/**
 * 「云端对话模式」P3：工具隔离的**运行期反算 + 白名单断言**（fail-closed）。
 *
 * 这一版把"静态手写 58 项 deny 名单"彻底删掉，测试也跟着重写——旧测试断言的是名单本身
 * （"58 项 / 覆盖 KNOWN_*"），而真接线时那份名单必然炸（`read`/`write`/`bash` 在 chat 会话里
 * 本就没注册，`bcdp_*` 惰性注册，`codex_*` 按开关注册）。
 *
 * 现在测试断言的是**语义**，全部用假 `ctx.tools`（不依赖 DSH 运行期）：
 * 1. `computeDeny(registered, allow) = registered − allow`；
 * 2. **新插件自动落 deny**（追加一个没见过的名字 → 立刻进 deny，证明"不会漏"）；
 * 3. `installChatToolDeny` 的三步流程（反算 → restrict → 再枚举 + 断言）；
 * 4. 五种失败情形：可见集多出工具 / 注册表读取抛错 / 读取接口缺席 / 拿不到 agent 作用域 /
 *    `restrict` 抛错（前四种 → `E_CHAT_TOOLS_NOT_ISOLATED`，最后一种 → `E_CHAT_DENY_FAILED`）；
 * 5. 白名单里的工具没注册 → **不报错**，只在 `missing` 里记录；
 * 6. `chatPresetInfo` 只交 `presetId`/`allow`/`rationale`（+可选计数），不再交静态名单；
 * 7. `cordis.patch.yml` 的 preset 声明保持不变（两个 insert 块、不挂任何 `tool-*`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRpcService } from '../dist/rpc.js'
import { SyncError } from '../dist/engine/errors.js'
import {
  ALLOW_CRITERION,
  ALLOW_RATIONALE,
  BROWSER_TOOL_SOURCES,
  BUILTIN_TOOL_SOURCES,
  CHAT_ALLOW_TOOLS,
  CHAT_PRESET_ID,
  CHAT_PRESET_LOADER_ID,
  CODEX_TOOL_SOURCES,
  KNOWN_ALL_TOOLS,
  PLUGIN_TOOL_SOURCES,
  assertIsolated,
  chatPresetInfo,
  computeDeny,
  describeDenyFailure,
  installChatToolDeny,
  unknownToolNamesFromRestrictError,
  validateDenyList,
} from '../dist/chatPreset/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')

/* -------------------------------------------------------------------------- */
/* 0. 假 ctx.tools：一个能"真的遮蔽"的工具注册表                                 */
/* -------------------------------------------------------------------------- */

/**
 * 造一个假的 `ctx.tools`：
 * - `definitions(scope)` 返回**当前可见**的工具名（遮蔽前 = 已注册名，遮蔽后 = 剩下的）；
 * - `restrict({deny})` 记录调用参数，并把 deny 里的名字从可见集移走；
 * - `restrict` 的行为可被 `options.restrict` 覆盖（模拟"没生效"或"抛错"）。
 */
function makeTools(registered, options = {}) {
  const calls = []
  const state = {
    visible: [...registered],
    visibleReads: 0,
    scopes: [],
  }
  const tools = {
    definitions(scope) {
      state.visibleReads += 1
      state.scopes.push(scope)
      return state.visible.map((name) => ({ name }))
    },
    restrict(filter) {
      calls.push(filter)
      if (typeof options.restrict === 'function') return options.restrict(filter, state)
      const deny = new Set(filter.deny ?? [])
      state.visible = state.visible.filter((name) => !deny.has(name))
      return () => undefined
    },
  }
  return { tools, calls, state }
}

/** 造一个假的 agent 作用域 ctx（`agent` = 作用域对象；DSH 里 agent 自身即 scope key）。 */
function makeCtx(tools, extra = {}) {
  const logs = []
  return {
    ctx: {
      tools,
      agent: { id: 'agent-scope' },
      logger: { warn: (message) => logs.push(message) },
      ...extra,
    },
    logs,
  }
}

/** 断言异步调用抛出 SyncError，并返回它（便于继续断言 code/message/details）。 */
async function rejectsWithSyncError(promise) {
  let caught
  try {
    await promise
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SyncError, '必须抛 SyncError（不许把未知异常直接冒出去）')
  return caught
}

/* -------------------------------------------------------------------------- */
/* 1. 白名单：唯一输入，判据逐字                                         */
/* -------------------------------------------------------------------------- */

