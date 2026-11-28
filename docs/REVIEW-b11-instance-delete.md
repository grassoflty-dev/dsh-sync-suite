# 独立只读评审 — batch b11：`mod-app-instance-delete-in-settings`（设置页删除实例）

- 评审对象：`main` @ `0eef9662dd94a242f2c514da95ccb0b18285acf4`（`HEAD == origin/main`），工作树中一条未提交车道（app 侧）
- 评审方式：只读 + 自跑允许门禁 + 读既有 `.tmp` 证据；**不运行** `build-harmony.ps1` / ArkTS 重建，不用 `hdc`、不联网、不执行任何 git 写命令、不打印任何 token
- 允许写入的仓库文件：本文件；本次自跑门禁输出只落 gitignored 根 `.tmp/gates-rvid-*.out`（`git check-ignore` 已证实）
- 立场：**攻击契约本身**；(a)–(h) 八条探针逐条给结论，不复读车道汇报

---

## 0 结论

- **P0 = 0，P1 = 2，P2 = 3。裁决：Block（冻结前必须修两条 P1）**。
- 一句话裁决：**复活、聊天面、入口唯一性、守卫台账、Rule-9 构建证据都成立**；但「彻底删干净」在授权表上只做到吊销、行仍带悬空 `instanceId`，且删除后保活的 `InstancesPane` 没有刷新信号、会把已删实例继续摆在首页 —— 两条都直接落到用户给的契约条款上，不能按 Freeze-with-fixes 放行。
- 另记一条**非本模块缺陷的并发漂移**（§1.3，不计入计数）：评审期间 `packages/dsh-dots/dist/sync/cycle.js` 由另一车道修改为 `M`，起始 status 中不存在；本评审的 tsc/validate 不触及该路径。

| # | 级别 | 一句话 | 位置 |
| --- | --- | --- | --- |
| P1-1 | P1 | 删除只把该实例授权写 `revokedAt`，**不删行**；已删实例的授权行仍以悬空 `instanceId` 留在 `instance-grants.json`，与「全部 grant 行删除 / 不留孤儿授权」正面冲突 | `apps/arkui-schedule/entry/src/main/ets/model/instanceGrant.ts:666-706`、`.../instanceGrantStore.ets:141-152`、`.../pages/SettingsInstances.ets:86`、`.../tools/test/instanceDelete.test.mjs:116` |
| P1-2 | P1 | 删除后 `Home.onPageShow()` 只推进日程面板的 `showTick`；`InstancesPane` 没有 tick、`onPageShow()` 自述永不触发，保活内存里仍留已删行（含 token），首页列表与设置摘要都可能显示已删实例 | `apps/arkui-schedule/entry/src/main/ets/pages/Home.ets:244-251,531-534`、`.../pages/panes/InstancesPane.ets:14-16,168-172,203-232`、`.../pages/Settings.ets:167-173,255-265` |
| P2-1 | P2 | 注释写「彻底删干净」、文案把「它的授权记录」列进损失项，但行是按吊销历史保留的，属于对授权删除的轻微夸大 | `.../pages/SettingsInstances.ets:7`、`.../model/instanceDelete.ts:32-33` |
| P2-2 | P2 | 多处 retarget 后标题/注释仍是「四行」「四行根页与三个子页」「当前 InstancesPane 有删除」，与实测断言不一致 | `.../tools/test/settingsSummaryResolve.test.mjs:58`、`.../tools/test/settingsIaGuards.test.mjs:119`、`.../tools/test/uiTokens.test.mjs:577`、`.../tools/test/instanceDelete.test.mjs:427` |
| P2-3 | P2 | 确认页只清 `remoteUrl` / `remoteLastOk`，`settingsStore.remoteToken` 原样留盘；不会复活（墓碑 + 地址清空挡住），但「记录含 token 彻底删干净」字面上仍留副本 | `.../pages/SettingsInstances.ets:89`、`.../services/settingsStore.ets:723-876` |

---

## 1 范围与证据

### 1.1 实际读过的文件

- 由 `git status --porcelain=v1` 自行枚举本模块改动面：`services/{instanceStore,instanceGrantStore}.ets`、`model/{instanceGrant.ts,instanceDelete.ts(新)}`、`pages/{SettingsInstances(新),Instances,Settings}.ets`、`pages/panes/InstancesPane.ets`、两份 `main_pages.json`、`tools/test/instanceDelete.test.mjs(新)` 以及 11 份 retarget 的守卫；逐份读正文或对 HEAD 做 `git diff`。提示清单之外的 `docs/MODULES.md` / `packages/dsh-dots/src/sync/cycle.ts` 不属本模块，只作为并发漂移记录。
- 只读旁证：`model/{instanceSeed,remoteUrl}.ts`、`services/settingsStore.ets`（`:700-889`）、`pages/{Home,RemoteControl}.ets`、`pages/panes/DotsPane.ets`、`services/remoteAnnounceRefresh.ets`、既有 `.tmp` 证据文件。

### 1.2 门禁复跑（全部 `Tee-Object` 到仓库根 gitignored `.tmp/`）

