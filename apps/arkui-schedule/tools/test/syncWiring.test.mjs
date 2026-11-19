// mod-v2-sync-wiring：syncCycle 纯周期的端到端行为（fake GitPort，内存 git）+ 接线静态契约。
//
// 前置构建：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型从 ../.build 导入；.ets 服务/页面因 @kit.* 只能在 Node 里做源码形状断言（本仓既有口径）。
//
// 覆盖：happy（gate→union→commit→push→outbox 排空）、push 拒一次（reset→replay→成功）、
//       一直拒（MAX_ATTEMPTS 耗尽→failed/pending）、远端删除+陈旧 upsert（dropped 不出队）、
//       behind→ff 放行 / ahead·diverged·schema·branch→E_* 零写入、activation 决策表
//       （schema 错 / 并存但 timeline 空 / 并存未确认 needsConfirm / 确认后 ok / 周期不可用），
//       以及「激活开关 / 并存专用确认文案与裁决键 / setRunner / tri-state 行 /
//       无 force-push·merge·rebase·clean·devices/ 写」静态断言。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('syncWiring.test.mjs');

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
  runCyclePure, dayIntegrityError, E_CORRUPT_CODE, E_CORRUPT_MESSAGE
} = await import('../.build/model/syncCycle.js');
const {
  makeIntentId, MAX_ATTEMPTS, SYNC_RETRY_ERROR, resetForRetry
} = await import('../.build/model/syncProtocol.js');
const {
  PERSISTENT_BINDINGS, PERSISTENT_READ_MODE_KEY, PERSISTENT_V2_WRITE_KEY,
  PERSISTENT_V1_RETAINED_KEY, bindingFor
} = await import('../.build/model/persistentSettings.js');
const { canonicalRecordLine, parseTimelineDay, parseLedger } =
  await import('../.build/model/timeline.js');
const { buildRecordsText, ledgerDeleteLine, ledgerRestoreLine } =
  await import('../.build/model/timelineWrite.js');
