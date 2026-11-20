# 运维手册（Runbook）：v2 单时间线迁移 / 回滚 / 异常处置

> 面向对象：操作员（Lead / 设备维护者），不是开发者。本文只使用仓库里**真实存在**的工具与命令。
> 权威依据：`docs/DATA-CONTRACT-v2.md` §9（同步协议）/ §10（迁移）/ §11（门槛），
> `docs/MODULES.md` §1 索引 / §1.1 依赖图 / §4 回滚演练，`docs/REVIEW-sync-wiring.md`，
> `docs/VERIFICATION.md` §14。凡真机 / 双端 / 重启类结论一律标 `unverified`（见 §6），
> **不要据此宣称已验证**。
> 下文 `<repo>` 指待迁移的**数据仓库**；代码仓库工作目录固定为
> `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`，两者不要混用。

## 1. 迁移真实仓库（v1 → v2）

迁移一次性、单向、只新增：`tools/migrate-v1-to-v2.mjs` 只读 `devices/**`，写
`<repo>/timeline/` 与 `timeline/schema.json`，**不删不改任何 v1 文件**；媒体 zip 由
`tools/migrate-media-v1-to-v2.mjs` 单独搬运，v1 zip 同样不删不改（契约 §10）。

### 1.1 备份 / 分支

先整目录复制 `<repo>` 作备份（带日期）；若 `<repo>` 是 git 仓库，`git -C <repo> status --porcelain`
必须干净，可建 `git -C <repo> branch backup/v1-<date>` 作回滚锚点；代码仓库同样先
`git status --porcelain` 确认干净。注意：v2 写操作断言分支固定 `main`（契约 §2/§11），
**迁移必须在 `main` 上完成**（2026-11-20 订正：原「与激活」随激活流程删除而作废），backup 分支只是锚点，不是迁移落地分支。

- **成功信号**：备份目录可读；`status --porcelain` 无输出；当前分支 `main`。
- **失败信号 + 处置**：工作区有改动 → 先由 Lead 处理或换用干净副本，不要在脏树上迁移；
  分支不是 `main` → 切回 `main` 再开始；备份无法读取 → 停止，禁止进入下一步。

### 1.2 记录迁移 dry-run（不写）

```
node tools/migrate-v1-to-v2.mjs --repo <path> --dry-run
```

`--repo` 可直接指向仓库根或它的 `devices/` 目录。重点读输出里的
`[migrate] plan days=… records=… deletes=… summaries=… skipped=… duplicates=… conflicts=… restores=…`
及各日 `[migrate] day <date> records=… deletes=… restores=… conflicts=… summaries=…` 行。

- **成功信号**：exit 0；有 `days`/`records` 计数；末行 `[migrate] dry-run: 未写入任何文件`。
  `conflicts` 非 0 表示同 `(id,ts)` 内容不同已被字节裁决，败者会在 `--apply` 时进当日 `conflicts.jsonl`，
  属预期、不是失败；确认 `days`/`records` 与源 `devices/**/schedules/*.jsonl` 数量相称。
- **失败信号 + 处置**：exit 2 = 参数/门槛拒绝（如找不到 `devices/`、参数冲突），先看 `拒绝：…` 文本，
  修正 `--repo` 路径后重跑；exit 1 = 未预期错误，保留完整堆栈回报 Lead。
  dry-run 零写入，可任意重跑；任何解析失败必须先暴露，不能带病进入 `--apply`（契约 §10 步骤 1）。

### 1.3 记录迁移 apply（暂存 + 校验）

```
node tools/migrate-v1-to-v2.mjs --repo <path> --apply
```

工具先写 `timeline.tmp-<pid>/`，回读逐字节校验后原子落入 `timeline/`，最后写 `timeline/schema.json`。

- **成功信号**：exit 0；`[migrate] verify ok days=… records=… deletes=… summaries=… skipped=… conflicts=… restores=…`
  的计数与 dry-run 对齐；`timeline.tmp-<pid>/` 已被清理；`timeline/schema.json` 含 `schemaVersion: 2`。
- **失败信号 + 处置**：exit 3 = 校验失败，输出 `[migrate] …；保留现场 <applied.site>`，**保留
  `timeline.tmp-<pid>/` 现场**，不要手动删除；比对 `verify ok` 期望计数与 dry-run 的 days/records/deletes/
  summaries/conflicts 差异，核对当日 `records.json` 的形状（§5），修正输入后用 `--out <path>` 输出到新目录，
  或在确认现场可弃后清理暂存再试。exit 2「目标 timeline/ 已存在」→ 用 `--out <path>`，或确认只补缺失日时加
  `--force`（**绝不覆盖已有 `records.json`**）。失败期间 v1 文件始终未动。

