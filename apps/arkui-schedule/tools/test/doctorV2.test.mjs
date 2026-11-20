// mod-v2-doctor：`tools/doctor-v2.mjs` 的离线端到端测试。
// 直接 execFileSync 调用 CLI（不依赖任何构建产物），构建 v1-only / v2-only / mixed / corrupt 四套
// 临时仓库，断言退出码、汇总行、typed code；**每次运行前后对整棵仓库做逐字节快照并断言相等**，
// 作为工具「只读、零修复、零临时文件」的硬证据。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../../../../tools/doctor-v2.mjs');
const DAY = '2026-11-19';
const DAY2 = '2026-11-20';
const SUMMARY_BODY_RE = /\[doctor\] days=(\d+) records=(\d+) deletes=(\d+) restores=(\d+) media=(\d+) problems=(\d+) warnings=(\d+)/;
const SUMMARY_RE = new RegExp(`^${SUMMARY_BODY_RE.source}$`, 'm');

// ---------------------------------------------------------------- helpers

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2doctor-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, repo };
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function writeLines(file, rows) {
  const list = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  writeText(file, list.length ? `${list.join('\n')}\n` : '');
}

function writeJson(file, obj) {
  writeText(file, JSON.stringify(obj));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rec(id, ts, overrides = {}) {
  return {
    id, ts, title: `title-${id}`, body: '', author: '我', done: false, media: [],
    ai_processed: false, opened_at: ts, ...overrides
  };
}

/** 契约 §3 形状：date / open / records，每条记录独占一行，末尾一个换行。 */
function recordsText(date, records, open) {
  const lines = ['{', `  "date": ${JSON.stringify(date)},`];
  if (!open.length) {
    lines.push('  "open": [],');
  } else {
    lines.push('  "open": [');
    open.forEach((id, i) => lines.push(`    ${JSON.stringify(id)}${i < open.length - 1 ? ',' : ''}`));
    lines.push('  ],');
  }
  if (!records.length) {
    lines.push('  "records": []');
  } else {
    lines.push('  "records": [');
    records.forEach((r, i) => lines.push(`    ${JSON.stringify(r)}${i < records.length - 1 ? ',' : ''}`));
    lines.push('  ]');
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** 建一棵合法（或按需破坏）的 v2 日目录；open 省略时按 closed_at 谓词派生。 */
function seedV2(repo, date, opts = {}) {
  const {
    records = [], open, deletes = [], restores = [], conflicts = [], mediaFiles = {},
    schemaVersion = 2, includeSchema = true, fileDate = date, ledgerFiles = true, conflictsFile = true,
    mediaDir = true
  } = opts;
  const timeline = path.join(repo, 'timeline');
  if (includeSchema) writeJson(path.join(timeline, 'schema.json'), { schemaVersion });
  const dayDir = path.join(timeline, date);
  const derivedOpen = open !== undefined ? open : records.filter((r) => !r.closed_at).map((r) => r.id);
  writeText(path.join(dayDir, 'records.json'), recordsText(fileDate, records, derivedOpen));
  if (ledgerFiles) {
    writeLines(path.join(dayDir, 'deleted.jsonl'), deletes);
    writeLines(path.join(dayDir, 'restore.jsonl'), restores);
  }
  if (conflictsFile) writeLines(path.join(dayDir, 'conflicts.jsonl'), conflicts);
  if (mediaDir) fs.mkdirSync(path.join(dayDir, 'media'), { recursive: true });
  for (const [name, content] of Object.entries(mediaFiles)) writeText(path.join(dayDir, 'media', name), content);
  return dayDir;
}

/** 建 v1 设备树：schedules/<date>.jsonl 与可选的 open.jsonl。 */
function seedV1(repo, devices) {
  for (const [device, spec] of Object.entries(devices)) {
    for (const [date, rows] of Object.entries(spec.schedules || {})) {
      writeLines(path.join(repo, 'devices', device, 'schedules', `${date}.jsonl`), rows);
    }
    if (spec.open) writeLines(path.join(repo, 'devices', device, 'open.jsonl'), spec.open);
  }
}

/** 整棵仓库的逐字节快照：目录标记 + 每个文件的 SHA256（覆盖内容、增删、改名、空目录）。 */
function snapshot(root) {
  const out = {};
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[`${key}/`] = '(dir)';
        walk(child, key);
      } else if (entry.isFile()) {
        out[key] = createHash('sha256').update(fs.readFileSync(child)).digest('hex');
      } else {
        out[key] = '(other)';
      }
    }
  };
  walk(root);
  return out;
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

/** 每次调用都做只读证明：运行前后整棵仓库逐字节相等。 */
function runReadOnly(t, repo, ...args) {
  const before = snapshot(repo);
  const result = run('--repo', repo, ...args);
  assert.deepEqual(snapshot(repo), before, 'doctor 必须只读：repo tree 在运行前后逐字节相同');
  return result;
}

function healthy(result) {
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  return result;
}

function unhealthy(result) {
  assert.equal(result.status, 2, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  return result;
}

function summary(result) {
  const match = SUMMARY_RE.exec(result.stdout);
  assert.ok(match, `缺少汇总行：\n${result.stdout}`);
  return {
    days: Number(match[1]), records: Number(match[2]), deletes: Number(match[3]),
    restores: Number(match[4]), media: Number(match[5]), problems: Number(match[6]), warnings: Number(match[7])
  };
}

function asJson(result, expectedStatus = 0) {
  assert.equal(result.status, expectedStatus, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.summary, SUMMARY_BODY_RE, 'JSON 输出必须带汇总行');
  const fields = SUMMARY_BODY_RE.exec(payload.summary);
  assert.equal(payload.problems, Number(fields[6]));
  assert.equal(payload.warnings, Number(fields[7]));
  return payload;
}

function hasCode(result, code) {
  assert.match(result.stdout, new RegExp(`\\b${code}\\b`), `未出现 ${code}：\n${result.stdout}`);
}

// 四套固定夹具 ----------------------------------------------------------------

function v1Only(t) {
  const { repo } = fixture(t);
  seedV1(repo, {
    'phone-a': {
      schedules: { [DAY]: [rec('a', `${DAY}T09:00:00+08:00`), rec('b', `${DAY}T10:00:00+08:00`)] },
      open: [{ id: 'a', ts: `${DAY}T09:00:00+08:00`, openedAt: `${DAY}T09:00:00+08:00` }]
    }
  });
  return repo;
}

function sha16Of(hex16) {
  return `${hex16}.jpg`;
}

function v2Only(t) {
  const { repo } = fixture(t);
  const sha = 'ab12'.repeat(16);
  const file = sha16Of('ab12'.repeat(4));
  seedV2(repo, DAY, {
    records: [
      rec('a', `${DAY}T09:00:00+08:00`),
      rec('b', `${DAY}T14:00:00+08:00`, {
        done: true, closed_at: `${DAY}T15:20:00+08:00`,
        media: [{ file, sha256: sha, pageIndex: 0 }]
      })
    ],
    mediaFiles: { [file]: 'jpeg-bytes' }
  });
  return repo;
}

function mixed(t) {
  const { repo } = fixture(t);
  seedV1(repo, { 'phone-a': { schedules: { [DAY]: [rec('v1a', `${DAY}T08:00:00+08:00`)] } } });
  seedV2(repo, DAY, { records: [rec('v2a', `${DAY}T09:00:00+08:00`)] });
  return repo;
}

function corrupt(t) {
  const { repo } = fixture(t);
  const missingSha = `${'1'.repeat(16)}${'0'.repeat(48)}`;
  const badNameSha = 'c'.repeat(64);
  const collisionA = `${'a'.repeat(16)}${'0'.repeat(48)}`;
  const collisionB = `${'a'.repeat(16)}${'1'.repeat(48)}`;
  const collisionFile = 'aaaaaaaaaaaaaaaa.jpg';
  seedV2(repo, DAY, {
    schemaVersion: 99,
    fileDate: '1999-01-01',
    records: [
      rec('m', `${DAY}T09:00:00+08:00`, { closed_at: `${DAY}T09:30:00+08:00`, media: [{ file: '1111111111111111.jpg', sha256: missingSha, pageIndex: 0 }] }),
      rec('n', `${DAY}T10:00:00+08:00`, { closed_at: `${DAY}T10:30:00+08:00`, media: [{ file: 'media/bad.jpg', sha256: badNameSha, pageIndex: 0 }] }),
      rec('p', `${DAY}T11:00:00+08:00`, { closed_at: `${DAY}T11:30:00+08:00`, media: [{ file: collisionFile, sha256: collisionA, pageIndex: 0 }] }),
      rec('q', `${DAY}T12:00:00+08:00`, { closed_at: `${DAY}T12:30:00+08:00`, media: [{ file: collisionFile, sha256: collisionB, pageIndex: 1 }] })
    ],
    deletes: [{ id: 'ghost', ts: `${DAY}T16:00:00+08:00`, deletedAt: `${DAY}T16:00:00+08:00` }],
    mediaFiles: { [collisionFile]: 'jpeg-bytes' }
  });
  return repo;
}

// ---------------------------------------------------------------- fixture 1: v1-only

test('01 v1-only fixture: healthy exit 0, correct summary, byte-identical repo', (t) => {
  const repo = v1Only(t);
  const r = healthy(runReadOnly(t, repo));
  assert.deepEqual(summary(r), { days: 0, records: 0, deletes: 0, restores: 0, media: 0, problems: 0, warnings: 0 });
  assert.match(r.stdout, /layout v1/);
});

test('02 v1-only counts: device / day / record / open entry exposed in JSON', (t) => {
  const repo = v1Only(t);
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.layout, 'v1');
  assert.equal(payload.v1.devices, 1);
  assert.equal(payload.v1.days, 1);
  assert.equal(payload.v1.records, 2);
  assert.equal(payload.v1.openEntries, 1);
  assert.equal(payload.v1.perDevice[0].device, 'phone-a');
});

test('03 v1-only cross-device id duplication is informational only', (t) => {
  const { repo } = fixture(t);
  seedV1(repo, {
    a: { schedules: { [DAY]: [rec('same', `${DAY}T09:00:00+08:00`)] } },
    b: { schedules: { [DAY]: [rec('same', `${DAY}T10:00:00+08:00`)] } }
  });
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'I_V1_CROSS_DEVICE_ID');
  assert.equal(summary(r).problems, 0);
});