const { decideActivation, ACTIVATION_MESSAGES } = await import('../.build/model/v2Activation.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const ETS = join(APP, 'entry', 'src', 'main', 'ets');
function src(rel) {
  return stripComments(readFileSync(join(ETS, rel), 'utf8'));
}

const DAY = '2026-11-19';
const T0930 = `${DAY}T09:30:00+08:00`;
const T1100 = `${DAY}T11:00:00+08:00`;
const T1400 = `${DAY}T14:00:00+08:00`;
const NOW = new Date('2026-11-19T10:02:11.000Z');
const SHA = 'a'.repeat(40);

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

function deleteIntent(id, ts, overrides = {}) {
  return {
    intentId: overrides.intentId === undefined ? makeIntentId(ts.slice(0, 10), id, ts, 'delete') : overrides.intentId,
    op: 'delete', date: ts.slice(0, 10), id: id, ts: ts,
    line: ledgerDeleteLine(id, ts, ts), enqueuedAt: ts,
    attempts: 0, state: 'pending', lastError: '', ...overrides
  };
}

// ---------------------------------------------------------------- fake GitPort（内存 git）

class FakeGit {
  constructor(opts = {}) {
    this.remote = new Map();
    this.local = new Map();
    this.schema = opts.schema === undefined ? 2 : opts.schema;
    this.branch = opts.branch === undefined ? 'main' : opts.branch;
    this.relationOverride = opts.relation === undefined ? null : opts.relation;
    this.pushFailures = opts.pushFailures === undefined ? 0 : opts.pushFailures;
    this.ffFails = opts.ffFails === true;
    this.head = SHA;
    this.origin = opts.origin === undefined ? SHA : opts.origin;
    this.fetchCount = 0;
    this.commitCount = 0;
    this.pushCount = 0;
    this.resetCount = 0;
    this.ffCount = 0;
    this.commits = [];
    this.added = [];
    this.writes = 0;
    if (this.schema === null) {
      this.remote.delete('timeline/schema.json');
    } else {
      this.remote.set('timeline/schema.json', JSON.stringify({ schemaVersion: this.schema }));
    }
  }

  setRemoteDay(date, records = [], deleted = '', restore = '') {
    this.remote.set(`timeline/${date}/records.json`, buildRecordsText(date, records));
    this.remote.set(`timeline/${date}/deleted.jsonl`, deleted);
    this.remote.set(`timeline/${date}/restore.jsonl`, restore);
  }

  setLocalDay(date, records = [], deleted = '', restore = '') {
    this.local.set(`timeline/${date}/records.json`, buildRecordsText(date, records));
    this.local.set(`timeline/${date}/deleted.jsonl`, deleted);
    this.local.set(`timeline/${date}/restore.jsonl`, restore);
  }

  async fetchMain() { this.fetchCount += 1; }
  async headSha() { return this.head; }
  async originMainSha() { return this.origin; }
  async showMain(path) { return this.remote.get(path) || ''; }
  async branchName() { return this.branch; }
  async headRelation() {
    if (this.relationOverride !== null) { return this.relationOverride; }
    return this.head === this.origin ? 'equal' : 'diverged';
  }
  async addPaths(paths) {
    this.added.push(paths.slice());
    for (const path of paths) {
      assert.ok(path.startsWith('timeline/'), `提交路径越界：${path}`);
    }
  }
  async commit(message) {
    this.commitCount += 1;
    this.commits.push(message);
    this.head = `c${String(this.commitCount).padStart(39, '0')}`;
  }
  async pushMain() {
    this.pushCount += 1;
    if (this.pushFailures > 0) {
      this.pushFailures -= 1;
      throw new Error('E_PUSH_REJECTED: push rejected by test');
    }
    this.origin = this.head;
    // 远端拿到本次落盘的 timeline 文件（模拟真实 push）
    for (const [path, text] of this.local) {
      if (path.startsWith('timeline/')) { this.remote.set(path, text); }
    }
  }
  async resetHardOrigin() {
    this.resetCount += 1;
    this.head = this.origin;
    this.relationOverride = null;
    for (const key of Array.from(this.remote.keys())) {
      if (key.startsWith('timeline/')) { this.local.set(key, this.remote.get(key)); }
    }
  }
  async fastForward() {
    this.ffCount += 1;
    if (this.ffFails) { throw new Error('E_NOT_SYNCED: ff failed by test'); }
    this.head = this.origin;
    for (const key of Array.from(this.remote.keys())) {
      if (key.startsWith('timeline/')) { this.local.set(key, this.remote.get(key)); }
    }
  }
  async listRemoteDays() {
    const set = new Set();
    for (const key of this.remote.keys()) {
      const matched = /^timeline\/(\d{4}-\d{2}-\d{2})\/records\.json$/.exec(key);
      if (matched !== null) { set.add(matched[1]); }
    }
    return Array.from(set).sort();
  }
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

function writeOf(fake) {
  return {
    writeDay: async (date, texts) => {
      fake.writes += 1;
      fake.local.set(`timeline/${date}/records.json`, texts.records);
      fake.local.set(`timeline/${date}/deleted.jsonl`, texts.deleted);
      fake.local.set(`timeline/${date}/restore.jsonl`, texts.restore);
      if (texts.conflicts.length > 0) {
        const path = `timeline/${date}/conflicts.jsonl`;
        fake.local.set(path, `${fake.local.get(path) || ''}${texts.conflicts.join('\n')}\n`);
      }
    }
  };
}

/**
 * P1-1：不再硬编码 days=[DAY]。按服务层同口径从「本地日 + 远端日 + outbox 意图日」派生，
 * 这样「只有停放意图才存在的全新日期」才会进入周期 —— 正是原来 44 例无法发现的问题。
 */
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

function run(fake, outbox, days) {
  const effective = days === undefined ? deriveDays(fake, outbox) : days;
  return runCyclePure(fake, effective, readDayOf(fake), outbox, NOW, writeOf(fake));
}

/** 带落盘探针的 run：记录每次 writeOutbox 的 attempts 快照（P1-3）。 */
async function runTracked(fake, outbox) {
  const diskSnapshots = [];
  const write = {
    writeDay: writeOf(fake).writeDay,
    writeOutbox: async (entries) => {
      diskSnapshots.push(entries.map((entry) => entry.attempts));
    }
  };
  const result = await runCyclePure(
    fake, deriveDays(fake, outbox), readDayOf(fake), outbox, NOW, write);
  return { result: result, diskSnapshots: diskSnapshots };
}

// ---------------------------------------------------------------- e2e：happy / 拒推 / 门禁

test('1 happy: gate→union→commit→push→outbox drain, tri-state zero', async () => {
  const fake = new FakeGit();
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ok');
  assert.deepEqual(result.days, [DAY]);
  assert.equal(result.applied, 1);
  assert.equal(result.pending, 0);
  assert.equal(result.failed, 0);
  assert.equal(fake.fetchCount, 1);
  assert.equal(fake.commitCount, 1);
  assert.equal(fake.pushCount, 1);
  assert.equal(fake.resetCount, 0, '成功路径绝不 reset');
  assert.equal(fake.commits[0], '[v2] sync 1 days');
  assert.equal(result.resultOutbox.length, 0, 'applied 必须出队');
});

test('2 happy writes union text into the working copy via WritePort', async () => {
  const fake = new FakeGit();
  await run(fake, [upsertIntent()]);
  assert.equal(fake.writes, 1);
  const parsed = parseTimelineDay(fake.local.get(`timeline/${DAY}/records.json`), DAY);
  assert.equal(parsed.day.allRecords.length, 1);
  assert.equal(parsed.day.allRecords[0].id, 'a1');
});

test('3 addPaths only timeline/** commit paths; remote got the local day file', async () => {
  const fake = new FakeGit();
  await run(fake, [upsertIntent()]);
  assert.ok(fake.added[0].includes(`timeline/${DAY}/records.json`));
  assert.ok(fake.remote.get(`timeline/${DAY}/records.json`).includes('"id":"a1"'));
});

test('4 no changes and no intents: no commit, still one push', async () => {
  const fake = new FakeGit();
  const result = await run(fake, [], []);
  assert.equal(result.ok, true);
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 1);
  assert.equal(result.applied, 0);
});

test('5 push rejected once: reset→replay→success, attempts=2, outbox drained', async () => {
  const fake = new FakeGit({ pushFailures: 1 });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(fake.pushCount, 2);
  assert.equal(fake.resetCount, 1);
  assert.equal(result.resultOutbox.length, 0);
  assert.equal(result.applied, 1);
});

test('6 push rejection resets to origin before replay (no force-push, no history rewrite)', async () => {
  const fake = new FakeGit({ pushFailures: 1 });
  await run(fake, [upsertIntent()]);
  assert.equal(fake.resetCount, 1);
  assert.equal(fake.head, fake.origin, 'reset 后 HEAD==origin/main');
});

test('7 push always rejected: E_PUSH_REJECTED, MAX_ATTEMPTS, failed=1, pending=0', async () => {
  const fake = new FakeGit({ pushFailures: 99 });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_PUSH_REJECTED');
  // mod-push-detail: FakeGit throws a detail-bearing 'E_PUSH_REJECTED: push rejected by test';
  // that raw detail now survives into the reason (generic Chinese next-step still kept).
  assert.ok(result.message.includes('E_PUSH_REJECTED: push rejected by test'),
    'detail-bearing rejection keeps its raw text in the user-visible reason');
  assert.ok(result.message.startsWith(SYNC_RETRY_ERROR), 'generic Chinese next-step still present');
  assert.equal(result.attempts, MAX_ATTEMPTS);
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 0);
  assert.equal(fake.pushCount, MAX_ATTEMPTS);
  assert.equal(fake.resetCount, MAX_ATTEMPTS);
});

