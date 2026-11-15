/**
 * 笔刷参数（纯逻辑：不 import 任何 SDK，也不 import `strokeHistory`，避免循环依赖）。
 *
 * 需求：仿 Pen Kit 的「手写常用笔刷」体验 —— 钢笔 / 圆珠笔 / 铅笔 / 马克笔 / 荧光笔，
 * 每种笔刷有自己的不透明度、粗细倍数、抖动（铅笔）与速度调制（钢笔）。
 *
 * 本模块只产出**绘制参数**（`rgba(...)` + `lineWidth` + `jitter` + `composite`），
 * 真正的 canvas 调用由 UI 完成；这样笔刷行为可以在 Node 下逐项断言。
 *
 * TODO（本轮不做，「一笔成形」需要识别器/拟合，时间不够）：
 * - 自由曲线 → 直线/圆/矩形/箭头的一次性拟合与吸附；
 * - 压感（Pen Kit 的 pressure）与倾斜角。
 */
/** 5 种笔刷。 */
export type BrushKind = 'pen' | 'ballpoint' | 'pencil' | 'marker' | 'highlighter';

/** 笔刷的静态参数。 */
export interface BrushSpec {
  kind: BrushKind;
  /** 工具条显示名：钢笔/圆珠笔/铅笔/马克笔/荧光笔。 */
  label: string;
  /** 颜色不透明度（1 = 实心）。 */
  alpha: number;
  /** 相对当前粗细档的倍数。 */
  widthScale: number;
  /** 抖动幅度（vp，铅笔用；其他 0）。 */
  jitter: number;
  /** 是否按移动速度调制宽度（钢笔 true）。 */
  speedSensitive: boolean;
  /** 最慢时的宽度系数（`speedSensitive=false` 时为 1）。 */
  maxSpeedScale: number;
  /** 最快时的宽度系数（`speedSensitive=false` 时为 1）。 */
  minSpeedScale: number;
}

/** 顺序固定：pen, ballpoint, pencil, marker, highlighter。 */
export const BRUSHES: BrushSpec[] = [
  {
    kind: 'pen',
    label: '钢笔',
    alpha: 1,
    widthScale: 1,
    jitter: 0,
    speedSensitive: true,
    maxSpeedScale: 1.35,
    minSpeedScale: 0.55
  },
  {
    kind: 'ballpoint',
    label: '圆珠笔',
    alpha: 1,
    widthScale: 1,
    jitter: 0,
    speedSensitive: false,
    maxSpeedScale: 1,
    minSpeedScale: 1
  },
  {
    kind: 'pencil',
    label: '铅笔',
    alpha: 0.7,
    widthScale: 1,
    jitter: 0.3,
    speedSensitive: false,
    maxSpeedScale: 1,
    minSpeedScale: 1
  },
  {
    kind: 'marker',
    label: '马克笔',
    alpha: 0.45,
    widthScale: 1.8,
    jitter: 0,
    speedSensitive: false,
    maxSpeedScale: 1,
    minSpeedScale: 1
  },
  {
    kind: 'highlighter',
    label: '荧光笔',
    alpha: 0.35,
    widthScale: 3,
    jitter: 0,
    speedSensitive: false,
    maxSpeedScale: 1,
    minSpeedScale: 1
  }
];

/** 默认笔刷（钢笔）。 */
export const DEFAULT_BRUSH: BrushKind = 'pen';

/** 荧光笔固定用荧光黄（忽略用户选的颜色，和真实的荧光笔一样）。 */
const HIGHLIGHTER_RGBA: string = 'rgba(255,235,59,0.35)';

/** 单笔描边参数（UI 直接照它设置 ctx）。 */
export interface BrushPaint {
  /** `rgba(...)`。 */
  strokeStyle: string;
  /** vp，已乘 `widthScale`，最小 0.5。 */
  lineWidth: number;
  /** vp（铅笔抖动）。 */
  jitter: number;
  composite: 'source-over' | 'destination-out';
}

