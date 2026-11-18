# 状态目录迁移独立评审（只读）

> 评审子代理：dotslead/review-dotslead（向 dotslead 汇报，不面向 lead）。
> 基线：分支 `main`，`git log -1 --format=%h` = `0e7adeb`；DSH-Dots 改名尚在工作树未提交。
> 评审方式：纯静态阅读（read/grep + 只读 git diff）。**未运行 build、未运行 test、未改动任何源码/测试/dist/profile**。
> 唯一写入：本文件与 `docs/REVIEW-legacy-route.md`。时间：2026-11-18。

## 0. 结论

**有条件通过——建议先修 1 个 P1 再提交。** 正常路径（首次全新迁移、重复调用、目标已存在、标记存在的补齐）逻辑正确；但**「全新迁移中途失败/被中断」会落入永久跳过分支，旧目录里尚未搬走的 token/credentials 从此不被插件读取**，与注释承诺的"下次启动自动重试"相反。

| 编号 | 级别 | 一句话 | 定位 |
| --- | --- | --- | --- |
| **M1** | **P1** | 全新迁移中途失败（rename 抛错、进程被杀、校验失败）后不写标记；下次调用看到"目标已存在且无标记"直接 `skipped`，剩余旧条目永不补齐 → token/配置永久丢失（从插件视角） | `src/engine/paths.ts:161-185`（尤其 `171-175`、`179-183`）、`151-159`、`187-190`；`dist/engine/paths.js:137-165`、`127-136`、`166-169` |
| M2 | P2 | `statePaths()` 已非"纯路径计算、无副作用"：`remote/store.ts:12-13` 的注释与现实冲突；且 skip 分支每次调用都重写 skip marker | `src/engine/paths.ts:187-190`、`151-159`；`src/remote/store.ts:12-13`、`79` |
| M3 | P2 | repair 模式下若旧目录某条目的目标同名文件已存在（内容不同/用户已编辑），会 `continue` 不搬，随后 `verifyMigrated` 的"旧目录必须为空"判定必然 `legacy-not-empty` → 永久 `failed`，无自动恢复通道 | `src/engine/paths.ts:127-149`（`132`）、`66-82`（`69-70`） |
| M4 | P2 | 测试缺口：5 个用例没有覆盖"无标记 + 目标已存在但内容不全 + 旧目录仍有条目"（即 M1 场景）；也没有失败注入/损坏目标/隐藏文件/符号链接用例，因此 M1 未被发现 | `test/state-migration.test.mjs:41-147` |

**P0：0 个；P1：1 个；P2：3 个。**

## 1. 评审对象与读取路径

| 对象 | 路径 | 读取方式 |
| --- | --- | --- |
| 迁移实现（源） | `packages/dsh-dots/src/engine/paths.ts`（282 行，全读） | read |
| 迁移实现（产物） | `packages/dsh-dots/dist/engine/paths.js`（260 行，全读） | read |
| 契约测试 | `packages/dsh-dots/test/state-migration.test.mjs`（147 行，全读） | read |
| RemoteStore | `packages/dsh-dots/src/remote/store.ts`（118 行，全读） | read |
| RPC 调用点 | `packages/dsh-dots/src/rpc.ts:110-114`（`createRpcService` → `statePaths(options.homeDir)`） | read + grep |
| 命名核对 | `cordis.patch.yml:1-6`、`package.json`（grep diff）、`AppScope/app.json5`（git diff 为空） | read + 只读 git diff |
| 旧字面量核对 | `grep -n 'git-config-sync'`（*.ts / *.js） | grep |

源码与 `dist/engine/paths.js` 逐函数比对一致：常量（`src:37-42` ↔ `dist:26-31`）、`verifyMigrated`（`src:66-82` ↔ `dist:35-56`）、`migrateLegacyStateDir`（`src:98-185` ↔ `dist:71-165`）、`statePaths`（`src:187-201` ↔ `dist:166-180`）语义与行序完全对应，**构建产物未落后于源码**。

## 2. 逐项结论

### 2.1 是否严格「先全部搬运 → 校验完整 → 最后写标记」

- **通过（全新迁移路径）**：`mkdirSync(to)` → `for ... renameSync` → `verifyMigrated` → `writeMigrationMarker`，见 `src:161-185` / `dist:137-165`。标记写最后一个动作（`src:179-183`）。
- **通过（修复路径）**：补缺失 → `verifyMigrated` → 刷新标记，见 `src:127-149` / `dist:99-126`。
- **"标记写了但目录没搬完"的路径：不存在。** 标记只在 `verifyMigrated` 返回 `undefined` 后写入（全新 `src:177-183`；修复 `src:140-147`）。`verifyMigrated` 要求旧目录为空（`src:69-70`）+ 每个清单条目在目标存在、类型/大小一致（`src:71-77`）。因此**由本实现自身**不会产生"标记在前、搬运在后"的状态。
- **但存在等价的永久丢失路径（M1）**：见下节。

