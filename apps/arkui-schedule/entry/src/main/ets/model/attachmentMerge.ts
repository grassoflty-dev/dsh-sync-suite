/**
 * 附件 / 汇总 / 未完成索引的「较新者胜 + 绝不覆盖」合并（A3 的一部分，纯逻辑、零 SDK import）。
 *
 * 三类数据的冲突策略各不相同，这里一次性定死：
 *
 * 1. `summaries/YYYY-MM-DD.json` —— **`generatedAt` 较新者胜**。汇总是一整天的派生结果，
 *    不能两版共存；相等按「保留本机」处理（先到先得，避免两台设备来回抖）。
 *    一侧文件损坏时采用另一侧（有可用内容就不能丢），两侧都不可用才判空。
 *
 * 2. `open.jsonl` —— 与日程日志同构：按 id 折叠，**同 id 取 `ts` 较新**；`ts` 相同内容不同 → 冲突取本机。
 *    索引是派生数据，但跨设备后仍可能因「勾选完成」事件丢失而发散，所以按记录同样的规则合并。
 *
 * 3. `attachments/YYYY-MM-DD.zip` —— 手迹**绝不能覆盖**。同名不同内容（sha256 不同）→ 保留两份：
 *    `YYYY-MM-DD.local.zip`（本机）与 `YYYY-MM-DD.remote.zip`（远端）；同名同内容 → 只留一份。
 *    派生名冲突时再退到 `.1` / `.2` 后缀，保证「写进去的每一份内容都在」。
 *
 * 本模块只做决策，不碰文件系统：`planArchiveWrites()` 输出「该写哪些新文件、哪些已存在可跳过」，
 * 由 `services/gitMerge.ets` 落盘（因此 Node 下可完整测试）。
 */

import { parseSummary, serializeSummary } from './dailySummary';
import type { DailySummary } from './dailySummary';
import { encodeOpenEntry, foldOpenByid, parseOpenIndex } from './openIndex';
import type { OpenEntry } from './openIndex';
import { sha256Hex } from './sha256';

// ---------------------------------------------------------------- 公共小工具

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

/**
 * 在扩展名前插入一段后缀：`2026-11-15.zip` + `local` → `2026-11-15.local.zip`。
 * 没有扩展名时直接接在末尾（`piece` + `local` → `piece.local`）。
 */
function insertSuffix(name: string, suffix: string): string {
  const raw = typeof name === 'string' ? name.trim() : '';
  if (raw.length === 0) {
    return suffix;
  }
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) {
    return `${raw}.${suffix}`;
  }
  return `${raw.slice(0, dot)}.${suffix}${raw.slice(dot)}`;
}

/** 本机份的文件名：`YYYY-MM-DD.zip` → `YYYY-MM-DD.local.zip`。 */
export function localVariantName(name: string): string {
  return insertSuffix(name, 'local');
}

/** 远端份的文件名：`YYYY-MM-DD.zip` → `YYYY-MM-DD.remote.zip`。 */
export function remoteVariantName(name: string): string {
  return insertSuffix(name, 'remote');
}

// ---------------------------------------------------------------- 1. 汇总（generatedAt）

/** 汇总合并的采用方：本机 / 远端 / 两侧等价 / 两侧都不可用。 */
export type SummaryWinner = 'local' | 'remote' | 'identical' | 'empty';

/** `mergeSummaryTexts()` 的决策结果（服务层据此决定写不写、写谁）。 */
export interface SummaryMergeDecision {
  /** 采用哪一侧；`identical` = 两侧规范化后相同（保留本机即可，不必写盘）。 */
  winner: SummaryWinner;
  /** 合并后应落盘的文本（已按 `serializeSummary` 规范化；`empty` 时为空串）。 */
  text: string;
  /** 本机 `generatedAt`；该侧没有可用汇总时为 -1。 */
  localGeneratedAt: number;
  /** 远端 `generatedAt`；该侧没有可用汇总时为 -1。 */
  remoteGeneratedAt: number;
  /** 解析失败（`corrupt`）的侧数，0..2。 */
  errors: number;
  /** 需要交代给人看的中文说明（正常合并为空串）。 */
  note: string;
}