| # | 命令（工作目录：仓库根） | 结果 / tail | 留存 |
| --- | --- | --- | --- |
| G1 | `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` | **exit 0**，无诊断 | `.tmp/gates-rvid-tsc.out`（末行 `EXIT=0`） |
| G2 | `node apps/arkui-schedule/tools/validate-app.mjs` | **exit 0**，`✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 643 条、main 静态 import 891 条、页面 13 个、rawfile/git 2 个文件）` | `.tmp/gates-rvid-validate.out`（末行 `EXIT=0`） |
| G3 | `node --test apps/arkui-schedule/tools/test/instanceDelete.test.mjs` | `tests 10 / suites 3 / pass 10 / fail 0 / skipped 0 / duration_ms 1139.2658`，exit 0；含 D-01…D-09 与 X-chat-surface | `.tmp/gates-rvid-instanceDelete.out` |
| G4 | 既有 Rule-9 完整构建日志复核（未重跑） | 见 §2(g) | `apps/arkui-schedule/.tmp/build-mod-app-instance-delete-in-settings.out` |
| G5 | 既有 D-06 改前红证据复核 | UTF-16LE + ANSI，`tests 1 / pass 0 / fail 1`，`AssertionError: InstancesPane 不得保留删除 affordance：label: '删除'`，`true !== false` | `apps/arkui-schedule/.tmp/gates-id-prefix-D06.txt`（2,628 B） |

- `tsc` 的唯一副作用是 app `tools/.build/`（tsconfig `:21-22`），未写 `src/**` / `test/**` / `dist/**`；未运行 `build-harmony.ps1`。

### 1.3 起始/结束哈希、`git status`、并发漂移

- 分支/HEAD 起止相同：`main` / `0eef9662dd94a242f2c514da95ccb0b18285acf4`；`git rev-parse origin/main` 同值；评审中未执行任何 git 写命令。
- **起始 status**：20 条 `M`（含 `docs/MODULES.md`、`packages/dsh-dots/src/sync/cycle.ts`）+ 9 条 `??`（含本模块 3 个新文件与其它车道文档/测试）。
- **结束 status**：起始条目全部仍在，另多出 `M packages/dsh-dots/dist/sync/cycle.js`。该路径不在 app `tsconfig.json` 的 `include`（只含 `entry/src/main/ets/model|common`）里，本评审的三个命令都不可能写它；判定为评审期间的**并发车道漂移**，不计入本模块缺陷，但说明「起止 status 完全一致」这一证据不成立。
- 指定文件 SHA-256（**起始 = 结束，逐字节未变**）：

| 文件 | SHA-256 |
| --- | --- |
| `services/instanceStore.ets` | `EF21E517A1BEEAF4360DFFBB80C8ADB4A1D7CC5191B78BFA05E1A4FF22D8A5CF` |
| `services/instanceGrantStore.ets` | `13547539A2B1EB521C5C2BCAA4623B9E0C976C2113B6137173EE3FAE9C5AAE18` |
| `model/instanceGrant.ts` | `3DE039C7A2F150179A9FDF400BCD384FAB529A11F366288361D464AB6A6B85A1` |
| `model/instanceDelete.ts` | `ED6C5456BB1DC765B5AC2059AFF394D621EBF3D5293F511AF3D9F6270ABEDC42` |
| `pages/SettingsInstances.ets` | `80CB0FF83B57B9D4AE1B5861536F5FF0006A8429357587ADEE8EFAB4481BA41F` |
| `pages/Instances.ets` | `8AFFF99759ED5DFA37507F2CFEBB3693D0B882CD1E6D4FEAA3A7142CC792DE47` |
| `pages/Settings.ets` | `EC18C0145A7A02D5B255A31626878D462D8CC2F46033783986FBA7C2CFEC5A4E` |
| `pages/panes/InstancesPane.ets` | `B1143394B48CA65A38DF32B88F52CF701CF2DD935072679627E97302B3F20950` |
| `entry/src/main/resources/base/profile/main_pages.json` | `D0E514E1C48590BD09F883BC2D804E4AEB25865C0151CD4392B8B019CD4B9158` |
| `entry/src/harmony/resources/base/profile/main_pages.json` | `2F70615264A637312139B5A084680E6099F88CC4CE3208C866FC7A815E1B64A2` |
| `tools/test/instanceDelete.test.mjs` | `88EAC13242065A82DE9A8EC41F8C2E01EA85248877FF018F6EE1A61276EC0264` |

---

## 2 逐项 (a)–(h)

### (a) 复活 — **no finding**

1. **真实播种路径**：`instanceStore.ensureSeeded()`（`instanceStore.ets:193-201`）先把 `legacy` 过 `suppressLegacyForTombstones(legacy, this.loadTombstones())` 再交 `seedInstances()`；后者只用 `legacyUrl()`（`instanceSeed.ts:56-67`）取 `remoteUrl`，空了才取 `decodeLastOk(remoteLastOk)`，与墓碑侧的 `legacySeedIdOf()`（`instanceDelete.ts:165-183`）**同源同序**，因此不存在「墓碑挡 A、播种用 B」的错位。
2. **墓碑内容**：`remove()`（`instanceStore.ets:265-279`）用 `tombstoneIdsOf(removed.id, removed.url)`（`instanceDelete.ts:155-162`）同时记实例 id 与真实 URL 派生 id；`legacySeedIdOf` 归一后的 id 命中就把 `remoteUrl`/`remoteLastOk` 一并置空（`:189-204`）。`deleted-instances.json` 是独立持久键（`:53,85-107`），不污染实例信封。
3. **镜像清空**：确认页还做 `settingsStore.save({ remoteUrl: '', remoteLastOk: '' }, context)`（`SettingsInstances.ets:89`）；`save()` 是 patch（`settingsStore.ets:723-876`），其它设置逐字不动，不会顺手 wipe 配置。
4. **仍打开的页面回写 lastOk 也挡得住**：`RemoteControl.recordLastOk()`（`RemoteControl.ets:608-620`）在 `onPageEnd` 会把已删 URL 写回 `remoteLastOk`，但墓碑仍在，下一次 `ensureSeeded()` 依旧抑制；这是墓碑比「清镜像」更强的地方。
5. **测试驱动的是真函数**：`instanceDelete.test.mjs:216-288` 从真实 `.ets` 截出 `InstanceStore` 类体与 helper，用 TypeScript `transpileModule` + 假 `AppStorage`/`PersistentStorage` 执行**生产方法本体**，D-05（`:314-357`）先证明控制组确实播种成功，再在同一份 prefs 上 `remove()` → 新建 store → `ensureSeeded(legacy)` 返回 `[]`，最后「镜像本身清空」与「重新添加清墓碑」两条也都钉住。**不是只断言表行消失**，符合探针要求。
6. 边界（记 P2-3 而非 finding）：`remoteToken` 不清，但单独一个 token 无法让 `seedInstances()` 造行，不构成复活。

