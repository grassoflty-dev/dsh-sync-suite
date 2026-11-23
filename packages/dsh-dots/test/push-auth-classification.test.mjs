/**
 * `mod-plugin-push-auth-vs-network`（评审 b11 P2-6）：**远端拒绝凭据**不是**网络不可达**。
 *
 * 缺陷：Gitee 的鉴权失败正文恰好是
 *   `fatal: unable to access 'https://gitee.com/<owner>/<repo>.git/': The requested URL returned error: 403`
 * 旧分类里 `unable to access` 是「网络不可达」的正面证据，于是**令牌被拒**的用户被告知
 * 「检查网络、代理或防火墙」。本文件钉住：先按 git 自己输出的 HTTP 状态码定原因，
 * 再谈文本；并且 `auth-prompt`（拿不出凭据）与 `auth-rejected`（凭据被拒）永不合并。
 *
 * b11b 评审补的三块（本文件同一批钉住）：
 *   · P1-1：407 的**真实**代理文案是 `Received HTTP code 407 from proxy after CONNECT` /
 *     `CONNECT tunnel failed, response 407`，不是 `returned error: 407`；两条都必须认出来，
 *     且新形状**不许**把进度数字 / 令牌片段 / `remote:` 日志里的数字当状态码（A5 / B2）；
 *   · P2-2：`Authentication failed` / `HTTP Basic: Access denied`（无数字状态码）是
 *     「凭据被拒」⇒ `auth-rejected`，与 `auth-prompt`（拿不出凭据）分开（B9）；
 *   · P2-3：5xx 的原因句必须同时提到代理，且 `rpc.isNetworkFailure()` 不再为
 *     `remote-error` / `rate-limited` 写「不可达」（E1）。
 *
 * `mod-plugin-push-classify-hardening` 再收两条（P2-1 / P2-4，本文件 G1 / G2）：
 *   · P2-4：传输证据**分成两类**，只有硬证据算数（`unable to access` 这个 curl 包装前缀
 *     被整条删掉），并且硬证据**赢过**状态码；松形状（协议行 / 裸 `HTTP NNN`）只在
 *     **非 `remote:`/`hint:` 回显行**上成立；
 *   · P2-1：`404` 有了自己的原因 `not-found`（带 `details.status=404`），其它未映射码
 *     （3xx / 400 / 405 / 422 …）落 `git-failed`，**绝不**再退回「网络不可达」。
 *
 * 结构（前置：cd packages/dsh-dots && node scripts/build.mjs）：
 *   A. 纯函数分类器：状态码形状 × 原因映射 × 控制组（DNS 失败仍是 unreachable，
 *      被 kill 的子进程仍是 timeout，即使 stderr 里有 403）；
 *   B. 端到端：每个新原因都经 `pushMain()` + 假 runner，断言 reason / 文案 / `details.status`；
 *   C. 凭据卫生：stderr 里出现令牌形态的值，绝不进 message，也绝不进 details；
 *   D. 引擎侧（`GitRepo`）：ls-remote 走同一套状态码分类，v1 push / fetch 说同一份真相；
 *   E. `reachable` 归因：`rpc.isNetworkFailure()` 逐原因的真值表；
 *   F. cycle 侧：白名单 + 下一步覆盖五个状态码原因（与 PO-09/PO-10 的短语闸门互补）；
 *   G. 证据优先级与未映射码（P2-4 / P2-1 的正面证明 + 反向控制）。
 * 全部只在 os.tmpdir() 外做纯注入，不联网、不跑 live 同步、不写项目仓库、不碰 ~/.dsh/dots。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import {
  GitRepo,
  HTTP_STATUS_CAUSE_ZH,
  GIT_AUTH_REJECTED_NEXT_STEP,
  GIT_NOT_FOUND_NEXT_STEP,
  GIT_PROXY_AUTH_NEXT_STEP,
  GIT_RATE_LIMITED_NEXT_STEP,
  GIT_REMOTE_ERROR_NEXT_STEP,
  TRANSPORT_DROPPED_WRAPPER_PATTERNS,
  TRANSPORT_HARD_EVIDENCE_PATTERNS,
  hasAuthRejectedEvidence,
  httpStatusCodesOf,
  httpStatusFailureOf,
  httpStatusReasonOf,
  hasTransportEvidence,
} from '../dist/engine/git.js'
import { SyncError } from '../dist/engine/errors.js'
import { GitRepoV2Port, pushFailureReason } from '../dist/sync/gitPort.js'
import { isNetworkFailure } from '../dist/rpc.js'
import {
  PUSH_ARGS,
  PUSH_AUTH_PROMPT_NEXT_STEP,
  PUSH_AUTH_REJECTED_NEXT_STEP,
  PUSH_NOT_FOUND_NEXT_STEP,
  PUSH_PROXY_AUTH_NEXT_STEP,
  PUSH_RATE_LIMITED_NEXT_STEP,
  PUSH_REMOTE_ERROR_NEXT_STEP,
  PUSH_TIMEOUT_NEXT_STEP,
  PUSH_UNREACHABLE_NEXT_STEP,
  V2_ERROR,
  gitStageFailure,
  makeIntentId,
  runV2Cycle,
} from '../dist/sync/cycle.js'
import { FRESH_SCHEMA_TEXT } from '../dist/timeline/index.js'

const DAY = '2026-11-23'
const TS = `${DAY}T01:30:00.000Z`
const TS_LOCAL = `${DAY}T09:30:00+08:00`
const HTTPS = 'https://gitee.com/acme/repo.git'

/** 令牌形态的假值：只用来证明它**不会**出现在任何用户可见面。 */
const TOKEN_SHAPE = 'ghp_FAKEtoken0123456789ABCDEFGHIJKLMNOPQ'

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

/** push 只走 runner：authMode=ssh 让 buildEnv 不起 askpass/node（分类与鉴权环境无关）。 */
function portWithRunner(runner) {
  return new GitRepoV2Port({
    dir: path.join(os.tmpdir(), 'dsh-push-auth-class-unused'),
    repoUrl: HTTPS,
    branch: 'main',
    authMode: 'ssh',
    token: null,
    runner,
  })
}

function failRunner(stderr, code = 128) {
  return async () => ({ code, stdout: '', stderr })
}

/** 捕获 typed 错误对象（要给 details 做逐字段断言）。 */
async function captureRejection(fn) {
  try {
    await fn()
  } catch (error) {
    return error
  }
  assert.fail('预期抛出 typed 错误，实际成功了')
}

/** 一次真实 pushMain()：reason / message / details 全部来自 shipped 代码。 */
async function pushWith(stderr) {
  const port = portWithRunner(failRunner(stderr))
  try {
    return await captureRejection(() => port.pushMain(PUSH_ARGS))
  } finally {
    await port.dispose()
  }
}

/** 引擎侧：用假 execFile 让 GitRepo 的命令以指定 stderr 非零退出。 */
function repoWithStderr(stderr, code = 128) {
  return new GitRepo({
    dir: path.join(os.tmpdir(), 'dsh-push-auth-class-work'),
    repoUrl: HTTPS,
    branch: 'main',
    authMode: 'ssh',
    execFileImpl: (file, args, options, callback) => {
      callback(Object.assign(new Error('Command failed'), { code }), '', stderr)
    },
  })
}

