import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  composePatch,
  findEntryByKey,
  localOnlyKeys,
  mergePatch,
  parsePatch,
  serializePatch,
} from '../dist/engine/patch.js'

const LOCAL = `# 文件头注释：profile patch
# 第二行注释

# --- dsh-mobile-remote managed (auto-generated; do not edit) ---
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
# --- end dsh-mobile-remote managed ---

- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        models:
        - id: deepseek-v4-pro
          name: DeepSeek V4 Pro (New)
          input:
          - text

- insert:
    - id: dots
      name: 'dsh-dots'

- id: local-only-entry
  config:
    keep: true
`

test('parsePatch + serializePatch：注释/缩进/!!js 字节级 round-trip', () => {
  const doc = parsePatch(LOCAL)
  assert.equal(doc.preamble.length, 4, '文件头（3 行注释 + 1 空行）应进入 preamble')
  assert.deepEqual(doc.entries[0].header, [], '第一条目没有独立 header（文件头归 preamble）')
  assert.equal(doc.entries.length, 4)
  assert.deepEqual(
    doc.entries.map((entry) => entry.key),
    ['webserver', 'llm-pi-ai', 'insert:dots', 'local-only-entry'],
  )
  assert.equal(doc.entries[0].kind, 'config')
  assert.equal(doc.entries[2].kind, 'insert')
  assert.ok(doc.entries[2].raw.includes("name: 'dsh-dots'"))
  assert.ok(doc.entries[0].raw.includes('!!js ctx.webStartup.port ?? 3080'))
  assert.equal(serializePatch(doc), LOCAL)
})

test('serializePatch：末尾恰好一个换行；空文档为空串', () => {
  const doc = parsePatch(`${LOCAL}\n\n\n`)
  const out = serializePatch(doc)
  assert.equal(out, LOCAL)
  assert.ok(out.endsWith('\n'))
  assert.ok(!out.endsWith('\n\n'))
  assert.equal(serializePatch(parsePatch('')), '')
  assert.equal(serializePatch(parsePatch(null)), '')
})

test('parsePatch：非 id 起始的条目退化为 entry:<序号>', () => {
  const doc = parsePatch('- disable: true\n- id: x\n  config: {}\n')
  assert.deepEqual(
    doc.entries.map((entry) => entry.key),
    ['entry:1', 'x'],
  )
})

test('mergePatch：same / changed / added 状态，本地顺序为准，本地独有保留', () => {
  const remote = `# 远端文件头（不应覆盖本地头）
- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        models:
        - id: deepseek-v4-pro
          name: DeepSeek V4 Pro (New)
          input:
          - text

- insert:
    - id: dots
      name: 'dsh-dots'

# 远端独有条目的前置注释
- id: remote-only-entry
  config:
    from: remote
`
  const merged = mergePatch(LOCAL, remote)
  const statuses = Object.fromEntries(merged.entries.map((entry) => [entry.key, entry.status]))
  assert.equal(statuses['llm-pi-ai'], 'same')
  assert.equal(statuses['insert:dots'], 'same')
  assert.equal(statuses['remote-only-entry'], 'added')
  assert.equal(statuses.webserver, undefined, '远端没有 webserver，不应出现在差异列表')

  assert.ok(merged.text.startsWith('# 文件头注释：profile patch'), '本地文件头保留')
  assert.ok(!merged.text.includes('远端文件头'), '远端文件头不得覆盖本地')
  assert.ok(merged.text.includes('# --- dsh-mobile-remote managed'), '条目前置注释保留')
  assert.ok(merged.text.includes('!!js ctx.webStartup.port ?? 3080'), '!!js 表达式原样保留')
  assert.ok(merged.text.includes('- id: local-only-entry'), '本地独有条目保留')
  assert.ok(merged.text.indexOf('- id: local-only-entry') < merged.text.indexOf('- id: remote-only-entry'), '远端独有追加到末尾')
  assert.ok(merged.text.includes('# 远端独有条目的前置注释'), '远端独有条目连同前置注释一起追加')
  assert.ok(merged.text.endsWith('\n') && !merged.text.endsWith('\n\n'))
  assert.deepEqual(localOnlyKeys(LOCAL, remote), ['webserver', 'local-only-entry'])
})

