// mod-v2-media-migration：v1 按天 zip -> timeline/<date>/media/<sha16>.jpg 的离线端到端测试。
// 直接 execFileSync 调用 CLI；fixture zip 由本文件用 node:zlib 手写（local header + central directory + EOCD），
// 不依赖 jszip / yauzl / tar / Expand-Archive 等任何外部依赖。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, '../../../../tools/migrate-media-v1-to-v2.mjs');
const DAY = '2026-11-19';
const NEXT = '2026-11-20';

// ---------------------------------------------------------------- CRC-32（测试侧独立实现，交叉验证工具）

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------- 自制 ZIP fixture

// entries: [{name, data:Buffer, method?:0|8, encrypted?:bool, badCrc?:bool}]
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method === undefined ? 0 : entry.method;
    const packed = method === 8 ? zlib.deflateRawSync(entry.data) : Buffer.from(entry.data);
    const crc = entry.badCrc ? (crc32(entry.data) ^ 0x1) >>> 0 : crc32(entry.data);
    const flags = entry.encrypted ? 1 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(entry.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cen, name]));

    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// 在 EOCD 前插入 ZIP64 定位器签名，触发工具的「ZIP64 类型化拒绝」分支。
function withZip64Locator(zipBuf) {
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= 0; i -= 1) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'fixture 应含 EOCD');
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  return Buffer.concat([zipBuf.subarray(0, eocd), locator, zipBuf.subarray(eocd)]);
}

// ---------------------------------------------------------------- fixture helpers

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2media-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'devices'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, repo };
}

function setupSchema(root) {
  const dir = path.join(root, 'timeline');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({ schemaVersion: 2 }));
}

