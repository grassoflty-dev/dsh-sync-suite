// 结构断言：防「文本匹配抓得住出现、抓不住是否被用」。
//
// 由来（A2 拆分后的真实教训）：拆分把 `Settings.ets` 里的大段 @Builder 搬进五个 section
// 组件后，静态守卫全部改成「在页面 + 五个 section 的合并源码里 grep 这段文案/这个调用」。
// 合并源码里文本当然都在——**包括那些定义了却再没人调用的 builder、赋值了却没人渲染的
// 错误状态**。文本匹配能证明「代码存在」，证明不了「它在界面上发生过」。
//
// 这里补两条**结构**判据（与文案、行号、文件名都无关）：
//   1. `unreadStateFields`：每个 `@State` 字段至少被**读**一次（只被写 = 死状态）；
//   2. `fieldsWithoutRenderSite`：校验类字段（`xxxIssue` / `xxxError` / `xxxWarning`）
//      必须出现在 `build()` / 某个 `@Builder` 的区间里（只声明不渲染 = 幽灵报错）。
// 外加 `propWiringViolations`：页面传给 section 的 props 必须与组件声明**双向对齐**
// （少传 = 组件永远走默认值，多传 = 拼错名字被静默忽略，两种都是拆分类重构的典型破法）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ETS_ROOT, lineNumberAt, lineTextAt, listFiles, matchBrace, relToEts, renderRegions, stripComments } from './etsSource.mjs';

// 默认扫描范围：`pages` 与 `components` 两棵子树下的全部 `.ets`（`entry/src/main/ets` 内）。
export function componentFiles(dirs = ['pages', 'components']) {
  return dirs.flatMap((dir) => listFiles(join(ETS_ROOT, 'main', 'ets', dir), ['.ets']));
}

/** 读并剥注释。 */
function sourceOf(file) {
  return stripComments(readFileSync(file, 'utf8'));
}

/**
 * 统计 `this.<field>` 的读 / 写次数。
 *
 * 写：`= …`（排除 `==`/`===`）、`+=` `-=` `*=` `|=` `&=`、`++` `--`。
 * 读：其余全部（含当参数传出去、参与表达式、`.length` 之类）。
 */
export function fieldUsage(source, field) {
  const pattern = new RegExp(`this\\.${field}\\b`, 'g');
  let reads = 0;
  let writes = 0;
  for (const matched of source.matchAll(pattern)) {
    const tail = source.slice(matched.index + matched[0].length, matched.index + matched[0].length + 6);
    if (/^\s*(\+\+|--)/.test(tail) || /^\s*(-=|\+=|\*=|&=|\|=)/.test(tail) || /^\s*=(?!=)/.test(tail)) {
      writes += 1;
    } else {
      reads += 1;
    }
  }
  return { reads, writes, total: reads + writes };
}

/** 收集全部 `@State` 字段声明。 */
export function collectStateFields(files) {
  const fields = [];
  for (const file of files) {
    const source = sourceOf(file);
    for (const matched of source.matchAll(/@State\s+([A-Za-z_]\w*)\s*[:=]/g)) {
      fields.push({
        file: relToEts(file),
        absolute: file,
        field: matched[1],
        line: lineNumberAt(source, matched.index),
        usage: fieldUsage(source, matched[1])
      });
    }
  }
  return fields;
}

/**
 * 死状态检查：返回「只被写、从未被读」的 `@State` 字段。
 *
 * `allowlist` 每条形如 `{ file, field, reason }`，`reason` 必填（写清为什么这个字段
 * 只写不读还留着）。白名单里某条已经对不上了（字段删了/改成会被读了）也算违约——
 * 免得白名单只增不减。
 */
export function unreadStateFields(files, allowlist = []) {
  const violations = [];
  const fields = collectStateFields(files);
  for (const item of allowlist) {
    if (!item.reason || item.reason.trim().length === 0) {
      violations.push({ file: item.file, field: item.field, line: 0, reason: '白名单条目缺少 reason（必须写清为什么允许只写不读）' });
    }
  }
  for (const field of fields) {
    if (field.usage.reads > 0) {
      continue;
    }
    const allowed = allowlist.find((item) => item.file === field.file && item.field === field.field);
    if (allowed === undefined) {
      violations.push({
        file: field.file,
        field: field.field,
        line: field.line,
        reason: `@State ${field.field} 只被写 ${field.usage.writes} 次、从未被读——死状态（要么删掉，要么加白名单并写理由）`
      });
    }
  }
  for (const item of allowlist) {
    const field = fields.find((candidate) => candidate.file === item.file && candidate.field === item.field);
    if (field === undefined) {
      violations.push({ file: item.file, field: item.field, line: 0, reason: '白名单条目已过期（源码里没有这个 @State），请删掉' });
    } else if (field.usage.reads > 0) {
      violations.push({ file: item.file, field: item.field, line: field.line, reason: '白名单条目已过期（字段现在会被读了），请删掉' });
    }
  }
  return { violations, fields, allowlistSize: allowlist.length };
}

