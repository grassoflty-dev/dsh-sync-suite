/**
 * mod-plugin-pairing / 配对载荷：规范 JSON + 紧凑手输串 + typed 错误 + 主机归一 + 核对。
 * 全部 Node 单测，零网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PAIRING_KEYS,
  PairingError,
  authorizationHeaderForPairing,
  buildPairingPayload,
  describePairing,
  formatPairingText,
  normalisePairingFingerprint,
  normalisePairingHost,
  pairingChecksum,
  parsePairingPayload,
  serialisePairingPayload,
  verifyPairingAgainst,
} from '../dist/remote/pairingPayload.js'

const TOKEN = 'V4b2NzaGZmM0xaU1pYm5CV1dEeF9wQmFzZTY0dXJsMTIzNDU2Nzg=' .replace(/=/g, '').slice(0, 43)
const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'

function base(overrides = {}) {
  return buildPairingPayload({
    instanceId: 'gwl-pc',
    transport: 'tailscale',
    host: '100.101.102.103',
    port: 44996,
    token: TOKEN,
    tlsFingerprint: FP,
    announceRef: '',
    ...overrides,
  })
}

function expectCode(code, run) {
  try {
    run()
    assert.fail(`应当抛 ${code}`)
  } catch (error) {
    assert.ok(error instanceof PairingError, `应当是 PairingError，实际 ${error}`)
    assert.equal(error.code, code)
  }
}

test('P1：规范 JSON 往返逐字节稳定，键序固定为 v/instanceId/transport/host/port/token/tlsFingerprint/announceRef', () => {
  const payload = base()
  const canonical = serialisePairingPayload(payload)
  assert.deepEqual(Object.keys(JSON.parse(canonical)), [...PAIRING_KEYS])
  assert.equal(canonical, JSON.stringify(payload))
  assert.equal(serialisePairingPayload(parsePairingPayload(canonical)), canonical)
  assert.equal(canonical.indexOf('"token"') < canonical.indexOf('"tlsFingerprint"'), true)
})

test('P2：紧凑手输串往返与校验和', () => {
  const payload = base({ transport: 'lan', host: '192.168.1.6' })
  const text = formatPairingText(payload)
  assert.ok(text.startsWith('DSHDOTS1|'))
  assert.equal(parsePairingPayload(text).port, 44996)
  assert.equal(serialisePairingPayload(parsePairingPayload(text)), serialisePairingPayload(payload))
  const broken = text.slice(0, -1) + (text.endsWith('0') ? '1' : '0')
  expectCode('E_PAIRING_MALFORMED', () => parsePairingPayload(broken))
  assert.equal(pairingChecksum('abc').length, 8)
})

test('P3：每一种坏值都映射到自己的 typed 码（reason 不含值）', () => {
  const ok = JSON.parse(serialisePairingPayload(base()))
  const cases = [
    ['E_PAIRING_MALFORMED', 'this-is-not-json'],
    ['E_PAIRING_MALFORMED', '{}'],
    ['E_PAIRING_MALFORMED', JSON.stringify({ ...ok, extra: 'x' })],
    ['E_PAIRING_VERSION', JSON.stringify({ ...ok, v: 2 })],
    ['E_PAIRING_TRANSPORT', JSON.stringify({ ...ok, transport: 'wifi' })],
    ['E_PAIRING_HOST', JSON.stringify({ ...ok, host: 'http://100.101.102.103/' })],
    ['E_PAIRING_PORT', JSON.stringify({ ...ok, port: 0 })],
    ['E_PAIRING_TOKEN', JSON.stringify({ ...ok, token: 'short' })],
    ['E_PAIRING_FINGERPRINT', JSON.stringify({ ...ok, tlsFingerprint: 'AA:BB' })],
  ]
  for (const [code, input] of cases) expectCode(code, () => parsePairingPayload(input))
  // 值不回显：坏版本 + 真 token 同时出现，错误文本里也不许出现 token。
  try {
    parsePairingPayload(JSON.stringify({ ...ok, v: 2 }))
  } catch (error) {
    assert.equal(error instanceof PairingError, true)
    assert.equal(JSON.stringify(error).includes(TOKEN), false)
    assert.equal(error.message.includes(TOKEN), false)
    assert.match(error.reason, /版本/)
  }
})

test('P4：IPv6 加方括号 + RFC5952 压缩小写；IPv4 / 主机名小写归一', () => {
  const v6 = normalisePairingHost('2408:8207:1234:0000:0000:0000:0000:0001', 'ipv6')
  assert.equal(v6.ok, true)
  assert.equal(v6.value, '[2408:8207:1234::1]')
  const bracketed = normalisePairingHost('[2408:8207:1234::1]', 'ipv6')
  assert.equal(bracketed.value, v6.value)
  const lan = normalisePairingHost('192.168.001.6', 'lan')
  assert.equal(lan.ok, false, '前导零 IPv4 必须拒')
  const tailnet = normalisePairingHost('100.101.102.103', 'tailscale')
  assert.equal(tailnet.value, '100.101.102.103')
  assert.equal(normalisePairingHost('8.8.8.8', 'lan').ok, false, '局域网必须是 RFC1918')
  assert.equal(normalisePairingHost('[2408::1]', 'lan').ok, false, '局域网不许 IPv6')
  // 载荷里的 IPv6 也必须带方括号且往返稳定。
  const payload = base({ transport: 'ipv6', host: '2408:8207:1234::1' })
  assert.equal(payload.host, '[2408:8207:1234::1]')
  assert.equal(serialisePairingPayload(parsePairingPayload(serialisePairingPayload(payload))), serialisePairingPayload(payload))
})

test('P5：指纹接受无冒号 / 小写输入，统一 32 段大写冒号', () => {
  const flat = normalisePairingFingerprint(FP.replace(/:/g, '').toLowerCase())
  assert.equal(flat.value, FP)
  assert.equal(normalisePairingFingerprint('nope').ok, false)
})

test('P6：describePairing 是唯一脱敏视图；token 只进载荷与 Authorization', () => {
  const payload = base()
  const described = describePairing(payload)
  assert.equal(described.token, 'present')
  assert.equal(described.port, 44996)
  assert.equal(described.tlsFingerprint, FP)
  const text = JSON.stringify(described)
  assert.equal(text.includes(TOKEN), false)
  assert.equal(text.includes(serialisePairingPayload(payload)), false)
  assert.equal(serialisePairingPayload(payload).includes(TOKEN), true)
  assert.equal(authorizationHeaderForPairing(TOKEN), `Bearer ${TOKEN}`)
})

test('P7：verifyPairingAgainst —— 匹配 / 轮换后旧载荷失败 / 端口或证书变化也失败', () => {
  const payload = base()
  const current = {
    instanceId: 'gwl-pc', transport: 'tailscale', host: '100.101.102.103',
    port: 44996, token: TOKEN, tlsFingerprint: FP, announceRef: '',
  }
  assert.equal(verifyPairingAgainst(payload, current).ok, true)
  const rotated = verifyPairingAgainst(payload, { ...current, token: TOKEN.split('').reverse().join('') })
  assert.equal(rotated.ok, false)
  assert.equal(rotated.code, 'E_PAIRING_TOKEN_MISMATCH')
  assert.equal(rotated.reason.includes(TOKEN), false)
  assert.equal(verifyPairingAgainst(payload, { ...current, port: 44997 }).code, 'E_PAIRING_PORT_MISMATCH')
  assert.equal(verifyPairingAgainst(payload, { ...current, tlsFingerprint: FP.replace('AA', '01') }).code, 'E_PAIRING_FINGERPRINT_MISMATCH')
  assert.equal(verifyPairingAgainst('garbage', current).code, 'E_PAIRING_MALFORMED')
})
