/**
 * `dsh_dots` 的数据层：给手机端「DSH-dots」的一次性快照（全部日程聚合 + DSH 状态）。
 *
 * 契约（与 `docs/DATA-CONTRACT.md` §1、§3 的目录/JSONL 契约一致）：
 * ```
 * <repo>/devices/<deviceId>/schedules/<YYYY-MM-DD>.jsonl
 * ```
 * 聚合口读取**所有**设备目录（跨设备），只扫最近 N 天的文件名，再按 `ts` 的本地日期归属过滤——
 * 与 `schedule_list` 一样不信文件名：记录属于哪一天由 `ts` 决定。
 *
 * 纪律：
 *   1. 只读：不写仓库、不 commit、不 push（拉取失败只降级成 `note`）；
 *   2. 同一天同一 id 跨设备折叠（`foldById`，取较晚 ts 的版本），避免一台设备改过、另一台还是旧版本时重复计数；
 *   3. 坏行跳过但**不静默**：计入 `totals.skipped`；
 *   4. 文件系统异常（除 ENOENT 外）抛 `E_DOTS_IO`；没有数据不是错误（空数组）；
 *   5. DSH 状态只填能证明的字段：数据通道（`mode`）与版本（`version`）可证，
 *      会话级字段（`sessionCount` 等）在拿不到证据时**一律不填**，`reachable` 保持 `false`。
 *
 * DSH 状态为什么默认只有"可证部分"：`docs/DSH-DOTS.md` 的设计稿若把会话探测接进来，
 * 只需给 `dsh_dots` 传一个 `DotsDshProbe`（见下）；插件当前的工具上下文
 * （`ScheduleToolHostContext`）只注入 `tools`，没有 `sessions` 服务，
 * 所以默认实现不猜会话数/忙碌态/最近活动时间。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SyncError, errorMessage } from '../engine/errors.js';
import { detectDshVersion } from '../engine/paths.js';
import { localDateKey, nowIso } from './clock.js';
import { foldById, parseJsonl, recordDateKey } from './jsonl.js';
import { DEVICE_ID_RE } from './paths.js';
/** 快照默认覆盖天数（`days` 缺省）。 */
export const DOTS_DEFAULT_DAYS = 7;
/** 最少 1 天（0 / 负数夹上来）。 */
export const DOTS_MIN_DAYS = 1;
/** 最多 90 天（再大会把手机端载荷撑爆，也超出仓库保留期）。 */
export const DOTS_MAX_DAYS = 90;
/** 每天最多给几条标题。 */
export const DOTS_TOP_TITLES = 3;
/** 坏行定位最多保留几条（`totals.skipped` 的计数不截断）。 */
export const DOTS_SKIPPED_DETAIL_LIMIT = 20;
/** 快照的格式版本（`docs/DSH-DOTS.md` §2.1 的 `v`，前向兼容靠它）。 */
export const DOTS_SNAPSHOT_VERSION = 1;
/* -------------------------------------------------------------------------- */
/* 参数与日期窗口                                                              */
/* -------------------------------------------------------------------------- */
/**
 * 把模型传进来的 `days` 夹到 1..90；缺省 / 非数字 → 7。
 *
 * 显式接受字符串数字（`"30"`）：模型的 JSON 参数有时给字符串，这里不因此报错。
 */
export function clampDays(value) {
    let raw = Number.NaN;
    if (typeof value === 'number')
        raw = value;
    else if (typeof value === 'string' && value.trim() !== '')
        raw = Number(value);
    if (!Number.isFinite(raw))
        return DOTS_DEFAULT_DAYS;
    const truncated = Math.trunc(raw);
    if (truncated < DOTS_MIN_DAYS)
        return DOTS_MIN_DAYS;
    if (truncated > DOTS_MAX_DAYS)
        return DOTS_MAX_DAYS;
    return truncated;
}
/**
 * 最近 N 天的日期键，按 `dateKey` 倒序（今天在最前）。
 *
 * 用 `new Date(y, m, d - i)` 做本地日历减法：跨月/跨年由 Date 自己进位，
 * 不碰 UTC，避免东八区 23:30 的记录被算到另一天。
 */
export function recentDateKeys(now, days) {
    const count = clampDays(days);
    const keys = [];
    for (let offset = 0; offset < count; offset += 1) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
        keys.push(localDateKey(date));
    }
    return keys;
}
/* -------------------------------------------------------------------------- */
/* 一天的聚合                                                                  */
/* -------------------------------------------------------------------------- */
/** ts → 毫秒；非法值排到最后（倒序时 `-Infinity` 沉底）。 */
function tsValue(ts) {
    const value = Date.parse(typeof ts === 'string' ? ts : '');
    return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}
