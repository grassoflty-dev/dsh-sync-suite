import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, mergePluginManifests, parseVersion } from '../dist/engine/pluginMerge.js'

const entry = (name, version, source = `^${version}`, enabled = true) => ({ name, version, source, enabled })

test('compareVersions：语义化比较（数值段、预发布）', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('^1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2', '1.2.0'), 0)
  assert.deepEqual(parseVersion('1.2.3-rc.1+build'), { numbers: [1, 2, 3], prerelease: ['rc', '1'] })
  assert.equal(parseVersion('not-a-version'), null)
})

test('mergePluginManifests：远端有本地无 → install；本地有远端无 → keep（永不删）', () => {
  const local = [entry('keep-me', '1.0.0'), entry('both', '1.0.0')]
  const remote = [entry('both', '1.0.0'), entry('install-me', '2.0.0')]
  const result = mergePluginManifests(local, remote)
  assert.deepEqual(
    result.install.map((item) => item.name),
    ['install-me'],
  )
  assert.deepEqual(result.keep.map((item) => item.name).sort(), ['both', 'keep-me'])
  assert.deepEqual(result.noDowngrade, [])
  assert.deepEqual(result.skip, [])
})

test('mergePluginManifests：版本更高才升级，本地更高 → noDowngrade，相同 → keep', () => {
  const local = [entry('up', '1.2.0'), entry('down', '3.0.0'), entry('same', '1.0.0')]
  const remote = [entry('up', '1.3.0'), entry('down', '2.9.0'), entry('same', '1.0.0')]
  const result = mergePluginManifests(local, remote)
  assert.deepEqual(
    result.install.map((item) => `${item.name}@${item.version}`),
    ['up@1.3.0'],
  )
  assert.deepEqual(
    result.noDowngrade.map((item) => `${item.name}:${item.localVersion}->${item.remoteVersion}`),
    ['down:3.0.0->2.9.0'],
  )
  assert.deepEqual(result.keep.map((item) => item.name).sort(), ['same'])
  assert.ok(!result.install.some((item) => item.name === 'down'), '绝不降级')
  assert.ok(!result.keep.some((item) => item.name === 'down'), 'noDowngrade 单独成列，不重复进 keep')
})

test('mergePluginManifests：来源不可解析 → skip，不进 install', () => {
  const local = []
  const remote = [
    entry('ok-pkg', '1.0.0', '^1.0.0'),
    entry('bad-source', '1.0.0', '   '),
    entry('bad source with space', '1.0.0', '^1.0.0'),
    entry('UPPER_Case!', '1.0.0', '^1.0.0'),
  ]
  const result = mergePluginManifests(local, remote)
  assert.deepEqual(
    result.install.map((item) => item.name),
    ['ok-pkg'],
  )
  const skipped = result.skip.map((item) => item.name).sort()
  assert.ok(skipped.includes('bad-source'))
  assert.ok(skipped.includes('bad source with space'))
})

test('mergePluginManifests：本地清单里的所有名字都不会消失（MERGE-only）', () => {
  const local = [entry('a', '1.0.0'), entry('b', '2.0.0'), entry('c', '1.0.0', '   ')]
  const remote = [entry('a', '1.1.0'), entry('d', '0.1.0')]
  const result = mergePluginManifests(local, remote)
  const accounted = new Set([
    ...result.install.map((item) => item.name),
    ...result.keep.map((item) => item.name),
    ...result.noDowngrade.map((item) => item.name),
    ...result.skip.map((item) => item.name),
  ])
  for (const item of local) assert.ok(accounted.has(item.name), `本地插件 ${item.name} 必须有归属`)
})

test('mergePluginManifests：重复条目与空输入容错', () => {
  assert.deepEqual(mergePluginManifests([], []), { install: [], keep: [], skip: [], noDowngrade: [] })
  const result = mergePluginManifests([entry('x', '1.0.0'), entry('x', '9.9.9')], [entry('x', '1.5.0')])
  assert.deepEqual(
    result.install.map((item) => item.version),
    ['1.5.0'],
  )
})

test('mergePluginManifests：不可解析版本 → 相同保留、不同 skip（不猜）', () => {
  const result = mergePluginManifests([entry('git-dep', 'github:o/r#main')], [entry('git-dep', 'github:o/r#dev')])
  assert.deepEqual(result.skip.map((item) => item.name), ['git-dep'])
  const same = mergePluginManifests([entry('git-dep', 'github:o/r#main')], [entry('git-dep', 'github:o/r#main')])
  assert.deepEqual(
    same.keep.map((item) => item.name),
    ['git-dep'],
  )
})
