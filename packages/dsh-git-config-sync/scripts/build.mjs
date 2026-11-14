#!/usr/bin/env node
// 插件构建：tsc 编译 src/ -> dist/，再把纯 JS 客户端模块拷贝进 dist/。
// 运行时零 npm 依赖（只用 node: 内置模块），dist 提交进仓库，安装时无需构建。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsc = require.resolve('typescript/bin/tsc')

execFileSync(process.execPath, [tsc, '-p', path.join(pkgDir, 'tsconfig.json')], {
  cwd: pkgDir,
  stdio: 'inherit',
})

mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
const clientSrc = path.join(pkgDir, 'src', 'client.js')
if (!existsSync(clientSrc)) {
  console.error('[plugin] 构建失败：缺少 src/client.js（浏览器半侧是交付物，不能只告警）')
  process.exit(1)
}
copyFileSync(clientSrc, path.join(pkgDir, 'dist', 'client.js'))
console.log('[plugin] dist/index.js + dist/client.js 已生成')
