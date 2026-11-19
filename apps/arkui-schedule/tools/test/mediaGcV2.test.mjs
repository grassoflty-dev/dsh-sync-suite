// mod-v2-media-gc：tools/media-gc-v2.mjs 离线端到端测试（默认只读 + plan hash 确认删除）。
// 直接 execFileSync 调 CLI；fixture 全用 node:fs 在临时目录生成，不依赖任何外部工具。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../../../../tools/media-gc-v2.mjs');
const DAY = '2026-11-19';
const NEXT = '2026-11-20';

// ---------------------------------------------------------------- helpers

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2gc-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, repo };
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function rec(id, ts, files = [], overrides = {}) {
  return {
    id, ts, title: `title-${id}`, body: '', author: '我', done: false,
    media: files.map((file, i) => ({ file, sha256: sha256Hex(file), pageIndex: i })),
    ai_processed: false, opened_at: ts, ...overrides
  };
}

function lines(rows) {
  return rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
}

// media: { '<hex16>.jpg': Buffer|string }
function writeDay(repo, date, { records = [], deleted = null, restore = null, media = {} } = {}) {
  const dayDir = path.join(repo, 'timeline', date);
  fs.mkdirSync(path.join(dayDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dayDir, 'records.json'), JSON.stringify({
    date, open: [], records
  }, null, 2) + '\n', 'utf8');
  if (deleted !== null) fs.writeFileSync(path.join(dayDir, 'deleted.jsonl'), lines(deleted), 'utf8');
  if (restore !== null) fs.writeFileSync(path.join(dayDir, 'restore.jsonl'), lines(restore), 'utf8');
  for (const [name, data] of Object.entries(media)) {
    fs.writeFileSync(path.join(dayDir, 'media', name), Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
  }
  return dayDir;
}

function setupSchema(repo) {
  fs.mkdirSync(path.join(repo, 'timeline'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'timeline', 'schema.json'), JSON.stringify({ schemaVersion: 2 }));
}

function run(...args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function ok(result) {
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  return result;
}

function all(r) {
  return `${r.stdout}\n${r.stderr}`;
}

function tree(root) {
  const out = {};
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child, key);
      else out[key] = fs.readFileSync(child).toString('hex');
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

// 内容 + mtime：证明默认模式连一次写入/替换都没发生。
function treeStat(root) {
  const out = {};
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child, key);
      else {
        const st = fs.statSync(child);
        out[key] = `${fs.readFileSync(child).toString('hex')}@${st.mtimeMs}`;
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

function expectedHash(pathsList) {
  const sorted = pathsList.slice().sort();
  const input = sorted.length ? `${sorted.join('\n')}\n` : '';
  return sha256Hex(input).slice(0, 12);
}

function planFrom(result) {
  return JSON.parse(result.stdout);
}

function hashFromStdout(stdout) {
  const m = /^\[gc\] planHash=([0-9a-f]{12})$/m.exec(stdout);
  assert.ok(m, `缺少 planHash 行：${stdout}`);
  return m[1];
}

// ---------------------------------------------------------------- 22 strict cases

test('01 v2-only with orphans: per-day counts, total bytes, plan hash', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  writeDay(repo, DAY, {
    records: [rec('r1', `${DAY}T09:00:00+08:00`, ['aaaaaaaaaaaaaaaa.jpg'])],
    media: {
      'aaaaaaaaaaaaaaaa.jpg': 'AAAA',
      'bbbbbbbbbbbbbbbb.jpg': 'BB',
      'cccccccccccccccc.jpg': 'CCC'
    }
  });
  const r = ok(run('--repo', repo));
  assert.match(r.stdout, /unreferenced=2 bytes=5/);
  assert.match(r.stdout, new RegExp(`day ${DAY} media=3 referenced=1 unreferenced=2 bytes=5`));
  assert.match(r.stdout, /orphan timeline\/2026-11-19\/media\/bbbbbbbbbbbbbbbb\.jpg bytes=2/);
  assert.match(r.stdout, /orphan timeline\/2026-11-19\/media\/cccccccccccccccc\.jpg bytes=3/);
  assert.equal(hashFromStdout(r.stdout), expectedHash([
    'timeline/2026-11-19/media/bbbbbbbbbbbbbbbb.jpg',
    'timeline/2026-11-19/media/cccccccccccccccc.jpg'
  ]));
  assert.match(r.stdout, /read-only: 未写入任何文件/);
});

test('02 mixed repo: devices/** media-like files ignored, only timeline planned', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const junk = path.join(repo, 'devices', 'tab', 'attachments', 'dddddddddddddddd.jpg');
  fs.mkdirSync(path.dirname(junk), { recursive: true });
  fs.writeFileSync(junk, 'DEVICE-JUNK');
  writeDay(repo, DAY, {
    records: [rec('r1', `${DAY}T09:00:00+08:00`)],
    media: { 'eeeeeeeeeeeeeeee.jpg': 'E' }
  });
  const before = tree(repo);
  const r = ok(run('--repo', repo));
  assert.match(r.stdout, /unreferenced=1 bytes=1/);
  assert.match(r.stdout, /eeeeeeeeeeeeeeee\.jpg/);
  assert.doesNotMatch(r.stdout, /dddddddddddddddd\.jpg/);
  assert.deepEqual(tree(repo), before);
});

test('03 ledger-filtered rows: deleted record media becomes orphan, restored stays referenced', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  writeDay(repo, DAY, {
    records: [rec('gone', `${DAY}T09:00:00+08:00`, ['ffffffffffffffff.jpg'])],
    deleted: [{ id: 'gone', ts: `${DAY}T12:00:00+08:00`, deletedAt: `${DAY}T12:00:00+08:00` }],
    media: { 'ffffffffffffffff.jpg': 'GONE' }
  });
  writeDay(repo, NEXT, {
    records: [rec('back', `${NEXT}T09:00:00+08:00`, ['1111111111111111.jpg'])],
    deleted: [{ id: 'back', ts: `${NEXT}T10:00:00+08:00` }],
    restore: [{ id: 'back', ts: `${NEXT}T11:00:00+08:00` }],
    media: { '1111111111111111.jpg': 'BACK' }
  });
  const r = ok(run('--repo', repo, '--json'));
  const p = planFrom(r);
  assert.equal(p.unreferenced, 1);
  assert.deepEqual(p.plan.map((x) => x.path), ['timeline/2026-11-19/media/ffffffffffffffff.jpg']);
  assert.equal(p.perDay.find((d) => d.date === NEXT).referenced, 1);
});

