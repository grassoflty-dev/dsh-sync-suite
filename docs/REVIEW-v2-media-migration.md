# 独立评审：`mod-v2-media-migration`（v1 按天 zip → v2 媒体散图）

| 项 | 值 |
| --- | --- |
| 评审角色 | 独立、只读评审执行者（`planner-b6/review-v2-media`） |
| 评审日期 | 2026-11-20 |
| 被审文件 | `tools/migrate-media-v1-to-v2.mjs`（实测 **764 行**；`docs/MODULES.md:34` 登记 765 行；任务书称 713 行）、`apps/arkui-schedule/tools/test/v2MediaMigration.test.mjs`（实测 **749 行 / 31 例**；任务书称 742 行） |
| 对照物 | `docs/项目理解.md`（上级目录）、`docs/DATA-CONTRACT-v2.md` §2/§5/§10/§11、`docs/DATA-CONTRACT.md` §4ter、`tools/migrate-v1-to-v2.mjs`（803 行） |
| 方法 | 逐行静态审阅 + 自造对抗性 ZIP fixture 实跑 + 四个门禁亲自复跑；未提交、未改任何被审源码，仅新增本评审文件 |

---

## 1. 结论

**P0 = 0；P1 = 0；P2 = 7；blocking = 无。判定：通过（非阻塞），建议在下个批次补测试与 P2 加固。**

核心结论：模块的**安全边界是对的**。所有写调用都落在 `--out` 根下的 `timeline.tmp-<pid>/` 或 `timeline/<date>/media/`；`devices/` 全程只读（静态 grep + 自造 fixture 的 sha256 前后比对双重证明，见 §4）；输出文件名由 `sha256[0:16]` 构造而非 zip 条目名，因此路径穿越**在结构上无法**落到 `media/` 之外；CRC-32、解压字节数、记录 sha256 三重校验后才 merge，`existing-different` 绝不覆盖；确定性/幂等/门槛/退出码/算术闭合均实测符合契约。31 个测试全部是真实契约断言，fixture zip 是手写二进制（local header + central directory + EOCD），确实走了解包器，没有绕过。

未升级为 P1 的原因：发现的 7 项 P2 中，最严重的「同日多设备 zip 暂存路径碰撞」（§3 P2-1）在两种顺序下分别是「正确字节落地但静默丢弃一次写、计数虚高」和「exit 3 且暂存保留」，**没有任何一条路径把错误字节写进最终树**；而且 v1 §4ter 的条目名自带内容 sha8，跨设备同名条目在正常数据下必然同内容，实际影响被进一步限制。

---

## 2. Findings（按严重度）

### P2-1 同 `(date,name)` 多项写共享同一 stagedPath：跨 zip 去重失效、验证可被绕过、计数虚高

`claimed` 在**每个 zip 循环内部**新建（`migrate-media-v1-to-v2.mjs:456`、`:490`），不是按天共享：

```js
// :456
for (const zip of zips) {
...
// :490
    const claimed = new Map(); // sha16 -> sha256
```

`writeStaging` 又只用 `w.name` 作为暂存文件名（`migrate-media-v1-to-v2.mjs:640-645`）：

```js
const dir = path.join(stage, 'media', day.date);
fs.mkdirSync(dir, { recursive: true });
for (const w of day.writes) {
  const staged = path.join(dir, w.name);
  fs.writeFileSync(staged, w.bytes);
  w.stagedPath = staged;
}
```

后果：两台设备各有一份 `2026-11-19.zip`、都含同一条目名时，`day.writes` 出现两个 `finalPath` 相同的写对象，暂存文件互相覆盖，`verifyStaging`（`:651-662`）读的是同一个物理文件。
实测（自造 fixture，记录 sha 对应设备 `a` 的字节）：

- 设备 `a`=正确字节、`z`=错误字节（错误者排序在后）→ `status=3`，`sha-mismatch=2` 同一路径重复报两次，暂存保留（fail-closed，但报错重复且计数失真）。
- 设备 `b`=错误字节、`z`=正确字节（正确者排序在后）→ `status=0`，`merged=1 already-present=1`，**一次写被静默丢弃**，`already-present` 凭虚高计数出现在成功行。

