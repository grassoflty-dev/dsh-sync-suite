# DSH-dots 设计（日程 App 的统一入口）

> 状态：**设计 + 最小契约，未实现**。本文只写文档，不改任何代码。
> 上游文档：`docs/REMOTE-DSH.md`（下称 **RD**，v0.1，398 行）、`docs/REMOTE-DSH-M1.md`（下称 **M1**，82 行）、
> `docs/CONTRACT.md`（**CT**）、`docs/SCHEDULE-BRIDGE.md`（**SB**）、`docs/DATA-CONTRACT.md`（**DC**）、`docs/UI-DESIGN.md`（**UI**）。
> 标注约定：**已验证** = 本轮亲自读过该文件/该行；**沿用** = 引自上述文档且本轮未复核；**未验证** = 本机无法证明；
> **推断** = 由已验证事实推出、但没跑过。
> 证据基线：本机 DSH `@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.3`（`app.asar` 内 `dsh/package.json:2,4`），
> 与 RD:4 记录的一致。`app.asar` 是归档而非目录（RD 附录 A 未验证项 2），本文对它的引用格式为
> `app.asar → @deepseek-ai/<pkg>/src/<file>:<line>`（用 Node 只读解析 asar 头 + 按 offset 取字节，未解包、未写回）。

---

## 1. DSH-dots 是什么

**一句话**：DSH-dots 是日程 App 首页上**一个可折叠区块**，把「全部日程的聚合数字」「本机 DSH 现在的运行状态」
「三个远程入口」放在同一处，让用户**不打开 DSH 也能知道两台机器现在的状态**，需要深操作时一键跳过去。

**与现有「AI 汇总」的关系：增强，不替代。** 三条理由都是有证据的：

| 维度 | 现有 AI 汇总（`SummaryCard`） | DSH-dots |
| --- | --- | --- |
| 本质 | 模型生成的**派生文本**（`DailySummary`，`dailySummary.ts:36-50`） | 本地**可算的数字 + 远端状态**，零 AI 成本 |
| 成本/失败面 | 要 key、要网络、有 5 种状态（`Index.ets:1060-1065`） | 无 AI 调用；只有「有快照/没快照」两态 |
| 契约位置 | 列表第一项，**必须保留**（守卫测试 `apps/arkui-schedule/tools/test/indexHeader.test.mjs:71-89`） | 排在汇总块之后，**不抢第一位** |

所以 AI 汇总的入口、落盘（`devices/<id>/summaries/<date>.json`）、生成逻辑（`summaryStore.read/generate`，
`summaryStore.ets:88-136`）**一个字节都不动**；DSH-dots 是它下面新增的一段，并复用它的「点开看全部」交互范式。

### 1.1 三类信息（每类的数据来源一句话）

| 类别 | 内容 | 来源 | 结论 |
| --- | --- | --- | --- |
| **日程聚合** | 近 N 天的 total/open/done、每天 top 标题、合计 | Git 仓库 `devices/*/schedules/*.jsonl`（DC §3） | **100% 可落地**，PC 与 App 各算一遍，同一口径 |
| **DSH 运行状态** | 是否可达、传输模式、会话数、忙否、最近活动、版本、局域网地址 | PC 进程内读 Cordis 服务（§3.2 有 4 条代码证据） | **部分可落地**：version/sessionCount 有硬证据；title/busy 依赖服务是否挂载（未验证） |
| **远程操作入口** | 刷新、打开 DSH 控制台、打开设置 | 已有 `syncController.pullNow()` + 已有 `dsh-mobile-remote` 插件（profile 内已装） | **可落地**，且**不需要** RD 的 M1 桥（§3.3） |

### 1.2 明确不做（避免重复造）

- **不加页头入口**：页头已有「今天 / ⚙ 设置」，且删掉 AI 汇总图标是用户定的（`Index.ets:5-10`，守卫测试 `indexHeader.test.mjs:47-69` 直接扫源码禁字符串）。
- **不新增页面**：`main_pages.json` 只列共享 4 页（CT:315、CT:333），新增页面要同步 harmony 超集 + `validate-app` 规则 3（CT:434）。
- **不新增设置项**：UI:5「不新增配置项」是定稿口径；DSH-dots 的所有开关都由「仓库里有没有快照文件」决定。
- **不在日程 App 里重造远程聊天界面**：RD §1.2 N1–N6 已排除文件面/终端/插件管理/owner 权限；远程聊天走 §3.3 的「打开 DSH 控制台」。

---

## 2. 数据契约（最重要）

契约分三层，**层次不同不要混**：

| 层 | 名字 | 谁产生 | 谁消费 | 是否进 Git |
| --- | --- | --- | --- | --- |
| ① 日聚合 | `DotsScheduleDigest` | PC 插件 / App 各自用同一算法算 | 两者 | 间接（随 `DotsSnapshot`） |
| ② 快照 | `DotsSnapshot` | **只有 PC 插件写** | App 只读 | **是**：`devices/<pcId>/dsh-status/latest.json` |
| ③ 展示模型 | `DotsCardModel` | App（`model/dotsView.ts`） | ArkTS UI | 否（纯内存） |

### 2.1 类型（可直接落地的 TypeScript）

