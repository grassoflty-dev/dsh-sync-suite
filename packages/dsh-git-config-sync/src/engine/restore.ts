/**
 * fail-closed 恢复（apply / rollback）。
 *
 * apply 顺序（CONTRACT §2.2）：
 *   1. `confirm !== true` → E_CONFIRM_REQUIRED，一个字节都不写；
 *   2. previewId / sourceDevice / entries 必须是本次预览里 added|changed|manual 的条目；
 *   3. 写前快照到 `%USERPROFILE%\.dsh\vet\restore-snapshots\<timestamp>\`（保留最近 10 份）；
 *   4. 只改 profile 的 cordis.patch.yml：以本地 patch 为底，仅替换勾选条目；先回填本地 secret，
 *      本地没有值 → 该条进 skipped（不写占位符覆盖）；
 *   5. 原子写（temp + rename），写后 SHA-256 校验，不一致 → 用快照回滚并抛 E_SHA_MISMATCH；
 *      返回的每条 applied 带 `fileSha256`（写后整文件）与 `blockSha256`（该条目文本）两个 SHA；
 *   6. 插件清单只写 MERGE-only 计划到 <pendingFile>，不执行 pnpm、不改 profile package.json。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SyncError } from './errors.js'
import { composePatch, findEntryByKey, parsePatch } from './patch.js'
import type { PatchBlock } from './patch.js'
import { sha256Hex } from './paths.js'
import type { StatePaths } from './paths.js'
import type { PluginMergeResult } from './pluginMerge.js'
import type { InternalPreview, InternalPreviewSource, PreviewEntry } from './preview.js'
import { restorePatchSecrets } from './secrets.js'
import type { SnapshotStore } from './snapshot.js'

export interface RpcHooks {
  /** 覆盖默认 SHA-256 校验（测试注入强制失败用）。 */
  verifySha256?: (filePath: string, expected: string) => Promise<boolean>
  /** 覆盖默认原子写（测试可用于干扰写入）。 */
  writeProfileFile?: (filePath: string, content: string) => Promise<void>
}

/**
 * 一条已写入的 patch 条目。
 *
 * 两个 SHA 语义必须分清（审计 P1-2）：
 *   - `fileSha256`：**写后 profile patch 整文件**的 SHA-256。同一次 apply 里同一文件的多条
 *     applied 共享这个值，它就是"落盘文件的校验和"；
 *   - `blockSha256`：该条目**合并后文本块**的 SHA-256（只覆盖这一条 entry 的字节）。
 * 旧字段 `sha256` 只代表单条 block 却被当成文件校验和，语义误导，已删除。
 */
export interface AppliedEntry {
  id: string
  fileSha256: string
  blockSha256: string
  path: string
}

export interface ApplyResult {
  applied: AppliedEntry[]
  skipped: Array<{ id: string; reason: string }>
  snapshotId: string
  verified: true
  pluginPlan?: PluginMergeResult
}

export interface RestoreContext {
  profileDir: string
  paths: StatePaths
  snapshots: SnapshotStore
  hooks?: RpcHooks
  now: () => Date
}

export interface ApplyOptions {
  confirm: unknown
  previewId: string
  sourceDevice: string
  entries: string[]
  preview: InternalPreview
}

export interface RollbackOptions {
  confirm: unknown
  snapshotId: string
}

const PROFILE_PATCH_NAME = 'cordis.patch.yml'

export function assertConfirm(confirm: unknown, action: string): void {
  if (confirm !== true) {
    throw new SyncError('E_CONFIRM_REQUIRED', `${action} 需要确认：请传 confirm: true`, { action })
  }
}

function profilePatchPath(profileDir: string): string {
  return path.join(profileDir, PROFILE_PATCH_NAME)
}

async function readTextIfExists(file: string): Promise<string> {
  if (!existsSync(file)) return ''
  return await readFile(file, 'utf8')
}