### 1.4 媒体迁移 dry-run（不写）

```
node tools/migrate-media-v1-to-v2.mjs --repo <path> --dry-run
```

dry-run **不要求** `timeline/schema.json`。

- **成功信号**：exit 0，产出媒体计划；不落任何媒体文件。
- **失败信号 + 处置**：exit 2（缺 `devices/` 等门槛）→ 修正路径；ZIP64 / 多磁盘 / 加密条目按条报类型化拒绝
  （exit 3）→ 记下受影响的 v1 zip，它们保持原样，对应记录由 App 显示占位文案 `媒体待迁移`（契约 §5）。

### 1.5 媒体迁移 apply

```
node tools/migrate-media-v1-to-v2.mjs --repo <path> --apply
```

要求 `timeline/schema.json` 的 `schemaVersion=2`（即 1.3 必须先成功）。文件落
`timeline/<date>/media/<sha16>.jpg`，按 sha256 同日去重、只增不减。

- **成功信号**：exit 0；媒体文件出现在对应日 `media/`，记录 `media[].file` 是不含路径的裸文件名；
  v1 `devices/**/attachments/*.zip` **不删不改**。
- **失败信号 + 处置**：exit 2「需先运行记录迁移」/「schemaVersion 不是 2」→ 回到 1.3；
  同名不同内容报 `E_MEDIA_SHA16_COLLISION` → 不覆盖，人工裁决；ZIP64/加密条目逐条拒绝、不落盘 → 保留 v1 zip，
  按 §6 标注未迁移，不宣称媒体完整。

### 1.6 提交迁移结果

由 Lead 提交（执行子代理不 commit）：`git status --porcelain` 只应看到新增 `timeline/**`；
`git add timeline/` → `git commit` → `git push origin main`。迁移提交**只新增** `timeline/` 与标记，
不删除 v1 文件；禁止 force-push。

- **成功信号**：push 成功，`origin/main` 前进，工作区干净。
- **失败信号 + 处置**：push 非快进 → 不要强推，核对远端状态后由 Lead 决定常规收敛；
  提交里混进 `devices/**` 删除 → 撤回重做，迁移提交不得删 v1（契约 §10）。

### 1.7 迁移一次 → App 即用 timeline（无激活步骤）

> **2026-11-20 v2-only 订正**：原「在 App 里显式激活」整节已废止删除——激活开关
> `timeline.v2WriteEnabled`、预检服务 `v2ActivationService` 与设置页开关均不存在。

§1.1–§1.6 的迁移提交一落地（`timeline/schema.json` 写明 `schemaVersion:2`），App 与插件即直接以
`timeline/` 为唯一日程真值；没有开关、没有确认弹层、没有「回到 v1」的路径。

- **成功信号**：不再显示未迁移 banner；新写入落到 `timeline/<date>/` 并随周期 commit + push；
  `devices/**` 原样保留、未被删除。
- **失败信号 + 处置**：出现**唯一一条**「仓库尚未迁移」banner 且 typed `E_NOT_MIGRATED` →
  说明标记未落地（迁移未完成或已回滚），回到 §1.1–§1.6 执行一次性迁移；零写入是预期，
  不要改仓库标记绕过门槛。

## 2. 迁移一次 → App 使用 timeline（v2-only）

> **2026-11-20 v2-only 订正**：原「激活与关闭」整节已废止删除——设置页没有「启用 v2 时间线写入」
> 开关，也不存在 `v2ActivationService.decide()/activate()/deactivate()`、两库并存专用确认、
> `timeline.v1Retained` / `timeline.readMode` / `timeline.v2WriteEnabled` 三个持久键，以及「关闭回到 v1」。
> 以上均为历史记录，不再成立（契约 §9/§10/§11）。

- **唯一路径**：迁移完成（`timeline/schema.json` 的 `schemaVersion=2`）后，App 与插件直接走 v2 单时间线：
  `timeline/<date>/` 下 `records.json`、`summary.json?`、`deleted.jsonl`、`restore.jsonl`、
  `conflicts.jsonl`、`media/` 与仓库级 `timeline/schema.json`。写入经 §9 同步周期自动 commit + push
  （提交 `[v2] sync <n> days`，`force:false`，不改写远端历史、不删远端文件）。
- **未迁移**：缺 `timeline/schema.json` 且存在 `devices/` → 界面显示**唯一一条** banner + typed
  `E_NOT_MIGRATED` 拒绝，**零写入**（不建本地提交、不 push）；处置只有一条：由用户显式执行一次
  `mod-v2-import-v1`（待交付）迁移。