```ts
/** ① 单日聚合。口径见 §2.2。 */
export interface DotsScheduleDigest {
  /** YYYY-MM-DD；取记录 `ts` 前 10 位（记录者本地日期），不信文件名。 */
  dateKey: string
  /** 折叠 + 去墓碑后的条数。 */
  total: number
  /** `done !== true` 的条数。 */
  open: number
  /** `done === true` 的条数。 */
  done: number
  /** ≤3 条标题：未完成优先、按 ts 倒序、去重；每条截断到 40 字。 */
  topTitles: string[]
  /** 该日贡献了记录的设备目录（可选，便于「这台机器今天没写」的可读性）。 */
  devices?: string[]
}

/** DSH 运行状态。未知一律「字段缺省」，绝不填 0/false 冒充已知。 */
export interface DotsDshStatus {
  /**
   * **只表示「本次拿到了会话级/进程级证据」**，不是「DSH 是否在线」的离线探针。
   * 拿不到证据就 `false` + `detail`；UI 的「新鲜度」判断另看快照 `generatedAt`（§4.4）。
   */
  reachable: boolean
  /** 状态是怎么拿到的：git-bridge = 本设计 v1；http-remote = 直连 DSH HTTP（P2）；unknown = 没拿到。 */
  mode: 'git-bridge' | 'http-remote' | 'unknown'
  /** 持久化会话数。来源见 §2.3 第 2 行。 */
  sessionCount?: number
  /**
   * 最近活跃会话的标题。
   * **只允许出现在工具返回值与本机 GUI；发布到 Git 时该字段必须省略**（隐私，见 §5.3）。
   */
  activeSessionTitle?: string
  /** 是否存在 running 的会话。 */
  busy?: boolean
  /** 最近活动时刻，ISO 8601 带偏移（取原子钟值，不做时区换算）。 */
  lastActivityAt?: string
  /** DSH 版本，形如 `0.2.2-rc.3`；取不到时为 `'unknown'`（与 `paths.ts:129` 的既有返回值一致）。 */
  version?: string
  /** DSH Web 控制台的局域网地址，如 `http://192.168.1.7:3080`；P2 的「打开控制台」用。 */
  webUrl?: string
  /** 采集时刻（区别于快照的 generatedAt）。 */
  observedAt?: string
  /** 不可达/降级原因（中文一句话，给 UI 直接显示）。 */
  detail?: string
}

