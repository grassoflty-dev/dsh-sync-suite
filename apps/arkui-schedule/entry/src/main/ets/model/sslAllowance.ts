/**
 * mod-remote-page-webview（App 远程页）：WebView 一次性 SSL 放行凭据，纯状态机。
 *
 * 零 SDK import、零 UI import。模块级单例（一个页面进程只允许一个当前放行），纯函数语义：
 * 同一 (hostPort, nowMs) 输入序列给出同一结果，不读写文件 / 偏好 / 网络。
 *
 * 不变量：
 * - 单次使用：grant 后只有第一次 consume(hostPort) 返回 true，随后一律 false；
 * - 精确绑定 host:port（IPv6 键形如 `[fd7a:…]:44996`）：换端口 / 换主机一律不匹配；
 * - TTL 默认 10 s（SSL_ALLOWANCE_TTL_MS），`now >= grantedAt + TTL` 即过期；
 * - **无 pin 永不授权**：grant 需要显式 pinPresent=true，否则直接拒绝，请求也不会发生；
 * - 主机变更清空：给另一个 host 授权会先清掉旧 host 的全部条目；
 * - 不增长：条目上限 MAX_ALLOWANCES，任何访问都先 prune 过期项再按到期时间裁剪。
 *
 * 严格单次使用是否可行（诚实回答：**可行**）：
 * SDK `D:\A-DevEco\DevEco Studio\sdk\default\openharmony\ets\component\web.d.ts:6715`
 * 对 `onSslErrorEventReceive` 的原文是 "Called to notify users when an SSL error occurs with a
 * request for the main frame. To include errors with requests for subframes, use the OnSslErrorEvent
 * API."（`:6727` 为该方法声明；`OnSslErrorEventReceiveEvent` 定义于 `:4793`，只有 handler /
 * error / certChainData，没有 request 字段）。也就是说：**本页使用的回调按 SDK 契约只对主文档
 * 触发**，不需要按子资源逐次放行。因此这里采用严格单次使用（consume 后即失效），
 * 而不是「host + TTL 可重复消费」的退化实现。较新的 `onSslErrorEvent`（`:6739`）才有显式
 * `isMainFrame`（`:8295`），本页没有切换到它——切换会改变 certChainData 的可用 API level
 * （`:8303` since 20），不在这次构建范围内。真机回调次数仍属 `unverified`。
 */

/** 默认有效期（毫秒）：预检完成到 WebView 握手之间留 10 s，长时间不握手就失效。 */
export const SSL_ALLOWANCE_TTL_MS: number = 10_000;

/** 条目上限（防御性；一次页面尝试只会用一条）。 */
const MAX_ALLOWANCES: number = 32;

/** 放行理由固定文案（上屏用；不回显 host / pin / token）。 */
export const SSL_ALLOWANCE_REFUSAL_WORDING: string =
  '一次性放行凭据已过期或已使用，已取消本次握手（未放行）';

/** 单条记录：到期时刻 + 归属 host（用于主机变更清理）。 */
interface Allowance {
  expiresAt: number;
  host: string;
}

/** 模块级有界表。键 = hostPortKey(host, port) 的产物。 */
const allowances: Map<string, Allowance> = new Map<string, Allowance>();

/** 键形如 `[ipv6]:port` 时取 `[ipv6]`，否则取 `dns:port` 里的 dns。 */
function hostOfKey(hostPort: string): string {
  const text: string = typeof hostPort === 'string' ? hostPort.trim() : '';
  if (text.startsWith('[')) {
    const close: number = text.indexOf(']');
    return close >= 0 ? text.slice(0, close + 1) : text;
  }
  const colon: number = text.lastIndexOf(':');
  return colon > 0 ? text.slice(0, colon) : text;
}

/** 时间参数必须是有限非负数，否则一律按「不可判定 ⇒ 拒绝」。 */
function validNow(nowMs: number): boolean {
  return typeof nowMs === 'number' && Number.isFinite(nowMs) && nowMs >= 0;
}

/** 每次访问前 prune：删过期项；仍超限则按到期时间从早到晚删。 */
function prune(nowMs: number): void {
  for (const entry of allowances.entries()) {
    if (entry[1].expiresAt <= nowMs) {
      allowances.delete(entry[0]);
    }
  }
  while (allowances.size > MAX_ALLOWANCES) {
    let oldestKey: string = '';
    let oldestAt: number = Number.POSITIVE_INFINITY;
    for (const entry of allowances.entries()) {
      if (entry[1].expiresAt < oldestAt) {
        oldestAt = entry[1].expiresAt;
        oldestKey = entry[0];
      }
    }
    if (oldestKey.length === 0) {
      break;
    }
    allowances.delete(oldestKey);
  }
}

/**
 * 授权一个 host:port；`pinPresent` 必须为 true（没有 pin 从不授权）。
 * 成功返回 true，任何非法输入 / 主机变更清理完成仍授权当前键。
 */
export function grant(hostPort: string, pinPresent: boolean, nowMs: number): boolean {
  const key: string = typeof hostPort === 'string' ? hostPort.trim() : '';
  if (key.length === 0 || pinPresent !== true || !validNow(nowMs)) {
    return false;
  }
  prune(nowMs);
  const host: string = hostOfKey(key);
  for (const entry of allowances.entries()) {
    if (entry[1].host !== host) {
      allowances.delete(entry[0]);
    }
  }
  allowances.set(key, { expiresAt: nowMs + SSL_ALLOWANCE_TTL_MS, host: host });
  prune(nowMs); // set 之后再裁剪一次：即使并发 grant，条目数也恒 ≤ MAX_ALLOWANCES
  return true;
}

/** 是否仍有效（只读，不消费）。过期 / 换键一律 false。 */
export function isAllowed(hostPort: string, nowMs: number): boolean {
  if (!validNow(nowMs)) {
    return false;
  }
  prune(nowMs);
  const key: string = typeof hostPort === 'string' ? hostPort.trim() : '';
  const entry: Allowance | undefined = allowances.get(key);
  return entry !== undefined && entry.expiresAt > nowMs;
}

/** 单次消费：有效则删条目并返回 true；随后（含 TTL 内）一律 false。 */
export function consume(hostPort: string, nowMs: number): boolean {
  if (!isAllowed(hostPort, nowMs)) {
    return false;
  }
  const key: string = hostPort.trim();
  allowances.delete(key);
  return true;
}

/** 清空所有授权（新的一次打开尝试 / 页面销毁时调用）。 */
export function clear(): void {
  allowances.clear();
}

/** 当前条目数（测试用：证明有界、无增长）。 */
export function size(): number {
  return allowances.size;
}
