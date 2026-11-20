/**
 * dots 按实例 / 按工具授权模型 —— 纯逻辑，零 SDK import，Node 可直接单测。
 *
 * 契约：`docs/CLOUD-CHAT-AND-DOTS.md` §4（权限模型：按实例、按工具、可吊销，principal 固定 dots，
 * view 权与 command 权**分开授予**）、§1（dots 不能自授权 / 不能拿令牌）、§7（跨实例泄漏）；
 * `docs/REMOTE-INSTANCES.md` §2/§4（grantKey = (instanceId, principal)，过期 / 吊销降只读、
 * fail-closed 不换令牌重试）、`docs/REVIEW-remote-security.md` §2（凭据唯一出口）。
 *
 * 六条不变式：
 * 1. **grantKey = (instanceId, principal)**：同一实例同一 principal 只有一条 grant；upsert 按键替换，
 *    不做「一个实例多条并存」的隐式并集。principal 只有 `dots`，与设备 principal 区分。
 * 2. **view 权永不隐含 command 权**：`session.prompt` 是唯一的命令工具，必须在 `tools` 里**显式列出**
 *    才生效；纯 view grant 的 `isGranted(..., 'session.prompt')` 恒 false。本模型没有任何
 *    从 view 工具推导 / 合并出命令工具的路径（§4「只给 view 时发送按钮禁用」的编码保证）。
 * 3. **per-instance 隔离**：`isGranted` / `grantedTools` 只匹配精确 instanceId；A 的 grant 永不授权 B。
 * 4. **fail-closed 时间语义**：仅在 `grantedAt <= t < (revokedAt|expiresAt)` 时有效；未生效、
 *    已吊销、已过期、时间非法均不授权；吊销后不自动续期、不换令牌重试。
 * 5. **typed 拒绝，不抛异常**：未知工具 / 空工具 / 未知 principal / 坏 instanceId 形状都返回 typed
 *    problem + 中文 reason；坏信封整表回落空表（与 `model/instances.ts` 同纪律）。
 * 6. **零凭据**：本模型与对应 store **没有任何令牌字段**，也没有日志调用；渲染视图 `RedactedGrant`
 *    结构上不带自由文本 `note`，只给派生的 `active` / `canPrompt`。
 */

import { INSTANCE_ID_PATTERN } from './instances';

/** dots 的唯一 principal（与设备 principal 区分）。 */
export const PRINCIPAL_DOTS: string = 'dots';

/** 工具 id：一个 view / inspect 类。 */
export type GrantTool =
  | 'instance.list'
  | 'instance.inspect'
  | 'session.list'
  | 'session.read'
  | 'session.prompt';

export const TOOL_INSTANCE_LIST: GrantTool = 'instance.list';
export const TOOL_INSTANCE_INSPECT: GrantTool = 'instance.inspect';
export const TOOL_SESSION_LIST: GrantTool = 'session.list';
export const TOOL_SESSION_READ: GrantTool = 'session.read';
/** 唯一的有副作用工具：必须显式授予，view 工具永不隐含它。 */
export const TOOL_SESSION_PROMPT: GrantTool = 'session.prompt';

/** 只读 / 查看类工具（§4 的 view 子集）。 */
export const VIEW_TOOLS: GrantTool[] = [
  TOOL_INSTANCE_LIST,
  TOOL_INSTANCE_INSPECT,
  TOOL_SESSION_LIST,
  TOOL_SESSION_READ
];

/** 命令类工具（§4 的 command 子集，当前只有 session.prompt）。 */
export const COMMAND_TOOLS: GrantTool[] = [TOOL_SESSION_PROMPT];

/** 全部合法工具，顺序即规范化 canonical 顺序（确定性信封用）。 */
export const ALL_GRANT_TOOLS: GrantTool[] = [
  TOOL_INSTANCE_LIST,
  TOOL_INSTANCE_INSPECT,
  TOOL_SESSION_LIST,
  TOOL_SESSION_READ,
  TOOL_SESSION_PROMPT
];

