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
 * ── 权威来源 / 生成物（mod-repo-overlay-hygiene，2026-11-26）────────────────────────────
 * 这里是**唯一**需要记住的三句话：
 *   1. 产品源码（入库、真正交付的东西）= `entry/src/harmony/**` + `entry/src/harmony-debug/**`。
 *      手写页 / OCR / harmony 版 main_pages.json 全都在那里，跑的是这些文件。
 *   2. `entry/src/main/**` 下与 harmony 同相对路径的文件是**构建期生成物**：apply 复制进去、
 *      restore 删/写回。它们绝不入库 —— 见下面的 GENERATED_PATHS 与仓库根 `.gitignore`。
 *      只有一条源、没有第二份拷贝，所以不存在「改了 main 却没改 harmony」的漂移。
 *   3. 构建中的脏树是可辨认的：`[overlay] applied=true` + `.platform-overlay/` 目录 +
 *      `node tools/overlay.mjs explain` 会把 `git status --porcelain` 逐条判成
 *      overlay（构建态）/ foreign（真·用户改动）。clean build 之后 `git status --porcelain` 必须为空。
 *
 * 崩溃安全（2026-11-26）：manifest 在**动任何文件之前**就落盘（phase=applying），备份用
 * tmp+rename 原子写入。于是任何时刻被硬杀（Stop-Process / OOM / 断电）都不会出现
 * 「文件已经改了、但没有还原记录」的状态：restore 总能依据 manifest 逐字节还原。
 * 万一 `.platform-overlay/` 被手工删掉，status 会通过 GENERATED_PATHS 的残留报 applied=true，
 * restore 也能把残留生成物清掉。
 *
 * 用法：
 *   node tools/overlay.mjs apply [debug|release]  # 应用鸿蒙覆盖层（先写 manifest，再复制）
 *   node tools/overlay.mjs restore                # 还原（删除新建文件、写回备份）
 *   node tools/overlay.mjs status                 # 打印当前是否已应用（含残留生成物）
 *   node tools/overlay.mjs explain                # 把 git status --porcelain 逐条归因
 */
import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync, unlinkSync, renameSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = dirname(dirname(root))
const harmonyDir = join(root, 'entry/src/harmony')
const debugDir = join(root, 'entry/src/harmony-debug')
const mainDir = join(root, 'entry/src/main')
const stateDir = join(root, '.platform-overlay')
const manifestPath = join(stateDir, 'manifest.json')
const backupDir = join(stateDir, 'backup')

const cmd = process.argv[2] ?? 'status'

/**
 * 覆盖层会**新建**（而不是覆盖）的相对路径 —— 也就是 `entry/src/main` 下原本不存在的文件。
 * 这些是构建期生成物：绝不入库，仓库根 `.gitignore` 必须逐条忽略它们。
 * 三条纪律（guard 测试 tools/test/overlayHygiene.test.mjs 会核对）：
 *   - 新增 harmony 源文件若落在 main 下不存在的位置，apply 会硬失败（exit 5）要求在这里登记；
 *   - GENERATED_PATHS 与 .gitignore 的覆盖层段必须逐条一致；
 *   - 已入库的路径不能出现在这里（否则 ignore 规则会把真实产品文件藏起来）。
 */
export const GENERATED_PATHS = [
  'ets/handwriting/HandwritingPager.ets',
  'ets/handwriting/StylusAssist.ets',
  'ets/ocr/OcrBatchManager.ets',
  'ets/pages/Handwriting.ets',
  'ets/services/rc3GateHarness.ets',
]

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

function writeManifest(manifest) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function isGenerated(rel) {
  return GENERATED_PATHS.includes(rel)
}

/** rel → 源目录（harmony 优先，debug 模式再用 harmony-debug 覆盖同相对路径）。 */
function sourceMap(mode) {
  const sources = new Map(walk(harmonyDir).map(rel => [rel, harmonyDir]))
  if (mode === 'debug') {
    for (const rel of walk(debugDir)) sources.set(rel, debugDir)
  }
  return sources
}

/** 本次 apply 会做的全部操作；只读文件系统，不落任何改动。 */
function planOps(mode) {
  const ops = []
  for (const [rel, sourceDir] of sourceMap(mode)) {
    const target = join(mainDir, rel)
    ops.push({ rel, source: join(sourceDir, rel), target, kind: existsSync(target) ? 'replace' : 'create' })
  }
  return ops
}

/** 原子备份：先写 `<backup>.tmp` 再 rename，进程在拷贝中途被杀不会留下半个备份。 */
function backupAtomic(target, backup) {
  mkdirSync(dirname(backup), { recursive: true })
  const tmp = `${backup}.tmp`
  copyFileSync(target, tmp)
  renameSync(tmp, backup)
}

