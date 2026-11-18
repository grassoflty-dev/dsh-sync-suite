import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const source = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')

test('client is loaded through the DSH ModuleLoader with the plugin id', () => {
  assert.match(source, /__ModuleLoader__\.load\s*\(/)
  assert.match(source, /id:\s*['"]dots['"]/)
  assert.match(source, /factory\s*\(\s*require\s*\)/)
})

test('client registers the settings section and locale module', () => {
  assert.match(source, /settings\.section/)
  assert.match(source, /locale\.register/)
  assert.match(source, /ctx\.slots\.inject\(/)
  assert.match(source, /ctx\.effect\(/)
})

test('client talks to the documented RPC endpoint and actions', () => {
  assert.match(source, /\/dsh-dots\/rpc/)
  for (const action of ['getState', 'saveSettings', 'testConnection', 'push', 'preview', 'apply', 'listSnapshots', 'rollback']) {
    assert.ok(source.includes(action), `client.js 未使用 RPC action: ${action}`)
  }
})

test('client avoids removed DSH APIs and third-party UI libraries', () => {
  assert.ok(!source.includes('installSection'), '不得使用 ctx.settings.installSection')
  assert.ok(!source.includes('settings.plugin.item'), '不得使用 settings.plugin.item')
  for (const bad of ['antd', 'element-plus', '@arco-design', 'naive-ui']) {
    assert.ok(!source.includes(bad), `不得引入第三方 UI 库: ${bad}`)
  }
})

test('client renders no raw HTML (XSS 防护)', () => {
  assert.ok(!source.includes('dangerouslySetInnerHTML'), '不得使用 dangerouslySetInnerHTML')
})
