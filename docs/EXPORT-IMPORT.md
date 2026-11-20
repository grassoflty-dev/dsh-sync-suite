# 导出 / 导入契约（EXPORT-IMPORT）

**export format is the git format**：设置页「数据」组唯一的 `导出完整包` 按钮把共享时间线导成一份
**repo-shaped bundle**（与 `timeline/**` 同构，`docs/DATA-CONTRACT-v2.md`，含 `media.zip` 与三本账本），
导入把它**只追加**地搬回 `timeline/<date>/`。**没有 Markdown 格式**——`mod-export-json` 已把格式选择器、
Markdown 渲染代码、文案与测试整体删除；v1 兼容的 JSON 文本导入仍保留，但导出格式只有 bundle。
**一个入口（mod-ui-drop-backup）**：原来的独立「日程备份」节已删除——媒体能力并入主导出 / 导入流程，
界面上只有一套按钮；`exportService.ets` 的 bundle 函数原样保留，只是不再由第二个 section 调用。

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 纯逻辑（零 SDK） | `entry/src/main/ets/model/exportImport.ts` | 区间校验、bundle manifest 构建/解析/校验、账本并集、媒体 sha256 预检、v1 JSON 计划与复核、面板状态助手 |
| 文件 IO + zip 桥 | `entry/src/main/ets/services/exportService.ets` | 写 bundle / media.zip（经 `GitSyncService.zipWriteBundle`）、选文件读文本、并发闸 + 写前复核 + 落盘 |
| zip 桥实现 | `entry/src/main/resources/rawfile/git/git-bridge.js` | `zipWrite`（整包重写、固定 DOS 时间、条目 `<date>/<sha16>.jpg`）/ `zipList` / `zipRead` |
| UI | `entry/src/main/ets/components/ExportImportPanel.ets` | 纯展示 + 回调，不做 IO、不做路由；无格式选择器 |
| 测试 | `tools/test/{exportImport,exportImportV2,exportJson}.test.mjs` | v1 JSON 规则、v2 bundle/账本规则、本格式的端到端 round-trip |

**不改既有契约**：`timeline/<date>/records.json` 仍是 `docs/DATA-CONTRACT-v2.md` §3 的规范字节，
三本账本仍是 §7 的 append-only 原文；本功能不新增记录字段、不改字段名、不删任何历史。

---

## 1. 三条硬规则

1. **导出是只读派生**：只读 `timelineStore.readDay()` / `readSummaryText()`，产出 bundle 写进沙箱
   `<filesDir>/exports/v2-<stamp>/`，**绝不动源文件**（不重写、不裁剪、不迁移）。
2. **导入是 append-only**：只在用户确认后，把记录经 `timelineWriteStore` 写进
   `timeline/<date>/records.json`，媒体只增、账本只并集追加；历史字节一个都不改、不删。
   **写盘前必须再复核一次**（见 §3.3）：dry-run 到确认之间本机可能已被别的页面 / 同步写入同 `id`，
   复核会把它们挡在写入之前。
3. **绝不覆盖 / fail-closed**：
   - 同 `id` 且导入记录**更新** → 只计入 `conflict`（统计并显示给人看），**不追加、不改既有行**；
   - 同 `id` 且**更旧或相同** → `skipped`；
   - 任何一条记录非法 / 任何一次 JSON 解析失败 / **任何一张媒体 sha256 不符** → 整包不写。

---

## 2. 导出（格式 = git 格式 bundle）

### 2.1 入口与参数

```ts
// 纯函数（可 Node 跑）
buildV2Manifest({ from, to, exportedAt, days, media, mediaArchive? }): string
buildV2RecordsText(date, records): string             // 规范字节
parseV2Manifest(text): V2ManifestResult
parseDateRange(fromText, toText): { ok, from, to, reason }

// 真实落盘（v2；需要 timelineStore.isMigrated()）
exportV2Timeline({ from, to }, zipBridge): Promise<V2ExportResult>
// v1 兼容 JSON 文本入口仍在（落点同样是 timeline/），但没有 Markdown 分支
exportSchedules({ from, to }): ExportFileResult
```

- `from` / `to`：`YYYY-MM-DD`，**含首尾**，必须是真实存在的日期（`2026-02-30`、`2026-13-01`、`2026-1-1` 全部拒绝）；
  `from > to` 报错「开始日期不能晚于结束日期」；
