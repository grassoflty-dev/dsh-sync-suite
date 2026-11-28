/**
 * 仓库可见性门禁的**插件半侧**（mod-plugin-repo-precheck / mod-repo-privacy-gate）。
 *
 * 【镜像纪律】本文件是 App `apps/arkui-schedule/entry/src/main/ets/model/repoVisibility.ts`
 * 与 `repoVisibilityClient.ts` 的镜像，不是另起一套设计：
 *   - typed 码字符串、逐字中文文案、固定优先级必须与 App 逐字节一致；
 *   - 共享夹具 `test-vectors/repo-visibility/`（SHA256SUMS 钉死）是唯一事实来源；
 *   - 插件独立构建，**不 import apps/****，只复制契约。
 *
 * 固定优先级：host → auth → status → parse → private。
 * - 只有显式 `private: true` 才 ok；缺 `private` 永远不 ok；
 * - 未知 host（自建 / GitLab / 任何白名单外域名）绝不回退成「假定私有」；
 * - 网络错误 / 超时 / 5xx → E_REPO_VISIBILITY_UNKNOWN（未确认私有前不落盘、不 clone）。
 *
 * token 纪律：token 只进 Authorization header；不进 URL、不进日志、不进错误/状态转储。
 */
import { SyncError } from '../engine/errors.js';
/** 成功码（typed，与 App 一致；ok=true 时 message 恒为空串）。 */
export const REPO_VISIBILITY_OK = 'OK';
export const E_REPO_PUBLIC = 'E_REPO_PUBLIC';
export const E_REPO_AUTH = 'E_REPO_AUTH';
export const E_REPO_NOT_FOUND = 'E_REPO_NOT_FOUND';
export const E_REPO_HOST_UNSUPPORTED = 'E_REPO_HOST_UNSUPPORTED';
export const E_REPO_VISIBILITY_UNKNOWN = 'E_REPO_VISIBILITY_UNKNOWN';
export const E_REPO_BAD_RESPONSE = 'E_REPO_BAD_RESPONSE';
/**
 * mod-plugin-askpass-error-surface：askpass 层的 typed 拒绝在**横幅**上的码。
 *
 * 与上面六个同属 `E_REPO_*` 家族（既有契约与用例都按这个前缀认"仓库阻断码"），但它不是
 * 可见性判定的产物，而是 `engine/nodePath.ts` 抛出的 `E_ASKPASS_NODE_MISSING` 经
 * `rpc.ts` 的 `repoCodeOfError()` 映射得到的。之前没有这条映射，于是最可执行的一个失败
 * （本机没有 node）在 state.json 里**没有码**、面板什么都不显示。
 */
