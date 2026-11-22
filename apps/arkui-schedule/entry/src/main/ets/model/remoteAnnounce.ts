/**
 * 签名地址公告（mod-remote-announce）—— 纯模型，零 SDK import / 零 IO / 零网络 / 零仓库写，Node 可直接单测。
 *
 * 契约：`docs/REMOTE-DISCOVERY.md` §2（签名公告）、§3（直连 DSH 优先、tailcat 仅 host↔host）；
 * `docs/DATA-CONTRACT-v2.md` §9/§11（仓库写门槛 / schema 纪律）、`docs/PERSISTENCE.md`（配置落点）。
 * 产品边界：**直连 DSH**，没有网关 / 中继 / 转发；公告文件只由 host 写入私有仓库，平板只读。
 *
 * 公告字段（规范顺序，逐字序列化，无空格）：
 *   instanceId, scheme, host, port, transportKind, publicKeyFingerprint, tlsFingerprint,
 *   tokenId, updatedAt, nonce, signature
 * 其中 `signature` 不参与签名载荷；`signingPayload()` 只序列化前 10 个字段。
 *
 * 验证流水线**顺序固定**（验收标准，不是偏好）：
 *   ① signature（注入的 SignatureVerifier）→ ② fingerprint（TOFU 钉住）→ ③ 时间界限 → ④ 同 id 拒并。
 * 任何坏输入都返回 typed 结果、绝不抛错；唯一两处显式 throw 是内部不变量断言：
 *   (1) `assertCanonical()` —— 确定性断言（重解析后的键序 / 字节与构造值不一致时抛，只可能是代码 bug）；
 *   (2) `assertSignatureExcluded()` —— 防止把 `signature` 误放进签名载荷的不变量守卫。
 * 二者只在实现出错时触发，用户 / 仓库输入永远不会走到。
 */

/** 公告的 transportKind 词表：tailcat 只在 host↔host 记录里允许，平板侧一律拒绝。 */
export type AnnounceTransportKind = 'tailscale' | 'ipv6' | 'lan' | 'manual' | 'tailcat';

/** 调用方身份：平板 = 只读消费公告（tailcat 不可用）；host = 发布 / host↔host。 */
export type AnnounceCaller = 'tablet' | 'host';

/** typed 拒绝码：模型、解析、验证、发布门禁共用一套，UI 只展示中文 reason。 */
export type AnnounceProblem =
  | 'ok'
  | 'E_ANNOUNCE_SHAPE'
  | 'E_ANNOUNCE_JSON'
  | 'E_ANNOUNCE_MISSING'
  | 'E_ANNOUNCE_TYPE'
  | 'E_ANNOUNCE_FIELD'
  | 'E_ANNOUNCE_TRANSPORT'
  | 'E_ANNOUNCE_TRANSPORT_UNSUPPORTED'
  | 'E_ANNOUNCE_CALLER'
  | 'E_ANNOUNCE_SIGNATURE'
  | 'E_ANNOUNCE_PIN_REQUIRED'
  | 'E_ANNOUNCE_PIN_MISMATCH'
  | 'E_ANNOUNCE_FUTURE'
  | 'E_ANNOUNCE_TOO_OLD'
  | 'E_ANNOUNCE_ID_CONFLICT'
  | 'E_ANNOUNCE_NOT_NEWER'
  | 'E_ANNOUNCE_SECRET'
  | 'E_ANNOUNCE_REPO_PUBLIC'
  | 'E_ANNOUNCE_REPO_UNKNOWN';

/** 规范字段顺序（规范序列化与 signingPayload 的唯一顺序来源）。 */
export const ANNOUNCE_FIELDS: readonly string[] = [
  'instanceId',
  'scheme',
  'host',
  'port',
  'transportKind',
  'publicKeyFingerprint',
  'tlsFingerprint',
  'tokenId',
  'updatedAt',
  'nonce',
  'signature'
];

/** 签名载荷字段 = 规范字段去掉末尾的 signature（同样保持固定顺序）。 */
export const SIGNING_FIELDS: readonly string[] = ANNOUNCE_FIELDS.slice(0, ANNOUNCE_FIELDS.length - 1);

