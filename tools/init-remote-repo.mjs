#!/usr/bin/env node
// 生成「用户自选 GitHub/Gitee 私有仓库」的初始目录，并可选绑定远端、打印推送指引。
// 只做本地 git 初始化，不联网。用法：
//   node tools/init-remote-repo.mjs --dir C:\Users\GWL\dsh-sync-repo [--devices pc-a,pc-b,phone-a] [--branch main] [--remote https://github.com/you/dsh-sync.git]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEVICE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

function parseArgs(argv) {
  const out = { devices: ['pc-a', 'pc-b', 'phone-a'], branch: 'main' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') out.dir = argv[++i]
    else if (arg === '--devices') out.devices = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--branch') out.branch = argv[++i]
    else if (arg === '--remote') out.remote = argv[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.dir) {
  console.log('用法：node tools/init-remote-repo.mjs --dir <仓库目录> [--devices pc-a,pc-b,phone-a] [--branch main] [--remote <url>]')
  process.exit(args.help ? 0 : 1)
}
if (!args.branch || !/^[A-Za-z0-9._/-]+$/.test(args.branch)) throw new Error(`分支名不合法：${args.branch}`)
for (const d of args.devices) if (!DEVICE_RE.test(d)) throw new Error(`设备标识不合法：${d}（需 ^[a-z0-9][a-z0-9-]{0,31}$）`)

const repoDir = path.resolve(args.dir)
if (existsSync(repoDir) && existsSync(path.join(repoDir, '.git'))) {
  throw new Error(`目标已是 git 仓库，拒绝覆盖：${repoDir}`)
}
mkdirSync(repoDir, { recursive: true })

for (const d of args.devices) {
  mkdirSync(path.join(repoDir, 'devices', d), { recursive: true })
  writeFileSync(path.join(repoDir, 'devices', d, '.gitkeep'), '', 'utf8')
}

writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n*.log\n.DS_Store\n', 'utf8')
writeFileSync(
  path.join(repoDir, 'README.md'),
  [
    '# DSH 配置同步仓库',
    '',
    '由 `dsh-git-config-sync` 插件与 ArkUI-X 日程助手使用。',
    '',
    '- 每台设备只写 `devices/<deviceId>/`，不要手动合并其他设备目录。',
    '- `devices/<deviceId>/cordis.patch.yml` 为脱敏后的 DSH profile patch；密钥以 `__SECRET__` 占位，恢复时由本地回填。',
    '- 手机端日程追加在 `devices/<deviceId>/schedules/YYYY-MM-DD.jsonl`，附件在 `attachments/<sha256>.png`。',
    '- 仓库必须为**私有**：配置虽已脱敏，仍包含设备与插件拓扑信息。',
    '',
    `设备目录：${args.devices.map((d) => `\`devices/${d}/\``).join('、')}`,
    '',
  ].join('\n'),
  'utf8',
)

function git(gitArgs) {
  execFileSync('git', gitArgs, {
    cwd: repoDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'dsh-sync',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'sync@localhost',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'dsh-sync',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'sync@localhost',
    },
  })
}

git(['init', '-b', args.branch])
git(['add', '-A'])
git(['commit', '-m', 'chore: init dsh sync repository'])
if (args.remote) {
  if (!/^(https:\/\/|ssh:\/\/|git@)/.test(args.remote)) throw new Error('远端地址仅支持 https://、ssh://、git@')
  git(['remote', 'add', 'origin', args.remote])
}

console.log(`\n✅ 已创建：${repoDir}（分支 ${args.branch}，设备 ${args.devices.join(', ')}）`)
if (args.remote) {
  console.log('已绑定 origin。确认远端为空仓库后执行：')
  console.log(`  git -C "${repoDir}" push -u origin ${args.branch}`)
} else {
  console.log('下一步：在 GitHub/Gitee 建**私有**空仓库，然后：')
  console.log(`  git -C "${repoDir}" remote add origin <repoUrl>`)
  console.log(`  git -C "${repoDir}" push -u origin ${args.branch}`)
}
console.log('随后在 DSH「设置 → 配置同步（Git）」里填入同一个仓库地址与设备标识。\n')
