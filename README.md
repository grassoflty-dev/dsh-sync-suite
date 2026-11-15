# DSH 同步套件（dsh-sync-suite）

两条工程线的交付仓库：

| 交付物 | 路径 | 说明 |
| --- | --- | --- |
| DSH 配置同步插件 | `packages/dsh-git-config-sync/` | 把 DSH profile 配置打成设备快照推到自建 Git 仓库，支持跨设备 fail-closed 恢复 |
| ArkUI-X 日程助手 | `apps/arkui-schedule/` | HarmonyOS + Android 同一份 ArkTS；四字段日程、分页手写 + 串行 OCR、AI 汇总、Git 同步 |

需求基准：[`BRIEF.md`](BRIEF.md)。接口与数据契约：[`docs/DATA-CONTRACT.md`](docs/DATA-CONTRACT.md)；
架构与安全边界：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；验收证据：[`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

## 快速开始

```powershell
# 依赖（仅开发期 TypeScript，插件运行时零依赖）
pnpm install

# 构建：插件 tsc + 客户端模块拷贝 + 应用纯逻辑编译 + node --check
pnpm build

# 测试（Node 24 的 --test 需要 glob，目录形式会报 MODULE_NOT_FOUND）
node --test "packages/dsh-git-config-sync/test/*.test.mjs"
node --test "apps/arkui-schedule/tools/test/*.test.mjs"
# 或一次跑全部（217 项）
pnpm test

# 应用静态校验
node apps/arkui-schedule/tools/validate-app.mjs
```

## 插件安装（两条路径，由用户/Lead 执行）

> 前置：`packages/dsh-git-config-sync/dist/` **必须已在仓库里**（本仓库已提交）。链接安装不会执行构建，
> 若 `dist/` 缺失，设置页不会出现（`exports["./client"]` 指向空文件）。

**① GUI「Plugins → Add plugin」选本地目录（推荐，链接安装）**

在 DSH Web GUI 的插件管理里添加插件并选择目录：

```
C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\packages\dsh-git-config-sync
```

等价 CLI（若你的环境允许）：

```powershell
dsh plugin --profile web add link:C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\packages\dsh-git-config-sync
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

- token 只存 `%USERPROFILE%\.dsh\git-config-sync\credentials.json`（0600），不进同步载荷；
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

两种构建模式（DevEco 26 的 schema 只接受 `runtimeOS: HarmonyOS | OpenHarmony`，所以 Android
product 必须等 ArkUI-X 工具链）：

```powershell
node tools\set-build-mode.mjs --check          # 当前模式
node tools\set-build-mode.mjs --mode harmony   # 默认：纯鸿蒙，无 Android product、无 @crossplatform
node tools\set-build-mode.mjs --mode arkui-x   # ArkUI-X 双端：双 product + 给每个 struct 加回 @crossplatform
```

`tools/validate-app.mjs` 负责静态一致性检查（JSON5、import 图、平台门控、`@crossplatform` 与构建模式一致性、isomorphic-git 资源）。
构建细节、真实报错与修复记录见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md) §8。

## 目录

```
docs/            ARCHITECTURE / DATA-CONTRACT / CONTRACT / VERIFICATION
packages/dsh-git-config-sync/
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
