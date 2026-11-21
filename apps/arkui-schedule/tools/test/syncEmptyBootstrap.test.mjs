// mod-sync-empty-repo-bootstrap：空仓库首跑引导（fake GitPort，内存 git）。
//
// 前置构建：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型从 ../.build 导入；.ets 服务 / rawfile 桥只做源码形状断言（本仓既有口径）。
//
// 覆盖：三态检测（普通 / 空远端引导 / 非空无 main 拒绝）、首跑 commit+push+已同步、
//       二次运行不重复根提交、非空无 main 保留 typed 错误且不引导、有 main 走普通路径不变、
//       引导时本地记录进初始提交、引导 push 失败 typed + outbox 停放（不谎报成功）、
//       分支不符零写入、坏本地日文件零推送、静态无 force/rebase/reset 越界。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('syncEmptyBootstrap.test.mjs');

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

const {
  runCyclePure, remoteStateDecision,
  E_REMOTE_EMPTY_CODE, E_REMOTE_EMPTY_MESSAGE, E_NO_MAIN_CODE, E_NO_MAIN_MESSAGE,
  BOOTSTRAP_COMMIT_MESSAGE
} = await import('../.build/model/syncCycle.js');
const { makeIntentId, MAX_ATTEMPTS } = await import('../.build/model/syncProtocol.js');
const { canonicalRecordLine, parseTimelineDay } = await import('../.build/model/timeline.js');
const { buildRecordsText } = await import('../.build/model/timelineWrite.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const ETS = join(APP, 'entry', 'src', 'main', 'ets');
function src(rel) {
  return stripComments(readFileSync(join(ETS, rel), 'utf8'));
}

const DAY = '2026-11-19';
const T0930 = `${DAY}T09:30:00+08:00`;
const T1100 = `${DAY}T11:00:00+08:00`;
const NOW = new Date('2026-11-19T10:02:11.000Z');
const SHA = 'a'.repeat(40);
const SCHEMA_TEXT = JSON.stringify({ schemaVersion: 2 });

function rec(overrides = {}) {
  return {
    id: 'a1', ts: T0930, title: '标题', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: T0930, ...overrides
  };
}

function upsertIntent(overrides = {}) {
  const record = overrides.record === undefined ? rec() : overrides.record;
  const date = record.ts.slice(0, 10);
  return {
    intentId: overrides.intentId === undefined
      ? makeIntentId(date, record.id, record.ts, 'upsert') : overrides.intentId,
    op: 'upsert', date: date, id: record.id, ts: record.ts,
    line: canonicalRecordLine(record), enqueuedAt: record.ts,
    attempts: 0, state: 'pending', lastError: '', ...overrides
  };
}

// ---------------------------------------------------------------- fake GitPort（内存 git，含首跑拓展）

class FakeBootstrapGit {
  constructor(opts = {}) {
    this.remote = new Map();
    this.local = new Map();
    /** 服务端是否已有 main。 */
    this.hasMain = opts.hasMain === undefined ? false : opts.hasMain;
    /** 服务端是否一个引用都没有（只有 !hasMain 时有意义）。 */
    this.remoteEmpty = opts.remoteEmpty === undefined ? true : opts.remoteEmpty;
    this.branch = opts.branch === undefined ? 'main' : opts.branch;
    this.pushFailures = opts.pushFailures === undefined ? 0 : opts.pushFailures;
    this.pushError = opts.pushError === undefined ? 'E_PUSH_REJECTED: bootstrap push rejected by test' : opts.pushError;
    this.head = this.hasMain ? SHA : '';
    this.origin = this.head;
    this.trace = [];
    this.commits = [];
    this.added = [];
    this.pushCount = 0;
    this.fetchCount = 0;
    this.commitCount = 0;
    this.resetCount = 0;
    this.layoutProbes = 0;
    this.localPathCalls = 0;
    this.schemaReadCalls = 0;
    this.writeDayCalls = 0;
    /** 探测失败注入（模拟首个调用的认证/传输故障）。 */
    this.probeError = opts.probeError === undefined ? '' : opts.probeError;
    /** 覆盖探测返回（例如只有 tags 的非空远端）。 */
    this.layout = opts.layout === undefined ? null : opts.layout;
    /** 已提交树的指纹：桥侧 NothingToCommit 是 no-op，树未变则不堆叠提交。 */
    this.committedFingerprint = '';
    // 本地骨架由 timelineWriteStore 在启动首用建好（空仓库也照常建），初始提交必须带上它。
    this.local.set('timeline/schema.json', SCHEMA_TEXT);
    if (this.hasMain) {
      this.remote.set('timeline/schema.json', SCHEMA_TEXT);
    }
    if (opts.noLocalPaths === true) {
      // 模拟旧端口：没有 localTimelinePaths，走 syncCycle 的 derived 回退枚举。
      this.localTimelinePaths = undefined;
    }
  }

  setLocalDay(date, records = []) {
    this.local.set(`timeline/${date}/records.json`, buildRecordsText(date, records));
  }

  setRemoteDay(date, records = []) {
    this.remote.set(`timeline/${date}/records.json`, buildRecordsText(date, records));
  }

  async remoteLayout() {
    this.layoutProbes += 1;
    if (this.probeError.length > 0) {
      throw new Error(this.probeError);
    }
    if (this.layout !== null) {
      return this.layout;
    }
    return {
      hasMain: this.hasMain,
      isEmpty: !this.hasMain && this.remoteEmpty,
      refs: this.hasMain ? ['main'] : (this.remoteEmpty ? [] : ['master'])
    };
  }

  async localSchemaText() {
    this.schemaReadCalls += 1;
    return this.local.get('timeline/schema.json') || '';
  }

  /** timeline/** 工作副本内容指纹（只认路径+字节，与真实 git tree 口径一致）。 */
  treeFingerprint() {
    const parts = [];
    const keys = Array.from(this.local.keys()).sort();
    for (const key of keys) {
      if (key.startsWith('timeline/')) {
        parts.push(`${key}\u0000${this.local.get(key)}`);
      }
    }
    return parts.join('\u0001');
  }

  async localTimelinePaths() {
    this.localPathCalls += 1;
    const out = [];
    for (const key of this.local.keys()) {
      if (key.startsWith('timeline/')) { out.push(key); }
    }
    return out.sort();
  }

  async fetchMain() { this.fetchCount += 1; this.trace.push('fetch'); }
  async headSha() { return this.head; }
  async originMainSha() { return this.origin; }
  async showMain(path) { return this.remote.get(path) || ''; }
  async branchName() { return this.branch; }
  async headRelation() {
    if (this.head === this.origin) { return 'equal'; }
    return 'diverged';
  }
  async addPaths(paths) {
    this.trace.push('add');
    this.added.push(paths.slice());
    for (const path of paths) {
      assert.ok(path.startsWith('timeline/'), `提交路径越界：${path}`);
    }
  }
  async commit(message) {
    this.trace.push('commit');
    // 真实桥把 NothingToCommit 当合法 no-op：树未变就不建新提交、HEAD 不动（调用仍被记录）。
    const fingerprint = this.treeFingerprint();
    if (fingerprint === this.committedFingerprint) {
      return;
    }
    this.committedFingerprint = fingerprint;
    this.commitCount += 1;
    this.commits.push(message);
    this.head = `c${String(this.commitCount).padStart(39, '0')}`;
  }
  async pushMain() {
    this.trace.push('push');
    this.pushCount += 1;
    if (this.pushFailures > 0) {
      this.pushFailures -= 1;
      throw new Error(this.pushError);
    }
    this.hasMain = true;           // push 在远端创建 main（set upstream 的前置）
    this.origin = this.head;
    for (const [path, text] of this.local) {
      if (path.startsWith('timeline/')) { this.remote.set(path, text); }
    }
  }
  async resetHardOrigin() { this.resetCount += 1; this.head = this.origin; }
  async fastForward() { this.head = this.origin; }
}

function readDayOf(fake) {
  return async (date) => ({
    remote: fake.remote.get(`timeline/${date}/records.json`) || '',
    local: fake.local.get(`timeline/${date}/records.json`) || '',
    deleted: fake.local.get(`timeline/${date}/deleted.jsonl`) || '',
    restore: fake.local.get(`timeline/${date}/restore.jsonl`) || '',
    remoteDeleted: fake.remote.get(`timeline/${date}/deleted.jsonl`) || '',
    remoteRestore: fake.remote.get(`timeline/${date}/restore.jsonl`) || ''
  });
}

function writeOf(fake, opts = {}) {
  // 默认模拟 timelineWriteStore.requireSchema()/ensureSkeleton()：首次 writeDay 建规范 v2 标记。
  const createSchema = opts.createSchema !== false;
  return {
    writeDay: async (date, texts) => {
      fake.writeDayCalls += 1;
      if (createSchema && !fake.local.has('timeline/schema.json')) {
        fake.local.set('timeline/schema.json', '{"schemaVersion":2}\n');
      }
      fake.local.set(`timeline/${date}/records.json`, texts.records);
      fake.local.set(`timeline/${date}/deleted.jsonl`, texts.deleted);
      fake.local.set(`timeline/${date}/restore.jsonl`, texts.restore);
      // 与真实 WritePort 一致：有审计行才写 conflicts.jsonl（fake 以前整个忽略，故 m3 无法断言）。
      if (texts.conflicts !== undefined && texts.conflicts.length > 0) {
        fake.local.set(`timeline/${date}/conflicts.jsonl`,
          texts.conflicts.map((line) => `${line}\n`).join(''));
      }
    }
  };
}

function deriveDays(fake, outbox) {
  const set = new Set();
  const pattern = /^timeline\/(\d{4}-\d{2}-\d{2})\/records\.json$/;
  for (const map of [fake.remote, fake.local]) {
    for (const key of map.keys()) {
      const matched = pattern.exec(key);
      if (matched !== null) { set.add(matched[1]); }
    }
  }
  for (const entry of outbox) { set.add(entry.date); }
  return Array.from(set).sort();
}

function runWith(fake, outbox, write) {
  return runCyclePure(fake, deriveDays(fake, outbox), readDayOf(fake), outbox, NOW, write);
}

function run(fake, outbox) {
  return runWith(fake, outbox, writeOf(fake));
}

// ---------------------------------------------------------------- 检测规则（纯判定）

test('1 remoteStateDecision: main→normal, empty→bootstrap, non-empty-no-main→no-main', () => {
  assert.equal(remoteStateDecision(true, false), 'normal');
  assert.equal(remoteStateDecision(true, true), 'normal', 'hasMain 优先，isEmpty 组合不影响普通路径');
  assert.equal(remoteStateDecision(false, true), 'bootstrap');
  assert.equal(remoteStateDecision(false, false), 'no-main');
  assert.equal(E_REMOTE_EMPTY_CODE, 'E_REMOTE_EMPTY');
  assert.match(E_REMOTE_EMPTY_MESSAGE, /首次同步的正常起点/);
  assert.equal(E_NO_MAIN_CODE, 'E_GIT');
  assert.match(E_NO_MAIN_MESSAGE, /Could not find origin\/main/);
});

// ---------------------------------------------------------------- 首跑引导

test('2 empty remote → bootstrap commit + push + 已同步, intent drained', async () => {
  const fake = new FakeBootstrapGit();
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ok');
  assert.equal(result.message, '已同步', '继续普通周期后用户看到既有的三态成功文案');
  assert.equal(result.bootstrapped, true);
  assert.equal(result.applied, 1);
  assert.equal(result.pending, 0);
  assert.deepEqual(fake.commits, [BOOTSTRAP_COMMIT_MESSAGE], '引导提交信息固定');
  assert.equal(fake.hasMain, true, 'push 在远端创建了 main');
  assert.ok(fake.pushCount >= 1);
  assert.equal(fake.resetCount, 0, '引导路径不 reset');
  assert.ok(fake.added[0].includes('timeline/schema.json'), 'schema 标记进初始提交');
});

test('3 second run → no duplicate root commit (main exists → normal path)', async () => {
  const fake = new FakeBootstrapGit();
  const outbox = [upsertIntent()];
  const first = await run(fake, outbox);
  assert.equal(first.bootstrapped, true);
  assert.equal(fake.commitCount, 1, '首跑只建一个根提交');

  const second = await run(fake, first.resultOutbox);
  assert.equal(second.ok, true);
  assert.notEqual(second.bootstrapped, true, '第二次不再走引导');
  assert.equal(fake.commitCount, 1, '第二次没有第二个提交（无重复根提交）');
  assert.deepEqual(fake.commits, [BOOTSTRAP_COMMIT_MESSAGE]);
  assert.equal(fake.hasMain, true);
});

test('4 non-empty remote without main → typed error, no bootstrap, no writes', async () => {
  const fake = new FakeBootstrapGit({ hasMain: false, remoteEmpty: false });
  const intent = upsertIntent();
  const result = await run(fake, [intent]);
  assert.equal(result.ok, false);
  assert.equal(result.code, E_NO_MAIN_CODE);
  assert.equal(result.message, E_NO_MAIN_MESSAGE, '保留既有 typed 错误 + 中文下一步');
  assert.notEqual(result.bootstrapped, true);
  assert.equal(fake.commitCount, 0, '绝不覆盖别人的历史');
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.localPathCalls, 0, '未进入引导的初始树枚举');
  assert.equal(result.resultOutbox.length, 1, '意图留在 outbox');
});

