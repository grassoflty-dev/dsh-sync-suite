/**
 * `mod-plugin-outbox-purge-failed`：仓库外 outbox 的陈旧失败意图清理。
 *
 * 只清理 state='failed' 且 enqueuedAt 年龄严格超过 PURGE_FAILED_AFTER_MS 的意图；
 * pending / syncing / 年龄不明一律 fail-closed 留着。出队统一走 dequeueIntents。
 * 日志只带数量，绝不外泄 lastError / commitSha / URL / token（碎片里有 mojibake）。
 * 机制已上线；三条碎片今天不清；最早 2026-11-29 19:12+08 起清除。
 * 被测对象：dist/sync/cycle.js（前置：node scripts/build.mjs）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PURGE_FAILED_AFTER_MS,
  dequeueIntents,
  isPurgeableFailedIntent,
  makeIntentId,
  outboxPurgeLogLine,
  purgeStaleFailedIntents,
  runV2Cycle,
  selectPurgeableIntents,
} from '../dist/sync/cycle.js'
import { FRESH_SCHEMA_TEXT } from '../dist/timeline/index.js'

const DAY = '2026-11-22'
const NOW_MS = Date.parse('2026-11-28T00:00:00+08:00')
/** 严格超过阈值（多 1 分钟）与严格落在窗口内（少 1 分钟）。 */
const OLD_MS = NOW_MS - PURGE_FAILED_AFTER_MS - 60_000
const FRESH_MS = NOW_MS - PURGE_FAILED_AFTER_MS + 60_000
const iso = (ms) => new Date(ms).toISOString()

/** P6 用的真实碎片形状：URL / token / mojibake / 旧 commitSha 都不许出现在日志里。 */
const SECRET_LAST_ERROR =
  'E_PUSH_REJECTED: https://u:token-ABC123@git.example.test/a.git?token=SECRET 鎵嬬画鎵€鍦ㄧ嚎 commitSha 163e086deadbeef'
const SECRET_SHA = '163e086deadbeef'

function intent(overrides = {}) {
  const ts = iso(OLD_MS)
  const id = overrides.id ?? 'a1'
  return {
    intentId: makeIntentId(DAY, id, ts, 'upsert'), op: 'upsert', date: DAY, id, ts,
    line: JSON.stringify({
      id, ts, title: 't', body: '', author: '我', done: false,
      media: [], ai_processed: false, opened_at: ts,
    }),
    enqueuedAt: ts, attempts: 4, state: 'failed', lastError: '', ...overrides,
  }
}

class MemOutbox {
  constructor(entries = []) { this.entries = entries.slice(); this.saves = [] }
  async load() { return this.entries.slice() }
  async save(entries) { this.saves.push(entries.slice()); this.entries = entries.slice() }
}

class MemFs {
  constructor(seed = {}) { this.files = new Map(Object.entries(seed)) }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) { const t = `${rel}.tmp`; this.files.set(t, text); return t }
  async readTemp(t) { return this.files.get(t) ?? '' }
  async rename(t, rel) { this.files.set(rel, this.files.get(t)); this.files.delete(t) }
  async backupIfExists(rel, b) {
    if (!this.files.has(rel)) return false
    this.files.set(b, this.files.get(rel)); return true
  }
  async append(rel, text) { this.files.set(rel, (this.files.get(rel) ?? '') + text) }
  async exists(rel) { return this.files.has(rel) }
}

class FakeGit {
  async branchName() { return 'main' }
  async fetchMain() {}
  async headSha() { return 'sha-1' }
  async originMainSha() { return 'sha-1' }
  async showRemote() { return '' }
  async showHead() { return '' }
  async addPaths() {}
  async commit() {}
  async pushMain() {}
  async aheadBehind() { return { ahead: 0, behind: 0 } }
  async aheadCommits() { return [] }
}

// ================================================================ P1–P7

