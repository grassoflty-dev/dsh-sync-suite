const VERSION_RE = /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export function parseVersion(version) {
    if (typeof version !== 'string')
        return null;
    const trimmed = version.trim().replace(/^[=~^]+/, '');
    const match = VERSION_RE.exec(trimmed);
    if (match === null)
        return null;
    const numbers = match[1].split('.').map((part) => Number.parseInt(part, 10));
    const prerelease = match[2] === undefined ? [] : match[2].split('.');
    return { numbers, prerelease };
}
/** 语义化版本比较：a < b 返回 -1，相等 0，a > b 返回 1。 */
export function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (left === null || right === null) {
        const sa = String(a).trim();
        const sb = String(b).trim();
        if (sa === sb)
            return 0;
        return sa < sb ? -1 : 1;
    }
    const length = Math.max(left.numbers.length, right.numbers.length);
    for (let i = 0; i < length; i += 1) {
        const ln = left.numbers[i] ?? 0;
        const rn = right.numbers[i] ?? 0;
        if (ln !== rn)
            return ln < rn ? -1 : 1;
    }
    // 无 prerelease 的版本 > 有 prerelease 的版本
    if (left.prerelease.length === 0 && right.prerelease.length === 0)
        return 0;
    if (left.prerelease.length === 0)
        return 1;
    if (right.prerelease.length === 0)
        return -1;
    const preLength = Math.max(left.prerelease.length, right.prerelease.length);
    for (let i = 0; i < preLength; i += 1) {
        const lp = left.prerelease[i];
        const rp = right.prerelease[i];
        if (lp === undefined)
            return -1;
        if (rp === undefined)
            return 1;
        const ln = /^\d+$/.test(lp) ? Number.parseInt(lp, 10) : null;
        const rn = /^\d+$/.test(rp) ? Number.parseInt(rp, 10) : null;
        if (ln !== null && rn !== null) {
            if (ln !== rn)
                return ln < rn ? -1 : 1;
            continue;
        }
        if (ln !== null)
            return -1;
        if (rn !== null)
            return 1;
        if (lp !== rp)
            return lp < rp ? -1 : 1;
    }
    return 0;
}
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** 包名是否像合法 npm 包名（用于识别不可解析条目）。 */
export function isResolvableName(name) {
    return typeof name === 'string' && PACKAGE_NAME_RE.test(name.trim());
}
/**
 * 来源是否可解析：接受版本范围、npm alias、git/github/file 协议等，
 * 但拒绝空串与含空白的乱码（不可解析 → 整个条目 skip，不猜）。
 */
export function isResolvableSource(source) {
    if (typeof source !== 'string')
        return false;
    const trimmed = source.trim();
    if (trimmed === '' || trimmed.length > 512)
        return false;
    return !/\s/.test(trimmed);
}
function isResolvableEntry(entry) {
    return isResolvableName(entry.name) && isResolvableSource(entry.source);
}
function byName(entries) {
    const map = new Map();
    for (const entry of entries) {
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (name === '' || map.has(name))
            continue;
        map.set(name, { ...entry, name });
    }
    return map;
}
export function mergePluginManifests(local, remote) {
    const localMap = byName(Array.isArray(local) ? local : []);
    const remoteMap = byName(Array.isArray(remote) ? remote : []);
    const result = { install: [], keep: [], skip: [], noDowngrade: [] };
    const keepNames = new Set();
    const pushKeep = (entry) => {
        if (keepNames.has(entry.name))
            return;
        keepNames.add(entry.name);
        result.keep.push(entry);
    };
    const pushSkip = (name, reason) => {
        if (result.skip.some((item) => item.name === name && item.reason === reason))
            return;
        result.skip.push({ name, reason });
    };
    for (const [name, remoteEntry] of remoteMap) {
        if (!isResolvableName(name)) {
            pushSkip(name, 'name-unparsable');
            continue;
        }
        const localEntry = localMap.get(name);
        if (localEntry === undefined) {
            if (!isResolvableEntry(remoteEntry)) {
                pushSkip(name, 'source-unparsable');
                continue;
            }
            result.install.push(remoteEntry);
            continue;
        }
        if (!isResolvableEntry(localEntry)) {
            pushSkip(name, 'source-unparsable');
            continue;
        }
        const localVersion = localEntry.version;
        const remoteVersion = remoteEntry.version;
        if (parseVersion(localVersion) === null || parseVersion(remoteVersion) === null) {
            if (String(localVersion).trim() === String(remoteVersion).trim()) {
                pushKeep(localEntry);
            }
            else {
                pushSkip(name, 'version-unparsable');
            }
            continue;
        }
        const order = compareVersions(remoteVersion, localVersion);
        if (order > 0)
            result.install.push({ ...remoteEntry, enabled: remoteEntry.enabled });
        else if (order < 0)
            result.noDowngrade.push({ name, localVersion, remoteVersion });
        else
            pushKeep(localEntry);
    }
    // 本地有、远端无 → 永不删。
    for (const [name, localEntry] of localMap) {
        if (remoteMap.has(name))
            continue;
        if (!isResolvableName(name)) {
            pushSkip(name, 'name-unparsable');
            continue;
        }
        pushKeep(localEntry);
    }
    return result;
}
