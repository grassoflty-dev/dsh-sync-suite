# 直连 DSH + 签名公告（REMOTE-DISCOVERY）提纲

> 状态：**设计提纲，2026-11-21；整体替换前版，保持直连 DSH 优先；不实现、不改代码。**
> 用户理由：平板若能连到一台主机，就能直连该主机的 DSH ⇒ 不设网关层；不可达由用户自行修网络（Tailscale / IPv6 / 端口映射），**不造中继**（产品边界，不是待补功能）。
> 更正需求：「IPV6 连接需要什么，为了防止 IP 波动，我还是需要把新的 IP 需要认证的内容上传到 git」⇒ 公告**签名**并携带认证材料，而非只写地址。
> 现状锚点：实例 = `inst-<16hex>`+name/url(无token)/mode/reachable/token、单键信封 `{v:1,items}`（`apps/arkui-schedule/entry/src/main/ets/model/instances.ts:26-38,85-103,568-595`；`services/instanceStore.ets:35-65`），id 由归一 URL sha16 派生（`apps/arkui-schedule/entry/src/main/ets/model/instances.ts:310-321`）、可达三态 `unknown` 永不升 `ok`（`apps/arkui-schedule/entry/src/main/ets/model/instances.ts:49-50,331-340`）；`REMOTE_MODE_HINTS`（`apps/arkui-schedule/entry/src/main/ets/model/remoteAccess.ts:321-328`）、mode 枚举（`packages/dsh-dots/src/remote/types.ts:21`）、`remote*` 键（`docs/PERSISTENCE.md:16`）。
- **多 DSH = N 条直连实例**：每条自带地址、凭据、grant、可达性；**列表本身就是聚合**，无上层汇总对象。
## 1 IPv6 直连到底要什么
- 主机需 **global IPv6**（非 link-local）；防火墙放行入站 TCP；DSH 监听 `[::]`（或其全球地址）的选定端口；TLS 用真证书或**自签证书且 App 钉住指纹**；平板侧 IPv6 可用（Wi-Fi/移动网络）。**CGNAT / 仅 IPv4 网络就是连不上**——网络事实，非 bug。
- 既有 `REMOTE_MODE_HINTS.ipv6` 已写明「公网 IPv6 + 防火墙放行 + `[地址]:端口` + 平板支持 IPv6」（`apps/arkui-schedule/entry/src/main/ets/model/remoteAccess.ts:321-328`）——本方案只补签名公告，不改这条前提。
## 2 公告文件与签名
- `remote/<instanceId>.json` = `{ instanceId, scheme, host, port, transportKind, publicKeyFingerprint, tlsFingerprint, tokenId, updatedAt, nonce, signature }`；host 在地址变更时发布；写侧仿 `chats/` 守 v2 门禁（`docs/PLUGIN-GAPS.md:33-39`）。
- host 用 **Ed25519** 签名，App 对**钉住的公钥**验签；首次配对 TOFU，之后**仅显式用户操作**可换公钥。理由：**谁能写仓库就能把 App 指向自己控制的主机——未签名公告按设计就是重定向攻击**。
- 文件里**绝不**写 repo token / DSH access token / 任何私钥；只有 `tokenId` 与指纹（token 卫生先例：`apps/arkui-schedule/entry/src/main/ets/model/instances.ts:13-15,105-116,416-443`）。
- 仓库必须**私有**；若公开，模块**拒绝发布**并给 typed 错误（`apps/arkui-schedule/entry/src/main/ets/model/instances.ts:52-65,220-248` 的 typed reason 口径）——公告 + 指纹仍是定向辅助。
- 时钟：`updatedAt` 超过**未来 5 分钟**或**过去 30 天**即拒并给 typed reason——否则敌意仓库可钉一个方便的时间。
- 验收规则：仅当**验签通过 + `updatedAt` 更新 + 指纹匹配钉住值**才自动刷新地址；否则显示「公告不可信，请手动确认」并保旧址；两实例同 `instanceId` ⇒ **拒绝，不合并**（`unknown` 永不升 `ok`，`apps/arkui-schedule/entry/src/main/ets/model/instances.ts:49-50,331-340`）。
## 3 取舍与分期
- 更简单的替代：**DDNS AAAA 记录**——host 更新 AAAA，App 只用主机名；无需仓库写，但要域名 + DDNS 客户端。仓库路线优势是**无需拥有域名**；二者并存，选哪个 `待定`。
- 分期：①schema + 读侧 + 验签 ②启动/地址变更发布 ③App 自动刷新 + 钉住执行 ④真机检查；同步仓库读写须独立评审、1000006 后做设备检查（`docs/PERSISTENCE.md:5`、`docs/REMOTE-INSTANCES.md:141-153`），**plugin r4 提交前不启动**。
- tailcat 仅 host↔host（一台 DSH 控制另一台），平板侧维持 `E_TRANSPORT_UNSUPPORTED`，不静默降级；平板侧路径已关闭，见 `docs/TAILCAT-HARMONYOS-SPIKE.md:3,31,42-44`。
- 插件侧仍按 instanceId 走 allow-list 解析出网目标、拒收调用方 URL（`packages/dsh-dots/src/remote/instances.ts:1-6,204-208`），只读投影白名单不变（`packages/dsh-dots/src/remote/projection.ts:14-15,161-172`）。
## 开放问题（用户拍板前不实现）
- **Q1 待定**：Ed25519 密钥对来源——host 生成 / 每实例一把 / 如何轮换？
- **Q2 待定**：`tokenId` 如何映射到 host 上的 DSH access token？
- **Q3 待定**：`nonce` 是否为防重放必需，还是 `updatedAt` 单独足够？
- **Q4 待定**：App 是否在本地缓存最近一次已验公告（离线启动仍有地址）？
