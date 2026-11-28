/**
 * 模型侧工具的 v2 时间线桥（`mod-plugin-tools-v2`）。
 *
 * 本文件把 `schedule_list` / `schedule_add` / `schedule_summary` / `dsh_dots` 从 v1
 * `devices/<deviceId>/schedules/<date>.jsonl` 迁到 v2 单时间线：
 * `timeline/<date>/records.json` + 三本账本 + `timeline/schema.json`。
 *
 * 纪律（绑定条件逐条落地）：
 *   1. 写字节**只**经 `src/timeline/records.ts` 的 `canonicalRecordLine` 产出意图行，
 *      日文件全文由 `buildRecordsText` 产出；本文件不拼任何 JSONL 字节；
 *   2. 写必须经 `runV2Cycle`（同一套门禁：schema → main → fetch → HEAD==origin/main），
 *      push 失败只把意图停在仓库外 outbox 并抛 typed 错，**绝不报成功**；
 *   3. 读只认 `closed_at` 缺省为未完成，折叠 / 账本优先级全部走共享读侧纯函数；
 *   4. v1 `devices/**` 在读写两侧都不参与：不读、不迁移、不删除；
 *   5. 工具名与入参形状不变；`add()` 的返回键不变，仅语义随 v2 路径调整（见报告）。
 *
 * v1 `src/schedule/bridge.ts` 原样保留（`addSchedule` 等自由函数与历史测试仍用它），
 * 本模块是**工具专用**的替代桥，不改写、不删除 v1 的任何代码。
 */
import path from 'node:path'
import { SyncError, errorMessage } from '../engine/errors.js'
import type { StatePaths } from '../engine/paths.js'
import type { SyncSettings } from '../engine/types.js'
import { NodeTimelineFs } from '../timeline/write.js'
import type { TimelineFs } from '../timeline/write.js'
import {
  canonicalRecordLine,
  decideFreshStart,
  parseLedger,
  parseTimelineDay,
  visibleRecords,
} from '../timeline/records.js'
import type { TimelineRecord } from '../timeline/records.js'
import {
  SCHEMA_MARKER_PATH,
  timelineDeletedPath,
  timelineRecordsPath,
  timelineRestorePath,
} from '../timeline/paths.js'
import {
  V2_ERROR,
  enqueueIntent,
  gateOfFacts,
  makeIntentId,
  runV2Cycle,
} from '../sync/cycle.js'
import type { OutboxIntent, OutboxPort, V2GitPort } from '../sync/cycle.js'
import { createDefaultMarkSynced, stampIfSynced } from '../sync/bootstrap.js'
import type { MarkSyncedFn } from '../sync/bootstrap.js'
import { GitRepoV2Port } from '../sync/gitPort.js'
import { NodeOutboxPort } from '../sync/outbox.js'
import { ensureRepoRoot, resolveV2RepoDirDetailed } from '../sync/repoPath.js'
import type { RepoRootLogger } from '../sync/repoRoot.js'
import { aiOptionsFromEnv } from './bridge.js'
import type { ScheduleAiOptions } from './bridge.js'
import { localDateKey, newRecordId, nowIso } from './clock.js'
import { BODY_PREVIEW_LIMIT } from './types.js'
import type {
  AddScheduleInput,
  AddScheduleResult,
  AiPayload,
  ScheduleRecord,
  ScheduleSummary,
  SummaryResult,
} from './types.js'
import {
  SUMMARY_SYSTEM_PROMPT,
  buildAiPrompt,
  buildDaySummaryPayload,
  currentTimeZone,
} from './aiPayload.js'
import {
  AI_STATUS_NETWORK,
  AI_STATUS_TIMEOUT,
  buildAiRequest,
  classifyAiError,
  parseAiReply,
} from './aiRequest.js'

/** 共享工作副本 + 注入端口：测试可整体替换，生产由 `buildV2Ports()` 装配。 */
export interface V2SchedulePorts {
  /** 仓库根目录（App 的 `git-repo/`，v2 唯一工作副本）。 */
  repoDir: string
  fs: TimelineFs
  git: V2GitPort
  outbox: OutboxPort
}