建议：把 `claimed` 提到 `for (const zip of zips)` 之外（按 `(date, sha16)` 去重），或让 stagedPath 包含 zip/序号；并为「同日多设备同名 archive」补一条测试。

### P2-2 EOCD 反向扫描只校验上界、不校验「恰好到 EOF」，注释内伪造签名可误导解析

`migrate-media-v1-to-v2.mjs:188-192` 从文件尾向前找第一个 `0x06054b50`；`:206` 只做上界检查：

```js
for (let i = buf.length - 22; i >= low; i -= 1) {
  if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
}
...
if (eocd + 22 + commentLen > buf.length) {
  throw new EntryError('zip-truncated', ...);
}
```

若 EOCD 注释内容里含 `PK\x05\x06` 且后续字节为 0（我构造的 `xx + PK0506 + 18×00`），扫描命中**注释里的假 EOCD**，`nTotal=0 / cdOff=0 / cdSize=0` 全部合法通过，于是中央目录被当成空：实测 `entries=0`、`missing=1`，`--apply` 退出 3（`status=3`，暂存保留）。普通注释（不含签名）正常工作（实测 `d-eocd-comment` 成功）。
影响：恶意/损坏 zip 会被误判为「引用缺失」而非「结构错误」；不写错文件，但错误分类错误。建议：命中的 EOCD 必须满足 `eocd + 22 + commentLen === buf.length`，否则继续向前找。

### P2-3 零长度条目被接受并写出 0 字节 `.jpg`

`extractEntry` 只比长度与 CRC（`migrate-media-v1-to-v2.mjs:268-273`），无下限检查：

```js
if (raw.length !== uncompSize) { throw new EntryError('size-mismatch', ...); }
if (crc32(raw) !== crc) { throw new EntryError('crc-mismatch', ...); }
```

实测 `--apply`：空条目通过，`status=0`、`merged=1`，落盘 `e3b0c44298fc1c14.jpg` 大小 0。若此类数据进入仓库，v2 §5 的「缺文件显示 `媒体待迁移`」占位不会触发（文件存在但空），app 会显示破图。建议：拒绝 `uncompSize === 0` 或写后校验 JPEG magic。

### P2-4 v1 `entry` 路径穿越被静默跳过（计数 +0 退出），且无测试

`collectReferences`（`migrate-media-v1-to-v2.mjs:358-362`）：

```js
// entry 只作为 zip 内 Map key，不拼文件路径；仍拒绝明显穿越形态。
if (att.entry.startsWith('/') || att.entry.split('/').includes('..') || att.entry.includes('\\')) {
  stats.badEntry += 1;
  continue;
}
```

实测 `../evil.jpg`、`/abs/evil.jpg`、`a\..\evil.jpg` 三种形态均 `badEntry=1`、条目变为 `unreferenced`、零文件写出，`--apply` 仍 `status=0`。**结论：不会越权写盘**（输出名来自 sha），符合安全要求；但不符合项目「no silent failure / typed 错误」纪律——只在 refs 汇总行留一个 `badEntry=1`，没有 typed error，也不影响退出码。v2 `records.json` 里 `media[].file` 的穿越则由 `:570-573` 的 `safeName` 捕获并进 `crossMissing`，实测 `status=3`，这部分是对的。两条路径都没有测试覆盖。

### P2-5 `--force` 与对照工具语义相反（操作者误用风险）

- 媒体工具 `USAGE`（`migrate-media-v1-to-v2.mjs:81`）：`--force  有逐条目错误时仍把已成功解包的条目合并进 timeline/；错误照报，退出码仍为 3`
- 记录工具 `USAGE`（`migrate-v1-to-v2.mjs:52`）：`--force  timeline/ 已存在时，只补缺失的日期目录，绝不覆盖已有 records.json`

同一批两个迁移工具、同一 flag 两种含义，操作者极易误用（尤其在两步迁移的 runbook 里同时复制粘贴）。建议改名（如 `--keep-going`）或在帮助里显式交叉提示。

### P2-6 测试缺口：7 条规范性/边界规则无用例，另有若干「日志措辞」型断言

31 例整体质量高（见 §6），但以下** normative 或已实现分支无任何用例**（点名）：

