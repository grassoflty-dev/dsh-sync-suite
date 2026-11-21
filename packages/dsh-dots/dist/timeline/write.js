/**
 * v2 单时间线「写半侧」：原子替换、追加式账本、写计划、汇总 newer-wins。
 *
 * 职责边界（绑定决策 ②）：
 * - 本文件**只**通过 `./records.js` 的共享规范序列化器产出记录字节
 *   （`parseTimelineDay` / `buildRecordsText` / `canonicalRecordLine` / `openIdsOf`）；
 *   绝不另写一套 JSONL 编码器，也不碰 v1 `src/schedule/jsonl.ts`。
 * - IO 全部经 `TimelineFs` 注入：本文件本身不 import fs/promises 以外的写逻辑、
 *   不含 fetch / 网络调用；`NodeTimelineFs` 只是默认适配器。
 * - 与 App `services/timelineWriteStore.ets:509-570` 的 `atomicWriteIn` 同一纪律：
 *   同目录 tmp → 回读逐字节校验 → 覆盖式 rename →（失败才）备份原文件再 rename，
 *   任一步校验失败**保留现场、绝不覆盖正式文件**。
 *
 * 账本（deleted / restore / conflicts）严格「追加前缀不变」：
 * 旧字节永远是新字节的严格前缀，只追加、不重排、不重写历史行。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SyncError } from '../engine/errors.js';
import { buildRecordsText, canonicalRecordLine, conflictsLine, parseLedger, parseTimelineDay, tsMillis, } from './records.js';
import { assertTimelineDateKey, timelineConflictsPath, timelineDeletedPath, timelineRestorePath, timelineSummaryPath, } from './paths.js';
/** `TimelineFs` 的真实磁盘适配器（仓库根 = rootDir）。 */
export class NodeTimelineFs {
    rootDir;
    constructor(rootDir) {
        this.rootDir = rootDir;
    }
    abs(rel) {
        return path.join(this.rootDir, ...rel.split('/'));
    }
    async read(rel) {
        try {
            return await readFile(this.abs(rel), 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        }
    }
    async writeTemp(rel, text) {
        const target = this.abs(rel);
        await mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' });
        return path.relative(this.rootDir, temp).split(path.sep).join('/');
    }
    async readTemp(tempRel) {
        return await readFile(this.abs(tempRel), 'utf8');
    }
    async rename(tempRel, rel) {
        await rename(this.abs(tempRel), this.abs(rel));
    }
    async backupIfExists(rel, backupRel) {
        const target = this.abs(rel);
        const backup = this.abs(backupRel);
        await mkdir(path.dirname(backup), { recursive: true });
        try {
            await rename(target, backup);
            return true;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return false;
            throw error;
        }
    }
    async append(rel, text) {
        const target = this.abs(rel);
        await mkdir(path.dirname(target), { recursive: true });
        await appendFile(target, text, { encoding: 'utf8' });
    }
    async exists(rel) {
        try {
            await readFile(this.abs(rel));
            return true;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return false;
            throw error;
        }
    }
}
/** 逐字节回读校验：长度与内容都必须与拟写文本一致。 */
function verifyReadBack(actual, expected) {
    const expectedBytes = Buffer.byteLength(expected, 'utf8');
    const actualBytes = Buffer.byteLength(actual, 'utf8');
    if (actualBytes !== expectedBytes || actual !== expected) {
        throw new SyncError('E_ATOMIC_WRITE', `临时文件回读字节与待写内容不一致（期望 ${expectedBytes} 字节，实得 ${actualBytes} 字节），现场保留、正式文件未动`, { expectedBytes, actualBytes });
    }
}
/**
 * 同目录原子替换（App `atomicWriteIn` 的插件等价物）。
 * 校验失败时抛 typed 错误、保留 tmp 与正式文件原样；绝不先删正式文件。
 */
export async function atomicReplace(fs, rel, text, tag = 'w') {
    const suffix = `${tag}-${process.pid}-${Date.now()}`;
    const tempRel = await fs.writeTemp(rel, text);
    const backupRel = `${rel}.bak-${suffix}`;
    // ① 回读逐字节校验；失败即保留现场，绝不进入改名阶段。
    verifyReadBack(await fs.readTemp(tempRel), text);
    // ② 首选覆盖式 rename（原子，中间没有「正式文件不存在」窗口）。
    try {
        await fs.rename(tempRel, rel);
        return { ok: true, code: '', message: '', path: rel, backupPath: backupRel, backupKept: false, renamed: true };
    }
    catch (primary) {
        // ③ 回退：先把原文件改名备份（绝不 unlink），再让 tmp 顶上；失败则恢复备份。
        const hadOriginal = await fs.backupIfExists(rel, backupRel);
        try {
            await fs.rename(tempRel, rel);
        }
        catch (fallback) {
            if (hadOriginal) {
                await fs.rename(backupRel, rel);
            }
            throw new SyncError('E_ATOMIC_WRITE', `原子替换失败（${rel}）：${String(primary)} / ${String(fallback)}；已恢复原文件`, {
                path: rel, backupPath: backupRel,
            });
        }
        // ④ 备份文件保留在盘上（唯一可恢复副本），路径随结果上报，供运维人工核对。
        return {
            ok: true, code: '', message: '', path: rel, backupPath: backupRel,
            backupKept: hadOriginal, renamed: true,
        };
    }
}
// ---------------------------------------------------------------- 追加式账本
/** 账本行去重键：deleted 按 (id,ts,intentId)，restore 按 (id,ts)（契约 §7）。 */
function ledgerKey(line, withIntent) {
    let obj = null;
    try {
        const parsed = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            obj = parsed;
        }
    }
    catch {
        // 坏行原样保留，键退化为整行
    }
    if (obj === null || typeof obj.id !== 'string' || typeof obj.ts !== 'string')
        return line;
    const base = `${obj.id}\u0000${obj.ts}`;
    return withIntent && typeof obj.intentId === 'string' ? `${base}\u0000${obj.intentId}` : base;
}
function ledgerLines(text) {
    return typeof text === 'string' ? text.split(/\r?\n/).filter((line) => line.length > 0) : [];
}
/**
 * 纯函数：把 `incoming` 按去重键并进旧账本文本。
 * 不变量：旧字节恒为新字节的严格前缀；历史行原序不变、不重排。
 * union 阶段用它算出应落盘的文本，写阶段用同一函数算增量，杜绝两套口径。
 */
