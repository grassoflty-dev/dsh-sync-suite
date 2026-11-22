/**
 * `mod-plugin-tools-v2`：把四个模型工具从 v1 JSONL 迁到共享 v2 时间线后的验收。
 *
 * 前置：`cd packages/dsh-dots; node scripts/build.mjs`。
 * 被测对象：dist/schedule/{tools,v2Bridge,dots}.js；门禁来自 dist/sync/cycle.js。
 *
 * 每条用例都说明「v1 当时怎么做」，断言必须**在 v1 行为下失败**：
 *   - v1 写 `devices/<deviceId>/schedules/<date>.jsonl`（一行一对象、先 pull --rebase）；
 *   - v1 读同一份 JSONL，按 `done` 分未完成，同 id 取较晚 ts（无字节序裁决 / 无账本）；
 *   - v1 无 schema 门槛、无 outbox，push 失败仍可能把本地成功报给用户。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

import { registerScheduleTools } from '../dist/schedule/tools.js'
import {
  V2ScheduleBridge,
  buildV2Ports,
  isOpenRecord,
  newTimelineRecord,
  summarizeV2,
  withV2ScheduleBridge,
} from '../dist/schedule/v2Bridge.js'
import { aggregateDotsV2, clampDays } from '../dist/schedule/dots.js'
import {
  FRESH_SCHEMA_TEXT,
  buildRecordsText,
  canonicalRecordLine,
  conflictsLine,
  decidedAtFromTs,
  parseTimelineDay,
} from '../dist/timeline/index.js'
import { PUSH_ARGS, V2_ERROR, makeIntentId } from '../dist/sync/cycle.js'
import { repoHash, statePaths } from '../dist/engine/paths.js'
import { defaultSettings, SettingsStore } from '../dist/engine/settings.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(path.resolve(here, `../${rel}`), 'utf8')

const DAY = '2026-11-19'
const T0930 = `${DAY}T09:30:00+08:00`
const T1400 = `${DAY}T14:00:00+08:00`
const T1600 = `${DAY}T16:00:00+08:00`
const SHA = 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789'
const NOW = () => new Date(`${DAY}T21:00:00+08:00`)
const V1_DATE = '2026-11-19'

function rec(overrides = {}) {
  return {
    id: 'a1', ts: T0930, title: '标题', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: T0930, ...overrides,
  }
}

/* ------------------------- App fixture（逐字复制，非新造） ------------------------- */
// 来源：test/plugin-timeline-v2.test.mjs:92-93 ← apps/arkui-schedule/tools/test/timelineRead.test.mjs:62-63
// （测试 09 / 10 的 EXAMPLE_A / EXAMPLE_B）
const APP_EXAMPLE_A = '{"id":"m9x2k1-3fk","ts":"2026-11-19T09:30:00+08:00","title":"周会","body":"讨论同步方案","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"2026-11-19T09:30:00+08:00"}'
const APP_EXAMPLE_B = '{"id":"n0y3l2-8ab","ts":"2026-11-19T14:00:00+08:00","title":"体检","body":"","author":"我","done":true,"media":[{"file":"ab12cd34ef567890.jpg","sha256":"ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789","pageIndex":0}],"ocr_text":"体检单","ai_processed":true,"opened_at":"2026-11-19T14:00:00+08:00","closed_at":"2026-11-19T15:20:00+08:00"}'
// 来源：test/plugin-timeline-v2.test.mjs:96-116 ← apps/arkui-schedule/tools/test/timelineWrite.test.mjs:69-91
// （测试 01 / 02 的对象 + 整文件期望）
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

/* ------------------------- 注入端口（照搬 plugin-v2-cycle.test.mjs:60-116） ------------------------- */
class MemFs {
  constructor(seed = {}) { this.files = new Map(Object.entries(seed)); this.calls = [] }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) { this.calls.push(['writeTemp', rel]); this.files.set(`${rel}.tmp`, text); return `${rel}.tmp` }
  async readTemp(t) { return this.files.get(t) ?? '' }
  async rename(t, rel) { this.calls.push(['rename', rel]); this.files.set(rel, this.files.get(t)); this.files.delete(t) }
  async backupIfExists(rel, b) { this.calls.push(['backup', rel]); if (!this.files.has(rel)) return false; this.files.set(b, this.files.get(rel)); return true }
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
    this.headFiles = opts.headFiles ?? {}
    this.pushError = opts.pushError ?? null
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
  async pushMain(args) { this.calls.push(['push', args]); if (this.pushError !== null) throw new Error(this.pushError) }
  async aheadBehind() { return { ahead: 0, behind: 0 } }
  async aheadCommits() { return [] }
  writes() { return this.calls.filter((c) => ['add', 'commit', 'push'].includes(c[0])) }
}
class MemOutbox {
  constructor(entries = []) { this.entries = entries.slice(); this.saves = 0 }
  async load() { return this.entries.slice() }
  async save(entries) { this.saves += 1; this.entries = entries.slice() }
}

