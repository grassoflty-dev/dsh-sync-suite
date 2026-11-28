# 独立只读评审 — batch b11：`mod-chat-hide`（隐藏式会话删除）

- 评审对象：`main` @ 起始 `8dc939cd750aac2530e974ecbb39bea9e8ae56a8`（起点 `HEAD == origin/main`），工作树中未提交的 18 条路径
- 评审方式：只读 + 自跑门禁 + 内存新鲜 emit 比对；**不运行** `scripts/build.mjs`，不写 `src/**`、`test/**`、`dist/**`，不执行任何 git 写命令，不联网，不用 `hdc`，不输出任何令牌
- 允许写入的唯一仓库文件：本文件；门禁输出只落 gitignored `.tmp/gates-rvch-*.out`
- 立场：**按已定稿设计 `docs/CHAT-DELETE-DESIGN.md` §11/§12 逐项验收实现，不重开设计**；对 10 项逐条给 `no finding` 或文件行号

---

## 0 结论

- **P0 = 0，P1 = 1，P2 = 1。裁决：暂不提交（Block）** —— 纯函数、导出抑制、归属门禁、dist 一致性、断言纪律都成立，但**平板侧没有任何"删除这条会话"的入口，也没有任何代码能写出隐藏行**；`chatHide.ts` 是一套零调用方的孤儿纯逻辑。该模块目前只能被测试手工追加的索引行驱动，不能产生用户可观察的删除动作，与设计 §3「两端都可以写 / 平板窄写通道」和 §12「删除 = 对用户隐藏」不符。
- 十项计数：**no finding 9 项（1/2/3/4/6/7/8/9/10），带发现 1 项（5）**。9 项里没有任何断言放宽、载荷删除、历史改写或「已删除」恢复 UI。
- 可拆分裁决：若 Lead 愿意拆包，**插件侧（折叠 / 导出抑制 / 门禁 / dist）可作为基础设施先提交**；App 侧 `chatHide.ts` 与其文案/失败原因在接通写通道前不得对外宣称"删除可用"。
- 并发漂移（不计入本模块缺陷）：评审期间另一条车道提交并推送了 `5e01aa9 feat(app): 远程实例删除移入设置…`，HEAD 由 `8dc939c` 移到 `5e01aa9`，终点 `HEAD == origin/main == 5e01aa9`；该提交改了 14 个 app 测试文件（起点 status 中显示修改，现已在 HEAD 内），属 `mod-app-instance-delete`，见 `docs/REVIEW-b11-instance-delete.md`。本模块 18 条路径哈希全程未变（§1.3）。

| # | 级别 | 一句话 | 位置 |
| --- | --- | --- | --- |
| P1-1 | P1 | 删除动作没有入口也没有写者：三个会话列表行都只读可点，`chatHide.ts` 零 importer，插件侧无隐藏 RPC，`chatStore.ets` 无写 API | `apps/arkui-schedule/entry/src/main/ets/pages/Chats.ets:319-362`、`.../panes/CloudChatPane.ets:103-132`、`.../model/chatHide.ts:1-86`、`.../services/chatStore.ets:24,147-167`、`packages/dsh-dots/src/rpc.ts` |
| P2-1 | P2 | `lastExportAt` 注释/类型文档说"可见条目里最大"，实现与测试却计入**后来被隐藏**的普通行；行为已锁死，属文档漂移 | `packages/dsh-dots/src/chats/foldChatIndex.ts:41-42,135`、`packages/dsh-dots/src/chats/types.ts:156`、`test/chat-hide-fold.test.mjs:40` |

---

## 1 范围与证据

### 1.1 实际读过的文件（18 条路径全覆盖）

