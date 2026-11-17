# ROADMAP / 执行状态

> 各阶段执行者在表尾追加自己的状态行；只追加，不修改他人结论。

| 阶段 | 状态 | 完成时间 | 证据 / 说明 |
| --- | --- | --- | --- |
| P4 DSH 插件复查（渲染 / locale / icon / README / 文档） | ✅ 完成（真实 GUI 渲染未验证） | 2026-11-15 | 修复设置卡片子节点丢失、`meta.detail` 改为真实文档路径、README 安装步骤与 `insert:` 限制；新增渲染/包元信息/locale 断言。插件测试 74/74 通过 |
| P5 设置页评审补漏 + 同步链路健壮性（执行代理 C） | ✅ 完成 | 2026-11-15 | 仓库地址可空保存（解除首次使用死锁）、settingsStore 键成对性与 AI 模型时序、凭据卫生审计、同步错误四档分级（`model/syncError.ts`）、设置页「上次同步 / 上次错误 / 重试」；新增 3 个测试文件 55 例（29 / 15 / 11），`validate` 8/8。详见下方「P5 明细」 |
| 手写板手写笔手感 + 「一笔框」评估（执行代理 A / hw） | ✅ 完成（一笔框按用户要求已移除） | 2026-11-15 | 保留：`model/strokeSmooth.ts`（二次 B 样条平滑，点数不变/首尾不动）、`brush.ts` 追加压感 `pressureWidthScale`/`pressureWidth`（0..65535 → 线宽，夹 [0.5, base×1.6]）与圆珠笔/铅笔速度调制 `speedWidthScaleFor`、页面历史点补采（`getHistoricalPoints`）+ 二次贝塞尔实时平滑 + `StylusAssist.ets`（轻捏切橡皮/双击撤销/帧率提升，全 try/catch）。**已移除**：「一笔框」（一笔闭合→自动不 OCR 区域）连同 `model/oneShotBox.ts`、`tools/test/oneShotBox.test.mjs`、`ONE_STROKE_CLOSE_RATIO`、`InstantShapeGenerator` 调用与工具按钮全部删除，`entry/src/**` 与 `tools/test/**` grep 零命中。`node --test` 461 全绿、`validate-app` 8/8、`build-harmony.ps1` + `verify-hap` 通过。**未验证**：真实手写笔的压感/平滑体感（注入工具无法产生压感与连续闭合轨迹） |
| 手写板工具条定版 + 稳定页 id（执行代理 A / hw） | ✅ 代码/单测/产物验收完成（真机试笔未做：设备掉线） | 2026-11-15 | 定版 9 位置工具条：竖屏顶部 48vp 单行 `[笔形▾][粗细▾][颜色▾][橡皮][手动框][撤销][重做][- n/m +][完成]`、横屏左侧 56vp rail 同序「完成」贴底；橡皮/手动框为独立按钮（再点回画笔，互斥）；页码改两步确认删除 + 当前页后插入；`preferences` 的 `handwriting.tipShown` 只弹一次引导；常驻文案与「清空」全部移除（grep 零命中）。模型层：`pageBook` 改「稳定页 id `p1/p2…` + 插入/删除后 id 跟随」，画布与截图 id 按页 id 绑定（`hw-page-p3`），插页后笔迹/框/撤销历史跟着页走。`node --test` 512 全绿（pageBook 25 例，新增 9 例覆盖插页/删页/id 不复用/上限）；`validate-app` 8/8；`build-harmony.ps1` + `verify-hap` 通过（1,461,511 B） |
| UI 重构 + 横竖屏自适应 · 四页完成（执行代理 D / uirefactor） | ✅ 完成（真机横竖屏、截图、真机三源测试未验证） | 2026-11-15 | 新增 `docs/UI-DESIGN.md`（191 行 / 19 条量化问题：主操作数、触控<40vp、字号 11→3 档、间距 45 处越界、硬编码色 24 处、信息密度；含令牌表、断点栅格、每页横竖屏布局、旋转方案）、`common/uiTokens.ts`（纯常量+纯函数，20 例单测）、`components/PageLayout.ets`（统一标题栏 + `onAreaChange` 断点、`breakpoint` 对外暴露）、`resources/dark/element/color.json`（14 令牌深色跟随）、`module.json5` 加 `"orientation": "auto_rotation"`。四页重排：Index（竖屏单列 / 横屏左日期列+右列表；`新建` 唯一主操作，AI 汇总·同步·提醒·含其他设备进「更多」）、Edit（左表单 / 右手写与附件预览，底部单一保存，手写入口仅鸿蒙）、Detail（左正文+AI / 右附件与元信息；`编辑` 唯一主操作，哈希进「更多」）、Settings（3 组 ≤4 行 + `?` 弹层 + 高级折叠，接 C2 的 `aiProvider` API：服务/模型联动、模型可手输、baseURL 仅 custom、测试显示真实往返耗时、「实验」标签取 `preset.experimental`）。`node --test` 512 pass / 0 fail、`tsc` exit 0、`validate-app` 8/8。**未验证**：设备 `hdc list targets` 为 `[Empty]`（此前锁屏），横竖屏布局、`docs/images/ui-*.png` 截图、三个 AI 源的真机「测试」结果均未取到；`orientation` 与手写页锁方向需重新构建生效。手写板旋转坐标系缺陷只报告未改（`docs/UI-DESIGN.md` §5，属 A 的文件） |
| 多 AI 源（provider）纯逻辑 + 服务层（执行代理 C2 / aiprovider） | ✅ 完成（真实 key 未端到端验证） | 2026-11-15 | 新增纯逻辑 `model/aiProvider.ts`：4 源预设（`deepseek` / `opencode-go` / `codex` / `custom`）+ 模型表 + `findProvider` / `modelsOf` / `defaultModelOf` / `resolveModel` / `normalizeBaseURL` / `isValidBaseURL` / `chatCompletionsURL`（零 SDK import，Node 直接跑）；`settingsStore` 增 `aiProviderId` / `aiBaseURL` 与 `cachedProviderId()` / `cachedBaseURL()`，旧数据（只有 `aiKey`）在 `load()` 里成对迁移到 `deepseek` + `deepseek-chat` + 预设地址并经 `save()` 写回；`deepseek.ets` 调用前按源解析地址与模型（`summarize` 增可选 `providerId` / `baseURL`，`testAiConnection(key, providerId, modelId, baseURL)` 且旧签名 `(key, model)` 仍可用），20 秒超时 / 退避重试 1 次 / 中文错误不变，密钥仍只进 `Authorization` 头；新增 `tools/test/aiProvider.test.mjs`（40 例）、`aiRequest.test.mjs` 补 2 例。收尾：`model/aiRequest.classifyAiError(status, body, providerLabel?)` 文案中性化（缺省「AI 服务 401：…」，deepseek 服务层传入预设源名）；`AiProviderPreset.experimental?` 只标记 `opencode-go`；`testAiConnection` 真实发 `max_tokens=8` 的 chat completions 并返回 `elapsedMs`；`resolveModel` 对非空模型名一律保留（模型下线可手输）。**发布版预设（端点/模型 id 取自本机 DSH `resources/app.asar` 的真实路由）**：`deepseek` → `https://api.deepseek.com/v1`（`deepseek-chat`/`deepseek-reasoner`）、`opencode-go` → `https://opencode.ai/inference/go/v1`（`deepseek-v4.1-flash`/`deepseek-v4-pro`）、`codex` → `https://api.openai.com/v1`（`gpt-5.1-codex`/`gpt-5-codex`/`gpt-5.1`，**API Key 模式，不支持 ChatGPT 订阅**）、`custom` 用户填。**未验证**：真实 key 的端到端调用；`opencode-go` 端点未实测（UI 标「实验」）；codex 与 opencode 的模型额度/权限取决于账号。自助引导：`keyHint` 四条单行文案（Key 输入框下方）+ 纯函数 `hintForProvider(providerId, status)`（401/403/404/429/超时/网络/5xx 各给下一步建议）。版本字段（`versionName 1.0.0` / `versionCode 1000000`）已核实、**本轮未动**。**待办（未实施）**：构建元数据 buildId 需要时再在 `build-profile.json5` 的 `buildOption` 里加，避免动已验产物 |
| 每日 AI 汇总 · 纯逻辑 + 存储 + 冲突策略（执行代理 C2 / aiprovider） | ✅ 完成（Index 展示由 D 接；真机同步与真机生成未验证） | 2026-11-15 | 新增纯逻辑 `model/dailySummary.ts`（零 SDK import）：落盘 `devices/<deviceId>/summaries/YYYY-MM-DD.json`（与日程同目录树、随 git 同步，**不写进 schedules JSONL**）；`summariesPath` / `summaryFilePath` / `serializeSummary` / `parseSummary`（`ok`\|`empty`\|`corrupt`，坏文件与读失败**不抛**）/ `sanitizeSummary`（要点 ≤3、headline 与要点压单行、`YYYY-MM-DD` 真日历校验、计数非负且 `doneCount ≤ recordCount`）/ `mergeSummary`（同日取 `generatedAt` 较新，相等保留现有，返回 `replaced`）/ `truncateSummaryForDisplay`（默认 3）/ `buildSummaryPayload`（复用 `aiPayload.buildDaySummaryPayload`，与增量载荷唯一差别是不过滤已处理记录）/ `summaryFromReply`（Markdown → headline + ≤3 要点）/ `SummaryIO` 端口的 `readDailySummary`、`writeDailySummary`（旧文件读失败拒绝写 `read-failed`、陈旧回复 `stale` 不覆盖、损坏文件 `repaired` 重写、写失败 `write-failed` 旧文件保留）；新增 `services/summaryStore.ets`（真实 fs 端口的 `RepoSummaryIO` + `read(date)` / `generate(...)`：**先 AI 后写盘**，AI 失败一个字节都不写）；`model/aiPayload.ts` 抽 `selectPayload` 并新增 `buildDaySummaryPayload`（`buildAiPayload` 行为不变）。**同步范围结论**：`git-bridge` push 递归 add 整个 `devices/<deviceId>/`，`summaries/` **自动在范围内**，`syncScope` 无需改动（已用 `assertWithinDevice`/`filterPathsForDevice` 实测断言）。新增 `tools/test/dailySummary.test.mjs` 33 例（含真实临时目录落盘的覆盖/不覆盖口径）。**未验证**：真机 Index 渲染与「今日第一项」位置（D 的 UI）、真机 git 同步能把 `summaries/` 带出、真实 AI 回复的 headline/要点质量。**待办**：`docs/DATA-CONTRACT.md` §1 补 `summaries/` 目录说明 |
| 收口批次：笔迹设置菜单 / 主从布局 / 附件 zip / 未完成索引 / 电脑端日程桥（执行代理 A/C2/D/F/G + planner） | ✅ 代码与产物验收完成（部分真机项待解锁补验，见 VERIFICATION §13.3） | 2026-11-15 | 笔迹设置三段面板（笔形/粗细/颜色，选中即生效不关面板）；分页三单元格；草稿；竖屏单列（<840vp）/横屏主从（≥840vp）；附件 JPEG q60 + 按天 zip（JSZip，两端通用）；open.jsonl 未完成索引（30 天自愈）；GitBridgeHost + 启动 pull + 下拉刷新；插件 schedule_list/add/summary。App 704 例 / 插件 98 例全绿，validate 8/8，HAP 2,133,649 B、APK 53,628,063 B 均过产物校验 |

