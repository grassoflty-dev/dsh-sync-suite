/**
 * mod-repo-overlay-hygiene — 平台覆盖层（tools/overlay.mjs）的三条纪律。
 *
 * 背景：`entry/src/harmony/**` 是真正入库、真正交付的产品源码；`apply` 会把它复制进
 * `entry/src/main/**` 供 hvigor 编译（entry 的 `sourceRoots` 对 entry 自己无效）。
 * 于是构建期工作区是脏的 —— 本测试钉住三件事：
 *   OH1  apply → status → restore 之后，被触碰的路径必须**逐字节**复原；而且 apply 只许写
 *        manifest 记录过的路径（没有「顺手改一下别的文件」）。
 *   OH2  构建进程在 apply 之后被硬杀（restore 从未执行）时，脏状态必须**可检测**、
 *        并且 restore 必须能把它完全收拾干净。
 *   OH3  中途硬杀（apply 正在复制文件时被 TerminateProcess）也必须能靠 manifest 还原；
 *        连 `.platform-overlay/` 被手工删掉（manifest 丢失）都要能识别残留并清掉。
 *   OH4  覆盖层写出的每条路径必须是「已入库的产品文件」或「已被忽略的生成物」，
 *        且 GENERATED_PATHS 与仓库根 .gitignore 的覆盖层段逐条一致 ——
 *        将来覆盖层新增一条路径却既没入库也没忽略，这里就红。
 *
 * 全部离线：不跑 hvigor、不碰设备、不联网、不写仓库工作树 ——
 * 只在 OS 临时目录里造一棵 scratch 工程（真仓库当作只读输入）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GENERATED_PATHS } from '../overlay.mjs'

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = resolve(toolsDir, '..')
const repoRoot = resolve(appRoot, '..', '..')
const overlayPath = join(toolsDir, 'overlay.mjs')
const gitignorePath = join(repoRoot, '.gitignore')

// --- 小工具 ---------------------------------------------------------------

/** 递归列出目录下所有文件（相对 base 的 POSIX 路径）；目录不存在时返回空。 */
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

/** 整棵树的 rel → sha256 快照；skipPrefix 用来把构建状态目录排除在外。 */
function snapshot(root, skipPrefix = '.platform-overlay') {
  const out = new Map()
  for (const rel of walk(root)) {
    if (rel === skipPrefix || rel.startsWith(`${skipPrefix}/`)) {
      continue
    }
    out.set(rel, createHash('sha256').update(readFileSync(join(root, rel))).digest('hex'))
  }
  return out
}

function diffSnapshots(before, after) {
  const added = []
  const changed = []
  for (const [rel, hash] of after) {
    if (!before.has(rel)) {
      added.push(rel)
    } else if (before.get(rel) !== hash) {
      changed.push(rel)
    }
  }
  const removed = [...before.keys()].filter(rel => !after.has(rel))
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() }
}

/** 覆盖层会「覆盖」（而非新建）的相对路径集合：源里有、main 里已存在的那些。 */
function replacedRelPaths() {
  const sources = new Set(walk(join(appRoot, 'entry/src/harmony')))
  for (const rel of walk(join(appRoot, 'entry/src/harmony-debug'))) {
    sources.add(rel)
  }
  return [...sources].filter(rel => existsSync(join(appRoot, 'entry/src/main', rel))).sort()
}

/**
 * 造一棵最小 scratch 工程：真仓库的 harmony / harmony-debug 源、会被覆盖的 main 文件、
 * 以及一份真的 overlay.mjs。真仓库全程只读。
 */
function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-guard-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  copyFileSync(overlayPath, join(dir, 'tools', 'overlay.mjs'))
  for (const rel of walk(join(appRoot, 'entry/src/harmony'))) {
    copyInto(dir, 'entry/src/harmony', rel)
  }
  for (const rel of walk(join(appRoot, 'entry/src/harmony-debug'))) {
    copyInto(dir, 'entry/src/harmony-debug', rel)
  }
  for (const rel of replacedRelPaths()) {
    copyInto(dir, 'entry/src/main', rel)
  }
  // 一个与覆盖层无关的文件：用来证明还原不会误删/误改别的东西。
  const unrelated = join(dir, 'entry/src/main/ets/unrelated.ts')
  mkdirSync(dirname(unrelated), { recursive: true })
  writeFileSync(unrelated, '// unrelated\n')
  return dir
}

function copyInto(dir, prefix, rel) {
  const to = join(dir, prefix, rel)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(appRoot, prefix, rel), to)
}

