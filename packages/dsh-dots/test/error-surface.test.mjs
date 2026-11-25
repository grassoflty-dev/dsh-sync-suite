/**
 * mod-plugin-askpass-error-surface 验收：**表驱动**，未来新增一个码无法"悄悄没有文案"。
 *
 * 被测对象：
 *   - `dist/remote/repoVisibility.js` 的 `REPO_BANNER_RULES` / `repoBannerCodeOf()` /
 *     `REPO_VISIBILITY_MESSAGES` / `E_REPO_*`；
 *   - `dist/rpc.js` 的 `repoCodeOfError()`（`withRepo()` 落盘 `status.repoBlockCode` 的唯一
 *     判定点）；
 *   - 真实 RPC 路径：askpass 层 `E_ASKPASS_NODE_MISSING` → `state.json` 得到 `E_REPO_ASKPASS`。
 *
 * 三个方向（缺一不可）：
 *   (a) 前向完备：`src/engine/**` + `src/sync/**` 里出现过的**每一个** `E_*` 码都在表里有登记
 *       （映射或带理由的豁免）——码从源码实时扫出来，不是手抄清单；
 *   (b) 文案完备：每个映射出的横幅码在 `REPO_VISIBILITY_MESSAGES` 里都有非空中文文案；
 *   (c) 反向无孤儿：`REPO_VISIBILITY_MESSAGES` 的每个键都真的可达（可见性判定的拒绝码，
 *       或某条映射的 banner）——没有"写了却永远不会显示"的文案。
 *
 * 全部离线：不联网、不推送、token 是假字面量，绝不打印。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRpcService, repoCodeOfError } from '../dist/rpc.js'
import { SyncError } from '../dist/engine/errors.js'
import {
  E_REPO_ASKPASS,
  REPO_BANNER_RULES,
  REPO_VISIBILITY_MESSAGES,
  repoBannerCodeOf,
} from '../dist/remote/repoVisibility.js'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(PKG_DIR, 'src')
/** 扫源码的两个目录：git/askpass 层 + 同步层。 */
const CODE_DIRS = ['engine', 'sync']
/** 中文文案/理由的判据（至少一个汉字）。 */
const CHINESE = /[\u4e00-\u9fff]/

/* -------------------------------------------------------------------------- */
/* 源码扫描：把"这一层到底能抛出哪些码"变成可复算的事实                        */
/* -------------------------------------------------------------------------- */

function listSources() {
  const files = []
  for (const dir of CODE_DIRS) {
    for (const name of readdirSync(path.join(SRC_DIR, dir))) {
      if (name.endsWith('.ts')) files.push(path.join(SRC_DIR, dir, name))
    }
  }
  return files.sort()
}

/** 取 `new SyncError(` 之后到顶层逗号为止的第一个实参文本。 */
function firstArgAfter(text, from) {
  let i = from
  let depth = 0
  let quote = ''
  while (i < text.length) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = ''
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    } else if ('([{'.includes(ch)) depth += 1
    else if (')]}'.includes(ch)) {
      if (depth === 0) return text.slice(from, i)
      depth -= 1
    } else if (ch === ',' && depth === 0) return text.slice(from, i)
    i += 1
  }
  return text.slice(from)
}

/**
 * 扫一遍 `src/engine/**` + `src/sync/**`，返回：
 *   - `throwCodes`：`new SyncError(<...>)` 里静态解析出的码（字面量 / 常量 / `OBJ.KEY` 常量）；
 *   - `allCodes`：上面这些 **∪** 两个目录里出现的所有 `'E_...'` 字面量（**故意取超集**：
 *     抛点用变量传码时（`fail()` / 三元表达式）也不会漏，且任何新增字面量都必须被登记）；
 *   - `unresolved`：静态解析不出来的抛点（列在允许表里，新增一个就失败）。
 */
