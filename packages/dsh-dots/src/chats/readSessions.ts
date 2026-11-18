/**
 * 读本机会话：目录扫描 + zstd 帧解压 + JSONL 行分类。
 *
 * 为什么不能一句 `zstdDecompressSync(file)` 了事（RSI §2.1 实测）：
 * `session.v4.jsonl.zstd` 是**裸 zstd 帧的串联**（无长度前缀、无外层容器），
 * Node 的 `zlib.zstdDecompressSync` 只解**第一帧**且**不报错**——静默丢掉 99% 的数据。
 * 所以必须自己按帧走：每帧 magic `28 b5 2f fd` 开头，帧头给出 Block 结构，走到 Last_Block。
 *
 * 帧格式（RFC 8878，逐字实现，勿凭记忆改动）：
 *   magic(4) | Frame_Header_Descriptor(1) | [Window_Descriptor(1)] | [Dictionary_ID(0/1/2/4)]
 *   | [Frame_Content_Size(0/1/2/4/8)] | Block* | [Checksum(4)]
 *   Block_Header(3, little-endian) = Last_Block:1 | Block_Type:2 | Block_Size:21
 *   Block_Type: 0=Raw, 1=RLE（载荷**只有 1 字节**）, 2=Compressed, 3=Reserved
 *
 * 「截断」的处理原则：**不抛**。走到不完整的帧就停在最后一个完整帧处并置 `truncated:true`，
 * 让调用方（`exportChats`）自己 fail-closed。理由：一个 2 MB 的会话因为尾巴 4 个字节缺失
 * 就整份读不出来，是比"少最后一条事件"更糟的失败方式。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { dshHome } from '../engine/paths.js'
import type {
  ClassifiedEvents,
  LocalSessionInfo,
  SessionEvent,
  SessionHeader,
  SessionReadResult,
  ZstdFrame,
  ZstdFrameScan,
} from './types.js'

/** DSH 当前版本的会话文件名（RSI §4.1：`CANONICAL_LOG_FILENAME` + `.zstd`，版本 4）。 */
export const SESSION_FILE_NAME = 'session.v4.jsonl.zstd'

/** zstd 魔数 `0xFD2FB528` 的小端字节。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const

/** skippable frame 的 magic 区间：`0x184D2A50`..`0x184D2A5F`（小端第 1 字节 0x50..0x5F）。 */
function isSkippableFrame(buffer: Buffer, at: number): boolean {
  if (at + 4 > buffer.length) return false
  return buffer[at]! >= 0x50 && buffer[at]! <= 0x5f && buffer[at + 1] === 0x2a && buffer[at + 2] === 0x4d && buffer[at + 3] === 0x18
}

function hasZstdMagic(buffer: Buffer, at: number): boolean {
  if (at + 4 > buffer.length) return false
  return (
    buffer[at] === ZSTD_MAGIC[0] &&
    buffer[at + 1] === ZSTD_MAGIC[1] &&
    buffer[at + 2] === ZSTD_MAGIC[2] &&
    buffer[at + 3] === ZSTD_MAGIC[3]
  )
}

/** magic 或 skippable magic 都算"这是一个帧的开头"。 */
function startsWithFrameMagic(buffer: Buffer, at: number): boolean {
  return hasZstdMagic(buffer, at) || isSkippableFrame(buffer, at)
}

/** `at` 处是否可能是帧开头（用于垃圾字节扫描）。 */
function looksLikeFrameStart(buffer: Buffer, at: number): boolean {
  return startsWithFrameMagic(buffer, at)
}

/**
 * 算 `at` 处一帧的**总字节数**；数据不足以判定/帧不完整时返回 `null`。
 *
 * 返回 `null` 有两种含义（调用方都按「截断」处理，不区分）：
 *   1. 剩余字节不足以走完帧（真正的截断）；
 *   2. 帧头非法（reserved bit 置位 / Block_Type=3）——这是损坏，不是可续读的前缀。
 */
export function frameByteLength(buffer: Buffer, at: number): number | null {
  if (!startsWithFrameMagic(buffer, at)) return null

  // skippable frame：magic(4) + size(4) + payload(size)
  if (isSkippableFrame(buffer, at)) {
    if (at + 8 > buffer.length) return null
    const size = buffer.readUInt32LE(at + 4)
    const total = 8 + size
    return at + total <= buffer.length ? total : null
  }

  let cursor = at + 4
  if (cursor + 1 > buffer.length) return null
  const descriptor = buffer[cursor]!
  cursor += 1
  // bit3 是 reserved，规范要求为 0；置位说明这 4 个字节只是"长得像 magic"。
  if ((descriptor & 0x08) !== 0) return null

  const contentSizeFlag = (descriptor >> 6) & 0x03
  const singleSegment = (descriptor & 0x20) !== 0
  const hasChecksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03

  // Window_Descriptor 只在非 single-segment 时存在。
  if (!singleSegment) cursor += 1
  const dictionarySize = [0, 1, 2, 4][dictionaryFlag]!
  cursor += dictionarySize
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag]!
  cursor += contentSizeBytes
  if (cursor > buffer.length) return null

  // Block 循环：Raw/Compressed 的载荷是 Block_Size 字节，RLE 只有 1 字节。
  for (;;) {
    if (cursor + 3 > buffer.length) return null
    const blockHeader = buffer.readUIntLE(cursor, 3)
    cursor += 3
    const lastBlock = (blockHeader & 0x01) !== 0
    const blockType = (blockHeader >> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 3) return null
    cursor += blockType === 1 ? 1 : blockSize
    if (cursor > buffer.length) return null
    if (lastBlock) break
  }

  if (hasChecksum) cursor += 4
  if (cursor > buffer.length) return null
  return cursor - at
}

