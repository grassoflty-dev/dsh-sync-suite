/**
 * P1 会话导出（`src/chats/**`）的单测。
 *
 * 全部使用临时目录 + **现造的 zstd 帧**（`node:zlib` 的 `zstdCompressSync`，带 checksum），
 * 绝不读写真实的 `~/.dsh`。仓库侧用「假 GitRepo」注入，不跑 git、不联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import {
  buildChatExport,
  ChatExportError,
  classifyEvents,
  exportChatsToRepo,
  frameByteLength,
  listLocalSessions,
  normalizeLimit,
  readChatExportStatus,
  readSessionEvents,
  redactSecrets,
  sanitizeChatReason,
  scanForLeaks,
  scrubAbsolutePaths,
  splitZstdFrames,
  uploadChats,
  workspaceNameOf,
} from '../dist/chats/index.js'
import { createRpcService } from '../dist/rpc.js'

/* -------------------------------------------------------------------------- */
/* 造数据                                                                      */
/* -------------------------------------------------------------------------- */

/** 压一帧（带 checksum，与 DSH 的 `ZSTD_c_checksumFlag` 一致）。 */
function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

const HEADER = {
  type: 'session',
  version: 4,
  id: 'sess-1',
  createdAt: 1700000000000,
  cwd: 'C:\\Users\\gw\\proj',
  isSeeded: false,
  delegationDepth: 0,
}

const headerLine = (extra = {}) => JSON.stringify({ ...HEADER, ...extra })
const userLine = (text, seq = 1) =>
  JSON.stringify({
    type: 'user/message',
    seq,
    time: 1700000001000,
    data: { role: 'user', content: [{ type: 'text', text }] },
    surfaceOp: 'append',
  })
const assistantLine = (seq = 2) =>
  JSON.stringify({
    type: 'assistant/message',
    seq,
    time: 1700000002000,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }] } },
    surfaceOp: 'append',
  })
const titleLine = (title, seq = 3) =>
  JSON.stringify({ type: 'session/title', seq, time: 1700000003000, data: { title, source: { kind: 'fallback' } }, surfaceOp: 'append' })
const requestHeaderLine = (provider, model, seq = 4) =>
  JSON.stringify({
    type: 'request/header',
    seq,
    time: 1700000004000,
    data: { header: { config: { provider, model, reasoningEffort: 'high' } }, reason: 'initial' },
  })

async function tempRoot(t, prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  return root
}

/** 写一个会话文件：chunks 每项是"一帧的明文"。 */
async function writeSessionFile(root, sessionId, chunks, slug = '--C-Users-gw-proj--') {
  const dir = path.join(root, slug, sessionId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  await writeFile(file, Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : frame(chunk)))))
  return { file, dir }
}

const infoOf = (sessionId, file, mtime = 1700000010000) => ({
  sessionId,
  slug: '--C-Users-gw-proj--',
  file,
  bytes: 1,
  mtime,
})