### (b) 孤儿授权 — **发现 P1-1**

1. **确实是整组、且 typed/total**：`revokeAllForInstance()`（`instanceGrant.ts:674-706`）遍历全部 grant，凡 `g.instanceId === wanted` 都写 `revokedAt`，非法 `nowMs` → `E_GRANT_NOW`、非法 id → `E_GRANT_INSTANCE_ID`、已有更早 `revokedAt` 保留更早值；store 侧失败只标 problem、不写回（`instanceGrantStore.ets:145-152`）。「不是只删一条」「typed 总函数」两项成立。
2. **但「删干净」不成立**：同函数 `:672` 明写「授权记录不删除，保留吊销历史」；D-01（`instanceDelete.test.mjs:116`）还把 `changed.items.length === 3` 钉成断言。于是该实例的每条授权行继续留在 `instance-grants.json`，`instanceId` 指向已不存在的实例 —— **正是契约禁止的孤儿授权**。
3. 影响边界要诚实：`grantActive()` 在 `revokedAt` 之后恒 false（`:493-510`），`canPrompt(ID_A, 5000)` 为 false（测试 `:123`），所以**没有活着的授权泄漏**，这是 P1 而非 P0；但契约第 1/2 条是数据 hygiene 要求，不能由「功能上失效」替代。
4. 建议：把 `revokeAllForInstance` 改成物理过滤掉匹配行（或新增 `removeAllForInstance` 纯函数），同步改 D-01/D-02 与 §0 文案；若 Lead 有意把「吊销=删除」写进契约，必须显式改契约并同步改确认文案，不能两边各说一套。

### (c) 聊天面未动 — **no finding**

`instanceDelete.test.mjs:359-421` 的 X-chat-surface：临时 `filesDir/git-repo/chats/` 放 `index.jsonl` + `chat-1/meta.json` + `chat-1/session.jsonl`，`snapshotChats()`（`:294-312`）对**路径集 + 逐文件 sha256** 取快照，删除前后 `assert.deepEqual(after, before)`（`:388`），并且写键白名单只允许 `deleted-instances.json` / `instance-grants.json` / `instances.json` 三把（`:395-397`），任何含 `chat|git-repo|/` 的键都禁写（`:398-401`），还覆盖「删除前目录不存在、删除后也不许被创建」的合法边界（`:403-417`）。生产页 `SettingsInstances.ets` 全文无 `git-repo` / `chats/`（D-07 `:461` 亦钉）。Freeze 条件满足。

### (d) 仅设置页有删除 — **no finding**

1. 全 app 目录 grep `instanceStore.remove(`：唯一生产调用点是 `pages/SettingsInstances.ets:87`（其余命中是注释与守卫测试）。D-07（`instanceDelete.test.mjs:447-465`）遍历 `ETS` 下所有 `.ets` 逐文件断言命中集合恰为 `['pages/SettingsInstances.ets']`。
2. `InstancesPane.ets`：行操作只有「按公告刷新地址 / 首配信任 / 打开 / 编辑」（`:851-907`），页头只有「添加实例」（`:613-623`）；D-06（`:428-445`）额外禁掉 `label: '删除'`、`variant: 'danger'`、`swipeAction(`、`LongPress`、`deleteInstance(` 等 10 个 token，并正向要求保留打开/编辑/upsert/rekey/addByPairing/ensureSeeded。
3. **改前红证据成立**：`apps/arkui-schedule/.tmp/gates-id-prefix-D06.txt`（2,628 B，UTF-16LE + ANSI）`tests 1 / pass 0 / fail 1`，失败点 `label: '删除'`，`actual: true, expected: false`；本次复跑 G3 同一用例绿。
4. 入口布局：`Settings.ets:145-146,464-471` 第五行「删除实例」推 `pages/SettingsInstances`，两份 `main_pages.json` 都登记（D-08）；确认是 `bindSheet` 两步（`SettingsInstances.ets:64-101,249-256`），不是滑动/长按。

### (e) 消费者横扫 — **发现 P1-2**

逐个核对读实例表/授权表的消费者（以下均为 `path:line`）：

