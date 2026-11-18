// 导出 / 导入纯逻辑（`model/exportImport.ts`）的行为契约测试。
//
// 前置：先构建纯逻辑层（`node --test` 不负责编译）
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 这个文件钉的是 `docs/EXPORT-IMPORT.md` 里那些「改了就毁数据」的规则：
// - 导出是**只读派生**：空区间也要产出文件、字段原样保留、按 (date, ts) 升序；
// - 导入是 **append-only + 绝不覆盖**：同 id 更新的只统计成 conflict、更旧/相同的 skipped；
// - 非法输入一律 **fail-closed**：`ok:false` + 中文原因，或进 `invalid` 且不进 `toAppend`。
//
// `exportImport.ts` 运行期 import `./calendar` / `./jsonl`（无扩展名），Node 的 ESM 不做扩展名
// 推断，这里只为测试进程补 `.js` 后缀（与 remoteAccess.test.mjs / attachmentMerge.test.mjs 同一套写法）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  EMPTY_RANGE_TEXT,
  EXPORT_FORMAT_JSON,
  EXPORT_FORMAT_MARKDOWN,
  EXPORT_VERSION,
  NO_ATTACHMENT_TEXT,
  NO_IMPORTABLE_TEXT,
  UNTITLED_TEXT,
  applyPlan,
  buildJsonExport,
  canConfirmImport,
  clearDryRun,
  copyExportImportState,
  decodeUtf8,
  defaultExportImportState,
  dryRunSummary,
  exportFileName,
  exportFileStamp,
  exportRecordsInRange,
  groupImportByDate,
  importBlockedTip,
  importRecordProblem,
  isDryRunEmpty,
  normalizeExportFormat,
  parseDateRange,
  parseJsonImport,
  planImport,
  reconcileBeforeAppend,
  renderMarkdownExport,
  todayText,
  withExportPath,
  withImportFileName,
  withPanelMessage,
  writePlan
} = await import('../.build/model/exportImport.js');

// ---------------------------------------------------------------- 造数据

/** 一条合法记录（只覆盖关心的字段，其余给最小合法值）。 */
function rec(overrides = {}) {
  return {
    id: 'r1',
    ts: '2026-11-03T09:30:00+08:00',
    title: '写周报',
    body: '',
    author: '我',
    done: false,
    ai_processed: false,
    ...overrides
  };
}

/** 造一条 `id` 自增、日期递增的合法记录（批量/性能测试用）。 */
function bulk(index, extra = {}) {
  const day = String((index % 28) + 1).padStart(2, '0');
  const month = String(((index % 12) + 1)).padStart(2, '0');
  const hour = String(index % 24).padStart(2, '0');
  const minute = String(index % 60).padStart(2, '0');
  return rec({
    id: `bulk-${index}`,
    ts: `2026-${month}-${day}T${hour}:${minute}:00+08:00`,
    title: `第 ${index} 条`,
    ...extra
  });
}

const RANGE = { from: '2026-11-01', to: '2026-11-30' };

/** 取 Markdown 的正文行（去掉首尾空行）。 */
function mdLines(markdown) {
  return markdown.split('\n');
}

// ---------------------------------------------------------------- parseDateRange

describe('parseDateRange：真日历校验 + 首尾含', () => {
  test('合法区间：返回规范化后的两端，reason 为空串', () => {
    const range = parseDateRange('2026-11-01', '2026-11-30');
    assert.equal(range.ok, true);
    assert.equal(range.from, '2026-11-01');
    assert.equal(range.to, '2026-11-30');
    assert.equal(range.reason, '', '成功时 reason 必须是空串');
  });

  test('首尾同日合法（单日区间）；两端带空白会 trim', () => {
    const single = parseDateRange('2026-11-03', '2026-11-03');
    assert.equal(single.ok, true);
    assert.equal(single.from, '2026-11-03');
    assert.equal(single.to, '2026-11-03');
    const padded = parseDateRange('  2026-11-01 ', '\t2026-11-30  ');
    assert.equal(padded.ok, true);
    assert.equal(padded.from, '2026-11-01');
    assert.equal(padded.to, '2026-11-30');
  });

  test('from > to：失败并给「开始日期不能晚于结束日期」', () => {
    const range = parseDateRange('2026-11-30', '2026-11-01');
    assert.equal(range.ok, false);
    assert.equal(range.from, '', '失败时 from 必须是空串');
    assert.equal(range.to, '');
    assert.ok(range.reason.includes('开始日期不能晚于结束日期'), `实际原因：${range.reason}`);
    assert.ok(range.reason.includes('2026-11-30'), '原因里要带上具体两端，便于对照');
  });

  test('月份越界 2026-13-01：失败且说明「合法日期」', () => {
    const range = parseDateRange('2026-13-01', '2026-12-31');
    assert.equal(range.ok, false);
    assert.ok(range.reason.includes('合法日期'), `实际原因：${range.reason}`);
    assert.ok(range.reason.includes('开始日期'));
  });

  test('假日期 2026-02-30 / 平年 2026-02-29 拒绝，闰年 2028-02-29 接受', () => {
    assert.equal(parseDateRange('2026-02-30', '2026-03-01').ok, false, '2 月没有 30 号');
    assert.equal(parseDateRange('2026-02-29', '2026-03-01').ok, false, '2026 是平年');
    assert.equal(parseDateRange('2028-02-29', '2028-03-01').ok, true, '2028 是闰年');
  });

  test('格式不严格（2026-1-1 / 2026/11/01 / abc）都拒绝', () => {
    for (const bad of ['2026-1-1', '2026/11/01', 'abc', '20261101', '2026-11-01T00:00:00']) {
      const range = parseDateRange(bad, '2026-11-30');
      assert.equal(range.ok, false, `应拒绝：${bad}`);
      assert.ok(range.reason.length > 0, '失败必须给中文原因');
    }
  });

  test('空串 / 只有空白：给「请先填写…」，不抛异常', () => {
    const emptyFrom = parseDateRange('', '2026-11-30');
    assert.equal(emptyFrom.ok, false);
    assert.ok(emptyFrom.reason.includes('请先填写开始日期'));
    const emptyTo = parseDateRange('2026-11-01', '   ');
    assert.equal(emptyTo.ok, false);
    assert.ok(emptyTo.reason.includes('请先填写结束日期'));
    assert.equal(parseDateRange(undefined, undefined).ok, false, '非字符串也不抛');
  });
});

// ---------------------------------------------------------------- 面板空态的「填今天」

