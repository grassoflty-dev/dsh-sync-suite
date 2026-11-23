// mod-v2-sync-wiring：syncCycle 纯周期的端到端行为（fake GitPort，内存 git）+ 接线静态契约。
//
// 前置构建：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型从 ../.build 导入；.ets 服务/页面因 @kit.* 只能在 Node 里做源码形状断言（本仓既有口径）。
//
// 覆盖：happy（gate→union→commit→push→outbox 排空）、push 拒一次（reset→replay→成功）、
//       一直拒（MAX_ATTEMPTS 耗尽→failed/pending）、远端删除+陈旧 upsert（dropped 不出队）、
//       behind→ff 放行 / ahead·diverged·schema·branch→E_* 零写入；
//       v2-only：激活决策表与持久化开关已删除，改由 mod-v2-only 的迁移门槛 + 首页横幅承担；
//       保留 setRunner / tri-state 行 / 无 force-push·merge·rebase·clean·devices/ 写静态断言。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchBrace, stripComments } from './helpers/etsSource.mjs';
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
const { canonicalRecordLine, parseTimelineDay, parseLedger } =
  await import('../.build/model/timeline.js');
const { buildRecordsText, ledgerDeleteLine, ledgerRestoreLine } =
  await import('../.build/model/timelineWrite.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const ETS = join(APP, 'entry', 'src', 'main', 'ets');
function src(rel) {
  return stripComments(readFileSync(join(ETS, rel), 'utf8'));
}

/** 按 marker 切出 `@Builder Name() { ... }` 的内部文本（注释已剥，行号无关）。 */
function builderBody(source, name) {
  const marker = `\n  ${name}() {`;
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `${name} builder not found`);
  const [start, end] = matchBrace(source, source.indexOf('{', at));
  return source.slice(start + 1, end - 1);
}

/* ------------------------------------------------------------ mod-app-retry-removal
 * Schedule-surface absence guard. Phase A removed the manual retry control from the
 * shipped SchedulePane; this module removes the leftover one on the fallback Index route.
 * The old pins asserted the control EXISTED (so a re-added or merely renamed button
 * passed). These helpers scan BOTH surface files and fail on any reintroduced control:
 * a Text/Button/ActionButton with a retry / test / status label, a clickable handler
 * reaching a sync capability, and the bare literal 重试同步 anywhere in either file.
 */
