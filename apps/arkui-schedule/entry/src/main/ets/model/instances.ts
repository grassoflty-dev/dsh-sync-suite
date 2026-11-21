/**
 * 远程实例表模型 —— 纯逻辑，零 SDK import，Node 可直接单测。
 *
 * 契约：`docs/REMOTE-INSTANCES.md` §1（信息架构里的稳定 id）、§2（实例模型 / token 保护）、
 * §6（token 泄漏风险），`docs/REVIEW-remote-security.md` §2（令牌唯一出口）。
 *
 * 产品决定（`mod-instances-drop-local`）：平板不跑原生 DSH，**本机实例不存在**，表里每一行都是
 * 远程实例；空表 + 「添加实例」是正常首用状态。
 *
 * 四条不变式：
 * 1. **id 恒为远程**：只认 `inst-<sha16(归一 url)>`；旧版本持久化的 `local` 占位行仅在解码时
 *    按字面量过滤（见 `LEGACY_LOCAL_ID`），不复活、不落盘，也绝不影响同信封里的远程行。
 * 2. **url 永不含 token**：归一阶段从 query 抽出 `token` / `k` 到 `token` 字段，落盘时
 *    token 只在信封里；对外一律走 `redactInstance` / `redactUrl`，只给 `tokenSet`，
 *    不给任何形式的令牌值。
 * 3. **fail-closed 拒绝**：id / url / mode / 显式空名任一不合法就返回 typed reason，
 *    不猜、不回落（mode 不回落到 lan；未知 reachable 只回落 `unknown`，永不升成 `ok`）。
 * 4. **派生字段不落盘**：`capabilities` 每次加载由 `deriveCapabilities()` 重新生成；
 *    信封只写 `{v:1,items:[{id,name,url,mode,token?,lastSeen?,reachable}]}`。
 */

import { findRemoteMode } from './remoteAccess';
import { normalizeRemoteUrl, sanitizeUrlForDisplay, stripRemoteToken } from './remoteUrl';
import { sha256Hex } from './sha256';

/** 远程行 id 前缀：`inst-<sha16(归一 url)>`（设计稿 §2）。 */
export const INSTANCE_ID_PREFIX: string = 'inst-';

/**
 * 旧版本持久化信封里可能出现的本机占位行 id，**只用于解码时过滤**（`decodeInstances`）。
 *
 * 平板不跑原生 DSH，本机实例已从产品里删除：这只是一个遗留数据的字面量判断，
 * 不是可创建的「本机实例」模型原语；过滤后不复活、不落盘，也绝不碰同信封里的远程行。
 */
const LEGACY_LOCAL_ID: string = 'local';

/** 合法 id：`inst-` + 16 位小写十六进制；旧 `local` 不再是合法实例 id。 */
export const INSTANCE_ID_PATTERN: RegExp = /^inst-[0-9a-f]{16}$/;

/** 远程行缺省名（仅在调用方完全没给 name 字段时使用；显式空串仍是拒绝）。 */
export const DEFAULT_REMOTE_NAME: string = '远程实例';

/** 持久化信封版本（只认 1，未来版本 typed 拒绝，不静默迁移）。 */
export const INSTANCE_ENVELOPE_VERSION: number = 1;

/** 单实例持久键前缀：只由合法 id 生成，非法 id 返回空串（不污染偏好键空间）。 */
export const INSTANCE_KEY_PREFIX: string = 'instance:';

/** 可达三态：未知永不降级成 ok（设计稿 §2 / `docs/REMOTE-ACCESS-OPTIONS.md:243`）。 */
export type Reachability = 'unknown' | 'ok' | 'fail';

/** typed 问题码：模型拒绝、信封损坏、存储不可用共用一套，UI 只展示中文 reason。 */
export type InstanceProblem =
  | 'ok'
  | 'E_INSTANCE_SHAPE'
  | 'E_INSTANCE_ID'
  | 'E_INSTANCE_URL'
  | 'E_INSTANCE_MODE'
  | 'E_INSTANCE_NAME'
  | 'E_ENVELOPE_EMPTY'
  | 'E_ENVELOPE_JSON'
  | 'E_ENVELOPE_SHAPE'
  | 'E_ENVELOPE_VERSION'
  | 'E_ENVELOPE_ITEM'
  | 'E_STORAGE_UNAVAILABLE';

