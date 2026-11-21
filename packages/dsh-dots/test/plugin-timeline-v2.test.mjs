/**
 * `mod-plugin-git-store`（读 + 规范序列化半侧）：插件 v2 时间线与 App 逐字节对拍。
 *
 * 参考实现（只读，不改）：
 * - apps/arkui-schedule/entry/src/main/ets/model/timeline.ts
 * - apps/arkui-schedule/tools/test/{timelineRead,timelineWrite,twoDevice,syncProtocol,exportImportV2,contractGaps}.test.mjs
 * 被测对象（新模块，不碰 v1 `src/schedule/**`）：packages/dsh-dots/dist/timeline/index.js
 *
 * 每条用例上方中文注释说明它钉住的契约规则；字节 fixture 均**逐字复制**自 App 自己的测试，
 * 并在注释里标明来源文件与用例号。前置：`cd packages/dsh-dots; node scripts/build.mjs`。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  FRESH_SCHEMA_TEXT,
  assertTimelineDateKey,
  buildRecordsText,
  canonicalRecordLine,
  conflictRowsFromResolutions,
  conflictsLine,
  decideFreshStart,
  decidedAtFromTs,
  deletionState,
  freshDayText,
  isTimelineDateKey,
  openIdsOf,
  openRecords,
  parseLedger,
  parseSchemaMarker,
  parseTimelineDay,
  schemaRefusal,
  timelineConflictsPath,
  timelineDateFromRecordsPath,
  timelineDayPath,
  timelineDeletedPath,
  timelineMediaDir,
  timelineRecordsPath,
  timelineRestorePath,
  timelineSummaryPath,
  visibleRecords,
} from '../dist/timeline/index.js'

const DAY = '2026-11-19'
const T0930 = `${DAY}T09:30:00+08:00`
const T1000 = `${DAY}T10:00:00+08:00`
const T1400 = `${DAY}T14:00:00+08:00`
const T1600 = `${DAY}T16:00:00+08:00`
const T1700 = `${DAY}T17:00:00+08:00`
const SHA = 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789'

/** 造一条合法 v2 记录（与 App 测试同形）。 */
function rec(overrides = {}) {
  return {
    id: 'a1', ts: T0930, title: '标题', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: T0930, ...overrides
  }
}

/** 按契约 §3 的「一条一行」布局拼日文件（逐字来自 timelineRead.test.mjs:34-46）。 */
function dayFile(records, { date = DAY, open = [] } = {}) {
  const lines = [
    '{',
    `  "date": ${JSON.stringify(date)},`,
    `  "open": ${JSON.stringify(open)},`,
    '  "records": ['
  ]
  records.forEach((record, i) => {
    lines.push(`    ${canonicalRecordLine(record)}${i < records.length - 1 ? ',' : ''}`)
  })
  lines.push('  ]', '}')
  return `${lines.join('\n')}\n`
}

/** 把记录行直接塞进文件，用于注入坏行（逐字来自 timelineRead.test.mjs:49-59）。 */
function dayFileRaw(recordLines, { date = DAY, open = [] } = {}) {
  return [
    '{',
    `  "date": ${JSON.stringify(date)},`,
    `  "open": ${JSON.stringify(open)},`,
    '  "records": [',
    ...recordLines,
    '  ]',
    '}'
  ].join('\n') + '\n'
}

// ================================================================ 字节对拍（fixture 逐字取自 App 测试）

// 来源：apps/arkui-schedule/tools/test/timelineRead.test.mjs:62-63（测试 09 / 10 的 EXAMPLE_A / EXAMPLE_B）
const APP_EXAMPLE_A = '{"id":"m9x2k1-3fk","ts":"2026-11-19T09:30:00+08:00","title":"周会","body":"讨论同步方案","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"2026-11-19T09:30:00+08:00"}'
const APP_EXAMPLE_B = '{"id":"n0y3l2-8ab","ts":"2026-11-19T14:00:00+08:00","title":"体检","body":"","author":"我","done":true,"media":[{"file":"ab12cd34ef567890.jpg","sha256":"ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789","pageIndex":0}],"ocr_text":"体检单","ai_processed":true,"opened_at":"2026-11-19T14:00:00+08:00","closed_at":"2026-11-19T15:20:00+08:00"}'