const SCHEDULE_SURFACE = ['pages/Index.ets', 'pages/panes/SchedulePane.ets'];
const RETRY_WORDS = ['重试同步', '重试', '立即同步', '测试连接', '查看状态', '同步'];
const SYNC_CAPABILITY = /retrySync|runConfiguredCycle|runAction\(|retryFromStatus\(|testConnection\(|\brunOnce\(/;

/** Balanced call-body extractor: handlerBodies(code, 'onClick') → each `.onClick(...)` body. */
function handlerBodies(code, name) {
  const out = [];
  const re = new RegExp('\\b' + name + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    let i = open + 1;
    let depth = 1;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === "'" || c === '"' || c === '`') {
        const q = c;
        i += 1;
        while (i < code.length) {
          if (code[i] === '\\') { i += 2; continue }
          if (code[i] === q) { i += 1; break }
          i += 1;
        }
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    out.push(code.slice(open + 1, i - 1));
  }
  return out;
}

function assertNoManualSyncRetryControl(where, overrides = {}) {
  for (const rel of SCHEDULE_SURFACE) {
    const raw = overrides[rel] ?? readFileSync(join(ETS, rel), 'utf8');
    const code = overrides[rel] === undefined ? src(rel) : stripComments(raw);
    // (a) plain literal absence in BOTH files (raw bytes, comments included).
    assert.ok(!raw.includes('重试同步'), `${rel}: literal 重试同步 must be absent (${where})`);
    // (b) no Text / Button / ActionButton carrying a retry / test / status label.
    const labels = [];
    for (const m of code.matchAll(/\b(?:Text|Button)\s*\(\s*(['"])([^'"]*)\1/g)) labels.push(m[2]);
    for (const m of code.matchAll(/\bActionButton\s*\(\s*\{([\s\S]{0,320}?)\}/g)) {
      for (const l of m[1].matchAll(/\b(?:label|actionLabel|retryLabel)\s*:\s*(['"])([^'"]*)\1/g)) labels.push(l[2]);
    }
    const hits = labels.filter((label) => RETRY_WORDS.some((w) => label.includes(w)));
    assert.deepEqual(hits, [], `${rel}: no retry/test/status-labelled control allowed (${where}); got ${hits.join(' | ')}`);
    // (c) no clickable handler wired to a sync capability (covers a benign-labelled re-add).
    for (const handler of ['onClick', 'onTap', 'onAction', 'onRetry']) {
      for (const body of handlerBodies(code, handler)) {
        assert.ok(!SYNC_CAPABILITY.test(body),
          `${rel}: ${handler} must not reach a sync capability (${where}): ${body.slice(0, 120)}`);
      }
      const propRe = new RegExp('\\b' + handler + '\\s*:\\s*', 'g');
      let pm;
      while ((pm = propRe.exec(code))) {
        const window = code.slice(pm.index, pm.index + 260);
        assert.ok(!SYNC_CAPABILITY.test(window),
          `${rel}: ${handler} prop must not reach a sync capability (${where})`);
      }
    }
  }
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
    /** 操作顺序探针（mod-auto-sync）：钉住 fetch 先于 add/commit/push。 */
    this.trace = [];
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

  async fetchMain() { this.fetchCount += 1; this.trace.push('fetch'); }
  async headSha() { return this.head; }
  async originMainSha() { return this.origin; }
  async showMain(path) { return this.remote.get(path) || ''; }
  async branchName() { return this.branch; }
  async headRelation() {
    if (this.relationOverride !== null) { return this.relationOverride; }
    return this.head === this.origin ? 'equal' : 'diverged';
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
    this.commitCount += 1;
    this.commits.push(message);
    this.head = `c${String(this.commitCount).padStart(39, '0')}`;
  }
  async pushMain() {
    this.trace.push('push');
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
    this.trace.push('reset');
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

// ---------------------------------------------------------------- 静态接线契约

test('37 static v2-only: no activation switch / confirm dialog / dual-store resolution remains', () => {
  const section = src('components/settings/SyncSection.ets');
  const settings = src('pages/Settings.ets');
  for (const forbidden of [/启用 v2 时间线写入/, /onToggleV2Write/, /v2WriteEnabled/, /关闭即回到 v1/,
    /确认以 timeline\/ 为权威/, /needsConfirm/, /v1Retained/, /v2WriteEnabled/]) {
    assert.doesNotMatch(section, forbidden, `SyncSection 不得残留激活控件：${forbidden}`);
    assert.doesNotMatch(settings, forbidden, `Settings 不得残留激活逻辑：${forbidden}`);
  }
});

test('38 static v2-only: deleted activation modules are gone from the import graph', () => {
  for (const rel of ['model/v2Activation.ts', 'model/timelineMode.ts', 'model/persistentSettings.ts',
    'services/v2ActivationService.ets', 'services/timelineModeSwitch.ets']) {
    assert.throws(() => readFileSync(join(ETS, rel)), `已删除文件仍存在：${rel}`);
  }
  const index = src('pages/Index.ets');
  assert.doesNotMatch(index, /timelineModeSwitch|v2ActivationService|useV2\(|readMode\(/);
});

test('39 static（old→new）: GitRunner 在 app 启动时确定性绑定，页面 bootstrap 幂等兜底', () => {
  // old（保留全部旧断言，防回退漂移）：fallback 路由 Index 的 bootstrap 仍绑定。
  const index = src('pages/Index.ets');
  assert.match(index, /import \{ bridgeGitRunner \} from '\.\.\/services\/gitRunner'/);
  assert.match(index, /syncProtocolStore\.setRunner\(bridgeGitRunner\)/);
  assert.match(index, /import \{ syncProtocolStore \}/);
  // new：真启动链 = EntryAbility.onCreate → bindAtStartup(runner, filesDir)，
  // 父生命周期先于任何页面 aboutToAppear / 记录写入，首轮周期不可能撞上「runner 未绑定」。
  const ability = src('entryability/EntryAbility.ets');
  assert.match(ability, /import \{ bridgeGitRunner \} from '\.\.\/services\/gitRunner'/);
  assert.match(ability, /import \{ syncProtocolStore \} from '\.\.\/services\/syncProtocolStore'/);
  const onCreate = /onCreate\(want: Want, launchParam: AbilityConstant\.LaunchParam\): void \{([\s\S]*?)\n  \}/.exec(ability);
  assert.ok(onCreate, 'EntryAbility.onCreate body not found');
  assert.match(onCreate[1], /syncProtocolStore\.bindAtStartup\(bridgeGitRunner, this\.context\)/);
  assert.match(src('pages/panes/SchedulePane.ets'), /syncProtocolStore\.setRunner\(bridgeGitRunner\)/);
});

// mod-auto-sync 重定位：原用例钉住旧的四态文案（已同步 / N 条待同步 / 错误）；
// 新契约只有一行三态（已同步 · HH:MM / 同步中… / 失败：<typed 原因>）+ 状态行点一下重试。
// 断言不比原来弱：既逐字钉新文案，也反向禁止旧按钮与第四态复活。
// 注：本例锚在 fallback 路由 pages/Index.ets；真日程面板已由 mod-sync-ui-silence PHASE A 只读化。
test('40 static: exactly three status states with exact copy, no manual sync buttons', () => {
  const index = src('pages/Index.ets');
  assert.match(index, /SyncStatusRow\(\)/);
  assert.match(index, /@State syncStatus: SyncStatusView = syncStatusStore\.snapshot\(\)/);
  assert.match(index, /Text\(this\.syncStatus\.text\)/);
  assert.match(index, /this\.syncStatus\.state === 'failed'/);
  // mod-app-retry-removal (old → new): was `assert.match(index, /Text\('重试同步'\)/)` —
  // a positive pin that let a re-added / renamed button pass. Now fail on ANY reachable
  // manual sync retry across both schedule-surface files.
  assertNoManualSyncRetryControl('syncWiring test 40');
  const store = src('services/syncStatusStore.ets');
  assert.match(store, /SYNCED_PREFIX: string = '已同步 · '/);
  assert.match(store, /SYNCING_TEXT: string = '同步中…'/);
  assert.match(store, /FAILED_PREFIX: string = '失败：'/);
  assert.match(store, /setSyncing\(\)/);
  assert.doesNotMatch(store, /条待同步|'只读'|'错误'/);
  for (const rel of ['components/settings/SyncSection.ets', 'pages/Settings.ets', 'pages/Index.ets']) {
    const text = src(rel);
    assert.doesNotMatch(text, /label: '推送'|label: '立即同步'|Text\('推送'\)/, rel);
  }
});

test('40b mod-app-retry-removal self-test: the absence guard fails on a re-added control', () => {
  // Positive control: inject the exact removed shape into the fallback route in memory
  // (no file write). A guard that only "passes" is worthless; this proves it can fail.
  const idxRaw = readFileSync(join(ETS, 'pages/Index.ets'), 'utf8');
  const mutated = idxRaw.replace('this.SyncStatusRow()',
    "Text('重试同步').onClick(() => { this.runConfiguredCycle(); })\n      this.SyncStatusRow()");
  assert.notEqual(mutated, idxRaw, 'mutation must actually apply');
  assert.throws(
    () => assertNoManualSyncRetryControl('self-test', { 'pages/Index.ets': mutated }),
    /重试同步/, 'guard must fail on a re-added, identically-named retry control');
  // A merely RENAMED control with a sync handler must fail too (label word + capability).
  const renamed = idxRaw.replace('this.SyncStatusRow()',
    "Text('同步').onClick(() => { this.runConfiguredCycle(); })\n      this.SyncStatusRow()");
  assert.throws(
    () => assertNoManualSyncRetryControl('self-test', { 'pages/Index.ets': renamed }),
    /retry\/test\/status-labelled control|sync capability/,
    'guard must fail on a renamed retry control wired to a sync capability');
  // The real tree still passes.
  assertNoManualSyncRetryControl('self-test clean');
});

test('41 static: no force-push / --force / merge / rebase / clean in new wiring', () => {
  const files = [
    'model/syncCycle.ts', 'services/gitRunner.ets', 'services/syncProtocolStore.ets'
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
  for (const rel of ['model/syncCycle.ts', 'services/gitRunner.ets', 'services/syncStatusStore.ets']) {
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

test('51 static P1-2: outboxStore.retry reset + NO manual retry control + real runCycle(ctx) caller', () => {
  const outbox = src('services/outboxStore.ets');
  assert.match(outbox, /retry\(intentId: string\): boolean/);
  assert.match(outbox, /resetForRetry\(entry\)/);
  // mod-app-retry-removal (old → new): four positive pins on Index (`重试同步`,
  // `outboxStore.retry(entry.intentId)`, `syncProtocolStore.wiredContext`,
  // `syncProtocolStore.runConfiguredCycle(ctx)`) all lived inside the deleted
  // retrySync(). They are replaced by an absence guard that fails on a re-added
  // control AND on a renamed one; the outbox reset pin and the store's runCycle
  // pin below are untouched.
  assertNoManualSyncRetryControl('syncWiring test 51');
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

// ---------------------------------------------------------------- mod-auto-sync（用户项 3+4）

test('60 create → pull (fetch) → replay on fresh remote → commit → push, in that order', async () => {
  const fake = new FakeGit();
  fake.setRemoteDay(DAY, [rec({ id: 'remote', ts: T0930 })]);
  const intent = upsertIntent({ record: rec({ id: 'new', ts: T1100 }) });
  const result = await run(fake, [intent]);
  assert.equal(result.ok, true);
  const fetchAt = fake.trace.indexOf('fetch');
  const addAt = fake.trace.indexOf('add');
  const commitAt = fake.trace.indexOf('commit');
  const pushAt = fake.trace.indexOf('push');
  assert.ok(fetchAt >= 0 && addAt > fetchAt && commitAt > addAt && pushAt > commitAt,
    `git 操作顺序错误：${fake.trace.join('→')}`);
  assert.equal(fetchAt, 0, 'fetch 必须是第一个 git 操作（先取远端最新状态）');
  const merged = parseTimelineDay(fake.remote.get(`timeline/${DAY}/records.json`), DAY);
  assert.deepEqual(merged.day.allRecords.map((r) => r.id).sort(), ['new', 'remote'],
    '新记录叠加在最新远端状态之上，且远端最终拿到两者');
  assert.equal(result.resultOutbox.length, 0);
});

test('61 offline / transport E_IO → typed failure + intent parked for retry (no force)', async () => {
  const fake = new FakeGit();
  fake.pushMain = async () => {
    fake.pushCount += 1;
    throw new Error('E_IO: network unreachable');
  };
  const result = await run(fake, [upsertIntent()]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_IO');
  assert.match(result.message, /E_IO: network unreachable/);
  assert.equal(result.failed, 1);
  assert.equal(result.resultOutbox.length, 1, '失败意图留在 outbox，等用户点重试');
  assert.equal(result.resultOutbox[0].state, 'failed');
  assert.match(result.resultOutbox[0].lastError, /E_IO/);
  assert.equal(fake.resetCount, MAX_ATTEMPTS, '拒推只能 reset --hard origin/main，绝不 force-push');
});

test('62 static: BOTH portrait CompactBody and wide WideBody use ONE shared Refresh wrapper → configured cycle', () => {
  // S3 迁移后真首页 = pages/Home.ets + panes/SchedulePane.ets（Index 仅留作 fallback 路由）。
  // 竖屏平板内容宽 <840vp → masterDetail=false → CompactBody；横屏/宽屏才走 WideBody。
  // 两栏必须调用同一个 RefreshableList()，不能再出现「只给一栏补 Refresh、真机拉不动」的布局漂移。
  const pane = src('pages/panes/SchedulePane.ets');
  const body = /private async onPullRefresh\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(pane);
  assert.ok(body, 'onPullRefresh body not found in SchedulePane');
  assert.match(body[1], /syncStatusStore\.setSyncing\(\)/);
  assert.match(body[1], /await syncProtocolStore\.runConfiguredCycle\(\)/);
  assert.match(body[1], /syncStatusStore\.fromCycle\(result/);
  assert.match(body[1], /this\.reload\(\)/);
  assert.match(body[1], /this\.loadSummary\(\)/);
  assert.doesNotMatch(body[1], /syncController\.pullNow/);

  const compact = builderBody(pane, 'CompactBody');
  const wide = builderBody(pane, 'WideBody');
  const shared = builderBody(pane, 'RefreshableList');
  const right = builderBody(pane, 'RightPane');

  // 唯一的列表 Refresh 包装：共享 builder 里一处，右栏独立 paneRefreshing 一处。
  // 旧断言「3 处字面 Refresh」改成「共享 1 + 右栏 1」，再由下面「两栏都调用共享 builder」
  // 保证三处入口都在（不再靠数字碰运气，也不再只钉横屏那一处）。
  const refreshSites = pane.match(/Refresh\(\{ refreshing: \$\$this\.\w+ \}\)/g) || [];
  assert.equal(refreshSites.length, 2, '共享列表包装 + 右栏各一处 Refresh（列表只写一次）');
  assert.match(shared, /Refresh\(\{ refreshing: \$\$this\.refreshing \}\)/);
  assert.match(shared, /this\.RecordList\(\)/, '共享包装必须渲染真实列表');
  assert.match(shared, /this\.onPullRefresh\(\)/, '共享包装复用同一 pull handler');
  assert.equal((shared.match(/this\.refreshing = false/g) || []).length, 2,
    '成功与 reject 两路都要复位转圈');
  assert.match(right, /Refresh\(\{ refreshing: \$\$this\.paneRefreshing \}\)/);
  assert.match(right, /this\.onPullRefresh\(\)/, '右栏复用同一 pull handler');

  // 两栏必须走同一条代码路径：各自恰好一次调用共享 builder，且不再内联 Refresh / RecordList。
  for (const [name, source] of [['CompactBody（竖屏）', compact], ['WideBody（横屏/宽屏）', wide]]) {
    assert.equal((source.match(/this\.RefreshableList\(\)/g) || []).length, 1,
      `${name} 必须且只能调用一次共享 Refresh 包装`);
    assert.doesNotMatch(source, /Refresh\(\{/, `${name} 不得再内联第二套 Refresh`);
    assert.doesNotMatch(source, /this\.RecordList\(\)/, `${name} 的列表只能经共享包装渲染`);
    assert.match(source, /this\.SyncStatusRow\(\)/, `${name} 必须显示同一三态状态行`);
    // 布局纪律：Refresh 外仍只有一层 .width(100%) + .layoutWeight(1) 加权兄弟，无定高包装。
    const list = /Column\(\) \{\n\s*this\.RefreshableList\(\)\n\s*\}\n\s*\.width\('100%'\)\n\s*\.layoutWeight\(1\)/.exec(source);
    assert.ok(list, `${name} 列表区必须保留唯一加权兄弟包裹共享 Refresh`);
  }
  assert.match(pane, /List\(\) \{[\s\S]*?\.layoutWeight\(1\)/, '列表自身仍保留 layoutWeight(1)');

  // fallback 路由保持原样：不是拿它替代面板断言，而是防止回退时两边漂移。
  const fallback = src('pages/Index.ets');
  assert.match(fallback, /Refresh\(\{ refreshing: \$\$this\.refreshing \}\)/);
  assert.match(fallback, /private async onPullRefresh\(\)/);
  assert.match(src('services/recordWriter.ets'), /syncStatusStore\.setSyncing\(\)/);
});

test('62b static: 日程面板三态状态行文案不变，且为只读（无手动同步控件）', () => {
  const pane = src('pages/panes/SchedulePane.ets');
  const status = src('services/syncStatusStore.ets');
  assert.match(status, /'已同步 · '/, '已同步·HH:MM 前缀不得改');
  assert.match(status, /'同步中…'/, '同步中… 文案不得改');
  assert.match(status, /'失败：'/, '失败：原因 前缀不得改');
  const row = /SyncStatusRow\(\) \{([\s\S]*?)\n  \}/.exec(pane);
  assert.ok(row, 'SyncStatusRow builder not found');
  assert.match(row[1], /this\.syncStatus\.text/);
  assert.match(row[1], /this\.syncStatus\.state === 'synced'/);
  assert.match(row[1], /this\.syncStatus\.state === 'failed'/);
  // mod-sync-ui-silence PHASE A：唯一状态面保持原文案，但用户不再手动重试。
  assert.doesNotMatch(row[1], /重试同步|立即同步|查看状态|测试连接/, '只读状态行无手动同步文案');
  assert.doesNotMatch(row[1], /\.onClick\s*\(/, '状态行不挂点击 handler');
  assert.doesNotMatch(pane, /this\.retrySync\(\)/, 'retrySync 能力保留但无 UI 调用点');
  // 竖屏与横屏都必须显示同一三态行（不再只钉横屏那一处）。
  for (const name of ['CompactBody', 'WideBody']) {
    assert.match(builderBody(pane, name), /this\.SyncStatusRow\(\)/, `${name} 也要显示同一三态行`);
  }
});

test('63 static: every create path routes through recordWriter (one sync trigger, no second impl)', () => {
  const writer = src('services/recordWriter.ets');
  assert.match(writer, /syncStatusStore\.setSyncing\(\)/);
  assert.match(writer, /runConfiguredCycle\(\)/);
  const paths = {
    // mod-home-drop-quick deleted the quick-record write path; the four remaining UI writes still route here.
    'pages/Index.ets': 4, // toggle / delete / restore / AI write-back
    'components/RecordEditorView.ets': 1, // editor save
    'components/RecordDetailView.ets': 1  // detail save
  };
  assert.doesNotMatch(src('pages/Index.ets'), /QuickRecordBar|submitQuickRecord/,
    '快捷记录写路径已删除，不得再出现第二个创建入口');
  for (const rel of Object.keys(paths)) {
    const text = src(rel);
    const calls = (text.match(/recordWriter\.writeRecord\(/g) || []).length +
      (text.match(/recordWriter\.deleteRecord\(/g) || []).length +
      (text.match(/recordWriter\.restoreRecord\(/g) || []).length;
    assert.equal(calls, paths[rel], `${rel} 写调用点数`);
  }
  assert.doesNotMatch(src('pages/Index.ets'), /runCyclePure\(/);
  assert.doesNotMatch(writer, /runCyclePure\(/);
});

test('64 static: force / rebase / reset --hard confined to the documented rejection path', () => {
  for (const rel of ['pages/Index.ets', 'pages/Settings.ets',
    'components/settings/SyncSection.ets', 'services/recordWriter.ets']) {
    assert.doesNotMatch(src(rel), /--force|\brebase\b|--hard/, `${rel} 不得出现强制/改写/硬重置`);
  }
  const store = src('services/syncProtocolStore.ets');
  assert.match(store, /'reset', '--hard', 'origin\/main'/);
  assert.match(store, /'push', 'origin', 'main'/);
  assert.doesNotMatch(store, /--force|\brebase\b/);
});

// ---------------------------------------------------------------- mod-sync-silent-autoinit（正向守卫）

test('65 static: every repo-needing bridge op funnels through ensureRepoInitialised()', () => {
  const bridge = readFileSync(
    join(APP, 'entry', 'src', 'main', 'resources', 'rawfile', 'git', 'git-bridge.js'), 'utf8');
  assert.match(bridge, /async function ensureRepoInitialised\(args\) \{/,
    '桥必须有唯一的静默初始化前置函数');
  // opFetch / opPull / opPush / opCommitPaths / opStatus / opLog / opCurrentBranch /
  // opResolveRef / opV2Git —— 每个需要工作副本的 op 都在触碰 git 之前调用它。
  const calls = bridge.match(/await ensureRepoInitialised\(args\);/g) || [];
  assert.equal(calls.length, 9, `九个 repo op 都必须调用静默前置，实际 ${calls.length}`);
  // 缺仓库：复用 opClone 的备份/并集/隔离；空远端走本地 init 交给 E_REMOTE_EMPTY，绝不覆盖历史。
  // mod-p0a-no-main-probe（equal-or-stricter）：上游两处已决策调用必须显式跳过二次探测；
  // 唯一允许无条件调用的是 OP_HANDLERS.clone 自己在 opClone 内完成的 probe-before-clone。
  assert.match(bridge, /return await opClone\(args, true\);/);
  assert.equal((bridge.match(/await opClone\(args\)/g) || []).length, 0,
    '不得留下任何未标记 skipProbe 的上游 opClone 调用');
  assert.match(bridge, /emptyRemote: true/);
  assert.match(bridge, /remoteHasNoRefs/);
  // 四个旧死结只作为内部不变量保留，且有中文注释声明「非用户提示 / 不可达」。
  const invariants = bridge.match(/内部不变量（\*\*非用户提示\*\*）/g) || [];
  assert.equal(invariants.length, 4, '四处死结必须带内部不变量注释，且正常流程不可达');
  assert.match(bridge, /本机仓库尚未初始化：请先执行「拉取」（首次会自动克隆）/);
  assert.match(bridge, /本机仓库尚未初始化：请先拉取克隆仓库/);
  // v2 空仓库 bootstrap 语义不能被静默初始化绕过：listDays 对缺失 origin/main 返回空列表。
  assert.match(bridge, /out\.value = '\[\]';/);
  // 门面每次调用都带 autoInit，直接调桥的单测不带（旧不变量断言保持绿）。
  const service = src('services/GitSyncService.ets');
  assert.match(service, /'autoInit': 'true'/);
  assert.match(service, /async ensureRepoInitialised\(\): Promise<GitSyncResult>/);
  for (const op of ['pull', 'push', 'status']) {
    assert.match(service, new RegExp(`const init: GitSyncResult = await this\\.ensureRepoInitialised\\(\\);`));
    assert.ok(service.includes(`this.callBridge('${op}'`), `门面 ${op} 仍走桥`);
  }
});

test('66 static: 查看状态 / 测试连接 auto-initialise first, then report real remote state', () => {
  const page = src('pages/SettingsSync.ets');
  const service = src('services/GitSyncService.ets');
  const bodyOf = (source, marker) => {
    const at = source.indexOf(marker);
    assert.ok(at >= 0, `${marker} not found`);
    const [start, end] = matchBrace(source, source.indexOf('{', at));
    return source.slice(start, end);
  };
  const testConnection = bodyOf(page, 'private async testConnection()');
  assert.match(testConnection, /this\.sync\.ensureRepoInitialised\(\)/,
    '测试连接必须先静默初始化，不能要求先手动拉取');
  assert.match(testConnection, /this\.sync\.status\(true\)/,
    '测试连接后再取真实远端状态（可达 / 领先 / 落后 / 一致）');
  const runAction = bodyOf(page, 'private async runAction(action: string)');
  assert.match(runAction, /this\.sync\.status\(true\)/, '查看状态走带 probe 的 bridge status');
  assert.match(runAction, /result\.diagnostics/, '真实仓库事实只落诊断区');
  // 桥的 status 在 fetchRemote 时先 fetch 再算 ahead/behind，不用过期的本地引用。
  const bridge = readFileSync(
    join(APP, 'entry', 'src', 'main', 'resources', 'rawfile', 'git', 'git-bridge.js'), 'utf8');
  const status = bodyOf(bridge, 'async function opStatus(args)');
  assert.ok(status.indexOf('await ensureRepoInitialised(args);') < status.indexOf('var report = {'),
    'status 必须先静默初始化再读仓库');
  assert.ok(status.indexOf("args.fetchRemote === 'true'") < status.indexOf('branchState(git'),
    'ahead/behind 必须在 fetch 刷新跟踪引用之后计算');
  assert.match(service, /args\['fetchRemote'\] = withProbe \? 'true' : 'false'/);
});

test('67 static (review M1/m1): one status source, no fabricated success, diagnostics are facts only', () => {
  const page = src('pages/SettingsSync.ets');
  const section = src('components/settings/SyncSection.ets');
  const store = src('services/syncStatusStore.ets');
  // 单一来源：页面把 honestStatus() 直接喂给正文，不持有字符串状态、不调根页摘要。
  assert.match(page, /syncMessage: this\.honestStatus\(\)/);
  assert.doesNotMatch(page, /@State syncMessage/);
  assert.doesNotMatch(page, /syncRowSummary\(/);
  // connectionText（诊断区）仍可保留 ❌；状态行写入不得再有 ❌ 前缀。
  assert.doesNotMatch(page, /syncMessage\s*=\s*`❌/);
  // 保存不是同步：保存方法里既不写成功时刻也不写失败原因。
  const saveAt = page.indexOf('private async saveSettings()');
  assert.ok(saveAt > 0, 'saveSettings not found');
  const [saveStart, saveEnd] = matchBrace(page, page.indexOf('{', saveAt));
  const save = page.slice(saveStart, saveEnd);
  assert.doesNotMatch(save, /lastSyncAt\s*=/, 'save must never fabricate a sync time');
  assert.doesNotMatch(save, /lastSyncError\s*=/);
  // 只有 pull 成功分支能推进 lastSyncAt；status 查询不可以。
  const actionAt = page.indexOf('private async runAction(');
  const [actionStart, actionEnd] = matchBrace(page, page.indexOf('{', actionAt));
  assert.match(page.slice(actionStart, actionEnd), /if \(op === 'pull'\) \{\s*this\.lastSyncAt = nowIso\(\);/);
  // 诊断区只读：可执行文案不渲染；状态行也不再可点重试（mod-sync-silence-phase-b）。
  assert.doesNotMatch(section, /statusReadiness/);
  assert.doesNotMatch(section, /describePushReadiness/);
  assert.match(section, /Text\(this\.syncMessage\)/, '唯一状态行仍渲染');
  assert.doesNotMatch(section, /onRetryStatus\(\)/, '状态行不得挂手动重试');
  // 相对时间兜底已整支删除（Lead 追加要求）。
  assert.doesNotMatch(store, /刚刚/);
  assert.match(store, /label = TEXT_NEVER;/);
});

// mod-p0a-no-main-probe（old→new，仅新增）：先探测后落地 + 已撤回的 adopt 通道不得复活。
test('68 static: bridge probes with listServerRefs before any clone; no adopt/ref-write on this path', () => {
  const bridge = readFileSync(
    join(APP, 'entry', 'src', 'main', 'resources', 'rawfile', 'git', 'git-bridge.js'), 'utf8');
  assert.match(bridge, /git\.listServerRefs\(/, '判空必须走 isomorphic-git 原始引用数组');
  assert.match(bridge, /function probeRemoteRefs\(git, config, url\)/);
  const at = bridge.indexOf('async function ensureRepoInitialised(args)');
  assert.ok(at > 0, 'ensureRepoInitialised not found');
  const [start, end] = matchBrace(bridge, bridge.indexOf('{', at));
  const ensure = bridge.slice(start, end);
  const emptyAt = ensure.indexOf('if (probe.empty)');
  assert.ok(emptyAt > 0, '必须有显式空远端分支');
  const emptyBranch = ensure.slice(emptyAt);
  assert.match(emptyBranch, /git\.init\(/);
  assert.doesNotMatch(emptyBranch, /git\.clone\(/, '空远端分支绝不能 clone');
  assert.match(bridge, /if \(probe\.heads\.indexOf\(branch\) < 0\)/, '非空无 main 必须 typed 拒绝');
  assert.match(bridge, /无法确认远端状态（探测失败）/, '探测抛错必须 typed 未定');
  // 已撤回的 adopt：这三个文件里不得出现建 main / 建引用 / 删分支 / 强推。
  for (const rel of ['model/syncCycle.ts', 'services/gitRunner.ets', 'pages/SettingsSync.ets']) {
    const code = src(rel);
    for (const banned of [
      /adopt(Branch|Main|Remote|AsMain)/i, /writeRef\s*\(/, /createRef\s*\(/,
      /branch\s+-D/, /--force/, /\brebase\b/
    ]) {
      assert.doesNotMatch(code, banned, `${rel} 残留已撤回的 adopt / 强改通道：${banned}`);
    }
  }
});