export const E_REPO_ASKPASS = 'E_REPO_ASKPASS';
/** 唯一规则行：同步仓库字段下方的常驻说明（与 App 逐字一致）。 */
export const REPO_PRIVATE_RULE_TEXT = '仓库必须是私有仓库（日程、聊天与远程控制配置会提交到这里）';
/** typed 码 → 逐字中文文案（成功是空串：没有拒绝就没有理由）。 */
export const REPO_VISIBILITY_MESSAGES = {
    E_REPO_PUBLIC: '仓库是公开的：日程与远程控制配置不允许提交到公开仓库。请把仓库改成私有后重试',
    E_REPO_AUTH: '令牌无权读取该仓库：请确认令牌有效且具备仓库读权限',
    E_REPO_NOT_FOUND: '仓库不存在：请检查地址（owner/repo）后重试',
    E_REPO_HOST_UNSUPPORTED: '不支持自动校验该仓库的可见性。请改用 Gitee 或 GitHub 的私有仓库；本应用不会把无法校验的仓库当作私有',
    E_REPO_VISIBILITY_UNKNOWN: '暂时无法确认仓库可见性：请检查网络后重试（未确认私有前不会提交任何数据）',
    E_REPO_BAD_RESPONSE: '仓库接口返回了非预期内容（可能被代理或登录页拦截）：请检查网络后重试',
    // mod-plugin-askpass-error-surface：askpass 层失败的唯一横幅文案（逐字，运维要能照着做）。
    E_REPO_ASKPASS: '找不到可用的 Node.js：HTTPS 推送要靠它把令牌交给 git，没有它就无法完成鉴权。请安装 Node.js，或把环境变量 DSH_GIT_SYNC_NODE 指向 node.exe 的完整路径后重试',
    // 本批顺手补上的空洞（不是可见性判定的码，但同样会被 `repoCodeOfError()` 原样写进
    // state.json）：透传的 `E_REPO_*` 里只有它一直没有文案，正好复现本模块要修的"有码无文案"。
    // `sync/repoRoot.ts` 的报错正文仍逐字不变，这里只是给横幅补一句最终可执行的下一步。
    E_REPO_ROOT_UNAVAILABLE: '共享工作目录无法创建或写入：请检查该路径的权限与磁盘剩余空间后重试，或把环境变量 DSH_DOTS_REPO_ROOT 指向一个可写目录',
};
/**
 * mod-plugin-askpass-error-surface：typed 码 → 横幅码的**唯一映射表**。
 *
 * 这张表覆盖 `packages/dsh-dots/src/engine/**` + `src/sync/**` 里出现过的**全部** `E_*`
 * 字面量（`test/error-surface.test.mjs` 每次运行都重新扫源码核对：新增一个码而不登记，
 * 测试直接失败，不会静默丢掉文案）。`rpc.ts` 的 `repoCodeOfError()` 只查这张表 +
 * `E_REPO_*` 原样透传，不再有第二份判断。
 *
 * 为什么不是每个码都给横幅：横幅语义是"仓库/凭据这一侧有事实被阻断"，
 * 本地 IO、参数校验、完整性校验、v2 周期结果码都各有自己的中文原因与下一步，
 * 硬塞进横幅只会把"本地文件损坏"谎报成"无法确认仓库可见性"。
 */