/**
 * 合并同一天的两份汇总（`summaries/YYYY-MM-DD.json`）。**永不抛异常**。
 *
 * - 两侧都可用：`generatedAt` 较新者胜；值相等且规范化文本相同 → `identical`（不写盘）；
 * - 只有一侧可用：采用可用的一侧（**不因为对方坏文件就丢掉好数据**）；
 * - 两侧都不可用：都空 → `empty`；至少一侧有内容 → 保留本机原文（损坏也**不清空**），并给 `note`。
 */
export function mergeSummaryTexts(localText: string, remoteText: string): SummaryMergeDecision {
  const localRaw = typeof localText === 'string' ? localText : '';
  const remoteRaw = typeof remoteText === 'string' ? remoteText : '';
  const localParsed = parseSummary(localRaw);
  const remoteParsed = parseSummary(remoteRaw);
  const localSummary: DailySummary | null = localParsed.kind === 'ok' ? localParsed.summary : null;
  const remoteSummary: DailySummary | null = remoteParsed.kind === 'ok' ? remoteParsed.summary : null;
  const errors =
    (localParsed.kind === 'corrupt' ? 1 : 0) + (remoteParsed.kind === 'corrupt' ? 1 : 0);
  const localGeneratedAt = localSummary === null ? -1 : localSummary.generatedAt;
  const remoteGeneratedAt = remoteSummary === null ? -1 : remoteSummary.generatedAt;

  if (localSummary !== null && remoteSummary !== null) {
    const localClean = serializeSummary(localSummary);
    const remoteClean = serializeSummary(remoteSummary);
    if (localClean === remoteClean) {
      return {
        winner: 'identical',
        text: localClean,
        localGeneratedAt: localGeneratedAt,
        remoteGeneratedAt: remoteGeneratedAt,
        errors: errors,
        note: ''
      };
    }
    if (localGeneratedAt >= remoteGeneratedAt) {
      return {
        winner: 'local',
        text: localClean,
        localGeneratedAt: localGeneratedAt,
        remoteGeneratedAt: remoteGeneratedAt,
        errors: errors,
        note: ''
      };
    }
    return {
      winner: 'remote',
      text: remoteClean,
      localGeneratedAt: localGeneratedAt,
      remoteGeneratedAt: remoteGeneratedAt,
      errors: errors,
      note: ''
    };
  }

  if (localSummary !== null) {
    return {
      winner: 'local',
      text: serializeSummary(localSummary),
      localGeneratedAt: localGeneratedAt,
      remoteGeneratedAt: remoteGeneratedAt,
      errors: errors,
      note: remoteParsed.kind === 'corrupt' ? '远端汇总损坏，已保留本机版本' : ''
    };
  }
  if (remoteSummary !== null) {
    return {
      winner: 'remote',
      text: serializeSummary(remoteSummary),
      localGeneratedAt: localGeneratedAt,
      remoteGeneratedAt: remoteGeneratedAt,
      errors: errors,
      note: localParsed.kind === 'corrupt' ? '本机汇总损坏，已采用远端版本' : ''
    };
  }

  const localBlank = localRaw.trim().length === 0;
  const remoteBlank = remoteRaw.trim().length === 0;
  if (localBlank && remoteBlank) {
    return {
      winner: 'empty',
      text: '',
      localGeneratedAt: -1,
      remoteGeneratedAt: -1,
      errors: errors,
      note: ''
    };
  }
  // 至少一侧有内容但都不可用：原样保留本机文件，绝不静默清空
  const text = localBlank ? remoteRaw : localRaw;
  return {
    winner: 'local',
    text: text,
    localGeneratedAt: localGeneratedAt,
    remoteGeneratedAt: remoteGeneratedAt,
    errors: errors,
    note: '两侧汇总都不可用，已原样保留现有文本'
  };
}

// ---------------------------------------------------------------- 2. open.jsonl（同 id 取 ts 较新）

/** 一次 `open.jsonl` 合并的统计与结果。 */
export interface OpenIndexMergeStats {
  /** 只在本机出现的 id 数（保留）。 */
  localOnly: number;
  /** 只在远端出现的 id 数（保留）。 */
  remoteOnly: number;
  /** 同 id、`ts` 相同、内容不同的条数（取本机）。 */
  conflicts: number;
  /** 合并结果：`ts` 升序 → 同 `ts` 按 `id` 升序，无重复 id。 */
  result: OpenEntry[];
  /** 两侧坏行总数。 */
  errors: number;
  /** 本机侧坏行数。 */
  localErrors: number;
  /** 远端侧坏行数。 */
  remoteErrors: number;
  /** 两侧同 id、`ts` 相同且内容相同的条数（已去重）。 */
  duplicates: number;
}