1. `att.entry` / `att.archive` 路径穿越拒绝与 `badEntry`/`missing` 归类（`:358-362`、`:448-454`）；
2. 256 MiB 压缩/解压双上限（`:48-49`、`:251-253`）；
3. 多磁盘拒绝 `zip-multidisk`（`:212-214`）与 ZIP64 **哨兵值**分支（`:209-211`；现有 test 23 只覆盖定位器）；
4. 带注释 EOCD（`:205-208`）及 P2-2 的伪造签名变体；
5. 中央目录与本地头尺寸不一致（`:268-270`）；
6. 零长度条目（P2-3）；
7. 退出码 1（`EXIT.UNEXPECTED`，`:57`、`:760-761`）无任何触发用例。

pin 实现琐事的断言：`dayLine`/`planLine`（测试文件 `:197-207`）依赖精确日志前缀，`/verify ok days=1 merged=1/`（`:219`）、`/已合并可安全条目 1 个/`（`:745`）、`tmpDirs()` 依赖 `timeline.tmp-` 前缀（`:193-195`）。这些是 CLI 输出形状而非行为语义；措辞微调会导致无意义红测。建议至少把关键不变量改为解析结构化字段（现有 test 18 的 `num()` 做法是好范例），日志文本断言保留 1–2 条即可。

### P2-7 退出码未在 `--help` / `USAGE` 中说明

`EXIT = { OK:0, UNEXPECTED:1, REFUSED:2, VERIFY:3 }`（`migrate-media-v1-to-v2.mjs:57`）只在代码里；`USAGE`（`:75-84`）列了参数却没列退出码表。虽然错误文本自解释且测试固定了 0/2/3，但对离线 CLI 的调用方（runbook / 脚本）不友好。建议在 `USAGE` 增加 4 行退出码表。

---

## 3. 已验证正确的规则（逐项证据）

| 检查 | 结论 | 证据 |
| --- | --- | --- |
| `archive` 权威 | 通过 | `:481` `const wanted = refs.byArchive.get(zip.archive)`；test 04（`:254-274`）断言另一日 zip 的同名条目 `unreferenced=1`、零落盘 |
| `entry → sha256` 折叠 | 通过 | `:335-351` 按 (device,file,id) 收集版本 + `:310-321` `pickWinner`（较晚 ts 胜 / 同 ts 取规范整行 UTF-8 字节较大者）；test 21（`:559-576`）、test 22（`:578-596`） |
| 重复条目去重 | 通过 | `:512-516` `claimed` 命中同 sha256 → `duplicates++`；test 03（`:238-252`） |
| `unreferenced` / `missing` 计数 | 通过 | `:495`、`:448-454`、`:483-487`；test 04/05/18。missing 不创建空文件（test 05 `:290`） |
| sha16 碰撞 | 通过 | `:411-426` `markSha16Collisions` 把撞前缀的**两方**都打 `skip`，`:496-499` 逐条记 `sha16-collision`；test 15（`:439-458`）断言两文件均不存在。注：实现是「跳过 + 报错」而非契约 §14 推荐 1 的「延长前缀」，但契约 §7 表明确 `E_MEDIA_SHA16_COLLISION，不覆盖`，且 §5 的推荐措辞是 `推荐` 非 normative，故不判缺陷 |
| `existing-different` 不覆盖 | 通过 | `:521-535` 计划期判定 + `:681-686` merge 前复查；test 12（`:397-411`）断言原字节未变 |
| 确定性 / 幂等 | 通过 | 全文件无 `Date.now` / `new Date`（grep 0 命中）；`process.pid` 只进暂存目录名且成功时删除；test 16（`:460-477`）两 `--out` 树逐字节相同，我复跑 `trees_equal=true`；第二次 `--apply` → `already-present=1`、`merged=0`（test 11 + 我的 `IDEMPOTENT` 探针） |
| 门槛 | 通过 | `:716-731` `--apply` 先查 `timeline/` 与 `schemaVersion===2`；dry-run 不查。我复跑：缺 schema → apply 2 / dry 0；缺 timeline → apply 2 / dry 0；v3 → apply 2 |
| 退出码 | 通过 | `:57` 0/1/2/3；`:742-748` VerifyFailed→3、`:755-762` Refused→2 / 其他→1；test 05/06/08/13/14/19/23/25 等固定 2/3，成功例固定 0（code 1 未测，见 P2-6） |
| 算术闭合 | 通过 | `:580-590` totals；每个中央目录条目恰好落入 written/skipped/errors 一类，zip 级错误按 1 条目入账（`:463`、`:476`）；test 18（`:499-530`）断言 `entries=3, written=1, skipped=1, errors=1` 且 `entries=written+skipped+errors` |
| 写后校验 | 通过 | `:650-662` 回读重算 sha256；`:667-673` 有错且无 `--force` → 抛 VerifyFailed 且暂存保留；`:695` 成功才清理暂存 |

