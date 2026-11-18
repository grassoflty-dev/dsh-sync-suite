/**
 * 「云端对话模式」的工具隔离：**运行期反算 deny + 白名单断言（fail-closed）**。
 *
 * ## 为什么是反算，不是名单
 *
 * 上一版把 58 个工具名写死在源码里当 deny。真接线必然失败，因为插件生态里**工具是运行期
 * 注册的**，数量与名字都不稳定：
 *
 * - `read`/`write`/`edit`/`glob`/`grep`/`bash`/`pwsh`/`job_*` 在 chat 会话里**本来就没注册**
 *   （chat preset 不挂任何 `tool-*` 行）→ 写进 deny 会被 `restrict` 判 unknown 并抛错；
 * - `bcdp_*` 除 `bcdp_status` 外**惰性注册**（分级 + 活动闸），`codex_*`/`chatgpt_connectors_*`
 *   按设置/模型/连接器/通话状态开关 → 同一份名单在不同机器、不同时刻的"合法与否"都不一样；
 * - 任何**新装插件**注册的工具都不在旧名单里 → 漏遮蔽，隔离静默失效。
 *
 * 所以唯一的正确方向是把关系反过来：**白名单是输入，deny 是输出**。
 *
 * ```
 * deny = 当前已注册的全部工具 − 纯对话白名单
 * ```
 *
 * ## 三步流程（缺一步都不算完成）
 *
 * 1. **取注册表**：枚举"当前已注册的工具名"。取不到 → 抛 `E_CHAT_TOOLS_NOT_ISOLATED`
 *    （fail-closed，**绝不**退化成静态名单——那等于把"未知"当成"安全"）。
 * 2. **遮蔽**：`ctx.tools.restrict({ deny })`。抛错 → 包成内部错误 `E_CHAT_DENY_FAILED`
 *    + 打日志，并按 fail-closed 拒绝（照射蔽失败处理，不重试别的名单）。
 * 3. **再枚举 + 断言**：重新枚举**可见**工具集，做白名单断言；多出任何非白名单工具 →
 *    抛 `E_CHAT_TOOLS_NOT_ISOLATED`（message 里逐个点名），拒绝创建会话。
 *
 * 第 3 步是这一版的关键：`restrict` 调用成功**不等于**遮蔽生效（可能算 deny 时与调用时注册表
 * 变了，也可能可见视图不认这层掩码）。只信"事后看见什么"，才叫 fail-closed。
 *
 * ## 隔离的语义（Lead 原话，评审时别改写）
 *
 * > chat 模式不接触本机文件系统 / 不执行本机命令 / 不读取本机环境。
 *
 * 注意判据不是"零副作用"（`todo_write` 有副作用，但它只写会话内计划），也不是"没有任何工具"
 * （`ask_user_question` 留下的价值就在反问用户）。准入判据与逐条理由见 `./allow.ts`。
 *
 * ## 宿主 API 依据
 *
 * - `restrict` 需要**有 scope 的 ctx**（agent.ctx），在 Host/root 层调用直接抛错；
 *   只认当前已注册的名字，写错就抛（`<ASAR>/dsh-tools/src/index.ts:162-189`）。
 * - `definitions(scope)` / `schemas(scope)` 给"该 scope 看见的定义"（同文件 `:305-318`），
 *   省略 scope 是**全局视图**——所以可见集必须按 agent scope 取，不能拿全局视图凑数。
 */
import { CHAT_ERROR_CODES, SyncError } from '../engine/errors.js'
import { CHAT_ALLOW_TOOLS } from './allow.js'
import { describeDenyFailure, unknownToolNamesFromRestrictError } from './deny.js'
import { CHAT_PRESET_ID } from './ids.js'

/** 读一次工具名（允许异步：宿主将来可能把枚举改成异步）。 */
export type ToolNameReader = () => readonly string[] | Promise<readonly string[]>

