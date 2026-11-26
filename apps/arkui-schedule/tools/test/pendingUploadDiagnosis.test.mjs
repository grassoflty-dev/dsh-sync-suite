#!/usr/bin/env node
/**
 * mod-app-pending-upload-diagnosis：诊断行「本地改动 N 处（本机未上传·待上传）」为什么永不收敛。
 *
 * 结论（本文件钉死）：v2 周期原先只提交 **union 改写过字节** 的路径；应用自己的写入器
 * （`timelineWriteStore.append/scheduleDelete/restore/appendSummary`、导入）是**先落盘、后触发同步**，
 * union 重算出的字节与本地一致 → 该路径不进提交集合 → 它永远留在工作区，
 * 状态行把「本机本来就能上传、只是没人 add」的改动说成「待上传」，远端也永远拿不到。
 *
 * 覆盖：
 * A. 纯模型：一个周期的提交集合必须覆盖工作副本里可上传的 timeline 文件（写入器已落盘的那些）；
 *    不可上传的脏路径（devices/**、仓库根文件、写入残留）不静默丢计数，而是分区点名；
 *    `describeSyncStatus` 三种措辞（无分区 / 部分不可上传 / 全部不可上传），且都不暗示云端已有；
 * B. 真桥 + 真 git 仓库：`.gitignore` 的忽略项不抬高 changedCount；只提 union 路径时计数
 *    **永不收敛**（复现观测），提交可上传路径后计数降到「只有不可上传的残留」。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('pendingUploadDiagnosis.test.mjs');

// tsc 产出的 .build 是「无扩展名相对 import」的 ESM（与本仓其它纯模型测试同一套解析钩子）。
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

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const BRIDGE_PATH = join(APP, 'entry/src/main/resources/rawfile/git/git-bridge.js');
const ISO_PATH = join(APP, 'entry/src/main/resources/rawfile/git/isomorphic-git.js');

const { runCyclePure } = await import('../.build/model/syncCycle.js');
const { buildRecordsText, ledgerDeleteLine } = await import('../.build/model/timelineWrite.js');
const {
  partitionDirtyPaths,
  notUploadableCount,
  stagePathsForCycle,
  isUploadableTimelinePath,
  isTempLeftoverPath,
  timelineDayOfPath,
  daysInStageSet
} = await import('../.build/model/syncUploadScope.js');
const { describeChangedCount, describeSyncStatus } = await import('../.build/model/syncError.js');

const DAY = '2026-11-20';
const T0900 = `${DAY}T09:00:00+08:00`;
const SHA = 'a'.repeat(40);
const SCHEMA_TEXT = '{"schemaVersion":2}\n';

function rec(overrides = {}) {
  return {
    id: 'a1', ts: T0900, title: '标题', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: T0900, ...overrides
  };
}

// ------------------------------------------------------------------ A. 纯模型：fake GitPort

/**
 * 带「HEAD 树 vs 工作副本」的 fake git：`dirty()` 就是真 git 的 `status --porcelain` 语义
 * （工作副本与已提交树字节不同的路径，含未跟踪），因此「提交后是否还有残留」可被直接断言。
 */
class PudPort {
  constructor(opts = {}) {
    this.files = new Map();
    this.head = new Map();
    this.remote = new Map();
    this.pending = [];
    this.added = [];
    this.commits = [];
    this.pushes = 0;
    this.headOid = SHA;
    this.originOid = SHA;
    this.head.set('timeline/schema.json', SCHEMA_TEXT);
    this.files.set('timeline/schema.json', SCHEMA_TEXT);
    this.remote.set('timeline/schema.json', SCHEMA_TEXT);
    if (opts.noLocalTimelineEnumeration !== true) {
      this.localTimelinePaths = async () => Array.from(this.files.keys())
        .filter((path) => path.startsWith('timeline/')).sort();
    }
  }

