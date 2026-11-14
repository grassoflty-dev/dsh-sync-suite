# BRIEF — 两条工程线交付（给总设计师与执行子代理）

本文件是唯一需求基准。所有子代理看不到主会话，必须完整阅读本文件后再动手。

## 0. 角色与协作
- 总设计师（Planner）：定方案、拆任务、派生执行者、评审整合、跑全部验收、写交付文档、git 提交。
- 执行者（Executor）：只做被指派的模块，必须自测并把证据写回报告。
- 层级固定 Lead → Planner → Executor。执行者**不得**再派生任何子代理（系统 depth cap=2）。
- 同一时刻最多 3 个执行者并行。
- 派生执行者必须用 `subagent` 工具并显式传 `provider: "deepseek-official"`, `model: "deepseek-flash"`, `reasoning_effort: "high"`。不要用 `subagent_fork`。
- 执行者 prompt 必须自包含：绝对路径、目标、接口契约、验收命令、输出位置。

## 1. 环境与边界
- 产物根目录：`C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`（独立 `git init`，main 分支）。
- 禁止修改 `C:\Users\GWL\.dsh\profiles\**`；禁止 `pnpm` 操作 profile；禁止调用 `plugin_manager`；插件的安装与 GUI 验证由 Lead 负责。
- Windows + PowerShell（无 bash）。Node v24.14、pnpm 11.22、git 2.53、网络可用（npm registry 200，代理 127.0.0.1:7897）。未预装 typescript，可在项目根 `pnpm add -D typescript @types/node`。
- 工作区根目录有大量历史垃圾文件，忽略，只在 `dsh-sync-suite` 内工作。
- 核心原则：每台设备只写自己的目录；跨设备通过追加事件/按 entry id 合并完成；不做 YAML 反序列化再序列化；密钥永不进入同步载荷。

## 2. 交付物 A：DSH 配置同步插件 `packages/dsh-git-config-sync`
### 2.1 清单与构建
- Cordis 函数插件 `export function apply(ctx, config)`，所有注册走 `ctx.effect(...)`。
- `package.json`：`name: dsh-git-config-sync`、`type: module`、`exports {".":"./dist/index.js","./client":"./dist/client.js","./locale/*.json":"./locale/*.json","./icon":"./icon.svg"}`、`dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client {platform:"web", immediately:true, inject:["@deepseek-ai/dsh-client-ui-settings"]}`、`files` 覆盖全部运行时文件。
- TypeScript 源码 `src/` → tsc 编译 `dist/`（dist 提交进仓库，安装时无需构建）。`pnpm build` 可重跑。禁止运行时 npm 依赖（只用 `node:` 内置模块）。不导出 `Config`（无 schemastery 依赖可解析），配置存插件自有状态目录。
- 不使用 `settings.plugin.item` / `ctx.settings.installSection`（当前 DSH 0.2.2-rc.3 不存在）。

