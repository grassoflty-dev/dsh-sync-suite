# 模块独立只读评审：mod-cleanup-quickrecord（快捷记录死代码清理）

> 评审对象：未提交工作树（同树 `mod-instance-grant` 新文件与 `docs/CLOUD-CHAT-AND-DOTS.md` 不计入本模块）。
> 日期：2026-11-21；真机项一律 `unverified`。只读评审，仅新增本文件。

## 结论

- **P0：0；P1：0；P2：1**（`docs/MODULES.md:31` 仍留「纯逻辑仍在」旧注，已由 `:77` 订正注明确作废，非阻断）。
- **可以提交**：两文件删除已证实；活源码零引用、零 import、零调用；5 个负向守卫仍成立；无断言削弱；文档三处登记齐全；计数与门闸全部复现。

## 引用清扫（grep `quickRecord|QuickRecord|planQuickRecord`）

| 范围 | 命中 | 判定 |
| --- | --- | --- |
| `*.ets` | 0 | 无残留 |
| `*.ts` | 6，全部在 `entry/build/default/cache/...`（`quickRecord.ts` / `QuickRecordBar.ts`），`.gitignore:14` | gitignored 构建缓存，非活引用 |
| `*.mjs` | 6（`b3Batch:347`、`homeFilters:132,135`、`syncWiring:820`、`uiTokens:171`、`v2Only:84`） | 5 个负向守卫 + 1 注释；无 import / 无调用 |
| 其他文件类型 / `docs/*.md` | 68，均为历史评审 / 删除说明 / 基线注 | 非活动代码 |

`git status` 确认两文件 `deleted`；`git show HEAD:` 复核删前内容（模型 48 行、测试 193 行 / 16 例）。

## 守卫判定

- 5 个负向守卫均为 `assert.equal(..., false)` / `assert.doesNotMatch(...)`，断言 `Index.ets` 无 `QuickRecordBar` / `QuickRecordRow` / `quickBusy` / `submitQuickRecord` /「快速记一条」/「回车保存」；删除后仍成立，现兼作**复活守卫**。
- `structureGuards.test.mjs`（`componentFiles()` 扫 `pages/*.ets` + `components/**/*.ets` 与 `SECTION_FILES`）、`uiTokens.test.mjs`（读 7 个固定 `.ets`）的文件清单均无 `quickRecord*`，无测试断言被删文件存在。
- `homeFilters.test.mjs:133` 是上一模块从 `quickRecordUi.test.mjs` retarget 的守卫，覆盖已删入口、非本模块 retarget；其余 4 个本轮未改。**无覆盖削弱**。
- 边界：无测试直接钉死 `model/quickRecord.ts` 文件缺席；仅恢复该模型不会被测试捕获（仅文档可见），非阻断。

## 计数算术

- `git show HEAD:...quickRecord.test.mjs` 中 `^test(` = **16**，与 Δ−16 完全一致。
- 改前 2929/2928/0/1 → 本模块 2913/2912/0/1（−16，无其他用例丢失）→ 并行 grant +39 = 实测 **2952/2951/0/1**。

## 门闸复现（tail）

```
node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
ℹ tests 2952 / suites 349 / pass 2951 / fail 0 / cancelled 0 / skipped 1 / todo 0
node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
EXITCODE=0（无输出）
node apps/arkui-schedule/tools/validate-app.mjs
✅ 全部通过：8/8（JSON5/JSON 70、相对 import 422、main 静态 import 541、页面 8、rawfile/git 2）；EXITCODE=0
node tools/overlay.mjs status → [overlay] applied=false
```

## unverified

- 无设备（hdc/DevEco 不可用）：ArkTS 编译产物与真机行为未验。
- 改前 2929 来自模块登记与删前测试 16 例的算术复核，未在本树实跑删除前版本。
- gitignored 构建缓存残留（`tools/.build/model/quickRecord.js` 等）未清理；不影响门闸与结论。