- **没有 `format` 参数**：Markdown 已删除；v2 用户得到 repo-shaped bundle，v1 兼容入口只产出 JSON；
- `includeAttachments` / `includeMeta` 已随 Markdown 删除；媒体由 bundle 的 `media.zip` 统一搬运；
- 空区间**也成功**（manifest `dayCount:0`、空的 `media.zip`）。

### 2.2 Bundle 布局（逐字契约，见 §7.3）

```
v2-<stamp>/
  manifest.json                 {bundleVersion:2, schemaVersion:2, kind:'dsh-schedule-v2',
                                 range, exportedAt, dayCount,
                                 days:[{date,recordCount,hasSummary,ledgers:[{name,bytes}×3]}],
                                 media:[{file,sha256,bytes,date}],
                                 mediaArchive:{name:'media.zip',sha256,bytes,entries}}
  timeline/<date>/records.json   canonical bytes（与 git 仓库中的文件逐字节相同）
  timeline/<date>/summary.json   仅 when present
  timeline/<date>/deleted.jsonl  逐字节复制（空账本也建文件）
  timeline/<date>/restore.jsonl
  timeline/<date>/conflicts.jsonl
  media.zip                      唯一归档，条目 <date>/<sha16>.jpg
```

**为什么一个 bundle 一个 media.zip（设计决策）**：一个归档让整个 bundle 保持为单一可转移文件，
媒体校验清单集中在一处可审计（manifest.media + mediaArchive.sha256），导入端一次预检即可在写盘前
校验每张图；按天 zip 会重新引入 v2 媒体布局刚刚去掉的「按日归档耦合」，散图则让 bundle 分裂成
一堆文件。zip 条目按 `(date,file)` 排序 + 固定 DOS 时间（1980-01-01），同数据重复导出逐字节相同。

### 2.3 v1 兼容 JSON 逐字结构（仅导入；导出不再产出 Markdown）

```json
{
  "version": 1,
  "exportedAt": "2026-11-18T07:44:00+08:00",
  "range": { "from": "2026-11-01", "to": "2026-11-30" },
  "deviceId": "pad-a",
  "records": [ /* ScheduleRecord，按 (date, ts) 升序，字段原样保留 */ ]
}
```

- 键顺序固定为上面五個；2 空格缩进 + 末尾一个换行；
- `records` 里的对象**原样保留**（不裁剪、不改名、不补默认值），因此 `parseJsonImport` + `planImport`
  能把它逐字段吃回（测试里有 round-trip 断言）；
- 缺 `deviceId`（空/全空白）抛 `导出缺少设备标识（deviceId 不能为空）`——没有来源的导出文件不接受。

### 2.4 导出目录与文件名

- 目录：`<filesDir>/exports/`（应用沙箱，**不在 `git-repo/` 里**，因此不会被 Git 同步推走）；
- v1 兼容 JSON 文件名：`schedule-YYYYMMDD-HHmm.json`；v2 bundle 目录名 `v2-YYYYMMDD-HHmm`；
- **时间戳来自记录**：取本次导出记录里 `ts` 最新的那条的日期+时刻（保留记录自带时区），
  区间内没有可用 `ts` 时才退回当前时间；**不用随机数**，同一份数据重复导出得到同一个名字；
- 同名（同一分钟内再次导出）：按 `-2` / `-3` … 递增（最多到 `-99`，再往后提示清理目录）；
- 面板显示**可读绝对路径**；路径用 `Text(...).copyOption(CopyOptions.LocalDevice)` 渲染，
  **长按即可复制**（不引入 pasteboard API、不新增任何权限）。

---

## 3. 导入

### 3.1 两步流程（UI 强制）

```
选文件 → parseJsonImport（文件级校验）→ planImport（逐条归位，dry-run）
      → 面板显示「将新增 N 条 / 跳过 M 条（同 id 且更旧） / 冲突 K 条（同 id 且更新，不会覆盖） / 非法 J 条」
      → 「确认导入」仅在 N > 0 && J === 0 时可点（且 `busy === false`）
      → appendImportPlan（并发闸 → 写前复核 → 只追加复核后的 added）
```