test('5 remote with main → normal path unchanged (fetch→gate→[v2] sync commit)', async () => {
  const fake = new FakeBootstrapGit({ hasMain: true });
  fake.setRemoteDay(DAY, [rec({ id: 'remote-1', ts: T0930 })]);
  const result = await run(fake, [upsertIntent({ record: rec({ id: 'local-1', ts: T1100 }) })]);
  assert.equal(result.ok, true);
  assert.notEqual(result.bootstrapped, true);
  assert.equal(fake.layoutProbes, 1);
  assert.equal(fake.fetchCount, 1, '普通路径仍先 fetch 再门禁');
  assert.equal(fake.localPathCalls, 0, '普通路径不枚举本地初始树');
  assert.ok(fake.commits[0].startsWith('[v2] sync '), '普通周期提交信息不变');
  assert.equal(fake.commits[0], '[v2] sync 1 days');
  const parsed = parseTimelineDay(fake.remote.get(`timeline/${DAY}/records.json`), DAY);
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id).sort(), ['local-1', 'remote-1']);
});

test('6 bootstrap with local records → they land in the initial commit', async () => {
  const fake = new FakeBootstrapGit();
  fake.setLocalDay(DAY, [rec({ id: 'preexisting', ts: T0930 })]);
  const result = await run(fake, []);
  assert.equal(result.ok, true);
  assert.equal(result.bootstrapped, true);
  assert.ok(fake.added[0].includes(`timeline/${DAY}/records.json`), '本地已有日文件进初始提交树');
  assert.ok(fake.added[0].includes('timeline/schema.json'), 'schema 标记进初始提交树');
  assert.equal(fake.added[0].some((p) => !p.startsWith('timeline/')), false, '初始树只含 timeline/**');
  const remoteText = fake.remote.get(`timeline/${DAY}/records.json`);
  assert.ok(remoteText.includes('"id":"preexisting"'), '本地记录在远端初始提交中可见');
});

