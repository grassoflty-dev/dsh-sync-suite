# 验证报告（VERIFICATION）

> 本文件记录**实际执行过的命令与真实输出**（2026-11-14，Asia/Shanghai）。
> 未验证项集中列在 §6，不虚报；所有产物均可在仓库根 `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite` 重跑。

## 0. 环境与结论

| 项 | 值 |
| --- | --- |
| OS / Shell | Windows 11 + PowerShell 7（无 bash） |
| Node / pnpm / git | v24.14.0 / 11.22.0 / 2.53.0.windows.2 |
| TypeScript | 5.9.3（devDependency，仅开发期；插件运行时零 npm 依赖） |
| 结论 | **两条工程线全部交付并通过本机可执行验收**；DevEco 构建、真机 OCR/提醒、真实远端认证等本机不可执行项已在 §6 如实标注 |

验收命令与结果：

```powershell
pnpm build
# plugin build: dist/index.js + dist/client.js 已生成
# app logic tsc: exit 0
# node --check: dist/index.js / dist/client.js / .build/model/jsonl.js 全部通过
# [build] 全部构建步骤完成

node --test "packages/dsh-git-config-sync/test/*.test.mjs"
# ℹ tests 62  ℹ pass 62  ℹ fail 0

node --test "apps/arkui-schedule/tools/test/*.test.mjs"
# ℹ tests 155  ℹ pass 155  ℹ fail 0

pnpm test
# ℹ tests 217  ℹ pass 217  ℹ fail 0（62 插件 + 155 应用）

node apps/arkui-schedule/tools/validate-app.mjs
# ✅ 全部通过：8/8 条规则（JSON5/JSON 12 个、相对 import 78 条、main 静态 import 86 条、页面 4 个、rawfile/git 2 个文件）

node --check packages/dsh-git-config-sync/dist/index.js    # exit 0
node --check packages/dsh-git-config-sync/dist/client.js   # exit 0
node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json --noEmit   # exit 0
```

> 注意：Node 24.14 的 `node --test <目录>` 会把位置参数当 glob 并报 `MODULE_NOT_FOUND`（空目录同样复现）。
> 仓库脚本与文档统一改用 glob：`node --test "…/test/*.test.mjs"`。

## 1. 交付物 A：dsh-git-config-sync

### 1.1 清单与构建（BRIEF §2.1）

| 验收项 | 证据 |
| --- | --- |
| Cordis 函数插件 `apply(ctx, config)`，注册全走 `ctx.effect` | `src/index.ts:43-61`；构建 + `node --check dist/index.js` |
| `package.json` 字段（name/type/exports/dsh.bundle.patch/dsh.client/files） | `packages/dsh-git-config-sync/package.json`；`npm pack --dry-run` → **22 个文件，含 `dist/client.js`** |
| TS → dist，dist 提交、安装免构建 | `pnpm build` 实测；`dist/**` 已生成并纳入提交 |
| 运行时零 npm 依赖 | 源码非相对 import 全部为 `node:child_process|crypto|fs|fs/promises|http|os|path` |
| 不导出 `Config`、无 schemastery | `src/` 无 `schemastery`；`dist` 无该依赖 |
| 不使用 `settings.installSection` / `settings.plugin.item` | 源码检索无命中（client 测试同样断言） |
| `pnpm build` 后 `node --check` 两产物 | 均 exit 0（见 §0） |
| `dist/client.js` 为真实客户端（非占位） | 89 231 B，`client-module.test.mjs` 5 项断言 ModuleLoader/RPC/禁用 API/XSS |

### 1.2 同步引擎（BRIEF §2.3）

| 验收项 | 证据（测试/代码） |
| --- | --- |
| patch 按 entry id 逐条合并，保注释 / `!!js` / 本地独有 | `test/patch-merge.test.mjs`；真实裸仓库集成测试断言未勾选条目逐字节不变 |
| 白名单 5 类文件与 `devices/<deviceId>/` 布局 | `engine/collect.ts` + `test/integration-git.test.mjs` |
| secret 脱敏为 `__SECRET__`，restore 用本地同名字段回填 | `test/secrets.test.mjs`、`test/audit-fixes.test.mjs`；真实 profile 只读探针：`{bytes:871, stripped:0, placeholders:0, maxTokensKept:true, apiKeyEnvKept:true, roundTripIdentical:true, needsLocal:[]}` |
| 推送 = 写快照→add→commit→push；非 FF 先 `pull --rebase` ≤2 次、永不 force | `engine/git.ts`；`integration-git.test.mjs`（两设备分叉场景：B 的提交保留、rebase 后 push 成功）；`--force` 检索无命中 |
| 工作副本 `~\.dsh\git-config-sync\work\<repoHash>\` | `engine/paths.ts` |
| restore fail-closed 四层：confirm → 逐条勾选 → 写前快照（留 10 份）→ 写后 SHA-256 | `test/confirm-gate.test.mjs`（无 confirm 文件字节不变）、`test/sha-verify.test.mjs`（注入校验失败 → 快照回滚 + `E_SHA_MISMATCH`）、`test/audit-fixes.test.mjs`（未知/非法 entry 整单拒绝） |
| HTTPS token 用临时 GIT_ASKPASS（0600，不进 argv）；SSH 用系统 agent | `engine/git.ts`（`ASKPASS_SH/CMD/MJS`，token 只经 `DSH_GIT_SYNC_TOKEN` 环境变量）；审计修复测试验证含 `&|<>%^` 的 token 原样输出且 askpass 文件不含 token |
| 状态文件 `settings.json` / `credentials.json` | `engine/settings.ts`（0600 创建；审计探针确认响应/日志无 token） |
| repoUrl 仅 https/ssh/git@，deviceId 正则 | `test/audit-fixes.test.mjs`（`user:pass@` 被拒；`git@host:path`、`ssh://git@host` 放行）；路径穿越探针全拒 |

### 1.3 RPC 契约（BRIEF §2.4）

8 个 action 全部实现并逐一测试：`getState`、`saveSettings`、`testConnection`、`push`、`preview`、`apply`、
`listSnapshots`、`rollback`；响应恒 `{ok:true,data}` / `{ok:false,error:{code,message,details?}}`（HTTP 200，
鉴权失败由 `connection.requestRejection` 出 401/403）。

- 未知 action → `E_UNKNOWN_ACTION`；无 `confirm:true` → `E_CONFIRM_REQUIRED` 且不落盘；
- `preview` 返回 `sources[].entries[].status ∈ added|changed|same|manual`、`plugins{install,keep,skip,noDowngrade}`；
- `apply` 校验 previewId/sourceDevice/entries，写前快照 + 写后 SHA-256，失败回滚；
- 插件清单 MERGE-only：不降级、不删除、不执行 pnpm（写 `plugins.to-install.json` 供用户安装）；
- 写操作串行队列；preview TTL 10 分钟。
- **`getState` 只读本地、不联网**：不执行 `lsRemote`/`fetch`/`clone`；`status.reachable` 为
  `true|false|null`（null=未探测），网络探测只发生在 `testConnection`/`push`/`preview`；
  `localPending`/`remotePending` 基于本地 `origin/<branch>` 引用，无 upstream 时为 `null`；
  单次 git 网络调用 `NETWORK_TIMEOUT_MS=8000` 超时映射 `E_GIT`。
- **`apply.applied[]` 双 SHA**：`fileSha256` = 写后整个 profile patch 的 SHA-256（落盘校验），
  `blockSha256` = 该 entry 合并后文本的 SHA-256（条目追踪），不再使用含糊的 `sha256`。
  测试断言同文件多条 `fileSha256` 相同、`blockSha256` 不同且等于 `parsePatch` 该条目 raw 的 SHA。
- 独立审计者用真实临时裸仓库/临时 profile 做了 32 组探针（envelope、错误码、HTTP 200/403/405、无 confirm 不写、
  过期 previewId、只勾一条时其余字节不变、`!!js` 保留、回滚逐字节还原、119 文件全量 grep 无 token 明文）——全过。

