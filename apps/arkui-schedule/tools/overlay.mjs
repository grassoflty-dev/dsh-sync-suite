#!/usr/bin/env node
/**
 * 文件级「平台覆盖层」——替代对 entry 模块**不生效**的 `targets[].source.sourceRoots`。
 *
 * 背景（2026-11-15 实测，见 docs/VERIFICATION.md §11「为什么源码测试全绿但产物缺功能」）：
 *   - `.arkui-x/arkui-x-config.json5` 里的 `{crossplatform:true}` 会让 hvigor 进入 crossplatform 模式，
 *     此时 `aceModuleRoot` 固定为 `entry/src/main/ets`，`@kit.CoreVisionKit` 等会被
 *     "can't support crossplatform application" 拦下；
 *   - `entry/build-profile.json5` 的 `source.sourceRoots` 只对依赖的 HAR/HSP 生效，
 *     对 entry 模块自己的 `ets` 源根无效 —— 于是 `src/harmony/**` 从来没有被编译，
 *     产物里连 `pages/Handwriting` 都不存在。
 *
 * 因此这里用最朴素、可逆的办法：把 `entry/src/harmony/**` 按相对路径复制到 `entry/src/main/**`，
 * 构建前 apply、构建后 restore。被覆盖/新建的文件都记录在 `.platform-overlay/manifest.json`，
 * restore 时可以逐字节还原（含删除新建文件），因此**不会污染工作区**。
 *
 * 用法：
 *   node tools/overlay.mjs apply     # 应用鸿蒙覆盖层（备份到 .platform-overlay/）
 *   node tools/overlay.mjs restore   # 还原（删除新建文件、写回备份）
 *   node tools/overlay.mjs status    # 打印当前是否已应用
 */
import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const harmonyDir = join(root, 'entry/src/harmony')
const mainDir = join(root, 'entry/src/main')
const stateDir = join(root, '.platform-overlay')
const manifestPath = join(stateDir, 'manifest.json')
const backupDir = join(stateDir, 'backup')

const cmd = process.argv[2] ?? 'status'

/** 递归列出目录下所有文件（相对 dir 的 POSIX 路径）。 */
function walk(dir, base = dir) {
  const out = []
  if (!existsSync(dir)) {
    return out
  }
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, base))
    } else {
      out.push(relative(base, full).split('\\').join('/'))
    }
  }
  return out
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

function apply() {
  const existing = readManifest()
  if (existing !== null) {
    // 并发构建会抢这份状态：如果这里只打印警告就继续，构建会编出一个「没有手写链路」的 HAP
    // （main_pages.json 只剩 4 页）。所以必须硬失败，让 build-harmony.ps1 当场停下。
    console.error(
      `✗ 覆盖层已被应用（${existing.replaced.length} 覆盖 / ${existing.created.length} 新建，时间 ${existing.at}）。` +
        '这说明另一个构建正在进行；并发构建会破坏产物。先等它结束，或手动 `node tools/overlay.mjs restore` 后再试。'
    )
    return 1
  }
  mkdirSync(backupDir, { recursive: true })
  const files = walk(harmonyDir)
  const manifest = { replaced: [], created: [], at: new Date().toISOString() }
  for (const rel of files) {
    const source = join(harmonyDir, rel)
    const target = join(mainDir, rel)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) {
      const backup = join(backupDir, rel)
      mkdirSync(dirname(backup), { recursive: true })
      copyFileSync(target, backup)
      manifest.replaced.push(rel)
    } else {
      manifest.created.push(rel)
    }
    copyFileSync(source, target)
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`已应用鸿蒙覆盖层：覆盖 ${manifest.replaced.length} 个、新建 ${manifest.created.length} 个`)
  for (const rel of manifest.replaced) {
    console.log(`  replace ${rel}`)
  }
  for (const rel of manifest.created) {
    console.log(`  create  ${rel}`)
  }
  return 0
}

function restore() {
  const manifest = readManifest()
  if (manifest === null) {
    console.log('覆盖层未应用，无需还原')
    return 0
  }
  for (const rel of manifest.created) {
    const target = join(mainDir, rel)
    if (existsSync(target)) {
      unlinkSync(target)
    }
  }
  for (const rel of manifest.replaced) {
    const backup = join(backupDir, rel)
    const target = join(mainDir, rel)
    if (existsSync(backup)) {
      copyFileSync(backup, target)
    }
  }
  rmSync(stateDir, { recursive: true, force: true })
  console.log(`已还原：删除 ${manifest.created.length} 个新建文件、写回 ${manifest.replaced.length} 个备份文件`)
  return 0
}

function status() {
  const manifest = readManifest()
  if (manifest === null) {
    console.log('覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）')
    // ASCII marker for scripts (build-harmony.ps1 asserts it; PS reads UTF-8 as GBK).
    console.log('[overlay] applied=false')
    return 0
  }
  console.log(`覆盖层：已应用（覆盖 ${manifest.replaced.length} / 新建 ${manifest.created.length}，时间 ${manifest.at}）`)
  console.log('[overlay] applied=true')
  return 0
}

if (cmd === 'apply') {
  process.exit(apply())
} else if (cmd === 'restore') {
  process.exit(restore())
} else if (cmd === 'status') {
  process.exit(status())
} else {
  console.error(`未知命令：${cmd}（只支持 apply / restore / status）`)
  process.exit(2)
}
