// v1 -> v2 记录迁移工具的离线端到端测试：node:test + node:assert/strict，
// 直接 execFileSync 调用工具，不依赖任何构建产物。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../../../../tools/migrate-v1-to-v2.mjs');
const DAY = '2026-11-19';
// 工具在 import 时不运行 main（CLI guard），可直接在进程内测契约 §3 的纯函数与原子写。
const { canonicalRecordLine, writeDayAtomic } = await import(pathToFileURL(TOOL).href);

// ---------------------------------------------------------------- helpers

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2mig-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'devices'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, repo };
}

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : null,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : String(err.message || err)
    };
  }
}

function ok(result) {
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  return result;
}

function writeLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n', 'utf8');
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sched(repo, device, date, rows) {
  writeLines(path.join(repo, 'devices', device, 'schedules', `${date}.jsonl`), rows);
}

function opens(repo, device, rows) {
  writeLines(path.join(repo, 'devices', device, 'open.jsonl'), rows);
}

function summ(repo, device, date, obj) {
  writeJson(path.join(repo, 'devices', device, 'summaries', `${date}.json`), obj);
}

function rec(id, ts, overrides = {}) {
  return {
    id, ts, title: `title-${id}`, body: `body-${id}`, author: '我',
    done: false, ai_processed: false, ...overrides
  };
}

function dayDir(repo, date = DAY) {
  return path.join(repo, 'timeline', date);
}

function doc(repo, date = DAY) {
  return readJson(path.join(dayDir(repo, date), 'records.json'));
}

function text(repo, date = DAY) {
  return fs.readFileSync(path.join(dayDir(repo, date), 'records.json'), 'utf8');
}

// 每日本契约账本（契约 §10 步骤 2）：文件必然存在，空文件读作 []。
function ledger(repo, name, date = DAY) {
  const raw = fs.readFileSync(path.join(dayDir(repo, date), name), 'utf8');
  return raw === '' ? [] : raw.trim().split('\n').map(JSON.parse);
}

function tree(root) {
  const out = {};
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child, key);
      else out[key] = fs.readFileSync(child, 'utf8');
    }
  };
  walk(root);
  return out;
}

function tmpDirs(repo) {
  return fs.readdirSync(repo).filter((name) => name.startsWith('timeline.tmp-'));
}

// ---------------------------------------------------------------- 22 required cases

test('01 single-device single-day basic migration (records / open / deleted produced)', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'phone', DAY, [
    rec('a', `${DAY}T09:00:00+08:00`, { done: true }),
    rec('b', `${DAY}T10:00:00+08:00`, { deleted: true })
  ]);
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /plan days=1 records=1 deletes=1 summaries=0 skipped=0 duplicates=0/);
  assert.match(r.stdout, /verify ok days=1 records=1 deletes=1 summaries=0 skipped=0/);
  const d = doc(repo);
  assert.deepEqual(d.records.map((x) => x.id), ['a']);
  assert.deepEqual(d.open, []);
  const ledger = fs.readFileSync(path.join(dayDir(repo), 'deleted.jsonl'), 'utf8').trim().split('\n');
  assert.equal(ledger.length, 1);
  assert.equal(JSON.parse(ledger[0]).id, 'b');
});

test('02 multi-device fold: same id with later ts wins', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'phone-a', DAY, [rec('x', `${DAY}T09:00:00+08:00`, { title: 'old' })]);
  sched(repo, 'pc-b', DAY, [rec('x', `${DAY}T10:00:00+08:00`, { title: 'new' })]);
  ok(run('--repo', repo, '--apply'));
  const records = doc(repo).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'new');
  assert.equal(records[0].ts, `${DAY}T10:00:00+08:00`);
});

