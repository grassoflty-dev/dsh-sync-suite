#!/usr/bin/env node
// 统一构建入口：
//   1) 插件 TypeScript -> dist（含 client.js 拷贝）
//   2) 应用纯逻辑（model/common）-> apps/arkui-schedule/tools/.build（供 node --test 导入）
//   3) node --check 校验产物
// 用法：node tools/build.mjs [--check]
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const checkOnly = process.argv.includes('--check')

function run(cmd, args, label) {
  process.stdout.write(`\n> ${label ?? path.basename(cmd)} ${args.join(' ')}\n`)
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
}

function resolveTsc() {
  // 从项目根解析 typescript，避免依赖 PATH 中的 .bin 注册方式
  const candidates = [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(root, 'node_modules', '.bin', 'tsc'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error('未找到 typescript，请先在项目根执行 pnpm add -D typescript @types/node')
}

const tsc = resolveTsc()
const errors = []

// 1) 插件
if (!checkOnly) {
  run(process.execPath, [path.join(root, 'packages/dsh-dots/scripts/build.mjs')], 'plugin build')
}

// 2) 应用纯逻辑（应用骨架由执行者创建；缺失时给出明确告警而不是静默跳过）
const appToolsTsconfig = path.join(root, 'apps/arkui-schedule/tools/tsconfig.json')
if (existsSync(appToolsTsconfig)) {
  run(process.execPath, [tsc, '-p', appToolsTsconfig], 'app logic tsc')
} else {
  console.warn(`[build] 跳过应用纯逻辑编译：缺少 ${appToolsTsconfig}`)
}

// 3) 产物语法检查
const artifacts = [
  path.join(root, 'packages/dsh-dots/dist/index.js'),
]
const clientDist = path.join(root, 'packages/dsh-dots/dist/client.js')
if (existsSync(clientDist)) artifacts.push(clientDist)
else console.warn(`[build] 警告：缺少 ${clientDist}（客户端模块尚未产出）`)
const appBuild = path.join(root, 'apps/arkui-schedule/tools/.build')
if (existsSync(appBuild)) artifacts.push(path.join(appBuild, 'model/jsonl.js'))

for (const artifact of artifacts) {
  if (!existsSync(artifact)) {
    console.error(`[build] 缺少产物：${artifact}`)
    errors.push(artifact)
    continue
  }
  try {
    run(process.execPath, ['--check', artifact], `node --check ${path.relative(root, artifact)}`)
    console.log(`[build] node --check 通过：${path.relative(root, artifact)}`)
  } catch {
    errors.push(artifact)
  }
}

if (errors.length) {
  console.error(`\n[build] 失败：${errors.length} 个产物异常`)
  process.exit(1)
}
console.log('\n[build] 全部构建步骤完成')