/** ② 快照文件 `devices/<pcId>/dsh-status/latest.json` 的完整内容。 */
export interface DotsSnapshot {
  /** 格式版本；`DailySummary.version` 同款先例（dailySummary.ts:37）。前向兼容靠它。 */
  v: 1
  /** 采集时刻，ISO 8601。 */
  generatedAt: string
  /** 产生该快照的**设备目录名**（PC 的 deviceId，DC §1 的 `^[a-z0-9][a-z0-9-]{0,31}$`）。 */
  deviceId: string
  /** 最近 N 天，按 dateKey **倒序**（今天在前）。工具允许 1..90，App 只展示 7 / 30 两档（§4.3）。 */
  days: DotsScheduleDigest[]
  /** `days` = 有记录的天数；`skipped` = 坏行计数（不静默丢失，但不进 UI）。 */
  totals: { days: number; records: number; open: number; done: number; skipped?: number }
  /** 采集时的 DSH 状态；拿不到就是 `{reachable:false, mode:'unknown', detail:'…'}`。 */
  dsh: DotsDshStatus
  /** 可选提示（未配置仓库 / 拉取失败等），不影响数据本身。 */
  note?: string
}
```

### 2.2 统计口径（PC 与 App 必须逐字一致，靠两份单测钉住）

| 规则 | 定义 | 证据 |
| --- | --- | --- |
| 日期归属 | `record.ts.slice(0,10)`，**不是文件名** | `bridge.ts:172-176`（`recordDateKey(record.ts) !== day` 即丢弃） |
| 折叠 | `sortRecords(foldById(...))`，同 id 取较晚 ts | `bridge.ts:172`；DC §3「折叠」行 |
| 墓碑 | 过滤 `deleted:true`（App 侧 `withoutDeleted`） | `scheduleStore.ets:239,253`；DC §3 更新事件段 |
| 未完成 | `record.done !== true`（缺字段算未完成，与 `schedule_list` 的 `done: {type:'boolean'}` 不冲突，读侧容错） | `types.ts:33`；`tools.ts:164` |
| topTitles | 未完成优先 → 按 ts 倒序 → 去重 → 最多 3 条 → 每条截断 40 字 | 新增规则（推断，已在 `dots.ts` 的 `digestDay` 落定，单测固化） |
| N 天窗口 | 含今天，向前 N-1 天，日历日（`new Date(y, m, d - offset)`，不碰 UTC） | `clock.ts:34-36` 的 `localDateKey` 扩展 |
| 空日 | 契约允许省略 `total=0` 的日子；**App 侧渲染前必须按 dateKey 补齐连续日期**（否则无法区分「没数据」与「那天放假」） | 本轮决定（实现侧选择省略，见 §8） |

### 2.3 每个字段的真实来源（这条是本设计的核心，逐项核对过）

| 字段 | 真实来源 | 证据等级 |
| --- | --- | --- |
| `days[].dateKey/total/open/done/topTitles/devices` | Git 工作副本里的 JSONL，读法与 `schedule_list` 完全同源（`bridge.readDetailed`） | **已验证**（`bridge.ts:142-188`、`jsonl.ts` 由 `bridge.ts:40` 导入） |
| `totals.*` | 对 `days[]` 求和 / 计数 | **已验证**（纯算术） |
| `dsh.version` | `detectDshVersion()`：`DSH_VERSION` → `~/.dsh/safe-launch/last-good.json` → 运行入口 `package.json` | **已验证**（仓库里已有，`engine/paths.ts:91-129`）；本机旁证：`app.asar → dsh/package.json:4` = `0.2.2-rc.3` |
| `dsh.sessionCount` | `ctx.get('sessionPersistence').list()` 的数组长度 | **已验证**（服务键与签名：`app.asar → @deepseek-ai/dsh-session-persistence/src/index.ts:119-120,149,210`）；**本机旁证**：`dsh-mobile-remote` 就是这么读的（`~/.dsh/profiles/web/node_modules/@feiyang666/dsh-mobile-remote/lib/index.js:284-290`），该插件已装并宣称面板有「DSH 状态」卡（`README.zh.md:29`）→ **沿用** |
| `dsh.sessionCount`（备选口径） | `ctx.get('sessionController').list({}, signal)` → `items.length` | **已验证**（`app.asar → dsh-api-session-controller/src/index.ts:74-79` 声明 `Context.sessionController`；`:281-285` 是 list 实现；`:252-254` 是返回形状） |
| `dsh.busy` | 同上 list 结果里 `items.some(i => i.running === true)` | **已验证**有该字段（`.../src/types.ts:154-167`，`running` 在 :161）；**未验证**该调用在本插件里跑得通（`@Remote` 装饰器只登记元数据，见 `dsh-typert-protocol/src/index.ts:277-317`，方法本体仍可直接调；`remoteAccess.allows()` 在「无 Remote invocation」时直接返回 true，见 `dsh-api-remote-access/src/index.ts:225-239`）→ **推断可行** |
| `dsh.lastActivityAt` | 同上 list 结果的 `max(updatedAt)`（epoch ms）→ ISO | 字段**已验证**（`types.ts:160`；排序见 `src/list.ts:176`）；可用性同 `busy`（**推断**） |
| `dsh.activeSessionTitle` | `ctx.get('sessionTitle').get(session)?.title`，`session = ctx.get('sessions').get(id)` | 字段**已验证**（`dsh-session-title/src/index.ts:395`；返回类型 `SessionTitleSnapshot.title`，`src/types.ts:51-56`；`sessions` 服务见 `dsh-session/src/index.ts:38-40`）；**未验证**该服务在本 profile 是否挂载（profile patch 里没有 title 相关行）→ **必须降级为省略** |
| `dsh.webUrl` | `ctx.webServer.host/port` + `os.networkInterfaces()` 取第一个非内网回环 IPv4 | **沿用**：`dsh-mobile-remote` 同款读法（`lib/index.js:698,739-748`）；本插件当前只声明了 `register()`（`src/index.ts:37-43`），**需要扩接口**（未验证 `host/port` 一定在） |
| `dsh.mode` | PC 侧写快照时固定 `'git-bridge'`；App 若走 LAN 直连写 `'http-remote'` | **已验证**（本设计定义） |
| `dsh.reachable` | 快照存在且 `generatedAt` 在 TTL（默认 72h）内 → `true`；否则 `false` + `detail` | **已验证**（本设计定义，纯算术） |
| `dsh.detail` | 降级原因中文句（服务缺失 / 快照过期 / 拉取失败） | **已验证**（本设计定义） |

**只能给 unknown 的三个字段（本轮不编）**：

1. `activeSessionTitle` —— 依赖 `sessionTitle` 服务；本机 profile 未声明该插件（`~/.dsh/profiles/web/cordis.patch.yml` grep 不到 title/session 行），**默认省略**。
2. `dsh.busy` / `lastActivityAt` —— 依赖 `sessionController` 直调，代码上可行（见上表）但**没跑过**；实现时必须包 try/catch，失败即 `detail:'会话服务不可用'` 并把两字段省略。
3. `dsh.webUrl` —— 需要 `ctx.webServer` 暴露 `host/port`（本插件只用了 `register`）；取不到就省略，UI 回落到「到电脑设置页复制地址」的说明文案。

### 2.4 快照文件（新增，需契约扩展）

```
<repo>/devices/<pcId>/dsh-status/latest.json    # PC 插件写，App 只读
```

- 命名与位置沿用 DC §1「每台设备只写自己的目录」；**这是对本文件的一次扩展**，落地时必须同步改 `DC §1` 的目录树与 CT §2.3（本文不代替那两份文档做决定）。
- 单文件覆盖写（不是 JSONL）：状态是幂等的当前值，不是事件流；与 `summaries/<date>.json` 同款（DC §1:23）。
- 稳定键序（`JSON.stringify(obj, null, 2) + '\n'`），便于 `git diff` 与「内容未变则不提交」的去重。
- **去重规则**：读出旧文件 → 除掉 `generatedAt`/`dsh.observedAt` 后逐字段比 → 相同则**不提交**；另有最小间隔（默认 10 分钟）与 `dsh.reachable` 变化时强制发布。

示例（`activeSessionTitle` 故意不出现）：

```json
{
  "v": 1,
  "generatedAt": "2026-11-16T22:40:03+08:00",
  "deviceId": "desktop-pvrp3qs",
  "days": [
    { "dateKey": "2026-11-16", "total": 5, "open": 2, "done": 3,
      "topTitles": ["周会纪要", "给平板的同步方案"], "devices": ["desktop-pvrp3qs", "pad-x7c1"] }
  ],
  "totals": { "days": 7, "records": 23, "open": 6, "done": 17 },
  "dsh": {
    "reachable": true,
    "mode": "git-bridge",
    "sessionCount": 12,
    "busy": false,
    "lastActivityAt": "2026-11-16T22:31:07+08:00",
    "version": "0.2.2-rc.3",
    "webUrl": "http://192.168.1.7:3080",
    "observedAt": "2026-11-16T22:40:03+08:00"
  }
}
```

---

## 3. 接口与实现路径

**结论：A（插件工具）为主，B（HTTP 远程）为备且本轮不做全量。** 理由见 §3.4。

### 3.1 路径 A：新增插件工具 `dsh_dots`（推荐）

#### 文件清单

| 动作 | 文件 | 内容 |
| --- | --- | --- |
| 新增 | `packages/dsh-dots/src/schedule/dots.ts` | 纯逻辑：日期窗口、日聚合、合计、top 标题、快照序列化与去重哈希 |
| 新增 | `packages/dsh-dots/src/schedule/dshStatus.ts` | 进程内读 DSH 状态（**只用 `ctx.get()` 可选服务**，缺一个不影响其它字段） |
| 新增 | `packages/dsh-dots/src/schedule/dotsPublish.ts` | 快照发布：读旧文件 → 去重 → 写 → `commitAll({onlyPath})` → `pushWithRebase` |
| 改 | `packages/dsh-dots/src/schedule/paths.ts` | 新增 `dotsStatusRelPath(deviceId)` 与 `assertDotsStatusScope(deviceId, relPath)`（现有 `assertSchedulesScope` 是**白名单，会把 `dsh-status/` 挡掉**：`paths.ts:90-105`） |
| 改 | `packages/dsh-dots/src/schedule/tools.ts` | 新增 `dshDotsTool()`，并加进 `buildScheduleTools()`（`tools.ts:308-310`）与 `registerScheduleTools()`（`:318-334` 自动覆盖） |
| 改 | `packages/dsh-dots/src/index.ts` | 新配置项 `config.dotsTool`（默认 true，与 `scheduleTools` 并列，`:33-35,110-115`），把 `ctx.get` 转发给状态读取 |
| 改 | `packages/dsh-dots/src/schedule/index.ts` | `export * from './dots.js'` 等三行（现有出口 `index.ts:14-21`） |
| 新增 | `packages/dsh-dots/test/schedule-dots.test.mjs` | 纯函数：窗口、口径、去重哈希 |
| 新增 | `packages/dsh-dots/test/schedule-dots-status.test.mjs` | 注入假 host（`{ get: (n) => … }`）验证 4 种降级：服务缺失 / 抛错 / 超时 / 正常 |
| 新增 | `packages/dsh-dots/test/schedule-dots-publish.test.mjs` | 临时裸仓库：只提交 `dsh-status/`、内容不变不提交、push 失败不抛 |

#### 函数签名

```ts
// dots.ts —— 零 npm 依赖、可注入 now，纯函数
export interface DotsRangeInput {
  days?: number          // 1..30，默认 7
  now?: Date
}
export function dateKeysBack(days: number, now: Date): string[]            // 升序，含今天
export function digestOfDay(day: string, items: Array<{ record: ScheduleRecord; deviceId: string }>): DotsScheduleDigest
export function digestRange(dayKeys: string[], byDay: Map<string, Array<{ record: ScheduleRecord; deviceId: string }>>): DotsScheduleDigest[]
export function totalsOf(days: DotsScheduleDigest[]): DotsSnapshot['totals']
export function stableSnapshotText(snapshot: DotsSnapshot): string          // 固定键序 + 末尾换行
export function snapshotFingerprint(snapshot: DotsSnapshot): string         // 去重哈希（剔除 generatedAt/observedAt）
```

```ts
// dshStatus.ts —— 不 import cordis 类型，用结构化最小宿主
export interface DshHostLike {
  get?(name: string): unknown
  now?(): Date
}
export interface ReadDshStatusOptions {
  timeoutMs?: number          // 默认 1500；每个服务单独超时，超时即省略该字段
  includeTitle?: boolean      // 默认 false；为 true 才尝试 activeSessionTitle（不进快照）
  includeUrl?: boolean        // 默认 true；写 webUrl 需要 ctx.webServer.host/port
}
export async function readDshStatus(host: DshHostLike, options?: ReadDshStatusOptions): Promise<DotsDshStatus>
```

```ts
// dotsPublish.ts
export function dotsStatusRelPath(deviceId: string): string                 // devices/<id>/dsh-status/latest.json
export function assertDotsStatusScope(deviceId: string, relPath: string): void
export interface PublishDotsResult {
  path: string
  written: boolean
  pushed: boolean
  rebased: boolean
  commit: string
  reason?: 'unchanged' | 'too-soon' | 'no-repo' | 'push-failed'
}
export async function publishDots(
  repo: GitRepo,                       // engine/git.ts，与 schedule_add 同一个类
  deviceId: string,
  snapshot: DotsSnapshot,
  options?: { minIntervalMs?: number; force?: boolean },
): Promise<PublishDotsResult>
```

```ts
// tools.ts 里的工具定义（形状照抄现有三个：tools.ts:130-188）
export const DOTS_TOOL_NAME = 'dsh_dots'
// 参数：{ days?: integer 1..30, deviceId?: string|'all', publish?: boolean, includeTitle?: boolean }
// 返回：{ snapshot: DotsSnapshot, notes: string[], refreshed: boolean, note?: string,
//        publish?: PublishDotsResult }
```

#### DSH 状态的来源（**这是本节要回答的核心问题**）

四条**代码证据**，按可靠性排序：

1. **架构上没有专门给插件用的「DSH 状态 API」**：`/api` 是 owner 级鉴权（RD §3.4 限制 1），远程桥尚未实现（M1 §2），
   所以插件只能**进程内**读 Cordis 服务。这不是推断，是本机已装插件就是这么做的：
   `dsh-mobile-remote` 的 `collectDshInfo()`（`…/lib/index.js:276-328`）用 `ctx.get()` 依次取
   `sessionPersistence` / `workspaceRegistry` / `pluginInventory` / `llm`，**任一失败降级为 null、整体不抛**——
   这正是本设计要的「取不到就 unknown」纪律，可直接照搬这套写法。
2. **会话数**：`ctx.sessionPersistence.list()`（服务键 `sessionPersistence`、签名 `list(): Promise<SessionPersistenceSnapshot[]>`
   见 `app.asar → @deepseek-ai/dsh-session-persistence/src/index.ts:119-120,149,210`）。
3. **忙/最近活动/标题**（更强、但只在本机验证过类型）：
   `ctx.sessionController.list({}, signal)` 返回 `{items: SessionSummary[]}`（`.../dsh-api-session-controller/src/index.ts:281-285`），
   `SessionSummary` 有 `updatedAt/running/agentAvailable/cwd/parentSessionId/origin`（`.../src/types.ts:154-167`）；
   它按 `ctx.remoteAccess.allows()` 过滤，而 `allows()` 在**没有 Remote invocation 时直接返回 true**
   （`.../dsh-api-remote-access/src/index.ts:225-239`）→ 插件内直调不会被拦掉。标题不在 `SessionSummary` 里
   （`.../src/types.ts:252-254` 只有 `items`；`SessionHeader` 也没有 title，`dsh-session/src/types.ts:95-136`），
     只能走 `ctx.get('sessionTitle').get(session)?.title`（`.../dsh-session-title/src/index.ts:395`，快照类型 `src/types.ts:51-56`）。
     统计口径：**只数顶层会话**（`origin !== 'subagent'`，字段见 `types.ts:163-164`），否则子代理会把会话数刷爆。
4. **版本**：别再写一遍探测逻辑，直接复用仓库已有的 `detectDshVersion()`（`engine/paths.ts:91-129`）。

> **未验证（必须在提交 2 里 spike 掉）**：`ctx.get('sessionController')` 在本插件上下文里返回的是可调用对象而非
> 带 `@Remote` 包装的 stub（`dsh-typert-protocol/src/index.ts:277-317` 显示装饰器只 `addMarkerInitializer`，
> 不替换方法本体 → **推断**可以直接调）。失败时的行为必须是：省略 `busy`/`lastActivityAt`/`sessionCount`
> （若 2 也失败）、`detail` 写「会话服务不可用：<原因>」、**整个工具仍然返回成功**。

#### 性能与拉取次数

- `bridge.readDetailed()` **每次调用都会 `tryRefresh()` 拉一次**（`bridge.ts:156`）；N 天 × `all` 若按天调就是 N 次 pull。
  所以 `digestRange` 必须先 `ensureWorkTree()` + **一次** `tryRefresh()`，再按 `dateKeys × deviceDirs` 直接读文件
  （复用 `scheduleRelPath` + `readTextIfExists` + `parseJsonl` + `foldById`，路径校验仍走 `assertSchedulesScope` 的读侧兄弟
  `resolveInsideRepo`）。上限：`days ≤ 30`、设备目录数不设上限但读文件数 = days × devices（7×3=21 个小文件，可接受）。
- 读路径**不抛**是既有纪律（`bridge.ts:357-371`：拉取失败只给 `note` + `refreshed:false`），`dsh_dots` 沿用。

#### 错误语义（**不新增错误码**）

现有错误码是**封闭集合**：`errors.ts:9-18` 注释明写「所有对外错误码必须在 CONTRACT §2.3 列出的集合内」，
CT:258-259 也钉死了这九个。因此：

| 条件 | 处理 | 依据 |
| --- | --- | --- |
| 未配置仓库地址 | **抛** `E_VALIDATION`，消息沿用现有文案 | `bridge.ts:406-408` |
| `days` 越界 / `deviceId` 非法 | **抛** `E_VALIDATION` | `paths.ts:27-35` 的 `assertDeviceId` |
| 仓库里一条日程都没有 | **不抛**：`days` 全 0 + `notes:['仓库里还没有日程']` | 对齐 `schedule_list` 的空态（`tools.ts:352`） |
| `refreshed:false`（网络/冲突） | **不抛**：`note` 说明「展示本地副本」 | `bridge.ts:357-371` |
| DSH 服务全缺失 | **不抛**：`dsh = {reachable:false, mode:'unknown', detail:'…'}` | 本节第 1 条 |
| 快照写入/推送失败 | **不抛**：`publish = {written:false|true, pushed:false, reason:'push-failed'}` | 状态是尽力而为；对比 `schedule_add` 写日程失败必须抛（`bridge.ts:276-277`） |
| 会话服务抛异常 | **不抛**：吞掉、写 `detail` | 同第 1 条 |

**为什么不用 `E_NO_DATA` / `E_DSH_UNREACHABLE`**：「没有数据」和「DSH 不可达」在本设计里都是**正常业务状态**
（用户就是想看「没有」和「离线」），做成 Error 会让模型/调用方把 UI 该显示的信息当失败处理；
真要用码，也只能映射进既有集合：`E_NOT_FOUND` + `details.reason='DOTS_NO_DATA'`、`E_GIT` + `details.reason='DSH_UNREACHABLE'`
（`SyncError` 支持 `details`，`errors.ts:23`）。**结论：v1 不新增码。**

### 3.2 路径 B：HTTP 远程（备用，本轮不做全量）

按 RD 的结论，走 DSH 自己的 HTTP 面需要：出站 WSS 中继 + AES-256-GCM E2E（RD §3.2）+ 配对与密钥（RD §4）
+ 载荷契约（RD §5）+ 重连去重（RD §8），即 RD §9 的 M1 全套；M1 又指出 App 侧三项平台能力未验证
（M1 §3：WebSocket / 扫码 / 密钥存储）。**本轮不做全量**，原因不是「不想做」，是 RD §3.4 的三条硬限制
（owner 级鉴权、审批只有 owner 能作答、审批不带工具参数）一条都没被解开。

**但有一条已经可用的现成通道，必须写进设计（否则就是重复造）**：
本机已装 `@feiyang666/dsh-mobile-remote@^1.6.1`（`~/.dsh/profiles/web/package.json:3`），它

- 把 `webserver.host` 写成 `0.0.0.0`、端口 3080（`~/.dsh/profiles/web/cordis.patch.yml:7-11`，标注 auto-generated 勿手改）；
- 提供 `GET /__dsh_remote/status`，响应里带 `dsh: {version, sessions, workspaces, plugins, llm}`
  （`…/lib/index.js:694-756`，采集实现 `:276-328`）；
- 该端点的鉴权门 `authGate` 对**非外网请求直接放行**（`…/lib/index.js:415-419,421-431`）→ 同 Wi-Fi 平板可免密 GET；
- 手机扫码打开 `http://<局域网IP>:3080` 就是**完整的 DSH Web UI**，能看会话、能发消息（`README.zh.md:97-101`）。