---

## 4. v1 未触碰证明（Check 1）

### 4.1 静态：全部写调用与目标

对 `migrate-media-v1-to-v2.mjs` grep `writeFileSync|renameSync|unlinkSync|rmSync|mkdirSync|copyFileSync|appendFileSync|createWriteStream|openSync`，**仅 7 处**：

```
636:   fs.rmSync(stage, { recursive: true, force: true });
637:   fs.mkdirSync(stage, { recursive: true });
641:     fs.mkdirSync(dir, { recursive: true });
644:       fs.writeFileSync(staged, w.bytes);
687:       fs.mkdirSync(path.dirname(w.finalPath), { recursive: true });
689:       fs.renameSync(w.stagedPath, w.finalPath);
695:   fs.rmSync(plan.stageDir, { recursive: true, force: true });
```

`stage` / `stageDir` 在 `resolvePaths`（`:140`）定义为 `path.join(outputRoot, 'timeline.tmp-${process.pid}')`；`finalPath` 在 `:519` 定义为 `path.join(paths.finalDir, day.date, 'media', name)`，`finalDir = path.join(outputRoot, 'timeline')`（`:139`）。`devices` 在全文 26 处出现全部是 `readdirSync` / `readFileSync` / `existsSync` / `statSync` / 字符串；**没有任何写调用以 `devices` 或 `paths.devices` 为参数**。`unlinkSync` / `appendFileSync` / `copyFileSync` / `createWriteStream` / `openSync` 命中数为 0。

### 4.2 动态：自造 fixture 的 sha256 前后比对

用独立探针脚本构造真实仓库（`devices/a/schedules/2026-11-19.jsonl` + `devices/a/attachments/2026-11-19.zip`），对整个 `devices/` 子树逐文件算 sha256，运行 CLI 后重算：

```
V1_SUCCESS   status=0 devices_identical=true {"a/attachments/2026-11-19.zip":"293298bf3f0024039fc53508c929692459da891839b8a905cf69684f57961a12","a/schedules/2026-11-19.jsonl":"2b1c4f27146755667d562826dc8a51aa94f95796aae98f3af3b5a6f7a509cc13"}
V1_DRYRUN    status=0 devices_identical=true
V1_FAILURE   status=3 devices_identical=true stage=timeline.tmp-31480
V1_FORCE     status=3 devices_identical=true
```

成功路径的最终树只有 4 个文件，写入范围严格受限：

```
SCOPE_SUCCESS ["devices/a/attachments/2026-11-19.zip","devices/a/schedules/2026-11-19.jsonl","timeline/2026-11-19/media/ffd9b182546d9aa6.jpg","timeline/schema.json"]
SCOPE_STAGE_LEFT []
```

失败路径暂存保留且路径被报出（`SCOPE_FAILURE`）：

```
SCOPE_FAILURE status=3 stage=["timeline.tmp-9784"] stagedFiles=[] tail="[media] 校验失败：逐条目错误=1 missing=0 cross-missing=0 sha-mismatch=0；未合并，暂存现场保留于 ...\timeline.tmp-9784"
```

（注：`stagedFiles=[]` 是因为该失败发生在 `extractEntry` 之前，没有条目进入暂存；test 07 `:331-333` 另有「成功条目留在暂存」的断言。）

---

## 5. 对抗性 ZIP 结果（自造 fixture，全部亲自实跑）

fixture 由独立脚本手写 local header + central directory + EOCD，可任意篡改字段；下表 `status=0` 的行为由 dry-run 探测报告分类，`--apply` 列给出真实退出码。