test('04 v1-only malformed schedule JSONL -> E_V1_JSONL_PARSE, exit 2', (t) => {
  const { repo } = fixture(t);
  seedV1(repo, { a: { schedules: { [DAY]: [rec('ok', `${DAY}T09:00:00+08:00`)] } } });
  writeText(path.join(repo, 'devices', 'a', 'schedules', `${DAY}.jsonl`),
    `${JSON.stringify(rec('ok', `${DAY}T09:00:00+08:00`))}\nnot-json\n`);
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_V1_JSONL_PARSE');
  assert.equal(summary(r).problems, 1);
});

// ---------------------------------------------------------------- fixture 2: v2-only

test('05 v2-only fixture: healthy exit 0, correct summary, byte-identical repo', (t) => {
  const repo = v2Only(t);
  const r = healthy(runReadOnly(t, repo));
  assert.deepEqual(summary(r), { days: 1, records: 2, deletes: 0, restores: 0, media: 1, problems: 0, warnings: 0 });
  assert.match(r.stdout, /layout v2/);
});

test('06 v2-only --json: machine-readable object with counts and findings', (t) => {
  const repo = v2Only(t);
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.layout, 'v2');
  assert.equal(payload.schema.version, 2);
  assert.equal(payload.days, 1);
  assert.equal(payload.records, 2);
  assert.equal(payload.media, 1);
  assert.equal(payload.problems, 0);
  assert.ok(Array.isArray(payload.findings));
  assert.match(payload.summary, /^\[doctor\] days=1 records=2 /);
});