因此：

| 用途 | v1（A 路径） | P2（可选增强） |
| --- | --- | --- |
| 状态 | PC 写 git 快照 → App 读 | App LAN 直连 `GET /__dsh_remote/status` → `mode:'http-remote'`，实时 |
| 远程操作 | 「打开 DSH 控制台」= 用系统浏览器/Web 组件打开快照里的 `dsh.webUrl` | 内嵌 WebView + 记住登录态（**未验证** ArkUI-X Android Web 的登录态与 `crypto.randomUUID` 兜底，见 `README.zh.md:154`） |

**约束（写进实现要求）**：`/__dsh_remote/*` 是**第三方插件的私有 API**，不是 DSH 契约，也没有发 prompt 的能力
→ 只能当「可选加速」，**不得成为 DSH-dots 的唯一数据源**；一处失败必须回落到 git 快照。

### 3.3 远程操作的现实边界（重要）

日程 App 与 DSH 之间**今天只有 Git 一条路**（平板侧网络能力只有 `@ohos.net.http` 拉 GitHub，`GitSyncService.ets` 即此；
RD §2.1 A1 说 DSH 只监听回环——而本机 profile 已被 mobile-remote 改成 `0.0.0.0`，
两者不矛盾：**RD 描述的是默认姿态，本机是被插件显式打开的**）。

