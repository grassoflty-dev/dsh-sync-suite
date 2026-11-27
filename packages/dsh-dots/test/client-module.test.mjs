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
  // retarget（mod-plugin-dormant-panel-removal）：原清单含 dormant 旧面板独占的
  // testConnection / push / preview / apply / listSnapshots / rollback；旧面板删除后
  // shipped 客户端只调用下面这些 action，逐项钉住调用点而不是裸字符串。
  // retarget（mod-plugin-remote-live-connections，client-module.test.mjs:29）：
  // 面板不再请求历史审计 pairingConnections，改从 remoteGetState 的状态里读当前连接。
  for (const action of ['getState', 'saveSettings', 'remoteGetState', 'pairingProvision',
    'pairingTransports', 'pairingShow', 'pairingRotateToken',
    'remoteProbe', 'remoteStart', 'remoteStop']) {
    assert.ok(source.includes("rpcCall('" + action + "'"), `client.js 未调用 RPC action: ${action}`)
  }
  assert.equal(source.includes("rpcCall('pairingConnections'"), false, '历史审计 RPC 不得再被面板调用')
  assert.ok(source.includes('status.liveConnections'), '面板必须读 status.liveConnections（当前连接）')
  for (const dead of ['testConnection', 'push', 'preview', 'apply', 'listSnapshots', 'rollback']) {
    assert.equal(source.includes("rpcCall('" + dead + "'"), false, `dormant RPC 调用点不得复活: ${dead}`)
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
