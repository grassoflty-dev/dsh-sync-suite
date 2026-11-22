/**
 * 签名公告的 TOFU 公钥指纹钉住表 + ArkTS Ed25519 验签适配器（mod-remote-announce）。
 *
 * 职责边界（薄服务）：
 * - 纯模型 `model/remoteAnnounce.ts` 负责 schema / 规范序列化 / 四步验证 / 刷新与发布决策，零 IO；
 * - 本文件只做三件 IO 相关的桥接：① 把「每个 instanceId 钉住的公钥指纹」持久化；
 *   ② 把平台的 cryptoFramework Ed25519 验签包装成模型注入的 `SignatureVerifier` 接缝；
 *   ③ 记录每个实例「上一次已应用的公告 updatedAt」，供刷新决策做时序比较（只在本机存储）。
 *
 * 安全纪律：
 * - 钉住表用单个字符串键 `remote-announce-pins.json`（PersistentStorage 绑定 + 一次整串原子写），
 *   信封 `{v:1,pins}`；坏 JSON / 坏版本 / 坏表 ⇒ **空表 fail-closed** + typed 问题码，绝不抛进 UI；
 * - 钉住值只在「显式首次配对」或「用户显式确认换钥」时由调用方写入，自动刷新路径只读取；
 * - 验签适配器完全隔离：任何平台差异 / API 异常都返回 **false，绝不 true**；
 *   只有 `verifySync(...) === true` 才放行。编译与真机行为本批 `unverified`（无 DevEco / 未装机）。
 *
 * 产品边界：直连 DSH；本模块不含任何网关 / 中继 / 转发，也不写仓库（公告发布由 host 侧完成）。
 */

import type { SignatureVerifier } from '../model/remoteAnnounce';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';

/** 唯一持久键：钉住表的 JSON 字符串信封。 */
const PIN_STORAGE_KEY: string = 'remote-announce-pins.json';

/** 信封版本：只认 1，未来版本 typed 拒绝、回落空表。 */
const PIN_ENVELOPE_VERSION: number = 1;

/** 已应用时间表：同样是单个字符串键，且与钉住表一样在 App 数据目录，**不在 git 仓库里**。 */
const APPLIED_STORAGE_KEY: string = 'remote-announce-applied.json';

/** 已应用时间表信封版本：只认 1。 */
const APPLIED_ENVELOPE_VERSION: number = 1;

/** 持久问题码：坏信封 / 存储不可用（含已应用时间表的同类问题）。 */
export type PinProblem = 'ok' | 'E_PIN_ENVELOPE_JSON' | 'E_PIN_ENVELOPE_SHAPE' |
  'E_PIN_ENVELOPE_VERSION' | 'E_PIN_STORAGE_UNAVAILABLE' |
  'E_APPLIED_ENVELOPE_JSON' | 'E_APPLIED_ENVELOPE_SHAPE' |
  'E_APPLIED_ENVELOPE_VERSION' | 'E_APPLIED_STORAGE_UNAVAILABLE';

/** 版本化信封 `{v:1,pins}`；整串一次写入 = 原子替换。 */
interface PinEnvelope {
  v: number;
  pins: Record<string, string>;
}

/** 解码结果：失败时 pins 恒为空表（fail-closed）。 */
interface PinDecodeResult {
  ok: boolean;
  pins: Record<string, string>;
  problem: PinProblem;
}

/** PersistentStorage 只需绑定一次；重复绑定由布尔位挡住。 */
let storageBound: boolean = false;

/** 绑定单个持久键；绑定失败时仍可用 AppStorage 内存镜像，不抛到 UI。 */
function ensureBound(): void {
  if (storageBound) {
    return;
  }
  storageBound = true;
  try {
    PersistentStorage.persistProp<string>(PIN_STORAGE_KEY, '');
  } catch {
    // 绑定不可用：读侧拿到空串、写侧只保留内存镜像；问题码由调用方按写失败标记
  }
}

/** 读原始信封字符串（未绑定 / 无值都按空串）。 */
function readRaw(): string {
  ensureBound();
  const raw: string | undefined = AppStorage.get<string>(PIN_STORAGE_KEY);
  return raw === undefined ? '' : raw;
}

/** 一次整串替换 = 原子写。 */
function writeRaw(json: string): void {
  ensureBound();
  AppStorage.setOrCreate<string>(PIN_STORAGE_KEY, json);
}

/** 空表解码结果（坏信封一律走这里）。 */
function decodeFailed(problem: PinProblem): PinDecodeResult {
  const result: PinDecodeResult = { ok: false, pins: {}, problem: problem };
  return result;
}