/** 假 GitRepo：只记录调用，不碰磁盘（除了 dir 下的文件写入）。 */
function fakeRepo(dir) {
  const calls = { commits: [], pushes: 0, ensured: 0 }
  return {
    dir,
    calls,
    async ensureWorkTree() {
      calls.ensured += 1
      return { cloned: false }
    },
    async commitAll(message, options) {
      calls.commits.push({ message, options })
      return { commit: `sha-${calls.commits.length}`, files: [] }
    },
    async pushWithRebase() {
      calls.pushes += 1
      return { pushed: true, rebased: false }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* 1. splitZstdFrames                                                          */
/* -------------------------------------------------------------------------- */

test('splitZstdFrames：空 buffer', () => {
  const scan = splitZstdFrames(Buffer.alloc(0))
  assert.equal(scan.frames.length, 0)
  assert.equal(scan.truncated, false)
  assert.equal(scan.garbageBytes, 0)
  assert.equal(scan.remainderBytes, 0)
})

test('splitZstdFrames：单帧', () => {
  const one = frame(`${headerLine()}\n`)
  const scan = splitZstdFrames(one)
  assert.equal(scan.frames.length, 1)
  assert.equal(scan.frames[0].offset, 0)
  assert.equal(scan.frames[0].length, one.length)
  assert.equal(scan.frames[0].end, one.length)
  assert.equal(scan.truncated, false)
  assert.equal(scan.remainderBytes, 0)
  assert.equal(frameByteLength(one, 0), one.length)
})

test('splitZstdFrames：双帧（第二帧从第一帧末尾开始）', () => {
  const first = frame(`${headerLine()}\n`)
  const second = frame(`${userLine('hi')}\n`)
  const scan = splitZstdFrames(Buffer.concat([first, second]))
  assert.equal(scan.frames.length, 2)
  assert.equal(scan.frames[0].length, first.length)
  assert.equal(scan.frames[1].offset, first.length)
  assert.equal(scan.frames[1].length, second.length)
  assert.equal(scan.frames[1].end, first.length + second.length)
  assert.equal(scan.truncated, false)
  assert.equal(scan.remainderBytes, 0)
})

test('splitZstdFrames：截断帧（最后一帧少了尾巴）', () => {
  const first = frame(`${headerLine()}\n`)
  const second = frame(`${userLine('hi')}\n`)
  const cut = Buffer.concat([first, second]).subarray(0, first.length + second.length - 5)
  const scan = splitZstdFrames(cut)
  assert.equal(scan.frames.length, 1)
  assert.equal(scan.frames[0].length, first.length)
  assert.equal(scan.truncated, true)
  assert.equal(scan.remainderBytes, second.length - 5)
})

test('splitZstdFrames：帧头都不完整（半帧）', () => {
  const half = frame(`${headerLine()}\n`).subarray(0, 6)
  const scan = splitZstdFrames(half)
  assert.equal(scan.frames.length, 0)
  assert.equal(scan.truncated, true)
  assert.equal(scan.remainderBytes, 6)
})

test('splitZstdFrames：magic 之前的垃圾字节被跳过并计数', () => {
  const one = frame(`${headerLine()}\n`)
  const scan = splitZstdFrames(Buffer.concat([Buffer.from('garbage!'), one]))
  assert.equal(scan.garbageBytes, 8)
  assert.equal(scan.frames.length, 1)
  assert.equal(scan.frames[0].offset, 8)
  assert.equal(scan.frames[0].length, one.length)
  assert.equal(scan.truncated, false)
})

test('splitZstdFrames：整份都不是帧', () => {
  const scan = splitZstdFrames(Buffer.from('no zstd here'))
  assert.equal(scan.frames.length, 0)
  assert.equal(scan.garbageBytes, 12)
  assert.equal(scan.truncated, false)
})

/* -------------------------------------------------------------------------- */
/* 2. readSessionEvents                                                        */
/* -------------------------------------------------------------------------- */

test('readSessionEvents：header 提取 + 事件 + 明文行序', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-read-')
  const { file } = await writeSessionFile(root, 'sess-1', [`${headerLine()}\n`, `${userLine('hi')}\n${assistantLine()}\n`])
  const read = await readSessionEvents(file)
  assert.equal(read.header.type, 'session')
  assert.equal(read.header.id, 'sess-1')
  assert.equal(read.events.length, 2)
  assert.equal(read.badLines, 0)
  assert.equal(read.frameCount, 2)
  assert.equal(read.truncated, false)
  assert.ok(read.rawJsonl.endsWith('\n'))
  assert.equal(read.rawJsonl.split('\n').filter((line) => line !== '').length, 3)
  assert.ok(read.rawJsonl.startsWith('{"type":"session"'))
})

test('readSessionEvents：坏行只计数，不抛', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-bad-')
  const { file } = await writeSessionFile(root, 'sess-bad', [`${headerLine()}\n`, '{not json\n', `${userLine('ok')}\n`])
  const read = await readSessionEvents(file)
  assert.equal(read.badLines, 1)
  assert.deepEqual(read.badLineNumbers, [2])
  assert.equal(read.events.length, 1)
  assert.equal(read.truncated, false)
})

test('readSessionEvents：截断帧 → truncated:true，前缀仍可用', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-torn-')
  const second = frame(`${userLine('lost')}\n`)
  const { file } = await writeSessionFile(root, 'sess-torn', [frame(`${headerLine()}\n`), second.subarray(0, 8)])
  const read = await readSessionEvents(file)
  assert.equal(read.truncated, true)
  assert.equal(read.frameCount, 1)
  assert.ok(read.header !== null)
  assert.equal(read.events.length, 0)
})

