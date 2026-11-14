#!/usr/bin/env node
/**
 * ArkUI-X 工程结构校验（`docs/CONTRACT.md` §3.5 的 7 条规则）。
 *
 * 用法：
 *   node apps/arkui-schedule/tools/validate-app.mjs [--root <dir>] [--json]
 *
 * - `--root` 默认是本文件上一级（`apps/arkui-schedule`），因此也能对 fixture 目录跑；
 * - 全部通过：打印 `✅` 汇总并以 0 退出；
 * - 有失败项：逐条打印 `❌ 规则 N ...` 明细并以 1 退出；
 * - 参数错误以 2 退出。
 *
 * 规则（与契约一一对应）：
 * 1. 所有 `.json5`/`.json` 可解析（内置 JSON5 子集解析器）；
 * 2. 所有 `.ets`/`.ts` 相对 import 可解析；main 文件的 import 不得只在平台覆盖目录里成功；
 * 3. `main_pages.json` 与 pages 目录一致；harmony 版必须是超集且文件存在；
 * 4. Android 可见路径（main + android）不得引用 OCR / 手写 / PixelMap / 图像识别模块；
 * 5. 任何含 `struct` 的 `.ets` 必须带 `@crossplatform`；
 * 6. rawfile/git 下的 isomorphic-git.js（≥100KB）与 git-bridge.js 存在且非空；
 * 7. `module.json5` 的 srcEntry、页面 profile 与 `$media/$string/$color/$profile` 资源引用都存在。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseJson5 } from './json5.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');

/** 递归时跳过的目录（构建产物/依赖/版本库）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'oh_modules',
  '.git',
  '.build',
  'build',
  'dist',
  '.hvigor',
  '.idea',
  '.preview'
]);

/** 平台源码树：main 为共享层，harmony/android 为覆盖层（同名相对路径后者优先）。 */
const TREES = {
  main: 'entry/src/main/ets',
  harmony: 'entry/src/harmony/ets',
  android: 'entry/src/android/ets'
};

const RULES = {
  1: 'JSON5/JSON 可解析',
  2: '相对 import 可解析',
  3: 'main_pages.json 与 pages 目录一致',
  4: 'Android 可见路径无 OCR/手写/PixelMap 引用',
  5: '含 struct 的 .ets 带 @crossplatform',
  6: 'rawfile/git 资源完整',
  7: 'module.json5 的 srcEntry/页面 profile/资源引用存在'
};

const MIN_ISOMORPHIC_GIT_BYTES = 100 * 1024;

// ---------------------------------------------------------------- 基础工具

function readText(file) {
  return readFileSync(file, 'utf8').replace(/^\ufeff/, '');
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function walkFiles(dir, filter, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      walkFiles(full, filter, out);
    } else if (entry.isFile() && filter(full)) {
      out.push(full);
    }
  }
  return out;
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function display(root, file) {
  return toPosix(relative(root, file));
}

// ---------------------------------------------------------------- 规则 1

