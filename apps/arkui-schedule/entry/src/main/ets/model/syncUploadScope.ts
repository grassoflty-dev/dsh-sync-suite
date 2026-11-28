/**
 * 上传范围（纯逻辑：不 import @ohos / UI，可在 Node 直接跑）。
 *
 * 背景（mod-app-pending-upload-diagnosis）：v2 周期原先只 `add` **union 改写过内容**的日文件。
 * 但应用自己的写入器（`timelineWriteStore.append/scheduleDelete/restore/appendSummary`、
 * 导入落盘）是**先写工作副本、后触发同步**，union 重算出来的字节与本地一致 → 该路径不进
 * 提交集合 → `git status` 永远把它算作「本地改动 N 处（本机未上传·待上传）」，而且这份改动
 * 永远不会被推送。本模块把「哪些工作区路径本设备应当上传」抽成可执行函数，供：
 *
 * 1. `model/syncCycle.ts` 计算一个周期的提交集合（union 改写的 ∪ git 实测脏路径里可上传的）；
 * 2. `services/GitSyncService.ets` 把 `status` 的脏路径分成「可上传」与「不在上传范围」，
 *    让 `describeSyncStatus` 能如实区分（绝不把不可上传的路径说成「待上传」）。
 *
 * 计数与提交集合因此来自**同一份事实**（同一次 `status` 的 changed 行 + 同一份可上传口径），
 * 不会出现「行里说 N 处待上传、周期却一处也不提交」的两套口径。
 *
 * 判定口径（与 `docs/DATA-CONTRACT-v2.md` §1/§11、桥侧 `addCommit` 白名单一致）：
 * - 可上传：`timeline/schema.json` 与 `timeline/<YYYY-MM-DD>/<…>` 下的普通文件（含 media/、summary.json）；
 * - **mod-app-chat-hide 的唯一例外**：字面量恰好 `chats/index.jsonl`（一条隐藏行追加），
 *   与 `docs/CHAT-DELETE-DESIGN.md` §5 的精确白名单同口径，**不是 `chats/` 前缀放宽**；
 * - 不可上传：`chats/<id>/meta.json`、`chats/<id>/session.jsonl`、裸 `chats/`、`devices/**`（v2 零写入）、
 *   仓库根下的其它文件、非法路径（绝对路径 / `..` 穿越 / `chats//index.jsonl` / `.bak`），
 *   以及 `timeline/**` 里的写入残留（`.tmp-` / `.bak-` 中间件）——残留不推给共享仓库，
 *   也不假装它会「待上传」。
 */

import { normalizeRepoPath } from './syncScope';

/** 仓库内时间线根目录名（与 timelineWriteStore / 桥侧白名单同一个字面量）。 */
export const TIMELINE_DIR_NAME: string = 'timeline';

/** 仓库级 schema 标记文件（§11 门禁读取的同一个文件）。 */
export const TIMELINE_SCHEMA_PATH: string = 'timeline/schema.json';

/** 原子替换的临时文件中缀（timelineWriteStore / syncProtocolStore 共用同一种命名）。 */
export const TEMP_INFIX: string = '.tmp-';

/** 旧文件备份后缀（原子替换失败时的留档）。 */
export const BAK_INFIX: string = '.bak-';

/**
 * mod-app-chat-hide：平板唯一可写的 chats 路径，字面量精确相等（不归一化、不做前缀匹配）。
 * 与 `model/chatHide.ts` 的 `HIDE_INDEX_PATH` 同值；这里的副本让上传范围层不反向依赖隐藏模型。
 */
export const CHAT_HIDE_INDEX_PATH: string = 'chats/index.jsonl';

/** 日目录名必须是日历日：`YYYY-MM-DD`（与时间线目录约定一致）。 */
const DAY_DIR_RE: RegExp = /^\d{4}-\d{2}-\d{2}$/;

/** 脏路径分区结果：可上传 / 不在上传范围（后者只用于如实措辞，绝不静默丢弃计数）。 */
export interface DirtyPartition {
  uploadable: string[];
  notUploadable: string[];
}

/**
 * 路径是否是写入残留（原子替换的 `.tmp-` 中间件 / `.bak-` 备份）。
 *
 * 残留是**本机内部文件**：推给共享仓库会污染远端，也不该被当成「待上传的用户改动」。
 * 判定看任意一段是否含中缀，或文件名是否以 `.tmp` / `.bak` 结尾——两条都只认字面量，
 * 不猜扩展名。
 */