test('readSessionEvents：末行没有换行视为尾撕裂', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-tail-')
  const { file } = await writeSessionFile(root, 'sess-tail', [`${headerLine()}\n${userLine('x')}`])
  const read = await readSessionEvents(file)
  assert.equal(read.truncated, true)
  assert.equal(read.badLines, 0)
  assert.equal(read.events.length, 1)
})

test('classifyEvents：第一条 session 是 header，后续 session 行不进事件流', () => {
  const classified = classifyEvents([headerLine(), headerLine({ id: 'other' }), userLine('x'), '', '   '])
  assert.equal(classified.header.id, 'sess-1')
  assert.equal(classified.headerLine, 1)
  assert.equal(classified.events.length, 1)
  assert.equal(classified.badLines, 0)
})

/* -------------------------------------------------------------------------- */
/* 3. buildChatExport                                                          */
/* -------------------------------------------------------------------------- */

function makeSession(extra = {}) {
  const lines = [
    headerLine(),
    userLine('hello world from the first message that is definitely longer than forty characters'),
    assistantLine(2),
    titleLine('真正的标题'),
    requestHeaderLine('deepseek', 'deepseek-chat', 5),
  ]
  return {
    header: HEADER,
    events: lines.slice(1).map((line) => JSON.parse(line)),
    rawJsonl: `${lines.join('\n')}\n`,
    badLines: 0,
    truncated: false,
    ...extra,
  }
}

test('buildChatExport：meta 字段齐全且 sha256 与 jsonl 一致', () => {
  const info = infoOf('sess-1', '/tmp/whatever/session.v4.jsonl.zstd')
  const built = buildChatExport(info, makeSession(), { deviceId: 'pc-a', now: new Date('2026-11-18T05:00:00Z') })
  assert.equal(built.dir, 'chats/sess-1')
  assert.equal(built.id, 'sess-1')
  assert.equal(built.meta.schemaVersion, 1)
  assert.equal(built.meta.sessionId, 'sess-1')
  assert.equal(built.meta.title, '真正的标题')
  assert.equal(built.meta.createdAt, '2023-11-14T22:13:20.000Z')
  assert.equal(built.meta.updatedAt, '2026-11-18T05:00:00.000Z')
  assert.equal(built.meta.model, 'deepseek/deepseek-chat')
  assert.equal(built.meta.messageCount, 2)
  assert.equal(built.meta.deviceId, 'pc-a')
  assert.equal(built.meta.workspaceName, 'proj')
  assert.equal(built.meta.lease, null)
  assert.equal(built.meta.sha256, createHash('sha256').update(built.jsonl, 'utf8').digest('hex'))
  assert.equal(built.meta.sha256.length, 64)
  assert.ok(built.jsonl.endsWith('\n'))
})

test('buildChatExport：绝对路径被替换（header.cwd），且 meta 不含路径', () => {
  const info = infoOf('sess-1', '/tmp/x/session.v4.jsonl.zstd')
  const built = buildChatExport(info, makeSession(), { deviceId: 'pc-a', now: new Date('2026-11-18T05:00:00Z') })
  assert.ok(built.jsonl.includes('<redacted-path>'))
  assert.equal(built.jsonl.includes('C:\\Users'), false)
  assert.equal(built.jsonl.includes('gw'), false)
  assert.ok(built.meta.redactions >= 1)
  assert.equal(built.meta.workspaceName, 'proj')
  assert.equal(JSON.stringify(built.meta).includes('Users'), false)
  assert.equal(JSON.stringify(built.meta).includes('C:'), false)
})