function scanTypedCodes() {
  const literalConst = new Map()
  const objectConst = new Map()
  const throwCodes = new Set()
  const allCodes = new Set()
  const unresolved = []

  for (const file of listSources()) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
      literalConst.set(m[1], m[2])
    }
    for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\{([\s\S]*?)\}\s*as const/g)) {
      for (const p of m[2].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
        objectConst.set(`${m[1]}.${p[1]}`, p[2])
      }
    }
  }

  for (const file of listSources()) {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/')
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
      if (m[1].startsWith('E_')) allCodes.add(m[1])
    }
    for (const m of text.matchAll(/new\s+SyncError\(/g)) {
      const arg = firstArgAfter(text, m.index + m[0].length).trim()
      const quoted = /^'([^']*)'$/.exec(arg) ?? /^"([^"]*)"$/.exec(arg)
      let code = null
      if (quoted !== null) code = quoted[1]
      else if (/^[A-Za-z_$][\w$]*$/.test(arg)) code = literalConst.get(arg) ?? null
      else if (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(arg)) code = objectConst.get(arg) ?? null
      if (code === null) unresolved.push(`${rel}|${arg}`)
      else {
        throwCodes.add(code)
        allCodes.add(code)
      }
    }
  }
  return { throwCodes: [...throwCodes].sort(), allCodes: [...allCodes].sort(), unresolved }
}

/**
 * 允许的"静态解析不出码"的抛点：`fail()` 的通用参数与 `git.ts` 里两处三元表达式。
 * 它们的真实码都已经以字面量形式出现在同一文件的字面量集合里（因此仍被 (a) 覆盖），
 * 但**新增**一个解析不出的抛点必须在这里登记，否则测试失败。
 */
const UNRESOLVED_ALLOWLIST = new Set(['engine/errors.ts|code', 'engine/git.ts|code'])

const SCAN = scanTypedCodes()

/**
 * 可见性判定真正会拒绝的码：从 `repoVisibility.ts` 源码里 `refuse(CODE)` 调用点实时扫。
 *
 * 只认三种形态：已知常量（`const X: string = 'E_...'`）、直接字面量、以及 `E_` 开头的标识符；
 * `function refuse(code: string)` 这种**声明**不算调用点。
 */
const VISIBILITY_REFUSAL_CODES = (() => {
  const file = path.join(SRC_DIR, 'remote', 'repoVisibility.ts')
  const text = readFileSync(file, 'utf8')
  const consts = new Map()
  for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*:\s*string\s*=\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
    consts.set(m[1], m[2])
  }
  const codes = new Set()
  for (const m of text.matchAll(/refuse\(\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\)|refuse\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const literal = m[1]
    const identifier = m[2]
    if (typeof literal === 'string') {
      codes.add(literal)
      continue
    }
    const resolved = consts.get(identifier)
    if (resolved !== undefined) codes.add(resolved)
    else if (/^E_[A-Z0-9_]+$/.test(identifier)) codes.add(identifier)
  }
  return [...codes].sort()
})()

/* -------------------------------------------------------------------------- */
/* (a)(b)(c)：三个方向                                                         */
/* -------------------------------------------------------------------------- */

test('B01 (a) 前向完备：engine/** + sync/** 的每个 E_ 码都已登记（映射或带理由豁免）', () => {
  assert.ok(SCAN.allCodes.length >= 20, `扫描到的码太少，扫描器可能坏了：${SCAN.allCodes.length}`)
  const missing = SCAN.allCodes.filter((code) => REPO_BANNER_RULES[code] === undefined)
  assert.deepEqual(
    missing,
    [],
    `这些码从 git/askpass 层可以抛出但没有登记进 REPO_BANNER_RULES（新增码必须显式映射或豁免）：${missing.join(', ')}`,
  )
  const stale = Object.keys(REPO_BANNER_RULES).filter((code) => !SCAN.allCodes.includes(code))
  assert.deepEqual(stale, [], `表里有已不存在的码（删码时要同步删登记）：${stale.join(', ')}`)
})