所以 v1 的「远程操作」只能是这三件事，且都**不新增传输通道**：

| # | 操作 | 前置条件 | 失败文案 |
| --- | --- | --- | --- |
| R1 | **刷新状态**（重新 pull + 重读快照） | 已配置仓库地址；`syncController.isReady()`（`syncController.ets:168`） | 「同步内核未就绪，请稍候再试」/「拉取失败：<分类后的原因>」 |
| R2 | **打开 DSH 控制台** | 快照里 `dsh.webUrl` 非空 | 「未开启 DSH 远程：到电脑「设置 → 远程控制」打开后再试」 |
| R3 | **打开设置** | 无 | 「打开设置页失败：<原因>」 |
| R4 | **发一条 prompt**（**P2，v1 灰显**） | 依赖 RD §9 M1 桥或内嵌 WebView 登录态 | 「需要先完成 DSH 远程桥（M1）；本轮未实现」 |

### 3.4 为什么选 A 为主

1. **不新增入站路由**：只需在插件里加一个工具，注册方式与现有三个完全一致（`tools.ts:318-334` + `index.ts:79-88` 的 `ctx.inject(['tools'])`）。
2. **不碰凭据**：状态由本机进程自己读自己，没有 token 出设备（对比 RD §4 的配对/轮换/吊销整套）。
3. **离线可用**：快照随 Git 走，手机没连同一个 Wi-Fi 也能看到上次状态（RD §7 的中继方案做不到「没网也能看」）。
4. **风险集中在两处**（§7 风险 1、2），都可以用「降到 unknown」兜底，不会把功能做死。