test('白名单：恰好 ask_user_question + todo_write，且没有文件/命令类工具', () => {
  assert.deepEqual([...CHAT_ALLOW_TOOLS], ['ask_user_question', 'todo_write'])
  assert.equal(CHAT_ALLOW_TOOLS.length, 2)
  for (const forbidden of ['read', 'write', 'edit', 'bash', 'pwsh', 'glob', 'grep', 'job_output', 'schedule_add']) {
    assert.ok(!CHAT_ALLOW_TOOLS.includes(forbidden), `白名单不该有 ${forbidden}`)
  }
})

test('白名单理由：每个名字都有非空理由，且理由里出现判据原文', () => {
  assert.deepEqual(Object.keys(ALLOW_RATIONALE).sort(), [...CHAT_ALLOW_TOOLS].sort())
  for (const name of CHAT_ALLOW_TOOLS) {
    const rationale = ALLOW_RATIONALE[name]
    assert.equal(typeof rationale, 'string', `${name} 必须有理由`)
    assert.ok(rationale.length > 20, `${name} 的理由不能是一句话敷衍`)
    assert.ok(rationale.includes(ALLOW_CRITERION), `${name} 的理由必须写出判据原文`)
    assert.match(rationale, /不是"有没有副作用"/, `${name} 的理由必须点明判据不是"有没有副作用"`)
  }
  assert.equal(ALLOW_CRITERION, '能不能读写本机文件 / 执行本机命令 / 读取本机环境')
})

test('白名单：名字形态合法、无重复（validateDenyList 仍可用于形态自检）', () => {
  const validation = validateDenyList(CHAT_ALLOW_TOOLS)
  assert.equal(validation.ok, true)
  assert.deepEqual(validation.unknown, [])
  assert.deepEqual(validation.duplicates, [])
})

/* -------------------------------------------------------------------------- */
/* 2. computeDeny：运行期反算（不是写死名单）                                   */
/* -------------------------------------------------------------------------- */

const BASE_REGISTERED = ['fs', 'bash', 'schedule_x', 'dsh_dots', 'bcdp_click', 'ask_user_question']

test('computeDeny：注册表 − 白名单，白名单里的名字不出现在 deny 里', () => {
  const deny = computeDeny(BASE_REGISTERED, CHAT_ALLOW_TOOLS)
  assert.deepEqual(deny, ['fs', 'bash', 'schedule_x', 'dsh_dots', 'bcdp_click'])
  assert.equal(deny.length, BASE_REGISTERED.length - 1)
  assert.ok(!deny.includes('ask_user_question'), '白名单工具不许进 deny')
})

test('computeDeny：新插件注册的工具自动落 deny（证明不会漏）', () => {
  const registered = [...BASE_REGISTERED, 'newtool_x']
  const deny = computeDeny(registered, CHAT_ALLOW_TOOLS)
  assert.ok(deny.includes('newtool_x'), '没见过的新工具必须自动被 deny')
  assert.deepEqual(deny.slice(-1), ['newtool_x'], '顺序跟随注册表')
  assert.equal(deny.length, registered.length - 1)
})

test('computeDeny：注册表全在白名单里 → deny 为空（不是"至少禁点什么"）', () => {
  assert.deepEqual(computeDeny(['ask_user_question', 'todo_write'], CHAT_ALLOW_TOOLS), [])
  assert.deepEqual(computeDeny([], CHAT_ALLOW_TOOLS), [])
})

test('computeDeny：重复名去重、保持注册表顺序、不动入参', () => {
  const registered = ['b', 'a', 'b', 'ask_user_question', 'a']
  const deny = computeDeny(registered, CHAT_ALLOW_TOOLS)
  assert.deepEqual(deny, ['b', 'a'])
  assert.deepEqual(registered, ['b', 'a', 'b', 'ask_user_question', 'a'], '不许改入参')
})

test('computeDeny：空串/空白被跳过，自定义白名单生效', () => {
  assert.deepEqual(computeDeny(['', '   ', 'x'], []), ['x'])
  assert.deepEqual(computeDeny(['x', 'y'], ['x']), ['y'])
})

/* -------------------------------------------------------------------------- */
/* 3. assertIsolated：白名单断言（extra 才失败，missing 只记录）                 */
/* -------------------------------------------------------------------------- */