test('7 bootstrap push failure → typed error + outbox park, no success claimed', async () => {
  const fake = new FakeBootstrapGit({ pushFailures: 99, pushError: 'E_IO: bootstrap network down' });
  const intent = upsertIntent();
  const result = await run(fake, [intent]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_IO', 'push 原始 typed 码保真');
  assert.match(result.message, /首次初始化 main 推送失败/);
  assert.notEqual(result.message, '已同步', '绝不把本地已提交但未推送的中间态报成成功');
  assert.equal(result.bootstrapped, true);
  assert.equal(result.resultOutbox.length, 1, '意图停在 outbox');
  assert.equal(result.resultOutbox[0].attempts, 1, '引导 push 失败也计入跨会话预算');
  assert.ok(result.pending >= 1);
  assert.equal(fake.resetCount, 0, '引导失败不走 reset');
});

test('7b bootstrap push failure exhausts budget → failed terminal state', async () => {
  const nearly = upsertIntent({ attempts: MAX_ATTEMPTS - 1 });
  const fake = new FakeBootstrapGit({ pushFailures: 99, pushError: 'E_AUTH: bootstrap token rejected' });
  const result = await run(fake, [nearly]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_AUTH');
  assert.equal(result.resultOutbox[0].state, 'failed');
  assert.equal(result.resultOutbox[0].attempts, MAX_ATTEMPTS);
});

// ---------------------------------------------------------------- 零写入 / 静态守卫

test('8 empty remote but branch != main → typed E_BRANCH_MISMATCH, zero writes', async () => {
  const fake = new FakeBootstrapGit({ branch: 'dev' });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_BRANCH_MISMATCH');
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.localPathCalls, 0);
});

test('9 corrupt local day during bootstrap → E_CORRUPT, no commit / push', async () => {
  const fake = new FakeBootstrapGit();
  const path = `timeline/${DAY}/records.json`;
  fake.local.set(path, 'this-is-not-json');
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.code, 'E_CORRUPT');
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.remote.get(path), undefined);
});

