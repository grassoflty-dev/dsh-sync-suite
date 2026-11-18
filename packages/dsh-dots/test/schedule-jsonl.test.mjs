/**
 * 日程桥纯逻辑测试：JSONL 契约、折叠、id/ts 与 App 对齐、路径越界、AI 载荷。
 *
 * 参考实现是 App 的 `entry/src/main/ets/model/jsonl.ts` 与 `common/date.ts`；
 * 这里断言的是"两端同形"，不是另起一套规则。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendRecord,
  encodeRecord,
  foldById,
  parseJsonl,
  recordDateKey,
  sortRecords,
} from '../dist/schedule/jsonl.js'
import { formatClock, localDateKey, newRecordId, nextTsSameDate, nowIso } from '../dist/schedule/clock.js'
import {
  assertDateKey,
  assertDeviceId,
  assertSchedulesScope,
  resolveInsideRepo,
  scheduleRelPath,
} from '../dist/schedule/paths.js'
import { buildAiPayload, buildAiPrompt, buildDaySummaryPayload } from '../dist/schedule/aiPayload.js'
import { buildAiRequest, classifyAiError, parseAiReply } from '../dist/schedule/aiRequest.js'
import { sealToolSchema } from '../dist/schedule/tools.js'

/** 平板侧写的一行（带扩展字段与附件，PC 必须原样读得懂）。 */
const TABLET_ROW = {
  id: 'pad-row-1',
  ts: '2026-11-15T09:30:00+08:00',
  title: '平板记录',
  body: '手写内容一',
  ocr_text: '原始 OCR',
  author: '我',
  done: false,
  attachments: [{ sha256: 'ab12', name: 'ab12.png', pageIndex: 0 }],
  ai_processed: false,
  ocr_time: '2026-11-15T09:31:12+08:00',
  mood: 'happy',
}

