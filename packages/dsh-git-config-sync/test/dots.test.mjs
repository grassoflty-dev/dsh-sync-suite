/**
 * `dsh_dots`（手机端 DSH-dots 快照）测试：跨设备跨天聚合 + 只填可证字段的 DSH 状态。
 *
 * 用临时目录伪造 `devices/<id>/schedules/*.jsonl`（不需要 git），
 * 工具层那一组再用真实临时仓库（bare + 工作副本，`allowLocalRepo`）走一遍设置 → 工具 → 仓库。
 *
 * 覆盖验收项：
 *   - 单设备 3 天数据 → totals/days 正确（dateKey 倒序）；
 *   - 多设备同日合并（同 id 跨设备折叠，取较晚 ts，不重复计数）；
 *   - days 夹取：0 → 1、200 → 90、缺省 7；
 *   - 坏行跳过且不崩，计入 totals.skipped（带行号定位，不静默）；
 *   - topTitles 未完成优先 + 按 ts 倒序 + 去重 + 最多 3 条；
 *   - DSH 状态取不到时 reachable:false + detail 可读，且不编造会话字段/版本；
 *   - 文件系统异常 → E_DOTS_IO；没有仓库 → 空数组、不报错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { statePaths } from '../dist/engine/paths.js'
import { defaultSettings, SettingsStore } from '../dist/engine/settings.js'
import { registerScheduleTools } from '../dist/schedule/tools.js'
import {
  DOTS_DEFAULT_DAYS,
  DOTS_MAX_DAYS,
  DOTS_MIN_DAYS,
  aggregateDots,
  buildDshStatus,
  clampDays,
  collectDotsSnapshot,
  digestDay,
  emptyDotsSnapshot,
  recentDateKeys,
} from '../dist/schedule/dots.js'

const exec = promisify(execFile)
const IDENTITY = ['-c', 'user.name=dsh-test', '-c', 'user.email=test@localhost']
const DATE = '2026-11-15'
const NOW_ISO = '2026-11-15T21:45:27+08:00'
const NOW = () => new Date(NOW_ISO)

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

async function tempDir(t, prefix = 'gcs-dots-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  return dir
}

/** 一条契约记录；`overrides` 覆盖字段。 */
function record(overrides) {
  return {
    id: 'r-1',
    ts: `${DATE}T09:00:00+08:00`,
    title: '默认标题',
    body: '',
    author: '我',
    done: false,
    ai_processed: false,
    ...overrides,
  }
}

/** 写一天的文件；`lines` 里的对象自动 JSON 化，字符串原样写入（造坏行用）。 */
async function writeDay(repoDir, deviceId, dateKey, lines) {
  const dir = path.join(repoDir, 'devices', deviceId, 'schedules')
  await mkdir(dir, { recursive: true })
  const text = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')
  await writeFile(path.join(dir, `${dateKey}.jsonl`), text === '' ? '' : `${text}\n`, 'utf8')
}

/** `YYYY-MM-DD`（本地日历；独立于被测实现重算，避免自证）。 */
function dateKeyOf(date) {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

async function git(cwd, args) {
  const { stdout } = await exec('git', [...IDENTITY, ...args], { cwd, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/** 真仓库：bare 远端 + 一份 seed 提交（两天数据，跨 pc-a / pad-1）。 */
async function setupRepo(t) {
  const root = await tempDir(t, 'gcs-dots-git-')
  const bare = path.join(root, 'remote.git')
  await git(root, ['init', '--bare', '-b', 'main', bare])
  const seed = path.join(root, 'seed')
  await git(root, ['clone', '--quiet', bare, seed])
  await writeDay(seed, 'pc-a', DATE, [
    record({ id: 'pc-1', ts: `${DATE}T09:00:00+08:00`, title: 'PC 未完成', done: false }),
    record({ id: 'pc-2', ts: `${DATE}T10:00:00+08:00`, title: 'PC 已完成', done: true }),
  ])
  await writeDay(seed, 'pad-1', DATE, [
    record({ id: 'pad-1', ts: `${DATE}T08:00:00+08:00`, title: '平板未完成', done: false }),
  ])
  await writeDay(seed, 'pad-1', '2026-11-14', [
    record({ id: 'pad-2', ts: '2026-11-14T20:00:00+08:00', title: '平板昨天的已完成', done: true }),
  ])
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '--quiet', '-m', 'seed: dots fixtures'])
  await git(seed, ['push', '--quiet', 'origin', 'HEAD:main'])
  return { root, bare }
}

/** 递归检查：每个 object 节点必须显式声明 additionalProperties（宿主注册时的硬要求）。 */
function assertSealedObjects(node, label) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) assertSealedObjects(item, label)
    return
  }
  if (node.type === 'object') {
    assert.equal(typeof node.additionalProperties, 'boolean', `${label}: object 节点必须声明 additionalProperties`)
  }
  if (node.properties !== undefined) {
    for (const child of Object.values(node.properties)) assertSealedObjects(child, label)
  }
  if (node.items !== undefined) assertSealedObjects(node.items, label)
}