test('8 exhausted intent stays failed in outbox (manual retry only)', async () => {
  const fake = new FakeGit({ pushFailures: 99 });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.resultOutbox.length, 1);
  assert.equal(result.resultOutbox[0].state, 'failed');
  assert.equal(result.resultOutbox[0].attempts, MAX_ATTEMPTS);
});

test('9 remote delete + stale upsert: dropped, never applied, record absent', async () => {
  const fake = new FakeGit();
  const del = ledgerDeleteLine('gone', T1100, T1100);
  fake.setRemoteDay(DAY, [], `${del}\n`, '');
  const stale = upsertIntent({ intentId: 'stale-up', record: rec({ id: 'gone' }) });
  const result = await run(fake, [stale]);
  assert.equal(result.dropped, 1);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.droppedIds, ['stale-up']);
  assert.equal(result.resultOutbox.length, 0, 'dropped 必须出队、不重试');
  const text = fake.local.get(`timeline/${DAY}/records.json`);
  assert.equal(text.includes('"id":"gone"'), false, '已删记录不得被写回');
});

test('10 dropped intent never bumps attempts (no false E_PUSH_REJECTED)', async () => {
  const fake = new FakeGit();
  const del = ledgerDeleteLine('gone', T1100, T1100);
  fake.setRemoteDay(DAY, [], `${del}\n`, '');
  const result = await run(fake, [upsertIntent({ intentId: 'stale-up', record: rec({ id: 'gone' }) })]);
  assert.equal(result.failed, 0);
  assert.equal(result.code, 'ok');
});

test('11 remote restore after delete (R.ts>D.ts): stale upsert applies again', async () => {
  const fake = new FakeGit();
  const del = ledgerDeleteLine('gone', T1100, T1100);
  const restore = ledgerRestoreLine('gone', T1400, T1400);
  fake.setRemoteDay(DAY, [], `${del}\n`, `${restore}\n`);
  const result = await run(fake, [upsertIntent({ intentId: 'after-restore', record: rec({ id: 'gone' }) })]);
  assert.equal(result.dropped, 0);
  assert.equal(result.applied, 1);
});

test('12 behind: fast-forward allowed, ff called before any write', async () => {
  const fake = new FakeGit({ relation: 'behind', origin: 'b'.repeat(40) });
  fake.setRemoteDay(DAY, [rec({ id: 'remote-1' })]);
  const result = await run(fake, []);
  assert.equal(result.ok, true);
  assert.equal(fake.ffCount, 1);
  assert.equal(fake.commitCount, 0);
});

test('13 behind ff failure: typed E_NOT_SYNCED with zero writes', async () => {
  const fake = new FakeGit({ relation: 'behind', origin: 'b'.repeat(40), ffFails: true });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_NOT_SYNCED');
  assert.equal(fake.writes, 0);
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
});

test('14 ahead: E_NOT_SYNCED, zero writes, intent stays pending in outbox', async () => {
  const fake = new FakeGit({ relation: 'ahead', origin: 'b'.repeat(40) });
  const intent = upsertIntent();
  const result = await run(fake, [intent]);
  assert.equal(result.code, 'E_NOT_SYNCED');
  assert.equal(result.pending, 1);
  assert.equal(fake.writes, 0);
  assert.equal(fake.commitCount, 0);
});

test('15 diverged: E_NOT_SYNCED, zero writes', async () => {
  const fake = new FakeGit({ relation: 'diverged', origin: 'b'.repeat(40) });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.code, 'E_NOT_SYNCED');
  assert.equal(fake.writes, 0);
});

test('16 schema v3: E_SCHEMA_UNKNOWN, zero writes', async () => {
  const fake = new FakeGit({ schema: 3 });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.code, 'E_SCHEMA_UNKNOWN');
  assert.equal(fake.writes, 0);
  assert.equal(fake.commitCount, 0);
});