// 来源：apps/arkui-schedule/tools/test/timelineWrite.test.mjs:69-91（测试 01 / 02 的对象 + 整文件期望）
const WRITE_EXAMPLE_A = {
  id: 'm9x2k1-3fk', ts: '2026-11-19T09:30:00+08:00', title: '周会', body: '讨论同步方案',
  author: '我', done: false, media: [], ai_processed: false, opened_at: '2026-11-19T09:30:00+08:00'
}
const WRITE_EXAMPLE_B = {
  id: 'n0y3l2-8ab', ts: '2026-11-19T14:00:00+08:00', title: '体检', body: '', author: '我',
  done: true, media: [{ file: 'ab12cd34ef567890.jpg', sha256: SHA, pageIndex: 0 }],
  ocr_text: '体检单', ai_processed: true, opened_at: '2026-11-19T14:00:00+08:00',
  closed_at: '2026-11-19T15:20:00+08:00'
}
const WRITE_EXAMPLE_TEXT = [
  '{',
  '  "date": "2026-11-19",',
  '  "open": ["m9x2k1-3fk"],',
  '  "records": [',
  `  ${APP_EXAMPLE_A},`,
  `  ${APP_EXAMPLE_B}`,
  '  ]',
  '}',
  ''
].join('\n')

// 规则：canonicalRecordLine 对同一记录输出必须逐字节等于 App 的 §3 示例（含乱序键归一）。
test('01 字节对拍：timelineRead.test.mjs 测试 09/10 的 §3 示例 A/B 字符串', () => {
  const a = {
    id: 'm9x2k1-3fk', ts: '2026-11-19T09:30:00+08:00', title: '周会', body: '讨论同步方案',
    author: '我', done: false, media: [], ai_processed: false, opened_at: '2026-11-19T09:30:00+08:00'
  }
  assert.equal(canonicalRecordLine(a), APP_EXAMPLE_A)
  const shuffled = {}
  for (const key of ['opened_at', 'ai_processed', 'media', 'done', 'author', 'body', 'title', 'ts', 'id']) {
    shuffled[key] = a[key]
  }
  assert.equal(canonicalRecordLine(shuffled), APP_EXAMPLE_A, '乱序输入规范化后仍须同字节')
  const b = {
    id: 'n0y3l2-8ab', ts: '2026-11-19T14:00:00+08:00', title: '体检', body: '', author: '我', done: true,
    media: [{ file: 'ab12cd34ef567890.jpg', sha256: SHA, pageIndex: 0 }],
    ocr_text: '体检单', ai_processed: true, opened_at: '2026-11-19T14:00:00+08:00',
    closed_at: '2026-11-19T15:20:00+08:00'
  }
  assert.equal(canonicalRecordLine(b), APP_EXAMPLE_B, '可选槽 + media + closed_at 的字节也必须一致')
})

// 规则：整份 records.json 的字节形状（顶层 date/open/records + 每记录一行 + 尾随一个换行）与 App 写模型一致。
test('02 字节对拍：timelineWrite.test.mjs 测试 01/02 的 LINE_A/LINE_B 与整文件 EXAMPLE_TEXT', () => {
  assert.equal(canonicalRecordLine(WRITE_EXAMPLE_A), APP_EXAMPLE_A)
  assert.equal(canonicalRecordLine(WRITE_EXAMPLE_B), APP_EXAMPLE_B)
  assert.equal(buildRecordsText(DAY, [WRITE_EXAMPLE_A, WRITE_EXAMPLE_B]), WRITE_EXAMPLE_TEXT)
})

// 规则：可选字段按契约槽位插入，未知扩展字段按插入顺序排在所有已知字段之后（timelineRead 测试 11）。
test('03 字节对拍：timelineRead.test.mjs 测试 11 的键序（可选槽 + 未知字段尾随）', () => {
  const record = rec({
    closed_at: T1400, ocr_time: T1000, ai_structured: '{}', ocr_text: 'ocr',
    zz: 2, aa: 1
  })
  const line = canonicalRecordLine(record)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'id', 'ts', 'title', 'body', 'author', 'done', 'media',
    'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at',
    'zz', 'aa'
  ])
  assert.ok(!/\s/.test(line.replace(/我|标题|ocr/g, '')), 'JSON 内部不得有多余空格')
})

// 规则：缺席的可选字段必须整个省略，不能写成 null / 空串（timelineRead 测试 12）。
test('04 字节对拍：timelineRead.test.mjs 测试 12 省略缺席可选字段', () => {
  const line = canonicalRecordLine(rec({ id: 'a1' }))
  for (const key of ['ocr_text', 'ai_structured', 'ocr_time', 'closed_at']) {
    assert.ok(!line.includes(`"${key}"`), `${key} 必须缺席`)
  }
})

// 规则：空日文本（buildRecordsText）与首用骨架（freshDayText）的字节也必须逐字等于 App。
test('05 字节对拍：timelineWrite.test.mjs 测试 06 的空日文件 + freshStart.ts 的 FRESH_SCHEMA_TEXT', () => {
  assert.equal(buildRecordsText(DAY, []), '{\n  "date": "2026-11-19",\n  "open": [],\n  "records": [\n  ]\n}\n')
  assert.equal(freshDayText(DAY), '{"date":"2026-11-19","open":[],"records":[]}\n')
  assert.equal(FRESH_SCHEMA_TEXT, '{"schemaVersion":2}\n')
})

