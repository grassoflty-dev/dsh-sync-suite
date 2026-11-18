/**
 * 日程桥：把"同一个 Git 仓库 + 本机设置 + 日程 JSONL"粘在一起。
 *
 * 目录契约（`docs/DATA-CONTRACT.md` §1，与平板侧完全一致）：
 * ```
 * <repo>/
 *   devices/desktop-xxx/{cordis.patch.yml,providers.json,plugins.json,mcp.json,manifest.json}  # 配置快照（现有流程写）
 *   devices/desktop-xxx/schedules/2026-11-15.jsonl                                             # 桌面端写的日程
 *   devices/pad-yyy/schedules/2026-11-15.jsonl                                                 # 平板写的日程（只读）
 *   devices/pad-yyy/summaries/2026-11-15.json                                                  # 平板写，PC 只读
 * ```
 *
 * 与现有配置同步共用同一个工作副本（`~/.dsh/dots/work/<repoHash>/`），
 * 所以"一个仓库装两类数据"不需要第二份配置、也不需要第二次 clone。
 *
 * 纪律：
 *   - 写只发生在 `devices/<本机 deviceId>/schedules/`，别的设备目录、`summaries/`、`..` 一律拒绝；
 *   - 写前 `pull --rebase`，冲突抛 `E_CONFLICT`（**永不 force、永不静默覆盖**）；
 *   - 提交只 `git add` 自己的 schedules 目录，不把别的设备文件带进提交；
 *   - token 只经 `GitRepo` 的环境变量/临时 askpass 传递，本文件不碰、不打印。
 */
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { SyncError, errorMessage } from '../engine/errors.js'
import { GitRepo } from '../engine/git.js'
import type { StatePaths } from '../engine/paths.js'
import { repoHash } from '../engine/paths.js'
import type { SyncSettings } from '../engine/types.js'
import type {
  AddScheduleInput,
  AddScheduleResult,
  AiPayload,
  ReadSchedulesResult,
  ScheduleRecord,
  ScheduleSummary,
  SummaryResult,
} from './types.js'
import { BODY_PREVIEW_LIMIT } from './types.js'
import { localDateKey, newRecordId, nowIso } from './clock.js'
import { encodeRecord, foldById, parseJsonl, recordDateKey, sortRecords } from './jsonl.js'
import {
  assertDateKey,
  assertDeviceId,
  assertSchedulesScope,
  resolveInsideRepo,
  scheduleRelPath,
  schedulesScope,
} from './paths.js'
import { buildDaySummaryPayload, buildAiPrompt, SUMMARY_SYSTEM_PROMPT, currentTimeZone } from './aiPayload.js'
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  buildAiRequest,
  classifyAiError,
  parseAiReply,
  AI_STATUS_NETWORK,
  AI_STATUS_TIMEOUT,
} from './aiRequest.js'

/** "全部设备"选择器。 */
export const ALL_DEVICES = 'all'

/** AI 汇总的运行期配置（key 只从环境变量读，绝不写进仓库或 settings.json）。 */
export interface ScheduleAiOptions {
  /** API key；空串 = 不调用 AI（只产出 payload + prompt）。 */
  apiKey: string
  baseURL: string
  model: string
  /** 面向用户的源名（错误文案里用）。 */
  providerLabel: string
}

/** 从环境变量读 AI 配置：`DSH_SCHEDULE_AI_KEY` 优先，其次通用的 `DEEPSEEK_API_KEY`。 */
export function aiOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ScheduleAiOptions {
  const key = (env.DSH_SCHEDULE_AI_KEY ?? env.DEEPSEEK_API_KEY ?? '').trim()
  return {
    apiKey: key,
    baseURL: (env.DSH_SCHEDULE_AI_BASE_URL ?? DEFAULT_AI_BASE_URL).trim() || DEFAULT_AI_BASE_URL,
    model: (env.DSH_SCHEDULE_AI_MODEL ?? DEFAULT_AI_MODEL).trim() || DEFAULT_AI_MODEL,
    providerLabel: '日程 AI',
  }
}