## P4 明细（dsh-git-config-sync）

- **渲染**：`Card`/`Field` 过去用 `arguments` 取 children（React 只走 `props.children`），
  导致所有卡片内容与表单控件不渲染；已改为 `React.Children.toArray(props.children)`，
  并由 `test/client-render.test.mjs` 用符合 React 语义的桩回归（2 select / 8 input / 9 button 等）。
- **locale**：`en`/`zh` key 集合一致（151），代码用到的 148 个 key 全部存在；
  `meta.detail` 从多行说明文本改为 `docs/DETAIL.md`（en）/ `docs/DETAIL.zh.md`（zh），
  详情文档随包发布（`files` 含 `docs`）。
- **icon / 详情**：`exports["./icon"]` → `icon.svg`（64×64，625 B，无脚本/外链），真实存在且 ≤256 KiB；
  `description` 132/58 字符、单行；`author`/`homepage` 缺失但 Plugin Manager 不渲染这两个字段。
- **README**：本地目录安装改为与根 README 一致（GUI Add plugin / `dsh plugin add link:`，
  安全启动器只收包名与 `github:`）；补 `dist/client.js` 前置检查、构建与重启说明；tarball 版本改为 1.0.0。
- **文档**：新增 `insert:` 多行块限制（整块合并、一块一行、不得嵌套）到插件 README，并同步两份 DETAIL。
- **未验证**：真实 DSH Web GUI 的视觉/交互（`http://127.0.0.1:37510` 返回
  `dsh web authentication required`，无已鉴权会话）；host RPC 已由其他执行者覆盖。
