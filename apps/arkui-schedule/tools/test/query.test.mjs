// 首页「搜索 + 筛选」纯逻辑测试（关键词 AND / 大小写 / 空白 / 中文 / 状态 / 作者 / 空结果）。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 设计口径（`entry/src/main/ets/model/query.ts` 文件头）：
// - 大小写不敏感、trim、连续空白折叠；
// - 多关键词 AND，每个词都命中 title / body / ocr_text / author 之一即可；
// - 中文没有空格时整串就是一个词（子串匹配）；
// - `applyQuery` 保持输入顺序（不重排），并统一剔除墓碑（deleted:true）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// query.ts 运行时依赖 ./undoDelete（tsc 输出的 import 不带 `.js`），这里补后缀解析。
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
  applyQuery,
  authorsOf,
  emptyFilter,
  filterStatusOf,
  hasKeyword,
  isFilterActive,
  makeFilter,
  matchesQuery,
  normalizeKeyword,
  splitKeywords
} = await import('../.build/model/query.js');
const { softDeleteRecord } = await import('../.build/model/undoDelete.js');

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_SOURCE = readFileSync(join(here, '..', '..', 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), 'utf8');
const QUERY_SOURCE = readFileSync(
  join(here, '..', '..', 'entry', 'src', 'main', 'ets', 'model', 'query.ts'),
  'utf8'
);

/** 造一条合法记录（字段与 `ScheduleRecord` 一致）。 */
function makeRecord(overrides = {}) {
  return {
    id: 'rec-1',
    ts: '2026-11-16T09:30:00+08:00',
    title: '周会',
    body: '讨论排期',
    author: '我',
    done: false,
    ai_processed: false,
    ...overrides
  };
}

// ---------------------------------------------------------------- 规范化 / 分词

test('normalizeKeyword：trim + 小写 + 连续空白折叠成一个空格', () => {
  assert.equal(normalizeKeyword('  周会  '), '周会');
  assert.equal(normalizeKeyword('  Weekly   Review '), 'weekly review');
  assert.equal(normalizeKeyword('A\t\nB'), 'a b');
  assert.equal(normalizeKeyword('A\u3000\u3000B'), 'a b', '全角空格也必须折叠');
  assert.equal(normalizeKeyword(''), '');
  assert.equal(normalizeKeyword('   '), '');
  assert.equal(normalizeKeyword(undefined), '', '非字符串输入按空串处理（不抛错）');
});

test('splitKeywords：空格分词；中文无空格时整串是一个词', () => {
  assert.deepEqual(splitKeywords('周会 排期'), ['周会', '排期']);
  assert.deepEqual(splitKeywords('  周会   排期  '), ['周会', '排期'], '多个空白只切一次（不产生空词）');
  assert.deepEqual(splitKeywords('周会讨论排期'), ['周会讨论排期'], '中文无空格 → 整串一个词');
  assert.deepEqual(splitKeywords('Weekly Review'), ['weekly', 'review'], '大小写不敏感（分词后已小写）');
  assert.deepEqual(splitKeywords(''), []);
  assert.deepEqual(splitKeywords('   '), []);
});

// ---------------------------------------------------------------- 关键词匹配

test('matchesQuery：多关键词 AND —— 每个词都要命中，缺一个就不匹配', () => {
  const record = makeRecord({ title: '周会讨论排期', body: '下周导出报表' });
  assert.equal(matchesQuery(record, makeFilter('周会 报表', 'all', '')), true, '两个词都在（跨字段）');
  assert.equal(matchesQuery(record, makeFilter('周会 排期', 'all', '')), true, '两个词都在 title 里');
  assert.equal(matchesQuery(record, makeFilter('周会 不存在的词', 'all', '')), false, '缺一个词即不匹配');
  assert.equal(matchesQuery(record, makeFilter('周会 周会', 'all', '')), true, '重复关键词不影响结论');
});

test('matchesQuery：大小写不敏感（title / body 都覆盖）', () => {
  const record = makeRecord({ title: 'Weekly Review', body: '用 DeepSeek 生成' });
  assert.equal(matchesQuery(record, makeFilter('weekly', 'all', '')), true);
  assert.equal(matchesQuery(record, makeFilter('WEEKLY REVIEW', 'all', '')), true);
  assert.equal(matchesQuery(record, makeFilter('deepseek', 'all', '')), true);
  assert.equal(matchesQuery(record, makeFilter('DeepSeek', 'all', '')), true);
});

test('matchesQuery：中文子串命中（整串作为一个词，不做分词）', () => {
  const record = makeRecord({ title: '周会讨论排期' });
  assert.equal(matchesQuery(record, makeFilter('周会', 'all', '')), true);
  assert.equal(matchesQuery(record, makeFilter('讨论', 'all', '')), true);
  assert.equal(matchesQuery(record, makeFilter('会议', 'all', '')), false);
});

