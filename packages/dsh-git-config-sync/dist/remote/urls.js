function okResult(value) {
    return { ok: true, value, reason: '' };
}
function failResult(reason) {
    return { ok: false, value: '', reason };
}
function urlOk(url) {
    return { ok: true, url, reason: '' };
}
function urlFail(reason) {
    return { ok: false, url: '', reason };
}
/** 十进制 0–255，且不允许前导零（`192.168.01.1` 这类在 Windows 上会被当八进制绕过去）。 */
const IPV4_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** 只做语法判定，不做通配/广播语义判定；成功返回原串（IPv4 没有大小写/压缩问题）。 */
function parseIpv4(text) {
    const parts = text.split('.');
    if (parts.length !== 4)
        return null;
    for (const part of parts)
        if (!IPV4_OCTET.test(part))
            return null;
    return parts.join('.');
}
/**
 * 归一 IPv4 字面量。
 *
 * 拒绝通配 `0.0.0.0`（绑定它 = 对同网段全开放）与广播 `255.255.255.255`（不可绑定）；
 * 空串、空白、主机名、`1.2.3.4.5`、`999.1.1.1` 一律失败。
 */
export function normalizeIpv4(raw) {
    if (typeof raw !== 'string')
        return failResult('IPv4 地址必须是字符串');
    const text = raw.trim();
    if (text === '')
        return failResult('IPv4 地址不能为空');
    if (text === '0.0.0.0')
        return failResult('不能用 0.0.0.0：这是「所有网卡」的通配地址，等于对同网段全开放');
    if (text === '255.255.255.255')
        return failResult('不能用 255.255.255.255：这是广播地址，不能用来监听');
    const parsed = parseIpv4(text);
    if (parsed === null)
        return failResult(`不是有效的 IPv4 地址：${text}`);
    return okResult(parsed);
}
/** 十六进制组（1–4 位）。 */
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;
/** 取 IPv4 末尾的十六进制两段（用于内嵌 IPv4 的 IPv6，如 `::ffff:192.168.1.1`）。 */
function ipv4ToHexGroups(text) {
    const parsed = parseIpv4(text);
    if (parsed === null)
        return null;
    const octets = parsed.split('.').map((part) => Number.parseInt(part, 10));
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    return [hi, lo];
}
/** 把末尾的内嵌 IPv4 换成两段十六进制；纯 IPv4（不是 IPv6）返回 null。 */
function expandIpv4Tail(text) {
    const lastColon = text.lastIndexOf(':');
    const tail = lastColon >= 0 ? text.slice(lastColon + 1) : text;
    if (!tail.includes('.'))
        return text;
    const groups = ipv4ToHexGroups(tail);
    if (groups === null)
        return null;
    const head = lastColon >= 0 ? text.slice(0, lastColon) : '';
    if (head === '')
        return null;
    return `${head}:${groups[0]}:${groups[1]}`;
}
/** 解析成完整 8 组（小写十六进制）；不合法返回 null。 */
function ipv6Groups(raw) {
    const expanded = expandIpv4Tail(raw);
    if (expanded === null)
        return null;
    const halves = expanded.split('::');
    if (halves.length > 2)
        return null;
    const toGroups = (segment) => {
        if (segment === '')
            return [];
        const out = [];
        for (const group of segment.split(':')) {
            if (!HEX_GROUP.test(group))
                return null;
            out.push(group.toLowerCase());
        }
        return out;
    };
    const headGroups = toGroups(halves[0] ?? '');
    const tailGroups = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
    if (headGroups === null || tailGroups === null)
        return null;
    if (halves.length === 2) {
        // `::` 至少要压缩掉一组，否则 `1:2:3:4:5:6:7::8` 这类越界写法会被放过。
        const zeros = 8 - headGroups.length - tailGroups.length;
        if (zeros < 1)
            return null;
        const middle = Array.from({ length: zeros }, () => '0');
        return [...headGroups, ...middle, ...tailGroups];
    }
    return headGroups.length === 8 ? headGroups : null;
}
/**
 * 按 RFC 5952 收敛成最短形态：小写、去前导零、最长一段（≥2 组）连续 0 压缩成 `::`。
 * 归一后等值的地址字符串相同，方便去重与"同一台机器"的判断。
 */
