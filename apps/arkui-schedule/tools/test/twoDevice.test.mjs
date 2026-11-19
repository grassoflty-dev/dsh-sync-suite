// mod-v2-hardening: deterministic simulated two-device convergence over ONE shared in-memory remote.
//
// Two fake GitPorts (device A / device B) share a single Remote: one timeline/** file map plus a
// tiny linear commit DAG (so behind / ahead / diverged and non-fast-forward push are real, not
// injected strings). Every assertion runs the REAL pure implementations from tools/.build:
// runCyclePure, unionDay (via runCyclePure), buildRecordsText, parseTimelineDay, visibleRecords.
// All cases run against shipped source; S3-e pins the §4 same-ts replay tie-break fix (formerly skipped).
//
// Contract anchors: docs/DATA-CONTRACT-v2.md §4 (line 99: same (id,ts) → UTF-8 byte-larger wins,
// loser → conflicts.jsonl), §7 (lines 130/155/157: physical delete + ledger, visible iff R>D,
// no TTL so no future edit can resurrect), §9 (lines 201-203/229/241: union→replay, idempotency,
// droppedDeleted), §15 (lines 357-367: the eight device scenarios, currently unverified on hardware).
//
// Prerequisite: node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('twoDevice.test.mjs');

// The compiled pure models use relative './model.js' specifiers without the extension.
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

const MODEL = '../.build/model/';
const { runCyclePure } = await import(`${MODEL}syncCycle.js`);
const {
  unionDay, makeIntentId, MAX_ATTEMPTS
} = await import(`${MODEL}syncProtocol.js`);
const {
  canonicalRecordLine, parseTimelineDay, parseLedger, visibleRecords, deletionState
} = await import(`${MODEL}timeline.js`);
const { buildRecordsText, ledgerDeleteLine, ledgerRestoreLine } = await import(`${MODEL}timelineWrite.js`);

// ---------------------------------------------------------------- fixtures

const DAY = '2026-11-19';
const T0930 = `${DAY}T09:30:00+08:00`;
const T1000 = `${DAY}T10:00:00+08:00`;
const T1100 = `${DAY}T11:00:00+08:00`;
const T1400 = `${DAY}T14:00:00+08:00`;
const T1600 = `${DAY}T16:00:00+08:00`;
const T1630 = `${DAY}T16:30:00+08:00`;
const T1700 = `${DAY}T17:00:00+08:00`;
const NOW = new Date('2026-11-19T18:00:00.000Z');
const SHA0 = '0'.repeat(40);
const RECORDS = (date = DAY) => `timeline/${date}/records.json`;
const DELETED = (date = DAY) => `timeline/${date}/deleted.jsonl`;
const RESTORE = (date = DAY) => `timeline/${date}/restore.jsonl`;
const CONFLICTS = (date = DAY) => `timeline/${date}/conflicts.jsonl`;

/** A v2 record. opened_at defaults to ts; pass opened_at explicitly for edits of an older id. */
function rec(overrides = {}) {
  const ts = overrides.ts === undefined ? T0930 : overrides.ts;
  return {
    id: 'a1', ts: ts, title: '标题', body: '', author: '我', done: false,
    media: [], ai_processed: false, opened_at: ts, ...overrides
  };
}

/** An upsert intent: payload fixed at enqueue time (contract §9: replay must not regenerate ts). */
function upsert(record, intentId) {
  const date = record.ts.slice(0, 10);
  return {
    intentId: intentId === undefined ? makeIntentId(date, record.id, record.ts, 'upsert') : intentId,
    op: 'upsert', date: date, id: record.id, ts: record.ts,
    line: canonicalRecordLine(record), enqueuedAt: record.ts,
    attempts: 0, state: 'pending', lastError: ''
  };
}

function ledgerIntent(line, op, id, ts, intentId) {
  return {
    intentId: intentId === undefined ? makeIntentId(ts.slice(0, 10), id, ts, op) : intentId,
    op: op, date: ts.slice(0, 10), id: id, ts: ts,
    line: line, enqueuedAt: ts, attempts: 0, state: 'pending', lastError: ''
  };
}
const deleteIntent = (id, ts, intentId) =>
  ledgerIntent(ledgerDeleteLine(id, ts, ts), 'delete', id, ts, intentId);
const restoreIntent = (id, ts, intentId) =>
  ledgerIntent(ledgerRestoreLine(id, ts, ts), 'restore', id, ts, intentId);

// ---------------------------------------------------------------- shared remote + two device ports

/** The single shared remote: timeline/** files + a commit DAG (parent links = real ancestry). */
class Remote {
  constructor() {
    this.files = new Map();
    this.commits = [{}]; // index 0 = SHA0, root has no parent
    this.head = SHA0;
    this.files.set('timeline/schema.json', JSON.stringify({ schemaVersion: 2 }));
  }