function ports(seed = {}, gitOpts = {}, outboxEntries = []) {
  const fs = new MemFs(seed)
  const git = new FakeGit(gitOpts)
  const outbox = new MemOutbox(outboxEntries)
  return { ports: { repoDir: '/repo', fs, git, outbox }, fs, git, outbox }
}

function makeTools(toolPorts, now = NOW) {
  const registered = []
  const ctx = {
    tools: { register(definition) { registered.push(definition); return () => undefined } },
    effects: [],
    effect(effect, label) { this.effects.push(label); effect() },
  }
  const root = statePaths(path.join(here, '..', '.tmp', 'tools-v2-home'))
  const store = new SettingsStore(root, { allowLocalRepo: true })
  store.writeSettings({ ...defaultSettings(), repoUrl: 'https://example.test/a/b.git', deviceId: 'pc-a' })
  registerScheduleTools(ctx, { paths: root, allowLocalRepo: true, now, v2Ports: toolPorts })
  return { registered, ctx, byName: (name) => registered.find((t) => t.name === name) }
}

/* ================================================================ 写路径 */

// v1：bridge.add → appendFile(`devices/pc-a/schedules/<date>.jsonl`) + pull --rebase。
test('T01 schedule_add 写 timeline/<date>/records.json，不写 devices/**；字节 = buildRecordsText', async () => {
  const { ports: p, fs, git } = ports()
  const bridge = new V2ScheduleBridge({ ports: p, deviceId: 'pc-a', now: NOW })
  const added = await bridge.add('pc-a', DAY, { title: '工具新建', body: '来自 schedule_add' })

  assert.equal(added.path, `timeline/${DAY}/records.json`)
  assert.equal(added.path.includes('devices/'), false)
  assert.equal(fs.files.has(`devices/pc-a/schedules/${V1_DATE}.jsonl`), false)
  const text = fs.files.get(`timeline/${DAY}/records.json`)
  assert.ok(typeof text === 'string')
  // 容器契约：整文件对象、records 一条一行、末尾恰好一个 \n
  assert.ok(text.startsWith('{\n  "date": "2026-11-19",\n  "open": '))
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.endsWith('\n\n'), false)
  const parsed = parseTimelineDay(text, DAY)
  assert.equal(parsed.errors.length, 0)
  const record = parsed.day.allRecords.find((r) => r.id === added.id)
  assert.deepEqual(record, newTimelineRecord(added.id, added.ts, { title: '工具新建', body: '来自 schedule_add' }))
  assert.equal(text, buildRecordsText(DAY, parsed.day.allRecords), '整份文件逐字节 = buildRecordsText')
  assert.ok(text.includes(canonicalRecordLine(record)), '写入行逐字节 = canonicalRecordLine')
  assert.equal(git.writes().some((c) => c[0] === 'push'), true)
  assert.deepEqual(git.writes().find((c) => c[0] === 'push')[1], PUSH_ARGS, 'push 固定 origin/main、force:false')
})

// v1：jsonl.ts 自造编码器（键序 ocr_text 在 author 前、attachments），与 App 字节不同。
test('T02 字节对拍：复用 App 测试 fixture，工具走的规范序列化器与之逐字节相同', () => {
  // 共享序列化器必须与 App 自带 fixture 字节一致（fixture 来源见文件头）
  assert.equal(canonicalRecordLine(WRITE_EXAMPLE_A), APP_EXAMPLE_A)
  assert.equal(canonicalRecordLine(WRITE_EXAMPLE_B), APP_EXAMPLE_B)
  assert.equal(buildRecordsText(DAY, [WRITE_EXAMPLE_A, WRITE_EXAMPLE_B]), WRITE_EXAMPLE_TEXT)
  // 工具写入用的就是同一函数：用相同对象经工具桥的构造器再序列化，字节不变
  const built = newTimelineRecord(WRITE_EXAMPLE_A.id, WRITE_EXAMPLE_A.ts, WRITE_EXAMPLE_A)
  assert.equal(canonicalRecordLine(built), APP_EXAMPLE_A)
  assert.equal(isOpenRecord(built), true, '缺 closed_at = 未完成（即使 done 字段另有取值）')
})

