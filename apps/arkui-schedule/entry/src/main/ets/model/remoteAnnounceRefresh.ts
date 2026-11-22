/**
 * 公告地址刷新的纯决策层（mod-remote-announce-wiring）—— 零 SDK import / 零 IO / 零日志 / 零仓库写。
 *
 * 调用链：`pages/panes/InstancesPane.ets` → `services/remoteAnnounceRefresh.ets` → 本文件
 *        → `model/remoteAnnounce.ts`（签名 → 指纹 → 时间 → 同 id 拒并，顺序固定）。
 * 把决策放在 Node 可直接单测的 .ts 里，是为了让「地址是否该被公告改写」这件事可验证；
 * 平台 IO（只读 fileIo / PersistentStorage / cryptoFramework）全部留在 service 层。
 *
 * 安全口径：
 * - 已有 pin 时，四步全过且 `updatedAt` 严格更新 ⇒ `state='refreshed'`，直接改地址（TOFU 的价值）；
 * - 还没有 pin 时，四步全过也只返回 `state='first-pairing-pending'`（提案），**零写入**；
 *   只有用户显式确认后 `completeRefresh()` 才经注入端口写 pin + 地址，成功态才是 `refreshed`；
 * - 取消确认 / 已有 pin 且不同钥匙 ⇒ 端口一次都不调用，持久化字节逐字不变；
 * - 其余任何分支 `newUrl` 恒为空串 —— 调用方据此**保旧地址**，绝不静默切换；
 * - 所有「不可信」分支的上屏文案逐字 = `KEEP_WORDING`（`公告不可信，请手动确认`）。
 *
 * 本文件不碰原有纯模型 `remoteAnnounce.ts` 的任何契约，只新增薄薄一层决策封装。
 */

import type {
  AnnounceCaller,
  AnnounceProblem,
  Announcement,
  AnnounceVerifyOptions
} from './remoteAnnounce';
import { KEEP_WORDING, decideAutoRefresh, parseAnnouncement } from './remoteAnnounce';

/** 刷新结果状态：只有 refreshed 允许改地址；其余状态都保旧地址。 */
export type AnnounceRefreshState = 'refreshed' | 'untrusted' | 'no-announcement' |
  'not-newer' | 'first-pairing-pending' | 'awaiting-consent';

/** 成功文案（不含地址：地址是 capability，不回显到 UI 状态 / 日志）。 */
export const REFRESHED_WORDING: string = '地址已按公告更新';
/** 公告文件不存在 / 空文件：typed「无公告」态，与「不可信」区分。 */
export const NO_ANNOUNCEMENT_WORDING: string = '没有找到该实例的公告，已保留原地址';
/** 公告可信但不比已应用时间更新：保旧地址，不报「不可信」。 */
export const NOT_NEWER_WORDING: string = '公告不比当前地址更新，已保留原地址';
/** 所有不可信分支的唯一上屏文案（逐字复用模型的 KEEP_WORDING）。 */
export const REFUSAL_WORDING: string = KEEP_WORDING;
/** 首配提案 / 等待确认的动作文案（用户可见，逐字断言）。 */
export const FIRST_PAIRING_WORDING: string = '首次配对：确认信任该公告';
/** 首配动作旁的一行后果说明（用户可见，逐字断言）。 */
export const FIRST_PAIRING_DETAIL: string = '信任后该实例的地址变更才会自动生效';
/** 取消确认后的状态文案：回到首配动作，但不写任何字节。 */
export const AWAITING_CONSENT_WORDING: string = FIRST_PAIRING_WORDING;

/**
 * 显式确认时才注入的写入端口：纯模型只决定「要不要写」，真实 IO 全在 service 层。
 * 取消 / 冲突路径一次都不调用它，因此 pins 表与实例表的字节都不变。
 */
export interface AnnounceApplyPort {
  /** 落 TOFU 锚点（只在当前没有 pin 时调用）。 */
  storePin(pin: string): void;
  /** 落地址 + 已应用时间（只在显式确认或已有 pin 的自动刷新中调用）。 */
  storeAddress(newUrl: string, updatedAt: number): void;
}

/** 决策输出：`newUrl` 只在 refreshed / first-pairing-pending 时非空，调用方不得把它写进日志。 */
export interface AnnounceRefreshOutcome {
  state: AnnounceRefreshState;
  problem: AnnounceProblem;
  wording: string;
  newUrl: string;
  updatedAt: number;
  pin: string;
}

/** 刷新前的本机状态：实例 id + 上一次已应用公告时间（0 = 从未应用）。 */
export interface AnnounceRefreshCurrent {
  id: string;
  updatedAt: number;
}

/** 构造「保旧地址」结果：newUrl 恒空，绝不带出任何地址 / 指纹 / 令牌。 */
function held(
  state: AnnounceRefreshState,
  problem: AnnounceProblem,
  wording: string
): AnnounceRefreshOutcome {
  return { state: state, problem: problem, wording: wording, newUrl: '', updatedAt: 0, pin: '' };
}

