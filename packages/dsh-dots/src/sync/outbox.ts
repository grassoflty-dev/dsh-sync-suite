/**
 * 仓库外 outbox 的真实文件实现（契约 §13，M2）。
 *
 * 落点：`%USERPROFILE%\.dsh\dots\outbox\<repoHash>.json` —— 明确在工作副本之外，
 * 绝不进 git、绝不进 timeline/**。写入复用 write.ts 的 `atomicReplace`
 * （同目录 tmp → 回读逐字节校验 → rename → 备份现场），因此崩溃/断电不会把
 * attempts 预算写成半个文件。`syncing` 状态当场落盘，跨会话累计不重置。
 */
import path from 'node:path'
import { SyncError } from '../engine/errors.js'
import { repoHash } from '../engine/paths.js'
import { atomicReplace, NodeTimelineFs } from '../timeline/write.js'
import type { OutboxIntent, OutboxPort } from './cycle.js'

/** 仓库外 outbox 路径：state 根目录下的 outbox/<repoHash>.json。 */
export function outboxPathFor(stateRoot: string, repoUrl: string): string {
  return path.join(stateRoot, 'outbox', `${repoHash(repoUrl)}.json`)
}

export interface NodeOutboxPortOptions {
  /** 插件 state 根目录（通常是 `~/.dsh/dots`）。与 repoUrl 二选一给出 filePath 时可省略。 */
  stateRoot?: string
  repoUrl?: string
  /** 显式路径（测试 / 运维覆盖）；仍须在工作副本之外。 */
  filePath?: string
}

export class NodeOutboxPort implements OutboxPort {
  readonly filePath: string
  private readonly fs: NodeTimelineFs

  constructor(options: NodeOutboxPortOptions) {
    if (typeof options.filePath === 'string' && options.filePath.trim() !== '') {
      this.filePath = path.resolve(options.filePath)
    } else {
      if (typeof options.stateRoot !== 'string' || options.stateRoot.trim() === '') {
        throw new SyncError('E_VALIDATION', 'NodeOutboxPort 需要 stateRoot 或 filePath')
      }
      if (typeof options.repoUrl !== 'string' || options.repoUrl.trim() === '') {
        throw new SyncError('E_VALIDATION', 'NodeOutboxPort 需要 repoUrl 以推导 outbox 文件名')
      }
      this.filePath = outboxPathFor(options.stateRoot, options.repoUrl)
    }
    this.fs = new NodeTimelineFs(path.dirname(this.filePath))
  }

  /** 缺文件 = 空 outbox（合法首跑）；坏文件 typed 失败，绝不静默丢弃意图。 */
  async load(): Promise<OutboxIntent[]> {
    const text = await this.fs.read(path.basename(this.filePath))
    if (text === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new SyncError('E_CORRUPT', `outbox 文件不是合法 JSON：${String(error)}`, { path: this.filePath })
    }
    if (!Array.isArray(parsed)) {
      throw new SyncError('E_CORRUPT', 'outbox 顶层必须是数组', { path: this.filePath })
    }
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof (entry as Record<string, unknown>).intentId !== 'string') {
        throw new SyncError('E_CORRUPT', 'outbox 条目缺少 intentId', { path: this.filePath })
      }
    }
    return parsed as OutboxIntent[]
  }

  /** 原子替换落盘（含 readback 校验）；空数组写为 `[]\n`，表示已排空。 */
  async save(entries: OutboxIntent[]): Promise<void> {
    const text = `${JSON.stringify(entries, null, 2)}\n`
    await atomicReplace(this.fs, path.basename(this.filePath), text, 'outbox')
  }
}
