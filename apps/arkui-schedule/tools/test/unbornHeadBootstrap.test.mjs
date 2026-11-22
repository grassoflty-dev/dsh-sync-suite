// mod-empty-remote-unborn-head：未出生 HEAD + 空远端必须走既有首跑引导。
//
// 设备证据（安装版 1000008）：冷启动cycles 跑起来了，但
//   git_sync_status.reason = "远端仓库为空，或分支/引用不存在：Could not find origin/main."
//   .git/HEAD = ref: refs/heads/main，.git/refs/heads/ 为空，.git/refs/remotes/origin 不存在。
// 根因不是分支门禁：真桥 currentBranch(unborn) 返回 main（符号 HEAD），
// remoteLayout 也正确判空 → decision='bootstrap'；失败发生在 bootstrap 内部第一处 readDay：
//   syncProtocolStore.readDay -> BridgeGitRunner.showMain -> v2Git('readBlob', {ref:'origin/main'})
//   -> git-bridge v2OidOf(git,'origin/main') -> git.resolveRef 抛 NotFoundError
//   -> normalizeError 给出上面的 E_GIT 文案 -> classifySyncError 归为 no-main。
//
// 本文件的 fake 端口**故意复刻真桥语义**：origin/main 不存在时 showMain 抛错（不是返回空串），
// 未出生 HEAD 的 currentBranch 仍返回 main（符号 HEAD 目标），listDays 吞掉引用缺失返回 []。
// 这正是前几轮 Node 绿灯、真机红灯的差异点。
//
// 前置构建：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('unbornHeadBootstrap.test.mjs');

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error !== null && typeof error === 'object' &&
          error.code === 'ERR_MODULE_NOT_FOUND' &&
          specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const { runCyclePure, remoteStateDecision } = await import('../.build/model/syncCycle.js');
const { buildRecordsText } = await import('../.build/model/timelineWrite.js');
const { classifySyncError } = await import('../.build/model/syncError.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', '..');
const BRIDGE_PATH = join(APP, 'entry/src/main/resources/rawfile/git/git-bridge.js');
const GIT_BUNDLE_PATH = join(APP, 'entry/src/main/resources/rawfile/git/isomorphic-git.js');
const BRIDGE_SRC = readFileSync(BRIDGE_PATH, 'utf8');
const CYCLE_SRC = readFileSync(join(APP, 'entry/src/main/ets/model/syncCycle.ts'), 'utf8');
const RUNNER_SRC = readFileSync(join(APP, 'entry/src/main/ets/services/gitRunner.ets'), 'utf8');

const DAY = '2026-11-22';
const SHA = 'a'.repeat(40);
const SCHEMA_TEXT = JSON.stringify({ schemaVersion: 2 });

function rec(title) {
  return {
    id: `loc-${title}`, ts: `${DAY}T09:30:00+08:00`, title: title, body: '', author: '我',
    done: false, media: [], ai_processed: false, opened_at: `${DAY}T09:30:00+08:00`
  };
}

/** 真桥语义的 GitPort：未出生 HEAD + origin/main 缺失时 showMain 抛错，绝不返回空串。 */
class UnbornHeadPort {
  constructor(opts = {}) {
    this.files = new Map();
    this.remoteFiles = new Map();
    this.layout = opts.layout === undefined
      ? { hasMain: opts.remoteMain === true, isEmpty: opts.remoteMain !== true, refs: opts.remoteMain === true ? ['main'] : [] }
      : opts.layout;
    this.probeError = opts.probeError === undefined ? '' : opts.probeError;
    this.remoteMain = opts.remoteMain === undefined ? false : opts.remoteMain;
    this.unborn = opts.unborn === undefined ? true : opts.unborn;
    this.pushReject = opts.pushReject === undefined ? '' : opts.pushReject;
    this.branch = 'main';
    this.head = this.unborn ? '' : SHA;
    this.origin = this.remoteMain ? SHA : '';
    this.trace = [];
    this.commits = [];
    this.pending = [];
    this.pushCount = 0;
    this.fetchCount = 0;
    this.resetCount = 0;
    this.layoutProbes = 0;
    if (opts.remoteMain) {
      this.remoteFiles.set('timeline/schema.json', SCHEMA_TEXT);
    }
    this.files.set('timeline/schema.json', SCHEMA_TEXT);
  }

  /** 模拟设备上的 17 处本地改动：全部在工作副本 timeline/**，尚未提交。 */
  seedLocalChanges(count = 17) {
    const titles = [];
    for (let i = 1; i <= count; i += 1) {
      const title = `本地改动${String(i).padStart(2, '0')}`;
      titles.push(title);
      this.files.set(`timeline/${DAY}/records.json`, buildRecordsText(DAY, titles.map(rec)));
      this.files.set(`timeline/${DAY}/deleted.jsonl`, `LOCAL-CHANGE-${String(i).padStart(2, '0')}\n`);
    }
    return titles;
  }

