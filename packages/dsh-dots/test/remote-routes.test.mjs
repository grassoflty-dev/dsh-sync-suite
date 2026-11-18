/**
 * `src/remote/routes.ts` 的分支穷举测试：鉴权是安全边界，这里必须把「放行」与
 * 「拒绝」两侧都钉死，且证明任何响应体里都不出现令牌明文与上游 cookie。
 *
 * 全部用假 gate（内存桩），不联网、不落盘。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteAuthorizer, REMOTE_PREFIX, stripTokenFromUrl } from '../dist/remote/routes.js'

const SESSION_COOKIE = 'dsh-remote-session'
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz012345'
const UPSTREAM = 'dsh-auth-abc123=session-value'
const SET_COOKIE = `${SESSION_COOKIE}=sess-value; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`

function makeGate(overrides = {}) {
  const state = {
    exchanges: [],
    failures: [],
    validCalls: 0,
    limitedAfter: Number.POSITIVE_INFINITY,
    validToken: TOKEN,
    acceptsCookie: false,
  }
  const gate = {
    exchange(token, nowMs) {
      state.exchanges.push({ token, nowMs })
      if (token === state.validToken) return { ok: true, setCookie: SET_COOKIE, reason: '' }
      return { ok: false, setCookie: '', reason: 'E_TOKEN' }
    },
    valid(cookieHeader, nowMs) {
      state.validCalls += 1
      void nowMs
      if (state.acceptsCookie && typeof cookieHeader === 'string' && cookieHeader.includes(`${SESSION_COOKIE}=sess-value`)) {
        return true
      }
      return false
    },
    fail(ip, nowMs) {
      state.failures.push(ip)
      void nowMs
      const limited = state.failures.length >= state.limitedAfter
      return { limited, retryAfterSec: limited ? 60 : 0 }
    },
    ...overrides,
  }
  return { gate, state }
}

function makeAuthorizer(gateOverrides = {}, optionOverrides = {}) {
  const { gate, state } = makeGate(gateOverrides)
  const authorize = createRemoteAuthorizer({
    gate,
    mode: () => 'lan',
    version: () => '1.0.0',
    upstreamCookie: () => UPSTREAM,
    ...optionOverrides,
  })
  return { authorize, gate, state }
}

function call(authorize, input) {
  return authorize({ method: 'GET', url: '/', headers: {}, remoteAddress: '192.168.1.50', ...input })
}

/* ------------------------------------------------------------------ health */

test('health：不带令牌也能取，且不泄露任何秘密', () => {
  const { authorize, state } = makeAuthorizer()
  const res = call(authorize, { url: `${REMOTE_PREFIX}health` })
  assert.equal(res.kind, 'respond')
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.deepEqual(payload, { ok: true, app: 'dsh-remote', mode: 'lan', version: '1.0.0' })
  assert.equal(state.exchanges.length, 0, 'health 不该消耗令牌')
  assert.equal(state.failures.length, 0, 'health 不该记失败')
})

test('health：非 GET → 405 JSON', () => {
  const { authorize } = makeAuthorizer()
  const res = call(authorize, { method: 'POST', url: `${REMOTE_PREFIX}health` })
  assert.equal(res.status, 405)
  assert.match(res.headers['content-type'], /application\/json/)
})

/* ------------------------------------------------------------------ 令牌入口 */

test('?token= 命中：303 到干净地址 + 下发会话 cookie，且不转发上游', () => {
  const { authorize } = makeAuthorizer()
  const res = call(authorize, { url: `/?token=${TOKEN}` })
  assert.equal(res.kind, 'respond')
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, '/')
  assert.equal(res.headers['set-cookie'], SET_COOKIE)
  assert.equal(res.body, '')
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('?token= 命中：保留路径与其它 query，只删 token', () => {
  const { authorize } = makeAuthorizer()
  const res = call(authorize, { url: `/workspace/a?token=${TOKEN}&tab=2#sec` })
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, '/workspace/a?tab=2#sec')
})

test('/__dsh_remote/login?token= 命中：回到首页而不是留在登录页', () => {
  const { authorize } = makeAuthorizer()
  const res = call(authorize, { url: `${REMOTE_PREFIX}login?token=${TOKEN}` })
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, '/')
})

test('?k= 与 ?token= 等价（auth.ts 的 TOKEN_PARAM 是 k）', () => {
  const { authorize } = makeAuthorizer()
  const res = call(authorize, { url: `/?k=${TOKEN}` })
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, '/')
  assert.equal(res.headers['set-cookie'], SET_COOKIE)
})

test('同时带 token 与 k：歧义输入 → 401，不做令牌比较', () => {
  const { authorize, state } = makeAuthorizer()
  const res = call(authorize, { url: `/?token=${TOKEN}&k=${TOKEN}` })
  assert.equal(res.status, 401)
  assert.equal(state.exchanges.length, 0)
  assert.equal(state.failures.length, 1)
})

test('?token= 不命中：401 页面，且响应体里没有令牌明文', () => {
  const { authorize, state } = makeAuthorizer()
  const bad = 'wrong-token-value'
  const res = call(authorize, { url: `/?token=${bad}` })
  assert.equal(res.status, 401)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.equal(res.body.includes(bad), false, '响应体不得回显用户输入')
  assert.equal(res.body.includes(TOKEN), false)
  assert.equal(state.failures.length, 1, '失败要计数（用于限速）')
})

