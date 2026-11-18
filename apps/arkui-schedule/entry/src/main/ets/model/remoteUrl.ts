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
 * query 里是否带令牌键（`token` 或 `k`）。
 *
 * 只看 `?` 之后、`#` 之前的部分（fragment 不是 query），键名比较忽略大小写；值是否为空不影响判定。
 *
 * 为什么 `k` 也算：插件侧的令牌门同时接受 `?token=` 与 `?k=`（`src/remote/routes.ts`，评审 M4
 * 让两者等价，同时出现视为歧义输入直接拒）。App 侧如果只认 `token`，用户从插件复制的
 * `…?k=…` 地址会被判成「地址未包含 token」并弹一条误导性的橙色提示——判据必须与服务端同源。
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
    if (key === 'token' || key === 'k') {
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

// ============================================================================
// 一、粘贴即用：一个输入框同时接「电脑上的地址」与「令牌」
//
// 为什么要有这一层：电脑侧给用户的是一整条带令牌的链接
// （`http://192.168.1.6:3080/?token=…`，见 `docs/REMOTE-DSH.md` §4.2 的 `#k=` / `?k=`
// 约定），但用户真正会粘的东西五花八门——整条链接、只抄了 `ip:端口`、只把 `?k=…` 那一段
// 抄下来、甚至只抄了值；手抄时首尾还可能带空白或全角空格。
//
// 若把这些形态都直接丢给 `normalizeRemoteUrl`：纯令牌片段 `token=abc` 里没有合法 host 字符，
// 会落到「地址不完整」——用户看到的是一句**错的**提示（他明明只差一个地址没填）。
// 所以这里先分类、再归一。注意分工：
// - 本层只做「这是地址 / 这是令牌 / 这是空的 / 这是废的」的分类与令牌抽取；
// - **地址校验与补协议仍然只有 `normalizeRemoteUrl` 一份规则**，本层绝不写第二份，
//   否则 `host:port` 与整条 URL 迟早会走出两种行为；
// - `file://`、`javascript:` 这类协议由 `normalizeRemoteUrl` 继续拒绝，本层不额外放行。
// ============================================================================

/** 用户粘进来的东西属于哪一类。 */
export type RemoteInputKind = 'url' | 'token' | 'empty' | 'invalid';

/** 粘贴解析结果。`ok=false` 时 `url` / `token` 恒为空串（fail-closed：不给半截值去连）。 */
export interface RemoteInputResult {
  /** 是否可用。 */
  ok: boolean;
  /** 输入类别。 */
  kind: RemoteInputKind;
  /** `kind='url'` 且成功时是归一后的地址；其余情况为空串。 */
  url: string;
  /** 抽出来的令牌（不含键名、已 percent-decode）；没抽到为空串。 */
  token: string;
  /** 失败时的中文原因（可直接展示）；成功为空串。 */
  reason: string;
  /** 用户原文里是否自带协议（`kind='token'/'empty'/'invalid'` 恒为 false）。 */
  hadScheme: boolean;
}

/** 令牌片段里既没有 `k=` 也没有 `token=`（或值为空）时的提示。 */
const REASON_TOKEN_MISSING: string = '粘贴的内容里没有可用的令牌（应为 k=… 或 token=…），请重新复制';

/** 令牌键名：`token` 与 `k` 两种都认（大小写不敏感）。 */
const TOKEN_KEYS: string[] = ['token', 'k'];

/** 「最近成功」记录里，超过这个时长就在按钮文案上加「7 天前」。 */
const RECONNECT_STALE_MS: number = 7 * 24 * 60 * 60 * 1000;

/** 打码后的占位串（用于展示层，绝不回显真实令牌）。 */
const MASK: string = '***';

/**
 * 把一个 URL 的 query 值做 percent-decode。
 *
 * 为什么失败要原样返回：令牌是**别人生成**的不可信输入，`%ZZ` 这种非法转义会让
 * `decodeURIComponent` 抛 URIError；为了一个畸形令牌就整条输入作废，用户只会看到
 * 「格式错误」却不知道该改哪里。原样保留至少还能让服务端给出准确判断。
 * 注：不把 `+` 当空格——令牌是 base64url（`docs/REMOTE-DSH.md` §4.1），`+` 是值本身。
 */
function decodeTokenValue(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 从「一条 URL 或一段 query」里取第一个令牌值。
 *
 * 口径（与 `queryHasToken` 保持一致）：
 * - 只看 `?` 之后、`#` 之前的部分——fragment 不是 query，`#/ui?token=` 不算；
 * - 键名 `token` / `k`，大小写不敏感；`access_token`、`notoken` 这类不算；
 * - 取**第一个**「键匹配且值非空」的；同时出现两个键时以先出现的为准，
 *   空值跳过（`?token=&k=abc` 应取 `abc`，空串不是令牌）。
 */
function extractTokenFromQuery(raw: string): string {
  const text: string = typeof raw === 'string' ? raw : '';
  const hash: number = text.indexOf('#');
  const beforeHash: string = hash >= 0 ? text.slice(0, hash) : text;
  const question: number = beforeHash.indexOf('?');
  if (question < 0) {
    return '';
  }
  const pairs: string[] = beforeHash.slice(question + 1).split('&');
  for (const pair of pairs) {
    const equal: number = pair.indexOf('=');
    if (equal < 0) {
      continue;
    }
    const key: string = pair.slice(0, equal).toLowerCase();
    if (TOKEN_KEYS.indexOf(key) < 0) {
      continue;
    }
    const value: string = decodeTokenValue(pair.slice(equal + 1));
    if (value.length > 0) {
      return value;
    }
  }
  return '';
}

/**
 * 是否「纯令牌片段」。
 *
 * 判据只有两条（宁可少认，不可把地址误当令牌）：
 * 1. 以 `?` 开头 —— 用户把链接的 query 整个抄了下来（`?k=…&x=1`）；
 * 2. 以 `k=` / `token=` 开头（大小写不敏感）—— 用户只抄了参数本身，连 `?` 都省了。
 *
 * 为什么不放宽成「含有 `token=`」：`http://a/?token=x` 含有它，但那是整条地址，
 * 必须走地址分支才能补协议、校验 host。
 */
function looksLikeTokenFragment(text: string): boolean {
  if (text.startsWith('?')) {
    return true;
  }
  return /^(?:token|k)=/i.test(text);
}

/** 构造「空输入」结果（文案与 `normalizeRemoteUrl` 完全一致，避免两处提示打架）。 */
function remoteInputEmpty(): RemoteInputResult {
  const result: RemoteInputResult = {
    ok: false,
    kind: 'empty',
    url: '',
    token: '',
    reason: REASON_EMPTY,
    hadScheme: false
  };
  return result;
}

/** 构造「非法输入」结果（`hadScheme` 恒 false：失败时调用方不该拿它去提示「已补 http」）。 */
function remoteInputInvalid(reason: string): RemoteInputResult {
  const result: RemoteInputResult = {
    ok: false,
    kind: 'invalid',
    url: '',
    token: '',
    reason: reason,
    hadScheme: false
  };
  return result;
}

/**
 * 解析「用户粘进来的一条东西」：地址、令牌、空、非法四类。
 *
 * 优先级（顺序不能换）：
 * 1. 空/全空白 → `kind='empty'`（提示先填地址，不是「格式错误」）；
 * 2. 纯令牌片段 → `kind='token'`，`url` 留空，由调用方用 `mergeRemoteToken()` 合到已填地址上；
 *    片段里抽不出令牌值（`?` 后面没东西 / `token=` 是空值）→ 按非法处理，不返回空令牌；
 * 3. 其余一律当地址交给 `normalizeRemoteUrl()`：成功 `kind='url'`（`url` 用它的归一结果，
 *    `token` 从 query 里抽），失败 `kind='invalid'`（`reason` 逐字沿用它的中文原因）。
 *
 * `host:port` 与整条 URL 走的是**同一条路**（第 3 步），因为 `normalizeRemoteUrl` 已经会补
 * `http://`；这里不再为「有没有写协议」分叉，否则两边的边界（端口非法、带 `@`、IPv6 方括号）
 * 会不一致。
 */
export function parseRemoteInput(raw: string): RemoteInputResult {
  const text: string = typeof raw === 'string' ? raw.trim() : '';

  // 1) 空输入：最常见的「还没填」而不是「填错了」，要给能指导下一步的文案。
  if (text.length === 0) {
    return remoteInputEmpty();
  }

  // 2) 纯令牌片段：`?k=…`、`?token=…&x=1`、`k=…`、`token=…`。
  if (looksLikeTokenFragment(text)) {
    const query: string = text.startsWith('?') ? text : `?${text}`;
    const token: string = extractTokenFromQuery(query);
    if (token.length === 0) {
      // 抽不到值就别返回 `kind='token'` + 空令牌：那等于允许「用空令牌去连」，
      // 用户会看到一次莫名其妙的鉴权失败，而不是「令牌没抄全」。
      return remoteInputInvalid(REASON_TOKEN_MISSING);
    }
    const fragment: RemoteInputResult = {
      ok: true,
      kind: 'token',
      url: '',
      token: token,
      reason: '',
      hadScheme: false
    };
    return fragment;
  }

  // 3) 其余当地址：`host:port`、`host/path`、整条 URL 都在这里，规则只有一份。
  const check: RemoteUrlCheck = normalizeRemoteUrl(text);
  if (!check.ok) {
    // `file://`、`javascript://`、空格、`http://` 都由此拒绝（不在这里另开白名单）。
    return remoteInputInvalid(check.reason);
  }
  const result: RemoteInputResult = {
    ok: true,
    kind: 'url',
    url: check.url,
    token: extractTokenFromQuery(check.url),
    reason: '',
    hadScheme: check.hadScheme
  };
  return result;
}

/**
 * 把一段令牌合进一条已填的地址，返回**可直接保存/打开**的地址。
 *
 * 为什么需要它（而不是让 UI 自己拼字符串）：粘贴框拿到 `kind='token'` 时，
 * 地址框里通常已经有 `192.168.1.6:3080` 或一条**上一轮的旧链接**。手拼 `${url}?token=…`
 * 在已有 `?` 时会拼出第二个 `?`，在已有旧令牌时会留下两个令牌参数——服务端取哪一个不确定，
 * 用户看到的就是「令牌没生效」。这里统一：
 * - 先过 `normalizeRemoteUrl()`（地址非法 → 返回空串，fail-closed）；
 * - 令牌值用 `encodeURIComponent` 编码（`parseRemoteInput` 抽出时已 decode，写回时补回来，
 *   往返一致）；
 * - 已有 `token` / `k` 参数就地替换，并**删掉多余的重复令牌参数**（只留一个）；
 * - 没有令牌参数就追加；fragment（`#` 之后）与其它 query 参数原样保留。
 *
 * `token` 为空 → 返回归一后的地址本身（等价于「只是把地址规整一下」）。
 */
export function mergeRemoteToken(url: string, token: string): string {
  const check: RemoteUrlCheck = normalizeRemoteUrl(url);
  if (!check.ok) {
    return '';
  }
  const normalized: string = check.url;
  const value: string = typeof token === 'string' ? token.trim() : '';
  if (value.length === 0) {
    return normalized;
  }
  const encoded: string = encodeURIComponent(value);

  const hash: number = normalized.indexOf('#');
  const beforeHash: string = hash >= 0 ? normalized.slice(0, hash) : normalized;
  const fragment: string = hash >= 0 ? normalized.slice(hash) : '';
  const question: number = beforeHash.indexOf('?');
  const head: string = question >= 0 ? beforeHash.slice(0, question) : beforeHash;
  if (question < 0) {
    return `${head}?token=${encoded}${fragment}`;
  }

  const pairs: string[] = beforeHash.slice(question + 1).split('&');
  const kept: string[] = [];
  let replaced: boolean = false;
  for (const pair of pairs) {
    const equal: number = pair.indexOf('=');
    const key: string = equal >= 0 ? pair.slice(0, equal) : pair;
    if (equal >= 0 && TOKEN_KEYS.indexOf(key.toLowerCase()) >= 0) {
      if (!replaced) {
        // 保留原键名（用户写的是 `K=` 就还写 `K=`，不改写他的链接形态）
        kept.push(`${key}=${encoded}`);
        replaced = true;
      }
      continue;
    }
    if (pair.length > 0) {
      kept.push(pair);
    }
  }
  if (!replaced) {
    kept.push(`token=${encoded}`);
  }
  return `${head}?${kept.join('&')}${fragment}`;
}

/**
 * 去掉地址里 `token` / `k` 的**整组**参数，返回仍然可打开的纯地址。
 *
 * 为什么需要它：`docs/CONFIG-UX.md` §B.4 要求落盘的「最近一次成功」记录**不含 secret**；
 * 重连时缺的令牌由调用方用已保存的 `remoteToken` 走 `mergeRemoteToken()` 现拼，
 * 令牌在偏好文件里因此只存一份（`remoteToken`），记录本身可以随便看、随便贴。
 *
 * 与 `sanitizeUrlForDisplay()` 的区别：后者把值换成 `***`，只用于展示，拿去重连必然 401；
 * 这里是删掉整对键值。口径与 `queryHasToken` 同源（键名大小写不敏感）；
 * `?k` 这种没有值的裸键不算令牌参数，原样保留，免得把 URL 形态改掉。
 * 删空 query 时连 `?` 一起去掉；**没有令牌参数时原样返回**（逐字等价，连空参数对
 * `?a=1&&b=2` 都不动——只有真的删掉令牌时才会顺手收掉那些空对，见下）。
 */
export function stripRemoteToken(url: string): string {
  const text: string = typeof url === 'string' ? url : '';
  if (text.length === 0) {
    return '';
  }
  const hash: number = text.indexOf('#');
  const beforeHash: string = hash >= 0 ? text.slice(0, hash) : text;
  const fragment: string = hash >= 0 ? text.slice(hash) : '';
  const question: number = beforeHash.indexOf('?');
  if (question < 0) {
    return text;
  }
  const head: string = beforeHash.slice(0, question);
  const kept: string[] = [];
  let stripped: boolean = false;
  for (const pair of beforeHash.slice(question + 1).split('&')) {
    if (pair.length === 0) {
      continue;
    }
    const equal: number = pair.indexOf('=');
    const key: string = (equal >= 0 ? pair.slice(0, equal) : pair).toLowerCase();
    if (equal >= 0 && TOKEN_KEYS.indexOf(key) >= 0) {
      stripped = true;
      continue;
    }
    kept.push(pair);
  }
  // 没有令牌参数 → 逐字返回原串（「记录不含 secret」不需要它顺手做规范化，
  // 保持等价才能让「无令牌时结果与入参相同」这条注释说得通）
  if (!stripped) {
    return text;
  }
  if (kept.length === 0) {
    return `${head}${fragment}`;
  }
  return `${head}?${kept.join('&')}${fragment}`;
}

// ============================================================================
// 二、一键重连：只记「最近一次成功的地址 + 时间」
//
// 为什么要独立一层编码：`docs/CONFIG-UX.md` §B.4 的结论是「一键重连」需要跨重启存活，
// 但那条信息**只是展示状态**，不该塞进 `remote.json` 的 9 字段契约（两端同改的代价不划算）。
// 落盘形态定为单行 JSON：人能看懂、坏了好修、也不需要新增依赖。
// 纪律：这里**只存地址**（地址里带不带令牌由调用方决定要不要剥），本层不引入任何 secret 字段。
// ============================================================================

/** 最近一次成功的连接记录。 */
export interface LastOkEntry {
  /** 当时连通的地址（归一后的形态；可能带令牌 query）。 */
  url: string;
  /** 成功时刻，毫秒时间戳（`Date.now()`）。 */
  at: number;
}

/** 序列化成单行 JSON（字段顺序固定，便于人读与测试逐字断言）。 */
export function encodeLastOk(entry: LastOkEntry): string {
  const record: LastOkEntry = { url: entry.url, at: entry.at };
  return JSON.stringify(record);
}

/**
 * 解析落盘的记录，**脏数据一律返回 null 且绝不抛**。
 *
 * 为什么容忍度要这么高：这是本机偏好文件里的一行，可能被手改、被旧版本写过、
 * 被中断的写入截断（`""`、`"{"`）。一个纯展示状态读失败不该让设置页崩掉，
 * 调用方拿到 null 就当「没有记录」，按钮退回「测试连接」即可。
 * 拒绝的情形：非 JSON / 不是对象（`null`、`[]`、数字）/ 缺 `url` / `url` 不是字符串或全空白 /
 * `at` 不是有限数字（`"x"`、`null`、`NaN` 都不行）。
 */
export function decodeLastOk(raw: string): LastOkEntry | null {
  const text: string = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return null;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record: Record<string, unknown> = parsed as Record<string, unknown>;
  const urlValue: unknown = record['url'];
  const atValue: unknown = record['at'];
  if (typeof urlValue !== 'string' || urlValue.trim().length === 0) {
    return null;
  }
  if (typeof atValue !== 'number' || !Number.isFinite(atValue)) {
    return null;
  }
  const entry: LastOkEntry = { url: urlValue, at: atValue };
  return entry;
}

/** 有可用记录、且记录里的地址现在还过得了 `normalizeRemoteUrl` → 才允许出「重新连接」。 */
export function canReconnect(raw: string): boolean {
  const entry: LastOkEntry | null = decodeLastOk(raw);
  if (entry === null) {
    return false;
  }
  return normalizeRemoteUrl(entry.url).ok;
}

/**
 * 取一条（已归一的）URL 的 authority：`scheme://` 之后、第一个 `/` `?` `#` 之前。
 *
 * 按钮文案只用它（`192.168.1.6:3080`、`[::1]:3080`），**天然不含 query，也就不会回显令牌**。
 */
function authorityOf(url: string): string {
  const text: string = typeof url === 'string' ? url : '';
  const matched: RegExpExecArray | null = SCHEME_RE.exec(text);
  const rest: string = matched !== null ? text.slice(matched[0].length) : text;
  let end: number = rest.length;
  const marks: string[] = ['/', '?', '#'];
  for (const mark of marks) {
    const at: number = rest.indexOf(mark);
    if (at >= 0 && at < end) {
      end = at;
    }
  }
  return rest.slice(0, end);
}

/**
 * 生成「一键重连」按钮的文案。
 *
 * - 没有记录 / 记录里的地址已不合法 → 空串（UI 此时显示「测试连接」）；
 * - 可重连 → `重新连接 <host:port>`（只到 authority，**绝不带令牌**）；
 * - 成功时刻距 `now` 超过 7 天 → 追加 `（7 天前）`，提醒用户这条记录可能早就失效了
 *   （网络换了、电脑换 IP 了），但**仍然给按钮**——没别的线索时它仍是最省事的一次尝试。
 * - `now` 或 `at` 不是有限数字时不加后缀（宁可少一句提示，也不要显示「0 天前」这种噪声）。
 */
export function reconnectLabel(entry: LastOkEntry | null, now: number): string {
  if (entry === null) {
    return '';
  }
  const check: RemoteUrlCheck = normalizeRemoteUrl(entry.url);
  if (!check.ok) {
    return '';
  }
  const authority: string = authorityOf(check.url);
  if (authority.length === 0) {
    return '';
  }
  const label: string = `重新连接 ${authority}`;
  const at: number = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0;
  const nowMs: number = typeof now === 'number' && Number.isFinite(now) ? now : 0;
  if (at > 0 && nowMs > 0 && nowMs - at > RECONNECT_STALE_MS) {
    return `${label}（7 天前）`;
  }
  return label;
}

/**
 * 把地址里 `token` / `k` 的**值**换成 `***`，用于日志、诊断文案与按钮/标签（下游会拿它显示）。
 *
 * 为什么必须有这一层：`docs/CONFIG-UX.md` §B.3 的约束是「任何拼进 message / hint 的地址
 * 都要打码」；用户把截图发到群里时，一条完整地址就等于把 owner 令牌交出去了。
 * 口径：
 * - 只打码 query 里的 `token` / `k`（大小写不敏感）——与 `hasToken` 同一口径，
 *   避免「地址说有令牌但显示没打码」这种自相矛盾；
 * - 其它参数、路径、fragment、原始顺序与大小写**原样保留**（诊断信息不能因此失真）；
 * - 没有令牌参数时返回原串（前台日志里地址照旧可读可复制）。
 */
export function sanitizeUrlForDisplay(url: string): string {
  const text: string = typeof url === 'string' ? url : '';
  if (text.length === 0) {
    return '';
  }
  const hash: number = text.indexOf('#');
  const beforeHash: string = hash >= 0 ? text.slice(0, hash) : text;
  const fragment: string = hash >= 0 ? text.slice(hash) : '';
  const question: number = beforeHash.indexOf('?');
  if (question < 0) {
    return text;
  }
  const head: string = beforeHash.slice(0, question);
  const pairs: string[] = beforeHash.slice(question + 1).split('&');
  let masked: boolean = false;
  const rewritten: string[] = [];
  for (const pair of pairs) {
    const equal: number = pair.indexOf('=');
    const key: string = equal >= 0 ? pair.slice(0, equal) : pair;
    if (equal >= 0 && TOKEN_KEYS.indexOf(key.toLowerCase()) >= 0) {
      rewritten.push(`${key}=${MASK}`);
      masked = true;
      continue;
    }
    // 没有 `=` 的裸键（`?k`）不是「值」，原样留着，免得把 URL 形态改掉
    rewritten.push(pair);
  }
  if (!masked) {
    return text;
  }
  return `${head}?${rewritten.join('&')}${fragment}`;
}