  commit(parent) {
    const sha = `c${String(this.commits.length).padStart(39, '0')}`;
    this.commits.push({ sha: sha, parent: parent });
    return sha;
  }

  isAncestor(ancestor, descendant) {
    let cursor = descendant;
    while (cursor !== null && cursor !== undefined) {
      if (cursor === ancestor) {
        return true;
      }
      const node = this.commits.find((entry) => entry.sha === cursor);
      cursor = node === undefined ? null : node.parent;
    }
    return false;
  }

  relation(head, origin) {
    if (head === origin) {
      return 'equal';
    }
    if (this.isAncestor(head, origin)) {
      return 'behind';
    }
    if (this.isAncestor(origin, head)) {
      return 'ahead';
    }
    return 'diverged';
  }
}

/** One device: its own working copy + outbox, but GitPort I/O targets the shared Remote. */
class Device {
  constructor(remote, name) {
    this.remote = remote;
    this.name = name;
    this.local = new Map();
    this.head = remote.head;
    this.outbox = [];
    this.writes = 0;
    this.commits = 0;
    this.pushes = 0;
    this.resets = 0;
    this.ffs = 0;
    this.commitMessages = [];
    /** Hook used to make a rival push land exactly between this device's commit and push. */
    this.beforePush = null;
  }

  // ---- GitPort
  async fetchMain() { /* shared map is already fresh; origin/main ref read live below */ }
  async headSha() { return this.head; }
  async originMainSha() { return this.remote.head; }
  async showMain(path) { return this.remote.files.get(path) || ''; }
  async branchName() { return 'main'; }
  async headRelation() { return this.remote.relation(this.head, this.remote.head); }
  async addPaths(paths) {
    for (const path of paths) {
      assert.ok(path.startsWith('timeline/'), `commit path escaped timeline/: ${path}`);
    }
  }
  async commit(message) {
    this.commits += 1;
    this.commitMessages.push(message);
    this.head = this.remote.commit(this.head);
  }
  async pushMain() {
    this.pushes += 1;
    if (this.beforePush !== null) {
      const hook = this.beforePush;
      this.beforePush = null;
      await hook();
    }
    // Real non-fast-forward detection: remote head must be this head or its ancestor.
    if (this.head !== this.remote.head && !this.remote.isAncestor(this.remote.head, this.head)) {
      throw new Error('E_PUSH_REJECTED: rival advanced origin/main first');
    }
    this.remote.head = this.head;
    for (const [path, text] of this.local) {
      if (path.startsWith('timeline/')) {
        this.remote.files.set(path, text);
      }
    }
  }
  async resetHardOrigin() {
    this.resets += 1;
    this.head = this.remote.head;
    this.copyRemoteToLocal();
  }
  async fastForward() {
    this.ffs += 1;
    this.head = this.remote.head;
    this.copyRemoteToLocal();
  }
  async listRemoteDays() {
    const set = new Set();
    for (const key of this.remote.files.keys()) {
      const matched = /^timeline\/(\d{4}-\d{2}-\d{2})\/records\.json$/.exec(key);
      if (matched !== null) {
        set.add(matched[1]);
      }
    }
    return Array.from(set).sort();
  }

