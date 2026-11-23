#!/usr/bin/env node
/**
 * mod-tablet-git-bridge-diagnostics：Web 桥 "Cannot read properties of undefined (reading 'length')" 诊断回归。
 *
 * 1. 真机症状复现：裸远端 + 两 clones，远端领先 3 提交、平板 11 处未提交改动；
 *    驱动 v2 周期同款薄桥命令，证明修复前 fastForward 必抛 V8 TypeError（irect git.merge({oid}) 复现），
 *    修复后 fastForward typed 成功；
 * 2. E_BRIDGE 边界：强制桥命令内部抛原始 TypeError，事件必须是 {ok:false, code:'E_BRIDGE', message, stack}，
 *    call 本身绝不把异常抛回 ArkTS；
 * 3. 护栏纯函数：asArray / shasFromLog / changedFromStatusMatrix / daysFromListFiles /
 *    pathsFromJson / commitsToReports 对 undefined / null / 错型输入全部零抛出；
 * 4. ArkTS 映射源码级：E_BRIDGE → 固定中文；原始 message 只进诊断行，stack 从不上屏。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..');
const GIT_DIR = join(APP_ROOT, 'entry/src/main/resources/rawfile/git');
const ISO_PATH = join(GIT_DIR, 'isomorphic-git.js');
const BRIDGE_PATH = join(GIT_DIR, 'git-bridge.js');
const SERVICE_PATH = join(APP_ROOT, 'entry/src/main/ets/services/GitSyncService.ets');
const BRIDGE_SOURCE = readFileSync(BRIDGE_PATH, 'utf8');
const SERVICE_SOURCE = readFileSync(SERVICE_PATH, 'utf8');
const nodeRequire = createRequire(import.meta.url);

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(REPO_ROOT, '.tmp', prefix));
  tempDirs.push(dir);
  return dir;
}
function g(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const GIT_ID = ['-c', 'user.name=Diagnostics', '-c', 'user.email=diag@localhost'];

/** 远端领先 3 提交 + 平板 11 处未提交改动的仓库组。 */
function makeFixture() {
  const work = makeTempDir('gitbridge-diag-');
  const remote = join(work, 'remote.git');
  const tablet = join(work, 'tablet');
  const other = join(work, 'other');
  g(['init', '-b', 'main', '--bare', remote], work);
  const seed = join(work, 'seed');
  g(['init', '-b', 'main', seed], work);
  writeFileSync(join(seed, 'seed.txt'), 'seed\n');
  g(['add', '-A'], seed);
  g([...GIT_ID, 'commit', '-m', 'seed'], seed);
  g(['remote', 'add', 'origin', remote], seed);
  g(['push', 'origin', 'main'], seed);
  g(['clone', '-b', 'main', remote, tablet], work);
  g(['clone', '-b', 'main', remote, other], work);
  mkdirSync(join(tablet, 'timeline'), { recursive: true });
  writeFileSync(join(tablet, 'timeline/schema.json'), '{"schemaVersion":2}\n');
  mkdirSync(join(tablet, 'timeline/2026-11-20'), { recursive: true });
  writeFileSync(join(tablet, 'timeline/2026-11-20/records.json'), '[]\n');
  g(['add', '-A'], tablet);
  g([...GIT_ID, 'commit', '-m', '[v2] bootstrap main'], tablet);
  g(['push', 'origin', 'main'], tablet);
  g(['pull', 'origin', 'main'], other);
  for (let i = 1; i <= 3; i++) {
    const day = join(other, 'timeline', `2026-11-2${i}`);
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'records.json'), `{"id":"remote-${i}"}\n`);
    g(['add', '-A'], other);
    g([...GIT_ID, 'commit', '-m', `[v2] remote ${i}`], other);
  }
  g(['push', 'origin', 'main'], other);
  const localPaths = [];
  for (let i = 1; i <= 11; i++) {
    const day = join(tablet, 'timeline', `2026-11-1${i % 10}`);
    mkdirSync(day, { recursive: true });
    const rel = `timeline/2026-11-1${i % 10}/local-${i}.json`;
    writeFileSync(join(tablet, rel), `{"id":"local-${i}"}\n`);
    localPaths.push(rel);
  }
  // 桥的 fetch 走 HTTP；单测用系统 git 只更新 origin/main 跟踪引用，后续薄桥读取同一仓库。
  g(['fetch', 'origin', 'main'], tablet);
  return { tablet, localPaths, head: g(['rev-parse', 'HEAD'], tablet).trim(), origin: g(['rev-parse', 'origin/main'], tablet).trim() };
}

