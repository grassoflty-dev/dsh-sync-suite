/**
 * askpass **兜底计数按调用重置**的行为见证（mod-plugin-dispose-race 的 item 2 / 评审 §8 第一行）。
 *
 * 背景：评审证明过一件难堪的事——把 `GitRepo.buildEnv()` 里那行 `await this.resetAskpassCounter()`
 * 删掉，整套 1045 例仍然全绿。也就是说"凭据修好了"这件事**没有回归保护**：计数文件的复位是
 * 拐杖，而测试只扶着墙。本文件补的是**行为**，不是"有没有调那个函数"：
 *
 *   命令 1（一次 git 调用）：两次**拿不到提示文本**的问询 → 先用户名、后 token（配对正确）；
 *   命令 2（下一次 git 调用）：第一次问询必须**重新从用户名开始**。
 *
 * 为什么这里用"无提示"的问询：`askpass.mjs` 里**可判的提示文本会先 `emit()` 直接退出**，
 * 计数逻辑根本不会执行。因此"按调用重置"只在**提示不可判**这条路径上才有可观察后果 ——
 * 那正是历史缺陷的形状（`.cmd` 没转发 `%*` 时 node 拿不到提示，于是跨调用沿用 token，
 * Gitee 收到 `username=<token>` 判 403）。真实 cmd 形状另有 C-3 专测（提示经 `%*` 到达 node）。
 *
 * 纪律：token 是明显假的固定串，只经子进程 env 传递；不联网、不推送、不碰真实 `%TEMP%` 之外
 * 的任何东西（askpass 目录由 `GitRepo` 自己 `mkdtemp` 并在 `dispose()` 里删掉）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { GitRepo } from '../dist/engine/git.js'

const exec = promisify(execFile)

/** 明显假的令牌与登录名；只经 env 传给被测进程，绝不写进任何文件（也不打印）。 */
const FAKE_TOKEN = 'gitee_FAKE_TOKEN_counter_reset_9f3a'
const FAKE_USER = 'ding_haoran'
const REPO_URL = 'https://gitee.com/ding_haoran/dsh-dots-test.git'
const USER_PROMPT = "Username for 'https://gitee.com': "
const PASS_PROMPT = `Password for 'https://${FAKE_USER}@gitee.com': `

/**
 * 造一个**真实**的 `GitRepo`（鉴权 env 走生产那条路：`buildEnv()` → `gitAuthEnv()`，
 * 其中 askpass 文件是 `writeAskpassFiles()` 现场生成的）。
 *
 * `nodePath.env` 注入只为让解释器解析确定落在当前 node 上（生产靠 PATH/覆盖变量解析）；
 * 这不改变被测语义——env 的其余部分与生产逐字同一份。
 */
async function makeRepo(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'askpass-counter-reset-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  const repo = new GitRepo({
    dir,
    repoUrl: REPO_URL,
    branch: 'main',
    authMode: 'https',
    platform: 'gitee',
    username: FAKE_USER,
    token: FAKE_TOKEN,
    nodePath: { env: { ...process.env, DSH_GIT_SYNC_NODE: process.execPath } },
  })
  t.after(() => repo.dispose())
  return { dir, repo }
}

/** 从**真实 env** 反推出生成物路径：绝不 import 私有字段，也绝不自己拼一份平行路径。 */
function askpassOf(env) {
  assert.equal(typeof env.GIT_ASKPASS, 'string', 'buildEnv() 必须给出 GIT_ASKPASS（否则本用例无从见证）')
  const dir = path.dirname(env.GIT_ASKPASS)
  const counter = env.DSH_GIT_SYNC_ASKPASS_COUNTER
  assert.equal(typeof counter, 'string', 'buildEnv() 必须注入计数文件路径')
  return { dir, js: path.join(dir, 'askpass.mjs'), cmd: env.GIT_ASKPASS, counter }
}

