// mod-v2-contract-tests (tests only): closes the P2 gaps logged in docs/REVIEW-three-batches.md.
//
// Everything here drives the SHIPPED pure models from tools/.build (compiled by
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json)
// with small in-memory fakes. No .ets runtime, no device, no real fs writes.
//
// Gap groups:
//   A (review A P2 / P2-A1) — fake-IO media preflight of checkV2MediaIntegrity:
//     every failure returns a typed code with verified=[] so the caller writes zero bytes.
//   B (review B P2 / P2-B1) — dedupe driven against unionDay / runCyclePure themselves
//     (NOT the twoDevice.test.mjs writePort, which re-implements conflict dedupe):
//     conflicts dedupe by (id,ts,dedupeKey); duplicate outbox intents drain once.
//   C (review B P2 / P2-B3) — contract rules that had no case: R<D hidden, bare media
//     filename read path, summary newer-wins, opened_at/closed_at, maxAttempts=4,
//     unknown schema => zero writes, 4x push rejection => E_PUSH_REJECTED + failed.
//
// Contract anchors: docs/DATA-CONTRACT-v2.md §4 (line 99-100 same-ts tie-break + audit),
// §5 (line 110 bare <sha16>.jpg, line 116 媒体待迁移), §6 (line 123 open predicate),
// §7 (line 155-156 visible iff R>D), §8 (line 187 newer generatedAt wins),
// §9 (line 223 maxAttempts=4, line 203 push rejection, line 229/241 idempotency),
// §11 (line 279-280 unknown schema => typed E_SCHEMA_* + zero writes).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('contractGaps.test.mjs');

// Compiled pure models use extension-less relative './model.js' specifiers (ArkTS style).
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
  V2_REFUSAL_MEDIA_CORRUPT, V2_REFUSAL_MEDIA_COLLISION,
  buildV2Manifest, buildV2RecordsText, checkV2MediaIntegrity, planV2Import,
  v2RefusalNext
} = await import('../.build/model/exportImport.js');
const { sha256Hex } = await import('../.build/model/sha256.js');
const {
  canonicalRecordLine, parseTimelineDay, parseLedger, visibleRecords, openRecords,
  deletionState
} = await import('../.build/model/timeline.js');
const {
  buildRecordsText, planUpsert, isNewerSummaryText, openIdsOf,
  ledgerDeleteLine
} = await import('../.build/model/timelineWrite.js');
const {
  assertWritable, unionDay, makeIntentId, markAttempt, replayable, resetForRetry,
  MAX_ATTEMPTS, SYNC_RETRY_ERROR
} = await import('../.build/model/syncProtocol.js');
const { runCyclePure } = await import('../.build/model/syncCycle.js');

const SERVICE = readFileSync(
  new URL('../../entry/src/main/ets/services/syncProtocolStore.ets', import.meta.url), 'utf8'
).replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- fixtures

const DAY = '2026-11-19';
const T0930 = `${DAY}T09:30:00+08:00`;
const T1000 = `${DAY}T10:00:00+08:00`;
const T1100 = `${DAY}T11:00:00+08:00`;
const T1400 = `${DAY}T14:00:00+08:00`;
const T1600 = `${DAY}T16:00:00+08:00`;
const T1630 = `${DAY}T16:30:00+08:00`;
const NOW = new Date('2026-11-19T18:00:00.000Z');
const SHA0 = '0'.repeat(40);
const SHA1 = 'ab'.repeat(32); // 64-char lowercase sha256 for the media fixture

function rec(overrides = {}) {
  const ts = overrides.ts === undefined ? T0930 : overrides.ts;
  return {
    id: 'a1', ts: ts, title: '标题', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: ts, ...overrides
  };
}

/** An upsert intent with payload fixed at enqueue time (contract §9). */
function upsert(record, intentId) {
  const date = record.ts.slice(0, 10);
  return {
    intentId: intentId === undefined ? makeIntentId(date, record.id, record.ts, 'upsert') : intentId,
    op: 'upsert', date: date, id: record.id, ts: record.ts,
    line: canonicalRecordLine(record), enqueuedAt: record.ts,
    attempts: 0, state: 'pending', lastError: ''
  };
}

function deleteIntent(id, ts, intentId) {
  return {
    intentId: intentId, op: 'delete', date: ts.slice(0, 10), id: id, ts: ts,
    line: ledgerDeleteLine(id, ts, ts), enqueuedAt: ts,
    attempts: 0, state: 'pending', lastError: ''
  };
}