/** 残留的生成物（manifest 丢失时也能认出来）。 */
function orphanPaths() {
  return GENERATED_PATHS.filter(rel => existsSync(join(mainDir, rel)))
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
  const mode = process.argv[3] ?? 'release'
  if (mode !== 'debug' && mode !== 'release') {
    console.error('覆盖层模式仅支持 debug / release')
    return 2
  }
  const ops = planOps(mode)
  // 新建路径必须显式登记：否则它会既不在索引里、也不在 .gitignore 里，
  // 生成出来的代码看起来就是「用户新增的文件」——正是这个模块要消灭的歧义。
  const undeclared = ops.filter(op => op.kind === 'create' && !isGenerated(op.rel)).map(op => op.rel)
  if (undeclared.length > 0) {
    console.error(`✗ 覆盖层要新建 ${undeclared.length} 个未登记的路径：`)
    for (const rel of undeclared) {
      console.error(`    create ${rel}`)
    }
    console.error('  先登记再构建：把它们加进 tools/overlay.mjs 的 GENERATED_PATHS 和仓库根 .gitignore。')
    return 5
  }
  const manifest = {
    version: 2,
    phase: 'applying',
    mode,
    at: new Date().toISOString(),
    replaced: ops.filter(op => op.kind === 'replace').map(op => op.rel),
    created: ops.filter(op => op.kind === 'create').map(op => op.rel),
  }
  // 关键顺序：manifest 先落盘，再动文件。任何时刻被硬杀，还原依据都已经在盘上。
  writeManifest(manifest)
  for (const op of ops) {
    if (op.kind === 'replace') {
      backupAtomic(op.target, join(backupDir, op.rel))
    }
    mkdirSync(dirname(op.target), { recursive: true })
    copyFileSync(op.source, op.target)
  }
  writeManifest({ ...manifest, phase: 'applied' })
  console.log(`已应用鸿蒙覆盖层：覆盖 ${manifest.replaced.length} 个、新建 ${manifest.created.length} 个`)
  for (const rel of manifest.replaced) {
    console.log(`  replace ${rel}`)
  }
  for (const rel of manifest.created) {
    console.log(`  create  ${rel}`)
  }
  console.log('[overlay] applied=true')
  console.log('[overlay] note=构建态（entry/src/main 下的覆盖层拷贝不是用户改动；构建结束会 restore）')
  return 0
}

function restore() {
  const manifest = readManifest()
  const orphans = orphanPaths()
  let removed = 0
  let written = 0
  const unrecoverable = []
  // debug 源集是 release 的超集，恢复期判「是否仍是覆盖层内容」时用它。
  const sources = sourceMap('debug')
  /** 目标文件此刻是否还是覆盖层内容（源文件逐字节相同）——用于证明「没有备份就不能假装干净」。 */
  const stillOverlaid = rel => {
    const sourceDir = sources.get(rel)
    const target = join(mainDir, rel)
    return sourceDir !== undefined && existsSync(target) && readFileSync(target).equals(readFileSync(join(sourceDir, rel)))
  }
  if (manifest !== null) {
    for (const rel of manifest.created) {
      const target = join(mainDir, rel)
      if (existsSync(target)) {
        unlinkSync(target)
        removed++
      }
    }
    for (const rel of manifest.replaced) {
      const backup = join(backupDir, rel)
      const target = join(mainDir, rel)
      if (existsSync(backup)) {
        copyFileSync(backup, target)
        written++
        continue
      }
      // 备份缺失有两种可能：备份前就被杀（目标没被动过，安全）或备份被人删了（无法还原）。
      // 判据：目标内容是否等于 harmony 源 —— 等于说明它仍是覆盖层内容，绝不能假装干净。
      if (stillOverlaid(rel)) {
        unrecoverable.push(rel)
      }
    }
  } else if (orphans.length > 0) {
    // 没有 manifest 但有生成物残留 ⇒ 状态目录被手工删过。此时被覆盖的 tracked 文件
    // 很可能仍是覆盖层内容，而备份已经没了：只能指名道姓地要求 git restore。
    // 生成物本身不参与这个判断 —— 它们是「待删除的残留」，由下面的兜底清理处理。
    for (const rel of sources.keys()) {
      if (!isGenerated(rel) && stillOverlaid(rel)) {
        unrecoverable.push(rel)
      }
    }
  }
  if (unrecoverable.length > 0) {
    console.error(`✗ ${unrecoverable.length} 个被覆盖的文件仍是覆盖层内容，但备份已丢失，无法逐字节还原：`)
    for (const rel of unrecoverable.sort()) {
      console.error(`    entry/src/main/${rel}  ← 用 git restore 从索引恢复`)
    }
    console.error('  状态目录与残留生成物都保留着（不要当已还原）；git restore 之后再跑一次 restore。')
    return 4
  }
  // 兜底：无论有没有 manifest，登记的生成物都不该留在 main 树里。
  let cleanedOrphans = 0
  for (const rel of GENERATED_PATHS) {
    const target = join(mainDir, rel)
    if (existsSync(target)) {
      unlinkSync(target)
      removed++
      cleanedOrphans++
    }
  }
  if (manifest !== null) {
    rmSync(stateDir, { recursive: true, force: true })
  }
  if (manifest === null && removed === 0) {
    console.log('覆盖层未应用，无需还原')
    console.log('[overlay] applied=false')
    return 0
  }
  console.log(`已还原：删除 ${removed} 个新建文件、写回 ${written} 个备份文件`)
  if (cleanedOrphans > 0) {
    console.log(`  其中 ${cleanedOrphans} 个是无 manifest 的残留生成物（兜底清理）`)
  }
  console.log('[overlay] applied=false')
  return 0
}

