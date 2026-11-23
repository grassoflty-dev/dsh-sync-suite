/**
 * mod-plugin-session-prompt：拒绝文案三方对拍（docs 表 / App COMMAND_WORDING / 插件两表）。
 *
 * 文档表只是 join，不是第三份拷贝：逐字真值在两侧代码里。任何一侧改文案而未同步 ⇒ 本门禁失败。
 * 注意 prompt.text.tooLong 在 App 侧是模板字面量：先断言 COMMAND_TEXT_LIMIT=2000，
 * 再替换 ${COMMAND_TEXT_LIMIT} 后比较；绝不比较原始源码文本。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LEASE_SEMANTIC_KEY_BY_CODE,
  PROMPT_CODE_BY_KEY,
  PROMPT_SEMANTIC_KEYS,
  PROMPT_WORDING,
} from '../dist/remote/promptWording.js'
import { LEASE_WORDING } from '../dist/remote/lease.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(TEST_DIR, '..', '..', '..')
const DOC = path.join(REPO, 'docs', 'REFUSAL-WORDING.md')
const APP_GATE = path.join(REPO, 'apps', 'arkui-schedule', 'entry', 'src', 'main', 'ets', 'model', 'remoteCommandGate.ts')

const EXPECTED_KEYS = [
  'prompt.target.missing',
  'prompt.tool.notAllowed',
  'prompt.text.empty',
  'prompt.text.tooLong',
  'prompt.grant.denied',
  'prompt.confirm.unconfirmed',
  'prompt.confirm.stale',
  'channel.tablet.unverified',
  'channel.desktop.unverified',
  'channel.desktop.leafMismatch',
  'lease.observing',
  'lease.notHeld',
  'lease.expired',
  'head.moved',
  'prompt.duplicate',
  'instance.unknown',
  'session.unavailable',
]

let mismatches = 0
function check(label, actual, expected) {
  const pass = actual === expected
  if (!pass) mismatches += 1
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
  return pass
}

function cell(text) {
  const value = text.trim()
  return value === '—' || value === '-' ? '' : value
}

function parseDoc() {
  const lines = readFileSync(DOC, 'utf8').split(/\r?\n/)
  const rows = []
  for (const line of lines) {
    const match = line.match(/^\|\s*([a-z]+(?:\.[a-zA-Z]+)+)\s*\|/)
    if (match === null) continue
    const cells = line.split('|').slice(1, -1).map((item) => item.trim())
    rows.push({
      key: cells[0],
      appCode: cell(cells[1]),
      appConst: cell(cells[2]),
      pluginCode: cell(cells[3]),
      pluginConst: cell(cells[4]),
      wording: cells[5],
    })
  }
  return rows
}

function parseApp() {
  const source = readFileSync(APP_GATE, 'utf8')
  const limitMatch = source.match(/COMMAND_TEXT_LIMIT\s*:\s*number\s*=\s*(\d+)/)
  const limit = limitMatch === null ? Number.NaN : Number(limitMatch[1])
  const marker = source.indexOf('export const COMMAND_WORDING')
  const start = source.indexOf('Object.freeze({', marker)
  const end = source.indexOf('});', start)
  assert.ok(marker >= 0 && start >= 0 && end > start, '无法定位 COMMAND_WORDING 对象')
  const block = source.slice(start + 'Object.freeze({'.length, end)
  const wording = {}
  for (const line of block.split(/\r?\n/)) {
    const entry = line.match(/^\s*(E_[A-Z_]+):\s*(.+?)\s*,?\s*$/)
    if (entry === null) continue
    let literal = entry[2].trim().replace(/,$/, '').trim()
    if (literal.startsWith("'") && literal.endsWith("'")) {
      wording[entry[1]] = literal.slice(1, -1)
    } else if (literal.startsWith('`') && literal.endsWith('`')) {
      wording[entry[1]] = literal.slice(1, -1).replace('${COMMAND_TEXT_LIMIT}', String(limit))
    }
  }
  return { limit, wording }
}

test('拒绝文案三方对拍：16 行 + App 侧 + 插件侧 +  hygiene', () => {
  const rows = parseDoc()
  const app = parseApp()

  // (c) 行数与 key 集合
  check('row count', rows.length, 17)
  check('key set', [...new Set(rows.map((row) => row.key))].sort().join(','), [...EXPECTED_KEYS].sort().join(','))
  // prompt.text.tooLong 的模板先决条件
  check('COMMAND_TEXT_LIMIT', app.limit, 2000)

  let appRows = 0
  let pluginRows = 0
  const allWording = []
  for (const row of rows) {
    allWording.push(row.wording)
    // (b) App 侧逐字
    if (row.appCode !== '') {
      appRows += 1
      check(`app ${row.key} (${row.appCode})`, app.wording[row.appCode], row.wording)
    }
    // (a) 插件侧逐字（语义键 + 码 + 文案三者同时钉住）
    if (row.pluginCode !== '') {
      pluginRows += 1
      if (row.pluginConst === 'PROMPT_WORDING') {
        check(`plugin key registered ${row.key}`, Object.prototype.hasOwnProperty.call(PROMPT_WORDING, row.key), true)
        check(`plugin code ${row.key}`, PROMPT_CODE_BY_KEY[row.key], row.pluginCode)
        check(`plugin wording ${row.key}`, PROMPT_WORDING[row.key], row.wording)
      } else if (row.pluginConst === 'LEASE_WORDING') {
        check(`lease key ${row.key}`, LEASE_SEMANTIC_KEY_BY_CODE[row.pluginCode], row.key)
        check(`lease wording ${row.key}`, LEASE_WORDING[row.pluginCode], row.wording)
      } else {
        check(`unknown plugin constant ${row.key}`, row.pluginConst, 'PROMPT_WORDING|LEASE_WORDING')
      }
    }
  }
  check('app row count', appRows, 8)
  check('plugin row count', pluginRows, 12)

  // (d) 文案 hygiene（文档 + App 值 + 插件两表）
  const texts = [...allWording, ...Object.values(app.wording), ...Object.values(PROMPT_WORDING), ...Object.values(LEASE_WORDING)]
  let leaks = 0
  for (const text of texts) {
    if (text.includes('/') || text.includes('\\') || /token|Bearer/i.test(text) || /[0-9a-f]{16,}/i.test(text)) leaks += 1
  }
  check('wording hygiene leaks', leaks, 0)

  check('PARITY mismatches', mismatches, 0)
  console.log(mismatches === 0 ? 'PARITY: 0 mismatch' : `PARITY: ${mismatches} mismatch`)
  assert.equal(mismatches, 0)
})