/* ================================================================ 读路径 */

// v1：devices/** 的 JSONL 会被读进来；v1 按 done 分未完成。
test('T03 schedule_list 只读 v2：closed_at 定未完成，v1 devices/** 不再被读', async () => {
  const appB = JSON.parse(APP_EXAMPLE_B)
  const seed = {
    [`timeline/${DAY}/records.json`]: buildRecordsText(DAY, [
      { ...WRITE_EXAMPLE_A, done: true }, // done=true 但无 closed_at → 未完成
      appB,                                // done=true 且有 closed_at → 已完成
    ]),
    // v1 诱饵：若工具仍读 devices/**，这里会多出一条
    [`devices/pc-a/schedules/${V1_DATE}.jsonl`]: `${canonicalRecordLine(rec({ id: 'v1-decoy', title: 'v1 诱饵' }))}\n`,
  }
  const { ports: p } = ports(seed)
  const { byName } = makeTools(p)
  const listed = await byName('schedule_list').execute({ deviceId: 'all', date: DAY })
  assert.deepEqual(listed.records.map((r) => r.id), ['m9x2k1-3fk', 'n0y3l2-8ab'])
  assert.equal(listed.records.some((r) => r.id === 'v1-decoy'), false)
  assert.deepEqual(listed.records.map((r) => r.done), [false, true], '不信 done，只看 closed_at')
  assert.equal(listed.refreshed, false, 'v2 读侧不 pull/rebase')
})

// v1：同 id 取较晚 ts 但同 ts 只按输入顺序，且没有 conflicts.jsonl。
test('T04 同 ts 冲突写 conflicts.jsonl：胜者与 App 的 UTF-8 字节序规则一致', async () => {
  const loser = rec({ id: 'tie', ts: T0930, body: 'A' })    // 规范行字节较小 → 败者
  const winner = rec({ id: 'tie', ts: T0930, body: 'Z' })   // 规范行字节较大 → 胜者
  const localText = buildRecordsText(DAY, [winner])
  const remoteText = buildRecordsText(DAY, [loser])
  const { ports: p, fs } = ports({
    [`timeline/${DAY}/records.json`]: localText,
    'timeline/schema.json': FRESH_SCHEMA_TEXT,
  }, { remote: { [`timeline/${DAY}/records.json`]: remoteText }, headFiles: { [`timeline/${DAY}/records.json`]: localText } })
  const bridge = new V2ScheduleBridge({ ports: p, deviceId: 'pc-a', now: NOW })
  await bridge.add('pc-a', DAY, { title: '触发一次同步周期' })

  const finalText = fs.files.get(`timeline/${DAY}/records.json`)
  const finalRecords = parseTimelineDay(finalText, DAY).day.allRecords
  const kept = finalRecords.find((r) => r.id === 'tie')
  assert.equal(kept.body, 'Z', '同 ts 取规范行 UTF-8 字节较大者')
  const conflicts = fs.files.get(`timeline/${DAY}/conflicts.jsonl`)
  assert.ok(typeof conflicts === 'string')
  const row = conflicts.trim()
  const expected = conflictsLine('tie', T0930, canonicalRecordLine(loser), decidedAtFromTs(T0930))
  assert.equal(row, expected, '审计行逐字节 = App conflictsLine（id,ts,losingLine,decidedAt,dedupeKey）')
  assert.equal(JSON.parse(row).losingLine, canonicalRecordLine(loser))
})