function status() {
  const manifest = readManifest()
  // 「残留」只在没有 manifest 时才算数：有 manifest 时这些文件就是覆盖层本体（created），
  // 是构建期的正常形态，不能叫 orphans。
  const orphans = manifest === null ? orphanPaths() : []
  if (manifest === null && orphans.length === 0) {
    console.log('覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）')
    // ASCII marker for scripts (build-harmony.ps1 asserts it; PS reads UTF-8 as GBK).
    console.log('[overlay] applied=false')
    console.log('[overlay] orphans=0')
    return 0
  }
  if (manifest === null) {
    console.log(`覆盖层：状态目录缺失，但仍有 ${orphans.length} 个生成物残留 —— 树处于覆盖形态（按未还原处理）`)
    for (const rel of orphans) {
      console.log(`  orphan ${rel}`)
    }
  } else {
    console.log(
      `覆盖层：已应用（覆盖 ${manifest.replaced.length} / 新建 ${manifest.created.length}，时间 ${manifest.at}` +
        `${manifest.phase ? `，phase ${manifest.phase}` : ''}）`
    )
  }
  // fail-closed：只要树还是覆盖形态就报 applied=true，preflight 会据此拦下源码测试。
  console.log('[overlay] applied=true')
  console.log(`[overlay] orphans=${orphans.length}`)
  console.log('[overlay] fix=node tools/overlay.mjs restore')
  return 0
}

/** 把 `git status --porcelain` 的每一行判成 overlay（构建态）还是 foreign（真·用户改动）。 */
function explain() {
  const manifest = readManifest()
  const owned = new Set()
  const addOwned = p => owned.add(p)
  for (const rel of GENERATED_PATHS) {
    addOwned(relative(repoRoot, join(mainDir, rel)).split('\\').join('/'))
  }
  if (manifest !== null) {
    for (const rel of [...manifest.replaced, ...manifest.created]) {
      addOwned(relative(repoRoot, join(mainDir, rel)).split('\\').join('/'))
    }
  }
  const stateRel = `${relative(repoRoot, stateDir).split('\\').join('/')}/`
  addOwned(stateRel)

  const res = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' })
  if (res.error || res.status !== 0) {
    console.error(`✗ git status --porcelain 失败（${res.error ? res.error.message : `exit ${res.status}`}）`)
    return 2
  }
  const lines = res.stdout.split(/\r?\n/).filter(line => line.trim() !== '')
  const overlayLines = []
  const foreignLines = []
  for (const line of lines) {
    const path = line.slice(3).trim().replace(/^"|"$/g, '')
    const isOverlay = [...owned].some(prefix => path === prefix || path.startsWith(prefix))
    if (isOverlay) {
      overlayLines.push(line)
    } else {
      foreignLines.push(line)
    }
  }
  console.log(`[overlay] porcelain-total=${lines.length}`)
  console.log(`[overlay] porcelain-overlay=${overlayLines.length}`)
  console.log(`[overlay] porcelain-foreign=${foreignLines.length}`)
  for (const line of overlayLines) {
    console.log(`  overlay ${line}`)
  }
  for (const line of foreignLines) {
    console.log(`  foreign ${line}`)
  }
  if (foreignLines.length > 0) {
    console.log('[overlay] verdict=user-edits')
    return 1
  }
  console.log(`[overlay] verdict=${overlayLines.length > 0 ? 'build-in-flight' : 'clean'}`)
  return 0
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (cmd === 'apply') {
    process.exit(apply())
  } else if (cmd === 'restore') {
    process.exit(restore())
  } else if (cmd === 'status') {
    process.exit(status())
  } else if (cmd === 'explain') {
    process.exit(explain())
  } else {
    console.error(`未知命令：${cmd}（只支持 apply / restore / status / explain）`)
    process.exit(2)
  }
}
