/**
 * 远程访问的**装配联调**测试：`rpc.ts` ← `remote/index.ts` ← service/auth/qr/probe/listener。
 *
 * 为什么需要它：`remote-rpc.test.mjs` 用的是假 `RemoteServiceLike`（只验证 RPC 转发语义），
 * `remote-service.test.mjs` 用假 listener/gate（只验证状态机）。两层都真的一起跑过，
 * 才说明"设置页点下去 → 真的能生成二维码 / 真的读到 6 种方式"这条链路没断。
 *
 * 这里**不起监听**（那会占端口、且由 e2e 脚本覆盖），只验证装配后的读取与生成路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createRemoteModule } from '../dist/remote/index.js'
import { createRpcService } from '../dist/rpc.js'

async function makeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-remote-int-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

async function makeRpc(t) {
  const home = await makeHome(t)
  const mod = createRemoteModule({ homeDir: home, webServer: { port: 3080 } })
  const service = createRpcService({ homeDir: home, remote: mod.service })
  t.after(async () => {
    await service.dispose()
    await mod.service.dispose()
  })
  return { home, service, mod }
}

test('联调：remoteGetState 走真实装配，返回 6 种方式 + 令牌已落盘 + 打码', async (t) => {
  const { home, service, mod } = await makeRpc(t)
  const res = await service.handleRpc({ action: 'remoteGetState' })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.data.modes.length, 6)
  assert.deepEqual(
    res.data.modes.map((item) => item.mode),
    ['lan', 'tailscale', 'ipv6', 'cloudflare', 'manual', 'uu'],
  )
  const uu = res.data.modes.find((item) => item.mode === 'uu')
  assert.equal(uu.availability, 'needs-setup', 'uu 已订正为「可用（需准备）」')
  assert.equal(uu.unavailableReason, '', 'uu 不再是 unsupported，unavailableReason 必须为空串')
  assert.deepEqual(
    uu.fields.map((field) => field.key),
    ['manualUrl', 'token'],
    'uu 复用 manualUrl 槽位 + 可选令牌',
  )
  assert.ok(uu.requires.length > 0 && uu.steps.length > 0, 'uu 必须给出前置条件与操作步骤')
  assert.equal(res.data.status.token.exists, true, '首次装配应自动生成令牌')
  assert.equal(res.data.settings.enabled, false, '默认关闭')

  // 令牌文件真的落在 home 下，且状态响应里没有明文
  const raw = JSON.parse(await readFile(mod.paths.tokenFile, 'utf8'))
  assert.equal(typeof raw.token, 'string')
  assert.equal(JSON.stringify(res).includes(raw.token), false, '状态响应不得含令牌明文')
})

test('联调：remoteSaveSettings 落盘 → getState 读回（端口/方式/地址都保留）', async (t) => {
  const { service } = await makeRpc(t)
  const saved = await service.handleRpc({
    action: 'remoteSaveSettings',
    settings: { enabled: true, mode: 'lan', lanAddress: '192.168.1.6', port: 3080 },
  })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(saved.data.settings.mode, 'lan')
  assert.equal(saved.data.settings.lanAddress, '192.168.1.6')
  assert.equal(saved.data.settings.port, 3080)

  const state = await service.handleRpc({ action: 'remoteGetState' })
  assert.equal(state.data.settings.enabled, true)
  assert.equal(state.data.settings.port, 3080)
})

test('联调：remoteShowLink 真的生成地址与二维码矩阵，且是唯一带 token 的出口', async (t) => {
  const { service, mod } = await makeRpc(t)
  await service.handleRpc({
    action: 'remoteSaveSettings',
    settings: { enabled: false, mode: 'lan', lanAddress: '192.168.1.6', port: 3080 },
  })
  const link = await service.handleRpc({ action: 'remoteShowLink' })
  assert.equal(link.ok, true, JSON.stringify(link))
  assert.match(link.data.url, /^https:\/\/192\.168\.1\.6:3080\/\?token=/, '旁挂监听已改为 HTTPS')
  assert.ok(link.data.qr.size >= 21 && link.data.qr.size <= 177, `二维码尺寸异常：${link.data.qr.size}`)
  assert.equal(link.data.qr.modules.length, link.data.qr.size)

  const tokenRecord = JSON.parse(await readFile(mod.paths.tokenFile, 'utf8'))
  assert.ok(link.data.url.includes(tokenRecord.token), 'showLink 是唯一允许出现明文 token 的出口')

  // 反证：其它 action 的响应里没有明文
  for (const action of ['remoteGetState', 'remoteDetectLan', 'remoteProbe']) {
    const res = await service.handleRpc({ action })
    assert.equal(JSON.stringify(res).includes(tokenRecord.token), false, `${action} 响应里出现了 token 明文`)
  }
})

test('联调：remoteDetectLan 返回网卡候选（不含通配地址）', async (t) => {
  const { service } = await makeRpc(t)
  const res = await service.handleRpc({ action: 'remoteDetectLan' })
  assert.equal(res.ok, true, JSON.stringify(res))
  const candidates = res.data.candidates
  assert.equal(Array.isArray(candidates), true)
  for (const item of candidates) {
    assert.notEqual(item.address, '0.0.0.0')
    assert.equal(['IPv4', 'IPv6'].includes(item.family), true)
    assert.equal(typeof item.iface, 'string')
    assert.equal(typeof item.virtual, 'boolean')
  }
})

test('联调：remoteProbe 走真实 probe，返回带 id/level 的结论且 verdict 非空', async (t) => {
  const { service } = await makeRpc(t)
  const res = await service.handleRpc({ action: 'remoteProbe', mode: 'lan' })
  assert.equal(res.ok, true, JSON.stringify(res))
  const probe = res.data
  assert.equal(['ok', 'warn', 'fail', 'unknown'].includes(probe.level), true)
  assert.ok(probe.checks.length > 0)
  for (const check of probe.checks) {
    assert.equal(typeof check.id, 'string')
    assert.equal(['ok', 'warn', 'fail', 'unknown'].includes(check.level), true)
    assert.ok(check.message.length > 0)
  }
  assert.ok(probe.verdict.length > 0)
})

test('联调：uu 有对外入口时 showLink 成功并带令牌；没入口时给中文原因', async (t) => {
  const { service, mod } = await makeRpc(t)

  // 1) 没填入口 → fail-closed，但原因是"还没填入口"，不是"这种方式不可用"
  await service.handleRpc({ action: 'remoteSaveSettings', settings: { enabled: false, mode: 'uu' } })
  const missing = await service.handleRpc({ action: 'remoteShowLink' })
  assert.equal(missing.ok, false, '没有入口时不该产出可打开地址')
  assert.equal(missing.error.code, 'E_INTERNAL')
  assert.match(missing.error.message, /还没填 UU 远程生成的对外入口/)

  // 2) 填了入口（就按 UU 界面里复制出来的 host:port 形态，不带协议）→ 直接能出链接
  const saved = await service.handleRpc({
    action: 'remoteSaveSettings',
    settings: { enabled: false, mode: 'uu', manualUrl: 'abc.uuyc.com:12345' },
  })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(saved.data.settings.mode, 'uu')
  assert.equal(saved.data.settings.manualUrl, 'abc.uuyc.com:12345', 'uu 的入口允许缺协议，原样保存')

  const link = await service.handleRpc({ action: 'remoteShowLink' })
  assert.equal(link.ok, true, JSON.stringify(link))
  assert.match(link.data.url, /^http:\/\/abc\.uuyc\.com:12345\/\?token=/)
  assert.ok(link.data.qr.size >= 21, '二维码仍然照常生成')

  const tokenRecord = JSON.parse(await readFile(mod.paths.tokenFile, 'utf8'))
  assert.ok(link.data.url.includes(tokenRecord.token), 'uu 链接同样带令牌（showLink 是唯一明文出口）')

  // 3) 令牌不进其它出口
  for (const action of ['remoteGetState']) {
    const res = await service.handleRpc({ action })
    assert.equal(JSON.stringify(res).includes(tokenRecord.token), false, `${action} 响应里出现了 token 明文`)
  }
})

test('联调：「访问令牌（可选）」落盘 → getState 只有 tokenSet/tokenMasked，showLink 用粘贴的令牌', async (t) => {
  const { service, mod } = await makeRpc(t)
  const PASTED = 'PastedToken-int-0123456789'

  const saved = await service.handleRpc({
    action: 'remoteSaveSettings',
    settings: { enabled: false, mode: 'lan', lanAddress: '192.168.1.6', port: 3080, token: PASTED },
  })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(saved.data.settings.tokenSet, true)
  assert.ok(saved.data.settings.tokenMasked.length > 0)
  assert.equal('token' in saved.data.settings, false, '设置视图里不允许出现 token 键')
  assert.equal(JSON.stringify(saved).includes(PASTED), false, 'saveSettings 响应里不许有令牌明文')

  const state = await service.handleRpc({ action: 'remoteGetState' })
  assert.equal(state.data.settings.tokenSet, true)
  assert.equal(JSON.stringify(state).includes(PASTED), false, 'getState 响应里不许有令牌明文')

  const link = await service.handleRpc({ action: 'remoteShowLink' })
  assert.equal(link.ok, true, JSON.stringify(link))
  assert.equal(link.data.url, 'https://192.168.1.6:3080/?token=' + PASTED, '链接里必须是粘贴的令牌（HTTPS）')
  assert.ok(link.data.qr.size >= 21, '二维码仍然照常生成')

  // 清除粘贴的令牌 → 回落到自动令牌（首次装配已落盘）
  await service.handleRpc({ action: 'remoteSaveSettings', settings: { token: '' } })
  const cleared = await service.handleRpc({ action: 'remoteGetState' })
  assert.equal(cleared.data.settings.tokenSet, false)
  const auto = JSON.parse(await readFile(mod.paths.tokenFile, 'utf8')).token
  const fallback = await service.handleRpc({ action: 'remoteShowLink' })
  assert.equal(fallback.ok, true, JSON.stringify(fallback))
  assert.ok(fallback.data.url.includes(auto), '清除后必须回落到自动生成的令牌')
  assert.equal(fallback.data.url.includes(PASTED), false, '清除后旧令牌不得再出现')
})
