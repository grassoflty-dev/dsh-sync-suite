/**
 * 文案规范（纯逻辑，**零 SDK import**，可被 `tools/tsconfig.json` 编译成 JS 由 Node 单测直接验证）。
 *
 * 规范来源：`model/syncError.ts` 的「原因 + 下一步」写法——每条给人看的错误都必须回答两件事：
 * 1. **发生了什么**（原因，不带裸错误码）；
 * 2. **现在该做什么**（下一步，可执行的动作）。
 *
 * 统一格式：`原因。下一步：Y`（`issueText()`）。用户界面上的三态（loading / empty / error）
 * 分别由 `loadingText()` / `emptyText()` / `errorText()` 产出，`components/StateView.ets` 负责渲染。
 *
 * 硬约束（有单测 `tools/test/copy.test.mjs`）：
 * - **幂等**：`f(f(x)) === f(x)`（`stripErrorCode` / `issueText` / `errorText` / `emptyText` /
 *   `loadingText` / `retryText` 都成立）——页面重复套一层包装不会出现「正在加载正在加载…」；
 * - **容错**：空串 / `undefined` / `null` / `NaN` 不抛异常，且**绝不产出「undefined」字样**；
 *   调用方传进来的是运行时的脏数据，文案层是最后一道防线；
 * - **不重复标点**：原因已以「。」「！」「？」「…」等结尾时不再补句号；
 * - **只去前缀错误码**：`E_GIT: xxx` / `HTTP 500: xxx` 这类**行首**码被剥掉，正文里的错误码保留
 *   （正文里的码通常是用户要反馈给开发者的原始信息，不能吞）。
 *
 * toast 时长：普通提示 3 秒、错误提示 5 秒（错误更长，用户要读完）。页面里不要再写字面量
 * `duration: 4000`，统一走 `toastMsFor(isError)`。
 */

/** 普通提示的 toast 时长（毫秒）：3 秒。 */
export const TOAST_MS: number = 3000;

/** 错误提示的 toast 时长（毫秒）：5 秒（比普通提示多 2 秒，够读完原因 + 下一步）。 */
export const TOAST_ERROR_MS: number = 5000;

/** 「暂无」前缀（`emptyText` 用它做幂等归一）。 */
const EMPTY_PREFIX: string = '暂无';

/** 「正在加载」前缀（`loadingText` 幂等归一）。 */
const LOADING_PREFIX: string = '正在加载';

/** 省略号：加载文案统一以它结尾（中英文两种都认，便于归一）。 */
const ELLIPSIS: string = '…';

/** 「重试」前缀（`retryText` 幂等归一）。 */
const RETRY_PREFIX: string = '重试';

/** 「下一步：」分隔符（`issueText` 的唯一格式）。 */
const NEXT_STEP_MARK: string = '下一步：';

/** 句末标点：命中则不再补句号（含中英文与省略号）。 */
const TERMINAL_PUNCTUATION: RegExp = /[。！？；…!?;]$/;

/** 空原因时的兜底原因（比「未知错误」更像人话，且不含裸错误码）。 */
const FALLBACK_REASON: string = '操作失败';

/** `errorText()` 的默认下一步：先重试，仍失败则去设置页查配置（与 `syncError` 的分级建议一致）。 */
const DEFAULT_ERROR_STEP: string = '重试，或到设置页检查配置';

/** 行首错误码：`E_GIT:` / `HTTP 500:`（只认行首 + 冒号结尾，正文里的码不动）。 */
const CODE_PREFIX: RegExp = /^\s*(?:E_[A-Z0-9_]+|[Hh][Tt][Tt][Pp]\s*\d{3})\s*[:：]\s*/;

/** `stripErrorCode` 的最大剥离层数（防止畸形输入死循环；正常最多 2–3 层）。 */
const MAX_CODE_PREFIXES: number = 8;

/** 归一化文本：非字符串 → 空串；折叠连续空白；去首尾空白。 */
function normalizeText(raw: string): string {
  const text: string = typeof raw === 'string' ? raw : '';
  return text.replace(/\s+/g, ' ').trim();
}

/** 去掉结尾的省略号（`正在加载日程……` → `正在加载日程`），用于幂等归一。 */
function trimEllipsis(raw: string): string {
  let text: string = raw;
  while (text.length > 0) {
    if (text.endsWith(ELLIPSIS)) {
      text = text.slice(0, text.length - ELLIPSIS.length).trim();
      continue;
    }
    if (text.endsWith('...')) {
      text = text.slice(0, text.length - 3).trim();
      continue;
    }
    break;
  }
  return text;
}

/** 补句末标点：空串保持空串，已带句末标点则原样返回。 */
function withPeriod(raw: string): string {
  if (raw.length === 0) {
    return '';
  }
  return TERMINAL_PUNCTUATION.test(raw) ? raw : `${raw}。`;
}

/** 当前 toast 应该停留多久：错误 5 秒，普通 3 秒。 */
export function toastMsFor(isError: boolean): number {
  return isError === true ? TOAST_ERROR_MS : TOAST_MS;
}

