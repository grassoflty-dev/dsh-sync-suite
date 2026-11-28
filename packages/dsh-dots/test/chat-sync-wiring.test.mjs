/**
 * chat-sync-wiring（P0）：证明 chatExport 端口真的接进生产装配点，且缺省时周期逐字节不变。
 *
 * 与 chat-export-auto.test.mjs 同款手法：本轮改动的 *.ts 在内存里转译到系统临时目录，
 * 未改动的依赖继续从 HEAD 原样的 dist 读取；因此 packages/dsh-dots/dist 不被触碰，
 * Lead 的 DSH 重启窗口保持打开。
 *
 * 两条断言的变异语义：
 *   ① 删掉 bootstrap.ts 里的 chatExport 接线行 ⇒ 捕获到的 CycleOptions.chatExport 消失 ⇒ 红；
 *   ② 若周期把缺省端口改成"自动补一个实现"、无条件调用 run() 或把 chats/** 写进
 *      writtenPaths ⇒ 无端口周期不再是今天的形状 ⇒ 红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(pkgDir, 'package.json'))
const ts = require('typescript')
const srcDir = path.join(pkgDir, 'src')
const distDir = path.join(pkgDir, 'dist')
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-sync-wiring-'))

/** bootstrap 接线 + 周期 + chats 的现成导出；其余依赖仍读 HEAD 的 dist。 */
const MODULES = [
  'sync/bootstrap.ts',
  'sync/cycle.ts',
  'chats/index.ts',
  'chats/exportChats.ts',
  // P1-1：把 rpc.ts 也转译进临时目录，才能对 getState 的注入口做**功能**断言；
  // 依赖仍从 HEAD 原样的 dist 读，dist 一字不碰。
  'rpc.ts',
]
const tempBySource = new Map()
for (const rel of MODULES) {
  tempBySource.set(path.join(srcDir, rel), path.join(tmpRoot, `${rel.replace(/[\\/]/g, '__')}.mjs`))
}