/**
 * 公告里的 scheme/host/port → 实例 base URL。
 * IPv6 字面量必须加方括号，才能被 `normalizeRemoteUrl` 当作合法 authority。
 * 公告字段已被 `normalizeAnnouncement` 校验（scheme ∈ http/https、host 无 /?@# 空白、端口合法），
 * 因此这里只做方括号包裹，不重新解析，避免二次归一改变字节。
 */
export function announcementBaseUrl(ann: Announcement): string {
  const host: string = ann.host.indexOf(':') >= 0 ? `[${ann.host}]` : ann.host;
  return `${ann.scheme}://${host}:${ann.port}`;
}

/**
 * 地址刷新决策（纯函数，零 IO）。
 *
 * 步骤：① 无公告 → typed no-announcement；② 解析 / 形状失败 → untrusted；
 * ③ 公告 instanceId 必须等于本机 id（跨 id 永不合并）；④ 交给模型的固定四步流水线；
 * ⑤ 只有 `decideAutoRefresh` 返回 refresh 才产出新地址。
 *
 * 时钟 / 验签器 / 钉住表全部由 `opts` 注入；验签器抛错时模型吞成 false，这里也不会抛。
 */
export function decideAnnounceRefresh(
  current: AnnounceRefreshCurrent,
  text: string | null | undefined,
  caller: AnnounceCaller,
  opts: AnnounceVerifyOptions
): AnnounceRefreshOutcome {
  const raw: string = typeof text === 'string' ? text.trim() : '';
  if (raw.length === 0) {
    return held('no-announcement', 'E_ANNOUNCE_MISSING', NO_ANNOUNCEMENT_WORDING);
  }

  const parsed = parseAnnouncement(raw, caller);
  if (!parsed.ok || parsed.announcement === null) {
    return held('untrusted', parsed.problem, REFUSAL_WORDING);
  }
  const ann: Announcement = parsed.announcement;

  // 跨 id 公告永不合并：即便签名有效，也不能把别的实例地址写到这一行
  if (ann.instanceId !== current.id) {
    return held('untrusted', 'E_ANNOUNCE_ID_CONFLICT', REFUSAL_WORDING);
  }

  const decision = decideAutoRefresh(ann, current.updatedAt, opts);
  if (decision.action !== 'refresh') {
    if (decision.problem === 'E_ANNOUNCE_NOT_NEWER') {
      return held('not-newer', decision.problem, NOT_NEWER_WORDING);
    }
    return held('untrusted', decision.problem, REFUSAL_WORDING);
  }

  const newUrl: string = announcementBaseUrl(ann);

  // 还没有 pin：即便四步全过也只产出「首配提案」，绝不在这里落任何字节。
  // 用户显式确认后由 completeRefresh() 写 pin + 地址；没有确认就一直是提案态。
  const hadPin: boolean = typeof opts.pinnedKey === 'string' && opts.pinnedKey.trim().length > 0;
  if (!hadPin) {
    return {
      state: 'first-pairing-pending',
      problem: 'ok',
      wording: FIRST_PAIRING_WORDING,
      newUrl: newUrl,
      updatedAt: ann.updatedAt,
      pin: decision.pin
    };
  }

  // 已有 pin：签名 + 指纹 + 时间 + 同 id 全过 ⇒ 直接刷新，不再打扰用户（TOFU 的意义）。
  return {
    state: 'refreshed',
    problem: 'ok',
    wording: REFRESHED_WORDING,
    newUrl: newUrl,
    updatedAt: ann.updatedAt,
    pin: decision.pin
  };
}

/**
 * 首配确认（唯一的信任锚点写入口，纯函数）。
 *
 * - `consent === false`：零端口调用，pins / 实例表字节逐字不变，返回 typed `awaiting-consent`；
 * - 提案状态不符 / 候选 pin 或地址为空：同样零写入 + typed 拒绝；
 * - 已有 pin 且与候选不同：**typed 拒绝、不重绑**（首配按钮永不复用成换钥按钮）；
 * - 确认通过：先 storePin（TOFU 锚点）再 storeAddress，一步提交地址与 updatedAt。
 */
export function completeRefresh(
  pending: AnnounceRefreshOutcome,
  consent: boolean,
  currentPin: string,
  port: AnnounceApplyPort
): AnnounceRefreshOutcome {
  if (!consent || pending.state !== 'first-pairing-pending' ||
      pending.pin.length === 0 || pending.newUrl.length === 0) {
    return held('awaiting-consent', 'E_ANNOUNCE_PIN_REQUIRED', AWAITING_CONSENT_WORDING);
  }
  const existing: string = typeof currentPin === 'string' ? currentPin.trim().toLowerCase() : '';
  if (existing.length > 0 && existing !== pending.pin.trim().toLowerCase()) {
    return held('untrusted', 'E_ANNOUNCE_PIN_MISMATCH', REFUSAL_WORDING);
  }
  if (existing.length === 0) {
    port.storePin(pending.pin);
  }
  port.storeAddress(pending.newUrl, pending.updatedAt);
  return {
    state: 'refreshed',
    problem: 'ok',
    wording: REFRESHED_WORDING,
    newUrl: pending.newUrl,
    updatedAt: pending.updatedAt,
    pin: pending.pin
  };
}
