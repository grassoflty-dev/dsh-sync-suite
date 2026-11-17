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
 * 不支持：IPv6 字面量（`http://[::1]:3080`）、带账号密码的地址 —— 内网 DSH 用 IPv4 即可，
 * 这两类会落到「地址不完整」的拒绝分支。
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