/** 倒序比较（ts 新的在前）；相等时保持折叠后的输入顺序。 */
function byTsDesc(left, right) {
    return tsValue(right.ts) - tsValue(left.ts);
}
/**
 * 把某一天（已合并多设备）的记录折成一天的摘要；没有记录返回 `null`（空白天不进快照）。
 *
 * `topTitles` 顺序：未完成（按 ts 倒序）→ 已完成（按 ts 倒序），去重后取前 `limit` 条。
 * 空标题不占位（不让一天 3 个名额被空串吃掉）。
 */
export function digestDay(dateKey, records, limit = DOTS_TOP_TITLES) {
    const folded = foldById(records);
    if (folded.length === 0)
        return null;
    const open = folded.filter((record) => record.done !== true).sort(byTsDesc);
    const done = folded.filter((record) => record.done === true).sort(byTsDesc);
    const titles = [];
    const seen = new Set();
    const cap = limit > 0 ? limit : DOTS_TOP_TITLES;
    for (const record of [...open, ...done]) {
        if (titles.length >= cap)
            break;
        const title = typeof record.title === 'string' ? record.title.trim() : '';
        if (title === '' || seen.has(title))
            continue;
        seen.add(title);
        titles.push(title);
    }
    return {
        dateKey,
        total: folded.length,
        open: open.length,
        done: done.length,
        topTitles: titles,
    };
}
/* -------------------------------------------------------------------------- */
/* 读盘                                                                        */
/* -------------------------------------------------------------------------- */
/**
 * 仓库里所有合法设备目录（按名字排序）；`devices/` 不存在 = 还没有任何设备数据，返回空数组。
 * 其它读盘失败 → `E_DOTS_IO`（可读，不吞）。
 */