// v1：没有 schema 概念，也没有 outbox；任何仓库都直接 appendFile。
test('T05 schema 门禁：缺标记幂等创建 schemaVersion:2；未知版本 typed 拒绝且零写入', async () => {
  const fresh = ports()
  const bridgeFresh = new V2ScheduleBridge({ ports: fresh.ports, deviceId: 'pc-a', now: NOW })
  await bridgeFresh.add('pc-a', DAY, { title: '首跑' })
  assert.equal(fresh.fs.files.get('timeline/schema.json'), FRESH_SCHEMA_TEXT)
  assert.equal(fresh.fs.writeCalls().filter((c) => c[1] === 'timeline/schema.json').length, 1)

  const unknown = ports({ 'timeline/schema.json': '{"schemaVersion":99}' })
  const unknownTool = makeTools(unknown.ports)
  await assert.rejects(
    () => unknownTool.byName('schedule_add').execute({ title: '应被拒绝', date: DAY }),
    (error) => { assert.equal(error.code, V2_ERROR.SCHEMA_UNKNOWN); return true },
  )
  assert.deepEqual(unknown.fs.writeCalls(), [], '零写入：连 schema/records 都没有写句柄')
  assert.deepEqual(unknown.git.writes(), [], '零 git 写命令')
  assert.equal(unknown.outbox.saves, 0, '零 outbox 写入（门禁在 enqueue 之前）')
})

// v1：push 失败时 add 仍返回 pushed:false，并可能把本地成功留给用户。
test('T06 push 失败：typed 错误 + 意图停在 outbox + 绝不返回成功', async () => {
  const { ports: p, fs, outbox } = ports({}, { pushError: 'remote rejected' })
  const bridge = new V2ScheduleBridge({ ports: p, deviceId: 'pc-a', now: NOW })
  await assert.rejects(
    () => bridge.add('pc-a', DAY, { title: '推不上去' }),
    (error) => {
      assert.equal(error.code, V2_ERROR.PUSH_REJECTED)
      assert.match(error.message, /下一步/)
      return true
    },
  )
  assert.equal(outbox.entries.length, 1)
  const parked = outbox.entries[0]
  assert.equal(parked.op, 'upsert')
  assert.equal(parked.state, 'pending')
  assert.equal(parked.attempts, 1)
  assert.match(parked.lastError, /E_PUSH_REJECTED/)
  assert.equal(parked.line, canonicalRecordLine(JSON.parse(parked.line)))
  // 本地文件可能已写（提交存在），但没有成功返回值——这正是「绝不报成功」的口径。
  assert.ok(fs.writeCalls().length > 0)
})

// ================================================================ 账本 / dots / 形状

// v1：账本不存在，被删记录仍出现在 list 里。
test('T07 账本优先级：deleted 隐藏、restore 严格更晚才复活（与 App 同规则）', async () => {
  const base = rec({ id: 'gone', body: '被删' })
  const kept = rec({ id: 'kept', ts: T1400, body: '保留' })
  const seed = {
    [`timeline/${DAY}/records.json`]: buildRecordsText(DAY, [base, kept]),
    [`timeline/${DAY}/deleted.jsonl`]: `${JSON.stringify({ id: 'gone', ts: T1600, deletedAt: T1600 })}\n`,
    [`timeline/${DAY}/restore.jsonl`]: `${JSON.stringify({ id: 'gone', ts: T0930, restoredAt: T0930 })}\n`,
  }
  const bridge = new V2ScheduleBridge({ ports: ports(seed).ports, deviceId: 'pc-a', now: NOW })
  let listed = await bridge.list('', DAY)
  assert.deepEqual(listed.records.map((r) => r.id), ['kept'], 'R<D 仍删除')
  seed[`timeline/${DAY}/restore.jsonl`] = `${JSON.stringify({ id: 'gone', ts: T1600, restoredAt: T1600 })}\n`
  const bridge2 = new V2ScheduleBridge({ ports: ports(seed).ports, deviceId: 'pc-a', now: NOW })
  listed = await bridge2.list('', DAY)
  assert.deepEqual(listed.records.map((r) => r.id), ['kept'], 'R=D 删除胜')
  seed[`timeline/${DAY}/restore.jsonl`] = `${JSON.stringify({ id: 'gone', ts: `${DAY}T17:00:00+08:00`, restoredAt: `${DAY}T17:00:00+08:00` })}\n`
  const bridge3 = new V2ScheduleBridge({ ports: ports(seed).ports, deviceId: 'pc-a', now: NOW })
  listed = await bridge3.list('', DAY)
  assert.deepEqual(listed.records.map((r) => r.id), ['gone', 'kept'], 'R>D 复活')
})

