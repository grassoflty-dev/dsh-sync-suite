/**
 * 日程桥（PC 侧）公共类型。
 *
 * 形状与 `docs/DATA-CONTRACT.md` §3（JSONL 契约）、§1（仓库目录结构）、§4 严格一致：
 * 同一个对象既是 Git 里的一行 JSONL，也是 AI 载荷与工具返回值的来源。
 * 与 App 侧 `entry/src/main/ets/model/types.ts` 保持字段名/类型逐项对应。
 */
/** 正文摘要在列表里的截断长度（`schedule_list` 只给前 80 字，完整正文用 `schedule_summary`）。 */
export const BODY_PREVIEW_LIMIT = 80;
