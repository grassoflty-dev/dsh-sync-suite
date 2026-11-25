/**
 * Git 传输层：只用 `node:child_process.execFile('git', ...)`，不拼 shell。
 *
 * 安全约束：
 *   - 提交身份用 `-c user.name/user.email` 临时注入，不依赖也不修改全局配置；
 *   - HTTPS token 只走环境变量 `DSH_GIT_SYNC_TOKEN` + 临时 GIT_ASKPASS 脚本（0600），
 *     绝不进 argv / 配置文件 / 日志（错误消息会 scrub）；
 *   - `GIT_TERMINAL_PROMPT=0`，避免 git 卡在交互提示上；
 *   - 非 fast-forward 先 fetch + rebase 再 push，最多 2 次，**永不 force**；
 *   - `allowLocalRepo` 仅供集成测试放行本地路径 / file://。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SyncError } from './errors.js';
import { GITEE_USERNAME_REQUIRED, resolveGitUsername, scrubAuthValue } from './gitUsername.js';
import { warmAskpassNode } from './nodePath.js';
/**
 * **读类**网络命令（ls-remote / fetch / clone）的单次超时上限。
 *
 * 离线或仓库无响应时不能把设置页挂死：超时后 kill 子进程并报 E_GIT（含"超时"字样）。
 * push 不在这一档：它上传对象，耗时与本地工作量成正比，见 `PUSH_TIMEOUT_MS`。
 */
export const NETWORK_TIMEOUT_MS = 8000;
/**
 * push 的单次超时上限（毫秒）：**只给 push 用，绝不与读命令共用**。
 *
 * 推送要把本地对象上传到远端，耗时与本地新增的工作量成正比（本仓库含手写页截图与
 * 附件 zip，几 MB 的数据在家用上行链路上完全可能超过 8 秒）。把读命令的 8 秒预算套到
 * push 上，会把「慢但健康」的推送判成超时——超时会累加同步周期的尝试次数，
 * 一次慢推送就可能把意图停放掉。所以 push 单独用 120 秒这一档；
 * 它已经远大于 askpass / node 的冷启动成本，因此 push **不申请**首次调用放宽
 * （见 `GitRepo.pushBudget()`）。
 */
export const PUSH_TIMEOUT_MS = 120_000;
/**
 * 本机**第一次**网络**读命令**（ls-remote / fetch / clone）使用的预算（毫秒）。
 *
 * D2：首次调用要在 git 子进程里启动 askpass 的 node 解释器（冷启动可能数秒），
 * 这段成本不应算进 8s 网络预算，否则健康的远端会在第一次探测/拉取被判成超时。
 * 只有调用方**没有**显式配置 `networkTimeoutMs` 时才会放宽到这个值；
 * 真正用掉的数字会出现在超时错误里（`details.budgetMs` + 文案）。
 * push 不吃这一档：`PUSH_TIMEOUT_MS` 本身已经远大于冷启动（见 `pushBudget()`）。
 */
export const FIRST_NETWORK_TIMEOUT_MS = 20_000;
/** 超时的下一步：先怀疑耗时（预热/远端慢），再怀疑链路。 */
export const GIT_TIMEOUT_NEXT_STEP = '下一步：稍后重试；连续超时先检查网络与代理是否可用';
/** 网络不可达的下一步：只有解析 / 连接到远端失败才用这一条。 */
export const GIT_UNREACHABLE_NEXT_STEP = '下一步：检查网络、代理或防火墙，确认远端地址可访问后重试';
/** 超时文案：预算数字一律来自当次实际使用的预算，不写死。 */
export function gitTimeoutMessage(command, budgetMs, firstCall) {
    const warm = firstCall ? '，本机首次调用可能包含预热耗时' : '';
    return `git ${command} 超时（>${budgetMs} 毫秒未完成${warm}）；${GIT_TIMEOUT_NEXT_STEP}`;
}
/**
 * 传输层失败的正面证据（唯一一份）：**分两类**，只有「硬证据」算数。
 *
 * ① **硬证据**（本表）＝ 真的能证明链路没通：解析不到主机/代理、连接被拒/被重置、
 *    `connect to <host> port <n> failed`、`unable to connect`。
 *    `timed out` / `timeout` **不在**此列——超时由结构信号（子进程被预算杀死）判定，
 *    绝不靠对外文文本的宽泛猜测。
 *
 * ② **被丢掉的那一类：`unable to access`**。它是 curl 给**所有** HTTPS 失败打的公共前缀
 *    （`fatal: unable to access '<url>': …`），403/404/407/5xx 全都带它，所以它什么也证明不了。
 *    把它当证据的直接后果（评审 b11b P2-1）：`returned error: 404`、`returned error: 302`
 *    这类「远端回了话」的失败被说成「网络不可达（无法解析或连接到远端）」，让用户去查网络。
 *    真正的网络失败时 `Could not resolve host` / `Failed to connect` 一定会和它同时出现，
 *    因此丢掉这个前缀**不会丢掉任何证据**（见 `test/push-auth-classification.test.mjs` 的 G1）。
 *
 * ③ **行门禁（评审 b11c P2-1，P2-4 的镜像）**：硬证据只在**不是服务器回显**的行上成立。
 *    `remote:` 是远端钩子 / CI 日志的输出，`hint:` 是配套提示，两者都不是 git 自己的 HTTP
 *    客户端说的话。于是 `remote: CI log: … Connection refused` 这种**被别人抄进回显**的字不能
 *    证明这次推送的链路没通——它若压过同一次失败里真实的 `returned error: 403`，用户会被送去
 *    查网络，而真相是令牌被拒（方向与本模块正好相反）。真实解析 / 连接失败只会出现在 git 自己
 *    的 `fatal:` 行上，所以按行排除回显**不会丢掉任何真实证据**。
 *    门禁只此一份：由下面的 `nonEchoLinesOf()` 提供，松形状状态码也用它（评审 b11b P2-4）。
 */
export const TRANSPORT_HARD_EVIDENCE_PATTERNS = Object.freeze([
    'could not resolve host',
    'could not resolve proxy',
    'failed to connect',
    "couldn't connect",
    'network is unreachable',
    'no route to host',
    'connection refused',
    'connection reset',
    'connect to [^\\s]+ port [^\\s]+ failed',
    'unable to connect',
]);
/**
 * 被**排除**在证据集之外的「包装前缀」。
 *
 * 这份常量不参与任何判定，存在的唯一目的是让测试能钉住「它确实被丢掉了」：
 * 只要有人把它加回 `TRANSPORT_HARD_EVIDENCE_PATTERNS`，那条守卫就会红。
 */
export const TRANSPORT_DROPPED_WRAPPER_PATTERNS = Object.freeze(['unable to access']);
const TRANSPORT_HARD_EVIDENCE_RE = new RegExp(TRANSPORT_HARD_EVIDENCE_PATTERNS.join('|'), 'i');
/** 服务器回显行（远端钩子日志 / 提示）的行首前缀：这一行不是 git 的 HTTP 客户端输出。 */
const ECHO_LINE_PREFIX_RE = /^(?:remote|hint)\s*:/i;
/**
 * 「哪些行是 git 自己说的」的**唯一**切行逻辑（评审 b11b P2-4 + b11c P2-1 共用）：
 * 按 CRLF/LF 切行、剥掉行首空白（含 tab）、丢掉空行，以及 `remote:` / `hint:` 开头的整行。
 *
 * 过滤是**结构性**的，不做「看起来像日志」之类的猜测；大小写与冒号前空格都由
 * `ECHO_LINE_PREFIX_RE` 的 `i` + `\s*:` 覆盖。
 */