/**
 * 把整份 buffer 切成 zstd 帧。
 *
 * - **空 buffer** → 0 帧、`truncated:false`；
 * - **首个 magic 之前的垃圾字节** → 跳过并计入 `garbageBytes`（真实 DSH 文件不该有，
 *   但半截下载/手工拼接的文件会有，跳过去比整份失败更有用）；
 * - **截断帧** → 停在最后一个完整帧，`truncated:true`，`remainderBytes` 给出剩余字节数；
 * - **完整帧之后不是 magic** → 同上按截断处理（中间夹字节 = 损坏尾巴）。
 *
 * 纯函数，不读文件、不抛异常，可在 Node 里直接单测。
 */
export function splitZstdFrames(input: Buffer | Uint8Array): ZstdFrameScan {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const frames: ZstdFrame[] = []
  if (buffer.length === 0) {
    return { frames, truncated: false, garbageBytes: 0, remainderBytes: 0 }
  }

  let cursor = 0
  while (cursor < buffer.length && !looksLikeFrameStart(buffer, cursor)) cursor += 1
  const garbageBytes = cursor
  if (cursor >= buffer.length) {
    // 整份都不是帧：既不谎报"读到 0 帧是正常的"，也不抛——让上层看 garbageBytes。
    return { frames, truncated: false, garbageBytes, remainderBytes: 0 }
  }

  let truncated = false
  while (cursor < buffer.length) {
    const length = frameByteLength(buffer, cursor)
    if (length === null) {
      truncated = true
      break
    }
    frames.push({ offset: cursor, length, end: cursor + length })
    cursor += length
    if (cursor < buffer.length && !looksLikeFrameStart(buffer, cursor)) {
      truncated = true
      break
    }
  }
  return { frames, truncated, garbageBytes, remainderBytes: buffer.length - cursor }
}

/** 默认会话根目录：`<.dsh>/sessions`（`homeDir` 给定时是 `<homeDir>/.dsh/sessions`，测试靠它隔离）。 */
export function resolveSessionsRoot(options: { sessionsRoot?: string; homeDir?: string } = {}): string {
  if (options.sessionsRoot !== undefined && options.sessionsRoot.trim() !== '') {
    return path.resolve(options.sessionsRoot)
  }
  return path.join(dshHome(options.homeDir), 'sessions')
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    // 目录不存在 / 无权限：按"没有会话"处理（调用方拿 0，不拿异常）。
    return []
  }
}

/**
 * 扫两层：`<root>/<slug>/<sessionId>/session.v4.jsonl.zstd`。
 *
 * 只认规范文件名（RSI §4.1）。按 mtime **降序**返回，让 `limit` 优先导出最近的会话。
 * 任何读目录/stat 失败都被吞掉：一个坏目录不该让整次导出失败。
 */
export async function listLocalSessions(
  options: { sessionsRoot?: string; homeDir?: string } = {},
): Promise<LocalSessionInfo[]> {
  const root = resolveSessionsRoot(options)
  const sessions: LocalSessionInfo[] = []
  for (const slug of await listDirectories(root)) {
    const slugDir = path.join(root, slug)
    for (const sessionId of await listDirectories(slugDir)) {
      const file = path.join(slugDir, sessionId, SESSION_FILE_NAME)
      try {
        const info = await stat(file)
        if (!info.isFile()) continue
        sessions.push({ sessionId, slug, file, bytes: info.size, mtime: info.mtimeMs })
      } catch {
        // 没有 session.v4.jsonl.zstd 的目录（半截迁移、临时目录）直接跳过。
      }
    }
  }
  sessions.sort((left, right) => right.mtime - left.mtime)
  return sessions
}

/* -------------------------------------------------------------------------- */
/* 行分类：纯逻辑，可直接单测                                                    */
/* -------------------------------------------------------------------------- */

/** 坏行行号最多保留多少个（病态文件不该把结果撑爆）。 */
const MAX_BAD_LINE_NUMBERS = 20

/**
 * 把明文行分成 header / 事件 / 坏行。**不抛**：坏行只计数。
 *
 * 规则：
 *   - 空行（含纯空白）跳过，不算坏行；
 *   - 不是合法 JSON、不是 JSON 对象、或 `type` 不是非空字符串 → 坏行；
 *   - 第一条 `type === 'session'` → header；之后再出现 `session` 行直接忽略（不污染事件流）。
 */
