// 「未完成索引」（`devices/<deviceId>/open.jsonl`）纯逻辑层测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖：往返解析 / 幂等（同记录两次 changed=false）/ done 翻转 / 同 id 多次折叠 /
//       漂移检测（缺、多、状态错）/ 首次全量重建 / 30 天窗口外的记录不进期望集。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';

// openIndex.ts 运行时依赖 ./jsonl（tsc 输出的 import 不带 `.js`），这里补后缀解析。
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
  RECONCILE_DAYS,
  applyRecordToIndex,
  buildIndexFromRecords,
  decodeOpenLine,
  diffIndex,
  encodeOpenEntry,
  expectedIndexForWindow,
  findOpenEntry,
  foldOpenByid,
  isEntryInWindow,
  isOpenEntryOpen,
  mergeDeviceIndexes,
  mergeIndexForRebuild,
  openIds,
  parseOpenIndex,
  reconcileWindowStart
} = await import('../.build/model/openIndex.js');

const DAY = '2026-11-15';
const TS = `${DAY}T09:00:00+08:00`;
const LATER = `${DAY}T09:30:00+08:00`;
const CLOSED = `${DAY}T18:00:00+08:00`;

function makeRecord(overrides = {}) {
  return {
    id: 'r1',
    ts: TS,
    title: '周会',
    body: '正文',
    author: '我',
    done: false,
    ai_processed: false,
    ...overrides
  };
}

function makeEntry(overrides = {}) {
  return {
    id: 'r1',
    date: DAY,
    ts: TS,
    openedAt: TS,
    ...overrides
  };
}

/** 模拟「逐条追加维护」：把记录依次喂给 applyRecordToIndex。 */
function maintain(index, records) {
  let current = index;
  for (const record of records) {
    const result = applyRecordToIndex(current, record);
    if (result.changed) {
      current = current.concat([result.entry]);
    }
  }
  return current;
}

describe('索引条目编解码：往返与坏行容错', () => {
  test('单条往返：编码 → 解析 → 深相等，字段顺序固定', () => {
    const entry = makeEntry({ closedAt: CLOSED });
    const text = encodeOpenEntry(entry);
    assert.equal(text.slice(-1), '\n', '每条必须以换行结尾');
    assert.equal(text.trimEnd().includes('\n'), false, '一条记录必须是单行');
    assert.equal(
      text.trimEnd(),
      `{"id":"r1","date":"2026-11-15","ts":"${TS}","openedAt":"${TS}","closedAt":"${CLOSED}"}`,
      '字段顺序固定为 id/date/ts/openedAt/closedAt（稳定 diff）'
    );
    assert.deepEqual(parseOpenIndex(text).entries, [entry]);
    assert.deepEqual(decodeOpenLine(text.trimEnd()), entry);
  });

  test('未关闭条目不带 closedAt；空串 closedAt 按「未关闭」规范化', () => {
    const open = makeEntry();
    assert.equal('closedAt' in JSON.parse(encodeOpenEntry(open).trimEnd()), false);
    const messy = makeEntry({ closedAt: '' });
    assert.deepEqual(decodeOpenLine(JSON.stringify(messy)), open, '空串 closedAt 归一成缺省');
    assert.equal(isOpenEntryOpen(messy), true);
    assert.equal(isOpenEntryOpen(makeEntry({ closedAt: CLOSED })), false);
  });

  test('整份解析：空行跳过、坏行记行号且不中断、合法行一条不丢', () => {
    const good1 = encodeOpenEntry(makeEntry({ id: 'a' })).trimEnd();
    const good2 = encodeOpenEntry(makeEntry({ id: 'b', ts: LATER, openedAt: LATER })).trimEnd();
    const text = `\n${good1}\n{不是 JSON\n${good2}\n\n{"id":"","ts":"x"}\n`;

    const parsed = parseOpenIndex(text);
    assert.deepEqual(
      parsed.entries.map((entry) => entry.id),
      ['a', 'b']
    );
    assert.equal(parsed.errors.length, 2, '一行坏 JSON + 一行字段不合法');
    assert.deepEqual(
      parsed.errors.map((item) => item.line),
      [3, 6],
      '行号按 1 起算'
    );
    assert.deepEqual(parseOpenIndex('').entries, []);
    assert.deepEqual(parseOpenIndex('   \n\n').errors, []);
  });

  test('非法条目拒绝编码（空 id / 坏日期 / 缺 openedAt）', () => {
    assert.throws(() => encodeOpenEntry(makeEntry({ id: '  ' })), /索引条目不合法/);
    assert.throws(() => encodeOpenEntry(makeEntry({ date: '2026/11/15' })), /date/);
    assert.throws(() => encodeOpenEntry(makeEntry({ openedAt: '' })), /openedAt/);
    // 归属日期未知（空串）允许：手工改坏的 ts 不该让索引整体写不进去
    assert.doesNotThrow(() => encodeOpenEntry(makeEntry({ date: '' })));
  });
});