test('buildChatExport：redactSecrets 生效（sk- 与 Bearer）', () => {
  const info = infoOf('sess-1', '/tmp/x/session.v4.jsonl.zstd')
  const lines = [
    headerLine(),
    userLine('my key is sk-abcdefgh12345678 and header Bearer abcdefghijklmnop'),
    assistantLine(2),
  ]
  const session = { header: HEADER, events: [JSON.parse(lines[1]), JSON.parse(lines[2])], rawJsonl: `${lines.join('\n')}\n` }
  const built = buildChatExport(info, session, { deviceId: 'pc-a', now: new Date('2026-11-18T05:00:00Z') })
  assert.equal(built.jsonl.includes('sk-abcdefgh12345678'), false)
  // 无捕获组的规则（`sk-…` / `ghp_…`）整体替换成 `***`，与 App 侧 redactSecrets 行为一致。
  assert.ok(built.jsonl.includes('***'))
  assert.equal(built.jsonl.includes('Bearer abcdefghijklmnop'), false)
  assert.ok(built.jsonl.includes('Bearer ***'))
  assert.deepEqual(scanForLeaks(built.jsonl), [])
})

test('buildChatExport：标题降级到首条 user 文本前 40 字', () => {
  const info = infoOf('sess-1', '/tmp/x/s.v4.jsonl.zstd')
  const long = 'a'.repeat(60)
  const lines = [headerLine({ title: undefined }), userLine(long), assistantLine(2)]
  const session = { header: { ...HEADER, title: undefined }, events: [JSON.parse(lines[1]), JSON.parse(lines[2])], rawJsonl: `${lines.join('\n')}\n` }
  const built = buildChatExport(info, session, { deviceId: 'pc-a', now: new Date('2026-11-18T05:00:00Z') })
  assert.equal(built.meta.title, 'a'.repeat(40))
  assert.equal(built.meta.model, undefined)
})

test('buildChatExport：坏行 → fail-closed（bad-jsonl）', () => {
  const info = infoOf('sess-1', '/tmp/x/s.v4.jsonl.zstd')
  assert.throws(
    () => buildChatExport(info, makeSession({ badLines: 2 }), { deviceId: 'pc-a' }),
    (error) => error instanceof ChatExportError && error.code === 'bad-jsonl',
  )
})

test('buildChatExport：截断 → fail-closed（truncated-session）', () => {
  const info = infoOf('sess-1', '/tmp/x/s.v4.jsonl.zstd')
  assert.throws(
    () => buildChatExport(info, makeSession({ truncated: true }), { deviceId: 'pc-a' }),
    (error) => error instanceof ChatExportError && error.code === 'truncated-session',
  )
})

test('buildChatExport：缺 header / 空会话 / 不安全 id 都 fail-closed', () => {
  const info = infoOf('sess-1', '/tmp/x/s.v4.jsonl.zstd')
  assert.throws(
    () => buildChatExport(info, makeSession({ header: null }), { deviceId: 'pc-a' }),
    (error) => error.code === 'missing-header',
  )
  assert.throws(
    () => buildChatExport(info, makeSession({ rawJsonl: '' }), { deviceId: 'pc-a' }),
    (error) => error.code === 'empty-session',
  )
  const evil = { ...makeSession(), header: { ...HEADER, id: '../escape' } }
  assert.throws(
    () => buildChatExport(infoOf('../escape', '/tmp/x/s.v4.jsonl.zstd'), evil, { deviceId: 'pc-a' }),
    (error) => error.code === 'bad-session-id',
  )
})

