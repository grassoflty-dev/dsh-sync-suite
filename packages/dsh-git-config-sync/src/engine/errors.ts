/**
 * 统一错误类型与 RPC 错误映射。
 *
 * 所有对外错误码必须在 CONTRACT §2.3 列出的集合内；未预期异常映射为 E_INTERNAL。
 */
import type { RpcErrorBody } from './types.js'

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
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/**
 * chat 域（云端对话模式工具隔离）的错误码。
 *
 * - `TOOLS_NOT_ISOLATED` 是**正式安全边界错误码**，已进 `docs/DATA-CONTRACT.md` §2.3 的公共表；
 * - `DENY_FAILED` 是**内部防御性错误**（宿主契约不满足 / `restrict` 抛错），只用于定位，
 *   **不进公共错误码表**——对外仍应表现为"拒绝创建会话"。
 */
export const CHAT_ERROR_CODES = {
  TOOLS_NOT_ISOLATED: 'E_CHAT_TOOLS_NOT_ISOLATED',
  DENY_FAILED: 'E_CHAT_DENY_FAILED',
} as const

export class SyncError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'SyncError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function isSyncError(error: unknown): error is SyncError {
  return error instanceof SyncError
}

/** 把任意异常映射成 RPC 错误体；绝不带出 secret（调用方保证 message 已脱敏）。 */
export function toRpcError(error: unknown): RpcErrorBody {
  if (error instanceof SyncError) {
    const body: RpcErrorBody = { code: error.code, message: error.message }
    if (error.details !== undefined) body.details = error.details
    return body
  }
  if (error instanceof Error) {
    const code = typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code! : ''
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOTDIR') {
      return { code: ERROR_CODES.IO, message: error.message }
    }
    return { code: ERROR_CODES.INTERNAL, message: error.message || String(error) }
  }
  return { code: ERROR_CODES.INTERNAL, message: String(error) }
}

/** 抛出 SyncError 的简写。 */
export function fail(code: string, message: string, details?: unknown): never {
  throw new SyncError(code, message, details)
}

/** 只取错误消息，供 status.error 之类的字段使用。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
