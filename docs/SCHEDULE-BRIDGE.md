# 日程桥（SCHEDULE-BRIDGE）

电脑端 DSH 与鸿蒙平板**共用同一个 Git 仓库**：一个仓库装两类数据，互不覆盖。

```
<同一个仓库>
├── devices/desktop-pvrp3qs/                 # 电脑（DSH 配置快照，现有插件写，本模块不碰）
│   ├── cordis.patch.yml / providers.json / plugins.json / mcp.json / manifest.json
│   └── schedules/2026-11-15.jsonl           # 电脑写的日程（本模块写）
└── devices/pad-xxxx/                        # 平板（App 写，本模块只读）
    ├── schedules/2026-11-15.jsonl
    └── summaries/2026-11-15.json
```

两边 `deviceId` **必须不同**（`^[a-z0-9][a-z0-9-]{0,31}$`，默认取主机名），App 侧同步组填**同一仓库地址 + 同一 token**。
工作副本复用配置同步的 `~/.dsh/git-config-sync/work/<repoHash>/`：同一 `repoUrl` → 同一份 clone，不需要第二份配置。

## 1. JSONL 契约（不新造格式）

权威定义见 [`docs/DATA-CONTRACT.md` §3](DATA-CONTRACT.md)；平板侧权威实现是
`apps/arkui-schedule/entry/src/main/ets/model/jsonl.ts`（`encodeRecord` / `parseJsonl` / `foldById`）。
本模块 `src/schedule/jsonl.ts` 是 Node 侧**逐条对应**的移植：

- 一行一个 JSON 对象，**只追加，绝不重写历史行**（`appendFile` 物理追加）；
- 字段顺序固定 `id, ts, title, body, [ocr_text], author, done, [attachments], [ai_structured], ai_processed, [ocr_time]`，
  未知扩展字段原样排在末尾（读路径不报错、不丢弃）；
- 同一 `id` 允许多行（事件溯源），`foldById` 先按 `ts` 稳定升序、后者覆盖前者；
- `id` / `ts` 与 App 同形：`id = Date.now().toString(36) + '-' + Math.floor(Math.random()*1679615).toString(36)`；
  `ts = 本地时区 ISO（秒级，如 2026-11-15T21:45:27+08:00）`。
  依据：`src/schedule/clock.ts` 与 App 的 `services/scheduleStore.ets:newRecordId`、`common/date.ts:nowIso/nextTsSameDate` 一行一行对应。

## 2. 工具面（注册给模型）

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `schedule_list` | `date?`（YYYY-MM-DD，省略=今天）、`deviceId?`（省略=本机，`all`=全部设备） | `{date, deviceIds, refreshed, note?, errors, records:[{id, ts, date, deviceId, title, author, done, bodyPreview, bodyLength, hasAttachments, aiProcessed}]}` |
| `schedule_add` | `date?`、`title`（必填）、`body?`、`author?`（缺省「我」） | `{id, ts, date, deviceId, path, commit, pushed, rebased, files}` |
| `schedule_summary` | `date?`、`deviceId?` | `{date, deviceIds, count, refreshed, note?, aiNote?, summary, prompt, payload}` |

- 注册位置：`packages/dsh-git-config-sync/src/index.ts` 的 `mountScheduleTools()`；
  定义在 `src/schedule/tools.ts`（`registerScheduleTools(ctx, {paths})` → `ctx.tools.register(...)`，逐个挂在 `ctx.effect` 上）。
  `tools` 是**可选**依赖（`ctx.inject(['tools'], …)`），宿主没有 tools 服务时插件照常挂载、配置同步 RPC 不受影响。
- 每次执行都重新读 `settings.json`：设置页换仓库/设备标识后下一次调用立即生效。
- 想整机关掉日程工具：插件行 `config.scheduleTools: false`（RPC 与配置同步不受影响）。
- 想直接调库：`listSchedule(repo, deviceId|'all', date, {ownDeviceId})`、`addSchedule(repo, deviceId, date, {...}, {ownDeviceId})`、
  `summarySchedule(repo, deviceId|'all', date, {ownDeviceId})`；`ownDeviceId` 决定哪个目录可写、以及 `'all'` 的排序。
- 正文摘要只给前 80 字（超长补 `…`）；`schedule_summary` 的载荷与提示词复用
  `apps/arkui-schedule/entry/src/main/ets/model/aiPayload.ts` 的契约（`{date, records:[{id, ocr_time, text}]}`、
  `text` 优先 `body`、为空退回 `ocr_text`、提示词注入当前时间与时区）。
