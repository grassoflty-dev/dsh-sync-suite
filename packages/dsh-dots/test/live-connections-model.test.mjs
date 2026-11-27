/**
 * mod-plugin-remote-live-connections：「当前连接」纯模型的时钟注入测试。
 * 不监听端口、不读盘、不联网：所有时间来自注入的 `clock()`，断言全用 strict/equal。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LIVE_CONNECTION_WINDOW_MS,
  LIVE_TUNNEL_LEASE_MS,
  createLiveConnections,
} from '../dist/remote/connections.js'

const T0 = 1_800_000_000_000

function fixture(options = {}) {
  let now = T0
  const model = createLiveConnections({ clock: () => now, ...options })
  return {
    model,
    advance(ms) { now += ms },
    now: () => now,
  }
}

test('M1：首个请求生成一条记录；窗口内的重复请求折叠成同一条、id / since 不变', () => {
  const { model, advance } = fixture()
  const first = model.touch('192.168.1.11', 'http')
  advance(1_000)
  const second = model.touch('192.168.1.11', 'http')
  assert.equal(second.id, first.id, '同对端在窗口内必须复用 id')
  assert.equal(second.since, first.since, '首次出现时刻不能被后续请求改写')
  assert.equal(model.view().count, 1)
  assert.equal(model.view().connections.length, 1)
  assert.equal(model.view().connections[0].peer, '192.168.1.11')
  assert.equal(model.view().connections[0].transport, '局域网')
  assert.equal(model.view().connections[0].kind, 'http')
  assert.equal(LIVE_CONNECTION_WINDOW_MS, 15_000, '窗口常量固定为 15 秒')
})

test('M2：一次开页的 40 个资源请求突发只算一个对端', () => {
  const { model } = fixture()
  let id = ''
  for (let i = 0; i < 40; i += 1) {
    const entry = model.touch('192.168.1.11', 'http')
    if (id === '') id = entry.id
    assert.equal(entry.id, id)
  }
  const view = model.view()
  assert.equal(view.count, 1)
  assert.equal(view.connections.length, 1)
  assert.equal(view.connections[0].id, id)
})

test('M3：窗口内存活、超过窗口消失；读视图时剪枝', () => {
  const { model, advance } = fixture()
  model.touch('192.168.1.11', 'http')
  advance(14_000)
  assert.equal(model.view().count, 1, '14 秒内仍算连接')
  advance(1_001)
  assert.equal(model.view().count, 0, '超过 15 秒窗口必须消失')
  assert.equal(model.view().connections.length, 0)
})

// retarget（P2-2，live-connections-model.test.mjs:66）：旧末句「close 后立即 count 0」与
// 「不能删掉仍活跃的 HTTP 对端」冲突，改为同一 path:line 的更强断言——关闭后先降级为 http
// 保留，再按窗口剪掉；隧道保活两条原断言逐字不动。
test('M4：隧道长期保活，HTTP 突发不把它降级；关闭后按 HTTP 证据降级/剪掉', () => {
  const { model, advance } = fixture()
  const tunnel = model.touch('100.64.0.2', 'tunnel')
  assert.equal(tunnel.transport, 'Tailscale')
  // 真实 101 已到手才长期保活；否则未转正预约会被租约自动收口（P1-1 不变式）。
  model.confirm(tunnel.id)
  advance(60_000)
  model.touch('100.64.0.2', 'http')
  const alive = model.view()
  assert.equal(alive.count, 1, '有开放隧道时即使 lastSeen 过期也必须活着')
  assert.equal(alive.connections[0].kind, 'tunnel', 'HTTP 请求不能把隧道降级成普通请求')
  model.close(tunnel.id)
  const after = model.view()
  assert.equal(after.count, 1, '隧道期间刚有 HTTP 活动 → 关闭后不能抹掉活跃对端')
  assert.equal(after.connections[0].kind, 'http', 'socket 已关就不能仍标「正在查看」')
  advance(LIVE_CONNECTION_WINDOW_MS + 1)
  assert.equal(model.view().count, 0, '窗口到期后仍按窗口剪掉，不留僵死行')
})

test('M5：stop 清空；清空后视图为空而不是旧快照', () => {
  const { model } = fixture()
  model.touch('192.168.1.11', 'http')
  model.touch('2001:db8::1', 'tunnel')
  assert.equal(model.view().count, 2)
  model.clear()
  assert.deepEqual(model.view(), { connections: [], count: 0 })
})

test('M6：cap 截断 + 「还有 N 个」尾行文案（名字来自 locale，不是裸计数）', () => {
  const { model } = fixture({ cap: 2 })
  model.touch('192.168.1.11', 'http')
  model.touch('192.168.1.12', 'http')
  model.touch('192.168.1.13', 'http')
  model.touch('192.168.1.14', 'http')
  const view = model.view()
  assert.equal(view.connections.length, 2, '面板最多 2 行')
  assert.equal(view.count, 4, 'count 是截断前的真实总数')
  assert.equal(view.connections[0].peer, '192.168.1.14', '最新出现的排最前')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const zh = JSON.parse(readFileSync(path.join(here, '..', 'locale', 'zh.json'), 'utf8'))
  assert.equal(zh['lean.remote.live.more'].replace('{n}', String(view.count - view.connections.length)), '还有 2 个')
})

test('M7：字段脱敏——无 token、无 ?、无 URL；畸形输入退回 已脱敏', () => {
  const { model } = fixture()
  model.touch('192.168.1.11:443/?token=SUPERSECRET', 'http')
  model.touch('::ffff:192.168.1.12', 'http')
  const view = model.view()
  const text = JSON.stringify(view)
  assert.equal(text.includes('SUPERSECRET'), false)
  assert.equal(text.includes('?'), false, '任何字段都不许有查询串')
  assert.equal(text.includes('://'), false, '任何字段都不许有 URL')
  assert.equal(view.connections.length, 2)
  const byPeer = new Map(view.connections.map((item) => [item.peer, item]))
  assert.equal(byPeer.get('已脱敏').transport, '未知')
  assert.equal(byPeer.get('192.168.1.12').transport, '局域网', 'IPv4 映射写法按裸 IPv4 分类')
})

// P2-2：close 不能删掉隧道期间刚发过 HTTP 的对端；纯隧道才立刻退役。
test('M8：close 只在没有窗口内 HTTP 证据时退役条目；有证据则降级为 http', () => {
  const { model, advance } = fixture()
  const withHttp = model.touch('192.168.1.21', 'tunnel')
  advance(1_000)
  model.touch('192.168.1.21', 'http')
  model.close(withHttp.id)
  const view = model.view()
  assert.equal(view.connections.filter((c) => c.peer === '192.168.1.21').length, 1, '活跃对端不得随隧道关闭消失')
  assert.equal(view.connections.find((c) => c.peer === '192.168.1.21').kind, 'http')

  const pureTunnel = model.touch('192.168.1.22', 'tunnel')
  model.close(pureTunnel.id)
  const after = model.view()
  assert.equal(after.connections.some((c) => c.peer === '192.168.1.22'), false, '纯隧道关闭后立即退役')
  assert.equal(after.count, 1, '只留下有 HTTP 证据的那一条')
})

// P1-1 模型侧不变式：预约租约到期自动收口；已确认 socket 的隧道才长期保活。
test('M9：没人 close 的未转正预约按租约剪掉；confirm 后的隧道长期保活', () => {
  const { model, advance } = fixture()
  model.touch('192.168.1.31', 'tunnel')
  assert.equal(model.view().count, 1, '租约期内仍显示')
  advance(LIVE_TUNNEL_LEASE_MS + 1)
  assert.equal(model.view().count, 0, '模型自行收口，不依赖调用方记得 close')

  const confirmed = model.touch('192.168.1.32', 'tunnel')
  model.confirm(confirmed.id)
  advance(60_000)
  assert.equal(model.view().count, 1, '拿到 101 的隧道不能被租约剪掉')
  assert.equal(model.view().connections[0].kind, 'tunnel')
})
