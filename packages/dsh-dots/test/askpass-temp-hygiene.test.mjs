/**
 * mod-plugin-askpass-temp-hygiene 验收（Node，全部离线，**不碰真实 `%TEMP%`**）。
 *
 * 被测对象：`dist/engine/askpassTemp.js` 的 `sweepStaleAskpassDirs()` /
 * `askpassStartupSweepPlan()` / `sweepAskpassDirsAtStartup()`。
 *
 * 纪律：本文件里**每一次删除都发生在 `.tmp/` 下的夹具目录**，绝不针对 `os.tmpdir()` 的真
 * 实内容；需要"删除失败"的场景用注入的 `removeImpl` 模拟，不去改真实条目的权限。
 *
 * 覆盖（用例名见各 test()）：
 *   A0  常量契约（前缀 / 1 小时阈值）
 *   A1  超龄目录被删除
 *   A2  新鲜目录被保留
 *   A3  别的前缀 / 普通文件 / 外来目录一律不动
 *   A4  mtime 刚被 touch 的目录被保留（模拟活着的 git 子进程）
 *   A5  junction / symlink 被跳过（Windows 用 junction；其它平台用目录符号链接）
 *   A6  干跑不删任何东西，只报 wouldRemove
 *   A7  `{scanned,removed,failed}` 计数精确
 *   A8  目录不存在 → 零工作量（不 mkdir、不探测）
 *   A9  删除失败静默但计数（不 throw）
 *   A10 启动计划：env 开关 + 测试进程保护
 *   A11 插件接线：`apply()` 里确实调了启动清理（静态钉子，防被删掉）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ASKPASS_SWEEP_ENV,
  ASKPASS_TEMP_MAX_AGE_MS,
  ASKPASS_TEMP_PREFIX,
  askpassStartupSweepPlan,
  sweepAskpassDirsAtStartup,
  sweepStaleAskpassDirs,
} from '../dist/engine/askpassTemp.js'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 夹具父目录：`.tmp/`（测试里所有删除只发生在这里面的子目录）。 */
const FIXTURE_PARENT = path.join(PKG_DIR, '.tmp')
const HOUR = 60 * 60 * 1000

/** 建一个独立夹具世界（`.tmp/hb-askpass-sweep-XXXXXX`），用例结束只删这一个自己建的目录。 */
async function makeWorld(t) {
  await mkdir(FIXTURE_PARENT, { recursive: true })
  const world = await mkdtemp(path.join(FIXTURE_PARENT, 'hb-askpass-sweep-'))
  t.after(async () => {
    await rm(world, { recursive: true, force: true }).catch(() => undefined)
  })
  return world
}

/** 在夹具里建一个目录（可选把 mtime 设成"多少毫秒之前"）。 */
async function makeDir(world, name, ageMs) {
  const full = path.join(world, name)
  await mkdir(full, { recursive: true })
  if (typeof ageMs === 'number') {
    const when = new Date(Date.now() - ageMs)
    await utimes(full, when, when)
  }
  return full
}

/** 在夹具里建一个普通文件（可选设 mtime）。 */
async function makeFile(world, name, ageMs) {
  const full = path.join(world, name)
  await writeFile(full, 'fixture\n', 'utf8')
  if (typeof ageMs === 'number') {
    const when = new Date(Date.now() - ageMs)
    await utimes(full, when, when)
  }
  return full
}

test('A0 常量契约：前缀与 1 小时阈值（阈值必须大于任何一次 git 调用）', () => {
  assert.equal(ASKPASS_TEMP_PREFIX, 'dsh-gcs-askpass-', '前缀必须与 engine/git.ts 的 mkdtemp 前缀一致')
  assert.equal(ASKPASS_TEMP_MAX_AGE_MS, 3_600_000, '阈值固定 1 小时')
  assert.ok(ASKPASS_TEMP_MAX_AGE_MS > 120_000 * 4, '阈值必须远大于 push 预算 120 s 与全部重试')
  assert.equal(ASKPASS_SWEEP_ENV, 'DSH_DOTS_ASKPASS_SWEEP')
})

test('A1 超龄目录被删除', async (t) => {
  const world = await makeWorld(t)
  const stale = await makeDir(world, `${ASKPASS_TEMP_PREFIX}stale-a`, 2 * HOUR)
  const result = await sweepStaleAskpassDirs({ tmpDir: world })
  assert.deepEqual(
    { scanned: result.scanned, removed: result.removed, failed: result.failed, wouldRemove: result.wouldRemove },
    { scanned: 1, removed: 1, failed: 0, wouldRemove: 1 },
  )
  assert.equal(existsSync(stale), false, '超龄目录必须被删掉')
  assert.equal(result.dryRun, false)
})

test('A2 新鲜目录被保留（未到阈值）', async (t) => {
  const world = await makeWorld(t)
  const fresh = await makeDir(world, `${ASKPASS_TEMP_PREFIX}fresh-a`, 10 * 60 * 1000)
  const result = await sweepStaleAskpassDirs({ tmpDir: world })
  assert.equal(result.scanned, 1)
  assert.equal(result.wouldRemove, 0)
  assert.equal(result.removed, 0)
  assert.equal(existsSync(fresh), true, '10 分钟前的目录绝不许删（阈值 1 小时）')
})