---

## 4. App 侧 UI 契约（给 UI 执行者的输入，不写 ArkTS 代码）

### 4.1 位置与结构

- **位置**：`SummaryCard` 之后、`RecordList` 之前，`CompactBody` 与 `WideBody` **各渲染一次**，
  且与汇总块同受 `if (!this.showAllPending)` 控制（`Index.ets:1507-1509` / `1549-1551`）。
  理由：守卫测试要求汇总块是列表第一项且必须在列表之前（`indexHeader.test.mjs:71-79`），DSH-dots 只能排它后面。
- **形态**：**一段分割区，不是卡片**——无阴影/无圆角/无底色，`: 1vp Divider` 开头结尾，与 `SummaryCard` 尾部
  `Divider()` 同款（`Index.ets:1201-1203`）。依据 UI:4-5（白底 + 单一强调色 + 去卡片）、UI:52-58（间距 4/8/12/16/24、字号 3 档 14/16/20）。
- **默认折叠**：1 行标题 + 1 行摘要（例：`◍ DSH-dots  近7天 23条 · 未完成 6 · DSH 在线`），点整行展开；
  展开态在**同页内联**渲染（不跳页、不弹 ActionSheet：首页无 ActionSheet 是定稿，UI:102；不新增页面见 §1.2）。
- 文案与字号：标题走 `FONT.caption` + `app.color.brand`（与「✨ 今日汇总」同级，`Index.ets:1071-1076`），
  数字行 `FONT.body`，说明/错误行 `FONT.caption` + `text_secondary`/`danger`。
- 触控：所有可点行 `height(TOUCH_MIN)`（≥40vp，UI:5）。

### 4.2 展开后的 6 个信息块（**固定 6 块，不再加**）

| # | 块 | 内容（字段） | 交互 |
| --- | --- | --- | --- |
| 1 | 状态行 | `dsh.reachable ? 'DSH 在线 · v'+version : 'DSH 状态未知'` + `mode` 小字 | 点 → R2 |
| 2 | 今日 | `days[今天]` 的 `open/done/total`（例 `今天 5 条 · 未完成 2`） | 点 → 展开第 4 块的今日明细 |
| 3 | 近 N 天合计 | `totals.records/open/done` + 窗口天数（`7天|30天` 两个 chip 切换） | 切 chip 重算，不联网 |
| 4 | 每日明细 | `days[]` 每行：`MM-DD · total · 未完成 open · topTitles[0]`，最多 7 行，超出折叠为「还有 N 天」 | 点某行 → 选中该日期并关闭展开（等价于日期条换日） |
| 5 | 最近活动 | `lastActivityAt`（`HH:MM`）+ `busy ? '进行中' : '空闲'` + `sessionCount` 个会话 | 无（纯展示） |
| 6 | 操作行 | `刷新` / `打开 DSH` / `设置`（依可用性启用，见 §4.4） | R1/R2/R3 |

块 1 与块 5 **同源**（都来自 `dsh`），拿不到时两块合并成一行提示，不留空位（UI:102「不留空按钮」精神）。

### 4.3 「获取全部日程」入口（口径必须写死）

- **入口**：块 3 的「7天 / 30天」chip；点开等价于 `days` 窗口切换，**不触发任何网络请求**（数据已在本地仓库里，
  App 侧 `scheduleStore` 已能读全部设备：`listDeviceIds()` `scheduleStore.ets:192-215`、`readAllDevices()` `:243-254`）。
- **口径**：与 §2.2 完全一致（日期取 `ts` 前 10 位、`foldById` 折叠、过滤墓碑、`done !== true` 记未完成）。
  App 侧实现放 `model/dots.ts`（纯函数，零 `@ohos` import，Node 可测），**不得**在 `.ets` 里写统计逻辑。
- **范围**：工具接受 1..90 天；**App 只给 7 天 / 30 天两档**（30 天是 UI 上限：避免一次读 30×N 个文件卡 UI，且
  `openIndexStore` 的自愈窗口也是 30 天，DC §4bis）。
- **与 DSH 快照的关系**：块 2–4 的**数字**优先用本地算的（永远最新、不会过期）；`dsh` 段才用快照。
  两者时间戳不同时，块底部加一行 `· 状态更新于 HH:MM`（取自 `dsh.observedAt`）。

### 4.4 不可达 / 空态：显示什么

| 情形 | 判断 | 显示 | 可用操作 |
| --- | --- | --- | --- |
| 从未有过快照 | 无 `latest.json` | 块 1 灰字「DSH 状态未知（仓库里还没有状态快照）」+ 一行说明「在电脑上让助手执行一次 dsh_dots」 | 刷新 / 设置 |
| 快照过期 | `generatedAt` 距今 > 72h（**只看时间，不看 `reachable`**） | 「DSH 状态已过期（N 天前）」+ 仍显示过期数字（灰字，不隐藏） | 刷新 / 打开 DSH / 设置 |
| `dsh.reachable=false` 且未过期 | `reachable === false` | 「本机未探测到会话级状态：<dsh.detail>」灰字一行（措辞不写「离线」，因为 `reachable` 只代表「有没有拿到证据」，§2.1） | 刷新 / 打开 DSH / 设置 |
| 快照格式不认识 | `v !== 1` | 「状态快照版本过新，请升级 App」+ **不显示任何数字**（防误读） | 刷新 / 设置 |
| 本地无日程 | 本地算出来全 0 | 块 2–4 显示「最近 N 天没有日程」（与汇总块「今天还没有日程」同款灰字，`Index.ets:1093-1100`） | 刷新 / 设置 |

