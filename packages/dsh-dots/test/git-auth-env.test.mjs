/**
 * mod-plugin-git-auth-env：git 网络命令鉴权环境的回归测试。
 *
 * 根因：v2 的 pushMain 走 gitPort.ts 的独立 execFile，没有注入 GitRepo 的鉴权环境；
 * clone / fetch 走 GitRepo.run() 有 env，所以「clone 成功、push 被 tty 提示卡住」。
 *
 * 本文件用**真实 execFile 路径** + 假 git（复制 node 可执行文件 + NODE_OPTIONS 预加载脚本）
 * 钉住四件事：
 *   1. push 的 env 含 GIT_ASKPASS / 用户名 / GIT_TERMINAL_PROMPT=0；
 *   2. 缺 askpass 时 typed E_PUSH_REJECTED，消息不含 tty 对话框文案与 token；
 *   3. clone / fetch / push 收到逐字节相同的 env（对完整 env 取哈希比较，绝不打印 token）；
 *   4. 源码形态：GIT_ASKPASS / GIT_TERMINAL_PROMPT 字面量只有一个模块持有。
 * 另有一例证明停放的 outbox 意图在真实命令路径上被重试推送并出队。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as engine from '../dist/engine/git.js'
import { SyncError } from '../dist/engine/errors.js'
import { GitRepoV2Port } from '../dist/sync/gitPort.js'
import { PUSH_ARGS, V2_ERROR, makeIntentId, runV2Cycle, v2TrailerLine } from '../dist/sync/cycle.js'
import { FRESH_SCHEMA_TEXT } from '../dist/timeline/index.js'
import { readFileSync } from 'node:fs'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'fake-private-token-9f3a7c2e'
const USER = 'ding_haoran'
const REPO_URL = 'https://gitee.com/ding_haoran/dsh-dots-test.git'
const SHA1 = '1111111111111111111111111111111111111111'
const SHA2 = '2222222222222222222222222222222222222222'
const DAY = '2026-11-22'
const TS = `${DAY}T09:30:00+08:00`
// 引擎写入 records.json 时会把 ts 规范化成 ISO；意图也用同一规范值，避免恢复校验误判冲突。
const TS_ISO = '2026-11-22T01:30:00.000Z'

/**
 * 假 git 预加载脚本（CommonJS）。Windows 上 execFile('git') 只按 PATH 找 .exe，所以
 * 把 node 可执行文件硬链接成 git.exe，再用 NODE_OPTIONS=--require 让本脚本先跑并退出。
 * 只记录「安全 env 字段 + 完整 env 的 sha256」，token 明文永不落盘、永不打印。
 */
const FAKE_GIT_PRELOAD_CJS = `
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const raw = process.argv.slice(1)
const argv = raw.map((a) => path.basename(a))
const SUBS = ['clone','fetch','push','rev-parse','rev-list','show','log','diff-tree',
  'symbolic-ref','status','diff','add','commit','ls-remote','config','reset','checkout','remote','rebase','clean']
const sub = SUBS.find((s) => argv.includes(s)) || ''
let control = {}
try { control = JSON.parse(fs.readFileSync(process.env.FAKE_GIT_CONTROL, 'utf8')) } catch {}

const askpass = process.env.GIT_ASKPASS || ''
const safe = {
  GIT_ASKPASS: askpass === '' ? null : askpass,
  DSH_GIT_SYNC_USER: process.env.DSH_GIT_SYNC_USER ?? null,
  GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? null,
  askpassExists: askpass === '' ? false : fs.existsSync(askpass),
}
const envHash = crypto.createHash('sha256')
  .update(JSON.stringify(Object.entries(process.env).sort()))
  .digest('hex')
fs.appendFileSync(process.env.FAKE_GIT_LOG,
  JSON.stringify({ sub, argv, cwd: process.cwd(), safe, envHash }) + '\\n')

const out = (text) => { process.stdout.write(text || ''); process.exit(0) }
const die = (text) => { process.stderr.write(text || ''); process.exit(1) }

if (sub === 'clone') {
  fs.mkdirSync(path.join(raw[raw.length - 1], '.git'), { recursive: true })
  out('')
}
if (sub === 'fetch' && control.fetchFail) die('fatal: unable to access remote')
if (sub === 'push' && control.pushFailAt > 0) {
  control.pushFailAt -= 1
  fs.writeFileSync(process.env.FAKE_GIT_CONTROL, JSON.stringify(control))
  die(control.pushError || 'fatal: push rejected')
}
if (sub === 'rev-parse') {
  if (argv.includes('--abbrev-ref')) out((control.branch || 'main') + '\\n')
  if (raw.some((a) => a.includes('origin/main'))) out((control.originSha || SHA1_PLACEHOLDER) + '\\n')
  out((control.headSha || SHA1_PLACEHOLDER) + '\\n')
}
if (sub === 'rev-list') out((control.aheadBehind || '0 0') + '\\n')
if (sub === 'log') out((control.logLines || []).join('\\n') + '\\n')
if (sub === 'show') {
  if (argv.includes('--format=%B')) out((control.commitBody || '') + '\\n')
  // Windows 下 argv[1] 是被 node 当作主脚本的 .../show（含盘符冒号），要排除掉。
  const spec = raw.find((a) => a.includes(':') && !a.includes('\\\\')) || ''
  out((control.files && control.files[spec]) || '')
}
if (sub === 'diff-tree') out((control.diffPaths || []).join('\\n') + '\\n')
if (sub === 'diff') process.exit(control.stagedClean ? 0 : 1)
out('')
`.replaceAll('SHA1_PLACEHOLDER', SHA1)

