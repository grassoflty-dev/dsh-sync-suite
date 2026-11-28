/**
 * 会话导出：本机 zstd 会话 → 共享仓库里的明文 `chats/<id>/{session.jsonl,meta.json}` + `chats/index.jsonl`。
 *
 * 诚实告知（常驻声明，不是对话框）：会话正文会像日程一样自动同步到云端仓库，以明文 JSONL 保存并进入 Git 历史，无法抹除。
 * 隐私过滤只打码凭据与绝对路径，并不改变「正文入仓」这一事实；告知文案不得软化成「备份 / 加密保存 / 仅本地可见」。
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
/**
 * mod-plugin-chat-export-auto：**每轮最多发布 50 个 chat 会话的安全上限**。
 * 它是上限，不是选择窗口——绝不能按「最近 50 个」挑会话，否则会把 work 会话发出去。
 * 选择只认唯一白名单谓词 `isPublishablePresetHeader()`：preset 字面量恰在
 * `PUBLISHABLE_PRESET_IDS` 里的会话才是可发布的（chat / dots），
 * 零轮（刚创建）的会话也要发布（Lead 2026-11-28 裁决）。
 * 本机 readSessions 可见的 888 个规范会话全部是 `agentPreset:'standard'`（work），
 * 因此今天实际会发布 0 个；50 只是防御性天花板，保证将来真有可发布会话时
 * 单轮字节/时间仍有界，且远低于 `PUSH_TIMEOUT_MS = 120_000` 的推送纪律。
 *
 * 残余风险（照实记录，不在本 lane 关闭）：零轮的已发布会话尚未被 `agentPresets.select`
 * 锁定，只有产生过一轮的会话才锁定，因此它理论上仍可被重新选成别的 preset。
 * 本模块只读会话首行 header，**从不写、也不提供任何修改 preset 的 API**。
 */
export const CHAT_EXPORT_PER_RUN_CAP = 50;
/**
 * 每轮导出阶段的硬时间上限（毫秒），只覆盖解码 + 哈希 + 写盘，不含网络。
 * 20 s 远小于 `PUSH_TIMEOUT_MS = 120_000`；触顶时只在会话边界停下，
 * 已写文件与已追加的索引行保留，随后仍由周期统一提交一次、推送一次。
 */
export const AUTO_EXPORT_PHASE_TIMEOUT_MS = 20_000;
/**
 * 产品裁决（2026-11-28，三种会话形态）：可静默发布的 preset 白名单只有两项。
 *   - `'chat'`：我们的 chat 入口创建（preset `chat`），只做对话；
 *   - `'dots'`：我们的 dots 入口创建（preset `dots`），对话之外还有调整日程 / 定时任务 /
 *     远程控制访问远程 DSH 的能力。
 * DSH 自己 UI（preset `standard`）创建的 work 会话**只留本地、永不发布**。
 *
 * 这是 allow-list 精确全等，不是包含 / 前缀 / 大小写匹配；来源只有会话首行 header。
 * `standard` / `null` / `undefined` / 空串 / 非字符串 / 未知 id 一律 fail-closed 为 work。
 * 两份字面量只在这里出现一次；选择处与变更门控共用下面的同一个谓词，绝不各写一份成员判断。
 * 零轮会话也要发布：刚建好时本就没有轮次，用户期望它出现在平板上。
 *
 * P2-4：`Object.freeze(new Set(...))` 只是容器本身冻结，`set.add()` 仍能改内容，不是真不可变。
 * 这里换成冻结数组 + `includes`：数组冻结后没有可调用的增删成员方法，成员关系逐字节固定。
 */
export const PUBLISHABLE_PRESET_IDS = Object.freeze(['chat', 'dots']);
/**
 * 唯一的发布白名单谓词：两个调用点（选择 + 变更门控）都调它。
 * 先挡非对象 header，再挡非字符串 preset，最后才做一次 allow-list 成员判断。
 */
export function isPublishablePresetHeader(header) {
    if (header === null || header === undefined || typeof header !== 'object')
        return false;
    const preset = header.agentPreset;
    if (typeof preset !== 'string')
        return false;
    return PUBLISHABLE_PRESET_IDS.includes(preset);
}
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
/** 该 id 在隐藏感知折叠后的索引里最后一条普通行（没有则 undefined）。 */
export function indexEntryOf(index, id) {
    for (const entry of index.entries) {
        if (entry.id === id)
            return entry;
    }
    return undefined;
}
/**
 * 索引里记录的 sha256（设计 §2 的变更锚点）。
 * 走 `foldChatIndex` 后的投影：op 行只折叠隐藏状态，绝不会折成 `sha256:''` 打动门控；
 * 坏行折出的空串按「内容变了」处理，绝不静默跳过。
 */
export function recordedSha256Of(index, id) {
    return indexEntryOf(index, id)?.sha256;
}
/**
 * 纯函数：只有「本次 hash ≠ 索引记录的 sha256」或「索引有行但载荷文件缺失」才导出。
 * 不读盘、不写盘：`indexEntry` 与 `payloadExists` 由调用方从同一份工作副本取来。
 *
 * **第二道 allow-list**（第一道在 index.ts 的选择处）：`header.agentPreset` 必须命中同一个
 * `isPublishablePresetHeader()` 谓词，否则连 sha256 都不算就跳过。
 * work 会话因此在任何调用路径上都进不了发布账本。
 * 顺序要紧：preset 门 → sha 不同（全量重写 + 新 sha 行）→ 载荷缺失（修复 + 原 sha 行）。
 */