test('10 static: bootstrap adds no force / rebase / reset outside the rejection path', () => {
  // 本模块新增/触碰的文件：syncCycle.ts + gitRunner.ets（git-bridge.js 单独查）。
  // syncProtocolStore.ets 的 `'reset', '--hard'` 是既有且**唯一**的拒推路径，不在本模块改动范围内，
  // 由 syncProtocol.test.mjs 的 test 50 钉死「恰好一次且位于 catch 内」，此处不重复禁止。
  for (const rel of ['model/syncCycle.ts', 'services/gitRunner.ets']) {
    const code = src(rel);
    assert.doesNotMatch(code, /--force/, rel);
    assert.doesNotMatch(code, /\brebase\b/, rel);
    assert.doesNotMatch(code, /\bclean\b/, rel);
    assert.doesNotMatch(code, /--hard/, rel);
    assert.doesNotMatch(code, /devices\//, rel);
  }
  assert.equal((src('services/syncProtocolStore.ets').match(/'reset', '--hard'/g) || []).length, 1,
    'syncProtocolStore 的 reset --hard 仍是唯一一处（拒推路径）');
  const model = src('model/syncCycle.ts');
  assert.match(model, /function remoteStateDecision\(hasMain: boolean, isEmpty: boolean\)/);
  assert.match(model, /BOOTSTRAP_COMMIT_MESSAGE: string = '\[v2\] bootstrap main'/);
  assert.match(model, /await port\.commit\(BOOTSTRAP_COMMIT_MESSAGE\)/);
  // M3b：缺标记与未知版本必须走同一个纯决策助手，不能靠 parseSchemaMarker 的空串结果一刀切。
  assert.match(model, /decideFreshStart\(schemaText\)/);
  // 规则 6：骨架只能由 writer 建，纯模型不得自己调 ensureSkeleton（零新增 IO 面）。
  assert.doesNotMatch(model, /ensureSkeleton\(/);
  const runner = src('services/gitRunner.ets');
  assert.match(runner, /v2Git\('remoteLayout', args\)/);
  assert.match(runner, /v2Git\('listLocalTimeline', args\)/);
  assert.match(runner, /v2Git\('readLocalTimelineSchema', args\)/, 'M3：runner 必须实现本地 schema 读取');
  const bridge = readFileSync(
    join(APP, 'entry', 'src', 'main', 'resources', 'rawfile', 'git', 'git-bridge.js'), 'utf8');
  assert.ok(bridge.includes("if (op === 'remoteLayout')"));
  assert.ok(bridge.includes("if (op === 'listLocalTimeline')"));
  // M1：emptiness 必须覆盖所有引用类别，注释也要写明「任何 heads/tags/pull 引用都没有才算空」。
  assert.ok(bridge.includes('任何 heads/tags/pull 引用都没有才算空仓库'));
  assert.ok(bridge.includes('isEmpty: allNames.length === 0'));
  // M3：桥侧用与 listFilesRecursive 相同的宿主 fs 访问器读本地 schema 标记。
  assert.ok(bridge.includes("if (op === 'readLocalTimelineSchema')"));
  assert.ok(bridge.includes('readHostFileBase64(schemaPath)'));
  assert.ok(bridge.includes('git.getRemoteInfo('));
  assert.ok(bridge.includes("remote: 'origin', ref: 'main', force: false"), 'v2 push 仍 force:false');
});

test('11 bootstrap probe runs before fetch, so empty remote never hits raw fetch error', async () => {
  const fake = new FakeBootstrapGit();
  await run(fake, []);
  const addAt = fake.trace.indexOf('add');
  const commitAt = fake.trace.indexOf('commit');
  const pushAt = fake.trace.indexOf('push');
  assert.ok(addAt >= 0 && commitAt > addAt && pushAt > commitAt,
    `引导 git 顺序错误：${fake.trace.join('→')}`);
  // 引导阶段不 fetch（空远端 fetch 会抛 "Could not find origin/main"），fetch 只发生在推送建 main 之后。
  const firstFetchAt = fake.trace.indexOf('fetch');
  assert.ok(firstFetchAt < 0 || firstFetchAt > pushAt,
    '首跑探测必须先于 fetch；fetch 只在建好 main 后执行');
});

// ---------------------------------------------------------------- review 修复回归

test('12 tags-only remote → typed E_GIT, no bootstrap (M1)', async () => {
  // 钉住 M1：只有 tags 的远端（refs:['v1']）也是「非空但没有 main」，必须保留 typed 错误。
  const fake = new FakeBootstrapGit({ layout: { hasMain: false, isEmpty: false, refs: ['v1'] } });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, false);
  assert.equal(result.code, E_NO_MAIN_CODE);
  assert.equal(result.message, E_NO_MAIN_MESSAGE);
  assert.notEqual(result.bootstrapped, true);
  assert.equal(fake.commitCount, 0, '绝不覆盖别人的历史');
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.localPathCalls, 0, '未进入引导的初始树枚举');
  assert.equal(result.resultOutbox.length, 1, '意图留在 outbox');
});