/** 跑 scratch 里的 overlay CLI，返回 { code, out }。 */
function overlay(dir, ...args) {
  const res = spawnSync(process.execPath, [join(dir, 'tools', 'overlay.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, '.platform-overlay/manifest.json'), 'utf8'))
}

/** 只读地问真仓库的 git 索引/忽略规则（不写、不联网）。 */
function gitStatus(args) {
  return spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })
}

function repoRel(rel) {
  return relative(repoRoot, join(appRoot, 'entry/src/main', rel)).split('\\').join('/')
}

/** apply → 断言 → restore → 断言「整棵 scratch 树逐字节回到 before」。 */
function assertCycle(mode) {
  const dir = makeScratch()
  try {
    const before = snapshot(dir)
    const applied = overlay(dir, 'apply', mode)
    assert.equal(applied.code, 0, `apply(${mode}) 必须成功：${applied.out}`)
    assert.match(applied.out, /\[overlay\] applied=true/)
    assert.equal(existsSync(join(dir, '.platform-overlay/manifest.json')), true, 'apply 必须留下 manifest')

    const manifest = readManifest(dir)
    assert.equal(manifest.phase, 'applied')
    assert.equal(manifest.mode, mode)

    // apply 只许写 manifest 记录过的路径：新增 == created，改动 == replaced，绝不删东西。
    const delta = diffSnapshots(before, snapshot(dir))
    assert.deepEqual(delta.added, manifest.created.map(rel => `entry/src/main/${rel}`).sort(), '新增文件必须与 created 清单一致')
    assert.deepEqual(delta.changed, manifest.replaced.map(rel => `entry/src/main/${rel}`).sort(), '被改文件必须与 replaced 清单一致')
    assert.deepEqual(delta.removed, [], 'apply 不允许删除任何文件')
    for (const rel of manifest.created) {
      assert.equal(
        readFileSync(join(dir, 'entry/src/main', rel), 'utf8'),
        readFileSync(join(dir, 'entry/src', existsSync(join(dir, 'entry/src/harmony', rel)) ? 'harmony' : 'harmony-debug', rel), 'utf8'),
        `生成物 ${rel} 必须是源文件的逐字节拷贝`
      )
    }

    // 重复 apply 必须硬失败（并发构建会编出缺页的 HAP），且不能再动树。
    const again = overlay(dir, 'apply', mode)
    assert.equal(again.code, 1, '已有 manifest 时 apply 必须硬失败')
    assert.match(again.out, /覆盖层已被应用/)
    assert.deepEqual(diffSnapshots(before, snapshot(dir)), delta, '第二次 apply 不得改动树')

    const statusApplied = overlay(dir, 'status')
    assert.match(statusApplied.out, /\[overlay\] applied=true/)
    assert.match(statusApplied.out, /\[overlay\] orphans=0/)

    const restored = overlay(dir, 'restore')
    assert.equal(restored.code, 0, `restore 必须成功：${restored.out}`)
    assert.match(restored.out, /\[overlay\] applied=false/)
    assert.deepEqual([...snapshot(dir)], [...before], 'restore 之后必须逐字节复原')
    assert.equal(existsSync(join(dir, '.platform-overlay')), false, 'restore 必须删掉状态目录')

    const statusClean = overlay(dir, 'status')
    assert.match(statusClean.out, /\[overlay\] applied=false/)
    assert.match(statusClean.out, /\[overlay\] orphans=0/)
    assert.match(statusClean.out, /未应用/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- OH1：apply → status → restore 逐字节复原 ------------------------------

test('OH1: apply → status → restore 逐字节复原（release 与 debug 两种模式）', () => {
  assertCycle('release')
  assertCycle('debug')
})

test('OH1b: apply 只读地跑真仓库的 harmony 源；真仓库工作树不被本测试触碰', () => {
  const touched = [...replacedRelPaths(), ...GENERATED_PATHS].map(rel => join(appRoot, 'entry/src/main', rel))
  const before = touched.map(p => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'missing'))
  const dir = makeScratch()
  try {
    assert.equal(overlay(dir, 'apply', 'debug').code, 0)
    assert.equal(overlay(dir, 'restore').code, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const after = touched.map(p => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'missing'))
  assert.deepEqual(after, before, '真仓库 entry/src/main 必须保持原样（生成物不得留在里面）')
})

// --- OH2：apply 之后被硬杀（restore 从未执行） ------------------------------

test('OH2: apply 之后进程被硬杀 → 脏状态可检测，restore 能完全收拾干净', async t => {
  const dir = makeScratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // 用一个「apply 完就 exit 7」的壳进程模拟 build-harmony 在 apply 之后被硬杀：
  // 没有 trap / finally / 退出钩子会跑，剩下的只能是磁盘上的 manifest + 覆盖层文件。
  writeFileSync(
    join(dir, 'tools/killed-build.mjs'),
    [
      "import { spawnSync } from 'node:child_process'",
      "import { fileURLToPath } from 'node:url'",
      "const r = spawnSync(process.execPath, [fileURLToPath(new URL('./overlay.mjs', import.meta.url)), 'apply', 'debug'], { stdio: 'inherit' })",
      'process.exit(7)',
      '',
    ].join('\n')
  )
  const before = snapshot(dir)
  const shell = spawnSync(process.execPath, [join(dir, 'tools/killed-build.mjs')], { cwd: dir, encoding: 'utf8' })
  assert.equal(shell.status, 7, '壳进程必须以 7 退出（= 构建在 apply 之后死掉）')

  // (1) 可检测：status 明确说 applied=true，且磁盘上的脏是真的。
  const dirty = overlay(dir, 'status')
  assert.match(dirty.out, /\[overlay\] applied=true/, '被硬杀后 status 必须报 applied=true')
  assert.match(dirty.out, /\[overlay\] fix=node tools\/overlay\.mjs restore/)
  const dirtyDelta = diffSnapshots(before, snapshot(dir))
  assert.ok(dirtyDelta.added.length > 0 && dirtyDelta.changed.length > 0, '被杀之后树确实是脏的（生成物 + 被覆盖文件）')

  // (2) 可还原：restore 之后逐字节复原，并且状态回到 applied=false。
  const restored = overlay(dir, 'restore')
  assert.equal(restored.code, 0, restored.out)
  assert.deepEqual([...snapshot(dir)], [...before], '硬杀之后的 restore 必须逐字节复原')
  assert.match(overlay(dir, 'status').out, /\[overlay\] applied=false/)
})

// --- OH3：中途硬杀 + 状态目录丢失 -----------------------------------------

test('OH3: apply 复制途中被 TerminateProcess 也必须靠 manifest 还原', async t => {
  for (const delayMs of [0, 1, 3, 8, 20]) {
    const dir = makeScratch()
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const before = snapshot(dir)
    const manifestPath = join(dir, '.platform-overlay/manifest.json')

    const child = spawn(process.execPath, [join(dir, 'tools', 'overlay.mjs'), 'apply', 'debug'], { cwd: dir, stdio: 'ignore' })
    const deadline = Date.now() + 5000
    // 先等 manifest 落盘（apply 会先写 journal 再复制），再等一会儿，然后在任意时刻杀掉。
    while (!existsSync(manifestPath) && Date.now() < deadline) {
      // busy wait：manifest 一出现就进入「复制中」的窗口
    }
    const spinUntil = Date.now() + delayMs
    while (Date.now() < spinUntil) {
      // 采样不同的中断点
    }
    child.kill()
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolveExit => child.once('exit', resolveExit))
    }

    // 关键性质：不管杀在哪一刻，restore 之后都必须逐字节复原。
    const restored = overlay(dir, 'restore')
    assert.equal(restored.code, 0, `delay=${delayMs}ms 的 restore 必须成功：${restored.out}`)
    assert.deepEqual([...snapshot(dir)], [...before], `delay=${delayMs}ms：中途硬杀后 restore 必须逐字节复原`)
    assert.match(overlay(dir, 'status').out, /\[overlay\] applied=false/, `delay=${delayMs}ms：状态必须回到 applied=false`)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OH3b: 状态目录被手工删掉（manifest 丢失）→ status 仍报 applied=true，restore 拒绝假装干净', t => {
  const dir = makeScratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const before = snapshot(dir)
  assert.equal(overlay(dir, 'apply', 'debug').code, 0)
  rmSync(join(dir, '.platform-overlay'), { recursive: true, force: true })

  // 没有 manifest 也要 fail-closed：树还是覆盖形态，就不能让源码测试以为是干净的。
  const status = overlay(dir, 'status')
  assert.match(status.out, /\[overlay\] applied=true/, '残留生成物必须让 status 报 applied=true')
  assert.match(status.out, new RegExp(`\\[overlay\\] orphans=${GENERATED_PATHS.length}`))
  for (const rel of GENERATED_PATHS) {
    assert.ok(status.out.includes(`orphan ${rel}`), `status 必须逐个点名残留：${rel}`)
  }

  // 1) 备份没了、被覆盖文件仍是覆盖层内容 ⇒ 硬失败并指名 git restore，一个文件都不删。
  const stuck = overlay(dir, 'restore')
  assert.equal(stuck.code, 4, `备份丢失且内容仍是覆盖层时必须 exit 4：${stuck.out}`)
  assert.match(stuck.out, /备份已丢失/)
  assert.match(stuck.out, /git restore/)
  assert.match(stuck.out, /resources\/base\/profile\/main_pages\.json/)
  for (const rel of GENERATED_PATHS) {
    assert.ok(existsSync(join(dir, 'entry/src/main', rel)), '硬失败时不得删除残留生成物（不许假装干净）')
  }

  // 2) 模拟 Lead 执行 git restore：scratch 里就是把 entry/src/main 的原版拷回来。
  for (const rel of replacedRelPaths()) {
    copyFileSync(join(appRoot, 'entry/src/main', rel), join(dir, 'entry/src/main', rel))
  }
  // 生成物还在，所以状态仍然是 applied=true（fail-closed，不由恢复动作自己宣布干净）。
  assert.match(overlay(dir, 'status').out, /\[overlay\] applied=true/)

  // 3) 再跑一次 restore：这次只需清掉残留生成物。
  const restored = overlay(dir, 'restore')
  assert.equal(restored.code, 0, restored.out)
  assert.match(restored.out, /\[overlay\] applied=false/)
  assert.deepEqual([...snapshot(dir)], [...before], 'git restore 之后 restore 必须能逐字节复原')
})

// --- OH4：每条覆盖层输出路径必须「已入库」或「已被忽略」 --------------------

test('OH4: 覆盖层写出的每条路径都已入库或被忽略；GENERATED_PATHS 与 .gitignore 一致', t => {
  const dir = makeScratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(overlay(dir, 'apply', 'debug').code, 0)
  const manifest = readManifest(dir)

  for (const rel of [...manifest.replaced, ...manifest.created]) {
    const path = repoRel(rel)
    const tracked = gitStatus(['ls-files', '--error-unmatch', '--', path])
    assert.equal(tracked.error, undefined, 'git 不可用，无法核对入库状态')
    const isTracked = tracked.status === 0
    const isIgnored = gitStatus(['check-ignore', '-q', '--', path]).status === 0
    assert.ok(
      isTracked || isIgnored,
      `${path} 既不在 git 索引里、也没被 .gitignore 忽略 —— 构建会把它变成「看起来像用户改动」的脏文件`
    )
    assert.equal(isTracked && isIgnored, false, `${path} 不能同时既入库又被忽略`)
  }

  // 被覆盖的必须都是入库文件（产品的一部分）；生成物必须是忽略规则覆盖的临时拷贝。
  for (const rel of manifest.replaced) {
    assert.equal(gitStatus(['ls-files', '--error-unmatch', '--', repoRel(rel)]).status, 0, `被覆盖的 ${rel} 必须在索引里`)
  }
  for (const rel of GENERATED_PATHS) {
    assert.equal(gitStatus(['check-ignore', '-q', '--', repoRel(rel)]).status, 0, `生成物 ${rel} 必须被 .gitignore 忽略`)
  }
  assert.deepEqual(
    [...manifest.created].sort(),
    [...GENERATED_PATHS].sort(),
    'debug 模式下的新建集合必须与 GENERATED_PATHS 完全一致；新增生成路径请同时登记两边'
  )

  // .gitignore 的覆盖层段必须与 GENERATED_PATHS 逐条一致（既不漏也不多）。
  const declared = readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('apps/arkui-schedule/entry/src/main/'))
    .sort()
  assert.deepEqual(
    declared,
    GENERATED_PATHS.map(rel => `apps/arkui-schedule/entry/src/main/${rel}`).sort(),
    '.gitignore 的覆盖层段必须与 tools/overlay.mjs 的 GENERATED_PATHS 逐条一致'
  )
})

test('OH4b: 覆盖层要新建一条未登记路径时必须硬失败，并且一个文件都不动', t => {
  const dir = makeScratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const rogue = join(dir, 'entry/src/harmony/ets/pages/Undeclared.ets')
  writeFileSync(rogue, '// a future overlay path that nobody declared\n')
  const before = snapshot(dir)

  const applied = overlay(dir, 'apply', 'debug')
  assert.equal(applied.code, 5, `未登记的新建路径必须 exit 5：${applied.out}`)
  assert.match(applied.out, /未登记的路径/)
  assert.match(applied.out, /GENERATED_PATHS/)
  assert.match(applied.out, /\.gitignore/)
  assert.deepEqual([...snapshot(dir)], [...before], '硬失败必须发生在动任何文件之前（无 manifest、无拷贝）')
  assert.equal(existsSync(join(dir, '.platform-overlay')), false, '硬失败不得留下状态目录')
})
