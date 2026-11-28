/**
 * mod-chat-hide：导出器三层抑制的回归测试（设计 §12.2 / §11.4 的 A3）。
 *
 * 关键点：源 zstd 会话**一直在**；只在 index 追加隐藏行后再次导出，
 * 绝不能产生新普通行、不能返回 ok:true、不能刷新已隐藏会话的载荷字节。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import {
  buildChatExport,
  exportChatsToRepo,
  readChatIndex,
  readHiddenChatIds,
  uploadChats,
} from '../dist/chats/index.js'

const DELETED_AT = 1795000000000

function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

const HEADER = { type: 'session', version: 4, id: 'S', createdAt: 1700000000000, cwd: 'C:\\Users\\gw\\proj' }
const USER = { type: 'user/message', seq: 1, time: 1700000001000, data: { content: 'hi' } }
const RAW = `${JSON.stringify(HEADER)}\n${JSON.stringify(USER)}\n`

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-chat-hide-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => {}) })
  return root
}

/** 源会话留在 sessionsRoot（这是复活风险的根源，测试刻意不清掉它）。 */
async function writeSource(sessionsRoot) {
  const dir = path.join(sessionsRoot, '--slug--', 'S')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  await writeFile(file, frame(RAW))
  return {
    sessionId: 'S', slug: '--slug--', file, bytes: 1, mtime: 1700000010000,
  }
}

function fakeRepo(dir) {
  const calls = { commits: [], pushes: 0 }
  return {
    dir, calls,
    async ensureWorkTree() { return { cloned: false } },
    async commitAll(message, options) {
      calls.commits.push({ message, options })
      return { commit: `sha-${calls.commits.length}`, files: [] }
    },
    async pushWithRebase() { calls.pushes += 1; return { pushed: true, rebased: false } },
  }
}

async function shaOf(file) {
  return createHash('sha256').update(await readFile(file, 'utf8')).digest('hex')
}

/** 造好「已导出一次 + 追加隐藏行」的现场，返回后续断言需要的路径。 */
async function hiddenScene(t) {
  const root = await tempRoot(t)
  const sessionsRoot = path.join(root, 'sessions')
  const repoDir = path.join(root, 'repo')
  await mkdir(path.join(repoDir, 'chats'), { recursive: true })
  const info = await writeSource(sessionsRoot)
  const built = buildChatExport(info, { header: HEADER, events: [USER], rawJsonl: RAW }, {
    deviceId: 'pc-a', now: new Date('2026-11-27T00:00:00.000Z'),
  })
  const repo = fakeRepo(repoDir)
  const seeded = await uploadChats(repo, [built], { push: false })
  assert.equal(seeded.ok, true)
  const indexPath = path.join(repoDir, 'chats', 'index.jsonl')
  const before = await readFile(indexPath, 'utf8')
  await appendFile(indexPath, `${JSON.stringify({ op: 'archive', id: 'S', deletedAt: DELETED_AT })}\n`, 'utf8')
  // "没有新增普通行"的基线必须是**隐藏行写入之后**的索引，不是隐藏前的索引。
  const hiddenText = await readFile(indexPath, 'utf8')
  return { sessionsRoot, repoDir, repo, indexPath, before, hiddenText, info, built }
}

test('HE-01 隐藏后二次导出（源会话仍在）：不复活、不新增普通行、载荷字节不变', async (t) => {
  const s = await hiddenScene(t)
  const payload = path.join(s.repoDir, 'chats', 'S', 'session.jsonl')
  const meta = path.join(s.repoDir, 'chats', 'S', 'meta.json')
  const payloadBefore = await shaOf(payload)
  const metaBefore = await shaOf(meta)

  assert.deepEqual((await readChatIndex(s.repoDir)).entries, [])
  assert.equal((await readHiddenChatIds(s.repoDir)).has('S'), true)

  const outcome = await exportChatsToRepo({
    repo: s.repo, deviceId: 'pc-a', sessionsRoot: s.sessionsRoot, push: false,
  })
  const row = outcome.results.find((item) => item.id === 'S')
  assert.ok(row !== undefined)
  assert.equal(row.ok, false)
  assert.equal(row.reason, 'deleted')

  const after = await readFile(s.indexPath, 'utf8')
  assert.equal(after.startsWith(s.before), true, '旧字节严格保留')
  assert.equal(after, s.hiddenText, '没有新增无意义的重复普通行（隐藏行之后的字节一个都不变）')
  assert.equal(s.repo.calls.commits.length, 1, '本次导出没有产生任何提交')
  assert.equal(await shaOf(payload), payloadBefore)
  assert.equal(await shaOf(meta), metaBefore)
})

test('HE-02 显式 id 导出同样按隐藏集合拒绝（reason=deleted）', async (t) => {
  const s = await hiddenScene(t)
  const outcome = await exportChatsToRepo({
    repo: s.repo, deviceId: 'pc-a', sessionsRoot: s.sessionsRoot, sessionIds: ['S'], push: false,
  })
  assert.equal(outcome.results.length, 1)
  assert.deepEqual(outcome.results[0], { id: 'S', ok: false, reason: 'deleted' })
  assert.equal(await readFile(s.indexPath, 'utf8'), s.hiddenText)
})

test('HE-03 uploadChats 的 TOCTOU 层：构造前复读隐藏集合，跳过且返回 typed 原因', async (t) => {
  const s = await hiddenScene(t)
  const changed = buildChatExport(s.info, {
    header: HEADER,
    events: [USER, { type: 'user/message', seq: 2, time: 1700000002000, data: { content: 'later' } }],
    rawJsonl: `${RAW}${JSON.stringify({ type: 'user/message', seq: 2, time: 1700000002000, data: { content: 'later' } })}\n`,
  }, { deviceId: 'pc-b', now: new Date('2026-11-28T00:00:00.000Z') })
  const result = await uploadChats(s.repo, [changed], { push: false })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'deleted')
  assert.deepEqual(result.sessionIds, [])
  assert.equal(await readFile(s.indexPath, 'utf8'), s.hiddenText)
})

test('HE-04 格式兼容：读取侧遇到未来 unarchive（本模块不产生）能恢复可见，再导出正常', async (t) => {
  const s = await hiddenScene(t)
  const indexPath = s.indexPath
  await appendFile(indexPath, `${JSON.stringify({ op: 'unarchive', id: 'S', ts: DELETED_AT + 1 })}\n`, 'utf8')
  assert.deepEqual((await readChatIndex(s.repoDir)).entries.map((entry) => entry.id), ['S'])
  assert.equal((await readHiddenChatIds(s.repoDir)).has('S'), false)

  const outcome = await exportChatsToRepo({
    repo: s.repo, deviceId: 'pc-a', sessionsRoot: s.sessionsRoot, push: false,
  })
  const row = outcome.results.find((item) => item.id === 'S')
  assert.equal(row.ok, true)
  assert.equal((await readChatIndex(s.repoDir)).entries.length, 1)
})