// v1：dsh_dots 逐设备读 devices/<id>/schedules/*.jsonl 并按 done 分未完成。
test('T08 dsh_dots 读共享 v2 timeline：v1 devices/** 忽略，未完成只看 closed_at', async () => {
  const { ports: p } = ports({
    [`timeline/${DAY}/records.json`]: buildRecordsText(DAY, [
      { ...WRITE_EXAMPLE_A, done: true }, appFixtureB(),
    ]),
    [`devices/pc-a/schedules/${V1_DATE}.jsonl`]: `${canonicalRecordLine(rec({ id: 'v1-decoy' }))}\n`,
  })
  const aggregate = await aggregateDotsV2(p, 'pc-a', { days: 1, now: NOW })
  assert.deepEqual(aggregate.days.map((d) => d.dateKey), [DAY])
  assert.deepEqual(aggregate.totals, { days: 1, records: 2, open: 1, done: 1, skipped: 0 })
  assert.deepEqual(aggregate.days[0].topTitles, ['周会', '体检'])
  assert.equal(aggregate.days[0].total, 2, 'v1 诱饵没被计入')

  const { byName } = makeTools(p)
  const snapshot = await byName('dsh_dots').execute({ days: 1 })
  assert.deepEqual(snapshot.totals, { days: 1, records: 2, open: 1, done: 1, skipped: 0 })
  assert.equal(snapshot.deviceId, 'pc-a')
})
function appFixtureB() { return JSON.parse(APP_EXAMPLE_B) }

// v1：工具名/入参/返回键形状；本模块必须保持这些键不变。
// 期望值内联自提交前的 v1 定义 `git show HEAD:packages/dsh-dots/src/schedule/tools.ts`
// （list 147-205 / add 207-260 / summary 261-323 / dots 325-411）；键消失或改名即红。
test('T09 四个工具的名字 / 入参键 / 返回键逐项与 v1 相同（含嵌套键与 timeoutMs）', () => {
  const V1 = {
    schedule_list: {
      params: ['date', 'deviceId'],
      returns: ['date', 'deviceIds', 'refreshed', 'note', 'errors', 'records'],
      nested: [['records[]', (t) => t.output.schema.properties.records.items.properties,
        ['id', 'ts', 'date', 'deviceId', 'title', 'author', 'done', 'bodyPreview', 'bodyLength', 'hasAttachments', 'aiProcessed']]],
      timeoutMs: 60_000,
    },
    schedule_add: {
      params: ['date', 'title', 'body', 'author'],
      required: ['title'],
      returns: ['id', 'ts', 'date', 'deviceId', 'path', 'commit', 'pushed', 'rebased', 'files'],
      nested: [],
      timeoutMs: 60_000,
    },
    schedule_summary: {
      params: ['date', 'deviceId'],
      returns: ['date', 'deviceIds', 'count', 'refreshed', 'note', 'aiNote', 'summary', 'prompt', 'payload'],
      nested: [
        ['payload', (t) => t.output.schema.properties.payload.properties, ['date', 'records']],
        ['payload.records[]', (t) => t.output.schema.properties.payload.properties.records.items.properties, ['id', 'ocr_time', 'text']],
      ],
      timeoutMs: 90_000,
    },
    dsh_dots: {
      params: ['days'],
      returns: ['generatedAt', 'deviceId', 'note', 'days', 'totals', 'dsh'],
      nested: [
        ['days[]', (t) => t.output.schema.properties.days.items.properties, ['dateKey', 'total', 'open', 'done', 'topTitles']],
        ['totals', (t) => t.output.schema.properties.totals.properties, ['days', 'records', 'open', 'done', 'skipped']],
        ['dsh', (t) => t.output.schema.properties.dsh.properties,
          ['reachable', 'mode', 'sessionCount', 'activeSessionTitle', 'busy', 'lastActivityAt', 'version', 'detail']],
      ],
      timeoutMs: 90_000,
    },
  }
  // sealToolSchema 会给每个 object 节点补 additionalProperties；比较键时剔除这个宿主要求字段。
  const keys = (node) => Object.keys(node).filter((key) => key !== 'additionalProperties').sort()
  const { registered } = makeTools(ports().ports)
  assert.deepEqual(registered.map((tool) => tool.name), Object.keys(V1), '工具名与注册顺序不变')
  for (const [name, v1] of Object.entries(V1)) {
    const tool = registered.find((candidate) => candidate.name === name)
    assert.ok(tool !== undefined, `${name} 必须仍然注册`)
    assert.deepEqual(keys(tool.parameters.properties), v1.params.slice().sort(), `${name} 入参键`)
    assert.deepEqual(keys(tool.output.schema.properties), v1.returns.slice().sort(), `${name} 返回键`)
    assert.equal(tool.timeoutMs, v1.timeoutMs, `${name} timeoutMs`)
    if (v1.required !== undefined) {
      assert.deepEqual(tool.parameters.required, v1.required, `${name} required`)
    }
    for (const [label, getNode, expectedKeys] of v1.nested) {
      assert.deepEqual(keys(getNode(tool)), expectedKeys.slice().sort(), `${name} 嵌套键 ${label}`)
    }
  }
  assert.equal(clampDays(0), 1, 'dsh_dots days 夹取语义未变')
})

