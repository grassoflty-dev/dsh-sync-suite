/**
 * `mod-plugin-git-store`（写半侧）v2 同步周期测试：门禁顺序、union 字节裁决、
 * outbox 停放/出队、push 实参、源码形态守卫。
 *
 * 所有 IO 用内存端口注入；`git` 端口刻意只有 fetch/读/add/commit/push，
 * 从类型上就不可能做历史改写。中文注释逐条说明钉住的契约规则。
 * 被测对象：dist/sync/cycle.js（前置：node scripts/build.mjs）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_ATTEMPTS,
  MAX_CYCLE_RETRIES,
  PUSH_ARGS,
  V2_ERROR,
  FACTS_INVALID_MESSAGE,
  assertUpsertIntent,
  DEFAULT_V2_INSTANCE_ID,
  dequeueIntents,
  enqueueIntent,
  gateOfFacts,
  hasV2Trailer,
  isConfinedTimelinePath,
  isOursCommit,
  isV2CommitSubject,
  makeIntentId,
  markAttempt,
  markSyncing,
  replayable,
  retryIntent,
  runV2Cycle,
  sortConflictRows,
  syncCommitMessage,
  unionDay,
  v2TrailerLine,
} from '../dist/sync/cycle.js'
import {
  FRESH_SCHEMA_TEXT,
  buildRecordsText,
  canonicalRecordLine,
  parseTimelineDay,
} from '../dist/timeline/index.js'

const DAY = '2026-11-19'
const DAY2 = '2026-11-20'
const T0930 = `${DAY}T09:30:00+08:00`
const T1000 = `${DAY}T10:00:00+08:00`

function rec(overrides = {}) {
  return {
    id: 'a1', ts: T0930, title: 't', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: T0930, ...overrides
  }
}

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
  constructor(opts = {}) {
    this.branch = opts.branch ?? 'main'
    this.head = opts.head ?? 'sha-1'
    this.origin = opts.origin ?? 'sha-1'
    this.remote = opts.remote ?? {}
    // m2：HEAD 提交树字节（与工作树 MemFs 分开注入，才能测「工作树匹配而 HEAD 不同」）。
    this.headFiles = opts.headFiles ?? {}
    this.pushError = opts.pushError ?? null
    this.ahead = opts.ahead ?? 0
    this.behind = opts.behind ?? 0
    this.aheadCommitList = opts.aheadCommits ?? []
    this.onPush = opts.onPush ?? null
    this.onCommit = opts.onCommit ?? null
    this.calls = []
  }
  async branchName() { return this.branch }
  async fetchMain() { this.calls.push(['fetch']) }
  async headSha() { return this.head }
  async originMainSha() { return this.origin }
  async showRemote(rel) { return this.remote[rel] ?? '' }
  async showHead(rel) { return this.headFiles[rel] ?? '' }
  async addPaths(paths) { this.calls.push(['add', paths.slice()]) }
  async commit(message, body) {
    this.calls.push(['commit', message, body])
    if (this.onCommit !== null) await this.onCommit()
  }
  async pushMain(args) {
    this.calls.push(['push', args])
    if (this.onPush !== null) await this.onPush()
    if (this.pushError !== null) throw new Error(this.pushError)
  }
  async aheadBehind() { return { ahead: this.ahead, behind: this.behind } }
  async aheadCommits() { return this.aheadCommitList.slice() }
  writes() { return this.calls.filter((c) => ['add', 'commit', 'push'].includes(c[0])) }
}

class MemOutbox {
  constructor(entries = []) { this.entries = entries.slice(); this.saves = 0 }
  async load() { return this.entries.slice() }
  async save(entries) { this.saves += 1; this.entries = entries.slice() }
}

function makeIntent(overrides = {}) {
  const date = overrides.date ?? DAY
  const id = overrides.id ?? 'a1'
  const ts = overrides.ts ?? T0930
  const op = overrides.op ?? 'upsert'
  return {
    intentId: makeIntentId(date, id, ts, op), op, date, id, ts,
    line: overrides.line ?? JSON.stringify(rec({ id, ts })),
    enqueuedAt: T1000, attempts: 0, state: 'pending', lastError: '', ...overrides,
  }
}

function opts({ fs = new MemFs(), git = new FakeGit(), outbox = new MemOutbox(), days = [DAY] } = {}) {
  return { fs, git, outbox, days, now: new Date(T1000) }
}

/** 本模块提交的只读事实：subject + body 尾注 + 只动 timeline/**。 */
function ownCommit(overrides = {}) {
  return {
    subject: '[v2] sync 1 days',
    body: v2TrailerLine(),
    paths: [`timeline/${DAY}/records.json`],
    ...overrides,
  }
}

// ================================================================ 门禁

