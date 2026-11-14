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
# 或一次跑全部（158 项）
pnpm test

# 应用静态校验
node apps/arkui-schedule/tools/validate-app.mjs
```

## 插件安装（本地目录安装，由用户/Lead 执行）

```powershell
# 方式 1：本地目录（开发/试用）
dsh plugin --profile web add link:C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\packages\dsh-git-config-sync

# 方式 2：打包后安装
cd packages\dsh-git-config-sync
npm pack
dsh plugin --profile web add .\dsh-git-config-sync-1.0.0.tgz
```

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

## 应用构建（需 DevEco Studio 5 + ArkUI-X 插件）

`apps/arkui-schedule` 是标准 DevEco 工程，本机未安装 DevEco SDK，**未做真机/模拟器构建验证**；
`tools/validate-app.mjs` 负责静态一致性检查（JSON5、import 图、平台门控、`@crossplatform`、isomorphic-git 资源）。
详细步骤与未验证项见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

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
