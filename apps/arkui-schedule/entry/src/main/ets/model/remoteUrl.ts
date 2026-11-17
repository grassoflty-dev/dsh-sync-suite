/**
 * 「远程控制」地址（电脑上的 DSH Web UI）归一与校验 —— 纯逻辑，零 SDK import，Node 可直接单测。
 *
 * 契约（设置页「打开远程控制」+ 远程控制页共用同一份规则）：
 * - 用户手输的地址是**不可信输入**：缺协议、夹空格、协议乱写、只有 `http://` 都必须给中文原因；
 * - `ip:port` / `host/path` 这类没写协议的地址自动补 `http://`（局域网 DSH 默认就是 http），
 *   并把 `hadScheme` 记为 `false`，让调用方能提示「已自动补 http://」；
 * - 协议只允许 http / https（大小写不敏感），一律归一成小写；host / 端口 / 路径 / query /
 *   fragment **原样保留**（不擅自改大小写、不增删末尾 `/`，token 的值更不能动）；
 * - `hasToken` 只看 query 里有没有 `token` 这个键（键名大小写不敏感）。值可以为空：
 *   「有没有这个参数」与「token 是否有效」是两件事，后者由 DSH 自己判断；
 *   fragment（`#` 之后）里的 `?token=` 不算 query，不置 `hasToken`；
 * - 失败时 `url` 一律为空串（fail-closed：调用方拿到空串就不会去打开一个注定不可达的内嵌 Web）。
 *
 * IPv6 字面量（`http://[2409:8a20:…:763c]:3080/`）：**本轮起支持**。
 * 之前只认 IPv4 是因为「内网 DSH 用 IPv4 即可」；现在多了「公网 IPv6 直连」这条访问方式
 * （`docs/REMOTE-ACCESS-OPTIONS.md` §2.2：不需要 DNS、也不需要 trustedHosts，平板用
 * `http://[地址]:端口/?token=…` 直接开），所以方括号形态必须能过。规则：
 * - 方括号内必须是**合法 IPv6 形态**（十六进制段 + 至多一个 `::`，允许内嵌 IPv4 尾段如
 *   `::ffff:192.168.1.1`），且 `]` 之后只能是「空」或 `:端口`；
 * - 成功时 `url` **保留方括号**（URL 里的 IPv6 必须裹起来，去掉就打不开）；
 * - 仍拒绝：裸 IPv6（没方括号却有多冒号）、未闭合 `[`、`[]`、带账号密码（`@`）、空格、
 *   非 http(s) —— 这些都会落到「地址不完整」的拒绝分支。
 *
 * 带账号密码的地址（`http://user:pass@host`）依然不支持（内嵌 Web 不需要，也不该存明文密码）。
 */

/** 归一/校验结果。`ok=false` 时只有 `reason` 有意义（`url` 为空串）。 */
export interface RemoteUrlCheck {
  /** 是否通过校验。 */
  ok: boolean;
  /** 归一后的地址：成功时为「小写协议 + 原文其余部分」，失败为空串。 */
  url: string;
  /** 校验失败的中文原因（可展示）；成功为空串。 */
  reason: string;
  /** query 里是否带 `token` 参数（键名大小写不敏感）。 */
  hasToken: boolean;
  /** 用户原文里是否本来就写了协议（`false` = 由本函数自动补的 `http://`）。 */
  hadScheme: boolean;
}

/** `scheme://` 前缀（只取协议名，`://` 之后的内容自己解析，不依赖 URL 实现）。 */
const SCHEME_RE: RegExp = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/** 允许的协议（小写）。 */
const ALLOWED_SCHEMES: string[] = ['http', 'https'];

/** 内部空白（含全角空格与制表符）。 */
const INNER_SPACE_RE: RegExp = /[\s\u3000]/;

/** host：字母/数字开头，其余允许字母、数字、`.`、`_`、`-`（IPv4 与内网域名都覆盖）。 */
const HOST_RE: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 端口：1–5 位十进制（只校验形态，不校验 65535 上限）。 */
const PORT_RE: RegExp = /^[0-9]{1,5}$/;

/** IPv6 的一段十六进制（1–4 位）。 */
const IPV6_GROUP_RE: RegExp = /^[0-9A-Fa-f]{1,4}$/;

