/**
 * 记录级冲突合并（A3）：两份同日 JSONL 的「按 id 折叠 + 较新者胜 + 冲突上报」。
 *
 * 纯逻辑，零 SDK import：ArkTS（HarmonyOS）、ArkUI-X（Android）与 Node 测试共用同一份实现。
 *
 * 为什么需要它：`pull` 走 fast-forward，冲突时由桥里的 `unionJsonl()`（`git-bridge.js`）做行级并集
 * 兜底——两边同 id 的行都留下，读时靠 `foldById` **静默**取较晚者。结果是：
 * - 冲突不可见（用户不知道另一台设备改了什么）；
 * - 同日文件会无限堆积重复行；
 * - 「远端新增」与「本机新增」混在一起，没法判定谁丢了。
 *
 * 本模块把「读时静默折叠」升级为「写时显式决策」：
 * - 同 id 两侧都有 → `ts` 较新者胜（last-write-wins，与 `foldById` 语义一致，不另立规则）；
 * - 同 id 且 `ts` 相同、内容不同 → **自动解不了**：计入 `conflicts` 并默认保留本机，
 *   把两侧的规范行交给 UI 让用户选「保留本机 / 采用远端」；
 * - 任一侧独有 → 一律保留。**远端新增不丢**；远端文件里没有的 id 也**不当作删除**去误删本机版本
 *   （契约里没有墓碑机制，删除只能用显式操作表达，合并绝不能把缺行解释成删除）；
 * - 坏行 / 空文件只跳过并计数，**永不抛异常**：合并失败不能拖垮一次同步。
 *
 * 输出契约：
 * - `mergeRecordLines()` 返回统计与记录数组（内存视图，供二次处理）；
 * - `mergeDayFile()` 返回可直接写回的完整 JSONL 文本，**每行都是 `encodeRecord()` 的规范格式**
 *   （字段顺序固定、未知扩展字段透传、末尾恰好一个 `\n`），排序固定为「`ts` 升序 → 同 `ts` 按 `id`
 *   升序」，因此同一输入重复调用**逐字节相同**。
 *
 * 与 `docs/DATA-CONTRACT.md` §3「只追加」的关系：合并写回会**压缩**同一 id 的历史行（只留胜者），
 * 这必然重写当日文件；被压缩掉的旧行仍在 git 历史里，且折叠后的语义与合并前完全等价。
 * 因此合并只应作为「同 id 多版本已被折叠」之后的规范化写回，不能拿它替代日常追加。
 */

import { encodeRecord, parseJsonl } from './jsonl';
import type { ScheduleRecord } from './types';

/** 冲突时优先采用哪一侧（默认 `local`；UI 选「采用远端」时传 `remote`）。 */
export type MergePrefer = 'local' | 'remote';

/** 一处「同 id、同 ts、内容不同」的冲突：两侧规范行都给出来，供 UI 选择/预览。 */
export interface MergeConflictDetail {
  /** 记录 id。 */
  id: string;
  /** 两侧相同的 `ts`（ISO 8601）。 */
  ts: string;
  /** 本机版本的规范单行（无行尾换行）。 */
  localLine: string;
  /** 远端版本的规范单行（无行尾换行）。 */
  remoteLine: string;
}

/** 一次合并的统计与结果。 */
export interface MergeStats {
  /** 只在本机出现的 id 数（远端缺行 ≠ 删除，一律保留）。 */
  localOnly: number;
  /** 只在远端出现的 id 数（远端新增必须进结果）。 */
  remoteOnly: number;
  /** 同 id、`ts` 相同、内容不同的条数（已按 `prefer` 取一侧，等用户确认）。 */
  conflicts: number;
  /** 合并结果：`ts` 升序，同 `ts` 按 `id` 升序（稳定，无重复 id）。 */
  result: ScheduleRecord[];
  /** 坏行 + 无法重新编码的行总数（= `localErrors + remoteErrors` 再加上编码失败数）。 */
  errors: number;
  /** 本机侧坏行数（`parseJsonl` 的 `errors.length`）。 */
  localErrors: number;
  /** 远端侧坏行数。 */
  remoteErrors: number;
  /** 两侧同 id、`ts` 相同且内容完全相同的条数（已去重，只保留一份）。 */
  duplicates: number;
}

/** `mergeDayFile()` 的结果：可直接写回的规范 JSONL + 冲突明细。 */
export interface MergeDayResult {
  /** 合并后的完整 JSONL（每行 `encodeRecord` 规范格式；两侧都空时为 `''`）。 */
  text: string;
  stats: MergeStats;
  /** 冲突 id（顺序 = `ts` 升序 → `id` 升序，与 `conflictDetails` 一致）。 */
  conflictIds: string[];
  /** 冲突明细（`stats.conflicts === 0` 时为空数组）。 */
  conflictDetails: MergeConflictDetail[];
}