/** `mergeOpenIndexTexts()` 的结果。 */
export interface OpenIndexMergeResult {
  /** 合并后的完整 JSONL（每行 `encodeOpenEntry` 规范格式；两侧都空时为 `''`）。 */
  text: string;
  stats: OpenIndexMergeStats;
  /** 冲突 id（`ts` 升序 → `id` 升序）。 */
  conflictIds: string[];
}

/** 一条索引条目的规范单行（无行尾换行），用于「内容是否相同」判定。 */
function canonicalOpenLine(entry: OpenEntry): string {
  try {
    const encoded = encodeOpenEntry(entry);
    return encoded.endsWith('\n') ? encoded.slice(0, encoded.length - 1) : encoded;
  } catch (error) {
    return JSON.stringify(entry);
  }
}

/** 索引结果排序：`ts` 升序 → 同 `ts` 按 `id` 升序。 */
function compareEntries(left: OpenEntry, right: OpenEntry): number {
  const delta = compareTs(left.ts, right.ts);
  if (delta !== 0) {
    return delta;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/** 单侧坏行计数（`parseOpenIndex` 永不抛）。 */
function openErrorsOf(text: string): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }
  return parseOpenIndex(text).errors.length;
}

/**
 * 合并两份 `open.jsonl`：按 id 折叠，**同 id 取 `ts` 较新**；`ts` 相同内容不同 → 冲突取本机。
 * 任一单侧独有的 id 都保留（远端新增不丢，远端缺行不当删除）。**永不抛异常**。
 */
export function mergeOpenIndexTexts(localText: string, remoteText: string): OpenIndexMergeResult {
  const localRaw = typeof localText === 'string' ? localText : '';
  const remoteRaw = typeof remoteText === 'string' ? remoteText : '';
  const localErrors = openErrorsOf(localRaw);
  const remoteErrors = openErrorsOf(remoteRaw);

  const localById = new Map<string, OpenEntry>();
  for (const entry of foldOpenByid(localRaw.length === 0 ? [] : parseOpenIndex(localRaw).entries)) {
    localById.set(entry.id, entry);
  }
  const remoteById = new Map<string, OpenEntry>();
  for (const entry of foldOpenByid(remoteRaw.length === 0 ? [] : parseOpenIndex(remoteRaw).entries)) {
    remoteById.set(entry.id, entry);
  }

  let localOnly = 0;
  let remoteOnly = 0;
  let conflicts = 0;
  let duplicates = 0;
  const winners: OpenEntry[] = [];
  const conflictIds: string[] = [];

  localById.forEach((localEntry: OpenEntry, id: string) => {
    const remoteEntry = remoteById.get(id);
    if (remoteEntry === undefined) {
      localOnly += 1;
      winners.push(localEntry);
      return;
    }
    const delta = compareTs(localEntry.ts, remoteEntry.ts);
    if (delta > 0) {
      winners.push(localEntry);
      return;
    }
    if (delta < 0) {
      winners.push(remoteEntry);
      return;
    }
    if (canonicalOpenLine(localEntry) === canonicalOpenLine(remoteEntry)) {
      duplicates += 1;
      winners.push(localEntry);
      return;
    }
    conflicts += 1;
    conflictIds.push(id);
    winners.push(localEntry);
  });
  remoteById.forEach((remoteEntry: OpenEntry, id: string) => {
    if (localById.has(id)) {
      return;
    }
    remoteOnly += 1;
    winners.push(remoteEntry);
  });

  winners.sort(compareEntries);
  conflictIds.sort();
  const lines: string[] = [];
  const kept: OpenEntry[] = [];
  let encodeErrors = 0;
  for (let index = 0; index < winners.length; index++) {
    const entry = winners[index];
    try {
      lines.push(encodeOpenEntry(entry));
    } catch (error) {
      encodeErrors += 1;
      continue;
    }
    kept.push(entry);
  }

  const stats: OpenIndexMergeStats = {
    localOnly: localOnly,
    remoteOnly: remoteOnly,
    conflicts: conflicts,
    result: kept,
    errors: localErrors + remoteErrors + encodeErrors,
    localErrors: localErrors,
    remoteErrors: remoteErrors,
    duplicates: duplicates
  };
  const result: OpenIndexMergeResult = {
    text: lines.join(''),
    stats: stats,
    conflictIds: conflictIds
  };
  return result;
}