test('C01 schema 未知 → typed E_SCHEMA_UNKNOWN，零写入（连 outbox 都不落盘）', async () => {
  const fs = new MemFs({ 'timeline/schema.json': '{"schemaVersion":99}' })
  const git = new FakeGit()
  const outbox = new MemOutbox([makeIntent()])
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(result.code, V2_ERROR.SCHEMA_UNKNOWN)
  assert.equal(result.ok, false)
  assert.deepEqual(fs.writeCalls(), [])
  assert.deepEqual(git.writes(), [])
  assert.equal(outbox.saves, 0)
})

test('C02 schema 缺失 → 幂等创建规范标记后周期继续；第二次运行不再重复创建', async () => {
  const fs = new MemFs()
  const git = new FakeGit()
  const result = await runV2Cycle(opts({ fs, git, days: [] }))
  assert.equal(result.ok, true)
  assert.equal(fs.files.get('timeline/schema.json'), FRESH_SCHEMA_TEXT)
  assert.match(git.calls.find((c) => c[0] === 'commit')[1], /^\[v2\] sync \d+ days$/)
  const markerBefore = fs.files.get('timeline/schema.json')
  const second = await runV2Cycle(opts({ fs, git, days: [] }))
  assert.equal(second.ok, true)
  assert.equal(fs.files.get('timeline/schema.json'), markerBefore)
  assert.equal(fs.writeCalls().filter((c) => c[1] === 'timeline/schema.json').length, 1)
})

test('C03 分支不是 main → typed E_BRANCH_MISMATCH，fetch/写入都不发生', async () => {
  const git = new FakeGit({ branch: 'dev' })
  const fs = new MemFs()
  const result = await runV2Cycle(opts({ fs, git }))
  assert.equal(result.code, V2_ERROR.BRANCH_MISMATCH)
  assert.equal(git.calls.some((c) => c[0] === 'fetch'), false)
  assert.deepEqual(fs.writeCalls(), [])
})

test('C04 字符串事实与计数事实自相矛盾（HEAD≠origin 但 ahead=behind=0）→ fail-closed E_NOT_SYNCED，零 add/commit/push、无任何历史改写', async () => {
  const git = new FakeGit({ origin: 'rival-sha' })
  const fs = new MemFs()
  const result = await runV2Cycle(opts({ fs, git }))
  assert.equal(result.code, V2_ERROR.NOT_SYNCED)
  // 事实自相矛盾时的文案只说明「事实不可用」，不是分叉文案、更不是静默 proceed。
  assert.equal(result.message, FACTS_INVALID_MESSAGE)
  assert.deepEqual(git.writes(), [])
  assert.deepEqual(fs.writeCalls(), [])
  assert.deepEqual(git.calls[0], ['fetch']) // fetch 先于 HEAD 断言
})

test('C05 gateOfFacts 顺序固定：schema 优先于分支，分支优先于 HEAD', async () => {
  assert.equal(gateOfFacts('{"schemaVersion":3}', 'dev', 'x', 'y').code, V2_ERROR.SCHEMA_UNKNOWN)
  assert.equal(gateOfFacts('', 'dev', 'x', 'y').code, V2_ERROR.BRANCH_MISMATCH)
  assert.equal(gateOfFacts(FRESH_SCHEMA_TEXT, 'main', 'x', 'y').code, V2_ERROR.NOT_SYNCED)
  assert.equal(gateOfFacts(FRESH_SCHEMA_TEXT, 'main', 'x', 'x').ok, true)
})

test('C06 任一侧 records.json date 与目录名不符 → E_CORRUPT，整周期零日写入', async () => {
  const bad = buildRecordsText(DAY, [rec()]).replace(`"${DAY}"`, '"2026-01-01"')
  const fs = new MemFs({ [`timeline/${DAY}/records.json`]: bad })
  const git = new FakeGit({ remote: { [`timeline/${DAY}/records.json`]: buildRecordsText(DAY, [rec({ body: 'r' })]) } })
  const result = await runV2Cycle(opts({ fs, git }))
  assert.equal(result.code, V2_ERROR.CORRUPT)
  assert.deepEqual(fs.writeCalls(), [])
  assert.deepEqual(git.writes(), [])
})

// ================================================================ union / 字节裁决

test('C07 两设备同 id 同 ts 不同 body：UTF-8 字节较大者胜，败者进 conflicts（顺序无关）', () => {
  const bodyA = buildRecordsText(DAY, [rec({ body: 'A' })])
  const bodyB = buildRecordsText(DAY, [rec({ body: 'B' })])
  const a = unionDay(DAY, { records: bodyA, deleted: '', restore: '' }, { records: bodyB, deleted: '', restore: '' }, [], new Date(T1000))
  const b = unionDay(DAY, { records: bodyB, deleted: '', restore: '' }, { records: bodyA, deleted: '', restore: '' }, [], new Date(T1000))
  assert.equal(a.recordsText, b.recordsText)
  assert.equal(a.conflictRows.length, 1)
  assert.deepEqual(a.conflictRows, b.conflictRows)
  const winner = parseTimelineDay(a.recordsText, DAY).day.allRecords[0]
  assert.equal(winner.body, 'B') // "B" 的规范整行字节序更大
  const loser = JSON.parse(a.conflictRows[0])
  assert.equal(loser.id, 'a1')
  assert.equal(loser.ts, T0930)
  assert.equal(JSON.parse(loser.losingLine).body, 'A')
  assert.match(loser.dedupeKey, /^[0-9a-f]{64}$/)
})

