# DSH 插件（packages/dsh-dots）现状与缺口（2026-11-21 审计）
> 除另标外 `src/x.ts:N` = `packages/dsh-dots/src/x.ts:N`；测试文件实盘 31 个（任务书写 29，按实盘列）。
## 1 已有能力（真实存在，非桩）
- tool 面：`schedule_list` → `src/schedule/tools.ts:147-204` → 真实 → bridge.list 读日程摘要，只读。
- tool 面：`schedule_add` → `src/schedule/tools.ts:207-258` → 真实 → bridge.add 追加 v1 JSONL + pull/commit/push，写。
- tool 面：`schedule_summary` → `src/schedule/tools.ts:261-321` → 真实 → v1 记录拼 AI 载荷/prompt。
- tool 面：`dsh_dots` → `src/schedule/tools.ts:324-411` → 真实 → 跨设备聚合 + DSH 状态，只读。
- tool 面：`schedule_view` → 本包未注册（`src/schedule/tools.ts:413-421` 仅 4 个）；DSH 本体另有同名工具，见 §2；注册入口 `src/schedule/tools.ts:429-445`、`src/index.ts:81-104,167-172`；`cordis.patch.yml:4-6` 只插插件行，不管工具。
- 数据面：`src/schedule/paths.ts:54-56` `devices/${assertDeviceId(deviceId)}/schedules/${assertDateKey(date)}.jsonl`；`src/schedule/dots.ts:290` 同形；`src/schedule/bridge.ts:263-288,350-365` 写/枚举 `devices/**`；`src/schedule/jsonl.ts:66-99,151-157` 编解码。
- 远程面：`src/rpc.ts:677-730` 共 22 action（读 getState/preview*/remoteGetState/chatExportStatus…；写 push/apply/rollback/remote*/chatExport*）；访问状态机 `src/remote/service.ts:170-531`，反代 `src/remote/listener.ts:698`、`src/remote/routes.ts:145`，令牌门 `src/remote/auth.ts:203`；无 `src/remote/rpc.ts`。
- 确认闸：`test/confirm-gate.test.mjs:33-56` 只守 `apply`/`rollback` 的 `confirm:true`（profile patch），不守会话/命令。
- 云端面：`src/chats/readSessions.ts:34,165-209` 读本机 `<.dsh>/sessions/**/session.v4.jsonl.zstd`；`src/chats/exportChats.ts:465-487,399-411` 写仓库 `chats/<id>/{session.jsonl,meta.json}` + `chats/index.jsonl`（仅 5 字段，:52）。
## 2 缺口（按模块）
- `schedule_view` 在 DSH 本体注册（`app.asar:dsh/node_modules/@deepseek-ai/dsh-tool-schedule/lib/index.js:594-595`，`ctx.tools.register(defineTool({name:"schedule_view"...}))`），但属不同域（Host 定时任务/reminder，参数 `id`，基于 `ctx.schedule`，:595-600；同包还注册 `schedule_list`/`create`/`edit`，:518,561,613，与插件同名工具有碰撞风险）；全仓（`packages/**`、`cordis.patch.yml`、`docs/*.md`、README）无注册亦无承诺（仅本文件提及），非"缺失工具"，无需删文案。
- `mod-plugin-git-store`：v1→v2 是重写非重构：`src/schedule/paths.ts:54-56`、`src/schedule/dots.ts:290`、`src/schedule/bridge.ts:263-288` 全写 `devices/**`；v2 唯一路径 `docs/DATA-CONTRACT-v2.md:13,17-33,46-48`（`timeline/<date>/records.json` + 账本 + `timeline/schema.json`），App 已 v2-only（`apps/arkui-schedule/entry/src/main/ets/model/timeline.ts:272-274`）；缺 canonicalRecordLine、assertWritable/schema 门槛、outbox/union/replay、三本账本与原子替换（契约 :198-205,287-305）。
- `mod-plugin-remote-tools`：`instanceList`/`sessionList`/`sessionCreate`/`sessionInfo`/`sessionPrompt`/`sessionEvents`/`sessionLease*`/`grant*` 全缺（`src/rpc.ts:677-730` 无，全包 grep 无）；设计均标「新增」`docs/REMOTE-INSTANCES.md:102-111`、`docs/CLOUD-CHAT-AND-DOTS.md:156-166`；无可吊销 per-tool grant（App 侧已有 `apps/arkui-schedule/entry/src/main/ets/model/instanceGrant.ts:12-16,32-43`），无命令确认卡。
- `mod-plugin-cloud-chat`：无 dots 会话存储；只做「本机会话→chats 导出」（`src/chats/exportChats.ts:240-333,449-512`），`lease:null` 写死（:327）；`readChatIndex` 仅供状态（:346-391），无消费 `chats/` 生成 dots 会话；index 缺 `kind`/`instanceId`（:52 vs `docs/CLOUD-CHAT-AND-DOTS.md:67-86`）；App 读同一文件 `apps/arkui-schedule/entry/src/main/ets/services/chatStore.ets:2,141-177`。
## 3 交叉一致性风险（与 App 侧 v2 契约）
- 键序/字段：插件 `id,ts,title,body,ocr_text,author,done,attachments,ai_structured,ai_processed,ocr_time`（`src/schedule/jsonl.ts:66-89`）≠ App `id,ts,title,body,author,done,media,ocr_text,ai_structured,ai_processed,ocr_time,opened_at,closed_at`（`apps/arkui-schedule/entry/src/main/ets/model/timeline.ts:137-140,239-253`）；`attachments`↔`media`、缺 opened_at/closed_at；须插件改。
- 转义/尾换行：两侧均 `JSON.stringify`（`src/schedule/jsonl.ts:98` / `timeline.ts:252`）→同键序下转义一致；但插件是「一行一对象 + `\n`」JSONL（`jsonl.ts:98,151-157`），v2 是「整文件 JSON 对象、records 元素各占一行、末尾恰好一个 `\n`」（契约 :46,50-61）；容器须插件改。
- open/折叠：插件按 `done` 分未完成（`src/schedule/dots.ts:186-187`）、foldById 同 ts 稳定保序（`src/schedule/jsonl.ts:166-187`）；v2 未完成 iff `closed_at` 缺省、不信 `done`/`open`（`timeline.ts:768-777`、契约 :123-124），同 ts 取规范行 UTF-8 字节序较大者并写 `conflicts.jsonl`（`timeline.ts:555-580`、契约 :99-100）；插件须改。
- 门禁/路径：插件 `pullRebase`（`src/schedule/bridge.ts:268`）与 `settings.branch`（:423）违背 v2 fetch+union 与固定 main（契约 :198-205,305）；无仓库外 outbox（契约 :214-215）；工作副本 `~/.dsh/dots/work/<repoHash>`（`src/engine/paths.ts:257`、`src/schedule/bridge.ts:390-392`）与 App `git-repo/` 非同一目录。
## 4 原开放问题（已结论化）
- 5 项问题已于 2026-11-21 由用户全部拍板并绑定，决定与实现后果见 §6；本节不再保持开放。
## 5 测试面（31 文件；单次运行 tests=454 / pass=453 / fail=0 / skipped=1，skip 因本机代理环境变量）
- schedule：`schedule-jsonl`（v1 编解码/字段序/路径门禁）、`schedule-bridge`（v1 读写桥/pull-rebase/越界/工具注册）、`dots`（跨设备聚合/夹取/坏行/DSH 状态）。
- remote：`remote-model`（6 方式/设置归一/URL）、`remote-auth`（令牌门/cookie/限速）、`remote-qr`（矩阵/罚分/SVG）、`remote-listener`（绑定/反代/WS）、`remote-routes`（token→cookie/401/429/503）、`remote-probe`（自检分级）、`remote-service`（启停/轮换/打码）、`remote-rpc`（8 action/串行队列）、`remote-integration`（真实装配联调）。
- chats：`chats-export`（zstd 解帧/脱敏/index 追加）、`chat-preset`（白名单/反算 deny/隔离 fail-closed）。
- client：`client-module`（ModuleLoader/端点/XSS）、`client-render`（设置面板渲染）、`client-remote-render`（远程面板/令牌不出 DOM）。
- engine：`plugin-merge`（清单 MERGE）、`locale`（双语文案）、`diff`（差异/hunk）、`patch-merge`（patch 合并）、`secrets`（脱敏回填）、`sha-verify`（写后 SHA 回滚）、`state-local`（getState 不联网）、`state-migration`（旧目录搬迁）、`bundle-meta`（包资源/exports）、`gitee-auth`（用户名门禁）。
- engine 写路径：`audit-fixes`（密钥/askpass/repoUrl）、`integration-git`（push→apply→rollback）、`rollback-ux`（diff/回滚两步）、`confirm-gate`（apply/rollback 确认闸）。
## 6 已拍板（2026-11-21，用户确认；不得重开）
- ①dots 对话只存仓库 `chats/`：cloud-chat 读写 `chats/**`，不做插件本地会话库（`docs/CLOUD-CHAT-AND-DOTS.md:59-97`、`src/chats/exportChats.ts:465-487`、`apps/arkui-schedule/entry/src/main/ets/services/chatStore.ets:2,141-177`）。
- ②插件可写 `timeline/**`，但只能复用同一规范实现：写侧复用已做字节一致性校验的读侧规范序列化（`src/timeline/records.ts:18,780`、`test/plugin-timeline-v2.test.mjs:386`；原 v1 写路径 `src/schedule/jsonl.ts:66-99`、`src/schedule/bridge.ts:263-288`、`src/schedule/tools.ts:250-255` 作废），禁止自造 JSONL。
- ③共享单一 clone：路径统一是**存量迁移**——`~/.dsh/dots/work/<repoHash>`（`src/engine/paths.ts:257`、`src/schedule/bridge.ts:390-392`）迁往 App 的 clone（`apps/arkui-schedule/entry/src/main/ets/services/chatStore.ets:2`）；新插件首跑须检测旧 work 目录并移动或重指向。**这是唯一可能让存量用户丢本地未推提交处**（旧 `pullRebase` 改写自身历史 `bridge.ts:268`，v2 禁 rebase 且插件侧无仓库外 outbox：契约 :198-205,214-215,305），迁移须幂等、先核账备份。
- ④schema 引导共用同一首跑逻辑、幂等：`decideFreshStart` 语义（`apps/arkui-schedule/entry/src/main/ets/model/freshStart.ts:32-41`、`src/timeline/records.ts:780`、`docs/DATA-CONTRACT-v2.md:192,287`）；不设插件专属 schema 写入口，首个运行者建 `timeline/schema.json`。
- ⑤`kind`/`instanceId` 由共享序列化器写（`docs/CLOUD-CHAT-AND-DOTS.md:67-86`）：导出端停止硬编码 `lease:null` 与 5 字段索引行（`src/chats/exportChats.ts:52,327,399-411`），改调共享序列化器。
- `schedule_view` 是 DSH 内置工具（见 §2），非插件工具，不在上述写权范围。
- 解禁：git-store 写侧与 cloud-chat 现可开工；remote-tools 保持只读，直到命令确认闸存在（现闸只守 apply/rollback：`test/confirm-gate.test.mjs:33-56`）。
