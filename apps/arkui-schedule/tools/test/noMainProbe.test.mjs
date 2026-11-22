// mod-p0a-no-main-probe：空仓库首跑探测回归（桥决策层 + 源码形状）。
//
// 设备证据（安装版 1000006，persisted prefs）：
//   lastSyncError = 同步失败：未知错误：…原始信息：同步失败：远端仓库为空，或分支/引用不存在：
//                   Could not find main.（已隔离未完成的本地仓库 .git.clone-failed-1795323540282…）
//   git_sync_status.reason = 远端仓库为空，或分支/引用不存在：Could not find origin/main.
// 根因：探测未产生「确定为空」结论就 fallthrough 到 git.clone({ref:'main'})，空仓库必然抛
// 「Could not find main」并隔离半成品。本文件用 shaped refs 钉死「先决策、后落地」：
//   [] → init/bootstrap，绝不 clone；['master'] → typed 且点名 master，绝不 clone / 建引用；
//   ['main'] → 允许普通 clone；probe 抛错 → typed 未定，绝不 clone；陈旧隔离目录不影响 init。
//
// 这些是**纯 / 桥等价层**测试；真实 Gitee 空仓库的端到端证明须在 1000007 装机后做。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('noMainProbe.test.mjs');

const { classifySyncError } = await import('../.build/model/syncError.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', '..');
const BRIDGE_PATH = join(APP, 'entry/src/main/resources/rawfile/git/git-bridge.js');
const BRIDGE_SRC = readFileSync(BRIDGE_PATH, 'utf8');
const MODEL_SRC = readFileSync(join(APP, 'entry/src/main/ets/model/syncCycle.ts'), 'utf8');
const ERROR_SRC = readFileSync(join(APP, 'entry/src/main/ets/model/syncError.ts'), 'utf8');
const PAGE_SRC = readFileSync(join(APP, 'entry/src/main/ets/pages/SettingsSync.ets'), 'utf8');
const SERVICE_SRC = readFileSync(join(APP, 'entry/src/main/ets/services/GitSyncService.ets'), 'utf8');

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

/** 假宿主：只提供文件代理；httpRequest 若被调用即视为错误（决策阶段不该联网建仓）。 */
function fakeHost(repoRoot) {
  return {
    readFileBase64(path) {
      try { return readFileSync(path).toString('base64'); } catch { return ''; }
    },
    writeFileBase64() { return true; },
    fileExists(path) { return existsSync(path); },
    mkdirp(path) { mkdirSync(path, { recursive: true }); return true; },
    readdir(path) { return JSON.stringify(readdirSync(path)); },
    stat() { return JSON.stringify({ mode: 0, size: 0, mtimeMs: 0, type: 'dir' }); },
    unlink() { return false; },
    rename() { return false; },
    getRepoRoot() { return repoRoot.replace(/\\/g, '/'); },
    httpRequest() { throw new Error('本用例不应发起 HTTP 请求'); },
    onEvent() { /* 决策层直调 internals，无事件回传 */ }
  };
}

/** 每次加载得到独立桥会话；把 global.git 换成可计数的假 git 驱动决策层。 */
function loadBridge(host, fakeGit) {
  globalThis.dshGitHost = host;
  delete globalThis.DshGitBridge;
  const realGit = globalThis.git;
  vm.runInThisContext(BRIDGE_SRC, { filename: BRIDGE_PATH });
  const bridge = globalThis.DshGitBridge;
  assert.ok(bridge && bridge.internals, '桥必须暴露 internals 供决策层单测');
  globalThis.git = fakeGit;
  return { bridge, restore: () => { globalThis.git = realGit; } };
}

function makeFakeGit(serverRefs, opts = {}) {
  const calls = { clone: 0, init: 0, listServerRefs: 0, getRemoteInfo: 0 };
  const oid = 'a'.repeat(40);
  return {
    calls,
    clone: async () => { calls.clone += 1; return {}; },
    init: async ({ dir, defaultBranch }) => {
      calls.init += 1;
      mkdirSync(join(dir, '.git'), { recursive: true });
      return { defaultBranch };
    },
    listServerRefs: async () => {
      calls.listServerRefs += 1;
      if (opts.probeThrows) { throw new Error(opts.probeThrows); }
      return serverRefs;
    },
    getRemoteInfo: async () => {
      calls.getRemoteInfo += 1;
      if (opts.infoThrows) { throw new Error(opts.infoThrows); }
      return { refs: { heads: {}, tags: {}, pull: {} } };
    },
    getConfig: async () => { throw new Error('no remote yet'); },
    addRemote: async () => { return {}; },
    currentBranch: async () => 'main',
    resolveRef: async () => oid
  };
}

