# 导出 / 导入契约（EXPORT-IMPORT）

设置页的「导出 / 导入」：把本机日程导成 **Markdown / JSON** 文件，或把一份 JSON 导出文件
**只追加**地导回本机。本文是唯一事实来源，实现见：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 纯逻辑（零 SDK） | `entry/src/main/ets/model/exportImport.ts` | 区间校验、Markdown/JSON 渲染、`parseJsonImport`、`planImport`、UTF-8 解码、面板状态助手 |
| 文件 IO | `entry/src/main/ets/services/exportService.ets` | 写导出文件、选文件读文本、按计划追加、维护未完成索引 |
| UI | `entry/src/main/ets/components/ExportImportPanel.ets` | 纯展示 + 回调，不做 IO、不做路由 |
| 测试 | `tools/test/exportImport.test.mjs` | 56 个用例钉住下面的规则 |

**不改既有契约**：日程 JSONL 仍是 `docs/DATA-CONTRACT.md` §3（一行一条、只追加），
未完成索引仍是 §4bis；本功能不新增记录字段、不改字段名、不写 `summaries/`、不碰附件二进制。

---

## 1. 三条硬规则

1. **导出是只读派生**：只读 `scheduleStore.readAll()`，产出文本写进沙箱 `exports/`，
   **绝不动源文件**（不重写、不裁剪、不迁移）。
2. **导入是 append-only**：只在用户确认后，把 `toAppend` 里那些「本机没有的新 id」追加到
   `devices/<本机>/schedules/YYYY-MM-DD.jsonl` 末尾；历史行一个字节都不改，别的设备目录永不被写。
3. **绝不覆盖 / fail-closed**：
   - 同 `id` 且导入记录**更新** → 只计入 `conflict`（统计并显示给人看），**不追加、不改既有行**；
   - 同 `id` 且**更旧或相同** → `skipped`；
   - 任何一条记录非法 / 任何一次 JSON 解析失败 → 整批不写（连「写一半」都不允许）。

---

## 2. 导出

### 2.1 入口与参数

```ts
// 纯函数（可 Node 跑）
renderMarkdownExport({ from, to, records, includeAttachments?, includeMeta? }): string
buildJsonExport({ from, to, deviceId, records, exportedAt? }): string
parseDateRange(fromText, toText): { ok, from, to, reason }

// 真实落盘（需要 scheduleStore 已 ready）
exportSchedules({ from, to, format, includeAttachments, includeMeta }): ExportFileResult
```

- `from` / `to`：`YYYY-MM-DD`，**含首尾**，必须是真实存在的日期（`2026-02-30`、`2026-13-01`、`2026-1-1` 全部拒绝）；
  `from > to` 报错「开始日期不能晚于结束日期」；
- `format`：`'markdown' | 'json'`，未知值按 `markdown`（人能直接读的那一种）；
- `includeAttachments` / `includeMeta` 默认 **false**；
- 空区间**也成功**，产出一份只有标题与占位行的文件。

### 2.2 Markdown 逐字格式

```
# 日程导出 2026-11-01 ~ 2026-11-30

## 2026-11-03（周二）
- [ ] 09:30 写周报　`id=abc123`
- [x] 14:00 体检　`id=def456`
```

规则：

| 规则 | 说明 |
| --- | --- |
| 已完成 / 未完成 | `[x]` / `[ ]`；**不再追加「（已完成）」**（复选框已经表达了，不重复） |
| 时间 | 有 `HH:MM` 才写（`ts` 只有日期就不写）；时刻取自 `ts` 自带时区，**不做本机换算** |
| id | 每行末尾全角空格 + `` `id=<记录 id>` ``（便于人回到原始 JSONL 行；示例里第二行省略只是排版简写） |
| 排序 | 日期升序 → 同日 `ts` 升序 |
| 星期 | `（周二）`；由 `model/calendar.ts` 的纯整数算法推得，不碰 `Date`/时区 |
| 空数据 | 标题下一行 `（该区间没有记录）`，不输出任何 `##` 小节 |
| 标题为空 | 渲染 `（无标题）`；标题里的换行压成空格（一条记录只能占一行） |
| 非法日期记录 | 直接不进导出（不产出 `## 2026-02-30` 这种假日期小节） |

`includeAttachments: true` 时文末追加：

```
## 附件清单
- 2026-11-03 · 09:30 · 写周报 · page-1.png · 第 1 页 · entry=page-1-1a2b3c4d.jpg · bytes=20480
```

- `entry` / `bytes` **存在才写**（`bytes` 不是 `§3` 的契约字段，只有数据真带了数字才写，绝不写 `bytes=undefined`）；
- 一条附件都没有 → 该小节下写 `（无附件）`。