| # | 对抗输入 | 工具反应 | apply 退出 | 判定 |
| --- | --- | --- | --- | --- |
| a | 中央目录 `uncompSize` 比本地头多 10 | `error size-mismatch: ...解压字节数 7 != 中央目录 17` | 3 | 正确拒绝 |
| a2 | 中央目录 `compSize` 改为 3 | `error size-mismatch: ...解压字节数 3 != 中央目录 13` | 3 | 正确拒绝 |
| b | `entry = ../evil.jpg` / `/abs/evil.jpg` / `a\..\evil.jpg` | `badEntry=1`、条目变 `unreferenced`、零写出 | 0 | 安全（不越权写），但静默（P2-4） |
| b2 | zip 条目名 `../../evil.jpg`，记录引用良性条目 | 恶意条目 `unreferenced=1`，良性条目正常写出 | 0 | 正确：输出名非条目名 |
| b3 | v2 `media[].file = ../../evil.jpg` | `cross-missing 2026-11-19 r ../../evil.jpg` | 3 | 正确拒绝 |
| c | 零长度条目 | `written=1`，写出 0 字节 `.jpg` | 0 | 接受（P2-3） |
| d | EOCD 带 19 字节普通注释 | 正常解出、字节匹配 | 0 | 正确 |
| d2 | EOCD 注释内嵌伪造 EOCD 签名 | 误判空中央目录 → `missing=1` | 3 | 错误分类（P2-2） |
| e | EOCD `nTotal=0xFFFF` ZIP64 哨兵 | `error zip64: ...EOCD 含 ZIP64 哨兵值` | 3 | 正确拒绝 |
| e2 | EOCD 前插 ZIP64 定位器 | `error zip64: ...检测到 ZIP64 定位器 0x07064b50` | 3 | 正确拒绝 |
| f | EOCD `diskNo=1` | `error zip-multidisk: ...多磁盘 ZIP 不支持` | 3 | 正确拒绝 |
| g | 中央目录 `uncompSize = 256MiB+1` | `error zip-too-large: ...超过 268435456 字节上限` | 3 | 正确拒绝 |
| g2 | 中央目录 `compSize = 256MiB+1` | 同上 | 3 | 正确拒绝 |
| h | 中央目录 CRC 篡改 | `error crc-mismatch: ...CRC-32 不符（解压字节未被写入）` | 3 | 正确拒绝 |
| i | 同日两设备同名 zip、同名条目不同字节 | 排序在后者决定暂存内容：一序 `status=0 merged=1 already-present=1`（静默丢写）；另一序 `status=3 sha-mismatch=2` | 0 或 3 | 顺序相关（P2-1） |

补充：EOCD 扫描下界 `low = Math.max(0, buf.length - (22 + 0xFFFF))`（`:188`）与 16 位注释上限自洽；中央目录区间检查 `cdOff + cdSize > eocd`（`:215`）、本地头签名（`:254`）、数据区越界（`:260`）均实测/静态成立。

---

## 6. 测试质量评估（31 例）

- **是真实契约断言，不是摆设**：全部 31 例都 `execFileSync` 真跑 CLI（`:155-168`），断言落在文件是否存在、字节是否一致、stdout 计数、退出码、暂存现场上。fixture zip 由 `makeZip`（`:44-93`）手写真实 local header / central directory / EOCD；CRC 用测试侧独立实现（`:21-35`）交叉验证工具侧表（工具 `:165-179`），没有 mock 掉解包器。
- **覆盖到位的核心规则**：stored/deflate（01/02）、dedupe（03）、archive 权威（04）、missing 不建空文件（05）、CRC（06）、不支持方法（07）、加密（08）、dry-run 零写（09）、写范围（10）、幂等（11）、existing-different（12）、三类 refusal（13/14/19）、sha16 碰撞（15）、确定性（16）、cross-check 双向（17/27）、算术（18）、折叠与 tie-break（21/22）、ZIP64（23）、无 EOCD（24）、sha 回读不符（25）、裸命名（26）、多日（28）、空计划（29）、entry-sha-conflict（30）、`--force`（31）。
- **missing cases**：见 P2-6 的 7 条点名（路径穿越、256 MiB、多磁盘/ZIP64 哨兵、EOCD 注释、central/local 尺寸不一致、零长度、退出码 1）。其中「not writing outside media」虽有 b2 的间接保障，但没有一条测试直接断言 `entry` 穿越被拒——这正是我在 §5 手工补的。
- **pin 实现琐事**：见 P2-6 第二段。总体占比小，不构成阻塞。
- 31/31 全部通过（门禁 tail 见 §7）。

