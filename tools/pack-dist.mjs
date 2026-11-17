#!/usr/bin/env node
/**
 * 打交付包 `dist-<时间戳>/`（**不是 Release**：不 git tag、不 GitHub Release、不改版本号）。
 *
 * 产出：
 *   dist-YYYYMMDD-HHmm/
 *     <hap 文件名>.hap                 —— 平板安装包（已签名）
 *     dsh-git-config-sync-<ver>.tgz    —— 插件分发包（dist/locale/docs/package.json/...）
 *     SHA256SUMS.txt                  —— `<sha256>  <bytes>  <mtime ISO>  <path>`
 *     MANIFEST.md                     —— commit / 构建时间 / 文件表 / 测试数字 / "非 Release" 声明
 *
 * 用法：
 *   node tools/pack-dist.mjs
 *   node tools/pack-dist.mjs --tests "1465/1464/0/1" --validate "8/8" --out dist-20261118
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
function arg(name, fallback = '') {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
const outDir = path.resolve(repo, arg('out', `dist-${stamp}`))

function git(...argv) {
  try {
    return execFileSync('git', argv, { cwd: repo, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const commit = git('rev-parse', '--short', 'HEAD') || 'unknown'
const subject = git('log', '-1', '--pretty=%s') || ''
const dirty = git('status', '--porcelain') !== ''

mkdirSync(outDir, { recursive: true })

/* ------------------------------------------------------------------ HAP */

const hapDir = path.join(repo, 'apps', 'arkui-schedule', 'dist-harmony')
const haps = existsSync(hapDir) ? readdirSync(hapDir).filter((name) => name.endsWith('.hap')) : []
if (haps.length === 0) {
  console.error(`no signed HAP under ${hapDir}; build+sign first (tools/build-harmony.ps1 + tools/sign-hap.ps1 -Deliver)`)
  process.exit(2)
}
for (const name of haps) copyFileSync(path.join(hapDir, name), path.join(outDir, name))

/* ------------------------------------------------------------------ 插件 tgz */

const pkgDir = path.join(repo, 'packages', 'dsh-git-config-sync')
const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const tgzName = `dsh-git-config-sync-${pkgJson.version}.tgz`
const tgzPath = path.join(outDir, tgzName)
const members = ['dist', 'locale', 'docs', 'package.json', 'README.md', 'cordis.patch.yml', 'icon.svg'].filter((member) =>
  existsSync(path.join(pkgDir, member)),
)
try {
  execFileSync('tar', ['-czf', tgzPath, '-C', pkgDir, ...members], { encoding: 'utf8' })
} catch (error) {
  console.error(`tar failed: ${error.message}`)
  process.exit(2)
}

/* ------------------------------------------------------------------ 复用文档 */

for (const doc of ['docs/REMOTE-ACCESS-OPTIONS.md', 'docs/REVIEW-remote-security.md']) {
  const from = path.join(repo, doc)
  if (existsSync(from)) copyFileSync(from, path.join(outDir, path.basename(doc)))
}

/* ------------------------------------------------------------------ 校验和 */

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const payload = readdirSync(outDir)
  .filter((name) => name !== 'SHA256SUMS.txt' && name !== 'MANIFEST.md')
  .sort()
const rows = payload.map((name) => {
  const file = path.join(outDir, name)
  const stat = statSync(file)
  return {
    name,
    bytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    sha256: sha256(file),
  }
})

writeFileSync(
  path.join(outDir, 'SHA256SUMS.txt'),
  rows.map((row) => `${row.sha256}  ${String(row.bytes).padStart(10)}  ${row.mtime}  ${row.name}`).join('\n') + '\n',
  'utf8',
)

/* ------------------------------------------------------------------ 清单 */

const tests = arg('tests', '(未记录)')
const validate = arg('validate', '(未记录)')
const manifest = [
  `# 交付包 MANIFEST（非 Release）`,
  '',
  `- 生成时间：${now.toISOString()}`,
  `- Git commit：\`${commit}\`${dirty ? '（**工作树有未提交改动**）' : ''}`,
  `- commit 说明：${subject === '' ? '(none)' : subject}`,
  `- 插件版本：${pkgJson.name}@${pkgJson.version}`,
  `- 测试：${tests}`,
  `- validate-app：${validate}`,
  '',
  '## 文件',
  '',
  '| 文件 | 字节 | SHA256 | mtime |',
  '| --- | --- | --- | --- |',
  ...rows.map((row) => `| ${row.name} | ${row.bytes} | \`${row.sha256}\` | ${row.mtime} |`),
  '',
  '## 发布状态',
  '',
  '- **这不是 Release**：没有 `git tag`、没有 GitHub Release、没有改版本号对外声明。',
  '- 安装方式：平板 `hdc install -r <hap>`（**同证书覆盖，禁止卸载**）；插件用 `dsh plugin add link:<repo>` 或解压 tgz 后链接。',
  '- 校验：`sha256sum -c SHA256SUMS.txt`（或按本文件表格逐个核对）。',
  '',
].join('\n')
writeFileSync(path.join(outDir, 'MANIFEST.md'), manifest, 'utf8')

console.log(`packed -> ${outDir}`)
for (const row of rows) console.log(`  ${row.name}  ${row.bytes}B  ${row.sha256.slice(0, 16)}…`)
console.log('  SHA256SUMS.txt / MANIFEST.md')