describe('todayText：面板空态的「填今天」必须落在本机当天', () => {
  test('给定时刻：输出 YYYY-MM-DD，且与 parseDateRange 认的格式一致', () => {
    const local = new Date(2026, 10, 3, 9, 30, 0); // 2026-11-03 09:30 本地时区
    assert.equal(todayText(local), '2026-11-03');
    const range = parseDateRange(todayText(local), todayText(local));
    assert.equal(range.ok, true, '「填今天」填出来的两端必须是合法区间（同日合法）');
    assert.equal(range.from, range.to);
  });

  test('月/日补零（个位数月份与日期也是两位）', () => {
    assert.equal(todayText(new Date(2027, 0, 5, 23, 59, 59)), '2027-01-05');
  });

  test('缺省入参：取当前时间，且形如 YYYY-MM-DD（不依赖时区文本）', () => {
    const text = todayText();
    assert.match(text, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(parseDateRange(text, text).ok, true);
  });
});

// ---------------------------------------------------------------- Markdown 导出

describe('renderMarkdownExport：空区间也必须产出文件', () => {
  test('空数据：只有标题行 + 占位行，且以换行结尾', () => {
    const markdown = renderMarkdownExport({ ...RANGE, records: [] });
    assert.equal(markdown, `# 日程导出 2026-11-01 ~ 2026-11-30\n${EMPTY_RANGE_TEXT}\n`);
    const lines = mdLines(markdown);
    assert.equal(lines[0], '# 日程导出 2026-11-01 ~ 2026-11-30', '首行是区间标题');
    assert.equal(lines[1], EMPTY_RANGE_TEXT, '第二行是占位文案');
    assert.equal(lines[2], '', '末尾恰好一个换行（split 后最后一个空串）');
    assert.equal(markdown.includes('## '), false, '空区间不该有日期小节');
  });

  test('区间外的记录不进文件（含首尾边界内才进）', () => {
    const markdown = renderMarkdownExport({
      from: '2026-11-02',
      to: '2026-11-03',
      records: [
        rec({ id: 'a', ts: '2026-11-01T10:00:00+08:00' }),
        rec({ id: 'b', ts: '2026-11-02T10:00:00+08:00' }),
        rec({ id: 'c', ts: '2026-11-03T23:59:00+08:00' }),
        rec({ id: 'd', ts: '2026-11-04T00:01:00+08:00' })
      ]
    });
    assert.ok(markdown.includes('## 2026-11-02'), '起始日当天要包含');
    assert.ok(markdown.includes('## 2026-11-03'), '结束日当天要包含');
    assert.equal(markdown.includes('2026-11-01'), false, '区间前一日的记录不能进来');
    assert.equal(markdown.includes('2026-11-04'), false, '区间后一日的记录不能进来');
    assert.equal(markdown.includes('`id=a`'), false);
    assert.equal(markdown.includes('`id=d`'), false);
  });
});

describe('renderMarkdownExport：每条记录的形态', () => {
  test('已完成 [x] / 未完成 [ ]、有 time 才写时间、日期带星期', () => {
    const markdown = renderMarkdownExport({
      ...RANGE,
      records: [
        rec({ id: 'abc123', ts: '2026-11-03T09:30:00+08:00', title: '写周报', done: false }),
        rec({ id: 'def456', ts: '2026-11-03T14:00:00+08:00', title: '体检', done: true }),
        rec({ id: 'ghi789', ts: '2026-11-03', title: '全天事项', done: false })
      ]
    });
    const lines = mdLines(markdown);
    assert.equal(lines[0], '# 日程导出 2026-11-01 ~ 2026-11-30');
    assert.equal(lines[1], '', '标题与首个日期小节之间留一个空行');
    assert.equal(lines[2], '## 2026-11-03（周二）', '日期小节带星期');
    assert.ok(markdown.includes('- [ ] 09:30 写周报　`id=abc123`'), `实际：${markdown}`);
    assert.ok(markdown.includes('- [x] 14:00 体检　`id=def456`'), '已完成用 [x]');
    assert.ok(markdown.includes('- [ ] 全天事项　`id=ghi789`'), 'ts 只有日期时不写时间');
    assert.equal(markdown.includes('（已完成）'), false, 'done 只由 [x] 表达，不重复写「（已完成）」');
  });

  test('日期升序、同日按 ts 升序（乱序输入也要排好）', () => {
    const markdown = renderMarkdownExport({
      ...RANGE,
      records: [
        rec({ id: 'd2', ts: '2026-11-05T08:00:00+08:00', title: '晚日期' }),
        rec({ id: 'd1b', ts: '2026-11-03T18:00:00+08:00', title: '下午' }),
        rec({ id: 'd1a', ts: '2026-11-03T07:05:00+08:00', title: '早上' }),
        rec({ id: 'd0', ts: '2026-11-02T12:00:00+08:00', title: '最早日期' })
      ]
    });
    const headings = markdown.split('\n').filter((line) => line.startsWith('## '));
    assert.deepEqual(headings, ['## 2026-11-02（周一）', '## 2026-11-03（周二）', '## 2026-11-05（周四）']);
    const order = ['最早日期', '早上', '下午', '晚日期'].map((title) => markdown.indexOf(title));
    assert.deepEqual([...order].sort((a, b) => a - b), order, '记录顺序必须是 日期升序 + 同日 ts 升序');
  });

  test('标题里的换行被压成空格；空标题给兜底文案', () => {
    const markdown = renderMarkdownExport({
      ...RANGE,
      records: [
        rec({ id: 'nl', title: '第一行\n第二行' }),
        rec({ id: 'empty', ts: '2026-11-04T09:00:00+08:00', title: '   ', done: false })
      ]
    });
    assert.ok(markdown.includes('- [ ] 09:30 第一行 第二行　`id=nl`'), '换行必须压平，否则一条记录会裂成两行');
    assert.ok(markdown.includes(`- [ ] 09:00 ${UNTITLED_TEXT}　\`id=empty\``), '空标题要有兜底');
    assert.equal(markdown.split('\n').some((line) => line === '第二行'), false);
  });

  test('非法日期/推不出日期的记录不会产出假的日期小节', () => {
    const markdown = renderMarkdownExport({
      ...RANGE,
      records: [rec({ id: 'bad', ts: 'not-a-date' }), rec({ id: 'ok', ts: '2026-11-06T09:00:00+08:00' })]
    });
    assert.equal(markdown.includes('not-a-date'), false);
    assert.equal(markdown.includes('`id=bad`'), false, '推不出日期的记录不能进区间导出');
    assert.ok(markdown.includes('## 2026-11-06（周五）'));
  });
});

describe('renderMarkdownExport：includeAttachments / includeMeta 开关', () => {
  const withAttachment = rec({
    id: 'att',
    ts: '2026-11-03T09:30:00+08:00',
    title: '手写笔记',
    attachments: [
      {
        sha256: 'a'.repeat(64),
        name: 'page-1.png',
        pageIndex: 0,
        archive: '2026-11-03.zip',
        entry: 'page-1-1a2b3c4d.jpg',
        bytes: 20480
      }
    ]
  });

  test('默认不带附件清单', () => {
    const markdown = renderMarkdownExport({ ...RANGE, records: [withAttachment] });
    assert.equal(markdown.includes('## 附件清单'), false);
    assert.equal(markdown.includes('page-1.png'), false);
  });

  test('includeAttachments=true：逐条列出 name / entry / 页 / bytes', () => {
    const markdown = renderMarkdownExport({ ...RANGE, records: [withAttachment], includeAttachments: true });
    assert.ok(markdown.includes('## 附件清单'), '必须有小节标题');
    assert.ok(markdown.includes('page-1.png'), '要有 name');
    assert.ok(markdown.includes('entry=page-1-1a2b3c4d.jpg'), '要有 entry');
    assert.ok(markdown.includes('第 1 页'), 'pageIndex 0 要显示成「第 1 页」');
    assert.ok(markdown.includes('bytes=20480'), '有 bytes 就写');
    assert.ok(markdown.includes('- 2026-11-03'), '附件行要带记录日期');
    assert.ok(markdown.indexOf('## 附件清单') > markdown.indexOf('## 2026-11-03'), '附件清单在文末');
  });

  test('includeAttachments=true 但没有附件：写「（无附件）」；空区间同样给占位', () => {
    const noAttachment = renderMarkdownExport({
      ...RANGE,
      records: [rec({ id: 'plain' })],
      includeAttachments: true
    });
    assert.ok(noAttachment.includes('## 附件清单'));
    assert.ok(noAttachment.includes(NO_ATTACHMENT_TEXT));
    const emptyRange = renderMarkdownExport({ ...RANGE, records: [], includeAttachments: true });
    assert.ok(emptyRange.includes(EMPTY_RANGE_TEXT));
    assert.ok(emptyRange.includes(NO_ATTACHMENT_TEXT), '空区间的附件清单也要有占位行');
  });

  test('includeMeta=false 默认没有元信息行', () => {
    const markdown = renderMarkdownExport({ ...RANGE, records: [rec({ tags: ['会议'], device: 'pc-a' })] });
    assert.equal(markdown.includes('  > '), false);
    assert.equal(markdown.includes('tags='), false);
  });

  test('includeMeta=true：tags / author / 来源设备 各就各位，缺字段不写', () => {
    const markdown = renderMarkdownExport({
      ...RANGE,
      records: [
        rec({
          id: 'meta',
          tags: ['会议', '重要'],
          author: '我',
          device: 'pc-a',
          ts: '2026-11-03T09:30:00+08:00'
        }),
        rec({
          id: 'string-tags',
          ts: '2026-11-04T09:30:00+08:00',
          title: '只有标签',
          tags: '随手记',
          author: '',
          sourceDevice: 'pad-b'
        }),
        rec({ id: 'bare', ts: '2026-11-05T09:30:00+08:00', title: '什么都没有', author: '' })
      ],
      includeMeta: true
    });
    const lines = mdLines(markdown);
    assert.ok(lines.includes('  > tags=会议,重要 · author=我 · 来源设备=pc-a'), `实际：${JSON.stringify(lines)}`);
    assert.ok(lines.includes('  > tags=随手记 · 来源设备=pad-b'), '字符串 tags + sourceDevice 也要认');
    assert.equal(lines.filter((line) => line.startsWith('  > ')).length, 2, '三个字段都没有就不写元信息行');
  });
});

// ---------------------------------------------------------------- JSON 导出

describe('buildJsonExport：字段原样保留、可被导入原样吃回', () => {
  test('顶层结构：version/exportedAt/range/deviceId/records', () => {
    const doc = JSON.parse(
      buildJsonExport({
        ...RANGE,
        deviceId: 'pad-a',
        exportedAt: '2026-11-18T00:00:00.000Z',
        records: [rec({ id: 'a' })]
      })
    );
    assert.equal(doc.version, EXPORT_VERSION);
    assert.equal(doc.version, 1);
    assert.equal(doc.exportedAt, '2026-11-18T00:00:00.000Z', '导出时刻原样写入');
    assert.deepEqual(doc.range, { from: '2026-11-01', to: '2026-11-30' });
    assert.equal(doc.deviceId, 'pad-a');
    assert.equal(doc.records.length, 1);
    assert.deepEqual(Object.keys(doc), ['version', 'exportedAt', 'range', 'deviceId', 'records'], '键顺序固定');
  });

  test('空区间：records 是空数组，文件仍完整', () => {
    const text = buildJsonExport({ ...RANGE, deviceId: 'pad-a', records: [], exportedAt: '2026-11-18T00:00:00.000Z' });
    const doc = JSON.parse(text);
    assert.deepEqual(doc.records, []);
    assert.equal(text.endsWith('\n'), true, '末尾一个换行');
    assert.equal(Array.isArray(doc.records), true, '必须是数组而不是 null');
  });

  test('records 按 (date, ts) 升序，且字段原样保留（不裁剪、不改名、不补默认值）', () => {
    const first = rec({ id: 'b', ts: '2026-11-03T18:00:00+08:00', title: '下午' });
    const second = rec({ id: 'a', ts: '2026-11-03T07:05:00+08:00', title: '早上', ocr_text: '原文' });
    const third = rec({ id: 'c', ts: '2026-11-04T09:00:00+08:00', title: '次日', tags: ['x'] });
    const doc = JSON.parse(
      buildJsonExport({
        ...RANGE,
        deviceId: 'pad-a',
        exportedAt: '2026-11-18T00:00:00.000Z',
        records: [first, second, third]
      })
    );
    assert.deepEqual(
      doc.records.map((item) => item.id),
      ['a', 'b', 'c'],
      '先按日期、再按 ts'
    );
    assert.deepEqual(doc.records[0], second, '记录对象逐字段原样保留');
    assert.deepEqual(doc.records[2], third, '未知扩展字段（tags）也要保留');
    assert.equal('date' in doc.records[0], false, '不能凭空补出 date 字段');
    assert.equal(doc.records[1].title, '下午', '不改名');
  });

  test('区间外的记录被过滤；非法区间 / 空 deviceId 抛中文错误', () => {
    const doc = JSON.parse(
      buildJsonExport({
        from: '2026-11-03',
        to: '2026-11-03',
        deviceId: 'pad-a',
        exportedAt: '2026-11-18T00:00:00.000Z',
        records: [rec({ id: 'in' }), rec({ id: 'out', ts: '2026-11-04T09:00:00+08:00' })]
      })
    );
    assert.deepEqual(
      doc.records.map((item) => item.id),
      ['in']
    );
    assert.throws(() => buildJsonExport({ from: '2026-11-30', to: '2026-11-01', deviceId: 'pad-a', records: [] }), /导出区间非法/);
    assert.throws(() => buildJsonExport({ ...RANGE, deviceId: '  ', records: [] }), /deviceId 不能为空/);
  });

  test('导出 → 导入：records 原样回来（round-trip）', () => {
    const records = [
      rec({ id: 'rt1', ts: '2026-11-03T09:30:00+08:00', title: '周报', done: true }),
      rec({
        id: 'rt2',
        ts: '2026-11-04T10:00:00+08:00',
        title: '带附件',
        attachments: [{ sha256: 'b'.repeat(64), name: 'p.png', pageIndex: 1 }]
      })
    ];
    const text = buildJsonExport({ ...RANGE, deviceId: 'pad-a', records, exportedAt: '2026-11-18T00:00:00.000Z' });
    const parsed = parseJsonImport(text);
    assert.equal(parsed.ok, true, parsed.reason);
    assert.deepEqual(parsed.records, records, '导出再导入必须逐字段相同');
    assert.equal(parsed.deviceId, 'pad-a');
    assert.equal(parsed.from, '2026-11-01');
    assert.equal(parsed.to, '2026-11-30');
    const plan = planImport({ existing: [], incoming: parsed.records, now: '2026-11-18T00:00:00Z' });
    assert.equal(plan.added, 2);
    assert.equal(plan.invalid, 0);
    assert.equal(plan.toAppend.length, 2);
  });
});

// ---------------------------------------------------------------- parseJsonImport

describe('parseJsonImport：fail-closed（一个字节都不写）', () => {
  test('空串 / 纯空白都拒绝，原因中文', () => {
    for (const text of ['', '   ', '\n\t ']) {
      const parsed = parseJsonImport(text);
      assert.equal(parsed.ok, false, `应拒绝：${JSON.stringify(text)}`);
      assert.deepEqual(parsed.records, [], '失败时 records 必须为空数组');
      assert.ok(parsed.reason.includes('空'), `原因应说明是空文件：${parsed.reason}`);
    }
  });

  test('半截 JSON / 非 JSON 文本拒绝，原因含「不是合法的 JSON」', () => {
    for (const text of ['{"version":1,"records":[', 'not json', '{oops}', '{"a":1,}']) {
      const parsed = parseJsonImport(text);
      assert.equal(parsed.ok, false, `应拒绝：${text}`);
      assert.ok(parsed.reason.includes('不是合法的 JSON'), `实际原因：${parsed.reason}`);
      assert.deepEqual(parsed.records, []);
    }
  });

  test('顶层是数组 / null / 标量都拒绝', () => {
    for (const text of ['[]', '[{"id":"a"}]', 'null', '"str"', '42', 'true']) {
      const parsed = parseJsonImport(text);
      assert.equal(parsed.ok, false, `应拒绝：${text}`);
      assert.ok(parsed.reason.length > 0);
    }
    assert.ok(parseJsonImport('[]').reason.includes('顶层必须是 JSON 对象'));
  });

  test('缺 version / version=99 / 缺 records / records 不是数组 都拒绝', () => {
    const missingVersion = parseJsonImport('{"records":[]}');
    assert.equal(missingVersion.ok, false);
    assert.ok(missingVersion.reason.includes('version'), `实际原因：${missingVersion.reason}`);

    const badVersion = parseJsonImport('{"version":99,"records":[]}');
    assert.equal(badVersion.ok, false);
    assert.ok(badVersion.reason.includes('不认识的版本号'), `实际原因：${badVersion.reason}`);
    assert.ok(badVersion.reason.includes('99'), '原因里要带实际版本号');

    const noRecords = parseJsonImport('{"version":1}');
    assert.equal(noRecords.ok, false);
    assert.ok(noRecords.reason.includes('records'), `实际原因：${noRecords.reason}`);

    const badRecords = parseJsonImport('{"version":1,"records":{}}');
    assert.equal(badRecords.ok, false);
    assert.ok(badRecords.reason.includes('records'));

    assert.equal(parseJsonImport('{"version":"1","records":[]}').ok, false, '字符串版本不算数');
  });

  test('合法文件：接受 records:[]，并回填 range/deviceId/exportedAt（缺则空串）', () => {
    const minimal = parseJsonImport('{"version":1,"records":[]}');
    assert.equal(minimal.ok, true);
    assert.deepEqual(minimal.records, []);
    assert.equal(minimal.reason, '');
    assert.equal(minimal.from, '', '没有 range 时回填空串，不猜');
    assert.equal(minimal.deviceId, '');
    assert.equal(minimal.exportedAt, '');

    const full = parseJsonImport(
      '{"version":1,"exportedAt":"2026-11-18T00:00:00Z","range":{"from":"2026-11-01","to":"2026-11-02"},"deviceId":"pc-a","records":[]}'
    );
    assert.equal(full.ok, true);
    assert.equal(full.exportedAt, '2026-11-18T00:00:00Z');
    assert.equal(full.from, '2026-11-01');
    assert.equal(full.to, '2026-11-02');
    assert.equal(full.deviceId, 'pc-a');
  });

  test('带 BOM 的文件也能读（用户从电脑上导出的 JSON 常带 BOM）', () => {
    const parsed = parseJsonImport('\ufeff{"version":1,"records":[]}');
    assert.equal(parsed.ok, true, parsed.reason);
  });
});

// ---------------------------------------------------------------- planImport 归属

describe('planImport：added / skipped / conflict / invalid 的归属', () => {
  test('新 id → added，进 toAppend；toAppend 保持 incoming 顺序', () => {
    const incoming = [
      rec({ id: 'n1', ts: '2026-11-03T09:00:00+08:00' }),
      rec({ id: 'n2', ts: '2026-11-03T10:00:00+08:00' }),
      rec({ id: 'n3', ts: '2026-11-03T11:00:00+08:00' })
    ];
    const plan = planImport({ existing: [], incoming, now: '2026-11-18T00:00:00Z' });
    assert.equal(plan.added, 3);
    assert.equal(plan.skipped, 0);
    assert.equal(plan.conflict, 0);
    assert.equal(plan.invalid, 0);
    assert.deepEqual(
      plan.toAppend.map((item) => item.id),
      ['n1', 'n2', 'n3'],
      'toAppend 必须保序（服务层再按日期分组排序）'
    );
    assert.equal(plan.plannedAt, '2026-11-18T00:00:00Z');
  });

  test('同 id 且 incoming 更新 → conflict（不覆盖、不进 toAppend）', () => {
    const existing = [rec({ id: 'same', ts: '2026-11-03T10:00:00+08:00', title: '本机版本' })];
    const incoming = [rec({ id: 'same', ts: '2026-11-03T11:00:00+08:00', title: '导入版本' })];
    const plan = planImport({ existing, incoming });
    assert.equal(plan.conflict, 1);
    assert.equal(plan.added, 0);
    assert.equal(plan.skipped, 0);
    assert.deepEqual(plan.toAppend, [], '冲突记录绝不能进 toAppend（否则就是覆盖）');
    assert.equal(plan.conflictItems.length, 1);
    assert.equal(plan.conflictItems[0].id, 'same');
    assert.equal(plan.conflictItems[0].index, 0);
    assert.equal(plan.conflictItems[0].incomingTs, '2026-11-03T11:00:00+08:00');
    assert.equal(plan.conflictItems[0].existingTs, '2026-11-03T10:00:00+08:00');
  });

  test('同 id 且 incoming 更旧 → skipped', () => {
    const existing = [rec({ id: 'same', ts: '2026-11-03T10:00:00+08:00' })];
    const incoming = [rec({ id: 'same', ts: '2026-11-03T09:00:00+08:00' })];
    const plan = planImport({ existing, incoming });
    assert.equal(plan.skipped, 1);
    assert.equal(plan.added, 0);
    assert.equal(plan.conflict, 0);
    assert.deepEqual(plan.toAppend, []);
  });

  test('同 id 且 ts 相同 → skipped（幂等：重复导入同一份文件不产生新行）', () => {
    const existing = [rec({ id: 'same', ts: '2026-11-03T10:00:00+08:00' })];
    const incoming = [rec({ id: 'same', ts: '2026-11-03T10:00:00+08:00' })];
    const plan = planImport({ existing, incoming });
    assert.equal(plan.skipped, 1, '相同 ts 不算更新');
    assert.equal(plan.conflict, 0);
    assert.equal(plan.added, 0);
  });

  test('existing 里同 id 有多条历史行时，比较基准取最新 ts', () => {
    const existing = [
      rec({ id: 'hist', ts: '2026-11-03T08:00:00+08:00' }),
      rec({ id: 'hist', ts: '2026-11-03T12:00:00+08:00' }),
      rec({ id: 'hist', ts: '2026-11-03T10:00:00+08:00' })
    ];
    const older = planImport({ existing, incoming: [rec({ id: 'hist', ts: '2026-11-03T11:00:00+08:00' })] });
    assert.equal(older.skipped, 1, '11:00 比最新的 12:00 更旧 → skipped');
    assert.equal(older.conflict, 0);

    const newer = planImport({ existing, incoming: [rec({ id: 'hist', ts: '2026-11-03T13:00:00+08:00' })] });
    assert.equal(newer.conflict, 1, '13:00 比 12:00 新 → conflict');
    assert.equal(newer.conflictItems[0].existingTs, '2026-11-03T12:00:00+08:00');
  });

  test('一批 4 条混合：新 id + 更旧 + 更新 + 相同 各归各位', () => {
    const existing = [
      rec({ id: 'old', ts: '2026-11-03T10:00:00+08:00' }),
      rec({ id: 'equal', ts: '2026-11-03T10:00:00+08:00' })
    ];
    const incoming = [
      rec({ id: 'fresh', ts: '2026-11-05T09:00:00+08:00' }),
      rec({ id: 'old', ts: '2026-11-03T09:00:00+08:00' }),
      rec({ id: 'old', ts: '2026-11-03T11:00:00+08:00' }),
      rec({ id: 'equal', ts: '2026-11-03T10:00:00+08:00' })
    ];
    const plan = planImport({ existing, incoming });
    assert.equal(plan.added, 1);
    assert.equal(plan.skipped, 2);
    assert.equal(plan.conflict, 1);
    assert.equal(plan.invalid, 0);
    assert.deepEqual(
      plan.toAppend.map((item) => item.id),
      ['fresh']
    );
  });

  test('同一批里重复的新 id：先到的 added，后到更新的算 conflict、更旧的算 skipped', () => {
    const newerLater = planImport({
      existing: [],
      incoming: [
        rec({ id: 'dup', ts: '2026-11-03T09:00:00+08:00' }),
        rec({ id: 'dup', ts: '2026-11-03T10:00:00+08:00' })
      ]
    });
    assert.equal(newerLater.added, 1);
    assert.equal(newerLater.conflict, 1);
    assert.equal(newerLater.toAppend.length, 1, '同 id 在同一批里只能追加一次');
    assert.equal(newerLater.toAppend[0].ts, '2026-11-03T09:00:00+08:00');

    const olderLater = planImport({
      existing: [],
      incoming: [
        rec({ id: 'dup', ts: '2026-11-03T10:00:00+08:00' }),
        rec({ id: 'dup', ts: '2026-11-03T09:00:00+08:00' })
      ]
    });
    assert.equal(olderLater.added, 1);
    assert.equal(olderLater.skipped, 1);
    assert.equal(olderLater.conflict, 0);
  });

  test('非数组输入按空处理（不抛）', () => {
    const plan = planImport({ existing: undefined, incoming: null });
    assert.equal(plan.added, 0);
    assert.equal(plan.skipped, 0);
    assert.equal(plan.invalid, 0);
    assert.equal(plan.plannedAt.length > 0, true, '缺省 now 也要给一个时刻');
  });
});

// ---------------------------------------------------------------- planImport 非法字段

describe('planImport：非法字段进 invalid，且绝不进 toAppend', () => {
  const cases = [
    ['缺 id', { id: undefined }],
    ['id 是空串', { id: '   ' }],
    ['date 是假日期', { date: '2026-02-30' }],
    ['date 格式不对', { date: '2026/11/03' }],
    ['title 是数字', { title: 42 }],
    ['ts 不是日期', { ts: 'not-a-date' }],
    ['ts 里是假日期', { ts: '2026-02-30T09:00:00+08:00' }],
    ['body 缺失', { body: undefined }],
    ['done 不是布尔', { done: 'yes' }]
  ];

  test('九类非法字段逐条进 invalid（带 index + 原因），一条都不进 toAppend', () => {
    const incoming = [];
    for (const [, overrides] of cases) {
      incoming.push(rec({ id: `bad-${incoming.length}`, ...overrides }));
    }
    const plan = planImport({ existing: [], incoming });
    assert.equal(plan.invalid, cases.length, '每条非法记录都要计入 invalid');
    assert.equal(plan.added, 0);
    assert.deepEqual(plan.toAppend, [], '非法记录一条都不能进 toAppend');
    assert.equal(plan.invalidItems.length, cases.length);
    for (let index = 0; index < plan.invalidItems.length; index++) {
      assert.equal(plan.invalidItems[index].index, index, 'index 必须指向 incoming 的下标');
      assert.equal(plan.invalidItems[index].reason.length > 0, true, '每条都要给中文原因');
    }
  });

  test('非法记录不影响同批合法记录（合法照常 added）', () => {
    const plan = planImport({
      existing: [],
      incoming: [
        rec({ id: 'ok-1', ts: '2026-11-03T09:00:00+08:00' }),
        rec({ id: 'bad', date: '2026-02-30' }),
        rec({ id: 'ok-2', ts: '2026-11-04T09:00:00+08:00' })
      ]
    });
    assert.equal(plan.added, 2);
    assert.equal(plan.invalid, 1);
    assert.deepEqual(
      plan.toAppend.map((item) => item.id),
      ['ok-1', 'ok-2']
    );
    assert.equal(plan.invalidItems[0].index, 1);
  });

  test('非对象记录（字符串 / 数组 / null）也算非法', () => {
    const plan = planImport({ existing: [], incoming: ['hello', ['a'], null] });
    assert.equal(plan.invalid, 3);
    assert.equal(plan.added, 0);
    for (const item of plan.invalidItems) {
      assert.ok(item.reason.includes('JSON 对象'), `实际原因：${item.reason}`);
    }
  });

  test('importRecordProblem：合法记录返回空串，缺 id / 假日期 / 非字符串 title 给中文原因', () => {
    assert.equal(importRecordProblem(rec({})), '', '合法记录不该有原因');
    assert.ok(importRecordProblem(rec({ id: '' })).includes('id'), '缺 id 的原因要点名 id');
    assert.ok(importRecordProblem(rec({ title: 42 })).includes('title'));
    assert.ok(importRecordProblem(rec({ date: '2026-02-30' })).includes('date'));
    assert.ok(importRecordProblem(rec({ ts: '2026-02-30T09:00:00+08:00' })).includes('ts'));
    assert.ok(importRecordProblem(null).length > 0);
  });
});

// ---------------------------------------------------------------- 性能 / 规模

describe('planImport：5000 条输入在合理时间内返回', () => {
  test('5000 条全新记录：< 2000ms、toAppend 保序、不丢条', () => {
    const incoming = [];
    for (let index = 0; index < 5000; index++) {
      incoming.push(bulk(index));
    }
    const startedAt = Date.now();
    const plan = planImport({ existing: [], incoming, now: '2026-11-18T00:00:00Z' });
    const elapsed = Date.now() - startedAt;
    assert.equal(plan.added, 5000);
    assert.equal(plan.invalid, 0);
    assert.equal(plan.toAppend.length, 5000);
    assert.equal(plan.toAppend[0].id, 'bulk-0');
    assert.equal(plan.toAppend[2500].id, 'bulk-2500', 'toAppend 必须保序（不是按日期重排）');
    assert.equal(plan.toAppend[4999].id, 'bulk-4999');
    assert.ok(elapsed < 2000, `5000 条 planImport 耗时 ${elapsed}ms，应 < 2000ms`);
  });

  test('5000 条全部与已有记录冲突：仍然快速返回且不产生 toAppend', () => {
    const incoming = [];
    const existing = [];
    for (let index = 0; index < 5000; index++) {
      const newer = bulk(index);
      existing.push(bulk(index));
      incoming.push(rec({ id: newer.id, ts: newer.ts.replace(':00+08:00', ':59+08:00') }));
    }
    const startedAt = Date.now();
    const plan = planImport({ existing, incoming });
    const elapsed = Date.now() - startedAt;
    assert.equal(plan.conflict, 5000);
    assert.equal(plan.added, 0);
    assert.equal(plan.conflictItems.length, 5000);
    assert.ok(elapsed < 2000, `5000 条 conflict 耗时 ${elapsed}ms，应 < 2000ms`);
  });
});

// ---------------------------------------------------------------- 文件名 / 时间戳

describe('exportFileStamp / exportFileName：时间戳来自记录，不用随机数', () => {
  test('取记录里最新 ts 的日期+时刻（不做本机时区换算）', () => {
    const stamp = exportFileStamp({
      records: [
        rec({ id: 'a', ts: '2026-11-03T09:30:00+08:00' }),
        rec({ id: 'b', ts: '2026-11-15T23:05:00+08:00' }),
        rec({ id: 'c', ts: '2026-11-10T10:00:00+08:00' })
      ],
      now: '2026-11-18T07:44:00+08:00'
    });
    assert.equal(stamp, '20261115-2305', '取最新一条记录的时间，而不是当前时间');
  });

  test('没有可用记录 ts 时退回 now；都推不出时返回空串', () => {
    assert.equal(exportFileStamp({ records: [], now: '2026-11-18T07:44:00+08:00' }), '20261118-0744');
    assert.equal(exportFileStamp({ records: [rec({ ts: 'bad' })], now: '2026-11-18T07:44:00+08:00' }), '20261118-0744');
    assert.equal(exportFileStamp({ records: [], now: 'bad' }), '');
  });

  test('文件名固定前缀与后缀；格式未知按 markdown；空时间戳用零值占位', () => {
    assert.equal(exportFileName(EXPORT_FORMAT_MARKDOWN, '20261115-2305'), 'schedule-20261115-2305.md');
    assert.equal(exportFileName(EXPORT_FORMAT_JSON, '20261115-2305'), 'schedule-20261115-2305.json');
    assert.equal(exportFileName('nope', '20261115-2305'), 'schedule-20261115-2305.md');
    assert.equal(exportFileName(EXPORT_FORMAT_JSON, ''), 'schedule-00000000-0000.json');
    assert.equal(normalizeExportFormat('json'), 'json');
    assert.equal(normalizeExportFormat(undefined), 'markdown');
  });
});

// ---------------------------------------------------------------- UTF-8 解码

describe('decodeUtf8：给「用户选的文件」做字节→文本（不依赖 SDK）', () => {
  test('ASCII / 中文 / emoji / 混合', () => {
    assert.equal(decodeUtf8(new Uint8Array([0x61, 0x62, 0x63])), 'abc');
    assert.equal(decodeUtf8(new TextEncoder().encode('日程导出')), '日程导出');
    assert.equal(decodeUtf8(new TextEncoder().encode('完成 ✅')), '完成 ✅');
    assert.equal(decodeUtf8(new TextEncoder().encode('a日程✅z')), 'a日程✅z');
  });

  test('剥掉 UTF-8 BOM；空输入返回空串', () => {
    assert.equal(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'a');
    assert.equal(decodeUtf8(new Uint8Array([])), '');
    assert.equal(decodeUtf8(null), '');
  });

  test('非法字节 / 截断序列 → U+FFFD（不抛），随后会被 JSON 解析拦住', () => {
    assert.equal(decodeUtf8(new Uint8Array([0x80])), '\ufffd');
    assert.equal(decodeUtf8(new Uint8Array([0xe6, 0x97])), '\ufffd\ufffd', '三字节序列被截断');
    assert.equal(decodeUtf8(new Uint8Array([0xff, 0xff])), '\ufffd\ufffd');
  });
});

// ---------------------------------------------------------------- 面板状态助手

describe('面板状态助手：dry-run 文案与「确认导入」可用条件', () => {
  test('默认状态：区间空、格式 markdown、两个开关关、没有结果、不忙', () => {
    const state = defaultExportImportState();
    assert.equal(state.fromText, '');
    assert.equal(state.toText, '');
    assert.equal(state.format, EXPORT_FORMAT_MARKDOWN);
    assert.equal(state.includeAttachments, false);
    assert.equal(state.includeMeta, false);
    assert.equal(state.dryRunReady, false);
    assert.equal(state.busy, false);
    assert.equal(state.message, '');
    assert.equal(state.exportPath, '');
  });

  test('dryRunSummary 逐字覆盖四类计数', () => {
    const state = { ...defaultExportImportState(), dryRunAdded: 3, dryRunSkipped: 1, dryRunConflict: 2, dryRunInvalid: 0 };
    assert.equal(
      dryRunSummary(state),
      '将新增 3 条 / 跳过 1 条（同 id 且更旧） / 冲突 2 条（同 id 且更新，不会覆盖） / 非法 0 条'
    );
    assert.equal(isDryRunEmpty({ ...defaultExportImportState(), dryRunReady: true }), true, '四类全 0 就是「没有可导入的记录」');
    assert.equal(isDryRunEmpty({ ...state, dryRunReady: true }), false);
  });

  test('canConfirmImport：必须 dry-run 过、有新增、且非法为 0、且不忙', () => {
    const base = { ...defaultExportImportState(), dryRunReady: true, dryRunAdded: 2 };
    assert.equal(canConfirmImport(base), true);
    assert.equal(canConfirmImport({ ...base, dryRunReady: false }), false, '没 dry-run 不能点');
    assert.equal(canConfirmImport({ ...base, dryRunAdded: 0 }), false, '没有可新增的记录不能点');
    assert.equal(canConfirmImport({ ...base, dryRunInvalid: 1 }), false, '有非法条目必须 fail-closed');
    assert.equal(canConfirmImport({ ...base, busy: true }), false, '导出/导入进行中不能点');
  });

  test('importBlockedTip：非法优先提示「先修正文件」，其次「没有可导入的记录」', () => {
    assert.equal(importBlockedTip(defaultExportImportState()), '', '还没 dry-run 时不提示');
    const blocked = importBlockedTip({ ...defaultExportImportState(), dryRunReady: true, dryRunInvalid: 2, dryRunAdded: 3 });
    assert.ok(blocked.includes('先修正文件'), `实际：${blocked}`);
    assert.ok(blocked.includes('2'), '提示里要带非法条数');
    assert.equal(importBlockedTip({ ...defaultExportImportState(), dryRunReady: true }), NO_IMPORTABLE_TEXT);
    assert.equal(importBlockedTip({ ...defaultExportImportState(), dryRunReady: true, dryRunAdded: 1 }), '');
  });

  test('applyPlan / withPanelMessage / withExportPath / clearDryRun 都返回新对象（不改入参）', () => {
    const state = defaultExportImportState();
    const plan = planImport({ existing: [], incoming: [rec({ id: 'x' })], now: '2026-11-18T00:00:00Z' });
    const planned = applyPlan(state, plan);
    assert.equal(planned.dryRunReady, true);
    assert.equal(planned.dryRunAdded, 1);
    assert.equal(state.dryRunReady, false, '原状态不能被改动');
    assert.equal(planned.dryRunInvalid, 0);

    const messaged = withPanelMessage(planned, '导出成功', false);
    assert.equal(messaged.message, '导出成功');
    assert.equal(planned.message, '', '原状态不能被改动');

    const pathed = withExportPath(messaged, '/data/exports/schedule-1.md');
    assert.equal(pathed.exportPath, '/data/exports/schedule-1.md');
    assert.equal(messaged.exportPath, '');

    const named = withImportFileName(pathed, 'schedule-20261115-2305.json');
    assert.equal(named.importFileName, 'schedule-20261115-2305.json');
    assert.equal(pathed.importFileName, '', '原状态不能被改动');
    assert.equal(withImportFileName(named, '').importFileName, '', '空串 = 清空已选文件名');

    const cleared = clearDryRun(pathed);
    assert.equal(cleared.dryRunReady, false);
    assert.equal(cleared.dryRunAdded, 0);
    assert.equal(cleared.importFileName, '');
    assert.equal(pathed.dryRunAdded, 1, 'clearDryRun 也不能改入参');

    const copy = copyExportImportState(state);
    assert.deepEqual(copy, state);
    assert.notEqual(copy, state, 'copy 必须是新对象');
  });
});

// ---------------------------------------------------------------- 导出选记录

describe('exportRecordsInRange：只读选行，不改入参', () => {
  test('排序返回新数组，入参顺序不变', () => {
    const late = rec({ id: 'late', ts: '2026-11-05T09:00:00+08:00' });
    const early = rec({ id: 'early', ts: '2026-11-02T09:00:00+08:00' });
    const input = [late, early];
    const picked = exportRecordsInRange(input, '2026-11-01', '2026-11-30');
    assert.deepEqual(
      picked.map((item) => item.id),
      ['early', 'late']
    );
    assert.deepEqual(
      input.map((item) => item.id),
      ['late', 'early'],
      '导出是只读派生：入参数组顺序不能被改'
    );
    assert.notEqual(picked, input, '返回的是新数组');
  });

  test('非数组输入返回空数组；非法日期记录被排除', () => {
    assert.deepEqual(exportRecordsInRange(undefined, '2026-11-01', '2026-11-30'), []);
    assert.deepEqual(exportRecordsInRange([rec({ ts: '' })], '2026-11-01', '2026-11-30'), []);
    assert.deepEqual(exportRecordsInRange([rec({ ts: '2026-02-30T09:00:00+08:00' })], '2026-02-01', '2026-03-01'), []);
  });
});
// ---------------------------------------------------------------- 导入落盘契约（fake IO）+ 写前复核
//
// 这一段补的是评审 M2 / M6：唯一碰盘的两处（`appendImportPlan` / `writePlan`）此前零测试。
// `services/exportService.ets` 跑不进 `node --test`，因此落盘的纯实现被抽到
// `model/exportImport.ts` 的 `writePlan(records, io)`，这里用**假 store + 假写入器**注入：
// - 假写入器复刻 `appendTextAtEnd` 的追加语义（上一行没换行才补 `\n`，然后写正文）；
// - 它**没有任何截断/覆盖能力**，`writePlan` 一旦伸手去够别的能力就当场炸（Proxy 看门）。
// 另用源码级断言钉住 `.ets` 侧的复核顺序、并发闸与「追加路径没有 TRUNC」。

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVICE_SOURCE = readFileSync(
  join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'services', 'exportService.ets'),
  'utf8'
).replace(/\r\n/g, '\n');

