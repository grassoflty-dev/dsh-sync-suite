/**
 * 主题模型（深色模式三态 + 大字号适配）—— **纯逻辑，零 SDK import**。
 *
 * 为什么单独一个文件：深色模式与字号的**判定规则**必须能被 Node 单测直接验证
 * （`tools/test/theme.test.mjs` 编译 `tools/tsconfig.json` 后 import 本文件），
 * 因此这里只有常量与纯函数，不 import `@kit.*`、不调 `$r()`、不碰 ArkUI 类型。
 *
 * 三层职责（别混）：
 * 1. **值**住在资源里：`resources/base/element/color.json`（浅色）与
 *    `resources/dark/element/color.json`（深色）是色值唯一来源，两份**键集必须完全一致**
 *    （缺一个，深色下就会回落成浅色值/编译期报错）；
 * 2. **名**集中在这里：`COLOR_TOKENS` 把「语义名 → 资源名」钉死，页面不写字符串字面量
 *    （`colorToken('canvas')` → `'app.color.canvas'`），未知名 fail-safe 回落 canvas；
 * 3. **规则**也在这里：`normalizeThemeMode` / `resolveTheme` / `clampFontScale` /
 *    `scaledFontSize` / `assertNoOverflow` 都是纯函数，页面与测试共用同一套判定。
 *
 * 三态语义（`ThemeMode`）：
 * - `system`：跟随系统（`ColorMode.COLOR_MODE_NOT_SET`，系统切换深色时 App 立刻跟随）；
 * - `light` / `dark`：强制浅色 / 深色（`COLOR_MODE_LIGHT` / `COLOR_MODE_DARK`）。
 * 持久化只有一个键 `themeMode`（`services/settingsStore.ets` 的 `KEY_THEME_MODE`），
 * 旧数据没有该键 → `normalizeThemeMode('')` → `system`，与升级前「跟随系统」行为一致。
 *
 * 大字号：**fp 本身已经跟随系统字体缩放**，这里只做「我们自己的上下限夹取」，
 * 防止用户在系统里拉到 2× 以上把工具栏/表格挤爆（夹到 `[1.0, 1.6]`）。
 */

/** 主题三态（唯一合法值域）。 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 三态的展示顺序（设置页分组顺序 = 这个数组，页面不另写字面量数组）。 */
export const THEME_MODE_ORDER: ThemeMode[] = ['system', 'light', 'dark'];

/** 设置页每态的短标签（与 `THEME_MODE_ORDER` 一一对应）。 */
export const THEME_MODE_LABELS: string[] = ['跟随系统', '浅色', '深色'];

/** 设置页每态的一行说明（用户看得懂的白话，不出现 ColorMode 之类内部术语）。 */
export const THEME_MODE_HINTS: string[] = [
  '系统切深色时本应用一起变',
  '始终用浅色界面',
  '始终用深色界面'
];

/** 持久化键名（`settingsStore` 里同名常量，测试会跨文件比对，别只改一处）。 */
export const THEME_MODE_KEY: string = 'themeMode';

/**
 * 语义名 → 资源名。
 *
 * 键 = 语义名（snake_case，与 `color.json` 的 `name` 同名，便于机械核对），
 * 值 = `$r()` 要用的完整资源名。页面只允许通过 `colorToken(name)` 取，
 * 不允许在 `.ets` 里写 `'app.color.xxx'` 字符串（静态测试会扫）。
 *
 * `canvas` 与 `page_background` 是**同一档的别名**（浅色都 `#FFFFFF`、深色都 `#000000`）：
 * 新代码一律用语义更准的 `canvas`；`page_background` 保留给历史调用点，不删以免漏改。
 */