### 1.4 设置页 UI 与资源（BRIEF §2.2/§2.5/§2.6）

- `src/client.js`：`window.__ModuleLoader__.load` + `factory(require)`；`inject:['slots','locale']`；
  `settings.section`（id `git-config-sync`，order 70）；`ctx.effect` 注册 locale；RPC 同源 fetch。
- 覆盖 BRIEF §2.5 全部 25 项（仓库配置/范围勾选/状态徽标/按钮/逐条差异勾选/插件 MERGE-only/快照回滚/内联错误/
  密码型 token）；独立审计核对 **25/25**，`client-module.test.mjs` 另有 5 项静态断言。
- 资源：`locale/en.json` + `zh.json` 各 148 key（集合一致，含 `meta.title/description/detail`）；
  原创 `icon.svg`（625 B）；插件 `README.md`（8.9 KB）；`docs/DETAIL.md`（11.8 KB）。
- 测试：`test/locale.test.mjs`、`test/client-module.test.mjs` 共 8 项全过。

### 1.5 插件测试清单（62 项）

`patch-merge` / `secrets` / `plugin-merge` / `confirm-gate` / `sha-verify` / `integration-git` /
`audit-fixes` / `state-local` / `locale` / `client-module`。集成测试使用**真实系统 git + 临时裸仓库**跑通
push → 另一设备 pull → preview → apply → rollback 全链路，不依赖网络；`state-local` 覆盖
“无工作副本/裸仓库被移走时 `getState` 仍只读本地且不产生 `E_GIT`、`reachable` 三态持久化”。

## 2. 交付物 B：arkui-schedule

### 2.1 工程与平台门控（BRIEF §3.1/§3.3）

| 验收项 | 证据 |
| --- | --- |
| ArkUI-X 工程骨架（AppScope/根与 entry build-profile、hvigorfile、oh-package、module.json5、资源） | 文件齐全；`validate-app.mjs` 规则 1/7（12 个 JSON5/JSON 可解析、引用资源存在） |
| 页面/组件 `@crossplatform` | 规则 5：所有含 `struct` 的 8 个 `.ets` 均通过 |
| Android 不编译/引用 OCR、PixelMap、Canvas 手写 | 覆盖层目录（`main` + `android`）+ 规则 4：Android 可见文件 0 命中；鸿蒙手写/OCR 只在 `entry/src/harmony/ets/**` |
| Android 静态隐藏手写入口、仅虚拟键盘 | `common/platformFeatures.ts` 默认 `handwriting:false, ocr:false`；鸿蒙覆盖层启用；Edit 页按钮受 `getFeatures().handwriting` 控制 |
| `main_pages.json`（共享 4 页）与鸿蒙超集（+`pages/Handwriting`） | 规则 3；鸿蒙清单 `entry/src/harmony/resources/base/profile/main_pages.json` |
| 相对 import 图完整 | 规则 2：78 条 import 全部解析；main 文件不依赖鸿蒙覆盖层；规则 8：main 树静态 import harmony 树即失败（动态 import 放行） |
| 平台装配（Lead P0-1） | `entry/build-profile.json5` 两 target：`default`→`sourceRoots:["./src/main","./src/harmony"]`、`android`→`["./src/main"]`；根 profile `module.targets` 用 `applyToProducts` 分别映射 default/android；运行时第二道防线 `detectPlatformFrom` + `devicePlatform.ets` 覆盖层（鸿蒙读 `deviceInfo.osFullName` 兜底 `deviceType`，检测失败 fail-closed→android）；`EntryAbility` 先同步 fail-closed 再异步检测覆盖 |

### 2.2 鸿蒙手写 + OCR（BRIEF §3.2）

- `harmony/ets/pages/Handwriting.ets` + `handwriting/HandwritingPager.ets`：Canvas 分页、`MAX_PAGES=10`、
  翻页/清空/完成并识别；`ocr/OcrBatchManager.ets`：串行（`maxConcurrency=1`）、每页
  PixelMap → **先落盘** `attachments/<sha256>.png` → `textRecognition` → 按 `pageIndex` 存 → 立即 `release`；
  整批 `init/release`；取消释放未处理 PixelMap；完成后 `concatPageTexts` 0→N 拼接、写 `AppStorage` 回填正文。
- 图表/公式：`replaceComplexBlocks` → `[公式/图表: 查看手迹]`（纯逻辑测试覆盖）；`ocr_text` 原样保留、编辑只写 `body`。
- **未验证**：OCR API 精确签名、`componentSnapshot` 对非当前页截图、PixelMap 释放时序、真机性能（见 §6）。

### 2.3 Android 功能（BRIEF §3.3）

- 共享页只用 `TextInput/TextArea`；手写/OCR 模块不在 Android 构建集合；能力注册默认关闭。

### 2.4 存储 / AI / 提醒 / Git 同步（BRIEF §3.4）

| 验收项 | 证据 |
| --- | --- |
| JSONL `devices/<deviceId>/schedules/YYYY-MM-DD.jsonl`，一行一事件、只追加 | `services/scheduleStore.ets`（`appendLineSync` 定位文件末尾、补换行、历史字节不改）；`model/jsonl.ts` + `serviceInvariants.test.mjs` 断言“追加结果以原文为前缀、不重排历史” |
| 附件 sha256 去重命名 | `model/attachments.ts` + `services/attachmentStore.ets`；测试覆盖命名/0→N 拼接/占位符 |
| 更新事件不迁日期、折叠取新版本 | `common/date.ts nextTsSameDate`（保留原日期、时刻严格递增）；`tools/test/date.test.mjs` 6 项 |
| 读其他设备目录折叠展示（fetch 后只读） | `scheduleStore.readAllDevices/readDayAllDevices/findByIdAny` + Index「含其他设备」开关 |
| 每日 AI 汇总手动触发、可取消勾选、载荷注入时间时区、只写 `ai_structured` | `model/aiPayload.ts`（11 项测试）+ `services/deepseek.ets` + Index AI 面板 |
| 提醒 reminderAgentManager ≤30，未授权降级 notificationManager；AGC 说明 | `harmony/ets/reminder/ReminderService.ets` + `model/reminder.ts`（数量上限测试）；Settings 页 AGC/签名说明 |
| isomorphic-git **真实下载** + 文件/HTTP 桥 | `rawfile/git/isomorphic-git.js` **305 157 B**（`isomorphic-git@1.25.3` UMD，VERSION/LICENSE 同目录）；`git-bridge.js` 52 751 B；`index.html` |
| 只写自己目录、永不 merge | 桥 `push` 仅 `devices/<deviceId>` add/commit；`git-bridge.test.mjs` 22 项（真实临时 git 仓库 + 系统 git，验证 init/status/log/branch、push 范围、HTTP 状态码透传、认证头、token 不外泄） |
| `GitSyncService` 与页面契约 | 固定 API（`registerProxy/configure/pull/push/status`）+ Settings 隐藏 Web 挂载 |

### 2.5 页面（BRIEF §3.5）

主页（日期选择 + 今日待办/全部未完成 + 左勾选/中标题+时间/右 📎 + 新建/AI/同步）、编辑页（四字段 +
手写切换 + 回填）、详情页（AI 结构化可编辑 + 原始 OCR 只读 + 截图全屏 + 附件哈希）、设置页
（设备标识/仓库 URL/token/AI key/同步按钮/平台信息）。`@crossplatform` 全部满足；validate 规则通过。

### 2.6 应用验收（BRIEF §3.6）

