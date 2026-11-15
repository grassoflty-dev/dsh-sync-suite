// 每日 AI 汇总（`model/dailySummary.ts`）测试：路径 / 往返 / 坏文件 / 合并冲突 / 落盘口径。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 落盘用例走真实临时目录（`SummaryIO` 的 Node 实现），因此「旧汇总不被覆盖」是实测而不是推导。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

// dailySummary.ts 运行时依赖 aiPayload / jsonl / syncScope，这里补 `.js` 后缀解析。
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
  SUMMARY_MAX_POINTS,
  SUMMARY_VERSION,
  buildSummaryPayload,
  mergeSummary,
  parseSummary,
  readDailySummary,
  sanitizeSummary,
  serializeSummary,
  summaryFilePath,
  summaryFromReply,
  summariesPath,
  truncateSummaryForDisplay,
  writeDailySummary
} = await import('../.build/model/dailySummary.js');
const { assertWithinDevice, filterPathsForDevice } = await import('../.build/model/syncScope.js');
const { buildAiPayload, buildAiPrompt, buildDaySummaryPayload } = await import('../.build/model/aiPayload.js');

const DATE = '2026-11-15';
const DEVICE = 'phone-a';
const SUMMARY_STORE = readFileSync(new URL('../../entry/src/main/ets/services/summaryStore.ets', import.meta.url), 'utf8');

function sample(overrides = {}) {
  return {
    version: SUMMARY_VERSION,
    date: DATE,
    generatedAt: 1763000000000,
    model: 'deepseek-chat',
    provider: 'deepseek',
    headline: '今天讲了预算',
    points: ['要点一', '要点二'],
    recordCount: 5,
    doneCount: 2,
    ...overrides
  };
}

function record(id, ts, extra = {}) {
  return { id, ts, title: '标题', body: '正文', author: '我', done: false, ai_processed: false, ...extra };
}