export interface ScheduleBridgeOptions {
  repo: GitRepo
  /** 本机 deviceId（= settings.deviceId）；只有它能被写。 */
  deviceId: string
  now?: () => Date
  /** AI 配置；缺省不调用 AI。 */
  ai?: ScheduleAiOptions
}

/** 一条记录 + 它来自哪个设备目录。 */
export interface OwnedRecord {
  record: ScheduleRecord
  deviceId: string
}

/** 一次"尽力刷新"的结果（读路径共用：失败降级成 note，不抛错）。 */
export interface RefreshResult {
  refreshed: boolean
  note?: string
}

/** `list` 的返回（`docs/SCHEDULE-BRIDGE.md` 的工具签名用同一形状）。 */
export interface ListSchedulesResult {
  date: string
  deviceIds: string[]
  records: ScheduleSummary[]
  refreshed: boolean
  note?: string
  errors: string[]
}

export class ScheduleBridge {
  readonly repo: GitRepo
  readonly deviceId: string
  private readonly now: () => Date
  private readonly ai: ScheduleAiOptions | null

  constructor(options: ScheduleBridgeOptions) {
    this.repo = options.repo
    this.deviceId = assertDeviceId(options.deviceId)
    this.now = options.now ?? ((): Date => new Date())
    this.ai = options.ai !== undefined && options.ai.apiKey !== '' ? options.ai : null
  }

  /** 今天的日期键（本机时区）。 */
  today(): string {
    return localDateKey(this.now())
  }

  /* ------------------------------------------------------------------ */
  /* 读                                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * 读某天的记录（折叠后）并标注来源设备。
   *
   * 读之前会尽力 `pull --rebase`：工作副本干净才拉，拉失败只记 `note`（读不是写，
   * 不该因为网络不可达就失败）；脏工作副本直接跳过拉取，避免 rebase 撞上未提交改动。
   */
  async readDetailed(deviceIdOrAll: string, date: string): Promise<{
    date: string
    deviceIds: string[]
    items: OwnedRecord[]
    refreshed: boolean
    note?: string
    errors: string[]
  }> {
    const day = assertDateKey(date)
    const selector =
      typeof deviceIdOrAll === 'string' && deviceIdOrAll.trim() !== '' ? deviceIdOrAll.trim() : this.deviceId
    // 先确保工作副本存在，再枚举设备目录（否则首次调用会只看到本机）。
    await this.repo.ensureWorkTree()
    const deviceIds = selector === ALL_DEVICES ? await this.deviceDirs() : [assertDeviceId(selector)]
    const refresh = await this.tryRefresh()

    const items: OwnedRecord[] = []
    const errors: string[] = []
    for (const id of deviceIds) {
      const relative = scheduleRelPath(id, day)
      let absolute: string
      try {
        absolute = resolveInsideRepo(this.repo.dir, relative)
      } catch (error) {
        errors.push(`${relative}: ${errorMessage(error)}`)
        continue
      }
      const text = await readTextIfExists(absolute)
      const parsed = parseJsonl(text)
      for (const item of parsed.errors) errors.push(`${relative}:${item.line} ${item.message}`)
      for (const record of sortRecords(foldById(parsed.records))) {
        // 记录必须归属当天：跨设备阅读时 ts 的日期才是权威，不信文件名。
        if (recordDateKey(record.ts) !== day) continue
        items.push({ record, deviceId: id })
      }
    }
    items.sort((left, right) => Date.parse(left.record.ts) - Date.parse(right.record.ts))
    const result: { date: string; deviceIds: string[]; items: OwnedRecord[]; refreshed: boolean; note?: string; errors: string[] } = {
      date: day,
      deviceIds,
      items,
      refreshed: refresh.refreshed,
      errors,
    }
    if (refresh.note !== undefined) result.note = refresh.note
    return result
  }

  /**
   * 读路径的"尽力刷新"入口：干净工作副本才 `pull --rebase`，任何失败都降级成 `note`。
   *
   * 抽成公开方法是为了让跨天聚合（`dsh_dots`）复用同一套刷新语义，
   * 而不是再写一份 status/pull 的判定（两处判定迟早会漂移）。
   */
  async refreshForRead(): Promise<RefreshResult> {
    return this.tryRefresh()
  }