test('assertIsolated：可见集恰好是白名单的子集 → ok，白名单没注册的名字进 missing', () => {
  const verdict = assertIsolated(['ask_user_question'], CHAT_ALLOW_TOOLS)
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.extra, [])
  assert.deepEqual(verdict.missing, ['todo_write'], '白名单里没注册的要记录，但不报错')
})

test('assertIsolated：可见集多出一个非白名单工具 → 失败并点名', () => {
  const verdict = assertIsolated(['ask_user_question', 'xxx'], CHAT_ALLOW_TOOLS)
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.extra, ['xxx'])
  assert.deepEqual(verdict.missing, ['todo_write'])
})

test('assertIsolated：空可见集 → ok，missing 是整张白名单', () => {
  const verdict = assertIsolated([], CHAT_ALLOW_TOOLS)
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.extra, [])
  assert.deepEqual(verdict.missing, [...CHAT_ALLOW_TOOLS])
})

test('assertIsolated：extra 去重且保持可见集顺序', () => {
  const verdict = assertIsolated(['b', 'a', 'b'], [])
  assert.deepEqual(verdict.extra, ['b', 'a'])
  assert.equal(verdict.ok, false)
})

/* -------------------------------------------------------------------------- */
/* 4. installChatToolDeny：happy path（反算 → restrict → 再枚举 + 断言）        */
/* -------------------------------------------------------------------------- */

test('install：restrict 只调一次、只传 deny，且参数就是反算结果', async () => {
  const { tools, calls, state } = makeTools(BASE_REGISTERED)
  const { ctx } = makeCtx(tools)
  const result = await installChatToolDeny(ctx)
  assert.equal(result, undefined)
  assert.equal(calls.length, 1, 'restrict 必须只调一次')
  assert.deepEqual(Object.keys(calls[0]), ['deny'], '只传 deny（传 allow 会连带遮蔽未来工具）')
  assert.deepEqual([...calls[0].deny], computeDeny(BASE_REGISTERED, CHAT_ALLOW_TOOLS))
  assert.deepEqual(state.visible, ['ask_user_question'], '遮蔽之后可见集只剩白名单里注册过的')
})

test('install：遮蔽之后要用 agent 作用域再枚举一次（不是算完就算）', async () => {
  const { tools, state } = makeTools(BASE_REGISTERED)
  const { ctx } = makeCtx(tools)
  await installChatToolDeny(ctx)
  assert.ok(state.visibleReads >= 1, '必须重新枚举可见集')
  for (const scope of state.scopes) {
    assert.equal(scope, ctx.agent, '可见集必须按 agent 作用域取（省略 scope 是全局视图，看不到掩码）')
  }
})

test('install：新插件自动落 deny（注册表追加一项 → 立即进 deny）', async () => {
  const { tools, calls } = makeTools([...BASE_REGISTERED, 'newtool_x'])
  const { ctx } = makeCtx(tools)
  await installChatToolDeny(ctx)
  assert.ok(calls[0].deny.includes('newtool_x'))
  assert.equal(calls[0].deny.length, BASE_REGISTERED.length)
})

test('install：白名单工具没注册 → 不报错（missing 只记录）', async () => {
  const { tools, calls } = makeTools(['fs'])
  const { ctx } = makeCtx(tools)
  await installChatToolDeny(ctx) // 不抛 = 正确
  assert.deepEqual([...calls[0].deny], ['fs'])
  const verdict = assertIsolated(['ask_user_question'], CHAT_ALLOW_TOOLS)
  assert.equal(verdict.ok, true, 'missing 不影响隔离结论')
  assert.deepEqual(verdict.missing, ['todo_write'])
})

test('install：注册表全在白名单里 → deny=[] 仍然走同一条流程', async () => {
  const { tools, calls, state } = makeTools(['ask_user_question', 'todo_write'])
  const { ctx } = makeCtx(tools)
  await installChatToolDeny(ctx)
  assert.equal(calls.length, 1)
  assert.deepEqual([...calls[0].deny], [])
  assert.deepEqual(state.visible, ['ask_user_question', 'todo_write'])
})