export interface V2ScheduleBridgeOptions {
  ports: V2SchedulePorts
  /** 本机 deviceId；v2 时间线不分设备命名空间，仅用于返回值与快照标注。 */
  deviceId: string
  now?: () => Date
  ai?: ScheduleAiOptions | null
  /**
   * mod-plugin-v2-marksynced：周期成功后落戳的窄回调（测试可塞 spy）。
   * 不注入时用下面 paths 造 createDefaultMarkSynced(paths, now)，与 V2SyncRuntime 共用同一实现。
   */
  markSynced?: MarkSyncedFn
  /** 默认落戳器写 state.json 的位置；由 V2WorkspaceOptions.paths 在装配处透传。 */
  paths?: StatePaths
}

/** v2 读结果：`deviceIds` 保留旧字段但只有共享时间线一个来源。 */
export interface V2ReadSchedulesResult {
  date: string
  deviceIds: string[]
  records: TimelineRecord[]
  /** v2 读路径不 pull/rebase；恒为 false，原因写进 `note`。 */
  refreshed: boolean
  note?: string
  errors: string[]
}

/** v2 `list` 的结果（与 v1 `ListSchedulesResult` 同键，逐字段由 v2 记录派生）。 */
export interface V2ListSchedulesResult {
  date: string
  deviceIds: string[]
  records: ScheduleSummary[]
  refreshed: boolean
  note?: string
  errors: string[]
}

const READ_NOTE = 'v2 时间线只读本地共享工作副本（timeline/**）；不 pull、不 rebase，远端更新由同步周期拉取'

/** `closed_at` 缺省（缺席 / null / 空串 / 纯空白）即未完成；绝不用 `done`。 */
export function isOpenRecord(record: TimelineRecord): boolean {
  const closed: unknown = record.closed_at
  return closed === undefined || closed === null || (typeof closed === 'string' && closed.trim().length === 0)
}

/** v2 记录 → 摘要（正文只给前 80 字；`done` 由 closed_at 派生，不信记录里的 done 字段）。 */
export function summarizeV2(record: TimelineRecord, deviceId: string): ScheduleSummary {
  const body = typeof record.body === 'string' ? record.body : ''
  const clipped = body.length > BODY_PREVIEW_LIMIT
  return {
    id: record.id,
    ts: record.ts,
    date: typeof record.ts === 'string' ? record.ts.slice(0, 10) : '',
    deviceId,
    title: typeof record.title === 'string' ? record.title : '',
    author: typeof record.author === 'string' ? record.author : '',
    done: !isOpenRecord(record),
    bodyPreview: clipped ? `${body.slice(0, BODY_PREVIEW_LIMIT)}…` : body,
    bodyLength: body.length,
    hasAttachments: Array.isArray(record.media) && record.media.length > 0,
    aiProcessed: record.ai_processed === true,
  }
}

/** v2 记录 → v1 形状（仅喂给既有的 AI 载荷/提示词构造器，不写盘）。 */
function toScheduleLike(record: TimelineRecord): ScheduleRecord {
  const out: ScheduleRecord = {
    id: record.id,
    ts: record.ts,
    title: typeof record.title === 'string' ? record.title : '',
    body: typeof record.body === 'string' ? record.body : '',
    author: typeof record.author === 'string' ? record.author : '',
    done: !isOpenRecord(record),
    ai_processed: record.ai_processed === true,
  }
  if (typeof record.ocr_text === 'string') out.ocr_text = record.ocr_text
  if (typeof record.ai_structured === 'string') out.ai_structured = record.ai_structured
  if (typeof record.ocr_time === 'string') out.ocr_time = record.ocr_time
  return out
}

/**
 * v2 记录构造器：与 App `timelineWriteStore.ets:356-399` 的 `toTimelineRecord` 同口径。
 * 新记录 done=false 且不带 closed_at ⇒ 未完成；media 必为空数组、opened_at=ts。
 */