function materialize(rel) {
  const src = path.join(srcDir, rel)
  const dest = tempBySource.get(src)
  if (existsSync(dest)) return dest
  const output = ts.transpileModule(readFileSync(src, 'utf8'), {
    fileName: src,
    compilerOptions: {
      module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    },
  }).outputText
  const rewritten = output.replace(/(\bfrom\s*|\bimport\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g, (_all, prefix, spec) => {
    const abs = path.resolve(path.dirname(src), spec)
    const asSource = abs.replace(/\.js$/, '.ts')
    const target = tempBySource.has(asSource)
      ? pathToFileURL(tempBySource.get(asSource)).href
      : pathToFileURL(path.join(distDir, path.relative(srcDir, abs))).href
    return `${prefix}'${target}'`
  })
  writeFileSync(dest, rewritten, 'utf8')
  return dest
}
for (const rel of MODULES) materialize(rel)

const cache = new Map()
function load(rel) {
  if (!cache.has(rel)) cache.set(rel, import(pathToFileURL(tempBySource.get(path.join(srcDir, rel))).href))
  return cache.get(rel)
}

const { SettingsStore, defaultSettings } = require(path.join(distDir, 'engine', 'settings.js'))
const { statePaths } = require(path.join(distDir, 'engine', 'paths.js'))
const { FRESH_SCHEMA_TEXT } = require(path.join(distDir, 'timeline', 'records.js'))

const DAY = '2026-11-19'
const T1000 = `${DAY}T10:00:00+08:00`

/* ------------------------------------------------------- (a) 生产路径真的注入了端口 */

test('CW-WIR-01 生产装配点把真实 chatExport 端口交给 runV2Cycle', async () => {
  const { V2SyncRuntime } = await load('sync/bootstrap.ts')
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-wiring-positive-'))
  let captured
  try {
    const store = new SettingsStore(statePaths(root))
    store.writeSettings({
      ...defaultSettings(),
      repoUrl: 'https://example.test/chat-sync-wiring.git',
    })
    const runtime = new V2SyncRuntime({
      homeDir: root,
      appFilesDir: '',
      cycleRunner: async (options) => {
        captured = options
        // 桩执行器：只观察装配结果，绝不放行真实周期（不联网、不写仓库）。
        return {
          ok: true, code: 'ok', message: 'stub', days: options.days.slice(),
          applied: 0, dropped: 0, failed: 0, pending: 0, attempts: 1, conflicts: 0,
          writtenPaths: [], outbox: [],
        }
      },
    })
    const result = await runtime.syncNow([DAY])
    assert.equal(result.code, 'ok', '桩执行器的结果原样上报')

    // 关键断言：不是"给了端口就能跑"，而是生产构造路径**自己**给了端口。
    assert.notEqual(captured, undefined, 'runCycle 必须真的构造过 CycleOptions')
    assert.notEqual(captured.chatExport, undefined, 'bootstrap.ts 的接线行被删就会在这里红')
    assert.equal(typeof captured.chatExport.run, 'function', '端口必须携带可调用 run')

    // 证明是 chats/ 现成实现编排出来的适配器，而不是测试桩或第二份实现。
    const runSource = String(captured.chatExport.run)
    assert.match(runSource, /selectAutoExportCandidates/)
    assert.match(runSource, /writeChatExportPayloads/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------- (b) 无端口时周期仍是今天的形状 */

class MemFs {
  constructor(seed = {}) {
    this.files = new Map(Object.entries(seed))
    this.calls = []
  }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) { const t = `${rel}.tmp`; this.calls.push(['writeTemp', rel]); this.files.set(t, text); return t }
  async readTemp(t) { return this.files.get(t) ?? '' }
  async rename(t, rel) { this.calls.push(['rename', rel]); this.files.set(rel, this.files.get(t)); this.files.delete(t) }
  async backupIfExists(rel, b) {
    this.calls.push(['backup', rel])
    if (!this.files.has(rel)) return false
    this.files.set(b, this.files.get(rel)); return true
  }
  async append(rel, text) { this.calls.push(['append', rel]); this.files.set(rel, (this.files.get(rel) ?? '') + text) }
  async exists(rel) { return this.files.has(rel) }
  writeCalls() { return this.calls.filter((c) => ['writeTemp', 'append', 'backup'].includes(c[0])) }
}

class FakeGit {
  constructor() {
    this.branch = 'main'
    this.head = 'sha-1'
    this.origin = 'sha-1'
    this.headFiles = {}
    this.remote = {}
    this.calls = []
  }
  async branchName() { return this.branch }
  async fetchMain() { this.calls.push(['fetch']) }
  async headSha() { return this.head }
  async originMainSha() { return this.origin }
  async showRemote(rel) { return this.remote[rel] ?? '' }
  async showHead(rel) { return this.headFiles[rel] ?? '' }
  async addPaths(paths) { this.calls.push(['add', paths.slice()]) }
  async commit(message, body) { this.calls.push(['commit', message, body]) }
  async pushMain(args) { this.calls.push(['push', args]) }
  async aheadBehind() { return { ahead: 0, behind: 0 } }
  async aheadCommits() { return [] }
  writes() { return this.calls.filter((c) => ['add', 'commit', 'push'].includes(c[0])) }
}

class MemOutbox {
  constructor(entries = []) { this.entries = entries.slice(); this.saves = 0 }
  async load() { return this.entries.slice() }
  async save(entries) { this.saves += 1; this.entries = entries.slice() }
}

test('CW-WIR-02 无 chatExport 时周期不发布、不新增失败、不崩溃', async () => {
  const cycle = await load('sync/cycle.ts')
  const fs = new MemFs()
  const git = new FakeGit()
  const outbox = new MemOutbox()

  // options 里刻意不出现 chatExport：这就是"接线被删掉"后的真实运行形状。
  const options = { days: [], git, fs, outbox, now: new Date(T1000) }
  assert.equal(options.chatExport, undefined)
  const result = await cycle.runV2Cycle(options)

  // 今天的成功形状逐字保持：ok / 'ok' / '已同步'，没有导出阶段的新文案。
  assert.equal(result.ok, true)
  assert.equal(result.code, 'ok')
  assert.equal(result.message, '已同步')
  assert.notEqual(result.code, 'E_CHAT_EXPORT')
  assert.ok(Array.isArray(result.writtenPaths))

  // 没有 chats/** 被发布：writtenPaths、addPaths、commit body 三处共同证明。
  assert.deepEqual(result.writtenPaths, ['timeline/schema.json'])
  assert.equal(result.writtenPaths.some((p) => p.startsWith('chats/')), false)
  const add = git.calls.find((c) => c[0] === 'add')
  assert.notEqual(add, undefined)
  assert.equal(add[1].some((p) => p.startsWith('chats/')), false)
  const commit = git.calls.find((c) => c[0] === 'commit')
  assert.notEqual(commit, undefined)
  assert.equal(commit[2], cycle.v2TrailerLine())
  assert.equal(commit[2].includes(cycle.CHAT_EXPORT_TRAILER_PREFIX), false)

  // fail-closed-by-construction：cycle.ts:1669-1679 的 if 守卫是唯一入口，
  // 缺省时 run() 根本不会被调用；把守卫删掉或让阶段无条件跑，这里与上面都会红。
  const cycleSrc = readFileSync(path.join(srcDir, 'sync', 'cycle.ts'), 'utf8')
  assert.match(cycleSrc, /let exportOutcome: AutoChatExportOutcome \| undefined/)
  assert.match(cycleSrc, /if \(options\.chatExport !== undefined\)/)
  assert.match(cycleSrc, /if \(options\.chatExport !== undefined\)[\s\S]{0,180}options\.chatExport\.run\(\)/)
})

/* ---------------------------- P1-1：status.chatExportLine 有真实生产者 */

const chatOutcome = (over = {}) => ({
  paths: [], exported: 0, remaining: 0, truncated: 0, timedOut: false, reason: '', ...over,
})

async function runChatCycle(outcome, { seed = {}, pushError, runError } = {}) {
  const cycle = await load('sync/cycle.ts')
  const git = new FakeGit()
  if (pushError !== undefined) git.pushMain = async () => { throw pushError }
  const result = await cycle.runV2Cycle({
    days: [], git, fs: new MemFs(seed), outbox: new MemOutbox(), now: new Date(T1000),
    chatExport: {
      run: async () => {
        if (runError !== undefined) throw runError
        return outcome
      },
    },
  })
  return { cycle, result }
}

test('CW-P1-01 chatExportLineFromCycle 逐字覆盖五种状态（生产者被删即红）', async () => {
  const cycle = await load('sync/cycle.ts')
  const boot = await load('sync/bootstrap.ts')
  const view = (over = {}) => ({
    exported: 0, remaining: 0, truncated: 0, timedOut: false, wrote: false, ...over,
  })
  const result = (over = {}) => ({
    ok: true, code: 'ok', message: 'stub', days: [], applied: 0, dropped: 0,
    failed: 0, pending: 0, attempts: 1, conflicts: 0, writtenPaths: [], outbox: [], ...over,
  })

  assert.equal(boot.chatExportLineFromCycle(result()), '', '没有导出阶段的周期不渲染那一行')
  assert.equal(boot.chatExportLineFromCycle(result({ chatExport: view() })),
    '本轮无变更，未提交未推送（自动发布 0 个）')
  assert.equal(boot.chatExportLineFromCycle(result({ chatExport: view({ exported: 3, wrote: true }) })),
    '已同步（自动发布 3 个）')
  assert.equal(boot.chatExportLineFromCycle(result({ chatExport: view({ exported: 3, truncated: 2, wrote: true }) })),
    '已同步（自动发布 3 个；本轮跳过 2 个不完整会话）')
  assert.equal(boot.chatExportLineFromCycle(result({
    chatExport: view({ exported: 3, remaining: 4, timedOut: true, wrote: true }),
  })), '部分发布：3 个；本轮超时，剩余 4 个下次同步继续')

  // 失败态：周期 message 就是面板文案，四类常量已在 cycle.ts 的生产分支里生成。
  assert.equal(boot.chatExportLineFromCycle(result({
    ok: false, code: 'E_CHAT_EXPORT',
    message: cycle.chatExportFailureLineOf('E_UNCONFIGURED: 尚未配置同步仓库'), chatExport: view(),
  })), '未配置同步仓库，自动发布暂停')
  assert.equal(boot.chatExportLineFromCycle(result({
    ok: false, code: 'E_CHAT_EXPORT',
    message: cycle.chatExportFailureLineOf('index-schema-rejected'), chatExport: view(),
  })), '自动发布暂停：索引格式被拒（typed 原因），未写半行（index-schema-rejected）')
  assert.equal(boot.chatExportLineFromCycle(result({
    ok: false, code: 'E_CHAT_EXPORT',
    message: cycle.chatExportFailureLineOf('bad-jsonl: 第 3 行坏 JSON'), chatExport: view(),
  })), '自动发布暂停：bad-jsonl: 第 3 行坏 JSON')
})

test('CW-P1-02 真实周期跑出的失败/部分态与面板状态行逐字相同', async () => {
  const boot = await load('sync/bootstrap.ts')

  const pushed = await runChatCycle(chatOutcome({ exported: 2 }), { pushError: new Error('模拟推送失败') })
  assert.equal(pushed.result.ok, false)
  assert.equal(pushed.result.code, 'E_PUSH_REJECTED')
  const NEXT = '；下一步：检查远端是否被其他设备推进，下一次同步会做有界重试，仍未成功请人工协调'
  assert.equal(pushed.result.message,
    `${pushed.cycle.CHAT_EXPORT_PUSH_FAILED_LINE}（E_PUSH_REJECTED: 模拟推送失败${NEXT}）`)
  assert.equal(pushed.result.message.includes('已同步'), false)
  assert.equal(boot.chatExportLineFromCycle(pushed.result), pushed.result.message)

  const schema = await runChatCycle(chatOutcome({ reason: 'index-schema-rejected' }))
  assert.equal(schema.result.code, 'E_CHAT_EXPORT')
  assert.equal(schema.result.message,
    `${schema.cycle.CHAT_EXPORT_SCHEMA_REJECTED_LINE}（index-schema-rejected）`)
  assert.deepEqual(schema.result.writtenPaths, [], 'schema 拒绝零写入')
  assert.equal(boot.chatExportLineFromCycle(schema.result), schema.result.message)

  const repo = await runChatCycle(chatOutcome(), {
    runError: new Error('E_UNCONFIGURED: 尚未配置同步仓库'),
  })
  assert.equal(repo.result.code, 'E_CHAT_EXPORT')
  assert.equal(repo.result.message, repo.cycle.CHAT_EXPORT_REPO_MISSING_LINE)
  assert.equal(boot.chatExportLineFromCycle(repo.result), repo.result.message)

  const skipped = await runChatCycle(chatOutcome({ exported: 3, truncated: 2 }))
  assert.equal(skipped.result.ok, true)
  assert.equal(skipped.result.message,
    `已同步（自动发布 3 个；${skipped.cycle.chatExportTruncatedLine(2)}）`)
  assert.equal(boot.chatExportLineFromCycle(skipped.result), skipped.result.message)

  const timedOut = await runChatCycle(chatOutcome({ exported: 3, remaining: 4, timedOut: true }))
  assert.equal(timedOut.result.message, timedOut.cycle.chatExportPartialMessage(3, 4))
  assert.equal(boot.chatExportLineFromCycle(timedOut.result), timedOut.result.message)

  const nothing = await runChatCycle(chatOutcome(), {
    seed: { 'timeline/schema.json': FRESH_SCHEMA_TEXT },
  })
  assert.deepEqual(nothing.result.writtenPaths, [])
  assert.equal(nothing.result.message, '本轮无变更，未提交未推送（自动发布 0 个）')
  assert.equal(boot.chatExportLineFromCycle(nothing.result), nothing.result.message)
})

test('CW-P1-03 V2SyncRuntime 把周期结果投影到 status.chatExportLine', async () => {
  const boot = await load('sync/bootstrap.ts')
  const cycle = await load('sync/cycle.ts')
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-status-runtime-'))
  try {
    const store = new SettingsStore(statePaths(root))
    store.writeSettings({ ...defaultSettings(), repoUrl: 'https://example.test/chat-status.git' })
    const runtime = new boot.V2SyncRuntime({
      homeDir: root,
      appFilesDir: '',
      cycleRunner: async (options) => ({
        ok: true, code: 'ok', message: '已同步（自动发布 4 个）', days: options.days.slice(),
        applied: 0, dropped: 0, failed: 0, pending: 0, attempts: 1, conflicts: 0,
        writtenPaths: [], outbox: [],
        chatExport: { exported: 4, remaining: 0, truncated: 0, timedOut: false, wrote: true },
      }),
    })
    await runtime.syncNow([DAY])
    assert.equal(runtime.status.chatExportLine, '已同步（自动发布 4 个）')
    assert.equal(runtime.status.chatExportLine,
      cycle.chatExportSuccessLineOf(runtime.status.cycle.chatExport))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const unconfigured = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-status-unconfigured-'))
  try {
    const runtime = new boot.V2SyncRuntime({ homeDir: unconfigured, appFilesDir: '' })
    await runtime.start()
    assert.equal(runtime.status.chatExportLine, cycle.CHAT_EXPORT_REPO_MISSING_LINE)
  } finally {
    rmSync(unconfigured, { recursive: true, force: true })
  }
})

test('CW-P1-04 getState 真的调用生产者；生产接线；面板那一行不可点', async () => {
  const { createRpcService } = await load('rpc.ts')
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-status-getstate-'))
  try {
    const LINE = '自动发布暂停：推送失败，已写入的提交保留；本轮不自动重试（E_PUSH_REJECTED: 模拟）'
    let calls = 0
    const service = createRpcService({
      homeDir: root,
      allowLocalRepo: true,
      chatExportStatusLine: () => { calls += 1; return LINE },
    })
    const response = await service.handleRpc({ action: 'getState' })
    assert.equal(response.ok, true)
    assert.equal(response.data.status.chatExportLine, LINE)
    assert.ok(calls > 0, 'getState 必须真的调用注入的生产者，不能由测试直接塞字段')
    await service.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const indexSrc = readFileSync(path.join(srcDir, 'index.ts'), 'utf8')
  assert.match(indexSrc, /chatExportStatusLine:\s*\(\)\s*=>\s*v2Runtime\?\.status\?\.chatExportLine/)
  assert.match(indexSrc, /v2Runtime\s*=\s*mountV2Sync\(/)

  const clientSrc = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  const at = clientSrc.indexOf("'chat-export-status'")
  assert.ok(at >= 0, '面板必须仍然渲染 chat-export-status 那一行')
  const end = clientSrc.indexOf(': null,', at)
  const block = clientSrc.slice(at, end + 7) // 只到三元表达式的 : null，不把后面的「保存」按钮算进来
  assert.equal(/onClick/.test(block), false, '状态行上没有点击回调')
  assert.equal(/Btn/.test(block), false, '状态行自身不是按钮')
  assert.match(block, /view\.status\.chatExportLine/, '渲染的文本只能来自 status.chatExportLine')
})

/* ------------------------------- 独立评审 F1/F4：失败也要给非空、点名实情的面板行 */

test('CW-F1-01 提交后落后未推：面板行非空且点名「已提交但未推送」', async () => {
  const cycle = await load('sync/cycle.ts')
  const boot = await load('sync/bootstrap.ts')
  const git = new FakeGit()
  // 初始事实：本地落后一行 → 决策 fast-forward；快进被本地改动挡住 → ffBlocked。
  git.headSha = async () => 'local-head'
  git.originMainSha = async () => 'origin-head'
  git.aheadBehind = async () => ({ ahead: 0, behind: 1 })
  git.fastForward = async () => ({ status: 'blocked-by-local-changes' })

  let ran = 0
  const result = await cycle.runV2Cycle({
    days: [], git, fs: new MemFs(), outbox: new MemOutbox(), now: new Date(T1000),
    chatExport: {
      run: async () => {
        ran += 1
        return chatOutcome({ paths: ['chats/s1/meta.json'], exported: 1 })
      },
    },
  })

  // 先把场景钉死：导出确实跑了、chat 载荷确实进了本地提交、但一次 push 都没有。
  assert.equal(ran, 1, '导出阶段必须真的跑过')
  const commit = git.calls.find((call) => call[0] === 'commit')
  assert.notEqual(commit, undefined, '必须先有本地提交，否则测的不是「已提交但未推送」')
  assert.equal(commit[2].includes(cycle.CHAT_EXPORT_TRAILER_PREFIX), true, '提交带 chat 尾注')
  assert.equal(git.calls.some((call) => call[0] === 'push'), false, '本路径绝不发生 push')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_NOT_SYNCED')

  // F1 本体：failure() 不带视图 ⇒ bootstrap 投影空串；message 不带 stranded 实情 ⇒ 只说门禁失败。
  assert.notEqual(result.chatExport, undefined, '失败也必须有 chatExport 视图')
  const line = boot.chatExportLineFromCycle(result)
  assert.notEqual(line, '', '面板状态行不能是空串')
  assert.equal(line, result.message, '失败态的面板行就是周期 message')
  assert.match(line, /自动发布暂停/, '必须沿用既有 CHAT_EXPORT_* 前缀')
  assert.match(line, /已提交但未推送/, '必须点名内容 stranded 在本地：已提交但未推送')
  assert.equal(line,
    `${cycle.CHAT_EXPORT_COMMITTED_NOT_PUSHED_LINE}（${cycle.FF_BLOCKED_PENDING_MESSAGE}）`,
    '整行逐字钉住：新状态常量 + 原门禁原因，不能退化成裸失败词')
})

test('CW-F4-01 意图/记录形状被拒：pre-export E_CORRUPT 也给出「本轮未发布」的非空行', async () => {
  const cycle = await load('sync/cycle.ts')
  const boot = await load('sync/bootstrap.ts')
  const git = new FakeGit()
  // ts 形状非法 ⇒ unionDay 内的 assertUpsertIntent 抛 typed E_CORRUPT，发生在导出阶段之前。
  const badIntent = {
    intentId: 'bad-ts-1', op: 'upsert', date: DAY, id: 'x', ts: 'not-a-timestamp',
    line: '{"id":"x","ts":"not-a-timestamp","title":"t"}',
    enqueuedAt: T1000, attempts: 0, state: 'pending', lastError: '',
  }
  let ran = 0
  const result = await cycle.runV2Cycle({
    days: [DAY], git, fs: new MemFs(), outbox: new MemOutbox([badIntent]), now: new Date(T1000),
    chatExport: {
      run: async () => {
        ran += 1
        return chatOutcome()
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_CORRUPT')
  assert.equal(ran, 0, 'unionDay 抛错时导出阶段根本没机会跑')
  assert.equal(git.calls.some((call) => call[0] === 'push'), false, '零推送')
  assert.deepEqual(result.writtenPaths, [], '零写入')

  // F4 本体：同 chat-index 拒绝的先例，失败也要有视图 + 说出「本轮未发布」。
  assert.notEqual(result.chatExport, undefined, 'pre-export 拒绝也必须有 chatExport 视图')
  const line = boot.chatExportLineFromCycle(result)
  assert.notEqual(line, '', '面板状态行不能是空串')
  assert.equal(line, result.message, '失败态的面板行就是周期 message')
  assert.match(line, /记录格式被拒/, '必须点名是记录被拒')
  assert.match(line, /本轮未发布/, '必须说明本轮什么都没发布，而不是只说失败')
  assert.equal(line,
    `${cycle.CHAT_EXPORT_RECORD_REJECTED_LINE}（E_CORRUPT: outbox upsert bad-ts-1 的 ts 形状非法：not-a-timestamp）`,
    '整行逐字钉住：新状态常量 + typed 原因')
})
