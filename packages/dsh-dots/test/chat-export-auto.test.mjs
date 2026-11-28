/**
 * mod-plugin-chat-export-auto，phase 1 静态证明（不跑 scripts/build.mjs）。
 *
 * 本测试**不改动 dist**：用已安装的 typescript 把本轮改过的三份 src/*.ts 在内存里
 * 转译到系统临时目录，相对 import 改指到 HEAD 原样 dist 的依赖；因此
 * `packages/dsh-dots/dist` 与 HEAD 8954aa1 逐字节一致，Lead 的 DSH 重启不被阻断。
 *
 * 这些断言证明的是「代码形状与纯逻辑」，**不是**导出阶段已在真实周期跑通；
 * 真机运行要等 phase 2 构建与注入宿主端口之后才可以宣称。
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
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-export-auto-'))

/** 本轮改动的模块；其余依赖继续从 HEAD 的 dist 读取。 */
const MODULES = ['chats/exportChats.ts', 'chats/index.ts', 'sync/cycle.ts']
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

/** 固定夹具：header + 一条 user 事件，正文不含凭据/绝对路径。 */
function sessionOf(id, text) {
  const header = { type: 'session', id, title: 'T', createdAt: 1700000000000, cwd: '/proj', agentPreset: 'standard' }
  const events = [{ type: 'user/message', seq: 1, time: 1700000000000, data: { text } }]
  const rawJsonl = `${[header, ...events].map((row) => JSON.stringify(row)).join('\n')}\n`
  return {
    info: { sessionId: id, slug: 'p', file: `fake://${id}`, bytes: rawJsonl.length, mtime: 1700000000000 },
    source: { header, events, rawJsonl, badLines: 0, truncated: false },
  }
}

const NOW = new Date('2026-11-28T00:00:00Z')

/* ------------------------------------------------------------------ §10 条件 1 */

/** 表驱动的拒绝表：名字 + 路径；每一条都必须被精确白名单拒绝。 */
const REJECTS = [
  ['bare-chats-dir', 'chats/'],
  ['bare-id-dir', 'chats/s1/'],
  ['other-file-under-id', 'chats/s1/anything-else'],
  ['config-json-in-chats', 'chats/config.json'],
  ['meta-backup-suffix', 'chats/s1/meta.json.bak'],
  ['index-with-query', 'chats/index.jsonl?x=1'],
  ['index-as-dir', 'chats/index.jsonl/meta.json'],
  ['double-slash', 'chats//s1/meta.json'],
  ['absolute-posix', '/chats/s1/meta.json'],
  ['absolute-drive', 'C:\\repo\\chats\\s1\\meta.json'],
  ['backslash-relative', 'chats\\s1\\meta.json'],
  ['traversal-leading', '../chats/s1/meta.json'],
  ['traversal-index', 'chats/../s1/meta.json'],
  ['traversal-id', 'chats/s1/../s2/meta.json'],
  ['traversal-file', 'chats/s1/../../etc/passwd'],
  ['dot-segment', 'chats/./s1/meta.json'],
  ['dot-id', 'chats/./meta.json'],
  ['dotdot-id', 'chats/../meta.json'],
  ['id-with-slash', 'chats/s/1/meta.json'],
  ['devices-registry', 'devices/registry.jsonl'],
  ['devices-schedule', 'devices/pc-a/schedules/2026-11-27.jsonl'],
  ['config-manifest', 'manifest.json'],
  ['config-cordis-patch', 'cordis.patch.yml'],
  ['timeline-not-export-class', 'timeline/2026-11-27/records.json'],
  ['empty-path', ''],
]

