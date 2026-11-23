/**
 * mod-plugin-askpass-node-resolution：askpass 的 node 解释器解析门禁（纯单测，不 spawn）。
 *
 * 所有临时目录都走 os.tmpdir()/mkdtemp，绝不碰 ~/.dsh/dots；探针一律注入，不起子进程。
 * 覆盖：解析顺序、ELECTRON_RUN_AS_NODE 精确注入、探针失败、token 卫生、
 *       Windows（; 分割 / 大小写不敏感）与 POSIX（: 分割 / 大小写敏感）两条注入平台路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  ASKPASS_NODE_MISSING_CODE,
  ASKPASS_NODE_MISSING_REASON,
  ASKPASS_NODE_OVERRIDE_ENV,
  listAskpassNodeCandidates,
  resolveAskpassNode,
} from '../dist/engine/nodePath.js'
import { gitAuthEnv, usesGitAskpass, writeAskpassFiles } from '../dist/engine/git.js'
import { SyncError } from '../dist/engine/errors.js'
import { GitRepoV2Port } from '../dist/sync/gitPort.js'
import {
  ASKPASS_NODE_NEXT_STEP, PUSH_ARGS, V2_ERROR, gitStageFailure, makeIntentId,
  runV2Cycle, typedCodeOf,
} from '../dist/sync/cycle.js'
import { FRESH_SCHEMA_TEXT } from '../dist/timeline/index.js'

const exec = promisify(execFile)

const FAKE_TOKEN = 'rt_FAKE_TOKEN_0123456789'
const APP = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const HTTPS = 'https://gitee.com/acme/repo.git'
const DAY = '2026-11-23'
const TS = `${DAY}T09:30:00+08:00`
const TS_ISO = '2026-11-23T01:30:00.000Z'
// electronVersion 就是注入进来的 process.versions.electron（非空 = execPath 是应用二进制）。
const ELECTRON = '30.0.0'

function winInputs(overrides = {}) {
  return {
    env: { Path: 'C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.CMD' },
    execPath: APP,
    electronVersion: ELECTRON,
    platform: 'win32',
    pathDelimiter: ';',
    fileExists: (p) => p.toLowerCase() === NODE.toLowerCase(),
    probe: () => true,
    ...overrides,
  }
}

function baseConfig(overrides = {}) {
  return {
    authMode: 'https',
    repoUrl: HTTPS,
    username: 'acme',
    token: FAKE_TOKEN,
    askpassPath: path.join(tmpdir(), 'fake-askpass.cmd'),
    ...overrides,
  }
}

/** assert.throws 不返回错误对象；这里手动捕获以便断言 typed code / 文案。 */
function captureThrow(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('预期抛出 typed 错误，实际未抛出')
}

/* -------------------------------------------------------------------------- */
/* 1. 解析顺序：override → PATH node → Electron 应用二进制 → typed 拒绝         */
/* -------------------------------------------------------------------------- */

test('解析顺序：override 优先于 PATH 与 execPath；无 override 时 PATH node 胜出', () => {
  const inputs = winInputs()
  assert.equal(inputs.env[ASKPASS_NODE_OVERRIDE_ENV], undefined)

  const order = listAskpassNodeCandidates(inputs)
  assert.deepEqual(order.map((c) => c.source).slice(0, 2), ['path', 'electron'])
  assert.equal(order[0].path.toLowerCase(), NODE.toLowerCase())
  assert.equal(order[0].electronRunAsNode, false)
  assert.equal(order[1].electronRunAsNode, true)

  const override = resolveAskpassNode(winInputs({
    env: { ...inputs.env, [ASKPASS_NODE_OVERRIDE_ENV]: NODE },
  }))
  assert.equal(override.path, NODE)
  assert.equal(override.source, 'override')

  const fromPath = resolveAskpassNode(inputs)
  assert.equal(fromPath.path.toLowerCase(), NODE.toLowerCase())
  assert.equal(fromPath.source, 'path')
  assert.equal(fromPath.electronRunAsNode, false)
})