test('clock：newRecordId 与 App 同形（base36 时间戳 + 随机后缀），nowIso 带本地时区偏移', () => {
  const now = new Date('2026-11-15T21:45:27+08:00')
  const id = newRecordId(now)
  // App：`${Date.now().toString(36)}-${Math.floor(Math.random()*1679615).toString(36)}`
  assert.match(id, /^[0-9a-z]+-[0-9a-z]{1,4}$/)
  assert.equal(id.split('-')[0], now.getTime().toString(36), 'id 前缀必须是毫秒时间戳的 base36')
  assert.notEqual(newRecordId(now), id, '随机后缀必须让同一毫秒的两个 id 不同')
  assert.equal(id.length <= 16, true)

  // App 的 nowIso：秒级、带本地偏移、没有毫秒与 Z
  const iso = nowIso(now)
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  assert.equal(iso.includes('Z'), false)
  assert.equal(iso.includes('.'), false)
  assert.equal(iso.slice(0, 10), localDateKey(now))
  // 与 App 的算法逐字段一致（本地时区由运行环境决定，这里比对同一 Date 的分量）
  const pad = (n) => String(n).padStart(2, '0')
  const expectedClock = `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  assert.ok(iso.includes(expectedClock), `nowIso 的时钟部分应与本地时间一致：${iso}`)
})

test('clock：nextTsSameDate 保留原记录日期且严格大于原 ts', () => {
  const original = '2026-11-15T09:30:00+08:00'
  const later = nextTsSameDate(original, new Date('2026-11-16T10:00:00+08:00'))
  assert.equal(later.slice(0, 10), '2026-11-15', '记录不能被迁到别的日期文件')
  assert.ok(Date.parse(later) > Date.parse(original), '新版本 ts 必须更晚，foldById 才能取到它')
  assert.equal(formatClock('2026-11-15T09:30:00+08:00'), '09:30')
})

test('jsonl：编码字段顺序与契约一致，同一条记录永远产出同一行', () => {
  const line = encodeRecord({
    id: 'x-1',
    ts: '2026-11-15T09:30:00+08:00',
    title: '标题',
    body: '正文',
    author: '我',
    done: false,
    ai_processed: false,
  })
  assert.ok(line.endsWith('\n'))
  // DATA-CONTRACT §3 的字段顺序：id, ts, title, body, author, done, ai_processed
  assert.deepEqual(Object.keys(JSON.parse(line)), ['id', 'ts', 'title', 'body', 'author', 'done', 'ai_processed'])
  assert.equal(
    line,
    encodeRecord({ id: 'x-1', ts: '2026-11-15T09:30:00+08:00', title: '标题', body: '正文', author: '我', done: false, ai_processed: false }),
  )
})

test('jsonl：能读平板写入的行（含扩展字段不报错），坏行只记 error 不中断', () => {
  const text = `${JSON.stringify(TABLET_ROW)}\nnot-json\n${JSON.stringify({ id: '', ts: '', title: 1 })}\n`
  const parsed = parseJsonl(text)
  assert.equal(parsed.records.length, 1)
  assert.equal(parsed.errors.length, 2, '坏 JSON + 字段不合法各记一条')
  const record = parsed.records[0]
  assert.equal(record.mood, 'happy', '未知扩展字段必须原样保留')
  assert.equal(record.ocr_text, '原始 OCR')
  assert.equal(record.attachments.length, 1)
  assert.deepEqual(parsed.errors.map((item) => item.line), [2, 3])
})

test('jsonl：appendRecord 逐字节保留历史行，只追加一条', () => {
  const base = `${JSON.stringify(TABLET_ROW)}\n`
  const next = {
    id: 'pc-1',
    ts: '2026-11-15T10:00:00+08:00',
    title: 'PC 新建',
    body: '',
    author: '我',
    done: false,
    ai_processed: false,
  }
  const appended = appendRecord(base, next)
  assert.ok(appended.startsWith(base), '历史字节必须原样保留（只追加，不重写）')
  assert.equal(appended.length, base.length + encodeRecord(next).length)
  assert.equal(appended.trimEnd().split('\n').length, 2)
  // 末尾没有换行的文件也只补一个换行
  const noNewline = appendRecord(base.trimEnd(), next)
  assert.ok(noNewline.startsWith(base.trimEnd()))
  assert.equal(noNewline.trimEnd().split('\n').length, 2)
})

test('jsonl：foldById 同 id 取较晚 ts，不同 id 全保留且按 ts 升序', () => {
  const older = { ...TABLET_ROW, ts: '2026-11-15T09:30:00+08:00', title: '旧标题' }
  const newer = { ...TABLET_ROW, ts: '2026-11-15T11:00:00+08:00', title: '新标题' }
  const other = { ...TABLET_ROW, id: 'pad-row-2', ts: '2026-11-15T08:00:00+08:00', title: '更早' }
  const folded = foldById([newer, other, older])
  assert.equal(folded.length, 2)
  const byId = new Map(folded.map((record) => [record.id, record]))
  assert.equal(byId.get('pad-row-1').title, '新标题', '同 id 必须取较晚 ts 的那条')
  assert.equal(byId.get('pad-row-2').title, '更早')
  const sorted = sortRecords([newer, other, older])
  assert.deepEqual(sorted.map((record) => record.ts), [
    '2026-11-15T08:00:00+08:00',
    '2026-11-15T09:30:00+08:00',
    '2026-11-15T11:00:00+08:00',
  ])
})

test('paths：只允许 devices/<deviceId>/schedules/<date>.jsonl，越界一律拒绝', () => {
  assert.equal(scheduleRelPath('pc-a', '2026-11-15'), 'devices/pc-a/schedules/2026-11-15.jsonl')
  // 非法 deviceId：路径分隔符、上跳、大写、空串
  for (const bad of ['../evil', 'a/b', 'a\\b', 'PC-A', '', 'pad/../x', '-lead']) {
    assert.throws(() => assertDeviceId(bad), /E_VALIDATION|deviceId/, `应拒绝 deviceId=${JSON.stringify(bad)}`)
    assert.throws(() => scheduleRelPath(bad, '2026-11-15'))
  }
  // 非法日期：形状不对、日历上不存在
  for (const bad of ['2026-1-5', '2026/11/15', '2026-13-01', '2026-02-31', '', '20261115']) {
    assert.throws(() => assertDateKey(bad), /E_VALIDATION|日期/, `应拒绝 date=${JSON.stringify(bad)}`)
  }
  assert.equal(assertDateKey('2026-02-28'), '2026-02-28')

  // 仓库内相对路径：逃出仓库根一律拒绝
  const repoDir = process.platform === 'win32' ? 'C:\\repo' : '/repo'
  assert.throws(() => resolveInsideRepo(repoDir, '../evil.jsonl'), /E_VALIDATION|越界/)
  assert.throws(() => resolveInsideRepo(repoDir, 'devices/../../evil.jsonl'), /E_VALIDATION|越界/)
  assert.ok(resolveInsideRepo(repoDir, 'devices/pc-a/schedules/2026-11-15.jsonl').includes('schedules'))

  // 写入范围：别的设备目录、summaries/、.. 全部拒绝
  assert.doesNotThrow(() => assertSchedulesScope('pc-a', 'devices/pc-a/schedules/2026-11-15.jsonl'))
  assert.throws(() => assertSchedulesScope('pc-a', 'devices/pad-1/schedules/2026-11-15.jsonl'), /只允许写/)
  assert.throws(() => assertSchedulesScope('pc-a', 'devices/pc-a/summaries/2026-11-15.json'), /只允许写/)
  assert.throws(() => assertSchedulesScope('pc-a', 'devices/pc-a/schedules/../schedules/x.jsonl'), /不得包含 \.\./)
  assert.throws(() => assertSchedulesScope('pc-a', 'devices/pc-a/schedules'), /不允许直接写/)
})

test('aiPayload：每日汇总全量载荷（含已处理记录），text 优先 body、为空退回 ocr_text', () => {
  const records = [
    { ...TABLET_ROW, id: 'a', body: '正文命中', ocr_text: 'OCR 不该用', ai_processed: true },
    { ...TABLET_ROW, id: 'b', body: '   ', ocr_text: 'OCR 兜底', ai_processed: false },
    { ...TABLET_ROW, id: 'c', ts: '2026-11-16T09:00:00+08:00' },
  ]
  const full = buildDaySummaryPayload('2026-11-15', records)
  assert.deepEqual(full.records.map((item) => item.id), ['a', 'b'], '跨天记录不进入当天载荷')
  assert.equal(full.records[0].text, '正文命中')
  assert.equal(full.records[1].text, 'OCR 兜底')
  assert.equal(full.records[0].ocr_time, '2026-11-15T09:31:12+08:00')

  const incremental = buildAiPayload('2026-11-15', records)
  assert.deepEqual(incremental.records.map((item) => item.id), ['b'], '增量载荷只取 ai_processed=false')

  const prompt = buildAiPrompt(full, '2026-11-15T21:45:27+08:00', 'Asia/Shanghai')
  assert.ok(prompt.includes('当前时间：2026-11-15T21:45:27+08:00'))
  assert.ok(prompt.includes('时区：Asia/Shanghai'))
  assert.ok(prompt.includes('记录日期：2026-11-15'))
  assert.ok(prompt.includes('记录条数：2'))
  assert.ok(prompt.includes('### 记录 1'))
  assert.ok(buildAiPrompt({ date: '2026-11-15', records: [] }, '2026-11-15T21:45:27+08:00', 'Asia/Shanghai').includes('当天没有需要整理的记录'))
  assert.equal(recordDateKey('2026-11-15T23:30:00+08:00'), '2026-11-15')
})

test('aiRequest：端点拼接/请求体/错误文案/回复解析（不联网）', () => {
  const request = buildAiRequest('https://api.deepseek.com/', 'deepseek-chat', '提示词', 2000, '系统')
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions')
  const body = JSON.parse(request.body)
  assert.equal(body.model, 'deepseek-chat')
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 2000)
  assert.equal(body.stream, false)
  assert.deepEqual(body.messages.map((item) => item.role), ['system', 'user'])
  assert.equal(buildAiRequest('https://x.test/v1/chat/completions', '', 'p').url, 'https://x.test/v1/chat/completions')
  assert.throws(() => buildAiRequest('https://x.test', 'm', '   '), /提示词不能为空/)
  assert.throws(() => buildAiRequest('', 'm', 'p'), /接口地址不能为空/)

  assert.equal(parseAiReply(JSON.stringify({ choices: [{ message: { content: ' 摘要 ' } }] })), '摘要')
  assert.throws(() => parseAiReply('not json'), /不是合法 JSON/)
  assert.throws(() => parseAiReply('{}'), /缺少 choices/)
  assert.equal(classifyAiError(401, '{"error":{"message":"bad key"}}'), 'AI 服务 401：密钥无效或已失效：bad key')
  assert.match(classifyAiError(0, ''), /网络异常/)
  assert.match(classifyAiError(-1, ''), /超时/)
})

test('tools：sealToolSchema 给每个 object 节点补齐 additionalProperties（宿主注册的硬要求）', () => {
  const sealed = sealToolSchema({
    type: 'object',
    properties: {
      date: { type: 'string' },
      records: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    required: ['date'],
  })
  assert.equal(sealed.additionalProperties, true)
  assert.equal(sealed.properties.records.items.additionalProperties, true)
  assert.deepEqual(sealed.required, ['date'], 'required 数组必须原样保留')
  // 非 object 节点不凭空加 additionalProperties
  assert.equal('additionalProperties' in sealed.properties.date, false)
  assert.equal('additionalProperties' in sealed.properties.records, false)
  // 幂等：再次封装不改变形状
  assert.deepEqual(sealToolSchema(sealed), sealed)
})