export const REPO_BANNER_RULES = {
    /* ---------------------------------------------------------------- 映射（3 条） */
    E_ASKPASS_NODE_MISSING: {
        banner: E_REPO_ASKPASS,
        reason: '本机解析不到可用的 node 解释器 ⇒ HTTPS 推送拿不到令牌、根本无法鉴权；这是操作者能立刻修好的一类失败，必须有横幅',
    },
    E_AUTH: {
        banner: E_REPO_AUTH,
        reason: '既有行为逐字保留：远端拒绝凭据对操作者而言等价于「令牌无权读取该仓库」',
    },
    E_GIT: {
        banner: E_REPO_VISIBILITY_UNKNOWN,
        reason: '既有行为逐字保留：其它 git 失败一律按「无法确认仓库可用」处理；本地 git 缺失（details.reason === "git-missing"）由 rpc 层先豁免',
    },
    /* ---------------------------------------------------------------- 豁免（本地事实） */
    E_VALIDATION: {
        banner: null,
        reason: '参数/配置校验失败，覆盖面太宽（branch、repoUrl、entries、deviceId…）；映射成横幅会把普通输入错误伪装成仓库阻断，原始中文原因已在 RPC 错误体里',
    },
    E_CONFIRM_REQUIRED: {
        banner: null,
        reason: '写操作缺 confirm 的交互前置条件，不是仓库事实',
    },
    E_NOT_FOUND: {
        banner: null,
        reason: '本地快照 / 预览条目不存在，属本地读取问题，与仓库是否可用无关',
    },
    E_IO: {
        banner: null,
        reason: '本地文件读写失败（写 profile patch、读快照），不是仓库阻断',
    },
    E_SHA_MISMATCH: {
        banner: null,
        reason: '完整性校验失败需要人工确认（错误体里已给下一步）；横幅语义是「仓库是否可用」，套上去会误导',
    },
    E_CONFLICT: {
        banner: null,
        reason: 'rebase 分叉冲突要人处理，错误体已给下一步；这不是「仓库不可用」',
    },
    E_PUSH_REJECTED: {
        banner: null,
        reason: '推送被拒的逐字原因与下一步由 sync/cycle.ts 给出（含 details.budgetMs）；横幅没有对应句子，硬映射成「可见性未知」会谎报原因',
    },
    E_UNCONFIGURED: {
        banner: null,
        reason: '还没配置仓库地址：面板本来就有专门的未配置态，横幅是多余的',
    },
    E_CORRUPT: {
        banner: null,
        reason: 'outbox / records.json 等本地状态损坏，重试无意义，也与仓库可用性无关',
    },
    E_REPO_ROOT_UNAVAILABLE: {
        banner: null,
        reason: '共享工作根本地不可写（权限 / 磁盘 / 路径被占用）：它自带透传的 E_REPO_* 码与逐字文案，不经本表映射',
    },
    /* ---------------------------------------------------------------- 豁免（v2 周期结果码） */
    E_SCHEMA_UNKNOWN: {
        banner: null,
        reason: '只作为 v2 周期结果码出现，不经 SyncError 抛出；原因由周期层文案给出',
    },
    E_BRANCH_MISMATCH: {
        banner: null,
        reason: '只作为 v2 周期结果码出现（远端分支不符），下一步由周期层文案给出',
    },
    E_NOT_SYNCED: {
        banner: null,
        reason: '只作为 v2 周期结果码出现（尚未同步），属提示而非阻断',
    },
    E_LOCAL_PENDING: {
        banner: null,
        reason: '只作为 v2 周期结果码出现（本地待推送），由 LOCAL_PENDING_MESSAGE 给出下一步',
    },
    E_PULL_FAILED: {
        banner: null,
        reason: '只作为 v2 周期结果码出现（拉取失败），真实原因由周期层保留',
    },
    /* ---------------------------------------------------------------- 豁免（安装期一次性拒绝） */
    E_LEGACY_UNPUSHED: {
        banner: null,
        reason: '安装期迁移的一次性 typed 拒绝（旧工作副本还有未推送提交），必须人工 push，与仓库可见性无关',
    },
    E_MIGRATION_TARGET_MISMATCH: {
        banner: null,
        reason: '安装期迁移的一次性 typed 拒绝（目标目录不符），重启 / 重装才能解决',
    },
    /* ---------------------------------------------------------------- 豁免（非仓库路径） */
    E_CHAT_TOOLS_NOT_ISOLATED: {
        banner: null,
        reason: 'chat 域安全边界码，不在仓库 / 推送路径上',
    },
    E_CHAT_DENY_FAILED: {
        banner: null,
        reason: 'chat 域内部防御性码，不在仓库 / 推送路径上',
    },
    E_CHAT_EXPORT: {
        banner: null,
        reason: '会话自动导出失败属 chat 域导出结果码，原因与下一步由周期层的 E_CHAT_EXPORT 中文文案逐字给出；它不表示仓库或凭据不可用，套进仓库横幅会把导出问题谎报成仓库阻断',
    },
    E_INTERNAL: {
        banner: null,
        reason: '未预期异常的兜底码，没有任何可执行的下一步可写进横幅',
    },
    E_UNKNOWN_ACTION: {
        banner: null,
        reason: 'RPC 动作名不认识，属调用方错误',
    },
};
/**
 * typed 码 → 横幅码；豁免（含表外未知码）返回 `null`。
 *
 * 唯一入口：`rpc.ts` 的 `repoCodeOfError()` 用它决定 `state.json` 的 `status.repoBlockCode`。
 */