/** 默认原子写：同目录临时文件 + rename（Windows 上 rename 覆盖已存在文件是原子的）。 */
async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, file)
  } catch (error) {
    try {
      await rm(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw new SyncError('E_IO', `写入 ${file} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function writeProfileFile(ctx: RestoreContext, file: string, content: string): Promise<void> {
  if (ctx.hooks?.writeProfileFile !== undefined) {
    await ctx.hooks.writeProfileFile(file, content)
    return
  }
  await atomicWrite(file, content)
}

async function verifyFileSha(ctx: RestoreContext, file: string, expected: string): Promise<boolean> {
  if (ctx.hooks?.verifySha256 !== undefined) return await ctx.hooks.verifySha256(file, expected)
  const actual = sha256Hex(await readFile(file, 'utf8'))
  return actual === expected
}

function selectableEntries(source: InternalPreviewSource): Map<string, PreviewEntry> {
  const map = new Map<string, PreviewEntry>()
  for (const entry of source.entries) {
    if (entry.status === 'added' || entry.status === 'changed' || entry.status === 'manual') map.set(entry.id, entry)
  }
  return map
}

export async function applySelected(ctx: RestoreContext, options: ApplyOptions): Promise<ApplyResult> {
  // 第 1 层：确认门禁（先于任何读写）。
  assertConfirm(options.confirm, '执行覆盖')

  const source = options.preview.sources.find((item) => item.deviceId === options.sourceDevice)
  if (source === undefined) {
    throw new SyncError('E_NOT_FOUND', `预览里没有来源设备 ${options.sourceDevice}`, {
      previewId: options.previewId,
      sourceDevice: options.sourceDevice,
      available: options.preview.sources.map((item) => item.deviceId),
    })
  }
  if (!Array.isArray(options.entries) || options.entries.length === 0) {
    throw new SyncError('E_VALIDATION', 'entries 不能为空：请至少勾选一个条目')
  }

  const selectable = selectableEntries(source)
  // 严格按契约：entries 非空且**每一条**都必须是本次预览里 added|changed|manual 的 id。
  // 出现未知 id / 状态为 same 的 id → 整单拒绝（不做部分 skip，避免客户端把 skipped 当部分成功）。
  const rejected: Array<{ id: string; reason: string }> = []
  for (const id of options.entries) {
    if (selectable.has(id)) continue
    const known = source.entries.find((item) => item.id === id)
    rejected.push({
      id,
      reason: known === undefined ? 'not-in-preview' : known.status === 'same' ? 'unchanged' : 'not-applicable',
    })
  }
  if (rejected.length > 0) {
    throw new SyncError('E_VALIDATION', 'entries 必须是本次预览里 added/changed/manual 的条目，请重新预览后重试', {
      previewId: options.previewId,
      sourceDevice: options.sourceDevice,
      rejected,
    })
  }
  const chosen = Array.from(new Set(options.entries))
  const skipped: Array<{ id: string; reason: string }> = []

  const patchFile = profilePatchPath(ctx.profileDir)
  const currentPatch = await readTextIfExists(patchFile)

  // 第 3 层：写前快照。
  const snapshot = ctx.snapshots.create(
    `pre-apply:${source.deviceId}`,
    { [PROFILE_PATCH_NAME]: currentPatch },
    {
      previewId: options.previewId,
      sourceDevice: source.deviceId,
      entries: chosen,
      profileDir: ctx.profileDir,
      createdAt: ctx.now().toISOString(),
    },
  )
  ctx.snapshots.prune(10)

  // 第 4 层：逐条回填 secret 并组合。
  const remoteDoc = parsePatch(source.patchRemote)
  const blocks: PatchBlock[] = []
  // 先按 id 记下"该条目合并后文本"的 SHA-256；整文件 SHA 要等写入并校验后才确定。
  const appliedBlocks: Array<{ id: string; blockSha256: string }> = []

  for (const id of chosen) {
    const remoteEntry = findEntryByKey(remoteDoc, id)
    if (remoteEntry === null) {
      skipped.push({ id, reason: 'not-in-remote' })
      continue
    }
    const localEntry = findEntryByKey(parsePatch(currentPatch), id)
    if (localEntry !== null) {
      const restored = restorePatchSecrets(remoteEntry.raw, localEntry.raw)
      if (restored.needsLocal.length > 0) {
        skipped.push({ id, reason: `needs-local-secret:${restored.needsLocal.join(',')}` })
        continue
      }
      blocks.push({ key: id, raw: restored.text })
      appliedBlocks.push({ id, blockSha256: sha256Hex(restored.text) })
      continue
    }
    // 远端新增条目：若含占位符，本地无从回填 → 跳过，不写占位符覆盖。
    if (remoteEntry.raw.includes('__SECRET__')) {
      skipped.push({ id, reason: 'needs-local-secret' })
      continue
    }
    blocks.push({ key: id, raw: remoteEntry.raw, header: remoteEntry.header })
    appliedBlocks.push({ id, blockSha256: sha256Hex(remoteEntry.raw) })
  }

  if (blocks.length === 0) {
    throw new SyncError('E_VALIDATION', '所选条目都缺少可回填的本地值，未写入任何内容', {
      skipped,
      snapshotId: snapshot.id,
    })
  }

  const nextPatch = composePatch(currentPatch, blocks)
  const expectedSha = sha256Hex(nextPatch)

  // 第 5 层：原子写 + 写后校验，失败用快照回滚。
  await writeProfileFile(ctx, patchFile, nextPatch)
  const verified = await verifyFileSha(ctx, patchFile, expectedSha)
  if (!verified) {
    await writeProfileFile(ctx, patchFile, currentPatch)
    throw new SyncError('E_SHA_MISMATCH', '写入后 SHA-256 校验失败，已用写前快照回滚 profile patch', {
      snapshotId: snapshot.id,
      expected: expectedSha,
      file: patchFile,
    })
  }
  // 校验通过 → 整文件 SHA-256 就是 expectedSha；每条 applied 带上它 + 自己的 block SHA。
  const applied: AppliedEntry[] = appliedBlocks.map((item) => ({
    id: item.id,
    fileSha256: expectedSha,
    blockSha256: item.blockSha256,
    path: patchFile,
  }))

  // 第 6 层：插件清单只落 MERGE-only 计划，不执行 pnpm、不改 package.json。
  const plan: PluginMergeResult = source.plugins
  if (plan.install.length > 0) {
    await mkdir(path.dirname(ctx.paths.pendingFile), { recursive: true, mode: 0o700 })
    const body = {
      generatedAt: ctx.now().toISOString(),
      sourceDevice: source.deviceId,
      previewId: options.previewId,
      note: 'MERGE-only 计划：请用户手动安装；本插件不执行 pnpm，也不修改 profile 的 package.json',
      install: plan.install,
      keep: plan.keep,
      skip: plan.skip,
      noDowngrade: plan.noDowngrade,
    }
    await writeFile(ctx.paths.pendingFile, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    skipped.push({ id: 'plugins', reason: 'manual-install-required' })
  }

  return {
    applied,
    skipped,
    snapshotId: snapshot.id,
    verified: true,
    pluginPlan: plan,
  }
}

export async function rollbackSnapshot(
  ctx: RestoreContext,
  options: RollbackOptions,
): Promise<{ restored: string[]; verified: true }> {
  assertConfirm(options.confirm, '历史回滚')

  const snapshot = ctx.snapshots.get(options.snapshotId)
  if (!(PROFILE_PATCH_NAME in snapshot.files)) {
    throw new SyncError('E_NOT_FOUND', `快照 ${options.snapshotId} 里没有 ${PROFILE_PATCH_NAME}`, {
      snapshotId: options.snapshotId,
    })
  }
  const content = snapshot.files[PROFILE_PATCH_NAME] ?? ''
  const patchFile = profilePatchPath(ctx.profileDir)
  const current = await readTextIfExists(patchFile)

  // 回滚前再存一份，保证回滚本身也可撤销。
  const preRollback = ctx.snapshots.create(
    `pre-rollback:${options.snapshotId}`,
    { [PROFILE_PATCH_NAME]: current },
    { snapshotId: options.snapshotId, profileDir: ctx.profileDir, createdAt: ctx.now().toISOString() },
  )
  ctx.snapshots.prune(10)

  const expected = sha256Hex(content)
  await writeProfileFile(ctx, patchFile, content)
  const verified = await verifyFileSha(ctx, patchFile, expected)
  if (!verified) {
    await writeProfileFile(ctx, patchFile, current)
    throw new SyncError('E_SHA_MISMATCH', '回滚后 SHA-256 校验失败，已还原回滚前内容', {
      snapshotId: options.snapshotId,
      rollbackSafetySnapshot: preRollback.id,
      expected,
      file: patchFile,
    })
  }
  return { restored: [patchFile], verified: true }
}