`includeMeta: true` 时每条记录后追加一行缩进元信息：

```
  > tags=会议,重要 · author=我 · 来源设备=pc-a
```

- `tags`（`string[]` 或 `string`）与「来源设备」（`device` / `sourceDevice` / `deviceId` 取第一个非空）
  都**不是** `ScheduleRecord` 的必填字段：**有才写，没有就不猜**；
- 三个字段都没有则整行不渲染。

### 2.3 JSON 逐字结构

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
- 文件名：`schedule-YYYYMMDD-HHmm.md` / `.json`；
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
      → 「确认导入」仅在 N > 0 && J === 0 时可点
      → appendImportPlan（真正追加）
```

页面**只允许**通过 `planImportFromText` 拿计划、通过 `appendImportPlan` 落盘；
`exportService` 故意不提供「分析+落盘」一步到位的函数，防止被误用成「选了文件就写」。

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
- `toAppend` **保持 `incoming` 顺序**（服务层再按日期分组、组内 `ts` 排序后一次追加）；
- 逐条字段校验复用 `model/jsonl.ts` 的 `encodeRecord`（唯一校验源），并额外要求：
  扩展字段 `date`（若有）必须是真实日期、`ts` 必须能推出真实日期。

### 3.3 「绝不覆盖」是怎么保证的（四道闸）

1. **计划层**：`planImport` 只把新 `id` 放进 `toAppend`；`conflict`/`skipped`/`invalid` 一条都进不去；
2. **编码层**：`appendImportPlan` 先把每个日期要追加的**全部行**编码完（`encodeRecord`），
   任何一条抛错就整批 `ok:false`、一个字节都不写；
3. **写入层**：只对 `scheduleStore.dayFilePath(date)`（即 `<本机>/schedules/<date>.jsonl`）
   定位文件末尾写入；上一行没有换行才补 `\n`，历史字节不改；同一天多条**一次**物理追加；
4. **读侧兜底**：即便历史里真有同 `id` 多版本，读取仍是 `parseJsonl` + `foldById`（同 id 取较晚 `ts`），
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
appendImportPlan(plan): { ok, appended, skipped, conflict, invalid, files, reason }
```

- `files`：实际追加到的**绝对路径**（按日期，顺序稳定）；
- 追加成功后调用 `openIndexStore.applyRecord` 逐条维护 `open.jsonl`（派生数据；失败不影响已写入的日程）；
- 部分写入失败时 `ok:false` 且 `appended`/`files` 如实报告已写入的部分（不会谎报全成功）。

---

## 4. UI 组件 `ExportImportPanel`

只展示 + 回调，**不含** IO / 路由 / services 引用。可编辑项（区间、格式、两个开关）在组件本地
`@State` 承接，初始值来自 `state`，导出时随 `ExportRequest` 回传给页面。

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `state` | `@Prop ExportImportState` | 区间初值、格式、开关、dry-run 计数、导出路径、提示文案、`busy` |
| `onExport` | `(request: ExportRequest) => void \| null` | 用户点「导出」；`ExportRequest` = `{fromText,toText,format,includeAttachments,includeMeta}` |
| `onPickFile` | `(() => void) \| null` | 用户点「选择 / 重新选择 JSON 文件」 |
| `onConfirmImport` | `(() => void) \| null` | 用户点「确认导入」（组件内部已用 `canConfirmImport` 挡住不可点的情形） |
| `onCancel` | `(() => void) \| null` | 用户点「取消」 |
| `onCopyPath` | `(() => void) \| null` | 可选：传了才渲染「复制路径」按钮（默认靠长按复制） |

按钮可用性、统计文案、提示文案全部由纯函数产出（与测试同源）：
`canConfirmImport(state)`、`dryRunSummary(state)`、`importBlockedTip(state)`、`isDryRunEmpty(state)`。

### 4.1 挂载片段（给 `pages/Settings.ets`）