/* cycle 侧：一条可重放意图 + 只有 push 抛 typed 错的端口。 */

class MemFs {
  constructor(seed = {}) { this.files = new Map(Object.entries(seed)) }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) { const tmp = `${rel}.tmp`; this.files.set(tmp, text); return tmp }
  async readTemp(tmp) { return this.files.get(tmp) ?? '' }
  async rename(tmp, rel) { this.files.set(rel, this.files.get(tmp)); this.files.delete(tmp) }
  async backupIfExists() { return false }
  async append(rel, text) { this.files.set(rel, (this.files.get(rel) ?? '') + text) }
  async exists(rel) { return this.files.has(rel) }
}

class MemOutbox {
  constructor(entries) { this.entries = entries.slice() }
  async load() { return this.entries.slice() }
  async save(entries) { this.entries = entries.slice() }
}

class PushFailPort {
  constructor(error) { this.error = error }
  async branchName() { return 'main' }
  async fetchMain() {}
  async headSha() { return 'a'.repeat(40) }
  async originMainSha() { return 'a'.repeat(40) }
  async showRemote() { return '' }
  async showHead() { return '' }
  async aheadBehind() { return { ahead: 0, behind: 0 } }
  async aheadCommits() { return [] }
  async addPaths() {}
  async commit() {}
  async pushMain() { throw this.error }
}

function pendingIntent() {
  return {
    intentId: makeIntentId(DAY, 'a1', TS, 'upsert'),
    op: 'upsert', date: DAY, id: 'a1', ts: TS,
    line: JSON.stringify({
      id: 'a1', ts: TS, title: 't', body: '', author: '我', done: false,
      media: [], ai_processed: false, opened_at: TS,
    }),
    enqueuedAt: TS_LOCAL, attempts: 0, state: 'pending', lastError: '',
  }
}

async function cycleWithPushError(error) {
  const outbox = new MemOutbox([pendingIntent()])
  const result = await runV2Cycle({
    days: [DAY], git: new PushFailPort(error), fs: new MemFs({ 'timeline/schema.json': FRESH_SCHEMA_TEXT }),
    outbox, now: new Date(TS_LOCAL),
  })
  return { result, outbox }
}

/* 五个状态码原因在源码里的唯一真值：供措辞一致性断言（不含 URL / 用户名 / 令牌）。 */

const NEW_REASONS = Object.freeze({
  'auth-rejected': {
    status: 403,
    cause: HTTP_STATUS_CAUSE_ZH['auth-rejected'],
    engineNext: GIT_AUTH_REJECTED_NEXT_STEP,
    cycleNext: PUSH_AUTH_REJECTED_NEXT_STEP,
    pushPhrase: '推送失败：远端拒绝了这个用户名或令牌（HTTP 401/403），凭据需要重新核对',
  },
  // b11b P2-1（本批闭合）：404 有了自己的原因与下一步——「仓库不存在 / 凭据看不到它」，
  // 既不是网络问题，也不是「令牌被拒」。
  'not-found': {
    status: 404,
    cause: HTTP_STATUS_CAUSE_ZH['not-found'],
    engineNext: GIT_NOT_FOUND_NEXT_STEP,
    cycleNext: PUSH_NOT_FOUND_NEXT_STEP,
    pushPhrase: '推送失败：远端返回 404，仓库不存在或当前凭据看不到它',
  },
  'proxy-auth': {
    status: 407,
    cause: HTTP_STATUS_CAUSE_ZH['proxy-auth'],
    engineNext: GIT_PROXY_AUTH_NEXT_STEP,
    cycleNext: PUSH_PROXY_AUTH_NEXT_STEP,
    pushPhrase: '推送失败：代理要求它自己的鉴权（HTTP 407），不是仓库凭据的问题',
  },
  'rate-limited': {
    status: 429,
    cause: HTTP_STATUS_CAUSE_ZH['rate-limited'],
    engineNext: GIT_RATE_LIMITED_NEXT_STEP,
    cycleNext: PUSH_RATE_LIMITED_NEXT_STEP,
    pushPhrase: '推送失败：远端限流（HTTP 429），稍后再推',
  },
  'remote-error': {
    status: 502,
    cause: HTTP_STATUS_CAUSE_ZH['remote-error'],
    engineNext: GIT_REMOTE_ERROR_NEXT_STEP,
    cycleNext: PUSH_REMOTE_ERROR_NEXT_STEP,
    pushPhrase: '推送失败：远端或代理返回 HTTP 5xx，本地改动与令牌都没有问题',
  },
})

/** 每条新原因的“真实 git stderr”（形状都来自 git / libcurl 实际会打印的东西）。 */
const STDERR_SHAPES = Object.freeze({
  'auth-rejected': [
    // 评审 b11 P2-6 的原始形状（Gitee 403）：
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 403",
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 401",
    'error: 403 Forbidden while accessing https://gitee.com/acme/repo.git/info/refs?service=git-receive-pack',
    'error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403',
  ],
  'not-found': [
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 404",
    'fatal: unable to access remote: HTTP 404',
  ],
  'proxy-auth': [
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 407",
    'fatal: unable to access remote: HTTP/1.1 407 Proxy Authentication Required',
    // b11b P1-1：代理**真正**会打印的两种形态（旧表里一条都没有，B2/T14 当时只钉住了
    // 上面那条 `returned error: 407`，读测试的人会以为 CONNECT 形状已被覆盖）。
    // ① git + libcurl 走 HTTPS 代理：
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': Received HTTP code 407 from proxy after CONNECT",
    // ② curl 8.x：
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': CONNECT tunnel failed, response 407",
  ],
  'rate-limited': [
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 429",
    'fatal: unable to access remote: HTTP/1.1 429 Too Many Requests',
  ],
  'remote-error': [
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 502",
    'error: 503 Service Unavailable while accessing https://gitee.com/acme/repo.git/info/refs',
    'fatal: unable to access remote: HTTP 500',
  ],
})

/* -------------------------------------------------------------------------- */
/* A. 纯函数分类器：状态码形状与映射                                            */
/* -------------------------------------------------------------------------- */