test('13 remoteLayout throws E_AUTH → typed probe failure, outbox intact (M2)', async () => {
  // 钉住 M2：首个探测调用抛错不得变成未捕获 rejection，底层 typed 码必须保真。
  const fake = new FakeBootstrapGit({ probeError: 'E_AUTH: token rejected by probe' });
  const intent = upsertIntent();
  const result = await run(fake, [intent]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_AUTH');
  assert.match(result.message, /远端状态探测失败/);
  assert.match(result.message, /检查网络与仓库地址后点「重试同步」/);
  assert.equal(result.attempts, 0, '探测阶段没有推送，不能 bump 跨会话预算');
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.fetchCount, 0);
  assert.equal(fake.localPathCalls, 0);
  assert.deepEqual(result.resultOutbox, [intent], '意图原样留在 outbox');
});

test('14 remoteLayout throws plain transport error → E_GIT, never isEmpty (M2)', async () => {
  // 钉住 M2：非 typed 传输错误归 E_GIT，绝不能映射成 isEmpty=true 去引导空仓库。
  const fake = new FakeBootstrapGit({ probeError: 'socket hang up' });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_GIT');
  assert.match(result.message, /远端状态探测失败/);
  assert.notEqual(result.bootstrapped, true);
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(result.resultOutbox.length, 1);
});