test('04 no orphans: empty plan exit 0, hash of empty list', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  writeDay(repo, DAY, {
    records: [rec('r', `${DAY}T09:00:00+08:00`, ['2222222222222222.jpg'])],
    media: { '2222222222222222.jpg': 'KEEP' }
  });
  const r = ok(run('--repo', repo));
  assert.match(r.stdout, /unreferenced=0 bytes=0/);
  assert.equal(hashFromStdout(r.stdout), expectedHash([]));
  assert.doesNotMatch(r.stdout, /orphan /);
});

test('05 --delete without --confirm: exit 2 typed refusal, zero writes', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, DAY, {
    records: [rec('r', `${DAY}T09:00:00+08:00`)],
    media: { '3333333333333333.jpg': 'ORPHAN' }
  });
  const before = treeStat(repo);
  const r = run('--repo', repo, '--delete');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_NO_CONFIRM/);
  assert.match(r.stderr, /--delete 必须同时提供 --confirm/);
  assert.deepEqual(treeStat(repo), before);
});

test('06 --delete with wrong token: exit 2 E_BAD_CONFIRM, zero writes', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, DAY, {
    records: [rec('r', `${DAY}T09:00:00+08:00`)],
    media: { '4444444444444444.jpg': 'ORPHAN' }
  });
  const before = treeStat(repo);
  const r = run('--repo', repo, '--delete', '--confirm', 'badbadbadbad');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_BAD_CONFIRM/);
  assert.match(r.stderr, /不符/);
  assert.deepEqual(treeStat(repo), before);
});

