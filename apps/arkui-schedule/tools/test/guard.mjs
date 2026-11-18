/**
 * 测试入口守卫：**overlay 生效时直接硬失败**，不许跳过、不许自动 restore。
 *
 * 为什么是 hard fail 而不是 skip：
 * `build-harmony.ps1` 构建期会 `overlay apply`，把 `entry/src/harmony/**` 覆盖进
 * `entry/src/main/**`。这时所有"扫源码文本"的断言（色值门闸、platform 装配、
 * Settings 结构断言…）扫到的都是**被覆盖过的树**，结论无意义。
 * skip 会给出「1943 例绿 + 若干 skip」的假绿——最关键的静态门闸一个没跑却报万事大吉，
 * 那比误报危险得多。所以这里选择 `process.exit(1)`：让红灯说话。
 *
 * 也不做"自动 restore 后继续跑"：测试擅自改工作区状态，比报错危险得多。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '.platform-overlay')
const MANIFEST = join(STATE_DIR, 'manifest.json')

/**
 * overlay 是否处于 applied 状态。
 * `.platform-overlay/manifest.json` 只在 apply 期间存在，restore 会删掉它。
 */
export function isOverlayApplied() {
  return existsSync(MANIFEST)
}

/** overlay applied 时抛错（带可复制的修复命令），否则静默返回。 */
export function requireOverlayRestored(label = 'tests') {
  if (!isOverlayApplied()) {
    return
  }
  const lines = [
    `[${label}] 拒绝运行：overlay 处于 applied 状态，源码扫描类断言无意义。`,
    '[tests] 先执行：node apps/arkui-schedule/tools/overlay.mjs restore',
    '[tests] （构建期请勿跑全量测试——build-harmony.ps1 会临时 apply overlay）',
  ]
  // 同时写 stderr 与抛错：无论是 `node --test` 还是被别的脚本 import，都能硬失败。
  console.error(lines.join('\n'))
  throw new Error(lines[0])
}

/** manifest 里的覆盖规模（供报错时给出"覆盖了多少文件"的证据）。 */
export function overlayFootprint() {
  if (!isOverlayApplied()) {
    return { replaced: 0, created: 0 }
  }
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    return {
      replaced: Array.isArray(manifest.replaced) ? manifest.replaced.length : 0,
      created: Array.isArray(manifest.created) ? manifest.created.length : 0,
    }
  } catch {
    return { replaced: -1, created: -1 }
  }
}
