import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createHttpHandler, createRpcService } from '../dist/rpc.js'

const PATCH = `# profile patch
- id: alpha
  config:
    value: 1
- id: beta
  config:
    value: 2
`

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gcs-confirm-'))
  const homeDir = path.join(root, 'home')
  const profileDir = path.join(root, 'profile')
  await mkdir(profileDir, { recursive: true })
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  await writeFile(patchFile, PATCH, 'utf8')
  const service = createRpcService({ homeDir, profileDir, dshVersion: 'test-1', allowLocalRepo: true })
  t.after(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  return { root, homeDir, profileDir, patchFile, service }
}

test('apply：缺少 confirm → E_CONFIRM_REQUIRED，且 profile 文件字节不变', async (t) => {
  const { patchFile, service } = await setup(t)
  const before = await readFile(patchFile)
  const cases = [
    {},
    { confirm: false },
    { confirm: 'true' },
    { confirm: 1 },
  ]
  for (const extra of cases) {
    const result = await service.handleRpc({
      action: 'apply',
      previewId: 'whatever',
      sourceDevice: 'pc-a',
      entries: ['alpha'],
      ...extra,
    })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'E_CONFIRM_REQUIRED', JSON.stringify(extra))
    assert.equal(result.error.details.action, 'apply')
  }
  const after = await readFile(patchFile)
  assert.deepEqual(after, before, '门禁失败不得写文件')
})

test('rollback：缺少 confirm → E_CONFIRM_REQUIRED，且快照/文件不被触碰', async (t) => {
  const { patchFile, service } = await setup(t)
  const before = await readFile(patchFile)
  const result = await service.handleRpc({ action: 'rollback', snapshotId: '20260101-000000' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'E_CONFIRM_REQUIRED')
  assert.deepEqual(await readFile(patchFile), before)
  const list = await service.handleRpc({ action: 'listSnapshots' })
  assert.equal(list.ok, true)
  assert.deepEqual(list.data.snapshots, [])
})

test('未知 action → E_UNKNOWN_ACTION；缺 action → E_VALIDATION', async (t) => {
  const { service } = await setup(t)
  const unknown = await service.handleRpc({ action: 'deleteEverything' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'E_UNKNOWN_ACTION')
  assert.equal(unknown.error.details.action, 'deleteEverything')

  const missing = await service.handleRpc({})
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'E_VALIDATION')
})

test('saveSettings：校验 repoUrl / deviceId / branch，非法值不落盘', async (t) => {
  const { service } = await setup(t)
  const base = {
    repoUrl: 'https://example.invalid/u/r.git',
    platform: 'github',
    authMode: 'https',
    deviceId: 'pc-a',
    branch: 'main',
    scope: { config: true, providers: true, plugins: true, mcp: true },
  }
  const badRepo = await service.handleRpc({
    action: 'saveSettings',
    settings: { ...base, repoUrl: 'ftp://example.invalid/x' },
  })
  assert.equal(badRepo.ok, false)
  assert.equal(badRepo.error.code, 'E_VALIDATION')

  const badDevice = await service.handleRpc({ action: 'saveSettings', settings: { ...base, deviceId: 'PC_A' } })
  assert.equal(badDevice.ok, false)
  assert.equal(badDevice.error.code, 'E_VALIDATION')

  const badBranch = await service.handleRpc({ action: 'saveSettings', settings: { ...base, branch: '  ' } })
  assert.equal(badBranch.ok, false)
  assert.equal(badBranch.error.code, 'E_VALIDATION')

  const localPath = await service.handleRpc({ action: 'saveSettings', settings: { ...base, repoUrl: 'C:\\repo\\x.git' } })
  assert.equal(localPath.ok, true, 'allowLocalRepo 允许本地路径（仅测试）')

  const good = await service.handleRpc({ action: 'saveSettings', settings: base, token: null })
  assert.equal(good.ok, true)
  assert.equal(good.data.settings.deviceId, 'pc-a')
  assert.equal(good.data.hasToken, false)
})

test('saveSettings：token 语义（空串/省略保留，null 清除，字符串覆盖）', async (t) => {
  const { service } = await setup(t)
  const settings = {
    repoUrl: 'https://example.invalid/u/r.git',
    platform: 'github',
    authMode: 'https',
    deviceId: 'pc-a',
    branch: 'main',
    scope: { config: true, providers: true, plugins: true, mcp: true },
  }
  const first = await service.handleRpc({ action: 'saveSettings', settings, token: 'test-token-not-real' })
  assert.equal(first.ok, true)
  assert.equal(first.data.hasToken, true)
  assert.ok(!JSON.stringify(first).includes('test-token-not-real'), '响应不得回显 token')

  const omit = await service.handleRpc({ action: 'saveSettings', settings })
  assert.equal(omit.data.hasToken, true, '不传 token 应保留')

  const empty = await service.handleRpc({ action: 'saveSettings', settings, token: '' })
  assert.equal(empty.data.hasToken, true, '空串应保留')

  const replace = await service.handleRpc({ action: 'saveSettings', settings, token: 'another-fake-token' })
  assert.equal(replace.data.hasToken, true)

  const clear = await service.handleRpc({ action: 'saveSettings', settings, token: null })
  assert.equal(clear.data.hasToken, false, 'null 应清除')

  const badToken = await service.handleRpc({ action: 'saveSettings', settings, token: 123 })
  assert.equal(badToken.ok, false)
  assert.equal(badToken.error.code, 'E_VALIDATION')
})

function makeRequest(body, method = 'POST') {
  const req = Readable.from([Buffer.from(body, 'utf8')])
  req.method = method
  req.headers = { host: '127.0.0.1:39228' }
  return req
}

function invokeHandler(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) this.body += String(chunk)
        resolve(this)
      },
    }
    handler(req, res)
  })
}

