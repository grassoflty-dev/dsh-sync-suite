# AI 多源 fallback（主源失败 → 按用户配置的备用顺序重试）

> 代码：`model/aiFallback.ts`（纯决策层）· `services/aiFallbackRunner.ets`（真调用）·
> `components/AiFallbackPanel.ets`（设置页 UI）· `tools/test/aiFallback.test.mjs`（决策表钉子）。
> 设置键见 `services/settingsStore.ets`：`aiFallbackEnabled` / `aiFallbackMaxAttempts` / `aiFallbackOrder`。

## 1. 为什么

现有 `aiRequest.runWithFallback` 只能「主源 → 一个备用源，且只切一次」，且备用源是三个独立字段
（`aiFallbackProviderId` / `aiFallbackModel` / `aiFallbackKey`），用户既不能排顺序，也看不到
「到底试了谁、为什么换、等了多久」。本模块把这件事拆成三层：

1. **决策层**（`model/aiFallback.ts`，零 SDK import）：一张决策表 + 一个规划函数，Node 直接可测；
2. **运行器**（`services/aiFallbackRunner.ets`）：串行发请求，每次尝试前重读设置，逐条回调诊断；
3. **UI**（`components/AiFallbackPanel.ets`）：开关 + 备用源列表 + 上次运行诊断，**纯展示 + 回调**。

## 2. 决策表（`classifyAttempt`）

| 情况 | outcome | 理由 |
| --- | --- | --- |
| `ok===true` | `success` | 直接返回 |
| 401 / 403（鉴权/配额拒绝） | `next-source` | 同一个源重试没意义，换源 |
| 429（限流） | `next-source` | 换源避免继续打同一家 |
| 超时（`kind==='timeout'` 或伪状态码 `-1`） | `next-source` | 无法判断何时恢复 |
| 网络错误（`kind==='network'` 或伪状态码 `0`） | `next-source` | 无法判断何时恢复 |
| 5xx（500–599） | `next-source` | 服务端故障 |
| 解析失败（`kind==='parse'`，可能是 HTTP 200） | `next-source` | 返回体不可用，别的源通常能给正文 |
| 其它 4xx（400 / 402 / 404 / 422 / 499 …） | `abort` | **我们自己的请求**有问题，换源也一样错，别浪费额度 |
| 本地配置问题（`kind==='config'`：缺 key / 地址非法 / 未知源） | `next-source` | 每个源有独立配置，且**一个字节都没发出去** |
| 其它（无状态码且无类别 / 3xx / 2xx 但 `ok=false`） | `abort` | 无法证明「换源有用」时保守停下 |
| `retry-same` | 保留 | 当前决策表**从不产出**；运行器仍限制了同源重试次数（防死循环） |

判定顺序：`kind` 先于 `status`（否则「HTTP 200 + 解析失败」会被误判成 abort）。

## 3. 规划规则（`planFallback(sources, enabled, maxAttempts)`）

- `enabled=false` → **只**返回 `sources[0]`（没有主源 → `[]`）。这是隐私红线，见 §6；
- 去重：同 `providerId + modelId` 只留第一次（provider 大小写不敏感；`baseURL` 不参与去重）；
- 尝试次数夹到 `1..去重后源数`，硬上限 `MAX_ATTEMPTS_LIMIT = 4`（主源 + 3 个备用源）；
- `sources[0]` 恒为主源；备用列表里重复出现的主源会被上面的去重规则吃掉（运行器另有
  `sourcesFromSettings()` 显式过滤一次，双保险）。

## 4. 设置项

| 键 | 类型 | 默认 | 归一 |
| --- | --- | --- | --- |
| `aiFallbackEnabled` | boolean | `false` | 非布尔 → `false` |
| `aiFallbackMaxAttempts` | number | `2` | `normalizeMaxAttempts`：夹到 `1..4`，NaN/非数 → `2` |
| `aiFallbackOrder` | string(JSON) | `''`（= `[]`） | `parseFallbackOrder` 逐条丢弃坏数据，再 `serializeFallbackOrder` 规范化后落盘 |

顺序串形态：

```json
[{"providerId":"opencode-go","modelId":"deepseek-v4-pro"},{"providerId":"codex","modelId":"gpt-5.1"}]
```

坏数据（非 JSON / 非数组 / 条目缺 `providerId` / **源 id 不在预设表**）一律丢弃；
未知源 id 会被丢弃而不是回退到 `deepseek`——`findProvider` 对未知 id 会静默回落默认源，
若沿用它，一个拼错的 id 会变成「把内容发给用户没选的供应商」。

主源仍是既有三项：`aiProviderId` / `aiModel` / `aiBaseURL`。备用顺序里**不应包含主源**。

## 5. 运行器行为（`runWithFallback`）

```ts
const result = await runWithFallback(payload, sources, {
  enabled: true,
  maxAttempts: 3,
  onAttempt: (d) => { diagnostics.push(d); }   // 已脱敏，可直接显示
});
// 成功：{ ok:true, reply, usedSource, diagnostics, usage }
// 失败：{ ok:false, lastError, diagnostics }（不抛异常）
```