const dt = (records = '', deleted = '', restore = '') => ({ records, deleted, restore });

// --- media fixture (same shape as exportImportV2.test.mjs, kept self-contained) ---

function v2rec(overrides = {}) {
  return {
    id: 'r1', ts: T0930, title: '周会', body: '', author: '我', done: false,
    ai_processed: false, media: [], opened_at: T0930, ...overrides
  };
}

/** A valid one-day bundle declaring one media file whose sha256 == goodBytes. */
function makeMediaBundle() {
  const goodBytes = new TextEncoder().encode('good-jpeg-bytes-123');
  const goodSha = sha256Hex(goodBytes);
  const file = `${goodSha.slice(0, 16)}.jpg`;
  const manifestText = buildV2Manifest({
    from: DAY, to: DAY, exportedAt: `${DAY}T09:00:00+08:00`,
    days: [{ date: DAY, recordCount: 1, hasSummary: false, media: [file] }],
    media: [{ file, sha256: goodSha, bytes: goodBytes.length, date: DAY }]
  });
  const records = [v2rec({ id: 'm', ts: T0930, media: [{ file, sha256: goodSha, pageIndex: 0 }] })];
  const bundle = {
    manifestText,
    days: [{ date: DAY, recordsText: buildV2RecordsText(DAY, records), summaryText: '', mediaFiles: [file] }]
  };
  return { bundle, date: DAY, file, goodBytes, goodSha };
}

/** Fake V2MediaCheckIo: source/target bytes and read failures are all injectable. */
function mediaIo(bytes, options = {}) {
  return {
    targetExists: () => options.targetExists === true,
    readTarget: () => {
      if (options.unreadableTarget) {
        throw new Error('target unreadable');
      }
      return options.targetBytes ?? bytes;
    },
    readSource: () => {
      if (options.unreadableSource) {
        throw new Error('source unreadable');
      }
      return bytes;
    }
  };
}

// --- minimal in-memory GitPort / WritePort for runCyclePure cases ---

/** Always-writable port; push rejections are injected via rejectCount. */
class OkPort {
  constructor(schemaVersion = 2) {
    this.schemaText = JSON.stringify({ schemaVersion });
    this.head = SHA0;
    this.pushes = 0;
    this.resets = 0;
    this.commits = [];
    this.forcePushCalls = 0;
    this.rejectCount = 0;
    this.pushError = SYNC_RETRY_ERROR;
  }
  async fetchMain() {}
  async headSha() { return this.head; }
  async originMainSha() { return this.head; }
  async showMain(path) { return path === 'timeline/schema.json' ? this.schemaText : ''; }
  async branchName() { return 'main'; }
  async headRelation() { return 'equal'; }
  async addPaths(_paths) {}
  async commit(message) { this.commits.push(message); }
  async pushMain() {
    this.pushes += 1;
    if (this.pushes <= this.rejectCount) {
      throw new Error(this.pushError);
    }
  }
  async resetHardOrigin() { this.resets += 1; }
  async fastForward() {}
  /** Not part of GitPort: present so a stray force-push would be observable. */
  forcePush() { this.forcePushCalls += 1; }
}

/** Plain recorder: it appends conflicts literally, with NO dedupe of its own. */
function recordingWrite(log) {
  return {
    writeDay: async (date, texts) => { log.days.push({ date, texts }); },
    writeOutbox: async (entries) => { log.outbox = entries; }
  };
}

const emptyReadDay = async () => dt('', '', '');

// ================================================================ Gap A: fake-IO media preflight

test('A1 media preflight: valid bytes -> ok, verified carries the checked bytes', () => {
  const { bundle, file, goodBytes, goodSha } = makeMediaBundle();
  const plan = planV2Import(bundle, { repoIsV2: true, writeEnabled: true });
  assert.equal(plan.ok, true, plan.reason);
  const result = checkV2MediaIntegrity(plan, mediaIo(goodBytes));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.code, '');
  assert.equal(result.verified.length, 1);
  assert.equal(result.verified[0].file, file);
  assert.equal(result.verified[0].sha256, goodSha);
  assert.deepEqual(Array.from(result.verified[0].bytes), Array.from(goodBytes));
});