- AI 调用：设置 `DSH_SCHEDULE_AI_KEY`（或 `DEEPSEEK_API_KEY`）后由插件用 Node `fetch` 调
  `DSH_SCHEDULE_AI_BASE_URL`（默认 `https://api.deepseek.com`）+ `DSH_SCHEDULE_AI_MODEL`（默认 `deepseek-chat`）；
  未配置时只返回 `payload` + `prompt`（`summary` 为空串、`aiNote` 说明原因），由调用方自己汇总。

示例：

```
schedule_add  {date: "2026-11-15", title: "周会", body: "讨论同步方案", author: "我"}
→ devices/desktop-pvrp3qs/schedules/2026-11-15.jsonl +1 行，已 commit + push

schedule_list {deviceId: "all"}
→ 09:30 [未完成] 手写备忘 · 我 · pad-xxxx · id=...
  21:45 [未完成] 周会 · 我 · desktop-pvrp3qs · id=...

schedule_summary {date: "2026-11-15"} → payload + prompt（配了 key 则直接给 Markdown 摘要）
```

## 3. Git 冲突策略

写顺序：`ensureWorkTree` → **`pull --rebase`** → 追加一行 → `git add devices/<本机>/schedules` → commit → `pushWithRebase`。

- 先拉后写：远端已被推进时先 rebase，冲突**立即中止**（`git rebase --abort`）并抛 `E_CONFLICT`；
- 永不 `force push`；非快进最多 retry 2 次（`GitRepo.pushWithRebase`）；
- 冲突时远端 HEAD 不变、本机文件回到自己的提交，**双方记录都不会被覆盖**，报错里带 git 的冲突摘要；
- 提交范围只有 `devices/<本机>/schedules`：别的设备文件与 `devices/<本机>/*.json` 不会被带进日程提交
  （`GitRepo.commitAll({onlyPath})` 会把范围外的脏文件还原，避免污染）；
- 读路径（`schedule_list` / `schedule_summary`）同样会尽力拉取，但**失败不报错**：工作副本脏就跳过，
  网络/冲突失败降级为 `refreshed:false` + `note`，仍返回本地副本。

## 4. 安全边界

- 只允许写 `devices/<本机 deviceId>/schedules/<YYYY-MM-DD>.jsonl`：`assertSchedulesScope` 拒绝别的设备目录、
  `summaries/`（平板侧写）、含 `..` 的路径、设备目录本身；`resolveInsideRepo` 再挡一次"逃出仓库根"。越界一律 `E_VALIDATION`。
- `date` 必须是真实存在的日历日（`2026-02-31` 拒绝）；`deviceId` 必须匹配 `^[a-z0-9][a-z0-9-]{0,31}$`。
- **token 不进日志、不进仓库**：HTTP 认证走 `GitRepo` 的临时 `GIT_ASKPASS` + 环境变量，本模块从不读取/打印 token；
  工具返回值、错误消息、AI 请求头都经过同一套脱敏（测试逐文件扫描仓库确认）。
- 不写 `summaries/`、不回写 `ai_structured`/`ai_processed`（回写属于平板侧编辑流程，PC 只读）。

## 5. 怎么配成"同一个仓库"（三步）

1. **电脑**：`设置 → Git 配置同步` 填仓库地址（https + token 或 SSH）、设备标识 `desktop-pvrp3qs`、分支；点「测试连接」。
2. **平板**：App `设置 → 同步` 填**同一个仓库地址 + 同一个 token**，设备标识改成**另一个**值（如 `pad-xxxx`）——
   两个 `deviceId` 相同会让两台机器写同一份 JSONL，容易 rebase 冲突。
3. **验证**：电脑说「列一下今天的日程，所有设备」→ 能看到平板那条；再说「加一条日程：周会」→
   平板同步后即可看到（`devices/desktop-pvrp3qs/schedules/<今天>.jsonl`）。

## 6. 相关文件与测试

| 文件 | 职责 |
| --- | --- |
| `src/schedule/types.ts` | 与 App 共用的数据形状 |
| `src/schedule/clock.ts` | `newRecordId` / `nowIso` / `nextTsSameDate`（与 App 同形） |
| `src/schedule/jsonl.ts` | JSONL 编解码、`appendRecord`、`foldById` |
| `src/schedule/paths.ts` | 路径构造与越界防护 |
| `src/schedule/aiPayload.ts` / `aiRequest.ts` | 汇总载荷/提示词、OpenAI 兼容请求 |
| `src/schedule/bridge.ts` | `ScheduleBridge`：`list` / `add` / `summary`，`withScheduleBridge` 工厂 |
| `src/schedule/tools.ts` | 三个工具的定义与注册 |
| `test/schedule-jsonl.test.mjs` / `test/schedule-bridge.test.mjs` | 纯逻辑 + 真实临时仓库集成测试 |

跑测试：`node --test "packages/dsh-git-config-sync/test/*.test.mjs"`（当前 98 例全绿）。