test('mergePatch：同 key 文本不同 → changed（整块采用远端），并保留本地 header', () => {
  const remote = LOCAL.replace("    host: '0.0.0.0'", "    host: '127.0.0.1'").replace(
    '    port: !!js ctx.webStartup.port ?? 3080',
    '    port: 3080',
  )
  const merged = mergePatch(LOCAL, remote)
  const statuses = Object.fromEntries(merged.entries.map((entry) => [entry.key, entry.status]))
  assert.equal(statuses.webserver, 'changed')
  assert.ok(merged.text.includes("    host: '127.0.0.1'"), '采用远端值')
  assert.ok(!merged.text.includes('!!js ctx.webStartup.port'), '远端整块替换（旧 !!js 消失）')
  assert.ok(merged.text.includes('# --- dsh-mobile-remote managed'), '本地 header 注释仍保留')
  assert.ok(merged.text.includes('- id: local-only-entry'), '其它条目不受影响')
})

test('mergePatch：远端块含 __SECRET__ 且不同 → manual，不自动覆盖', () => {
  const localPatch = `- id: llm
  config:
    apiKey: local-value
    name: x
`
  const remotePatch = `- id: llm
  config:
    apiKey: __SECRET__
    name: x
`
  const merged = mergePatch(localPatch, remotePatch)
  assert.equal(merged.entries.length, 1)
  assert.equal(merged.entries[0].status, 'manual')
  assert.equal(merged.entries[0].secretStripped, true)
  assert.ok(merged.text.includes('apiKey: local-value'), 'manual 条目必须保留本地值')
  assert.ok(!merged.text.includes('__SECRET__'), '不得把占位符写进合并结果')
})

test('mergePatch：远端与本地都含同一占位符 → same', () => {
  const localPatch = `- id: llm
  config:
    apiKey: __SECRET__
    name: x
`
  const remotePatch = localPatch
  const merged = mergePatch(localPatch, remotePatch)
  assert.equal(merged.entries[0].status, 'same')
  assert.equal(merged.text, localPatch)
})

test('mergePatch：本地为空 → 全部 added，且采用远端 preamble', () => {
  const remote = '# 远端头\n- id: a\n  config:\n    k: v\n'
  const merged = mergePatch(null, remote)
  assert.equal(merged.entries.length, 1)
  assert.equal(merged.entries[0].status, 'added')
  assert.equal(merged.entries[0].localText, '')
  assert.equal(merged.text, '# 远端头\n- id: a\n  config:\n    k: v\n')
})

test('composePatch：只替换勾选条目，其余保持本地字节', () => {
  const remote = LOCAL.replace("    host: '0.0.0.0'", "    host: '10.0.0.5'")
  const remoteEntry = findEntryByKey(parsePatch(remote), 'webserver')
  assert.ok(remoteEntry !== null)
  const text = composePatch(LOCAL, [{ key: 'webserver', raw: remoteEntry.raw }])
  assert.ok(text.includes("    host: '10.0.0.5'"))
  assert.ok(text.includes('- id: local-only-entry'))
  assert.ok(text.includes('# 文件头注释：profile patch'))
  // 未勾选条目应与原文一致
  assert.ok(text.includes('- id: llm-pi-ai\n  config:\n    providers:'))
})

test('composePatch：远端独有 block 追加时带上 header', () => {
  const text = composePatch('- id: a\n  config: {}\n', [
    { key: 'b', raw: '- id: b\n  config:\n    k: 1', header: ['# b 的注释'] },
  ])
  assert.ok(text.includes('# b 的注释\n- id: b'))
  assert.ok(text.endsWith('\n'))
})

test('合并/组合不依赖临时目录（round-trip 幂等）', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-patch-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  const doc = parsePatch(LOCAL)
  const once = serializePatch(doc)
  const twice = serializePatch(parsePatch(once))
  assert.equal(once, twice)
  assert.ok(path.isAbsolute(root))
})