/** 宿主 `tools` 服务里本模块用到的那一小块（全部按需探测，缺哪个走哪条降级路）。 */
export interface ToolsRegistryLike {
  /** 施加 agent 作用域掩码；只接受当前已注册的全局名字。 */
  restrict?: (filter: { allow?: readonly string[]; deny?: readonly string[] }) => unknown
  /** 该 scope 看见的定义（`{name}` 数组或纯名字数组）。 */
  definitions?: (scope?: unknown) => readonly unknown[]
  /** 该 scope 看见的 schema（同上）。 */
  schemas?: (scope?: unknown) => readonly unknown[]
  /** 显式"全部已注册名"接口（当前 DSH 没有；有就直接用，最准）。 */
  listRegistered?: () => readonly string[] | Promise<readonly string[]>
  /** 显式"该 scope 可见名"接口（同上，可选）。 */
  listVisible?: () => readonly string[] | Promise<readonly string[]>
}

/** `installChatToolDeny` 需要的上下文：**必须有 agent 作用域**的 `tools` 服务。 */
export interface ChatToolDenyContext {
  tools?: ToolsRegistryLike
  /**
   * agent 作用域对象（在 DSH 里 agent 自身就是 scope key，`definitions(agent)` 可拿到
   * agent 视图）。装配路径把它挂在这里；没有它就只能取全局视图，可见集断言会因此拒绝。
   */
  agent?: unknown
  /** 某些装配路径把作用域放在 `ctx.scope`（与 `agent` 二选一）。 */
  scope?: unknown
  /** `agents.currentInitiator()` 兜底发现路径（可选）。 */
  agents?: { currentInitiator?: () => unknown }
  /** 日志口（宿主 logger；没有就静默，不往 stdout 喷）。 */
  logger?: {
    warn?: (message: string, ...args: unknown[]) => unknown
    error?: (message: string, ...args: unknown[]) => unknown
  }
}

/** `installChatToolDeny` 的可选参数（测试/二期接线用）。 */
export interface InstallChatToolDenyOptions {
  /** 覆盖白名单（默认 `CHAT_ALLOW_TOOLS`）。 */
  allow?: readonly string[]
  /** 覆盖"已注册工具名"的读法（默认从 `ctx.tools` 探测；抛错 = fail-closed）。 */
  listRegistered?: ToolNameReader
}

/** `assertIsolated` 的判定结果。 */
export interface IsolationVerdict {
  /** 是否隔离成功（**只看 extra**：白名单里没注册的名字不算失败）。 */
  ok: boolean
  /** 可见但不在白名单里的名字（隔离失败的点名清单）。 */
  extra: string[]
  /** 白名单里有、但当前不可见的名字（记录用：说明该能力没被挂载/被别处掩码了）。 */
  missing: string[]
}

/**
 * 反算 deny：`registered − allow`。
 *
 * 纯函数、无副作用、不改入参；保留 `registered` 的顺序（便于日志对照），去重。
 * 名字里的空白/非字符串会被跳过——不是因为"宽容"，而是 `restrict` 本身会拒绝非法名字，
 * 与其在这里猜，不如让名字来源（注册表读取）负责失败。
 *
 * @param registered - 当前已注册的工具名。
 * @param allow - 纯对话白名单（`src/chatPreset/allow.ts`）。
 * @returns 需要 deny 的工具名（顺序同 `registered`，已去重）。
 */
export function computeDeny(registered: readonly string[], allow: readonly string[]): string[] {
  const allowed = new Set(allow)
  const seen = new Set<string>()
  const deny: string[] = []
  for (const raw of registered) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    if (allowed.has(raw) || seen.has(raw)) continue
    seen.add(raw)
    deny.push(raw)
  }
  return deny
}

/**
 * 白名单断言：**可见集里不允许出现白名单之外的名字**。
 *
 * `extra` 非空 = 隔离失败（fail-closed 的唯一判据）；`missing` 只记录不失败——白名单里的工具
 * 没注册是"能力少了"，不是"能力漏了"，方向是安全的（例如 chat preset 没挂 `dsh-tool-ask-user`
 * 时 `ask_user_question` 就是 missing）。
 *
 * @param visible - 遮蔽之后实际可见的工具名。
 * @param allow - 纯对话白名单。
 */
