#!/usr/bin/env node
/**
 * 在「纯 DevEco / HarmonyOS」与「ArkUI-X / Android」两种构建模式之间切换。
 *
 * 两种模式的差异（2026-11-15 实测）：
 *   harmony  : hvigorfile 用 @ohos/hvigor-ohos-plugin；entry 源码 = src/main + src/harmony；
 *              build-profile 单 default product；HAP 由 devecocli 构建。
 *   arkui-x  : hvigorfile 用 @ohos/hvigor-ohos-arkui-x-plugin；entry 源码 = src/main（不含手写/OCR）；
 *              Ace Tools 先用 hvigor 编 ArkTS，再用 Gradle 打成 APK。
 *
 * 用法：
 *   node tools/set-build-mode.mjs --mode harmony
 *   node tools/set-build-mode.mjs --mode arkui-x
 *   node tools/set-build-mode.mjs --check
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { readdirSync, statSync } from 'node:fs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const modeFlag = args.indexOf('--mode')
const mode = modeFlag >= 0 ? args[modeFlag + 1] : undefined
const checkOnly = args.includes('--check')

const PROFILES = [
  { active: join(root, 'build-profile.json5'), variants: { harmony: join(root, 'build-profile.harmony.json5'), 'arkui-x': join(root, 'build-profile.harmony.json5') } },
  { active: join(root, 'entry/build-profile.json5'), variants: { harmony: join(root, 'entry/build-profile.harmony.json5'), 'arkui-x': join(root, 'entry/build-profile.arkui-x.json5') } }
]

const HVIGORFILES = {
  harmony: {
    root: `import { appTasks } from '@ohos/hvigor-ohos-plugin';

export default {
  system: appTasks,
  plugins: []
}
`,
    entry: `import { hapTasks } from '@ohos/hvigor-ohos-plugin';

export default {
  system: hapTasks,
  plugins: []
}
`
  },
  'arkui-x': {
    root: `import { AppTasksForArkUIX } from '@ohos/hvigor-ohos-arkui-x-plugin';

export default {
  system: AppTasksForArkUIX,
  plugins: []
}
`,
    entry: `import { HapTasks } from '@ohos/hvigor-ohos-arkui-x-plugin';

export default {
  system: HapTasks,
  plugins: []
}
`
  }
}

function currentMode() {
  const entry = readFileSync(join(root, 'entry/build-profile.json5'), 'utf8')
  return /\.\/src\/harmony/.test(entry) ? 'harmony' : 'arkui-x'
}

if (checkOnly || mode === undefined) {
  console.log(`当前构建模式：${currentMode()}${checkOnly ? '' : '（未指定 --mode，仅报告）'}`)
  process.exit(0)
}
if (mode !== 'harmony' && mode !== 'arkui-x') {
  console.error(`未知模式：${mode}（只支持 harmony / arkui-x）`)
  process.exit(1)
}

for (const item of PROFILES) {
  const source = item.variants[mode]
  if (!existsSync(source)) {
    console.error(`缺少模式文件：${relative(root, source)}`)
    process.exit(1)
  }
  writeFileSync(item.active, readFileSync(source))
}

// hvigorfile 与 hvigor 插件依赖随模式切换（ArkUI-X 用 ArkUIX 任务，HarmonyOS 用内置任务）
writeFileSync(join(root, 'hvigorfile.ts'), HVIGORFILES[mode].root)
writeFileSync(join(root, 'entry/hvigorfile.ts'), HVIGORFILES[mode].entry)

const configPath = join(root, 'hvigor/hvigor-config.json5')
const config = readFileSync(configPath, 'utf8')
const arkuiDep = `'@ohos/hvigor-ohos-arkui-x-plugin':'4.24.1'`
if (mode === 'arkui-x') {
  if (!config.includes('hvigor-ohos-arkui-x-plugin')) {
    writeFileSync(configPath, config.replace(/dependencies\s*:\s*\{/, `dependencies:{${arkuiDep},`))
  }
} else {
  // 去掉 arkui-x 插件依赖，并把它留下的多余逗号一起吃掉（否则 `dependencies:{,}` 会让 hvigor JSON5 解析失败）。
  const cleaned = config
    .replace(/,?'@ohos\/hvigor-ohos-arkui-x-plugin':'[^']*',?/g, '')
    .replace(/\{\s*,/g, '{')
    .replace(/,\s*\}/g, '}')
  writeFileSync(configPath, cleaned)
}

// `.arkui-x/arkui-x-config.json5` 里的 `{crossplatform:true}` 是 hvigor 判定「这是 ArkUI-X 工程」的
// 标记：一旦存在，构建就进入 crossplatform 模式（aceModuleRoot 固定 src/main/ets、@kit.CoreVisionKit
// 被 "can't support crossplatform application" 拦），**鸿蒙覆盖层永远不会被编译**。
// 所以 harmony 模式必须把它挪走、arkui-x 模式再放回来。
const crossMarker = join(root, '.arkui-x/arkui-x-config.json5')
const crossMarkerOff = `${crossMarker}.harmony-off`
if (mode === 'harmony') {
  if (existsSync(crossMarker)) {
    renameSync(crossMarker, crossMarkerOff)
  }
} else {
  if (existsSync(crossMarkerOff)) {
    renameSync(crossMarkerOff, crossMarker)
  }
}

// local.properties 里的 `arkui-x.dir` 会让 hvigor 进入 crossplatform 模式：此时
// aceModuleRoot 只认 `src/main/ets`，`src/harmony` 覆盖层整棵被摇掉（HAP 里连
// pages/Handwriting 都不会出现），并且 @kit.CoreVisionKit 之类会被
// "can't support crossplatform application" 拦下。所以两种模式必须互斥地维护这一行。
const localPropsPath = join(root, 'local.properties')
const ARKUIX_LINE = 'arkui-x.dir=C\\:\\\\Users\\\\GWL\\\\AppData\\\\Local\\\\ArkUI-X\\\\Sdk'
if (existsSync(localPropsPath)) {
  const raw = readFileSync(localPropsPath, 'utf8')
  const lines = raw.split(/\r?\n/)
  const kept = lines.filter((line) => !/^\s*arkui-x\.dir\s*=/.test(line))
  if (mode === 'arkui-x') {
    const existing = lines.find((line) => /^\s*arkui-x\.dir\s*=/.test(line))
    if (existing === undefined) {
      kept.push(ARKUIX_LINE)
    } else {
      kept.push(existing)
    }
  }
  const next = kept.filter((line, index, arr) => line.length > 0 || index < arr.length - 1).join('\n')
  if (next !== raw) {
    writeFileSync(localPropsPath, next)
  }
}

// 装饰器：ArkUI-X 26 的 ets-loader 不认 @crossplatform，两种模式都清掉
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
  const next = text.replace(/^[ \t]*@crossplatform[ \t]*\r?\n/gm, '')
  if (next !== text) {
    writeFileSync(file, next)
    touched++
  }
}

console.log(`已切换到 ${mode} 模式：2 个 build-profile + 2 个 hvigorfile + ${touched} 个 .ets 已更新`)
try {
  execFileSync(process.execPath, [join(root, 'tools/validate-app.mjs')], { stdio: 'inherit' })
} catch {
  process.exitCode = 1
}