describe('状态推进：幂等、done 翻转、乱序保护', () => {
  test('同一记录两次 → 第二次 changed=false（不写盘）', () => {
    const record = makeRecord();
    const first = applyRecordToIndex([], record);
    assert.equal(first.changed, true);
    assert.deepEqual(first.entry, makeEntry());

    const second = applyRecordToIndex([first.entry], record);
    assert.equal(second.changed, false, '内容一致时不得再写盘');
    assert.deepEqual(second.entry, first.entry);
  });

  test('标记完成：closedAt=该记录 ts；已关闭后再编辑不产生索引写入', () => {
    const open = applyRecordToIndex([], makeRecord()).entry;
    const doneRecord = makeRecord({ ts: CLOSED, done: true });

    const closed = applyRecordToIndex([open], doneRecord);
    assert.equal(closed.changed, true);
    assert.equal(closed.entry.closedAt, CLOSED);
    assert.equal(closed.entry.openedAt, TS, '会话开始时间不变');
    assert.equal(closed.entry.ts, CLOSED);

    const editAfterClose = makeRecord({ ts: `${DAY}T19:00:00+08:00`, done: true, title: '改标题' });
    const again = applyRecordToIndex([open, closed.entry], editAfterClose);
    assert.equal(again.changed, false, '关闭后的编辑不动索引（状态没变）');
    assert.equal(again.entry.closedAt, CLOSED);
  });

  test('取消完成：清 closedAt 并开新会话（openedAt=该记录 ts）', () => {
    const open = applyRecordToIndex([], makeRecord()).entry;
    const closed = applyRecordToIndex([open], makeRecord({ ts: CLOSED, done: true })).entry;
    const undo = applyRecordToIndex([open, closed], makeRecord({ ts: `${DAY}T20:00:00+08:00`, done: false }));

    assert.equal(undo.changed, true);
    assert.equal(undo.entry.closedAt, undefined, 'closedAt 必须被清掉');
    assert.equal(undo.entry.openedAt, `${DAY}T20:00:00+08:00`);
    assert.equal(undo.entry.ts, `${DAY}T20:00:00+08:00`);
    assert.equal(isOpenEntryOpen(undo.entry), true);
  });

  test('未完成记录被编辑：openedAt 保留（会话不重置），ts 跟上', () => {
    const open = applyRecordToIndex([], makeRecord()).entry;
    const edited = applyRecordToIndex([open], makeRecord({ ts: LATER, title: '改标题' }));
    assert.equal(edited.changed, true, 'ts 变了，索引要记一条');
    assert.equal(edited.entry.openedAt, TS, '编辑不改变会话开始时间');
    assert.equal(edited.entry.ts, LATER);
  });

  test('乱序到达（更旧 ts）被忽略，不回退已推进的状态', () => {
    const latest = makeRecord({ ts: CLOSED, done: true });
    const older = makeRecord({ ts: TS, done: false });
    const result = applyRecordToIndex([], latest);
    const afterOlder = applyRecordToIndex([result.entry], older);
    assert.equal(afterOlder.changed, false);
    assert.equal(afterOlder.entry.closedAt, CLOSED, '旧记录不得把已完成翻回未完成');
  });
});