test('07 --quiet keeps the summary line but drops section headers', (t) => {
  const repo = v2Only(t);
  const r = healthy(runReadOnly(t, repo, '--quiet'));
  assert.match(r.stdout, /^\[doctor\] days=1 records=2 deletes=0 restores=0 media=1 problems=0 warnings=0$/m);
  assert.doesNotMatch(r.stdout, /--- timeline\/v2 ---/);
});

test('08 same id with different later ts: resolvable, informational, exit 0', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, {
    records: [
      rec('dup', `${DAY}T09:00:00+08:00`, { body: 'old', closed_at: `${DAY}T09:30:00+08:00` }),
      rec('dup', `${DAY}T10:00:00+08:00`, { body: 'new', closed_at: `${DAY}T10:30:00+08:00` })
    ]
  });
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'I_DUPLICATE_IDS');
  assert.equal(summary(r).problems, 0);
});

test('09 same id and same ts: UTF-8 byte tie-break resolvable, exit 0', (t) => {
  const { repo } = fixture(t);
  const ts = `${DAY}T09:00:00+08:00`;
  seedV2(repo, DAY, {
    records: [
      rec('dup', ts, { title: 'a', closed_at: `${DAY}T09:30:00+08:00` }),
      rec('dup', ts, { title: 'z', closed_at: `${DAY}T09:30:00+08:00` })
    ]
  });
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.duplicateGroups, 1);
  assert.equal(payload.duplicateLines, 1);
  assert.equal(payload.problems, 0);
  assert.ok(payload.findings.some((f) => f.code === 'I_DUPLICATE_IDS'));
});