---

## 7. 门禁 tail（逐字引用）

### 7.1 `node --test apps/arkui-schedule/tools/test/v2MediaMigration.test.mjs`

```
ℹ tests 31
ℹ suites 0
ℹ pass 31
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3720.4201
```

（31 条 `✔`，EXIT=0；例：`✔ 31 --force merges safe entries despite per-entry errors (exit still 3) (87.9987ms)`）

### 7.2 `node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"`

```
✔ ④ 重复调用幂等：第二次不重复搬动、不覆盖用户后续修改 (11.358ms)
✔ ⑤ 标记在但目标不全（上次中断）→ 从旧目录补齐并校验，旧数据不丢 (14.5691ms)
✔ ⑥ 无完成标记但有 pending 标记 + 目标已建且只搬了一半 → 补齐而不是永久 skip（评审 M1） (17.6534ms)
✔ ⑦ 补齐时目标已有同名条目 → 不覆盖用户数据，也不因旧目录残留而永久失败（评审 M3） (14.8962ms)
ℹ tests 2456
ℹ suites 312
ℹ pass 2455
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 27004.7625
```

（EXIT=0；与期望 **2456 / 2455 pass / 0 fail / 1 skip** 完全一致；相对加测试前基线 +31 = 本模块 31 例，亦与 `docs/MODULES.md:73` 记录吻合）

### 7.3 `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json`

无 stdout/stderr 输出：

```
EXIT=0
```

### 7.4 `node apps/arkui-schedule/tools/validate-app.mjs`

```
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 361 条、main 静态 import 456 条、页面 7 个、rawfile/git 2 个文件）
EXIT=0
```

（8/8 符合要求；import 计数与 `docs/项目理解.md` 里 355/448 的旧数字不同，属该文档滞后，不是本模块问题。）

---

## 8. `unverified`

1. **真机 / 第二设备**：v2 §15 要求的两设备并发、app 侧 `媒体待迁移` 占位渲染、导出导入搬运媒体，全部 `unverified`（`hdc list targets` 空、无 DevEco/SDK）。本工具只做离线文件搬运，不涉及 app 代码。
2. **真实 v1 仓库数据**：本次所有实跑均用自造 fixture；未在 Lead 的真实 `devices/**` 上执行 `--dry-run`/`--apply`，真实 zip 可能含 data descriptor、extra field、ZIP 注释（含伪造签名）等 fixture 未覆盖的形态。P2-2 在真实数据上的出现概率未知。
3. **git 状态**：模块是新增未提交文件（`git status --short` 显示 `?? tools/migrate-media-v1-to-v2.mjs`、`?? apps/arkui-schedule/tools/test/v2MediaMigration.test.mjs`）；提交哈希 / revert 路径由 Lead 回填（`docs/MODULES.md:34,95`）。
4. **分支断言**：v2 §11 的 `assertWritable()` 含分支 `main` 检查，本离线工具**只查 schema、不查 git 分支**；与记录迁移工具一致（`migrate-v1-to-v2.mjs:753-763` 同样只查 schema）。判断为「离线一次性工具不属于 §9 同步周期，分支断言属 sync 阶段 0 职责」，但此判断未经契约作者确认，标记 `unverified`。
5. **sha16 碰撞策略**：契约 §14 开放项 1 的推荐是「逐步延长前缀」，实现选择「跳过两方 + `E_MEDIA_SHA16_COLLISION`」；§7 表支持后者，但两处文字的取舍未经 Lead 书面确认，标记 `unverified`（非缺陷）。
6. **行数**：任务书给的 713 / 742 与实测 764 / 749 不一致；`docs/MODULES.md:34` 登记 765。本评审所有 `file:line` 引用以实际读到的文件为准。
7. **未做性能/体积验证**：256 MiB 上限是静态 + 篡改字段验证，没有构造真实大文件测内存峰值（`fs.readFileSync` 整文件入内存，真实 256 MiB zip 的 RSS 未测）。