/** 持久化信封版本（只认 1，未来版本 typed 拒绝，不静默迁移）。 */
export const GRANT_ENVELOPE_VERSION: number = 1;

/** 未授权 / 损坏时的空 tools（返回新数组，避免调用方改到共享常量）。 */
export function emptyTools(): GrantTool[] {
  return [];
}

/** 是否已知工具（严格精确匹配，不做大小写 / 别名容错）。 */
export function isKnownTool(raw: string): boolean {
  if (typeof raw !== 'string') {
    return false;
  }
  return ALL_GRANT_TOOLS.indexOf(raw as GrantTool) >= 0;
}

/** 是否 view 工具。 */
export function isViewTool(raw: string): boolean {
  if (typeof raw !== 'string') {
    return false;
  }
  return VIEW_TOOLS.indexOf(raw as GrantTool) >= 0;
}

/** 是否命令工具（session.prompt）。 */
export function isCommandTool(raw: string): boolean {
  if (typeof raw !== 'string') {
    return false;
  }
  return COMMAND_TOOLS.indexOf(raw as GrantTool) >= 0;
}

/** typed 问题码：模型拒绝 / 信封损坏 / 存储不可用共用一套，UI 用 problemText 转中文。 */
export type GrantProblem =
  | 'ok'
  | 'E_GRANT_SHAPE'
  | 'E_GRANT_ID'
  | 'E_GRANT_INSTANCE_ID'
  | 'E_GRANT_PRINCIPAL'
  | 'E_GRANT_TOOLS_SHAPE'
  | 'E_GRANT_TOOLS_EMPTY'
  | 'E_GRANT_TOOL_UNKNOWN'
  | 'E_GRANT_GRANTED_AT'
  | 'E_GRANT_REVOKED_AT'
  | 'E_GRANT_EXPIRES_AT'
  | 'E_GRANT_ENVELOPE_EMPTY'
  | 'E_GRANT_ENVELOPE_JSON'
  | 'E_GRANT_ENVELOPE_SHAPE'
  | 'E_GRANT_ENVELOPE_VERSION'
  | 'E_GRANT_ENVELOPE_ITEM'
  | 'E_GRANT_STORAGE_UNAVAILABLE';

/** 一条授权记录。`principal` 字面量固定 dots；可选字段只在真有值时落盘。 */
export interface InstanceGrant {
  /** 授权 id（调用方生成，唯一标识一条授权）。 */
  grantId: string;
  /** 目标实例 id：`local` 或 `inst-<16hex>`（与实例表同一形状）。 */
  instanceId: string;
  /** 只能是 `dots`。 */
  principal: 'dots';
  /** 显式授予的工具集合；命令工具必须在这里出现才生效。 */
  tools: GrantTool[];
  /** 授权生效的毫秒时间戳（必须为正有限数）。 */
  grantedAt: number;
  /** 吊销时刻；`t >= revokedAt` 起失效（§4 的可吊销）。 */
  revokedAt?: number;
  /** 到期时刻；`t >= expiresAt` 起失效（§4 的 expiresAt）。 */
  expiresAt?: number;
  /** 人写备注（自由文本，redacted 视图会剥掉）。 */
  note?: string;
}

/** 反序列化输入；逐字段 typed 校验，坏值不抛异常。 */
export interface RawGrant {
  grantId?: LooseValue;
  instanceId?: LooseValue;
  principal?: LooseValue;
  tools?: LooseValue;
  grantedAt?: LooseValue;
  revokedAt?: LooseValue;
  expiresAt?: LooseValue;
  note?: LooseValue;
}

/** 运行时宽松读取（脏 JSON 的数字 / null / 数组不能让归一抛错）。 */
type LooseValue = string | number | boolean | null | undefined | object;

/** 归一结果：`ok=false` 时 `grant=null` + typed problem + 中文 reason。 */
export interface GrantNormalizeResult {
  ok: boolean;
  grant: InstanceGrant | null;
  problem: GrantProblem;
  reason: string;
}

/** 信封解码结果：失败时 `items=[]` + typed problem（供 UI 显示，不抛异常）。 */
export interface GrantDecodeResult {
  ok: boolean;
  items: InstanceGrant[];
  problem: GrantProblem;
  reason: string;
}