export function assertIsolated(visible: readonly string[], allow: readonly string[]): IsolationVerdict {
  const allowed = new Set(allow)
  const visibleNames = new Set<string>()
  const extra: string[] = []
  for (const name of visible) {
    if (typeof name !== 'string' || name.trim() === '') continue
    visibleNames.add(name)
    if (!allowed.has(name) && !extra.includes(name)) extra.push(name)
  }
  const missing = allow.filter((name) => !visibleNames.has(name))
  return { ok: extra.length === 0, extra, missing }
}

/* -------------------------------------------------------------------------- */
/* 内部：名字读取与失败构造                                                     */
/* -------------------------------------------------------------------------- */

/** 统一错误消息提取（不把 object 直接 String 成 `[object Object]` 之外的怪东西）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 安全边界错误：`E_CHAT_TOOLS_NOT_ISOLATED`（message 统一前缀，便于用户看到"拒绝创建会话"）。 */
function isolationError(reason: string, details: Record<string, unknown> = {}): SyncError {
  return new SyncError(
    CHAT_ERROR_CODES.TOOLS_NOT_ISOLATED,
    `云端对话模式没能隔离工具：${reason}`,
    { preset: CHAT_PRESET_ID, ...details },
  )
}

/** 把枚举结果规范化成名字数组；形态不对 → `undefined`（交给调用方决定"这是失败"）。 */
function namesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names: string[] = []
  for (const entry of value as readonly unknown[]) {
    if (typeof entry === 'string') {
      names.push(entry)
      continue
    }
    if (entry !== null && typeof entry === 'object') {
      const name = (entry as { name?: unknown }).name
      if (typeof name === 'string') {
        names.push(name)
        continue
      }
    }
    return undefined
  }
  return names
}

/** 是否是可用作 scope key 的对象（DSH 的 ScopeKey 是 object）。 */
function isScopeKey(value: unknown): boolean {
  return value !== null && typeof value === 'object'
}

/** 找出 agent 作用域对象：`ctx.agent` / `ctx.scope` / `agents.currentInitiator()`。 */
function agentScopeOf(ctx: ChatToolDenyContext): unknown {
  for (const candidate of [ctx.agent, ctx.scope]) {
    if (isScopeKey(candidate)) return candidate
  }
  const agents = ctx.agents
  if (agents !== undefined && typeof agents.currentInitiator === 'function') {
    try {
      const active = agents.currentInitiator()
      if (isScopeKey(active)) return active
    } catch {
      // 没有发起者边界（agentless 调用）：不是错误，继续走其它路径。
    }
  }
  return undefined
}

/** 调一次读取器：吞掉异常并返回 `undefined`（"这条降级路走不通"，由上层统一判失败）。 */
async function tryRead(reader: () => unknown): Promise<string[] | undefined> {
  try {
    return namesOf(await Promise.resolve(reader()))
  } catch {
    return undefined
  }
}

/**
 * 取"当前已注册的工具名"。
 *
 * 顺序：显式 `options.listRegistered` → `tools.listRegistered()` → agent 作用域的
 * `definitions`/`schemas` → 全局作用域的 `definitions`/`schemas`。
 *
 * 后两级都是"可见视图"，在没有任何掩码的情况下等于已注册名（安装发生在首次遮蔽之前）；
 * 全局视图那一级是**兜底**：它能覆盖第三方 Host 插件注册的残余面，但看不到 preset 作用域里
 * 注册的工具——那些会在第 3 步的可见集断言里以 `extra` 暴露出来（所以不会漏，只会更严）。
 *
 * 一级都走不通 → `E_CHAT_TOOLS_NOT_ISOLATED`（**不许**退化成静态名单）。
 */