- **全仓 `node --test` 的外部阻塞**：复查时 `apps/arkui-schedule/tools/test/platformDetect.test.mjs`
  仍读取已被并行迁移删除的 `entry/src/{main,harmony}/ets/common/platformFeatures.ts`
  （现为同目录 `.ets`），导致 363 项中 2 项失败（361 pass）；属 apps 并行改造，未在本阶段修改。
  插件自身 `node --test "packages/dsh-git-config-sync/test/*.test.mjs"` 为 74/74 全绿。

### P4 真实 GUI 验证（2026-11-15 补充）

- `http://127.0.0.1:37510`：HTTP 可达，但正文为
  `dsh web authentication required; reopen the URL printed by dsh web.`，浏览器没有已鉴权会话；
  `dsh web` 的 launch token 只存在进程内存/终端输出里。只读扫描
  `%USERPROFILE%\.dsh\{launcher,safe-launch,cache,sessions,state}`、
  `%APPDATA%\@deepseek-ai\dsh-desktop\{Local Storage,Session Storage,Network,logs}` 与 `%TEMP%`
  共 224,243 个文件，带 `token=` 的 `http://127.0.0.1:37510...` URL **0 命中**；
  未读取个人浏览器 Cookie、未伪造会话、未改任何 DSH 配置。
- 已鉴权的 **DSH desktop** 窗口可正常渲染：Plugins 页可见「内置插件配置 / 实验性插件 / 已安装插件」，
  固定截图 `C:\Users\GWL\Desktop\itwillclaude\.tmp\gui-plugins-page.png`。但本轮**没有看到**
  「设置 → 配置同步」卡片：Win32 合成点击可切换 Plugins 页，之后窗口被前台其它应用遮挡/抢占键盘，
  键盘快捷键无法可靠送入 WebView，DevTools 方案也已放弃（不改窗口尺寸、不抢焦点、不影响其它执行者）。
- 结论：**设置卡片真实渲染仍未验证**；因为没看到卡片，未生成 `gui-plugin-card.png`（不伪造视觉结论）。
  本轮无代码改动，插件测试仍 74/74。

## P5 明细（设置页评审 + 同步链路健壮性，执行代理 C）

### 决策 1：仓库地址允许为空保存（解除首次使用死锁）