  /** 应用写入器落盘（records / 账本 / 汇总 / 媒体都由它先写工作副本）。 */
  write(path, text) { this.setWorktree(path, text); }

  setWorktree(path, text) {
    const parts = path.split('/');
    const dir = path.slice(0, path.length - parts[parts.length - 1].length);
    void dir;
    this.files.set(path, text);
  }

  /** 脏路径（工作副本 ≠ HEAD；含未跟踪）——真 `statusMatrix` 的等价物。 */
  dirty() {
    const out = [];
    for (const [path, text] of this.files) {
      if (this.head.get(path) !== text) { out.push(path); }
    }
    for (const path of this.head.keys()) {
      if (!this.files.has(path)) { out.push(path); }
    }
    return out.sort();
  }

  async fetchMain() { this.fetched = (this.fetched || 0) + 1; }
  async headSha() { return this.headOid; }
  async originMainSha() { return this.originOid; }
  async branchName() { return 'main'; }
  async headRelation() { return this.headOid === this.originOid ? 'equal' : 'diverged'; }
  async showMain(path) { return this.remote.get(path) || ''; }
  async listRemoteDays() { return [DAY].filter((day) => this.remote.has(`timeline/${day}/records.json`)); }
  async addPaths(paths) {
    this.added.push(paths.slice());
    this.pending = paths.slice();
    for (const path of paths) {
      assert.ok(path.startsWith('timeline/'), `提交路径越界：${path}`);
    }
  }
  async commit(message) {
    this.commits.push(message);
    for (const path of this.pending) {
      if (this.files.has(path)) { this.head.set(path, this.files.get(path)); }
    }
    this.pending = [];
    this.headOid = 'b'.repeat(40);
  }
  async pushMain() {
    this.pushes += 1;
    this.originOid = this.headOid;
    for (const [path, text] of this.head) { this.remote.set(path, text); }
  }
  async resetHardOrigin() { this.headOid = this.originOid; }
  async fastForward() {}
}

function readDayOf(port) {
  return async (date, remote = true) => ({
    remote: remote ? port.remote.get(`timeline/${date}/records.json`) || '' : '',
    local: port.files.get(`timeline/${date}/records.json`) || '',
    deleted: port.files.get(`timeline/${date}/deleted.jsonl`) || '',
    restore: port.files.get(`timeline/${date}/restore.jsonl`) || '',
    remoteDeleted: remote ? port.remote.get(`timeline/${date}/deleted.jsonl`) || '' : '',
    remoteRestore: remote ? port.remote.get(`timeline/${date}/restore.jsonl`) || '' : ''
  });
}

function writeOf(port) {
  return {
    writeDay: async (date, texts) => {
      port.files.set(`timeline/${date}/records.json`, texts.records);
      port.files.set(`timeline/${date}/deleted.jsonl`, texts.deleted);
      port.files.set(`timeline/${date}/restore.jsonl`, texts.restore);
      if (texts.conflicts.length > 0) {
        const path = `timeline/${date}/conflicts.jsonl`;
        port.files.set(path, `${port.files.get(path) || ''}${texts.conflicts.join('\n')}\n`);
      }
    },
    writeOutbox: async () => {}
  };
}

/** 生产口径的「脏路径」提供者：等价于 `GitSyncService.v2DirtyPaths()`（真 git status 的行）。 */
function dirtyProviderOf(port) {
  return async () => port.dirty();
}

/**
 * 跑一轮周期。第 4 个参数是脏路径提供者：缺省 = 生产口径（实测脏路径）；
 * 传 `null` = 桥查不到 status 的降级口径（runCyclePure 收到 undefined）。
 */
async function cycle(port, outbox = [], days = [DAY], dirtyProvider = 'default') {
  const provider = dirtyProvider === 'default' ? dirtyProviderOf(port) : dirtyProvider;
  const providerArg = provider === null ? undefined : provider;
  return runCyclePure(port, days, readDayOf(port), outbox,
    new Date('2026-11-26T10:00:00Z'), writeOf(port), false, providerArg);
}