async function resolveRegistered(
  ctx: ChatToolDenyContext,
  options: InstallChatToolDenyOptions,
): Promise<string[]> {
  const custom = options.listRegistered
  if (custom !== undefined) {
    if (typeof custom !== 'function') {
      throw isolationError('调用方给的 listRegistered 不是函数，读不到已注册工具表', {
        reason: 'list-registered-unavailable',
      })
    }
    let raw: unknown
    try {
      raw = await Promise.resolve(custom())
    } catch (error) {
      throw isolationError(`读取已注册工具表时抛错（${messageOf(error)}）`, {
        reason: 'list-registered-threw',
        cause: messageOf(error),
      })
    }
    const names = namesOf(raw)
    if (names === undefined) {
      throw isolationError('调用方给的 listRegistered 没有返回工具名数组', {
        reason: 'list-registered-malformed',
      })
    }
    return names
  }

  const tools = ctx.tools
  if (tools === undefined || tools === null || typeof tools !== 'object') {
    throw isolationError('宿主没有可用的 tools 服务，读不到已注册工具表', {
      reason: 'tools-unavailable',
    })
  }

  if (typeof tools.listRegistered === 'function') {
    const names = await tryRead(() => tools.listRegistered!())
    if (names !== undefined) return names
    throw isolationError('宿主 tools.listRegistered() 调用失败（抛错或没返回工具名数组）', {
      reason: 'list-registered-unavailable',
    })
  }

  const scope = agentScopeOf(ctx)
  const readers: Array<() => unknown> = []
  if (typeof tools.definitions === 'function') {
    const read = tools.definitions.bind(tools)
    if (scope !== undefined) readers.push(() => read(scope))
    readers.push(() => read())
  }
  if (typeof tools.schemas === 'function') {
    const read = tools.schemas.bind(tools)
    if (scope !== undefined) readers.push(() => read(scope))
    readers.push(() => read())
  }
  for (const reader of readers) {
    const names = await tryRead(reader)
    if (names !== undefined) return names
  }
  throw isolationError(
    '读不到已注册工具表（宿主 tools 服务没有 listRegistered，definitions/schemas 也不可用）；' +
      '按 fail-closed 拒绝，绝不退回静态名单',
    { reason: 'registry-unavailable' },
  )
}

/**
 * 取"遮蔽之后 agent 实际可见的工具名"。
 *
 * **必须按 agent 作用域取**：省略 scope 会拿到全局视图，而掩码是加在 agent 那一层的，
 * 全局视图看不到掩码 → 会给出"看起来隔离成功"的假结论。拿不到 agent 作用域就失败。
 */
async function resolveVisible(ctx: ChatToolDenyContext, tools: ToolsRegistryLike): Promise<string[]> {
  const scope = agentScopeOf(ctx)
  if (scope === undefined) {
    throw isolationError(
      '拿不到 agent 作用域，无法枚举可见工具集（不能证明已隔离）；' +
        '请在 chat 会话的 agent 装配路径里调用，并传入 agent 作用域',
      { reason: 'agent-scope-unavailable' },
    )
  }
  const readers: Array<() => unknown> = []
  if (typeof tools.definitions === 'function') readers.push(() => tools.definitions!(scope))
  if (typeof tools.schemas === 'function') readers.push(() => tools.schemas!(scope))
  if (typeof tools.listVisible === 'function') readers.push(() => tools.listVisible!())
  for (const reader of readers) {
    const names = await tryRead(reader)
    if (names !== undefined) return names
  }
  throw isolationError('拿不到 agent 可见工具集，无法断言隔离；按 fail-closed 拒绝', {
    reason: 'visible-unavailable',
  })
}

/**
 * 把失败原因交给**宿主 logger**（有就交；没有就什么也不做）。
 *
 * 插件不许直接往控制台打印：唯一出口是结构化错误。三个调用点随后都会抛
 * `SyncError`，其 `details` 已带同样的 `reason` / `cause` / `extra`，所以宿主
 * 没配 logger 时诊断信息并不丢失，也不会把凭据/本机路径打到宿主控制台。
 */