页面**只允许**通过 `planImportFromText` 拿计划、通过 `appendImportPlan` 落盘；
`exportService` 故意不提供「分析+落盘」一步到位的函数，防止被误用成「选了文件就写」。
「确认」时不要重新 `planImportFromText`（否则统计会和你看到的不一致）——成立的前提是
`appendImportPlan` 内部**自己**复核（它就是这么做的）。

### 3.2 `planImport` 归属表

| 情形 | 归属 | 是否进 `toAppend` |
| --- | --- | --- |
| 新 `id` | `added` | ✅ |
| 同 `id`，导入 `ts` **更新** | `conflict`（`conflictItems` 里有 index/id/两端 ts） | ❌ **绝不覆盖** |
| 同 `id`，导入 `ts` **更旧或相同** | `skipped` | ❌ |
| 字段非法 | `invalid`（`invalidItems` 带 index + 中文原因） | ❌ |

细节：

- `existing` 里同 `id` 可能有多条历史行，比较基准取其中**最新**的 `ts`（即 `foldById` 后的版本）；
- 同一批 `incoming` 里重复出现同一个新 `id`：先到的算 `added`，后到的按上面的规则算 `conflict`/`skipped`
  ——同一 `id` 在同一批里最多追加一次；
- `toAppend` **保持 `incoming` 顺序**（`writePlan` 再按日期分组 `groupImportByDate`、组内 `ts` 排序后一次追加）；
- 逐条字段校验复用 `model/jsonl.ts` 的 `encodeRecord`（唯一校验源），并额外要求：
  扩展字段 `date`（若有）必须是真实日期、`ts` 必须能推出真实日期。

### 3.3 「绝不覆盖」是怎么保证的（六道闸）

1. **计划层**：`planImport` 只把新 `id` 放进 `toAppend`；`conflict`/`skipped`/`invalid` 一条都进不去；
2. **复核层（写盘前）**：`appendImportPlan` 用 `scheduleStore.readAll()` 重读**此刻**的本机记录，
   再用纯函数 `reconcileBeforeAppend(plan.toAppend, existingNow)` 过滤一次——规则与 `planImport`
   完全一致（新 id → `added`；同 id 且导入更新 → `conflict`；更旧/相同 → `skipped`），
   **只有复核后的 `added` 才会被写**。读不到本机记录时 fail-closed（`ok:false`，一个字节不写）。
   这一层挡的是两件事：双击（第二下复核必为空）与「dry-run 之后本机/远端同步写入了同 id」；
3. **并发闸**：模块级 `inFlight`，一次导入在飞时再次调用**直接拒绝**
   （`ok:false` + `reason='正在导入中，请稍候'`），**不排队**——排队只会把两次写都排上。
   闸在 `finally` 里复位，异常也不会卡死后续导入；
4. **编码层**：`writePlan` 先把每个日期要追加的**全部行**编码完（`encodeRecord`），
   任何一条抛错就整批 `ok:false`、一个字节都不写（连目录都不建）；
5. **写入层**：只对 `scheduleStore.dayFilePath(date)`（即 `<本机>/schedules/<date>.jsonl`）
   定位文件末尾写入；上一行没有换行才补 `\n`，历史字节不改；同一天多条**一次**物理追加。
   落盘的 IO 是**注入**的（`ImportWriteIo` 只有建目录 / 取路径 / 末尾追加 / 维护索引四个能力，
   没有覆盖写和截断写），所以「追加路径碰到 `TRUNC`」在类型层面就不可能；
6. **读侧兜底**：即便历史里真有同 `id` 多版本，读取仍是 `parseJsonl` + `foldById`（同 id 取较晚 `ts`），
   导入不会让任何既有版本「消失」。

### 3.4 `parseJsonImport` 拒绝清单（fail-closed）

| 输入 | 结果 |
| --- | --- |
| 空串 / 纯空白 | `ok:false`「导入文件是空的」 |
| 半截 JSON / 非 JSON | `ok:false`「不是合法的 JSON：…」 |
| 顶层是数组 / 标量 / `null` | `ok:false`「顶层必须是 JSON 对象」 |
| 缺 `version` | `ok:false`「缺少 version 字段」 |
| `version !== 1`（含 `"1"` 字符串） | `ok:false`「不认识的版本号（…），本机只认 version=1」 |
| 缺 `records` / `records` 不是数组 | `ok:false`「缺少 records 数组」 |
| 合法但 `records: []` | `ok:true`（dry-run 四类全 0 → 面板「没有可导入的记录」） |

