/**
 * 三态视图的纯逻辑（**零 SDK import**，可被 `tools/tsconfig.json` 编译成 JS 由 Node 单测直接跑）。
 *
 * 契约来源：`docs/STATE-UI.md` §2（唯一技术方案）。四个结构性问题的判定都收敛在这里：
 * 1. **加载中可取消**：`canCancelLoading(elapsedMs)` —— 超过 `CANCEL_AFTER_MS` 才允许取消
 *    （太快给「取消」会让用户误点，等于把「等一下」变成「操作失败」）；
 * 2. **加载有进度**：`progressText(progress)` —— `-1` = 不确定进度，`0..100` 夹取取整；
 * 3. **错误有诊断**：`formatDiagnostics(input, now?)` —— 版本 / 设备 / 错误码 / 时间**四段永远都在**
 *    （缺一段用户就少一条反馈线索），配合 `describeFailure()` 生成「发生了什么 / 为什么 / 下一步」；
 * 4. **空态有出路：真按钮，或没有可点的东西时给一句事实**：
 *    `emptyStateIssue(title, actionLabel, showAction?, detail?)` —— 默认仍要求按钮；
 *    显式 `showAction: false` 时要求非空且非已知占位的 `detail`，由静态测试钉住。
 *    这一步是**词法检查**（空白 + 已知占位符），不判断句子说的是不是真的。
 *
 * 约定（与 `common/copy.ts` 一致）：
 * - **容错**：空串 / `undefined` / `null` / `NaN` 不抛异常，且**绝不产出「undefined」字样**；
 * - **幂等**：`describeFailure` 对已格式化过的入参原样返回，页面重复套一层不会出现
 *   「同步失败：同步失败：…」；
 * - **不编造**：`formatDiagnostics` 缺字段用兜底词（`未登记` / `无`），不猜内容。
 */
import { emptyText } from '../common/copy';

/** 三态：加载中。 */
export const STATE_LOADING: string = 'loading';

/** 三态：空（没有数据；出路是真按钮，或没有可点的东西时给一句事实）。 */
export const STATE_EMPTY: string = 'empty';

/** 三态：错误（发生了什么 / 为什么 / 下一步 + 诊断）。 */
export const STATE_ERROR: string = 'error';

/** 加载超过这么久才允许取消（毫秒）。组件不得自己写字面量 3000。 */
export const CANCEL_AFTER_MS: number = 3000;

/** 诊断单行的字段分隔符（四要素之间的唯一分隔）。 */
const SEGMENT_SEPARATOR: string = ' · ';

/** 省略号：加载文案统一以它结尾（与 `common/copy.ts` 的 `ELLIPSIS` 同形）。 */
const ELLIPSIS: string = '…';

/** 进度文案前缀：`正在处理…` / `正在处理 42%…`。 */
const PROGRESS_PREFIX: string = '正在处理';

/** 进度百分比的上限（夹取用）。 */
const PROGRESS_MAX: number = 100;

/** 诊断：版本缺失时的兜底词（不是「未知」，避免和「用户没填」混淆）。 */
const FALLBACK_VERSION: string = '未取到版本';

/** 诊断：设备 id 缺失时的兜底词（与设置页「未登记」口径一致）。 */
const FALLBACK_DEVICE: string = '未登记';

/** 诊断：错误码缺失时的兜底词。 */
const FALLBACK_CODE: string = '无';

/** 失败三段式：`what` 缺失时的兜底主语（`操作失败：…` 比 `失败：…` 像人话）。 */
const FALLBACK_WHAT: string = '操作';

/** 失败三段式：`why` 缺失时的兜底原因（不编造具体原因）。 */
const FALLBACK_WHY: string = '原因未知';

/** 失败三段式：`next` 缺失时的兜底下一步（与 `common/copy.ts` 的默认建议一致）。 */
const FALLBACK_NEXT: string = '重试，或到设置页检查配置';

/** 失败三段式的固定分隔：`<what>失败：<why>。下一步：<next>`。 */
const FAILURE_MARK: string = '失败：';

/** 「失败」二字（用于剥离已带后缀的 `what`，保证幂等）。 */
const FAILURE_TAG: string = '失败';

/** 下一步标记（避免 `next` 里已经带了又补一遍）。 */
const NEXT_MARK: string = '下一步：';

/** 空态标题的识别词（命中任一即认为「这是一个空态」，必须配动作）。 */
const EMPTY_MARKERS: string[] = ['暂无', '没有', '空'];

/** 句末标点：命中则不再补句号（中英文与省略号都算）。 */
const TERMINAL_PUNCTUATION: RegExp = /[。！？；…!?;]$/;

/** `what` 后缀剥离的最大轮数（防止畸形输入死循环）。 */
const MAX_STRIP_ROUNDS: number = 8;