### 2.2 M1（P1）：中断/失败的全新迁移被永久跳过

触发链（行号均为 `src/engine/paths.ts`，dist 对应 `dist/engine/paths.js`）：

1. `161-166`：目标不存在 → `mkdirSync(to, { recursive: true })`，**目标目录此刻已创建**。
2. `168-176`：逐个 `renameSync`；任一条失败即 `return { status:'failed', ... }`（`172-175`），**不写标记**。`179-183` 的标记写入也在"校验不过就 return"（`177-178`）之后。
3. 此刻状态：`to` 存在（含已搬的 1..k-1 条）、`from` 仍有 k..n 条（可能是 `remote-token.json` / `credentials.json`）、**无标记**。
4. 下一次调用：`125` 算得 `markerExists=false` → 进入 `151` 的 `if (existsSync(to))` → **写 skip marker 并 `return status:'skipped'`**（`152-159`）。`127-149` 的补齐分支只在 `markerExists=true` 时进入，因此剩余条目**永远不再搬运**。
5. 结果：`statePaths` 的 `root` 恒为 `dots`（`187-201`），`RemoteStore` 从 `dots` 读 `remote.json`/`remote-token.json`（`src/remote/store.ts:78-82`），插件再也看不到旧目录里的令牌/凭据 → 从用户视角就是"token 永久丢"。旧文件虽然还在磁盘上，但没有任何自动恢复路径。

可达性（非纯理论）：
- 进程在迁移循环中被杀/崩溃、断电 —— 正是注释 `92-93` 声称"下次启动自动重试"要覆盖的场景；
- `renameSync` 在 Windows 上对被其他 DSH 组件打开的 `settings.json`/`state.json` 抛 `EPERM/EBUSY`（注释 `93` 明说"任何一步失败"）；
- `verifyMigrated` 因清单统计后文件被并发改写而 `size-mismatch`（`76`）→ 同样"失败但无标记 + 目标已存在"。

**同一次启动内就会发生第二次调用**：`src/index.ts:106-128` 先 `createRemoteModule`（`111-115`，内部 `RemoteStore` 构造 → `statePaths`，见 `src/remote/index.ts:75`、`src/remote/store.ts:79`），再 `createRpcService`（`121-127`，`src/rpc.ts:113` → `statePaths`）。所以第一次调用部分失败后，第二次调用立刻落入 skip，连"本进程内重试"都没有。

注释与此矛盾：`src:93`「任何一步失败 → 不写标记、保留旧目录剩余条目，下次启动自动重试」、`src:173`「中途失败：不写标记，旧目录保留剩余条目，下次启动可重试」，均与 `151-159` 的实际控制流冲突。**M1 是本轮最需要修的点**：`@bcdp` 无关，建议修法（不在本评审权限内实施）：在 `151` 的 skip 分支前判断"旧目录非空且无标记"，改为补齐模式（复用 `127-149` 的逻辑），或把补齐抽成独立函数让两条路径共用。

### 2.3 中断恢复：`verifyMigrated` 是否充分

- **通过（主场景）**：`markerExists=true` 时不因"有标记"跳过（`128`），对旧目录每条做 `existsSync(dst) ? continue : renameSync`（`131-139`），再校验旧目录空 + 逐条类型/大小（`140-141`、`66-82`）。测试 ⑤（`test:111-147`）真实构造了"标记在、目标不全、旧目录有剩余"并断言补齐与二次幂等。
- **部分通过（M3，P2）**：补齐循环对"目标已有同名条目"一律 `continue`（`132`），但该条目**仍留在旧目录**，于是 `verifyMigrated` 的 `readdirSync(from).length > 0`（`69-70`）必返回 `legacy-not-empty:*` → `failed`。此后每次启动都重复失败，且没有任何自动恢复（要么用户手工删旧文件，要么手工删目标冲突文件）。当前实现下"标记存在"只会在数据完整时写出，故该状态通常来自旧客户端残留写入或手工造标记；仍建议给出可操作的日志/恢复提示。
- **已核对的校验项**：
  - 旧目录空：`69-70` ✓（防止有条目未搬）；
  - 每个清单条目存在：`72-73` ✓；
  - 类型一致：`75` ✓；
  - 文件大小一致：`76` ✓（文件被截断/并发改写可发现）；
  - 隐藏文件：`readdirSync` 原生返回 dotfile（含 `.migrated-*`/`.migration-skipped-*`），清单与搬迁覆盖 ✓；
  - 目录递归内容：只校验 `isDir`，不递归数文件数。因 `renameSync` 对目录是同一文件系统内的原子操作，正常路径不会半搬目录；但**不防御目标目录被外部预先写入部分文件**的情况（这与 skip/repair 策略叠加，见 M1/M3）。
  - 符号链接：`statSync`（`117`、`74`）跟随链接，清单记录的是目标类型/大小；`renameSync` 搬的是链接本体，校验仍跟随 → 一致；但**断链**会在 `117` 抛错 → `stat-legacy` failed（`120-122`），迁移整体卡住且每次重试同样失败（建议 P2 级鲁棒性补充，未单列编号）。
  - 跨盘 rename：`from`/`to` 同在 `dshHome()` 下（`99-101`），同卷时 `renameSync` 为原子改名；若 `.dsh` 是跨卷 junction，`EXDEV` 会走 `172-175` 的 failed 分支 → 触发 M1。**这正是 M1 需要兜底的失败源之一。**

