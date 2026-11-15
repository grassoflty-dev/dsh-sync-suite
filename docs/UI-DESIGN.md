# UI 设计规范与重构方案（UI-DESIGN）

> 需求：**「页面太丑太繁杂了，而且还要支持竖屏和横屏两种 UI。」**
> 方向（已定）：白底 + 单一强调色 `$r('app.color.brand')` + 细分割线；去掉多余卡片/阴影/边框；每屏 1 个主操作，
> 其余进「更多」；字号 3 级；触控 ≥40vp；深色跟随系统；不新增配置项。
> **能力边界**：模型无视觉能力，本审计**不基于截图观感**，只基于 ①`devecocli ui layout --format json` 的结构化布局
> ②源码静态统计（字号 / padding / margin / space / 圆角 / 硬编码色 / 触控尺寸）。截图仅供用户验收，**不作自动判据**。

## 1. 证据与验证边界

| 项 | 结果 |
| --- | --- |
| 设备 | `6MFBB25C27205131`（`MLR-AL00`，`deviceType=tablet`，物理 1600×2560 = 原生竖屏） |
| 取布局 | ❌ **锁屏**：只返回 `ScreenLockRootComponent` + `ContainerModal`（bounds `0,105,2560,1600`，系统显示为横屏 2560×1600）；`aa start` 成功但前台仍是锁屏。未解锁、未绕过，设备同时被 A 占用。 |
| 替代手段 | 源码静态统计（6 个页面/组件文件，脚本 `.tmp/ui-audit.mjs`），下文「现状值」均可复算 |
| 未验证 | 真机横/竖屏布局、截图、深色实机渲染（锁屏 + 旋转生效需重新构建） |

## 2. 量化阈值：现状 → 目标

> 格式：**指标 → 现状值（证据）→ 目标 → 改法**；行号为「改前」源码行。