- 插件 src：`src/chats/{foldChatIndex,exportChats,index,types}.ts`、`src/sync/{cycle,syncGate}.ts`（全文 + `git diff HEAD`）；`src/rpc.ts` 只读核对导出 RPC 调用点。
- 插件 test/dist：`test/chat-hide-{fold,export,gate}.test.mjs`、`test/plugin-pending-ownership.test.mjs`（全文 + diff）；`dist/chats/{foldChatIndex,exportChats,index}.js`、`dist/sync/{cycle,syncGate}.js`（新鲜 emit 逐字节比对）。
- App：`model/chatList.ts`（diff + `foldChatIndex`/`parseChatIndex` 全文）、`model/chatHide.ts`、`tools/test/chatHide.test.mjs`（全文）；只读核对 `services/chatStore.ets`、`pages/Chats.ets`、`pages/panes/{CloudChatPane,DotsPane}.ets` 的删除入口是否接线。
- 设计/文档：`docs/CHAT-DELETE-DESIGN.md` §3/§4/§5/§11/§12/§13、`docs/MODULES.md` §7.8/§7.9/§7.10；文风参照 `docs/REVIEW-b11-ff-vp.md`。

### 1.2 门禁（ claimed 复核 + 自跑，全部留在 `.tmp/gates-rvch-*.out`）

| # | 命令 / 来源 | 结果 | 留存 |
| --- | --- | --- | --- |
| G0 | 只读 claimed 输出 | `gates-ch-build.out` 120 B：`BUILD_EXIT=0`（本评审未重跑 build） | 原文件 |
| G1 | 只读 claimed 输出 | `gates-ch-suite-1.out` / `-suite-2.out`：`tests 1136 / pass 1134 / fail 0 / skipped 2`，两次 `SUITE_EXIT=0` —— 与声称一致 | 原文件 |
| G2 | 只读 claimed 输出 | `gates-ch-distcheck.out` 614 B：`DIST-FRESHNESS: 79 files, 0 mismatch`、`DIST-WINDOW: 5`、`DISTCHECK_EXIT=0` —— 与声称一致 | 原文件 |
| G3 | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | `TSC_EXIT=0`（claimed `gates-ch-tsc.out` 19 B 同为 0） | `.tmp/gates-rvch-tsc.out` |
| G4 | `node --test test/chat-hide-{fold,export,gate}.test.mjs test/plugin-pending-ownership.test.mjs` | `tests 29 / pass 29 / fail 0`，exit 0（HF 9 + HE 4 + HG 4 + PO 12） | `.tmp/gates-rvch-plugin.out` |
| G5 | `node --test apps/arkui-schedule/tools/test/chatHide.test.mjs` | `tests 12 / pass 12 / fail 0`，exit 0 | `.tmp/gates-rvch-app.out` |
| G6 | 内存新鲜 emit（`transpileModule`，ES2022/ESNext/esModuleInterop，先用未改的 `src/sync/outbox.ts → dist/sync/outbox.js` 校准逐字节一致） | 校准 `match=true`；5 份目标 dist **5/5 match**，`MISMATCH=0` | `.tmp/gates-rvch-distcheck.out` |
| G7 | `node --test apps/arkui-schedule/tools/test/*.test.mjs`（当前 HEAD `5e01aa9`） | `tests 3392 / suites 479 / pass 3392 / fail 0`，exit 0 | `.tmp/gates-rvch-app-full.out` |

- **claimed `-app.out` 的纠正**：`gates-ch-app.out` 确为 479,204 B，但其尾部是 `APP_SUITE_EXIT=1`，汇总 `tests 3392 / pass 3391 / fail 1`；唯一红项是 `remoteOutcome.test.mjs` 的 D3（`onPageShow` / Home tick 相关），且日志里的测试标题与当前 HEAD 源码 `remoteOutcome.test.mjs:176` 不同 —— 该 gate 产生于并发提交之前。G7 在当前 HEAD 复跑 3392/3392 全绿，**不是本模块缺陷，也不是本模块修好的**。app 侧 `gates-ch-app-tsc.out` 22 B `APP_MODEL_TSC_EXIT=0`。

### 1.3 起始/结束哈希、`git status`、dist 结论

- 起点 `main` / `8dc939c` / `HEAD==origin/main`；终点 `main` / `5e01aa9` / `HEAD==origin/main`。评审期间未执行任何 git 写命令；HEAD 的位移完全来自另一条车道的提交（§0）。
- 18 条路径的 mtime 最晚为 `2026-11-28 09:00:00`，早于评审开始采样时间 `2026-11-28 09:16:50+08:00`；本评审没有写它们，终点重新哈希与起点逐字相同，不存在"中途重建 dist"。

