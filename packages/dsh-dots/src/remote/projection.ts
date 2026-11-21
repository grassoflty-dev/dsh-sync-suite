/**
 * 只读工具输出的**唯一白名单投影**（`mod-plugin-remote-tools`）。
 *
 * 为什么必须共享：本机路径（`localRead.ts`）与远端路径（peer RPC 的 `rpc.data`）
 * 若各自造结构，被攻陷的 allow-list peer 就能把 `token` / `path` / 额外数组塞进
 * 我们承诺给 dots 的结果里。把所有字段收敛到一个函数后，两条路径**按构造**同形。
 *
 * 纪律：
 *   - 只取下列具名字段，未知字段一律丢弃；
 *   - `instanceId` 由**本地解析出的实例**强制覆盖，不信 peer 自报的来源；
 *   - 本模块没有租约语义，`lease` / `owner` 恒 null（未来租约模块自带 typed 白名单）；
 *   - 每条文本截断 2000 字符、每个数组限 500 项，防 peer 用巨量字段撑爆上下文。
 */
/** 与 `rpc.ts` 的只读 action 集合一致。 */
export type RemoteReadAction = 'instanceList' | 'sessionList' | 'sessionInfo' | 'sessionEvents'

export interface ProjectedInstance {
  id: string
  displayName: string
  mode: string
  urlMasked: string
  capabilities: string[]
}

export interface ProjectedSessionItem {
  sessionId: string
  title: string
  updatedAt: string
  messageCount: number
  sha256: string
  instanceId: string
  lease: null
}

export interface ProjectedSessionList {
  items: ProjectedSessionItem[]
  nextCursor: string
}

export interface ProjectedSessionInfo {
  instanceId: string
  sessionId: string
  sha256: string
  lease: null
  owner: null
}

export interface ProjectedEvent {
  seq: number
  time: string
  type: string
  text: string
}

export interface ProjectedSessionEvents {
  instanceId: string
  events: ProjectedEvent[]
  nextSeq: number
  sha256: string
}

export type ProjectedReadResult =
  | ProjectedSessionList
  | ProjectedSessionInfo
  | ProjectedSessionEvents

/** 单条文本上限（字符）：与本地适配器的截断口径一致。 */
export const MAX_PROJECTED_TEXT_CHARS = 2000
/** 单个数组上限（项）：与本地会话事件的 limit 上限一致。 */
export const MAX_PROJECTED_ARRAY_ITEMS = 500

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function asSafeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function asSafeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

function safeText(value: unknown): string {
  return asSafeString(value).slice(0, MAX_PROJECTED_TEXT_CHARS)
}

/** 实例列表完全由本地事实构造，但仍走投影函数以免将来漏字段。 */
export function projectInstanceList(items: unknown): ProjectedInstance[] {
  if (!Array.isArray(items)) return []
  return items.slice(0, MAX_PROJECTED_ARRAY_ITEMS).map((raw) => {
    const item = asRecord(raw) ?? {}
    return {
      id: asSafeString(item.id),
      displayName: asSafeString(item.displayName),
      mode: asSafeString(item.mode),
      urlMasked: asSafeString(item.urlMasked),
      capabilities: Array.isArray(item.capabilities)
        ? item.capabilities.filter((cap): cap is string => typeof cap === 'string').slice(0, MAX_PROJECTED_ARRAY_ITEMS)
        : [],
    }
  })
}

/** 会话列表：items 逐项白名单，instanceId 强制为本地解析值。 */
export function projectSessionList(data: unknown, instanceId: string): ProjectedSessionList {
  const raw = asRecord(data) ?? {}
  const items = Array.isArray(raw.items) ? raw.items : []
  return {
    items: items.slice(0, MAX_PROJECTED_ARRAY_ITEMS).map((entry) => {
      const item = asRecord(entry) ?? {}
      return {
        sessionId: asSafeString(item.sessionId),
        title: safeText(item.title),
        updatedAt: asSafeString(item.updatedAt),
        messageCount: asSafeInt(item.messageCount),
        sha256: asSafeString(item.sha256),
        instanceId,
        // 本模块无租约语义：不信 peer 传来的 lease 结构（可能内嵌 token/path）。
        lease: null,
      }
    }),
    nextCursor: asSafeString(raw.nextCursor),
  }
}

/** 单会话信息：只保留五个具名字段，instanceId 同样强制覆盖。 */
export function projectSessionInfo(data: unknown, instanceId: string): ProjectedSessionInfo {
  const item = asRecord(data) ?? {}
  return {
    instanceId,
    sessionId: asSafeString(item.sessionId),
    sha256: asSafeString(item.sha256),
    lease: null,
    owner: null,
  }
}

/** 会话事件：事件对象只取四个字段，正文截断；多余字段（含 data/path/token）全丢。 */
export function projectSessionEvents(data: unknown, instanceId: string): ProjectedSessionEvents {
  const raw = asRecord(data) ?? {}
  const events = Array.isArray(raw.events) ? raw.events : []
  return {
    instanceId,
    events: events.slice(0, MAX_PROJECTED_ARRAY_ITEMS).map((entry) => {
      const item = asRecord(entry) ?? {}
      return {
        seq: asSafeInt(item.seq),
        time: asSafeString(item.time),
        type: safeText(item.type),
        text: safeText(item.text),
      }
    }),
    nextSeq: asSafeInt(raw.nextSeq),
    sha256: asSafeString(raw.sha256),
  }
}

/** action → 白名单投影的唯一分派点（本机与远端路径共用）。 */
export function projectReadResult(
  action: RemoteReadAction,
  data: unknown,
  instanceId: string,
): ProjectedReadResult | ProjectedInstance[] {
  switch (action) {
    case 'instanceList': return projectInstanceList(data)
    case 'sessionList': return projectSessionList(data, instanceId)
    case 'sessionInfo': return projectSessionInfo(data, instanceId)
    case 'sessionEvents': return projectSessionEvents(data, instanceId)
  }
}

/** 供测试断言"同一逻辑载荷两条路径同形"：把 action 的期望键集合列出来。 */
export const PROJECTED_KEY_SETS: Record<RemoteReadAction, readonly string[]> = {
  instanceList: ['id', 'displayName', 'mode', 'urlMasked', 'capabilities'],
  sessionList: ['items', 'nextCursor'],
  sessionInfo: ['instanceId', 'sessionId', 'sha256', 'lease', 'owner'],
  sessionEvents: ['instanceId', 'events', 'nextSeq', 'sha256'],
}