export function isTempLeftoverPath(path: string): boolean {
  const normalized: string | null = normalizeRepoPath(path);
  if (normalized === null) {
    return true;
  }
  const parts: string[] = normalized.split('/');
  for (let index = 0; index < parts.length; index++) {
    const segment: string = parts[index];
    if (segment.indexOf(TEMP_INFIX) >= 0 || segment.indexOf(BAK_INFIX) >= 0) {
      return true;
    }
    if (segment.endsWith('.tmp') || segment.endsWith('.bak')) {
      return true;
    }
  }
  return false;
}

/**
 * 路径取「时间线范围」：`timeline` 根 / `timeline/schema.json` / `timeline/<date>/…` 才算；
 * 其它（含 `devices/**`、仓库根文件、别的目录）返回 `null`。
 */
function timelineParts(path: string): string[] | null {
  const normalized: string | null = normalizeRepoPath(path);
  if (normalized === null) {
    return null;
  }
  const parts: string[] = normalized.split('/');
  if (parts[0] !== TIMELINE_DIR_NAME || parts.length < 2) {
    return null;
  }
  if (parts.length === 2) {
    // timeline/schema.json：仓库级标记；其它根下文件不属于 v2 契约
    return parts[1] === 'schema.json' ? parts : null;
  }
  if (!DAY_DIR_RE.test(parts[1])) {
    return null;
  }
  return parts;
}

/**
 * 该路径本设备应当上传吗（口径见文件头；残留不算）。
 *
 * mod-app-chat-hide：先按**原始字符串**做一次精确相等判定，只有 `chats/index.jsonl` 这一个
 * chats 路径能过；`chats//index.jsonl`、`chats/index.jsonl.bak`、`chats/<id>/**` 全走下面的
 * 时间线判定并失败（时间线分支只认 `timeline/` 根）。
 */
export function isUploadableTimelinePath(path: string): boolean {
  if (path === CHAT_HIDE_INDEX_PATH) {
    return true;
  }
  const parts: string[] | null = timelineParts(path);
  if (parts === null) {
    return false;
  }
  return !isTempLeftoverPath(path);
}

/**
 * 路径所属的日（`timeline/<date>/…` → `date`；`timeline/schema.json` → 空串）。
 * 非法 / 不在时间线范围内返回 `null`（调用方据此丢弃，绝不猜日期）。
 */
export function timelineDayOfPath(path: string): string | null {
  const parts: string[] | null = timelineParts(path);
  if (parts === null) {
    return null;
  }
  if (parts.length === 2) {
    return '';
  }
  return parts[1];
}

/** 脏路径 → {uploadable, notUploadable}：保持输入顺序、逐项规范化；同一路径只出现一次。 */
export function partitionDirtyPaths(paths: string[]): DirtyPartition {
  const uploadable: string[] = [];
  const notUploadable: string[] = [];
  const seen: Record<string, boolean> = {};
  if (!Array.isArray(paths)) {
    return { uploadable: uploadable, notUploadable: notUploadable };
  }
  // mod-app-chat-hide：归一化同形路径（如 chats//index.jsonl）与精确字面量同键，
  // 不能让先到的别名占住去重键、压制后到的合法隐藏行。先确认全量里是否真有字面量：
  // 有 → 别名直接跳过且不占 seen 键（两种到达顺序都优先字面量）；
  // 没有 → 别名仍按原口径进 notUploadable，并在别名之间照旧去重（计数不丢失）。
  const hasHideLiteral: boolean = paths.some(
    (raw: string): boolean => typeof raw === 'string' && raw === CHAT_HIDE_INDEX_PATH
  );
  for (let index = 0; index < paths.length; index++) {
    const raw: string = typeof paths[index] === 'string' ? paths[index] : '';
    const normalized: string | null = normalizeRepoPath(raw);
    const key: string = normalized === null ? `invalid:${raw}` : normalized;
    // 隐藏行只认原始字面量：归一化后的同形路径（如 chats//index.jsonl）不算可上传。
    const hideLiteral: boolean = normalized === CHAT_HIDE_INDEX_PATH && raw === CHAT_HIDE_INDEX_PATH;
    if (normalized === CHAT_HIDE_INDEX_PATH && !hideLiteral) {
      if (!hasHideLiteral) {
        if (seen[key] !== true) {
          seen[key] = true;
          notUploadable.push(raw);
        }
      }
      continue;
    }
    if (seen[key] === true) {
      continue;
    }
    seen[key] = true;
    if (normalized !== null && isUploadableTimelinePath(normalized)) {
      uploadable.push(normalized);
    } else {
      notUploadable.push(normalized === null ? raw : normalized);
    }
  }
  return { uploadable: uploadable, notUploadable: notUploadable };
}