| 路径 | SHA-256（起始 = 结束） |
| --- | --- |
| `packages/dsh-dots/src/chats/foldChatIndex.ts` | `1B71DB989BFEB649D2BFCD870F3B9989D50543283C2DB622305E8A81A1A6C3B7` |
| `packages/dsh-dots/src/chats/exportChats.ts` | `E506FF410AF15673322CD4521B05F75F3FEAEDC7A5251BFDD1E2C2AAA984FDB0` |
| `packages/dsh-dots/src/chats/index.ts` | `EC7E9C963B846FD1BFEABADE5D1BCAA5FA425012EAF4922C27D6328B9D0EC344` |
| `packages/dsh-dots/src/chats/types.ts` | `95B83C0E4DE0D30F448C2A62969E4E4B1F623E1A97FC682A7A536A60FAE3E4C2` |
| `packages/dsh-dots/src/sync/cycle.ts` | `818CB3C61429387F88945514B7CDC2EEDCB1AAD0F097E52026C8E16349B9F5A7` |
| `packages/dsh-dots/src/sync/syncGate.ts` | `0353A8DCD958C019C4263878EE28E7E0099A5964A3DBE9C6FE5FF6B563E54FAF` |
| `packages/dsh-dots/test/plugin-pending-ownership.test.mjs` | `D645FBCB1B1328D9EF5263CB8299A73AFDA8585955284ADA7205A93412AEAF3F` |
| `packages/dsh-dots/test/chat-hide-fold.test.mjs` | `82D6290DFD88A96296D2C89F929CCFD5AC2DF854B2D918802DA57EB9EB6DAAE5` |
| `packages/dsh-dots/test/chat-hide-export.test.mjs` | `2C61CCB4B97131EC9A4BCA7549BF94588EE50EA12CA03806B215DCC61823D988` |
| `packages/dsh-dots/test/chat-hide-gate.test.mjs` | `F3FBF3EA228A8ED245490A67E85925D50ADC42758D482C11EE9AEA47CB15D853` |
| `packages/dsh-dots/dist/chats/foldChatIndex.js` | `56DD8BE8E2723875467E5EA7F457D47A9E0DDC5870B217182877C2A3B4B3D677` |
| `packages/dsh-dots/dist/chats/exportChats.js` | `380DC0683D9A51BDFA60A0EDDC812EFFE5C75D4E4ED0DFDAE020184FD3D390D7` |
| `packages/dsh-dots/dist/chats/index.js` | `845AC9BCE4F95B7E80EE69D354B2EC95D3A8F84F80BDE7CC344E9F19F52EE8DC` |
| `packages/dsh-dots/dist/sync/cycle.js` | `80A0F0F4DC53320E28FEAC14A32B1A9820622D43F08384E3F121F1972B2BA27E` |
| `packages/dsh-dots/dist/sync/syncGate.js` | `CAACDC7A5A3242E44D9710C42B270054FA600E43D81A60B628C1CBB0A51D375F` |
| `apps/arkui-schedule/entry/src/main/ets/model/chatList.ts` | `F453279B8B2CD2F8EDAB97E38E9F75ED16D271121C6EE094C76611A21019AB81` |
| `apps/arkui-schedule/entry/src/main/ets/model/chatHide.ts` | `F21F23F7D40E0E50529D68869D1B6664DEFEA7170144B20B65F5BFCFB5014F93` |
| `apps/arkui-schedule/tools/test/chatHide.test.mjs` | `46F1143B0FF88B8F27EA2FD33E33C8940574ADF93E5BD0FD59FD234E40F8DEF8` |

- **dist 结论**：5 份目标 dist 与源码新鲜 emit 逐字节一致（G6，`MISMATCH=0`），与 claimed `DIST-WINDOW: 5` 对得上；哈希表证明本评审未触碰 dist。

---

## 2 逐项 1–10

### 1 折叠是总函数 — **no finding**