export const COLOR_TOKENS: Record<string, string> = {
  // ---- 底色（三层：画布 / 面 / 抬起的面）
  canvas: 'app.color.canvas',
  page_background: 'app.color.page_background',
  surface: 'app.color.surface',
  surface_raised: 'app.color.surface_raised',
  start_window_background: 'app.color.start_window_background',
  preview_background: 'app.color.preview_background',
  // ---- 控件填充（浅色是浅灰，深色是抬起的深灰；不要再写字面量 #F1F3F5 之类）
  control_fill: 'app.color.control_fill',
  control_fill_alt: 'app.color.control_fill_alt',
  field_fill: 'app.color.field_fill',
  // ---- 品牌与选中
  brand: 'app.color.brand',
  brand_soft: 'app.color.brand_soft',
  selection_fill: 'app.color.selection_fill',
  selection_stroke: 'app.color.selection_stroke',
  // ---- 文字
  text_primary: 'app.color.text_primary',
  text_secondary: 'app.color.text_secondary',
  text_inverse: 'app.color.text_inverse',
  // ---- 线与边框
  divider: 'app.color.divider',
  border: 'app.color.border',
  grid_line: 'app.color.grid_line',
  // ---- 语义色（错误 / 警告 / 成功）
  danger: 'app.color.danger',
  warning: 'app.color.warning',
  warning_soft: 'app.color.warning_soft',
  success: 'app.color.success',
  region_fill: 'app.color.region_fill',
  // ---- 蒙层与阴影
  scrim: 'app.color.scrim',
  shadow: 'app.color.shadow',
  // ---- 两套主题下**恒定**的纸面/二维码色（见 `DARK_FALLBACK` 与 docs/UI-DESIGN.md §8）
  qr_light: 'app.color.qr_light',
  qr_dark: 'app.color.qr_dark',
  ink_paper: 'app.color.ink_paper',
  ink_pencil: 'app.color.ink_pencil',
  ink_highlighter: 'app.color.ink_highlighter'
};

/**
 * 语义名归一：`surfaceRaised` / `surface-raised` / `SURFACE_RAISED` 都认。
 *
 * 只做「拆驼峰 + 小写 + 下划线」，不做模糊匹配（拼错就是拼错，回落 canvas 更安全）。
 */
function canonicalTokenName(raw: string): string {
  if (typeof raw !== 'string') {
    return '';
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }
  // 驼峰 / 连字符 → snake_case；多下划线压成一个
  const snake = trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
    .replace(/_{2,}/g, '_');
  return snake;
}

/**
 * 取资源名（fail-safe：未知语义名一律回落 `canvas`，绝不返回空串/undefined）。
 *
 * 回落而不是抛错，是因为颜色取不到就等于「界面没底色」，在深色下会直接黑屏一片；
 * 回落成 canvas 至少保证「看得见」。
 */
export function colorToken(name: string): string {
  const key = canonicalTokenName(name);
  const found = COLOR_TOKENS[key];
  return typeof found === 'string' ? found : COLOR_TOKENS.canvas;
}

/** 该语义名是否是已知令牌（测试用来枚举缺漏，页面一般不用）。 */
export function hasColorToken(name: string): boolean {
  const key = canonicalTokenName(name);
  return typeof COLOR_TOKENS[key] === 'string';
}

/** 全部令牌的语义名（顺序 = `COLOR_TOKENS` 声明顺序，测试用来核对 base/dark 键集）。 */
export function colorTokenNames(): string[] {
  return Object.keys(COLOR_TOKENS);
}

/**
 * 归一主题三态：大小写、空白都容忍；**未知值 → `system`**（跟随系统）。
 *
 * 旧数据（没有 themeMode 键）读成空串，也走这条路径 → `system`。
 */
export function normalizeThemeMode(raw: string): ThemeMode {
  if (typeof raw !== 'string') {
    return 'system';
  }
  const text = raw.trim().toLowerCase();
  if (text === 'light') {
    return 'light';
  }
  if (text === 'dark') {
    return 'dark';
  }
  return 'system';
}

/** 三态的中文短标签（未知值按 `system` 显示）。 */
export function themeModeLabel(mode: string): string {
  const index = THEME_MODE_ORDER.indexOf(normalizeThemeMode(mode));
  return THEME_MODE_LABELS[index];
}

/** 三态的一行说明（未知值按 `system` 显示）。 */
export function themeModeHint(mode: string): string {
  const index = THEME_MODE_ORDER.indexOf(normalizeThemeMode(mode));
  return THEME_MODE_HINTS[index];
}

/**
 * 三态 + 系统当前是否深色 → 实际生效的主题。
 *
 * `system` 时看 `systemDark`；`light`/`dark` 时**忽略**系统（强制档就是强制）。
 */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' {
  const normalized = normalizeThemeMode(mode);
  if (normalized === 'light') {
    return 'light';
  }
  if (normalized === 'dark') {
    return 'dark';
  }
  return systemDark === true ? 'dark' : 'light';
}

// ------------------------------------------------------------------ 大字号

/** 字号缩放下限（系统字体缩放小于 1 时不跟着缩，避免「越调越小」）。 */
export const FONT_SCALE_MIN: number = 1.0;

