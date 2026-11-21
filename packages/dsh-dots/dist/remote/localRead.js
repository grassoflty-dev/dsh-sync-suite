/**
 * 本机只读会话适配器（`instanceId === 'local'` 时使用）。
 *
 * 作用：让四个只读 action 在"本机"这条路上**不发起 HTTP**，从而避免
 * `local → HTTP → 同一插件 → local → …` 的递归；远程实例则由 RPC 层转发到
 * 对端插件的同名只读 action（对端再走它自己的 local 分支）。
 *
 * 只读纪律：只调用 `chats/readSessions.ts` 的扫描/解码函数，不写任何文件；
 * 输出只做白名单投影（title / seq / time / type / text），**不含绝对路径、
 * 不含会话正文里的工具参数原文、不含 token**。
 */
import { readFile } from 'node:fs/promises';
import { listLocalSessions, readSessionEvents, eventText } from '../chats/readSessions.js';
import { sha256Hex } from '../engine/paths.js';
function asPositiveInt(value, fallback) {
    const n = typeof value === 'number' ? value : Number.NaN;
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}
function asNonNegativeInt(value, fallback) {
    const n = typeof value === 'number' ? value : Number.NaN;
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}
function shaOfFile(file) {
    return readFile(file).then((bytes) => sha256Hex(bytes));
}
/** 本机会话列表：按 mtime 降序，limit 默认 50 / 上限 200，cursor 是 mtime 游标。 */
export async function localSessionList(args, homeDir) {
    const limit = Math.min(asPositiveInt(args.limit, 50), 200);
    const cursor = asNonNegativeInt(args.cursor, 0);
    const sessions = await listLocalSessions(homeDir === undefined ? {} : { homeDir });
    const page = sessions.filter((item) => item.mtime < cursor).slice(0, limit);
    const items = [];
    for (const session of page) {
        items.push({
            sessionId: session.sessionId,
            title: session.slug,
            updatedAt: new Date(session.mtime).toISOString(),
            messageCount: 0,
            sha256: await shaOfFile(session.file),
            instanceId: 'local',
            lease: null,
        });
    }
    const tail = page[page.length - 1];
    return { items, nextCursor: tail === undefined ? '' : String(tail.mtime) };
}
/** 本机单会话信息：找不到时返回 null（由 RPC 层映射成 E_NOT_FOUND）。 */
export async function localSessionInfo(args, homeDir) {
    if (typeof args.sessionId !== 'string' || args.sessionId === '')
        return null;
    const sessions = await listLocalSessions(homeDir === undefined ? {} : { homeDir });
    const found = sessions.find((item) => item.sessionId === args.sessionId);
    if (found === undefined)
        return null;
    return {
        instanceId: 'local',
        sessionId: found.sessionId,
        sha256: await shaOfFile(found.file),
        lease: null,
        owner: null,
    };
}
/** 本机会话事件：按 fromSeq 过滤，白名单投影，绝不回传原始 data（可能含工具参数/路径）。 */
export async function localSessionEvents(args, homeDir) {
    if (typeof args.sessionId !== 'string' || args.sessionId === '')
        return null;
    const sessions = await listLocalSessions(homeDir === undefined ? {} : { homeDir });
    const found = sessions.find((item) => item.sessionId === args.sessionId);
    if (found === undefined)
        return null;
    const decoded = await readSessionEvents(found.file);
    const fromSeq = asNonNegativeInt(args.fromSeq, 0);
    const limit = Math.min(asPositiveInt(args.limit, 200), 500);
    const events = [];
    let nextSeq = fromSeq;
    for (const event of decoded.events) {
        const seq = asNonNegativeInt(event.seq, -1);
        if (seq < fromSeq)
            continue;
        if (events.length >= limit)
            break;
        const type = typeof event.type === 'string' ? event.type : '';
        events.push({
            seq,
            time: typeof event.time === 'string' ? event.time : '',
            type,
            text: eventText(event.content).slice(0, 2000),
        });
        nextSeq = seq + 1;
    }
    return { events, nextSeq, sha256: await shaOfFile(found.file) };
}
