# 抖动台账

> 只记可证实的事实：一次性抖动、复跑结果、是否留存输出、是否改过超时；原因未证实前不写推断。

| 日期 | 通道 | 套件/命令 | 观察 | 复跑 | 失败用例名 | 超时改动 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-21 Wave B | app | `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` | **2721 tests / 1 fail**（一次） | 14 次全绿（均 2721/2721/0/0） | **未捕获**（当次输出未留存） | 无（唯一显式超时 `tools/test/deviceAccept.test.mjs:465` 保持 60000ms，未改） |
| 2026-11-21 plugin r4 | plugin | `node --test "packages/dsh-dots/test/*.test.mjs"` | **572/568/3 fail/1 skip**（一次） | 3 次全绿（572/571/0/1） | **未捕获** | 无 |
| 2026-11-23 batch 5 | app | `node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"` | **一次失败**：`exportJson.test.mjs`「确定性：同数据两次导出…逐字节相同」（fail 1 of 3980），留存 `.tmp/gates-planner-b9-batch5-final.out` | 两次全量复跑绿（**3980/3978/0/2**，`.tmp/gates-planner-b9-batch5-rerun1.out` / `.tmp/gates-planner-b9-batch5-rerun2.out`）；该文件单独 3/3 绿 | `exportJson.test.mjs`「确定性：同数据两次导出…逐字节相同」 | 无（**原因未证实，未改任何超时**；本批未触碰 app 树代码） |

## 处置

两次抖动形状相同（负载敏感、未捕获、不可复现）；处置 = 强制留存输出（§0 规则 10）+ 本台账；**未证实原因前不改超时**；若复现且有名称，再修用例或重试策略，并在本台账追加一行。
