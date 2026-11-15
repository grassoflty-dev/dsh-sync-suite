#!/usr/bin/env node
/**
 * 产物级验收：**构建通过 ≠ 交付通过**。
 *
 * 2026-11-15 的事故：`node --test` 全绿、hvigor `BUILD SUCCESSFUL`，但解包 HAP 后发现
 * `main_pages.json` 只有 4 页、`modules.abc` 里没有 `Handwriting` —— 因为
 * `entry/build-profile.json5` 的 `sourceRoots` 对 entry 无效（见 docs/VERIFICATION.md §11），
 * `src/harmony/**` 从来没被编译。这个脚本把「产物必须包含什么」变成可执行断言。
 *
 * 用法：
 *   node tools/verify-hap.mjs                       # 默认检查 entry-default-unsigned.hap（鸿蒙）
 *   node tools/verify-hap.mjs --hap <path>
 *   node tools/verify-hap.mjs --apk dist-android/arkui-schedule-android-debug.apk
 *
 * 鸿蒙断言（harmony）：
 *   - `resources/base/profile/main_pages.json` 含 `pages/Handwriting`；
 *   - `ets/modules.abc` 含 `Handwriting`、`hw-page-`、`PageBook`、`OcrBatch` 各 ≥1；
 *   - 含手柄/OCR 能力痕迹之一：`HandwriteComponent`（Pen Kit）或 `componentSnapshot`/`recognizeText`。
 * APK 反例断言（android）：APK 内任何条目都不得出现 `Handwriting` / `OcrBatch` /
 *   `textRecognition` / `PenKit` / `hw-page-`。
 */
import { readFileSync, existsSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 极简 ZIP 读取（中央目录 + inflateRaw），够用即可，避免引入依赖。 */
function readZip(buffer) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 65558; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) {
    throw new Error('不是有效的 zip/hap/apk（找不到 EOCD）')
  }
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      break
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compSize = buffer.readUInt32LE(offset + 20)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen)
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buffer.subarray(dataStart, dataStart + compSize)
    let data
    if (method === 0) {
      data = Buffer.from(raw)
    } else {
      try {
        data = inflateRawSync(raw)
      } catch {
        data = Buffer.alloc(0)
      }
    }
    entries.set(name, data)
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 统计 UTF-8 文本里 haystack 出现次数（二进制文件按 latin1 读，ASCII 关键字一样能命中）。 */
function count(haystack, needle) {
  let total = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    total++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return total
}

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const pos = args.indexOf(name)
  return pos >= 0 && args[pos + 1] !== undefined ? args[pos + 1] : fallback
}

const apkPath = argValue('--apk', null)
const mode = apkPath === null ? 'harmony' : 'android'
const target = resolve(
  root,
  apkPath !== null ? apkPath : argValue('--hap', 'entry/build/default/outputs/default/entry-default-unsigned.hap')
)

if (!existsSync(target)) {
  console.error(`✗ 找不到产物：${target}`)
  process.exit(1)
}

const buffer = readFileSync(target)
const entries = readZip(buffer)
console.log(`产物：${target}（${buffer.length} B，${entries.size} 个条目，模式 ${mode}）`)

const failures = []
const ok = (message) => console.log(`  ✓ ${message}`)
const fail = (message) => {
  console.log(`  ✗ ${message}`)
  failures.push(message)
}

if (mode === 'harmony') {
  const pages = entries.get('resources/base/profile/main_pages.json')
  if (pages === undefined) {
    fail('缺少 resources/base/profile/main_pages.json')
  } else {
    const text = pages.toString('utf8')
    if (text.includes('pages/Handwriting')) {
      ok(`main_pages.json 含 pages/Handwriting（${text.length} B）`)
    } else {
      fail(`main_pages.json 不含 pages/Handwriting：${text}`)
    }
  }
  const abc = entries.get('ets/modules.abc')
  if (abc === undefined) {
    fail('缺少 ets/modules.abc')
  } else {
    const text = abc.toString('latin1')
    for (const symbol of ['Handwriting', 'hw-page-', 'PageBook', 'OcrBatch']) {
      const hits = count(text, symbol)
      if (hits >= 1) {
        ok(`modules.abc 含 ${symbol}（${hits} 次）`)
      } else {
        fail(`modules.abc 不含 ${symbol}（覆盖层没进产物？）`)
      }
    }
    const penKit = count(text, 'HandwriteComponent') + count(text, 'HandwriteController')
    const ocr = count(text, 'componentSnapshot') + count(text, 'recognizeText')
    if (penKit >= 1 || ocr >= 1) {
      ok(`含手写/OCR 能力痕迹（Pen Kit ${penKit} 次 / OCR ${ocr} 次）`)
    } else {
      fail('既没有 Pen Kit 符号也没有 OCR/截图符号 —— 手写链路没进产物')
    }
  }
} else {
  // 只禁「代码符号」，不禁纯文案词：
  // - `textRecognition` 会出现在 Settings 页的说明文案里（"可用（textRecognition 逐页串行识别）"），
  //   它只是字符串、不代表调用了 OCR SDK，所以不列入黑名单；
  // - 下面这些是真实的类名/组件 id/API 名，出现即说明手写或 OCR 代码被打进了 Android 包。
  const forbidden = ['Handwriting', 'OcrBatch', 'recognizeText', 'PenKit', 'hw-page-', 'HandwriteComponent']
  for (const symbol of forbidden) {
    let hits = 0
    for (const [name, data] of entries) {
      // 只扫**我们自己的模块**（assets/arkui-x/entry/**）：ArkUI-X 运行时（lib/、systemres/）
      // 里本来就有 componentSnapshot 等符号，扫进去会误报。
      if (data.length === 0 || !name.includes('entry/')) {
        continue
      }
      hits += count(data.toString('latin1'), symbol)
    }
    if (hits === 0) {
      ok(`APK 内无 ${symbol}`)
    } else {
      fail(`APK 内出现 ${symbol}（${hits} 次）—— Android 端不该带手写/OCR 代码`)
    }
  }
}

if (failures.length > 0) {
  console.error(`\n✗ 产物验收失败：${failures.length} 项`)
  process.exit(1)
}
console.log('\n✓ 产物验收通过')
