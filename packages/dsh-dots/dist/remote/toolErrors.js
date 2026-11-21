/**
 * 远程只读工具的错误词汇表（`mod-plugin-remote-tools`）。
 *
 * 复用 `engine/errors.ts` 的 `SyncError` 载体（`toRpcError()` 会原样透传 code），
 * 只新增本模块专用的拒绝码——每种拒绝都可区分，且 details 里**永不**放 URL 或 token。
 *
 * 五类必须可区分的拒绝：
 *   - 未知实例        → E_INSTANCE_UNKNOWN
 *   - 未授权          → E_GRANT_DENIED
 *   - 不可达 / 超时    → E_REMOTE_UNREACHABLE
 *   - 远端鉴权拒绝     → E_REMOTE_AUTH_REJECTED
 *   - 不支持的动作     → E_REMOTE_UNSUPPORTED
 * 另加 E_REMOTE_BAD_RESPONSE（远端返回无法解析的载荷）与 E_VALIDATION（本地入参非法）。
 *
 * 安全纪律：本文件没有任何日志调用；`remoteToolError()` 的 details 形状被写死为
 * `{instanceId?, tool?, status?}`，从类型上就塞不进 url / token / 会话正文。
 */
import { SyncError } from '../engine/errors.js';
export const REMOTE_TOOL_ERROR_CODES = {
    INSTANCE_UNKNOWN: 'E_INSTANCE_UNKNOWN',
    GRANT_DENIED: 'E_GRANT_DENIED',
    REMOTE_UNREACHABLE: 'E_REMOTE_UNREACHABLE',
    REMOTE_AUTH_REJECTED: 'E_REMOTE_AUTH_REJECTED',
    REMOTE_UNSUPPORTED: 'E_REMOTE_UNSUPPORTED',
    REMOTE_BAD_RESPONSE: 'E_REMOTE_BAD_RESPONSE',
    /** 响应体超过字节上限；独立 typed 码，便于 UI 区分"太大"与"坏响应"。 */
    REMOTE_TOO_LARGE: 'E_REMOTE_TOO_LARGE',
};
/** 构造一个不会泄露凭据的拒绝错误。 */
export function remoteToolError(code, message, details = {}) {
    return new SyncError(code, message, details);
}
/** 远端 RPC 响应里可能带回的 code：只在白名单内映射，避免把远端的任意文案透传上屏。 */
const REMOTE_CODE_MAP = {
    E_INSTANCE_UNKNOWN: REMOTE_TOOL_ERROR_CODES.INSTANCE_UNKNOWN,
    E_GRANT_DENIED: REMOTE_TOOL_ERROR_CODES.GRANT_DENIED,
    E_REMOTE_UNREACHABLE: REMOTE_TOOL_ERROR_CODES.REMOTE_UNREACHABLE,
    E_REMOTE_AUTH_REJECTED: REMOTE_TOOL_ERROR_CODES.REMOTE_AUTH_REJECTED,
    E_REMOTE_UNSUPPORTED: REMOTE_TOOL_ERROR_CODES.REMOTE_UNSUPPORTED,
    E_REMOTE_BAD_RESPONSE: REMOTE_TOOL_ERROR_CODES.REMOTE_BAD_RESPONSE,
    E_REMOTE_TOO_LARGE: REMOTE_TOOL_ERROR_CODES.REMOTE_TOO_LARGE,
    // 远端没装本模块时返回 E_UNKNOWN_ACTION → 就是"不支持的只读动作"。
    E_UNKNOWN_ACTION: REMOTE_TOOL_ERROR_CODES.REMOTE_UNSUPPORTED,
};
/** 把远端 `{ok:false,error:{code}}` 的 code 收敛到本模块的白名单；不认的按坏响应处理。 */
export function mapRemoteCode(code) {
    return typeof code === 'string' ? (REMOTE_CODE_MAP[code] ?? REMOTE_TOOL_ERROR_CODES.REMOTE_BAD_RESPONSE) : REMOTE_TOOL_ERROR_CODES.REMOTE_BAD_RESPONSE;
}