export function classifyEvents(lines: string[]): ClassifiedEvents {
  const result: ClassifiedEvents = {
    header: null,
    headerLine: -1,
    events: [],
    badLines: 0,
    badLineNumbers: [],
    types: {},
  }
  const list = Array.isArray(lines) ? lines : []
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const lineNumber = index + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      result.badLines += 1
      if (result.badLineNumbers.length < MAX_BAD_LINE_NUMBERS) result.badLineNumbers.push(lineNumber)
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      result.badLines += 1
      if (result.badLineNumbers.length < MAX_BAD_LINE_NUMBERS) result.badLineNumbers.push(lineNumber)
      continue
    }
    const record = parsed as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : ''
    if (type === '') {
      result.badLines += 1
      if (result.badLineNumbers.length < MAX_BAD_LINE_NUMBERS) result.badLineNumbers.push(lineNumber)
      continue
    }
    if (type === 'session') {
      if (result.header === null) {
        result.header = record as SessionHeader
        result.headerLine = lineNumber
      }
      continue
    }
    result.events.push(record)
    result.types[type] = (result.types[type] ?? 0) + 1
  }
  return result
}

/**
 * 从事件 `data.content` 里抽纯文本（RSI §3.2：content 是 `string` 或内容块数组）。
 * 只取 `type:'text'` 的块，其余（图片/工具块）忽略——导出不负责渲染，只管标题降级。
 */
export function eventText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

function dataOf(event: SessionEvent): Record<string, unknown> {
  const data = event.data
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
}

/** 最后一条 `session/title` 的标题（`docs/CHAT-SYNC.md` §2.1：title 来自最后一条）。 */
export function latestTitleOf(events: SessionEvent[]): string {
  let title = ''
  for (const event of events) {
    if (event.type !== 'session/title') continue
    const value = dataOf(event).title
    if (typeof value === 'string' && value.trim() !== '') title = value.trim()
  }
  return title
}

/** 首条 `user/message` 的纯文本（未截断；标题降级由调用方切 40 字）。 */
export function firstUserTextOf(events: SessionEvent[]): string {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const text = eventText(dataOf(event).content).replace(/\s+/g, ' ').trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * 最后使用的 `provider/model`（RSI §3.1：header 里没有 model，路由在 `request/header` / `request/context`）。
 * 解不出来返回空串（调用方据此**省略** `meta.model`，而不是写个假值）。
 */
export function modelOf(events: SessionEvent[]): string {
  let model = ''
  for (const event of events) {
    const data = dataOf(event)
    if (event.type === 'request/header') {
      const header = data.header
      if (header === null || typeof header !== 'object') continue
      const config = (header as Record<string, unknown>).config
      if (config === null || typeof config !== 'object') continue
      const record = config as Record<string, unknown>
      const provider = typeof record.provider === 'string' ? record.provider : ''
      const name = typeof record.model === 'string' ? record.model : ''
      if (name !== '') model = provider === '' ? name : `${provider}/${name}`
      continue
    }
    if (event.type === 'request/context') {
      const provider = typeof data.provider === 'string' ? data.provider : ''
      const name = typeof data.model === 'string' ? data.model : ''
      if (name !== '') model = provider === '' ? name : `${provider}/${name}`
    }
  }
  return model
}

/** user + assistant 消息数（`meta.messageCount`）。 */
export function countMessages(events: SessionEvent[]): { user: number; assistant: number } {
  let user = 0
  let assistant = 0
  for (const event of events) {
    if (event.type === 'user/message') user += 1
    else if (event.type === 'assistant/message') assistant += 1
  }
  return { user, assistant }
}

/* -------------------------------------------------------------------------- */
/* 读一个会话文件                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 解帧 + 分类。
 *
 * - 帧**逐个** `zstdDecompressSync`，任一阵解压失败就停在它之前（`truncated:true`），不抛；
 * - 解码文本按 `\n` 切行，末尾换行不算空行；
 * - 末行**没有**换行（尾撕裂）→ `truncated:true`（`docs/CHAT-SYNC.md` §2.3：半行拒绝上传）；
 * - `rawJsonl` 统一成 LF 结尾，供 `sha256` 与上传使用。
 */
export async function readSessionEvents(file: string): Promise<SessionReadResult> {
  const buffer = await readFile(file)
  const scan = splitZstdFrames(buffer)
  const chunks: Buffer[] = []
  let frameCount = 0
  let truncated = scan.truncated

  for (const frame of scan.frames) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(frame.offset, frame.end)))
      frameCount += 1
    } catch {
      // 帧头完整但帧体损坏（bit flip）：已解出的前缀仍然可用。
      truncated = true
      break
    }
  }

  const decoded = Buffer.concat(chunks).toString('utf8')
  const tornTail = decoded.length > 0 && !decoded.endsWith('\n')
  const lines = decoded.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const classified = classifyEvents(lines)
  const rawJsonl = lines.length === 0 ? '' : `${lines.join('\n')}\n`

  return {
    header: classified.header,
    events: classified.events,
    rawJsonl,
    lines,
    badLines: classified.badLines,
    badLineNumbers: classified.badLineNumbers,
    truncated: truncated || tornTail,
    frameCount,
  }
}
