/**
 * 远程访问方式「纯逻辑模型 + 地址归一」的回归测试。
 *
 * 覆盖：
 *   1. 六种方式元数据：availability / bindKind / 必填字段 / 步骤数 / 字段占位符；
 *      关键判定文案（uu 的"图形化端口映射 / 免费版包含"、tailscale 的"卓易通不能让本机 App 走它"）；
 *   2. `normalizeRemoteSettings`：缺省沿用、显式清空、逐字段非法（含 details 打码）；
 *   3. `urlForMode` 六种方式（IPv6 方括号、cloudflare 无端口、lan 无地址报错）；
 *   4. `withToken` 幂等、`maskToken` / `redactToken`（含 %2B 编码形态）；
 *   5. IPv4 / IPv6 / 主机名归一的边界。
 *
 * 断言纪律：**任何**错误消息与 details 都不许出现 token 明文（见最后一组用例）。
 * 运行：先编译（见任务说明），再 `node --test test/remote-model.test.mjs`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REMOTE_MODE_ORDER,
  REMOTE_MODES,
  defaultRemoteSettings,
  findMode,
  isModeUsable,
  listModes,
  missingRequiredFields,
  normalizeRemoteSettings,
} from '../dist/remote/accessMode.js'
import {
  appendAccessToken,
  buildHttpUrl,
  buildHttpsUrl,
  formatAuthority,
  maskToken,
  normalizeHostname,
  normalizeIpv4,
  normalizeIpv6,
  redactToken,
  urlForMode,
  withToken,
} from '../dist/remote/urls.js'

/** 每条方式：可用性、绑定点、必填字段（顺序即 UI 顺序）。 */
const EXPECTED_MODES = {
  lan: ['ready', 'lan', ['lanAddress', 'port']],
  tailscale: ['needs-setup', 'tailnet', ['tailscaleHost', 'port']],
  ipv6: ['needs-setup', 'ipv6', ['ipv6Address', 'port']],
  cloudflare: ['needs-setup', 'loopback', ['cloudflareHost', 'port']],
  manual: ['ready', 'none', ['manualUrl']],
  // 2026-11-18 订正：UU 官方 blog 明确提供图形化端口映射（免费版含）→ needs-setup。
  uu: ['needs-setup', 'none', ['manualUrl']],
}

const CTX = { lanAddress: '192.168.1.6', dshPort: 40596 }

function baseSettings(overrides = {}) {
  return { ...defaultRemoteSettings(), port: 40596, ...overrides }
}

/** 抓 SyncError（JS 侧只认 code/name，不需要 import 引擎实现）。 */
function captureError(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('这里应当抛出 E_VALIDATION')
}

function expectValidation(fn, messagePart) {
  const error = captureError(fn)
  assert.equal(error.name, 'SyncError')
  assert.equal(error.code, 'E_VALIDATION')
  assert.ok(
    error.message.includes(messagePart),
    `消息里应包含「${messagePart}」，实际是：${error.message}`,
  )
  return error
}

test('六种方式的可用性/绑定点/必填字段与调研结论一致', () => {
  assert.deepEqual(REMOTE_MODE_ORDER, ['lan', 'tailscale', 'ipv6', 'cloudflare', 'manual', 'uu'])
  assert.equal(listModes().length, 6)
  assert.deepEqual(
    listModes().map((spec) => spec.mode),
    [...REMOTE_MODE_ORDER],
    'listModes 顺序必须等于 REMOTE_MODE_ORDER',
  )

  for (const mode of REMOTE_MODE_ORDER) {
    const spec = REMOTE_MODES[mode]
    const [availability, bindKind, requiredKeys] = EXPECTED_MODES[mode]
    assert.equal(spec.mode, mode, `${mode}: mode 字段`)
    assert.equal(spec.availability, availability, `${mode}: availability`)
    assert.equal(spec.bindKind, bindKind, `${mode}: bindKind`)
    assert.deepEqual(
      spec.fields.filter((field) => field.required).map((field) => field.key),
      requiredKeys,
      `${mode}: 必填字段`,
    )
    assert.equal(isModeUsable(mode), availability !== 'unsupported', `${mode}: 可用性判定`)
    assert.ok(spec.label.length > 0, `${mode}: label 不能为空`)
    assert.ok(spec.description.length > 0, `${mode}: description 不能为空`)
    // description 是方式卡片上的一行说明：原上限 40 字，uu 订正成"可用（需准备）"后
    // 需要把机制（图形化端口映射）+ 用法说全，放宽到 60 字；其余方式仍远低于 40。
    assert.ok(spec.description.length <= 60, `${mode}: description 超过 60 字`)
    for (const field of spec.fields) {
      assert.ok(field.label.length > 0, `${mode}.${field.key}: label 不能为空`)
      assert.ok(field.placeholder.length > 0, `${mode}.${field.key}: placeholder 不能为空`)
      assert.ok(field.hint.length > 0, `${mode}.${field.key}: hint 不能为空`)
    }
  }

  assert.equal(isModeUsable('uu'), true, 'uu 已订正为"可用（需准备）"，不再 unsupported')
  assert.equal(isModeUsable('lan'), true)
  assert.equal(isModeUsable('manual'), true)
})