test('?token= 连续失败到上限：429 + Retry-After', () => {
  const { authorize } = makeAuthorizer({}, {})
  call(authorize, { url: '/?token=bad' })
  const res = call(authorize, { url: '/?token=bad' })
  assert.notEqual(res.status, 429, '未达上限前仍是 401')
})

test('重复 token 参数（歧义输入）→ 401 并计数', () => {
  const { authorize, state } = makeAuthorizer()
  const res = call(authorize, { url: `/?token=${TOKEN}&token=${TOKEN}` })
  assert.equal(res.status, 401)
  assert.equal(state.exchanges.length, 0, '歧义输入不该进入令牌比较')
  assert.equal(state.failures.length, 1)
})

/* ------------------------------------------------------------------ 限速 */

test('失败达到阈值后返回 429，并带 retry-after 与中文提示', () => {
  const { gate } = makeGate()
  const authorize = createRemoteAuthorizer({
    gate: { ...gate, fail: () => ({ limited: true, retryAfterSec: 42 }) },
    mode: () => 'lan',
    upstreamCookie: () => UPSTREAM,
  })
  const res = call(authorize, { url: '/?token=bad' })
  assert.equal(res.status, 429)
  assert.equal(res.headers['retry-after'], '42')
  assert.match(res.body, /尝试过多/)
})

/* ------------------------------------------------------------------ 会话 */

test('会话 cookie 有效：放行，并且只注入上游 cookie', () => {
  const { authorize, state } = makeAuthorizer({}, {})
  state.acceptsCookie = true
  const res = call(authorize, { headers: { cookie: `${SESSION_COOKIE}=sess-value` } })
  assert.equal(res.kind, 'allow')
  assert.deepEqual(res.upstreamHeaders, { cookie: UPSTREAM })
})

test('会话 cookie 缺失或无效：401（/api 走 JSON）', () => {
  const { authorize } = makeAuthorizer()
  const res = call(authorize, { headers: {} })
  assert.equal(res.status, 401)
  assert.match(res.headers['content-type'], /text\/html/)
  const api = call(authorize, { url: '/api/sessions', headers: {} })
  assert.equal(api.status, 401)
  assert.match(api.headers['content-type'], /application\/json/)
  const payload = JSON.parse(api.body)
  assert.equal(payload.ok, false)
})

test('上游身份不可用（cookie 换不到）→ 503，绝不裸转发', () => {
  const { authorize, state } = makeAuthorizer({}, { upstreamCookie: () => null })
  state.acceptsCookie = true
  const res = call(authorize, { headers: { cookie: `${SESSION_COOKIE}=sess-value` } })
  assert.equal(res.kind, 'respond')
  assert.equal(res.status, 503)
  assert.equal(JSON.parse(res.body).error.code, 'E_UPSTREAM_IDENTITY')
})

/* ------------------------------------------------------------------ 命名空间 */

test('未鉴权的 /__dsh_remote/login 给登录页，但不计入失败（用户只是打开表单）', () => {
  const { authorize, state } = makeAuthorizer()
  const res = call(authorize, { url: `${REMOTE_PREFIX}login` })
  assert.equal(res.status, 401)
  assert.equal(res.body.includes('需要访问令牌'), true)
  assert.equal(state.failures.length, 0, '只打开登录页不该被限速')
})

test('未知的 /__dsh_remote/* 路径 → 404 JSON', () => {
  const { authorize } = makeAuthorizer()
  const res = call(authorize, { url: `${REMOTE_PREFIX}nope` })
  assert.equal(res.status, 404)
  assert.equal(JSON.parse(res.body).error.code, 'E_NOT_FOUND')
})

test('无法解析的请求目标 → 400', () => {
  const { authorize } = makeAuthorizer()
  const res = call(authorize, { url: 'http://[bad' })
  assert.equal(res.status, 400)
})

test('对端地址缺失时用 unknown 桶限速，不因此放行', () => {
  const { authorize, state } = makeAuthorizer()
  const res = call(authorize, { url: '/?token=bad', remoteAddress: '' })
  assert.equal(res.status, 401)
  assert.deepEqual(state.failures, ['unknown'])
})

/* ------------------------------------------------------------------ 卫生 */

test('任何响应体都不含令牌明文 / 上游 cookie / 会话 cookie 值', () => {
  const { authorize } = makeAuthorizer()
  const probes = [
    call(authorize, { url: '/?token=bad' }),
    call(authorize, { url: `${REMOTE_PREFIX}login` }),
    call(authorize, { url: '/api/x', headers: {} }),
    call(authorize, { url: `${REMOTE_PREFIX}health` }),
  ]
  for (const res of probes) {
    const text = `${res.body ?? ''}${JSON.stringify(res.headers ?? {})}`
    assert.equal(text.includes(TOKEN), false)
    assert.equal(text.includes('dsh-auth-'), false)
    assert.equal(text.includes('sess-value'), false)
  }
})

test('生成的响应都带 no-store / noindex', () => {
  const { authorize } = makeAuthorizer()
  const res = call(authorize, { url: `${REMOTE_PREFIX}health` })
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-robots-tag'], 'noindex')
})

test('stripTokenFromUrl 只删 token/k，保留其它部分', () => {
  assert.equal(stripTokenFromUrl('/a?token=x&b=1#c'), '/a?b=1#c')
  assert.equal(stripTokenFromUrl('/a?k=x&b=1'), '/a?b=1')
  assert.equal(stripTokenFromUrl('/a?b=1'), '/a?b=1')
  assert.equal(stripTokenFromUrl('http://[bad'), '/')
})
