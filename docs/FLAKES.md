# 抖动台账

> 只记可证实的事实：一次性抖动、复跑结果、是否留存输出、是否改过超时；原因未证实前不写推断。

| 日期 | 通道 | 套件/命令 | 观察 | 复跑 | 失败用例名 | 超时改动 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-21 Wave B | app | `node --test "apps/arkui-schedule/tools/test/*.test.mjs"` | **2721 tests / 1 fail**（一次） | 14 次全绿（均 2721/2721/0/0） | **未捕获**（当次输出未留存） | 无（唯一显式超时 `tools/test/deviceAccept.test.mjs:465` 保持 60000ms，未改） |
| 2026-11-21 plugin r4 | plugin | `node --test "packages/dsh-dots/test/*.test.mjs"` | **572/568/3 fail/1 skip**（一次） | 3 次全绿（572/571/0/1） | **未捕获** | 无 |
| 2026-11-23 batch 5 | app | `node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"` | **一次失败**：`exportJson.test.mjs`「确定性：同数据两次导出…逐字节相同」（fail 1 of 3980），留存 `.tmp/gates-planner-b9-batch5-final.out` | 两次全量复跑绿（**3980/3978/0/2**，`.tmp/gates-planner-b9-batch5-rerun1.out` / `.tmp/gates-planner-b9-batch5-rerun2.out`）；该文件单独 3/3 绿 | `exportJson.test.mjs`「确定性：同数据两次导出…逐字节相同」 | 无（**原因未证实，未改任何超时**；本批未触碰 app 树代码） |
| 2026-11-24 b11b 加修轮 | plugin | `node --test test/*.test.mjs`（cwd `packages/dsh-dots`） | **一次失败**：`remote-service.test.mjs` T「start：uu（可用但不需要本机监听）→ E_NO_BIND_ADDRESS」实际拿到 `E_NO_UPSTREAM_IDENTITY`（`test/remote-service.test.mjs:113` 一带）；该次输出**被随后的重试覆盖、未留存**，用例名来自该轮执行者转述 | 该文件单独 **23/23 绿**；本批共 5 次全量，1 次抖动、最后 2 次绿（**969/967/0/2**，`.tmp/gates-p1b-plugin1.out`、`.tmp/gates-p1b-plugin2.out`、`.tmp/gates-designer-freeze-plugin.out`） | `remote-service.test.mjs`「uu（可用但不需要本机监听）」 | 无（**原因未证实**；怀疑与 3 s 上游身份换取预算 `service.ts` 在负载下超时有关，未改任何超时。本批 `src/remote/service.ts` **未改**，属既有代码） |

## 处置

两次抖动形状相同（负载敏感、未捕获、不可复现）；处置 = 强制留存输出（§0 规则 10）+ 本台账；**未证实原因前不改超时**；若复现且有名称，再修用例或重试策略，并在本台账追加一行。
