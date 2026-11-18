/**
 * 日程桥 Git 集成测试：真实临时仓库（bare + 多个工作副本，`allowLocalRepo`）。
 *
 * 覆盖验收项：
 *   - list 能读平板写入的行（含扩展字段 / 附件 / 坏行）；
 *   - add 只追加、原行逐字节不变、id 不重复、foldById 生效、只提交自己的 schedules 目录；
 *   - pull --rebase 冲突 → E_CONFLICT，远端与本地都不被静默覆盖；
 *   - 越界（`../`、别的设备目录、非法日期）一律拒绝；
 *   - token 不出现在任何返回值、错误消息、仓库文件与 AI 请求里；
 *   - 工具层（settings → 工作副本 → 工具）串起来可用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { GitRepo } from '../dist/engine/git.js'
import { statePaths } from '../dist/engine/paths.js'
import { defaultSettings, SettingsStore } from '../dist/engine/settings.js'
import { ScheduleBridge, addSchedule, listSchedule, summarySchedule } from '../dist/schedule/bridge.js'
import { registerScheduleTools } from '../dist/schedule/tools.js'
import { appendRecord, encodeRecord, parseJsonl } from '../dist/schedule/jsonl.js'

const exec = promisify(execFile)
const IDENTITY = ['-c', 'user.name=dsh-test', '-c', 'user.email=test@localhost']
const DATE = '2026-11-15'
const TOKEN = 'test-token-not-real-9z8y'
const PAD_FILE = `devices/pad-1/schedules/${DATE}.jsonl`

/** 平板侧写的两行：第一行带扩展字段 + 附件，第二行正文超 80 字（列表要截断）。 */
const LONG_BODY =
  '今天要把平板上的手写记录整理一遍，顺便核对下周三的会议时间与参会人，再补一条给家里买菜的提醒，' +
  '别忘了晚上的电话，以及周五前把报销单交给行政。'.repeat(2)
const TABLET_TEXT =
  `${JSON.stringify({
    id: 'pad-row-1',
    ts: `${DATE}T09:30:00+08:00`,
    title: '平板记录一',
    body: '手写内容一',
    ocr_text: '原始 OCR 文本',
    author: '我',
    done: false,
    attachments: [{ sha256: 'ab12'.repeat(16), name: 'ab12.png', pageIndex: 0 }],
    ai_processed: false,
    ocr_time: `${DATE}T09:31:12+08:00`,
    mood: '扩展字段必须被保留',
  })}\n` +
  `${JSON.stringify({
    id: 'pad-row-2',
    ts: `${DATE}T10:00:00+08:00`,
    title: '平板记录二',
    body: LONG_BODY,
    author: '小李',
    done: true,
    ai_processed: true,
  })}\n`

async function git(cwd, args) {
  const { stdout } = await exec('git', [...IDENTITY, ...args], { cwd, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

async function gitShow(bare, spec) {
  return await git(path.dirname(bare), ['--git-dir', bare, 'show', spec])
}

async function gitHead(bare) {
  return (await git(path.dirname(bare), ['--git-dir', bare, 'rev-parse', 'main'])).trim()
}

/** 建一个 bare 远端，并让"平板"先写一天的日程推上去。 */
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-schedule-'))
  const bare = path.join(root, 'remote.git')
  await git(root, ['init', '--bare', '-b', 'main', bare])
  const pad = path.join(root, 'pad')
  await git(root, ['clone', '--quiet', bare, pad])
  await mkdir(path.join(pad, 'devices', 'pad-1', 'schedules'), { recursive: true })
  await mkdir(path.join(pad, 'devices', 'pad-1', 'summaries'), { recursive: true })
  await writeFile(path.join(pad, PAD_FILE), TABLET_TEXT, 'utf8')
  await writeFile(
    path.join(pad, 'devices', 'pad-1', 'summaries', `${DATE}.json`),
    `${JSON.stringify({ date: DATE, summary: '平板侧汇总' }, null, 2)}\n`,
    'utf8',
  )
  await git(pad, ['add', '-A'])
  await git(pad, ['commit', '--quiet', '-m', 'pad: seed schedules'])
  await git(pad, ['push', '--quiet', 'origin', 'HEAD:main'])
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  return { root, bare, pad }
}

function repoFor(dir, bare) {
  return new GitRepo({
    dir,
    repoUrl: bare,
    branch: 'main',
    authMode: 'https',
    token: TOKEN,
    allowLocalRepo: true,
  })
}

/** 递归检查：每个 object 节点都必须显式声明 additionalProperties（宿主注册时的硬要求）。 */
function assertSealedObjects(node, label) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) assertSealedObjects(item, label)
    return
  }
  if (node.type === 'object') {
    assert.equal(
      typeof node.additionalProperties,
      'boolean',
      `${label}: object 节点必须显式声明 additionalProperties（true/false）`,
    )
  }
  if (node.properties !== undefined) {
    for (const child of Object.values(node.properties)) assertSealedObjects(child, label)
  }
  if (node.items !== undefined) assertSealedObjects(node.items, label)
}

