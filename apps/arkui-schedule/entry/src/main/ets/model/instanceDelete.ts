/**
 * mod-app-instance-delete-in-settings：删除实例的纯判定（零 SDK import，Node 可直接单测）。
 *
 * 两件事都在这里收口，页面 / store 只做接线：
 * 1. **确认文案**：`deletePlanOf()` 返回逐字文案行。规则写在常量里，sheet 只渲染这些行，
 *    所以「名字 + 打码 URL + 丢什么 + 不丢什么 + 显式删除动词」不可能与规则漂移。
 * 2. **墓碑**：删除实例后，旧配置镜像（settingsStore 的 `remoteUrl` / `remoteLastOk`）仍在盘上，
 *    下次启动 `instanceStore.ensureSeeded()` 会按同一 URL 派生同一 id 再播种回来。墓碑用
 *    持久键记住「已删实例的 id（以及它地址派生出的 id）」，`ensureSeeded` 先抑制该旧镜像。
 *    墓碑是 typed / total 的：坏信封回落空表，坏 id 不进表，重添同一地址时清墓碑。
 *
 * 安全：本模型没有令牌字段、没有任何日志调用；给页面展示的 URL 只经 `redactUrl()`
 * （内部先 `sanitizeUrlForDisplay()` 再整串兜底打码），token 值结构上不出现。
 */

import { INSTANCE_ID_PATTERN, instanceIdFromUrl, redactUrl } from './instances';
import { decodeLastOk, normalizeRemoteUrl } from './remoteUrl';
import type { RedactedInstance } from './instances';
import type { LegacyInstanceSettings } from './instanceSeed';

// ---------------------------------------------------------------- 确认文案

/** sheet 标题与显式破坏性动词：不是裸「删除」。 */
export const DELETE_TITLE: string = '删除实例';
export const DELETE_CONFIRM: string = '删除实例';
export const DELETE_CANCEL: string = '取消';

/**
 * 逐字损失说明：不夸大授权（授权表今天可能本来就是空的），也不承诺清仓库级数据。
 * 这条常量是 sheet 唯一来源，测试逐字钉住，避免文案漂移成「顺带清缓存」。
 */
export const DELETE_LOSS_LINE: string =
  '这条实例的记录（地址、保存的访问令牌、证书指纹）和它的授权记录（如果从未授权过，这里是空的）';

/** 仓库级数据不随实例删除：聊天缓存 / 同步队列属于 repo，不能对其它实例造成空白。 */
export const DELETE_KEEP_LINE: string = '聊天缓存与同步队列属于仓库，不随实例删除';

/** 不杀会话、不假装被拦住：已打开页面继续可用，下次连接要重新扫码配对。 */
export const DELETE_LIVE_LINE: string = '已打开的页面在关闭前仍可使用；下次连接需要重新扫码配对';

/** 确认单的一行文案；没有实例时名字 / 地址是空串（不伪造占位名）。 */
export interface DeletePlan {
  title: string;
  name: string;
  displayUrl: string;
  lines: string[];
  confirmLabel: string;
  cancelLabel: string;
}

/** 展示 URL 的唯一出口：store 已 `redactInstance()` 过，这里再过一次整串兜底打码。 */
export function redactDisplayUrl(url: string): string {
  return redactUrl(typeof url === 'string' ? url : '');
}

/** 纯确认计划：入参不受影响，文案逐字来自常量，URL 永不回显令牌。 */
export function deletePlanOf(view: RedactedInstance | null | undefined): DeletePlan {
  const name: string = view === null || view === undefined || typeof view.name !== 'string' ? '' : view.name;
  const rawUrl: string = view === null || view === undefined || typeof view.url !== 'string' ? '' : view.url;
  const lines: string[] = [
    `实例：${name}`,
    `地址：${redactDisplayUrl(rawUrl)}`,
    DELETE_LOSS_LINE,
    DELETE_KEEP_LINE,
    DELETE_LIVE_LINE
  ];
  const plan: DeletePlan = {
    title: DELETE_TITLE,
    name: name,
    displayUrl: redactDisplayUrl(rawUrl),
    lines: lines,
    confirmLabel: DELETE_CONFIRM,
    cancelLabel: DELETE_CANCEL
  };
  return plan;
}

// ---------------------------------------------------------------- 墓碑（防止旧镜像复活）

/** 墓碑信封版本（只认 1，未来版本 typed 拒绝，不静默迁移）。 */
export const TOMBSTONE_ENVELOPE_VERSION: number = 1;

