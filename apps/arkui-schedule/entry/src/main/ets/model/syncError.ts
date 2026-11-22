/**
 * Git 同步错误的分级与展示文案（纯逻辑，不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 输入是「桥/服务层给的东西」：桥错误码（`E_AUTH` | `E_HTTP` | `E_GIT` | `E_FS`）、
 * HTTP 状态码（数字，或 `'HTTP 401'` 这种文本），以及原始中文 message。
 * 输出固定四档，设置页据此决定颜色、是否提供「重试」以及给用户看的中文说明：
 *
 * | level | 含义 | retryable | 用户要做什么 |
 * |---|---|---|---|
 * | `auth` | 401 用户名/令牌不对、403 无权限 | 否 | 去设置页改用户名与 token、确认仓库权限 |
 * | `conflict` | 分支分叉 / 推送被拒 / 409 | 否 | 先「拉取」再「推送」（应用不自动合并） |
 * | `retry` | 网络不可达 / DNS / 超时 / 429 / 5xx | 是 | 直接重试或换网络 |
 * | `fatal` | 404 / 证书错误 / 本地磁盘 / 配置不全 / 未知 | 否 | 按 detail 修正配置或环境 |
 *
 * 每类都给**可操作**的中文建议（401 会点明「Gitee 用户名是登录名不是邮箱」，
 * 证书错误会点明「应用不会跳过证书校验」），而不是把原始异常原样抛给用户。
 *
 * 两条硬约束（有单测）：
 * 1. **绝不回显凭据**：message 先过 `redactSecrets()`，`Basic xxx` / `Bearer xxx` /
 *    `x-access-token:xxx` / `token=xxx` / `ghp_…` / `sk-…` 一律打码；
 * 2. 幂等：同一输入永远得到同一结果（纯函数，无时间/随机/全局状态）。
 */

/** 错误等级：只允许这四档（UI 用它们选颜色与按钮）。 */
export type SyncErrorLevel = 'fatal' | 'retry' | 'conflict' | 'auth';

/** 细化分类键，便于日志与测试断言（不直接展示给用户）。 */
export type SyncErrorKind =
  | 'network'
  | 'dns'
  | 'certificate'
  | 'timeout'
  | 'rate-limit'
  | 'server'
  | 'auth'
  | 'forbidden'
  | 'notfound'
  | 'conflict'
  | 'no-main'
  | 'remote-indeterminate'
  | 'disk'
  | 'input'
  | 'unknown';

/** 分级结果。 */
export interface SyncErrorInfo {
  /** 四档等级。 */
  level: SyncErrorLevel;
  /** 一句话标题（中文，可直接当小标题）。 */
  title: string;
  /** 具体说明 + 用户下一步动作（中文，已脱敏）。 */
  detail: string;
  /** 同一操作「直接重试」是否可能成功（网络类为 true，配置/权限/冲突为 false）。 */
  retryable: boolean;
  /** 细化分类键。 */
  kind: SyncErrorKind;
}

/** detail 的最大长度（超出截断，避免把整份 HTML 错误页塞进界面）。 */
const MAX_DETAIL_LENGTH: number = 300;