/* ---------------------------------------------------------------- PUD-01..03 */

test('PUD-01 写入器已落盘的 day 文件必须进本周期提交集合（观测里的「本地改动 N 处」根因）', async () => {
  const port = new PudPort();
  // 应用写入器先落盘：recordWriter → timelineWriteStore.append → 触发同步（outbox 已出队）
  port.write(`timeline/${DAY}/records.json`, buildRecordsText(DAY, [rec()]));
  assert.deepEqual(port.dirty(), [`timeline/${DAY}/records.json`], '前置：工作区确实有 1 处未提交改动');

  const result = await cycle(port, [], [DAY]);

  assert.equal(result.ok, true);
  const staged = port.added.length === 0 ? [] : port.added[0];
  assert.ok(staged.includes(`timeline/${DAY}/records.json`),
    `本机改动必须在提交集合里，实际提交集合=${JSON.stringify(staged)}`);
  assert.equal(port.commits.length, 1, '必须产生一次提交');
  assert.match(port.commits[0], /^\[v2\] sync \d+ days$/, '提交信息形状不变（跨包契约 isV2CommitSubject）');
  assert.ok(port.commits[0] !== '[v2] sync 0 days', '提交了 1 天就必须记 1 天，不能记 0 天');
  assert.deepEqual(port.dirty(), [], '提交后工作区对本机可上传内容是干净的（无残留「待上传」）');
  assert.equal(port.remote.get(`timeline/${DAY}/records.json`), buildRecordsText(DAY, [rec()]),
    '远端必须真的拿到这条记录（否则「待上传」只是空承诺）');
});

test('PUD-02 账本 / 汇总 / 媒体同样是「已落盘、union 不再改写」的那一类，必须一并提交', async () => {
  const port = new PudPort();
  const records = buildRecordsText(DAY, [rec()]);
  port.write(`timeline/${DAY}/records.json`, records);
  port.write(`timeline/${DAY}/deleted.jsonl`, `${ledgerDeleteLine('a1', T0900, T0900)}\n`);
  port.write(`timeline/${DAY}/summary.json`, '{"generatedAt":"2026-11-20T12:00:00+08:00","text":"汇总"}\n');
  port.write(`timeline/${DAY}/media/${'c'.repeat(64)}.png`, 'PNG');

  await cycle(port, [], [DAY]);

  const staged = port.added[0] || [];
  for (const path of [
    `timeline/${DAY}/records.json`,
    `timeline/${DAY}/deleted.jsonl`,
    `timeline/${DAY}/summary.json`,
    `timeline/${DAY}/media/${'c'.repeat(64)}.png`
  ]) {
    assert.ok(staged.includes(path), `缺 ${path}；实际=${JSON.stringify(staged)}`);
    assert.ok(port.remote.has(path), `远端没拿到 ${path}`);
  }
  assert.deepEqual(port.dirty(), []);
});