test('03 same (id,ts) different content: UTF-8 byte-larger canonical line wins, loser -> conflicts.jsonl', (t) => {
  const { repo, dir } = fixture(t);
  sched(repo, 'a', DAY, [
    rec('dup', `${DAY}T09:00:00+08:00`, { title: 'first' }),
    rec('dup', `${DAY}T09:00:00+08:00`, { title: 'second' })
  ]);
  const dry = ok(run('--repo', repo));
  assert.match(dry.stdout, /duplicates=0 conflicts=1/);
  ok(run('--repo', repo, '--apply'));
  const records = doc(repo).records;
  assert.equal(records.length, 1);
  // 契约 §4：'second' 首字节 0x73 > 'first' 的 0x66 ⇒ 规范整行字节较大者胜，与出现顺序无关。
  assert.equal(records[0].title, 'second');
  const rows = ledger(repo, 'conflicts.jsonl');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'dup');
  assert.equal(rows[0].ts, `${DAY}T09:00:00+08:00`);
  assert.match(rows[0].losingLine, /"id":"dup"/);
  assert.match(rows[0].losingLine, /"title":"first"/);
  assert.equal(typeof rows[0].decidedAt, 'string');
  assert.equal(rows[0].dedupeKey.length, 64);

  // 输入顺序颠倒并分落两台设备 → 胜者与败者逐字节一致（确定性）。
  const repo2 = path.join(dir, 'repo2');
  fs.mkdirSync(path.join(repo2, 'devices'), { recursive: true });
  sched(repo2, 'z', DAY, [
    rec('dup', `${DAY}T09:00:00+08:00`, { title: 'second' }),
    rec('dup', `${DAY}T09:00:00+08:00`, { title: 'first' })
  ]);
  ok(run('--repo', repo2, '--apply'));
  assert.equal(doc(repo2).records[0].title, 'second');
  assert.deepEqual(ledger(repo2, 'conflicts.jsonl').map((r) => r.losingLine), rows.map((r) => r.losingLine));
});

test('04 tombstone: ledger entry, absent from records, no deleted field anywhere', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [
    rec('alive', `${DAY}T09:00:00+08:00`),
    rec('dead', `${DAY}T09:30:00+08:00`),
    rec('dead', `${DAY}T10:00:00+08:00`, { deleted: true, title: 'tombstone' })
  ]);
  ok(run('--repo', repo, '--apply'));
  const raw = text(repo);
  assert.equal(raw.includes('"deleted"'), false);
  const d = doc(repo);
  assert.deepEqual(d.records.map((x) => x.id), ['alive']);
  for (const record of d.records) assert.equal('deleted' in record, false);
  const rows = fs.readFileSync(path.join(dayDir(repo), 'deleted.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'dead');
  assert.equal(rows[0].ts, `${DAY}T10:00:00+08:00`);
  assert.equal(rows[0].deletedAt, '2026-11-19T02:00:00.000Z');
});

test('05 open.jsonl openedAt/closedAt mapping with later ts winning', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('r1', `${DAY}T09:00:00+08:00`, { done: true })]);
  opens(repo, 'a', [
    { id: 'r1', ts: `${DAY}T08:00:00+08:00`, openedAt: `${DAY}T08:00:00+08:00`, closedAt: `${DAY}T08:10:00+08:00` },
    { id: 'r1', ts: `${DAY}T09:00:00+08:00`, openedAt: `${DAY}T09:00:00+08:00`, closedAt: `${DAY}T09:05:00+08:00` }
  ]);
  ok(run('--repo', repo, '--apply'));
  const r = doc(repo).records[0];
  assert.equal(r.opened_at, `${DAY}T09:00:00+08:00`);
  assert.equal(r.closed_at, `${DAY}T09:05:00+08:00`);
});

test('06 missing open entry: fallback opened_at=ts, closed_at only when done', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [
    rec('done-one', `${DAY}T09:00:00+08:00`, { done: true }),
    rec('open-one', `${DAY}T10:00:00+08:00`, { done: false })
  ]);
  ok(run('--repo', repo, '--apply'));
  const byId = Object.fromEntries(doc(repo).records.map((r) => [r.id, r]));
  assert.equal(byId['done-one'].opened_at, `${DAY}T09:00:00+08:00`);
  assert.equal(byId['done-one'].closed_at, `${DAY}T09:00:00+08:00`);
  assert.equal(byId['open-one'].opened_at, `${DAY}T10:00:00+08:00`);
  assert.equal('closed_at' in byId['open-one'], false);
});