`foldChatIndex.ts:74-148`：`typeof jsonlText === 'string' ? … : ''`（:75）吞掉任意入参；逐行 `trim`、空行跳过（:84-85）；`JSON.parse` 在 try/catch 内，坏行 `badLines++` 后 `continue`（:87-93）；非对象/数组、缺 id、未知 op、坏 id、非法毫秒都只计数（:94-116）。普通行只写 `byId`/`order`，**刻意不碰 states**（:125-135）；op 行只在 `isNewer({ts,seq}, at)` 严格新于当前标记时改状态，`seq=index+1` 做同毫秒决胜（:61-64,117-121）。对抗矩阵由 HF-01…HF-09 与 AH-01…AH-08 覆盖：乱序（HF-04）、同毫秒双序（HF-05 / AH-04）、重复隐藏（HF-03）、unarchive 早于 hide（HF-06 / AH-05）、截断 JSON 与坏行（HF-08 / AH-07）、空输入 `foldChatIndex(undefined/null/42)`（HF-08:103-106）；两端口径一致。`deletedAt` 被记录且参与决胜，符合 §12.3。

### 2 导出抑制真实 — **no finding**

- 选中前过滤：`index.ts:149-178` 显式 id 与默认 `local.slice(0,limit)` 两路都按 `hiddenIds` 剔除，命中的进 `results` 为 `{ok:false, reason:'deleted'}`；`readChatExportStatus` 的 `pending` 也排除隐藏 id（:87-92）。
- TOCTOU 层：`exportChats.ts:362-366` 的 `readHiddenChatIds` 每次重新读盘；`:459-461` 写盘前一次、`:472-476` **紧挨 `appendIndexLine` 前再一次**，命中即 `ChatExportError('deleted')`，`uploadChats` 置 `ok:false`（:489-493），不是 `ok:true`。
- 测试确实证明了"不重发 + 不解除隐藏"：HE-01 在源 zstd 会话仍在的情况下二次 `exportChatsToRepo`，先断言 `readChatIndex(...).entries == []`（`chat-hide-export.test.mjs:94`，**折叠结果被断言**，不是只看"没有新行"），再断言索引字节与隐藏后基线逐字相等（:107）、零新提交（:108）、载荷与 meta 的 sha256 不变（:109-110）、`row.reason === 'deleted'`（:102-103）。HE-02/HE-03/HE-04 分别覆盖显式 id、直接调 `uploadChats`、unarchive 后再导出。

### 3 归属门禁没有放宽其它路径 — **no finding**

`cycle.ts:183-189` 的 `isConfinedTimelinePath` 原文未动；:196-198 `isConfinedSyncPath(p) = p === 'chats/index.jsonl' || isConfinedTimelinePath(p)`，字面量精确相等、不归一化。`git diff HEAD -- src/sync/cycle.ts` 显示只把 :205 与 :244 两处调用从旧谓词换成新谓词；subject 新增一种 `chats: delete <id>` 精确形状（:159-164），尾注、`paths.length>0` 一条没删。`chats/<id>/meta.json`、`session.jsonl`、媒体、`devices/**`、配置载荷、绝对/盘符/反斜杠/`..`/`//`/`.bak` 仍拒，由 `chat-hide-gate.test.mjs:33-47` HG-02 表驱动钉住；混合路径仍判 `untrusted`（HG-03:57-62）。`syncGate.ts` 只有注释改动。

### 4 合并没有回退已提交的 outbox-purge — **no finding**

独立复核：工作树 `src/sync/cycle.ts` 中 `PURGE_FAILED_AFTER_MS` / `isPurgeableFailedIntent` / `selectPurgeableIntents` 共 **10 处**（:86,453,454,466,467,469,483,504,507,1387），HEAD 版本同样 **10 处**；`git diff HEAD -- src/sync/cycle.ts` 中含 `purge/PURGE/Purge` 的删除行 **0 条**。全 diff 仅 28 增 / 7 删，删的 7 行都是旧文案或旧谓词引用（逐行读过），没有 purge 逻辑。

### 5 平板路径 — **P1-1（`apps/arkui-schedule/entry/src/main/ets/model/chatHide.ts:1-86`）**