test('A3 别的前缀 / 普通文件 / 外来目录一律不动', async (t) => {
  const world = await makeWorld(t)
  const ours = await makeDir(world, `${ASKPASS_TEMP_PREFIX}ours-a`, 3 * HOUR)
  const foreignPrefix = await makeDir(world, `hb-foreign-${ASKPASS_TEMP_PREFIX}1`, 3 * HOUR)
  const otherPrefix = await makeDir(world, 'dsh-gcs-token-abc', 3 * HOUR)
  const plainInTemp = await makeFile(world, 'askpass.cmd', 3 * HOUR)
  const notes = await makeFile(world, 'demo-notes.txt', 3 * HOUR)

  const result = await sweepStaleAskpassDirs({ tmpDir: world })
  assert.equal(result.scanned, 1, '只有自家前缀的目录进入统计')
  assert.equal(result.removed, 1)
  assert.equal(result.failed, 0)
  assert.equal(existsSync(ours), false)
  for (const [name, full] of [['外来前缀目录', foreignPrefix], ['其它前缀目录', otherPrefix], ['%TEMP% 普通文件', plainInTemp], ['无关文件', notes]]) {
    assert.equal(existsSync(full), true, `${name} 必须原样保留`)
  }
  const left = readdirSync(world).sort()
  assert.deepEqual(left, [`hb-foreign-${ASKPASS_TEMP_PREFIX}1`, 'demo-notes.txt', 'askpass.cmd', 'dsh-gcs-token-abc'].sort())
})

test('A4 mtime 刚被 touch 的目录被保留（模拟活着的 git 子进程）', async (t) => {
  const world = await makeWorld(t)
  const live = await makeDir(world, `${ASKPASS_TEMP_PREFIX}live-a`, 0)
  const result = await sweepStaleAskpassDirs({ tmpDir: world })
  assert.equal(result.scanned, 1)
  assert.equal(result.removed, 0)
  assert.equal(result.wouldRemove, 0)
  assert.equal(existsSync(live), true, '刚被写过 mtime 的目录必须保留')
})

test('A5 不跟随链接：junction / symlink 被跳过', async (t) => {
  const world = await makeWorld(t)
  const target = await makeDir(world, 'hb-link-target', 3 * HOUR)
  const keep = await makeFile(target, 'keep.txt', 3 * HOUR)
  const link = path.join(world, `${ASKPASS_TEMP_PREFIX}link-a`)
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`本平台无法创建目录链接，跳过：${error && error.code ? error.code : String(error)}`)
    return
  }
  const result = await sweepStaleAskpassDirs({ tmpDir: world })
  assert.equal(result.scanned, 1, '链接本身计入 scanned')
  assert.equal(result.removed, 0, '链接一律跳过，绝不许顺着它删')
  assert.equal(result.failed, 0)
  assert.equal(existsSync(link), true)
  assert.equal(existsSync(target), true, '链接指向的目录必须完好')
  assert.equal(existsSync(keep), true, '链接目录里的文件必须完好')
})

