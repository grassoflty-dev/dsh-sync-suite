# 跨设备发指令拒绝文案唯一对照表

> 本表是「跨设备发指令」的**拒绝文案唯一对照表**：逐字文案的唯一事实源在代码里——平板侧 `COMMAND_WORDING`（`apps\arkui-schedule\entry\src\main\ets\model\remoteCommandGate.ts`），插件侧 `LEASE_WORDING` / `PROMPT_WORDING`（`packages\dsh-dots\src\remote\...`）。
> 本文件只是两侧代码之间的 **join**，**绝不允许成为第三份拷贝**。
> 纪律：任何一侧改文案而没有改本表（或反之）都必须让门禁失败。

| 语义键 | 平板码 | 平板常量 | 插件码 | 插件常量 | 逐字中文 | 产生位置 |
| --- | --- | --- | --- | --- | --- | --- |
| prompt.target.missing | E_COMMAND_TARGET_MISSING | COMMAND_WORDING | — | — | 请先选择一个已配对的实例 | `remoteCommandGate.ts` |
| prompt.tool.notAllowed | E_COMMAND_TOOL_NOT_ALLOWED | COMMAND_WORDING | — | — | 该工具不是允许的指令工具（只允许 session.prompt） | `remoteCommandGate.ts` |
| prompt.text.empty | E_COMMAND_TEXT_EMPTY | COMMAND_WORDING | E_VALIDATION | PROMPT_WORDING | 请先输入要发送的指令 | 两侧 |
| prompt.text.tooLong | E_COMMAND_TEXT_TOO_LONG | COMMAND_WORDING | E_VALIDATION | PROMPT_WORDING | 指令过长（上限 2000 字） | 两侧 |
| prompt.grant.denied | E_COMMAND_NOT_GRANTED | COMMAND_WORDING | E_GRANT_DENIED | PROMPT_WORDING | 该实例未授予发指令权限（查看权限不包含发指令） | 两侧 |
| prompt.confirm.unconfirmed | E_COMMAND_UNCONFIRMED | COMMAND_WORDING | — | — | 发送前需要在确认框里勾选「确认发送」 | `remoteCommandGate.ts` |
| prompt.confirm.stale | E_COMMAND_CONFIRM_STALE | COMMAND_WORDING | — | — | 草稿已改变，请重新确认后发送 | `remoteCommandGate.ts` |
| channel.tablet.unverified | E_COMMAND_REMOTE_UNVERIFIED | COMMAND_WORDING | — | — | 安全连接尚未通过真机校验，未发送任何内容 | `remoteCommandGate.ts` |
| channel.desktop.unverified | — | — | E_CHANNEL_UNVERIFIED | PROMPT_WORDING | 该电脑尚未标记安全通道已验证，未发送任何内容 | 插件 `sessionPrompt` |
| channel.desktop.leafMismatch | — | — | E_CHANNEL_LEAF_MISMATCH | PROMPT_WORDING | 该实例当前证书与标记时的指纹不同（证书已更换），未发送任何内容 | 插件 `sessionPrompt` |
| lease.observing | — | — | E_LEASE_OBSERVING | LEASE_WORDING | 该会话正被其他人使用（只读），未写入任何内容 | 插件租约 |
| lease.notHeld | — | — | E_LEASE_NOT_HELD | LEASE_WORDING | 未持有该会话的写权限，未写入任何内容 | 插件租约 |
| lease.expired | — | — | E_LEASE_EXPIRED | LEASE_WORDING | 会话写权限已过期，请重新确认后重试 | 插件租约 |
| head.moved | — | — | E_HEAD_MOVED | LEASE_WORDING | 会话已被其他人写入，请先刷新再重新确认 | 插件租约 |
| prompt.duplicate | — | — | E_PROMPT_DUPLICATE | PROMPT_WORDING | 同一条指令已经处理过，未重复写入 | 插件 `sessionPrompt` |
| instance.unknown | — | — | E_INSTANCE_UNKNOWN | PROMPT_WORDING | 找不到该实例，请重新配对 | 插件 `sessionPrompt` |
| session.unavailable | — | — | E_SESSION_UNAVAILABLE | PROMPT_WORDING | 该会话暂时不可写入（投递通道未接入） | 插件 `sessionPrompt` |

> `channel.tablet.unverified` 与 `channel.desktop.unverified` 是**同一个前置条件的两个半边，文案不同、不可互换、不可互相替代**：平板侧证明的是「本机没有通过真机 pin 校验」，桌面侧证明的是「操作员没有标记本机通道已验证」。两侧都成立才允许发送。
> `channel.desktop.leafMismatch` 表示**操作员确实验证过某个证书，但当前证书已不是那一个**（换证书 / 重装）；它与 `channel.desktop.unverified`（从未验证 / 标记缺失 / 无 pin 可绑）**必须可区分**，两者都拒绝发送，且都绝不 TOFU 补 pin。

> `prompt.text.*` 与 `prompt.grant.denied` 是**同一失败空间的重叠**：平板先拦（本地判定），插件再拦（防御性复检）。**同一语义键在两侧必须逐字相同**；这就是本表存在的原因。

## DARK 通道标记的威胁模型

桌面侧只认操作员显式写入的标记文件 `~\.dsh\dots\channel-verified.json`，载荷为证据三元组 `{verifiedAt, instanceId, leafSha256, verifier}`，任何启动路径、握手成功、面板操作都**不得**写它；文件缺失 ⇒ 每个调用一律 `E_CHANNEL_UNVERIFIED`，无回退、不记忆上次。**一句话威胁模型：能写这个文件的人与用户处于同一信任域，所以它是操作员断言，不是密码学证明；任何文案都不得暗示更强的东西。** 两侧必须同时在场（平板侧 `channelVerifiedAt` 只在**本次安装内**、与匹配叶证书的 pin 握手成功后才置位），否则拒绝。

## 门禁如何断言

平板侧的 8 个码由 `apps\arkui-schedule\entry\src\main\ets\model\remoteCommandGate.ts` 的 `COMMAND_WORDING` 提供；插件侧由 `packages\dsh-dots\src\remote\promptWording.ts` 的 `PROMPT_WORDING` 与 `...\lease.ts` 的 `LEASE_WORDING` 提供；一条插件侧测试同时读取本表、两侧源码与这两个常量，任何一处改动而未同步 ⇒ 门禁失败。**文案不得出现第三份拷贝。**

---

日期 2026-11-23 · owner：总设计师 · 本表共 **17 行**语义键 · 状态：本表随 `mod-plugin-session-prompt` 落地；`mod-chat-lease` 的 `LEASE_WORDING` 先于本表冻结。
