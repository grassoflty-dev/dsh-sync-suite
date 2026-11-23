/**
 * mod-remote-command-wire（RC-4 接线）：单次确认闸的**草稿状态**纯逻辑（零 SDK import，Node 可单测）。
 *
 * 本文件只做一件事：把 UI 的草稿字段收进一个具名状态，并在每次改动后重新问冻结的
 * `model/remoteCommandGate.ts`「现在能不能发」。判定、文案、指纹全部来自那一个闸门，
 * 这里不复制任何一句拒绝文案，也不产生任何「已发送 / 发送中」的状态。
 */

import { TOOL_SESSION_PROMPT } from './instanceGrant';
import { COMMAND_TEXT_LIMIT, COMMAND_WORDING, commandFingerprint, decideCommandSend } from './remoteCommandGate';
import type { CommandDraft, CommandGateDecision, CommandGateInput } from './remoteCommandGate';

/** 当前唯一合法的指令工具（值即 `session.prompt`）。 */
export const COMMAND_TOOL: string = TOOL_SESSION_PROMPT;

/**
 * 承载指令的通道是否已通过真机校验：**恒为 false**。
 *
 * 今天没有任何经过 RC-3 真机门禁的 pinned 通道：远程控制页的原生 pinned client 尚未通过设备
 * 验收（页面只显示「安全连接尚未启用…」），RC-3 的四个真机门禁也没有跑过，因此不存在一个
 * 可以被证明「安全」的出口。把这一位置成 true 必须先跑通那道真机门禁，并且必须自带一份新的
 * 测试来证明翻转本身；只改这个布尔值不构成证据。
 *
 * 同时，当前没有 `sessionPrompt` RPC（`mod-chat-lease` 尚未落地，设备门禁也未过），所以组件
 * 绝不能假装已经把指令投递出去——发送按钮永久禁用，页面上也没有任何在途 / 成功态。
 */
export const REMOTE_CHANNEL_VERIFIED: boolean = false;

/** 发指令草稿的完整状态；确认只绑定「目标 + 工具 + 正文」的指纹。 */
export interface ComposerState {
  instanceId: string;
  instanceName: string;
  tool: string;
  text: string;
  confirmed: boolean;
  confirmedFingerprint: string;
}

/** 新草稿：空正文、未确认（空正文由闸门给出 `E_COMMAND_TEXT_EMPTY` 文案）。 */
export function emptyComposerState(instanceId: string, instanceName: string): ComposerState {
  const state: ComposerState = {
    instanceId: instanceId,
    instanceName: instanceName,
    tool: COMMAND_TOOL,
    text: '',
    confirmed: false,
    confirmedFingerprint: ''
  };
  return state;
}

/** 唯一一处把 ComposerState 投影成闸门认识的 CommandDraft（具名类型，不用推断字面量）。 */
function draftOf(state: ComposerState): CommandDraft {
  const draft: CommandDraft = {
    instanceId: state.instanceId,
    instanceName: state.instanceName,
    tool: state.tool,
    text: state.text
  };
  return draft;
}

/** 复制状态（不改入参；每个字段逐项赋值，避免具名接口之间的结构化赋值）。 */
function copyOf(state: ComposerState): ComposerState {
  const copy: ComposerState = {
    instanceId: state.instanceId,
    instanceName: state.instanceName,
    tool: state.tool,
    text: state.text,
    confirmed: state.confirmed,
    confirmedFingerprint: state.confirmedFingerprint
  };
  return copy;
}

/** 指纹变了就作废确认（防 TOCTOU）；未确认时空指纹也保持空。 */
function privateInvalidate(next: ComposerState): ComposerState {
  if (commandFingerprint(draftOf(next)) !== next.confirmedFingerprint) {
    next.confirmed = false;
    next.confirmedFingerprint = '';
  }
  return next;
}