test('PUD-03 本机不会上传的脏路径：不进提交集合，但绝不从计数里静默消失', async () => {
  const port = new PudPort();
  port.write(`timeline/${DAY}/records.json`, buildRecordsText(DAY, [rec()]));
  port.write('devices/tablet-b/schedules/2026-11-20.jsonl', 'foreign\n');
  port.write(`timeline/${DAY}/records.json.tmp-1-2`, 'half-written');
  port.write('README.md', 'local note\n');

  const dirtyBefore = port.dirty();
  await cycle(port, [], [DAY]);

  const staged = port.added[0] || [];
  assert.ok(!staged.includes('devices/tablet-b/schedules/2026-11-20.jsonl'), '外机目录绝不提交');
  assert.ok(!staged.includes(`timeline/${DAY}/records.json.tmp-1-2`), '写入残留绝不提交');
  assert.ok(!staged.includes('README.md'), '仓库根文件不在 v2 契约内，绝不提交');

  const dirtyAfter = port.dirty();
  assert.deepEqual(dirtyAfter, [
    'README.md',
    'devices/tablet-b/schedules/2026-11-20.jsonl',
    `timeline/${DAY}/records.json.tmp-1-2`
  ], '可上传的已清空，不可上传的原样留在工作区（不删、不假装干净）');

  // 计数分区：总数仍是实测脏路径数，其中 3 处不可上传 → 措辞必须点名，不能说成「待上传」
  const split = partitionDirtyPaths(dirtyAfter);
  assert.deepEqual(split.uploadable, []);
  assert.equal(split.notUploadable.length, 3);
  const line = describeSyncStatus({
    initialized: true, branch: 'main', head: SHA, ahead: 0, behind: 0, diverged: false,
    conflicts: 0, changedCount: dirtyAfter.length, uploadState: 'pending',
    notUploadableCount: notUploadableCount(dirtyAfter), remoteConfigured: true, lastCommitMessage: ''
  });
  assert.equal(dirtyBefore.length, 4, '前置：周期前有 4 处脏路径');
  assert.equal(dirtyAfter.length, 3, '周期后只有可上传的那 1 处被清掉，其余计数不消失');
  assert.ok(line.includes(`本地改动 ${dirtyAfter.length} 处`), `总数必须是实测脏路径数：${line}`);
  assert.ok(line.includes('不在本机上传范围'), `必须点名不可上传部分：${line}`);
  assert.ok(!line.includes('待上传'), `全都不可上传时不能说「待上传」：${line}`);
  for (const banned of ['云端', '已上传', '已同步', '同步成功']) {
    assert.ok(!line.includes(banned), `绝不能让云端已有被读出来：${line}`);
  }
});

/* ---------------------------------------------------------------- PUD-04..06 */

test('PUD-04 措辞三态：无分区 / 部分不可上传 / 全部不可上传（既有措辞一字不改）', () => {
  const plain = describeChangedCount(12, 'pending');
  assert.equal(plain, '本地改动 12 处（本机未上传·待上传）', '无分区信息时保持既有措辞');
  assert.equal(describeChangedCount(12, 'failed', 0), '本地改动 12 处（本机未上传·上传失败）');
  assert.equal(describeChangedCount(0, undefined), '本地改动 0 处（本机未上传·待上传）');

  const partial = describeChangedCount(12, 'pending', 5);
  assert.equal(partial,
    '本地改动 12 处（本机未上传·待上传；其中 5 处不在本机上传范围，不会被本机上传）');
  assert.ok(partial.includes('本机未上传'), '可上传部分仍要带「本机未上传」');

  const all = describeChangedCount(3, 'pending', 3);
  assert.equal(all, '本地改动 3 处（其中 3 处不在本机上传范围，不会被本机上传）');

  // M 大于总数 / 负数：夹取，不产生「其中 20 处」这种自相矛盾的句子
  assert.ok(describeChangedCount(3, 'pending', 20).includes('其中 3 处'));
  assert.equal(describeChangedCount(3, 'pending', -1), '本地改动 3 处（本机未上传·待上传）');

  // 任何形态都不暗示云端已有
  for (const line of [plain, partial, all]) {
    for (const banned of ['云端', '已上传', '已同步', '同步成功', '已推送']) {
      assert.ok(!line.includes(banned), `措辞越界：${line}`);
    }
    assert.ok(line.includes('本地改动'), `必须保留改动数：${line}`);
  }
});

