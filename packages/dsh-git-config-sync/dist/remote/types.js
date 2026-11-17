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
];
