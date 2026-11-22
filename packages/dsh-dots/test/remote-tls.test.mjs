/**
 * mod-remote-tls-termination：插件侧 HTTPS 终结的 Node 集成测试（真起服务，不 mock TLS）。
 *
 * 覆盖：
 *   - HTTPS server 用 pairingTls 生成的证书提供服务，客户端拿到的 leaf 指纹 == 配对 pin；
 *   - 明文 HTTP 客户端打不进 TLS 端口（无法静默降级）；
 *   - 缺密钥材料 / 坏密钥材料 → typed E_REMOTE_TLS_SETUP_FAILED，端口根本不打开（fail-closed）；
 *   - 换证书后配对核对必然失败（model-level cert-swap detection）；
 *   - `verifyPairingAgainst` 的既有判定未被本模块改动（回归钉子）。
 *
 * token hygiene：测试里的 canary 令牌只用于断言"错误消息不回显"；证书 PEM/私钥内容
 * **永不**写进断言输出或日志（只比较哈希后的指纹）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { RemoteStartError, isBindableLanAddress, startRemoteListener } from '../dist/remote/listener.js'
import { generatePairingCertificate } from '../dist/remote/pairingTls.js'
import {
  buildPairingPayload,
  pairingFingerprintOf,
  verifyPairingAgainst,
} from '../dist/remote/pairingPayload.js'

function findLanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      const family = item.family
      if (family !== 'IPv4' && family !== 4) continue
      if (item.internal === true) continue
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(item.address)) continue
      if (item.address.startsWith('169.254.')) continue
      if (!isBindableLanAddress(item.address)) continue
      return item.address
    }
  }
  return null
}

const LAN = findLanAddress()
const SKIP = LAN === null ? '本机没有可绑定的非回环 IPv4' : false

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

async function startUpstream(t) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, via: 'upstream' }))
  })
  await listenOnce(server, 0, '127.0.0.1')
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

function colonFingerprint(der) {
  const hex = createHash('sha256').update(der).digest('hex').toUpperCase()
  return (hex.match(/.{2}/g) ?? []).join(':')
}

/** HTTPS 客户端；顺手记下服务端 leaf 的 DER 指纹，用来证明"用的就是那张生成的证书"。 */
function httpsRequest(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    let peerFingerprint = ''
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        agent: false,
        rejectUnauthorized: false, // 自签证书：这里只证明服务端用的证书字节，不做 CA 校验
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          // 在响应末读取 socket 上呈现的 leaf（ClientRequest 本身不转发 secureConnect）
          const socket = res.socket
          if (socket !== null && socket !== undefined && typeof socket.getPeerCertificate === 'function') {
            const peer = socket.getPeerCertificate()
            if (peer !== null && peer !== undefined && peer.raw !== undefined && peer.raw !== null) {
              peerFingerprint = colonFingerprint(peer.raw)
            }
          }
          let json = null
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            /* ignore */
          }
          resolve({ status: res.statusCode, json, peerFingerprint })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** 明文 HTTP 客户端：连 TLS 端口要么报错，要么绝不可能拿到 200 + 上游正文。 */
function plaintextRequest(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: '/x', method: 'GET', agent: false, timeout: 2000 },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('plaintext-timeout'))
    })
    req.end()
  })
}

/** 直接用明文字节打 TLS 端口：服务端不应回任何 HTTP 200。 */
function rawPlaintext(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host)
    let data = ''
    socket.setTimeout(1500)
    socket.on('connect', () => {
      socket.write('GET /x HTTP/1.1\r\nHost: plaintext-probe\r\nConnection: close\r\n\r\n')
    })
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1')
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve(data)
    })
    socket.on('error', () => resolve(data))
    socket.on('close', () => resolve(data))
  })
}

const TOKEN = 'a'.repeat(43)
function currentState(overrides = {}) {
  return {
    instanceId: 'gwl-pc',
    transport: 'lan',
    host: '192.168.1.6',
    port: 44996,
    token: TOKEN,
    tlsFingerprint: pairingFingerprintOf(generatePairingCertificate().certPem),
    announceRef: '',
    ...overrides,
  }
}

test('HTTPS 监听用生成的证书对外服务，leaf 指纹等于配对 pin', { skip: SKIP }, async (t) => {
  const cert = generatePairingCertificate()
  const upstream = await startUpstream(t)
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: upstream },
    tls: { cert: cert.certPem, key: cert.keyPem },
  })
  t.after(async () => {
    await handle.close()
  })

  const response = await httpsRequest(`https://${LAN}:${handle.port}/x`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { ok: true, via: 'upstream' })
  assert.equal(response.peerFingerprint, cert.fingerprint, '服务端 leaf 必须就是配对时固定的那张证书')
  assert.equal(pairingFingerprintOf(cert.certPem), cert.fingerprint, 'PEM 与 DER 指纹算法一致')
})