| 验收项 | 结果 |
| --- | --- |
| `tools/` 用 tsc 对模型层类型检查（stub d.ts） | `tsc -p tools/tsconfig.json` 与 `--noEmit` 均 exit 0 |
| 平台装配（Lead P0-1） | `entry/build-profile.json5` 两 target：`default`→`sourceRoots:["./src/main","./src/harmony"]`、`android`→`["./src/main"]`；根 profile `module.targets` 用 `applyToProducts` 分别映射 default/android；运行时第二道防线 `detectPlatformFrom` + `devicePlatform.ets` 覆盖层（鸿蒙读 `deviceInfo.osFullName` 兜底 `deviceType`，检测失败 fail-closed→android）；`EntryAbility` 先同步 fail-closed 再异步检测覆盖 |
| OCR 两阶段（Lead P0-2） | `model/pageCapture.ts`（main 树中性命名，无 OCR/SDK 标识符）：阶段 A 全部截图落盘 → 阶段 B 串行识别、每页立即释放、失败/取消释放未处理句柄；`pageCapture.test.mjs` 13 项，含“第 1 页 OCR 抛错时 attachments 仍为 3 且 pageIndex 0/1/2 对齐、release=[0,1,2]” |
| 服务层不变量（Lead P0-3） | `model/syncScope.ts`（设备目录断言，`GitSyncService.push` 调用）+ `syncScope.test.mjs` 13 项（`devices/pc-a-evil/`、`../`、绝对路径均拒）；`serviceInvariants.test.mjs` 11 项（JSONL 前缀追加、AI 只处理 `ai_processed:false`、`ocr_text` 逐条不变） |
| 纯逻辑覆盖：JSONL、AI 载荷、sha256、按 pageIndex 拼接、平台门控、设备路径 | **155 项测试**（sha256 11 / jsonl 14 / attachments 11 / aiPayload 11 / platform 9 / validate 22 / date 6 / git-bridge 22 / platformDetect 12 / pageCapture 13 / syncScope 13 / serviceInvariants 11） |
| 插件清单 MERGE-only 纯逻辑 | 由插件侧 `test/plugin-merge.test.mjs` 覆盖（应用不处理插件清单，见 §7 映射说明） |
| 不复制两份实现 | 模型层单一实现，Node 测试 import 编译产物 `.build/**`；页面复用同一源码 |

## 3. 其它交付（BRIEF §4）

| 交付物 | 状态 |
| --- | --- |
| 根 `README.md` | 完成（快速开始、安装、目录、覆盖摘要、边界） |
| `docs/ARCHITECTURE.md` | 完成（数据流、模块图、安全/失败模式、未验证项） |
| `docs/DATA-CONTRACT.md` | 完成（Git 目录、patch 载荷、JSONL、RPC、状态目录、应用 Git 布局） |
| `docs/CONTRACT.md` | 完成（接口/文件所有权/验收命令，执行者共用契约） |
| `devices/{pc-a,pc-b,phone-a}/` | 完成（目录说明文件） |
| `tools/init-remote-repo.mjs` | 完成并实测：临时目录 `git init -b main` + 设备目录 + 首次提交 + `git log` 正确 |

## 4. 审计驱动的修复（独立审计 → 修复 → 回归）

独立只读审计者对插件做了逐 action/字段/安全探针，发现 1 个虚假声明与 2 个硬伤、5 个重要缺陷，均已修复：

| 编号 | 缺陷 | 修复证据 |
| --- | --- | --- |
| B1 | `dist/client.js` 缺失而 README 声称已提交 | 构建脚本改为**缺 `src/client.js` 即硬失败**；`pnpm build` 生成 89 KB `dist/client.js`，`npm pack` 22 文件含之 |
| B2 | secret 子串匹配误伤 `maxTokens`/`apiKeyEnv`，回填按顺序错配 | 词边界 `isSecretKey` + 按 entry/key 回填；真实 profile 探针 3→0 替换、round-trip 字节一致；`audit-fixes` 8 项回归 |
| M1 | repoUrl 内嵌凭据 | 校验拒绝并打码（`https://user:pass@`、`https://token@`） |
| M2 | 空 repoUrl 无法保存/假成功 | 空串可保存，push/testConnection/preview 返回 `E_VALIDATION` |
| M3 | apply 非法 entry 只 skip | 整单 `E_VALIDATION`（空/未知/`same`），文件字节不变 |
| M4 | conflict / lastSyncAt 语义不符 | `state.json` 持久化；分叉才 conflict；新 service 实例可读 lastSyncAt |
| M5 | Windows askpass 经 cmd 展开 token | `askpass.cmd → node askpass.mjs`，token 仅环境变量；含 `&|<>%^` 实测原样输出 |

修复后插件测试从 44 → **62 项**，全绿；`secrets`/`sha-verify` 等原覆盖未删。

### 4.1 Lead 复审修复（第二轮）

| 编号 | 缺陷 | 修复证据 |
| --- | --- | --- |
| P0-1 | 平台装配未生效：`entry/src/harmony/ets/**` 不进鸿蒙构建 | `entry/build-profile.json5` 两 target + `sourceRoots`；根 profile `applyToProducts` 映射；运行时检测 `detectPlatformFrom` + `devicePlatform.ets`（鸿蒙 `deviceInfo.osFullName` 兜底 `deviceType`，失败 fail-closed）；validator 新增规则 8（main 静态 import harmony 即失败，动态放行）并有 fixture 单测；**sourceRoots 未在 DevEco 实测**（§6） |
| P0-2 | OCR 逐页交错，首屏失败时后续页未落盘 | `model/pageCapture.ts` 两阶段 + `OcrBatchManager` 薄适配；`pageCapture.test.mjs` 13 项，含“第 1 页 OCR 抛错：attachments=3、savedPages=3、pageIndex 0/1/2、release=[0,1,2]”；取消路径释放全部未处理句柄 |
| P0-3 | 服务不变量无可执行证据 | `model/syncScope.ts` + `GitSyncService.push` 断言（`syncScope` 13 项）；`serviceInvariants` 11 项（JSONL 前缀追加、AI 仅未处理、`ocr_text` 不变） |
| P1-1 | `getState` 每次联网、离线卡 UI | `getState` 只读本地 HEAD/state；`reachable` 三态持久化；本地 ahead/behind 用 `origin/<branch>` 引用，无则 null；`NETWORK_TIMEOUT_MS=8000`；`state-local.test.mjs` 用“裸仓库整体移走”证明 getState 仍 ok、push 才失败 |
| P1-2 | `applied[].sha256` 语义误导 | 改为 `{id,fileSha256,blockSha256,path}`；测试断言同文件多条 `fileSha256` 相同且等于整文件 SHA、`blockSha256` 不同 |
| P1-3 | 安装路径不清 | README 写清 ①GUI「Plugins → Add plugin」本地目录（链接安装，要求 `dist/` 已提交）②发布 GitHub 后走安全启动器 `install-plugin`（不接受本地目录，端点不在线时不得绕过） |
| P2 | `insert:` 多行块合并限制未文档化 | `docs/DATA-CONTRACT.md` §2.1 与插件 `docs/DETAIL.md` §4.1/已知限制写明“按内部第一个 id 整体合并”，建议一条 entry 一行 `insert` |

第二轮修复后：插件 52 → **62 项**；应用 106 → **155 项**；validate 7/7 → **8/8**；总数 **217**。

## 5. 命令输出汇总

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | exit 0；dist/index.js + dist/client.js + 应用 `.build/**` 生成；3 个产物 `node --check` 通过 |
| `node --test "packages/dsh-git-config-sync/test/*.test.mjs"` | 62 pass / 0 fail |
| `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` | 155 pass / 0 fail |
| `pnpm test` | 217 pass / 0 fail |
| `node apps/arkui-schedule/tools/validate-app.mjs` | ✅ 8/8 规则；JSON5/JSON 12、import 78、main 静态 import 86、页面 4、rawfile/git 2 |
| `tsc -p apps/arkui-schedule/tools/tsconfig.json --noEmit` | exit 0 |
| `node --check dist/index.js` / `dist/client.js` | exit 0 / exit 0 |
| 真实 profile patch 只读脱敏探针 | `{"bytes":871,"stripped":0,"placeholders":0,"maxTokensKept":true,"apiKeyEnvKept":true,"roundTripIdentical":true,"needsLocal":[]}` |