test('10 stale top-level open vs derived closed_at -> E_OPEN_DRIFT info, exit 0', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`)], // 无 closed_at ⇒ 派生 open=['a']
    open: [] // 文件缓存为空 ⇒ 漂移，但只是 informational
  });
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'E_OPEN_DRIFT');
  assert.equal(summary(r).problems, 0);
  assert.equal(summary(r).warnings, 0);
});

test('11 unreferenced media file -> W_MEDIA_UNREFERENCED warning, exit 0', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`, { closed_at: `${DAY}T09:30:00+08:00` })],
    mediaFiles: { 'aaaaaaaaaaaaaaaa.jpg': 'orphan-jpeg' }
  });
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'W_MEDIA_UNREFERENCED');
  assert.deepEqual(summary(r), { days: 1, records: 1, deletes: 0, restores: 0, media: 1, problems: 0, warnings: 1 });
});

test('12 restore.ts > delete.ts counted as restoreWins, exit 0', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`, { closed_at: `${DAY}T09:30:00+08:00` })],
    deletes: [{ id: 'a', ts: `${DAY}T10:00:00+08:00`, deletedAt: `${DAY}T10:00:00+08:00` }],
    restores: [{ id: 'a', ts: `${DAY}T11:00:00+08:00`, restoredAt: `${DAY}T11:00:00+08:00` }]
  });
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.restoreWins, 1);
  assert.equal(payload.restoreIgnored, 0);
  assert.equal(payload.problems, 0);
});

test('13 restore.ts <= delete.ts is legal (delete wins), counted not an error', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`, { closed_at: `${DAY}T09:30:00+08:00` })],
    deletes: [{ id: 'a', ts: `${DAY}T11:00:00+08:00`, deletedAt: `${DAY}T11:00:00+08:00` }],
    restores: [{ id: 'a', ts: `${DAY}T10:00:00+08:00`, restoredAt: `${DAY}T10:00:00+08:00` }]
  });
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.restoreWins, 0);
  assert.equal(payload.restoreIgnored, 1);
  assert.equal(payload.problems, 0);
});

// ---------------------------------------------------------------- fixture 3: mixed

test('14 mixed fixture: v1 + v2 coexistence is informational, exit 0', (t) => {
  const repo = mixed(t);
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'I_LAYOUT_MIXED');
  assert.match(r.stdout, /layout mixed/);
  assert.deepEqual(summary(r), { days: 1, records: 1, deletes: 0, restores: 0, media: 0, problems: 0, warnings: 0 });
});

test('15 mixed fixture JSON reports both sides', (t) => {
  const repo = mixed(t);
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.layout, 'mixed');
  assert.equal(payload.v1.records, 1);
  assert.equal(payload.records, 1);
  assert.ok(payload.findings.some((f) => f.code === 'I_LAYOUT_MIXED' && f.severity === 'info'));
});

// ---------------------------------------------------------------- schema / layout errors

test('16 timeline present but schema.json missing -> E_SCHEMA_MISSING, exit 2', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, { includeSchema: false, records: [rec('a', `${DAY}T09:00:00+08:00`)] });
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_SCHEMA_MISSING');
  assert.equal(summary(r).problems, 1);
});

