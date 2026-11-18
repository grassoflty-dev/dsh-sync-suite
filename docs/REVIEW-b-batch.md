# REVIEW b-batch（2026-11-18，独立只读评审）

> 评审角色：独立只读评审子代理（非作者）。cwd = `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`。
> 评审范围严格限定为派活清单里的 8 个文件；`docs/*` 的并行改动不在评审范围。

## 0 结论

- **是否阻塞提交：否**
- **P0 0 条 / P1 1 条 / P2 2 条**
- **评审后状态（规划者补记，见 §7）**：P1-1 已修（B8 断言落地）、P2-1 已修（无令牌时逐字等价）、
  P2-3（Lead 复审追加）已修（空 merged 守卫）、P2-2 接受为已知限制（未改）。
  当前全量 **2179 例 / 2178 pass / 0 fail / 1 skip**、`validate-app` 8/8。

核心结论：D1-b 一键重连、stripRemoteToken、settingsStore 新键六处成对、D2 chat 只读跳转出口，
**实现语义全部符合契约**，回归全绿（2175/2176 通过，唯一 skipped 是既有的环境相关用例）。
唯一 P1 是**测试缺口**：`bBatch.test.mjs` 的 B6 只钉了 `openRemote(overrideUrl)` 的函数签名，
没有钉住「override 分支必须跳过 `buildRemoteAccessUrl` 与第二次 mode 字段落盘」这条 B.4 最核心的语义；
实现目前是对的，但下一次重构可以悄悄改坏而测试不红。两条 P2 是边界行为（空 query 对、裸 `?k` 与令牌现拼的组合）。

---

## 1 评审范围与命令（证据三段式：命令原文 / 原样输出 / 结论）

### 1.1 范围核对

**命令原文**
```
git status --short
```

**原样输出**
```
 M apps/arkui-schedule/entry/src/main/ets/components/settings/RemoteSection.ets
 M apps/arkui-schedule/entry/src/main/ets/model/remoteUrl.ts
 M apps/arkui-schedule/entry/src/main/ets/pages/ChatDetail.ets
 M apps/arkui-schedule/entry/src/main/ets/pages/RemoteControl.ets
 M apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets
 M apps/arkui-schedule/entry/src/main/ets/services/settingsStore.ets
 M apps/arkui-schedule/tools/test/remoteUrl.test.mjs
?? apps/arkui-schedule/tools/test/bBatch.test.mjs
```

**结论**：与派活清单的 8 个文件逐字一致，无多余改动进评审范围。

### 1.2 既有断言是否被放宽/删除

**命令原文**
```
git --no-pager diff -- apps/arkui-schedule/tools/test/remoteUrl.test.mjs
git --no-pager diff --numstat -- apps/arkui-schedule/tools/test/remoteUrl.test.mjs
```

**原样输出（numstat）**
```
61	1	apps/arkui-schedule/tools/test/remoteUrl.test.mjs
```

diff 原文里那 1 行删除是 import 行的**追加式改写**：
```
-  sanitizeUrlForDisplay
+  sanitizeUrlForDisplay,
+  stripRemoteToken
```
其后是文末新增的 `describe('stripRemoteToken：…')` 整段（9 个 test）。

**结论**：没有任何既有断言被删除或放宽；`remoteUrl.test.mjs` 实质只有新增。

### 1.3 既有 OPEN_REMOTE 五条正则是否仍语义一致（任务点名要跑）

**命令原文**
```
node --test apps/arkui-schedule/tools/test/remoteSettings.test.mjs
```

**原样输出（尾部）**
```
  ✔ 点击路径：先 normalizeRemoteUrl → 再保存 → 最后 routeToRemote 跳转（顺序不可颠倒） (0.1751ms)
...
ℹ tests 18
ℹ suites 4
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 90.8271
EXIT=0
```

五条断言位于 `tools/test/remoteSettings.test.mjs:124-128`（归一 / 早退 / 红字 / 先 save / 后 pushUrl），
全部通过；`openRemote` 改造后 `await settingsStore.save({ remoteUrl: check.url });`（`Settings.ets:2030`）
与 `router.pushUrl({ url: routeToRemote(), params: { url: check.url } });`（`Settings.ets:2067`）逐字仍在。