- 确认文案本身**正确**：`chatHide.ts:10-16` 逐字给出「删除这条会话？」「删除后不再显示在会话列表；云端记录不会被抹除。」「目前没有恢复入口，删除后应用内无法找回。」「删除」「取消」；AH-09（`tools/test/chatHide.test.mjs:83-101`）还禁止了「可恢复/撤销/彻底/永久」，实测 12/12 绿。`hideLineOf`（:44-54）只产出 `{"op":"archive","id":…,"deletedAt":<ms>}`，`appendHideLine`（:60-69）只追加、旧字节为前缀，`hideReasonOf`（:71-86）四阶段中文原因诚实：prepare/write 明说"没有写入任何内容"（下一次读不会隐藏），commit 明说"隐藏行已写入但提交未完成；列表以索引为准"（下一次读按索引确实隐藏，但不是成功），push 明说"本机已隐藏，其它设备稍后同步才会隐藏"——没有假成功。
- **但没有任何调用方**：全 App 搜索 `chatHidePlanOf|hideLineOf|appendHideLine|hideReasonOf|删除这条会话` 只命中 `chatHide.ts` 自身与 `chatHide.test.mjs`；三个会话列表行 `pages/Chats.ets:319-362`、`pages/panes/CloudChatPane.ets:103-132`、`pages/panes/DotsPane.ets:195` 都是整行 `onClick(openDetail)` 的只读行，没有 `bindMenu` / `ActionSheet` / 确认弹层；`services/chatStore.ets` 无 `writeFile/appendFile/commit/push`；插件 `src/rpc.ts` 无隐藏/删除 RPC。因此**没有 per-chat 删除入口（也没有 bulk 入口），没有写者，写入失败的四条中文原因不可达**。这是功能缺口，不是文案问题；详见 §3 P1-1。

### 6 App 读侧 — **no finding**

`chatList.ts:328-409` 是 App 侧唯一的折叠实现，普通行永不碰 states（:384-391），op 行 `(ts,seq)` 严格决胜（:357-376），可见条目排除隐藏 id（:393-400），隐藏 id 进 `hiddenIds`（:401-408）；`parseChatIndex`（:411-414）直接委托 `foldChatIndex`，没有第二套折叠。`chatStore.ets:24,167` 只用 `parseChatIndex` 投影列表，隐藏项不进 `listChats` 的 `entries`。全 App 无会话「已删除」视图/恢复手势（`Index.ets` 的「已删除 · 撤销」属于日程记录 undo，与 chats 无关）。插件与 App 各有一份实现是平台隔离的必然结果（ArkTS 不能 import 插件 TS），单一侧内没有重复实现。

### 7 断言纪律 — **no finding**（台账见 §4）

`plugin-pending-ownership.test.mjs` 只有一处等严 retarget（旧谓词 → 新谓词）与一条新增更严断言，负例表与尾注/subject 条件一条未删。三个插件 `chat-hide-*.test.mjs`（17 例）与 App `chatHide.test.mjs`（12 例）都是全新文件，按定义**不可能删除任何既有断言**。起点 status 中其它 app 测试文件的修改属于并发提交 `5e01aa9` 的 instance-delete 车道，现已在 HEAD 内，不属于本模块；本模块 scope 内既有断言删除数 = 0、放宽数 = 0。

### 8 dist vs src — **no finding**

G6 用 TS `transpileModule` 做内存新鲜 emit：先用未改的 `outbox.ts` 校准 `match=true`，再比 5 份目标 dist，`foldChatIndex / exportChats / chats/index / sync/cycle / sync/syncGate` 全部 `match=true`、`MISMATCH=0`（`.tmp/gates-rvch-distcheck.out`），字节数与 dist 逐一相等。§1.3 的起止 SHA-256 与 mtime 证明没有中途重建。

### 9 诚实性 — **no finding**

18 条路径中没有"已验证 / 真机已过"之类声明：`foldChatIndex.ts` 只说"这是全函数"（可由 HF/AH 证明），`exportChats.ts:356-360` 只描述读盘策略，`chat-hide-export.test.mjs` 的标题都是夹具级陈述（"源会话仍在"指测试造的 sessionsRoot）。没有任何注释或测试暗示恢复 UI 存在；`chatHide.ts:14` 明说「目前没有恢复入口」，`:6` 明说载荷/历史不动，代码里也确实没有任何删除载荷的 API（`src/chats/**` 无 `unlink/rm`）。`docs/MODULES.md:853` 把两条行为路径明确列为 `unverified`，没有冒充已验。

