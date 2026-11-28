/**
 * 会话导出：本机 zstd 会话 → 共享仓库里的明文 `chats/<id>/{session.jsonl,meta.json}` + `chats/index.jsonl`。
 *
 * 三个职责严格分开，别混：
 *   1. `buildChatExport`：**纯函数**（除读时间外无 IO）。隐私过滤 + 逐行校验 + 生成 meta；
 *   2. `uploadChats`：只做「落盘 + 每个会话一个 commit + 一次 push」。push 失败**不抛**、
 *      不删已写文件（`docs/CHAT-SYNC.md` §4：本地文件原样保留，下次可重试）；
 *   3. `readChatIndex`：只读 `chats/index.jsonl`，给 `chatExportStatus` 用。
 *
 * 隐私（`docs/CHAT-SYNC.md` §7 三处调用点，这里是插件侧的三层）：
 *   L1 `redactSecrets()`：`sk-…` / `Bearer …` / `Basic …` / `token=` / `ghp_…` 打码成 `sk-***`；
 *   L2 `scrubAbsolutePathsDeep()`：递归只处理 **string 值**，把 `C:\…`、`/Users/…`、`/home/…`、
 *      `\\server\share`、`file://…` 整段换成 `<redacted-path>`，并计数（`meta.redactions`）；
 *   L3 `scanForLeaks()`：写盘前对最终 JSONL 文本做静态扫描，命中即 fail-closed 整会话跳过。
 *
 * 注意：`redactSecrets` 在本包里**没有** engine 侧实现（`src/engine/secrets.ts` 只有结构化的
 * `stripSecretsDeep`，且本轮禁止修改 `src/engine/**`），所以按 App 侧
 * `apps/arkui-schedule/entry/src/main/ets/model/syncError.ts:84` 的同一套规则在下面**逐字复刻**。
 * 规则集必须与 App 侧保持一致，否则同一段文本在两端会得到不同结果。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { countMessages, firstUserTextOf, latestTitleOf, modelOf } from './readSessions.js';
import { foldChatIndex } from './foldChatIndex.js';
/** 共享命名空间（不是 `devices/<id>/`，见 `docs/CHAT-SYNC.md` §2）。 */
export const CHATS_DIR = 'chats';
/** 只追加的列表页索引。 */
export const INDEX_FILE_NAME = 'index.jsonl';
/** 明文会话文件（App 无需 zstd 解帧即可读）。 */
export const SESSION_JSONL_NAME = 'session.jsonl';
export const META_JSON_NAME = 'meta.json';
export const CHAT_SCHEMA_VERSION = 1;
/** 绝对路径的替换占位符（`docs/CHAT-SYNC.md` §7）。 */
export const REDACTED_PATH = '<redacted-path>';
/** 标题降级时取首条 user 文本的前 N 字。 */
const TITLE_FALLBACK_CHARS = 40;
/** meta.title 上限（防御性：标题可能是一整段话）。 */
const MAX_TITLE_CHARS = 200;
/** 索引行投影的字段（`docs/CHAT-SYNC.md` §2.4，多一个都不写）。 */
const INDEX_FIELDS = ['id', 'title', 'updatedAt', 'messageCount', 'sha256'];
/** 会话导出失败（fail-closed）：`code` 机器可读，`message` 只含原因，**不含正文/路径**。 */
export class ChatExportError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ChatExportError';
        this.code = code;
    }
}
/* -------------------------------------------------------------------------- */
/* L1：凭据打码（App 侧 syncError.ts:61 SECRET_PATTERNS 的逐字复刻）             */
/* -------------------------------------------------------------------------- */
/** 顺序敏感：先长前缀（Basic/Bearer/x-access-token），再裸 token 形态。 */
const SECRET_PATTERNS = [
    /(Basic\s+)[A-Za-z0-9+/=._~-]{8,}/g,
    /(Bearer\s+)[A-Za-z0-9+/=._~-]{8,}/g,
    /(x-access-token:)[^\s"',;]+/g,
    /((?:token|secret|password|access_token|api[_-]?key|aiKey)=)[^\s"'&,;]+/gi,
    /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    /\bsk-[A-Za-z0-9_-]{8,}\b/g,
];
/**
 * 把凭据打码：保留「标识前缀」，其余替换成 `***`。
 * 与 App 侧 `redactSecrets()` 行为一致；非字符串/空值返回空串。
 */
export function redactSecrets(raw) {
    if (typeof raw !== 'string' || raw.length === 0)
        return '';
    let text = raw;
    for (const pattern of SECRET_PATTERNS) {
        text = text.replace(pattern, (matched, prefix) => {
            if (typeof prefix !== 'string')
                return '***';
            return `${prefix}***`;
        });
    }
    return text;
}
/* -------------------------------------------------------------------------- */
/* L2：绝对路径替换（递归，只处理 string 值）                                    */
/* -------------------------------------------------------------------------- */
/**
 * 一个字符串值里所有「绝对路径样」的片段。
 *
 * 顺序要紧：先说 UNC（`\\server\share`）与 `file://`，再说盘符；
 * 盘符必须要求冒号前不是字母数字，否则 `https://x` 里的 `s://x` 会被误吞。
 */
const PATH_PATTERNS = [
    /\\\\[A-Za-z0-9._$-]+\\[^\s"']*/g,
    /\bfile:\/\/[^\s"']*/gi,
    /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"']*/g,
    /\/Users\/[^\s"']*/g,
    /\/home\/[^\s"']*/g,
    /\/root\/[^\s"']*/g,
];
/** 单个字符串：替换所有绝对路径片段，返回新串与替换次数。 */
export function scrubAbsolutePaths(text) {
    if (typeof text !== 'string' || text === '')
        return { text: typeof text === 'string' ? text : '', count: 0 };
    let result = text;
    let count = 0;
    for (const pattern of PATH_PATTERNS) {
        result = result.replace(pattern, () => {
            count += 1;
            return REDACTED_PATH;
        });
    }
    return { text: result, count };
}
/** 递归处理 JSON 树里的**每一个 string 值**（key 不动，数组/对象照走）。 */
export function scrubAbsolutePathsDeep(value) {
    let count = 0;
    const walk = (node) => {
        if (typeof node === 'string') {
            const scrubbed = scrubAbsolutePaths(node);
            count += scrubbed.count;
            return scrubbed.text;
        }
        if (Array.isArray(node))
            return node.map((item) => walk(item));
        if (node !== null && typeof node === 'object') {
            const out = {};
            for (const [key, child] of Object.entries(node))
                out[key] = walk(child);
            return out;
        }
        return node;
    };
    return { value: walk(value), count };
}
/* -------------------------------------------------------------------------- */
/* L3：写盘前的静态扫描（fail-closed）                                          */
/* -------------------------------------------------------------------------- */
/**
 * 命中即拒传的规则（`docs/CHAT-SYNC.md` §7 表格）。
 *
 * 注意匹配的是**最终 JSONL 文本**，所以 Windows 路径里的单个 `\` 在文本里是 `\\`；
 * 正则里的 `\\\\` 正好等于"文本里的两个反斜杠"。
 */
const LEAK_RULES = [
    { name: 'windows-user-path', re: /[A-Za-z]:\\\\+Users\\\\/i },
    { name: 'user-home-path', re: /\/home\/[^/\s"']+/ },
    { name: 'mac-user-path', re: /\/Users\/[^/\s"']+/ },
    { name: 'unc-user-path', re: /\\\\{2,}Users\\\\/i },
    { name: 'file-url', re: /\bfile:\/\//i },
    { name: 'api-key', re: /\bsk-[A-Za-z0-9_-]{8,}/ },
    { name: 'bearer-credential', re: /(?:Bearer|Basic)\s+[A-Za-z0-9+/=._~-]{12,}/ },
    { name: 'gh-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
];
/** 返回命中的规则名（空数组 = 干净）。只用于 fail-closed，不用于展示。 */
export function scanForLeaks(text) {
    const source = typeof text === 'string' ? text : '';
    const hits = [];
    for (const rule of LEAK_RULES) {
        if (rule.re.test(source))
            hits.push(rule.name);
    }
    return hits;
}
/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */
/** 同时认 `/` 与 `\` 的 basename（`path.basename` 在 POSIX 上认不出 `C:\a\b`）。 */
export function workspaceNameOf(cwd) {
    if (typeof cwd !== 'string')
        return '';
    const parts = cwd.split(/[\\/]+/).filter((item) => item !== '');
    return parts.length === 0 ? '' : parts[parts.length - 1];
}
function toIso(millis) {
    if (typeof millis === 'number' && Number.isFinite(millis) && millis >= 0) {
        const date = new Date(millis);
        if (!Number.isNaN(date.getTime()))
            return date.toISOString();
    }
    return '';
}
/** 会话 id 会直接做目录名：只允许安全字符，挡住 `..` / 分隔符 / 冒号。 */
function assertSafeSessionId(id) {
    if (id === '' || id.length > 200)
        throw new ChatExportError('bad-session-id', '会话 id 为空或过长');
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
        throw new ChatExportError('bad-session-id', '会话 id 含不安全字符，拒绝写进路径');
    }
}
/** 标题清洗：先打码凭据、再替换路径、最后截断（都不含正文以外的副作用）。 */
function cleanTitle(raw) {
    const redacted = redactSecrets(raw);
    const scrubbed = scrubAbsolutePaths(redacted);
    const collapsed = scrubbed.text.replace(/\s+/g, ' ').trim();
    return collapsed.length <= MAX_TITLE_CHARS ? collapsed : `${collapsed.slice(0, MAX_TITLE_CHARS)}…`;
}
/**
 * 构造一次导出的内存结果：`{ dir, id, meta, jsonl }`。
 *
 * fail-closed 清单（任何一条命中都**抛** `ChatExportError`，调用方据此跳过整会话并记原因）：
 *   - 明文为空（空会话）；
 *   - 有坏行（`session.badLines > 0`）；
 *   - 帧被截断 / 尾撕裂（`session.truncated`，`docs/CHAT-SYNC.md` §2.3「半行拒绝上传」）；
 *   - 没有 header（`type:"session"` 缺失）；
 *   - 脱敏后仍扫描出绝对路径/凭据（L3 兜底）。
 *
 * 输出约束：`jsonl` 每行是 `JSON.stringify` 后的紧凑单行（键序不变），LF 结尾——
 * 这是唯一与"原样搬运"不同的地方：为了做递归路径替换必须 parse 一次再序列化。
 */
export function buildChatExport(info, session, options) {
    if (session === null || typeof session !== 'object') {
        throw new ChatExportError('empty-session', '会话内容为空');
    }
    if (typeof session.rawJsonl !== 'string' || session.rawJsonl === '') {
        throw new ChatExportError('empty-session', '会话明文为空（没有可导出的行）');
    }
    if ((session.badLines ?? 0) > 0) {
        throw new ChatExportError('bad-jsonl', `会话明文含 ${session.badLines} 行坏 JSON，整会话跳过`);
    }
    if (session.truncated === true) {
        throw new ChatExportError('truncated-session', '会话文件尾部不完整（zstd 帧被截断或末行撕裂），整会话跳过');
    }
    if (session.header === null || session.header === undefined) {
        throw new ChatExportError('missing-header', '会话缺少 type="session" 的 header 行，整会话跳过');
    }
    const header = session.header;
    const headerId = typeof header.id === 'string' && header.id.trim() !== '' ? header.id.trim() : '';
    const sessionId = headerId !== '' ? headerId : info.sessionId;
    assertSafeSessionId(sessionId);
    const now = options.now ?? new Date();
    const updatedAt = Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString();
    const headerCreatedAt = toIso(header.createdAt);
    const fileMtime = toIso(info.mtime);
    const createdAt = headerCreatedAt !== '' ? headerCreatedAt : fileMtime !== '' ? fileMtime : updatedAt;
    const events = Array.isArray(session.events) ? session.events : [];
    const counts = countMessages(events);
    /* L1 + 逐行 JSON.parse 校验 + L2，一次遍历完成。 */
    const redacted = redactSecrets(session.rawJsonl);
    const rawLines = redacted.split('\n');
    const out = [];
    let redactions = 0;
    for (let index = 0; index < rawLines.length; index += 1) {
        const line = rawLines[index];
        if (line.trim() === '')
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            // 只报行号，绝不带出该行内容（隐私 + 日志纪律）。
            throw new ChatExportError('bad-jsonl', `脱敏后第 ${index + 1} 行不是合法 JSON，整会话跳过`);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new ChatExportError('bad-jsonl', `脱敏后第 ${index + 1} 行不是 JSON 对象，整会话跳过`);
        }
        const scrubbed = scrubAbsolutePathsDeep(parsed);
        redactions += scrubbed.count;
        out.push(JSON.stringify(scrubbed.value));
    }
    if (out.length === 0)
        throw new ChatExportError('empty-session', '会话明文没有非空行，整会话跳过');
    const jsonl = `${out.join('\n')}\n`;
    const leaks = scanForLeaks(jsonl);
    if (leaks.length > 0) {
        throw new ChatExportError('path-leak', `脱敏后仍命中静态扫描规则（${leaks.join(',')}），整会话跳过`);
    }
    /* 标题降级：显式覆盖 → header.title → 最后一条 session/title → 首条 user 前 40 字 → id。 */
    const headerTitle = typeof header.title === 'string' ? header.title : '';
    const fallbackUser = firstUserTextOf(events).slice(0, TITLE_FALLBACK_CHARS);
    const rawTitle = (typeof options.title === 'string' && options.title.trim() !== '' ? options.title : '') ||
        headerTitle ||
        latestTitleOf(events) ||
        fallbackUser ||
        sessionId;
    const title = cleanTitle(rawTitle) || sessionId;
    const meta = {
        schemaVersion: CHAT_SCHEMA_VERSION,
        sessionId,
        title,
        createdAt,
        updatedAt,
        messageCount: counts.user + counts.assistant,
        sha256: createHash('sha256').update(jsonl, 'utf8').digest('hex'),
        deviceId: options.deviceId,
        workspaceName: workspaceNameOf(header.cwd),
        redactions,
        lease: null,
    };
    const model = modelOf(events);
    if (model !== '')
        meta.model = model;
    return { dir: `${CHATS_DIR}/${sessionId}`, id: sessionId, meta, jsonl };
}
/** 读 `chats/index.jsonl` 的原文；文件不存在 / 读不到按空索引处理（fail-open 到空，不抛）。 */
async function readChatIndexText(indexFile) {
    try {
        return await readFile(indexFile, 'utf8');
    }
    catch {
        return '';
    }
}
/**
 * 当前隐藏 id 集合（mod-chat-hide 的导出抑制层）。
 *
 * 每次都**重新读盘**：选中前过滤与 `appendIndexLine` 前复核都调它，才能关住 TOCTOU 窗口。
 * 文件不存在 = 没有隐藏项；坏行只计数、不抛。
 */
export async function readHiddenChatIds(workDir) {
    const file = path.join(workDir, CHATS_DIR, INDEX_FILE_NAME);
    const folded = foldChatIndex(await readChatIndexText(file));
    return new Set(folded.hiddenIds);
}
/** 读 `chats/index.jsonl`；文件不存在按空索引处理，隐藏 id 不进正常投影，坏行只计数。 */
export async function readChatIndex(workDir) {
    const file = path.join(workDir, CHATS_DIR, INDEX_FILE_NAME);
    const folded = foldChatIndex(await readChatIndexText(file));
    return {
        entries: folded.entries,
        exported: folded.entries.length,
        lastExportAt: folded.lastExportAt,
        badLines: folded.badLines,
    };
}
/**
 * 只追加一行到 `chats/index.jsonl`。
 *
 * 「只追加」的实现保证：**从不重写**已有字节（`appendFile`），只在需要时先补一个 `\n`
 * （上一行没有行尾换行时才补）。首行字节因此在任何情况下都不变——App 侧与测试都依赖这点。
 */
async function appendIndexLine(indexFile, entry) {
    const line = {};
    for (const field of INDEX_FIELDS)
        line[field] = entry[field];
    const encoded = JSON.stringify(line);
    let needsNewline = false;
    try {
        const existing = await readFile(indexFile, 'utf8');
        needsNewline = existing.length > 0 && !existing.endsWith('\n');
    }
    catch {
        // 文件不存在：直接创建。
    }
    await appendFile(indexFile, `${needsNewline ? '\n' : ''}${encoded}\n`, 'utf8');
}
async function readPreviousCreatedAt(metaFile) {
    try {
        const parsed = JSON.parse(await readFile(metaFile, 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return '';
        const value = parsed.createdAt;
        return typeof value === 'string' && value !== '' ? value : '';
    }
    catch {
        return '';
    }
}
/** 把任意异常压成「可展示但无敏感信息」的一行原因。 */
export function sanitizeChatReason(error) {
    const raw = error instanceof Error ? error.message : String(error);
    const redacted = redactSecrets(raw).replace(/\s+/g, ' ').trim();
    const scrubbed = scrubAbsolutePaths(redacted).text;
    return scrubbed.length <= 200 ? scrubbed : `${scrubbed.slice(0, 200)}…`;
}
function reasonOf(error, fallback) {
    if (error instanceof ChatExportError)
        return error.code;
    const message = sanitizeChatReason(error);
    return message === '' ? fallback : `${fallback}: ${message}`;
}
/**
 * 写入共享仓库并提交/推送。
 *
 * 落盘顺序（每个会话独立一个 commit，`docs/CHAT-SYNC.md` §6「一次上传 = 一个 commit」）：
 *   `chats/<id>/session.jsonl` → `chats/<id>/meta.json` → `chats/index.jsonl` 追加一行 → commit。
 * 同 id 二次导出**覆盖**这两个文件（折叠语义）但 index 仍然**追加**新行。
 * 全部会话写完才 push 一次。
 *
 * 失败语义：任何一个环节出错都返回 `{ok:false, reason}`，**已写的本地文件一律保留**，
 * 因此下一次调用重试即可（push 失败时工作副本里就是待提交/待推送的内容）。
 */
export async function uploadChats(repo, exports, options = {}) {
    const result = { ok: true, sessionIds: [], commits: [], pushed: false };
    const list = Array.isArray(exports) ? exports.filter((item) => item !== null && typeof item === 'object') : [];
    if (list.length === 0)
        return result;
    try {
        if (typeof repo.ensureWorkTree === 'function')
            await repo.ensureWorkTree();
    }
    catch (error) {
        // 连工作副本都没有 → 一个字节都不写，直接失败（写进非 git 目录没有意义）。
        return { ok: false, reason: reasonOf(error, 'work-tree-unavailable'), sessionIds: [], commits: [], pushed: false };
    }
    const chatsRoot = path.join(repo.dir, CHATS_DIR);
    const indexFile = path.join(chatsRoot, INDEX_FILE_NAME);
    for (const item of list) {
        try {
            assertSafeSessionId(item.id);
            // 纵深第 2 层（写盘前）：隐藏集合每次重新读盘，命中即整会话跳过，不碰载荷。
            if ((await readHiddenChatIds(repo.dir)).has(item.id)) {
                throw new ChatExportError('deleted', '会话已隐藏，拒绝重新发布');
            }
            const sessionDir = path.join(chatsRoot, item.id);
            await mkdir(sessionDir, { recursive: true });
            const metaFile = path.join(sessionDir, META_JSON_NAME);
            const previousCreatedAt = await readPreviousCreatedAt(metaFile);
            const meta = previousCreatedAt === '' ? item.meta : { ...item.meta, createdAt: previousCreatedAt };
            await writeFile(path.join(sessionDir, SESSION_JSONL_NAME), item.jsonl, 'utf8');
            await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
            // 纵深第 2 层（TOCTOU）：**紧挨着 appendIndexLine 之前**再读一次。
            // 隐藏行可能在本次导出期间被平板追加进来；此时绝不能再写一条普通行去"刷新"它。
            if ((await readHiddenChatIds(repo.dir)).has(meta.sessionId)) {
                throw new ChatExportError('deleted', '会话在导出期间被隐藏，拒绝追加普通行');
            }
            await appendIndexLine(indexFile, {
                id: meta.sessionId,
                title: meta.title,
                updatedAt: meta.updatedAt,
                messageCount: meta.messageCount,
                sha256: meta.sha256,
            });
            const message = `chats: export ${meta.sessionId} (${meta.messageCount} msgs)`;
            const committed = await repo.commitAll(message, { onlyPath: CHATS_DIR });
            result.sessionIds.push(meta.sessionId);
            result.commits.push({ id: meta.sessionId, commit: committed.commit });
        }
        catch (error) {
            // 单个会话写失败不影响其它会话；但整体标记为失败（fail-closed 但不丢已写文件）。
            result.ok = false;
            result.reason = reasonOf(error, 'write-failed');
        }
    }
    if (!result.ok)
        return result;
    if (result.sessionIds.length === 0)
        return result;
    if (options.push === false)
        return result;
    try {
        const pushed = await repo.pushWithRebase();
        result.pushed = pushed.pushed;
        return result;
    }
    catch (error) {
        // push 失败：本地文件/提交都保留，下次重试即可。
        return { ...result, ok: false, pushed: false, reason: reasonOf(error, 'push-failed') };
    }
}