test('C08 不同 ts 静默折叠：较晚 ts 胜且不产生 conflict 行', () => {
  const early = buildRecordsText(DAY, [rec({ ts: T0930, body: '早' })])
  const late = buildRecordsText(DAY, [rec({ ts: T1000, body: '晚' })])
  const u = unionDay(DAY, { records: early, deleted: '', restore: '' }, { records: late, deleted: '', restore: '' }, [], new Date(T1000))
  assert.equal(parseTimelineDay(u.recordsText, DAY).day.allRecords[0].body, '晚')
  assert.deepEqual(u.conflictRows, [])
})

test('C09 周期落盘：冲突审计行只增一份，重放同一冲突不追加第二行', async () => {
  const remoteText = buildRecordsText(DAY, [rec({ body: 'A' })])
  const localText = buildRecordsText(DAY, [rec({ body: 'B' })])
  const fs = new MemFs({ [`timeline/${DAY}/records.json`]: localText })
  const git = new FakeGit({ remote: { [`timeline/${DAY}/records.json`]: remoteText } })
  const first = await runV2Cycle(opts({ fs, git }))
  assert.equal(first.ok, true)
  assert.equal(first.conflicts, 1)
  const rows = fs.files.get(`timeline/${DAY}/conflicts.jsonl`).trim().split('\n')
  assert.equal(rows.length, 1)
  const before = fs.files.get(`timeline/${DAY}/conflicts.jsonl`)
  const second = await runV2Cycle(opts({ fs, git }))
  assert.equal(second.conflicts, 0)
  assert.equal(fs.files.get(`timeline/${DAY}/conflicts.jsonl`), before)
})

// ================================================================ outbox

test('C10 push 失败：意图 attempts+1 停放、不得报成功；四次后 failed 终态', async () => {
  const outbox = new MemOutbox([makeIntent()])
  for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
    const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
    const git = new FakeGit({ pushError: 'E_PUSH_REJECTED: rival advanced' })
    const result = await runV2Cycle(opts({ fs, git, outbox }))
    assert.equal(result.ok, false)
    assert.equal(result.code, V2_ERROR.PUSH_REJECTED)
    assert.equal(outbox.entries[0].attempts, i)
    assert.equal(outbox.entries[0].state, i >= MAX_ATTEMPTS ? 'failed' : 'pending')
    assert.match(outbox.entries[0].lastError, /E_PUSH_REJECTED/)
  }
  assert.equal(replayable(outbox.entries).length, 0) // 停止自动重放
  const retried = retryIntent(outbox.entries[0])
  assert.equal(retried.attempts, 0)
  assert.equal(retried.state, 'pending')
  assert.equal(retried.line, outbox.entries[0].line)
})

test('C11 push 成功：applied 意图出队、outbox 排空，push 实参固定 force:false', async () => {
  const outbox = new MemOutbox([makeIntent()])
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
  const git = new FakeGit()
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(result.ok, true)
  assert.equal(result.applied, 1)
  assert.deepEqual(outbox.entries, [])
  const push = git.calls.find((c) => c[0] === 'push')
  assert.deepEqual(push[1], { remote: 'origin', branch: 'main', force: false })
  assert.deepEqual(PUSH_ARGS, { remote: 'origin', branch: 'main', force: false })
})

test('C12 提交信息形状 `[v2] sync <N> days`，N 为实际改动天数', async () => {
  const git = new FakeGit({
    remote: {
      [`timeline/${DAY}/records.json`]: buildRecordsText(DAY, [rec()]),
      [`timeline/${DAY2}/records.json`]: buildRecordsText(DAY2, [rec({ id: 'b2', ts: `${DAY2}T09:00:00+08:00`, opened_at: `${DAY2}T09:00:00+08:00` })]),
    },
  })
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
  const result = await runV2Cycle(opts({ fs, git, days: [DAY, DAY2] }))
  assert.equal(result.ok, true)
  const commit = git.calls.find((c) => c[0] === 'commit')[1]
  assert.match(commit, /^\[v2\] sync \d+ days$/)
  assert.equal(commit, syncCommitMessage(2))
})