test('uu 判定为可用（需准备）：图形化端口映射，免费版包含', () => {
  const uu = REMOTE_MODES.uu
  assert.equal(uu.availability, 'needs-setup')
  assert.equal(uu.unavailableReason, '', 'uu 不再是 unsupported，unavailableReason 必须为空串')
  assert.equal(isModeUsable('uu'), true)
  assert.deepEqual(
    uu.fields.map((field) => field.key),
    ['manualUrl', 'token'],
    'uu 复用 manualUrl 槽位 + 可选的 token',
  )
  assert.equal(uu.fields[0].required, true)
  assert.equal(uu.fields[0].label, '对外入口地址')
  assert.equal(uu.fields[1].required, false)
  assert.ok(uu.steps.length >= 3 && uu.steps.length <= 6, 'uu 的步骤数必须是 3–6 步')
  assert.equal(uu.hostsListener, false, 'UU 自己负责转发，插件不起监听')
  assert.equal(uu.bindKind, 'none')
  const requiresText = uu.requires.join('｜')
  assert.ok(requiresText.includes('UU 远程'), 'requires 必须点明要装 UU 远程')
  assert.ok(requiresText.includes('端口映射'), 'requires 必须点明图形化端口映射')
  assert.ok(requiresText.includes('免费'), 'requires 必须说明免费版就含端口映射')
  const stepsText = uu.steps.join('｜')
  assert.ok(stepsText.includes('图形化端口映射'), 'steps 必须给出配映射的入口')
  assert.ok(stepsText.includes('对外入口'), 'steps 必须让用户复制生成的对外入口')
  assert.ok(stepsText.includes('待实测'), '入口形态仍是待实测点，不能写成已确定')
})

test('tailscale 需要平板装鸿蒙原生客户端，并点明卓易通路线不可用', () => {
  const spec = REMOTE_MODES.tailscale
  assert.equal(spec.availability, 'needs-setup')
  assert.equal(spec.bindKind, 'tailnet')
  assert.equal(spec.hostsListener, true)
  const requiresText = spec.requires.join('｜')
  assert.ok(requiresText.includes('卓易通'), 'requires 必须提到卓易通')
  assert.ok(requiresText.includes('不能'), 'requires 必须写明"不能"')
  assert.ok(requiresText.includes('App'), 'requires 必须点明本机 App 走不了')
  assert.ok(requiresText.includes('鸿蒙'), 'requires 必须要求鸿蒙原生客户端')
  assert.ok(requiresText.includes('HarmoTail'), 'requires 应给出可核对的客户端名')
  assert.ok(spec.steps.length >= 3 && spec.steps.length <= 6)
})

test('步骤数与"是否起监听"符合契约', () => {
  assert.ok(REMOTE_MODES.lan.steps.length >= 2 && REMOTE_MODES.lan.steps.length <= 3)
  assert.equal(REMOTE_MODES.manual.steps.length, 2)
  assert.equal(REMOTE_MODES.uu.steps.length, 5, 'uu：启动 DSH → 配映射 → 复制入口 → 粘贴 → 平板打开')
  assert.ok(REMOTE_MODES.ipv6.steps.length >= 3 && REMOTE_MODES.ipv6.steps.length <= 6)
  assert.ok(REMOTE_MODES.cloudflare.steps.length >= 3 && REMOTE_MODES.cloudflare.steps.length <= 6)
  assert.equal(REMOTE_MODES.lan.hostsListener, true)
  assert.equal(REMOTE_MODES.ipv6.hostsListener, true)
  assert.equal(REMOTE_MODES.cloudflare.hostsListener, true)
  assert.equal(REMOTE_MODES.manual.hostsListener, false)
})

test('字段占位符与端口 hint 按契约给出', () => {
  const field = (mode, key) => REMOTE_MODES[mode].fields.find((item) => item.key === key)
  assert.equal(field('lan', 'lanAddress').placeholder, '192.168.1.6')
  assert.equal(field('tailscale', 'tailscaleHost').placeholder, '100.101.102.103')
  assert.equal(field('cloudflare', 'cloudflareHost').placeholder, 'xxx.trycloudflare.com')
  assert.equal(field('ipv6', 'ipv6Address').placeholder, '2409:8a20:4cad:ba20:1234:5678:9abc:def0')
  assert.equal(field('manual', 'manualUrl').placeholder, 'https://example.com/?token=…')
  assert.equal(field('lan', 'port').hint, '0 = 跟 DSH 同端口')
  assert.equal(field('lan', 'port').required, true)
  assert.equal(field('ipv6', 'port').required, true)
})

test('findMode 只认枚举里的精确字符串', () => {
  assert.equal(findMode('lan').mode, 'lan')
  assert.equal(findMode('uu').mode, 'uu')
  assert.equal(findMode('telnet'), null)
  assert.equal(findMode('LAN'), null)
  assert.equal(findMode(' lan'), null)
  assert.equal(findMode(''), null)
  assert.equal(findMode(null), null)
  assert.equal(findMode(123), null)
  assert.equal(findMode({ mode: 'lan' }), null)
})