test('PUD-05 stagePathsForCycle：可上传口径 / days 范围 / 去重 / union 路径优先', () => {
  assert.equal(isUploadableTimelinePath('timeline/schema.json'), true);
  assert.equal(isUploadableTimelinePath(`timeline/${DAY}/records.json`), true);
  assert.equal(isUploadableTimelinePath(`timeline/${DAY}/media/${'d'.repeat(64)}.png`), true);
  assert.equal(isUploadableTimelinePath('devices/tablet-a/schedules/2026-11-20.jsonl'), false);
  assert.equal(isUploadableTimelinePath('timeline/notes.txt'), false, '时间线根下只认 schema.json');
  assert.equal(isUploadableTimelinePath('timeline/2026-13-40/records.json'), true,
    '这里只做「日目录形状」判定（YYYY-MM-DD）；日历合法性由写入器负责（ensureDay 的 E_DATE）');
  assert.equal(isUploadableTimelinePath(`timeline/${DAY}/records.json.tmp-9-9`), false);
  assert.equal(isUploadableTimelinePath('../timeline/x'), false);
  assert.equal(isTempLeftoverPath(`timeline/${DAY}/records.json.bak-9-9`), true);
  assert.equal(timelineDayOfPath(`timeline/${DAY}/summary.json`), DAY);
  assert.equal(timelineDayOfPath('timeline/schema.json'), '');
  assert.equal(timelineDayOfPath('devices/x'), null);

  const staged = stagePathsForCycle(
    [`timeline/${DAY}/records.json`],
    [
      `timeline/${DAY}/records.json`,
      `timeline/${DAY}/summary.json`,
      `timeline/2026-01-01/records.json`,   // 不在本轮 days
      'timeline/schema.json',
      `timeline/${DAY}/records.json.tmp-1-2`,
      'devices/tablet-a/open.jsonl'
    ],
    [DAY]
  );
  assert.deepEqual(staged, [
    `timeline/${DAY}/records.json`,
    `timeline/${DAY}/summary.json`,
    'timeline/schema.json'
  ], 'union 路径优先、去重；范围外与不可上传的一律不进集合');
  assert.equal(daysInStageSet(staged), 1);

  // 拿不到实测脏路径（提供者缺席 / 查询失败）时退回旧行为：只提交 union 路径
  assert.deepEqual(stagePathsForCycle([`timeline/${DAY}/records.json`], undefined, [DAY]),
    [`timeline/${DAY}/records.json`]);
  // union 没改写任何路径、也没有脏路径 → 空集合（不产出空提交）
  assert.deepEqual(stagePathsForCycle([], undefined, [DAY]), []);
  assert.deepEqual(stagePathsForCycle([], [], [DAY]), []);
});

test('PUD-06 拿不到实测脏路径时行为与旧代码一致（不制造提交、不谎报）', async () => {
  const port = new PudPort(); // 不传脏路径提供者 = 桥查不到 status 的降级路径
  port.write(`timeline/${DAY}/records.json`, buildRecordsText(DAY, [rec()]));

  await cycle(port, [], [DAY], null);
  assert.equal(port.added.length, 0, '没有实测脏路径时不能凭空知道该提交什么');
  assert.equal(port.commits.length, 0);
  // writeDay 会把本轮三件套都写一遍（含空账本），所以工作区多了三个未跟踪文件；
  // 其中 records.json 才是用户数据，另外两个是空账本占位。它们都仍留在工作区，
  // 会被 status 如实计入「本地改动 N 处（本机未上传）」，不会被谎报为已上传。
  assert.deepEqual(port.dirty(), [
    `timeline/${DAY}/deleted.jsonl`,
    `timeline/${DAY}/records.json`,
    `timeline/${DAY}/restore.jsonl`
  ], '这些路径仍留在工作区，会被如实计入「本地改动 N 处」（本机未上传），不会被谎报为已上传');
});

// ------------------------------------------------------------------ B. 真桥 + 真 git

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const GIT_IDENTITY = ['-c', 'user.name=Test Runner', '-c', 'user.email=test@localhost', '-c', 'core.autocrlf=false'];