test('07 open array derived from closed_at only, not done (contract §6 P2-2)', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [
    rec('withClosed', `${DAY}T09:00:00+08:00`, { done: false }),
    rec('doneNoClose', `${DAY}T10:30:00+08:00`, { done: true }),
    rec('noClose', `${DAY}T11:00:00+08:00`, { done: false })
  ]);
  opens(repo, 'a', [
    { id: 'withClosed', ts: `${DAY}T09:00:00+08:00`, openedAt: `${DAY}T09:00:00+08:00`, closedAt: `${DAY}T09:30:00+08:00` },
    { id: 'doneNoClose', ts: `${DAY}T10:30:00+08:00`, openedAt: `${DAY}T10:30:00+08:00`, closedAt: '' },
    { id: 'noClose', ts: `${DAY}T11:00:00+08:00`, openedAt: `${DAY}T11:00:00+08:00` }
  ]);
  ok(run('--repo', repo, '--apply'));
  // 契约 §6 可测例：{done:false, closed_at:'...'} 不在 open；{done:true, closed_at:''/缺省} 在 open。
  assert.deepEqual(doc(repo).open, ['doneNoClose', 'noClose']);
});

test('08 two device summaries: newest generatedAt wins (equal keeps first)', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`)]);
  summ(repo, 'a', DAY, { version: 1, date: DAY, generatedAt: 1000, model: 'old', points: ['A'] });
  summ(repo, 'b', DAY, { version: 1, date: DAY, generatedAt: 2000, model: 'new', points: ['B'] });
  summ(repo, 'c', DAY, { version: 1, date: DAY, generatedAt: 2000, model: 'tie', points: ['C'] });
  ok(run('--repo', repo, '--apply'));
  const s = readJson(path.join(dayDir(repo), 'summary.json'));
  assert.equal(s.generatedAt, 2000);
  assert.equal(s.model, 'new');
  assert.deepEqual(s.points, ['B']);
});

test('09 malformed JSONL line skipped and counted in plan, run succeeds', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, ['{bad json', rec('ok', `${DAY}T09:00:00+08:00`)]);
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /skipped=1/);
  assert.match(r.stdout, /verify ok days=1 records=1 deletes=0 summaries=0 skipped=1/);
  assert.equal(fs.existsSync(path.join(dayDir(repo), 'records.json')), true);
  assert.deepEqual(doc(repo).records.map((x) => x.id), ['ok']);
});

test('10 determinism: two --apply runs into separate --out dirs are byte-identical', (t) => {
  const { repo, dir } = fixture(t);
  const sha = 'abcdef0123456789'.repeat(4);
  sched(repo, 'a', DAY, [
    rec('x', `${DAY}T09:00:00+08:00`, { attachments: [{ sha256: sha, pageIndex: 0 }] }),
    rec('y', `${DAY}T11:00:00+08:00`, { deleted: true })
  ]);
  opens(repo, 'a', [{ id: 'x', ts: `${DAY}T09:00:00+08:00`, openedAt: `${DAY}T08:55:00+08:00` }]);
  summ(repo, 'a', DAY, { version: 1, generatedAt: 3000, model: 'm' });
  const outA = path.join(dir, 'outA');
  const outB = path.join(dir, 'outB');
  ok(run('--repo', repo, '--apply', '--out', outA));
  ok(run('--repo', repo, '--apply', '--out', outB));
  assert.deepEqual(tree(path.join(outA, 'timeline')), tree(path.join(outB, 'timeline')));
});

test('11 --dry-run writes nothing (tree unchanged)', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  const before = tree(repo);
  const r = ok(run('--repo', repo, '--dry-run'));
  assert.match(r.stdout, /dry-run: 未写入任何文件/);
  assert.deepEqual(tree(repo), before);
  assert.equal(fs.existsSync(path.join(repo, 'timeline')), false);
  assert.deepEqual(tmpDirs(repo), []);
});

test('12 --apply key order + one-line-per-record shape', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [
    rec('done', `${DAY}T09:00:00+08:00`, { done: true }),
    rec('open', `${DAY}T10:00:00+08:00`)
  ]);
  ok(run('--repo', repo, '--apply'));
  assert.equal(readJson(path.join(repo, 'timeline', 'schema.json')).schemaVersion, 2);
  const raw = text(repo);
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed), ['date', 'open', 'records']);
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.endsWith('\n\n'), false);
  const lines = raw.split('\n');
  assert.equal(lines[lines.length - 1], '');
  assert.equal(lines[0], '{');
  assert.match(lines[1], /^  "date": "/);
  assert.match(lines[2], /^  "open": /);
  const start = lines.indexOf('  "records": [');
  const end = lines.indexOf('  ]', start + 1);
  assert.ok(start > 2 && end > start);
  assert.equal(end - start - 1, parsed.records.length); // N record lines + 2 bracket lines
  assert.equal(lines[lines.length - 2], '}');
  for (let i = start + 1; i < end; i += 1) {
    assert.match(lines[i], /^    \{.*\},?$/);
    const obj = JSON.parse(lines[i].trim().replace(/,$/, ''));
    assert.equal(typeof obj, 'object');
    assert.equal(Array.isArray(obj), false);
    assert.equal(Object.hasOwn(obj, 'id'), true);
  }
});

test('13 idempotent second --apply: refuses overwrite, reports skipped-existing', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  ok(run('--repo', repo, '--apply'));
  const file = path.join(dayDir(repo), 'records.json');
  // Mutate a value but keep the file valid JSON so the verify pass still succeeds.
  const changed = text(repo).replace('"title":"title-x"', '"title":"title-x-CHANGED"');
  assert.notEqual(changed, text(repo));
  fs.writeFileSync(file, changed, 'utf8');
  const second = ok(run('--repo', repo, '--apply', '--force'));
  assert.match(second.stdout, /skipped-existing days=2026-11-19/);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  assert.deepEqual(tmpDirs(repo), []);
});

test('14 --force fills only missing day folders', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  ok(run('--repo', repo, '--apply'));
  const first = text(repo);
  const next = '2026-11-20';
  sched(repo, 'a', next, [rec('y', `${next}T09:00:00+08:00`)]);
  const r = ok(run('--repo', repo, '--apply', '--force'));
  assert.match(r.stdout, /skipped-existing days=2026-11-19/);
  assert.equal(text(repo), first);
  // 契约 §10 步骤 2：每个日目录都带三本账本（空文件也必须在）。
  assert.deepEqual(Object.keys(tree(path.join(repo, 'timeline'))).sort(), [
    '2026-11-19/conflicts.jsonl', '2026-11-19/deleted.jsonl',
    '2026-11-19/records.json', '2026-11-19/restore.jsonl',
    '2026-11-20/conflicts.jsonl', '2026-11-20/deleted.jsonl',
    '2026-11-20/records.json', '2026-11-20/restore.jsonl',
    'schema.json'
  ]);
  assert.deepEqual(doc(repo, next).records.map((x) => x.id), ['y']);
});

test('15 refusal: no devices/ -> exit 2 with Chinese message', (t) => {
  const { dir } = fixture(t);
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  const r = run('--repo', empty, '--apply');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /拒绝：未找到 devices\/ 目录/);
  assert.deepEqual(tree(empty), {});
});

test('16 refusal: existing schema.json with schemaVersion 3 -> exit 2', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  writeJson(path.join(repo, 'timeline', 'schema.json'), { schemaVersion: 3 });
  const r = run('--repo', repo, '--apply');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /schemaVersion 不是 2/);
  assert.equal(fs.existsSync(dayDir(repo)), false);
});

test('17 refusal: --dry-run and --apply together -> exit 2', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  const r = run('--repo', repo, '--dry-run', '--apply');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--dry-run 与 --apply 不能同时使用/);
  assert.equal(fs.existsSync(path.join(repo, 'timeline')), false);
});

test('18 verify failure path -> exit 3 (corrupt pre-existing day, forced)', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  writeJson(path.join(repo, 'timeline', 'schema.json'), { schemaVersion: 2 });
  fs.mkdirSync(dayDir(repo), { recursive: true });
  fs.writeFileSync(path.join(dayDir(repo), 'records.json'), '{corrupt', 'utf8');
  // 旧日的三本账本齐全，让校验失败点落在损坏的 records.json 本身。
  for (const name of ['deleted.jsonl', 'restore.jsonl', 'conflicts.jsonl']) {
    fs.writeFileSync(path.join(dayDir(repo), name), '', 'utf8');
  }
  const r = run('--repo', repo, '--apply', '--force');
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /校验失败/);
  assert.match(r.stderr, /records\.json/);
  assert.equal(tmpDirs(repo).length, 1);
  assert.equal(fs.existsSync(path.join(repo, tmpDirs(repo)[0], DAY, 'records.json')), true);
});

test('19 media reference mapping: bare <sha16>.jpg, no path prefix, no media files', (t) => {
  const { repo } = fixture(t);
  const sha = 'abcdef0123456789'.repeat(4);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`, {
    attachments: [{ sha256: sha, name: 'scan.png', pageIndex: 2 }]
  })]);
  ok(run('--repo', repo, '--apply'));
  // 契约 §5 / §3 P2-11：file 是不含路径的裸文件名，任何写入端不得带 media/ 前缀。
  assert.deepEqual(doc(repo).records[0].media, [
    { file: `${sha.slice(0, 16)}.jpg`, sha256: sha, pageIndex: 2 }
  ]);
  assert.equal(doc(repo).records[0].media[0].file.includes('/'), false);
  assert.equal(doc(repo).records[0].media[0].file.includes('\\'), false);
  assert.equal(doc(repo).records[0].media[0].file.includes('..'), false);
  assert.equal(fs.existsSync(path.join(repo, 'timeline', 'media')), false);
  assert.equal(fs.existsSync(path.join(dayDir(repo), 'media')), false);
});