export function repoBannerCodeOf(typedCode) {
    const rule = REPO_BANNER_RULES[typedCode];
    return rule === undefined ? null : rule.banner;
}
/** 内部构造：拒绝。 */
function refuse(code) {
    const message = REPO_VISIBILITY_MESSAGES[code];
    return {
        ok: false,
        code,
        message: typeof message === 'string' ? message : REPO_VISIBILITY_MESSAGES[E_REPO_BAD_RESPONSE],
    };
}
/** 内部构造：通过（只有显式 `private: true` 能走到这里）。 */
function accept() {
    return { ok: true, code: REPO_VISIBILITY_OK, message: '' };
}
/** host 归一：trim + 小写 + 去可选端口；拿不到就是空串（→ 不支持）。 */
function normalizeHost(raw) {
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (text.length === 0)
        return '';
    const colon = text.indexOf(':');
    return colon > 0 ? text.slice(0, colon) : text;
}
/** 受支持的托管域名（白名单；自建 / GitLab / 其它域名一律不支持）。 */
const SUPPORTED_HOSTS = ['gitee.com', 'github.com'];
/** JSON 里足以证明「这确实是一个仓库对象」的身份键（缺全部 = 200 但没有仓库身份）。 */
const REPO_IDENTITY_KEYS = [
    'id', 'full_name', 'name', 'path', 'html_url', 'clone_url', 'ssh_url',
];
/** 从 typed 码重建拒绝结果（保存失败后 status 复用上次判定，不再发请求）。 */
export function decisionForRepoCode(code) {
    return code === REPO_VISIBILITY_OK ? accept() : refuse(code);
}
/**
 * 纯判定：固定优先级 host → auth → status → parse → private。
 *
 * - status 401/403 在 host 之后判（未知 host 即使返回 401 也先报「不支持」）；
 * - 200 JSON 里没有身份键报 NOT_FOUND，有身份键却没有 boolean `private` 报 BAD_RESPONSE。
 */
export function decideRepoVisibility(request) {
    const facts = request === null || request === undefined
        ? { host: '', status: 0, contentType: '', body: '' }
        : request;
    const host = normalizeHost(facts.host);
    const status = facts.status;
    const contentType = typeof facts.contentType === 'string' ? facts.contentType.toLowerCase() : '';
    const body = typeof facts.body === 'string' ? facts.body : '';
    // 1) host：白名单优先，未知 host 绝不假定私有（即使后面 200 + private:false）。
    if (!SUPPORTED_HOSTS.includes(host))
        return refuse(E_REPO_HOST_UNSUPPORTED);
    // 2) auth：令牌无权读取。
    if (status === 401 || status === 403)
        return refuse(E_REPO_AUTH);
    // 3) status：不存在 / 网络与服务端异常 / 其它非 200。
    if (status === 404)
        return refuse(E_REPO_NOT_FOUND);
    if (status === 0 || status >= 500)
        return refuse(E_REPO_VISIBILITY_UNKNOWN);
    if (status !== 200)
        return refuse(E_REPO_BAD_RESPONSE);
    // 4) parse：HTML / 空体 / 不可解析 / 非对象 / 没有仓库身份。
    if (contentType.includes('html'))
        return refuse(E_REPO_BAD_RESPONSE);
    const text = body.trim();
    if (text.length === 0 || text.charAt(0) === '<')
        return refuse(E_REPO_BAD_RESPONSE);
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return refuse(E_REPO_BAD_RESPONSE);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return refuse(E_REPO_BAD_RESPONSE);
    const obj = parsed;
    const keys = Object.keys(obj);
    if (!REPO_IDENTITY_KEYS.some((key) => keys.includes(key)))
        return refuse(E_REPO_NOT_FOUND);
    // 5) private：只认显式 boolean true；false = 公开；缺字段 / 非 boolean = 非预期响应。
    if (!keys.includes('private'))
        return refuse(E_REPO_BAD_RESPONSE);
    const visibility = obj.private;
    if (typeof visibility !== 'boolean')
        return refuse(E_REPO_BAD_RESPONSE);
    if (visibility !== true)
        return refuse(E_REPO_PUBLIC);
    return accept();
}
/** 硬超时上限（毫秒）：≤5s，与 App 的 `REPO_VISIBILITY_TIMEOUT_MS` 一致。 */
export const REPO_VISIBILITY_TIMEOUT_MS = 5000;
/** Gitee / GitHub 的仓库 API 端点；未知 host 返回空串（不发请求，纯模型判 E_REPO_HOST_UNSUPPORTED）。 */
export function providerEndpoint(target) {
    if (target === null || target === undefined)
        return '';
    if (target.host === 'gitee.com')
        return `https://gitee.com/api/v5/repos/${target.owner}/${target.repo}`;
    if (target.host === 'github.com')
        return `https://api.github.com/repos/${target.owner}/${target.repo}`;
    return '';
}
/**
 * 请求头：token 唯一落点是 Authorization（Gitee 用 `token`，GitHub 用 `Bearer`）。
 * 同一行里绝不出现 repoUrl 与 token。
 */