test('17 unparsable schema.json -> E_SCHEMA_MISSING, exit 2', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, { records: [rec('a', `${DAY}T09:00:00+08:00`)] });
  writeText(path.join(repo, 'timeline', 'schema.json'), '{not json');
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_SCHEMA_MISSING');
});

test('18 schemaVersion 99 -> E_SCHEMA_UNKNOWN, exit 2', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, { schemaVersion: 99, records: [rec('a', `${DAY}T09:00:00+08:00`)] });
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_SCHEMA_UNKNOWN');
  assert.equal(asJson(runReadOnly(t, repo, '--json'), 2).schema.version, 99);
});

test('19 neither devices/ nor timeline/ -> E_NO_DATA, exit 2', (t) => {
  const { repo } = fixture(t);
  writeText(path.join(repo, 'README.md'), 'empty repo');
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_NO_DATA');
  assert.match(r.stdout, /layout none/);
  assert.equal(summary(r).problems, 1);
});

// ---------------------------------------------------------------- per-day checks

test('20 date field != directory name -> E_DAY_DATE_MISMATCH, exit 2', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, { fileDate: '2020-01-01', records: [rec('a', `${DAY}T09:00:00+08:00`)] });
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_DAY_DATE_MISMATCH');
  assert.equal(summary(r).problems, 1);
});

test('21 malformed records line counted as E_RECORDS_MALFORMED, exit 2', (t) => {
  const { repo } = fixture(t);
  const dayDir = seedV2(repo, DAY, { records: [rec('a', `${DAY}T09:00:00+08:00`)] });
  const file = path.join(dayDir, 'records.json');
  const text = fs.readFileSync(file, 'utf8');
  writeText(file, text.replace('  "records": [', '  "records": [\n    {bad json},'));
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_RECORDS_MALFORMED');
  const payload = asJson(runReadOnly(t, repo, '--json'), 2);
  assert.equal(payload.malformedLines, 1);
});

test('22 missing records.json -> E_RECORDS_MISSING, exit 2', (t) => {
  const { repo } = fixture(t);
  const dayDir = seedV2(repo, DAY, { records: [rec('a', `${DAY}T09:00:00+08:00`)] });
  fs.unlinkSync(path.join(dayDir, 'records.json'));
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_RECORDS_MISSING');
});

test('23 invalid day directory name skipped and counted as W_DAY_DIR_NAME', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, { records: [rec('a', `${DAY}T09:00:00+08:00`)] });
  fs.mkdirSync(path.join(repo, 'timeline', '2026-13-99'), { recursive: true });
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'W_DAY_DIR_NAME');
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.skippedDays, 1);
  assert.equal(payload.days, 1);
  assert.equal(summary(r).warnings, 1);
});

// ---------------------------------------------------------------- ledgers / conflicts

test('24 never-existed ghost with a delete ledger entry -> I_LEDGER_RETAINED info, exit 0', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`)],
    deletes: [{ id: 'ghost', ts: `${DAY}T16:00:00+08:00`, deletedAt: `${DAY}T16:00:00+08:00` }]
  });
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'I_LEDGER_RETAINED');
  assert.doesNotMatch(r.stdout, /E_LEDGER_ORPHAN/);
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.ledgerRetained, 1);
  assert.equal(payload.ledgerOrphans, 0);
  assert.equal(payload.problems, 0);
  assert.equal(payload.warnings, 0);
  assert.ok(payload.findings.some((f) => f.code === 'I_LEDGER_RETAINED' && f.severity === 'info'));
});

test('25 malformed ledger line -> E_LEDGER_PARSE, exit 2', (t) => {
  const { repo } = fixture(t);
  const dayDir = seedV2(repo, DAY, { records: [rec('a', `${DAY}T09:00:00+08:00`)] });
  writeText(path.join(dayDir, 'deleted.jsonl'), 'not-json\n');
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_LEDGER_PARSE');
});

test('26 conflicts.jsonl bad dedupeKey shape -> E_CONFLICTS_DEDUPE_KEY, exit 2', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`)],
    conflicts: [{ id: 'a', ts: `${DAY}T09:00:00+08:00`, losingLine: '{}', decidedAt: `${DAY}T10:00:00+08:00`, dedupeKey: 'short' }]
  });
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_CONFLICTS_DEDUPE_KEY');
});