/**
 * 能力集（设计稿 §2）：由探测给出、不落盘。
 * 第一片没有探测 RPC，默认值只表达「已知恒有 / 恒无」：所有实例都是远程，`webUI` 恒有；
 * 其余一律 false，未知永不升成已具备。
 */
export interface InstanceCapabilities {
  /** 内嵌 Web 可打开（远程恒 true）。 */
  webUI: boolean;
  /** `/dsh-dots/rpc` 可达（未探测前恒 false）。 */
  rpc: boolean;
  /** `chatExportStatus` 可用。 */
  chatExport: boolean;
  /** `sessionLease*` 可用。 */
  lease: boolean;
  /** `sessionCreate` 可用（新增 RPC，未实现前恒 false）。 */
  sessionCreate: boolean;
}

/** 一条实例记录；`token` / `lastSeen` 可选，渲染侧禁止直接读这两个字段。 */
export interface DsInstance {
  /** `inst-<sha16>`（所有实例都是远程）。 */
  id: string;
  /** 展示名（trim 后非空）。 */
  name: string;
  /** 不含 token 的 http(s) base。 */
  url: string;
  /** `REMOTE_MODE_*` 之一（`lan/tailscale/ipv6/cloudflare/manual/uu`）。 */
  mode: string;
  /** 可选令牌；secret，只允许出现在持久化信封内部。 */
  token?: string;
  /** 最近一次成功探测的毫秒时间戳；失败不覆盖。 */
  lastSeen?: number;
  /** 可达三态。 */
  reachable: Reachability;
  /** 派生能力集，不落盘。 */
  capabilities: InstanceCapabilities;
}

/** 给渲染 / 导出的只读视图：**结构上没有 token 字段**，只有 `tokenSet`。 */
export interface RedactedInstance {
  id: string;
  name: string;
  url: string;
  mode: string;
  /** 是否保存过令牌（只有布尔，永不回显值）。 */
  tokenSet: boolean;
  lastSeen?: number;
  reachable: Reachability;
  capabilities: InstanceCapabilities;
}

/** 反序列化输入；全部可选，坏字段一律 typed 拒绝而不是抛错。 */
export interface RawInstance {
  id?: string;
  name?: string;
  url?: string;
  mode?: string;
  token?: string;
  lastSeen?: number;
  /** 兼容设计稿 §2 的 `true/false/null` 三态。 */
  reachable?: string | boolean | null;
}

/** 归一结果：`ok=false` 时 `instance=null` + typed problem + 中文 reason。 */
export interface InstanceNormalizeResult {
  ok: boolean;
  instance: DsInstance | null;
  problem: InstanceProblem;
  reason: string;
}

/** 信封解码结果：失败时 `items=[]` + typed problem（供 UI 显示，不抛异常）。 */
export interface InstanceDecodeResult {
  ok: boolean;
  items: DsInstance[];
  problem: InstanceProblem;
  reason: string;
}

/** 运行时宽松读取（脏 JSON 的数字 / null / 数组不能让归一抛错）。 */
type LooseValue = string | number | boolean | null | undefined | object;

/** 只接受字符串，去首尾空白；其余类型按空串。 */
function readText(value: LooseValue): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从 query 里找第一个非空的 `token` / `k`（键名大小写不敏感，与 `remoteUrl` 同口径）。 */
function findUrlToken(url: string): string {
  const hash: number = url.indexOf('#');
  const beforeHash: string = hash >= 0 ? url.slice(0, hash) : url;
  const question: number = beforeHash.indexOf('?');
  if (question < 0) {
    return '';
  }
  const pairs: string[] = beforeHash.slice(question + 1).split('&');
  for (const pair of pairs) {
    const equal: number = pair.indexOf('=');
    if (equal < 0) {
      continue;
    }
    const key: string = pair.slice(0, equal).toLowerCase();
    if (key !== 'token' && key !== 'k') {
      continue;
    }
    const encoded: string = pair.slice(equal + 1);
    if (encoded.length === 0) {
      continue;
    }
    let decoded: string = encoded;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      // 畸形百分号编码：按原文，绝不因为坏值抛错
      decoded = encoded;
    }
    if (decoded.length > 0) {
      return decoded;
    }
  }
  return '';
}