/** 归一化文本：非字符串 → 空串；折叠连续空白；去首尾空白。 */
function normalizeText(raw: string): string {
  const text: string = typeof raw === 'string' ? raw : '';
  return text.replace(/\s+/g, ' ').trim();
}

/** 两位补零（时间格式 `YYYY-MM-DD HH:mm:ss` 用）。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 时间戳（毫秒）→ `YYYY-MM-DD HH:mm:ss`（本地时区由运行环境决定，函数只吃时间戳）。 */
function formatTimestamp(timestamp: number): string {
  const date: Date = new Date(timestamp);
  const year: number = date.getFullYear();
  const month: number = date.getMonth() + 1;
  const day: number = date.getDate();
  const hours: number = date.getHours();
  const minutes: number = date.getMinutes();
  const seconds: number = date.getSeconds();
  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** 选一个能用的时间戳：`timestamp` 优先，其次调用方给的 `now`，最后用当前时间（永不 NaN）。 */
function resolveTimestamp(timestamp: number, now: number | undefined): number {
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return timestamp;
  }
  if (typeof now === 'number' && Number.isFinite(now) && now > 0) {
    return now;
  }
  return Date.now();
}

/** 补句末标点：空串保持空串，已带句末标点原样返回。 */
function withPeriod(raw: string): string {
  if (raw.length === 0) {
    return '';
  }
  return TERMINAL_PUNCTUATION.test(raw) ? raw : `${raw}。`;
}

/** 剥掉 `what` 结尾的标点与「失败」后缀（`同步失败。` → `同步`），并保证非空。 */
function stripFailureSuffix(raw: string): string {
  let text: string = raw;
  for (let round = 0; round < MAX_STRIP_ROUNDS; round++) {
    text = text.replace(/[。！？；：:!?;\s]+$/, '');
    if (!text.endsWith(FAILURE_TAG)) {
      break;
    }
    text = text.slice(0, text.length - FAILURE_TAG.length).trim();
  }
  return text.length > 0 ? text : FALLBACK_WHAT;
}

/** 剥掉 `next` 开头重复的「下一步：」（`下一步：检查网络` → `检查网络`）。 */
function stripNextMark(raw: string): string {
  let text: string = raw;
  while (text.indexOf(NEXT_MARK) === 0) {
    text = text.slice(NEXT_MARK.length).trim();
  }
  return text;
}

/**
 * 是否已到「可以取消」的时刻：非法 / 负数按 0 处理。
 *
 * `elapsedMs >= CANCEL_AFTER_MS` 才算可取消（正好 3000ms 视为已到）。
 */
export function canCancelLoading(elapsedMs: number): boolean {
  const elapsed: number = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  return elapsed >= CANCEL_AFTER_MS;
}

/**
 * 加载进度文案：
 * - `progress < 0`（含 `NaN`）= 不确定进度 → `正在处理…`；
 * - `0..100` → `正在处理 42%…`（先夹取到 `[0, 100]`，再四舍五入取整）。
 */
export function progressText(progress: number): string {
  if (!Number.isFinite(progress) || progress < 0) {
    return `${PROGRESS_PREFIX}${ELLIPSIS}`;
  }
  const clamped: number = Math.min(PROGRESS_MAX, Math.max(0, progress));
  const percent: number = Math.round(clamped);
  return `${PROGRESS_PREFIX} ${percent}%${ELLIPSIS}`;
}

/** 诊断四要素（`formatDiagnostics` 的入参）。 */
export interface DiagnosticsInput {
  /** 版本号，例 `'1.0.0'`（来自 `common/version.ts` 的 `APP_VERSION`）。 */
  version: string;
  /** 设备标识，例 `'device-2'`；空 → `未登记`。 */
  deviceId: string;
  /** 错误码，例 `'E_GIT_TIMEOUT'`；空 → `无`。 */
  errorCode: string;
  /** 毫秒时间戳；非法 → 用调用方给定的 `now`。 */
  timestamp: number;
}

/**
 * 单行诊断：`版本 1.0.0 · 设备 device-2 · 错误码 E_GIT_TIMEOUT · 2026-11-18 20:41:05`
 *
 * 四段**永远都在**：缺字段用兜底词（`未取到版本` / `未登记` / `无`），时间非法时回落
 * `now`（调用方给）或当前时间；绝不省略段、绝不产出 `undefined`。
 */