test('20 records.json has no schemaVersion key (explicit negative assertion)', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  ok(run('--repo', repo, '--apply'));
  const raw = text(repo);
  assert.equal(raw.includes('"schemaVersion"'), false);
  const d = doc(repo);
  assert.equal('schemaVersion' in d, false);
  assert.deepEqual(Object.keys(d), ['date', 'open', 'records']);
  // version marker exists only at repo level
  assert.equal(readJson(path.join(repo, 'timeline', 'schema.json')).schemaVersion, 2);
});

test('21 unknown extra record fields preserved (forward compatibility)', (t) => {
  const { repo } = fixture(t);
  const extras = {
    ocr_text: '原文不动',
    ai_structured: '{"kind":"x"}',
    ocr_time: `${DAY}T10:30:00+08:00`,
    pageObjects: [{ pageIndex: 0, boxes: [[1, 2, 3, 4]] }],
    future_field: { nested: [1, 2, 3] }
  };
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`, extras)]);
  ok(run('--repo', repo, '--apply'));
  const r = doc(repo).records[0];
  for (const [key, value] of Object.entries(extras)) assert.deepEqual(r[key], value);
  const keys = Object.keys(r);
  assert.ok(keys.indexOf('future_field') > keys.indexOf('ai_processed'));
  assert.equal(keys[keys.length - 1], 'future_field'); // unknown fields appended at end
  assert.equal('deleted' in r, false);
});

test('22 empty device (no schedules): no day folders, schema.json still written', (t) => {
  const { repo } = fixture(t);
  fs.mkdirSync(path.join(repo, 'devices', 'empty'), { recursive: true });
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /plan days=0 records=0 deletes=0 summaries=0/);
  assert.deepEqual(Object.keys(tree(path.join(repo, 'timeline'))), ['schema.json']);
  assert.equal(fs.existsSync(dayDir(repo)), false);
  assert.equal(readJson(path.join(repo, 'timeline', 'schema.json')).schemaVersion, 2);
});

// ---------------------------------------------------------------- extra guards

test('23 --repo may point directly at devices/', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  ok(run('--repo', path.join(repo, 'devices'), '--apply'));
  assert.deepEqual(doc(repo).records.map((x) => x.id), ['x']);
});

test('24 deletedAt derived from tombstone ts, not wall clock', (t) => {
  const { repo, dir } = fixture(t);
  sched(repo, 'a', DAY, [rec('dead', `${DAY}T12:00:00+08:00`, { deleted: true })]);
  for (const out of ['o1', 'o2']) ok(run('--repo', repo, '--apply', '--out', path.join(dir, out)));
  for (const out of ['o1', 'o2']) {
    const rows = fs.readFileSync(path.join(dir, out, 'timeline', DAY, 'deleted.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].deletedAt, '2026-11-19T04:00:00.000Z');
  }
});

test('25 registry.jsonl, attachments zip and chats/ are ignored', (t) => {
  const { repo, dir } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  writeLines(path.join(repo, 'devices', 'registry.jsonl'), ['{not json']);
  fs.mkdirSync(path.join(repo, 'devices', 'a', 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'devices', 'a', 'attachments', `${DAY}.zip`), 'PK-not-a-zip');
  writeJson(path.join(dir, 'chats', 'session.json'), { junk: true });
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /skipped=0/);
  assert.equal(fs.existsSync(path.join(dayDir(repo), 'records.json')), true);
  assert.equal(fs.existsSync(path.join(repo, 'timeline', 'devices')), false);
});

test('26 --quiet suppresses plan detail but keeps verify line', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  const dry = ok(run('--repo', repo, '--quiet'));
  assert.equal(dry.stdout.trim(), '');
  const applied = ok(run('--repo', repo, '--apply', '--quiet'));
  assert.match(applied.stdout, /verify ok days=1 records=1 deletes=0 summaries=0 skipped=0/);
  assert.doesNotMatch(applied.stdout, /\[migrate\] plan days=/);
});

test('27 open.jsonl folded across devices by id, later session wins', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`, { done: false })]);
  opens(repo, 'a', [{ id: 'x', ts: `${DAY}T09:00:00+08:00`, openedAt: `${DAY}T09:00:00+08:00` }]);
  opens(repo, 'b', [{ id: 'x', ts: `${DAY}T10:00:00+08:00`, openedAt: `${DAY}T10:00:00+08:00`, closedAt: `${DAY}T10:30:00+08:00` }]);
  ok(run('--repo', repo, '--apply'));
  const r = doc(repo).records[0];
  assert.equal(r.opened_at, `${DAY}T10:00:00+08:00`);
  assert.equal(r.closed_at, `${DAY}T10:30:00+08:00`);
});

