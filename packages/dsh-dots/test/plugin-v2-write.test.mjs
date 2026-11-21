/**
 * `mod-plugin-git-store`（写半侧）writer 测试：原子替换 / 回读校验 / 追加式账本 /
 * 共享规范序列化 / summary newer-wins。
 *
 * IO 全部用内存 `MemFs` 注入，不联网、不碰真实仓库；中文注释逐条说明钉住的契约规则。
 * 被测对象：packages/dsh-dots/dist/timeline/write.js（前置：node scripts/build.mjs）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NodeTimelineFs,
  appendConflicts,
  appendDeleted,
  appendRestored,
  atomicReplace,
  canonicalLineOf,
  conflictRowOf,
  deletedLedgerLine,
  isValidTsShape,
  mergeLedgerText,
  planRemove,
  planUpsert,
  restoredLedgerLine,
  saveSummary,
} from '../dist/timeline/write.js'
import {
  FRESH_SCHEMA_TEXT,
  buildRecordsText,
  canonicalRecordLine,
  parseTimelineDay,
} from '../dist/timeline/index.js'

const DAY = '2026-11-19'
const T0930 = `${DAY}T09:30:00+08:00`
const T1000 = `${DAY}T10:00:00+08:00`
const T1600 = `${DAY}T16:00:00+08:00`

function rec(overrides = {}) {
  return {
    id: 'a1', ts: T0930, title: '标题', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: T0930, ...overrides
  }
}

/** 内存 TimelineFs：可注入「回读被截断」「主改名失败」「回退改名失败」三类故障。 */
class MemFs {
  constructor(seed = {}) {
    this.files = new Map(Object.entries(seed))
    this.calls = []
    this.truncateReadback = 0
    this.failPrimaryRenameFor = new Set()
    this.failFallbackRename = false
    this.renameCount = new Map()
  }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) {
    const temp = `${rel}.tmp-1`
    this.calls.push(['writeTemp', rel, temp])
    this.files.set(temp, text)
    return temp
  }
  async readTemp(tempRel) {
    this.calls.push(['readTemp', tempRel])
    const text = this.files.get(tempRel) ?? ''
    return this.truncateReadback > 0 ? text.slice(0, this.truncateReadback) : text
  }
  async rename(tempRel, rel) {
    // 按「正式目标路径」计数：主 rename / 回退 rename / 恢复 rename 都落在同一个 rel 上。
    const n = (this.renameCount.get(rel) ?? 0) + 1
    this.renameCount.set(rel, n)
    this.calls.push(['rename', tempRel, rel])
    if (n === 1 && this.failPrimaryRenameFor.has(rel)) throw new Error('primary rename denied')
    if (n === 2 && this.failFallbackRename) throw new Error('fallback rename denied')
    this.files.set(rel, this.files.get(tempRel))
    this.files.delete(tempRel)
  }
  async backupIfExists(rel, backupRel) {
    this.calls.push(['backup', rel, backupRel])
    if (!this.files.has(rel)) return false
    this.files.set(backupRel, this.files.get(rel))
    return true
  }
  async append(rel, text) {
    this.calls.push(['append', rel, text])
    this.files.set(rel, (this.files.get(rel) ?? '') + text)
  }
  async exists(rel) { return this.files.has(rel) }
}

// ================================================================ 原子替换

test('W01 原子替换按 tmp → 回读 → 同目录 rename 顺序落盘，正式文件逐字节一致', async () => {
  const fs = new MemFs({ 'timeline/2026-11-19/records.json': 'old' })
  const text = buildRecordsText(DAY, [rec()])
  const result = await atomicReplace(fs, 'timeline/2026-11-19/records.json', text)
  assert.equal(result.ok, true)
  assert.equal(result.renamed, true)
  assert.equal(fs.files.get('timeline/2026-11-19/records.json'), text)
  const kinds = fs.calls.map((c) => c[0])
  assert.deepEqual(kinds, ['writeTemp', 'readTemp', 'rename'])
  // 断言没有先删正式文件的动作：MemFs 没有 unlink 接口，tmp 同名同目录。
  assert.equal(fs.calls[0][1], 'timeline/2026-11-19/records.json')
})

test('W02 回读被截断 → typed E_ATOMIC_WRITE，正式文件原样、rename 一次都没发生', async () => {
  const fs = new MemFs({ 'timeline/2026-11-19/records.json': 'ORIGINAL-BYTES' })
  fs.truncateReadback = 5
  await assert.rejects(
    async () => await atomicReplace(fs, 'timeline/2026-11-19/records.json', buildRecordsText(DAY, [rec()])),
    (error) => error.code === 'E_ATOMIC_WRITE' && error.message.includes('现场保留、正式文件未动'),
  )
  assert.equal(fs.files.get('timeline/2026-11-19/records.json'), 'ORIGINAL-BYTES')
  assert.equal(fs.calls.some((c) => c[0] === 'rename'), false)
  assert.equal(fs.files.has('timeline/2026-11-19/records.json.tmp-1'), true) // 现场保留
})