export function formatDiagnostics(input: DiagnosticsInput, now?: number): string {
  const source: DiagnosticsInput | null = input === undefined || input === null ? null : input;
  const version: string = normalizeText(source === null ? '' : source.version);
  const deviceId: string = normalizeText(source === null ? '' : source.deviceId);
  const errorCode: string = normalizeText(source === null ? '' : source.errorCode);
  const timestamp: number = resolveTimestamp(source === null ? 0 : source.timestamp, now);
  const parts: string[] = [
    `版本 ${version.length > 0 ? version : FALLBACK_VERSION}`,
    `设备 ${deviceId.length > 0 ? deviceId : FALLBACK_DEVICE}`,
    `错误码 ${errorCode.length > 0 ? errorCode : FALLBACK_CODE}`,
    formatTimestamp(timestamp)
  ];
  return parts.join(SEGMENT_SEPARATOR);
}

/**
 * 失败三段式：`<what>失败：<why>。下一步：<next>`。
 *
 * - 缺项不编造：`why` 空 → `原因未知`，`next` 空 → `重试，或到设置页检查配置`，
 *   `what` 空 → `操作`（因此永远返回完整的四要素句子）；
 * - **幂等**：入参本身已是一句失败描述（含 `失败：`）时原样归一返回，
 *   所以 `describeFailure(describeFailure(...), '', '') === describeFailure(...)`；
 * - `what` 结尾的标点与「失败」后缀会被剥掉再拼，不会出现「同步失败失败：…」。
 */
export function describeFailure(what: string, why: string, next: string): string {
  const normalizedWhat: string = normalizeText(what);
  if (normalizedWhat.indexOf(FAILURE_MARK) >= 0) {
    return normalizedWhat;
  }
  const head: string = stripFailureSuffix(normalizedWhat);
  const whyText: string = normalizeText(why);
  const nextText: string = normalizeText(next);
  const whyBody: string = withPeriod(whyText.length > 0 ? whyText : FALLBACK_WHY);
  const nextBody: string = stripNextMark(nextText.length > 0 ? nextText : FALLBACK_NEXT);
  return `${head}${FAILURE_MARK}${whyBody}${NEXT_MARK}${nextBody}`;
}

/** 标题是否「像一个空态」（含「暂无 / 没有 / 空」任一识别词）。 */
function looksLikeEmptyState(title: string): boolean {
  for (const marker of EMPTY_MARKERS) {
    if (title.indexOf(marker) >= 0) {
      return true;
    }
  }
  return false;
}

/**
 * 空态 detail 的已知占位符（**只做 exact match，不做子串匹配**）：这些都不是事实句。
 *
 * `emptyText('')` 是应用自己的兜底标题（「暂无内容」），必须一并拒绝；
 * 「没有」这类识别词只用于标题，不在这里做子串扫描——事实句里完全可以出现「没有」。
 * 词法检查**按设计如此**：只能挡住空白和名单里的占位，判断不了一句话是不是真的。
 */
const PLACEHOLDER_DETAILS: readonly string[] = Object.freeze([
  emptyText(''),
  '暂无数据',
  '暂无内容',
  '-',
  '—',
  '…',
  '...',
  '暂无',
  '无',
  '空'
]);

/**
 * 空态有出路：真按钮，或没有可点的东西时给一句事实：返回问题说明（**空串 = 合规**）。
 *
 * - `showAction !== false`（默认）：标题像空态且 `actionLabel` 为空时返回问题——既能抓住
 *   「暂无日程」这种死界面，也不会把「还没有云端会话」（含「没有」）漏掉；空按钮文案永远有
 *   `EmptyState` 的「刷新」兜底，不会被当作「不要按钮」。
 * - `showAction === false`：必须给出非空且不在 `PLACEHOLDER_DETAILS` 里的 `detail` 才合规；
 *   此时没有任何可点的东西，出路只能靠那句事实。
 *   **这里是词法检查（按设计如此）**：能拒绝空白和已知占位符（`emptyText('')` 等逐字比对），
 *   但不能判断一句话是不是真的；占位符按 exact match 比对，绝不做子串扫描。
 * 标题不像空态时不属于本函数的判定范围（返回空串）。
 */
export function emptyStateIssue(title: string, actionLabel: string, showAction: boolean = true, detail: string = ''): string {
  const name: string = normalizeText(title);
  if (!looksLikeEmptyState(name)) {
    return '';
  }
  if (showAction === false) {
    const fact: string = normalizeText(detail);
    if (fact.length === 0) {
      return `空态没有可点的东西时必须给一句事实：标题「${name}」缺少事实说明（detail 为空）`;
    }
    if (PLACEHOLDER_DETAILS.indexOf(fact) >= 0) {
      return `空态没有可点的东西时必须给一句事实：标题「${name}」的 detail 是占位符「${fact}」，不是事实句`;
    }
    return '';
  }
  const action: string = normalizeText(actionLabel);
  if (action.length > 0) {
    return '';
  }
  return `空态有出路：真按钮，或没有可点的东西时给一句事实；标题「${name}」缺少下一步动作（actionLabel 为空）`;
}