test('B02 抛点扫描：无法静态解析的抛点只有登记过的两处（新增即失败）', () => {
  const unexpected = SCAN.unresolved.filter((site) => !UNRESOLVED_ALLOWLIST.has(site))
  assert.deepEqual(
    unexpected,
    [],
    `新增了静态解析不出错误码的抛点，请改成字面量 / 常量，或登记到 UNRESOLVED_ALLOWLIST：${unexpected.join(', ')}`,
  )
  assert.ok(SCAN.throwCodes.includes('E_ASKPASS_NODE_MISSING'), 'askpass 的 typed 码必须被扫到')
})

test('B03 (a) 每条登记都有非空中文理由；映射与豁免都必须说清楚', () => {
  for (const [code, rule] of Object.entries(REPO_BANNER_RULES)) {
    assert.equal(typeof rule.reason, 'string', `${code} 缺 reason`)
    assert.ok(rule.reason.trim().length >= 10, `${code} 的 reason 太短，写清为什么映射/豁免`)
    assert.match(rule.reason, CHINESE, `${code} 的 reason 必须是中文`)
    assert.ok(rule.banner === null || typeof rule.banner === 'string', `${code} 的 banner 必须是 string 或 null`)
  }
})

test('B04 (b) 文案完备：每个映射出的横幅码都有非空中文文案', () => {
  const mapped = Object.values(REPO_BANNER_RULES)
    .map((rule) => rule.banner)
    .filter((banner) => banner !== null)
  assert.ok(mapped.length >= 3, '至少三条映射（E_ASKPASS_NODE_MISSING / E_AUTH / E_GIT）')
  for (const banner of mapped) {
    const copy = REPO_VISIBILITY_MESSAGES[banner]
    assert.equal(typeof copy, 'string', `横幅码 ${banner} 没有文案`)
    assert.ok(copy.trim().length > 0, `横幅码 ${banner} 的文案是空串`)
    assert.match(copy, CHINESE, `横幅码 ${banner} 的文案必须是中文`)
  }
})

test('B05 (b+) 凡是能写进 state.json 的码都必须有文案（含 E_REPO_* 透传）', () => {
  const passthrough = SCAN.throwCodes.filter((code) => code.startsWith('E_REPO_'))
  const mapped = Object.values(REPO_BANNER_RULES)
    .map((rule) => rule.banner)
    .filter((banner) => banner !== null)
  const reachableAsBanner = new Set([...passthrough, ...mapped, ...VISIBILITY_REFUSAL_CODES])
  for (const code of reachableAsBanner) {
    const copy = REPO_VISIBILITY_MESSAGES[code]
    assert.equal(typeof copy, 'string', `${code} 会被写进 status.repoBlockCode，却没有中文文案`)
    assert.match(String(copy), CHINESE, `${code} 的文案必须是中文`)
  }
})

test('B06 (c) 反向无孤儿：REPO_VISIBILITY_MESSAGES 的每个键都可达', () => {
  const reachable = new Set([
    ...VISIBILITY_REFUSAL_CODES,
    // `E_REPO_*` 家族原样透传（engine/sync 里真实抛出的那些）也算可达。
    ...SCAN.throwCodes.filter((code) => code.startsWith('E_REPO_')),
    ...Object.values(REPO_BANNER_RULES)
      .map((rule) => rule.banner)
      .filter((banner) => banner !== null),
  ])
  const orphans = Object.keys(REPO_VISIBILITY_MESSAGES).filter((code) => !reachable.has(code))
  assert.deepEqual(orphans, [], `这些文案永远不会显示（既不是拒绝码也不是映射 banner）：${orphans.join(', ')}`)
  assert.ok(VISIBILITY_REFUSAL_CODES.length >= 6, `可见性拒绝码至少六个，实际 ${VISIBILITY_REFUSAL_CODES.length}`)
})