test('默认设置：关闭、lan、端口跟随 DSH、地址与令牌全空', () => {
  assert.deepEqual(defaultRemoteSettings(), {
    enabled: false,
    mode: 'lan',
    port: 0,
    lanAddress: '',
    tailscaleHost: '',
    cloudflareHost: '',
    ipv6Address: '',
    manualUrl: '',
    token: '',
  })
})

test('设置归一：缺省沿用 previous、显式空串才清空', () => {
  const base = baseSettings({
    enabled: true,
    mode: 'ipv6',
    lanAddress: '192.168.1.6',
    tailscaleHost: '100.1.2.3',
    cloudflareHost: 'a.trycloudflare.com',
    ipv6Address: '2409:8a20::1',
    manualUrl: 'https://example.com/',
  })

  const kept = normalizeRemoteSettings({}, base)
  assert.deepEqual(kept, base)
  assert.notEqual(kept, base, '应当返回新对象，不修改 previous')
  assert.equal(base.mode, 'ipv6', 'previous 不能被就地改动')

  const cleared = normalizeRemoteSettings({ lanAddress: '', ipv6Address: '', manualUrl: '', port: 0 }, base)
  assert.equal(cleared.lanAddress, '')
  assert.equal(cleared.ipv6Address, '')
  assert.equal(cleared.manualUrl, '')
  assert.equal(cleared.port, 0)
  assert.equal(cleared.mode, 'ipv6', '未提供的 mode 必须沿用 previous')
  assert.equal(cleared.enabled, true)

  assert.equal(normalizeRemoteSettings({ lanAddress: '  192.168.1.6  ' }, base).lanAddress, '192.168.1.6')
  assert.equal(normalizeRemoteSettings({ cloudflareHost: 'XXX.TryCloudflare.COM' }, base).cloudflareHost, 'xxx.trycloudflare.com')
  assert.equal(normalizeRemoteSettings({ ipv6Address: '2409:8A20:0:0:0:0:0:1' }, base).ipv6Address, '2409:8a20::1')
  assert.equal(normalizeRemoteSettings({ enabled: false }, base).enabled, false)
  assert.equal(normalizeRemoteSettings({ mode: 'manual' }, base).mode, 'manual')
})

test('设置归一：结构非法一律 E_VALIDATION', () => {
  const base = baseSettings()
  expectValidation(() => normalizeRemoteSettings(null, base), '必须是对象')
  expectValidation(() => normalizeRemoteSettings([], base), '必须是对象')
  expectValidation(() => normalizeRemoteSettings('lan', base), '必须是对象')
  expectValidation(() => normalizeRemoteSettings({ enabled: 'yes' }, base), '布尔')
  expectValidation(() => normalizeRemoteSettings({ enabled: 1 }, base), '布尔')
  expectValidation(() => normalizeRemoteSettings({ mode: 'telnet' }, base), 'mode')
  expectValidation(() => normalizeRemoteSettings({ mode: 'LAN' }, base), 'mode')
  expectValidation(() => normalizeRemoteSettings({ mode: '' }, base), 'mode')
})

test('设置归一：端口必须是 0–65535 的整数', () => {
  const base = baseSettings()
  const tooBig = expectValidation(() => normalizeRemoteSettings({ port: 70000 }, base), '0–65535')
  assert.equal(tooBig.details.field, 'port')
  assert.equal(tooBig.details.allowed.min, 0)
  assert.equal(tooBig.details.allowed.max, 65535)
  expectValidation(() => normalizeRemoteSettings({ port: -1 }, base), '0–65535')
  expectValidation(() => normalizeRemoteSettings({ port: 1.5 }, base), '整数')
  expectValidation(() => normalizeRemoteSettings({ port: '40596' }, base), '整数')
  expectValidation(() => normalizeRemoteSettings({ port: Number.NaN }, base), '整数')
  assert.equal(normalizeRemoteSettings({ port: 0 }, base).port, 0)
  assert.equal(normalizeRemoteSettings({ port: 65535 }, base).port, 65535)
})

test('设置归一：地址字段逐项校验，details 带 field/value', () => {
  const base = baseSettings()

  const wildcard = expectValidation(() => normalizeRemoteSettings({ lanAddress: '0.0.0.0' }, base), '局域网地址')
  assert.equal(wildcard.details.field, 'lanAddress')
  assert.equal(wildcard.details.value, '0.0.0.0')
  expectValidation(() => normalizeRemoteSettings({ lanAddress: 'example.com' }, base), '局域网地址')
  expectValidation(() => normalizeRemoteSettings({ ipv6Address: '[2409:8a20::1]' }, base), '方括号')
  expectValidation(() => normalizeRemoteSettings({ ipv6Address: 'eth0' }, base), 'IPv6')
  expectValidation(() => normalizeRemoteSettings({ cloudflareHost: 'https://x.trycloudflare.com' }, base), '隧道域名')
  expectValidation(() => normalizeRemoteSettings({ cloudflareHost: 'x.trycloudflare.com:443' }, base), '隧道域名')
  expectValidation(() => normalizeRemoteSettings({ tailscaleHost: '100.1.2.3/status' }, base), 'Tailscale 地址')
  expectValidation(() => normalizeRemoteSettings({ manualUrl: 'javascript:alert(1)' }, base), '完整地址')
  expectValidation(() => normalizeRemoteSettings({ manualUrl: 'example.com' }, base), '完整地址')
  expectValidation(() => normalizeRemoteSettings({ lanAddress: 123 }, base), '字符串')
})