const NOW = () => new Date('2026-11-15T21:45:27+08:00')

test('list：能读平板写入的行（扩展字段/附件不报错），正文摘要只给前 80 字', async (t) => {
  const { root, bare } = await setup(t)
  const repo = repoFor(path.join(root, 'work-a'), bare)
  const bridge = new ScheduleBridge({ repo, deviceId: 'pc-a', now: NOW })

  const listed = await bridge.list('all', DATE)
  assert.deepEqual(listed.deviceIds, ['pc-a', 'pad-1'], '本机排最前，同时能看到平板设备目录')
  assert.equal(listed.records.length, 2)
  assert.equal(listed.errors.length, 0, '平板的扩展字段/附件不应报错')
  assert.equal(listed.refreshed, true)

  const first = listed.records[0]
  assert.equal(first.id, 'pad-row-1')
  assert.equal(first.deviceId, 'pad-1')
  assert.equal(first.title, '平板记录一')
  assert.equal(first.author, '我')
  assert.equal(first.done, false)
  assert.equal(first.hasAttachments, true)
  assert.equal(first.aiProcessed, false)

  const second = listed.records[1]
  assert.ok(second.bodyLength > 80)
  assert.equal(second.bodyPreview.length, 81, '80 字 + 省略号')
  assert.ok(second.bodyPreview.endsWith('…'))
  assert.equal(second.done, true)

  // 只看本机：还没有 PC 记录
  const own = await bridge.list('', DATE)
  assert.deepEqual(own.deviceIds, ['pc-a'])
  assert.equal(own.records.length, 0)
  await repo.dispose()
})