  async remoteLayout() {
    this.layoutProbes += 1;
    this.trace.push('remoteLayout');
    if (this.probeError.length > 0) {
      throw new Error(this.probeError);
    }
    return this.layout;
  }

  async listRemoteDays() {
    this.trace.push('listDays');
    if (!this.remoteMain) {
      return []; // 真桥 catch 引用缺失 → '[]'
    }
    return Array.from(this.remoteFiles.keys())
      .filter((p) => /^timeline\/\d{4}-\d{2}-\d{2}\/records\.json$/.test(p))
      .map((p) => p.split('/')[1]).sort();
  }

  async showMain(path) {
    this.trace.push(`showMain:${path}`);
    if (!this.remoteMain) {
      // 真桥 v2OidOf(git,'origin/main') -> resolveRef NotFoundError -> normalizeError(E_GIT)
      throw new Error('E_GIT: 远端仓库为空，或分支/引用不存在：Could not find origin/main.');
    }
    return this.remoteFiles.get(path) || '';
  }

  async localSchemaText() { return this.files.get('timeline/schema.json') || ''; }
  async localTimelinePaths() { return Array.from(this.files.keys()).filter((p) => p.startsWith('timeline/')).sort(); }
  async branchName() { return this.branch; } // 符号 HEAD：未出生也解析成 main
  async headSha() { return this.head; }
  async originMainSha() { return this.origin; }
  async headRelation() { return this.head === this.origin ? 'equal' : 'diverged'; }
  async addPaths(paths) { this.pending = paths.slice(); }
  async commit(message) {
    if (this.pending.length === 0) { return; }
    const files = new Map();
    for (const p of this.pending) {
      if (this.files.has(p)) { files.set(p, this.files.get(p)); }
    }
    this.commits.push({ message, files });
    this.head = SHA;
    this.pending = [];
  }
  async fetchMain() {
    this.fetchCount += 1;
    this.trace.push('fetch');
    if (this.remoteMain) { this.origin = this.head; }
  }
  async pushMain() {
    this.pushCount += 1;
    this.trace.push('push');
    if (this.pushReject.length > 0) { throw new Error(this.pushReject); }
    this.remoteMain = true;
    this.origin = this.head;
    // 推上去的就是初始提交树（含 17 处本地改动）
    for (const c of this.commits) {
      for (const [p, text] of c.files) { this.remoteFiles.set(p, text); }
    }
  }
  async resetHardOrigin() { this.resetCount += 1; this.trace.push('resetHard'); }
  async fastForward() {}
}

function writePort(port) {
  return {
    writeDay: async (date, texts) => {
      if (!port.files.has('timeline/schema.json')) { port.files.set('timeline/schema.json', SCHEMA_TEXT); }
      port.files.set(`timeline/${date}/records.json`, texts.records);
      port.files.set(`timeline/${date}/deleted.jsonl`, texts.deleted);
      port.files.set(`timeline/${date}/restore.jsonl`, texts.restore);
    },
    writeOutbox: async () => {}
  };
}

async function cycle(port, opts = {}) {
  const days = opts.days === undefined ? [DAY] : opts.days;
  const readDay = opts.readDay === undefined
    ? async (date, remote = true) => ({
        remote: remote ? await port.showMain(`timeline/${date}/records.json`) : '',
        local: port.files.get(`timeline/${date}/records.json`) || '',
        deleted: port.files.get(`timeline/${date}/deleted.jsonl`) || '',
        restore: port.files.get(`timeline/${date}/restore.jsonl`) || ''
      })
    : opts.readDay;
  return await runCyclePure(port, days, readDay, [], new Date('2026-11-22T10:00:00.000Z'), writePort(port));
}

// ------------------------------------------------------------------ UH-00：真桥决策取证

