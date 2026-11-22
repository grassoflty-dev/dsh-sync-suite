/**
 * 公告地址刷新服务（mod-remote-announce-wiring）—— 让 remoteAnnounceStore 真正进入 HAP 的消费者。
 *
 * 消费路径（唯一入口，页面显式触发）：
 *   `pages/panes/InstancesPane.ets`（失败行的「按公告刷新地址」/「首次配对：确认信任该公告」）
 *   → `RemoteAnnounceRefreshService.refresh()` → `model/remoteAnnounceRefresh.ts`（纯决策）
 *   → `model/remoteAnnounce.ts`（签名 → 指纹 → 时间 → 同 id 拒并）。
 *
 * 首配两阶段（关 Major：原来 firstPairing 恒 false ⇒ 没有任何用户能走到 refreshed）：
 *   ① 提案：`refresh()` 在没有 pin 时以 firstPairing=true 跑完整四步，只返回
 *      `first-pairing-pending`，**零写入**（pins / 实例表字节不变）；
 *   ② 确认：`confirmFirstPairing()` 先重跑一次提案防 TOCTOU，再经纯函数 `completeRefresh()`
 *      显式 consent 一道写 pin（TOFU 锚点）+ 地址。
 *   一旦有 pin，之后的刷新走 firstPairing=false + 同一把验签材料，直接 refreshed，不再打扰用户；
 *   不同钥匙在该行 typed 拒绝，首配按钮**永不**复用成换钥按钮（本模块不提供换钥入口）。
 *
 * 纪律：
 * - **只读仓库**：仅 `fs.readTextSync` 读 `<filesDir>/git-repo/remote/<instanceId>.json`；
 *   本文件没有任何写 / 提交 / push / 网络调用，也不碰网关 / 中继；
 * - **不轮询、不自动信任**：没有后台定时器，没有 on-load 路径能进入首配；
 * - **不抛到 UI**：文件读失败 / 存储异常 / 平台 crypto 异常全被吞成 typed 结果；
 * - **地址不出日志**：本文件没有任何日志调用，新地址只在确认后经端口进持久层；
 * - **直连 DSH / tailcat typed 拒绝**：caller 恒为 `tablet`，模型会拒收 tailcat 公告。
 *
 * 验签材料来源：有 pin 时取 pin；首配提案时取公告自带的 64 位十六进制公钥指纹作为候选密钥
 * （Q1 的分发机制未定，本模块不发明）。候选钥匙只用于「签名是否由自称的这把钥匙签发」的自洽检查，
 * 只有用户显式确认后才落盘成为锚点。材料长度不合规则验签器直接 false（fail-closed）。
 */

import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import type { DsInstance } from '../model/instances';
import { parseAnnouncement } from '../model/remoteAnnounce';
import type { AnnounceVerifyOptions } from '../model/remoteAnnounce';
import { KEEP_WORDING } from '../model/remoteAnnounce';
import { completeRefresh, decideAnnounceRefresh } from '../model/remoteAnnounceRefresh';
import type {
  AnnounceApplyPort,
  AnnounceRefreshCurrent,
  AnnounceRefreshOutcome
} from '../model/remoteAnnounceRefresh';
import { instanceStore } from './instanceStore';
import { createEd25519Verifier, remoteAnnounceStore } from './remoteAnnounceStore';

/** 仓库工作副本相对 filesDir 的目录名（与 GitSyncService.getRepoRoot() 同口径）。 */
const REPO_DIR: string = 'git-repo';
/** 公告目录（host 写、平板只读）。 */
const REMOTE_DIR: string = 'remote';
/** 合法实例 id：同时是文件名白名单，杜绝路径穿越。 */
const INSTANCE_ID_RE: RegExp = /^inst-[0-9a-f]{16}$/;

export class RemoteAnnounceRefreshService {
  /** filesDir 由页面在触发动作时预置；未预置时一切按「无公告」处理。 */
  private filesDir: string = '';

  /** 幂等初始化：只取 filesDir，不建目录、不写盘、不执行 git。 */
  init(context: common.UIAbilityContext): void {
    try {
      const dir: string = context.filesDir;
      this.filesDir = typeof dir === 'string' && dir.length > 0 ? dir.replace(/\\/g, '/') : '';
    } catch {
      this.filesDir = '';
    }
  }