test('CE-01 精确白名单放行表 + 表驱动拒绝表（25 条拒绝）', async () => {
  const cycle = await load('sync/cycle.ts')
  for (const p of [
    'chats/index.jsonl',
    'chats/s1/meta.json',
    'chats/s1/session.jsonl',
    'chats/abc.def-1/session.jsonl',
  ]) assert.equal(cycle.isConfinedChatExportPath(p), true, p)
  assert.equal(REJECTS.length, 25, '拒绝表条数被钉住，删条必须同时改本断言')
  for (const [name, p] of REJECTS) {
    assert.equal(cycle.isConfinedChatExportPath(p), false, name)
  }
  // 裸目录 / 配置载荷即使带导出尾注也不能归 ours。
  const exportBody = `${cycle.v2TrailerLine()}\n${cycle.chatExportTrailerLine()}`
  for (const [name, p] of REJECTS.slice(0, 5)) {
    const commit = { subject: '[v2] sync 1 days', body: exportBody, paths: ['chats/index.jsonl', p] }
    assert.equal(cycle.isOursCommit(commit), false, name)
  }
})

/* ------------------------------------------------------------ §10 条件 2 / 尾注 */

test('CE-02 平板隐藏提交无法把 chats/<id>/** 带进 ours，写盘阶段也拒隐藏 id', async () => {
  const cycle = await load('sync/cycle.ts')
  const ex = await load('chats/exportChats.ts')
  const hide = {
    subject: 'chats: delete s1',
    body: cycle.v2TrailerLine(), // 只有 v2 尾注，没有导出尾注
    paths: ['chats/index.jsonl', 'chats/s1/session.jsonl'],
  }
  assert.equal(cycle.isOursCommit(hide), false)
  const verdict = cycle.describePendingOwnership([hide])
  assert.equal(verdict.ours, false)
  assert.equal(verdict.verdicts[0].verdict, 'untrusted')
  assert.equal(verdict.verdicts[0].outsideScopePaths, 1)
  assert.match(verdict.verdicts[0].reason, /载荷缺少导出尾注/)

  // 尝试写：索引里已有 archive 行 ⇒ 写盘器必须跳过，载荷目录根本不出现。
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-hide-refuse-'))
  const chatsDir = path.join(workDir, 'chats')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(chatsDir, { recursive: true })
  writeFileSync(path.join(chatsDir, 'index.jsonl'), `${JSON.stringify({ op: 'archive', id: 's1', deletedAt: 1700000000001 })}\n`, 'utf8')
  const { info, source } = sessionOf('s1', 'hello')
  const built = ex.buildChatExport(info, source, { deviceId: 'pc-a', now: NOW })
  const result = await ex.writeChatExportPayloads(workDir, [built], new Map([[built.id, { action: 'export', reason: 'new' }]]))
  assert.deepEqual(result.paths, [])
  assert.equal(existsSync(path.join(chatsDir, 's1')), false)
  rmSync(workDir, { recursive: true, force: true })
})

test('CE-03 同步类尾注：与 v2 尾注分开，且只有带它的提交能放行载荷', async () => {
  const cycle = await load('sync/cycle.ts')
  assert.equal(cycle.CHAT_EXPORT_TRAILER_PREFIX, 'dsh-dots-chat-sync:')
  assert.notEqual(cycle.CHAT_EXPORT_TRAILER_PREFIX, cycle.V2_TRAILER_PREFIX)
  const body = `${cycle.v2TrailerLine()}\n${cycle.chatExportTrailerLine()}`
  assert.equal(cycle.hasChatExportTrailer(body), true)
  assert.equal(cycle.hasChatExportTrailer(cycle.v2TrailerLine()), false)
  const exportCommit = {
    subject: '[v2] sync 1 days',
    body,
    paths: ['chats/index.jsonl', 'chats/s1/meta.json', 'chats/s1/session.jsonl'],
  }
  assert.equal(cycle.isOursCommit(exportCommit), true)
  assert.equal(cycle.isOursCommit({ ...exportCommit, paths: [...exportCommit.paths, 'devices/x'] }), false)
  assert.equal(cycle.isOursCommit({ ...exportCommit, body: cycle.chatExportTrailerLine() }), false)
  assert.equal(cycle.chatExportPartialMessage(7, 12), '部分发布：7 个；本轮超时，剩余 12 个下次同步继续')
  assert.equal(cycle.chatExportPartialMessage(0, 0), '部分发布：0 个；本轮超时，未处理的会话下次同步继续')
})