/** IPv4 的一段十进制（1–3 位，≤255，不补前导零）。 */
const IPV4_OCTET_RE: RegExp = /^(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;

/** 是否合法的 IPv4 字面量（只用于 IPv6 尾段的内嵌判定）。 */
function isIpv4Literal(text: string): boolean {
  const parts: string[] = text.split('.');
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (!IPV4_OCTET_RE.test(part)) {
      return false;
    }
  }
  return true;
}

/** 一段（`::` 切开后的一侧）里有多少个十六进制组；不合法返回 -1。 */
function ipv6GroupCount(segment: string): number {
  if (segment.length === 0) {
    return 0;
  }
  const parts: string[] = segment.split(':');
  for (const part of parts) {
    if (!IPV6_GROUP_RE.test(part)) {
      return -1;
    }
  }
  return parts.length;
}

/**
 * 是否合法的 IPv6 **字面量形态**（不含方括号）。
 *
 * 只做形态判定，不做「这个地址能不能用」的语义判定（通配 / 回环 / 全局由调用方自己判断）：
 * - 允许内嵌 IPv4 尾段（`::ffff:192.168.1.1`）；
 * - 至多一个 `::`，且它至少压缩掉一组（`1:2:3:4:5:6:7::8` 这种越界写法拒绝）；
 * - 不带 `%eth0` 这类 zone id（WebView / 浏览器用不了，放过去只会在平板上失败）。
 */
export function isIpv6Literal(raw: string): boolean {
  const text: string = typeof raw === 'string' ? raw : '';
  if (text.length === 0) {
    return false;
  }
  if (text.indexOf('%') >= 0) {
    return false;
  }
  let expanded: string = text;
  const lastColon: number = text.lastIndexOf(':');
  if (lastColon >= 0 && text.slice(lastColon + 1).indexOf('.') >= 0) {
    // 尾部是内嵌 IPv4：换成两段十六进制再按组数判定（`::ffff:1.2.3.4`）
    const tail: string = text.slice(lastColon + 1);
    if (!isIpv4Literal(tail)) {
      return false;
    }
    expanded = `${text.slice(0, lastColon)}:0:0`;
  } else if (text.indexOf('.') >= 0) {
    // 有点但没冒号 / 点不在尾段：都不是 IPv6（纯 IPv4 也不该被当成 IPv6）
    return false;
  }
  const halves: string[] = expanded.split('::');
  if (halves.length > 2) {
    return false;
  }
  if (halves.length === 2) {
    const head: number = ipv6GroupCount(halves[0]);
    const tail: number = ipv6GroupCount(halves[1]);
    if (head < 0 || tail < 0) {
      return false;
    }
    // `::` 至少要压缩掉一组，否则 8 组写法还带 `::` 是越界的
    return head + tail < 8;
  }
  return ipv6GroupCount(expanded) === 8;
}

/** 失败文案（与需求逐字一致，测试与设置页红字都按这些串断言）。 */
const REASON_EMPTY: string = '请先填写电脑上的 DSH 地址';
const REASON_SCHEME: string = '只支持 http:// 或 https:// 开头的地址';
const REASON_SPACE: string = '地址里不能有空格';
const REASON_INCOMPLETE: string = '地址不完整，请填写 ip:端口/路径';

/** 内部构造：失败结果（`url` 恒为空串，`hadScheme` 恒 false）。 */
function failed(reason: string): RemoteUrlCheck {
  const result: RemoteUrlCheck = { ok: false, url: '', reason: reason, hasToken: false, hadScheme: false };
  return result;
}

/** 内部构造：成功结果。 */
function passed(url: string, hasToken: boolean, hadScheme: boolean): RemoteUrlCheck {
  const result: RemoteUrlCheck = { ok: true, url: url, reason: '', hasToken: hasToken, hadScheme: hadScheme };
  return result;
}

/**
 * query 里是否有 `token` 键。
 *
 * 只看 `?` 之后、`#` 之前的部分（fragment 不是 query），键名比较忽略大小写；值是否为空不影响判定。
 */
