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

/** 唯一持久键：JSON 字符串信封。 */
const INSTANCE_STORAGE_KEY: string = 'instances.json';

/** `PersistentStorage` 只需绑定一次；重复绑定由布尔位挡住。 */
let storageBound: boolean = false;

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

export class InstanceStore {
  /** 内存镜像；null = 还没从持久层解码过。 */
  private items: DsInstance[] | null = null;
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

  /** 当前实例表（返回副本；本机若有则由调用方用 `localInstance()` 决定如何呈现）。 */
  list(): DsInstance[] {
    return this.load().slice();
  }

  /**
   * 首次进入实例页时播种 + 旧配置迁移（模块 `mod-instance-list`）。
   *
   * 由页面在读完 `settingsStore` 后调用一次；纯判定在 `model/instanceSeed.ts`。
   * 内容没变就**不写盘**（第二次启动零 IO、零重复）；本机不可删、旧地址按 id 去重。
   */
  ensureSeeded(legacy: LegacyInstanceSettings): DsInstance[] {
    const before: DsInstance[] = this.load();
    const seeded: DsInstance[] = seedInstances(before, legacy);
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
    return this.commit(upsertInstance(this.load(), inst));
  }

  /** 按 id 删除；本机行由模型层保证不可删除。 */
  remove(id: string): DsInstance[] {
    return this.commit(removeInstance(this.load(), id));
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
