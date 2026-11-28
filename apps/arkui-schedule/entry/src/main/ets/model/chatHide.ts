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

/**
 * mod-app-hide-commit-reconcile：闸内三态对账（纯函数，零 IO / 零写 / 零 SDK）。
 *
 * 背景：hideChat 先把隐藏行落盘，之后才拿写闸。同步周期的 stagePaths 恰好也接受
 * `chats/index.jsonl`，所以周期可能在自己那次 `[v2] sync N days` 提交里把这一行带走，
 * 甚至已经推送。此时 hideChat 再 add→commit 已经「没有可提交内容」，旧实现一律报
 * commit 失败 —— 对用户是一次**假失败**（删除其实已经生效）。本函数只用三个只读事实：
 * HEAD 里 `chats/index.jsonl` 的原文、本次要写的具体隐藏行、HEAD 与 origin/main 的关系。
 *
 * 返回：
 * - `commit`：HEAD 里没有这一行 —— 真没被任何提交带上（含首次隐藏 HEAD 根本没有该文件），
 *   走原来的 add → commit → push；提交真失败时仍是既有 commit 原因。
 * - `done`：这一行在 HEAD，且 HEAD 与 origin/main 同 sha（equal），或 HEAD 是 origin/main 的祖先
 *   （behind）—— 这一行已经在远端历史里，周期已提交并推送，直接成功，不重复 commit / push，
 *   也不新增任何用户可见失败文案。behind 时若 origin/main 后来又前进、在新提交里移除了这一行，
 *   远端当前其实不再隐藏；这是有意的取舍：行既然发布过，本地索引仍是唯一真相，不因为 behind 就
 *   倒推远端状态，更不重试一次注定 non-fast-forward 的 push（详见函数内注释）。
 * - `push`：这一行在 HEAD，但 HEAD 比 origin/main 新（ahead）或与它分叉（diverged），或关系
 *   无法识别（保守路径）—— 远端可能还没有这一行，补一次推送；推送成功即成功，失败仍是既有
 *   push 原因。
 *
 * 匹配按**整行.trim()**，由 `hasHideLine` 单独提供：闸内 gate（要不要读关系）与本函数的三态决策
 * 共用同一判据，只认本次 hideLineOf 生成的那一行，不把别的 id / 子串误认成自己，也不把 CRLF
 * 差异当成没写进去。
 */
export type HideReconcileDecision = 'commit' | 'done' | 'push';

/**
 * HEAD 文本里是否**整行**等于本次隐藏行（trim 后比较，兼容 CRLF）。
 * 闸内廉价 gate 与三态决策共用这一个判据：光是子串包含不足以证明这一行已进 HEAD。
 */
export function hasHideLine(headText: string, hideLine: string): boolean {
  if (typeof headText !== 'string' || typeof hideLine !== 'string' || hideLine.length === 0) {
    return false;
  }
  const lines: string[] = headText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === hideLine) {
      return true;
    }
  }
  return false;
}

export function decideHideReconcile(headText: string, hideLine: string, relation: string): HideReconcileDecision {
  if (!hasHideLine(headText, hideLine)) {
    return 'commit';
  }
  // equal / behind 都算已发布：这一行已经在 origin/main 的历史里，从 behind 再 push 只会换来
  // non-fast-forward 拒绝 —— 那又是一次「删除其实成功、界面却报失败」的假失败。
  // 唯一的取舍：behind 时 origin/main 可能又前进并在新提交里移除了这一行，远端当前不再隐藏；
  // 仍然判 done，是因为行已发布过、本地索引才是唯一真相，不能靠 behind 反推远端状态，
  // 更不能重试一次注定失败的 push。恢复显示只走显式 unarchive，本模块不产生该行。
  // ahead / diverged 才是「本地已提交、远端还没有」，补一次 push；未知关系保守按 push 处理，
  // 让 push 的真实成败说话（fail-safe，绝不凭空报成功）。
  if (relation === 'equal' || relation === 'behind') {
    return 'done';
  }
  return 'push';
}