/**
 * 不在上传范围的路径数（诊断行用的 M）。
 *
 * 只数不推测：传进来的必须是 `status` 实测的脏路径全量；调用方拿不到全量时不要调用本函数，
 * 让视图字段保持 `undefined`（措辞退回单一「本机未上传」，不编造分区）。
 */
export function notUploadableCount(paths: string[]): number {
  return partitionDirtyPaths(paths).notUploadable.length;
}

/**
 * 一个周期的提交集合 = union 改写过内容的路径 ∪ git 实测「已脏且**本机可上传**且在本轮 days 范围内」的路径。
 *
 * 为什么要有第二项：`changedPaths` 只包含「union 重算的字节与本轮读到的不一样」的路径；
 * 应用写入器先落盘、union 随后算出同样字节时它为空，于是本机改动永远不被提交（本模块修复的根因）。
 * 第二项的来源必须是 **git 实测的脏路径**（`status` 的 changed 行），与状态行计数同一份事实；
 * 这样「计数」和「提交集合」不会各说一套，也不会为了覆盖脏路径而每轮盲目全量 add（那会产生空提交）。
 *
 * @param changedPaths  union 改写的路径（可为空）
 * @param dirtyPaths    git 实测的脏路径（含未跟踪）；调用方拿不到时传 `undefined` → 退回旧行为
 * @param days          本轮周期覆盖的日期（不在其中的日文件不提交：本轮没读过它，不该替它做决定）
 */
export function stagePathsForCycle(
  changedPaths: string[],
  dirtyPaths: string[] | undefined,
  days: string[]
): string[] {
  const ordered: string[] = [];
  const seen: Record<string, boolean> = {};
  const changed: string[] = Array.isArray(changedPaths) ? changedPaths : [];
  for (let index = 0; index < changed.length; index++) {
    const rawChanged: string = typeof changed[index] === 'string' ? changed[index] : '';
    const normalized: string | null = normalizeRepoPath(rawChanged);
    if (normalized === null || seen[normalized] === true) {
      continue;
    }
    // 与下面脏路径循环同一口径：先挡归一化同形路径，再过上传范围谓词。
    // 本函数对任意调用方都要自身满足「只有 chats/index.jsonl 这一个 chats 例外」。
    if (normalized === CHAT_HIDE_INDEX_PATH && rawChanged !== CHAT_HIDE_INDEX_PATH) {
      continue;
    }
    if (!isUploadableTimelinePath(normalized)) {
      continue;
    }
    seen[normalized] = true;
    ordered.push(normalized);
  }
  if (!Array.isArray(dirtyPaths)) {
    return ordered;
  }
  const scope: Record<string, boolean> = {};
  const dayList: string[] = Array.isArray(days) ? days : [];
  for (let index = 0; index < dayList.length; index++) {
    if (typeof dayList[index] === 'string' && dayList[index].length > 0) {
      scope[dayList[index]] = true;
    }
  }
  for (let index = 0; index < dirtyPaths.length; index++) {
    const rawDirty: string = typeof dirtyPaths[index] === 'string' ? dirtyPaths[index] : '';
    const normalized: string | null = normalizeRepoPath(rawDirty);
    if (normalized === null || seen[normalized] === true) {
      continue;
    }
    if (normalized === CHAT_HIDE_INDEX_PATH && rawDirty !== CHAT_HIDE_INDEX_PATH) {
      continue; // 只认原始字面量，不把归一化同形路径当隐藏行
    }
    if (!isUploadableTimelinePath(normalized)) {
      continue;
    }
    // mod-app-chat-hide：隐藏行不属任何日，与 schema.json 同口径「总是随周期走」；
    // 这样工作副本里已落盘的墓碑不会因为 days 范围之外而被长期遗漏。
    if (normalized === CHAT_HIDE_INDEX_PATH) {
      seen[normalized] = true;
      ordered.push(normalized);
      continue;
    }
    const day: string | null = timelineDayOfPath(normalized);
    // schema.json（day=''）总是随周期走：它是 §11 门禁读的仓库级标记，不该长期只存在本机。
    if (day !== '' && (day === null || scope[day] !== true)) {
      continue;
    }
    seen[normalized] = true;
    ordered.push(normalized);
  }
  return ordered;
}

/** 提交集合里覆盖的日数（提交信息 `[v2] sync <n> days` 的 n 取下界）。 */
export function daysInStageSet(paths: string[]): number {
  const seen: Record<string, boolean> = {};
  let count: number = 0;
  const list: string[] = Array.isArray(paths) ? paths : [];
  for (let index = 0; index < list.length; index++) {
    const day: string | null = timelineDayOfPath(list[index]);
    if (day === null || day.length === 0 || seen[day] === true) {
      continue;
    }
    seen[day] = true;
    count += 1;
  }
  return count;
}