test('UH-00 真桥：未出生 HEAD + 空远端 ⇒ remoteLayout 判空、currentBranch=main、readBlob 抛 Could not find origin/main', async (t) => {
  globalThis.self = globalThis;
  vm.runInThisContext(readFileSync(GIT_BUNDLE_PATH, 'utf8'), { filename: GIT_BUNDLE_PATH });
  const realGit = globalThis.git;
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(join(await import('node:os').then((m) => m.tmpdir()), 'dsh-unborn-head-'));
  const root = join(dir, 'git-repo');
  fs.mkdirSync(root, { recursive: true });
  await realGit.init({ fs: fs.promises, dir: root, defaultBranch: 'main' });

  const stubs = {
    listServerRefs: async () => [],
    getRemoteInfo: async () => ({ refs: { heads: {}, tags: {}, pull: {} } })
  };
  globalThis.git = new Proxy(realGit, {
    get(target, prop) {
      return Object.prototype.hasOwnProperty.call(stubs, prop) ? stubs[prop] : target[prop];
    }
  });
  globalThis.dshGitHost = {
    readFileBase64(p) { try { return fs.readFileSync(p).toString('base64'); } catch { return ''; } },
    writeFileBase64(p, b) { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(b, 'base64')); return true; },
    fileExists(p) { return fs.existsSync(p); },
    mkdirp(p) { fs.mkdirSync(p, { recursive: true }); return true; },
    readdir(p) { return JSON.stringify(fs.readdirSync(p)); },
    stat(p) {
      const i = fs.statSync(p, { throwIfNoEntry: false });
      if (!i) { const e = new Error("ENOENT: no such file or directory, stat '" + p + "'"); e.code = 'ENOENT'; throw e; }
      return JSON.stringify({ mode: i.mode, size: i.size, mtimeMs: i.mtimeMs, type: i.isDirectory() ? 'dir' : 'file' });
    },
    unlink() { return false; }, rename() { return false; },
    getRepoRoot() { return root.replace(/\\/g, '/'); },
    httpRequest() { throw new Error('diagnostic must not use HTTP'); }, onEvent() {}
  };
  delete globalThis.DshGitBridge;
  vm.runInThisContext(BRIDGE_SRC, { filename: BRIDGE_PATH });
  const v2 = globalThis.DshGitBridge.internals.opHandlers.v2Git;
  const args = { op: '', autoInit: 'true', repoUrl: 'https://gitee.com/example/empty.git', branch: 'main' };
  const call = (op, extra = {}) => v2({ ...args, op, ...extra });

  assert.equal(fs.readFileSync(join(root, '.git/HEAD'), 'utf8').trim(), 'ref: refs/heads/main');
  assert.deepEqual(fs.readdirSync(join(root, '.git/refs/heads')), []);
  const layout = JSON.parse((await call('remoteLayout')).value);
  const branch = (await call('currentBranch')).value;
  let blobError = null;
  try { await call('readBlob', { ref: 'origin/main', path: `timeline/${DAY}/records.json` }); }
  catch (e) { blobError = e; }
  t.diagnostic(`decision: hasMain=${layout.hasMain} isEmpty=${layout.isEmpty} -> ${remoteStateDecision(layout.hasMain, layout.isEmpty)}; currentBranch=${branch}; readBlob=${blobError && blobError.message}`);
  assert.equal(remoteStateDecision(layout.hasMain, layout.isEmpty), 'bootstrap');
  assert.equal(branch, 'main', '未出生 HEAD 的符号引用仍解析成 main，分支门禁不会拒绝');
  assert.ok(blobError, 'origin/main 缺失时真桥 readBlob 抛错（设备失败的真正位置）');
  const normalized = globalThis.DshGitBridge.internals.normalizeError(blobError);
  assert.match(normalized.message, /远端仓库为空，或分支\/引用不存在：Could not find origin\/main/);
  assert.equal(classifySyncError(normalized.code, normalized.message).kind, 'no-main',
    '归到 no-main 的是错误分类，不是引导决策');
  globalThis.git = realGit;
});

// ------------------------------------------------------------------ UH-01..05

test('UH-01 未出生 HEAD + 空远端 ⇒ bootstrap 决策、main 创建、一次提交、尝试推送', async () => {
  const port = new UnbornHeadPort();
  port.seedLocalChanges(17);
  const outcome = await cycle(port);
  assert.equal(outcome.bootstrapped, true, '必须命中既有 bootstrap 分支，不是 no-main');
  assert.equal(outcome.ok, true, outcome.message);
  assert.equal(outcome.message, '已同步');
  assert.equal(port.commits.length, 1, '只建一个初始提交');
  assert.equal(port.commits[0].message, '[v2] bootstrap main');
  assert.equal(port.branch, 'main');
  assert.ok(port.pushCount >= 1, '必须尝试 push');
  assert.ok(port.fetchCount >= 1, 'push 后必须 fetch 建立 origin/main 跟踪引用');
  assert.equal(port.resetCount, 0, '首跑不 reset --hard');
  assert.notEqual(classifySyncError(outcome.code, outcome.message).kind, 'no-main', '成功不该被归类为 no-main');
});

