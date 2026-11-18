# 稳定性批（C）失败模式清单

> 基线：仓库 `dsh-sync-suite`，分支 main，HEAD `379fcc5`（行号只对这一版负责）。
> 状态：overlay `applied=false`（`node apps/arkui-schedule/tools/overlay.mjs status` 原样输出见 §7）。
> 本文**只写不改**：没有改任何代码/文档，没有装依赖，没有跑构建、没有跑全量测试、没有 git add/commit。
> 用途：这是后续加固的输入。每行 = `文件:行号 | 现象 | 当前行为 | 判定 | 处理`，`判定` 只用 `已加固`（附证据行）/ `半加固`（说清关口）/ `未加固`（说清后果）三种，不写「应该没问题」。

---

## 1. 扫描方法（可复算）

### 1.1 扫了哪些文件

| 批次 | 目录 / 文件 | 关注点 |
| --- | --- | --- |
| 同步 | `apps/arkui-schedule/entry/src/main/ets/services/GitSyncService.ets`、`services/syncController.ets`、`services/gitMerge.ets`、`model/syncGuard.ts`、`model/syncError.ts` | fetch/clone/push 的超时、busy 复位、迟到回执 |
| 桥 | `apps/arkui-schedule/entry/src/main/resources/rawfile/git/git-bridge.js`（2283 行） | `createHttp()`、`HTTP_TIMEOUT_MS`、`readFile` 空串歧义 |
| AI | `services/deepseek.ets`、`services/aiFallbackRunner.ets`、`services/summaryStore.ets`、`model/aiFallback.ts`、`model/aiRequest.ts`、`model/aiProvider.ts` | 超时链、重试、无流式 |
| 远程 | `pages/RemoteControl.ets`、`components/settings/RemoteSection.ets`、`packages/dsh-dots/src/remote/listener.ts`、`remote/probe.ts` | `-173`、`isMainFrame` 过滤、101 反代 |
| 重入 | `components/settings/SyncSection.ets`、`pages/Settings.ets`、`pages/Index.ets`、`components/ExportImportPanel.ets`、`services/exportService.ets` | 按钮 `enabled`、`busy` 置位时机、`importInFlight` |
| 崩溃恢复 | `services/draftStore.ets`、`model/draft.ts`、`components/RecordEditorView.ets`、`pages/Edit.ets`、`services/scheduleStore.ets`、`components/GitBridgeHost.ets` | AppStorage vs 磁盘、`.tmp` 残留、返回确认 |
| 存储/权限 | `services/attachmentStore.ets`、`services/exportService.ets`、`services/scheduleStore.ets`、`services/draftStore.ets` | 空 `catch`、静默降级 |

排除项：`apps/arkui-schedule/entry/build/**`（构建中间产物）、`oh_modules/**`、`node_modules/**` 全部未纳入结论。

### 1.2 用的命令

```powershell
# 基线
git rev-parse --short HEAD          # 379fcc5
node apps/arkui-schedule/tools/overlay.mjs status

# 超时常量 / spinner 复位 / 忙标志 全量定位（grep 工具，非 Get-Content）
#   pattern: TIMEOUT|Timeout|timeout|_MS\b
#   pattern: busy|loading|enabled\(|aiBusy|syncBusy
#   pattern: -173|describeLoadError|onErrorReceive|ErrorCard

# 空 catch（含只有注释的）全量扫描：直接 node 遍历，判「去掉注释后方法体为空」
$js = @'
const fs=require('fs'),path=require('path');
const roots=['apps/arkui-schedule/entry/src/main/ets','packages/dsh-dots/src'];
const out=[];
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
  if(e.isDirectory())walk(p); else if(/\.(ets|ts|js)$/.test(e.name))scan(p);}}
function scan(f){const s=fs.readFileSync(f,'utf8');const re=/catch\s*(?:\([^)]*\))?\s*\{/g;let m;
  while((m=re.exec(s))){let i=re.lastIndex,depth=1;while(i<s.length&&depth>0){if(s[i]==='{')depth++;else if(s[i]==='}')depth--;i++;}
    const body=s.slice(re.lastIndex,i-1);
    const stripped=body.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'').trim();
    if(stripped.length===0){const line=s.slice(0,m.index).split('\n').length;out.push(f.split(path.sep).join('/')+':'+line);}}}
roots.forEach(r=>{if(fs.existsSync(r))walk(r);});
console.log('total',out.length);console.log(out.join('\n'));
'@
node -e $js        # 结果：total 77（app 37 + packages 40），逐条见 §6

# 行号对照（抽查用）
$js = @'
const fs=require('fs');
const B='apps/arkui-schedule/entry/src/main/ets/';
for(const [f,n] of [[B+'pages/Index.ets',1514],[B+'services/GitSyncService.ets',2037]]){
  const L=fs.readFileSync(f,'utf8').split('\n');console.log(f+':'+n+'  >>  '+L[n-1].trim());}
'@
node -e $js
```

> 注意：本机 PowerShell 的 `Get-Content` 会把 UTF-8 中文显示成乱码，所以**看文件一律用 read/grep 工具或 `node -e` 读**，没有改过任何文件编码。

### 1.3 行号复核

本清单里每条 `文件:行号` 都用同一段 `node -e` 打印过原文（见 §1.2 最后一段），§8 抽了 5 条原样对照。路径一律相对仓库根；为表格可读，正文里的短名（如 `GitSyncService.ets:380`）指的是上表列出的完整路径。

---

## 2. 断网 / 切网