test('A2 media preflight: tampered bytes -> E_MEDIA_CORRUPT, verified=[] (no writes)', () => {
  const { bundle } = makeMediaBundle();
  const plan = planV2Import(bundle, { repoIsV2: true, writeEnabled: true });
  const result = checkV2MediaIntegrity(plan, mediaIo(new TextEncoder().encode('TAMPERED')));
  assert.equal(result.ok, false);
  assert.equal(result.code, V2_REFUSAL_MEDIA_CORRUPT);
  assert.deepEqual(result.verified, []);
  assert.ok(result.reason.includes('未写入任何内容'));
  assert.match(v2RefusalNext(result.code), /[\u4e00-\u9fa5]/);
});

test('A3 media preflight: unreadable source -> E_MEDIA_CORRUPT, verified=[]', () => {
  const { bundle } = makeMediaBundle();
  const plan = planV2Import(bundle, { repoIsV2: true, writeEnabled: true });
  const result = checkV2MediaIntegrity(plan, mediaIo(new Uint8Array(), { unreadableSource: true }));
  assert.equal(result.code, V2_REFUSAL_MEDIA_CORRUPT);
  assert.deepEqual(result.verified, []);
  assert.ok(result.reason.includes('未写入任何内容'));
});

test('A4 media preflight: target exists but unreadable -> E_MEDIA_CORRUPT, verified=[]', () => {
  const { bundle } = makeMediaBundle();
  const plan = planV2Import(bundle, { repoIsV2: true, writeEnabled: true });
  const result = checkV2MediaIntegrity(plan, mediaIo(new Uint8Array(), {
    targetExists: true, unreadableTarget: true
  }));
  assert.equal(result.code, V2_REFUSAL_MEDIA_CORRUPT);
  assert.deepEqual(result.verified, []);
  assert.ok(result.reason.includes('未写入任何内容'));
});

test('A5 media preflight: media planned but no manifest sha256 entry -> E_MEDIA_CORRUPT, verified=[]', () => {
  const { bundle } = makeMediaBundle();
  const doc = JSON.parse(bundle.manifestText);
  doc.media = [];
  const plan = planV2Import({ ...bundle, manifestText: JSON.stringify(doc) }, { repoIsV2: true, writeEnabled: true });
  assert.equal(plan.ok, true, plan.reason);
  const result = checkV2MediaIntegrity(plan, mediaIo(new TextEncoder().encode('good-jpeg-bytes-123')));
  assert.equal(result.code, V2_REFUSAL_MEDIA_CORRUPT);
  assert.deepEqual(result.verified, []);
});

test('A6 media preflight: same (date,file) two sha256 in manifest -> E_MEDIA_COLLISION, verified=[]', () => {
  const { bundle, file, goodBytes } = makeMediaBundle();
  const doc = JSON.parse(bundle.manifestText);
  doc.media.push({ file, sha256: SHA1, bytes: 10, date: DAY });
  const plan = planV2Import({ ...bundle, manifestText: JSON.stringify(doc) }, { repoIsV2: true, writeEnabled: true });
  assert.equal(plan.ok, true, 'manifest shape still legal; collision caught at preflight');
  const result = checkV2MediaIntegrity(plan, mediaIo(goodBytes));
  assert.equal(result.code, V2_REFUSAL_MEDIA_COLLISION);
  assert.deepEqual(result.verified, []);
  assert.ok(result.reason.includes('未写入任何内容'));
});

test('A7 media preflight: target exists with different bytes -> E_MEDIA_COLLISION, verified=[]', () => {
  const { bundle } = makeMediaBundle();
  const plan = planV2Import(bundle, { repoIsV2: true, writeEnabled: true });
  const result = checkV2MediaIntegrity(plan, mediaIo(new TextEncoder().encode('good-jpeg-bytes-123'), {
    targetExists: true, targetBytes: new TextEncoder().encode('WRONG-OLD-IMAGE')
  }));
  assert.equal(result.code, V2_REFUSAL_MEDIA_COLLISION);
  assert.deepEqual(result.verified, []);
});

test('A8 media preflight: target exists identical -> ok, verified=[] (skip copy, media only grows)', () => {
  const { bundle, goodBytes } = makeMediaBundle();
  const plan = planV2Import(bundle, { repoIsV2: true, writeEnabled: true });
  const result = checkV2MediaIntegrity(plan, mediaIo(goodBytes, { targetExists: true }));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.code, '');
  assert.deepEqual(result.verified, [], 'existing correct file is not re-copied');
});

// ================================================================ Gap B: dedupe against shipped code