- **问题**：`saveSettings` 过去用 `validateRepoUrl` + `validateToken` 做**全字段必填**，仓库地址为空即拒绝保存。
  首次使用的真实路径是「先在本机记录日程、之后再配同步」，此时用户连设备标识 / 作者名 / AI key
  都存不下来；而改这些字段正是配同步之前要做的事 → 设置页自锁。
- **决策**：**仓库地址可为空**（`''` 可保存，不报错但给提示）；设备标识 / 作者名仍必填；
  token 仅在「仓库地址非空 + 认证方式 HTTPS」时必填。
  空地址在**测试连接 / 拉取 / 推送 / 查看状态**前仍被强校验拦住，不会带空地址发请求。
- **证据**：`apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets:224`（`saveSettings`，`:227`
  计算 `repoEmpty`、`:230-231` 跳过地址/token 必填、`:245` 存空串、`:261` 保存后的提示语）、
  `:474`（`runAction` 先 `validateRepoUrl` 再发请求）、`:312`（测试连接前校验）。
- **回归**：`settingsStorePairing.test.mjs` 固化新键成对读写；地址允许为空的判定是页面逻辑，
  由 `repoUrl.test.mjs`（`validateRepoUrl` 对空串给中文原因）与本节记录共同守住。

### 决策 2：settingsStore 新键成对 + AI 模型取用时序（已满足，加测试固化）

- `aiModel` / `gitPlatform` / `authMode` 三个键在 `load()`（`:111`，默认 `deepseek-chat` /
  `github` / `https`）与 `save()`（`:158`）里成对读写，读取时用 `normalizeAiModel` /
  `normalizePlatform` / `normalizeAuthMode` 归一化未知值。
- `cachedAiModel()` 在缓存为空时返回空串，`services/deepseek.ets` 的 `resolveModel()` 依次回落
  显式参数 → 缓存 → 默认 `deepseek-chat`；主页 AI 汇总流程先 `settingsStore.load()` 再
  `summarize()`，因此缓存必然已就绪（`settingsStorePairing.test.mjs` 用源码位置断言固化）。
- 本轮新增 3 个键：`lastSyncAt` / `lastSyncError` / `lastSyncAction`（`settingsStore.ets:76-78`），
  由 `saveSyncState()`（`:199`）单独写入，`save()` 不会再把它们清空——避免「保存设置」把同步状态抹掉。

### 决策 3：凭据安全（审计结论：合规，无泄露路径）

- token / AI key 只出现在 `Authorization` 头：`GitSyncService.ets:965`（探测）、`Settings.ets:312`
  （测试连接）、`deepseek.ets`（`Bearer`）；仓库地址禁止内嵌凭据（`validateRepoUrl` 拒绝
  `https://user:token@host/...`），因此不会出现 `https://token@host` 形态的 remote URL。
- 桥侧另有二次打码 `git-bridge.js:294 sanitizeMessage()`（`x-access-token:` / `token=` /
  `Basic` / `Bearer` → `***`），服务层 `syncError.ts:79 redactSecrets()` 是 ArkTS 侧第三道防线。
- App 侧页面/服务**没有** `console.*` / `hilog.*` 调用，同步载荷 `ScheduleRecord` 无凭据字段；
  由 `credentialHygiene.test.mjs`（11 例，含插件侧 `writeFilePrivate(credentialsFile)` 检查）固化。

### 决策 4：同步错误分级 + 用户可见状态

- 新增纯逻辑 `model/syncError.ts`：`classifySyncError(kindOrStatus, message)` → 四档
  `fatal | retry | conflict | auth`，附 `title` / `detail` / `retryable` / `kind`
  （`:163`）；`redactSecrets`（`:79`）；`describeLastSync`（`:359`）与
  `normalizeSyncAction` / `syncActionLabel` / `canRetrySync`。
- 服务层 `GitSyncResult` 增加机器可读 `code`（`E_AUTH` / `E_HTTP` / `E_GIT` / `E_FS` / `E_INPUT`），
  预检失败统一 `E_INPUT`（`GitSyncService.ets:842 validateForSync`、`:885 verifyPushScope`）。
- 设置页同步区展示「上次同步时间 / 上次错误（分级后文案）/ 重试按钮」：
  `Settings.ets:557 SyncPanel`、`:446 persistSyncState`、`:466 applySyncFailure`、`:474 runAction`。
- 单测：`tools/test/syncError.test.mjs`（29 例：分级、脱敏、时间文案、动作归一、冲突语义）；
  `settingsStorePairing.test.mjs`（15 例：键成对、默认值、模型时序、本页决策 1 的静态回归）；
  `credentialHygiene.test.mjs`（11 例：无日志、token 不进 URL、载荷无凭据字段、插件侧 0600 凭据文件）。

### 冲突语义：**已满足契约，未改格式**（证据）

- 以 `id` 为键、后写覆盖：`model/jsonl.ts:233 foldById`（先 `sortRecords` `:210` 稳定升序，再让
  后者覆盖前者，即同 id 取 `ts` 较晚的一条）。
- 只追加、不重写历史行：`services/scheduleStore.ets` 的 `appendLineSync`（定位文件末尾追加），
  折叠只在读取时发生；`serviceInvariants.test.mjs` 已用字节级断言守住。