**结论**：语义一致，未放宽。

### 1.4 回归面（任务点名要跑）

**命令原文**
```
node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
node apps/arkui-schedule/tools/validate-app.mjs
```

**原样输出（测试尾部）**
```
﹣ fetch 直连时：真实 fetch 断言状态码/正文/x-forwarded-for (0.17ms) # 本机 NODE_USE_ENV_PROXY+HTTP_PROXY 生效且 NO_PROXY 不含局域网地址，fetch 被系统代理接管
ℹ tests 2176
ℹ suites 295
ℹ pass 2175
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 26631.6939
```

**原样输出（validate-app 8/8）**
```
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 347 条、main 静态 import 436 条、页面 7 个、rawfile/git 2 个文件）
EXIT=0
```

**结论**：回归全绿。唯一 skipped 是既有的、与本批无关的代理环境变量用例。

### 1.5 新增测试自身输出（佐证）

**命令原文**
```
node --test apps/arkui-schedule/tools/test/bBatch.test.mjs
node --test apps/arkui-schedule/tools/test/remoteUrl.test.mjs
```

**原样输出（尾部）**
```
bBatch:      ℹ tests 22 / ℹ suites 5 / ℹ pass 22 / ℹ fail 0 / ℹ skipped 0 / ℹ todo 0 / ℹ duration_ms 88.1762 / EXIT=0
remoteUrl:   ℹ tests 73 / ℹ suites 14 / ℹ pass 73 / ℹ fail 0 / ℹ skipped 0 / ℹ todo 0 / ℹ duration_ms 105.8357 / EXIT=0
```

**结论**：新增测试自身 95/95 通过（其中 `stripRemoteToken` 9 条、bBatch 22 条）。

---

## 2 P0（必须改，否则不可提交）

**未发现。**

逐条核对结果：
- `recordLastOk` 先 `stripRemoteToken(this.url)` 再 `encodeLastOk(entry)`（`RemoteControl.ets:183,188`）——记录无 secret；
- `loadError` 非空早退（`RemoteControl.ets:180`）——失败不覆盖旧记录；
- `onPageShow` 只调 `refreshRemoteLastOk()`（`Settings.ets:464-477`），全文无第二处 `onPageShow`，未调 `applySettings`；
- override 分支确实跳过 `buildRemoteAccessUrl` 与第二次 mode 落盘（`Settings.ets:2031,2032-2054`），
  `remoteManualUrl` 只在 `override.length === 0` 分支里被写（`Settings.ets:2033-2036`）；
- settingsStore 六处成对（`settingsStore.ets:175,232,282,433,479,670,711,770`），整表保存走
  `patch.remoteLastOk === undefined ? current.remoteLastOk : …`（`:670`）并回写（`:711`），不会抹掉记录。

---

## 3 P1（应改，可与提交同批或紧随）

### P1-1 测试没钉住「重连不重新推导方式字段」这条 B.4 核心语义

- **位置**：`apps/arkui-schedule/tools/test/bBatch.test.mjs:194-200`（B6）；对应实现 `apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets:2003-2054`。
- **现象**：B6 只断言了函数签名，没有断言 override 分支的**排他性**。当前实现正确，但把
  `buildRemoteAccessUrl(config)` 移出 `if (override.length === 0)`、或把第二次 `settingsStore.save({remoteMode: …})`
  改成无条件执行，B6 / B7 / 既有 `remoteSettings.test.mjs` 五条正则**全都不会红**——契约靠人眼守着。
- **证据（原样代码行）**：

  `bBatch.test.mjs:194-200`：
  ```js
    test('B6 openRemote 带可选 overrideUrl 参数（重连时传入现拼的地址）', () => {
      assert.match(
        PAGE,
        /private async openRemote\(overrideUrl: string = ''\): Promise<void>/,
        '契约丢了：openRemote 缺可选参数 overrideUrl: string = \'\''
      );
    });
  ```

  `Settings.ets:2031-2036,2042-2051`（真正需要被钉住的事实）：
  ```ts
        if (override.length === 0) {
          // 重连不重新推导方式字段：下面这段只在普通打开时执行
          if (this.remoteMode === REMOTE_MODE_MANUAL) {
            this.remoteManualUrl = check.url;
          }
          ...
          await settingsStore.save({
            remoteMode: this.remoteMode,
            ...
          });
  ```
