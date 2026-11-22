/**
 * 配置偏好存储的版本化访问层（`mod-config-persistence`，只做 IO 适配）。
 *
 * 所有判定与字节都由 `model/configSchema.ts` 的纯函数产生：本文件只负责打开 preferences、
 * 按「当前名 → 历史名」链读字节、在**确实需要**时把旧扁平表一次性写成
 * `{v:1,values:{...}}` 信封（单键 put + 一次 flush = 原子替换）。
 *
 * fail-closed：信封版本不认识 / 字节损坏 / 存储异常 → typed refuse + 零写入 + 原字节不动，
 * 绝不以默认值覆盖；所有公开方法都吞掉异常、只返回 typed 结果，不把异常抛进 UI。
 * 异步 put / flush 的 rejection 由纯层 `commitConfigWrite()` 封闭，外层再包 try/catch：
 * put 失败即不 flush 半截状态，并尽力把保留键恢复为空（旧扁平键从未被触碰），
 * 最终只给 typed refuse / wrote=false —— 启动期调用 migrateOnce() 不会变成 unhandled rejection。
 *
 * 本轮**不接入** `settingsStore.ets` / `syncController.ets`：那两个文件由其它模块占用，
 * 接线等其提交后由 Lead 显式授权。
 *
 * 接线纪律（后续模块必须遵守）：一次性重写后 `values` 信封是配置真值；后续每次保存都要
 * 写回同一信封（write-through，或整表改走本层）。若只把信封写一次、仍用旧扁平键保存，
 * 下次启动会优先命中信封而读到陈旧值——这不是本层的缺陷，而是接线时必须闭合的环路。
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import {
  CONFIG_ENVELOPE_KEY,
  commitConfigWrite,
  needsRewrite as decideRewrite,
  resolveLegacyChain,
  runWithSeam
} from '../model/configSchema';
import type {
  ConfigCandidate,
  ConfigResolution,
  ConfigStorageSeam,
  ConfigValue,
  MigrationOutcome,
  RewriteDecision
} from '../model/configSchema';

/** 一个 store 的读取规格：当前名 + 历史名（从新到旧）+ 旧扁平键清单。 */
export interface ConfigStoreSpec {
  /** 当前 preferences store 名（也是一次性重写的落点 store）。 */
  name: string;
  /** 历史 store 名，按从新到旧排列；当前名读不到值才依次尝试。 */
  legacyNames: string[];
  /** 旧扁平表里的键；只把确实有值的键并进 `values`，未知额外键同样保留。 */
  legacyKeys: string[];
}

/** 偏好值只接纳标量；数组 / 对象在这里跳过，避免把非标量写进配置信封。 */
function scalarOf(value: preferences.ValueType): ConfigValue | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

export class ConfigStore {
  private spec: ConfigStoreSpec;
  private prefs: preferences.Preferences | null = null;

  constructor(spec: ConfigStoreSpec) {
    this.spec = spec;
  }

  /** 当前 store 名（供调用方做日志 / UI 文案，不打印凭据）。 */
  storeName(): string {
    return this.spec.name;
  }

  /** 全部候选名：当前名第一，历史名随后。 */
  private names(): string[] {
    const names: string[] = [this.spec.name];
    for (const name of this.spec.legacyNames) {
      names.push(name);
    }
    return names;
  }

  /** 打开当前 store（幂等）。 */
  async init(context: object): Promise<void> {
    if (this.prefs !== null) {
      return;
    }
    const abilityContext: common.UIAbilityContext = context as common.UIAbilityContext;
    this.prefs = await preferences.getPreferences(abilityContext, { name: this.spec.name });
  }

  /** 尚未 init 时用传入 context（或全局 getContext）补一次打开。 */
  private async ensure(context?: object): Promise<preferences.Preferences> {
    if (this.prefs === null) {
      const abilityContext: common.UIAbilityContext =
        context === undefined
          ? (getContext() as common.UIAbilityContext)
          : (context as common.UIAbilityContext);
      await this.init(abilityContext);
    }
    return this.prefs as preferences.Preferences;
  }

  /** 打开任意候选 store 名（历史名可能是空壳，读不到值就换下一个）。 */
  private async openNamed(name: string, context?: object): Promise<preferences.Preferences> {
    if (name === this.spec.name) {
      return this.ensure(context);
    }
    const abilityContext: common.UIAbilityContext =
      context === undefined ? (getContext() as common.UIAbilityContext) : (context as common.UIAbilityContext);
    return preferences.getPreferences(abilityContext, { name: name });
  }

  /**
   * 收集候选字节：每个 store 先看保留信封键，再看旧扁平键拼出的 JSON 对象串。
   * 空值不进候选链（由纯函数按「当前名空 → 历史名命中」解析）。
   */
  async collectCandidates(context?: object): Promise<ConfigCandidate[]> {
    const candidates: ConfigCandidate[] = [];
    const names: string[] = this.names();
    for (const name of names) {
      const store: preferences.Preferences = await this.openNamed(name, context);
      const envelopeRaw: preferences.ValueType = await store.get(CONFIG_ENVELOPE_KEY, '');
      if (typeof envelopeRaw === 'string' && envelopeRaw.trim().length > 0) {
        candidates.push({ name: name, raw: envelopeRaw });
        continue;
      }
      const flat: Record<string, ConfigValue> = {};
      for (const key of this.spec.legacyKeys) {
        const value: ConfigValue | null = scalarOf(await store.get(key, ''));
        if (value !== null) {
          flat[key] = value;
        }
      }
      if (Object.keys(flat).length > 0) {
        candidates.push({ name: name, raw: JSON.stringify(flat) });
      }
    }
    return candidates;
  }