test('buildChatExport：L2 拦不住的路径（藏在 JSON key 里）由 L3 静态扫描 fail-closed', () => {
  // scrubAbsolutePathsDeep 只处理 **string 值**，key 不处理；
  // 于是 `C:\Users\gw` 作为 key 会原样进文本，必须由写盘前的 L3 扫描拒绝。
  const info = infoOf('sess-1', '/tmp/x/s.v4.jsonl.zstd')
  const weird = JSON.stringify({ type: 'weird', seq: 9, data: { 'C:\\Users\\gw': 1 } })
  const session = { header: HEADER, events: [JSON.parse(weird)], rawJsonl: `${headerLine()}\n${weird}\n` }
  assert.throws(
    () => buildChatExport(info, session, { deviceId: 'pc-a' }),
    (error) => error instanceof ChatExportError && error.code === 'path-leak',
  )
})

test('workspaceNameOf / scrubAbsolutePaths / sanitizeChatReason 三个小工具', () => {
  assert.equal(workspaceNameOf('C:\\Users\\gw\\proj'), 'proj')
  assert.equal(workspaceNameOf('/home/gw/proj/'), 'proj')
  assert.equal(workspaceNameOf(''), '')
  assert.equal(scrubAbsolutePaths('open C:\\Users\\gw\\a.txt now').text, 'open <redacted-path> now')
  assert.equal(scrubAbsolutePaths('see https://example.com/x').count, 0)
  assert.ok(scrubAbsolutePaths('/Users/gw/x').text.includes('<redacted-path>'))
  assert.equal(redactSecrets('token=abc123'), 'token=***')
  assert.ok(sanitizeChatReason(new Error('open C:\\Users\\gw\\x failed')).includes('<redacted-path>'))
  assert.equal(sanitizeChatReason(new Error('open C:\\Users\\gw\\x failed')).includes('gw'), false)
})

test('scanForLeaks 命中规则集', () => {
  assert.deepEqual(scanForLeaks('{"a":"C:\\\\Users\\\\gw"}'), ['windows-user-path'])
  assert.ok(scanForLeaks('{"a":"/home/gw/x"}').includes('user-home-path'))
  assert.ok(scanForLeaks('{"a":"Bearer abcdefghijklmnop"}').includes('bearer-credential'))
  assert.ok(scanForLeaks('{"a":"sk-abcdefgh12345678"}').includes('api-key'))
  assert.deepEqual(scanForLeaks('{"a":"hello"}'), [])
})

/* -------------------------------------------------------------------------- */
/* 4. uploadChats                                                              */
/* -------------------------------------------------------------------------- */

test('uploadChats：文件落位 + index 只追加 + 每个会话一个 commit', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-up-')
  const repoDir = path.join(root, 'repo')
  await mkdir(path.join(repoDir, 'chats'), { recursive: true })
  const seed = '{"id":"seed","title":"旧行","updatedAt":"2026-01-01T00:00:00.000Z","messageCount":1,"sha256":"x"}'
  await writeFile(path.join(repoDir, 'chats', 'index.jsonl'), seed, 'utf8')

  const info = infoOf('sess-1', path.join(root, 's.v4.jsonl.zstd'))
  const built = buildChatExport(info, makeSession(), { deviceId: 'pc-a', now: new Date('2026-11-18T05:00:00Z') })
  const repo = fakeRepo(repoDir)
  const result = await uploadChats(repo, [built])

  assert.equal(result.ok, true)
  assert.equal(result.pushed, true)
  assert.deepEqual(result.sessionIds, ['sess-1'])
  assert.equal(result.commits.length, 1)
  assert.equal(repo.calls.commits[0].message, 'chats: export sess-1 (2 msgs)')
  assert.equal(repo.calls.commits[0].options.onlyPath, 'chats')
  assert.equal(repo.calls.pushes, 1)

  const sessionFile = path.join(repoDir, 'chats', 'sess-1', 'session.jsonl')
  const metaFile = path.join(repoDir, 'chats', 'sess-1', 'meta.json')
  assert.ok(existsSync(sessionFile))
  assert.ok(existsSync(metaFile))
  assert.equal(await readFile(sessionFile, 'utf8'), built.jsonl)
  const meta = JSON.parse(await readFile(metaFile, 'utf8'))
  assert.equal(meta.sessionId, 'sess-1')
  assert.equal(meta.lease, null)

  const indexPath = path.join(repoDir, 'chats', 'index.jsonl')
  const text = await readFile(indexPath, 'utf8')
  const lines = text.split('\n').filter((line) => line !== '')
  assert.equal(lines.length, 2)
  assert.equal(text.slice(0, seed.length), seed, '首行字节必须完全不变')
  const appended = JSON.parse(lines[1])
  assert.deepEqual(Object.keys(appended).sort(), ['id', 'messageCount', 'sha256', 'title', 'updatedAt'])
  assert.equal(appended.id, 'sess-1')
  assert.equal(appended.sha256, built.meta.sha256)
})