/**
 * 剥离 URL 的 `#…` fragment：**只做一次字符串截取，不解析 / 不重序列化地址**。
 *
 * 为什么单独做这一步：`remoteUrl.stripRemoteToken()` 明确逐字保留 fragment
 * （`remoteUrl.ts:558-560,586,588`），于是 `http://h/?k=S#token=S` 剥完 query 令牌后
 * 仍留下 `#token=S`——明文进了持久 `url`，还被 `instanceIdFromUrl()` 一起哈希。
 * 这里在落盘 / 哈希之前把整段 fragment 切掉：片段里的 `#token=` 被彻底丢弃（不是抽到
 * `token` 字段，因为 `findUrlToken()` 按契约只读 query），地址形态保持与原归一结果一致。
 */
function stripUrlFragment(url: string): string {
  const hash: number = url.indexOf('#');
  return hash >= 0 ? url.slice(0, hash) : url;
}

/** 整个字符串兜底打码（覆盖 fragment 等 `sanitizeUrlForDisplay` 不管的位置）。 */
const TOKEN_PAIR_RE: RegExp = /(^|[?&#])((?:token|k)=)([^&#]*)/gi;

/** 兜底打码：只替换非空且尚未打码的值。 */
function maskTokenPairs(text: string): string {
  return text.replace(
    TOKEN_PAIR_RE,
    (whole: string, lead: string, pair: string, value: string): string => {
      if (value.length === 0 || value === '***') {
        return whole;
      }
      return `${lead}${pair}***`;
    }
  );
}

/** typed 码 → 可直接上屏的中文原因（原因本身永不回显令牌值）。 */
export function problemText(problem: InstanceProblem): string {
  switch (problem) {
    case 'E_INSTANCE_SHAPE':
      return '实例数据不是对象';
    case 'E_INSTANCE_ID':
      return '实例 id 只能是 inst- 加 16 位十六进制';
    case 'E_INSTANCE_URL':
      return '实例地址必须是完整的 http(s) 地址';
    case 'E_INSTANCE_MODE':
      return '实例访问方式不在支持的六种之内';
    case 'E_INSTANCE_NAME':
      return '实例名称不能为空';
    case 'E_ENVELOPE_EMPTY':
      return '还没有保存过实例';
    case 'E_ENVELOPE_JSON':
      return '实例表 JSON 损坏，已回落空表';
    case 'E_ENVELOPE_SHAPE':
      return '实例表结构不正确，已回落空表';
    case 'E_ENVELOPE_VERSION':
      return '实例表版本不认识，已回落空表';
    case 'E_ENVELOPE_ITEM':
      return '实例表中有损坏的记录，已回落空表';
    case 'E_STORAGE_UNAVAILABLE':
      return '本地存储不可用，实例表只在本次运行内有效';
    default:
      return '';
  }
}

/** 内部：拒绝结果。 */
function refused(problem: InstanceProblem): InstanceNormalizeResult {
  const result: InstanceNormalizeResult = {
    ok: false,
    instance: null,
    problem: problem,
    reason: problemText(problem)
  };
  return result;
}

/** 内部：成功结果。 */
function accepted(instance: DsInstance): InstanceNormalizeResult {
  const result: InstanceNormalizeResult = {
    ok: true,
    instance: instance,
    problem: 'ok',
    reason: ''
  };
  return result;
}

/** 内部：解码失败结果（永远带空表）。 */
function decodeFailed(problem: InstanceProblem): InstanceDecodeResult {
  const result: InstanceDecodeResult = {
    ok: false,
    items: [],
    problem: problem,
    reason: problemText(problem)
  };
  return result;
}

/** 能力集副本：避免调用方改到模型内部的共享对象。 */
function copyCapabilities(capabilities: InstanceCapabilities): InstanceCapabilities {
  const copy: InstanceCapabilities = {
    webUI: capabilities.webUI,
    rpc: capabilities.rpc,
    chatExport: capabilities.chatExport,
    lease: capabilities.lease,
    sessionCreate: capabilities.sessionCreate
  };
  return copy;
}

/**
 * 能力集（不落盘）。所有实例都是远程：内嵌 Web 恒有，其余能力等探测再开，
 * 未知永不升成已具备。保留 `_id` 形参只为兼容既有调用点，能力集不再按 id 分叉。
 */
export function deriveCapabilities(_id: string): InstanceCapabilities {
  const capabilities: InstanceCapabilities = {
    webUI: true, rpc: false, chatExport: false, lease: false, sessionCreate: false
  };
  return capabilities;
}

/**
 * 由归一后的 URL 生成稳定 id：`inst-<sha16>`。
 * 地址相同、token 不同 → 同一个 id（token 不参与哈希）；坏地址 → 空串（fail-closed）。
 */
export function instanceIdFromUrl(url: string): string {
  const check = normalizeRemoteUrl(readText(url));
  if (!check.ok || !check.hadScheme) {
    return '';
  }
  // 先剥 fragment 再剥 query 令牌再哈希：fragment 里的 token 不参与 id（P2-1）
  const base: string = stripUrlFragment(stripRemoteToken(check.url));
  if (base.length === 0) {
    return '';
  }
  return `${INSTANCE_ID_PREFIX}${sha256Hex(base).slice(0, 16)}`;
}

/** 持久键片段：合法 id 才生成，非法 id 返回空串（不让脏值进偏好键空间）。 */
export function instanceKey(id: string): string {
  if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
    return '';
  }
  return `${INSTANCE_KEY_PREFIX}${id}`;
}

/** 兼容三态：设计稿的 `true/false/null` 与模型的 `ok/fail/unknown`；未知只回落 unknown。 */
function normalizeReachable(raw: LooseValue): Reachability {
  if (raw === true || raw === 'ok') {
    return 'ok';
  }
  if (raw === false || raw === 'fail') {
    return 'fail';
  }
  return 'unknown';
}

/**
 * 校验并归一一条实例（**不抛异常**）。
 *
 * 判定顺序：对象形状 → id → mode → url → name。
 * - id 只认 `inst-<16hex>`（旧 `local` 一律拒绝，不是实例）；
 * - mode 只认六种精确枚举（未知不回落 lan，避免把错值悄悄变成可用配置）；
 * - url 必须显式 http(s)、经 `normalizeRemoteUrl` 通过；query 里的 token/k 被抽到 `token` 字段，
 *   `url` 永远是不含 token 的 base；
 * - name：字段缺失 → 默认远程名；显式非字符串 / trim 后空串 → `E_INSTANCE_NAME` 拒绝。
 */
export function normalizeInstance(raw: RawInstance | null | undefined): InstanceNormalizeResult {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return refused('E_INSTANCE_SHAPE');
  }
  const id: string = readText(raw.id);
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return refused('E_INSTANCE_ID');
  }
  const mode: string = readText(raw.mode);
  if (mode.length === 0 || findRemoteMode(mode) === null) {
    return refused('E_INSTANCE_MODE');
  }
  const rawUrl: string = readText(raw.url);
  if (rawUrl.length === 0) {
    return refused('E_INSTANCE_URL');
  }
  const check = normalizeRemoteUrl(rawUrl);
  if (!check.ok || !check.hadScheme) {
    return refused('E_INSTANCE_URL');
  }
  // 与 instanceIdFromUrl 用同一条「剥 fragment」规则：带 #token= 的地址与干净地址
  // 落盘成同一个 base，id 相等，且明文 token 永不进持久 url（P2-1）
  const url: string = stripUrlFragment(stripRemoteToken(check.url));
  if (url.length === 0) {
    return refused('E_INSTANCE_URL');
  }
  const hasName: boolean = raw.name !== undefined && raw.name !== null;
  const name: string = hasName ? readText(raw.name as LooseValue) : DEFAULT_REMOTE_NAME;
  if (hasName && name.length === 0) {
    return refused('E_INSTANCE_NAME');
  }
  const urlToken: string = findUrlToken(rawUrl);
  const rawToken: string = readText(raw.token);
  const token: string = rawToken.length > 0 ? rawToken : urlToken;
  const instance: DsInstance = {
    id: id,
    name: name,
    url: url,
    mode: mode,
    reachable: normalizeReachable(raw.reachable),
    capabilities: deriveCapabilities(id)
  };
  if (token.length > 0) {
    instance.token = token;
  }
  if (typeof raw.lastSeen === 'number' && Number.isFinite(raw.lastSeen) && raw.lastSeen > 0) {
    instance.lastSeen = Math.trunc(raw.lastSeen);
  }
  return accepted(instance);
}