// ================================================================ 解析对拍（同输入 → 同 parsed day）

// 规则：一条一行与 pretty JSON 两种形态必须解析成同一个 day（timelineRead 测试 01/02）。
test('06 解析对拍：timelineRead.test.mjs 测试 01/02 双形态解析一致', () => {
  const a = rec({ id: 'a1', title: '周会' })
  const b = rec({ id: 'b2', ts: T1400, title: '体检' })
  const oneLine = parseTimelineDay(dayFile([a, b]), DAY)
  assert.equal(oneLine.errors.length, 0)
  assert.equal(oneLine.day.date, DAY)
  assert.deepEqual(oneLine.day.allRecords.map((r) => r.id), ['a1', 'b2'])
  assert.equal(oneLine.day.allRecords[0].title, '周会')

  const pretty = `${JSON.stringify({ date: DAY, open: ['a1'], records: [a, b] }, null, 2)}\n`
  const prettyParsed = parseTimelineDay(pretty, DAY)
  assert.equal(prettyParsed.errors.length, 0, JSON.stringify(prettyParsed.errors))
  assert.equal(prettyParsed.day.allRecords.length, 2)
  assert.deepEqual(prettyParsed.day.open, ['a1'])
})

// 规则：坏 JSON 行 / 缺字段行 fail-soft（跳过并计数），合法行全保留（timelineRead 测试 03/04）。
test('07 解析对拍：timelineRead.test.mjs 测试 03/04 坏行与坏字段跳过计数', () => {
  const good = rec({ id: 'a1' })
  const badJson = dayFileRaw([
    `    ${canonicalRecordLine(good)},`,
    '    {this is not json},',
    `    ${canonicalRecordLine(rec({ id: 'b2', ts: T1400 }))}`
  ])
  const p1 = parseTimelineDay(badJson, DAY)
  assert.deepEqual(p1.day.allRecords.map((r) => r.id), ['a1', 'b2'])
  assert.equal(p1.errors.length, 1)
  assert.ok(p1.errors[0].line > 0)
  assert.match(p1.errors[0].message, /JSON/)

  const badFields = dayFileRaw([
    `    ${canonicalRecordLine(rec({ id: 'a1' }))},`,
    '    {"id":"bad","ts":"x","title":1},',
    '    {"id":"","ts":"x","title":"t","body":"","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"x"}'
  ])
  const p2 = parseTimelineDay(badFields, DAY)
  assert.equal(p2.day.allRecords.length, 1)
  assert.equal(p2.errors.length, 2)
  assert.ok(p2.errors.every((e) => e.line >= 1))
})

// 规则：空文本得空 day；完全无法识别的顶层返回 day=null + typed 错误（timelineRead 测试 05/06）。
test('08 解析对拍：timelineRead.test.mjs 测试 05/06 空文本与垃圾文本', () => {
  assert.deepEqual(parseTimelineDay('', DAY), {
    day: { date: DAY, open: [], allRecords: [] }, errors: [], resolutions: [], duplicates: 0
  })
  const garbage = parseTimelineDay('not json at all', DAY)
  assert.equal(garbage.day, null)
  assert.equal(garbage.errors.length, 1)
})

// 规则：date 字段与目录名不符时以目录名为权威并记一条错误；未知字段原样保留（timelineRead 测试 07/08）。
test('09 解析对拍：timelineRead.test.mjs 测试 07/08 目录日期权威 + 未知字段保留', () => {
  const mismatch = parseTimelineDay(dayFile([rec({ id: 'a1' })], { date: '2026-11-20' }), DAY)
  assert.equal(mismatch.day.date, DAY)
  assert.equal(mismatch.day.allRecords.length, 1)
  assert.equal(mismatch.errors.length, 1)
  assert.match(mismatch.errors[0].message, /2026-11-20/)
  assert.match(mismatch.errors[0].message, /2026-11-19/)

  const withUnknown = parseTimelineDay(dayFile([{ ...rec({ id: 'a1' }), x: 1 }]), DAY)
  assert.equal(withUnknown.day.allRecords[0].x, 1)
  assert.ok(canonicalRecordLine(withUnknown.day.allRecords[0]).endsWith(',"x":1}'))
})

