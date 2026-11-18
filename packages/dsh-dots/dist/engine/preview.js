/**
 * 拉取预览（只读，不写任何文件）。
 *
 * 从已 fetch 的远端 ref 读 `devices/<deviceId>/` 快照，与本地采集结果逐条比对：
 *   - 用 manifest.json 的 sha256 校验远端文件（传输校验，fail-closed）；
 *   - patch 条目走 mergePatch（含 manual 判定），本地独有单独列出（永不删）；
 *   - 插件清单走 MERGE-only；provider / MCP 只做 id 级差异展示。
 * 预览结果缓存在内存（TTL 10 分钟，单实例只保留一个 previewId）。
 */
import { randomBytes } from 'node:crypto';
import { readProfilePatch, pluginsOf } from './collect.js';
import { diffText, summarizeFiles } from './diff.js';
import { SyncError } from './errors.js';
import { localOnlyKeys, mergePatch } from './patch.js';
import { mergePluginManifests } from './pluginMerge.js';
import { byteLength, sha256Hex } from './paths.js';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
export function settingsFingerprint(settings) {
    return sha256Hex(JSON.stringify([settings.repoUrl, settings.branch, settings.deviceId, settings.authMode, settings.scope])).slice(0, 16);
}
function readJsonObject(text) {
    if (typeof text !== 'string' || text.trim() === '')
        return null;
    try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map((item) => stableJson(item)).join(',')}]`;
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    const entries = Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(',')}}`;
}
function diffProviders(localText, remoteText) {
    const local = readJsonObject(localText)?.providers;
    const remote = readJsonObject(remoteText)?.providers;
    const localMap = local !== null && typeof local === 'object' ? local : {};
    const remoteMap = remote !== null && typeof remote === 'object' ? remote : {};
    const diff = { added: [], changed: [], same: [] };
    for (const id of Object.keys(remoteMap).sort()) {
        if (!(id in localMap))
            diff.added.push(id);
        else if (stableJson(localMap[id]) === stableJson(remoteMap[id]))
            diff.same.push(id);
        else
            diff.changed.push(id);
    }
    return diff;
}
function diffMcp(localText, remoteText) {
    const local = readJsonObject(localText)?.entries;
    const remote = readJsonObject(remoteText)?.entries;
    const index = (value) => {
        const map = new Map();
        if (!Array.isArray(value))
            return map;
        for (const item of value) {
            if (item === null || typeof item !== 'object')
                continue;
            const record = item;
            const id = typeof record.id === 'string' ? record.id : '';
            if (id === '' || map.has(id))
                continue;
            map.set(id, stableJson(record));
        }
        return map;
    };
    const localMap = index(local);
    const remoteMap = index(remote);
    const diff = { added: [], changed: [], same: [] };
    for (const id of Array.from(remoteMap.keys()).sort()) {
        if (!localMap.has(id))
            diff.added.push(id);
        else if (localMap.get(id) === remoteMap.get(id))
            diff.same.push(id);
        else
            diff.changed.push(id);
    }
    return diff;
}
function devicesInTree(paths) {
    const devices = new Set();
    for (const item of paths) {
        const match = /^devices\/([^/]+)\//.exec(item);
        if (match !== null)
            devices.add(match[1]);
    }
    return Array.from(devices).sort();
}
function normalizeManifest(text) {
    if (text === null)
        return null;
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object')
            return null;
        const record = parsed;
        if (!Array.isArray(record.files))
            return null;
        const files = record.files
            .filter((item) => item !== null && typeof item === 'object')
            .map((item) => {
            const name = typeof item.name === 'string' ? item.name : '';
            return {
                name: name,
                sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
                bytes: typeof item.bytes === 'number' ? item.bytes : 0,
            };
        })
            .filter((item) => item.name !== '');
        return {
            deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
            time: typeof record.time === 'string' ? record.time : '',
            scopes: typeof record.scopes === 'object' && record.scopes !== null ? record.scopes : {
                config: true,
                providers: true,
                plugins: true,
                mcp: true,
            },
            dshVersion: typeof record.dshVersion === 'string' ? record.dshVersion : '',
            files,
        };
    }
    catch {
        return null;
    }
}
/** 校验远端快照并读出四个文件；manifest 与内容不一致立即失败（fail-closed）。 */
async function readRemoteSnapshot(git, headSha, deviceId) {
    const prefix = `devices/${deviceId}/`;
    const manifestText = await git.showFile(headSha, `${prefix}manifest.json`);
    const manifest = normalizeManifest(manifestText);
    const names = ['cordis.patch.yml', 'providers.json', 'plugins.json', 'mcp.json'];
    const files = {};
    const sizes = [];
    for (const name of names) {
        const text = await git.showFile(headSha, `${prefix}${name}`);
        const content = text ?? '';
        files[name] = content;
        const sha256 = sha256Hex(content);
        const bytes = byteLength(content);
        const declared = manifest?.files.find((file) => file.name === name);
        if (declared !== undefined) {
            if (text === null) {
                throw new SyncError('E_SHA_MISMATCH', `远端快照 ${deviceId} 缺少 manifest 声明的文件 ${name}`, {
                    deviceId,
                    file: name,
                });
            }
            if (declared.sha256 !== '' && declared.sha256 !== sha256) {
                throw new SyncError('E_SHA_MISMATCH', `远端快照 ${deviceId} 的 ${name} 与 manifest 不一致`, {
                    deviceId,
                    file: name,
                    declared: declared.sha256,
                    actual: sha256,
                });
            }
        }
        sizes.push({ name, sha256, bytes });
    }
    if (manifest !== null && manifest.deviceId !== '' && manifest.deviceId !== deviceId) {
        throw new SyncError('E_SHA_MISMATCH', `远端快照目录 ${deviceId} 与 manifest 的 deviceId 不一致`, {
            dirDeviceId: deviceId,
            manifestDeviceId: manifest.deviceId,
        });
    }
    return { manifest, files, sizes };
}
export async function buildPreview(deps) {
    const { git } = deps;
    await git.ensureWorkTree();
    const fetched = await git.fetch();
    const headSha = fetched.headSha;
    const localPatch = readProfilePatch(deps.profileDir);
    const tree = headSha === '' ? [] : await git.listTree(headSha);
    const deviceIds = devicesInTree(tree).filter((deviceId) => deviceId !== deps.deviceId);
    const sources = [];
    const internalSources = [];
    for (const deviceId of deviceIds) {
        const snapshot = await readRemoteSnapshot(git, headSha, deviceId);
        const remotePatch = snapshot.files['cordis.patch.yml'];
        const merged = mergePatch(localPatch, remotePatch);
        const entries = merged.entries.map((entry) => ({
            id: entry.key,
            name: entry.name,
            status: entry.status,
            localText: entry.localText,
            remoteText: entry.remoteText,
            secretStripped: entry.secretStripped,
        }));
        const remotePlugins = pluginsOf(snapshot.files['plugins.json']);
        const plugins = mergePluginManifests(deps.localPlugins, remotePlugins);
        const source = {
            deviceId,
            headSha,
            files: snapshot.sizes,
            entries,
            plugins,
            providers: diffProviders(deps.localFiles['providers.json'], snapshot.files['providers.json']),
            mcp: diffMcp(deps.localFiles['mcp.json'], snapshot.files['mcp.json']),
            localOnly: localOnlyKeys(localPatch, remotePatch),
        };
        sources.push(source);
        internalSources.push({
            deviceId,
            headSha,
            patchRemote: remotePatch,
            entries,
            files: snapshot.sizes,
            manifest: snapshot.manifest,
            plugins,
        });
    }
    const previewId = randomBytes(12).toString('hex');
    const internal = {
        previewId,
        createdAt: deps.now.getTime(),
        fingerprint: deps.fingerprint,
        localPatch,
        sources: internalSources,
    };
    return { result: { previewId, sources }, internal, reachable: fetched.reachable };
}
/** 内存预览缓存：TTL 10 分钟，单实例只保留一个 previewId。 */
export class PreviewCache {
    current = null;
    ttlMs;
    constructor(ttlMs = DEFAULT_TTL_MS) {
        this.ttlMs = ttlMs;
    }
    set(preview) {
        this.current = preview;
    }
    get(previewId, nowMs = Date.now()) {
        if (this.current === null)
            return null;
        if (typeof previewId !== 'string' || previewId === '' || this.current.previewId !== previewId)
            return null;
        if (nowMs - this.current.createdAt > this.ttlMs) {
            this.current = null;
            return null;
        }
        return this.current;
    }
    peek() {
        return this.current;
    }
    clear() {
        this.current = null;
    }
}
/**
 * 把 `buildPreview` 的 **entry 级**差异转成文件级 `DiffSummary`。
 *
 * 远端快照只有脱敏后的四个文件，apply 真正改写的是 patch 里的条目，所以路径用
 * `devices/<deviceId>/cordis.patch.yml#<entryId>` 这种伪文件形式：一行对应一个条目，
 * 用户仍然能按「新增 / 修改 / 删除」分组并把差异展开成 hunk 文本。
 * providers / plugins / mcp 的 id 级差异仍由既有 `preview` 的 DiffList 展示，不在这里重复。
 */
