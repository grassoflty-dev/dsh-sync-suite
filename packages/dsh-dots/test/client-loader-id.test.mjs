/**
 * 客户端 loader id 的护栏测试（中文注释）。
 *
 * 背景：DSH 以「包名」作为 __ModuleLoader__ 工厂的 key，而 client.js 曾写
 * `id: 'dots'`，导致 factory 执行了却没有注册到 `dsh-dots`，Web GUI 报
 * "loaded without registering \"dsh-dots\""。
 *
 * 本文件同时守住三套互不相同的命名空间，防止有人为了修 loader id 连带改名：
 *   1) loader id（window.__ModuleLoader__.load 的 id）= package.json.name
 *   2) slot / panel id（settings.section 的 dots、dots-remote）
 *   3) RPC 路径（/dsh-dots/rpc）
 * locale NS `dots` 与 slot id 同属面板内部命名，也不得改名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderClientSource } from '../scripts/build.mjs'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const builtText = readFileSync(path.join(pkgDir, 'dist', 'client.js'), 'utf8')
const srcText = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')

const LOADER_ID_RE = /\bwindow\.__ModuleLoader__\.load\(\{\s*\n\s*id:\s*(['"])([^'"]*)\1/

/** 取出 __ModuleLoader__.load({ id: ... }) 的 id；定位不到返回 null。 */
function loaderId(text) {
  const m = text.match(LOADER_ID_RE)
  return m ? m[2] : null
}

test('dist/client.js 含有字面量 id: \'dsh-dots\'', () => {
  assert.match(
    builtText,
    /\bwindow\.__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'dsh-dots'/,
    'dist/client.js 的 loader id 必须是 dsh-dots'
  )
})

test('loader id 与 package.json.name 一致（src 与 dist 均校验）', () => {
  assert.equal(typeof pkg.name, 'string')
  assert.equal(loaderId(builtText), pkg.name, 'dist 的 loader id 必须等于 package.json.name')
  assert.equal(loaderId(srcText), pkg.name, 'src 的 loader id 也必须等于 package.json.name')
})

test('exports["./client"] 指向已构建的 dist/client.js', () => {
  const rel = pkg.exports && pkg.exports['./client']
  assert.equal(rel, './dist/client.js', 'exports["./client"] 必须指向构建产物')
  assert.ok(
    existsSync(path.join(pkgDir, rel.replace(/^\.\//, ''))),
    'exports["./client"] 指向的文件必须真实存在'
  )
})

test('dsh.client.platform 为 web', () => {
  assert.equal(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform, 'web')
})

test('dist/client.js 与 build.mjs 新鲜构建输出逐字节一致', () => {
  const fresh = Buffer.from(renderClientSource(), 'utf8')
  const onDisk = Buffer.from(builtText, 'utf8')
  assert.equal(
    Buffer.compare(onDisk, fresh),
    0,
    'dist/client.js 已漂移：请重新运行 node scripts/build.mjs'
  )
})

test('面板内的 slot id / locale NS / RPC 路径未被连带改名', () => {
  assert.match(builtText, /ctx\.slots\.inject\('settings\.section'/, 'slot 名必须仍是 settings.section')
  assert.match(builtText, /name:\s*'settings\.section',\s*\n\s*id:\s*'dots-remote'/, '远程面板 id 必须仍是 dots-remote')
  assert.match(builtText, /name:\s*'settings\.section',\s*\n\s*id:\s*'dots'/, '设置面板 id 必须仍是 dots')
  assert.match(builtText, /const NS = 'dots'/, 'locale 命名空间必须仍是 dots')
  assert.match(builtText, /const RPC_PATH = '\/dsh-dots\/rpc'/, 'RPC 路径必须仍是 /dsh-dots/rpc')
})