- 跨设备不会真冲突：每台设备只写自己目录（`GitSyncService.ets:885 verifyPushScope` +
  `model/syncScope.ts` fail-closed），拉取固定快进、永不 merge
  （`rawfile/git/git-bridge.js:1301 fastForwardOnly: true`，push 前预拉取在同文件 `:1349`）。
- `deleted` 墓碑：`docs/CONTRACT.md` §3.2 的 `ScheduleRecord` **没有** `deleted` 字段，UI 也没有删除入口，
  因此不引入墓碑格式；「同 id 后写覆盖 + `ts` 比较」就是既有语义（`syncError.test.mjs` 用
  `foldById` 的跨设备用例 + 「带 `deleted` 的额外字段不改变折叠」用例固化，防止后人误加墓碑）。
- 分叉（本机与远端各有提交）是唯一真实冲突面：桥把它映射为 `FastForward` / `PushRejected`
  中文错误，`classifySyncError` 归到 `conflict` 档并提示「先拉取再推送」。

## 进行中（本轮：远程访问，2026-11-17 起）

> 上一轮（B3/表格 OCR/Wave3 等）的任务行已随交付归档，见本文上半部分的阶段表与 `docs/VERIFICATION.md`。
> 本轮由 `pm` 统一拆解；**单一规划层**（releaseplanner 已退役，其三条执行线跑完后交接给 pm）。

| 任务 | 负责人 | 状态 | ETA | 阻塞 |
| --- | --- | --- | --- | --- |
| A–E 五路调研（源码对照 / UU / Tailscale 鸿蒙 / IPv6 / 零自建） | pm/research-a…e | ✅ 完成，结论入 `docs/RESEARCH-*.md` | - | 无 |
| `src/remote/types.ts` 契约（8 字段 / 6 方式 / 状态 / 自检 / 服务接口） | pm | ✅ 完成 | - | 无 |
| `src/remote/accessMode.ts` + `urls.ts`（6 方式元数据、字段归一、URL 生成） | pm/exec-remote-model | ✅ 完成（25 例 / 233 断言） | - | 无 |
| `src/remote/probe.ts`（连通性自检，`external-reachability` 恒 unknown） | pm/exec-remote-probe | ✅ 完成（32 例全绿） | - | 无 |
| 客户端「远程访问」独立 section + `remote*` RPC 8 个 action + locale | pm/exec-remote-ui | ✅ 完成（rpc 14 例 / render 10 例） | - | 无 |
| `src/remote/store.ts`（remote.json / remote-token.json，0600 + 原子写） | pm | ✅ 完成 | - | 无 |
| `src/remote/routes.ts`（`/__dsh_remote/*` + 令牌门 + 上游 cookie 注入） | pm | ✅ 完成（19 例全绿） | - | 无 |
| `src/remote/service.ts` + `src/index.ts` 挂载（失败隔离、autostart、轮换） | pm | ✅ 完成（14 例全绿） | - | 无 |
| `listener.ts` / `auth.ts` / `qr.ts`（旁挂监听 + 令牌门状态机 + 零依赖 QR） | releaseplanner/remotelisten,remoteauth | ✅ 已落盘（listener 21 例 / auth 51 例 / qr 见 `remote-qr`） | - | 交接单待发 |
| App 设置页「访问方式 + 各方式字段」+ IPv6 地址支持 | pm/exec-app-remote | 进行中（remoteAccess 59 例已绿） | 20min | 无 |
| `docs/REMOTE-ACCESS-OPTIONS.md` + DATA-CONTRACT §7 | pm | ✅ 完成 | - | 无 |
| **端到端验证（真实 DSH 3080 实例）** | pm | ✅ **13/13 通过**（含 WS 101） | - | 无 |
| **IPv6 真绑定端到端（本机公网 v6:3098）** | pm | ✅ **通过**（health/401/303/200 全绿，probe 5 ok + 1 unknown） | - | 无 |
| 独立只读评审（安全边界 / 失败语义 / token 出口） | pm/review-remote | ✅ 完成：**有条件通过**，P0=0 / P1=2 / P2=2，见 `docs/REVIEW-remote-security.md` | - | 无 |
| 评审修复 M1（ipv6 方式起不来）/ M2（上游 cookie 过期不 fail-closed）/ M3（manualUrl token 进 DOM）/ M4（`?k=` 与 `?token=` 不一致） | pm | ✅ 全部已修 + 补测试（见下「评审修复」） | - | 无 |
| 真机验收（平板已切回家中 WiFi，`192.168.1.10` / USB `6MFBB25C27205131`） | pm/qa-remote-device | ✅ 完成（**3 通过 / 1 不通过 / 1 未执行**） | - | 见下「真机验收结论」 |
| 真机：竖↔横旋转往返 | —— | **待用户动手** | - | 设备无 `wm`/rotate，`uitest` 无 rotate，`snapshot_display` 无旋转参数 → 只能人工把平板转一次再补拍 |
| 真机缺陷：内嵌 Web 的 WebSocket 握不上（`ERR_WS_UPGRADE -173`） | —— | **待定位（P1）** | - | 见下「WS 缺陷定位」；**先要 DSH 重启让本插件进链路**才能分清是 ArkWeb 还是代理 |
| 真实 GUI 渲染验证（设置页「配置同步」+「远程访问」两个 section） | —— | **待办（等 DSH 重启）** | - | 用户决定本轮不重启；重启后需人工看一眼设置页渲染，别丢 |

