/**
 * 空仓库首次使用（mod-drop-v1）：零 SDK import / 零 IO / 零墙钟的纯决策与规范字节。
 *
 * 产品决定：不再有「未迁移」态、横幅或迁移动作。仓库里没有 `timeline/`（或
 * `timeline/schema.json`）就是**空仓库正常起点**：App 显示空日程列表，首次使用时
 * 建仓库级 schema 标记，写第一条记录时建当日目录与 `records.json`。
 *
 * 旧 `devices/**` 与旧 `open.jsonl`：一律忽略——本模块与整条 v2 路径都不读、不写、不删。
 */
import { parseSchemaMarker } from './timeline';

/** 仓库级 schema 标记的规范字节（唯一拼法，首用时原子落盘）。 */
export const FRESH_SCHEMA_TEXT: string = '{"schemaVersion":2}\n';

/** 首条记录之前，当日 `records.json` 的规范空骨架（键序即契约 §3）。 */
export function freshDayText(date: string): string {
  return `{"date":"${date}","open":[],"records":[]}\n`;
}

/** 首次使用决策（供写入服务在打开任何写句柄前判定）。 */
export interface FreshStartDecision {
  /** 标记文件缺失 / 为空 → 写 `FRESH_SCHEMA_TEXT` 建骨架。 */
  needSchema: boolean;
  /** 标记存在但不是 v2 → 保留 `E_SCHEMA_UNKNOWN` 只读门槛（不是旧数据拒绝）。 */
  unsupported: boolean;
}

/**
 * 纯决策：缺标记 = 正常空仓库（needSchema=true，不拒绝）；
 * 有标记但版本不认识 = unsupported（仅此一种保留 typed 只读门槛）。
 */
export function decideFreshStart(schemaText: string): FreshStartDecision {
  const present: boolean = typeof schemaText === 'string' && schemaText.trim().length > 0;
  if (!present) {
    const fresh: FreshStartDecision = { needSchema: true, unsupported: false };
    return fresh;
  }
  const parsed = parseSchemaMarker(schemaText);
  const decision: FreshStartDecision = { needSchema: false, unsupported: !parsed.ok };
  return decision;
}