## 6. 未验证项与验证步骤（如实标注）

| 未验证项 | 原因 | 验证步骤 |
| --- | --- | --- |
| 真机 OCR、PixelMap 截图、Canvas 手写 | 无鸿蒙设备 | 真机运行 Handwriting 页，确认每页落盘 sha256、释放 PixelMap、0→N 拼接 |
| reminderAgentManager / 通知降级 / AGC 权限 | 需 AGC 申请（约 8 工作日）+ 手动签名 | 申请 `PUBLISH_AGENT_REMINDER` 开放能力后真机创建 ≤30 条提醒并验证未授权降级 |
| Android 设备运行 | 无 Android 设备 | 用 Android 构建产物安装，确认手写入口隐藏、纯键盘输入、Git 同步可用 |
| 真实 GitHub/Gitee HTTPS/SSH 认证 | 本机无远端仓库凭据 | 建私有仓库，用 HTTPS PAT 执行 testConnection/push/pull；SSH 用 ssh-agent |
| 插件在 DSH Web GUI 的挂载与视觉 | 安装/GUI 验证由 Lead 负责（本任务禁止改 profile） | `dsh plugin --profile web add link:<repo>/packages/dsh-git-config-sync`，打开设置页确认分区与 RPC |
| `ctx.locale.t(ns,key)` 精确签名 | DSH 版本 API 细节 | 安装后观察 locale 文案；client 已做 inline 字典回退 |
| 大 base64 经 `runJavaScript` / `@ohos.net.http` 二进制与 gzip | 无真机 | 真机同步一个含二进制的私有仓库，观察 clone/push |
| rebase 冲突（同设备并发） | 集成测试只覆盖分叉非冲突 | 两设备同改同一 entry 后 push，确认 `E_CONFLICT` 提示且不丢本地文件 |

## 7. 需求 ↔ 证据映射备注

- BRIEF §3.6 列的「插件清单 MERGE-only」属于插件同步引擎语义（应用不处理 DSH 插件清单），
  由 `packages/dsh-git-config-sync/test/plugin-merge.test.mjs` 覆盖；应用侧只同步日程 JSONL 与附件。
- 应用 `.ets` **已在本机真实编译通过**（见 §8）；纯逻辑 tsc+node 测试（155 项）与静态规则校验（8 条）
  继续作为回归保障，运行时不依赖设备。
- `reports/`（执行者报告）被 `.gitignore` 忽略，属工作过程记录；本文件为对外验收证据。

## 8. 真实鸿蒙构建（2026-11-15 实测）

### 8.1 工具链

| 项 | 值 |
| --- | --- |
| IDE | `D:\A-DevEco\DevEco Studio`，DevEco Studio **26.0.0.865**（build `DS-261.23567.138.36.2600865`） |
| SDK | `sdk\default`：**HarmonyOS 26.0.0**（`apiVersion: 26`，Release） |
| 构建入口 | `devecocli`（npm `@deveco/deveco-cli@1.3.0-stable`），内部调用自带 `tools\hvigor` + `tools\ohpm` + `tools\node` + `jbr` |
| 版本对齐 | `compatibleSdkVersion` / `targetSdkVersion` = `26.0.0`（本机只装 API 26 SDK；用户确认 HarmonyOS 6+ 可接受） |

### 8.2 命令与结果（可复现）

```powershell
$env:DEVECO_CLI_STUDIO_PATH = 'D:\A-DevEco\DevEco Studio'
$env:DEVECO_SDK_HOME = 'D:\A-DevEco\DevEco Studio\sdk'
cd apps\arkui-schedule
devecocli build clean        # Clean completed successfully（停止 1 个 daemon）
devecocli build --product default
```

实测输出：

```
> hvigor WARN: No signingConfig found for product default
> hvigor BUILD SUCCESSFUL in 1 min 26 s 296 ms

entry/build/default/outputs/default/entry-default-unsigned.hap        0.87 MB
entry/build/default/outputs/default/app/entry-default.hap             0.87 MB
```

HAP **未签名**（无 AGC 签名配置），真机安装前需在 DevEco 里配 `signingConfigs` 或走自动签名。
边用电脑边构建时用 `tools/build-harmony.ps1`（处理器亲和性 + BelowNormal + JVM/Node 上限），
实测构建进程 `Affinity=0xF`、`Priority=BelowNormal`。

### 8.3 首次构建暴露并修复的 7 类问题

| # | 报错 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `Schema validate failed` at `app.products[1].runtimeOS` | 纯 DevEco 26 只接受 `runtimeOS: HarmonyOS | OpenHarmony`，`Android` 属 ArkUI-X 扩展 | 移除 Android product/target，另存 `build-profile.arkui-x.json5` + `entry/build-profile.arkui-x.json5` |
| 2 | `app.apiReleaseType` 不匹配 `^(Canary|Beta|Release)[1-9]\d*$` | `AppScope/app.json5` 里有旧字段 `apiReleaseType: "Release"`、`minAPIVersion/targetAPIVersion: 12` | 精简为 scaffold 形态（bundleName/vendor/versionCode/versionName/icon/label） |
| 3 | `hvigor-config.json5` does not exist | 生成工程缺 hvigor wrapper 配置 | 新增 `hvigor/hvigor-config.json5`（modelVersion `26.0.0`） |
| 4 | `Cannot find name 'crossplatform'`（6 处 + 鸿蒙覆盖层 2 处） | `@crossplatform` 是 ArkUI-X 装饰器，纯 HarmonyOS 编译器不定义 | 新增 `tools/set-build-mode.mjs`：纯鸿蒙模式移除、ArkUI-X 模式自动加回；validator 规则 5 改为按模式校验 |
| 5 | `arkts-no-spread`（Index/Detail 3 处 `{...record}`） | ArkTS 禁止对象展开 | `model/types.ts` 新增 `cloneRecord()` 逐字段复制，调用处改为「克隆 + 改字段」 |
| 6 | `arkts-no-structural-typing`（GitSyncService 2 处 reject） | `Error` 是接口，类实例赋值触发结构化类型检查 | `PendingRequest.reject` 与 Promise executor 的 reject 参数改为 `Object` |
| 7 | `arkts-no-untyped-obj-literals`（Settings）、`WebAttribute.onError` 不存在 | `Record<string,string>` 字面量 + 旧版 Web 回调 | 改显式 if/else；`.onError()` → `.onErrorReceive()` |

### 8.4 构建后的回归

```
node tools/validate-app.mjs                  # ✅ 8/8（JSON5 17、import 78、main 静态 import 88、页面 4、rawfile 2）
node --test apps/arkui-schedule/tools/test/*.test.mjs   # 155 pass / 0 fail
.\node_modules\.bin\tsc -p apps/arkui-schedule/tools/tsconfig.json --noEmit   # exit 0
```

### 8.5 仍未验证（构建已通过，但运行时仍需设备）

- ~~HAP 未签名，真机安装需 AGC 签名配置~~ → 已在 §10 打通（签名 HAP 已装到 `MLR-AL00` 并启动）；
- 真机 OCR / `componentSnapshot` / PixelMap 释放 / 提醒权限（AGC，约 8 工作日）；
- Android 分支：本机无 ArkUI-X 工具链，`architecture-x` 变体只做了静态校验，未编译；
- `source.sourceRoots` 在 HarmonyOS build 中已被 hvigor 接受（本次构建通过），
  但其「同名相对路径后者覆盖前者」的语义是否与 ArkUI-X 一致，仍需在 ArkUI-X 工具链下复核。

## 9. Android APK 真实构建（2026-11-15 实测）

### 9.1 工具链（全部本机安装并验证）