test('P1 failed 且 enqueuedAt 严格超过阈值 → 被清理并落盘', async () => {
  const dead = intent({ id: 'dead', intentId: 'i-dead' })
  const outbox = new MemOutbox([dead])
  const ids = await purgeStaleFailedIntents(outbox, NOW_MS)
  assert.deepEqual(ids, ['i-dead'])
  assert.equal(isPurgeableFailedIntent(dead, NOW_MS), true)
  assert.deepEqual(outbox.entries, [])
  assert.equal(outbox.saves.length, 1)
})

test('P2 pending 意图（无论多老）都不清理', async () => {
  const pending = intent({ id: 'pend', intentId: 'i-pend', state: 'pending', attempts: 0 })
  const outbox = new MemOutbox([pending])
  const ids = await purgeStaleFailedIntents(outbox, NOW_MS)
  assert.deepEqual(ids, [])
  assert.equal(isPurgeableFailedIntent(pending, NOW_MS), false)
  assert.deepEqual(outbox.entries, [pending])
  assert.equal(outbox.saves.length, 0)
})

test('P3 syncing 意图不清理', async () => {
  const syncing = intent({ id: 'sync', intentId: 'i-sync', state: 'syncing', attempts: 1 })
  const outbox = new MemOutbox([syncing])
  const ids = await purgeStaleFailedIntents(outbox, NOW_MS)
  assert.deepEqual(ids, [])
  assert.equal(isPurgeableFailedIntent(syncing, NOW_MS), false)
  assert.deepEqual(outbox.entries, [syncing])
  assert.equal(outbox.saves.length, 0)
})

test('P4 failed 但 enqueuedAt 落在窗口内 → 不清理', async () => {
  const fresh = intent({ id: 'fresh', intentId: 'i-fresh', enqueuedAt: iso(FRESH_MS) })
  const outbox = new MemOutbox([fresh])
  const ids = await purgeStaleFailedIntents(outbox, NOW_MS)
  assert.deepEqual(ids, [])
  assert.equal(isPurgeableFailedIntent(fresh, NOW_MS), false)
  assert.deepEqual(outbox.entries, [fresh])
  assert.equal(outbox.saves.length, 0)
})

test('P4b failed 且 enqueuedAt 恰好等于阈值 → 不清理（严格大于才清）', async () => {
  const edge = intent({
    id: 'edge', intentId: 'i-edge', enqueuedAt: iso(NOW_MS - PURGE_FAILED_AFTER_MS),
  })
  const outbox = new MemOutbox([edge])
  const ids = await purgeStaleFailedIntents(outbox, NOW_MS)
  assert.equal(isPurgeableFailedIntent(edge, NOW_MS), false)
  assert.deepEqual(ids, [])
  assert.deepEqual(outbox.entries, [edge])
  assert.equal(outbox.saves.length, 0)
})

test('P5 failed 但 enqueuedAt 缺失 / 非法 / 非正 / 非有限 → fail-closed 不清理', async () => {
  const cases = [
    intent({ id: 'none', intentId: 'i-none', enqueuedAt: undefined }),
    intent({ id: 'bad', intentId: 'i-bad', enqueuedAt: 'not-a-date' }),
    intent({ id: 'nan', intentId: 'i-nan', enqueuedAt: Number.NaN }),
    intent({ id: 'null', intentId: 'i-null', enqueuedAt: null }),
    // 非正时间戳即便「看起来很老」也绝不作为删除理由（P2-1）。
    intent({ id: 'neg', intentId: 'i-neg', enqueuedAt: -1 }),
    intent({ id: 'negstr', intentId: 'i-negstr', enqueuedAt: '-1000' }),
    intent({ id: 'pre', intentId: 'i-pre', enqueuedAt: '1969-12-31T23:59:59Z' }),
  ]
  const outbox = new MemOutbox(cases)
  const ids = await purgeStaleFailedIntents(outbox, NOW_MS)
  assert.deepEqual(ids, [])
  for (const entry of cases) assert.equal(isPurgeableFailedIntent(entry, NOW_MS), false)
  assert.deepEqual(outbox.entries, cases)
  assert.equal(outbox.saves.length, 0)
})

