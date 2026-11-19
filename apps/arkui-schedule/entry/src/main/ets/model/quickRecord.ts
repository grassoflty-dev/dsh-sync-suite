/**
 * 首页快捷记录的保存决策（纯 TypeScript，零 SDK / 零服务层依赖，Node 下可直接单测）。
 *
 * ## 为什么要和编辑器的 `resolveSaveTs` 分开判定
 * 编辑器保存的是「已有记录 / 正在编辑的表单」：`resolveSaveTs(originalTs, chosenDate, now)`
 * 必须先看 `originalTs` 才能区分「新建选日」与「已有记录同日升级」，已有记录还会**故意忽略**
 * `chosenDate`（日期是创建时选定的，不能改）。
 *
 * 快捷记录面对的是**一条尚不存在的记录**：没有 originalTs、没有正文、没有附件，日期就是这一次
 * 创建的唯一选择（当前所选日期，可过去可未来）。因此不能拿空 `originalTs` 去借道 `resolveSaveTs`
 * ——那条路的语义是「新建」，虽然此刻碰巧等价，但它把决策绑在编辑器的表单字段上，一旦编辑器
 * 加字段/改规则就会把不相干的分支带进来。这里直接复用它底下的唯一日期落点 `tsForDate`。
 *
 * **不发明第二种日期格式**：`ts` 的形状（本地 ISO-8601 带偏移）、分片键（`recordDateKey`）、
 * 版本序与编辑器完全同源（同一份 `recordSaveTs.ts`），因此快捷记录落盘后与编辑器创建的记录
 * 在 `foldById` / `openIndex` / `appendRecord` 上行为一致。非法日期与脏 `now` 由 `tsForDate`
 * 兜底，本模块不抛错、不读时钟（时钟由调用方显式传入）。
 */
import { tsForDate } from './recordSaveTs';

/** 一次快捷记录的决策结果（全为字符串 / 布尔，可直接进 UI 与日志）。 */
export interface QuickRecordPlan {
  ok: boolean;
  /** 规整后的标题（`rawTitle.trim()`）；失败时为空串。 */
  title: string;
  /** 新记录的 ts；失败时为空串。 */
  ts: string;
  /** 失败时的可展示中文原因；成功时为空串。 */
  reason: string;
}

/**
 * 决定这次快捷记录能否落盘、用哪个 ts（纯函数：同入参恒定输出，不抛错，时钟只由入参注入）。
 *
 * 只做判定、不写文件；调用方按 `ok` / `ts` 决定追加哪一行。失败时 `title` 一律回空串：
 * 没有可用计划就不把半成品标题交出去（输入框还留着原文，由组件层决定保留）。
 */
export function planQuickRecord(rawTitle: string, dateKey: string, now: Date = new Date()): QuickRecordPlan {
  const title: string = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (title.length === 0) {
    return { ok: false, title: '', ts: '', reason: '请输入标题' };
  }
  const ts: string = tsForDate(dateKey, now);
  if (ts.length === 0) {
    return { ok: false, title: '', ts: '', reason: '日期不合法：请重新选择日期' };
  }
  return { ok: true, title: title, ts: ts, reason: '' };
}
