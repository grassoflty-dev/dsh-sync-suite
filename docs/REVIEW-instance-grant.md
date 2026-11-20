# 独立评审：`mod-instance-grant`（只读）

> 对象：新增 `model/instanceGrant.ts`（619 行）、`services/instanceGrantStore.ets`（134 行）、`tools/test/instanceGrant.test.mjs`（516 行 / 39 例）；文档登记 3 处（`CLOUD-CHAT-AND-DOTS` §4 落地注、`MODULES` §1/§5/§6、`ROADMAP` 交接）。工作树并存的 `mod-cleanup-quickrecord` 两个删除文件不在范围，已忽略。
> 依据：`项目理解.md`、`docs/CLOUD-CHAT-AND-DOTS.md` §1/§4、`docs/REVIEW-remote-security.md` §2/§7。方式：静态逐行 + 4 道门闸复现 + 2 个运行时边界探针；未改任何源码/测试。

## 1. 结论

**P0 = 0，P1 = 0，P2 = 3（均不阻断）。可以提交。**
crux（显式命令、跨实例隔离、吊销/过期 fail-closed、无凭据无日志）全部兑现且有测试钉死；下列 P2 都是"失败方向安全"的健壮性/一致性缺口，不构成提权或跨实例泄漏。

## 2. Findings（`file:line`）

| 级别 | 定位 | 问题与证据 |
| --- | --- | --- |
| P2-1 | `model/instanceGrant.ts:518` + `:355-360` + `:605-608` | 非法 `nowMs` 吊销写出 `revokedAt=0`，而 `validTime(0)=false`；重编码后 `decodeGrants` 判 `E_GRANT_ENVELOPE_ITEM`，**整表回落空表**（实测 items=0）。方向 fail-closed（全部授权失效），但一次坏吊销清掉所有实例授权。`R-03:341-343` 只钉当场 `isGranted=false`，未钉持久化回读。 |
| P2-2 | `model/instanceGrant.ts:603-611`（对比不变式 `:10-11`） | `decodeGrants` 不按 grantKey 去重，可容纳两条同键授权；`isGranted:419` / `grantedTools:433-437` 对其取并集（实测同键两条 → `canPrompt=true`）。前提是可写本地 `instance-grants.json`，不增加超出"能改本地文件"的权限，但违背"同键只有一条、无隐式并集"的自述。 |
| P2-3 | `tools/test/instanceGrant.test.mjs:462-471` 等 | 规范缺口：`redactGrant` 的 `expiresAt` 分支未钉（D-02 只覆盖 `revokedAt`）；store 类运行时（`lastProblem()` 坏表恢复、`redacted()`、存储不可用）无执行测试，仅 `S-03:496-506` 源码正则守卫；无"吊销后显式再授"与"同键重复信封"用例。 |

## 3. 显式命令规则证明（crux）

- 集合：`VIEW_TOOLS = [instance.list, instance.inspect, session.list, session.read]`（`:45-50`），`COMMAND_TOOLS = [session.prompt]`（`:53`），`ALL_GRANT_TOOLS` 仅在 `:61` 收录一次；`isViewTool`/`isCommandTool` 各查自己数组（`:81-94`），不相交。
- 归一：`normalizeGrant:336-343` 只接受显式出现的工具；`canonicalTools:266-274` 遍历 `ALL_GRANT_TOOLS` 仅做去重/排序，**不补入**工具。
- 判定：`isGranted:402-424` 唯一放行条件 `g.tools.indexOf(wanted) >= 0`（`:419`），无 view→prompt 推导；`grantedTools:427-440` 只遍历 `g.tools`（`:433`）；`canPrompt:443-445` 直接委托 `isGranted(...,TOOL_SESSION_PROMPT,...)`。
- 派生：`redactGrant:546` 的 `canPrompt` 同样走显式判定，纯 view grant 恒 false。
- 测试：`T-01/T-02:97-118` 钉集合与不相交；`G-01:228-234` 钉 view-only 的 `isGranted`/`canPrompt`/`grantedTools` 三者均不含 prompt；`G-02:236-247` 钉显式列出才生效；`D-01:449-460` 钉脱敏视图；`S-04:508-515` 源码守卫禁止 `VIEW_TOOLS.indexOf(...PROMPT)` 式推导。引入隐式 prompt 至少 5 例变红。

## 4. 隔离 / 吊销 / 过期证明