  /** 页面据此选择「按公告刷新地址」还是「首次配对：确认信任该公告」；纯读取。 */
  hasPin(instanceId: string): boolean {
    try {
      return remoteAnnounceStore.getPin(instanceId).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 只读读取工作副本里的公告；文件不存在 / 空文件 / 任何异常都按「无公告」返回 null。
   * 这里绝不用 write / mkdir / rm / git 接口 —— 公告是 host 侧产物，平板只读。
   */
  private readAnnouncement(instanceId: string): string | null {
    if (!INSTANCE_ID_RE.test(instanceId) || this.filesDir.length === 0) {
      return null;
    }
    const path: string = `${this.filesDir}/${REPO_DIR}/${REMOTE_DIR}/${instanceId}.json`;
    try {
      const text: string = fs.readTextSync(path);
      return typeof text === 'string' && text.trim().length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  /** 统一的 typed 拒绝结果（保旧地址、零写入、逐字 KEEP_WORDING）。 */
  private refusal(): AnnounceRefreshOutcome {
    return {
      state: 'untrusted',
      problem: 'E_ANNOUNCE_SIGNATURE',
      wording: KEEP_WORDING,
      newUrl: '',
      updatedAt: 0,
      pin: ''
    };
  }

  /**
   * 把新地址 + 已应用时间写进实例表（只在四步全过且显式 consent 后调用）。
   * id 是公告签名的稳定身份，不按新地址重算；可达态回落 unknown，token / lastSeen 原样保留。
   */
  private storeAddress(instance: DsInstance, newUrl: string, updatedAt: number): void {
    const next: DsInstance = {
      id: instance.id,
      name: instance.name,
      url: newUrl,
      mode: instance.mode,
      reachable: 'unknown',
      capabilities: instance.capabilities
    };
    if (instance.token !== undefined) {
      next.token = instance.token;
    }
    if (instance.lastSeen !== undefined) {
      next.lastSeen = instance.lastSeen;
    }
    instanceStore.upsert(next);
    remoteAnnounceStore.applyUpdatedAt(instance.id, updatedAt);
  }

  /**
   * 按公告刷新 / 生成首配提案：同步返回 typed 结果，永不向 UI 抛异常。
   * 有 pin ⇒ 四步全过后直接刷新；无 pin ⇒ 四步全过后只给提案，零写入。
   */
  refresh(instance: DsInstance): AnnounceRefreshOutcome {
    try {
      const text: string | null = this.readAnnouncement(instance.id);
      const pin: string = remoteAnnounceStore.getPin(instance.id);
      const firstPairing: boolean = pin.length === 0;
      // 首配候选验签材料只从同一份公告文本读取（自洽检查），确认后才成为 pin
      const parsed = parseAnnouncement(text === null ? '' : text, 'tablet');
      const verifierKey: string = !firstPairing || !parsed.ok || parsed.announcement === null
        ? pin
        : parsed.announcement.publicKeyFingerprint;
      const opts: AnnounceVerifyOptions = {
        verifier: createEd25519Verifier(),
        publicKey: verifierKey,
        pinnedKey: pin,
        firstPairing: firstPairing,
        knownPins: remoteAnnounceStore.allPins(),
        now: (): number => Date.now()
      };
      // ArkTS 要求对象字面量对应显式声明的接口（arkts-no-untyped-obj-literals）
      const current: AnnounceRefreshCurrent = {
        id: instance.id,
        updatedAt: remoteAnnounceStore.getAppliedUpdatedAt(instance.id)
      };
      const outcome: AnnounceRefreshOutcome =
        decideAnnounceRefresh(current, text, 'tablet', opts);

      // 只有已有 pin 的自动刷新才写地址；first-pairing-pending 绝不在这里落字节
      if (outcome.state === 'refreshed') {
        this.storeAddress(instance, outcome.newUrl, outcome.updatedAt);
      }
      return outcome;
    } catch {
      return this.refusal();
    }
  }

  /**
   * 显式确认首配：先重跑提案防 TOCTOU（公告变了就拒绝），再一道写 pin + 地址。
   * - 已有 pin ⇒ 拒绝（首配按钮不能换钥、不能重复绑定，重入也在这里挡住）；
   * - 取消 / 无提案 / 候选变化 ⇒ 零端口调用，pins 与实例表字节不变。
   */
  confirmFirstPairing(instance: DsInstance, pending: AnnounceRefreshOutcome): AnnounceRefreshOutcome {
    try {
      if (pending.state !== 'first-pairing-pending' || pending.pin.length === 0 ||
          pending.newUrl.length === 0) {
        return this.refusal();
      }
      if (remoteAnnounceStore.getPin(instance.id).length > 0) {
        return this.refusal();
      }
      const fresh: AnnounceRefreshOutcome = this.refresh(instance);
      if (fresh.state !== 'first-pairing-pending' || fresh.pin !== pending.pin ||
          fresh.newUrl !== pending.newUrl || fresh.updatedAt !== pending.updatedAt) {
        return this.refusal();
      }
      const port: AnnounceApplyPort = {
        storePin: (value: string): void => {
          remoteAnnounceStore.setPin(instance.id, value);
        },
        storeAddress: (url: string, at: number): void => {
          this.storeAddress(instance, url, at);
        }
      };
      return completeRefresh(pending, true, '', port);
    } catch {
      return this.refusal();
    }
  }
}

/** 全局单例：页面与未来其它显式刷新入口共用同一份 filesDir 视图。 */
export const remoteAnnounceRefreshService: RemoteAnnounceRefreshService =
  new RemoteAnnounceRefreshService();
