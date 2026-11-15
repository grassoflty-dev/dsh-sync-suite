#!/usr/bin/env node
/**
 * 在「纯 DevEco / HarmonyOS」与「ArkUI-X 双端」两种构建模式之间切换。
 *
 * 背景（2026-11-15 实测）：
 * - 纯 DevEco 26 的 build-profile schema 只接受 runtimeOS: HarmonyOS | OpenHarmony，
 *   `runtimeOS: "Android"` 需要 ArkUI-X 工具链；而且 DevEco 的 ArkTS 编译器不认识
 *   ArkUI-X 的 `@crossplatform` 装饰器（报 Cannot find name 'crossplatform'）。
 * - 因此两种模式的 profile 与装饰器必须成套切换，不能混用。
 *
 * 用法：
 *   node tools/set-build-mode.mjs --mode harmony    # 默认：纯 HarmonyOS（无 Android product、无 @crossplatform）
 *   node tools/set-build-mode.mjs --mode arkui-x    # ArkUI-X：双 product + 每个 struct 前置 @crossplatform
 *   node tools/set-build-mode.mjs --check           # 只报告当前模式，不写文件
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const modeFlag = args.indexOf('--mode')
const mode = modeFlag >= 0 ? args[modeFlag + 1] : undefined
const checkOnly = args.includes('--check')

const PROFILES = [
  { active: join(root, 'build-profile.json5'), variants: { harmony: join(root, 'build-profile.harmony.json5'), 'arkui-x': join(root, 'build-profile.arkui-x.json5') } },
  { active: join(root, 'entry/build-profile.json5'), variants: { harmony: join(root, 'entry/build-profile.harmony.json5'), 'arkui-x': join(root, 'entry/build-profile.arkui-x.json5') } }
]

function currentMode() {
  const text = readFileSync(join(root, 'build-profile.json5'), 'utf8')
  return /"runtimeOS"\s*:\s*"Android"/.test(text) ? 'arkui-x' : 'harmony'
}

if (checkOnly || mode === undefined) {
  const now = currentMode()
  console.log(`当前构建模式：${now}${checkOnly ? '' : '（未指定 --mode，仅报告）'}`)
  process.exit(0)
}

if (mode !== 'harmony' && mode !== 'arkui-x') {
  console.error(`未知模式：${mode}（只支持 harmony / arkui-x）`)
  process.exit(1)
}

// 1) 切换 profile
for (const item of PROFILES) {
  const source = item.variants[mode]
  if (!existsSync(source)) {
    console.error(`缺少模式文件：${relative(root, source)}`)
    process.exit(1)
  }
  writeFileSync(item.active, readFileSync(source))
}

// 2) 切换 @crossplatform 装饰器
const { readdirSync, statSync } = await import('node:fs')
const collect = (dir) => {
  const files = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) files.push(...collect(full))
    else if (name.endsWith('.ets')) files.push(full)
  }
  return files
}
const targets = collect(join(root, 'entry/src/main/ets')).concat(
  existsSync(join(root, 'entry/src/harmony/ets')) ? collect(join(root, 'entry/src/harmony/ets')) : []
)
let touched = 0
for (const file of targets) {
  const text = readFileSync(file, 'utf8')
  if (!/\bstruct\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\{/.test(text)) continue
  let next = text
  if (mode === 'arkui-x') {
    if (!/@crossplatform\b/.test(next)) {
      next = next.replace(/^([ \t]*)@(Entry|Component)\b/gm, '$1@crossplatform\n$1@$2')
    }
  } else {
    next = next.replace(/^[ \t]*@crossplatform[ \t]*\r?\n/gm, '')
  }
  if (next !== text) {
    writeFileSync(file, next)
    touched++
  }
}

console.log(`已切换到 ${mode} 模式：2 个 build-profile + ${touched} 个 .ets 装饰器已更新`)
try {
  execFileSync(process.execPath, [join(root, 'tools/validate-app.mjs')], { stdio: 'inherit' })
} catch {
  process.exitCode = 1
}