// 规则：多 id 折叠报告（resolutions / duplicates）必须与 App 对拍，不同 ts 静默折叠不记审计（测试 39）。
test('10 解析对拍：timelineRead.test.mjs 测试 39 多 id 折叠报告可审计', () => {
  const text = dayFile([
    rec({ id: 'x', ts: T0930, body: 'A' }),
    rec({ id: 'x', ts: T0930, body: 'B' }),
    rec({ id: 'y', ts: T1400, body: 'same' }),
    rec({ id: 'y', ts: T1400, body: 'same' }),
    rec({ id: 'z', ts: T0930, body: 'old' }),
    rec({ id: 'z', ts: T1600, body: 'new' })
  ])
  const parsed = parseTimelineDay(text, DAY)
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id), ['x', 'y', 'z'])
  assert.equal(parsed.resolutions.length, 2)
  const byId = new Map(parsed.resolutions.map((r) => [r.id, r]))
  assert.equal(byId.get('x').reason, 'equal-ts-byte-order')
  assert.equal(byId.get('x').ts, T0930)
  assert.equal(byId.get('x').winner, canonicalRecordLine(rec({ id: 'x', ts: T0930, body: 'B' })))
  assert.deepEqual(byId.get('x').losers, [canonicalRecordLine(rec({ id: 'x', ts: T0930, body: 'A' }))])
  assert.equal(byId.get('y').reason, 'identical')
  assert.equal(parsed.duplicates, 1)
  assert.equal(byId.has('z'), false)
  assert.deepEqual(parseTimelineDay(text, DAY).resolutions, parsed.resolutions, '同输入必须确定性')
})

// 规则：同 (id,ts) 取规范行 UTF-8 字节较大者胜，且与出现顺序无关（timelineRead 测试 25/26/27）。
test('11 解析对拍：timelineRead.test.mjs 测试 25/26/27 同 ts 字节序裁决与 identical 折叠', () => {
  const forward = parseTimelineDay(dayFile([
    rec({ id: 'a1', ts: T0930, body: 'A' }), rec({ id: 'a1', ts: T0930, body: 'B' })
  ]), DAY)
  const backward = parseTimelineDay(dayFile([
    rec({ id: 'a1', ts: T0930, body: 'B' }), rec({ id: 'a1', ts: T0930, body: 'A' })
  ]), DAY)
  assert.equal(forward.day.allRecords[0].body, 'B')
  assert.equal(backward.day.allRecords[0].body, 'B')
  assert.equal(forward.resolutions[0].reason, 'equal-ts-byte-order')
  assert.equal(forward.duplicates, 0)
  const row = rec({ id: 'a1', ts: T0930, body: 'same' })
  const identical = parseTimelineDay(dayFile([row, { ...row }]), DAY)
  assert.equal(identical.day.allRecords.length, 1)
  assert.equal(identical.resolutions[0].reason, 'identical')
  assert.equal(identical.duplicates, 1)
})

// 规则：ts 判等是「有意超集」——同刻不同字节写法（+08:00 vs Z）也走 §4 字节序裁决（测试 44）。
test('12 解析对拍：timelineRead.test.mjs 测试 44 同刻不同字节 ts 的裁决超集', () => {
  const plus08 = rec({ id: 'a1', ts: T0930, body: 'A' })
  const zulu = rec({ id: 'a1', ts: `${DAY}T01:30:00Z`, body: 'B' })
  const parsed = parseTimelineDay(dayFile([plus08, zulu]), DAY)
  assert.equal(parsed.day.allRecords.length, 1)
  assert.equal(parsed.day.allRecords[0].body, 'A')
  assert.equal(parsed.day.allRecords[0].ts, T0930)
  assert.equal(parsed.resolutions.length, 1)
  assert.equal(parsed.resolutions[0].reason, 'equal-ts-byte-order')
  assert.deepEqual(parsed.resolutions[0].losers, [canonicalRecordLine(zulu)])
})

// 规则：records[] 里的标量元素跳过并计数，不静默丢弃（timelineRead 测试 41）。
test('13 解析对拍：timelineRead.test.mjs 测试 41 标量元素跳过并计数', () => {
  const text = dayFileRaw([
    `    ${canonicalRecordLine(rec({ id: 'a1' }))},`,
    '    42,',
    '    "oops",',
    '    null,',
    '    true,',
    '    [1,2]'
  ])
  const parsed = parseTimelineDay(text, DAY)
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id), ['a1'])
  assert.equal(parsed.errors.length, 5)
  assert.ok(parsed.errors.every((e) => /非对象元素/.test(e.message)))
  assert.ok(parsed.errors.every((e) => e.line >= 1))
})