function nonEchoLinesOf(text) {
    const lines = [];
    for (const line of text.split(/\r?\n/)) {
        const body = line.trimStart();
        if (body === '' || ECHO_LINE_PREFIX_RE.test(body))
            continue;
        lines.push(body);
    }
    return lines;
}
/** 文本里是否有**硬**传输失败证据（结构性判定的唯一入口，供 gitPort 复用）。 */
export function hasTransportEvidence(text) {
    if (typeof text !== 'string' || text === '')
        return false;
    // 只扫非回显行（评审 b11c P2-1）：`remote:` / `hint:` 里的 `Connection refused` 是别人抄来的字，
    // 不是这次推送的链路事实；真正连不上时 git 自己那行 `fatal: …` 一定还在。
    const evidenceLines = nonEchoLinesOf(text);
    return evidenceLines.length > 0 && TRANSPORT_HARD_EVIDENCE_RE.test(evidenceLines.join('\n'));
}
/**
 * 状态码 → 原因的**唯一映射**（`failure()` 与 `sync/gitPort.ts` 共用，绝不各写一份）。
 *
 * - 401 / 403 → `auth-rejected`：远端收到凭据但拒绝（Gitee 令牌过期 / 无写权限就是这一形）；
 * - 404 → `not-found`：仓库不存在 / 改名 / 删了 / 令牌看不到它，**也可能来自 CONNECT 代理**
 *   （**不是**网络问题，评审 b11b P2-1 + b11c P2-2）；
 * - 407 → `proxy-auth`：代理要它自己的凭据，和仓库登录名无关；
 * - 429 → `rate-limited`：远端限流；
 * - 500–599 → `remote-error`：远端**或中间代理/网关**出错（代理回 502 时 git 的文案与仓库
 *   自己回 502 完全相同，所以措辞不把责任单方面判给仓库），本地改动与令牌都没有问题；
 * - 其它（1xx/2xx/3xx/400/405/422 …）→ `null`：**不发明原因**，交回调用方的
 *   「认出了状态码但没映射」分支（那一支一律 `git-failed`，绝不退回「网络不可达」）。
 */
export function httpStatusReasonOf(status) {
    if (!Number.isInteger(status))
        return null;
    if (status === 401 || status === 403)
        return 'auth-rejected';
    if (status === 404)
        return 'not-found';
    if (status === 407)
        return 'proxy-auth';
    if (status === 429)
        return 'rate-limited';
    if (status >= 500 && status <= 599)
        return 'remote-error';
    return null;
}
/**
 * git / libcurl **真正会打印**的 HTTP 状态码形状（源码里唯一一份）：**只认句子形状**。
 *
 * 这里四条都是「git 自己的 HTTP 客户端说的一句话」——curl 的两个出口，加上代理 CONNECT
 * 的两种文案。它们自带判别性上下文，端口数字、令牌片段、进度行里的数字都命中不了。
 *
 * 代理那两条为什么必须在表里：`Received HTTP code 407 from proxy after CONNECT` 与
 * `CONNECT tunnel failed, response 407` 是 git/libcurl 走 HTTPS 代理失败时**真实**会打印的
 * 两种形态；漏掉它们，「代理要它自己的凭据」就会落回兜底的「网络不可达」。
 * （前提说明：这两条是 libcurl 的**文档形态**，本机没有真实代理链路，未曾实机观测。）
 */
const HTTP_STATUS_SENTENCE_SOURCES = Object.freeze([
    // curl 标准出口：`fatal: unable to access '<url>': The requested URL returned error: 403`
    'returned error:\\s*(\\d{3})\\b',
    // 老版本 git：`error: 403 Forbidden while accessing https://…`
    '\\berror:\\s*(\\d{3})(?:\\s+[A-Za-z][A-Za-z .!\'-]*)?\\s+while accessing',
    // libcurl 走 HTTPS 代理时的 407 文案（评审 b11b P1-1）：
    //   `fatal: unable to access '<url>': Received HTTP code 407 from proxy after CONNECT`
    // 这里**故意要求** `from proxy` 这一小段：真正的代理失败句必然带它，而 `remote:` 钩子
    // 回显的普通日志（`remote: … received HTTP code 503 …`）不带。
    '\\bReceived HTTP code\\s+(\\d{3})\\s+from proxy\\b',
    // curl 8.x 的替代文案：`CONNECT tunnel failed, response 407`
    // 同样自带判别性上下文（`CONNECT tunnel failed,`），不会命中任何"只是提到 response 一词"的进度行。
    'CONNECT tunnel failed,\\s*response\\s+(\\d{3})\\b',
]);
/**
 * 更松的两条形状（协议行 `HTTP/1.1 429`、裸 `HTTP 403`）：**只对不是服务器回显的行**生效。
 *
 * 为什么必须按行过滤（评审 b11b P2-4）：`remote:` 是远端钩子的输出、`hint:` 是配套提示，
 * 它们不是 git 的 HTTP 客户端说的话。一句 `remote: build log: see HTTP 403 section`
 * 会把真正的 DNS 失败判成「凭据被拒」——方向与本模块的目标正好相反。
 * 过滤只此一份（`nonEchoLinesOf()`，硬传输证据也用它）：按行切开、剥掉行首空白、跳过
 * `remote:` / `hint:` 开头的整行，再跑正则；不做「看起来像日志」之类的猜测。
 * 句子形状（上表）不受此过滤影响：那是 git 自己的措辞。
 */
const HTTP_STATUS_LOOSE_SOURCES = Object.freeze([
    // 协议行：`HTTP/1.1 429`
    '\\bHTTP/\\d+(?:\\.\\d+)?\\s+(\\d{3})\\b',
    // 兜底：`HTTP 403` / `RPC failed; HTTP 403`
    '\\bHTTP\\s+(\\d{3})\\b',
]);
/** 把 `sources` 里的所有匹配按顺序追加进 `codes`（去重，只收 100..599）。 */
function collectStatusCodes(text, sources, codes) {
    for (const source of sources) {
        for (const match of text.matchAll(new RegExp(source, 'gi'))) {
            const code = Number.parseInt(match[1] ?? '', 10);
            if (Number.isInteger(code) && code >= 100 && code <= 599 && !codes.includes(code))
                codes.push(code);
        }
    }
}
/** 从任意 git 文本里取出能认出的 HTTP 状态码（100..599，按形状顺序、去重）。 */
export function httpStatusCodesOf(text) {
    if (typeof text !== 'string' || text === '')
        return [];
    const codes = [];
    // 句子形状先跑：同一段 stderr 里既有 `HTTP/1.1 200 Connection established` 又有
    // `returned error: 500` 时，真正的失败码必须先被认领（源顺序 = 可信度）。
    collectStatusCodes(text, HTTP_STATUS_SENTENCE_SOURCES, codes);
    // 松形状逐行跑，跳过服务器回显行（`remote:` / `hint:`）——与硬传输证据同一份行门禁。
    for (const body of nonEchoLinesOf(text)) {
        collectStatusCodes(body, HTTP_STATUS_LOOSE_SOURCES, codes);
    }
    return codes;
}
/**
 * 从 git 文本里找出**第一个能定原因**的状态码。
 *
 * 认不出、或状态码不在映射表（例如 302 / 400 / 405 / 422）→ `null`：绝不发明原因。
 * 调用方据此区分两件事：「根本没看见状态码」与「看见了但没映射」——后者一律 `git-failed`，
 * 绝不许退回「网络不可达」（评审 b11b P2-1，用 `httpStatusCodesOf(text).length > 0` 判）。
 */
export function httpStatusFailureOf(text) {
    for (const status of httpStatusCodesOf(text)) {
        const reason = httpStatusReasonOf(status);
        if (reason !== null)
            return { reason, status };
    }
    return null;
}
/**
 * 五种状态码失败的**中文原因**（一句话，只说真实原因）。
 * `sync/gitPort.ts` 的 push 文案沿用同一批措辞（那边以「推送失败：」开头的整句字面量受
 * 终态白名单约束，见 `test/push-auth-classification.test.mjs` 的措辞一致性断言）。
 *
 * 5xx 的措辞**必须提到代理**（评审 b11b P2-3）：公司代理返回 502/503 时 curl 打的是
 * 与仓库服务端出错**一模一样**的那句 `returned error: 502`，只说「远端服务器出错」会把
 * 代理故障归因给仓库；只说「代理」又会把真正的服务端 5xx 说错。两个都点名。
 *
 * 404 的措辞（评审 b11b P2-1 + b11c P2-2）：只说「远端**或代理**回了 404」+ 两种真实处境
 * （仓库不存在 / 凭据看不到），不写「网络」「防火墙」——那正是旧兜底把用户带偏的方向。
 * 为什么要把代理算进来：CONNECT 失败时代理自己也会回 404，而 libcurl 对它的措辞与仓库回 404
 * 无法从 stderr 上区分；把责任单方面判给仓库，用户就会去核对一个没问题的仓库地址。
 * 这里**不**尝试从 stderr 分辨来源（那需要真实链路观测），只让文案不再声称来源是仓库。
 */