export function visibilityHeaders(target, token) {
    const scheme = target !== null && target !== undefined && target.host === 'gitee.com' ? 'token' : 'Bearer';
    return {
        'User-Agent': 'dsh-dots',
        Accept: 'application/json',
        Authorization: `${scheme} ${token}`,
    };
}
/**
 * 仓库地址 → 目标；只取域名 + owner/repo，兼容 https/ssh/scp，去掉 `.git` / query / hash。
 * 非法地址返回 null（调用方交给纯模型判 E_REPO_HOST_UNSUPPORTED，不发任何请求）。
 */
export function repoTargetFromUrl(rawUrl) {
    const text = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (text === '' || /[\s\u3000]/.test(text))
        return null;
    let host = '';
    let rawPath = '';
    const scp = /^git@([^:/\\\s]+):(.+)$/.exec(text);
    if (scp !== null) {
        host = scp[1] ?? '';
        rawPath = scp[2] ?? '';
    }
    else {
        const matched = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/.exec(text);
        if (matched === null)
            return null;
        const authority = matched[1] ?? '';
        const at = authority.lastIndexOf('@');
        host = at >= 0 ? authority.slice(at + 1) : authority;
        rawPath = matched[2] ?? '';
    }
    host = host.toLowerCase().replace(/:\d+$/, '');
    let path = rawPath.replace(/^\/+|\/+$/g, '');
    if (path.toLowerCase().endsWith('.git'))
        path = path.slice(0, -4);
    const parts = path.split('/').filter((part) => part !== '');
    if (parts.length < 2 || (parts[0] ?? '') === '' || (parts[1] ?? '') === '')
        return null;
    return { host, owner: parts[0], repo: parts[1] };
}
/**
 * 取一次响应并判定。transport 抛错 / abort / 超时一律当 status=0（→ 未知），
 * 绝不把「没查到」当私有，也不把 token 写进任何返回值。
 */
export async function fetchRepoVisibility(target, token, transport) {
    const url = providerEndpoint(target);
    if (url === '') {
        return decideRepoVisibility({ host: target === null ? '' : target.host, status: 0, contentType: '', body: '' });
    }
    try {
        const response = await transport(url, visibilityHeaders(target, token), REPO_VISIBILITY_TIMEOUT_MS);
        return decideRepoVisibility({
            host: target.host,
            status: response.status,
            contentType: response.contentType,
            body: response.body,
        });
    }
    catch {
        return decideRepoVisibility({ host: target.host, status: 0, contentType: '', body: '' });
    }
}
/** 把拒绝判定转成 typed SyncError；message 是固定中文文案，details 恒为空（无 token / URL）。 */
export function repoPrecheckError(decision) {
    return new SyncError(decision.code, decision.message);
}
/** 全局 fetch 适配成 transport：超时用 AbortSignal，token 只在 header。 */
export function createFetchTransport(fetchImpl) {
    return async (url, headers, timeoutMs) => {
        const response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
        const contentType = typeof response.contentType === 'string'
            ? response.contentType
            : (response.headers?.get('content-type') ?? '');
        const body = typeof response.body === 'string' ? response.body : ((await response.text?.()) ?? '');
        return { status: response.status, contentType, body };
    };
}