/** 渲染 / 导出唯一视图：无自由文本 note，带派生的 active / canPrompt。 */
export interface RedactedGrant {
  grantId: string;
  instanceId: string;
  principal: 'dots';
  tools: GrantTool[];
  grantedAt: number;
  revokedAt?: number;
  expiresAt?: number;
  /** 当前时刻是否处于有效期内（派生，不落盘）。 */
  active: boolean;
  /** 是否显式授予命令工具（派生；view 永不使其为 true）。 */
  canPrompt: boolean;
}

/** typed 码 → 可直接上屏的中文原因（原因不带任何凭据值）。 */
export function problemText(problem: GrantProblem): string {
  switch (problem) {
    case 'E_GRANT_SHAPE':
      return '授权数据不是对象';
    case 'E_GRANT_ID':
      return '授权 id 不能为空';
    case 'E_GRANT_INSTANCE_ID':
      return '实例 id 只能是 local 或 inst- 加 16 位十六进制';
    case 'E_GRANT_PRINCIPAL':
      return '授权对象只能是 dots';
    case 'E_GRANT_TOOLS_SHAPE':
      return '授权工具列表必须是数组';
    case 'E_GRANT_TOOLS_EMPTY':
      return '授权工具列表不能为空';
    case 'E_GRANT_TOOL_UNKNOWN':
      return '授权工具不在允许的工具集合内';
    case 'E_GRANT_GRANTED_AT':
      return '授权生效时间必须是正整数时间戳';
    case 'E_GRANT_REVOKED_AT':
      return '授权吊销时间必须是正整数时间戳';
    case 'E_GRANT_EXPIRES_AT':
      return '授权到期时间必须是正整数时间戳';
    case 'E_GRANT_ENVELOPE_EMPTY':
      return '还没有保存过 dots 授权';
    case 'E_GRANT_ENVELOPE_JSON':
      return '授权表 JSON 损坏，已回落空表';
    case 'E_GRANT_ENVELOPE_SHAPE':
      return '授权表结构不正确，已回落空表';
    case 'E_GRANT_ENVELOPE_VERSION':
      return '授权表版本不认识，已回落空表';
    case 'E_GRANT_ENVELOPE_ITEM':
      return '授权表中有损坏的记录，已回落空表';
    case 'E_GRANT_STORAGE_UNAVAILABLE':
      return '本地存储不可用，授权表只在本次运行内有效';
    default:
      return '';
  }
}

