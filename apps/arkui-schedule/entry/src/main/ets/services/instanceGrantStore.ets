/**
 * dots 按实例 / 按工具授权表持久化（零 UI，模块 `mod-instance-grant`）。
 *
 * 落盘：单个 `PersistentStorage` 键 `instance-grants.json`，信封 `{v:1,items:[...]}`。
 * 这里按 `docs/REMOTE-INSTANCES.md` §2 的实例表同款口径绑定这一个专用键（持久化底层仍是
 * preferences）；它是非秘密开关族之外的新键，授权表**不进 Git**、不进导出、不进日志。
 *
 * 原子写：整表经 `encodeGrants()` 编成一个 JSON 字符串，一次 `AppStorage.setOrCreate`
 * 全量替换；不拆多键、不追加写、不留下半截表。
 *
 * 安全：本模型没有令牌字段，store 也**没有任何日志调用**；对外渲染 / 导出一律走
 * `redacted()`（结构上没有自由文本 note，只给派生的 active / canPrompt）。绝不把一条
 * 授权连同任何凭据值一起打印。
 *
 * 失败纪律：坏 JSON / 坏版本 / 坏记录 → `decodeGrants` 回落空表 + typed reason，由
 * `lastProblem()` 暴露给 UI；存储 API 异常也只落到 typed reason，绝不抛进 UI。
 */

import {
  decodeGrants,
  encodeGrants,
  redactGrant,
  revokeGrant,
  sortGrants,
  upsertGrant
} from '../model/instanceGrant';
import type {
  GrantMutationResult,
  GrantProblem,
  InstanceGrant,
  RedactedGrant
} from '../model/instanceGrant';

/** 唯一持久键：JSON 字符串信封。 */
const GRANT_STORAGE_KEY: string = 'instance-grants.json';

/** `PersistentStorage` 只需绑定一次；重复绑定由布尔位挡住。 */
let storageBound: boolean = false;

/** 绑定单个持久键；绑定失败时仍可用 AppStorage 内存镜像，不抛到 UI。 */
function ensureBound(): void {
  if (storageBound) {
    return;
  }
  storageBound = true;
  try {
    PersistentStorage.persistProp<string>(GRANT_STORAGE_KEY, '');
  } catch {
    // 绑定不可用：读侧拿到空串、写侧只保留内存镜像；问题码由调用方按写失败标记
  }
}

/** 读原始信封字符串（未绑定 / 无值都按空串）。 */
function readRaw(): string {
  ensureBound();
  const raw: string | undefined = AppStorage.get<string>(GRANT_STORAGE_KEY);
  return raw === undefined ? '' : raw;
}

/** 一次整串替换 = 原子写。 */
function writeRaw(json: string): void {
  ensureBound();
  AppStorage.setOrCreate<string>(GRANT_STORAGE_KEY, json);
}

export class InstanceGrantStore {
  /** 内存镜像；null = 还没从持久层解码过。 */
  private items: InstanceGrant[] | null = null;
  /** 最近一次读 / 写的问题码；'ok' = 健康。 */
  private problem: GrantProblem = 'ok';

  /** 懒加载：坏值回落空表 + typed reason，整条路径不抛异常。 */
  private load(): InstanceGrant[] {
    if (this.items !== null) {
      return this.items;
    }
    let raw: string = '';
    try {
      raw = readRaw();
    } catch {
      this.problem = 'E_GRANT_STORAGE_UNAVAILABLE';
      this.items = [];
      return this.items;
    }
    const decoded = decodeGrants(raw);
    this.problem = decoded.problem;
    this.items = decoded.items;
    return this.items;
  }

  /** 排序 + 整表写回；写失败只标 problem，内存镜像照常更新（不把异常抛给页面）。 */
  private commit(items: InstanceGrant[]): InstanceGrant[] {
    const sorted: InstanceGrant[] = sortGrants(items);
    const json: string = encodeGrants(sorted);
    try {
      writeRaw(json);
      this.problem = 'ok';
    } catch {
      this.problem = 'E_GRANT_STORAGE_UNAVAILABLE';
    }
    this.items = sorted;
    return sorted.slice();
  }

  /** 当前授权表（返回副本；按 grantKey 排序，确定性）。 */
  list(): InstanceGrant[] {
    return this.load().slice();
  }

  /** typed 问题码：坏信封 / 存储不可用；UI 用 `problemText()` 转成中文。 */
  lastProblem(): GrantProblem {
    // 先触发一次懒加载，让调用方读到的是真实问题码
    this.load();
    return this.problem;
  }

  /** 插入或按 grantKey 替换（同实例同 principal 更新，不产生第二条）；坏授权只标 typed problem，不写回。 */
  upsert(grant: InstanceGrant): InstanceGrant[] {
    const result: GrantMutationResult = upsertGrant(this.load(), grant);
    if (!result.ok) {
      this.problem = result.problem;
      return this.list();
    }
    return this.commit(result.items);
  }

  /**
   * 按 grantId 吊销；重复吊销保留更早的时间，找不到 grantId 则原样。
   * nowMs 非法时模型返回 `E_GRANT_NOW` 且原表不动，此处绝不写回——否则坏吊销清掉整表授权。
   */
  revoke(grantId: string, nowMs: number): InstanceGrant[] {
    const result: GrantMutationResult = revokeGrant(this.load(), grantId, nowMs);
    if (!result.ok) {
      this.problem = result.problem;
      return this.list();
    }
    return this.commit(result.items);
  }

  /** 渲染 / 导出唯一入口：无自由文本 note，带派生 active / canPrompt（view 永不隐含 command）。 */
  redacted(nowMs: number): RedactedGrant[] {
    const items: InstanceGrant[] = this.load();
    const views: RedactedGrant[] = [];
    for (const item of items) {
      views.push(redactGrant(item, nowMs));
    }
    return views;
  }
}

/** 全局单例（页面 / 服务共用同一份内存镜像与持久键）。 */
export const instanceGrantStore: InstanceGrantStore = new InstanceGrantStore();