// 规则：media[].file 必须是裸 <hex16>.jpg，sha256 必须 64 位小写 hex；坏项丢弃但记录保留（测试 28/29/42）。
test('14 解析对拍：timelineRead.test.mjs 测试 28/29/42 媒体裸名与 sha256 校验', () => {
  const valid = parseTimelineDay(dayFile([rec({
    id: 'a1', media: [{ file: 'ab12cd34ef567890.jpg', sha256: SHA, pageIndex: 2 }]
  })]), DAY)
  assert.equal(valid.errors.length, 0)
  assert.equal(valid.day.allRecords[0].media[0].pageIndex, 2)

  for (const file of ['media/x.jpg', '../x.jpg', 'C:/x.jpg', 'ab.jpg']) {
    const parsed = parseTimelineDay(dayFile([rec({
      id: 'a1', media: [{ file, sha256: SHA, pageIndex: 0 }]
    })]), DAY)
    assert.equal(parsed.day.allRecords.length, 1, `记录必须保留：${file}`)
    assert.equal(parsed.day.allRecords[0].media.length, 0, `坏媒体必须丢弃：${file}`)
    assert.equal(parsed.errors.length, 1)
    assert.match(parsed.errors[0].message, /裸文件名/)
  }
  for (const bad of ['not-hex-!!', SHA.toUpperCase(), SHA.slice(1), `${SHA}0`]) {
    const parsed = parseTimelineDay(dayFile([rec({
      id: 'a1', media: [{ file: 'ab12cd34ef567890.jpg', sha256: bad, pageIndex: 0 }]
    })]), DAY)
    assert.equal(parsed.day.allRecords.length, 1, `记录必须保留：${bad}`)
    assert.equal(parsed.day.allRecords[0].media.length, 0)
    assert.match(parsed.errors[0].message, /64 位小写十六进制/)
  }
})

// ================================================================ open / 账本 / schema 对拍

// 规则：open 谓词只看 closed_at 缺省（空 / 空白 / null），忽略 done 与陈旧 day.open（测试 13/14/43）。
test('15 open 谓词对拍：timelineRead.test.mjs 测试 13/14/43 closed_at 缺省即未完成', () => {
  const day = {
    date: DAY, open: ['ghost'], allRecords: [
      rec({ id: 'missing' }),
      rec({ id: 'empty', closed_at: '' }),
      rec({ id: 'ws', closed_at: '   ' }),
      rec({ id: 'null', closed_at: null }),
      rec({ id: 'set', closed_at: T1600 })
    ]
  }
  assert.deepEqual(openRecords(day, [], []).map((r) => r.id), ['missing', 'empty', 'ws', 'null'])
  assert.deepEqual(openIdsOf(day.allRecords), ['missing', 'empty', 'ws', 'null'])
})

// 规则：账本先过滤再算 open；D<R 可见、D=R 删除胜；漏传 restore 等于关闭过滤（测试 16/19/23/40）。
test('16 账本对拍：timelineRead.test.mjs 测试 16/19/23/40 删除与撤销优先级', () => {
  const text = [
    JSON.stringify({ id: 'a1', ts: T1600, deletedAt: T1600, intentId: 'i1' }),
    JSON.stringify({ id: 'a1', ts: T1700, restoredAt: T1700 })
  ].join('\n') + '\n'
  const parsed = parseLedger(text)
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[0].deletedAt, T1600)
  assert.equal(parsed.entries[1].restoredAt, T1700)

  const day = { date: DAY, open: [], allRecords: [rec({ id: 'a1' }), rec({ id: 'b2', ts: T1400, closed_at: T1600 })] }
  const del = [{ id: 'a1', ts: T1600 }]
  assert.equal(deletionState('a1', del, [{ id: 'a1', ts: T1600 }]), 'deleted', 'D=R 删除胜')
  assert.equal(deletionState('a1', del, [{ id: 'a1', ts: T1700 }]), 'visible', 'R>D 复活')
  assert.deepEqual(visibleRecords(day, del, []).map((r) => r.id), ['b2'])
  assert.deepEqual(visibleRecords(day, del, [{ id: 'a1', ts: T1600 }]).map((r) => r.id), ['b2'])
  assert.deepEqual(visibleRecords(day, del, [{ id: 'a1', ts: T1700 }]).map((r) => r.id), ['a1', 'b2'])
  assert.deepEqual(openRecords(day, del, [{ id: 'a1', ts: T1700 }]).map((r) => r.id), ['a1'])
  // allRecords 保留被删行，裸读会「复活」——只有统一入口才是展示路径
  assert.equal(day.allRecords.some((r) => r.id === 'a1'), true)
})