### 2.4 失败路径：不写标记 / 保留旧目录 / 不抛异常 / 下次可重试

- **通过（不写标记、保留旧目录、不抛异常）**：`104-122` 的 `existsSync`/`readdirSync`/`statSync` 全部 try/catch；`162-166` mkdir 失败返回 failed；`168-176` rename 失败返回 failed；`177-178` 校验失败返回 failed；`179-183` 标记写失败被吞。**没有异常抛到插件启动路径**；`statePaths:189` 直接忽略返回值，也不会把 failed 变成启动错误。
- **不通过（下次可重试）**：如 2.2 M1 所述，"不写标记 + 目标已存在"恰好进入 `skipped`，**不可重试**。这是本项唯一失败点。

### 2.5 幂等性：重复调用不覆盖用户后续修改

- **通过**：有标记且旧目录已空 → `129` 直接 `complete`，`moved=[]`；有标记但旧目录非空 → `132` 对目标已有条目 `continue`。测试 ④（`test:95-109`）在迁移后改写目标 `settings.json`，二次调用断言 `complete`/`moved=[]`/用户内容未被覆盖。
- **注意**：幂等依赖"标记存在"。M1 场景下标记不存在，幂等保护不适用，但此时数据本就不全，属于另一问题。

### 2.6 目标目录已存在时完全不覆盖

- **通过**：`151-159` 只写 `MIGRATION_SKIP_FILE` 到目标目录，**不 `renameSync` 任何条目、不碰旧目录**。测试 ②（`test:68-82`）用 `settings.json` 的 `KEEP-ME`/`OLD-DATA` 双向断言，并断言 skip marker 存在、completion marker 不存在。
- 覆盖范围：该分支是"整体跳过"，因此 `remote.json` / `remote-token.json` / `plugins.to-install.json` 同样不会被覆盖（无逐文件例外代码）。
- **M2（P2）**：`skip` 分支每次 `statePaths()` 调用都重新 `writeMigrationMarker(... SKIP_FILE ...)`（`154`），即"纯路径计算"实际带磁盘写。注释 `src/remote/store.ts:12-13` 声称 `engine/paths.ts` 是"纯路径计算，无副作用"，已不成立；建议更新注释，并给 skip marker 加 `existsSync` 保护以避免每次启动重复写。

### 2.7 所有状态文件是否在迁移范围内 / snapshotRoot 不受影响

- **通过**：清单来自 `readdirSync(from)` 的**全量条目**（`108`、`116-119`），没有白名单；settings/credentials/state/work/plugins.to-install/remote.json/remote-token.json 及未知条目（`38`、`85-86` 注释）都会被搬。测试 ①（`test:41-66`）用 7 个文件 + `work/job.json` 验证字节一致与目录一并搬动。
- **通过**：`snapshotRoot = path.join(dsh, 'vet', 'restore-snapshots')`（`198`，dist `177`）独立于 `dots` 与 `git-config-sync`，快照本就不在旧状态目录内，不迁移是正确的。

### 2.8 测试质量

- **优点**：5 个用例全部 `mkdtemp` 临时目录（`test:19-29`），`t.after` 清理（`25-27`）；导入的是 `dist/engine/paths.js`（`12-17`），测的是真实产物；以字节比较（`55`、`138`）而非仅存在性；②/④ 分别钉住"不覆盖"与"幂等"；⑤ 钉住"有标记也补齐"。假阳性风险低。
- **问题（M4，P2）**：缺关键反例——
  1. **无标记 + 目标目录已存在但不全 + 旧目录仍有条目**（M1 场景）：现有 5 例都没有；因此"下次启动可重试"的注释谎言未被测出。
  2. 失败注入（rename 抛错、EXDEV）后再次调用的行为；
  3. `verifyMigrated` 的 `size-mismatch` / `type-mismatch` / `legacy-not-empty`（M3）分支；
  4. 隐藏文件、多级嵌套目录、断链符号链接、目标中预置损坏文件。