/** 只接受字符串，去首尾空白；其余类型按空串。 */
function readText(value: LooseValue): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 严格正有限数（时间字段的 fail-closed 判据）；小数由调用方按需取整。 */
function validTime(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 内部：拒绝结果。 */
function refused(problem: GrantProblem): GrantNormalizeResult {
  const result: GrantNormalizeResult = {
    ok: false,
    grant: null,
    problem: problem,
    reason: problemText(problem)
  };
  return result;
}

/** 内部：成功结果。 */
function accepted(grant: InstanceGrant): GrantNormalizeResult {
  const result: GrantNormalizeResult = {
    ok: true,
    grant: grant,
    problem: 'ok',
    reason: ''
  };
  return result;
}

/** 内部：解码失败结果（永远带空表）。 */
function decodeFailed(problem: GrantProblem): GrantDecodeResult {
  const result: GrantDecodeResult = {
    ok: false,
    items: [],
    problem: problem,
    reason: problemText(problem)
  };
  return result;
}

/** canonical 化工具：去重 + 按合法工具顺序排序，未知工具直接丢弃（fail-closed）。 */
export function canonicalTools(tools: GrantTool[]): GrantTool[] {
  const out: GrantTool[] = [];
  for (const tool of ALL_GRANT_TOOLS) {
    if (tools.indexOf(tool) >= 0) {
      out.push(tool);
    }
  }
  return out;
}

/** grantKey 的唯一构造点（`instanceId|principal`，两者都不含 `|`）。 */
export function makeGrantKey(instanceId: string, principal: string): string {
  return `${instanceId}|${principal}`;
}

/** §4 的 grantKey = (instanceId, principal)。 */
export function grantKey(g: InstanceGrant): string {
  return makeGrantKey(g.instanceId, g.principal);
}

/** 深拷贝一条授权（canonical 工具顺序；不共享可变数组给调用方）。 */
function copyGrant(g: InstanceGrant): InstanceGrant {
  const copy: InstanceGrant = {
    grantId: g.grantId,
    instanceId: g.instanceId,
    principal: g.principal,
    tools: canonicalTools(g.tools),
    grantedAt: g.grantedAt
  };
  if (g.revokedAt !== undefined) {
    copy.revokedAt = g.revokedAt;
  }
  if (g.expiresAt !== undefined) {
    copy.expiresAt = g.expiresAt;
  }
  if (g.note !== undefined) {
    copy.note = g.note;
  }
  return copy;
}

/**
 * 校验并归一一条授权（**不抛异常**）。
 *
 * 判定顺序：对象形状 → grantId → instanceId → principal → tools（数组 / 非空 / 全已知） →
 * grantedAt → revokedAt? → expiresAt?。工具按 canonical 顺序去重排序，保证同输入逐字节同输出。
 */
export function normalizeGrant(raw: RawGrant | null | undefined): GrantNormalizeResult {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return refused('E_GRANT_SHAPE');
  }
  const grantId: string = readText(raw.grantId);
  if (grantId.length === 0) {
    return refused('E_GRANT_ID');
  }
  const instanceId: string = readText(raw.instanceId);
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    return refused('E_GRANT_INSTANCE_ID');
  }
  const principal: string = readText(raw.principal);
  if (principal !== PRINCIPAL_DOTS) {
    return refused('E_GRANT_PRINCIPAL');
  }
  if (!Array.isArray(raw.tools)) {
    return refused('E_GRANT_TOOLS_SHAPE');
  }
  const rawTools: LooseValue[] = raw.tools as LooseValue[];
  if (rawTools.length === 0) {
    return refused('E_GRANT_TOOLS_EMPTY');
  }
  const tools: GrantTool[] = [];
  for (const item of rawTools) {
    const tool: string = readText(item);
    if (!isKnownTool(tool)) {
      return refused('E_GRANT_TOOL_UNKNOWN');
    }
    tools.push(tool as GrantTool);
  }
  const grantedAt: number = typeof raw.grantedAt === 'number' ? raw.grantedAt : NaN;
  if (!validTime(grantedAt)) {
    return refused('E_GRANT_GRANTED_AT');
  }
  const grant: InstanceGrant = {
    grantId: grantId,
    instanceId: instanceId,
    principal: 'dots',
    tools: canonicalTools(tools),
    grantedAt: Math.trunc(grantedAt)
  };
  if (raw.revokedAt !== undefined && raw.revokedAt !== null) {
    const revokedAt: number = typeof raw.revokedAt === 'number' ? raw.revokedAt : NaN;
    if (!validTime(revokedAt)) {
      return refused('E_GRANT_REVOKED_AT');
    }
    grant.revokedAt = Math.trunc(revokedAt);
  }
  if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
    const expiresAt: number = typeof raw.expiresAt === 'number' ? raw.expiresAt : NaN;
    if (!validTime(expiresAt)) {
      return refused('E_GRANT_EXPIRES_AT');
    }
    grant.expiresAt = Math.trunc(expiresAt);
  }
  const note: string = readText(raw.note);
  if (note.length > 0) {
    grant.note = note;
  }
  return accepted(grant);
}

/** 一条授权在时刻 t 是否处于有效期内（未生效 / 已吊销 / 已过期 / 时间非法均 false）。 */
export function grantActive(g: InstanceGrant, nowMs: number): boolean {
  if (!validTime(nowMs)) {
    return false;
  }
  if (g.principal !== PRINCIPAL_DOTS) {
    return false;
  }
  if (!validTime(g.grantedAt) || nowMs < g.grantedAt) {
    return false;
  }
  if (g.revokedAt !== undefined && nowMs >= g.revokedAt) {
    return false;
  }
  if (g.expiresAt !== undefined && nowMs >= g.expiresAt) {
    return false;
  }
  return true;
}