/** 内部：一次合并的完整产出（`text` 只由这里生成，保证两条出口口径一致）。 */
interface MergeCoreResult {
  text: string;
  stats: MergeStats;
  conflictIds: string[];
  conflictDetails: MergeConflictDetail[];
}

// ---------------------------------------------------------------- 比较与解析

/** ts → 毫秒；非法返回 NaN（与 `model/jsonl` 同样只做宽松解析）。 */
function tsMillis(ts: string): number {
  const value = Date.parse(ts);
  return Number.isNaN(value) ? Number.NaN : value;
}

/** ts 比较：两侧都能解析时按毫秒，否则退回字符串比较；返回 <0 / 0 / >0。 */
function compareTs(left: string, right: string): number {
  const a = tsMillis(left);
  const b = tsMillis(right);
  if (!Number.isNaN(a) && !Number.isNaN(b)) {
    return a - b;
  }
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 结果排序：`ts` 升序 → 同 `ts` 按 `id` 升序（完全确定，不依赖输入顺序）。 */
function compareRecords(left: ScheduleRecord, right: ScheduleRecord): number {
  const delta = compareTs(left.ts, right.ts);
  if (delta !== 0) {
    return delta;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/** 冲突明细排序：`ts` 升序 → `id` 升序（与结果排序同口径，便于并排展示）。 */
function compareConflicts(left: MergeConflictDetail, right: MergeConflictDetail): number {
  const delta = compareTs(left.ts, right.ts);
  if (delta !== 0) {
    return delta;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/**
 * 一条记录的规范单行（无行尾换行），用于「内容是否相同」的判定。
 *
 * 走 `encodeRecord`：字段顺序固定、附件子字段重排、未知扩展字段原样保留，
 * 因此「同一语义的两条记录」不会被 `JSON.stringify` 的键序差异误判成冲突。
 * 正常解析出来的记录不会编码失败；万一失败，退回 `JSON.stringify` 保证比较仍然可用。
 */
function canonicalLine(record: ScheduleRecord): string {
  try {
    const encoded = encodeRecord(record);
    return encoded.endsWith('\n') ? encoded.slice(0, encoded.length - 1) : encoded;
  } catch (error) {
    return JSON.stringify(record);
  }
}

/** 解析一侧文本；坏行只计数不抛（`parseJsonl` 本身永不抛）。 */
function parseSide(text: string): { records: ScheduleRecord[]; errors: number } {
  if (typeof text !== 'string' || text.length === 0) {
    return { records: [], errors: 0 };
  }
  const parsed = parseJsonl(text);
  return { records: parsed.records, errors: parsed.errors.length };
}

/**
 * 单侧折叠：同 id 取 `ts` 最晚的一条；`ts` 相同时**后出现的行胜**（与「只追加」一致：
 * 后写的那行才是更新的版本）。返回按 id 索引的 Map，键序 = 各 id 首次出现顺序。
 */
function foldSide(records: ScheduleRecord[]): Map<string, ScheduleRecord> {
  const folded = new Map<string, ScheduleRecord>();
  for (const record of records) {
    const previous = folded.get(record.id);
    if (previous === undefined || compareTs(record.ts, previous.ts) >= 0) {
      folded.set(record.id, record);
    }
  }
  return folded;
}

// ---------------------------------------------------------------- 合并核心

/**
 * 合并核心：两侧解析 → 各自折叠 → 按 id 求并集与胜者 → 排序 → 规范编码。
 *
 * 计数口径（互相不重叠）：
 * - `localOnly + remoteOnly + conflicts + duplicates + (两侧都有且 ts 不同的 id)` = 结果条数；
 * - `conflicts` 与 `duplicates` 都只统计「两侧 ts 相同」的 id。
 */
function mergeCore(localText: string, remoteText: string, prefer: MergePrefer): MergeCoreResult {
  const localSide = parseSide(localText);
  const remoteSide = parseSide(remoteText);
  const localById = foldSide(localSide.records);
  const remoteById = foldSide(remoteSide.records);

  let localOnly = 0;
  let remoteOnly = 0;
  let conflicts = 0;
  let duplicates = 0;
  const winners: ScheduleRecord[] = [];
  const conflictDetails: MergeConflictDetail[] = [];

  localById.forEach((localRecord: ScheduleRecord, id: string) => {
    const remoteRecord = remoteById.get(id);
    if (remoteRecord === undefined) {
      // 本机独有（含「远端缺这一行」）：保留，绝不因为对方没有就删
      localOnly += 1;
      winners.push(localRecord);
      return;
    }
    const delta = compareTs(localRecord.ts, remoteRecord.ts);
    if (delta > 0) {
      winners.push(localRecord);
      return;
    }
    if (delta < 0) {
      winners.push(remoteRecord);
      return;
    }
    // ts 相同：内容相同就去重，内容不同才是真冲突
    const localLine = canonicalLine(localRecord);
    const remoteLine = canonicalLine(remoteRecord);
    if (localLine === remoteLine) {
      duplicates += 1;
      winners.push(localRecord);
      return;
    }
    conflicts += 1;
    conflictDetails.push({ id: id, ts: localRecord.ts, localLine: localLine, remoteLine: remoteLine });
    winners.push(prefer === 'remote' ? remoteRecord : localRecord);
  });

  remoteById.forEach((remoteRecord: ScheduleRecord, id: string) => {
    if (localById.has(id)) {
      return;
    }
    // 远端独有：远端新增必须进结果
    remoteOnly += 1;
    winners.push(remoteRecord);
  });

  winners.sort(compareRecords);
  conflictDetails.sort(compareConflicts);
  const conflictIds: string[] = [];
  for (let index = 0; index < conflictDetails.length; index++) {
    conflictIds.push(conflictDetails[index].id);
  }

  // 规范编码：编码失败的行（理论上不会出现）计入 errors 并从结果里剔除，
  // 保证 `stats.result` 与 `text` 严格一致，调用方拿哪个都不会错位。
  const kept: ScheduleRecord[] = [];
  const lines: string[] = [];
  let encodeErrors = 0;
  for (let index = 0; index < winners.length; index++) {
    const record = winners[index];
    let line: string;
    try {
      line = encodeRecord(record);
    } catch (error) {
      encodeErrors += 1;
      continue;
    }
    kept.push(record);
    lines.push(line);
  }

  const stats: MergeStats = {
    localOnly: localOnly,
    remoteOnly: remoteOnly,
    conflicts: conflicts,
    result: kept,
    errors: localSide.errors + remoteSide.errors + encodeErrors,
    localErrors: localSide.errors,
    remoteErrors: remoteSide.errors,
    duplicates: duplicates
  };
  const core: MergeCoreResult = {
    text: lines.join(''),
    stats: stats,
    conflictIds: conflictIds,
    conflictDetails: conflictDetails
  };
  return core;
}

// ---------------------------------------------------------------- 对外接口

/**
 * 合并两份同日 JSONL，返回统计与结果（内存视图）。**永不抛异常**。
 *
 * 规则：坏行跳过并计数 → 同 id 折叠 → 并集（本机独有 + 远端独有都保留）→
 * 同 id 取 `ts` 较新者 → `ts` 相同且内容不同则计入 `conflicts` 并按 `prefer` 取一侧。
 *
 * @param localText 本机文本（不存在时空串）
 * @param remoteText 远端/工作副本文本（不存在时空串）
 * @param prefer 冲突时优先采用的一侧，默认 `local`
 */
export function mergeRecordLines(
  localText: string,
  remoteText: string,
  prefer: MergePrefer = 'local'
): MergeStats {
  return mergeCore(localText, remoteText, prefer).stats;
}

/**
 * 合并两份同日 JSONL，返回**可直接写回**的完整文本 + 统计 + 冲突明细。**永不抛异常**。
 *
 * `text` 的保证：
 * - 每行都是 `encodeRecord()` 的规范格式（字段顺序固定，未知扩展字段透传）；
 * - 非空时末尾恰好一个 `\n`，没有空行；两侧都空时是 `''`；
 * - 排序 = `ts` 升序 → 同 `ts` 按 `id` 升序，同一输入任意次数结果逐字节相同。
 *
 * 调用方约定：`conflictIds` 非空时**先不要写回**，把 `conflictDetails` 交给 UI 让用户选
 * 「保留本机 / 采用远端」，再用 `prefer` 重跑一次并写回。
 */
export function mergeDayFile(
  localText: string,
  remoteText: string,
  prefer: MergePrefer = 'local'
): MergeDayResult {
  const core = mergeCore(localText, remoteText, prefer);
  const result: MergeDayResult = {
    text: core.text,
    stats: core.stats,
    conflictIds: core.conflictIds,
    conflictDetails: core.conflictDetails
  };
  return result;
}