- **建议**：给 `openRemote` 方法体加一条静态断言，至少覆盖三点：
  ① `buildRemoteAccessUrl(` 出现在 `if (override.length === 0)` 之后（即被包含在分支内）；
  ② `remoteMode:` / `remoteManualUrl:` 的第二次 save 同样位于该分支内；
  ③ override 分支里没有对 `this.remoteManualUrl` 赋值。
  复用文件里已有的 `methodBody(PAGE, 'private async openRemote(')` 即可，无需运行时。

---

## 4 P2（可选/风格/后续）

### P2-1 `stripRemoteToken` 会顺手吃掉空 query 对，`?a=1&&b=2` 形态被改写

- **位置**：`apps/arkui-schedule/entry/src/main/ets/model/remoteUrl.ts:566-568,577-580`。
- **现象**：`for (const pair of …split('&'))` 里 `if (pair.length === 0) continue;`，
  所以入参 `http://h:3080/?a=1&&b=2` 会返回 `http://h:3080/?a=1&b=2`。
  与 `sanitizeUrlForDisplay`（`:739-741` 无令牌时**原样返回 text**）的口径略有偏差：
  新函数文档写的是「没有令牌参数时原样返回（结果与入参等价）」，空 `&&` 的普通地址不等价。
- **证据（原样代码行）**：
  ```ts
    for (const pair of beforeHash.slice(question + 1).split('&')) {
      if (pair.length === 0) {
        continue;
      }
  ```
- **建议**：若在意「纯清理不重写」，可先把原 pairs 留着、只在最后拼接时过滤；或把文档改成
  「丢弃空 query 对」。对重连功能无实际影响（空对不含 secret，归一后仍可打开），故列 P2。

### P2-2 裸 `?k` 记录与「现拼令牌」组合会生成两个令牌键，可能被服务端判歧义

- **位置**：`remoteUrl.ts:571-575`（裸键保留，任务明确要求）与 `remoteUrl.ts:522,534-536`（`mergeRemoteToken` 只替换带 `=` 的键，否则追加 `token=`）。
- **现象**：记录里若留着裸 `?k`（`stripRemoteToken` 按要求不删），重连时
  `mergeRemoteToken('http://h:3080/?k', 'secret')` 得到 `http://h:3080/?k&token=secret`；
  服务端令牌门按「同时出现两个令牌键视为歧义拒绝」（`remoteUrl.ts:159-161` 的同源说明、
  `tools/test` 里 auth 侧 `?token=` 与 `?k=` 同时出现 → 401 的用例），这条重连会失败。
- **证据（原样代码行）**：
  ```ts
      const key: string = (equal >= 0 ? pair.slice(0, equal) : pair).toLowerCase();
      if (equal >= 0 && TOKEN_KEYS.indexOf(key) >= 0) {
        continue;
      }
  ```
  ```ts
    if (!replaced) {
      kept.push(`token=${encoded}`);
    }
  ```
- **建议**：若要把这个边角收紧，可在 `mergeRemoteToken` 里把「裸 `token`/`k` 键」也视为待替换位
  （就地改成 `key=<encoded>`，而不是追加）；但触发前置是用户手工输入了无值的 `?k` 且该地址仍能成功加载，
  概率极低，故 P2。当前测试 `stripRemoteToken` 明确保留裸 `?k`（`remoteUrl.test.mjs` 新增段），
  **不要为了这条去改 strip 的语义**。

---

## 5 已核实无问题的点（防后续误改）

1. **按钮出现条件**：`reconnectText()` = `reconnectLabel(decodeLastOk(this.remoteLastOk), Date.now())`
   （`Settings.ets:1974`）；解码失败 → `decodeLastOk` 返回 null（`remoteUrl.ts:615-640`）→ 文案空串；
   地址不合法 → `reconnectLabel` 内 `normalizeRemoteUrl` 失败 → 空串（`remoteUrl.ts:684-687`）；
   `RemoteSection.ets:357` 用 `if (this.reconnectText.length > 0)` 才渲染按钮。✓