test('add：只追加不重写、id 不重复、foldById 生效，且不动别的设备目录与 summaries/', async (t) => {
  const { root, bare } = await setup(t)
  const repo = repoFor(path.join(root, 'work-a'), bare)
  const bridge = new ScheduleBridge({ repo, deviceId: 'pc-a', now: NOW })

  const added = await bridge.add('pc-a', DATE, { title: 'PC 新建', body: '桌面端写的第一条', author: '桌面' })
  assert.equal(added.path, `devices/pc-a/schedules/${DATE}.jsonl`)
  assert.equal(added.date, DATE)
  assert.equal(added.deviceId, 'pc-a')
  assert.match(added.commit, /^[0-9a-f]{40}$/)
  assert.equal(added.pushed, true, '新建后应立即推送')
  assert.deepEqual(added.files, [`devices/pc-a/schedules/${DATE}.jsonl`])

  const remoteOwn = await gitShow(bare, `main:devices/pc-a/schedules/${DATE}.jsonl`)
  const ownLines = remoteOwn.trimEnd().split('\n')
  assert.equal(ownLines.length, 1)
  const stored = JSON.parse(ownLines[0])
  assert.deepEqual(Object.keys(stored), ['id', 'ts', 'title', 'body', 'author', 'done', 'ai_processed'])
  assert.equal(stored.title, 'PC 新建')
  assert.equal(stored.author, '桌面')
  assert.equal(stored.done, false)
  assert.equal(stored.ai_processed, false)
  assert.match(stored.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  assert.equal(stored.ts.slice(0, 10), DATE)
  assert.equal(stored.id, added.id)

  // 平板文件与 summaries/ 必须逐字节不变（PC 只写自己的 schedules）
  assert.equal(await gitShow(bare, `main:${PAD_FILE}`), TABLET_TEXT)
  assert.ok((await gitShow(bare, `main:devices/pad-1/summaries/${DATE}.json`)).includes('平板侧汇总'))

  // 第二条：id 不重复，第一条逐字节不变
  const second = await bridge.add('pc-a', DATE, { title: 'PC 第二条', body: '' })
  assert.notEqual(second.id, added.id)
  const afterTwo = (await gitShow(bare, `main:devices/pc-a/schedules/${DATE}.jsonl`)).split('\n')
  assert.equal(afterTwo[0], ownLines[0], '追加不得改写历史行')
  assert.equal(afterTwo.filter((line) => line !== '').length, 2)

  let listed = await bridge.list('', DATE)
  assert.equal(listed.records.length, 2)

  // 事件溯源：追加同 id 的较晚版本（完成/编辑），foldById 应只留新版本
  const file = path.join(repo.dir, `devices/pc-a/schedules/${DATE}.jsonl`)
  const older = parseJsonl(await readFile(file, 'utf8')).records[0]
  const updated = { ...older, ts: '2026-11-15T23:00:00+08:00', title: 'PC 新建（已勾完成）', done: true }
  await writeFile(file, appendRecord(await readFile(file, 'utf8'), updated), 'utf8')
  await git(repo.dir, ['add', '-A'])
  await git(repo.dir, ['commit', '--quiet', '-m', 'pc: mark done'])
  await git(repo.dir, ['push', '--quiet', 'origin', 'HEAD:main'])

  listed = await bridge.list('', DATE)
  assert.equal(listed.records.length, 2, '同 id 的新版本不得变成两条记录')
  const folded = listed.records.find((record) => record.id === older.id)
  assert.equal(folded.done, true, 'foldById 必须取较晚 ts 的版本')
  assert.equal(folded.title, 'PC 新建（已勾完成）')
  assert.equal(listed.records.filter((record) => record.id === older.id).length, 1, '同 id 只能出现一次')

  // 平板那边仍然只有自己写的那两行（PC 的 add 没有污染别的设备目录）
  assert.equal(await gitShow(bare, `main:${PAD_FILE}`), TABLET_TEXT)
  await repo.dispose()
})

test('add：pull --rebase 冲突 → E_CONFLICT，远端与本机都不被静默覆盖', async (t) => {
  const { root, bare } = await setup(t)
  const dirA = path.join(root, 'work-a')
  const dirB = path.join(root, 'work-b')
  const repoA = repoFor(dirA, bare)
  const repoB = repoFor(dirB, bare)
  const bridgeA = new ScheduleBridge({ repo: repoA, deviceId: 'pc-a', now: NOW })
  const bridgeB = new ScheduleBridge({ repo: repoB, deviceId: 'pc-a', now: NOW })

  const first = await bridgeA.add('pc-a', DATE, { title: 'A 的第一条' })
  assert.equal(first.pushed, true)

  // B：另一台机器用了同一个 deviceId（同一份文件），离线提交了一条修改
  await repoB.ensureWorkTree()
  const fileB = path.join(dirB, `devices/pc-a/schedules/${DATE}.jsonl`)
  const bText = (await readFile(fileB, 'utf8')).replace('A 的第一条', 'B 改的一行')
  await writeFile(fileB, bText, 'utf8')
  await git(dirB, ['add', '-A'])
  await git(dirB, ['commit', '--quiet', '-m', 'B: offline edit'])

  // A 侧改同一行并推送（远端因此与 B 的本地提交分叉）
  const fileA = path.join(dirA, `devices/pc-a/schedules/${DATE}.jsonl`)
  await writeFile(fileA, (await readFile(fileA, 'utf8')).replace('A 的第一条', 'A 改的一行'), 'utf8')
  await git(dirA, ['add', '-A'])
  await git(dirA, ['commit', '--quiet', '-m', 'A: edit'])
  await git(dirA, ['push', '--quiet', 'origin', 'HEAD:main'])
  const remoteHead = await gitHead(bare)

  await assert.rejects(
    () => bridgeB.add('pc-a', DATE, { title: 'B 的新记录' }),
    (error) => {
      assert.equal(error.code, 'E_CONFLICT', `应报 E_CONFLICT，实际：${error.code} ${error.message}`)
      assert.match(error.message, /冲突/)
      assert.match(error.message, /永不 force push|abort/)
      return true
    },
  )

  // 远端完全没动：HEAD 未变、A 的版本仍在、B 的新行没有被写进去
  assert.equal(await gitHead(bare), remoteHead, '冲突时不得产生任何提交')
  const remoteText = await gitShow(bare, `main:devices/pc-a/schedules/${DATE}.jsonl`)
  assert.ok(remoteText.includes('A 改的一行'))
  assert.equal(remoteText.includes('B 的新记录'), false, '冲突时不得静默追加/覆盖')

  // B 的工作副本被 abort 回自己的提交，没有被远端悄悄覆盖
  const after = await readFile(fileB, 'utf8')
  assert.ok(after.includes('B 改的一行'), 'rebase --abort 后应恢复本机内容')
  assert.equal(after.includes('A 改的一行'), false, '冲突时不得把远端内容混进本机文件')
  assert.equal(after.includes('B 的新记录'), false, '冲突时不得写入新行')

  // 冲突之后仍能正常读（读路径不应因写失败而崩）
  const listed = await bridgeB.list('pc-a', DATE)
  assert.equal(listed.records.length, 1)
  await repoA.dispose()
  await repoB.dispose()
})

test('越界拒绝：别的设备目录、../、非法日期都写不进去', async (t) => {
  const { root, bare } = await setup(t)
  const repo = repoFor(path.join(root, 'work-a'), bare)
  const bridge = new ScheduleBridge({ repo, deviceId: 'pc-a', now: NOW })
  await repo.ensureWorkTree()
  const headBefore = await gitHead(bare)

  await assert.rejects(() => bridge.add('pad-1', DATE, { title: '越界写平板' }), /只允许写本机设备目录/)
  await assert.rejects(() => bridge.add('../../etc', DATE, { title: '越界路径' }), /deviceId/)
  await assert.rejects(() => bridge.add('pc-a', '2026-13-01', { title: '非法日期' }), /日期/)
  await assert.rejects(() => bridge.add('pc-a', DATE, { title: '   ' }), /title 不能为空/)

  assert.equal(await gitHead(bare), headBefore, '被拒绝的调用不得产生提交')
  assert.equal(await gitShow(bare, `main:${PAD_FILE}`), TABLET_TEXT, '平板文件必须原样')
  const pcDir = path.join(repo.dir, 'devices', 'pc-a', 'schedules')
  await assert.rejects(() => stat(pcDir), /ENOENT/, '拒绝后不应留下任何 pc-a 目录')
  await repo.dispose()
})

test('token 不出现在任何返回值、错误消息、仓库文件与 AI 请求里', async (t) => {
  const { root, bare } = await setup(t)
  const repo = repoFor(path.join(root, 'work-a'), bare)
  const bridge = new ScheduleBridge({
    repo,
    deviceId: 'pc-a',
    now: NOW,
    ai: { apiKey: 'ai-key-not-the-git-token', baseURL: 'https://ai.test/v1', model: 'm', providerLabel: '测试 AI' },
  })

  const outputs = []
  outputs.push(JSON.stringify(await bridge.list('all', DATE)))
  outputs.push(JSON.stringify(await bridge.add('pc-a', DATE, { title: '带 token 的调用', body: 'body' })))
  for (const bad of ['pad-1', '../x', 'PC-A']) {
    try {
      await bridge.add(bad, DATE, { title: 'x' })
      assert.fail('应当被拒绝')
    } catch (error) {
      outputs.push(`${error.code} ${error.message} ${JSON.stringify(error.details ?? null)}`)
    }
  }

  // AI 请求：stub fetch，检查 URL / 头 / 请求体里都没有 git token
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: String(init?.body ?? '') })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'AI 摘要正文' } }] }),
    }
  }
  try {
    const summarized = await bridge.summary('all', DATE)
    assert.equal(summarized.summary, 'AI 摘要正文')
    assert.equal(summarized.count, 3, '平板 2 条 + PC 1 条')
    assert.equal(summarized.payload.date, DATE)
    assert.ok(summarized.prompt.includes(`记录日期：${DATE}`))
    outputs.push(JSON.stringify(summarized))
  } finally {
    globalThis.fetch = realFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://ai.test/v1/chat/completions')
  assert.equal(calls[0].headers.authorization, 'Bearer ai-key-not-the-git-token')
  const joined = outputs.join('\n')
  for (const call of calls) {
    assert.equal(call.url.includes(TOKEN), false)
    assert.equal(call.body.includes(TOKEN), false)
    assert.equal(JSON.stringify(call.headers).includes(TOKEN), false)
  }

  // 仓库里（含 .git/config）也不能出现 token
  const scanned = []
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await scan(full)
      else if (entry.isFile()) scanned.push([full, await readFile(full, 'utf8')])
    }
  }
  await scan(repo.dir)
  assert.ok(scanned.length > 0)
  for (const [file, content] of scanned) {
    assert.equal(content.includes(TOKEN), false, `token 泄漏到仓库文件：${path.basename(file)}`)
  }
  assert.equal(joined.includes(TOKEN), false, 'token 不得出现在任何返回值/错误消息里')
  await repo.dispose()
})