| 文件:行号 | 现象 | 当前行为 | 判定 | 处理 |
| --- | --- | --- | --- | --- |
| `apps/arkui-schedule/entry/src/main/ets/services/GitSyncService.ets:2037` | 断网点「立即同步」，按钮长时间停在「同步中…」 | 每次桥调用挂一个 `REQUEST_TIMEOUT_MS=60000`（同文件 `:380`）的 `setTimeout`，到点 reject 并 `pending.delete`（`:2038`）；**60 秒内没有任何中间进度**，也没有取消入口 | 半加固（上限有、反馈无；`syncBusy` 期间按钮文字固定「同步中…」，见 `SyncSection.ets:405`） | P1：页面层在 `syncBusy` 期间显示「已等待 Ns」，`GitSyncService` 暴露 `cancelPending()` 由用户点「取消」触发 |
| `apps/arkui-schedule/entry/src/main/ets/services/GitSyncService.ets:1115` | 用户看到「同步失败」，但工作副本其实还在被写 | 超时后 `pending` 已删，桥里 clone/fetch 仍在跑；它完成时 `onEvent` 查不到 id，直接 `return` 静默丢弃（`:1115-1117`） | 半加固（不会崩、不会错乱，但「失败」与「磁盘状态」不一致，用户重试会叠一次） | P1：`onEvent` 命中不到 id 时记一条「迟到回执」并让状态行显示「上一次操作已在后台完成」，同时禁止超时后立刻重试 |
| `apps/arkui-schedule/entry/src/main/resources/rawfile/git/git-bridge.js:62` | 桥内「网络请求超时（90 秒）」这句话永远不会出现 | `HTTP_TIMEOUT_MS=90000`，而外层 `callBridge` 只有 60000 → 90s 分支在正常路径上是死代码，永远是外层先报 | 半加固（有界，但两个超时语义不一致，排查时会被误导） | P2：把桥内超时改成等于外层的一半（如 25s）并在 `describeBridgeFailure` 里区分「单请求超时」与「整体超时」 |
| `apps/arkui-schedule/entry/src/main/ets/services/deepseek.ets:290` | AI 断网卡住不返回 | `Promise.race`（`:297-300`）+ `request.timeoutMs`（默认 30s，`aiRequest.ts:225`）+ `connectTimeout 20s/readTimeout 120s`（`:287-288`），且 `finally` 里 `httpRequest.destroy()`（`:313-320`）释放连接 | 已加固（证据：`:290` race、`:307-312` 归一成 `AI_STATUS_TIMEOUT`、`:317` destroy） | P2：无需改；建议把 120s 的 `readTimeout` 与整体 30s 的关系写进注释（现在是不可达值） |
| `apps/arkui-schedule/entry/src/main/ets/services/aiFallbackRunner.ets:253` | 备用源多、超时被调大时，「整理中…」可挂几分钟 | 每个源一次 `Promise.race`（`:253-261`）+ 串行 `while`（`:434-486`），但**没有总预算**；`AI_MAX_TIMEOUT_MS=180000`（`aiRequest.ts:41`）× 源数即为最坏时长 | 半加固（每步有界、整体无界） | P1：`runWithFallback` 增加 `totalBudgetMs`（建议 90s），超预算直接判失败并给出「已尝试 N 个源」 |
| `apps/arkui-schedule/entry/src/main/ets/pages/RemoteControl.ets:333` | 切网/弱网时内嵌页一片空白，没有任何「正在连接」提示 | `Web({src, controller})` 只挂了 `onErrorReceive`（`:338`）与 `onHttpErrorReceive`（`:345`），**没有 `onPageEnd`、没有加载超时看门狗**；`phase` 进入 `ready` 后就不再变（`:127`），空白只能等 Chromium 自己报错（真机约 50s，见 `docs/VERIFICATION.md:917`） | 半加固（最终会出错误卡片，但等待期无反馈、无重试入口） | P1：加 `onPageEnd` + 15s 看门狗，超时直接置 `loadError='连接超时（15s）：请检查电脑是否在运行、地址端口是否一致'` 并显示错误卡片 |
| `apps/arkui-schedule/entry/src/main/ets/components/settings/RemoteSection.ets:354` | 断网时点「打开远程控制」必然进白屏 | 按钮只判 `.enabled(this.remoteUrl.trim().length > 0)`，不探活、不看上次连通性 | 未加固（后果：用户把「白屏 50s」当成 App 坏了） | P1：点击前用一次 3s 的 `GET /__dsh_remote/health`（免令牌）做前置探测，失败即提示并保留「仍然打开」 |

---

## 3. 超时（每处外部调用的上限）