```ts
// 1) 页面顶部 import
import { ExportImportPanel } from '../components/ExportImportPanel';
import {
  applyPlan, clearDryRun, defaultExportImportState, withExportPath, withImportFileName, withPanelMessage
} from '../model/exportImport';
import type { ExportImportState, ExportRequest, ImportPlan } from '../model/exportImport';
import { appendImportPlan, exportSchedules, pickImportFile, planImportFromText } from '../services/exportService';
import { common } from '@kit.AbilityKit';

// 2) 页面状态（一个展示状态 + 一份待确认的计划）
@State exportImport: ExportImportState = defaultExportImportState();
private pendingImport: ImportPlan | null = null;

// 3) 在「关于 / 数据」分组里挂一行（真实渲染位置由 Settings 决定）
ExportImportPanel({
  state: this.exportImport,
  onExport: (request: ExportRequest) => {
    this.exportImport = withPanelMessage(this.exportImport, '', true);
    const result = exportSchedules(request);   // ExportRequest 字段名与 ExportRequestInput 一致，可直接透传
    this.exportImport = result.ok
      ? withExportPath(withPanelMessage(this.exportImport, `已导出 ${result.recordCount} 条`, false), result.path)
      : withPanelMessage(this.exportImport, result.reason, false);
  },
  onPickFile: () => {
    this.exportImport = withPanelMessage(this.exportImport, '', true);
    const context = getContext(this) as common.UIAbilityContext;
    pickImportFile(context).then((picked) => {
      if (!picked.ok) {
        this.exportImport = withPanelMessage(this.exportImport, picked.reason, false);
        return;
      }
      const planned = planImportFromText(picked.text, picked.fileName);
      this.pendingImport = planned.plan;
      if (planned.plan === null) {
        this.exportImport = withPanelMessage(this.exportImport, planned.reason, false);
        return;
      }
      const tip = planned.plan.conflict > 0 ? '有冲突记录：本机版本不会被覆盖' : '';
      this.exportImport = applyPlan(
        withImportFileName(withPanelMessage(this.exportImport, tip, false), picked.fileName),
        planned.plan
      );
    });
  },
  onConfirmImport: () => {
    if (this.pendingImport === null) {
      return;
    }
    const applied = appendImportPlan(this.pendingImport);
    this.pendingImport = null;
    this.exportImport = withPanelMessage(
      this.exportImport,
      applied.ok ? `已追加 ${applied.appended} 条、跳过 ${applied.skipped} 条、冲突 ${applied.conflict} 条` : applied.reason,
      false
    );
  },
  onCancel: () => {
    this.pendingImport = null;
    this.exportImport = clearDryRun(withPanelMessage(this.exportImport, '', false));
  }
})
```

> 注意：`onConfirmImport` 必须用**用户看过的那份计划**（`pendingImport`）落盘，
> 不要在确认时重新 `planImportFromText`——两次读取之间本机记录可能已被其它页面改动，
> 重新规划会得到与用户看到的统计不一致的结果。

---

## 5. 边界：明确不做的事

| 不做 | 原因 |
| --- | --- |
| 不导出附件二进制 | 附件在 `attachments/<date>.zip`，属 §4ter；导出只列清单（`Markdown` 的附件小节 / JSON 的 `attachments` 字段原样） |
| 不导出 `summaries/`、`open.jsonl` | 它们是派生数据，可由日程重算；导出它们只会制造第二事实来源 |
| 不导入 Markdown | Markdown 是给人看的；导入只认 `version:1` 的 JSON（文本解析出错就是脏数据） |
| 不做「同 id 覆盖」 | 覆盖 = 改历史语义；更新的记录只报告成 `conflict`，由人决定 |
| 不写别的设备目录 | 只写 `<self>/schedules/`；跨设备数据靠 Git 同步，不靠导入 |
| 不迁移旧数据 / 不改 schema | 导出导入不改 §3 的字段；旧记录（散图附件等）原样进原样出 |
| 不新增权限 | 选文件用系统 picker；复制路径用 `copyOption` |
| 不把导出文件放进 Git 仓库 | `<filesDir>/exports/` 在 `git-repo/` 之外，不会被 `push` 带走 |

已知限制：

- 导出只覆盖**本机**记录（`scheduleStore.readAll()`）；「含其他设备」是首页的展示开关，不参与导出；
- 导出不折叠 `id`：调用方应传已折叠列表（`readAll()` 就是）；手工传原始多版本会按版本各占一行；
- 同名导出文件的序号后缀是**本地文件系统**层面的行为，不写进文件内容；
- `includeMeta` 的 `tags` / 来源设备依赖记录上的扩展字段，现网数据如果没有就只写 `author`。

---

## 6. 验证

```bash
cd apps/arkui-schedule
node ..\..\node_modules\typescript\bin\tsc -p tools\tsconfig.json   # 纯逻辑层编译（exit 0）
node --test tools\test\exportImport.test.mjs                        # 56 用例 / 全部通过
node tools\validate-app.mjs                                         # 8/8
```

测试覆盖（节选）：空区间导出、区间过滤与排序、`[x]/[ ]`、无 time、`includeAttachments`、
`includeMeta`、JSON round-trip、`parseJsonImport` 的 12 类坏输入、`planImport` 的三种同 id 归属、
9 类非法字段、5000 条 < 2000ms 且保序、`exportFileStamp`、`decodeUtf8`、面板状态助手。
