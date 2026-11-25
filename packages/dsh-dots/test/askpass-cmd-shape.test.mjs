/**
 * mod-plugin-askpass-cmd-shape：Windows askpass 生成物的形状与「一次调用一次计数」语义。
 *
 * 现场（Lead 探针，本文件的负向对照把它固化下来）：
 *   1. `askpass.cmd` 最后一行没有把 `%*` 转发给 node，node 拿不到提示文本；
 *   2. 拿不到提示文本就落到一个**跨 git 进程存活**的全局计数上：第一次用户名、之后一律 token；
 *   3. 于是 fetch 之后再 push 时，git 的「用户名问句」被答成 token，Gitee 回
 *      “The token username invalid” → 403。这就是真实推送一直失败的根因；
 *   4. 同一批 `rem` 行里写着 `& | < > %`，cmd 先按 `&` 切分再执行 rem，尾巴被当成命令，
 *      每次调用都往 stderr 打一行「不是内部或外部命令」，污染失败分类的输入。
 *
 * 本文件只验证本地生成物，**不碰任何远端**、不推送、不联网；token 是明显假的固定串，
 * 永远只经环境变量传给被测进程，绝不写进任何文件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { writeAskpassFiles } from '../dist/engine/git.js'

const exec = promisify(execFile)

/** 明显假的令牌；从不写入任何文件，只经子进程 env 传递。 */
const FAKE_TOKEN = 'gitee_FAKE_TOKEN_0123456789'
const FAKE_USER = 'ding_haoran'
const USER_PROMPT = "Username for 'https://gitee.com': "
const PASS_PROMPT = `Password for 'https://${FAKE_USER}@gitee.com': `

/** cmd 的语法字符：出现在 rem 行里就会被当成命令分隔 / 重定向 / 变量展开。 */
const CMD_METACHARS = /[&|<>^%]/

async function makeAskpass(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'askpass-cmd-shape-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })
  const files = await writeAskpassFiles(dir)
  const env = {
    ...process.env,
    DSH_GIT_SYNC_TOKEN: FAKE_TOKEN,
    DSH_GIT_SYNC_USER: FAKE_USER,
    DSH_GIT_SYNC_NODE: process.execPath,
    DSH_GIT_SYNC_ASKPASS_COUNTER: files.counter,
  }
  return { dir, files, env }
}

/** 跑一次生成物（默认用当前宿主 node；cwd 固定为临时目录，避免受工作树影响）。 */
async function runNode(dir, js, args, env) {
  const result = await exec(process.execPath, [js, ...args], { cwd: dir, env })
  return { stdout: result.stdout.replace(/\r?\n$/, ''), stderr: result.stderr }
}

/* -------------------------------------------------------------------------- */
/* 1. A：node 行必须把 git 的提示文本原样转发（与 POSIX 版对齐）                */
/* -------------------------------------------------------------------------- */

test('生成物形状：node 行在同一行上转发 %*，且 %* 之前就是 %~dp0 的脚本', async (t) => {
  const { files } = await makeAskpass(t)
  const text = await readFile(files.cmd, 'utf8')
  const lines = text.split('\r\n')
  const nodeLine = lines.find((line) => line.includes('%DSH_GIT_SYNC_NODE%'))
  assert.ok(nodeLine !== undefined, 'askpass.cmd 必须有一行调用解释器')
  assert.equal(nodeLine, '"%DSH_GIT_SYNC_NODE%" "%~dp0askpass.mjs" %*',
    'node 行必须与 POSIX 版一致地把 git 的参数原样转发（%* 与解释器同在一行）')
  // 这一行必须在 `exit /b` 之前，且是最后一条实际命令。
  const nodeAt = lines.indexOf(nodeLine)
  assert.equal(lines[nodeAt + 1], 'exit /b %ERRORLEVEL%')
  assert.equal(lines.slice(0, nodeAt).some((line) => line.includes('%DSH_GIT_SYNC_NODE%')), false,
    '解释器只能被调用一次')
})

/* -------------------------------------------------------------------------- */
/* 2. C：注释行不许带 cmd 元字符；可执行行必须保留全部占位符                    */
/* -------------------------------------------------------------------------- */

