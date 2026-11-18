# DSH 同步套件（dsh-sync-suite）

两条工程线的交付仓库：

| 交付物 | 路径 | 说明 |
| --- | --- | --- |
| DSH 配置同步插件 | `packages/dsh-dots/` | 把 DSH profile 配置打成设备快照推到自建 Git 仓库，支持跨设备 fail-closed 恢复 |
| ArkUI-X DSH-Dots | `apps/arkui-schedule/` | HarmonyOS + Android 同一份 ArkTS；四字段日程、分页手写 + 串行 OCR、AI 汇总、Git 同步 |

需求基准：[`BRIEF.md`](BRIEF.md)。接口与数据契约：[`docs/DATA-CONTRACT.md`](docs/DATA-CONTRACT.md)；
架构与安全边界：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；验收证据：[`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

## 快速开始

```powershell
# 依赖（仅开发期 TypeScript，插件运行时零依赖）
pnpm install

# 构建：插件 tsc + 客户端模块拷贝 + 应用纯逻辑编译 + node --check
pnpm build

# 测试（Node 24 的 --test 需要 glob，目录形式会报 MODULE_NOT_FOUND）
node --test "packages/dsh-dots/test/*.test.mjs"
node --test "apps/arkui-schedule/tools/test/*.test.mjs"
# 或一次跑全部（217 项）
pnpm test

# 应用静态校验
node apps/arkui-schedule/tools/validate-app.mjs
```

## 插件安装（两条路径，由用户/Lead 执行）

> 前置：`packages/dsh-dots/dist/` **必须已在仓库里**（本仓库已提交）。链接安装不会执行构建，
> 若 `dist/` 缺失，设置页不会出现（`exports["./client"]` 指向空文件）。

**① GUI「Plugins → Add plugin」选本地目录（推荐，链接安装）**

在 DSH Web GUI 的插件管理里添加插件并选择目录：

```
C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\packages\dsh-dots
```

等价 CLI（若你的环境允许）：

```powershell
dsh plugin --profile web add link:C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\packages\dsh-dots
```

**② 发布到 GitHub 后走安全启动器（npm/GitHub 来源）**

安全启动器只接受 npm 包名或 `github:owner/repo`，**不接受本地目录**：

```powershell
# 先把本仓库推到 GitHub（含 dist/），然后在 DSH 运行时执行：
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3080/dsh-safe-launch/install-plugin `
  -ContentType 'application/json' -Body '{"source":"github:<owner>/<repo>"}'
# 返回 {ok:true,jobId} 后轮询：
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3080/dsh-safe-launch/job `
  -ContentType 'application/json' -Body '{"id":"<jobId>"}'
```

若 `127.0.0.1:3080` 不在线，请先启动 DSH，**不要**绕过安全启动器直接改
`~\.dsh\profiles\**` 或用 pnpm 操作 profile（跳过金丝雀启动测试）。

安装后在 Web GUI「设置 → 配置同步（Git）」中填写仓库地址、设备标识与 token（HTTPS）。
安全说明：

- token 只存 `%USERPROFILE%\.dsh\dots\credentials.json`（0600），不进同步载荷；
- 所有 provider/MCP/patch 载荷在采集阶段脱敏为 `__SECRET__`，恢复时用本地同名值回填；
- 恢复必须 `confirm:true` + 逐条勾选，写前自动快照（保留 10 份），写后 SHA-256 校验，失败回滚；
- 永不 force push；非 fast-forward 先 `pull --rebase` 最多重试 2 次。

## 仓库初始化（自建 GitHub/Gitee 私有仓库）

```powershell
node tools/init-remote-repo.mjs --dir C:\Users\GWL\dsh-sync-repo
# 按脚本输出把该目录推到你的私有仓库；插件设置里填同一个 repoUrl
```

## 应用构建（已实测：DevEco Studio 26.0.0.865 + HarmonyOS SDK 26.0.0）

本机已用官方 IDE 工具链真实构建通过（HAP 未签名）：

```powershell
# 环境（DevEco 装在 D 盘；换路径时改这两个变量即可）
$env:DEVECO_CLI_STUDIO_PATH = 'D:\A-DevEco\DevEco Studio'
$env:DEVECO_SDK_HOME = 'D:\A-DevEco\DevEco Studio\sdk'

# 构建（devecocli 来自官方 npm 包 @deveco/deveco-cli）
cd apps\arkui-schedule
devecocli build --product default        # => BUILD SUCCESSFUL，产物 entry/build/default/outputs/default/entry-default-unsigned.hap

# 边用电脑边构建（限制 4/12 核 + BelowNormal）
powershell -File .\tools\build-harmony.ps1 -Cores 4
```

两种构建模式（同一份 ArkTS 源码，产物不同）：

```powershell
node tools\set-build-mode.mjs --check          # 当前模式
node tools\set-build-mode.mjs --mode harmony   # 鸿蒙 HAP：entry = src/main + src/harmony
node tools\set-build-mode.mjs --mode arkui-x   # 安卓 APK：entry = src/main（无手写/OCR）
```

**安卓 APK（ArkUI-X，已实测）**：

```powershell
$sdk = "$env:LOCALAPPDATA\ArkUI-X\Sdk\26.0.0\arkui-x"       # DevEco 插件下载的 ArkUI-X SDK 26.0.0.28
$env:PATH = "$sdk\toolchains\bin;D:\A-DevEco\DevEco Studio\tools\node;$env:PATH"
$env:JAVA_HOME = 'D:\jdk17\jdk-17'                           # Gradle 8.4 不能用 DevEco 自带 JDK 25
$env:ANDROID_HOME = 'D:\android-sdk'
node tools\set-build-mode.mjs --mode arkui-x
ace build apk --debug     # => BUILD SUCCESSFUL，产物 .arkui-x/android/app/build/outputs/apk/debug/app-debug.apk
```

已产出：`dist-android/arkui-schedule-android-debug.apk`（50.84 MB，含 ArkUI-X 运行库，无手写/OCR 代码）。
详细步骤、踩坑与证据见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md) §8（鸿蒙）、§9（安卓）。

**鸿蒙真机安装（已实测：MLR-AL00 / API 26）**：

```powershell
# 前置：AGC 里已有应用 + 调试证书 + 已登记设备 UDID + 调试 Profile
# （没有的话 devecocli 会报 DEVICE_MISSING，见 docs/VERIFICATION.md §10.2）

cd apps\arkui-schedule

# 1) 构建（产出未签名 HAP）
powershell -File tools\build-harmony.ps1 -Cores 4     # => entry\build\default\outputs\default\entry-default-unsigned.hap

# 2) 签名（二选一）
#    a. 自动签名：devecocli 从 AGC 取材料，写 signingConfigs + %USERPROFILE%\.ohos\config\
#       产物是 entry-default-signed.hap
devecocli signature generate --product default --force
#    b. 离线签名：仓库内 signing/ 材料 + 明文口令，不改 build-profile.json5
#       （hvigor 只认 DevEco 加密口令，明文会报 00303116，所以走离线脚本）
#       产物是 entry-default-unsigned-signed.hap
powershell -File tools\sign-hap.ps1

# 3) 安装（换了签名身份要先 uninstall，否则 install sign info inconsistent）
hdc -t 6MFBB25C27205131 install -r entry\build\default\outputs\default\entry-default-unsigned-signed.hap

# 4) 启动
hdc -t 6MFBB25C27205131 shell aa start -a EntryAbility -b com.itwill.schedule

# 5) 看日志（hilog 无 jscrash 即视为启动正常；hdc install 失败时退出码仍为 0，要看输出文本）
hdc -t 6MFBB25C27205131 shell hilog -r
hdc -t 6MFBB25C27205131 shell aa start -a EntryAbility -b com.itwill.schedule
hdc -t 6MFBB25C27205131 shell hilog -x
```

已产出：`apps/arkui-schedule/dist-harmony/arkui-schedule-harmony-debug-signed.hap`（953,791 B，调试签名，
只能装到 AGC 已登记 UDID 的 `MLR-AL00`；HAP 与 APK 一样属构建产物，按 `.gitignore` 不入库）。

签名材料在 `apps/arkui-schedule/signing/`，证书/Profile 与设备 UDID 绑定，细节与踩坑见
[`docs/VERIFICATION.md`](docs/VERIFICATION.md) §10。

**正文手写怎么用（鸿蒙，真机已验）**：

1. 新建/编辑日程 → 正文右上「手写板」进入；
2. 顶部工具条 9 个位置：`[笔形▾] [粗细▾] [颜色▾] [橡皮] [手动框] [撤销] [重做] [− n/m +] [完成]`，
   点带 ▾ 的按钮弹出二级面板（笔形 5 种 / 粗细 5 档 / 颜色 5 色）；
3. 需要"只存原图、不做识别"的内容（图表、公式）→ 点「手动框」，在画布上拖出矩形（可拖动、调大小、删除，一页可多个框）；
4. 全部页写完后点一次「完成」：系统**先把每页原始截图落盘**到 `attachments/<sha256>.png`，
   再把框内区域填白、对遮罩图统一 OCR，正文里框的位置插入 `[图表/公式: 查看手迹 · 第N页·区域K]`；
5. `− n/m +` 是页控制：`−` 删除当前页（两次确认），`+` 在当前页之后插入空白页（上限 10 页）。
6. 首次进入会弹一次说明（之后不再出现）；识别进度用 toast，不常驻占屏。

细节与真机证据见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md) §11–§12。

## 目录

```
docs/            ARCHITECTURE / DATA-CONTRACT / CONTRACT / VERIFICATION
packages/dsh-dots/
  src/           host（TypeScript）+ client.js（ModuleLoader 纯 JS）
  dist/          构建产物（提交进仓库，安装后无需构建）
  locale/        en.json / zh.json
  test/          node --test（真实临时 Git 裸仓库集成测试）
apps/arkui-schedule/
  entry/src/main/ets/{pages,components,model,common,services}
  entry/src/harmony/ets  鸿蒙覆盖层（手写/OCR/提醒）
  entry/src/android/ets  Android 覆盖层
  entry/src/main/resources/rawfile/git  isomorphic-git + 文件/HTTP 桥
  tools/         tsc 类型检查、validate-app.mjs、纯逻辑测试
devices/         同步仓库设备目录示例（pc-a / pc-b / phone-a）
tools/           build.mjs / init-remote-repo.mjs
```

## 测试覆盖（摘要）

- 插件：patch 逐条合并保注释/`!!js`/本地独有、secret 脱敏与回填、`confirm:true` 门禁、SHA 校验失败回滚、
  插件清单 MERGE-only 不降级、临时裸仓库 + 真实 git 的 push→pull→preview→apply→rollback 全链路。
- 应用：JSONL 编解码与折叠、SHA-256、AI 载荷构建、分页 0→N 拼接、附件命名、平台门控、JSON5/import/
  main_pages/Android 门控/`@crossplatform`/rawfile 静态校验。

## 边界

- 不修改 `~/.dsh/profiles/**`、不调用 `plugin_manager`、不对 profile 执行 pnpm —— 插件安装与 GUI 验证由 Lead 执行。
- 本机无法验证：DevEco 编译、真机 OCR/提醒、AGC 权限、真实 GitHub/Gitee 认证（测试用本地裸仓库）。
