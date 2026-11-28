/**
 * 日程桥（PC 侧）公共类型。
 *
 * 形状与 `docs/DATA-CONTRACT.md` §3（JSONL 契约）、§1（仓库目录结构）、§4 严格一致：
 * 同一个对象既是 Git 里的一行 JSONL，也是 AI 载荷与工具返回值的来源。
 * 与 App 侧 `entry/src/main/ets/model/types.ts` 保持字段名/类型逐项对应。
 */

/** 手写页截图在 `attachments/` 下的引用（PC 侧只读，不新增附件）。 */
export interface Attachment {
  /** 截图内容的 SHA-256（小写十六进制，64 字符），即文件名主体。 */
  sha256: string
  /** 实际文件名，形如 `<sha256>.png`。 */
  name: string
  /** 第几页，0 起。 */
  pageIndex: number
}

/** 一行 JSONL = 一条日程事件（同 id 允许多行，读时以较晚 ts 覆盖）。 */
export interface ScheduleRecord {
  /** 全局唯一 id（时间戳 base36 + 随机后缀），跨设备折叠键。 */
  id: string
  /** 创建时间，ISO 8601 带本地时区偏移。 */
  ts: string
  title: string
  /** 正文（用户可编辑；桌面端新建时可为空串）。 */
  body: string
  /** 手写 OCR 原始结果，只读，永不覆盖。 */
  ocr_text?: string
  /** 记录者。 */
  author: string
  /** 完成情况。 */
  done: boolean
  attachments?: Attachment[]
  /** AI 结构化结果（可编辑）。 */
  ai_structured?: string
  /** 是否已 AI 处理。 */
  ai_processed: boolean
  /** 识别时间（AI 载荷使用）。 */
  ocr_time?: string
}

/**
 * 每日 AI 汇总载荷（与 App `model/aiPayload.ts` 的 `AiPayload` 同形）。
 * 桌面端复用同一形状，跨端提示词才能保持一致。
 */
export interface AiPayload {
  date: string
  records: Array<{ id: string; ocr_time: string; text: string }>
}

/** 正文摘要在列表里的截断长度（`timeline_list` 只给前 80 字，完整正文用 `timeline_summary`）。 */
export const BODY_PREVIEW_LIMIT = 80

/** 列表里的一条摘要。 */
export interface ScheduleSummary {
  id: string
  ts: string
  /** 记录归属日期（`ts` 前 10 位，保留记录者时区）。 */
  date: string
  /** 该记录来自哪个设备目录。 */
  deviceId: string
  title: string
  author: string
  done: boolean
  /** 正文前 80 字（超长时以 `…` 结尾）。 */
  bodyPreview: string
  /** 正文总长度（字符数），用于判断是否被截断。 */
  bodyLength: number
  hasAttachments: boolean
  aiProcessed: boolean
}

/** `addSchedule` 的输入。 */
export interface AddScheduleInput {
  title: string
  body?: string
  author?: string
}

/** `addSchedule` 的结果。 */
export interface AddScheduleResult {
  id: string
  ts: string
  date: string
  deviceId: string
  /** 相对仓库根的路径：`devices/<deviceId>/schedules/<date>.jsonl`。 */
  path: string
  commit: string
  pushed: boolean
  rebased: boolean
  /** 本次提交涉及的仓库相对路径。 */
  files: string[]
}

/** 一次读取（列表 / 汇总共用）的结果。 */
export interface ReadSchedulesResult {
  date: string
  deviceIds: string[]
  records: ScheduleRecord[]
  /** 是否成功从远端拉到最新（`false` 时内容可能不是最新）。 */
  refreshed: boolean
  /** `refreshed` 为 false 的原因，或其它需要告知用户的提示。 */
  note?: string
  /** 坏行（不是合法 JSON / 字段不合法）的定位信息，读取时跳过但不静默。 */
  errors: string[]
}

/** `timeline_summary` 的结果：载荷 + 提示词 + 可选 AI 输出。 */
export interface SummaryResult {
  date: string
  deviceIds: string[]
  count: number
  payload: AiPayload
  prompt: string
  /** AI 摘要正文；未配置密钥或调用失败时为 null。 */
  summary: string | null
  /** 没有调用 AI 的原因（未配置密钥 / 当天没有记录 / 调用失败）。 */
  aiNote?: string
  refreshed: boolean
  note?: string
}
