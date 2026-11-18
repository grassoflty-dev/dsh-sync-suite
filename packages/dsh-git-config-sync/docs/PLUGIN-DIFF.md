# 差异预览（sync 前）+ 回滚两步确认（restore 前）

本文是 `previewDiff` / `rollbackPreview` 两个只读 action、`engine/diff.ts` 纯函数，以及设置页
「差异预览 / 回滚到上次快照」交互的契约。写实现或改 UI 前先读这一份，行为以本文 + 测试为准。

- 代码：`src/engine/diff.ts`、`src/engine/preview.ts`（新增导出）、`src/engine/restore.ts`（新增导出）、
  `src/rpc.ts`（新增 action）、`src/client.js`（同步 section）
- 测试：`test/diff.test.mjs`、`test/rollback-ux.test.mjs`

---

## 1. `engine/diff.ts`：纯函数，零 I/O，绝不抛异常

```ts
type FileChangeKind = 'added' | 'modified' | 'deleted' | 'same'

interface FileDiffStat {
  path: string
  kind: FileChangeKind
  addedLines: number
  removedLines: number
  beforeBytes: number
  afterBytes: number
  truncated?: boolean   // 附加字段：二进制 / >512KB / 行数预算耗尽
}

interface DiffSummary {
  files: FileDiffStat[]
  totals: { added; modified; deleted; same; addedLines; removedLines }
}

interface UnifiedHunk { path: string; header: string; lines: string[]; truncated: boolean }

diffText(before, after, options?: { contextLines?: number; maxLines?: number; path?: string })
  → { addedLines, removedLines, hunks, truncated }   // truncated 是**顶层**字段（M1）
diffFiles(before: Record<string,string>, after: Record<string,string>, options?)
  → DiffSummary
summarize(summary: DiffSummary) → string   // 「3 个文件变更（+12 / -4 行），1 个新增，1 个删除」
summarizeFiles(files: FileDiffStat[]) → DiffSummary   // 仅供 host 侧聚合，避免重算 diff
```

规则：

| 规则 | 行为 |
| --- | --- |
| 切行 | 只按 `\n` 切；行尾 `\r` 只影响展示，不参与比较（纯 CRLF 差异**不算**变更） |
| 末尾换行 | 末行有无换行属于内容差异，hunk 里补 `\ No newline at end of file` |
| 相同行 | 不进 hunk；相隔 ≤ `2 * contextLines` 的改动合并成一个 hunk |
| 默认值 | `contextLines = 3`，`maxLines = 200`（hunk 正文总行数，超出即 `truncated: true` 并停止） |
| 二进制 / 超长 | 含 NUL 或 > 512KB：只给 `kind` + 字节数，不产出 hunk；`FileDiffStat.truncated = true` |
| 预算超限 | 中间段 LCS 超过 100 万格时降级为「整段替换」：行数按两侧行数计，hunks 是一个 truncated 占位 |
| 异常 | 任何异常（入参不是字符串/对象、内部断言失败）→ 空结果（`0/0` + `hunks: []`），**绝不向上抛** |

`maxLines` 只截 hunk 文本，**不截行数统计**：结论（+12/-4）始终是完整语义，
用户看到的 hunk 只是"前 N 行"。

两级截断标记（M1，**消费方必须看顶层那个**）：

| 字段 | 语义 | 可靠性 |
| --- | --- | --- |
| `hunks[].truncated` | **这一段** hunk 的正文被预算裁掉了尾巴 | 只能发现"被裁一半" |
| `diffText(...).truncated` | **还有差异没展示**：单 hunk 被裁，或预算用尽后整段 hunk 被丢弃 | 唯一可靠的"没看全"信号 |

为什么需要顶层字段：预算可能在某个 hunk **末尾恰好用完**，随后的 range 直接 `break` 且**不产出**
任何 hunk，于是每个已产出的 hunk 都是 `truncated: false`——只看 `hunks[].truncated` 会静默少显示差异。
`truncated` 只在"hunk 文本因预算没放全"时为 true；二进制 / >512KB 的"只给统计"由
`FileDiffStat.truncated` 表达（那种文件本来就按规则不产出 hunk，不算预算截断）。
LCS 超预算降级成占位 hunk 时，顶层 `truncated` 同样为 true。

> 与需求原文的差异：`FileDiffStat.truncated` 是**新增可选字段**。原文要求"二进制/超长只给
> kind 与字节数、`hunks: []` 且标记 `truncated: true`"，而 `truncated` 原本只存在于 `UnifiedHunk`
> 上——在没有 hunk 的情况下无处安放。这里把它放到文件级统计上，UI 用它渲染
> 「二进制或过大：只给统计」徽标。

## 2. `previewDiff`（只读）

请求：`{ action: 'previewDiff', sourceDevice?: string }`，响应 `{ok:true, data}`：

```ts
interface PreviewDiffData {
  sourceDevice: string
  local: boolean
  summary: DiffSummary
  hunks: UnifiedHunk[]
  truncated: boolean   // 「还有差异没展示」：任一文件的 hunk 被预算裁掉/整段丢弃
}
```