describe('折叠与查询：同 id 取最新 ts、openIds', () => {
  test('同 id 多条（ts 递增）折叠为最新一条，顺序无关', () => {
    const older = makeEntry({ ts: TS, openedAt: TS, closedAt: TS });
    const newer = makeEntry({ ts: LATER, openedAt: LATER });
    const newest = makeEntry({ ts: CLOSED, openedAt: LATER, closedAt: CLOSED });

    for (const order of [
      [older, newer, newest],
      [newest, older, newer],
      [newer, newest, older]
    ]) {
      const folded = foldOpenByid(order);
      assert.equal(folded.length, 1, '同 id 只保留一条');
      assert.equal(folded[0].ts, CLOSED);
      assert.equal(folded[0].closedAt, CLOSED);
    }
  });

  test('findOpenEntry 取最新；openIds 只含未关闭的 id', () => {
    const index = [
      makeEntry({ id: 'a', ts: TS, openedAt: TS }),
      makeEntry({ id: 'b', ts: TS, openedAt: TS }),
      makeEntry({ id: 'b', ts: CLOSED, openedAt: TS, closedAt: CLOSED }),
      makeEntry({ id: 'c', ts: LATER, openedAt: LATER })
    ];
    assert.equal(findOpenEntry(index, 'b').closedAt, CLOSED);
    assert.equal(findOpenEntry(index, 'missing'), null);
    assert.deepEqual(openIds(index).sort(), ['a', 'c']);
    assert.deepEqual(openIds([]), []);
  });

  test('重建结果与逐条维护结果一致（两条路径同一套规则）', () => {
    const records = [
      makeRecord({ id: 'a', ts: TS }),
      makeRecord({ id: 'a', ts: LATER, done: true }),
      makeRecord({ id: 'b', ts: `${DAY}T08:00:00+08:00` }),
      makeRecord({ id: 'b', ts: `${DAY}T08:10:00+08:00`, done: true }),
      makeRecord({ id: 'b', ts: `${DAY}T08:20:00+08:00`, done: false }),
      makeRecord({ id: 'c', ts: `${DAY}T07:00:00+08:00`, done: true })
    ];
    // 逐条维护：按 App 真实写入顺序（ts 升序）追加
    const chronological = [...records].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
    const incremental = maintain([], chronological);
    const rebuilt = buildIndexFromRecords(records);

    assert.deepEqual(
      rebuilt.map((entry) => entry.id),
      ['a', 'b', 'c'],
      '重建按 id 首次出现顺序输出'
    );
    assert.deepEqual(
      foldOpenByid(rebuilt).sort((l, r) => (l.id < r.id ? -1 : 1)),
      foldOpenByid(incremental).sort((l, r) => (l.id < r.id ? -1 : 1)),
      '重建与增量维护必须收敛到同一状态，否则对账会反复漂移'
    );
    assert.deepEqual(openIds(rebuilt), ['b'], 'b 最后一次是取消完成，仍算未完成');
  });
});

describe('漂移检测：缺项 / 多项 / 状态错', () => {
  test('完全一致 → drift=false（不得触发重建写盘）', () => {
    const index = [makeEntry({ id: 'a' }), makeEntry({ id: 'b', ts: LATER, openedAt: LATER })];
    const diff = diffIndex(index, index.slice().reverse());
    assert.equal(diff.drift, false);
    assert.equal(diff.count, 0);
    assert.deepEqual(diff.items, []);
  });

  test('缺项（索引漏记）', () => {
    const expected = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })];
    const actual = [makeEntry({ id: 'a' })];
    const diff = diffIndex(expected, actual);
    assert.equal(diff.drift, true);
    assert.deepEqual(diff.missing, ['b']);
    assert.deepEqual(diff.extra, []);
    assert.deepEqual(diff.state, []);
    assert.deepEqual(diff.items.map((item) => item.kind), ['missing']);
  });

  test('多项（索引里有记录已不存在的 id）', () => {
    const diff = diffIndex([makeEntry({ id: 'a' })], [makeEntry({ id: 'a' }), makeEntry({ id: 'ghost' })]);
    assert.deepEqual(diff.extra, ['ghost']);
    assert.equal(diff.count, 1);
    assert.equal(diff.items[0].kernel, undefined, '不多带无关字段');
    assert.equal(diff.items[0].actual.id, 'ghost');
  });

  test('状态错（期望未完成、实际已完成，反之亦然）', () => {
    const expected = [
      makeEntry({ id: 'open', ts: LATER, openedAt: LATER }),
      makeEntry({ id: 'closed', ts: LATER, openedAt: TS, closedAt: LATER })
    ];
    const actual = [
      makeEntry({ id: 'open', ts: LATER, openedAt: TS, closedAt: LATER }),
      makeEntry({ id: 'closed', ts: LATER, openedAt: TS })
    ];
    const diff = diffIndex(expected, actual);
    assert.deepEqual(diff.state.sort(), ['closed', 'open']);
    assert.deepEqual(diff.missing, []);
    assert.deepEqual(diff.extra, []);
    assert.equal(diff.count, 2);
  });
});