  // ---- helpers
  copyRemoteToLocal() {
    for (const [key, text] of this.remote.files) {
      if (key.startsWith('timeline/')) {
        this.local.set(key, text);
      }
    }
  }
  readDay() {
    return async (date) => ({
      remote: this.remote.files.get(RECORDS(date)) || '',
      local: this.local.get(RECORDS(date)) || '',
      deleted: this.local.get(DELETED(date)) || '',
      restore: this.local.get(RESTORE(date)) || '',
      remoteDeleted: this.remote.files.get(DELETED(date)) || '',
      remoteRestore: this.remote.files.get(RESTORE(date)) || ''
    });
  }
  writePort() {
    return {
      writeDay: async (date, texts) => {
        this.writes += 1;
        this.local.set(RECORDS(date), texts.records);
        this.local.set(DELETED(date), texts.deleted);
        this.local.set(RESTORE(date), texts.restore);
        if (texts.conflicts.length > 0) {
          // Mirror the shipped WritePort (services/syncProtocolStore.ets:310-313,
          // appendDedupLines by conflictKey = (id,ts,dedupeKey)): dedupe across cycles too.
          const path = CONFLICTS(date);
          const existing = this.local.get(path) || '';
          const seen = new Set();
          for (const line of existing.split(/\r?\n/).filter((item) => item.length > 0)) {
            const row = JSON.parse(line);
            seen.add(`${row.id}\u0000${row.ts}\u0000${row.dedupeKey}`);
          }
          const appended = [];
          for (const line of texts.conflicts) {
            const row = JSON.parse(line);
            const key = `${row.id}\u0000${row.ts}\u0000${row.dedupeKey}`;
            if (!seen.has(key)) {
              seen.add(key);
              appended.push(line);
            }
          }
          if (appended.length > 0) {
            this.local.set(path, `${existing}${appended.join('\n')}\n`);
          }
        }
      },
      writeOutbox: async (entries) => { this.outbox = entries; }
    };
  }
  days() {
    const set = new Set();
    const pattern = /^timeline\/(\d{4}-\d{2}-\d{2})\/records\.json$/;
    for (const map of [this.remote.files, this.local]) {
      for (const key of map.keys()) {
        const matched = pattern.exec(key);
        if (matched !== null) {
          set.add(matched[1]);
        }
      }
    }
    for (const entry of this.outbox) {
      set.add(entry.date);
    }
    return Array.from(set).sort();
  }
  cycle() {
    return runCyclePure(this, this.days(), this.readDay(), this.outbox, NOW, this.writePort());
  }
  dayText(date = DAY) { return this.local.get(RECORDS(date)) || ''; }
  conflictText(date = DAY) { return this.local.get(CONFLICTS(date)) || ''; }
  deletedText(date = DAY) { return this.local.get(DELETED(date)) || ''; }
  restoreText(date = DAY) { return this.local.get(RESTORE(date)) || ''; }
  allRecords(date = DAY) {
    const parsed = parseTimelineDay(this.dayText(date), date);
    assert.notEqual(parsed.day, null, `${this.name}: day must parse`);
    return parsed.day.allRecords;
  }
  visible(date = DAY) {
    const parsed = parseTimelineDay(this.dayText(date), date);
    assert.notEqual(parsed.day, null, `${this.name}: day must parse`);
    const deletions = parseLedger(this.deletedText(date)).entries;
    const restores = parseLedger(this.restoreText(date)).entries;
    return visibleRecords(parsed.day, deletions, restores);
  }
  conflictRows(date = DAY) {
    return this.conflictText(date).split(/\r?\n/).filter((line) => line.length > 0).map((line) => JSON.parse(line));
  }
}

function pair() {
  const remote = new Remote();
  return { remote, A: new Device(remote, 'A'), B: new Device(remote, 'B') };
}

/** Seed a record into the shared remote through A's real cycle (no direct file poking). */
async function seed(remote, A, B, record) {
  A.outbox = [upsert(record, 'seed')];
  const result = await A.cycle();
  assert.equal(result.ok, true, 'seed cycle must succeed');
  const pull = await B.cycle();
  assert.equal(pull.ok, true, 'seed pull must succeed');
}

// ================================================================= S1: create → push → pull

test('S1-a A creates a record and pushes; B fetches/merges and sees byte-identical canonical day', async () => {
  const { A, B } = pair();
  A.outbox = [upsert(rec({ id: 'first', title: '第一次' }), 'create-A')];
  const pushed = await A.cycle();
  assert.equal(pushed.ok, true);
  assert.deepEqual(pushed.days, [DAY]);
  assert.equal(A.outbox.length, 0);

  const pulled = await B.cycle();
  assert.equal(pulled.ok, true);
  assert.equal(B.dayText(), A.dayText(), 'canonical records.json bytes must be identical on both devices');
  assert.deepEqual(B.visible().map((r) => r.id), ['first']);
  assert.equal(B.visible()[0].title, '第一次');
});

test('S1-b multiple records created on A reach B with no lost rows', async () => {
  const { A, B } = pair();
  A.outbox = [
    upsert(rec({ id: 'r1', ts: T0930, title: 'one' }), 'c1'),
    upsert(rec({ id: 'r2', ts: T1100, title: 'two' }), 'c2'),
    upsert(rec({ id: 'r3', ts: T1400, title: 'three' }), 'c3')
  ];
  await A.cycle();
  await B.cycle();
  assert.deepEqual(A.visible().map((r) => r.id).sort(), ['r1', 'r2', 'r3']);
  assert.deepEqual(B.visible().map((r) => r.id).sort(), ['r1', 'r2', 'r3']);
  assert.equal(B.dayText(), A.dayText());
});

test('S1-c B converges by fast-forwarding to A\'s commit (fetch/merge, not a local-only copy)', async () => {
  const { remote, A, B } = pair();
  A.outbox = [upsert(rec({ id: 'ff' }), 'c-ff')];
  await A.cycle();
  const aHead = A.head;
  assert.notEqual(aHead, SHA0);
  const result = await B.cycle();
  assert.equal(result.ok, true);
  assert.equal(B.ffs, 1, 'B was behind and must fast-forward exactly once');
  assert.equal(B.head, aHead);
  assert.equal(B.head, remote.head);
});

// ================================================================= S2: later ts wins silently