/* ------------------------------------------------------------- §2 幂等变更门控 */

test('CE-04 三次未变⇒0 新行；一次变更⇒1 新行；索引有行载荷缺失⇒修复行 sha 不变', async () => {
  const ex = await load('chats/exportChats.ts')
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-export-work-'))
  const indexPath = path.join(workDir, 'chats', 'index.jsonl')
  const linesOf = () => existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8').split('\n').filter((line) => line !== '')
    : []
  const gate = async (built, header) => {
    const index = await ex.readChatIndex(workDir)
    const decision = ex.shouldExportChat(
      built, ex.indexEntryOf(index, built.id), await ex.chatPayloadExists(workDir, built.id), header,
    )
    return decision
  }

  const first = sessionOf('s1', 'hello')
  first.source.header.agentPreset = 'chat'
  const built = ex.buildChatExport(first.info, first.source, { deviceId: 'pc-a', now: NOW })
  assert.deepEqual(await gate(built, first.source.header), { action: 'export', reason: 'new' })
  let w = await ex.writeChatExportPayloads(workDir, [built], new Map([[built.id, { action: 'export', reason: 'new' }]]))
  assert.equal(w.ok, true)
  assert.equal(linesOf().length, 1)
  const firstBytes = readFileSync(indexPath, 'utf8')

  for (let pass = 0; pass < 2; pass += 1) {
    assert.deepEqual(await gate(built, first.source.header), { action: 'skip', reason: 'unchanged' })
    w = await ex.writeChatExportPayloads(workDir, [], new Map())
    assert.deepEqual(w.paths, [])
  }
  assert.equal(linesOf().length, 1, '三轮之后索引新增行必须为 0')
  assert.equal(readFileSync(indexPath, 'utf8'), firstBytes, '未变时载荷与索引字节都不动')

  const changed = sessionOf('s1', 'hello world')
  changed.source.header.agentPreset = 'chat'
  const built2 = ex.buildChatExport(changed.info, changed.source, {
    deviceId: 'pc-a', now: new Date('2026-11-28T01:00:00Z'),
  })
  assert.notEqual(built2.meta.sha256, built.meta.sha256)
  assert.deepEqual(await gate(built2, changed.source.header), { action: 'export', reason: 'sha256-changed' })
  w = await ex.writeChatExportPayloads(workDir, [built2], new Map([[built2.id, { action: 'export', reason: 'sha256-changed' }]]))
  assert.equal(linesOf().length, 2)
  assert.equal(readFileSync(indexPath, 'utf8').startsWith(firstBytes), true, '旧字节是新字节的严格前缀')
  assert.equal(JSON.parse(linesOf()[1]).sha256, built2.meta.sha256)

  rmSync(path.join(workDir, 'chats', 's1', 'session.jsonl'))
  assert.deepEqual(await gate(built2, changed.source.header), { action: 'export', reason: 'payload-missing' })
  w = await ex.writeChatExportPayloads(workDir, [built2], new Map([[built2.id, { action: 'export', reason: 'payload-missing' }]]))
  assert.deepEqual(w.repairedIds, ['s1'])
  assert.equal(linesOf().length, 3)
  assert.equal(JSON.parse(linesOf()[2]).sha256, JSON.parse(linesOf()[1]).sha256, '修复行 sha256 不变')
  assert.equal(existsSync(path.join(workDir, 'chats', 's1', 'session.jsonl')), true)
  rmSync(workDir, { recursive: true, force: true })
})

