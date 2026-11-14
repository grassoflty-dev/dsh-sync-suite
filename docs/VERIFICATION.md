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
| DevEco Studio / ArkUI-X 真实编译与签名 | 本机未安装 DevEco SDK | 用 DevEco 5 打开 `apps/arkui-schedule`：切 `default` product 构建，确认 `handwritingPageRoute()` 非空、`getFeatures()` 两项为 true；切 `android` product 构建，确认产物无 `Handwriting*`/`OcrBatchManager`/`ReminderService`/`@kit.CoreVisionKit`/`multimedia.image`；`source.sourceRoots` 装配未在 DevEco 5 实测，若 hvigor 不识别该字段，回退步骤见 `reports/platformfix.md` §7 |
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
- 应用 `.ets` 无法在本机编译，因此用三层替代验收：纯逻辑 tsc+node 测试（155 项）、静态规则校验（8 条）、
  代码级契约核对（页面/服务 API、平台覆盖、rawfile 真实产物）。
- `reports/`（执行者报告）被 `.gitignore` 忽略，属工作过程记录；本文件为对外验收证据。