/** `#RRGGBB`（允许省略 `#`）。 */
const HEX_COLOR_RE: RegExp = /^#?([0-9a-fA-F]{6})$/;

/** alpha 夹到 0..1（NaN/Infinity 按 0），保留 3 位小数避免浮点噪声进 `rgba()` 文案。 */
function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) {
    return 0;
  }
  if (alpha < 0) {
    return 0;
  }
  if (alpha > 1) {
    return 1;
  }
  return Math.round(alpha * 1000) / 1000;
}

/** 线宽：非有限/非正按 0，之后保证最小 0.5，并保留 3 位小数（5×1.8 要正好是 9）。 */
function roundWidth(width: number): number {
  const value: number = Number.isFinite(width) && width > 0 ? width : 0;
  const rounded: number = Math.round(value * 1000) / 1000;
  return rounded < 0.5 ? 0.5 : rounded;
}

/** 复制一份笔刷参数（外部改返回值不会污染 `BRUSHES` 表）。 */
function copySpec(spec: BrushSpec): BrushSpec {
  return {
    kind: spec.kind,
    label: spec.label,
    alpha: spec.alpha,
    widthScale: spec.widthScale,
    jitter: spec.jitter,
    speedSensitive: spec.speedSensitive,
    maxSpeedScale: spec.maxSpeedScale,
    minSpeedScale: spec.minSpeedScale
  };
}

/** 取笔刷参数；未知/非法 kind → 返回默认笔刷（不抛异常，返回的是副本）。 */
export function brushSpec(kind: BrushKind): BrushSpec {
  for (let index = 0; index < BRUSHES.length; index++) {
    if (BRUSHES[index].kind === kind) {
      return copySpec(BRUSHES[index]);
    }
  }
  return copySpec(BRUSHES[0]);
}

/** `'#RRGGBB'` + alpha(0..1) → `'rgba(r,g,b,a)'`；非法 hex 回退 `rgba(0,0,0,alpha)`，alpha 夹到 0..1。 */
export function rgbaFromHex(hex: string, alpha: number): string {
  const opacity: number = clampAlpha(alpha);
  const text: string = typeof hex === 'string' ? hex.trim() : '';
  const matched: RegExpExecArray | null = HEX_COLOR_RE.exec(text);
  if (matched === null) {
    return `rgba(0,0,0,${opacity})`;
  }
  const value: number = parseInt(matched[1], 16);
  const red: number = (value >> 16) & 0xff;
  const green: number = (value >> 8) & 0xff;
  const blue: number = value & 0xff;
  return `rgba(${red},${green},${blue},${opacity})`;
}

/**
 * 单笔描边参数：
 * - 荧光笔固定荧光黄（`rgba(255,235,59,0.35)`），颜色参数被忽略；
 * - `erase=true` → `destination-out`、alpha 1、`lineWidth = baseWidth × 4`（橡皮比任何笔都粗）；
 * - 其他笔刷 → 颜色 + 自身 alpha，`lineWidth = baseWidth × widthScale`，最小 0.5。
 */
export function paintFor(kind: BrushKind, color: string, baseWidth: number, erase?: boolean): BrushPaint {
  const spec: BrushSpec = brushSpec(kind);
  if (erase === true) {
    return {
      strokeStyle: rgbaFromHex(color, 1),
      lineWidth: roundWidth(baseWidth * 4),
      jitter: 0,
      composite: 'destination-out'
    };
  }
  if (spec.kind === 'highlighter') {
    return {
      strokeStyle: HIGHLIGHTER_RGBA,
      lineWidth: roundWidth(baseWidth * spec.widthScale),
      jitter: spec.jitter,
      composite: 'source-over'
    };
  }
  return {
    strokeStyle: rgbaFromHex(color, spec.alpha),
    lineWidth: roundWidth(baseWidth * spec.widthScale),
    jitter: spec.jitter,
    composite: 'source-over'
  };
}

