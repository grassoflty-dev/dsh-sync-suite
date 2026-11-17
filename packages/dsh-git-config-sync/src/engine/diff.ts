/**
 * 差异摘要（纯函数，零 I/O，**绝不抛异常**）。
 *
 * 只给「够用户判断」的信息：每个文件的新增/删除行数、字节变化，以及前后各 N 行的
 * 统一 diff hunk 文本。**不产出完整 patch**——大文件把 RPC 响应撑爆的代价远大于收益，
 * 所以 hunks 有硬上限（默认 200 行），超出就置 `truncated: true` 并停止。
 *
 * 规则（与 docs/PLUGIN-DIFF.md 一致）：
 *   - 行按 `\n` 切；行尾 `\r` 只用于展示，不参与比较（纯 CRLF 差异不算变更）；
 *   - 末行有无换行属于**内容差异**（标准 diff 语义），hunk 里会补 `\ No newline at end of file`；
 *   - 相同行不进 hunk；hunk 之间相隔超过 `2 * contextLines` 才拆成两段；
 *   - 二进制（含 NUL 字节）或 > 512KB 的文件只给 kind 与字节数，不产出 hunk；
 *   - 任何异常（入参不是字符串/对象、内部预算超限）都退化成空结果，不向上抛。
 */

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'same'

export interface FileDiffStat {
  path: string
  kind: FileChangeKind
  addedLines: number
  removedLines: number
  beforeBytes: number
  afterBytes: number
  /**
   * 附加字段（非破坏性）：二进制 / 超过 512KB / hunk 预算耗尽时为 true。
   * 这类文件只给 kind 与字节数，不产出 hunk。
   */
  truncated?: boolean
}

export interface DiffSummary {
  files: FileDiffStat[]
  totals: {
    added: number
    modified: number
    deleted: number
    same: number
    addedLines: number
    removedLines: number
  }
}

/** 行级统一 diff 摘要：只产出前后各 N 行的 hunk 文本，**不产出完整 patch**。 */
export interface UnifiedHunk {
  path: string
  header: string
  lines: string[]
  truncated: boolean
}

export interface DiffOptions {
  /** 上下文行数，默认 3。 */
  contextLines?: number
  /** hunk 正文总行数上限，默认 200；超出置 `truncated: true` 并停止。 */
  maxLines?: number
  /** 仅用于回填 `UnifiedHunk.path`（diffText 不知道文件名）。 */
  path?: string
}

export const DEFAULT_CONTEXT_LINES = 3
export const DEFAULT_MAX_LINES = 200
/** 超过这个字节数的文件不逐行 diff（只给 kind 与字节数）。 */
export const MAX_DIFF_BYTES = 512 * 1024

const MAX_DP_CELLS = 1_000_000
const NO_EOL_MARKER = '\\ No newline at end of file'
const EMPTY_TEXT = ''

interface SourceLine {
  text: string
  /** 该行是文件的最后一行，且原文没有结尾换行。 */
  noEol: boolean
}

interface Op {
  kind: ' ' | '-' | '+'
  beforeIndex: number
  afterIndex: number
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : EMPTY_TEXT
}

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function utf8Bytes(text: string): number {
  try {
    return Buffer.byteLength(text, 'utf8')
  } catch {
    return text.length
  }
}

/** 二进制（含 NUL）或超过 512KB：不逐行 diff。 */
function isOpaque(text: string): boolean {
  if (text === EMPTY_TEXT) return false
  if (text.indexOf('\u0000') >= 0) return true
  return utf8Bytes(text) > MAX_DIFF_BYTES
}

/** 按 `\n` 切行；`\r` 只剥掉用于展示，末行是否带换行单独记下来。 */
function toLines(text: string): SourceLine[] {
  if (text === EMPTY_TEXT) return []
  const raw = text.split('\n')
  const endsWithNewline = text.endsWith('\n')
  if (endsWithNewline) raw.pop()
  const lines: SourceLine[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index]!
    const text = line.endsWith('\r') ? line.slice(0, -1) : line
    lines.push({ text, noEol: index === raw.length - 1 && !endsWithNewline })
  }
  return lines
}