| # | 页面 | 指标 | 现状值（证据） | 目标 | 改法 |
| --- | --- | --- | --- | --- | --- |
| 1 | Index | 同屏主操作数 | **4**：新建/AI 汇总/同步/提醒并排（:611-640） | **1** | 新建唯一实底；其余进「更多」 |
| 2 | Index | 触控目标 | **8 个 <40vp**：`‹`/`›`/`今天`=36vp（:335-370）、模式片 ≈29vp（padding6+14fp，:394-425）、AI 面板`全选`/`关闭` ≈18vp（:476-479、:570-574） | ≥40vp | 图标 40×40；模式片 `height(TOUCH_MIN)`；文本动作补 `height(40)+padding(md)` |
| 3 | Index | 字号层级 | **6 档**：11/12/13/14/16/18 | 3 档 | 见 §3 映射 |
| 4 | Index | 卡片/阴影/色 | `AiPanel` `shadow(radius:24)`+`borderRadius(16)`（:553-557）；圆角 16×4、14×1；硬编码 `#E8F1FF`×5 等 | 无阴影直角、全走 `$r()` | 浮层 `surface`+`RADIUS.md`，删 `.shadow()` |
| 5 | Index | 间距 | **16 处越界**：14×4、6×4、5×2、10×3、2×2 | 0 处 | 收敛 4/8/12/16/24 |
| 6 | Index | 辅助信息行 | **3 行**重复：`点击选择日期`(11fp:348)+模式行计数(12fp:426)+状态行(12fp:606) | 1 行 | 统计句只留标题栏副标题 |
| 7 | Edit | 主操作数 | **2 个保存入口**：顶部`保存`36vp（:240-244）+ 底部`保存修改`46vp（:369-375） | 1 | 只留标题栏「保存」 |
| 8 | Edit | 触控目标 | **3 个 <40vp**：返回`‹`26fp 无盒 ≈31vp（:228-234）、`保存`36vp、`手写板`chip ≈25vp（:271-277） | ≥40vp | 统一 40×40 返回；手写入口 40vp 行 |
| 9 | Edit | 横屏/圆角 | `TextArea` 固定高 220（:282-284）无断点；`borderRadius(10)`×4（:260/286/315/339） | 双栏 + 0/8 | 横屏左表单/右预览（§4）；输入框改 1vp 下边线 |
| 10 | Detail | 卡片层数 | **5 层白卡片** + `borderRadius(12)`（:286-302/304-320/322-367/369-385/195-250） | 0 卡片 | 区块只用 1vp 分割线 + 标题 |
| 11 | Detail | 主操作数 | **3**：`编辑`34vp(:268)、`AI 结构化`(:339)、`保存`30vp(:329) | 1 | AI 结构化进「更多」 |
| 12 | Detail | 字号/密度 | **8 档** 10/11/12/13/14/18/20/26；每页渲染 `#pageIndex sha256 name` 10fp 技术串（:230-243） | 3 档 | 哈希列表删除（仅在「更多→附件信息」可选） |
| 13 | Settings | 卡片/按钮数 | **5 个白卡片**（:557/655/706/789/946）+ **7 按钮**（同步区 4 个并排 :580-622） | 3 组 × ≤4 行，1 主操作/组 | 同步/AI/关于；见 §4.1 |
| 14 | Settings | 字号/触控 | **6 档** 11/12/13/14/15/18；11fp 小字 10 处；4 个 chip ≈29vp（:736-753、:766-784） | 3 档 / ≥40vp | 说明统一 `FONT.caption`；chip `height(TOUCH_MIN)` |
| 15 | Settings | 重复文案/密度 | **3 条同义隐私说明**（:894/962/1012）；AGC 5 步长文 8 行（:710-719） | 各 1 条、≤2 行 | 合并进「关于」+ `?` 弹层 |
| 16 | RecordRow | 触控目标 | `Checkbox` **显式 24×24**（:50-56） | 40×40 | `.width(TOUCH_MIN).height(TOUCH_MIN)` |
| 17 | EmptyState | 字号/留白 | emoji **48fp**（:16-18）+ 上下 `padding 48`（:35） | 无装饰图标 | 删 emoji，正文+辅助两行，上下 24 |
| 18 | 全局 | 深色模式 | 只有 `resources/base/element/color.json`，**无 `dark/`** | 跟随系统 | 新增 `resources/dark/element/color.json`（14 令牌） |
| 19 | 全局 | 方向/断点 | ability **无 `orientation`**（应用不跟随旋转）；5 页全单列、**0 处断点判断** | 横竖屏 + 3 档断点 | `"orientation": "auto_rotation"` + `PageLayout` 统一算断点（§4） |

**全局统计（6 文件）**：字号 11 种（10×1、11×20、12×24、13×25、14×8、15×1、16×4、18×5、20×2、26×4、48×1）；
间距越界 **45 处**（1×1、2×3、5×2、6×17、10×7、14×12、48×2）；硬编码色 **24 处**
（`#E8F1FF`×12、`#F7F9FB`×6、`#EEF1F4`×3、`#D94838`×3、`#FFF3E6`、`#B26A00`×2、`#8A93A0`、`#22000000`、`#66000000`、`#CCFFFFFF`、`#000000`）。

## 3. 设计令牌（唯一来源 `common/uiTokens.ts`）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `SPACING.xs/sm/md/lg/xl` | 4 / 8 / 12 / 16 / 24 | 唯一五档间距，页面禁写其它值 |
| `RADIUS.none/sm/md` | 0 / 8 / 12 | 卡片·行·分割区=`none`；按钮·输入=`sm`；浮层=`md` |
| `FONT.title/body/caption` | 20 / 16 / 14 | 只有三级 |
| `LINE_HEIGHT.*` | 28 / 24 / 20 | 与字号一一对应 |
| `TOUCH_MIN` / `DIVIDER` | 40 / 1 | 最小触控边长 / 分割线宽 |

**字号合并映射（11 种 → 3 种）**：10/11/12/13/14 → `caption` 14；15/16/18 → `body` 16（页头标题 → `title` 20）；
20/26 → `title` 20（返回箭头改 40×40 点击区，不再靠 26fp 撑大）；48（emoji）→ **删除**。

**颜色收敛（1 强调 + 4 中性 + 分割线 + 语义色，全部 `$r('app.color.*')`）**