test('C13 已删除 id 的旧 upsert 意图按 P1-3(c) 丢弃出队，绝不复活', async () => {
  const deletedLine = JSON.stringify({ id: 'a1', ts: T1000, deletedAt: T1000 })
  const fs = new MemFs({
    'timeline/schema.json': FRESH_SCHEMA_TEXT,
    [`timeline/${DAY}/deleted.jsonl`]: `${deletedLine}\n`,
  })
  const outbox = new MemOutbox([makeIntent()])
  const git = new FakeGit()
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(result.ok, true)
  assert.equal(result.dropped, 1)
  assert.deepEqual(outbox.entries, [])
  const records = fs.files.get(`timeline/${DAY}/records.json`) ?? ''
  assert.equal(records.includes('"a1"'), false)
})

test('C14 意图按 (date,id,ts,op) 内容判重；markAttempt/dequeue/retry 语义', async () => {
  const one = makeIntent()
  let entries = enqueueIntent([], one)
  entries = enqueueIntent(entries, makeIntent())
  assert.equal(entries.length, 1)
  assert.equal(entries[0].intentId, makeIntentId(DAY, 'a1', T0930, 'upsert'))
  const bumped = markAttempt(one, 'E_PUSH_REJECTED')
  assert.equal(bumped.attempts, 1)
  assert.equal(bumped.state, 'pending')
  assert.deepEqual(dequeueIntents([one, makeIntent({ id: 'b2' })], [one.intentId]).length, 1)
})

// ================================================================ 源码形态守卫

test('C15 源码守卫（M6）：四个源码 + 全部编译产物均无历史改写/分支设置，含 camelCase 变体', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const sources = [
    '../src/timeline/write.ts',
    '../src/sync/cycle.ts',
    '../src/sync/gitPort.ts',
    '../src/sync/syncGate.ts',
    '../src/sync/repoPath.ts',
    '../src/sync/outbox.ts',
    '../src/sync/bootstrap.ts',
  ]
  const distDir = path.resolve(here, '../dist/sync')
  const compiled = readdirSync(distDir).filter((name) => name.endsWith('.js')).map((name) => `../dist/sync/${name}`)
  // 含 resetHard / reset[A-Z] camelCase：原 C15 的 \breset\b 抓不到。
  const forbidden = /resetHard|reset[A-Z]|\breset\b|rebase|checkout|--force|force\s*:\s*true|pullRebase|pushWithRebase/i
  for (const rel of [...sources, ...compiled]) {
    const source = readFileSync(path.resolve(here, rel), 'utf8')
    assert.equal(forbidden.test(source), false, `${rel} 含被禁的历史改写/分支设置片段`)
  }
  assert.ok(compiled.length >= 5, '编译产物扫描集合不能退化')
})

test('C16 编译产物守卫（M6）：扫描全部 dist/sync/*.js，并钉住 gitPort 的运行期 force 断言', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const distDir = path.resolve(here, '../dist/sync')
  const names = readdirSync(distDir).filter((name) => name.endsWith('.js'))
  const forbidden = /resetHard|rebase|checkout|force\s*:\s*true|pushWithRebase|pullRebase/i
  for (const name of names) {
    const source = readFileSync(path.join(distDir, name), 'utf8')
    assert.equal(forbidden.test(source), false, `${name} 暴露了历史改写面`)
  }
  const cycle = readFileSync(path.join(distDir, 'cycle.js'), 'utf8')
  assert.match(cycle, /force: false/)
  const gitPort = readFileSync(path.join(distDir, 'gitPort.js'), 'utf8')
  // N2：运行期断言必须还在，不能只靠 cycle.js 里 PUSH_ARGS 的常量。
  assert.match(gitPort, /args\.remote\s*!==\s*["']origin["']/)
  assert.match(gitPort, /args\.branch\s*!==\s*["']main["']/)
  assert.match(gitPort, /args\.force\s*!==\s*false/)
})

// ================================================================ B1（数据破坏路径）

test('C17 B1 逆向复现：畸形 upsert → typed E_CORRUPT，records.json 哈希不变、outbox 原样、零提交零推送', async () => {
  const rel = `timeline/${DAY}/records.json`
  const original = buildRecordsText(DAY, [rec({ body: 'safe' })])
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT, [rel]: original })
  const beforeHash = createHash('sha256').update(fs.files.get(rel)).digest('hex')
  const bad = makeIntent({ line: JSON.stringify({ ...rec(), title: 123 }) }) // 复现评审里的 title:123
  const outbox = new MemOutbox([bad])
  const snapshot = JSON.stringify(outbox.entries)
  const git = new FakeGit()
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.CORRUPT)
  assert.equal(createHash('sha256').update(fs.files.get(rel)).digest('hex'), beforeHash)
  assert.equal(JSON.stringify(outbox.entries), snapshot) // 同一条目、attempts 仍为 0
  assert.equal(outbox.entries[0].attempts, 0)
  assert.equal(outbox.saves, 0)
  assert.deepEqual(git.writes(), [])
  // union 直接调用也必须抛错，不能靠调用方自觉。
  assert.throws(
    () => unionDay(DAY, { records: original, deleted: '', restore: '' }, { records: '', deleted: '', restore: '' }, [bad], new Date(T1000)),
    (error) => error.code === V2_ERROR.CORRUPT,
  )
})

