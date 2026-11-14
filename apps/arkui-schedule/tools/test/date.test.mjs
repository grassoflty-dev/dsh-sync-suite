import test from 'node:test'
import assert from 'node:assert/strict'
import { localDateKey, nextTsSameDate, nowIso } from '../.build/common/date.js'

function localDate(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms)
}

test('nowIso 保留本地时区偏移且格式稳定', () => {
  const value = nowIso(localDate(2026, 11, 14, 9, 5, 3))
  assert.match(value, /^2026-11-14T09:05:03[+-]\d{2}:\d{2}$/)
})

test('nextTsSameDate 保留原记录日期，不迁到当天', () => {
  const original = '2026-11-10T09:30:00+08:00'
  const now = localDate(2026, 11, 14, 22, 15, 0)
  const next = nextTsSameDate(original, now)
  assert.ok(next.startsWith('2026-11-10T'), `日期必须保持 2026-11-10，实际 ${next}`)
  assert.ok(Date.parse(next) > Date.parse(original), '新 ts 必须严格大于原 ts')
  assert.equal(next.slice(11, 16), '22:15', '时刻取当前时钟')
})

test('nextTsSameDate 当前时钟早于原时刻时仍严格递增', () => {
  const original = '2026-11-10T18:30:00+08:00'
  const now = localDate(2026, 11, 14, 7, 0, 0)
  const next = nextTsSameDate(original, now)
  assert.ok(next.startsWith('2026-11-10T'))
  assert.ok(Date.parse(next) > Date.parse(original), `必须大于原 ts：${next} vs ${original}`)
})

test('nextTsSameDate 原记录 23:59:59.999 时钳到当天上限且不丢失更新顺序', () => {
  const original = '2026-11-09T23:59:59.999+08:00'
  const now = localDate(2026, 11, 14, 8, 0, 0)
  const next = nextTsSameDate(original, now)
  assert.ok(next.startsWith('2026-11-09T23:59:59'))
  assert.ok(Date.parse(next) >= Date.parse(original))
})

test('nextTsSameDate 原 ts 非法时退化为当前时间', () => {
  const now = localDate(2026, 11, 14, 10, 20, 30)
  const next = nextTsSameDate('not-a-timestamp', now)
  assert.equal(next.slice(0, 19), nowIso(now).slice(0, 19))
  assert.equal(next.slice(0, 10), localDateKey(now))
})

test('nextTsSameDate 折叠场景：追加更新后按 ts 升序取到新版本', () => {
  const original = { id: 'x', ts: '2026-11-10T18:30:00+08:00', done: false }
  const updated = { id: 'x', ts: nextTsSameDate(original.ts, localDate(2026, 11, 14, 7, 0, 0)), done: true }
  const sorted = [original, updated].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  assert.equal(sorted[sorted.length - 1].done, true, '后者（更新）必须是排序后的最后一条')
  assert.equal(sorted[sorted.length - 1].ts.slice(0, 10), '2026-11-10', '更新后仍归属原日期')
})