test('W03 回读等长但内容不同也判失败（逐字节而非仅比长度）', async () => {
  const fs = new MemFs({})
  fs.readTemp = async (tempRel) => 'x'.repeat((fs.files.get(tempRel) ?? '').length)
  await assert.rejects(
    async () => await atomicReplace(fs, 'timeline/2026-11-19/records.json', FRESH_SCHEMA_TEXT),
    (error) => error.code === 'E_ATOMIC_WRITE' && error.details.expectedBytes === error.details.actualBytes,
  )
})

test('W04 主 rename 失败 → 先备份原文件再回退 rename，备份路径随结果上报且保留现场', async () => {
  const fs = new MemFs({ 'timeline/2026-11-19/records.json': 'OLD' })
  fs.failPrimaryRenameFor.add('timeline/2026-11-19/records.json')
  const result = await atomicReplace(fs, 'timeline/2026-11-19/records.json', 'NEW')
  assert.equal(result.ok, true)
  assert.equal(result.backupKept, true)
  assert.match(result.backupPath, /^timeline\/2026-11-19\/records\.json\.bak-/)
  assert.equal(fs.files.get('timeline/2026-11-19/records.json'), 'NEW')
  assert.equal(fs.files.get(result.backupPath), 'OLD')
})

test('W05 回退 rename 也失败 → 从备份恢复原文件并抛 typed 错误', async () => {
  const fs = new MemFs({ 'timeline/2026-11-19/records.json': 'OLD' })
  fs.failPrimaryRenameFor.add('timeline/2026-11-19/records.json')
  fs.failFallbackRename = true
  await assert.rejects(
    async () => await atomicReplace(fs, 'timeline/2026-11-19/records.json', 'NEW'),
    (error) => error.code === 'E_ATOMIC_WRITE',
  )
  // 第三次 rename 把 backup 恢复回正式文件。
  assert.equal(fs.files.get('timeline/2026-11-19/records.json'), 'OLD')
})

// ================================================================ 追加式账本

test('W06 账本只追加：旧字节恒为新字节的严格前缀，历史行原序不变', async () => {
  const fs = new MemFs({})
  const rel = 'timeline/2026-11-19/deleted.jsonl'
  await appendDeleted(fs, DAY, [deletedLedgerLine('a1', T0930, T1600, 'i1')])
  const first = fs.files.get(rel)
  await appendDeleted(fs, DAY, [deletedLedgerLine('b2', T1000, T1600, 'i2')])
  const second = fs.files.get(rel)
  assert.equal(second.startsWith(first), true)
  assert.deepEqual(second.trim().split('\n').map((line) => JSON.parse(line).id), ['a1', 'b2'])
  // 纯函数版本给出同样结论。
  assert.deepEqual(mergeLedgerText(first, [deletedLedgerLine('c3', T1000, T1600, 'i3')], true).appended.length, 1)
})

test('W07 deleted 按 (id,ts,intentId) 去重；同 id/ts 不同 intentId 仍各自保留', async () => {
  const fs = new MemFs({})
  const rel = 'timeline/2026-11-19/deleted.jsonl'
  await appendDeleted(fs, DAY, [
    deletedLedgerLine('a1', T0930, T1600, 'i1'),
    deletedLedgerLine('a1', T0930, T1600, 'i1'), // 重复
    deletedLedgerLine('a1', T0930, T1600, 'i2'), // 不同意图，保留
  ])
  assert.equal(fs.files.get(rel).trim().split('\n').length, 2)
  const before = fs.files.get(rel)
  await appendDeleted(fs, DAY, [deletedLedgerLine('a1', T0930, T1600, 'i1')])
  assert.equal(fs.files.get(rel), before) // 重放不追加、不重写
})

test('W08 restore 按 (id,ts) 去重；冲突审计行按 (id,ts,dedupeKey) 去重', async () => {
  const fs = new MemFs({})
  const r1 = restoredLedgerLine('a1', T1000, T1000)
  await appendRestored(fs, DAY, [r1, r1])
  assert.equal(fs.files.get('timeline/2026-11-19/restore.jsonl').trim().split('\n').length, 1)
  const row = conflictRowOf('a1', T0930, canonicalRecordLine(rec({ body: '败者' })), T1000)
  await appendConflicts(fs, DAY, [row, row])
  const before = fs.files.get('timeline/2026-11-19/conflicts.jsonl')
  await appendConflicts(fs, DAY, [row])
  assert.equal(fs.files.get('timeline/2026-11-19/conflicts.jsonl'), before)
  const obj = JSON.parse(before.trim())
  assert.deepEqual(Object.keys(obj), ['id', 'ts', 'losingLine', 'decidedAt', 'dedupeKey'])
})