test('A1 状态码形状：git 会打印的五种形态都能取出数字，端口/进度数字不会被误当状态码', () => {
  const cases = [
    ["fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 403", 403],
    ['error: 403 Forbidden while accessing https://gitee.com/acme/repo.git/info/refs', 403],
    ['fatal: unable to access remote: HTTP 403', 403],
    ['error: RPC failed; HTTP 403 curl 22', 403],
    ['fatal: unable to access remote: HTTP/1.1 429 Too Many Requests', 429],
    ['returned error: 502', 502],
    // b11b P1-1：代理 CONNECT 的两种真实文案（407 的**主流**形状）
    ["fatal: unable to access 'https://gitee.com/acme/repo.git/': Received HTTP code 407 from proxy after CONNECT", 407],
    ["fatal: unable to access 'https://gitee.com/acme/repo.git/': CONNECT tunnel failed, response 407", 407],
  ]
  for (const [text, expected] of cases) {
    assert.deepEqual(httpStatusCodesOf(text), [expected], text)
  }
  // 没有状态码形状的文本一律空：端口号、字节进度、提交 sha 都不许被当成状态码。
  assert.deepEqual(httpStatusCodesOf('fatal: unable to access remote: Failed to connect to gitee.com port 443'), [])
  assert.deepEqual(httpStatusCodesOf('Receiving objects: 100% (12/12), 1.2 MiB | 300.00 KiB/s'), [])
  assert.deepEqual(httpStatusCodesOf('unable to access: 0 objects'), [])
  // 404 现在**能定原因**（b11b P2-1 收口）：旧断言是 `null`（「404 不发明原因」），
  // 结果是兜底把「仓库不存在」说成「网络不可达」；retarget 成 not-found + 404，比旧断言更严
  // （旧断言只钉「没原因」，新断言连原因、状态码、文案、下一步都钉）。
  assert.deepEqual(httpStatusCodesOf('fatal: unable to access remote: HTTP 404'), [404])
  assert.deepEqual(httpStatusFailureOf('fatal: unable to access remote: HTTP 404'),
    { reason: 'not-found', status: 404 }, '404 ⇒ not-found（不是网络、也不是凭据）')
})

test('A5 新形状不越界：进度/令牌/`remote:` 日志里的数字，以及 HTTP/2 200 都定不出原因', () => {
  // 这一条是 b11b P1-1 的**反向**证明：新增两条代理形状时不许把匹配面撑大。
  // 逐个形状既查「取出哪些码」，也查「能不能定原因」，避免只靠一层掩盖。
  const noCodes = [
    // 进度行里的速率与比例（libcurl 的传输进度条）
    'Resolving deltas: 100% (403/403), done.',
    'remote: counting objects: 1.2 MiB | 403 KiB/s (download rate)',
    // 令牌形态的值：407 后面紧跟字母，绝不是一个状态码
    'fatal: unable to access \'https://gitee.com/acme/repo.git/\': invalid token=407abc',
    // 进度行里出现一个孤立的 `response` 词，但**不是** `CONNECT tunnel failed, response NNN`
    'writing objects: response received, 407 objects packed, done',
    // `remote:` 钩子日志只是"提到了一个数字"，连 `from proxy` / `CONNECT tunnel failed` 都没有
    'remote: build cache: received HTTP code 503 from the artifact index',
    'remote: proxy settings loaded: response 407 expected for the upstream',
  ]
  for (const text of noCodes) {
    assert.equal(httpStatusFailureOf(text), null, `不许定原因：${text}`)
    assert.equal(httpStatusCodesOf(text).length, 0, `不许取出任何码：${text}`)
  }
  // `HTTP/2 200` 单独钉：协议行形状确实认得出 200，但 200 不映射原因 ⇒ 仍然 null。
  assert.deepEqual(httpStatusCodesOf('HTTP/2 200'), [200], '协议行形状仍按原样认得 200')
  assert.equal(httpStatusFailureOf('HTTP/2 200'), null, '200 不在映射表，绝不发明原因')
  // b11b P2-4（本批闭合）：`remote:` / `hint:` 行是**服务器回显**，不是 git 的 HTTP 客户端；
  // 松形状（协议行 / 裸 `HTTP NNN`）只对非回显行生效。旧断言在这里是 `[403]`（承认误认），
  // retarget 成 `[]` —— 这是**收紧**：旧断言把 bug 钉成现状，新断言把正确行为钉死。
  assert.deepEqual(httpStatusCodesOf('remote: build log: see HTTP 403 section'), [])
  assert.equal(httpStatusFailureOf('remote: build log: see HTTP 403 section'), null)
  assert.deepEqual(httpStatusCodesOf('hint: HTTP 403 section is documented below'), [])
  assert.deepEqual(httpStatusCodesOf('  remote: HTTP/1.1 503 from the hook'), [], '行首有空白的回显行同样跳过')
  // 行过滤的**作用域**要说清：本批只给两条松形状加过滤（评审 b11b P2-4 的原文要求）。
  // 句子形状仍然整段扫——它们是 git 自己的措辞；若远端钩子逐字抄一句 `returned error: 403`，
  // 仍会被认领（残留面，未在本批收窄，记在报告 unverified 边界里）。
  assert.deepEqual(httpStatusCodesOf('remote: returned error: 403'), [403])
  // 新加的两条形状不参与这种误认：同样的 `remote:` 日志换成代理措辞也不认。
  assert.equal(httpStatusFailureOf('remote: see Received HTTP code 407 section'), null)
})

test('A2 映射：401/403 → auth-rejected，404 → not-found，407 → proxy-auth，429 → rate-limited，5xx → remote-error，其它 null', () => {
  for (const status of [401, 403]) assert.equal(httpStatusReasonOf(status), 'auth-rejected', String(status))
  // b11b P2-1 retarget（**收紧**）：404 以前在下面那张 null 表里（「不发明原因」），
  // 结果是兜底把它说成网络不可达。现在它有自己的原因，所以从 null 表移到正向断言。
  assert.equal(httpStatusReasonOf(404), 'not-found')
  assert.equal(httpStatusReasonOf(407), 'proxy-auth')
  assert.equal(httpStatusReasonOf(429), 'rate-limited')
  for (const status of [500, 502, 503, 504, 599]) assert.equal(httpStatusReasonOf(status), 'remote-error', String(status))
  // 仍然**不发明原因**的码：1xx/2xx/3xx/400/405/422/超界/非整数。
  for (const status of [200, 204, 301, 302, 304, 400, 405, 409, 422, 451, 600, 999, 0, -1, 40.5, Number.NaN]) {
    assert.equal(httpStatusReasonOf(status), null, String(status))
  }
  assert.equal(httpStatusFailureOf("fatal: unable to access 'x': The requested URL returned error: 403").status, 403)
  assert.equal(httpStatusFailureOf('error: 502 Bad Gateway while accessing https://x/y.git').status, 502)
  // 未映射码在**纯函数层**仍是 null（「认出了码、但没映射」由调用方区分）：
  assert.equal(httpStatusFailureOf("fatal: unable to access 'x': The requested URL returned error: 302"), null)
  assert.deepEqual(httpStatusCodesOf("fatal: unable to access 'x': The requested URL returned error: 302"), [302])
})

test('A3 控制组：真正的 DNS / 连接失败仍是 unreachable，绝不会被说成 auth-rejected', async () => {
  // 同一批“unable to access”前缀、但没有状态码 ⇒ 传输层证据成立。
  for (const stderr of [
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': Could not resolve host: gitee.com",
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': Failed to connect to gitee.com port 443",
  ]) {
    assert.equal(hasTransportEvidence(stderr), true)
    assert.equal(httpStatusFailureOf(stderr), null, '没有状态码')
    const error = await pushWith(stderr)
    assert.equal(error.code, V2_ERROR.PUSH_REJECTED)
    assert.equal(error.details.reason, 'unreachable')
    assert.equal(error.message, '推送失败：网络不可达（无法解析或连接到远端）')
    assert.equal(error.details.status, undefined, '不可达没有状态码，details 不留假数字')
    // 反向控制：403 与 DNS 失败的文本几乎只差最后一段，结局必须不同。
    const rejected = await pushWith(
      "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 403")
    assert.equal(rejected.details.reason, 'auth-rejected')
    assert.notEqual(rejected.details.reason, error.details.reason)
    assert.notEqual(rejected.message, error.message)
  }
})