/** 与 GitSyncService 行为一致的同步宿主假实现（HTTP 返回 404，本套不验证传输）。 */
function createHost(repoRoot) {
  const waiters = new Map();
  let seq = 0;
  const host = {
    getRepoRoot: () => repoRoot.replace(/\\/g, '/'),
    fileExists: (p) => existsSync(p),
    readFileBase64: (p) => { try { return readFileSync(p).toString('base64'); } catch { return ''; } },
    writeFileBase64: (p, base64) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(base64, 'base64')); return true; },
    mkdirp: (p) => { mkdirSync(p, { recursive: true }); return true; },
    readdir: (p) => JSON.stringify(readdirSync(p)),
    stat: (p) => {
      const s = statSync(p, { throwIfNoEntry: false });
      if (!s) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return JSON.stringify({ mode: s.mode, size: s.size, mtimeMs: s.mtimeMs, type: s.isDirectory() ? 'dir' : 'file' });
    },
    unlink: (p) => { try { rmSync(p); return true; } catch { return false; } },
    rename: (o, n) => { mkdirSync(dirname(n), { recursive: true }); rmSync(n, { force: true }); renameSync(o, n); return true; },
    httpRequest(id) {
      Promise.resolve().then(() => globalThis.DshGitBridge.onHttpResult(JSON.stringify({
        id, statusCode: 404, statusMessage: 'Not Found', headers: {}, bodyBase64: ''
      })));
    },
    onEvent(json) {
      const event = JSON.parse(json);
      const waiter = waiters.get(String(event.id));
      if (waiter) { waiters.delete(String(event.id)); waiter(event); }
    }
  };
  host.call = (bridge, op, args) => {
    const id = `d${++seq}`;
    return new Promise((resolvePromise) => {
      waiters.set(id, resolvePromise);
      assert.equal(bridge.call(JSON.stringify({ id, op, args })), undefined, 'call 必须无返回值');
    });
  };
  return host;
}
function loadBridge(host) {
  globalThis.dshGitHost = host;
  delete globalThis.DshGitBridge;
  globalThis.self = globalThis;
  nodeRequire(ISO_PATH);
  vm.runInThisContext(BRIDGE_SOURCE, { filename: BRIDGE_PATH });
  return globalThis.DshGitBridge;
}

// ------------------------------------------------------------------ 1. 症状复现 / 修复验证