test('S2-a B edits the same id with a later ts; A pulls and sees B\'s version', async () => {
  const { remote, A, B } = pair();
  await seed(remote, A, B, rec({ id: 'same', title: 'old', body: 'v1' }));
  B.outbox = [upsert(rec({ id: 'same', ts: T1100, title: 'new', body: 'v2', opened_at: T0930 }), 'edit-B')];
  const edited = await B.cycle();
  assert.equal(edited.ok, true);
  assert.equal(edited.applied, 1);
  await A.cycle();
  assert.equal(A.visible().length, 1);
  assert.equal(A.visible()[0].title, 'new');
  assert.equal(A.visible()[0].body, 'v2');
  assert.equal(A.visible()[0].ts, T1100);
});

test('S2-b different-ts edit is silent later-ts-wins: no conflicts row on either side', async () => {
  const { remote, A, B } = pair();
  await seed(remote, A, B, rec({ id: 'same', title: 'old', opened_at: T0930 }));
  B.outbox = [upsert(rec({ id: 'same', ts: T1400, title: 'much-newer', opened_at: T0930 }), 'edit-B')];
  await B.cycle();
  await A.cycle();
  assert.equal(A.conflictRows().length, 0);
  assert.equal(B.conflictRows().length, 0);
  assert.equal(A.visible()[0].title, 'much-newer');
});

test('S2-c A and B day files are byte-identical after the later-ts edit converges', async () => {
  const { remote, A, B } = pair();
  await seed(remote, A, B, rec({ id: 'same', body: 'old', opened_at: T0930 }));
  B.outbox = [upsert(rec({ id: 'same', ts: T1100, body: 'new', opened_at: T0930 }), 'edit-B')];
  await B.cycle();
  await A.cycle();
  assert.equal(A.dayText(), B.dayText());
  assert.equal(parseTimelineDay(A.dayText(), DAY).day.allRecords.length, 1, 'only the later version survives');
});

// ================================================================= S3: same ts, different bodies

test('S3-a same (id,ts) different bodies converge to the UTF-8 byte-larger canonical line', async () => {
  const { A, B } = pair();
  // Interleaving: the byte-larger body ('z', 0x7a) commits first; the smaller one ('a', 0x61)
  // is then replayed from B's offline outbox. Both must end on the same byte-larger winner.
  const larger = rec({ id: 'tie', ts: T1000, body: 'z' });
  const smaller = rec({ id: 'tie', ts: T1000, body: 'a' });
  assert.ok(Buffer.compare(Buffer.from(canonicalRecordLine(larger), 'utf8'),
    Buffer.from(canonicalRecordLine(smaller), 'utf8')) > 0);

  B.outbox = [upsert(larger, 'intent-larger')];
  A.outbox = [upsert(smaller, 'intent-smaller')];
  await B.cycle(); // 'z' becomes remote truth
  const second = await A.cycle(); // 'a' is replayed and loses the §4 tie-break
  assert.equal(second.ok, true);
  assert.equal(A.visible()[0].body, 'z');
  assert.equal(B.visible()[0].body, 'z');
  assert.equal(A.dayText(), B.dayText(), 'both devices converge to identical canonical bytes');
});

test('S3-b loser is recorded once on both sides with the same dedupeKey (contract §4 / §9)', async () => {
  const { A, B } = pair();
  const larger = rec({ id: 'tie', ts: T1000, body: 'z' });
  const smaller = rec({ id: 'tie', ts: T1000, body: 'a' });
  B.outbox = [upsert(larger, 'intent-larger')];
  A.outbox = [upsert(smaller, 'intent-smaller')];
  await B.cycle();
  const result = await A.cycle();
  assert.equal(result.conflicts, 1);
  await B.cycle(); // B pulls A's conflict audit via fast-forward

  const rowsA = A.conflictRows();
  const rowsB = B.conflictRows();
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  assert.equal(rowsA[0].id, 'tie');
  assert.equal(rowsA[0].ts, T1000);
  assert.match(rowsA[0].dedupeKey, /^[0-9a-f]{64}$/);
  assert.equal(rowsA[0].dedupeKey, rowsB[0].dedupeKey, 'same dedupeKey on both devices');
  assert.equal(rowsA[0].losingLine, rowsB[0].losingLine);
  assert.equal(JSON.parse(rowsA[0].losingLine).body, 'a', 'the byte-smaller line is the loser');
  assert.equal(JSON.parse(rowsA[0].losingLine).id, 'tie');
});

test('S3-c re-running the same conflict three times never appends a duplicate row', async () => {
  const { A, B } = pair();
  B.outbox = [upsert(rec({ id: 'tie', ts: T1000, body: 'z' }), 'intent-larger')];
  A.outbox = [upsert(rec({ id: 'tie', ts: T1000, body: 'a' }), 'intent-smaller')];
  await B.cycle();
  await A.cycle();
  const firstBytes = A.conflictText();
  assert.equal(A.conflictRows().length, 1);

  // Deliver the smaller intent twice more; §9 P1-2 content dedupe must keep one audit row.
  A.outbox = [
    upsert(rec({ id: 'tie', ts: T1000, body: 'a' }), 'intent-smaller'),
    upsert(rec({ id: 'tie', ts: T1000, body: 'a' }), 'intent-smaller')
  ];
  await A.cycle();
  await A.cycle();
  assert.equal(A.conflictRows().length, 1, 'no duplicate conflict rows');
  assert.equal(A.conflictText(), firstBytes, 'conflicts.jsonl stays byte-identical');
  assert.equal(A.outbox.length, 0, 'duplicate intents are idempotent no-ops and drain');
});