| 文件:行号 | 现象 | 当前行为 | 判定 | 处理 |
| --- | --- | --- | --- | --- |
| `apps/arkui-schedule/entry/src/main/ets/services/GitSyncService.ets:380` | 一次 pull/push 最长 60s，到点必须失败 | `REQUEST_TIMEOUT_MS=60000`，用于 `callBridge`（`:2037`）与 `callBridgeJson`（`:742`）两处；超时后只删内存 entry，**不 cancel 底层** | 半加固（限时但不释放真实资源） | P1：见 §2 第 1、2 行，与「取消 + 迟到回执」一起做 |
| `apps/arkui-schedule/entry/src/main/resources/rawfile/git/git-bridge.js:1136` | clone 大仓库时每个 HTTP 请求各自计时，但不会重试 | 每个请求一个 90s 定时器，超时 reject `E_HTTP`；`isomorphic-git` 的 lsRemote/fetch/push **全部走这一个通道，没有一次重试** | 半加固（有上限、无重试；弱网一次抖动就得整轮重来） | P1：在桥的 `createHttp` 外层加「同一 URL 最多 2 次、指数退避 1s/3s」，只对幂等 GET（`info/refs`）开 |
| `apps/arkui-schedule/entry/src/main/ets/services/GitSyncService.ets:2008` | 宿主侧真发 HTTP 的那一层 | `connectTimeout: 15000`、`readTimeout: 45000`（`:2008-2009`），`finally` 里 `safeDestroy(request)`（`:2022`/`:2025`） | 已加固（证据：`:2008-2009` 双超时、`:2022` 与 `:2025` 两条分支都 destroy） | P2：无需改 |
| `apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets:923` | 「测试连接」不会转圈到天荒地老 | `PROBE_TIMEOUT_MS=10000` 同时给 `connectTimeout` 与 `readTimeout`（`:923-924`），`finally` 里 `request.destroy()`（`:929-935`），外层 `connectionBusy` 在 `finally` 复位（`:971-975`） | 已加固（证据同上；重入另见 §5 第 10 行） | P2：无需改 |
| `apps/arkui-schedule/entry/src/main/ets/services/deepseek.ets:68` | 单次 AI 请求的「读超时」永远用不到 | `CONNECT_TIMEOUT_MS=20000`、`READ_TIMEOUT_MS=120000`（`:68-69`），但整体 race 用的是 `request.timeoutMs`（默认 30s）→ 120s 只在用户把超时调到 120000 以上才可达 | 半加固（配置项之间的隐含依赖没写清） | P2：`aiRequest.ts` 解析时把 `timeoutMs` 下限钳到 `CONNECT_TIMEOUT_MS + 1000`，或在设置页把 120s 读超时文案标成「仅当总超时大于 120s 时生效」 |
| `apps/arkui-schedule/entry/src/main/ets/model/aiProvider.ts:468` | 拉模型列表卡住 | `Promise.race` + `AI_MODELS_TIMEOUT_MS=15000`（`:113`），`finally` 里 `clearTimeout`（`:483`），失败归一成 `MODELS_STATUS_TIMEOUT` | 已加固（证据：`:468-483`） | P2：无需改 |
| `packages/dsh-dots/src/remote/listener.ts:959` | PC 侧等上游 101 不会无限挂 | `upstreamReq.setTimeout(15_000, ...)` 主动 destroy（`:959-961`）；上游拒绝升级回 502（`:1019`）；上游不可达回 502（`:1023`） | 已加固（证据：`:959`、`:1019`、`:1023`） | P2：无需改 |
| `packages/dsh-dots/src/remote/probe.ts:33` | PC 侧自检的每一项都有上限 | loopback 1500ms、listener 2000ms、v6 connect 2500ms、command 4000ms、防火墙规则 12000ms、WS 探测 8000ms（`:33-38`） | 已加固（证据：`:33-38` + `defaultConnect` 的 `socket.setTimeout`（`:145`）） | P2：无需改 |

> 说明：本应用**没有流式（SSE / chunked）AI 调用**——全仓 `grep stream|SSE|on('data'` 在 `ets/` 下只命中附件分块（`attachmentStore.ets:237`）与桥的 zip 分块（`GitSyncService.ets:713`）。所以「AI streaming 断流卡住」这一类失败模式在当前实现里不存在，对应风险已由上面的「非流式单请求超时」覆盖。

---

## 4. 内嵌 Web 的 WS 失败（`ERR_WS_UPGRADE(-173)`）

既有结论（不推翻，只补 App 侧代码证据）：`docs/ROADMAP.md:366`（真机「通过（带缺陷）」+ `-173`）、`docs/ROADMAP.md:379-390`（WS 缺陷定位为 **ArkWeb 在 WS 握手时不带 DSH 会话 cookie**）、`docs/RESTART-CHECKLIST.md:63`（`sidecar-ws-101` PASS 而 App 仍 `-173` → 判 ArkWeb 侧）、`docs/VERIFICATION.md:882`（内嵌页渲染出完整 DSH UI，非白屏，但左下角持续「连接异常，刷新重试」）。本节只回答「App 侧现在对 `-173` 做了什么」。

| 文件:行号 | 现象 | 当前行为 | 判定 | 处理 |
| --- | --- | --- | --- | --- |
| `apps/arkui-schedule/entry/src/main/ets/pages/RemoteControl.ets:192` | `-173` 会显示什么？ | `describeLoadError` 只对 `-102` 写了人话（`:194-196`），其余码一律 `` `页面加载失败（${code}）：${detail}` ``（`:197`）→ `-173` 的用户可见文案是「页面加载失败（-173）：<Chromium 英文 info>」，没有一句「WebSocket 没握上」 | 半加固（有码可查，但没有可行动的解释） | P1：`describeLoadError` 补 `-173` 分支：「实时连接没建立（-173）：页面能开但不会自动刷新，可点『用浏览器打开』」 |
| `apps/arkui-schedule/entry/src/main/ets/pages/RemoteControl.ets:340` | **`-173` 根本不会让错误卡片弹出来** | `onErrorReceive` 第一句就是 `if (!event.request.isMainFrame()) return;`（`:340-342`）；WS 升级失败不是主文档加载失败 → `loadError` 保持空串 → `ErrorCard` 不渲染（`:352`）。用户看到的是页面正常 + DSH 自己的「连接异常，刷新重试」 | 未加固（后果：App 完全看不到这个失败，等于把已知 P1 缺陷藏在页里） | P1：改用 `onSslErrorEventReceive`/`onConsole` 之外的可行路径——在 `onPageEnd` 后注入一段 `new WebSocket(wsUrl)` 探针（5s 超时），失败即置 `loadError='实时连接未建立（-173）'` |
| `apps/arkui-schedule/entry/src/main/ets/pages/RemoteControl.ets:352` | 有没有「改用浏览器打开」的自动降级？ | `ErrorCard` 里两个按钮常备（「重试」`:300`、「用浏览器打开」`:309`，后者走 `openInBrowser()` `:160-173`），但卡片只在 `loadError` 非空时出现；**没有任何自动降级**，也不会主动提示用户去点 | 半加固（出口存在、触发条件缺） | P1：与上一行同一个探针联动；探针失败时卡片标题改成「页面能开，但实时连接不通」，并把「用浏览器打开」提到第一个按钮 |
| `apps/arkui-schedule/entry/src/main/ets/pages/RemoteControl.ets:143` | 点「重试」对 `-173` 没用 | `refresh()` 清 `loadError` 后 `controller.refresh()`（`:148`）；`-173` 本来就不产生 `loadError`，刷新后仍是同一个死 WS | 未加固（后果：用户被引导做一次无效操作，且没有任何反馈说明为什么没用） | P2：`-173` 命中后把「重试」改成「重新握手（清 cookie 再加载）」，或直接降级成提示用浏览器打开 |
| `packages/dsh-dots/src/remote/listener.ts:959` | 会不会是 PC 侧 hang 导致的？ | 不是：服务端 101 反代有 15s 握手超时、拒绝升级与不可达都回 502（`:1019`/`:1023`），双向 teardown（`:998-1009`）；`remote-listener.test.mjs:608` 有 101 + 双向 echo 用例 | 已加固（证据：`:959-962`、`:1019`、`:1023`；测试 `packages/dsh-dots/test/remote-listener.test.mjs:608`） | P2：无需改；排查时优先看 App 侧 cookie |

