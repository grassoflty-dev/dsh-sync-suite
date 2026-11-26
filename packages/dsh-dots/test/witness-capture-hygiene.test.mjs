/**
 * mod-plugin-dispose-hygiene-residuals / item 3：witness capture 不得写出真实 Gitee 登录名。
 *
 * 背景（评审 §2.1 的 witness）：`gates-askpass-witness.out` 里的用户名是从**真实账号**抄来的，
 * 而这份 capture 是"贴给评审/issue 看"的产物——等于把真实登录名连同 askpass 行为一起发出去。
 * 令牌可以轮换，登录名不能，所以这条与 token hygiene 同级。
 *
 * 本文件钉两件事（都只在本地、离线可证）：
 *   1. **生成器**（`.tmp/witness-askpass-final.mjs`）只许用**合成**用户名，且不得从环境/系统
 *      身份里取名字（`process.env.USER` / `USERNAME` / `os.userInfo` / `git config user.name`）；
 *      任何位置出现真实登录名（按 SHA-256 比对，本文件不写明文）即失败。
 *   2. **capture 路径**：真跑一遍生成器（TMP 指向临时目录），它的 stdout 与 canonical capture
 *      （`.tmp/gates-askpass-witness.out`）都不许含真实登录名。
 *
 * 诚实边界：`.tmp` 里还有若干**历史** gate capture / 实验脚本（`gates-stderr-*`、`stderr-lab/**`），
 * 它们是评审当时的证据，本模块不改写历史文件；能保证的是"生成器再也不会写出真名"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const TMP = path.join(process.cwd(), '.tmp')
const GENERATOR = path.join(TMP, 'witness-askpass-final.mjs')
const CANONICAL_CAPTURE = path.join(TMP, 'gates-askpass-witness.out')

/** 真实 Gitee 登录名的 SHA-256（只存摘要：本文件本身也不得写出明文）。 */
const REAL_LOGIN_SHA256 = '60628e848958115c25fac47a3248d7395aaf9fcef7d99f9635ed513cdb285be1'

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * 读文本，兼容 PowerShell `Tee-Object` 产出的 UTF-16LE capture（本仓库的 `.tmp/*.out` 就是这种）。
 * 不兼容会把整份历史 capture 读成一串 NUL，于是"扫不到"被误当成"干净"——一个假绿。
 */
async function readText(file) {
  const buf = await readFile(file)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  const sample = buf.subarray(0, Math.min(200, buf.length))
  let nuls = 0
  for (const byte of sample) if (byte === 0) nuls += 1
  return nuls > sample.length / 4 ? buf.toString('utf16le') : buf.toString('utf8')
}

/** 从文本里取所有"像标识符"的片段，逐个比对摘要（大小写各算一次，避免大小写漏网）。 */
function containsRealLogin(text) {
  const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9._-]{2,}/g) ?? []
  for (const token of tokens) {
    if (sha256(token) === REAL_LOGIN_SHA256) return true
    if (sha256(token.toLowerCase()) === REAL_LOGIN_SHA256) return true
  }
  return false
}

test('WH-1 生成器只许用合成用户名，且不得从环境/系统身份取名字', async (t) => {
  if (!existsSync(GENERATOR)) {
    t.skip('.tmp/witness-askpass-final.mjs 不存在（本工作区之外的检出）：没有可扫的生成器')
    return
  }
  const source = await readText(GENERATOR)
  const userLine = source.match(/^const USER = '([^']*)'$/m)
  assert.ok(userLine, '生成器必须有一个显式的 USER 夹具常量（便于审查与替换）')
  // 用 test() 而不是 assert.match()：后者会把实际夹具值打进失败输出（那正是本模块要消灭的泄漏）。
  assert.equal(
    /^(witness|fixture|fake)[a-z0-9_-]*$/.test(userLine[1]),
    true,
    '用户名夹具必须是明显的合成名（witness-/fixture-/fake- 前缀）',
  )
  assert.equal(containsRealLogin(source), false, '生成器源码里不得出现真实 Gitee 登录名（按摘要比对）')
  // 不按环境/系统身份取名字：否则"换一台机器跑 capture"又会把真名带出来。
  assert.equal(
    /\bprocess\.env\.(USER|USERNAME|LOGNAME)\b|\bos\.userInfo\s*\(|\bos\.homedir\s*\(|\bgit\s+config\s+user\.name/.test(source),
    false,
    '生成器不得从环境/系统身份读取用户名',
  )
})

test('WH-2 真跑生成器（TMP 重定向到临时目录）：capture 输出里没有真实登录名', async (t) => {
  if (!existsSync(GENERATOR)) {
    t.skip('.tmp/witness-askpass-final.mjs 不存在（本工作区之外的检出）：没有可跑的生成器')
    return
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), 'witness-capture-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }).catch(() => undefined))
  const env = { ...process.env, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox }
  const { stdout } = await exec(process.execPath, [GENERATOR], {
    cwd: process.cwd(),
    env,
    maxBuffer: 4 * 1024 * 1024,
  })
  assert.ok(stdout.length > 0, '生成器必须有输出（否则这条什么也没证明）')
  assert.equal(containsRealLogin(stdout), false, 'capture stdout 不得含真实 Gitee 登录名')
  assert.match(stdout, /witness-user/, 'capture 必须使用合成用户名（说明跑的是修好之后的生成器）')
})

test('WH-3 canonical capture（.tmp/gates-askpass-witness.out）不得含真实登录名', async (t) => {
  if (!existsSync(CANONICAL_CAPTURE)) {
    t.skip('canonical capture 不存在：没有可扫的产物')
    return
  }
  const text = await readText(CANONICAL_CAPTURE)
  assert.equal(containsRealLogin(text), false, 'canonical witness capture 不得含真实 Gitee 登录名')
})
