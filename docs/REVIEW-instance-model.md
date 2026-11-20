# mod-instance-model 独立只读评审

> 日期 2026-11-20；对象为工作树未提交的三新增文件 + 四处文档登记行。
> 已先读 `项目理解.md`、`docs/REMOTE-INSTANCES.md` §2/§6、`docs/REVIEW-remote-security.md`。
> 树内 `mod-export-json` 在途改动（`Settings.ets`/`DataSection.ets`/`export*` 等）按任务书忽略。
> 本评审纯静态 + 重跑门禁 + 编译产物探针，未改任何源码/测试。

## 结论

- **P0 0 / P1 0 / P2 2**；**可以提交**（P2 非阻断、不进 Git/导出/日志；建议提交前补 P2-1 用例并修，或写入 `unverified`）。
- P2-1：fragment 里的 token 进入持久 `url` 与 id 哈希，违反「url 永不含 token / token 不参与哈希」。
- P2-2：设计稿 §2 字段表、§3 新 RPC 仍用旧名 `displayName`/`tokenRef`，与落地 `name`/`token` 并存。

## Findings

**P2-1（token 不变量，边界值）** `model/instances.ts:150-184` 的 `findUrlToken()` 先截掉 `#` 再找 `?`；
`model/instances.ts:315` 依赖 `remoteUrl.ts:553-589` 的 `stripRemoteToken()`，后者把 fragment **逐字保留**
（`remoteUrl.ts:560,586,588`）。于是 `http://h/#token=S` 归一后 `url` 仍含 `S`，`token` 字段为空
（`instances.ts:387-401`），`instanceIdFromUrl()`（`instances.ts:310-320`）哈希了带 token 的 URL。
探针实证：`normalizeInstance({url:'http://h:3080/#token=FRAGMENT_SECRET_123'})` → `url` 含明文、
`token===undefined`，id `inst-3dfd3be8e1916036` ≠ 干净地址 `inst-2f06382cff0c2e46`。
`redactUrl()` 会打码该值（`instances.ts:413-420`，测试 R-03 通过），故不到日志/展示/导出，定 P2。
修法：`normalizeInstance`/`instanceIdFromUrl` 先剥离 fragment 中的 token 对再落盘/哈希。

**P2-2（文档一致性）** `docs/REMOTE-INSTANCES.md:69` 的落地注记本身**准确**（`name`/`token`/
`reachable:'unknown'|'ok'|'fail'`、`inst-<sha16>`、本机首行、`{v:1,items}` 均与代码一致）；
但 `:41-43`、`:58` 仍写 `displayName`/`tokenRef`/布尔三态，`:93` 的 `instanceList` 响应仍用
`displayName`/`urlMasked`。注记说「以已落地模型为准」，但字段表未标注新旧映射，后续模块若照表消费会取错名。

## Token 安全分析

- query 令牌（`?token=`/`?k=`，大小写不敏感）由 `findUrlToken()` 抽出到 `token` 字段，
  `url` 只留 base（`instances.ts:363-376,387-401`；N-07/N-09 钉死）。
- `redactUrl()` = `sanitizeUrlForDisplay` + `maskTokenPairs`（`instances.ts:186-200,413-420`），
  覆盖 `?token=`/`?k=`/大小写/fragment/空值（R-01~R-03 实证）。
- `redactInstance()` 接口与对象**无 token 属性**，只有 `tokenSet`（`instances.ts:101-112,426-453`；R-04）。
- 日志：三文件 `(console|hilog|logger)\.` grep 为 0（S-02/S-03 + 本评审复检）。
- 文档/导出：无任何文件 import `instanceStore`/`model/instances`（`git grep` 为空），
  `encodeInstances()` 的 token 只进 preference 信封（`instances.ts:594-614`），不在导出 bundle 路径上。
- 结论：query token 无外泄通道；唯一漏洞是 P2-1 的 fragment 变体（仍不外泄到日志/文档/导出）。

## 模型 / 存储判定

- 模型：`inst-<sha16>` 用 token-free URL（`:310-320`）；六方式精确枚举不回落（`:359-362`）；
  形状→id→mode→url→name 全部 typed 拒绝（`:351-406`）；`sortInstances` 本机优先再 name→id、不改入参
  （`:456-480`）；upsert 同 id 替换、remove 拒 `local`、find 精确（`:486-529`）；`capabilities` 由
  `deriveCapabilities()` 生成、`encodeInstances` 不写该字段（`:280-286,594-614`）；`applyReachability`
  仅 `ok` 推进 `lastSeen`（`:535-574`）。除 P2-1 外正确。
- 存储：`instanceStore.ets:31` 单键 `instances.json`；`:88-99` 排序→整串编码→一次 `setOrCreate` 原子写；
  `:69-85` 懒解码、读异常与坏信封都回落空表 + typed `problem`；`:107-111` `lastProblem()` 先触发 load；
  `:101` 注释明确不自动播种 `local`，由调用方用 `localInstance()` 决定。无异常抛进 UI，正确。

## 测试质量

28 例均为真断言（N/R/L/E/S）：删打码会红 R-01~R-04，改排序会红 L-02，坏信封抛错会红 E-03，加日志会红 S-02/S-03。
缺口（按优先级）：① fragment token 的归一/id 用例（即 P2-1，现只测了 `redactUrl` 显示侧）；
② store 运行时用例（坏信封 → `lastProblem()` typed + `redacted()=[]`、写失败内存镜像、不自动播种）现仅静态守卫 S-01；
③ `?TOKEN=` 大写键抽取到 `token` 字段、非法 `nowMs` 的 `markReachable` 无用例。

## 门禁尾巴（本评审重跑）

```
overlay:  [overlay] applied=false
tsc:      TSC_EXIT=0（无输出）
instance: ℹ tests 28 / ℹ pass 28 / ℹ fail 0 / ℹ skipped 0
full:     ℹ tests 2926 / ℹ pass 2925 / ℹ fail 0 / ℹ skipped 1
validate: ✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 430 条、main 静态 import 551 条、页面 7 个、rawfile/git 2 个文件）
```
全部与简报期望一致。`pages/**` 无本模块改动（`Settings.ets` 变更属 export-json）；
`git grep` 无新模块 import、`git diff` 无 probe 代码行 → 强制编译用的临时 probe 已还原。

## unverified

- 真机两次 `BUILD SUCCESSFUL`、probe 文件名与产物验收只见于登记行（`MODULES.md:177`/`ROADMAP.md:619`），无法重跑。
- preferences 明文、无 HUKS、Windows 无 0600 ACL 加固；无 UI 接线，`PersistentStorage`/`AppStorage` 行为未真机验证。
- 简报行号 622/131/404 与实读 658/142/406 不符，疑似简报基于更早快照；本评审以当前工作树为准。