test('B1 unionDay dedupes duplicate conflict rows by (id,ts,dedupeKey) — shipped unionDay, no fake dedupe', () => {
  const remote = dt(buildRecordsText(DAY, [rec({ id: 'tie', ts: T1000, body: 'a' })]));
  const local = dt(buildRecordsText(DAY, [rec({ id: 'tie', ts: T1000, body: 'z' })]));
  // Two duplicate replay intents deliver the SAME losing line as the remote/local tie does.
  const losers = [
    upsert(rec({ id: 'tie', ts: T1000, body: 'a' }), 'dup-1'),
    upsert(rec({ id: 'tie', ts: T1000, body: 'a' }), 'dup-2')
  ];
  const union = unionDay(DAY, remote, local, losers, NOW);
  assert.equal(union.conflicts.length, 1, 'unionDay.addConflict must dedupe by (id,ts,dedupeKey)');
  const row = JSON.parse(union.conflicts[0]);
  assert.equal(row.id, 'tie');
  assert.equal(row.ts, T1000);
  assert.equal(row.dedupeKey, sha256Hex(row.losingLine), 'dedupeKey = sha256(canonical losingLine)');
  assert.equal(JSON.parse(row.losingLine).body, 'a', 'byte-smaller line is the loser');
  assert.equal(union.applied.length, 2, 'both duplicate intents are treated as applied and can dequeue');
});

test('B2 runCyclePure drains duplicate outbox intents once with a plain (non-deduping) WritePort', async () => {
  const port = new OkPort();
  const log = { days: [], outbox: [] };
  const record = rec({ id: 'once', title: '一次' });
  const intent = upsert(record, 'content-dedup');
  const outbox = [intent, { ...intent }]; // same payload + same intentId
  const result = await runCyclePure(port, [DAY], emptyReadDay, outbox, NOW, recordingWrite(log));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.days, [DAY]);
  assert.equal(result.applied, 1, 'unique intentId is applied once');
  assert.equal(result.pending, 0);
  assert.deepEqual(result.resultOutbox, [], 'duplicate intents drain completely');
  assert.deepEqual(log.outbox, [], 'outbox atomically written back empty');
  assert.equal(log.days.length, 1, 'one cycle, one writeDay call');
  const written = parseTimelineDay(log.days[0].texts.records, DAY).day;
  assert.equal(written.allRecords.length, 1, 'only one physical row for the id');
});

test('B3 shipped service appends conflicts through appendDedupLines keyed by (id,ts,dedupeKey)', () => {
  // Cross-cycle conflict dedupe lives in the .ets WritePort, not in runCyclePure. Assert the
  // SHIPPED service source (never the twoDevice test double's own dedupe) provides it.
  assert.ok(SERVICE.includes('this.appendDedupLines('), 'writeDayTexts must append conflicts via appendDedupLines');
  assert.ok(SERVICE.includes('this.conflictKey(line)'), 'conflict rows must be keyed by conflictKey');
  assert.ok(SERVICE.includes('row.dedupeKey'), 'conflictKey must include dedupeKey alongside id/ts');
});

test('B4 runCyclePure drains duplicate delete intents once (one ledger row, no retries)', async () => {
  const port = new OkPort();
  const log = { days: [], outbox: [] };
  const del = deleteIntent('gone', T1600, 'del-once');
  const outbox = [del, { ...del }];
  const result = await runCyclePure(port, [DAY], emptyReadDay, outbox, NOW, recordingWrite(log));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.applied, 1);
  assert.equal(result.pending, 0);
  assert.deepEqual(result.resultOutbox, []);
  assert.equal(log.days.length, 1);
  assert.equal(parseLedger(log.days[0].texts.deleted).entries.length, 1, 'one deleted.jsonl row');
  assert.equal(parseLedger(log.days[0].texts.deleted).entries.filter((e) => e.id === 'gone').length, 1);
});

// ================================================================ Gap C: untested contract rules

test('C1 R.ts < D.ts stays hidden (and R == D stays hidden — delete wins)', () => {
  const deletions = parseLedger(`${ledgerDeleteLine('x', T1600, T1600)}\n`).entries;
  const earlierRestore = parseLedger(`${JSON.stringify({ id: 'x', ts: T1400, restoredAt: T1400 })}\n`).entries;
  const equalRestore = parseLedger(`${JSON.stringify({ id: 'x', ts: T1600, restoredAt: T1600 })}\n`).entries;
  assert.equal(deletionState('x', deletions, earlierRestore), 'deleted', 'R < D -> hidden');
  assert.equal(deletionState('x', deletions, equalRestore), 'deleted', 'R == D -> hidden');
  const day = parseTimelineDay(buildRecordsText(DAY, [rec({ id: 'x' })]), DAY).day;
  assert.equal(visibleRecords(day, deletions, earlierRestore).length, 0);
});

