/**
 * 远程访问域（`src/remote/**`）的**唯一**类型契约。
 *
 * 纪律（PRD/评审共守）：
 *   1. 本域**禁止** import `src/engine/**`（`engine/errors.ts` 这类纯工具除外）与
 *      `src/schedule/**` 的实现：远程监听起不来不能连累同步，反之亦然。
 *   2. 一切失败 fail-closed：不认识的 mode / 缺字段 / 探测未证实 → 一律不给出"可用"结论。
 *   3. token 明文永不进入 `RemoteStatus`、日志、错误消息；只允许出现在
 *      `RemoteLink`（用户显式点「显示链接」时）与二维码矩阵里。
 *
 * 与 App（`apps/arkui-schedule/entry/src/main/ets/model/remoteAccess.ts`）共享同一套
 * 字段语义：字段名、枚举值、必填规则必须逐字一致，见 `docs/REMOTE-ACCESS-OPTIONS.md`。
 *
 * ## 三个"看起来都在说开关"的位（mod-plugin-remote-accepting-surface：禁止互相代用）
 *
 * | 位 | 唯一含义 | 谁写 | 谁读 |
 * | --- | --- | --- | --- |
 * | `enabled` | **上一次保存的偏好**（start/stop 时按监听句柄回声写，进程被强杀后可能过期） | `commitEnabledFlag()`（起成功 / 显式 stop）、`saveSettings` 原样落盘 | 只给人看；**任何情况下不得**被当成"此刻在接"或"下次自动起" |
 * | `autoStart` | **意图**：下次激活时要不要自己起监听 | `start()`（manual 来源置 `true`，失败也置）、`stop()` 清零落盘、`dispose()` 不动 | 激活唯一入口 `service.autoStart()` |
 * | `accepting` | **活真相**：此刻监听句柄是否存在（与 `RemoteStatus.running` **同一个**表达式 `runtime.handle !== null`） | 无人写；每次读状态时派生 | 面板那句「正在接受连接（addr:port）」 |
 *
 * 一句话记法：`enabled` = 上次存了什么偏好，`autoStart` = 下次要不要自己起，
 * `accepting` = **此刻**在不在接。三者不准互相推断，也不准合并成一个字段。
 */
/** 设置项的字段名（RPC 归一、App 侧、UI 表单三处共用）。 */
export const REMOTE_SETTING_KEYS = [
    'enabled',
    'mode',
    'port',
    'lanAddress',
    'tailscaleHost',
    'cloudflareHost',
    'ipv6Address',
    'manualUrl',
    'token',
];
