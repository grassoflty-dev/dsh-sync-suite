# 三态与按钮组件契约（STATE-UI）

> 本轮（A 批）定稿的**唯一技术方案**。执行子代理按本文实现，评审按本文验收。
> 与 `docs/UI-DESIGN.md`（视觉令牌）、`docs/CONTRACT.md` §3.4（三态语义）叠加生效；
> 冲突时以本文为准（本文更新）。

## 0. 为什么要有这一批

`components/StateView.ets` 已能画 loading/empty/error，但存在四个结构性问题：

1. **加载中不可取消**：外部调用（Git、AI、远程探测）一旦卡住，用户只能杀 App；
2. **空态可以只有一句「暂无数据」**：没有下一步动作，用户卡死；
3. **错误态没有诊断信息**：用户反馈「同步失败」时，版本 / 设备 id / 错误码 / 时间全无；
4. **按钮禁用后没有任何反馈**：`.enabled(false)` 会吞掉点击，用户不知道为什么点不动。

本批把这四点变成**组件契约 + 纯函数 + 静态断言**，让后续所有人无法再写回旧形态。

## 1. 文件与职责

| 文件 | 类型 | 职责 |
|---|---|---|
| `entry/src/main/ets/common/version.ts` | 纯常量 | `APP_VERSION`（必须与 `AppScope/app.json5` 的 `versionName` 一致，有静态测试钉住） |
| `entry/src/main/ets/model/stateView.ts` | 纯逻辑（零 SDK import） | 三态枚举、加载可取消判定、诊断行格式化、失败三段式文案、空态必须有动作的校验 |
| `entry/src/main/ets/model/actionButton.ts` | 纯逻辑（零 SDK import） | `resolveButton()`：可用性/忙碌/不可用原因/透明度；`blockedTapText()`：点不动时该说什么 |
| `entry/src/main/ets/components/state/LoadingState.ets` | 组件 | 进度 + 文案；超过 **3000ms** 出现「取消」；`onCancel` 由页面提供 |
| `entry/src/main/ets/components/state/EmptyState.ets` | 组件 | **一句说明 + 一个下一步按钮**；没有动作就渲染兜底动作，不允许死界面 |
| `entry/src/main/ets/components/state/ErrorState.ets` | 组件 | 「发生了什么 / 为什么 / 下一步」三段 + **可复制诊断行** + 重试 |
| `entry/src/main/ets/components/state/StateView.ets` | 组件（调度器） | 新 API：`kind` + 取消/诊断/动作三件套，内部转调上面三个 |
| `entry/src/main/ets/components/StateView.ets` | **保持不动**（历史兼容） | 旧调用点（`RecordDetailView` / `RecordEditorView` / `EmptyState`）继续用它；`tools/test/copy.test.mjs` 对它的内部构件有 30 条断言，本轮不动它，**新代码一律用 `components/state/`**。两套并存是刻意的：旧件只管「块内三态」，新件才带取消 / 诊断 / 动作契约。 |
| `entry/src/main/ets/components/ActionButton.ets` | 组件 | 全站唯一按钮：`enabled` + `disabledReason` + `busy` + `variant` |

**为什么模型放 `model/` 而不是 `components/`**：`components/*.ets` 带 struct，Node 单测读不了；
纯逻辑必须能被 `node --test` 直接跑（仓库既有约定，见 `model/exportImport.ts` / `model/syncGuard.ts`）。

## 2. `model/stateView.ts` 契约

```ts
export const STATE_LOADING: string = 'loading';
export const STATE_EMPTY: string = 'empty';
export const STATE_ERROR: string = 'error';

/** 加载超过这么久才允许取消（毫秒）。 */
export const CANCEL_AFTER_MS: number = 3000;

/** 是否已到「可以取消」的时刻：非法/负数按 0 处理。 */
export function canCancelLoading(elapsedMs: number): boolean;

/** 加载进度文案：progress<0 → '正在处理…'；0..100 → '正在处理 42%…'（夹取 + 取整）。 */
export function progressText(progress: number): string;

export interface DiagnosticsInput {
  version: string;    // 例 '1.0.0'
  deviceId: string;   // 例 'device-2'；空 → '未登记'
  errorCode: string;  // 例 'E_GIT_TIMEOUT'；空 → '无'
  timestamp: number;  // 毫秒时间戳；非法 → 用调用方给定的 now
}
/** 单行诊断：`版本 1.0.0 · 设备 device-2 · 错误码 E_GIT_TIMEOUT · 2026-11-18 20:41:05` */
export function formatDiagnostics(input: DiagnosticsInput, now?: number): string;

/** 失败三段式：`<what>失败：<why>。下一步：<next>`（幂等；缺项不编造）。 */
export function describeFailure(what: string, why: string, next: string): string;

/** 空态有出路：真按钮，或没有可点的东西时给一句事实；返回问题说明（空串 = 合规）。 */
export function emptyStateIssue(
  title: string,
  actionLabel: string,
  showAction?: boolean,   // 默认 true：仍然渲染按钮；false = 显式不渲染按钮
  detail?: string         // showAction === false 时必须给一句事实（非空白、非已知占位符）
): string;
```

