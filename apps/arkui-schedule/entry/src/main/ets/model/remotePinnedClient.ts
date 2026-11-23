/**
 * mod-remote-pinned-client（RC-3 核心）：带凭证请求的「pinned client」纯判定逻辑。
 *
 * 零 SDK import、零 UI import，Node 可直接单测（与 tlsPin.ts 同一约定）。
 * 平台侧只有 services/remotePinnedClient.ets 把 http.createHttp().request() 接到这里；
 * 本文件不持有任何 token / PEM / 证书原文，只接收已摘出的 leaf DER 与 pin 摘要。
 *
 * 不重定向决策（对应 Lead 2026-11-22 纠正）：
 * SDK `ets/api/@ohos.net.http.d.ts:400` 定义了 `maxRedirects`，`:390-395` 明写
 * 「value 0 = redirection disabled」。所以 http API **有** SDK 级 no-follow 机制，
 * 采用「http + remoteValidation + maxRedirects:0」分支，而不是事后看 3xx 才拒绝。
 * 事后 3xx 判定仍保留，但只是第二道闸；真正的 no-follow 由 maxRedirects:0 保证。
 *
 * leaf 顺序决策：SDK 的 ValidationContext（`:561-594`）只给出 pemCerts[] / x509Certs[]，
 * 未定义第 0 项一定是 leaf（见 SPIKE-ARKWEB-PINNING.md:28,77）。因此本模块把
 * 「链首即 leaf」当作**需要带外证明**的前提（leafOrderProven），未证明时一律
 * E_LEAF_ORDER_UNPROVEN fail-closed，绝不因为「通常第一个是 leaf」就放行。
 */

import { sha256Hex } from './sha256';

/** 全部带类型拒绝码；文案固定、不含任何凭证/证书/URL 值。 */
export type PinnedRefusalCode =
  | 'E_NO_PIN'
  | 'E_HOST_MISMATCH'
  | 'E_IP_MISMATCH'
  | 'E_LEAF_ORDER_UNPROVEN'
  | 'E_CHAIN_MISSING'
  | 'E_CHAIN_AMBIGUOUS'
  | 'E_LEAF_UNREADABLE'
  | 'E_VERIFY_EXCEPTION'
  | 'E_PIN_MISMATCH'
  | 'E_REDIRECT_REFUSED'
  | 'E_REDIRECT_LIMIT'
  | 'E_PIN_REJECTED'
  | 'E_HTTP_FAILURE'
  | 'E_TRANSPORT_FAILURE'
  | 'E_API_UNSUPPORTED';

/** 拒绝结果：code 给逻辑，message 是固定中文文案（可直接上屏、可进日志）。 */
export interface PinnedRefusal {
  code: PinnedRefusalCode;
  message: string;
}

/** 判定成功：不携带任何值，避免把响应/证书带进日志。 */
export interface VerifyOk {
  ok: true;
}

/** 判定失败：带 typed 拒绝。 */
export interface VerifyFail {
  ok: false;
  refusal: PinnedRefusal;
}

export type VerifyOutcome = VerifyOk | VerifyFail;

/** 固定拒绝文案（集中定义，便于逐字 pin 住测试）。 */
export const PIN_REFUSAL_WORDING: Record<PinnedRefusalCode, string> = {
  'E_NO_PIN': '没有可用的证书 pin，已拒绝请求（未发送任何凭证）',
  'E_HOST_MISMATCH': '连接的主机与预置白名单不一致，已拒绝请求（未发送任何凭证）',
  'E_IP_MISMATCH': '连接的地址与预置白名单不一致，已拒绝请求（未发送任何凭证）',
  'E_LEAF_ORDER_UNPROVEN': '证书链的 leaf 顺序尚未真机证实，已拒绝请求（未发送任何凭证）',
  'E_CHAIN_MISSING': '没有拿到证书链，已拒绝请求（未发送任何凭证）',
  'E_CHAIN_AMBIGUOUS': '证书链的两种表示互相矛盾，无法唯一确定 leaf，已拒绝请求（未发送任何凭证）',
  'E_LEAF_UNREADABLE': '无法读取 leaf 证书 DER，已拒绝请求（未发送任何凭证）',
  'E_VERIFY_EXCEPTION': '证书校验过程异常，已拒绝请求（未发送任何凭证）',
  'E_PIN_MISMATCH': '证书 pin 不匹配，已拒绝请求（未发送任何凭证）',
  'E_REDIRECT_REFUSED': '服务器要求跳转，已拒绝（未跟随跳转、未发送任何凭证）',
  'E_REDIRECT_LIMIT': '服务器跳转次数超过上限，已拒绝（未跟随跳转、未发送任何凭证）',
  'E_PIN_REJECTED': '证书校验失败，请求已被平台拒绝（未发送任何凭证，错误码 2300060）',
  'E_HTTP_FAILURE': '电脑返回了非成功状态，已停止本次请求（未继续发送凭证）',
  'E_TRANSPORT_FAILURE': '请求发送失败，已停止（未继续发送凭证）',
  'E_API_UNSUPPORTED': '设备不支持所需的证书校验接口，已拒绝请求（未发送任何凭证）'
};

