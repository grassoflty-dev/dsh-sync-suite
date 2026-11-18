/**
 * chat preset 的装配入口（P3 一期：**只提供可调用函数，不自动接线**）。
 *
 * 本轮刻意**不**在 `src/index.ts` 里调用 `installChatToolDeny`：那会把 deny 施加到
 * 标准会话（`standard` preset）上，等于把用户的文件/命令工具全关掉。真正接线的位置是
 * "chat 会话的装配路径"（preset 行里的一个自研插件，或 `composeAgent` 的 setup），
 * 属于 P3 二期（见 `docs/CHAT-SYNC.md`「安全边界」与 `docs/RESEARCH-chat-preset.md`
 * 的「结论补充」）。
 *
 * 本模块的契约（2026-11-18 二次裁决后）：
 * 1. **deny 不是常量，是反算结果**：`deny = 当前已注册的全部工具 − 纯对话白名单`
 *    （白名单在 `./allow.ts`，反算与断言在 `./isolate.ts`）。源码里**不再有**静态 deny 名单，
 *    也没有任何"名单与实装插件是否一致"的手工维护问题。
 * 2. `installChatToolDeny(ctx)` 在**当前 agent 作用域**反算 → `ctx.tools.restrict({ deny })`
 *    → 再枚举可见集做白名单断言。断言不过或读不到注册表 → `E_CHAT_TOOLS_NOT_ISOLATED`
 *    （拒绝创建会话）；`restrict` 抛错/宿主没有 `restrict` → 内部错误 `E_CHAT_DENY_FAILED`
 *    + 打日志，同样拒绝。**绝不静默吞**（静默 = 以为隔离了其实没有，是最坏的一种"看起来安全"）。
 * 3. `chatPresetInfo()` 给 RPC 用：只交出 `presetId` / `allow` / `rationale`（以及可选的
 *    计数），**不再交出静态名单**——名单在运行期才有意义。
 */
import { ALLOW_RATIONALE, CHAT_ALLOW_TOOLS } from './allow.js'
import { computeDeny } from './isolate.js'
import { CHAT_PRESET_ID } from './ids.js'

export type {
  ChatToolDenyContext,
  InstallChatToolDenyOptions,
  IsolationVerdict,
  ToolNameReader,
  ToolsRegistryLike,
} from './isolate.js'
export type { DenyValidation, ToolNameSource } from './deny.js'
export {
  ALLOW_CRITERION,
  ALLOW_RATIONALE,
  CHAT_ALLOW_TOOLS,
} from './allow.js'
export {
  assertIsolated,
  computeDeny,
  installChatToolDeny,
} from './isolate.js'
export {
  BROWSER_TOOL_SOURCES,
  BUILTIN_TOOL_SOURCES,
  CODEX_TOOL_SOURCES,
  KNOWN_ALL_TOOLS,
  KNOWN_BUILTIN_TOOLS,
  KNOWN_GLOBAL_TOOLS,
  PLUGIN_TOOL_SOURCES,
  describeDenyFailure,
  unknownToolNamesFromRestrictError,
  validateDenyList,
} from './deny.js'
export { CHAT_PRESET_ID, CHAT_PRESET_LOADER_ID, CHAT_PRESET_NAME } from './ids.js'

/** `chatPresetInfo` 的返回结构（RPC `chatPresetInfo` 的 `data`）。 */
export interface ChatPresetInfo {
  /** preset 定义 id（= 会话 header 里的 `agentPreset`）。 */
  presetId: string
  /** 纯对话白名单（唯一允许留在 chat 会话里的工具）。 */
  allow: readonly string[]
  /** 白名单逐条理由（判据：能不能读写本机文件 / 执行本机命令 / 读取本机环境）。 */
  rationale: Record<string, string>
  /** 反算时看到的已注册工具数（运行期才有，RPC 不带注册表时省略）。 */
  registeredCount?: number
  /** 反算出的 deny 条数（同上，运行期才有）。 */
  denyCount?: number
}

/**
 * RPC `chatPresetInfo` 的返回值：结构稳定（`presetId`/`allow`/`rationale`，可选的两个计数）。
 *
 * 纯函数、只读、不联网、不碰文件系统——设置页可以随时调用它对"白名单 vs 实装工具"做自检。
 * 传入 `registered`（当前已注册工具名）时会附带 `registeredCount`/`denyCount`，便于诊断脚本
 * 直接看到"这次反算会 deny 多少条"；不传时只交白名单与理由，**绝不**回退成静态名单。
 *
 * @param registered - 可选的"当前已注册工具名"（由调用方从运行期取；RPC 侧没有注册表）。
 */
export function chatPresetInfo(registered?: readonly string[]): ChatPresetInfo {
  const info: ChatPresetInfo = {
    presetId: CHAT_PRESET_ID,
    allow: CHAT_ALLOW_TOOLS,
    rationale: ALLOW_RATIONALE,
  }
  if (registered !== undefined) {
    info.registeredCount = registered.length
    info.denyCount = computeDeny(registered, CHAT_ALLOW_TOOLS).length
  }
  return info
}