test('15 unknown local schemaVersion on empty remote → E_SCHEMA_UNKNOWN, zero writes (M3)', async () => {
  // 钉住 M3：§11 门禁先于任何 timeline/** 写；schemaVersion=99 不得进初始提交，本地字节不变。
  const fake = new FakeBootstrapGit();
  fake.local.set('timeline/schema.json', '{"schemaVersion":99}');
  const before = fake.local.get('timeline/schema.json');
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_SCHEMA_UNKNOWN');
  assert.match(result.message, /仓库结构版本不认识/);
  assert.equal(result.resultOutbox.length, 1);
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.localPathCalls, 0, '门禁失败前不得枚举初始树');
  assert.equal(fake.schemaReadCalls, 1, 'schema 必须在写前被读取一次');
  assert.equal(fake.local.get('timeline/schema.json'), before, '本地 schema 文件字节未被改写');
});

test('16 port without localSchemaText → fail-closed E_SCHEMA_UNKNOWN (M3)', async () => {
  // 钉住 M3：端口没实现新读标记方法时同样 fail-closed，绝不「先写后拒」。
  const fake = new FakeBootstrapGit();
  fake.localSchemaText = undefined;
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_SCHEMA_UNKNOWN');
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.localPathCalls, 0);
});

test('17 push failed once then retried → one root commit, eventual 已同步 (m1)', async () => {
  // 钉住 m1：fake 像真实桥一样把 NothingToCommit 当 no-op；推送失败后重跑不堆叠重复根提交。
  const fake = new FakeBootstrapGit({ pushFailures: 1, pushError: 'E_IO: transient push failure' });
  const first = await run(fake, [upsertIntent()]);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'E_IO');
  assert.equal(fake.hasMain, false, '第一次推送失败，远端仍无 main');
  assert.equal(fake.commitCount, 1, '第一次只建一个本地根提交');

  const second = await run(fake, first.resultOutbox);
  assert.equal(second.ok, true, '重试后推送成功');
  assert.equal(second.message, '已同步');
  assert.equal(second.bootstrapped, true, '第二次仍从空远端重新引导');
  assert.equal(fake.hasMain, true);
  assert.equal(fake.commitCount, 1, '树未变 → commit no-op，无重复根提交');
  assert.deepEqual(fake.commits, [BOOTSTRAP_COMMIT_MESSAGE]);
  assert.equal(second.resultOutbox.length, 0, '意图最终出队');
});