export const HTTP_STATUS_CAUSE_ZH = Object.freeze({
    'auth-rejected': '远端拒绝了这个用户名或令牌',
    'not-found': '远端或代理返回 404，仓库不存在或当前凭据看不到它',
    'proxy-auth': '代理要求它自己的鉴权',
    'rate-limited': '远端限流',
    'remote-error': '远端或代理返回 HTTP 5xx，本地改动与令牌都没有问题',
});
/** 五种状态码失败的下一步（每条都点名真实原因对应的动作，与原因一一对应）。 */
export const GIT_AUTH_REJECTED_NEXT_STEP = '下一步：在设置里核对仓库登录名与私人令牌（需要写权限），令牌过期或被吊销后重新生成，不要把令牌填成登录密码';
/** 404：先核对仓库地址，再核对这个令牌看不看得见私有库——两件都不是网络问题。 */
export const GIT_NOT_FOUND_NEXT_STEP = '下一步：核对仓库地址是否改名或已删除；私有库需要该登录名与令牌有读取权限';
export const GIT_PROXY_AUTH_NEXT_STEP = '下一步：检查 HTTPS_PROXY 的用户名与口令，或先关掉代理再试';
/** 5xx：先怀疑代理/网关与服务端两侧（代理回 502 与仓库回 502 的 git 文案完全相同）。 */
export const GIT_REMOTE_ERROR_NEXT_STEP = '下一步：稍后重试；连续出现先确认代理是否正常，再去看仓库状态页';
export const GIT_RATE_LIMITED_NEXT_STEP = '下一步：等几分钟再试；先把多次小提交合并再推';
/** 原因 → 下一步的唯一查表（`failure()` 用；`sync/cycle.ts` 有自己的 push 版本）。 */
export const HTTP_STATUS_NEXT_STEP = Object.freeze({
    'auth-rejected': GIT_AUTH_REJECTED_NEXT_STEP,
    'not-found': GIT_NOT_FOUND_NEXT_STEP,
    'proxy-auth': GIT_PROXY_AUTH_NEXT_STEP,
    'rate-limited': GIT_RATE_LIMITED_NEXT_STEP,
    'remote-error': GIT_REMOTE_ERROR_NEXT_STEP,
});
/** 进程内已经发起过多少次带预算的网络 git 调用（第一次调用据此放宽预算）。 */
let networkCallsThisProcess = 0;
/** 仅测试：把「本进程第一次网络调用」复位，便于观察首次预算。 */
export function resetNetworkCallBudget() {
    networkCallsThisProcess = 0;
}
/** 是否需要走临时 askpass：仅 https 仓库 + https 模式 + 有 token。 */
export function usesGitAskpass(config) {
    return config.authMode === 'https' && config.token !== null && /^https:\/\//i.test(config.repoUrl);
}
/**
 * 构造一条 git 子进程的环境。返回值是可直接交给 execFile 的完整 env；
 * 同一配置多次调用得到逐字节相同的结果（clone / fetch / push 因此完全一致）。
 */
export function gitAuthEnv(config) {
    const env = {
        ...process.env,
        ...config.extraEnv,
        GIT_TERMINAL_PROMPT: '0',
        GIT_MERGE_AUTOEDIT: 'no',
    };
    if (usesGitAskpass(config)) {
        // 不变量：探针环境 = 真实 askpass 环境 —— 两边都在「启动 node 的那一刻」用同一份规则清掉
        // NODE_OPTIONS / NODE_PATH（askpass.cmd 的 set / nodePath.ts 的 sanitizeNodeEnv），
        // git 子进程本身保留原 env，避免改变 git 自身的行为。
        // 禁用本机 credential.helper（如 Git Credential Manager 的缓存）：唯一凭据来源 = askpass + token。
        // 走 env 而非 argv，gitPort 的固定 push argv 不必改，clone/fetch/ls-remote/push 全部一致生效。
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = 'credential.helper';
        env.GIT_CONFIG_VALUE_0 = '';
        env.GCM_INTERACTIVE = 'Never';
        env.GIT_ASKPASS = config.askpassPath ?? undefined;
        env.DSH_GIT_SYNC_TOKEN = config.token ?? undefined;
        env.DSH_GIT_SYNC_USER = config.username;
        // node 解释器必须经解析 + 探针验证，不能直接用 process.execPath（DSH 里它是应用二进制）。
        // 解析失败在这里 typed 抛出，早于任何 git 子进程；不涉及 token，也不退化成 auth-prompt。
        // 走 warmAskpassNode：每进程只解析 / 探测一次（冷启动成本在带预算的网络调用之前付掉）。
        const node = warmAskpassNode({ ...config.nodePath, env: config.nodePath?.env ?? env });
        env.DSH_GIT_SYNC_NODE = node.path;
        // ELECTRON_RUN_AS_NODE 只在真正使用应用二进制时出现；真实 node.exe 必须没有这个 Electron 变量。
        if (node.electronRunAsNode)
            env.ELECTRON_RUN_AS_NODE = '1';
        else
            delete env.ELECTRON_RUN_AS_NODE;
        env.DSH_GIT_SYNC_ASKPASS_COUNTER = config.askpassCounter ?? undefined;
        env.SSH_ASKPASS_REQUIRE = 'never';
    }
    return env;
}
/** 临时提交身份，避免要求用户配置全局 user.name。 */
const IDENTITY_ARGS = ['-c', 'user.name=dsh-dots', '-c', 'user.email=sync@localhost'];
/**
 * GIT_ASKPASS 脚本（POSIX）。token 从环境变量读取，脚本本身与 argv 都不含 token。
 * 用户名同样由环境变量提供：GitHub 可留空（默认 x-access-token），
 * Gitee 必须是登录名（私人令牌只作密码）。
 */
const ASKPASS_SH = [
    '#!/bin/sh',
    'case "$1" in',
    '  *sername*) printf \'%s\\n\' "${DSH_GIT_SYNC_USER:-x-access-token}" ;;',
    '  *) printf \'%s\\n\' "${DSH_GIT_SYNC_TOKEN:-}" ;;',
    'esac',
    '',
].join('\n');
/**
 * Windows 版 askpass：转交给 node 执行 askpass.mjs，不在 cmd 里展开 token。
 *
 * 最后一行把 git 的提示文本原样转发给 node（与 POSIX 版对齐）。`%*` 为什么是引号安全的：
 * 它复制的就是 git 自己拼出来的那段参数字符串（git 只传一句普通提示文本，例如
 * `Username for 'https://gitee.com':`，其中的单引号、冒号、@ 对 cmd 都没有特殊含义），
 * cmd 不对参数做变量展开，所以提示文本不会被当成语法；token 永远只在 node 进程的环境变量
 * DSH_GIT_SYNC_TOKEN 里，既不进 argv，也不进本文件。
 *
 * 注释行一律不带 cmd 元字符：cmd 先按元字符切分整行再执行 rem，被切出来的尾巴会被当成命令
 * 执行，并往 stderr 打一行「不是内部或外部命令」——那会污染失败分类的输入。
 *
 * 已知边界（故不改变转发形式）：若仓库地址本身带 `& | < > ^`，git 的提示文本会带上它们，
 * cmd 仍会在那里切分；分类关键字总在切分点之前，答案仍正确，但尾巴会被当成命令执行。插件只
 * 接受 `https://host/path` 形式的地址（无空白、无查询串），这种形状不在支持范围内；要彻底
 * 消除得改成 `set "DSH_GIT_SYNC_PROMPT=%~1"` 让 node 读环境变量，那会偏离与 POSIX 版逐字
 * 对齐的转发形式。
 */
