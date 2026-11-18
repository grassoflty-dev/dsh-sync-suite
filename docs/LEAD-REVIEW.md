# Lead 独立复核（第三轮，2026-11-15）

本文件只记录 **Lead 亲自执行**、与 Planner 报告相互独立的验证，命令均可在本机重跑。
测试脚本放在仓库外的 `.tmp/lead-smoke/`，不进入交付物。

## 1. 构建 / 测试 / 静态校验（与 Planner 数字一致）

```powershell
cd dsh-sync-suite
pnpm build                                    # 全部构建步骤完成
pnpm test                                     # tests 217 / pass 217 / fail 0（18 suites）
node apps/arkui-schedule/tools/validate-app.mjs   # ✅ 8/8（JSON5 12、import 78、main 静态 import 86、页面 4、rawfile 2）
.\node_modules\.bin\tsc -p apps/arkui-schedule/tools/tsconfig.json --noEmit   # exit 0
node --check packages/dsh-dots/dist/index.js    # exit 0
node --check packages/dsh-dots/dist/client.js   # exit 0
```

## 2. 插件形态冒烟（不启动 DSH，用假 ctx 加载 dist/index.js）

`15/15 通过`。覆盖：`inject = ['webServer','connection']`、`ctx.effect` 使用、只注册一条
`exact /dsh-dots/rpc`、真实 HTTP `getState`（三态 `reachable`、未配置不报错）、
未知 action、`apply` 无 confirm → `E_CONFIRM_REQUIRED`、`GET → 405`、
`requestRejection → 401` 且空 body、客户端模块在伪 `__ModuleLoader__` 下加载、
`factory` 返回 `{inject:['slots','locale'],apply}`、注册 `settings.section / id=dots / order=70`、
en/zh 字典 key 完全一致。

## 3. 端到端（真实 git 裸仓库 + 真实 RPC 面，两台设备各自 HOME）

`21/21 通过`。链路与断言：

| 步骤 | 断言 |
| --- | --- |
| A 保存设置 + 推送 | `pushed:true`，commit 非空 |
| 远端落盘 | 出现 `devices/pc-a/{cordis.patch.yml,providers.json,plugins.json,mcp.json,manifest.json}` |
| 密钥边界 | 载荷里**没有** `apiKey` 明文，出现 `__SECRET__` 占位符 |
| B 预览 | 枚举到 `pc-a`，`shared-entry` 为 `changed`，出现含密条目 |
| 无 confirm | `E_CONFIRM_REQUIRED`，B 的 patch 字节不变 |
| 逐条采纳 | 仅 `shared-entry` 写入；`b-only`（本地独有）保留；`# 设备 B 自己的注释` 保留；`!!js/function >` 保留；`a-only` 不被带过来；含密条目未自动采纳 |
| 回滚 | 写前快照存在；回滚 `verified:true`；B 的 patch **与写前字节完全一致** |

## 4. 真实 profile 只读探针

对 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（2656 B）执行 `collectLocal`（不写盘）：

```
cordis.patch.yml: bytes=2656 secretPlaceholders=0
providers.json:   bytes=291  items=1（opencode-go 的模型元数据）
plugins.json:     bytes=440  plugins=3（dsh-airremote / dsh-browser-cdp / dsh-codex-subscription，均 enabled:false）
mcp.json:         bytes=20   entries=0
```

真实 profile 里没有 `apiKey` 字面量（该 provider 走 `apiKeyEnv`），故 0 个占位符符合预期；
`maxTokens`/`apiKeyEnv` 未被误伤（第二轮审计修复项）。

## 5. 仍未验证（需真实环境）

| 项 | 状态 |
| --- | --- |
| 插件在 DSH GUI 中的实际挂载与 locale 渲染 | **未验证**（需安装；见 README 两条安装路径） |
| `entry/build-profile.json5` 的 `source.sourceRoots` 被 DevEco 5 / ArkUI-X 采纳 | **未验证**（本机无 SDK；回退方案见 `reports/platformfix.md` §7） |
| 鸿蒙真机 OCR / `componentSnapshot` / PixelMap / 提醒权限 / AGC 审批 | **未验证** |
| Android 设备运行、WebView 内 isomorphic-git 大 base64 传输 | **未验证** |
| 真实 GitHub / Gitee HTTPS·SSH 认证 | **未验证**（本地裸仓库路径已端到端验证） |

## 6. 结论

两条工程线的**代码、契约、离线可验证逻辑**均已闭环：插件引擎在真实 git 上跑通
push → preview → 逐条 apply → 回滚，安全边界（confirm 门禁、密钥不出机、本地独有不删除、
注释/`!!js` 保留、写后 SHA 校验）全部有实测证据；应用侧的纯逻辑（JSONL、AI 载荷、sha256、
分页 OCR 两阶段、设备目录隔离、平台门控）有 155 项测试与 8 条静态规则兜底。
剩余风险集中在**必须真机/真 SDK 才能验证**的运行时行为，已在 `docs/VERIFICATION.md` §6 列明。