/**
 * 压感量程上限：`TouchObject.pressure` 的取值区间是 `[0, 65535)`（API 15+）。
 * 手写笔在部分机型/笔尖悬停时可能报 0，因此 UI 侧把 `0` 当作「无压感信息」处理（见页面注释）。
 */
export const PRESSURE_MAX: number = 65535;

/** 压感为 0 时的线宽系数下限（再细就看不清了）。 */
export const PRESSURE_MIN_SCALE: number = 0.35;

/** 压感线宽上限倍数：超过基础线宽 1.6 倍会糊成一团，一律夹住。 */
export const PRESSURE_MAX_WIDTH_SCALE: number = 1.6;

/**
 * 压感 → 线宽系数：`0.35 + 0.65 × pressure/65535`，取值范围 `[0.35, 1]`。
 *
 * - `pressure <= 0` → `0.35`；`pressure >= 65535` → `1`（再大也按满压算）；
 * - 非有限数（NaN / ±Infinity）→ `1`（没有压感信息时**不缩放**，避免笔画莫名变细）；
 * - 结果保留 3 位小数，避免浮点噪声进入 `lineWidth`。
 */
export function pressureWidthScale(pressure: number): number {
  if (!Number.isFinite(pressure)) {
    return 1;
  }
  if (pressure <= 0) {
    return PRESSURE_MIN_SCALE;
  }
  if (pressure >= PRESSURE_MAX) {
    return 1;
  }
  const ratio: number = pressure / PRESSURE_MAX;
  const scale: number = PRESSURE_MIN_SCALE + (1 - PRESSURE_MIN_SCALE) * ratio;
  return Math.round(scale * 1000) / 1000;
}

/**
 * 压感 → **最终线宽**（vp）：`baseWidth × pressureWidthScale(pressure)`，再夹进
 * `[0.5, baseWidth × 1.6]`（基础线宽非正时退化为 0.5，与 `paintFor` 的最小值一致）。
 *
 * UI 上压力只用来「同一笔内变粗细」，因此这里不改变笔刷自身的 `widthScale` 语义。
 */
export function pressureWidth(baseWidth: number, pressure: number): number {
  const base: number = Number.isFinite(baseWidth) && baseWidth > 0 ? baseWidth : 0;
  if (base <= 0) {
    return 0.5;
  }
  const scaled: number = base * pressureWidthScale(pressure);
  const max: number = base * PRESSURE_MAX_WIDTH_SCALE;
  const clamped: number = scaled > max ? max : scaled;
  return roundWidth(clamped);
}

/** 某笔刷的速度调制区间（`maxScale` = 最慢时系数，`minScale` = 最快时系数）。 */
export interface SpeedRange {
  kind: BrushKind;
  maxScale: number;
  minScale: number;
}

/**
 * 除钢笔之外**额外**吃「快细慢粗」的笔刷及其保守区间。
 *
 * 为什么不直接改 `BRUSHES` 里的 `speedSensitive`：那张表是 `brush.test.mjs` 逐项锁定的契约
 * （圆珠笔/铅笔的 `speedSensitive=false`、区间 1/1），改它会破坏既有断言与其他调用方；
 * 因此这里以**追加**的方式提供 `speedWidthScaleFor`，页面改用它即可，`speedWidthScale` 语义不变。
 */
export const EXTRA_SPEED_RANGES: SpeedRange[] = [
  { kind: 'ballpoint', maxScale: 1.2, minScale: 0.75 },
  { kind: 'pencil', maxScale: 1.15, minScale: 0.8 }
];

