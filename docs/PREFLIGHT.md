# 装机前 pre-flight（`tools/preflight.mjs`）

装机前的三条硬判据。存在的理由：2026-11-15 把「旧 HAP + 没还原的 overlay + 全绿源码测试」当成了验证通过；
设备不在线（`hdc list targets` = `[Empty]`）时也必须能自检，所以本脚本**不碰设备、不构建**。

```
node apps/arkui-schedule/tools/preflight.mjs
node apps/arkui-schedule/tools/preflight.mjs --hap <path> --manifest <path>
```

## 三条判据

| # | 判据 | 通过条件 | 失败条件 |
| --- | --- | --- | --- |
| 1 | overlay 已还原 | `overlay.mjs status` 输出 `[overlay] applied=false` | `applied=true`，或取不到状态（无法证明即不通过） |
| 2 | HAP 比源码新 | HAP 的 mtime **严格大于**源码最后提交时间 | HAP 更旧/相等，或仓库里找不到 HAP |
| 3 | SHA256 清单 | 清单逐条命中 | 任一条哈希不符 / 文件缺失 |

判据 2 的「源码最后提交时间」= `git log -1 --format=%cI -- apps/arkui-schedule/entry apps/arkui-schedule/AppScope packages/`。
**故意不含 `docs/` 与 `tools/`**：改文档/脚本不改变产物，算进去会天天误报过期。
「相等」也算旧：同一次提交前后生成的产物无法证明它包含该提交。

判据 3 的清单约定（优先兼容已有工具）：`dist-<时间戳>/SHA256SUMS.txt`，由 `tools/pack-dist.mjs` 生成，
格式 `<sha256>  <bytes>  <mtime ISO>  <path>`；同时兼容 `sha256sum` 的 `<sha256>  <path>`。
条目路径相对清单所在目录解析。**没有清单 → 打印 `unverified-sha` 并继续，不判 FAIL，绝不伪造清单或哈希。**

## 输出契约

每条判据一行，失败时随后给缩进提示（修复命令），末行是汇总：

```
[preflight] overlay=ok applied=false
[preflight] hap-fresh=ok hap=apps/arkui-schedule/entry/build/default/outputs/default/entry-default-unsigned.hap hapMtime=2026-11-18T12:20:37.174Z source=2026-11-18T12:22:07.000Z
[preflight] sha=unverified-sha（没有清单，继续）
[preflight] pass=2 fail=0 unverified=1 → exit 0
```

行格式（机器可读）：`[preflight] <check>=<status>` + `key=value` 词元；
`check ∈ {overlay, hap-fresh, sha}`，`status ∈ {ok, fail, unverified, error}`。
HAP 默认取仓库里 **mtime 最新的**那份（`entry/build/**`、`dist-harmony/`、`dist-*/`），`--hap` 可覆盖。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 无 FAIL（`unverified` 不判红） |
| 1 | 有 FAIL（overlay 未还原 / HAP 过期或缺失 / 哈希不符） |
| 2 | 参数或环境错误（git 不可用、该路径集无提交、`--hap`/`--manifest` 指向的文件不存在） |

## 纯逻辑导出（`import` 无副作用）

`compareHapFreshness(hapMtimeMs, sourceCommitMs)`、`verifyShaManifest(manifestText, readFile)`、
`gradeChecks(results)`、`checkOverlay(statusText, error)`、`checkHapFreshness(hap, commit, repoRoot)`、
`checkSha(manifest, readFile)`、`parseOverlayStatus(text)`、`parseShaManifest(text)`、
`findHaps(repoRoot)` / `newestHap(repoRoot)` / `findShaManifest(repoRoot)` / `loadShaManifest(repoRoot)`、
`runPreflight(options)`、`main(argv)`。

测试：`node --test apps/arkui-schedule/tools/test/preflight.test.mjs`（临时目录 + 假 mtime + 假清单，不依赖真机与真实产物）。
