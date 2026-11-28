/** 隐藏行 / 恢复行的 op 字面量；`unarchive` 只读不写。 */
export const ARCHIVE_OP = 'archive';
export const UNARCHIVE_OP = 'unarchive';
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
/** op 行的 id 才走白名单（与 `assertSafeSessionId` 同口径）；普通行保持历史兼容（非空即可）。 */
function safeIdOf(value) {
    if (typeof value !== 'string')
        return '';
    const id = value.trim();
    if (id === '' || id.length > 200 || id === '.' || id === '..' || !SAFE_ID.test(id))
        return '';
    return id;
}
/** 毫秒时间戳：只认非负整数；坏值让该 op 行失效（只计数、不改状态）。 */
function opMillisOf(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
        return null;
    return value;
}
/** `(ts, seq)` 严格新于 `at`？同毫秒时行号大的胜出。 */
function isNewer(marker, at) {
    return marker.ts > at.ts || (marker.ts === at.ts && marker.seq > at.seq);
}
/**
 * 按文件顺序折叠 `chats/index.jsonl`。
 *
 * - 普通行：同 id 取最后一行（沿用既有"展示投影取最新"语义），但**不动 hidden**；
 * - archive：若 `(deletedAt, seq)` 严格新于当前 `at` ⇒ hidden=true，记录该标记；
 * - unarchive：若 `(ts, seq)`（缺 ts 时回落 deletedAt）严格新于当前 `at` ⇒ hidden=false；
 * - 坏行 / 未知 op：只 `badLines++`，状态与投影都不变。
 */
export function foldChatIndex(jsonlText) {
    const text = typeof jsonlText === 'string' ? jsonlText : '';
    const byId = new Map();
    const states = new Map();
    const order = [];
    let badLines = 0;
    let lastExportAt = '';
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index].trim();
        if (trimmed === '')
            continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            badLines += 1;
            continue;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            badLines += 1;
            continue;
        }
        const record = parsed;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (id === '') {
            badLines += 1;
            continue;
        }
        if (record.op !== undefined) {
            const op = record.op === ARCHIVE_OP || record.op === UNARCHIVE_OP ? record.op : '';
            const safe = safeIdOf(id);
            // 兼容格式定义里 unarchive 用 ts；也接受 deletedAt，避免未来模块两种写法分裂。
            const rawMillis = op === ARCHIVE_OP
                ? record.deletedAt
                : (record.ts !== undefined ? record.ts : record.deletedAt);
            const ts = opMillisOf(rawMillis);
            if (op === '' || safe === '' || ts === null) {
                badLines += 1;
                continue;
            }
            const seq = index + 1;
            const current = states.get(safe) ?? { hidden: false, at: { ts: -1, seq: -1 } };
            if (isNewer({ ts, seq }, current.at)) {
                states.set(safe, { hidden: op === ARCHIVE_OP, at: { ts, seq } });
            }
            continue;
        }
        // 普通行：只更新内容投影。注意这里刻意不碰 states。
        if (!byId.has(id))
            order.push(id);
        const entry = {
            id,
            title: typeof record.title === 'string' ? record.title : '',
            updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
            messageCount: typeof record.messageCount === 'number' ? record.messageCount : 0,
            sha256: typeof record.sha256 === 'string' ? record.sha256 : '',
        };
        byId.set(id, entry);
        if (entry.updatedAt > lastExportAt)
            lastExportAt = entry.updatedAt;
    }
    const entries = [];
    for (const id of order) {
        if (states.get(id)?.hidden === true)
            continue;
        entries.push(byId.get(id));
    }
    const hiddenIds = [];
    for (const [id, state] of states) {
        if (state.hidden)
            hiddenIds.push(id);
    }
    return { entries, hiddenIds, states, badLines, lastExportAt };
}