/** 「公告不可信，请手动确认」—— 所有非刷新分支的唯一上屏文案（逐字，测试按此断言）。 */
export const KEEP_WORDING: string = '公告不可信，请手动确认';

/** 未来界限 5 分钟、过去界限 30 天（毫秒）。 */
const FUTURE_LIMIT_MS: number = 5 * 60 * 1000;
const PAST_LIMIT_MS: number = 30 * 24 * 60 * 60 * 1000;

/** 签名验证接缝：生产注入 ArkTS cryptoFramework Ed25519 适配器，测试注入假实现。 */
export type SignatureVerifier = (payload: string, signature: string, publicKey: string) => boolean;

/** 一条签名公告（字段顺序即规范顺序；signature 是最后一段）。 */
export interface Announcement {
  instanceId: string;
  scheme: string;
  host: string;
  port: number;
  transportKind: AnnounceTransportKind;
  publicKeyFingerprint: string;
  tlsFingerprint: string;
  tokenId: string;
  updatedAt: number;
  nonce: string;
  signature: string;
}

/** 宽松输入：全部字段按 unknown 读，坏值 typed 拒绝而不是抛错。 */
export interface RawAnnouncement {
  [key: string]: unknown;
}

/** 归一结果：失败时 announcement=null + typed problem。 */
export interface AnnounceResult {
  ok: boolean;
  announcement: Announcement | null;
  problem: AnnounceProblem;
  reason: string;
}

/** 验证结果：ok 时 pin 为应持久化 / 比对的公钥指纹。 */
export interface VerifyResult {
  ok: boolean;
  pin: string;
  problem: AnnounceProblem;
  reason: string;
}

/** 自动刷新决策：refresh 才更新地址；keep 的 reason 恒为 KEEP_WORDING。 */
export interface RefreshDecision {
  action: 'refresh' | 'keep';
  pin: string;
  problem: AnnounceProblem;
  reason: string;
}

/** 发布门禁结果：仓库非私有即 typed 拒绝（fail-closed）。 */
export interface PublishDecision {
  ok: boolean;
  problem: AnnounceProblem;
  reason: string;
}

/** 验证选项：所有 IO 都被注入（验签、时钟、已有的 TOFU 钉住表）。 */
export interface AnnounceVerifyOptions {
  /** 注入的签名验证器；异常必须由实现吞掉并返回 false。 */
  verifier: SignatureVerifier;
  /** 验签用的 Ed25519 公钥材料（base64 / hex 由适配器约定）；公告里只有指纹，不含公钥原文。 */
  publicKey: string;
  /** 当前钉住的公钥指纹；空串 = 尚未钉住（首配路径）。 */
  pinnedKey: string;
  /** 显式「首次配对」授权；没有 pin 且此位为 false ⇒ typed 拒绝。 */
  firstPairing: boolean;
  /** 已知的 (instanceId → 公钥指纹) 表，供第 ④ 步同 id 冲突检测（重复公告永不合并）。 */
  knownPins: Readonly<Record<string, string>>;
  /** 注入的时钟（返回 epoch 毫秒），测试可 spy 它来验证「验签先于时间判定」。 */
  now: () => number;
}

/** typed 码 → 可直接上屏的中文原因（原因本身永不回显令牌值）。 */
export function problemText(problem: AnnounceProblem): string {
  switch (problem) {
    case 'E_ANNOUNCE_SHAPE': return '公告数据不是对象';
    case 'E_ANNOUNCE_JSON': return '公告 JSON 损坏，已忽略';
    case 'E_ANNOUNCE_MISSING': return '公告缺少必填字段';
    case 'E_ANNOUNCE_TYPE': return '公告字段类型不正确';
    case 'E_ANNOUNCE_FIELD': return '公告字段值不合法';
    case 'E_ANNOUNCE_TRANSPORT': return '公告的传输方式不在支持范围内';
    case 'E_ANNOUNCE_TRANSPORT_UNSUPPORTED': return '平板不支持该传输方式的公告';
    case 'E_ANNOUNCE_CALLER': return '公告调用方身份不合法';
    case 'E_ANNOUNCE_SIGNATURE': return '公告签名验证失败';
    case 'E_ANNOUNCE_PIN_REQUIRED': return '尚未钉住公钥，需要显式首次配对';
    case 'E_ANNOUNCE_PIN_MISMATCH': return '公告公钥指纹与钉住值不一致';
    case 'E_ANNOUNCE_FUTURE': return '公告时间超出未来 5 分钟';
    case 'E_ANNOUNCE_TOO_OLD': return '公告时间早于 30 天';
    case 'E_ANNOUNCE_ID_CONFLICT': return '同一个实例出现不同公钥的公告，已拒绝且不合并';
    case 'E_ANNOUNCE_NOT_NEWER': return '公告不比已存地址更新';
    case 'E_ANNOUNCE_SECRET': return '公告包含凭据 / 私钥等禁止字段';
    case 'E_ANNOUNCE_REPO_PUBLIC': return '仓库是公开的，拒绝发布地址公告';
    case 'E_ANNOUNCE_REPO_UNKNOWN': return '无法确定仓库是否私有，拒绝发布地址公告';
    default: return '';
  }
}

