/**
 * 插件包元信息 / 图标 / 详情文档 / bundle patch 的静态契约。
 *
 * Plugin Manager 不激活插件也会读取这些资源：`exports["./icon"]` 指向的文件必须
 * 真实存在且可解析，`files` 必须覆盖 locale、docs、icon 与运行时产物，`meta.detail`
 * 指向的文档必须随包发布。这里全部做静态校验，避免"安装成功但详情页/图标空白"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))

const ICON_MAX_BYTES = 256 * 1024

test('package.json 基本字段完整，description 为单行短文案', () => {
  assert.equal(pkg.name, 'dsh-dots')
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'version 必须是 semver')
  assert.equal(typeof pkg.description, 'string')
  assert.ok(pkg.description.trim().length > 0, 'description 不能为空')
  assert.ok(!/[\r\n]/.test(pkg.description), 'description 不能含换行')
  assert.ok(pkg.description.length <= 200, `description 不得超过 200 字符，实际 ${pkg.description.length}`)
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.type, 'module')
})

test('icon 资源真实存在、格式合法且不超过 256 KiB', () => {
  // 两种声明方式：顶层 package.json icon，或 exports["./icon"]（本项目用后者）。
  const iconRel = typeof pkg.icon === 'string' ? pkg.icon : pkg.exports && pkg.exports['./icon']
  assert.equal(typeof iconRel, 'string', '必须声明 exports["./icon"] 或顶层 icon')
  assert.ok(!path.isAbsolute(iconRel), 'icon 必须是包内相对路径')
  assert.ok(!/^[a-z]+:/i.test(iconRel), 'icon 不能是 URL')
  const iconPath = path.join(pkgDir, iconRel.replace(/^\.\//, ''))
  assert.ok(existsSync(iconPath), `icon 文件不存在：${iconRel}`)
  const bytes = statSync(iconPath).size
  assert.ok(bytes > 0 && bytes <= ICON_MAX_BYTES, `icon 必须 >0 且 ≤256 KiB，实际 ${bytes} 字节`)

  const text = readFileSync(iconPath, 'utf8')
  assert.match(text, /<svg[\s>]/, 'icon 必须是可解析的 SVG')
  assert.match(text, /viewBox="[^"]+"/, 'SVG 必须带 viewBox')
  assert.ok(!/<script[\s>]/i.test(text), 'icon 不能含脚本')
  assert.ok(!/\son[a-z]+\s*=/i.test(text), 'icon 不能含事件处理属性')
  assert.ok(!/<image[\s>]/i.test(text), 'icon 不应内嵌外部位图')
})

test('exports 与 files 覆盖运行时、locale、icon、详情文档', () => {
  assert.equal(pkg.main, './dist/index.js')
  assert.equal(pkg.exports['.'], './dist/index.js')
  assert.equal(pkg.exports['./client'], './dist/client.js')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  for (const rel of ['dist/index.js', 'dist/client.js', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(existsSync(path.join(pkgDir, rel)), `缺少产物：${rel}`)
  }
  assert.ok(Array.isArray(pkg.files))
  for (const entry of ['dist', 'locale', 'icon.svg', 'cordis.patch.yml', 'README.md', 'docs']) {
    assert.ok(pkg.files.includes(entry), `package.json files 必须包含 ${entry}`)
  }
})

test('locale 声明的详情文档都随包存在', () => {
  for (const lang of ['en', 'zh']) {
    const dict = JSON.parse(readFileSync(path.join(pkgDir, 'locale', `${lang}.json`), 'utf8'))
    const rel = dict['meta.detail']
    assert.equal(typeof rel, 'string', `${lang} 缺少 meta.detail`)
    assert.ok(existsSync(path.join(pkgDir, rel)), `${lang} meta.detail 指向的文件不存在：${rel}`)
  }
  assert.ok(existsSync(path.join(pkgDir, 'docs', 'DETAIL.md')))
  assert.ok(existsSync(path.join(pkgDir, 'docs', 'DETAIL.zh.md')))
})

test('bundle patch 只插入一个 dots 行，且 client 注册 id 与包名一致', () => {
  const patch = readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /-\s*insert:/)
  assert.match(patch, /id:\s*dots/)
  assert.match(patch, /name:\s*['"]?dsh-dots['"]?/)
  const client = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  // loader id 必须等于包名（旧断言写死 'dots'，正是本次线上加载失败的根因）。
  const idRe = new RegExp(`__ModuleLoader__\\.load\\(\\{\\s*\\n\\s*id:\\s*'${pkg.name}'`)
  assert.match(client, idRe, 'client loader id 必须等于 package.json.name')
})

test('README 记录 insert: 多行块限制（整块合并 + 不嵌套）', () => {
  const readme = readFileSync(path.join(pkgDir, 'README.md'), 'utf8')
  assert.match(readme, /insert:\s*`?多行块限制|`insert:`\s*多行块限制/, 'README 必须说明 insert: 多行块限制')
  assert.match(readme, /一个\s*`?insert:`?\s*块只放一行|一个 `insert:` 块只放一行/, 'README 必须给出“一块一行”的用法')
  assert.match(readme, /嵌套\s*`?insert:`?/, 'README 必须说明不能嵌套 insert')
})