test('B07 新横幅码 E_REPO_ASKPASS：文案逐字钉住 + 说清"装 Node 或设 DSH_GIT_SYNC_NODE"', () => {
  assert.equal(E_REPO_ASKPASS, 'E_REPO_ASKPASS')
  const copy = REPO_VISIBILITY_MESSAGES[E_REPO_ASKPASS]
  assert.equal(
    copy,
    '找不到可用的 Node.js：HTTPS 推送要靠它把令牌交给 git，没有它就无法完成鉴权。请安装 Node.js，或把环境变量 DSH_GIT_SYNC_NODE 指向 node.exe 的完整路径后重试',
  )
  assert.match(copy, /Node\.js/, '必须点名装 Node.js')
  assert.match(copy, /DSH_GIT_SYNC_NODE/, '必须点名覆盖变量')
  assert.match(copy, /node\.exe/, '必须点名 node.exe')
  assert.match(copy, /鉴权/, '必须说明没有它就无法鉴权')
  // 既有六条文案逐字未动（本模块只新增，不改写）
  assert.equal(REPO_VISIBILITY_MESSAGES.E_REPO_PUBLIC, '仓库是公开的：日程与远程控制配置不允许提交到公开仓库。请把仓库改成私有后重试')
  assert.equal(REPO_VISIBILITY_MESSAGES.E_REPO_AUTH, '令牌无权读取该仓库：请确认令牌有效且具备仓库读权限')
  assert.equal(REPO_VISIBILITY_MESSAGES.E_REPO_NOT_FOUND, '仓库不存在：请检查地址（owner/repo）后重试')
  assert.ok(String(REPO_VISIBILITY_MESSAGES.E_REPO_HOST_UNSUPPORTED).includes('不支持自动校验该仓库的可见性'))
  assert.ok(String(REPO_VISIBILITY_MESSAGES.E_REPO_VISIBILITY_UNKNOWN).includes('暂时无法确认仓库可见性'))
  assert.ok(String(REPO_VISIBILITY_MESSAGES.E_REPO_BAD_RESPONSE).includes('仓库接口返回了非预期内容'))
})

/* -------------------------------------------------------------------------- */
/* repoCodeOfError：落盘口径本身                                                 */
/* -------------------------------------------------------------------------- */

test('B08 repoCodeOfError：askpass 家族 → 横幅码；既有映射逐字不变', () => {
  assert.equal(repoCodeOfError(new SyncError('E_ASKPASS_NODE_MISSING', '找不到可用的 node 解释器')), 'E_REPO_ASKPASS')
  assert.equal(repoCodeOfError(new SyncError('E_ASKPASS_NODE_MISSING', 'x', { code: 'E_ASKPASS_NODE_MISSING' })), 'E_REPO_ASKPASS')
  assert.equal(repoCodeOfError(new SyncError('E_AUTH', '凭据被拒')), 'E_REPO_AUTH')
  assert.equal(repoCodeOfError(new SyncError('E_GIT', '网络不可达')), 'E_REPO_VISIBILITY_UNKNOWN')
  assert.equal(
    repoCodeOfError(new SyncError('E_GIT', '找不到 git', { reason: 'git-missing' })),
    null,
    '本地 git 缺失不是仓库阻断（既有行为）',
  )
  assert.equal(repoCodeOfError(new SyncError('E_REPO_PUBLIC', '仓库是公开的')), 'E_REPO_PUBLIC', 'E_REPO_* 原样透传')
  assert.equal(repoCodeOfError(new SyncError('E_REPO_ROOT_UNAVAILABLE', '根不可写')), 'E_REPO_ROOT_UNAVAILABLE')
  for (const code of ['E_VALIDATION', 'E_CONFLICT', 'E_IO', 'E_SHA_MISMATCH', 'E_PUSH_REJECTED', 'E_CORRUPT', 'E_UNCONFIGURED']) {
    assert.equal(repoCodeOfError(new SyncError(code, 'x')), null, `${code} 必须豁免（不写横幅）`)
  }
  assert.equal(repoCodeOfError(new Error('boom')), null, '非 SyncError 不冒充仓库码')
  assert.equal(repoCodeOfError(null), null)
  assert.equal(repoCodeOfError('E_ASKPASS_NODE_MISSING'), null, '字符串不冒充 SyncError')
})