/** 内部：拒绝结果（announcement 恒为 null）。 */
function refused(problem: AnnounceProblem): AnnounceResult {
  return { ok: false, announcement: null, problem: problem, reason: problemText(problem) };
}

/** 内部：验证拒绝结果（pin 恒为空串）。 */
function verifyRefused(problem: AnnounceProblem): VerifyResult {
  return { ok: false, pin: '', problem: problem, reason: problemText(problem) };
}

/** 内部：keep 决策（上屏文案逐字等于 KEEP_WORDING）。 */
function keep(problem: AnnounceProblem): RefreshDecision {
  return { action: 'keep', pin: '', problem: problem, reason: KEEP_WORDING };
}

/** 只接受字符串，去首尾空白；其余类型按空串。 */
function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 指纹归一：trim + 小写，便于 TOFU 比对（大小写差异不算冲突）。 */
function normaliseFingerprint(value: string): string {
  return value.trim().toLowerCase();
}

/** 合法公钥指纹形态：16–64 位小写十六进制（大小写输入先归一）。 */
const FINGERPRINT_RE: RegExp = /^[0-9a-f]{16,64}$/;
/** 合法实例 id：inst- + 16 位小写十六进制（与 instances.ts 同口径）。 */
const INSTANCE_ID_RE: RegExp = /^inst-[0-9a-f]{16}$/;
/** tokenId / nonce 允许的安全字符（无空白、无引号、无控制字符）。 */
const SAFE_ID_RE: RegExp = /^[A-Za-z0-9._:\-]{1,128}$/;

/** `publicKeyFingerprint` / `tlsFingerprint` 共用校验。 */
function validFingerprint(value: string): boolean {
  return FINGERPRINT_RE.test(normaliseFingerprint(value));
}

/**
 * 构造规范字节串：严格按给定字段顺序拼 `{"k":v,...}`，无空格、无额外字段。
 * 这是签名与验签**唯一**的字节来源；未知字段在此被天然丢弃（never-containing）。
 */