function sched(repo, device, day, rows) {
  const file = path.join(repo, 'devices', device, 'schedules', `${day}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n', 'utf8');
}

function writeZip(repo, device, archive, entries) {
  const file = path.join(repo, 'devices', device, 'attachments', archive);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makeZip(entries));
  return file;
}

function rec(id, ts, overrides = {}) {
  return {
    id, ts, title: `title-${id}`, body: '', author: '我',
    done: false, ai_processed: false, ...overrides
  };
}

function att(sha, entryName, archive = `${DAY}.zip`, pageIndex = 0) {
  return { sha256: sha, name: entryName, pageIndex, archive, entry: entryName };
}

function dataFor(tag) {
  return Buffer.from(`JPEG-BYTES-${tag}`, 'utf8');
}

function mediaPath(repo, date, sha) {
  return path.join(repo, 'timeline', date, 'media', `${sha.slice(0, 16)}.jpg`);
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

function tmpDirs(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith('timeline.tmp-'));
}

function dayLine(stdout, date) {
  const line = stdout.split('\n').find((l) => l.startsWith(`[media] day ${date} `));
  assert.ok(line, `缺少 day ${date} 计划行：${stdout}`);
  return line;
}

function planLine(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('[media] plan '));
  assert.ok(line, `缺少 plan 行：${stdout}`);
  return line;
}

// ---------------------------------------------------------------- 34 strict cases

test('01 stored entry extracts byte-identically (output sha256 equals record sha256)', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('stored');
  const sha = sha256Hex(data);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'page-0-11111111.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'page-0-11111111.jpg', data, method: 0 }]);
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /verify ok days=1 merged=1/);
  const file = mediaPath(repo, DAY, sha);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(fs.readFileSync(file), data);
  assert.equal(sha256Hex(fs.readFileSync(file)), sha);
});

test('02 deflate entry extracts byte-identically (method 8 via inflateRawSync)', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = Buffer.from('LONG-JPEG-DATA-'.repeat(40));
  const sha = sha256Hex(data);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'page-1-deadbeef.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'page-1-deadbeef.jpg', data, method: 8 }]);
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /verify ok days=1 merged=1/);
  assert.deepEqual(fs.readFileSync(mediaPath(repo, DAY, sha)), data);
});

test('03 two records referencing the same entry dedupe to one file', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('dedupe');
  const sha = sha256Hex(data);
  const a = att(sha, 'page-0-dedupe00.jpg');
  sched(repo, 'a', DAY, [
    rec('r1', `${DAY}T09:00:00+08:00`, { attachments: [a] }),
    rec('r2', `${DAY}T10:00:00+08:00`, { attachments: [a] })
  ]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: a.entry, data }]);
  ok(run('--repo', repo, '--apply'));
  const mediaDir = path.join(repo, 'timeline', DAY, 'media');
  assert.deepEqual(fs.readdirSync(mediaDir), [`${sha.slice(0, 16)}.jpg`]);
});

test('04 archive is authoritative: entry in another date zip is unreferenced there', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const dataDay = dataFor('day-zip');
  const dataNext = dataFor('next-zip');
  const shaNext = sha256Hex(dataNext);
  sched(repo, 'a', DAY, [rec('old', `${DAY}T09:00:00+08:00`)]);
  sched(repo, 'a', NEXT, [rec('new', `${NEXT}T09:00:00+08:00`, {
    attachments: [att(shaNext, 'shared.jpg', `${NEXT}.zip`)]
  })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'shared.jpg', data: dataDay }]);
  writeZip(repo, 'a', `${NEXT}.zip`, [{ name: 'shared.jpg', data: dataNext }]);
  const dry = ok(run('--repo', repo, '--dry-run'));
  assert.match(dayLine(dry.stdout, DAY), /written=0/);
  assert.match(dayLine(dry.stdout, DAY), /unreferenced=1/);
  assert.match(dayLine(dry.stdout, NEXT), /written=1/);
  ok(run('--repo', repo, '--apply'));
  assert.ok(fs.existsSync(mediaPath(repo, NEXT, shaNext)));
  const dayMedia = path.join(repo, 'timeline', DAY, 'media');
  assert.equal(fs.existsSync(dayMedia) && fs.readdirSync(dayMedia).length > 0, false);
});

test('05 record placeholder with no matching zip entry: missing counted, no file created', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const sha = sha256Hex(dataFor('gone'));
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, {
    attachments: [att(sha, 'gone.jpg')]
  })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'other.jpg', data: dataFor('other') }]);
  const dry = ok(run('--repo', repo, '--dry-run'));
  assert.match(planLine(dry.stdout), /missing=1/);
  assert.match(dry.stdout, /missing r 2026-11-19\.zip!gone\.jpg/);
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(all(applied), /missing=1/);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, sha)), false);
});

test('06 CRC mismatch: per-entry error, file not written, exit 3 in --apply', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('bad-crc');
  const sha = sha256Hex(data);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'crc.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'crc.jpg', data, badCrc: true }]);
  const dry = ok(run('--repo', repo, '--dry-run'));
  assert.match(dayLine(dry.stdout, DAY), /errors=1/);
  assert.match(dry.stdout, /crc-mismatch/);
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(all(applied), /crc-mismatch/);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, sha)), false);
});

test('07 unsupported method 12: typed error, other entries still extracted, counts correct', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const good = dataFor('good');
  const shaGood = sha256Hex(good);
  const bad = dataFor('bzip2');
  const shaBad = sha256Hex(bad);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, {
    attachments: [att(shaGood, 'good.jpg'), att(shaBad, 'bad.jpg')]
  })]);
  writeZip(repo, 'a', `${DAY}.zip`, [
    { name: 'good.jpg', data: good, method: 0 },
    { name: 'bad.jpg', data: bad, method: 12 }
  ]);
  const dry = ok(run('--repo', repo, '--dry-run'));
  assert.match(dayLine(dry.stdout, DAY), /entries=2 written=1 skipped=0 errors=1/);
  assert.match(dry.stdout, /unsupported-method/);
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(all(applied), /unsupported-method/);
  // 默认不改最终树；成功解包的字节留在暂存现场供 inspection。
  assert.equal(fs.existsSync(mediaPath(repo, DAY, shaGood)), false);
  const stages = tmpDirs(repo);
  assert.equal(stages.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(repo, stages[0], 'media', DAY, `${shaGood.slice(0, 16)}.jpg`)), good);
});

test('08 encrypted flag: typed error, no file, exit 3', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('secret');
  const sha = sha256Hex(data);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'enc.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'enc.jpg', data, encrypted: true }]);
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(all(applied), /encrypted/);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, sha)), false);
});

test('09 dry-run writes nothing: whole tree unchanged, v1 zip byte-identical', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('dry');
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha256Hex(data), 'dry.jpg')] })]);
  const zipFile = writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'dry.jpg', data }]);
  const zipBefore = sha256Hex(fs.readFileSync(zipFile));
  const before = tree(repo);
  const r = ok(run('--repo', repo, '--dry-run'));
  assert.match(r.stdout, /dry-run: 未写入任何文件/);
  assert.deepEqual(tree(repo), before);
  assert.equal(sha256Hex(fs.readFileSync(zipFile)), zipBefore);
  assert.deepEqual(tmpDirs(repo), []);
});

test('10 --apply writes only timeline/<date>/media/<sha16>.jpg; v1 zip untouched', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('apply');
  const sha = sha256Hex(data);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'apply.jpg')] })]);
  const zipFile = writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'apply.jpg', data }]);
  const zipBefore = sha256Hex(fs.readFileSync(zipFile));
  ok(run('--repo', repo, '--apply'));
  assert.equal(sha256Hex(fs.readFileSync(zipFile)), zipBefore);
  assert.deepEqual(Object.keys(tree(path.join(repo, 'timeline'))).sort(), [
    `${DAY}/media/${sha.slice(0, 16)}.jpg`, 'schema.json'
  ]);
  assert.deepEqual(tmpDirs(repo), []);
});

test('11 idempotent second --apply: already-present, no rewrite', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('idem');
  const sha = sha256Hex(data);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'idem.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'idem.jpg', data }]);
  ok(run('--repo', repo, '--apply'));
  const file = mediaPath(repo, DAY, sha);
  const before = fs.readFileSync(file);
  const second = ok(run('--repo', repo, '--apply'));
  assert.match(second.stdout, /already-present=1/);
  assert.match(second.stdout, /verify ok days=1 merged=0 already-present=1/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(tmpDirs(repo), []);
});

test('12 existing different file: error, never overwritten', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('fresh');
  const sha = sha256Hex(data);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'fresh.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'fresh.jpg', data }]);
  const target = mediaPath(repo, DAY, sha);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from('SOME-OTHER-BYTES'));
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(all(applied), /existing-different/);
  assert.deepEqual(fs.readFileSync(target), Buffer.from('SOME-OTHER-BYTES'));
});

test('13 refusal without timeline/schema.json: exit 2, zero writes', (t) => {
  const { repo } = fixture(t);
  // timeline/ 存在但缺标记：专门命中「schema.json 缺失」分支（与「timeline/ 缺失」分支区分）。
  fs.mkdirSync(path.join(repo, 'timeline'), { recursive: true });
  const data = dataFor('noschema');
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha256Hex(data), 'x.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'x.jpg', data }]);
  const before = tree(repo);
  const r = run('--repo', repo, '--apply');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /缺少 .*schema\.json/);
  assert.deepEqual(tree(repo), before);
  assert.deepEqual(fs.readdirSync(path.join(repo, 'timeline')), []);
  assert.deepEqual(tmpDirs(repo), []);
});

test('14 refusal without devices/: exit 2', (t) => {
  const { dir } = fixture(t);
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  const r = run('--repo', empty, '--apply');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /未找到 devices\/ 目录/);
  assert.deepEqual(tree(empty), {});
});

test('15 sha16 collision: both entries skipped + typed error, no file', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const prefix = 'ab'.repeat(8);
  const shaA = prefix + '11'.repeat(24);
  const shaB = prefix + '22'.repeat(24);
  const dataA = dataFor('collision-a');
  const dataB = dataFor('collision-b');
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, {
    attachments: [att(shaA, 'a.jpg'), att(shaB, 'b.jpg')]
  })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'a.jpg', data: dataA }, { name: 'b.jpg', data: dataB }]);
  const dry = ok(run('--repo', repo, '--dry-run'));
  assert.match(dayLine(dry.stdout, DAY), /errors=2/);
  assert.match(dry.stdout, /sha16-collision/);
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, shaA)), false);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, shaB)), false);
});

test('16 determinism: two --apply runs into two --out roots produce byte-identical trees', (t) => {
  const { repo, dir } = fixture(t);
  const data = dataFor('determinism');
  const sha = sha256Hex(data);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'd.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'd.jpg', data, method: 8 }]);
  const outA = path.join(dir, 'outA');
  const outB = path.join(dir, 'outB');
  setupSchema(outA);
  setupSchema(outB);
  ok(run('--repo', repo, '--apply', '--out', outA));
  ok(run('--repo', repo, '--apply', '--out', outB));
  assert.deepEqual(tree(path.join(outA, 'timeline')), tree(path.join(outB, 'timeline')));
  assert.deepEqual(tmpDirs(outA), []);
  assert.deepEqual(tmpDirs(outB), []);
  // v1 侧完全没有 timeline；输出只落在 --out 下。
  assert.equal(fs.existsSync(path.join(repo, 'timeline')), false);
});

test('17 cross-check with records.json placeholder: missing file -> exit 3', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const sha = sha256Hex(dataFor('cross-missing'));
  const file = `${sha.slice(0, 16)}.jpg`;
  fs.mkdirSync(path.join(repo, 'timeline', DAY), { recursive: true });
  fs.writeFileSync(path.join(repo, 'timeline', DAY, 'records.json'), JSON.stringify({
    date: DAY, open: [], records: [{
      id: 'r', ts: `${DAY}T09:00:00+08:00`, title: 't', body: '', author: '我', done: false,
      media: [{ file, sha256: sha, pageIndex: 0 }], ai_processed: false, opened_at: `${DAY}T09:00:00+08:00`
    }]
  }));
  const dry = ok(run('--repo', repo, '--dry-run'));
  assert.match(dry.stdout, /cross-check days=1 placeholders=1 missing=1/);
  assert.match(dry.stdout, new RegExp(`cross-missing ${DAY} r ${file}`));
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(applied.stderr, /cross-missing=1/);
});

test('18 plan totals arithmetic: entries = written + skipped + errors', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const good = dataFor('arith-good');
  const bad = dataFor('arith-bad');
  const shaGood = sha256Hex(good);
  const shaBad = sha256Hex(bad);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, {
    attachments: [att(shaGood, 'good.jpg'), att(shaBad, 'bad.jpg')]
  })]);
  writeZip(repo, 'a', `${DAY}.zip`, [
    { name: 'good.jpg', data: good },
    { name: 'bad.jpg', data: bad, badCrc: true },
    { name: 'unref.jpg', data: dataFor('unref') }
  ]);
  const r = ok(run('--repo', repo, '--dry-run'));
  const line = planLine(r.stdout);
  const num = (key) => {
    const m = line.match(new RegExp(`${key}=(\\d+)`));
    assert.ok(m, `${key} missing in ${line}`);
    return Number(m[1]);
  };
  const entries = num('entries');
  const written = num('written');
  const skipped = num('skipped');
  const errors = num('errors');
  assert.equal(entries, 3);
  assert.equal(written, 1);
  assert.equal(skipped, 1);
  assert.equal(errors, 1);
  assert.equal(entries, written + skipped + errors);
});

test('19 refusal: schemaVersion 3 -> exit 2', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  fs.writeFileSync(path.join(repo, 'timeline', 'schema.json'), JSON.stringify({ schemaVersion: 3 }));
  const data = dataFor('v3');
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha256Hex(data), 'v3.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'v3.jpg', data }]);
  const before = tree(repo);
  const r = run('--repo', repo, '--apply');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /schemaVersion 不是 2/);
  assert.deepEqual(tree(repo), before);
});

test('20 --quiet suppresses plan detail but keeps verify result', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('quiet');
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha256Hex(data), 'q.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'q.jpg', data }]);
  const dry = ok(run('--repo', repo, '--quiet'));
  assert.equal(dry.stdout.trim(), '');
  const applied = ok(run('--repo', repo, '--apply', '--quiet'));
  assert.match(applied.stdout, /verify ok days=1 merged=1/);
  assert.doesNotMatch(applied.stdout, /\[media\] plan /);
});

test('21 fold by id: later ts wins, its attachment is the one extracted', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const oldData = dataFor('old-version');
  const newData = dataFor('new-version');
  const shaOld = sha256Hex(oldData);
  const shaNew = sha256Hex(newData);
  sched(repo, 'a', DAY, [
    rec('x', `${DAY}T09:00:00+08:00`, { title: 'old', attachments: [att(shaOld, 'old.jpg')] }),
    rec('x', `${DAY}T11:00:00+08:00`, { title: 'new', attachments: [att(shaNew, 'new.jpg')] })
  ]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'old.jpg', data: oldData }, { name: 'new.jpg', data: newData }]);
  const dry = ok(run('--repo', repo, '--dry-run'));
  assert.match(dayLine(dry.stdout, DAY), /unreferenced=1/);
  ok(run('--repo', repo, '--apply'));
  assert.ok(fs.existsSync(mediaPath(repo, DAY, shaNew)));
  assert.equal(fs.existsSync(mediaPath(repo, DAY, shaOld)), false);
});

test('22 same (id,ts) tie-break: UTF-8 byte-larger canonical line wins', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const shaFirst = sha256Hex(dataFor('tie-first'));
  const shaSecond = sha256Hex(dataFor('tie-second'));
  const ts = `${DAY}T09:00:00+08:00`;
  sched(repo, 'a', DAY, [
    rec('dup', ts, { title: 'first', attachments: [att(shaFirst, 'first.jpg')] }),
    rec('dup', ts, { title: 'second', attachments: [att(shaSecond, 'second.jpg')] })
  ]);
  writeZip(repo, 'a', `${DAY}.zip`, [
    { name: 'first.jpg', data: dataFor('tie-first') },
    { name: 'second.jpg', data: dataFor('tie-second') }
  ]);
  ok(run('--repo', repo, '--apply'));
  // 与记录工具 §4 同规则：'second' 的首字节 0x73 > 'first' 的 0x66。
  assert.ok(fs.existsSync(mediaPath(repo, DAY, shaSecond)));
  assert.equal(fs.existsSync(mediaPath(repo, DAY, shaFirst)), false);
});

test('23 ZIP64 locator: typed refusal, no media written, exit 3', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('zip64');
  const sha = sha256Hex(data);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'z64.jpg')] })]);
  const archive = path.join(repo, 'devices', 'a', 'attachments', `${DAY}.zip`);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, withZip64Locator(makeZip([{ name: 'z64.jpg', data }])));
  const dry = ok(run('--repo', repo, '--dry-run'));
  assert.match(dry.stdout, /zip64/);
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(all(applied), /zip64/);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, sha)), false);
});

test('24 missing EOCD: typed error, no media written, exit 3', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const sha = sha256Hex(dataFor('eocd'));
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'x.jpg')] })]);
  const archive = path.join(repo, 'devices', 'a', 'attachments', `${DAY}.zip`);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, Buffer.from('PK-not-a-zip'));
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(all(applied), /zip-eocd/);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, sha)), false);
});

test('25 sha256 mismatch on staging re-read: exit 3, staging kept', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('sha-mismatch');
  const wrongSha = '0'.repeat(64);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(wrongSha, 'wrong.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'wrong.jpg', data }]); // zip CRC 自洽，但与记录 sha256 不符
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(applied.stdout + applied.stderr, /verify-mismatch/);
  assert.match(applied.stderr, /sha-mismatch=1/);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, wrongSha)), false);
  assert.equal(tmpDirs(repo).length, 1);
});

test('26 media naming is bare <sha16>.jpg under <date>/media/ (no path prefix)', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('naming');
  const sha = sha256Hex(data);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'page-9-abcdef12.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'page-9-abcdef12.jpg', data }]);
  ok(run('--repo', repo, '--apply'));
  const mediaDir = path.join(repo, 'timeline', DAY, 'media');
  assert.deepEqual(fs.readdirSync(mediaDir), [`${sha.slice(0, 16)}.jpg`]);
  const file = path.join(mediaDir, `${sha.slice(0, 16)}.jpg`);
  assert.equal(path.basename(file), `${sha.slice(0, 16)}.jpg`);
  assert.equal(path.basename(path.dirname(file)), 'media');
});

test('27 cross-check placeholder already present: exit 0, already-present counted', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('cross-present');
  const sha = sha256Hex(data);
  const file = `${sha.slice(0, 16)}.jpg`;
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'cp.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'cp.jpg', data }]);
  fs.mkdirSync(path.join(repo, 'timeline', DAY, 'media'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'timeline', DAY, 'media', file), data);
  fs.writeFileSync(path.join(repo, 'timeline', DAY, 'records.json'), JSON.stringify({
    date: DAY, open: [], records: [{
      id: 'r', ts: `${DAY}T09:00:00+08:00`, title: 't', body: '', author: '我', done: false,
      media: [{ file, sha256: sha, pageIndex: 0 }], ai_processed: false, opened_at: `${DAY}T09:00:00+08:00`
    }]
  }));
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /cross-check days=1 placeholders=1 missing=0/);
  assert.match(r.stdout, /verify ok days=1 merged=0 already-present=1/);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'timeline', DAY, 'media', file)), data);
});

test('28 multiple days processed independently', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const dataA = dataFor('multi-a');
  const dataB = dataFor('multi-b');
  const shaA = sha256Hex(dataA);
  const shaB = sha256Hex(dataB);
  sched(repo, 'a', DAY, [rec('r1', `${DAY}T09:00:00+08:00`, { attachments: [att(shaA, 'a.jpg')] })]);
  sched(repo, 'a', NEXT, [rec('r2', `${NEXT}T09:00:00+08:00`, { attachments: [att(shaB, 'b.jpg', `${NEXT}.zip`)] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'a.jpg', data: dataA }]);
  writeZip(repo, 'a', `${NEXT}.zip`, [{ name: 'b.jpg', data: dataB }]);
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(r.stdout, /verify ok days=2 merged=2/);
  assert.deepEqual(fs.readFileSync(mediaPath(repo, DAY, shaA)), dataA);
  assert.deepEqual(fs.readFileSync(mediaPath(repo, NEXT, shaB)), dataB);
});

test('29 no zips / no records: empty plan, exit 0, schema-only tree', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  fs.mkdirSync(path.join(repo, 'devices', 'empty'), { recursive: true });
  const r = ok(run('--repo', repo, '--apply'));
  assert.match(planLine(r.stdout), /days=0 zips=0 entries=0 written=0 skipped=0 errors=0/);
  assert.deepEqual(Object.keys(tree(path.join(repo, 'timeline'))), ['schema.json']);
  assert.deepEqual(tmpDirs(repo), []);
});

test('30 same (archive,entry) with two different sha256: entry-sha-conflict typed error', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const shaA = sha256Hex(dataFor('conflict-a'));
  const shaB = sha256Hex(dataFor('conflict-b'));
  const data = dataFor('conflict-payload');
  sched(repo, 'a', DAY, [
    rec('r1', `${DAY}T09:00:00+08:00`, { attachments: [att(shaA, 'same.jpg')] }),
    rec('r2', `${DAY}T10:00:00+08:00`, { attachments: [att(shaB, 'same.jpg')] })
  ]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'same.jpg', data }]);
  const dry = ok(run('--repo', repo, '--dry-run'));
  assert.match(dry.stdout, /entry-sha-conflict/);
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(all(applied), /entry-sha-conflict/);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, shaA)), false);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, shaB)), false);
});

test('31 --force merges safe entries despite per-entry errors (exit still 3)', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const good = dataFor('force-good');
  const bad = dataFor('force-bad');
  const shaGood = sha256Hex(good);
  const shaBad = sha256Hex(bad);
  sched(repo, 'a', DAY, [rec('r', `${DAY}T09:00:00+08:00`, {
    attachments: [att(shaGood, 'good.jpg'), att(shaBad, 'bad.jpg')]
  })]);
  writeZip(repo, 'a', `${DAY}.zip`, [
    { name: 'good.jpg', data: good },
    { name: 'bad.jpg', data: bad, method: 12 }
  ]);
  const applied = run('--repo', repo, '--apply', '--force');
  assert.equal(applied.status, 3);
  assert.match(all(applied), /unsupported-method/);
  assert.match(applied.stderr, /已合并可安全条目 1 个/);
  assert.deepEqual(fs.readFileSync(mediaPath(repo, DAY, shaGood)), good);
  assert.equal(fs.existsSync(mediaPath(repo, DAY, shaBad)), false);
  assert.deepEqual(tmpDirs(repo), []);
});

// ---------------------------------------------------------------- P2-1: 跨 zip 同输出路径认领（同日多设备同名 zip）

test('32 same day, two devices, same entry name, IDENTICAL bytes: one file, counts consistent, exit 0', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('cross-device-identical');
  const sha = sha256Hex(data);
  // 两台设备的记录给出相同 sha256 -> collectReferences 合并成同一个 ref；
  // 但 listDayZips 会产出两个同名 archive（a/…zip 与 z/…zip），二者都会尝试写同一 stagedPath。
  sched(repo, 'a', DAY, [rec('ra', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'shared.jpg')] })]);
  sched(repo, 'z', DAY, [rec('rz', `${DAY}T10:00:00+08:00`, { attachments: [att(sha, 'shared.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'shared.jpg', data }]);
  writeZip(repo, 'z', `${DAY}.zip`, [{ name: 'shared.jpg', data }]);
  const dry = ok(run('--repo', repo, '--dry-run'));
  // 修复前：written=2 skipped=0（两个 write 对象，暂存互相覆盖，计数虚高）。
  // 修复后：written=1 skipped=1（duplicates），entries=2 仍闭合。
  assert.match(dayLine(dry.stdout, DAY), /entries=2 written=1 skipped=1 errors=0/);
  const applied = ok(run('--repo', repo, '--apply'));
  assert.match(applied.stdout, /verify ok days=1 merged=1 already-present=0/);
  const mediaDir = path.join(repo, 'timeline', DAY, 'media');
  assert.deepEqual(fs.readdirSync(mediaDir), [`${sha.slice(0, 16)}.jpg`]);
  assert.deepEqual(fs.readFileSync(mediaPath(repo, DAY, sha)), data);
  assert.deepEqual(tmpDirs(repo), []);
});

test('33 same day, two devices, same entry name, DIFFERENT bytes: exit 3, no merge, conflict named, first bytes staged', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  // 记录 sha 指向设备 a（排序在先）的字节；设备 z 的 zip 含不同字节但 CRC 自洽，extractEntry 照常通过。
  // 修复前：两个 write 指向同一 stagedPath，后者覆盖前者 -> verifyStaging 同一路径 sha-mismatch=2 或静默丢写。
  // 修复后：跨 zip 认领比对提取字节 -> entry-sha-conflict，fail-closed 不合并。
  const first = dataFor('cross-device-first');
  const second = dataFor('cross-device-second');
  const sha = sha256Hex(first);
  sched(repo, 'a', DAY, [rec('ra', `${DAY}T09:00:00+08:00`, { attachments: [att(sha, 'shared.jpg')] })]);
  sched(repo, 'z', DAY, [rec('rz', `${DAY}T10:00:00+08:00`, { attachments: [att(sha, 'shared.jpg')] })]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: 'shared.jpg', data: first }]);
  writeZip(repo, 'z', `${DAY}.zip`, [{ name: 'shared.jpg', data: second }]);
  const dry = ok(run('--repo', repo, '--dry-run'));
  assert.match(dry.stdout, /entry-sha-conflict/);
  assert.match(dry.stdout, new RegExp(`a/${DAY}\\.zip!shared\\.jpg`));
  assert.match(dry.stdout, new RegExp(`z/${DAY}\\.zip!shared\\.jpg`));
  const applied = run('--repo', repo, '--apply');
  assert.equal(applied.status, 3);
  assert.match(all(applied), /entry-sha-conflict/);
  assert.match(all(applied), /未合并/);
  // 不合并：最终树里没有该媒体文件；暂存保留且只有首个（排序在先设备）的字节。
  assert.equal(fs.existsSync(mediaPath(repo, DAY, sha)), false);
  const stages = tmpDirs(repo);
  assert.equal(stages.length, 1);
  assert.deepEqual(
    fs.readFileSync(path.join(repo, stages[0], 'media', DAY, `${sha.slice(0, 16)}.jpg`)),
    first
  );
});

test('34 same day, two records of the SAME device reference same entry: existing dedupe still counts once', (t) => {
  const { repo } = fixture(t);
  setupSchema(repo);
  const data = dataFor('same-device-dedupe');
  const sha = sha256Hex(data);
  const a = att(sha, 'page-0-dedupe00.jpg');
  sched(repo, 'a', DAY, [
    rec('r1', `${DAY}T09:00:00+08:00`, { attachments: [a] }),
    rec('r2', `${DAY}T10:00:00+08:00`, { attachments: [a] })
  ]);
  writeZip(repo, 'a', `${DAY}.zip`, [{ name: a.entry, data }]);
  const dry = ok(run('--repo', repo, '--dry-run'));
  // collectReferences 把两条记录的同一 entry 折叠成一个 ref，仍只产出一次写。
  assert.match(dayLine(dry.stdout, DAY), /entries=1 written=1 skipped=0 errors=0/);
  const applied = ok(run('--repo', repo, '--apply'));
  assert.match(applied.stdout, /verify ok days=1 merged=1 already-present=0/);
  const mediaDir = path.join(repo, 'timeline', DAY, 'media');
  assert.deepEqual(fs.readdirSync(mediaDir), [`${sha.slice(0, 16)}.jpg`]);
  assert.deepEqual(fs.readFileSync(mediaPath(repo, DAY, sha)), data);
  assert.deepEqual(tmpDirs(repo), []);
});