test('设置归一：uu 的对外入口允许缺协议（UU 界面复制出来的就是 host:port），manual 仍严格', () => {
  const uuBase = baseSettings({ mode: 'uu' })
  assert.equal(
    normalizeRemoteSettings({ manualUrl: 'abc.uuyc.com:12345' }, uuBase).manualUrl,
    'abc.uuyc.com:12345',
    'uu 方式下原样保存，不替用户猜协议',
  )
  assert.equal(
    normalizeRemoteSettings({ manualUrl: 'https://abc.uuyc.com/x' }, uuBase).manualUrl,
    'https://abc.uuyc.com/x',
  )
  // 仍拦乱写：解析不出主机名 / 非 http(s) 的一律拒
  expectValidation(() => normalizeRemoteSettings({ manualUrl: 'http://' }, uuBase), '完整地址')
  expectValidation(() => normalizeRemoteSettings({ manualUrl: 'javascript:alert(1)' }, uuBase), '完整地址')
  // 同一个输入换个方式（manual）必须被拒：落盘严格是 manual 的既有纪律
  expectValidation(
    () => normalizeRemoteSettings({ manualUrl: 'abc.uuyc.com:12345' }, baseSettings({ mode: 'manual' })),
    '完整地址',
  )
})

test('设置归一：manualUrl 里的 token 在 details 里已打码', () => {
  const base = baseSettings()
  const token = 'tok-abcdefghijklmnop-1234567890'
  const error = captureError(() =>
    normalizeRemoteSettings({ manualUrl: `ftp://files.example.com/?token=${token}` }, base),
  )
  assert.equal(error.code, 'E_VALIDATION')
  assert.equal(error.details.field, 'manualUrl')
  assert.ok(!String(error.details.value).includes(token), 'details 里不能有 token 明文')
  assert.ok(String(error.details.value).includes('token=***'))
  assert.ok(!error.message.includes(token), 'message 里不能有 token 明文')
  assert.ok(JSON.stringify(error.details).includes('***'))
})

test('「访问令牌（可选）」出现在 lan / ipv6 / tailscale / uu，且排在端口之后', () => {
  // uu 也带令牌字段：UU 生成的对外入口不保证带令牌，需要插件在链接后追加 ?token=…
  // （cloudflare / manual 没有它：令牌由域名或完整地址自带）
  const withTokenField = ['lan', 'ipv6', 'tailscale', 'uu']
  for (const mode of REMOTE_MODE_ORDER) {
    const keys = REMOTE_MODES[mode].fields.map((field) => field.key)
    const tokenFields = REMOTE_MODES[mode].fields.filter((field) => field.key === 'token')
    if (!withTokenField.includes(mode)) {
      assert.equal(tokenFields.length, 0, `${mode}: 不该有 token 字段（令牌由域名/完整地址自带）`)
      continue
    }
    assert.equal(tokenFields.length, 1, `${mode}: 必须恰好一个 token 字段`)
    assert.equal(keys[keys.length - 1], 'token', `${mode}: token 字段必须排在端口之后（UI 顺序）`)
    // label / placeholder / required 必须全方式一致；hint 允许措辞略不同（uu 复用的是自己那份
    // 文案，语义相同：留空不追加、填了追加 ?token=…），所以只做包含式断言。
    const tokenShape = { ...tokenFields[0] }
    delete tokenShape.hint
    assert.deepEqual(tokenShape, {
      key: 'token',
      label: '访问令牌（可选）',
      placeholder: '粘贴电脑上 DSH 地址里的 token',
      required: false,
    })
    assert.ok(tokenFields[0].hint.includes('留空则不带令牌'), `${mode}: token hint 必须说明留空的行为`)
    assert.ok(tokenFields[0].hint.includes('?token='), `${mode}: token hint 必须说明会追加 ?token=`)
    assert.equal(
      REMOTE_MODES[mode].fields.filter((field) => field.required).map((field) => field.key).includes('token'),
      false,
      `${mode}: 令牌是可选项，不能进必填列表`,
    )
  }
})

