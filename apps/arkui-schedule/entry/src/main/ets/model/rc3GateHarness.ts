/**
 * mod-remote-pinned-client：RC-3 真机门禁 harness 的**纯判定层**（零 SDK import，Node 可单测）。
 *
 * 这份逻辑只服务四个受控门禁（PIN-ATTACK-01 / PIN-ROTATE-01 / PIN-REUSE-01 / PIN-HEADER-01），
 * 不是产品功能；唯一调用方是 debug-only 的 services/rc3GateHarness.ets。
 *
 * 三条硬纪律：
 * 1. 端点白名单显式且精确（host:port），不在表内一律 typed 拒绝；
 * 2. 只接受本地生成的合成凭证，绝不使用用户的真实 token（本文件不读任何设置/文件）；
 * 3. 观察阶段不得携带凭证；leaf 顺序未由观察证据证实时不得进入带凭证阶段。
 *
 * 注意：本文件不含 harness 唯一 sentinel（sentinel 只在 debug harness 服务里），
 * 以免 release 产物意外带上它，破坏 release-exclusion 断言。
 */

import { sha256Hex } from './sha256';

/** router 参数名：只有 debug 构建且参数值为 '1' 才激活（参数本身不是访问边界）。 */
export const GATE_ROUTE_PARAM: string = 'rc3Gate';
export const GATE_ROUTE_VALUE: string = '1';

/**
 * 受控端点白名单（精确 host:port）。第二项是给 Lead 的测试机占位，使用前必须改成
 * 自己控制的 HTTPS 端点；表外地址一律拒绝，绝不做「同网段就放行」。
 */
export const GATE_ALLOWLIST: ReadonlyArray<string> = ['127.0.0.1:9443', '10.0.0.7:9443'];

/** 合成凭证前缀：一看就知道是测试值，绝不可能是用户的真实 token。 */
export const SYNTHETIC_PREFIX: string = 'Bearer SYNTHETIC-RC3-';

export type GateRefusalCode = 'E_GATE_ENDPOINT_NOT_ALLOWED' | 'E_GATE_CREDENTIAL' | 'E_LEAF_ORDER_UNPROVEN';

/** 端点判定：只接受 https + 表内精确 host:port；URL 里不得有查询串/用户密码。 */
export function isAllowedGateEndpoint(url: string): boolean {
  if (typeof url !== 'string' || !url.toLowerCase().startsWith('https://')) {
    return false;
  }
  if (url.indexOf('?') >= 0 || url.indexOf('#') >= 0) {
    return false;
  }
  const rest: string = url.slice('https://'.length);
  const slash: number = rest.indexOf('/');
  const authority: string = slash < 0 ? rest : rest.slice(0, slash);
  if (authority.length === 0 || authority.indexOf('@') >= 0 || authority.indexOf('?') >= 0) {
    return false;
  }
  return GATE_ALLOWLIST.indexOf(authority) >= 0;
}

/** 本地生成合成凭证：nonce + SHA-256 截断，固定形状，便于严格识别。 */
export function makeSyntheticCredential(nonce: string): string {
  return SYNTHETIC_PREFIX + sha256Hex(nonce).slice(0, 16);
}

export type GateCredentialClass = 'synthetic' | 'missing' | 'foreign';

/** 只接受本 harness 生成的形状；真实 token / JWT / 空值一律 foreign/missing。 */
export function classifyGateCredential(value: unknown): GateCredentialClass {
  if (typeof value !== 'string' || value.length === 0) {
    return 'missing';
  }
  if (!value.startsWith(SYNTHETIC_PREFIX)) {
    return 'foreign';
  }
  const tail: string = value.slice(SYNTHETIC_PREFIX.length);
  return /^[0-9a-f]{16}$/.test(tail) ? 'synthetic' : 'foreign';
}

/** 观察阶段证据（只存计数与摘要，绝不存 PEM / 证书原文 / 凭证）。 */
export interface GateObservation {
  callbackFired: boolean;
  host: string;
  ip: string;
  x509Count: number;
  pemCount: number;
  leafDigests: string[];
}

export function emptyObservation(): GateObservation {
  return { callbackFired: false, host: '', ip: '', x509Count: 0, pemCount: 0, leafDigests: [] };
}

/**
 * leaf 身份证据（PEM-only）：x509Certs 没有同步 DER 可读，只能作形状信号。
 * 只有「恰好一份 PEM + x509 不超过一份 + 恰好一个 64 位摘要」才算字节来源唯一；
 * 多证书（任一表示 >1）依然 E_LEAF_ORDER_UNPROVEN——这正是「不从多个候选里猜第 0 项」。
 * 即便形状唯一，带凭证阶段仍须 debug harness 的显式确认（canRunCredentialPhase）。
 */
export function leafOrderEvidence(obs: GateObservation): 'proven' | 'E_LEAF_ORDER_UNPROVEN' {
  if (!obs.callbackFired || obs.x509Count > 1 || obs.pemCount !== 1 || obs.leafDigests.length !== 1) {
    return 'E_LEAF_ORDER_UNPROVEN';
  }
  return /^[0-9a-f]{64}$/.test(obs.leafDigests[0]) ? 'proven' : 'E_LEAF_ORDER_UNPROVEN';
}

/** 带凭证阶段的前置：观察已证明 leaf 身份，且 harness 内的显式确认已给出。 */
export function canRunCredentialPhase(
  phase: 'observe' | 'credentials',
  obs: GateObservation,
  confirmedInDebugHarness: boolean
): boolean {
  return phase === 'credentials' && confirmedInDebugHarness && leafOrderEvidence(obs) === 'proven';
}

/** 仅接受从受控夹具带外取得的 SHA-256；绝不从刚看到的证书自动建立信任。 */
export function normalizeGateExpectedPin(value: string): string {
  const pin: string = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(pin) ? pin : '';
}

/** 服务端只回报计数，不回报 token 值。 */
export interface GateCounts {
  authCount: number;
  destinationRequestCount: number;
}

export function formatGateCounts(counts: GateCounts): string {
  return `服务端 Authorization 次数：${counts.authCount}；目标端请求次数：${counts.destinationRequestCount}`;
}
