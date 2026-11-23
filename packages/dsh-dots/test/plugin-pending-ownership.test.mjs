/**
 * `mod-plugin-local-pending-cause`：E_LOCAL_PENDING 的**真实 git** 归因证据。
 *
 * 与 plugin-v2-cycle.test.mjs 的 C19–C28 / PI-01..PI-04 不重复：
 * 那些用例用 FakeGit 钉住布尔归属与恢复语义；本文件只在 os.tmpdir() 里的
 * 真实 git 仓库（git init --bare + clone）上跑，证明 shipped 分类在真实提交字节上
 * 依然正确，并钉住终态消息里新增的「逐条归属 + 最近 typed 推拒原因」。
 *
 * 硬约束：不放宽 isOursCommit / classifyIntentLanding / proveRecoveryState /
 * 路径收容 / push 闸；负例仍必须被拒绝，本文只让原因可见。
 * 被测对象：dist/sync/cycle.js + dist/sync/gitPort.js（前置：node scripts/build.mjs）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  DEFAULT_V2_INSTANCE_ID,
  MAX_CYCLE_RETRIES,
  V2_ERROR,
  describePendingOwnership,
  isConfinedTimelinePath,
  isOursCommit,
  makeIntentId,
  runV2Cycle,
  v2TrailerLine,
} from '../dist/sync/cycle.js'
import { SyncError } from '../dist/engine/errors.js'
import { GitRepoV2Port, pushTimeoutReason } from '../dist/sync/gitPort.js'
import { NodeTimelineFs } from '../dist/timeline/write.js'
import { NodeOutboxPort } from '../dist/sync/outbox.js'
import { FRESH_SCHEMA_TEXT, buildRecordsText, canonicalRecordLine } from '../dist/timeline/index.js'

const DAY = '2026-11-19'
const TS = `${DAY}T01:30:00.000Z`
const TRAILER = v2TrailerLine()
const REL_RECORDS = `timeline/${DAY}/records.json`
const REL_SUMMARY = `timeline/${DAY}/summary.json`
const REL_CHATS = 'chats/x.json'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 真实仓库夹具：裸远端 + 一份已推过 main 的工作副本；不碰项目仓库、不碰 live state。 */
async function makeRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-pending-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const bare = path.join(root, 'remote.git')
  const work = path.join(root, 'git-repo')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], { stdio: 'ignore' })
  execFileSync('git', ['clone', '--quiet', bare, work], { stdio: 'ignore' })
  git(work, ['config', 'user.email', 'pending@localhost'])
  git(work, ['config', 'user.name', 'pending-test'])
  await writeFile(path.join(work, 'README.md'), 'init\n')
  git(work, ['add', 'README.md'])
  git(work, ['commit', '--quiet', '-m', 'init'])
  git(work, ['push', '--quiet', 'origin', 'main'])
  git(work, ['fetch', '--quiet', 'origin'])
  return { root, bare, work }
}

/** 用真实 git 提交一个指定形状；body 用第二个 -m 写，模仿插件的 commit() 路径。 */
async function commitShape(work, files, subject, body = '') {
  for (const [rel, text] of files) {
    const full = path.join(work, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, `${text}\n`)
  }
  git(work, ['add', '-A'])
  if (body !== '') git(work, ['commit', '--quiet', '-m', subject, '-m', body])
  else git(work, ['commit', '--quiet', '-m', subject])
}

/** 真实端口：aheadCommits / aheadBehind 全部来自 git log / show / diff-tree。 */
function portOf(s) {
  return new GitRepoV2Port({
    dir: s.work, repoUrl: s.bare, branch: 'main',
    authMode: 'https', allowLocalRepo: true, token: null,
  })
}

async function withPort(s, fn) {
  const port = portOf(s)
  try { return await fn(port) } finally { await port.dispose() }
}

function rec(overrides = {}) {
  return {
    id: 'a1', ts: TS, title: 't', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: TS, ...overrides,
  }
}

// ---------------------------------------------------------------- 终态原因白名单的最小注入面
// 分类仍由真实 git 用例（PO-01..PO-06）证明；这里只让 pushMain 抛出任意** hostile 文本**，
// 经 runV2Cycle 的公开可观察返回值检验白名单闸门，不为测试新增生产 API。