test('C18 B1 ts 形状非法 / id·ts 漂移同样 typed 拒绝（无半个文件、无出队）', async () => {
  const cases = [
    makeIntent({ ts: 'not-a-ts', line: JSON.stringify(rec({ ts: 'not-a-ts' })) }),
    makeIntent({ id: 'a1', line: JSON.stringify(rec({ id: 'different' })) }),
  ]
  for (const intent of cases) {
    const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
    const outbox = new MemOutbox([intent])
    const git = new FakeGit()
    const result = await runV2Cycle(opts({ fs, git, outbox }))
    assert.equal(result.code, V2_ERROR.CORRUPT)
    assert.equal(outbox.entries.length, 1)
    assert.equal(outbox.entries[0].attempts, 0)
    assert.deepEqual(git.writes(), [])
  }
  assert.equal(typeof assertUpsertIntent, 'function')
})

// ================================================================ M3（推拒后的有界恢复）

test('C19 M3 推拒后下一周期识别本模块未推提交 → 重取远端/重算 union/再推成功', async () => {
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
  const outbox = new MemOutbox([makeIntent()])
  const first = new FakeGit({ pushError: 'E_PUSH_REJECTED: rival advanced' })
  const r1 = await runV2Cycle(opts({ fs, git: first, outbox }))
  assert.equal(r1.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(outbox.entries[0].attempts, 1)
  // 模拟本地留有我们自己的 v2 提交，远端尚未收到。
  const second = new FakeGit({
    head: 'local-v2', origin: 'remote-1', ahead: 1, behind: 0, aheadCommits: [ownCommit()],
    headFiles: { [`timeline/${DAY}/records.json`]: buildRecordsText(DAY, [rec()]) },
  })
  const r2 = await runV2Cycle(opts({ fs, git: second, outbox }))
  assert.equal(r2.ok, true)
  assert.match(r2.message, /恢复/)
  assert.deepEqual(outbox.entries, [])
  assert.equal(second.writes().length, 1) // 只有 push，无 add/commit（不改写历史）
  assert.deepEqual(second.writes()[0], ['push', PUSH_ARGS])
  assert.equal(isV2CommitSubject('[v2] sync 1 days'), true)
  assert.equal(isV2CommitSubject('manual fix'), false)
})

test('C20 M3 恢复有界：持续被拒 → E_LOCAL_PENDING 终态，推送次数恰为 MAX_CYCLE_RETRIES，绝不改写历史', async () => {
  // 本地文件必须已存在（即上一周期提交的那份），否则重算 union 会发现「远端有而本地无」而提前终止。
  const committed = buildRecordsText(DAY, [rec()])
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT, [`timeline/${DAY}/records.json`]: committed })
  const outbox = new MemOutbox([makeIntent()])
  const git = new FakeGit({
    head: 'local-v2', origin: 'remote-1', ahead: 1, behind: 0,
    aheadCommits: [ownCommit()], pushError: 'E_PUSH_REJECTED: still rejected',
    headFiles: { [`timeline/${DAY}/records.json`]: committed },
  })
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.LOCAL_PENDING)
  assert.match(result.message, /下一步/)
  assert.match(result.message, /手工协调/)
  assert.equal(git.calls.filter((c) => c[0] === 'push').length, MAX_CYCLE_RETRIES)
  assert.equal(git.calls.some((c) => c[0] === 'add' || c[0] === 'commit'), false)
  assert.equal(outbox.entries[0].attempts, MAX_CYCLE_RETRIES) // 预算跨会话累加
})

test('C21 M3 领先提交不是本模块产生 → 仍 E_NOT_SYNCED，不进入恢复通道', async () => {
  const fs = new MemFs()
  const git = new FakeGit({ head: 'local', origin: 'remote', ahead: 1, behind: 0, aheadCommits: [ownCommit({ subject: 'manual local commit' })] })
  const result = await runV2Cycle(opts({ fs, git }))
  assert.equal(result.code, V2_ERROR.NOT_SYNCED)
  assert.equal(git.calls.filter((c) => c[0] === 'push').length, 0)
})

test('C22 m6 syncing 中间态：push 前当场落盘，失败后回到 pending 且 attempts=1', async () => {
  const outbox = new MemOutbox([makeIntent()])
  let stateAtPush = ''
  const git = new FakeGit({
    pushError: 'E_PUSH_REJECTED: nope',
    onPush: async () => { stateAtPush = outbox.entries[0].state },
  })
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(stateAtPush, 'syncing')
  assert.equal(outbox.entries[0].state, 'pending')
  assert.equal(outbox.entries[0].attempts, 1)
  assert.equal(result.ok, false)
  assert.equal(markSyncing(makeIntent()).state, 'syncing')
})