test('uploadChats：同 id 二次导出覆盖 session.jsonl，但 index 追加新行', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-up2-')
  const repoDir = path.join(root, 'repo')
  await mkdir(repoDir, { recursive: true })
  const info = infoOf('sess-1', path.join(root, 's.v4.jsonl.zstd'))
  const first = buildChatExport(info, makeSession(), { deviceId: 'pc-a', now: new Date('2026-11-18T05:00:00Z') })
  // 第二次：多加一条事件，内容与 sha 都不同。
  const more = makeSession()
  const extraLine = userLine('second batch', 9)
  more.rawJsonl = `${more.rawJsonl}${extraLine}\n`
  more.events = [...more.events, JSON.parse(extraLine)]
  const second = buildChatExport(info, more, { deviceId: 'pc-b', now: new Date('2026-11-18T06:00:00Z') })
  assert.notEqual(first.meta.sha256, second.meta.sha256)

  const repo = fakeRepo(repoDir)
  await uploadChats(repo, [first], { push: false })
  const indexOnce = await readFile(path.join(repoDir, 'chats', 'index.jsonl'), 'utf8')
  const firstLine = indexOnce.split('\n')[0]

  await uploadChats(repo, [second], { push: false })
  const text = await readFile(path.join(repoDir, 'chats', 'index.jsonl'), 'utf8')
  const lines = text.split('\n').filter((line) => line !== '')
  assert.equal(lines.length, 2)
  assert.equal(lines[0], firstLine, '第一次写入的行必须原样保留')
  assert.equal(JSON.parse(lines[1]).sha256, second.meta.sha256)

  const onDisk = await readFile(path.join(repoDir, 'chats', 'sess-1', 'session.jsonl'), 'utf8')
  assert.equal(onDisk, second.jsonl, '同 id 覆盖，索引仍追加')
  const meta = JSON.parse(await readFile(path.join(repoDir, 'chats', 'sess-1', 'meta.json'), 'utf8'))
  assert.equal(meta.deviceId, 'pc-b')
  assert.equal(meta.createdAt, first.meta.createdAt, 'createdAt 首次上传后不变')
})

test('uploadChats：push 失败 → ok:false，本地文件仍在（可重试）', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-push-')
  const repoDir = path.join(root, 'repo')
  await mkdir(repoDir, { recursive: true })
  const info = infoOf('sess-1', path.join(root, 's.v4.jsonl.zstd'))
  const built = buildChatExport(info, makeSession(), { deviceId: 'pc-a', now: new Date('2026-11-18T05:00:00Z') })

  const repo = fakeRepo(repoDir)
  repo.pushWithRebase = async () => {
    throw new Error('fatal: unable to access https://example.com/x.git: network is unreachable')
  }
  const result = await uploadChats(repo, [built])
  assert.equal(result.ok, false)
  assert.ok(result.reason.startsWith('push-failed'))
  assert.equal(result.pushed, false)
  assert.equal(result.sessionIds.length, 1)
  assert.ok(existsSync(path.join(repoDir, 'chats', 'sess-1', 'session.jsonl')), 'push 失败不得丢本地文件')
  assert.ok(existsSync(path.join(repoDir, 'chats', 'index.jsonl')))
})