export function mergeLedgerText(oldText, incoming, withIntent = false) {
    const seen = new Set();
    for (const line of ledgerLines(oldText))
        seen.add(ledgerKey(line, withIntent));
    const appended = [];
    for (const line of incoming) {
        if (line.length === 0)
            continue;
        const key = ledgerKey(line, withIntent);
        if (seen.has(key))
            continue;
        seen.add(key);
        appended.push(line);
    }
    if (appended.length === 0)
        return { text: oldText, appended, prefixPreserved: true };
    const head = oldText.length === 0 || oldText.endsWith('\n') ? oldText : `${oldText}\n`;
    const text = `${head}${appended.join('\n')}\n`;
    return { text, appended, prefixPreserved: text.startsWith(oldText) };
}
/**
 * 只追加并集：把 `incoming` 按去重键并进旧账本。
 * 不变量：旧字节恒为新字节的严格前缀；历史行原序不变、不重排。
 */
export async function appendLedger(fs, rel, incoming, withIntent = false) {
    const before = await fs.read(rel);
    const oldText = before ?? '';
    const merged = mergeLedgerText(oldText, incoming, withIntent);
    if (merged.appended.length === 0) {
        return { ok: true, added: 0, text: oldText, prefixPreserved: true };
    }
    await fs.append(rel, merged.text.slice(oldText.length));
    return { ok: true, added: merged.appended.length, text: merged.text, prefixPreserved: merged.prefixPreserved };
}
/** 契约 §7 删除账本行（键序固定；仅账本使用，记录行仍走共享序列化器）。 */
export function deletedLedgerLine(id, ts, deletedAt, intentId) {
    const row = { id, ts, deletedAt };
    if (intentId !== undefined && intentId !== '')
        row.intentId = intentId;
    return JSON.stringify(row);
}
/** 契约 §7 撤销账本行（键序固定）。 */
export function restoredLedgerLine(id, ts, restoredAt) {
    return JSON.stringify({ id, ts, restoredAt });
}
/** 追加冲突审计行（去重键由 records.ts 的 conflictsLine 计算，写入侧只做前缀追加）。 */
export async function appendConflicts(fs, date, rows) {
    return await appendLedger(fs, timelineConflictsPath(date), rows, false);
}
/** 追加删除账本（按 id,ts,intentId 去重）。 */
export async function appendDeleted(fs, date, rows) {
    return await appendLedger(fs, timelineDeletedPath(date), rows, true);
}
/** 追加撤销账本（按 id,ts 去重）。 */
export async function appendRestored(fs, date, rows) {
    return await appendLedger(fs, timelineRestorePath(date), rows, false);
}
function failPlan(reason) {
    return { ok: false, text: '', reason, records: [] };
}
/** ts 形状门禁：ISO 8601 秒级 + 时区偏移，且可解析（与 App `isValidTsShape` 同口径）。 */
export function isValidTsShape(ts) {
    if (typeof ts !== 'string')
        return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(ts))
        return false;
    return Number.isFinite(tsMillis(ts));
}
/** 最新旧版本已关闭而本次不带 closed_at → 重新打开（刷新 opened_at，§6 P2-2）。 */
function wasClosedAndNowOpen(records, incoming) {
    const closed = incoming.closed_at;
    if (typeof closed === 'string' && closed.trim().length > 0)
        return false;
    let latestMs = null;
    let latestClosed = false;
    for (const existing of records) {
        if (existing.id !== incoming.id)
            continue;
        const ms = tsMillis(existing.ts);
        if (!Number.isFinite(ms))
            continue;
        if (latestMs === null || ms > latestMs) {
            latestMs = ms;
            const value = existing.closed_at;
            latestClosed = typeof value === 'string' && value.trim().length > 0;
        }
    }
    return latestClosed;
}
/** 从既有日文件文本取规范记录（parseTimelineDay 已按 id 折叠，不另造解析器）。 */
function recordsOfText(date, text) {
    if (text === null || text.trim().length === 0)
        return [];
    const parsed = parseTimelineDay(text, date);
    if (parsed.day === null)
        return [];
    return parsed.day.allRecords.slice();
}
/**
 * upsert 写计划：替换同 id 的全部旧版本行，产出共享序列化器构造的日文件全文。
 * `existingText` 为当日 records.json 原文（缺文件传 null / 空串）。
 */