const ARGS = {
  autoInit: 'true', repoUrl: 'https://gitee.com/example/empty.git',
  branch: 'main', deviceId: 'phone-a', op: 'fetch'
};

function freshRepo(quarantineDirs = []) {
  const work = mkdtempSync(join(tmpdir(), 'dsh-p0a-probe-'));
  tempDirs.push(work);
  const root = join(work, 'git-repo');
  mkdirSync(root, { recursive: true });
  for (const name of quarantineDirs) {
    mkdirSync(join(root, name), { recursive: true });
  }
  return root;
}

function quarantineNames(root) {
  return readdirSync(root).filter((name) => name.indexOf('.git.clone-failed-') === 0);
}

// ------------------------------------------------------------------ 纯 shaped fixtures

test('P1 纯判定：空数组 / master / main 三类 shaped refs 的逐字返回值', () => {
  const { bridge, restore } = loadBridge(fakeHost(freshRepo()), makeFakeGit([]));
  try {
    const internals = bridge.internals;
    assert.deepEqual(internals.serverRefHeadNames([]), []);
    assert.deepEqual(internals.serverRefDisplayNames([]), []);
    assert.deepEqual(
      internals.serverRefHeadNames([{ ref: 'refs/heads/master', oid: 'a'.repeat(40) }]), ['master']);
    assert.deepEqual(
      internals.serverRefDisplayNames([
        { ref: 'refs/heads/master', oid: 'a'.repeat(40) },
        { ref: 'refs/tags/v1', oid: 'b'.repeat(40) }
      ]), ['master', 'tags/v1']);
    assert.deepEqual(internals.serverRefHeadNames([{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }]), ['main']);
    // 旧嵌套谓词仍是 true（空对象两种形状），但它已不参与决策。
    assert.equal(internals.remoteHasNoRefs({ refs: { heads: {}, tags: {}, pull: {} } }), true);
    assert.equal(internals.remoteHasNoRefs({}), true);
    assert.equal(internals.remoteHasNoRefs({ refs: { heads: { master: 'a'.repeat(40) } } }), false);
    // 隔离目录识别：只认前缀，且不参与 repoInitialized 判定。
    assert.equal(internals.isCloneQuarantineDir('.git.clone-failed-1795323540282'), true);
    assert.equal(internals.isCloneQuarantineDir('.git'), false);
    assert.equal(internals.cloneQuarantinePrefix, '.git.clone-failed-');
  } finally {
    restore();
  }
});

// ------------------------------------------------------------------ 决策层（假 git，无网络）

test('P2 refs=[] ⇒ 空远端：init/bootstrap，git.clone 从未调用，且不建隔离目录', async () => {
  const root = freshRepo();
  const fake = makeFakeGit([]);
  const { bridge, restore } = loadBridge(fakeHost(root), fake);
  try {
    const result = await bridge.internals.ensureRepoInitialised(ARGS);
    assert.equal(result.emptyRemote, true);
    assert.equal(result.cloned, false);
    assert.equal(fake.calls.listServerRefs, 1);
    assert.equal(fake.calls.init, 1);
    assert.equal(fake.calls.clone, 0, '空远端绝不 clone——这是本模块要修的根因');
    assert.equal(bridge.internals.repoInitializedOf(), true);
    assert.deepEqual(quarantineNames(root), []);
  } finally {
    restore();
  }
});