test('07 --delete with correct token: only planned files removed, byte-compare everything else', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const junk = path.join(repo, 'devices', 'tab', 'attachments', 'junk.jpg');
  fs.mkdirSync(path.dirname(junk), { recursive: true });
  fs.writeFileSync(junk, 'DEVICE-JUNK');
  writeDay(repo, DAY, {
    records: [rec('r', `${DAY}T09:00:00+08:00`, ['aaaaaaaaaaaaaaaa.jpg'])],
    deleted: [{ id: 'ghost', ts: `${DAY}T12:00:00+08:00` }],
    restore: [{ id: 'ghost', ts: `${DAY}T11:00:00+08:00` }],
    media: {
      'aaaaaaaaaaaaaaaa.jpg': 'KEEP',
      'bbbbbbbbbbbbbbbb.jpg': 'DROP-B',
      'cccccccccccccccc.jpg': 'DROP-C'
    }
  });
  const dry = ok(run('--repo', repo, '--json'));
  const token = planFrom(dry).planHash;
  const before = tree(repo);
  const r = ok(run('--repo', repo, '--delete', '--confirm', token));
  const after = tree(repo);
  const removed = [
    'timeline/2026-11-19/media/bbbbbbbbbbbbbbbb.jpg',
    'timeline/2026-11-19/media/cccccccccccccccc.jpg'
  ];
  assert.equal(r.status, 0);
  assert.match(r.stdout, /已删除 2 个文件/);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).filter((k) => !removed.includes(k)).sort());
  for (const key of Object.keys(after)) assert.equal(after[key], before[key], `未计划文件被改动：${key}`);
  assert.equal(fs.existsSync(junk), true);
  assert.match(r.stderr, /unlink timeline\/2026-11-19\/media\/bbbbbbbbbbbbbbbb\.jpg bytes=6/);
  assert.match(r.stderr, /unlink timeline\/2026-11-19\/media\/cccccccccccccccc\.jpg bytes=6/);
});

test('08 --json shape: keys, plan entries, perDay, 12-hex hash', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, DAY, {
    records: [rec('r', `${DAY}T09:00:00+08:00`)],
    media: { '5555555555555555.jpg': 'AB' }
  });
  const r = ok(run('--repo', repo, '--json'));
  const p = planFrom(r);
  for (const key of ['mode', 'repo', 'planHash', 'days', 'mediaFiles', 'referenced', 'unreferenced', 'bytes', 'perDay', 'plan', 'deleted']) {
    assert.ok(Object.prototype.hasOwnProperty.call(p, key), `JSON 缺少 ${key}`);
  }
  assert.equal(p.mode, 'read-only');
  assert.match(p.planHash, /^[0-9a-f]{12}$/);
  assert.deepEqual(p.plan, [{
    date: DAY, file: '5555555555555555.jpg',
    path: 'timeline/2026-11-19/media/5555555555555555.jpg', bytes: 2
  }]);
  assert.deepEqual(p.perDay, [{ date: DAY, mediaFiles: 1, referenced: 0, unreferenced: 1, bytes: 2 }]);
  assert.deepEqual(p.deleted, []);
});

test('09 determinism: two runs produce identical hash and identical output', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, DAY, {
    records: [rec('r', `${DAY}T09:00:00+08:00`, ['6666666666666666.jpg'])],
    media: {
      '6666666666666666.jpg': 'A',
      '7777777777777777.jpg': 'BB',
      '8888888888888888.jpg': 'CCC'
    }
  });
  writeDay(repo, NEXT, {
    records: [],
    media: { '9999999999999999.jpg': 'DDDD' }
  });
  const a = ok(run('--repo', repo));
  const b = ok(run('--repo', repo));
  assert.equal(a.stdout, b.stdout);
  assert.equal(hashFromStdout(a.stdout), hashFromStdout(b.stdout));
});

test('10 default mode is read-only: tree byte-and-mtime identical', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  writeDay(repo, DAY, {
    records: [rec('r', `${DAY}T09:00:00+08:00`)],
    deleted: [{ id: 'd', ts: `${DAY}T10:00:00+08:00` }],
    media: { 'aaaaaaaaaaaaaaaa.jpg': 'ORPHAN' }
  });
  const before = treeStat(repo);
  ok(run('--repo', repo));
  assert.deepEqual(treeStat(repo), before);
});