| 现值 | 出现 | 映射 |
| --- | --- | --- |
| `#E8F1FF` | 12 | `brand_soft`（品牌淡底） |
| `#F7F9FB` / `#EEF1F4` / `#8A93A0` | 10 | **删除**：输入框白底 + 1vp 下边线；图片占位 `divider` |
| `#D94838` | 3 | `danger` |
| `#B26A00` / `#FFF3E6` | 3 | `warning` / `warning_soft` |
| `#22000000`（阴影） | 1 | **删除**（不用阴影） |
| `#66000000` / `#CCFFFFFF` / `#000000` | 3 | `scrim` / `text_inverse` / `preview_background` |

中性 4 档：`page_background`(#FFFFFF 白底，由 `#F1F3F5` 改) / `surface`(#FFFFFF) / `text_primary`(#182431) /
`text_secondary`(#66182431)；`divider`(#33182431) 是结构色不占层级；`dark/` 覆盖同名 14 令牌
（`#000000`/`#16181A`/`#E6E8EA`/`#99E6E8EA`/`#4D9FFF`…）。已知中间态：Edit/Detail/Settings 尚未重构，白底上会短暂「白上白」。

**信息密度目标（单屏可见文本行）**：Index ≤12 / Edit ≤10 / Detail ≤18 / Settings ≤22。

## 4. 断点与栅格

| 断点 | 宽度(vp) | 列 | Index | Edit | Detail | Settings |
| --- | --- | --- | --- | --- | --- | --- |
| `compact` | <600 | 1 | 日期条→模式→列表→新建 | 表单自上而下 | 正文→附件 | 单列 3 组 |
| `medium` | 600–840 | 2 | 左右主从（左列表 / 右详情·编辑） | 单列表单 | 单列详情 | 两列分组 |
| `expanded` | >840 | 2 | 同上（主栏 360–420vp） | 同上 | 同上 | 同上 |

- **横屏特例**：`resolveBreakpoint(w, landscape)` 横屏下**至少 `medium`**（横屏拿宽度换高度，单列纵向会挤爆），
  因此页面只需 `breakpoint === 'compact'` 一个判断，不必各写方向判断。
- 侧栏宽 `sidebarWidth(contentWidth)` = 内容宽 1/3，夹 280–420vp；阈值 `600/840` 只允许出现在 `uiTokens.ts` 与 `PageLayout`。

```
Index 紧凑(竖屏)                        Index 宽屏/横屏
┌ 今天 · 共5条/完成2       更多 ┐        ┌ 今天·共5条/完成2     更多 ┐
│ ‹ 2026-11-15 周四  今天 ›   │        │ ‹date 今天› │ ○ 标题 09:30│
│ [今日待办][全部未完成]       │        │ 周四        │─────────────│
│ ───────────────────────── │        │[今日][全部] │ ○ 标题 10:00│
│ ○ 标题               09:30 │        │ ────────── │─────────────│
│ ───────────────────────── │        │ [ 新建 ]    │  ...        │
│ ○ 标题               10:00 │        │             │             │
│ ───────────────────────── │        │             │             │
│ [      新建（唯一主操作）    ] │        │             │             │
└───────────────────────────┘        └─────────────┴─────────────┘
页头动作 = ✨ AI 汇总（有汇总→打开面板；无→生成；生成中显示「✨ 生成中…」）/ ⚙ 设置；首页无「更多」与 ActionSheet。**列表第一项 = 今日汇总块**（数据源 = `summaryStore.read(date)` 持久化，`devices/<id>/summaries/<date>.json`）：标题 1 行 + 要点 ≤3（`truncateSummaryForDisplay`）+ 「更新于 HH:MM · 重新生成」；无汇总→「✨ 生成今日汇总」；今日无日程→灰字（无按钮）；失败→一行错误 + 重试（`summaryStore.generate` 保证不覆盖旧文件，失败后重新 `read()` 继续显示旧汇总）；`aboutToAppear`/换日期/回今天/回前台都重新 `read()`
```
- **宽屏 = 左右主从**：左栏（`masterPaneWidth` **360–420vp**）= 日期条 + 模式 + 今日汇总块 + 列表 + 「新建」（240vp 左对齐）；右栏 = **三态**（空 / 详情 / 编辑），内容限宽 **720vp 居中**便于阅读。点行切右栏、点「新建」右栏直接变编辑表单（不跳二级页）；选中行 = `brand_soft` 底 + **2vp 品牌竖条**；编辑有未保存内容时切行先弹「放弃当前编辑？」。详情/编辑复用 `components/RecordDetailView.ets` / `RecordEditorView.ets`（`Detail.ets`/`Edit.ets` 已退化为薄壳），避免两套 UI 漂移。

| 页 | 区块 | compact（竖屏） | medium / expanded（横屏·宽屏） | 主操作 |
| --- | --- | --- | --- | --- |
| Edit | 表单 / 预览 | 标题 → 正文 → 记录者 → 完成自上而下，附件在末尾 | 左表单、右手写与附件预览；手写入口两组都**只在鸿蒙**出现 | `保存`（底部全宽） |
| Detail | 正文 / AI / 附件 | 标题 → 正文 → AI → 原始识别 → 附件 | 左正文+AI、右附件+原始识别+元信息；哈希进「更多」 | `编辑`（底部全宽） |
| Settings | 三组 | 同步 → AI → 关于 单列 | 左同步+关于 / 右 AI；长说明 `?` 弹层 | `保存设置`（底部全宽） |

### 4.1 设置页行级契约

| 组 | 行 1 | 行 2 | 行 3 | 行 4 | 组头「更多」 |
| --- | --- | --- | --- | --- | --- |
| 同步 (Git) | 仓库地址 | token（密码框） | 设备标识 + 作者名（同行两列） | `立即同步` + **`含其他设备` 开关** + 1 行状态（超长 → `?`） | 推送 / 查看状态 / 重试上次 / 测试连接 / 平台(GitHub·Gitee) / 认证(HTTPS·SSH) |
| AI | 服务（下拉 4 源；`preset.experimental` 为真的源带「实验」标签） | 模型（下拉，`modelsOf(id)` 联动） | API Key（密码框，下方一行 `keyHint`） | `测试` + 1 行结果（`成功 · 320ms`，耗时取 `result.elapsedMs`；失败原样展示 `result.message`） | 高级（默认折叠）：**模型名可手输**（三源都允许，`custom` 必填）+ **baseURL 仅 `custom` 可编辑**；选 `custom` 时自动展开 |
| 关于 | 版本 + 上次同步 | 平台信息（平台·手写·OCR 一行） | 隐私说明 `?` | —（提醒功能已按用户要求删除） | — |

长说明一律 `?` → 一次性弹层，不再整段常驻。

**AI 源文案全部来自预设表**（`preset.label` / `keyHint` / `experimental`），页面不硬编码「订阅 / OAuth」这类说法；`codex` = API Key 模式（keyHint 自带一句说明），`opencode-go` 用 `experimental` 出「实验」标签。

**页面级主操作 = `保存设置`**（底部全宽、唯一实底按钮）；`立即同步` 与 `测试` 是品牌淡底次要按钮，推送/查看状态/重试/测试连接/平台/认证全部在组头「更多」。

**交接（给 C2 / 设置页重构者）**：`tools/test/settingsStorePairing.test.mjs` 用**源码文本正则**断言 `pages/Settings.ets`
（该测试文件我无权修改）。下面清单要么**逐字保留**，要么由有权限的人同步改测试，否则 `node --test` 必红：

| 测试行 | 必须存在（逐字） |
| --- | --- |
| :101 | `const repoEmpty: boolean = this.repoUrl.trim().length === 0;` |
| :104 | `const tokenError: string = repoEmpty ? '' : validateToken(this.authMode, this.token);` |
| :107 | `const repoError: string = repoEmpty \|\| repoCheck.ok ? '' : repoCheck.error;` |
| :108 | `repoUrl: repoEmpty ? '' : repoCheck.url,` |
| :112 | `设置已保存（${nowIso()}）；仓库地址为空，同步前需要先填写` |
| :116 | `validateRepoUrl(this.repoUrl)` **≥3 处**（saveSettings / testConnection / runAction） |
| :118 | `if (!repoCheck.ok) { this.syncMessage = \`请先修正仓库地址：${repoCheck.error}\`;` |
| :119 | `if (!repoCheck.ok) { this.connectionText = \`❌ 无法测试：${repoCheck.error}\`;` |
| :123 | `Text(describeLastSync(this.lastSyncAt, nowIso()))` |
| :124 | `if (this.lastSyncError.length > 0) { Text(\`上次错误：${this.lastSyncError}\`)` |
| :125-126 | `if (canRetrySync(this.lastSyncAction, this.syncBusy)) {` + `this.runAction(this.lastSyncAction);` |
| :156-157 | `this.aiModel = settings.aiModel;` + `aiModel: this.aiModel,`（C2 已确认 `aiModel` 语义不变，**这两行不用改**） |

Index 侧 :146-153 的断言（`settingsStore.load(` 必须早于 `await summarize(`、存在 `aiKey = settings.aiKey;`）本轮重构已保持通过，无需改动。

**AI 组接的 API 真值（C2 已落地 `model/aiProvider.ts`，6.1KB，零 import）**：
`AiProviderPreset{ id: 'deepseek'|'opencode-go'|'codex'|'custom'; label; baseURL; models: AiModelOption[]; keyHint }`、
`AI_PROVIDERS`（顺序即展示顺序，4 个）、`DEFAULT_PROVIDER_ID`、`CUSTOM_PROVIDER_ID`、`findProvider(id)`（未知/空永不返回 null）、
`modelsOf(id)`、`defaultModelOf(id)`、`resolveModel(providerId, modelId)`、`normalizeBaseURL`、`isValidBaseURL`、`chatCompletionsURL`（空/非法抛中文 Error）。
注意两点与直觉不同：**无 `defaultModel` 字段**（用 `defaultModelOf(id)`）、**无 `isCustom` 字段**（用 `preset.id === CUSTOM_PROVIDER_ID`）。
`settingsStore` 增 `aiProviderId`/`aiBaseURL` 与 `cachedProviderId()`/`cachedBaseURL()`；测试用 3 参
`testAiConnection(this.aiKey, this.aiProviderId, this.aiModel, this.aiBaseURL)`（「填了没保存」的地址也能测）。
**「高级」里不放开超时/重试**：`AI_TIMEOUT_MS=20000`、退避 1000ms、只重试 1 次是 `model/aiRequest.ts` 的固定常量，
做成开关就是改不动的假开关——与本轮「别太复杂」相反，故只保留 baseURL。

## 5. 旋转支持与手写板坐标系（只报告，不改 A 的文件）

1. **方向开关**：`module.json5` 的 EntryAbility 增 `"orientation": "auto_rotation"`（唯一字段改动）；若被平板策略限制则回落
   `auto_rotation_restricted`，并**如实记录**（本轮未验证：锁屏 + 需重新构建）。
2. **三点验证**（待构建后）：①布局重排（`onAreaChange` → 断点 compact↔medium/expanded，Index 单列↔双栏）；
   ②数据不丢（状态都在 `@State`，旋转只 relayout 不重建，写盘仍走 `appendRecord`）；③手写坐标系（下条）。
3. **手写板旋转缺陷（只报告）**：笔迹是**像素坐标**（`HandwritingPager.ets:680` `points.push({x,y})`，绘制直接用 :499-501）；
   框是**归一化坐标**（渲染 `box.x * canvasW` :1418-1420，遮白 `regionsToMaskRects` `model/regions.ts:133`）；
   画布尺寸在 `onAreaChange` 被直接替换（:1516-1519）。→ 旋转后框按新宽高比拉伸、笔迹停在旧像素位置：
   **框与笔迹错位**（遮白盖错位置，框内笔迹会被送 OCR，违反「框内不做 OCR」），且**超出新画布的笔迹在截图里永久丢失**。
4. **选方案 b（手写页锁方向 + UI 说明）**：方案 a（按新画布重投影归一化框）只能让框继续贴住旧像素墨迹，
   阻止不了墨迹被裁（属「看着修好了、实际丢数据」）；方案 b 一次 `setPreferredOrientation` 就根除两类问题，且不动坐标。
   UI 在状态行加一句「手写板固定为进入时的方向，不跟随旋转」。若产品要求手写页跟随旋转，必须先把 `Stroke.points` 归一化
   （`handwriting/**`，A 的文件），本轮**只报告未改**。

## 6. 要删掉的元素 / 文案合并

| 删除 | 位置 | 理由 |
| --- | --- | --- |
| `AiPanel.shadow(radius:24)` | Index.ets:557 | 无阴影规范 |
| `点击选择日期` 11fp + 模式行计数 | Index.ets:348-350、426-428 | 与标题栏统计重复（省 2 行） |
| 底部 3 个次按钮 + 右上「更多」ActionSheet | Index.ets（原 :618-639、MoreSheet） | AI 汇总→页头动作、同步配置→设置页；**提醒功能整条删除**（UI 调用点/状态/文案已移除，services 侧由他人删） |
| 顶部 `保存` | Edit.ets:240-244 | 与底部保存重复 |
| `#pageIndex sha256 name` 哈希列表 | Detail.ets:230-243 | 技术信息、10fp |
| AGC 提醒权限长文（8 行）/ 隐私 3 条 | Settings.ets（原 :710-719、894/962/1012） | AGC 段随「提醒」一并删除；隐私合并 1 条进 `?` |
| EmptyState emoji 48fp + 48 padding | EmptyState.ets:16/35 | 占半屏、字号越级 |
| `#F7F9FB` / `#EEF1F4` 填充 | 全局 9 处 | 白底 + 细线取代填充块 |

**合并**：平台/手写/OCR 三行 → 「平台信息」一行小字；上次错误 + 同步结果 → 一行状态 + 「更多」看详情；
仓库地址两段提示 → 交给 `repoUrlPlaceholder`（已按平台/认证变化）。

## 7. 交付状态与截图

- 已交付：`uiTokens.ts`（20 例单测）、`PageLayout.ets`、`color.json`(+`dark/`)、`module.json5` 方向字段、
  `RecordRow`/`EmptyState` 重排，以及**四个页面全部重构**：Index（日期列 / 列表双栏）、Edit（表单 / 预览双栏）、
  Detail（正文 / AI·附件双栏）、Settings（3 组 × ≤4 行 + `?` 弹层 + 高级折叠）。
- `Handwriting.ets` 由 A 做，只 import 本文件的 token；旋转锁方向方案见 §5。
- **真机 AI 源测试：未验证**（设备 `hdc list targets` 为 `[Empty]`）：三个源各点一次「测试」、把 `成功 · Nms` / 错误码贴回，需设备回来后做。
- **截图判据修正（2026-11-15 19:4x 复核）**：先前「白像素 0.9% / 无竖分割线 / 不可能是本应用」的结论**错误**——分析的是已被覆盖的旧文件（19:25 的 `ui-index-landscape.jpeg` 132,972 B，疑似退桌面误抓），且未处理 PNG 的 alpha 通道。
- 正确方法（RGBA 先合成白底再逐像素分类）重测 Lead 的 `ui-index-landscape-verified.png`（2560×1600, 147,969 B）：白 **95.4%**、品牌蓝 2.4%、浅灰 1.7%；**竖分割线 x=948（x/w=0.370，覆盖 76% 高度）**；`新建` 区域 (57,609)-(910,723) 为 **98% 品牌蓝**，右栏 (988,370) 与 (1000,700)-(2400,1400) **100% 白**。结论：**那张确实是本应用的横屏两栏**，右栏整片白正是用户第 3 点反馈的量化证据。
- **截图：未验证**。原因：设备锁屏（layout 仅 `ScreenLockRootComponent`）+ `orientation` 需重新构建生效（构建由总设计师统一执行）。
  取到后按 `docs/images/ui-<screen>-<portrait|landscape>.png` 归档并在此登记；截图仅供用户验收，不参与自动判定。
- 设备侧客观事实：物理 1600×2560、当前系统显示 2560×1600、`deviceType=tablet`；`const.product.screenDensity` 读取失败
  （errNum 106），vp 换算按 2.0 暂估——只影响落入哪个断点档，不改变布局规则。