// ---------------------------------------------------------------- 3. 按天 zip（保留两份）

/** 一个 zip 文件（名字 + 原始字节；本模块不做解压）。 */
export interface ArchiveInput {
  name: string;
  bytes: Uint8Array;
}

/** 合并后要保留的一份 zip。 */
export interface ArchiveVariant {
  /** 最终文件名（可能带 `.local` / `.remote` / `.1` 后缀）。 */
  name: string;
  /** 这份内容来自哪一侧：`local` | `remote` | `base`。 */
  role: string;
  /** 内容 sha256（小写十六进制）。 */
  sha256: string;
  bytes: Uint8Array;
}

/** `mergeArchivePair()` 的结果。 */
export interface ArchiveMergeResult {
  /** 必须保留下来的份（同名同内容时只有一份）。 */
  variants: ArchiveVariant[];
  /** 两侧内容是否完全相同（只留一份）。 */
  identical: boolean;
  /** 是否发生了改名（同名不同内容）。 */
  renamed: boolean;
  /** 本机内容 sha256；该侧不存在时为空串。 */
  localSha256: string;
  /** 远端内容 sha256；该侧不存在时为空串。 */
  remoteSha256: string;
}

/** 目录里已存在的文件（名字 + 内容 sha256），用于「不覆盖、只补缺」。 */
export interface ArchiveExisting {
  name: string;
  sha256: string;
}

/** 计划要写的一个新文件。 */
export interface ArchiveWrite {
  name: string;
  role: string;
  bytes: Uint8Array;
}

/** `planArchiveWrites()` 的落盘计划。 */
export interface ArchiveWritePlan {
  /** 需要新写出的文件（绝不与已存在文件同名不同内容）。 */
  writes: ArchiveWrite[];
  /** 已存在且内容相同、无需再写的文件（内容已安全落盘）。 */
  kept: string[];
  identical: boolean;
  renamed: boolean;
  localSha256: string;
  remoteSha256: string;
  /** 给用户看的说明。 */
  note: string;
}

/** 一侧内容的 sha256（`null` → 空串）。 */
export function archiveSha256(input: ArchiveInput | null): string {
  if (input === null || input === undefined) {
    return '';
  }
  return sha256Hex(input.bytes);
}

/**
 * 两份同名/不同名 zip 的合并决策：**同名不同内容 → 保留两份**（`.local` / `.remote`），
 * 同名同内容 → 只留一份，只有一侧 → 保留原名。**不修改入参、不碰文件系统**。
 */