function createFakeHost(repoRoot) {
  const waiters = new Map();
  const host = {
    readFileBase64(path) { try { return readFileSync(path).toString('base64'); } catch { return ''; } },
    writeFileBase64(path, base64) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(base64, 'base64'));
      return true;
    },
    fileExists(path) { return existsSync(path); },
    mkdirp(path) { mkdirSync(path, { recursive: true }); return true; },
    readdir(path) { return JSON.stringify(readdirSync(path)); },
    stat(path) {
      const info = statSync(path, { throwIfNoEntry: false });
      if (!info) {
        const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return JSON.stringify({ mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, type: info.isDirectory() ? 'dir' : 'file' });
    },
    unlink(path) {
      try { unlinkSync(path); return true; } catch (error) {
        if (error.code === 'ENOENT') { return false; }
        throw error;
      }
    },
    rename(oldPath, newPath) { mkdirSync(dirname(newPath), { recursive: true }); renameSync(oldPath, newPath); return true; },
    getRepoRoot() { return repoRoot; },
    httpRequest() { throw new Error('本用例不应发起 HTTP 请求'); },
    onEvent(json) {
      const event = JSON.parse(json);
      const waiter = waiters.get(String(event.id));
      if (waiter) { waiters.delete(String(event.id)); waiter(event); }
    }
  };
  host.waiters = waiters;
  return host;
}

function loadBridge(host) {
  globalThis.dshGitHost = host;
  delete globalThis.DshGitBridge;
  vm.runInThisContext(readFileSync(BRIDGE_PATH, 'utf8'), { filename: BRIDGE_PATH });
  assert.equal(typeof globalThis.DshGitBridge, 'object', 'git-bridge.js 应暴露 globalThis.DshGitBridge');
  return globalThis.DshGitBridge;
}

