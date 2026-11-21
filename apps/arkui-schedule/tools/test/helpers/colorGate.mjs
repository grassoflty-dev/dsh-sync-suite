// 色值门闸：**目录级预算 + 语义约束**（替代原来的「文件:行号锚点」白名单）。
//
// 背景：旧门闸把豁免写成 `{ file, anchor, kind }`，锚点是**行内文本**。
// A1 / A2 两次重构（手写页去重、设置页拆 section）都让它整片打红：代码只是**搬家**，
// 颜色一个都没变，但「文件:行号」对不上了。位置是重构的产物，不该当契约。
//
// 现在的判据只有两层：
//   1. **目录级预算**（`COLOR_BUDGET`）：只看目录内各类字面量的**总计数**，
//      文件怎么拆、怎么挪、怎么改名都不影响；新增一个字面量就超预算 → 红。
//   2. **语义约束**（`shapeViolations`）：预算内的每一处还必须长在**允许的上下文形态**里
//      （`isDarkTheme() ? 深色令牌 : '浅色'` 的假分支、常量对象字面量、`backgroundColor(...)`
//      的参数位置……）。防止「预算还有额度，随手塞一个裸 hex」。
//
// 计数常量是**实测值**（2026-11-18，工作区无覆盖层残留时逐目录数出来的），
// 不是拍的：改代码导致计数变化时，先看是不是该走令牌，再決定改预算（改预算 = 显式决策）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ETS_ROOT, listFiles, relToEts, stripComments, windowLines } from './etsSource.mjs';

/**
 * 色值字面量的可扫描形态。每一种都有负向自测盯着（改正则先跑那组用例）。
 * - `hex`：`#FFF` / `#RGBA` / `#RRGGBB` / `#AARRGGBB`（大小写不敏感）；
 * - `func`：`rgb(` / `rgba(` / `hsl(` / `hsla(`（含空格语法）；
 * - `named`：**任意** `Color.<Name>`（不靠常见色名单，`Color.Cyan` 也抓）；
 * - `ctor`：`Color(0x…)` / `Color(数字)`；
 * - `concat`：`'#' + '…'`、`'…' + 'F1F3F5'`、`` `#${x}` ``。
 */