test('C2 R.ts > D.ts makes the record visible again (contrast case)', () => {
  const deletions = parseLedger(`${ledgerDeleteLine('x', T1600, T1600)}\n`).entries;
  const laterRestore = parseLedger(`${JSON.stringify({ id: 'x', ts: T1630, restoredAt: T1630 })}\n`).entries;
  assert.equal(deletionState('x', deletions, laterRestore), 'visible');
  const day = parseTimelineDay(buildRecordsText(DAY, [rec({ id: 'x' })]), DAY).day;
  assert.equal(visibleRecords(day, deletions, laterRestore).length, 1);
});

test('C3 media read path: bare <sha16>.jpg is kept; a missing file does not crash read', () => {
  const sha16 = SHA1.slice(0, 16);
  const file = `${sha16}.jpg`;
  const record = rec({ id: 'm', media: [{ file, sha256: SHA1, pageIndex: 0 }] });
  const parsed = parseTimelineDay(buildRecordsText(DAY, [record]), DAY);
  assert.notEqual(parsed.day, null);
  assert.equal(parsed.errors.length, 0, 'bare filename is the only legal shape');
  // The read functions take no filesystem argument: an absent media/ file is never read here.
  // (Rendering the typed 媒体待迁移 placeholder is a .ets UI concern — unverified without a device.)
  const visible = visibleRecords(parsed.day, [], []);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].media[0].file, file, 'media index survives; no image error is thrown');
  assert.deepEqual(openRecords(parsed.day, [], []).map((r) => r.id), ['m']);
});

test('C4 media read path: path-bearing / malformed file is rejected + counted, record retained', () => {
  const bad = [
    { file: `media/${SHA1.slice(0, 16)}.jpg`, sha256: SHA1, pageIndex: 0 },
    { file: `../${SHA1.slice(0, 16)}.jpg`, sha256: SHA1, pageIndex: 0 },
    { file: `${SHA1.slice(0, 8)}.jpg`, sha256: SHA1, pageIndex: 0 },
    { file: `${SHA1.slice(0, 16).toUpperCase()}.jpg`, sha256: SHA1, pageIndex: 0 }
  ];
  const record = rec({ id: 'm', media: bad });
  // buildRecordsText self-checks and refuses malformed media (returns ''), so exercise the pure
  // parser directly with the record serialized by canonicalRecordLine inside a valid day wrapper.
  const text = `{\n  "date": "${DAY}",\n  "open": [],\n  "records": [\n  ${canonicalRecordLine(record)}\n  ]\n}\n`;
  const direct = parseTimelineDay(text, DAY);
  assert.notEqual(direct.day, null, 'the day still parses (fail-soft, no crash)');
  assert.equal(direct.errors.filter((e) => e.message.includes('media[')).length, bad.length);
  assert.equal(direct.day.allRecords.length, 1, 'invalid media drops the entry, not the record');
  assert.equal(direct.day.allRecords[0].media.length, 0);
});

test('C5 summary newer generatedAt wins; equal keeps existing', () => {
  const old = JSON.stringify({ generatedAt: 100, date: DAY });
  assert.equal(isNewerSummaryText(old, JSON.stringify({ generatedAt: 200, date: DAY })), true);
  assert.equal(isNewerSummaryText(old, JSON.stringify({ generatedAt: 100, date: DAY })), false);
  assert.equal(isNewerSummaryText(old, JSON.stringify({ generatedAt: 50, date: DAY })), false);
});

test('C6 summary corrupt / NaN candidate never replaces a good one; valid replaces a bad one', () => {
  const good = JSON.stringify({ generatedAt: 100, date: DAY });
  assert.equal(isNewerSummaryText(good, '{not json'), false, 'corrupt candidate never overwrites good');
  assert.equal(isNewerSummaryText(good, JSON.stringify({ generatedAt: '200' })), false);
  assert.equal(isNewerSummaryText(good, JSON.stringify({ generatedAt: null })), false);
  assert.equal(isNewerSummaryText('{bad old', JSON.stringify({ generatedAt: 200 })), true,
    'a valid candidate may replace a bad/empty old file');
});