- **安全网**：`devices/**` 永不删除、保持原样；迁移只新增 `timeline/` 与标记，不删改任何 v1 文件。
- **应看到**：首页三态行 `已同步·HH:MM`（`services/syncStatusStore.ets` 的 `lastAt` 本地时间，
  `Index.ets` 的 `SyncStatusRow()`）；一次成功的 v2 周期提交（同上）。

## 3. 回滚任一模块（按 tag，从右往左）

tag 命名为 `module/mod-<id>`（`docs/MODULES.md` §3；`git tag -l` 可列出）。回滚由 Lead 执行，
规则是**从右往左先回滚依赖方**；依赖链见 `docs/MODULES.md` §1.1。

> **2026-11-20 v2-only 订正**：`mod-v2-dual-write-off` 的激活部分与 `mod-v2-sync-wiring` 的激活部分已删除、
> 被 `mod-v2-only` 取代；二者不再出现在回滚链中（原「单独回滚只回到 v2 写入未激活安全态」的说法作废）。

```
mod-v2-contract
 ├─ mod-v2-migration ─ mod-v2-media-migration
 ├─ mod-v2-read-timeline ─ mod-v2-read-service ──┐
 ├─ mod-v2-write-service ────────────────────────┼─ mod-v2-only ─ mod-export-import-v2
 └─ mod-v2-sync-protocol ────────────────────────┘
```

固定顺序（`git revert <tag>`，一次一个、逐项记录）：

1. `git revert module/mod-export-import-v2`（最右端，导出/导入）
2. `git revert module/mod-v2-only`（v2-only 默认行为；单独回滚只回到「含已删除激活模块的旧代码」历史态，
   不作为常规回滚目标）
3. 再回滚汇入它的三方：`git revert module/mod-v2-sync-protocol`、`git revert module/mod-v2-write-service`、
   `git revert module/mod-v2-read-service`；随后 `git revert module/mod-v2-read-timeline`
4. `git revert module/mod-v2-media-migration` → `git revert module/mod-v2-migration` → `git revert module/mod-v2-contract`

`git-bridge` 不能被早于汇入它的同步模块回滚：`services/GitSyncService.ets` 与
`resources/rawfile/git/git-bridge.js` 的 `opV2Git` 承担 v2 周期的 git 执行，先回滚桥会让仍在线的周期失去 git 执行基础
（2026-11-20 订正：原「不得早于 `mod-v2-sync-wiring` 回滚」的说法随该模块激活部分删除而作废）。
多提交模块按**提交时间从新到旧**逐次 revert
（例：`mod-d5-create-date` 的 `git revert d6a6b69 14b181a`，见 §1 行）。若已执行过 v1 清理提交，
须先逆序 revert 清理提交再 revert 迁移提交，否则只能恢复到 v2 状态（契约 §10）。

**回滚后必跑门闸**（工作目录 `dsh-sync-suite`，原始输出贴进批次记录）：

```
node apps/arkui-schedule/tools/overlay.mjs status          # 期望 applied=false
node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"  # 0 fail / 1 skip
node apps/arkui-schedule/tools/validate-app.mjs            # 8/8
node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json  # exit 0
```

五项同时成立才算回滚干净；**回滚之后必须再跑一次全绿全量**（§4 第 5 步），没有这次绿灯不算回滚完成。

## 4. 异常处置（原「激活失败 / 异常处置」）

> **2026-11-20 v2-only 订正**：原五类激活拒绝中的 `E_SCHEMA_MISSING` / `E_MIGRATION_EMPTY` /
> `E_NEEDS_EXPLICIT_RESOLUTION` / `E_SYNC_UNAVAILABLE`（决策表 `model/v2Activation.ts`，评审
> `REVIEW-sync-wiring.md` §4）随激活流程一并删除，不再存在；`E_SCHEMA_UNKNOWN` 保留为 schema 门禁拒绝。
> 新增未迁移拒绝 `E_NOT_MIGRATED`。

现有 typed 拒绝的现象与下一步（`assertWritable()` 门禁，契约 §9/§11）：

| code | 现象 | 下一步 |
| --- | --- | --- |
| `E_NOT_MIGRATED` | **唯一一条**「仓库尚未迁移到 v2 时间线」banner；`timeline/**` 写入零写入 | 由用户显式执行一次 `mod-v2-import-v1`（待交付）迁移，生成 `timeline/schema.json`；不要手改标记绕过门槛 |
| `E_SCHEMA_UNKNOWN` | 「仓库结构版本不是 2（不认识）」，只读、零写入 | 核对标记内容，重跑一次性迁移；不要手改 schemaVersion 绕过 |

三态行异常时先查什么：

- **`未迁移 banner`**：先查 `timeline/schema.json` 是否存在、`schemaVersion` 是否 2；缺标记 + `devices/`
  存在 → `E_NOT_MIGRATED` + 唯一一条 banner + 零写入，属预期，须显式迁移，不是故障。