test('17 missing schema marker: E_SCHEMA_UNKNOWN, zero writes', async () => {
  const fake = new FakeGit({ schema: null });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.code, 'E_SCHEMA_UNKNOWN');
  assert.equal(fake.writes, 0);
});

test('18 branch != main: E_BRANCH_MISMATCH, zero writes', async () => {
  const fake = new FakeGit({ branch: 'dev' });
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.code, 'E_BRANCH_MISMATCH');
  assert.equal(fake.writes, 0);
});

// ---------------------------------------------------------------- e2e：并集语义

test('19 union remote+local different ids: both rows in the written day', async () => {
  const fake = new FakeGit();
  fake.setRemoteDay(DAY, [rec({ id: 'remote-1', ts: T0930 })]);
  fake.setLocalDay(DAY, [rec({ id: 'local-1', ts: T1100 })]);
  const result = await run(fake, []);
  assert.equal(result.ok, true);
  const parsed = parseTimelineDay(fake.local.get(`timeline/${DAY}/records.json`), DAY);
  assert.deepEqual(parsed.day.allRecords.map((r) => r.id).sort(), ['local-1', 'remote-1']);
});

test('20 later ts wins silently for same id', async () => {
  const fake = new FakeGit();
  fake.setRemoteDay(DAY, [rec({ id: 'same', ts: T0930, title: 'old' })]);
  fake.setLocalDay(DAY, [rec({ id: 'same', ts: T1400, title: 'new' })]);
  await run(fake, []);
  const parsed = parseTimelineDay(fake.local.get(`timeline/${DAY}/records.json`), DAY);
  assert.equal(parsed.day.allRecords.length, 1);
  assert.equal(parsed.day.allRecords[0].title, 'new');
});

test('21 same id+ts different body: byte tie-break + conflicts audit line', async () => {
  const fake = new FakeGit();
  fake.setRemoteDay(DAY, [rec({ id: 'tie', ts: T0930, body: 'a' })]);
  fake.setLocalDay(DAY, [rec({ id: 'tie', ts: T0930, body: 'z' })]);
  const result = await run(fake, []);
  assert.equal(result.conflicts, 1);
  const conflictText = fake.local.get(`timeline/${DAY}/conflicts.jsonl`) || '';
  assert.equal(conflictText.trim().split('\n').length, 1);
  const row = JSON.parse(conflictText.trim());
  assert.equal(row.id, 'tie');
  assert.match(row.dedupeKey, /^[0-9a-f]{64}$/);
});

test('22 delete ledger union keeps local bytes as strict prefix', async () => {
  const fake = new FakeGit();
  const localDel = `${ledgerDeleteLine('l1', T1100, T1100)}\n`;
  const remoteDel = `${ledgerDeleteLine('r1', T1400, T1400)}\n`;
  fake.setLocalDay(DAY, [], localDel, '');
  fake.setRemoteDay(DAY, [], remoteDel, '');
  await run(fake, []);
  const merged = fake.local.get(`timeline/${DAY}/deleted.jsonl`);
  assert.ok(merged.startsWith(localDel));
  assert.equal(parseLedger(merged).entries.length, 2);
});

test('23 added counter tracks replayed upserts, not pre-existing rows', async () => {
  const fake = new FakeGit();
  fake.setRemoteDay(DAY, [rec({ id: 'existing', ts: T0930 })]);
  const fresh = rec({ id: 'fresh', ts: T1100 });
  const result = await run(fake, [upsertIntent({ record: fresh })]);
  assert.equal(result.added, 1);
  assert.equal(result.applied, 1);
});

test('24 failed outbox entry is not replayed by a new cycle', async () => {
  const fake = new FakeGit();
  const failed = upsertIntent({ intentId: 'failed-1', state: 'failed', attempts: MAX_ATTEMPTS });
  const result = await run(fake, [failed]);
  assert.equal(result.applied, 0);
  assert.equal(result.pending, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.resultOutbox.length, 1);
});

test('25 fetch runs before the gate even on gate failure (fresh origin/main facts)', async () => {
  const fake = new FakeGit({ schema: 3 });
  await run(fake, []);
  assert.equal(fake.fetchCount, 1);
  assert.equal(fake.pushCount, 0);
});

// ---------------------------------------------------------------- activation（决策表：schema / 并存裁决 / 周期）

const activationBase = {
  schemaVersion: 2, hasDevices: false, hasTimeline: true,
  timelineDays: 1, confirmed: false, cycleAvailable: true
};
const BOTH_TEXT = '检测到 v1（devices/）与 v2（timeline/）数据并存：确认以 timeline/ 为权威并停用 v1 写入？v1 文件不会被删除。';

test('26 activation ok: schema=2, no devices/, cycle available', () => {
  const decision = decideActivation(activationBase);
  assert.equal(decision.ok, true);
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, 'ok');
  assert.equal(decision.needsConfirm, false);
});

test('27 activation refusal: schema v3 → E_SCHEMA_UNKNOWN', () => {
  const decision = decideActivation({ ...activationBase, schemaVersion: 3 });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'E_SCHEMA_UNKNOWN');
  assert.equal(decision.needsConfirm, false);
  assert.equal(decision.reason, ACTIVATION_MESSAGES.E_SCHEMA_UNKNOWN);
});