/** 用临时 home 造工具注册表；返回已注册的工具与 ctx。 */
function registerTools(paths, ownDeviceId) {
  const store = new SettingsStore(paths, { allowLocalRepo: true })
  const settings = defaultSettings()
  store.writeSettings({ ...settings, repoUrl: '', deviceId: ownDeviceId })
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => undefined
      },
    },
    effects: [],
    effect(effect, label) {
      this.effects.push(label)
      effect()
    },
  }
  const names = registerScheduleTools(ctx, { paths, allowLocalRepo: true, now: NOW })
  return { registered, ctx, names, store }
}

/* -------------------------------------------------------------------------- */
/* 聚合                                                                        */
/* -------------------------------------------------------------------------- */

test('aggregateDots：单设备 3 天数据 → 每天 total/open/done 与 totals 正确（dateKey 倒序）', async (t) => {
  const repo = await tempDir(t)
  await writeDay(repo, 'pc-a', '2026-11-15', [
    record({ id: 'd15-a', ts: `${DATE}T09:00:00+08:00`, title: '15 号未完成 1' }),
    record({ id: 'd15-b', ts: `${DATE}T10:00:00+08:00`, title: '15 号已完成', done: true }),
    record({ id: 'd15-c', ts: `${DATE}T11:00:00+08:00`, title: '15 号未完成 2' }),
  ])
  await writeDay(repo, 'pc-a', '2026-11-14', [
    record({ id: 'd14-a', ts: '2026-11-14T20:00:00+08:00', title: '14 号已完成', done: true }),
  ])
  await writeDay(repo, 'pc-a', '2026-11-13', [
    record({ id: 'd13-a', ts: '2026-11-13T08:00:00+08:00', title: '13 号未完成' }),
    record({ id: 'd13-b', ts: '2026-11-13T09:00:00+08:00', title: '13 号已完成', done: true }),
  ])

  const aggregate = await aggregateDots({ repoDir: repo, deviceId: 'pc-a', now: NOW })
  assert.equal(aggregate.generatedAt, NOW_ISO, 'generatedAt 用本地时区 ISO（与 ts 同形）')
  assert.equal(aggregate.deviceId, 'pc-a')
  assert.deepEqual(
    aggregate.days.map((day) => day.dateKey),
    ['2026-11-15', '2026-11-14', '2026-11-13'],
    '只返回有记录的天，按 dateKey 倒序',
  )
  assert.deepEqual(
    aggregate.days.map((day) => ({ total: day.total, open: day.open, done: day.done })),
    [
      { total: 3, open: 2, done: 1 },
      { total: 1, open: 0, done: 1 },
      { total: 2, open: 1, done: 1 },
    ],
  )
  assert.deepEqual(aggregate.totals, { days: 3, records: 6, open: 3, done: 3, skipped: 0 })
  assert.deepEqual(aggregate.skippedDetails, [])
})