---

## 5. 重入（连点 / 中途再点）

| 文件:行号 | 现象 | 当前行为 | 判定 | 处理 |
| --- | --- | --- | --- | --- |
| `apps/arkui-schedule/entry/src/main/ets/components/settings/SyncSection.ets:412` | 连点「立即同步」 | `.enabled(!syncBusy && webReady && authBlocker().length === 0)`（推送按钮同款在 `:423`，换 `pushBlockedReason()`） | 已加固（证据：`:412`、`:423`；`syncBusy` 在 `Settings.ets:1667` 于任何 await 之前置位） | P2：无需改 |
| `apps/arkui-schedule/entry/src/main/ets/services/GitSyncService.ets:1005` | 忙判定只在 UI 层，服务层没有闸 | `precondition(busy)` 的 4 个调用点（`:778`、`:849`、`:965`、`:1022`）全部传 `false` → `model/syncGuard.ts:57` 的 `E_BUSY` 分支在服务层**永不触发**；`syncGuard.test.mjs:62` 测的是纯函数，给了「已防连点」的假信心 | 半加固（关口：只要绕过按钮（`syncController.pullOnStartup`、页面自动动作）就没有任何保护） | P1：`GitSyncService` 增加 `private inFlight: boolean`，所有公开操作入口用 `precondition(this.inFlight)`，`finally` 复位 |
| `apps/arkui-schedule/entry/src/main/ets/services/syncController.ets:249` | 启动 pull 还没回来，回前台又拉一次 | 节流只看 `lastPullAt`，而 `lastPullAt` 在 pull **完成之后**才写（`:277`）；在飞的这段时间里两次调用都能通过节流 → 双发 | 半加固（重复拉取本身幂等，代价是双倍流量 + 两条互相覆盖的结果） | P1：`pullNow` 里加 `starting/inFlight` 标志（复用 `:163` 的 `starting` 语义），在飞时直接返回 `skipped:true` |
| `apps/arkui-schedule/entry/src/main/ets/pages/Index.ets:614` | 快速双击同一行的勾选框 | `toggleDone` 全同步、没有 in-flight 闸；两次点击各 `appendRecord` 一行，且 `next.ts = nextTsSameDate(target.ts)`（`:628`）都基于**同一个** `target.ts` → 可能写出两行 ts 完全相同的记录 | 半加固（读侧 `foldById` 取最新，用户看不到错乱；代价是多一行 + 索引多建一次） | P2：`toggleDone` 里加 300ms 同 id 去抖，或在 `nextTsSameDate` 之后做「同 id 同 ts 已存在则不写」 
| `apps/arkui-schedule/entry/src/main/ets/pages/Index.ets:850` | 连点「开始汇总」→ 双发 AI 请求（花双份钱） | 按钮 `.enabled(!this.aiBusy)`（`:1675`），但 `runAi()` 顶部**没有** `if (this.aiBusy) return`，而 `this.aiBusy = true` 在 `:883`，前面隔着一个 `await settingsStore.load`（`:871`）→ 第二次点击可以在这段 await 里进来 | 半加固（窗口是毫秒级，但一旦命中就是双份计费 + 两次 `appendRecord`） | P2：`runAi` 第一行加 `if (this.aiBusy) return;`，或把 `aiBusy = true` 提到函数最前 |
| `apps/arkui-schedule/entry/src/main/ets/pages/Index.ets:558` | 「生成今日汇总」连点 | 函数第一行就是「`aiBusy` 为真或当天没有记录就直接 return」，`aiBusy=true` 也在任何 await 之前（`:562`） | 已加固（证据：`:558`、`:562`、`:600-601` finally 复位） | P2：无需改 |
| `apps/arkui-schedule/entry/src/main/ets/services/exportService.ets:457` | 导入连点 | 模块级 `importInFlight` 闸（`:457-475`，`finally` 复位 `:474`），并发时直接回「正在导入中，请稍候」；`ExportImportPanel.ets:80/90` 另有 `state.busy` 双保险；`canConfirmImport`（`model/exportImport.ts:1250`）要求「dry-run 过 + 有新增 + 非法为 0」 | 已加固（证据：`:457`、`:474`；测试 `exportImport.test.mjs:1242`「并发闸：在飞时直接拒绝（不排队）」） | P2：无需改 |
| `apps/arkui-schedule/entry/src/main/ets/services/exportService.ets:228` | 大区间导出时界面卡死（不是双发，是 ANR 风险） | `exportSchedules` 全程同步（`readAll` → 拼文本 → 写文件），`handleExport` 是同步调用（`Settings.ets:1045`）；`state.busy=true`（`Settings.ets:1036`）在同一个同步栈里根本没机会渲染 | 半加固（重入被 JS 单线程天然挡住，但用户感知是「卡住」） | P1：导出改成 `setTimeout(...,0)` 分片或搬进 Worker，先在 UI 上把 busy 渲染出来再干活 |
| `apps/arkui-schedule/entry/src/main/ets/pages/Index.ets:1514` | 单列下拉刷新理论上可能永远转圈 | 单列分支 `this.onPullRefresh().then(...)` **没有 `.catch()`**（`:1514-1516`），而主从分支写了 `.catch`（`:1488-1490`）；`refreshing` 只在 then 里复位 | 半加固（当前 `onPullRefresh` 内部不 reject：`syncController.pullNow` 全程 try/catch，`reload`/`loadSummary` 也各自吞异常 → 靠「下游永不 reject」这个隐式契约撑着） | P1：补 `.catch(() => { this.refreshing = false; })`，别依赖下游契约 |
| `apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets:940` | 连点「测试连接」 | `if (this.connectionBusy) return;`（`:940`）+ `finally` 里复位（`:971-975`） | 已加固（证据：`:940`、`:971-975`） | P2：无需改 |

