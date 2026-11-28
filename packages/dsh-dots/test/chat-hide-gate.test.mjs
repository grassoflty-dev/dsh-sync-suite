/**
 * mod-chat-hide：归属门禁白名单的机械化表驱动证明（设计 §5 / §12 A7）。
 *
 * `isConfinedSyncPath` 只比字面量、不做归一化：除 `timeline/**` 外只多一条
 * `chats/index.jsonl`。subject 多一种 `chats: delete <id>` 形状，尾注与
 * `paths.length > 0` 两条严格条件一律不放宽。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NOT_SYNCED_MESSAGE,
  describePendingOwnership,
  isChatDeleteSubject,
  isConfinedSyncPath,
  isOursCommit,
  isV2CommitSubject,
  v2TrailerLine,
} from '../dist/sync/cycle.js'

const TRAILER = v2TrailerLine()
const DELETE_SUBJECT = 'chats: delete s1'

test('HG-01 三种合法形状收容（timeline 文件 / timeline 媒体 / 索引单文件）', () => {
  const allowed = [
    'timeline/2026-11-27/records.json',
    'timeline/2026-11-27/deleted.jsonl',
    'timeline/2026-11-27/media/a1b2.jpg',
    'chats/index.jsonl',
  ]
  for (const p of allowed) assert.equal(isConfinedSyncPath(p), true, p)
})

test('HG-02 拒绝表：chats 子路径 / devices / 配置载荷 / 绝对与归一化形态 / 裸文件', () => {
  const rejected = [
    'chats/s1/meta.json',
    'chats/s1/session.jsonl',
    'chats/s1/media/a.jpg',
    'chats/index.jsonl.bak',
    'devices/pc-a/schedules/2026-11-27.jsonl',
    'devices/registry.jsonl',
    'cordis.patch.yml', 'providers.json', 'plugins.json', 'mcp.json', 'manifest.json',
    '/abs/chats/index.jsonl', 'C:\\repo\\chats\\index.jsonl',
    'chats/../chats/index.jsonl', 'chats//index.jsonl', 'chats/./index.jsonl',
    'timeline/../chats/index.jsonl', 'timeline//x', 'timeline\\x', '', 'README.md',
  ]
  for (const p of rejected) assert.equal(isConfinedSyncPath(p), false, p)
})

test('HG-03 隐藏提交判 ours；混合路径仍是 untrusted，且解释不算 ours', () => {
  const hide = { subject: DELETE_SUBJECT, body: TRAILER, paths: ['chats/index.jsonl'] }
  assert.equal(isV2CommitSubject(DELETE_SUBJECT), true)
  assert.equal(isChatDeleteSubject('chats: delete ../s1'), false)
  assert.equal(isChatDeleteSubject('chats: delete s1 extra'), false)
  assert.equal(isOursCommit(hide), true)
  assert.equal(describePendingOwnership([hide]).ours, true)

  const mixed = { ...hide, paths: ['chats/index.jsonl', 'devices/x'] }
  assert.equal(isOursCommit(mixed), false)
  const verdict = describePendingOwnership([mixed])
  assert.equal(verdict.ours, false)
  assert.equal(verdict.verdicts[0].verdict, 'untrusted')
  assert.equal(verdict.verdicts[0].outsideScopePaths, 1)

  // 尾注缺失 / subject 形状不对仍一律不算本模块。
  assert.equal(isOursCommit({ ...hide, body: '' }), false)
  assert.equal(isOursCommit({ ...hide, subject: 'manual fix' }), false)
  assert.equal(isOursCommit({ ...hide, paths: [] }), false)
})

test('HG-04 分叉文案与归属解释同步点名新白名单', () => {
  assert.match(NOT_SYNCED_MESSAGE, /白名单路径（timeline\/\*\* 或恰为 chats\/index\.jsonl）/)
  assert.equal(NOT_SYNCED_MESSAGE.includes('且只改 timeline/**，否则'), false)
})