function makeRefusal(code: PinnedRefusalCode): PinnedRefusal {
  return { code: code, message: PIN_REFUSAL_WORDING[code] };
}

function refusal(code: PinnedRefusalCode): VerifyFail {
  return { ok: false, refusal: makeRefusal(code) };
}

/**
 * 把 pin 归一成 64 位小写十六进制；可带冒号，坏值返回空串。
 * 空串绝不等于「任意证书匹配」——直接 E_NO_PIN。
 */
export function normalizePin(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const text: string = value.trim().replace(/:/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : '';
}

const BASE64_ALPHABET: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * PEM → DER（纯 TS，无宿主 atob/Buffer）。
 * 只用于平台上同时给出 pemCerts[0] 与 x509Certs[0] 时做交叉核对；
 * 坏输入返回 null，由调用方走 E_CHAIN_AMBIGUOUS / E_CHAIN_MISSING，绝不 guessed 放行。
 */
export function pemToDer(pem: string): Uint8Array | null {
  if (typeof pem !== 'string') {
    return null;
  }
  const text: string = pem
    .replace(/-----BEGIN[^-]*-----/g, '')
    .replace(/-----END[^-]*-----/g, '')
    .replace(/\s+/g, '');
  if (text.length === 0 || text.length % 4 !== 0) {
    return null;
  }
  if (/=/.test(text) && !/={0,2}$/.test(text)) {
    return null;
  }
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    let word: number = 0;
    for (let j = 0; j < 4; j++) {
      const ch: string = text.charAt(i + j) === '=' ? 'A' : text.charAt(i + j);
      const idx: number = BASE64_ALPHABET.indexOf(ch);
      if (idx < 0) {
        return null;
      }
      word = (word << 6) | idx;
    }
    out.push((word >>> 16) & 0xff);
    if (text.charAt(i + 2) !== '=') {
      out.push((word >>> 8) & 0xff);
    }
    if (text.charAt(i + 3) !== '=') {
      out.push(word & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** 定长十六进制恒定时间比较：全程遍历，绝不遇到首个不同字节就返回。 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  let diff: number = 0;
  for (let i = 0; i < 64; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 平台回调里摘出的一个 leaf 候选：DER + 来自哪条表示（x509 / pem）。 */
export interface LeafCandidate {
  der: Uint8Array;
  source: 'x509' | 'pem';
}

export interface LeafChainShape {
  x509Count: number;
  pemCount: number;
}

/** verifyLeafPin 的输入：全部是值，不含 SDK 对象，便于 Node 完全覆盖。 */
export interface VerifyLeafInput {
  host: string;
  ip: string;
  expectedHost: string;
  expectedIp: string; // 空串 = 不校验 IP
  expectedPin: string;
  leaves: LeafCandidate[];
  /** 链形状信号：x509Certs 无同步 DER 可读，只用来识别多证书/歧义。 */
  chainShape: LeafChainShape;
  /** 链首即 leaf 是否已由真机门禁带外证实；未证实 = 拒绝。 */
  leafOrderProven: boolean;
}

/** 注入 hash 便于「异常 ⇒ false」的可控单测；默认纯 TS SHA-256。 */
export interface VerifyDeps {
  hash?: (der: Uint8Array) => string;
}

/**
 * verifyPinnedLeaf 的纯判定核心。
 *
 * 判定顺序固定（任何含糊都不落到成功）：
 *   1. pin 非法/缺失 ⇒ E_NO_PIN；
 *   2. 接口能力未就绪（leafOrderProven=false）⇒ E_LEAF_ORDER_UNPROVEN；
 *   3. host / 可选 ip 不符 ⇒ E_HOST_MISMATCH / E_IP_MISMATCH；
 *   4. 链空 ⇒ E_CHAIN_MISSING；两种表示的 hash 不一致 ⇒ E_CHAIN_AMBIGUOUS；
 *   5. leaf DER 不可读 ⇒ E_LEAF_UNREADABLE；
 *   6. SHA-256(DER) 与 pin 恒定时间比较：相等 ⇒ ok，否则 ⇒ E_PIN_MISMATCH；
 *   7. 任意异常 ⇒ E_VERIFY_EXCEPTION（fail closed）。
 */
export function verifyLeafPin(input: VerifyLeafInput, deps: VerifyDeps = {}): VerifyOutcome {
  try {
    const expected: string = normalizePin(input.expectedPin);
    if (expected.length === 0) {
      return refusal('E_NO_PIN');
    }
    if (input.leafOrderProven !== true) {
      return refusal('E_LEAF_ORDER_UNPROVEN');
    }
    if (input.host.toLowerCase() !== input.expectedHost.toLowerCase()) {
      return refusal('E_HOST_MISMATCH');
    }
    if (input.expectedIp.length > 0 && input.ip !== input.expectedIp) {
      return refusal('E_IP_MISMATCH');
    }
    // PEM-only 设计：x509Certs 没有同步 DER 访问器，只作为形状信号。
    // 多证书（任一表示 >1）无法唯一确定 leaf ⇒ 歧义 fail closed。
    if (input.chainShape !== undefined &&
        (input.chainShape.pemCount > 1 || input.chainShape.x509Count > 1)) {
      return refusal('E_CHAIN_AMBIGUOUS');
    }
    if (!Array.isArray(input.leaves) || input.leaves.length === 0) {
      return refusal('E_CHAIN_MISSING');
    }
    const hash: (der: Uint8Array) => string = deps.hash ?? sha256Hex;
    const digests: string[] = [];
    for (const leaf of input.leaves) {
      if (leaf === null || leaf === undefined || !(leaf.der instanceof Uint8Array) || leaf.der.length === 0) {
        return refusal('E_LEAF_UNREADABLE');
      }
      digests.push(normalizePin(hash(leaf.der)));
    }
    // 两条表示都在时必须指向同一张 leaf；不一致 = 链含糊，fail closed。
    if (digests.length > 1) {
      for (let i = 1; i < digests.length; i++) {
        if (digests[i] !== digests[0]) {
          return refusal('E_CHAIN_AMBIGUOUS');
        }
      }
    }
    if (digests[0].length === 0) {
      return refusal('E_LEAF_UNREADABLE');
    }
    return constantTimeEqualHex(digests[0], expected) ? { ok: true } : refusal('E_PIN_MISMATCH');
  } catch (error) {
    // 不记录 error 内容：可能带 URL/证书/凭证。只返回 typed 拒绝。
    return refusal('E_VERIFY_EXCEPTION');
  }
}

/** 只给布尔值的薄封装，供「match ⇒ true，其余 ⇒ false」的门禁断言使用。 */
export function safeVerifyPinnedLeaf(input: VerifyLeafInput, deps: VerifyDeps = {}): boolean {
  return verifyLeafPin(input, deps).ok;
}

/** 带凭证请求的唯一输入；token 只出现在 authorization 字段。 */
export interface CredentialedRequest {
  url: string;                 // 绝不含凭证
  host: string;
  authorization: string;       // 仅供测试用合成凭证；生产由调用方从安全存储取
  expectedPin: string;
  expectedIp: string;
  leafOrderProven: boolean;
}

/** 传给 http.request 的 options（与本模块无关的平台字段由 .ets 适配层补齐）。 */
export interface PinnedRequestOptions {
  method: 'POST';
  header: Record<string, string>;
  maxRedirects: 0;
  usingProxy: false;
  /** 适配层把它映射成真正的 remoteValidation: verifyPinnedLeaf 函数。 */
  remoteValidation: 'verifyPinnedLeaf';
}

/** 一份带凭证请求的完整计划：URL 与 header 物理分离。 */
export interface PinnedRequestPlan {
  url: string;
  options: PinnedRequestOptions;
  host: string;
  expectedPin: string;
  expectedIp: string;
  leafOrderProven: boolean;
}

/**
 * 构造请求计划：header 是 bearer 的唯一载体；URL 永不拼凭证；
 * maxRedirects 固定 0、usingProxy 固定 false（SDK 级 no-follow / 不走系统代理）。
 */
export function buildPinnedRequestPlan(req: CredentialedRequest): PinnedRequestPlan {
  const header: Record<string, string> = { 'Authorization': req.authorization };
  return {
    url: req.url,
    options: {
      method: 'POST',
      header: header,
      maxRedirects: 0,
      usingProxy: false,
      remoteValidation: 'verifyPinnedLeaf'
    },
    host: req.host,
    expectedPin: req.expectedPin,
    expectedIp: req.expectedIp,
    leafOrderProven: req.leafOrderProven
  };
}

/** 传输层响应的最小形状（适配层把 http.HttpResponse 映射成它）。 */
export interface PinnedTransportResponse {
  responseCode: number;
  location: string;
  body: string;
  errorCode: number; // 0 = 无错误；平台错误码（2300060 / 2300047 等）只按数字处理
}

/** 执行结果：disposition 决定 UI，requestCount 证明没有第二次请求。 */
export interface PinnedExecution {
  disposition: PinnedResponseDisposition;
  requestCount: number;
}

export interface PinnedOkResponse {
  kind: 'ok';
  body: string;
}

export interface PinnedRefusedResponse {
  kind: 'refused';
  refusal: PinnedRefusal;
}

export type PinnedResponseDisposition = PinnedOkResponse | PinnedRefusedResponse;

/**
 * 响应分类：
 * - 平台 pin 拒绝 2300060 / 跳转上限 2300047 ⇒ typed 拒绝；
 * - 任何 3xx（含 location）⇒ E_REDIRECT_REFUSED，绝不渲染、绝不作为数据返回；
 * - 2xx ⇒ ok；其它状态与未知平台错误 ⇒ typed 拒绝，文案不带原始错误串。
 */
export function classifyPinnedResponse(res: PinnedTransportResponse): PinnedResponseDisposition {
  if (res.errorCode === 2300060) {
    return { kind: 'refused', refusal: makeRefusal('E_PIN_REJECTED') };
  }
  if (res.errorCode === 2300047) {
    return { kind: 'refused', refusal: makeRefusal('E_REDIRECT_LIMIT') };
  }
  if (res.errorCode !== 0) {
    // 只带数字码，不拼 error.message（可能含带 token 的 URL）。
    return {
      kind: 'refused',
      refusal: { code: 'E_TRANSPORT_FAILURE', message: `${PIN_REFUSAL_WORDING['E_TRANSPORT_FAILURE']}（${res.errorCode}）` }
    };
  }
  if (res.responseCode >= 300 && res.responseCode < 400) {
    return { kind: 'refused', refusal: makeRefusal('E_REDIRECT_REFUSED') };
  }
  if (res.responseCode >= 200 && res.responseCode < 300) {
    return { kind: 'ok', body: res.body };
  }
  return {
    kind: 'refused',
    refusal: { code: 'E_HTTP_FAILURE', message: `${PIN_REFUSAL_WORDING['E_HTTP_FAILURE']}（HTTP ${res.responseCode}）` }
  };
}

/** 原生渲染用的结构化卡片：只保留展示字段，绝不把响应原文/凭证带进 UI。 */
export interface PinnedRemoteCard {
  title: string;
  detail: string;
}

/**
 * 解析 pinned client 取回的结构化响应，供 ArkUI 原生渲染（不启用 WebView）。
 * 形状不对 / JSON 坏掉时返回空数组（fail closed，不回显原文，不猜测）。
 */
export function parsePinnedCards(body: string): PinnedRemoteCard[] {
  if (typeof body !== 'string' || body.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    void error;
    return [];
  }
  const root: Record<string, unknown> = parsed as Record<string, unknown>;
  const raw: unknown = root !== null && root !== undefined && !Array.isArray(root)
    ? root['cards']
    : parsed;
  if (!Array.isArray(raw)) {
    return [];
  }
  const cards: PinnedRemoteCard[] = [];
  for (const item of raw) {
    const row: Record<string, unknown> = item as Record<string, unknown>;
    if (row === null || row === undefined || typeof row !== 'object') {
      continue;
    }
    const title: unknown = row['title'];
    const detail: unknown = row['detail'];
    cards.push({
      title: typeof title === 'string' ? title : '',
      detail: typeof detail === 'string' ? detail : ''
    });
  }
  return cards;
}

/**
 * 注入式传输缝：让 Node 测试能用「遵守 maxRedirects:0 契约」的假传输跑真实编排逻辑。
 * 真实实现在 .ets 适配层，每个带凭证请求只调用一次 request。
 */
export interface PinnedTransport {
  request(url: string, options: PinnedRequestOptions): Promise<PinnedTransportResponse>;
}

/**
 * 带凭证请求的唯一编排：只发一次 request，之后再无第二次网络调用。
 * no-follow 由 plan.options.maxRedirects===0 在 SDK 侧保证；本函数额外拒绝任何 3xx。
 */
export async function executePinnedRequest(
  plan: PinnedRequestPlan,
  transport: PinnedTransport
): Promise<PinnedExecution> {
  const response: PinnedTransportResponse = await transport.request(plan.url, plan.options);
  return { disposition: classifyPinnedResponse(response), requestCount: 1 };
}