### 4.5 远程操作的最小集合

只 3 个可用 + 1 个灰显：**R1 刷新状态**、**R2 打开 DSH 控制台**、**R3 打开设置**、R4 发 prompt（灰显，见 §3.3）。
每个操作一屏内只出现一次；失败用 `promptAction.showToast`（项目现有风格，`Index.ets:226,608,645`），
不复用 `statusText`（那是列表统计行）。

---

## 5. 安全边界

### 5.1 绝不放进 App 的操作（逐条对应 RD §1.2 的 N1–N6）

| RD 条目 | 在 DSH-dots 里的落地 |
| --- | --- |
| N1 完整 IDE / 文件编辑器 | 不做；App 只能看聚合数字，**没有任何路径/文件内容字段**进入契约（对比 `schedule_list` 才有 `bodyPreview`） |
| N2 文件树 / 上传下载 | 不做；`dsh-status/` 只读一个固定文件名，不提供目录列表能力 |
| N3 插件安装/卸载/升级 | 不做；App 侧无任何 `plugin_manager` 语义，快照里也不放已装插件列表（对比 mobile-remote 的 `plugins` 字段，我们**故意不抄**） |
| N4 终端 / bash / pwsh | 不做；`DotsSnapshot` 里没有任何可执行动作字段 |
| N5 多用户 / 团队共享 | 不做；快照是单 owner 的私有仓库文件 |
| N6 手机成为 owner Peer | 不做；R2 只是「打开浏览器里的 DSH UI」，手机仍是浏览器 Peer，鉴权仍由 DSH 自己判 |
| 额外（本设计加） | **不做审批作答**：RD §3.4 限制 2（审批瀑布只有 owner 能答）没解，DSH-dots 不碰 `approval/*` 任何事件 |

### 5.2 凭据存放位置（沿用，不新增）

| 凭据 | 位置 | 证据 |
| --- | --- | --- |
| Git token（平板） | App `preferences`，**明文** | `settingsStore.ets`（M1 §3 已列风险）；CONTRACT §3.3 口径 |
| Git token（PC） | `~/.dsh/dots/credentials.json`，0600 | CT:54-55、DC §5 |
| AI key | 平板 `preferences` / PC 环境变量 `DSH_SCHEDULE_AI_KEY` | SB §2 末、`bridge.ts:73-82` |
| DSH 远程访问密码 | **不经过 DSH-dots**，由 mobile-remote 自己管（`~/.dsh/plugins/dsh-mobile-remote/config.json`，scrypt 哈希） | `README.zh.md:43` |

**DSH-dots 不引入任何新凭据**；`dsh-status/latest.json` 里**不得**出现任何 token/key/密码字段（见 §5.3 校验项）。

### 5.3 日志与载荷禁止项

写进测试断言（提交 2/3 各一条扫描测试，照抄仓库已有的「逐文件扫描仓库确认」做法，SB §4）：

1. `token` / `Authorization` / `Bearer` / `apiKey` / `api_key` 任何形态；
2. `repoUrl` 里的用户信息段（`https://user:pass@…`）——只允许出现 host/path；
3. **用户 prompt / assistant 正文**：契约里没有这些字段，快照构建时若手滑塞进去，测试必须红；
4. **`activeSessionTitle` 不许出现在 `latest.json`**：这是**用户的会话标题**，可能含人名/项目名。
   规则：`publishDots()` 出参前一刀切（`delete snapshot.dsh.activeSessionTitle`）+ 落盘前再断言一次；
5. 设备 IP：`dsh.webUrl` 会带局域网 IP，**这是本设计唯一主动写入仓库的网络信息**（私有仓库）；若用户不接受，
   工具参数 `includeUrl:false` 可关（默认 true），关掉后 R2 退化为「到电脑复制地址」的说明；
6. `sessionId` 原文不进快照（只给计数）；若要排障只允许前 8 位哈希。

---

## 6. 落地计划（3 个提交）

> 命令在仓库根执行（CT §4 的验收命令子集）。「真机」= 需要在鸿蒙/安卓平板上验证。

### 提交 1：契约 + 纯聚合（零 DSH、零 UI、可完全单测）

> **注**：本轮并行工作区里已经出现 `packages/dsh-dots/src/schedule/dots.ts`（只读聚合 + 保守状态，
> 本文未修改它）。提交 1 的实际内容是**把它与本文契约对齐并补齐 App 侧**，不是从零写；差异清单见 §8。

- 改/增：`src/schedule/dots.ts`（对齐 §2.1/§2.2，见 §8）、`src/schedule/index.ts`、`test/dots.test.mjs`；
  `apps/arkui-schedule/entry/src/main/ets/model/dots.ts`、`apps/arkui-schedule/tools/test/dots.test.mjs`。
- 内容：§2.1 的 `DotsScheduleDigest`/`DotsSnapshot` 类型 + §2.2 口径 + 稳定序列化/去重哈希；PC 与 App 各一份实现，**用同一批 fixture 断言两边输出逐字段相等**（防漂移，照抄 `aiPayload` 双端同源的既成做法，`aiPayload.ts:2`）。
- 验收：

  ```powershell
  pnpm build
  node --test "packages/dsh-dots/test/*.test.mjs"
  node --test "apps/arkui-schedule/tools/test/*.test.mjs"
  node apps/arkui-schedule/tools/validate-app.mjs
  node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json --noEmit
  ```
- 真机：**不需要**。

### 提交 2：DSH 状态读取 + 快照发布 + 工具面（PC only）

- 改/增：`src/schedule/dshStatus.ts`、`src/schedule/dotsPublish.ts`、`src/schedule/paths.ts`（新 scope guard）、
  `src/schedule/tools.ts`（`dsh_dots`）、`src/index.ts`（`config.dotsTool` + 宿主 `get` 透传）、
  `test/schedule-dots-status.test.mjs`、`test/schedule-dots-publish.test.mjs`、`test/schedule-dots-hygiene.test.mjs`（§5.3 扫描）。