describe('自愈：首次全量重建、30 天窗口、重建合并', () => {
  test('首次全量重建：空索引 vs 分片记录 → 全部算缺项', () => {
    const records = [makeRecord({ id: 'a' }), makeRecord({ id: 'b', ts: LATER, done: true })];
    const expected = buildIndexFromRecords(records);
    const diff = diffIndex(expected, []);
    assert.equal(diff.drift, true);
    assert.deepEqual(diff.missing.sort(), ['a', 'b']);
    assert.equal(mergeIndexForRebuild(expected, [], '2000-01-01').length, 2, '重建写出全部条目');
  });

  test('窗口起点：RECONCILE_DAYS=30，含今天', () => {
    assert.equal(RECONCILE_DAYS, 30);
    assert.equal(reconcileWindowStart(30, new Date(2026, 10, 15)), '2026-10-17');
    assert.equal(reconcileWindowStart(1, new Date(2026, 10, 15)), '2026-11-15');
    assert.equal(reconcileWindowStart(0, new Date(2026, 10, 15)), '2026-11-15', '非法天数按 1 天');
    // 跨月/跨年边界
    assert.equal(reconcileWindowStart(30, new Date(2027, 0, 5)), '2026-12-07');
  });

  test('30 天窗口外的记录不进期望集，但窗口外的实际条目原样保留', () => {
    const oldRecord = makeRecord({ id: 'old', ts: '2026-09-01T09:00:00+08:00' });
    const newRecord = makeRecord({ id: 'new', ts: TS });
    const windowStart = reconcileWindowStart(30, new Date(2026, 10, 15));

    const expected = expectedIndexForWindow([oldRecord, newRecord], windowStart);
    assert.deepEqual(expected.map((entry) => entry.id), ['new'], '窗口外（2026-09-01）不进期望集');
    assert.equal(isEntryInWindow(expected[0], windowStart), true);

    // 实际索引里那条 9 月的记录仍未完成 → 不在对账范围，重建时必须保留
    const actual = [
      makeEntry({ id: 'old', date: '2026-09-01', ts: '2026-09-01T09:00:00+08:00', openedAt: '2026-09-01T09:00:00+08:00' }),
      makeEntry({ id: 'stale', date: DAY, ts: TS, openedAt: TS })
    ];
    const diff = diffIndex(expected, actual.filter((entry) => isEntryInWindow(entry, windowStart)));
    assert.deepEqual(diff.extra, ['stale'], '窗口内的多余条目要报出来');
    assert.deepEqual(diff.missing, ['new']);

    const merged = mergeIndexForRebuild(expected, actual, windowStart);
    assert.deepEqual(merged.map((entry) => entry.id).sort(), ['new', 'old'], '窗口外 old 保留，窗口内 stale 丢弃');
    assert.equal(diffIndex(expected, merged.filter((entry) => isEntryInWindow(entry, windowStart))).drift, false, '合并后不再漂移');
  });

  test('重建后再次对账必须无漂移（不出现「每次启动都重建」的抖动）', () => {
    const records = [
      makeRecord({ id: 'open', ts: TS }),
      makeRecord({ id: 'open', ts: LATER, title: '改标题' }),
      makeRecord({ id: 'closed', ts: TS }),
      makeRecord({ id: 'closed', ts: CLOSED, done: true }),
      makeRecord({ id: 'reopened', ts: TS }),
      makeRecord({ id: 'reopened', ts: LATER, done: true }),
      makeRecord({ id: 'reopened', ts: `${DAY}T20:00:00+08:00`, done: false })
    ];
    const chronological = [...records].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
    const actual = maintain([], chronological);
    const expected = buildIndexFromRecords(records);
    const windowStart = reconcileWindowStart(30, new Date(2026, 10, 15));

    const merged = mergeIndexForRebuild(expected, actual, windowStart);
    const inWindow = merged.filter((entry) => isEntryInWindow(entry, windowStart));
    assert.equal(diffIndex(expected, inWindow).drift, false, '重建完必须干净，否则每次启动都会重写索引');
    assert.deepEqual(mergeIndexForRebuild(expected, merged, windowStart), merged, '再跑一次也必须稳定（幂等）');
    assert.deepEqual(openIds(merged).sort(), ['open', 'reopened'], 'closed 不在未完成集合里');
  });

  test('重建是紧凑的当前状态（每个 id 一行），不继续堆历史行', () => {
    const records = [
      makeRecord({ id: 'a', ts: TS }),
      makeRecord({ id: 'a', ts: LATER, done: true }),
      makeRecord({ id: 'a', ts: CLOSED, done: false })
    ];
    const maintained = maintain([], records);
    assert.equal(maintained.length, 3, '增量维护每次状态变化追加一行');
    const merged = mergeIndexForRebuild(buildIndexFromRecords(records), maintained, '2026-10-17');
    assert.equal(merged.length, 1, '重建折叠成单条当前状态');
    assert.equal(merged[0].openedAt, CLOSED);
  });
});