test('应用二进制只在带 ELECTRON_RUN_AS_NODE=1 时才被选中；什么都找不到时 typed 拒绝', () => {
  const app = resolveAskpassNode(winInputs({
    env: { Path: '' },
    fileExists: () => false,
    probe: (candidate) => candidate.electronRunAsNode,
  }))
  assert.equal(app.path, APP)
  assert.equal(app.source, 'electron')
  assert.equal(app.electronRunAsNode, true)

  const error = captureThrow(() => resolveAskpassNode(winInputs({
    env: {},
    execPath: '',
    electronVersion: '',
    fileExists: () => false,
    probe: () => false,
  })))
  assert.equal(error.code, ASKPASS_NODE_MISSING_CODE)
  assert.equal(error.message, ASKPASS_NODE_MISSING_REASON)
  assert.deepEqual(error.details.tried, [])
})

/* -------------------------------------------------------------------------- */
/* 2. ELECTRON_RUN_AS_NODE 恰好在应用二进制候选出现                            */
/* -------------------------------------------------------------------------- */

test('ELECTRON_RUN_AS_NODE 在子进程 env 中：应用二进制有、真实 node 没有', () => {
  // 调用方 env 里即使带了 ELECTRON_RUN_AS_NODE=1，真实 node 候选也必须把它删掉。
  const realNodeEnv = gitAuthEnv(baseConfig({
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    nodePath: winInputs({ probe: () => true }),
  }))
  assert.equal(realNodeEnv.DSH_GIT_SYNC_NODE.toLowerCase(), NODE.toLowerCase())
  assert.equal(Object.hasOwn(realNodeEnv, 'ELECTRON_RUN_AS_NODE'), false,
    '真实 node.exe 不得拿到 Electron 专用变量')
  assert.equal(realNodeEnv.GIT_TERMINAL_PROMPT, '0')

  const appEnv = gitAuthEnv(baseConfig({
    nodePath: winInputs({
      env: { Path: '' },
      fileExists: () => false,
      probe: (candidate) => candidate.electronRunAsNode,
    }),
  }))
  assert.equal(appEnv.DSH_GIT_SYNC_NODE, APP)
  assert.equal(appEnv.ELECTRON_RUN_AS_NODE, '1',
    '应用二进制必须注入 ELECTRON_RUN_AS_NODE=1')
})

test('非 askpass 场景（无 token / SSH）完全不解析 node，保持原有行为', () => {
  const anonymous = gitAuthEnv(baseConfig({
    token: null,
    nodePath: winInputs({ probe: () => false }),
  }))
  assert.equal(usesGitAskpass({ authMode: 'https', repoUrl: HTTPS, token: null }), false)
  assert.equal(anonymous.DSH_GIT_SYNC_NODE, undefined)
  // 非 askpass 路径一字不动：继承什么就是什么（探针即使全失败也不得影响它）。
  assert.equal(anonymous.ELECTRON_RUN_AS_NODE, process.env.ELECTRON_RUN_AS_NODE)

  const ssh = gitAuthEnv(baseConfig({
    authMode: 'ssh',
    repoUrl: 'git@gitee.com:acme/repo.git',
    nodePath: winInputs({ probe: () => false }),
  }))
  assert.equal(ssh.DSH_GIT_SYNC_NODE, undefined)
  assert.equal(ssh.ELECTRON_RUN_AS_NODE, process.env.ELECTRON_RUN_AS_NODE)
})

/* -------------------------------------------------------------------------- */
/* 3. 探针失败：非零退出 / 错误标记一律拒绝（注入探针，不起子进程）             */
/* -------------------------------------------------------------------------- */

