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
| `medium` | 600–840 | 2 | **单列列表**（点行进详情页 / 新建进编辑页） | 单列表单 | 单列详情 | 两列分组 |
| `expanded` | >840 | 2 | 左右主从（主栏 360–420vp、右栏 ≥360vp） | 同上 | 同上 | 同上 |

- **横屏特例**：`resolveBreakpoint(w, landscape)` 横屏下**至少 `medium`**（横屏拿宽度换高度，单列纵向会挤爆），
  因此页面只需 `breakpoint === 'compact'` 一个判断，不必各写方向判断。
- 侧栏宽 `sidebarWidth(contentWidth)` = 内容宽 1/3，夹 280–420vp；阈值 `600/840` 只允许出现在 `uiTokens.ts` 与 `PageLayout`。

```
Index 紧凑(竖屏)                        Index 宽屏/横屏
┌ 今天 · 今日3条            ⚙ 设置 ┐       ┌ 今天·今日3条         ⚙ 设置 ┐
│ ‹ 2026-11-15 周四  今天 ›   │        │ ‹date 今天› │ ○ 标题 09:30│
│ [今日][未完成]              │        │ 周四        │─────────────│
│ ───────────────────────── │        │[今日][未完成]│ ○ 标题 10:00│
│ ○ 标题               09:30 │        │ ────────── │─────────────│
│ ───────────────────────── │        │ [ 新建 ]    │  ...        │
│ ○ 标题               10:00 │        │             │             │
│ ───────────────────────── │        │             │             │
│ [      新建（唯一主操作）    ] │        │             │             │
└───────────────────────────┘        └─────────────┴─────────────┘
页头动作 = ✨ AI 汇总（有汇总→打开面板；无→生成；生成中显示「✨ 生成中…」）/ ⚙ 设置；首页无「更多」与 ActionSheet。**列表第一项 = 今日汇总块**（数据源 = `summaryStore.read(date)` 持久化，`devices/<id>/summaries/<date>.json`）：标题 1 行 + 要点 ≤3（`truncateSummaryForDisplay`）+ 「更新于 HH:MM · 重新生成」；无汇总→「✨ 生成今日汇总」；今日无日程→灰字（无按钮）；失败→一行错误 + 重试（`summaryStore.generate` 保证不覆盖旧文件，失败后重新 `read()` 继续显示旧汇总）；`aboutToAppear`/换日期/回今天/回前台都重新 `read()`
```
- **主从门槛 = 内容宽 ≥ 840vp**（`isMasterDetailWidth`）：竖屏平板 673vp、手机 360–430vp 一律**单列**、不渲染右栏；左右主从时左栏（`masterPaneWidth` **360–420vp**）= 日期条 + 模式 + 今日汇总块 + 列表 + 「新建」（240vp 左对齐）；右栏 = **三态**（空 / 详情 / 编辑），内容限宽 **720vp 居中**便于阅读。点行切右栏、点「新建」右栏直接变编辑表单（不跳二级页）；选中行 = `brand_soft` 底 + **2vp 品牌竖条**；编辑有未保存内容时切行先弹「放弃当前编辑？」。详情/编辑复用 `components/RecordDetailView.ets` / `RecordEditorView.ets`（`Detail.ets`/`Edit.ets` 已退化为薄壳），避免两套 UI 漂移。右栏同样支持**下拉刷新**（`Refresh` + `paneRefreshing`，复用左栏 `onPullRefresh()` 的 pull→reload→loadSummary）；编辑态有未保存内容时**不推进 `paneTick`**（宁可右栏不重读，也不冲掉草稿），只刷新左栏与汇总并 toast 说明。

| 页 | 区块 | compact（竖屏） | medium / expanded（横屏·宽屏） | 主操作 |
| --- | --- | --- | --- | --- |
| Edit | 表单 / 预览 | 标题 → 正文 → 记录者 → 完成自上而下，附件在末尾 | 左表单、右手写与附件预览；手写入口两组都**只在鸿蒙**出现 | `保存`（底部全宽） |
| Detail | 正文 / AI / 附件 | 标题 → 正文 → AI → 原始识别 → 附件 | 左正文+AI、右附件+原始识别+元信息；哈希进「更多」 | `编辑`（底部全宽） |
| Settings | 三组 | 同步 → AI → 关于 单列 | 左同步+关于 / 右 AI；长说明 `?` 弹层 | `保存设置`（底部全宽） |

### 4.1 设置页行级契约

| 组 | 行 1 | 行 2 | 行 3 | 行 4 | 组头「更多」 |
| --- | --- | --- | --- | --- | --- |
| 同步 (Git) | 仓库地址（下方固定说明「平台按地址自动识别 · 分支固定 main」） | 访问令牌（密码框） | `高级 ▸` 折叠区：Git 用户名 / 设备标识 / 作者名（默认收起）；已保存 SSH 时警告 + 「改用 HTTPS 令牌」按钮（只切状态，落盘仍走底部 `保存设置`） | `立即同步` + **`含其他设备` 开关** + 1 行状态（超长 → `?`） | 推送 / 查看状态 / 重试上次 / 测试连接（平台按地址推断、分支固定 main、无认证切换） |
| AI | 服务（下拉 4 源；`preset.experimental` 为真的源带「实验」标签） | 模型（下拉，`modelsOf(id)` 联动） | API Key（密码框，下方一行 `keyHint`） | `测试` + 1 行结果（`成功 · 320ms`，耗时取 `result.elapsedMs`；失败原样展示 `result.message`） | **无「高级」折叠区**（mod-ai-drop-advanced）：模型只能从上两行的「服务 / 模型」下拉选，**没有手输模型名**；自定义源的 baseURL 在 `customProvider` 下直接内联显示（选 `custom` 即出现） |
| 数据 | **唯一导入 / 导出入口**：一个 `导出完整包` 按钮（记录 + 媒体 + 账本）+ 区间 chip / 日期输入 | 选文件 → 试算（自动识别完整包 manifest 或兼容 JSON） | 试算计数 + `确认导入`（显式确认框后才落盘） | `取消` + 导出路径（长按复制） | — |
| 关于 | 版本 + 上次同步 | 平台信息（平台·手写·OCR 一行） | 隐私说明 `?` | —（提醒功能已按用户要求删除） | — |

> **mod-ui-drop-backup（2026-11-20）**：数据组原来在主「导出 / 导入」之外还渲染一个「日程备份」节（四个按钮 + 空态 + 独立提示行），用户反馈「已经有导入导出了，不需要备份的设置」。现在**只有一个入口**：媒体能力并入主流程——主按钮改为 `导出完整包`（repo-shaped bundle，含 `media.zip` 与三本账本），导入的「选文件 → 试算 → 确认」同一套控件自动识别完整包 manifest 与兼容 JSON；备份节、四个 `onV2*` 回调与四份展示状态全部删除，没有第二套按钮或文案。界面上不再出现「备份」二字；真机观感 `unverified`。

> 分支契约（mod-settings-lean）：v2 起分支固定 `main`；旧 extras 里的 `branch` 会被忽略并在下次保存时写成 `main`（无迁移提示）。

长说明一律 `?` → 一次性弹层，不再整段常驻。

**AI 源文案全部来自预设表**（`preset.label` / `keyHint` / `experimental`），页面不硬编码「订阅 / OAuth」这类说法；`codex` = API Key 模式（keyHint 自带一句说明），`opencode-go` 用 `experimental` 出「实验」标签。