// ================================================================ M4（冲突行确定性排序）

test('C23 M4 多冲突行按 (ts,id,dedupeKey) 排序，remote/local 互换逐字节一致', () => {
  const early = '2026-11-19T08:00:00+08:00'
  const earlyRec = (body) => rec({ id: 'c3', ts: early, body, opened_at: early })
  const ra = buildRecordsText(DAY, [
    rec({ id: 'a1', body: 'A' }), rec({ id: 'b2', body: 'C' }), earlyRec('E'),
  ])
  const lb = buildRecordsText(DAY, [
    rec({ id: 'a1', body: 'B' }), rec({ id: 'b2', body: 'D' }), earlyRec('F'),
  ])
  const forward = unionDay(DAY, { records: ra, deleted: '', restore: '' }, { records: lb, deleted: '', restore: '' }, [], new Date(T1000))
  const swapped = unionDay(DAY, { records: lb, deleted: '', restore: '' }, { records: ra, deleted: '', restore: '' }, [], new Date(T1000))
  assert.equal(forward.conflictRows.length, 3)
  assert.deepEqual(forward.conflictRows, swapped.conflictRows)
  const ids = forward.conflictRows.map((row) => [JSON.parse(row).ts, JSON.parse(row).id])
  assert.deepEqual(ids, [
    [early, 'c3'], [T0930, 'a1'], [T0930, 'b2'],
  ]) // ts 升序，同 ts 再按 id 升序
  const scrambled = sortConflictRows([forward.conflictRows[2], forward.conflictRows[0], forward.conflictRows[1]])
  assert.deepEqual(scrambled, forward.conflictRows)
})

// ================================================================ F1 / F2（r2 复评）

test('C24 F1 恢复路径逆向复现：畸形意图 + 可恢复领先态 → typed E_CORRUPT，零推送、零出队、字节不变', async () => {
  const rel = `timeline/${DAY}/records.json`
  const committed = buildRecordsText(DAY, [rec()])
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT, [rel]: committed })
  const beforeHash = createHash('sha256').update(fs.files.get(rel)).digest('hex')
  const bad = makeIntent({ line: JSON.stringify({ ...rec(), title: 123 }) })
  const outbox = new MemOutbox([bad])
  const snapshot = JSON.stringify(outbox.entries)
  const git = new FakeGit({
    head: 'local-v2', origin: 'remote-1', ahead: 1, behind: 0, aheadCommits: [ownCommit()],
    headFiles: { [rel]: committed },
  })
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.CORRUPT)
  assert.equal(createHash('sha256').update(fs.files.get(rel)).digest('hex'), beforeHash)
  assert.equal(JSON.stringify(outbox.entries), snapshot) // 条目、attempts、lastError 全不变
  assert.equal(outbox.entries[0].attempts, 0)
  assert.equal(outbox.saves, 0)
  assert.equal(git.calls.filter((c) => c[0] === 'push').length, 0)
  assert.equal(git.calls.some((c) => c[0] === 'add' || c[0] === 'commit'), false)
})

test('C25 F2 同 subject 但无尾注（App 也会发 subject）→ typed 拒绝，零推送', async () => {
  const fs = new MemFs()
  const git = new FakeGit({
    head: 'app-local', origin: 'remote-1', ahead: 1, behind: 0,
    aheadCommits: [ownCommit({ body: '' })], // 与 App 的 `-m subject` 完全一致
  })
  const result = await runV2Cycle(opts({ fs, git }))
  assert.equal(result.code, V2_ERROR.NOT_SYNCED)
  assert.match(result.message, /dsh-dots-v2/)
  assert.equal(git.calls.filter((c) => c[0] === 'push').length, 0)
  assert.equal(isOursCommit(ownCommit({ body: '' })), false)
})

test('C26 F2 有尾注但 diff 触及非 timeline 路径 → typed 拒绝，零推送', async () => {
  const fs = new MemFs()
  const git = new FakeGit({
    head: 'foreign-local', origin: 'remote-1', ahead: 1, behind: 0,
    aheadCommits: [ownCommit({ paths: [`timeline/${DAY}/records.json`, 'chats/secret.json'] })],
  })
  const result = await runV2Cycle(opts({ fs, git }))
  assert.equal(result.code, V2_ERROR.NOT_SYNCED)
  assert.equal(git.calls.filter((c) => c[0] === 'push').length, 0)
  assert.equal(isOursCommit(ownCommit({ paths: ['chats/x'] })), false)
})