export function shouldExportChat(built, indexEntry, payloadExists, header) {
    if (!isPublishablePresetHeader(header))
        return { action: 'skip', reason: 'work-session' };
    if (indexEntry === undefined)
        return { action: 'export', reason: 'new' };
    const recorded = typeof indexEntry.sha256 === 'string' ? indexEntry.sha256 : '';
    if (recorded === '' || recorded !== built.meta.sha256)
        return { action: 'export', reason: 'sha256-changed' };
    if (!payloadExists)
        return { action: 'export', reason: 'payload-missing' };
    return { action: 'skip', reason: 'unchanged' };
}
/**
 * 载荷两件套是否都在工作副本里（「索引有行但载荷缺失」的判定源）。
 * id 先过与写盘同款的白名单，坏 id 一律返回 false，绝不拼进文件系统路径。
 */
export async function chatPayloadExists(workDir, id) {
    if (typeof id !== 'string' || id === '' || id.length > 200)
        return false;
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..')
        return false;
    try {
        await Promise.all([
            readFile(path.join(workDir, CHATS_DIR, id, SESSION_JSONL_NAME)),
            readFile(path.join(workDir, CHATS_DIR, id, META_JSON_NAME)),
        ]);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 索引普通行的 5 字段门禁（设计 §8）：缺字段 / 多字段 / 坏 JSON 一律拒绝。
 * `op` 行（隐藏 / 恢复）由 `foldChatIndex` 单独折叠，不在这里按 5 字段判定。
 */
export function isValidChatIndexLine(line) {
    try {
        const parsed = JSON.parse(line);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return false;
        const record = parsed;
        if (record.op !== undefined)
            return true;
        const keys = Object.keys(record);
        return keys.length === INDEX_FIELDS.length &&
            INDEX_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(record, field));
    }
    catch {
        return false;
    }
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
/**
 * 把门控放行的会话写进工作副本，**绝不 commit / push**（设计 §10 的 A + mutex）。
 *
 * 落盘顺序与 `uploadChats` 一致：`session.jsonl` → `meta.json` → `index.jsonl` 追加一行。
 * 唯一的提交与推送由 `sync/cycle.ts` 在 pull/快进之后统一做一笔；push 失败时不会留下
 * 本地 ahead 提交，下一周期也就不会变成事实上的 rebase（`exportChats.ts` 旧路径的陷阱）。
 *
 * 索引始终是「已成功发布」的唯一账本：修复场景追加一行**原 sha256**、新 `updatedAt`，
 * 旧行留在 Git 历史里；既有字节从不重写。
 */
export async function writeChatExportPayloads(workDir, exports, decisions) {
    const result = { ok: true, paths: [], writtenIds: [], repairedIds: [] };
    const list = Array.isArray(exports) ? exports.filter((item) => item !== null && typeof item === 'object') : [];
    if (list.length === 0)
        return result;
    const indexFile = path.join(workDir, CHATS_DIR, INDEX_FILE_NAME);
    // schema 门：任何一条坏普通行都让整轮导出在设计 §8 的失败语义下停住，
    // 零载荷写入、零索引半行；本轮没有进程内重试，也不起定时器。
    const existingIndex = await readChatIndexText(indexFile);
    if (existingIndex.split('\n').some((line) => line.trim() !== '' && !isValidChatIndexLine(line))) {
        return { ...result, ok: false, reason: 'index-schema-rejected' };
    }
    for (const item of list) {
        try {
            assertSafeSessionId(item.id);
            // 纵深第三道：门控给出 work-session 的会话绝不落盘（调用方绕开选择处也挡住）。
            if (decisions.get(item.id)?.reason === 'work-session')
                continue;
            // 隐藏集合每次重新读盘：写盘前与追加索引前各一次，关住 TOCTOU。
            if ((await readHiddenChatIds(workDir)).has(item.id))
                continue;
            const sessionDir = path.join(workDir, CHATS_DIR, item.id);
            await mkdir(sessionDir, { recursive: true });
            const metaFile = path.join(sessionDir, META_JSON_NAME);
            const previousCreatedAt = await readPreviousCreatedAt(metaFile);
            const meta = previousCreatedAt === '' ? item.meta : { ...item.meta, createdAt: previousCreatedAt };
            await writeFile(path.join(sessionDir, SESSION_JSONL_NAME), item.jsonl, 'utf8');
            await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
            if ((await readHiddenChatIds(workDir)).has(meta.sessionId))
                continue;
            await appendIndexLine(indexFile, {
                id: meta.sessionId,
                title: meta.title,
                updatedAt: meta.updatedAt,
                messageCount: meta.messageCount,
                sha256: meta.sha256,
            });
            // 路径用 POSIX 字面量拼，绝不把 Windows 反斜杠带进 git 路径或门禁白名单。
            for (const rel of [
                `${CHATS_DIR}/${item.id}/${SESSION_JSONL_NAME}`,
                `${CHATS_DIR}/${item.id}/${META_JSON_NAME}`,
                `${CHATS_DIR}/${INDEX_FILE_NAME}`,
            ]) {
                if (!result.paths.includes(rel))
                    result.paths.push(rel);
            }
            result.writtenIds.push(meta.sessionId);
            if (decisions.get(item.id)?.reason === 'payload-missing')
                result.repairedIds.push(meta.sessionId);
        }
        catch (error) {
            result.ok = false;
            result.reason = reasonOf(error, 'write-failed');
            break;
        }
    }
    return result;
}
