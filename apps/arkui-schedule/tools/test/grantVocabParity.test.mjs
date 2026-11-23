/**
 * mod-grant-vocab-parity：授权词表双表对拍（插件 canonical / App 近似 + composer 窄谓词）。
 *
 *  technique 沿用 `packages/dsh-dots/test/refusal-wording-parity.test.mjs`：
 *  直接解析两份源码，不 import（App 的 model 只有 tsc 后才可加载，插件源码是 TS）；
 *  每条断言打印一行 PASS/FAIL，末尾打印 `PARITY: 0 mismatch`，任何一侧漂移即红。
 *
 *  钉住三件事：① 10 个 id 与 view/command 分类两侧逐字相同（无多无少）；
 *  ② App 的 ALL_GRANT_TOOLS = view + command；③ composer 的 prompt 工具集恰好
 *  ['session.prompt']，且 remoteCommandGate 用的是 isPromptTool 而不是宽的 isCommandTool。
 *  这样未来「给命令词表加工具」或「给 composer 加工具」都会立刻被本门禁抓住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const PLUGIN_SRC = path.join(REPO, 'packages', 'dsh-dots', 'src', 'remote', 'grants.ts')
const APP_SRC = path.join(REPO, 'apps', 'arkui-schedule', 'entry', 'src', 'main', 'ets', 'model', 'instanceGrant.ts')
const GATE_SRC = path.join(REPO, 'apps', 'arkui-schedule', 'entry', 'src', 'main', 'ets', 'model', 'remoteCommandGate.ts')

let mismatches = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const pass = a === e
  if (!pass) mismatches += 1
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${a} expected=${e}`)
  return pass
}

/** 从 `export const TOOL_X ... = 'id'` 抽常量值（兼容两侧 TS 写法）。 */
function toolConstants(source) {
  const out = new Map()
  const re = /export const (TOOL_[A-Z0-9_]+)\s*(?::[^=]+)?=\s*'([^']+)'/g
  let m
  while ((m = re.exec(source)) !== null) out.set(m[1], m[2])
  return out
}

/** 从 `export const NAME...= [ ... ]` 抽出 TOOL_* 常量的字面量值（按出现顺序）。 */
function toolTable(source, name, constants) {
  const marker = `export const ${name}`
  const at = source.indexOf(marker)
  if (at < 0) return null
  // 必须跳过类型标注里的 `GrantTool[]`：从 `=` 之后才找数组字面量。
  const eq = source.indexOf('=', at)
  const open = eq < 0 ? -1 : source.indexOf('[', eq)
  const close = open < 0 ? -1 : source.indexOf(']', open)
  if (open < 0 || close < 0) return null
  const tokens = source.slice(open + 1, close).match(/TOOL_[A-Z0-9_]+/g) || []
  return tokens.map((token) => constants.get(token) ?? `<unresolved:${token}>`)
}

test('授权词表双表对拍：10 id / view-command 分类 / composer prompt 集', () => {
  const plugin = readFileSync(PLUGIN_SRC, 'utf8')
  const app = readFileSync(APP_SRC, 'utf8')
  const gate = readFileSync(GATE_SRC, 'utf8')

  const pc = toolConstants(plugin)
  const ac = toolConstants(app)
  const pView = toolTable(plugin, 'VIEW_TOOLS', pc)
  const pCommand = toolTable(plugin, 'COMMAND_TOOLS', pc)
  const aView = toolTable(app, 'VIEW_TOOLS', ac)
  const aCommand = toolTable(app, 'COMMAND_TOOLS', ac)
  const aAll = toolTable(app, 'ALL_GRANT_TOOLS', ac)
  const aPrompt = toolTable(app, 'PROMPT_TOOLS', ac)

  // (1) 数量：两侧都必须是 5 view + 5 command。
  check('plugin view count', pView && pView.length, 5)
  check('plugin command count', pCommand && pCommand.length, 5)
  check('app view count', aView && aView.length, 5)
  check('app command count', aCommand && aCommand.length, 5)

  // (2) 分类逐字相同：无 extra、无 missing、顺序也一致。
  check('view ids identical', pView, aView)
  check('command ids identical', pCommand, aCommand)
  check('all ids identical (derived)', [...(pView || []), ...(pCommand || [])], aAll)
  check('app ALL == view + command', aAll, [...(aView || []), ...(aCommand || [])])
  check('view / command disjoint', (aView || []).filter((t) => (aCommand || []).includes(t)), [])

  // (3) 旧 App 独有工具绝不能混入任何 canonical 表。
  const allTables = [...(pView || []), ...(pCommand || []), ...(aView || []), ...(aCommand || []), ...(aAll || [])]
  check('session.read absent from both vocabularies', allTables.filter((t) => t === 'session.read'), [])

  // (4) composer 的 prompt 集恰好一个工具，且发送闸走窄谓词。
  check('app PROMPT_TOOLS', aPrompt, ['session.prompt'])
  check('prompt tool is a grantable command tool', (aCommand || []).includes('session.prompt'), true)
  check('gate imports isPromptTool', /import \{ isPromptTool \} from '\.\/instanceGrant'/.test(gate), true)
  check('gate calls isPromptTool', /!isPromptTool\(draft\.tool\)/.test(gate), true)
  check('gate does not use isCommandTool', /isCommandTool\(/.test(gate), false)

  check('PARITY mismatches', mismatches, 0)
  console.log(mismatches === 0 ? 'PARITY: 0 mismatch' : `PARITY: ${mismatches} mismatch`)
  assert.equal(mismatches, 0, `授权词表/发送闸对拍失败：${mismatches} mismatch`)
})