| 组件 | 位置 / 版本 |
| --- | --- |
| DevEco Studio | `D:\A-DevEco\DevEco Studio` 26.0.0.865 |
| ArkUI-X SDK | `%LOCALAPPDATA%\ArkUI-X\Sdk\26.0.0\arkui-x`，**26.0.0.28 (Beta2)**（DevEco 插件下载） |
| ACE Tools | 同上 `toolchains\bin\ace.cmd`（`ace config` 已配置 SDK/JDK/Node/ohpm 路径） |
| Android SDK | `D:\android-sdk`：platform-tools、platforms android-33/34、build-tools 30.0.3/34.0.0 |
| Gradle | wrapper 8.4（`repo.huaweicloud.com`）+ 本机 8.7 备用 |
| JDK | **Temurin 17.0.21**（`D:\jdk17\jdk-17`）——DevEco 自带 JBR 是 **JDK 25**，Gradle 8.4 无法运行（`Unsupported class file major version 69`） |

### 9.2 命令与结果（可复现）

```powershell
$sdk = "$env:LOCALAPPDATA\ArkUI-X\Sdk\26.0.0\arkui-x"
$env:PATH = "$sdk\toolchains\bin;D:\A-DevEco\DevEco Studio\tools\node;$env:PATH"
$env:JAVA_HOME = 'D:\jdk17\jdk-17'
$env:ANDROID_HOME = 'D:\android-sdk'

cd apps\arkui-schedule
node tools\set-build-mode.mjs --mode arkui-x   # entry 只编 src/main（无手写/OCR）
ace build apk --debug
```

实测输出：

```
Use ArkUI-X SDK, Version 26.0.0.28
> Task :app:assembleDebug
BUILD SUCCESSFUL in 1m 44s
31 actionable tasks: 31 executed
APK file built successfully.
```

产物：

```
apps/arkui-schedule/dist-android/arkui-schedule-android-debug.apk   50.84 MB
  = .arkui-x/android/app/build/outputs/apk/debug/app-debug.apk
  ArkUI-X 运行库：lib/arm64-v8a/libarkui_android.so 等 20+ 个 .so + classes.dex 557 KB
  含 Handwriting / OcrBatch / reminderAgent 的条目：0（Android 分支物理上不含这些代码）
```

### 9.3 打通 Android 构建时修掉的问题

| # | 现象 | 根因 | 处理 |
| --- | --- | --- | --- |
| 1 | `ace modify` 交互式命令在无 stdin 时崩溃 | readline 被关闭 | 新增 `tools/ace-driver.cjs`，用管道喂 `2`（Android 平台） |
| 2 | `must be equal to one of the allowed values` at `products[1].runtimeOS` | ArkUI-X 的 hvigor 仍按 HarmonyOS schema 校验 | 根 profile 只保留 HarmonyOS product；Android 差异只放在 entry 的 `sourceRoots` |
| 3 | `Cannot find name 'crossplatform'` | ArkUI-X 26 的 ets-loader 不认该装饰器（文档里的 `@crossplatform` 只是 API 能力标签） | 两种模式都清除该装饰器，validator 规则 5 改为「出现即失败」 |
| 4 | `The module target 'ohosTest' is not found` | `ace build apk` 无条件编译 ohosTest | entry profile 增加 `ohosTest` target + `entry/src/ohosTest/module.json5` + 最小 `List.test.ets` |
| 5 | `@ohos/hypium` 无法解析 | 测试模块依赖缺失 | `oh-package.json5` devDependencies 增加 `@ohos/hypium 1.0.25` |
| 6 | ACE 打包 ENOENT：`.arkui-x/ios/.../pkgContextInfo.json` | ACE 的复制逻辑对 iOS 目录不 mkdir | 预建 `.arkui-x/ios/arkui-x/{entry,entry_test}` |
| 7 | Gradle 启动失败 `Unsupported class file major version 69` | DevEco JBR 是 JDK 25，Gradle 8.4 不支持 | 安装 Temurin 17，`JAVA_HOME` 指向它，`ace config --java-sdk` 同步 |

### 9.4 双产物与模式切换

| 产物 | 构建模式 | 命令 | 结果 |
| --- | --- | --- | --- |
| HarmonyOS HAP | `--mode harmony`（entry = main + harmony） | `devecocli build --product default` | `entry-default-unsigned.hap` 0.87 MB，BUILD SUCCESSFUL |
| Android APK | `--mode arkui-x`（entry = main only） | `ace build apk --debug` | `app-debug.apk` 50.84 MB，BUILD SUCCESSFUL |

`tools/set-build-mode.mjs` 会同时切换：根/entry 的 build-profile、两个 hvigorfile（内置任务 ↔ ArkUI-X 任务）、
hvigor 插件依赖，并清理/保留 `@crossplatform`。

### 9.5 仍未验证

- APK **未在 Android 真机/模拟器上安装运行**（本机无 Android 设备；`adb devices` 为空）；
- 手写/OCR 在 Android 上不存在的结论来自「源码隔离 + APK 内容扫描」，未做运行时点击验证；
- ~~HarmonyOS HAP 仍未签名（需 AGC 证书/profile，等设备连接后由 `tools/install-device.ps1` 生成）~~
  → 已在 §10 完成签名 + 真机安装 + hilog/UI 验证。

## 10. 签名与真机安装（2026-11-15 实测）

§8 留下「HAP 未签名、无设备」的尾巴，本节把它补齐：**签名 → 构建 → 安装 → 启动 → hilog → UI 节点** 全链路已在真机上跑通。

### 10.1 工具链与设备

| 项 | 值 |
| --- | --- |
| IDE | `D:\A-DevEco\DevEco Studio`，DevEco Studio **26.0.0.865** |
| HarmonyOS SDK | `D:\A-DevEco\DevEco Studio\sdk\default`（API **26**） |
| hdc | `...\sdk\default\openharmony\toolchains\hdc.exe`（Ver **3.2.0f**） |
| 签名工具 | `...\sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar` |
| JDK | `D:\jdk17\jdk-17`（Temurin **17.0.21**；不能用 DevEco 自带 JDK 25） |
| 构建/签名入口 | `C:\Users\GWL\Desktop\itwillclaude\.tmp\deveco-cli\node_modules\.bin\devecocli.cmd` |
| 华为账号 | `行走的49W 丁浩然`（主账号，已认证），developer-id / team `70086000166631503` |

实测连接的设备：

| 项 | 值 |
| --- | --- |
| serial | `6MFBB25C27205131` |
| 型号 | MatePad Mini 悦读版 `MLR-AL00` |
| 系统 | `const.ohos.apiversion=26`，`const.ohos.fullname=OpenHarmony-7.0.0.111` |
| UDID | `A2DCA977DA029D56868CBA60A01A698B677DB1BA1101B5499A43999D8B6CC07E` |

### 10.2 失败起点：DEVICE_MISSING 与真正根因

第一次尝试是让 CLI 全自动生成签名（期望它自己建 Profile）：

```powershell
devecocli signature generate --product default --force
```

实测失败：

```
[DEBUG] [EnvCheck] Scenario 4 Device check: no cloud devices found, falling back to local hdc
[DEBUG] [EnvCheck] Scenario 4 Device check: local device found but not an emulator
[Debug] FAIL: DEVICE_MISSING "Unable to create the profile file due to missing devices..."
```

真正根因**不在设备侧**：AGC 团队下既没有 HarmonyOS 应用、也没有登记过设备。
`devecocli` 只读 AGC、不写 AGC，因此它无法替你创建应用、证书和 Profile，自然「找不到设备」。
设备本身、hdc 授权、开发者模式当时都是正常的（hdc 能连上、能装包）。

结论：**签名材料必须先在 AGC 网页侧备齐**，CLI 只负责在材料齐备后签发本地密钥与配置。

### 10.3 AGC 手工申请四步

