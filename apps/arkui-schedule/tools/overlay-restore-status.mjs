#!/usr/bin/env node
/**
 * mod-build-restore-timeout：从 `node tools/overlay.mjs status` 的输出判断"还需不需要还原"。
 *
 * 这是给 overlay-restore.ps1 用的纯函数（零依赖，只认 ASCII 标记）：
 *   - classifyStatus(text) -> 'applied' | 'not-applied' | 'unknown'
 *   - needsRestore(text)   -> applied / unknown 都返回 true（unknown 走 fail-closed：
 *     宁可再跑一次幂等的 restore，也不把读不懂的状态当成"已经干净"）
 *
 * 为什么单独放一个 .mjs：PowerShell 侧和 Node 测试侧必须共用同一份判据，
 * 否则"wrapper 认为已还原 / 测试认为未还原"会因为两份正则漂移而悄悄分叉。
 * 作为 CLI 运行时：`node overlay-restore-status.mjs --needs-restore` 从 stdin 读状态文本，
 * 输出 yes/no 单个词，供 wrapper 直接消费。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 把 status 输出归类；applied=true 优先，防止同一段文本里两种标记并存时漏还原。 */
export function classifyStatus(statusText) {
  if (typeof statusText !== 'string') return 'unknown'
  if (/(^|\s)applied=true(\s|$)/.test(statusText)) return 'applied'
  if (/(^|\s)applied=false(\s|$)/.test(statusText)) return 'not-applied'
  return 'unknown'
}

/** "restore needed?" 的唯一判据：只有明确 applied=false 才跳过；未知状态 fail-closed。 */
export function needsRestore(statusText) {
  return classifyStatus(statusText) !== 'not-applied'
}

/** 断言还原后的状态：必须是明确的 applied=false，空串 / 报错 / applied=true 都不算。 */
export function isRestored(statusText) {
  return classifyStatus(statusText) === 'not-applied'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = readFileSync(0, 'utf8')
  process.stdout.write(needsRestore(text) ? 'yes\n' : 'no\n')
}