test('CE-04b 选择层幂等：同一未变会话二次选择 = 0 导出 / skippedUnchanged=1', async () => {
  const idx = await load('chats/index.ts')
  const ex = await load('chats/exportChats.ts')
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-select-idempotent-'))
  const chatsDir = path.join(workDir, 'chats')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(chatsDir, { recursive: true })
  const indexPath = path.join(chatsDir, 'index.jsonl')
  writeFileSync(indexPath, '', 'utf8')

  const session = sessionOf('s1', 'hello')
  session.source.header.agentPreset = 'chat'
  const base = {
    local: [session.info], hiddenIds: new Set(), workDir, deviceId: 'pc-a',
    now: NOW, readEvents: async () => session.source,
  }

  const first = await idx.selectAutoExportCandidates({ ...base, index: await ex.readChatIndex(workDir) })
  assert.equal(first.exports.length, 1, '首轮确实导出一条，夹具不是空的')
  const written = await ex.writeChatExportPayloads(workDir, first.exports, first.decisions)
  assert.equal(written.ok, true)
  const firstBytes = readFileSync(indexPath, 'utf8')
  assert.equal(firstBytes.split('\n').filter((line) => line !== '').length, 1)

  // 关键：第二次读到的是真实磁盘上刚写出的 index.jsonl，会话内容一字未变。
  const second = await idx.selectAutoExportCandidates({ ...base, index: await ex.readChatIndex(workDir) })
  assert.equal(second.exports.length, 0,
    '若保留 shouldExportChat 调用却删掉 action 为 skip 的分支，这里会变成 1（每轮重复追加索引行 + 重新提交）')
  assert.equal(second.skippedUnchanged, 1)
  assert.equal(second.decisions.size, 0, 'skip 的决定不能进 decisions 再交给写盘器')
  const again = await ex.writeChatExportPayloads(workDir, second.exports, second.decisions)
  assert.deepEqual(again.paths, [])
  assert.equal(readFileSync(indexPath, 'utf8'), firstBytes, '第二周期索引字节必须不变')

  rmSync(workDir, { recursive: true, force: true })
})

/* --------------------------------------------------------------- §3/§5 有界性 */