test('S3-d tie-break uses UTF-8 byte order, not UTF-16 (astral code point vs private-use BMP)', () => {
  // U+1F600 (surrogate pair D83D DE00) sorts AFTER U+E000 in UTF-8/code-point order,
  // but its UTF-16 lead surrogate 0xD83D sorts BEFORE 0xE000. A UTF-16 implementation
  // would pick the wrong winner. unionDay's byteCompare must pick the astral line.
  const astral = rec({ id: 'u', ts: T1000, body: '\u{1F600}' });
  const bmp = rec({ id: 'u', ts: T1000, body: '\uE000' });
  const astralLine = canonicalRecordLine(astral);
  const bmpLine = canonicalRecordLine(bmp);
  assert.ok(Buffer.compare(Buffer.from(astralLine, 'utf8'), Buffer.from(bmpLine, 'utf8')) > 0,
    'precondition: astral is UTF-8 byte-larger');
  assert.ok(astralLine < bmpLine, 'precondition: UTF-16 string order would disagree');

  const texts = (record) => ({ records: buildRecordsText(DAY, [record]), deleted: '', restore: '' });
  const union = unionDay(DAY, texts(astral), texts(bmp), [], NOW);
  const winner = parseTimelineDay(union.text, DAY).day.allRecords[0];
  assert.equal(winner.body, '\u{1F600}', 'winner must follow UTF-8 byte order');
  assert.equal(union.conflicts.length, 1);
  const conflictRow = JSON.parse(union.conflicts[0]);
  assert.equal(JSON.parse(conflictRow.losingLine).body, '\uE000');
});

// ---------------------------------------------------------------- S3-e..g: replay tie-break (contract §4)

test('S3-e same-ts replay: smaller-first still converges to the UTF-8 byte-larger line', async () => {
  const { A, B } = pair();
  const larger = rec({ id: 'tie', ts: T1000, body: 'z' });
  const smaller = rec({ id: 'tie', ts: T1000, body: 'a' });
  // Smaller body commits first (becomes remote truth); larger body then arrives via replay.
  A.outbox = [upsert(smaller, 'intent-smaller')];
  B.outbox = [upsert(larger, 'intent-larger')];
  await A.cycle();
  const replay = await B.cycle();
  assert.equal(replay.conflicts, 1, 'the §4 tie-break must be audited exactly once');
  await A.cycle(); // A pulls B's converged remote (records + conflict audit)

  assert.equal(A.visible()[0].body, 'z', 'CONTRACT §4: UTF-8 byte-larger canonical line must win');
  assert.equal(B.visible()[0].body, 'z');
  assert.equal(A.dayText(), B.dayText(), 'both devices converge to identical canonical bytes');
  const rowsA = A.conflictRows();
  const rowsB = B.conflictRows();
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  assert.equal(JSON.parse(rowsA[0].losingLine).body, 'a', 'the byte-smaller line is the loser');
  assert.match(rowsA[0].dedupeKey, /^[0-9a-f]{64}$/);
  assert.equal(rowsA[0].dedupeKey, rowsB[0].dedupeKey, 'same dedupeKey on both devices');
});

test('S3-f reverse interleaving (larger committed first, smaller replayed) still converges to the larger', async () => {
  const { A, B } = pair();
  const larger = rec({ id: 'tie', ts: T1000, body: 'z' });
  const smaller = rec({ id: 'tie', ts: T1000, body: 'a' });
  // Mirror of S3-e: the larger body becomes remote truth first; the smaller arrives via replay.
  B.outbox = [upsert(larger, 'intent-larger')];
  A.outbox = [upsert(smaller, 'intent-smaller')];
  await B.cycle();
  const replay = await A.cycle();
  assert.equal(replay.conflicts, 1);
  await B.cycle(); // B pulls A's converged remote

  assert.equal(A.visible()[0].body, 'z');
  assert.equal(B.visible()[0].body, 'z');
  assert.equal(A.dayText(), B.dayText());
  assert.equal(A.conflictRows().length, 1);
  assert.equal(B.conflictRows().length, 1);
  assert.equal(JSON.parse(A.conflictRows()[0].losingLine).body, 'a');
  assert.equal(A.conflictRows()[0].dedupeKey, B.conflictRows()[0].dedupeKey);
});

