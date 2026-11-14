# 架构（ARCHITECTURE）

本仓库包含两条独立工程线，共用一个“设备只写自己目录”的数据契约：

1. `packages/dsh-git-config-sync` —— DSH（DeepSeek Harness）Web 配置同步插件。
2. `apps/arkui-schedule` —— ArkUI-X 跨平台日程助手（HarmonyOS + Android）。

## 1. 总体数据流

```
设备 A（PC-a）                     Git 远端（用户自建 GitHub/Gitee 私有仓库）              设备 B（PC-b）
┌────────────────────┐              ┌──────────────────────────────┐                ┌────────────────────┐
│ ~/.dsh/profiles/web│  collect     │ devices/pc-a/                │   git pull     │ ~/.dsh/profiles/web│
│  cordis.patch.yml  │ ───────────▶ │   cordis.patch.yml (脱敏)    │ ─────────────▶ │  cordis.patch.yml  │
│  package.json      │  推送快照    │   providers.json             │  预览/逐条勾选  │  package.json      │
│  已安装插件清单     │              │   plugins.json  mcp.json     │  fail-closed   │  ...               │
└────────────────────┘              │   manifest.json              │  写前快照+校验  └────────────────────┘
                                    └──────────────────────────────┘
手机侧（ArkUI-X）只在 devices/phone-a/ 下追加 JSONL 与附件，永不 merge 其他设备目录。
```

核心原则：

- **单写者**：每台设备只写 `devices/<deviceId>/`，冲突面从“同一文件并发编辑”降为“不同目录各自追加”。
- **按 entry id 合并**：`cordis.patch.yml` 是 YAML 数组，每条 entry 有稳定 id；跨设备合并是
  “逐条取远端块”而不是 YAML 反序列化再序列化，因此注释、`!!js`、键顺序、引号风格全部保留。
- **密钥不出设备**：所有载荷在采集阶段脱敏，`__SECRET__` 占位；恢复时用本地同名值回填，本地没有则不覆盖并标记“需本地填写”。
- **fail-closed 恢复**：必须 `confirm:true` + 有效 previewId；逐条勾选；写前快照；写后 SHA-256 校验；异常回滚。

## 2. 插件 A：dsh-git-config-sync

```
src/index.ts          Cordis 函数插件入口（inject: webServer, connection）
  └─ rpc.ts           RPC 分发 + 串行写队列 + HTTP 适配 + 鉴权拒绝
      ├─ engine/paths.ts       状态/工作副本/快照路径
      ├─ engine/settings.ts    设置与凭据（settings.json / credentials.json，0600）
      ├─ engine/collect.ts     读取 profile → 4+1 个同步文件（脱敏）
      ├─ engine/patch.ts       YAML entry 切分 / 合并 / 序列化
      ├─ engine/secrets.ts     递归 + 行级脱敏/回填
      ├─ engine/pluginMerge.ts MERGE-only 插件清单决策
      ├─ engine/snapshot.ts    写前快照（保留 10 份）
      ├─ engine/preview.ts     远端快照 vs 本地差异
      ├─ engine/restore.ts     apply / rollback（校验+回滚）
      └─ engine/git.ts         execFile git，GIT_ASKPASS 临时凭据，pull --rebase + push（≤2 次）
src/client.js         Web GUI 设置分区（纯 JS，ModuleLoader 加载）
```

关键点：

- 插件运行时**零 npm 依赖**，只用 `node:` 内置模块；`dist/` 提交进仓库，安装后无需构建。
- 不使用 `ctx.settings.installSection` / `settings.plugin.item`（当前 DSH 0.2.2-rc.3 不存在）。
- 配置存在插件自有状态目录 `~/.dsh/git-config-sync/`，不依赖 schemastery。
- Token 只存 `credentials.json`；HTTPS 认证用临时 `GIT_ASKPASS`（0600，token 走环境变量），不进 argv。
- 非 fast-forward：`pull --rebase` 后重试 push，最多 2 次，**永不 force**。
- 插件安装（pnpm/profile 变更）不由插件执行：MERGE-only 计划写入
  `~/.dsh/git-config-sync/plugins.to-install.json` 交用户/Lead 用安全启动器安装。

## 3. 应用 B：arkui-schedule

```
entry/src/main/ets/
  pages/           共享 4 页（Home/Edit/Detail/Settings），@crossplatform
  model/           纯 TS 逻辑：JSONL、sha256、AI 载荷、分页拼接、附件命名、提醒计划
  common/          平台门控、日期、能力注册表
  services/        scheduleStore / attachmentStore / deepseek（@ohos 运行时 API）
entry/src/harmony/ets/   鸿蒙覆盖层：Canvas 手写分页板、OcrBatchManager、提醒、平台能力注册
entry/src/android/ets/   Android 覆盖层：能力注册（handwriting=false, ocr=false）
```

- **平台门控**：共享代码只依赖 `common/features.ts` 的接口；`platform/platformFeatures.ts` 由平台覆盖层
  提供实现。Android 构建 = `main` + `android`，物理上不含手写/OCR 模块，编译期就不可能引用鸿蒙 API。
- **手写 + OCR**：Canvas 分页（`setMaxPages`）→ 每页截图先落盘 `attachments/<sha256>.png` → 串行 OCR
  （`maxConcurrency=1`）→ 每页完成立即释放 PixelMap → 结果按 pageIndex 存 → 全部完成后 0→N 拼接一次填正文。
  `ocr_text` 保留原始识别，编辑写 `body`。
- **存储**：`git-repo/devices/<deviceId>/schedules/YYYY-MM-DD.jsonl`，一行一事件、只追加；附件按 sha256 去重。
- **同步**：Web 组件 + isomorphic-git（真实 dist 放 rawfile）+ ArkTS 文件/HTTP 桥；只写自己目录，读他人目录折叠展示。
- **AI 汇总**：手动触发、可取消勾选、载荷注入时间与时区；结果只写 `ai_structured`，`ai_processed` 翻转。
- **提醒**：reminderAgentManager（≤30 条），未授权降级 notificationManager；AGC 申请+手动签名约 8 工作日。

## 4. 安全与失败模式

| 风险 | 措施 |
| --- | --- |
| token 泄漏到仓库/日志/argv | 采集即脱敏；token 只存 0600 文件；GIT_ASKPASS 环境变量；测试用假值 |
| 远端恶意 patch 执行 `!!js` | 只同步文本，不在插件进程求值；restore 逐条确认；写前快照可回滚 |
| 半写/崩溃 | 原子写（temp+rename）+ 写后 SHA-256 + 快照回滚 |
| 并发写 | 单进程串行队列；跨进程靠 git 快照目录隔离 |
| 本地独有配置丢失 | 合并规则本地优先保留；插件清单 MERGE-only 永不删 |
| 设备 ID 非法/路径穿越 | `^[a-z0-9][a-z0-9-]{0,31}$`；所有路径来自固定根 + 校验后的 id |
| Android 误引鸿蒙 API | 覆盖层目录 + validate-app.mjs 静态检查 |

## 5. 未验证项（本机无法执行）

- DevEco Studio / hvigor 真实构建（未安装 SDK）：`validate-app.mjs` 只做静态一致性检查。
- 真机 OCR、PixelMap 截图、AGC 权限、提醒授权、Android 设备运行。
- 真实 GitHub/Gitee HTTPS/SSH 远端认证（测试用本地裸仓库）；插件在真实 DSH GUI 的挂载与交互（由 Lead 验证）。