describe('索引脏数据自愈：多一条 / 少一条', () => {
  const windowStart = reconcileWindowStart(30, new Date(2026, 10, 15));

  test('索引多一条（记录已不存在）→ 报「多」，重建后与真实记录一致', () => {
    const expected = buildIndexFromRecords([makeRecord({ id: 'a' }), makeRecord({ id: 'b', ts: LATER })]);
    const ghost = makeEntry({ id: 'ghost', ts: `${DAY}T07:00:00+08:00`, openedAt: `${DAY}T07:00:00+08:00` });
    const actual = expected.concat([ghost]);

    const diff = diffIndex(expected, actual);
    assert.equal(diff.drift, true);
    assert.deepEqual(diff.extra, ['ghost'], '实际多出来的 id 必须报出来');
    assert.deepEqual(diff.missing, []);
    assert.deepEqual(diff.items.map((item) => item.kind), ['extra']);

    const merged = mergeIndexForRebuild(expected, actual, windowStart);
    assert.deepEqual(merged.map((entry) => entry.id).sort(), ['a', 'b'], '脏条目在重建时被丢掉');
    assert.equal(diffIndex(expected, merged).drift, false, '重建后与真实数据一致');
    assert.equal(openIds(merged).includes('ghost'), false, '幽灵条目不得出现在未完成集合里');
  });

  test('索引少一条（实际缺项）→ 报「缺」，重建后补齐', () => {
    const expected = buildIndexFromRecords([makeRecord({ id: 'a' }), makeRecord({ id: 'b', ts: LATER })]);
    const actual = expected.filter((entry) => entry.id !== 'b');

    const diff = diffIndex(expected, actual);
    assert.equal(diff.drift, true);
    assert.deepEqual(diff.missing, ['b']);
    assert.deepEqual(diff.extra, []);

    const merged = mergeIndexForRebuild(expected, actual, windowStart);
    assert.deepEqual(merged.map((entry) => entry.id).sort(), ['a', 'b'], '缺的条目在重建时补回');
    assert.equal(diffIndex(expected, merged).drift, false);
    assert.deepEqual(openIds(merged).sort(), ['a', 'b']);
  });
});