export function mergeArchivePair(local: ArchiveInput | null, remote: ArchiveInput | null): ArchiveMergeResult {
  const localSha = archiveSha256(local);
  const remoteSha = archiveSha256(remote);

  if (local === null && remote === null) {
    const empty: ArchiveMergeResult = {
      variants: [],
      identical: false,
      renamed: false,
      localSha256: '',
      remoteSha256: ''
    };
    return empty;
  }
  if (local === null) {
    const only = remote as ArchiveInput;
    const variants: ArchiveVariant[] = [
      { name: only.name, role: 'remote', sha256: remoteSha, bytes: only.bytes }
    ];
    const onlyRemote: ArchiveMergeResult = {
      variants: variants,
      identical: false,
      renamed: false,
      localSha256: '',
      remoteSha256: remoteSha
    };
    return onlyRemote;
  }
  if (remote === null) {
    const only = local as ArchiveInput;
    const variants: ArchiveVariant[] = [
      { name: only.name, role: 'local', sha256: localSha, bytes: only.bytes }
    ];
    const onlyLocal: ArchiveMergeResult = {
      variants: variants,
      identical: false,
      renamed: false,
      localSha256: localSha,
      remoteSha256: ''
    };
    return onlyLocal;
  }

  const localInput = local as ArchiveInput;
  const remoteInput = remote as ArchiveInput;
  const localName = typeof localInput.name === 'string' ? localInput.name.trim() : '';
  const remoteName = typeof remoteInput.name === 'string' ? remoteInput.name.trim() : '';

  // 不同名（例如两天的 zip 被放在一起比较）：各留原名，不构成冲突
  if (localName !== remoteName) {
    const both: ArchiveVariant[] = [
      { name: localInput.name, role: 'local', sha256: localSha, bytes: localInput.bytes },
      { name: remoteInput.name, role: 'remote', sha256: remoteSha, bytes: remoteInput.bytes }
    ];
    const differentNames: ArchiveMergeResult = {
      variants: both,
      identical: localSha === remoteSha,
      renamed: false,
      localSha256: localSha,
      remoteSha256: remoteSha
    };
    return differentNames;
  }

  // 同名同内容：只留一份（手上这一份就是对方那一份）
  if (localSha === remoteSha) {
    const one: ArchiveVariant[] = [
      { name: remoteInput.name, role: 'base', sha256: remoteSha, bytes: remoteInput.bytes }
    ];
    const same: ArchiveMergeResult = {
      variants: one,
      identical: true,
      renamed: false,
      localSha256: localSha,
      remoteSha256: remoteSha
    };
    return same;
  }

  // 同名不同内容：手迹可能不同，两份都要留（改名，绝不覆盖）
  const two: ArchiveVariant[] = [
    { name: localVariantName(localName), role: 'local', sha256: localSha, bytes: localInput.bytes },
    { name: remoteVariantName(remoteName), role: 'remote', sha256: remoteSha, bytes: remoteInput.bytes }
  ];
  const renamed: ArchiveMergeResult = {
    variants: two,
    identical: false,
    renamed: true,
    localSha256: localSha,
    remoteSha256: remoteSha
  };
  return renamed;
}

/** 取一个还没被占用的名字：`name` → `name` 已占 → 插 `.1` / `.2` …（保证不覆盖）。 */
function nextFreeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  for (let index = 1; index <= 999; index++) {
    const candidate = insertSuffix(name, String(index));
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`同名附件变体过多，无法为 ${name} 找到空闲文件名`);
}

/**
 * 把「合并决策」翻译成「落盘计划」：目录里已有同内容文件就不再写（`kept`），
 * 要写的新名字绝不与已存在文件重名（重名 → `.1` / `.2` 后缀），因此**不存在覆盖丢手迹的路径**。
 *
 * @param existing 目标目录现有文件（名字 + sha256）
 * @param local 本机快照（pull 前的本机份）；没有则 `null`
 * @param remote 工作副本里的当前份；没有则 `null`
 */
export function planArchiveWrites(
  existing: ArchiveExisting[],
  local: ArchiveInput | null,
  remote: ArchiveInput | null
): ArchiveWritePlan {
  const merged = mergeArchivePair(local, remote);
  const taken = new Set<string>();
  const existingShaByName = new Map<string, string>();
  for (let index = 0; index < existing.length; index++) {
    const item = existing[index];
    if (item === null || item === undefined) {
      continue;
    }
    taken.add(item.name);
    existingShaByName.set(item.name, item.sha256);
  }

  const writes: ArchiveWrite[] = [];
  const kept: string[] = [];
  for (let index = 0; index < merged.variants.length; index++) {
    const variant = merged.variants[index];
    let alreadyThere = false;
    existingShaByName.forEach((sha: string, name: string) => {
      if (!alreadyThere && sha === variant.sha256) {
        alreadyThere = true;
        if (kept.indexOf(name) < 0) {
          kept.push(name);
        }
      }
    });
    if (alreadyThere) {
      continue;
    }
    const target = nextFreeName(variant.name, taken);
    taken.add(target);
    writes.push({ name: target, role: variant.role, bytes: variant.bytes });
  }

  let note = '';
  if (merged.renamed) {
    note = '同名附件内容不同：已分别保留本机与远端两份（不覆盖）';
  } else if (merged.identical && merged.variants.length > 0) {
    note = '同名附件内容相同：只保留一份';
  }

  const plan: ArchiveWritePlan = {
    writes: writes,
    kept: kept,
    identical: merged.identical,
    renamed: merged.renamed,
    localSha256: merged.localSha256,
    remoteSha256: merged.remoteSha256,
    note: note
  };
  return plan;
}