带 UTF-8 BOM 的文件可以读（电脑端导出的 JSON 常带 BOM）。

### 3.5 读文件

- `pickImportFile(context)`：系统文件选择器（`@kit.CoreFileKit` 的 `picker`），只筛 `.json`，**不新增权限**；
- 读取方式：`openSync(uri, READ_ONLY)` + `statSync(fd)` + `readSync` + `decodeUtf8`（纯函数，见下）；
- 大小上限 `16MB`，超过直接拒绝；用户取消 / 读失败返回 `ok:false` + 中文原因；
- `decodeUtf8` 不依赖 `util.TextDecoder`（避免把 `@kit.ArkTS` 拖进共享层），非法字节给 `U+FFFD`，
  随后会被 JSON 解析的 `ok:false` 拦住。

### 3.6 落盘结果

```ts
appendImportPlan(plan): {
  ok, appended, skipped, conflict, invalid, files, reason,
  reconfirmed: { added, skipped, conflict }   // 写盘前复核出来的「这一次」的归属
}
```

- `files`：实际追加到的**绝对路径**（按日期，顺序稳定）；
- `appended`：**已经写下**的条数（复核后 `added` 有多少就写多少；半批失败时只算已写下的）；
- `reconfirmed`：`reconcileBeforeAppend` 的计数；顶层的 `skipped` / `conflict` 已把它加上
  （它们表示「这一次确认」的最终归属，`reconfirmed` 单独留一份方便面板区分 dry-run 与复核）；
- 被并发闸挡下时 `ok:false` + `reason='正在导入中，请稍候'`，`files` 为空、`reconfirmed` 全 0；
- 复核后一条都不剩（典型：双击的第二下）时 `ok:true` + `appended:0` + `files:[]`，
  **不会**再产生任何物理追加；
- 追加成功后调用 `openIndexStore.applyRecord` 逐条维护 `open.jsonl`（派生数据；失败不影响已写入的日程，
  也不会把 `ok` 翻转成 false）；
- 部分写入失败时 `ok:false` 且 `appended`/`files` 如实报告已写入的部分（不会谎报全成功）。

---

## 4. UI 组件 `ExportImportPanel`

只展示 + 回调，**不含** IO / 路由 / services 引用。可编辑项只有区间，在组件本地两个 `@State`
承接，初始值来自 `state`，导出时随 `ExportRequest` 回传给页面。**组件是唯一入口**，没有第二个
「备份」section；`mod-ui-drop-backup` 删除了 `V2Section` / 四个 `onV2*` 回调 / 四份 `v2*` 展示状态。

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `state` | `@Prop ExportImportState` | 区间初值、dry-run 计数、导出路径、提示文案、`busy` |
| `onExport` | `(request: ExportRequest) => void \| null` | 用户点唯一的「导出完整包」；`ExportRequest` = `{fromText,toText}`，页面据此调 `exportV2Timeline` 产出含媒体的 bundle |
| `onPickFile` | `(() => void) \| null` | 用户点「选择 / 重新选择文件」；页面先按完整包 manifest 试算，不是完整包再回落兼容 JSON |
| `onConfirmImport` | `(() => void) \| null` | 用户点「确认导入」（组件内部已用 `canConfirmImport` 挡住不可点的情形；页面按计划类型分派 `applyV2Import` / `appendImportPlan`） |
| `onCancel` | `(() => void) \| null` | 用户点「取消」 |
| `onCopyPath` | `(() => void) \| null` | 可选：传了才渲染「复制路径」按钮（默认靠长按复制） |

按钮可用性、统计文案、提示文案全部由纯函数产出（与测试同源）：
`canConfirmImport(state)`、`dryRunSummary(state)`、`importBlockedTip(state)`、`isDryRunEmpty(state)`。

### 4.1 挂载片段（给 `pages/Settings.ets`，mod-ui-drop-backup 后）