/** 校验类字段：`xxxIssue` / `xxxError` / `xxxWarning`（页面 @State 与组件 @Prop 都算）。 */
export function collectIssueFields(files) {
  const fields = [];
  for (const file of files) {
    const source = sourceOf(file);
    for (const matched of source.matchAll(/@(State|Prop)\s+([A-Za-z_]\w*)\s*[:=]/g)) {
      if (!/(?:Issue|Error|Warning)$/.test(matched[2])) {
        continue;
      }
      fields.push({
        file: relToEts(file),
        absolute: file,
        field: matched[2],
        decorator: matched[1],
        line: lineNumberAt(source, matched.index)
      });
    }
  }
  return fields;
}

/**
 * 可见落点检查：返回「声明了、但没在渲染树里出现过」的校验类字段。
 *
 * 渲染树 = 本文件的 `build()` + 全部 `@Builder`（见 `renderRegions`）。
 * 页面把字段作为 prop 传给 section 也算落点（那行就在 `XxxGroup()` 这个 @Builder 里），
 * 但接受方自己的 `@Prop` 同样要过一遍本检查——两层都过才算「真能看见」。
 */
export function fieldsWithoutRenderSite(files) {
  const violations = [];
  const fields = collectIssueFields(files);
  const regionsByFile = new Map();
  for (const field of fields) {
    if (!regionsByFile.has(field.absolute)) {
      regionsByFile.set(field.absolute, renderRegions(sourceOf(field.absolute)));
    }
    const source = sourceOf(field.absolute);
    const regions = regionsByFile.get(field.absolute);
    const pattern = new RegExp(`this\\.${field.field}\\b`);
    const hit = regions.find(([start, end]) => pattern.test(source.slice(start, end)));
    if (hit === undefined) {
      violations.push({
        file: field.file,
        field: field.field,
        line: field.line,
        reason: `${field.decorator} ${field.field} 只在逻辑里出现，build()/@Builder 里没有引用——界面看不到（幽灵报错）`
      });
    }
  }
  return { violations, fields, scannedFiles: files.length };
}

/** 提取组件声明里的字段名（@Prop / @State / 普通成员，含回调函数成员）。 */
export function declaredMembers(source) {
  const members = [];
  const pattern = /^\s{2}(?:@Prop\s+|@State\s+|@Link\s+)?([A-Za-z_]\w*)\s*(?:!\s*)?\??:\s*/gm;
  for (const matched of source.matchAll(pattern)) {
    members.push({ name: matched[1], line: lineNumberAt(source, matched.index) });
  }
  return members;
}

/** 提取 `Struct({ … })` 调用点里传的 key（按调用体里的最小缩进判定「顶层 key」）。 */
export function passedKeys(source, structName) {
  const marker = new RegExp(`${structName}\\s*\\(\\s*\\{`);
  const matched = marker.exec(source);
  if (matched === null) {
    return null;
  }
  const braceAt = matched.index + matched[0].length - 1;
  const [start, end] = matchBrace(source, braceAt);
  const body = source.slice(start + 1, end - 1);
  const lines = body.split('\n').filter((line) => line.trim().length > 0);
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  const keys = [];
  for (const line of lines) {
    const lead = line.length - line.trimStart().length;
    if (lead !== indent) {
      continue;
    }
    const key = /^([A-Za-z_]\w*)\s*:/.exec(line.trim());
    if (key !== null) {
      keys.push(key[1]);
    }
  }
  return keys;
}

/**
 * 装配对齐：`page`（引用页面）里每个 `Struct({…})` 调用点 vs `sections`（组件文件）的声明。
 *
 * 少传 → 组件永远用默认值（拆分后最典型的「功能还在但界面不动」）；
 * 多传 → 名字拼错，ArkTS 静默忽略（或编译期才报）。
 */
export function propWiringViolations(pageFile, sectionFiles) {
  const violations = [];
  const page = sourceOf(pageFile);
  for (const file of sectionFiles) {
    const structName = structNameOf(file);
    const section = sourceOf(file);
    const declared = declaredMembers(section).map((member) => member.name);
    const passed = passedKeys(page, structName);
    if (passed === null) {
      violations.push({ file: relToEts(file), reason: `页面里找不到 ${structName}({ … }) 调用点（组件没被挂上）` });
      continue;
    }
    for (const name of declared) {
      if (!passed.includes(name)) {
        violations.push({ file: relToEts(file), reason: `页面没给 ${structName}.${name} 传值（组件只会用默认值，拆分后数据断了）` });
      }
    }
    for (const name of passed) {
      if (!declared.includes(name)) {
        violations.push({ file: relToEts(file), reason: `页面给 ${structName} 传了未声明的 ${name}（拼错名字会被静默忽略）` });
      }
    }
  }
  return violations;
}

/** 从 `export struct Foo {` 取组件名。 */
export function structNameOf(file) {
  const source = sourceOf(file);
  const matched = /export\s+struct\s+([A-Za-z_]\w*)/.exec(source);
  return matched === null ? '' : matched[1];
}