class MemFs {
  constructor(seed = {}) { this.files = new Map(Object.entries(seed)) }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) { const t = `${rel}.tmp`; this.files.set(t, text); return t }
  async readTemp(t) { return this.files.get(t) ?? '' }
  async rename(t, rel) { this.files.set(rel, this.files.get(t)); this.files.delete(t) }
  async backupIfExists() { return false }
  async append(rel, text) { this.files.set(rel, (this.files.get(rel) ?? '') + text) }
  async exists(rel) { return this.files.has(rel) }
}

class MemOutbox {
  constructor(entries = []) { this.entries = entries.slice() }
  async load() { return this.entries.slice() }
  async save(entries) { this.entries = entries.slice() }
}

/** 一条本模块领先提交 + 已落地的停放意图；pushMain 抛 typed 错，触发有界恢复终态。 */
function recoveryMessagePort(pushErrorText) {
  const recordsText = buildRecordsText(DAY, [rec()])
  return {
    async branchName() { return 'main' },
    async fetchMain() {},
    async headSha() { return 'local-head' },
    async originMainSha() { return 'remote-head' },
    async showRemote() { return '' },
    async showHead(rel) { return rel === REL_RECORDS ? recordsText : '' },
    async addPaths() {},
    async commit() {},
    async pushMain() { throw new SyncError('E_PUSH_REJECTED', pushErrorText) },
    async aheadBehind() { return { ahead: 1, behind: 0 } },
    async aheadCommits() {
      return [{ subject: '[v2] sync 1 days', body: TRAILER, paths: [REL_RECORDS] }]
    },
  }
}

async function hostileReasonResult(pushErrorText) {
  const outbox = new MemOutbox([{
    intentId: makeIntentId(DAY, 'a1', TS, 'upsert'),
    op: 'upsert', date: DAY, id: 'a1', ts: TS,
    line: canonicalRecordLine(rec()), enqueuedAt: TS,
    attempts: 0, state: 'pending', lastError: '',
  }])
  const fs = new MemFs({
    'timeline/schema.json': FRESH_SCHEMA_TEXT,
    [REL_RECORDS]: buildRecordsText(DAY, [rec()]),
  })
  return await runV2Cycle({
    days: [DAY], git: recoveryMessagePort(pushErrorText), fs, outbox, now: new Date(TS),
  })
}

// 两侧短语漂移守卫：从源码逐字抽出五个「推送失败：…」短语，不靠人工维护清单。
// 其中超时短语是模板（唯一变量 = 当次预算数字），单独从 gitPort.ts 的导出常量取出。
function quotedPushPhrases(block) {
  const out = []
  const re = /'([^'\r\n]*)'/g
  let match
  while ((match = re.exec(block)) !== null) {
    if (match[1].startsWith('推送失败：')) out.push(match[1])
  }
  return out
}

function shippedPushReasons() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.resolve(here, '../src/sync/gitPort.ts'), 'utf8')
  const start = src.indexOf('const message = {')
  const end = src.indexOf('}[reason]', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const phrases = quotedPushPhrases(src.slice(start, end))
  // 超时短语由模板 + 实际预算生成：模板必须能被源码逐字取出，否则本守卫失效。
  const template = /export const PUSH_TIMEOUT_REASON_TEMPLATE = '([^']+)'/.exec(src)
  assert.notEqual(template, null, 'gitPort.ts 必须导出 PUSH_TIMEOUT_REASON_TEMPLATE')
  assert.equal(template[1].includes('>N 毫秒'), true, '超时模板的唯一变量必须是 >N 毫秒')
  phrases.push(template[1])
  return phrases.sort()
}

function cycleAllowedReasons() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.resolve(here, '../src/sync/cycle.ts'), 'utf8')
  const start = src.indexOf('const ALLOWED_PUSH_REASONS')
  const end = src.indexOf('])', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return quotedPushPhrases(src.slice(start, end + 2)).sort()
}

// ================================================================ PO-01..PO-05：真实提交上的分类