test('A4 控制组：被预算杀死的子进程仍是 timeout，即使 stderr 里恰好有 403 字样', async () => {
  // 结构信号优先：进程被杀说明“没有等到远端回答”，不构成“远端拒绝凭据”。
  const killedWith403 = await pushWith('fatal: The requested URL returned error: 403')
  assert.equal(killedWith403.details.reason, 'auth-rejected', '基线：不杀时这份文本确实是 auth-rejected')

  const port = portWithRunner(async () => {
    throw Object.assign(
      new Error("Command failed: git push\nfatal: The requested URL returned error: 403"),
      { killed: true, code: 'ETIMEDOUT' },
    )
  })
  try {
    const error = await captureRejection(() => port.pushMain(PUSH_ARGS))
    assert.equal(error.details.reason, 'timeout')
    assert.equal(error.details.budgetMs, 120_000, '超时仍带 push 的真实预算')
    assert.equal(error.details.status, undefined, '超时不是状态码原因，details 不掺 403')
    assert.equal(/网络不可达/.test(error.message), false)
    assert.equal(/远端拒绝|401\/403/.test(error.message), false, '被杀的进程不得声称凭据被拒')
  } finally {
    await port.dispose()
  }
  // 纯函数面同样成立（含 engine 的 typed timeout 覆盖文本）。
  assert.equal(pushFailureReason(Object.assign(new Error('HTTP 403'), { killed: true })), 'timeout')
  assert.equal(pushFailureReason(new SyncError('E_GIT', 'HTTP 403', { reason: 'timeout' })), 'timeout')
})

/* -------------------------------------------------------------------------- */
/* B. 端到端：每个新原因经 pushMain() 都给出正确的 reason / 文案 / status         */
/* -------------------------------------------------------------------------- */