先在 [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/index.html) 手工完成四件事，对象如下：

| 对象 | 标识 / 值 |
| --- | --- |
| 应用 | `itwill schedule`，包名 `com.itwill.schedule`，支持设备「手机 + 平板」，所属项目 `itwill-schedule` |
| appId | `6917621854545473037` |
| projectId | `101653523865711182` |
| 调试证书 | `itwill-debug-cert`（类型「调试证书」，状态生效，失效 **2027-11-15**），由 `signing/itwill-debug.csr` 上传签发 |
| 设备 | `MLR-AL00`（类型「平板」，注册时间 2026-11-15 13:01:59） |
| 调试 Profile | `itwill-debug-profile`（类型「调试」，provisionId `2084126670842794816`，uuid `5657b004-aa48-45c2-b598-bedaf8aa0379`） |

四个步骤（顺序不能乱：证书要绑应用，Profile 要绑证书 + 设备）：

1. **建应用**：项目 `itwill-schedule` → 添加 HarmonyOS 应用，包名 `com.itwill.schedule`，支持设备勾选手机 + 平板。
2. **传 CSR 签证书**：`证书、APP ID 和 Profile` → 证书 → 新增「调试证书」，上传 `apps/arkui-schedule/signing/itwill-debug.csr`，
   签发得到 `itwill-debug-cert`（下载为 `itwill-debug.cer`）。
3. **登记设备 UDID**：设备管理 → 添加设备，填 §10.1 表里的 UDID，设备形态选「平板」。
4. **建调试 Profile**：Profile → 新增「调试」，选上面签好的证书、勾选刚登记的设备，得到 `itwill-debug-profile`（下载为 `itwill-debug.p7b`）。

实测遇到的两个 AGC 页面细节：

- **①「类型」下拉里没有「调试设备」**。新版设备页只有 手机 / 平板 / PC / 2in1 / 运动手表 / 智能手表 / 智慧屏 / 路由器，
  按设备**形态**选「平板」即可，这样它才会出现在调试 Profile 的设备勾选列表里。
- **② Profile 行的「下载」按钮抓不到文件**。它的实现是 `window.open(OBS 签名直链)`，常规下载监听收不到；
  需要从页面 XHR 里取直链（`provision/refresh` → `cfs/file_service/v1/download/object/url`）再自己下载。

### 10.4 登记设备后自动签名恢复可用

AGC 四步做完后，**同一条命令原样重跑即成功**，不需要改任何参数：

```powershell
devecocli signature generate --product default --force
```

实测输出：

```
Start generating p12
Start generating csr
Start generating certificate
Start generating profile
Signing config written to C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule\build-profile.json5
Signature generation completed successfully.
```

它会：

- 在 `%USERPROFILE%\.ohos\config\` 下生成 `default_arkui-schedule_*.{p12,cer,p7b}`；
- 把 `signingConfigs` 写进 `apps/arkui-schedule/build-profile.json5`；
- 之后 `devecocli build` / `hvigor` 就会自动签出 `entry-default-signed.hap`（实测 953,680 B）。

⚠️ **它签发的证书与 `signing/itwill-debug.cer` 不是同一张**（实测两者 cer 的 SHA256 不同）。
两条身份线并存会引出 §10.7 的 `install sign info inconsistent`。

### 10.5 hvigor 只接受加密密码 → 离线签名脚本

自动签名把机器相关的加密串写进了 `build-profile.json5`，不适合提交。手工换成明文密码再构建，直接失败：

```
> hvigor ERROR: Failed :entry:default@SignHap
00303116 Configuration Error
Error Message: The length of the storePassword or keyPassword field in the signature configuration is less than 32. At file: ...\apps\arkui-schedule\build-profile.json5
```

结论：hvigor 的 `SignHap` 只认 DevEco **加密后**的密码串（64 位 hex），明文不可用。
因此仓库里的 `build-profile.json5` 保持 `"signingConfigs": []`（不提交机器相关的加密串），
签名改由离线脚本 `apps/arkui-schedule/tools/sign-hap.ps1` 完成：直接用 SDK 的 `hap-sign-tool.jar` +
明文密码 + 仓库内 `signing/` 材料，绕开 hvigor。

脚本参数（`apps/arkui-schedule/tools/sign-hap.ps1`）：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-Hap` | `entry\build\default\outputs\default\entry-default-unsigned.hap` | 待签名的未签名 HAP |
| `-Out` | 输入名 + `-signed.hap` | 输出路径 |
| `-KeyAlias` | `debugkey` | p12 别名 |
| `-StorePass` / `-KeyPass` | `<已脱敏>` | 明文口令（与 `signing/README.md` 一致） |
| `-CompatibleVersion` | `26` | 与 API 26 对齐 |
| `-SkipVerify` | 关 | 跳过 `verify-app` 校验 |

### 10.6 构建 / 签名 / 安装 / 启动命令与输出

```powershell
cd apps\arkui-schedule

# 1) 构建（限制 4 核 + BelowNormal，边用电脑边构建）
powershell -File tools\build-harmony.ps1 -Cores 4

# 2) 离线签名 + 自校验
powershell -File tools\sign-hap.ps1

# 3) 安装（覆盖安装；注意 §10.7 的坑）
hdc -t 6MFBB25C27205131 install -r entry\build\default\outputs\default\entry-default-unsigned-signed.hap

# 4) 启动
hdc -t 6MFBB25C27205131 shell aa start -a EntryAbility -b com.itwill.schedule
```

实测输出：

```
# 构建
> BUILD SUCCESSFUL in 10 s 310 ms（42 tasks）
entry\build\default\outputs\default\entry-default-unsigned.hap   912,422 B

# 签名
sign-app success
signed HAP: entry-default-unsigned-signed.hap (953,791 bytes)

# 校验（sign-hap.ps1 内自动执行 verify-app）
Digest verify result: true, DigestAlgorithm: SHA-256
verify permission sign success
verify: Verify success
verify-app success（exit 0）

# 安装
msg:install bundle successfully.

# 启动
start ability successfully.
```

### 10.7 两个安装坑

| # | 现象 | 根因 | 处理 |
| --- | --- | --- | --- |
| 1 | `msg:error: failed to install bundle. code:9568332 error: install sign info inconsistent.` | 设备上已装的是 `devecocli` 自动签发身份签的包，与 `signing/itwill-debug.cer` 不是同一张证书 | 先 `hdc -t 6MFBB25C27205131 uninstall com.itwill.schedule` 再装，实测成功 |
| 2 | `hdc install` 失败时退出码仍为 `0`（`$LASTEXITCODE=0`） | hdc 的 CLI 行为：失败只体现在输出文本 | **必须看输出文本**（`install bundle successfully`）判断成败，不能只看退出码 |

### 10.8 hilog 15 秒观察结论

冷启动观察命令（实测）：

```powershell
hdc -t 6MFBB25C27205131 shell aa force-stop com.itwill.schedule
hdc -t 6MFBB25C27205131 shell hilog -r          # 清缓冲
hdc -t 6MFBB25C27205131 shell aa start -a EntryAbility -b com.itwill.schedule
# 等 15 秒
hdc -t 6MFBB25C27205131 shell hilog -x > hilog-final.txt
```

结论：

- 采集 **1722 行**日志；`jscrash|appfreeze|Fatal|SIGSEGV|SIGABRT` 命中 **0**；
- 15 秒后进程 `com.itwill.schedule` **仍存活**（PID 26968）；
- 应用侧 **31 条 E 级**日志全部是框架噪声，不构成崩溃证据：
  `CODE_SIGN [XpmIoctl] Ioctl cmd ... failed: Invalid argument (ignore)`、
  `WMS SetWindowType: permission denied!`、
  `ArkCompiler PandaFileSnapshotInterfaces::ReadCrossBundleHspInfo failed`、
  `data_share_manager_impl RegisterClientDeathObserver failed`、
  `Ace LoadThemeFont: Failed to load font default.ttf`、
  `AceAppBar read abc file success!`（这条虽是 E 级，语义是成功）；