test('CE-05 888 个 work 会话⇒今天导出 0 个；时间上限在会话边界停下', async () => {
  const idx = await load('chats/index.ts')
  const ex = await load('chats/exportChats.ts')
  const emptyWorkDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-export-empty-'))
  const emptyIndex = await ex.readChatIndex(emptyWorkDir)
  // 规范会话数 888（不是 2,225：后者把嵌套/非规范 *.zstd 也数进去了），且全是 work。
  const local = Array.from({ length: 888 }, (_unused, i) => ({
    sessionId: `s${i}`, slug: 'p', file: `fake://${i}`, bytes: 10, mtime: 888 - i,
  }))
  const { source } = sessionOf('s0', 'hello')
  const base = {
    local, hiddenIds: new Set(), index: emptyIndex, workDir: emptyWorkDir,
    deviceId: 'pc-a', now: NOW, readEvents: async () => source,
  }
  const full = await idx.selectAutoExportCandidates(base)
  assert.equal(full.exports.length, 0, '888 个 work 会话一个都不导出（今天实际发布数 = 0）')
  assert.equal(full.skippedWork, 888)
  assert.equal(full.eligible, 0)
  assert.equal(full.remaining, 0)
  assert.equal(full.timedOut, false)

  const times = [0, 1, 25000]
  let cursor = 0
  const capped = await idx.selectAutoExportCandidates({
    ...base, nowMs: () => times[Math.min(cursor++, times.length - 1)],
  })
  assert.equal(capped.timedOut, true)
  assert.equal(capped.considered, 1, '触顶时停在会话边界')
  assert.equal(capped.exports.length, 0)
  assert.equal(idx.CHAT_EXPORT_PER_RUN_CAP, 50)
  assert.equal(idx.AUTO_EXPORT_PHASE_TIMEOUT_MS, 20000)
  assert.ok(idx.AUTO_EXPORT_PHASE_TIMEOUT_MS < 120000)
  rmSync(emptyWorkDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------- §4 诚实告知文案 */

const HONEST_ZH = '会话正文会像日程一样自动同步到云端仓库，以明文 JSONL 保存并进入 Git 历史，无法抹除。'
const HONEST_EN = 'Conversation content is automatically synced to the cloud repository just like schedule entries, stored as plaintext JSONL, and committed to Git history; it cannot be erased.'
const SCOPE_ZH = '平板/云端显示的是你在 chat / dots 模式下创建的会话；本机已有的 888 个会话都是 work 模式，因此不会被同步，平板的会话列表在你新建 chat / dots 会话之前本来就是空的。'

test('CE-06 面板与 locale 的诚实声明逐字一致；无 URL / 令牌 / 问号', () => {
  const zh = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(path.join(pkgDir, 'locale', 'en.json'), 'utf8'))
  const client = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  const exportSrc = readFileSync(path.join(srcDir, 'chats', 'exportChats.ts'), 'utf8')
  assert.equal(zh['lean.chatExport.honesty'], HONEST_ZH)
  assert.equal(en['lean.chatExport.honesty'], HONEST_EN)
  assert.equal(zh['lean.chatExport.scope'], SCOPE_ZH, '范围声明逐字一致（888 / work / 不会同步 / 本来就是空的）')
  assert.equal(Object.keys(zh).length, Object.keys(en).length, 'zh/en 键集合必须一致')
  assert.match(client, /data-lean': 'chat-export-honesty'/)
  assert.match(client, /tr\('lean\.chatExport\.honesty'\)/)
  assert.match(client, /data-lean': 'chat-export-scope'/)
  assert.match(client, /tr\('lean\.chatExport\.scope'\)/)
  for (const stale of ['导出最近的会话', '平板显示你的全部对话']) {
    assert.equal(zh['lean.chatExport.scope'].includes(stale), false, stale)
    assert.equal(client.includes(stale), false, stale)
  }
  assert.match(exportSrc, /会话正文会像日程一样自动同步到云端仓库，以明文 JSONL 保存并进入 Git 历史，无法抹除。/)
  for (const sentence of [HONEST_ZH, HONEST_EN]) {
    assert.equal(sentence.includes('?'), false)
    assert.equal(/https?:\/\//.test(sentence), false)
  }
  // 用户可见文案里不许再出现「导出」/export：静默自动同步，没有导出按钮、没有导出概念。
  for (const [lang, dict] of [['zh', zh], ['en', en]]) {
    for (const key of ['lean.chatExport.honesty', 'lean.chatExport.scope', 'lean.chatExport.paused',
      'lean.chatExport.partial', 'lean.chatExport.skipped']) {
      const value = dict[key]
      assert.equal(/导出|export/i.test(value), false, `${lang}.${key} 不得出现导出/export`)
    }
  }
  // 面板里不许有可点的「导出/立即同步」动作（状态行是只读的，不是按钮）。
  for (const actionString of ['导出全部', '导出会话', '立即同步', 'sync now', 'Export all', 'Export now']) {
    assert.equal(client.includes(actionString), false, actionString)
  }
  // 声明不是对话框：没有按钮、没有确认回调。
  assert.equal(/chat-export-honesty[\s\S]{0,160}onClick/.test(client), false)
})

test('CE-07 schema 门拒绝时零写入；四类失败文案都不冒充成功', async () => {
  const ex = await load('chats/exportChats.ts')
  const cycle = await load('sync/cycle.ts')
  const five = { id: 's1', title: 't', updatedAt: 'x', messageCount: 1, sha256: 'h' }
  assert.equal(ex.isValidChatIndexLine(JSON.stringify(five)), true)
  assert.equal(ex.isValidChatIndexLine(JSON.stringify({ op: 'archive', id: 's1', deletedAt: 1 })), true)
  assert.equal(ex.isValidChatIndexLine(JSON.stringify({ id: 's1' })), false)
  assert.equal(ex.isValidChatIndexLine('{bad'), false)

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-export-schema-'))
  const chatsDir = path.join(workDir, 'chats')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(chatsDir, { recursive: true })
  writeFileSync(path.join(chatsDir, 'index.jsonl'), '{"id":"s1"}\n', 'utf8')
  const { info, source } = sessionOf('s1', 'hello')
  const built = ex.buildChatExport(info, source, { deviceId: 'pc-a', now: NOW })
  const result = await ex.writeChatExportPayloads(workDir, [built], new Map())
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'index-schema-rejected')
  assert.deepEqual(result.paths, [])
  assert.equal(existsSync(path.join(chatsDir, 's1')), false, '拒绝时零载荷写入、零索引半行')
  rmSync(workDir, { recursive: true, force: true })

  for (const line of [
    cycle.CHAT_EXPORT_PUSH_FAILED_LINE,
    cycle.CHAT_EXPORT_REPO_MISSING_LINE,
    cycle.CHAT_EXPORT_SCHEMA_REJECTED_LINE,
  ]) {
    assert.equal(line.includes('已同步'), false)
  }
  assert.match(cycle.CHAT_EXPORT_PUSH_FAILED_LINE, /自动发布暂停/)
  assert.equal(cycle.chatExportTruncatedLine(3), '本轮跳过 3 个不完整会话')

  // CE-07 wiring proof：四条常量必须在 cycle.ts 的**生产分支**里被调用，不能只有定义 + 测试引用。
  const cycleSrc = readFileSync(path.join(srcDir, 'sync', 'cycle.ts'), 'utf8')
  for (const name of [
    'CHAT_EXPORT_PUSH_FAILED_LINE', 'CHAT_EXPORT_REPO_MISSING_LINE',
    'CHAT_EXPORT_SCHEMA_REJECTED_LINE', 'chatExportTruncatedLine',
  ]) {
    const hits = cycleSrc.split(name).length - 1
    assert.ok(hits >= 2, `${name} 必须除定义外至少还有一处生产引用（实际命中 ${hits}）`)
  }
})

test('CE-08 选择白名单：chat + dots 都放行；50 只是安全上限不是窗口', async () => {
  const idx = await load('chats/index.ts')
  const ex = await load('chats/exportChats.ts')
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-export-allow-'))
  const index = await ex.readChatIndex(workDir)
  const select = (session) => idx.selectAutoExportCandidates({
    local: [session.info], hiddenIds: new Set(), index, workDir, deviceId: 'pc-a',
    now: NOW, readEvents: async () => session.source,
  })

  // 唯一谓词 + 单一冻结 allow-list：只有 'chat' / 'dots' 通过，其余全部 fail-closed 为 work。
  assert.equal(ex.isPublishablePresetHeader({ type: 'session', agentPreset: 'chat' }), true)
  assert.equal(ex.isPublishablePresetHeader({ type: 'session', agentPreset: 'dots' }), true)
  assert.equal(Object.isFrozen(ex.PUBLISHABLE_PRESET_IDS), true)
  assert.deepEqual([...ex.PUBLISHABLE_PRESET_IDS].sort(), ['chat', 'dots'])
  // 逐类拒绝：standard / 未知 / null / undefined / 空串 / 数字 / 对象 / 数组 / 大小写 / 前后空格。
  const rejections = [
    ['standard', 'standard'],
    ['ptc', 'ptc'],
    ['minimal', 'minimal'],
    ['unknown', 'unknown-id'],
    ['null', null],
    ['undefined', undefined],
    ['empty-string', ''],
    ['number', 42],
    ['zero', 0],
    ['object', { id: 'chat' }],
    ['array', ['chat']],
    ['case-mismatch', 'Chat'],
    ['whitespace', ' chat'],
  ]
  for (const [name, preset] of rejections) {
    const header = { type: 'session' }
    if (preset !== undefined) header.agentPreset = preset
    assert.equal(ex.isPublishablePresetHeader(header), false, name)
  }
  assert.equal(ex.isPublishablePresetHeader(null), false)
  assert.equal(ex.isPublishablePresetHeader(undefined), false)

  const chat = sessionOf('c1', 'hi') // 有一条 user 轮次
  chat.source.header.agentPreset = 'chat'
  const chatResult = await select(chat)
  assert.equal(chatResult.exports.length, 1)
  assert.equal(chatResult.eligible, 1)
  assert.equal(chatResult.skippedWork, 0)
  const dots = sessionOf('d1', 'hi') // dots 入口：对话 + 调整日程 / 定时任务 / 远程控制
  dots.source.header.agentPreset = 'dots'
  const dotsResult = await select(dots)
  assert.equal(dotsResult.exports.length, 1, 'dots 与 chat 同等待遇')
  assert.equal(dotsResult.eligible, 1)
  assert.equal(dotsResult.skippedWork, 0)
  const work = sessionOf('w1', 'hi') // 缺省 standard
  const workResult = await select(work)
  assert.equal(workResult.exports.length, 0)
  assert.equal(workResult.skippedWork, 1)
  assert.equal(workResult.eligible, 0)
  const empty = sessionOf('e1', '')
  empty.source.header.agentPreset = 'chat'
  empty.source.events = []
  empty.source.rawJsonl = `${JSON.stringify(empty.source.header)}\n`
  const emptyResult = await select(empty)
  assert.equal(emptyResult.exports.length, 1, '零轮 chat 也要发布')
  assert.equal(emptyResult.eligible, 1)
  assert.equal(emptyResult.skippedWork, 0)

  // 60 个 chat 会话 + 调用方传 limit=9999 ⇒ 仍只发布 50，rest 计数准确。
  const many = Array.from({ length: 60 }, (_unused, i) => {
    const item = sessionOf(`c${i}`, 'hi')
    item.source.header.agentPreset = 'chat'
    return item
  })
  const byFile = new Map(many.map((item) => [item.info.file, item.source]))
  const capped = await idx.selectAutoExportCandidates({
    local: many.map((item) => item.info), hiddenIds: new Set(), index, workDir,
    deviceId: 'pc-a', now: NOW, readEvents: async (file) => byFile.get(file), limit: 9999,
  })
  assert.equal(capped.exports.length, 50)
  assert.equal(capped.considered, 50, '安全上限处停下，后 10 个连读都没读，remaining 不编造数字')
  assert.equal(capped.remaining, 0)
  assert.equal(capped.timedOut, false)
  rmSync(workDir, { recursive: true, force: true })
})

/* ------------------------------------------------- §三种会话形态：两个调用点同一谓词 */

test('CE-09 chat / dots 经选择与变更门控两处都能发布；standard(work) 两处都拒', async () => {
  const idx = await load('chats/index.ts')
  const ex = await load('chats/exportChats.ts')
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-kinds-'))
  const index = await ex.readChatIndex(workDir)
  for (const preset of ['chat', 'dots']) {
    const session = sessionOf(`${preset}-1`, 'hi')
    session.source.header.agentPreset = preset
    const built = ex.buildChatExport(session.info, session.source, { deviceId: 'pc-a', now: NOW })
    // 变更门控这个调用点：两个 id 都放行，原因都是 new。
    assert.deepEqual(
      ex.shouldExportChat(built, undefined, false, session.source.header),
      { action: 'export', reason: 'new' }, preset,
    )
    // 选择那个调用点：都计入 eligible / exports，且没有任何一个被算作 work。
    const selected = await idx.selectAutoExportCandidates({
      local: [session.info], hiddenIds: new Set(), index, workDir, deviceId: 'pc-a',
      now: NOW, readEvents: async () => session.source,
    })
    assert.equal(selected.exports.length, 1, preset)
    assert.equal(selected.eligible, 1, preset)
    assert.equal(selected.skippedWork, 0, preset)
  }
  const work = sessionOf('work-1', 'hi') // DSH 自己 UI 的 standard 会话
  const builtWork = ex.buildChatExport(work.info, work.source, { deviceId: 'pc-a', now: NOW })
  assert.deepEqual(
    ex.shouldExportChat(builtWork, undefined, false, work.source.header),
    { action: 'skip', reason: 'work-session' },
  )
  const skipped = await idx.selectAutoExportCandidates({
    local: [work.info], hiddenIds: new Set(), index, workDir, deviceId: 'pc-a',
    now: NOW, readEvents: async () => work.source,
  })
  assert.equal(skipped.exports.length, 0)
  assert.equal(skipped.skippedWork, 1)
  assert.equal(skipped.eligible, 0)
  rmSync(workDir, { recursive: true, force: true })
})

/* ------------------------------- P2-3/P2-4：非对象 header 全函数 + 真不可变白名单 */

test('CE-08b header 本身非对象一律 false 不抛；白名单冻结数组无从 add', async () => {
  const ex = await load('chats/exportChats.ts')
  const fnHeader = function chatHeader() { return { agentPreset: 'chat' } }
  for (const [name, header] of [
    ['string-chat', 'chat'],
    ['number-42', 42],
    ['array-chat', ['chat']],
    ['function', fnHeader],
  ]) {
    let verdict
    assert.doesNotThrow(() => { verdict = ex.isPublishablePresetHeader(header) }, name)
    assert.equal(verdict, false, name)
  }

  // P2-4：Object.freeze(new Set(...)) 的 isFrozen 为真但 set.add('standard') 仍生效。
  // 现在必须是真数组 + 冻结：没有 add，push 被拒，成员关系逐字节固定。
  assert.equal(Array.isArray(ex.PUBLISHABLE_PRESET_IDS), true)
  assert.equal(ex.PUBLISHABLE_PRESET_IDS instanceof Set, false)
  assert.equal(Object.isFrozen(ex.PUBLISHABLE_PRESET_IDS), true)
  assert.equal(typeof ex.PUBLISHABLE_PRESET_IDS.add, 'undefined', '不得残留 Set API 供调用方绕过')
  try { ex.PUBLISHABLE_PRESET_IDS.push('standard') } catch { /* 严格模式预期 TypeError */ }
  assert.deepEqual([...ex.PUBLISHABLE_PRESET_IDS].sort(), ['chat', 'dots'], 'CE-08 的内容锚点仍须成立')
  assert.equal(ex.PUBLISHABLE_PRESET_IDS.includes('standard'), false)
})

/* ------------------------------------- 独立评审 F3：零写入超时也必须披露超时 */

test('CE-10 零写入且触顶时不能只说「无变更」，必须披露本轮超时', async () => {
  const cycle = await load('sync/cycle.ts')
  const view = (over) => ({
    exported: 0, remaining: 0, truncated: 0, timedOut: false, wrote: false, ...over,
  })

  const timedOutWithZeroWrites = cycle.chatExportSuccessLineOf(view({ exported: 0, remaining: 3, timedOut: true }))
  assert.match(timedOutWithZeroWrites, /本轮无变更，未提交未推送/, '零写入的事实不能丢')
  assert.match(timedOutWithZeroWrites, /本轮超时/, 'F3：超时不能再被 wrote===false 吞掉')
  assert.equal(timedOutWithZeroWrites,
    '本轮无变更，未提交未推送（自动发布 0 个）；本轮超时，剩余 3 个下次同步继续',
    '新增的超时披露逐字钉住，复用既有超时子句')
  assert.equal(cycle.chatExportSuccessLineOf(view({ timedOut: true })),
    '本轮无变更，未提交未推送（自动发布 0 个）；本轮超时，未处理的会话下次同步继续',
    '剩余数为 0 时不编造数量，仍是既有超时子句')
  assert.equal(timedOutWithZeroWrites.includes('已同步'), false)

  // 既有真值路径逐字不变：非零写入的超时仍走部分发布原文案。
  assert.equal(cycle.chatExportSuccessLineOf(view({ exported: 3, remaining: 4, timedOut: true, wrote: true })),
    cycle.chatExportPartialMessage(3, 4))
  assert.equal(cycle.chatExportSuccessLineOf(view()), '本轮无变更，未提交未推送（自动发布 0 个）')
})