test('27 conflicts.jsonl well-formed is silent', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`)],
    conflicts: [{ id: 'a', ts: `${DAY}T09:00:00+08:00`, losingLine: '{"id":"a"}', decidedAt: `${DAY}T10:00:00+08:00`, dedupeKey: 'd'.repeat(64) }]
  });
  const r = healthy(runReadOnly(t, repo));
  assert.equal(summary(r).problems, 0);
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.conflicts, 1);
  assert.equal(payload.perDay[0].conflicts, 1, 'perDay[].conflicts 必须等于当日 conflicts.jsonl 行数');
});

// ---------------------------------------------------------------- media checks

test('28 referenced media missing in a populated media/ dir -> E_MEDIA_MISSING, exit 2', (t) => {
  const { repo } = fixture(t);
  const sha = `1${'0'.repeat(63)}`;
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`, { media: [{ file: '1000000000000000.jpg', sha256: sha, pageIndex: 0 }] })],
    // media/ 已有文件（迁移已运行）⇒ 引用缺失是真缺文件，不是合法的迁移窗口空目录
    mediaFiles: { 'aaaaaaaaaaaaaaaa.jpg': 'jpeg-bytes' }
  });
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_MEDIA_MISSING');
  assert.equal(asJson(runReadOnly(t, repo, '--json'), 2).mediaMissing, 1);
});