/** URL 打码：先走 `remoteUrl` 的唯一展示口径，再做整串兜底（fragment 等）。 */
export function redactUrl(url: string): string {
  const text: string = readText(url);
  if (text.length === 0) {
    return '';
  }
  return maskTokenPairs(sanitizeUrlForDisplay(text));
}

/**
 * 渲染 / 导出唯一视图：**没有 token 字段**，只有 `tokenSet`；URL 也过打码。
 * 脏入参返回空视图而不是抛错（调用方可能在 UI 渲染路径上）。
 */
export function redactInstance(inst: DsInstance | null | undefined): RedactedInstance {
  const emptyCapabilities: InstanceCapabilities = deriveCapabilities('');
  if (inst === null || inst === undefined) {
    const empty: RedactedInstance = {
      id: '',
      name: '',
      url: '',
      mode: '',
      tokenSet: false,
      reachable: 'unknown',
      capabilities: emptyCapabilities
    };
    return empty;
  }
  const view: RedactedInstance = {
    id: inst.id,
    name: inst.name,
    url: redactUrl(inst.url),
    mode: inst.mode,
    tokenSet: inst.token !== undefined && inst.token.length > 0,
    reachable: inst.reachable,
    capabilities: copyCapabilities(inst.capabilities)
  };
  if (inst.lastSeen !== undefined && inst.lastSeen > 0) {
    view.lastSeen = inst.lastSeen;
  }
  return view;
}