2. **文案不含令牌**：`reconnectLabel` 只取 `authorityOf`（`remoteUrl.ts:656-669,688-698`），
   在 `?` / `#` / `/` 处截断；测试逐字断言「不含令牌值」且 IPv6 方括号保留。✓
3. **重连不改方式/令牌字段**：override 分支只写 `remoteUrl`，`remoteMode`/`remoteLanAddress`/
   `remotePort`/`remoteManualUrl`/`remoteToken` 的第二次 save 全部在 `override.length === 0` 内
   （`Settings.ets:2031-2054`）；`config.port` → `this.remotePortValue()` 的改写等价
   （`remoteAccessConfig()` 在 `Settings.ets:1905` 本来就赋同一个值）。✓
4. **记录不含 secret / 失败不覆盖**：`RemoteControl.ets:180-190`；`stripRemoteToken` 与
   `sanitizeUrlForDisplay`（`remoteUrl.ts:712-743`）、`queryHasToken`（`:163-179`）、`TOKEN_KEYS`（`:319`）
   同口径：`token`/`k` 大小写不敏感、带值才删、其它参数与 fragment 原样、删空 query 去 `?`。✓
5. **onPageShow 不整表 reload**：`Settings.ets:464-477` 全文只有一处 `onPageShow`，仅调
   `refreshRemoteLastOk()`；`bBatch` B4 也钉了 `doesNotMatch(/applySettings/)`。✓
6. **settingsStore 六处成对**：`ScheduleSettings`(`:175`)/`SettingsPatch`(`:232`)/`KEY_REMOTE_LAST_OK`(`:282`)/
   `load`(`:433,479`)/`save`(`:670,711`)/`saveSyncState`(`:770`)；整表「保存设置」的 patch
   （`Settings.ets:780-819`）**不含** `remoteLastOk`，因此走 `:670` 的沿用分支，不会抹掉记录；
   `saveSyncState` 只 put 同步状态三项，不动 `KEY_REMOTE_LAST_OK`。✓
7. **D2 只读纪律**：`ChatDetail.ets` 无 `TextInput` / `TextArea` / 发送按钮；新增出口是
   `ActionButton`+`router.pushUrl`（`:142-171,385-416`）；地址不可用时 `enabled:false` 且给
   `disabledReason`（`:396-397`）；跳转带的是 `normalizeRemoteUrl` 后的 `this.remoteUrl`（`:142-155,293` 处
   `remoteUrl = check.ok ? check.url : ''`），`RemoteControl.paramUrl()/resolveAddress()` 参数优先读取
   （`:103-128`），归一地址确实被用上。bBatch E3 的反向断言先剥掉以 `//`、`*`、`/**` 开头的注释行
   （`bBatch.test.mjs:28-30`），文件里「发送」只出现在这些注释行（`:8,10`），可执行代码里无该词，
   **剥注释没有把真入口放过去**（真入口必然在非注释行，仍会被抓到）。✓
8. **既有测试未被迁就**：`remoteSettings.test.mjs` 18/18（含 OPEN_REMOTE 五条正则）、`remoteUrl.test.mjs`
   73/73（含新增 strip 9 条）、`bBatch.test.mjs` 22/22 全绿；validate-app 8/8。✓

---

## 6 未覆盖/需真机验证（unverified）

以下均为**真机行为**，本评审未做、也不得写成「已验证」：

1. `onPageEnd` 与主文档 `onErrorReceive` / `onHttpErrorReceive` 的**回调先后顺序**：作者假设错误回调先置 `loadError`，
   于是 `recordLastOk` 早退；若 ArkWeb 在某些 WebView 版本上先抛 `onPageEnd` 再抛 HTTP 错误，
   401/404 页也可能被记成「最近一次成功」。需在真机上用错误 token / 错误端口复现观察。