function buildCanonical(fields: readonly string[], values: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of fields) {
    const value: unknown = values[field];
    // 缺字段时用 null 兜底而不是抛：坏输入路径一律返回 typed 结果（normalize 会先挡住）。
    parts.push(`${JSON.stringify(field)}:${JSON.stringify(value === undefined ? null : value)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 显式 throw 案例 (1)：确定性断言。
 * 重新解析自己产出的字节，若键序或重序列化字节不一致 ⇒ 抛（只可能是实现 bug，不是用户输入）。
 */
function assertCanonical(text: string, fields: readonly string[]): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('E_ANNOUNCE_CANON_JSON');
  }
  const keys: string[] = Object.keys(parsed);
  if (keys.length !== fields.length) {
    throw new Error('E_ANNOUNCE_CANON_ORDER');
  }
  for (let i = 0; i < fields.length; i++) {
    if (keys[i] !== fields[i]) {
      throw new Error('E_ANNOUNCE_CANON_ORDER');
    }
  }
  if (buildCanonical(fields, parsed) !== text) {
    throw new Error('E_ANNOUNCE_CANON_BYTES');
  }
}

/**
 * 显式 throw 案例 (2)：防止 `signature` 混进签名载荷的不变量守卫。
 * 只在编码错误（把 signature 加进 SIGNING_FIELDS）时触发，用户输入永不触发。
 */
function assertSignatureExcluded(fields: readonly string[]): void {
  for (const field of fields) {
    if (field === 'signature') {
      throw new Error('E_ANNOUNCE_SIGN_INVARIANT');
    }
  }
}

/** 规范序列化（含 signature）：用于发布 / 落盘的逐字节确定性表示。 */
export function canonicalSerialise(ann: Announcement): string {
  const values: Record<string, unknown> = {
    instanceId: ann.instanceId,
    scheme: ann.scheme,
    host: ann.host,
    port: ann.port,
    transportKind: ann.transportKind,
    publicKeyFingerprint: ann.publicKeyFingerprint,
    tlsFingerprint: ann.tlsFingerprint,
    tokenId: ann.tokenId,
    updatedAt: ann.updatedAt,
    nonce: ann.nonce,
    signature: ann.signature
  };
  const text: string = buildCanonical(ANNOUNCE_FIELDS, values);
  assertCanonical(text, ANNOUNCE_FIELDS);
  return text;
}

/** 签名载荷（排除 signature）：验签器收到的就是这串字节。 */
export function signingPayload(ann: Announcement): string {
  assertSignatureExcluded(SIGNING_FIELDS);
  const values: Record<string, unknown> = {
    instanceId: ann.instanceId,
    scheme: ann.scheme,
    host: ann.host,
    port: ann.port,
    transportKind: ann.transportKind,
    publicKeyFingerprint: ann.publicKeyFingerprint,
    tlsFingerprint: ann.tlsFingerprint,
    tokenId: ann.tokenId,
    updatedAt: ann.updatedAt,
    nonce: ann.nonce
  };
  const text: string = buildCanonical(SIGNING_FIELDS, values);
  assertCanonical(text, SIGNING_FIELDS);
  return text;
}

/**
 * 凭据扫描器：扫描**字节**而不是结构。命中任一即 true（fail-closed）：
 * - `"token"` 作为字段名（`"tokenId"` 不算）；
 * - `privateKey` 字样 / PEM 的 `BEGIN`；
 * - query 形态的 `?token=` / `&k=`；
 * - 调用方显式给出的已知令牌值（第二参数）。
 */
export function containsSecret(text: string, knownSecrets?: readonly string[]): boolean {
  const bytes: string = typeof text === 'string' ? text : '';
  if (/"token"\s*:/i.test(bytes)) {
    return true;
  }
  if (/privateKey/i.test(bytes)) {
    return true;
  }
  if (/BEGIN/i.test(bytes)) {
    return true;
  }
  if (/[?&#](?:token|k)=/i.test(bytes)) {
    return true;
  }
  if (Array.isArray(knownSecrets)) {
    for (const value of knownSecrets) {
      if (typeof value === 'string' && value.length > 0 && bytes.indexOf(value) >= 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 校验并归一一条公告（不抛异常）。
 * 判定顺序：形状 → 调用方 → 必填字段 → 类型 → 逐字段值 → tailcat/平板拒绝。
 * `token` / `privateKey` 这类禁止字段直接 typed 拒绝；其余未知字段忽略（规范序列化天然不含它们）。
 */
export function normalizeAnnouncement(raw: unknown, caller: AnnounceCaller): AnnounceResult {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return refused('E_ANNOUNCE_SHAPE');
  }
  if (caller !== 'tablet' && caller !== 'host') {
    return refused('E_ANNOUNCE_CALLER');
  }
  const obj: Record<string, unknown> = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, 'token') ||
      Object.prototype.hasOwnProperty.call(obj, 'privateKey')) {
    return refused('E_ANNOUNCE_SECRET');
  }
  for (const field of SIGNING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(obj, field)) {
      return refused('E_ANNOUNCE_MISSING');
    }
  }
  const instanceId: string = readText(obj['instanceId']);
  const scheme: string = readText(obj['scheme']);
  const host: string = readText(obj['host']);
  const transportKind: string = readText(obj['transportKind']);
  const publicKeyFingerprint: string = readText(obj['publicKeyFingerprint']);
  const tlsFingerprint: string = readText(obj['tlsFingerprint']);
  const tokenId: string = readText(obj['tokenId']);
  const nonce: string = readText(obj['nonce']);
  const port: unknown = obj['port'];
  const updatedAt: unknown = obj['updatedAt'];
  const signature: unknown = obj['signature'];
  // 类型判定（signingPayload 的 10 个字段 + 可选 signature）
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    return refused('E_ANNOUNCE_TYPE');
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    return refused('E_ANNOUNCE_TYPE');
  }
  if (signature !== undefined && typeof signature !== 'string') {
    return refused('E_ANNOUNCE_TYPE');
  }
  // 逐字段值判定
  if (!INSTANCE_ID_RE.test(instanceId)) {
    return refused('E_ANNOUNCE_FIELD');
  }
  if (scheme !== 'http' && scheme !== 'https') {
    return refused('E_ANNOUNCE_FIELD');
  }
  if (host.length === 0 || /[\s@/?#\\]/.test(host)) {
    return refused('E_ANNOUNCE_FIELD');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return refused('E_ANNOUNCE_FIELD');
  }
  if (transportKind !== 'tailscale' && transportKind !== 'ipv6' && transportKind !== 'lan' &&
      transportKind !== 'manual' && transportKind !== 'tailcat') {
    return refused('E_ANNOUNCE_TRANSPORT');
  }
  // tailcat 只用于 host↔host；平板侧是 typed 拒绝，不静默降级（见 TAILCAT-HARMONYOS-SPIKE §6）
  if (transportKind === 'tailcat' && caller === 'tablet') {
    return refused('E_ANNOUNCE_TRANSPORT_UNSUPPORTED');
  }
  if (!validFingerprint(publicKeyFingerprint) || !validFingerprint(tlsFingerprint)) {
    return refused('E_ANNOUNCE_FIELD');
  }
  if (!SAFE_ID_RE.test(tokenId) || !SAFE_ID_RE.test(nonce)) {
    return refused('E_ANNOUNCE_FIELD');
  }
  if (!Number.isInteger(updatedAt) || updatedAt <= 0) {
    return refused('E_ANNOUNCE_FIELD');
  }
  const ann: Announcement = {
    instanceId: instanceId,
    scheme: scheme,
    host: host,
    port: port,
    transportKind: transportKind as AnnounceTransportKind,
    publicKeyFingerprint: normaliseFingerprint(publicKeyFingerprint),
    tlsFingerprint: normaliseFingerprint(tlsFingerprint),
    tokenId: tokenId,
    updatedAt: updatedAt,
    nonce: nonce,
    signature: typeof signature === 'string' ? signature : ''
  };
  return { ok: true, announcement: ann, problem: 'ok', reason: '' };
}

/** 解析规范 JSON 文本并归一；坏 JSON 返回 typed E_ANNOUNCE_JSON，绝不抛异常。 */
export function parseAnnouncement(text: unknown, caller: AnnounceCaller): AnnounceResult {
  const raw: string = typeof text === 'string' ? text.trim() : '';
  if (raw.length === 0) {
    return refused('E_ANNOUNCE_JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return refused('E_ANNOUNCE_JSON');
  }
  return normalizeAnnouncement(parsed, caller);
}

/** 指纹比对（TOFU pin）：两侧都 trim + 小写后精确相等。 */
export function verifyFingerprint(pinned: string, announced: string): boolean {
  const a: string = normaliseFingerprint(typeof pinned === 'string' ? pinned : '');
  const b: string = normaliseFingerprint(typeof announced === 'string' ? announced : '');
  return a.length > 0 && b.length > 0 && a === b;
}

/**
 * 验证流水线（顺序固定，验收标准）：
 *   ① signature → ② fingerprint（TOFU pin / 首配）→ ③ 时间界限 → ④ 同 id 拒并。
 * 时钟 `opts.now()` 只在第 ③ 步调用一次，便于测试用 spy 证明「验签先于时间判定」。
 */
export function verifyAnnouncement(ann: Announcement, opts: AnnounceVerifyOptions): VerifyResult {
  // ① signature —— 注入的验签器；异常一律按失败，绝不按通过。
  const payload: string = signingPayload(ann);
  let signatureOk: boolean = false;
  try {
    signatureOk = opts.verifier(payload, ann.signature, opts.publicKey) === true;
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return verifyRefused('E_ANNOUNCE_SIGNATURE');
  }

  // ② fingerprint（TOFU）：没有 pin ⇒ 只允许带显式首配标志的路径，并返回要保存的 pin。
  const announcedPin: string = normaliseFingerprint(ann.publicKeyFingerprint);
  const pinned: string = typeof opts.pinnedKey === 'string' ? normaliseFingerprint(opts.pinnedKey) : '';
  if (pinned.length === 0) {
    if (opts.firstPairing !== true) {
      return verifyRefused('E_ANNOUNCE_PIN_REQUIRED');
    }
  } else if (!verifyFingerprint(pinned, announcedPin)) {
    return verifyRefused('E_ANNOUNCE_PIN_MISMATCH');
  }
  const pin: string = pinned.length === 0 ? announcedPin : pinned;

  // ③ 时间界限：未来 >5 分钟 / 过去 >30 天，两个不同的 typed 码；边界值本身放行。
  const now: number = typeof opts.now === 'function' ? opts.now() : 0;
  if (!Number.isFinite(now)) {
    return verifyRefused('E_ANNOUNCE_FIELD');
  }
  if (ann.updatedAt > now + FUTURE_LIMIT_MS) {
    return verifyRefused('E_ANNOUNCE_FUTURE');
  }
  if (ann.updatedAt < now - PAST_LIMIT_MS) {
    return verifyRefused('E_ANNOUNCE_TOO_OLD');
  }

  // ④ 同 id 拒并：已知该 id 的钉住公钥与本次 pin 不同 ⇒ typed 冲突，绝不合并。
  const known: unknown = opts.knownPins[ann.instanceId];
  if (typeof known === 'string' && known.length > 0 && !verifyFingerprint(known, pin)) {
    return verifyRefused('E_ANNOUNCE_ID_CONFLICT');
  }

  return { ok: true, pin: pin, problem: 'ok', reason: '' };
}

/**
 * 自动刷新决策：只有四步全过 **且** `updatedAt` 严格新于已存时间才 refresh；
 * 其余一律 keep（上屏文案逐字 = KEEP_WORDING），地址保持旧值。
 */
export function decideAutoRefresh(
  ann: Announcement,
  storedUpdatedAt: number,
  opts: AnnounceVerifyOptions
): RefreshDecision {
  const verified: VerifyResult = verifyAnnouncement(ann, opts);
  if (!verified.ok) {
    return keep(verified.problem);
  }
  const stored: number = typeof storedUpdatedAt === 'number' && Number.isFinite(storedUpdatedAt)
    ? storedUpdatedAt
    : 0;
  if (!(ann.updatedAt > stored)) {
    return keep('E_ANNOUNCE_NOT_NEWER');
  }
  return { action: 'refresh', pin: verified.pin, problem: 'ok', reason: '' };
}

/**
 * 发布前清洗：未知字段一律剥离；凭据 / 私钥 / `"token"` 字段 typed 拒绝（never-containing）。
 * 发布发生在 host 侧，因此默认 caller='host'。
 */
export function sanitiseForPublish(
  input: unknown,
  caller: AnnounceCaller = 'host'
): AnnounceResult {
  const normalized: AnnounceResult = normalizeAnnouncement(input, caller);
  if (!normalized.ok || normalized.announcement === null) {
    return normalized;
  }
  const bytes: string = canonicalSerialise(normalized.announcement);
  if (containsSecret(bytes)) {
    return refused('E_ANNOUNCE_SECRET');
  }
  return normalized;
}

/**
 * 发布门禁（fail-closed）：仓库私有才允许；公开 / 未知（含任何非三者值）都 typed 拒绝。
 * 公告 + 指纹是定向辅助，非私有仓库绝不发布。
 */
export function canPublish(repoVisibility: unknown): PublishDecision {
  if (repoVisibility === 'private') {
    return { ok: true, problem: 'ok', reason: '' };
  }
  if (repoVisibility === 'public') {
    return { ok: false, problem: 'E_ANNOUNCE_REPO_PUBLIC', reason: problemText('E_ANNOUNCE_REPO_PUBLIC') };
  }
  return { ok: false, problem: 'E_ANNOUNCE_REPO_UNKNOWN', reason: problemText('E_ANNOUNCE_REPO_UNKNOWN') };
}
