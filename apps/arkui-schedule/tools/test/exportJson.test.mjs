// `mod-export-json`：导出即 git 格式的 repo-shaped bundle（manifest + timeline/** + media.zip）。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 本文件是纯逻辑 + 真 zip 桥的端到端契约：用内存 host 加载 rawfile/git 的 JSZip 桥，
// 造一个两天的 v2 fixture 仓库 → export（bundle）→ 擦空 scratch 目标 → import → 断言
// timeline/** 逐字节相等、媒体按 sha256 逐张相等；再覆盖：篡改条目 / 旧 bundle / 未来版本 / 确定性。
// 不写真实 git 仓库、不新增依赖（jszip.min.js 是本仓已 vendored 的运行时）。

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const M = await import('../.build/model/exportImport.js');
const { sha256Hex } = await import('../.build/model/sha256.js');

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = joinPath(here, '..', '..');
const bridgeDir = joinPath(appRoot, 'entry', 'src', 'main', 'resources', 'rawfile', 'git');
const SERVICE = readFileSync(joinPath(appRoot, 'entry', 'src', 'main', 'ets', 'services', 'exportService.ets'), 'utf8')
  .replace(/\r\n/g, '\n');
const BRIDGE = readFileSync(joinPath(bridgeDir, 'git-bridge.js'), 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- 内存 zip 桥

const memFs = new Map();
function installHost() {
  globalThis.dshGitHost = {
    fileExists(path) { return memFs.has(path) || [...memFs.keys()].some((k) => k.startsWith(`${path}/`)); },
    readFileBase64(path) {
      const v = memFs.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return Buffer.from(v).toString('base64');
    },
    writeFileBase64(path, b64) { memFs.set(path, Buffer.from(b64, 'base64')); return true; },
    mkdirp() { return true; }
  };
}
const require = createRequire(import.meta.url);
const jszipModule = require(joinPath(bridgeDir, 'jszip.min.js'));
const JSZip = typeof globalThis.JSZip === 'function' ? globalThis.JSZip
  : typeof jszipModule === 'function' ? jszipModule : jszipModule.default;
assert.equal(typeof JSZip, 'function');
globalThis.JSZip = JSZip;
installHost();
require(joinPath(bridgeDir, 'git-bridge.js'));
const zip = globalThis.DshGitBridge.internals;
function chunk(bytes) {
  const out = [];
  for (let o = 0; o < bytes.length; o += zip.zipChunkBytes) {
    out.push(Buffer.from(bytes.subarray(o, Math.min(o + zip.zipChunkBytes, bytes.length))).toString('base64'));
  }
  return out;
}
function unchunk(chunks) { return Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64'))); }
async function zipWrite(archivePath, entries) {
  const result = await zip.zipWrite({
    archivePath,
    entries: entries.map((e) => ({ name: e.name, chunks: chunk(e.bytes) }))
  });
  // 桥写入内存 host；同步一份到临时目录，让后续的 readFileSync / 服务层读回语义一致。
  const normalized = zip.normalizePath(archivePath);
  const written = memFs.get(normalized) ?? memFs.get(archivePath);
  if (written === undefined) {
    throw new Error(`zipWrite 未落盘：${archivePath}（normalized=${normalized}）`);
  }
  writeFileSync(archivePath, written);
  return result;
}
async function zipRead(archivePath, entry) {
  const r = await zip.zipRead({ archivePath, entryName: entry });
  return r.chunks.length === 0 ? null : unchunk(r.chunks);
}

// ---------------------------------------------------------------- fixture / export / import

const DATES = ['2026-11-19', '2026-11-20'];
const TARGET = { repoIsV2: true, writeEnabled: true };

function record(date, id, file, sha) {
  return {
    id, ts: `${date}T09:30:00+08:00`, title: `记录 ${id}`, body: '', author: '我', done: false,
    media: file ? [{ file, sha256: sha, pageIndex: 0 }] : [],
    ai_processed: false, opened_at: `${date}T09:30:00+08:00`
  };
}

/** 造一个两天、含记录/汇总/三本账本/2 张媒体的 fixture 仓库。 */
function buildFixtureRepo(root) {
  const media = new Map();
  for (const date of DATES) {
    const dayDir = joinPath(root, 'timeline', date);
    mkdirSync(joinPath(dayDir, 'media'), { recursive: true });
    const bytes = new TextEncoder().encode(`jpeg-${date}`);
    const sha = sha256Hex(bytes);
    const file = `${sha.slice(0, 16)}.jpg`;
    media.set(date, { file, sha, bytes, size: bytes.length });
    const recs = [record(date, `${date}-a`, file, sha), record(date, `${date}-b`, null, '')];
    writeFileSync(joinPath(dayDir, 'records.json'), M.buildV2RecordsText(date, recs));
    if (date === DATES[0]) {
      writeFileSync(joinPath(dayDir, 'summary.json'), JSON.stringify({ version: 1, date, headline: '要点' }) + '\n');
    }
    writeFileSync(joinPath(dayDir, 'deleted.jsonl'),
      JSON.stringify({ id: `${date}-old`, ts: `${date}T08:00:00+08:00`, deletedAt: `${date}T08:00:00+08:00` }) + '\n');
    writeFileSync(joinPath(dayDir, 'restore.jsonl'), '');
    writeFileSync(joinPath(dayDir, 'conflicts.jsonl'), '');
  }
  return media;
}

/** 模拟服务层导出：timeline/** 逐字节搬运 + 一个 media.zip + manifest 回填归档摘要。 */
async function exportBundle(repo, bundleDir, media) {
  const dayEntries = [];
  const mediaEntries = [];
  const zipEntries = [];
  const repoRoot = joinPath(repo, 'timeline');
  for (const date of DATES) {
    const dayDir = joinPath(repoRoot, date);
    const recordsText = readFileSync(joinPath(dayDir, 'records.json'), 'utf8');
    const summaryPath = joinPath(dayDir, 'summary.json');
    const summaryText = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
    const m = media.get(date);
    mediaEntries.push({ file: m.file, sha256: m.sha, bytes: m.size, date });
    zipEntries.push({ name: M.v2MediaEntryName(date, m.file), bytes: m.bytes });
    const ledgers = M.V2_LEDGER_FILES.map((name) => {
      const text = readFileSync(joinPath(dayDir, name), 'utf8');
      return { name, text, bytes: M.v2Utf8ByteLength(text) };
    });
    dayEntries.push({ date, recordCount: 2, hasSummary: summaryText.length > 0, media: [m.file],
      ledgers: ledgers.map((l) => ({ name: l.name, bytes: l.bytes })) });
  }
  zipEntries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const archivePath = joinPath(bundleDir, M.V2_MEDIA_ARCHIVE_NAME);
  mkdirSync(bundleDir, { recursive: true });
  const written = await zipWrite(archivePath, zipEntries);
  const archiveBytes = new Uint8Array(readFileSync(archivePath));
  const manifestText = M.buildV2Manifest({
    from: DATES[0], to: DATES[1], exportedAt: `${DATES[1]}T09:30:00+08:00`,
    days: dayEntries, media: mediaEntries,
    mediaArchive: { name: M.V2_MEDIA_ARCHIVE_NAME, sha256: sha256Hex(archiveBytes),
      bytes: archiveBytes.length, entries: written.entries }
  });
  writeFileSync(joinPath(bundleDir, 'manifest.json'), manifestText);
  for (const date of DATES) {
    const src = joinPath(repoRoot, date);
    const dest = joinPath(bundleDir, 'timeline', date);
    mkdirSync(dest, { recursive: true });
    for (const name of ['records.json', 'summary.json', ...M.V2_LEDGER_FILES]) {
      const p = joinPath(src, name);
      if (existsSync(p)) writeFileSync(joinPath(dest, name), readFileSync(p));
    }
  }
  return { manifestText, archiveBytes };
}

/** 模拟服务层导入：整包 sha 校验 → 逐张预检 → 零写入保证 → 才落盘。 */
async function importBundle(bundleDir, targetRoot, options = {}) {
  const manifestText = readFileSync(joinPath(bundleDir, 'manifest.json'), 'utf8');
  const parsed = M.parseV2Manifest(manifestText);
  if (!parsed.ok) return { code: parsed.code, writes: 0, plan: null };
  const manifest = parsed.manifest;
  const days = [];
  for (const day of manifest.days) {
    const dayDir = joinPath(bundleDir, 'timeline', day.date);
    days.push({
      date: day.date,
      recordsText: readFileSync(joinPath(dayDir, 'records.json'), 'utf8'),
      summaryText: day.hasSummary ? readFileSync(joinPath(dayDir, 'summary.json'), 'utf8') : '',
      mediaFiles: manifest.mediaArchive ? day.media.slice()
        : readdirSync(joinPath(dayDir, 'media')).filter((n) => /^[0-9a-f]{16}\.jpg$/.test(n)),
      ledgers: M.V2_LEDGER_FILES.map((name) => ({ name, text: readFileSync(joinPath(dayDir, name), 'utf8') }))
    });
  }
  const archivePath = joinPath(bundleDir, 'media.zip');
  const archiveBytes = existsSync(archivePath) ? new Uint8Array(readFileSync(archivePath)) : undefined;
  const plan = M.planV2Import({ manifestText, days, mediaArchiveBytes: archiveBytes }, TARGET);
  if (!plan.ok) return { code: plan.code, writes: 0, plan };
  // zip 异步预取（服务层 applyV2Import 的职责）；缺条目 / 读失败 = E_MEDIA_CORRUPT。
  // prefetched === null 表示旧 bundle（无 media.zip）——与服务层同款传参（P1-1）。
  const prefetched = manifest.mediaArchive ? new Map() : null;
  if (prefetched !== null) {
    for (const item of manifest.media) {
      const entry = M.v2MediaEntryName(item.date, item.file);
      const bytes = await zipRead(archivePath, entry);
      if (bytes === null) return { code: M.V2_REFUSAL_MEDIA_CORRUPT, writes: 0, plan };
      prefetched.set(entry, bytes);
    }
  }
  // 用服务层同款 io 构造器：新包挂 readArchiveEntry，旧包只给散图 readSource（P1-1）。
  const check = M.checkV2MediaIntegrity(plan, M.buildV2MediaCheckIo(
    () => false,
    () => { throw new Error('target must be empty'); },
    (date, file) => new Uint8Array(readFileSync(joinPath(bundleDir, 'timeline', date, 'media', file))),
    prefetched
  ));
  if (!check.ok) return { code: check.code, writes: 0, plan };
  let writes = 0;
  for (const day of plan.days) {
    const dest = joinPath(targetRoot, 'timeline', day.date);
    mkdirSync(joinPath(dest, 'media'), { recursive: true });
    // V2ValidatedDay 带的是已解析 records（不是原文）：用同一 canonical 生成器写回，断言逐字节相等。
    writeFileSync(joinPath(dest, 'records.json'), M.buildV2RecordsText(day.date, day.records)); writes++;
    if (day.summaryText.length > 0) { writeFileSync(joinPath(dest, 'summary.json'), day.summaryText); writes++; }
    for (const ledger of day.ledgers) {
      writeFileSync(joinPath(dest, ledger.name),
        M.mergeV2LedgerText('', ledger.text, ledger.name === 'conflicts.jsonl' ? 'conflict'
          : ledger.name === 'restore.jsonl' ? 'restore' : 'delete').text);
      writes++;
    }
    for (const item of check.verified.filter((v) => v.date === day.date)) {
      writeFileSync(joinPath(dest, 'media', item.file), item.bytes); writes++;
    }
  }
  return { code: '', writes, plan, check };
}

function freshDir(prefix) { return mkdtempSync(joinPath(tmpdir(), prefix)); }

// ---------------------------------------------------------------- tests

describe('mod-export-json：bundle 形态与确定性', () => {
  test('manifest 顶层含 mediaArchive，条目按 (date,file)，归档条目为 <date>/<sha16>.jpg', async () => {
    const repo = freshDir('dsh-json-repo-');
    const bundle = freshDir('dsh-json-bundle-');
    const media = buildFixtureRepo(repo);
    const exported = await exportBundle(repo, bundle, media);
    const doc = JSON.parse(exported.manifestText);
    assert.deepEqual(Object.keys(doc), ['bundleVersion', 'schemaVersion', 'kind', 'range', 'exportedAt',
      'dayCount', 'days', 'media', 'mediaArchive']);
    assert.equal(doc.bundleVersion, 2);
    assert.equal(doc.mediaArchive.name, 'media.zip');
    assert.equal(doc.mediaArchive.entries, 2);
    assert.equal(sha256Hex(exported.archiveBytes), doc.mediaArchive.sha256);
    assert.equal(exported.archiveBytes.length, doc.mediaArchive.bytes);
    const listed = await zip.zipList({ archivePath: joinPath(bundle, 'media.zip') });
    assert.deepEqual(listed.entries.map((e) => e.name),
      [M.v2MediaEntryName(DATES[0], media.get(DATES[0]).file), M.v2MediaEntryName(DATES[1], media.get(DATES[1]).file)]);
    assert.match(listed.entries[0].name, zip.mediaZipEntryRe);
    assert.equal(existsSync(joinPath(bundle, 'timeline', DATES[0], 'media')), false, 'bundle 内不再有按日 media/');
    rmSync(repo, { recursive: true, force: true });
    rmSync(bundle, { recursive: true, force: true });
  });

  test('确定性：同数据两次导出，manifest / media.zip / timeline/** 逐字节相同', async () => {
    const repo = freshDir('dsh-json-repo-');
    const media = buildFixtureRepo(repo);
    const a = freshDir('dsh-json-a-');
    const b = freshDir('dsh-json-b-');
    await exportBundle(repo, a, media);
    await exportBundle(repo, b, media);
    for (const name of ['manifest.json', 'media.zip']) {
      assert.deepEqual(readFileSync(joinPath(a, name)), readFileSync(joinPath(b, name)), `${name} 必须逐字节相同`);
    }
    for (const date of DATES) {
      for (const name of ['records.json', ...M.V2_LEDGER_FILES]) {
        assert.deepEqual(readFileSync(joinPath(a, 'timeline', date, name)),
          readFileSync(joinPath(b, 'timeline', date, name)));
      }
    }
    for (const d of [repo, a, b]) rmSync(d, { recursive: true, force: true });
  });
});

describe('mod-export-json：round-trip 与 typed 拒绝', () => {
  test('两天 fixture → export → 擦空 scratch → import：timeline 逐字节相等、媒体 sha256 相等', async () => {
    const repo = freshDir('dsh-json-repo-');
    const media = buildFixtureRepo(repo);
    const bundle = freshDir('dsh-json-bundle-');
    await exportBundle(repo, bundle, media);
    const target = freshDir('dsh-json-target-');
    const result = await importBundle(bundle, target);
    assert.equal(result.code, '');
    assert.ok(result.writes > 0);
    for (const date of DATES) {
      for (const name of ['records.json', 'summary.json', ...M.V2_LEDGER_FILES]) {
        const src = joinPath(repo, 'timeline', date, name);
        const dst = joinPath(target, 'timeline', date, name);
        if (existsSync(src)) {
          assert.ok(existsSync(dst), `${date}/${name} 必须被导入`);
          assert.deepEqual(readFileSync(dst), readFileSync(src), `${date}/${name} 必须逐字节相等`);
        }
      }
      const m = media.get(date);
      const got = new Uint8Array(readFileSync(joinPath(target, 'timeline', date, 'media', m.file)));
      assert.equal(sha256Hex(got), m.sha, '媒体内容按 sha256 逐张相等');
    }
    for (const d of [repo, bundle, target]) rmSync(d, { recursive: true, force: true });
  });

  test('篡改 media.zip 条目（整包 sha 同步改）→ E_MEDIA_CORRUPT，零写入', async () => {
    const repo = freshDir('dsh-json-repo-');
    const media = buildFixtureRepo(repo);
    const bundle = freshDir('dsh-json-bundle-');
    const exported = await exportBundle(repo, bundle, media);
    // 重写 zip：第一条改一个字节，但 manifest 里该文件的 sha256 不变；整包 sha 同步回填以隔离逐张校验。
    const entry = M.v2MediaEntryName(DATES[0], media.get(DATES[0]).file);
    const tampered = new Uint8Array(media.get(DATES[0]).bytes);
    tampered[0] = tampered[0] ^ 0xff;
    await zipWrite(joinPath(bundle, 'media.zip'), [
      { name: entry, bytes: tampered },
      { name: M.v2MediaEntryName(DATES[1], media.get(DATES[1]).file), bytes: media.get(DATES[1]).bytes }
    ]);
    const zipBytes = new Uint8Array(readFileSync(joinPath(bundle, 'media.zip')));
    const doc = JSON.parse(exported.manifestText);
    doc.mediaArchive.sha256 = sha256Hex(zipBytes);
    doc.mediaArchive.bytes = zipBytes.length;
    writeFileSync(joinPath(bundle, 'manifest.json'), JSON.stringify(doc, null, 2) + '\n');
    const target = freshDir('dsh-json-target-');
    const result = await importBundle(bundle, target);
    assert.equal(result.code, M.V2_REFUSAL_MEDIA_CORRUPT);
    assert.equal(result.writes, 0);
    assert.equal(existsSync(joinPath(target, 'timeline')), false, '目标一个字节都没写');
    for (const d of [repo, bundle, target]) rmSync(d, { recursive: true, force: true });
  });

  test('旧 bundle（无 media.zip，散图）仍可导入，返回 informational note', async () => {
    const repo = freshDir('dsh-json-repo-');
    const media = buildFixtureRepo(repo);
    const bundle = freshDir('dsh-json-bundle-');
    await exportBundle(repo, bundle, media);
    // 把 zip 拆回按日散图，manifest 删掉 mediaArchive（旧格式）。
    const doc = JSON.parse(readFileSync(joinPath(bundle, 'manifest.json'), 'utf8'));
    delete doc.mediaArchive;
    writeFileSync(joinPath(bundle, 'manifest.json'), JSON.stringify(doc, null, 2) + '\n');
    rmSync(joinPath(bundle, 'media.zip'));
    for (const date of DATES) {
      const m = media.get(date);
      const mediaDir = joinPath(bundle, 'timeline', date, 'media');
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(joinPath(mediaDir, m.file), m.bytes);
    }
    const target = freshDir('dsh-json-target-');
    const result = await importBundle(bundle, target);
    assert.equal(result.code, '');
    assert.ok(result.plan.notes.includes(M.V2_NOTE_MEDIA_ARCHIVE_ABSENT), '旧 bundle 必须给 informational note');
    for (const date of DATES) {
      const m = media.get(date);
      assert.equal(sha256Hex(new Uint8Array(readFileSync(joinPath(target, 'timeline', date, 'media', m.file)))), m.sha);
    }
    for (const d of [repo, bundle, target]) rmSync(d, { recursive: true, force: true });
  });

  test('P1-1 回归：旧 bundle 用服务层同款 io（prefetched=null → 不挂 readArchiveEntry）→ 成功 + note + 散图按 sha256 验证', async () => {
    const repo = freshDir('dsh-json-repo-');
    const media = buildFixtureRepo(repo);
    const bundle = freshDir('dsh-json-bundle-');
    await exportBundle(repo, bundle, media);
    // 拆成旧 bundle：删 mediaArchive / media.zip，按日写散图。
    const doc = JSON.parse(readFileSync(joinPath(bundle, 'manifest.json'), 'utf8'));
    delete doc.mediaArchive;
    writeFileSync(joinPath(bundle, 'manifest.json'), JSON.stringify(doc, null, 2) + '\n');
    rmSync(joinPath(bundle, 'media.zip'));
    for (const date of DATES) {
      const m = media.get(date);
      const mediaDir = joinPath(bundle, 'timeline', date, 'media');
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(joinPath(mediaDir, m.file), m.bytes);
    }
    // 逐字复刻服务层 applyV2ImportOnce 的 io 构造：把 prefetched=null 交给构造器决定挂不挂。
    const io = M.buildV2MediaCheckIo(
      () => false,
      () => { throw new Error('target must be empty'); },
      (date, file) => new Uint8Array(readFileSync(joinPath(bundle, 'timeline', date, 'media', file))),
      null
    );
    assert.equal(io.readArchiveEntry, undefined, '旧 bundle 不能挂抛错的 readArchiveEntry 劫持 readSource');
    const manifestText = readFileSync(joinPath(bundle, 'manifest.json'), 'utf8');
    const parsed = M.parseV2Manifest(manifestText);
    assert.equal(parsed.ok, true);
    const days = [];
    for (const day of parsed.manifest.days) {
      const dayDir = joinPath(bundle, 'timeline', day.date);
      days.push({
        date: day.date,
        recordsText: readFileSync(joinPath(dayDir, 'records.json'), 'utf8'),
        summaryText: day.hasSummary ? readFileSync(joinPath(dayDir, 'summary.json'), 'utf8') : '',
        mediaFiles: readdirSync(joinPath(dayDir, 'media')).filter((n) => /^[0-9a-f]{16}\.jpg$/.test(n)),
        ledgers: M.V2_LEDGER_FILES.map((name) => ({ name, text: readFileSync(joinPath(dayDir, name), 'utf8') }))
      });
    }
    const plan = M.planV2Import({ manifestText, days, mediaArchiveBytes: undefined }, TARGET);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.ok(plan.notes.includes(M.V2_NOTE_MEDIA_ARCHIVE_ABSENT), '旧 bundle 必须给 informational note');
    const check = M.checkV2MediaIntegrity(plan, io);
    assert.equal(check.ok, true, check.reason);
    assert.equal(check.verified.length, 2, '媒体从散图路径验证并交给写入');
    for (const item of check.verified) {
      assert.equal(item.sha256, media.get(item.date).sha, `${item.date} 媒体按 manifest sha256 验证`);
      assert.equal(sha256Hex(item.bytes), item.sha256, '验证的字节就是散图原文');
    }
    for (const d of [repo, bundle]) rmSync(d, { recursive: true, force: true });
  });

  test('整包 media.zip sha256 与 manifest 不符（整包级，非逐张）→ E_MEDIA_CORRUPT，零写入', async () => {
    const repo = freshDir('dsh-json-repo-');
    const media = buildFixtureRepo(repo);
    const bundle = freshDir('dsh-json-bundle-');
    const exported = await exportBundle(repo, bundle, media);
    // 篡改归档字节但**不回填** manifest.mediaArchive.sha256/bytes：命中整包校验分支，
    // 与「只改条目、同步回填整包 sha」的逐张用例互补。
    const archivePath = joinPath(bundle, 'media.zip');
    const bytes = new Uint8Array(readFileSync(archivePath));
    bytes[0] = bytes[0] ^ 0xff;
    writeFileSync(archivePath, bytes);
    const doc = JSON.parse(exported.manifestText);
    assert.equal(doc.mediaArchive.sha256, sha256Hex(exported.archiveBytes), 'manifest 仍声明原始整包 sha');
    assert.notEqual(sha256Hex(bytes), doc.mediaArchive.sha256, '实际归档 sha 已改变');
    const target = freshDir('dsh-json-target-');
    const result = await importBundle(bundle, target);
    assert.equal(result.code, M.V2_REFUSAL_MEDIA_CORRUPT);
    assert.equal(result.writes, 0);
    assert.equal(existsSync(joinPath(target, 'timeline')), false, '目标一个字节都没写');
    for (const d of [repo, bundle, target]) rmSync(d, { recursive: true, force: true });
  });

  test('未来 bundleVersion > 2 → E_BUNDLE_VERSION（typed 拒绝，零写入）', () => {
    const doc = {
      bundleVersion: 3, schemaVersion: 2, kind: M.V2_BUNDLE_KIND,
      range: { from: DATES[0], to: DATES[1] }, exportedAt: 'X', dayCount: 0, days: [], media: []
    };
    const parsed = M.parseV2Manifest(JSON.stringify(doc));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, M.V2_REFUSAL_BUNDLE_VERSION);
  });

  test('源码守卫：服务层用 zipWriteBundle / zipRead 走桥，预检在所有写入之前', () => {
    assert.match(SERVICE, /zipWriteBundle\(/, '导出必须经 zip 桥写 media.zip');
    assert.match(SERVICE, /zip\.zipRead\(/, '导入必须经 zip 桥读 media.zip 条目');
    assert.match(SERVICE, /buildV2MediaCheckIo\(/, '媒体预检 io 必须走服务层与测试共用的构造器');
    assert.match(BRIDGE, /zipWrite/, '桥必须暴露 zipWrite op');
    assert.match(BRIDGE, /1980, 0, 1/, 'zipWrite 必须用固定 DOS 时间保证确定性');
    const start = SERVICE.indexOf('function applyV2ImportOnce');
    assert.doesNotMatch(SERVICE.slice(start), /旧 bundle 没有 media\.zip/, 'apply 路径不得无条件挂抛错的 readArchiveEntry 劫持 readSource');
    const preflight = SERVICE.indexOf('checkV2MediaIntegrity(', start);
    const firstWrite = Math.min(
      SERVICE.indexOf('timelineWriteStore.append(', start),
      SERVICE.indexOf('v2WriteBinary(', start)
    );
    assert.ok(preflight > 0 && firstWrite > 0 && preflight < firstWrite, '预检早于一切写入');
  });
});