test('工具层：schedule_add / schedule_list / schedule_summary 经设置读到同一个仓库', async (t) => {
  const { root, bare } = await setup(t)
  const homeDir = path.join(root, 'home')
  const paths = statePaths(homeDir)
  const settings = defaultSettings()
  const store = new SettingsStore(paths, { allowLocalRepo: true })
  store.writeSettings({
    ...settings,
    repoUrl: bare,
    platform: 'custom',
    authMode: 'https',
    branch: 'main',
    deviceId: 'pc-a',
  })
  store.writeToken(TOKEN)

  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => undefined
      },
    },
    effects: [],
    effect(effect, label) {
      this.effects.push(label)
      effect()
    },
  }
  const names = registerScheduleTools(ctx, { paths, allowLocalRepo: true, now: NOW })
  assert.deepEqual(names, ['schedule_list', 'schedule_add', 'schedule_summary', 'dsh_dots'])
  assert.deepEqual(
    registered.map((tool) => tool.name),
    names,
  )
  assert.equal(ctx.effects.length, 4, '每个工具注册都要挂在 ctx.effect 上')

  const addTool = registered.find((tool) => tool.name === 'schedule_add')
  const listTool = registered.find((tool) => tool.name === 'schedule_list')
  const summaryTool = registered.find((tool) => tool.name === 'schedule_summary')
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    // 宿主 assertSupportedJsonSchema 要求 object 节点显式声明 additionalProperties
    for (const schema of [tool.parameters, tool.output.schema]) assertSealedObjects(schema, tool.name)
  }
  assert.deepEqual(addTool.parameters.required, ['title'], 'title 是必填参数')

  // 省略 date → 用注入的"今天"（2026-11-15），命中平板同一天的文件
  const added = await addTool.execute({ title: '工具新建', body: '来自 schedule_add' })
  assert.equal(added.path, `devices/pc-a/schedules/${DATE}.jsonl`)
  assert.equal(added.pushed, true)
  const addRendered = addTool.output.render({}, added)[0]
  assert.equal(addRendered.type, 'text')
  assert.ok(addRendered.text.includes('已新建日程'))
  assert.ok(addRendered.text.includes(added.id))

  const listed = await listTool.execute({ deviceId: 'all' })
  assert.equal(listed.date, DATE)
  assert.equal(listed.records.length, 3, '平板 2 条 + 工具新建 1 条')
  const rendered = listTool.output.render({}, listed)[0]
  assert.equal(rendered.type, 'text')
  assert.ok(rendered.text.includes('工具新建'))

  const summarized = await summaryTool.execute({})
  assert.equal(summarized.count, 1, '默认只看本机：只有工具新建那一条')
  assert.equal(summarized.summary, '', '没有 AI 密钥时 summary 是空串')
  assert.match(summarized.aiNote, /未配置 AI 密钥/)
  assert.ok(summaryTool.output.render({}, summarized)[0].text.includes('提示词'))

  // 未配置仓库地址时要给出可操作的中文错误
  store.writeSettings({ ...store.readSettings(), repoUrl: '' })
  await assert.rejects(() => listTool.execute({}), /尚未配置仓库地址/)
})

