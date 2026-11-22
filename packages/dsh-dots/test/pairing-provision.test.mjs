/**
 * mod-plugin-pairing / 自动配置：幂等、端口记录与重发、轮换、证书指纹、secret 卫生。
 * 全部 Node 单测：端口/网卡/令牌/证书全部注入，零网络、零安装、零 DSH 重启。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  PAIRING_PREFERRED_PORT,
  createPairingProvisioner,
} from '../dist/remote/pairingProvision.js'
import {
  describePairing,
  parsePairingPayload,
  verifyPairingAgainst,
} from '../dist/remote/pairingPayload.js'
import {
  fingerprintPairingCertificate,
  generatePairingCertificate,
} from '../dist/remote/pairingTls.js'
import { RemoteStore } from '../dist/remote/store.js'

const TOKEN = 'V4b2NzaGZmM0xaU1pYm5CV1dEeF9wQmFzZTY0dXJsMTIzNDU2Nzg'
const TOKEN2 = 'W5c3O2aIZG4Nc2bBmaW5DWXhFeV9xQmJzZTY0dXJsMTIzNDU2N2g'
const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const FP2 = '01:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const CERT_A = { certPem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n', keyPem: 'KEY-A', fingerprint: FP, createdAt: '2026-01-01T00:00:00.000Z' }
const CERT_B = { ...CERT_A, fingerprint: FP2, createdAt: '2026-06-01T00:00:00.000Z' }

function home() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-pairing-test-'))
}

function makeProvisioner(dir, overrides = {}) {
  const tokens = overrides.tokens ?? [TOKEN]
  let ti = 0
  const certs = overrides.certs ?? [CERT_A]
  let ci = 0
  return createPairingProvisioner({
    homeDir: dir,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    instanceId: 'gwl-pc',
    transport: 'lan',
    host: '192.168.1.6',
    isPortFree: overrides.isPortFree ?? (() => true),
    generateTokenFn: () => tokens[ti++] ?? tokens[tokens.length - 1],
    generateCertFn: () => certs[ci++] ?? certs[certs.length - 1],
    ...(overrides.onRepublish ? { onRepublish: overrides.onRepublish } : {}),
    ...(overrides.onTokenChanged ? { onTokenChanged: overrides.onTokenChanged } : {}),
  })
}

test('V1：两次 provision 完全幂等——同 token / 同证书指纹 / 同端口 / 同载荷，第二次无重发', async () => {
  const dir = home()
  try {
    const events = []
    const p = makeProvisioner(dir, { onRepublish: (e) => events.push(e) })
    const a = await p.provision()
    const b = await p.provision()
    assert.equal(a.state.token, TOKEN)
    assert.equal(b.state.token, TOKEN, '重启不得静默轮换令牌')
    assert.equal(b.state.tlsFingerprint, FP, '重启不得静默轮换证书')
    assert.equal(b.state.port, PAIRING_PREFERRED_PORT)
    assert.equal(b.payload, a.payload)
    assert.equal(b.changed.port, false)
    assert.equal(b.changed.token, false)
    assert.equal(b.changed.cert, false)
    assert.equal(b.republish, null)
    assert.equal(events.length, 1, '只有首次发布，第二次不重发')
    assert.equal(events[0].reason, 'first-publish')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('V2：端口记录进 remote.json；重掷后同 key 重发（不是静默 edit），空闲则不重掷', async () => {
  const dir = home()
  try {
    let occupied = false
    const events = []
    const p = makeProvisioner(dir, {
      isPortFree: (port) => port === (occupied ? PAIRING_PREFERRED_PORT + 1 : PAIRING_PREFERRED_PORT),
      onRepublish: (e) => events.push(e),
    })
    const a = await p.provision()
    assert.equal(a.state.port, PAIRING_PREFERRED_PORT)
    const stored = JSON.parse(readFileSync(path.join(dir, '.dsh', 'dots', 'remote.json'), 'utf8'))
    assert.equal(stored.port, PAIRING_PREFERRED_PORT, '选中的端口必须落盘，供公告与二维码共享')
    const b = await p.provision()
    assert.equal(b.state.port, PAIRING_PREFERRED_PORT, '端口空闲时不重掷')
    assert.equal(b.republish, null)
    occupied = true
    const c = await p.provision()
    assert.equal(c.state.port, PAIRING_PREFERRED_PORT + 1)
    assert.equal(c.republish.reason, 'port-changed')
    assert.equal(c.republish.previousPort, PAIRING_PREFERRED_PORT)
    assert.equal(c.republish.key, events[0].key, '同一个公告 key，新 payload')
    assert.equal(parsePairingPayload(c.republish.payload).port, c.state.port, '公告与二维码端口一致')
    assert.equal(events.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('V3：rotateToken 让旧载荷失效并触发重发；令牌门同步回调拿到新值', async () => {
  const dir = home()
  try {
    const changed = []
    const p = makeProvisioner(dir, {
      tokens: [TOKEN, TOKEN2],
      onTokenChanged: (e) => changed.push(e),
    })
    const a = await p.provision()
    const r = await p.rotateToken()
    assert.equal(r.state.token, TOKEN2)
    assert.equal(changed.some((e) => e.token === TOKEN2), true)
    assert.equal(r.republish.reason, 'token-rotated')
    const old = parsePairingPayload(a.payload)
    const current = {
      instanceId: r.state.instanceId, transport: r.state.transport, host: r.state.host,
      port: r.state.port, token: r.state.token, tlsFingerprint: r.state.tlsFingerprint,
      announceRef: r.state.announceRef,
    }
    const verdict = verifyPairingAgainst(old, current)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, 'E_PAIRING_TOKEN_MISMATCH')
    assert.equal(verdict.reason.includes(TOKEN2), false)
    assert.equal(verifyPairingAgainst(r.payload, current).ok, true, '新载荷仍然有效')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('V4：rotateCert 换指纹，旧载荷被 typed 拒绝', async () => {
  const dir = home()
  try {
    const p = makeProvisioner(dir, { certs: [CERT_A, CERT_B] })
    const a = await p.provision()
    const r = await p.rotateCert()
    assert.equal(r.state.tlsFingerprint, FP2)
    assert.equal(r.republish.reason, 'cert-rotated')
    const verdict = verifyPairingAgainst(parsePairingPayload(a.payload), {
      instanceId: r.state.instanceId, transport: r.state.transport, host: r.state.host,
      port: r.state.port, token: r.state.token, tlsFingerprint: r.state.tlsFingerprint,
      announceRef: r.state.announceRef,
    })
    assert.equal(verdict.code, 'E_PAIRING_FINGERPRINT_MISMATCH')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('V5：secret 卫生——视图 / 重发摘要 / describe 都不含 token 或私钥', async () => {
  const dir = home()
  try {
    const p = makeProvisioner(dir)
    const r = await p.provision()
    const safe = JSON.stringify({
      view: r.view,
      changed: r.changed,
      republish: { key: r.republish.key, reason: r.republish.reason, port: r.republish.port },
    })
    assert.equal(safe.includes(TOKEN), false)
    assert.equal(safe.includes('KEY-A'), false)
    assert.equal(JSON.stringify(describePairing(r.state)).includes(TOKEN), false)
    // 完整状态是 secret 容器，只有载荷 / text / 重发事件携带 token。
    assert.equal(r.payload.includes(TOKEN), true)
    assert.equal(r.republish.payload.includes(TOKEN), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('V6：自签证书是一套真 X.509（可被 Node 解析），指纹与载荷字段逐字节一致', () => {
  const cert = generatePairingCertificate({ now: () => new Date('2026-01-01T00:00:00.000Z') })
  const parsed = new X509Certificate(cert.certPem)
  assert.equal(parsed.subject, 'CN=DSH Dots Pairing')
  // Node 的 `.fingerprint` 是 SHA-1；TOFU pin 用 `.fingerprint256`（SHA-256）。
  assert.equal(parsed.fingerprint256, cert.fingerprint, 'Node 的 SHA-256 指纹必须等于我们的 TOFU pin')
  assert.equal(fingerprintPairingCertificate(cert.certPem), cert.fingerprint)
  assert.match(cert.fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/)
  assert.ok(cert.keyPem.includes('PRIVATE KEY'))
})

/** 读一个 DER TLV；只用于测试里独立提取"实际发出的 TBS"与签名，不复用编码器代码。 */
function readTlv(buffer, offset) {
  const tag = buffer[offset]
  let length = buffer[offset + 1]
  let header = 2
  if ((length & 0x80) !== 0) {
    const count = length & 0x7f
    length = 0
    for (let i = 0; i < count; i += 1) length = length * 256 + buffer[offset + 2 + i]
    header = 2 + count
  }
  const start = offset + header
  return { offset, tag, start, end: start + length, next: start + length }
}