test('P6 日志恰好一行，只含数量，不含 URL / token / lastError / commitSha', async () => {
  const lines = []
  const debris = [1, 2, 3].map((n) => intent({
    id: `d${n}`, intentId: `i-d${n}`, lastError: SECRET_LAST_ERROR, commitSha: SECRET_SHA,
  }))
  const outbox = new MemOutbox(debris)
  const ids = await purgeStaleFailedIntents(outbox, NOW_MS, PURGE_FAILED_AFTER_MS, {
    info: (line) => lines.push(line),
  })
  assert.equal(ids.length, 3)
  assert.equal(lines.length, 1)
  const line = lines[0]
  assert.equal(line, outboxPurgeLogLine(3))
  assert.equal(line, 'outbox: 已清理 3 条陈旧失败意图（>7 天）')
  assert.equal(line.includes('3'), true)
  assert.equal(line.includes('http'), false)
  assert.equal(line.includes('://'), false)
  assert.equal(line.includes('token'), false)
  assert.equal(line.includes(SECRET_LAST_ERROR), false)
  assert.equal(line.includes(SECRET_SHA), false)
})

test('P7 出队走 dequeueIntents：保留幸存者原顺序，只删选中 id', async () => {
  const old1 = intent({ id: 'old1', intentId: 'i-old1' })
  const pending = intent({ id: 'pend', intentId: 'i-pend', state: 'pending', attempts: 0 })
  const old2 = intent({ id: 'old2', intentId: 'i-old2' })
  const syncing = intent({ id: 'sync', intentId: 'i-sync', state: 'syncing', attempts: 1 })
  const fresh = intent({ id: 'fresh', intentId: 'i-fresh', enqueuedAt: iso(FRESH_MS) })
  const old3 = intent({ id: 'old3', intentId: 'i-old3' })
  const entries = [old1, pending, old2, syncing, fresh, old3]
  const outbox = new MemOutbox(entries)
  const ids = selectPurgeableIntents(entries, NOW_MS)
  assert.deepEqual(ids, ['i-old1', 'i-old2', 'i-old3'])
  const expected = dequeueIntents(entries, ids)
  assert.deepEqual(expected, [pending, syncing, fresh])
  await purgeStaleFailedIntents(outbox, NOW_MS)
  assert.deepEqual(outbox.entries, expected)
  assert.deepEqual(outbox.entries, dequeueIntents(entries, ids))
})

// ================================================================ 装配点

test('P8 成功周期之后才清理；CycleResult 全字段逐字不变', async () => {
  const dead = intent({
    id: 'dead', intentId: 'i-dead', lastError: SECRET_LAST_ERROR, commitSha: SECRET_SHA,
  })
  const outbox = new MemOutbox([dead])
  const lines = []
  const result = await runV2Cycle({
    days: [],
    git: new FakeGit(),
    fs: new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT }),
    outbox,
    now: new Date(NOW_MS),
    logger: { info: (line) => lines.push(line) },
  })
  // 全字段期望快照：钉住 ok / code / attempts 及其余每个结果字段都不因清理而改变。
  const expectedResult = {
    ok: true, code: 'ok', message: '已同步', days: [], applied: 0, dropped: 0,
    failed: 1, pending: 0, attempts: 0, conflicts: 0, writtenPaths: [], outbox: [dead],
  }
  assert.deepEqual(result, expectedResult)
  // 合成意图从注入端口出队，且只有一行纯计数日志。
  assert.deepEqual(outbox.entries, [])
  assert.equal(lines.length, 1)
  assert.equal(lines[0], 'outbox: 已清理 1 条陈旧失败意图（>7 天）')
})