| 消费者 | 位置 | 删除后行为 |
| --- | --- | --- |
| 设置根页实例计数 / typed 问题 | `pages/Settings.ets:258-259`（`instancesViewOf`，经 `:167-173` 的 `aboutToAppear`） | 本页无 `onPageShow`，从删除子页返回时不重算 ⇒ 摘要可能停在删除前计数 |
| 首页保活面板播种 | `pages/panes/InstancesPane.ets:203-224`（`bootstrap → ensureSeeded`） | 墓碑抑制生效，不会复活；只在组件首次出现时跑 |
| 面板列表/徽章/问题行 | `pages/panes/InstancesPane.ets:227-232,239-251,264-273,1097-1100` | **保活不重读**：`rows/views` 是删除时的副本；见 P1-2 |
| 面板「打开」取 token | `pages/panes/InstancesPane.ets:253-261,387-403` | `fullOf()` 命中**旧副本**仍可拼出已删实例的 token 并打开 |
| 面板可达性回写 | `pages/panes/InstancesPane.ets:182-198,400`、`services/remoteAnnounceRefresh.ets:130` | `markReachable`/`upsert` 走 typed 路径，找不到 id 不新增行；不崩 |
| 编辑改地址 rekey | `pages/panes/InstancesPane.ets:480-486`、`services/instanceStore.ets:223-239` | 旧 id 写墓碑、新 id 清墓碑，无第二条；与删除互斥 |
| 手动/扫码配对 | `pages/panes/InstancesPane.ets:501-527,534-569`、`services/instanceStore.ets:247-256` | 成功时整表替换 + 清对应墓碑，行为不变 |
| RemoteControl 取 pin | `pages/RemoteControl.ets:552-566` | `findInstance()` 返回 null 时返回空串 → 拒绝，不抛；id 由当前 URL 派生，不是持久「current」指针 |
| Dots 授权只读行 | `pages/panes/DotsPane.ets:103-163` | 只看 `view.active`；被吊销行 inactive，不会显示成已授权 |

**P1-2 的证据链**：`InstancesPane.ets:14-16` 明写面板保活、`:176-178` 明写「本面板的 `onPageShow()` 永远不会被框架调用」；`Home.ets:244-251` 的 `onPageShow()` 只推进 `scheduleShowTick`（另 `:129-133` 的 refresh tick 也只给日程/dots/云端），`:531-534` 给 `InstancesPane` 只传 `deepLinkId`/`active`，没有 tick 也没有 `@Watch`。因此删除后回到首页，面板仍以旧 `rows/views` 渲染已删行（含 token），与确认 sheet 承诺的「下次连接需要重新扫码配对」相矛盾。`structureGuards.test.mjs:367-378,446` 反而把 InstancesPane 的 prop 白名单钉成只有 `active`/`deepLinkId`，所以现有测试抓不到这一条。建议：给 `InstancesPane` 加 `instancesShowTick`（或 `instanceStore` 版本 `@Watch`），由 `Home.onPageShow()` 推进并在 `@Watch` 里 `reload()`；`Settings.ets` 同步加 `onPageShow()` 重算摘要；补一条「删除后返回首页列表为空」的守卫。真机生命周期表现见 §6。

### (f) Retargeted guards — **no finding（0 放宽 / 0 静默删除）**

`git diff -- apps/arkui-schedule/tools/test/` 逐文件逐条见 §4。结论：所有变化都是「删除入口从面板迁到设置子页」这条契约变更的定向 retarget，每条被替换的旧断言都有等价或更强的新断言接管；页数常量 12→13 / 13→14 与 `validate-app` 实测 13 页一致。**没有任何 `looser`，没有任何断言被静默删除。** 措辞滞后另记 P2-2。

### (g) Rule-9 证据 — **no finding**

`apps/arkui-schedule/.tmp/build-mod-app-instance-delete-in-settings.out`：102,682 B / 1,421 行，非 0 字节。逐项计数（ANSI 保留、大小写敏感）：

| 判据 | 实测 |
| --- | --- |
| `Finished :entry:default@CompileArkTS` | **1** |
| `UP-TO-DATE … CompileArkTS` | **0** |
| `BUILD SUCCESSFUL` | **1**（`BUILD SUCCESSFUL in 10 min 30 s 732 ms`） |
| ERROR 行 | **0** |
| tail | `42 tasks in total: 26 executed, 16 up-to-date` / `Build completed successfully` |

控制台侧 `✓ 产物验收通过` 与 overlay 收尾在该文件里**没有**（本次 grep 计数 0）；它们落在同批兄弟捕获 `apps/arkui-schedule/.tmp/gates-id-build.out`（8,368 B）中：`overlay(finally): restoring` → `[overlay] applied=false` → `[overlay-restore] OK: overlay.mjs status reports applied=false` → `[overlay] orphans=0` → `overlay(finally): applied=false（已断言）`，随后产物清单与 `✓ 产物验收通过`。**证据成立但分散在两个文件**，冻结登记时应同时引用两者，不能只引构建日志就声称控制台验收通过。未重跑 ArkTS 构建（按指派）。

### (h) 诚实性 — **发现 P2-1 / P2-2 / P2-3**