function formatIpv6(groups) {
    const compact = [];
    for (const group of groups)
        compact.push(group.replace(/^0+(?=.)/, ''));
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    let curLen = 0;
    for (let i = 0; i < compact.length; i += 1) {
        if (compact[i] === '0') {
            if (curStart < 0)
                curStart = i;
            curLen += 1;
            if (curLen > bestLen) {
                bestLen = curLen;
                bestStart = curStart;
            }
        }
        else {
            curStart = -1;
            curLen = 0;
        }
    }
    if (bestLen < 2)
        return compact.join(':');
    const head = compact.slice(0, bestStart).join(':');
    const tail = compact.slice(bestStart + bestLen).join(':');
    return `${head}::${tail}`;
}
/**
 * 归一 IPv6 字面量，输出**不带方括号**。
 *
 * 带方括号直接报错（URL 里的方括号由 `formatAuthority` 补），`%eth0` 这类 zone id 也拒：
 * 浏览器/WebView 无法使用带 zone 的地址，放过去只会在平板上失败。
 */
export function normalizeIpv6(raw) {
    if (typeof raw !== 'string')
        return failResult('IPv6 地址必须是字符串');
    const text = raw.trim();
    if (text === '')
        return failResult('IPv6 地址不能为空');
    if (text.startsWith('[') || text.endsWith(']'))
        return failResult('IPv6 地址不要带方括号：把 [ ] 去掉再填');
    if (text.includes('%'))
        return failResult('IPv6 地址不要带 % 网卡名（如 %eth0），请到系统里确认实际地址');
    const groups = ipv6Groups(text);
    if (groups === null)
        return failResult(`不是有效的 IPv6 地址：${text}`);
    return okResult(formatIpv6(groups));
}
/**
 * 归一主机名（也可以是 IPv4 字面量）。
 *
 * 只接受"裸主机"：不带协议、不带路径/参数/片段、不带端口、不带方括号。全数字点分串一律
 * 按 IPv4 处理（`999.1.1.1` 这种是手误，不该被当成合法主机名放过）；输出小写。
 */