### 10 Lead 的能力缺口 — **陈述（非 finding）**

两个仓库都没有 `chats/index.jsonl`（实测 `~/.dsh` 与 `itwillclaude` 全树 `chats/index.jsonl` 计数均为 0），因此**两条行为路径（隐藏后列表消失、隐藏后二次导出不复活）都是 `unverified`**；使其可验证的唯一前置是：在电脑上用 `chatExportOne`/`chatExportAll`（`rpc.ts:1360`/`:1358`）发布一条会话，使仓库出现 `chats/index.jsonl` 与 `chats/<id>/`、平板列表出现该会话，然后执行一次隐藏并再导出一次（`docs/MODULES.md:853` 同口径）。当前模块连"执行一次隐藏"都做不到（P1-1），所以这条前置现在还不充分。

---

## 3 发现清单

| 级别 | 位置 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1-1 | `apps/arkui-schedule/entry/src/main/ets/model/chatHide.ts:1-86`；`pages/Chats.ets:319-362`、`pages/panes/CloudChatPane.ets:103-132`、`pages/panes/DotsPane.ets:195`；`services/chatStore.ets:24,147-167`；`packages/dsh-dots/src/rpc.ts` | 全仓搜索只有模型与测试命中 `chatHidePlanOf/hideLineOf/appendHideLine/hideReasonOf/删除这条会话`；三处会话行只有 `onClick(openDetail)`；`chatStore` 无写 API；插件无隐藏 RPC；`isChatDeleteSubject`（`cycle.ts:159-164`）只**识别** `chats: delete <id>`，没有任何生产者 | 用户无法从平板（也无法从桌面端经本模块）删除一条会话；确认文案、typed 失败原因、隐藏行格式全部不可达；模块只剩"读侧认识隐藏行"与"导出器抑制"两套被动能力 | 补 **per-chat** 删除入口（长按/行尾按钮 → `chatHidePlanOf()` 确认 sheet → 追加 `hideLineOf` 到 `chats/index.jsonl` → commit/push，subject `chats: delete <id>` + v2 尾注 + 仅该索引路径），把 `hideReasonOf` 四阶段文案接到界面；此后才允许宣称 §12 的删除能力 |
| P2-1 | `packages/dsh-dots/src/chats/foldChatIndex.ts:41-42` 与 `:135`；`src/chats/types.ts:156`；`test/chat-hide-fold.test.mjs:40` | 文档注释/类型说 `lastExportAt` 是"所有可见条目里最大的 updatedAt"，但 :135 在普通行上无条件更新（含后来被隐藏的 id），HF-02:40 还把"隐藏后重导出仍刷新 lastExportAt"钉成断言 | 仅文档与实现漂移，不改变行为；将来有人按注释"修正"代码会红测试并误导 `chatExportStatus` 的展示语义 | 把注释与 `ChatIndexFold`/`ChatIndexSnapshot` 字段说明改成"所有普通行里最大的 updatedAt（含后续被隐藏的 id）"，保留 HF-02 断言 |

---

## 4 断言变更台账

