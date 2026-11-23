/**
 * 扫码配对归一化（mod-app-pairing-qr-scan）—— 纯逻辑，零 SDK import，Node 可直接单测。
 *
 * 系统扫码 UI 回传的 `originalValue` 可能带 BOM / 零宽字符 / 换行 / URL 包装，
 * 本文件只做「把扫码文本变成粘贴框可解析的规范串」这一件事，然后**委托**
 * `parsePairingPayload()` 做唯一的 schema 校验，并把它的 code / reason 逐字透传。
 * 绝不在这里复制任何字段级校验或中文拒绝句：非配对载荷一律由那一个解析器说话。
 *
 * 唯一新增文案是扫码 API 自身失败（非用户取消）的 E_PAIRING_SCAN_UNAVAILABLE，
 * 与载荷解析无关，见 PAIRING_SCAN_WORDING。
 */

import { parsePairingPayload } from './pairingPayload';
import type { PairingParseResult } from './pairingPayload';

/**
 * 扫码归一结果：`text` 是粘贴框将再次解析的规范串（不重排、不重新序列化）；
 * 失败时 `code` / `reason` 来自唯一解析器，`text` 仍是规范串而非原始扫描文本。
 */
export interface PairingScanResult {
  ok: boolean;
  text: string;
  code: string;
  reason: string;
}

/**
 * 全模块唯一新增文案表：只有扫码 API 自身失败（非用户取消）才使用，
 * typed 码与固定中文原因各一条；这里没有任何解析器拒绝句的副本。
 */
export const PAIRING_SCAN_WORDING: Record<string, string> = {
  E_PAIRING_SCAN_UNAVAILABLE: '无法启动扫码，请改用手动粘贴配对串'
};

/** 直接取固定原因，避免调用方对具名表做下标运算。 */
export const PAIRING_SCAN_UNAVAILABLE_REASON: string =
  PAIRING_SCAN_WORDING['E_PAIRING_SCAN_UNAVAILABLE'];

/** 构造扫码 API 失败结果：`text` 恒空、ok 恒 false，绝不回显扫描原文 / URL。 */
export function scanUnavailableResult(): PairingScanResult {
  return {
    ok: false,
    text: '',
    code: 'E_PAIRING_SCAN_UNAVAILABLE',
    reason: PAIRING_SCAN_UNAVAILABLE_REASON
  };
}

/** 需要剥掉的不可见字符与排版空白：BOM、零宽字符、CR / LF / TAB。 */
const INVISIBLE_RE: RegExp = /[\uFEFF\u200B-\u200D\r\n\t]/g;
/** 只有出现合法 %XX 才尝试解码，避免无谓异常。 */
const PERCENT_ESCAPE_RE: RegExp = /%[0-9A-Fa-f]{2}/;
/** 只有 scheme:// 形态才尝试从 query / fragment 抽载荷；紧凑串 / JSON 原样透传。 */
const URL_SCHEME_RE: RegExp = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** 承载配对串的 query 键名（小写比较）。 */
const PAYLOAD_KEYS: readonly string[] = ['p', 'payload', 'text'];

/** 字符清洗：只去不可见字符 / 排版空白，不做任何字段级判断。 */
function clean(text: string): string {
  return text.replace(INVISIBLE_RE, '');
}

/** 含 %XX 时解码一次；坏转义抛错则原样保留，绝不把异常抛给调用方。 */
function tryDecode(text: string): string {
  if (!PERCENT_ESCAPE_RE.test(text)) {
    return text;
  }
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** 从扫码 URL 的 query / fragment 取载荷；非 URL 或无已知键返回 null（原样交给解析器）。 */
function extractUrlPayload(text: string): string | null {
  if (!URL_SCHEME_RE.test(text)) {
    return null;
  }
  const hashAt: number = text.indexOf('#');
  const queryAt: number = text.indexOf('?');
  if (queryAt >= 0) {
    const end: number = hashAt >= 0 ? hashAt : text.length;
    const query: string = text.slice(queryAt + 1, end);
    const pairs: string[] = query.split('&');
    for (const pair of pairs) {
      const eqAt: number = pair.indexOf('=');
      if (eqAt < 0) {
        continue;
      }
      const key: string = tryDecode(pair.slice(0, eqAt)).trim().toLowerCase();
      if (PAYLOAD_KEYS.indexOf(key) >= 0) {
        return tryDecode(pair.slice(eqAt + 1));
      }
    }
  }
  if (hashAt >= 0) {
    const fragment: string = text.slice(hashAt + 1);
    if (fragment.length > 0) {
      return tryDecode(fragment);
    }
  }
  return null;
}

/** 扫码原文 → 规范串：清洗 → 解码一次 → 抽 URL 载荷 → 再清洗 → trim。 */
function canonicalText(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  let text: string = clean(raw);
  text = tryDecode(text);
  const payload: string | null = extractUrlPayload(text);
  if (payload !== null) {
    text = clean(tryDecode(payload));
  }
  return text.trim();
}

/**
 * 扫码文本归一 + 校验：返回规范串与**唯一解析器**的 code / reason 逐字结果。
 * 成功时调用方把 text 放进粘贴框并复用 addByPairing()；失败时只显示 reason，不保留原文。
 */
export function normaliseScannedPairing(raw: unknown): PairingScanResult {
  const text: string = canonicalText(raw);
  const parsed: PairingParseResult = parsePairingPayload(text);
  return {
    ok: parsed.ok,
    text: text,
    code: parsed.code,
    reason: parsed.reason
  };
}