test('生成物卫生：rem 行不含 cmd 元字符，可执行行仍保留解释器变量 / %* / %ERRORLEVEL% / %~dp0', async (t) => {
  const { files } = await makeAskpass(t)
  const text = await readFile(files.cmd, 'utf8')
  const lines = text.split('\r\n').filter((line) => line !== '')
  const commentLines = lines.filter((line) => /^\s*rem\b/i.test(line))
  const execLines = lines.filter((line) => !/^\s*rem\b/i.test(line))
  assert.ok(commentLines.length >= 2, '必须真的有注释行，否则这条断言会凭空通过')
  for (const line of commentLines) {
    assert.equal(CMD_METACHARS.test(line), false,
      `注释行不得含 cmd 元字符（否则 cmd 会把尾巴当命令跑）：${line}`)
  }
  const joined = execLines.join('\n')
  for (const token of ['%DSH_GIT_SYNC_NODE%', '%*', '%ERRORLEVEL%', '%~dp0']) {
    assert.equal(joined.includes(token), true, `可执行行必须保留占位符 ${token}`)
  }
  // token 既不在文件里，也不许被 cmd 展开。
  assert.equal(text.includes(FAKE_TOKEN), false, 'askpass.cmd 不得包含 token')
  assert.equal(text.includes('%DSH_GIT_SYNC_TOKEN%'), false, 'askpass.cmd 不得展开 token 变量')
})

/* -------------------------------------------------------------------------- */
/* 3. D2：真实 node 执行生成的 .mjs，按提示文本答（用户名 / token）             */
/* -------------------------------------------------------------------------- */

test('生成的 .mjs（真实 node 执行）：用户名问句答用户名、口令问句答 token', async (t) => {
  const { dir, files, env } = await makeAskpass(t)
  const username = await runNode(dir, files.js, [USER_PROMPT], env)
  assert.equal(username.stdout, FAKE_USER)
  const password = await runNode(dir, files.js, [PASS_PROMPT], env)
  assert.equal(password.stdout, FAKE_TOKEN)
  assert.equal(username.stderr, '')
  assert.equal(password.stderr, '')
})

/* -------------------------------------------------------------------------- */
/* 4. D3 前半：两次连续调用共用一个计数文件，无提示文本时先用户名、后 token      */
/* -------------------------------------------------------------------------- */

test('两次连续的无提示调用共用一个计数文件：第一次用户名、第二次 token（一次 git 调用的形状）', async (t) => {
  const { dir, files, env } = await makeAskpass(t)
  const first = await runNode(dir, files.js, [], env)
  assert.equal(first.stdout, FAKE_USER, '一次 git 调用的第一次问询必须是用户名')
  const second = await runNode(dir, files.js, [], env)
  assert.equal(second.stdout, FAKE_TOKEN, '同一次调用的第二次问询才是 token')
  // 计数文件是本次修复的形状：带父进程与时间戳的 JSON，不再是裸数字。
  const state = JSON.parse(await readFile(files.counter, 'utf8'))
  assert.equal(typeof state.ppid, 'number')
  assert.equal(typeof state.at, 'number')
  assert.equal(state.count, 2)
})

/* -------------------------------------------------------------------------- */
/* 5. D3 后半：换父进程（上一次调用已问满两项）⇒ 从用户名重新开始               */
/* -------------------------------------------------------------------------- */

test('第三次调用换父进程且上次已问满两项：从用户名重新开始，绝不沿用 token', async (t) => {
  const { dir, files, env } = await makeAskpass(t)
  // 先用同一个父进程问满两项，把计数留在「问完了」的状态。
  assert.equal((await runNode(dir, files.js, [], env)).stdout, FAKE_USER)
  assert.equal((await runNode(dir, files.js, [], env)).stdout, FAKE_TOKEN)
  // 第三次由另一个 node 进程拉起：askpass 的父进程因此与上一次不同。
  const helper = 'import { execFile } from "node:child_process";'
    + 'execFile(process.execPath, [process.argv[1]], (error, stdout) => {'
    + 'process.stdout.write(error ? `ERR:${error.message}` : stdout) })'
  const third = await exec(process.execPath, ['-e', helper, files.js], { cwd: dir, env })
  assert.equal(third.stdout.replace(/\r?\n$/, ''), FAKE_USER,
    '新一次 git 调用的第一次问询必须是用户名')
  const fourth = await exec(process.execPath, ['-e', helper, files.js], { cwd: dir, env })
  assert.equal(fourth.stdout.replace(/\r?\n$/, ''), FAKE_TOKEN)
})