/** 确定性排序：全部是远程行，按 name 再按 id 兜底，不用 localeCompare 免得随系统 locale 变。 */
export function sortInstances(list: DsInstance[]): DsInstance[] {
  const sorted: DsInstance[] = list.slice();
  sorted.sort((a: DsInstance, b: DsInstance): number => {
    if (a.name < b.name) {
      return -1;
    }
    if (a.name > b.name) {
      return 1;
    }
    if (a.id < b.id) {
      return -1;
    }
    if (a.id > b.id) {
      return 1;
    }
    return 0;
  });
  return sorted;
}

/**
 * 插入或按 id 替换；坏实例直接忽略（不抛错）。返回新数组且已排序。
 * 同 id 视为「更新」，不会生成第二条记录。
 */
export function upsertInstance(list: DsInstance[], inst: DsInstance): DsInstance[] {
  const normalized: InstanceNormalizeResult = normalizeInstance(inst);
  if (!normalized.ok || normalized.instance === null) {
    return sortInstances(list);
  }
  const next: DsInstance[] = [];
  let replaced: boolean = false;
  for (const item of list) {
    if (item.id === normalized.instance.id) {
      next.push(normalized.instance);
      replaced = true;
    } else {
      next.push(item);
    }
  }
  if (!replaced) {
    next.push(normalized.instance);
  }
  return sortInstances(next);
}

/** 删除任意一行（没有受保护的本机行）；按 id 精确匹配，返回排序后的新数组。 */
export function removeInstance(list: DsInstance[], id: string): DsInstance[] {
  const next: DsInstance[] = [];
  for (const item of list) {
    if (item.id !== id) {
      next.push(item);
    }
  }
  return sortInstances(next);
}

/** 按 id 精确查找；没有就返回 null。 */
export function findInstance(list: DsInstance[], id: string): DsInstance | null {
  for (const item of list) {
    if (item.id === id) {
      return item;
    }
  }
  return null;
}

/**
 * 可达性更新（store 的 `markReachable` 直接调它，纯函数便于 Node 单测）。
 * 只有 `ok` 才推进 `lastSeen`（「上次成功」语义）；`fail` 保留旧值；未知状态 / 不存在 id 不改表。
 */
export function applyReachability(
  list: DsInstance[],
  id: string,
  status: string,
  nowMs: number
): DsInstance[] {
  if (status !== 'ok' && status !== 'fail') {
    return list.slice();
  }
  if (findInstance(list, id) === null) {
    return list.slice();
  }
  const validNow: boolean =
    typeof nowMs === 'number' && Number.isFinite(nowMs) && nowMs > 0;
  const next: DsInstance[] = [];
  for (const item of list) {
    if (item.id === id) {
      const updated: DsInstance = {
        id: item.id,
        name: item.name,
        url: item.url,
        mode: item.mode,
        reachable: status,
        capabilities: copyCapabilities(item.capabilities)
      };
      if (item.token !== undefined && item.token.length > 0) {
        updated.token = item.token;
      }
      if (status === 'ok' && validNow) {
        updated.lastSeen = Math.trunc(nowMs);
      } else if (item.lastSeen !== undefined && item.lastSeen > 0) {
        updated.lastSeen = item.lastSeen;
      }
      next.push(updated);
    } else {
      next.push(item);
    }
  }
  return next;
}