/** 解析钉住表；空串 / 坏 JSON / 坏版本 / 非对象 / 非字符串条目 ⇒ 空表 + typed 码，绝不抛。 */
export function decodePins(raw: string | null | undefined): PinDecodeResult {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return { ok: true, pins: {}, problem: 'ok' };
  }
  let parsed: PinEnvelope;
  try {
    parsed = JSON.parse(text) as PinEnvelope;
  } catch {
    return decodeFailed('E_PIN_ENVELOPE_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return decodeFailed('E_PIN_ENVELOPE_SHAPE');
  }
  if (typeof parsed.v !== 'number' || !Number.isFinite(parsed.v)) {
    return decodeFailed('E_PIN_ENVELOPE_SHAPE');
  }
  if (parsed.v !== PIN_ENVELOPE_VERSION) {
    return decodeFailed('E_PIN_ENVELOPE_VERSION');
  }
  if (parsed.pins === null || typeof parsed.pins !== 'object' || Array.isArray(parsed.pins)) {
    return decodeFailed('E_PIN_ENVELOPE_SHAPE');
  }
  const pins: Record<string, string> = {};
  const keys: string[] = Object.keys(parsed.pins);
  for (const key of keys) {
    // ArkTS 禁用 unknown：信封字段已声明为 Record<string,string>，按声明类型读，运行时再用 typeof 兜底
    const value: string = parsed.pins[key];
    // 只接受 inst-<16hex> 键与非空字符串指纹；任一坏条目 ⇒ 整表 fail-closed（不局部保留）
    if (!/^inst-[0-9a-f]{16}$/.test(key) || typeof value !== 'string' || value.trim().length === 0) {
      return decodeFailed('E_PIN_ENVELOPE_SHAPE');
    }
    pins[key] = value.trim().toLowerCase();
  }
  return { ok: true, pins: pins, problem: 'ok' };
}

/** 序列化整表（固定键 v→pins；pins 按 key 排序，逐字节确定）。 */
export function encodePins(pins: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  const keys: string[] = Object.keys(pins).sort();
  for (const key of keys) {
    sorted[key] = pins[key];
  }
  const envelope: PinEnvelope = { v: PIN_ENVELOPE_VERSION, pins: sorted };
  return JSON.stringify(envelope);
}

// ============================================================================
// 已应用公告时间表（instanceId → updatedAt）—— 与钉住表同纪律：单键原子写 / fail-closed
// ============================================================================

/** 已应用表信封 `{v:1,applied}`。 */
interface AppliedEnvelope {
  v: number;
  applied: Record<string, number>;
}

/** 已应用表解码结果：失败时恒为空表 + typed 码。 */
interface AppliedDecodeResult {
  ok: boolean;
  applied: Record<string, number>;
  problem: PinProblem;
}

/** 已应用表的 PersistentStorage 绑定位（与钉住表独立）。 */
let appliedBound: boolean = false;

/** 绑定已应用表键；绑定失败仍可用 AppStorage 内存镜像，不抛到 UI。 */
function ensureAppliedBound(): void {
  if (appliedBound) {
    return;
  }
  appliedBound = true;
  try {
    PersistentStorage.persistProp<string>(APPLIED_STORAGE_KEY, '');
  } catch {
    // 绑定不可用：读侧拿空串、写侧只保留内存镜像
  }
}

/** 读已应用表原始串（未绑定 / 无值都按空串）。 */
function readAppliedRaw(): string {
  ensureAppliedBound();
  const raw: string | undefined = AppStorage.get<string>(APPLIED_STORAGE_KEY);
  return raw === undefined ? '' : raw;
}

/** 已应用表整串原子替换。 */
function writeAppliedRaw(json: string): void {
  ensureAppliedBound();
  AppStorage.setOrCreate<string>(APPLIED_STORAGE_KEY, json);
}

/**
 * 解析已应用表：空串 / 坏 JSON / 坏版本 / 非对象 / 非正整数条目 ⇒ 空表 + typed 码，绝不抛。
 * 只接受 `inst-<16hex>` 键；坏条目让整表 fail-closed（不局部保留）。
 */
export function decodeApplied(raw: string | null | undefined): AppliedDecodeResult {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return { ok: true, applied: {}, problem: 'ok' };
  }
  let parsed: AppliedEnvelope;
  try {
    parsed = JSON.parse(text) as AppliedEnvelope;
  } catch {
    return { ok: false, applied: {}, problem: 'E_APPLIED_ENVELOPE_JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
      typeof parsed.v !== 'number' || !Number.isFinite(parsed.v)) {
    return { ok: false, applied: {}, problem: 'E_APPLIED_ENVELOPE_SHAPE' };
  }
  if (parsed.v !== APPLIED_ENVELOPE_VERSION) {
    return { ok: false, applied: {}, problem: 'E_APPLIED_ENVELOPE_VERSION' };
  }
  if (parsed.applied === null || typeof parsed.applied !== 'object' || Array.isArray(parsed.applied)) {
    return { ok: false, applied: {}, problem: 'E_APPLIED_ENVELOPE_SHAPE' };
  }
  const applied: Record<string, number> = {};
  const keys: string[] = Object.keys(parsed.applied);
  for (const key of keys) {
    // 同上：ArkTS 禁用 unknown；运行时仍用 typeof / Number.isFinite 兜底坏信封
    const value: number = parsed.applied[key];
    if (!/^inst-[0-9a-f]{16}$/.test(key) || typeof value !== 'number' ||
        !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      return { ok: false, applied: {}, problem: 'E_APPLIED_ENVELOPE_SHAPE' };
    }
    applied[key] = value;
  }
  return { ok: true, applied: applied, problem: 'ok' };
}