test('29 media[].file with path prefix -> E_MEDIA_NAME, exit 2', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`, { media: [{ file: 'media/x.jpg', sha256: 'c'.repeat(64), pageIndex: 0 }] })]
  });
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_MEDIA_NAME');
});

test('30 sha16 collision (two shas sharing prefix) -> E_MEDIA_COLLISION, exit 2', (t) => {
  const { repo } = fixture(t);
  const file = 'aaaaaaaaaaaaaaaa.jpg';
  const shaA = `${'a'.repeat(16)}${'0'.repeat(48)}`;
  const shaB = `${'a'.repeat(16)}${'1'.repeat(48)}`;
  seedV2(repo, DAY, {
    records: [
      rec('a', `${DAY}T09:00:00+08:00`, { media: [{ file, sha256: shaA, pageIndex: 0 }] }),
      rec('b', `${DAY}T10:00:00+08:00`, { media: [{ file, sha256: shaB, pageIndex: 0 }] })
    ],
    mediaFiles: { [file]: 'jpeg' }
  });
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_MEDIA_COLLISION');
  assert.equal(asJson(runReadOnly(t, repo, '--json'), 2).mediaCollisions, 1);
});

// ---------------------------------------------------------------- corrupt fixture & CLI

test('31 corrupt fixture: all six typed problems reported in one run, exit 2, read-only', (t) => {
  const repo = corrupt(t);
  const r = unhealthy(runReadOnly(t, repo));
  for (const code of [
    'E_SCHEMA_UNKNOWN', 'E_DAY_DATE_MISMATCH',
    'E_MEDIA_MISSING', 'E_MEDIA_NAME', 'E_MEDIA_COLLISION'
  ]) hasCode(r, code);
  hasCode(r, 'I_LEDGER_RETAINED'); // P1-1: 账本有 id、records 无 id 现为 info，不再是 error
  assert.equal(summary(r).problems, 5);
  assert.equal(summary(r).days, 1);
  assert.equal(summary(r).records, 4);
  assert.equal(summary(r).deletes, 1);
});

test('32 corrupt fixture --json: codes present in machine-readable findings', (t) => {
  const repo = corrupt(t);
  const payload = asJson(runReadOnly(t, repo, '--json'), 2);
  const codes = new Set(payload.findings.filter((f) => f.severity === 'error').map((f) => f.code));
  for (const code of [
    'E_SCHEMA_UNKNOWN', 'E_DAY_DATE_MISMATCH',
    'E_MEDIA_MISSING', 'E_MEDIA_NAME', 'E_MEDIA_COLLISION'
  ]) assert.ok(codes.has(code), `findings missing ${code}`);
  assert.ok(payload.findings.some((f) => f.code === 'I_LEDGER_RETAINED' && f.severity === 'info'));
  assert.equal(payload.problems, 5);
});

test('33 deterministic: two runs on the same repo produce byte-identical stdout', (t) => {
  const repo = corrupt(t);
  const a = unhealthy(runReadOnly(t, repo, '--json'));
  const b = unhealthy(runReadOnly(t, repo, '--json'));
  assert.equal(b.stdout, a.stdout);
});

test('34 CLI: missing --repo and unknown flag refused with exit 2; --help exit 0', (t) => {
  const { repo } = fixture(t);
  const missing = run();
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /拒绝：缺少 --repo/);
  const before = snapshot(repo);
  const unknown = run('--repo', repo, '--fix');
  assert.deepEqual(snapshot(repo), before, '参数拒绝路径同样不得改动仓库');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /无法识别的参数/);
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法: node tools\/doctor-v2\.mjs/);
});

test('35 multiple days counted independently and ledgers aggregated', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, { records: [rec('a', `${DAY}T09:00:00+08:00`)], deletes: [{ id: 'a', ts: `${DAY}T16:00:00+08:00`, deletedAt: `${DAY}T16:00:00+08:00` }] });
  seedV2(repo, DAY2, { records: [rec('b', `${DAY2}T09:00:00+08:00`)], restores: [{ id: 'b', ts: `${DAY2}T16:00:00+08:00`, restoredAt: `${DAY2}T16:00:00+08:00` }] });
  const r = healthy(runReadOnly(t, repo));
  assert.deepEqual(summary(r), { days: 2, records: 2, deletes: 1, restores: 1, media: 0, problems: 0, warnings: 0 });
});

// ---------------------------------------------------------------- P1-1 回归：已删清行账本 / 孤儿账本

test('36 purged row + retained delete ledger -> I_LEDGER_RETAINED info only, exit 0', (t) => {
  const { repo } = fixture(t);
  const ts = `${DAY}T11:00:00+08:00`;
  seedV2(repo, DAY, {
    records: [rec('live', `${DAY}T09:00:00+08:00`)], // purged 的版本行已物理清除
    deletes: [{ id: 'purged', ts, deletedAt: ts, intentId: 'delete-intent-1' }]
  });
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'I_LEDGER_RETAINED');
  assert.doesNotMatch(r.stdout, /W_LEDGER_ORPHAN/);
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.problems, 0);
  assert.equal(payload.warnings, 0);
  assert.equal(payload.ledgerRetained, 1);
  assert.equal(payload.ledgerOrphans, 0);
  assert.ok(payload.findings.some((f) => f.code === 'I_LEDGER_RETAINED' && f.severity === 'info'));
});

test('37 restore-then-purge sequence -> retained info, exit 0', (t) => {
  const { repo } = fixture(t);
  const t1 = `${DAY}T10:00:00+08:00`;
  const t2 = `${DAY}T11:00:00+08:00`;
  const t3 = `${DAY}T12:00:00+08:00`;
  seedV2(repo, DAY, {
    records: [], // 最终已物理清行
    deletes: [
      { id: 'seq', ts: t1, deletedAt: t1, intentId: 'del-1' },
      { id: 'seq', ts: t3, deletedAt: t3, intentId: 'del-2' }
    ],
    restores: [{ id: 'seq', ts: t2, restoredAt: t2 }]
  });
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'I_LEDGER_RETAINED');
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.problems, 0);
  assert.equal(payload.restoreIgnored, 1); // D(t3) > R(t2)：删除胜
  assert.equal(payload.ledgerRetained, 1);
  assert.ok(payload.findings.some((f) => f.code === 'I_LEDGER_RETAINED' && f.severity === 'info'));
});

test('38 ledger id never referenced anywhere (restore only) -> W_LEDGER_ORPHAN warning, exit 0', (t) => {
  const { repo } = fixture(t);
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`)],
    restores: [{ id: 'bogus', ts: `${DAY}T16:00:00+08:00`, restoredAt: `${DAY}T16:00:00+08:00` }]
  });
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'W_LEDGER_ORPHAN');
  assert.doesNotMatch(r.stdout, /E_LEDGER_ORPHAN/);
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.problems, 0);
  assert.equal(payload.warnings, 1);
  assert.equal(payload.ledgerOrphans, 1);
  assert.ok(payload.findings.some((f) => f.code === 'W_LEDGER_ORPHAN' && f.severity === 'warning'));
});