/**
 * 剥掉**行首**的裸错误码前缀：`E_GIT: 推送被拒绝` → `推送被拒绝`、`HTTP 500: 服务异常` → `服务异常`。
 *
 * - 只认 `E_XXX:` 与 `HTTP <三位数>:`（中英文冒号都算），且必须紧贴行首；
 * - 多层前缀（`E_GIT: E_AUTH: xxx`）一次剥完，因此**幂等**：`f(f(x)) === f(x)`；
 * - 正文里的错误码（`推送失败（E_GIT）`）不动——那是要反馈给开发者的原始信息。
 */
export function stripErrorCode(text: string): string {
  let out: string = normalizeText(text);
  for (let round = 0; round < MAX_CODE_PREFIXES; round++) {
    const matched: RegExpExecArray | null = CODE_PREFIX.exec(out);
    if (matched === null) {
      break;
    }
    out = out.slice(matched[0].length).trim();
  }
  return out;
}

/**
 * 统一「原因 + 下一步」：`原因。下一步：Y`。
 *
 * - 原因已以句末标点结尾时不重复补「。」；
 * - `step` 为空 → 只返回原因（补上句号）；
 * - `reason` 为空 → 只返回 `下一步：Y`（不编造原因）；
 * - 两者都空 → 空串（调用方据此隐藏该行，而不是显示一句废话）；
 * - 原因里已经包含同一个「下一步」时原样返回 → **幂等**。
 */
export function issueText(reason: string, next: string): string {
  const why: string = normalizeText(reason);
  const step: string = normalizeText(next);
  if (step.length === 0) {
    return withPeriod(why);
  }
  if (why.length === 0) {
    return `${NEXT_STEP_MARK}${step}`;
  }
  if (why.indexOf(`${NEXT_STEP_MARK}${step}`) >= 0) {
    // 已经带同一个「下一步」→ 原样返回（补句号会破坏幂等：f(f(x)) 会多一个「。」）
    return why;
  }
  return `${withPeriod(why)}${NEXT_STEP_MARK}${step}`;
}

/**
 * 错误文案：剥错误码 + 补默认下一步（「重试，或到设置页检查配置」）。
 *
 * 例：`errorText('E_GIT: 推送被拒绝')` → `推送被拒绝。下一步：重试，或到设置页检查配置`
 * 空原因 → `操作失败。下一步：…`（绝不出现「undefined」）。
 */
export function errorText(reason: string): string {
  const why: string = stripErrorCode(reason);
  return issueText(why.length > 0 ? why : FALLBACK_REASON, DEFAULT_ERROR_STEP);
}

/**
 * 空态标题：`暂无<subject>`；给了 `hint` 时拼成一句说明。
 *
 * 例：`emptyText('日程')` → `暂无日程`
 *     `emptyText('日程', '点右上角「新建」记录一条')` → `暂无日程。点右上角「新建」记录一条`
 * subject 缺省 → `暂无内容`；hint 已包含在标题里时不重复拼（幂等）。
 */
export function emptyText(subject: string, hint?: string): string {
  let name: string = normalizeText(subject);
  while (name.indexOf(EMPTY_PREFIX) === 0) {
    name = name.slice(EMPTY_PREFIX.length).trim();
  }
  const base: string = name.length > 0 ? `${EMPTY_PREFIX}${name}` : `${EMPTY_PREFIX}内容`;
  const extra: string = typeof hint === 'string' ? normalizeText(hint) : '';
  if (extra.length === 0 || base.indexOf(extra) >= 0) {
    return base;
  }
  return `${base}。${extra}`;
}

/**
 * 加载文案：`正在加载<what>…`。
 *
 * 例：`loadingText('日程')` → `正在加载日程…`；`loadingText('')` → `正在加载…`
 * 已是加载文案时原样返回（幂等，不会出现「正在加载正在加载日程……」）。
 */
export function loadingText(what: string): string {
  let name: string = trimEllipsis(normalizeText(what));
  while (name.indexOf(LOADING_PREFIX) === 0) {
    name = trimEllipsis(name.slice(LOADING_PREFIX.length).trim());
  }
  if (name.length === 0) {
    return `${LOADING_PREFIX}${ELLIPSIS}`;
  }
  return `${LOADING_PREFIX}${name}${ELLIPSIS}`;
}

/**
 * 重试按钮文案：默认就是「重试」；给了 `what` 则变成「重试<what>」。
 *
 * 例：`retryText('')` → `重试`、`retryText('加载')` → `重试加载`
 * 已以「重试」开头时原样返回（幂等）。
 */
export function retryText(what: string): string {
  const name: string = normalizeText(what);
  if (name.length === 0) {
    return RETRY_PREFIX;
  }
  if (name.indexOf(RETRY_PREFIX) === 0) {
    return name;
  }
  return `${RETRY_PREFIX}${name}`;
}

/**
 * 计数文案：`共 <n> <unit>`。
 *
 * 例：`countText(5, '条')` → `共 5 条`、`countText(0, '条')` → `共 0 条`
 * `unit` 为空 → `共 5`；`n` 非法（NaN / Infinity / undefined / 负数）→ 按 0 处理。
 */
export function countText(n: number, unit: string): string {
  let value: number = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0;
  if (value < 0) {
    value = 0;
  }
  const name: string = normalizeText(unit);
  return name.length > 0 ? `共 ${value} ${name}` : `共 ${value}`;
}
