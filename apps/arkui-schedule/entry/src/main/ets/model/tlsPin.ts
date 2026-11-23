/**
 * mod-remote-tls-termination：平板侧「证书指纹 pin 校验」纯逻辑（零 SDK import，Node 可直接单测）。
 *
 * 为什么单独一层：Web 页里不能塞判定分支（ArkTS 编译与单测都覆盖不到），把三种拒绝结果
 * 收成一张纯函数表，Web 组件只负责把平台给的 DER 链和已保存的 pin 喂进来并执行 handler。
 *
 * 三条硬纪律：
 * 1. **pin 只来自配对**（实例信封的 `tlsFingerprint`，由 `addPairedInstance` 写入）。
 *    本文件只读 pin，**从不写 pin**；连接成功/失败都不产生任何持久化副作用。
 *    老实例（配对功能之前创建的、没有 `tlsFingerprint`）一律按「无 pin」拒绝，必须重新扫码配对。
 * 2. **三种结果必须分开**：指纹不匹配 (a) / 从未配对无 pin (b) / 证书链无法获取或无法校验 (c)。
 *    (c) 绝不能被当成 (a)，更不能被当成成功；平台给不出可 hash 的 leaf 时一律 (c) fail-closed。
 * 3. 文案固定，任何分支都**不回显**指纹值、证书内容、URL 或 token。
 *
 * 指纹算法与电脑插件 `pairingTls.ts` / `pairingPayload.ts` 一致：SHA-256(证书 DER) → 冒号分隔大写。
 */

import { sha256Hex } from './sha256';

/** 三种可区分结果 + 成功。 */
export type TlsPinOutcome = 'match' | 'mismatch' | 'no-pin' | 'unverifiable';

/** 唯一结果对象：`outcome` 供逻辑判断，`wording` 是可以直接上屏的固定中文。 */
export interface TlsPinResult {
  outcome: TlsPinOutcome;
  wording: string;
}

/**
 * (a) 有 pin 且 leaf 指纹不一致：可能是换了机器、换了证书或中间人。
 */
export const TLS_PIN_MISMATCH_WORDING: string =
  '证书指纹与配对时固定的一致才能连接：当前证书指纹不匹配，已拒绝连接（可能是换了机器、换了证书或中间人）';

/**
 * (b) 没有 pin：该实例从未配对过 / 老实例没有指纹字段 / 指纹字段损坏。
 * 绝不在连接时 TOFU 补 pin；用户必须回设置页重新扫码配对。
 */
export const TLS_NO_PIN_WORDING: string =
  '该实例从未配对过（无 pin），没有固定的证书指纹，已拒绝连接；请先回设置页用二维码配对，连接本身不会自动信任证书';

/**
 * (c) 平台没给出可 pin 的证书链，或链里没有可 hash 的 leaf。
 * 含糊情况一律 (c)：宁可拒绝，也不假装成指纹不匹配或放行。
 */
export const TLS_CHAIN_UNVERIFIABLE_WORDING: string = '无法校验证书链，已拒绝连接';

/** 成功文案仅用于状态清理的对照，不上屏（成功时页面正常加载）。 */
export const TLS_PIN_MATCH_WORDING: string = '';

const HEX64_RE: RegExp = /^[0-9a-fA-F]{64}$/;

function result(outcome: TlsPinOutcome): TlsPinResult {
  let wording: string = '';
  if (outcome === 'mismatch') {
    wording = TLS_PIN_MISMATCH_WORDING;
  } else if (outcome === 'no-pin') {
    wording = TLS_NO_PIN_WORDING;
  } else if (outcome === 'unverifiable') {
    wording = TLS_CHAIN_UNVERIFIABLE_WORDING;
  }
  return { outcome: outcome, wording: wording };
}

/**
 * 从 64 位十六进制（可带冒号）得到纯大写比较键；坏值返回空串。
 * 空串 = 没有可用的 pin，绝不等于"任意证书都匹配"。
 */
export function pinKey(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const text: string = value.trim().replace(/:/g, '').toUpperCase();
  return HEX64_RE.test(text) ? text : '';
}

/** SHA-256(DER) → 32 段大写冒号分隔；与插件侧 `pairingFingerprintOf` 同一算法。 */
export function fingerprintFromDer(der: Uint8Array): string {
  const hex: string = sha256Hex(der).toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    groups.push(hex.slice(i, i + 2));
  }
  return groups.join(':');
}

/**
 * 校验 presented leaf against 已保存的 pin。
 *
 * 判定顺序（故意固定，避免含糊时被当成成功）：
 *   1. pin 为空/格式非法 ⇒ no-pin (b) —— 与配对更新分支「空指纹不能算匹配」对齐；
 *   2. 证书链缺失/空/leaf 不可 hash ⇒ unverifiable (c) —— 含糊一律 fail-closed；
 *   3. 否则取 `chain[0]`（leaf）算 SHA-256：相等 ⇒ match，否则 ⇒ mismatch (a)。
 *
 * @param chain 平台回调给出的 DER 证书链；leaf 必须是第一项。`undefined` = 平台拿不到链。
 * @param pin   实例里由配对写入的 `tlsFingerprint`；`undefined`/空串 = 从未配对。
 */
export function verifyPinnedCertificate(
  chain: Uint8Array[] | undefined,
  pin: string | undefined | null
): TlsPinResult {
  const expected: string = pinKey(pin);
  if (expected.length === 0) {
    return result('no-pin');
  }
  if (!Array.isArray(chain) || chain.length === 0) {
    return result('unverifiable');
  }
  const leaf: Uint8Array | undefined = chain[0];
  if (leaf === undefined || !(leaf instanceof Uint8Array) || leaf.length === 0) {
    return result('unverifiable');
  }
  const actual: string = pinKey(fingerprintFromDer(leaf));
  if (actual.length === 0) {
    return result('unverifiable');
  }
  return result(actual === expected ? 'match' : 'mismatch');
}