let requestSeq = 0;
function invoke(bridge, host, op, args) {
  const id = `pud-${++requestSeq}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      host.waiters.delete(id);
      rejectPromise(new Error(`桥操作超时：${op}`));
    }, 30000);
    host.waiters.set(id, (event) => { clearTimeout(timer); resolvePromise(event); });
    bridge.call(JSON.stringify({ id, op, args }));
  });
}

async function expectOk(bridge, host, op, args) {
  const event = await invoke(bridge, host, op, args);
  assert.equal(event.ok, true, `${op} 失败：${event.ok ? '' : JSON.stringify(event.error)}`);
  return event.data;
}

test('PUD-07 真 git + 真 .gitignore：忽略项不抬高 changedCount；不提交可上传路径则计数永不收敛', async () => {
  globalThis.self = globalThis;
  const nodeRequire = createRequire(import.meta.url);
  nodeRequire(ISO_PATH); // UMD 把 isomorphic-git 挂到 globalThis.git（与 index.html 顺序一致）

  const work = makeTempDir('dsh-pud-');
  const repoRoot = join(work, 'git-repo').replace(/\\/g, '/');
  mkdirSync(join(repoRoot, 'timeline/2026-11-19'), { recursive: true });
  const git = (args) => runGit(args, repoRoot);
  git(['init', '-b', 'main']);
  git(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoRoot, 'timeline/schema.json'), SCHEMA_TEXT);
  writeFileSync(join(repoRoot, 'timeline/2026-11-19/records.json'),
    buildRecordsText('2026-11-19', [rec({ ts: '2026-11-19T09:00:00+08:00', opened_at: '2026-11-19T09:00:00+08:00' })]));
  writeFileSync(join(repoRoot, '.gitignore'), 'build/\n*.log\n');
  git([...GIT_IDENTITY, 'add', '-A']);
  git([...GIT_IDENTITY, 'commit', '-m', '[v2] sync 1 days']);

  // 应用侧实况：写入器落盘的日文件 / 汇总；不可上传的残留（.tmp）；忽略掉的构建产物
  mkdirSync(join(repoRoot, `timeline/${DAY}`), { recursive: true });
  writeFileSync(join(repoRoot, `timeline/${DAY}/records.json`), buildRecordsText(DAY, [rec()]));
  writeFileSync(join(repoRoot, `timeline/${DAY}/summary.json`), '{"generatedAt":"x","text":"y"}\n');
  writeFileSync(join(repoRoot, `timeline/${DAY}/records.json.tmp-3-4`), 'half\n');
  mkdirSync(join(repoRoot, 'build'), { recursive: true });
  writeFileSync(join(repoRoot, 'build/out.log'), 'noise\n');
  mkdirSync(join(repoRoot, 'devices/tablet-b/schedules'), { recursive: true });
  writeFileSync(join(repoRoot, 'devices/tablet-b/schedules/2026-11-20.jsonl'), 'foreign\n');

  const host = createFakeHost(repoRoot);
  const bridge = loadBridge(host);
  await expectOk(bridge, host, 'init', {
    branch: 'main', deviceId: 'tablet-a', authorName: '测试', authorEmail: 'tablet-a@localhost'
  });

  const first = await expectOk(bridge, host, 'status', { fetchRemote: 'false' });
  const firstPaths = first.changed.map((row) => row.path).sort();
  assert.deepEqual(firstPaths, [
    'devices/tablet-b/schedules/2026-11-20.jsonl',
    `timeline/${DAY}/records.json`,
    `timeline/${DAY}/records.json.tmp-3-4`,
    `timeline/${DAY}/summary.json`
  ], 'statusMatrix 已按 .gitignore 排除 build/out.log 等忽略项（忽略项不抬高计数）');
  assert.equal(first.changedCount, 4);

  // 观测复现：只提交 union 改写的路径（本轮 union 无需改写任何日文件 → 空集合）。
  // 旧代码在空集合时直接跳过 add/commit，于是计数永远停在 4。
  const emptyStage = stagePathsForCycle([], undefined, [DAY]);
  assert.deepEqual(emptyStage, []);
  const second = await expectOk(bridge, host, 'status', { fetchRemote: 'false' });
  assert.equal(second.changedCount, first.changedCount,
    '没有 add/commit 时 changedCount 不会自己收敛（这就是「未在周期之间自行恢复」的事实）');

  // 修复后的提交集合：把 **status 实测的脏路径** 按可上传口径过滤（忽略写入残留 / 外机目录）
  const dirtyNow = second.changed.map((row) => row.path);
  const stage = stagePathsForCycle([], dirtyNow, [DAY, '2026-11-19']);
  assert.ok(stage.includes(`timeline/${DAY}/records.json`));
  assert.ok(stage.includes(`timeline/${DAY}/summary.json`));
  assert.ok(!stage.includes(`timeline/${DAY}/records.json.tmp-3-4`), '写入残留不进提交集合');
  assert.ok(!stage.includes('devices/tablet-b/schedules/2026-11-20.jsonl'));

  await expectOk(bridge, host, 'v2Git', {
    op: 'addCommit', paths: JSON.stringify(stage), message: '[v2] sync 1 days'
  });

  const third = await expectOk(bridge, host, 'status', { fetchRemote: 'false' });
  const rest = third.changed.map((row) => row.path).sort();
  assert.deepEqual(rest, [
    'devices/tablet-b/schedules/2026-11-20.jsonl',
    `timeline/${DAY}/records.json.tmp-3-4`
  ], '提交可上传路径后只剩本机不会上传的两处（不静默丢弃计数）');
  assert.equal(third.changedCount, 2);

  const split = partitionDirtyPaths(rest);
  assert.equal(split.uploadable.length, 0);
  assert.equal(split.notUploadable.length, 2);
  const line = describeSyncStatus({
    initialized: true, branch: 'main', head: third.head, ahead: 0, behind: 0, diverged: false,
    conflicts: 0, changedCount: third.changedCount, uploadState: 'pending',
    notUploadableCount: split.notUploadable.length, remoteConfigured: true, lastCommitMessage: ''
  });
  assert.ok(line.includes('本地改动 2 处'), `总数保留：${line}`);
  assert.ok(line.includes('不会被本机上传'), `点名不可上传：${line}`);
  assert.ok(!line.includes('待上传'), `不能让用户以为它们在排队：${line}`);
});
