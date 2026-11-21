/**
 * mod-plugin-remote-tools：授权表语义测试。
 *
 * 覆盖：view 允许 / command 默认拒绝 / 吊销 / 过期 / 坏信封回落空表 /
 * per-instance 隔离 / 落盘在同步仓库之外 / 红acted 视图无 secret。
 * 全部从 dist 导入（dist 是交付物，构建窗口打开后再跑）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  canPrompt,
  decodeGrants,
  encodeGrants,
  grantActive,
  GRANT_ENVELOPE_VERSION,
  grantedTools,
  isGranted,
  normalizeGrant,
  redactGrant,
  revokeGrant,
  upsertGrant,
  GrantStore,
} from '../dist/remote/grants.js'
import { InstanceRegistry, sanitizeBaseUrl } from '../dist/remote/instances.js'

const INSTANCE = 'inst-0123456789abcdef'
const OTHER = 'inst-ffffffffffffffff'
const NOW = 5000

/** 造一条合法 view 授权（显式工具列表，view 永不隐含 command）。 */
function viewGrant(overrides = {}) {
  const result = normalizeGrant({
    grantId: 'g-1',
    instanceId: INSTANCE,
    principal: 'dots',
    tools: ['instance.list', 'session.list', 'session.info', 'session.events'],
    grantedAt: 1000,
    ...overrides,
  })
  assert.equal(result.ok, true, result.reason)
  return result.grant
}

async function tempHome(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-grants-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  return path.join(root, 'home')
}

test('view 授权：列工具与精确工具检查均为真', () => {
  const grants = [viewGrant()]
  assert.equal(isGranted(grants, INSTANCE, 'session.list', NOW), true)
  assert.equal(isGranted(grants, INSTANCE, 'session.info', NOW), true)
  assert.equal(isGranted(grants, INSTANCE, 'session.events', NOW), true)
  assert.equal(isGranted(grants, INSTANCE, 'instance.list', NOW), true)
  assert.deepEqual(grantedTools(grants, INSTANCE, NOW), [
    'instance.list', 'session.list', 'session.info', 'session.events',
  ])
})

test('command 默认拒绝：无授权 / 只有 view 授权时都拿不到 session.prompt', () => {
  assert.equal(isGranted([], INSTANCE, 'session.prompt', NOW), false, '空表一律拒绝')
  const viewOnly = [viewGrant()]
  assert.equal(isGranted(viewOnly, INSTANCE, 'session.prompt', NOW), false, 'view 永不隐含 command')
  assert.equal(canPrompt(viewOnly, INSTANCE, NOW), false)
  // 其余命令保留 id 同样默认拒绝
  for (const tool of ['session.create', 'session.lease.claim', 'session.lease.heartbeat', 'session.lease.release']) {
    assert.equal(isGranted(viewOnly, INSTANCE, tool, NOW), false, `${tool} 应默认拒绝`)
  }
})

test('显式列入 command 工具才生效（但本模块不注册对应 action，另测）', () => {
  const withCommand = viewGrant({ grantId: 'g-cmd', tools: ['session.list', 'session.prompt'] })
  assert.equal(canPrompt([withCommand], INSTANCE, NOW), true)
})

test('吊销：revokedAt 起失效，重复吊销保留更早时间', () => {
  const base = viewGrant()
  const revoked = revokeGrant([base], base.grantId, 2000)
  assert.equal(revoked.ok, true)
  assert.equal(grantActive(revoked.items[0], 1999), true)
  assert.equal(grantActive(revoked.items[0], 2000), false, 't >= revokedAt 即失效')
  assert.equal(isGranted(revoked.items, INSTANCE, 'session.list', NOW), false)
  // 重复吊销不得延后（写更早的时间也不会延长窗口）
  const again = revokeGrant(revoked.items, base.grantId, 9000)
  assert.equal(again.items[0].revokedAt, 2000)
  const later = revokeGrant(revoked.items, base.grantId, 1000)
  assert.equal(later.items[0].revokedAt, 1000, '更早的 revokedAt 生效（fail-closed 一侧）')
})

test('过期：expiresAt 起失效；未生效的 grantedAt 也不授权', () => {
  const expired = viewGrant({ expiresAt: 3000 })
  assert.equal(grantActive(expired, 2999), true)
  assert.equal(grantActive(expired, 3000), false)
  const future = viewGrant({ grantedAt: 8000 })
  assert.equal(isGranted([future], INSTANCE, 'session.list', NOW), false)
})

test('坏信封 → 空表 + typed problem（JSON 坏 / 版本错 / 记录坏）', () => {
  const badJson = decodeGrants('{oops')
  assert.equal(badJson.ok, false)
  assert.deepEqual(badJson.items, [])
  assert.equal(badJson.problem, 'E_GRANT_ENVELOPE_JSON')

  const badVersion = decodeGrants(JSON.stringify({ v: 99, items: [] }))
  assert.equal(badVersion.problem, 'E_GRANT_ENVELOPE_VERSION')
  assert.deepEqual(badVersion.items, [])

  const badItem = decodeGrants(JSON.stringify({
    v: GRANT_ENVELOPE_VERSION,
    items: [{ grantId: 'g', instanceId: INSTANCE, principal: 'dots', tools: ['bogus'], grantedAt: 1 }],
  }))
  assert.equal(badItem.problem, 'E_GRANT_ENVELOPE_ITEM')
  assert.deepEqual(badItem.items, [], '任何坏记录都整表回落空表')

  assert.equal(decodeGrants('').problem, 'E_GRANT_ENVELOPE_EMPTY')
})

