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
import { ASKPASS_NODE_MISSING_CODE } from '../engine/nodePath.js';
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
/** 尾注存在但实例标识不是本模块（与「整条尾注缺失」区分）。 */
function hasOtherV2Trailer(body, instanceId) {
    const ours = v2TrailerLine(instanceId);
    return body.split(/\r?\n/).some((row) => {
        const line = row.trim();
        return line.startsWith(`${V2_TRAILER_PREFIX} `) && line !== ours;
    });
}
/**
 * 纯函数：逐条解释领先提交的归属。复用 isOursCommit / isV2CommitSubject /
 * hasV2Trailer / isConfinedTimelinePath 同一批严格谓词——本函数只**增解释**，
 * 不放宽任何一条：尾注缺失、实例不符、subject 非 v2 形状、diff 越界仍一律不算本模块。
 */
export function describePendingOwnership(commits, instanceId = DEFAULT_V2_INSTANCE_ID) {
    const verdicts = commits.map((commit, i) => {
        const subjectShape = isV2CommitSubject(commit.subject) ? 'v2' : 'other';
        const trailer = hasV2Trailer(commit.body, instanceId);
        const outsideScopePaths = commit.paths.filter((p) => !isConfinedTimelinePath(p)).length;
        const reasons = [];
        if (subjectShape !== 'v2')
            reasons.push('subject 不是 [v2] 形状');
        if (hasOtherV2Trailer(commit.body, instanceId))
            reasons.push('尾注实例标识不符');
        else if (!trailer)
            reasons.push('尾注缺失');
        if (outsideScopePaths > 0)
            reasons.push(`diff 越界 ${outsideScopePaths} 条`);
        if (commit.paths.length === 0)
            reasons.push('无 timeline 改动');
        const ours = isOursCommit(commit, instanceId);
        const verdict = ours
            ? 'ours'
            : (subjectShape === 'v2' && trailer && outsideScopePaths > 0 ? 'untrusted' : 'foreign');
        return {
            index: i + 1, verdict, subjectShape, trailer, outsideScopePaths,
            reason: ours ? '尾注与路径均合规' : (reasons.length > 0 ? reasons.join('；') : '归属不明'),
        };
    });
    const ours = commits.length > 0 && verdicts.every((v) => v.verdict === 'ours');
    const pieces = verdicts.map((v) => {
        const label = v.verdict === 'ours' ? '本模块' : (v.verdict === 'untrusted' ? '不可信' : '非本模块');
        return v.verdict === 'ours'
            ? `第 ${v.index} 条 ${label}`
            : `第 ${v.index} 条 ${label}（${v.reason}）`;
    });
    const summary = commits.length === 0
        ? '领先提交 0 条'
        : `领先提交 ${commits.length} 条：${pieces.join('；')}`;
    return { ours, verdicts, summary };
}
/** 意图是否已被某次提交认领（新字段优先；旧 outbox 用 attempts≥1 兜底）。 */
export function isCommittedIntent(entry) {
    return (typeof entry.commitSha === 'string' && entry.commitSha !== '') || entry.attempts >= 1;
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
 * 逐意图对照认领它的提交树（m2：只读 HEAD 的**已提交字节**，工作树不算证据）。
 *
 * 这是原 union 全量校验的替代：绝不把「尚未应用的新写入」并进一个与 HEAD 比对的 union，
 * 否则新意图必然让字节不等，被误判成「已提交却缺字节」→ E_CORRUPT（死锁的根因）。
 *
 * 三分支：
 * - present：同 (id[,ts]) 的规范字节已在提交树里 → (b) 出队 + 推送；
 * - absent：同 id 的行字节不符，或意图已被提交认领却找不到 → (a) 诚实 E_CORRUPT；
 * - unapplied：提交树里没有这个 id，且意图还没被任何提交认领 → (c) 应用→提交→再校验。
 *
 * 「认领本意图的提交」= `OutboxIntent.commitSha`（提交成功后回填），旧数据以 attempts≥1 兜底；
 * 已经认领的意图用 HEAD 提交树核对（HEAD 就是/包含那次提交），新意图不允许走这条捷径。
 */
export function classifyIntentLanding(intent, head, date) {
    const base = { intentId: intent.intentId };
    if (intent.date !== date)
        return { ...base, code: 'unapplied', reason: '意图日期不在本日' };
    if (intent.op === 'upsert') {
        const incoming = parseRecordLine(intent.line);
        if (incoming === null)
            return { ...base, code: 'absent', reason: 'line 不是合法记录对象' };
        const parsed = parseTimelineDay(head.records, date);
        const existing = parsed.day === null
            ? undefined
            : parsed.day.allRecords.find((record) => record.id === incoming.id);
        if (existing === undefined) {
            return isCommittedIntent(intent)
                ? { ...base, code: 'absent', reason: '认领提交的树里找不到同 id 记录' }
                : { ...base, code: 'unapplied', reason: '尚未应用到任何提交' };
        }
        // 同 id 但字节不符（含同 id 不同 ts 被更晚记录覆盖）：保守判为诚实拒绝。
        return canonicalRecordLine(existing) === canonicalRecordLine(incoming)
            ? { ...base, code: 'present', reason: '规范行已落在提交树里' }
            : { ...base, code: 'absent', reason: '同 id 的提交字节与意图 line 不符' };
    }
    // delete / purgeRows 落在 deleted.jsonl，restore 落在 restore.jsonl。
    const ledgerText = intent.op === 'restore' ? head.restore : head.deleted;
    const landed = parseLedger(ledgerText).entries.some((entry) => entry.id === intent.id && entry.ts === intent.ts);
    if (landed)
        return { ...base, code: 'present', reason: '账本行已落在提交树里' };
    return isCommittedIntent(intent)
        ? { ...base, code: 'absent', reason: '认领提交的账本里找不到该行' }
        : { ...base, code: 'unapplied', reason: '尚未应用到任何提交' };
}
/**
 * F1（修订）：先逐意图分类，再决定动作；不再做「全量 union 对 HEAD 一次比字节」。
 *
 * B1 形状校验仍先于任何写入/推送：畸形意图原样抛 E_CORRUPT。
 * (a) 缺字节的意图在这里抛 typed E_CORRUPT：不推、不出队、不落盘（意图原样停放）——
 * 这正是原检查的诚实拒绝，保留下来；区别只在于不再把未应用的新写入算成 (a)。
 */
async function proveRecoveryState(ctx) {
    const heads = new Map();
    for (const date of ctx.days) {
        heads.set(date, {
            records: await ctx.git.showHead(timelineRecordsPath(date)),
            deleted: await ctx.git.showHead(timelineDeletedPath(date)),
            restore: await ctx.git.showHead(timelineRestorePath(date)),
        });
    }
    // B1：先校验所有可重放意图的形状，畸形意图在推送/写入之前 typed 拒绝。
    for (const entry of replayable(ctx.all)) {
        if (entry.op === 'upsert')
            assertUpsertIntent(entry.date, entry);
    }
    const landedIds = [];
    const unapplied = [];
    for (const entry of replayable(ctx.all)) {
        const head = heads.get(entry.date);
        if (head === undefined)
            continue; // 不在本周期覆盖日的意图原样停放
        const verdict = classifyIntentLanding(entry, head, entry.date);
        if (verdict.code === 'absent') {
            throw new SyncError(V2_ERROR.CORRUPT, `恢复校验失败（${entry.date}）：意图 ${entry.intentId} 与 HEAD 已提交树不一致（sha=${entry.commitSha ?? `旧数据 attempts=${entry.attempts}`}；${verdict.reason}），意图未被证明已落地，拒绝推送与出队`, { date: entry.date, intentId: entry.intentId, sha: entry.commitSha ?? '' });
        }
        if (verdict.code === 'present') {
            if (!landedIds.includes(entry.intentId))
                landedIds.push(entry.intentId);
        }
        else {
            unapplied.push(entry);
        }
    }
    return { landedIds, unapplied };
}
/**
 * (c) 新意图：应用 → 提交 → 再校验，顺序不可颠倒。
 *
 * 以 HEAD 已提交字节为基线重算 union（工作树不算证据），写入后 add/commit，
 * 提交完成才把新的 commitSha 回填到意图并以新 HEAD 逐意图复核。
 * 任何一步失败都 typed E_CORRUPT，绝不带着未证明的字节去推送。
 */
async function applyUnappliedIntents(ctx, fresh) {
    const dates = [...new Set(fresh.map((entry) => entry.date))]
        .filter((date) => ctx.days.includes(date)).sort();
    const writtenPaths = [];
    let touchedDays = 0;
    for (const date of dates) {
        const remote = {
            records: await ctx.git.showRemote(timelineRecordsPath(date)),
            deleted: await ctx.git.showRemote(timelineDeletedPath(date)),
            restore: await ctx.git.showRemote(timelineRestorePath(date)),
        };
        // m2：基线取 HEAD 提交字节，不读工作树；避免把脏工作树当成已落地事实。
        const head = {
            records: await ctx.git.showHead(timelineRecordsPath(date)),
            deleted: await ctx.git.showHead(timelineDeletedPath(date)),
            restore: await ctx.git.showHead(timelineRestorePath(date)),
        };
        const corrupt = dayIntegrityError(date, remote.records, head.records);
        if (corrupt !== '')
            throw new SyncError(V2_ERROR.CORRUPT, `E_CORRUPT: ${corrupt}`, { date });
        const union = unionDay(date, remote, head, fresh.filter((entry) => entry.date === date), ctx.now);
        if (union.recordsText !== head.records) {
            await atomicReplace(ctx.fs, timelineRecordsPath(date), union.recordsText, 'records');
            if (!writtenPaths.includes(timelineRecordsPath(date)))
                writtenPaths.push(timelineRecordsPath(date));
            touchedDays += 1;
        }
        if (union.deletedText !== head.deleted) {
            const merged = mergeLedgerText(head.deleted, localLines(union.deletedText), true);
            if (merged.appended.length > 0) {
                await ctx.fs.append(timelineDeletedPath(date), merged.text.slice(head.deleted.length));
                if (!writtenPaths.includes(timelineDeletedPath(date)))
                    writtenPaths.push(timelineDeletedPath(date));
                touchedDays += 1;
            }
        }
        if (union.restoreText !== head.restore) {
            const merged = mergeLedgerText(head.restore, localLines(union.restoreText), false);
            if (merged.appended.length > 0) {
                await ctx.fs.append(timelineRestorePath(date), merged.text.slice(head.restore.length));
                if (!writtenPaths.includes(timelineRestorePath(date)))
                    writtenPaths.push(timelineRestorePath(date));
                touchedDays += 1;
            }
        }
        if (union.conflictRows.length > 0) {
            const conflictsRel = `timeline/${date}/conflicts.jsonl`;
            const existingRows = localLines((await ctx.fs.read(conflictsRel)) ?? '');
            const seen = new Set(existingRows.map(conflictKey));
            const freshRows = union.conflictRows.filter((row) => {
                const key = conflictKey(row);
                if (seen.has(key))
                    return false;
                seen.add(key);
                return true;
            });
            if (freshRows.length > 0) {
                await ctx.fs.append(conflictsRel, `${freshRows.join('\n')}\n`);
                if (!writtenPaths.includes(conflictsRel))
                    writtenPaths.push(conflictsRel);
                touchedDays += 1;
            }
        }
    }
    if (writtenPaths.length > 0) {
        await ctx.git.addPaths(writtenPaths.slice());
        await ctx.git.commit(syncCommitMessage(touchedDays), v2TrailerLine(ctx.instanceId));
    }
    const commitSha = await ctx.git.headSha();
    // 提交之后才校验：此刻 HEAD 就是认领这些新意图的提交。
    const landedIds = [];
    for (const entry of fresh) {
        if (!dates.includes(entry.date))
            continue;
        const head = {
            records: await ctx.git.showHead(timelineRecordsPath(entry.date)),
            deleted: await ctx.git.showHead(timelineDeletedPath(entry.date)),
            restore: await ctx.git.showHead(timelineRestorePath(entry.date)),
        };
        const verdict = classifyIntentLanding(entry, head, entry.date);
        if (verdict.code !== 'present') {
            throw new SyncError(V2_ERROR.CORRUPT, `恢复校验失败（${entry.date}）：意图 ${entry.intentId} 提交后仍未落在 HEAD（${verdict.reason}），拒绝推送与出队`, { date: entry.date, intentId: entry.intentId });
        }
        if (!landedIds.includes(entry.intentId))
            landedIds.push(entry.intentId);
    }
    return { landedIds, commitSha };
}
/**
 * 有界恢复：逐意图证明 (a)/(b)/(c) 后才推送；
 * 只出队被证明已落在推送树里的意图；无硬回退 / 无变基。
 */
async function recoverPendingLocalCommit(ctx) {
    let all = ctx.all;
    let attempts = 0;
    // 最近一次推拒的白名单化 typed 原因：原先只折进 outbox 的 attempts/lastError，
    // 终态消息完全看不到；这里只在终态读取，不改任何成功路径。
    let lastPushReason = '';
    for (let retry = 0; retry < MAX_CYCLE_RETRIES; retry += 1) {
        attempts += 1;
        ctx.all = all;
        // F1：先逐意图校验、再推；失败即 typed E_CORRUPT，零 push / 零出队 / 零 outbox 写入。
        let proof;
        try {
            proof = await proveRecoveryState(ctx);
        }
        catch (error) {
            return failure(V2_ERROR.CORRUPT, `E_CORRUPT: ${typedError(error)}`, all, 0);
        }
        let freshIds = [];
        if (proof.unapplied.length > 0) {
            try {
                // (c)：先应用→提交→再校验；提交完成才回填 commitSha 并标记 syncing 落盘。
                const applied = await applyUnappliedIntents(ctx, proof.unapplied);
                freshIds = applied.landedIds;
                const freshSet = new Set(proof.unapplied.map((entry) => entry.intentId));
                all = all.map((entry) => freshSet.has(entry.intentId)
                    ? { ...entry, commitSha: applied.commitSha, state: 'syncing' }
                    : entry);
                ctx.all = all;
                await ctx.outbox.save(all);
            }
            catch (error) {
                return failure(V2_ERROR.CORRUPT, `E_CORRUPT: ${typedError(error)}`, all, 0);
            }
        }
        const verifiedIds = [...proof.landedIds, ...freshIds];
        let pushed = false;
        try {
            await ctx.git.pushMain(PUSH_ARGS);
            pushed = true;
        }
        catch (error) {
            const reason = typedError(error);
            lastPushReason = typedPushReason(error);
            // 推拒仍按契约停放（attempts 跨会话累计）；但绝不把未推提交报成成功。
            all = all.map((entry) => replayable([entry]).length > 0 ? markAttempt(entry, reason) : entry);
            ctx.all = all; // 预算累计带入下一轮校验
            await ctx.outbox.save(all);
        }
        if (pushed) {
            // 只出队被逐意图证明已落在树里的意图（含刚提交的新意图）。
            const done = dequeueIntents(all, verifiedIds);
            await ctx.outbox.save(done);
            return {
                ok: true, code: V2_ERROR.OK, message: '已同步（本地未推提交已恢复）',
                days: [], applied: verifiedIds.length, dropped: 0, failed: countFailed(done),
                pending: replayable(done).length, attempts, conflicts: 0, writtenPaths: [], outbox: done.slice(),
            };
        }
        await ctx.git.fetchMain();
        if (!await pendingIsOurs(ctx.git, ctx.instanceId))
            break;
    }
    // 终态只在这里解释：逐条归属 + 最近一次 typed 推拒原因。判定与出队语义一字未动。
    const ownership = await describeAheadOwnership(ctx.git, ctx.instanceId);
    const parts = [`已重试 ${attempts} 次`, ownership.summary];
    if (lastPushReason !== '')
        parts.push(`最近一次推送失败：${lastPushReason}`);
    return failure(V2_ERROR.LOCAL_PENDING, `${LOCAL_PENDING_MESSAGE}（${parts.join('；')}）`, all, attempts);
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
/** node 解释器缺失的下一步：全文件唯一一份，push / branchName / fetch 共用。 */
export const ASKPASS_NODE_NEXT_STEP = '；下一步：安装 Node.js 或把 DSH_GIT_SYNC_NODE 指向 node.exe 后重试';
/** 超时的下一步：先怀疑耗时（首次预热 / 远端慢），与「不可达」的链路排查分开。 */
export const PUSH_TIMEOUT_NEXT_STEP = '；下一步：稍后重试；连续超时先检查网络与代理是否可用';
/** 网络不可达的下一步：只有解析/连接失败这一类才给链路排查指令。 */
export const PUSH_UNREACHABLE_NEXT_STEP = '；下一步：检查网络、代理或防火墙，确认远端地址可访问后重试';
/*
 * 四个「HTTP 状态码」原因的下一步：每一条都点名**真实原因**对应的动作，互不借用。
 * 原因本身由 `engine/git.ts` 的 `httpStatusReasonOf()` 唯一映射，这里只负责动作措辞。
 */
/** 远端拒绝了凭据（401/403）：改登录名/令牌，不是查网络。 */
export const PUSH_AUTH_REJECTED_NEXT_STEP = '；下一步：在设置里核对仓库登录名与私人令牌（需要写权限），令牌过期或被吊销后重新生成，不要把令牌填成登录密码';
/** 代理要它自己的凭据（407）：改代理配置，不是改仓库凭据。 */
export const PUSH_PROXY_AUTH_NEXT_STEP = '；下一步：检查 HTTPS_PROXY 的用户名与口令，或先关掉代理再试';
/** 远端服务器（**或中间代理/网关**）出错（5xx）：本地没有需要修的东西。 */
export const PUSH_REMOTE_ERROR_NEXT_STEP = '；下一步：稍后重试；连续出现先确认代理是否正常，再去看仓库状态页';
/** 远端限流（429）：等，别猛推。 */
export const PUSH_RATE_LIMITED_NEXT_STEP = '；下一步：等几分钟再试；先把多次小提交合并再推';
/**
 * 拿不出凭据（本机鉴权环境）：动作是**把登录名/令牌填全**，与 401/403 的「核对令牌」不同。
 * 旧实现让它共用 `DEFAULT_GIT_NEXT_STEP`（「检查远端是否被其他设备推进」），于是同一句
 * 「HTTPS 鉴权无法通过」后面跟着一句与鉴权无关的建议——文案自相矛盾（评审 b11b P2-2）。
 */
export const PUSH_AUTH_PROMPT_NEXT_STEP = '；下一步：检查登录名/令牌是否填全（设置里仓库登录名与私人令牌都不能空），再重试';
/** 其它 typed 码（含既有 E_PUSH_REJECTED）沿用原来的远端分叉建议，文案逐字节不变。 */
const DEFAULT_GIT_NEXT_STEP = '；下一步：检查远端是否被其他设备推进，下一次同步会做有界重试，仍未成功请人工协调';
/**
 * reason → 下一步的**完整表**：`sync/gitPort.ts` 能产出的九类原因在这里一一对应，
 * 少写一个就会落回 DEFAULT（因此 `test/push-auth-classification.test.mjs` 逐原因断言）。
 *
 * - 四个状态码原因各有独立动作（改令牌 / 改代理 / 等 / 等服务端恢复，5xx 那条同时提代理）；
 * - `timeout` / `unreachable` 各自保留原有措辞（超时与不可达是两种结局）；
 * - `auth-prompt` 有自己的动作（把登录名/令牌填全）——它的短语只说「鉴权无法通过」，
 *   不给动作就等于让用户去读那份「远端被推进」的建议（b11b P2-2）；
 * - `non-fast-forward` / `git-failed` **故意沿用** DEFAULT：这两类的短语本身已经写了动作
 *   （「下一次同步会做有界重试」），真正的远端分叉建议也正好是 `non-fast-forward` 想要的；
 *   改它们等于改动已钉死的字节。
 */
const PUSH_NEXT_STEP = Object.freeze({
    timeout: PUSH_TIMEOUT_NEXT_STEP,
    unreachable: PUSH_UNREACHABLE_NEXT_STEP,
    network: PUSH_UNREACHABLE_NEXT_STEP, // 旧字段兼容：network = unreachable
    'auth-rejected': PUSH_AUTH_REJECTED_NEXT_STEP,
    'proxy-auth': PUSH_PROXY_AUTH_NEXT_STEP,
    'remote-error': PUSH_REMOTE_ERROR_NEXT_STEP,
    'rate-limited': PUSH_RATE_LIMITED_NEXT_STEP,
    'auth-prompt': PUSH_AUTH_PROMPT_NEXT_STEP,
    'non-fast-forward': DEFAULT_GIT_NEXT_STEP,
    'git-failed': DEFAULT_GIT_NEXT_STEP,
});
/**
 * 下一步只按 typed `details.reason` 与码选一份，不再让超时复用「远端被推进」的建议。
 * 查不到（旧数据 / 未知 reason）时 fail-closed 回 DEFAULT，绝不留空。
 */
function nextStepOf(error) {
    if (typedCodeOf(error) === ASKPASS_NODE_MISSING_CODE)
        return ASKPASS_NODE_NEXT_STEP;
    const raw = error?.details?.reason;
    if (typeof raw === 'string') {
        const step = PUSH_NEXT_STEP[raw];
        // typeof 守卫同时挡住 `constructor` / `__proto__` 这类原型链键（它们不是 string）。
        if (typeof step === 'string')
            return step;
    }
    return DEFAULT_GIT_NEXT_STEP;
}
/**
 * typed 码判定：只有 SyncError 且 code 为 E_ 前缀才保留；其余一律走调用方兜底文案。
 * push / branchName / fetch 三处共用，杜绝任何一处把 typed 码误标成别的类别。
 */
export function typedCodeOf(error) {
    return error instanceof SyncError && typeof error.code === 'string' && /^E_[A-Z0-9_]+$/.test(error.code)
        ? error.code
        : '';
}
/**
 * git 阶段失败的统一解释：E_ typed 码原样保留（附诚实下一步），
 * 其它异常用调用方给的兜底码与文案（保持既有 byte-stable 行为）。
 */
export function gitStageFailure(error, fallback) {
    const code = typedCodeOf(error);
    if (code === '')
        return fallback;
    return { code, message: `${code}: ${typedError(error)}${nextStepOf(error)}` };
}
/**
 * typed 失败时把可重放意图停放并落盘：绝不留在 syncing、绝不报成功。
 * 非 typed 的既有失败路径不调用它，以保持原文案与落盘行为逐字节不变。
 */
async function parkTypedFailure(all, outbox, reason) {
    const parked = all.map((entry) => replayable([entry]).length > 0 ? markAttempt(entry, reason) : entry);
    await outbox.save(parked);
    return parked;
}
/** 终态消息允许出现的推送原因上限（字符）：只放白名单短语，不放原始 git stderr。 */
const MAX_TERMINAL_PUSH_REASON = 96;
/** 未通过白名单时的固定替代文案：只报类别，不报位置、原文或任何可还原片段。 */
const GENERIC_PUSH_REASON = '推送失败（原因类别未识别）';
/**
 * 只接受 `gitPort.pushFailure()` 的全部固定短语（8 条 + 1 个超时模板 = 9）；
 * 任何其它正文都不进终态消息。
 */
const ALLOWED_PUSH_REASONS = Object.freeze([
    '推送失败：HTTPS 鉴权无法通过（git 已禁用交互提示，askpass／用户名或令牌不可用）；请检查鉴权配置后重试',
    // b11 P2-6：凭据被远端拒绝与「拿不出凭据」是两件事，四条短语各自点名真实原因。
    '推送失败：远端拒绝了这个用户名或令牌（HTTP 401/403），凭据需要重新核对',
    '推送失败：代理要求它自己的鉴权（HTTP 407），不是仓库凭据的问题',
    '推送失败：远端限流（HTTP 429），稍后再推',
    // 5xx 不单方面归因给仓库：代理/网关回 502 时 git 的文案与仓库自己回 502 完全相同（b11b P2-3）。
    '推送失败：远端或代理返回 HTTP 5xx，本地改动与令牌都没有问题',
    '推送失败：远端分支已前进，下一次同步会做有界重试',
    '推送失败：网络不可达（无法解析或连接到远端）',
    // 超时短语的唯一变量是当次实际预算数字（push 恒为 PUSH_TIMEOUT_MS = 120000）：
    // 匹配前把 `>N 毫秒` 归一（见 singleLineSafeReason）。
    '推送失败：推送超时（>N 毫秒未完成，推送需上传本地对象，上传量大或远端响应慢）',
    '推送失败：git 拒绝了本次推送，请检查远端状态后重试',
]);
/**
 * 精确短语白名单（fail-closed）：折叠成单行、有界之后，只有逐字等于九条
 * pushFailure() 短语之一才通过；其它一切（含 UNC / 相对 / 全角路径、盘符、
 * 令牌、hex、超长串）都整段换成固定短语。不做部分打码、不做占位符替换。
 *
 * 超时短语里的 `>N 毫秒` 是唯一允许的变量：只把**纯数字**归一成 N 再做精确比对，
 * 命中后仍然输出带真实数字的原文（数字来自当次预算，不写死）。
 */
function singleLineSafeReason(text, max = MAX_TERMINAL_PUSH_REASON) {
    const flat = text.replace(/[\r\n\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const bounded = flat.slice(0, max);
    const canonical = bounded.replace(/>\d{1,6} 毫秒/, '>N 毫秒');
    return ALLOWED_PUSH_REASONS.includes(canonical) ? bounded : GENERIC_PUSH_REASON;
}
/** 从 push 异常提取 typed 原因：优先带出 E_ 码，正文只取白名单化的单行短句。 */
function typedPushReason(error) {
    const raw = error?.code;
    const code = typeof raw === 'string' && /^E_[A-Z0-9_]+$/.test(raw) ? raw : '';
    const msg = singleLineSafeReason(typedError(error));
    if (msg === '')
        return code;
    return code === '' ? msg : `${code}：${msg}`;
}
/** 只读地取当前领先提交并解释归属；读取失败也只降级一句话，不改终态语义。 */
async function describeAheadOwnership(git, instanceId) {
    try {
        return describePendingOwnership(await git.aheadCommits(), instanceId);
    }
    catch {
        return { ours: false, verdicts: [], summary: '领先提交读取失败' };
    }
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
    let branchName = '';
    try {
        branchName = await git.branchName();
    }
    catch (error) {
        // typed（例如 node 解释器缺失）必须原样带出并停放意图，绝不让异常逃出周期把 syncing 卡死。
        const decided = gitStageFailure(error, {
            code: 'E_GIT',
            message: `读取分支失败：${typedError(error)}`,
        });
        if (typedCodeOf(error) !== '')
            all = await parkTypedFailure(all, outbox, decided.message);
        return failure(decided.code, decided.message, all, 0);
    }
    const facts = {
        schemaText,
        branch: branchName,
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
    // fetch 先于 HEAD 断言；传输失败不吞、不伪装成功；typed 码原样带出并停放意图。
    try {
        await git.fetchMain();
    }
    catch (error) {
        const decided = gitStageFailure(error, {
            code: V2_ERROR.PULL_FAILED,
            message: `拉取远端失败：${typedError(error)}`,
        });
        if (typedCodeOf(error) !== '')
            all = await parkTypedFailure(all, outbox, decided.message);
        return failure(decided.code, decided.message, all, 0);
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
            return await recoverPendingLocalCommit({ git, fs, outbox, days, now, all, instanceId });
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
        // per-intent：提交成功后回填认领 sha；下次有界恢复据此逐意图核对，不再全量 union 比 HEAD。
        const committedSha = await git.headSha();
        all = all.map((entry) => replayable([entry]).length > 0
            ? { ...entry, commitSha: committedSha }
            : entry);
        await outbox.save(all);
        attempts = 1;
        try {
            await git.pushMain(PUSH_ARGS);
        }
        catch (error) {
            // 与 branchName / fetch 共用 gitStageFailure()：typed 码与下一步只有这一份判定。
            // E_ASKPASS_NODE_MISSING 来自 nodePath.ts 的 fail-closed 门禁，不能冒充远端分叉。
            const decided = gitStageFailure(error, {
                code: V2_ERROR.PUSH_REJECTED,
                message: `E_PUSH_REJECTED: ${typedError(error)}${DEFAULT_GIT_NEXT_STEP}`,
            });
            const reason = decided.message;
            // 失败只停放意图（预算跨会话累计），绝不把未推送的本地提交报成成功。
            all = all.map((entry) => replayable([entry]).length > 0 ? markAttempt(entry, reason) : entry);
            await outbox.save(all);
            return failure(decided.code, reason, all, attempts);
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