/** 改正文：先按闸门的上限截断（防御纵深），再按指纹作废旧确认。 */
export function changeText(state: ComposerState, text: string): ComposerState {
  const safeText: string = typeof text === 'string' ? text.slice(0, COMMAND_TEXT_LIMIT) : '';
  const next: ComposerState = copyOf(state);
  next.text = safeText;
  return privateInvalidate(next);
}

/** 换目标：展示名只用于预览、不进指纹；目标 id 变了才作废旧确认。 */
export function changeTarget(state: ComposerState, instanceId: string, instanceName: string): ComposerState {
  const next: ComposerState = copyOf(state);
  next.instanceId = instanceId;
  next.instanceName = instanceName;
  return privateInvalidate(next);
}

/** 勾选 / 取消勾选：勾选时把「当前这份草稿」的指纹记下来，取消时清空。 */
export function setConfirmed(state: ComposerState, confirmed: boolean): ComposerState {
  const next: ComposerState = copyOf(state);
  if (confirmed === true) {
    next.confirmed = true;
    next.confirmedFingerprint = commandFingerprint(draftOf(state));
  } else {
    next.confirmed = false;
    next.confirmedFingerprint = '';
  }
  return next;
}

/** 当前通道是否可信（唯一事实来源，组件不得自己判断）。 */
export function remoteChannelVerified(): boolean {
  return REMOTE_CHANNEL_VERIFIED;
}

/** 组装闸门输入：通道位永远来自 `remoteChannelVerified()`。 */
export function composerGateInput(state: ComposerState, commandGranted: boolean): CommandGateInput {
  const input: CommandGateInput = {
    draft: draftOf(state),
    commandGranted: commandGranted,
    confirmed: state.confirmed,
    confirmedFingerprint: state.confirmedFingerprint,
    remoteVerified: remoteChannelVerified()
  };
  return input;
}

/** 唯一判定：直接转交冻结的闸门，不在本文件里另写一套顺序。 */
export function composerDecision(state: ComposerState, commandGranted: boolean): CommandGateDecision {
  return decideCommandSend(composerGateInput(state, commandGranted));
}

/**
 * 上屏原因：逐字取闸门返回的 `wording`；判定通过时为空串（今天不可达）。
 * 组件只渲染这个字符串，不写第二份文案。
 */
export function composerReason(state: ComposerState, commandGranted: boolean): string {
  const decision: CommandGateDecision = composerDecision(state, commandGranted);
  if (decision.ok === false) {
    return decision.wording;
  }
  return '';
}

/**
 * D2：dots 等**没有 composer 的只读面板**也要显示「为什么发指令不可用」。
 *
 * 这里只做「前置条件 → 闸门文案」的一张映射表：文案一律来自冻结闸的 `COMMAND_WORDING`，
 * 本文件不写第二份中文，面板也不再手写那句「确认闸未接线」的失效旧话（闸门早已接线）。
 * 判定顺序与闸门一致：目标 → 授权 → 通道；通道已验证时返回空串（今天不可达）。
 */
export interface PlaceholderRefusalInput {
  /** 当前有没有可选的有效目标实例。 */
  hasTarget: boolean;
  /** 该目标是否显式授予了 session.prompt（view 权不算）。 */
  commandGranted: boolean;
  /** 承载指令的通道是否已通过真机校验。 */
  remoteVerified: boolean;
}

/** 只读面板的拒绝原因（逐字取自 COMMAND_WORDING；全部满足时为空串）。 */
export function placeholderRefusalReason(input: PlaceholderRefusalInput): string {
  if (input.hasTarget !== true) {
    return COMMAND_WORDING.E_COMMAND_TARGET_MISSING;
  }
  if (input.commandGranted !== true) {
    return COMMAND_WORDING.E_COMMAND_NOT_GRANTED;
  }
  if (input.remoteVerified !== true) {
    return COMMAND_WORDING.E_COMMAND_REMOTE_UNVERIFIED;
  }
  return '';
}