test('设置归一：token 空/合法/含空格/非法字符/过短/超长，details 只给长度', () => {
  const base = baseSettings()
  const token = 'AbC123+/=_-xyz'

  assert.equal(normalizeRemoteSettings({ token }, base).token, token, '合法令牌原样保存')
  assert.equal(normalizeRemoteSettings({ token: `  ${token}  ` }, base).token, token, '先 trim 再保存')
  assert.equal(normalizeRemoteSettings({ token: '' }, base).token, '', '显式空串 = 清空（不追加参数）')
  assert.equal(normalizeRemoteSettings({ token: '    ' }, base).token, '', '纯空白等同清空')
  assert.equal(
    normalizeRemoteSettings({}, baseSettings({ token })).token,
    token,
    '缺省（undefined）必须沿用 previous',
  )
  assert.equal(normalizeRemoteSettings({ token: 'a'.repeat(8) }, base).token.length, 8, '8 位是下界（含）')
  assert.equal(normalizeRemoteSettings({ token: 'a'.repeat(512) }, base).token.length, 512, '512 位是上界（含）')

  const bad = ['has space token', 'bad!char', 'short7', 'a'.repeat(513), '中文令牌中文令牌']
  const message = '访问令牌只允许字母数字与 + / = _ -，长度 8–512'
  for (const value of bad) {
    const error = captureError(() => normalizeRemoteSettings({ token: value }, baseSettings()))
    assert.equal(error.name, 'SyncError')
    assert.equal(error.code, 'E_VALIDATION')
    assert.equal(error.message, message)
    // details 的结构必须是固定的 field + length —— 多一个键都算泄露风险。
    assert.deepEqual(Object.keys(error.details).sort(), ['field', 'length'])
    assert.deepEqual(error.details, { field: 'token', length: value.trim().length })

    const trimmed = value.trim()
    assert.equal(error.message.includes(trimmed), false, 'message 里不得出现令牌值')
    assert.equal(JSON.stringify(error.details).includes(trimmed), false, 'details 里不得出现令牌值')
    // 除 message 与 details 之外没有别的可见文本（凭据不会藏在第三处）。
    const visible = error.message + JSON.stringify(error.details)
    assert.equal(visible, message + JSON.stringify({ field: 'token', length: trimmed.length }))
  }

  // 非字符串：也要拒绝，且 details 里同样不给值
  const notString = captureError(() => normalizeRemoteSettings({ token: 12345 }, baseSettings()))
  assert.equal(notString.code, 'E_VALIDATION')
  assert.deepEqual(notString.details, { field: 'token' })
  assert.equal(String(notString.details.value), 'undefined')
})

test('appendAccessToken：空令牌原样返回、非空拼 ?token=、非法地址空串', () => {
  const url = 'http://192.168.1.6:40596/'
  assert.equal(appendAccessToken(url, ''), url, '空令牌不追加参数')
  assert.equal(appendAccessToken(url, '   '), url, '纯空白同理')
  assert.equal(appendAccessToken('http://x/?a=1#f', 'tok'), 'http://x/?a=1&token=tok#f')
  assert.equal(appendAccessToken('https://example.com/', 'a+b/c='), 'https://example.com/?token=a%2Bb%2Fc%3D')
  assert.equal(
    appendAccessToken(url, 'abc+def/123'),
    withToken(url, 'abc+def/123'),
    '非空时行为必须与 withToken 一致',
  )

  const once = appendAccessToken(url, 'dup')
  assert.equal(appendAccessToken(once, 'dup'), once, '同一令牌重复追加必须幂等')
  assert.equal((appendAccessToken('http://x/?token=old', 'new').match(/token=/g) || []).length, 1)

  assert.equal(appendAccessToken('不是地址', 'tok'), '', '非法 URL 返回空串（fail-closed）')
  assert.equal(appendAccessToken('ftp://example.com/', 'tok'), '', '非 http(s) 返回空串')
  assert.equal(appendAccessToken('', 'tok'), '')
})

test('missingRequiredFields 只报真正空的字符串字段（端口与令牌恒不算缺失）', () => {
  assert.deepEqual(missingRequiredFields('lan', defaultRemoteSettings()), ['lanAddress'])
  assert.deepEqual(missingRequiredFields('tailscale', defaultRemoteSettings()), ['tailscaleHost'])
  assert.deepEqual(missingRequiredFields('ipv6', defaultRemoteSettings()), ['ipv6Address'])
  assert.deepEqual(missingRequiredFields('cloudflare', defaultRemoteSettings()), ['cloudflareHost'])
  assert.deepEqual(missingRequiredFields('manual', defaultRemoteSettings()), ['manualUrl'])
  assert.deepEqual(missingRequiredFields('uu', defaultRemoteSettings()), ['manualUrl'], 'uu 缺的是对外入口')
  assert.deepEqual(missingRequiredFields('lan', baseSettings({ lanAddress: '192.168.1.6' })), [])
  assert.deepEqual(missingRequiredFields('lan', baseSettings({ lanAddress: '   ' })), ['lanAddress'])
})

test('normalizeIpv4 的边界', () => {
  assert.equal(normalizeIpv4('192.168.1.6').ok, true)
  assert.equal(normalizeIpv4('192.168.1.6').value, '192.168.1.6')
  assert.equal(normalizeIpv4('  192.168.1.6  ').value, '192.168.1.6')
  assert.equal(normalizeIpv4('0.0.0.0').ok, false)
  assert.ok(normalizeIpv4('0.0.0.0').reason.includes('通配'))
  assert.equal(normalizeIpv4('255.255.255.255').ok, false)
  assert.equal(normalizeIpv4('1.2.3.4.5').ok, false)
  assert.equal(normalizeIpv4('999.1.1.1').ok, false)
  assert.equal(normalizeIpv4('192.168.01.1').ok, false)
  assert.equal(normalizeIpv4('192.168.1').ok, false)
  assert.equal(normalizeIpv4('').ok, false)
  assert.equal(normalizeIpv4('   ').ok, false)
  assert.equal(normalizeIpv4(null).ok, false)
  assert.equal(normalizeIpv4(42).ok, false)
  assert.equal(normalizeIpv4('localhost').ok, false)
  assert.equal(normalizeIpv4('fe80::1').ok, false)
  // 失败时统一是"空值 + 中文原因"，不会返回半成品
  assert.equal(normalizeIpv4('999.1.1.1').value, '')
  assert.ok(normalizeIpv4('999.1.1.1').reason.length > 0)
})

