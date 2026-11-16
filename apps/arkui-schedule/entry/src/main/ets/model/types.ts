/**
 * 日程数据模型（纯类型，无运行时依赖）。
 *
 * 契约来源：`docs/DATA-CONTRACT.md` §3、`docs/CONTRACT.md` §3.2。
 * 本文件禁止 import 鸿蒙 SDK 运行时 / 页面组件 / services 层 —— 模型层必须能在 Node 下直接运行。
 */

/**
 * 手写板每页截图在 `attachments/` 下的引用。
 *
 * 2026-11 起改为「**JPEG 压缩 + 按天 zip**」：
 * - 新数据带 `archive` + `entry`，图片在 `attachments/<YYYY-MM-DD>.zip` 里的 `page-<页>-<sha8>.jpg`；
 * - 旧数据**没有** `archive`（只有 `sha256`/`name`），仍按散图 `attachments/<name>` 读取，不迁移、不报错。
 */
export interface Attachment {
  /** 截图内容的 SHA-256（小写十六进制，64 字符），即文件名主体。 */
  sha256: string;
  /** 实际文件名（旧数据是 `<sha256>.png`；新数据是 zip 内的条目名）。 */
  name: string;
  /** 第几页，0 起。 */
  pageIndex: number;
  /** 按天打包的 zip 文件名（如 `2026-11-15.zip`）；旧数据没有这个字段 → 走散图路径。 */
  archive?: string;
  /** zip 内条目名（如 `page-1-1a2b3c4d.jpg`）；与 `archive` 同时出现。 */
  entry?: string;
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
  /**
   * 手写板插入的对象（框 / 图片 / 表格），v2 按页文档 JSON：{version:2, pages:{p1:[…]}}。
   * 键是稳定页 id；旧记录没有这个字段。
   */
  pageObjects?: string;
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

/**
 * 手写页上的一个矩形区域（用户框选的公式/图表等「不参与 OCR」的部分）。
 *
 * 坐标是**归一化**的（0..1，左上角原点，`w`/`h` 为宽高比例），与画布像素/VP 尺寸无关：
 * 同一份区域数据在手机、平板、截图落盘后的原图上都指向同一块内容。
 * 越界/负宽高/NaN 由 `model/regions.ts` 的 `sanitizeRegion` 统一清洗，模型层不假设数据干净。
 */
export interface RegionBox {
  /** 左上角 x（0..1）。 */
  x: number;
  /** 左上角 y（0..1）。 */
  y: number;
  /** 宽（0..1）。 */
  w: number;
  /** 高（0..1）。 */
  h: number;
}

/**
 * 复制一条日程记录。
 *
 * ArkTS 不支持对象展开（`arkts-no-spread`），因此「基于旧记录改几个字段再追加一行」
 * 必须逐字段复制。这里显式列出全部字段：新增字段时编译器会强制补全，避免漏拷贝。
 *
 * 未知字段（历史日志里已废弃的扩展字段）由 `model/jsonl` 原样透传：读路径只校验已知字段，
 * 多出来的键既不报错也不丢弃。因此模型层不需要为已删除的功能保留任何字段。
 */
export function cloneRecord(source: ScheduleRecord): ScheduleRecord {
  const copy: ScheduleRecord = {
    id: source.id,
    ts: source.ts,
    title: source.title,
    body: source.body,
    author: source.author,
    done: source.done,
    ai_processed: source.ai_processed
  };
  if (source.ocr_text !== undefined) {
    copy.ocr_text = source.ocr_text;
  }
  if (source.attachments !== undefined) {
    copy.attachments = source.attachments;
  }
  if (source.ai_structured !== undefined) {
    copy.ai_structured = source.ai_structured;
  }
  if (source.ocr_time !== undefined) {
    copy.ocr_time = source.ocr_time;
  }
  return copy;
}
