# REVIEW — mod-instances-pane-readonly（独立只读评审）

## 结论
P0 0 / P1 0 / P2 4（均非阻断）。**可以提交**（须按模块拆分；ArkTS 编译与真机观感 `unverified`）。

## Findings（file:line）
- P2-1 工作树混入另一模块：`Chats.ets` / `CloudChatPane.ets` / `modSettingsCloudNoConfig.test.mjs` / `docs/REVIEW-cloud-chat-no-config-note.md` 与本模块同处未提交状态；本模块只含 `Instances.ets`、`InstancesPane.ets` 与 3 份 guard 的改动。提交按模块拆分，勿混批（`git status --short`）。
- P2-2 `SettingsHost.ets:1282/1445-1446/1486/1522` 仍保留旧「远程实例与云端对话」入口，与 `Settings.ets:164` 四行菜单「远程实例」并存；两者都指向 `pages/Instances`（`configurable:true`），不影响只读/配置分界，属既有代码、不在本模块改动集。
- P2-3 只读面板仍携带配置态与方法（`InstancesPane.ets:89-97` 的 `panelMode/formName/formUrl/formMode/formError`；`:223-314` 的 `showAdd/showEdit/submitForm/deleteInstance`），仅由 `configurable` 门控不可达；单一事实来源的代价，非功能缺陷。
- P2-4 只读空态标题「还没有可管理的 DSH 实例」（`:52`）中「可管理」与只读定位略不一致；U-02 钉住逐字共用，未改，仅记录。`deepLinkId`（`:70-71`）为未消费的预留 prop，非本模块引入。

## 拆分证明（pane 只用 vs Settings 页配置）
模式 prop = `configurable: boolean = false`（`InstancesPane.ets:78`）。
- 只读调用点：`Home.ets:198-201` 装配 `InstancesPane` 仅传 `deepLinkId/active`，**不传** `configurable` → 默认 false。
- 配置调用点：`pages/Instances.ets:21` 显式 `configurable: true`；该页是 `Settings.ets:42/164`「远程实例」行的 push 目标。`SettingsHost` 不承载实例正文，只保留一行入口（`:1280-1310`）。
- 配置 UI 全部在 `if (this.configurable)` 内：页头「添加实例」`:362`；空态就地添加 `:395`；问题行「重新添加」`:443`；行内「编辑/删除」`:538-565`；build 中 `FormPanel` 调用 `:666`；`FormPanel` 本体（TextInput/Select/保存/取消）`:575-653`。四模式块 + builder（`instanceList.test.mjs:474`）。
- 只读可见：本机首行播种 `:121-142`/`:679-681`；状态·可达 `:498-513`；打码 URL `Text(redactUrl(view.url))` `:516`；「打开」`:526-537`；问题行与空态走 `openInstanceConfig()` `:217-221` → `pages/Instances`（常量 `:62`），无内联表单。
- 令牌：只渲染 `store.redacted()`（`:147`）+ `redactUrl()`（`:516`）；token 仅进 `openInstance` 的 router params（`:194-198`）与 `submitForm` 的 `RawInstance`（`:287-289`），不进 Text/日志；`normalizeRemoteUrl` 的 reason 全是静态常量（`remoteUrl.ts:137-140`），不回显令牌。

## Guard 判定
三份 guard 全绿，且为**收紧**而非放宽：U-17/U-18/U-20/U-21（实例）与 P-18/P-19/P-20、L-11/L-19/L-20（布局）按模式切源码验证「只读无配置入口 / 配置保留全部能力 / 两种模式都有打开 / 空态跳设置」；U-16、P-19、L-19 验证占位串绝迹。只读源码用 `readonlySource()/readonlyRegions()` 挖空配置块（`instanceList.test.mjs:100-114`、`paneLayout.test.mjs:71-82`、`shellLayout.test.mjs:105-116`），非空泛 `includes`；未见假阳性或放宽。

## Gate tails（本机复现）
- 三 guard：`ℹ tests 77 / ℹ pass 77 / ℹ fail 0 / ℹ skipped 0 / ℹ duration_ms 1061.3317`
- 全量：`ℹ tests 3097 / ℹ suites 365 / ℹ pass 3096 / ℹ fail 0 / ℹ skipped 1 / ℹ duration_ms 55760.8067`
- validate-app：`✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 488 条、main 静态 import 635 条、页面 12 个、rawfile/git 2 个文件）`
- overlay：`覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）` / `[overlay] applied=false`
（全量 1 skip 为已知代理环境下的 fetch 直连用例；3097 与《项目理解》旧基线 2306 的差额来自后续模块，非本模块回归。）

## Unverified
`.ets` 不在 tsc 范围（`UI-DESIGN.md:495-497`），四道 gate 无 ArkTS 编译与真机步骤；`InstancesPane.ets` / `Instances.ets` 的编译、横竖屏布局、真机点击与可达状态均无设备证据（hdc 无目标），`unverified`。