// 规则：schema 标记只认 2；缺标记 = fresh start 不拒绝；存在但不可识别 = typed 只读拒绝（§11）。
test('17 schema 门槛对拍：timelineRead.test.mjs 测试 31-33 + freshStart.decideFreshStart', () => {
  assert.deepEqual(parseSchemaMarker('{"schemaVersion":2}'), { ok: true, version: 2, reason: '' })
  assert.equal(parseSchemaMarker('{"schemaVersion":2,"migratedAt":"x","source":"v1"}').ok, true)
  const v3 = parseSchemaMarker('{"schemaVersion":3}')
  assert.equal(v3.ok, false)
  assert.equal(v3.version, 3)
  assert.match(v3.reason, /3/)
  const missing = parseSchemaMarker('{}')
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /缺少/)
  const wrongType = parseSchemaMarker('{"schemaVersion":"2"}')
  assert.equal(wrongType.ok, false)
  assert.match(wrongType.reason, /数字/)

  assert.deepEqual(decideFreshStart(''), { needSchema: true, unsupported: false, code: '', reason: '' })
  assert.deepEqual(schemaRefusal('  '), { ok: true, code: '', version: null, reason: '' })
  assert.equal(decideFreshStart('{"schemaVersion":2}').unsupported, false)
  const unknown = decideFreshStart('{"schemaVersion":99}')
  assert.equal(unknown.unsupported, true)
  assert.equal(unknown.code, 'E_SCHEMA_UNKNOWN')
  const corrupt = decideFreshStart('{bad json')
  assert.equal(corrupt.unsupported, true)
  assert.equal(corrupt.code, 'E_CORRUPT')
})

// 规则：冲突审计行键序与 dedupeKey 必须与 App `conflictsLine` 一致（syncProtocol 测试 18/19）。
test('18 冲突审计行对拍：syncProtocol.test.mjs 测试 18 的 dedupeKey = sha256(losingLine)', () => {
  const losing = canonicalRecordLine(rec())
  const row = conflictsLine('a1', T0930, losing, '2026-11-19T01:30:00.000Z')
  const parsed = JSON.parse(row)
  assert.deepEqual(Object.keys(parsed), ['id', 'ts', 'losingLine', 'decidedAt', 'dedupeKey'])
  assert.equal(parsed.id, 'a1')
  assert.equal(parsed.ts, T0930)
  assert.equal(parsed.losingLine, losing)
  assert.equal(parsed.dedupeKey, createHash('sha256').update(losing, 'utf8').digest('hex'))
  assert.equal(row.split('\n').length, 1)
  assert.equal(decidedAtFromTs(T0930), '2026-11-19T01:30:00.000Z')
  assert.equal(decidedAtFromTs('not-a-ts'), 'not-a-ts', '不可解析时退回原文，绝不读墙钟')

  const folded = parseTimelineDay(dayFile([
    rec({ id: 'tie', ts: T1000, body: 'a' }), rec({ id: 'tie', ts: T1000, body: 'z' })
  ]), DAY)
  const rows = conflictRowsFromResolutions(folded.resolutions)
  assert.equal(rows.length, 1, 'identical 折叠不产审计行')
  assert.equal(JSON.parse(rows[0]).losingLine, canonicalRecordLine(rec({ id: 'tie', ts: T1000, body: 'a' })))
})

// ================================================================ 往返稳定 / 确定性

// 规则：parse(serialise(parse(x))) 必须逐字节稳定，未知字段与 open 派生也不漂移。
test('19 往返稳定：parse(serialise(parse(x))) 逐字节与原输入相等', () => {
  const media = { file: 'ab12cd34ef567890.jpg', sha256: SHA, pageIndex: 0 }
  const original = buildRecordsText(DAY, [
    rec({ id: 'x', ts: T0930, x: 1 }),
    rec({ id: 'y', ts: T1400, media: [media], closed_at: T1600 })
  ])
  assert.notEqual(original, '')
  const p1 = parseTimelineDay(original, DAY)
  const serialised = buildRecordsText(p1.day.date, p1.day.allRecords)
  const p2 = parseTimelineDay(serialised, DAY)
  assert.equal(serialised, original)
  assert.deepEqual(p2, p1)
  assert.deepEqual(p2.day.open, ['x'])
  assert.equal(p2.day.allRecords[0].x, 1)
})

// 规则：同输入两次调用字节/对象全等，且不改写入参（App timelineRead 测试 36 的确定性口径）。
test('20 确定性：同输入两次字节相等、不改入参', () => {
  const records = [rec({ id: 'b', ts: T1400 }), rec({ id: 'a' })]
  const snapshot = JSON.stringify(records)
  assert.equal(buildRecordsText(DAY, records), buildRecordsText(DAY, records))
  const line = canonicalRecordLine(records[0])
  assert.equal(line, canonicalRecordLine(records[0]))
  const text = buildRecordsText(DAY, records)
  assert.deepEqual(parseTimelineDay(text, DAY), parseTimelineDay(text, DAY))
  assert.equal(JSON.stringify(records), snapshot)
})

// ================================================================ 路径（只读，不 fs）

