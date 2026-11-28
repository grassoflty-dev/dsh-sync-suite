/**
 * mod-chat-hide：单条会话"删除 = 隐藏"的纯逻辑（零 SDK import，Node 可直接单测）。
 *
 * 现在这条链已经接通：`pages/Chats.ets` 的**逐行**删除按钮 → `chatHidePlanOf()` 确认 sheet
 * → `services/chatStore.ets` 的 `hideChat(id)` 追加一行 → 窄写通道 commit/push。
 * 设计 `docs/CHAT-DELETE-DESIGN.md` §12：没有恢复 UI，也不产出 `op:"unarchive"`，
 * 所以确认文案必须一次说清不可逆；隐藏只写成 `chats/index.jsonl` 的一条追加行
 * `{"op":"archive","id":…,"deletedAt":<ms>}`，载荷 / `chats/<id>/**` / Git 历史一个字节都不动。
 * 索引是唯一真相：任一阶段失败都不保留本地乐观隐藏，页面每次都重读索引。
 */

/** 确认弹层标题（逐字，§12.5）。 */
export const HIDE_TITLE: string = '删除这条会话？';
/** 正文第一行：说清列表影响与云端记录保留。 */
export const HIDE_BODY_KEEP: string = '删除后不再显示在会话列表；云端记录不会被抹除。';
/** 正文第二行：说清没有恢复入口（禁用「可恢复 / 撤销 / 彻底 / 永久」字样）。 */
export const HIDE_BODY_NO_RESTORE: string = '目前没有恢复入口，删除后应用内无法找回。';
export const HIDE_CONFIRM: string = '删除';
export const HIDE_CANCEL: string = '取消';

/** 确认 sheet 的唯一文案来源：页面只渲染这里的字段，不自己拼规则。 */
export interface ChatHidePlan {
  title: string;
  lines: string[];
  confirmLabel: string;
  cancelLabel: string;
}

/** 纯确认计划（无入参、无副作用）；逐字来自常量，避免按钮文案漂移。 */
export function chatHidePlanOf(): ChatHidePlan {
  return {
    title: HIDE_TITLE,
    lines: [HIDE_BODY_KEEP, HIDE_BODY_NO_RESTORE],
    confirmLabel: HIDE_CONFIRM,
    cancelLabel: HIDE_CANCEL
  };
}

/** 仓库相对路径：上传白名单里**字面量恰好**允许平板写的 chats 路径（不是前缀）。 */
export const HIDE_INDEX_PATH: string = 'chats/index.jsonl';

/** 与导出器 / 读侧一致的会话 id 白名单。 */
const HIDE_ID_PATTERN: RegExp = /^[A-Za-z0-9._-]+$/;
const ID_MAX_LENGTH: number = 200;

/** 单条会话 id 是否可直接用于隐藏（纯判定；写者据此在 prepare 阶段早退）。 */
export function isHideId(id: string): boolean {
  if (typeof id !== 'string') {
    return false;
  }
  const text: string = id.trim();
  if (text.length === 0 || text.length > ID_MAX_LENGTH || text === '.' || text === '..') {
    return false;
  }
  return HIDE_ID_PATTERN.test(text);
}

/** id + 毫秒时间戳 → 隐藏行；非法输入返回空串（调用方据此拒绝，不写半个行）。 */
export function hideLineOf(id: string, deletedAt: number): string {
  if (!isHideId(id)) {
    return '';
  }
  const safeId: string = id.trim();
  if (typeof deletedAt !== 'number' || !Number.isFinite(deletedAt) || !Number.isInteger(deletedAt) || deletedAt < 0) {
    return '';
  }
  return JSON.stringify({ op: 'archive', id: safeId, deletedAt: deletedAt });
}

/** 隐藏提交的 subject 前缀：精确形状 `chats: delete <id>`（与归属判定同款，不是放宽成任意文本）。 */
export const HIDE_COMMIT_SUBJECT_PREFIX: string = 'chats: delete ';

/** 隐藏提交尾注：与 v2 同步包同一行，归属判定要求 subject + 尾注 + 白名单路径三者同时成立。 */
export const HIDE_COMMIT_TRAILER: string = 'dsh-dots-v2: plugin-git-store';

/** 单条隐藏提交信息：subject + 尾注两行；不含恢复语义，不携带路径 / 令牌 / 原始错误。 */
export function hideCommitMessageOf(id: string): string {
  if (!isHideId(id)) {
    return '';
  }
  return `${HIDE_COMMIT_SUBJECT_PREFIX}${id.trim()}\n\n${HIDE_COMMIT_TRAILER}`;
}

/**
 * 只追加：旧字节必须是新字节的严格前缀；上一行没有换行时先补一个换行。
 * 空行不写入（绝不制造无意义行），坏输入返回原文。
 */
export function appendHideLine(indexText: string, line: string): string {
  const prefix: string = typeof indexText === 'string' ? indexText : '';
  if (typeof line !== 'string' || line.length === 0) {
    return prefix;
  }
  if (prefix.length === 0) {
    return `${line}\n`;
  }
  return prefix.endsWith('\n') ? `${prefix}${line}\n` : `${prefix}\n${line}\n`;
}

/** 阶段 ①（prepare）：id 非法 / 仓库目录拿不到 / 索引读不出来 —— 一个字节都没写。 */
export const HIDE_FAIL_PREPARE: string = '删除失败：同步仓库或会话索引不可用；没有写入任何内容';
/** 阶段 ②（write）：tmp 写 / 回读 / rename 任一失败 —— 旧索引字节原样保留。 */
export const HIDE_FAIL_WRITE: string = '删除失败：会话索引写入失败；没有写入任何内容';
/** 阶段 ③（commit）：隐藏行已落盘但 addCommit 失败；如实说明，不冒称已推送。 */
export const HIDE_FAIL_COMMIT: string = '删除失败：隐藏行已写入但提交未完成；请稍后重试同步，列表以索引为准';
/** 阶段 ④（push）：本机已隐藏、其它设备尚未一致；不冒称全局完成。 */
export const HIDE_FAIL_PUSH: string = '删除失败：隐藏行已提交但推送未完成；本机列表已隐藏，其它设备稍后同步才会隐藏';

/** 写者的四个阶段（顺序固定，失败即停，不再推进后续阶段）。 */
export type HideStage = 'prepare' | 'write' | 'commit' | 'push';

/**
 * 阶段码 → 中文 typed 原因（sheet / toast 的唯一文案来源）。
 * 只输出上面四句固定文案，绝不把桥的原始错误 / 路径 / 令牌带到界面。
 */
export function hideReasonOf(stage: HideStage): string {
  if (stage === 'write') return HIDE_FAIL_WRITE;
  if (stage === 'commit') return HIDE_FAIL_COMMIT;
  if (stage === 'push') return HIDE_FAIL_PUSH;
  return HIDE_FAIL_PREPARE;
}
