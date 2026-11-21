/**
 * 插件侧 v2 同步周期（writer half 的决策层，IO 全部注入）。
 *
 * 三条硬约束（Lead requirement (b)，与 App `model/syncCycle.ts` 故意不同）：
 * 1. 本模块**没有**任何改写远端/本地历史的能力：没有变基、没有硬回退、
 *    没有切分支命令；git 端口只暴露 fetch / 读 / add / commit / push 五个动作。
 * 2. push 参数固定为 `{ remote:'origin', branch:'main', force:false }`，
 *    测试可直接断言调用实参；push 失败只把意图停放进仓库外 outbox 并报 typed 错误，
 *    绝不把「本地已提交但没推成功」报成成功。
 * 3. 门槛顺序固定：schema 判定 → 分支 main → fetch → HEAD == origin/main →
 *    才会发生第一个写句柄。未知 schema / 分叉都零写入。
 *
 * 绑定决策 ④：`decideFreshStart`（共享读侧的语义）——缺 schema 标记 = 正常空起点，
 * 首个运行者幂等创建规范 `FRESH_SCHEMA_TEXT`；标记存在但版本不认识 → E_SCHEMA_UNKNOWN。
 * outbox 落在仓库之外的插件状态目录（契约 §13），周期之间唯一本地真值。
 *
 * B1 硬守卫：任何重放的 upsert 先经 `isValidTsShape` + `planUpsert` 的共享规范化校验；
 * 非法输入一律 typed `E_CORRUPT`，意图原地停放、零写入、零提交、零推送、零出队。
 * `buildRecordsText` 的空串哨兵同样致命：union 产出空文本即抛错，绝不落盘。
 */
import { SyncError } from '../engine/errors.js';
import { FRESH_SCHEMA_TEXT, byteCompare, canonicalRecordLine, decideFreshStart, deletionState, parseLedger, parseTimelineDay, sha256Hex, tsMillis, } from '../timeline/records.js';
import { SCHEMA_MARKER_PATH, timelineRecordsPath, timelineDeletedPath, timelineRestorePath, timelineSummaryPath, } from '../timeline/paths.js';
import { atomicReplace, conflictRowOf, deletedLedgerLine, isValidTsShape, mergeLedgerText, planUpsert, recordsTextOf, restoredLedgerLine, } from '../timeline/write.js';
// ---------------------------------------------------------------- typed 错误与常量
export const V2_ERROR = {
    SCHEMA_UNKNOWN: 'E_SCHEMA_UNKNOWN',
    BRANCH_MISMATCH: 'E_BRANCH_MISMATCH',
    NOT_SYNCED: 'E_NOT_SYNCED',
    LOCAL_PENDING: 'E_LOCAL_PENDING',
    CORRUPT: 'E_CORRUPT',
    PULL_FAILED: 'E_PULL_FAILED',
    PUSH_REJECTED: 'E_PUSH_REJECTED',
    IO: 'E_IO',
    OK: 'ok',
};
/** 每意图全生命周期的尝试预算（跨会话累计，只有用户点重试才归零）。 */
export const MAX_ATTEMPTS = 4;
/**
 * 推被拒后的有界恢复预算：每个恢复周期最多 2 次额外推送尝试（连同首次共 3 次）。
 * 取 2 是为了吸收「另一设备刚快进了一步」这类单次竞态，同时不让真正分叉的仓库空转；
 * 仍低于意图的 maxAttempts=4，预算口径不与契约 §9 P1-1 冲突。
 */
export const MAX_CYCLE_RETRIES = 2;
/** 有界恢复耗尽后的 typed 终态文案：点名 operator 必须做什么，绝不静默。 */
export const LOCAL_PENDING_MESSAGE = 'E_LOCAL_PENDING: 本地存在尚未推送的 v2 提交，已按有界重试仍未能推送；下一步：请核对远端是否被其他设备推进（查看远端日志与本地 git status），确认后手工协调并重新运行同步；本层绝不改写历史、绝不强制推送。';
/** push 的唯一合法实参：固定 origin/main、永不 force。 */
export const PUSH_ARGS = Object.freeze({ remote: 'origin', branch: 'main', force: false });
/** 提交信息形如 `[v2] sync <N> days`。 */
export function syncCommitMessage(days) {
    return `[v2] sync ${days} days`;
}
/**
 * 提交尾注（authority marker）：写在 commit **body**，不写 subject。
 * App 的 `syncProtocolStore.ets:552` 会发出一模一样的 `[v2] sync <n> days` subject，
 * 因此 subject 不能证明归属；只有带本尾注 + diff 全在 timeline/** 才算本模块提交。
 */