export function newTimelineRecord(id: string, ts: string, input: AddScheduleInput): TimelineRecord {
  const record: TimelineRecord = {
    id,
    ts,
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
    author: typeof input.author === 'string' && input.author.trim() !== '' ? input.author.trim() : '我',
    done: false,
    media: [],
    ai_processed: false,
    opened_at: ts,
  }
  return record
}

export class V2ScheduleBridge {
  readonly repoDir: string
  readonly deviceId: string
  readonly ports: V2SchedulePorts
  private readonly now: () => Date
  private readonly ai: ScheduleAiOptions | null
  private readonly markSynced: MarkSyncedFn

  constructor(options: V2ScheduleBridgeOptions) {
    this.ports = options.ports
    this.repoDir = options.ports.repoDir
    this.deviceId = options.deviceId
    this.now = options.now ?? ((): Date => new Date())
    this.ai = options.ai != null && options.ai.apiKey !== '' ? options.ai : null
    // 缺省落戳器来自 bootstrap 的具名工厂，绝不在此重写「何时算同步」。
    // 没有 paths 的内存夹具没有 state.json：落戳器为空操作，保持既有测试语义。
    this.markSynced = options.markSynced ?? (options.paths !== undefined
      ? createDefaultMarkSynced(options.paths, this.now)
      : (): void => { /* 无 state.json 可写 */ })
  }

  /** 今天的日期键（本机时区）。 */
  today(): string {
    return localDateKey(this.now())
  }

  /* ------------------------------------------------------------------ 读 */

  /** 读一日可见记录：目录日期权威、折叠走共享读侧、账本按 App 的 D/R 优先级过滤。 */
  async read(date: string): Promise<V2ReadSchedulesResult> {
    const key = typeof date === 'string' ? date.trim() : ''
    const parsedText = await this.readText(timelineRecordsPath(key))
    const parsed = parseTimelineDay(parsedText, key)
    const deletions = parseLedger(await this.readText(timelineDeletedPath(key))).entries
    const restores = parseLedger(await this.readText(timelineRestorePath(key))).entries
    const day = parsed.day ?? { date: key, open: [], allRecords: [] }
    const visible = visibleRecords(day, deletions, restores)
    visible.sort((left, right) => {
      const a = Date.parse(left.ts)
      const b = Date.parse(right.ts)
      if (Number.isFinite(a) && Number.isFinite(b)) return a - b
      return left.ts < right.ts ? -1 : (left.ts > right.ts ? 1 : 0)
    })
    const result: V2ReadSchedulesResult = {
      date: key,
      deviceIds: [this.deviceId],
      records: visible,
      refreshed: false,
      errors: parsed.errors.map((error) => `${timelineRecordsPath(key)}:${error.line} ${error.message}`),
      note: READ_NOTE,
    }
    return result
  }

  /** 列表：字段与 v1 同名同形，`done` 由 closed_at 派生。`deviceIdOrAll` 仅为兼容保留。 */
  async list(_deviceIdOrAll: string, date: string): Promise<V2ListSchedulesResult> {
    const read = await this.read(date)
    return {
      date: read.date,
      deviceIds: read.deviceIds,
      records: read.records.map((record) => summarizeV2(record, this.deviceId)),
      refreshed: read.refreshed,
      errors: read.errors,
      note: read.note,
    }
  }

  /** 汇总：载荷/提示词复用既有构造器，可选真调 AI（失败只写 aiNote，不抛）。 */
  async summary(_deviceIdOrAll: string, date: string): Promise<SummaryResult> {
    const read = await this.read(date)
    const payload: AiPayload = buildDaySummaryPayload(
      read.date,
      read.records.map(toScheduleLike),
    )
    const now = this.now()
    const prompt = buildAiPrompt(payload, nowIso(now), currentTimeZone(now))
    const result: SummaryResult = {
      date: read.date,
      deviceIds: read.deviceIds,
      count: payload.records.length,
      payload,
      prompt,
      summary: null,
      refreshed: read.refreshed,
    }
    if (read.note !== undefined) result.note = read.note
    if (payload.records.length === 0) {
      result.aiNote = '当天没有记录，未调用 AI'
      return result
    }
    if (this.ai === null) {
      result.aiNote =
        '未配置 AI 密钥（设置环境变量 DSH_SCHEDULE_AI_KEY 或 DEEPSEEK_API_KEY 后可直接返回摘要）；' +
        'prompt 字段已给出可直接使用的提示词'
      return result
    }
    try {
      result.summary = await callAi(this.ai, prompt)
      return result
    } catch (error) {
      result.aiNote = `AI 调用失败：${errorMessage(error)}`
      return result
    }
  }

