/**
 * mod-pairing-badge-pin-guard（D3）：实例行的「配对徽章」唯一事实来源（零 SDK import，Node 可单测）。
 *
 * 规则只有一条：**徽章是实例自身状态的函数**，不是「这一行可达」的别名：
 * - 有 pin（指纹合法）且 `reachable:'ok'` ⇒ PAIRING_REACHABLE_WORDING（逐字节不变的旧文案）；
 * - 有 pin + `fail` / `unknown` ⇒ 已配对但连接失败 / 尚未探测；
 * - 无 pin（手动地址）⇒ 一律「未配对」口径，即使 TCP 可达也绝不声称配对/证书结论。
 *
 * 防御纵深：`http://` 行永远按未配对口径渲染，**即便误存了指纹**（`http` 没有 TLS，
 * "尚未校验证书" 这种话对它是假陈述）；`canShowFingerprint()` 与 `badgeOf()` 共用同一个判据，
 * 面板不会在徽章之外另写一套 scheme 判断。
 *
 * 这里不复制任何 pinned 文案：`PAIRING_REACHABLE_WORDING` 仍只活在 `model/pairingPayload.ts`。
 */

import { PAIRING_REACHABLE_WORDING } from './pairingPayload';
import { pinnedFingerprintPrefix } from './instances';
import type { DsInstance, Reachability } from './instances';

/** 有 pin 但地址不可连接。 */
export const PAIRED_UNREACHABLE_WORDING: string = '已配对（当前不可连接）';

/** 有 pin 但还没探测过地址。 */
export const PAIRED_UNPROBED_WORDING: string = '已配对（尚未探测地址可达性）';

/** 无 pin、TCP 探测通过。 */
export const UNPAIRED_REACHABLE_WORDING: string = '地址可达（未配对）';

/** 无 pin、TCP 探测失败。 */
export const UNPAIRED_UNREACHABLE_WORDING: string = '地址不可达（未配对）';

/** 无 pin、未探测。 */
export const UNPAIRED_UNPROBED_WORDING: string = '尚未探测地址可达性（未配对）';

/** 只有显式 http scheme 才算明文行（大小写 / 首尾空白容错；https 不算）。 */
function isHttpUrl(url: string): boolean {
  const text: string = typeof url === 'string' ? url.trim().toLowerCase() : '';
  return text.startsWith('http://');
}

/** 归一化三态：脏值只回落 unknown，绝不升成 ok。 */
function normalizeReachability(raw: Reachability): Reachability {
  if (raw === 'ok' || raw === 'fail') {
    return raw;
  }
  return 'unknown';
}

/**
 * 这一行是否有「可上屏的配对 pin」：指纹形状合法，且 URL 不是明文 http。
 * 渲染侧用它决定是否显示「指纹 … · 已固定指纹」那一行，避免与徽章判据漂移。
 */
export function canShowFingerprint(instance: DsInstance): boolean {
  if (isHttpUrl(instance.url)) {
    return false;
  }
  const raw: string = instance.tlsFingerprint === undefined ? '' : instance.tlsFingerprint;
  return pinnedFingerprintPrefix(raw).length > 0;
}

/**
 * 徽章文案：pin × reachable 的 3×3 表 + http 防御分支。
 * 纯函数、无 IO、无日志；同一个实例永远得到同一句。
 */
export function badgeOf(instance: DsInstance): string {
  const reachable: Reachability = normalizeReachability(instance.reachable);
  if (canShowFingerprint(instance)) {
    if (reachable === 'ok') {
      return PAIRING_REACHABLE_WORDING;
    }
    if (reachable === 'fail') {
      return PAIRED_UNREACHABLE_WORDING;
    }
    return PAIRED_UNPROBED_WORDING;
  }
  if (reachable === 'ok') {
    return UNPAIRED_REACHABLE_WORDING;
  }
  if (reachable === 'fail') {
    return UNPAIRED_UNREACHABLE_WORDING;
  }
  return UNPAIRED_UNPROBED_WORDING;
}