```ts
// 1) 一个展示状态 + 两份互斥的待确认计划（pendingV2Plan !== null → 完整包）
@State exportImport: ExportImportState = defaultExportImportState();
private pendingImport: ImportPlan | null = null;          // 兼容 JSON
private pendingV2Plan: V2ImportPlan | null = null;        // 完整包（含媒体）
private pendingV2BundleDir: string = '';

// 2) 主导出：区间来自面板，产物是 repo-shaped bundle（记录 + 媒体 + 账本）
private async handleExport(request: ExportRequest): Promise<void> {
  this.exportImport = withPanelMessage(this.exportImport, '', true);
  const input: ExportRequestInput = { from: request.fromText, to: request.toText };
  const zip: V2ZipBridge = new SettingsZipBridge(this.sync);   // ArkTS 显式适配器
  const result: V2ExportResult = await exportV2Timeline(input, zip);
  this.exportImport = result.ok
    ? withExportPath(withPanelMessage(this.exportImport, `已导出完整包…`, false), result.dirPath)
    : withPanelMessage(this.exportImport, `导出失败：…`, false);
}

// 3) 选文件：先按完整包试算，不是完整包再回落兼容 JSON（两者都只算不写）
const bundled: V2ImportPlanResult = planV2ImportFromPicked(picked.text, picked.uri);
if (bundled.ok && bundled.plan !== null) {
  this.pendingV2Plan = bundled.plan;
  this.pendingV2BundleDir = bundled.bundleDir;
  // 用 withBundleDryRun 把天数/记录数写回同一份 ExportImportState，确认按钮仍走 canConfirmImport
} else {
  const planned = planImportFromText(picked.text, picked.fileName);
  this.pendingImport = planned.plan;
}

// 4) 确认：同一按钮按计划类型分派；完整包先弹显式确认框再 applyV2Import
if (this.pendingV2Plan !== null) {
  this.confirmBundleImport();       // promptAction.showDialog → applyV2Import(plan, bundleDir, zip)
} else {
  const applied = appendImportPlan(this.pendingImport!);
}

// 5) 装配：数据组只有一个 ExportImportPanel（没有第二个 section）
ExportImportPanel({
  state: this.exportImport,
  onExport: (request: ExportRequest): void => { this.handleExport(request); },
  onPickFile: (): void => { this.handlePickImportFile(); },
  onConfirmImport: (): void => { this.handleConfirmImport(); },
  onCancel: (): void => { this.handleCancelImport(); },
  onCancelWait: (): void => { /* 只复位 busy，语义是「停止等待」不是「已取消」 */ },
  onCopyPath: (): void => { this.handleCopyPath(); }
})
```

> 注意：`onConfirmImport` 必须用**用户看过的那份计划**落盘（完整包用 `pendingV2Plan`，兼容 JSON 用
> `pendingImport`），不要在确认时重新解析——两次读取之间本机记录可能已被其它页面改动。
>
> 「不重解析」不等于「不复核」：`appendImportPlan` 与 `applyV2Import` 内部都会**重读本机**再复核
> （§3.3 第 2 道闸 / §7.3 媒体预检），所以过期计划不会造成重复追加或覆盖媒体。
> `busy` 置位/复位是 UI 第一道闸，模块级 `inFlight` 是第二道闸——**两道都要**。
>
> 已删除：`V2Section` 整段（空态 / 四个 ActionButton / 忙碌 / 计划行 / 备份提示）、
> `v2PlanReady` / `v2PlanText` / `v2Message` / `v2Busy` 四份状态、`onV2Export` / `onV2Pick` /
> `onV2Apply` / `onV2Cancel` 四个回调，以及 `handleV2*` 四个页面 handler（现只保留
> `confirmBundleImport` 作为完整包确认分支）。服务层函数未删，仍由主流程调用。

---

## 5. 边界：明确不做的事

| 不做 | 原因 |
| --- | --- |
| 不导出附件二进制 | v2 媒体统一进 `media.zip`（条目 `<date>/<sha16>.jpg`），不保留按天附件 zip 的耦合；v1 兼容 JSON 的 `attachments` 字段原样保留 |
| 不导出 `summaries/`、`open.jsonl` | 它们是派生数据，可由日程重算；导出它们只会制造第二事实来源 |
| 不生成 Markdown | 格式已删除：v2 导出是 git 格式 bundle，v1 兼容文本导入只认 `version:1` 的 JSON |
| 不做「同 id 覆盖」 | 覆盖 = 改历史语义；更新的记录只报告成 `conflict`，由人决定 |
| 不写别的设备目录 | 只写 `<self>/schedules/`；跨设备数据靠 Git 同步，不靠导入 |
| 不迁移旧数据 / 不改 schema | 导出导入不改 §3 的字段；旧记录（散图附件等）原样进原样出 |
| 不新增权限 | 选文件用系统 picker；复制路径用 `copyOption` |
| 不把导出文件放进 Git 仓库 | `<filesDir>/exports/` 在 `git-repo/` 之外，不会被 `push` 带走 |