- **`只读`**：先查 `timeline/schema.json` 是否 2、分支是否 `main`（**不再查「开关是否真开启」**，开关已删除）；
  未知版本 → `E_SCHEMA_UNKNOWN`、零写入；门禁失败都会落这一态。
- **`N 条待同步`**：先读「最近失败：<typed>」——是 `E_SCHEMA_UNKNOWN`/`E_BRANCH_MISMATCH` 一类门禁错，
  还是 `E_PUSH_REJECTED`/`E_AUTH`/`E_IO` 一类同步错；再查是否 4 次预算耗尽进入 `failed` 终态
  （契约 §9 P1-1，只有 UI「重试同步」能复位）。
- **outbox 卡住**：① 在首页三态行点「重试同步」（`Index.retrySync()` → `resetForRetry()` 复位
  `attempts=0/state=pending`）让它重跑周期；② 检查远端仓库可达、分支 `main`、HEAD==origin/main、凭据有效
  （token 不进日志）；③ 查看 outbox：App 在 `<filesDir>/sync-outbox.json`（`git-repo/` 之外），
  插件在 `%USERPROFILE%\.dsh\dots\outbox\<repoHash>.json`，只观察 `state`/`attempts`/`lastError`/`date`，
  **不要手改 payload（入队即不可变）也不要删条目**——outbox 是周期之间唯一本地真值，删了就丢数据；
  ④ 若远端坏文件报 `E_CORRUPT`，按契约 §9 整日不动、意图留 outbox，须先修远端再重试。

## 5. 验收清单（迁移完成后）

> **2026-11-20 v2-only 订正**：原「激活后验收」口径已改为「迁移完成后验收」；不再检查任何设置页开关。

逐项打勾，任何一项不满足都不要宣告迁移成功：

1. 建一条记录：无未迁移 banner（已迁移），三态行不再「只读」；`devices/**` 原样保留、未被删除。
2. 确认 commit + push：数据仓库 `git -C <repo> log -1 --oneline` 见 `[v2] sync <n> days`；
   `git -C <repo> status --porcelain` 干净；`origin/main` 前进；无 force-push。
3. 重启 App：按 `docs/VERIFICATION.md` §14.9 的 hdc 路径
   （`D:\A-DevEco\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`）停止进程后用
   `hdc -t <serial> shell "aa start -a EntryAbility -b com.itwill.schedule"` 重启。
4. 记录仍在（列表与详情可见、未出现未迁移 banner / 未零写入）；注意「重启后仍生效」本身仍 `unverified`（§6），
   这一步是现场核对，不是引用已有通过结论。
5. `timeline/<date>/records.json` 形态正确：合法 JSON 对象，顶层仅 `date`/`open`/`records`，
   每条记录独占一行、键序符合契约 §3、末尾恰好一个换行，`date` == 目录名；
   `deleted.jsonl` 只追加、一行一条 `{id,ts,deletedAt,intentId?}`，旧字节是新字节严格前缀（契约 §7/§9）。
6. 三态行回到 `已同步·HH:MM`；`timeline/<date>/media/` 应有迁移后的散图，缺文件时显示 `媒体待迁移`
   占位而非破图。

## 6. 未验证边界

以下项当前明确为 `unverified`，本文任何步骤都**不能**被当作它们的通过证据：

- **设备上未配置仓库 / 未迁移拒绝**：真机上「唯一一条 banner」的渲染、对未迁移仓库的 typed
  `E_NOT_MIGRATED` 拒绝与**零写入**、实际写 `timeline/`、真实 push 全链路，以及
  「建记录→自动同步→三态行变已同步」均无端到端证据（评审 §9、`docs/VERIFICATION.md` §14.8）。
- **双设备并发**：两设备同日各建、同 id 不同 ts / 同 ts、A 删 + B 编辑、媒体占位、fetch+union+replay
  双端逐字节一致，全部 `unverified`（契约 §15）。
- **签名 / 安装 / 启动（v2-only 后）**：`hdc list targets` 为空，当前无法在真机重新签名、安装并启动含
  v2-only 改动的 HAP；banner 渲染与设备写拒绝因此端侧 `unverified`（评审 §9 第 3 项）。
- **PersistentStorage 重启证明**：原三个持久键（`timeline.readMode` / `timeline.v2WriteEnabled` /
  `timeline.v1Retained`）已随激活流程删除；「迁移完成 → 杀进程 → 重启仍生效」在真机未验证（评审 §9 第 3 项）。

不要据此宣称已验证；对外表述只能是「纯逻辑/编译可证，端侧待验」。
