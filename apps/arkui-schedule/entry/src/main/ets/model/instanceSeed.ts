/**
 * 实例列表「播种 + 迁移 + 行展示」纯逻辑（模块 `mod-instance-list`，零 SDK import）。
 *
 * 为什么单独一层：`services/instanceStore.ets` 用 `PersistentStorage`/`AppStorage`，
 * Node 单测加载不了；把可判定的部分放进纯模型，UI 与 store 只做接线。
 *
 * 产品决定（`mod-instances-drop-local`）：平板不跑原生 DSH，**没有本机实例**；播种只把旧配置里的
 * 远程地址落成远程行，空表 + 「添加实例」是正常首用状态，绝不补本机占位行。
 *
 * 两条纪律：
 * 1. **幂等**：旧地址 id 已存在就跳过（不覆盖用户后来改的 name / lastSeen），
 *    第二次启动不会多出第二条；
 * 2. **旧地址必须先归一**：`normalizeRemoteUrl(raw).url` 才交给 `instanceIdFromUrl()` /
 *    `normalizeInstance()`——后者拒绝 `hadScheme === false`，只有前者会给裸 host 补 `http://`。
 *    token 由 `normalizeInstance()` 从 query 抽进 `token` 字段，`url` 永远不含明文。
 */

import { REMOTE_MODE_MANUAL, findRemoteMode } from './remoteAccess';
import {
  findInstance,
  instanceIdFromUrl,
  normalizeInstance,
  sortInstances,
  upsertInstance
} from './instances';
import type { DsInstance, RawInstance, Reachability } from './instances';
import { decodeLastOk, normalizeRemoteUrl } from './remoteUrl';

/** 从 `settingsStore` 投影过来的三个旧字段（只读快照，不回写旧配置）。 */
export interface LegacyInstanceSettings {
  /** 旧「远程控制地址」；可能带 `?token=`，也可能是裸 host（无协议）。 */
  remoteUrl: string;
  /** 旧「最近一次成功」单行 JSON `{"url":…,"at":…}`。 */
  remoteLastOk: string;
  /** 旧访问方式（非法 / 空一律回落到 `manual`）。 */
  remoteMode?: string;
  /**
   * 旧「访问令牌（可选）」明文（mod-settings-remote-dedupe）。
   *
   * 它常与 `remoteUrl` 分开存放，所以必须显式带进实例行，否则「地址迁过来了、令牌没了」。
   * 只写进实例的 `token` 字段，绝不拼进 `url`；settingsStore 里的旧键仍原样可读（不删除）。
   */
  remoteToken?: string;
}

/** 相对时间分档（毫秒）：1 分钟 / 1 小时 / 1 天。 */
const MINUTE_MS: number = 60 * 1000;
const HOUR_MS: number = 60 * MINUTE_MS;
const DAY_MS: number = 24 * HOUR_MS;

/** 只接受有限正数时间戳（毫秒）；坏值一律 0 = 没有时间。 */
function validTime(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 旧地址来源：优先 `remoteUrl`，空了才用「最近成功」里的地址。 */
function legacyUrl(legacy: LegacyInstanceSettings | null | undefined): string {
  if (legacy === null || legacy === undefined) {
    return '';
  }
  const primary: string = typeof legacy.remoteUrl === 'string' ? legacy.remoteUrl.trim() : '';
  if (primary.length > 0) {
    return primary;
  }
  const lastOk = decodeLastOk(typeof legacy.remoteLastOk === 'string' ? legacy.remoteLastOk : '');
  return lastOk === null ? '' : lastOk.url.trim();
}

/** 旧地址的时间戳：只取「最近成功」的 `at`，脏值 = 0（不写 lastSeen）。 */
function legacyLastSeen(legacy: LegacyInstanceSettings | null | undefined): number {
  if (legacy === null || legacy === undefined) {
    return 0;
  }
  const lastOk = decodeLastOk(typeof legacy.remoteLastOk === 'string' ? legacy.remoteLastOk : '');
  return lastOk === null ? 0 : validTime(lastOk.at);
}

/** 旧访问方式：能查到六种精确枚举就用，否则回 `manual`（旧地址本就是手填的完整地址）。 */
function legacyMode(legacy: LegacyInstanceSettings | null | undefined): string {
  const raw: string = legacy === null || legacy === undefined ? '' : (legacy.remoteMode ?? '');
  const spec = findRemoteMode(typeof raw === 'string' ? raw : '');
  return spec === null ? REMOTE_MODE_MANUAL : spec.mode;
}

/**
 * 首次加载时播种：只把旧 `remoteUrl` / `remoteLastOk` 落成一条远程实例，**不补本机行**。
 *
 * 幂等判定按 id：`inst-<sha16(归一 url)>`；同 id 已存在就不再 upsert，所以第二次启动
 * 既不重复、也不会用旧快照覆盖用户改过的名字 / 可达状态。旧配置为空时直接返回原表（通常为空）。
 */
export function seedInstances(
  current: DsInstance[] | null | undefined,
  legacy: LegacyInstanceSettings | null | undefined
): DsInstance[] {
  const list: DsInstance[] = Array.isArray(current) ? current.slice() : [];
  const raw: string = legacyUrl(legacy);
  if (raw.length === 0) {
    return sortInstances(list);
  }
  const check = normalizeRemoteUrl(raw);
  if (!check.ok) {
    return sortInstances(list);
  }
  // 关键：传归一后的 check.url（已补 http://），绝不把 raw 直接喂给实例模型
  const id: string = instanceIdFromUrl(check.url);
  if (id.length === 0 || findInstance(list, id) !== null) {
    return sortInstances(list);
  }
  const candidate: RawInstance = {
    id: id,
    url: check.url,
    mode: legacyMode(legacy),
    reachable: 'unknown'
  };
  // 旧令牌与地址分开存：显式带上，避免「地址迁过来了、令牌丢了」。
  // normalizeInstance 优先用这里的非空 token，其次才从 URL query 抽取；两者都不进可读 url。
  const legacyToken: string =
    legacy === null || legacy === undefined || typeof legacy.remoteToken !== 'string'
      ? ''
      : legacy.remoteToken.trim();
  if (legacyToken.length > 0) {
    candidate.token = legacyToken;
  }
  const seen: number = legacyLastSeen(legacy);
  if (seen > 0) {
    candidate.lastSeen = seen;
  }
  const result = normalizeInstance(candidate);
  if (!result.ok || result.instance === null) {
    return sortInstances(list);
  }
  return upsertInstance(list, result.instance);
}

/** 可达三态 → 中文短徽章；未知永不显示成「可达」。 */
export function reachabilityLabel(value: Reachability | string | undefined): string {
  if (value === 'ok') {
    return '可达';
  }
  if (value === 'fail') {
    return '不可达';
  }
  return '未知';
}

/**
 * 「上次成功」相对时间：坏值 / 时钟回拨都按「暂无记录」，不给用户看负数或 0 天前。
 * `now` 非法时退回传入的时间戳本身（调用方通常传 `Date.now()`）。
 */
export function relativeLastSeen(lastSeen: number | undefined, now: number): string {
  const at: number = validTime(lastSeen);
  if (at === 0) {
    return '暂无记录';
  }
  const current: number = validTime(now) > 0 ? now : Date.now();
  const elapsed: number = current - at;
  if (elapsed < 0) {
    return '暂无记录';
  }
  if (elapsed < MINUTE_MS) {
    return '刚刚';
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} 分钟前`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)} 小时前`;
  }
  return `${Math.floor(elapsed / DAY_MS)} 天前`;
}