/** 信封里的一条记录（**没有 capabilities**；派生字段每次加载重算）。 */
interface EnvelopeItem {
  id: string;
  name: string;
  url: string;
  mode: string;
  token?: string;
  lastSeen?: number;
  reachable: Reachability;
}

/** 版本化信封：`{v:1, items:[...]}`，整串一次性写入 = 原子替换。 */
interface InstanceEnvelope {
  v: number;
  items: EnvelopeItem[];
}

/** 序列化整表（固定键顺序；token 只在信封内部出现，从来不被日志打印）。 */
export function encodeInstances(list: DsInstance[]): string {
  const items: EnvelopeItem[] = [];
  for (const inst of list) {
    const item: EnvelopeItem = {
      id: inst.id,
      name: inst.name,
      url: inst.url,
      mode: inst.mode,
      reachable: inst.reachable
    };
    if (inst.token !== undefined && inst.token.length > 0) {
      item.token = inst.token;
    }
    if (inst.lastSeen !== undefined && inst.lastSeen > 0) {
      item.lastSeen = inst.lastSeen;
    }
    items.push(item);
  }
  const envelope: InstanceEnvelope = { v: INSTANCE_ENVELOPE_VERSION, items: items };
  return JSON.stringify(envelope);
}

/**
 * 只识别旧信封里的 `local` 占位行：纯字面量比较，不是可创建的本机实例模型。
 * 产品已删除本机实例，这类行只作为历史遗留数据出现在持久化字符串里。
 */
function isLegacyLocalItem(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const item = raw as RawInstance;
  return typeof item.id === 'string' && item.id.trim() === LEGACY_LOCAL_ID;
}

/**
 * 反序列化整表：空串 / 坏 JSON / 结构错 / 版本错 / 任一记录坏 → 空表 + typed reason，
 * 绝不抛异常（这条路径在 UI 启动时跑）。成功时按 `sortInstances` 给确定性顺序。
 *
 * 遗留数据兼容（读取时过滤，不做迁移）：旧版本可能把一条 `id:'local'` 的本机占位行写进信封。
 * 这里读取时**只丢弃这一行**——不复活、不重编码落盘、不影响同一信封里的其它远程行，
 * 也不让这条历史行把整表判成损坏（`E_ENVELOPE_ITEM`）。选择「过滤」而非「迁移」是因为
 * 本机实例已从产品里删除，没有可迁移的目标；远程行保持逐字不动。
 */
export function decodeInstances(raw: string | null | undefined): InstanceDecodeResult {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return decodeFailed('E_ENVELOPE_EMPTY');
  }
  let parsed: InstanceEnvelope | null = null;
  try {
    parsed = JSON.parse(text) as InstanceEnvelope;
  } catch {
    return decodeFailed('E_ENVELOPE_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return decodeFailed('E_ENVELOPE_SHAPE');
  }
  if (typeof parsed.v !== 'number' || !Number.isFinite(parsed.v)) {
    return decodeFailed('E_ENVELOPE_SHAPE');
  }
  if (parsed.v !== INSTANCE_ENVELOPE_VERSION) {
    return decodeFailed('E_ENVELOPE_VERSION');
  }
  if (!Array.isArray(parsed.items)) {
    return decodeFailed('E_ENVELOPE_SHAPE');
  }
  const items: DsInstance[] = [];
  for (const rawItem of parsed.items) {
    if (isLegacyLocalItem(rawItem)) {
      continue;
    }
    const result: InstanceNormalizeResult = normalizeInstance(rawItem as RawInstance);
    if (!result.ok || result.instance === null) {
      return decodeFailed('E_ENVELOPE_ITEM');
    }
    items.push(result.instance);
  }
  const okResult: InstanceDecodeResult = {
    ok: true,
    items: sortInstances(items),
    problem: 'ok',
    reason: ''
  };
  return okResult;
}
