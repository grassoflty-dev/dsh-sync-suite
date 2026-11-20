# mod-instance-list 独立只读评审

> 日期 2026-11-20；对象为工作树未提交的 3 新增文件（`pages/Instances.ets`、`model/instanceSeed.ts`、
> `tools/test/instanceList.test.mjs`）+ 5 修改文件（`model/instances.ts`、`services/instanceStore.ets`、
> `tools/test/instanceModel.test.mjs`、两份 `main_pages.json`、`pages/Settings.ets` 入口行）。
> 已先读 `项目理解.md`、`docs/REMOTE-INSTANCES.md` §1/§2/§6、`docs/REVIEW-instance-model.md`。
> 树内 A/B 及其它模块的在途改动按任务书忽略，仅核 `Settings.ets` 的入口行。纯静态 + 重跑门禁 + 探针，未改源码/测试。

## 结论

- **P0 0 / P1 0 / P2 1**；**可以提交**（P2 非阻断，见下）。六项核查全部通过。
- 上轮 `REVIEW-instance-model.md` 的 P2-1（fragment token 进持久 url / id 哈希）已由本模块定向修复，
  经独立探针 + E-07/S-07 钉死；P2-2 字段映射由 `REMOTE-INSTANCES.md:71-80` 补齐。

## Findings

**P2-1（非阻断，令牌出口边界）** `pages/Instances.ets:286-299` 空态次操作「用浏览器打开」把
`settingsStore.cached().remoteUrl`（可能含 `?token=`）作为 `Want.uri` 交系统浏览器（:287-296）。
属用户主动出口（类比 `remoteShowLink`），不在 UI/日志/文件落明文；但绕过 `remoteShowLink`，
Android Intent / 浏览器历史是否留痕 `unverified`。建议提交前在 :288 与 :295 间剥 token 或写入免责说明。

## 注册证明

- 两份 profile 各 +1 行、均含 `pages/Instances`：`entry/src/main/resources/base/profile/main_pages.json:8`、
  `entry/src/harmony/resources/base/profile/main_pages.json:9`（`git diff` 各 1 行）。
- main 清单 8 条 == 磁盘 8 个页面 `.ets`（Index/Edit/Detail/Settings/RemoteControl/Instances/Chats/ChatDetail）；
  harmony 9 条为超集（多 `pages/Handwriting`，既有鸿蒙覆盖页）。validate-app 规则 3 明确要求 harmony 是超集，
  故两表一致且正确。实测 `✅ 8/8 条规则（…页面 8 个…）`。U-01（`instanceList.test.mjs:211-214`）钉死双表登记。

## 本机 guard 证明

- 无删除：删除按钮包在 `if (view.id !== LOCAL_INSTANCE_ID)`（`Instances.ets:436-449`）；`deleteInstance()` 再守一次
  （:271-273）；模型 `removeInstance()` 亦拒 `local`（`instances.ts:525-527`）。
- 无 URL 编辑：URL/方式输入框只在 `if (this.formId !== LOCAL_INSTANCE_ID)` 渲染（:478-494）；本机提交分支只传 name/mode
  （`submitForm()` :220-230）。
- 渲染第一：`sortInstances()` 本机优先（`instances.ts:473-481`）；`seedInstances()` 首行 push `localInstance()` 再排序
  （`instanceSeed.ts:89-97,100`）。L-02（`instanceList.test.mjs:152-163`）钉死顺序。

## Token 泄漏排查

- 唯一渲染 URL 出口 `Text(redactUrl(view.url))`（`Instances.ets:402`），输入来自 `instanceStore.redacted()`（:120）→
  `redactInstance()`，后者结构无 token、只 `tokenSet`（`instances.ts:101-112,457-465`）。无 `Text(full.url)`（U-03 :223-228）。
- 新页 / 种子 / store 三文件 `(console|hilog|logger)\.` grep = 0；新页无测试令牌字面量（:31 SECRET 仅测试夹具）。
  全仓 Secret 字面量仅见旧评审证据行 `docs/REVIEW-instance-model.md:20` 与测试夹具；UI/日志/文档无明文。
- 真身仅用于拼一次性打开地址（`mergeRemoteToken` :167-170）与保留 token（:249-250），不进 Text / toast。

## fragment / seed 判定

- `stripUrlFragment()` 为单次 `indexOf('#')+slice` 定向字符串截取（`instances.ts:198-201`），在
  `instanceIdFromUrl()`（:326-329）与 `normalizeInstance()`（:385-388）各调一次——两处都必要，否则 id 等式不成立。
  `remoteUrl.ts` 与 `stripRemoteToken` 的 `git diff` / `git status` 均空，完全未触碰。
- 独立探针：`instanceIdFromUrl('http://h/?k=S#token=S') === instanceIdFromUrl('http://h/?k=S')` = true；
  归一后 `url='http://h/'`、`token='S'`、无 `#`/无明文。E-07（`instanceModel.test.mjs:353`）、S-07（`instanceList.test.mjs:115-122`）钉死。
- `seedInstances()` 用 `normalizeRemoteUrl(raw)` 后的 `check.url`（`instanceSeed.ts:102,107,113`），注释明令
  `绝不把 raw 直接喂给实例模型`（:106），U-09 断言无 `url: raw`。幂等：按 id 去重（:108）+ 本机缺才补（:89-97），
  S-03（:73-80）断言三次播种信封字节相等；`ensureSeeded()` 信封相等即不写盘（`instanceStore.ets:114-121`），U-08 断言。

## 测试质量

- `instanceList.test.mjs` 25 例（S 8 + L 6 + U 11）全为直接断言：L-01 打码、S-03 重复播种、L-02 顺序、
  S-07 fragment、U-09 归一迁移——删打码 / 去幂等 / 改排序必红。
- `instanceModel.test.mjs` 改动 `38 增 0 删`（N-10 大写键 :177、E-07 :353、E-08 :395），原 28 例断言未动，只增强不削弱。

## 门禁尾巴（本评审重跑）

```
tsc:       TSC_EXIT=0（无输出）
instance:  ℹ tests 56 / pass 56 / fail 0 / skip 0  （25 + 31）
full:      ℹ tests 2913 / pass 2912 / fail 0 / skipped 1
validate:  ✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 428 条、main 静态 import 548 条、页面 8 个、rawfile/git 2 个文件）
```
均与简报期望一致。

## unverified

- 真机两次 BUILD SUCCESSFUL、ArkTS 编译、页面 / 入口实际跳转、AppStorage/PersistentStorage 行为无法重跑。
- 显式「用浏览器打开」的 Intent URI 是否在系统 / 浏览器历史留痕（P2-1）。
- preferences 明文、无 HUKS、Windows 无 0600 ACL 加固（承接 §6）；fragment token 被丢弃而非抽进 `token` 字段
  （`findUrlToken()` 契约只读 query，符合设计稿 §2）。