export const V2_TRAILER_PREFIX = 'dsh-dots-v2:';
export const DEFAULT_V2_INSTANCE_ID = 'plugin-git-store';
/** 尾注整行，例：`dsh-dots-v2: plugin-git-store`。 */
export function v2TrailerLine(instanceId = DEFAULT_V2_INSTANCE_ID) {
    return `${V2_TRAILER_PREFIX} ${instanceId}`;
}
/** body 中是否含本模块的尾注（逐行全等，避免前缀误判）。 */
export function hasV2Trailer(body, instanceId = DEFAULT_V2_INSTANCE_ID) {
    const line = v2TrailerLine(instanceId);
    return body.split(/\r?\n/).some((row) => row.trim() === line);
}
/** 只检查 subject 形状；**单独不足以**证明归属（见 hasV2Trailer / isOursCommit）。 */
export function isV2CommitSubject(subject) {
    return /^\[v2\] (sync \d+ days|bootstrap main)$/.test(subject.trim());
}
/**
 * 严格路径收容：只接受 `timeline/<…>` 的正斜杠相对路径。
 * 拒绝绝对路径、盘符、反斜杠、空段、`.` 与 `..` 段——前缀匹配本身不够。
 */
export function isConfinedTimelinePath(p) {
    if (typeof p !== 'string' || p.length === 0)
        return false;
    if (p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p))
        return false;
    const parts = p.split('/');
    if (parts.some((segment) => segment === '' || segment === '.' || segment === '..'))
        return false;
    return parts[0] === 'timeline' && parts.length > 1;
}
/** 三条件同时成立才算「本模块产生」：subject 形状 + 尾注 + diff 严格收容在 timeline/**。 */
export function isOursCommit(commit, instanceId = DEFAULT_V2_INSTANCE_ID) {
    return isV2CommitSubject(commit.subject) &&
        hasV2Trailer(commit.body, instanceId) &&
        commit.paths.length > 0 &&
        commit.paths.every(isConfinedTimelinePath);
}
// ---------------------------------------------------------------- outbox 纯操作
/** 一条意图的唯一键 = (date,id,ts,op) 的内容哈希：同一四元组只入队一次。 */
export function makeIntentId(date, id, ts, op) {
    return `${op}:${date}:${id}:${sha256Hex(`${op}\u0000${date}\u0000${id}\u0000${ts}`).slice(0, 16)}`;
}
/** 入队（按 intentId 去重，先到先得；payload 原样保留）。 */
export function enqueueIntent(entries, intent) {
    if (entries.some((item) => item.intentId === intent.intentId))
        return entries.slice();
    return entries.concat([intent]);
}
/** 可重放：pending / syncing 且未耗尽预算，严格 FIFO。 */
export function replayable(entries) {
    return entries.filter((item) => (item.state === 'pending' || item.state === 'syncing') && item.attempts < MAX_ATTEMPTS);
}
/** 尝试次数 +1；达到预算即 failed 终态，停止自动重放。 */
export function markAttempt(entry, error) {
    const attempts = entry.attempts + 1;
    return { ...entry, attempts, state: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', lastError: error };
}
/** 推送尝试前置状态：syncing（跨会话持久化，崩溃后仍可重放）。 */
export function markSyncing(entry) {
    return { ...entry, state: 'syncing' };
}
/** 用户点「重试」的唯一复位语义：attempts=0 / pending；payload 完全不变。 */
export function retryIntent(entry) {
    return { ...entry, attempts: 0, state: 'pending', lastError: '' };
}
/** 出队已应用 / 已丢弃的意图。 */
export function dequeueIntents(entries, ids) {
    const done = new Set(ids);
    return entries.filter((item) => !done.has(item.intentId));
}
function countFailed(entries) {
    return entries.filter((item) => item.state === 'failed').length;
}
/** 门禁事实判定：schema → 分支 → HEAD/origin 相等，顺序固定。 */
export function gateOfFacts(schemaText, branch, head, origin) {
    const fresh = decideFreshStart(schemaText);
    if (fresh.unsupported) {
        return { ok: false, code: V2_ERROR.SCHEMA_UNKNOWN, message: fresh.reason, needSchema: false };
    }
    if (branch.trim() !== 'main') {
        return { ok: false, code: V2_ERROR.BRANCH_MISMATCH, message: '分支不是 main，拒绝写入', needSchema: fresh.needSchema };
    }
    if (head !== origin) {
        return {
            ok: false, code: V2_ERROR.NOT_SYNCED,
            message: '本地 HEAD 与 origin/main 不一致，本层不改写历史；下一步：确认本地领先提交是否带 dsh-dots-v2 尾注且只改 timeline/**，否则请人工协调后重试',
            needSchema: fresh.needSchema,
        };
    }
    return { ok: true, code: V2_ERROR.OK, message: '可写', needSchema: fresh.needSchema };
}
// ---------------------------------------------------------------- B1：意图形状硬守卫
/**
 * 重放前的类型化校验（B1）：任何 shape-invalid 的 upsert 都必须在这里止步。
 * 只做校验、不改 payload、不"规范化后继续"；非法即抛 typed E_CORRUPT。
 */
export function assertUpsertIntent(date, entry) {
    const reject = (detail) => {
        throw new SyncError(V2_ERROR.CORRUPT, `outbox upsert ${entry.intentId} ${detail}`, {
            intentId: entry.intentId, code: V2_ERROR.CORRUPT,
        });
    };
    if (!isValidTsShape(entry.ts))
        return reject(`的 ts 形状非法：${entry.ts}`);
    const record = parseRecordLine(entry.line);
    if (record === null)
        return reject('的 line 不是合法记录对象');
    if (record.id !== entry.id || record.ts !== entry.ts)
        return reject('的 (id,ts) 与 payload 不一致');
    // 与直接写路径共用同一个 planUpsert：其 buildRecordsText 自检挡下 title:123 / 坏 media 等。
    const plan = planUpsert(date, null, record);
    if (!plan.ok || plan.text === '')
        return reject(`形状非法：${plan.reason}`);
}
function tsCompare(left, right) {
    const a = tsMillis(left);
    const b = tsMillis(right);
    if (Number.isFinite(a) && Number.isFinite(b))
        return a === b ? 0 : (a < b ? -1 : 1);
    return left === right ? 0 : (left < right ? -1 : 1);
}
function recordsByLine(text, date) {
    const out = new Map();
    if (text.trim().length === 0)
        return out;
    const parsed = parseTimelineDay(text, date);
    if (parsed.day === null)
        return out;
    for (const record of parsed.day.allRecords)
        out.set(record.id, record);
    return out;
}
function conflictKey(row) {
    try {
        const obj = JSON.parse(row);
        return `${String(obj.id)}\u0000${String(obj.ts)}\u0000${String(obj.dedupeKey)}`;
    }
    catch {
        return row;
    }
}
/** M4：与 App `syncProtocol.ts:769-784` 逐字同口径的冲突行确定性排序。 */
export function sortConflictRows(rows) {
    return rows.slice().sort((left, right) => {
        let a = null;
        let b = null;
        try {
            const pa = JSON.parse(left);
            const pb = JSON.parse(right);
            if (pa !== null && typeof pa === 'object' && !Array.isArray(pa))
                a = pa;
            if (pb !== null && typeof pb === 'object' && !Array.isArray(pb))
                b = pb;
        }
        catch {
            // 坏行按整行字节序兜底
        }
        if (a === null || b === null)
            return byteCompare(left, right);
        const delta = tsCompare(String(a.ts), String(b.ts));
        if (delta !== 0)
            return delta;
        if (String(a.id) !== String(b.id))
            return String(a.id) < String(b.id) ? -1 : 1;
        return byteCompare(String(a.dedupeKey), String(b.dedupeKey));
    });
}
/**
 * 单日 union（阶段一）+ 意图重放（阶段二）。
 * 胜者规则与读侧 records.ts 完全一致：较晚 ts 静默胜；同 ts 取规范行 UTF-8 字节序较大者，
 * 败者原样进 conflicts.jsonl（按 id/ts/dedupeKey 去重）。远端与本地互换得到同一结果。
 * 非法意图与空文本哨兵在这里抛出 typed E_CORRUPT（B1），绝不返回可写文本。
 */
export function unionDay(date, remote, local, entries, now) {
    const remoteRecords = recordsByLine(remote.records, date);
    const localRecords = recordsByLine(local.records, date);
    const merged = new Map();
    const conflictRows = [];
    const seenConflict = new Set();
    const addConflict = (id, ts, losingLine) => {
        const row = conflictRowOf(id, ts, losingLine, decidedAtOf(ts, now));
        const key = conflictKey(row);
        if (seenConflict.has(key))
            return;
        seenConflict.add(key);
        conflictRows.push(row);
    };
    const ids = new Set([...remoteRecords.keys(), ...localRecords.keys()]);
    for (const id of ids) {
        const a = remoteRecords.get(id);
        const b = localRecords.get(id);
        if (a !== undefined && b !== undefined) {
            const lineA = canonicalRecordLine(a);
            const lineB = canonicalRecordLine(b);
            const delta = tsCompare(a.ts, b.ts);
            let winner;
            let loser = null;
            if (delta > 0) {
                winner = a;
                loser = b;
            }
            else if (delta < 0) {
                winner = b;
                loser = a;
            }
            else if (lineA === lineB) {
                winner = a;
            }
            else if (byteCompare(lineB, lineA) > 0) {
                winner = b;
                loser = a;
            }
            else {
                winner = a;
                loser = b;
            }
            merged.set(id, winner);
            // 不同 ts 是静默折叠，只有同 ts 的字节裁决败者才落审计（契约 §4）。
            if (loser !== null && delta === 0)
                addConflict(id, loser.ts, canonicalRecordLine(loser));
        }
        else if (a !== undefined) {
            merged.set(id, a);
        }
        else if (b !== undefined) {
            merged.set(id, b);
        }
    }
    const replay = replayable(entries).filter((item) => item.date === date);
    // B1：先校验所有 upsert，再动任何字节；校验失败抛错，调用方零写入。
    for (const entry of replay) {
        if (entry.op === 'upsert')
            assertUpsertIntent(date, entry);
    }
    const intentDeleted = [];
    const intentRestored = [];
    for (const entry of replay) {
        if (entry.op === 'delete' || entry.op === 'purgeRows') {
            intentDeleted.push(deletedLedgerLine(entry.id, entry.ts, entry.ts, entry.intentId));
        }
        else if (entry.op === 'restore') {
            intentRestored.push(restoredLedgerLine(entry.id, entry.ts, entry.ts));
        }
    }
    const deletedText = mergeLedgerText(local.deleted, [
        ...localLines(remote.deleted), ...intentDeleted,
    ], true).text;
    const restoreText = mergeLedgerText(local.restore, [
        ...localLines(remote.restore), ...intentRestored,
    ], false).text;
    const deletions = parseLedger(deletedText).entries;
    const restores = parseLedger(restoreText).entries;
    const applied = [];
    const dropped = [];
    let added = 0;
    for (const entry of replay) {
        if (entry.op !== 'upsert')
            continue;
        const incoming = parseRecordLine(entry.line);
        if (incoming === null) {
            throw new SyncError(V2_ERROR.CORRUPT, `outbox upsert ${entry.intentId} 的 line 无法解析`);
        }
        // P1-3(c)：并集账本里删除胜 → 有意丢弃，绝不复活。
        if (deletionState(incoming.id, deletions, restores) === 'deleted') {
            dropped.push(entry.intentId);
            continue;
        }
        const existing = merged.get(incoming.id);
        const incomingLine = canonicalRecordLine(incoming);
        if (existing === undefined) {
            merged.set(incoming.id, incoming);
            added += 1;
            applied.push(entry.intentId);
            continue;
        }
        const existingLine = canonicalRecordLine(existing);
        if (existingLine === incomingLine) {
            applied.push(entry.intentId);
            continue;
        }
        const delta = tsCompare(existing.ts, incoming.ts);
        if (delta > 0) {
            applied.push(entry.intentId);
            continue;
        }
        if (delta === 0) {
            addConflict(incoming.id, incoming.ts, byteCompare(incomingLine, existingLine) > 0 ? existingLine : incomingLine);
            if (byteCompare(incomingLine, existingLine) > 0) {
                merged.set(incoming.id, incoming);
            }
            applied.push(entry.intentId);
            continue;
        }
        merged.set(incoming.id, incoming);
        added += 1;
        applied.push(entry.intentId);
    }
    // 清行意图：只有账本确有删除时才可物理移除（P2-13：保留行也可，读侧仍过滤）。
    for (const entry of replay) {
        if (entry.op !== 'purgeRows')
            continue;
        if (deletionState(entry.id, deletions, restores) === 'deleted')
            merged.delete(entry.id);
        applied.push(entry.intentId);
    }
    const recordsText = recordsTextOf(date, [...merged.values()]);
    // B1 硬守卫：空串是 records.ts 的失败哨兵，绝不能被当作「空日」落盘。
    if (recordsText === '') {
        throw new SyncError(V2_ERROR.CORRUPT, `union(${date}) 产出空 records.json 哨兵，拒绝写入`);
    }
    return {
        date, recordsText, deletedText, restoreText,
        conflictRows: sortConflictRows(conflictRows), applied, dropped, added,
    };
}
function localLines(text) {
    return typeof text === 'string' ? text.split(/\r?\n/).filter((line) => line.length > 0) : [];
}
function parseRecordLine(line) {
    if (typeof line !== 'string' || line.trim().length === 0)
        return null;
    try {
        const parsed = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/** 与 App `decidedAtOf` 同口径：ts 不可解析时原样返回，不读墙钟（m1）。 */
function decidedAtOf(ts, _now) {
    const ms = Date.parse(ts);
    return Number.isNaN(ms) ? ts : new Date(ms).toISOString();
}
/** 阶段一前置完整性：任一侧非空 records.json 顶层坏 / date 不符 → E_CORRUPT（整日不动）。 */
export function dayIntegrityError(date, remote, local) {
    for (const text of [remote, local]) {
        if (text.trim().length === 0)
            continue;
        const parsed = parseTimelineDay(text, date);
        if (parsed.day === null)
            return `${date}: records.json 顶层不是合法 JSON 对象`;
        for (const error of parsed.errors) {
            if (error.message.includes('与目录日期') || error.message.includes('顶层不是合法 JSON')) {
                return `${date}: ${error.message}`;
            }
        }
    }
    return '';
}
/**
 * 领先提交是否全部是本模块自己产生的：behind===0 + 每条提交都带 body 尾注 +
 * subject 形状正确 + diff 只碰 timeline/**。subject 相同但无尾注的 App 提交一律不算。
 */
async function pendingIsOurs(git, instanceId) {
    const ab = await git.aheadBehind();
    if (ab.behind !== 0 || ab.ahead <= 0)
        return false;
    const commits = await git.aheadCommits();
    return commits.length > 0 && commits.every((commit) => isOursCommit(commit, instanceId));
}
/**
 * F1：恢复推送前的**同一套** refuse-and-park 校验。
 * 用真实 entries（不是 []）重算 union：`assertUpsertIntent` 在 unionDay 内部逐条执行，
 * 并要求重放并集的字节已经等于本地已提交文件——否则意图并未证明落在待推树里。
 * 任何失败都抛 typed E_CORRUPT：不推、不出队、不落盘（意图原样停放）。
 */
async function proveRecoveryState(ctx) {
    const replay = replayable(ctx.all);
    const appliedIds = [];
    for (const date of ctx.days) {
        const remote = {
            records: await ctx.git.showRemote(timelineRecordsPath(date)),
            deleted: await ctx.git.showRemote(timelineDeletedPath(date)),
            restore: await ctx.git.showRemote(timelineRestorePath(date)),
        };
        // m2：以 HEAD 的**提交字节**作为「已落在待推树里」的证据；工作树可能被别的写入者改脏。
        const local = {
            records: await ctx.git.showHead(timelineRecordsPath(date)),
            deleted: await ctx.git.showHead(timelineDeletedPath(date)),
            restore: await ctx.git.showHead(timelineRestorePath(date)),
        };
        // 关键：传真实 replay，unionDay 内部会对每条 upsert 调 assertUpsertIntent。
        const union = unionDay(date, remote, local, replay.filter((entry) => entry.date === date), ctx.now);
        if (union.recordsText !== local.records || union.deletedText !== local.deleted ||
            union.restoreText !== local.restore || union.conflictRows.length > 0) {
            throw new SyncError(V2_ERROR.CORRUPT, `恢复校验失败（${date}）：带意图的 union 字节与 HEAD 已提交文件不一致（工作树不算证据），意图未被证明已落地，拒绝推送与出队`, { date });
        }
        for (const id of union.applied)
            if (!appliedIds.includes(id))
                appliedIds.push(id);
    }
    return { appliedIds };
}
/**
 * 有界恢复：只在通过归属证明与带意图的 union 校验后才推送；
 * 只出队被证明已落在推送树里的意图；无硬回退 / 无变基 / 无文件写入。
 */
async function recoverPendingLocalCommit(ctx) {
    let all = ctx.all;
    let attempts = 0;
    for (let retry = 0; retry < MAX_CYCLE_RETRIES; retry += 1) {
        attempts += 1;
        // F1：先校验、再推；失败即 typed E_CORRUPT，零 push / 零出队 / 零 outbox 写入。
        let proven;
        try {
            proven = await proveRecoveryState(ctx);
        }
        catch (error) {
            const reason = typedError(error);
            return failure(V2_ERROR.CORRUPT, `E_CORRUPT: ${reason}`, all, 0);
        }
        let pushed = false;
        try {
            await ctx.git.pushMain(PUSH_ARGS);
            pushed = true;
        }
        catch (error) {
            const reason = typedError(error);
            // 推拒仍按契约停放（attempts 跨会话累计）；但绝不把未推提交报成成功。
            all = all.map((entry) => replayable([entry]).length > 0 ? markAttempt(entry, reason) : entry);
            ctx.all = all; // 预算累计带入下一轮校验
            await ctx.outbox.save(all);
        }
        if (pushed) {
            // F1：只出队 union 证明已落在树里的意图，不再假设「全部 replayable 都已应用」。
            const done = dequeueIntents(all, proven.appliedIds);
            await ctx.outbox.save(done);
            return {
                ok: true, code: V2_ERROR.OK, message: '已同步（本地未推提交已恢复）',
                days: [], applied: proven.appliedIds.length, dropped: 0, failed: countFailed(done),
                pending: replayable(done).length, attempts, conflicts: 0, writtenPaths: [], outbox: done.slice(),
            };
        }
        await ctx.git.fetchMain();
        if (!await pendingIsOurs(ctx.git, ctx.instanceId))
            break;
    }
    return failure(V2_ERROR.LOCAL_PENDING, `${LOCAL_PENDING_MESSAGE}（已重试 ${attempts} 次）`, all, attempts);
}
// ---------------------------------------------------------------- 周期
function failure(code, message, all, attempts) {
    return {
        ok: false, code, message, days: [], applied: 0, dropped: 0,
        failed: countFailed(all), pending: replayable(all).length, attempts,
        conflicts: 0, writtenPaths: [], outbox: all.slice(),
    };
}
function typedError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 单一 v2 同步周期。零写入的失败路径全部在第一个写句柄之前返回。
 * 成功路径才会出队并把 outbox 原子落盘；失败路径只会把意图 attempts+1 后停放。
 */
export async function runV2Cycle(options) {
    const { days, git, fs, outbox, now } = options;
    const instanceId = options.instanceId ?? DEFAULT_V2_INSTANCE_ID;
    let all = await outbox.load();
    // ── 阶段 0（只读）：schema 文本 → 门禁事实。schema 读取发生在任何 timeline 写句柄之前。
    const schemaText = (await fs.read(SCHEMA_MARKER_PATH)) ?? '';
    const facts = {
        schemaText,
        branch: await git.branchName(),
        head: '',
        origin: '',
    };
    // 未知 schema 立刻 typed 拒绝，零写入（连 outbox 都不写）。
    const preGate = gateOfFacts(facts.schemaText, facts.branch, '', '');
    if (!preGate.ok && preGate.code === V2_ERROR.SCHEMA_UNKNOWN) {
        return failure(preGate.code, preGate.message, all, 0);
    }
    if (!preGate.ok && preGate.code === V2_ERROR.BRANCH_MISMATCH) {
        return failure(preGate.code, preGate.message, all, 0);
    }
    // fetch 先于 HEAD 断言；传输失败不吞、不伪装成功。
    try {
        await git.fetchMain();
    }
    catch (error) {
        return failure(V2_ERROR.PULL_FAILED, `拉取远端失败：${typedError(error)}`, all, 0);
    }
    facts.head = await git.headSha();
    facts.origin = await git.originMainSha();
    const gate = gateOfFacts(facts.schemaText, facts.branch, facts.head, facts.origin);
    // M3：本地领先提交若全部是本模块的 [v2] 提交，不判永久 E_NOT_SYNCED，
    // 进入有界恢复（重取远端 → 重算 union → 重试推送），全程无硬回退 / 无变基。
    if (!gate.ok && gate.code === V2_ERROR.NOT_SYNCED) {
        let ours = false;
        try {
            ours = await pendingIsOurs(git, instanceId);
        }
        catch {
            ours = false;
        }
        if (ours) {
            return await recoverPendingLocalCommit({ git, outbox, days, now, all, instanceId });
        }
    }
    if (!gate.ok)
        return failure(gate.code, gate.message, all, 0);
    // ── 阶段一前置（只读）：所有受影响日先做完整性检查，任一日坏则整周期零写入。
    const reads = [];
    for (const date of days) {
        const remote = {
            records: await git.showRemote(timelineRecordsPath(date)),
            deleted: await git.showRemote(timelineDeletedPath(date)),
            restore: await git.showRemote(timelineRestorePath(date)),
        };
        const local = {
            records: (await fs.read(timelineRecordsPath(date))) ?? '',
            deleted: (await fs.read(timelineDeletedPath(date))) ?? '',
            restore: (await fs.read(timelineRestorePath(date))) ?? '',
        };
        const corrupt = dayIntegrityError(date, remote.records, local.records);
        if (corrupt !== '')
            return failure(V2_ERROR.CORRUPT, `E_CORRUPT: ${corrupt}`, all, 0);
        reads.push({ date, remote, local });
    }
    // ── B1：在任何写句柄之前计算并校验所有 union；非法意图 / 空串哨兵在这里 typed 失败。
    let unions = [];
    try {
        for (const read of reads)
            unions.push(unionDay(read.date, read.remote, read.local, all, now));
    }
    catch (error) {
        const reason = typedError(error);
        return failure(V2_ERROR.CORRUPT, `E_CORRUPT: ${reason}`, all, 0);
    }
    // ── 门禁通过、完整性/形状校验通过后的第一个写：缺标记则幂等创建规范 schema（④）。
    const writtenPaths = [];
    if (gate.needSchema) {
        const latest = (await fs.read(SCHEMA_MARKER_PATH)) ?? '';
        if (decideFreshStart(latest).needSchema) {
            await atomicReplace(fs, SCHEMA_MARKER_PATH, FRESH_SCHEMA_TEXT, 'schema');
            // m5：只有真的写了才纳入提交路径。
            if (!writtenPaths.includes(SCHEMA_MARKER_PATH))
                writtenPaths.push(SCHEMA_MARKER_PATH);
        }
    }
    // ── 阶段一 + 阶段二：union → replay → 落盘（records 原子替换，账本只追加）。
    const applied = [];
    const dropped = [];
    let conflicts = 0;
    let touchedDays = 0;
    for (let i = 0; i < reads.length; i += 1) {
        const read = reads[i];
        const union = unions[i];
        if (union.recordsText !== read.local.records) {
            await atomicReplace(fs, timelineRecordsPath(read.date), union.recordsText, 'records');
            if (!writtenPaths.includes(timelineRecordsPath(read.date)))
                writtenPaths.push(timelineRecordsPath(read.date));
            touchedDays += 1;
        }
        if (union.deletedText !== read.local.deleted) {
            const merged = mergeLedgerText(read.local.deleted, localLines(union.deletedText), true);
            if (merged.appended.length > 0) {
                await fs.append(timelineDeletedPath(read.date), merged.text.slice(read.local.deleted.length));
                if (!writtenPaths.includes(timelineDeletedPath(read.date)))
                    writtenPaths.push(timelineDeletedPath(read.date));
                touchedDays += 1;
            }
        }
        if (union.restoreText !== read.local.restore) {
            const merged = mergeLedgerText(read.local.restore, localLines(union.restoreText), false);
            if (merged.appended.length > 0) {
                await fs.append(timelineRestorePath(read.date), merged.text.slice(read.local.restore.length));
                if (!writtenPaths.includes(timelineRestorePath(read.date)))
                    writtenPaths.push(timelineRestorePath(read.date));
                touchedDays += 1;
            }
        }
        if (union.conflictRows.length > 0) {
            // 契约 §4：按 (id, ts, dedupeKey) 与已有审计行去重；同一冲突重放多次只落一行。
            const conflictsRel = `timeline/${read.date}/conflicts.jsonl`;
            const existingRows = localLines((await fs.read(conflictsRel)) ?? '');
            const seen = new Set(existingRows.map(conflictKey));
            const freshRows = union.conflictRows.filter((row) => {
                const key = conflictKey(row);
                if (seen.has(key))
                    return false;
                seen.add(key);
                return true;
            });
            if (freshRows.length > 0) {
                await fs.append(conflictsRel, `${freshRows.join('\n')}\n`);
                if (!writtenPaths.includes(conflictsRel))
                    writtenPaths.push(conflictsRel);
                conflicts += freshRows.length;
                touchedDays += 1;
            }
        }
        for (const id of union.applied)
            if (!applied.includes(id))
                applied.push(id);
        for (const id of union.dropped)
            if (!dropped.includes(id))
                dropped.push(id);
    }
    // dropped 与推送成败无关：先出队（不计 attempts）。
    all = dequeueIntents(all, dropped);
    // ── 提交 + 推送：只有真正有文件变化才提交；push 实参固定、无 force。
    let attempts = 0;
    if (writtenPaths.length > 0) {
        // m6：推送前把可重放意图标记为 syncing 并当场落盘（崩溃后预算不丢）。
        all = all.map((entry) => replayable([entry]).length > 0 ? markSyncing(entry) : entry);
        await outbox.save(all);
        await git.addPaths(writtenPaths.slice());
        // F2：尾注写进 body（第二个 -m），App 的 `-m subject` 不会产生它。
        await git.commit(syncCommitMessage(touchedDays), v2TrailerLine(instanceId));
        attempts = 1;
        try {
            await git.pushMain(PUSH_ARGS);
        }
        catch (error) {
            const reason = `E_PUSH_REJECTED: ${typedError(error)}；下一步：检查远端是否被其他设备推进，下一次同步会做有界重试，仍未成功请人工协调`;
            // 失败只停放意图（预算跨会话累计），绝不把未推送的本地提交报成成功。
            all = all.map((entry) => replayable([entry]).length > 0 ? markAttempt(entry, reason) : entry);
            await outbox.save(all);
            return failure(V2_ERROR.PUSH_REJECTED, reason, all, attempts);
        }
    }
    all = dequeueIntents(all, applied);
    await outbox.save(all);
    return {
        ok: true, code: V2_ERROR.OK, message: '已同步', days: days.slice(),
        applied: applied.length, dropped: dropped.length, failed: countFailed(all),
        pending: replayable(all).length, attempts, conflicts, writtenPaths: writtenPaths.slice(), outbox: all.slice(),
    };
}
/** 供调用方枚举仓库内已有的日程日（只读，路径来自共享 timeline/paths.ts）。 */
export function dayPathsOf(date) {
    return {
        records: timelineRecordsPath(date),
        deleted: timelineDeletedPath(date),
        restore: timelineRestorePath(date),
        summary: timelineSummaryPath(date),
    };
}