**页面级主操作 = `保存设置`**（底部全宽、唯一实底按钮）；`立即同步` 与 `测试` 是品牌淡底次要按钮，推送/查看状态/重试/测试连接全部在组头「更多」（平台/认证选择器已删除：平台按地址推断、分支固定 main；仅存 SSH 时警告行给一个「改用 HTTPS 令牌」显式出口，切换后仍需点 `保存设置` 落盘）。

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
**AI 组不再有「高级」折叠区**（mod-ai-drop-advanced）：原来折叠里的手输模型名已整条删除，模型只走
「服务 / 模型」两个预设下拉；baseURL 从折叠里移出，选到 `custom` 时在 AI 组内联显示。
**不放开超时/重试**：`AI_TIMEOUT_MS=20000`、退避 1000ms、只重试 1 次仍是 `model/aiRequest.ts` 的固定常量，
做成开关就是改不动的假开关——与本轮「别太复杂」相反。

**存量手输模型名不迁移**：若 `settingsStore.aiModel` 已是手输的非预设名，`load()` 的 `resolveAiModel`
原样保留，`modelLabel()` 在预设表里查不到时把 id 原样显示在当前「模型」行，继续进入请求；
只是 UI 不再提供手输入口，非预设模型名从此不可新设（备选：在预设模型表加「自定义」项，未实现）。

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
  Detail（正文 / AI·附件双栏）、Settings（3 组 × ≤4 行 + `?` 弹层；AI 组的「高级」折叠已按用户要求删除，见 §11）。
- `Handwriting.ets` 由 A 做，只 import 本文件的 token；旋转锁方向方案见 §5。
- **真机 AI 源测试：未验证**（设备 `hdc list targets` 为 `[Empty]`）：三个源各点一次「测试」、把 `成功 · Nms` / 错误码贴回，需设备回来后做。
- **截图判据修正（2026-11-15 19:4x 复核）**：先前「白像素 0.9% / 无竖分割线 / 不可能是本应用」的结论**错误**——分析的是已被覆盖的旧文件（19:25 的 `ui-index-landscape.jpeg` 132,972 B，疑似退桌面误抓），且未处理 PNG 的 alpha 通道。
- 正确方法（RGBA 先合成白底再逐像素分类）重测 Lead 的 `ui-index-landscape-verified.png`（2560×1600, 147,969 B）：白 **95.4%**、品牌蓝 2.4%、浅灰 1.7%；**竖分割线 x=948（x/w=0.370，覆盖 76% 高度）**；`新建` 区域 (57,609)-(910,723) 为 **98% 品牌蓝**，右栏 (988,370) 与 (1000,700)-(2400,1400) **100% 白**。结论：**那张确实是本应用的横屏两栏**，右栏整片白正是用户第 3 点反馈的量化证据。
- **截图：未验证**。原因：设备锁屏（layout 仅 `ScreenLockRootComponent`）+ `orientation` 需重新构建生效（构建由总设计师统一执行）。
  取到后按 `docs/images/ui-<screen>-<portrait|landscape>.png` 归档并在此登记；截图仅供用户验收，不参与自动判定。
- 设备侧客观事实：物理 1600×2560、当前系统显示 2560×1600、`deviceType=tablet`；`const.product.screenDensity` 读取失败
  （errNum 106），vp 换算按 2.0 暂估——只影响落入哪个断点档，不改变布局规则。


## 8. 深色与大字号（2026-11-18，第 4 轮 B 线）

> 本节**只追加**，不改 §1–§7 的任何结论。上面 §2 第 18 行「深色跟随系统」是本轮完成项；
> §3 的「14 令牌」只描述当时状态，**现役令牌表以本节 8.1 为准**（31 个，base 与 dark 键集完全一致）。

### 8.1 令牌（唯一来源：`resources/{base,dark}/element/color.json`）