test('A6 干跑：一个都不删，只报 wouldRemove', async (t) => {
  const world = await makeWorld(t)
  const stale = await makeDir(world, `${ASKPASS_TEMP_PREFIX}stale-dry`, 2 * HOUR)
  const fresh = await makeDir(world, `${ASKPASS_TEMP_PREFIX}fresh-dry`, 1000)
  const dry = await sweepStaleAskpassDirs({ tmpDir: world, dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.scanned, 2)
  assert.equal(dry.removed, 0, '干跑 removed 恒为 0')
  assert.equal(dry.wouldRemove, 1)
  assert.equal(dry.failed, 0)
  assert.equal(existsSync(stale), true, '干跑绝不许删除')
  assert.equal(existsSync(fresh), true)

  const live = await sweepStaleAskpassDirs({ tmpDir: world })
  assert.equal(live.removed, 1)
  assert.equal(existsSync(stale), false)
  assert.equal(existsSync(fresh), true)
})

test('A7 计数精确：scanned / removed / failed / wouldRemove 逐字符合', async (t) => {
  const world = await makeWorld(t)
  const oldA = await makeDir(world, `${ASKPASS_TEMP_PREFIX}old-a`, 2 * HOUR)
  const oldB = await makeDir(world, `${ASKPASS_TEMP_PREFIX}old-b`, 5 * HOUR)
  const fresh = await makeDir(world, `${ASKPASS_TEMP_PREFIX}fresh-c`, 60 * 1000)
  const prefixFile = await makeFile(world, `${ASKPASS_TEMP_PREFIX}not-a-dir`, 3 * HOUR)
  const foreign = await makeDir(world, 'hb-other-dir', 3 * HOUR)

  const result = await sweepStaleAskpassDirs({ tmpDir: world })
  assert.deepEqual(
    {
      scanned: result.scanned,
      removed: result.removed,
      failed: result.failed,
      wouldRemove: result.wouldRemove,
      dryRun: result.dryRun,
    },
    { scanned: 4, removed: 2, failed: 0, wouldRemove: 2, dryRun: false },
  )
  assert.equal(existsSync(oldA), false)
  assert.equal(existsSync(oldB), false)
  assert.equal(existsSync(fresh), true, '新鲜目录保留')
  assert.equal(existsSync(prefixFile), true, '同前缀的普通文件不是目录，必须保留')
  assert.equal(existsSync(foreign), true)
  const oldest = result.oldestMtimeMs ?? 0
  const newest = result.newestMtimeMs ?? 0
  assert.ok(Date.now() - oldest > 4 * HOUR, 'oldest 应指向最旧的那个目录')
  assert.ok(Date.now() - newest < 10 * 60 * 1000, 'newest 应指向最新的那个目录')
})

test('A8 目录不存在：零工作量，不 mkdir 也不探测', async (t) => {
  const world = await makeWorld(t)
  const missing = path.join(world, 'hb-missing-temp')
  const result = await sweepStaleAskpassDirs({ tmpDir: missing })
  assert.deepEqual(
    { scanned: result.scanned, removed: result.removed, failed: result.failed, wouldRemove: result.wouldRemove },
    { scanned: 0, removed: 0, failed: 0, wouldRemove: 0 },
  )
  assert.equal(result.oldestMtimeMs, null)
  assert.equal(result.newestMtimeMs, null)
  assert.equal(existsSync(missing), false, '不许因为清理而创建目录')
})

test('A9 删除失败：静默计数，不 throw', async (t) => {
  const world = await makeWorld(t)
  const good = await makeDir(world, `${ASKPASS_TEMP_PREFIX}good-a`, 2 * HOUR)
  const bad = await makeDir(world, `${ASKPASS_TEMP_PREFIX}bad-a`, 2 * HOUR)
  const result = await sweepStaleAskpassDirs({
    tmpDir: world,
    removeImpl: async (target) => {
      if (path.basename(target).endsWith('bad-a')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      await rm(target, { recursive: true, force: true })
    },
  })
  assert.equal(result.scanned, 2)
  assert.equal(result.removed, 1)
  assert.equal(result.failed, 1, '删不掉的条目必须进 failed 计数')
  assert.equal(existsSync(good), false)
  assert.equal(existsSync(bad), true, '失败的那一个保持原样')
})

test('A10 启动计划：env 开关（dry / off）与测试进程保护', () => {
  assert.equal(askpassStartupSweepPlan({}), 'live', '缺省就是真删')
  assert.equal(askpassStartupSweepPlan({ [ASKPASS_SWEEP_ENV]: 'dry' }), 'dry')
  assert.equal(askpassStartupSweepPlan({ [ASKPASS_SWEEP_ENV]: ' DRY ' }), 'dry', '大小写与空白不影响')
  for (const off of ['off', '0', 'false', 'no', 'OFF']) {
    assert.equal(askpassStartupSweepPlan({ [ASKPASS_SWEEP_ENV]: off }), 'skip', `${off} 必须关闭清理`)
  }
  assert.equal(askpassStartupSweepPlan({ NODE_TEST_CONTEXT: 'child-v8' }), 'skip', '测试进程一律跳过')
  assert.equal(
    askpassStartupSweepPlan({ NODE_TEST_CONTEXT: 'child-v8', [ASKPASS_SWEEP_ENV]: 'dry' }),
    'skip',
    '测试进程保护优先于 dry',
  )
})

test('A11 sweepAskpassDirsAtStartup：跳过时全 0 且 dryRun=true（不动真实 %TEMP%）', async () => {
  const skipped = await sweepAskpassDirsAtStartup({ NODE_TEST_CONTEXT: 'child-v8' })
  assert.deepEqual(
    { scanned: skipped.scanned, removed: skipped.removed, failed: skipped.failed, wouldRemove: skipped.wouldRemove },
    { scanned: 0, removed: 0, failed: 0, wouldRemove: 0 },
  )
  assert.equal(skipped.dryRun, true)
  const off = await sweepAskpassDirsAtStartup({ [ASKPASS_SWEEP_ENV]: 'off' })
  assert.equal(off.removed, 0)
})

test('A12 本进程（node --test）里插件启动清理必须是 skip：既有套件不会删真实 %TEMP%', () => {
  assert.equal(askpassStartupSweepPlan(process.env), 'skip', '整套测试的进程里必须是 skip')
})

test('A13 插件接线：apply() 里确实调了启动清理（防被静默删掉）', async () => {
  const compiled = await readFileSync(path.join(PKG_DIR, 'dist', 'index.js'), 'utf8')
  assert.match(compiled, /sweepAskpassDirsAtStartup/, 'dist/index.js 必须引用启动清理')
  assert.match(compiled, /askpass temp sweep/, 'ctx.effect 的标签必须点名这次清理')
  const effectCount = (compiled.match(/ctx\.effect\(/g) ?? []).length
  assert.equal(effectCount, 5, 'effect 数量契约不变（新增清理复用既有 effect，不新开）')
})