### 2.2 已核实的 DSH API（照此实现）
- 设置分区：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'git-config-sync', order:70, label:()=>t('nav'), locale:NS }, Component))`；组件 props 含 `t`、`close`。
- 客户端模块（纯 JS，无需构建）：
```js
window.__ModuleLoader__.load({
  id: 'dsh-git-config-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // ...组件
    return { inject: ['slots','locale'], apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }))
      ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Component))
    } }
  },
})
```
- Host RPC：`export const inject = ['webServer','connection']`；`ctx.effect(() => ctx.webServer.register({ kind:'exact', path:'/dsh-git-config-sync/rpc', handler }))`；handler 开头 `const rej = ctx.connection.requestRejection(req); if (rej) { res.statusCode = rej; res.end(); return }`。Client 用同源 `fetch('/dsh-git-config-sync/rpc', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({action, ...})})`。
- 样式用 `--dsw-alias-*` 主题变量，自写控件，不引第三方 UI 库。

### 2.3 同步引擎
- 白名单：`cordis.patch.yml`（按 entry id 逐条合并，保留注释与 `!!js`）、provider 定义、插件清单（包名/版本/来源/启用状态，不同步代码与 node_modules）、MCP 定义、插件自身配置（剔除 secret 字段）。
- 敏感值（key 匹配 `token|secret|password|apikey|api_key|authorization|bearer`）不写入载荷，快照里替换为 `__SECRET__`；restore 时保留本地同名字段值，本地没有则跳过并标注“需本地填写”。
- 设备快照目录 `devices/<deviceId>/`：`cordis.patch.yml`、`providers.json`、`plugins.json`、`mcp.json`、`manifest.json`（deviceId/time/scopes/dsh 版本/各文件 sha256）。
- 推送：写快照 → `git add` → `commit` → `push`；非 fast-forward 先 `pull --rebase` 再 push（≤2 次），**永不 force**。git 用 `node:child_process.execFile` 调系统 git。工作副本在 `%USERPROFILE%\.dsh\git-config-sync\work\<repoHash>\`。
- restore fail-closed 四层：① 必须 `confirm:true`，否则只 dry-run 预览（覆盖/新增/本地独有（不删）/需本地填写）；② 逐 entry 勾选；插件清单 MERGE-only（远端有本地无可安装、本地有远端无永不删、本地版本高不降级）；③ 写前快照到 `%USERPROFILE%\.dsh\vet\restore-snapshots\<timestamp>\` 保留最近 10 份；④ 写后 SHA-256 校验，不一致报错并可回滚。
- 认证：HTTPS token 用临时 `GIT_ASKPASS`（0600 文件，不进 argv）；SSH 用系统 ssh-agent。状态文件 `%USERPROFILE%\.dsh\git-config-sync\{settings.json,credentials.json}`，权限仅当前用户。repoUrl 仅 https/ssh/git@；deviceId 匹配 `^[a-z0-9][a-z0-9-]{0,31}$`。

### 2.4 RPC 契约（A/B 并行必须一致）
POST `/dsh-git-config-sync/rpc`，body `{action, ...}`，响应恒 `{ok:true,data}` 或 `{ok:false,error:{code,message,details?}}`（HTTP 200；仅鉴权失败 401/403）。action：
- `getState` → `{settings:{repoUrl,platform:'github'|'gitee'|'custom',authMode:'https'|'ssh',deviceId,branch,scope:{config,providers,plugins,mcp},hasToken}, status:{reachable,branch,headSha,headMessage,headTime,localPending,remotePending,conflict,lastSyncAt,error?}, snapshots:[{id,time,reason,bytes}]}`
- `saveSettings` `{settings, token?}` → `{settings, hasToken}`
- `testConnection` → `{reachable, branch, headSha, message}`
- `push` → `{pushed, commit, branch, files, rebased}`
- `preview` → `{previewId, sources:[{deviceId, headSha, files:[{name,sha256,bytes}], entries:[{id,name,status:'added'|'changed'|'same'|'manual',localText,remoteText,secretStripped}], plugins:{install,keep,skip,noDowngrade}, providers, mcp}]}`
- `apply` `{confirm:true, previewId, sourceDevice, entries:string[]}` → `{applied:[{id,sha256,path}], skipped:[{id,reason}], snapshotId, verified:true}`；非 `confirm:true` 返回 `E_CONFIRM_REQUIRED` 且不写文件。
- `listSnapshots` → `{snapshots}`；`rollback` `{snapshotId, confirm:true}` → `{restored, verified:true}`
- 未识别 action → `E_UNKNOWN_ACTION`；所有写操作串行队列。

### 2.5 设置页 UI 内容
仓库配置（平台 GitHub/Gitee 仅影响 URL 提示、仓库地址、认证方式、设备标识）、同步范围勾选（默认全选）、状态徽标（本地/仓库/待上传/待下载/冲突 + 分支 + 最近提交）、按钮（保存设置/测试连接/推送/拉取预览/执行覆盖（未预览不可点）/历史回滚）、逐条差异勾选（采纳远端/保留本地）、插件清单 MERGE-only 展示、快照列表与回滚、内联错误。Token `type=password`。

### 2.6 bundle 资源与验收
- `locale/en.json`+`locale/zh.json`（`meta.title`/`meta.description`/`meta.detail`）、`docs/DETAIL.md`、原创 `icon.svg`、`README.md`。
- 真实测试（`node --test`，不依赖网络）：patch 逐条合并保留注释/!!js/本地独有；secret 脱敏与 `__SECRET__` 保留；`confirm:true` 门禁；SHA 校验失败可回滚；插件清单 MERGE-only 不降级。集成测试用临时裸仓库 + 真实 git：push → 另一设备目录 pull → preview → apply → rollback 全链路。
- `pnpm build` 后 `node --check dist/index.js`、`node --check dist/client.js` 通过。

## 3. 交付物 B：ArkUI-X 日程助手 `apps/arkui-schedule`
### 3.1 跨平台
- 用 **ArkUI-X**：同一份 ArkTS 支持 HarmonyOS 与 Android。页面/组件加 `@crossplatform`；页面清单 `entry/src/main/resources/base/profile/main_pages.json`。
- 工程骨架：DevEco Studio 5（API 12+）Empty Ability，`AppScope/app.json5`、根 `build-profile.json5`、`hvigorfile.ts`、`oh-package.json5`、`entry/{build-profile.json5,hvigorfile.ts,oh-package.json5}`、`entry/src/main/{module.json5,resources/...}`。
- 平台门控：`common/platform.ets` 暴露 `isHarmonyOS`（ArkUI-X 下 Android 侧为 false）；Android 产物**不得**编译/引用 OCR、PixelMap 截图、Canvas 手写模块。

### 3.2 鸿蒙功能
- 四字段日程：标题/正文/记录者/完成情况。标题、记录者 TextInput（系统全局手写输入）；正文 TextArea + 「手写板」切换。
- 分页手写板：Canvas 分页（`setMaxPages` 限制），点「完成并识别」时**先**同步把每页截图存 `attachments/<sha256>.png`，再交 `OcrBatchManager`：串行 `maxConcurrency=1`，逐页 `textRecognition`，每页完成立即释放 PixelMap，结果按 `pageIndex` 写 `results[pageIndex]`，全部完成后 0→N 拼接一次性填入正文；OCR init/release 包住整批；取消释放未处理 PixelMap。
- `ocr_text` 保留原始识别结果不被覆盖，编辑内容写 `body`。图表/公式不做整页结构化：占位符 `[公式/图表: 查看手迹]` + 原始截图兜底。
### 3.3 Android 功能
- 删除手写与 OCR 全部能力；标题/正文/记录者只能虚拟键盘输入（TextInput/TextArea）；UI 静态隐藏手写入口。
### 3.4 存储与同步
- `devices/phone-a/schedules/YYYY-MM-DD.jsonl`，一行一事件：`{id, ts, title, body, ocr_text?, author, done, attachments?:[{sha256,name,pageIndex}], ai_structured?, ai_processed, ocr_time?}`；追加写，绝不重写历史行；附件按 sha256 去重命名。
- 每日 AI 汇总手动触发（列表页底部按钮）：读当天 `ai_processed:false`，允许取消勾选，POST DeepSeek API，载荷 `{date, records:[{id, ocr_time, text}]}`；提示词注入当前时间与时区；结果写 `ai_structured` 并置 `ai_processed:true`，不改 `ocr_text`。定时汇总默认关闭，注释说明鸿蒙 setInterval 会被回收、需长时任务+通知。
- 提醒：`reminderAgentManager` 日历提醒（`ohos.permission.PUBLISH_AGENT_REMINDER`，单应用 ≤30 条），未获批降级 `notificationManager`。文档写清 AGC 开放能力申请 + 手动签名 + 约 8 工作日。
- Git 同步：Web 组件 + `isomorphic-git@1.25.3` + `registerJavaScriptProxy` 文件系统桥 + HTTP 桥（ArkTS `http.createHttp()`，二进制 base64）。只写自己目录，永不 merge；读其他设备目录 fetch 后折叠展示。isomorphic-git 的 dist 必须**真实下载**到 `entry/src/main/resources/rawfile/git/`，并写 `git-bridge.js`（clone/fetch/pull/push/status/log + http/fs 桥）。
### 3.5 UI 页面
主页（日期选择 + 今日待办/全部未完成切换 + 左勾选/中标题+截止/右 📎 手迹）、编辑页、详情页（AI 结构化可编辑 + 原始 OCR 只读 + 截图全屏 + 附件哈希）、设置页（设备标识、仓库 URL、token、AI key、同步按钮、平台信息）。

### 3.6 应用验收（必须真实执行）
- `tools/` 下用 tsc 对 `model/`、`common/` 纯逻辑做类型检查（为 `@ohos.*` 写最小 d.ts stub；模型层不得 import UI 或 @ohos 运行时）。
- `tools/validate-app.mjs` 检查：JSON5 可解析、相对 `import` 路径全部存在、`main_pages.json` 与 pages 目录一致、Android 路径无 OCR/手写引用、所有 page/component 有 `@crossplatform`、rawfile 里 isomorphic-git 文件存在且非空。
- 纯逻辑至少覆盖：JSONL 编解码与折叠、AI 载荷构建、sha256 命名、按 pageIndex 拼接、插件清单 MERGE-only、平台门控。用 Node 运行（把纯逻辑写成可被 Node 导入的形式，或在 `tools/` 里写等价运行时校验，但不得复制粘贴两份实现）。

## 4. 其它交付
- 根 `README.md`、`docs/ARCHITECTURE.md`、`docs/DATA-CONTRACT.md`（Git 目录 + JSONL + RPC）、`docs/VERIFICATION.md`（每条验收标准 ↔ 实际命令与输出，未验证项如实标注）、`devices/{pc-a,pc-b,phone-a}/.gitkeep`、`tools/init-remote-repo.mjs`（生成用户自选 GitHub/Gitee 远端仓库的初始目录）。
- 结束前 `git add -A && git commit`，输出 `git log --oneline -1` 与 `git status --short`。

## 5. 质量红线
- 不许用占位/TODO/模拟实现冒充完成；核心逻辑必须真实可用。
- 本机无法验证的（DevEco 编译、真机 OCR、AGC 权限、Android 设备）如实标注“未验证”并给出验证步骤。
- secret 不得进入任何同步文件/日志/测试 fixture。
- 文档与汇报用中文。