/** 字号缩放上限（系统拉到 2× 以上时按 1.6 截断，保住工具栏与表格密度）。 */
export const FONT_SCALE_MAX: number = 1.6;

/** 大字号验收档位：「×1.5 不截断」的那一档（测试与文档都用这个常量）。 */
export const FONT_SCALE_LARGE: number = 1.5;

/**
 * 夹取字号缩放：`[1.0, 1.6]`。
 *
 * 非法值（NaN / Infinity / 负数 / 非数字）一律回 1.0（= 不缩放），
 * 因为「算不出缩放」时宁可保持原字号，也不能把界面放大到看不见内容。
 */
export function clampFontScale(scale: number): number {
  if (typeof scale !== 'number' || Number.isNaN(scale)) {
    return FONT_SCALE_MIN;
  }
  if (scale <= FONT_SCALE_MIN) {
    // 含 0 / 负数 / -Infinity：系统没给有效倍率时保持原字号
    return FONT_SCALE_MIN;
  }
  if (scale >= FONT_SCALE_MAX) {
    // 含 +Infinity：按上限截断
    return FONT_SCALE_MAX;
  }
  return scale;
}

/**
 * 按缩放算字号：`baseSp × clamp(scale)`，再夹到 `[minPx, maxPx]`。
 *
 * `minPx`/`maxPx` 反了就自动交换（调用方不必保证顺序）；非法边界按「不夹那一侧」处理。
 */
export function scaledFontSize(baseSp: number, scale: number, minPx: number, maxPx: number): number {
  const base = typeof baseSp === 'number' && Number.isFinite(baseSp) && baseSp > 0 ? baseSp : 0;
  const scaled = base * clampFontScale(scale);
  const hasMin = typeof minPx === 'number' && Number.isFinite(minPx);
  const hasMax = typeof maxPx === 'number' && Number.isFinite(maxPx);
  let low = hasMin ? minPx : Number.NEGATIVE_INFINITY;
  let high = hasMax ? maxPx : Number.POSITIVE_INFINITY;
  if (low > high) {
    const swap = low;
    low = high;
    high = swap;
  }
  if (scaled < low) {
    return low;
  }
  if (scaled > high) {
    return high;
  }
  return scaled;
}

/** 行高按同一条缩放走（行高与字号必须同比例，否则大字号下会压字）。 */
export function scaledLineHeight(baseLh: number, scale: number, minPx: number, maxPx: number): number {
  return scaledFontSize(baseLh, scale, minPx, maxPx);
}

// ------------------------------------------------------------------ 对比度（纯函数，测试与文档共用）

/**
 * 相对亮度（WCAG 2.1 定义）。
 *
 * 支持 `#RGB` / `#RRGGBB` / `#AARRGGBB`（ArkUI 资源用的是 `#AARRGGBB`，透明度位**忽略**：
 * 半透明字的实际对比度取决于合成底色，静态估算只能按不透明算，这是本函数的已知边界）。
 * 非法输入 → 0（≈ 纯黑），让对比度计算退化成「最保守」的结果而不是 NaN。
 */
export function relativeLuminance(color: string): number {
  const rgb = parseHexColor(color);
  if (rgb === null) {
    return 0;
  }
  const channels: number[] = [rgb[0], rgb[1], rgb[2]].map((value: number) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : Math.pow((ratio + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** 解析 `#RGB` / `#RRGGBB` / `#AARRGGBB` → `[r, g, b]`（0–255）；非法返回 null。 */
export function parseHexColor(color: string): number[] | null {
  if (typeof color !== 'string') {
    return null;
  }
  const text = color.trim();
  if (!/^#/.test(text)) {
    return null;
  }
  const body = text.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(body)) {
    return null;
  }
  if (body.length === 3) {
    const r = parseInt(body[0] + body[0], 16);
    const g = parseInt(body[1] + body[1], 16);
    const b = parseInt(body[2] + body[2], 16);
    return [r, g, b];
  }
  if (body.length === 6) {
    return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)];
  }
  if (body.length === 8) {
    // #AARRGGBB：前两位是 alpha，丢
    return [parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16), parseInt(body.slice(6, 8), 16)];
  }
  return null;
}

/**
 * 对比度（WCAG 2.1）：`(L1 + 0.05) / (L2 + 0.05)`，L1 为较亮者。
 *
 * 返回值 ∈ [1, 21]；两色都非法时返回 1（= 完全看不出差别，最保守）。
 */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

