/**
 * engine/diff.ts 的纯函数测试：只测摘要语义，不碰任何文件。
 *
 * 断言重点（对应 docs/PLUGIN-DIFF.md §1）：
 *   - 行增删计数 / hunk 合并 / 上下文裁剪 / maxLines 截断；
 *   - 二进制与超长（> 512KB）只给 kind + 字节数；
 *   - 空输入、CRLF、末尾无换行；
 *   - diffFiles 四类 kind、summarize 的中文串；
 *   - 任何异常输入都不抛（宁可返回空结果，也不让 RPC 变成 500/白屏）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffText, diffFiles, summarize, summarizeFiles, MAX_DIFF_BYTES } from '../dist/engine/diff.js'

const NO_EOL = '\\ No newline at end of file'

test('diffText：纯新增 / 纯删除的行数统计与 hunk 结构', () => {
  const added = diffText('a\nb\n', 'a\nb\nc\n')
  assert.equal(added.addedLines, 1)
  assert.equal(added.removedLines, 0)
  assert.equal(added.hunks.length, 1)
  assert.equal(added.hunks[0].path, '')
  assert.match(added.hunks[0].header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/)
  assert.ok(added.hunks[0].lines.includes('+c'))
  assert.ok(!added.hunks[0].lines.includes('-c'))
  assert.equal(added.hunks[0].truncated, false)

  const removed = diffText('a\nb\n', 'a\n')
  assert.equal(removed.addedLines, 0)
  assert.equal(removed.removedLines, 1)
  assert.ok(removed.hunks[0].lines.includes('-b'))

  const rewritten = diffText('a\n', 'b\n')
  assert.equal(rewritten.addedLines, 1)
  assert.equal(rewritten.removedLines, 1)
})

test('diffText：修改行 + 默认 3 行上下文', () => {
  const result = diffText('a\nb\nc\n', 'a\nB\nc\n')
  assert.equal(result.addedLines, 1)
  assert.equal(result.removedLines, 1)
  assert.equal(result.hunks.length, 1)
  assert.deepEqual(result.hunks[0].lines, [' a', '-b', '+B', ' c'])
  assert.equal(result.hunks[0].truncated, false)
})

test('diffText：contextLines 裁剪与 hunk 合并', () => {
  const before = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n'
  const after = '1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n10\n'
  const tight = diffText(before, after, { contextLines: 0 })
  assert.equal(tight.hunks.length, 2, '相隔很远的改动必须拆成两个 hunk')
  assert.deepEqual(tight.hunks[0].lines, ['-2', '+TWO'])
  assert.deepEqual(tight.hunks[1].lines, ['-9', '+NINE'])
  assert.equal(tight.addedLines, 2)
  assert.equal(tight.removedLines, 2)

  const near = diffText('a\nb\nc\nd\ne\nf\n', 'a\nB\nc\nd\nE\nf\n', { contextLines: 3 })
  assert.equal(near.hunks.length, 1, '相隔不超过 2*context 的改动合并进同一个 hunk')
  assert.ok(near.hunks[0].lines.includes('-b'))
  assert.ok(near.hunks[0].lines.includes('+E'))

  const widened = diffText(before, after, { contextLines: 2 })
  assert.equal(widened.hunks.length, 2)
  assert.ok(widened.hunks[0].lines.includes(' 1'), '上下文 2 行时 hunk 应包含前两行')
})

test('diffText：maxLines 截断并标记 truncated', () => {
  const before = Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n') + '\n'
  const after = Array.from({ length: 400 }, (_, i) => `LINE-${i}`).join('\n') + '\n'

  const capped = diffText(before, after, { maxLines: 10 })
  const totalLines = capped.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  assert.ok(totalLines <= 10, `hunk 正文必须被截到 10 行以内，实际 ${totalLines}`)
  assert.equal(capped.hunks[capped.hunks.length - 1].truncated, true)
  // 行数统计是**完整**的（截断只影响 hunk 文本，不影响结论）。
  assert.equal(capped.addedLines, 400)
  assert.equal(capped.removedLines, 400)

  const byDefault = diffText(before, after)
  const defaultLines = byDefault.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  assert.ok(defaultLines <= 200, `默认 maxLines=200，实际 ${defaultLines}`)
  assert.equal(byDefault.hunks[byDefault.hunks.length - 1].truncated, true)
})

test('二进制（NUL）与超长（>512KB）只给统计，不产出 hunk', () => {
  const binary = diffText('a\u0000b', 'a\u0000c')
  assert.deepEqual(binary.hunks, [])
  assert.equal(binary.addedLines, 0)
  assert.equal(binary.removedLines, 0)

  const binaryFiles = diffFiles({ 'db.bin': 'a\u0000b' }, { 'db.bin': 'a\u0000c' })
  assert.equal(binaryFiles.files.length, 1)
  assert.equal(binaryFiles.files[0].kind, 'modified')
  assert.equal(binaryFiles.files[0].truncated, true)
  assert.equal(binaryFiles.files[0].addedLines, 0)
  assert.equal(binaryFiles.files[0].removedLines, 0)
  assert.equal(binaryFiles.files[0].beforeBytes, 3)

  const huge = 'x'.repeat(MAX_DIFF_BYTES + 1024)
  const hugeDiff = diffText(huge, `${huge}y`)
  assert.deepEqual(hugeDiff.hunks, [])
  assert.equal(hugeDiff.addedLines, 0)
  const hugeFiles = diffFiles({ 'huge.json': huge }, { 'huge.json': `${huge}y` })
  assert.equal(hugeFiles.files[0].truncated, true)

  // 刚好在阈值内的文本仍然逐行比较。
  const nearLimit = 'a\n'.repeat(Math.floor(MAX_DIFF_BYTES / 2) - 10)
  const nearDiff = diffText(nearLimit, nearLimit)
  assert.equal(nearDiff.addedLines, 0)
})

test('空输入：空文件 / 空对象都不产生差异', () => {
  const empty = diffText('', '')
  assert.deepEqual(empty.hunks, [])
  assert.equal(empty.addedLines, 0)
  assert.equal(empty.removedLines, 0)

  assert.equal(diffText('', 'x\n').addedLines, 1)
  assert.equal(diffText('x\n', '').removedLines, 1)

  const none = diffFiles({}, {})
  assert.deepEqual(none.files, [])
  assert.deepEqual(none.totals, { added: 0, modified: 0, deleted: 0, same: 0, addedLines: 0, removedLines: 0 })
  assert.equal(summarize(none), '没有差异')
})

test('CRLF 与末尾换行：行尾 \\r 不算变更，缺尾换行算变更', () => {
  const crlfOnly = diffText('a\r\nb\r\n', 'a\nb\n')
  assert.equal(crlfOnly.addedLines, 0, '纯 CRLF 差异不应算行变更')
  assert.equal(crlfOnly.removedLines, 0)
  assert.deepEqual(crlfOnly.hunks, [])

  const crlfChanged = diffText('a\r\nb\r\n', 'a\r\nB\r\n')
  assert.equal(crlfChanged.addedLines, 1)
  assert.equal(crlfChanged.removedLines, 1)
  assert.deepEqual(crlfChanged.hunks[0].lines, [' a', '-b', '+B'])

  const noTrailing = diffText('a\nb', 'a\nb\n')
  assert.equal(noTrailing.addedLines, 1, '补上结尾换行属于内容变更')
  assert.equal(noTrailing.removedLines, 1)
  assert.ok(noTrailing.hunks[0].lines.includes(NO_EOL), 'hunk 里必须标注末尾无换行')

  const stillNoTrailing = diffText('a\nb', 'a\nB')
  assert.ok(stillNoTrailing.hunks[0].lines.includes(NO_EOL))
})

test('diffFiles：added / modified / deleted / same 四类与字节统计', () => {
  const before = { 'a.yml': '1\n', 'b.yml': '2\n', 'd.yml': '4\n' }
  const after = { 'a.yml': '1\n', 'b.yml': '2x\n', 'c.yml': '3\n' }
  const summary = diffFiles(before, after)
  const kinds = Object.fromEntries(summary.files.map((file) => [file.path, file.kind]))
  assert.deepEqual(kinds, { 'a.yml': 'same', 'b.yml': 'modified', 'c.yml': 'added', 'd.yml': 'deleted' })
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ['a.yml', 'b.yml', 'c.yml', 'd.yml'],
    '文件必须按路径排序',
  )
  assert.equal(summary.totals.added, 1)
  assert.equal(summary.totals.modified, 1)
  assert.equal(summary.totals.deleted, 1)
  assert.equal(summary.totals.same, 1)
  assert.equal(summary.totals.addedLines, 2)
  assert.equal(summary.totals.removedLines, 2)

  const chinese = diffFiles({ 'x.json': '中文\n' }, { 'x.json': '中文\n' })
  assert.equal(chinese.files[0].beforeBytes, 7, 'UTF-8 字节数：中文(6) + 换行(1)')
  assert.equal(chinese.files[0].afterBytes, 7)
  assert.equal(chinese.files[0].kind, 'same')

  const addedOnly = diffFiles({}, { 'new.json': 'a\nb\n' })
  assert.equal(addedOnly.files[0].kind, 'added')
  assert.equal(addedOnly.files[0].addedLines, 2)
  assert.equal(addedOnly.files[0].beforeBytes, 0)
  assert.equal(addedOnly.files[0].afterBytes, 4)
})

test('summarize：一句中文结论（含空差异）', () => {
  const summary = diffFiles(
    { 'a.yml': '1\n', 'b.yml': '2\n', 'd.yml': '4\n' },
    { 'a.yml': '1\n', 'b.yml': '2x\n', 'c.yml': '3\n' },
  )
  assert.match(summarize(summary), /^3 个文件变更（\+2 \/ -2 行）/)
  assert.ok(summarize(summary).includes('1 个新增'))
  assert.ok(summarize(summary).includes('1 个修改'))
  assert.ok(summarize(summary).includes('1 个删除'))

  const crafted = summarize({
    files: [],
    totals: { added: 1, modified: 1, deleted: 1, same: 0, addedLines: 12, removedLines: 4 },
  })
  assert.equal(crafted, '3 个文件变更（+12 / -4 行），1 个新增，1 个修改，1 个删除')

  assert.equal(
    summarize({ files: [], totals: { added: 0, modified: 0, deleted: 0, same: 2, addedLines: 0, removedLines: 0 } }),
    '没有差异',
  )
})

test('summarizeFiles 与 diffText 的容错：异常输入绝不抛', () => {
  const cases = [
    () => diffText(null, undefined),
    () => diffText(123, {}),
    () => diffText([], { a: 1 }),
    () => diffFiles(null, null),
    () => diffFiles({ a: 5 }, { a: null }),
    () => diffFiles(undefined, { ok: 'x' }),
    () => summarize(null),
    () => summarize({}),
    () => summarizeFiles(null),
    () => summarizeFiles([{}]),
  ]
  for (const run of cases) {
    assert.doesNotThrow(run)
  }
  assert.deepEqual(diffText(null, undefined), { addedLines: 0, removedLines: 0, hunks: [] })
  assert.deepEqual(diffFiles(null, null).files, [])
  assert.equal(summarize(null), '没有差异')
  assert.equal(summarizeFiles(null).files.length, 0)
  const fromTextInputs = diffFiles({ 'only-string.json': 'a\n' }, { 'only-string.json': 'b\n' })
  assert.equal(fromTextInputs.files[0].kind, 'modified')
})
