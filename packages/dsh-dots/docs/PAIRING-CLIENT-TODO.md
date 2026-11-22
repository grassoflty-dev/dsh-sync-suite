# `mod-plugin-pairing` — 客户端接线清单（引擎已完成，客户端未接线）

> **状态（登记口径）：引擎完成 / 客户端未接线 / 面板待接线。二维码与自动配置尚不是用户可见功能。**
> 本文件随引擎模块一起提交，不是散落的 `.tmp/` 草稿。
> 接线在同一车道、`mod-plugin-lean-panel-r2-d1d2` 提交后**一次完成**。
>
> **所有行号锚点均按当前工作树 `packages/dsh-dots/src/client.js`（190586 B）给出。**
> 撰写时 lean 面板 d1/d2 已提交为 `cd78008`；本清单的行号已在该提交上复核
> （`DotsPanel:4569` / `LeanRemoteGroup:4326` / `loadLink:4342` / `persist:4400` / `doGenerate:4436`）。
> **re-anchor after lean-panel d1/d2 lands** —— 若其后又有客户端编辑落地，先重跑 grep 确认下列 symbol 的行号再改：
>
> ```
> grep -n "function \(DotsPanel\|LeanRemoteGroup\|LeanSyncGroup\|loadLink\|persist\|doCopy\|doGenerate\|leanStateView\|leanStatusText\)" packages/dsh-dots/src/client.js
> ```
>
> 这份清单是 checklist；每完成一项把它勾掉，并让 `test/pairing-hygiene.test.mjs` 的 H1–H3 继续保持绿灯。

## 0. 已交付的引擎出口（客户端只需要调用，不要重写）