// 规则：v2 路径只落在 timeline/**，日期键是真实日历日；v1 devices/** 路径不参与（§2）。
test('21 路径：timeline 布局 + 严格日历日校验 + 读侧反解', () => {
  assert.equal(timelineDayPath('2026-11-19'), 'timeline/2026-11-19/records.json', '与 App 测试 34 同形')
  assert.equal(timelineRecordsPath('2026-01-02'), 'timeline/2026-01-02/records.json')
  assert.equal(timelineDeletedPath(DAY), 'timeline/2026-11-19/deleted.jsonl')
  assert.equal(timelineRestorePath(DAY), 'timeline/2026-11-19/restore.jsonl')
  assert.equal(timelineConflictsPath(DAY), 'timeline/2026-11-19/conflicts.jsonl')
  assert.equal(timelineSummaryPath(DAY), 'timeline/2026-11-19/summary.json')
  assert.equal(timelineMediaDir(DAY), 'timeline/2026-11-19/media')
  assert.equal(timelineDateFromRecordsPath('timeline/2026-11-19/records.json'), DAY)
  assert.equal(timelineDateFromRecordsPath('devices/d1/schedules/2026-11-19.jsonl'), null)
  assert.equal(timelineDateFromRecordsPath('timeline/2026-13-99/records.json'), null)
  assert.equal(isTimelineDateKey('2024-02-29'), true)
  assert.equal(isTimelineDateKey('2026-02-30'), false)
  assert.equal(isTimelineDateKey('2026/11/19'), false)
  assert.throws(() => assertTimelineDateKey('2026-13-99'), /合法日历日/)
})

// ================================================================ v1 → v2 四个分歧（审计 PLUGIN-GAPS §3）