| 令牌 | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `canvas` / `page_background` | `#FFFFFF` | `#000000` | 画布底（两者同值别名；新代码用 `canvas`） |
| `surface` | `#FFFFFF` | `#16181A` | 卡片/行底 |
| `surface_raised` | `#FFFFFF` | `#1F2226` | 抬起的面（弹层/浮层/手柄） |
| `control_fill` / `control_fill_alt` | `#F1F3F5` / `#F7F8FA` | `#23262A` / `#1B1E21` | 次级按钮/单元格底 |
| `field_fill` | `#EEF1F4` | `#262A2E` | 输入框/取消按钮底 |
| `brand` / `brand_soft` | `#007DFF` / `#E8F1FF` | `#3B82F6` / `#14304D` | 强调色/品牌淡底 |
| `selection_fill` / `selection_stroke` | `#E8F1FF` / `#0A59F7` | `#14304D` / `#4D9FFF` | 选中底/选中蓝框 |
| `text_primary` / `text_secondary` / `text_inverse` | `#182431` / `#66182431` / `#FFFFFF` | `#E6E8EA` / `#99E6E8EA` / `#FFFFFF` | 三级文字 |
| `divider` / `border` / `grid_line` | `#33182431` / `#DDDDDD` / `#8A93A0` | `#33E6E8EA` / `#3A3F45` / `#6B7480` | 分割线/边框/**表格网格** |
| `danger` / `warning` / `warning_soft` / `success` | `#C0392B` / `#B26A00` / `#FFF3E6` / `#188038` | `#FF6B5E` / `#E8A33D` / `#3A2A12` / `#4CC38A` | 语义色 |
| `scrim` / `shadow` / `region_fill` | `#66000000` / `#1A000000` / `#1AF59E0B` | `#99000000` / `#66000000` / `#1AE8A33D` | 蒙层/投影/区域框填充 |
| `preview_background` | `#000000` | `#000000` | 图片预览底（恒黑） |
| `qr_light` / `qr_dark` | `#FFFFFF` / `#000000` | `#FFFFFF` / `#000000` | **二维码恒白底黑码** |
| `ink_paper` | `#FFFFFF` | `#FFFFFF` | **手写纸面恒白**（见 8.4） |
| `ink_pencil` / `ink_highlighter` | `#8A8A8A` / `#F5B700` | `#B8BDC4` / `#FFD54F` | 笔形图标色 |

- **语义名 → 资源名**集中在 `model/theme.ts` 的 `COLOR_TOKENS`（`colorToken('canvas') → 'app.color.canvas'`，
  未知名 fail-safe 回落 `canvas`），页面只写 `$r('app.color.*')`，不写裸色值。
- Canvas 的 `fillStyle`/`strokeStyle` **不收 `$r()` 资源对象**，纸面内绘制色集中在 `theme.ts` 的 `CANVAS_PAINTS`
  （`paper`/`mask`/`grid`/`objectStroke`/`objectOutlineFaded`/`objectTint`/`selectionStroke`/`objectDanger`）。

### 8.2 三态（跟随系统 / 浅色 / 深色）

| 项 | 落点 |
| --- | --- |
| 判定（纯函数） | `model/theme.ts`：`ThemeMode`、`THEME_MODE_ORDER`、`normalizeThemeMode`（未知→`system`）、`resolveTheme(mode, systemDark)` |
| 持久化 | `services/settingsStore.ets`：**只加一个键** `themeMode`（`KEY_THEME_MODE`），读写成对，旧数据缺键 → `system` |
| 落地 | `common/themeApply.ets`：`colorModeOf()` / `applyThemeMode()` / `isSystemDark()`（三态→`ConfigurationConstant.ColorMode` 的**唯一**映射处） |
| 启动 | `EntryAbility.onCreate` → `applyStoredThemeMode()`：**页面加载前**设置，避免首帧闪一下 |
| 切换 | 设置页「关于 → 深色模式」三态片：点一下**立即** `setColorMode` + 落盘，落盘失败回退界面并提示 |
| `system` 语义 | `ColorMode.COLOR_MODE_NOT_SET`（**不是** `COLOR_MODE_LIGHT`），系统切深色时 App 立刻跟随 |

### 8.3 大字号（`FONT_SCALE`）

`fp` 本身已跟随系统字体缩放，本节只管「我们自己允许的范围」：`FONT_SCALE = { min: 1.0, max: 1.6, large: 1.5 }`
（`common/uiTokens.ts`），夹取与缩放走 `clampFontScale` / `scaledFontSize`（`model/theme.ts`）。

**「×1.5 不截断」的三条布局规则**（两条代表性页面已按此验收）：

1. **可压缩列一律 `layoutWeight(1)` + `maxLines(n)` + `textOverflow({ overflow: TextOverflow.Ellipsis })`**，
   绝不靠固定宽裁字（Index 列表行标题 `maxLines(2)`、Settings 表单行标签 `maxLines(1)`）；
2. **固定列（勾选 40vp / 开关 / 删除 / 三态片）不许被压缩**（`flexShrink(0)` + 只写 `constraintSize({ minWidth })`，
   不写死 `width`），否则大字号下按钮先被挤没；
3. **行高与字号同档放大**（`LINE_HEIGHT` 与 `FONT` 一一对应），只放大字号会压字；纯度断言：
   `assertNoOverflow` 在 `scale=1.0` 与 `1.5` 下都必须 `fits=true`。

文本宽度估算口径（写进测试注释）：**字宽 ≈ 字号 × 0.6 × 字符数**（`estimatedTextWidth`）；
这是估算不是排版引擎，但 ×1.5 的增量是 +50%，远大于 ±15% 的估算误差。

### 8.4 专项检查点（`tools/test/theme.test.mjs` 断言）

| 检查点 | 结论 | 断言 |
| --- | --- | --- |
| 手写板画布底色/笔迹色 | **纸面恒白**（`ink_paper` 两套主题同值），默认墨色 `#1A1A1A` 对比 ≥ 4.5:1 | `contrastRatio(DEFAULT_PEN_COLOR, CANVAS_PAINTS.paper) ≥ 4.5` |
| 表格网格线 | DOM 侧 `grid_line` 浅 3.10:1 / 深 4.43:1（≥3:1）；纸面 Canvas 网格用 `CANVAS_PAINTS.grid`（白纸上 7.4:1） | `contrast(grid_line, canvas) ≥ 3` 两套主题 |
| 选中态蓝框 | `selection_stroke` 对 `selection_fill` 浅 4.88:1 / 深 4.95:1 | ≥ 3:1 两套主题 |
| 错误红字 | `danger` 对 `canvas`：浅 5.04:1 / 深 7.52:1（对 `surface` 同样 ≥4.5） | ≥ 4.5:1 两套主题 |
| 二维码 | 恒放白底容器（`qr_light = #FFFFFF`），`qr_dark/qr_light ≥ 7:1`；**App 侧当前没有二维码**，此约定供后续接入方遵守 | `qr_light` 两套主题都必须是 `#FFFFFF` |
| 品牌按钮反白字 | `text_inverse` 对 `brand` 浅 3.91:1 / 深 3.68:1（≥3:1 大字号底线） | ≥ 3:1 两套主题 |

**为什么纸面（手写板/二维码）不跟随深色**：笔迹颜色与二维码内容都是**数据**，深色下把纸面变黑会让已有
`#1A1A1A` 墨迹直接不可见，手写页还要 `componentSnapshot` 截图送 OCR（深底截图对识别也更差）。
所以 `ink_paper` / `qr_light` 两套主题恒 `#FFFFFF`，与「深色模式」不矛盾——它们是**内容纸**，不是界面底。

### 8.5 已知限制与待办（需决策/需 owner）

1. **`tools/test/handwritingToolbar.test.mjs` 与本轮冲突（未改该文件）**：
   - `:652` 断言 `railBar` 必须 `.backgroundColor(RAIL_BG)`，而 `:653` 把 `RAIL_BG` 钉成 `#F7F9FB`（浅灰）。
     深色下文字色是令牌（变浅灰），rail 若仍浅灰则字看不见，因此改为 `this.railBackground()`（浅色档仍用 `RAIL_BG`）。
     **该断言现在 1 条红**，正确改法：`assert.ok(/\.backgroundColor\(this\.railBackground\(\)\)/.test(bar))`。
   - `:418` 要求 4 个分页单元格/rail 按钮内出现 `'#F…'` 字面量、`:240` 要求「完成」用 `Color.White`：
     这些字面量**保留**（浅色档），深色档走 `theme.ts` 的 `DARK_FALLBACK`（值与 dark 令牌一致，测试比对）。
2. **画布内的绘制色不随主题实时刷新**：`CANVAS_PAINTS` 是常量、`isDarkTheme()` 在页面绘制时读一次 config。
   在设置页切三态后回到手写页会重建，没问题；但**停留在手写页时**系统切深色，画布内的对象框颜色不会立即重画
   （界面其余部分由系统重载资源，会变）。要彻底实时需把 config 变化回调接进 `HandwritingPager` 并重画。
3. **无真机验证**：本轮所有结论来自静态断言 + 纯函数计算，深色实机观感、系统字体缩放 ×1.5 的真机排版**未验证**。


## 9. 手写板工具条与笔过滤（2026-11-18，用户报的三个 P0）

> 本节**只追加**，不改 §1–§8 的任何结论。涉及文件仅三个：`entry/src/harmony/ets/pages/Handwriting.ets`、
> `entry/src/harmony/ets/handwriting/HandwritingPager.ets`、`entry/src/main/ets/model/penInput.ts`（只加导出）。

### 9.1 缺陷 3：竖屏顶部工具条不再进横向 Scroll

| 项 | 旧（缺陷） | 新（定版） |
| --- | --- | --- |
| 容器 | `Scroll().scrollable(Horizontal)` 包住「橡皮/手动框/插入/↶/↷（+窄屏分页组）」 | **没有任何 Scroll**：`if (topBarTwoRows())` → 两行 `Column`；否则一行 `Row` |
| 9 项 | 退出 / 笔迹 / 橡皮 / 手动框 / 插入 / ↶ / ↷ / 分页组 / 完成，其中 5 项会被滚出屏幕 | 全部静态可见：一行排完，或折成两行 |
| 用户症状 | 「工具按钮没了」；历史按钮点不动（手势被 Scrollable 吃掉） | 点得到、看得见 |

**折行判据（`topBarTwoRows()`，两行都是静态布局，绝不滚动）**：

1. `pageW < TOP_BAR_SINGLE_ROW_MIN`（**640vp**）→ 极窄屏，直接两行；
2. 否则实算 `topBarRequiredWidth() > pageW` 才折行 —— 公式 = `7 × itemSize + finishWidth + 笔迹额外 16 + pagerTotalWidth + 8 × controlGap + 两侧 16`。

**两行怎么分**：第一行 `[‹][笔迹▾][橡皮][手动框][插入▾][↶][↷]`，第二行 `[ −|+ ][n/m][‹|› ][完成]`
（导航在上、翻页与主操作在下）；顶部条整体高度 = `topBarHeight()` = 两行时 `2 × barThickness`，
`topBarTotalHeight()` = 它 + 1vp 分割线（**高度必须跟着翻倍，否则第二行会被 `clip(true)` 裁掉**）。

**真机数值自证**（1600×2560 @2.375 ⇒ 673.7vp 宽，`itemSize=64`、`gap=9.6`、`barThickness=64`）：
一行需要 **904.4vp > 673.7vp** ⇒ 物理上不可能一行放下 9 项（分页区每半 ≥44vp 是既有硬约束），
因此**真机竖屏实际走两行**：第一行 537.6vp、第二行 373.2vp，两行都放得下。宽屏（≥1024vp）仍是一行。
> 待用户决策：若坚持「673.7vp 也一行」，只能把分页区每半压到 <44vp（与 §2 触控 ≥40vp 及既有测试冲突），不建议。

### 9.2 缺陷 4：撤销 / 重做点不动（两个成因都排除）

| 成因 | 处理 |
| --- | --- |
| (a) 手势被 Scrollable 抢走 | §9.1 已删除横向 Scroll；历史按钮改成**真组件** `Row` + `.onClick`（竖屏 `historyButton`、横屏 `railHistoryButton` 同一套），不再是裸 `Text` 平铺 |
| (b) `enabled=false` + 状态不刷新 | **不再用 `.enabled()`**：按钮永远可点，禁用只改字色；`onHistoryTap(kind, available)` 在无可用笔画时 toast「没有可撤销/可重做的笔画」。可用性在 `build()` 里**现读** `pagerState.undoSteps / redoAvailable`，并由 `onStatsChange → onHistoryStats → touchUi()`（延一拍避免 build 期间改状态）与「抬笔 dirty → touchUi()」双路保证重建 |

点击链：`Row.onClick → onHistoryTap → pagerState.applyUndo()/applyRedo() → touchUi()`（方法名沿用既有 `applyUndo/applyRedo`）。

### 9.3 缺陷 1：`penOnly` 终于作用到画布（`shouldAcceptTouch` 原来零调用点）

- **值从哪来**：`Handwriting.aboutToAppear → settingsStore.load() → penOnlyInput`（`=== true` 归一，缺键/读失败 = false）
  → `pagerState.setPenOnlyInput()`；开关切换时 `savePenOnlyInput()` 先写 `pagerState`（**立刻生效**）再 `settingsStore.save({ penOnlyInput })`。
- **在哪里拦**（两个入口，都是各自的第一条语句）：
  `HandwritingPager.handleTouch()`（落笔/橡皮的唯一入口）与 `handleGestureStart()`（`手动框` 走 PanGesture，不经过 handleTouch）。
- **规则**（纯函数 `model/penInput.ts`，Node 单测全矩阵）：`penOnly=true` 时**只拒 `SourceTool.Finger`**；
  笔 / `Unknown`（拿不到笔类型的设备）/ 其它任何取值一律放行——宁可漏放一次手指，也不能让笔写不了字。
- **计数与提示**：`fingerRejectCount` 只在触摸起点（`TouchType.Down` / 手势起手）累加，
  `shouldShowRejectNotice(count)` 为真（阈值 `FINGER_REJECT_THRESHOLD=3` 的整数倍）才 `promptAction.showToast` 一次，
  文案用新增的 `fingerRejectNoticeOnBoard()`（指出关闭位置 =「笔迹 → 更多」，不再指去已删除的设置页开关）；
  任何**非手指**输入进来立即把计数清零（「连续」语义）。
- **被拒的触摸**：不落笔、不进橡皮、不进框选、不动撤销栈（直接 `return`）。

### 9.4 缺陷 2：开关挪进手写板「笔迹」面板的二级菜单

```
笔迹设置
  笔形      [钢笔][圆珠笔][铅笔][马克笔][荧光笔]
  ─────────────────────────────
  粗细      [· 1][·· 2][··· 3][···· 4][····· 5]
  ─────────────────────────────
  颜色      [■黑][■红][■蓝][■绿][■橙]
  ─────────────────────────────
  更多 ▸    ← 二级入口（默认收起，`inkMoreOpen`）
    ┌ 仅手写笔输入            [ Switch ]
    └ 开启后手指不能写，只能用手写笔
```

- 切换即落盘（`settingsStore.save({ penOnlyInput })`）并**立即**作用于画布（不需要退出重进）；
  落盘失败回退界面状态 + toast（不让用户「拨了开关却还是能用手写」）。
- 点面板外（scrim）/ 切到别个面板都会收起「更多」。
- 设置页那条同名开关由另一个任务删除，本文件不再引用它。

### 9.5 合规与测试

- 新增 UI 只用令牌：`$r('app.color.*')`（`brand / divider / text_primary / text_secondary / selection_fill`）、
  `FONT.caption` + `LINE_HEIGHT.caption`、`SPACING.*`、`RADIUS.sm`、`DIVIDER`、`CHIP_HEIGHT=40`（触控 ≥40vp）；
  **没有新增任何字面色 / `Color.X` / `rgba()`**（`theme.test.mjs` 的白名单条目数与字面量条数保持不变）。
- `tools/test/penInput.test.mjs`（24 例）：`shouldAcceptTouch` 四态全矩阵（penOnly × FINGER/UNKNOWN/PEN/其它值，
  另含「非布尔真值一律按关处理」）、`fingerRejectNotice` / `fingerRejectNoticeOnBoard` 边界（0 / 负数 / NaN / Infinity / 小数）、
  `shouldShowRejectNotice` 节流边界，以及 **pager 接线**回归（两个入口都过滤、只在 Down 计数、state 上存值）。
- `tools/test/handwritingToolbar.test.mjs`（59 例）：新增「缺陷 3」「缺陷 4」「缺陷 1/2」三个 describe ——
  `topBar` 内不含 `Scroll(`、9 项逐个数（每个 2 次 = 一行+两行各一套）、640vp + 实算折行判据与数值自证、
  历史按钮是 `Row + onClick` 且**不含 `.enabled(`**、`applyUndo/applyRedo` 真被调用、`onStatsChange → touchUi` 接线、
  面板「更多 / 仅手写笔输入 / 说明文案 / 切换即落盘并传画布」。


### 9.6 两行时的画布高度（2026-11-18 复核，防后人改回滚动）

- **竖屏实测换算**：本机 2560×1600、density ≈ 2.375 → `pageW ≈ 673.7vp`、`pageH ≈ 1077.9vp`；两行工具条
  = `2 × barThickness(64) + 1(DIVIDER) = 129vp`，画布仍有 **≈ 949vp（≈88%）**，远超"能舒服写一行字"的下限。
- **横屏不折行**：`rail` 是竖向条（`barThickness` 56–84 用作**宽度**），不占高度。
- **判据是算出来的，不是拍阈值**：`topBarTwoRows()` 只在两种情况下为真 —— ① `pageW < 640vp`（极窄屏，
  9 项物理放不下，直接两行）；② `topBarRequiredWidth() > pageW`（用真实控件尺寸求和）。二者都**不滚动**。
- **不许为了"一行"把分页单元格压到 < 44vp**：触控定版优先于"一行好看"。

## 10. 首页筛选控件收敛（`mod-home-filters` → `mod-home-filters-2`，2026-11-20）

> 本节**只追加**，不改 §1–§9 的结论。§4 的示意图已按本节更新为 `今日 / 未完成` 两段（无开关）。
> 用户反馈：① 首页筛选太杂（5 个控件先收敛为 2 段 + 1 开关）；② **今天的日程是全部显示，不区分已完成和未完成，不需要单独的显示已完成的开关按钮**（`mod-home-filters-2` 据此处置）。

### 10.1 定版：恰好 2 个 tab，无开关

| 控件 | 默认值 | 行为 |
| --- | --- | --- |
| `今日` tab | **选中** | 当前所选日期（默认今天）的**全部**记录（已完成 + 未完成）；排序规则不变；副标题计数 = 当天记录总数「今日 N 条」。 |
| `未完成` tab | 未选 | 跨日未完成记录（原数据语义不变），按**日期键**再按 `ts` 升序排列；页头标题「未完成」，副标题「未完成 N 条」。 |

只保留搜索框（标题/正文/OCR/作者）、作者 chips、✨今日汇总块与 5 秒撤销条；页头动作、记录点击/编辑/删除路径均不动。今日本来就显示全部记录，完成状态只由每行的勾选指示。

### 10.2 删除项与冗余理由

| 被删控件 / 状态 | 取代它的控件 | 为什么冗余 |
| --- | --- | --- |
| `今日待办` | `今日` | 改名：今日 tab 现在显示当天全部记录，「待办」这个与「未完成」重复的修饰不再成立。 |
| `全部` | `今日` | 今日 tab 本身就是当天全部记录（`records` 保留 tab 级全量），无需再点一个「全部」。 |
| `已完成` | `今日` + 行上勾选 | 今日列表中 `done === true` 的行就是原「已完成」视图；完成状态只由逐行勾选指示，不单独成片。 |
| `全部未完成` | `未完成` | 纯改名：跨日未完成的取数与排序（`pendingRecords` → `pendingSorted`）一字未改，去掉「全部」这层与 tab 语义重复的前缀。 |
| 「显示已完成」开关 + `showDone` 状态 + `onShowDoneChange` 回调 | 无（直接删除） | 用户明确要求今日全部显示、不区分已完成与未完成；开关在「显示全部」之后已无剩余语义。 |

> 控件数 **5 → 2**（`mod-home-filters` 先收到 2 段 + 1 开关，`mod-home-filters-2` 再删掉开关）。
> 被删的是**状态**，不是能力：今日全部 / 跨日未完成两种视图仍可直接到达；逐行勾选仍可完成/取消完成。

### 10.3 状态与空态契约

- 状态机：仅 `tab: 'today' | 'pending'`；`showDone`、旧 `showAllPending` / `statusFilter` 两个 `@State`
  与 `StatusChip()` / `pickStatus()` / `onShowDoneChange()` 一并删除（`model/query.ts` 的 `status` 参数保留为通用能力，页面固定传 `'all'`）。
- 今日 tab 不做完成状态过滤：`records`（tab 全量）直接进 `applyQuery`（只剩用户主动的关键词 / 作者过滤），
  `visibleRecords` 是列表真正渲染的数据源；逐行勾选仍只改变记录状态，排序规则未动。
- 空态（`docs/STATE-UI.md` 的口径）：今日无记录 → 汇总块灰字「今天还没有日程」（不重复渲染）；
  未完成 tab 无记录 → 列表给「没有未完成的日程」；有搜索 / 作者筛选时仍由 `EmptyResults()` 给
  「没有匹配… / 没有符合筛选条件…」并带「清空」动作。今日有记录时全部可见，不再有「全已完成所以列表空」的空态。
- 计数：今日「今日 N 条」= 当天记录总数；未完成「未完成 N 条」= 跨日未完成条数；**两处都没有「共 M 条」后缀**。
- 旧文案「所有日程都已完成」「这一天还没有日程」及「今日 N 条未完成 · 共 M 条」已删除，逐字由上面的新文案取代。

### 10.4 步数与测试

- 步数按 `docs/UX-STEPS.md` §1 口径 **Δ0**（控件数变化不是可计数的 tap / scroll / wait，见 §4.7），
  合计仍 31 步；`unverified`：真机布局与触控观感（本机 `hdc list targets` 为空）。
- 测试：`tools/test/homeFilters.test.mjs`（18 例，两 tab 控制集 / 开关消失 / 今日全量 / 排序键 / 计数为总量 /
  无「共」后缀 / 空态 / 旧标签消失）；旧测试 `b3Batch` / `timelineService` / `uiTokens` / `b4CalendarWiring` / `query` / `v2Only` /
  `openIndex` / `device-accept` 的旧状态名与旧文案已 retarget，不是删断言。

## 11. AI/API 配置删除「高级」与手输模型名（`mod-ai-drop-advanced`，2026-11-20）

> 本节**只追加**，不改 §1–§10 的结论。用户原话：「api 配置里删掉高级按钮，模型配置已经完成了，不需要再填模型名称」。

### 11.1 原来「高级」里是什么

`components/settings/AiSection.ets` 的「高级 ▸ / 高级 ▾」展开后有三样东西：

| 内容 | 条件 | 处置 |
| --- | --- | --- |
| 手输**模型名**输入框（`TextInput({ text: this.aiModel })`）+ 字段标题（预设源「模型名（可手输，留空用默认）」/ 自定义源「模型名（必填）」）+ `aiModelError` 红字 | 全部源 | **删除**（用户要求） |
| **接口地址 baseURL** 输入框 + `aiBaseUrlError` 红字 | 仅 `customProvider` | **保留**，移出折叠区，选到「自定义」时在 AI 组内联常驻显示 |
| 「预设源使用内置接口地址；要自定义地址请把『服务』切到『自定义』。」一行灰字 | 预设源且展开时 | 随折叠区删除（无剩余语义） |

没有 temperature / timeout / retry 开关：`AI_TIMEOUT_MS=20000`、退避 1000ms、只重试 1 次一直是 `model/aiRequest.ts` 的固定常量（见 §4.1 注）。

### 11.2 删除清单（逐处）

- `components/settings/AiSection.ets`：删 `advancedOpen` / `aiModel` / `aiModelError` 三个 `@Prop`、`onToggleAdvanced` / `onChangeAiModel` 两个回调、`defaultModelOf` import、「高级」切换 Row、`if (this.advancedOpen) { … }` 整段里的模型名输入框与文案；baseURL 块改成 `if (this.customProvider) { … }` 直接渲染。
- `pages/Settings.ets`：删 `@State advancedOpen` / `@State aiModelError`、`FIELD_AI_MODEL` import、`applyIssues()` 里 AI 模型名的清空与分支、`aiBaseUrlError` 分支里的 `this.advancedOpen = true`、`pickProvider()` 里选 custom 自动展开、`AiGroup()` 的四个无用接线；`this.aiModel` / `aiModel: this.aiModel` 与 `this.pickModel()` **保留**（模型仍从下拉写回）。
- `model/settingsForm.ts`：删 FIELD_AI_MODEL 校验（`自定义源必须填写模型名（点「高级」手输）`）——模型只能从下拉选，`aiModel` 由 `defaultModelOf` 保证非空，这条校验既不可满足也无可见落点。
- `services/settingsStore.ets`：只改注释，归一逻辑一字未动。
- 测试：`modelHintGate.test.mjs` 整份重写（8 例）；`settingsCopyGuard.test.mjs` 加 C4；`settingsFormValidation.test.mjs` 把 FIELD_AI_MODEL 从校验/幽灵报错表移除。

### 11.3 决策与代价

预设模型**始终可用**：`AI_PROVIDERS` 每个源（含 `custom`）都有非空 `models`，`defaultModelOf(id)` 永远给得出默认模型；服务 + 模型两个下拉就是唯一配置路径。手输模型名是通往**非预设**模型名的唯一入口，删除后这类名字**不能再从 UI 新设**——用户明确说「模型配置已经完成了」，故按原样删除。最小备选（**未实现**）：在预设模型表里给各源加一条「自定义」项，选择后再输入名字；需要时另立模块。

### 11.4 存量手输模型名的安全

**不迁移、不清空、不重写**：`settingsStore.load()` 的 `resolveAiModel(providerId, aiModel)` 对非空字符串原样保留；`applySettings()` 把 `settings.aiModel` 铺回 `@State`；`modelLabel()` 在 `modelsOf(id)` 里查不到时把 id 原样显示在当前「模型」行；`saveSettings()` 仍把 `this.aiModel` 写回 patch，测试连接 / summary / 详情 / fallback runner 仍读 `settings.aiModel`。**表现**：已存的手输模型名继续显示并继续生效，只是「模型」下拉里没有它的勾选项。

### 11.5 步数与未验证

步数按 §1 口径 **Δ0**（删的是输入控件与折叠开关，不是可计数的 tap / scroll / wait）。`unverified`：真机观感（本机 `hdc list targets` 为空，按调度不做 ArkTS 构建 / 装机）；`TextInput.onChange` 与自定义源 baseURL 内联渲染的真机行为未验证。

## 12. 外壳导航轨（`mod-shell-rail`，2026-11-21）

> 本节**只追加**，不改 §1–§11 的结论。新增 `pages/Home.ets`（外壳页）+ `components/shell/ShellRail.ets`（左轨）；
> 两份 `main_pages.json` 各加一行 `pages/Home`（main 清单 9 页，harmony 为超集）。《项目理解》所述「每屏 1 个主操作」
> 继续成立——四个分段平级，没有「哪个更重要」的主按钮。

| 项 | 定版 |
| --- | --- |
| 四节平级 | 顺序固定 `dots / 日程 / 远程 DSH / 云端对话`（id `dots / schedule / instances / cloudChat`），同一份 `SHELL_SECTION_ORDER` 表驱动 `ForEach`；选中态只改底色/字色 + 2vp 品牌竖条，不加图标、角标或主按钮 |
| 默认分段 | `dots`（未知深链 id 也 fail-closed 回落 dots）；`onBackPress`：抽屉开→收抽屉并吃掉、非 dots→回 dots 并吃掉、dots→放行 |
| 轨宽 / 行高 | 常驻轨 **240vp**（宽屏/横屏）、抽屉窄轨 **72vp**（icon-only，label 进 accessibilityText）；四节与页脚齿轮行同高 **48vp**（≥ `TOUCH_MIN` 40），分隔线在齿轮之前——齿轮是**出口不是第五个 section** |
| 页头 | 每个面板自带 `PaneHeader(分段标签, 动作名, 禁用原因)`：左侧分段名（compact 时加 ☰ 开抽屉），右侧动作槽显示「动作（原因）」且 `.enabled(false)`；设置出口唯一——`ShellRail` 齿轮只发 `onOpenSettings`，由 `Home.openSettings()` 唯一一处 `pushUrl('pages/Settings')` |
| 保活 | 四个 `@Builder` 面板在**同一个 Stack** 里全部无条件实例化（不写 `if/else`），非当前面板用 `.visibility(active ? Visibility.Visible : Visibility.Hidden)` 隐藏——Hidden 仍留在组件树上，切换后 `@State` / 滚动位置 / 选中态不丢；S3 把占位换成真实 body 时必须保留这条 `active → Visibility` 接线 |
| 唯一 flex 层 | `Row { ShellRail, Stack(panes).layoutWeight(1) }` 是整页唯一一处结构性 `layoutWeight(1)` 切分；内容区是 **Stack 而非固定高度 Column**，`.height('100%')` 撑满，滚动由各面板自己的 `Scroll` 承担，没有嵌套的「固定页头 + 内容」外壳；`PaneHeader` 标题的 `layoutWeight(1)` 只是文本省略号，不是第二层切分 |
| 断点 / 抽屉 | 与 `Index` / `PageLayout` 同一套 `onAreaChange → resolveBreakpoint(width, isLandscapeSize(...))`；只判 `breakpoint === 'compact'`（<600vp，横屏至少 medium）。compact 下导航条从 Row 撤出，改挂 root Stack 的抽屉：☰ / 点分段 / 点 scrim 关闭；抽屉轨用 `Visibility.None` 挂起（不占布局、不 unmount） |
| 占位无假行 | 四个面板当前是占位：dots 有禁用输入框 + 逐字原因 `dots 尚未接线`；其余三节各一句「…即将迁入，本页暂不展示任何记录。」；没有任何 `ForEach` / 假记录行 / 可点的空入口 |

**测试与未验证**：`tools/test/shellLayout.test.mjs`（16 例，L-01–L-16）钉住上述几何/保活/断点契约；
`indexHeader` / `uiTokens` / `structureGuards` 的旧页头断言已 retarget（旧 4 条一条未删，改标「日程面板契约」，
S3 迁入时只换文件锚点），并新增外壳页头/断点/令牌/装配守卫共 11 例。`tsc` 只覆盖 `tools/tsconfig.json`
的纯 TS（`components/` 与 `pages/` 被排除），所以 **`Home.ets` / `ShellRail.ets` 的 ArkTS 编译与真机观感
`unverified`**，首次真实编译留给下一次设备 pass。

> **mod-cloud-chat-no-config-note（2026-11-21）**：云端对话**没有设置面**——`pages/panes/CloudChatPane.ets`
> 与 `pages/Chats.ets` 都不渲染配置行或「chats/ + Git + 电脑上续接」这类机制说明段落，它直接复用
> 「设置 → 同步仓库」那份 Git 配置；空态只给一句「先在设置里配置仓库」，会话列表 / 只读详情导航 /
> 下拉刷新路径不变。

**S3 落地更新（`mod-shell-schedule-pane`，2026-11-21）**：本节「四个面板当前是占位」与「S3 迁入时换锚点」
两条已经落地——
- **日程现在是真 body**：`pages/panes/SchedulePane.ets` 逐字承接 `pages/Index.ets` 的日程正文
  （两 tab / 新建 / 搜索 / 汇总卡 / 列表 / 撤销条 / 主从右栏 / AI 面板），只删掉表格里说的首页双格条
  （导航轨已有 dots / 云端对话两个分段，页内双入口重复）。列表仍由唯一的 `.layoutWeight(1)` 加权兄弟吃余量，
  `SummaryCard` 仍是封顶兄弟（`fix-landscape-list` 横屏修法不回退）。`pages/Index.ets` 保留为 fallback 路由、未改。
- **入口已经是 Home**：`EntryAbility.onWindowStageCreate` 改为 `loadContent('pages/Home')`；两份
  `main_pages.json` 仍各登记 `pages/Home` 与 `pages/Index`（main 9 / harmony 10 页，不变）。
- **其余三面仍是表格所述的占位**：`DotsPane` / `InstancesPane` / `CloudChatPane` 各带分段标签页头、
  禁用主操作与逐字原因，没有假行；compact 的 ☰ 开抽屉入口上提到 Home 的 root Stack（面板不再自持）。
- 四个 `@Builder` 已变为四个外部 `@Component`，props 统一 `id: string`（深链预留）+ `active: boolean`
  （分段可见性）；`active → Visibility.Visible/Hidden` 的保活接线随组件一起下沉，不卸载的语义不变。
- `validate-app` 的页面发现改为只认 `pages/` 顶层 `.ets`（子目录组件不登记为路由页），因此页数仍为 9；
  `Color.Transparent` 因日程 body 的逐字复制由 1 处变 2 处（Index fallback + SchedulePane），预算显式登记并
  用逐文件断言防止扩散。真机 ArkTS 编译 / 四节交互仍 `unverified`。

**远程 DSH 面板落真更新（`mod-shell-instances-pane`，2026-11-21）**：上表「占位无假行」与 S3「其余三面仍是
表格所述的占位」两条对 `InstancesPane` 已失效——
- **远程 DSH 现在是真 body**：`pages/panes/InstancesPane.ets` 逐字承接 `pages/Instances.ets` 的实例正文
  （本机首行 + 远程行 name / mode / reachable / 相对 `lastSeen` / 二次打码 URL + 打开·编辑·删除三动作 +
  typed 问题行 + 四段空态 + `ensureSeeded` 幂等播种迁移）；页头换为可点「添加实例」与「云端对话」桥接；
  自带 `Scroll` + `active→Visibility.Hidden` 保活，无嵌套固定高度 Column，`deepLinkId`/`active` 两个 prop 不变。
- **顶层页不再持有正文**：`pages/Instances.ets` 瘦身为只装配同一个 InstancesPane 的 `@Entry` 路由壳
  （单一事实来源；设置页仍 `pushUrl('pages/Instances')`，两份 `main_pages.json` 未改）。
- **占位只剩两个**：`DotsPane` / `CloudChatPane` 仍为表格所述的 scaffold；三占位的禁用计数 4→3，
  「本页暂不展示任何记录。」说明 2→1；`REASON_REMOTE` / `远程面板即将迁入` 在 app 源码中绝迹。
- `docs/VERIFICATION.md` §15.15 的 FAILED 项「2b 远程 DSH 实例列表」由本模块重验，证据写入 §15.16。

**设置出口去重（`mod-settings-entry-dedupe`，2026-11-21）**：`ShellRail` 页脚齿轮是全外壳**唯一**的设置入口
（齿轮 → `Home.openSettings()` → 唯一一处 `pushUrl('pages/Settings')`）；日程面板页头不再有「⚙ 设置」，
错误态也不再提供第二个「去设置」按钮，其余三面的动作槽本来就是 pane 专属（新建对话 / 添加实例 / 新建对话）。
fallback 路由 `pages/Index.ets` 在自己的页头保留齿轮，直到 fallback 退役；`Chats` / `RemoteControl` 的
「去设置」是错误恢复按钮、不是导航入口，保持不动。五份守卫正向钉住「外壳 + 四面板中恰好一处 Settings push、
位于 `Home.openSettings()`，且面板页头无设置动作」。

**同步仓库是真页面（`mod-settings-sync-page`，2026-11-21）**：四行设置菜单的「同步仓库」行 push 的
`pages/SettingsSync.ets` 不再是复用 `SettingsHost` 的薄壳——它自带 `PageLayout(title:'同步仓库')`、
一层 flex（自己的 `Scroll` + 底部唯一主操作「保存」）、全部同步状态与业务方法（读写 store、配置内核、
`checkSettingsFields` 校验、状态 / 拉取、测试连接、诚实状态行、失败出口），并装配同一份
`components/settings/SyncSection.ets` 作为 presentational body（两个字段：仓库地址 / 访问令牌）。
诚实状态行三态逐字为 `已同步·HH:MM` / `同步中…` / `失败：原因`，失败态点一下即重放上次动作；
失败出口「查看状态 / 测试连接 / 重试」在页面，没有「高级」也没有「推送 / 立即同步」手动按钮。
`SettingsHost` 不再为 `section='sync'` 渲染正文 / 装配 props（删 `SyncGroup` 与 `SyncSection` import），
API 子页已按 `mod-settings-api-page`、数据子页已按 `mod-settings-export-page` 落真；关于子页的历史骨架留在宿主，且不再由路由渲染；
`settingsStore.save()` 是 patch，故那些子页保存不会覆盖仓库地址 / 令牌（`syncSaveScope.test.mjs` 钉住此契约）。
真机 ArkTS 编译与保存落盘观感 `unverified`。

**使用 / 配置分家（`mod-instances-pane-readonly`，2026-11-21）**：本节上一段「其余三面的动作槽…
添加实例」对远程 DSH 面板已失效——用户：「设置里已经有远程配置…所以首页的远程 DSH 里就不需要展示配置了」。
定版口径：**首页远程 DSH 面板 = 用，设置 → 远程实例 = 配**。

| 能力 | 首页「远程 DSH」分段（只读） | 设置 → 远程实例（`pages/Instances`） |
| --- | --- | --- |
| 本机首行 / 远程行 / 方式徽章 / 可达三态 / 相对 `lastSeen` / 二次打码 URL | ✅ | ✅ |
| 「打开」（内嵌 Web + 可达回写） | ✅ | ✅ |
| typed 问题行 + 空态标题 / 指引 / 「用浏览器打开」 | ✅ | ✅ |
| 页头「添加实例」、行内「编辑 / 删除」、地址·令牌·方式表单、空态「添加实例」 | ❌ | ✅ |
| 空态 / 问题行恢复动作 | 「去设置添加实例」→ `router.pushUrl('pages/Instances')` | 就地「添加实例」/「重新添加」→ 展开表单 |

同一份 `pages/panes/InstancesPane.ets` 用**一个 prop** 分叉：`configurable: boolean = false`——
`pages/Home.ets` 的面板装配不传该 prop（默认 false = 只读，Home 本批未改）；设置路由
`pages/Instances.ets` 显式传 `configurable: true`。所有配置 UI（页头主操作、行内两动作、`FormPanel`
及 `TextInput` / `Select`、空态「添加实例」、问题行「重新添加」）都包在 `if (this.configurable)` 里；
只读模式保留**打开**、展示与播种迁移，配置动作统一走 `openInstanceConfig()` → `pages/Instances`。
只读空态不是假入口：按钮文案改「去设置添加实例」，路由可达；配置页空态仍是逐字「添加实例」。
守卫按「模式可见性」切源码做**正向**断言（`instanceList` U-17–U-21 / `shellLayout` L-11·L-19·L-20 /
`paneLayout` P-18·P-19·P-21）：只读侧无配置入口与地址 / 令牌 / 方式输入且保留打开与打码 URL，
配置侧保留三动作与表单，旧「三动作齐全」断言 retarget 为「打开常在 + 编辑·删除只在配置模式」（收紧非放宽）。
真机 ArkTS 编译 / 两模式观感 `unverified`（设备 lane 在跑，本批不做构建 / 装机）。

**数据导入导出是真页面（`mod-settings-export-page`，2026-11-21）**：四行设置菜单的「数据导入导出」行 push 的
`pages/SettingsExportImport.ets` 不再是复用 `SettingsHost` 的薄壳——它自带 `PageLayout(title:'数据导入导出')`、
一层 flex（自己的 `Scroll` + 底部唯一主操作「导出」，按今天日期走真实完整包落盘链）、全部数据状态与方法
（选文件试算、显式确认导入、写前复核、取消与复制路径）。正文继续装配 `components/settings/DataSection.ets`
→ `components/ExportImportPanel.ets` 两个 presentational body：区间入口只有 今天 / 本周 / 近 7 天 chip +
两个日期字段，动作只有 导出完整包 / 选择文件 / 确认导入，没有「填今天」重复提示，也没有「日程备份」节，
媒体能力留在主流程。`SettingsHost` 不再为 `section='data'` 渲染正文 / 装配 props（删 `DataGroup` /
`PrimaryExportButton` 与 `DataSection` import）；导出 / 导入状态只写 AppStorage 两个时刻键，不写
`settingsStore`，故任何子页保存都不会清空它（`settingsMenu` M-09 钉住）。真机 ArkTS 编译 /
文件选择器观感 `unverified`（设备 lane 在跑，本批不做构建 / 装机）。

**API 配置是真页面（`mod-settings-api-page`，2026-11-21）**：四行设置菜单的「API 配置」行 push 的
`pages/SettingsApi.ets` 不再是复用 `SettingsHost` 的薄壳——它自带 `PageLayout(title:'API 配置')`、
一层 flex（自己的 `Scroll` + 底部唯一主操作「保存」）、全部 AI / 多源 fallback 状态与方法
（读盘、服务与模型下拉、测试连接、保存、四路 fallback handler），返回键走 `router.back()`。
正文继续装配同一份 `components/settings/AiSection.ets` presentational body：服务 + 模型两个预设下拉、
API Key 密码框、自定义源才显示接口地址，没有「高级」控制、没有手输模型名（§11 删除口径不变）。
`SettingsHost` 删 `SECTION_API` / `AiGroup` / `PickerSheet` / AI 状态与 handler；`settingsStore.save()`
为 patch，未提供的 AI 键保留磁盘原值，M-10 钉住「剩余页面保存不触碰 AI 字段」。真机 ArkTS 编译 /
保存落盘与弹层观感 `unverified`（设备 lane 在跑，本批不做构建 / 装机）。

**远程实例入口去重（`mod-settings-instances-entry-dedupe`，2026-11-21）**：设置树里指向可配置实例页 `pages/Instances` 的导航只剩一条——四行菜单的「远程实例」行（`pages/Settings.ets`，`ROUTE_INSTANCES`）。旧 `SettingsHost` 长滚动里的「远程实例与云端对话 ›」行（`ChatEntryRow` → `openInstances`）、包装它的 `RemoteGroup()`、两套历史骨架的两处装配与「远程」锚点 chip 一并删除（不留「永远 toast 未测量」的死锚点）；实例页内部（列表 / 表单 / 播种 / 打开）一字未改。`instancesEntryDedupe.test.mjs` 正向钉住「Settings 树里 `pages/Instances` 字面量恰好 1 处、文件列表 === `['pages/Settings.ets']`」，旧文案全树绝迹，两份 `main_pages.json` 与顶层页装配仍保证路由可达；四份旧守卫按 old→new retarget（旧断言一条未删）。真机编译 / 观感 `unverified`（本批不做构建 / 装机）。

**面板页头去跨节导航（`mod-pane-header-nav-dedupe`，2026-11-21）**：四面板页头只放 pane 专属动作，换段只走 `ShellRail`（`onSelect` → `Home.selectSection()`）。远程 DSH 页头删掉与轨重复的「云端对话」按钮及其 `openChats()` handler：只读页头只剩标题、无点击动作；配置页头仍只有「添加实例」。`instanceList` U-11/U-15、`paneLayout` P-19/P-21、`shellLayout` L-11/L-20 由「桥接存在」retarget 为「跨节导航绝迹 + 只读页头为空 / 配置为添加实例」（旧断言未删），三份守卫各补一条正向守卫（U-S6 / P-22 / L-21）钉「四面板无跨节 push、无切段状态、选段只在 rail」。真机编译 / 观感 `unverified`（设备 lane 在跑，本批不做构建 / 装机）。

**设置 IA 整体守卫（`mod-settings-ia-guards`，2026-11-21）**：IA 契约本身未变，但本节此前分散在根页 / 子页 / 外壳各处的导航模型现在有了一处**整体**的可回归陈述，由 `tools/test/settingsIaGuards.test.mjs` 五例正向钉住：根页只导航（无任何配置控件）、恰好四个目的地且各出现一次（两份 `main_pages.json` 都登记）、页间动作词表不串页且每页确实渲染自己的动作（`Button('…')` 计数仅次要信号）、四目的地之间没有任何 `router.pushUrl` 横跳（三真页面只 `router.back()`）、根页不声明锚点机制（chip↔行一致性由 C6 / D2 / remoteSettings 钉住）、四个读者必须读到真实非空源码。「远程实例」行是唯一标题不一致项：路由壳 `pages/Instances.ets` 没有 `PageLayout`，真标题在 `pages/panes/InstancesPane.ets` 的 `Text('远程 DSH')`——这是实际契约，测试按此钉住而非伪造一个「远程实例」标题。IA-02/03/04 已被既有守卫逐字覆盖，故本模块只在测试头注释注明跳过、不重复断言。真机端侧 **未装机 / unverified**（安装版 `1000004` 不含本模块）。

**云端对话面板落真（`mod-shell-cloud-chat-pane`，2026-11-21）**：上表「占位无假行」与 S3「其余三面仍是占位」两条对 `CloudChatPane` 已失效——它现在是真实**只读会话列表**：复用 `services/chatStore.ets` 的 `listChats()` 与 `model/chatList.ts` 的 `filterByKind` / `sortChats` / `chatSummaryLine`，点行进 `pages/ChatDetail`；保留 `deepLinkId` / `active` 两个 prop 与 `active → Visibility.Visible/Hidden` 保活，`aboutToAppear` 只读一次。没有搜索 / 下拉刷新 / 新建 / 发送 / 设置控件，空态唯一下一步仍是「先在设置里配置仓库」。`paneLayout` / `shellLayout` / `indexHeader` / `uiTokens` 的 scaffold 断言逐条 retarget（旧断言一条未删），新增 P-23 / P-24 / L-22 正向守卫钉「复用既有数据链、无 ad-hoc JSON、只读详情路由、零 RPC / 零配置 / 无跨节导航」。真实构建 `build-20261121-194922.log`（`CompileArkTS` EXECUTED），`modules.abc` 含「还没有云端对话」且不含已退役 scaffold 句；真机端侧 **未装机 / unverified**（安装版 `1000004` 不含本模块）。

**实例列表没有本机行（`mod-instances-drop-local`，2026-11-21）**：产品定版「平板不跑原生 DSH，所有 DSH 都是远程实例」，`InstancesPane` 只渲染远程行——没有「本机（默认）」首行、没有本机特例动作（打开参数缺省 / 只改名表单 / 删除豁免）；空表是正常首用态，配置模式主操作「添加实例」、只读模式「去设置添加实例」。旧持久化 `local` 行读取时按字面量过滤（不迁移、不复活、不重编码），不影响同信封里的远程行。**未装机 / unverified**（安装版 `1000004` 不含本变更）。

**AI 汇总标签恒为「AI 汇总」（`mod-ai-summarize-label`，2026-11-21）**：汇总完成后按钮标签恒为「AI 汇总」（幂等，再点即重生成），「重新生成」文案在 fallback `pages/Index.ets` 与外壳真 body `pages/panes/SchedulePane.ets` 两个日程源码中绝迹；空态「生成汇总」/ 失败态「重试」保留为不同且诚实的状态。真实 Wave B 构建 `entry-default-unsigned.hap` 内嵌 `ets/modules.abc` 含「AI 汇总」且不含「重新生成」，两处源码标签均已编进 abc；**未装机 / unverified**（安装版 `1000004` 不含本变更）。