test('index.apply：有 tools 服务时注册三个日程工具，没有时只注册 RPC（不影响配置同步）', async (t) => {
  const { root } = await setup(t)
  const index = await import('../dist/index.js')
  const makeCtx = (withTools) => {
    const state = { registered: [], effects: [], injectDeps: null }
    const ctx = {
      webServer: { register: () => () => undefined },
      connection: { requestRejection: () => undefined },
      effect(effect, label) {
        state.effects.push(label)
        const cleanup = effect()
        return () => {
          if (typeof cleanup === 'function') cleanup()
        }
      },
    }
    if (withTools) {
      ctx.tools = {
        register(definition) {
          state.registered.push(definition)
          return () => undefined
        },
      }
      ctx.inject = (deps, callback) => {
        state.injectDeps = deps
        callback(ctx)
      }
    }
    return { ctx, state }
  }

  const withTools = makeCtx(true)
  index.apply(withTools.ctx, {
    homeDir: path.join(root, 'home-a'),
    profileDir: path.join(root, 'profile-a'),
    dshVersion: 'test-1',
  })
  assert.deepEqual(withTools.state.injectDeps, ['tools'], '用 ctx.inject 延迟注入可选依赖')
  assert.deepEqual(
    withTools.state.registered.map((tool) => tool.name),
    ['schedule_list', 'schedule_add', 'schedule_summary', 'dsh_dots'],
  )
  assert.equal(withTools.state.effects.length, 9, '3 个 RPC 相关 effect（新路由/旧兼容路由/dispose）+ 2 个远程访问 effect + 4 个工具 effect')

  const noTools = makeCtx(false)
  index.apply(noTools.ctx, {
    homeDir: path.join(root, 'home-b'),
    profileDir: path.join(root, 'profile-b'),
    dshVersion: 'test-1',
  })
  assert.equal(noTools.state.registered.length, 0)
  // 远程访问域的装配与 tools 无关：它有自己的 dispose/autostart 两个 effect。
  assert.equal(noTools.state.effects.length, 5, '没有 tools 服务时仍是 3 个 RPC 相关 effect（新/旧路由 + dispose）+ 2 个远程 effect')

  const disabled = makeCtx(true)
  index.apply(disabled.ctx, {
    homeDir: path.join(root, 'home-c'),
    profileDir: path.join(root, 'profile-c'),
    dshVersion: 'test-1',
    scheduleTools: false,
  })
  assert.equal(disabled.state.registered.length, 0, 'scheduleTools:false 可整机关掉日程工具')
  assert.equal(disabled.state.effects.length, 5, '关掉日程工具不影响 RPC（新/旧路由 + dispose）与远程访问的 effect')
})

