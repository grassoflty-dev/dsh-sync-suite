/**
 * mod-plugin-dispose-hygiene-residuals / item 2：askpass 兜底的两条边角（评审 §2.3）。
 *
 * 两条都**只在"拿不到提示文本"的兜底路径**上才有可观察后果（生产形状 `%*` 总带提示，
 * 走的是"按提示作答"那条唯一正确路径）。但兜底一旦被别的调用器点亮，它们就是真的：
 *
 *   E-1 同父进程（同一调用器连续 spawn 生成物）时，第 3 次无提示问询会答 token ——
 *       因为 `sameParent` 绕过了「一次调用最多问两项」的安全门，于是 token 被答给
 *       **用户名问句**（Gitee 回 "The token username invalid" 403，正是本模块要消灭的答案）。
 *       修法：`pending` 对 sameParent 同样生效 ⇒ 同父兜底最多答两项，第 3 次从用户名重来。
 *
 *   E-2 `Password for 'https://…sername…@host'` 先命中 `/sername/`，把**口令问句**答成用户名。
 *       修法：先按**锚定问句词**判（`Password for …` / `Username for …`），再落回子串规则；
 *       锚定判据对"主机名里含关键字"天然免疫，也不会把 `/assword/` 提到 `/sername/` 前面
 *       （那会反过来把用户名问句答成 token）。
 *
 * 纪律：只用生成物 + 假 token/假用户名，不联网、不推送、不读真实凭据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { writeAskpassFiles } from '../dist/engine/git.js'

const exec = promisify(execFile)

/** 明显假的固定串；只经子进程 env 传递，不写进任何文件、不打印。 */
const TOKEN = 'gitee_FAKE_TOKEN_fallback_edges_4c1d'
const USER = 'fallback-fixture-user'
const USER_PROMPT = "Username for 'https://gitee.com': "
const PASS_PROMPT = `Password for 'https://${USER}@gitee.com': `

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'askpass-fallback-'))
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined))
  const files = await writeAskpassFiles(dir)
  const env = {
    ...process.env,
    DSH_GIT_SYNC_TOKEN: TOKEN,
    DSH_GIT_SYNC_USER: USER,
    DSH_GIT_SYNC_NODE: process.execPath,
    DSH_GIT_SYNC_ASKPASS_COUNTER: files.counter,
  }
  /** 无提示问询 = 历史缺陷的形状（`%*` 没转发时 node 拿到的就是空 argv）。 */
  const ask = async (args = []) => {
    const result = await exec(process.execPath, [files.js, ...args], { cwd: dir, env })
    return result.stdout.replace(/\r?\n$/, '')
  }
  return { dir, files, ask }
}

/* ------------------------------------------------------------------ E-1 同父上限 */

test('E-1 同父进程连续三次无提示问询：用户名 → token → **用户名**（同父兜底最多两项）', async (t) => {
  const { files, ask } = await fixture(t)
  await rm(files.counter, { force: true })

  assert.equal(await ask(), USER, '第 1 次问询必须是用户名')
  assert.equal(await ask(), TOKEN, '第 2 次问询才是 token')
  // 第 3 次：一次 git 调用最多问两项，问满就该重来。修前这里答 token（用户名问句拿到 token）。
  assert.equal(await ask(), USER, '第 3 次无提示问询必须从用户名重新开始，绝不沿用 token')

  const state = JSON.parse(await readFile(files.counter, 'utf8'))
  assert.equal(state.count, 1, '重来之后的计数必须是 1（不是继续累加）')
})

/* ------------------------------------------------------------------ E-2 提示分类 */

test('E-2 锚定问句词：主机名里含 sername 的口令问句必须答 token（修前答成用户名）', async (t) => {
  const { ask } = await fixture(t)
  // 提示文本里只有 "Password for …" 是问句词；"sername" 出现在**主机名**里。
  assert.equal(
    await ask(["Password for 'https://my-sername-login@gitee.com': "]),
    TOKEN,
    '口令问句不许因为主机名含 sername 就答用户名',
  )
  // 评审 2c/2e 的同族形状：主机名含 username 的口令问句。
  assert.equal(
    await ask(["Password for 'https://username-host@gitee.com': "]),
    TOKEN,
    '口令问句不许因为主机名含 username 就答用户名',
  )
})

test('E-2 反向：主机名里含 assword/username 的**用户名**问句仍答用户名（不许把判序反过来）', async (t) => {
  const { ask } = await fixture(t)
  assert.equal(
    await ask(["Username for 'https://assword-host@gitee.com': "]),
    USER,
    '用户名问句不许因为主机名含 assword 就答 token',
  )
  assert.equal(
    await ask(["Username for 'https://gitee.com/username-org': "]),
    USER,
    '用户名问句不许因为路径含 username 就答 token',
  )
  // 标准形状照旧（两条唯一正确路径）。
  assert.equal(await ask([USER_PROMPT]), USER)
  assert.equal(await ask([PASS_PROMPT]), TOKEN)
})

test('E-2 中英混排/前缀装饰：问句词在行首（git 的真实形状）才按锚定判，别的位置仍走子串兜底', async (t) => {
  const { ask } = await fixture(t)
  // git 的真实口令提示带用户名与 @；这里保证锚定判据对真实形状同样成立。
  assert.equal(await ask([`Password for 'https://${USER}@gitee.com': `]), TOKEN)
  // 非标准形状（问句词不在行首）不要过度解读：仍按既有子串规则（sername 优先）。
  assert.equal(
    await ask([`Authentication required. Username for 'https://gitee.com': `]),
    USER,
    '非锚定的用户名问句仍靠子串规则答用户名',
  )
})