test('28 records ordered by ts then id', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [
    rec('b', `${DAY}T10:00:00+08:00`),
    rec('a', `${DAY}T10:00:00+08:00`),
    rec('c', `${DAY}T09:00:00+08:00`)
  ]);
  ok(run('--repo', repo, '--apply'));
  assert.deepEqual(doc(repo).records.map((r) => r.id), ['c', 'a', 'b']);
});

test('29 schema.json migratedAt derived from newest input ts', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  sched(repo, 'b', DAY, [rec('y', `${DAY}T10:00:00+08:00`)]);
  ok(run('--repo', repo, '--apply'));
  assert.equal(readJson(path.join(repo, 'timeline', 'schema.json')).migratedAt, '2026-11-19T02:00:00.000Z');
});

test('30 invalid shard day is skipped and counted, not crashed', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', 'notdate', [rec('x', `${DAY}T09:00:00+08:00`)]);
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /skipped=1/);
  assert.match(r.stdout, /verify ok days=0 records=0 deletes=0 summaries=0 skipped=1/);
  assert.deepEqual(Object.keys(tree(path.join(repo, 'timeline'))), ['schema.json']);
});

// ---------------------------------------------------------------- contract regression cases (review fixes)

test('31 identical canonical lines are true duplicates: no conflicts row', (t) => {
  const { repo } = fixture(t);
  const row = rec('same', `${DAY}T09:00:00+08:00`, { title: 'identical' });
  sched(repo, 'a', DAY, [row, { ...row }]);
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /duplicates=1 conflicts=0/);
  assert.equal(doc(repo).records.length, 1);
  assert.deepEqual(ledger(repo, 'conflicts.jsonl'), []);
});