test('28 activation refusal: missing schema → E_SCHEMA_MISSING', () => {
  const decision = decideActivation({ ...activationBase, schemaVersion: null });
  assert.equal(decision.code, 'E_SCHEMA_MISSING');
  assert.equal(decision.needsConfirm, false);
});

test('29 activation refusal: no cycle runner → E_SYNC_UNAVAILABLE', () => {
  const decision = decideActivation({ ...activationBase, cycleAvailable: false });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'E_SYNC_UNAVAILABLE');
  assert.equal(decision.needsConfirm, false);
});

test('30 both present + empty timeline → E_MIGRATION_EMPTY (refusal, no confirm)', () => {
  const decision = decideActivation({ ...activationBase, hasDevices: true, timelineDays: 0 });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'E_MIGRATION_EMPTY');
  assert.equal(decision.needsConfirm, false);
  assert.equal(decision.reason, ACTIVATION_MESSAGES.E_MIGRATION_EMPTY);
  assert.match(decision.nextStep, /迁移/);
});

test('31 both present + valid timeline + not confirmed → needsConfirm (no activation)', () => {
  const decision = decideActivation({ ...activationBase, hasDevices: true });
  assert.equal(decision.ok, false);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'E_NEEDS_EXPLICIT_RESOLUTION');
  assert.equal(decision.needsConfirm, true);
  assert.equal(decision.reason, BOTH_TEXT);
  assert.equal(decision.reason, ACTIVATION_MESSAGES.E_NEEDS_EXPLICIT_RESOLUTION);
});

test('32 both present + valid timeline + confirmed → ok (no second prompt)', () => {
  const decision = decideActivation({ ...activationBase, hasDevices: true, confirmed: true });
  assert.equal(decision.ok, true);
  assert.equal(decision.code, 'ok');
  assert.equal(decision.needsConfirm, false);
});

test('33 both present + confirmed + no cycle → E_SYNC_UNAVAILABLE (gate still holds)', () => {
  const decision = decideActivation({
    ...activationBase, hasDevices: true, confirmed: true, cycleAvailable: false
  });
  assert.equal(decision.code, 'E_SYNC_UNAVAILABLE');
  assert.equal(decision.needsConfirm, false);
});

test('34 priority: both-present empty beats missing-cycle (fail-closed)', () => {
  const decision = decideActivation({
    ...activationBase, hasDevices: true, timelineDays: 0, cycleAvailable: false
  });
  assert.equal(decision.code, 'E_MIGRATION_EMPTY');
});

test('35 priority: schema beats both-present (no schema, no confirm)', () => {
  const decision = decideActivation({
    ...activationBase, schemaVersion: 3, hasDevices: true, timelineDays: 0
  });
  assert.equal(decision.code, 'E_SCHEMA_UNKNOWN');
  assert.equal(decision.needsConfirm, false);
});