/** 本机某天 JSONL 的假路径。 */
const DAY_PATH = (date) => `/fake/filesDir/git-repo/devices/pad-a/schedules/${date}.jsonl`;

/**
 * 假 store + 假写入器。
 *
 * @param {object} [options]
 * @param {Record<string,string>} [options.seeds] 预置文件内容（path → 文本），模拟历史行
 * @param {string|null} [options.failOnDate] 该日期的追加抛错（模拟「第 2 个日期写失败」）
 */
function fakeIo(options = {}) {
  const seeds = options.seeds ?? {};
  const failOnDate = options.failOnDate ?? null;
  const files = new Map(Object.entries(seeds));
  const appends = [];
  const applied = [];
  const calls = { ensureDirs: 0, applyRecord: 0 };
  const io = {
    ensureDirs() {
      calls.ensureDirs += 1;
    },
    dayFilePath(date) {
      return DAY_PATH(date);
    },
    appendTextAtEnd(path, text) {
      if (failOnDate !== null && path === DAY_PATH(failOnDate)) {
        throw new Error(`模拟写盘失败（${path}）`);
      }
      const before = files.get(path) ?? '';
      const needsNewline = before.length > 0 && !before.endsWith('\n');
      const after = `${before}${needsNewline ? '\n' : ''}${text}`;
      files.set(path, after);
      appends.push({ path, text, before, after, needsNewline });
    },
    applyRecord(record) {
      calls.applyRecord += 1;
      applied.push(record);
    }
  };
  return { io, files, appends, applied, calls };
}

