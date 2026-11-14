/**
 * 日程数据模型（纯类型，无运行时依赖）。
 *
 * 契约来源：`docs/DATA-CONTRACT.md` §3、`docs/CONTRACT.md` §3.2。
 * 本文件禁止 import 鸿蒙 SDK 运行时 / 页面组件 / services 层 —— 模型层必须能在 Node 下直接运行。
 */

/** 手写板每页截图在 `attachments/` 下的引用。 */
export interface Attachment {
  /** 截图内容的 SHA-256（小写十六进制，64 字符），即文件名主体。 */
  sha256: string;
  /** 实际文件名，形如 `<sha256>.png`。 */
  name: string;
  /** 第几页，0 起。 */
  pageIndex: number;
}

/**
 * 一行 JSONL 即一条日程事件（事件溯源：同 id 允许出现多条，读时以较晚者覆盖）。
 */
export interface ScheduleRecord {
  /** 全局唯一 id（时间戳+随机），跨设备折叠键。 */
  id: string;
  /** 创建时间，ISO 8601 含时区。 */
  ts: string;
  title: string;
  /** 正文（用户可编辑）。 */
  body: string;
  /** 手写 OCR 原始结果，只读，永不覆盖。 */
  ocr_text?: string;
  /** 记录者。 */
  author: string;
  /** 完成情况。 */
  done: boolean;
  attachments?: Attachment[];
  /** AI 结构化结果（可编辑）。 */
  ai_structured?: string;
  /** 是否已 AI 处理。 */
  ai_processed: boolean;
  /** 识别时间（AI 载荷使用）。 */
  ocr_time?: string;
}

/** 每日 AI 汇总请求载荷。 */
export interface AiPayload {
  date: string;
  records: Array<{ id: string; ocr_time: string; text: string }>;
}