describe('跨设备合并：两台设备的「全部未完成」', () => {
  const dayBefore = '2026-11-14';
  const earlier = `${dayBefore}T08:00:00+08:00`;

  test('两台设备的未完成集合正确：已完成的不出现，按 ts 升序，重复调用结果稳定', () => {
    const phoneA = {
      deviceId: 'phone-a',
      entries: [
        makeEntry({ id: 'a1', ts: TS, openedAt: TS }),
        makeEntry({ id: 'a2', ts: LATER, openedAt: TS, closedAt: LATER })
      ]
    };
    const phoneB = {
      deviceId: 'phone-b',
      entries: [makeEntry({ id: 'b1', date: dayBefore, ts: earlier, openedAt: earlier })]
    };

    const merged = mergeDeviceIndexes([phoneA, phoneB]);
    assert.deepEqual(
      merged.map((item) => `${item.deviceId}:${item.entry.id}`),
      ['phone-b:b1', 'phone-a:a1'],
      'ts 升序；已完成（a2）不出现；设备归属正确'
    );
    assert.equal(
      new Set(merged.map((item) => item.entry.id)).size,
      merged.length,
      '跨设备合并后没有重复 id'
    );
    assert.deepEqual(
      mergeDeviceIndexes([phoneB, phoneA]),
      merged,
      '输入顺序不同但输出完全一致（排序稳定）'
    );
    assert.deepEqual(mergeDeviceIndexes([]), []);
    assert.deepEqual(mergeDeviceIndexes([{ deviceId: 'x', entries: [] }]), []);
  });

  test('同一 id 出现在两台设备目录（手工拷贝）→ 只留一条，取 ts 较晚者', () => {
    const merged = mergeDeviceIndexes([
      { deviceId: 'phone-a', entries: [makeEntry({ id: 'dup', ts: TS, openedAt: TS })] },
      { deviceId: 'phone-b', entries: [makeEntry({ id: 'dup', ts: LATER, openedAt: LATER })] }
    ]);
    assert.equal(merged.length, 1, '同 id 不得重复');
    assert.equal(merged[0].deviceId, 'phone-b', '较晚 ts 的那条所属设备胜出');
    assert.equal(merged[0].entry.ts, LATER);
  });

  test('缺失设备索引 → 内存重建结果等价于文件索引（不落盘）', () => {
    // 该设备只有分片、没有 open.jsonl：store 走 memoryRebuild → buildIndexFromRecords
    const legacyRecords = [
      makeRecord({ id: 'n1', ts: TS }),
      makeRecord({ id: 'n2', ts: `${DAY}T10:00:00+08:00`, done: true })
    ];
    const memoryIndex = buildIndexFromRecords(legacyRecords);
    assert.deepEqual(openIds(memoryIndex), ['n1'], '内存重建同样只把未完成算进来');
    assert.equal(
      diffIndex(memoryIndex, maintain([], legacyRecords)).drift,
      false,
      '内存重建与「按文件增量维护」得到同一状态，跨设备视图不会因此抖动'
    );

    const merged = mergeDeviceIndexes([
      { deviceId: 'phone-a', entries: [] },
      { deviceId: 'phone-legacy', entries: memoryIndex }
    ]);
    assert.deepEqual(
      merged.map((item) => `${item.deviceId}:${item.entry.id}`),
      ['phone-legacy:n1'],
      '缺索引的设备靠内存重建照样进「全部未完成」，已完成的 n2 不出现'
    );
  });
});

describe('跨设备只读约束（源码级）', () => {
  const STORE = readFileSync(new URL('../../entry/src/main/ets/services/openIndexStore.ets', import.meta.url), 'utf8');

  /** 去掉整行注释（`//`、`*`、`/*`、`/**` 开头），只看代码行。 */
  function codeLines(source) {
    return source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^(\/\/|\*|\/\*)/.test(line));
  }

  test('所有 fs 写调用都落在本机目录：路径里不出现 devicesRoot / 其他设备路径', () => {
    let writes = 0;
    for (const line of codeLines(STORE)) {
      if (!/fs\.(writeSync|renameSync|unlinkSync|openSync|mkdirSync|copyFileSync|createStreamSync)/.test(line)) {
        continue;
      }
      if (/OpenMode\.READ_ONLY/.test(line)) {
        continue; // 只读打开不算写
      }
      writes++;
      assert.equal(
        /devicesRoot|deviceIndexPath|deviceSchedulesDir|otherDevice/.test(line),
        false,
        `写操作落在别的设备目录上：${line}`
      );
    }
    assert.ok(writes >= 3, `写调用点数量异常（${writes}）：期望 append/替换/建目录都在本机路径上`);
  });

  test('缺索引的设备走内存重建并打 [idx] rebuild-memory 日志（不写回）', () => {
    assert.match(STORE, /\[idx\] rebuild-memory device=\$\{deviceId\} count=\$\{pending\}/);
    assert.match(STORE, /private memoryRebuild\(deviceId: string\)/);
    assert.match(
      STORE,
      /if \(this\.fileExists\(path\)\)[\s\S]{0,400}?return this\.memoryRebuild\(deviceId\)/,
      '其他设备没有 open.jsonl 时进入内存重建'
    );
    assert.match(STORE, /this\.memoryIndexCache\.set\(deviceId, snapshot\)/, '内存结果只进缓存');
    assert.equal(
      /memoryRebuild\(deviceId\)[\s\S]{0,600}?(replaceEntries|appendEntry)\(/.test(STORE),
      false,
      '内存重建路径不得调用任何写盘方法'
    );
    assert.match(STORE, /mergeDeviceIndexes\(snapshots\)/, '跨设备「全部未完成」走合并函数');
  });
});