test('S3-g three-way same-(id,ts) a/b/z converges to z on both sides with exactly two conflict rows', async () => {
  const { A, B } = pair();
  const a = rec({ id: 'tie', ts: T1000, body: 'a' });
  const b = rec({ id: 'tie', ts: T1000, body: 'b' });
  const z = rec({ id: 'tie', ts: T1000, body: 'z' });
  // A replays 'a' then 'b' in one FIFO cycle (b wins over a); B replays 'z' on top of that.
  A.outbox = [upsert(a, 'intent-a'), upsert(b, 'intent-b')];
  B.outbox = [upsert(z, 'intent-z')];
  await A.cycle();
  const replay = await B.cycle();
  assert.equal(replay.conflicts, 1, 'B adds the b-loses-to-z audit row on top of A\'s a-loses-to-b row');
  await A.cycle(); // A pulls B's converged remote (z + both audit rows)

  assert.equal(A.visible()[0].body, 'z');
  assert.equal(B.visible()[0].body, 'z');
  assert.equal(A.dayText(), B.dayText(), 'both devices converge to the byte-largest canonical line');
  const rowsA = A.conflictRows();
  const rowsB = B.conflictRows();
  assert.equal(rowsA.length, 2, 'exactly two losers (a, b) on A');
  assert.equal(rowsB.length, 2, 'exactly two losers (a, b) on B');
  assert.deepEqual(rowsA.map((row) => JSON.parse(row.losingLine).body).sort(), ['a', 'b']);
  assert.deepEqual(rowsB.map((row) => JSON.parse(row.losingLine).body).sort(), ['a', 'b']);
  assert.deepEqual(rowsA.map((row) => row.dedupeKey).sort(), rowsB.map((row) => row.dedupeKey).sort(),
    'same dedupeKeys on both devices');
  assert.equal(new Set(rowsA.map((row) => row.dedupeKey)).size, 2, 'two distinct losers → two distinct keys');
});

// ================================================================= S4: delete vs edit

test('S4-a A deletes (ledger) and B edits offline with an earlier ts: record stays deleted on both', async () => {
  const { remote, A, B } = pair();
  await seed(remote, A, B, rec({ id: 'gone' }));
  A.outbox = [deleteIntent('gone', T1600, 'del-A')];
  const deletion = await A.cycle();
  assert.equal(deletion.applied, 1);
  // B was offline when A deleted; its earlier edit is still parked in the outbox.
  B.outbox = [upsert(rec({ id: 'gone', ts: T1100, body: 'stale edit', opened_at: T0930 }), 'edit-B')];
  const replay = await B.cycle();
  assert.equal(replay.ok, true);
  assert.equal(replay.applied, 0);
  assert.equal(replay.dropped, 1, '§9 P1-3(c): stale upsert for a deleted id is dropped');
  assert.deepEqual(replay.droppedIds, ['edit-B']);
  assert.equal(B.outbox.length, 0, 'dropped intent dequeues, never retries');
  assert.equal(A.visible().length, 0, 'no resurrection on A');
  assert.equal(B.visible().length, 0, 'no resurrection on B');
});

test('S4-b reverse order (B edit has a LATER ts) still stays deleted — contract §7 line 157 + §9 P1-3(c)', async () => {
  // §7: "账本条目永不过期、无 TTL、不自动清理，确保任何未来编辑都无法让已删记录复活"
  //     (ledger entries never expire, so NO future edit can resurrect a deleted record).
  // §9 P1-3(c) line 241: an id in deleted.jsonl makes the upsert be dropped regardless of ts;
  //     only a restore.jsonl row with strictly later ts (§7 line 155) can make it visible again.
  const { remote, A, B } = pair();
  await seed(remote, A, B, rec({ id: 'gone' }));
  A.outbox = [deleteIntent('gone', T1600, 'del-A')];
  await A.cycle();
  B.outbox = [upsert(rec({ id: 'gone', ts: T1700, body: 'later edit', opened_at: T0930 }), 'edit-B')];
  const replay = await B.cycle();
  assert.equal(replay.dropped, 1, 'later-ts does not matter: deletion ledger wins');
  assert.deepEqual(replay.droppedIds, ['edit-B']);
  assert.equal(A.visible().length, 0);
  assert.equal(B.visible().length, 0);
  assert.equal(B.restoreText(), '', 'an edit is not a restore: no restore.jsonl row created');
});

test('S4-c delete ledger converges to one byte-identical row on both devices', async () => {
  const { remote, A, B } = pair();
  await seed(remote, A, B, rec({ id: 'gone' }));
  A.outbox = [deleteIntent('gone', T1600, 'del-A')];
  await A.cycle();
  B.outbox = [upsert(rec({ id: 'gone', ts: T1700, body: 'ignored', opened_at: T0930 }), 'edit-B')];
  await B.cycle();
  const rowsA = parseLedger(A.deletedText()).entries;
  const rowsB = parseLedger(B.deletedText()).entries;
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 1);
  assert.equal(A.deletedText(), B.deletedText());
  assert.equal(rowsA[0].id, 'gone');
  assert.equal(rowsA[0].ts, T1600);
});