test('install：listRegistered 覆盖生效（注册表来源可注入）', async () => {
  // definitions 只看得到 ask_user_question；listRegistered 多给一个 alpha。
  // 若注册表误从 definitions 取，deny 会是 []；正确时应是 ['alpha']。
  const { tools, calls } = makeTools(['ask_user_question'])
  const { ctx } = makeCtx(tools)
  await installChatToolDeny(ctx, { listRegistered: () => ['alpha', 'ask_user_question'] })
  assert.deepEqual([...calls[0].deny], ['alpha'], 'deny 必须来自 listRegistered')
})

test('install：allow 覆盖生效（白名单可注入，用于评审/未来放开）', async () => {
  const { tools, calls } = makeTools(['alpha', 'beta'])
  const { ctx } = makeCtx(tools)
  await installChatToolDeny(ctx, { allow: ['beta'] })
  assert.deepEqual([...calls[0].deny], ['alpha'])
})

/* -------------------------------------------------------------------------- */
/* 5. 失败情形（fail-closed）：一律拒绝，不回退静态名单                          */
/* -------------------------------------------------------------------------- */

test('install：可见集多出工具 → E_CHAT_TOOLS_NOT_ISOLATED，message 含该名字', async () => {
  // restrict 收下但"没生效"（模拟掩码未落地/作用域不对）：可见集仍是注册表全量。
  const { tools } = makeTools(['ask_user_question', 'xxx'], { restrict: () => () => undefined })
  const { ctx, logs } = makeCtx(tools)
  const error = await rejectsWithSyncError(installChatToolDeny(ctx))
  assert.equal(error.code, 'E_CHAT_TOOLS_NOT_ISOLATED')
  assert.ok(error.message.includes('xxx'), 'message 必须点名多出来的工具')
  assert.match(error.message, /多出 /)
  assert.deepEqual(error.details.extra, ['xxx'])
  assert.equal(error.details.preset, 'chat')
  assert.ok(logs.some((line) => line.includes('xxx')), '失败必须打日志（不静默）')
})

test('install：注册表读取抛错 → E_CHAT_TOOLS_NOT_ISOLATED（不许吞、不许退化名单）', async () => {
  const { tools, calls } = makeTools(['ask_user_question'])
  const { ctx } = makeCtx(tools)
  const error = await rejectsWithSyncError(
    installChatToolDeny(ctx, {
      listRegistered: () => {
        throw new Error('registry exploded')
      },
    }),
  )
  assert.equal(error.code, 'E_CHAT_TOOLS_NOT_ISOLATED')
  assert.match(error.message, /云端对话模式没能隔离工具/)
  assert.equal(error.details.reason, 'list-registered-threw')
  assert.match(error.details.cause, /registry exploded/)
  assert.equal(calls.length, 0, '读不到注册表就不许调 restrict（等于在赌名单）')
})

test('install：注册表接口缺席 → E_CHAT_TOOLS_NOT_ISOLATED（fail-closed，不退回静态名单）', async () => {
  // 只有一个 restrict，没有任何可枚举注册表的接口。
  const calls = []
  const tools = { restrict: (filter) => calls.push(filter) }
  const { ctx } = makeCtx(tools)
  const error = await rejectsWithSyncError(installChatToolDeny(ctx))
  assert.equal(error.code, 'E_CHAT_TOOLS_NOT_ISOLATED')
  assert.equal(error.details.reason, 'registry-unavailable')
  assert.equal(calls.length, 0, '**绝不**把 KNOWN_ALL_TOOLS 之类静态名单塞进 restrict')
  assert.ok(KNOWN_ALL_TOOLS.length > 0, '静态证据表还在（仅说明用），但没被当成 deny 输入')
})

test('install：注册表返回非法形态 → E_CHAT_TOOLS_NOT_ISOLATED', async () => {
  const { tools, calls } = makeTools(['ask_user_question'])
  const { ctx } = makeCtx(tools)
  const error = await rejectsWithSyncError(
    installChatToolDeny(ctx, { listRegistered: () => 'not-an-array' }),
  )
  assert.equal(error.code, 'E_CHAT_TOOLS_NOT_ISOLATED')
  assert.equal(error.details.reason, 'list-registered-malformed')
  assert.equal(calls.length, 0)
})

test('install：拿不到 agent 作用域 → E_CHAT_TOOLS_NOT_ISOLATED（不能拿全局视图凑数）', async () => {
  const { tools } = makeTools(['ask_user_question'])
  // 没有 agent / scope 字段：registered 能取到（全局 definitions），可见集取不到 → 拒绝。
  const ctx = { tools, logger: { warn: () => {} } }
  const error = await rejectsWithSyncError(installChatToolDeny(ctx))
  assert.equal(error.code, 'E_CHAT_TOOLS_NOT_ISOLATED')
  assert.equal(error.details.reason, 'agent-scope-unavailable')
})