test('P3 refs=[master] ⇒ typed 点名 master；无 clone / 无 init / 无建引用 / 无隔离目录', async () => {
  const root = freshRepo();
  const fake = makeFakeGit([{ ref: 'refs/heads/master', oid: 'a'.repeat(40) }]);
  const { bridge, restore } = loadBridge(fakeHost(root), fake);
  try {
    let error;
    await assert.rejects(() => bridge.internals.ensureRepoInitialised(ARGS), (e) => { error = e; return true; });
    assert.equal(error.code, 'E_GIT');
    assert.match(error.message, /master/);
    assert.match(error.message, /缺少 main/);
    assert.equal(error.message.includes('远端仓库为空'), false, '非空仓库绝不能说成空仓库');
    assert.equal(error.message.includes('原始信息：'), false);
    assert.equal(fake.calls.clone, 0, '非空无 main 绝不 clone');
    assert.equal(fake.calls.init, 0, '非空无 main 绝不建本地仓库');
    assert.deepEqual(quarantineNames(root), []);
  } finally {
    restore();
  }
});

test('P4 refs=[main] ⇒ 普通首次 clone 保持原样', async () => {
  const root = freshRepo();
  const fake = makeFakeGit([{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }]);
  const { bridge, restore } = loadBridge(fakeHost(root), fake);
  try {
    const result = await bridge.internals.ensureRepoInitialised(ARGS);
    assert.equal(result.cloned, true);
    assert.equal(fake.calls.clone, 1, 'main 存在时普通 clone 不变');
  } finally {
    restore();
  }
});

test('P5 探测抛错 ⇒ typed「无法确认远端状态」，绝不 clone（fail-closed）', async () => {
  const root = freshRepo();
  const fake = makeFakeGit([], { probeThrows: 'E_AUTH: token rejected' });
  const { bridge, restore } = loadBridge(fakeHost(root), fake);
  try {
    let error;
    await assert.rejects(() => bridge.internals.ensureRepoInitialised(ARGS), (e) => { error = e; return true; });
    assert.equal(error.code, 'E_GIT');
    assert.match(error.message, /无法确认远端状态/);
    assert.match(error.message, /E_AUTH: token rejected/, '底层原文必须保留（脱敏后）');
    assert.match(error.message, /不会克隆/);
    assert.equal(fake.calls.clone, 0, '探测失败绝不 fallthrough 到 clone');
    assert.equal(fake.calls.init, 0);
    assert.deepEqual(quarantineNames(root), []);
  } finally {
    restore();
  }
});

test('P6 陈旧 .git.clone-failed-* 在场 ⇒ 下一次同步仍走 init，无需卸载 / 清数据', async () => {
  const stale = '.git.clone-failed-1795323540282';
  const root = freshRepo([stale]);
  const fake = makeFakeGit([]);
  const { bridge, restore } = loadBridge(fakeHost(root), fake);
  try {
    assert.equal(bridge.internals.repoInitializedOf(), false, '隔离目录不得被误判为已初始化');
    const result = await bridge.internals.ensureRepoInitialised(ARGS);
    assert.equal(result.emptyRemote, true);
    assert.equal(fake.calls.clone, 0);
    assert.equal(fake.calls.init, 1);
    assert.equal(bridge.internals.repoInitializedOf(), true);
    assert.ok(existsSync(join(root, stale)), '陈旧隔离目录被忽略而非依赖其存在');
  } finally {
    restore();
  }
});

test('P7 remoteLayout 的 isEmpty 来自原始数组：空 / master / main 三种输出', async () => {
  const cases = [
    { refs: [], hasMain: false, isEmpty: true, names: [] },
    { refs: [{ ref: 'refs/heads/master', oid: 'a'.repeat(40) }], hasMain: false, isEmpty: false, names: ['master'] },
    { refs: [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }], hasMain: true, isEmpty: false, names: ['main'] }
  ];
  for (const one of cases) {
    const root = freshRepo();
    const fake = makeFakeGit(one.refs);
    const { bridge, restore } = loadBridge(fakeHost(root), fake);
    try {
      const config = { repoUrl: ARGS.repoUrl, branch: 'main', url: ARGS.repoUrl };
      const probe = await bridge.internals.probeRemoteRefs(fake, config, ARGS.repoUrl);
      assert.equal(probe.empty, one.isEmpty);
      assert.deepEqual(probe.heads, one.names);
      assert.deepEqual(probe.names, one.names);
      assert.equal(fake.calls.clone, 0);
    } finally {
      restore();
    }
  }
});