test('normalizeIpv6 的边界（输出不带方括号）', () => {
  assert.equal(normalizeIpv6('::1').ok, true)
  assert.equal(normalizeIpv6('::1').value, '::1')
  assert.equal(normalizeIpv6('2409:8A20:4CAD:BA20:1234:5678:9ABC:DEF0').value, '2409:8a20:4cad:ba20:1234:5678:9abc:def0')
  assert.equal(normalizeIpv6('2409:8a20:0:0:0:0:0:1').value, '2409:8a20::1')
  assert.equal(normalizeIpv6('fe80::1').ok, true)
  assert.equal(normalizeIpv6('::ffff:192.168.1.1').ok, true)

  assert.equal(normalizeIpv6('[::1]').ok, false)
  assert.ok(normalizeIpv6('[2409:8a20::1]').reason.includes('方括号'))
  assert.equal(normalizeIpv6('[2409:8a20::1]').value, '')
  assert.equal(normalizeIpv6('fe80::1%eth0').ok, false)
  assert.ok(normalizeIpv6('fe80::1%eth0').reason.includes('%'))
  assert.equal(normalizeIpv6('1:2:3:4:5:6:7').ok, false)
  assert.equal(normalizeIpv6('1:2:3:4:5:6:7:8:9').ok, false)
  assert.equal(normalizeIpv6('2409::8a20::1').ok, false)
  assert.equal(normalizeIpv6('12345::1').ok, false)
  assert.equal(normalizeIpv6('192.168.1.6').ok, false)
  assert.equal(normalizeIpv6('').ok, false)
  assert.equal(normalizeIpv6('   ').ok, false)
  assert.equal(normalizeIpv6(null).ok, false)
})

test('normalizeHostname 的边界（无协议/路径/端口，小写输出）', () => {
  assert.equal(normalizeHostname('Example.COM').ok, true)
  assert.equal(normalizeHostname('Example.COM').value, 'example.com')
  assert.equal(normalizeHostname(' 100.101.102.103 ').value, '100.101.102.103')
  assert.equal(normalizeHostname('100.101.102.103').ok, true)
  assert.equal(normalizeHostname('mypc').ok, true)

  assert.equal(normalizeHostname('https://example.com').ok, false)
  assert.ok(normalizeHostname('https://example.com').reason.includes('http'))
  assert.equal(normalizeHostname('example.com/path').ok, false)
  assert.equal(normalizeHostname('example.com?x=1').ok, false)
  assert.equal(normalizeHostname('example.com:443').ok, false)
  assert.equal(normalizeHostname('999.1.1.1').ok, false)
  assert.equal(normalizeHostname('exa_mple.com').ok, false)
  assert.equal(normalizeHostname('-bad.example.com').ok, false)
  assert.equal(normalizeHostname('example.com.').ok, false)
  assert.equal(normalizeHostname('').ok, false)
  assert.equal(normalizeHostname('   ').ok, false)
  assert.equal(normalizeHostname(null).ok, false)
})

test('formatAuthority / buildHttpUrl / buildHttpsUrl 的拼装规则', () => {
  assert.equal(formatAuthority('2409:8a20::1'), '[2409:8a20::1]')
  assert.equal(formatAuthority('192.168.1.6'), '192.168.1.6')
  assert.equal(formatAuthority('example.com'), 'example.com')
  assert.equal(buildHttpUrl('192.168.1.6', 40596), 'http://192.168.1.6:40596/')
  assert.equal(buildHttpUrl('2409:8a20::1', 40596), 'http://[2409:8a20::1]:40596/')
  assert.equal(buildHttpUrl('192.168.1.6', 0), 'http://192.168.1.6/')
  assert.equal(buildHttpUrl('192.168.1.6', 40596, '/chat'), 'http://192.168.1.6:40596/chat')
  assert.equal(buildHttpsUrl('xxx.trycloudflare.com'), 'https://xxx.trycloudflare.com/')
  assert.equal(buildHttpsUrl('xxx.trycloudflare.com', '/chat'), 'https://xxx.trycloudflare.com/chat')
})