test('per-instance 隔离：A 的授权不放行 B', () => {
  const grants = [viewGrant()]
  assert.equal(isGranted(grants, INSTANCE, 'session.list', NOW), true)
  assert.equal(isGranted(grants, OTHER, 'session.list', NOW), false)
  assert.deepEqual(grantedTools(grants, OTHER, NOW), [])
})

test('upsert 按 (instanceId, principal) 替换，不产生第二条并存授权', () => {
  const first = viewGrant({ grantId: 'g-1', tools: ['session.list'] })
  const second = viewGrant({ grantId: 'g-2', tools: ['session.info'] })
  const result = upsertGrant([first], second)
  assert.equal(result.ok, true)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].grantId, 'g-2')
  assert.deepEqual(result.items[0].tools, ['session.info'])
})

test('红acted 视图剥掉自由文本 note，view 授权 canPrompt 恒 false', () => {
  const granted = viewGrant({ note: '这是一段不该出现在视图里的备注' })
  const view = redactGrant(granted, NOW)
  assert.equal(view.canPrompt, false)
  assert.equal(view.active, true)
  assert.equal(Object.hasOwn(view, 'note'), false)
  assert.equal(JSON.stringify(view).includes('备注'), false)
})

test('store 落盘在插件状态目录（同步仓库之外），坏文件回落空表', async (t) => {
  const home = await tempHome(t)
  const store = new GrantStore({ homeDir: home })
  // 注入的 homeDir 必须逐字生效：路径 = <home>/.dsh/dots/instance-grants.json，
  // 不能是模块级常量把首次调用的 home 钉死（那会让授权表写进别的用户的状态目录）。
  const expected = path.join(home, '.dsh', 'dots', 'instance-grants.json').replace(/\\/g, '/')
  assert.equal(store.file.replace(/\\/g, '/'), expected)
  const other = new GrantStore({ homeDir: path.join(path.dirname(home), 'other-home') })
  assert.notEqual(other.file, store.file, '不同 homeDir 必须落到不同文件')
  assert.match(store.file.replace(/\\/g, '/'), /\/\.dsh\/dots\/instance-grants\.json$/)
  assert.equal(store.file.includes('work'), false)
  assert.equal(store.upsert(viewGrant()), true)
  const raw = await readFile(store.file, 'utf8')
  assert.equal(raw.includes('token'), false, '信封里没有任何 token 字段')
  assert.equal(store.isGranted(INSTANCE, 'session.list', NOW), true, '显式时间下 view 授权生效')

  // 手改坏文件 → 空表 + typed problem，且不再授权
  const { writeFile } = await import('node:fs/promises')
  await writeFile(store.file, '{broken', 'utf8')
  const reloaded = new GrantStore({ homeDir: home })
  assert.deepEqual(reloaded.list(), [])
  assert.equal(reloaded.lastProblem(), 'E_GRANT_ENVELOPE_JSON')
  assert.equal(reloaded.isGranted(INSTANCE, 'session.list', NOW), false)
})

test('store 的 revoke 立即生效（同一实例内吊销后读动作应被拒）', async (t) => {
  const home = await tempHome(t)
  const store = new GrantStore({ homeDir: home })
  const granted = viewGrant({ grantedAt: 100 })
  assert.equal(store.upsert(granted), true)
  assert.equal(store.isGranted(INSTANCE, 'session.list', NOW), true)
  assert.equal(store.revoke(granted.grantId, 4000), true)
  assert.equal(store.isGranted(INSTANCE, 'session.list', NOW), false)
  assert.equal(store.isGranted(INSTANCE, 'session.list', 3999), true)
})

test('实例 allow-list：只有登记过的 id 能解析出 token-free base，坏 URL 被拒', async (t) => {
  const home = await tempHome(t)
  const registry = new InstanceRegistry({ homeDir: home })
  assert.equal(registry.get('local')?.id, 'local')
  assert.equal(registry.get(OTHER), null, '未登记实例一律 null')
  assert.equal(registry.baseUrlOf(OTHER), null)
  assert.equal(registry.upsert({ id: INSTANCE, baseUrl: 'http://127.0.0.1:40596/?token=SECRET123456&k=EVIL', mode: 'lan', displayName: 'pc-b' }), true)
  assert.equal(registry.baseUrlOf(INSTANCE), 'http://127.0.0.1:40596/', 'token 类参数被剥掉')
  assert.equal(registry.get(INSTANCE)?.baseUrl.includes('SECRET123456'), false)
  assert.equal(sanitizeBaseUrl('javascript:alert(1)'), '')
  assert.equal(sanitizeBaseUrl('https://user:pw@example.com/'), '', 'userinfo 一律拒绝')
})
