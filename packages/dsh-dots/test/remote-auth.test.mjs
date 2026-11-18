/**
 * `dist/remote/auth.js` 的单测：认证门（token → Cookie 会话 + 按 IP 限速）。
 *
 * 覆盖重点：常量时间比较、token 生成/轮换、Cookie 签发与属性、会话过期（`now` 注入，不 sleep）、
 * 伪造/缺失 Cookie、滑动 60s 限速窗口、Cookie 头解析的坏格式，以及"token 明文永不外泄"这条红线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  DEFAULT_MAX_FAILURES_PER_MINUTE,
  DEFAULT_TOKEN_TTL_MS,
  FAILURE_WINDOW_MS,
  RemoteAuth,
  SESSION_COOKIE_ALIAS,
  SESSION_COOKIE_NAME,
  TOKEN_PARAM,
  buildSessionCookie,
  generateToken,
  isLoopback,
  parseCookieHeader,
  timingSafeEqualText,
  tokenFingerprint,
} from '../dist/remote/auth.js'

const BASE64URL = /^[A-Za-z0-9_-]+$/

/** 从 `Set-Cookie` 值里取出会话 id。 */
function sessionIdOf(setCookie) {
  const m = /^([A-Za-z0-9_~.-]+)=([^;]*)/.exec(setCookie)
  assert.ok(m, `unexpected Set-Cookie: ${setCookie}`)
  return { name: m[1], value: m[2] }
}

test('timingSafeEqualText：相等/不等/长度不等/空串都按约定返回', async (t) => {
  await t.test('相同字符串 → true', () => {
    assert.equal(timingSafeEqualText('correct-horse-battery-staple', 'correct-horse-battery-staple'), true)
    assert.equal(timingSafeEqualText('a', 'a'), true)
  })

  await t.test('内容不同但长度相同 → false', () => {
    assert.equal(timingSafeEqualText('abcdef', 'abcdeg'), false)
    // 只差最后一位，验证没有"提前相等"的短路
    assert.equal(timingSafeEqualText('0'.repeat(64) + 'a', '0'.repeat(64) + 'b'), false)
  })

  await t.test('长度不等 → false（且不抛错）', () => {
    assert.equal(timingSafeEqualText('abc', 'abcd'), false)
    assert.equal(timingSafeEqualText('abcd', 'abc'), false)
    assert.equal(timingSafeEqualText('a'.repeat(500), 'a'.repeat(501)), false)
  })

  await t.test('空串：空 vs 空为真，空 vs 非空为假', () => {
    assert.equal(timingSafeEqualText('', ''), true)
    assert.equal(timingSafeEqualText('', 'a'), false)
    assert.equal(timingSafeEqualText('a', ''), false)
  })

  await t.test('非字符串入参按空串处理，不抛 TypeError', () => {
    assert.equal(timingSafeEqualText(undefined, ''), true)
    assert.equal(timingSafeEqualText(null, 'a'), false)
  })
})

test('generateToken：默认 32 字节 → 43 字符 base64url，且每次不同', async (t) => {
  await t.test('默认长度与字符集', () => {
    const token = generateToken()
    assert.equal(token.length, 43)
    assert.match(token, BASE64URL)
    assert.ok(!token.includes('='))
  })

  await t.test('两次生成不同（256bit 熵）', () => {
    const seen = new Set()
    for (let i = 0; i < 64; i++) seen.add(generateToken())
    assert.equal(seen.size, 64)
  })

  await t.test('指定字节数：16 → 22、64 → 86', () => {
    assert.equal(generateToken(16).length, 22)
    assert.equal(generateToken(64).length, 86)
  })

  await t.test('越界字节数抛 RangeError（不静默降级成弱 token）', () => {
    assert.throws(() => generateToken(4), RangeError)
    assert.throws(() => generateToken(4096), RangeError)
    assert.throws(() => generateToken(Number.NaN), RangeError)
  })
})

test('parseCookieHeader：多 cookie / 空格 / 重复键 / 坏格式', async (t) => {
  await t.test('两个 cookie', () => {
    assert.deepEqual(parseCookieHeader('a=1; b=2'), { a: '1', b: '2' })
  })

  await t.test('空格与尾随分号', () => {
    assert.deepEqual(parseCookieHeader('  a = 1 ; b=2 ;; '), { a: '1', b: '2' })
  })

  await t.test('重复键后者覆盖', () => {
    assert.deepEqual(parseCookieHeader('a=1; a=2'), { a: '2' })
  })

  await t.test('坏格式被跳过而不抛错', () => {
    assert.deepEqual(parseCookieHeader('novalue; =empty; a=1'), { a: '1' })
    assert.deepEqual(parseCookieHeader(';;;'), {})
    assert.deepEqual(parseCookieHeader('__proto__=polluted; b=2'), { b: '2' })
    assert.equal({}.polluted, undefined)
  })

  await t.test('值里含等号、引号值、百分号编码', () => {
    assert.deepEqual(parseCookieHeader('a=b=c'), { a: 'b=c' })
    assert.deepEqual(parseCookieHeader('a="quoted"'), { a: 'quoted' })
    assert.deepEqual(parseCookieHeader('a=x%20y'), { a: 'x y' })
    assert.deepEqual(parseCookieHeader('a=bad%zz'), { a: 'bad%zz' })
  })

  await t.test('无头 / 空串 → 空对象', () => {
    assert.deepEqual(parseCookieHeader(undefined), {})
    assert.deepEqual(parseCookieHeader(''), {})
    assert.deepEqual(parseCookieHeader(null), {})
  })
})