test('C7 reopening a closed record refreshes opened_at to the new session ts', () => {
  const closed = rec({ id: 'r', ts: T0930, closed_at: T1400, done: true, opened_at: T0930 });
  const reopened = rec({ id: 'r', ts: T1600, closed_at: undefined, done: false, opened_at: T0930 });
  const plan = planUpsert(DAY, [closed], reopened);
  assert.equal(plan.ok, true, plan.reason);
  const parsed = parseTimelineDay(plan.text, DAY).day;
  const row = parsed.allRecords.find((r) => r.id === 'r');
  assert.equal(row.closed_at, undefined, 'reopen clears closed_at');
  assert.equal(row.opened_at, T1600, 'new uncompleted session gets a fresh opened_at');
  assert.deepEqual(plan.open, ['r'], 'reopened record is in the derived open list');
});

test('C8 completing a record sets closed_at, removes it from open, and keeps duration computable', () => {
  const open = rec({ id: 'r', ts: T0930, opened_at: T0930 });
  const done = rec({ id: 'r', ts: T1400, opened_at: T0930, done: true, closed_at: T1400 });
  const plan = planUpsert(DAY, [open], done);
  assert.equal(plan.ok, true, plan.reason);
  const row = parseTimelineDay(plan.text, DAY).day.allRecords[0];
  assert.equal(row.closed_at, T1400, 'closed_at set on completion');
  assert.equal(row.opened_at, T0930, 'opened_at preserved');
  assert.deepEqual(openIdsOf([row]), [], 'closed_at present -> not open (done is not consulted)');
  const durationMs = Date.parse(row.closed_at) - Date.parse(row.opened_at);
  assert.ok(durationMs > 0, 'completion duration closed_at - opened_at is computable');
});

test('C9 maxAttempts=4: markAttempt reaches failed terminal; replayable excludes; retry resets', () => {
  assert.equal(MAX_ATTEMPTS, 4);
  const third = upsert(rec({ id: 'r' }), 'retry-me');
  const fourth = markAttempt({ ...third, attempts: 3, state: 'pending' }, 'last error');
  assert.equal(fourth.attempts, 4);
  assert.equal(fourth.state, 'failed');
  assert.equal(fourth.lastError, 'last error');
  assert.equal(replayable([fourth]).length, 0, 'failed terminal is never auto-replayed');
  const reset = resetForRetry(fourth);
  assert.equal(reset.attempts, 0);
  assert.equal(reset.state, 'pending');
  assert.equal(reset.lastError, '');
  assert.equal(reset.line, fourth.line, 'retry changes only the budget, never the payload');
  assert.equal(replayable([reset]).length, 1);
});

test('C10 unknown schemaVersion -> runCyclePure zero writes, typed E_SCHEMA_UNKNOWN', async () => {
  const port = new OkPort(99);
  const log = { days: [], outbox: [] };
  let writes = 0;
  const write = recordingWrite(log);
  write.writeDay = async () => { writes += 1; };
  const result = await runCyclePure(port, [DAY], emptyReadDay, [upsert(rec(), 's')], NOW, write);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_SCHEMA_UNKNOWN');
  assert.deepEqual(result.days, []);
  assert.equal(writes, 0, 'no timeline file write');
  assert.equal(port.commits.length, 0, 'no commit');
  assert.equal(port.pushes, 0, 'no push');
  assert.equal(result.pending, 1, 'intent stays in outbox');
});

test('C11 assertWritable returns typed E_SCHEMA_* for unknown / missing version', () => {
  const base = { branch: 'main', headSha: SHA0, originMainSha: SHA0 };
  assert.equal(assertWritable({ ...base, schemaVersion: 99 }).code, 'E_SCHEMA_UNKNOWN');
  assert.equal(assertWritable({ ...base, schemaVersion: null }).code, 'E_SCHEMA_UNKNOWN');
  assert.equal(assertWritable({ ...base, schemaVersion: 2 }).ok, true);
});