| 句子 | 证据 | 裁定 |
| --- | --- | --- |
| 「已打开的页面在关闭前仍可使用；下次连接需要重新扫码配对」（`instanceDelete.ts:39`，D-03 逐字钉住） | 与确认页 `:18-19` 一致，是契约原文 | 支持；但 P1-2 使首页保活行仍可打开，实际行为与承诺有张力 |
| 「聊天缓存与同步队列属于仓库，不随实例删除」（`:36`） | X-chat-surface + 写键白名单支持 | 支持，未宣称清聊天 |
| 「授权记录（如果从未授权过，这里是空的）」列入损失项（`:32-33`） | 行按吊销历史保留、不删（P1-1） | **轻度过量 ⇒ P2-1** |
| 页头「『彻底删干净』的一次确认写三处」（`SettingsInstances.ets:7`） | 三处写入属实；但授权行与 `remoteToken` 仍在 | **比证据强 ⇒ P2-1/P2-3** |
| 「任何一步失败都如实说明，绝不声称已删干净」（`:78`） | catch 只写「删除未完成」，不说成功 | 支持 |
| 没有「可撤销 / 恢复 / 5 秒撤销」类文案 | 全模块 grep 无此措辞（`Index.ets`/`SchedulePane.ets` 的撤销属另一模块） | 支持，未承诺可逆 |
| 旧测试标题/注释仍写「四行」「配置模式有删除」 | 断言已改为 5 行 / 面板无删除 | **漂移 ⇒ P2-2** |
| `docs/MODULES.md` 本次新增 28 行只含 7.6/7.7 与路由偏差记账 | grep 无 `instance-delete` / `SettingsInstances` / 「删除实例」 | 模块未入台账（范围外，记 §7 待办，不计 P2） |

---

## 3 发现清单

| 级别 | 位置 | 证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P1-1 | `apps/arkui-schedule/entry/src/main/ets/model/instanceGrant.ts:666-706`；`.../services/instanceGrantStore.ets:141-152`；`.../pages/SettingsInstances.ets:86`；`.../tools/test/instanceDelete.test.mjs:116` | 注释逐字「授权记录不删除，保留吊销历史」；D-01 钉 `items.length === 3`；`revokedAt` 后的行 `instanceId` 仍指向已删实例 | 违反契约「所有 grant 行删除、不留孤儿授权」；`instance-grants.json` 留悬空行。活授权已失效，故非 P0 | 物理过滤匹配行或新增 typed `removeAllForInstance`；改 D-01/D-02 与确认文案；若改契约须显式书面化 |
| P1-2 | `apps/arkui-schedule/entry/src/main/ets/pages/Home.ets:244-251,531-534`；`.../pages/panes/InstancesPane.ets:14-16,168-172,203-232,387-403`；`.../pages/Settings.ets:167-173,255-265` | 面板自述 `onPageShow()` 永不触发；Home 只给 `scheduleShowTick`；`structureGuards.test.mjs:367-378,446` 钉死 InstancesPane 只有两个 prop | 删除后回首页仍可见已删行，且可用旧副本 token 打开，和「下次需重新扫码配对」冲突 | 加 `instancesShowTick` + `@Watch reload()`，Home.onPageShow 推进；Settings 加 onPageShow 重算摘要；补返回首页为空的守卫 |
| P2-1 | `apps/arkui-schedule/entry/src/main/ets/pages/SettingsInstances.ets:7`；`.../model/instanceDelete.ts:32-33` | 文案把「授权记录」列为丢失项，实现只吊销保留行 | 对授权删除轻微夸大，违背「must not oversell grant deletion」 | 改成「授权随即失效（授权记录按吊销历史保留）」；页头改「一次确认收口三处写入」 |
| P2-2 | `apps/arkui-schedule/tools/test/settingsSummaryResolve.test.mjs:58`；`.../settingsIaGuards.test.mjs:119`；`.../uiTokens.test.mjs:577`；`.../instanceDelete.test.mjs:427` | 标题/注释仍说「四行」「三个子页」「当前面板有删除」，断言已是 5 行 / 无删除 | 误导后来读者，掩盖 retarget 事实 | 同步改措辞（不改断言强度） |
| P2-3 | `apps/arkui-schedule/entry/src/main/ets/pages/SettingsInstances.ets:89`；`.../services/settingsStore.ets:723-876` | patch 只清 `remoteUrl`/`remoteLastOk`，`remoteToken` 沿用 | token 在偏好里留副本；无法复活但「彻底删干净」字面不完整 | 若契约要求连带清令牌，追加 `remoteToken: ''` 并补对应断言；否则在文案里写明「旧偏好令牌不在本次清理范围」 |

---

## 4 断言台账（(f) 的账本）

`stricter` = 旧断言保留或被等价更强断言接管，并新增钉子；`equal` = 纯 retarget（常量/计数随契约变更，形状与强度不变）；`looser` = 删断言或放宽判据（本次 0 条）。

