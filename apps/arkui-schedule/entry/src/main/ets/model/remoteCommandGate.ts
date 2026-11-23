/**
 * mod-remote-command-gate（RC-4）：跨设备「发指令」的**单次确认闸**纯判定层（零 SDK import，Node 可单测）。
 *
 * 为什么单列一层：把指令发给另一台电脑是不可撤销动作，用户必须在发送前看到「发给谁、用哪个工具、
 * 正文是什么」，并且**一次确认只覆盖一次发送**。任何一项不满足都 typed 拒绝、绝不静默发送。
 *
 * 三条硬纪律：
 * 1. view 权永不隐含 command 权：只有显式授予 `session.prompt` 的实例才可能进入可发送态；
 * 2. 确认与草稿指纹绑定：确认时记下草稿摘要，正文/目标/工具任一变化都必须重新确认（防 TOCTOU）；
 * 3. 预览与拒绝文案只含目标实例名、工具名与正文摘要，**绝不含 token / 地址凭据 / 指纹**。
 */

// mod-grant-vocab-parity：命令授权词表已扩到 5 个工具，但 composer 仍只接受 session.prompt。
// 用窄谓词 isPromptTool 而不是 isCommandTool，词表变宽不会把发送权一起放宽（行为保持）。
import { isPromptTool } from './instanceGrant';

/** 指令正文上限（字符）：超过就拒绝，避免把整段对话粘进一次远程写入。 */
export const COMMAND_TEXT_LIMIT: number = 2000;

/** 单次确认的绑定值：草稿指纹（决定「确认是否还对应这份草稿」）。 */
export interface CommandDraft {
  /** 目标实例 id（与实例表同一键）。 */
  instanceId: string;
  /** 目标实例的展示名（只用于预览，不参与指纹）。 */
  instanceName: string;
  /** 工具名；当前唯一合法值 `session.prompt`。 */
  tool: string;
  /** 指令正文。 */
  text: string;
}

export type CommandRefusalCode =
  | 'E_COMMAND_TARGET_MISSING'
  | 'E_COMMAND_TOOL_NOT_ALLOWED'
  | 'E_COMMAND_TEXT_EMPTY'
  | 'E_COMMAND_TEXT_TOO_LONG'
  | 'E_COMMAND_NOT_GRANTED'
  | 'E_COMMAND_UNCONFIRMED'
  | 'E_COMMAND_CONFIRM_STALE'
  | 'E_COMMAND_REMOTE_UNVERIFIED';

/** 固定中文文案：不含地址 / token / 指纹；每条都可直接上屏。 */
export const COMMAND_WORDING: Readonly<Record<CommandRefusalCode, string>> = Object.freeze({
  E_COMMAND_TARGET_MISSING: '请先选择一个已配对的实例',
  E_COMMAND_TOOL_NOT_ALLOWED: '该工具不是允许的指令工具（只允许 session.prompt）',
  E_COMMAND_TEXT_EMPTY: '请先输入要发送的指令',
  E_COMMAND_TEXT_TOO_LONG: `指令过长（上限 ${COMMAND_TEXT_LIMIT} 字）`,
  E_COMMAND_NOT_GRANTED: '该实例未授予发指令权限（查看权限不包含发指令）',
  E_COMMAND_UNCONFIRMED: '发送前需要在确认框里勾选「确认发送」',
  E_COMMAND_CONFIRM_STALE: '草稿已改变，请重新确认后发送',
  E_COMMAND_REMOTE_UNVERIFIED: '安全连接尚未通过真机校验，未发送任何内容',
});

export interface CommandGateInput {
  draft: CommandDraft;
  /** 该实例是否显式授予了 command 工具（view 权不算）。 */
  commandGranted: boolean;
  /** 用户是否在确认框里勾选（一次发送对应一次勾选）。 */
  confirmed: boolean;
  /** 确认时记下的草稿指纹；未确认过为空串。 */
  confirmedFingerprint: string;
  /** 承载请求的通道是否已通过真机 pin 校验（今天恒为 false）。 */
  remoteVerified: boolean;
}

export type CommandGateDecision =
  | { ok: true; fingerprint: string; preview: string }
  | { ok: false; code: CommandRefusalCode; wording: string };

function refuse(code: CommandRefusalCode): CommandGateDecision {
  return { ok: false, code: code, wording: COMMAND_WORDING[code] };
}

/**
 * 草稿指纹：只由「目标 + 工具 + 正文」决定，用长度前缀拼接避免分隔符注入。
 * 不引入哈希库：这是纯函数，跨 ArkTS / Node 结果逐字节一致。
 */
export function commandFingerprint(draft: CommandDraft): string {
  const parts: string[] = [draft.instanceId, draft.tool, draft.text];
  let out: string = '';
  for (const part of parts) {
    out += `${part.length}:${part}|`;
  }
  return out;
}

/** 发送预览：发给谁、用哪个工具、正文原样（正文是用户自己输入的内容，不是凭据）。 */
export function commandPreview(draft: CommandDraft): string {
  const name: string = draft.instanceName.trim().length > 0 ? draft.instanceName.trim() : draft.instanceId;
  return `将向「${name}」发送指令（${draft.tool}）：\n${draft.text}`;
}

/**
 * 唯一判定入口。顺序固定：目标 → 工具 → 正文 → 授权 → 确认 → 指纹一致 → 通道可信。
 * 前六步都是本地判定，最后一步（remoteVerified）才涉及网络；任一步失败都不发请求。
 */
export function decideCommandSend(input: CommandGateInput): CommandGateDecision {
  const draft: CommandDraft = input.draft;
  if (typeof draft.instanceId !== 'string' || draft.instanceId.trim().length === 0) {
    return refuse('E_COMMAND_TARGET_MISSING');
  }
  if (!isPromptTool(draft.tool)) {
    return refuse('E_COMMAND_TOOL_NOT_ALLOWED');
  }
  const text: string = typeof draft.text === 'string' ? draft.text : '';
  if (text.trim().length === 0) {
    return refuse('E_COMMAND_TEXT_EMPTY');
  }
  if (text.length > COMMAND_TEXT_LIMIT) {
    return refuse('E_COMMAND_TEXT_TOO_LONG');
  }
  if (input.commandGranted !== true) {
    return refuse('E_COMMAND_NOT_GRANTED');
  }
  if (input.confirmed !== true) {
    return refuse('E_COMMAND_UNCONFIRMED');
  }
  const fingerprint: string = commandFingerprint(draft);
  // 确认只对「确认时那份草稿」有效：正文或目标改了就必须重新确认。
  if (input.confirmedFingerprint !== fingerprint) {
    return refuse('E_COMMAND_CONFIRM_STALE');
  }
  if (input.remoteVerified !== true) {
    return refuse('E_COMMAND_REMOTE_UNVERIFIED');
  }
  return { ok: true, fingerprint, preview: commandPreview(draft) } as CommandGateDecision;
}