2. `onPageEnd` 是否会**被子 frame 触发**（回调里忽略了 event.url，只记 `this.url`）：若 iframe 先完成且
   主文档尚未失败，可能提前落记录。真机带嵌套页确认。
3. 设置页「一键重连」按钮在**紧凑屏 / 大字号 ×1.5** 下是否真的一屏可见（`RemoteSection` 里位于主按钮之上）；
   静态代码只能确认其排列顺序与条件渲染，不能确认视口内可见。
4. D2 出口在 **Loading / Empty / Error** 三态下的可视位置：代码上它位于四选一内容区之外
   （`ChatDetail.ets:441-442`），`MessageList` 有 `.layoutWeight(1)`（`:310`），但真实高度/滚动手感需真机确认。
5. 「Web 首屏是否成功才算成功」：本批以 `onPageEnd` 作为**最接近**成功的信号，这是工程近似；
   是否等于产品语义（例如需要首屏某个元素出现）未经真机/产品确认。
6. 上述 P2-2 的**服务端判定**：两个令牌键（裸 `?k` + `?token=`）是否确实被当前 DSH 版本判歧义，
   本评审只依据仓内代码的同源说明与既有测试，未做真机联调。

---

## 7 处理记录（规划者 planner-b 补记，2026-11-18 23:10；**不是评审原文**）

| 编号 | 处理 | 证据 |
| --- | --- | --- |
| P0 | 无 | — |
| P1-1 | **已修**：`tools/test/bBatch.test.mjs:209` 新增 B8。断言「`override` 守卫恰好两处」「`buildRemoteAccessUrl` 在第一处守卫内」「第一次 `save({ remoteUrl })` 之后才出现第二处守卫」「`remoteManualUrl` 同步在第二处守卫内」（全部按下标关系 + 5 条 `>= 0` 兜底，失败信息带「§B.4 语义丢了」）。 | `node --test "…/remoteUrl.test.mjs" "…/bBatch.test.mjs"` → `tests 97 / pass 97 / fail 0`（bBatch 22→23） |
| P2-1 | **已修**：`model/remoteUrl.ts` 的 `stripRemoteToken` 增加 `stripped` 标志——**没有删掉任何令牌参数时逐字返回原串**（`?a=1&&b=2` 不再被顺手规范化）；只有真删令牌时才收掉空参数对。同步在 `tools/test/remoteUrl.test.mjs:587` 加对应用例。 | 同上 → `remoteUrl.test.mjs` 73→74 例；全量 2179/2178/0 fail/1 skip |
| P2-3 | **已修（Lead 复审追加，2026-11-18 23:15）**：`pages/Settings.ets:1983` 的 `reconnectLastOk()` 先把合并结果存 `merged`（`:1992`），`merged.length === 0` 时给「重连失败：最近一次成功的地址已失效，请重新填写地址」并 `return`（`:1993-1996`）——不再把空串交给 `openRemote`（空串会退化成「按当前方式字段重新拼」，红字也会变成误导性的「请先填写电脑上的 DSH 地址」）。`tools/test/bBatch.test.mjs:251` 新增 B9 按下标关系钉死「算 merged → 空串早退 → `openRemote(merged)` 在守卫之后」，并禁止内联 `openRemote(mergeRemoteToken(...))`。 | `bBatch` 23→24 例全过；全量 **2179/2178/0 fail/1 skip**；`validate-app` 8/8 |
| P2-2 | **接受为已知限制（本批不改）**：裸 `?k` 记录（无值）与重连现拼 `token=` 会并存两个令牌键。修它要动 `mergeRemoteToken` 的「保留原键名、只替换一个」契约，超出 B 批范围；触发前置极罕见（用户手写无值 `?k` 之后又点重连）。**列入后续**，真机联调时一并确认服务端是否判歧义。 | 见 §4 P2-2 原文 |

**修复后的复核方式（任何人可重跑）**：

```powershell
cd C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite
node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
node apps/arkui-schedule/tools/validate-app.mjs
```

规划者实跑结果（P2-3 修复后）：`tests 2179 / pass 2178 / fail 0 / skipped 1`、`✅ 全部通过：8/8 条规则`。