| 需求 | 引擎入口 | 返回 |
| --- | --- | --- |
| 自动端口 / 令牌 / 证书（幂等） | `src/remote/pairingProvision.ts` → `createPairingProvisioner().provision()` | `PairingProvisionResult`（`state` 含 secret，**禁止**跨 RPC；`view` 脱敏） |
| RPC：面板打开 | action `pairingProvision` | `{view, changed, republish:{key,reason,previousPort,port}}\` |
| RPC：运输方式原因 | action `pairingTransports` | `{selected, selectedHost, overrideUnavailable, candidates, reasonLines}` |
| RPC：**显式**显示二维码 / 复制串 | action `pairingShow` | `{payload, text, qr}`（bearer secret，只有此处返回） |
| RPC：轮换 | `pairingRotateToken` / `pairingRotateCert` | 脱敏视图 + `changed` + 重发摘要 |
| RPC：令牌门同步 | `remoteAdoptToken({token})`（`RemoteService.adoptToken`） | `{ok}`，不回显 token |
| 载荷解析 / 核对（平板侧同 schema） | `src/remote/pairingPayload.ts` → `parsePairingPayload` / `serialisePairingPayload` / `formatPairingText` / `verifyPairingAgainst` / `describePairing` | typed `E_PAIRING_*` |
| 重新发布钩子 | `createPairingProvisioner({onRepublish})` → `PairingRepublishEvent {key, payload, text, reason}` | 公告模块消费；同 key、新 payload |

**纪律（不可协商）**：只有 `pairingShow` 的返回可以进入 QR 编码器 / 剪贴板。
`pairingProvision` 的返回里没有 token，`pairingShow` 的返回**永不**进入 state / DOM / 日志 / 错误消息。

---

## 1. 面板打开 → 自动配置（不要手输端口 / 令牌）

- [ ] **1.1** `LeanRemoteGroup`（`src/client.js:4326`）的挂载 effect（`:4356–4382`，当前先 `remoteGetState` 再 `loadLink`）改为：
      取 host 的权威 `mode`（d1 现有逻辑 `:4361–4372`，**保留**，仍只信 `remoteGetState().settings.mode`），
      然后调用 `pairingProvision`，把 `view` 存进 React state。
      **绝不**在挂载时调用 `pairingShow`（它是显式动作）。
- [ ] **1.2** 没有 host mode 时（d1 中性态 `:4376–4380`）：只渲染 `pairingTransports().reasonLines`，
      状态行保持 `tr('lean.remote.mode.unselected')`（`:4479–4480`），且**不**请求二维码。
- [ ] **1.3** 挂载完成后断言：`navigator.clipboard.writeText` 调用次数为 **0**
      （`test/pairing-hygiene.test.mjs` H1 已按当前面板钉住；接线后保持）。

## 2. 二维码 / 复制串 → 显式 `pairingShow`

- [ ] **2.1** 用 `pairingShow()` 替换 `loadLink(currentMode)`（`:4342–4354`）作为**唯一**二维码来源。
      返回 `{payload, text, qr}`：`qr` 交给 `QrMatrix`（`:4560`），`text`/`payload` 只进剪贴板。
- [ ] **2.2** `loadLink` 当前在三处被隐式调用：挂载 `:4378`、生成后 `:4448`、切方式 `:4507`、端口失焦 `:4526`、
      令牌失焦 `:4540`。接线后这些地方要么改成 `pairingShow`（用户动作的结果），
      要么只刷新 `pairingProvision` 的脱敏视图；**挂载路径不得再触发 secret 出口**。
- [ ] **2.3** `doCopy()`（`:4452–4470`）只写一个值：紧凑手输串 `shown.text`（若产品选规范 JSON 则写 `shown.payload`），
      复制仍只发生在显式按钮点击（`:4548`）。复制后 DOM 文本仍不得含 token（H2/H3）。
- [ ] **2.4** QR 渲染只读 `qr` 矩阵；严禁把 `payload` / `text` / `shown.url` 作为 `<text>` / `title` / `aria-label` / `value` 落到 DOM。
      `qrToSvg` 的 `aria-label` 已是固定的「QR code」，不要改成内容摘要。

## 3. 运输方式原因行（灰掉 + 解释）

- [ ] **3.1** `pairingTransports()` 的 `reasonLines` 渲染到 Select（`LeanRemoteGroup` 的方式 Field，`:4492–4511`）下方，
      顺序固定 Tailscale / 局域网 / IPv6，再接局域网说明行。文案来自
      `src/remote/pairingTransport.ts::TRANSPORT_REASON_COPY`（中文，含「同一 tailnet」「同一 Wi-Fi」「部分运营商屏蔽入站」）。
- [ ] **3.2** 用 `candidates[kind].available` 灰掉不可选项（只留 `tailscale`/`lan`/`ipv6`，与现有下拉 `:4498–4502` 一致）；
      `overrideUnavailable=true` 时在状态行追加一行说明"已回落到自动选择"。
- [ ] **3.3** 局域网说明必须逐字传达：**端口和令牌已随二维码带好、不用手输；令牌阻止同一网络里其他人控制这台 DSH。**
      这是用户明确提问「局域网也需要这些吗」的产品答复。

## 4. 端口 / 令牌只读展示，生成 = 显式轮换

- [ ] **4.1** 端口 Input（`:4513–4528`）改为只读展示 `view.port`（自动选出的具体端口），
      删掉用户手填端口的路径；端口变化由引擎记录并触发公告同 key 重发。
- [ ] **4.2** 令牌 Input（`:4530–4542`）保持 `type=password`，只显示 `token: present` 状态；
      绝不把 token 值写回 `value`（当前 `setToken('')` 已正确，保留）。用户手动输入配对串的入口（如要做）
      调用 `parsePairingPayload` + `verifyPairingAgainst` 得到 typed 错误，**错误只显示 reason**。
- [ ] **4.3** 「生成」按钮 `doGenerate()`（`:4436–4450`）改调 `pairingRotateToken`；成功后
      （a）经 `remoteAdoptToken` 同步内存令牌门（引擎 `onTokenChanged` 钩子已发出新 token），
      （b）再用 `pairingShow` 刷新二维码。轮换后旧配对串必须用 `verifyPairingAgainst` 失败。
- [ ] **4.4** 「自检」`doSelfCheck()`（`:4423–4434`）与「保存」路径不再需要写端口 / 令牌；
      若保留令牌失焦保存，只允许写用户粘贴的**同步令牌**，不写配对令牌。

## 5. 重发钩子与公告模块（本批只留接缝）

- [ ] **5.1** `pairingProvision` 返回的 `republish` 摘要（key / reason / port）可以进 UI 状态行，
      但该摘要里**没有** payload（引擎投影已剥离）；公告模块通过进程内
      `onRepublish` 回调拿完整 `PairingRepublishEvent`，同 key 重新签名发布。
- [ ] **5.2** 端口变化导致的重发必须表现为「同 key、新 payload」，不要新建另一个公告条目。

## 6. 接线后的验证

- [ ] **6.1** 定向 `node --test test/pairing-*.test.mjs test/client-*.test.mjs` 全绿；
      `test/pairing-hygiene.test.mjs` 的 H1（零剪贴板）/ H2（DOM 无 token）/ H3（显式复制）不得删或放宽。
- [ ] **6.2** 中文 UI copy 加到 `locale/zh.json` + `locale/en.json` + `src/client.js` 内置字典三处，逐字一致
      （参照 lean 面板车道既有的三处同步做法）。
- [ ] **6.3** 更新 `docs/MODULES.md`：把「客户端未接线 / 面板待接线」改为接线完成口径；
      GUI / 平板扫码 / 真机仍标 `unverified`，直到 Lead reload 后人工确认。