export async function listDeviceDirs(repoDir) {
    let entries = [];
    try {
        entries = await readdir(path.join(repoDir, 'devices'), { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw new SyncError('E_DOTS_IO', `读取 devices/ 失败：${errorMessage(error)}`, { repoDir });
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => DEVICE_ID_RE.test(name))
        .sort();
}
/** 读某个仓库相对路径；不存在返回空串（"没有数据"不是错误）。其它失败 → `E_DOTS_IO`。 */
async function readTextIfExists(repoDir, relative) {
    const absolute = path.join(repoDir, ...relative.split('/'));
    try {
        return await readFile(absolute, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return '';
        throw new SyncError('E_DOTS_IO', `读取日程文件失败：${relative}（${errorMessage(error)}）`, { path: relative });
    }
}
/**
 * 跨设备聚合最近 N 天的日程。
 *
 * 只读：不做任何 git 操作（拉取由调用方决定，见 `dotsSnapshotFromBridge`）。
 * 坏行跳过并按行号记入 `skippedDetails`；`totals.skipped` 累加真实数量。
 */
export async function aggregateDots(options) {
    const now = options.now ?? (() => new Date());
    const days = clampDays(options.days);
    const dateKeys = recentDateKeys(now(), days);
    const deviceIds = options.deviceIds !== undefined
        ? options.deviceIds.map((id) => String(id).trim()).filter((id) => DEVICE_ID_RE.test(id))
        : await listDeviceDirs(options.repoDir);
    const digests = [];
    const skippedDetails = [];
    let skipped = 0;
    for (const dateKey of dateKeys) {
        const records = [];
        for (const deviceId of deviceIds) {
            const relative = `devices/${deviceId}/schedules/${dateKey}.jsonl`;
            const text = await readTextIfExists(options.repoDir, relative);
            if (text === '')
                continue;
            const parsed = parseJsonl(text);
            for (const item of parsed.errors) {
                skipped += 1;
                if (skippedDetails.length < DOTS_SKIPPED_DETAIL_LIMIT) {
                    skippedDetails.push(`${relative}:${item.line} ${item.message}`);
                }
            }
            for (const record of parsed.records) {
                // 与 `schedule_list` 同一规则：记录属于哪一天由 ts 决定，不信文件名。
                if (recordDateKey(record.ts) !== dateKey)
                    continue;
                records.push(record);
            }
        }
        const digest = digestDay(dateKey, records);
        if (digest !== null)
            digests.push(digest);
    }
    const totals = { days: digests.length, records: 0, open: 0, done: 0, skipped };
    for (const digest of digests) {
        totals.records += digest.total;
        totals.open += digest.open;
        totals.done += digest.done;
    }
    return { generatedAt: nowIso(now()), deviceId: options.deviceId, days: digests, totals, skippedDetails };
}
/**
 * 只填能证明的字段的 DSH 状态。
 *
 * - `mode`：`gitBridge === true` → `'git-bridge'`，否则 `'unknown'`；
 * - `reachable`：**恒为 false**（除非由 `DotsDshProbe` 提供证据）——
 *   它不是"DSH 是否在运行"的离线探针，而是"有没有拿到会话级证据"；
 * - `version`：只写可信值，`unknown`/空串直接省略；
 * - `detail`：永远给出人能看懂的原因。
 */
export function buildDshStatus(options = {}) {
    const mode = options.gitBridge === true ? 'git-bridge' : 'unknown';
    const status = { reachable: false, mode };
    const version = typeof options.version === 'string' ? options.version.trim() : '';
    if (version !== '' && version !== 'unknown')
        status.version = version;
    const detail = typeof options.detail === 'string' ? options.detail.trim() : '';
    status.detail =
        detail !== ''
            ? detail
            : mode === 'git-bridge'
                ? '日程经 Git 工作副本读取（数据通道 git-bridge，可证）；DSH 会话级状态未探测：' +
                    '工具上下文未注入 sessions 服务，故不填 sessionCount/activeSessionTitle/busy/lastActivityAt'
                : '取不到 DSH 状态：工具上下文未注入 sessions 服务，且没有可用的 Git 工作副本';
    return status;
}
/** 只保留可证字段：探针给出的字段里，类型不对/明显未填的一律丢掉。 */
function sanitizeProbedStatus(probed) {
    const status = {
        reachable: probed.reachable === true,
        mode: probed.mode === 'git-bridge' || probed.mode === 'http-remote' || probed.mode === 'unknown' ? probed.mode : 'unknown',
    };
    if (typeof probed.sessionCount === 'number' && Number.isFinite(probed.sessionCount) && probed.sessionCount >= 0) {
        status.sessionCount = Math.trunc(probed.sessionCount);
    }
    if (typeof probed.activeSessionTitle === 'string' && probed.activeSessionTitle.trim() !== '') {
        status.activeSessionTitle = probed.activeSessionTitle.trim();
    }
    if (typeof probed.busy === 'boolean')
        status.busy = probed.busy;
    if (typeof probed.lastActivityAt === 'string' && probed.lastActivityAt.trim() !== '') {
        status.lastActivityAt = probed.lastActivityAt.trim();
    }
    if (typeof probed.version === 'string' && probed.version.trim() !== '' && probed.version.trim() !== 'unknown') {
        status.version = probed.version.trim();
    }
    if (typeof probed.detail === 'string' && probed.detail.trim() !== '')
        status.detail = probed.detail.trim();
    return status;
}
/** 用仓库目录造一份快照（不碰 git，测试与只读场景直接用）。 */
export async function collectDotsSnapshot(options) {
    const aggregate = await aggregateDots(options);
    const dsh = options.dsh !== undefined
        ? sanitizeProbedStatus(await options.dsh({ gitBridge: true, deviceId: aggregate.deviceId }))
        : buildDshStatus({ gitBridge: true, version: options.version ?? detectDshVersion() });
    const snapshot = {
        v: DOTS_SNAPSHOT_VERSION,
        generatedAt: aggregate.generatedAt,
        deviceId: aggregate.deviceId,
        days: aggregate.days,
        totals: aggregate.totals,
        dsh,
    };
    if (options.note !== undefined && options.note !== '')
        snapshot.note = options.note;
    return snapshot;
}
/**
 * 经 `ScheduleBridge` 造快照：先确保工作副本存在，再**尽力**拉一次（失败只写 `note`，读不因网络失败），
 * 然后跨设备聚合。只读：不写仓库、不 commit、不 push。
 */
export async function dotsSnapshotFromBridge(bridge, options = {}) {
    await bridge.repo.ensureWorkTree();
    const refresh = await bridge.refreshForRead();
    const snapshot = await collectDotsSnapshot({
        repoDir: bridge.repo.dir,
        deviceId: bridge.deviceId,
        ...(options.days !== undefined ? { days: options.days } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.dsh !== undefined ? { dsh: options.dsh } : {}),
        ...(options.version !== undefined ? { version: options.version } : {}),
        ...(refresh.note !== undefined ? { note: refresh.note } : {}),
    });
    return snapshot;
}
/**
 * 没有仓库（或还没有任何数据）时的空快照：日程用空数组，**不报错**。
 *
 * DSH 状态按 `mode: 'unknown'` 给出可读说明；不编造会话字段。
 */
export function emptyDotsSnapshot(options) {
    const now = options.now ?? (() => new Date());
    const note = options.note !== undefined && options.note.trim() !== ''
        ? options.note.trim()
        : `最近 ${clampDays(options.days)} 天没有可聚合的日程数据（日程用空数组，不是错误）`;
    return {
        v: DOTS_SNAPSHOT_VERSION,
        generatedAt: nowIso(now()),
        deviceId: typeof options.deviceId === 'string' ? options.deviceId : '',
        days: [],
        totals: { days: 0, records: 0, open: 0, done: 0, skipped: 0 },
        dsh: buildDshStatus({
            gitBridge: false,
            version: options.version ?? detectDshVersion(),
            detail: `${note}；DSH 会话级状态未探测（工具上下文未注入 sessions 服务）`,
        }),
        note,
    };
}