/** 该笔刷是否参与速度调制（钢笔 + `EXTRA_SPEED_RANGES` 里的笔刷）。 */
export function usesSpeedWidth(kind: BrushKind): boolean {
  const spec: BrushSpec = brushSpec(kind);
  if (spec.speedSensitive) {
    return true;
  }
  for (let index = 0; index < EXTRA_SPEED_RANGES.length; index++) {
    if (EXTRA_SPEED_RANGES[index].kind === spec.kind) {
      return true;
    }
  }
  return false;
}

/**
 * 速度调制（**页面用这个**）：钢笔走原 `speedWidthScale`，圆珠笔/铅笔走 `EXTRA_SPEED_RANGES`
 * 的保守区间，其余笔刷（马克笔/荧光笔）恒为 1。
 *
 * `speed` 语义与 `speedWidthScale` 一致：vp/ms，`<= 0` 或 NaN 取最粗，`>= 2` 取最细，中间线性插值。
 */
export function speedWidthScaleFor(kind: BrushKind, speed: number): number {
  const spec: BrushSpec = brushSpec(kind);
  if (spec.speedSensitive) {
    // 钢笔：沿用原区间，不复制逻辑
    return speedWidthScale(spec.kind, speed);
  }
  let range: SpeedRange | null = null;
  for (let index = 0; index < EXTRA_SPEED_RANGES.length; index++) {
    if (EXTRA_SPEED_RANGES[index].kind === spec.kind) {
      range = EXTRA_SPEED_RANGES[index];
      break;
    }
  }
  if (range === null) {
    return 1;
  }
  if (Number.isNaN(speed) || speed <= 0) {
    return range.maxScale;
  }
  if (speed >= 2) {
    // +Infinity 也落这里：越快越细（与 speedWidthScale 一致）
    return range.minScale;
  }
  const ratio: number = speed / 2;
  const scale: number = range.maxScale + (range.minScale - range.maxScale) * ratio;
  return Math.round(scale * 1000) / 1000;
}

/**
 * 钢笔速度调制：`speed`（vp/ms）越大越细。
 * 返回 `[minSpeedScale, maxSpeedScale]` 区间内的系数：
 * `speed <= 0`（含 NaN/负数）→ `maxSpeedScale`；`speed >= 2` → `minSpeedScale`；中间线性插值。
 * 非 `speedSensitive` 的笔刷恒返回 1。
 */
export function speedWidthScale(kind: BrushKind, speed: number): number {
  const spec: BrushSpec = brushSpec(kind);
  if (!spec.speedSensitive) {
    return 1;
  }
  if (Number.isNaN(speed)) {
    return spec.maxSpeedScale;
  }
  if (speed <= 0) {
    return spec.maxSpeedScale;
  }
  if (speed >= 2) {
    // +Infinity 也落这里：越快越细
    return spec.minSpeedScale;
  }
  const ratio: number = speed / 2;
  const scale: number = spec.maxSpeedScale + (spec.minSpeedScale - spec.maxSpeedScale) * ratio;
  return Math.round(scale * 1000) / 1000;
}

/**
 * 铅笔抖动用：给定点与幅度返回**偏移后的新点**（不修改入参）。
 * `amount <= 0` / 非有限 → 原样返回（新对象）；偏移半径 `sqrt(rng()) × amount`，因此距离恒 ≤ amount。
 * `rng` 可注入（默认 `Math.random`），测试传固定序列即可复现。
 */
export function jitterPoint(
  point: { x: number; y: number },
  amount: number,
  rng?: () => number
): { x: number; y: number } {
  const x: number = point === null || point === undefined ? 0 : point.x;
  const y: number = point === null || point === undefined ? 0 : point.y;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { x: x, y: y };
  }
  const random: () => number = typeof rng === 'function' ? rng : Math.random;
  const angle: number = normalizeRandom(random()) * Math.PI * 2;
  const radiusFactor: number = Math.sqrt(normalizeRandom(random()));
  const radius: number = radiusFactor * amount;
  return { x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius };
}

/** `rng` 返回值归一化到 0..1（注入的序列可能越界或非有限）。 */
function normalizeRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