test('C27 F2 尾注由本周期 commit 路径写入 body；格式逐字固定', async () => {
  const outbox = new MemOutbox([makeIntent()])
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
  const git = new FakeGit()
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(result.ok, true)
  const commit = git.calls.find((c) => c[0] === 'commit')
  assert.equal(commit[1], syncCommitMessage(1))
  assert.equal(commit[2], v2TrailerLine())
  assert.equal(v2TrailerLine(), `dsh-dots-v2: ${DEFAULT_V2_INSTANCE_ID}`)
  assert.equal(hasV2Trailer(commit[2]), true)
  assert.equal(hasV2Trailer('unrelated body'), false)
  assert.equal(isOursCommit(ownCommit()), true)
})

// ================================================================ r4 Minors

test('C28 m1 路径收容：../、./、双斜杠、Windows 分隔符、绝对路径全部拒绝且恢复路径不推送', async () => {
  const badPaths = [
    'timeline/../etc/passwd',
    'timeline/./x',
    'timeline//x',
    'timeline\\..\\secret',
    'C:\\etc\\passwd',
    '/etc/passwd',
  ]
  for (const p of badPaths) {
    assert.equal(isConfinedTimelinePath(p), false, p)
    assert.equal(isOursCommit(ownCommit({ paths: [p] })), false, p)
    const git = new FakeGit({
      head: 'app-local', origin: 'remote-1', ahead: 1, behind: 0, aheadCommits: [ownCommit({ paths: [p] })],
    })
    const result = await runV2Cycle(opts({ fs: new MemFs(), git }))
    assert.equal(result.code, V2_ERROR.NOT_SYNCED, p)
    assert.equal(git.calls.filter((c) => c[0] === 'push').length, 0, p)
  }
  // 正常路径仍收容（正向对照）。
  assert.equal(isConfinedTimelinePath(`timeline/${DAY}/records.json`), true)
})

test('C29 m2 工作树匹配但 HEAD 不同 → typed E_CORRUPT，零推送、零出队', async () => {
  const rel = `timeline/${DAY}/records.json`
  // 工作树放着意图对应的记录；HEAD 里却是另一条 body —— 提交树才是推送对象。
  const inTree = buildRecordsText(DAY, [rec({ body: 'X' })])
  const inHead = buildRecordsText(DAY, [rec({ body: 'Y' })])
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT, [rel]: inTree })
  const outbox = new MemOutbox([makeIntent({ line: JSON.stringify(rec({ body: 'X' })) })])
  const snapshot = JSON.stringify(outbox.entries)
  const git = new FakeGit({
    head: 'local-v2', origin: 'remote-1', ahead: 1, behind: 0,
    aheadCommits: [ownCommit()],
    headFiles: { [rel]: inHead },
  })
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.CORRUPT)
  assert.match(result.message, /HEAD/)
  assert.equal(JSON.stringify(outbox.entries), snapshot)
  assert.equal(outbox.saves, 0)
  assert.equal(git.calls.filter((c) => c[0] === 'push').length, 0)
})

// ================================================================ mod-plugin-outbox-per-intent
//
// per-intent 恢复校验的三分支回归：停放意图（已认领，b）/ 缺字节（诚实拒绝，a）/
// 新写入（未应用，c）。今天的代码把 c 当 a，导致停放意图永远无法 flush 且新写入永远被拒。

test('PI-01 停放意图(attempts≥1) + 一条新写入 → 两者都应用并推送，无 E_CORRUPT', async () => {
  const rel = `timeline/${DAY}/records.json`
  const outbox = new MemOutbox([makeIntent({ id: 'a1', ts: T0930 })])
  const fs1 = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
  const git1 = new FakeGit({ pushError: 'E_PUSH_REJECTED: auth-prompt' })
  const first = await runV2Cycle(opts({ fs: fs1, git: git1, outbox }))
  assert.equal(first.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(outbox.entries[0].attempts, 1)
  const parked = outbox.entries[0] // 停放意图已被提交认领（commitSha 在下方断言）

  // 停放期间新来一条写入（不同 id），还没落地任何提交。
  outbox.entries.push(makeIntent({ id: 'b2', ts: T1000 }))

  const headText = fs1.files.get(rel)
  const fs2 = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT, [rel]: headText })
  const git2 = new FakeGit({
    head: 'local-v2', origin: 'remote-1', ahead: 1, behind: 0,
    aheadCommits: [ownCommit()], headFiles: { [rel]: headText },
  })
  // 模拟真实提交/推送的字节流：commit 把工作树写进 HEAD，push 把 HEAD 当作 origin。
  git2.onCommit = async () => { git2.headFiles[rel] = fs2.files.get(rel) ?? ''; git2.head = 'local-v2-2' }
  git2.onPush = async () => { git2.origin = git2.head }

  const second = await runV2Cycle(opts({ fs: fs2, git: git2, outbox }))
  assert.equal(second.ok, true)
  assert.notEqual(second.code, V2_ERROR.CORRUPT)
  assert.ok(parked.commitSha) // 认领停放意图的提交 sha 已回填
  assert.deepEqual(outbox.entries, [])
  assert.equal(git2.calls.filter((c) => c[0] === 'push').length, 1)
  const ids = parseTimelineDay(git2.headFiles[rel], DAY).day.allRecords.map((r) => r.id).sort()
  assert.deepEqual(ids, ['a1', 'b2']) // 停放 + 新写入都落在被推送的树里
})