test('buildSessionCookie：属性齐全（HttpOnly / SameSite=Lax / Path=/ / Max-Age）', async (t) => {
  await t.test('12h 的默认 TTL', () => {
    const cookie = buildSessionCookie('abc123', DEFAULT_TOKEN_TTL_MS)
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=abc123; `))
    assert.match(cookie, /Path=\//)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Max-Age=43200/)
    assert.ok(!/Secure/.test(cookie), '局域网 http 下不能加 Secure，否则浏览器不回传')
  })

  await t.test('毫秒 → 秒向下取整；非法 TTL 退化成 0', () => {
    assert.match(buildSessionCookie('v', 1500), /Max-Age=1$/)
    assert.match(buildSessionCookie('v', Number.NaN), /Max-Age=0$/)
    assert.match(buildSessionCookie('v', -5), /Max-Age=0$/)
  })

  await t.test('值里的非法字符走百分号编码（防拼头注入）', () => {
    assert.match(buildSessionCookie('a;b', 1000), /=a%3Bb;/)
  })
})

test('isLoopback：只认回环字面量', async (t) => {
  await t.test('回环地址 → true', () => {
    for (const ip of ['127.0.0.1', '::1', '127.0.0.5', '127.1.2.3', '::ffff:127.0.0.1', '[::1]', '::1%lo0']) {
      assert.equal(isLoopback(ip), true, ip)
    }
  })

  await t.test('非回环 → false', () => {
    for (const ip of ['192.168.1.2', '10.0.0.1', '::2', '0.0.0.0', 'localhost', '', 'fe80::1', '2001:db8::1']) {
      assert.equal(isLoopback(ip), false, ip)
    }
    assert.equal(isLoopback(undefined), false)
  })
})

test('exchangeToken：正确 token 签发会话；错误/缺失 fail-closed', async (t) => {
  await t.test('正确 token → 会话 cookie，属性齐全', () => {
    const auth = new RemoteAuth()
    const token = auth.setToken('t'.repeat(43))
    const res = auth.exchangeToken(token)
    assert.equal(res.ok, true)
    assert.equal(res.reason, undefined)
    const { name, value } = sessionIdOf(res.cookie)
    assert.equal(name, SESSION_COOKIE_NAME)
    assert.equal(value.length, 43)
    assert.match(res.cookie, /HttpOnly/)
    assert.match(res.cookie, /SameSite=Lax/)
    assert.match(res.cookie, /Path=\//)
    assert.match(res.cookie, /Max-Age=43200/)
    // 兼容别名也一并下发
    assert.equal(res.cookies.length, 2)
    assert.equal(sessionIdOf(res.cookies[1]).name, SESSION_COOKIE_ALIAS)
    assert.equal(auth.sessionCount(), 1)
    assert.equal(auth.checkCookie(`${SESSION_COOKIE_NAME}=${value}`), true)
  })

  await t.test('错误 token → ok:false / invalid-token，且不签发会话', () => {
    const auth = new RemoteAuth()
    auth.setToken('right-token-value')
    const res = auth.exchangeToken('wrong-token-value')
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'invalid-token')
    assert.equal(res.cookie, undefined)
    assert.equal(auth.sessionCount(), 0)
  })

  await t.test('空 / 非字符串 token → missing-token', () => {
    const auth = new RemoteAuth()
    for (const bad of ['', undefined, null, 42]) {
      const res = auth.exchangeToken(bad)
      assert.equal(res.ok, false)
      assert.equal(res.reason, 'missing-token')
    }
  })

  await t.test('返回值里永不出现 token 明文', () => {
    const auth = new RemoteAuth()
    const token = auth.setToken('super-secret-token-1234567890')
    const ok = auth.exchangeToken(token)
    const bad = auth.exchangeToken('nope')
    assert.ok(!JSON.stringify(ok).includes('super-secret-token'))
    assert.ok(!JSON.stringify(bad).includes('nope'))
    assert.ok(!JSON.stringify(bad).includes('super-secret-token'))
  })
})

test('checkCookie / inspectCookie：有效 / 过期 / 伪造 / 缺失', async (t) => {
  const ttl = 1000
  const t0 = 1_700_000_000_000
  const setup = () => {
    const auth = new RemoteAuth({ tokenTtlMs: ttl })
    auth.setToken('k'.repeat(43))
    const res = auth.exchangeToken('k'.repeat(43), t0)
    return { auth, id: sessionIdOf(res.cookie).value }
  }

  await t.test('有效会话（TTL 内）→ true / ok', () => {
    const { auth, id } = setup()
    assert.equal(auth.checkCookie(`${SESSION_COOKIE_NAME}=${id}`, t0 + 999), true)
    assert.deepEqual(auth.inspectCookie(`${SESSION_COOKIE_NAME}=${id}`, t0 + 999), { ok: true, reason: 'ok' })
  })

  await t.test('过期（now 注入越过 TTL）→ false / expired，并顺手删除', () => {
    const { auth, id } = setup()
    // 先问诊断（会话还在，能判成 expired），再问布尔校验（此时已被删除 → false）
    assert.deepEqual(auth.inspectCookie(`${SESSION_COOKIE_NAME}=${id}`, t0 + ttl), { ok: false, reason: 'expired' })
    assert.equal(auth.checkCookie(`${SESSION_COOKIE_NAME}=${id}`, t0 + ttl), false)
    // 已删除 → 再问就是 invalid，而不是又报 expired
    assert.deepEqual(auth.inspectCookie(`${SESSION_COOKIE_NAME}=${id}`, t0 + ttl + 1), { ok: false, reason: 'invalid' })
    assert.equal(auth.sessionCount(), 0)
  })

  await t.test('无 cookie / 无会话键 → missing', () => {
    const { auth } = setup()
    for (const header of [undefined, '', 'other=1', `${SESSION_COOKIE_NAME}=`]) {
      assert.equal(auth.checkCookie(header), false)
      assert.deepEqual(auth.inspectCookie(header), { ok: false, reason: 'missing' })
    }
  })

  await t.test('伪造的会话 id → invalid', () => {
    const { auth } = setup()
    const fake = generateToken()
    assert.equal(auth.checkCookie(`${SESSION_COOKIE_NAME}=${fake}`), false)
    assert.deepEqual(auth.inspectCookie(`${SESSION_COOKIE_NAME}=${fake}`), { ok: false, reason: 'invalid' })
  })

  await t.test('多 cookie 头里也能取到会话；兼容别名同样可用', () => {
    const { auth, id } = setup()
    assert.equal(auth.checkCookie(`theme=dark; ${SESSION_COOKIE_NAME}=${id}; lang=zh`, t0 + 1), true)
    assert.equal(auth.checkCookie(`${SESSION_COOKIE_ALIAS}=${id}`, t0 + 1), true)
  })

  await t.test('会话不滑动续期：TTL 到点即死', () => {
    const { auth, id } = setup()
    assert.equal(auth.checkCookie(`${SESSION_COOKIE_NAME}=${id}`, t0 + 900), true)
    assert.equal(auth.checkCookie(`${SESSION_COOKIE_NAME}=${id}`, t0 + 1001), false)
  })
})

test('token 轮换：旧 token 立即失效，会话一并吊销，指纹随之变化', async (t) => {
  await t.test('setToken 后旧 token 换不到新会话', () => {
    const auth = new RemoteAuth()
    const first = auth.setToken()
    const res1 = auth.exchangeToken(first)
    assert.equal(res1.ok, true)
    const id = sessionIdOf(res1.cookie).value

    const second = auth.setToken()
    assert.notEqual(second, first)
    assert.equal(auth.exchangeToken(first).ok, false)
    assert.equal(auth.exchangeToken(first).reason, 'invalid-token')
    assert.equal(auth.exchangeToken(second).ok, true)
    // 轮换动机是"旧链接可能泄露"，因此旧会话必须一起吊销
    assert.equal(auth.checkCookie(`${SESSION_COOKIE_NAME}=${id}`), false)
  })

  await t.test('currentTokenFingerprint = sha256(token) 前 8 位，且不含明文', () => {
    const auth = new RemoteAuth()
    const token = auth.setToken('fingerprint-me-please')
    const expected = createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 8)
    assert.equal(auth.currentTokenFingerprint(), expected)
    assert.equal(auth.currentTokenFingerprint(), tokenFingerprint(token))
    assert.equal(auth.currentTokenFingerprint().length, 8)
    assert.ok(!auth.currentTokenFingerprint().includes(token))
    assert.equal(tokenFingerprint(''), '')
  })

  await t.test('maskedToken 只露前 4 位 + 长度', () => {
    const auth = new RemoteAuth()
    const token = auth.setToken('abcdEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg')
    const masked = auth.maskedToken()
    assert.equal(masked, `abcd…(${token.length} chars)`)
    assert.ok(!masked.includes(token.slice(4)))
    assert.equal(auth.hasToken(), true)
    assert.match(auth.tokenCreatedAt(), /^\d{4}-\d{2}-\d{2}T/)
  })
})

test('registerFailure：滑动 60s 窗口，第 6 次起限速', async (t) => {
  const t0 = 1_700_000_000_000

  await t.test('默认上限 5：第 1..5 次不限，第 6 次限 + retryAfterSec', () => {
    const auth = new RemoteAuth()
    assert.equal(DEFAULT_MAX_FAILURES_PER_MINUTE, 5)
    for (let i = 1; i <= 5; i++) {
      const res = auth.registerFailure('192.168.1.9', t0 + i)
      assert.equal(res.limited, false, `第 ${i} 次不该限速`)
      assert.equal(res.retryAfterSec, undefined)
    }
    const sixth = auth.registerFailure('192.168.1.9', t0 + 6)
    assert.equal(sixth.limited, true)
    assert.ok(sixth.retryAfterSec >= 1 && sixth.retryAfterSec <= 60, String(sixth.retryAfterSec))
  })

  await t.test('60s 后窗口滑出 → 恢复', () => {
    const auth = new RemoteAuth()
    for (let i = 0; i < 6; i++) auth.registerFailure('10.1.1.1', t0)
    assert.equal(auth.registerFailure('10.1.1.1', t0 + 10).limited, true)
    const afterWindow = auth.registerFailure('10.1.1.1', t0 + FAILURE_WINDOW_MS + 1)
    assert.equal(afterWindow.limited, false)
  })

  await t.test('不同 IP 互不影响', () => {
    const auth = new RemoteAuth()
    for (let i = 0; i < 6; i++) auth.registerFailure('10.0.0.1', t0)
    assert.equal(auth.registerFailure('10.0.0.1', t0).limited, true)
    assert.equal(auth.registerFailure('10.0.0.2', t0).limited, false)
  })

  await t.test('resetFailures(ip) 只清该 IP；resetFailures() 全清', () => {
    const auth = new RemoteAuth()
    for (let i = 0; i < 6; i++) auth.registerFailure('10.0.0.1', t0)
    for (let i = 0; i < 6; i++) auth.registerFailure('10.0.0.2', t0)
    auth.resetFailures('10.0.0.1')
    assert.equal(auth.registerFailure('10.0.0.1', t0).limited, false)
    assert.equal(auth.registerFailure('10.0.0.2', t0).limited, true)
    auth.resetFailures()
    assert.equal(auth.registerFailure('10.0.0.2', t0).limited, false)
  })

  await t.test('自定义上限生效；空 IP 归到 unknown 桶', () => {
    const auth = new RemoteAuth({ maxFailuresPerMinute: 2 })
    assert.equal(auth.registerFailure('', t0).limited, false)
    assert.equal(auth.registerFailure('', t0).limited, false)
    assert.equal(auth.registerFailure('', t0).limited, true)
  })
})

test('reset / pruneSessions / sessionCount：内存状态可清、不会无限增长', async (t) => {
  const t0 = 1_700_000_000_000

  await t.test('reset 清会话与失败计数，但保留 token', () => {
    const auth = new RemoteAuth({ tokenTtlMs: 1000 })
    const token = auth.setToken('keep-me')
    auth.exchangeToken(token, t0)
    for (let i = 0; i < 6; i++) auth.registerFailure('1.2.3.4', t0)
    auth.reset(t0)
    assert.equal(auth.sessionCount(), 0)
    assert.equal(auth.hasToken(), true)
    assert.equal(auth.exchangeToken(token, t0).ok, true)
    assert.equal(auth.registerFailure('1.2.3.4', t0).limited, false)
  })

  await t.test('pruneSessions 只清过期的，返回清掉的条数', () => {
    const auth = new RemoteAuth({ tokenTtlMs: 1000 })
    const token = auth.setToken('prune-me')
    const now = Date.now()
    auth.exchangeToken(token, now - 800) // 到期 now+200
    auth.exchangeToken(token, now) // 到期 now+1000
    assert.equal(auth.sessionCount(), 2)
    assert.equal(auth.pruneSessions(now + 500), 1)
    assert.equal(auth.sessionCount(), 1)
    assert.equal(auth.pruneSessions(now + 5000), 1)
    assert.equal(auth.sessionCount(), 0)
  })
})

test('常量契约：TOKEN_PARAM 与 cookie 名与 routes 侧对齐', () => {
  assert.equal(TOKEN_PARAM, 'k')
  assert.equal(SESSION_COOKIE_NAME, 'dsh_remote_session')
  assert.equal(DEFAULT_TOKEN_TTL_MS, 12 * 60 * 60 * 1000)
  assert.equal(FAILURE_WINDOW_MS, 60_000)
})