`truncated` 的聚合口径（M1）：本机模式对每个非 `same`、非二进制文件跑 `diffText`，任一返回
`truncated: true` 即整体为 true；远端模式取 `fileDiffOfPreview` 的聚合值（逐 entry 相同口径）。

两种模式：

| 条件 | 对比对象 | 粒度 |
| --- | --- | --- |
| `sourceDevice` 缺省，或等于本机 `deviceId` | 本地工作副本 `~/.dsh/git-config-sync/work/<repoHash>/devices/<deviceId>/`（上次 push 的内容）vs 当前 profile 的 `collectLocal` 结果 | 真文件级（四个同步文件，路径如 `cordis.patch.yml`） |
| 给了其它 `deviceId` | 远端该设备快照（走 `buildPreview` 的读取与 manifest sha256 校验）vs 本机采集结果 | entry 级伪文件（`devices/<deviceId>/cordis.patch.yml#<entryId>`），因为 apply 的写入单位是条目 |

**只读承诺（有测试证据）**：

1. 不创建 snapshot：`previewDiff` 里没有任何 `snapshots.create` 调用；测试断言
   `snapshotRoot` 下的目录数在调用前后相同。
2. 不写 profile：本机模式只做 `collectLocal`（其内部只读 profile）；测试逐字节比较
   `cordis.patch.yml`。
3. 不写 `state.json`：不调用 `recordProbe`（既有 `preview` 会写 `reachable`，这里刻意不写）。
4. 不写预览缓存（`PreviewCache`）与 `plugins.to-install.json`。
5. 远端模式会用到工作副本（`ensureWorkTree` + `fetch`），这是 `preview` 本来就有的
   "读取远端前先确保本地 ref" 行为，不涉及 profile / 快照 / 状态文件。

失败一律 `SyncError` + 中文原因，`{ok:false, error:{code,message}}`：
未配置仓库 `E_VALIDATION`、profile 目录不存在 / 工作副本缺本机快照目录 / 远端没有该设备 `E_NOT_FOUND`、
远端读取失败 `E_GIT`。**绝不返回"空差异"冒充成功。**

## 3. `rollbackPreview`（只读）

请求：`{ action: 'rollbackPreview', snapshotId }`；响应 `data`：

```ts
interface RollbackPreview {
  snapshotId: string
  createdAt: string   // 快照 manifest.time（ISO）
  reason: string
  files: FileDiffStat[]        // 「当前 profile → 快照（回滚后）」
  summary: DiffSummary
  willRestore: string[]        // 回滚**实际**会写入的绝对路径
  hunks: UnifiedHunk[]         // 内容级差异（M4），方向与 files 一致
  truncated: boolean           // 还有 hunk 没展示（预算用尽 / 单 hunk 被裁）
}
```

`hunks` 的来源与上限（M4）：对每个 `kind !== 'same'` 且**不是**二进制 / >512KB 的文件，
用 `diffText(当前内容, 快照内容, { maxLines: 200, path })` 生成——即 `-` 行是现在会被换掉的内容，
`+` 行是回滚后写入的内容，与 `files` 的 `+X/-Y` 统计**同方向**，不会互相矛盾。
单文件预算 200 行；任一文件被裁或后续 hunk 被丢弃时 `truncated: true`（判定逻辑与 `diffText` 同一套）。
二进制 / 超长文件按 `diff.ts` 既有规则跳过（不产出 hunk，UI 显示"只给统计"徽标）。

方向与 kind 语义（务必按这个理解 UI 文案）：

| kind | 含义 | 回滚会不会动它 |
| --- | --- | --- |
| `added` | 快照里有、当前没有 | 会创建 |
| `modified` | 两侧都有且不同 | 会改写 |
| `deleted` | 当前有、快照里没有 | **不会删除**（快照不含该文件），UI 用「删除」+ 中性说明标注 |
| `same` | 内容一致 | 不动 |

`willRestore` 只列**真正会被写**的文件：当前实现 `rollbackSnapshot` 只写 profile 的
`cordis.patch.yml`，所以它恒为 `[<profileDir>/cordis.patch.yml]`（快照里没有该文件时直接
`E_NOT_FOUND`）。其它文件（providers / plugins / mcp）只做对照展示，不写盘。

fail-closed：

- `snapshotId` 为空 → `E_VALIDATION`；id 形态非法（不是 `YYYYMMDD-HHmmss[-n]`）→ `E_VALIDATION`；
- 快照不存在 → `E_NOT_FOUND`；
- 快照里没有 `cordis.patch.yml` → `E_NOT_FOUND`（与 `rollback` 的前置条件一致）；
- manifest 里的 sha256 与实际文件不一致 → `E_SHA_MISMATCH`；
- 读取当前 profile 失败 → `E_IO`。

以上任一条都**不写任何文件**（测试逐字节比较 + 快照目录数不变）。

## 4. 客户端：两步确认状态机

同步 section 新增两个入口：操作区「查看差异」「回滚到上次快照」（回滚入口在快照列表为空时禁用），
以及两张卡片：「差异预览」「回滚到上次快照」。