test('matchesQuery：可搜字段 = title / body / ocr_text / author', () => {
  const record = makeRecord({
    title: '通用标题',
    body: '通用正文',
    ocr_text: '手写：二阶导数',
    author: '张三'
  });
  assert.equal(matchesQuery(record, makeFilter('张三', 'all', '')), true, 'author 可搜');
  assert.equal(matchesQuery(record, makeFilter('二阶导数', 'all', '')), true, 'ocr_text 可搜');
  assert.equal(matchesQuery(record, makeFilter('通用正文', 'all', '')), true, 'body 可搜');
  assert.equal(matchesQuery(record, makeFilter('通用标题', 'all', '')), true, 'title 可搜');

  // ocr_text 缺失时不崩、也不误命中
  const noOcr = makeRecord({ id: 'no-ocr', title: '无手迹', body: '' });
  assert.equal(matchesQuery(noOcr, makeFilter('二阶导数', 'all', '')), false);
  assert.equal(matchesQuery(noOcr, makeFilter('无手迹', 'all', '')), true);
});

test('matchesQuery：空 filter（空关键词/status=all/空作者）恒为 true（墓碑除外）', () => {
  const record = makeRecord();
  assert.equal(matchesQuery(record, emptyFilter()), true);
  assert.equal(matchesQuery(record, makeFilter('   ', 'all', '   ')), true);
  // 只有空白的关键词等于没填
  assert.equal(hasKeyword(makeFilter('   ', 'all', '')), false);
  assert.equal(isFilterActive(makeFilter('   ', 'all', '   ')), false);
});

// ---------------------------------------------------------------- 状态 / 作者

test('matchesQuery：状态筛选 all / open / done', () => {
  const open = makeRecord({ id: 'open', done: false });
  const done = makeRecord({ id: 'done', done: true });
  const all = makeFilter('', 'all', '');
  assert.equal(matchesQuery(open, all), true);
  assert.equal(matchesQuery(done, all), true);

  const onlyOpen = makeFilter('', 'open', '');
  assert.equal(matchesQuery(open, onlyOpen), true);
  assert.equal(matchesQuery(done, onlyOpen), false);

  const onlyDone = makeFilter('', 'done', '');
  assert.equal(matchesQuery(open, onlyDone), false);
  assert.equal(matchesQuery(done, onlyDone), true);
});

test('filterStatusOf / makeFilter：未知状态回落 all，作者 trim，非字符串输入安全', () => {
  assert.equal(filterStatusOf('open'), 'open');
  assert.equal(filterStatusOf('done'), 'done');
  assert.equal(filterStatusOf('all'), 'all');
  assert.equal(filterStatusOf('whatever'), 'all');
  assert.equal(filterStatusOf(''), 'all');
  assert.equal(makeFilter(' 周会 ', 'nope', '  张三 ').status, 'all');
  assert.equal(makeFilter(' 周会 ', 'open', '  张三 ').author, '张三');
  assert.equal(makeFilter(' 周会 ', 'open', '  张三 ').text, ' 周会 ', '关键词原文保留（只用于空态文案）');
  assert.equal(makeFilter(undefined, undefined, undefined).author, '');
});

test('matchesQuery：作者精确匹配（trim 后比较，不做模糊）', () => {
  const record = makeRecord({ author: '张三' });
  assert.equal(matchesQuery(record, makeFilter('', 'all', '张三')), true);
  assert.equal(matchesQuery(record, makeFilter('', 'all', ' 张三 ')), true, 'filter 侧会 trim');
  assert.equal(matchesQuery(record, makeFilter('', 'all', '张')), false, '作者不是模糊匹配');
  assert.equal(matchesQuery(record, makeFilter('', 'all', '李四')), false);
  assert.equal(matchesQuery(record, makeFilter('', 'all', '')), true, '空作者 = 不筛');
});

test('applyQuery：状态 + 作者 + 关键词可同时生效（AND）', () => {
  const records = [
    makeRecord({ id: 'a', title: '周会', author: '张三', done: false }),
    makeRecord({ id: 'b', title: '周会', author: '张三', done: true }),
    makeRecord({ id: 'c', title: '周会', author: '李四', done: false })
  ];
  assert.deepEqual(
    applyQuery(records, makeFilter('周会', 'open', '张三')).map((item) => item.id),
    ['a']
  );
  assert.deepEqual(
    applyQuery(records, makeFilter('周会', 'done', '')).map((item) => item.id),
    ['b']
  );
  assert.deepEqual(
    applyQuery(records, makeFilter('周会', 'all', '李四')).map((item) => item.id),
    ['c']
  );
});

// ---------------------------------------------------------------- applyQuery 行为