test('32 closed_at non-string is missing (§6 empty==missing): done=true still in open', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`, { done: true })]);
  opens(repo, 'a', [{ id: 'x', ts: `${DAY}T09:00:00+08:00`, openedAt: `${DAY}T09:00:00+08:00`, closedAt: null }]);
  ok(run('--repo', repo, '--apply'));
  assert.equal('closed_at' in doc(repo).records[0], false);
  assert.deepEqual(doc(repo).open, ['x']);
});

test('33 canonical key order: known optional fields in §3 slots, unknown last', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`, {
    ocr_text: 'OCR', ai_structured: '{"k":1}', ocr_time: `${DAY}T09:05:00+08:00`,
    future_field: { z: 1 }
  })]);
  ok(run('--repo', repo, '--apply'));
  const line = text(repo).split('\n').find((l) => l.trim().startsWith('{"id":')).trim().replace(/,$/, '');
  const obj = JSON.parse(line);
  assert.deepEqual(Object.keys(obj), [
    'id', 'ts', 'title', 'body', 'author', 'done', 'media',
    'ocr_text', 'ai_structured', 'ai_processed', 'ocr_time', 'opened_at', 'future_field'
  ]);
  assert.equal(line, canonicalRecordLine(obj));
});

test('34 every day folder has all three ledgers, empty when unused (§10 step 2)', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  ok(run('--repo', repo, '--apply'));
  for (const name of ['deleted.jsonl', 'restore.jsonl', 'conflicts.jsonl']) {
    assert.equal(fs.existsSync(path.join(dayDir(repo), name)), true, name);
    assert.equal(fs.readFileSync(path.join(dayDir(repo), name), 'utf8'), '', name);
  }
});