test('S4-d both devices still retain the physical row but visibleRecords hides it (§9 P2-13)', () => {
  const { remote, A, B } = pair();
  // Pure read-side check of the documented behaviour: ledger filters, rows are retained.
  const row = rec({ id: 'gone' });
  const text = buildRecordsText(DAY, [row]);
  const day = parseTimelineDay(text, DAY).day;
  const deletions = parseLedger(`${ledgerDeleteLine('gone', T1600, T1600)}\n`).entries;
  const restores = parseLedger('').entries;
  assert.equal(day.allRecords.length, 1, 'row is physically retained');
  assert.equal(visibleRecords(day, deletions, restores).length, 0, 'read side hides the deleted id');
  assert.equal(deletionState('gone', deletions, restores), 'deleted');
  assert.ok(remote.files.has('timeline/schema.json'));
  assert.ok(A instanceof Device && B instanceof Device);
});

// ================================================================= S5: restore after delete

test('S5-a restore with a strictly later ts makes the record visible on both devices', async () => {
  const { remote, A, B } = pair();
  await seed(remote, A, B, rec({ id: 'back' }));
  A.outbox = [deleteIntent('back', T1600, 'del-A')];
  await A.cycle();
  assert.equal(A.visible().length, 0);
  A.outbox = [restoreIntent('back', T1630, 'restore-A')];
  const restored = await A.cycle();
  assert.equal(restored.applied, 1);
  await B.cycle();
  assert.equal(A.visible().length, 1, 'D.ts=16:00 < R.ts=16:30 → visible (§7 line 155)');
  assert.equal(B.visible().length, 1);
  assert.equal(B.visible()[0].id, 'back');
  assert.equal(B.restoreText(), A.restoreText());
});

test('S5-b restore with ts equal to delete ts stays hidden (delete wins, §7 line 156)', async () => {
  const { remote, A, B } = pair();
  await seed(remote, A, B, rec({ id: 'back' }));
  // Both ledger rows in one outbox share the same ts: R === D → not visible.
  A.outbox = [
    deleteIntent('back', T1600, 'del-A'),
    restoreIntent('back', T1600, 'restore-A')
  ];
  const result = await A.cycle();
  assert.equal(result.ok, true);
  assert.equal(result.applied, 2);
  await B.cycle();
  assert.equal(deletionState('back',
    parseLedger(A.deletedText()).entries, parseLedger(A.restoreText()).entries), 'deleted');
  assert.equal(A.visible().length, 0);
  assert.equal(B.visible().length, 0);
});

// ================================================================= S6: offline outbox replay

test('S6-a B writes while offline (intent parked) → online cycle replays → A pulls → converges; pending=0', async () => {
  const { remote, A, B } = pair();
  await seed(remote, A, B, rec({ id: 'base' }));
  // B goes offline: only the outbox changes, no cycle reaches the remote.
  const parked = upsert(rec({ id: 'offline', ts: T1100, title: '离线写入' }), 'offline-B');
  B.outbox = [parked];
  assert.equal(remote.files.has(RECORDS()), true, 'shared remote exists but lacks the offline row');
  assert.equal(parseTimelineDay(B.dayText(), DAY).day.allRecords.some((r) => r.id === 'offline'), false,
    'offline intent has not touched the working copy yet');

  const replay = await B.cycle();
  assert.equal(replay.ok, true);
  assert.equal(replay.applied, 1);
  assert.equal(replay.pending, 0, 'outbox fully drained');
  assert.equal(B.outbox.length, 0);
  assert.deepEqual(replay.resultOutbox, []);
  await A.cycle();
  assert.deepEqual(A.visible().map((r) => r.id).sort(), ['base', 'offline']);
  assert.deepEqual(B.visible().map((r) => r.id).sort(), ['base', 'offline']);
  assert.equal(A.dayText(), B.dayText());
});

test('S6-b parked intent on a day with NO local/remote files is still included in the cycle', async () => {
  const { A, B } = pair();
  const ONLY = '2026-12-07';
  const ts = `${ONLY}T09:00:00+08:00`;
  const parked = upsert(rec({ id: 'newday', ts: ts, title: '新的一天' }), 'newday-B');
  B.outbox = [parked];
  const result = await B.cycle();
  assert.equal(result.ok, true);
  assert.deepEqual(result.days, [ONLY], 'outbox date must be derived into days (review P1-1)');
  assert.equal(B.outbox.length, 0);
  assert.equal(parseTimelineDay(B.dayText(ONLY), ONLY).day.allRecords.length, 1);
  await A.cycle();
  assert.equal(A.visible(ONLY).length, 1);
  assert.equal(A.dayText(ONLY), B.dayText(ONLY));
});

