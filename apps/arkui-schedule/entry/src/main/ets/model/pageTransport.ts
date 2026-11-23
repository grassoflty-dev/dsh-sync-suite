/**
 * mod-remote-page-webview（App 远程页）：传输标签与页面决策表，唯一文案事实来源。
 *
 * 零 SDK import、零 UI import。组件里**不许**写任何决策文案，只渲染本表返回的 `label`。
 *
 * 禁用词（模型头声明 + 测试逐字 grep）：
 *   - 「防中间人」 —— 预检只证明这一张叶证书与 pin 一致，不能证明任何防御能力；
 *   - 「已验证身份」 —— 指纹一致 ≠ 身份真实，配对是谁做的我们没有证明；
 *   - 「校验证书链」 —— 只比了叶证书 DER 的 SHA-256，没有签名链 / 根信任校验；
 *   - 「安全连接已启用」 —— 尤其不能出现在 http/明文行；明文就是明文。
 *
 * Tailscale 行**不额外加任何词**：它走的 https 成功行与局域网 / IPv6 / 手动完全同一条文案，
 * 没有任何「安全 / 可信 / 加密更强」的形容词。
 *
 * 残留风险（TOCTOU）由页面的独立一行逐字渲染；文案也放在模型里，避免组件复制。
 */

/** 预检的三个 pin 状态 + 一个请求未完成的终局。 */
export type PinState = 'verified' | 'absent' | 'mismatch' | 'preflight-failed';

/** 页面决策：load 才允许挂载 WebView；refuse 必须显示 label 且不挂。 */
export interface PageDecision {
  action: 'load' | 'refuse';
  labelKey: string;
  label: string;
}

/** 冻结决策表（键 = scheme + pin 状态）。文案只在表里出现一次。 */
export const PAGE_TRANSPORT_TABLE: Readonly<Record<string, Readonly<PageDecision>>> = Object.freeze({
  'http': Object.freeze({
    action: 'load' as 'load',
    labelKey: 'PLAINTEXT_HTTP',
    label: '明文传输，令牌随地址明文发送，仅在你信任的网络内使用'
  }),
  'https:verified': Object.freeze({
    action: 'load' as 'load',
    labelKey: 'HTTPS_PIN_VERIFIED',
    label: '已比对叶证书指纹与配对记录一致'
  }),
  'https:absent': Object.freeze({
    action: 'refuse' as 'refuse',
    labelKey: 'HTTPS_NO_PIN',
    label: '未配对：没有证书指纹，无法校验证书，已拒绝加载'
  }),
  'https:mismatch': Object.freeze({
    action: 'refuse' as 'refuse',
    labelKey: 'HTTPS_PIN_MISMATCH',
    label: '证书指纹与配对记录不一致，已拒绝加载'
  }),
  'https:preflight-failed': Object.freeze({
    action: 'refuse' as 'refuse',
    labelKey: 'HTTPS_PREFLIGHT_FAILED',
    label: '证书预检请求未完成，已拒绝加载'
  })
});

/** 未知 scheme 的拒绝行（同样在表内，组件不需要备胎文案）。 */
const UNSUPPORTED: Readonly<PageDecision> = Object.freeze({
  action: 'refuse' as 'refuse',
  labelKey: 'UNSUPPORTED_SCHEME',
  label: '地址协议不支持，已拒绝加载'
});

/** 残留 TOCTOU 风险的逐字说明：预检与 WebView 握手是两条独立连接。 */
export const TOCTOU_SENTENCE: string =
  '预检校验的那张叶证书属于先前的连接，WebView 的握手是另一次独立连接；' +
  '若有人能在两次连接之间更换证书，这里不会发现。';

/** 决策纯函数：scheme + pin 状态 → 唯一一行决策。不接收 transport 参数，Tailscale 无特权。 */
export function pageDecision(input: { scheme: string; pinState: PinState }): PageDecision {
  const scheme: string = typeof input.scheme === 'string' ? input.scheme.trim().toLowerCase() : '';
  const state: PinState = input.pinState;
  if (scheme === 'http') {
    return { action: PAGE_TRANSPORT_TABLE['http'].action,
      labelKey: PAGE_TRANSPORT_TABLE['http'].labelKey,
      label: PAGE_TRANSPORT_TABLE['http'].label };
  }
  if (scheme !== 'https') {
    return { action: UNSUPPORTED.action, labelKey: UNSUPPORTED.labelKey, label: UNSUPPORTED.label };
  }
  const key: string = `https:${state}`;
  const row: Readonly<PageDecision> | undefined = PAGE_TRANSPORT_TABLE[key];
  if (row === undefined) {
    return { action: UNSUPPORTED.action, labelKey: UNSUPPORTED.labelKey, label: UNSUPPORTED.label };
  }
  return { action: row.action, labelKey: row.labelKey, label: row.label };
}