/** 把 IO 包成「只允许读写已声明的四个能力」的看门对象（够到别的成员立刻抛）。 */
function watchedIo(io) {
  return new Proxy(io, {
    get(target, key) {
      if (typeof key === 'string' && !(key in target)) {
        throw new Error(`writePlan 试图使用未声明的 IO 能力：${key}（导入只允许追加）`);
      }
      return target[key];
    }
  });
}

/** 取 `source` 里某个顶层函数的方法体（本仓库顶层函数以行首 `}` 结束）。 */
function topLevelFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `exportService.ets 里找不到 ${signature}`);
  const open = source.indexOf('{', start);
  const end = source.indexOf('\n}\n', open);
  assert.ok(open >= 0 && end > open, `${signature} 的方法体边界没找到`);
  return source.slice(open, end + 2);
}

describe('writePlan：只追加、同一天一次、半批如实报告、历史行逐字节不变', () => {
  test('① 只用「追加」这一个写入口：IO 面上没有截断能力，历史行逐字节原样保留', () => {
    const historyLine1 = '{"id":"h1","ts":"2026-11-03T08:00:00+08:00","title":"旧行"}\n';
    // 末尾故意不带换行：追加方必须自己补一个，且不能改动这两个字节之外的任何东西
    const history = `${historyLine1}{"id":"h2","ts":"2026-11-03T08:30:00+08:00","title":"旧行2"}`;
    const { io, files, appends } = fakeIo({ seeds: { [DAY_PATH('2026-11-03')]: history } });

    assert.deepEqual(
      Object.keys(io).sort(),
      ['appendTextAtEnd', 'applyRecord', 'dayFilePath', 'ensureDirs'],
      'IO 契约只能有这四个能力：没有 writeTextFile / truncate / remove'
    );

    const plan = planImport({
      existing: [],
      incoming: [rec({ id: 'n1', ts: '2026-11-03T09:00:00+08:00', title: '新行' })],
      now: '2026-11-18T00:00:00Z'
    });
    const written = writePlan(plan.toAppend, watchedIo(io));
    assert.equal(written.ok, true);
    assert.equal(appends.length, 1, '一条记录 = 一次物理追加');
    assert.equal(appends[0].before, history, '追加前的内容必须与历史行逐字节相同');
    assert.equal(appends[0].needsNewline, true, '历史行末尾没换行时必须补一个 \\n');
    const after = files.get(DAY_PATH('2026-11-03'));
    assert.ok(after.startsWith(history), '历史行必须是结果的前缀（没有被重写/截断）');
    assert.equal(after, `${history}\n${appends[0].text}`);
    assert.ok(!Object.prototype.hasOwnProperty.call(io, 'writeTextFile'), '导入不得拿到覆盖写能力');

    // 源码级：`.ets` 里唯一的 TRUNC 属于**导出**写入，追加路径一个都不能有
    const truncCount = (SERVICE_SOURCE.match(/OpenMode\.TRUNC/g) ?? []).length;
    assert.equal(truncCount, 1, `exportService.ets 里只允许导出用的 1 处 TRUNC，实际 ${truncCount} 处`);
    const appendBody = topLevelFunctionBody(SERVICE_SOURCE, 'function appendTextAtEnd(');
    assert.match(appendBody, /OpenMode\.READ_WRITE \| fs\.OpenMode\.CREATE/, '追加必须是 READ_WRITE|CREATE');
    assert.equal(/TRUNC/.test(appendBody), false, '追加路径不许出现 TRUNC（否则会覆盖历史行）');
    const exportBody = topLevelFunctionBody(SERVICE_SOURCE, 'function writeTextFile(');
    assert.match(exportBody, /OpenMode\.TRUNC/, '唯一的 TRUNC 必须留在「新建导出文件」那处');
  });

  test('② 同一天多条只发生一次物理追加（且组内按 ts 升序、跨日期各一次）', () => {
    const { io, appends } = fakeIo();
    const plan = planImport({
      existing: [],
      incoming: [
        rec({ id: 'late', ts: '2026-11-03T18:00:00+08:00' }),
        rec({ id: 'early', ts: '2026-11-03T07:00:00+08:00' }),
        rec({ id: 'mid', ts: '2026-11-03T12:00:00+08:00' }),
        rec({ id: 'other-day', ts: '2026-11-05T09:00:00+08:00' })
      ],
      now: '2026-11-18T00:00:00Z'
    });
    const written = writePlan(plan.toAppend, watchedIo(io));
    assert.equal(written.ok, true);
    assert.equal(written.appended, 4);
    assert.deepEqual(written.files, [DAY_PATH('2026-11-03'), DAY_PATH('2026-11-05')]);
    assert.equal(appends.length, 2, '两个日期 → 两次物理追加（同一天三条合成一次）');

    const dayLines = appends[0].text.split('\n').filter((line) => line.length > 0);
    assert.equal(dayLines.length, 3, '同一天的三条必须在**一次**追加里');
    assert.deepEqual(
      dayLines.map((line) => JSON.parse(line).id),
      ['early', 'mid', 'late'],
      '组内必须按 ts 升序（不是 incoming 顺序）'
    );
    assert.equal(appends[1].text.split('\n').filter((line) => line.length > 0).length, 1);
  });

  test('③ 第 2 个日期写失败：ok:false、files 只含已写文件、已写内容完整', () => {
    const firstDayHistory = '{"id":"old","ts":"2026-11-03T06:00:00+08:00","title":"旧行"}\n';
    const { io, files, appends } = fakeIo({
      seeds: { [DAY_PATH('2026-11-03')]: firstDayHistory },
      failOnDate: '2026-11-05'
    });
    const plan = planImport({
      existing: [],
      incoming: [
        rec({ id: 'a', ts: '2026-11-03T09:00:00+08:00' }),
        rec({ id: 'b', ts: '2026-11-03T10:00:00+08:00' }),
        rec({ id: 'c', ts: '2026-11-05T09:00:00+08:00' })
      ],
      now: '2026-11-18T00:00:00Z'
    });
    const written = writePlan(plan.toAppend, watchedIo(io));
    assert.equal(written.ok, false, '半批写入必须报 ok:false');
    assert.equal(written.appended, 2, '只算**已写下**的条数，不虚报第 3 条');
    assert.deepEqual(written.files, [DAY_PATH('2026-11-03')], 'files 只含已成功写入的文件');
    assert.ok(written.reason.includes('已写入 1 个文件'), `实际原因：${written.reason}`);
    assert.equal(appends.length, 1);
    assert.equal(files.has(DAY_PATH('2026-11-05')), false, '第 2 个日期一个字节都不许写');

    const firstDay = files.get(DAY_PATH('2026-11-03'));
    assert.ok(firstDay.startsWith(firstDayHistory), '已写文件的历史行仍然逐字节不变');
    const lines = firstDay.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 3, '第 1 个日期的两条必须完整写下（旧行 + 2 新行）');
    assert.deepEqual(lines.slice(1).map((line) => JSON.parse(line).id), ['a', 'b']);
  });

  test('④ 追加前已存在的历史行逐字节不变（多行 + 末尾带换行 / 不带换行两种）', () => {
    const withNewline = '{"id":"x","ts":"2026-11-03T06:00:00+08:00","title":"一"}\n{"id":"y","ts":"2026-11-03T06:30:00+08:00","title":"二"}\n';
    const withoutNewline = '{"id":"z","ts":"2026-11-05T06:00:00+08:00","title":"三"}';
    const { io, files, appends } = fakeIo({
      seeds: {
        [DAY_PATH('2026-11-03')]: withNewline,
        [DAY_PATH('2026-11-05')]: withoutNewline
      }
    });
    const plan = planImport({
      existing: [],
      incoming: [
        rec({ id: 'n3', ts: '2026-11-03T09:00:00+08:00' }),
        rec({ id: 'n5', ts: '2026-11-05T09:00:00+08:00' })
      ],
      now: '2026-11-18T00:00:00Z'
    });
    const written = writePlan(plan.toAppend, watchedIo(io));
    assert.equal(written.ok, true);
    assert.equal(appends[0].before, withNewline);
    assert.equal(appends[1].before, withoutNewline);
    assert.equal(appends[0].needsNewline, false, '末尾已有换行就不该多补一个空行');
    assert.equal(appends[1].needsNewline, true);
    assert.equal(files.get(DAY_PATH('2026-11-03')), `${withNewline}${appends[0].text}`);
    assert.equal(files.get(DAY_PATH('2026-11-05')), `${withoutNewline}\n${appends[1].text}`);
    // 历史行的字节（UTF-8）逐字节出现在结果开头
    assert.equal(
      Buffer.from(files.get(DAY_PATH('2026-11-03'))).subarray(0, Buffer.byteLength(withNewline)).equals(
        Buffer.from(withNewline)
      ),
      true
    );
  });

  test('编码失败 = 零写入（fileIo 之前就整批放弃）；空输入不建目录', () => {
    const { io, appends, calls } = fakeIo();
    // 三条都不合法：坏 id / 坏字段类型 / null（复核不负责校验，这里必须 fail-closed 而不是抛异常）
    const broken = [rec({ id: '' }), rec({ id: 'bad', title: 42 }), null];
    const written = writePlan(broken, watchedIo(io));
    assert.equal(written.ok, false);
    assert.deepEqual(written.files, []);
    assert.equal(written.appended, 0);
    assert.ok(written.reason.includes('整批未写入'), `实际原因：${written.reason}`);
    assert.equal(appends.length, 0);
    assert.equal(calls.ensureDirs, 0, '编码失败时连目录都不该建');

    const empty = writePlan([], watchedIo(io));
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, '导入内容为空，未写入任何文件');
    assert.equal(appends.length, 0);
  });

  test('派生索引在写入之后维护：抛错不把「已落盘」改报成失败', () => {
    const { io, appends } = fakeIo();
    io.applyRecord = () => {
      throw new Error('索引写失败（模拟）');
    };
    const written = writePlan([rec({ id: 'n1', ts: '2026-11-03T09:00:00+08:00' })], watchedIo(io));
    assert.equal(written.ok, true, '索引是派生数据，失败不该翻转 ok');
    assert.equal(appends.length, 1);
  });
});

