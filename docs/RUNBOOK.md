# 运维手册（Runbook）：v2 单时间线迁移 / 回滚 / 异常处置

> 面向对象：操作员（Lead / 设备维护者），不是开发者。本文只使用仓库里**真实存在**的工具与命令。
> 权威依据：`docs/DATA-CONTRACT-v2.md` §9（同步协议）/ §10（迁移）/ §11（门槛），
> `docs/MODULES.md` §1 索引 / §1.1 依赖图 / §4 回滚演练，`docs/REVIEW-sync-wiring.md`，
> `docs/VERIFICATION.md` §14。凡真机 / 双端 / 重启类结论一律标 `unverified`（见 §6），
> **不要据此宣称已验证**。
> 下文 `<repo>` 指待迁移的**数据仓库**；代码仓库工作目录固定为
> `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`，两者不要混用。

## 1. Start fresh：把 App 指向一个仓库，它自己建时间线

**产品决定（mod-drop-v1）**：没有迁移流程、没有未迁移横幅、没有 E_NOT_MIGRATED。
空仓库（没有 `timeline/` 或 `timeline/schema.json`）就是正常起点：
- App 启动后显示**空日程列表**（没有横幅、没有拒绝、没有「查看迁移步骤」）；
- 写入服务在**首用**（初始化）时创建 `<repo>/timeline/` 与规范 `schema.json`（`{"schemaVersion":2}`）；
- 写第一条日程时创建 `timeline/<date>/records.json`（先建空骨架再原子写入该条记录）。

旧设备目录与旧 `open.jsonl` **一律忽略**：不读、不写、不删（仅保留一行说明；历史数据由用户自行处置，本项目不提供迁移入口）。

**私有仓库硬门禁（mod-repo-privacy-gate）**：同一个仓库承载 `timeline/**`（日程）+ `chats/**`（聊天会话）+ `remote/**`（远程控制配置），平板 App 与 DSH 插件共用，所以**仓库必须是私有仓库**。这不是同意勾选或地址猜测：设置页保存仓库地址、「测试连接」以及每次推送前都会调用 Gitee / GitHub 的 provider API 权威校验 `private`（≤ 5 s 超时，令牌只进 Authorization 头）。公开、401/403、404、未知域名（自建 / GitLab）、5xx / 超时与非预期响应都给 typed 中文拒绝，绝不把「查不到」当作私有。被挡时**本地写入照常**（记录落本地、意图停在 outbox），但**推送被拒且绝不显示已同步**；状态行只显示「仓库已变为公开，已停止上传（最近尝试 HH:MM）」或「无法确认仓库可见性，已停止上传（最近尝试 HH:MM）」。校验按 60 s 去重，公开 / 未知判定 sticky（只有一次通过的实时校验才解挡），重试只发生在下一次自然周期 / 保存 / 测试连接，没有后台轮询。

### 1.1 操作步骤

1. 确认代码仓库工作目录干净：`git status --porcelain` 无输出。
2. 在设置页填好数据仓库地址与令牌并保存（分支固定 `main`）。
3. 回到首页：看到空列表即可开始记录；第一条日程保存后检查 `<repo>/timeline/schema.json` 与当日 `records.json` 已生成。
4. 后续保存、勾选完成、删除 / 撤销、汇总都只写 `timeline/<date>/`，并随同步周期 commit + push（`[v2] sync <n> days`，`force:false`）。

- **成功信号**：无横幅；空态文案「今天还没有日程」；首条保存后 `timeline/schema.json` 与 `timeline/<date>/records.json` 存在。
- **失败信号 + 处置**：若出现 typed `E_SCHEMA_UNKNOWN`，说明标记存在但版本不认识 → 只读、零写入，检查标记内容；不要手改版本绕过。若无任何时间线文件且写入失败，检查本机存储可写与仓库地址配置。

## 2. 空仓库与已有 v2 仓库的运行时行为

- **唯一路径**：App 与插件直接以 `timeline/` 为唯一日程真值；写 `timeline/<date>/`（records / summary / deleted / restore / conflicts / media），自动跑 fetch→union→replay→commit→push。
- **没有开关 / 没有迁移**：`timeline.readMode` / `timeline.v2WriteEnabled` / `timeline.v1Retained` 与 `E_NOT_MIGRATED` 均已删除；没有「启用」「确认迁移」「回到 v1」入口。
- **安全说明**：旧设备目录与 `open.jsonl` 不读、不写、不删；仓库里若残留这些文件会被原样忽略。
- **应看到**：首页三态行 `已同步·HH:MM`（`services/syncStatusStore.ets` 的 `lastAt`，`Index.ets` 的 `SyncStatusRow()`）。

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
> **构建后覆盖层还原卡住（2026-11-21 `mod-build-restore-timeout`）**：`build-harmony.ps1` 打印 `[overlay-restore] TIMEOUT ...` / `FAILED ...` 或以 exit 3 结束时，先 `node apps/arkui-schedule/tools/overlay.mjs status` 确认是否仍 `applied=true`；确认没有他人 hvigor / devecocli 构建在跑后，在 `apps/arkui-schedule` 目录手动 `node tools/overlay.mjs restore`，再查 `node tools/overlay.mjs status` 必须 `applied=false` 且 `git status --short` 的 `entry/src/main` 无改动才算恢复；不要在别人的构建进行中还原。