**硬约束（单测钉住）**

- `formatDiagnostics` 四个字段**永远四个都在**（缺失用兜底词，不允许省略段）；
- 时间格式固定 `YYYY-MM-DD HH:mm:ss`（本地时区由调用方决定，函数只吃时间戳）；
- `describeFailure` 幂等：`f(f(x)) === f(x)`；`why` 为空时写「原因未知」，`next` 为空时写「重试，或到设置页检查配置」；
- `emptyStateIssue` 分两支判定：`showAction !== false` 时，**标题像空态**（含「暂无 / 没有 / 空」）且
  `actionLabel` 为空 → 返回问题；`showAction === false` 时，`detail` 必须是一句事实，**空白**或命中
  `PLACEHOLDER_DETAILS`（`暂无数据` / `暂无内容` / `-` / `—` / `…` / `...` / `暂无` / `无` / `空` 等，
  **exact match**，绝不做子串扫描——否则「还没有配置仓库」这种诚实句子会被误杀）→ 返回问题。
  这一步是**词法检查**：它能拒绝空白与已知占位符，但**不能**判断一句话是不是真的。

## 3. `model/actionButton.ts` 契约

```ts
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonState {
  /** 视觉与命中：true = 可点且真的会执行动作。 */
  tappable: boolean;
  /** 是否忙碌（标签切成「处理中…」并禁止重复触发）。 */
  busy: boolean;
  /** 不可用原因（永远非空当 tappable=false；这是「点了给原因」的文案来源）。 */
  blockedReason: string;
  /** 透明度：可点 1 / 忙 0.5 / 不可用 0.4（视觉必须明显不同）。 */
  opacity: number;
}

export function resolveButton(enabled: boolean, busy: boolean, disabledReason: string): ButtonState;

/** 用户点到不可用按钮时该 toast 什么；可点/忙碌时返回空串（忙碌有事中提示，不重复 toast）。 */
export function blockedTapText(state: ButtonState): string;
```

**语义（与旧代码的差别，务必照做）**

- `ActionButton` **绝不使用 `.enabled(false)`**：ArkUI 的 `.enabled(false)` 会吞掉 `onClick`，
  而这批的产品要求是「点不动 → 必须告诉用户为什么」。实现方式：始终可点，`onClick` 内先看
  `state.tappable`，不可用时 `promptAction.showToast({ message: blockedReason })` 且**不**执行业务回调。
- `busy=true` 时标签自动加「…」并由组件内部忽略重复点击（调用方不必再判 `busy`）。
- 不可用原因兜底：`enabled=false` 且 `disabledReason` 为空 → `'当前不可用，请稍后再试'`（绝不静默）。
- 透明度与背景：不可用时 `primary` 背景降为 `brand_soft`、文字 `brand`；`secondary`/`ghost` 只降透明度。
  视觉差异是**断言项**（静态测试要求 `opacity` 与 `backgroundColor` 都随状态变化）。

## 4. 组件契约

### 4.1 `LoadingState`

props：`title`（默认 `loadingText('')`）、`detail`、`progress`（-1 = 不确定）、`onCancel`（null = 不允许取消）、
`compact`。组件自己用 `setInterval(500ms)` 累计 `elapsedMs`，到 `CANCEL_AFTER_MS` 才渲染「取消」按钮；
`aboutToDisappear` 必须 `clearInterval`（泄漏会被测试抓：静态断言 `clearInterval` 存在）。
取消后文案切「正在取消…」，**不自行把页面置回空闲**（由页面在回调里决定，避免假成功）。

### 4.2 `EmptyState`

props：`title`、`detail`、`actionLabel`、`onAction`、`showAction`（默认 `true`）。
`showAction !== false` 时行为不变：`actionLabel` 为空回落到 `'刷新'`，照常给按钮。
`showAction: false` 是**显式**退出按钮的唯一方式（绝不从空串推断）：此时不渲染按钮、也不渲染禁用态，
出路由 `detail` 的一句事实承担（`emptyStateIssue` 会拒绝空白与已知占位符）。
**契约是「空态有出路：真按钮，或没有可点的东西时给一句事实」**，不再是「永远有按钮」；
产品规则是**不要有同步或导出按钮**，所以「没有可点的东西」是合法空态。