test('V7：独立验签——对**实际发出的 DER** 用其自身公钥验证为真，篡改一字节后为假', () => {
  const cert = generatePairingCertificate({ now: () => new Date('2026-01-01T00:00:00.000Z') })
  const parsed = new X509Certificate(cert.certPem)
  const der = Buffer.from(cert.certPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64')
  const outer = readTlv(der, 0)
  assert.equal(outer.tag, 0x30)
  const tbs = readTlv(der, outer.start)
  const algorithm = readTlv(der, tbs.next)
  const signature = readTlv(der, algorithm.next)
  assert.equal(tbs.tag, 0x30)
  assert.equal(signature.tag, 0x03, '签名值必须是 BIT STRING')
  const sigBytes = der.subarray(signature.start + 1, signature.end) // 跳掉 unused-bits 字节
  assert.equal(sigBytes.length, 256, 'RSA-2048 签名应为 256 字节')

  // A) Node/OpenSSL 高层 API：自签证书用自身公钥验签通过。
  assert.equal(parsed.verify(parsed.publicKey), true)
  assert.equal(parsed.checkIssued(parsed), true)
  // B) 底层独立验证：签名针对的是 **emitted TBS 原字节**，不是内存里另算的一份。
  assert.equal(verify('sha256', der.subarray(tbs.offset, tbs.end), parsed.publicKey, sigBytes), true)

  // C) 篡改：翻转 issuer CN 里的一个 ASCII 字节，DER 仍可解析，但验签必须失败。
  const cnAt = der.indexOf(Buffer.from('DSH Dots Pairing', 'ascii'))
  assert.ok(cnAt > 0)
  const tampered = Buffer.from(der)
  tampered[cnAt] = (tampered[cnAt] + 1) & 0xff
  const parsedTampered = new X509Certificate(tampered)
  assert.notEqual(parsedTampered.fingerprint256, parsed.fingerprint256)
  assert.equal(parsedTampered.verify(parsedTampered.publicKey), false, '篡改后的证书不得验签通过')
  const tbsTampered = readTlv(tampered, outer.start)
  assert.equal(verify('sha256', tampered.subarray(tbsTampered.offset, tbsTampered.end), parsedTampered.publicKey, sigBytes), false)
})

test('V8：注入"选完端口后、重发前"失败——端口不落盘；重试重新推导同一端口并发出 port-changed', async () => {
  const dir = home()
  try {
    let seamWorks = true
    let occupied = false
    const events = []
    const p = createPairingProvisioner({
      homeDir: dir,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      instanceId: 'gwl-pc',
      interfaceSeam: { interfaces: () => seamWorks ? [{ name: 'WLAN', family: 'IPv4', address: '192.168.1.6' }] : [] },
      isPortFree: (port) => port === (occupied ? PAIRING_PREFERRED_PORT + 1 : PAIRING_PREFERRED_PORT),
      generateTokenFn: () => TOKEN,
      generateCertFn: () => CERT_A,
      onRepublish: (event) => events.push(event),
    })
    const first = await p.provision() // auto 模式：选择 lan
    assert.equal(first.state.port, PAIRING_PREFERRED_PORT)
    assert.equal(events[0].reason, 'first-publish')

    // 端口被迫改变，但网卡 seam 在 resolveEndpoint 处失败（重发之前）。
    occupied = true
    seamWorks = false
    await assert.rejects(p.provision(), /未检测到可用网络/)
    const afterFailure = JSON.parse(readFileSync(path.join(dir, '.dsh', 'dots', 'remote.json'), 'utf8'))
    assert.equal(afterFailure.port, PAIRING_PREFERRED_PORT, '失败时新端口绝不能先落盘')
    assert.equal(events.length, 1, '失败时不得发出重发事件')

    // 恢复 seam：重试必须重新推导同一端口，并发出同 key 的 port-changed。
    seamWorks = true
    const retry = await p.provision()
    assert.equal(retry.state.port, PAIRING_PREFERRED_PORT + 1)
    assert.equal(retry.republish.reason, 'port-changed')
    assert.equal(retry.republish.previousPort, PAIRING_PREFERRED_PORT)
    assert.equal(retry.republish.key, first.republish.key)
    assert.equal(events.length, 2)
    const third = await p.provision()
    assert.equal(third.republish, null, '发布成功后不再重复重发')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('V9：durable announcedPort 标记修复"重发成功但写盘失败"窗口（下次 run 重发而不是静默丢失）', async () => {
  const dir = home()
  try {
    const events = []
    const make = () => createPairingProvisioner({
      homeDir: dir,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      instanceId: 'gwl-pc',
      transport: 'lan', host: '192.168.1.6',
      isPortFree: () => true,
      generateTokenFn: () => TOKEN,
      generateCertFn: () => CERT_A,
      onRepublish: (event) => events.push(event),
    })
    const first = await make().provision()
    assert.equal(first.republish.reason, 'first-publish')

    // 模拟公告仍是旧端口：marker 回退一格，而 remote.json::port 保持新值。
    const store = new RemoteStore({ homeDir: dir })
    store.writePairingAnnouncement({
      v: 1, announcedPort: first.state.port - 1,
      announceRef: first.republish.announceRef, key: first.republish.key,
    })
    const repaired = await make().provision()
    assert.equal(repaired.republish.reason, 'port-changed')
    assert.equal(repaired.republish.previousPort, first.state.port - 1)
    assert.equal(repaired.republish.key, first.republish.key)
    assert.equal(store.readPairingAnnouncement().announcedPort, first.state.port)
    assert.equal((await make().provision()).republish, null, '修复后恢复幂等')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