---

## 6. 崩溃恢复（重进能恢复到哪一步）

| 文件:行号 | 现象 | 当前行为 | 判定 | 处理 |
| --- | --- | --- | --- | --- |
| `apps/arkui-schedule/entry/src/main/ets/components/RecordEditorView.ets:123` | 编辑正文时进程被杀（系统回收 / 闪退）→ 未保存的文字**全部丢失** | 未保存内容只写进 `AppStorage`（`:116-123`，`aboutToDisappear` 里写内存键 `editor.draft`）；磁盘上的 `draftStore` 只服务手写板，**文本编辑从不落盘** | 未加固（后果：重进只能回到磁盘上的旧记录，「重进能恢复到哪一步」= 恢复到上一次保存，刚才打的字一个字都没有） | P1：`RecordEditorView` 在输入去抖 1s 后调用 `draftStore.saveDraftSync('editor-' + recordId, json)`，并在 `bootstrap()` 里优先读磁盘草稿 |
| `apps/arkui-schedule/entry/src/main/ets/components/RecordEditorView.ets:132` | 从记录 A 切到记录 B，A 的未保存内容被销毁 | `restoreDraft` 先 `AppStorage.setOrCreate(DRAFT_KEY, '')` 清键（`:132`），**之后**才比对 `recordId`（`:135`）；不匹配就 `return false` —— 此时 A 的草稿已经没了 | 半加固（同一条记录来回切没问题；跨记录切必丢） | P1：改成「先比对、后清键」，或直接把键改成 `editor.draft.<recordId>` 按记录分槽 |
| `apps/arkui-schedule/entry/src/main/ets/pages/Edit.ets:47` | 编辑页点返回（或系统返回手势）→ 无任何确认 | `onBack: () => { router.back(); }`（`:47-49`），页内没有 `onBackPress`、没有脏检查；`RecordEditorView` 的脏状态只通过回调通知父页面 | 未加固（后果：单列/手机形态下，误触返回 = 内容直接丢，且没有撤销） | P1：`Edit` 实现 `onBackPress`，脏时弹「放弃修改？」（复用 `Index.ets:405` 的 `guardEditor` 文案） |
| `apps/arkui-schedule/entry/src/main/ets/pages/Index.ets:405` | 主从布局的确认只在「宽屏」生效 | `guardEditor` 只被 `onRowTap`（`:437`）与 `onNewTap`（`:450`）调用，两处都在 `if (!this.masterDetail) { ... return; }` **之后** → 单列形态（`:432-436`）直接 `openDetail` 不确认 | 未加固（后果：窄屏用户切列表就丢右栏编辑；与上一行是同一个用户损失的不同入口） | P1：与 `Edit.onBackPress` 一起做，单列分支在跳转前也走一次脏检查 |
| `apps/arkui-schedule/entry/src/main/ets/services/draftStore.ets:55` | 手写草稿保存在「删旧 → 改名」之间被杀 | `saveDraftSync` 先 `fs.unlinkSync(path)`（`:55`）再 `fs.renameSync(tmpPath, path)`（`:57`）；`readDraftSync`（`:72-82`）**只读正式文件，不认 `.tmp`** → 这个窗口里被杀，旧稿没了、新稿只剩 `.tmp`，重进 = 草稿空 | 半加固（窗口很小，但「重进恢复到哪一步」= 一步都恢复不了，且目录里的 `.tmp` 永远不会被清理） | P1：改成「写 `.tmp` → `rename` 覆盖」（鸿蒙 `renameSync` 对已存在目标的行为要先在真机确认），或启动时扫 `.tmp` 做一次恢复/清理 |
| `apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets:1097` | dry-run 之后、点「确认导入」之前被杀 | `pendingImport` 只是页面成员（`:1097`），不落盘；重进 = 没有待确认计划，选文件那一步得重来（`:1120-1125` 会明确提示「没有待确认的导入计划」） | 半加固（不丢数据，丢的是操作进度；提示是明确的） | P2：把计划（或至少文件 URI + 计数）存进 preferences，重进时提示「上次有未完成的导入」 |
| `apps/arkui-schedule/entry/src/main/ets/services/exportService.ets:539` | 确认导入执行到一半被杀 | `writePlan` 按日期逐个文件追加（`:539`），**没有事务**：可能写了一半；但重放同一份文件是安全的——写盘前会重读本机再 reconcile（`:517`），已写入的 id 变成 skipped/conflict 而不会重复追加 | 半加固（能恢复到「重放一遍即可」，恢复不到「精确回滚到导入前」） | P2：在结果里返回 `partial: true` + 已写文件清单，让用户知道重放是安全的 |
| `apps/arkui-schedule/entry/src/main/ets/services/summaryStore.ets:132` | AI 汇总写到一半失败 | `generate` 在 `read-failed`/`write-failed` 时直接抛中文 Error（`:132-133`），旧汇总保持不变；`Index.generateSummary` 的 catch 里再把旧汇总读回来继续显示（`Index.ets:592-599`） | 已加固（证据：`:132-133` + `Index.ets:594-598`） | P2：无需改 |