/** 序列化已应用表（固定键 v→applied；键排序，逐字节确定）。 */
export function encodeApplied(applied: Record<string, number>): string {
  const sorted: Record<string, number> = {};
  const keys: string[] = Object.keys(applied).sort();
  for (const key of keys) {
    sorted[key] = applied[key];
  }
  const envelope: AppliedEnvelope = { v: APPLIED_ENVELOPE_VERSION, applied: sorted };
  return JSON.stringify(envelope);
}

/** 钉住表服务（内存镜像 + 单键原子写；零日志，指纹不是令牌但也绝不外泄）。 */
export class RemoteAnnounceStore {
  private pins: Record<string, string> | null = null;
  private problem: PinProblem = 'ok';
  /** 已应用 updatedAt 的内存镜像；null = 还没从持久层解码过。 */
  private applied: Record<string, number> | null = null;
  /** 已应用表的 typed 问题码。 */
  private appliedProblem: PinProblem = 'ok';

  /** 懒加载：坏值回落空表 + typed 码，整条路径不抛异常。 */
  private load(): Record<string, string> {
    if (this.pins !== null) {
      return this.pins;
    }
    let raw: string = '';
    try {
      raw = readRaw();
    } catch {
      this.problem = 'E_PIN_STORAGE_UNAVAILABLE';
      this.pins = {};
      return this.pins;
    }
    const decoded: PinDecodeResult = decodePins(raw);
    this.problem = decoded.problem;
    this.pins = decoded.pins;
    return this.pins;
  }

  /** 整表写回；写失败只标 problem，内存镜像照常更新（不把异常抛给页面）。 */
  private commit(pins: Record<string, string>): void {
    const json: string = encodePins(pins);
    try {
      writeRaw(json);
      this.problem = 'ok';
    } catch {
      this.problem = 'E_PIN_STORAGE_UNAVAILABLE';
    }
    this.pins = pins;
  }

  /** 读取某个实例的钉住指纹；没有返回空串（= 首配路径）。 */
  getPin(instanceId: string): string {
    const table: Record<string, string> = this.load();
    const value: string | undefined = table[instanceId];
    return value === undefined ? '' : value;
  }

  /** 全部钉住项的副本（供模型的 knownPins 第 ④ 步同 id 冲突检测）。 */
  allPins(): Record<string, string> {
    const table: Record<string, string> = this.load();
    const copy: Record<string, string> = {};
    const keys: string[] = Object.keys(table);
    for (const key of keys) {
      copy[key] = table[key];
    }
    return copy;
  }

  /**
   * 写入钉住指纹 —— **只供显式用户操作调用**（首次配对 / 用户确认换钥）。
   * 自动刷新路径绝不可调用本方法；坏 id / 空指纹直接 no-op，不污染表。
   */
  setPin(instanceId: string, fingerprint: string): void {
    if (!/^inst-[0-9a-f]{16}$/.test(instanceId) || fingerprint.trim().length === 0) {
      return;
    }
    const next: Record<string, string> = this.allPins();
    next[instanceId] = fingerprint.trim().toLowerCase();
    this.commit(next);
  }

  // ---------------------------------------------------------------- 已应用时间表

  /** 懒加载已应用表：坏值回落空表 + typed 码；不抛异常。 */
  private loadApplied(): Record<string, number> {
    if (this.applied !== null) {
      return this.applied;
    }
    let raw: string = '';
    try {
      raw = readAppliedRaw();
    } catch {
      this.appliedProblem = 'E_APPLIED_STORAGE_UNAVAILABLE';
      this.applied = {};
      return this.applied;
    }
    const decoded: AppliedDecodeResult = decodeApplied(raw);
    this.appliedProblem = decoded.problem;
    this.applied = decoded.applied;
    return this.applied;
  }

  /** 已应用表整表写回；写失败只标 problem，内存镜像照常更新（不把异常抛给页面）。 */
  private commitApplied(applied: Record<string, number>): void {
    const json: string = encodeApplied(applied);
    try {
      writeAppliedRaw(json);
      this.appliedProblem = 'ok';
    } catch {
      this.appliedProblem = 'E_APPLIED_STORAGE_UNAVAILABLE';
    }
    this.applied = applied;
  }