  /** 读某天的记录（不带来源设备，只要记录本身）。 */
  async read(deviceIdOrAll: string, date: string): Promise<ReadSchedulesResult> {
    const detailed = await this.readDetailed(deviceIdOrAll, date)
    const result: ReadSchedulesResult = {
      date: detailed.date,
      deviceIds: detailed.deviceIds,
      records: detailed.items.map((item) => item.record),
      refreshed: detailed.refreshed,
      errors: detailed.errors,
    }
    if (detailed.note !== undefined) result.note = detailed.note
    return result
  }

  /**
   * 读某天的记录并压成摘要数组（正文只给前 80 字）。
   *
   * `deviceIdOrAll` 缺省 = 只看本机；`'all'` = 看仓库里所有设备目录。
   */
  async list(deviceIdOrAll: string, date: string): Promise<ListSchedulesResult> {
    const detailed = await this.readDetailed(deviceIdOrAll, date)
    const records = detailed.items.map((item) => summarize(item.record, item.deviceId))
    const result: ListSchedulesResult = {
      date: detailed.date,
      deviceIds: detailed.deviceIds,
      records,
      refreshed: detailed.refreshed,
      errors: detailed.errors,
    }
    if (detailed.note !== undefined) result.note = detailed.note
    return result
  }

  /* ------------------------------------------------------------------ */
  /* 写                                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * 追加一条日程并推送。
   *
   * 顺序（失败即中止，不做任何"猜测性覆盖"）：
   *   1. 校验 deviceId 必须是本机（写别人的设备目录一律 `E_VALIDATION`）；
   *   2. `ensureWorkTree`（没有工作副本就 clone）；
   *   3. `pull --rebase`：远端有新提交先 rebase，冲突 → `E_CONFLICT`（已 abort 后原样抛出）；
   *   4. 物理追加一行（`appendFile`，历史字节不变），id 保证不与已有行重复；
   *   5. `git add devices/<id>/schedules` + commit；
   *   6. `pushWithRebase`（非快进时再 rebase 一次，最多 2 次，永不 force）。
   */
  async add(deviceId: string, date: string, input: AddScheduleInput): Promise<AddScheduleResult> {
    const id = assertDeviceId(deviceId)
    if (id !== this.deviceId) {
      throw new SyncError('E_VALIDATION', `只允许写本机设备目录：本机是 ${this.deviceId}，收到 ${id}`, {
        deviceId: id,
        expected: this.deviceId,
      })
    }
    const day = assertDateKey(date)
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title === '') throw new SyncError('E_VALIDATION', 'title 不能为空')
    const body = typeof input.body === 'string' ? input.body : ''
    const author = typeof input.author === 'string' && input.author.trim() !== '' ? input.author.trim() : '我'

    const relative = scheduleRelPath(id, day)
    assertSchedulesScope(id, relative)

    await this.repo.ensureWorkTree()
    // 先拉再写：远端若已被别的设备（或同一设备的另一台机器）推进，冲突在这里暴露。
    await this.repo.pullRebase()

    const absolute = resolveInsideRepo(this.repo.dir, relative)
    const existing = await readTextIfExists(absolute)
    const now = this.now()
    const record: ScheduleRecord = {
      id: uniqueId(existing, now),
      ts: nowIso(now),
      title,
      body,
      author,
      done: false,
      ai_processed: false,
    }
    const line = encodeRecord(record)
    await mkdir(path.dirname(absolute), { recursive: true })
    await appendFile(absolute, line, { encoding: 'utf8' })