test('探针失败：坏候选被拒绝并回落到 PATH node；全部失败则 typed 拒绝', () => {
  const bad = 'C:\\bad\\node.exe'
  let probes = 0
  // 模拟坏候选「退出非 0 / 打印错误标记」：注入探针直接判 false。
  const probe = (candidate) => {
    probes += 1
    return candidate.path.toLowerCase() === NODE.toLowerCase()
  }
  const recovered = resolveAskpassNode(winInputs({
    env: {
      Path: 'C:\\Program Files\\nodejs',
      PATHEXT: '.EXE',
      [ASKPASS_NODE_OVERRIDE_ENV]: bad,
    },
    probe,
  }))
  assert.equal(recovered.path.toLowerCase(), NODE.toLowerCase())
  assert.equal(probes, 2, '坏 override 必须被探测并拒绝，再探测 PATH 候选')

  const error = captureThrow(() => resolveAskpassNode(winInputs({
    env: { [ASKPASS_NODE_OVERRIDE_ENV]: bad },
    electronVersion: '',
    fileExists: () => false,
    probe: () => false,
  })))
  assert.equal(error.code, ASKPASS_NODE_MISSING_CODE)
  assert.equal(error.message, ASKPASS_NODE_MISSING_REASON)
  assert.deepEqual(error.details.tried, [bad])
})

/* -------------------------------------------------------------------------- */
/* 4. token 卫生：askpass 文件与子进程 env                                     */
/* -------------------------------------------------------------------------- */

test('askpass.cmd / askpass.sh / askpass.mjs 不含 token；gitAuthEnv 只把 token 放进 token 变量', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'askpass-node-resolution-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  const files = await writeAskpassFiles(dir)
  for (const file of [files.cmd, files.sh, files.js]) {
    const text = await readFile(file, 'utf8')
    assert.equal(text.includes(FAKE_TOKEN), false, `${path.basename(file)} 不得包含 token`)
  }

  const env = gitAuthEnv(baseConfig({ nodePath: winInputs() }))
  const leaking = Object.entries(env)
    .filter(([, value]) => typeof value === 'string' && value.includes(FAKE_TOKEN))
    .map(([key]) => key)
  assert.deepEqual(leaking, ['DSH_GIT_SYNC_TOKEN'], 'token 只能出现在 token 变量里')
  assert.equal(env.DSH_GIT_SYNC_TOKEN, FAKE_TOKEN)
})

/* -------------------------------------------------------------------------- */
/* 5. 注入平台：Windows ; 分割 / 大小写不敏感，POSIX : 分割 / 大小写敏感        */
/* -------------------------------------------------------------------------- */

test('Windows：PATH 按 ; 分割、.exe 按大小写不敏感匹配；override 与 execPath 大小写不同也算应用二进制', () => {
  const env = { Path: 'C:\\Fake\\NodeJS;C:\\other', PATHEXT: '.COM;.EXE;.CMD' }
  const found = 'c:\\fake\\nodejs\\node.exe'
  const fileExists = (p) => p.toLowerCase() === found
  const fromPath = resolveAskpassNode({
    env, execPath: APP, electronVersion: ELECTRON, platform: 'win32', pathDelimiter: ';',
    fileExists, probe: () => true,
  })
  assert.equal(fromPath.path.toLowerCase(), found)
  assert.equal(fromPath.source, 'path')

  const appOverride = resolveAskpassNode({
    env: { Path: '', [ASKPASS_NODE_OVERRIDE_ENV]: 'c:\\app\\DSH.EXE' },
    execPath: 'C:\\App\\dsh.exe', electronVersion: ELECTRON, platform: 'win32', pathDelimiter: ';',
    fileExists: () => false, probe: () => true,
  })
  assert.equal(appOverride.electronRunAsNode, true, 'Windows 下路径比较必须大小写不敏感')
})

