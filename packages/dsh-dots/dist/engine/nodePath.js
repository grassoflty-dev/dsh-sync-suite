/**
 * askpass 子进程所用的 node 解释器解析（mod-plugin-askpass-node-resolution）。
 *
 * 解析顺序（ fail-closed，任何一步都不静默降级）：
 *   1. 显式覆盖变量 DSH_GIT_SYNC_NODE（历史名称，保持不变）；
 *   2. PATH 上可发现的 node / node.exe（Windows 看 .exe，路径大小写不敏感；POSIX 精确匹配）；
 *   3. DSH / Electron 应用二进制 —— 仅当给子进程注入 ELECTRON_RUN_AS_NODE=1 时它才等价于 node；
 *   4. 以上都不可用 → 抛 typed E_ASKPASS_NODE_MISSING，绝不退化成 auth-prompt。
 *
 * 候选必须逐个通过有界探针（默认 spawnSync 打印固定标记，按进程缓存）。探针函数可注入，
 * 因此本模块的解析逻辑可在不 spawn 的前提下纯单测。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SyncError } from './errors.js';
/** 显式覆盖变量名（沿用历史名称，文档未描述该变量，故不新增文档）。 */
export const ASKPASS_NODE_OVERRIDE_ENV = 'DSH_GIT_SYNC_NODE';
/** typed 拒绝码：与 git 自身的鉴权失败码严格区分。 */
export const ASKPASS_NODE_MISSING_CODE = 'E_ASKPASS_NODE_MISSING';
/** 面向用户的一行固定文案：给出修复办法，不含任何凭据值。 */
export const ASKPASS_NODE_MISSING_REASON = '找不到可用的 node 解释器：请安装 Node.js，或把 DSH_GIT_SYNC_NODE 设为 node.exe 的路径；否则 HTTPS 推送无法通过鉴权';
/** 探针打印的固定标记（非秘密，仅用于确认候选真的是可执行的 node）。 */
export const ASKPASS_PROBE_MARKER = 'DSH_DOTS_ASKPASS_NODE_OK';
const PROBE_JS = `process.stdout.write(${JSON.stringify(ASKPASS_PROBE_MARKER)})`;
const PROBE_TIMEOUT_MS = 2000;
const probeCache = new Map();
/** 探针输出的**唯一**判据：退出码 0 且 stdout 含固定标记。 */
export function isProbeOutputAccepted(result) {
    return (result.status === 0 &&
        typeof result.stdout === 'string' &&
        result.stdout.includes(ASKPASS_PROBE_MARKER));
}
/**
 * 真实探针执行器：直接跑候选可执行文件，不经 shell、不经 .cmd。
 * 退出码 0 只说明「进程起来了」，不说明它是 node —— 判定交给 isProbeOutputAccepted。
 */