/** 跑一次生成物（node 直跑 .mjs）：`args` 为空 = **拿不到提示文本**（历史缺陷的形状）。 */
async function ask(js, args, env, cwd) {
  const result = await exec(process.execPath, [js, ...args], { cwd, env })
  return result.stdout.replace(/\r?\n$/, '')
}

/* -------------------------------------------------------------------------- */
/* C-1 两命令见证：命令 1 的两次问询配对，命令 2 重新从用户名开始                */
/* -------------------------------------------------------------------------- */

test('C-1 两命令见证：命令 1 = 用户名→token；命令 2 的第一次问询仍答用户名（真实 buildEnv 两次）', async (t) => {
  const { dir, repo } = await makeRepo(t)

  // ---- 命令 1：一次 git 调用，两次拿不到提示的问询（先用户名、后口令）。
  const env1 = await repo.buildEnv()
  const one = askpassOf(env1)
  assert.equal(await ask(one.js, [], env1, dir), FAKE_USER, '一次调用的第一次问询必须是用户名')
  assert.equal(await ask(one.js, [], env1, dir), FAKE_TOKEN, '同一次调用的第二次问询才是 token')
  // 计数文件确实存在（否则"两次配对"是靠别的机制蒙对的，本见证会失去意义）。
  const files = await readdir(one.dir)
  assert.ok(files.includes('askpass.count'), `一次调用问满两项后应留下计数文件，实际：${files.join(',')}`)

  // ---- 命令 2：下一次 git 调用。生产里每次命令都从 buildEnv() 取 env。
  const env2 = await repo.buildEnv()
  const two = askpassOf(env2)
  assert.equal(two.counter, one.counter, '两次命令必须共用同一个计数文件（否则本条什么也没证明）')
  assert.equal(two.js, one.js, '生成物路径不许漂移：重置的是同一个文件的计数')

  const firstAskOfCommand2 = await ask(two.js, [], env2, dir)
  assert.notEqual(firstAskOfCommand2, FAKE_TOKEN, '命令 2 的第一次问询**绝不能**拿到 token（那正是 403 的成因）')
  assert.equal(firstAskOfCommand2, FAKE_USER, '命令 2 的第一次问询必须重新从用户名开始')
})

/* -------------------------------------------------------------------------- */
/* C-2 负向对照：故意不复位（脏计数）⇒ 命令 2 拿到 token（这就是修前答案）       */
/* -------------------------------------------------------------------------- */

test('C-2 负向对照：不复位计数（脏计数夹具）⇒ 命令 2 的第一次问询答成 token，复位后答用户名', async (t) => {
  const { dir, repo } = await makeRepo(t)
  const env1 = await repo.buildEnv()
  const one = askpassOf(env1)
  assert.equal(await ask(one.js, [], env1, dir), FAKE_USER)
  assert.equal(await ask(one.js, [], env1, dir), FAKE_TOKEN)

  // retarget（mod-plugin-dispose-hygiene-residuals item 2）：兜底现在**无论父进程是否相同**都
  // 最多答两项 —— 问满两项后（count=2）第三次会自动从用户名重来，所以「问满两项后不复位」
  // 不再是脏状态（那正是修好的安全门）。复位真正兜住的是**只问了一项就结束**的调用
  // （git 失败/中途退出）：那个遗留的 count=1 会让下一条命令的第一次问询直接答 token。
  // 这里把计数写回 1 来构造这个脏状态（等价于一次只问了一项的调用），断言强度不变。
  await writeFile(one.counter, JSON.stringify({ ppid: process.pid, at: Date.now(), count: 1 }))
  const dirty = await ask(one.js, [], env1, dir)
  assert.equal(dirty, FAKE_TOKEN, '脏计数下命令 2 的第一次问询会答成 token —— 修前就是这个答案')
  assert.notEqual(dirty, FAKE_USER, '这必须是个错误答案，否则本对照为空')

  // 同一次运行里把"命令 2"正经走一遍 buildEnv()：答案立刻回到用户名。
  const env2 = await repo.buildEnv()
  const two = askpassOf(env2)
  const clean = await ask(two.js, [], env2, dir)
  assert.equal(clean, FAKE_USER, '重置之后命令 2 必须从用户名开始')
  assert.notEqual(clean, dirty, '复位前后必须是两个不同的答案（本对照的全部意义）')
})

