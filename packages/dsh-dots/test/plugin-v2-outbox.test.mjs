/**
 * 仓库外 outbox 的真实文件实现测试（M2）：跨「进程重启」持久、attempts 不重置、
 * 排空后文件为 `[]\n`、坏文件 typed 失败。中文注释逐条说明契约 §13 的规则。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { NodeOutboxPort, outboxPathFor } from '../dist/sync/outbox.js'
import { FRESH_SCHEMA_TEXT } from '../dist/timeline/index.js'
import { V2_ERROR, makeIntentId, runV2Cycle } from '../dist/sync/cycle.js'
import { repoHash } from '../dist/engine/paths.js'

const DAY = '2026-11-19'
const TS = `${DAY}T09:30:00+08:00`

function intent(overrides = {}) {
  return {
    intentId: makeIntentId(DAY, 'a1', TS, 'upsert'), op: 'upsert', date: DAY, id: 'a1', ts: TS,
    line: JSON.stringify({
      id: 'a1', ts: TS, title: 't', body: '', author: '我', done: false,
      media: [], ai_processed: false, opened_at: TS,
    }),
    enqueuedAt: TS, attempts: 0, state: 'pending', lastError: '', ...overrides,
  }
}

class MemFs {
  constructor(seed = {}) { this.files = new Map(Object.entries(seed)) }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) { const t = `${rel}.tmp`; this.files.set(t, text); return t }
  async readTemp(t) { return this.files.get(t) ?? '' }
  async rename(t, rel) { this.files.set(rel, this.files.get(t)); this.files.delete(t) }
  async backupIfExists(rel, b) {
    if (!this.files.has(rel)) return false
    this.files.set(b, this.files.get(rel)); return true
  }
  async append(rel, text) { this.files.set(rel, (this.files.get(rel) ?? '') + text) }
  async exists(rel) { return this.files.has(rel) }
}

class FakeGit {
  constructor(pushError = null) { this.pushError = pushError; this.calls = [] }
  async branchName() { return 'main' }
  async fetchMain() { this.calls.push('fetch') }
  async headSha() { return 'sha' }
  async originMainSha() { return 'sha' }
  async showRemote() { return '' }
  async showHead() { return '' }
  async addPaths(p) { this.calls.push(['add', p]) }
  async commit(m) { this.calls.push(['commit', m]) }
  async pushMain(a) { this.calls.push(['push', a]); if (this.pushError) throw new Error(this.pushError) }
  async aheadBehind() { return { ahead: 0, behind: 0 } }
  async aheadCommits() { return [] }
}

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-v2-outbox-'))
  return { root, stateRoot: path.join(root, 'state') }
}

test('O01 outbox 落在 %USERPROFILE%\\.dsh\\dots\\outbox\\<repoHash>.json（工作副本之外）', async () => {
  const { root, stateRoot } = await tempRoot()
  try {
    const url = 'https://example.test/a/b.git'
    const port = new NodeOutboxPort({ stateRoot, repoUrl: url })
    assert.equal(port.filePath, path.join(stateRoot, 'outbox', `${repoHash(url)}.json`))
    assert.equal(outboxPathFor(stateRoot, url), port.filePath)
    assert.equal(port.filePath.includes(`${path.sep}.git`), false)
    assert.equal(path.relative(stateRoot, port.filePath).startsWith(`outbox${path.sep}`), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('O02 缺文件 = 空；save/load 往返；模拟重启后 attempts 原样保留', async () => {
  const { root, stateRoot } = await tempRoot()
  try {
    const url = 'https://example.test/a/b.git'
    const first = new NodeOutboxPort({ stateRoot, repoUrl: url })
    assert.deepEqual(await first.load(), [])
    const parked = intent({ attempts: 3, state: 'syncing', lastError: 'E_PUSH_REJECTED: nope' })
    await first.save([parked])
    // 关键：换一个新实例 = 新会话/新进程，只有磁盘是共享真值。
    const restarted = new NodeOutboxPort({ stateRoot, repoUrl: url })
    const loaded = await restarted.load()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].attempts, 3)
    assert.equal(loaded[0].state, 'syncing')
    assert.equal(loaded[0].lastError, parked.lastError)
    assert.equal(loaded[0].line, parked.line)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('O03 坏 outbox 文件 typed E_CORRUPT，绝不静默当作空（避免吞掉意图）', async () => {
  const { root, stateRoot } = await tempRoot()
  try {
    const port = new NodeOutboxPort({ stateRoot, repoUrl: 'https://example.test/x.git' })
    await port.save([])
    await writeFile(port.filePath, '{not json')
    await assert.rejects(async () => await port.load(), (e) => e.code === V2_ERROR.CORRUPT)
    await writeFile(port.filePath, '{"not":"array"}')
    await assert.rejects(async () => await port.load(), (e) => e.code === V2_ERROR.CORRUPT)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('O04 端到端：推拒落盘 attempts=1 → 重启读回 → 再推成功排空文件', async () => {
  const { root, stateRoot } = await tempRoot()
  try {
    const url = 'https://example.test/a/b.git'
    const outbox1 = new NodeOutboxPort({ stateRoot, repoUrl: url })
    await outbox1.save([intent()])
    const fs = new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT })
    const failing = await runV2Cycle({
      days: [DAY], git: new FakeGit('E_PUSH_REJECTED: rival'), fs, outbox: outbox1,
      now: new Date(`${DAY}T10:00:00+08:00`),
    })
    assert.equal(failing.code, V2_ERROR.PUSH_REJECTED)
    // 模拟 DSH 重启：新实例从文件读回，attempts 不被重置。
    const outbox2 = new NodeOutboxPort({ stateRoot, repoUrl: url })
    const afterRestart = await outbox2.load()
    assert.equal(afterRestart.length, 1)
    assert.equal(afterRestart[0].attempts, 1)
    assert.equal(afterRestart[0].state, 'pending')
    const success = await runV2Cycle({
      days: [DAY], git: new FakeGit(), fs, outbox: outbox2,
      now: new Date(`${DAY}T10:00:00+08:00`),
    })
    assert.equal(success.ok, true)
    assert.equal(existsSync(outbox2.filePath), true)
    assert.equal(await readFile(outbox2.filePath, 'utf8'), '[]\n') // 排空
    const drained = new NodeOutboxPort({ stateRoot, repoUrl: url })
    assert.deepEqual(await drained.load(), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