test('aggregateDots：多设备同日合并，同 id 跨设备折叠取较晚 ts（不重复计数）', async (t) => {
  const repo = await tempDir(t)
  await writeDay(repo, 'pc-a', DATE, [
    // 同一 id 的较晚版本：PC 上勾了完成并改了标题
    record({ id: 'shared-1', ts: `${DATE}T12:00:00+08:00`, title: '开会（已完成）', done: true }),
    record({ id: 'pc-only', ts: `${DATE}T09:00:00+08:00`, title: 'PC 自己的未完成' }),
  ])
  await writeDay(repo, 'pad-1', DATE, [
    // 同一 id 的旧版本（平板还没同步到 PC 的修改）
    record({ id: 'shared-1', ts: `${DATE}T10:00:00+08:00`, title: '开会（旧）', done: false }),
    record({ id: 'pad-only', ts: `${DATE}T08:00:00+08:00`, title: '平板未完成' }),
  ])

  const aggregate = await aggregateDots({ repoDir: repo, deviceId: 'pc-a', now: NOW })
  assert.equal(aggregate.days.length, 1)
  const day = aggregate.days[0]
  assert.equal(day.dateKey, DATE)
  assert.equal(day.total, 3, '两个设备 4 行、同 id 折叠后 3 条')
  assert.equal(day.open, 2)
  assert.equal(day.done, 1, 'shared-1 取较晚 ts：已完成')
  assert.deepEqual(day.topTitles, ['PC 自己的未完成', '平板未完成', '开会（已完成）'])
  assert.deepEqual(aggregate.totals, { days: 1, records: 3, open: 2, done: 1, skipped: 0 })
})

test('days 夹取：0→1、200→90、缺省 7；窗口只取最近 N 天（跨月正确）', async (t) => {
  // 纯函数：边界与非法输入
  assert.equal(clampDays(0), DOTS_MIN_DAYS)
  assert.equal(clampDays(-5), DOTS_MIN_DAYS)
  assert.equal(clampDays(200), DOTS_MAX_DAYS)
  assert.equal(clampDays(undefined), DOTS_DEFAULT_DAYS)
  assert.equal(clampDays(null), DOTS_DEFAULT_DAYS)
  assert.equal(clampDays('abc'), DOTS_DEFAULT_DAYS)
  assert.equal(clampDays('30'), 30, '字符串数字不报错')
  assert.equal(clampDays(7.9), 7, '小数截断')
  assert.equal(clampDays(1), 1)
  assert.equal(clampDays(90), 90)
  assert.deepEqual(recentDateKeys(NOW(), 3), ['2026-11-15', '2026-11-14', '2026-11-13'])
  assert.deepEqual(recentDateKeys(new Date('2026-12-02T12:00:00+08:00'), 3), [
    '2026-12-02',
    '2026-12-01',
    '2026-11-30',
  ])

  // 实数据：92 天各 1 条 → days:200 只保留 90 天（从今天往回数 89 天）
  const repo = await tempDir(t)
  for (let offset = 0; offset < 92; offset += 1) {
    const date = new Date(NOW().getFullYear(), NOW().getMonth(), NOW().getDate() - offset)
    const key = dateKeyOf(date)
    await writeDay(repo, 'pc-a', key, [record({ id: `day-${offset}`, ts: `${key}T09:00:00+08:00`, title: `第 ${offset} 天` })])
  }
  const capped = await aggregateDots({ repoDir: repo, deviceId: 'pc-a', days: 200, now: NOW })
  assert.equal(capped.days.length, DOTS_MAX_DAYS, '200 天夹到 90 天')
  assert.equal(capped.totals.days, 90)
  assert.equal(capped.days[0].dateKey, '2026-11-15')
  const oldestKey = dateKeyOf(new Date(NOW().getFullYear(), NOW().getMonth(), NOW().getDate() - 89))
  assert.equal(capped.days[89].dateKey, oldestKey)
  assert.equal(capped.days.some((day) => day.dateKey === dateKeyOf(new Date(NOW().getFullYear(), NOW().getMonth(), NOW().getDate() - 90))), false)

  // 只取最近 1 天
  const single = await aggregateDots({ repoDir: repo, deviceId: 'pc-a', days: 0, now: NOW })
  assert.equal(single.days.length, 1, '0 夹到 1 天')
  assert.equal(single.days[0].dateKey, '2026-11-15')
})