test('uploadChats：push 错误里的绝对路径被脱敏', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-push2-')
  const repoDir = path.join(root, 'repo')
  await mkdir(repoDir, { recursive: true })
  const info = infoOf('sess-1', path.join(root, 's.v4.jsonl.zstd'))
  const built = buildChatExport(info, makeSession(), { deviceId: 'pc-a' })
  const repo = fakeRepo(repoDir)
  repo.pushWithRebase = async () => {
    throw new Error('fatal: could not open C:\\Users\\gw\\repo\\.git\\config')
  }
  const result = await uploadChats(repo, [built])
  assert.equal(result.ok, false)
  assert.equal(result.reason.includes('gw'), false)
  assert.ok(result.reason.includes('<redacted-path>'))
})

test('uploadChats：ensureWorkTree 失败时一个字节都不写', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-noclone-')
  const repoDir = path.join(root, 'repo')
  await mkdir(repoDir, { recursive: true })
  const info = infoOf('sess-1', path.join(root, 's.v4.jsonl.zstd'))
  const built = buildChatExport(info, makeSession(), { deviceId: 'pc-a' })
  const repo = fakeRepo(repoDir)
  repo.ensureWorkTree = async () => {
    throw new Error('E_GIT: clone failed')
  }
  const result = await uploadChats(repo, [built])
  assert.equal(result.ok, false)
  assert.ok(result.reason.startsWith('work-tree-unavailable'))
  assert.equal(existsSync(path.join(repoDir, 'chats')), false)
  assert.equal(repo.calls.commits.length, 0)
})

/* -------------------------------------------------------------------------- */
/* 5. 编排层：listLocalSessions / status / exportChatsToRepo                     */
/* -------------------------------------------------------------------------- */

test('listLocalSessions：扫两层并按 mtime 降序', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-list-')
  await writeSessionFile(root, 'sess-old', [`${headerLine({ id: 'sess-old' })}\n`], '--slug-a--')
  await writeSessionFile(root, 'sess-new', [`${headerLine({ id: 'sess-new' })}\n`], '--slug-b--')
  // 造一个没有规范文件名的目录，必须被跳过。
  await mkdir(path.join(root, '--slug-a--', 'broken'), { recursive: true })
  const list = await listLocalSessions({ sessionsRoot: root })
  assert.equal(list.length, 2)
  assert.ok(list[0].mtime >= list[1].mtime)
  assert.ok(list.every((item) => item.sessionId.startsWith('sess-')))
  assert.ok(list.every((item) => item.slug.startsWith('--slug-')))
  assert.equal(list[0].bytes > 0, true)
})

test('readChatExportStatus：exported/pending 来自 index.jsonl', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-status-')
  const sessionsRoot = path.join(root, 'sessions')
  const workDir = path.join(root, 'work')
  await writeSessionFile(sessionsRoot, 'sess-1', [`${headerLine({ id: 'sess-1' })}\n`])
  await writeSessionFile(sessionsRoot, 'sess-2', [`${headerLine({ id: 'sess-2' })}\n`])
  await mkdir(path.join(workDir, 'chats'), { recursive: true })
  await writeFile(
    path.join(workDir, 'chats', 'index.jsonl'),
    `${JSON.stringify({ id: 'sess-1', title: 't', updatedAt: '2026-11-18T05:00:00.000Z', messageCount: 2, sha256: 'abc' })}\n`,
    'utf8',
  )
  const status = await readChatExportStatus({ workDir, sessionsRoot })
  assert.equal(status.localSessions, 2)
  assert.equal(status.exported, 1)
  assert.equal(status.pending, 1)
  assert.equal(status.lastExportAt, '2026-11-18T05:00:00.000Z')

  // 没有工作副本时不许抛：按 0 已导出处理。
  const bare = await readChatExportStatus({ workDir: path.join(root, 'nothing'), sessionsRoot })
  assert.equal(bare.exported, 0)
  assert.equal(bare.pending, 2)
})