  /** 读取某实例已应用的公告时间；无记录 / 坏 id 返回 0（= 从未应用）。 */
  getAppliedUpdatedAt(instanceId: string): number {
    const table: Record<string, number> = this.loadApplied();
    const value: number | undefined = table[instanceId];
    return value === undefined ? 0 : value;
  }

  /**
   * 记录「已按公告应用过的时间」——只在刷新决策四步全过并真正改写地址后调用。
   * 坏 id / 非正整数直接 no-op；这不是钉住操作，不影响 TOFU 表。
   */
  applyUpdatedAt(instanceId: string, updatedAt: number): void {
    if (!/^inst-[0-9a-f]{16}$/.test(instanceId) || !Number.isFinite(updatedAt) ||
        !Number.isInteger(updatedAt) || updatedAt <= 0) {
      return;
    }
    const next: Record<string, number> = {};
    const table: Record<string, number> = this.loadApplied();
    const keys: string[] = Object.keys(table);
    for (const key of keys) {
      next[key] = table[key];
    }
    next[instanceId] = updatedAt;
    this.commitApplied(next);
  }

  /** typed 问题码：坏信封 / 存储不可用；UI 只展示中文，不回显指纹以外的凭据。 */
  lastProblem(): PinProblem {
    this.load();
    return this.problem;
  }

  /** 已应用表的 typed 问题码（坏信封 / 存储不可用）。 */
  lastAppliedProblem(): PinProblem {
    this.loadApplied();
    return this.appliedProblem;
  }
}

/** 全局单例（页面 / 服务共用同一份内存镜像与持久键）。 */
export const remoteAnnounceStore: RemoteAnnounceStore = new RemoteAnnounceStore();

// ============================================================================
// ArkTS cryptoFramework Ed25519 验签适配器（隔离层）
// 平台差异 / API 异常全部吞成 false；只有 verifySync(...) === true 才放行。
// 验签材料来源：本模块只消费已钉住的值（64 位十六进制 Ed25519 公钥）；密钥生成 / 分发 / 轮换
// 是 docs/REMOTE-DISCOVERY.md 的 Q1（待定），不在 wiring 模块里发明。钉值不是 32 字节时
// hexToBytes 长度校验失败 ⇒ false（fail-closed）。
// 本批无 DevEco / 未装机：编译与真机行为 unverified，留给 Designer 的 wave 构建验证。
// ============================================================================

/** 十六进制字符串 → 字节；非法形态返回空数组（调用方据此 fail-closed）。 */
function hexToBytes(hex: string): Uint8Array {
  const text: string = typeof hex === 'string' ? hex.trim() : '';
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(text)) {
    return new Uint8Array(0);
  }
  const out: Uint8Array = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * 规范载荷（ASCII 子集：instanceId / scheme / host / tokenId / nonce / 数字均为安全字符）→ 字节。
 * 不引入字符串编码依赖，保证平台差异不会改变验签字节。
 */
function asciiBytes(text: string): Uint8Array {
  const src: string = typeof text === 'string' ? text : '';
  const out: Uint8Array = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = src.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * 构造注入模型的 `SignatureVerifier`：publicKey / signature 均以 *hex* 传入。
 * - 公钥必须 32 字节、签名必须 64 字节（Ed25519 定长），否则直接 false；
 * - convertKeySync / initSync / updateSync / verifySync 任一异常 ⇒ false；
 * - 结果严格 `=== true` 才返回 true，杜绝「平台返回真值对象」被误判通过。
 */
export function createEd25519Verifier(): SignatureVerifier {
  return (payload: string, signature: string, publicKey: string): boolean => {
    try {
      const pubBytes: Uint8Array = hexToBytes(publicKey);
      const sigBytes: Uint8Array = hexToBytes(signature);
      if (pubBytes.length !== 32 || sigBytes.length !== 64) {
        return false;
      }
      // SDK 26 只有同步工厂 createAsyKeyGenerator（无 ...Sync 后缀）；返回类型本身是确定的
      const generator = cryptoFramework.createAsyKeyGenerator('Ed25519');
      const keyPair = generator.convertKeySync({ data: pubBytes }, null);
      const verify = cryptoFramework.createVerify('Ed25519');
      verify.initSync(keyPair.pubKey);
      verify.updateSync({ data: asciiBytes(payload) });
      // SDK 26 签名 verifySync(data: DataBlob | null, signatureData: DataBlob)：
      // 数据已由 updateSync 送入，首参按契约传 null（仍 fail-closed：异常一律 false）
      const result: boolean = verify.verifySync(null, { data: sigBytes });
      return result === true;
    } catch {
      // 平台差异 / API 不存在 / 密钥格式错误 —— 一律按「验签失败」处理，绝不按通过
      return false;
    }
  };
}