test('P8 byte-level: 真实 isomorphic-git 1.25.3 listServerRefs 读空 advertisement ⇒ []', async () => {
  // 不是 fake：直接加载仓库内 vendored UMD，用 pkt-line 字节伪造服务端 advertisement。
  const { createRequire } = await import('node:module');
  const nodeRequire = createRequire(import.meta.url);
  const isoPath = join(APP, 'entry/src/main/resources/rawfile/git/isomorphic-git.js');
  const savedSelf = globalThis.self;
  const savedGit = globalThis.git;
  globalThis.self = globalThis;
  try {
    nodeRequire(isoPath);
    const realGit = globalThis.git;
    assert.equal(realGit.version(), '1.25.3');
    const pkt = (text) => {
      const body = Buffer.from(text, 'utf8');
      return Buffer.concat([
        Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body
      ]);
    };
    const discovery = Buffer.concat([
      pkt('# service=git-upload-pack\n'), Buffer.from('0000', 'ascii'),
      pkt('version 2\n'), Buffer.from('0000', 'ascii')
    ]);
    const makeHttp = (lsRefsBytes) => ({
      request: async ({ url, method }) => {
        const isPost = String(method || 'GET').toUpperCase() === 'POST';
        const payload = isPost ? lsRefsBytes : discovery;
        return {
          url: url, method: String(method || 'GET'), headers: {},
          statusCode: 200, statusMessage: 'OK',
          body: (async function* () { yield new Uint8Array(payload); })()
        };
      }
    });
    // 空仓库：ls-refs 只回 flush pkt（0000）⇒ 原始引用数组为空。
    const emptyRefs = await realGit.listServerRefs({
      http: makeHttp(Buffer.from('0000', 'ascii')), url: 'https://example.invalid/empty.git'
    });
    assert.ok(Array.isArray(emptyRefs));
    assert.equal(emptyRefs.length, 0, '空 advertisement 的原始引用数组必须是 []');
    const { bridge, restore } = loadBridge(fakeHost(freshRepo()), makeFakeGit(emptyRefs));
    try {
      assert.equal(bridge.internals.serverRefHeadNames(emptyRefs).length, 0);
      assert.equal(bridge.internals.remoteHasNoRefs({ refs: { heads: {}, tags: {}, pull: {} } }), true);
      const probe = await bridge.internals.probeRemoteRefs(makeFakeGit(emptyRefs),
        { repoUrl: 'https://example.invalid/empty.git' }, 'https://example.invalid/empty.git');
      assert.equal(probe.empty, true, '真实空数组必须被判为空仓库首跑态');
    } finally {
      restore();
    }
    // 对照：同样字节里加一条 master ref ⇒ 数组含 refs/heads/master，走 no-main 分类。
    const sha = 'a'.repeat(40);
    const withMaster = Buffer.concat([
      pkt(`${sha} refs/heads/master\n`), Buffer.from('0000', 'ascii')
    ]);
    const masterRefs = await realGit.listServerRefs({
      http: makeHttp(withMaster), url: 'https://example.invalid/nonempty.git'
    });
    assert.equal(masterRefs.length, 1);
    assert.equal(masterRefs[0].ref, 'refs/heads/master');
    assert.equal(masterRefs[0].oid, sha);
    const { bridge: b2, restore: r2 } = loadBridge(fakeHost(freshRepo()), makeFakeGit(masterRefs));
    try {
      assert.deepEqual(b2.internals.serverRefHeadNames(masterRefs), ['master']);
      const probe2 = await b2.internals.probeRemoteRefs(makeFakeGit(masterRefs),
        { repoUrl: 'https://example.invalid/nonempty.git' }, 'https://example.invalid/nonempty.git');
      assert.equal(probe2.empty, false);
      assert.deepEqual(probe2.heads, ['master']);
    } finally {
      r2();
    }
  } finally {
    globalThis.self = savedSelf;
    globalThis.git = savedGit;
  }
});

// ------------------------------------------------------------------ 真实 OP_HANDLERS.clone（App 入口）

/**
 * 直接调用 OP_HANDLERS.clone —— 门面 GitSyncService.ensureRepoInitialised() 的 `callBridge('clone')`
 * 最终落到的就是这个函数。上一版只测 internals.ensureRepoInitialised / opV2Git，漏掉了这个入口。
 */