test('B1 auth-rejected：Gitee 403 原串 → 凭据被拒文案 + details.status=403（绝不是网络不可达）', async () => {
  const gitee403 =
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 403"
  const error = await pushWith(gitee403)
  assert.equal(error.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(error.details.reason, 'auth-rejected')
  assert.equal(error.details.status, 403)
  assert.equal(error.message, NEW_REASONS['auth-rejected'].pushPhrase)
  assert.equal(/网络不可达|不可达/.test(error.message), false, '令牌被拒绝不许说成网络不可达')
  assert.equal(/auth-prompt|askpass/.test(error.message), false, '凭据已送出，不许说成拿不到凭据')
  // 401 走同一原因（凭据被拒），但 status 如实报 401。
  const unauthorized = await pushWith(
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 401")
  assert.equal(unauthorized.details.reason, 'auth-rejected')
  assert.equal(unauthorized.details.status, 401)
  assert.equal(unauthorized.message, error.message, '同一原因同一句文案')
})

test('B2 proxy-auth：407 → 代理鉴权文案，details.status=407，不再指向仓库凭据（含两种 CONNECT 真实形态）', async () => {
  // 既有形状保留（`returned error: 407`），并补上代理**真正**会打印的两种形态（b11b P1-1）。
  // 数量断言保证"两条真实形态没有被悄悄删掉"：旧表其实只有 2 条、都不含 CONNECT。
  assert.equal(STDERR_SHAPES['proxy-auth'].length, 4, 'proxy-auth 形状表必须有 4 条（含两种 CONNECT 形态）')
  for (const stderr of STDERR_SHAPES['proxy-auth']) {
    const error = await pushWith(stderr)
    assert.equal(error.details.reason, 'proxy-auth', stderr)
    assert.equal(error.details.status, 407, stderr)
    assert.equal(error.message, NEW_REASONS['proxy-auth'].pushPhrase, stderr)
    assert.equal(/HTTPS_PROXY/.test(error.message), false, '代理口令的修法在下一步里，不在原因句里')
    assert.equal(/网络不可达/.test(error.message), false, `代理鉴权失败不许说成网络不可达：${stderr}`)
  }
  // 两条 CONNECT 形态逐条点名（不靠循环掩盖"到底哪条过了"）。
  for (const stderr of [
    "fatal: unable to access 'x': Received HTTP code 407 from proxy after CONNECT",
    "fatal: unable to access 'x': CONNECT tunnel failed, response 407",
  ]) {
    const error = await pushWith(stderr)
    assert.equal(error.details.reason, 'proxy-auth', stderr)
    assert.equal(error.details.status, 407, stderr)
  }
})

test('B3 rate-limited：429 → 限流文案，details.status=429', async () => {
  for (const stderr of STDERR_SHAPES['rate-limited']) {
    const error = await pushWith(stderr)
    assert.equal(error.details.reason, 'rate-limited', stderr)
    assert.equal(error.details.status, 429, stderr)
    assert.equal(error.message, NEW_REASONS['rate-limited'].pushPhrase, stderr)
  }
})

test('B4 remote-error：5xx（502 / 503 while accessing / HTTP 500）→ 服务端文案，details.status 如实', async () => {
  const expected = [
    ["fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 502", 502],
    ['error: 503 Service Unavailable while accessing https://gitee.com/acme/repo.git/info/refs', 503],
    ['fatal: unable to access remote: HTTP 500', 500],
  ]
  for (const [stderr, status] of expected) {
    const error = await pushWith(stderr)
    assert.equal(error.details.reason, 'remote-error', stderr)
    assert.equal(error.details.status, status, stderr)
    assert.equal(error.message, NEW_REASONS['remote-error'].pushPhrase, stderr)
    assert.equal(/网络不可达/.test(error.message), false, '服务端 5xx 不许说成用户网络问题')
    assert.equal(/令牌|凭据/.test(error.message), /令牌/.test(NEW_REASONS['remote-error'].pushPhrase))
  }
})

test('B5 auth-prompt 语义不变：拿不到凭据仍是 auth-prompt，绝不会被合并成 auth-rejected', async () => {
  const cases = [
    'fatal: could not read Username for \'https://gitee.com\': terminal prompts disabled',
    'fatal: could not read Password for \'https://gitee.com/acme/repo.git\': No such device or address',
  ]
  for (const stderr of cases) {
    const error = await pushWith(stderr)
    assert.equal(error.details.reason, 'auth-prompt', stderr)
    assert.equal(error.message,
      '推送失败：HTTPS 鉴权无法通过（git 已禁用交互提示，askpass／用户名或令牌不可用）；请检查鉴权配置后重试', stderr)
    assert.equal(error.details.status, undefined, '没有状态码就不许编一个')
  }
})

test('B9 凭据被拒的**文本**形态（没有数字状态码）→ auth-rejected，绝不退回 auth-prompt', async () => {
  // b11b P2-2：`Authentication failed` / `HTTP Basic: Access denied` 是「凭据已送出、被拒绝」，
  // 旧实现把它们判成 auth-prompt，于是终端说「askpass／用户名或令牌**不可用**」——
  // 用户去改本机鉴权环境，而真相是令牌过期。这里把两桶的边界逐条钉死。
  const rejected = [
    "fatal: Authentication failed for 'https://gitee.com/acme/repo.git/'",
    'remote: HTTP Basic: Access denied\nfatal: Authentication failed for \'https://gitlab.com/acme/repo.git/\'',
    'remote: HTTP Basic: Access denied',
    'fatal: Invalid username or password',
  ]
  for (const stderr of rejected) {
    const error = await pushWith(stderr)
    assert.equal(error.details.reason, 'auth-rejected', stderr)
    assert.equal(error.message, NEW_REASONS['auth-rejected'].pushPhrase, stderr)
    assert.equal(error.details.status, undefined, `没有数字状态码就不许编一个：${stderr}`)
    assert.equal(/askpass|不可用/.test(error.message), false, `被拒绝 ≠ 不可用：${stderr}`)
    assert.equal(/网络不可达/.test(error.message), false, stderr)
  }
  // 控制组：真正**拿不出**凭据的形态仍是 auth-prompt（不许被并进 auth-rejected）。
  for (const stderr of [
    "fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
    "fatal: could not read Password for 'https://gitee.com/acme/repo.git': No such device or address",
  ]) {
    const error = await pushWith(stderr)
    assert.equal(error.details.reason, 'auth-prompt', stderr)
  }
  // 两张表是同一份：push 侧复用 engine 的 `hasAuthRejectedEvidence()`，不各写一份。
  assert.equal(hasAuthRejectedEvidence("fatal: Authentication failed for 'x'"), true)
  assert.equal(hasAuthRejectedEvidence("fatal: could not read Username for 'x': terminal prompts disabled"), false)
  assert.equal(pushFailureReason(new Error("fatal: Authentication failed for 'x'")), 'auth-rejected')
  assert.equal(pushFailureReason(new Error("fatal: could not read Username for 'x'")), 'auth-prompt')
})

test('B6 cycle 端到端：五个状态码原因的短语过白名单，下一步各自点名（互不相同）', async () => {
  // 先钉住每一条“真实 git stderr 形状”都落到它该落的原因上（表里没有未使用样本）。
  for (const [reason, shapes] of Object.entries(STDERR_SHAPES)) {
    for (const stderr of shapes) {
      const error = await pushWith(stderr)
      assert.equal(error.details.reason, reason, stderr)
      assert.equal(error.message, NEW_REASONS[reason].pushPhrase, stderr)
    }
  }

  const seenMessages = new Set()
  const seenSteps = new Set()
  for (const [reason, spec] of Object.entries(NEW_REASONS)) {
    const error = new SyncError(V2_ERROR.PUSH_REJECTED, spec.pushPhrase, { reason, status: spec.status })
    const { result, outbox } = await cycleWithPushError(error)
    assert.equal(result.ok, false, reason)
    assert.equal(result.code, V2_ERROR.PUSH_REJECTED, reason)
    // 短语逐字存活（没有被终态白名单折叠成「原因类别未识别」）。
    assert.equal(result.message.includes(spec.pushPhrase), true, reason)
    assert.equal(result.message.includes('原因类别未识别'), false, reason)
    // 下一步按原因选，且不是那条「远端被推进」的通用建议。
    assert.equal(result.message.includes(spec.cycleNext), true, reason)
    assert.equal(result.message.includes('其他设备推进'), false, reason)
    // 失败只停放，不报成功。
    assert.equal(outbox.entries[0].state, 'pending', reason)
    assert.equal(outbox.entries[0].attempts, 1, reason)
    assert.equal(outbox.entries[0].lastError.includes(spec.pushPhrase), true, reason)
    seenMessages.add(result.message)
    seenSteps.add(spec.cycleNext)
  }
  // 5 = 本批新增的 not-found 之后的状态码原因数（四条 → 五条），retarget 只改数字，
  // 唯一性要求本身没变（任两条撞车就会小于 5）。
  assert.equal(seenMessages.size, 5, '五种原因的终态消息必须互不相同')
  assert.equal(seenSteps.size, 5, '五种原因的下一步必须互不相同')
  // 与超时 / 不可达的下一步也不许撞车（否则等于没分）。
  assert.equal(Object.values(NEW_REASONS).some((spec) => spec.cycleNext.includes('检查网络')), false)
})

test('B8 nextStepOf 覆盖十类原因：五个状态码原因与 auth-prompt 各有专属下一步，两条历史原因共用默认建议', () => {
  const typed = (reason) => new SyncError(V2_ERROR.PUSH_REJECTED, '推送失败：x', { reason })
  const decidedOf = (reason) => gitStageFailure(typed(reason), {
    code: V2_ERROR.PUSH_REJECTED, message: 'fallback',
  })
  const stepOf = (reason) => {
    const { code, message } = decidedOf(reason)
    assert.equal(code, V2_ERROR.PUSH_REJECTED, reason)
    assert.equal(message.startsWith('E_PUSH_REJECTED: 推送失败：x'), true, reason)
    // 每条消息只追加**一个**下一步（多追加就是重复建议）。
    assert.equal(message.split('下一步：').length - 1, 1, reason)
    return message.slice('E_PUSH_REJECTED: 推送失败：x'.length)
  }

  const expected = {
    timeout: PUSH_TIMEOUT_NEXT_STEP,
    unreachable: PUSH_UNREACHABLE_NEXT_STEP,
    network: PUSH_UNREACHABLE_NEXT_STEP, // 旧字段兼容：network = unreachable
    'auth-rejected': PUSH_AUTH_REJECTED_NEXT_STEP,
    // b11b P2-1：404 有了自己的动作（核对地址 / 私有库授权），不再借用网络或远端分叉建议。
    'not-found': PUSH_NOT_FOUND_NEXT_STEP,
    'proxy-auth': PUSH_PROXY_AUTH_NEXT_STEP,
    'remote-error': PUSH_REMOTE_ERROR_NEXT_STEP,
    'rate-limited': PUSH_RATE_LIMITED_NEXT_STEP,
    // b11b P2-2 retarget（更严）：auth-prompt 以前与 non-fast-forward / git-failed 共用 DEFAULT，
    // 于是「HTTPS 鉴权无法通过」后面跟着「检查远端是否被其他设备推进」—— 自相矛盾。
    // 现在它有自己的动作，因此这里从"三条共用一条"收紧成"每类各一条"。
    'auth-prompt': PUSH_AUTH_PROMPT_NEXT_STEP,
  }
  for (const [reason, step] of Object.entries(expected)) {
    assert.equal(stepOf(reason), step, `${reason} 必须拿到自己那条下一步`)
  }
  // not-found 的下一步必须真的讲「仓库地址 / 私有库」，不许提网络（P2-1 的全部意义）。
  assert.equal(PUSH_NOT_FOUND_NEXT_STEP.includes('仓库地址'), true)
  assert.equal(PUSH_NOT_FOUND_NEXT_STEP.includes('私有库'), true)
  assert.equal(PUSH_NOT_FOUND_NEXT_STEP.includes('网络'), false)
  // auth-prompt 的下一步必须真的讲「填全登录名/令牌」，不许是那条远端分叉建议。
  assert.equal(PUSH_AUTH_PROMPT_NEXT_STEP.includes('登录名/令牌'), true)
  assert.equal(PUSH_AUTH_PROMPT_NEXT_STEP.includes('其他设备推进'), false)

  // 两条历史原因仍故意共用同一条默认建议（短语本身已写动作，改它等于改动已钉死的字节）：
  // 它们既不许被新原因借走，也不许把其它原因的下一步吞掉。
  const legacySteps = new Set(['non-fast-forward', 'git-failed'].map(stepOf))
  assert.equal(legacySteps.size, 1, '两条历史原因必须共用同一条默认建议')
  const legacy = [...legacySteps][0]
  assert.equal(legacy.includes('检查远端是否被其他设备推进'), true, '默认建议保持原措辞')
  assert.notEqual(stepOf('auth-prompt'), legacy, 'auth-prompt 不许再借用默认建议')
  for (const step of new Set(Object.values(expected))) {
    if (step === legacy) continue
    assert.equal(legacy.includes(step), false, '历史原因不得借用新原因的下一步')
  }
  // 未知 reason / 原型链键：fail-closed 回默认，绝不留空、绝不抛。
  for (const bogus of ['constructor', '__proto__', 'toString', 'unknown', '']) {
    assert.equal(stepOf(bogus), legacy, bogus)
  }
})

test('B7 措辞一致性：push 短语与 engine 的状态码原因说同一件事，且没有 URL / 令牌', () => {
  for (const [reason, spec] of Object.entries(NEW_REASONS)) {
    // 原因措辞只有一份：把 engine 的 cause 按分句拆开，每一句都必须原样出现在 push 短语里
    //（push 短语可以多插「（HTTP 5xx）」这类限定，但不许换一种说法）。
    for (const clause of spec.cause.split('，')) {
      assert.equal(spec.pushPhrase.includes(clause), true, `${reason} 的 push 短语必须含原因分句「${clause}」`)
    }
    assert.equal(spec.pushPhrase.startsWith('推送失败：'), true, reason)
    assert.equal(spec.pushPhrase.length <= 96, true, `${reason} 必须能整句通过 96 字符的终态闸门`)
    assert.equal(spec.engineNext.startsWith('下一步：'), true, reason)
    assert.equal(spec.cycleNext.startsWith('；下一步：'), true, reason)
    for (const text of [spec.pushPhrase, spec.engineNext, spec.cycleNext]) {
      assert.equal(/https?:\/\//i.test(text), false, `${reason} 文案不许带 URL`)
      assert.equal(/[A-Za-z0-9_-]{20,}/.test(text), false, `${reason} 文案不许带令牌形态长串`)
      assert.equal(text.includes('\n'), false, `${reason} 文案必须单行`)
      assert.equal(/[\u4e00-\u9fa5]/.test(text), true, `${reason} 文案必须是中文`)
    }
  }
})

/* -------------------------------------------------------------------------- */
/* C. 凭据卫生：状态码分支只看数字，绝不回显令牌                                  */
/* -------------------------------------------------------------------------- */

test('C1 令牌形态的 stderr：绝不出现在 message / details（状态码分支只报数字与固定文案）', async () => {
  const leaky =
    "fatal: unable to access 'https://acme:" + TOKEN_SHAPE + "@gitee.com/acme/repo.git/': "
    + 'The requested URL returned error: 403'
  const error = await pushWith(leaky)
  assert.equal(error.details.reason, 'auth-rejected')
  assert.equal(error.details.status, 403)
  const haystack = [error.message, JSON.stringify(error.details)].join('\n')
  assert.equal(haystack.includes(TOKEN_SHAPE), false, '令牌形态的值绝不许进 message 或 details')
  assert.equal(/ghp_|token/i.test(haystack), false, '连令牌关键字都不许带出')
  assert.equal(haystack.includes('acme:'), false, '被脱敏的 URL userinfo 也不许回显')
  // details 只允许白名单字段（reason + status），没有 command / text / stderr / url。
  assert.deepEqual(Object.keys(error.details).sort(), ['reason', 'status'])

  // engine 侧（ls-remote / fetch / v1 push）：同样的卫生要求。
  const repo = repoWithStderr(leaky)
  try {
    const engineError = await captureRejection(() => repo.lsRemote())
    assert.equal(engineError.details.reason, 'auth-rejected')
    assert.equal(engineError.details.status, 403)
    assert.equal(engineError.code, 'E_AUTH', '凭据被拒仍是鉴权类错误（调用方据此提示登录名/令牌）')
    const engineHaystack = [engineError.message, JSON.stringify(engineError.details)].join('\n')
    assert.equal(engineHaystack.includes(TOKEN_SHAPE), false, '引擎侧也不许把令牌带进错误面')
    assert.equal(engineHaystack.includes('acme:'), false)
    assert.deepEqual(Object.keys(engineError.details).sort(),
      ['command', 'exitCode', 'network', 'reason', 'status'])
  } finally {
    await repo.dispose()
  }
})

/* -------------------------------------------------------------------------- */
/* D. 引擎侧共享分类：ls-remote / fetch / v1 push 说同一份真相                    */
/* -------------------------------------------------------------------------- */

test('D1 GitRepo 的 401/403 与 gitPort 同因同码（共享 httpStatusFailureOf，不各写一份）', async () => {
  const shapes = [
    ["fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 403", 403],
    ["fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 401", 401],
    ["fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 407", 407],
    ["fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 429", 429],
    ["fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 502", 502],
  ]
  for (const [stderr, status] of shapes) {
    const expected = httpStatusReasonOf(status)
    // 端口侧
    const portError = await pushWith(stderr)
    assert.equal(portError.details.reason, expected, stderr)
    assert.equal(portError.details.status, status, stderr)
    // 引擎侧（ls-remote 是 v1 的“测试连接”，用户最先看到的那一句）
    const repo = repoWithStderr(stderr)
    try {
      const engineError = await captureRejection(() => repo.lsRemote())
      assert.equal(engineError.details.reason, expected, stderr)
      assert.equal(engineError.details.status, status, stderr)
      assert.equal(engineError.code, expected === 'auth-rejected' ? 'E_AUTH' : 'E_GIT', stderr)
      assert.equal(engineError.message.includes(`HTTP ${status}`), true, stderr)
      assert.equal(engineError.message.includes(HTTP_STATUS_CAUSE_ZH[expected]), true, stderr)
      assert.equal(engineError.message.includes(specNext(expected)), true, stderr)
      assert.equal(/网络不可达/.test(engineError.message), false, stderr)
    } finally {
      await repo.dispose()
    }
  }
})

function specNext(reason) {
  return {
    'auth-rejected': GIT_AUTH_REJECTED_NEXT_STEP,
    'proxy-auth': GIT_PROXY_AUTH_NEXT_STEP,
    'rate-limited': GIT_RATE_LIMITED_NEXT_STEP,
    'remote-error': GIT_REMOTE_ERROR_NEXT_STEP,
  }[reason]
}

test('D2 v1 push（GitRepo.push）同样先认状态码：403 不再被说成网络不可达', async () => {
  const repo = repoWithStderr(
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 403")
  try {
    const error = await captureRejection(() => repo.push())
    assert.equal(error.code, 'E_AUTH')
    assert.equal(error.details.reason, 'auth-rejected')
    assert.equal(error.details.status, 403)
    assert.equal(error.message.includes('HTTP 403'), true)
    assert.equal(/网络不可达/.test(error.message), false)
  } finally {
    await repo.dispose()
  }
})

test('D3 顺序守卫：同一段 stderr 同时命中「传输证据」与 403 时，状态码胜出（旧误报的成因）', async () => {
  const mixed =
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 403"
  // 旧误报的成因（b11b P2-4 已根治）：`unable to access` 是 curl 给所有 HTTPS 失败打的**包装前缀**，
  // 它本身不是证据。本处由 `true` retarget 成 `false`（**收紧**）：旧断言钉的是 bug 的成因，
  // 新断言钉的是「这个前缀已被逐出证据集」；紧接着的正向控制组保证证据集没被掏空。
  assert.equal(hasTransportEvidence(mixed), false, '`unable to access` 不再是传输层证据')
  const hardControl = "fatal: unable to access 'x': Could not resolve host: gitee.com"
  assert.equal(hasTransportEvidence(hardControl), true, '正向控制组：硬证据仍在证据集里')
  // 证据集的分裂是结构性的：包装前缀被单独列出，且**不在**硬证据表里。
  assert.deepEqual(TRANSPORT_DROPPED_WRAPPER_PATTERNS, ['unable to access'])
  assert.equal(
    TRANSPORT_HARD_EVIDENCE_PATTERNS.some((pattern) => pattern.includes('unable to access')),
    false, '硬证据表里不许出现包装前缀',
  )
  assert.equal(httpStatusFailureOf(mixed).reason, 'auth-rejected')
  const repo = repoWithStderr(mixed)
  try {
    const error = await captureRejection(() => repo.lsRemote())
    assert.equal(error.details.reason, 'auth-rejected', '状态码必须先于传输层文本成立')
    assert.equal(error.details.status, 403)
    assert.equal(/网络不可达/.test(error.message), false)
  } finally {
    await repo.dispose()
  }
})

/* -------------------------------------------------------------------------- */
/* E. `reachable` 归因（b11b P2-3）：哪些失败才配宣称「不可达」                  */
/* -------------------------------------------------------------------------- */

test('E1 reachable 归因：只有链路不通 / 凭据类失败才写 reachable:false，5xx 与 429 不许', () => {
  const typed = (code, details) => new SyncError(code, 'x', details)

  // 1）引擎真实会产出的形状（见 D1 / D2 / A3 / A4 的 typed 详情）。
  const engineShapes = [
    // 网络命令 + 传输层证据：链路确实不通 ⇒ 允许写 reachable:false
    { code: 'E_GIT', details: { reason: 'unreachable', network: true }, expected: true },
    // 超时（预算杀死子进程）：允许（既有行为）
    { code: 'E_GIT', details: { reason: 'timeout', network: true }, expected: true },
    // 凭据类：允许（既有行为，E_AUTH 一律算网络失败 —— 本轮不变）
    { code: 'E_AUTH', details: { reason: 'auth-prompt', network: true }, expected: true },
    { code: 'E_AUTH', details: { reason: 'auth-rejected', status: 403, network: true }, expected: true },
    // 代理要凭据：链路是通的（代理答了 407）——但这条仍沿用既有 E_GIT+network 的判定
    { code: 'E_GIT', details: { reason: 'proxy-auth', status: 407, network: true }, expected: true },
    // 5xx / 429 / 404：远端**回了话**，不许说成连不上（b11b P2-3 + P2-1）
    { code: 'E_GIT', details: { reason: 'remote-error', status: 502, network: true }, expected: false },
    { code: 'E_GIT', details: { reason: 'rate-limited', status: 429, network: true }, expected: false },
    { code: 'E_GIT', details: { reason: 'not-found', status: 404, network: true }, expected: false },
    // 本地错误（git 不在 PATH）：从来不是网络失败
    { code: 'E_GIT', details: { reason: 'git-missing' }, expected: false },
    // 无 details 的 E_GIT：没有正面证据就不许宣称不可达
    { code: 'E_GIT', details: undefined, expected: false },
    // 非 SyncError：不归因
    { code: null, details: null, expected: false },
  ]
  for (const { code, details, expected } of engineShapes) {
    const error = code === null ? new Error('boom') : typed(code, details)
    assert.equal(isNetworkFailure(error), expected, `${String(code)} ${JSON.stringify(details)}`)
  }

  // 2）**顺序守卫**：这两条若把 `network: true` 放在前面判，就会写 reachable:false ——
  //    正是评审 P2-3 指出的「状态文件说连不上、正文说服务端/代理出错」的自相矛盾。
  const remoteError = typed('E_GIT', { reason: 'remote-error', status: 502, network: true })
  assert.equal(remoteError.details.network, true, '前提：引擎确实给 5xx 打了 network 标记')
  assert.equal(isNetworkFailure(remoteError), false, '但 5xx 不等于不可达')

  // 3）文案与归因必须一致：5xx 的原因句同时点名「远端或代理」，而不是只说仓库服务端。
  assert.equal(HTTP_STATUS_CAUSE_ZH['remote-error'].includes('代理'), true)
  assert.equal(NEW_REASONS['remote-error'].pushPhrase.includes('代理'), true)
  assert.equal(PUSH_REMOTE_ERROR_NEXT_STEP.includes('代理'), true)
  // 429 的措辞仍是限流专属（不许被 5xx 的"代理"口径带跑）。
  assert.equal(NEW_REASONS['rate-limited'].pushPhrase.includes('限流'), true)
  assert.equal(PUSH_RATE_LIMITED_NEXT_STEP.includes('代理'), false)

  // 4）404（b11b P2-1）：远端回了话 ⇒ 不许写 reachable:false。顺序守卫同上。
  const notFound = typed('E_GIT', { reason: 'not-found', status: 404, network: true })
  assert.equal(notFound.details.network, true, '前提：网络命令失败时引擎会带 network 标记')
  assert.equal(isNetworkFailure(notFound), false, '但 404 不等于不可达')
})

/* -------------------------------------------------------------------------- */
/* G. 证据优先级与未映射码（b11b P2-4 / P2-1 的收口：正面证明 + 反向控制）          */
/* -------------------------------------------------------------------------- */

test('G1 硬传输证据优先于状态码：`remote:` 回显 403 + DNS 失败 ⇒ unreachable（且没有 status）', async () => {
  // 评审 b11b P2-4 的原串（一字不改），旧实现的答案：auth-rejected + status=403（真因是 DNS）。
  const witness = 'remote: build log: see HTTP 403 section; Could not resolve host'
  assert.equal(httpStatusCodesOf(witness).length, 0, '回显行上的 403 不是 git 的状态码')
  assert.equal(httpStatusFailureOf(witness), null)
  assert.equal(hasTransportEvidence(witness), true, '硬证据成立')
  const port = portWithRunner(failRunner(witness))
  try {
    const error = await captureRejection(() => port.pushMain(PUSH_ARGS))
    assert.equal(error.code, V2_ERROR.PUSH_REJECTED)
    assert.equal(error.details.reason, 'unreachable', '真因是 DNS，不是凭据')
    assert.equal(error.details.status, undefined, '不可达不许挂状态码')
    assert.equal(error.message, '推送失败：网络不可达（无法解析或连接到远端）')
    assert.equal(/令牌|凭据|401\/403/.test(error.message), false, '不许把网络问题说成凭据问题')
  } finally {
    await port.dispose()
  }

  // 同一件事在**更完整的真实形态**里也成立：curl 的 fatal 行 + 钩子日志两行同时出现。
  const mixed = [
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': Could not resolve host: gitee.com",
    'remote: build log: see HTTP 403 section',
  ].join('\n')
  const mixedPort = portWithRunner(failRunner(mixed))
  try {
    const error = await captureRejection(() => mixedPort.pushMain(PUSH_ARGS))
    assert.equal(error.details.reason, 'unreachable', '硬证据赢过同段文本里的 403')
    assert.equal(error.details.status, undefined)
  } finally {
    await mixedPort.dispose()
  }

  // 引擎侧（ls-remote / v1 push 走同一条 `failure()`）：同一份裁决，码为 E_GIT。
  const repo = repoWithStderr(mixed)
  try {
    const error = await captureRejection(() => repo.lsRemote())
    assert.equal(error.code, 'E_GIT')
    assert.equal(error.details.reason, 'unreachable')
    assert.equal(error.details.status, undefined)
    assert.equal(/网络不可达/.test(error.message), true)
  } finally {
    await repo.dispose()
  }

  // **同伴用例**：同样涉及 403、但**没有** DNS 证据 ⇒ 必须仍是 auth-rejected（Gitee 不回归）。
  for (const stderr of [
    "fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 403",
    'error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403',
  ]) {
    const companion = portWithRunner(failRunner(stderr))
    try {
      const error = await captureRejection(() => companion.pushMain(PUSH_ARGS))
      assert.equal(error.details.reason, 'auth-rejected', stderr)
      assert.equal(error.details.status, 403, stderr)
      assert.equal(error.message, NEW_REASONS['auth-rejected'].pushPhrase, stderr)
    } finally {
      await companion.dispose()
    }
  }
})

test('G2 未映射码：404 ⇒ not-found（可操作文案 + status），3xx/400/405/422 ⇒ git-failed 且绝非 unreachable', async () => {
  // ① 404：自己的原因 + 自己的文案 + 自己的下一步 + 数字。
  const notFound = await pushWith("fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 404")
  assert.equal(notFound.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(notFound.details.reason, 'not-found')
  assert.equal(notFound.details.status, 404)
  assert.equal(notFound.message, '推送失败：远端返回 404，仓库不存在或当前凭据看不到它')
  assert.equal(/网络不可达|不可达/.test(notFound.message), false, '404 不许说成网络不可达')
  assert.equal(/令牌过期|401\/403/.test(notFound.message), false, '404 不等于凭据被拒')
  assert.deepEqual(Object.keys(notFound.details).sort(), ['reason', 'status'], 'details 只带原因与数字')

  // cycle 端到端：not-found 的短语过白名单、下一步是「核对地址 / 私有库授权」。
  const cycled = await cycleWithPushError(notFound)
  assert.equal(cycled.result.message.includes(notFound.message), true)
  assert.equal(cycled.result.message.includes(PUSH_NOT_FOUND_NEXT_STEP), true)
  assert.equal(cycled.result.message.includes('原因类别未识别'), false)
  assert.equal(cycled.outbox.entries[0].state, 'pending', '失败只停放，不报成功')

  // ② 其它未映射码：落 git-failed（文案不怪网络），不冒充不可达，也不编 status。
  const unmapped = [
    ["fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 302", 302],
    ['error: RPC failed; HTTP 400 Bad Request', 400],
    ['error: 405 Method Not Allowed while accessing https://gitee.com/acme/repo.git/info/refs', 405],
    ['fatal: unable to access remote: HTTP 422 Unprocessable Entity', 422],
  ]
  for (const [stderr, status] of unmapped) {
    assert.equal(httpStatusFailureOf(stderr), null, `分类器不发明原因：${stderr}`)
    assert.deepEqual(httpStatusCodesOf(stderr), [status], `但码被认出来了：${stderr}`)
    const error = await pushWith(stderr)
    assert.equal(error.details.reason, 'git-failed', stderr)
    assert.equal(error.details.status, undefined, `未映射码不挂 status：${stderr}`)
    assert.equal(error.message, '推送失败：git 拒绝了本次推送，请检查远端状态后重试', stderr)
    assert.equal(/网络不可达|不可达/.test(error.message), false, `未映射码不许说成网络不可达：${stderr}`)
    assert.equal(/远端拒绝了这个用户名|限流|代理要求/.test(error.message), false, stderr)
  }

  // ③ 反向控制组：没有状态码的硬证据仍然是 unreachable（本批没有把证据集掏空）。
  const dns = await pushWith("fatal: unable to access 'https://gitee.com/acme/repo.git/': Could not resolve host: gitee.com")
  assert.equal(dns.details.reason, 'unreachable')
  assert.equal(dns.details.status, undefined)

  // ④ 引擎侧：ls-remote 对 404 / 302 给出同一份裁决；未映射码的 `network` 一律 false。
  const repo404 = repoWithStderr("fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 404")
  try {
    const error = await captureRejection(() => repo404.lsRemote())
    assert.equal(error.code, 'E_GIT')
    assert.equal(error.details.reason, 'not-found')
    assert.equal(error.details.status, 404)
    assert.equal(error.message.includes(HTTP_STATUS_CAUSE_ZH['not-found']), true)
    assert.equal(error.message.includes(GIT_NOT_FOUND_NEXT_STEP), true)
    assert.equal(/网络不可达/.test(error.message), false)
    assert.equal(isNetworkFailure(error), false, '404 不许把 reachable 写成 false')
  } finally {
    await repo404.dispose()
  }
  const repo302 = repoWithStderr("fatal: unable to access 'https://gitee.com/acme/repo.git/': The requested URL returned error: 302")
  try {
    const error = await captureRejection(() => repo302.lsRemote())
    assert.equal(error.details.reason, 'git-failed')
    assert.equal(error.details.network, false, '认出了状态码却没映射：不许给「网络类失败」盖章')
    assert.equal(isNetworkFailure(error), false)
    assert.equal(/网络不可达/.test(error.message), false)
  } finally {
    await repo302.dispose()
  }
})
