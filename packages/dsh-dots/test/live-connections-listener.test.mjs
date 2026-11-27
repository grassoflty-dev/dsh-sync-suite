/**
 * mod-plugin-remote-live-connections：listener 级双假对端测试。
 * **不绑真端口、不联网**：注入 serverFactory，用 loopback 风格的假 server / 假 socket 驱动
 * accept + request 两条路径；时钟也注入，所以"一个对端老化、另一个还在"完全可复现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { startRemoteListener } from '../dist/remote/listener.js'

const FAKE_TLS = {
  cert: '-----BEGIN CERTIFICATE-----\nTEST-CERT\n-----END CERTIFICATE-----',
  key: '-----BEGIN PRIVATE KEY-----\nTEST-KEY\n-----END PRIVATE KEY-----',
}
const TOKEN = 'SUPERSECRET-TOKEN'

function makeFakeServer(holder) {
  const server = new EventEmitter()
  server.keepAliveTimeout = 0
  server.headersTimeout = 0
  server.listen = () => { queueMicrotask(() => server.emit('listening')) }
  server.address = () => ({ address: '192.168.1.50', port: 44996 })
  server.close = (cb) => { if (typeof cb === 'function') cb() }
  holder.server = server
  return server
}

function makeFakeSocket(remoteAddress) {
  const socket = new EventEmitter()
  socket.remoteAddress = remoteAddress
  socket.setNoDelay = () => {}
  socket.destroy = () => {}
  socket.write = () => true
  socket.pause = () => {}
  socket.resume = () => {}
  return socket
}

/** 发一次假 HTTP 请求：url 故意带 token 与查询串，证明它们进不了状态载荷。 */
function emitRequest(server, remoteAddress, url) {
  const socket = makeFakeSocket(remoteAddress)
  const req = new EventEmitter()
  req.socket = socket
  req.headers = { host: '127.0.0.1:44996' }
  req.method = 'GET'
  req.url = url
  req.pause = () => {}
  const res = new EventEmitter()
  res.headersSent = false
  res.writableEnded = false
  res.writableFinished = true
  res.rawHeaders = []
  res.writeHead = () => res
  res.end = () => res
  server.emit('connection', socket)
  server.emit('request', req, res)
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('L1：两个假对端 → 状态同时反映两者；只刷新其中一个 → 另一个按窗口老化，stop 清空', async () => {
  let now = 1_900_000_000_000
  const holder = {}
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: '192.168.1.50',
    upstream: { baseUrl: 'http://127.0.0.1:1' },
    tls: FAKE_TLS,
    authorize: () => ({ kind: 'respond', status: 200, body: 'ok' }),
    liveClock: () => now,
    serverFactory: () => makeFakeServer(holder),
  })

  emitRequest(holder.server, '192.168.1.11', `/?token=${TOKEN}&x=1`)
  emitRequest(holder.server, '192.168.1.12', `/app.js?token=${TOKEN}`)
  await tick()
  const before = handle.stats().liveConnections
  assert.equal(before.count, 2, '两个假对端都必须在当前连接里')
  assert.equal(before.connections.length, 2)
  assert.deepEqual(
    before.connections.map((item) => item.peer).sort(),
    ['192.168.1.11', '192.168.1.12'],
    '状态必须逐字反映两个对端',
  )
  const payload = JSON.stringify(before)
  assert.equal(payload.includes(TOKEN), false, '状态载荷不得含 token')
  assert.equal(payload.includes('?'), false, '状态载荷不得含查询串')
  assert.equal(payload.includes('://'), false, '状态载荷不得含 URL')

  // 只让 192.168.1.12 在窗口内继续活动；192.168.1.11 不再有请求。
  now += 14_000
  emitRequest(holder.server, '192.168.1.12', `/style.css?token=${TOKEN}`)
  await tick()
  now += 2_000
  const after = handle.stats().liveConnections
  assert.equal(after.count, 1, '静默对端必须老化，不是永久在线')
  assert.equal(after.connections.length, 1)
  assert.equal(after.connections[0].peer, '192.168.1.12')
  assert.equal(JSON.stringify(after).includes(TOKEN), false)

  await handle.close()
  assert.deepEqual(handle.stats().liveConnections, { connections: [], count: 0 }, 'stop 后必须是空而不是残留')
})

/** 发一次假升级请求；带非法头值令 `http.request` 在拨号时同步抛错（评审 G5 的形状）。 */
function emitBrokenUpgrade(server, remoteAddress) {
  const socket = makeFakeSocket(remoteAddress)
  const req = new EventEmitter()
  req.socket = socket
  req.headers = { host: '127.0.0.1:44996', upgrade: 'websocket', 'x-probe-bad': 'bad\nvalue' }
  req.method = 'GET'
  req.url = '/ws?token=' + TOKEN
  req.pause = () => {}
  server.emit('connection', socket)
  server.emit('upgrade', req, socket, Buffer.alloc(0))
}

// P1-1 回归（评审 §6 G5）：拨号同步抛错的早退路径必须同时归还预约槽和活连接条目。
test('L2：拨号同步抛错 → tunnels:0 / reservedTunnels:0 且无幽灵行；推进 10⁷ ms 后仍为空', async () => {
  let now = 1_900_000_000_000
  const holder = {}
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: '192.168.1.50',
    upstream: { baseUrl: 'http://127.0.0.1:1' },
    tls: FAKE_TLS,
    liveClock: () => now,
    serverFactory: () => makeFakeServer(holder),
  })

  emitBrokenUpgrade(holder.server, '192.168.1.11')
  await tick()
  await tick()
  const before = handle.stats()
  assert.equal(before.tunnels, 0, '没有拿到 101，就不该有已建立隧道')
  assert.equal(before.reservedTunnels, 0, '同步抛错必须归还预约槽')
  assert.equal(before.liveConnections.count, 0, '同步抛错不得留下「正在查看」幽灵行')

  now += 10_000_000
  const after = handle.stats()
  assert.equal(after.tunnels, 0, '推进 10⁷ ms 后仍没有隧道')
  assert.equal(after.reservedTunnels, 0, '推进 10⁷ ms 后仍没有预约')
  assert.equal(after.liveConnections.count, 0, '推进 10⁷ ms 后幽灵行不得复活')
  assert.equal(JSON.stringify(after).includes(TOKEN), false, '状态载荷不得含 token')
  await handle.close()
})