  /* ------------------------------------------------------------------ 写 */

  /**
   * 新建一条日程：先过只读门禁（schema/分支），再把规范行放进仓库外 outbox，
   * 最后跑完整 v2 周期。周期失败（含 push 被拒）一律抛 typed 错，意图留在 outbox。
   */
  async add(deviceId: string, date: string, input: AddScheduleInput): Promise<AddScheduleResult> {
    if (deviceId !== this.deviceId) {
      throw new SyncError('E_VALIDATION', `只允许写本机标识：本机是 ${this.deviceId}，收到 ${deviceId}`, {
        deviceId,
        expected: this.deviceId,
      })
    }
    const day = typeof date === 'string' ? date.trim() : ''
    // 门禁前置：未知 schema / 非 main 在**任何写入之前** typed 拒绝（零写仓库、零写 outbox）。
    const schemaText = await this.readText(SCHEMA_MARKER_PATH)
    const pre = gateOfFacts(schemaText, await this.ports.git.branchName(), '', '')
    if (pre.code === V2_ERROR.SCHEMA_UNKNOWN || pre.code === V2_ERROR.BRANCH_MISMATCH) {
      throw new SyncError(pre.code, pre.message)
    }

    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title === '') throw new SyncError('E_VALIDATION', 'title 不能为空')
    const now = this.now()
    const ts = nowIso(now)
    const existingText = await this.readText(timelineRecordsPath(day))
    const parsed = parseTimelineDay(existingText, day)
    const usedIds = new Set<string>((parsed.day?.allRecords ?? []).map((record) => record.id))
    for (const entry of await this.ports.outbox.load()) {
      if (entry.date === day) usedIds.add(entry.id)
    }
    let id = newRecordId(now)
    let attempt = 0
    while (usedIds.has(id)) {
      attempt += 1
      if (attempt > 32) throw new SyncError('E_INTERNAL', '无法生成唯一 id（同日 32 次碰撞）')
      id = `${newRecordId(now)}-${attempt.toString(36)}`
    }
    const record = newTimelineRecord(id, ts, {
      title,
      ...(typeof input.body === 'string' && input.body !== '' ? { body: input.body } : {}),
      ...(typeof input.author === 'string' && input.author !== '' ? { author: input.author } : {}),
    })
    // 唯一序列化入口：规范行来自共享序列化器，本文件不拼 JSONL。
    const line = canonicalRecordLine(record)
    const intent: OutboxIntent = {
      intentId: makeIntentId(day, id, ts, 'upsert'),
      op: 'upsert',
      date: day,
      id,
      ts,
      line,
      enqueuedAt: ts,
      attempts: 0,
      state: 'pending',
      lastError: '',
    }
    await this.ports.outbox.save(enqueueIntent(await this.ports.outbox.load(), intent))
    const cycle = await runV2Cycle({
      days: [day],
      git: this.ports.git,
      fs: this.ports.fs,
      outbox: this.ports.outbox,
      now,
    })
    if (!cycle.ok) {
      // push 失败 / 门禁失败：意图已由 cycle 停放（attempts+1），绝不把本地提交报成成功。
      // 失败分支在这里直接抛 SyncError、不返回：没有东西到达远端，state.json 必须保持原样，
      // 因此下面唯一的落戳调用只在 cycle.ok 的成功分支上，失败路径无处可戳。
      throw new SyncError(cycle.code, cycle.message, { writtenPaths: cycle.writtenPaths, cycle })
    }
    // 与 V2SyncRuntime.runCycle 共用同一判据/落戳对：成功周期恰好一戳。
    // no-op（writtenPaths 为空 ⇒ attempts 保持 0）被 shouldMarkSynced 拒绝，绝不「没写入也宣称同步」。
    try {
      stampIfSynced(cycle, this.markSynced)
    } catch {
      /* 落戳失败只影响 UI 展示，绝不改变工具返回值 */
    }
    const commit = cycle.writtenPaths.length > 0 ? await this.ports.git.headSha() : ''
    return {
      id,
      ts,
      date: day,
      deviceId,
      path: timelineRecordsPath(day),
      commit,
      pushed: true,
      rebased: false,
      files: cycle.writtenPaths.slice(),
    }
  }

  /* ------------------------------------------------------------------ 内部 */

  /** 读文件；不存在返回空串（"没有记录"不是错误）；其它 IO 失败 typed E_IO。 */
  private async readText(rel: string): Promise<string> {
    try {
      return (await this.ports.fs.read(rel)) ?? ''
    } catch (error) {
      throw new SyncError('E_IO', `读取 v2 时间线失败：${rel}（${errorMessage(error)}）`, { path: rel })
    }
  }
}