test('exportChatsToRepo：单个失败不拖垮其它会话', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-orch-')
  const sessionsRoot = path.join(root, 'sessions')
  const repoDir = path.join(root, 'repo')
  await mkdir(repoDir, { recursive: true })
  await writeSessionFile(sessionsRoot, 'sess-ok', [`${headerLine({ id: 'sess-ok' })}\n`, `${userLine('hi')}\n`])
  // 坏行会话：必须 fail-closed 且只记原因。
  await writeSessionFile(sessionsRoot, 'sess-bad', [`${headerLine({ id: 'sess-bad' })}\n`, 'oops\n'])

  const repo = fakeRepo(repoDir)
  const outcome = await exportChatsToRepo({ repo, deviceId: 'pc-a', sessionsRoot, limit: 10 })
  assert.equal(outcome.summary.total, 2)
  assert.equal(outcome.summary.ok, 1)
  assert.equal(outcome.summary.failed, 1)
  assert.equal(outcome.pushed, true)
  const bad = outcome.results.find((item) => item.id === 'sess-bad')
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'bad-jsonl')
  assert.equal(outcome.reason, undefined)
})

test('exportChatsToRepo：指定不存在的 id → not-found；limit 归一', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-one-')
  const sessionsRoot = path.join(root, 'sessions')
  const repoDir = path.join(root, 'repo')
  await mkdir(repoDir, { recursive: true })
  const repo = fakeRepo(repoDir)
  const outcome = await exportChatsToRepo({ repo, deviceId: 'pc-a', sessionsRoot, sessionIds: ['nope'] })
  assert.equal(outcome.summary.total, 1)
  assert.equal(outcome.results[0].reason, 'not-found')
  assert.equal(outcome.pushed, false)
  assert.equal(normalizeLimit(undefined), 50)
  assert.equal(normalizeLimit(0), 50)
  assert.equal(normalizeLimit(7), 7)
  assert.equal(normalizeLimit(10000), 200)
})

/* -------------------------------------------------------------------------- */
/* 6. RPC 层：三个新 action（不联网、不碰真实 ~/.dsh）                            */
/* -------------------------------------------------------------------------- */

test('RPC chatExportStatus：读本机会话目录，未配置仓库也不报错', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-rpc-')
  const homeDir = path.join(root, 'home')
  const sessionsRoot = path.join(homeDir, '.dsh', 'sessions')
  await writeSessionFile(sessionsRoot, 'sess-rpc', [`${headerLine({ id: 'sess-rpc' })}\n`])
  const service = createRpcService({ homeDir, profileDir: path.join(root, 'profile'), dshVersion: 'test' })
  t.after(async () => {
    await service.dispose()
  })
  const status = await service.handleRpc({ action: 'chatExportStatus' })
  assert.equal(status.ok, true)
  assert.equal(status.data.localSessions, 1)
  assert.equal(status.data.exported, 0)
  assert.equal(status.data.pending, 1)
  assert.equal(status.data.lastExportAt, '')
})

test('RPC chatExportAll / chatExportOne：未配置仓库 → E_VALIDATION 中文原因', async (t) => {
  const root = await tempRoot(t, 'gcs-chat-rpc2-')
  const service = createRpcService({ homeDir: path.join(root, 'home'), profileDir: path.join(root, 'profile'), dshVersion: 'test' })
  t.after(async () => {
    await service.dispose()
  })
  const all = await service.handleRpc({ action: 'chatExportAll' })
  assert.equal(all.ok, false)
  assert.equal(all.error.code, 'E_VALIDATION')
  assert.equal(all.error.message, '尚未配置仓库地址')

  const one = await service.handleRpc({ action: 'chatExportOne', sessionId: '' })
  assert.equal(one.ok, false)
  assert.equal(one.error.code, 'E_VALIDATION')
})