test('install：restrict 抛错 → E_CHAT_DENY_FAILED + 打日志，并按 fail-closed 拒绝', async () => {
  const boom = new Error(
    'tools.restrict() names unknown global tool "bcdp_click"; known global tools: ask_user_question',
  )
  const { tools, state } = makeTools(['bcdp_click', 'ask_user_question'], {
    restrict: () => {
      throw boom
    },
  })
  const { ctx, logs } = makeCtx(tools)
  const error = await rejectsWithSyncError(installChatToolDeny(ctx))
  assert.equal(error.code, 'E_CHAT_DENY_FAILED')
  assert.ok(error.message.includes('bcdp_click'), 'message 必须含未知名')
  assert.deepEqual([...error.details.unknown], ['bcdp_click'])
  assert.match(error.details.cause, /unknown global tool/)
  assert.equal(error.details.reason, 'restrict-threw')
  assert.equal(state.visibleReads, 1, '只读了注册表那一次；restrict 失败后不许再枚举可见集（避免"看起来通过"）')
  assert.ok(logs.some((line) => line.includes('fail-closed')), '必须打日志')
})

test('install：宿主没有 tools.restrict / 没有 ctx → E_CHAT_DENY_FAILED（不静默跳过）', async () => {
  for (const ctx of [{}, { tools: {} }, { tools: { restrict: 1 } }, null]) {
    const error = await rejectsWithSyncError(installChatToolDeny(ctx))
    assert.equal(error.code, 'E_CHAT_DENY_FAILED', `ctx=${JSON.stringify(ctx)} 必须报内部错误`)
    assert.equal(error.details.reason, 'restrict-unavailable')
  }
})

/* -------------------------------------------------------------------------- */
/* 6. 失败文案 / 宿主错误解析（保留，但语义改为"反算不一致"）                     */
/* -------------------------------------------------------------------------- */

test('describeDenyFailure：点名未知工具，并说明 deny 是反算的不是写死的', () => {
  const message = describeDenyFailure(['bcdp_page_info', 'codex_sketch'])
  assert.ok(message.includes('bcdp_page_info'))
  assert.ok(message.includes('codex_sketch'))
  assert.match(message, /运行期反算/)
  assert.match(message, /fail-closed/)
})

test('describeDenyFailure：解析不出名字时给兜底文案（仍非空且不静默）', () => {
  const message = describeDenyFailure([])
  assert.ok(message.length > 0)
  assert.match(message, /fail-closed/)
})

test('unknownToolNamesFromRestrictError：只认本次传入的 deny 名字，不吃 known 清单', () => {
  const error = new Error(
    'tools.restrict() names unknown global tools "bcdp_page_info", "read"; known global tools: schedule_add, dsh_dots',
  )
  assert.deepEqual(unknownToolNamesFromRestrictError(error, ['bcdp_page_info', 'read']), [
    'bcdp_page_info',
    'read',
  ])
  assert.deepEqual(unknownToolNamesFromRestrictError(error, ['bcdp_page_info']), ['bcdp_page_info'])
  assert.deepEqual(unknownToolNamesFromRestrictError('boom', ['x']), [])
})

/* -------------------------------------------------------------------------- */
/* 7. chatPresetInfo：只交白名单与理由，不再交静态名单                          */
/* -------------------------------------------------------------------------- */

test('chatPresetInfo：三个键（presetId/allow/rationale），引用同一份常量', () => {
  const info = chatPresetInfo()
  assert.deepEqual(Object.keys(info).sort(), ['allow', 'presetId', 'rationale'])
  assert.equal(info.presetId, 'chat')
  assert.equal(info.allow, CHAT_ALLOW_TOOLS, '必须是同一份常量引用，不能是拷贝')
  assert.equal(info.rationale, ALLOW_RATIONALE)
  for (const gone of ['tools', 'known', 'validation', 'deny']) {
    assert.ok(!(gone in info), `不许再把静态名单字段 ${gone} 交给前端`)
  }
  assert.equal(info.registeredCount, undefined)
  assert.equal(info.denyCount, undefined)
})