---

## 7. 存储满 / 权限失败（本机 IO）

| 文件:行号 | 现象 | 当前行为 | 判定 | 处理 |
| --- | --- | --- | --- | --- |
| `apps/arkui-schedule/entry/src/main/ets/services/scheduleStore.ets:322` | 磁盘满时保存一条日程 | `appendLineSync` 失败被包成 `` `写入日程失败（${path}）：...` ``（`:319-323`）向上抛，`Index.toggleDone` 的 catch toast（`Index.ets:632-634`），`RecordEditorView` 保存同理 | 已加固（明确报错；证据：`:322`） | P2：无需改；可把 toast 升级成「重试」按钮 |
| `apps/arkui-schedule/entry/src/main/ets/services/draftStore.ets:137` | 草稿写不进去 | `writeTextSync` 抛 `` `写入草稿失败（${path}）` ``（`:136-137`），调用方 toast | 已加固（明确报错；证据：`:137`） | P2：无需改 |
| `apps/arkui-schedule/entry/src/main/ets/services/exportService.ets:296` | 导出写文件失败 | `return failed(`写入导出文件失败：${describeError(error)}`)`（`:295-297`），面板把 `ok:false` 的 reason 显示出来（`Settings.ets:1049-1051`） | 已加固（明确报错；证据：`:296`） | P2：无需改 |
| `apps/arkui-schedule/entry/src/main/ets/services/attachmentStore.ets:397` | 截图/插图写不进去 | `writeFileSync` 抛 `` `写入附件失败（${path}）` ``（`:396-397`） | 已加固（明确报错；证据：`:397`） | P2：无需改 |
| `apps/arkui-schedule/entry/src/main/ets/services/attachmentStore.ets:43` | 手写页回传的附件清单 JSON 坏了 → **附件静默消失**（`parseAttachmentList`，同族纯逻辑在 `model/attachmentMerge.ts`） | `parseAttachmentList` 解析失败 `catch { return list; }`（`:41-45`），返回空数组；调用方拿到 `[]` 当「本来就没有附件」处理，**没有任何提示** | 未加固（静默丢数据：用户看到的记录少了截图，且无从得知） | P1：返回值加 `{ list, dropped }`，`dropped > 0` 时在记录详情页显示「N 个附件解析失败」，并保留原始 JSON 到 `filesDir/quarantine` |
| `apps/arkui-schedule/entry/src/main/ets/services/GitSyncService.ets:1160` | 权限/读错误时，桥把「读失败」当成「空文件」 | `readFileBase64` 的 `catch` 里 `return ''`（`:1159-1160`），与「空文件」不可区分；桥侧靠「再查一次存在性」区分（`git-bridge.js:873-879`），但**文件存在却读不出来**（权限/句柄耗尽）时，isomorphic-git 会把空内容写进 blob → 提交里出现被清空的文件 | 半加固（关口：只有「exists 为真 + 读失败」这一组合才中招；会污染提交内容，且不报错） | P1：`readFileBase64` 失败时返回 `null`（或抛 `E_FS`），桥侧把 `null` 一律转 `EACCES`，宁可不提交 |
| `apps/arkui-schedule/entry/src/main/ets/services/scheduleStore.ets:354` | 派生索引失败 | `notifyAppend` 显式 `catch { }`（`:353-356`），注释写明「索引是派生数据，失败由下次自愈重建」，日志由钩子自己打 | 已加固（有意静默，且有自愈路径；证据：`:348-357` 注释 + `openIndexStore.reconcile`） | P2：无需改 |
| `apps/arkui-schedule/entry/src/main/ets/components/GitBridgeHost.ets:38` | 隐藏 Web 永远不触发 `onPageEnd` 时，同步永久不可用 | 只有 `onPageEnd`（`:38-45`，且 `delivered` 只许一次）和 `onErrorReceive`（`:46-48`）两个出口，**没有超时看门狗** → 页面卡在加载中时 `syncController.isReady()` 永远 false，设置页按钮永远灰着（文案是「同步内核尚未就绪」） | 半加固（状态可解释、不崩，但没有自动重试，用户只能重启 App） | P1：`GitBridgeHost` 挂 10s 看门狗，超时后 `onFail('同步内核加载超时')` 并允许一次 `refresh()` 重试 |

### 7.1 空 `catch` 全量清单（77 处，逐条可核对）

扫描口径：`catch` 块去掉 `/* */` 与 `//` 后方法体为空（含只有注释的），AST 级扫描脚本见 §1.2。App 侧 37 处、`packages/dsh-dots/src` 40 处。

**apps/arkui-schedule/entry/src/main/ets（37）**

```
components/RecordEditorView.ets:184      model/aiRequest.ts:346
model/exportImport.ts:998               model/pageCapture.ts:169
model/pageCapture.ts:187                pages/Index.ets:597
pages/Settings.ets:932                  pages/Settings.ets:1506
pages/Settings.ets:1526                 services/aiFallbackRunner.ets:232
services/aiFallbackRunner.ets:289       services/chatStore.ets:93
services/deepseek.ets:317               services/deepseek.ets:622
services/draftStore.ets:64              services/gitMerge.ets:233
services/gitMerge.ets:256               services/gitMerge.ets:283
services/GitSyncService.ets:697         services/GitSyncService.ets:820
services/GitSyncService.ets:884         services/GitSyncService.ets:941
services/GitSyncService.ets:1165        services/GitSyncService.ets:1189
services/GitSyncService.ets:1218        services/GitSyncService.ets:1363
services/GitSyncService.ets:1500        services/GitSyncService.ets:1683
services/GitSyncService.ets:1720        services/GitSyncService.ets:1796
services/GitSyncService.ets:1974        services/GitSyncService.ets:2057
services/GitSyncService.ets:2078        services/openIndexStore.ets:180
services/scheduleStore.ets:354          services/syncController.ets:139
services/syncController.ets:268
```

