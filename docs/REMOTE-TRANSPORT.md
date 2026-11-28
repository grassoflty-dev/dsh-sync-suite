# 远程控制的传输方式：决定与 IPv6 事实（2026-11-28 定稿）

> 这份文件回答一个会被反复问到的问题：**「能不能用 SSH over IPv6 做远程控制？」**
> 用户已裁定：**「SSH 没啥优势，还是保持我们现有的方案」**。本文把决定、依据与未验证项一次写清，
> 以免三周后有人重新讨论一遍。

## 1 决定

**远程控制使用插件自带的「配对 + 具体地址 HTTPS 监听」，信任锚是 TOFU 指纹；不引入 SSH。**

- 监听只用**明确的一个地址**（绝不 `0.0.0.0` / `::`）。
- 信任 = 配对载荷里的 `tlsFingerprint`（证书字节的 SHA-256 冒号指纹），**不是主机名校验**。
- **SSH 是刻意不采纳的**，理由有三条，任一成立即够：
  1. 树里**没有任何 SSH 客户端 / 服务端 / 隧道**实现；SSH 相关代码全部只是 **git 远端地址的 scheme 支持**（见 §4）。
  2. 平板（HarmonyOS）上没有可用的 SSH 客户端，端口转发这条路上没有可执行的端点。
  3. 反向隧道与 Tailscale 的功能重叠；而「配对 + 具体地址 HTTPS」在安全等级上与 SSH 隧道同级，却不新增一个常驻进程和一套密钥管理。

**代价**：我们失去「一条命令把内网端口打出去」的便利。**收益**：少一个要装的二进制、少一套 known_hosts 与主机密钥轮换、
少一条在平板侧根本不存在的依赖链。

## 2 IPv6：能力已经在了，缺的不是代码

`ipv6` 并不是一个待实现的功能，它是**已经实现的一种接入方式**，只是从未在真机上端到端跑过。

| 事实 | 证据 |
| --- | --- |
| 监听只 bind 一个具体字面量地址 | `packages/dsh-dots/src/remote/listener.ts:1977` `server.listen(listenPort, address)` |
| 通配地址与不可绑地址被拒（v4：`0.0.0.0/8`、`127/8`、`169.254/16`、组播/保留/广播） | `listener.ts:351-359`，入口 `isBindableAddress` 见 `listener.ts:395` |
| v6 可绑范围：只放行 `2000::/3` 全局单播与 `fc00::/7` ULA；`::`、`::1`、IPv4-mapped、`fe80::/10`、组播一律拒 | `listener.ts:374-391`（白名单在 `:389-390`） |
| 绑定地址按模式分派 | `packages/dsh-dots/src/remote/service.ts:1232` `resolveBindAddress(settings.mode, settings, routeAddress)` |
| `ipv6` 是一种正式接入方式（含 `bindKind:'ipv6'`、`hostsListener:true`、`ipv6Address` 字段） | `packages/dsh-dots/src/remote/accessMode.ts:165-195` |
| 该方式的三条前提（公网 v6 / 路由器放行入站 / 平板网络也有 v6） | `accessMode.ts:171-175` |
| 广播/配对主机在 v6 时**带方括号**输出 | `packages/dsh-dots/src/remote/pairingTransport.ts:158-160` |
| 平板侧做 RFC 5952 归一（`[…]` 或裸写 → `[小写压缩]`），并拒绝给要求 IPv4 的传输方式填 v6 | `apps/arkui-schedule/entry/src/main/ets/model/pairingPayload.ts:276-285` |

## 3 为什么 IPv6 不需要动证书（这一点最容易误判）

我们的证书是**手写的最小 DER/X.509 v1 编码器**（`packages/dsh-dots/src/remote/pairingTls.ts:2-11`，
运行时只用 `node:crypto`、零 npm 依赖）。**v1 没有扩展字段，因此全仓没有、也不会有 `subjectAltName`。**

信任不是从主机名来的，而是从**指纹**来的：

- 配对载荷里带 `tlsFingerprint`（`packages/dsh-dots/src/remote/pairingPayload.ts:26`，形态校验 `:99`）；
- 指纹 = 证书字节的 SHA-256 冒号形态（`pairingTls.ts:6` 的纪律说明），配对时以 TOFU 钉住；
- 轮换 = 新密钥 + 新证书 + 新指纹，旧载荷立即被 `verifyPairingAgainst` 拒。

**用户可见的结论**：把访问地址从 IPv4 字面量换成 IPv6 字面量，**不会破坏信任**——
因为从来没有任何一步做过主机名校验。这也正是 `ipv6` 方式不需要任何证书工作的原因。

## 4 SSH 在树里到底是什么

只有「git 远端地址允许 `ssh://` 或 `git@host:path`」，没有别的：

- `packages/dsh-dots/src/engine/git.ts:26,360` `authMode: 'https' | 'ssh'`
- `git.ts:413` `SSH_ASKPASS_REQUIRE='never'`（为了不弹交互口令）
- `git.ts:611-651` 远端地址校验（`ssh://` 与 scp 风格放行，带内嵌凭据的拒绝）
- `packages/dsh-dots/src/engine/settings.ts:21` `AUTH_MODES = ['https','ssh']`

全仓对 `ssh2` / `sshd` / `known_hosts` / 隧道实现的检索为 **0 命中**。

## 5 诚实的状态行（别读成「已上线」）

- `ipv6` 方式**已实现，但从未在真机上端到端跑过**——没有人真的用 `https://[2409:…]:44996/` 从平板连过一次。
- **当前实况仍是 `lan`**：`~/.dsh/dots/remote.json` 里 `mode:"lan"`、`port:44996`、
  `lanAddress:"192.168.137.1"`（旧值）；实测监听是 **`192.168.1.5:44996` LISTENING**（PID 54528），
  并有一条来自 `192.168.1.11` 的 ESTABLISHED 连接（即平板此刻是连着的）。
- 该用户的公网 v6 地址**已经填在配置里**（`ipv6Address:"2409:8a20:…"`），所以切到 `ipv6` 是
  「改模式 + 路由器放行入站」的运维动作，**不需要新开发**。
- 剩下的是**运维 + 我们自己的验证**：运营商给公网 v6、光猫/路由器放行该端口、平板所在网络有 v6。

## 6 将来若要重新考虑 SSH，先回答这三个问题

1. 平板上跑什么 SSH 客户端？没有它，「端口转发」这条路没有可执行端点。
2. 它能提供什么现有 HTTPS 端点没有的东西？安全性上不给更多（我们有指纹钉），只多运维面。
3. 谁来轮换主机密钥、谁维护 known_hosts？如果答案是「没人」，那就不该引入。
