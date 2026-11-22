/**
 * mod-plugin-pairing / 传输自动选择：优先级 + 可解释的 {available, reason} + 手动覆盖回落。
 * 网卡由 seam 注入，零网络、零真实接口依赖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TRANSPORT_REASON_COPY,
  TRANSPORT_PRIORITY,
  selectPairingTransport,
  transportReasonLines,
} from '../dist/remote/pairingTransport.js'

const seam = (interfaces) => ({ interfaces: () => interfaces })
const lan = { name: 'WLAN', family: 'IPv4', address: '192.168.1.6' }
const tail = { name: 'Tailscale', family: 'IPv4', address: '100.101.102.103' }
const v6 = { name: 'WLAN', family: 'IPv6', address: '2408:8207:1234::1' }
const virtual = { name: 'vEthernet (WSL)', family: 'IPv4', address: '172.20.1.9', virtual: true, internal: false }

test('T1：优先级 Tailscale > 局域网 > IPv6，三种同时存在时选 tailnet', () => {
  const selection = selectPairingTransport(seam([lan, v6, tail]))
  assert.deepEqual([...TRANSPORT_PRIORITY], ['tailscale', 'lan', 'ipv6'])
  assert.equal(selection.selected, 'tailscale')
  assert.equal(selection.selectedHost, '100.101.102.103')
  assert.equal(selection.candidates.tailscale.available, true)
  assert.equal(selection.candidates.lan.available, true)
  assert.equal(selection.candidates.ipv6.available, true)
  assert.equal(selection.candidates.ipv6.host, '[2408:8207:1234::1]', 'IPv6 候选已加方括号')
  assert.equal(selection.overrideUnavailable, false)
})

test('T2：只有局域网时给出三条可解释理由 + 局域网也要令牌的产品说明', () => {
  const selection = selectPairingTransport(seam([lan, virtual]))
  assert.equal(selection.selected, 'lan')
  assert.equal(selection.selectedHost, '192.168.1.6')
  assert.equal(selection.candidates.tailscale.available, false)
  assert.equal(selection.candidates.tailscale.reason, TRANSPORT_REASON_COPY.tailscaleOff)
  assert.equal(selection.candidates.ipv6.available, false)
  assert.equal(selection.candidates.ipv6.reason, TRANSPORT_REASON_COPY.ipv6Off)
  const lines = transportReasonLines(selection)
  assert.equal(lines.length, 4)
  assert.ok(lines.includes('Tailscale：平板需加入同一 tailnet'))
  assert.ok(lines.includes('IPv6：本机需有 IPv6，部分运营商屏蔽入站'))
  assert.ok(lines.includes('局域网：同一 Wi-Fi'))
  assert.match(lines[3], /令牌阻止同一网络里的其他人控制这台 DSH/, '必须解释 LAN 也要 token')
  assert.match(lines[3], /不用手输/, '必须解释端口与令牌在二维码里')
})

test('T3：手动覆盖可用时生效，不可用时回落自动选择（绝不给出死地址）', () => {
  const onlyLan = seam([lan])
  const okOverride = selectPairingTransport(onlyLan, { override: 'lan' })
  assert.equal(okOverride.requested, 'lan')
  assert.equal(okOverride.selected, 'lan')
  assert.equal(okOverride.overrideUnavailable, false)
  const badOverride = selectPairingTransport(onlyLan, { override: 'tailscale' })
  assert.equal(badOverride.overrideUnavailable, true)
  assert.equal(badOverride.selected, 'lan', '回落自动选择')
  assert.equal(badOverride.selectedHost, '192.168.1.6')
})

test('T4：没有可用网卡 → selected=null 且三行前置条件齐全（UI 灰掉并解释）', () => {
  const selection = selectPairingTransport(seam([]))
  assert.equal(selection.selected, null)
  assert.equal(selection.selectedHost, '')
  assert.equal(selection.candidates.tailscale.available, false)
  assert.equal(selection.candidates.lan.available, false)
  assert.equal(selection.candidates.ipv6.available, false)
  const lines = transportReasonLines(selection)
  assert.equal(lines[0], 'Tailscale：平板需加入同一 tailnet')
  assert.equal(lines[1], '局域网：同一 Wi-Fi')
  assert.equal(lines[2], 'IPv6：本机需有 IPv6，部分运营商屏蔽入站')
})

test('T5：IPv4 通配 / 回环 / ULA / 链路本地不冒充可用候选', () => {
  const selection = selectPairingTransport(seam([
    { name: 'Ethernet', family: 'IPv4', address: '0.0.0.0', internal: false },
    { name: 'Loopback', family: 'IPv4', address: '127.0.0.1', internal: false },
    { name: 'Ethernet', family: 'IPv6', address: 'fe80::1', internal: false },
    { name: 'Ethernet', family: 'IPv6', address: 'fd00::1', internal: false },
  ]))
  assert.equal(selection.selected, null)
})