/**
 * 精确实例 + 精确工具 + 有效期内才授权。
 *
 * 命令工具没有特殊通道：它和普通工具一样必须出现在 `tools` 里；view 工具绝不会在这里
 * 推导出 `session.prompt`（§4 hard rule）。未知工具 / 非法 nowMs 一律 false。
 */
export function isGranted(
  grants: InstanceGrant[],
  instanceId: string,
  tool: GrantTool | string,
  nowMs: number
): boolean {
  if (!isKnownTool(tool) || !validTime(nowMs)) {
    return false;
  }
  const wanted: GrantTool = tool as GrantTool;
  for (const g of grants) {
    if (g.instanceId !== instanceId) {
      continue;
    }
    if (!grantActive(g, nowMs)) {
      continue;
    }
    if (g.tools.indexOf(wanted) >= 0) {
      return true;
    }
  }
  return false;
}

/** 该实例当前有效的工具并集（canonical 顺序）；不补入任何未显式授予的工具。 */
export function grantedTools(grants: InstanceGrant[], instanceId: string, nowMs: number): GrantTool[] {
  const found: GrantTool[] = [];
  for (const g of grants) {
    if (g.instanceId !== instanceId || !grantActive(g, nowMs)) {
      continue;
    }
    for (const tool of g.tools) {
      if (found.indexOf(tool) < 0) {
        found.push(tool);
      }
    }
  }
  return canonicalTools(found);
}

/** 是否显式授予命令工具（供「发送按钮禁用」消费，view grant 恒 false）。 */
export function canPrompt(grants: InstanceGrant[], instanceId: string, nowMs: number): boolean {
  return isGranted(grants, instanceId, TOOL_SESSION_PROMPT, nowMs);
}

/** 按 grantId 精确查找；没有就返回 null。 */
export function findGrant(grants: InstanceGrant[], grantId: string): InstanceGrant | null {
  for (const g of grants) {
    if (g.grantId === grantId) {
      return g;
    }
  }
  return null;
}

/** 确定性排序：按 grantKey（再按 grantId），不用 localeCompare 免得随系统 locale 变。 */
export function sortGrants(list: InstanceGrant[]): InstanceGrant[] {
  const sorted: InstanceGrant[] = list.slice();
  sorted.sort((a: InstanceGrant, b: InstanceGrant): number => {
    const keyA: string = grantKey(a);
    const keyB: string = grantKey(b);
    if (keyA < keyB) {
      return -1;
    }
    if (keyA > keyB) {
      return 1;
    }
    if (a.grantId < b.grantId) {
      return -1;
    }
    if (a.grantId > b.grantId) {
      return 1;
    }
    return 0;
  });
  return sorted;
}

/**
 * 插入或按 grantKey 替换（同一实例同一 principal 只有一条）；坏授权直接忽略（不抛错）。
 * 返回新数组且已排序，入参不被修改。
 */
export function upsertGrant(grants: InstanceGrant[], grant: InstanceGrant): InstanceGrant[] {
  const normalized: GrantNormalizeResult = normalizeGrant(grant);
  if (!normalized.ok || normalized.grant === null) {
    const kept: InstanceGrant[] = [];
    for (const g of grants) {
      kept.push(copyGrant(g));
    }
    return sortGrants(kept);
  }
  const key: string = grantKey(normalized.grant);
  const next: InstanceGrant[] = [];
  let replaced: boolean = false;
  for (const g of grants) {
    if (grantKey(g) === key) {
      next.push(normalized.grant);
      replaced = true;
    } else {
      next.push(copyGrant(g));
    }
  }
  if (!replaced) {
    next.push(normalized.grant);
  }
  return sortGrants(next);
}

/**
 * 吊销：按 grantId 找到并写 revokedAt = nowMs；已是吊销态保留**更早**的 revokedAt
 * （重复吊销不延长授权窗口，fail-closed）；找不到 grantId 则原样返回副本。
 */