const spawnProbe = (candidate, childEnv, script) => {
    const result = spawnSync(candidate.path, ['-e', script], {
        env: childEnv,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
    });
    return { status: result.status, stdout: result.stdout };
};
/** 按平台比较路径：Windows 大小写不敏感且把 / 视为 \ ，POSIX 精确匹配。 */
function samePath(a, b, win) {
    const norm = (value) => (win ? value.replace(/\//g, '\\').toLowerCase() : value);
    return norm(a) === norm(b);
}
/** 自己拼路径而不用 node:path，保证注入的 platform 在任意宿主上都生效。 */
function joinPath(dir, name, win) {
    if (dir.endsWith('/') || (win && dir.endsWith('\\')))
        return `${dir}${name}`;
    return `${dir}${win ? '\\' : '/'}${name}`;
}
function readPathValue(env, win) {
    if (win) {
        const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
        return key === undefined ? '' : env[key] ?? '';
    }
    return env.PATH ?? '';
}
/**
 * 列出候选，顺序即优先级；只做纯判定，不 spawn、不抛错。
 * 同一路径只保留第一次出现的来源（override > path > electron）。
 */
export function listAskpassNodeCandidates(inputs = {}) {
    const env = inputs.env ?? process.env;
    const execPath = typeof inputs.execPath === 'string' ? inputs.execPath : process.execPath;
    const electronVersion = inputs.electronVersion ?? process.versions.electron;
    const platform = inputs.platform ?? process.platform;
    const win = platform === 'win32';
    const delimiter = inputs.pathDelimiter ?? (win ? ';' : ':');
    const fileExists = inputs.fileExists ?? existsSync;
    const seen = new Set();
    const candidates = [];
    const push = (raw, source) => {
        if (typeof raw !== 'string' || raw.trim() === '')
            return;
        // 去掉 PATH 里可能存在的引号；不解析为绝对路径，保持注入测试的可预测性。
        const value = raw.trim().replace(/^"|"$/g, '');
        const key = win ? value.replace(/\//g, '\\').toLowerCase() : value;
        if (seen.has(key))
            return;
        seen.add(key);
        // 诚实判定「这是应用二进制而非 node」：仅当 electronVersion 存在且路径与 execPath 相同。
        const isAppBinary = typeof electronVersion === 'string' && electronVersion !== '' && samePath(value, execPath, win);
        candidates.push({ path: value, source, electronRunAsNode: isAppBinary });
    };
    // 1. 显式覆盖优先。
    push(env[ASKPASS_NODE_OVERRIDE_ENV], 'override');
    // 2. PATH 上的解释器。Windows 遵循 PATHEXT 的 .EXE 规则并按大小写不敏感查找，
    //    POSIX 只认精确文件名 'node'。
    const pathext = inputs.pathExt ?? env.PATHEXT ?? '.EXE';
    const exeAllowed = win && /\.EXE/i.test(String(pathext));
    if (exeAllowed || !win) {
        const names = win
            ? ['node.exe', 'Node.exe', 'NODE.EXE', 'Node.EXE', 'NODE.exe', 'node.EXE', 'node.Exe', 'Node.Exe']
            : ['node'];
        for (const dir of String(readPathValue(env, win)).split(delimiter)) {
            const clean = dir.trim().replace(/^"|"$/g, '');
            if (clean === '')
                continue;
            for (const name of names) {
                const candidate = joinPath(clean, name, win);
                if (fileExists(candidate))
                    push(candidate, 'path');
            }
        }
    }
    // 3. Electron 应用二进制兜底：只有带着 ELECTRON_RUN_AS_NODE=1 才是可用解释器。
    if (typeof electronVersion === 'string' && electronVersion !== '')
        push(execPath, 'electron');
    return candidates;
}
/**
 * 探针环境与真实 askpass 子进程的共享净化规则（就地修改传入的副本）：
 * 去掉 NODE_OPTIONS / NODE_PATH 这类会劫持 node 启动的变量。
 * 不变量：探针环境 = 真实 askpass 环境 —— 这里与 src/engine/git.ts 的 ASKPASS_CMD
 * （`set NODE_OPTIONS=` / `set NODE_PATH=`）一一对应，都是「启动 node 那一刻」的同一份规则；
 * git 子进程自身保留原 env，避免干扰 git 本身。
 */
export function sanitizeNodeEnv(env) {
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    return env;
}
/**
 * 探针只需要证明这个解释器能跑 node，不需要任何凭据。
 * 在 node 启动净化（sanitizeNodeEnv）之上再剥掉所有凭据类变量：DSH_GIT_SYNC_TOKEN、
 * DSH_GIT_SYNC_ASKPASS_COUNTER 等 DSH_GIT_*（保留解释器路径变量，由 withElectronFlag 删除）、
 * GIT_ASKPASS / GIT_CONFIG_* / GCM_INTERACTIVE，以及任何 *_TOKEN / *_PASSWORD。
 * 否则 PATH 上任一能回显标记的假 node.exe 在探针阶段就拿到了真实令牌。
 */
export function probeOnlyEnv(env) {
    const out = sanitizeNodeEnv({ ...env });
    for (const key of Object.keys(out)) {
        const upper = key.toUpperCase();
        if ((upper.startsWith('DSH_GIT_') && upper !== 'DSH_GIT_SYNC_NODE') ||
            upper.startsWith('GIT_CONFIG_') ||
            upper === 'GIT_ASKPASS' ||
            upper === 'GCM_INTERACTIVE' ||
            upper.endsWith('_TOKEN') ||
            upper.endsWith('_PASSWORD')) {
            delete out[key];
        }
    }
    return out;
}
/** 按候选决定 ELECTRON_RUN_AS_NODE：只有应用二进制候选为 '1'，真实 node 必须没有。 */
export function withElectronFlag(env, candidate) {
    const out = { ...env };
    delete out.DSH_GIT_SYNC_NODE; // 解释器变量本身不参与探针
    if (candidate.electronRunAsNode)
        out.ELECTRON_RUN_AS_NODE = '1';
    else
        delete out.ELECTRON_RUN_AS_NODE;
    return out;
}
/**
 * 默认有界探针：只跑一次 `-e` 打印固定标记，短超时，结果按进程缓存。
 * 探针环境 = 真实 askpass 环境的 node 启动部分（由 probeOnlyEnv 去掉所有凭据）。
 *
 * 直接 spawn 候选可执行文件本身（`spawnSync(path, ['-e', PROBE_JS])`），**不生成、不经过任何
 * `.cmd`**：所以本模块与 askpass.cmd 的元字符 / 参数转发缺陷无关。判据见
 * `isProbeOutputAccepted()`：退出码 0 **且** stdout 含固定标记，缺标记一律拒绝。
 */
export function defaultAskpassProbe(candidate, context, runner = spawnProbe) {
    const key = `${candidate.electronRunAsNode ? 'electron' : 'node'}|${candidate.path}`;
    // 只有默认真实探针才进缓存：注入的 runner 是纯单测替身，缓存它会让下一个用例拿到串味结果。
    const cacheable = runner === spawnProbe;
    if (cacheable) {
        const cached = probeCache.get(key);
        if (cached !== undefined)
            return cached;
    }
    let ok = false;
    try {
        const childEnv = withElectronFlag(context?.env ?? probeOnlyEnv(process.env), candidate);
        ok = isProbeOutputAccepted(runner(candidate, childEnv, PROBE_JS));
    }
    catch {
        ok = false;
    }
    if (cacheable)
        probeCache.set(key, ok);
    return ok;
}
const resolutionCache = new Map();
/** 注入的探针 / 存在性判定按**对象身份**区分：不同测试的注入不会互相串味。 */
const functionIds = new WeakMap();
let functionIdSeq = 0;
let warmUpState = { warmed: false, elapsedMs: 0, path: '' };
/** 仅测试：清空进程内解析缓存与预热状态，让「首次调用」可被重复观察。 */
export function resetAskpassNodeWarmUp() {
    resolutionCache.clear();
    warmUpState = { warmed: false, elapsedMs: 0, path: '' };
}
/** 当前进程的预热状态快照（只读；调用方据此在超时文案里点明首次调用的额外成本）。 */
export function askpassNodeWarmUp() {
    return { ...warmUpState };
}
function functionIdOf(value) {
    if (value === undefined)
        return 'default';
    const known = functionIds.get(value);
    if (known !== undefined)
        return String(known);
    functionIdSeq += 1;
    functionIds.set(value, functionIdSeq);
    return String(functionIdSeq);
}
/** 缓存键 = 影响解析结果的全部输入（含注入函数的身份，保证测试可预测）。 */
function warmUpKey(inputs) {
    const env = inputs.env ?? process.env;
    const platform = inputs.platform ?? process.platform;
    const win = platform === 'win32';
    return [
        env[ASKPASS_NODE_OVERRIDE_ENV] ?? '',
        readPathValue(env, win),
        inputs.pathExt ?? env.PATHEXT ?? '',
        platform,
        inputs.pathDelimiter ?? '',
        inputs.execPath ?? process.execPath,
        inputs.electronVersion ?? process.versions.electron ?? '',
        functionIdOf(inputs.fileExists),
        functionIdOf(inputs.probe),
        functionIdOf(inputs.probeRunner),
    ].join('\u0000');
}
/**
 * 预热 + 每进程只解析一次：第一次调用真的列举候选并跑探针（冷启动成本在这里付掉，
 * 早于任何带预算的网络 git 子进程），之后同键调用直接命中缓存，不再列举、不再起探针进程。
 *
 * 失败**绝不缓存**、绝不降级：解释器缺失仍然是 typed `E_ASKPASS_NODE_MISSING`，每次调用都抛。
 */
export function warmAskpassNode(inputs = {}) {
    const key = warmUpKey(inputs);
    const cached = resolutionCache.get(key);
    if (cached !== undefined)
        return { ...cached };
    const startedAt = Date.now();
    const resolved = resolveAskpassNode(inputs);
    resolutionCache.set(key, resolved);
    warmUpState = { warmed: true, elapsedMs: Date.now() - startedAt, path: resolved.path };
    return { ...resolved };
}
/** 按顺序探测候选，第一个通过者胜出；全部失败则 typed 拒绝，不返回任何假解释器。 */
export function resolveAskpassNode(inputs = {}) {
    // 注入 `probe` 时它说了算；只注入 `probeRunner` 时判据仍是默认探针的标记判据，被替换的只是
    // 子进程（这样「退出 0 但输出不对」这条反例也能走真实的决策路径）。
    const probe = inputs.probe ??
        ((candidate, context) => defaultAskpassProbe(candidate, context, inputs.probeRunner));
    const candidates = listAskpassNodeCandidates(inputs);
    const probeEnv = probeOnlyEnv(inputs.env ?? process.env);
    for (const candidate of candidates) {
        let ok = false;
        try {
            const outcome = probe(candidate, { env: withElectronFlag(probeEnv, candidate) });
            ok = outcome === true || (typeof outcome === 'object' && outcome !== null && outcome.ok === true);
        }
        catch {
            ok = false;
        }
        if (ok)
            return { ...candidate };
    }
    throw new SyncError(ASKPASS_NODE_MISSING_CODE, ASKPASS_NODE_MISSING_REASON, {
        code: ASKPASS_NODE_MISSING_CODE,
        tried: candidates.map((candidate) => candidate.path),
    });
}