**packages/dsh-dots/src（40）**

```
chatPreset/isolate.ts:207               chatPreset/isolate.ts:347
chats/exportChats.ts:407                chats/readSessions.ts:202
client.js:660                           client.js:684
client.js:703                           client.js:3561
client.js:3563                          engine/git.ts:111
engine/git.ts:147                       engine/git.ts:698
engine/paths.ts:76                      engine/paths.ts:167
engine/paths.ts:194                     engine/paths.ts:207
engine/paths.ts:315                     engine/paths.ts:338
engine/restore.ts:109                   engine/settings.ts:209
engine/snapshot.ts:173                  index.ts:91
index.ts:99                             remote/listener.ts:527
remote/listener.ts:537                  remote/listener.ts:725
remote/listener.ts:1016                 remote/probe.ts:139
remote/probe.ts:397                     remote/probe.ts:696
remote/service.ts:357                   remote/store.ts:52
remote/store.ts:114                     remote/urls.ts:427
remote/urls.ts:432                      rpc.ts:181
rpc.ts:255                              rpc.ts:271
schedule/aiPayload.ts:105               schedule/aiRequest.ts:79
```

按性质分三类（不是每条都要改）：
- **有意静默**（派生数据 / 清理 / 关闭句柄）：`scheduleStore.ets:354`、`openIndexStore.ets:180`、`draftStore.ets:64`、`GitSyncService.ets:1165/1189/1218`、`deepseek.ets:317`、`aiFallbackRunner.ets:289/232`、`syncController.ets:139/268`、`Settings.ets:932/1506/1526`、`Index.ets:597` —— 这些在 §7 各表里已按「明确报错 / 有意降级」判过。
- **需要复查**（吞掉后用户侧无任何反馈，且不是清理类）：`pages/Index.ets:597`（AI 失败后重读旧汇总再失败）、`RecordEditorView.ets:184`（读作者名）、`model/exportImport.ts:998`、`gitMerge.ets:233/256/283`、`GitSyncService.ets:820/884/941/1363/1500/1683/1720/1796/1974/2057/2078`。这批统一 P2 复核：不是「改掉 catch」，而是确认每条都在上游有等价的可读提示。
- **`packages/dsh-dots/src` 40 处**：属于 PC 侧插件（Node 进程），不在本次「App 稳定性批」的修复范围，故只登记行号、本轮不判处理（P2 交插件批次）。

> 追加说明：除空 `catch` 外，还有一类**非空但静默降级**更危险——`attachmentStore.ets:41-45` 的 `catch { return list; }`（§7 第 5 行）。这类不满足「空方法体」的扫描口径，只能靠人工读，建议下一轮补一条 ESLint/结构测试规则：`catch` 块里只允许 `return` 常量或重抛。

---

## 8. 证据边界

### 8.1 来自静态阅读（static）

除下面 8.2 / 8.3 明确标注的以外，本清单所有「当前行为」与判定都来自**静态阅读 + 行号对照**（HEAD `379fcc5`）。没有跑构建、没有跑全量测试、没有真机。

### 8.2 有现成测试覆盖（可以引用的证据）

| 结论 | 测试文件:行号 |
| --- | --- |
| 忙时优先报 `E_BUSY`（**只测纯函数**，服务层没接上，见 §5 第 2 行） | `apps/arkui-schedule/tools/test/syncGuard.test.mjs:62` |
| 并发导入闸「在飞时直接拒绝、退出复位」 | `apps/arkui-schedule/tools/test/exportImport.test.mjs:1242` |
| 「双击」端到端不会重复物理追加 | `apps/arkui-schedule/tools/test/exportImport.test.mjs:1189` |
| 第 2 个日期写失败时 `ok:false` 且只含已写文件（对应 §6 第 7 行的「半加固」） | `apps/arkui-schedule/tools/test/exportImport.test.mjs:1056` |
| 草稿坏 JSON → `corrupt` 不抛 | `apps/arkui-schedule/tools/test/draft.test.mjs:277` |
| 草稿写读往返（`filesDir/drafts` 语义） | `apps/arkui-schedule/tools/test/draft.test.mjs:424` |
| clone 失败后隔离半成品，再次 pull 不会卡死 | `apps/arkui-schedule/tools/test/git-bridge.test.mjs:517` |
| pull 遇 404 报 `E_HTTP` 且 HEAD 不变（不丢本地提交） | `apps/arkui-schedule/tools/test/git-bridge.test.mjs:689` |
| 失败分类：超时/网络/429/5xx 可换源，确定性 4xx 不换 | `apps/arkui-schedule/tools/test/aiReliability.test.mjs:119` |
| 同 id 更新也是「追加」而非覆盖历史行 | `apps/arkui-schedule/tools/test/serviceInvariants.test.mjs:105` |
| WS 反代 101 + 双向 echo（对应 §4 最后一行「服务端已加固」） | `packages/dsh-dots/test/remote-listener.test.mjs:608` |

**这些测试覆盖的是纯函数/结构契约，不能证明 UI 层的 spinner 会复位**——两者别混着引用。

### 8.3 必须真机（unverified，禁止写「已验证」）

`hdc list targets` 在本机**根本无法执行**（命令不存在，比「`[Empty]`」更弱）：

```
hdc : 无法将"hdc"项识别为 cmdlet、函数、脚本文件或可运行程序的名称。请检查名称的拼写，如果包括路径，请确保路径正确，然后再试一次。
    + CategoryInfo          : ObjectNotFound: (hdc:String) [], CommandNotFoundException
[exit code: 1]
```