test('11 fold by id: only the winning version media stays referenced', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, DAY, {
    records: [
      rec('x', `${DAY}T09:00:00+08:00`, ['aaaaaaaaaaaaaaaa.jpg'], { title: 'old' }),
      rec('x', `${DAY}T11:00:00+08:00`, ['bbbbbbbbbbbbbbbb.jpg'], { title: 'new' })
    ],
    media: { 'aaaaaaaaaaaaaaaa.jpg': 'OLD', 'bbbbbbbbbbbbbbbb.jpg': 'NEW' }
  });
  const p = planFrom(ok(run('--repo', repo, '--json')));
  assert.deepEqual(p.plan.map((x) => x.file), ['aaaaaaaaaaaaaaaa.jpg']);
});

test('12 same (id,ts) tie-break: UTF-8 byte-larger canonical line wins', (t) => {
  const { repo } = fixture(t);
  const ts = `${DAY}T09:00:00+08:00`;
  writeDay(repo, DAY, {
    records: [
      rec('dup', ts, ['aaaaaaaaaaaaaaaa.jpg'], { title: 'first' }),
      rec('dup', ts, ['bbbbbbbbbbbbbbbb.jpg'], { title: 'second' })
    ],
    media: { 'aaaaaaaaaaaaaaaa.jpg': 'LOSE', 'bbbbbbbbbbbbbbbb.jpg': 'WIN' }
  });
  // 'second' 的首字节 0x73 > 'first' 的 0x66 → byte-larger line wins（与 §4 一致）。
  const p = planFrom(ok(run('--repo', repo, '--json')));
  assert.deepEqual(p.plan.map((x) => x.file), ['aaaaaaaaaaaaaaaa.jpg']);
});

test('13 invalid media file name in record: skipped, never crashes, other orphan still found', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, DAY, {
    records: [rec('r', `${DAY}T09:00:00+08:00`, ['../evil.jpg', 'AAAAAAAAAAAAAAAA.JPG', 'aaaaaaaaaaaaaaaa.jpg'])],
    media: { 'aaaaaaaaaaaaaaaa.jpg': 'KEEP', 'bbbbbbbbbbbbbbbb.jpg': 'ORPHAN' }
  });
  const r = ok(run('--repo', repo, '--json'));
  const p = planFrom(r);
  assert.deepEqual(p.plan.map((x) => x.file), ['bbbbbbbbbbbbbbbb.jpg']);
  assert.doesNotMatch(all(r), /未预期错误/);
});

test('14 invalid date directory skipped: its media never enters plan', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, '2026-13-99', { records: [], media: { 'cccccccccccccccc.jpg': 'BAD-DAY' } });
  writeDay(repo, DAY, {
    records: [],
    media: { 'dddddddddddddddd.jpg': 'GOOD-ORPHAN' }
  });
  const r = ok(run('--repo', repo));
  assert.match(r.stdout, /skippedDays=1/);
  assert.match(r.stdout, /unreferenced=1/);
  assert.match(r.stdout, /dddddddddddddddd\.jpg/);
  assert.doesNotMatch(r.stdout, /2026-13-99/);
});

test('15 --delete with correct token but empty plan: exit 2 E_NOTHING_TO_DELETE, zero writes', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, DAY, {
    records: [rec('r', `${DAY}T09:00:00+08:00`, ['aaaaaaaaaaaaaaaa.jpg'])],
    media: { 'aaaaaaaaaaaaaaaa.jpg': 'KEEP' }
  });
  const token = hashFromStdout(ok(run('--repo', repo)).stdout);
  const before = treeStat(repo);
  const r = run('--repo', repo, '--delete', '--confirm', token);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_NOTHING_TO_DELETE/);
  assert.deepEqual(treeStat(repo), before);
});

test('16 --quiet suppresses detail but keeps summary and plan hash', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, DAY, {
    records: [],
    media: { 'aaaaaaaaaaaaaaaa.jpg': 'X', 'bbbbbbbbbbbbbbbb.jpg': 'YY' }
  });
  const r = ok(run('--repo', repo, '--quiet'));
  assert.match(r.stdout, /^\[gc\] mode=read-only /m);
  assert.match(r.stdout, /^\[gc\] planHash=[0-9a-f]{12}$/m);
  assert.doesNotMatch(r.stdout, /\[gc\] day /);
  assert.doesNotMatch(r.stdout, /\[gc\] orphan /);
});