function linesKey(line: SourceLine): string {
  return line.noEol ? `${line.text}\u0000` : line.text
}

/**
 * LCS 差分。先剥掉公共前后缀（配置文件通常改几行，这一步就把问题缩到很小），
 * 只有中间段会做 DP；中间段超过预算 → 返回 null（调用方降级成"整体替换"）。
 */
function diffOps(before: SourceLine[], after: SourceLine[]): Op[] | null {
  const beforeLength = before.length
  const afterLength = after.length
  let prefix = 0
  while (prefix < beforeLength && prefix < afterLength && linesKey(before[prefix]!) === linesKey(after[prefix]!)) {
    prefix += 1
  }
  let beforeEnd = beforeLength
  let afterEnd = afterLength
  while (
    beforeEnd > prefix &&
    afterEnd > prefix &&
    linesKey(before[beforeEnd - 1]!) === linesKey(after[afterEnd - 1]!)
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }

  const ops: Op[] = []
  for (let index = 0; index < prefix; index += 1) {
    ops.push({ kind: ' ', beforeIndex: index, afterIndex: index })
  }

  const midBefore = beforeEnd - prefix
  const midAfter = afterEnd - prefix
  if (midBefore === 0 && midAfter === 0) {
    // 完全一致（或只差前缀/后缀）。
  } else if (midBefore === 0) {
    for (let index = 0; index < midAfter; index += 1) {
      ops.push({ kind: '+', beforeIndex: prefix, afterIndex: prefix + index })
    }
  } else if (midAfter === 0) {
    for (let index = 0; index < midBefore; index += 1) {
      ops.push({ kind: '-', beforeIndex: prefix + index, afterIndex: prefix })
    }
  } else {
    if (midBefore * midAfter > MAX_DP_CELLS) return null
    const width = midAfter + 1
    const table = new Int32Array((midBefore + 1) * width)
    for (let i = midBefore - 1; i >= 0; i -= 1) {
      const beforeIndex = prefix + i
      for (let j = midAfter - 1; j >= 0; j -= 1) {
        const afterIndex = prefix + j
        if (linesKey(before[beforeIndex]!) === linesKey(after[afterIndex]!)) {
          table[i * width + j] = table[(i + 1) * width + (j + 1)]! + 1
        } else {
          table[i * width + j] = Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!)
        }
      }
    }
    let i = 0
    let j = 0
    while (i < midBefore && j < midAfter) {
      const beforeIndex = prefix + i
      const afterIndex = prefix + j
      if (linesKey(before[beforeIndex]!) === linesKey(after[afterIndex]!)) {
        ops.push({ kind: ' ', beforeIndex, afterIndex })
        i += 1
        j += 1
      } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
        ops.push({ kind: '-', beforeIndex, afterIndex })
        i += 1
      } else {
        ops.push({ kind: '+', beforeIndex, afterIndex })
        j += 1
      }
    }
    while (i < midBefore) {
      ops.push({ kind: '-', beforeIndex: prefix + i, afterIndex: prefix + j })
      i += 1
    }
    while (j < midAfter) {
      ops.push({ kind: '+', beforeIndex: prefix + i, afterIndex: prefix + j })
      j += 1
    }
  }

  for (let index = 0; index < beforeLength - beforeEnd; index += 1) {
    ops.push({ kind: ' ', beforeIndex: beforeEnd + index, afterIndex: afterEnd + index })
  }
  return ops
}

interface HunkBuildResult {
  hunks: UnifiedHunk[]
  /** 有任何 hunk 因为行数预算被裁剪。 */
  truncated: boolean
}