// ------------------------------------------------------------------ 大字号布局断言（纯函数）

/** 布局里的一个项：固定宽，或「可压缩到 minWidth 的弹性项」。 */
export interface LayoutItem {
  /** 理想宽度（vp）；弹性项这是「内容想占的宽」，实际会被压到剩余宽。 */
  width: number;
  /** 是否弹性（`layoutWeight(1)` 那一类）：true 时只保证 `minWidth` 不被挤穿。 */
  flexible?: boolean;
  /** 弹性项的最小宽（vp），默认 0。 */
  minWidth?: number;
}

/** `assertNoOverflow` 的入参。 */
export interface LayoutInput {
  /** 容器可用宽（vp）。 */
  availableWidth: number;
  /** 从左到右的项（顺序即排布顺序）。 */
  items: LayoutItem[];
  /** 相邻项间距（vp），默认 0。 */
  gap?: number;
}

/** `assertNoOverflow` 的结果（`fits=false` 时 `overflowBy` 就是超出的 vp 数）。 */
export interface LayoutReport {
  /** 是否放得下（固定项 + 弹性项最小宽 + 间距 ≤ 可用宽）。 */
  fits: boolean;
  /** 实际占用宽（= 固定项 + 弹性项取到的宽 + 间距）。 */
  usedWidth: number;
  /** 超出多少 vp（0 表示没超）。 */
  overflowBy: number;
  /** 弹性项能分到的宽（负数表示已经挤穿）。 */
  flexibleWidth: number;
}

/** 浮点比较容差（vp）：0.01 级别的误差不算溢出。 */
const LAYOUT_EPSILON: number = 0.01;

/**
 * 布局是否不溢出（大字号验收的核心断言）。
 *
 * 判定口径：**固定项 + 所有弹性项的 `minWidth` + 间距 ≤ 可用宽**。
 * 弹性项的理想宽不计入，因为它可以被压（页面里对应 `layoutWeight(1)` + `maxLines` +
 * `TextOverflow.Ellipsis`）；真正会「挤出去」的只有固定项与最小宽。
 *
 * 非法值（NaN / 负数宽）按 0 处理，保证永远返回确定结果。
 */
export function assertNoOverflow(input: LayoutInput): LayoutReport {
  const available =
    typeof input.availableWidth === 'number' && Number.isFinite(input.availableWidth) && input.availableWidth > 0
      ? input.availableWidth
      : 0;
  const items: LayoutItem[] = Array.isArray(input.items) ? input.items : [];
  const gapRaw = input.gap;
  const gap = typeof gapRaw === 'number' && Number.isFinite(gapRaw) && gapRaw > 0 ? gapRaw : 0;
  let fixed = 0;
  let flexibleMin = 0;
  let flexibleCount = 0;
  for (const item of items) {
    const width =
      typeof item.width === 'number' && Number.isFinite(item.width) && item.width > 0 ? item.width : 0;
    if (item.flexible === true) {
      const min = typeof item.minWidth === 'number' && Number.isFinite(item.minWidth) && item.minWidth > 0
        ? item.minWidth
        : 0;
      flexibleMin += min;
      flexibleCount++;
    } else {
      fixed += width;
    }
  }
  const gaps = gap * Math.max(0, items.length - 1);
  const required = fixed + flexibleMin + gaps;
  const fits = required <= available + LAYOUT_EPSILON;
  const flexibleWidth = available - fixed - gaps;
  return {
    fits: fits,
    usedWidth: fits ? available : required,
    overflowBy: fits ? 0 : required - available,
    flexibleWidth: flexibleWidth
  };
}

/**
 * 更朴素的版本：给定一行文本宽度与间距，问「放不放得下」。
 *
 * 与 `assertNoOverflow` 的区别：这里**所有项都按固定宽**算（适合「不换行不省略」的
 * 工具条/表格行），任一项为负按 0 算。
 */
export function layoutFits(availableWidth: number, textWidths: number[], gaps: number[]): boolean {
  const available =
    typeof availableWidth === 'number' && Number.isFinite(availableWidth) && availableWidth > 0
      ? availableWidth
      : 0;
  const widths: number[] = Array.isArray(textWidths) ? textWidths : [];
  const gapList: number[] = Array.isArray(gaps) ? gaps : [];
  let used = 0;
  for (const width of widths) {
    used += typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 0;
  }
  for (const gap of gapList) {
    used += typeof gap === 'number' && Number.isFinite(gap) && gap > 0 ? gap : 0;
  }
  return used <= available + LAYOUT_EPSILON;
}

