/**
 * cordis.patch.yml 的逐条合并。
 *
 * 关键约束（CONTRACT §2.2）：
 *   - 不使用 YAML 库；按顶层 `- ` 项切分，条目内部字节原样保留；
 *   - 注释、`!!js` 表达式、缩进、键顺序都不重排；
 *   - `serializePatch` 是字节级 round-trip，文件末尾恰好一个 `\n`；
 *   - 合并：本地顺序为准，本地独有保留，远端独有追加，同 key 不同 → 采用远端整块，
 *     远端含 `__SECRET__` 且不同 → manual（不自动覆盖）。
 */
import { SECRET_PLACEHOLDER, isSecretKey, splitYamlComment, stripPatchSecrets, unquoteYamlScalar, } from './secrets.js';
/** 顶层 YAML 序列项起始：行首 `-` 且后面是空白或行尾。 */
const ENTRY_START_RE = /^-([ \t]|$)/;
function isBlank(line) {
    return /^[ \t\r]*$/.test(line);
}
function isComment(line) {
    return /^[ \t]*#/.test(line);
}
function stripCommentValue(value) {
    return splitYamlComment(value).code.trim();
}
/** `- id: xxx` → xxx（去引号；允许行内注释）。 */
function parseIdLine(line) {
    const match = /^-\s+id\s*:\s*(.*)$/.exec(line);
    if (match === null)
        return null;
    const value = unquoteYamlScalar(stripCommentValue(match[1]));
    return value === '' ? null : value;
}
/** insert 块内第一个 `- id:`。 */
function parseInsertId(lines) {
    for (let index = 1; index < lines.length; index += 1) {
        const match = /^\s+-\s+id\s*:\s*(.*)$/.exec(lines[index]);
        if (match === null)
            continue;
        const value = unquoteYamlScalar(stripCommentValue(match[1]));
        if (value !== '')
            return value;
    }
    return null;
}
function makeEntry(header, lines, ordinal) {
    const raw = lines.join('\n');
    const first = lines[0] ?? '';
    let kind = 'other';
    let id = null;
    if (/^-\s+id\s*:/.test(first)) {
        kind = 'config';
        id = parseIdLine(first);
    }
    else if (/^-\s+insert\s*:\s*(#.*)?$/.test(first)) {
        kind = 'insert';
        id = parseInsertId(lines);
    }
    let key;
    if (kind === 'config' && id !== null)
        key = id;
    else if (kind === 'insert' && id !== null)
        key = `insert:${id}`;
    else
        key = `entry:${ordinal + 1}`;
    return { key, id, kind, raw, header };
}
/** 解析成 preamble + 顶层条目；空/null 输入按空文档处理。 */
export function parsePatch(text) {
    const doc = { preamble: [], entries: [] };
    if (text === null || text === undefined)
        return doc;
    const source = String(text);
    if (source === '')
        return doc;
    const lines = source.split('\n');
    // 末尾换行产生一个空元素；序列化时统一补回恰好一个 `\n`。
    if (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    const pending = [];
    let tail = [];
    let current = null;
    let ordinal = 0;
    const closeCurrent = () => {
        if (current === null)
            return;
        doc.entries.push(makeEntry(current.header, current.lines, ordinal));
        ordinal += 1;
        current = null;
    };
    for (const line of lines) {
        if (ENTRY_START_RE.test(line)) {
            // 条目之间的注释/空行属于"下一个条目"的前置注释（远端独有追加时要一起搬走）。
            const headerLines = current === null ? pending.splice(0, pending.length) : [];
            headerLines.push(...tail);
            tail = [];
            closeCurrent();
            current = { header: headerLines, lines: [line] };
            continue;
        }
        if (isBlank(line) || isComment(line)) {
            if (current === null)
                pending.push(line);
            else
                tail.push(line);
            continue;
        }
        if (current === null) {
            // 顶层非注释内容出现在任何条目之前：当作 preamble 原样保留。
            pending.push(line);
            continue;
        }
        // 条目内部的注释/空行后若还有内容，说明它们属于本条目内部。
        if (tail.length > 0) {
            for (const buffered of tail)
                current.lines.push(buffered);
            tail = [];
        }
        current.lines.push(line);
    }
    if (current !== null) {
        for (const buffered of tail)
            current.lines.push(buffered);
        tail = [];
        closeCurrent();
    }
    doc.preamble = pending;
    // 第一个条目前面的注释是文件头：归到 preamble，避免把"远端文件头"随条目搬到本地。
    const first = doc.entries[0];
    if (first !== undefined && first.header.length > 0) {
        doc.preamble = [...doc.preamble, ...first.header];
        first.header = [];
    }
    return doc;
}
/** 序列化：preamble/header/raw 原样拼接，末尾恰好一个换行。 */
export function serializePatch(doc) {
    const lines = [...doc.preamble];
    for (const entry of doc.entries) {
        for (const headerLine of entry.header)
            lines.push(headerLine);
        for (const rawLine of entry.raw.split('\n'))
            lines.push(rawLine);
    }
    while (lines.length > 0 && isBlank(lines[lines.length - 1]))
        lines.pop();
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
export function findEntryByKey(doc, key) {
    for (const entry of doc.entries) {
        if (entry.key === key)
            return entry;
    }
    return null;
}
/** 条目里是否带 `providers:`（collect 提取 provider 定义用）。 */
export function entryHasProviders(entry) {
    return /(^|\n)\s*providers\s*:/.test(entry.raw);
}
/** 条目 id/name 是否含 `mcp`（collect 提取 MCP 定义用）。 */
export function entryLooksLikeMcp(entry) {
    const id = (entry.id ?? '').toLowerCase();
    if (id.includes('mcp'))
        return true;
    return /(^|\n)\s*(?:-\s+)?(?:id|name)\s*:\s*['"]?[^'"\n]*mcp/i.test(entry.raw);
}
function localEntryText(entry) {
    try {
        return stripPatchSecrets(entry.raw).text;
    }
    catch {
        return entry.raw;
    }
}
function remoteEntryText(entry) {
    return localEntryText(entry);
}
function hasPlaceholder(text) {
    return text.includes(SECRET_PLACEHOLDER);
}
/** 条目里是否出现 secret key（用于 secretStripped 标记）。 */
function mentionsSecretKey(text) {
    for (const line of text.split('\n')) {
        const scan = splitYamlComment(line).code;
        const match = /^\s*(?:-\s+)?["']?([A-Za-z0-9_$@/.-]+)["']?\s*[:=]/.exec(scan);
        if (match !== null && isSecretKey(match[1]))
            return true;
    }
    return false;
}
/**
 * 逐条合并本地与远端 patch。
 *
 * 返回的 `text` 是"全部采纳"后的结果：changed 条目采用远端整块，added 追加到末尾，
 * manual 保持本地（不覆盖），same 不动。真正落盘时由 restore.ts 按用户勾选子集重新组合。
 */
export function mergePatch(localText, remoteText) {
    const localDoc = parsePatch(localText);
    const remoteDoc = parsePatch(remoteText);
    if (localDoc.entries.length === 0) {
        const entries = remoteDoc.entries.map((entry) => ({
            key: entry.key,
            name: entry.id ?? entry.key,
            status: 'added',
            localText: '',
            remoteText: remoteEntryText(entry),
            secretStripped: hasPlaceholder(entry.raw) || mentionsSecretKey(entry.raw),
        }));
        return { text: serializePatch(remoteDoc), entries };
    }
    const entries = localDoc.entries.map((entry) => ({ ...entry, header: [...entry.header] }));
    const indexByKey = new Map();
    entries.forEach((entry, index) => {
        if (!indexByKey.has(entry.key))
            indexByKey.set(entry.key, index);
    });
    const merged = [];
    const seenRemoteKeys = new Set();
    for (const remoteEntry of remoteDoc.entries) {
        let key = remoteEntry.key;
        let duplicate = false;
        if (seenRemoteKeys.has(key)) {
            // 同一份远端 patch 里 key 重复：退化成独立条目，避免覆盖同一条本地配置。
            key = `${remoteEntry.key}#${seenRemoteKeys.size + 1}`;
            duplicate = true;
        }
        seenRemoteKeys.add(remoteEntry.key);
        const localIndex = duplicate ? undefined : indexByKey.get(remoteEntry.key);
        if (localIndex === undefined) {
            entries.push({
                key,
                id: remoteEntry.id,
                kind: remoteEntry.kind,
                raw: remoteEntry.raw,
                header: [...remoteEntry.header],
            });
            merged.push({
                key,
                name: remoteEntry.id ?? remoteEntry.key,
                status: 'added',
                localText: '',
                remoteText: remoteEntryText(remoteEntry),
                secretStripped: hasPlaceholder(remoteEntry.raw) || mentionsSecretKey(remoteEntry.raw),
            });
            continue;
        }
        const localEntry = localDoc.entries[indexByKey.get(remoteEntry.key)];
        const localSanitized = localEntryText(localEntry);
        const remoteSanitized = remoteEntryText(remoteEntry);
        let status;
        if (localEntry.raw === remoteEntry.raw) {
            status = 'same';
        }
        else if (hasPlaceholder(remoteEntry.raw)) {
            // 远端快照里该块含占位符且与本地不同 → 绝不自动覆盖（需本地确认/填写）。
            status = 'manual';
        }
        else {
            status = 'changed';
            entries[localIndex].raw = remoteEntry.raw;
        }
        merged.push({
            key: remoteEntry.key,
            name: remoteEntry.id ?? remoteEntry.key,
            status,
            localText: localSanitized,
            remoteText: remoteSanitized,
            secretStripped: hasPlaceholder(remoteEntry.raw) || mentionsSecretKey(remoteEntry.raw),
        });
    }
    return { text: serializePatch({ preamble: [...localDoc.preamble], entries }), entries: merged };
}
/**
 * 以本地 patch 为底，把给定 block 按 key 替换/追加，返回完整文本。
 * 供 restore.ts 按用户勾选的子集落盘（不做任何密钥处理，调用方先回填）。
 */
export function composePatch(localText, blocks) {
    const doc = parsePatch(localText);
    const entries = doc.entries.map((entry) => ({ ...entry, header: [...entry.header] }));
    for (const block of blocks) {
        const index = entries.findIndex((entry) => entry.key === block.key);
        if (index >= 0) {
            entries[index] = { ...entries[index], raw: block.raw };
            continue;
        }
        const lines = block.raw.split('\n');
        const first = lines[0] ?? '';
        let kind = 'other';
        let id = null;
        if (/^-\s+id\s*:/.test(first)) {
            kind = 'config';
            id = parseIdLine(first);
        }
        else if (/^-\s+insert\s*:\s*(#.*)?$/.test(first)) {
            kind = 'insert';
            id = parseInsertId(lines);
        }
        entries.push({ key: block.key, id, kind, raw: block.raw, header: block.header === undefined ? [] : [...block.header] });
    }
    return serializePatch({ preamble: [...doc.preamble], entries });
}
/** 本地存在、远端没有的条目 key（预览里"本地独有（不删）"）。 */
export function localOnlyKeys(localText, remoteText) {
    const remoteKeys = new Set(parsePatch(remoteText).entries.map((entry) => entry.key));
    return parsePatch(localText)
        .entries.filter((entry) => !remoteKeys.has(entry.key))
        .map((entry) => entry.key);
}
/** 条目文本是否带 secret 占位符（apply 判定 needsLocal 用）。 */
export function entryHasSecretPlaceholder(raw) {
    return hasPlaceholder(raw);
}
export { isBlank, isComment };