/* ------------------------------------------------------------------ 装配 */

export interface V2PortsAssemblyOptions {
  paths: StatePaths
  settings: SyncSettings
  token: string | null
  /** 已废弃注入通道（等价于 DSH_DOTS_APP_FILES_DIR）；DSH_DOTS_REPO_ROOT 优先。 */
  appFilesDir?: string
  /** 显式覆盖完整仓库目录（集成测试用）。 */
  repoDir?: string
  /** 显式 homeDir；缺省从 paths.root 反推（`<home>/.dsh/dots`）。 */
  homeDir?: string
  /** 宿主 logger（可选）；根选择那一行只经它输出。 */
  logger?: RepoRootLogger
  allowLocalRepo?: boolean
  networkTimeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** 生产装配：PC 自持 clone 为默认根，端口与 outbox 与 sync cycle 完全同一套。 */
export function buildV2Ports(options: V2PortsAssemblyOptions): {
  ports: V2SchedulePorts
  dispose(): Promise<void>
  repoDir: string
  sharedRepoRoot: string
  /** 结构化的一行「选中哪个根 + 为什么」，宿主可直接取用，不依赖 stdout。 */
  logLine: string
} {
  const hasExplicitRepoDir = typeof options.repoDir === 'string' && options.repoDir.trim() !== ''
  const resolved = resolveV2RepoDirDetailed({
    appFilesDir: options.appFilesDir,
    repoUrl: options.settings.repoUrl,
    homeDir: options.homeDir ?? path.resolve(options.paths.root, '..', '..'),
    env: options.env ?? process.env,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(hasExplicitRepoDir ? { overrideDir: options.repoDir } : {}),
  })
  const repoDir = resolved.repoDir
  // 集成测试显式给仓库目录时不碰真实文件系统；生产默认根必须存在且可写。
  if (!hasExplicitRepoDir) ensureRepoRoot(resolved.sharedRepoRoot)
  const git = new GitRepoV2Port({
    dir: repoDir,
    repoUrl: options.settings.repoUrl,
    branch: 'main',
    authMode: options.settings.authMode,
    token: options.token,
    platform: options.settings.platform,
    username: options.settings.username ?? '',
    allowLocalRepo: options.allowLocalRepo === true,
    ...(options.networkTimeoutMs !== undefined ? { networkTimeoutMs: options.networkTimeoutMs } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  })
  const outbox = new NodeOutboxPort({ stateRoot: options.paths.root, repoUrl: options.settings.repoUrl })
  return {
    ports: { repoDir, fs: new NodeTimelineFs(repoDir), git, outbox },
    dispose: async () => await git.dispose(),
    repoDir,
    sharedRepoRoot: resolved.sharedRepoRoot,
    logLine: resolved.logLine,
  }
}

export interface V2WorkspaceOptions {
  paths: StatePaths
  settings: SyncSettings
  token: string | null
  /** 已废弃别名；新 env DSH_DOTS_REPO_ROOT 优先。 */
  appFilesDir?: string
  repoDir?: string
  homeDir?: string
  logger?: RepoRootLogger
  allowLocalRepo?: boolean
  networkTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  now?: () => Date
  ai?: ScheduleAiOptions
  /** 端口整体覆盖（测试 / 宿主显式注入）；给出时不读 env、不建真实端口。 */
  ports?: V2SchedulePorts
}

/** 每次执行都重新读设置的工厂：换仓库/设备后下一次工具调用立即生效。 */
export async function withV2ScheduleBridge<T>(
  options: V2WorkspaceOptions,
  task: (bridge: V2ScheduleBridge) => Promise<T>,
): Promise<T> {
  if (typeof options.settings.repoUrl !== 'string' || options.settings.repoUrl.trim() === '') {
    throw new SyncError('E_VALIDATION', '尚未配置仓库地址：请先在「设置 → Git 配置同步」里填写仓库地址')
  }
  if (options.ports !== undefined) {
    return await task(new V2ScheduleBridge({
      ports: options.ports,
      deviceId: options.settings.deviceId,
      ...(options.now !== undefined ? { now: options.now } : {}),
      // 生产装配的 paths 透传给默认落戳器（与 buildV2Ports 用的是同一份 paths）。
      paths: options.paths,
      ai: options.ai ?? aiOptionsFromEnv(options.env ?? process.env),
    }))
  }
  const built = buildV2Ports(options)
  try {
    // PC 自持 clone：首次调用先克隆到默认根（已有则只核对 remote）。注入端口没有 prepare，
    // 测试的内存 git 不受影响；克隆走既有 GitRepo 实现，无 rebase / 无 force / 无历史改写。
    const gitPort = built.ports.git as V2GitPort & { prepare?: () => Promise<{ cloned: boolean }> }
    if (typeof gitPort.prepare === 'function') await gitPort.prepare()
    return await task(new V2ScheduleBridge({
      ports: built.ports,
      deviceId: options.settings.deviceId,
      ...(options.now !== undefined ? { now: options.now } : {}),
      // 生产装配的 paths 透传给默认落戳器（与 buildV2Ports 用的是同一份 paths）。
      paths: options.paths,
      ai: options.ai ?? aiOptionsFromEnv(options.env ?? process.env),
    }))
  } finally {
    await built.dispose()
  }
}

/* ------------------------------------------------------------------ AI */

/** 与 v1 `bridge.ts:callAi` 同口径；此处不复用是为了让工具侧彻底脱离 v1 写桥。 */
async function callAi(options: ScheduleAiOptions, prompt: string): Promise<string> {
  let request: { url: string; body: string; timeoutMs: number }
  try {
    request = buildAiRequest(options.baseURL, options.model, prompt, undefined, SUMMARY_SYSTEM_PROMPT)
  } catch (error) {
    throw new SyncError('E_VALIDATION', errorMessage(error))
  }
  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: request.body,
      signal: AbortSignal.timeout(request.timeoutMs),
    })
  } catch (error) {
    const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    throw new SyncError('E_GIT', classifyAiError(aborted ? AI_STATUS_TIMEOUT : AI_STATUS_NETWORK, '', options.providerLabel))
  }
  const text = await response.text()
  if (!response.ok) {
    throw new SyncError('E_GIT', classifyAiError(response.status, text, options.providerLabel), { status: response.status })
  }
  try {
    return parseAiReply(text)
  } catch (error) {
    throw new SyncError('E_GIT', errorMessage(error), { status: response.status })
  }
}

/** 只判定 schema：供工具在零写入前给出 typed 拒绝（与 cycle 的门禁同口径）。 */
export function refuseUnknownSchema(schemaText: string): void {
  const decision = decideFreshStart(schemaText)
  if (decision.unsupported) throw new SyncError(decision.code, decision.reason)
}