test('35 writeDayAtomic rolls back on failure: no partial records.json left behind', (t) => {
  const { dir } = fixture(t);
  const target = path.join(dir, 'day');
  assert.throws(() => writeDayAtomic(target, {
    'records.json': '{"partial":true}\n',
    'deleted.jsonl': undefined // 注入非法内容令写入中途抛错
  }));
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('tmp-')), []);
  writeDayAtomic(target, { 'records.json': '{"ok":true}\n' });
  assert.equal(fs.readFileSync(path.join(target, 'records.json'), 'utf8'), '{"ok":true}\n');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('tmp-')), []);
});

test('36 tombstone + later restore version: keep record, write restore.jsonl only (§10 step 5)', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [
    rec('r', `${DAY}T09:00:00+08:00`),
    rec('r', `${DAY}T11:00:00+08:00`, { deleted: true }),
    rec('r', `${DAY}T12:00:00+08:00`, { deleted: false, title: 'back' })
  ]);
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /conflicts=0 restores=1/);
  assert.deepEqual(doc(repo).records.map((x) => x.id), ['r']);
  assert.equal(doc(repo).records[0].title, 'back');
  assert.deepEqual(ledger(repo, 'deleted.jsonl'), []);
  const rows = ledger(repo, 'restore.jsonl');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'r');
  assert.equal(rows[0].ts, `${DAY}T12:00:00+08:00`);
  assert.equal(rows[0].restoredAt, '2026-11-19T04:00:00.000Z');
});

test('37 canonicalRecordLine pure function matches §3 examples byte-for-byte', (t) => {
  const a = '{"id":"m9x2k1-3fk","ts":"2026-11-19T09:30:00+08:00","title":"周会","body":"讨论同步方案","author":"我","done":false,"media":[],"ai_processed":false,"opened_at":"2026-11-19T09:30:00+08:00"}';
  const r1 = {
    id: 'm9x2k1-3fk', ts: '2026-11-19T09:30:00+08:00', title: '周会', body: '讨论同步方案',
    author: '我', done: false, media: [], ai_processed: false, opened_at: '2026-11-19T09:30:00+08:00'
  };
  assert.equal(canonicalRecordLine(r1), a);
  assert.equal(canonicalRecordLine(r1), canonicalRecordLine(r1));
  const shuffled = {};
  for (const k of ['opened_at', 'ai_processed', 'media', 'done', 'author', 'body', 'title', 'ts', 'id']) {
    shuffled[k] = r1[k];
  }
  assert.equal(canonicalRecordLine(shuffled), a); // 交换插入顺序后规范化恢复示例序

  const b = '{"id":"n0y3l2-8ab","ts":"2026-11-19T14:00:00+08:00","title":"体检","body":"","author":"我","done":true,"media":[{"file":"ab12cd34ef567890.jpg","sha256":"ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789","pageIndex":0}],"ocr_text":"体检单","ai_processed":true,"opened_at":"2026-11-19T14:00:00+08:00","closed_at":"2026-11-19T15:20:00+08:00"}';
  const r2 = {
    id: 'n0y3l2-8ab', ts: '2026-11-19T14:00:00+08:00', title: '体检', body: '', author: '我', done: true,
    media: [{ file: 'ab12cd34ef567890.jpg', sha256: 'ab12cd34ef567890abcdef0123456789abcdef0123456789abcdef0123456789', pageIndex: 0 }],
    ocr_text: '体检单', ai_processed: true, opened_at: '2026-11-19T14:00:00+08:00', closed_at: '2026-11-19T15:20:00+08:00'
  };
  assert.equal(canonicalRecordLine(r2), b);
});

test('38 verify covers every day dir under timeline/, not just plan.days (P2-1)', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [rec('x', `${DAY}T09:00:00+08:00`)]);
  ok(run('--repo', repo, '--apply'));
  const orphan = path.join(repo, 'timeline', '2026-11-22');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'records.json'), '{corrupt', 'utf8');
  const r = run('--repo', repo, '--apply', '--force');
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /校验失败/);
  assert.match(r.stderr, /2026-11-22/);
});