/**
 * 文本宽度估算：**字宽 ≈ 字号 × 0.6 × 字符数**（中文按全角 ≈ 1em 折 0.6 的经验系数）。
 *
 * 这是**估算**，不是排版引擎：真实宽度取决于字体、字重与 CJK/Latin 混排。用它做
 * 「大字号下会不会挤爆」的静态断言足够了（误差 ±15%，而 ×1.5 的增量是 50%）。
 * `scale` 走 `clampFontScale`，与真实放大倍数一致。
 */
export function estimatedTextWidth(text: string, fontSp: number, scale: number): number {
  const source = typeof text === 'string' ? text : '';
  const base = typeof fontSp === 'number' && Number.isFinite(fontSp) && fontSp > 0 ? fontSp : 0;
  return base * clampFontScale(scale) * 0.6 * source.length;
}

// ------------------------------------------------------------------ 画布绘制色（`$r()` 用不了的地方）

/**
 * Canvas `fillStyle` / `strokeStyle` 只吃 `string | number | CanvasGradient | CanvasPattern`，
 * **不接受 `Resource` 对象**，所以纸面内的绘制色只能写字面量。它们是「纸面相对色」，
 * 与主题无关——因为**纸面恒为白**（见下）。
 *
 * 为什么纸面不跟随深色（重要，别「优化」掉）：
 * 笔迹颜色是**持久化数据**（`model/strokeHistory.ts` 的 `PEN_COLORS`，#1A1A1A 等深色墨水），
 * 手写页还要 `componentSnapshot` 截图送 OCR。纸面若在深色下变黑，已有墨迹立刻不可见、
 * 截图也不再是「白纸黑字」。所以纸面恒 `#FFFFFF`（= `app.color.ink_paper`，
 * 与二维码 `app.color.qr_light` 同理），框选/网格/对象外框一律用纸面相对色。
 */
export interface CanvasPaints {
  /** 纸面（= 画布底色，恒白）。 */
  paper: string;
  /** 遮白（框内不做 OCR 时盖掉的手法，恒白、与纸面同色）。 */
  mask: string;
  /** 表格对象网格线（纸面相对；与 `app.color.grid_line` 是两回事——后者给 DOM）。 */
  grid: string;
  /** 对象外框 / 占位文字。 */
  objectStroke: string;
  /** 未选中对象的外框（选中外框的淡版；`rgba` 不能被 `$r()` 表达）。 */
  objectOutlineFaded: string;
  /** 对象占位填充（配合 globalAlpha 变淡）。 */
  objectTint: string;
  /** 选中的对象外框 / 缩放手柄。 */
  selectionStroke: string;
  /** 选中的对象删除 ×。 */
  objectDanger: string;
}

/** 纸面绘制色（唯一能在 `.ets` 里被引用的十六进制来源）。 */
export const CANVAS_PAINTS: CanvasPaints = {
  paper: '#FFFFFF',
  mask: '#FFFFFF',
  grid: '#4A5563',
  objectStroke: '#4A5563',
  objectOutlineFaded: 'rgba(47,107,255,0.45)',
  objectTint: '#2F6BFF',
  selectionStroke: '#2F6BFF',
  objectDanger: '#D93025'
};

/**
 * 深色档字面色：**只给被静态测试钉住、不能用 `$r()` 的位置兜底**。
 *
 * 现状只有一处：`harmony/ets/pages/Handwriting.ets` 的 4 个分页单元格 + rail 工具按钮，
 * `tools/test/handwritingToolbar.test.mjs:418` 用正则要求这些 `@Builder` 内必须出现
 * `'#F…'` 字面量（该测试不在本轮可改范围）。于是浅色档保留被钉住的字面量、深色档取这里，
 * 两档都正确渲染；`theme.test.mjs` 会断言这里的值与 `color.json` 的深色同名令牌一致。
 */
export interface DarkFallback {
  /** 分页单元格底色（= `control_fill_alt` 深色值）。 */
  chipFill: string;
  /** rail 工具按钮底色（= `control_fill` 深色值）。 */
  railFill: string;
}

/** 深色档兜底色（值必须与 `resources/dark/element/color.json` 一致，测试会比对）。 */
export const DARK_FALLBACK: DarkFallback = {
  chipFill: '#1B1E21',
  railFill: '#23262A'
};