- **串行**：逐个源发请求，绝不并发（同一份日程内容不会同时发给多家）；
- **每次尝试前重读设置**（`settingsStore.load()`，每次重新 `prefs.get`）：用户中途关掉 fallback，
  下一轮只剩主源，立即生效；顺序与次数也用最新值重新 `planFallback`；
- 两层开关取「都开」：`options.enabled && settings.aiFallbackEnabled`，任一层说关就关（fail-closed）；
- 诊断经 `sanitizeDiagnostic` 后逐条交给 `onAttempt`；回调抛异常不会打断流程；
- 全部失败时 `lastError` 是最后一次尝试的中文原因（已脱敏）。

## 6. 隐私红线

- **未开启 fallback 时绝不外发**：`planFallback(enabled=false)` 只返回主源，运行器在外发前
  还会用「设置里的开关」再判一次（两层 AND），因此「界面上关了但设置没保存」也不会漏发；
- **诊断不落盘**：`FallbackDiagnostic` 只存在于内存（`diagnostics` 数组 + 组件 `@Prop`），
  不进 `preferences`、不进 Git 同步载荷、不进 `schedules/*.jsonl`（见 `docs/DATA-CONTRACT.md` §8）；
- **脱敏**：`sanitizeDiagnostic` 把 `sk-…`、`Bearer <凭据>`、`api_key=…`、`token=…` 以及残留的
  `key` / `token` / `secret` 单词替换成 `***`，message 截断到 200 字符；
- **key 只出现在 `Authorization` 头里**：不打印、不进诊断、不进返回值；全文件没有 `console.*`；
- 未知源 id 不会被静默改投默认源（见 §4 最后一段）。

## 7. 已知限制 / 待决策

1. **备用源共用一个 key**：设置里只有一个 `aiFallbackKey`，三个备用源（可能属于不同厂商）
   只能共用一个密钥。若要「每个备用源各自一把 key」，需要把 `aiFallbackOrder` 的元素扩成
   `{providerId, modelId, baseURL, keyRef}` 并让设置页多一个密码框——属于设置模型变更，未在本轮做。
2. **402（余额不足）按 4xx 归入 `abort`**：符合「4xx 其它 → abort」的字面规则，但 `402` 换源
   其实常常有效。要改成 `next-source` 只需在 `classifyAttempt` 加一行，测试同步加一条。
3. **诊断列表只有「上一次」**：面板显示的是父页面传进来的最近一次运行结果，不保留历史。
4. **组件挂载由设置页负责**：本轮不改 `pages/Settings.ets`，挂载片段见 §8。

## 8. 挂载片段（给 `pages/Settings.ets`）

```ts
import { AiFallbackPanel } from '../components/AiFallbackPanel';
import { parseFallbackOrder, serializeFallbackOrder, sourceLabel } from '../model/aiFallback';
import type { FallbackDiagnostic, FallbackSource, FallbackSourcePatch } from '../model/aiFallback';

// @State（在 Settings 里）
//   @State aiFallbackEnabled: boolean = false;
//   @State aiFallbackSources: FallbackSource[] = [];
//   @State aiFallbackMaxAttempts: number = 2;
//   @State aiFallbackDiagnostics: FallbackDiagnostic[] = [];
// 读取：this.aiFallbackEnabled = settings.aiFallbackEnabled;
//       this.aiFallbackSources = parseFallbackOrder(settings.aiFallbackOrder);
//       this.aiFallbackMaxAttempts = settings.aiFallbackMaxAttempts;
// 保存：aiFallbackEnabled: this.aiFallbackEnabled,
//       aiFallbackMaxAttempts: this.aiFallbackMaxAttempts,
//       aiFallbackOrder: serializeFallbackOrder(this.aiFallbackSources),

AiFallbackPanel({
  enabled: this.aiFallbackEnabled,
  sources: this.aiFallbackSources,
  maxAttempts: this.aiFallbackMaxAttempts,
  diagnostics: this.aiFallbackDiagnostics,
  primaryLabel: sourceLabel({ providerId: this.aiProviderId, modelId: this.aiModel }),
  onToggle: (isOn: boolean): void => { this.aiFallbackEnabled = isOn; },
  onAdd: (): void => { this.addFallbackSource(); },
  onRemove: (index: number): void => { this.removeFallbackSource(index); },
  onMove: (index: number, offset: number): void => { this.moveFallbackSource(index, offset); },
  onChange: (index: number, patch: FallbackSourcePatch): void => { this.patchFallbackSource(index, patch); },
  onMaxAttempts: (value: number): void => { this.aiFallbackMaxAttempts = value; }
})
```

生成汇总时把源序列交给运行器（`sources[0]` 是主源，其余是备用源，主源已被过滤）：

```ts
const settings = await settingsStore.load(context);
const result = await runWithFallback(
  payload,
  sourcesFromSettings(settings),
  { enabled: settings.aiFallbackEnabled, maxAttempts: settings.aiFallbackMaxAttempts,
    onAttempt: (d: FallbackDiagnostic): void => { this.aiFallbackDiagnostics = [...this.aiFallbackDiagnostics, d]; } }
);
```