test('S6-c replay never regenerates ts: the enqueued ts is fixed and lands verbatim', async () => {
  const { A, B } = pair();
  const record = rec({ id: 'fixed', ts: T1100, title: '固定时间' });
  const intent = upsert(record, 'fixed-B');
  B.outbox = [intent];
  await B.cycle();
  await A.cycle();
  assert.equal(B.visible()[0].ts, T1100);
  assert.equal(A.visible()[0].ts, T1100);
  assert.equal(intent.ts, T1100, 'intent payload is immutable');
  assert.equal(intent.line, canonicalRecordLine(record));
});

// ================================================================= S7: mid-flight push rejection

test('S7-a B pushes first → A push rejected → reset → replay → both converge with no lost rows', async () => {
  const { A, B } = pair();
  // A and B both create a distinct record offline from the same base.
  A.outbox = [upsert(rec({ id: 'A', body: 'from-A' }), 'add-A')];
  B.outbox = [upsert(rec({ id: 'B', ts: T1000, body: 'from-B' }), 'add-B')];
  // B's commit+push lands exactly between A's local commit and A's push.
  A.beforePush = async () => {
    const rival = await B.cycle();
    assert.equal(rival.ok, true);
  };
  const result = await A.cycle();
  assert.equal(result.ok, true, 'reset→replay must recover');
  assert.equal(result.code, 'ok');
  assert.deepEqual(A.visible().map((r) => r.id).sort(), ['A', 'B']);
  assert.equal(B.visible().length, 1, 'B still has only its own row until it pulls');
  await B.cycle();
  assert.deepEqual(B.visible().map((r) => r.id).sort(), ['A', 'B']);
  assert.equal(A.dayText(), B.dayText(), 'byte-identical after convergence');
});

test('S7-b A resets to origin before replay, bumps attempts to 2, drains outbox, never force-pushes', async () => {
  const { remote, A, B } = pair();
  A.outbox = [upsert(rec({ id: 'A' }), 'add-A')];
  B.outbox = [upsert(rec({ id: 'B', ts: T1000 }), 'add-B')];
  A.beforePush = async () => { await B.cycle(); };
  const result = await A.cycle();
  assert.equal(A.resets, 1, 'exactly one resetHardOrigin');
  assert.equal(A.pushes, 2, 'first push rejected, second succeeds');
  assert.equal(result.attempts, 2);
  assert.equal(A.head, remote.head, 'after reset+replay HEAD == origin/main (no force-push)');
  assert.equal(result.applied, 1);
  assert.equal(result.pending, 0);
  assert.equal(A.outbox.length, 0);
  assert.ok(result.attempts < MAX_ATTEMPTS, 'rejection must not exhaust the retry budget');
});

// ================================================================= S8: idempotency

test('S8-a replaying the same intents twice leaves both day files byte-identical', async () => {
  const { remote, A, B } = pair();
  const first = upsert(rec({ id: 'x', body: 'one' }), 'idem-1');
  const second = upsert(rec({ id: 'y', ts: T1100, body: 'two' }), 'idem-2');
  A.outbox = [first, second];
  await A.cycle();
  await B.cycle();
  const bytesA = A.dayText();
  const bytesB = B.dayText();

  A.outbox = [{ ...first }, { ...second }];
  B.outbox = [];
  const replayA = await A.cycle();
  assert.equal(replayA.ok, true);
  assert.equal(replayA.applied, 2, 'already-applied intents are no-ops, not new rows');
  assert.equal(replayA.pending, 0);
  assert.equal(A.dayText(), bytesA, 'A day file unchanged byte-for-byte');
  await B.cycle();
  assert.equal(B.dayText(), bytesB, 'B day file unchanged byte-for-byte');
  assert.equal(A.dayText(), B.dayText());
});

test('S8-b replay never duplicates ledger rows or conflict rows', async () => {
  const { A, B, remote } = pair();
  await seed(remote, A, B, rec({ id: 'gone' }));
  const del = deleteIntent('gone', T1600, 'del-once');
  A.outbox = [del];
  await A.cycle();
  await B.cycle();
  const delBytesA = A.deletedText();
  const delBytesB = B.deletedText();
  assert.equal(parseLedger(delBytesA).entries.length, 1);

  A.outbox = [{ ...del }, { ...del }];
  const replay = await A.cycle();
  assert.equal(replay.applied, 1, 'identical intentIds collapse to one applied id (content dedupe)');
  assert.equal(replay.pending, 0);
  assert.equal(A.deletedText(), delBytesA, 'delete ledger byte-identical after duplicate replay');
  assert.equal(A.conflictRows().length, 0);
  await B.cycle();
  assert.equal(B.deletedText(), delBytesB);
  assert.equal(B.conflictRows().length, 0);
});