## 4. 异常处置（原「激活失败 / 异常处置」；**历史口径，未迁移项已被 mod-drop-v1 superseded**）

> **2026-11-20 v2-only 订正**：原五类激活拒绝中的 `E_SCHEMA_MISSING` / `E_MIGRATION_EMPTY` /
> `E_NEEDS_EXPLICIT_RESOLUTION` / `E_SYNC_UNAVAILABLE`（决策表 `model/v2Activation.ts`，评审
> `REVIEW-sync-wiring.md` §4）随激活流程一并删除，不再存在；`E_SCHEMA_UNKNOWN` 保留为 schema 门禁拒绝。
> 新增未知版本只读拒绝 ，契约 §9/§11）：

| code | 现象 | 下一步 |
| --- | --- | --- |
| `E_SCHEMA_UNKNOWN（未知版本标记）→ 只读、零写入，检查标记内容
| `E_SCHEMA_UNKNOWN` | 「仓库结构版本不是 2（不认识）」，只读、零写入 | 核对标记内容，重跑一次性迁移；不要手改 schemaVersion 绕过 |

三态行异常时先查什么：

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

## 5. 验收清单（空仓库首用后）

> **2026-11-20 v2-only 订正**：原「激活后验收」口径已改为「迁移完成后验收」；不再检查任何设置页开关。

逐项打勾，任何一项不满足都不要宣告迁移成功：

1. 建一条记录：空仓库正常起点（无 banner、无拒绝），三态行不再「只读」；旧设备数据原样保留、未被删除。
2. 确认 commit + push：数据仓库 `git -C <repo> log -1 --oneline` 见 `[v2] sync <n> days`；
   `git -C <repo> status --porcelain` 干净；`origin/main` 前进；无 force-push。
3. 重启 App：按 `docs/VERIFICATION.md` §14.9 的 hdc 路径
   （`D:\A-DevEco\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`）停止进程后用
   `hdc -t <serial> shell "aa start -a EntryAbility -b com.itwill.schedule"` 重启。
4. 记录仍在（列表与详情可见、无 banner / 无拒绝）；注意「重启后仍生效」本身仍 `unverified`（§6），
   这一步是现场核对，不是引用已有通过结论。
5. `timeline/<date>/records.json` 形态正确：合法 JSON 对象，顶层仅 `date`/`open`/`records`，
   每条记录独占一行、键序符合契约 §3、末尾恰好一个换行，`date` == 目录名；
   `deleted.jsonl` 只追加、一行一条 `{id,ts,deletedAt,intentId?}`，旧字节是新字节严格前缀（契约 §7/§9）。
6. 三态行回到 `已同步·HH:MM`；`timeline/<date>/media/` 应有迁移后的散图，缺文件时显示 `媒体待迁移`
   占位而非破图。

## 6. 未验证边界

以下项当前明确为 `unverified`，本文任何步骤都**不能**被当作它们的通过证据：

- **设备上未配置仓库 / 未知版本只读拒绝 *零写入**、实际写 `timeline/`、真实 push 全链路，以及
  「建记录→自动同步→三态行变已同步」均无端到端证据（评审 §9、`docs/VERIFICATION.md` §14.8）。
- **双设备并发**：两设备同日各建、同 id 不同 ts / 同 ts、A 删 + B 编辑、媒体占位、fetch+union+replay
  双端逐字节一致，全部 `unverified`（契约 §15）。
- **签名 / 安装 / 启动（v2-only 后）**：`hdc list targets` 为空，当前无法在真机重新签名、安装并启动含
  v2-only 改动的 HAP；banner 渲染与设备写拒绝因此端侧 `unverified`（评审 §9 第 3 项）。
- **PersistentStorage 重启证明**：原三个持久键（`timeline.readMode` / `timeline.v2WriteEnabled` /
  `timeline.v1Retained`）已随激活流程删除；「迁移完成 → 杀进程 → 重启仍生效」在真机未验证（评审 §9 第 3 项）。

不要据此宣称已验证；对外表述只能是「纯逻辑/编译可证，端侧待验」。

## 7. 构建 / 签名（`tools/sign-hap.ps1`）

- 口令解析顺序固定为 `-StorePass/-KeyPass` 显式参数 → 环境变量 `SIGN_PASS`（可选 `SIGN_KEY_PASS`）→ `signing/pass.txt`（去 UTF-8 BOM、只去掉行尾 CRLF，空格/制表符当作口令字符保留）；签名前用 `keytool -list` 预检 keystore，打不开即报 `[sign-hap] 密码无法打开 keystore：检查 -StorePass / signing/pass.txt（不要打印密码）` 而不打印口令；v2 材料（`itwill-debug-v2.p12/.cer/.p7b`）不齐时**默认拒绝**使用已泄露的 v1 调试密钥，确有 Reproduction 需要须显式加 `-AllowLegacyV1Key`，届时会打印含 `LEAKED v1 signing key` 的高亮警告。

- **可证安装 = install 输出 + 内容哈希比对（或新构建独有的行为），不要依赖 bm dump 的 versionCode。**
  - 本机（MLR-AL00 / API 26）上 `bm dump -n com.itwill.schedule` 的 `versionCode` 恒为 `0`、`versionName` 为空，
    **不能**用来证明替换成功；把 `versionCode` 自增当作安装证据是无效的。
  - **内容证明**：从设备取回 `.../haps/entry/modules.abc`（或 `resources.index`），与已签名 HAP 内同名条目比对 SHA256；
    相等即证明该构建已安装。
  - **行为证明**：只在新构建里出现的界面特征（例如设置四行菜单、关于页版本文案、某个按钮已消失）。
  - 操作记录仍保留 `install bundle successfully` + `aa start` 输出。
  - `versionCode` 仍需按发布递增（AppGallery 要求），但**不作为安装证明**引用。

### 7.1 安装证明：内容哈希路线在 undebuggable 镜像上不可用（1000004 起）

> 2026-11-21 随 1000004 落真追加。**取代 §7 末段「可证安装 = install 输出 + 内容哈希比对、不要依赖 `bm dump` 的 `versionCode`」的笼统口径**：那条来自旧镜像（MLR-AL00 / API 26，`versionCode` 恒为 0）的观察，不适用于当前的 undebuggable 镜像。

**症状**：本镜像上 `hdc shell ls` / `hdc file recv` 读取 `/data/app/el1/bundle/public/<bundle>/entry.hap` 一律 `Permission denied`（shell uid 2000），`hdc smode` 也被拒。因此原计划的「从设备取回已安装的 `ets/modules.abc` 并与已签名 HAP 内同名条目比对 SHA-256」**在此无法产出**；不要把「取不到哈希」误记为比对失败。

**已采用的替代证明（1000004 实测）**：`bm dump -n <bundle>` 取**应用级** `versionCode`——以最浅的 `"vendor": "itwill"` 行作锚，`versionCode` 在紧随其后、缩进相同的一行——再取 `updateTime`；**装机前先抓一份基线**，`install -r` 后再抓一份对照。PASS = `versionCode` 等于预期值**且** `updateTime` 发生变化/增长。不要用 `installTime`（陈旧，`install -r` 不推进；实测两侧同为 `1794720327159`），也不要用嵌套/模块的 `versionCode` 块（0/空）。逐行哈希与完整判据见 `docs/VERIFICATION.md` §15.18。

**操作要点**：每次需要可证明的装机，先自增 `AppScope/app.json5` 的 `versionCode` 再构建；`dist-harmony/` 必须在 `sign-hap.ps1` 运行前就存在，否则报 `11017002 Write zip file failed`；若 `signing/pass.txt` 已打不开 keystore，用 `signing/README.md` 记载的值经 `-StorePass`/`-KeyPass` 传入，**不要打印口令**。

### 7.2 设备传输：每次会话重新读 `hdc list targets`

设备可能以**无线（TCP target，例如 `192.168.1.7:33023`）或 USB 串口**接入，同一台平板在两次会话之间可能换传输方式、换端口或只连 USB；因此**每次会话开始都先跑 `hdc list targets` 读当次真实 target**，此后所有 `hdc -t <serial> …` 都沿用这一次的读数，不沿用上次会话的 IP / 串口。此前有一个周期因为默认 `192.168.1.7:33023` 而整轮丢失。**当前串口 `6MFBB25C27205131` 只是示例，不是常量**：无线在线时 target 形如 `192.168.x.x:port`，USB 在线时是设备序列号，两者都会变，以当次 `hdc list targets` 输出为准。