test('PO-01 plugin-shaped 真实提交：describePendingOwnership().ours=true，纯谓词 isOursCommit 同意', async (t) => {
  const s = await makeRepo(t)
  await commitShape(s.work, [[REL_RECORDS, '{"records":[]}']], '[v2] sync 1 days', TRAILER)
  await withPort(s, async (port) => {
    const ab = await port.aheadBehind()
    assert.equal(ab.ahead, 1)
    assert.equal(ab.behind, 0)
    const commits = await port.aheadCommits()
    assert.equal(commits.length, 1)
    assert.deepEqual(commits[0].paths, [REL_RECORDS])
    assert.equal(commits[0].body.includes(TRAILER), true)
    const d = describePendingOwnership(commits)
    assert.equal(d.ours, true)
    assert.equal(d.verdicts[0].verdict, 'ours')
    assert.equal(d.verdicts[0].trailer, true)
    assert.equal(d.verdicts[0].subjectShape, 'v2')
    assert.equal(d.verdicts[0].outsideScopePaths, 0)
    assert.equal(isOursCommit(commits[0]), true) // 同一份真实数据上两口径一致
    assert.equal(isConfinedTimelinePath(REL_RECORDS), true)
    assert.match(d.summary, /第 1 条 本模块/)
  })
})

test('PO-02 App 风格（同 subject、无尾注）：非本模块，原因含「尾注缺失」', async (t) => {
  const s = await makeRepo(t)
  await commitShape(s.work, [[REL_RECORDS, '{"records":[]}']], '[v2] sync 1 days', '')
  await withPort(s, async (port) => {
    const commits = await port.aheadCommits()
    assert.equal(commits[0].body, '')
    const d = describePendingOwnership(commits)
    assert.equal(d.ours, false)
    assert.equal(d.verdicts[0].verdict, 'foreign')
    assert.equal(d.verdicts[0].trailer, false)
    assert.equal(d.verdicts[0].reason.includes('尾注缺失'), true)
    assert.equal(isOursCommit(commits[0]), false)
    assert.equal(d.summary.includes('[v2] sync 1 days'), false) // 不带出提交正文
  })
})

test('PO-03 有尾注但触及 chats/x.json：untrusted，原因含越界计数且不带出路径', async (t) => {
  const s = await makeRepo(t)
  await commitShape(s.work, [[REL_RECORDS, '{"records":[]}'], [REL_CHATS, '{}']], '[v2] sync 1 days', TRAILER)
  await withPort(s, async (port) => {
    const commits = await port.aheadCommits()
    assert.equal(commits[0].paths.includes(REL_CHATS), true) // 真实 diff 确实越界
    const d = describePendingOwnership(commits)
    assert.equal(d.ours, false)
    assert.equal(d.verdicts[0].verdict, 'untrusted')
    assert.equal(d.verdicts[0].trailer, true)
    assert.equal(d.verdicts[0].outsideScopePaths, 1)
    assert.equal(d.verdicts[0].reason.includes('diff 越界 1 条'), true)
    assert.equal(isOursCommit(commits[0]), false)
    assert.equal(d.summary.includes(REL_CHATS), false)
    assert.equal(d.summary.includes('chats'), false)
  })
})

test('PO-04 尾注实例标识不符：非本模块，原因点名实例不符但不带出尾注原文', async (t) => {
  const s = await makeRepo(t)
  await commitShape(s.work, [[REL_RECORDS, '{"records":[]}']], '[v2] sync 1 days', 'dsh-dots-v2: other-device')
  await withPort(s, async (port) => {
    const commits = await port.aheadCommits()
    const d = describePendingOwnership(commits, DEFAULT_V2_INSTANCE_ID)
    assert.equal(d.ours, false)
    assert.equal(d.verdicts[0].verdict, 'foreign')
    assert.equal(d.verdicts[0].reason.includes('尾注实例标识不符'), true)
    assert.equal(isOursCommit(commits[0]), false)
    assert.equal(d.summary.includes('other-device'), false)
  })
})