test('urlForMode: lan 用设置里的地址，缺失时回退 ctx 网卡地址，都没有则报错', () => {
  const fromContext = urlForMode('lan', baseSettings(), CTX)
  assert.equal(fromContext.ok, true)
  assert.equal(fromContext.url, 'http://192.168.1.6:40596/')
  assert.equal(fromContext.reason, '')

  const fromSettings = urlForMode('lan', baseSettings({ lanAddress: '192.168.1.7' }), CTX)
  assert.equal(fromSettings.url, 'http://192.168.1.7:40596/')

  const noPortSetting = urlForMode('lan', baseSettings({ port: 0 }), CTX)
  assert.equal(noPortSetting.url, 'http://192.168.1.6:40596/', 'port=0 时应跟随 dshPort')

  const missing = urlForMode('lan', baseSettings(), { lanAddress: null, dshPort: 40596 })
  assert.equal(missing.ok, false)
  assert.equal(missing.url, '')
  assert.ok(missing.reason.includes('还没有可用的局域网地址，请先选择本机网卡地址'))

  const wildcard = urlForMode('lan', baseSettings({ lanAddress: '0.0.0.0' }), CTX)
  assert.equal(wildcard.ok, false)
  assert.equal(wildcard.url, '')
})

test('urlForMode: ipv6 地址裹方括号、非法地址报错', () => {
  const ok = urlForMode('ipv6', baseSettings({ ipv6Address: '2409:8a20:4cad:ba20::1' }), CTX)
  assert.equal(ok.ok, true)
  assert.equal(ok.url, 'http://[2409:8a20:4cad:ba20::1]:40596/')

  const empty = urlForMode('ipv6', baseSettings(), CTX)
  assert.equal(empty.ok, false)
  assert.equal(empty.url, '')

  const bracketed = urlForMode('ipv6', baseSettings({ ipv6Address: '[2409:8a20::1]' }), CTX)
  assert.equal(bracketed.ok, false)
  assert.equal(bracketed.url, '')
  assert.ok(bracketed.reason.includes('方括号'))
})

test('urlForMode: tailscale 走 http，cloudflare 走 https 且不带端口', () => {
  const tailscale = urlForMode('tailscale', baseSettings({ tailscaleHost: '100.101.102.103' }), CTX)
  assert.equal(tailscale.ok, true)
  assert.equal(tailscale.url, 'http://100.101.102.103:40596/')

  const magicDns = urlForMode('tailscale', baseSettings({ tailscaleHost: 'MyPc.tailnet.ts.net' }), CTX)
  assert.equal(magicDns.url, 'http://mypc.tailnet.ts.net:40596/')

  const emptyTailscale = urlForMode('tailscale', baseSettings(), CTX)
  assert.equal(emptyTailscale.ok, false)
  assert.equal(emptyTailscale.url, '')

  const cloudflare = urlForMode(
    'cloudflare',
    baseSettings({ cloudflareHost: 'XXX.trycloudflare.com', port: 40596 }),
    CTX,
  )
  assert.equal(cloudflare.ok, true)
  assert.equal(cloudflare.url, 'https://xxx.trycloudflare.com/')
  assert.ok(!cloudflare.url.includes('40596'), 'cloudflare 地址里不能出现端口')

  const badCloudflare = urlForMode('cloudflare', baseSettings({ cloudflareHost: 'http://x.trycloudflare.com' }), CTX)
  assert.equal(badCloudflare.ok, false)
  assert.equal(badCloudflare.url, '')
})

test('urlForMode: manual 透传（缺协议补 http://）', () => {
  const full = urlForMode('manual', baseSettings({ manualUrl: 'https://example.com/dsh/?x=1' }), CTX)
  assert.equal(full.ok, true)
  assert.equal(full.url, 'https://example.com/dsh/?x=1')

  const bare = urlForMode('manual', baseSettings({ manualUrl: 'example.com:8888/x' }), CTX)
  assert.equal(bare.ok, true)
  assert.equal(bare.url, 'http://example.com:8888/x')

  const empty = urlForMode('manual', baseSettings(), CTX)
  assert.equal(empty.ok, false)
  assert.equal(empty.url, '')
  assert.ok(empty.reason.includes('完整地址'))

  const badScheme = urlForMode('manual', baseSettings({ manualUrl: 'ftp://example.com/' }), CTX)
  assert.equal(badScheme.ok, false)
  assert.equal(badScheme.url, '')
  assert.ok(badScheme.reason.includes('http'))
})