  /** 读侧异常的 typed 结果：只返回，不抛。 */
  private unavailable(name: string): ConfigResolution {
    const resolution: ConfigResolution = { kind: 'storage-unavailable', name: name, tried: [] };
    return resolution;
  }

  /** 现行信封的 schema 版本；legacy / 未知版本 / 坏字节都返回 null（细节见 resolution）。 */
  async schemaVersionOf(context?: object): Promise<number | null> {
    try {
      const candidates: ConfigCandidate[] = await this.collectCandidates(context);
      const resolution: ConfigResolution = resolveLegacyChain(candidates);
      if (resolution.kind === 'found' && resolution.decode.state === 'ok') {
        return resolution.decode.version;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 旧名链的 typed 结果（found / missing / version-unknown / corrupt / storage-unavailable）。 */
  async resolution(context?: object): Promise<ConfigResolution> {
    try {
      const candidates: ConfigCandidate[] = await this.collectCandidates(context);
      return resolveLegacyChain(candidates);
    } catch {
      return this.unavailable(this.spec.name);
    }
  }

  /** 是否需要一次性重写；只判定、不写盘，未知版本给出 typed refuse。 */
  async needsRewrite(context?: object): Promise<RewriteDecision> {
    try {
      const candidates: ConfigCandidate[] = await this.collectCandidates(context);
      return decideRewrite(resolveLegacyChain(candidates), this.spec.name);
    } catch {
      const resolution: ConfigResolution = this.unavailable(this.spec.name);
      return decideRewrite(resolution, this.spec.name);
    }
  }

  /** 解析出的配置值；任何拒绝态都返回空表（调用方仍有 typed resolution / rewrite 结果可查）。 */
  async readValues(context?: object): Promise<Record<string, ConfigValue>> {
    try {
      const candidates: ConfigCandidate[] = await this.collectCandidates(context);
      const resolution: ConfigResolution = resolveLegacyChain(candidates);
      return resolution.kind === 'found' ? resolution.decode.values : {};
    } catch {
      return {};
    }
  }

  /**
   * 一次性重写：经注入的存储缝跑纯决策，只在 `wrote=true` 时真正 put + flush。
   * 未知版本 / 坏字节 / 存储异常一律零写入；第二次运行读到 `{v:1,values}` 必为 no-write。
   */
  async migrateOnce(context?: object): Promise<MigrationOutcome> {
    let candidates: ConfigCandidate[];
    let store: preferences.Preferences;
    try {
      candidates = await this.collectCandidates(context);
      store = await this.ensure(context);
    } catch {
      const resolution: ConfigResolution = this.unavailable(this.spec.name);
      return { resolution: resolution, decision: decideRewrite(resolution, this.spec.name), wrote: false };
    }
    const byName: Record<string, string> = {};
    for (const candidate of candidates) {
      if (typeof candidate.raw === 'string') {
        byName[candidate.name] = candidate.raw;
      }
    }
    const pending: Array<Promise<void>> = [];
    const seam: ConfigStorageSeam = {
      read: (name: string): string | null | undefined => {
        const raw: string | undefined = byName[name];
        return raw === undefined ? null : raw;
      },
      // 落点固定为当前 store 的保留键；绝不写回历史名（历史名可能是未知版本）。
      write: (_name: string, bytes: string): void => {
        pending.push(store.put(CONFIG_ENVELOPE_KEY, bytes));
      }
    };
    const outcome: MigrationOutcome = runWithSeam(seam, this.names(), this.spec.name);
    if (outcome.wrote) {
      try {
        // 纯层守卫封闭 put / flush 的 rejection；外层 try/catch 再兜一层，启动期绝不抛。
        const commit = await commitConfigWrite(
          outcome.decision,
          async (): Promise<void> => {
            await Promise.all(pending);
            await store.flush();
          },
          async (): Promise<void> => {
            // 回滚只清空保留键（重写前它为空）；旧扁平键从未被写，原字节因此保持原样。
            await store.put(CONFIG_ENVELOPE_KEY, '');
            await store.flush();
          }
        );
        const committed: MigrationOutcome = {
          resolution: outcome.resolution,
          decision: commit.decision,
          wrote: commit.wrote
        };
        return committed;
      } catch {
        const refused: RewriteDecision = {
          kind: 'refuse',
          reason: 'storage-unavailable',
          name: this.spec.name,
          message: '配置写入失败：已保留原字节'
        };
        const failed: MigrationOutcome = { resolution: outcome.resolution, decision: refused, wrote: false };
        return failed;
      }
    }
    return outcome;
  }
}

/** 便捷单例工厂（规格由调用方给出；本模块不内置任何真实 store 名，避免误接）。 */
export function createConfigStore(spec: ConfigStoreSpec): ConfigStore {
  return new ConfigStore(spec);
}