test('PO-05 live 形状假设：两条真实领先提交（先 ours、后无尾注）→ ours=false，两条各有不同结论', async (t) => {
  const s = await makeRepo(t)
  await commitShape(s.work, [[REL_RECORDS, '{"records":[]}']], '[v2] sync 1 days', TRAILER)
  await commitShape(s.work, [[REL_SUMMARY, '{}']], '[v2] sync 1 days', '')
  await withPort(s, async (port) => {
    const ab = await port.aheadBehind()
    assert.equal(ab.ahead, 2)
    assert.equal(ab.behind, 0)
    // aheadCommits() 是 git log 顺序（新→旧）；按运维可读的创建顺序反转后再编号。
    const commits = (await port.aheadCommits()).slice().reverse()
    const d = describePendingOwnership(commits)
    assert.equal(d.ours, false)
    assert.equal(d.verdicts.length, 2)
    assert.equal(d.verdicts[0].verdict, 'ours')
    assert.equal(d.verdicts[1].verdict, 'foreign')
    assert.equal(d.verdicts[1].reason.includes('尾注缺失'), true)
    assert.equal(isOursCommit(commits[0]), true)
    assert.equal(isOursCommit(commits[1]), false)
    assert.match(d.summary, /第 1 条 本模块/)
    assert.match(d.summary, /第 2 条 非本模块/)
    assert.equal(d.summary.includes('第 1 条 非本模块'), false)
  })
})

// ================================================================ PO-06：真实代码路径的终态消息