- 日志里另有 2 条 `OnProcessDied`（`com.huawei.hmos.clouddrive`），与本应用无关；
- `/data/log/faultlog/faultlogger/` 在本机 shell 下 `Permission denied`，取不到 faultlogger 文件，
  因此本节的判据是「hilog 无 jscrash / appfreeze + 进程存活」，**不是** faultlog 为空。

### 10.9 UI 实证

设备锁屏时 `devecocli ui layout` 只能拿到锁屏节点（`ScreenLockRootComponent`），必须先唤醒并解锁：

```powershell
hdc -t 6MFBB25C27205131 shell power-shell wakeup
hdc -t 6MFBB25C27205131 shell "uitest uiInput swipe 1280 1400 1280 300 300"
```

然后再取节点树：

```powershell
devecocli ui layout --device 6MFBB25C27205131 --format json --mode simplified
```

实测拿到 2560×1600 的真实页面节点，文本为：`2026-11-15`、`点击选择日期`、`今天`、`今日待办`、
`全部未完成`、`仅本机`、`这一天还没有日程`、`点击底部「新建」记录一条，或切换日期`，
按钮 `新建` / `AI 汇总` / `同步`。

截图（`hdc shell snapshot_display -f /data/local/tmp/itwill.jpeg` + `hdc file recv` 取回）：

![鸿蒙真机运行截图（2560×1600）](images/harmony-device-run-2026-11-15.jpeg)

文件：`docs/images/harmony-device-run-2026-11-15.jpeg`，2560×1600，107,467 B。

### 10.10 仍未验证与边界

- **release 证书未做**：本节全部基于「调试证书 + 调试 Profile」，只能装到已登记 UDID 的设备上；
- **调试身份不可上架**：`itwill-debug.cer` / `itwill-debug.p7b` 是调试用途，不能用于应用市场发布；
- **换设备要重新登记**：Profile 绑定 UDID，换一台设备必须回 AGC 重新登记 UDID 并重建调试 Profile，否则安装失败；
- **有效期**：调试证书与 Profile 均到 **2027-11-15**，到期需重签并同步更新仓库内 `signing/`；
- **faultlog 目录无权限**：`/data/log/faultlog/faultlogger/` 在本机 shell 下 `Permission denied`，崩溃判定依赖 hilog 与进程存活；
- **未做多设备 / 多分辨率验证**：只测了 `MLR-AL00` 一台（2560×1600 平板），手机形态与其它分辨率未验证；
- `apps/arkui-schedule/tools/install-device.ps1` 本次**未使用**（安装走的是直接 `hdc install`），其行为未验证。

## 11. 手写板功能与产物级验收（2026-11-15 实测）

### 11.1 团队须知：为什么「源码测试全绿 + BUILD SUCCESSFUL」但产物缺功能

这是本轮最重要的教训，**验收口径的失误**，必须记住：

| 环节 | 当时看到的 | 实际情况 |
| --- | --- | --- |
| `node --test` | 218→306 全绿 | 测的是 `src/main` 的纯逻辑，**没测产物内容** |
| `hvigor` 输出 | `BUILD SUCCESSFUL` | 只代表编译了 `aceModuleRoot` 里的东西 |
| 解包 HAP | —— | `main_pages.json` **只有 4 页**（无 `pages/Handwriting`），`modules.abc` 里 `Handwriting`/`hw-page-`/`PageBook`/`OcrBatch` 命中 **0** |

两个原因叠加：

1. **`.arkui-x/arkui-x-config.json5` 里的 `{crossplatform:true}`**：它会让 hvigor 判定这是 ArkUI-X 工程，
   进入 crossplatform 模式 —— `aceModuleRoot` 固定 `entry/src/main/ets`、`@kit.CoreVisionKit` 被
   `can't support crossplatform application` 拦下、**`src/harmony/**` 整棵不参与编译**。
2. **`entry/build-profile.json5` 的 `targets[].source.sourceRoots` 对 entry 模块不生效**：
   查 hvigor 插件源码（`src/utils/source-roots-utils.js`）可见它只用于**依赖的 HAR/HSP**，
   对 entry 自己的 ets 源根无效。之前"构建接受了这个字段"只是没报错，不代表生效。

=> 结论：**构建通过 ≠ 交付通过**。任何"鸿蒙专属代码"必须以产物内容为准。

### 11.2 修复：文件级覆盖 + 交叉平台开关 + 产物断言

| 机制 | 文件 | 说明 |
| --- | --- | --- |
| 覆盖层 | `apps/arkui-schedule/tools/overlay.mjs` | `apply`：把 `entry/src/harmony/**` 按相对路径复制到 `entry/src/main/**`（被覆盖的写进 `.platform-overlay/backup/`、新建的记账）；`restore`：逐字节还原并删除新建文件。**可逆、不污染工作区** |
| 交叉平台开关 | `tools/set-build-mode.mjs` | harmony 模式把 `.arkui-x/arkui-x-config.json5` 改名 `.harmony-off`（并去掉 `local.properties` 的 `arkui-x.dir`）；arkui-x 模式再放回 |
| 产物断言 | `tools/verify-hap.mjs` | 自带 ZIP 解析（无依赖）。鸿蒙：`main_pages.json` 必须含 `pages/Handwriting`，`modules.abc` 必须含 `Handwriting`/`hw-page-`/`PageBook`/`OcrBatch`，且含 Pen Kit 或 OCR 符号；APK：上述符号必须 **0 次** |
| 流水线 | `tools/build-harmony.ps1` | `apply overlay → devecocli build → restore overlay → verify-hap`；构建失败也会 restore |

实测输出（2026-11-15 15:14）：

```
> hvigor BUILD SUCCESSFUL in 26 s 996 ms
已还原：删除 5 个新建文件、写回 3 个备份文件

== verify HAP contents ==
产物：…\entry-default-unsigned.hap（1267692 B，13 个条目，模式 harmony）
  ✓ main_pages.json 含 pages/Handwriting（108 B）
  ✓ modules.abc 含 Handwriting（16 次）
  ✓ modules.abc 含 hw-page-（1 次）
  ✓ modules.abc 含 PageBook（2 次）
  ✓ modules.abc 含 OcrBatch（7 次）
  ✓ 含手写/OCR 能力痕迹（Pen Kit 3 次 / OCR 3 次）
✓ 产物验收通过
```

顺带修掉的真编译错误：`platformFeatures.ts` 里从 `.ts` import `.ets`（`ReminderService`）被 ArkTS 禁止
（`Importing ArkTS files in JS and TS files is forbidden`）→ 两棵树里都改名为 `platformFeatures.ets`。

### 11.3 手写板功能（本轮实装）

| 能力 | 实现要点 | 纯逻辑（Node 可测） |
| --- | --- | --- |
| 可选分页（默认 1 页，上限 10） | `PageBook`：页序 → 画布槽位映射，删中间页后其余页笔迹跟随；`HandwritingPagerState` 用扁平字段同步给 ArkUI | `model/pageBook.ts`（16 用例） |
| 页条 | 画布上方页码块 + 「＋」，当前页高亮，点页码跳页 | — |
| 框选（框内不 OCR） | overlay 是笔迹 Canvas 的**兄弟节点**（截图只截 `hw-page-<slot>`，框/手柄/× 不进图）；归一化坐标 0..1 → `fillRect` 填白 | `model/regions.ts`（17 用例） |
| 两阶段识别 | 阶段 A 逐页截图落盘 `attachments/<sha256>.png`（**先全部落盘**）→ 阶段 B 有框页 `release → maskPage → 二次截图 → recognize`，无框页直接识别 | `model/pageCapture.ts`（22 用例） |
| 正文拼接 | `composePageBody`：每页文字（`replaceComplexBlocks` 降级表格公式）+ 该页占位符 `[图表/公式: 查看手迹 · 第N页·区域K]`（按 y 升序） | `model/attachments.ts` |
| 笔工具 | 5 笔刷（钢笔/圆珠笔/铅笔/马克笔/荧光笔）+ 5 档粗细（2/3.5/5/7/10）+ 5 色 + 橡皮（`destination-out`，宽度×4）+ 撤销/重做（按页、≥20 步） | `model/brush.ts`（25 用例）、`model/strokeHistory.ts`（14 用例） |
| 唯一完成入口 | 底部 **「完成（统一识别）」**，无"翻页即识别"路径；`ocr_text` 只保留遮罩图识别文本，正文另加占位符 | — |