/** 版本化信封：`{v:1,items:[inst-<16hex>,…]}`，一次整串写入 = 原子替换。 */
interface TombstoneEnvelope {
  v: number;
  items: string[];
}

function validId(raw: string): string {
  return typeof raw === 'string' && INSTANCE_ID_PATTERN.test(raw.trim()) ? raw.trim() : '';
}

/** 确定性排序 + 去重（不用 localeCompare，免得随系统 locale 变）。 */
function normalizeIds(ids: string[]): string[] {
  const unique: string[] = [];
  for (const raw of ids) {
    const id: string = validId(raw);
    if (id.length > 0 && unique.indexOf(id) < 0) {
      unique.push(id);
    }
  }
  unique.sort();
  return unique;
}

/** 序列化墓碑表（固定键顺序；无令牌、不写日志）。 */
export function encodeTombstones(ids: string[]): string {
  const envelope: TombstoneEnvelope = { v: TOMBSTONE_ENVELOPE_VERSION, items: normalizeIds(ids) };
  return JSON.stringify(envelope);
}

/** 反序列化：空串 / 坏 JSON / 坏版本 / 坏项都回落空表，绝不抛异常。 */
export function decodeTombstones(raw: string | null | undefined): string[] {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return [];
  }
  let parsed: Object | null = null;
  try {
    parsed = JSON.parse(text) as Object;
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  const envelope: TombstoneEnvelope = parsed as TombstoneEnvelope;
  if (envelope.v !== TOMBSTONE_ENVELOPE_VERSION || !Array.isArray(envelope.items)) {
    return [];
  }
  return normalizeIds(envelope.items as string[]);
}

/** 追加墓碑（已存在的 id 不重复，返回新数组，入参不改）。 */
export function mergeTombstones(existing: string[], added: string[]): string[] {
  return normalizeIds(existing.concat(added));
}

/** 清除墓碑：用户重新添加 / 配对同一地址后，旧镜像不再被抑制。 */
export function forgetTombstones(existing: string[], ids: string[]): string[] {
  const drop: string[] = normalizeIds(ids);
  const kept: string[] = [];
  for (const id of normalizeIds(existing)) {
    if (drop.indexOf(id) < 0) {
      kept.push(id);
    }
  }
  return kept;
}

/**
 * 一条实例的墓碑 id：实例 id 本身，以及它**真实 URL** 派生出的 id（旧镜像播种用的就是后者）。
 * 坏 id / 坏地址只留能用的那一个；两者都没有时返回空表（总函数，不抛错）。
 */
export function tombstoneIdsOf(instanceId: string, url: string): string[] {
  const ids: string[] = [validId(instanceId)];
  const check = normalizeRemoteUrl(typeof url === 'string' ? url : '');
  if (check.ok) {
    ids.push(instanceIdFromUrl(check.url));
  }
  return normalizeIds(ids);
}

/** 旧配置镜像会被 `seedInstances()` 派生出的 id：用于判断是否要抑制播种。 */
export function legacySeedIdOf(legacy: LegacyInstanceSettings | null | undefined): string {
  if (legacy === null || legacy === undefined) {
    return '';
  }
  const primary: string = typeof legacy.remoteUrl === 'string' ? legacy.remoteUrl.trim() : '';
  let raw: string = primary;
  if (raw.length === 0) {
    const lastOk = decodeLastOk(typeof legacy.remoteLastOk === 'string' ? legacy.remoteLastOk : '');
    raw = lastOk === null ? '' : lastOk.url.trim();
  }
  if (raw.length === 0) {
    return '';
  }
  const check = normalizeRemoteUrl(raw);
  if (!check.ok) {
    return '';
  }
  return instanceIdFromUrl(check.url);
}

/**
 * 播种前的旧镜像抑制：墓碑命中时把地址 / 最近成功两项清空（令牌与方式字段原样保留），
 * 于是 `seedInstances()` 没有地址可用，已删实例不会在下次启动回来；未命中时原对象原样返回。
 */
export function suppressLegacyForTombstones(
  legacy: LegacyInstanceSettings,
  tombstones: string[]
): LegacyInstanceSettings {
  const id: string = legacySeedIdOf(legacy);
  if (id.length === 0 || tombstones.indexOf(id) < 0) {
    return legacy;
  }
  const safe: LegacyInstanceSettings = {
    remoteUrl: '',
    remoteLastOk: '',
    remoteMode: legacy.remoteMode,
    remoteToken: legacy.remoteToken
  };
  return safe;
}