export function revokeGrant(grants: InstanceGrant[], grantId: string, nowMs: number): InstanceGrant[] {
  if (findGrant(grants, grantId) === null) {
    return grants.slice();
  }
  const at: number = validTime(nowMs) ? Math.trunc(nowMs) : 0;
  const next: InstanceGrant[] = [];
  for (const g of grants) {
    if (g.grantId === grantId) {
      const revoked: InstanceGrant = copyGrant(g);
      const current: number | undefined = g.revokedAt;
      if (current !== undefined) {
        revoked.revokedAt = Math.min(current, at);
      } else {
        revoked.revokedAt = at;
      }
      next.push(revoked);
    } else {
      next.push(copyGrant(g));
    }
  }
  return sortGrants(next);
}

/** 渲染 / 导出视图：剥掉自由文本 note，只给派生 active / canPrompt（不落盘）。 */
export function redactGrant(g: InstanceGrant, nowMs: number): RedactedGrant {
  const view: RedactedGrant = {
    grantId: g.grantId,
    instanceId: g.instanceId,
    principal: 'dots',
    tools: canonicalTools(g.tools),
    grantedAt: g.grantedAt,
    active: grantActive(g, nowMs),
    canPrompt: isGranted([g], g.instanceId, TOOL_SESSION_PROMPT, nowMs)
  };
  if (g.revokedAt !== undefined) {
    view.revokedAt = g.revokedAt;
  }
  if (g.expiresAt !== undefined) {
    view.expiresAt = g.expiresAt;
  }
  return view;
}

/** 版本化信封里的单条记录（没有派生字段；与主对象同形）。 */
type EnvelopeItem = InstanceGrant;

/** 版本化信封：`{v:1, items:[...]}`，整串一次性写入 = 原子替换。 */
interface GrantEnvelope {
  v: number;
  items: EnvelopeItem[];
}

/** 序列化整表（固定键顺序；无任何凭据字段，也从不打日志）。 */
export function encodeGrants(list: InstanceGrant[]): string {
  const items: EnvelopeItem[] = [];
  for (const g of sortGrants(list)) {
    items.push(copyGrant(g));
  }
  const envelope: GrantEnvelope = { v: GRANT_ENVELOPE_VERSION, items: items };
  return JSON.stringify(envelope);
}

/**
 * 反序列化整表：空串 / 坏 JSON / 结构错 / 版本错 / 任一记录坏 → 空表 + typed reason，
 * 绝不抛异常（这条路径在 UI 启动时跑）。成功时按 `sortGrants` 给确定性顺序。
 */
export function decodeGrants(raw: string | null | undefined): GrantDecodeResult {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return decodeFailed('E_GRANT_ENVELOPE_EMPTY');
  }
  let parsed: GrantEnvelope | null = null;
  try {
    parsed = JSON.parse(text) as GrantEnvelope;
  } catch {
    return decodeFailed('E_GRANT_ENVELOPE_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return decodeFailed('E_GRANT_ENVELOPE_SHAPE');
  }
  if (typeof parsed.v !== 'number' || !Number.isFinite(parsed.v)) {
    return decodeFailed('E_GRANT_ENVELOPE_SHAPE');
  }
  if (parsed.v !== GRANT_ENVELOPE_VERSION) {
    return decodeFailed('E_GRANT_ENVELOPE_VERSION');
  }
  if (!Array.isArray(parsed.items)) {
    return decodeFailed('E_GRANT_ENVELOPE_SHAPE');
  }
  const rawItems: LooseValue[] = parsed.items as LooseValue[];
  const items: InstanceGrant[] = [];
  for (const rawItem of rawItems) {
    const result: GrantNormalizeResult = normalizeGrant(rawItem as RawGrant);
    if (!result.ok || result.grant === null) {
      return decodeFailed('E_GRANT_ENVELOPE_ITEM');
    }
    items.push(result.grant);
  }
  const okResult: GrantDecodeResult = {
    ok: true,
    items: sortGrants(items),
    problem: 'ok',
    reason: ''
  };
  return okResult;
}