/** 凭据打码规则（顺序敏感：先长前缀，再裸 token 形态）。 */
const SECRET_PATTERNS: RegExp[] = [
  /(Basic\s+)[A-Za-z0-9+/=._~-]{8,}/g,
  /(Bearer\s+)[A-Za-z0-9+/=._~-]{8,}/g,
  /(x-access-token:)[^\s"',;]+/g,
  /((?:token|secret|password|access_token|api[_-]?key|aiKey)=)[^\s"'&,;]+/gi,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g
];

/** 已知 HTTP 状态码集合（只在 message 里认这些，避免把「60 秒」误判成状态码）。 */
const HTTP_STATUSES: number[] = [
  400, 401, 402, 403, 404, 405, 408, 409, 410, 422, 429, 451, 500, 502, 503, 504
];

/** 允许重试的动作（与服务层 GitSyncService 的 op 名一致）。 */
const SYNC_ACTIONS: string[] = ['pull', 'push', 'status'];

/**
 * 把凭据打码：保留 «标识前缀»，其余替换成 `***`。
 *
 * 与 `rawfile/git/git-bridge.js` 的 `sanitizeMessage()` 同一思路（这里是 ArkTS 侧的第二道防线：
 * 即使桥把 token 拼进了 message，界面与日志也只会看到 `***`）。
 */
export function redactSecrets(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    return '';
  }
  let text: string = raw;
  for (let index = 0; index < SECRET_PATTERNS.length; index++) {
    text = text.replace(SECRET_PATTERNS[index], (matched: string, prefix: string): string => {
      if (matched === undefined || prefix === undefined) {
        return '***';
      }
      return `${prefix}***`;
    });
  }
  return text;
}

/** 归一化 message：脱敏 → 折叠空白 → 截断。 */
function cleanMessage(raw: string): string {
  const text: string = redactSecrets(typeof raw === 'string' ? raw : '');
  const collapsed: string = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_DETAIL_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_DETAIL_LENGTH)}…`;
}

/** 从状态码入参（数字或 `'HTTP 401'`）取状态码；没有返回 0。 */
function statusFromArg(value: string | number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const matched = /(?:HTTP\s*)?(\d{3})\b/i.exec(value);
  if (matched === null) {
    return 0;
  }
  const parsed = Number.parseInt(matched[1], 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 从脱敏后的 message 里认状态码（只认 HTTP_STATUSES 里的值）。 */
function statusFromMessage(text: string): number {
  for (let index = 0; index < HTTP_STATUSES.length; index++) {
    const candidate: number = HTTP_STATUSES[index];
    const pattern = new RegExp(`(?:HTTP\\s*)?\\b${candidate}\\b`, 'i');
    if (pattern.test(text)) {
      return candidate;
    }
  }
  return 0;
}

/** 按固定字段构造结果（ArkTS 不允许用对象展开，这里逐字段写）。 */
function info(
  kind: SyncErrorKind,
  level: SyncErrorLevel,
  title: string,
  detail: string,
  retryable: boolean
): SyncErrorInfo {
  return { kind: kind, level: level, title: title, detail: detail, retryable: retryable };
}

/** 把「基础说明」和「原始信息」拼成 detail（原始信息为空或与基础说明重复时不重复拼）。 */
function withRaw(base: string, raw: string): string {
  if (raw.length === 0 || raw === base || base.indexOf(raw) >= 0) {
    return base;
  }
  const combined: string = `${base} 原始信息：${raw}`;
  if (combined.length <= MAX_DETAIL_LENGTH) {
    return combined;
  }
  return `${combined.slice(0, MAX_DETAIL_LENGTH)}…`;
}

/**
 * 把同步失败分档成用户能懂的中文。
 *
 * @param kindOrStatus 桥错误码（`E_AUTH` / `E_HTTP` / `E_GIT` / `E_FS` / `E_INPUT`）、
 *                    HTTP 状态码数字，或 `'HTTP 401'` 文本；不知道时传空串
 * @param message      原始中文 message（可为空；含凭据会被打码）
 */
export function classifySyncError(kindOrStatus: string | number, message: string): SyncErrorInfo {
  const code: string = typeof kindOrStatus === 'string' ? kindOrStatus.trim().toUpperCase() : '';
  const raw: string = cleanMessage(typeof message === 'string' ? message : '');
  const argStatus: number = statusFromArg(kindOrStatus);
  const status: number = argStatus > 0 ? argStatus : statusFromMessage(raw);
  // 「网络层失败」的伪状态码 0 只在调用方显式传数字 0 时才成立；
  // 不能把「没认出状态码」也当成网络错误（否则「请先在设置页填写仓库地址」会被误判）。
  const explicitZero: boolean = typeof kindOrStatus === 'number' && kindOrStatus === 0;

  // 1. 本地磁盘：与网络无关，必须最先分出来（否则「文件读写失败」会被当成网络问题重试）
  if (
    code === 'E_FS' ||
    /磁盘|空间不足|只读文件系统|本地文件读写失败|创建目录失败|写入日程失败|EACCES|EPERM|ENOSPC|EIO|EBUSY/.test(raw)
  ) {
    return info(
      'disk',
      'fatal',
      '本地磁盘错误',
      withRaw('本机目录读写失败（空间不足 / 权限 / 只读）。请清理存储空间或重装应用后重试。', raw),
      false
    );
  }

  // 1b. 证书：TLS 校验失败与「没连上」不是一回事，必须单独指路（重试不会变好）
  if (
    /CERT_|ERR_CERT|certificate|self.?signed|自签名|证书(?:错误|过期|不受信任|链)|SSL handshake|TLS handshake|UNABLE_TO_VERIFY|unable to get local issuer/i.test(
      raw
    )
  ) {
    return info(
      'certificate',
      'fatal',
      '证书错误（HTTPS 校验未通过）',
      withRaw(
        'HTTPS 证书校验没通过（过期 / 域名不匹配 / 自签名 / 系统时间不对）。' +
          '请让服务端使用受信任证书，并检查手机系统时间；应用不会跳过证书校验。',
        raw
      ),
      false
    );
  }

  // 2. 鉴权：401 是用户名/令牌不对，403 是令牌有效但没权限 —— 都归 auth，文案不同
  if (code === 'E_AUTH' || status === 401 || /认证失败|令牌无效|令牌失效|token 无效|未授权/.test(raw)) {
    if (status === 403 || /无权限|权限不足|forbidden/i.test(raw)) {
      return info(
        'forbidden',
        'auth',
        '无权限（403）',
        withRaw(
          'token 有效，但这个 token 没有该仓库的读写权限：请确认仓库路径/命名空间、组织权限与分支保护规则；' +
            '自建服务还要确认账号在该仓库有 write 权限。',
          raw
        ),
        false
      );
    }
    return info(
      'auth',
      'auth',
      '认证失败（401：用户名或 token）',
      withRaw(
        '请到设置页检查用户名与令牌：GitHub 用 x-access-token + PAT；' +
          'Gitee 的用户名是「登录名」（不是邮箱），留空必然 401；GitLab 用用户名或 oauth2。' +
          '另确认 token 未过期、有 repo 读写权限、复制时没带空格。',
        raw
      ),
      false
    );
  }
  if (status === 403 || /无权限|权限不足|forbidden/i.test(raw)) {
    return info(
      'forbidden',
      'auth',
      '无权限（403）',
      withRaw(
        'token 有效但没有该仓库的读写权限：请确认仓库路径/命名空间、组织权限与分支保护规则，或换一个有权限的 token。',
        raw
      ),
      false
    );
  }

  // 3. 冲突：本应用永不 merge，分叉只能靠用户先拉取
  if (status === 409 || /推送被拒绝|无法快进|已分叉|存在冲突|non-fast-forward/i.test(raw)) {
    return info(
      'conflict',
      'conflict',
      '分支已分叉（需要先拉取）',
      withRaw(
        '本机与远端都有新提交，应用不会自动合并。请先「拉取」（只做快进）再「推送」；若仍分叉，说明有其它设备写入了本设备目录。',
        raw
      ),
      false
    );
  }

  // 3b. 远端非空但没有 main（mod-p0a-no-main-probe）：known typed 错必须**一句话说清**。
  // 绝不落进 §9 兜底的「未知错误：…原始信息：<原文>」嵌套转储；文案本身已经点名分支与下一步。
  if (/远端已有分支|远端已有引用|缺少 main|远端并非空仓库|Could not find (origin\/)?main/i.test(raw)) {
    return info('no-main', 'fatal', '远端缺少 main 分支', raw, false);
  }

  // 3c. 探测未定（桥 fail-closed）：不是网络抖动，也不是「空仓库」，重试会重新探测。
  if (/无法确认远端状态|远端状态探测失败/.test(raw)) {
    return info('remote-indeterminate', 'retry', '无法确认远端状态', raw, true);
  }

  // 4. 仓库不存在：404 在 GitHub 上也可能是「私有仓库 + 无凭据」
  if (status === 404 || /仓库不存在|repository not found/i.test(raw)) {
    return info(
      'notfound',
      'fatal',
      '仓库不存在（404）',
      withRaw(
        '请检查仓库地址拼写与分支名；私有仓库在没带 token（或 token 无权限）时也会返回 404。',
        raw
      ),
      false
    );
  }

  // 5. 限流 / 服务端：都值得稍后重试
  if (status === 429 || /请求过于频繁|限流|额度超限/.test(raw)) {
    return info(
      'rate-limit',
      'retry',
      '请求过于频繁（429）',
      withRaw('远端限流：请等 1–2 分钟后重试，避免连续快速点击。', raw),
      true
    );
  }
  if ((status >= 500 && status <= 599) || /服务端错误|服务异常|服务不可用/.test(raw)) {
    return info(
      'server',
      'retry',
      '远端服务异常（5xx）',
      withRaw('仓库服务端暂时异常：请稍后重试；持续失败可查看 GitHub / Gitee 状态页。', raw),
      true
    );
  }

  // 5b. 其它 4xx（418/451/…）：确定性拒绝，重试无意义
  if (status >= 400 && status <= 499) {
    return info(
      'unknown',
      'fatal',
      `请求被远端拒绝（HTTP ${status}）`,
      withRaw(
        '远端拒绝了这次同步请求：请检查仓库地址、分支名与 token 权限，必要时先在网页端确认仓库可访问。',
        raw
      ),
      false
    );
  }

  // 6. 超时先于网络：超时也属于网络类，但文案不同
  if (/超时|timed?\s*out|timeout/i.test(raw)) {
    return info(
      'timeout',
      'retry',
      '同步超时',
      withRaw('等待远端响应超时（单次最多 60 秒）。请检查网络后重试；长时间失败请换一个网络环境。', raw),
      true
    );
  }

  // 7. 配置不全（服务层在发请求前就拦下的那些）——必须早于「网络」，
  //    否则「请先在设置页填写仓库地址」这类确定性提示会被当成网络抖动鼓励重试
  if (
    code === 'E_INPUT' ||
    /请先在设置页|请填写|配置不完整|尚未就绪|尚未初始化/.test(raw)
  ) {
    return info(
      'input',
      'fatal',
      '同步配置不完整',
      withRaw('同步前需要：仓库地址（HTTPS）、设备标识、token，并等隐藏 Web 同步内核就绪。请到设置页补齐。', raw),
      false
    );
  }

  // 7b. DNS：解析不到域名与「连不上」在排查手段上完全不同（先按域名/网络/DNS 查）
  if (
    /ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo|nodename nor servname|域名解析失败|无法解析域名|域名不存在|未知主机/i.test(
      raw
    )
  ) {
    return info(
      'dns',
      'retry',
      '域名解析失败（DNS）',
      withRaw(
        '本机解析不到仓库域名：请核对域名拼写（gitee.com / github.com / 自建域名）、手机网络与 DNS/VPN；' +
          '公司网络或自建仓库可能要先连内网。换网络后重试。',
        raw
      ),
      true
    );
  }

  // 8. 网络不可达
  if (
    explicitZero ||
    code === 'E_HTTP' ||
    /网络|不可达|无法连接|连接失败|断网|域名解析|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ECONNRESET|DNS/i.test(raw)
  ) {
    return info(
      'network',
      'retry',
      '网络不可达',
      withRaw('手机连不上仓库域名（可能是断网、DNS 或代理/防火墙拦截）。请检查网络后重试。', raw),
      true
    );
  }

  // 9. 兜底
  return info(
    'unknown',
    'fatal',
    '同步失败',
    withRaw('未知错误：可以直接重试一次；若持续失败，请把下面的原始信息反馈给开发者。', raw),
    false
  );
}

/** 本地日期键 `YYYY-MM-DD`（本机时区）。 */
function localDateKeyOf(date: Date): string {
  const month: string = `${date.getMonth() + 1}`.padStart(2, '0');
  const day: string = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 本地时钟 `HH:MM`（24 小时制，补零）。 */
function localClockOf(date: Date): string {
  const hour: string = `${date.getHours()}`.padStart(2, '0');
  const minute: string = `${date.getMinutes()}`.padStart(2, '0');
  return `${hour}:${minute}`;
}

/**
 * 「上次同步时间」文案。
 *
 * - 空串 → `上次同步：从未同步`
 * - 今天 → `上次同步：今天 14:32`
 * - 同年 → `上次同步：11-14 09:05`
 * - 更早 → `上次同步：2025-11-14 09:05`
 * - 无法解析 → `上次同步：时间未知`
 *
 * 用本机时区换算（与记录 ts 的展示口径一致），不依赖 Intl。
 */
export function describeLastSync(lastSyncAt: string, nowIso: string): string {
  const at: string = typeof lastSyncAt === 'string' ? lastSyncAt.trim() : '';
  if (at.length === 0) {
    return '上次同步：从未同步';
  }
  const atMs: number = Date.parse(at);
  if (Number.isNaN(atMs)) {
    return '上次同步：时间未知';
  }
  const atDate = new Date(atMs);
  const clock: string = localClockOf(atDate);
  const month: string = `${atDate.getMonth() + 1}`.padStart(2, '0');
  const day: string = `${atDate.getDate()}`.padStart(2, '0');
  const nowMs: number = Date.parse(typeof nowIso === 'string' ? nowIso : '');
  if (Number.isNaN(nowMs)) {
    // 调用方没给可解析的「现在」时退回绝对时间，保证结果确定（不读系统时钟）
    return `上次同步：${atDate.getFullYear()}-${month}-${day} ${clock}`;
  }
  const nowDate = new Date(nowMs);
  if (localDateKeyOf(atDate) === localDateKeyOf(nowDate)) {
    return `上次同步：今天 ${clock}`;
  }
  if (atDate.getFullYear() === nowDate.getFullYear()) {
    return `上次同步：${month}-${day} ${clock}`;
  }
  return `上次同步：${atDate.getFullYear()}-${month}-${day} ${clock}`;
}

/** 归一化「可重试动作」：只接受 pull / push / status，其它一律空串。 */
export function normalizeSyncAction(value: string): string {
  const text: string = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SYNC_ACTIONS.indexOf(text) >= 0 ? text : '';
}

/** 动作的中文名（用于按钮与提示文案）。 */
export function syncActionLabel(action: string): string {
  const normalized: string = normalizeSyncAction(action);
  if (normalized === 'pull') {
    return '拉取';
  }
  if (normalized === 'push') {
    return '推送';
  }
  if (normalized === 'status') {
    return '查看状态';
  }
  return '同步';
}

/** 是否满足「重试上一次同步」的前置条件（有动作、且不是网络类自动重试中）。 */
export function canRetrySync(lastSyncAction: string, busy: boolean): boolean {
  return normalizeSyncAction(lastSyncAction).length > 0 && busy !== true;
}

// ---------------------------------------------------------------- 分支名（A2）

/** 默认分支名（用户没填时用它；与 `docs/DATA-CONTRACT.md` §1 的 main 一致）。 */
export const DEFAULT_BRANCH: string = 'main';

/** 分支名最大长度（git 自身没有硬上限，这里给界面一个可读的上限）。 */
const MAX_BRANCH_LENGTH: number = 120;

function trimText(value: string): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 归一分支名：去首尾空白、去 `refs/heads/` 前缀、去首尾斜杠。
 *
 * 只做「明显冗余」的清理；非法字符交给 `validateBranchName` 判断（不静默吞掉用户的输入）。
 */
export function normalizeBranchName(raw: string): string {
  let text: string = trimText(raw);
  if (text.indexOf('refs/heads/') === 0) {
    text = text.slice('refs/heads/'.length);
  }
  while (text.length > 0 && text.charAt(0) === '/') {
    text = text.slice(1);
  }
  while (text.length > 0 && text.charAt(text.length - 1) === '/') {
    text = text.slice(0, text.length - 1);
  }
  return text;
}

/**
 * 校验分支名（git check-ref-format 的可读子集）。
 *
 * @returns 空串表示合法；否则返回可直接展示的中文原因
 */
export function validateBranchName(raw: string): string {
  const text: string = normalizeBranchName(raw);
  if (text.length === 0) {
    return `分支名不能为空（默认 ${DEFAULT_BRANCH}）`;
  }
  if (text.length > MAX_BRANCH_LENGTH) {
    return `分支名最长 ${MAX_BRANCH_LENGTH} 个字符`;
  }
  if (/[\s\u3000]/.test(text)) {
    return '分支名不能包含空格或制表符';
  }
  if (/[~^:?*[\]\\]/.test(text)) {
    return '分支名不能包含这些字符：~ ^ : ? * [ ] \\';
  }
  if (text.indexOf('..') >= 0) {
    return '分支名不能包含连续的两个点（..）';
  }
  if (text.indexOf('//') >= 0) {
    return '分支名不能包含连续的斜杠（//）';
  }
  if (text.charAt(0) === '-') {
    return '分支名不能以「-」开头';
  }
  if (text.charAt(text.length - 1) === '.') {
    return '分支名不能以「.」结尾';
  }
  if (/\.lock$/.test(text)) {
    return '分支名不能以 .lock 结尾';
  }
  if (text.indexOf('@{') >= 0) {
    return '分支名不能包含「@{」';
  }
  if (text === '@') {
    return '分支名不能是「@」';
  }
  const segments: string[] = text.split('/');
  for (let index = 0; index < segments.length; index++) {
    const segment: string = segments[index];
    if (segment.length === 0) {
      return '分支名的斜杠两侧必须有内容（不能出现空段）';
    }
    if (segment === '.' || segment === '..') {
      return '分支名不能包含「.」或「..」段';
    }
  }
  return '';
}

// ---------------------------------------------------------------- ahead / behind（A2）

/** ahead/behind 的计算结果（两侧提交集合的差）。 */
export interface AheadBehind {
  /** 本地独有提交数（要推送的量）。 */
  ahead: number;
  /** 远端独有提交数（要拉取的量）。 */
  behind: number;
  /** 两边都有独有提交（真分叉，必须先拉取再推送）。 */
  diverged: boolean;
  /** 两侧是否有可比较的提交（都为空时无法判断领先/落后）。 */
  comparable: boolean;
}

/**
 * 由「本地分支提交 sha 列表」和「远端分支提交 sha 列表」算 ahead/behind。
 *
 * 纯函数：只看集合差，不读磁盘/不联网。两侧列表都以**新到旧**给出（`git.log` 的顺序），
 * 但结果与顺序无关；同一 sha 重复出现只算一次。
 *
 * 注意：桥里给的是 `git.log` 截断后的列表（默认最多 500 条），因此结果是
 * **下界**（真实领先数不会更小）——对「要不要推送/拉取」这个判断足够。
 */
export function computeAheadBehind(localShas: string[], remoteShas: string[]): AheadBehind {
  const local: string[] = Array.isArray(localShas) ? localShas : [];
  const remote: string[] = Array.isArray(remoteShas) ? remoteShas : [];
  const remoteSet: Record<string, boolean> = {};
  for (let index = 0; index < remote.length; index++) {
    const sha: string = trimText(remote[index]);
    if (sha.length > 0) {
      remoteSet[sha] = true;
    }
  }
  const localSet: Record<string, boolean> = {};
  for (let index = 0; index < local.length; index++) {
    const sha: string = trimText(local[index]);
    if (sha.length > 0) {
      localSet[sha] = true;
    }
  }
  let ahead: number = 0;
  const localKeys: string[] = Object.keys(localSet);
  for (let index = 0; index < localKeys.length; index++) {
    if (remoteSet[localKeys[index]] !== true) {
      ahead++;
    }
  }
  let behind: number = 0;
  const remoteKeys: string[] = Object.keys(remoteSet);
  for (let index = 0; index < remoteKeys.length; index++) {
    if (localSet[remoteKeys[index]] !== true) {
      behind++;
    }
  }
  const comparable: boolean = localKeys.length > 0 || remoteKeys.length > 0;
  return { ahead: ahead, behind: behind, diverged: ahead > 0 && behind > 0, comparable: comparable };
}

/** ahead/behind → 一行中文（空仓库等无法判断时也给可读结论）。 */
export function describeAheadBehind(info: AheadBehind): string {
  if (info === null || info === undefined || info.comparable !== true) {
    return '领先/落后未知（本地或远端还没有提交）';
  }
  if (info.ahead === 0 && info.behind === 0) {
    return '与远端一致';
  }
  if (info.ahead > 0 && info.behind === 0) {
    return `领先远端 ${info.ahead} 个提交`;
  }
  if (info.ahead === 0 && info.behind > 0) {
    return `落后远端 ${info.behind} 个提交`;
  }
  return `与远端分叉：领先 ${info.ahead}、落后 ${info.behind}`;
}

/** 本机改动的上传状态（只读诊断词，不是同步结果）。 */
export type UploadState = 'blocked' | 'failed' | 'retrying' | 'pending';

/** 同步状态视图（页面/服务共用一份文案）。 */
export interface SyncStatusView {
  /** 本机仓库是否已初始化（首次拉取前为 false）。 */
  initialized: boolean;
  /** 当前分支名。 */
  branch: string;
  /** 当前 HEAD（完整 sha，空串表示空仓库）。 */
  head: string;
  /** 本地独有提交数。 */
  ahead: number;
  /** 远端独有提交数。 */
  behind: number;
  /** 是否双向分叉。 */
  diverged: boolean;
  /** 冲突文件数（应用不 merge，正常应为 0）。 */
  conflicts: number;
  /** 工作区改动数（本机尚未上传的事实，绝不暗示云端已有）。 */
  changedCount: number;
  /**
   * 这些本机改动的上传状态（mod-sync-silence-phase-b）：只用于诊断措辞，
   * 与 `changedCount` 成对出现，绝不把「本机未上传」写成「云端已同步」。
   * 缺省按 `pending`，保证任何调用点都不会输出无状态的裸改动数。
   */
  uploadState?: UploadState;
  /** 远端是否已配置。 */
  remoteConfigured: boolean;
  /** 最近一条提交说明（可空）。 */
  lastCommitMessage: string;
}

/** 短 sha（7 位；空串给「（空仓库）」）。 */
export function shortSha(sha: string): string {
  const text: string = trimText(sha);
  if (text.length === 0) {
    return '（空仓库）';
  }
  return text.length > 7 ? text.substring(0, 7) : text;
}

/**
 * 上传状态的短标签（mod-sync-silence-phase-b）：只描述本机意图的上传处境，不是同步结果。
 * 四项穷举 + 缺省 `待上传`，因此「本地改动 N 处」永远带着一个非成功的状态词。
 */
export function describeUploadState(state: UploadState | undefined): string {
  switch (state) {
    case 'blocked': return '已停止上传';
    case 'failed': return '上传失败';
    case 'retrying': return '重试中';
    case 'pending': return '待上传';
    default: return '待上传';
  }
}

/**
 * 同步状态一行文案（A2）：分支 / HEAD / ahead / behind / 本机未上传改动 / 冲突 / 远端。
 *
 * 例：`分支 main｜HEAD a1b2c3d｜领先远端 2 个提交｜本地改动 3 处（本机未上传·待上传）｜冲突 0｜远端 已配置`
 */
export function describeSyncStatus(view: SyncStatusView): string {
  if (view === null || view === undefined || view.initialized !== true) {
    return '本机仓库尚未初始化（首次「拉取」会自动克隆）';
  }
  const branch: string = trimText(view.branch).length > 0 ? trimText(view.branch) : DEFAULT_BRANCH;
  const parts: string[] = [];
  parts.push(`分支 ${branch}`);
  parts.push(`HEAD ${shortSha(view.head)}`);
  parts.push(
    describeAheadBehind({
      ahead: view.ahead,
      behind: view.behind,
      diverged: view.diverged === true,
      comparable: trimText(view.head).length > 0
    })
  );
  // mod-sync-silence-phase-b：本机改动 ≠ 云端已有。改动数永远与上传状态成对出现，
  // 措辞明确「本机未上传」，避免把本地工作区事实读成云端同步成功。
  parts.push(`本地改动 ${view.changedCount} 处（本机未上传·${describeUploadState(view.uploadState)}）`);
  parts.push(`冲突 ${view.conflicts}`);
  parts.push(`远端 ${view.remoteConfigured === true ? '已配置' : '未配置'}`);
  const message: string = trimText(view.lastCommitMessage);
  if (message.length > 0) {
    parts.push(`最近提交 ${message.length > 40 ? message.substring(0, 40) + '…' : message}`);
  }
  return parts.join('｜');
}

/**
 * 同步状态 → 推送按钮的可用性说明（空串 = 现在可以推）。
 *
 * 页面据此禁用「推送」并给一行原因，而不是让用户点了没反应。
 */
export function describePushReadiness(view: SyncStatusView): string {
  if (view === null || view === undefined || view.initialized !== true) {
    return '先「立即同步」（拉取）完成首次克隆，才能推送';
  }
  if (view.diverged === true) {
    return '与远端已分叉：请先「拉取」，本应用不会强制推送';
  }
  if (view.changedCount === 0 && view.ahead === 0) {
    return '没有新的本地改动可推送';
  }
  return '';
}

/**
 * 「上次同步」一行：时间 + 动作 + 成败（A2 第 2 条）。
 *
 * 例：`上次同步：今天 14:32 · 上次推送成功` /
 *     `上次同步：今天 14:32 · 上次推送失败：认证失败（401…）`
 */
export function describeLastSyncOutcome(
  lastSyncAt: string,
  lastSyncError: string,
  lastSyncAction: string,
  nowIso: string
): string {
  const base: string = describeLastSync(lastSyncAt, nowIso);
  const action: string = normalizeSyncAction(lastSyncAction);
  const label: string = action.length > 0 ? syncActionLabel(action) : '同步';
  const error: string = trimText(lastSyncError);
  if (error.length > 0) {
    const detail: string = error.length > 80 ? error.substring(0, 80) + '…' : error;
    return `${base} · 上次${label}失败：${detail}`;
  }
  if (trimText(lastSyncAt).length === 0) {
    return base;
  }
  return `${base} · 上次${label}成功`;
}