已知限制：

- 导出只覆盖**本机**记录（`scheduleStore.readAll()`）；「含其他设备」是首页的展示开关，不参与导出；
- 导出不折叠 `id`：调用方应传已折叠列表（`readAll()` 就是）；手工传原始多版本会按版本各占一行；
- 同名导出文件的序号后缀是**本地文件系统**层面的行为，不写进文件内容；
- 导出格式固定为 JSON / git bundle（原 Markdown 导出与 `includeAttachments` / `includeMeta` 开关已删除）；
  来源设备 / `tags` 等扩展字段若现网数据没有就不写，不虚构。

---

## 6. 验证

```bash
cd apps/arkui-schedule
node ..\..\node_modules\typescript\bin\tsc -p tools\tsconfig.json   # 纯逻辑层编译（exit 0）
node --test tools\test\exportImport.test.mjs                        # v1 JSON / 导入规则（Markdown 11 例已删）
node --test tools\test\exportImportV2.test.mjs tools\test\exportJson.test.mjs  # v2 bundle + 本格式 round-trip
node tools\validate-app.mjs                                         # 8/8
```

测试覆盖（节选）：空区间导出、区间过滤与排序、JSON / git bundle round-trip（manifest + timeline/**
逐字节相等 + 媒体 sha256 逐张相等）、确定性（两次导出逐字节相同）、`manifest.mediaArchive`
整包 sha256 / 逐张 sha256 篡改零写入、旧 bundle 散图导入 + informational note、服务层同款 io
构造（P1-1）、`parseJsonImport` 的 12 类坏输入、`planImport` 的三种同 id 归属、
9 类非法字段、5000 条 < 2000ms 且保序、`exportFileStamp`、`decodeUtf8`、面板状态助手；
**落盘契约（fake store / fake 写入器注入）**：只追加（无 `TRUNC`，历史行逐字节不变）、
同一天多条只一次物理追加、第 2 个日期失败时 `ok:false` + `files` 只含已写文件 + 已写内容完整、
编码失败零写入、索引异常不翻转 `ok`；**复核（M2）**：`reconcileBeforeAppend` 的三种归属、
同批复核去重、双击端到端不产生第二次物理追加、`.ets` 侧「重读 → 复核 → 写入」顺序与并发闸的源码级断言。

---

## 7. v2 bundle 版本与按日账本（`mod-export-v2-ledgers`）

v2 bundle（沙箱 `<filesDir>/exports/v2-<stamp>/`，不进 Git）在原 `manifest.json` 基础上增加**最外层** `bundleVersion`，并为每个导出日增加三本账本文件；其余 bundle 内容（records/summary/media、键序、确定性排序）**逐字节不变**。

```
v2-<stamp>/
  manifest.json                        # bundleVersion, schemaVersion, kind, range, exportedAt, dayCount, days, media
  timeline/<date>/records.json
  timeline/<date>/summary.json         # 存在才写
  timeline/<date>/deleted.jsonl        # 逐字节复制源仓库，空账本也建文件
  timeline/<date>/restore.jsonl
  timeline/<date>/conflicts.jsonl
  media.zip                            # mod-export-json：唯一归档，条目 <date>/<sha16>.jpg
```

- manifest 的 `days[]` 每天增 `ledgers: [{name, bytes}, …]`，恒三项、顺序固定 `deleted.jsonl` / `restore.jsonl` / `conflicts.jsonl`，`bytes` 为该账本 UTF-8 字节数（空账本为 0）；
- 账本从源仓库 **append-only 逐字节复制**（不解析、不重排、不重写历史行），与 `DATA-CONTRACT-v2.md` §7 P2-3 的「旧字节是新字节严格前缀」一致；
- 确定性不变：days 按 date、ledgers 按固定名序、records 按 `(ts,id)`、media 按 `(date,file)`；同数据重复导出逐字节相同。

### 7.1 Bundle/version rule（mod-drop-v1）

> 只支持当前一种 bundle：bundleVersion: 2，必须同时带 media.zip 与三本按日账本。
> 任何 bundleVersion !== 2（缺失 / 1 / >2 / 畸形）均以 typed E_BUNDLE_VERSION 拒绝，
> 零计划、零写入。旧 bundle（缺 media.zip / 缺账本）**不支持**，不再降级导入、不再返回 informational note。

中文说明：
- bundleVersion: 2：三本账本与目标已有账本做**并集**，只追加目标里没有的新行；
  mergeV2LedgerText() 保证目标已有字节恒为新字节前缀，delete/restore 按 (id,ts)、
  conflicts 按 (id,ts,dedupeKey) 去重，坏行按整行去重；重复导入零新增（幂等）。
  records/summary/media 规则不变（media 只增、预检 sha256 不变）。
- 非 2 的 bundleVersion 一律 typed E_BUNDLE_VERSION；下一步：用当前版本工具重新导出一份完整备份。
- schemaVersion 仍固定为 2、规则不变（非 2 仍是 E_SCHEMA_UNKNOWN）。

### 7.2 验证（`tools/test/exportImportV2.test.mjs`）

新增覆盖：v2 bundle 含三本账本（含空账本）与字节数声明、旧 bundle（缺字段/1）不拒绝且带 note、并集去重与不截断、未来版本 `E_BUNDLE_VERSION`、账本乱序声明仍确定性、round-trip（空目标账本逐字节相等；已有目标行并集 + 重放幂等）。v1 导出/导入测试 `exportImport.test.mjs` 只随 Markdown 删除做了定点删测（11 例）与格式默认值 retarget（2 例），JSON/导入规则用例保持原样。

### 7.3 `mod-export-json`：repo-shaped bundle 的媒体布局与校验

**布局与理由**（与 `model/exportImport.ts` v2 节头注释同源）：导出就是 git 格式——
`manifest.json` + `timeline/<date>/{records.json,summary.json,deleted.jsonl,restore.jsonl,conflicts.jsonl}` +
**一个** `media.zip`（条目 `<date>/<sha16>.jpg`）。manifest 顶层键序固定
`bundleVersion, schemaVersion, kind, range, exportedAt, dayCount, days, media, mediaArchive`；
`media[]` 逐张列 `{file,sha256,bytes,date}`，`mediaArchive` 列 `{name:'media.zip',sha256,bytes,entries}`。
一个归档让 bundle 保持单一可转移文件、媒体校验清单集中一处可审计；按天 zip 会重新引入 v2 媒体布局
刚刚去掉的「按日归档耦合」，散图会让 bundle 分裂成一堆文件。

**确定性**：zip 条目按 `(date,file)` 排序，桥 `zipWrite` 用固定 DOS 时间（1980-01-01）+
STORE 压缩，因此同一份数据两次导出的 manifest / media.zip / 日文件逐字节相同（测试钉死）。

**Bundle/version rule（续 §7.1）**：只支持 bundleVersion:2 且带 media.zip 的当前 bundle；缺 mediaArchive 或 bundleVersion!==2 一律 typed E_BUNDLE_VERSION，不再从按日散图 / 按日 zip 降级导入。

**媒体校验规则（fail-closed，零写入）**：
1. dry-run 读回 `media.zip` 字节，先比对整包 `mediaArchive.sha256` / `bytes`；不符 → `E_MEDIA_CORRUPT`；
2. 用户确认后，`applyV2Import` 用 zip 桥**异步预取全部条目字节**，任一条目读不出 / 缺失 → `E_MEDIA_CORRUPT`；
3. 预取字节交给同步的 `checkV2MediaIntegrity`：逐张比对 manifest.sha256，不符 / 目标同名内容不同 →
   `E_MEDIA_CORRUPT` / `E_MEDIA_COLLISION`；**所有校验发生在任何 records/summary/media/账本写入之前**；
4. 校验通过的字节原样写入（不二次读源），消除「验完再读」的竞态；媒体只增，不覆盖、不删除。

验证：`tools/test/exportJson.test.mjs`（真 zip 桥 + 两天 fixture）覆盖 round-trip 逐字节相等、
篡改条目零写入、旧 bundle note、未来版本拒绝、确定性。真机 / 第二设备行为 `unverified`。
