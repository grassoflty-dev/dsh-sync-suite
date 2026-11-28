/**
 * 远程实例表持久化（零 UI，模块 `mod-instance-model`）。
 *
 * 落盘：设计稿 `docs/REMOTE-INSTANCES.md` §2 的**单个字符串键** `instances.json`。
 * 这里按任务书用 `PersistentStorage` 绑定这一个专用键（持久化底层仍是 preferences，
 * 与 §2 的「preferences 一个字符串键」同义）；它不是那几个非秘密开关键，实例表不混进
 * Git 仓库、不进导出（`docs/DATA-CONTRACT.md` §10 禁止凭据进 `chats/`）。
 *
 * 原子写：整表经 `encodeInstances()` 编成 `{v:1,items:[...]}` 一个 JSON 字符串，
 * 一次 `AppStorage.setOrCreate` 全量替换；不拆多键、不追加写、不留下半截表。
 *
 * 安全：token 只活在这个信封字符串里；本文件**没有任何日志调用**，
 * 对外渲染 / 导出一律走 `redacted()`（结构上没有 token，只有 tokenSet）。
 *
 * 失败纪律：坏 JSON / 坏版本 / 坏记录 → `decodeInstances` 回落空表 + typed reason，
 * 由 `lastProblem()` 暴露给 UI；存储 API 异常也只落到 typed reason，绝不抛进 UI。
 *
 * 产品决定（`mod-instances-drop-local`）：没有本机实例，表里只放远程行；旧持久化 `local` 行在
 * `decodeInstances` 读取时按字面量过滤，不复活、不落盘。
 */

import {
  applyReachability,
  decodeInstances,
  encodeInstances,
  redactInstance,
  removeInstance,
  sortInstances,
  upsertInstance
} from '../model/instances';
import type { DsInstance, InstanceProblem, RedactedInstance } from '../model/instances';
import { seedInstances } from '../model/instanceSeed';
import type { LegacyInstanceSettings } from '../model/instanceSeed';
import { addPairedInstanceWithProbe } from '../model/pairingPayload';
import type { PairingAddResult } from '../model/pairingPayload';
import type { PairingProbeTransport } from '../model/pairingProbe';
import {
  decodeTombstones,
  encodeTombstones,
  forgetTombstones,
  mergeTombstones,
  suppressLegacyForTombstones,
  tombstoneIdsOf
} from '../model/instanceDelete';

/** 唯一持久键：JSON 字符串信封。 */
const INSTANCE_STORAGE_KEY: string = 'instances.json';

/**
 * 删除墓碑键（mod-app-instance-delete-in-settings）：单独一个字符串键，不污染实例表信封。
 * 旧配置镜像 `remoteUrl` / `remoteLastOk` 仍在盘上，没有墓碑就会在下次启动被 ensureSeeded 播种回来。
 */
const TOMBSTONE_STORAGE_KEY: string = 'deleted-instances.json';

/** `PersistentStorage` 只需绑定一次；重复绑定由布尔位挡住。 */
let storageBound: boolean = false;
let tombstoneBound: boolean = false;

/** 绑定单个持久键；绑定失败时仍可用 AppStorage 内存镜像，不抛到 UI。 */
function ensureBound(): void {
  if (storageBound) {
    return;
  }
  storageBound = true;
  try {
    PersistentStorage.persistProp<string>(INSTANCE_STORAGE_KEY, '');
  } catch {
    // 绑定不可用：读侧拿到空串、写侧只保留内存镜像；问题码由调用方按写失败标记
  }
}

/** 读原始信封字符串（未绑定 / 无值都按空串）。 */
function readRaw(): string {
  ensureBound();
  const raw: string | undefined = AppStorage.get<string>(INSTANCE_STORAGE_KEY);
  return raw === undefined ? '' : raw;
}

/** 一次整串替换 = 原子写。 */
function writeRaw(json: string): void {
  ensureBound();
  AppStorage.setOrCreate<string>(INSTANCE_STORAGE_KEY, json);
}

/** 墓碑键只需绑定一次；绑定失败时仍可用 AppStorage 内存镜像，不抛到 UI。 */
function ensureTombstoneBound(): void {
  if (tombstoneBound) {
    return;
  }
  tombstoneBound = true;
  try {
    PersistentStorage.persistProp<string>(TOMBSTONE_STORAGE_KEY, '');
  } catch {
    // 绑定不可用：读侧拿到空串、写侧只保留内存镜像；问题码由写失败标记
  }
}