function buildHunks(
  ops: Op[],
  before: SourceLine[],
  after: SourceLine[],
  path: string,
  contextLines: number,
  maxLines: number,
): HunkBuildResult {
  const modifiedIndices: number[] = []
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index]!.kind !== ' ') modifiedIndices.push(index)
  }
  if (modifiedIndices.length === 0) return { hunks: [], truncated: false }

  // 相隔不超过 2*context 的改动合并进同一个 hunk（与标准 unified diff 一致）。
  const ranges: Array<[number, number]> = []
  let rangeStart = modifiedIndices[0]!
  let previous = modifiedIndices[0]!
  for (let index = 1; index < modifiedIndices.length; index += 1) {
    const current = modifiedIndices[index]!
    if (current - previous <= contextLines * 2 + 1) {
      previous = current
      continue
    }
    ranges.push([rangeStart, previous])
    rangeStart = current
    previous = current
  }
  ranges.push([rangeStart, previous])

  const hunks: UnifiedHunk[] = []
  let budget = maxLines
  let truncated = false
  for (const [first, last] of ranges) {
    if (budget <= 0) {
      truncated = true
      break
    }
    const start = Math.max(0, first - contextLines)
    const end = Math.min(ops.length - 1, last + contextLines)

    let beforeConsumed = 0
    let afterConsumed = 0
    for (let index = 0; index < start; index += 1) {
      if (ops[index]!.kind !== '+') beforeConsumed += 1
      if (ops[index]!.kind !== '-') afterConsumed += 1
    }
    let oldCount = 0
    let newCount = 0
    for (let index = start; index <= end; index += 1) {
      if (ops[index]!.kind !== '+') oldCount += 1
      if (ops[index]!.kind !== '-') newCount += 1
    }
    const oldStart = oldCount === 0 ? beforeConsumed : beforeConsumed + 1
    const newStart = newCount === 0 ? afterConsumed : afterConsumed + 1
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`

    const lines: string[] = []
    let cut = false
    for (let index = start; index <= end; index += 1) {
      const op = ops[index]!
      const line = op.kind === '+' ? after[op.afterIndex]! : before[op.beforeIndex]!
      const text = `${op.kind === ' ' ? ' ' : op.kind}${line.text}`
      if (budget <= 0) {
        cut = true
        break
      }
      lines.push(text)
      budget -= 1
      const noEol = op.kind === '+' ? after[op.afterIndex]!.noEol : before[op.beforeIndex]!.noEol
      if (noEol) {
        if (budget <= 0) {
          cut = true
          break
        }
        lines.push(NO_EOL_MARKER)
        budget -= 1
      }
    }
    hunks.push({ path, header, lines, truncated: cut })
    if (cut) {
      truncated = true
      break
    }
  }
  return { hunks, truncated }
}

/**
 * 行级统一 diff 摘要。
 *
 * 二进制 / 超过 512KB：返回 `{addedLines: 0, removedLines: 0, hunks: []}`（不做行级猜测）。
 * 内部 DP 预算超限：把整段视为替换（`addedLines/removedLines` 为两侧行数，hunks 为一个 truncated 占位）。
 */
export function diffText(
  before: unknown,
  after: unknown,
  options: DiffOptions = {},
): { addedLines: number; removedLines: number; hunks: UnifiedHunk[] } {
  try {
    const beforeText = asText(before)
    const afterText = asText(after)
    const path = typeof options.path === 'string' ? options.path : ''
    const contextLines = toInt(options.contextLines, DEFAULT_CONTEXT_LINES, 0, 50)
    const maxLines = toInt(options.maxLines, DEFAULT_MAX_LINES, 1, 5000)
    if (isOpaque(beforeText) || isOpaque(afterText)) return { addedLines: 0, removedLines: 0, hunks: [] }

    const beforeLines = toLines(beforeText)
    const afterLines = toLines(afterText)
    const ops = diffOps(beforeLines, afterLines)
    if (ops === null) {
      return {
        addedLines: afterLines.length,
        removedLines: beforeLines.length,
        hunks: [{ path, header: '@@ -1 +1 @@', lines: [], truncated: true }],
      }
    }

    let addedLines = 0
    let removedLines = 0
    for (const op of ops) {
      if (op.kind === '+') addedLines += 1
      else if (op.kind === '-') removedLines += 1
    }
    const built = buildHunks(ops, beforeLines, afterLines, path, contextLines, maxLines)
    return { addedLines, removedLines, hunks: built.hunks }
  } catch {
    return { addedLines: 0, removedLines: 0, hunks: [] }
  }
}

function toTextMap(value: unknown): Record<string, string> {
  const source = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const out: Record<string, string> = Object.create(null) as Record<string, string>
  for (const key of Object.keys(source)) {
    const item = source[key]
    if (typeof item === 'string') out[key] = item
  }
  return out
}

function emptySummary(): DiffSummary {
  return {
    files: [],
    totals: { added: 0, modified: 0, deleted: 0, same: 0, addedLines: 0, removedLines: 0 },
  }
}

/** 把一组文件级统计汇总成 totals（不重算 diff）。 */
export function summarizeFiles(files: FileDiffStat[]): DiffSummary {
  try {
    const list = Array.isArray(files) ? files : []
    const totals: DiffSummary['totals'] = {
      added: 0,
      modified: 0,
      deleted: 0,
      same: 0,
      addedLines: 0,
      removedLines: 0,
    }
    for (const file of list) {
      if (file === null || typeof file !== 'object') continue
      if (file.kind === 'added') totals.added += 1
      else if (file.kind === 'modified') totals.modified += 1
      else if (file.kind === 'deleted') totals.deleted += 1
      else totals.same += 1
      totals.addedLines += Number.isFinite(file.addedLines) ? file.addedLines : 0
      totals.removedLines += Number.isFinite(file.removedLines) ? file.removedLines : 0
    }
    return { files: list, totals }
  } catch {
    return emptySummary()
  }
}

/**
 * 文件级差异（path 存在与否决定 added/deleted，内容是否相同决定 same/modified）。
 * 输入里的非字符串值一律按"不存在"处理，绝不抛异常。
 */
export function diffFiles(before: unknown, after: unknown, options: DiffOptions = {}): DiffSummary {
  try {
    const beforeMap = toTextMap(before)
    const afterMap = toTextMap(after)
    const paths = Array.from(new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])).sort()
    const files: FileDiffStat[] = []
    for (const filePath of paths) {
      const beforeText = beforeMap[filePath]
      const afterText = afterMap[filePath]
      if (beforeText === undefined && afterText === undefined) continue
      const kind: FileChangeKind =
        beforeText === undefined
          ? 'added'
          : afterText === undefined
            ? 'deleted'
            : beforeText === afterText
              ? 'same'
              : 'modified'
      const stat: FileDiffStat = {
        path: filePath,
        kind,
        addedLines: 0,
        removedLines: 0,
        beforeBytes: utf8Bytes(beforeText ?? EMPTY_TEXT),
        afterBytes: utf8Bytes(afterText ?? EMPTY_TEXT),
      }
      if (kind !== 'same') {
        if (isOpaque(beforeText ?? EMPTY_TEXT) || isOpaque(afterText ?? EMPTY_TEXT)) {
          stat.truncated = true
        } else {
          const result = diffText(beforeText ?? EMPTY_TEXT, afterText ?? EMPTY_TEXT, options)
          stat.addedLines = result.addedLines
          stat.removedLines = result.removedLines
        }
      }
      files.push(stat)
    }
    return summarizeFiles(files)
  } catch {
    return emptySummary()
  }
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** 一句中文结论，如「3 个文件变更（+12 / -4 行），1 个新增，1 个删除」。 */
export function summarize(summary: DiffSummary): string {
  try {
    const totals = summary !== null && typeof summary === 'object' ? (summary as DiffSummary).totals : null
    if (totals === null || typeof totals !== 'object') return '没有差异'
    const added = safeCount(totals.added)
    const modified = safeCount(totals.modified)
    const deleted = safeCount(totals.deleted)
    const changed = added + modified + deleted
    if (changed === 0) return '没有差异'
    const parts = [`${changed} 个文件变更（+${safeCount(totals.addedLines)} / -${safeCount(totals.removedLines)} 行）`]
    if (added > 0) parts.push(`${added} 个新增`)
    if (modified > 0) parts.push(`${modified} 个修改`)
    if (deleted > 0) parts.push(`${deleted} 个删除`)
    return parts.join('，')
  } catch {
    return '没有差异'
  }
}
