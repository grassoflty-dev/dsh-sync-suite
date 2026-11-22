// mod-crash-settings-sync（P0：设置 → 同步仓库首开杀进程）：构建期 fs 安全的行为 + 形状守卫。
//
// 两层契约必须分开证明：
// - UI / 构建侧：safeList / issuesFromList 永不抛；ENOTDIR/ENOENT 是良性「无 issue」，
//   EACCES/I/O 是 typed warning（照实报，不吞成「没问题」）。
// - 桥侧：宿主不再同步抛，而是返回 typed 失败信封；git-bridge.js 的 fs adapter 必须把
//   ENOTDIR 变成 **rejected promise with code=ENOENT**，绝不能 resolve 成 []（谎报空仓库）。
//
// 行为断言（ behavioural ）用零 SDK 纯层 + 逐码注入的 fs seam；
// 静态断言（ static ）钉住 SettingsSync.build / SyncSection.build 可达的 fs.*Sync 调用点全部有守卫：
// S-3 是**逐个调用点**的结构检查（解析 try 块 / typed 包装的花括号范围），不是按方法名抽样；
// S-5 用注入证明模板插值内的调用也不会被 masker 漏掉。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  FS_ENOENT,
  FS_EACCES,
  FS_ENOTDIR,
  FS_FAILURE_MARKER,
  bridgeFailureEnvelope,
  bridgeFsCode,
  collectBuildIssues,
  fsErrorCode,
  isBenignFsCode,
  issuesFromList,
  safeList
} from '../.build/model/settingsBuildSafety.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..', '..');
const ETS = join(APP_ROOT, 'entry/src/main/ets');
const BRIDGE_PATH = join(APP_ROOT, 'entry/src/main/resources/rawfile/git/git-bridge.js');

const read = (relative) => readFileSync(join(ETS, relative), 'utf8');

/* ------------------------------------------------------------------ *\
 * 结构检查助手（评审修订版）：
 * - 字符串 / 注释 / 正则字面量 → 等长空格；
 * - **模板字面量只遮蔽文本段，`${…}` 内部按代码递归保留**（可嵌套），
 *   因此 `${fs.statSync('/x').size}` 里的调用一定会被枚举；
 * - 表达式位置的 `/…/flags` 当正则遮蔽，引号不会翻转字符串状态；
 * - 状态机未闭合（解析歧义）时 analysis 退回未遮蔽原文 —— 宁可多报，绝不漏报。
\* ------------------------------------------------------------------ */
function maskLiteralsAndComments(text) {
  const out = new Array(text.length).fill(' ');
  const stack = [{ kind: 'code', at: 0 }];
  const push = (kind, at, depth) => {
    const frame = { kind, at };
    if (depth !== undefined) { frame.depth = depth; }
    stack.push(frame);
  };
  const top = () => stack[stack.length - 1];
  const keep = (index) => { out[index] = text[index]; };
  const regexKeywords = ['return', 'typeof', 'case', 'delete', 'void', 'in', 'of', 'instanceof', 'new', 'yield', 'await'];
  const regexStart = (index) => {
    let cursor = index - 1;
    while (cursor >= 0 && /\s/.test(text[cursor])) { cursor -= 1; }
    if (cursor < 0) { return true; }
    if ('(=,:[!&|?{;+-*%^~<>'.includes(text[cursor])) { return true; }
    const word = /[A-Za-z_$]+$/.exec(text.slice(0, cursor + 1));
    return word !== null && regexKeywords.includes(word[0]);
  };
  let i = 0;
  while (i < text.length) {
    const context = top();
    const c = text[i];
    const n = text[i + 1];
    if (context.kind === 'line-comment') {
      if (c === '\n') { keep(i); stack.pop(); }
      i += 1; continue;
    }
    if (context.kind === 'block-comment') {
      if (c === '*' && n === '/') { i += 2; stack.pop(); continue; }
      i += 1; continue;
    }
    if (context.kind === "'" || context.kind === '"') {
      if (c === '\\') { i += 2; continue; }
      if (c === context.kind) { i += 1; stack.pop(); continue; }
      i += 1; continue;
    }
    if (context.kind === 'regex') {
      if (c === '\\') { i += 2; continue; }
      if (c === '/') {
        i += 1;
        while (i < text.length && /[a-zA-Z]/.test(text[i])) { i += 1; }
        stack.pop(); continue;
      }
      i += 1; continue;
    }
    if (context.kind === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i += 1; stack.pop(); continue; }
      if (c === '$' && n === '{') {
        keep(i); keep(i + 1);
        push('expr', i, 1);
        i += 2; continue;
      }
      i += 1; continue;
    }
    // code / expr：expr 只需额外数花括号深度，用来识别插值结束
    if (context.kind === 'expr') {
      if (c === '{') { context.depth += 1; keep(i); i += 1; continue; }
      if (c === '}') {
        context.depth -= 1;
        keep(i); i += 1;
        if (context.depth === 0) { stack.pop(); }
        continue;
      }
    }
    if (c === '/' && n === '/') { push('line-comment', i); i += 2; continue; }
    if (c === '/' && n === '*') { push('block-comment', i); i += 2; continue; }
    if (c === '/') {
      if (regexStart(i)) { push('regex', i); keep(i); i += 1; continue; }
      keep(i); i += 1; continue;
    }
    if (c === "'" || c === '"') { push(c, i); keep(i); i += 1; continue; }
    if (c === '`') { push('template', i); keep(i); i += 1; continue; }
    keep(i); i += 1;
  }
  const balanced = stack.length === 1 && stack[0].kind === 'code';
  return {
    masked: out.join(''),
    balanced,
    stackInfo: stack.map((item) => ({ kind: item.kind, line: text.slice(0, item.at).split('\n').length }))
  };
}

