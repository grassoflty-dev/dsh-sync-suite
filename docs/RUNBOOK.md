# 运维手册（Runbook）：v2 单时间线迁移 / 激活 / 回滚 / 异常处置

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
**迁移与激活必须在 `main` 上完成**，backup 分支只是锚点，不是迁移落地分支。

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

### 1.7 在 App 里显式激活

按 §2 到设置页打开「启用 v2 时间线写入」。迁移完成只是**允许**激活，代码绝不自动激活。

- **成功信号**：开关保持开启，三态行不再「只读」（§2）。
- **失败信号 + 处置**：开关打不开 → 按 §4 的五类拒绝逐项排查；此时 v1 仍可用，不要改仓库标记绕过门槛。

## 2. 激活与关闭

- **位置**：设置页 → 同步区，行标题「启用 v2 时间线写入」+ 开关，源码在
  `components/settings/SyncSection.ets:652–675`；开关处理在 `pages/Settings.ets:544` 的 `toggleV2Write()`。
  开启前必经 `v2ActivationService.decide()` 预检 + `promptAction.showDialog()` 确认；全仓唯一写激活位的是
  `v2ActivationService.activate()/deactivate()`。
- **两库并存专用确认**：`devices/` 与有有效日的 `timeline/` 并存是迁移后常态，此时弹层标题
  「v1 / v2 数据并存：需要显式裁决」、按钮「确认以 timeline/ 为权威」（`pages/Settings.ets:572/578`），
  明示 v1 文件不删除；确认后写 `timeline.v1Retained='1'` 作为裁决记录，之后不再重问。
  单态走普通「确认启用」，文案不同。取消则两种都不激活。
- **关闭**：关掉开关 → `deactivate()` 显式写 `false` / `'v1'`，回到 v1 日程路径，toast 提示「已关闭 v2 写入，
  回到 v1（v1 数据未删除）」；**`timeline.v1Retained` 保留**，因为裁决是事实记录（契约 §9 P1-5）。
- **三个持久键**：`timeline.readMode`（默认 `'v1'`）、`timeline.v2WriteEnabled`（默认 `false`）、
  `timeline.v1Retained`（默认 `''`）的唯一真值在 `model/persistentSettings.ts`，由 `EntryAbility.onCreate()`
  在页面加载前用全局 `PersistentStorage.persistProp` 绑定。真机重启是否仍生效仍 `unverified`（§6）。
- **激活后应看到**：首页三态行 `已同步·HH:MM`（`services/syncStatusStore.ets` 的 `lastAt` 本地时间，
  `Index.ets` 的 `SyncStatusRow()`）；数据仓 `timeline/<date>/` 下 `records.json`、`summary.json?`、
  `deleted.jsonl`、`restore.jsonl`、`conflicts.jsonl`、`media/` 与仓库级 `timeline/schema.json`；
  一次成功的 push（v2 周期提交 `[v2] sync <n> days`，`force:false`，不改写远端历史、不删远端文件）。

## 3. 回滚任一模块（按 tag，从右往左）

tag 命名为 `module/mod-<id>`（`docs/MODULES.md` §3；`git tag -l` 可列出）。回滚由 Lead 执行，
规则是**从右往左先回滚依赖方**；依赖链见 `docs/MODULES.md` §1.1：

```
mod-v2-contract
 ├─ mod-v2-migration ─ mod-v2-media-migration
 ├─ mod-v2-read-timeline ─ mod-v2-read-service ──┐
 ├─ mod-v2-write-service ────────────────────────┼─ mod-v2-dual-write-off ─ mod-v2-sync-wiring ─ mod-export-import-v2
 └─ mod-v2-sync-protocol ────────────────────────┘
```

固定顺序（`git revert <tag>`，一次一个、逐项记录）：

1. `git revert module/mod-export-import-v2`（最右端，导出/导入）
2. `git revert module/mod-v2-sync-wiring`（激活环节；单独回滚只回到「v2 写入未激活」安全态，v1 数据未删）
3. `git revert module/mod-v2-dual-write-off`（必须在 sync-wiring 之后，否则接线悬空）
4. 再回滚汇入它的三方：`git revert module/mod-v2-sync-protocol`、`git revert module/mod-v2-write-service`、
   `git revert module/mod-v2-read-service`；随后 `git revert module/mod-v2-read-timeline`
5. `git revert module/mod-v2-media-migration` → `git revert module/mod-v2-migration` → `git revert module/mod-v2-contract`

`git-bridge` 不能被早于 `mod-v2-sync-wiring` 回滚：`services/GitSyncService.ets` 与
`resources/rawfile/git/git-bridge.js` 的 `opV2Git` 是 sync-wiring 的跨模块触碰（§2 登记），随该提交一起回滚；
先回滚桥会让仍在线的接线失去 git 执行基础。多提交模块按**提交时间从新到旧**逐次 revert
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

## 4. 激活失败 / 异常处置

五类拒绝的现象与下一步（`model/v2Activation.ts` 决策表，评审 `REVIEW-sync-wiring.md` §4）：