test('39 conflicts dedupe by (id,ts,dedupeKey): repeated loser appended once', (t) => {
  const { repo } = fixture(t);
  sched(repo, 'a', DAY, [
    rec('dup', `${DAY}T09:00:00+08:00`, { title: 'first' }),
    rec('dup', `${DAY}T09:00:00+08:00`, { title: 'second' }),
    rec('dup', `${DAY}T09:00:00+08:00`, { title: 'first' })
  ]);
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /conflicts=1/);
  assert.equal(ledger(repo, 'conflicts.jsonl').length, 1);
});

// ---------------------------------------------------------------- scoped verification (re-check P1)

test('40 --force after adding a day when the SKIPPED day holds a conflict: exit 0, no false verify failure', (t) => {
  const { repo } = fixture(t);
  const day1 = '2026-11-19';
  const day2 = '2026-11-20';
  sched(repo, 'a', day1, [
    rec('dup', `${day1}T09:00:00+08:00`, { title: 'first' }),
    rec('dup', `${day1}T09:00:00+08:00`, { title: 'second' })
  ]);
  ok(run('--repo', repo, '--apply'));
  assert.equal(ledger(repo, 'conflicts.jsonl', day1).length, 1);
  const firstText = text(repo, day1);
  const firstConflict = ledger(repo, 'conflicts.jsonl', day1);

  // 只给 v1 新增一个日；旧日含 conflicts，必须在 --force 中被跳过而非参与期望计数。
  sched(repo, 'a', day2, [rec('y', `${day2}T09:00:00+08:00`)]);
  const r = run('--repo', repo, '--apply', '--force');
  ok(r);
  assert.match(r.stdout, /skipped-existing days=2026-11-19/);
  assert.match(r.stdout, /verify ok days=2 records=2 deletes=0 summaries=0 skipped=0 conflicts=1 restores=0/);
  assert.equal(text(repo, day1), firstText, '被跳过日字节不得变化');
  assert.deepEqual(ledger(repo, 'conflicts.jsonl', day1), firstConflict);
  assert.deepEqual(doc(repo, day2).records.map((x) => x.id), ['y'], '新日必须真正写入');
  assert.deepEqual(tmpDirs(repo), [], '成功路径不得遗留 staging');

  // 真正的写入/现存日损坏仍必须 exit 3：把新日 records.json 改成非法 JSON 后重跑。
  fs.writeFileSync(path.join(dayDir(repo, day2), 'records.json'), '{corrupt', 'utf8');
  const bad = run('--repo', repo, '--apply', '--force');
  assert.equal(bad.status, 3, bad.stderr);
  assert.match(bad.stderr, /校验失败/);
  assert.match(bad.stderr, /records\.json/);
  assert.equal(tmpDirs(repo).length, 1, '失败保留现场');
});

test('41 --force after adding a day when the SKIPPED day holds a restore: exit 0, no false verify failure', (t) => {
  const { repo } = fixture(t);
  const day1 = '2026-11-19';
  const day2 = '2026-11-20';
  sched(repo, 'a', day1, [
    rec('r', `${day1}T09:00:00+08:00`),
    rec('r', `${day1}T11:00:00+08:00`, { deleted: true }),
    rec('r', `${day1}T12:00:00+08:00`, { deleted: false, title: 'back' })
  ]);
  ok(run('--repo', repo, '--apply'));
  assert.equal(ledger(repo, 'restore.jsonl', day1).length, 1);
  const firstText = text(repo, day1);
  const firstRestore = ledger(repo, 'restore.jsonl', day1);

  // 只给 v1 新增一个日；旧日含 restores，必须在 --force 中被跳过而非参与期望计数。
  sched(repo, 'a', day2, [rec('z', `${day2}T09:00:00+08:00`)]);
  const r = run('--repo', repo, '--apply', '--force');
  ok(r);
  assert.match(r.stdout, /skipped-existing days=2026-11-19/);
  assert.match(r.stdout, /verify ok days=2 records=2 deletes=0 summaries=0 skipped=0 conflicts=0 restores=1/);
  assert.equal(text(repo, day1), firstText, '被跳过日字节不得变化');
  assert.deepEqual(ledger(repo, 'restore.jsonl', day1), firstRestore);
  assert.deepEqual(doc(repo, day2).records.map((x) => x.id), ['z'], '新日必须真正写入');
  assert.deepEqual(tmpDirs(repo), [], '成功路径不得遗留 staging');
});