test('计数文件过期（超过时间窗且父进程不同）也按新调用处理；旧格式裸数字不得继承', async (t) => {
  const { dir, files, env } = await makeAskpass(t)
  await writeFile(files.counter, JSON.stringify({
    ppid: process.pid + 100000, at: Date.now() - 60000, count: 1,
  }))
  assert.equal((await runNode(dir, files.js, [], env)).stdout, FAKE_USER,
    '过期计数文件必须被丢弃')
  // 旧版生成物写的是裸数字：解析不到 {ppid, at} ⇒ 一律按新调用处理。
  await writeFile(files.counter, '1')
  assert.equal((await runNode(dir, files.js, [], env)).stdout, FAKE_USER,
    '旧格式的全局计数不得让用户名问句拿到 token')
})

/* -------------------------------------------------------------------------- */
/* 6. D4 负向对照：旧 shim 会把用户名问句答成 token（夹具体内嵌，回归可观测）    */
/* -------------------------------------------------------------------------- */

/** 旧版生成物（bug 现场，逐字内嵌）：.cmd 不转发 `%*`，.mjs 用全局计数且从不重置。 */
const LEGACY_MJS = [
  '// legacy fixture: 旧版生成物（无参数转发 + 全局计数 + 从不重置）',
  "import { readFileSync, writeFileSync } from 'node:fs'",
  '',
  "const token = process.env.DSH_GIT_SYNC_TOKEN ?? ''",
  "const user = process.env.DSH_GIT_SYNC_USER ?? 'x-access-token'",
  "const prompt = process.argv.slice(2).join(' ')",
  '',
  'const emit = (value) => {',
  '  process.stdout.write(`${value}\\n`)',
  '  process.exit(0)',
  '}',
  '',
  "if (/sername/i.test(prompt)) emit(user)",
  "if (/assword|assphrase/i.test(prompt)) emit(token)",
  '',
  "const counterFile = process.env.DSH_GIT_SYNC_ASKPASS_COUNTER ?? ''",
  'let count = 0',
  "if (counterFile !== '') {",
  "  try { count = Number.parseInt(readFileSync(counterFile, 'utf8'), 10) || 0 } catch { count = 0 }",
  '  try { writeFileSync(counterFile, String(count + 1)) } catch { /* 计数失败不影响输出 */ }',
  '}',
  'emit(count === 0 ? user : token)',
  '',
].join('\n')

test('负向对照：旧 shim（全局计数已到 1）把用户名问句答成 token，新 shim 答用户名', async (t) => {
  const { dir, files, env } = await makeAskpass(t)
  const legacyPath = path.join(dir, 'legacy-askpass.mjs')
  await writeFile(legacyPath, LEGACY_MJS, 'utf8')
  // 旧 .cmd 不转发 %*：node 拿不到提示文本，只能落到全局计数上（这里已到 1）。
  await writeFile(files.counter, '1')
  const legacyAnswer = await runNode(dir, legacyPath, [], env)
  assert.equal(legacyAnswer.stdout, FAKE_TOKEN,
    '旧 shim 确实会把随后的一次用户名问句答成 token —— 这就是 403 现场')
  assert.notEqual(legacyAnswer.stdout, FAKE_USER, '旧 shim 的答案就是错的')

  // 换成新 shim，同一个计数文件（旧格式、值为 1）：必须答用户名。
  await writeFile(files.counter, '1')
  const newAnswer = await runNode(dir, files.js, [], env)
  assert.equal(newAnswer.stdout, FAKE_USER, '新 shim 在同样的「别人留下的计数」下必须答用户名')
})

/* -------------------------------------------------------------------------- */
/* 7. D5 / D6：真实 cmd 见证（%* 真的把提示送进 node；stderr 必须为空）         */
/* -------------------------------------------------------------------------- */

test('真实 cmd 见证（Windows）：提示文本经 %* 到达 node，stdout 正确且 stderr 为空', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('只在 Windows 上存在 cmd.exe；这一条是唯一能证明 %* 真的穿过 cmd 的用例')
    return
  }
  const { dir, files, env } = await makeAskpass(t)
  const username = await exec('cmd.exe', ['/d', '/c', files.cmd, USER_PROMPT], { cwd: dir, env })
  assert.equal(username.stdout.replace(/\r?\n$/, ''), FAKE_USER,
    'cmd 必须把提示文本经 %* 原样交给 node，让 node 认出这是用户名问句')
  assert.equal(username.stderr, '', 'stderr 必须为空：注释行的元字符尾巴不得被当成命令（缺陷 4）')
  assert.equal(username.stderr.includes('不是内部或外部命令'), false)

  const password = await exec('cmd.exe', ['/d', '/c', files.cmd, PASS_PROMPT], { cwd: dir, env })
  assert.equal(password.stdout.replace(/\r?\n$/, ''), FAKE_TOKEN)
  assert.equal(password.stderr, '')
})

