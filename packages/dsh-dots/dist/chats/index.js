/**
 * 云端对话模式 P1（插件侧）的**唯一入口**：`src/chats/` 对 RPC 层只暴露这里的函数与类型。
 *
 * 分工：
 *   - `readSessions.ts`：本机 zstd 帧 → 明文行（纯逻辑 + 解帧）；
 *   - `exportChats.ts`：明文 → `{meta, jsonl}`（隐私过滤）→ 落盘/提交/推送；
 *   - 本文件：把两者编排成 RPC 需要的三种结果（status / all / one），
 *     并保证**任何失败都不抛到 RPC 之外**（逐会话记原因，push 失败只降级整体 ok）。
 */
import path from 'node:path';
import { ChatExportError, readChatIndex, readHiddenChatIds, sanitizeChatReason, uploadChats } from './exportChats.js';
import { buildChatExport } from './exportChats.js';
import { listLocalSessions, readSessionEvents } from './readSessions.js';
export * from './types.js';
export { CHATS_DIR, CHAT_SCHEMA_VERSION, ChatExportError, INDEX_FILE_NAME, META_JSON_NAME, REDACTED_PATH, SESSION_JSONL_NAME, buildChatExport, readChatIndex, readHiddenChatIds, redactSecrets, sanitizeChatReason, scanForLeaks, scrubAbsolutePaths, scrubAbsolutePathsDeep, uploadChats, workspaceNameOf, } from './exportChats.js';
export { foldChatIndex } from './foldChatIndex.js';
export { SESSION_FILE_NAME, classifyEvents, countMessages, eventText, firstUserTextOf, frameByteLength, latestTitleOf, listLocalSessions, modelOf, readSessionEvents, resolveSessionsRoot, splitZstdFrames, } from './readSessions.js';
/** `chatExportAll` 的默认上限：一次推爆远端仓库没有意义（每会话最多几 MB 明文）。 */
export const DEFAULT_EXPORT_LIMIT = 50;
/** 硬上限：即使调用方传了更大的值也不越过（防止一次上传把工作副本/网络打满）。 */
export const MAX_EXPORT_LIMIT = 200;
/**
 * `chatExportStatus` 的实现。**绝不联网**：只扫本机会话目录 + 读工作副本里的 `chats/index.jsonl`。
 *
 * `pending` 是「本机有、index 里没有」的会话数；`exported` 是 index 里不同 id 的个数。
 */
export async function readChatExportStatus(options = {}) {
    const local = await listLocalSessions({
        ...(options.sessionsRoot !== undefined ? { sessionsRoot: options.sessionsRoot } : {}),
        ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    });
    const workDir = typeof options.workDir === 'string' ? options.workDir : '';
    const snapshot = workDir === '' ? null : await readChatIndex(workDir);
    const exportedIds = new Set((snapshot?.entries ?? []).map((entry) => entry.id));
    // 隐藏会话不再提示"待导出"：源 zstd 还在，但导出器会按隐藏集合跳过它。
    const hiddenIds = workDir === '' ? new Set() : await readHiddenChatIds(workDir);
    let pending = 0;
    for (const session of local) {
        if (!exportedIds.has(session.sessionId) && !hiddenIds.has(session.sessionId))
            pending += 1;
    }
    return {
        localSessions: local.length,
        exported: snapshot?.exported ?? 0,
        lastExportAt: snapshot?.lastExportAt ?? '',
        pending,
    };
}
/** 把 limit 归一：非正数/非数字 → 默认 50；超过硬上限 → 200。 */
export function normalizeLimit(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return DEFAULT_EXPORT_LIMIT;
    return Math.min(Math.floor(value), MAX_EXPORT_LIMIT);
}
function readFailureReason(error) {
    if (error instanceof ChatExportError)
        return error.code;
    const message = sanitizeChatReason(error);
    return message === '' ? 'read-failed' : `read-failed: ${message}`;
}
/**
 * 导出（构建 + 写盘 + 提交 + 推送）并返回逐会话结果。
 *
 * 关键语义：
 *   - **单个会话的读取/构建失败不抛**：只在 `results[]` 里记 `ok:false` + 原因码；
 *   - 写盘成功但 push 失败：`ok` 仍为 true（本地已落盘，可重试），
 *     `summary`/`reason` 里带整体失败原因；
 *   - 一个会话都没有可导出时 `pushed:false`，但不算失败（`ok:0 / failed:0`）。
 */
export async function exportChatsToRepo(options) {
    const limit = normalizeLimit(options.limit);
    const results = [];
    const pendingExports = [];
    const local = await listLocalSessions({
        ...(options.sessionsRoot !== undefined ? { sessionsRoot: options.sessionsRoot } : {}),
        ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    });
    const byId = new Map();
    for (const session of local)
        byId.set(session.sessionId, session);
    // 纵深第 1 层（选中前过滤）：隐藏会话既不构建也不上传，源 zstd 留着但绝不重新发布。
    const hiddenIds = await readHiddenChatIds(options.repo.dir);
    let selected = [];
    if (Array.isArray(options.sessionIds) && options.sessionIds.length > 0) {
        for (const requested of options.sessionIds) {
            const id = typeof requested === 'string' ? requested.trim() : '';
            if (id === '') {
                results.push({ id: '', ok: false, reason: 'bad-session-id' });
                continue;
            }
            if (hiddenIds.has(id)) {
                results.push({ id, ok: false, reason: 'deleted' });
                continue;
            }
            const found = byId.get(id);
            if (found === undefined) {
                results.push({ id, ok: false, reason: 'not-found' });
                continue;
            }
            selected.push(found);
        }
    }
    else {
        selected = local.filter((session) => !hiddenIds.has(session.sessionId)).slice(0, limit);
        for (const session of local) {
            if (hiddenIds.has(session.sessionId)) {
                results.push({ id: session.sessionId, ok: false, reason: 'deleted' });
            }
        }
    }
    const buildOptions = {
        deviceId: options.deviceId,
        ...(options.now !== undefined ? { now: options.now() } : {}),
    };
    for (const info of selected) {
        try {
            const session = await readSessionEvents(info.file);
            const built = buildChatExport(info, session, buildOptions);
            pendingExports.push(built);
        }
        catch (error) {
            results.push({ id: info.sessionId, ok: false, reason: readFailureReason(error) });
        }
    }
    let pushed = false;
    let failureReason;
    if (pendingExports.length > 0) {
        const uploadOptions = options.push === false ? { push: false } : {};
        const uploaded = await uploadChats(options.repo, pendingExports, uploadOptions);
        pushed = uploaded.pushed;
        const writtenIds = new Set(uploaded.sessionIds);
        for (const item of pendingExports) {
            if (writtenIds.has(item.id))
                results.push({ id: item.id, ok: true });
            else
                results.push({ id: item.id, ok: false, reason: uploaded.reason ?? 'write-failed' });
        }
        if (!uploaded.ok)
            failureReason = uploaded.reason ?? 'upload-failed';
    }
    const ok = results.filter((item) => item.ok).length;
    const outcome = {
        results,
        summary: { total: results.length, ok, failed: results.length - ok, limit },
        pushed,
    };
    if (failureReason !== undefined)
        outcome.reason = failureReason;
    return outcome;
}
/** 供 RPC 层拼工作副本路径（`work/<repoHash>/chats`）时复用。 */
export function chatsDirOf(workDir) {
    return path.join(workDir, 'chats');
}