const ASKPASS_CMD = [
    '@echo off',
    'rem 本文件不含 token：token 只由 node 从环境变量读取，cmd 不对它做变量展开。',
    'rem 提示文本由 git 作为参数传入，同一行原样转交给 node，node 才能按提示判用户名还是口令。',
    'rem 注释行不得出现命令解释器元字符：cmd 会先按元字符切分整行再执行 rem，切出来的尾巴被当成命令跑。',
    'rem 探针也按同一份规则清掉这两项：探针环境 = 真实 askpass 环境。',
    'rem 拿不到提示文本时按调用序兜底，规则见 askpass.mjs：新一次 git 调用从用户名重新开始。',
    'set NODE_OPTIONS=',
    'set NODE_PATH=',
    '"%DSH_GIT_SYNC_NODE%" "%~dp0askpass.mjs" %*',
    'exit /b %ERRORLEVEL%',
    '',
].join('\r\n');
/**
 * node 版 askpass：直接写 stdout，token 只从环境变量读。
 *
 * Windows 上 cmd 的 `echo %VAR%` 会把 `& | < > %` 当成语法，含这些字符的 token 会被
 * 截断/当命令执行；所以 .cmd 只负责调 node，值由 node 原样输出（审计 M5）。
 * 提示文本由 git 作为 argv 传给 askpass，.cmd 用 `%*` 原样转发，这条路径不经过 cmd 的变量展开。
 *
 * 拿不到提示文本时的兜底（本次修复）：**绝不**再用一个跨 git 进程存活的全局计数。旧实现
 * 先答用户名、之后一律答 token，于是 fetch 之后再 push 时，git 的「用户名问句」被答成
 * token，Gitee 回 “The token username invalid” 并 403 —— 这就是真实推送一直失败的那个根因。
 *
 * 现在的规则（只看「这是不是同一次 git 调用」）：
 *   1. 提示文本可判 → 直接按提示答（唯一正确路径，兜底根本不参与）；
 *   2. 同一次调用内继续计数：父进程相同，**或** 计数文件够新且上一次调用显然还没问完
 *      （一次 git 调用最多问两项：用户名 + 口令）；
 *   3. 否则一律从 0 重新开始 —— 新一次 git 调用永远先答用户名，绝不把 token 答给用户名问句。
 *
 * 为什么 (2) 需要「没问完」这一条而不是只用父进程：实测 Windows 上 git 每次 askpass 都由一个
 * 新的 cmd.exe 拉起（同一次 git 调用内两次问询的父进程 pid 不同，且都不是 git 自己的 pid），
 * 只用父进程做键会把每次问询都当成新调用。调用方（`GitRepo.buildEnv()`）在启动每个 git 进程
 * 前还会删掉计数文件，正常路径上文件总是新的。
 */
const ASKPASS_MJS = [
    '// 由 dsh-dots 生成：token 只从环境变量读，直接写 stdout；本文件不含 token，也不含任何凭据。',
    "import { readFileSync, writeFileSync } from 'node:fs'",
    '',
    "const token = process.env.DSH_GIT_SYNC_TOKEN ?? ''",
    "const user = process.env.DSH_GIT_SYNC_USER ?? 'x-access-token'",
    "const prompt = process.argv.slice(2).join(' ')",
    '',
    'const emit = (value) => {',
    '  process.stdout.write(`${value}\\n`)',
    '  process.exit(0)',
    '}',
    '',
    '// 1) 有提示文本就按提示判（唯一正确路径）：用户名问句答用户名，口令问句答 token。',
    "if (/sername/i.test(prompt)) emit(user)",
    "if (/assword|assphrase/i.test(prompt)) emit(token)",
    '',
    '// 2) 拿不到提示文本时的兜底：一次 git 调用内先用户名、后 token，绝不跨调用沿用。',
    '//    判定「同一次调用」的两个证据：父进程相同，或者计数文件够新且上一次调用还没问完',
    '//    （一次 git 调用最多问两项）。父进程单独不够：Windows 上 git 每次都经新的 cmd.exe 拉起，',
    '//    同一次调用内两次问询的父进程 pid 不同（实测），所以再加「没问完」这一条。',
    "const counterFile = process.env.DSH_GIT_SYNC_ASKPASS_COUNTER ?? ''",
    'const WINDOW_MS = 3000',
    'const ASKS_PER_INVOCATION = 2',
    'let count = 0',
    "if (counterFile !== '') {",
    '  const now = Date.now()',
    '  try {',
    "    const state = JSON.parse(readFileSync(counterFile, 'utf8'))",
    "    if (state !== null && typeof state === 'object') {",
    "      const sameParent = typeof state.ppid === 'number' && state.ppid === process.ppid",
    '      const age = now - Number(state.at)',
    '      const fresh = Number.isFinite(age) && age >= 0 && age <= WINDOW_MS',
    '      const pending = !(Number(state.count) >= ASKS_PER_INVOCATION)',
    '      if (sameParent || (fresh && pending)) count = Number.parseInt(String(state.count), 10) || 0',
    '    }',
    '  } catch (error) {',
    '    count = 0 // 旧格式或半截文件一律按新调用处理：宁可先答用户名，绝不继承 token 状态',
    '  }',
    '  try {',
    '    writeFileSync(counterFile, JSON.stringify({ ppid: process.ppid, at: now, count: count + 1 }))',
    '  } catch (error) {',
    '    /* 计数写不进去只影响兜底，不影响本次输出 */',
    '  }',
    '}',
    'emit(count === 0 ? user : token)',
    '',
].join('\n');
/**
 * 写出临时 askpass 文件（0600）。token 从不写入这些文件，只经子进程环境变量传递，
 * 因此不会出现在 argv / 配置文件 / 日志里（BRIEF §2.3、审计 M5）。
 */
export async function writeAskpassFiles(dir) {
    const shPath = path.join(dir, 'askpass.sh');
    const cmdPath = path.join(dir, 'askpass.cmd');
    const jsPath = path.join(dir, 'askpass.mjs');
    const counterPath = path.join(dir, 'askpass.count');
    await writeFile(shPath, ASKPASS_SH, { encoding: 'utf8', mode: 0o600 });
    await writeFile(cmdPath, ASKPASS_CMD, { encoding: 'utf8', mode: 0o600 });
    await writeFile(jsPath, ASKPASS_MJS, { encoding: 'utf8', mode: 0o600 });
    try {
        await chmod(shPath, 0o600);
        await chmod(cmdPath, 0o600);
        await chmod(jsPath, 0o600);
    }
    catch {
        /* Windows 上 chmod 语义有限；这些文件本身不含 token */
    }
    return {
        dir,
        sh: shPath,
        cmd: cmdPath,
        js: jsPath,
        counter: counterPath,
        path: process.platform === 'win32' ? cmdPath : shPath,
    };
}
const LOCAL_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/;
const GIT_SSH_URL_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;
/**
 * URL 里是否内嵌凭据（`https://user:pass@host` / `https://token@host`）。
 *
 * HTTPS 的 token 必须走临时 GIT_ASKPASS（BRIEF §2.3：不进 argv / 配置文件），
 * 所以带 userinfo 的 https 地址一律拒绝。`ssh://git@host/...` 的 `git@` 是正常的
 * SSH 用户名，不算凭据（只有 `ssh://user:pass@...` 这种带密码的才拒绝）。
 */