test('18 fallback without localTimelinePaths → committed tree matches written files incl conflicts (m3)', async () => {
  // 钉住 m3：回退枚举要逐字列出 WritePort 写下的 records/deleted/restore/conflicts；
  // fake 现在记录 texts.conflicts，同 id/ts 不同字节的裁决败者必须落 conflicts.jsonl。
  const fake = new FakeBootstrapGit({ noLocalPaths: true });
  fake.setLocalDay(DAY, [rec({ id: 'same', ts: T0930, body: 'local' })]);
  const rival = upsertIntent({ record: rec({ id: 'same', ts: T0930, body: 'rival' }) });
  const result = await run(fake, [rival]);
  assert.equal(result.ok, true);
  assert.equal(fake.localPathCalls, 0, '确实走了 derived 回退');
  const paths = fake.added[0];
  assert.ok(paths.includes(`timeline/${DAY}/records.json`));
  assert.ok(paths.includes(`timeline/${DAY}/deleted.jsonl`));
  assert.ok(paths.includes(`timeline/${DAY}/restore.jsonl`));
  assert.ok(paths.includes(`timeline/${DAY}/conflicts.jsonl`));
  const conflictsText = fake.local.get(`timeline/${DAY}/conflicts.jsonl`);
  assert.ok(conflictsText !== undefined && conflictsText.includes('"id":"same"'),
    'conflicts.jsonl 审计行已落盘');
  assert.equal(fake.remote.get(`timeline/${DAY}/conflicts.jsonl`), conflictsText,
    '回退路径写下的 conflicts.jsonl 也进了初始提交');
  // 同 id/ts 的字节裁决在引导阶段已完成：胜者进 records.json，败者进 conflicts.jsonl；
  // 恢复的普通周期重放同一意图时逐字节命中胜者，不再产生第二条审计行（幂等）。
  assert.equal(result.conflicts, 0, '恢复周期不再重复记冲突');
  assert.ok(fake.remote.get(`timeline/${DAY}/records.json`).includes('"body":"rival"'),
    '字节较大的胜者进入初始提交');
  for (const key of fake.local.keys()) {
    assert.ok(paths.includes(key), `工作副本文件未进初始提交：${key}`);
  }
});

// ---------------------------------------------------------------- M3b：缺标记 = 正常起点

test('19 missing schema + writer → skeleton created, bootstrap succeeds (M3b)', async () => {
  // 钉住规则 3：真·全新安装缺 schema.json 时放行到阶段 1，writer 建骨架后复核通过再提交。
  const fake = new FakeBootstrapGit();
  fake.local.delete('timeline/schema.json');
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ok');
  assert.equal(result.message, '已同步');
  assert.equal(result.bootstrapped, true);
  assert.equal(fake.commitCount, 1);
  assert.ok(fake.added[0].includes('timeline/schema.json'), '骨架进入初始提交树');
  assert.deepEqual(JSON.parse(fake.remote.get('timeline/schema.json')), { schemaVersion: 2 },
    '远端副本带合法 v2 标记');
  assert.equal(fake.writeDayCalls, 2, '引导阶段 1 一次 + 恢复的普通周期一次');
  assert.equal(fake.schemaReadCalls, 2, '写前读一次，阶段 1 后复核一次');
});