async function callCloneHandler(root, serverRefs, opts = {}) {
  const fake = makeFakeGit(serverRefs, opts);
  const { bridge, restore } = loadBridge(fakeHost(root), fake);
  try {
    let result = null;
    let error = null;
    try {
      result = await bridge.internals.opHandlers.clone(ARGS);
    } catch (e) {
      error = e;
    }
    return { result, error, fake, bridge };
  } finally {
    restore();
  }
}

test('H1 OP_HANDLERS.clone + refs=[] ⇒ 首跑 init，git.clone 从未调用，无隔离目录', async () => {
  const root = freshRepo();
  const out = await callCloneHandler(root, []);
  assert.equal(out.error, null, `不应失败：${out.error && out.error.message}`);
  assert.equal(out.result.emptyRemote, true);
  assert.equal(out.result.cloned, false);
  assert.match(out.result.message, /首次同步的正常起点/, '首跑文案，不是失败');
  assert.equal(out.fake.calls.listServerRefs, 1);
  assert.equal(out.fake.calls.init, 1);
  assert.equal(out.fake.calls.clone, 0, 'App 入口的空远端绝不能 clone');
  assert.deepEqual(quarantineNames(root), []);
});

test('H2 OP_HANDLERS.clone + refs=[master] ⇒ typed 点名 master，无 clone / 无 init', async () => {
  const root = freshRepo();
  const out = await callCloneHandler(root, [{ ref: 'refs/heads/master', oid: 'a'.repeat(40) }]);
  assert.ok(out.error, '必须 typed 失败');
  assert.equal(out.error.code, 'E_GIT');
  assert.match(out.error.message, /master/);
  assert.match(out.error.message, /缺少 main/);
  assert.equal(out.error.message.includes('原始信息：'), false);
  assert.equal(out.fake.calls.clone, 0);
  assert.equal(out.fake.calls.init, 0);
  assert.deepEqual(quarantineNames(root), []);
});

test('H3 OP_HANDLERS.clone + refs=[main] ⇒ 恰好 clone 一次（普通路径不变）', async () => {
  const root = freshRepo();
  const out = await callCloneHandler(root, [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }]);
  assert.equal(out.error, null, `不应失败：${out.error && out.error.message}`);
  assert.equal(out.result.cloned, true);
  assert.equal(out.fake.calls.clone, 1);
});

test('H4 OP_HANDLERS.clone + probe throw ⇒ typed 未定，clone 从未调用', async () => {
  const root = freshRepo();
  const out = await callCloneHandler(root, [], { probeThrows: 'E_AUTH: token rejected' });
  assert.ok(out.error);
  assert.match(out.error.message, /无法确认远端状态/);
  assert.match(out.error.message, /E_AUTH: token rejected/);
  assert.equal(out.fake.calls.clone, 0);
  assert.equal(out.fake.calls.init, 0);
  assert.deepEqual(quarantineNames(root), []);
});

// ------------------------------------------------------------------ 源码形状守卫