function queryHasToken(rest: string): boolean {
  const hash: number = rest.indexOf('#');
  const beforeHash: string = hash >= 0 ? rest.slice(0, hash) : rest;
  const question: number = beforeHash.indexOf('?');
  if (question < 0) {
    return false;
  }
  const pairs: string[] = beforeHash.slice(question + 1).split('&');
  for (const pair of pairs) {
    const equal: number = pair.indexOf('=');
    const key: string = (equal >= 0 ? pair.slice(0, equal) : pair).toLowerCase();
    if (key === 'token') {
      return true;
    }
  }
  return false;
}

/**
 * 归一并校验「远程控制」地址。
 *
 * 幂等：`normalizeRemoteUrl(x).ok === true` 时 `normalizeRemoteUrl(normalizeRemoteUrl(x).url).url` 与之相等
 * （第二次的 `hadScheme` 变成 `true`，因为第一次已经把协议补上了）。
 */
export function normalizeRemoteUrl(raw: string): RemoteUrlCheck {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return failed(REASON_EMPTY);
  }
  if (INNER_SPACE_RE.test(text)) {
    return failed(REASON_SPACE);
  }

  // 1) 协议：写了就必须是 http(s)；没写就补 http://（内网 DSH 的默认形态）
  let scheme: string = 'http';
  let hadScheme: boolean = false;
  let rest: string = text;
  const matched: RegExpExecArray | null = SCHEME_RE.exec(text);
  if (matched !== null) {
    scheme = matched[1].toLowerCase();
    if (ALLOWED_SCHEMES.indexOf(scheme) < 0) {
      return failed(REASON_SCHEME);
    }
    hadScheme = true;
    rest = text.slice(matched[0].length);
  }

  // 2) authority：`://` 之后到第一个 `/`、`?`、`#` 之前
  let end: number = rest.length;
  const marks: string[] = ['/', '?', '#'];
  for (const mark of marks) {
    const at: number = rest.indexOf(mark);
    if (at >= 0 && at < end) {
      end = at;
    }
  }
  const authority: string = rest.slice(0, end);
  if (authority.length === 0) {
    // `http://`、`https:///path` 这类「有协议但没主机」的地址
    return failed(REASON_INCOMPLETE);
  }

  // 3) host[:port]：端口只允许数字，host 不允许 `@` / 空白 / 其它怪字符
  //    IPv6 字面量单独走一条分支：`[` 开头就必须有配对的 `]`，括号里必须是合法 IPv6，
  //    `]` 之后只允许 `:端口`（多一个字符都归到「地址不完整」）。
  if (authority.startsWith('[')) {
    const close: number = authority.indexOf(']');
    if (close < 0) {
      // `http://[::1:3080`：方括号没闭合
      return failed(REASON_INCOMPLETE);
    }
    const inner: string = authority.slice(1, close);
    if (!isIpv6Literal(inner)) {
      // `[]`、`[1:2:3]`、`[gggg::1]`、`[::1::2]` 一律拒绝
      return failed(REASON_INCOMPLETE);
    }
    const after: string = authority.slice(close + 1);
    if (after.length > 0) {
      if (!after.startsWith(':')) {
        return failed(REASON_INCOMPLETE);
      }
      if (!PORT_RE.test(after.slice(1))) {
        return failed(REASON_INCOMPLETE);
      }
    }
    const ipv6Url: string = `${scheme}://${rest}`;
    return passed(ipv6Url, queryHasToken(rest), hadScheme);
  }

  let hostPart: string = authority;
  const colon: number = authority.lastIndexOf(':');
  if (colon >= 0) {
    hostPart = authority.slice(0, colon);
    const port: string = authority.slice(colon + 1);
    if (!PORT_RE.test(port)) {
      return failed(REASON_INCOMPLETE);
    }
  }
  if (!HOST_RE.test(hostPart)) {
    return failed(REASON_INCOMPLETE);
  }

  const url: string = `${scheme}://${rest}`;
  return passed(url, queryHasToken(rest), hadScheme);
}

/**
 * 远程控制页的路由（设置页跳转与测试共用同一个常量）。
 *
 * 页面文件是 `entry/src/main/ets/pages/RemoteControl.ets`，`main_pages.json` 里登记的是
 * `pages/RemoteControl`；不要在调用方硬编码这个字符串。
 */
export function routeToRemote(): string {
  return 'pages/RemoteControl';
}