### 端到端证据（`192.168.1.6:3099` → 真实 DSH `127.0.0.1:3080`）

一次性脚本 `.tmp/e2e-remote.mjs`（不进仓库）跑出 13/13：

```
PASS  start                    {"lastError":null,"listen":"192.168.1.6:3099"}
PASS  health-200               {"ok":true,"app":"dsh-remote","mode":"lan"}
PASS  health-no-secret
PASS  root-401                 status=401
PASS  api-401-json             status=401
PASS  showLink-has-token       qr=37
PASS  token-303                status=303 set-cookie=1
PASS  cookie-not-upstream      no dsh-auth-* leaked
PASS  root-200-proxied         status=200 bytes=57970
PASS  no-upstream-cookie-leak
PASS  ws-101                   status=101        ← /api/remote.mux 的 WebSocket upgrade 真通
PASS  bad-token-401            status=401
PASS  bad-token-not-echoed
```

结论：**局域网直连（不需要 IPv6）+ 令牌门 + HTTP/WS 反代 + 二维码**这条主链已在真实 DSH 上打通；
上游 `dsh-auth-*` 会话 cookie 未下发给客户端；错误令牌不回显。

复现：`DSH_UPSTREAM_TOKEN=<launch token> node packages/dsh-git-config-sync/tools/e2e-remote.mjs`
（脚本在包内 `tools/`，读 env 里的 token，不落盘）。

**收尾全量验证（2026-11-17 22:1x）**：`node --test "packages/*/test/*.test.mjs"
"apps/arkui-schedule/tools/test/*.test.mjs"` → **1459 例 / 1458 pass / 0 fail / 1 skip**
（skip 是 listener 的 fetch 用例：本机 `HTTP_PROXY=127.0.0.1:7897` 且 `NO_PROXY` 不含 LAN，
被代理接管；无代理环境会真跑）；`validate-app` **8/8**；插件 `tsc -p` **exit 0**。

### IPv6 真绑定端到端（`[2409:8a20:4cad:ba20:d2c0:3d53:7540:763c]:3098`）

`node packages/dsh-git-config-sync/tools/e2e-ipv6.mjs`（env: `DSH_UPSTREAM_TOKEN` + `V6`）：

```
start: {"running":true,"listen":"2409:8a20:4cad:ba20:d2c0:3d53:7540:763c:3098","err":null}
health over v6: 200 {"ok":true,"app":"dsh-remote","mode":"ipv6"}
root without token: 401
token exchange: 303 cookie-set: true
authorized root: 200 bytes: 57970
probe: unknown 本机检查通过，但公网可达性必须从外网确认
  ok      dsh-port-known         DSH 监听端口：3080
  ok      dsh-loopback-reachable 本机能连上 127.0.0.1:3080
  ok      v6-global              找到 1 个稳定的全局 IPv6 地址：2409:8a20:…:763c
  ok      v6-stable              地址稳定（不是临时隐私地址）
  ok      dsh-bound-v6           能连上 [2409:…:763c]:3098（本机自连）
  ok      firewall-inbound       已找到入站放行规则：Node.js JavaScript Runtime
  unknown external-reachability  本机无法自证公网可达；请用平板在外网打开确认
```

即：**公网 IPv6 直连这条路在本机真的跑起来了**（绑具体 v6、令牌门、反代、自检），
只剩「外网是否可达」必须人工从外网验证（自检如实给 `unknown`，不假阳性）。

### 评审修复（`docs/REVIEW-remote-security.md` 的 4 条）

| 编号 | 问题 | 修法 | 回归 |
| --- | --- | --- | --- |
| M1 (P1) | `ipv6` 方式永远起不来：listener 只认局域网 IPv4 | `listener.ts` 新增 `isBindableIpv6Address` / `isBindableAddress`（放行 `2000::/3` 与 `fc00::/7`；拒 `::`/`::1`/`fe80::/10`/`ff00::/8`/`::ffff:`/带方括号/带 zone），启动校验改用它；`service` 侧透传 v6 字面量 | `remote-service.test.mjs` 新增 ipv6 启动用例 + 地址分类表；**真机级 e2e-ipv6 通过** |
| M2 (P1) | 上游 `dsh-auth-*` 过期后仍直送上游（客户端收到莫名 401） | `service.ts` 的 `upstreamCookie` 闭包同时判 `expiresAt`，过期即 `null` → `routes` 回 503（fail-closed） | 既有 503 用例 + 后台 6h 刷新定时器 |
| M3 (P2) | `manualUrl` 自带 token 时经 `status.urls` 渲染进 DOM | 新增 `redactUrlForDisplay`，`status.urls` 一律脱敏（`token=***`）；明文仍只走 `showLink` | `remote-service.test.mjs` 两条（函数级 + `getState` 端到端） |
| M4 (P2) | `auth.ts` 的 `TOKEN_PARAM='k'` 与门只认 `?token=` 矛盾 | `routes.ts` 同时接受 `token` 与 `k`（同时出现视为歧义输入直接拒），303 时两个都删 | `remote-routes.test.mjs` 三条（`?k=` 等价、歧义拒绝、strip 两者） |