- 内容：§3.1 全部；**先做 spike 再写实现**：在真实 DSH 里跑一次「`ctx.get` 拿 `sessionPersistence` / `sessionController`」的最小工具调用，把实测结果写进 §2.3 的「证据等级」（这是唯一可能翻盘的技术点，见 §7 风险 1）。
- 验收（追加）：

  ```powershell
  node --test "packages/dsh-dots/test/*.test.mjs"
  # 手工：DSH 里让模型调 dsh_dots {publish:true}
  git -C <工作副本> log --oneline -3 -- devices/desktop-*/dsh-status
  git -C <工作副本> show --stat HEAD      # 必须只有 dsh-status/latest.json 一个文件
  ```
- 真机：**不需要**（App 未动）。

### 提交 3：App 卡片 + 远程入口（App only）

- 改/增：`apps/.../model/dotsView.ts`（纯：合并本地 digest 与快照 → 6 块展示模型 + 五态文案）、
  `apps/.../services/dotsStore.ets`（pull 后读 `devices/*/dsh-status/latest.json`，失败不抛、内存缓存）、
  `apps/.../pages/Index.ets`（`DotsCard()` builder + 两处 body 各一次 + `onPullRefresh`/`onPageShow` 里 `loadDots()`）、
  `apps/arkui-schedule/tools/test/dotsView.test.mjs`。
- 约束：不得动 `SummaryCard` 顺序与页头（`indexHeader.test.mjs:71-79`）；不得新增页面（§1.2）；不得新增设置项（UI:5）。
- 验收：

  ```powershell
  node --test "apps/arkui-schedule/tools/test/*.test.mjs"
  node apps/arkui-schedule/tools/validate-app.mjs
  node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json --noEmit
  ```
- 真机：**需要**。三条验收路径：①平板 pull 后能看到块 2–4 的真实数字；②电脑发布一次 `dsh_dots {publish:true}` → 平板 pull → 块 1/5 出状态；③**删掉** `latest.json` 再 pull → 走 §4.4 第一行空态（不允许崩溃/白屏）。

---

## 7. 两个最大风险（按严重度）

1. **状态字段可能只剩两个（product 风险）**：`busy` / `lastActivityAt` / `activeSessionTitle` 依赖
   `sessionController` / `sessionTitle` 两个服务在本 profile 是否挂载、以及 Typert 直调是否真能跑通——
   代码证据齐（§2.3）但**一次都没实跑**。若 spike 失败，卡片只剩 `version` + `sessionCount` + `webUrl`，
   「DSH 状态」会退化成「DSH 版本 + 会话数」，观感打折。**缓解**：提交 2 第一件事就是 spike；失败则把 §2.1 的
   那三个字段标 `unknown` 并在 UI 里合并块 1/5（§4.2 已预留这个形态），不假装有数据。
2. **新增写入面会扩大契约与 git 噪声（工程风险）**：`paths.ts:90-105` 现在**只允许写 `devices/<id>/schedules/`**，
   放开 `dsh-status/` 是安全边界的一次真实扩张（DC §1 也要跟着改）；且每次发布都是一个提交，会把日程提交历史搅乱。
   **缓解**：新 guard 只放行**一个固定文件名**（`latest.json`，不接受任意路径）、`commitAll({onlyPath})` 限定目录
   （同 `bridge.ts:276` 的做法）、内容指纹去重 + 10 分钟最小间隔 + `push` 失败不抛。

次要风险（不单列）：`dsh.webUrl` 会把局域网 IP 写进私有仓库（§5.3 第 5 条给了开关）；`/__dsh_remote/*` 是第三方私有 API，
只能当可选加速（§3.2）。

---

## 附录：本文引用到的证据位置

| 位置 | 读到了什么 |
| --- | --- |
| `app.asar → dsh/package.json:2,4` | `@deepseek-ai/dsh-desktop-runtime` / `0.2.2-rc.3` |
| `app.asar → @deepseek-ai/dsh-session-persistence/src/index.ts:119-120,149,210` | `Context.sessionPersistence`、`super(ctx,'sessionPersistence')`、`list(): Promise<readonly SessionPersistenceSnapshot[]>` |
| `app.asar → @deepseek-ai/dsh-api-session-controller/src/index.ts:74-79,281-285` | `Context.sessionController` 声明；`@Remote('list') async list()` 实现（按 `remoteAccess.allows` 过滤） |
| 同上 `src/types.ts:154-167,252-254` | `SessionSummary`（含 `updatedAt/running/origin/parentSessionId`，**无 title**）；`SessionListValue {items}` |
| 同上 `src/list.ts:125-138,145-178` | 列表投影、`ctx.sessionQuery.listSessions`、`ctx.sessions.get`、按 `updatedAt` 倒序 |
| `app.asar → @deepseek-ai/dsh-session/src/index.ts:38-40` / `src/types.ts:95-136` | `Context.sessions: SessionStore`；`SessionHeader` 无 title |
| `app.asar → @deepseek-ai/dsh-session-title/src/index.ts:395` / `src/types.ts:51-56,79-87` | `sessionTitle.get(session)`；`SessionTitleSnapshot.title`；`title` 投影键 |
| `app.asar → @deepseek-ai/dsh-api-remote-access/src/index.ts:225-239` | `allows()` 在无 invocation 时返回 true |
| `app.asar → @deepseek-ai/dsh-typert-protocol/src/index.ts:250-317` | `@Remote` 只登记 marker，不替换方法本体 |
| `~/.dsh/profiles/web/package.json:3` / `cordis.patch.yml:7-11` | 已装 `dsh-mobile-remote@^1.6.1`；`webserver.host: 0.0.0.0` / port 3080（插件 auto-managed） |
| `…/dsh-mobile-remote/lib/index.js:276-328,415-431,694-756` | 进程内 `collectDshInfo`（version/sessions/workspaces/plugins/llm）；`authGate` 对内网放行；status 响应含 `dsh` |
| `…/dsh-mobile-remote/README.zh.md:29,43,97-101,154` | 「DSH 状态」卡既有能力；密码门禁；手机扫码即用完整 DSH UI；内网 `crypto.randomUUID` 兜底 |
| 仓库内 | `schedule/tools.ts`、`schedule/bridge.ts`、`schedule/paths.ts`、`schedule/clock.ts`、`engine/errors.ts`、`engine/paths.ts`、`apps/…/services/{scheduleStore,summaryStore,syncController}.ets`、`pages/Index.ets`、`model/dailySummary.ts`、`tools/test/indexHeader.test.mjs`（行号见正文） |