test('urlForMode: uu 用 UU 生成的对外入口（缺协议按"含 / 补 https、否则 host:port 补 http"归一）', () => {
  const empty = urlForMode('uu', baseSettings(), CTX)
  assert.equal(empty.ok, false)
  assert.equal(empty.url, '')
  assert.equal(empty.reason, '还没填 UU 远程生成的对外入口')

  // host:port 形态（UU 端口映射最常见的复制结果）→ 补 http://
  const hostPort = urlForMode('uu', baseSettings({ manualUrl: 'abc.uuyc.com:12345' }), CTX)
  assert.equal(hostPort.ok, true)
  assert.equal(hostPort.url, 'http://abc.uuyc.com:12345/')

  // 含 `/` → 视为域名入口，补 https://
  const domain = urlForMode('uu', baseSettings({ manualUrl: 'abc.uuyc.com/dsh' }), CTX)
  assert.equal(domain.ok, true)
  assert.equal(domain.url, 'https://abc.uuyc.com/dsh')

  // 已带协议 → 原样保留（不改 scheme、不丢路径）
  const withScheme = urlForMode('uu', baseSettings({ manualUrl: 'https://abc.uuyc.com/remote?x=1' }), CTX)
  assert.equal(withScheme.ok, true)
  assert.equal(withScheme.url, 'https://abc.uuyc.com/remote?x=1')

  // 非 http(s) 一律拒：不能凭"用户粘了地址"就放过 javascript:/ftp:
  const badScheme = urlForMode('uu', baseSettings({ manualUrl: 'ftp://abc.uuyc.com/' }), CTX)
  assert.equal(badScheme.ok, false)
  assert.equal(badScheme.url, '')
  assert.ok(badScheme.reason.includes('http'))
  assert.ok(badScheme.reason.startsWith('对外入口不可用'), '失败原因要与 App 侧同一套措辞')

  // 解析不出主机名（例如端口越界）也是 fail-closed，且带同一前缀
  const badPort = urlForMode('uu', baseSettings({ manualUrl: 'abc.uuyc.com:999999' }), CTX)
  assert.equal(badPort.ok, false)
  assert.equal(badPort.url, '')
  assert.ok(badPort.reason.startsWith('对外入口不可用'))

  // token 不在这里拼：`urlForMode` 恒返回不带 token 的地址，追加由 appendAccessToken 负责
  const noToken = urlForMode('uu', baseSettings({ manualUrl: 'abc.uuyc.com:12345', token: 'rt_plain_0123456789' }), CTX)
  assert.equal(noToken.ok, true)
  assert.equal(noToken.url.includes('token='), false, 'urlForMode 不得自行追加 token')
  assert.equal(
    appendAccessToken(noToken.url, 'rt_plain_0123456789'),
    'http://abc.uuyc.com:12345/?token=rt_plain_0123456789',
  )
})

test('withToken 幂等、只留一个 token、保留其它参数与 fragment', () => {
  const url = 'http://192.168.1.6:40596/?a=1#frag'
  const once = withToken(url, 'abc+def/123')
  assert.ok(once.includes('token=abc%2Bdef%2F123'), `实际：${once}`)
  assert.ok(once.includes('a=1'), '其它查询参数必须保留')
  assert.ok(once.endsWith('#frag'), 'fragment 必须在末尾')
  assert.equal(withToken(once, 'abc+def/123'), once, '同一 token 重复调用必须幂等')

  const replaced = withToken(once, 'newtoken')
  assert.equal((replaced.match(/token=/g) || []).length, 1, '不能出现第二个 token 参数')
  assert.ok(replaced.includes('token=newtoken'))
  assert.ok(!replaced.includes('abc'))
  assert.ok(replaced.endsWith('#frag'))

  const doubled = withToken('http://192.168.1.6:40596/?token=old&token=older', 'new')
  assert.equal((doubled.match(/token=/g) || []).length, 1, '旧的重复 token 必须被清掉')

  assert.equal(withToken('https://example.com/', ''), 'https://example.com/', '空 token 不追加参数')
  assert.equal(withToken('https://example.com/', '   '), 'https://example.com/')
})

test('maskToken 打码规则', () => {
  assert.equal(maskToken('abcdefghijkl'), 'abcd…ijkl')
  assert.equal(maskToken('123456789012'), '1234…9012')
  assert.equal(maskToken('abcdefghijk'), '***', '长度 < 12 一律 ***')
  assert.equal(maskToken('short'), '***')
  assert.equal(maskToken(''), '***')
  assert.ok(!maskToken('abcdefghijkl').includes('abcdefghijkl'))
})

test('redactToken 覆盖明文与 URL 编码形态（含 %2B / %2b）', () => {
  const token = 'a+b/c=d?e&f'
  const encoded = encodeURIComponent(token)
  const lower = encoded.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase())

  const text = `链接 https://x/?token=${encoded} ，原样 ${token} ，小写 ${lower}`
  const redacted = redactToken(text, token)
  assert.ok(!redacted.includes(encoded), '编码形态必须被替换')
  assert.ok(!redacted.includes(token), '明文形态必须被替换')
  assert.ok(!redacted.includes(lower), '小写百分号形态必须被替换')
  assert.ok(redacted.includes('token=***'))
  assert.ok(redacted.includes('https://x/?token=***'))

  assert.equal(redactToken(text, ''), text, '空 token 不做替换')
  assert.equal(redactToken('nothing here', token), 'nothing here')
})

test('错误路径统一是 ok:false + 空 url，且消息里没有 token 明文', () => {
  const token = 'tok-secret-abcdefghijklmnop'
  const cases = [
    urlForMode('lan', baseSettings(), { lanAddress: null, dshPort: 40596 }),
    urlForMode('ipv6', baseSettings(), CTX),
    urlForMode('tailscale', baseSettings(), CTX),
    urlForMode('cloudflare', baseSettings(), CTX),
    urlForMode('manual', baseSettings(), CTX),
    urlForMode('uu', baseSettings(), CTX),
    urlForMode('manual', baseSettings({ manualUrl: `ftp://x/?token=${token}` }), CTX),
  ]
  for (const result of cases) {
    assert.equal(result.ok, false)
    assert.equal(result.url, '')
    assert.ok(result.reason.length > 0, '失败必须给出中文原因')
    assert.ok(!result.reason.includes(token))
    assert.ok(!result.url.includes(token))
  }
})