### 本轮交付面（2026-11-17）

**代码（已提交，工作树 clean）**

| 提交 | 内容 |
| --- | --- |
| `5fce8dc` | 远程访问域主体：`src/remote/**`（types/routes/store/service/index + accessMode/urls/probe）、`src/index.ts` 挂载、`src/rpc.ts` 8 个 action、`src/client.js` 远程 section、`locale/*`、`dist/**`、App 侧 `model/remoteAccess.ts` + `remoteUrl` IPv6 + `Settings.ets` + `settingsStore.ets`、文档与测试 |
| `67b6126` | ROADMAP：全量验证数字、IPv6 真绑定证据、评审修复表 |
| `d211e15` | （交接）`src/remote/listener.ts` + `auth.ts` + `qr.ts` + 各自测试与 `dist` |
| `fec8345` | （交接）App「远程控制」页面 `pages/RemoteControl.ets` + `model/remoteUrl.ts` |

**新增能力清单**

- 插件：6 种访问方式（`lan` / `ipv6` / `cloudflare` / `tailscale` / `manual` / `uu`）的配置模型与可用性标注；
  旁挂监听（绑具体 IPv4/IPv6，**绝不 0.0.0.0**）+ HTTP/WS 反代；令牌门（`randomBytes(32)`、`?token=`/`?k=`/cookie、
  常量时间比较、同 IP 失败限速、上游 `dsh-auth-*` 只注入不下发）；零依赖二维码；17 项连通性自检；
  设置页独立 section「远程访问」（id `git-config-sync-remote`、order 71，与同步 section 状态隔离）；8 个 RPC action。
- App：`model/remoteAccess.ts`（与插件同一套字段语义）、`remoteUrl` 支持 IPv6 字面量、设置页按方式渲染字段、
  端口在 `lan/ipv6/tailscale` 下必填（用户拍板维持）。
- 文档：`docs/REMOTE-ACCESS-OPTIONS.md`（可行性矩阵 / 字段表 / 自检表 / 安全边界 / 未验证清单）、
  `docs/DATA-CONTRACT.md` §7、`docs/RESEARCH-{A,B,C,D,E}-*.md`、`docs/REVIEW-remote-security.md`。

**测试数字（最后一轮，2026-11-17 22:1x）**

- 全仓：`node --test "packages/*/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"`
  → **1459 例 / 1458 pass / 0 fail / 1 skip**（skip：`HTTP_PROXY` 接管导致 listener fetch 用例跳过）。
- `node apps/arkui-schedule/tools/validate-app.mjs` → **8/8**。
- 插件 `tsc -p tsconfig.json --noEmit` → **exit 0**；`node scripts/build.mjs` 可重复产出、commit 后无 dist 漂移。
- 端到端（真实 DSH）：LAN `13/13`（含 WS 101）；公网 IPv6 `PASS`（含 probe 5×ok + 1×unknown）。
- 独立评审：`docs/REVIEW-remote-security.md` P0=0 / P1=2 / P2=2，**四条全部已修 + 有回归测试**。

**发布状态（重要）**

- **未发 Release**（未获 lead 批准）。
- **未打 `dist-*` 交付包、未生成发布用 SHA256 清单**；本轮只有 `dist/remote/*.js` 的源码构建产物随仓库提交。
- 插件在 `~/.dsh/profiles/desktop` 是 **junction 链接**（`link:`），重启 DSH 即加载新 `dist/`；
  **本轮按用户决定不重启**，因此「设置页两个 section 的真实 GUI 渲染」仍未验证（记为上方待办）。

### 真机验收结论（2026-11-17，`6MFBB25C27205131`）

HAP `dist-harmony/arkui-schedule-harmony-debug-signed.hap` **2,881,758 B**
SHA256 `C2455DBC…0E5D219B`；`hdc install -r` **覆盖安装成功（未卸载）**；`verify-hap 6/6`；全程 **0 JS Crash / 0 FATAL**。
证据：`docs/VERIFICATION.md`「远程控制页真机验收（2026-11-17）」+ `docs/images/remote-*.jpeg`。

| # | 验收项 | 结论 | 要点 |
| --- | --- | --- | --- |
| 1 | 局域网方式打开内嵌 Web | **通过（带缺陷）** | 选「局域网直连」+ `192.168.1.6` + `3080` → 内嵌页渲染出 DSH 完整 UI（非白屏）；但左下持续「连接异常，刷新重试」，hilog `ERR_WS_UPGRADE(-173)` |
| 2 | 横竖屏往返 | **未执行** | 设备无 `wm`/rotate，`uitest` 无 rotate → 需用户**亲手转一次平板**后补拍 |
| 3 | 返回栈 | **通过** | 返回后地址/端口/方式都在；两轮进出不重复入栈；首页页头仍只有「今天」+「⚙ 设置」 |
| 4 | 错误路径（端口 9999） | **通过** | ~50s 后中文「打不开这台电脑上的 DSH 页面 / 页面加载失败（-7）ERR_TIMED_OUT / 重试 / 用浏览器打开」，**-7 而非 -29**（明文 HTTP 未被拦） |
| 5 | token 缺失 | **不通过（该实例口径不成立）** | 该 3080 实例的 `GET /` 带/不带 token 都 200（只在 WS 层校验），所以「去掉 token 应见 401」在本实例上不成立，不是 App 的问题 |