export function normalizeHostname(raw) {
    if (typeof raw !== 'string')
        return failResult('主机名必须是字符串');
    const text = raw.trim();
    if (text === '')
        return failResult('主机名不能为空');
    if (text.includes('://'))
        return failResult('不要带 http:// 或 https://，只填主机名');
    if (/[/\\?#]/.test(text))
        return failResult('不要带路径或参数，只填主机名');
    if (text.startsWith('[') || text.endsWith(']'))
        return failResult('不要带方括号，只填主机名');
    if (text.includes(':'))
        return failResult('不要带端口；要填 IPv6 地址请换用「IPv6 地址」字段');
    if (/\s/.test(text))
        return failResult('主机名里不能有空格');
    if (/^[0-9.]+$/.test(text)) {
        const v4 = normalizeIpv4(text);
        if (!v4.ok)
            return failResult(`不是有效的 IPv4 地址：${text}`);
        return okResult(v4.value);
    }
    const lowered = text.toLowerCase();
    if (lowered.endsWith('.'))
        return failResult('主机名不要以点结尾');
    if (lowered.length > 253)
        return failResult('主机名太长（超过 253 个字符）');
    for (const label of lowered.split('.')) {
        if (label === '')
            return failResult('主机名里有连续的点');
        if (label.length > 63)
            return failResult('主机名每段不能超过 63 个字符');
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
            return failResult(`主机名里有非法字符：${label}`);
        }
    }
    return okResult(lowered);
}
/** URL 权限部分里的 host：IPv6 必须裹方括号，IPv4/主机名原样。 */
export function formatAuthority(host) {
    const text = host.trim();
    if (text === '')
        return '';
    const bracketed = text.startsWith('[') && text.endsWith(']');
    return text.includes(':') && !bracketed ? `[${text}]` : text;
}
/** 路径片段补齐前导斜杠；空路径归一成 `/`。 */
function normalizePath(path) {
    if (path === '')
        return '/';
    return path.startsWith('/') ? path : `/${path}`;
}
/** 拼 `http://host[:port]/path`；`port <= 0` 表示"不确定端口"，省略端口段。 */
export function buildHttpUrl(host, port, path = '/') {
    const authority = formatAuthority(host);
    const suffix = normalizePath(path);
    const portPart = Number.isInteger(port) && port > 0 ? `:${port}` : '';
    return `http://${authority}${portPart}${suffix}`;
}
/** 拼 `https://host/path`。隧道/反代都终结了 TLS，前端一律是 443，不带端口。 */
export function buildHttpsUrl(host, path = '/') {
    return `https://${formatAuthority(host)}${normalizePath(path)}`;
}
/**
 * 手动地址归一：缺协议按 `http://` 补（用户常从别处粘 `192.168.1.6:40596/`），
 * 其余 scheme 一律拒。注意这是**渲染期**的容错，落盘校验更严（见 accessMode.ts）。
 */
function normalizeManualUrl(raw) {
    const text = raw.trim();
    if (text === '')
        return urlFail('还没有填写完整地址，请填能访问这台电脑的地址');
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
    let parsed;
    try {
        parsed = new URL(withScheme);
    }
    catch {
        return urlFail('地址解析失败，请检查是否拼错（例如少了主机名或多了空格）');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return urlFail('只支持 http:// 或 https:// 开头的地址');
    }
    if (parsed.hostname === '')
        return urlFail('地址里缺少主机名');
    return urlOk(parsed.toString());
}
/**
 * UU 远程「对外入口」归一。
 *
 * 用户从 UU 远程的「图形化端口映射」里复制出来的东西，形态**还没实测过**，可能长这样：
 * `abc.uuyc.com:12345`（host:port）、`abc.uuyc.com`（纯域名）、或已经是 `https://…`。
 * 规则（**临时默认，实测后只改这一处**）：
 *   - 已带协议 → 原样保留（只校验是 http/https）；
 *   - 不带协议且文本里**含 `/`**（看起来是域名/带路径）→ 补 `https://`；
 *   - 否则（看起来是 `host:port`）→ 补 `http://`。
 *
 * 为什么先这么定：域名入口通常由 UU 终结 TLS，补 http 会打不开；而 `host:port` 形态几乎
 * 只可能是明文端口映射。两个方向都可能判错，所以这里只做"最可能打开"的猜测，并把
 * 「待实测」写进 uu 的 `steps` 最后一步，等真机结果回来再改这个函数。
 *
 * 不在这里追加 token：token 由 `appendAccessToken` / `showLink` 统一负责。
 */
function normalizeUuEntry(raw) {
    const text = raw.trim();
    if (text === '')
        return urlFail('还没填 UU 远程生成的对外入口');
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
        ? text
        : text.includes('/')
            ? `https://${text}`
            : `http://${text}`;
    let parsed;
    try {
        parsed = new URL(withScheme);
    }
    catch {
        return urlFail('对外入口不可用：地址解析失败，请检查是否拼错（例如少了主机名或多了空格）');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return urlFail('对外入口不可用：只支持 http:// 或 https:// 开头的地址');
    }
    if (parsed.hostname === '')
        return urlFail('对外入口不可用：地址里缺少主机名');
    return urlOk(parsed.toString());
}
/** 端口取值：设置里 `>0` 用它，否则跟随 DSH 自己的监听端口。 */
function effectivePort(settings, ctx) {
    return settings.port > 0 ? settings.port : ctx.dshPort;
}
/**
 * 按当前方式产出一条可打开地址（不含 token）。
 *
 * 每种方式失败都返回可展示的中文原因，UI 直接显示，不需要再翻译错误码。
 */
export function urlForMode(mode, settings, ctx) {
    switch (mode) {
        case 'lan': {
            const configured = settings.lanAddress.trim();
            const candidate = configured !== '' ? configured : (ctx.lanAddress ?? '').trim();
            if (candidate === '')
                return urlFail('还没有可用的局域网地址，请先选择本机网卡地址');
            const v4 = normalizeIpv4(candidate);
            if (!v4.ok)
                return urlFail(`局域网地址不可用：${v4.reason}`);
            const port = effectivePort(settings, ctx);
            if (port <= 0)
                return urlFail('还不知道 DSH 的监听端口，请先确认端口设置');
            return urlOk(buildHttpUrl(v4.value, port));
        }
        case 'ipv6': {
            const configured = settings.ipv6Address.trim();
            if (configured === '')
                return urlFail('还没有填写 IPv6 地址，请先在电脑上查到本机公网 IPv6');
            const v6 = normalizeIpv6(configured);
            if (!v6.ok)
                return urlFail(`IPv6 地址不可用：${v6.reason}`);
            const port = effectivePort(settings, ctx);
            if (port <= 0)
                return urlFail('还不知道 DSH 的监听端口，请先确认端口设置');
            return urlOk(buildHttpUrl(v6.value, port));
        }
        case 'tailscale': {
            const configured = settings.tailscaleHost.trim();
            if (configured === '')
                return urlFail('还没有填写 Tailscale 地址，请填电脑在 Tailscale 里的 100.x 地址');
            const host = normalizeHostname(configured);
            if (!host.ok)
                return urlFail(`Tailscale 地址不可用：${host.reason}`);
            const port = effectivePort(settings, ctx);
            if (port <= 0)
                return urlFail('还不知道 DSH 的监听端口，请先确认端口设置');
            return urlOk(buildHttpUrl(host.value, port));
        }
        case 'cloudflare': {
            const configured = settings.cloudflareHost.trim();
            if (configured === '')
                return urlFail('还没有填写隧道域名，请填 cloudflared 打印出的那个域名');
            const host = normalizeHostname(configured);
            if (!host.ok)
                return urlFail(`隧道域名不可用：${host.reason}`);
            // 隧道对外只有 443，端口设置在这里不参与（写进 URL 会让地址打不开）。
            return urlOk(buildHttpsUrl(host.value));
        }
        case 'manual':
            return normalizeManualUrl(settings.manualUrl);
        case 'uu':
            // UU 的对外入口与 manual 共用 `manualUrl` 槽位（刻意复用，见 accessMode.ts 的注释），
            // 但归一规则不同：UU 允许缺协议（入口形态待实测）。
            return normalizeUuEntry(settings.manualUrl);
        default:
            // 旧配置/手改文件里可能出现未知 mode：fail-closed，不猜。
            return urlFail('不认识的访问方式，请重新选择');
    }
}
/**
 * 追加/替换 `token` 查询参数（幂等）。
 *
 * 用 `URLSearchParams.set` 保证同名参数只留一个（用户可能贴了一条已带 token 的旧链接）；
 * 其它查询参数与 fragment 原样保留，fragment 仍在最末尾。
 * token 为空时原样返回（避免生成 `?token=` 这种"看起来配好了"的地址）。
 */
export function withToken(url, token) {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (trimmed === '')
        return url;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        // 不是绝对 URL 就原样返回：这里只负责加 token，不负责修地址。
        return url;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return url;
    parsed.searchParams.set('token', trimmed);
    return parsed.toString();
}
/**
 * 「访问令牌（可选）」的出口拼接：把用户粘贴/自动生成的令牌拼成 `?token=…`。
 *
 * 与 `withToken` 的分工：`withToken` 是"能加就加，地址不合法就原样返回"的宽容版
 * （渲染期容错）；本函数是**显式出口**——非空令牌却拼不进去时返回空串，让调用方
 * fail-closed（宁可报错，也不给一条"看起来带令牌、实际没带"的链接）。
 *
 * - 空令牌（含纯空白）→ 原样返回 url（不生成 `?token=` 这种假配置）；
 * - 非空令牌 → 交给 `withToken`（幂等、只留一个 `token` 参数、保留其它参数与 fragment）；
 * - 非法 / 非 http(s) 绝对地址 → 空串。
 */
export function appendAccessToken(url, token) {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (trimmed === '')
        return url;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return '';
    return withToken(url, trimmed);
}
/** 打码展示：前 4 + `…` + 后 4；太短的 token 打码后信息量等于明文，直接 `***`。 */
export function maskToken(token) {
    if (typeof token !== 'string' || token.length < 12)
        return '***';
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/g;
/** 一个 token 在文本里可能出现的编码形态：原样、encodeURIComponent、encodeURI（含百分号大小写）。 */
function tokenVariants(token) {
    const variants = new Set();
    const push = (value) => {
        if (value === '')
            return;
        variants.add(value);
        variants.add(value.replace(PERCENT_ESCAPE, (match) => match.toUpperCase()));
        variants.add(value.replace(PERCENT_ESCAPE, (match) => match.toLowerCase()));
    };
    push(token);
    try {
        push(encodeURIComponent(token));
    }
    catch {
        // 非法 UTF-16（孤立代理对）无法编码：忽略该变体，原样形态仍然会替换。
    }
    try {
        push(encodeURI(token));
    }
    catch {
        /* 同上 */
    }
    return [...variants];
}
/**
 * 把文本里出现的 token 明文（含 URL 编码形态、%2B/%2b 两种大小写）替换成 `***`。
 *
 * 用 `split/join` 而不是正则：token 里的 `.` `+` `*` 全是正则元字符，逐字符转义更容易出错；
 * 字符串切分是精确匹配，不会误伤。
 */
export function redactToken(text, token) {
    if (text === '' || typeof token !== 'string' || token === '')
        return text;
    let out = text;
    for (const variant of tokenVariants(token))
        out = out.split(variant).join('***');
    return out;
}
