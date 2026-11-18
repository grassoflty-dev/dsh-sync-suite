/**
 * 旧配置目录 → dots 目录迁移契约。
 * 全部使用 mkdtemp 临时目录，绝不碰真实 ~/.dsh。
 * dist 由 dotslead 统一重建，本文件只负责断言，不在本地构建产物。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  migrateLegacyStateDir,
  MIGRATION_MARKER_FILE,
  MIGRATION_SKIP_FILE,
  MIGRATION_PENDING_FILE,
  LEGACY_STATE_DIR_NAME,
} from '../dist/engine/paths.js'

async function makeHome(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-dots-mig-'))
  const homeDir = path.join(root, 'home')
  const dsh = path.join(homeDir, '.dsh')
  const legacy = path.join(dsh, LEGACY_STATE_DIR_NAME)
  const target = path.join(dsh, 'dots')
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })
  return { root, homeDir, dsh, legacy, target }
}

const PAYLOADS = {
  'settings.json': '{"deviceId":"pc-a","scope":{}}\n',
  'credentials.json': '{"token":"fake-token-never-real"}\n',
  'state.json': '{"lastSync":"2026-01-01T00:00:00.000Z"}\n',
  'remote.json': '{"enabled":false}\n',
  'remote-token.json': 'fake-remote-token-never-real\n',
  'plugins.to-install.json': '[]\n',
  'unknown-extra.bin': '\u0000\u0001binary-payload\u0002',
}

test('① 旧目录含完整条目 → 新目录全部存在且字节一致，标记文件存在', async (t) => {
  const { homeDir, legacy, target } = await makeHome(t)
  await mkdir(legacy, { recursive: true })
  for (const [name, content] of Object.entries(PAYLOADS)) {
    await writeFile(path.join(legacy, name), content, 'utf8')
  }
  await mkdir(path.join(legacy, 'work'), { recursive: true })
  await writeFile(path.join(legacy, 'work', 'job.json'), '{"job":1}\n', 'utf8')

  const result = migrateLegacyStateDir(homeDir)
  assert.equal(result.status, 'migrated')
  assert.equal(result.moved.length, Object.keys(PAYLOADS).length + 1, '7 个文件 + work/ 目录全部搬动')

  for (const [name, content] of Object.entries(PAYLOADS)) {
    assert.deepEqual(await readFile(path.join(target, name)), Buffer.from(content, 'utf8'), `${name} 字节须一致`)
  }
  assert.ok((await stat(path.join(target, 'work', 'job.json'))).isFile(), 'work/ 子目录须一并搬动')
  assert.equal(await readFile(path.join(target, 'work', 'job.json'), 'utf8'), '{"job":1}\n')

  const markerFile = path.join(target, MIGRATION_MARKER_FILE)
  assert.ok(existsSync(markerFile), '迁移成功后必须写标记')
  const marker = JSON.parse(await readFile(markerFile, 'utf8'))
  assert.ok(marker.from.endsWith(LEGACY_STATE_DIR_NAME))
  assert.ok(marker.to.endsWith('dots'))
  assert.equal(typeof marker.at, 'string')
})

test('② 新目录已存在 → 不覆盖原内容，旧目录不动，写跳过标记', async (t) => {
  const { homeDir, legacy, target } = await makeHome(t)
  await mkdir(target, { recursive: true })
  await mkdir(legacy, { recursive: true })
  await writeFile(path.join(target, 'settings.json'), 'KEEP-ME\n', 'utf8')
  await writeFile(path.join(legacy, 'settings.json'), 'OLD-DATA\n', 'utf8')

  const result = migrateLegacyStateDir(homeDir)
  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'target-exists')
  assert.equal(await readFile(path.join(target, 'settings.json'), 'utf8'), 'KEEP-ME\n', '目标内容不得被覆盖')
  assert.equal(await readFile(path.join(legacy, 'settings.json'), 'utf8'), 'OLD-DATA\n', '旧目录不得被改动')
  assert.ok(existsSync(path.join(target, MIGRATION_SKIP_FILE)))
  assert.ok(!existsSync(path.join(target, MIGRATION_MARKER_FILE)))
})

test('③ 无旧目录 → no-op，且不创建标记', async (t) => {
  const { homeDir, dsh, target } = await makeHome(t)
  await mkdir(dsh, { recursive: true })

  const result = migrateLegacyStateDir(homeDir)
  assert.equal(result.status, 'no-op')
  assert.deepEqual(result.moved, [])
  assert.ok(!existsSync(target), '不得凭空创建目标目录')
  assert.ok(!existsSync(path.join(target, MIGRATION_MARKER_FILE)))
})

test('④ 重复调用幂等：第二次不重复搬动、不覆盖用户后续修改', async (t) => {
  const { homeDir, legacy, target } = await makeHome(t)
  await mkdir(legacy, { recursive: true })
  await writeFile(path.join(legacy, 'settings.json'), PAYLOADS['settings.json'], 'utf8')

  const first = migrateLegacyStateDir(homeDir)
  assert.equal(first.status, 'migrated')

  await writeFile(path.join(target, 'settings.json'), 'USER-EDIT-AFTER-MIGRATION\n', 'utf8')
  const second = migrateLegacyStateDir(homeDir)
  assert.equal(second.status, 'complete')
  assert.deepEqual(second.moved, [])
  assert.equal(await readFile(path.join(target, 'settings.json'), 'utf8'), 'USER-EDIT-AFTER-MIGRATION\n', '不得覆盖')
  assert.ok(existsSync(path.join(target, MIGRATION_MARKER_FILE)))
})

test('⑤ 标记在但目标不全（上次中断）→ 从旧目录补齐并校验，旧数据不丢', async (t) => {
  const { homeDir, legacy, target } = await makeHome(t)
  await mkdir(legacy, { recursive: true })
  await mkdir(target, { recursive: true })

  // 模拟写到一半崩溃：settings/credentials 已在目标，其余仍留在旧目录；标记已存在。
  await writeFile(path.join(target, 'settings.json'), PAYLOADS['settings.json'], 'utf8')
  await writeFile(path.join(target, 'credentials.json'), PAYLOADS['credentials.json'], 'utf8')
  const pending = {
    'state.json': PAYLOADS['state.json'],
    'remote.json': PAYLOADS['remote.json'],
    'remote-token.json': PAYLOADS['remote-token.json'],
  }
  for (const [name, content] of Object.entries(pending)) {
    await writeFile(path.join(legacy, name), content, 'utf8')
  }
  await writeFile(
    path.join(target, MIGRATION_MARKER_FILE),
    JSON.stringify({ from: legacy, to: target, at: '2026-01-01T00:00:00.000Z' }),
    'utf8',
  )

  const result = migrateLegacyStateDir(homeDir)
  assert.equal(result.status, 'repaired', '有标记也不能跳过，必须补齐')
  assert.deepEqual(new Set(result.moved), new Set(Object.keys(pending)))

  for (const name of ['settings.json', 'credentials.json', ...Object.keys(pending)]) {
    assert.equal(await readFile(path.join(target, name), 'utf8'), PAYLOADS[name], `${name} 补齐后字节须一致`)
  }
  assert.deepEqual(await readdir(legacy), [], '旧目录剩余条目已全部搬走，数据没有丢失')
  const marker = JSON.parse(await readFile(path.join(target, MIGRATION_MARKER_FILE), 'utf8'))
  assert.equal(typeof marker.at, 'string')

  const again = migrateLegacyStateDir(homeDir)
  assert.equal(again.status, 'complete', '补齐后再次调用应幂等')
  assert.deepEqual(again.moved, [])
})

test('⑥ 无完成标记但有 pending 标记 + 目标已建且只搬了一半 → 补齐而不是永久 skip（评审 M1）', async (t) => {
  const { homeDir, dsh, legacy, target } = await makeHome(t)
  await mkdir(legacy, { recursive: true })
  await mkdir(target, { recursive: true })

  // 模拟 mkdir 成功、部分 rename 后进程被杀：settings 已搬，token 仍在旧目录；无完成标记。
  await writeFile(path.join(target, 'settings.json'), PAYLOADS['settings.json'], 'utf8')
  const remaining = {
    'credentials.json': PAYLOADS['credentials.json'],
    'remote-token.json': PAYLOADS['remote-token.json'],
    'plugins.to-install.json': PAYLOADS['plugins.to-install.json'],
  }
  for (const [name, content] of Object.entries(remaining)) {
    await writeFile(path.join(legacy, name), content, 'utf8')
  }
  await writeFile(
    path.join(dsh, MIGRATION_PENDING_FILE),
    JSON.stringify({ from: legacy, to: target, at: '2026-01-01T00:00:00.000Z' }),
    'utf8',
  )

  const result = migrateLegacyStateDir(homeDir)
  assert.equal(result.status, 'repaired', 'pending 标记在 → 必须补齐，绝不能因为目标已存在就 skip')
  assert.deepEqual(new Set(result.moved), new Set(Object.keys(remaining)))
  for (const name of ['settings.json', ...Object.keys(remaining)]) {
    assert.equal(await readFile(path.join(target, name), 'utf8'), PAYLOADS[name], `${name} 不得丢失`)
  }
  assert.deepEqual(await readdir(legacy), [], '旧目录清空，token 未丢')
  assert.ok(!existsSync(path.join(dsh, MIGRATION_PENDING_FILE)), '成功后 pending 标记须清理')
  assert.ok(existsSync(path.join(target, MIGRATION_MARKER_FILE)), '成功后须写完成标记')
})

test('⑦ 补齐时目标已有同名条目 → 不覆盖用户数据，也不因旧目录残留而永久失败（评审 M3）', async (t) => {
  const { homeDir, legacy, target } = await makeHome(t)
  await mkdir(legacy, { recursive: true })
  await mkdir(target, { recursive: true })

  await writeFile(path.join(legacy, 'settings.json'), 'OLD-SETTINGS\n', 'utf8')
  await writeFile(path.join(legacy, 'credentials.json'), PAYLOADS['credentials.json'], 'utf8')
  await writeFile(path.join(target, 'settings.json'), 'USER-NEW-SETTINGS\n', 'utf8')
  await writeFile(
    path.join(target, MIGRATION_MARKER_FILE),
    JSON.stringify({ from: legacy, to: target, at: '2026-01-01T00:00:00.000Z' }),
    'utf8',
  )

  const result = migrateLegacyStateDir(homeDir)
  assert.equal(result.status, 'repaired', '同名条目应视为已满足，而不是永久 failed')
  assert.equal(await readFile(path.join(target, 'settings.json'), 'utf8'), 'USER-NEW-SETTINGS\n', '目标内容为权威')
  assert.equal(await readFile(path.join(target, 'credentials.json'), 'utf8'), PAYLOADS['credentials.json'])
  assert.equal(await readFile(path.join(legacy, 'settings.json'), 'utf8'), 'OLD-SETTINGS\n', '旧目录同名条目保留不删')

  const again = migrateLegacyStateDir(homeDir)
  assert.equal(again.status, 'complete', '再次调用应幂等，不再报 legacy-not-empty')
})