/** 临时目录上的 SummaryIO 实现（读不到返回 null，写前建目录）。 */
function tempStore() {
  const root = mkdtempSync(join(tmpdir(), 'daily-summary-'));
  return {
    root,
    io: {
      readText(relative) {
        const path = join(root, relative);
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      },
      writeText(relative, text) {
        const path = join(root, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, 'utf8');
      }
    },
    read(relative) {
      return readFileSync(join(root, relative), 'utf8');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('路径与同步范围', () => {
  test('汇总文件在设备目录下的 summaries/', () => {
    assert.equal(summariesPath(DEVICE), 'devices/phone-a/summaries');
    assert.equal(summaryFilePath(DEVICE, DATE), 'devices/phone-a/summaries/2026-11-15.json');
  });

  test('汇总路径落在 push 允许范围内（devices/<id>/ 整树）', () => {
    const path = summaryFilePath(DEVICE, DATE);
    assert.doesNotThrow(() => assertWithinDevice(path, DEVICE));
    assert.deepEqual(filterPathsForDevice([path], DEVICE), [path]);
  });

  test('非法设备标识 / 非法日期被拒', () => {
    assert.throws(() => summariesPath('BAD ID'), /设备标识/);
    assert.throws(() => summaryFilePath(DEVICE, '2026-13-01'), /YYYY-MM-DD/);
    assert.throws(() => summaryFilePath(DEVICE, '2026-1-5'), /YYYY-MM-DD/);
    assert.throws(() => summaryFilePath(DEVICE, ''), /YYYY-MM-DD/);
  });
});

describe('序列化 / 解析往返', () => {
  test('往返一致（键序固定）', () => {
    const text = serializeSummary(sample());
    const parsed = parseSummary(text);
    assert.equal(parsed.kind, 'ok');
    assert.deepEqual(parsed.summary, sample());
    assert.match(text, /^\{\n {2}"version": 1,/);
    assert.equal(text.endsWith('\n'), true);
  });

  test('空文本是 empty', () => {
    assert.equal(parseSummary('').kind, 'empty');
    assert.equal(parseSummary('  \n ').kind, 'empty');
  });

  test('坏文件一律 corrupt 且不抛', () => {
    const broken = [
      'not json',
      '{',
      'null',
      '[]',
      '"只有字符串"',
      '{"date":"2026-11-15"}',
      '{"date":"2026-13-01","generatedAt":1}',
      '{"date":"2026-11-15","generatedAt":"x"}'
    ];
    for (const text of broken) {
      const parsed = parseSummary(text);
      assert.equal(parsed.kind, 'corrupt', `样本应判 corrupt：${text}`);
      assert.equal(parsed.summary, null);
    }
  });

  test('非法内容序列化直接抛错', () => {
    assert.throws(() => serializeSummary(sample({ date: 'bad' })), /不合法/);
    assert.throws(() => serializeSummary(sample({ generatedAt: Number.NaN })), /不合法/);
  });
});

describe('sanitizeSummary', () => {
  test('要点截断到 3 条', () => {
    const clean = sanitizeSummary(sample({ points: ['a', 'b', 'c', 'd', 'e'] }));
    assert.equal(clean.points.length, SUMMARY_MAX_POINTS);
    assert.deepEqual(clean.points, ['a', 'b', 'c']);
  });

  test('headline 与要点压成单行', () => {
    const clean = sanitizeSummary(sample({ headline: '第一行\n第二行   合并', points: ['要点\n换行'] }));
    assert.equal(clean.headline, '第一行 第二行 合并');
    assert.equal(clean.points[0], '要点 换行');
  });

  test('计数取非负整数，doneCount 不超过 recordCount', () => {
    assert.equal(sanitizeSummary(sample({ recordCount: -5 })).recordCount, 0);
    assert.equal(sanitizeSummary(sample({ recordCount: 3.7 })).recordCount, 3);
    assert.equal(sanitizeSummary(sample({ recordCount: 2, doneCount: 9 })).doneCount, 2);
    assert.equal(sanitizeSummary(sample({ doneCount: -1 })).doneCount, 0);
  });

  test('非法日期 / 缺失生成时间 → null', () => {
    assert.equal(sanitizeSummary(sample({ date: '2026-02-30' })), null);
    assert.equal(sanitizeSummary(sample({ date: '2026/11/15' })), null);
    assert.equal(sanitizeSummary(sample({ generatedAt: undefined })), null);
    assert.equal(sanitizeSummary(sample({ generatedAt: -1 })), null);
    assert.equal(sanitizeSummary(null), null);
  });

  test('版本统一写回 1（未知版本按 1 归一）', () => {
    assert.equal(sanitizeSummary(sample({ version: 99 })).version, SUMMARY_VERSION);
  });
});

describe('mergeSummary：同一天取较新', () => {
  test('更新的 incoming 覆盖', () => {
    const merged = mergeSummary(sample({ generatedAt: 100 }), sample({ generatedAt: 200, headline: '新' }));
    assert.equal(merged.replaced, true);
    assert.equal(merged.summary.headline, '新');
  });

  test('更旧的 incoming 保留现有', () => {
    const existing = sample({ generatedAt: 200, headline: '旧' });
    const merged = mergeSummary(existing, sample({ generatedAt: 100, headline: '更旧' }));
    assert.equal(merged.replaced, false);
    assert.equal(merged.summary.headline, '旧');
  });

  test('时间相等保留现有（先到先得）', () => {
    const existing = sample({ generatedAt: 200, headline: '现有' });
    const merged = mergeSummary(existing, sample({ generatedAt: 200, headline: '来者' }));
    assert.equal(merged.replaced, false);
    assert.equal(merged.summary.headline, '现有');
  });

  test('没有旧汇总时直接采用', () => {
    const merged = mergeSummary(null, sample());
    assert.equal(merged.replaced, true);
  });
});

describe('truncateSummaryForDisplay', () => {
  test('默认最多 3 条要点', () => {
    const display = truncateSummaryForDisplay(sample({ points: ['a', 'b', 'c', 'd'] }));
    assert.equal(display.points.length, SUMMARY_MAX_POINTS);
  });

  test('maxPoints 生效且 headline 单行', () => {
    const display = truncateSummaryForDisplay(sample({ headline: '第一行\n第二行', points: ['a', 'b'] }), 1);
    assert.equal(display.points.length, 1);
    assert.equal(display.headline, '第一行 第二行');
  });
});

describe('buildSummaryPayload：汇总口径', () => {
  test('取当天全部记录（含已处理）并统计完成数', () => {
    const records = [
      record('r1', `${DATE}T09:00:00+08:00`),
      record('r2', `${DATE}T10:00:00+08:00`, { done: true }),
      record('r3', `${DATE}T11:00:00+08:00`, { ai_processed: true }),
      record('r4', '2026-11-14T23:00:00+08:00')
    ];
    const input = buildSummaryPayload(records, DATE, 'UTC+08:00');
    assert.equal(input.recordCount, 3);
    assert.equal(input.doneCount, 1);
    assert.equal(input.payload.records.length, 3);
    assert.equal(input.timeZone, 'UTC+08:00');
  });

  test('复用现有提示词构造（不另写一份 prompt）', () => {
    const input = buildSummaryPayload([record('r1', `${DATE}T09:00:00+08:00`)], DATE, 'UTC+08:00');
    const prompt = buildAiPrompt(input.payload, `${DATE}T12:00:00+08:00`, input.timeZone);
    assert.match(prompt, /记录条数：1/);
    assert.match(prompt, /UTC\+08:00/);
  });

  test('与增量载荷的唯一差别是不过滤已处理记录', () => {
    const records = [
      record('r1', `${DATE}T09:00:00+08:00`),
      record('r2', `${DATE}T10:00:00+08:00`, { ai_processed: true })
    ];
    assert.equal(buildAiPayload(DATE, records).records.length, 1);
    assert.equal(buildDaySummaryPayload(DATE, records).records.length, 2);
  });
});

describe('summaryFromReply：Markdown → 汇总', () => {
  test('首行当 headline，项目符号当要点（最多 3 条）', () => {
    const reply = ['今天主要是预算会', '', '- 预算砍了 10%', '- 下周一复核', '- 张三负责数据', '- 第四条不进'].join('\n');
    const summary = summaryFromReply(reply, {
      date: DATE,
      generatedAt: 100,
      model: 'deepseek-chat',
      provider: 'deepseek',
      recordCount: 4,
      doneCount: 1
    });
    assert.equal(summary.headline, '今天主要是预算会');
    assert.deepEqual(summary.points, ['预算砍了 10%', '下周一复核', '张三负责数据']);
    assert.equal(summary.recordCount, 4);
    assert.equal(summary.doneCount, 1);
  });

  test('章节标题不进要点', () => {
    const reply = ['## 重点事项', '预算会', '- 砍 10%'].join('\n');
    const summary = summaryFromReply(reply, {
      date: DATE,
      generatedAt: 100,
      model: 'm',
      provider: 'p',
      recordCount: 1,
      doneCount: 0
    });
    assert.equal(summary.headline, '重点事项');
    assert.deepEqual(summary.points, ['预算会', '砍 10%']);
  });

  test('没有可用文本时抛错（不产出空汇总）', () => {
    assert.throws(
      () =>
        summaryFromReply('   \n\n---\n', {
          date: DATE,
          generatedAt: 100,
          model: 'm',
          provider: 'p',
          recordCount: 1,
          doneCount: 0
        }),
      /没有可用的标题/
    );
  });
});

describe('SummaryIO 落盘（真实临时目录）', () => {
  test('首次写入 → created，读回一致', () => {
    const store = tempStore();
    try {
      const result = writeDailySummary(store.io, DEVICE, sample());
      assert.equal(result.written, true);
      assert.equal(result.reason, 'created');
      assert.equal(result.path, 'devices/phone-a/summaries/2026-11-15.json');
      const read = readDailySummary(store.io, DEVICE, DATE);
      assert.equal(read.kind, 'ok');
      assert.deepEqual(read.summary, sample());
      assert.equal(store.read(result.path), serializeSummary(sample()));
    } finally {
      store.cleanup();
    }
  });

  test('更旧的回复不覆盖文件（字节不变）', () => {
    const store = tempStore();
    try {
      writeDailySummary(store.io, DEVICE, sample({ generatedAt: 200, headline: '新的' }));
      const before = store.read(summaryFilePath(DEVICE, DATE));
      const result = writeDailySummary(store.io, DEVICE, sample({ generatedAt: 100, headline: '旧的' }));
      assert.equal(result.written, false);
      assert.equal(result.reason, 'stale');
      assert.equal(result.replaced, false);
      assert.equal(store.read(summaryFilePath(DEVICE, DATE)), before);
    } finally {
      store.cleanup();
    }
  });

  test('更新的回复覆盖并标记 newer', () => {
    const store = tempStore();
    try {
      writeDailySummary(store.io, DEVICE, sample({ generatedAt: 100, headline: '旧的' }));
      const result = writeDailySummary(store.io, DEVICE, sample({ generatedAt: 200, headline: '新的' }));
      assert.equal(result.written, true);
      assert.equal(result.reason, 'newer');
      assert.equal(result.replaced, true);
      assert.equal(readDailySummary(store.io, DEVICE, DATE).summary.headline, '新的');
    } finally {
      store.cleanup();
    }
  });

  test('旧文件损坏 → repaired（重写而不是拒绝）', () => {
    const store = tempStore();
    try {
      const path = summaryFilePath(DEVICE, DATE);
      mkdirSync(dirname(join(store.root, path)), { recursive: true });
      writeFileSync(join(store.root, path), '{ 坏文件', 'utf8');
      assert.equal(readDailySummary(store.io, DEVICE, DATE).kind, 'corrupt');
      const result = writeDailySummary(store.io, DEVICE, sample());
      assert.equal(result.written, true);
      assert.equal(result.reason, 'repaired');
    } finally {
      store.cleanup();
    }
  });

  test('内容非法时一个字节都不写', () => {
    const store = tempStore();
    try {
      writeDailySummary(store.io, DEVICE, sample({ headline: '保留这份' }));
      const before = store.read(summaryFilePath(DEVICE, DATE));
      const result = writeDailySummary(store.io, DEVICE, sample({ date: 'bad', headline: '非法' }));
      assert.equal(result.written, false);
      assert.equal(result.reason, 'invalid');
      assert.equal(result.summary, null);
      assert.equal(store.read(summaryFilePath(DEVICE, DATE)), before);
    } finally {
      store.cleanup();
    }
  });

  test('读失败 → read-failed 且不写', () => {
    const store = tempStore();
    try {
      writeDailySummary(store.io, DEVICE, sample());
      const before = store.read(summaryFilePath(DEVICE, DATE));
      const failing = {
        readText() {
          throw new Error('权限不足');
        },
        writeText() {
          throw new Error('不该被调用');
        }
      };
      assert.equal(readDailySummary(failing, DEVICE, DATE).kind, 'corrupt');
      const result = writeDailySummary(failing, DEVICE, sample({ generatedAt: 999999 }));
      assert.equal(result.written, false);
      assert.equal(result.reason, 'read-failed');
      assert.equal(store.read(summaryFilePath(DEVICE, DATE)), before);
    } finally {
      store.cleanup();
    }
  });

  test('写失败 → write-failed（旧文件保留）', () => {
    const store = tempStore();
    try {
      const path = summaryFilePath(DEVICE, DATE);
      const failing = {
        readText(relative) {
          return store.io.readText(relative);
        },
        writeText() {
          throw new Error('磁盘满');
        }
      };
      const result = writeDailySummary(failing, DEVICE, sample());
      assert.equal(result.written, false);
      assert.equal(result.reason, 'write-failed');
      assert.equal(existsSync(join(store.root, path)), false);
    } finally {
      store.cleanup();
    }
  });
});

describe('AI 失败不覆盖旧汇总（服务层顺序）', () => {
  test('summaryStore 先调 AI、后写盘', () => {
    const summarizeAt = SUMMARY_STORE.indexOf('await summarize(');
    const writeAt = SUMMARY_STORE.indexOf('writeDailySummary(');
    assert.ok(summarizeAt > 0, 'summaryStore 没有调用 summarize');
    assert.ok(writeAt > summarizeAt, '写盘必须排在 AI 调用之后（AI 失败时不能落盘）');
  });

  test('只有拿到回复后才构造汇总并写盘', () => {
    const replyAt = SUMMARY_STORE.indexOf('summaryFromReply(reply, meta)');
    const writeAt = SUMMARY_STORE.indexOf('writeDailySummary(');
    assert.ok(replyAt > 0 && writeAt > replyAt);
  });
});