export const COLOR_PATTERNS = [
  { kind: 'hex', label: 'hex 字面色（3/4/6/8 位）', pattern: /#[0-9A-Fa-f]{3,8}\b/g },
  { kind: 'func', label: 'rgb()/rgba()/hsl()/hsla()', pattern: /\b(?:rgba?|hsla?)\s*\(/g },
  { kind: 'named', label: 'Color.<Name> 命名色', pattern: /\bColor\.[A-Za-z][A-Za-z0-9]*/g },
  { kind: 'ctor', label: 'Color(0x…) / Color(数字)', pattern: /\bColor\s*\(\s*(?:0[xX][0-9A-Fa-f]+|\d+)/g },
  { kind: 'concat', label: "'#' + '…' 拼接", pattern: /['"]#['"]?\s*\+/g },
  { kind: 'concat', label: "'…' + 'F1F3F5' 拼接", pattern: /\+\s*['"][0-9A-Fa-f]{3,8}['"]/g },
  // 模板拼接：`` `#${x}` ``（`#` 前面必须是行首或非 `#`/单词字符，否则 Markdown 的 `## ${date}` 会误报）
  { kind: 'concat', label: '`#${x}` 模板拼接', pattern: /(^|[^#\w])#\s*\$\{/g }
];

/**
 * 目录级预算表。**限额就是当前实测值**（`≤` 只留「变少」的方向）：
 * 计数一涨就红，等于「新增字面色必须走令牌或显式改预算」。
 *
 * 每行的 `measured` 注释写清实测时间与逐类计数——这是「以实测为准」的凭据。
 */
export const COLOR_BUDGET = [
  {
    // 共享 UI 层：只该有资源令牌 $r('app.color.*')。
    // 实测 2026-11-18（40 个 .ets）：hex 0 / rgb 0 / ctor 0 / concat 0；named 1 = Index.ets 的 Color.Transparent。
    // 2026-11-21 S3：日程正文迁入 pages/panes/SchedulePane.ets 且 Index 保留为 fallback 路由，
    // 同一处 AiPanel「取消」按钮底色被逐字复制，故 named 2 = Index + SchedulePane 各 1（显式决策，
    // theme.test.mjs 再加逐文件断言防止扩散到第三个文件）。
    key: 'main-ui',
    dir: 'entry/src/main/ets',
    suffixes: ['.ets'],
    label: 'entry/src/main/ets（共享 UI，.ets）',
    limits: { hex: 0, func: 0, ctor: 0, concat: 0, named: 2 },
    namedLimits: { 'Color.Transparent': 2 }
  },
  {
    // 共享纯逻辑层：画布绘制色 / 墨色 / 兜底色。这些**本来就不跟主题**，
    // 也不能换成 $r()（Node 单测与 canvas 绘制都要拿到字符串）。
    // 实测 2026-11-18：hex 16（theme.ts 9 + strokeHistory.ts 6 + draft.ts 1）/ func 4（brush.ts 3 + theme.ts 1）。
    key: 'main-model',
    dir: 'entry/src/main/ets/model',
    suffixes: ['.ts'],
    label: 'entry/src/main/ets/model（纯逻辑，.ts）',
    limits: { hex: 16, func: 4, ctor: 0, concat: 0, named: 0 },
    namedLimits: {}
  },
  {
    // 共享 common 层：一个色值都不该有（实测 0 / 0 / 0 / 0 / 0，5 个 .ts）。
    key: 'main-common',
    dir: 'entry/src/main/ets/common',
    suffixes: ['.ts'],
    label: 'entry/src/main/ets/common（.ts）',
    limits: { hex: 0, func: 0, ctor: 0, concat: 0, named: 0 },
    namedLimits: {}
  },
  {
    // 鸿蒙覆盖层：5 处 hex 是 `handwritingToolbar.test.mjs` 逐字钉住的浅色档（`'#F7F9FB'` /
    // `'#F1F3F5'` / `'#F7F8FA'`），命名色 4 处 = 完成按钮反白字 1 + 选中态透明 3。
    // 实测 2026-11-18（6 个文件）：hex 5 / named 4（White 1、Transparent 3）/ rgb 0 / ctor 0 / concat 0。
    key: 'harmony',
    dir: 'entry/src/harmony/ets',
    suffixes: ['.ets', '.ts'],
    label: 'entry/src/harmony/ets（鸿蒙覆盖层）',
    limits: { hex: 5, func: 0, ctor: 0, concat: 0, named: 4 },
    namedLimits: { 'Color.White': 1, 'Color.Transparent': 3 }
  }
];

/**
 * 鸿蒙树里被 `handwritingToolbar.test.mjs` 钉住的浅色档**值集合**。
 * 光有预算（≤5）挡不住「把 '#123456' 塞进三元里」，值集合再收一道：
 * 只认这三个属于「工具条浅色底」的钉住值。
 */
export const PINNED_HEX_VALUES = new Set(['#F7F9FB', '#F1F3F5', '#F7F8FA']);

/** 逐条命中（行内正则；带 index 供「前后 8 行窗口」判定用）。 */
export function detectColorLiterals(code) {
  const hits = [];
  const lines = code.split('\n');
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    for (const rule of COLOR_PATTERNS) {
      // 每次用新的 lastIndex，避免 g 正则跨行残留
      const found = [...text.matchAll(rule.pattern)];
      for (const matched of found) {
        hits.push({
          line: index + 1,
          index: offset + matched.index,
          kind: rule.kind,
          literal: matched[0].trim(),
          text
        });
      }
    }
    offset += text.length + 1;
  }
  return hits;
}

/** 一个预算桶包含的文件（绝对路径，正斜杠）。 */
export function bucketFiles(bucket) {
  const relativeDir = bucket.dir.replace(/^entry\/src\//, '');
  return listFiles(join(ETS_ROOT, ...relativeDir.split('/')), bucket.suffixes);
}

/** 扫描一个预算桶，返回带文件/上下文的命中。 */
export function scanBucket(bucket) {
  return scanFiles(bucketFiles(bucket), bucket.key);
}

/** 扫描显式文件列表（负向自测也用它）。 */
export function scanFiles(files, bucketKey = 'ad-hoc') {
  const hits = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const hit of detectColorLiterals(code)) {
      hits.push({
        ...hit,
        bucket: bucketKey,
        file: relToEts(file),
        absolute: file,
        code
      });
    }
  }
  return hits;
}

/** 全部预算桶的命中（顺序 = `COLOR_BUDGET` 的顺序，便于报错逐目录读）。 */
export function collectColorHits() {
  return COLOR_BUDGET.flatMap((bucket) => scanBucket(bucket));
}

/** 某桶内某类的计数。 */
export function countsOf(hits, bucketKey) {
  const counts = {};
  for (const hit of hits.filter((item) => item.bucket === bucketKey)) {
    counts[hit.kind] = (counts[hit.kind] ?? 0) + 1;
  }
  return counts;
}

/** 预算违约（超限 = 新增；`≤` 只放过变少）。 */
export function budgetViolations(hits) {
  const violations = [];
  for (const bucket of COLOR_BUDGET) {
    const counts = countsOf(hits, bucket.key);
    for (const [kind, limit] of Object.entries(bucket.limits)) {
      const actual = counts[kind] ?? 0;
      if (actual > limit) {
        violations.push(
          `${bucket.label}：${kind} ${actual} 处 > 预算 ${limit} 处` +
            `（目录级预算，实测值见 COLOR_BUDGET 注释；新增字面色请走 $r()/CANVAS_PAINTS，` +
            `确需豁免就改预算并在注释里写理由）`
        );
      }
    }
    const named = hits.filter((hit) => hit.bucket === bucket.key && hit.kind === 'named');
    const seen = new Set(named.map((hit) => hit.literal));
    for (const literal of seen) {
      const limit = bucket.namedLimits[literal] ?? 0;
      const actual = named.filter((hit) => hit.literal === literal).length;
      if (actual > limit) {
        violations.push(`${bucket.label}：命名色 ${literal} ${actual} 处 > 预算 ${limit} 处`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------- 语义形态判定

/** `name: '#xxx'` / `name: 'rgba(…)'` 形式（常量对象字面量的属性，允许行首缩进）。 */
const OBJECT_PROPERTY = /^\s*[A-Za-z_]\w*\s*:\s*['"`](?:#[0-9A-Fa-f]{3,8}|rgba?\()/;
/** `const NAME: string = '#xxx'` 形式。 */
const CONST_STRING = /(?:const|let)\s+[A-Za-z_]\w*\s*:\s*string\s*=\s*['"`](?:#[0-9A-Fa-f]{3,8}|rgba?\()/;
/** `isDarkTheme(...) ? 深色 : '浅色'` 的**假分支**（窗口内匹配）。 */
const DARK_TERNARY = /isDarkTheme\([^)]*\)\s*\?[^;]*?:\s*[^;]*?['"`]#[0-9A-Fa-f]{3,8}['"`]/;
/** 颜色位置的调用前缀：`.backgroundColor(` / `.borderColor(` 等（只看到字面量**之前**的部分）。 */
const COLOR_CALL_PREFIX = /\.(?:backgroundColor|borderColor|foregroundColor|fillColor|fontColor)\s*\([^()]*$/;
/** 常量数组字面量：`const PEN_COLORS: string[] = [ … ]`（元素可以全写在一行）。 */
const CONST_ARRAY = /(?:const|let)\s+[A-Za-z_]\w*\s*:\s*string\[\]\s*=\s*\[/;
/** 返回绘制串的语句（`return \`rgba(...)\`` / `return 'rgba(...)'`）。 */
const RETURN_PAINT = /return\s+[`'"]rgba?\(/;

/**
 * 语义约束：预算内的每一处命中都必须在**允许的上下文形态**里。
 * 返回 `[{ hit, reason }]`，空数组 = 全部合规。
 *
 * 判定用「命中行 + 前后 8 行窗口」，不看行号：作者把整段代码上移下移、换个文件都不影响。
 * 命名色额外看「字面量**之前**的同一行」——`backgroundColor(...)` 的参数位、三元假分支的
 * `:` 之后，这两种位置才放行。
 */
export function shapeViolations(hits) {
  const violations = [];
  for (const hit of hits) {
    const line = hit.text;
    const before = line.slice(0, line.indexOf(hit.literal));
    const window = windowLines(hit.code, hit.index, 8);
    const reason = violationFor(hit, line, before, window);
    if (reason !== null) {
      violations.push({ hit, reason });
    }
  }
  return violations;
}

/** 同一个表达式里已经出现了颜色调用（透明色作为它的参数或参数里的三元分支）。 */
function insideColorCall(before, window) {
  if (COLOR_CALL_PREFIX.test(before)) {
    return true;
  }
  // 跨行写法：调用开始在上面的行里，字面量在下一行
  return /\.(?:backgroundColor|borderColor|foregroundColor|fillColor|fontColor)\s*\([^;]*$/.test(
    window.slice(0, window.lastIndexOf('\n') + 1)
  );
}

function violationFor(hit, line, before, window) {
  switch (hit.bucket) {
    case 'main-ui': {
      if (hit.kind === 'named' && hit.literal === 'Color.Transparent') {
        return insideColorCall(before, window)
          ? null
          : 'main 树的 Color.Transparent 只允许出现在 .backgroundColor(...)/.borderColor(...) 这类调用参数位置';
      }
      return `${hit.kind} 在共享 UI 层没有豁免额度（必须走 $r('app.color.*')）`;
    }
    case 'main-model': {
      if (hit.kind === 'hex' || hit.kind === 'func') {
        if (CONST_STRING.test(line) || OBJECT_PROPERTY.test(line) || RETURN_PAINT.test(line)) {
          return null;
        }
        if (CONST_ARRAY.test(line)) {
          return null;
        }
        return `${hit.kind} 必须长在常量对象字面量 / const 声明 / 常量数组 / 返回绘制串的语句里`;
      }
      return `${hit.kind} 在 model 层没有豁免额度`;
    }
    case 'main-common':
      return `${hit.kind} 在 common 层没有豁免额度（必须走 $r('app.color.*')）`;
    case 'harmony': {
      if (hit.kind === 'hex') {
        if (!PINNED_HEX_VALUES.has(hit.literal.toUpperCase())) {
          return `hex ${hit.literal} 不在被 handwritingToolbar.test.mjs 钉住的浅色档值集合里`;
        }
        if (CONST_STRING.test(line) || CONST_ARRAY.test(line) || DARK_TERNARY.test(window)) {
          return null;
        }
        return 'harmony 树的 hex 必须是 `isDarkTheme(...) ? 深色令牌 : \'浅色\'` 的假分支，或常量声明';
      }
      if (hit.kind === 'named' && hit.literal === 'Color.White') {
        return /\.fontColor\(\s*$/.test(before)
          ? null
          : 'Color.White 只允许用在完成按钮的 .fontColor(...) 上';
      }
      if (hit.kind === 'named' && hit.literal === 'Color.Transparent') {
        const ternaryBranch = /\?\s*[^:]*:\s*$/.test(before);
        return insideColorCall(before, window) || ternaryBranch
          ? null
          : 'Color.Transparent 只允许出现在调用参数位置或三元假分支';
      }
      return `${hit.kind} ${hit.literal} 在 harmony 树没有豁免额度`;
    }
    default:
      return `未知预算桶 ${hit.bucket}（新目录必须先登记进 COLOR_BUDGET）`;
  }
}

/** 把命中格式化成「文件:行号: [类别] 字面量 → 整行」。 */
export function formatHit(hit) {
  return `${hit.file}:${hit.line}: [${hit.kind}] ${hit.literal} → ${hit.text.trim()}`;
}