| 文件 | 断言 / 守卫 | old → new | 分类 |
| --- | --- | --- | --- |
| `tools/test/b2Batch.test.mjs:231-264` | 路由常量表 | 4 项 → +`ROUTE_INSTANCE_DELETE` | stricter |
| 同上 `:243-252` | B2-19 行数与标题 | `rows===4` + 四标题 → `rows===5` + 五标题（+「删除实例」） | stricter（retarget + 增钉） |
| 同上 `:258-264` | B2-20 行绑定 | 4 组 → +`['删除实例','instanceSummary','ROUTE_INSTANCE_DELETE']` | stricter |
| `tools/test/bridgeReadiness.test.mjs:499-510` | W-09 行数 / 绑定 | `countRows===4` + 4 组 → `===5` + 5 组 | stricter |
| `tools/test/instanceList.test.mjs:330-332` | U-01 页面登记 | 只查 Instances → 两份清单都查 `SettingsInstances` | stricter |
| 同上 `:361-366` | 配置模式删除按钮 | `assert.match(config, /label:'删除'/)` → `assert.equal(…,false)` + 子页 `assert.match(/label:'删除实例'/)` | equal（retarget，替换而非删） |
| 同上 `:402-407` | U-08 播种接线 | `seedInstances(before, legacy)` → `seedInstances(before, suppressLegacyForTombstones(legacy, this.loadTombstones()))`；幂等比较旧断言保留 | stricter |
| 同上 `:423-426` | 配置页删除行 | 正向 `label:'删除'` → 反向禁止 + 子页正向 | equal（retarget） |
| 同上 `:492-495` | 行删除动作 | 同上 | equal（retarget） |
| 同上 `:555-570` | U-19 配置能力 | 必留清单删 `label:'删除'` / `this.deleteInstance(view)`，但新增 `rekey` 钉 + 三项反向禁止 + `askDelete` 正向 | stricter |
| `tools/test/paneLayout.test.mjs:497-508` | 配置模式删除 | 两处正向 `label:'删除'` → 两处反向禁止 + 子页正向；注释同步 | stricter |
| `tools/test/settingsCopyGuard.test.mjs:244-255` | C5 行数 | 4 → 5，新增「删除实例」行绑定 | stricter |
| 同上 `:283-298` | C7 路由与页数 | 4 路由→5；main 12→13、harmony 13→14，唯一性保留 | stricter（retarget） |
| `tools/test/settingsIaGuards.test.mjs:27-60,94-104,119` | 目的地 / 动作清单 | +`readDeletePage`、+第 5 目的地、+SettingsInstances 动作条目；`countRows 4→5`（两处） | stricter |
| `tools/test/settingsSources.mjs:64-72,104-110` | 源清单 | +`readDeletePage()` 导出、+`SettingsInstances.ets` 进扫描集 | stricter |
| `tools/test/settingsSummaryResolve.test.mjs:39-43,61` | ROWS / 行数 | +第 5 行；`countRows 4→5` | stricter（标题措辞滞后 ⇒ P2-2） |
| `tools/test/shellLayout.test.mjs:134-142` | L-01 页数 | 12/13 → 13/14，+`SettingsInstances` 登记断言 | stricter |
| 同上 `:393-406` | 面板删除 affordance | 必留清单去 `label:'删除'`，改三项反向禁止 + 子页正向 | stricter |
| 同上 `:455-458` | 入口/fallback 页数 | 12/13 → 13/14 | equal（retarget） |
| `tools/test/structureGuards.test.mjs:281-282,313-330` | 死状态扫描集 / SG-S2 | +`SettingsInstances.ets`；页数 12/13→13/14；+第 5 路由 | stricter |
| `tools/test/uiTokens.test.mjs:576-583,609-615` | U-S5 文件集 | roots +`SettingsInstances.ets`，+4 条子页断言（标题 / Scroll / back / 无横向 push） | stricter |
| `tools/test/instanceDelete.test.mjs:1-500` | D-01…D-09 + X-chat-surface | 全新文件，无旧断言可删 | 新增 |

**总账**：账本 22 行 = 更严 17 + 等严 retarget 4 + 新增文件 1；既有断言删除数 = **0**（逐条均有替换）；放宽数 = **0**；新增用例 = 10（本模块新文件）。唯一「旧断言消失」类变化是面板侧 `label:'删除'` 的正向断言，全部被「面板禁止 + 子页存在」成对替换，符合契约迁移，不算静默删除。

---

## 5 诚实性

见 §2(h) 表与 §3 的 P2-1/2/3。净结论：**没有可逆性承诺、没有「清聊天」承诺、失败时没有假装成功**；三处需要收敛的是授权行的措辞、测试标题滞后、以及 `remoteToken` 残留。`docs/MODULES.md` 本次 28 行新增未给本模块登记行（范围外，§7 待办）。

---

## 6 `unverified`（真机/设备未验）

1. ArkUI 生命周期：从 `pages/SettingsInstances` 返回后，`Settings.ets` 的 `aboutToAppear` 是否重跑、保活 `InstancesPane` 是否真的收不到 `onPageShow` —— P1-2 是**源码链判定**，真机表现未截图/未打点。
2. `bindSheet` 两步确认在真机上的 destructive 色/遮罩/关闭手势、重复点击防抖（`busy`）的实际行为。
3. `PersistentStorage` 绑定 `deleted-instances.json` 在真机冷启动、应用数据被系统清理、多进程同键竞争时的表现；D-05 用的是假 AppStorage 夹具。
4. 已打开 `RemoteControl` 期间被删除：`onPageEnd` 回写 `remoteLastOk` 与墓碑抑制的竞态只在夹具里以「墓碑仍在」推导，未真机复现。
5. Rule-9 构建产物 `entry-default-unsigned.hap` 的安装/启动、页面清单 13/14 项在真机路由可达性。
6. 授权表在真机是否真的为空（契约前提），以及吊销行的 `instanceId` 悬空是否会在未来被某个尚未落地的授权 UI 重新消费。
7. 并发车道 `packages/dsh-dots/dist/sync/cycle.js` 的归属与一致性未审计（非本模块）。

---

## 7 冻结建议