function ruleJsonParsable(root) {
  const messages = [];
  const files = walkFiles(root, (file) => /\.(json5|json)$/i.test(file));
  for (const file of files) {
    try {
      parseJson5(readText(file));
    } catch (error) {
      messages.push(`${display(root, file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { messages, count: files.length };
}

// ---------------------------------------------------------------- 规则 2 / 4 / 5 共用：源码预处理

/**
 * 去掉注释（保留字符串字面量与换行）。
 *
 * 规则 2/4/5 针对的是**代码**：注释里提到 PixelMap / ocr 属于文档说明，不应判失败；
 * 反之注释里写 `@crossplatform` 也不能算通过。
 */
function stripComments(source) {
  let out = '';
  let state = 'code';
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block';
        i += 2;
        out += ' ';
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        state = char;
        out += char;
        i++;
        continue;
      }
      out += char;
      i++;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += '\n';
      }
      i++;
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        i += 2;
        out += ' ';
        continue;
      }
      if (char === '\n') {
        out += '\n';
      }
      i++;
      continue;
    }
    // 字符串内部：转义跳过，遇到同种引号结束
    if (char === '\\') {
      out += char + (next === undefined ? '' : next);
      i += 2;
      continue;
    }
    if (char === state) {
      state = 'code';
      out += char;
      i++;
      continue;
    }
    out += char;
    i++;
  }
  return out;
}

/** 读取源码并去掉注释（规则 2/4/5 统一入口）。 */
function readCode(file) {
  return stripComments(readText(file));
}

/** 从源码中抽取所有静态/动态 import 与 re-export 的模块说明符。 */
function extractImportSpecifiers(content) {
  const specs = new Set();
  const patterns = [
    /(?:^|[\s;{}()])import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|[\s;{}()])export\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    let matched;
    while ((matched = pattern.exec(content)) !== null) {
      specs.add(matched[1]);
    }
  }
  return Array.from(specs);
}

/** 判断文件属于哪棵源码树（main/harmony/android）。 */
function treeOf(root, file) {
  for (const name of Object.keys(TREES)) {
    const treeRoot = join(root, TREES[name]);
    const rel = relative(treeRoot, file);
    if (rel.length > 0 && !rel.startsWith('..') && !rel.includes(`..${sep}`)) {
      return name;
    }
  }
  return null;
}

/** 尝试把无扩展名基路径解析成真实文件（原样 / .ets / .ts / .d.ts / index）。 */
function tryResolveFile(base) {
  const candidates = [
    base,
    `${base}.ets`,
    `${base}.ts`,
    `${base}.d.ts`,
    join(base, 'index.ets'),
    join(base, 'index.ts')
  ];
  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 解析相对 import：
 * - 本树优先；
 * - main 树的文件再按 harmony → android 顺序镜像查找（覆盖层语义）；
 * - harmony/android 树的文件回落到 main（共享层）。
 */
function resolveRelativeImport(root, file, spec) {
  const tree = treeOf(root, file);
  if (tree === null) {
    return { ok: false, reason: 'not-in-ets-tree' };
  }
  const absTarget = resolve(dirname(file), spec);
  const relFromEts = relative(join(root, TREES[tree]), absTarget);
  const order = tree === 'main' ? ['main', 'harmony', 'android'] : [tree, 'main'];
  for (const candidateTree of order) {
    const found = tryResolveFile(join(root, TREES[candidateTree], relFromEts));
    if (found !== null) {
      return { ok: true, tree: candidateTree, file: found };
    }
  }
  return { ok: false, reason: 'missing' };
}

function collectSourceFiles(root) {
  const files = [];
  for (const name of Object.keys(TREES)) {
    const treeRoot = join(root, TREES[name]);
    walkFiles(treeRoot, (file) => /\.(ets|ts)$/.test(file), files);
  }
  return files;
}

function ruleImportsResolvable(root, sourceFiles) {
  const messages = [];
  let checked = 0;
  for (const file of sourceFiles) {
    const tree = treeOf(root, file);
    const content = readCode(file);
    for (const spec of extractImportSpecifiers(content)) {
      if (!spec.startsWith('.')) {
        continue; // 包名 / @ohos.* / @kit.* 不在本规则校验范围
      }
      checked++;
      const result = resolveRelativeImport(root, file, spec);
      if (!result.ok) {
        if (result.reason !== 'missing') {
          continue;
        }
        messages.push(`断链 import：${display(root, file)} → '${spec}'（候选：原样/.ets/.ts/index.ets 均不存在）`);
        continue;
      }
      if (tree === 'main' && result.tree !== 'main') {
        messages.push(
          `main 文件的 import 不能只依赖 ${result.tree} 覆盖层：${display(root, file)} → '${spec}'` +
            `（解析到 ${display(root, result.file)}，Android/HarmonyOS 另一侧会编译失败）`
        );
      }
    }
  }
  return { messages, checked };
}

// ---------------------------------------------------------------- 规则 3

/** 把 profile 里的条目规范化成 `pages/<Name>`（去 `./`、去 `.ets`、统一斜杠）。 */
function normalizePageEntry(entry) {
  let text = String(entry).trim().replace(/\\/g, '/');
  while (text.startsWith('./')) {
    text = text.slice(2);
  }
  text = text.replace(/\.ets$/, '');
  return text.replace(/^\/+/, '');
}

/** 列出某棵源码树 pages 目录下的页面（不含扩展名，正斜杠）。 */
function listPages(treeRoot) {
  const pagesDir = join(treeRoot, 'pages');
  const result = [];
  walkFiles(pagesDir, (file) => file.endsWith('.ets'), result);
  return result
    .map((file) => toPosix(relative(treeRoot, file)).replace(/\.ets$/, ''))
    .sort();
}

function readPageProfile(file) {
  const doc = parseJson5(readText(file));
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.src)) {
    throw new Error('main_pages.json 必须形如 {"src": ["pages/Index", ...]}');
  }
  return doc.src.map(normalizePageEntry);
}

function rulePagesConsistent(root) {
  const messages = [];
  const mainProfileFile = join(root, 'entry/src/main/resources/base/profile/main_pages.json');
  const mainEts = join(root, TREES.main);
  const pagesOnDisk = listPages(mainEts);

  let declared = [];
  if (!existsSync(mainProfileFile)) {
    messages.push('缺少 entry/src/main/resources/base/profile/main_pages.json');
  } else {
    try {
      declared = readPageProfile(mainProfileFile);
    } catch (error) {
      messages.push(`main_pages.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
    for (const entry of declared) {
      if (tryResolveFile(join(mainEts, entry)) === null) {
        messages.push(`main_pages 声明了 ${entry}，但文件不存在：entry/src/main/ets/${entry}.ets`);
      }
    }
    for (const page of pagesOnDisk) {
      if (!declared.includes(page)) {
        messages.push(`页面未登记到 main_pages.json：${page}（entry/src/main/ets/${page}.ets）`);
      }
    }
  }

  const harmonyProfileFile = join(root, 'entry/src/harmony/resources/base/profile/main_pages.json');
  if (existsSync(harmonyProfileFile)) {
    let harmonyPages = [];
    try {
      harmonyPages = readPageProfile(harmonyProfileFile);
    } catch (error) {
      messages.push(
        `harmony 版 main_pages.json 无法解析：${error instanceof Error ? error.message : String(error)}`
      );
    }
    for (const entry of declared) {
      if (!harmonyPages.includes(entry)) {
        messages.push(`harmony 版 main_pages 缺少共享页面：${entry}（必须是共享清单的超集）`);
      }
    }
    for (const entry of harmonyPages) {
      const found =
        tryResolveFile(join(root, TREES.harmony, entry)) ?? tryResolveFile(join(root, TREES.main, entry));
      if (found === null) {
        messages.push(`harmony 版 main_pages 声明的页面不存在：${entry}`);
      }
    }
  }

  return { messages, declared: declared.length, onDisk: pagesOnDisk.length };
}

// ---------------------------------------------------------------- 规则 4

/** Android 侧（main + android）禁止出现的引用。 */
const FORBIDDEN_REFERENCES = [
  {
    pattern: /@ohos\.multimedia\.image|@kit\.ImageKit/,
    label: '图像识别模块（@ohos.multimedia.image / @kit.ImageKit）'
  },
  { pattern: /\bPixelMap\b/, label: 'PixelMap 截图' },
  { pattern: /\bOcrBatch[A-Za-z0-9_]*\b|\bOcrManager\b/, label: 'OcrBatch* 批量识别' },
  { pattern: /\bHandwriting[A-Za-z0-9_]*\b/, label: 'Handwriting* 手写组件' },
  {
    pattern: /['"][^'"]*(?:\/|\\)(?:ocr|handwriting)(?:\/|\\)[^'"]*['"]/,
    label: 'ocr/ 或 handwriting/ 目录'
  }
];

function ruleAndroidSafe(root, sourceFiles) {
  const messages = [];
  let scanned = 0;
  for (const file of sourceFiles) {
    const tree = treeOf(root, file);
    if (tree !== 'main' && tree !== 'android') {
      continue;
    }
    scanned++;
    const content = readCode(file);
    const shown = display(root, file);
    for (const rule of FORBIDDEN_REFERENCES) {
      if (rule.pattern.test(content)) {
        messages.push(`${shown} 引用了 ${rule.label}（Android 侧不可编译）`);
      }
    }
    for (const spec of extractImportSpecifiers(content)) {
      if (!spec.startsWith('.')) {
        continue;
      }
      const result = resolveRelativeImport(root, file, spec);
      if (result.ok && result.tree === 'harmony') {
        messages.push(`${shown} → '${spec}' 只在 harmony 覆盖层存在`);
      }
    }
  }
  return { messages, scanned };
}

// ---------------------------------------------------------------- 规则 5

function ruleCrossplatform(root, sourceFiles) {
  const messages = [];
  const structRe = /\bstruct\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\{/;
  let scanned = 0;
  for (const file of sourceFiles) {
    if (!file.endsWith('.ets')) {
      continue;
    }
    scanned++;
    const content = readCode(file);
    if (!structRe.test(content)) {
      continue;
    }
    if (!/@crossplatform\b/.test(content)) {
      messages.push(`${display(root, file)} 含 struct 但缺少 @crossplatform 注解`);
    }
  }
  return { messages, scanned };
}

// ---------------------------------------------------------------- 规则 6

function ruleRawfileGit(root) {
  const messages = [];
  const gitDir = join(root, 'entry/src/main/resources/rawfile/git');
  const isogit = join(gitDir, 'isomorphic-git.js');
  const bridge = join(gitDir, 'git-bridge.js');

  if (!isFile(isogit)) {
    messages.push('缺少 entry/src/main/resources/rawfile/git/isomorphic-git.js（必须真实下载 isomorphic-git@1.25.3）');
  } else {
    const size = fileSize(isogit);
    if (size < MIN_ISOMORPHIC_GIT_BYTES) {
      messages.push(`isomorphic-git.js 只有 ${size} 字节，小于 ${MIN_ISOMORPHIC_GIT_BYTES} 字节（疑似占位文件）`);
    }
  }

  if (!isFile(bridge)) {
    messages.push('缺少 entry/src/main/resources/rawfile/git/git-bridge.js');
  } else if (fileSize(bridge) === 0) {
    messages.push('git-bridge.js 是空文件');
  }

  const indexHtml = join(gitDir, 'index.html');
  if (isFile(indexHtml)) {
    const html = readText(indexHtml);
    const scriptRe = /<script[^>]+src=["']([^"']+)["']/g;
    let matched;
    let found = 0;
    while ((matched = scriptRe.exec(html)) !== null) {
      const src = matched[1];
      if (/^(?:https?:)?\/\//.test(src)) {
        continue; // 外链不在校验范围
      }
      found++;
      const target = resolve(gitDir, src.replace(/^\.\//, ''));
      if (!isFile(target)) {
        messages.push(`index.html 引用的脚本不存在：${src}`);
      }
    }
    if (found === 0 && !/isomorphic-git/.test(html)) {
      messages.push('index.html 没有引用任何本地脚本');
    }
  }

  const count = [isogit, bridge].filter((file) => isFile(file) && fileSize(file) > 0).length;
  return { messages, count };
}

// ---------------------------------------------------------------- 规则 7

const RESOURCE_REF_RE = /\$(media|string|color|profile|float|boolean|integer|plural|symbol):([A-Za-z0-9_.]+)/g;

/** 收集 AppScope 与 entry 资源目录里某类元素的 name 集合。 */
function collectElementNames(root, elementFileName) {
  const names = new Set();
  for (const resourceRoot of [join(root, 'AppScope/resources'), join(root, 'entry/src/main/resources')]) {
    const files = walkFiles(resourceRoot, (file) => basename(file) === elementFileName);
    for (const file of files) {
      try {
        const doc = parseJson5(readText(file));
        const key = elementFileName.replace(/\.json$/, '');
        const list = doc !== null && typeof doc === 'object' ? doc[key] : null;
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item !== null && typeof item === 'object' && typeof item.name === 'string') {
              names.add(item.name);
            }
          }
        }
      } catch {
        // 解析错误由规则 1 报告，这里只做引用存在性
      }
    }
  }
  return names;
}

/** 收集 media 资源名（按文件名去扩展名，任意 qualifier 目录）。 */
function collectMediaNames(root) {
  const names = new Set();
  for (const resourceRoot of [join(root, 'AppScope/resources'), join(root, 'entry/src/main/resources')]) {
    const files = walkFiles(resourceRoot, (file) => file.includes(`${sep}media${sep}`));
    for (const file of files) {
      names.add(basename(file).replace(/\.[^.]+$/, ''));
    }
  }
  return names;
}

function collectProfileNames(root) {
  const names = new Set();
  for (const resourceRoot of [join(root, 'AppScope/resources'), join(root, 'entry/src/main/resources')]) {
    const files = walkFiles(resourceRoot, (file) => file.includes(`${sep}profile${sep}`) && file.endsWith('.json'));
    for (const file of files) {
      names.add(basename(file).replace(/\.json$/, ''));
    }
  }
  return names;
}

function ruleModuleReferences(root) {
  const messages = [];
  const moduleFile = join(root, 'entry/src/main/module.json5');
  const moduleDir = join(root, 'entry/src/main');

  if (!isFile(moduleFile)) {
    return { messages: ['缺少 entry/src/main/module.json5'], refs: 0 };
  }

  let moduleDoc;
  try {
    moduleDoc = parseJson5(readText(moduleFile));
  } catch (error) {
    return {
      messages: [`module.json5 无法解析，跳过引用检查：${error instanceof Error ? error.message : String(error)}`],
      refs: 0
    };
  }
  const moduleBlock = moduleDoc !== null && typeof moduleDoc === 'object' ? moduleDoc.module : null;
  if (moduleBlock === null || typeof moduleBlock !== 'object') {
    return { messages: ['module.json5 缺少 module 对象'], refs: 0 };
  }

  // 7a. 页面 profile
  const pagesRef = typeof moduleBlock.pages === 'string' ? moduleBlock.pages : '';
  if (!pagesRef.startsWith('$profile:')) {
    messages.push(`module.pages 必须是 $profile:main_pages 形式，当前为 ${JSON.stringify(pagesRef)}`);
  } else {
    const profileName = pagesRef.slice('$profile:'.length);
    const profileFile = join(moduleDir, 'resources/base/profile', `${profileName}.json`);
    if (!isFile(profileFile)) {
      messages.push(`module.pages 引用的 profile 不存在：entry/src/main/resources/base/profile/${profileName}.json`);
    }
  }

  // 7b. abilities[].srcEntry 与 mainElement
  const abilities = Array.isArray(moduleBlock.abilities) ? moduleBlock.abilities : [];
  const abilityNames = [];
  for (const ability of abilities) {
    if (ability === null || typeof ability !== 'object') {
      continue;
    }
    if (typeof ability.name === 'string') {
      abilityNames.push(ability.name);
    }
    const srcEntry = typeof ability.srcEntry === 'string' ? ability.srcEntry : '';
    if (srcEntry.length === 0) {
      messages.push(`ability ${JSON.stringify(ability.name)} 缺少 srcEntry`);
      continue;
    }
    const entryFile = resolve(moduleDir, srcEntry);
    if (!isFile(entryFile)) {
      messages.push(`ability ${ability.name} 的 srcEntry 不存在：${display(root, entryFile)}`);
    }
  }
  if (typeof moduleBlock.mainElement === 'string' && abilityNames.length > 0) {
    if (!abilityNames.includes(moduleBlock.mainElement)) {
      messages.push(`module.mainElement=${moduleBlock.mainElement} 不在 abilities 列表中（${abilityNames.join(', ')}）`);
    }
  }

  // 7c. 资源引用存在性（module.json5 + AppScope/app.json5）
  const appFile = join(root, 'AppScope/app.json5');
  const mediaNames = collectMediaNames(root);
  const profileNames = collectProfileNames(root);
  const stringNames = collectElementNames(root, 'string.json');
  const colorNames = collectElementNames(root, 'color.json');

  let refCount = 0;
  for (const file of [moduleFile, appFile]) {
    if (!isFile(file)) {
      continue;
    }
    const content = readText(file);
    const seen = new Set();
    let matched;
    RESOURCE_REF_RE.lastIndex = 0;
    while ((matched = RESOURCE_REF_RE.exec(content)) !== null) {
      const kind = matched[1];
      const name = matched[2];
      const key = `${kind}:${name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refCount++;
      if (kind === 'media' && !mediaNames.has(name)) {
        messages.push(`${display(root, file)} 引用的 $media:${name} 在资源目录中不存在`);
      } else if (kind === 'string' && !stringNames.has(name)) {
        messages.push(`${display(root, file)} 引用的 $string:${name} 不在任何 string.json 中`);
      } else if (kind === 'color' && !colorNames.has(name)) {
        messages.push(`${display(root, file)} 引用的 $color:${name} 不在任何 color.json 中`);
      } else if (kind === 'profile' && !profileNames.has(name)) {
        messages.push(`${display(root, file)} 引用的 $profile:${name} 不存在`);
      }
    }
  }

  return { messages, refs: refCount };
}

// ---------------------------------------------------------------- 汇总

/**
 * 对给定工程根目录跑全部 7 条规则。
 * @param {string} [rootDir] 工程根目录（含 AppScope 与 entry）
 */
export function validateApp(rootDir = DEFAULT_ROOT) {
  const root = resolve(rootDir);
  const failures = [];
  const stats = {};

  const sourceFiles = collectSourceFiles(root);

  const runners = [
    [1, () => ruleJsonParsable(root)],
    [2, () => ruleImportsResolvable(root, sourceFiles)],
    [3, () => rulePagesConsistent(root)],
    [4, () => ruleAndroidSafe(root, sourceFiles)],
    [5, () => ruleCrossplatform(root, sourceFiles)],
    [6, () => ruleRawfileGit(root)],
    [7, () => ruleModuleReferences(root)]
  ];

  for (const [rule, runner] of runners) {
    try {
      const result = runner();
      stats[rule] = result;
      if (result.messages.length > 0) {
        failures.push({ rule, title: RULES[rule], messages: result.messages });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ rule, title: RULES[rule], messages: [`规则执行异常：${message}`] });
    }
  }

  return {
    root,
    ok: failures.length === 0,
    failures,
    stats
  };
}

function formatSummary(result) {
  const sourceCount = result.stats[2] === undefined ? 0 : result.stats[2].checked;
  const jsonCount = result.stats[1] === undefined ? 0 : result.stats[1].count;
  const pageCount = result.stats[3] === undefined ? 0 : result.stats[3].onDisk;
  const rawCount = result.stats[6] === undefined ? 0 : result.stats[6].count;
  return `JSON5/JSON ${jsonCount} 个、相对 import ${sourceCount} 条、页面 ${pageCount} 个、rawfile/git ${rawCount} 个文件`;
}

function printReport(result) {
  const lines = [];
  lines.push(`🔍 校验 ArkUI-X 工程：${result.root}`);
  for (const failure of result.failures) {
    lines.push(`❌ 规则 ${failure.rule} ${failure.title}`);
    for (const message of failure.messages) {
      lines.push(`   - ${message}`);
    }
  }
  if (result.ok) {
    lines.push(`✅ 全部通过：7/7 条规则（${formatSummary(result)}）`);
  } else {
    const problems = result.failures.reduce((sum, item) => sum + item.messages.length, 0);
    const passed = 7 - result.failures.length;
    lines.push('');
    lines.push(
      `❌ 共 ${result.failures.length} 条规则失败（${problems} 个问题），${passed}/7 条规则通过；明细见上方 ❌ 列表。`
    );
  }
  console.log(lines.join('\n'));
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--root 需要一个目录参数');
      }
      options.root = resolve(value);
      i++;
    } else if (arg.startsWith('--root=')) {
      options.root = resolve(arg.slice('--root='.length));
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`用法：node validate-app.mjs [--root <dir>] [--json]\n参数错误：${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log('用法：node validate-app.mjs [--root <dir>] [--json]');
    return 0;
  }
  if (!existsSync(options.root)) {
    console.error(`❌ 目录不存在：${options.root}`);
    return 2;
  }

  const result = validateApp(options.root);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = main();
}

export { RULES, DEFAULT_ROOT };