function matchingDelimiter(masked, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    if (masked[i] === openChar) { depth += 1; }
    if (masked[i] === closeChar) {
      depth -= 1;
      if (depth === 0) { return i; }
    }
  }
  return -1;
}

function tryBlockRanges(masked) {
  const ranges = [];
  const re = /\btry\s*\{/g;
  let match = re.exec(masked);
  while (match !== null) {
    const open = masked.indexOf('{', match.index);
    const close = matchingDelimiter(masked, open, '{', '}');
    if (close > open) { ranges.push([open, close]); }
    match = re.exec(masked);
  }
  return ranges;
}

function typedWrapperRanges(masked, names) {
  const ranges = [];
  for (const name of names) {
    const re = new RegExp('\\b' + name + '(?:<[^>]*>)?\\s*\\(', 'g');
    let match = re.exec(masked);
    while (match !== null) {
      const open = masked.indexOf('(', match.index);
      const close = matchingDelimiter(masked, open, '(', ')');
      if (close > open) { ranges.push([open, close]); }
      match = re.exec(masked);
    }
  }
  return ranges;
}

/** 单个来源的逐调用点分析；歧义时退回未遮蔽原文（false positive 可接受，false negative 不可）。 */
function analyzeFsSites(source) {
  const mask = maskLiteralsAndComments(source);
  const scan = mask.balanced ? mask.masked : source;
  const tryRanges = tryBlockRanges(scan);
  const wrapperRanges = typedWrapperRanges(scan, ['safeList', 'safeCall']);
  const sites = [];
  const re = /\bfs\.[A-Za-z]+Sync\s*\(/g;
  let match = re.exec(scan);
  while (match !== null) {
    const index = match.index;
    sites.push({
      index,
      line: source.slice(0, index).split('\n').length,
      call: match[0].replace(/\s*\($/, ''),
      inTry: tryRanges.some(([open, close]) => index > open && index < close),
      inWrapper: wrapperRanges.some(([open, close]) => index > open && index < close)
    });
    match = re.exec(scan);
  }
  return { sites, mask };
}

/** 逐码注入的 fs seam：只认指定 code，其余调用也抛（防止「只对该路径生效」的假绿）。 */
function throwingList(code, path) {
  return () => {
    const error = new Error(`${code}: not a usable directory -> ${path}`);
    error.code = code;
    throw error;
  };
}

/** 真机栈里的 ENOTDIR 是数值 errno 13900018；这里也注入一次，证明数值码也被认出。 */
function harmonyErrnoList(errno, path) {
  return () => {
    const error = new Error('Not a directory');
    error.code = errno;
    throw error;
  };
}

describe('构建期 fs 安全：行为断言（注入 ENOTDIR / ENOENT / EACCES seam）', () => {
  test('UI-1 直读非目录：safeList 返回 typed 失败，绝不 throw，且日志恰好一次（path + code）', () => {
    const path = '/data/app/git-repo/devices';
    const logged = [];
    const result = safeList(path, throwingList(FS_ENOTDIR, path), (p, code) => logged.push([p, code]));

    assert.equal(result.ok, false);
    assert.deepEqual(result.names, []);
    assert.equal(result.code, FS_ENOTDIR);
    assert.equal(result.path, path);
    assert.deepEqual(logged, [[path, FS_ENOTDIR]], '失败必须且只能记一次日志，且只含 path + code');
  });

  test('UI-2 真机 13900018 数值码也被归一为 ENOTDIR；ENOENT 单独注入同样安全', () => {
    const notDir = safeList('/repo/.git/refs', harmonyErrnoList(13900018, '/repo/.git/refs'));
    assert.equal(notDir.code, FS_ENOTDIR);
    assert.equal(notDir.ok, false);

    const missing = safeList('/repo/timeline/2026-11-23', throwingList(FS_ENOENT, '/repo/timeline/2026-11-23'));
    assert.equal(missing.code, FS_ENOENT);
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.names, []);
    assert.equal(isBenignFsCode(missing.code), true);
    assert.equal(fsErrorCode({ code: 13900002 }), FS_ENOENT);
  });

  test('UI-3 issue/warning 计算：ENOTDIR / ENOENT ⇒ 无 issue、无 throw；EACCES ⇒ 照实报 typed warning', () => {
    const benign = [FS_ENOTDIR, FS_ENOENT].map((code) =>
      issuesFromList(safeList('/repo/devices', throwingList(code, '/repo/devices')), '设备目录异常')
    );
    for (const issues of benign) {
      assert.deepEqual(issues, [], '缺目录 / 被文件挡住 = 没有 issue 可报，不是错误态');
    }

    const permission = issuesFromList(
      safeList('/repo/devices', throwingList(FS_EACCES, '/repo/devices')),
      '设备目录异常'
    );
    assert.equal(permission.length, 1, '权限失败必须 surfaced，不能被吞成良性');
    assert.match(permission[0], /EACCES/);
    assert.match(permission[0], /\/repo\/devices/);
  });

  test('UI-4 多路径汇总：坏目录不中断扫描，逐条保留 typed code', () => {
    const paths = ['/repo/devices', '/repo/attachments'];
    const outcome = collectBuildIssues(paths, throwingList(FS_ENOTDIR, paths[0]));
    assert.deepEqual(outcome.issues, []);
    assert.equal(outcome.results.length, 2);
    assert.deepEqual(outcome.results.map((item) => item.code), [FS_ENOTDIR, FS_ENOTDIR]);
  });

  test('BRIDGE-1 ENOTDIR 信封的 code 映射为 ENOENT，且绝不 resolved 成空数组', () => {
    const failed = safeList('/repo/.git/refs', throwingList(FS_ENOTDIR, '/repo/.git/refs'));
    const envelope = JSON.parse(bridgeFailureEnvelope(failed));
    assert.equal(envelope[FS_FAILURE_MARKER], true);
    assert.equal(envelope.code, FS_ENOENT, 'git 期望「目录不存在」= ENOENT');
    assert.equal(envelope.path, '/repo/.git/refs');
    assert.equal(bridgeFsCode(FS_EACCES), FS_EACCES, '权限失败不许被降码成良性');
    assert.notDeepEqual(envelope, [], '这是核心回归：resolved [] 会把 unborn .git 伪装成空仓库');
  });

  test('BRIDGE-2 真桥的 fs adapter：宿主返回失败信封 ⇒ rejected promise，code=ENOENT', async () => {
    const envelope = bridgeFailureEnvelope({
      ok: false,
      names: [],
      code: FS_ENOTDIR,
      path: '/repo/.git/refs'
    });
    const host = {
      getRepoRoot: () => '/repo',
      fileExists: () => false,
      readFileBase64: () => '',
      writeFileBase64: () => true,
      mkdirp: () => true,
      unlink: () => false,
      rename: () => true,
      readdir: () => envelope,
      stat: () => envelope,
      httpRequest: () => {},
      onEvent: () => {},
      onHttpResult: () => {}
    };
    globalThis.dshGitHost = host;
    delete globalThis.DshGitBridge;
    vm.runInThisContext(readFileSync(BRIDGE_PATH, 'utf8'), { filename: BRIDGE_PATH });

    const fsAdapter = globalThis.DshGitBridge.getInternalFs();
    const attempt = fsAdapter.readdir('/repo/.git/refs');
    assert.equal(typeof attempt.then, 'function', 'fs.readdir 必须返回 Promise，不能同步抛');
    await assert.rejects(
      attempt,
      (error) => {
        assert.equal(error.code, FS_ENOENT, 'git 只认 ENOENT 作为「目录不存在」');
        return true;
      },
      '必须是 rejected promise，绝不能 resolve 成 []'
    );
    delete globalThis.DshGitBridge;
  });
});

describe('构建期 fs 安全：静态断言（列出检查过的调用点）', () => {
  const syncPage = read('pages/SettingsSync.ets');
  const syncSection = read('components/settings/SyncSection.ets');
  const service = read('services/GitSyncService.ets');

  test('S-1 build 可达的页面 / 组件源码零 fs.*Sync 直接调用', () => {
    for (const [name, source] of [['SettingsSync.build', syncPage], ['SyncSection.build', syncSection]]) {
      assert.equal(
        /\bfs\.[A-Za-z]+Sync\s*\(/.test(source),
        false,
        `${name} 不得直接调用 fs.*Sync（必须在服务层归一成 typed 结果）`
      );
    }
    assert.match(syncPage, /this\.IssuesBanner\(\)/);
    assert.match(syncPage, /SyncSection\(\{/);
  });

  test('S-2 宿主代理的 readdir / stat / mkdirp 全经 typed 纯层，源码里没有裸抛调用', () => {
    const readdirBody = service.slice(service.indexOf('  readdir(path: string): string {'), service.indexOf('  /** UI / 构建侧目录列举'));
    assert.ok(readdirBody.includes('safeList('), 'readdir 必须经 safeList');
    assert.ok(readdirBody.includes('bridgeFailureEnvelope('), '失败必须返回桥失败信封');
    assert.equal(/\bfs\.listFileSync\(normalizePath\(/.test(readdirBody), false, '不再有裸 fs.listFileSync(normalizePath(...))');

    const statBody = service.slice(service.indexOf('  stat(path: string): string {'), service.indexOf('  unlink(path: string): boolean {'));
    assert.ok(statBody.includes('safeCall<fs.Stat>'), 'stat 必须经 safeCall');
    const statCalls = statBody.match(/\bfs\.statSync\(target\)/g) ?? [];
    assert.equal(statCalls.length, 1, 'stat 里只允许 safeCall 缝内那一处 fs.statSync');
    const statCallLine = statBody.split('\n').find((line) => line.includes('fs.statSync(target)'));
    assert.ok(statCallLine.includes('safeCall<fs.Stat>'), 'fs.statSync 必须出现在 safeCall 缝内，不能裸调');

    const mkdirpBody = service.slice(service.indexOf('  mkdirp(path: string): boolean {'), service.indexOf('  readdir(path: string): string {'));
    assert.ok(mkdirpBody.includes('safeCall<fs.Stat>') && mkdirpBody.includes('safeCall<void>'), 'mkdirp 的 stat 与 mkdir 都要走 typed 层');
    assert.equal(/\btry\s*\{/.test(mkdirpBody), false, 'mkdirp 不再靠散落的 try/catch');

    assert.match(service, /const listed: FsListResult = this\.readdirTyped\(dir\);/,
      '身份/遗留目录扫描必须走 typed 列举，不能假设目录存在');
  });

  test('S-3 逐调用点结构守卫：每个 fs.*Sync 调用都落在 try 块或 typed 包装内（附完整行数清单）', () => {
    const { sites, mask } = analyzeFsSites(service);
    assert.equal(mask.balanced, true,
      `源码词法状态必须闭合；歧义时守卫退回未遮蔽扫描：${JSON.stringify(mask.stackInfo)}`);

    // 完整清单随测试输出，便于评审核对「逐个调用点」而不是「按方法抽样」。
    console.log(`S-3 调用点清单（${sites.length} 处）：` +
      sites.map((site) => `${site.line}:${site.call}`).join(', '));
    assert.equal(sites.length, 24,
      `fs.*Sync 调用点数变化（期望 24，实际 ${sites.length}）——新增/删除都必须同步更新本守卫`);

    for (const site of sites) {
      assert.ok(site.inTry || site.inWrapper,
        `GitSyncService.ets:${site.line} 的 ${site.call} 在 try 块与 typed 包装之外，可把异常抛进 build 路径`);
    }
    // 正向证据：已修复的 writeFileBase64 openSync 确实落在 try 内（修复前在 try 之前）。
    const writeOpen = sites.find((site) =>
      site.call === 'fs.openSync' && service.slice(site.index, site.index + 220).includes('READ_WRITE'));
    assert.ok(writeOpen !== undefined && writeOpen.inTry,
      'writeFileBase64 的 openSync 必须在 try 内（评审 Major 的回归点）');
    // wrapper 名称必须来自唯一纯层 import，不允许本地伪造同名函数骗过结构检查。
    const importBlock = /import \{([^}]*)\} from '\.\.\/model\/settingsBuildSafety';/.exec(service);
    assert.ok(importBlock !== null, '必须存在来自 settingsBuildSafety 的唯一纯层 import');
    for (const name of ['safeList', 'safeCall']) {
      assert.ok(importBlock[1].includes(name), `${name} 必须来自纯层 import，不得本地伪造`);
    }
  });

  test('S-5 masker 注入回归：模板插值内 / 普通语句内的 fs 调用都必须被枚举且判为未守卫', () => {
    const baseline = analyzeFsSites(service);
    assert.equal(baseline.mask.balanced, true);
    assert.equal(baseline.sites.length, 24, '当前文件的调用点数在插值保真遮蔽下仍是 24');

    const lines = service.split('\n');
    const anchor = lines.findIndex((line) => line.includes('宿主代理：文件系统（同步）'));
    assert.ok(anchor >= 0, '注入锚点丢失，S-5 需更新');
    const injectedLine = anchor + 2;

    const cases = [
      { name: '模板插值', snippet: "    const probe = `${fs.statSync('/x').size}`;" },
      { name: '普通语句', snippet: "    fs.statSync('/x');" }
    ];
    for (const { name, snippet } of cases) {
      const mutated = lines.slice();
      mutated.splice(anchor + 1, 0, snippet);
      const result = analyzeFsSites(mutated.join('\n'));
      assert.equal(result.sites.length, baseline.sites.length + 1,
        `${name}：注入后必须多枚举出一个 fs.*Sync 调用点`);
      const injected = result.sites.find((site) => site.line === injectedLine);
      assert.ok(injected !== undefined, `${name}：注入的调用点必须出现在清单里`);
      assert.equal(injected.inTry || injected.inWrapper, false,
        `${name}：注入的调用必须被判为未守卫，否则说明 masker 漏掉或误判了覆盖范围`);
    }
  });

  test('S-4 hilog 只在独立出口，服务与设置页源码保持零日志字面量', () => {
    assert.equal(/hilog\./.test(service), false, '服务层仍禁止 hilog 字面量（credentialHygiene 契约）');
    assert.equal(/hilog\./.test(syncPage), false);
    assert.equal(/hilog\./.test(syncSection), false);
    const logSource = read('common/fsSafetyLog.ets');
    assert.match(logSource, /hilog\.error\(/);
    assert.match(logSource, /path=%\{public\}s code=%\{public\}s/, '日志只允许 path + code 两个字段');
  });
});