test('POSIX：PATH 按 : 分割、文件名精确匹配；大小写不同不算同一个应用二进制', () => {
  const fromPath = resolveAskpassNode({
    env: { PATH: '/usr/local/bin:/usr/bin' },
    execPath: '/opt/DSH', electronVersion: ELECTRON, platform: 'linux', pathDelimiter: ':',
    fileExists: (p) => p === '/usr/local/bin/node', probe: () => true,
  })
  assert.equal(fromPath.path, '/usr/local/bin/node')
  assert.equal(fromPath.source, 'path')
  assert.equal(fromPath.electronRunAsNode, false)

  const caseSensitive = resolveAskpassNode({
    env: { PATH: '', [ASKPASS_NODE_OVERRIDE_ENV]: '/OPT/DSH' },
    execPath: '/opt/DSH', electronVersion: ELECTRON, platform: 'linux', pathDelimiter: ':',
    fileExists: () => false, probe: () => true,
  })
  assert.equal(caseSensitive.electronRunAsNode, false, 'POSIX 下 /OPT/DSH != /opt/DSH')
})

/* -------------------------------------------------------------------------- */
/* 6. gitPort 接线：typed 拒绝先于 git 执行，绝不 auth-prompt                   */
/* -------------------------------------------------------------------------- */

test('pushMain：node 缺失抛 typed E_ASKPASS_NODE_MISSING，git 一次都没跑', async () => {
  let gitCalls = 0
  const port = new GitRepoV2Port({
    dir: path.join(tmpdir(), 'askpass-node-unused-worktree'),
    repoUrl: HTTPS,
    branch: 'main',
    authMode: 'https',
    username: 'acme',
    token: FAKE_TOKEN,
    platform: 'gitee',
    nodePath: winInputs({
      env: {},
      electronVersion: '',
      fileExists: () => false,
      probe: () => false,
    }),
    runner: async () => {
      gitCalls += 1
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  await assert.rejects(() => port.pushMain(PUSH_ARGS), (error) => {
    assert.equal(error.code, ASKPASS_NODE_MISSING_CODE)
    assert.equal(error.message, ASKPASS_NODE_MISSING_REASON)
    assert.equal(/auth-prompt|HTTPS 鉴权无法通过/.test(error.message), false)
    return true
  })
  assert.equal(gitCalls, 0, '解释器缺失时绝不能执行 git')
  await port.dispose()
})

/* -------------------------------------------------------------------------- */
/* 7. cycle.ts：push 失败保留 typed code，不再一律误报成「远端被其他设备推进」 */
/* -------------------------------------------------------------------------- */

class MemFsCycle {
  constructor() {
    this.files = new Map([['timeline/schema.json', FRESH_SCHEMA_TEXT]])
  }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) { const tmp = `${rel}.tmp`; this.files.set(tmp, text); return tmp }
  async readTemp(tmp) { return this.files.get(tmp) ?? '' }
  async rename(tmp, rel) { this.files.set(rel, this.files.get(tmp)); this.files.delete(tmp) }
  async backupIfExists() { return false }
  async append(rel, text) { this.files.set(rel, (this.files.get(rel) ?? '') + text) }
  async exists(rel) { return this.files.has(rel) }
}

class MemOutboxCycle {
  constructor(entries) { this.entries = entries.slice() }
  async load() { return this.entries.slice() }
  async save(entries) { this.entries = entries.slice() }
}

/** 其余端口方法给中性值；failAt 决定在 branch / fetch / push 哪一步抛错。 */
class PushFailGit {
  constructor(error, failAt = 'push') { this.error = error; this.failAt = failAt }
  async branchName() { if (this.failAt === 'branch') throw this.error; return 'main' }
  async fetchMain() { if (this.failAt === 'fetch') throw this.error }
  async headSha() { return 'a'.repeat(40) }
  async originMainSha() { return 'a'.repeat(40) }
  async showRemote() { return '' }
  async showHead() { return '' }
  async aheadBehind() { return { ahead: 0, behind: 0 } }
  async aheadCommits() { return [] }
  async addPaths() {}
  async commit() {}
  async pushMain() { if (this.failAt === 'push') throw this.error }
}

async function cycleWithPushError(error, failAt = 'push', state = 'pending') {
  const intent = {
    intentId: makeIntentId(DAY, 'a1', TS_ISO, 'upsert'),
    op: 'upsert', date: DAY, id: 'a1', ts: TS_ISO,
    line: JSON.stringify({
      id: 'a1', ts: TS_ISO, title: 't', body: '', author: '我', done: false,
      media: [], ai_processed: false, opened_at: TS_ISO,
    }),
    enqueuedAt: TS, attempts: 0, state, lastError: '',
  }
  const outbox = new MemOutboxCycle([intent])
  const result = await runV2Cycle({
    days: [DAY], git: new PushFailGit(error, failAt), fs: new MemFsCycle(), outbox, now: new Date(TS),
  })
  return { result, outbox }
}

test('cycle：E_ASKPASS_NODE_MISSING 保留 typed code 与修复指引，不冒充远端分叉', async () => {
  const { result, outbox } = await cycleWithPushError(
    new SyncError(ASKPASS_NODE_MISSING_CODE, ASKPASS_NODE_MISSING_REASON))
  assert.equal(result.code, ASKPASS_NODE_MISSING_CODE)
  assert.equal(result.ok, false)
  assert.equal(result.message.includes(ASKPASS_NODE_MISSING_CODE), true)
  assert.equal(result.message.includes('E_PUSH_REJECTED'), false)
  assert.equal(result.message.includes('其他设备推进'), false)
  assert.equal(result.message.includes('DSH_GIT_SYNC_NODE'), true)
  assert.equal(outbox.entries[0].lastError.includes(ASKPASS_NODE_MISSING_CODE), true)
})

test('cycle：E_PUSH_REJECTED 的 reason 文案逐字节不变', async () => {
  const { result } = await cycleWithPushError(
    new SyncError(V2_ERROR.PUSH_REJECTED, '推送失败：git 拒绝了本次推送，请检查远端状态后重试'))
  assert.equal(result.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(result.message,
    'E_PUSH_REJECTED: 推送失败：git 拒绝了本次推送，请检查远端状态后重试；'
    + '下一步：检查远端是否被其他设备推进，下一次同步会做有界重试，仍未成功请人工协调')
})

test('cycle：非 SyncError / 非 E_ 抛错仍降级为 E_PUSH_REJECTED 旧文案', async () => {
  const { result } = await cycleWithPushError(new Error('plain git failure'))
  assert.equal(result.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(result.message,
    'E_PUSH_REJECTED: plain git failure；'
    + '下一步：检查远端是否被其他设备推进，下一次同步会做有界重试，仍未成功请人工协调')
})

/* -------------------------------------------------------------------------- */
/* 8. 统一 typed helper 覆盖 stage-0 / fetch，防止意图卡在 syncing              */
/* -------------------------------------------------------------------------- */

test('统一 helper：typedCodeOf / gitStageFailure 只认 SyncError 的 E_ 码，下一步文案只有一份', () => {
  const error = new SyncError(ASKPASS_NODE_MISSING_CODE, ASKPASS_NODE_MISSING_REASON)
  assert.equal(typedCodeOf(error), ASKPASS_NODE_MISSING_CODE)
  assert.equal(typedCodeOf(new Error(`${ASKPASS_NODE_MISSING_CODE}: ${ASKPASS_NODE_MISSING_REASON}`)), '')
  const decided = gitStageFailure(error, { code: V2_ERROR.PULL_FAILED, message: 'fallback' })
  assert.equal(decided.code, ASKPASS_NODE_MISSING_CODE)
  assert.equal(decided.message,
    `${ASKPASS_NODE_MISSING_CODE}: ${ASKPASS_NODE_MISSING_REASON}${ASKPASS_NODE_NEXT_STEP}`)
  const genuine = gitStageFailure(new Error('fatal: unable to access remote'), {
    code: V2_ERROR.PULL_FAILED, message: '拉取远端失败：fatal: unable to access remote',
  })
  assert.deepEqual(genuine, {
    code: V2_ERROR.PULL_FAILED, message: '拉取远端失败：fatal: unable to access remote',
  })
})

test('cycle：branchName 抛 typed 不逃出周期；原 syncing 意图被停放写回', async () => {
  const { result, outbox } = await cycleWithPushError(
    new SyncError(ASKPASS_NODE_MISSING_CODE, ASKPASS_NODE_MISSING_REASON), 'branch', 'syncing')
  assert.equal(result.code, ASKPASS_NODE_MISSING_CODE)
  assert.equal(result.ok, false)
  assert.equal(result.message.includes(ASKPASS_NODE_NEXT_STEP), true)
  assert.equal(result.message.includes('E_PUSH_REJECTED'), false)
  assert.equal(outbox.entries[0].state, 'pending')
  assert.equal(outbox.entries[0].attempts, 1)
  assert.equal(outbox.entries[0].lastError.includes(ASKPASS_NODE_MISSING_CODE), true)
})

test('cycle：fetch 抛 typed 保留 code 并停放；非 typed 仍是 E_PULL_FAILED 今日文案', async () => {
  const typed = await cycleWithPushError(
    new SyncError(ASKPASS_NODE_MISSING_CODE, ASKPASS_NODE_MISSING_REASON), 'fetch', 'syncing')
  assert.equal(typed.result.code, ASKPASS_NODE_MISSING_CODE)
  assert.equal(typed.outbox.entries[0].state, 'pending')
  assert.equal(typed.outbox.entries[0].lastError.includes(ASKPASS_NODE_NEXT_STEP), true)

  const genuine = await cycleWithPushError(new Error('fatal: unable to access remote'), 'fetch')
  assert.equal(genuine.result.code, V2_ERROR.PULL_FAILED)
  assert.equal(genuine.result.message, '拉取远端失败：fatal: unable to access remote')
  assert.equal(genuine.outbox.entries[0].state, 'pending')
  assert.equal(genuine.outbox.entries[0].attempts, 0, '既有非 typed 路径不额外消耗预算')
})

/* -------------------------------------------------------------------------- */
/* 9. 探针环境 = 真实 askpass 环境；凭据唯一来源 = askpass + token              */
/* -------------------------------------------------------------------------- */

test('探针凭据卫生：探针 env 无任何凭据，真实 askpass env 仍带 token', () => {
  let probeEnv = null
  const probe = (candidate, context) => { probeEnv = context.env; return true }
  const env = gitAuthEnv(baseConfig({
    extraEnv: {
      Path: 'C:\\Program Files\\nodejs', PATHEXT: '.EXE',
      NODE_OPTIONS: '--no-addons', NODE_PATH: 'C:\\bad', ELECTRON_RUN_AS_NODE: '1',
    },
    nodePath: {
      execPath: APP, electronVersion: ELECTRON, platform: 'win32', pathDelimiter: ';',
      fileExists: (p) => p.toLowerCase() === NODE.toLowerCase(), probe,
    },
  }))
  assert.equal(probeEnv.NODE_OPTIONS, undefined)
  assert.equal(probeEnv.NODE_PATH, undefined)
  // 探针只需要证明解释器能跑 node：所有凭据类变量都必须被剥掉。
  assert.equal(Object.hasOwn(probeEnv, 'DSH_GIT_SYNC_TOKEN'), false)
  assert.equal(Object.values(probeEnv).includes(FAKE_TOKEN), false)
  assert.equal(Object.keys(probeEnv).some((key) => key.toUpperCase().startsWith('DSH_GIT_')), false)
  assert.equal(Object.keys(probeEnv).some((key) => key.toUpperCase().startsWith('GIT_CONFIG_')), false)
  assert.equal(Object.hasOwn(probeEnv, 'GIT_ASKPASS'), false)
  assert.equal(Object.hasOwn(probeEnv, 'GCM_INTERACTIVE'), false)
  // 真实 askpass 环境必须仍然带 token，否则这条断言会因「两边都删光」而假通过。
  assert.equal(env.DSH_GIT_SYNC_TOKEN, FAKE_TOKEN)
  // git 子进程自身保留原 env（假 git / 宿主钩子依赖它），只在启动 node 的那一刻清除。
  assert.equal(env.NODE_OPTIONS, '--no-addons')
  assert.equal(env.NODE_PATH, 'C:\\bad')
  assert.equal(Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE'), false)
  assert.equal(Object.hasOwn(probeEnv, 'ELECTRON_RUN_AS_NODE'), false)

  let appProbeEnv = null
  const appEnv = gitAuthEnv(baseConfig({
    nodePath: {
      env: { Path: '' }, execPath: APP, electronVersion: ELECTRON, platform: 'win32', pathDelimiter: ';',
      fileExists: () => false,
      probe: (candidate, context) => { appProbeEnv = context.env; return candidate.electronRunAsNode },
    },
  }))
  assert.equal(appEnv.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(appProbeEnv.ELECTRON_RUN_AS_NODE, '1')
})

test('凭据唯一来源 = askpass + token：helper 被中和，去掉 token 后不再产出凭据', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'askpass-no-helper-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  const files = await writeAskpassFiles(dir)
  const cmdText = await readFile(files.cmd, 'utf8')
  // 逐行字面量断言：两行 set 必须在解释器调用之前，且顺序固定（注释行无法通过）。
  const cmdLines = cmdText.split('\r\n')
  const optionsAt = cmdLines.indexOf('set NODE_OPTIONS=')
  const pathAt = cmdLines.indexOf('set NODE_PATH=')
  const nodeAt = cmdLines.findIndex((line) => line.includes('%DSH_GIT_SYNC_NODE%'))
  assert.notEqual(optionsAt, -1)
  assert.notEqual(pathAt, -1)
  assert.ok(optionsAt < pathAt && pathAt < nodeAt)

  const env = gitAuthEnv(baseConfig({
    askpassPath: files.js, askpassCounter: files.counter, username: 'acme', nodePath: winInputs(),
  }))
  assert.equal(env.DSH_GIT_SYNC_TOKEN, FAKE_TOKEN, '真实 askpass 环境必须仍带 token')
  assert.equal(env.GIT_CONFIG_COUNT, '1')
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper')
  assert.equal(env.GIT_CONFIG_VALUE_0, '')
  assert.equal(env.GCM_INTERACTIVE, 'Never')

  // 模拟 shim 在启动 node 时的净化，env 其余部分与 git 交给 askpass 的完全一致。
  const askpassEnv = { ...env, NODE_OPTIONS: '', NODE_PATH: '' }
  // 用当前宿主 node 执行脚本（POSIX CI 上不应依赖 Windows 盘符路径）。
  const nodeBin = process.execPath
  const prompt = "Password for 'https://gitee.com/acme/repo.git':"
  const userPrompt = "Username for 'https://gitee.com/acme/repo.git':"
  const username = await exec(nodeBin, [files.js, userPrompt], { env: askpassEnv })
  assert.equal(username.stdout.replace(/\r?\n$/, ''), 'acme')
  const password = await exec(nodeBin, [files.js, prompt], { env: askpassEnv })
  assert.equal(password.stdout.replace(/\r?\n$/, ''), FAKE_TOKEN)

  const withoutToken = { ...askpassEnv, DSH_GIT_SYNC_TOKEN: '' }
  const noPassword = await exec(nodeBin, [files.js, prompt], { env: withoutToken })
  assert.equal(noPassword.stdout.replace(/\r?\n$/, ''), '', '没有 token 时不得回落到任何缓存凭据')

  if (process.platform === 'win32') {
    // .cmd 不转发 git 的提示文本，按调用顺序：第一次用户名，第二次 token（与既有 M5 测试一致）。
    const first = await exec('cmd.exe', ['/d', '/c', files.cmd], { env, cwd: dir })
    assert.equal(first.stdout.replace(/\r?\n$/, ''), 'acme')
    const second = await exec('cmd.exe', ['/d', '/c', files.cmd], { env, cwd: dir })
    assert.equal(second.stdout.replace(/\r?\n$/, ''), FAKE_TOKEN)
  }
})
