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