test('applyQuery：保持原顺序（不重排、不改入参）', () => {
  const records = [
    makeRecord({ id: 'late', title: '排期', body: '', ts: '2026-11-16T18:00:00+08:00' }),
    makeRecord({ id: 'early', title: '排期', body: '', ts: '2026-11-16T08:00:00+08:00' }),
    makeRecord({ id: 'other', title: '别的', body: '' })
  ];
  const filtered = applyQuery(records, makeFilter('排期', 'all', ''));
  assert.deepEqual(
    filtered.map((item) => item.id),
    ['late', 'early'],
    '筛选后顺序必须与入参一致（排序由数据源负责）'
  );
  assert.deepEqual(
    records.map((item) => item.id),
    ['late', 'early', 'other'],
    'applyQuery 不得改动入参数组'
  );
});

test('applyQuery：空 filter 返回等值结果（内容一致，且不是同一个数组引用）', () => {
  const records = [makeRecord({ id: 'a' }), makeRecord({ id: 'b' })];
  const result = applyQuery(records, emptyFilter());
  assert.deepEqual(
    result.map((item) => item.id),
    ['a', 'b']
  );
  assert.notEqual(result, records, '必须返回新数组（内部要剔除墓碑，不能复用引用）');
});

test('applyQuery：空结果返回空数组（不返回 undefined）', () => {
  const records = [makeRecord({ id: 'a', title: '周会' })];
  assert.deepEqual(applyQuery(records, makeFilter('不存在的关键词', 'all', '')), []);
  assert.deepEqual(applyQuery([], makeFilter('周会', 'all', '')), []);
});

test('applyQuery / matchesQuery：墓碑（deleted:true）永远不出现', () => {
  const alive = makeRecord({ id: 'alive' });
  const tombstone = softDeleteRecord(alive, '2026-11-16T10:00:00+08:00');
  assert.equal(matchesQuery(tombstone, emptyFilter()), false);
  assert.deepEqual(
    applyQuery([alive, tombstone], emptyFilter()).map((item) => item.id),
    ['alive'],
    '同一 id 的墓碑版本必须被剔除'
  );
});

// ---------------------------------------------------------------- 作者 chips

test('authorsOf：去重 + 升序，空作者不产生 chip，不改入参', () => {
  const records = [
    makeRecord({ id: 'a', author: '张三' }),
    makeRecord({ id: 'b', author: '李四' }),
    makeRecord({ id: 'c', author: '张三' }),
    makeRecord({ id: 'd', author: '   ' }),
    makeRecord({ id: 'e', author: '' })
  ];
  assert.deepEqual(authorsOf(records), ['张三', '李四'].sort((left, right) => (left < right ? -1 : 1)));
  assert.deepEqual(authorsOf([]), []);
});

test('hasKeyword / isFilterActive：决定空态文案走哪一支', () => {
  assert.equal(hasKeyword(makeFilter(' 周会 ', 'all', '')), true);
  assert.equal(isFilterActive(makeFilter(' 周会 ', 'all', '')), true);
  assert.equal(isFilterActive(makeFilter('', 'open', '')), true, '只有状态筛选也算激活');
  assert.equal(isFilterActive(makeFilter('', 'all', '张三')), true, '只有作者筛选也算激活');
  assert.equal(isFilterActive(emptyFilter()), false);
});

// ---------------------------------------------------------------- 源码级断言

test('源码级：Index 的列表走 applyQuery，而不是自己手写过滤', () => {
  assert.match(INDEX_SOURCE, /import \{[^}]*applyQuery[^}]*\} from '\.\.\/model\/query'/);
  assert.match(INDEX_SOURCE, /this\.visibleRecords = applyQuery\(source, filter\)/);
  assert.match(INDEX_SOURCE, /record\.done !== true/, '今日 tab 开关关闭时由 source 先挡已完成行');
  assert.match(INDEX_SOURCE, /this\.authorChips = authorsOf\(this\.records\)/);
  assert.match(INDEX_SOURCE, /this\.visibleRecords/, '列表要渲染过滤后的数据集');
  assert.equal(
    /applyQuery\(this\.records\)/.test(INDEX_SOURCE),
    false,
    'applyQuery 必须带 filter 参数（否则筛选永远不生效）'
  );
});

test('源码级：query.ts 零 SDK 依赖（模型层必须能在 Node 下跑）', () => {
  assert.equal(/@kit\.|@ohos\./.test(QUERY_SOURCE), false, 'query.ts 不得 import 鸿蒙 SDK');
  assert.equal(/from '\.\.\/services\//.test(QUERY_SOURCE), false, 'query.ts 不得依赖 services 层');
  for (const name of ['normalizeKeyword', 'splitKeywords', 'matchesQuery', 'applyQuery', 'authorsOf']) {
    assert.match(QUERY_SOURCE, new RegExp(`export function ${name}\\(`), `缺少导出 ${name}`);
  }
});