- **裁决：Block。** 两条 P1 都是契约条款正面未满足，且 P1-2 是用户可见的「删了还在」。冻结前请 Lead 要求原车道做四件事：① 让 `revokeAllForInstance` 真正移除匹配行（或改契约并同步文案/测试），消除悬空 `instanceId`（P1-1）；② 给 `InstancesPane` 与 `Settings` 加删除后的刷新信号并补守卫（P1-2）；③ 收敛三处文案（P2-1/P2-3）；④ 修测试标题/注释与 `docs/MODULES.md` 登记（P2-2 + 范围外待办）。
- 复跑门槛：修后重跑 §1.2 的 G1/G2/G3（本评审已留 `.tmp/gates-rvid-*.out` 作为基线），并保留新的改前红/改后绿证据；**不要**用 0 字节或 `UP-TO-DATE`-only 的构建日志冒充 Rule-9 证据，冻结登记需同时引用构建日志与控制台 `✓ 产物验收通过` + overlay 收尾两个文件。
- 不得把并发车道 `packages/dsh-dots/dist/sync/cycle.js` 漂移算作本模块缺陷；但该车道也应在批次提交前自证一致。
- 本评审未修改任何源、测试、dist 或 git 状态；唯一仓库写入是本文件（门禁输出落 gitignored 根 `.tmp/`）。

---

## 8 追加复核（2026-11-28 09:17 +08:00，Designer 要求：只看两条 P1 与 P2 处置）

**结论：Freeze-green（可提交）。** 前次两条 P1 均已消除；本次只追加证据，不改写 §0–§7 的历史结论。HEAD 已从 `0eef966` 前进到 `8dc939c`（`chore(sync): 清理仓库外 outbox 里陈旧的失败意图`，只含 `packages/dsh-dots/**`，属另一车道）。

### 8.1 P1-1 授权行删除 — **已修，no finding**

- `model/instanceGrant.ts:666-693`：`revokeAllForInstance()` 注释逐字改为「按实例整组**移除**授权记录……语义是删除，不是写 `revokedAt` 留历史」；循环只剩 `if (g.instanceId !== wanted) next.push(copyGrant(g))`（`:686-691`），不再写任何 `revokedAt`。typed/total 判据保留（非法 `nowMs` → `E_GRANT_NOW`、非法 id → `E_GRANT_INSTANCE_ID`、无匹配 → 排序原表副本，`:679-685,692`）。
- `services/instanceGrantStore.ets:142` 注释同步改为「从表里移除」；调用点与写回纪律不变（`:145-152`）。
- 测试：`tools/test/instanceDelete.test.mjs:116-124` 由 `length===3` + 逐行 `revokedAt===5000` 改为 `length===1` 且 `filter(instanceId===ID_A).length===0`（明写「连吊销历史行也不能留」），`g-b` `deepEqual` 原行、入参 `length===3` 且未被就地改写仍在；`:141` `assert.deepEqual(ok.items, [])`。X-chat-surface `:390-394` 也从「revokedAt 时间戳」改为 `ID_A` 行数 0 / `ID_B` 行数 1。**不存在带悬空 `instanceId` 的存活授权行。**

### 8.2 P1-2 删除后即时刷新 — **已修，no finding**

- `pages/Home.ets:121-125` 新增 `@State instancesShowTick`；`:251-254` `onPageShow()` 每次 `+1`；`:540-543` 把 `showTick: this.instancesShowTick` 传给 `InstancesPane`。
- `pages/panes/InstancesPane.ets:106-109` 新增 `@Prop @Watch('onShowTick') showTick`；`:179-184` `onShowTick()` → `reload()`；`:240-245` `reload()` 从单例 `instanceStore.list()/redacted()/lastProblem()` 重取三态。删除页在 `SettingsInstances.ets:87` 已 `commit()` 更新同一单例的内存镜像，因此「设置里删 → 返回首页」时 tick 触发的 reload 拿到的是新表，旧行与旧 token 副本被整体替换；行内动作只会命中新 `rows`（`fullOf()` 找不到就早退），不存在可触达的旧令牌。
- 设置页摘要也补上：`Settings.ets:166-167,185-195` 用 `firstShow` 跳过首帧，其余 `onPageShow()` 走 `bootstrap().catch()` 重算实例行。
- 钉子：`instanceDelete.test.mjs:502-517`（D-10，Home tick 递增 / 传参 / pane `@Watch` / `onShowTick()` 内含 `reload()` / Settings 重读摘要）；`structureGuards.test.mjs:365-390`（InstancesPane 期望 props 从 `['active','deepLinkId']` 改为含 `showTick`，并新增 `@Watch` + Home tick 两条源码断言）；`remoteOutcome.test.mjs:176-195`（结果标记仍只走 `@StorageLink+@Watch`，showTick 不消费标记）；`homeListRefresh.test.mjs:66,99-103` 既有日程 watcher 不动。r2 全量套件中 D-10 与 remoteOutcome D3 均显示 ✔（`.tmp/gates-id-r2-suite-1.out:1914,3000`）。
- 失败模式「返回首页旧行仍在」由源码链排除；真机生命周期表现仍属 §6 的 `unverified`，但不再作为冻结阻塞项。

### 8.3 三条 P2 处置

| P2 | 状态 | 证据 |
| --- | --- | --- |
| P2-1 文案夸大授权删除 | **已解决** | 删除语义已变成真删行（§8.1），`DELETE_LOSS_LINE`（`model/instanceDelete.ts:33`）把「授权记录」列为损失项如今逐字成立；`SettingsInstances.ets:7-8` 的「彻底删干净 / 授权记录被移除」也有行为支撑；空表时括号「如果从未授权过，这里是空的」保留，未夸大 |
| P2-2「四行」措辞滞后 | **部分解决（仅注释，非阻塞）** | 断言标题已改：`b2Batch:228,243`、`bridgeReadiness:499`、`settingsCopyGuard:244,284`、`settingsIaGuards:122,194`、`settingsSummaryResolve:50`、`uiTokens:578`、`instanceList:397`；仍有注释残留「四行」：`settingsSummaryResolve.test.mjs:55,60,136`、`settingsIaGuards.test.mjs:9,44,121,193`、`uiTokens.test.mjs:577`、`b2Batch.test.mjs:222,288`、`settingsCopyGuard.test.mjs:239,278`；`docs/MODULES.md` 仍未给本模块登记行（范围外） |
| P2-3 `remoteToken` 残留 | **已解决** | `SettingsInstances.ets:90-91` 改为 `settingsStore.save({ remoteUrl: '', remoteLastOk: '', remoteToken: '' }, context)` 并写明理由「remoteToken 是配对密钥，删实例后不得留在偏好里」；D-09 `:498-499` 与 D-07 `:460` 钉住，X-chat-surface fixture `:384` 同步清 `prefs.remoteToken` |