test('PI-02 认领提交里确实缺该意图的行 → E_CORRUPT，零推送，意图原样保留（诚实 case a）', async () => {
  const rel = `timeline/${DAY}/records.json`
  // 认领提交里只有别的记录，a1 的行确实不在其中。
  const headText = buildRecordsText(DAY, [rec({ id: 'other', ts: T0930 })])
  const intentional = makeIntent({ id: 'a1', ts: T0930, attempts: 1, state: 'pending', commitSha: 'claim-sha' })
  const outbox = new MemOutbox([intentional])
  const snapshot = JSON.stringify(outbox.entries)
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT, [rel]: headText })
  const git = new FakeGit({
    head: 'local-v2', origin: 'remote-1', ahead: 1, behind: 0,
    aheadCommits: [ownCommit()], headFiles: { [rel]: headText },
  })
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(result.ok, false)
  assert.equal(result.code, V2_ERROR.CORRUPT)
  assert.match(result.message, /HEAD/)
  assert.equal(git.calls.filter((c) => c[0] === 'push').length, 0)
  assert.equal(git.calls.some((c) => c[0] === 'add' || c[0] === 'commit'), false)
  assert.equal(JSON.stringify(outbox.entries), snapshot) // 未出队、未改 attempts
})

test('PI-03 恢复推送成功后 outbox 排空且 HEAD == origin/main', async () => {
  const rel = `timeline/${DAY}/records.json`
  const headText = buildRecordsText(DAY, [rec()])
  const outbox = new MemOutbox([makeIntent({ attempts: 1, state: 'pending', commitSha: 'claim-sha' })])
  const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT, [rel]: headText })
  const git = new FakeGit({
    head: 'local-v2', origin: 'remote-1', ahead: 1, behind: 0,
    aheadCommits: [ownCommit()], headFiles: { [rel]: headText },
  })
  git.onPush = async () => { git.origin = git.head }
  const result = await runV2Cycle(opts({ fs, git, outbox }))
  assert.equal(result.ok, true)
  assert.notEqual(result.code, V2_ERROR.CORRUPT)
  assert.deepEqual(outbox.entries, [])
  assert.equal(git.head, git.origin)
  assert.equal(git.calls.filter((c) => c[0] === 'push').length, 1)
  assert.equal(git.calls.some((c) => c[0] === 'add' || c[0] === 'commit'), false) // 停放意图只推不重写
})

test('PI-04 两个停放意图 + 一条新写入 → 三者全部落地，无 E_CORRUPT', async () => {
  const rel = `timeline/${DAY}/records.json`
  const outbox = new MemOutbox([
    makeIntent({ id: 'a1', ts: T0930 }),
    makeIntent({ id: 'b2', ts: T1000 }),
  ])
  const fs1 = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
  const git1 = new FakeGit({ pushError: 'E_PUSH_REJECTED: auth-prompt' })
  const first = await runV2Cycle(opts({ fs: fs1, git: git1, outbox }))
  assert.equal(first.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(outbox.entries.filter((e) => e.attempts >= 1).length, 2)

  outbox.entries.push(makeIntent({ id: 'c3', ts: `${DAY}T11:00:00+08:00` }))

  const headText = fs1.files.get(rel)
  const fs2 = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT, [rel]: headText })
  const git2 = new FakeGit({
    head: 'local-v2', origin: 'remote-1', ahead: 1, behind: 0,
    aheadCommits: [ownCommit()], headFiles: { [rel]: headText },
  })
  git2.onCommit = async () => { git2.headFiles[rel] = fs2.files.get(rel) ?? ''; git2.head = 'local-v2-2' }
  git2.onPush = async () => { git2.origin = git2.head }

  const second = await runV2Cycle(opts({ fs: fs2, git: git2, outbox }))
  assert.equal(second.ok, true)
  assert.notEqual(second.code, V2_ERROR.CORRUPT)
  assert.deepEqual(outbox.entries, [])
  const ids = parseTimelineDay(git2.headFiles[rel], DAY).day.allRecords.map((r) => r.id).sort()
  assert.deepEqual(ids, ['a1', 'b2', 'c3'])
  assert.equal(git2.calls.filter((c) => c[0] === 'commit').length, 1) // 新写入一次提交
  assert.equal(git2.calls.filter((c) => c[0] === 'push').length, 1)
})