function readTombstonesRaw(): string {
  ensureTombstoneBound();
  const raw: string | undefined = AppStorage.get<string>(TOMBSTONE_STORAGE_KEY);
  return raw === undefined ? '' : raw;
}

function writeTombstonesRaw(json: string): void {
  ensureTombstoneBound();
  AppStorage.setOrCreate<string>(TOMBSTONE_STORAGE_KEY, json);
}

export class InstanceStore {
  /** 内存镜像；null = 还没从持久层解码过。 */
  private items: DsInstance[] | null = null;
  /** 墓碑镜像；null = 还没从持久层解码过。 */
  private tombstones: string[] | null = null;
  /** 最近一次读 / 写的问题码；'ok' = 健康。 */
  private problem: InstanceProblem = 'ok';

  /** 懒加载：坏值回落空表 + typed reason，整条路径不抛异常。 */
  private load(): DsInstance[] {
    if (this.items !== null) {
      return this.items;
    }
    let raw: string = '';
    try {
      raw = readRaw();
    } catch {
      this.problem = 'E_STORAGE_UNAVAILABLE';
      this.items = [];
      return this.items;
    }
    const decoded = decodeInstances(raw);
    this.problem = decoded.problem;
    this.items = decoded.items;
    return this.items;
  }

  /** 排序 + 整表写回；写失败只标 problem，内存镜像照常更新（不把异常抛给页面）。 */
  private commit(items: DsInstance[]): DsInstance[] {
    const sorted: DsInstance[] = sortInstances(items);
    const json: string = encodeInstances(sorted);
    try {
      writeRaw(json);
      this.problem = 'ok';
    } catch {
      this.problem = 'E_STORAGE_UNAVAILABLE';
    }
    this.items = sorted;
    return sorted.slice();
  }

  /** 墓碑表懒加载：坏信封回落空表，整条路径不抛异常。 */
  private loadTombstones(): string[] {
    if (this.tombstones !== null) {
      return this.tombstones;
    }
    let raw: string = '';
    try {
      raw = readTombstonesRaw();
    } catch {
      this.tombstones = [];
      return this.tombstones;
    }
    this.tombstones = decodeTombstones(raw);
    return this.tombstones;
  }

  /** 墓碑整串替换：写失败只保留内存镜像，不把异常抛给页面。 */
  private commitTombstones(ids: string[]): void {
    const next: string[] = ids.slice();
    try {
      writeTombstonesRaw(encodeTombstones(next));
    } catch {
      // 与实例表同样的失败纪律：problem 由调用方按写失败标记，内存镜像照常更新
    }
    this.tombstones = next;
  }

  /** 当前实例表（返回副本；只含远程行，旧 `local` 行已在 `decodeInstances` 读取时过滤）。 */
  list(): DsInstance[] {
    return this.load().slice();
  }

  /** 当前墓碑表（返回副本）。 */
  deletedIds(): string[] {
    return this.loadTombstones().slice();
  }

  /**
   * 首次进入实例页时播种 + 旧配置迁移（模块 `mod-instance-list`）。
   *
   * 由页面在读完 `settingsStore` 后调用一次；纯判定在 `model/instanceSeed.ts`。
   * 只迁远程地址、不补本机行；内容没变就**不写盘**（第二次启动零 IO、零重复），旧地址按 id 去重。
   */
  ensureSeeded(legacy: LegacyInstanceSettings): DsInstance[] {
    const before: DsInstance[] = this.load();
    // 墓碑优先：即使调用方还持有旧 remoteUrl / remoteLastOk，也不许把已删实例播种回来。
    const seeded: DsInstance[] = seedInstances(before, suppressLegacyForTombstones(legacy, this.loadTombstones()));
    if (encodeInstances(seeded) === encodeInstances(sortInstances(before))) {
      return before.slice();
    }
    return this.commit(seeded);
  }

  /** typed 问题码：坏信封 / 存储不可用；UI 用 `problemText()` 转成中文。 */
  lastProblem(): InstanceProblem {
    // 先触发一次懒加载，让调用方读到的是真实问题码
    this.load();
    return this.problem;
  }

