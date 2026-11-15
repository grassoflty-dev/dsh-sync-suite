/**
 * 用管道喂 stdin 驱动 ACE Tools 的交互式命令（ace.cmd 在无 stdin 时会 readline 崩溃）。
 * 用法：node ace-driver.cjs <input-line> <cwd> <ace.cmd> <args...>
 */
const { spawn } = require('child_process')

const [input, cwd, ace, ...rest] = process.argv.slice(2)
if (!ace) {
  console.error('usage: node ace-driver.cjs <input-line> <cwd> <ace.cmd> <args...>')
  process.exit(2)
}

const child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', ace, ...rest], {
  cwd,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe']
})

child.stdout.on('data', (d) => process.stdout.write(d))
child.stderr.on('data', (d) => process.stderr.write(d))
child.on('exit', (code) => {
  console.log(`[ace exit] ${code}`)
  process.exit(code === null ? 1 : code)
})

if (input && input.length > 0 && input !== '-') {
  setTimeout(() => {
    try {
      child.stdin.write(input + '\n')
    } catch (error) {
      console.error('[driver] stdin write failed:', error.message)
    }
  }, 2500)
}
setTimeout(() => {
  try { child.stdin.end() } catch (error) { /* ignore */ }
}, 4000)