| 文件:行 | 断言 / 守卫 | 旧 → 新 | 分类 |
| --- | --- | --- | --- |
| `packages/dsh-dots/test/plugin-pending-ownership.test.mjs:373` | PO-07 no-loosening 的收容谓词字面量 | `cycleSrc.includes('commit.paths.every(isConfinedTimelinePath)')` → `…every(isConfinedSyncPath)` | **等严**：被守卫的调用点未变，谓词精确多一个字面量；同块负例表、`force: false`、无 `force:true` 三条逐字保留 |
| `packages/dsh-dots/test/plugin-pending-ownership.test.mjs:374` | 新白名单字面量守卫 | 无 → `assert.equal(cycleSrc.includes("p === 'chats/index.jsonl'"), true)` | **更严** |
| 同文件 `:370-372` | 两行说明性注释 | 无 → 注释 | 非断言 |
| `packages/dsh-dots/test/chat-hide-fold.test.mjs`（HF-01…HF-09，9 例） | 折叠全函数对抗矩阵 | 全新文件 | **新增**；不可能删除既有断言 |
| `packages/dsh-dots/test/chat-hide-export.test.mjs`（HE-01…HE-04，4 例） | 二次导出不复活 / TOCTOU / 显式 id / unarchive 兼容 | 全新文件 | **新增** |
| `packages/dsh-dots/test/chat-hide-gate.test.mjs`（HG-01…HG-04，4 例） | 白名单正例 / 拒绝表 / 混合路径 untrusted / 文案同步 | 全新文件 | **新增** |
| `apps/arkui-schedule/tools/test/chatHide.test.mjs`（AH-01…AH-12，12 例） | App 折叠 + 文案 + 隐藏行 + typed 原因 | 全新文件 | **新增** |
| `apps/arkui-schedule/tools/test/*.mjs` 其余文件 | 起点 status 显示 14 个已改 | 相对起点 `8dc939c` 的改动全部来自并发提交 `5e01aa9`（instance-delete 车道）；相对终点 HEAD 本模块零改动 | 车道漂移，**不计入本模块台账**，见 `docs/REVIEW-b11-instance-delete.md` |

**总账（本模块 18 路径）**：既有断言删除 **0**；放宽 **0**；等严 retarget **1**；更严 **1**；新增用例 **29**（插件 17 + app 12；定向实跑 29/29 + 12/12 全绿）。**新文件按定义不可能删除任何东西**——这是分类依据，不是推测。

---

## 5 `unverified`

1. **两条行为路径**：`chats/index.jsonl` 在两个仓库都不存在（实测计数 0），"隐藏后列表消失"与"隐藏后二次导出不复活"都只在夹具里跑过，均 `unverified`；可验证条件见 §2 第 10 项。
2. **跨设备可见**（§12.2 第 2 条）：A 删 → 推送 → B 同步后 B 列表消失，未验证；且当前没有 A 能删（P1-1）。
3. **平板窄写通道**：commit/push 失败、无网、`chats/index.jsonl` 只读等真实失败分支的界面表现未验证（四条中文原因没有调用方）。
4. **真机观感**：确认 sheet 在平板上的布局/触感、警示色、按钮命中，`unverified`（设备不可用，§7.9）。
5. **桌面反射**（§13.2）：把索引隐藏集合反射到 DSH 自带归档数组属于别的模块，未实现、未验证；中间态窗口如实存在。
6. **claimed `-app.out`**：文件本身是提交前快照（`exit 1` / 1 红），当前 HEAD 的 G7 已 3392/3392 绿；两者都不构成本模块证据。

---

## 6 冻结建议

- **裁决：Block（暂不按"隐藏式会话删除"提交）。** 先补 P1-1 的 per-chat 入口 + 窄写通道 + 四阶段中文失败接线；P2-1 只需改注释/类型文档，不动行为与 HF-02。
- 若 Lead 选择拆包：插件侧 6 个 src + 5 个 dist + 4 个测试可作为"折叠/导出抑制/归属白名单"基础设施先提交（1/2/3/4/8 全部 `no finding`，定向 29/29、emit 5/5、tsc 0）；但**不要把 `chatHide.ts` 与确认文案说成已交付的用户能力**，也不要在冻结记录里写"删除已可用"。
- 冻结前必须（a）由原车道补写通道并给出"同一 sessionsRoot 二次导出仍隐藏"的夹具 + 至少一次真实 `chats/index.jsonl` 上的隐藏写；（b）在电脑上用 `chatExportOne`/`chatExportAll` 发布一条会话后走一遍 §7.9 的三步；（c）不要因另一条车道的并发提交或 `gates-ch-app.out` 的旧红而回滚本模块，也不要把它们的绿算到本模块头上。
- 本评审未修改任何源、测试、dist 或 git 状态；唯一写入是本文件，门禁输出仅落 `.tmp/gates-rvch-*.out`。