/* ------------------------------------------------------------------ 源码启发式（纵深防御，不是保证） */
// 真正的保证在 gitPort.ts 的 buildSafePushArgs / assertSafeGitArgs（见 repo-root.test.mjs:R10/R11）。
// 这里只做文本形态筛查：把 `-f` / 强制 refspec / push.force / `--delete` 等**拼写**也纳入，
// 并对同一 matcher 做正/负对照（T10b），避免"当前代码恰好干净"式假阳性安全。
const TEXT_FORCE_PATTERNS = [
  { label: 'pull --rebase', re: /pull\s+--rebase/i },
  { label: 'history-rewrite call', re: /\b(?:pullRebase|pushWithRebase)\s*\(/i },
  { label: 'force flag', re: /--force(?:-with-lease|-if-includes)?\b/i },
  { label: 'short force flag', re: /(?:^|[\s"'`])-f(?=[\s"'`\]},]|$)/ },
  { label: 'forced refspec', re: /(?:^|[:\s"'`])\+(?:refs\/heads\/[A-Za-z0-9_.\/*-]+|[A-Za-z0-9_][A-Za-z0-9_.-]*)(?=[\s"'`\]},:/]|$)/ },
  { label: 'push.force config', re: /\bpush\.force\s*[=:]/i },
  { label: 'remote delete', re: /--delete\b/i },
  { label: 'force:true', re: /\bforce\s*:\s*true\b/i },
  { label: 'reset --hard', re: /reset\s+--hard/i },
  { label: 'unlink call', re: /\bunlink\s*\(/ },
  { label: 'rmSync call', re: /\brmSync\s*\(/ },
  { label: 'recursive rm', re: /\brm\s*\(?\s*-?r/i },
]
function textForceHit(text) {
  for (const { label, re } of TEXT_FORCE_PATTERNS) if (re.test(text)) return label
  return null
}

// v1：bridge.ts 内 pullRebase / pushWithRebase 会改写历史并可能 force。
test('T10 源码形态启发式（heuristic，非保证）：改动面与 dist 孪生无强制/删除拼写', () => {
  // src/sync 与 dist/sync 用目录枚举，新增文件自动纳入；schedule 三件套显式列出。
  const inDir = (dir, suffix) => readdirSync(path.resolve(here, `../${dir}`))
    .filter((name) => name.endsWith(suffix)).map((name) => `${dir}/${name}`)
  const files = [
    'src/schedule/v2Bridge.ts', 'src/schedule/tools.ts', 'src/schedule/dots.ts',
    'dist/schedule/v2Bridge.js', 'dist/schedule/tools.js', 'dist/schedule/dots.js',
    ...inDir('src/sync', '.ts'), ...inDir('dist/sync', '.js'),
  ]
  for (const rel of files) {
    const hit = textForceHit(src(rel))
    assert.equal(hit, null, `${rel} 出现被禁的历史改写/删除动作：${hit}`)
  }
  assert.deepEqual(PUSH_ARGS, { remote: 'origin', branch: 'main', force: false })
})

test('T10b 启发式的正/负对照：恶意拼写全部命中，无害文本放行（证明 matcher 会失败）', () => {
  const offending = [
    'git push origin -f',
    'git push --force origin main',
    'git push --force-with-lease origin main',
    'git push --force-if-includes origin main',
    'git push origin +main',
    'git push origin +refs/heads/*',
    'git push origin +refs/heads/*:refs/heads/*',
    'git push --delete origin main',
    'git -c push.force=true push origin main',
    'git --config push.force=true push origin main',
  ]
  for (const line of offending) {
    assert.notEqual(textForceHit(line), null, `启发式漏报：${line}`)
  }
  const benign = [
    "export const PUSH_ARGS = Object.freeze({ remote: 'origin', branch: 'main', force: false })",
    '// 不改写历史，也不强推，force:false 是固定值',
    "await this.git(['push', '--porcelain', 'origin', 'HEAD:main'])",
  ]
  for (const line of benign) {
    assert.equal(textForceHit(line), null, `启发式误报：${line}`)
  }
})

// v1：outbox 意图 id 由 makeIntentId 生成；这里钉死工具写入的 line 就是规范行且 intentId 可复算。
test('T11 工具写出的 outbox 意图 payload 稳定（date/id/ts/op 与规范行一致）', async () => {
  // 成功周期会出队意图；这里让 push 失败，意图被停放，才能检查原始 payload。
  const { ports: p, outbox } = ports({}, { pushError: 'reject for intent check' })
  const bridge = new V2ScheduleBridge({ ports: p, deviceId: 'pc-a', now: NOW })
  let added
  await assert.rejects(() => bridge.add('pc-a', DAY, { title: '意图检查' }), () => true)
  const failed = outbox.entries[0]
  added = { id: failed.id, ts: failed.ts }
  const intent = failed
  assert.equal(intent.intentId, makeIntentId(DAY, added.id, added.ts, 'upsert'))
  assert.deepEqual(
    [intent.date, intent.id, intent.ts, intent.op],
    [DAY, added.id, added.ts, 'upsert'],
  )
  assert.equal(intent.line, canonicalRecordLine(JSON.parse(intent.line)))
})

test('T12 工具读侧查询不再有 v1 设备选择语义（入参保留但同结果）', async () => {
  const seed = { [`timeline/${DAY}/records.json`]: buildRecordsText(DAY, [rec()]) }
  const { byName } = makeTools(ports(seed).ports)
  const own = await byName('schedule_list').execute({ deviceId: 'pc-a', date: DAY })
  const all = await byName('schedule_list').execute({ deviceId: 'all', date: DAY })
  assert.deepEqual(own.records, all.records, 'v2 只有一份共享时间线，deviceId 不影响结果')
  assert.deepEqual(own.deviceIds, ['pc-a'])
  const summaryOwn = await byName('schedule_summary').execute({ deviceId: 'pc-a', date: DAY })
  const summaryAll = await byName('schedule_summary').execute({ deviceId: 'all', date: DAY })
  assert.equal(summaryOwn.count, summaryAll.count)
})

// mod-plugin-repo-root 订正：缺 appFilesDir 不再 fail-closed，默认 PC 根解析成功。
test('T13 缺 appFilesDir 不再是用户失败：默认根解析成功，E_NO_APP_FILES_DIR 已删除', async () => {
  const home = path.join(here, '..', '.tmp', 'tools-v2-home-real')
  const paths = statePaths(home)
  const url = 'https://example.test/a/b.git'
  const store = new SettingsStore(paths, { allowLocalRepo: true })
  store.writeSettings({ ...defaultSettings(), repoUrl: url, deviceId: 'pc-a' })
  // 显式清空两个 env，等价于用户机器上的「什么都没配」。
  const built = buildV2Ports({
    paths, settings: store.readSettings(), token: null,
    env: { DSH_DOTS_REPO_ROOT: '', DSH_DOTS_APP_FILES_DIR: '' },
  })
  try {
    const expected = path.join(home, '.dsh', 'dots', 'repos', repoHash(url), 'git-repo')
    assert.equal(built.repoDir, expected)
    assert.equal(built.sharedRepoRoot, path.dirname(expected))
    assert.equal(typeof built.ports.fs.read, 'function')
    assert.equal(typeof built.ports.git.prepare, 'function', '真实端口带 clone 准备步骤')
  } finally {
    await built.dispose()
  }
})
