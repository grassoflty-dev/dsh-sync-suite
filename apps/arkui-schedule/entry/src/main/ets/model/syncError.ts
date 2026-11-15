/**
 * Git 同步错误的分级与展示文案（纯逻辑，不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 输入是「桥/服务层给的东西」：桥错误码（`E_AUTH` | `E_HTTP` | `E_GIT` | `E_FS`）、
 * HTTP 状态码（数字，或 `'HTTP 401'` 这种文本），以及原始中文 message。
 * 输出固定四档，设置页据此决定颜色、是否提供「重试」以及给用户看的中文说明：
 *
 * | level | 含义 | retryable | 用户要做什么 |
 * |---|---|---|---|
 * | `auth` | 401 token 失效 / 403 无权限 | 否 | 去设置页换 token、确认仓库权限 |
 * | `conflict` | 分支分叉 / 推送被拒 / 409 | 否 | 先「拉取」再「推送」（应用不自动合并） |
 * | `retry` | 网络不可达 / 超时 / 429 / 5xx | 是 | 直接重试或换网络 |
 * | `fatal` | 404 / 本地磁盘 / 配置不全 / 未知 | 否 | 按 detail 修正配置或环境 |
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
  | 'timeout'
  | 'rate-limit'
  | 'server'
  | 'auth'
  | 'forbidden'
  | 'notfound'
  | 'conflict'
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

  // 2. 鉴权：401 是 token 失效，403 是 token 有效但没权限 —— 都归 auth，文案不同
  if (code === 'E_AUTH' || status === 401 || /认证失败|令牌无效|令牌失效|token 无效|未授权/.test(raw)) {
    if (status === 403 || /无权限|权限不足|forbidden/i.test(raw)) {
      return info(
        'forbidden',
        'auth',
        '无权限（403）',
        withRaw(
          'token 有效，但这个 token 没有该仓库的读写权限：请确认仓库路径/组织权限，或换一个有 repo 权限的 token。',
          raw
        ),
        false
      );
    }
    return info(
      'auth',
      'auth',
      '认证失败（token 失效）',
      withRaw(
        '请到设置页重新填写 token：确认它没有过期，并且具备仓库的 repo 读写权限（GitHub / Gitee 的 Personal Access Token）。',
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
      withRaw('token 有效但没有该仓库的读写权限：请确认仓库路径与组织权限，或换一个有权限的 token。', raw),
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
