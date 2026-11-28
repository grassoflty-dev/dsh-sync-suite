// 源码扫描的共享底座（只做「读」与「切区间」，不含任何断言）。
//
// 为什么要有这个文件：A2 拆分把 `pages/Settings.ets` 按功能组拆成 `components/settings/*.ets`，
// 之后所有「按行号 / 按文件切片」的静态断言都得跟着搬。位置会变，**结构不会变**，
// 所以这里只提供两样东西：
//   1. 稳定的相对路径与注释剥离（行号保持与源文件一致）；
//   2. `build()` 与全部 `@Builder` 的**区间**——「有没有渲染落点」就靠它判定，
//      作者把代码搬到哪个文件都不影响。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/arkui-schedule` 的绝对路径（从本文件位置推，任意工作目录都成立）。 */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** `entry/src` 的绝对路径。 */
export const ETS_ROOT = join(APP_ROOT, 'entry', 'src');

/** 读 `entry/src` 下的文件（传相对 `entry/src` 的路径，正反斜杠都行）。 */
export function readEts(relative) {
  return readFileSync(join(ETS_ROOT, relative), 'utf8');
}

/** 读 `apps/arkui-schedule` 下的文件（传相对 app 根的路径）。 */
export function readApp(relative) {
  return readFileSync(join(APP_ROOT, relative), 'utf8');
}

/**
 * 剥注释（块注释 + 行注释）；保留换行数，行号与源文件一致。
 *
 * 旧实现是两条全局正则，`//` 只要出现在字符串里就会被当成行注释开头，
 * 把同一行后面的代码一起吃掉（`const u = 'https://x'; if (entry.kind …)`）。
 * 这里改成单遍状态机：先认字符串字面量（含转义），字符串里的 `//` / `/*` 原样保留；
 * 只有代码态下的 `//` / `/*` 才算注释。块注释仍用等长空格占位（仅保留 `\n`），
 * 行注释仍只删到行尾，所以所有依赖「行号不变」的守卫行为都不变。
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  const size = source.length;
  while (i < size) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < size && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < size) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < size && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < size) {
        const inner = source[i];
        out += inner;
        i += 1;
        if (inner === '\\' && i < size) {
          out += source[i];
          i += 1;
        } else if (inner === quote) {
          break;
        }
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 递归收集目录下指定后缀的文件（返回正斜杠绝对路径，顺序稳定）。 */
export function listFiles(dir, suffixes = ['.ets'], out = []) {
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, suffixes, out);
    } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      out.push(full.replace(/\\/g, '/'));
    }
  }
  return out;
}

/** 相对 `entry/src` 的展示路径（报错信息用）。 */
export function relToEts(absolute) {
  return absolute.slice(ETS_ROOT.length + 1);
}

/** 从 `code[startIndex]` 处的 `{` 开始做括号配对，返回 `[start, endExclusive]`。 */
export function matchBrace(code, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < code.length; index++) {
    const ch = code[index];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return [startIndex, index + 1];
      }
    }
  }
  return [startIndex, code.length];
}

/**
 * 「渲染树」区间：`build() { … }` 与每个 `@Builder Name(...) { … }`。
 *
 * 只认这两种：ArkUI 的界面只能从这两个入口生成。页面里的普通方法（saveSettings /
 * pushBlockedReason …）不是渲染树，字段只在方法里出现 = 界面上看不到。
 */
export function renderRegions(code) {
  const regions = [];
  const pattern = /(?:build\s*\(\s*\)|@Builder\s*\n\s*[A-Za-z_]\w*\s*\([^)]*\))\s*\{/g;
  for (const matched of code.matchAll(pattern)) {
    regions.push(matchBrace(code, matched.index + matched[0].length - 1));
  }
  return regions;
}

/** 索引 → 1 起始行号。 */
export function lineNumberAt(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/** 索引所在行的整行文本（去掉首尾空白）。 */
export function lineTextAt(code, index) {
  const start = code.lastIndexOf('\n', index) + 1;
  const end = code.indexOf('\n', index);
  return code.slice(start, end === -1 ? code.length : end).trim();
}

/** 索引所在行的全部行文本（含前后各 `radius` 行的窗口）——「前后 8 行」语义约束的最小实现。 */
export function windowLines(code, index, radius = 8) {
  const lines = code.split('\n');
  const line = lineNumberAt(code, index) - 1;
  return lines.slice(Math.max(0, line - radius), line + radius + 1).join('\n');
}

// 覆盖层状态判定统一由 `tools/test/guard.mjs`（`requireOverlayRestored`）负责——
// 构建期 `overlay apply` 会把 main 树换成 harmony 的副本，源码扫描类断言全部失真，
// 所以测试入口直接硬失败。2026-11-18 那 4 条色值假红就是残留 overlay 造成的，不是代码写死。