test('明文客户端打不进 TLS 端口（不存在明文回落）', { skip: SKIP }, async (t) => {
  const cert = generatePairingCertificate()
  const upstream = await startUpstream(t)
  const handle = await startRemoteListener({
    port: 0,
    bindAddress: LAN,
    upstream: { baseUrl: upstream },
    tls: { cert: cert.certPem, key: cert.keyPem },
  })
  t.after(async () => {
    await handle.close()
  })

  let plaintext = null
  try {
    plaintext = await plaintextRequest(`http://${LAN}:${handle.port}/x`)
  } catch (error) {
    // TLS 端口对明文请求报错关闭即符合预期
    assert.ok(['ECONNRESET', 'ECONNREFUSED', 'EPROTO', 'ERR_HTTP_REQUEST_TIMEOUT'].includes(error.code),
      `意料外的明文客户端错误：${String(error.code)}`)
  }
  if (plaintext !== null) {
    assert.notEqual(plaintext.status, 200, '明文请求绝不能拿到上游 200')
    assert.ok(!plaintext.text.includes('via'), '明文请求绝不能读到上游正文')
  }

  const raw = await rawPlaintext(handle.port, LAN)
  assert.ok(!raw.includes('HTTP/1.1 200'), '裸明文字节不能从 TLS 端口骗到 HTTP 200')
})

test('fail-closed：缺 TLS 入参 / 缺私钥 / 坏 PEM 都抛 typed 错误且不监听', async () => {
  const canary = 'SECRET-CANARY-9f3a'
  const base = { port: 0, bindAddress: LAN ?? '192.168.1.6', upstream: { baseUrl: 'http://127.0.0.1:1' } }

  for (const [label, tls] of [
    ['缺 tls', undefined],
    ['缺 key', { cert: '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n', key: '' }],
    ['坏 PEM', { cert: `not-a-pem ${canary}`, key: 'also-not-a-key' }],
  ]) {
    const failure = await startRemoteListener({ ...base, ...(tls === undefined ? {} : { tls }) }).then(
      () => null,
      (error) => error,
    )
    assert.ok(failure instanceof RemoteStartError, `${label} 应抛 RemoteStartError`)
    assert.equal(failure.code, 'E_REMOTE_TLS_SETUP_FAILED', label)
    assert.ok(!failure.message.includes(canary), '错误消息不得回显密钥材料的任何内容')
  }
})

test('换证书被配对模型拒绝：verifyPairingAgainst 报 E_PAIRING_FINGERPRINT_MISMATCH', () => {
  const pinned = generatePairingCertificate()
  const swapped = generatePairingCertificate()
  assert.notEqual(pinned.fingerprint, swapped.fingerprint, '两张证书必须不同（否则用例无意义）')

  const payload = buildPairingPayload(currentState({ tlsFingerprint: pinned.fingerprint }))
  const same = verifyPairingAgainst(payload, currentState({ tlsFingerprint: pinned.fingerprint }))
  assert.equal(same.ok, true, '同一张证书必须核对通过')
  const afterSwap = verifyPairingAgainst(payload, currentState({ tlsFingerprint: swapped.fingerprint }))
  assert.equal(afterSwap.ok, false)
  assert.equal(afterSwap.code, 'E_PAIRING_FINGERPRINT_MISMATCH')
  assert.equal(afterSwap.field, 'tlsFingerprint')
  assert.ok(!afterSwap.reason.includes(pinned.fingerprint), '拒绝原因不得回显指纹值')
})

test('verifyPairingAgainst 既有判定未被改动（回归钉子）', () => {
  const cert = generatePairingCertificate()
  const state = currentState({ tlsFingerprint: cert.fingerprint })
  const payload = buildPairingPayload(state)
  assert.equal(verifyPairingAgainst(payload, state).ok, true)

  for (const [field, override, code] of [
    ['port', { port: 44997 }, 'E_PAIRING_PORT_MISMATCH'],
    ['token', { token: 'b'.repeat(43) }, 'E_PAIRING_TOKEN_MISMATCH'],
    ['transport', { transport: 'ipv6' }, 'E_PAIRING_TRANSPORT_MISMATCH'],
  ]) {
    const result = verifyPairingAgainst(payload, currentState({ ...override, tlsFingerprint: cert.fingerprint }))
    assert.equal(result.ok, false, field)
    assert.equal(result.code, code, field)
    assert.equal(result.field, field)
  }
})