describe('reconcileBeforeAppend：写盘前的幂等复核（M2）', () => {
  const existing = [rec({ id: 'same', ts: '2026-11-03T09:00:00+08:00' })];

  test('新 id → added；同 id 更新 → conflict；同 id 更旧/相同 → skipped', () => {
    const planned = [
      rec({ id: 'fresh', ts: '2026-11-03T10:00:00+08:00' }),
      rec({ id: 'same', ts: '2026-11-03T09:30:00+08:00' }),
      rec({ id: 'same', ts: '2026-11-03T08:00:00+08:00' }),
      rec({ id: 'same', ts: '2026-11-03T09:00:00+08:00' })
    ];
    const result = reconcileBeforeAppend(planned, existing);
    assert.deepEqual(result.added.map((item) => item.id), ['fresh']);
    assert.equal(result.conflict, 1, 'incoming 更新的一条 = conflict（绝不覆盖）');
    assert.equal(result.skipped, 2, '更旧 + 相同 ts 各算一次 skipped');
  });

  test('同一批复核里重复的新 id：先到 added，后到按规则 conflict / skipped', () => {
    const planned = [
      rec({ id: 'dup', ts: '2026-11-03T09:00:00+08:00' }),
      rec({ id: 'dup', ts: '2026-11-03T09:00:00+08:00' }),
      rec({ id: 'dup', ts: '2026-11-03T11:00:00+08:00' }),
      rec({ id: 'dup', ts: '2026-11-03T07:00:00+08:00' })
    ];
    const result = reconcileBeforeAppend(planned, []);
    assert.equal(result.added.length, 1, '同一个 id 在一批复核里最多放行一次');
    assert.equal(result.skipped, 2);
    assert.equal(result.conflict, 1, '同批里更晚的那条算 conflict（不覆盖已接收的）');
  });

  test('空/非法 id 一律 skipped（复核不写脏主键）；非数组入参回空结果', () => {
    const result = reconcileBeforeAppend(
      [rec({ id: '' }), rec({ id: undefined }), null, rec({ id: 'ok', ts: '2026-11-03T09:00:00+08:00' })],
      []
    );
    assert.deepEqual(result.added.map((item) => item.id), ['ok']);
    assert.equal(result.skipped, 3);
    const empty = reconcileBeforeAppend(undefined, undefined);
    assert.deepEqual(empty, { added: [], skipped: 0, conflict: 0 });
  });

  test('「双击」端到端：第一次写完后复核为空，不会再产生任何物理追加', () => {
    const planned = [
      rec({ id: 'a', ts: '2026-11-03T09:00:00+08:00' }),
      rec({ id: 'b', ts: '2026-11-03T10:00:00+08:00' })
    ];
    const { io, appends, files } = fakeIo();
    const first = reconcileBeforeAppend(planned, []);
    assert.equal(first.added.length, 2);
    writePlan(first.added, watchedIo(io));
    assert.equal(appends.length, 1);

    // 第二下点击：本机已经有这两条（同 id、同 ts）→ 复核必须把两条都拦成 skipped
    const existingNow = files
      .get(DAY_PATH('2026-11-03'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    const second = reconcileBeforeAppend(planned, existingNow);
    assert.deepEqual(second.added, [], '双击的第二下不该再有可写记录');
    assert.equal(second.skipped, 2);
    assert.equal(second.conflict, 0);
    if (second.added.length > 0) {
      writePlan(second.added, watchedIo(io));
    }
    assert.equal(appends.length, 1, '物理追加次数必须还是 1（没有第二次写）');
  });

  test('planImport → reconcile：dry-run 之后本机同步到同 id 也不会重复追加', () => {
    const planned = planImport({
      existing: [],
      incoming: [rec({ id: 'synced', ts: '2026-11-03T09:00:00+08:00' })],
      now: '2026-11-18T00:00:00Z'
    }).toAppend;
    // dry-run 之后，另一台设备经 Git 同步写入了同 id 的**更新**版本
    const synced = [rec({ id: 'synced', ts: '2026-11-03T12:00:00+08:00' })];
    const result = reconcileBeforeAppend(planned, synced);
    assert.deepEqual(result.added, [], '本机已有同 id 时绝不能再追加');
    assert.equal(result.skipped, 1, '导入版本更旧 → skipped（不覆盖、也不报冲突）');
    assert.equal(result.conflict, 0);
  });
});

describe('exportService.ets 接线：复核顺序 + 并发闸（源码级契约）', () => {
  test('写盘前先重读本机再 reconcile，最后才 writePlan', () => {
    const readIndex = SERVICE_SOURCE.indexOf('existingNow = scheduleStore.readAll()');
    const reconcileIndex = SERVICE_SOURCE.indexOf('reconcileBeforeAppend(plan.toAppend, existingNow)');
    const writeIndex = SERVICE_SOURCE.indexOf('writePlan(reconciled.added, importWriteIo())');
    assert.ok(readIndex > 0, '写盘前必须重读本机记录');
    assert.ok(reconcileIndex > readIndex, '重读之后必须复核');
    assert.ok(writeIndex > reconcileIndex, '只有复核后的 added 才交给 writePlan');
    assert.match(SERVICE_SOURCE, /if \(reconciled\.added\.length === 0\)/, '复核为空时必须直接返回、不写盘');
  });

  test('并发闸：在飞时直接拒绝（不排队），退出时复位', () => {
    assert.match(SERVICE_SOURCE, /let importInFlight: boolean = false;/, '并发闸必须是模块级布尔');
    assert.match(SERVICE_SOURCE, /if \(importInFlight\) \{/, '再次调用必须命中并发闸');
    assert.match(SERVICE_SOURCE, /reason: '正在导入中，请稍候'/, '拒绝原因是中文固定文案');
    assert.match(SERVICE_SOURCE, /importInFlight = false;/, '无论成功失败都要复位');
    assert.match(SERVICE_SOURCE, /\} finally \{/, '复位必须放在 finally 里');
    assert.match(SERVICE_SOURCE, /reconfirmed: counts/, '返回值必须带复核后的计数');
  });
});