function bodyOf(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `${marker} not found`);
  const start = source.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces after ${marker}`);
}

test('S1 源码形状：空分支没有 git.clone；探测失败不 fallthrough；无 adopt / 建引用', () => {
  const ensure = bodyOf(BRIDGE_SRC, 'async function ensureRepoInitialised(args)');
  const emptyBranch = ensure.slice(ensure.indexOf('if (probe.empty)'));
  assert.match(emptyBranch, /git\.init\(/, '空远端走 init');
  assert.doesNotMatch(emptyBranch, /git\.clone\(/, '空分支绝不能有 clone 调用');
  assert.doesNotMatch(ensure, /probeRemoteRefs[\s\S]*catch[\s\S]*opClone/,
    '探测异常绝不能落回 clone');
  assert.match(BRIDGE_SRC, /git\.listServerRefs\(/, '判空必须走 listServerRefs');
  // B1：真正的 OP_HANDLERS.clone 入口也必须 probe-before-clone（门面就走它）。
  const opClone = bodyOf(BRIDGE_SRC, 'async function opClone(args, skipProbe)');
  const cloneAt = opClone.indexOf('git.clone(');
  const probeAt = opClone.indexOf('probeRemoteRefs(git, config, url)');
  assert.ok(probeAt > 0 && cloneAt > probeAt, 'opClone 的探测必须在 git.clone 之前');
  const probeBranch = opClone.slice(probeAt, cloneAt);
  assert.match(probeBranch, /git\.init\(/, '空远端分支走 init');
  assert.doesNotMatch(probeBranch, /quarantineBrokenRepo/, '首跑决策不建隔离目录');
  assert.equal((BRIDGE_SRC.match(/await opClone\(args, true\);/g) || []).length, 2,
    '两处上游已决策调用必须显式跳过二次探测');
  // 已撤回的 adopt 通道不得复活：本模块任何文件的**可执行源码**都不许创建 / 删除引用或强制改写。
  for (const [name, src] of [
    ['bridge-opClone-decision', stripComments(probeBranch)],
    ['bridge-empty-decision', stripComments(ensure)],
    ['bridge-remoteLayout', stripComments(bodyOf(BRIDGE_SRC, "if (op === 'remoteLayout')"))],
    ['model-syncCycle', stripComments(MODEL_SRC)],
    ['model-syncError', stripComments(ERROR_SRC)],
    ['page-SettingsSync', stripComments(PAGE_SRC)],
    ['service-GitSyncService', stripComments(SERVICE_SRC)]
  ]) {
    // 精确指向已撤回的「以远端分支建 main」通道；`adoptRepoFingerprint` 是无关的既有设备身份 API。
    for (const banned of [
      /adopt(Branch|Main|Remote|AsMain|MainFrom)/i, /createMainFrom/, /创建 main/,
      /createRef\s*\(/, /branch\s+-D/, /--force/, /\brebase\b/, /git\.push\s+--force/
    ]) {
      assert.doesNotMatch(src, banned, `${name} 不得出现 ${banned}`);
    }
  }
  assert.doesNotMatch(stripComments(MODEL_SRC), /writeRef\s*\(/, '纯模型绝不建引用');
});

test('S2 用户文案：known typed 错不套「未知错误…原始信息」，非空不误报空', () => {
  for (const message of [
    '同步失败：远端仓库为空，或分支/引用不存在：Could not find main.（已隔离未完成的本地仓库 .git.clone-failed-1795323540282）',
    'E_GIT: 远端已有分支：master；缺少 main。远端并非空仓库。'
  ]) {
    const info = classifySyncError('E_GIT', message);
    assert.equal(info.kind, 'no-main');
    assert.equal(info.level, 'fatal');
    assert.equal(info.detail.includes('未知错误'), false);
    assert.equal(info.detail.includes('原始信息：'), false);
  }
  const undecided = classifySyncError('E_GIT', '无法确认远端状态（探测失败）：E_AUTH: token rejected；下一步：重试');
  assert.equal(undecided.kind, 'remote-indeterminate');
  assert.equal(undecided.level, 'retry');
  assert.equal(undecided.retryable, true);
});

test('S3 facade: GitSyncService 仍走唯一被守卫的 clone 入口，且必然带 autoInit', () => {
  // 源码形状断言（.ets 不在 Node 编译范围）：门面不绕过 opClone 自建第二条 clone 路径。
  const facade = bodyOf(SERVICE_SRC, 'async ensureRepoInitialised(): Promise<GitSyncResult>');
  assert.match(facade, /this\.callBridge\('clone', this\.configArgs\(\)\)/,
    '门面必须经 OP_HANDLERS.clone（opClone 已在桥内 probe-before-clone）');
  assert.doesNotMatch(facade, /v2Git\('clone'|opClone|git\.clone/,
    '门面不得自带克隆实现或第二入口');
  const configArgs = bodyOf(SERVICE_SRC, 'private configArgs(): Record<string, string>');
  assert.match(configArgs, /'autoInit': 'true'/, 'configArgs 必须打开桥内探测守卫');
  // App 的三个用户入口都经该门面；不另起裸 clone。
  const page = PAGE_SRC;
  assert.match(page, /this\.sync\.ensureRepoInitialised\(\)/, '测试连接经门面');
  assert.equal((SERVICE_SRC.match(/this\.callBridge\('clone'/g) || []).length, 1,
    '整个服务只允许一处裸 clone 桥调用，且已被 opClone 守卫');
});
