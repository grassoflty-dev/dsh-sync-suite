/**
 * mod-chat-hide：折叠全函数（`foldChatIndex`）的对抗性单测。
 *
 * 语义锁定自 `docs/CHAT-DELETE-DESIGN.md` §11.3 / §12：
 * 普通行永不解除隐藏；archive/unarchive 之间才按 (ts, seq) 严格单调；
 * 坏行只计数不抛；unarchive 只是格式兼容（本模块不产生）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { foldChatIndex } from '../dist/chats/index.js'

const normal = (id, extra = {}) => JSON.stringify({
  id, title: `标题-${id}`, updatedAt: '2026-11-27T10:00:00.000Z', messageCount: 2, sha256: 'a'.repeat(64), ...extra,
})
const archive = (id, deletedAt, extra = {}) => JSON.stringify({ op: 'archive', id, deletedAt, ...extra })
const unarchive = (id, ts, extra = {}) => JSON.stringify({ op: 'unarchive', id, ts, ...extra })
const fold = (...lines) => foldChatIndex(lines.join('\n'))

test('HF-01 普通行 last-wins 投影，不产生隐藏状态', () => {
  const result = fold(
    normal('s1', { title: '旧', updatedAt: '2026-11-27T09:00:00.000Z' }),
    normal('s1', { title: '新', updatedAt: '2026-11-27T10:00:00.000Z' }),
  )
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].title, '新')
  assert.deepEqual(result.hiddenIds, [])
  assert.equal(result.states.size, 0)
  assert.equal(result.badLines, 0)
})

test('HF-02 archive 后手工追加的普通行永不解除隐藏（A6，黏滞规则 2）', () => {
  const result = fold(
    normal('s1'),
    archive('s1', 1000),
    normal('s1', { title: '老客户端重导出', updatedAt: '2026-11-28T10:00:00.000Z' }),
  )
  assert.deepEqual(result.entries.map((entry) => entry.id), [])
  assert.deepEqual(result.hiddenIds, ['s1'])
  assert.deepEqual(result.states.get('s1').at, { ts: 1000, seq: 2 })
  assert.equal(result.lastExportAt, '2026-11-28T10:00:00.000Z', '内容投影仍更新，但可见性不变')
})

test('HF-03 重复隐藏行：按 (deletedAt, seq) 严格取最新', () => {
  const result = fold(normal('s1'), archive('s1', 1000), archive('s1', 1000), archive('s1', 900))
  assert.equal(result.states.get('s1').hidden, true)
  assert.deepEqual(result.states.get('s1').at, { ts: 1000, seq: 3 })
  assert.deepEqual(result.hiddenIds, ['s1'])
})

test('HF-04 乱序：迟到的旧 archive 不能覆盖较新的 unarchive', () => {
  const result = fold(normal('s1'), unarchive('s1', 2000), archive('s1', 1000))
  assert.deepEqual(result.entries.map((entry) => entry.id), ['s1'])
  assert.deepEqual(result.hiddenIds, [])
  assert.deepEqual(result.states.get('s1').at, { ts: 2000, seq: 2 })
})

test('HF-05 同一毫秒：行号大的胜出（两种行序各验证一次）', () => {
  const hideWins = fold(normal('s1'), unarchive('s1', 1000), archive('s1', 1000))
  assert.equal(hideWins.states.get('s1').hidden, true)
  assert.deepEqual(hideWins.states.get('s1').at, { ts: 1000, seq: 3 })

  const showWins = fold(normal('s1'), archive('s1', 1000), unarchive('s1', 1000))
  assert.equal(showWins.states.get('s1').hidden, false)
  assert.deepEqual(showWins.states.get('s1').at, { ts: 1000, seq: 3 })
  assert.deepEqual(showWins.entries.map((entry) => entry.id), ['s1'])
})

test('HF-06 unarchive 行出现在它"对应"的 hide 之前，仍由时间戳/行号决胜', () => {
  const olderUnarchive = fold(normal('s1'), unarchive('s1', 100), archive('s1', 200))
  assert.equal(olderUnarchive.states.get('s1').hidden, true)

  const sameMs = fold(unarchive('s1', 200), archive('s1', 200))
  assert.equal(sameMs.states.get('s1').hidden, true)
  assert.deepEqual(sameMs.states.get('s1').at, { ts: 200, seq: 2 })
})

test('HF-07 读取侧认识 unarchive（A8）：更正后的行让会话重新可见，且不抛', () => {
  const text = [
    normal('s1'), archive('s1', 1000),
    normal('s2'), archive('s2', 1000), unarchive('s2', 2000),
  ].join('\n')
  const result = foldChatIndex(text)
  assert.deepEqual(result.entries.map((entry) => entry.id), ['s2'])
  assert.deepEqual(result.hiddenIds, ['s1'])
  assert.equal(result.states.get('s2').hidden, false)
  // 格式定义里 unarchive 用 ts；缺 ts 时回落 deletedAt 也认，避免未来模块两种写法分裂。
  const fallback = fold(normal('s3'), archive('s3', 1000), JSON.stringify({ op: 'unarchive', id: 's3', deletedAt: 2000 }))
  assert.deepEqual(fallback.entries.map((entry) => entry.id), ['s3'])
})

test('HF-08 坏行只计数、不改状态；任意输入都是全函数', () => {
  const result = fold(
    '{不是 JSON', '123', 'null', '[]', JSON.stringify({ title: '没有 id' }),
    JSON.stringify({ op: 'future-op', id: 's1', ts: 1 }),
    JSON.stringify({ op: 'archive', id: 's1', deletedAt: '1000' }),
    JSON.stringify({ op: 'archive', id: 's1', deletedAt: -1 }),
    JSON.stringify({ op: 'archive', id: '../s1', deletedAt: 1000 }),
    normal('s1'), archive('s1', 1000),
  )
  assert.equal(result.badLines, 9)
  assert.deepEqual(result.entries, [])
  assert.deepEqual(result.hiddenIds, ['s1'])
  assert.doesNotThrow(() => foldChatIndex(undefined))
  assert.doesNotThrow(() => foldChatIndex(null))
  assert.doesNotThrow(() => foldChatIndex(42))
  assert.equal(foldChatIndex(undefined).entries.length, 0)
})

test('HF-09 只有隐藏行、没有普通行时也进隐藏集合', () => {
  const result = fold(archive('ghost', 1234))
  assert.deepEqual(result.entries, [])
  assert.deepEqual(result.hiddenIds, ['ghost'])
  assert.deepEqual(result.states.get('ghost').at, { ts: 1234, seq: 1 })
})
