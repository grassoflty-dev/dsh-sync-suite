/**
 * PowerShell 脚本必须带 UTF-8 BOM 的静态断言（防复发）。
 *
 * 背景：本机 Windows PowerShell 5.1 把「无 BOM 的 UTF-8」按 ANSI 解码。
 * build-harmony.ps1 含中文提示与 `✗` 字符，缺 BOM 时整个脚本在解析期就失败
 * （Missing closing ')' / Try 语句缺少 Catch 等连锁错误），且报错行号完全误导。
 * 编辑器另存为 UTF-8（无 BOM）很容易把 BOM 去掉，所以写成测试硬门禁，不靠人记得。
 *
 * 与 guard.mjs 的 overlay 守卫同一思路：不 skip、不自动修复，红灯说话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..', '..')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

const ps1Dirs = [path.join(repoRoot, 'tools'), path.join(repoRoot, 'apps', 'arkui-schedule', 'tools')]

function trackedScripts() {
  const files = []
  for (const dir of ps1Dirs) {
    for (const name of readdirSync(dir)) {
      if (name.toLowerCase().endsWith('.ps1')) files.push(path.join(dir, name))
    }
  }
  return files.sort()
}

test('全部 tools/*.ps1 都带 UTF-8 BOM（PS5.1 解析含中文脚本的前提）', () => {
  const files = trackedScripts()
  assert.ok(files.length > 0, '至少要扫到一个 .ps1，防止路径写错导致空断言')
  for (const file of files) {
    const bytes = readFileSync(file)
    assert.ok(
      bytes.length >= 3 && bytes.subarray(0, 3).equals(BOM),
      `${path.relative(repoRoot, file)} 缺少 UTF-8 BOM（前三个字节须为 EF BB BF）`,
    )
  }
})

test('build-harmony.ps1 明确带 BOM 且解析期依赖它', () => {
  const file = path.join(repoRoot, 'apps', 'arkui-schedule', 'tools', 'build-harmony.ps1')
  const bytes = readFileSync(file)
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  const text = bytes.toString('utf8')
  assert.match(text, /Write-Host '✗ 无法读取覆盖层状态/, '该脚本含非 ASCII 字面量，缺 BOM 会被 PS5.1 误解码')
})