export function planUpsert(date, existingText, record) {
    try {
        assertTimelineDateKey(date);
    }
    catch (error) {
        return failPlan(String(error));
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record))
        return failPlan('记录必须是 JSON 对象');
    if (typeof record.id !== 'string' || record.id.trim().length === 0)
        return failPlan('记录 id 必须是非空字符串');
    if (!isValidTsShape(record.ts))
        return failPlan('记录 ts 形状不合法');
    const prior = recordsOfText(date, existingText);
    const incoming = wasClosedAndNowOpen(prior, record)
        ? { ...record, opened_at: record.ts }
        : record;
    const next = prior.filter((item) => item.id !== record.id);
    next.push(incoming);
    const text = buildRecordsText(date, next);
    if (text === '')
        return failPlan('规范化后的记录文本无法通过解析自检');
    return { ok: true, text, reason: '', records: next };
}
/** remove 写计划：物理移除同 id 的全部版本行，id 不存在时幂等 no-op。 */
export function planRemove(date, existingText, id) {
    try {
        assertTimelineDateKey(date);
    }
    catch (error) {
        return failPlan(String(error));
    }
    if (typeof id !== 'string' || id.trim().length === 0)
        return failPlan('记录 id 必须是非空字符串');
    const prior = recordsOfText(date, existingText);
    const next = prior.filter((item) => item.id !== id);
    const text = buildRecordsText(date, next);
    if (text === '')
        return failPlan('规范化后的记录文本无法通过解析自检');
    return { ok: true, text, reason: '', records: next };
}
/** 供 union 阶段复用：把一批规范记录行交给共享序列化器构造日文件全文。 */
export function recordsTextOf(date, records) {
    return buildRecordsText(date, records);
}
/** 供 union 阶段复用：逐字节规范行（唯一序列化入口）。 */
export function canonicalLineOf(record) {
    return canonicalRecordLine(record);
}
/** 供 union 阶段复用：冲突审计行（唯一构造入口）。 */
export function conflictRowOf(id, ts, losingLine, decidedAt) {
    return conflictsLine(id, ts, losingLine, decidedAt);
}
function generatedAtOf(text) {
    if (text === null || text.trim().length === 0)
        return null;
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return null;
        const value = parsed.generatedAt;
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    catch {
        return null;
    }
}
/**
 * summary.json newer-wins：generatedAt 严格较新才原子替换；相等或更旧保留原字节；
 * 原文件损坏时同样保留（契约 §8：坏文件不抛、不静默覆盖）。
 */
export async function saveSummary(fs, date, incoming) {
    const rel = timelineSummaryPath(date);
    const oldText = await fs.read(rel);
    const oldAt = generatedAtOf(oldText);
    const newAt = generatedAtOf(incoming);
    if (newAt === null) {
        return { ok: false, written: false, code: 'E_VALIDATION', reason: 'summary 缺少合法 generatedAt', text: oldText ?? '' };
    }
    if (oldText !== null && (oldAt === null || newAt <= oldAt)) {
        return {
            ok: true, written: false, code: '', reason: oldAt === null ? '旧 summary 损坏，保留原字节' : 'generatedAt 不更新，保留原字节',
            text: oldText,
        };
    }
    const result = await atomicReplace(fs, rel, incoming, 'summary');
    if (!result.ok)
        return { ok: false, written: false, code: result.code, reason: result.message, text: oldText ?? '' };
    return { ok: true, written: true, code: '', reason: '', text: incoming };
}
/** 读取当日账本（供 cycle 复用同一解析入口，杜绝第二套账本解析）。 */
export function parseDeleted(text) {
    return parseLedger(text ?? '').entries;
}
export function parseRestored(text) {
    return parseLedger(text ?? '').entries;
}