test('chatPresetInfo：带注册表时附带计数（注册数 / 反算出的 deny 数）', () => {
  const info = chatPresetInfo(BASE_REGISTERED)
  assert.equal(info.registeredCount, BASE_REGISTERED.length)
  assert.equal(info.denyCount, BASE_REGISTERED.length - 1)
  assert.equal(info.presetId, CHAT_PRESET_ID)
})

/* -------------------------------------------------------------------------- */
/* 8. RPC：chatPresetInfo 走 enqueue，返回同一结构                               */
/* -------------------------------------------------------------------------- */

test('RPC chatPresetInfo：ok:true 且 data 与 chatPresetInfo() 逐字段一致', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-chat-preset-'))
  const profileDir = path.join(root, 'profile')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '# empty\n', 'utf8')
  const service = createRpcService({ homeDir: path.join(root, 'home'), profileDir, dshVersion: 'test-1' })
  t.after(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  const result = await service.handleRpc({ action: 'chatPresetInfo' })
  assert.equal(result.ok, true)
  assert.equal(result.data.presetId, 'chat')
  assert.deepEqual(result.data, chatPresetInfo())
  assert.deepEqual(Object.keys(result.data).sort(), ['allow', 'presetId', 'rationale'])
})

/* -------------------------------------------------------------------------- */
/* 9. 静态契约 + 证据表：preset 声明不变、KNOWN_* 仅说明用                        */
/* -------------------------------------------------------------------------- */

test('cordis.patch.yml：preset 声明在独立 insert 块里，id 与常量一致', () => {
  const patch = readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8')
  const blocks = patch.split(/^-\s+insert:/m).slice(1)
  assert.equal(blocks.length, 2, 'README 2.2：一个 insert 块只放一行插件，这里是 2 块')
  const presetBlock = blocks[1]
  assert.ok(presetBlock.includes(`id: ${CHAT_PRESET_LOADER_ID}`), `Loader 行 id 必须是 ${CHAT_PRESET_LOADER_ID}`)
  assert.ok(presetBlock.includes("name: '@deepseek-ai/dsh-agent-preset'"))
  assert.ok(presetBlock.includes(`id: ${CHAT_PRESET_ID}`), 'config.id 必须是 chat（= 会话 header 的 agentPreset）')
  assert.ok(blocks[0].includes('id: dots'), '第一块仍是原插件行')
})

test('cordis.patch.yml：preset 的 plugins 只列纯对话插件，没有任何 tool-* 行', () => {
  const patch = readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8')
  const presetBlock = patch.split(/^-\s+insert:/m).slice(2).join('')
  assert.ok(!/name:\s*'@deepseek-ai\/dsh-tool-/.test(presetBlock), 'preset 里不许出现 tool-* 插件')
  assert.ok(!/tool-fs|tool-bash|tool-pwsh|tool-jobs|tool-web|tool-subagent/.test(presetBlock))
  assert.ok(presetBlock.includes("name: '@deepseek-ai/dsh-persona'"), 'persona 必须在')
  assert.ok(presetBlock.includes('dsh-compaction-basic'), '上下文压缩必须在（长对话需要）')
})

test('证据表（仅说明用）：58 项、来源带行号、每条都写了"为什么必须不可见"', () => {
  const sources = [
    ...PLUGIN_TOOL_SOURCES,
    ...BUILTIN_TOOL_SOURCES,
    ...CODEX_TOOL_SOURCES,
    ...BROWSER_TOOL_SOURCES,
  ]
  assert.equal(PLUGIN_TOOL_SOURCES.length, 4)
  assert.equal(BUILTIN_TOOL_SOURCES.length, 12)
  assert.equal(CODEX_TOOL_SOURCES.length, 7)
  assert.equal(BROWSER_TOOL_SOURCES.length, 35)
  assert.equal(KNOWN_ALL_TOOLS.length, 58)
  assert.equal(sources.length, KNOWN_ALL_TOOLS.length)
  const names = sources.map((item) => item.name)
  assert.equal(new Set(names).size, names.length, '证据表里不能有重复工具名')
  for (const item of sources) {
    assert.match(item.source, /:\d+/, `${item.name} 的来源必须带行号`)
    assert.ok(item.why.trim() !== '', `${item.name} 必须写一句"为什么必须不可见"`)
  }
  assert.equal(validateDenyList(KNOWN_ALL_TOOLS).ok, true)
})
