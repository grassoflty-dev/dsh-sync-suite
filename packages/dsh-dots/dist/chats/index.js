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
import { AUTO_EXPORT_PHASE_TIMEOUT_MS, CHAT_EXPORT_PER_RUN_CAP, ChatExportError, chatPayloadExists, indexEntryOf, isPublishablePresetHeader, readChatIndex, readHiddenChatIds, sanitizeChatReason, shouldExportChat, uploadChats, } from './exportChats.js';
import { buildChatExport } from './exportChats.js';
import { listLocalSessions, readSessionEvents } from './readSessions.js';
export * from './types.js';
export { AUTO_EXPORT_PHASE_TIMEOUT_MS, CHATS_DIR, CHAT_EXPORT_PER_RUN_CAP, CHAT_SCHEMA_VERSION, ChatExportError, INDEX_FILE_NAME, META_JSON_NAME, PUBLISHABLE_PRESET_IDS, REDACTED_PATH, SESSION_JSONL_NAME, buildChatExport, chatPayloadExists, indexEntryOf, isPublishablePresetHeader, isValidChatIndexLine, readChatIndex, readHiddenChatIds, recordedSha256Of, redactSecrets, sanitizeChatReason, scanForLeaks, scrubAbsolutePaths, scrubAbsolutePathsDeep, shouldExportChat, uploadChats, workspaceNameOf, writeChatExportPayloads, } from './exportChats.js';
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
/**
 * 白名单选择（产品裁决）：**不按时间、不按数量挑会话，也不按轮次挑**。
 * `header.agentPreset` 命中 `{'chat','dots'}` 才进入 sha256 门控；`standard` / null / 缺失 /
 * 非字符串 / 未知 id 一律是 work、永不发布（本机 888 个规范会话全是 work ⇒ 今天发布 0 个）。
 * 零轮的 chat / dots 会话**照常发布**：用户刚建好就应出现在平板；残余风险是它尚未被
 * `agentPresets.select` 锁定（只有产生过一轮的会话才锁定），本模块只读 header、从不改 preset。
 * `CHAT_EXPORT_PER_RUN_CAP = 50` 只是安全天花板，不是候选窗口，今天不可达。
 *
 * 时间上限 `AUTO_EXPORT_PHASE_TIMEOUT_MS` 只在会话边界检查：触顶时保留已构建的会话，
 * 剩余交给下一轮门控自然接上；本函数绝不起定时器、绝不重试。
 */
export async function selectAutoExportCandidates(options) {
    const requested = typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.floor(options.limit)
        : CHAT_EXPORT_PER_RUN_CAP;
    const cap = Math.max(0, Math.min(requested, CHAT_EXPORT_PER_RUN_CAP));
    const clock = typeof options.nowMs === 'function' ? options.nowMs : Date.now;
    const startedAt = clock();
    const selection = {
        exports: [], decisions: new Map(), considered: 0, skippedWork: 0,
        eligible: 0, skippedUnchanged: 0, skippedHidden: 0, truncated: 0, failures: 0,
        timedOut: false, remaining: 0,
    };
    const buildOptions = {
        deviceId: options.deviceId,
        ...(options.now !== undefined ? { now: options.now } : {}),
    };
    for (const info of options.local) {
        if (selection.exports.length >= cap)
            break;
        // 时间上限：只在会话边界停，绝不写到一半。
        if (clock() - startedAt >= AUTO_EXPORT_PHASE_TIMEOUT_MS) {
            selection.timedOut = true;
            break;
        }
        selection.considered += 1;
        if (options.hiddenIds.has(info.sessionId)) {
            selection.skippedHidden += 1;
            continue;
        }
        try {
            const events = await (options.readEvents ?? readSessionEvents)(info.file);
            // 第一道 allow-list：只在会话首行 header 上做 preset 全等，不猜路径/标题。
            // work 会话连 buildChatExport 都不调用；零轮的 chat / dots 会话照常进入门控。
            if (!isPublishablePresetHeader(events.header)) {
                selection.skippedWork += 1;
                continue;
            }
            selection.eligible += 1;
            const built = buildChatExport(info, events, buildOptions);
            const entry = indexEntryOf(options.index, built.id);
            const exists = await chatPayloadExists(options.workDir, built.id);
            // 第二道 allow-list：变更门控在 exportChats.ts 里用同一个谓词再验一次这份 header。
            const decision = shouldExportChat(built, entry, exists, events.header);
            if (decision.action === 'skip') {
                selection.skippedUnchanged += 1;
                continue;
            }
            selection.exports.push(built);
            selection.decisions.set(built.id, decision);
        }
        catch (error) {
            // 截断会话 fail-closed 跳过（truncated-session 已在 exportChats.ts 定义），其余继续。
            if (error instanceof ChatExportError && error.code === 'truncated-session')
                selection.truncated += 1;
            else
                selection.failures += 1;
        }
    }
    selection.remaining = Math.max(0, selection.eligible - selection.exports.length);
    return selection;
}