async function makeHarness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'git-auth-env-'))
  const bin = path.join(root, 'bin')
  const controlFile = path.join(root, 'control.json')
  const logFile = path.join(root, 'invocations.ndjson')
  const preloadFile = path.join(root, 'fake-git-preload.cjs')
  const workDir = path.join(root, 'work')
  await mkdir(bin, { recursive: true })
  await mkdir(workDir, { recursive: true })
  await writeFile(controlFile, JSON.stringify({}), 'utf8')
  await writeFile(logFile, '', 'utf8')
  await writeFile(preloadFile, FAKE_GIT_PRELOAD_CJS, 'utf8')
  // 硬链接（失败退回复制）：同一分区上瞬时完成，避免每个用例复制 ~90MB 的 node.exe。
  const gitBin = path.join(bin, process.platform === 'win32' ? 'git.exe' : 'git')
  try {
    await link(process.execPath, gitBin)
  } catch {
    const { copyFile } = await import('node:fs/promises')
    await copyFile(process.execPath, gitBin)
  }
  if (process.platform !== 'win32') await chmod(gitBin, 0o755)

  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const originalPath = process.env[pathKey] ?? ''
  process.env[pathKey] = `${bin}${path.delimiter}${originalPath}`
  t.after(async () => {
    process.env[pathKey] = originalPath
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  const control = async (patch) => { await writeFile(controlFile, JSON.stringify(patch), 'utf8') }
  const invocations = async () => {
    const text = await readFile(logFile, 'utf8')
    return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
  }
  const options = (overrides = {}) => ({
    dir: workDir, repoUrl: REPO_URL, branch: 'main', authMode: 'https',
    platform: 'gitee', username: USER, token: TOKEN, allowLocalRepo: false,
    env: {
      FAKE_GIT_CONTROL: controlFile,
      FAKE_GIT_LOG: logFile,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preloadFile}`.trim(),
      [pathKey]: `${bin}${path.delimiter}${originalPath}`,
    },
    ...overrides,
  })
  return { root, bin, workDir, control, invocations, options }
}

function recordLine(overrides = {}) {
  return JSON.stringify({
    id: 'a1', ts: TS_ISO, title: 'token 门禁测试', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: TS_ISO, ...overrides,
  })
}

class MemFs {
  constructor(seed = {}) { this.files = new Map(Object.entries(seed)) }
  async read(rel) { return this.files.has(rel) ? this.files.get(rel) : null }
  async writeTemp(rel, text) { this.files.set(`${rel}.tmp`, text); return `${rel}.tmp` }
  async readTemp(tmp) { return this.files.get(tmp) ?? '' }
  async rename(tmp, rel) { this.files.set(rel, this.files.get(tmp)); this.files.delete(tmp) }
  async backupIfExists() { return false }
  async append(rel, text) { this.files.set(rel, (this.files.get(rel) ?? '') + text) }
  async exists(rel) { return this.files.has(rel) }
}

class MemOutbox {
  constructor(entries = []) { this.entries = entries.slice() }
  async load() { return this.entries.slice() }
  async save(entries) { this.entries = entries.slice() }
}

// ---------------------------------------------------------------- 用例

test('gitAuthEnv：单一构造点产出 askpass / 用户名 / GIT_TERMINAL_PROMPT=0，token 只在 env 不在 argv', () => {
  assert.equal(typeof engine.gitAuthEnv, 'function', 'dist/engine/git.js 必须导出 gitAuthEnv')
  const cfg = {
    authMode: 'https', repoUrl: REPO_URL, platform: 'gitee', username: USER, token: TOKEN,
    askpassPath: path.join(tmpdir(), 'fake-askpass.cmd'), askpassCounter: path.join(tmpdir(), 'ask.count'),
  }
  const env = engine.gitAuthEnv(cfg)
  assert.equal(env.GIT_ASKPASS, cfg.askpassPath)
  assert.equal(env.DSH_GIT_SYNC_USER, USER)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.DSH_GIT_SYNC_TOKEN, TOKEN)
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'never')
})

test('push 走真实 execFile 路径：env 含 GIT_ASKPASS、用户名、GIT_TERMINAL_PROMPT=0（今天失败）', async (t) => {
  const h = await makeHarness(t)
  const port = new GitRepoV2Port(h.options())
  await port.pushMain(PUSH_ARGS)
  const pushes = (await h.invocations()).filter((i) => i.sub === 'push')
  assert.equal(pushes.length, 1)
  assert.ok(pushes[0].safe.GIT_ASKPASS, 'push env 必须含 GIT_ASKPASS（今天为 null）')
  assert.ok(pushes[0].safe.askpassExists, 'GIT_ASKPASS 必须指向已生成的脚本')
  assert.equal(pushes[0].safe.DSH_GIT_SYNC_USER, USER)
  assert.equal(pushes[0].safe.GIT_TERMINAL_PROMPT, '0')
  await port.dispose()
})

test('push 缺 askpass 时 typed E_PUSH_REJECTED，消息不含 tty 对话框文案与 token（今天失败）', async (t) => {
  const h = await makeHarness(t)
  await h.control({
    pushFailAt: 1,
    pushError: [
      'fatal: User cancelled dialog.',
      'bash: line 1: /dev/tty: No such device or address',
      'error: failed to execute prompt script (exit code 1)',
      `fatal: could not read Username for '${REPO_URL}'`,
      `token ${TOKEN} leaked here`,
    ].join('\n'),
  })
  // 无 token → 不会生成/注入 askpass 脚本，正是线上「push 没有鉴权 env」的形态。
  const port = new GitRepoV2Port(h.options({ token: null }))
  await assert.rejects(
    () => port.pushMain(PUSH_ARGS),
    (error) => {
      assert.equal(error instanceof SyncError, true)
      assert.equal(error.code, V2_ERROR.PUSH_REJECTED, '必须是 typed E_PUSH_REJECTED（今天是 E_GIT）')
      assert.equal(/User cancelled dialog|\/dev\/tty|prompt script/.test(error.message), false,
        'typed 消息不得回显 tty 对话框文案')
      assert.equal(error.message.includes(TOKEN), false, 'typed 消息不得含 token')
      assert.equal(error.message.includes('askpass.mjs'), false, 'typed 消息不得含 askpass 正文')
      return true
    },
  )
  const pushes = (await h.invocations()).filter((i) => i.sub === 'push')
  assert.equal(pushes[0].safe.GIT_ASKPASS, null, '无 token 时不应有 askpass 脚本')
  assert.equal(pushes[0].safe.GIT_TERMINAL_PROMPT, '0', '禁用交互提示后 git 必须快速失败')
  await port.dispose()
})

test('clone / fetch / push 收到逐字节相同的 env（完整 env 哈希比对，今天失败）', async (t) => {
  const h = await makeHarness(t)
  const port = new GitRepoV2Port(h.options({ dir: path.join(h.root, 'fresh-clone') }))
  await port.prepare() // clone
  await port.fetchMain() // fetch
  await port.pushMain(PUSH_ARGS) // push
  const rows = await h.invocations()
  const clone = rows.find((i) => i.sub === 'clone')
  const fetch = rows.find((i) => i.sub === 'fetch')
  const push = rows.find((i) => i.sub === 'push')
  assert.ok(clone && fetch && push, '三条命令都必须真实执行')
  assert.equal(clone.envHash, fetch.envHash, 'clone 与 fetch env 必须逐字节一致')
  assert.equal(clone.envHash, push.envHash, 'clone 与 push env 必须逐字节一致（今天 push 没有鉴权 env）')
  assert.equal(push.safe.GIT_TERMINAL_PROMPT, '0')
  await port.dispose()
})

test('源码形态：GIT_ASKPASS / GIT_TERMINAL_PROMPT 字面量只有一个模块持有，gitPort 不自行拼 env', () => {
  const files = ['src/engine/git.ts', 'src/sync/gitPort.ts', 'src/sync/cycle.ts', 'src/sync/repoPath.ts']
  const texts = new Map(files.map((f) => [f, readFileSync(path.join(PKG_DIR, f), 'utf8')]))
  const owners = files.filter((f) => /['"`]GIT_ASKPASS['"`]|GIT_TERMINAL_PROMPT:\s*['"`]0['"`]/.test(texts.get(f)))
  assert.deepEqual(owners, ['src/engine/git.ts'], 'env 字面量只允许 engine/git.ts 持有')
  assert.equal(/export function gitAuthEnv\s*\(/.test(texts.get('src/engine/git.ts')), true,
    'owner 必须导出 gitAuthEnv')
  assert.equal(/buildEnv\(\)/.test(texts.get('src/sync/gitPort.ts')), true,
    'gitPort 必须从 GitRepo 取 env，不得自行构造')
  assert.equal(/\.\.\.process\.env/.test(texts.get('src/sync/gitPort.ts')), false,
    'gitPort 不得再展开 process.env 造第二份 env')
})

test('停放的 outbox 意图在真实命令路径上被重试推送并出队（今天失败）', async (t) => {
  const h = await makeHarness(t)
  const git = new GitRepoV2Port(h.options())
  const fs = new MemFs()
  const outbox = new MemOutbox()
  const intent = {
    intentId: makeIntentId(DAY, 'a1', TS_ISO, 'upsert'),
    op: 'upsert', date: DAY, id: 'a1', ts: TS_ISO, line: recordLine(),
    enqueuedAt: TS, attempts: 0, state: 'pending', lastError: '',
  }
  await outbox.save([intent])
  await h.control({ pushFailAt: 1, pushError: 'fatal: User cancelled dialog. /dev/tty' })

  const first = await runV2Cycle({ days: [DAY], git, fs, outbox, now: new Date(TS) })
  assert.equal(first.code, V2_ERROR.PUSH_REJECTED)
  assert.equal(outbox.entries.length, 1)
  assert.equal(outbox.entries[0].attempts, 1)
  assert.equal(outbox.entries[0].state, 'pending')
  assert.match(outbox.entries[0].lastError, /E_PUSH_REJECTED/)
  assert.equal(/User cancelled dialog|\/dev\/tty/.test(outbox.entries[0].lastError), false)
  assert.equal(outbox.entries[0].lastError.includes(TOKEN), false)

  // 模拟「本地已有我们自己的领先提交」：HEAD 前进、origin/main 未动、HEAD 树含刚写的文件。
  const recordsText = fs.files.get(`timeline/${DAY}/records.json`) ?? ''
  assert.notEqual(recordsText, '')
  await h.control({
    pushFailAt: 0,
    headSha: SHA2,
    originSha: SHA1,
    aheadBehind: '1 0',
    logLines: [SHA2],
    commitBody: `[v2] sync 1 days\n${v2TrailerLine()}\n`,
    diffPaths: [`timeline/${DAY}/records.json`],
    files: { [`HEAD:timeline/${DAY}/records.json`]: recordsText },
  })
  fs.files.set('timeline/schema.json', FRESH_SCHEMA_TEXT)

  const second = await runV2Cycle({ days: [DAY], git, fs, outbox, now: new Date(TS) })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(outbox.entries.length, 0, '停放的意图必须被出队')
  const pushes = (await h.invocations()).filter((i) => i.sub === 'push')
  assert.equal(pushes.length, 2, '两次周期各推一次，第二次走的是同一 env 构造路径')
  assert.equal(pushes[0].envHash, pushes[1].envHash)
  assert.equal(pushes[1].safe.GIT_TERMINAL_PROMPT, '0')
  await git.dispose()
})