export function hasEmbeddedCredentials(repoUrl) {
    if (typeof repoUrl !== 'string')
        return false;
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(repoUrl.trim());
    if (match === null)
        return false;
    const scheme = (match[1] ?? '').toLowerCase();
    const authority = match[2] ?? '';
    const at = authority.lastIndexOf('@');
    if (at <= 0)
        return false;
    const userinfo = authority.slice(0, at);
    if (userinfo === '')
        return false;
    if (scheme === 'ssh')
        return userinfo.includes(':');
    return true;
}
/** 是否为本插件允许的仓库地址。 */
export function isSupportedRepoUrl(repoUrl, allowLocalRepo = false) {
    if (typeof repoUrl !== 'string')
        return false;
    const trimmed = repoUrl.trim();
    if (trimmed === '' || /\s/.test(trimmed))
        return false;
    if (/^https:\/\/\S+$/i.test(trimmed))
        return !hasEmbeddedCredentials(trimmed);
    if (/^ssh:\/\/\S+$/i.test(trimmed))
        return !hasEmbeddedCredentials(trimmed);
    if (GIT_SSH_URL_RE.test(trimmed))
        return true;
    if (allowLocalRepo) {
        if (/^file:\/\/\S+$/i.test(trimmed))
            return true;
        if (LOCAL_PATH_RE.test(trimmed))
            return true;
    }
    return false;
}
export function assertRepoUrl(repoUrl, allowLocalRepo = false) {
    if (!isSupportedRepoUrl(repoUrl, allowLocalRepo)) {
        throw new SyncError('E_VALIDATION', 'repoUrl 仅支持 https://、ssh://、git@host:path', {
            repoUrl: String(repoUrl).replace(/\/\/[^@/]+@/, '//***@'),
        });
    }
}
function isNonFastForward(text) {
    return /non-fast-forward|\[rejected\]|fetch first|Updates were rejected|stale info|failed to push some refs/i.test(text);
}
/**
 * 鉴权类文本的**两个桶**（评审 b11b P2-2）：语义完全不同，不许合并。
 *
 *   · 拿不出凭据（本机鉴权环境）→ `auth-prompt`：git 根本没把凭据送出去；
 *   · 凭据被拒（远端明确说不）→ `auth-rejected`：凭据已经送出去，只是不被接受。
 *
 * 旧实现把 `Authentication failed` 之类一律归 `auth-prompt`，于是终端文案说
 * 「askpass／用户名或令牌**不可用**」——而真相是「被拒绝」。同一个用户处境（令牌过期）
 * 只因远端文案带不带数字 401 就得到两套互相矛盾的说明，这是本轮要修的谎。
 *
 * 这两张表是**唯一一份**：`sync/gitPort.ts` 的 push 分类复用 `hasAuthRejectedEvidence()`，
 * 不各写一份（否则同一段 stderr 在两条链上会得到两个原因）。
 */
const AUTH_PROMPT_TEXT_RE = /could not read Username|could not read Password|terminal prompts disabled/i;
const AUTH_REJECTED_TEXT_RE = /Authentication failed|fatal: Authentication|HTTP Basic|Access denied|Invalid username or password/i;
/** 其它鉴权类文本：历史行为保持不变（仍按 `auth-prompt` 归类），本轮不扩大改动面。 */
const AUTH_OTHER_TEXT_RE = /Permission denied \(publickey\)|Repository not found|403 Forbidden/i;
/** 文本是否是「凭据被远端拒绝」（没有数字状态码的那些形态）。 */
export function hasAuthRejectedEvidence(text) {
    return typeof text === 'string' && AUTH_REJECTED_TEXT_RE.test(text);
}
/** 文本是否是「本机拿不出凭据」（askpass 缺失 / 提示被禁用 / 用户名读不到）。 */
export function hasAuthPromptEvidence(text) {
    return typeof text === 'string' && AUTH_PROMPT_TEXT_RE.test(text);
}
/**
 * HTTPS askpass 用户名门闸（薄包装，规则只在 `gitUsername.ts` 一份）：
 *   - 显式 username（界面手填 / `DSH_DOTS_GIT_USERNAME`）优先；
 *   - Gitee 留空 → 按仓库地址推断 owner；推不出来才报可读错误；
 *   - GitHub / 自定义留空 → `x-access-token`（GitHub PAT 约定，历史行为不变）。
 */