test('aggregateDots：坏行跳过且不崩，计入 totals.skipped 并带行号定位', async (t) => {
  const repo = await tempDir(t)
  await writeDay(repo, 'pc-a', DATE, [
    record({ id: 'ok-1', ts: `${DATE}T09:00:00+08:00`, title: '好行一' }),
    '这不是 JSON{',
    JSON.stringify({ id: 'bad-1', ts: `${DATE}T10:00:00+08:00`, title: '缺字段' }),
    record({ id: 'ok-2', ts: `${DATE}T11:00:00+08:00`, title: '好行二', done: true }),
  ])

  const aggregate = await aggregateDots({ repoDir: repo, deviceId: 'pc-a', now: NOW })
  assert.equal(aggregate.days.length, 1)
  assert.equal(aggregate.days[0].total, 2, '两条好行照常统计')
  assert.equal(aggregate.days[0].open, 1)
  assert.equal(aggregate.days[0].done, 1)
  assert.equal(aggregate.totals.skipped, 2, '坏行计数不丢')
  assert.equal(aggregate.totals.records, 2)
  assert.equal(aggregate.skippedDetails.length, 2)
  assert.match(aggregate.skippedDetails[0], /devices\/pc-a\/schedules\/2026-11-15\.jsonl:2/)
  assert.match(aggregate.skippedDetails[0], /不是合法 JSON/)
  assert.match(aggregate.skippedDetails[1], /:3 /)
  assert.match(aggregate.skippedDetails[1], /字段校验失败/)
})

test('digestDay：topTitles 未完成优先、按 ts 倒序、去重、最多 3 条', async () => {
  // 4 条未完成 + 1 条已完成（已完成 ts 最新，但未完成必须排在前面）
  const day = digestDay(DATE, [
    record({ id: 't1', ts: `${DATE}T20:00:00+08:00`, title: '开会' }),
    record({ id: 't2', ts: `${DATE}T21:00:00+08:00`, title: '写周报' }),
    record({ id: 't3', ts: `${DATE}T22:00:00+08:00`, title: '开会' }), // 同标题去重
    record({ id: 't4', ts: `${DATE}T18:00:00+08:00`, title: '第 4 个未完成' }),
    record({ id: 't5', ts: `${DATE}T23:30:00+08:00`, title: '已完成 A', done: true }),
  ])
  assert.deepEqual(day.topTitles, ['开会', '写周报', '第 4 个未完成'])
  assert.equal(day.total, 5)
  assert.equal(day.open, 4)
  assert.equal(day.done, 1)

  // 未完成不足 3 条时用已完成补齐（两组内部各自按 ts 倒序）
  const mixed = digestDay(DATE, [
    record({ id: 'm1', ts: `${DATE}T09:00:00+08:00`, title: '唯一未完成' }),
    record({ id: 'm2', ts: `${DATE}T23:00:00+08:00`, title: '完成 1', done: true }),
    record({ id: 'm3', ts: `${DATE}T22:00:00+08:00`, title: '完成 2', done: true }),
    record({ id: 'm4', ts: `${DATE}T21:00:00+08:00`, title: '完成 3', done: true }),
  ])
  assert.deepEqual(mixed.topTitles, ['唯一未完成', '完成 1', '完成 2'])

  assert.equal(digestDay(DATE, []), null, '空白天不进快照')
})

/* -------------------------------------------------------------------------- */
/* DSH 状态                                                                    */
/* -------------------------------------------------------------------------- */