test('HTTP 层：恒 200 + JSON 错误体；非 POST 405；鉴权拒绝直接 403', async (t) => {
  const { service } = await setup(t)

  const handlerWithoutConnection = createHttpHandler(service)
  const gated = await invokeHandler(
    handlerWithoutConnection,
    makeRequest(JSON.stringify({ action: 'apply', previewId: 'x', sourceDevice: 'pc-a', entries: ['alpha'] })),
  )
  assert.equal(gated.statusCode, 200)
  assert.equal(gated.headers['content-type'], 'application/json; charset=utf-8')
  const gatedBody = JSON.parse(gated.body)
  assert.equal(gatedBody.ok, false)
  assert.equal(gatedBody.error.code, 'E_CONFIRM_REQUIRED')

  const badJson = await invokeHandler(handlerWithoutConnection, makeRequest('{not json'))
  assert.equal(badJson.statusCode, 200)
  assert.equal(JSON.parse(badJson.body).error.code, 'E_VALIDATION')

  const getReq = await invokeHandler(handlerWithoutConnection, makeRequest('', 'GET'))
  assert.equal(getReq.statusCode, 405)
  assert.equal(getReq.headers.allow, 'POST')

  const rejected = createHttpHandler(service, { requestRejection: () => 403 })
  const forbidden = await invokeHandler(rejected, makeRequest(JSON.stringify({ action: 'getState' })))
  assert.equal(forbidden.statusCode, 403)
  assert.equal(forbidden.body, '')

  const unauthorized = createHttpHandler(service, { requestRejection: () => 401 })
  const denied = await invokeHandler(unauthorized, makeRequest(JSON.stringify({ action: 'getState' })))
  assert.equal(denied.statusCode, 401)
})

test('index.ts：inject 声明与 ctx.effect 注册 / 清理（Cordis 函数插件形态）', async (t) => {
  const rooted = await setup(t)
  const index = await import('../dist/index.js')
  assert.deepEqual(index.inject, ['webServer', 'connection'])
  assert.equal(index.RPC_PATH, '/dsh-dots/rpc')
  assert.equal(typeof index.LEGACY_RPC_PATH, 'string', '必须导出旧路径兼容常量')
  assert.equal(typeof index.apply, 'function')

  const routes = []
  const effects = []
  const cleanups = []
  const unregistered = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          unregistered.push(route.path)
        }
      },
    },
    connection: {
      requestRejection(req) {
        return req.headers['x-test-forbidden'] === true ? 403 : undefined
      },
    },
    effect(effect, label) {
      effects.push(label)
      const cleanup = effect()
      cleanups.push(cleanup)
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }

  index.apply(ctx, { homeDir: rooted.homeDir, profileDir: rooted.profileDir, dshVersion: 'test-1' })
  assert.equal(routes.length, 2, '新路径 + legacy 路径两条 exact 路由都要注册')
  const newRoute = routes.find((r) => r.path === index.RPC_PATH)
  const legacyRoute = routes.find((r) => r.path === index.LEGACY_RPC_PATH)
  assert.ok(newRoute, '缺少新路径路由')
  assert.ok(legacyRoute, '缺少 legacy 路径路由')
  for (const [label, route] of [['新', newRoute], ['legacy', legacyRoute]]) {
    assert.equal(route.kind, 'exact', `${label} 路由必须 exact`)
    assert.equal(typeof route.handler, 'function', `${label} 路由 handler 必须可用`)
  }
  assert.equal(routes[0].path, '/dsh-dots/rpc', '保留原有新路径断言')
  assert.equal(
    effects.length,
    5,
    '新路由 + legacy 路由 + RPC dispose + 远程 dispose + 远程 autostart 各自包在 ctx.effect 里',
  )

  // 两条路由共用同一个 handler：ctx.connection.requestRejection 都首先生效
  for (const [label, route] of [['新', newRoute], ['legacy', legacyRoute]]) {
    const allowed = await invokeHandler(route.handler, makeRequest(JSON.stringify({ action: 'getState' })))
    assert.equal(allowed.statusCode, 200, `${label} 路由正常请求应 200`)
    assert.equal(JSON.parse(allowed.body).ok, true, `${label} 路由应返回 ok`)
    assert.equal(JSON.parse(allowed.body).data.settings.deviceId.length > 0, true)

    const forbiddenReq = makeRequest(JSON.stringify({ action: 'getState' }))
    forbiddenReq.headers['x-test-forbidden'] = true
    const forbidden = await invokeHandler(route.handler, forbiddenReq)
    assert.equal(forbidden.statusCode, 403, `${label} 路由 requestRejection 必须先生效`)
    assert.equal(forbidden.body, '')
  }

  // 清理时每条路由各自注销自己（不是只注销其中一条）
  for (const cleanup of cleanups) {
    if (typeof cleanup === 'function') cleanup()
  }
  assert.deepEqual(new Set(unregistered), new Set([index.RPC_PATH, index.LEGACY_RPC_PATH]))
})