test('36 no devices/ + empty timeline is not a refusal (fresh v2 repo)', () => {
  const decision = decideActivation({
    ...activationBase, hasTimeline: false, timelineDays: 0
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.needsConfirm, false);
});

// ---------------------------------------------------------------- 静态接线契约

test('37 static: explicit activation switch + both dialogs + disable path', () => {
  const section = src('components/settings/SyncSection.ets');
  const settings = src('pages/Settings.ets');
  assert.match(section, /启用 v2 时间线写入/);
  assert.match(section, /onToggleV2Write/);
  assert.match(section, /Toggle\(\{ type: ToggleType\.Switch, isOn: this\.v2WriteEnabled \}\)/);
  assert.match(section, /仓库已迁移到 timeline\/ 结构后才可开启/);
  assert.match(section, /关闭即回到 v1，v1 数据不会被删除/);
  assert.match(settings, /promptAction\.showDialog/);
  assert.match(settings, /确认启用/);
  assert.match(settings, /v2ActivationService\.deactivate\(\)/);
  assert.match(settings, /v2ActivationService\.activate\(/);
  // 并存专用文案逐字出现在设置页；单态文案仍保留，两者不可互相替代。
  assert.match(settings, /检测到 v1（devices\/）与 v2（timeline\/）数据并存：确认以 timeline\/ 为权威并停用 v1 写入？v1 文件不会被删除。/);
  assert.match(settings, /确认以 timeline\/ 为权威/);
  assert.match(settings, /needsConfirm/);
  assert.match(settings, /activate\(context, true\)/);
});

test('38 static: both-present decision persisted + timeline days counted', () => {
  const model = src('model/v2Activation.ts');
  const service = src('services/v2ActivationService.ets');
  assert.match(model, /V1_RETAINED_KEY: string = PERSISTENT_V1_RETAINED_KEY/);
  assert.match(model, /BOTH_PRESENT_CONFIRM_TEXT/);
  assert.match(model, /E_NEEDS_EXPLICIT_RESOLUTION/);
  assert.match(model, /E_MIGRATION_EMPTY/);
  assert.match(service, /V1_RETAINED_KEY/);
  assert.match(service, /AppStorage\.setOrCreate<string>\(V1_RETAINED_KEY, '1'\)/);
  assert.match(service, /countValidTimelineDays/);
  assert.match(service, /parseTimelineDay/);
  assert.match(service, /timelineDays: this\.countValidTimelineDays\(repoRoot\)/);
  assert.match(service, /confirmed: confirmed/);
});

test('39 static: setRunner(bridgeGitRunner) wired in Index bootstrap', () => {
  const index = src('pages/Index.ets');
  assert.match(index, /import \{ bridgeGitRunner \} from '\.\.\/services\/gitRunner'/);
  assert.match(index, /syncProtocolStore\.setRunner\(bridgeGitRunner\)/);
  assert.match(index, /import \{ syncProtocolStore \}/);
});

test('40 static: tri-state row present and driven by syncStatusStore', () => {
  const index = src('pages/Index.ets');
  assert.match(index, /SyncStatusRow\(\)/);
  assert.match(index, /@State syncStatus: SyncStatusView = syncStatusStore\.snapshot\(\)/);
  assert.match(index, /this\.syncStatus\.label/);
  assert.match(index, /this\.syncStatus\.text/);
  const store = src('services/syncStatusStore.ets');
  assert.match(store, /label = '已同步'/);
  assert.match(store, /label = `\$\{pending\} 条待同步`/);
  assert.match(store, /let label: string = '只读'/);
});

test('41 static: no force-push / --force / merge / rebase / clean in new wiring', () => {
  const files = [
    'model/syncCycle.ts', 'services/gitRunner.ets', 'services/syncProtocolStore.ets',
    'services/gitRunner.ets', 'services/v2ActivationService.ets'
  ];
  for (const rel of new Set(files)) {
    const code = src(rel);
    const noComment = code;
    assert.doesNotMatch(noComment, /--force/, rel);
    assert.doesNotMatch(noComment, /\brebase\b/, rel);
    assert.doesNotMatch(noComment, /\bclean\b/, rel);
    assert.doesNotMatch(noComment, /git merge(?!\s+--ff-only)/, rel);
  }
  const bridge = readFileSync(join(APP, 'entry', 'src', 'main', 'resources', 'rawfile', 'git', 'git-bridge.js'), 'utf8');
  // v2 推送唯一的字面量：force:false，分支固定 main（旧 v1 push 走 pushPlan，其 force 亦恒 false）。
  assert.ok(bridge.includes("remote: 'origin', ref: 'main', force: false"), 'v2 push 必须 force:false / ref:main');
  assert.doesNotMatch(bridge, /git\s+push\s+--force/);
});

test('42 static: new files never write devices/**', () => {
  for (const rel of ['model/syncCycle.ts', 'services/gitRunner.ets', 'services/v2ActivationService.ets', 'services/syncStatusStore.ets']) {
    const code = src(rel);
    assert.doesNotMatch(code, /devices\//, rel);
  }
  const gitRunner = src('services/gitRunner.ets');
  assert.match(gitRunner, /GitSyncService\.active\(\)/);
  assert.match(gitRunner, /v2Git\('push'/);
  assert.match(gitRunner, /v2Git\('resetHard'/);
});

test('43 static: recordWriter parks intent before write, triggers sync on both paths', () => {
  const writer = src('services/recordWriter.ets');
  assert.match(writer, /runConfiguredCycle\(\)/);
  assert.match(writer, /syncStatusStore\.fromCycle\(result/);
  assert.match(writer, /E_V2_WRITE_PARKED: v2 写入失败（\$\{reason\}）/);
  assert.match(writer, /outboxStore\.enqueue\(entry\)/);
  assert.match(writer, /outboxStore\.updateLastError\(entry\.intentId/);
  assert.match(writer, /outboxStore\.remove\(entry\.intentId\)/);
  const body = /private writeV2\(op: ParkOp, record: ScheduleRecord, apply: V2Apply\): void \{([\s\S]*?)\n  \}/.exec(writer);
  assert.ok(body, 'writeV2 body not found');
  assert.ok(body[1].indexOf('outboxStore.enqueue(entry)') < body[1].indexOf('apply();'),
    'intent must be durable BEFORE the v2 write attempt');
  assert.equal((body[1].match(/this\.triggerSync\(\)/g) || []).length, 2,
    'success AND failure must both trigger a cycle attempt');
  assert.equal((writer.match(/this\.writeV2\(/g) || []).length, 3, '3 write entry points routed');
});

test('44 static: commit message is exactly [v2] sync <n> days', () => {
  const model = src('model/syncCycle.ts');
  assert.match(model, /COMMIT_PREFIX: string = '\[v2\] sync '/);
  assert.match(model, /`\$\{COMMIT_PREFIX\}\$\{touchedDays\} days`/);
});

// ---------------------------------------------------------------- P1-1：停放意图日期进 days

test('45 P1-1: a brand-new date that exists ONLY in a parked intent is replayed and committed', async () => {
  const NEW_DAY = '2026-12-07';
  const newTs = `${NEW_DAY}T09:00:00+08:00`;
  const fake = new FakeGit(); // no local records.json, no remote day
  const parked = upsertIntent({ record: rec({ id: 'only-parked', ts: newTs, opened_at: newTs }) });
  assert.deepEqual(deriveDays(fake, [parked]), [NEW_DAY], 'cycle day comes solely from outbox');
  const result = await run(fake, [parked]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.days, [NEW_DAY]);
  assert.equal(result.applied, 1);
  assert.equal(fake.commitCount, 1);
  assert.ok(fake.remote.get(`timeline/${NEW_DAY}/records.json`).includes('"id":"only-parked"'));
  assert.equal(result.resultOutbox.length, 0, 'replayed intent must be drained');
});

test('46 static P1-1: outbox dates are unioned into runWiredCycle days', () => {
  const store = src('services/syncProtocolStore.ets');
  assert.match(store, /parkedDays\.push\(entry\.date\)/);
  assert.match(store, /remoteDays\.concat\(parkedDays\)/);
  assert.match(store, /for \(const entry of outbox\) \{/);
});

// ---------------------------------------------------------------- P1-5：持久化绑定

test('47 P1-5 pure: three persistent bindings with exact keys and defaults', () => {
  assert.deepEqual(PERSISTENT_BINDINGS.map((b) => [b.key, b.defaultValue]), [
    ['timeline.readMode', 'v1'],
    ['timeline.v2WriteEnabled', false],
    ['timeline.v1Retained', '']
  ]);
  assert.equal(PERSISTENT_READ_MODE_KEY, 'timeline.readMode');
  assert.equal(PERSISTENT_V2_WRITE_KEY, 'timeline.v2WriteEnabled');
  assert.equal(PERSISTENT_V1_RETAINED_KEY, 'timeline.v1Retained');
  assert.deepEqual(bindingFor('timeline.v2WriteEnabled').defaultValue, false);
  assert.equal(bindingFor('not.registered'), null);
});

test('48 static P1-5: EntryAbility binds all three keys before page load; services reuse them', () => {
  const entry = src('entryability/EntryAbility.ets');
  assert.match(entry, /PersistentStorage\.persistProp<string>\(PERSISTENT_READ_MODE_KEY/);
  // 本 SDK：PersistentStorage 是 ArkUI 全局类，@kit.ArkUI 不导出（编译验证过）。
  assert.doesNotMatch(entry, /import \{[^}]*PersistentStorage[^}]*\} from '@kit\.ArkUI'/);
  assert.match(entry, /this\.bindPersistentSettings\(\);/);
  assert.match(entry, /PersistentStorage\.persistProp<string>\(PERSISTENT_READ_MODE_KEY, 'v1'\)/);
  assert.match(entry, /PersistentStorage\.persistProp<boolean>\(PERSISTENT_V2_WRITE_KEY, false\)/);
  assert.match(entry, /PersistentStorage\.persistProp<string>\(PERSISTENT_V1_RETAINED_KEY, ''\)/);
  assert.match(src('services/timelineStore.ets'), /TIMELINE_READ_MODE_KEY: string = PERSISTENT_READ_MODE_KEY/);
  assert.match(src('services/timelineModeSwitch.ets'), /V2_WRITE_ENABLED_KEY: string = PERSISTENT_V2_WRITE_KEY/);
  assert.match(src('model/v2Activation.ts'), /V1_RETAINED_KEY: string = PERSISTENT_V1_RETAINED_KEY/);
});

test('49 static P1-5: deactivate persists false/v1; readers use the bound keys', () => {
  const service = src('services/v2ActivationService.ets');
  assert.match(service, /AppStorage\.setOrCreate<boolean>\(V2_WRITE_ENABLED_KEY, false\)/);
  assert.match(service, /timelineStore\.setReadMode\('v1'\)/);
  assert.match(src('services/timelineStore.ets'), /AppStorage\.get<string>\(TIMELINE_READ_MODE_KEY\)/);
  assert.match(src('services/timelineModeSwitch.ets'), /AppStorage\.get<boolean>\(V2_WRITE_ENABLED_KEY\) === true/);
  assert.match(src('services/v2ActivationService.ets'), /AppStorage\.get<string>\(V1_RETAINED_KEY\) === '1'/);
});

// ---------------------------------------------------------------- P1-2：用户可见重试

test('50 P1-2: failed intent → retry reset → cycle replay → drained', async () => {
  const failed = upsertIntent({ intentId: 'retry-me', state: 'failed', attempts: MAX_ATTEMPTS });
  const retried = resetForRetry(failed);
  assert.equal(retried.attempts, 0);
  assert.equal(retried.state, 'pending');
  assert.equal(retried.intentId, failed.intentId, 'payload / identity unchanged');
  assert.equal(retried.line, failed.line);
  assert.equal(retried.date, failed.date);
  const fake = new FakeGit({ pushFailures: 1 });
  const result = await run(fake, [retried]);
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1);
  assert.equal(result.resultOutbox.length, 0, 'drained after user retry');
});

test('51 static P1-2: outboxStore.retry + Index 重试同步 + real runCycle(ctx) caller', () => {
  const outbox = src('services/outboxStore.ets');
  assert.match(outbox, /retry\(intentId: string\): boolean/);
  assert.match(outbox, /resetForRetry\(entry\)/);
  const index = src('pages/Index.ets');
  assert.match(index, /重试同步/);
  assert.match(index, /outboxStore\.retry\(entry\.intentId\)/);
  assert.match(index, /syncProtocolStore\.wiredContext/);
  assert.match(index, /syncProtocolStore\.runConfiguredCycle\(ctx\)/);
  const store = src('services/syncProtocolStore.ets');
  assert.match(store, /return await this\.runCycle\(ctx\)/);
});

// ---------------------------------------------------------------- P1-3：每次尝试落盘

test('52 P1-3: attempts persisted on every rejection (not only once at cycle end)', async () => {
  const fake = new FakeGit({ pushFailures: 99 });
  const { result, diskSnapshots } = await runTracked(fake, [upsertIntent()]);
  assert.equal(result.code, 'E_PUSH_REJECTED');
  assert.equal(result.attempts, MAX_ATTEMPTS);
  assert.deepEqual(diskSnapshots, [[1], [2], [3], [4]],
    'one durable write after each failed attempt + terminal failed state');
  assert.equal(result.resultOutbox[0].attempts, MAX_ATTEMPTS);
});

test('53 static P1-3: outbox write call site is inside the rejection path', () => {
  const model = src('model/syncCycle.ts');
  assert.match(model, /writeOutbox\?\(entries: OutboxEntry\[\]\): Promise<void>/);
  assert.ok(model.includes('current = bumpAttempts(current, lastPushError);\n      await persistOutbox(write, current);'),
    'bump + persist must be adjacent inside catch(rejection)');
  assert.match(src('services/syncProtocolStore.ets'), /writeOutbox: async \(entries: OutboxEntry\[\]\): Promise<void> =>/);
});

// ---------------------------------------------------------------- P1-4：typed E_CORRUPT

test('54 P1-4: unparsable remote day → E_CORRUPT, zero write, remote bytes unchanged', async () => {
  const fake = new FakeGit();
  const raw = 'this-is-not-a-json-object';
  fake.remote.set(`timeline/${DAY}/records.json`, raw);
  const parked = upsertIntent();
  const result = await run(fake, [parked]);
  assert.equal(result.code, E_CORRUPT_CODE);
  assert.match(result.message, /E_CORRUPT/);
  assert.match(result.message, /无法解析|目录名不符/);
  assert.equal(fake.writes, 0, '整日不动：WritePort 一次都不能调用');
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.remote.get(`timeline/${DAY}/records.json`), raw, 'remote bytes untouched');
  assert.equal(result.resultOutbox.length, 1, 'intent stays in outbox');
  assert.equal(result.resultOutbox[0].state, 'pending');
});

test('55 P1-4: records.json date ≠ directory name → E_CORRUPT, zero write', async () => {
  const fake = new FakeGit();
  const path = `timeline/${DAY}/records.json`;
  fake.setRemoteDay(DAY, [rec()]);
  const raw = fake.remote.get(path).replace(`"date": "${DAY}"`, '"date": "2026-11-20"');
  assert.notEqual(raw, fake.remote.get(path));
  fake.remote.set(path, raw);
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.code, E_CORRUPT_CODE);
  assert.match(result.message, /date 字段.*与目录日期.*不符/);
  assert.equal(fake.writes, 0);
  assert.equal(fake.commitCount, 0);
  assert.equal(fake.pushCount, 0);
  assert.equal(fake.remote.get(path), raw);
});

test('56 P1-4 pure: dayIntegrityError distinguishes empty day from corrupt day', () => {
  const good = buildRecordsText(DAY, [rec()]);
  assert.equal(dayIntegrityError(DAY, '', ''), '', 'missing file = legal empty day');
  assert.equal(dayIntegrityError(DAY, good, ''), '');
  assert.match(dayIntegrityError(DAY, 'not json', ''), /E_CORRUPT/);
  const mismatch = good.replace(`"date": "${DAY}"`, '"date": "2026-11-20"');
  assert.match(dayIntegrityError(DAY, mismatch, ''), /目录日期/);
  assert.match(E_CORRUPT_MESSAGE, /整日不动/);
});

test('57 static P1-4: E_CORRUPT typed code passes through outcomeToResult', () => {
  const model = src('model/syncCycle.ts');
  assert.match(model, /E_CORRUPT_CODE: string = 'E_CORRUPT'/);
  assert.match(model, /dayIntegrityError\(date, read\.remote, read\.local\)/);
  const store = src('services/syncProtocolStore.ets');
  assert.match(store, /code: outcome\.code, message: outcome\.message/);
  assert.doesNotMatch(store, /let code: WriteGateCode \| 'E_PUSH_REJECTED'/);
});

// ---------------------------------------------------------------- cheap extras

test('58 push transport E_AUTH keeps original typed code and error text', async () => {
  const fake = new FakeGit();
  fake.pushMain = async () => {
    fake.pushCount += 1;
    throw new Error('E_AUTH: token rejected by remote');
  };
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.code, 'E_AUTH');
  assert.match(result.message, /E_AUTH: token rejected by remote/);
  assert.equal(result.resultOutbox[0].lastError.includes('E_AUTH: token rejected by remote'), true);
});

test('59 static: gate is rechecked per intent before replay (P1-3(a) literal)', () => {
  const model = src('model/syncCycle.ts');
  assert.match(model, /for \(let i = 0; i < replayEntries\.length; i \+= 1\) \{[\s\S]{0,200}gateOf\(port\)/);
});