回滚状态机（`rollbackStep`）：

```
''  ──点击「回滚到上次快照」──▶  'pick'（第 1 步：只列最近 1 份快照）
                                     │  点击「查看这次回滚会改什么」→ rollbackPreview()
                                     ├─ 失败：留在 'pick'，ErrorBox(code+message)，不写盘
                                     ▼
                               'preview'（第 2 步：文件级 diff + 内容 hunk + willRestore 列表）
                                     │  点击「确认回滚（不可撤销）」→ rollback{confirm:true}
                                     ├─ 失败：留在 'preview'，ErrorBox(code+message)，不写盘
                                     ▼
                               成功：清空状态机 → notice → 刷新状态 + 快照列表
```

- `'pick'` 还有「取消」；`'preview'` 有「返回上一步」（回到 `'pick'`）与「取消」。
- 所有按钮共享 `busy`（`diff` / `rollbackPreview` / `rollback`），互斥：一个动作在跑时其它入口禁用。
- 差异卡片：顶部一句结论（`summarize` 同口径），按 kind 分组，每行 `path` + `+N/-M` + 字节变化
  （`before → after`）；有 hunk 的文件可展开（等宽 `<pre>`、`maxHeight` 限高滚动），
  `truncated` 时显示「仅显示前 N 行」；**空差异显示「没有差异」**，不是空白区域。
- **顶层 `truncated` 必显示提示**（M1）：`data.truncated === true` 时列表顶部显示
  「仅显示前 N 行差异，还有更多（请把区间缩小或直接看文件）」——不能只依赖每个 hunk 的
  `truncated`（预算恰好用完时后续 hunk 根本不产出）。
- 回滚第 2 步（M4）：同一套 `FileDiffList` 渲染 `hunks`（默认收起、点「展开 hunk」才显示正文），
  `truncated` 同样显示上面那条提示，与统计结论并列。
- 差异/回滚错误各自独立 state，互不清除对方的 ErrorBox；`diffError` 不清空上一次的成功结果
  （但会显示"失败"提示），避免"看似没有差异"的误导。

## 5. 与既有 `apply` / `rollback` 门禁的关系

- `apply`：**未改动**。仍需 `confirm: true` + 有效 `previewId` + 预览内 `added|changed|manual` 的条目。
- `rollback`：**未改动**，仍要求 `confirm: true`，否则 `E_CONFIRM_REQUIRED` 且一个字节都不写
  （`test/rollback-ux.test.mjs` 有回归断言）。新增的 `rollbackPreview` 只是"先看一眼"，
  **不给 `rollback` 加参数、不放宽门禁**。
- 快照列表里每行的既有「回滚 → 确认回滚」入口保持原样；新入口只是多了一步服务端预览，
  两者最终调用的都是同一个 `rollback {confirm:true}`。
- `preview`（拉取预览）与 `previewDiff` 是两件事：前者产出可 apply 的 `previewId` 与条目选择，
  后者只回答"变了多少"。`previewDiff` 不写缓存，所以不影响 apply 的 10 分钟预览有效期。

## 6. fail-closed 清单（测试证据）

| 场景 | 期望 | 测试 |
| --- | --- | --- |
| `previewDiff` 未配置仓库 / profile 不存在 | `{ok:false}` + 中文原因，快照数 0 | `rollback-ux.test.mjs` |
| `previewDiff` 远端设备不存在 | `E_GIT`，不写 `state.json` | 同上 |
| `rollbackPreview` 快照不存在 / id 非法 | `E_NOT_FOUND` / `E_VALIDATION` | 同上 |
| `rollbackPreview` manifest sha256 不匹配 | `E_SHA_MISMATCH`，profile 字节不变 | 同上 |
| `rollback` 缺 `confirm:true` | `E_CONFIRM_REQUIRED`，不建回滚前快照 | 同上 |
| 预览后文件未被改动 | 逐字节比较四个文件 | 同上 |
| 客户端预览失败 | 停在当前步骤、ErrorBox 显示 code+message、不发 `rollback` | 同上（渲染桩） |
| `diff.ts` 异常输入 | 返回空结果、不抛 | `diff.test.mjs` |
| `diffText` 预算恰好用完 / 后续 hunk 被整段丢弃（M1） | 顶层 `truncated: true`（即使每个 hunk 都是 false），预算充足时 `false` | `diff.test.mjs` |
| `rollbackPreview` 的内容级预览（M4） | `hunks` 非空且与 `files` 同方向；预算不足时 `truncated: true` | `rollback-ux.test.mjs` |

## 7. 已知限制

1. 远端设备模式的差异是 **entry 级**（伪文件路径），providers / plugins / mcp 的 id 级差异仍在
   既有「拉取预览」的 DiffList 里，不重复展示。
2. 回滚预览里的 `deleted` 是"不在快照里"，不代表回滚会删文件（`rollbackSnapshot` 从不删文件）。
3. `diff.ts` 不做行内（字符级）差异，也不产出可 `git apply` 的完整 patch——只给摘要与前后文。
4. 超过 512KB 或含 NUL 的文件只能看到 kind 与字节数。