    const scope = schedulesScope(id)
    const commit = await this.repo.commitAll(`dsh-schedule: add ${record.id} ${day}`, { onlyPath: scope })
    const pushed = await this.repo.pushWithRebase()
    return {
      id: record.id,
      ts: record.ts,
      date: day,
      deviceId: id,
      path: relative,
      commit: commit.commit,
      pushed: pushed.pushed,
      rebased: pushed.rebased,
      files: commit.files,
    }
  }

  /* ------------------------------------------------------------------ */
  /* 汇总                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 把当天记录拼成 AI 载荷 + 提示词；配了 key 就顺便调一次模型。
   *
   * 调用失败不抛错（原因放进 `aiNote`）：工具返回"载荷 + 失败原因"比抛异常更有用，
   * 调用方（模型）自己就能完成汇总。真正会抛的只有路径/日期/读盘这类硬错误。
   */
  async summary(deviceIdOrAll: string, date: string): Promise<SummaryResult> {
    const read = await this.read(deviceIdOrAll, date)
    const payload: AiPayload = buildDaySummaryPayload(read.date, read.records)
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

  /* ------------------------------------------------------------------ */
  /* 内部                                                                */
  /* ------------------------------------------------------------------ */

  /** 仓库里所有合法设备目录（跳过非目录与非法名），本机排在最前。 */
  async deviceDirs(): Promise<string[]> {
    let entries: Array<{ name: string; isDirectory(): boolean }> = []
    try {
      entries = await readdir(path.join(this.repo.dir, 'devices'), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [this.deviceId]
      throw new SyncError('E_IO', `读取 devices/ 失败：${errorMessage(error)}`)
    }
    const ids = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(name))
      .sort()
    return [this.deviceId, ...ids.filter((id) => id !== this.deviceId)]
  }

  /** 干净的工作副本才拉取；任何失败都降级成 `note`（读路径不因网络/冲突失败）。 */
  private async tryRefresh(): Promise<RefreshResult> {
    let clean = false
    try {
      clean = (await this.repo.status()).clean
    } catch (error) {
      return { refreshed: false, note: `读取工作副本状态失败：${errorMessage(error)}` }
    }
    if (!clean) return { refreshed: false, note: '工作副本有未提交改动，已跳过拉取（内容可能不是远端最新）' }
    try {
      const pulled = await this.repo.pullRebase()
      return pulled.rebased ? { refreshed: true, note: '已 rebase 到远端最新提交' } : { refreshed: true }
    } catch (error) {
      return { refreshed: false, note: `拉取失败，展示本地副本：${errorMessage(error)}` }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 工厂                                                                        */
/* -------------------------------------------------------------------------- */

/** 工作副本目录：与配置同步共用（同一 repoUrl → 同一目录）。 */
export function workDirOf(paths: StatePaths, repoUrl: string): string {
  return path.join(paths.workRoot, repoHash(repoUrl))
}

export interface ScheduleWorkspaceOptions {
  paths: StatePaths
  allowLocalRepo?: boolean
  now?: () => Date
  /** 单次网络命令超时（毫秒），测试可注入更小值。 */
  networkTimeoutMs?: number
  /** 覆盖 AI 配置（缺省读环境变量）。 */
  ai?: ScheduleAiOptions
  /** 覆盖环境变量（测试用）。 */
  env?: NodeJS.ProcessEnv
}

/**
 * 用插件设置造一个 `GitRepo` + `ScheduleBridge`，任务结束后释放临时 askpass 文件。
 *
 * 每次调用都重新读设置：用户在设置页换了仓库/设备标识后，下一次工具调用立即生效。
 */
export async function withScheduleBridge<T>(
  options: ScheduleWorkspaceOptions,
  settings: SyncSettings,
  token: string | null,
  task: (bridge: ScheduleBridge, settings: SyncSettings) => Promise<T>,
): Promise<T> {
  if (typeof settings.repoUrl !== 'string' || settings.repoUrl.trim() === '') {
    throw new SyncError('E_VALIDATION', '尚未配置仓库地址：请先在「设置 → Git 配置同步」里填写仓库地址')
  }
  const repo = new GitRepo({
    dir: workDirOf(options.paths, settings.repoUrl),
    repoUrl: settings.repoUrl,
    branch: settings.branch,
    authMode: settings.authMode,
    platform: settings.platform,
    username: settings.username ?? '',
    token,
    allowLocalRepo: options.allowLocalRepo === true,
    ...(options.networkTimeoutMs !== undefined ? { networkTimeoutMs: options.networkTimeoutMs } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  })
  try {
    const bridge = new ScheduleBridge({
      repo,
      deviceId: settings.deviceId,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ai: options.ai ?? aiOptionsFromEnv(options.env ?? process.env),
    })
    return await task(bridge, settings)
  } finally {
    await repo.dispose()
  }
}

/* -------------------------------------------------------------------------- */
/* 自由函数（无需工厂的最小 API）                                                */
/* -------------------------------------------------------------------------- */

/** 调用侧必须给"本机 deviceId"，否则无法判断哪些目录可写。 */
export interface ScheduleCallOptions {
  /** 本机 deviceId（= settings.deviceId）。 */
  ownDeviceId: string
  now?: () => Date
  ai?: ScheduleAiOptions
}

/** 读某天日程摘要：`deviceId` 可为具体设备或 `'all'`。 */
export async function listSchedule(
  repo: GitRepo,
  deviceId: string,
  date: string,
  options: ScheduleCallOptions,
): Promise<ListSchedulesResult> {
  return build(repo, options).list(deviceId, date)
}

/** 追加一行日程并推送；`deviceId` 必须是本机，否则 `E_VALIDATION`。 */
export async function addSchedule(
  repo: GitRepo,
  deviceId: string,
  date: string,
  input: AddScheduleInput,
  options: ScheduleCallOptions,
): Promise<AddScheduleResult> {
  return build(repo, options).add(deviceId, date, input)
}

/** 把当天记录拼成 AI 载荷 + 提示词（可选真调 AI）。 */
export async function summarySchedule(
  repo: GitRepo,
  deviceId: string,
  date: string,
  options: ScheduleCallOptions,
): Promise<SummaryResult> {
  return build(repo, options).summary(deviceId, date)
}

function build(repo: GitRepo, options: ScheduleCallOptions): ScheduleBridge {
  return new ScheduleBridge({
    repo,
    deviceId: options.ownDeviceId,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.ai !== undefined ? { ai: options.ai } : {}),
  })
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

/** 读文本文件；不存在返回空串（"没有记录"不是错误）。 */
async function readTextIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new SyncError('E_IO', `读取日程文件失败：${errorMessage(error)}`)
  }
}

/** 生成一个当天文件里不存在的 id（碰撞时追加 base36 计数后缀）。 */
function uniqueId(existingText: string, now: Date): string {
  const used = new Set(parseJsonl(existingText).records.map((record) => record.id))
  let candidate = newRecordId(now)
  let attempt = 0
  while (used.has(candidate)) {
    attempt += 1
    if (attempt > 32) throw new SyncError('E_INTERNAL', '无法生成唯一 id（同文件 32 次碰撞）')
    candidate = `${newRecordId(now)}-${attempt.toString(36)}`
  }
  return candidate
}

/** 记录 → 摘要（正文只给前 80 字）。 */
export function summarize(record: ScheduleRecord, deviceId: string): ScheduleSummary {
  const body = typeof record.body === 'string' ? record.body : ''
  const clipped = body.length > BODY_PREVIEW_LIMIT
  return {
    id: record.id,
    ts: record.ts,
    date: recordDateKey(record.ts),
    deviceId,
    title: record.title,
    author: record.author,
    done: record.done,
    bodyPreview: clipped ? `${body.slice(0, BODY_PREVIEW_LIMIT)}…` : body,
    bodyLength: body.length,
    hasAttachments: Array.isArray(record.attachments) && record.attachments.length > 0,
    aiProcessed: record.ai_processed,
  }
}

/** 调一次聊天补全；失败抛 `SyncError`（消息经 `classifyAiError`，不含 key）。 */
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
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: request.body,
      signal: AbortSignal.timeout(request.timeoutMs),
    })
  } catch (error) {
    const aborted =
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    const status = aborted ? AI_STATUS_TIMEOUT : AI_STATUS_NETWORK
    throw new SyncError('E_GIT', classifyAiError(status, '', options.providerLabel), { status })
  }
  const text = await response.text()
  if (!response.ok) {
    throw new SyncError('E_GIT', classifyAiError(response.status, text, options.providerLabel), {
      status: response.status,
    })
  }
  try {
    return parseAiReply(text)
  } catch (error) {
    throw new SyncError('E_GIT', errorMessage(error), { status: response.status })
  }
}