- 隔离：`isGranted:413` 与 `grantedTools:430` 都是 `g.instanceId !== instanceId → continue`（精确串匹配）；`grantKey:276-284` 以 `instanceId|dots` 为唯一键，`upsertGrant:484-508` 按键替换。`G-04:256-262` 钉 A 的 grant（含 prompt）对 B 的 `isGranted`/`canPrompt` 均 false、`grantedTools` 为空；`K-01:209-214`、`U-01:350-359` 钉跨实例键不同且并存。
- 时间：`grantActive:377-394` 仅在 `grantedAt <= t < min(revokedAt,expiresAt)` 为真，非法时间/非 dots principal 一律 false；`revokeGrant:514-535` 写 `revokedAt` 且重复吊销取 `Math.min`（不延长窗口）。
- 测试：`G-06:274-280` 未生效、`G-07:282-292` 过期即降权且不换令牌重试、`G-08:294-300` 吊销边界、`G-09:302-310` 多 grant 任一失效、`R-01/R-02:316-333` 吊销优先与更早 `revokedAt` 保留。
- `redacted()` 反映：`redactGrant:545-546` 的 `active`/`canPrompt` 由同一 `grantActive`/`isGranted` 派生，`D-02:462-471` 钉吊销后两者同时翻 false。无自动续期路径——时间流逝只会使授权失效。

## 5. Store 判定

- 单键 `instance-grants.json`（`instanceGrantStore.ets:30`），信封 `{v:1,items}` 由 `encodeGrants:567-574` 生成；`writeRaw:56-59` 一次 `AppStorage.setOrCreate` 整串替换 = 属性级原子写（非 fs tmp+rename，见 unverified）。
- 坏表：`load:68-84` 调 `decodeGrants`，坏值→空表+typed problem；`lastProblem:106-110` 先触发懒加载再返回；存储 API 异常落 `E_GRANT_STORAGE_UNAVAILABLE`，全路径不抛给 UI（`E-03:414-436` 钉 10 种损坏输入）。
- 无 token 字段、无日志：独立 grep `token|secret|password|bearer|authorization|console|hilog|logger` 对两份源码**零命中**；`InstanceGrant.note`（`:133`）是唯一自由文本，`redactGrant:538-555` 结构上剥除，`D-01:458-459` 钉 `hasOwnProperty(note)=false` 且 JSON 不含备注内容；`S-01/S-02:480-494` 为常驻守卫。
- 结论：store 契约成立；仅 P2-1/P2-2 的边界如上。

## 6. 测试质量

39 例全部为真实断言（编译产物导入 + 源码正则守卫），非占位。三类回归均会变红：隐式 prompt（`G-01`、`D-01`、`S-04`）、跨实例泄漏（`G-04`、`K-01`、`U-01`）、吊销仍有效（`G-08`、`R-01`、`D-02`）。缺口见 P2-3；建议后续补 `redactGrant` 过期用例、store 层坏表、`revoke→upsert` 再授与重复键信封。

## 7. 门闸（复现，尾部原样）

```
node --test .../instanceGrant.test.mjs  → ℹ tests 39 / ℹ pass 39 / ℹ fail 0 / ℹ skipped 0 ; EXIT=0（tsc 重建后复跑同）
node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
   → ℹ tests 2952 / ℹ suites 349 / ℹ pass 2951 / ℹ fail 0 / ℹ skipped 1 ; EXIT=0
node .../tsc -p .../tools/tsconfig.json  → （无输出）; EXIT=0
node .../validate-app.mjs               → ✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 422 条、
   main 静态 import 541 条、页面 8 个、rawfile/git 2 个文件）; EXIT=0
```
四项与任务书期望逐字一致。

## 8. Scope / ArkTS hygiene

- 零 UI：全 `ets/` grep `instanceGrantStore|from '../model/instanceGrant'|canPrompt(` 只命中两个新文件自身，无页面/组件接线；零 RPC：`packages/` grep `instanceGrant|session.prompt` 无命中。
- 纯 TS 模型只有一处相对 import `./instances`（`:24`），复用 `INSTANCE_ID_PATTERN=/^(local|inst-[0-9a-f]{16})$/`（`instances.ts:31`）；无 SDK import，导出声明均带显式类型；`.ets` store 仅用 `PersistentStorage`/`AppStorage`。`tsc` 与 `validate-app` 8/8 成立。

## 9. unverified

- 真机/ArkTS 编译与装机：设备 suspended，未做（同既有评审口径）。
- store 的"原子"依赖 `AppStorage`/`PersistentStorage` 刷盘语义，未做断电/并发写实测；Windows 上文件权限模式无意义。
- 跨机 grant 一致性、确认卡与实际 `sessionPrompt` RPC 属于后续模块，本片未接线，无法验证。
- 两个边界探针只在 Node 编译产物上执行，未在设备 store 上复现。

> **追记（2026-11-21，同模块 id 后续批次）**：上文三项 P2 已修复并登记于 `docs/MODULES.md` §5 的 2026-11-21 行——P2-1 `revokeGrant` 改为先校验 `nowMs`，非法返回 `E_GRANT_NOW` typed 拒绝且原表不动，store 拒绝时不写回；P2-2 `decodeGrants` 按 grantKey 去重（最新 `grantedAt` 胜，同刻 `grantId` 大者胜）；P2-3 补齐 expiresAt 脱敏、revoke→再授、重复键信封等 6 例。定向测试 45/45、全量 2958/2957/0/1、tsc exit 0、validate-app 8/8。本节原有结论与行号记录保持历史原样，不随修复改写。