test('PO-06 真实 GitRepoV2Port + 被 hook 拒收的裸远端 + 停放意图 → 可归因的 E_LOCAL_PENDING', async (t) => {
  const s = await makeRepo(t)
  // 一条本模块提交：schema 标记 + 规范 records 字节 + body 尾注，全部收容在 timeline/**。
  const record = rec()
  const recordsText = buildRecordsText(DAY, [record])
  assert.notEqual(recordsText, '')
  await commitShape(s.work, [
    ['timeline/schema.json', FRESH_SCHEMA_TEXT.trimEnd()],
    [REL_RECORDS, recordsText.trimEnd()],
  ], '[v2] sync 1 days', TRAILER)

  // 远端 pre-receive 恒拒，模拟「远端推进 / 权限拒绝」这类真实推拒；remote 自身不动，behind 仍为 0。
  await mkdir(path.join(s.bare, 'hooks'), { recursive: true })
  await writeFile(path.join(s.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho rejected-by-hook >&2\nexit 1\n')

  // 仓库外意图（显式 filePath，绝不碰 live ~/.dsh/dots）。
  const outboxPath = path.join(s.root, 'state', 'outbox.json')
  await mkdir(path.dirname(outboxPath), { recursive: true })
  const outbox = new NodeOutboxPort({ filePath: outboxPath })
  const intent = {
    intentId: makeIntentId(DAY, record.id, record.ts, 'upsert'),
    op: 'upsert', date: DAY, id: record.id, ts: record.ts,
    line: canonicalRecordLine(record), enqueuedAt: TS,
    attempts: 0, state: 'pending', lastError: '',
  }
  await outbox.save([intent])

  let result
  await withPort(s, async (port) => {
    const before = await port.headSha()
    result = await runV2Cycle({
      days: [DAY], git: port, fs: new NodeTimelineFs(s.work), outbox, now: new Date(TS),
    })
    assert.equal(await port.headSha(), before) // 失败路径零新提交
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.LOCAL_PENDING)
  assert.equal(result.applied, 0)
  assert.equal(result.pending, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.attempts, MAX_CYCLE_RETRIES)
  const msg = result.message
  // 既有文案仍在，operator 指令不丢。
  assert.equal(msg.includes('下一步'), true)
  assert.equal(msg.includes('手工协调'), true)
  assert.equal(msg.includes(`已重试 ${MAX_CYCLE_RETRIES} 次`), true)
  // 新增的三段归因：逐条归属 / 越界计数口径 / 最近 typed 推拒原因。
  assert.match(msg, /领先提交 1 条：第 1 条 本模块/)
  assert.equal(msg.includes('最近一次推送失败：E_PUSH_REJECTED'), true)
  assert.equal(msg.includes('推送失败：远端分支已前进'), true) // 来自 pushFailure() 白名单
  // 凭据/路径形态守卫：单行、无 ~、无 /、无 token/Bearer、无 64-hex、无绝对路径。
  assert.equal(msg.includes('\n'), false)
  assert.equal(msg.includes('\r'), false)
  assert.equal(msg.includes('~'), false)
  assert.equal(msg.includes('/'), false)
  assert.equal(/token/i.test(msg), false)
  assert.equal(/bearer/i.test(msg), false)
  assert.equal(/[0-9a-fA-F]{64}/.test(msg), false)
  assert.equal(msg.includes(s.work), false)
  assert.equal(msg.includes(s.bare), false)
  assert.equal(msg.includes(REL_RECORDS), false)
  // 停放语义不变：意图仍在，预算累计到重试次数，未出队。
  const parked = (await outbox.load())[0]
  assert.equal(parked.attempts, MAX_CYCLE_RETRIES)
  assert.equal(parked.state, 'pending')
})

// ================================================================ PO-07：不放宽守卫

test('PO-07 no-loosening：负例仍全被拒 + 新导出形状与终态归属行（改前必 fail）', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const cycleSrc = readFileSync(path.resolve(here, '../src/sync/cycle.ts'), 'utf8')
  // 严格收容谓词原样在位（不是被替换成 startsWith 之类的宽松判断）。
  assert.equal(cycleSrc.includes("parts[0] === 'timeline'"), true)
  assert.equal(cycleSrc.includes('commit.paths.every(isConfinedTimelinePath)'), true)
  assert.equal(cycleSrc.includes('force: false'), true)
  assert.equal(/force\s*:\s*true/.test(cycleSrc), false)

  const trailerOnly = { subject: '[v2] sync 1 days', body: TRAILER, paths: [REL_RECORDS] }
  const noTrailer = { subject: '[v2] sync 1 days', body: '', paths: [REL_RECORDS] }
  const outside = { subject: '[v2] sync 1 days', body: TRAILER, paths: [REL_RECORDS, REL_CHATS] }
  const otherInstance = { subject: '[v2] sync 1 days', body: 'dsh-dots-v2: other-device', paths: [REL_RECORDS] }
  const wrongSubject = { subject: 'manual fix', body: TRAILER, paths: [REL_RECORDS] }
  for (const [name, commit] of [
    ['no-trailer', noTrailer], ['outside', outside],
    ['other-instance', otherInstance], ['wrong-subject', wrongSubject],
  ]) {
    assert.equal(isOursCommit(commit), false, name)
    assert.equal(describePendingOwnership([commit]).ours, false, name)
  }
  assert.equal(isOursCommit(trailerOnly), true)
  assert.equal(describePendingOwnership([trailerOnly]).ours, true)
  // 越界计数只是计数，永不变成路径列表。
  const d = describePendingOwnership([outside])
  assert.equal(d.verdicts[0].outsideScopePaths, 1)
  assert.equal(Array.isArray(d.verdicts[0].outsideScopePaths), false)

  // 以下三条只对**改后**代码成立（改前 describePendingOwnership 不存在、终态无归属行）。
  assert.equal(typeof describePendingOwnership, 'function')
  const shape = describePendingOwnership([trailerOnly, noTrailer])
  assert.equal(shape.ours, false)
  assert.equal(shape.verdicts.length, 2)
  assert.deepEqual(Object.keys(shape.verdicts[0]).sort(),
    ['index', 'outsideScopePaths', 'reason', 'subjectShape', 'trailer', 'verdict'].sort())
  assert.equal(shape.verdicts[0].index, 1)
  assert.equal(shape.verdicts[1].index, 2)
  const terminal = await hostileReasonResult('推送失败：远端分支已前进，下一次同步会做有界重试')
  assert.equal(terminal.code, V2_ERROR.LOCAL_PENDING)
  assert.match(terminal.message, /领先提交 1 条：第 1 条 本模块/)
})

// ================================================================ PO-08/09：终态原因白名单闸门

test('PO-08 16 个 hostile 推送原因全部折叠为固定短语（含 r2 fuzz 的 5 个幸存者）', async () => {
  const cases = [
    ['UNC', '推送失败：\\\\host\\share\\f'],
    ['relative-up', '推送失败：..\\x'],
    ['relative-dot', '推送失败：.\\x'],
    ['drive', '推送失败：C:\\x'],
    ['posix', '推送失败：/tmp/x'],
    ['double-slash', '推送失败：//host/share'],
    ['hex64', '推送失败：' + 'a'.repeat(64)],
    ['token', '推送失败：token=abc'],
    ['bearer', '推送失败：Bearer x'],
    ['crlf', '推送失败：第一\r\n第二'],
    ['long-500', '推'.repeat(500)],
    // r2 fuzz 报告里穿过字符类白名单的五个 content-bearing 样本：
    ['base64url-token', '推送失败：ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'],
    ['fullwidth-slash-path', '推送失败：timeline／2026-11-19／records.json'],
    ['chinese-token-key', '推送失败：令牌 abc123'],
    ['fifteen-hex', '推送失败：0123456789abcde'],
    ['fullwidth-colon-drive', '推送失败：C：Users'],
  ]
  const marker = '最近一次推送失败：'
  const generic = 'E_PUSH_REJECTED：推送失败（原因类别未识别）'
  for (const [name, text] of cases) {
    const result = await hostileReasonResult(text)
    assert.equal(result.code, V2_ERROR.LOCAL_PENDING, name)
    const msg = result.message
    const at = msg.indexOf(marker)
    assert.notEqual(at, -1, name)
    const reason = msg.slice(at + marker.length, -1) // 去掉末尾的 ）
    // 终态消息整体形态：单行、有界、无路径分隔符/父目录/盘符/64-hex。
    assert.equal(msg.includes('\n'), false, name)
    assert.equal(msg.includes('\r'), false, name)
    assert.equal(/[/\\]/.test(msg), false, name)
    assert.equal(msg.includes('..'), false, name)
    assert.equal(msg.includes('C:'), false, name)
    assert.equal(/[0-9a-fA-F]{64}/.test(msg), false, name)
    assert.equal(/token|bearer/i.test(msg), false, name)
    assert.equal(reason.length <= 96 + 'E_PUSH_REJECTED：'.length, true, name)
    // 精确短语闸门：所有可疑样本（含超长串）一律整段换成固定短语。
    assert.equal(reason, generic, name)
  }
})

test('PO-09 五个 shipped 短语逐字节存活（防止过度打码）', async () => {
  const reasons = shippedPushReasons()
  // 4 个固定短语 + 1 个超时模板（mod-plugin-git-timeout-classification：超时与不可达分开）。
  assert.equal(reasons.length, 5)
  for (const shipped of reasons) {
    const result = await hostileReasonResult(shipped)
    assert.equal(result.code, V2_ERROR.LOCAL_PENDING, shipped)
    assert.equal(
      result.message.includes(`最近一次推送失败：E_PUSH_REJECTED：${shipped}）`),
      true, shipped,
    )
  }
})

test('PO-11 超时短语带真实预算数字也能穿过白名单；把数字换成文字仍被折叠', async () => {
  // mod-plugin-git-timeout-classification：超时与不可达是两种结局，数字来自当次预算。
  const shipped = pushTimeoutReason(20_000)
  assert.equal(shipped.includes('>20000 毫秒'), true)
  const kept = await hostileReasonResult(shipped)
  assert.equal(kept.code, V2_ERROR.LOCAL_PENDING)
  assert.equal(kept.message.includes(`最近一次推送失败：E_PUSH_REJECTED：${shipped}）`), true)

  // 唯一允许的变量是纯数字：换成文字就必须整段折叠成固定短语（闸门没有放宽）。
  const tampered = shipped.replace('20000', '两百')
  const folded = await hostileReasonResult(tampered)
  assert.equal(folded.message.includes('推送失败（原因类别未识别）'), true)
  assert.equal(folded.message.includes('两百'), false)
})

test('PO-10 drift guard：cycle.ts 的精确短语表与 gitPort.pushFailure() 逐字一致', () => {
  const shipped = shippedPushReasons()
  const allowed = cycleAllowedReasons()
  assert.equal(shipped.length, 5)
  assert.equal(allowed.length, 5)
  // 任一侧改写 / 增删短语都会让排序后的数组不同 ⇒ 本测试失败，
  // 不会让重新措辞的正文悄无声息地穿过终态消息。
  assert.deepEqual(allowed, shipped)
})
