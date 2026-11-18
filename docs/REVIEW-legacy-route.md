# 临时兼容路由独立评审（只读）

> 评审子代理：dotslead/review-dotslead（向 dotslead 汇报，不面向 lead）。
> 基线：分支 `main`，`git log -1 --format=%h` = `0e7adeb`；DSH-Dots 改名尚在工作树未提交。
> 评审方式：纯静态阅读（read/grep + 只读 git diff）。**未运行 build、未运行 test、未改动任何源码/测试/dist/profile**。
> 唯一写入：本文件与 `docs/REVIEW-state-migration.md`。时间：2026-11-18。

## 0. 结论

**通过，可进入提交。** 两条 exact 路由共用同一个 handler（鉴权不可绕过）、各自返回独立注销函数（卸载都能清）、effect 计数断言与实现逐项吻合、客户端只用新路径、旧路径字面量仅存在于带"临时兼容、后续删除"注释的常量中。**0 个 P0 / 0 个 P1 / 0 个 P2。** 文末列有 3 条非阻断建议。

## 1. 评审对象与读取路径

| 对象 | 路径 | 读取方式 |
| --- | --- | --- |
| host 入口（源） | `packages/dsh-dots/src/index.ts`（173 行，全读） | read |
| host 入口（产物） | `packages/dsh-dots/dist/index.js`（90 行，全读） | read |
| 共用 handler | `packages/dsh-dots/src/rpc.ts:787-832`（`createHttpHandler`） | read |
| 兼容路由测试 | `packages/dsh-dots/test/confirm-gate.test.mjs:205-277`（全文件亦读） | read |
| effect 计数测试 | `packages/dsh-dots/test/schedule-bridge.test.mjs:450-513`（全文件亦读） | read |
| 客户端（源/产物） | `packages/dsh-dots/src/client.js`、`dist/client.js`（grep 路径/ID/NS） | grep |
| 客户端测试 | `packages/dsh-dots/test/client-module.test.mjs:11-29` | read |
| 命名/版本 | `cordis.patch.yml:1-6`、`package.json`、`AppScope/app.json5` | read + 只读 git diff |

`src/index.ts` 与 `dist/index.js` 逐函数一致：`inject`、`RPC_PATH`、`LEGACY_RPC_PATH`（含注释）、`mountScheduleTools`、`apply` 的两条路由注册与 5 个 effect（源 `65-173` ↔ 产物 `4-90`）。**构建产物未落后于源码。**

## 2. 逐项结论

### 2.1 legacy 路由与 RPC_PATH 是否共用同一个 handler（鉴权不可绕过）

**通过。** `src/index.ts:128` 只创建一次 `const handler = createHttpHandler(service, ctx.connection)`；`:130-137` 两条 `ctx.webServer.register({ kind:'exact', path, handler })` 传入的是**同一个 handler 引用**（`:131` 用 `RPC_PATH`，`:135` 用 `LEGACY_RPC_PATH`）。`dist/index.js:63-65` 相同。

鉴权在 handler 第一条语句：`src/rpc.ts:794-802` 先 `connection.requestRejection(req)`，非 null/undefined 立即 `res.statusCode = rejection; res.end(); return`，之后才判 method（`:803-808`）与解析 body（`:809-825`）。因此**旧路径不存在"绕过 requestRejection 直达 handleRpc"的分支**。

测试 `test/confirm-gate.test.mjs:258-270` 对**两条路由都**做了同样的两轮请求：正常 `getState` → 200 + `ok:true`；带 `x-test-forbidden` → 403 且 body 为空，逐条断言（`:268-269`）。这直接钉住了共用 handler 的鉴权语义，不是只看常量。

### 2.2 两条 exact 路由各自的 effect 是否返回正确注销函数

**通过。** `src/index.ts:130-133` / `:134-137` 的 effect 回调直接 `return ctx.webServer.register({...})`，即把宿主 `register` 返回的注销函数作为 effect 的 dispose 交回 Cordis（`dist/index.js:64-65` 同）。`register` 的返回类型在 `WebServerLike`（`:41-49`）明确为 `(() => void) | void`。

`test/confirm-gate.test.mjs:217-239` 的 ctx stub 把每次 `register` 的返回值收进 `cleanups`（`:231-238`），并在 `:272-275` 逐个执行；`:276` 用 `new Set(unregistered)` 与 `new Set([RPC_PATH, LEGACY_RPC_PATH])` 深比较，**证明两条路由都被注销，不存在只清一条的泄漏**。同时 `:247-250` 断言两条路由都是 `kind:'exact'` 且 handler 为函数。

其余三个 effect 的 dispose：RPC service（`:138-143`）、remote service（`:145-153`）、remote autostart（`:155-165`）都返回明确函数（autostart 返回 `() => undefined`）；上述测试 `:273-275` 会一并调用，未抛错。

### 2.3 effect 计数断言是否与实现一致（confirm-gate=5、schedule-bridge=9/5/5）

**通过，逐项来源如下。** `apply()` 的 effect 固定顺序为：
1. 新 RPC 路由（`src/index.ts:130-133`）；
2. legacy RPC 路由（`:134-137`）；
3. RPC service dispose（`:138-143`）；
4. remote service dispose（`:147-152`，仅 `remote !== null`，默认 `remoteAccess !== false` 且 `createRemoteModule` 成功 → 成立）；
5. remote autostart（`:155-164`，同上）。

