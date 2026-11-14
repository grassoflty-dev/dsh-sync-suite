export const ERROR_CODES = {
    VALIDATION: 'E_VALIDATION',
    CONFIRM_REQUIRED: 'E_CONFIRM_REQUIRED',
    UNKNOWN_ACTION: 'E_UNKNOWN_ACTION',
    NOT_FOUND: 'E_NOT_FOUND',
    GIT: 'E_GIT',
    AUTH: 'E_AUTH',
    CONFLICT: 'E_CONFLICT',
    SHA_MISMATCH: 'E_SHA_MISMATCH',
    IO: 'E_IO',
    INTERNAL: 'E_INTERNAL',
};
export class SyncError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'SyncError';
        this.code = code;
        if (details !== undefined)
            this.details = details;
    }
}
export function isSyncError(error) {
    return error instanceof SyncError;
}
/** 把任意异常映射成 RPC 错误体；绝不带出 secret（调用方保证 message 已脱敏）。 */
export function toRpcError(error) {
    if (error instanceof SyncError) {
        const body = { code: error.code, message: error.message };
        if (error.details !== undefined)
            body.details = error.details;
        return body;
    }
    if (error instanceof Error) {
        const code = typeof error.code === 'string' ? error.code : '';
        if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOTDIR') {
            return { code: ERROR_CODES.IO, message: error.message };
        }
        return { code: ERROR_CODES.INTERNAL, message: error.message || String(error) };
    }
    return { code: ERROR_CODES.INTERNAL, message: String(error) };
}
/** 抛出 SyncError 的简写。 */
export function fail(code, message, details) {
    throw new SyncError(code, message, details);
}
/** 只取错误消息，供 status.error 之类的字段使用。 */
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