test('B09 repoBannerCodeOf：表外码返回 null（不猜）', () => {
  assert.equal(repoBannerCodeOf('E_ASKPASS_NODE_MISSING'), 'E_REPO_ASKPASS')
  assert.equal(repoBannerCodeOf('E_GIT'), 'E_REPO_VISIBILITY_UNKNOWN')
  assert.equal(repoBannerCodeOf('E_VALIDATION'), null)
  assert.equal(repoBannerCodeOf('E_NOT_A_REAL_CODE'), null)
})

/* -------------------------------------------------------------------------- */
/* 端到端：真实 RPC 路径 → state.json 的 repoBlockCode                          */
/* -------------------------------------------------------------------------- */

const TOKEN = 'gitee_fake_token_DO_NOT_LEAK_b71c'
const SETTINGS = {
  repoUrl: 'https://gitee.com/ding_haoran/dsh-mobile-remote.git',
  platform: 'gitee',
  authMode: 'https',
  username: 'ding_haoran',
  deviceId: 'pc-a',
  branch: 'main',
  scope: { config: true, providers: true, plugins: true, mcp: true },
}

test('B10 端到端：本机解析不到 node ⇒ testConnection 抛 typed 码、state.json 得到 E_REPO_ASKPASS', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-error-surface-'))
  const homeDir = path.join(root, 'home')
  const profileDir = path.join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# empty\n', 'utf8')
  const service = createRpcService({
    homeDir,
    profileDir,
    dshVersion: 'test-1',
    // 门禁走假 transport：只为了让 saveSettings 落盘，不联网。
    repoPrecheckFetch: async () => ({ status: 200, contentType: 'application/json', body: '{"id":1,"private":true}' }),
  })
  t.after(async () => {
    await service.dispose()
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  const saved = await service.handleRpc({ action: 'saveSettings', settings: SETTINGS, token: TOKEN })
  assert.equal(saved.ok, true, JSON.stringify(saved))

  // 让 askpass 的 node 解析必然失败：显式覆盖指向不存在的路径 + 清空 PATH（只影响本进程，
  // 且解析缓存以 env 为键，不会命中旧的成功结果）。
  const savedEnv = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    PATHEXT: process.env.PATHEXT,
    DSH_GIT_SYNC_NODE: process.env.DSH_GIT_SYNC_NODE,
  }
  process.env.DSH_GIT_SYNC_NODE = path.join(root, 'no-such-dir', 'node.exe')
  process.env.PATH = ''
  process.env.Path = ''
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const probed = await service.handleRpc({ action: 'testConnection' })
  assert.equal(probed.ok, false, JSON.stringify(probed))
  assert.equal(probed.error.code, 'E_ASKPASS_NODE_MISSING', 'askpass 层必须保留自己的 typed 码')
  assert.match(probed.error.message, /node/, '正文要点名 node')

  const state = await service.handleRpc({ action: 'getState' })
  assert.equal(state.ok, true)
  assert.equal(
    state.data.status.repoBlockCode,
    'E_REPO_ASKPASS',
    'state.json 必须给出横幅码（这正是本模块修的那个"面板什么都不显示"）',
  )
  const stateFile = readFileSync(path.join(homeDir, '.dsh', 'dots', 'state.json'), 'utf8')
  assert.equal(stateFile.includes('E_REPO_ASKPASS'), true, 'typed 码必须真的落盘')
  assert.equal(stateFile.includes(TOKEN), false, 'state.json 不得含 token')
})