/* -------------------------------------------------------------------------- */
/* C-3 真实 cmd 形状（Windows）：提示经 %* 到达 node，不靠计数兜底               */
/* -------------------------------------------------------------------------- */

test('C-3 真实 cmd 形状（仅 Windows）：提示经 %* 到达 node，两次命令都按提示作答且 stderr 为空', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('cmd.exe 只在 Windows 上存在；这条钉的是 %* 转发形状，POSIX 用 askpass.sh，不适用')
    return
  }
  const { dir, repo } = await makeRepo(t)
  const env1 = await repo.buildEnv()
  const one = askpassOf(env1)
  const runCmd = async (prompt, env) => {
    const result = await exec('cmd.exe', ['/d', '/c', one.cmd, prompt], { cwd: dir, env, windowsHide: true })
    return { answer: result.stdout.replace(/\r?\n$/, ''), stderr: result.stderr }
  }
  const username = await runCmd(USER_PROMPT, env1)
  assert.equal(username.answer, FAKE_USER)
  assert.equal(username.stderr, '', '注释行不得被当成命令执行（stderr 必须为空）')
  const password = await runCmd(PASS_PROMPT, env1)
  assert.equal(password.answer, FAKE_TOKEN)
  assert.equal(password.stderr, '')

  // 命令 2：同一套生成物、新的一份 env；提示可见时答案与计数无关，这里钉的是"形状没退化"。
  const env2 = await repo.buildEnv()
  const again = await runCmd(USER_PROMPT, env2)
  assert.equal(again.answer, FAKE_USER)
  assert.equal(again.stderr, '')
})

/* -------------------------------------------------------------------------- */
/* C-4 提示可见形状的两命令见证（跨平台，`.mjs` + 提示作为 argv）                */
/* -------------------------------------------------------------------------- */

/**
 * 这条是"按提示作答"那条路径的**两命令**见证（跨平台）：命令 1 一次用户名问询 + 一次口令问询，
 * 命令 2 再问一次用户名。
 *
 * 诚实说明：**这条在"删掉 reset"的变异下仍然是绿的** —— 提示可判时 `askpass.mjs` 在计数逻辑
 * 之前就 `emit()` 退出了，计数根本不参与。因此它证明的是"提示转发这条正确路径两次命令都对"，
 * 而**不是**计数复位；能证明复位的是 C-1（并在 C-2 里给出反证）。两条都要，缺一条就会留下
 * "修好了但没人守"或"守着一个不说明问题的断言"。
 */
test('C-4 提示可见的两命令见证（跨平台）：命令 1 用户名+口令、命令 2 的用户名问句都按提示作答', async (t) => {
  const { dir, repo } = await makeRepo(t)
  const env1 = await repo.buildEnv()
  const one = askpassOf(env1)
  assert.equal(await ask(one.js, [USER_PROMPT], env1, dir), FAKE_USER, '用户名问句必须答用户名')
  assert.equal(await ask(one.js, [PASS_PROMPT], env1, dir), FAKE_TOKEN, '口令问句必须答 token')

  const env2 = await repo.buildEnv()
  const two = askpassOf(env2)
  assert.equal(two.counter, one.counter)
  assert.equal(await ask(two.js, [USER_PROMPT], env2, dir), FAKE_USER, '命令 2 的用户名问句仍答用户名')
  assert.equal(await ask(two.js, [PASS_PROMPT], env2, dir), FAKE_TOKEN, '命令 2 的口令问句仍答 token')
})