test('自由函数：addSchedule 越界拒绝、listSchedule 与 summarySchedule 可用', async (t) => {
  const { root, bare } = await setup(t)
  const repo = repoFor(path.join(root, 'work-a'), bare)
  const options = { ownDeviceId: 'pc-a', now: NOW }

  await assert.rejects(() => addSchedule(repo, 'pad-1', DATE, { title: 'x' }, options), /只允许写本机设备目录/)
  const added = await addSchedule(repo, 'pc-a', DATE, { title: '函数式新建' }, options)
  assert.equal(added.id.length > 0, true)

  const listed = await listSchedule(repo, 'all', DATE, options)
  assert.equal(listed.records.length, 3)
  assert.ok(listed.records.some((record) => record.title === '函数式新建'))

  const summarized = await summarySchedule(repo, 'all', DATE, options)
  assert.equal(summarized.count, 3)
  assert.equal(summarized.summary, null, '没有 AI 配置时不调用模型')
  assert.match(summarized.aiNote, /未配置 AI 密钥/)

  // encodeRecord 与列表读到的记录同形（工具写出去的行能被自己读回来）
  const file = path.join(repo.dir, `devices/pc-a/schedules/${DATE}.jsonl`)
  const text = await readFile(file, 'utf8')
  const parsed = parseJsonl(text)
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.records[0].id, added.id)
  assert.equal(encodeRecord(parsed.records[0]), `${JSON.stringify(JSON.parse(text.trim()))}\n`)
  await repo.dispose()
})