| code | 现象（设置页原因行） | 下一步 |
| --- | --- | --- |
| `E_SCHEMA_MISSING` | 「仓库缺少 timeline/schema.json（或无法解析），不能启用 v2 写入」 | 先按 §1 跑迁移生成 `timeline/schema.json`，再回来开启 |
| `E_SCHEMA_UNKNOWN` | 「仓库结构版本不是 2（不认识），不能启用 v2 写入」 | 核对标记内容，重跑记录迁移 apply；不要手改 schemaVersion 绕过 |
| `E_MIGRATION_EMPTY` | devices/ 与 timeline/ 并存但 timeline/ 无有效日，拒绝启用 | 先跑单向迁移让 timeline/ 产生有效日，再开启 |
| `E_NEEDS_EXPLICIT_RESOLUTION` | 弹出「v1 / v2 数据并存：需要显式裁决」专用确认（非错误） | 在弹层点「确认以 timeline/ 为权威」；取消则不激活 |
| `E_SYNC_UNAVAILABLE` | 「同步周期不可用（未绑定 GitRunner 或同步内核未就绪）」 | 先进入设置页让同步内核就绪，再回来开启 |

三态行异常时先查什么：

- **`只读`**：先查开关是否真开启、`timeline/schema.json` 是否 2、分支是否 `main`；缺省文案
  「v2 写入未启用，当前使用 v1 日程路径（在设置页显式开启）」来自 `services/syncStatusStore.ets`。
  未激活 / 已关闭 / 门禁失败都会落这一态；关闭后回到 v1 属预期，不是故障。
- **`N 条待同步`**：先读「最近失败：<typed>」——是 `E_SCHEMA_UNKNOWN`/`E_BRANCH_MISMATCH` 一类门禁错，
  还是 `E_PUSH_REJECTED`/`E_AUTH`/`E_IO` 一类同步错；再查是否 4 次预算耗尽进入 `failed` 终态
  （契约 §9 P1-1，只有 UI「重试同步」能复位）。
- **outbox 卡住**：① 在首页三态行点「重试同步」（`Index.retrySync()` → `resetForRetry()` 复位
  `attempts=0/state=pending`）让它重跑周期；② 检查远端仓库可达、分支 `main`、HEAD==origin/main、凭据有效
  （token 不进日志）；③ 查看 outbox：App 在 `<filesDir>/sync-outbox.json`（`git-repo/` 之外），
  插件在 `%USERPROFILE%\.dsh\dots\outbox\<repoHash>.json`，只观察 `state`/`attempts`/`lastError`/`date`，
  **不要手改 payload（入队即不可变）也不要删条目**——outbox 是周期之间唯一本地真值，删了就丢数据；
  ④ 若远端坏文件报 `E_CORRUPT`，按契约 §9 整日不动、意图留 outbox，须先修远端再重试。

## 5. 验收清单（激活后）

逐项打勾，任何一项不满足都不要宣告迁移/激活成功：

1. 建一条记录：设置页开关为开，三态行不再「只读」。
2. 确认 commit + push：数据仓库 `git -C <repo> log -1 --oneline` 见 `[v2] sync <n> days`；
   `git -C <repo> status --porcelain` 干净；`origin/main` 前进；无 force-push。
3. 重启 App：按 `docs/VERIFICATION.md` §14.9 的 hdc 路径
   （`D:\A-DevEco\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`）停止进程后用
   `hdc -t <serial> shell "aa start -a EntryAbility -b com.itwill.schedule"` 重启。
4. 记录仍在（列表与详情可见、未回退到 v1 路径）；注意「重启后仍生效」本身仍 `unverified`（§6），
   这一步是现场核对，不是引用已有通过结论。
5. `timeline/<date>/records.json` 形态正确：合法 JSON 对象，顶层仅 `date`/`open`/`records`，
   每条记录独占一行、键序符合契约 §3、末尾恰好一个换行，`date` == 目录名；
   `deleted.jsonl` 只追加、一行一条 `{id,ts,deletedAt,intentId?}`，旧字节是新字节严格前缀（契约 §7/§9）。
6. 三态行回到 `已同步·HH:MM`；`timeline/<date>/media/` 应有迁移后的散图，缺文件时显示 `媒体待迁移`
   占位而非破图。

## 6. 未验证边界

以下项当前明确为 `unverified`，本文任何步骤都**不能**被当作它们的通过证据：

- **设备上未配置仓库**：真机激活对话框的弹出/取消/翻转、实际写 `timeline/`、真实 push 全链路，
  以及「建记录→自动同步→三态行变已同步」均无端到端证据（评审 §9、`docs/VERIFICATION.md` §14.8）。
- **双设备并发**：两设备同日各建、同 id 不同 ts / 同 ts、A 删 + B 编辑、媒体占位、fetch+union+replay
  双端逐字节一致，全部 `unverified`（契约 §15）。
- **PersistentStorage 重启证明**：三键已用全局 `PersistentStorage.persistProp` 绑定且有编译证据，
  但「已激活/已裁决 → 杀进程 → 重启仍生效」在真机未验证（评审 §9 第 3 项）。

不要据此宣称已验证；对外表述只能是「纯逻辑/编译可证，端侧待验」。