// 分歧① 字段顺序：v1 把 ocr_text 放在 author 之前且用 attachments；v2 键序由契约 §3 固定。
test('22 分歧① 字段顺序：v2 键序与 App 一致，不是 v1 的 ocr_text 在前', () => {
  // 造一条含全部可选槽的记录，才能逐位比较完整 v2 键序（缺席的可选字段按规则 04 会被省略）
  const line = canonicalRecordLine(rec({
    ocr_text: 'OCR', ai_structured: '{}', ocr_time: T1000, closed_at: T1600
  }))
  const keys = Object.keys(JSON.parse(line))
  const v2 = ['id', 'ts', 'title', 'body', 'author', 'done', 'media',
    'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'closed_at']
  const v1 = ['id', 'ts', 'title', 'body', 'ocr_text', 'author', 'done',
    'attachments', 'ai_structured', 'ai_processed', 'ocr_time']
  assert.deepEqual(keys, v2, '必须严格按 v2 键序')
  assert.notDeepEqual(keys, v1)
  assert.ok(keys.indexOf('author') < keys.indexOf('ocr_text'), 'v2 author 在 ocr_text 之前（v1 相反）')
  assert.equal(keys.includes('opened_at'), true)
  assert.equal(keys.includes('closed_at'), true)
})

// 分歧② attachments vs media：v2 只认 media[]；attachments 只是未知字段尾随，不能替代 media。
test('23 分歧② attachments → media：没有 media 的 v1 行在 v2 自检被拒', () => {
  const v1Row = {
    id: 'a1', ts: T0930, title: 'v1', body: '', ocr_text: 'OCR', author: '我', done: false,
    attachments: [{ sha256: 'ab12', name: 'ab12.png', pageIndex: 0 }],
    ai_processed: false, ocr_time: T1000
  }
  assert.equal(buildRecordsText(DAY, [v1Row]), '', 'v1 行缺 media → fail-closed，不产出字节')
  const withBoth = buildRecordsText(DAY, [rec({ media: [], attachments: v1Row.attachments })])
  assert.notEqual(withBoth, '')
  const parsed = parseTimelineDay(withBoth, DAY)
  assert.deepEqual(parsed.day.allRecords[0].media, [], 'media 才是唯一媒体字段')
  assert.equal(parsed.day.allRecords[0].attachments.length, 1, 'attachments 作为未知字段原样保留')
  const line = canonicalRecordLine(parsed.day.allRecords[0])
  assert.ok(line.includes(',"attachments":'), 'attachments 必须排在已知字段之后')
})

// 分歧③ done vs closed_at：v1 按 done 分未完成；v2 只认 closed_at，done:true 也可能未完成。
test('24 分歧③ done → closed_at：done:true 无 closed_at 仍是 open，done:false 有 closed_at 不是 open', () => {
  const day = { date: DAY, open: [], allRecords: [
    rec({ id: 'done-no-closed', done: true }),
    rec({ id: 'not-done-with-closed', done: false, closed_at: T1600 })
  ] }
  assert.deepEqual(openRecords(day, [], []).map((r) => r.id), ['done-no-closed'])
  assert.deepEqual(openIdsOf(day.allRecords), ['done-no-closed'])
  const text = buildRecordsText(DAY, day.allRecords)
  assert.deepEqual(parseTimelineDay(text, DAY).day.open, ['done-no-closed'], '写侧 open 也由 closed_at 派生')
})

// 分歧④ 一行一对象 vs 整文件：v1 JSONL 顶层不是 JSON 对象，v2 是 date/open/records 整文件。
test('25 分歧④ JSONL → records.json：v1 文件被拒、v2 整文件被接受', () => {
  const v1Jsonl = `${canonicalRecordLine(rec({ id: 'a1' }))}\n${canonicalRecordLine(rec({ id: 'b2', ts: T1400 }))}\n`
  const rejected = parseTimelineDay(v1Jsonl, DAY)
  assert.equal(rejected.day, null, '两行裸对象不是合法 v2 顶层')
  assert.equal(rejected.errors.length, 1)
  assert.match(rejected.errors[0].message, /顶层/)

  const v2Text = buildRecordsText(DAY, [rec({ id: 'a1' }), rec({ id: 'b2', ts: T1400 })])
  assert.ok(v2Text.startsWith('{\n  "date": "2026-11-19",\n  "open": '))
  const accepted = parseTimelineDay(v2Text, DAY)
  assert.equal(accepted.errors.length, 0)
  assert.deepEqual(accepted.day.allRecords.map((r) => r.id), ['a1', 'b2'])
  assert.match(timelineRecordsPath(DAY), /^timeline\//)
  assert.equal(timelineRecordsPath(DAY).includes('devices/'), false, '路径也不得是 v1 设备命名空间')
})

// ================================================================ [M3] 逐行 decidedAt 回归

// 规则：App `apps/arkui-schedule/entry/src/main/ets/model/syncProtocol.ts:595-596` 在 addConflict 内
// 对每条冲突调用 `conflictsLine(id, ts, losingLine, decidedAtOf(ts, now))`；调用点 :641 传入的是
// **败者自己的 loser.ts**。故同一天多个时刻的冲突必须各自带不同的 decidedAt（由各自 ts 转换），
// 不可给整批盖一个值。decidedAtOf（:294-300）= 可解析 ts → new Date(ms).toISOString()，否则原文退回。
test('26 逐行 decidedAt：多时刻冲突各用败者自己的 ts 换算，精确钉住期望字符串', () => {
  const BAD_TS = 'not-a-ts'
  const text = dayFile([
    rec({ id: 'tie1', ts: T0930, body: 'a' }), rec({ id: 'tie1', ts: T0930, body: 'z' }),
    rec({ id: 'tie2', ts: T1400, body: 'a' }), rec({ id: 'tie2', ts: T1400, body: 'z' }),
    rec({ id: 'tie3', ts: BAD_TS, body: 'a' }), rec({ id: 'tie3', ts: BAD_TS, body: 'z' })
  ])
  const folded = parseTimelineDay(text, DAY)
  assert.equal(folded.resolutions.length, 3)
  const rows = conflictRowsFromResolutions(folded.resolutions)
  assert.equal(rows.length, 3)

  // 败者规范行（body='a' 是字节较小者，必为 loser）；逐行 ts / decidedAt 全部精确断言。
  const loserA = (id, ts) => canonicalRecordLine(rec({ id, ts, body: 'a' }))
  const expected = [
    { id: 'tie1', ts: T0930, at: '2026-11-19T01:30:00.000Z' }, // 09:30+08:00 → 01:30Z
    { id: 'tie2', ts: T1400, at: '2026-11-19T06:00:00.000Z' }, // 14:00+08:00 → 06:00Z
    { id: 'tie3', ts: BAD_TS, at: BAD_TS }                      // 不可解析 → 原文退回（app :300）
  ]
  rows.forEach((row, i) => {
    const want = expected[i]
    assert.equal(row, conflictsLine(want.id, want.ts, loserA(want.id, want.ts), want.at),
      `第 ${i + 1} 行必须与 App :596 的逐行产物逐字节相同`)
    const obj = JSON.parse(row)
    assert.equal(obj.ts, want.ts, '每行的 ts 必须是败者自己的 ts（app :641）')
    assert.equal(obj.decidedAt, want.at, '每行的 decidedAt 必须由本行 ts 换算（app :595-596）')
  })
  const decided = rows.map((row) => JSON.parse(row).decidedAt)
  assert.deepEqual(decided, [
    '2026-11-19T01:30:00.000Z', '2026-11-19T06:00:00.000Z', 'not-a-ts'
  ])
  assert.equal(new Set(decided.slice(0, 2)).size, 2, '两个不同时刻必须产生两个不同的 decidedAt')
  assert.equal(decidedAtFromTs(T1400), '2026-11-19T06:00:00.000Z', '与 App decidedAtOf 的转换同值')
})