// ---------------------------------------------------------------- P2-2 回归：媒体迁移窗口

test('39 media references with no media/ directory -> W_MEDIA_NOT_MIGRATED warning, exit 0', (t) => {
  const { repo } = fixture(t);
  const sha = 'ab12'.repeat(16);
  seedV2(repo, DAY, {
    mediaDir: false, // 媒体迁移模块尚未运行：同日 media/ 目录不存在
    records: [rec('a', `${DAY}T09:00:00+08:00`, {
      closed_at: `${DAY}T09:30:00+08:00`,
      media: [{ file: 'ab12ab12ab12ab12.jpg', sha256: sha, pageIndex: 0 }]
    })]
  });
  assert.equal(fs.existsSync(path.join(repo, 'timeline', DAY, 'media')), false);
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'W_MEDIA_NOT_MIGRATED');
  assert.doesNotMatch(r.stdout, /E_MEDIA_MISSING/);
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.problems, 0);
  assert.equal(payload.warnings, 1);
  assert.equal(payload.mediaMissing, 1);
  assert.ok(payload.findings.some((f) => f.code === 'W_MEDIA_NOT_MIGRATED' && f.severity === 'warning'));
});

test('40 empty media/ dir + all referenced media missing -> W_MEDIA_NOT_MIGRATED warning, exit 0', (t) => {
  const { repo } = fixture(t);
  const sha = 'ab12'.repeat(16);
  const dayDir = seedV2(repo, DAY, {
    // 默认 mediaDir:true 且不放任何文件 ⇒ media/ 存在但为空（契约 §5 迁移窗口）
    records: [rec('a', `${DAY}T09:00:00+08:00`, {
      closed_at: `${DAY}T09:30:00+08:00`,
      media: [{ file: 'ab12ab12ab12ab12.jpg', sha256: sha, pageIndex: 0 }]
    })]
  });
  assert.equal(fs.existsSync(path.join(dayDir, 'media')), true);
  assert.deepEqual(fs.readdirSync(path.join(dayDir, 'media')), []);
  const r = healthy(runReadOnly(t, repo));
  hasCode(r, 'W_MEDIA_NOT_MIGRATED');
  assert.doesNotMatch(r.stdout, /E_MEDIA_MISSING/);
  const payload = asJson(healthy(runReadOnly(t, repo, '--json')));
  assert.equal(payload.problems, 0);
  assert.equal(payload.warnings, 1);
  assert.equal(payload.mediaMissing, 1);
  assert.ok(payload.findings.some((f) => f.code === 'W_MEDIA_NOT_MIGRATED' && f.severity === 'warning'));
});

test('41 partially migrated media/ (one referenced present, one missing) -> E_MEDIA_MISSING, exit 2', (t) => {
  const { repo } = fixture(t);
  const presentSha = 'ab12'.repeat(16);
  const presentFile = 'ab12ab12ab12ab12.jpg';
  const missingSha = `1${'0'.repeat(63)}`;
  const missingFile = '1000000000000000.jpg';
  seedV2(repo, DAY, {
    records: [rec('a', `${DAY}T09:00:00+08:00`, {
      closed_at: `${DAY}T09:30:00+08:00`,
      media: [
        { file: presentFile, sha256: presentSha, pageIndex: 0 },
        { file: missingFile, sha256: missingSha, pageIndex: 1 }
      ]
    })],
    mediaFiles: { [presentFile]: 'jpeg-bytes' }
  });
  const r = unhealthy(runReadOnly(t, repo));
  hasCode(r, 'E_MEDIA_MISSING');
  assert.doesNotMatch(r.stdout, /W_MEDIA_NOT_MIGRATED/);
  const payload = asJson(runReadOnly(t, repo, '--json'), 2);
  assert.equal(payload.mediaMissing, 1);
  assert.equal(payload.problems, 1);
  assert.ok(payload.findings.some((f) => f.code === 'E_MEDIA_MISSING' && f.severity === 'error'));
});