describe('真机症状：远端领先 3 提交 + 平板 11 处改动', () => {
  test('修复前：git.merge({oid}) 抛的正是 V8 Cannot read properties of undefined (reading length)', async () => {
    const fx = makeFixture();
    const bridge = loadBridge(createHost(fx.tablet));
    assert.equal(g(['rev-list', '--count', 'HEAD..origin/main'], fx.tablet).trim(), '3');
    assert.equal(fx.localPaths.length, 11);
    await assert.rejects(
      () => globalThis.git.merge({
        fs: bridge.getInternalFs(), dir: fx.tablet.replace(/\\/g, '/'),
        oid: fx.origin, fastForwardOnly: true, author: { name: 'T', email: 't@x' }
      }),
      (error) => {
        assert.equal(error.name, 'TypeError');
        assert.match(error.message, /Cannot read properties of undefined \(reading 'length'\)/);
        return true;
      }
    );
  });

  test('修复后：v2 周期薄桥序列 typed 跑通，fastForward 不再抛 raw TypeError', async () => {
    const fx = makeFixture();
    const host = createHost(fx.tablet);
    const bridge = loadBridge(host);
    const cfg = { branch: 'main', deviceId: 'tablet', repoUrl: 'https://invalid.example/r.git', authorName: 'T', authorEmail: 't@x' };
    const call = (op, args) => host.call(bridge, op, { ...cfg, ...args });
    const resolveRef = async (ref) => call('v2Git', { op: 'resolveRef', ref });
    assert.equal((await resolveRef('HEAD')).data.oid, fx.head);
    assert.equal((await resolveRef('refs/remotes/origin/main')).data.oid, fx.origin);
    assert.equal((await call('v2Git', { op: 'currentBranch' })).data.value, 'main');
    assert.match((await call('v2Git', { op: 'readBlob', ref: 'origin/main', path: 'timeline/schema.json' })).data.value, /schemaVersion/);
    assert.equal((await call('v2Git', { op: 'mergeBase', a: fx.head, b: fx.origin })).data.oid, fx.head);
    const ff = await call('v2Git', { op: 'fastForward' });
    assert.equal(ff.ok, true, `fastForward 应 typed 成功：${JSON.stringify(ff.error)}`);
    assert.equal((await resolveRef('HEAD')).data.oid, fx.origin);
    const days = JSON.parse((await call('v2Git', { op: 'listDays' })).data.value);
    assert.ok(days.includes('2026-11-23'), '远端 3 个提交的新日目录应可列出');
    const committed = await call('v2Git', { op: 'addCommit', paths: JSON.stringify(fx.localPaths), message: '[v2] sync 1 days' });
    assert.equal(committed.ok, true, `addCommit 应成功：${JSON.stringify(committed.error)}`);
    assert.equal((await resolveRef('HEAD')).data.oid, committed.data.oid);
    const status = await call('status', {});
    assert.equal(status.ok, true, `status 应成功：${JSON.stringify(status.error)}`);
    assert.equal(status.data.changedCount, 0, '11 处本地改动已提交，工作区应干净');
  });

  test('源码级：merge 用 theirs，不再用 oid 传目标提交', () => {
    const block = BRIDGE_SOURCE.slice(BRIDGE_SOURCE.indexOf("op === 'fastForward'"), BRIDGE_SOURCE.indexOf("op === 'addCommit'"));
    assert.match(block, /git\.merge\(\{/);
    assert.match(block, /theirs:\s*target/);
    assert.doesNotMatch(block, /oid:\s*target/);
  });
});

// ------------------------------------------------------------------ 2. E_BRIDGE 边界

describe('E_BRIDGE 边界：原始 JS throw 永不外泄', () => {
  test('桥命令内部抛 TypeError → typed E_BRIDGE + message + stack，call 不抛出', async () => {
    const fx = makeFixture();
    const host = createHost(fx.tablet);
    const bridge = loadBridge(host);
    const original = globalThis.git;
    globalThis.git = new Proxy(original, {
      get(target, prop) {
        if (prop === 'fetch') {
          return async () => { throw new TypeError("Cannot read properties of undefined (reading 'length')"); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    try {
      const event = await host.call(bridge, 'v2Git', {
        op: 'fetch', branch: 'main', repoUrl: 'https://invalid.example/r.git'
      });
      assert.equal(event.ok, false);
      assert.equal(event.error.code, 'E_BRIDGE');
      assert.match(event.error.message, /Cannot read properties of undefined/);
      assert.equal(typeof event.error.stack, 'string');
      assert.ok(event.error.stack.length > 0, 'stack 仅用于诊断，必须随事件给出');
    } finally {
      globalThis.git = original;
    }
  });

  test('toBridgeFailure 对裸 TypeError / null / 错型都给 typed 错，不抛', () => {
    const bridge = loadBridge(createHost(makeTempDir('gitbridge-diag-boundary-')));
    const internals = bridge.internals;
    assert.equal(internals.bridgeErrorCode, 'E_BRIDGE');
    const raw = new TypeError("Cannot read properties of undefined (reading 'length')");
    const typed = internals.toBridgeFailure(raw);
    assert.equal(typed.code, 'E_BRIDGE');
    assert.match(typed.message, /Cannot read properties of undefined/);
    assert.ok(typed.jsStack.length > 0);
    for (const bad of [null, undefined, 42, {}, 'x']) {
      const result = internals.toBridgeFailure(bad);
      assert.equal(typeof result.code, 'string');
      assert.equal(result.isBridgeError, true);
    }
  });

  test('status 事件的 ok:true 分支不带 stack 字段', async () => {
    const fx = makeFixture();
    const host = createHost(fx.tablet);
    const bridge = loadBridge(host);
    const event = await host.call(bridge, 'status', {});
    assert.equal(event.ok, true);
    assert.equal(event.error, undefined);
    assert.equal(Object.hasOwn(event, 'stack'), false);
  });
});

// ------------------------------------------------------------------ 3. 护栏纯函数

describe('边界值护栏：undefined / null / 错型零抛出', () => {
  const BAD = [undefined, null, 42, 'oops', {}, true];
  test('asArray', () => {
    const { asArray } = loadBridge(createHost(makeTempDir('gitbridge-diag-guard-'))).internals;
    for (const bad of BAD) { assert.deepEqual(asArray(bad), []); }
    assert.deepEqual(asArray([1, 2]), [1, 2]);
  });
  test('shasFromLog', () => {
    const { shasFromLog } = loadBridge(createHost(makeTempDir('gitbridge-diag-guard-'))).internals;
    for (const bad of BAD) { assert.deepEqual(shasFromLog(bad), []); }
    assert.deepEqual(shasFromLog([{ oid: 'a' }, null, {}, { oid: '' }, { oid: 'b' }]), ['a', 'b']);
  });
  test('changedFromStatusMatrix（含空树 / 缺行 / 错型）', () => {
    const { changedFromStatusMatrix } = loadBridge(createHost(makeTempDir('gitbridge-diag-guard-'))).internals;
    for (const bad of BAD) { assert.deepEqual(changedFromStatusMatrix(bad), { changed: [], conflicts: 0 }); }
    assert.deepEqual(
      changedFromStatusMatrix([['a.json', 0, 2, 0], ['b.json', 1, 1, 1], null, ['short']]).changed,
      [{ path: 'a.json', head: 0, workdir: 2, stage: 0 }]
    );
  });
  test('daysFromListFiles', () => {
    const { daysFromListFiles } = loadBridge(createHost(makeTempDir('gitbridge-diag-guard-'))).internals;
    for (const bad of BAD) { assert.deepEqual(daysFromListFiles(bad), []); }
    assert.deepEqual(daysFromListFiles(['timeline/2026-11-20/records.json', 'other', null]), ['2026-11-20']);
  });
  test('pathsFromJson（null / 对象 / 坏 JSON）', () => {
    const { pathsFromJson } = loadBridge(createHost(makeTempDir('gitbridge-diag-guard-'))).internals;
    for (const bad of BAD) { assert.deepEqual(pathsFromJson(bad), []); }
    assert.deepEqual(pathsFromJson('null'), []);
    assert.deepEqual(pathsFromJson('{"x":1}'), []);
    assert.deepEqual(pathsFromJson('["timeline/a.json"]'), ['timeline/a.json']);
  });
  test('commitsToReports（空提交数组 / undefined parent）', () => {
    const { commitsToReports } = loadBridge(createHost(makeTempDir('gitbridge-diag-guard-'))).internals;
    for (const bad of BAD) { assert.deepEqual(commitsToReports(bad), []); }
    const reports = commitsToReports([{ oid: 'a', commit: { message: 'm', author: { name: 'n', email: 'e', timestamp: 0 } } }]);
    assert.equal(reports[0].sha, 'a');
    assert.equal(reports[0].message, 'm');
  });
  test('既有 countConflicts / computeAheadBehind 也吃 degenerate 形状', () => {
    const { countConflicts, computeAheadBehind } = loadBridge(createHost(makeTempDir('gitbridge-diag-guard-'))).internals;
    for (const bad of BAD) {
      assert.equal(countConflicts(bad), 0);
      const range = computeAheadBehind(bad, bad);
      assert.equal(range.ahead, 0);
      assert.equal(range.behind, 0);
    }
  });
});

// ------------------------------------------------------------------ 4. ArkTS 映射

describe('ArkTS 映射：固定中文给用户，原始文案只进诊断', () => {
  test('GitSyncService 有 E_BRIDGE 固定中文映射且诊断前缀只拼 diagnostics', () => {
    assert.match(SERVICE_SOURCE, /E_BRIDGE_USER_MESSAGE.*本地 Git 桥内部出错，本次操作未完成/);
    assert.match(SERVICE_SOURCE, /BRIDGE_DIAGNOSTIC_PREFIX.*｜桥诊断：/);
    assert.match(SERVICE_SOURCE, /failureOf\(code, text\)/);
    assert.match(SERVICE_SOURCE, /diagnostics = diagnostics \+ this\.bridgeDiagnostic/);
    const userMessage = /const E_BRIDGE_USER_MESSAGE: string = '([^']+)'/.exec(SERVICE_SOURCE);
    assert.ok(userMessage, '固定中文必须是单字面量，便于审计');
    assert.doesNotMatch(userMessage[1], /Cannot read properties|undefined|stack/);
  });
  test('状态行渲染函数不含桥诊断成员（raw message 不可能进主状态行）', () => {
    const statusFn = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf('async status('), SERVICE_SOURCE.indexOf('private statusViewOf('));
    assert.match(statusFn, /this\.bridgeDiagnostic/);
    const failureFn = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf('private failureOf('), SERVICE_SOURCE.indexOf('宿主代理：事件回传'));
    assert.match(failureFn, /this\.bridgeDiagnostic = /);
    assert.doesNotMatch(failureFn, /new SyncError\(E_BRIDGE_CODE, [^)]*rawMessage/);
    assert.doesNotMatch(failureFn, /\.stack/);
  });
});

// ------------------------------------------------------------------ 5. 双方都移动时的行为

describe('本机与远端都移动：typed 拒绝而非 TypeError', () => {
  test('分叉时 gate 拒绝（E_NOT_SYNCED），快进只在 behind 调用', () => {
    const cycle = readFileSync(join(APP_ROOT, 'entry/src/main/ets/model/syncCycle.ts'), 'utf8');
    assert.match(cycle, /if \(relation === 'behind'\)[\s\S]{0,120}fastForward\(\)/);
    assert.match(cycle, /code: 'E_NOT_SYNCED'/);
    const bridge = BRIDGE_SOURCE.slice(BRIDGE_SOURCE.indexOf("op === 'fastForward'"), BRIDGE_SOURCE.indexOf("op === 'addCommit'"));
    assert.match(bridge, /fastForwardOnly:\s*true/);
  });
});