测试总数：`node --test` **306 pass / 0 fail**（原 218 + 88 新增），`validate-app.mjs` 8/8。

### 11.4 仍未验证 / 已知取舍

- **真机手势与渲染未验**（验证时平板处于锁屏 PIN 界面，`aa start` 报 `10106102`）：落笔、铅笔抖动、
  钢笔速度调制、橡皮擦除观感、框选手势命中、`componentSnapshot` 是否真的不含 overlay、填白后重绘是否够一帧；
- 马克笔/荧光笔是**逐段描边**，半透明笔刷在接缝处会重复叠加偏深（取舍：不每帧整页重绘）；
- 「一笔成形」（停顿 600ms 判定直线/矩形/圆）只留 `TODO`，未实现；
- `StrokeHistory` 没有 `redoDepth`，「重做」只有可用/不可用，没有步数；
- 填白是**破坏性**的（抹掉框内笔迹），依赖"阶段 A 已先落盘原图"这一顺序保证；取消整批时不会恢复画布。

## 12. Pen Kit 评估与手写板定版（2026-11-15 实测）

### 12.1 Pen Kit spike：不通过（已回退自研）

`@kit.Penkit` 在本机 SDK 里存在（`sdk/default/hms/ets/kits/@kit.Penkit.d.ts` → `@hms.stylus.HandwriteComponent.d.ets`，
API 26 声明齐全，`tablet-hmos.json` 也声明了 `SystemCapability.Stylus.Handwrite`），但真机 spike 在第 2 项失败：

```
E ArkCompiler: TypeError: Cannot read property createSystemHspModuleResourceManager of undefined
    at initPaintView (penkit|penkit|1.0.0|.../HspPaintController.ts:15:1)
    at PaintController (penkit|@hw-penengine/library|1.0.20240621|.../PaintController.ts:189:14)
    at HandwriteController (penkit|penkit|1.0.0|.../HandwritePaint.ts:373:1)
    at PenKitSpike entry (.../PenKitSpike.ets:27:45)
E AceRouter: failed to create page: pages/PenKitSpike
```

`new HandwriteController()` 依赖 Pen Kit 自带 HSP 模块的资源管理器，普通 entry 应用（系统 hms 包形态）取不到；
要修就得把 Pen Kit 的 HSP 作为依赖正确接入，属文档外的逆向。按 gate 规则**停止改造、回退自研**。

> 结论（写进设计取舍）：**`@kit.Penkit` 是闭源系统组件，不能 fork/修改**，只能用其公开 props
> （`defaultPenType` / `defaultPenInfo` / `hiddenTools` / `widthRatio` / `heightRatio` / `maxCanvasHeight` / `scaleDisabled`）；
> 我们选择仿制其交互而非集成，是因为它没有分页概念、存专有笔记文件、导出图片能否用于 OCR 未验证，
> 与"分页 + 逐页截图 + 框选遮罩"链路冲突。

### 12.2 手写板定版（自研，真机验证）

工具条 9 个位置（竖屏顶部横排 ≤48vp；横屏左侧竖排 rail ≤56vp）：

```
[笔形▾] [粗细▾] [颜色▾] [橡皮] [手动框] [撤销] [重做] [− n/m +] [完成]
```

- 笔形按钮显示**当前笔刷名 + ▾**（钢笔/圆珠笔/铅笔/马克笔/荧光笔），粗细显示**当前档位圆点 + 数值 + ▾**，
  颜色显示 20×20 色块 + ▾；按钮宽度**按内容自适应**（`minWidth(44)` + 左右 8vp padding，`flexShrink(0)`），
  整行 `Scroll` 横向滚动（溢出就滚、不换行、不压缩、不省略、禁 `TextOverflow.Ellipsis`）。
- 二级面板是**绝对定位浮层**（`minWidth(140)`，行高 44），不挤压画布、不遮画布中心。
- 步进器 `− n/m +`：`−` = 删除当前页（**两次确认**，只剩 1 页置灰）；`+` = **在当前页之后插入**空白页并跳转（上限 10）。
- 页用**稳定 id**（`p1/p2…`，`pageBook.ids`），插页/删页时笔迹、框、撤销历史、截图 id 一起跟随；占位符「第N页」用显示顺序。
- 「清空本页」已删除（用户要求：删除就够了），代码与 UI 里 `清空` 字样零命中。
- 首次进入弹一次引导（`preferences` 的 `handwriting.tipShown`），之后不再出现；页面无常驻提示与开发期文案。

真机 layout 证据（`devecocli ui layout`，1600×2560 竖屏）：

```
钢笔 @38,138→105,185   ▾ @110,138    3.5 @195,138→241,185  ▾ @246,138
(色块) ▾ @359,138      橡皮 @402,114→507,209   手动框 @516,114→654,209
↶ @664,114→769,209     ↷ @778,114→883,209      − @893,114→988,209
1/1 @988,114→1121,209  + @1121,114→1216,209    完成 @1429,114→1581,209（152px）
Canvas hw-page-p1: 0,218 → 1600,2494（高 2276/2560 = 88.9% 屏高）
```

菜单（点开后 `ui layout` 里可见）：笔形 `钢笔 ✓ / 圆珠笔 / 铅笔 / 马克笔 / 荧光笔`；
粗细 `2 vp / 3.5 vp / ✓ / 5 vp / 7 vp / 10 vp`。hilog 自证：`[hw] menu=brush open=1` / `[hw] menu=size open=1`。

### 12.3 端到端真机验证（写→框→完成）

操作：首页「新建」→「手写板」→ `uitest uiInput swipe` 写 2 笔 → 点「手动框」→ 拖一个框 → 点「完成」。

结果（回到编辑页后的 `ui layout`）：

```
正文
[图表/公式: 查看手迹 · 第1页·区域1]     ← 占位符写入正文
手迹附件（1 页）
```

hilog 同时出现真实 OCR 引擎日志（证明不是假通过）：

```
hiai.vision/OCR_LIB_MSG: LoadDetectModel::end : 195.08 ms
hiai.vision/OCR_LIB_MSG: InitLibrary::ocr finish : 205.51 ms
```

进程始终存活（同 PID），无 jscrash/appfreeze。截图：
`docs/images/ui-index-portrait.jpeg`、`ui-handwriting-portrait.jpeg`、`ui-handwriting-toolbar-menu.jpeg`、
`ui-edit-handwriting-result.jpeg`。

### 12.4 未验证 / 边界

- **横屏截图没取到**：`uitest uiInput` 无 `rotate` 命令、设备无 `wm`、`devecocli ui window` 只能 list；
  `orientation: auto_rotation` 只能等用户开系统自动旋转后物理横屏验证。仓库里的
  `ui-index-landscape.jpeg` 是**旋转失败**的那张（内容与竖屏相同），已如实标注，不当作横屏证据。
- 压感/铅笔抖动的手感只有"真机写过、不崩"这一级结论，缺少笔尖压力与视觉评估（工具注入无法产生压感）。
- 多分辨率/手机形态未验（只测 MLR-AL00 一台 1600×2560 平板）。
- AI 三个源的真机「测试」未做（没有可用 key）。