所以下列结论一律标 **unverified**，只能等有设备 + hdc 的会话再补：

1. `-173` 在 ArkWeb 上的实际触发条件与频率（`docs/ROADMAP.md:379-390` 的 cookie 假设仍是推断）。
2. 断网时「同步中…」到底停多少秒、用户是否等得住（`GitSyncService.ets:380` 的 60s 是代码上限，实际由网络栈决定）。
3. 弱网下内嵌页空白到错误卡片的真实时长（`docs/VERIFICATION.md:917` 记的是「约 50s」，那是端口丢弃 SYN 的场景）。
4. 「导出阻塞 UI」是卡顿还是 ANR（`exportService.ets:228` 同步执行的量级取决于记录条数）。
5. `draftStore` 把「先删后改名」换成「改名覆盖」在鸿蒙上是否可行（§6 第 5 行的方案前提）。
6. 杀进程后编辑器文本草稿的丢失是否 100% 复现（§6 第 1 行的推理链是「只写 AppStorage」→「进程死即丢」，逻辑上确定，但真机表现仍建议实测一次）。

---

## 9. P1 加固排序（用户可见损失 × 发生概率，前 8 条）

每条都给一个**不依赖真机、能写成 node 用例**的验收判据（沿用仓库现有 `tools/test/structureGuards.test.mjs` 那种「读源码断言结构 / 读纯函数断言输出」的风格）。

| 序 | 失败模式 | 为什么排这个位置 | 验收判据（node 用例） |
| --- | --- | --- | --- |
| 1 | 未保存编辑只存内存（§6 第 1、2 行） | 损失=全部打字内容；概率=高（切网、来电、系统回收都算），且**完全无恢复路径** | 断言 `components/RecordEditorView.ets` 源码中出现 `draftStore.saveDraftSync` 与 `draftStore.readDraftSync`；且 `restoreDraft` 里「比对 recordId」的行号早于「清空 DRAFT_KEY」的行号 |
| 2 | `-173` 完全不进错误卡片（§4 第 2、3 行） | 损失=内嵌页实时功能整个不可用；概率=100%（已知必现缺陷），且用户拿不到任何指引 | 构造一个假 `OnErrorReceiveEvent`（`isMainFrame()` 返回 false、`code=-173`）喂给 `RemoteControl` 的判定逻辑，断言 `loadError` 非空且文案含「-173」与「浏览器打开」 |
| 3 | 批量导出阻塞 UI（§5 第 8 行） | 损失=长时间无响应（可能 ANR）；概率=中高（导出整个月必现） | 断言 `handleExport` 不再同步调用 `exportSchedules`，而是 `setTimeout`/任务队列；并断言 `exportImport.busy` 在 `exportSchedules` 之前已置 true |
| 4 | 服务层没有忙判定（§5 第 2 行） | 损失=双发同步（互相覆盖结果、双倍流量）；概率=中（绕过按钮的路径有 3 条：启动 pull、回前台、自动动作） | 断言 `GitSyncService` 的 4 个公开操作入口都调 `precondition(this.inFlight)`（源码扫描：`precondition(true)` 出现次数 ≥ 1，且不再是全 `false`）；配一条纯函数用例：`checkSyncPrecondition({busy:true,...}).code === 'E_BUSY'` |
| 5 | 单列下拉刷新无 `.catch`（§5 第 9 行） | 损失=spinner 永转（需杀进程）；概率=低，但一旦命中用户只能重启 | 结构断言：`pages/Index.ets` 中 `onPullRefresh()` 的每个 `.then(` 后面都跟一个 `.catch(`（计数相等） |
| 6 | 手写草稿「先删后改名」窗口（§6 第 5 行） | 损失=整页笔迹；概率=低（窗口毫秒级，但保存频率高） | 用 fake-fs 跑 `saveDraftSync`：让 `renameSync` 抛错，断言**旧草稿仍然存在**且 `.tmp` 被清理；或断言 `readDraftSync` 在正式文件缺失时会读 `.tmp` |
| 7 | 附件清单解析失败静默成空（§7 第 5 行） | 损失=截图静默消失且无提示；概率=低（需要坏 JSON），但用户无从发现 | 纯函数用例：`parseAttachmentList('{bad json')` 返回 `dropped === 1` 且 `list.length === 0`；再断言调用方在 `dropped > 0` 时会写一条可见提示 |
| 8 | 远程页无加载看门狗（§2 最后两行、§7 最后一行） | 损失=白屏/永久灰按钮；概率=中（弱网、电脑休眠） | 断言 `RemoteControl` 与 `GitBridgeHost` 都存在一个 `setTimeout(...)` 看门狗，且超时分支会写 `loadError` / 调 `onFail`（源码扫描两个文件里 `setTimeout` 各 ≥ 1） |

---

## 10. 六类计数汇总

| 类别 | 已加固 | 半加固 | 未加固 | 行数 |
| --- | --- | --- | --- | --- |
| 2. 断网/切网 | 1 | 5 | 1 | 7 |
| 3. 超时 | 5 | 3 | 0 | 8 |
| 4. 内嵌 Web WS（-173） | 1 | 2 | 2 | 5 |
| 5. 重入 | 4 | 6 | 0 | 10 |
| 6. 崩溃恢复 | 1 | 4 | 3 | 8 |
| 7. 存储满/权限 | 5 | 2 | 1 | 8 |
| **合计** | **17** | **22** | **7** | **46** |

最危险的 3 条（按上表 P1 排序）：① 未保存编辑只存内存 → 打字内容整段丢失；② `-173` 不进错误卡片 → 内嵌页实时功能全废且无指引；③ 服务层无忙判定 → 双发同步互相覆盖。