/* -------------------------------------------------------------------------- */
/* 8. 7-bit ASCII 门禁 + 无 console 形状回归（本轮 stderr 残渣）                 */
/* -------------------------------------------------------------------------- */

/**
 * 现场（Lead 真机，2026-11-25，复现见 `.tmp/gates-stderr-1..5.out`）：修好 %* 之后，真机
 * `git fetch` + `git push` 的 stderr 里，**每次问询**都多出一行把注释尾巴当命令执行的中文报错
 * （`'…整行再执行 rem，切出来的尾巴被当成命令跑…' 不是内部或外部命令`）。退出码与凭据都对，
 * 但它污染了失败分类器读的那一行。
 *
 * 机制（本机实测，非推测）：git 拉起 askpass 时没有 console（生产是 `execFile` +
 * `windowsHide:true` ⇒ CREATE_NO_WINDOW），cmd 按 **OEM 代码页 936** 解析批处理文件，于是 UTF-8
 * 的中文注释字节被当成 DBCS 双字节对；行尾落单的 lead byte 跨行吞掉 CRLF，紧邻的注释行就从
 * 中间被当成一条命令执行。**同一文件在挂 console 时是干净的**——所以旧用例（`exec('cmd.exe')`
 * 不传 windowsHide）一直是绿的，缺陷只在无 console 形状里出现。
 *
 * 因此下面两条是配套的：
 *   · 结构门禁：生成物里一个 >0x7F 的字节都不许有（代码页无关，任何 Windows 上都成立）；
 *   · 形状回归：真按生产形状（无 console）跑两次问询，stderr 必须为空。这一条是本机 CP936 下
 *     的实测复现，在单字节 OEM 代码页的 Windows 上不会发作（但那时结构门禁仍然成立）。
 */

test('生成物必须是 7-bit ASCII：askpass.cmd 里不许出现任何 >0x7F 的字节', async (t) => {
  const { files } = await makeAskpass(t)
  const bytes = await readFile(files.cmd)
  assert.ok(Buffer.isBuffer(bytes), '必须按字节读，不能先解码成字符串')
  const bad = []
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > 0x7f) bad.push(`${i}:0x${bytes[i].toString(16)}`)
  }
  assert.deepEqual(bad, [],
    'askpass.cmd 必须是纯 ASCII：cmd 用 OEM 代码页解析批处理文件，多字节注释会吞掉行尾，'
    + '把下一条注释的尾巴当成命令执行，往 stderr 吐「不是内部或外部命令」（分类器的输入被污染）')
  // 说明理由仍然留在 TypeScript 源码里（给人读），生成物里只留 7-bit 英文。
  assert.equal(/[^\x00-\x7f]/.test(await readFile(files.cmd, 'utf8')), false,
    '文本视图也必须全 ASCII')
})

test('无 console 形状（与生产一致：windowsHide + piped stdio）：两次问询的 stderr 都为空', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('只在 Windows 上存在 cmd.exe')
    return
  }
  const { dir, files, env } = await makeAskpass(t)
  // 生产 `GitRepo.run()` 用的就是 execFile + windowsHide:true ⇒ 子进程没有 console。
  // 这正是旧用例漏掉的形状：有 console 时 cmd 解析同样的中文注释也不出错。
  const username = await exec('cmd.exe', ['/d', '/c', files.cmd, USER_PROMPT], {
    cwd: dir, env, windowsHide: true,
  })
  assert.equal(username.stdout.replace(/\r?\n$/, ''), FAKE_USER)
  assert.equal(username.stderr, '',
    '无 console 时 stderr 必须为空：注释行的多字节尾巴不得被当成命令执行')
  assert.equal(username.stderr.includes('不是内部或外部命令'), false)
  assert.equal(username.stderr.includes('not recognized as an internal or external command'), false)

  const password = await exec('cmd.exe', ['/d', '/c', files.cmd, PASS_PROMPT], {
    cwd: dir, env, windowsHide: true,
  })
  assert.equal(password.stdout.replace(/\r?\n$/, ''), FAKE_TOKEN)
  assert.equal(password.stderr, '')
})

