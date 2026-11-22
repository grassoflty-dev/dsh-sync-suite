#!/usr/bin/env node
// 插件构建：tsc 编译 src/ -> dist/，再把纯 JS 客户端模块写进 dist/。
// 运行时零 npm 依赖（只用 node: 内置模块），dist 提交进仓库，安装时无需构建。
//
// 客户端 loader id 由 package.json.name 生成：src/client.js 里保留可读的字面量，
// 但真正的交付值在这里按包名重写。这样 loader id 与包名不可能漂移；
// 其他 id（slot/panel id、locale NS、RPC 路径）在各自命名空间，绝不触碰。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsc = require.resolve('typescript/bin/tsc')

/**
 * 生成 dist/client.js 的文本：以 src/client.js 为模板，把
 * `window.__ModuleLoader__.load({ id: ... })` 的 id 字面量替换为 package.json.name。
 * 单测直接调用本函数做「与新鲜构建产物逐字节一致」断言（无需跑 tsc）。
 * @returns {string} 交付用 client.js 文本
 */
export function renderClientSource() {
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const moduleId = pkg.name
  if (typeof moduleId !== 'string' || moduleId.trim() === '') {
    throw new Error('[plugin] 构建失败：package.json.name 缺失，无法生成 client loader id')
  }
  const clientSrc = path.join(pkgDir, 'src', 'client.js')
  if (!existsSync(clientSrc)) {
    throw new Error('[plugin] 构建失败：缺少 src/client.js（浏览器半侧是交付物，不能只告警）')
  }
  const text = readFileSync(clientSrc, 'utf8')
  // 只匹配 load({ 之后紧跟的 id 字面量；匹配不到就报错，绝不静默产出错误 id。
  const idPattern = /(\bwindow\.__ModuleLoader__\.load\(\{\s*\n\s*id:\s*)(['"])([^'"]*)(\2)/
  if (!idPattern.test(text)) {
    throw new Error('[plugin] 构建失败：无法在 src/client.js 定位 __ModuleLoader__.load({ id: ... }，拒绝生成 dist/client.js')
  }
  return text.replace(idPattern, (all, prefix, quote, oldId, closingQuote) =>
    prefix + quote + moduleId + closingQuote)
}

function main() {
  execFileSync(process.execPath, [tsc, '-p', path.join(pkgDir, 'tsconfig.json')], {
    cwd: pkgDir,
    stdio: 'inherit',
  })

  mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
  writeFileSync(path.join(pkgDir, 'dist', 'client.js'), renderClientSource(), 'utf8')
  console.log('[plugin] dist/index.js + dist/client.js 已生成')
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main()
}