test('20 missing schema without WritePort → fail-closed E_SCHEMA_UNKNOWN (M3b)', async () => {
  // 钉住规则 4：纯预览没有 writer 建骨架，缺标记只能 fail-closed（零写入、零提交、零推送）。
  const fake = new FakeBootstrapGit();
  fake.local.delete('timeline/schema.json');
  const intent = upsertIntent();
  const result = await runWith(fake, [intent], undefined);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_SCHEMA_UNKNOWN');
  assert.equal(fake.writeDayCalls, 0);
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.localPathCalls, 0);
  assert.deepEqual(result.resultOutbox, [intent], '意图原样留在 outbox');
});

test('21 present but unparseable schema → E_SCHEMA_UNKNOWN, bytes untouched (M3b)', async () => {
  // 钉住规则 1：decideFreshStart 判 unsupported（文件在但不是 v2 标记）必须零写入拒绝。
  const fake = new FakeBootstrapGit();
  fake.local.set('timeline/schema.json', 'not-json');
  const before = fake.local.get('timeline/schema.json');
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_SCHEMA_UNKNOWN');
  assert.equal(fake.writeDayCalls, 0, '门禁拒绝前没有任何 timeline 写入');
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.schemaReadCalls, 1, '阶段 1 前就拒绝，不做复核读取');
  assert.equal(fake.local.get('timeline/schema.json'), before, '文件字节未被改写');
});

test('22 writer fails to create schema → post-stage-1 re-read rejects before commit (M3b)', async () => {
  // 钉住规则 3 兜底：writer 在但没建标记时，阶段 1 后复核必须拦住，绝不提交无标记的树。
  const fake = new FakeBootstrapGit();
  fake.local.delete('timeline/schema.json');
  const result = await runWith(fake, [upsertIntent()], writeOf(fake, { createSchema: false }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_SCHEMA_UNKNOWN');
  assert.equal(fake.writeDayCalls, 1, '阶段 1 确实写过日文件');
  assert.equal(fake.schemaReadCalls, 2, '写前 + 阶段 1 后各读一次');
  assert.equal(fake.added.length, 0, '复核失败前不得 addPaths');
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.local.has('timeline/schema.json'), false, '纯模型没有自己建标记');
});

// ---------------------------------------------------------------- r2：生产闭环 + 就绪码保真

test('23 static: production writeDay ensures skeleton before any write (M3b-prod)', () => {
  // M3b 生产闭环的唯一一行：syncProtocolStore.writeDay 先 ensureSkeleton() 再 writeDayTexts；
  // 回滚路径 = 只删这一行（该文件其余部分不动，git diff 必须是 1 insertion）。
  const store = src('services/syncProtocolStore.ets');
  assert.equal((store.match(/ensureSkeleton\(/g) || []).length, 1,
    '全文件恰好一次 ensureSkeleton(，即 M3b 生产闭环那一行');
  const start = store.indexOf('writeDay: async (date: string, texts: DayWriteTexts)');
  assert.ok(start >= 0, '找到生产 WritePort 的 writeDay');
  const end = store.indexOf('this.writeDayTexts(date, texts)', start);
  assert.ok(end > start, 'writeDay 仍委托给 writeDayTexts');
  const between = store.slice(start, end);
  assert.match(between, /timelineWriteStore\.ensureSkeleton\(\)/,
    '任何 records/账本写入前先幂等建 v2 骨架');
  assert.doesNotMatch(between, /atomicReplaceText|appendDedupLines/,
    '骨架调用必须在落盘动作之前');
});

test('24 remoteLayout throws E_SYNC_UNAVAILABLE → typed readiness code, not E_GIT (M2b)', async () => {
  // 钉住 M2b：bridge 未就绪不能塌缩成 E_GIT，必须保留就绪码与「稍候自动重试」的中文下一步。
  const fake = new FakeBootstrapGit({
    probeError: 'E_SYNC_UNAVAILABLE: 同步内核或 GitRunner 未就绪'
  });
  const intent = upsertIntent();
  const result = await run(fake, [intent]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_SYNC_UNAVAILABLE');
  assert.match(result.message, /远端状态探测失败/);
  assert.match(result.message, /页面就绪后会自动重试/);
  assert.doesNotMatch(result.message, /检查网络与仓库地址/);
  assert.equal(result.attempts, 0, '探测阶段没有推送，不 bump 预算');
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.fetchCount, 0);
  assert.deepEqual(result.resultOutbox, [intent], '意图原样留在 outbox');
});