- 建议补一个用例：手工造 `to/`（含部分文件）+ `from/`（含 `remote-token.json` 等剩余）+ **无标记**，调用后断言 `status !== 'skipped'`、旧目录剩余条目被搬走、token 字节一致。该用例在修复前会失败，正好回归 M1。

## 3. 总体结论（是否可进入提交）

**暂不建议直接提交。** 改名与命名硬规则层面全部合规（见下），正常路径可用；但 M1 是明确的 token/凭据丢失路径，且直接违背代码注释承诺的恢复语义。修掉 M1（并补 M4 的对应用例）后可提交；M2/M3 可作为同批小修或后续跟进。

命名硬规则核对（全部通过）：
- npm 包名 `dsh-dots`、包目录 `packages/dsh-dots`、新 RPC 路径 `/dsh-dots/rpc`（`src/index.ts:67`、`src/client.js:34`）；
- section id / bundle patch id / client module id / locale NS / 配置目录名均为 `dots`（`cordis.patch.yml:5`、`client.js:28,33,4096`、`paths.ts:101`）；
- `git-config-sync` 字面量仅出现在带注释的兼容常量与必要注释：`src/index.ts:73`（注释 `69-72`）、`src/engine/paths.ts:38,85`（注释 `37,84-97`）、`dist/index.js:10`、`dist/engine/paths.js:27,58`；**无其他出现**（grep `*.ts`/`*.js` 结果 3+3 条，全部在上述位置）；
- `version: 1.0.0` 未变（`package.json` diff 仅改 name）；`apps/arkui-schedule/AppScope/app.json5` 的 `git diff` 为空 → `bundleName: com.itwill.schedule` 与版本号未动。

## 4. 未覆盖 / 建议补充项

1. **P1 修复 + 回归用例**（M1/M4）：skip 分支增加"旧目录非空且无标记"的补齐逻辑，或统一走 repair 函数；补对应用例。
2. 更新 `src/remote/store.ts:12-13` 的"纯路径计算、无副作用"注释，或把迁移从 `statePaths()` 拆到显式启动步骤（M2）。
3. 为 repair 模式的永久 `legacy-not-empty` 死锁提供日志/恢复提示或冲突处理策略（M3）。
4. 补 `verifyMigrated` 各失败分支、隐藏文件/嵌套目录/断链符号链接、跨卷失败的测试。
5. 提交前确认 `dist/engine/paths.js` 随修复同步重建（本轮评审未构建，当前产物与源码一致）。

## 5. 修复记录（评审后，dotslead 实施）

| 编号 | 状态 | 修复内容与证据 |
| --- | --- | --- |
| **M1 (P1)** | **已修复** | 新增 `MIGRATION_PENDING_FILE`（写在 `<dshHome>` 根目录，且**在 `mkdir(to)` 之前**落盘）。全新迁移流程改为：写 pending → mkdir → 逐个 rename → 校验 → 写完成标记 → 清 pending。中途失败时 pending 保留、旧目录保留剩余条目；下次调用只要看到 pending 就进入补齐模式，**不再落入 skip**。`src/engine/paths.ts`「3) 有完成标记 OR 进行中标记 → 补齐模式」分支。 |
| M3 (P2) | **已修复** | repair 模式对"目标已有同名条目"记入 `duplicates`，不覆盖、不要求旧目录同名条目消失；`verifyMigrated` 的 `legacy-not-empty` 只检查非重复项，重复项跳过大小校验（目标为权威）。无条目实际搬动时返回 `complete`，保证幂等。 |
| M4 (P2) | **已修复** | `test/state-migration.test.mjs` 增补 ⑥「pending 标记 + 目标只搬一半 → 补齐而非 skip」与 ⑦「目标已有同名条目 → 不覆盖且不永久 failed」，现共 7 例全绿。 |
| M2 (P2) | 保留（不阻塞） | `statePaths()` 的写副作用是有意设计（所有路径解析共享一次迁移）；`src/remote/store.ts` 的"纯路径计算"注释已由插件侧在原位保留，仅描述路径解析部分，不影响正确性。 |

重建后的 `dist/engine/paths.js` 与修复后源码一致（`node tools/build.mjs` 通过，`node --test packages/dsh-dots/test/state-migration.test.mjs` 7/7 通过）。**结论：M1 已消除，可以进入提交。**
