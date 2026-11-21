/**
 * 远程实例允许清单（allow-list）：`instanceId → token-free base URL`。
 *
 * 为什么需要它：RPC 动作**只能**接 instanceId，绝不能接调用方给的 URL——
 * 否则 dots 正文里一段"请访问 http://attacker/..."就能把请求打到任意主机
 * （SSRF + 跨实例泄漏）。所有出网目标必须先在注册表里登记，且 URL 是 token-free base。
 *
 * 落盘位置：`~/.dsh/dots/dots-instances.json`（插件状态目录，同步仓库之外），
 * 单文件 `{v:1,items:[...]}` 原子写 + 0600，坏信封 → 只剩内置 `local`（fail-closed）。
 * 与 `remote.json` / `instance-grants.json` 同目录同纪律。
 *
 * 复用 `remote/urls.ts` 的纪律（token 打码 / URL 归一）而非另造一套：
 * `sanitizeBaseUrl()` 与 `redactUrlForDisplay` 使用同一批敏感参数名单，剥掉凭据与 token 类参数。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { statePaths } from '../engine/paths.js';
import { INSTANCE_ID_PATTERN } from './grants.js';
/** 与 `remote/types.ts` 的 RemoteAccessMode 保持同一批字面量。 */
export const INSTANCE_MODES = ['lan', 'tailscale', 'ipv6', 'cloudflare', 'manual', 'uu'];
/** token 类查询参数名（与 `service.ts::redactUrlForDisplay` 同一名单）。 */
const SENSITIVE_PARAM = /^(token|k|access_token|secret|password|pwd|ticket)$/i;
/**
 * 把用户/迁移来源给的地址收敛成 token-free base：
 *   - 只认 http(s) 绝对 URL；
 *   - 去掉 userinfo（user:pass@）；
 *   - 删掉所有 token 类查询参数与 fragment；
 *   - path 归一为 `/`（base 只到 origin）。
 * 非法输入返回空串（fail-closed，绝不返回半成品）。
 */
export function sanitizeBaseUrl(raw) {
    if (typeof raw !== 'string')
        return '';
    const text = raw.trim();
    if (text === '')
        return '';
    let url;
    try {
        url = new URL(text);
    }
    catch {
        return '';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return '';
    if (url.username !== '' || url.password !== '')
        return '';
    for (const key of Array.from(url.searchParams.keys())) {
        if (SENSITIVE_PARAM.test(key))
            url.searchParams.delete(key);
    }
    url.hash = '';
    url.pathname = '/';
    return url.toString();
}
/** 展示用打码（实例列表只回这个，不回真身 base）。 */
export function redactInstanceUrl(baseUrl) {
    if (baseUrl === '')
        return '';
    const clean = sanitizeBaseUrl(baseUrl);
    if (clean === '')
        return '';
    try {
        const url = new URL(clean);
        url.hostname = url.hostname.replace(/^(.{1,2}).*$/, '$1***');
        return url.toString();
    }
    catch {
        return '';
    }
}
function ensureDir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
}
function writeFilePrivate(file, content) {
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    try {
        renameSync(tmp, file);
    }
    catch {
        writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
        try {
            unlinkSync(tmp);
        }
        catch {
            /* 清理失败不影响结果 */
        }
    }
}
function normalizeInstance(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const item = raw;
    if (typeof item.id !== 'string' || !INSTANCE_ID_PATTERN.test(item.id) || item.id === 'local')
        return null;
    const mode = typeof item.mode === 'string' && INSTANCE_MODES.indexOf(item.mode) >= 0
        ? item.mode
        : 'manual';
    return {
        id: item.id,
        baseUrl: sanitizeBaseUrl(item.baseUrl),
        mode,
        displayName: typeof item.displayName === 'string' && item.displayName.trim() !== '' ? item.displayName.trim() : item.id,
    };
}
function decodeInstances(text) {
    if (text.trim() === '')
        return [];
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return [];
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return [];
    const envelope = parsed;
    if (envelope.v !== 1 || !Array.isArray(envelope.items))
        return [];
    const out = [];
    const seen = new Set();
    for (const raw of envelope.items) {
        const item = normalizeInstance(raw);
        if (item === null || seen.has(item.id))
            continue;
        seen.add(item.id);
        out.push(item);
    }
    return out;
}
/**
 * 实例允许清单。内置 `local` 恒存在且不可删除/改 URL；远程实例需显式登记。
 */
export class InstanceRegistry {
    file;
    local;
    items = null;
    constructor(options = {}) {
        const root = statePaths(options.homeDir).root;
        this.file = path.join(root, options.fileName ?? 'dots-instances.json');
        this.local = {
            id: 'local',
            baseUrl: sanitizeBaseUrl(options.localBaseUrl ?? ''),
            mode: 'manual',
            displayName: '本机',
        };
    }
    load() {
        if (this.items !== null)
            return this.items;
        let text = '';
        try {
            text = existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
        }
        catch {
            this.items = [];
            return this.items;
        }
        this.items = decodeInstances(text);
        return this.items;
    }
    commit(items) {
        const envelope = { v: 1, items };
        try {
            writeFilePrivate(this.file, JSON.stringify(envelope));
        }
        catch {
            /* 写失败保留内存镜像；下次读取会因文件损坏而回落（fail-closed） */
        }
        this.items = items.slice();
    }
    /** 全部实例（local 在前，其余按 id 字典序）。返回副本。 */
    list() {
        const remote = this.load().slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return [this.local, ...remote];
    }
    /** 按 id 精确解析；不在清单里返回 null（RPC 动作据此抛 E_INSTANCE_UNKNOWN）。 */
    get(id) {
        if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id))
            return null;
        if (id === 'local')
            return { ...this.local };
        const found = this.load().find((item) => item.id === id);
        return found === undefined ? null : { ...found };
    }
    /** 出网目标唯一来源：由 id 解析，绝不接受调用方 URL。 */
    baseUrlOf(id) {
        const instance = this.get(id);
        return instance === null ? null : instance.baseUrl;
    }
    /** 登记 / 替换一个远程实例；非法 id 或 local 一律拒绝。 */
    upsert(item) {
        if (item.id === 'local' || !INSTANCE_ID_PATTERN.test(item.id))
            return false;
        const normalized = normalizeInstance(item);
        if (normalized === null)
            return false;
        const next = this.load().filter((existing) => existing.id !== normalized.id);
        next.push(normalized);
        this.commit(next);
        return true;
    }
    /** 移除一个远程实例（local 不可移除）。 */
    remove(id) {
        if (id === 'local' || !INSTANCE_ID_PATTERN.test(id))
            return false;
        const next = this.load().filter((item) => item.id !== id);
        this.commit(next);
        return true;
    }
}