function logFailure(ctx: ChatToolDenyContext, message: string): void {
  const logger = ctx.logger
  try {
    if (logger !== undefined && typeof logger.warn === 'function') {
      logger.warn(message)
      return
    }
    if (logger !== undefined && typeof logger.error === 'function') {
      logger.error(message)
    }
  } catch {
    // 日志本身失败不能影响"拒绝创建会话"这个结论。
  }
}

/* -------------------------------------------------------------------------- */
/* 安装入口                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 在**当前 agent 作用域**里把 chat 模式不该有的工具全部遮蔽，并断言隔离成立。
 *
 * 调用点要求：`ctx` 必须是带 scope 的 agent ctx（`restrict` 在 root/Host 层调用直接抛错），
 * 并且要能拿到 agent 作用域对象（见 `ChatToolDenyContext.agent`）。
 *
 * 失败语义（两种都**拒绝创建会话**，不降级、不回退静态名单）：
 * - 读不到注册表 / 可见集、或断言发现多出的工具 → `E_CHAT_TOOLS_NOT_ISOLATED`；
 * - 宿主没有 `restrict`，或 `restrict` 抛错 → `E_CHAT_DENY_FAILED`（内部防御性错误，打日志）。
 *
 * @param ctx - 带 `tools.restrict` 的 agent 作用域上下文（需要 agent 作用域对象）。
 * @param options - 白名单覆盖 / 注册表读取覆盖（测试与二期接线用）。
 * @throws {SyncError} `E_CHAT_TOOLS_NOT_ISOLATED` 或 `E_CHAT_DENY_FAILED`。
 */
export async function installChatToolDeny(
  ctx: ChatToolDenyContext,
  options: InstallChatToolDenyOptions = {},
): Promise<void> {
  const context: ChatToolDenyContext = ctx === null || typeof ctx !== 'object' ? {} : ctx
  const allow = options.allow ?? CHAT_ALLOW_TOOLS
  const tools = context.tools

  if (tools === undefined || tools === null || typeof tools !== 'object' || typeof tools.restrict !== 'function') {
    const reason =
      '宿主没有可用的 tools.restrict（它需要 agent 作用域的 ctx，在 Host/root 层调用必然失败）；' +
      '请把安装点放到 chat 会话的 agent 装配路径里'
    logFailure(context, `[chat-preset] ${reason}`)
    throw new SyncError(CHAT_ERROR_CODES.DENY_FAILED, `chat 模式工具遮蔽失败：${reason}`, {
      preset: CHAT_PRESET_ID,
      reason: 'restrict-unavailable',
    })
  }

  const registered = await resolveRegistered(context, options)
  const deny = computeDeny(registered, allow)

  try {
    tools.restrict({ deny })
  } catch (error) {
    const unknown = unknownToolNamesFromRestrictError(error, deny)
    const cause = messageOf(error)
    logFailure(context, `[chat-preset] ctx.tools.restrict() 抛错，按 fail-closed 拒绝创建会话：${cause}`)
    throw new SyncError(CHAT_ERROR_CODES.DENY_FAILED, describeDenyFailure(unknown), {
      preset: CHAT_PRESET_ID,
      reason: 'restrict-threw',
      registeredCount: registered.length,
      denyCount: deny.length,
      unknown,
      cause,
    })
  }

  const visible = await resolveVisible(context, tools)
  const verdict = assertIsolated(visible, allow)
  if (!verdict.ok) {
    const reason = `多出 ${verdict.extra.join(', ')}`
    logFailure(context, `[chat-preset] ${reason}；按 fail-closed 拒绝创建会话`)
    throw isolationError(reason, {
      reason: 'extra-tools-visible',
      extra: verdict.extra,
      missing: verdict.missing,
      registeredCount: registered.length,
      denyCount: deny.length,
    })
  }
}