**顺带发现的两个真实缺陷（已修 / 待定位）**

1. **端口提示文案与语义矛盾（已修）**：真机上「端口」下仍写「0 = 跟 DSH 同端口」，但本轮已把
   `lan/ipv6/tailscale` 的端口改成必填（0 → 「请先填端口」）。已改 `model/remoteAccess.ts` 的
   `portField()` 提示与占位符（`placeholder: '3080'`）；设备上那份 HAP 是修改前构建的。
2. **内嵌 Web 的 WS 握不上（待定位）**：见下节。

### WS 缺陷定位（`ERR_WS_UPGRADE -173`，P1）

真机：内嵌页 HTTP 能加载，WS 握手失败。PC 侧对照（同一台 3080 实例，从本机直连局域网地址）：

```
GET /?token=<launch>         -> 303 + Set-Cookie
WS /api/remote.mux 无 cookie -> 401（服务端正常拒绝）
WS /api/remote.mux 带 cookie -> 101（服务端支持 WS，参考实现的旁挂监听也能转发 WS）
```

即：**服务端不是瓶颈**。同一份上游（`127.0.0.1:3080`）经**我们自己的**旁挂监听（`192.168.1.6:3099`）
跑 e2e 时 `ws-101` 也是 PASS。因此 `-173` 大概率是 **ArkWeb 在 WS 握手时没带上 DSH 的会话 cookie**
（或该版本对 `ws://` + 自定义端口的 upgrade 有限制），而不是代理或插件的问题。

下一步（需要 DSH 重启或用户配合，已列入待办）：

1. DSH 重启 → 本插件进链路（桌面 profile 是 junction，重启即生效）；
2. App 侧用 `@ohos.web.webview` 的 `WebCookieManager` 打印加载后的 cookie 是否存在；
3. 若确实是 ArkWeb 不带 cookie：本插件的令牌门已支持 `?k=`（评审 M4 顺带支持），
   可考虑让 `/api/remote.mux` 的 WS 鉴权接受 URL token——但 DSH 页面自己拼的 WS URL
   不受我们控制，需要评估注入方案。

### 本轮已定技术结论（评审基线，别再推翻）

1. **局域网监听**：自建 `http.Server` 绑**具体局域网 IPv4**，反代到 `127.0.0.1:<dshPort>`，改写 `Host`/`Origin`
   过 DSH 信任围栏。**绝不绑 `0.0.0.0`**——asar 实证：`webserver: host … is not a concrete IPv4 or IPv6
   address literal`，通配地址在加载期被拒。
2. **上游身份**：`ctx.connection.authenticatedUrl(baseUrl)` 在 DSH 0.2.2-rc.3 上**存在且可用**
   （asar 命中 `ConnectionPlugin.authenticatedUrl`），据此换取上游 `dsh-auth-*` cookie 由代理注入；
   该 cookie **绝不下发给平板**（否则等于交出 owner 会话）。拿不到该 API 时 fail-closed，不降级。
3. **UU 远程 = 不可用**（画面串流，无端口映射）；**卓易通里的安卓 Tailscale = 不可用**（宿主导航不走容器 netns）；
   `uu` 在 UI 里是 disabled 选项 + 明确原因，**不做假开关**。
4. **IPv6 直连可行**：本机有公网 `2409:8a20:4cad:ba20::/60`，DSH 的 `host` 接受具体 v6 字面量；
   自检必须剔除 `Temporary` 地址，且 `external-reachability` **恒为 `unknown`**（不许假阳性）。
5. **Cloudflare quick tunnel** 零账号可试，WS(101) 官方无明文 → 只能实测，故标 `needs-setup`。
6. **`port: 0` = 跟随 DSH 监听端口**（默认），不是随机端口。

## 子代理协作约定（本项目，用户 2026-11-16 明确授权）

- **并行执行子代理数量不设上限**：不再限制"同时最多 3 个"。可独立成块的任务一律拆开并行，
  按需 fan-out（规划子代理自行决定并发度，只受机器负载与真机串行占用约束）。
- 层级仍是「主会话 → 规划子代理 → 执行子代理」，执行子代理不再向下派生。
- 执行子代理不只写代码，也可承担调研、方案评估、代码评审、真机验收、文档补记。
- **唯一不能省的是评审**：涉及数据格式、失败语义、安全边界、删除/覆盖类操作的关键改动，
  必须有**一个独立的执行子代理**做只读评审（作者不能自评），评审结论落 `docs/REVIEW-*.md`。
- **真机是串行资源**：同一条 `hdc` 链路同一时刻只允许一个执行子代理装机/操作，
  其余任务在后台跑，等独占方结束再入场。
- 规划子代理每轮向主会话汇报三行：完成 / 进行中含 owner / 阻塞或需决策。
