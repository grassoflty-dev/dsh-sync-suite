# 设计师交接（Designer handover）— 2026-11-21 18:15

## 状态
- HEAD: `5599196`（80+ tags，`origin/main` 已同步）。工作树 8 条未提交路径：bootstrap 四个 + 三个共享 docs + `AppScope/app.json5`。
- 已提交：v2-only / 迁移删除 / shell 四段（rail+dots/日程/远程 DSH/云端对话）/ 设置 IA（根四行 + 同步·导出·API 三个真页面 + 入口去重）/ 实例面板只读 / 云端对话去配置说明 / 同步绑定修复（③）/ 下拉刷新共享 builder（④）/ AI 端点修复（②，`/inference/go/openai/v1`）/ 两处 ArkTS 编译修复 / 无痕构建规则。
- 设备上装的：**1000003**（含 ①③，含 ③ 的编译修复）；**不含** ②④ 与 bootstrap。

## 队列（按序）
1. **bootstrap**（进行中）：空远端 = 首次状态 → 初始提交（`timeline/schema.json` + 本地记录）→ push `main` → 上游 → 继续周期；非空无 `main` 保留 typed 错；幂等（不得重复根提交）。必须 gates + 真实 build（命名 log）+ review。
2. **1000004**：先 bump `versionCode`，build → sign（`-AllowLegacyV1Key`，引用 leaked-key 警告原文）→ install → **内容哈希证明**（`hdc file recv …/haps/entry/modules.abc` 与签名 HAP 内同名条目比 SHA256，两个哈希都贴）。
3. **§15.18**：用户复测四项（① 无配置入口；② AI 200 或 provider+model typed 错；③ 重试与新建后自动同步；④ 竖屏下拉）→ PASS/FAILED/BLOCKED + 证据来源。
4. `mod-settings-ia-guards` → `mod-shell-cloud-chat-pane` → `mod-shell-dots-pane` → `mod-dots-readonly`（首次真正编译 `instanceGrantStore`）。
5. 发布阻塞（研究已交付 `docs/RELEASE-PLAN-APPGALLERY.md`）：开发者账号+实名、release cert+profile（v2 `.cer`/`.p7b` 缺）、HAP→APP、备案、隐私政策/双清单、AI 合规。**需用户拍板才动**。

## 常驻规则
- 并发 ≤5；一文件一主人；同文件串行。
- **任何改 `.ets` 的模块，交付前必须跑真实 `build-harmony.ps1` 并在汇报里点名 log**（`tsc` 只覆盖 `model/`+`common/`；`067cbb5` 曾因此带 ArkTS 错进主干，设备上是旧二进制）。
- 临时脚本只放 `.tmp/`；根目录/`apps/arkui-schedule/` 下出现 `.tmp-*` 视为冻结阻塞。
- 冻结条件：`overlay applied=false`、无 overlay 残留（`.platform-overlay/`、`ets/handwriting|ocr/`、`pages/Handwriting.ets`）、全量 tests fail 0、validate 8/8、tsc 0；共享文件在 commit message 里写明“必须一起回滚”。
- **`bm dump` 的 `versionCode` 在本机恒为 0/空，不能作为安装证明**（已写入 RUNBOOK）：用内容哈希 + 新构建独有行为。
- 凭证协议：令牌/密钥永不读、不写、不打印；只观察 测试连接结果、状态行原文、仓库侧证据（设备无 `git`，用 `file recv` 后桌面 git 核对），或让用户贴提交列表。
- 签名：v2 材料不全 → 默认拒绝 leaked v1；本地复现才用 `-AllowLegacyV1Key`，并引用 `LEAKED v1 signing key … reproduce-only, never ship` 原文。

## 下三步（精确）
1. 等 `bootstrap-finish` 到 18:25；无写入/无汇报 → 亲自接手四文件（`syncCycle.ts`、`gitRunner.ets`、`git-bridge.js`、`syncEmptyBootstrap.test.mjs`），最小可用：检测 + 初始提交 push + 幂等测试 + gates + 一次 build（命名 log）。
2. 交冻结：路径清单 + gates tail + build log + review 结论 + 回滚路径。
3. 用户提交后：bump 1000004 → build/sign/install → 内容哈希证明 → 四项复测清单 → `§15.18`。