export function resolveAskpassUser(platform, username, repoUrl = '') {
    const resolved = resolveGitUsername(platform, username, repoUrl);
    if (resolved === '')
        throw new SyncError('E_VALIDATION', GITEE_USERNAME_REQUIRED);
    return resolved;
}
export class GitRepo {
    dir;
    repoUrl;
    branch;
    authMode;
    platform;
    username;
    token;
    allowLocalRepo;
    extraEnv;
    nodePath;
    networkTimeoutMs;
    /** 调用方是否显式给了 networkTimeoutMs（显式预算绝不放宽：测试与自定义上限的口径不变）。 */
    configuredTimeout;
    execFileImpl;
    askpassDir = null;
    askpassPath = null;
    askpassCounter = null;
    constructor(options) {
        assertRepoUrl(options.repoUrl, options.allowLocalRepo === true);
        if (typeof options.branch !== 'string' || options.branch.trim() === '') {
            throw new SyncError('E_VALIDATION', 'branch 不能为空');
        }
        if (typeof options.dir !== 'string' || options.dir.trim() === '') {
            throw new SyncError('E_VALIDATION', '工作副本目录不能为空');
        }
        this.dir = path.resolve(options.dir);
        this.repoUrl = options.repoUrl.trim();
        this.branch = options.branch.trim();
        this.authMode = options.authMode;
        this.platform = options.platform ?? 'custom';
        // 显式 username（面板手填）优先；否则读本机环境变量 DSH_DOTS_GIT_USERNAME。
        // 两者都为空时才走 gitUsername.ts 的地址推断（Gitee owner / GitHub x-access-token）。
        const explicitUser = typeof options.username === 'string' ? options.username.trim() : '';
        const envUserRaw = options.env?.DSH_DOTS_GIT_USERNAME ?? process.env.DSH_DOTS_GIT_USERNAME;
        const envUser = typeof envUserRaw === 'string' ? envUserRaw.trim() : '';
        this.username = explicitUser !== '' ? explicitUser : envUser;
        this.token = options.token !== undefined && options.token !== null && options.token !== '' ? options.token : null;
        this.allowLocalRepo = options.allowLocalRepo === true;
        this.extraEnv = options.env ?? {};
        this.nodePath = options.nodePath;
        this.execFileImpl = options.execFileImpl;
        const configured = options.networkTimeoutMs;
        this.configuredTimeout =
            typeof configured === 'number' && Number.isFinite(configured) && configured > 0;
        this.networkTimeoutMs = this.configuredTimeout
            ? Math.min(configured, NETWORK_TIMEOUT_MS)
            : NETWORK_TIMEOUT_MS;
    }
    /**
     * 本次网络调用实际要用的预算。
     *
     * - 本进程第一次带预算的网络调用，且调用方没有显式配置 → 放宽到 FIRST_NETWORK_TIMEOUT_MS，
     *   让首次 askpass/node 冷启动不至于把健康远端判成超时；
     * - 其余情况仍然是调用方的预算（默认 NETWORK_TIMEOUT_MS）。
     *
     * 返回值会被写进超时错误的 `details`，用户看到的就是"这次实际用掉的那个数"。
     */
    networkBudget() {
        const firstNetworkCall = networkCallsThisProcess === 0;
        networkCallsThisProcess += 1;
        // firstCall 的语义 = 「这次真的用上了放宽后的首次预算」，不是「这是第几次调用」：
        // 显式配置预算的调用方永远拿到自己给的数字，文案里也不会出现「首次调用」的解释。
        if (!firstNetworkCall || this.configuredTimeout)
            return { timeoutMs: this.networkTimeoutMs, firstCall: false };
        return { timeoutMs: Math.max(this.networkTimeoutMs, FIRST_NETWORK_TIMEOUT_MS), firstCall: true };
    }
    /**
     * push 的预算（见 `PUSH_TIMEOUT_MS`）：**独立一档，不与读命令共用**。
     *
     * - 恒为 120 秒，**不读** `networkTimeoutMs`：读命令的预算配置不得反向缩小推送；
     * - 恒为 `firstCall: false`：120 秒已远大于 askpass / node 冷启动，不需要再放宽，
     *   文案里也不会出现「首次调用预热」这种用于读命令的解释；
     * - **不推进**进程级网络调用计数：push 抢不走 ls-remote / fetch 的首次放宽。
     */
    pushBudget() {
        return { timeoutMs: PUSH_TIMEOUT_MS, firstCall: false };
    }
    usesAskpass() {
        return usesGitAskpass({ authMode: this.authMode, repoUrl: this.repoUrl, token: this.token });
    }
    /** 把可能出现在文本里的 token / 用户名 / URL 凭据抹掉，保证错误消息可安全上报。 */
    scrub(text) {
        let out = typeof text === 'string' ? text : String(text);
        if (this.token !== null && this.token.length >= 4)
            out = scrubAuthValue(out, this.token);
        // 登录名不是秘密，但也不该进日志/错误串（只用于本机 HTTPS 鉴权）。
        out = scrubAuthValue(out, this.username);
        out = out.replace(/(\bhttps?:\/\/)[^@/\s]+@/gi, '$1***@');
        return out;
    }
    async ensureAskpass() {
        if (!this.usesAskpass() || this.askpassPath !== null)
            return;
        const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-gcs-askpass-'));
        const files = await writeAskpassFiles(dir);
        this.askpassDir = dir;
        this.askpassPath = files.path;
        this.askpassCounter = files.counter;
    }
    /**
     * 每个 git 子进程启动前重置 askpass 兜底计数：**一次 git 调用 = 一次计数生命周期**。
     *
     * 提示文本现在已由 askpass.cmd 用 `%*` 原样转发，兜底只在「拿不到提示文本」时才会用到；
     * 一旦用到，计数就必须从「用户名」开始，绝不能沿用上一个 git 进程留下的状态 —— 那正是 403
     * 的成因（随后的一次用户名问句被答成 token，Gitee 回 “The token username invalid”）。
     * 用删文件而不是改文件内容：不改变 env 的任何一个字节（clone / fetch / push 的逐字节一致
     * 仍然成立），计数文件路径全生命周期不变。.mjs 里的「父进程 + 时间窗」规则是第二道网。
     */
    async resetAskpassCounter() {
        if (this.askpassCounter === null)
            return;
        try {
            await rm(this.askpassCounter, { force: true });
        }
        catch {
            /* 删不掉不阻断：askpass.mjs 里「一次调用问满两项就重置」仍能挡住跨调用沿用 */
        }
    }
    /**
     * 本实例的鉴权环境。所有 git 命令（含 v2 端口的 push）都从这里取 env，
     * 构造细节只在 `gitAuthEnv()` 一份。公开给 sync/gitPort.ts 复用。
     */
    async buildEnv() {
        if (this.usesAskpass())
            await this.ensureAskpass();
        // 每次取 env = 即将启动一个新的 git 进程：先把兜底计数归零（见 resetAskpassCounter）。
        await this.resetAskpassCounter();
        // Gitee 的 HTTPS 规则是「用户名（登录名）+ 私人令牌作密码」；x-access-token 只适用于
        // GitHub PAT。登录名优先手填 / DSH_DOTS_GIT_USERNAME，否则按仓库地址推断 owner；
        // 只有 Gitee 且两者都拿不到时才报可读错误（规则只在 gitUsername.ts 一份）。
        const askpassUser = this.authMode === 'https' ? resolveAskpassUser(this.platform, this.username, this.repoUrl) : '';
        return gitAuthEnv({
            authMode: this.authMode,
            repoUrl: this.repoUrl,
            username: askpassUser,
            token: this.token,
            askpassPath: this.askpassPath,
            askpassCounter: this.askpassCounter,
            extraEnv: this.extraEnv,
            nodePath: this.nodePath,
        });
    }
    /**
     * 非零退出的统一解释（D1）：**类别靠结构 + 正面证据 + 状态码**，不靠宽泛外文猜测。
     *
     * 判定顺序（本文件与 `sync/gitPort.ts` 的 `textFailureOf()` 共用同一套，不许各自发明）：
     *   0. 超时/预算杀死由结构信号在 `run()` 里先判掉（走不到这里）；
     *   1. **硬传输证据**（`hasTransportEvidence`：解析不到主机/代理、连接被拒/被重置等，
     *      **且只在非 `remote:`/`hint:` 回显行上找**）→ E_GIT + `unreachable`。
     *      **它必须先于状态码**：真正的 DNS 失败会同时带一串 HTTP 文本（`remote:` 钩子回显、
     *      代理抱怨），此时链路根本没通，那些数字不是「远端回的码」（评审 b11b P2-4 的收口；
     *      `unable to access` 这个 curl 包装前缀已从证据集里删掉）。反过来，回显行里的
     *      `Connection refused` 也**不算**证据：它压过同一次失败里真实的 403 时，用户会被送去
     *      查网络，而令牌其实已被拒绝（评审 b11c P2-1，P2-4 的镜像）；
     *   2. stderr 里的 HTTP 状态码（`httpStatusFailureOf`）：401/403 → `auth-rejected`，
     *      404 → `not-found`，407 → `proxy-auth`，429 → `rate-limited`，5xx → `remote-error`；
     *   3. **认出了状态码但没映射**（3xx / 400 / 405 / 422 …）→ E_GIT + `git-failed`，
     *      且 `network: false`：远端回过话，这不许被说成「网络不可达」（评审 b11b P2-1）；
     *   4. 拿不出凭据的鉴权失败 → E_AUTH + `auth-prompt`（语义不变：git 没把凭据送出去）；
     *      凭据被拒的文本形态（`Authentication failed` / `HTTP Basic: Access denied` 等，
     *      没有数字状态码）→ E_AUTH + `auth-rejected`（b11b P2-2：被拒绝 ≠ 不可用）；
     *   5. 其它 → E_GIT + `git-failed`，文案逐字保持历史行为。
     *
     * 状态码分支的文案**只写真实原因 + 下一步**，不回显 stderr：那段原文可能带 URL / 令牌片段，
     * 而真实原因已经由状态码确定，不需要再猜。`details.status` 只带数字，永远不带凭据。
     *
     * 注意：**超时不会走到这里**——超时由子进程被预算杀死（结构信号）在 `run()` 里单独判定。
     */
    failure(args, result, network = false) {
        const text = `${result.stderr}\n${result.stdout}`.trim();
        const summary = text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
            .slice(0, 4)
            .join(' | ') || `exit ${result.code}`;
        const raw = `git ${args[0] ?? ''} 失败：${this.scrub(summary)}`;
        // 1. 硬传输证据优先：链路没通的时候，stderr 里其余的 HTTP 文本都只是回显。
        if (hasTransportEvidence(text)) {
            return new SyncError('E_GIT', `网络不可达（无法解析或连接到远端）：${raw}；${GIT_UNREACHABLE_NEXT_STEP}`, {
                command: args.map((arg) => this.scrub(arg)),
                exitCode: result.code,
                // 调用方据此判断"是否网络类失败"（网络失败才写 reachable:false）；字段名与语义不变。
                network,
                reason: 'unreachable',
            });
        }
        const codes = httpStatusCodesOf(text);
        const statusHit = httpStatusFailureOf(text);
        if (statusHit !== null) {
            // auth-rejected 是「远端拒了你的凭据」→ E_AUTH（调用方按鉴权处理）；
            // 其余几种（含 not-found）是远端/链路事实 → E_GIT，不冒充仓库凭据问题。
            const code = statusHit.reason === 'auth-rejected' ? 'E_AUTH' : 'E_GIT';
            const message = `git ${args[0] ?? ''} 失败：${HTTP_STATUS_CAUSE_ZH[statusHit.reason]}（HTTP ${statusHit.status}）；`
                + HTTP_STATUS_NEXT_STEP[statusHit.reason];
            return new SyncError(code, message, {
                command: args.map((arg) => this.scrub(arg)),
                exitCode: result.code,
                network,
                reason: statusHit.reason,
                status: statusHit.status,
            });
        }
        // 3. 认出了状态码却没映射：不许落到文本规则上（尤其不许落到「网络不可达」）。
        //    `network: false` 是同一个诚实要求：正文说「HTTP 302」时，状态文件不许写「连不上」。
        if (codes.length > 0) {
            return new SyncError('E_GIT', raw, {
                command: args.map((arg) => this.scrub(arg)),
                exitCode: result.code,
                network: false,
                reason: 'git-failed',
            });
        }
        // 4. 鉴权类文本分两个桶：拿不出凭据（auth-prompt）与被远端拒绝（auth-rejected）。
        // 先问「拿不出」：git 若连用户名都读不到，根本没送出凭据，"不可用"才是根因。
        const authPrompt = hasAuthPromptEvidence(text);
        const authRejected = !authPrompt && hasAuthRejectedEvidence(text);
        const authOther = !authPrompt && !authRejected && AUTH_OTHER_TEXT_RE.test(text);
        const auth = authPrompt || authRejected || authOther;
        const code = auth ? 'E_AUTH' : 'E_GIT';
        const reason = authRejected ? 'auth-rejected' : auth ? 'auth-prompt' : 'git-failed';
        return new SyncError(code, raw, {
            command: args.map((arg) => this.scrub(arg)),
            exitCode: result.code,
            // 调用方据此判断"是否网络类失败"（网络失败才写 reachable:false）；字段名与语义不变。
            network,
            reason,
        });
    }
    /**
     * 起一个 git 子进程。`timeoutMs` 命中时**子进程被杀死**（结构信号 `error.killed`），
     * 这条分支与 stderr 是否有内容、是什么语言无关，因此结果确定：timeout，而不是网络不可达。
     */
    async run(args, options = {}) {
        const cwd = options.cwd ?? (existsSync(this.dir) ? this.dir : os.tmpdir());
        const env = await this.buildEnv();
        const networkFlags = options.network === true && this.usesAskpass() ? ['-c', 'credential.helper='] : [];
        const fullArgs = [...IDENTITY_ARGS, ...networkFlags, ...args];
        const timeoutMs = options.timeoutMs;
        const exec = this.execFileImpl ?? execFile;
        const result = await new Promise((resolve, reject) => {
            exec('git', fullArgs, {
                cwd,
                env,
                windowsHide: true,
                maxBuffer: 32 * 1024 * 1024,
                encoding: 'utf8',
                ...(timeoutMs !== undefined ? { timeout: timeoutMs, killSignal: 'SIGTERM' } : {}),
            }, (error, stdout, stderr) => {
                const errno = error === null ? null : error.code;
                if (errno === 'ENOENT') {
                    reject(new SyncError('E_GIT', '找不到 git 可执行文件，请先安装 git 并加入 PATH', { reason: 'git-missing' }));
                    return;
                }
                const killed = error !== null && error.killed === true;
                if (killed && timeoutMs !== undefined) {
                    reject(new SyncError('E_GIT', gitTimeoutMessage(args[0] ?? '', timeoutMs, options.firstCall === true), {
                        command: args.map((arg) => this.scrub(arg)),
                        timeoutMs,
                        budgetMs: timeoutMs,
                        firstCall: options.firstCall === true,
                        network: options.network === true,
                        reason: 'timeout',
                    }));
                    return;
                }
                const numeric = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
                resolve({ code: numeric, stdout: stdout ?? '', stderr: stderr ?? '' });
            });
        });
        if (result.code !== 0 && options.allowFailure !== true)
            throw this.failure(args, result, options.network === true);
        return result;
    }
    /** 让 git 保持字节原样：禁用 CRLF 转换（Windows 上默认 core.autocrlf=true 会破坏 patch 字节）。 */
    async configureRepo() {
        await this.run(['config', 'core.autocrlf', 'false'], { allowFailure: true });
        await this.run(['config', 'core.safecrlf', 'false'], { allowFailure: true });
        await this.run(['config', 'core.quotepath', 'false'], { allowFailure: true });
    }
    async ensureRemote() {
        const current = await this.run(['remote', 'get-url', 'origin'], { allowFailure: true });
        if (current.code !== 0) {
            await this.run(['remote', 'add', 'origin', this.repoUrl]);
            return;
        }
        if (current.stdout.trim() !== this.repoUrl) {
            await this.run(['remote', 'set-url', 'origin', this.repoUrl]);
        }
    }
    async ensureBranch() {
        const remoteBranch = await this.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${this.branch}`], {
            allowFailure: true,
        });
        if (remoteBranch.code === 0) {
            await this.run(['checkout', '-B', this.branch, `origin/${this.branch}`]);
            return;
        }
        // 空仓库（或远端还没有该分支）：直接建同名本地分支，等首次 commit/push 建立远端分支。
        await this.run(['checkout', '-B', this.branch]);
    }
    async ensureWorkTree() {
        if (existsSync(path.join(this.dir, '.git'))) {
            await this.ensureRemote();
            await this.configureRepo();
            return { cloned: false };
        }
        const parent = path.dirname(this.dir);
        await mkdir(parent, { recursive: true });
        // 首次 clone 走隔离目录：git 失败时它自己往往留下半个目录 / 半个 .git。
        // 只有 clone 成功且后续初始化全部成功，才原子改名为最终工作副本。
        // 任何失败都在 finally 里清掉隔离目录，并且（若已改名）清掉最终目录——
        // 绝不留 `.git`，也不留 `.git.clone-failed-*`（测试直接断言这两个不变式）。
        const quarantine = path.join(parent, `.git.clone-failed-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        let installed = false;
        try {
            const cloneArgs = ['clone', '--quiet', this.repoUrl, quarantine];
            const cloned = await this.run(cloneArgs, { allowFailure: true, network: true, cwd: parent });
            if (cloned.code !== 0)
                throw this.failure(cloneArgs, cloned, true);
            if (existsSync(this.dir))
                await rm(this.dir, { recursive: true, force: true });
            await rename(quarantine, this.dir);
            installed = true;
            await this.configureRepo();
            // clone 时的 checkout 受全局 core.autocrlf 影响，可能把 LF 改成 CRLF；
            // 关掉转换后按索引重写一遍，保证工作树字节 == blob 字节（否则会把别人的设备文件改脏）。
            await this.run(['reset', '--hard'], { allowFailure: true });
            await this.ensureRemote();
            await this.ensureBranch();
            return { cloned: true };
        }
        catch (error) {
            if (installed)
                await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
        finally {
            await rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    async headSha() {
        const result = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true });
        return result.code === 0 ? result.stdout.trim() : '';
    }
    async head() {
        const sha = await this.headSha();
        if (sha === '')
            return { sha: '', message: '', time: '' };
        const result = await this.run(['log', '-1', '--format=%cI%x09%s'], { allowFailure: true });
        if (result.code !== 0)
            return { sha, message: '', time: '' };
        const line = result.stdout.replace(/\r?\n$/, '');
        const tab = line.indexOf('\t');
        if (tab < 0)
            return { sha, message: line, time: '' };
        return { sha, message: line.slice(tab + 1), time: line.slice(0, tab) };
    }
    async lsRemote() {
        const budget = this.networkBudget();
        const result = await this.run(['ls-remote', '--heads', this.repoUrl], {
            allowFailure: true,
            network: true,
            timeoutMs: budget.timeoutMs,
            firstCall: budget.firstCall,
        });
        if (result.code !== 0)
            throw this.failure(['ls-remote', this.repoUrl], result, true);
        let headSha = '';
        for (const line of result.stdout.split('\n')) {
            const match = /^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/.exec(line.trim());
            if (match === null)
                continue;
            if (match[2] === this.branch) {
                headSha = match[1];
                break;
            }
        }
        let message = '';
        if (headSha !== '' && existsSync(path.join(this.dir, '.git'))) {
            const exists = await this.run(['cat-file', '-e', headSha], { allowFailure: true });
            if (exists.code === 0) {
                const subject = await this.run(['log', '-1', '--format=%s', headSha], { allowFailure: true });
                message = subject.code === 0 ? subject.stdout.replace(/\r?\n$/, '') : '';
            }
        }
        return { reachable: true, branch: this.branch, headSha, message };
    }
    /**
     * fetch 远端分支，返回远端分支 sha（远端还没有该分支时为空串）。
     *
     * `reachable` 只用于"最近一次探测结果"：fetch 本身不抛错（远端分支不存在是正常情况），
     * 只有到达远端但拿不到该 ref 时仍算可达。
     */
    async fetch() {
        await this.ensureRemote();
        const budget = this.networkBudget();
        const fetched = await this.run(['fetch', '--quiet', 'origin', this.branch], {
            allowFailure: true,
            network: true,
            timeoutMs: budget.timeoutMs,
            firstCall: budget.firstCall,
        });
        if (fetched.code !== 0) {
            const text = `${fetched.stderr}\n${fetched.stdout}`;
            // 远端根本没有该分支（空仓库/新分支）→ 网络是通的。
            const branchMissing = /couldn't find remote ref|no such remote ref|could not read from remote repository.*not found|remote branch .* not found/i.test(text);
            return { headSha: '', reachable: branchMissing };
        }
        const head = await this.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${this.branch}`], {
            allowFailure: true,
        });
        return { headSha: head.code === 0 ? head.stdout.trim() : '', reachable: true };
    }
    /**
     * 本地状态（**不联网**）：分支、脏文件、相对 `origin/<branch>` 的领先/落后提交数。
     *
     * ahead/behind 只在本地存在 `refs/remotes/origin/<branch>` 时给出数字，否则为 null ——
     * 不做 fetch，也不把"没有远端引用"当成 0。
     */
    async status() {
        const branchResult = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
        const branch = branchResult.code === 0 && branchResult.stdout.trim() !== '' ? branchResult.stdout.trim() : this.branch;
        const statusResult = await this.run(['status', '--porcelain'], { allowFailure: true });
        const changed = statusResult.code === 0
            ? statusResult.stdout
                .split('\n')
                .map((line) => line.slice(3).trim())
                .filter((line) => line !== '')
            : [];
        let ahead = null;
        let behind = null;
        const upstream = `refs/remotes/origin/${this.branch}`;
        const upstreamRef = await this.run(['rev-parse', '--verify', '--quiet', upstream], { allowFailure: true });
        if (upstreamRef.code === 0) {
            const counts = await this.run(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], {
                allowFailure: true,
            });
            if (counts.code === 0) {
                const parts = counts.stdout.trim().split(/\s+/);
                const a = Number.parseInt(parts[0] ?? '', 10);
                const b = Number.parseInt(parts[1] ?? '', 10);
                if (Number.isFinite(a) && Number.isFinite(b)) {
                    ahead = a;
                    behind = b;
                }
            }
        }
        return { branch, clean: changed.length === 0, changed, ahead, behind };
    }
    async pullRebase() {
        const before = await this.headSha();
        const fetched = await this.fetch();
        if (fetched.headSha === '')
            return { rebased: false };
        const result = await this.run(['rebase', '--quiet', `refs/remotes/origin/${this.branch}`], { allowFailure: true });
        if (result.code !== 0) {
            const text = `${result.stderr}\n${result.stdout}`;
            await this.run(['rebase', '--abort'], { allowFailure: true });
            if (/conflict|CONFLICT|could not apply|needs merge|Resolve all conflicts/i.test(text)) {
                const summary = this.scrub(text
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line !== '')
                    .slice(0, 4)
                    .join(' | '));
                throw new SyncError('E_CONFLICT', `rebase 发生冲突，已 abort，请在本地手动处理后重试（本插件永不 force push）：${summary}`);
            }
            throw this.failure(['rebase'], result);
        }
        const after = await this.headSha();
        return { rebased: before !== after };
    }
    /**
     * 丢弃指定目录之外的本地改动。
     *
     * 工作副本只用于同步，`devices/<other>/` 属于别的设备，绝不能被本机提交
     * （例如 clone 时 CRLF 转换、或缺省 checkout 造成的差异）。
     */
    async discardChangesOutside(onlyPath) {
        const prefix = onlyPath.endsWith('/') ? onlyPath : `${onlyPath}/`;
        const status = await this.run(['status', '--porcelain'], { allowFailure: true });
        if (status.code !== 0)
            return [];
        const paths = [];
        for (const line of status.stdout.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '')
                continue;
            const rest = trimmed.slice(2).trim();
            const arrow = rest.indexOf(' -> ');
            const raw = (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, '');
            if (raw !== '' && raw !== onlyPath && !raw.startsWith(prefix))
                paths.push(raw);
        }
        for (const file of paths) {
            const tracked = await this.run(['ls-files', '--error-unmatch', '--', file], { allowFailure: true });
            if (tracked.code === 0)
                await this.run(['checkout', '--', file], { allowFailure: true });
            else
                await this.run(['clean', '-fd', '--', file], { allowFailure: true });
        }
        return paths;
    }
    async commitAll(message, options = {}) {
        if (options.onlyPath !== undefined && options.onlyPath !== '') {
            await this.run(['add', '-A', '--', options.onlyPath]);
            // 自己的目录之外不留改动，避免把别的设备文件带进提交、也避免 rebase 因脏树失败。
            await this.discardChangesOutside(options.onlyPath);
        }
        else {
            await this.run(['add', '-A']);
        }
        const status = await this.run(['status', '--porcelain']);
        const changed = status.stdout
            .split('\n')
            .map((line) => line.slice(3).trim())
            .filter((line) => line !== '');
        if (changed.length === 0) {
            const head = await this.head();
            return { commit: head.sha, files: [] };
        }
        await this.run(['commit', '--quiet', '--no-gpg-sign', '-m', message]);
        const head = await this.head();
        return { commit: head.sha, files: changed };
    }
    async pushOnce() {
        // push 用自己的一档（PUSH_TIMEOUT_MS），不走读命令的 networkBudget()：
        // 推送上传对象的耗时与本地工作量成正比，8 秒预算会把慢但健康的推送判成超时。
        const budget = this.pushBudget();
        const result = await this.run(['push', '--porcelain', 'origin', `HEAD:${this.branch}`], {
            allowFailure: true,
            network: true,
            timeoutMs: budget.timeoutMs,
            firstCall: budget.firstCall,
        });
        const text = `${result.stdout}\n${result.stderr}`;
        if (result.code === 0) {
            const upToDate = /Everything up-to-date|\[up to date\]/i.test(text);
            return { pushed: !upToDate, upToDate, nonFastForward: false };
        }
        if (isNonFastForward(text))
            return { pushed: false, upToDate: false, nonFastForward: true };
        throw this.failure(['push'], result, true);
    }
    /** 单次推送（不做 rebase），供 pushWithRebase 内部使用。 */
    async push() {
        return await this.pushWithRebase();
    }
    /** 非 fast-forward 先 fetch+rebase 再 push，最多 2 次；永不 force。 */
    async pushWithRebase() {
        let rebased = false;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const result = await this.pushOnce();
            if (result.pushed)
                return { pushed: true, rebased };
            if (!result.nonFastForward)
                return { pushed: false, rebased };
            if (attempt === 2)
                break;
            const pulled = await this.pullRebase();
            rebased = rebased || pulled.rebased;
        }
        throw new SyncError('E_CONFLICT', '远端分支已分叉，rebase 后仍无法快进推送（本插件永不 force push），请人工处理', {
            attempts: 2,
        });
    }
    async log(limit) {
        const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
        const result = await this.run(['log', `-n${count}`, '--format=%H%x09%cI%x09%s'], { allowFailure: true });
        if (result.code !== 0)
            return [];
        const out = [];
        for (const line of result.stdout.split('\n')) {
            if (line.trim() === '')
                continue;
            const [sha, time, ...rest] = line.split('\t');
            if (sha === undefined || time === undefined)
                continue;
            out.push({ sha, time, message: rest.join('\t') });
        }
        return out;
    }
    /** 列出某个 revision 下 `devices/` 的所有文件路径（预览只读取远端 ref，不动工作树）。 */
    async listTree(rev, prefix = 'devices/') {
        if (typeof rev !== 'string' || rev === '')
            return [];
        const result = await this.run(['ls-tree', '-r', '--name-only', rev, '--', prefix], { allowFailure: true });
        if (result.code !== 0)
            return [];
        return result.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
    }
    /** 读某个 revision 下的文件内容；不存在返回 null。 */
    async showFile(rev, relativePath) {
        if (typeof rev !== 'string' || rev === '')
            return null;
        const result = await this.run(['show', `${rev}:${relativePath}`], { allowFailure: true });
        return result.code === 0 ? result.stdout : null;
    }
    async dispose() {
        if (this.askpassDir !== null) {
            const dir = this.askpassDir;
            this.askpassDir = null;
            this.askpassPath = null;
            this.askpassCounter = null;
            try {
                await rm(dir, { recursive: true, force: true });
            }
            catch {
                /* 临时目录清理失败不影响同步结果 */
            }
        }
    }
}