test('C12 four consecutive push rejections -> E_PUSH_REJECTED detail preserved, intent failed, no force-push', async () => {
  const port = new OkPort();
  port.rejectCount = 4;
  // Inject a DETAIL-BEARING rejection: setting pushError to SYNC_RETRY_ERROR itself made the
  // old "verbatim detail" assertion vacuous (generic message == injected message).
  const detail = 'E_PUSH_REJECTED: rival advanced first (non-fast-forward); remote gained 3 commits';
  port.pushError = detail;
  const log = { days: [], outbox: [] };
  const intent = upsert(rec({ id: 'push-me' }), 'push-exhaust');
  const result = await runCyclePure(port, [DAY], emptyReadDay, [intent], NOW, recordingWrite(log));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_PUSH_REJECTED');
  assert.ok(result.message.includes(detail), 'typed detail preserved verbatim in user-visible reason');
  assert.equal(result.attempts, 4);
  assert.equal(result.failed, 1);
  assert.equal(result.pending, 0, 'failed terminal is not pending / not auto-replayed');
  assert.equal(port.pushes, 4);
  assert.equal(port.resets, 4, 'each rejection uses the sole reset path');
  assert.equal(port.forcePushCalls, 0, 'never force-push');
  assert.equal(result.resultOutbox.length, 1);
  assert.equal(result.resultOutbox[0].state, 'failed');
  assert.equal(result.resultOutbox[0].attempts, 4);
  assert.equal(result.resultOutbox[0].lastError, detail, 'raw rejection detail survives to lastError');
});

test('C13 push error typed fidelity: E_AUTH detail is preserved, not collapsed to E_PUSH_REJECTED', async () => {
  const port = new OkPort();
  port.rejectCount = 4;
  const detail = 'E_AUTH: token expired; rotate token';
  port.pushError = detail;
  const log = { days: [], outbox: [] };
  const intent = upsert(rec({ id: 'auth-me' }), 'auth-exhaust');
  const result = await runCyclePure(port, [DAY], emptyReadDay, [intent], NOW, recordingWrite(log));
  assert.equal(result.code, 'E_AUTH');
  assert.ok(result.message.includes(detail), 'raw typed detail survives into the reason');
  assert.equal(result.failed, 1);
  assert.equal(result.resultOutbox[0].state, 'failed');
  assert.equal(port.forcePushCalls, 0);
});

// ================================================================ P2 fix (mod-push-detail): typedPushError fidelity

const PUSH_DETAIL = 'E_PUSH_REJECTED: rival advanced first (non-fast-forward)';

test('C14 detail-bearing E_PUSH_REJECTED keeps code + full detail in message and lastError', async () => {
  const port = new OkPort();
  port.rejectCount = 4;
  port.pushError = PUSH_DETAIL;
  const log = { days: [], outbox: [] };
  const result = await runCyclePure(port, [DAY], emptyReadDay,
    [upsert(rec({ id: 'detail-push' }), 'detail-push')], NOW, recordingWrite(log));
  assert.equal(result.code, 'E_PUSH_REJECTED', 'typed code stays E_PUSH_REJECTED');
  assert.ok(result.message.includes(PUSH_DETAIL), 'user-visible reason keeps code + detail');
  assert.equal(result.resultOutbox.length, 1);
  assert.ok(result.resultOutbox[0].lastError.includes(PUSH_DETAIL), 'lastError keeps code + detail');
});

test('C15 bare E_PUSH_REJECTED collapses to the generic Chinese message', async () => {
  const port = new OkPort();
  port.rejectCount = 4;
  port.pushError = 'E_PUSH_REJECTED';
  const log = { days: [], outbox: [] };
  const result = await runCyclePure(port, [DAY], emptyReadDay,
    [upsert(rec({ id: 'bare-push' }), 'bare-push')], NOW, recordingWrite(log));
  assert.equal(result.code, 'E_PUSH_REJECTED');
  assert.equal(result.message, SYNC_RETRY_ERROR, 'bare code -> generic Chinese next-step');
  assert.match(result.message, /[\u4e00-\u9fa5]/);
});

test('C16 non-E_ transport error stays generic (unchanged)', async () => {
  const port = new OkPort();
  port.rejectCount = 4;
  port.pushError = 'socket hang up (ECONNRESET)';
  const log = { days: [], outbox: [] };
  const result = await runCyclePure(port, [DAY], emptyReadDay,
    [upsert(rec({ id: 'transport' }), 'transport')], NOW, recordingWrite(log));
  assert.equal(result.code, 'E_PUSH_REJECTED');
  assert.equal(result.message, SYNC_RETRY_ERROR, 'non-E_ error remains generic');
  assert.equal(result.failed, 1);
});
