// `mod-export-import-v2`：v2 单时间线导出 / 导入的纯逻辑契约测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 这个文件钉住 brief 的四条硬约束：
// 1. 导出 bundle 的确定性（days 按 date、records 按 (ts,id)、media 按 (date,file)），同数据逐字节稳定；
// 2. 导入 validate + dry-run 的五类类型化拒绝（E_SCHEMA_UNKNOWN / E_BUNDLE_CORRUPT /
//    E_MEDIA_MISSING / E_V1_TARGET / E_TARGET_BUSY）与 plan(days/records/media/bytes)；
// 3. 落点只经 timelineWriteStore（源码级断言），不写 devices/**、不删媒体；
// 4. UI 只在 timelineStore.useV2() 时显示 v2 节，禁用按钮必须有中文原因（无假入口）；
// 5. 落盘前媒体 sha256 预检：篡改 / 读不出 → E_MEDIA_CORRUPT，同名不同内容 → E_MEDIA_COLLISION，
//    失败时零写入；四个 v2 回调已全部接线，无「未接入」死路径（review follow-up）。
//
// v1 行为不改：本文件不改也不削弱 exportImport.test.mjs 的任何用例。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.js')
      ) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const {
  V2_BUNDLE_KIND,
  V2_BUNDLE_SCHEMA_VERSION,
  V2_REFUSAL_BUNDLE_CORRUPT,
  V2_REFUSAL_MEDIA_CORRUPT,
  V2_REFUSAL_MEDIA_COLLISION,
  V2_REFUSAL_MEDIA_MISSING,
  V2_REFUSAL_SCHEMA_UNKNOWN,
  V2_REFUSAL_TARGET_BUSY,
  V2_REFUSAL_V1_TARGET,
  asV2Record,
  buildV2Manifest,
  buildV2RecordsText,
  checkV2MediaIntegrity,
  parseV2Manifest,
  planV2Import,
  validateV2Bundle,
  v2PlanSummary,
  v2RefusalNext
} = await import('../.build/model/exportImport.js');

const {
  parseLedger,
  parseTimelineDay,
  visibleRecords
} = await import('../.build/model/timeline.js');

