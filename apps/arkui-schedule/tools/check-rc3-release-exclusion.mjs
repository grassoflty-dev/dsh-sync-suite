#!/usr/bin/env node
/**
 * RC-3 release-exclusion 检查：断言 release 构建的 modules.abc **不含** debug harness sentinel。
 *
 * 为什么需要它：ArkTS 没有预处理器，debug-only 只是 `BuildProfile.DEBUG` 编译期常量 +
 * router 参数双闸；router 参数不是访问边界。只有把 release 产物里 sentinel 的缺席变成断言，
 * 「debug-only」才是可证明的，而不是一句意图。
 *
 * 用法：
 *   node tools/check-rc3-release-exclusion.mjs --abc <path-to-modules.abc> [--expect absent|present]
 * 默认 --expect absent。命中（或该在却不在）都以 exit 1 失败，只打印计数，不打印任何凭证。
 */
import { readFileSync } from 'node:fs'

const SENTINEL = 'PIN-ATTACK-01'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
}
const abcPath = flag('--abc', '')
const expect = flag('--expect', 'absent')
if (abcPath.length === 0 || !['absent', 'present'].includes(expect)) {
  console.error('用法：node tools/check-rc3-release-exclusion.mjs --abc <modules.abc> [--expect absent|present]')
  process.exit(2)
}

let text
try {
  text = readFileSync(abcPath, 'utf8')
} catch (error) {
  console.error(`无法读取 abc：${abcPath}`)
  process.exit(2)
}

let count = 0
let at = text.indexOf(SENTINEL)
while (at >= 0) {
  count++
  at = text.indexOf(SENTINEL, at + SENTINEL.length)
}
const ok = expect === 'absent' ? count === 0 : count > 0
console.log(`[rc3-release-exclusion] sentinel=${SENTINEL} expect=${expect} hits=${count} ${ok ? 'PASS' : 'FAIL'}`)
if (!ok) {
  process.exit(1)
}