  /** 插入或按 id 替换（同 id 更新，不产生第二条），写回后返回排序后的新表。 */
  upsert(inst: DsInstance): DsInstance[] {
    const next: DsInstance[] = this.commit(upsertInstance(this.load(), inst));
    // 用户重新添加 / 配对同一地址：墓碑必须清掉，否则旧镜像会被永久抑制（新行本身不受影响）。
    this.commitTombstones(forgetTombstones(this.loadTombstones(), tombstoneIdsOf(inst.id, inst.url)));
    return next;
  }

  /**
   * 编辑改地址专用一步替换：旧 id → 新 id，不留两行。
   * 这不是用户可见的删除入口（删除只在 `pages/SettingsInstances`）：旧 id/旧地址写墓碑，
   * 防止旧配置镜像在下次启动把「改地址前的那一行」播种回来；新地址清墓碑。
   */
  rekey(oldId: string, inst: DsInstance): DsInstance[] {
    const before: DsInstance[] = this.load();
    let old: DsInstance | null = null;
    for (const item of before) {
      if (item.id === oldId) {
        old = item;
        break;
      }
    }
    const next: DsInstance[] = this.commit(upsertInstance(removeInstance(before, oldId), inst));
    let tombstones: string[] = this.loadTombstones();
    if (old !== null) {
      tombstones = mergeTombstones(tombstones, tombstoneIdsOf(old.id, old.url));
    }
    this.commitTombstones(forgetTombstones(tombstones, tombstoneIdsOf(inst.id, inst.url)));
    return next;
  }

  /**
   * 手动配对落表（mod-pairing-reachability）：先做真实短超时 TCP 探活，再走 TOFU 门禁。
   * 只有「探测通过 + schema 合法 + TOFU 不冲突」（result.ok）才整表替换；
   * 连接被拒 / 超时 / 指纹冲突 / 坏载荷一律零写入，pin 与旧地址逐字不变，
   * 粘贴框由页面保留供用户改端口后重试。返回 typed code + 固定中文文案（永不含令牌值）。
   */
  async addByPairing(text: string, probe: PairingProbeTransport): Promise<PairingAddResult> {
    const result: PairingAddResult = await addPairedInstanceWithProbe(this.load(), text, probe);
    if (result.ok) {
      this.commit(result.items);
      for (const item of result.items) {
        this.commitTombstones(forgetTombstones(this.loadTombstones(), tombstoneIdsOf(item.id, item.url)));
      }
    }
    return result;
  }

  /**
   * 按 id 删除远程行（没有受保护的本机行）；连同 token / tlsFingerprint / pairingInstanceId
   * 整条记录一起消失（整表替换，不留半行）。同时写墓碑：旧配置镜像里的地址派生同一个 id，
   * 下次启动 `ensureSeeded()` 会因此被抑制，已删实例不会回来。
   *
   * 唯一调用点是 `pages/SettingsInstances.ets` 的确认 sheet；首页 / 配置页面板没有删除入口。
   */
  remove(id: string): DsInstance[] {
    const before: DsInstance[] = this.load();
    let removed: DsInstance | null = null;
    for (const item of before) {
      if (item.id === id) {
        removed = item;
        break;
      }
    }
    const next: DsInstance[] = this.commit(removeInstance(before, id));
    if (removed !== null) {
      this.commitTombstones(mergeTombstones(this.loadTombstones(), tombstoneIdsOf(removed.id, removed.url)));
    }
    return next;
  }

  /**
   * 标记可达性：只有 `ok` 推进 `lastSeen`，`fail` 保留「上次成功」，未知状态不改表。
   */
  markReachable(id: string, status: 'ok' | 'fail', nowMs: number): DsInstance[] {
    return this.commit(applyReachability(this.load(), id, status, nowMs));
  }

  /** 渲染 / 导出唯一入口：没有 token 字段，URL 已打码。 */
  redacted(): RedactedInstance[] {
    const items: DsInstance[] = this.load();
    const views: RedactedInstance[] = [];
    for (const item of items) {
      views.push(redactInstance(item));
    }
    return views;
  }
}

/** 全局单例（页面 / 服务共用同一份内存镜像与持久键）。 */
export const instanceStore: InstanceStore = new InstanceStore();