// ================================================================ summary newer-wins

test('W09 summary newer-wins：generatedAt 较新才替换，相等/更旧/坏文件都保留原字节', async () => {
  const fs = new MemFs({})
  const rel = 'timeline/2026-11-19/summary.json'
  const s100 = JSON.stringify({ generatedAt: 100, headline: 'old' })
  const s200 = JSON.stringify({ generatedAt: 200, headline: 'new' })
  await saveSummary(fs, DAY, s100)
  assert.equal(fs.files.get(rel), s100)
  const r1 = await saveSummary(fs, DAY, s200)
  assert.equal(r1.written, true)
  assert.equal(fs.files.get(rel), s200)
  const r2 = await saveSummary(fs, DAY, JSON.stringify({ generatedAt: 150 }))
  assert.equal(r2.written, false)
  assert.equal(fs.files.get(rel), s200)
  const r3 = await saveSummary(fs, DAY, s200)
  assert.equal(r3.written, false)
  assert.equal(fs.files.get(rel), s200)
  fs.files.set(rel, 'NOT JSON')
  const r4 = await saveSummary(fs, DAY, s200)
  assert.equal(r4.written, false)
  assert.equal(fs.files.get(rel), 'NOT JSON')
})

test('W10 非法 generatedAt 的 summary 拒绝写入（E_VALIDATION）', async () => {
  const fs = new MemFs({})
  const result = await saveSummary(fs, DAY, JSON.stringify({ headline: 'no ts' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_VALIDATION')
  assert.equal(fs.files.has('timeline/2026-11-19/summary.json'), false)
})

// ================================================================ 写计划（共享序列化器）

test('W11 planUpsert 产出字节与共享 buildRecordsText 完全一致（绑定决策 ②：无第二序列化器）', async () => {
  const plan = planUpsert(DAY, null, rec())
  assert.equal(plan.ok, true)
  assert.equal(plan.text, buildRecordsText(DAY, [rec()]))
  const parsed = parseTimelineDay(plan.text, DAY)
  assert.equal(parsed.day.allRecords.length, 1)
  assert.deepEqual(Object.keys(JSON.parse(canonicalLineOf(rec()))), [
    'id', 'ts', 'title', 'body', 'author', 'done', 'media', 'ai_processed', 'opened_at'
  ])
})

test('W12 planUpsert 替换同 id 全部旧版本；重新打开刷新 opened_at', async () => {
  const prior = buildRecordsText(DAY, [
    rec({ ts: T0930, closed_at: T1000 }),
    rec({ id: 'b2', ts: T0930 }),
  ])
  const plan = planUpsert(DAY, prior, rec({ ts: T1000, title: '重新打开' }))
  assert.equal(plan.ok, true)
  const records = parseTimelineDay(plan.text, DAY).day.allRecords
  assert.equal(records.length, 2)
  assert.equal(records.find((r) => r.id === 'a1').opened_at, T1000)
  assert.equal(records.find((r) => r.id === 'b2').opened_at, T0930)
})

test('W13 planRemove 物理移除全部版本行，重复移除幂等 no-op', async () => {
  const prior = buildRecordsText(DAY, [rec({ ts: T0930 }), rec({ ts: T1000 }), rec({ id: 'b2', ts: T0930 })])
  const plan = planRemove(DAY, prior, 'a1')
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.records.map((r) => r.id), ['b2'])
  const second = planRemove(DAY, plan.text, 'a1')
  assert.equal(second.text, plan.text)
})

test('W14 planUpsert 拒绝畸形 ts / 非法日期；isValidTsShape 只认秒级 ISO + 时区', async () => {
  assert.equal(planUpsert(DAY, null, rec({ ts: 'not-a-ts' })).ok, false)
  assert.equal(planUpsert('2026-13-99', null, rec()).ok, false)
  assert.equal(isValidTsShape(T0930), true)
  assert.equal(isValidTsShape('2026-11-19'), false)
  assert.equal(isValidTsShape('2026-11-19T09:30:00'), false)
})

test('W15 NodeTimelineFs 同目录 temp + 真实 rename（真实磁盘适配器冒烟）', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const p = await import('node:path')
  const root = await mkdtemp(p.join(os.tmpdir(), 'dsh-v2-fs-'))
  try {
    const fs = new NodeTimelineFs(root)
    const rel = 'timeline/2026-11-19/records.json'
    await fs.append(rel, '')
    const result = await atomicReplace(fs, rel, FRESH_SCHEMA_TEXT)
    assert.equal(result.ok, true)
    assert.equal(await readFile(p.join(root, rel), 'utf8'), FRESH_SCHEMA_TEXT)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