test('DSH 状态：取不到时 reachable=false + detail 可读，不编造会话字段/版本；探针注入才出现', async (t) => {
  const repo = await tempDir(t)
  const savedVersion = process.env.DSH_VERSION
  delete process.env.DSH_VERSION
  try {
    // 默认：没有任何会话证据
    const plain = buildDshStatus()
    assert.equal(plain.reachable, false)
    assert.equal(plain.mode, 'unknown')
    assert.equal(typeof plain.detail, 'string')
    assert.ok(plain.detail.length >= 8, 'detail 必须是人能看懂的原因')
    for (const field of ['sessionCount', 'activeSessionTitle', 'busy', 'lastActivityAt', 'version']) {
      assert.equal(field in plain, false, `不许编造 ${field}`)
    }

    // 经 Git 工作副本读到：通道可证，但会话态仍未探测
    const viaGit = buildDshStatus({ gitBridge: true, version: 'unknown' })
    assert.equal(viaGit.reachable, false)
    assert.equal(viaGit.mode, 'git-bridge')
    assert.equal('version' in viaGit, false, '版本探测不出来就不写')
    assert.match(viaGit.detail, /sessions/)
    assert.equal(buildDshStatus({ gitBridge: true, version: '1.2.3' }).version, '1.2.3')

    // 快照层：空仓库也是"没有数据"，不是错误
    const snapshot = await collectDotsSnapshot({ repoDir: repo, deviceId: 'pc-a', now: NOW })
    assert.deepEqual(snapshot.days, [])
    assert.deepEqual(snapshot.totals, { days: 0, records: 0, open: 0, done: 0, skipped: 0 })
    assert.equal(snapshot.dsh.reachable, false)
    assert.equal(snapshot.dsh.mode, 'git-bridge')
    assert.equal(snapshot.dsh.sessionCount, undefined)

    // 有探针（将来接 sessions 服务）时才出现会话字段
    const probed = await collectDotsSnapshot({
      repoDir: repo,
      deviceId: 'pc-a',
      now: NOW,
      dsh: async () => ({
        reachable: true,
        mode: 'http-remote',
        sessionCount: 3,
        activeSessionTitle: '写 DSH-dots 设计稿',
        busy: true,
        lastActivityAt: '2026-11-15T21:00:00+08:00',
        version: '4.5.6',
        detail: '来自 sessions 服务',
      }),
    })
    assert.deepEqual(probed.dsh, {
      reachable: true,
      mode: 'http-remote',
      sessionCount: 3,
      activeSessionTitle: '写 DSH-dots 设计稿',
      busy: true,
      lastActivityAt: '2026-11-15T21:00:00+08:00',
      version: '4.5.6',
      detail: '来自 sessions 服务',
    })

    // 探针给出脏值：能证实的才留，其余丢掉（不把垃圾透传给手机）
    const garbage = await collectDotsSnapshot({
      repoDir: repo,
      deviceId: 'pc-a',
      now: NOW,
      dsh: () => ({ reachable: 'yes', mode: 'weird', sessionCount: -1, version: 'unknown' }),
    })
    assert.equal(garbage.dsh.reachable, false)
    assert.equal(garbage.dsh.mode, 'unknown')
    for (const field of ['sessionCount', 'version']) assert.equal(field in garbage.dsh, false)
  } finally {
    if (savedVersion === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = savedVersion
  }
})

test('emptyDotsSnapshot：没有数据时日程为空数组、DSH 说明可读（不报错）', async () => {
  const snapshot = emptyDotsSnapshot({ deviceId: 'pc-a', days: 7, now: NOW })
  assert.equal(snapshot.generatedAt, NOW_ISO)
  assert.equal(snapshot.deviceId, 'pc-a')
  assert.deepEqual(snapshot.days, [])
  assert.deepEqual(snapshot.totals, { days: 0, records: 0, open: 0, done: 0, skipped: 0 })
  assert.equal(snapshot.dsh.reachable, false)
  assert.equal(snapshot.dsh.mode, 'unknown')
  assert.match(snapshot.note, /没有可聚合的日程数据/)
  assert.match(snapshot.dsh.detail, /没有可聚合的日程数据/)
})

test('aggregateDots：文件系统异常 → E_DOTS_IO（可读错误码，不吞）', async (t) => {
  const repo = await tempDir(t)
  // devices 是普通文件而不是目录 → readdir ENOTDIR
  await writeFile(path.join(repo, 'devices'), 'not a directory\n', 'utf8')
  await assert.rejects(
    () => aggregateDots({ repoDir: repo, deviceId: 'pc-a', now: NOW }),
    (error) => {
      assert.equal(error.code, 'E_DOTS_IO', `应报 E_DOTS_IO，实际：${error.code} ${error.message}`)
      assert.match(error.message, /devices\//)
      return true
    },
  )

  // 当天的文件其实是目录 → readFile 失败也要 E_DOTS_IO
  const repo2 = await tempDir(t)
  await mkdir(path.join(repo2, 'devices', 'pc-a', 'schedules', `${DATE}.jsonl`), { recursive: true })
  await assert.rejects(
    () => aggregateDots({ repoDir: repo2, deviceId: 'pc-a', now: NOW }),
    (error) => {
      assert.equal(error.code, 'E_DOTS_IO')
      assert.match(error.message, /2026-11-15\.jsonl/)
      return true
    },
  )
})

/* -------------------------------------------------------------------------- */
/* 工具层（真实仓库）                                                          */
/* -------------------------------------------------------------------------- */

test('工具层：dsh_dots 注册、days 夹取、跨设备快照字段齐全（真实仓库，只读）', async (t) => {
  const { root, bare } = await setupRepo(t)
  const paths = statePaths(path.join(root, 'home'))
  const { registered, ctx, store } = registerTools(paths, 'pc-a')
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['schedule_list', 'schedule_add', 'schedule_summary', 'dsh_dots'],
  )
  assert.equal(ctx.effects.length, 4, '每个工具注册都要挂在 ctx.effect 上')

  const dotsTool = registered.find((tool) => tool.name === 'dsh_dots')
  assert.equal(typeof dotsTool.execute, 'function')
  assert.equal(typeof dotsTool.output.render, 'function')
  for (const schema of [dotsTool.parameters, dotsTool.output.schema]) {
    assertSealedObjects(schema, 'dsh_dots')
  }
  assert.equal(dotsTool.parameters.properties.days.type, 'integer')
  assert.match(dotsTool.description, /跨设备聚合/)
  assert.match(dotsTool.description, /最近 N 天/)

  const settings = store.readSettings()
  store.writeSettings({
    ...settings,
    repoUrl: bare,
    platform: 'custom',
    authMode: 'https',
    branch: 'main',
    deviceId: 'pc-a',
  })
  const headBefore = (await git(path.dirname(bare), ['--git-dir', bare, 'rev-parse', 'main'])).trim()

  const savedVersion = process.env.DSH_VERSION
  process.env.DSH_VERSION = '9.9.9-dots'
  try {
    const snapshot = await dotsTool.execute({})
    assert.equal(snapshot.generatedAt, NOW_ISO)
    assert.equal(snapshot.deviceId, 'pc-a')
    assert.deepEqual(
      snapshot.days.map((day) => day.dateKey),
      ['2026-11-15', '2026-11-14'],
      '跨设备（pc-a + pad-1）聚合，按 dateKey 倒序',
    )
    assert.deepEqual(snapshot.totals, { days: 2, records: 4, open: 2, done: 2, skipped: 0 })
    assert.deepEqual(snapshot.days[0].topTitles, ['PC 未完成', '平板未完成', 'PC 已完成'])
    assert.equal(snapshot.dsh.reachable, false, '没有会话证据时为 false（不编造）')
    assert.equal(snapshot.dsh.mode, 'git-bridge', '数据通道可证')
    assert.equal(snapshot.dsh.version, '9.9.9-dots', '版本来自 detectDshVersion()，不是编的')
    assert.match(snapshot.dsh.detail, /会话级状态未探测/)

    // days:0 → 1（只今天）；days:200 → 90（不报错，仍覆盖全部有记录的天）
    const todayOnly = await dotsTool.execute({ days: 0 })
    assert.deepEqual(
      todayOnly.days.map((day) => day.dateKey),
      ['2026-11-15'],
    )
    assert.equal(todayOnly.totals.records, 3)
    const huge = await dotsTool.execute({ days: 200 })
    assert.deepEqual(
      huge.days.map((day) => day.dateKey),
      ['2026-11-15', '2026-11-14'],
    )

    const rendered = dotsTool.output.render({}, snapshot)[0]
    assert.equal(rendered.type, 'text')
    assert.match(rendered.text, /DSH-dots 快照/)
    assert.match(rendered.text, /2026-11-15 · 3 条/)
    assert.match(rendered.text, /reachable=false · mode=git-bridge · version=9\.9\.9-dots/)
  } finally {
    if (savedVersion === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = savedVersion
  }

  const headAfter = (await git(path.dirname(bare), ['--git-dir', bare, 'rev-parse', 'main'])).trim()
  assert.equal(headAfter, headBefore, 'dsh_dots 只读：不得产生提交/推送')
})

test('工具层：dsh_dots 未配置仓库地址时不报错（空数组 + DSH 说明可读）', async (t) => {
  const root = await tempDir(t, 'gcs-dots-norepo-')
  const paths = statePaths(path.join(root, 'home'))
  const { registered } = registerTools(paths, 'pc-a')
  const dotsTool = registered.find((tool) => tool.name === 'dsh_dots')

  const snapshot = await dotsTool.execute({ days: 30 })
  assert.deepEqual(snapshot.days, [])
  assert.deepEqual(snapshot.totals, { days: 0, records: 0, open: 0, done: 0, skipped: 0 })
  assert.equal(snapshot.deviceId, 'pc-a')
  assert.equal(snapshot.dsh.reachable, false)
  assert.equal(snapshot.dsh.mode, 'unknown')
  assert.match(snapshot.note, /尚未配置仓库地址/)
  assert.match(snapshot.dsh.detail, /sessions/)
  assert.equal(dotsTool.output.render({}, snapshot)[0].type, 'text')
})