const { sha256Hex } = await import('../.build/model/sha256.js');

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE = readFileSync(
  new URL('../../entry/src/main/ets/services/exportService.ets', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n');
const PANEL = readFileSync(
  new URL('../../entry/src/main/ets/components/ExportImportPanel.ets', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n');
const SETTINGS = readFileSync(
  new URL('../../entry/src/main/ets/pages/Settings.ets', import.meta.url),
  'utf8'
).replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- 造数据

const SHA_1 = 'ab'.repeat(32); // 64 位小写 hex
const SHA_2 = 'cd'.repeat(32);
const FILE_1 = `${SHA_1.slice(0, 16)}.jpg`;
const FILE_2 = `${SHA_2.slice(0, 16)}.jpg`;

/** 一条合法 v2 形状记录（含 opened_at / media；buildV2RecordsText 会再规范化）。 */
function v2rec(overrides = {}) {
  return {
    id: 'r1',
    ts: '2026-11-19T09:30:00+08:00',
    title: '周会',
    body: '',
    author: '我',
    done: false,
    ai_processed: false,
    media: [],
    opened_at: '2026-11-19T09:30:00+08:00',
    ...overrides
  };
}

function recWithMedia(overrides, file, sha, pageIndex = 0) {
  return v2rec({ ...overrides, media: [{ file, sha256: sha, pageIndex }] });
}

/** 造一个合法的 bundle（默认两天，可覆盖 manifest 与逐日输入）。 */
function makeBundle(options = {}) {
  const dates = options.dates ?? ['2026-11-19', '2026-11-20'];
  const dayEntries = [];
  const mediaEntries = [];
  const days = [];
  for (const date of dates) {
    const records = options.recordsFor ? options.recordsFor(date) : [v2rec({ id: `${date}-a`, ts: `${date}T09:30:00+08:00` })];
    const mediaFiles = options.mediaFor ? options.mediaFor(date) : [];
    for (const name of mediaFiles) {
      mediaEntries.push({ file: name, sha256: name.slice(0, -4).padEnd(64, '0'), bytes: 10, date });
    }
    dayEntries.push({ date, recordCount: records.length, hasSummary: false, media: mediaFiles });
    days.push({
      date,
      recordsText: buildV2RecordsText(date, records),
      summaryText: '',
      mediaFiles: options.presentMediaFor ? options.presentMediaFor(date) : mediaFiles.slice()
    });
  }
  const manifestText = buildV2Manifest({
    from: dates[0],
    to: dates[dates.length - 1],
    exportedAt: options.exportedAt ?? `${dates[0]}T09:30:00+08:00`,
    days: options.dayEntries ?? dayEntries,
    media: options.mediaEntries ?? mediaEntries
  });
  return { manifestText, days };
}

const V2_TARGET_OK = { repoIsV2: true, writeEnabled: true };

/** 造一份「声明一张媒体」的合法 bundle：manifest 的 sha256 与 goodBytes 真值一致。 */
function makeMediaBundle() {
  const date = '2026-11-19';
  const goodBytes = new TextEncoder().encode('good-jpeg-bytes-123');
  const goodSha = sha256Hex(goodBytes);
  const file = `${goodSha.slice(0, 16)}.jpg`;
  const manifestText = buildV2Manifest({
    from: date,
    to: date,
    exportedAt: `${date}T09:00:00+08:00`,
    days: [{ date, recordCount: 1, hasSummary: false, media: [file] }],
    media: [{ file, sha256: goodSha, bytes: goodBytes.length, date }]
  });
  const records = [
    v2rec({ id: 'm', ts: `${date}T09:00:00+08:00`, media: [{ file, sha256: goodSha, pageIndex: 0 }] })
  ];
  const bundle = {
    manifestText,
    days: [
      { date, recordsText: buildV2RecordsText(date, records), summaryText: '', mediaFiles: [file] }
    ]
  };
  return { bundle, date, file, goodBytes, goodSha };
}

/** 假 IO：目标是否存在、读目标、读源都可注入；unreadable 系列模拟读失败。 */
function mediaIo(bytes, options = {}) {
  const io = {
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
  return io;
}

// ---------------------------------------------------------------- buildV2Manifest

describe('v2 导出 manifest：确定性 + 逐字节稳定', () => {
  test('顶层键序固定，schemaVersion=2 / kind 标记写入', () => {
    const text = buildV2Manifest({
      from: '2026-11-01', to: '2026-11-30', exportedAt: '2026-11-18T00:00:00+08:00',
      days: [], media: []
    });
    const doc = JSON.parse(text);
    assert.equal(doc.schemaVersion, V2_BUNDLE_SCHEMA_VERSION);
    assert.equal(doc.kind, V2_BUNDLE_KIND);
    assert.deepEqual(Object.keys(doc), ['schemaVersion', 'kind', 'range', 'exportedAt', 'dayCount', 'days', 'media']);
    assert.deepEqual(doc.range, { from: '2026-11-01', to: '2026-11-30' });
    assert.equal(doc.dayCount, 0);
    assert.equal(text.endsWith('\n'), true);
  });

  test('days 按 date、media 按 (date,file) 排序：乱序输入得到同一份字节（byte-stable）', () => {
    const input = {
      from: '2026-11-01', to: '2026-11-30', exportedAt: 'X',
      days: [
        { date: '2026-11-20', recordCount: 1, hasSummary: false, media: [FILE_2, FILE_1] },
        { date: '2026-11-19', recordCount: 2, hasSummary: true, media: [FILE_1] }
      ],
      media: [
        { file: FILE_2, sha256: SHA_2, bytes: 20, date: '2026-11-20' },
        { file: FILE_1, sha256: SHA_1, bytes: 10, date: '2026-11-19' }
      ]
    };
    const shuffled = {
      ...input,
      days: [input.days[1], input.days[0]],
      media: [input.media[1], input.media[0]]
    };
    const a = buildV2Manifest(input);
    const b = buildV2Manifest(shuffled);
    assert.equal(a, b, '同一份逻辑数据重复导出必须逐字节相同');
    const doc = JSON.parse(a);
    assert.deepEqual(doc.days.map((d) => d.date), ['2026-11-19', '2026-11-20']);
    assert.deepEqual(doc.days[0].media, [FILE_1]);
    assert.deepEqual(doc.media.map((m) => m.file), [FILE_1, FILE_2]);
  });

  test('非法区间抛中文 Error（与 v1 渲染入口同口径）', () => {
    assert.throws(
      () => buildV2Manifest({ from: '2026-11-30', to: '2026-11-01', exportedAt: '', days: [], media: [] }),
      /导出区间非法/
    );
  });
});

// ---------------------------------------------------------------- parseV2Manifest

describe('parseV2Manifest：schema 标记与字段形状的 fail-closed', () => {
  test('合法 manifest → ok:true，字段回填', () => {
    const text = buildV2Manifest({ from: '2026-11-19', to: '2026-11-19', exportedAt: 'E', days: [], media: [] });
    const parsed = parseV2Manifest(text);
    assert.equal(parsed.ok, true, parsed.reason);
    assert.equal(parsed.code, '');
    assert.notEqual(parsed.manifest, null);
    assert.equal(parsed.manifest.exportedAt, 'E');
  });

  test('schemaVersion 存在但不为 2 → E_SCHEMA_UNKNOWN', () => {
    const text = buildV2Manifest({ from: '2026-11-19', to: '2026-11-19', exportedAt: '', days: [], media: [] });
    const bad = text.replace('"schemaVersion": 2', '"schemaVersion": 99');
    const parsed = parseV2Manifest(bad);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, V2_REFUSAL_SCHEMA_UNKNOWN);
    assert.ok(parsed.reason.includes('99'));
  });

  test('空文件 / 坏 JSON / 顶层非对象 / 缺 schemaVersion / kind 不符 → E_BUNDLE_CORRUPT', () => {
    const cases = ['', '   ', '{oops', '[]', '{"kind":"dsh-schedule-v2","range":{},"days":[],"media":[],"dayCount":0}'];
    for (const text of cases) {
      const parsed = parseV2Manifest(text);
      assert.equal(parsed.ok, false, `应拒绝：${text}`);
      assert.equal(parsed.code, V2_REFUSAL_BUNDLE_CORRUPT, `实际：${parsed.code} / ${parsed.reason}`);
    }
    const valid = buildV2Manifest({ from: '2026-11-19', to: '2026-11-19', exportedAt: '', days: [], media: [] });
    const wrongKind = parseV2Manifest(valid.replace(V2_BUNDLE_KIND, 'other-kind'));
    assert.equal(wrongKind.code, V2_REFUSAL_BUNDLE_CORRUPT);
  });

  test('dayCount 与 days 不一致 → E_BUNDLE_CORRUPT', () => {
    const text = buildV2Manifest({ from: '2026-11-19', to: '2026-11-19', exportedAt: '', days: [], media: [] });
    const parsed = parseV2Manifest(text.replace('"dayCount": 0', '"dayCount": 3'));
    assert.equal(parsed.code, V2_REFUSAL_BUNDLE_CORRUPT);
  });

  test('带 BOM 的 manifest 也能读', () => {
    const text = buildV2Manifest({ from: '2026-11-19', to: '2026-11-19', exportedAt: '', days: [], media: [] });
    assert.equal(parseV2Manifest(`\ufeff${text}`).ok, true);
  });
});

// ---------------------------------------------------------------- 记录序列化 + 账本过滤链

describe('v2 导出记录：buildV2RecordsText 字节稳定 + 账本优先级链', () => {
  test('同输入两次字节相同，按 (ts,id) 排序，未知扩展字段原样保留', () => {
    const date = '2026-11-19';
    const records = [
      v2rec({ id: 'late', ts: `${date}T18:00:00+08:00`, title: '下午' }),
      v2rec({ id: 'early', ts: `${date}T07:00:00+08:00`, title: '早上', tag: 'keep-me' })
    ];
    const a = buildV2RecordsText(date, records);
    const b = buildV2RecordsText(date, records);
    assert.equal(a, b, 'same data → same bytes');
    const parsed = parseTimelineDay(a, date);
    assert.equal(parsed.day !== null, true);
    assert.equal(parsed.errors.length, 0, 'buildRecordsText 的解析自检必须通过');
    assert.deepEqual(parsed.day.allRecords.map((r) => r.id), ['early', 'late']);
    assert.equal(parsed.day.allRecords[0].tag, 'keep-me', '未知字段原样尾随');
    assert.ok(a.startsWith('{\n  "date": "2026-11-19",\n  "open": '), '顶层键序 date/open/records');
  });

  test('deleted/restore 优先级：账本判删的记录不进导出（导出只拿 visibleRecords）', () => {
    const date = '2026-11-19';
    const kept = v2rec({ id: 'kept', ts: `${date}T09:00:00+08:00` });
    const deleted = v2rec({ id: 'gone', ts: `${date}T10:00:00+08:00` });
    const text = buildV2RecordsText(date, [kept, deleted]);
    const day = parseTimelineDay(text, date).day;
    const delLedger = parseLedger(JSON.stringify({ id: 'gone', ts: `${date}T11:00:00+08:00`, deletedAt: `${date}T11:00:00+08:00` })).entries;
    const restoreLedger = parseLedger('').entries;
    const visible = visibleRecords(day, delLedger, restoreLedger);
    assert.deepEqual(visible.map((r) => r.id), ['kept'], 'D 无 R → 不可见，与 timelineStore.readDay 同口径');

    const exportedText = buildV2RecordsText(date, visible);
    const exportedIds = parseTimelineDay(exportedText, date).day.allRecords.map((r) => r.id);
    assert.deepEqual(exportedIds, ['kept'], '导出 bundle 里只有可见记录');
  });

  test('media 索引原样保留；asV2Record 补齐 opened_at / media', () => {
    const record = recWithMedia({}, FILE_1, SHA_1, 0);
    const v2 = asV2Record(record);
    assert.equal(v2.opened_at, record.ts);
    assert.equal(v2.media.length, 1);
    assert.equal(v2.media[0].file, FILE_1);
    assert.equal(v2.media[0].sha256, SHA_1);
    assert.equal(v2.media[0].pageIndex, 0);
  });
});

// ---------------------------------------------------------------- validateV2Bundle

describe('validateV2Bundle：逐日记录解析 + 媒体在位', () => {
  test('合法 bundle → ok:true，逐日记录数/媒体清单回填', () => {
    const bundle = makeBundle({
      dates: ['2026-11-19'],
      recordsFor: (d) => [v2rec({ id: 'a', ts: `${d}T09:00:00+08:00` })],
      mediaFor: () => [FILE_1]
    });
    const result = validateV2Bundle(bundle);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.days.length, 1);
    assert.equal(result.days[0].records.length, 1);
    assert.deepEqual(result.days[0].mediaFiles, [FILE_1]);
  });

  test('records.json 无法解析 / 记录数不符 → E_BUNDLE_CORRUPT', () => {
    const good = makeBundle({ dates: ['2026-11-19'] });
    const broken = { ...good, days: [{ ...good.days[0], recordsText: 'not json' }] };
    assert.equal(validateV2Bundle(broken).code, V2_REFUSAL_BUNDLE_CORRUPT);

    const wrongCount = makeBundle({
      dates: ['2026-11-19'],
      dayEntries: [{ date: '2026-11-19', recordCount: 9, hasSummary: false, media: [] }]
    });
    assert.equal(validateV2Bundle(wrongCount).code, V2_REFUSAL_BUNDLE_CORRUPT);
  });

  test('manifest 声明的媒体文件在某日 media/ 名单里缺失 → E_MEDIA_MISSING', () => {
    const bundle = makeBundle({
      dates: ['2026-11-19'],
      mediaFor: () => [FILE_1],
      presentMediaFor: () => [] // 目录里没有这个文件
    });
    const result = validateV2Bundle(bundle);
    assert.equal(result.ok, false);
    assert.equal(result.code, V2_REFUSAL_MEDIA_MISSING);
    assert.ok(result.reason.includes(FILE_1));
  });

  test('bundle 天数与 manifest 不符 → E_BUNDLE_CORRUPT', () => {
    const bundle = makeBundle({ dates: ['2026-11-19', '2026-11-20'] });
    bundle.days.pop();
    assert.equal(validateV2Bundle(bundle).code, V2_REFUSAL_BUNDLE_CORRUPT);
  });
});

// ---------------------------------------------------------------- planV2Import：五类类型化拒绝 + dry-run

describe('planV2Import：五类类型化拒绝（typed refusals）', () => {
  test('E_SCHEMA_UNKNOWN：bundle 标记不认识', () => {
    const bundle = makeBundle({ dates: ['2026-11-19'] });
    const bad = bundle.manifestText.replace('"schemaVersion": 2', '"schemaVersion": 7');
    const plan = planV2Import({ ...bundle, manifestText: bad }, V2_TARGET_OK);
    assert.equal(plan.ok, false);
    assert.equal(plan.code, V2_REFUSAL_SCHEMA_UNKNOWN);
    assert.deepEqual(plan.days, []);
    assert.equal(plan.totals.records, 0, '拒绝必须零计划、零写入');
  });

  test('E_BUNDLE_CORRUPT：日文件坏', () => {
    const bundle = makeBundle({ dates: ['2026-11-19'] });
    bundle.days[0].recordsText = '{broken';
    const plan = planV2Import(bundle, V2_TARGET_OK);
    assert.equal(plan.code, V2_REFUSAL_BUNDLE_CORRUPT);
  });

  test('E_MEDIA_MISSING：媒体没一起搬运', () => {
    const bundle = makeBundle({ dates: ['2026-11-19'], mediaFor: () => [FILE_1], presentMediaFor: () => [] });
    const plan = planV2Import(bundle, V2_TARGET_OK);
    assert.equal(plan.code, V2_REFUSAL_MEDIA_MISSING);
  });

  test('E_V1_TARGET：v2 bundle 落进 v1 仓库（无 schema 标记）→ 要求先迁移', () => {
    const bundle = makeBundle({ dates: ['2026-11-19'] });
    const plan = planV2Import(bundle, { repoIsV2: false, writeEnabled: false });
    assert.equal(plan.code, V2_REFUSAL_V1_TARGET);
    assert.ok(plan.reason.includes('迁移'), '原因里要给出「先迁移」的下一步');
  });

  test('E_TARGET_BUSY：仓库是 v2 但写入路径未启用', () => {
    const bundle = makeBundle({ dates: ['2026-11-19'] });
    const plan = planV2Import(bundle, { repoIsV2: true, writeEnabled: false });
    assert.equal(plan.code, V2_REFUSAL_TARGET_BUSY);
    assert.ok(plan.reason.includes('写入'), '原因里要点名写入路径');
  });

  test('七类拒绝都有中文「下一步」文案（含新增 E_MEDIA_CORRUPT / E_MEDIA_COLLISION）', () => {
    for (const code of [
      V2_REFUSAL_SCHEMA_UNKNOWN, V2_REFUSAL_BUNDLE_CORRUPT, V2_REFUSAL_MEDIA_MISSING,
      V2_REFUSAL_V1_TARGET, V2_REFUSAL_TARGET_BUSY,
      V2_REFUSAL_MEDIA_CORRUPT, V2_REFUSAL_MEDIA_COLLISION
    ]) {
      const next = v2RefusalNext(code);
      assert.ok(next.length > 0);
      assert.match(next, /[\u4e00-\u9fa5]/, `${code} 的下一步必须是中文`);
    }
  });
});

describe('planV2Import：成功路径给出 days / records / media / bytes', () => {
  test('dry-run 统计正确，且 plan 携带逐日记录供 apply 使用', () => {
    const bundle = makeBundle({
      dates: ['2026-11-19', '2026-11-20'],
      recordsFor: (d) => [
        v2rec({ id: `${d}-a`, ts: `${d}T09:00:00+08:00` }),
        v2rec({ id: `${d}-b`, ts: `${d}T10:00:00+08:00` })
      ],
      mediaFor: (d) => (d === '2026-11-19' ? [FILE_1] : []),
      mediaEntries: [{ file: FILE_1, sha256: SHA_1, bytes: 1234, date: '2026-11-19' }]
    });
    const plan = planV2Import(bundle, V2_TARGET_OK);
    assert.equal(plan.ok, true, plan.reason);
    assert.equal(plan.code, '');
    assert.equal(plan.totals.days, 2);
    assert.equal(plan.totals.records, 4);
    assert.equal(plan.totals.media, 1);
    assert.equal(plan.totals.bytes, 1234);
    assert.equal(plan.days.length, 2);
    assert.equal(plan.days[0].records.length, 2);
    assert.ok(v2PlanSummary(plan).includes('2 天 / 4 条记录 / 1 个媒体文件（共 1234 字节）'));
  });

  test('拒绝时计划行不渲染（避免面板显示假计划）', () => {
    const bundle = makeBundle({ dates: ['2026-11-19'] });
    const plan = planV2Import(bundle, { repoIsV2: false, writeEnabled: false });
    assert.equal(v2PlanSummary(plan), '');
  });
});

// ---------------------------------------------------------------- 落盘前媒体完整性（P1-1 / P2）

describe('checkV2MediaIntegrity：sha256 校验与 sha16 碰撞（fail closed before any write）', () => {
  test('valid bytes → ok，verified 携带已校验字节供复制', () => {
    const { bundle, file, goodBytes, goodSha } = makeMediaBundle();
    const plan = planV2Import(bundle, V2_TARGET_OK);
    assert.equal(plan.ok, true, plan.reason);
    const result = checkV2MediaIntegrity(plan, mediaIo(goodBytes));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.code, '');
    assert.equal(result.verified.length, 1);
    assert.equal(result.verified[0].file, file);
    assert.equal(result.verified[0].sha256, goodSha);
    assert.deepEqual(Array.from(result.verified[0].bytes), Array.from(goodBytes));
  });

  test('tampered bytes → E_MEDIA_CORRUPT，verified 为空（调用方据此零写入）', () => {
    const { bundle } = makeMediaBundle();
    const plan = planV2Import(bundle, V2_TARGET_OK);
    const result = checkV2MediaIntegrity(plan, mediaIo(new TextEncoder().encode('TAMPERED')));
    assert.equal(result.ok, false);
    assert.equal(result.code, V2_REFUSAL_MEDIA_CORRUPT);
    assert.deepEqual(result.verified, [], '坏图不得进入写入列表');
    assert.match(result.reason, /[\u4e00-\u9fa5]/, '原因必须中文');
    assert.ok(result.reason.includes('未写入任何内容'));
    assert.match(v2RefusalNext(V2_REFUSAL_MEDIA_CORRUPT), /[\u4e00-\u9fa5]/, '下一步必须中文');
  });

  test('unreadable source → E_MEDIA_CORRUPT，verified 为空', () => {
    const { bundle } = makeMediaBundle();
    const plan = planV2Import(bundle, V2_TARGET_OK);
    const result = checkV2MediaIntegrity(plan, mediaIo(new Uint8Array(), { unreadableSource: true }));
    assert.equal(result.code, V2_REFUSAL_MEDIA_CORRUPT);
    assert.deepEqual(result.verified, []);
  });

  test('计划有媒体但 manifest 无 sha256 条目 → E_MEDIA_CORRUPT（无法校验就不搬）', () => {
    const { bundle } = makeMediaBundle();
    const doc = JSON.parse(bundle.manifestText);
    doc.media = [];
    const plan = planV2Import({ ...bundle, manifestText: JSON.stringify(doc) }, V2_TARGET_OK);
    assert.equal(plan.ok, true, plan.reason);
    const result = checkV2MediaIntegrity(
      plan,
      mediaIo(new TextEncoder().encode('good-jpeg-bytes-123'))
    );
    assert.equal(result.code, V2_REFUSAL_MEDIA_CORRUPT);
    assert.deepEqual(result.verified, []);
  });

  test('manifest 同一 (date,file) 两个不同 sha256 → E_MEDIA_COLLISION（选拒绝，不延长前缀）', () => {
    const { bundle, date, file, goodBytes } = makeMediaBundle();
    const doc = JSON.parse(bundle.manifestText);
    doc.media.push({ file, sha256: SHA_2, bytes: 10, date });
    const plan = planV2Import({ ...bundle, manifestText: JSON.stringify(doc) }, V2_TARGET_OK);
    assert.equal(plan.ok, true, 'manifest 形状仍合法，碰撞在预检阶段拦截');
    const result = checkV2MediaIntegrity(plan, mediaIo(goodBytes));
    assert.equal(result.code, V2_REFUSAL_MEDIA_COLLISION);
    assert.deepEqual(result.verified, []);
    assert.match(v2RefusalNext(V2_REFUSAL_MEDIA_COLLISION), /[\u4e00-\u9fa5]/);
  });

  test('目标已有同名但内容不同 → E_MEDIA_COLLISION（不覆盖，也不留错误旧图）', () => {
    const { bundle } = makeMediaBundle();
    const plan = planV2Import(bundle, V2_TARGET_OK);
    const result = checkV2MediaIntegrity(
      plan,
      mediaIo(new TextEncoder().encode('good-jpeg-bytes-123'), {
        targetExists: true,
        targetBytes: new TextEncoder().encode('WRONG-OLD-IMAGE')
      })
    );
    assert.equal(result.code, V2_REFUSAL_MEDIA_COLLISION);
    assert.deepEqual(result.verified, []);
  });

  test('目标已有同名且内容一致 → 跳过复制（media 只增不覆盖）', () => {
    const { bundle, goodBytes } = makeMediaBundle();
    const plan = planV2Import(bundle, V2_TARGET_OK);
    const result = checkV2MediaIntegrity(
      plan,
      mediaIo(goodBytes, { targetExists: true })
    );
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.verified, [], '已有正确文件不再复制');
  });
});

// ---------------------------------------------------------------- 源码级接线断言

/** 剥掉行注释（本测试只判可执行文本；注释里写「不写 devices/**」是纪律陈述，不是路径）。 */
function stripLineComments(source) {
  const lines = source.split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      kept.push('');
    } else {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

describe('源码级：v2 落点只经原子写、不碰 devices、UI flag-gated', () => {
  const V2_MARK = '// ================================================================ v2 单时间线导出 / 导入';

  test('exportService 的 v2 段只经 timelineWriteStore，不直接写 timeline records.json', () => {
    const start = SERVICE.indexOf(V2_MARK);
    assert.ok(start > 0, 'exportService 里找不到 v2 段标记');
    const v2Code = stripLineComments(SERVICE.slice(start));
    assert.match(v2Code, /timelineWriteStore\.append\(/, '记录必须经既有原子 writer 的 append 落盘');
    assert.match(v2Code, /timelineWriteStore\.appendSummary\(/, '汇总必须经既有原子 writer 落盘');
    assert.match(v2Code, /timelineStore\.readDay\(/, '导出复用 timelineStore 的账本过滤读');
    assert.match(v2Code, /buildV2RecordsText\(/, '日文件字节由 buildRecordsText 生成');
    assert.match(v2Code, /planV2Import\(/, '导入先 dry-run');
    assert.equal(v2Code.includes('devices/'), false, 'v2 段不得出现 devices/** 路径');
    assert.equal(v2Code.includes('unlinkSync'), false, 'v2 段不得删除媒体或历史');
  });

  test('applyV2Import：媒体预检早于一切写入，失败即 typed 拒绝（零写入）', () => {
    const start = SERVICE.indexOf('function applyV2ImportOnce');
    assert.ok(start > 0, '找不到 applyV2ImportOnce');
    const apply = SERVICE.slice(start);
    const preflightAt = SERVICE.indexOf('checkV2MediaIntegrity(', start);
    const firstWrite = Math.min(
      SERVICE.indexOf('timelineWriteStore.append(', start),
      SERVICE.indexOf('timelineWriteStore.appendSummary(', start),
      SERVICE.indexOf('v2WriteBinary(', start)
    );
    assert.ok(preflightAt > 0 && firstWrite > 0 && preflightAt < firstWrite,
      '媒体预检必须发生在任何记录 / 汇总 / 媒体写入之前');
    assert.ok(apply.includes('if (!mediaCheck.ok)'), '预检失败必须直接 typed 拒绝');
    assert.ok(SERVICE.includes('V2_REFUSAL_MEDIA_CORRUPT'), '服务层必须能返回 E_MEDIA_CORRUPT');
    assert.ok(SERVICE.includes('V2_REFUSAL_MEDIA_COLLISION'), '服务层必须能返回 E_MEDIA_COLLISION');
    assert.equal(apply.includes('v2CopyBinary'), false, '导入不再二次读源字节（写入已校验字节）');
  });

  test('v1 落盘路径未被改：TRUNC 仍只有导出 1 处，v1 三函数仍在', () => {
    const truncCount = (SERVICE.match(/OpenMode\.TRUNC/g) ?? []).length;
    assert.equal(truncCount, 1, 'v1 契约：TRUNC 只允许新建导出文件那一处');
    for (const name of ['exportSchedules(', 'planImportFromText(', 'appendImportPlan(']) {
      assert.ok(SERVICE.includes(name), `v1 入口 ${name} 必须保留`);
    }
  });

  test('面板只在 useV2() 时渲染 v2 节，禁用按钮有中文原因，无裸 Text 点击', () => {
    assert.match(PANEL, /timelineStore\.useV2\(\)/, 'v2 节必须由 timelineStore.useV2() flag gate');
    assert.match(PANEL, /if \(this\.v2Visible\(\)\)/, 'build() 里必须有 flag 条件');
    assert.match(PANEL, /this\.V2Section\(\)/, 'v2 节必须挂到渲染树');
    assert.equal(PANEL.includes('V2_NOT_WIRED'), false, '四个 v2 回调已全部接线，不得残留「未接入」死路径');
    for (const cb of ['onV2Export', 'onV2Pick', 'onV2Apply', 'onV2Cancel']) {
      assert.ok(PANEL.includes(`${cb}:`), `${cb} 必须在面板声明`);
      assert.ok(SETTINGS.includes(`${cb}: (): void => {`), `${cb} 必须在设置页接线`);
    }
    assert.match(PANEL, /V2_BUSY/, '忙碌按钮必须给原因');
    assert.equal((PANEL.match(/^\s*@State\b/gm) ?? []).length, 5, '面板不得新增 @State（保持纯展示）');
  });
});