### 4.3 `ErrorState`

props：`what`（发生了什么）、`why`（为什么）、`next`（下一步）、`diagnostics`（`formatDiagnostics` 的产物）、
`onRetry`、`onOpenSettings`（可选，第二出路）、`compact`。
渲染顺序固定：**红色标题 → 为什么 → 下一步 → 诊断块（灰底、等宽、`copyOption(CopyOptions.LocalDevice)` 长按复制）→ 按钮行**。
诊断块上方必须有一行 `长按可复制诊断信息`（用户不知道能长按等于没有）。

## 5. 三态覆盖矩阵（A 批验收对象）

| 异步动作 | 落点文件 | loading | empty | error |
|---|---|---|---|---|
| 同步（pull / push / status） | `components/settings/SyncSection.ets` + `pages/Settings.ets` | 同步中进度 + 5s 后可取消 | 未配置仓库 → 「去填地址」 | 失败三段式 + 诊断 + 重试 |
| 导出 / 导入 | `components/ExportImportPanel.ets` | 导出中进度 + 可取消 | 区间内 0 条 → 「换个区间」 | 写文件失败 + 诊断 + 重试 |
| AI 生成 | `pages/Index.ets` + `components/AiFallbackPanel.ets` | 生成中进度 + 可取消 | 没选中记录 → 「先勾选」 | 模型失败（含 `aiFallback` 降级链）+ 诊断 + 重试 |
| 远程连接 | `pages/RemoteControl.ets` + `components/settings/RemoteSection.ets` | 地址解析 + Web 首帧 | 无地址 → 「去设置」 | 加载失败（含 `-173`）→ 重试 / 浏览器打开 |
| chat 拉取 | `pages/Chats.ets` + `pages/ChatDetail.ets` | 读取中 + 3s 可取消 | 无会话 → 「怎么导出」 | 读取失败 + 诊断 + 重试 |

**覆盖判据（机器可读，见 §6）**：上表每个文件必须同时出现 `LoadingState(`、`EmptyState(`、`ErrorState(`
（或经 `StateView` 以 `kind: 'loading'|'empty'|'error'` 三态各一次）；缺一个即测试红。

## 6. 静态断言（`tools/test/interactionGuards.test.mjs`）

1. **禁止裸 `Text` 当按钮**：`pages/**` 与 `components/**`（除 `components/state/**`）里，
   `Text(...)` 后跟 `.onClick(` 的调用点 = 违规。白名单只允许两类，且每条要写理由：
   - `components/PageLayout.ets` 的 `‹` / 头部动作 / 「更多」（导航文字链，不是动作按钮）；
   - 已在 `docs/STATE-UI.md` 登记的历史例外（本轮要求清零，初始为空）。
2. **ActionButton 装配完整**：每个 `ActionButton({ … })` 调用点必须传 `label` / `enabled` /
   `disabledReason` / `onTap`（用 `helpers/structureGuards.mjs` 的 `passedKeys` 判定）。
3. **聊胜于无的禁用不算禁用**：`.enabled(false)` 与 `ActionButton` 不得同时出现在同一调用点附近
   （防止有人在 ActionButton 外面再包一层禁用，把「点了给原因」又吞掉）。
4. **三态覆盖矩阵**：按 §5 表逐文件断言三个组件名都出现，并打印实际命中次数。
5. **诊断四要素**：`ErrorState(` 的调用点必须传 `diagnostics:`（不允许空错误态）。
6. **版本一致**：`common/version.ts` 的 `APP_VERSION` === `AppScope/app.json5.versionName`。
7. **可取消实现完整**：`components/state/LoadingState.ets` 必须同时含 `setInterval` 与 `clearInterval`，
   且 `CANCEL_AFTER_MS` 由 model 提供（不允许组件里写字面量 3000）。

## 7. 交付门槛

- `node --test "packages/*/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"` 全绿（基线 1964 起，只增不减）；
- `node apps/arkui-schedule/tools/validate-app.mjs` → 8/8；
- `powershell -File apps/arkui-schedule/tools/build-harmony.ps1` → `BUILD SUCCESSFUL`（**不装机**，`hdc list targets` 为 `[Empty]`）；
- `docs/REVIEW-state-ui.md`：独立执行子代理只读评审结论（作者不自评）。