test('17 --delete + --json: stdout pure JSON with deleted list, unlink logged on stderr', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, DAY, {
    records: [],
    media: { 'aaaaaaaaaaaaaaaa.jpg': 'X' }
  });
  const token = planFrom(ok(run('--repo', repo, '--json'))).planHash;
  const r = ok(run('--repo', repo, '--delete', '--confirm', token, '--json'));
  const p = planFrom(r);
  assert.equal(p.mode, 'delete');
  assert.equal(p.deleted.length, 1);
  assert.equal(p.deleted[0].path, 'timeline/2026-11-19/media/aaaaaaaaaaaaaaaa.jpg');
  assert.match(r.stderr, /^\[gc\] unlink timeline\/2026-11-19\/media\/aaaaaaaaaaaaaaaa\.jpg bytes=1$/m);
});

test('18 --confirm without --delete: exit 2 typed refusal', (t) => {
  const { repo } = fixture(t);
  const r = run('--repo', repo, '--confirm', 'aaaaaaaaaaaa');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_CONFIRM_WITHOUT_DELETE/);
});

test('19 missing --repo: exit 2 E_MISSING_REPO', (t) => {
  fixture(t);
  const r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_MISSING_REPO/);
});

test('20 plan hash changes when the plan changes', (t) => {
  const { repo } = fixture(t);
  writeDay(repo, DAY, {
    records: [],
    media: { 'aaaaaaaaaaaaaaaa.jpg': 'X' }
  });
  const first = hashFromStdout(ok(run('--repo', repo)).stdout);
  writeDay(repo, NEXT, {
    records: [],
    media: { 'bbbbbbbbbbbbbbbb.jpg': 'Y' }
  });
  const second = hashFromStdout(ok(run('--repo', repo)).stdout);
  assert.notEqual(first, second);
  assert.equal(second, expectedHash([
    'timeline/2026-11-19/media/aaaaaaaaaaaaaaaa.jpg',
    'timeline/2026-11-20/media/bbbbbbbbbbbbbbbb.jpg'
  ]));
});

test('21 delete never touches records / ledgers / schema / devices', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const junk = path.join(repo, 'devices', 'tab', 'schedules', `${DAY}.jsonl`);
  fs.mkdirSync(path.dirname(junk), { recursive: true });
  fs.writeFileSync(junk, '{"id":"v1"}\n');
  writeDay(repo, DAY, {
    records: [rec('r', `${DAY}T09:00:00+08:00`)],
    deleted: [{ id: 'd', ts: `${DAY}T10:00:00+08:00` }],
    restore: [{ id: 'd', ts: `${DAY}T11:00:00+08:00` }],
    media: { 'aaaaaaaaaaaaaaaa.jpg': 'ORPHAN' }
  });
  const token = planFrom(ok(run('--repo', repo, '--json'))).planHash;
  const protectedBefore = {};
  for (const rel of [
    'timeline/schema.json', `timeline/${DAY}/records.json`,
    `timeline/${DAY}/deleted.jsonl`, `timeline/${DAY}/restore.jsonl`,
    'devices/tab/schedules/2026-11-19.jsonl'
  ]) protectedBefore[rel] = fs.readFileSync(path.join(repo, rel), 'utf8');
  ok(run('--repo', repo, '--delete', '--confirm', token));
  for (const [rel, before] of Object.entries(protectedBefore)) {
    assert.equal(fs.readFileSync(path.join(repo, rel), 'utf8'), before, `受保护文件被改动：${rel}`);
  }
  assert.equal(fs.existsSync(path.join(repo, 'timeline', DAY, 'media', 'aaaaaaaaaaaaaaaa.jpg')), false);
});

test('22 --repo may point directly at the timeline/ directory', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  writeDay(repo, DAY, {
    records: [],
    media: { 'aaaaaaaaaaaaaaaa.jpg': 'X' }
  });
  const r = ok(run('--repo', path.join(repo, 'timeline'), '--json'));
  const p = planFrom(r);
  assert.deepEqual(p.plan.map((x) => x.path), ['timeline/2026-11-19/media/aaaaaaaaaaaaaaaa.jpg']);
  assert.equal(p.repo, repo);
});
