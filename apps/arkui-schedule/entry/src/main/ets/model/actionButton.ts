/**
 * 统一按钮的状态模型（**零 SDK import**，可被 `tools/tsconfig.json` 编译成 JS 由 Node 单测直接跑）。
 *
 * 契约来源：`docs/STATE-UI.md` §3。解决的是「按钮禁用后没有任何反馈」：
 * ArkUI 的禁用修饰符（enabled 链式属性）会把 `onClick` 一起吞掉，用户点不动却不知道为什么。
 * 所以 `ActionButton` **永远可点**，点击时先问这里「到底能不能执行」，不能执行就 toast 原因。
 *
 * 三个状态（互斥，`busy` 优先）：
 * | 入参 | tappable | busy | opacity | 说明 |
 * |---|---|---|---|---|
 * | `enabled=true, busy=false` | true | false | 1.0 | 正常可点 |
 * | `busy=true`（无论 enabled） | false | true | 0.5 | 处理中，忽略重复点击 |
 * | `enabled=false, busy=false` | false | false | 0.4 | 不可用，点了给原因 |
 *
 * 硬约束：`tappable=false` 时 `blockedReason` **永远非空**（`enabled=false` 且没给原因 →
 * 兜底 `当前不可用，请稍后再试`），「点了没反应」这种静默失败在本批之后不允许出现。
 */

/** 按钮视觉档位：主操作 / 次操作 / 文字链 / 危险操作。 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** 按钮的解析结果（组件只读它决定标签、颜色、透明度与点击行为）。 */
export interface ButtonState {
  /** 视觉与命中：true = 可点且真的会执行动作。 */
  tappable: boolean;
  /** 是否忙碌（标签切成「处理中…」并禁止重复触发）。 */
  busy: boolean;
  /** 不可用原因（`tappable=false` 时永远非空；这是「点了给原因」的文案来源）。 */
  blockedReason: string;
  /** 透明度：可点 1 / 忙 0.5 / 不可用 0.4（视觉必须明显不同）。 */
  opacity: number;
}

/** 可点时的透明度。 */
const OPACITY_NORMAL: number = 1;

/** 忙碌时的透明度（半透明，但仍能被看到）。 */
const OPACITY_BUSY: number = 0.5;

/** 不可用时的透明度（比忙碌更淡，扫读时一眼能分开）。 */
const OPACITY_BLOCKED: number = 0.4;

/** 忙碌时点击该 toast 什么（有事中提示，不重复弹）。 */
const REASON_BUSY: string = '处理中，请稍候';

/** `enabled=false` 且没给原因时的兜底原因（绝不静默）。 */
const REASON_FALLBACK: string = '当前不可用，请稍后再试';

/** 归一化原因：非字符串 → 空串；折叠空白、去首尾。 */
function normalizeReason(raw: string): string {
  const text: string = typeof raw === 'string' ? raw : '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 把「可用性 / 忙碌 / 禁用原因」解析成按钮的最终状态。
 *
 * `busy` 优先于 `enabled`：正在跑的动作不允许被第二个点击打断（也不该显示成「不可用」）。
 */
export function resolveButton(enabled: boolean, busy: boolean, disabledReason: string): ButtonState {
  const isBusy: boolean = busy === true;
  const isEnabled: boolean = enabled === true;
  if (isBusy) {
    return { tappable: false, busy: true, blockedReason: REASON_BUSY, opacity: OPACITY_BUSY };
  }
  if (!isEnabled) {
    const reason: string = normalizeReason(disabledReason);
    return {
      tappable: false,
      busy: false,
      blockedReason: reason.length > 0 ? reason : REASON_FALLBACK,
      opacity: OPACITY_BLOCKED
    };
  }
  return { tappable: true, busy: false, blockedReason: '', opacity: OPACITY_NORMAL };
}

/**
 * 用户点到不可用按钮时该 toast 什么；**可点 / 忙碌时返回空串**。
 *
 * 忙碌时为空串是刻意的：忙碌已经有「处理中…」的视觉与状态，再弹一次 toast 是噪音
 * （`ActionButton` 收到空串就不弹）。
 */
export function blockedTapText(state: ButtonState): string {
  if (state === undefined || state === null) {
    return REASON_FALLBACK;
  }
  if (state.tappable === true || state.busy === true) {
    return '';
  }
  const reason: string = normalizeReason(state.blockedReason);
  return reason.length > 0 ? reason : REASON_FALLBACK;
}