export function fileDiffOfPreview(internal, options = {}) {
    const blocks = [];
    const allFiles = [];
    const allHunks = [];
    let truncated = false;
    for (const source of Array.isArray(internal?.sources) ? internal.sources : []) {
        const files = [];
        const hunks = [];
        let blockTruncated = false;
        for (const entry of Array.isArray(source.entries) ? source.entries : []) {
            const path = `devices/${source.deviceId}/cordis.patch.yml#${entry.id}`;
            // added → 远端新增；same → 一致；changed / manual → 会被改写（manual 需本地补值）。
            const kind = entry.status === 'added' ? 'added' : entry.status === 'same' ? 'same' : 'modified';
            const localText = typeof entry.localText === 'string' ? entry.localText : '';
            const remoteText = typeof entry.remoteText === 'string' ? entry.remoteText : '';
            const stat = {
                path,
                kind,
                addedLines: 0,
                removedLines: 0,
                beforeBytes: byteLength(localText),
                afterBytes: byteLength(remoteText),
            };
            if (kind !== 'same') {
                const result = diffText(localText, remoteText, { ...options, path });
                stat.addedLines = result.addedLines;
                stat.removedLines = result.removedLines;
                for (const hunk of result.hunks)
                    hunks.push(hunk);
                // 单条 entry 的 hunk 被预算截断 / 整段被丢弃 → 这一块就算"还有差异没展示"。
                if (result.truncated)
                    blockTruncated = true;
            }
            files.push(stat);
        }
        const block = {
            deviceId: source.deviceId,
            files,
            summary: summarizeFiles(files),
            hunks,
            truncated: blockTruncated,
        };
        blocks.push(block);
        for (const file of files)
            allFiles.push(file);
        for (const hunk of hunks)
            allHunks.push(hunk);
        if (blockTruncated)
            truncated = true;
    }
    return { files: allFiles, summary: summarizeFiles(allFiles), hunks: allHunks, truncated, sources: blocks };
}