此外 `scheduleTools !== false` 时 `mountScheduleTools`（`:167-172`）→ `registerScheduleTools` 为每个工具各挂一个 effect（`src/schedule/tools.ts`），共 4 个（`schedule_list`/`schedule_add`/`schedule_summary`/`dsh_dots`，见 `test/schedule-bridge.test.mjs:403`、`:408`）。

| 断言 | 位置 | 期望 | 实现计算 | 结论 |
| --- | --- | --- | --- | --- |
| confirm-gate `effects.length` | `confirm-gate.test.mjs:252-256` | 5 | 3（RPC 相关）+ 2（remote）= 5（该 ctx 无 tools/inject，日程工具不挂） | ✓ 一致 |
| schedule-bridge 有 tools | `schedule-bridge.test.mjs:492` | 9 | 3 + 2 + 4 = 9 | ✓ 一致 |
| schedule-bridge 无 tools | `schedule-bridge.test.mjs:502` | 5 | 3 + 2 + 0 = 5 | ✓ 一致 |
| schedule-bridge `scheduleTools:false` | `schedule-bridge.test.mjs:512` | 5 | 3 + 2 + 0 = 5 | ✓ 一致 |

测试注释本身已写明来源（`confirm-gate:255`、`schedule-bridge:492,502,512`），与实现逐项对应，无虚高/虚低。`remoteAccess:false` 时会少 2 个 effect（3），实现一致但**未被上述用例覆盖**（非阻断，见 §4）。

### 2.4 client.js 是否只用新 RPC 路径

**通过。** `src/client.js:34` `const RPC_PATH = '/dsh-dots/rpc'`；`:1053-1057` 的 `rpcCall` 只 `fetch(RPC_PATH, ...)`，全文件再无第二个 RPC 终点。`dist/client.js:34,1057` 相同。grep `/dsh-[a-z-]*/rpc` 在 `src/client.js` 与 `dist/client.js` 中**只命中 `/dsh-dots/rpc`**（另命中注释 `:20`），**没有 `/dsh-git-config-sync/rpc`**。测试 `test/client-module.test.mjs:24-29` 断言 `/\/dsh-dots\/rpc/`，`:11-15` 断言模块 id `dots`。

命名核对：client module id `dots`（`client.js:28`）、locale NS `dots`（`:33`，`locale.register` 在 `:4058`、`bind` 在 `:4065`）、settings section id `dots`（`:4096`）、bundle patch id `dots`（`cordis.patch.yml:5`）、npm 包名 `dsh-dots`（`package.json`）；均符合硬规则。`version: 1.0.0` 未变（`package.json` diff 仅 name 行），`apps/arkui-schedule/AppScope/app.json5` 的 `git diff` 为空 → `bundleName: com.itwill.schedule` 与版本号未被改动。

### 2.5 旧路径是否只在兼容常量中出现，注释是否说明"临时兼容、后续删除"

**通过。** grep `git-config-sync`（`*.ts` / `*.js`）全仓命中 6 条，全部落在允许位置：
- `src/index.ts:73` `LEGACY_RPC_PATH = '/dsh-git-config-sync/rpc'`，其上方 `:69-72` 注释明确"**临时兼容旧路径、后续删除**……老客户端下线后删除此常量与下面对应的那条注册即可"；
- `src/engine/paths.ts:38` `LEGACY_STATE_DIR_NAME`（注释 `:37`"临时兼容……迁移完成后可删除"）、`:85` 必要注释；
- `dist/index.js:10`、`dist/engine/paths.js:27,58` 与上对应的产物；
- `dist/index.js:6-8` 同样保留了"临时兼容旧路径……后续删除"注释，且 `:65` 的 effect label 为 `'dsh-dots: legacy rpc route (临时兼容旧路径、后续删除)'`（源 `src/index.ts:136`）。

客户端侧零命中（§2.4）。没有在路由表、配置、profile、文档硬编码里散布旧路径。

## 3. 总体结论（是否可进入提交）

**可以进入提交。** 本评审范围内未发现 P0/P1/P2；鉴权共用、注销完备、计数一致、命名合规、产物与源码同步。注意：状态目录迁移另有 1 个 P1（见 `docs/REVIEW-state-migration.md`），那是另一篇评审的对象，不影响本篇"兼容路由可提交"的结论，但**整批改动是否提交应以那篇的总体结论为准**。

## 4. 未覆盖 / 建议补充项（均非阻断）

1. 增加 `remoteAccess:false` 场景的 effect 计数断言（应为 3：新/旧路由 + RPC dispose），防止远程装配失败被误当成路由注册失败。
2. 测试 `ctx.webServer.register` 返回 `void`（宿主不提供注销函数）时的卸载行为，确认 Cordis 侧不会因 `undefined` dispose 报错（实现类型已允许 `void`）。
3. 待老客户端彻底下线后，按 `src/index.ts:69-72` 的注释一起删除 `LEGACY_RPC_PATH` 常量、`:134-137` 的注册与对应两条测试断言；当前保留是有意兼容，不算缺口。