### 8.4 本次修复轮的断言增量台账（只列相对 §4 的变化）

| 文件 | old → new | 分类 |
| --- | --- | --- |
| `tools/test/instanceDelete.test.mjs:99-145` D-01 | `items.length===3` + 每行 `revokedAt===5000` → `length===1` + `ID_A` 行数 0，新增入参未被就地改写断言 | stricter（retarget 到删除语义） |
| 同文件 D-02 | `g-old.revokedAt===4000`（保留更早吊销）→ `deepEqual(ok.items, [])` | stricter（旧断言在新语义下不适用，由更强的零行断言接管） |
| 同文件 X-chat-surface `:390-394` | `find('g-a1').revokedAt===5000` / `g-b` 无 revokedAt → `ID_A` 行数 0 / `ID_B` 行数 1 | stricter |
| 同文件 D-07/D-09 `:460,498` | `{remoteUrl:'',remoteLastOk:''}` → `{remoteUrl:'',remoteLastOk:'',remoteToken:''}` | stricter |
| 同文件 D-10 `:502-517` | 无 → 5 条刷新链路守卫 | 新增 |
| `tools/test/remoteOutcome.test.mjs:176-195` D3 | 「Home 不给面板传任何 tick」→ 「只传 `showTick: this.instancesShowTick`，且 showTick 不消费结果标记」 | equal（retarget，旧否定断言因契约变更被更强的新断言替换）+ 新增 2 条 |
| `tools/test/structureGuards.test.mjs:365-390` | InstancesPane props `['active','deepLinkId']` → 含 `showTick`，新增 @Watch/Home tick 断言 | stricter |
| `tools/test/settingsMenu.test.mjs:32`、`instanceList:397`、`settingsIaGuards:167,194`、`settingsSummaryResolve:50`、`uiTokens:578`、`b2Batch:228` | 测试标题「四行」→「五行 / 设置摘要」 | equal（仅标题，断言体未变） |

**增量总账：looser = 0，静默删除 = 0，stricter = 4，equal = 7，新增用例 = 1（D-10）。** 唯一被移除的旧断言是「吊销保留更早 revokedAt」，其被测行为已被删除语义取代并由零行断言覆盖，不是放宽。

### 8.5 范围

- 本车道修复触及的Dirty路径全部在 `apps/arkui-schedule/**`（另 `docs/MODULES.md` 与本评审文件）；`packages/dsh-dots/**` 的 dirty 集合是 `chats/{exportChats,index,types,foldChatIndex}`、`sync/{cycle,syncGate}` 与 `test/{chat-hide-*,plugin-pending-ownership,outbox-purge-failed}`，对应聊天导出/隐藏与 outbox 清理车道；HEAD `8dc939c` 正是后者提交（只含 `packages/dsh-dots/**`），即 §1.3 记录的「并发漂移」已被对方车道正规提交，非本模块写入。
- 时间证据：本车道修复文件 mtime `08:38–08:44`（`instanceGrant.ts` 08:38:55、`Home.ets` 08:39:55、`InstancesPane.ets` 08:40:38、`SettingsInstances.ets` 08:39:26、`instanceDelete.test.mjs` 08:44:31），随后 08:58 构建；`packages/dsh-dots/src/sync/cycle.ts` 08:59:02、`dist/chats/index.js` 08:59:59，晚于本车道编辑。新模块源码/测试全文无 `dsh-dots` / `packages/` 引用。**判定：`packages/dsh-dots/**` 未被本车道触碰。**

### 8.6 r2 门禁复核（未重跑，只读既有证据）

- `apps/arkui-schedule/.tmp/build-mod-app-instance-delete-r2.out` 102,645 B：`Finished :entry:default@CompileArkTS` ×1、`UP-TO-DATE … CompileArkTS` ×0、`BUILD SUCCESSFUL` ×1、ERROR ×0；控制台 `gates-id-build-r2.out` 有 `✓ 产物验收通过`。
- `gates-id-r2-tsc.out` `TSC_EXIT=0`；`gates-id-r2-validate.out` `VALIDATE_EXIT=0`（8/8、页面 13）；`gates-id-r2-suite-1/2.out` 均 `tests 3392 / pass 3392 / fail 0`、`SUITE_EXIT=0`。

### 8.7 冻结建议（覆盖 §7）

**可提交。** 两条 P1 已闭环并各有源码守卫；剩余 P2-2 只是注释措辞、P2-1/P2-3 已解决。提交时保留 r2 两套套件、tsc/validate、构建日志 + 控制台验收四份证据；真机「返回首页旧行不可见」按 §6 继续标 `unverified`（非阻塞）。本次追加复核仍未修改任何源、测试、dist 或 git 状态，唯一仓库写入是本文件。
