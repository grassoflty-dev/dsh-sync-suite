/** 单条文本上限（字符）：与本地适配器的截断口径一致。 */
export const MAX_PROJECTED_TEXT_CHARS = 2000;
/** 单个数组上限（项）：与本地会话事件的 limit 上限一致。 */
export const MAX_PROJECTED_ARRAY_ITEMS = 500;
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
export function asSafeString(value) {
    return typeof value === 'string' ? value : '';
}
export function asSafeInt(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}
function safeText(value) {
    return asSafeString(value).slice(0, MAX_PROJECTED_TEXT_CHARS);
}
/** 实例列表完全由本地事实构造，但仍走投影函数以免将来漏字段。 */
export function projectInstanceList(items) {
    if (!Array.isArray(items))
        return [];
    return items.slice(0, MAX_PROJECTED_ARRAY_ITEMS).map((raw) => {
        const item = asRecord(raw) ?? {};
        return {
            id: asSafeString(item.id),
            displayName: asSafeString(item.displayName),
            mode: asSafeString(item.mode),
            urlMasked: asSafeString(item.urlMasked),
            capabilities: Array.isArray(item.capabilities)
                ? item.capabilities.filter((cap) => typeof cap === 'string').slice(0, MAX_PROJECTED_ARRAY_ITEMS)
                : [],
        };
    });
}
/** 会话列表：items 逐项白名单，instanceId 强制为本地解析值。 */
export function projectSessionList(data, instanceId) {
    const raw = asRecord(data) ?? {};
    const items = Array.isArray(raw.items) ? raw.items : [];
    return {
        items: items.slice(0, MAX_PROJECTED_ARRAY_ITEMS).map((entry) => {
            const item = asRecord(entry) ?? {};
            return {
                sessionId: asSafeString(item.sessionId),
                title: safeText(item.title),
                updatedAt: asSafeString(item.updatedAt),
                messageCount: asSafeInt(item.messageCount),
                sha256: asSafeString(item.sha256),
                instanceId,
                // 本模块无租约语义：不信 peer 传来的 lease 结构（可能内嵌 token/path）。
                lease: null,
            };
        }),
        nextCursor: asSafeString(raw.nextCursor),
    };
}
/** 单会话信息：只保留五个具名字段，instanceId 同样强制覆盖。 */
export function projectSessionInfo(data, instanceId) {
    const item = asRecord(data) ?? {};
    return {
        instanceId,
        sessionId: asSafeString(item.sessionId),
        sha256: asSafeString(item.sha256),
        lease: null,
        owner: null,
    };
}
/** 会话事件：事件对象只取四个字段，正文截断；多余字段（含 data/path/token）全丢。 */
export function projectSessionEvents(data, instanceId) {
    const raw = asRecord(data) ?? {};
    const events = Array.isArray(raw.events) ? raw.events : [];
    return {
        instanceId,
        events: events.slice(0, MAX_PROJECTED_ARRAY_ITEMS).map((entry) => {
            const item = asRecord(entry) ?? {};
            return {
                seq: asSafeInt(item.seq),
                time: asSafeString(item.time),
                type: safeText(item.type),
                text: safeText(item.text),
            };
        }),
        nextSeq: asSafeInt(raw.nextSeq),
        sha256: asSafeString(raw.sha256),
    };
}
/** action → 白名单投影的唯一分派点（本机与远端路径共用）。 */
export function projectReadResult(action, data, instanceId) {
    switch (action) {
        case 'instanceList': return projectInstanceList(data);
        case 'sessionList': return projectSessionList(data, instanceId);
        case 'sessionInfo': return projectSessionInfo(data, instanceId);
        case 'sessionEvents': return projectSessionEvents(data, instanceId);
    }
}
/** 供测试断言"同一逻辑载荷两条路径同形"：把 action 的期望键集合列出来。 */
export const PROJECTED_KEY_SETS = {
    instanceList: ['id', 'displayName', 'mode', 'urlMasked', 'capabilities'],
    sessionList: ['items', 'nextCursor'],
    sessionInfo: ['instanceId', 'sessionId', 'sha256', 'lease', 'owner'],
    sessionEvents: ['instanceId', 'events', 'nextSeq', 'sha256'],
};