test('UH-02 17 处本地改动不丢：全部进入初始提交 / 远端树', async () => {
  const port = new UnbornHeadPort();
  const titles = port.seedLocalChanges(17);
  const outcome = await cycle(port);
  assert.equal(outcome.bootstrapped, true, outcome.message);
  const committed = port.commits[0] ? port.commits[0].files : new Map();
  const records = committed.get(`timeline/${DAY}/records.json`) || '';
  for (const title of titles) {
    assert.ok(records.includes(title), `本地改动未进初始提交: ${title}`);
  }
  assert.ok(committed.has('timeline/schema.json'));
  assert.equal(records, port.remoteFiles.get(`timeline/${DAY}/records.json`), '推上去的树与提交树一致');
  assert.equal(port.resetCount, 0, '绝不 reset --hard / checkout -- . 覆盖未提交改动');
});

test('UH-03 空远端 + 已有 HEAD（本地有提交但远端无引用）仍走既有引导，不回归', async () => {
  const port = new UnbornHeadPort({ unborn: false });
  port.seedLocalChanges(17);
  const outcome = await cycle(port);
  assert.equal(outcome.bootstrapped, true, outcome.message);
  assert.equal(outcome.ok, true, outcome.message);
  assert.equal(port.commits.length, 1);
  assert.ok(port.pushCount >= 1);
});

test('UH-04 远端已有 main ⇒ 普通周期，不引导、不再起新根提交', async () => {
  const port = new UnbornHeadPort({ remoteMain: true, unborn: false });
  port.remoteFiles.set(`timeline/${DAY}/records.json`, buildRecordsText(DAY, [rec('remote-existing')]));
  const outcome = await cycle(port);
  assert.notEqual(outcome.bootstrapped, true);
  assert.equal(outcome.ok, true, outcome.message);
  assert.ok(port.commits.every((c) => c.message.startsWith('[v2] sync ')),
    '普通周期只产出 [v2] sync 提交，不能产出 bootstrap 根提交');
  assert.ok(port.fetchCount >= 1);
  assert.ok(port.pushCount >= 1);
  assert.equal(port.layoutProbes, 1);
});

test('UH-05 探测失败 ⇒ typed 未定、零提交、零推送（既有不变量）', async () => {
  const port = new UnbornHeadPort({ probeError: 'E_AUTH: token expired' });
  const outcome = await cycle(port);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'E_AUTH');
  assert.notEqual(outcome.bootstrapped, true);
  assert.equal(port.commits.length, 0);
  assert.equal(port.pushCount, 0);
  assert.equal(port.fetchCount, 0);
});

test('UH-07 EOF / 未出生 HEAD 伪引用不算「远端已有引用」，仍判空', async () => {
  globalThis.self = globalThis;
  vm.runInThisContext(readFileSync(GIT_BUNDLE_PATH, 'utf8'), { filename: GIT_BUNDLE_PATH });
  const realGit = globalThis.git;
  globalThis.git = new Proxy(realGit, {
    get(target, prop) {
      if (prop === 'listServerRefs') {
        return async () => [
          { ref: 'HEAD', oid: '0'.repeat(40) },
          { ref: 'EOF', oid: '' }
        ];
      }
      if (prop === 'getRemoteInfo') {
        return async () => ({ refs: { heads: {}, tags: {}, pull: {} } });
      }
      return target[prop];
    }
  });
  delete globalThis.DshGitBridge;
  vm.runInThisContext(BRIDGE_SRC, { filename: BRIDGE_PATH });
  const probe = globalThis.DshGitBridge.internals.probeRemoteRefs;
  const result = await probe(globalThis.git, {}, 'https://gitee.com/example/empty.git');
  assert.deepEqual(result, { empty: true, heads: [], names: [] });
  globalThis.git = realGit;
});

// ------------------------------------------------------------------ 源码形状守卫：复用既有 bootstrap，不新建第二条路径

test('UH-06 生产接线：readDay 在引导阶段必须可跳过 origin/main 读取', () => {
  const service = readFileSync(join(APP, 'entry/src/main/ets/services/syncProtocolStore.ets'), 'utf8');
  const start = service.indexOf('const readDay = async (');
  assert.ok(start >= 0, 'readDay 闭包必须存在');
  const readDayBody = service.slice(start, service.indexOf('const write:', start));
  assert.match(readDayBody, /remote/,
    'readDay 必须支持 remote 开关：空远端尚未创建 origin/main 时不能读远端');
  assert.ok(CYCLE_SRC.includes('bootstrapEmptyRemote('), '必须复用既有 bootstrap 函数');
  assert.equal((CYCLE_SRC.match(/async function bootstrapEmptyRemote\(/g) || []).length, 1,
    '只能有一条 bootstrap 路径');
  assert.ok(RUNNER_SRC.includes("v2Git('readBlob'"), 'showMain 真桥语义守卫：走 readBlob');
});
