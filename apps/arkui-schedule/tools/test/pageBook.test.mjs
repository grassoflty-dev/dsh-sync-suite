// 分页账本（`model/pageBook.ts`）测试：页序 → 画布槽位映射、区域跟随页重排、槽位复用、上限与裁剪。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 关键不变量（每个用例都在断言）：
// - `slots.length === regions.length`，页数始终 1..maxPages；
// - 删中间页只重排 `slots` / `regions`（第 2 页框的还是原来那块内容），`current` 夹紧；
// - 新增页优先复用回收槽位，永远不出现 >= maxPages 的槽位；新页区域为空。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// pageBook.ts 运行时只依赖 regions.ts（同样无 SDK import），这里补一下 `.js` 后缀解析，
// 让测试跑的是 tsc 编译产物而不是另写一份实现。
import { registerHooks } from 'node:module';

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

const { MAX_HANDWRITING_PAGES, PageBook } = await import('../.build/model/pageBook.js');

/** 合法框（用 y 区分不同页的区域，方便断言「区域跟着页走」）。 */
function box(x, y, w = 0.3, h = 0.2) {
  return { x, y, w, h };
}

/** 断言账本的内部不变量：slots 与 regions 等长、槽位互不相同且在 0..maxPages-1。 */
function assertInvariants(book) {
  assert.equal(book.slots.length, book.regions.length, 'slots 与 regions 必须等长');
  assert.ok(book.pageCount() >= 1, '至少保留 1 页');
  assert.ok(book.pageCount() <= book.maxPages, '页数不得超过 maxPages');
  assert.equal(new Set(book.slots).size, book.slots.length, '槽位不得重复');
  for (const slot of book.slots) {
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot < book.maxPages, `槽位越界：${slot}`);
  }
  assert.ok(book.current >= 0 && book.current < book.pageCount(), 'current 必须落在页序范围内');
}

/** 造一个已有 pages 页的账本（初始 1 页，再补 pages-1 页）。 */
function bookWithPages(pages) {
  const book = new PageBook();
  for (let index = 1; index < pages; index++) {
    assert.equal(book.addPage(), true);
  }
  return book;
}

describe('PageBook：初始状态与页数上限', () => {
  test('初始 1 页：slots=[0]、regions=[[]]、current=0、maxPages=10', () => {
    const book = new PageBook();
    assert.equal(MAX_HANDWRITING_PAGES, 10);
    assert.deepEqual(book.slots, [0]);
    assert.deepEqual(book.regions, [[]]);
    assert.deepEqual(book.regionsAt(0), []);
    assert.equal(book.current, 0);
    assert.equal(book.maxPages, MAX_HANDWRITING_PAGES);
    assert.equal(book.pageCount(), 1);
    assert.deepEqual(book.indexes(), [0]);
    assertInvariants(book);
  });

  test('addPage 逐个加到 10 页，第 11 次返回 false 且不改状态', () => {
    const book = new PageBook();
    for (let pageIndex = 1; pageIndex < MAX_HANDWRITING_PAGES; pageIndex++) {
      assert.equal(book.addPage(), true, `第 ${pageIndex + 1} 页应能新增`);
      assert.equal(book.current, pageIndex, '新增后 current 指向新页');
      assert.deepEqual(book.regionsAt(pageIndex), [], '新页区域为空');
      assertInvariants(book);
    }
    assert.equal(book.pageCount(), 10);
    assert.deepEqual(book.slots, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(book.regions, new Array(10).fill(null).map(() => []));

    const beforeSlots = book.slots.slice();
    assert.equal(book.addPage(), false, '达上限后必须返回 false');
    assert.equal(book.pageCount(), 10);
    assert.equal(book.current, 9, '失败不得移动 current');
    assert.deepEqual(book.slots, beforeSlots, '失败不得改状态');
    assertInvariants(book);
  });
});

describe('PageBook：removePage 与区域跟随', () => {
  test('删除中间页：slots 与 regions 同步重排（第 3 页的区域跟着页走到第 2 页）', () => {
    const book = bookWithPages(3);
    const first = box(0.1, 0.1);
    const second = box(0.1, 0.3);
    const third = box(0.1, 0.5);
    book.setRegions(0, [first]);
    book.setRegions(1, [second]);
    book.setRegions(2, [third]);
    book.jumpTo(2);

    assert.equal(book.removePage(1), true);
    assert.equal(book.pageCount(), 2);
    assert.deepEqual(book.slots, [0, 2], '被删页的槽位从页序里移除，其余页槽位不动');
    assert.deepEqual(book.regionsAt(0), [first], '第 1 页区域不动');
    assert.deepEqual(book.regionsAt(1), [third], '原第 3 页的区域跟着页走到第 2 页');
    assert.deepEqual(book.regionsAt(2), [], '越界读取返回空数组');
    assert.equal(book.current, 1, 'current 夹紧到 pageCount-1');
    assertInvariants(book);

    // 删到只剩 1 页后不能再删
    assert.equal(book.removePage(0), true);
    assert.equal(book.pageCount(), 1);
    assert.deepEqual(book.regionsAt(0), [third], '留下的页保留自己的区域');
    assert.equal(book.current, 0);
    assert.equal(book.removePage(0), false, '只剩 1 页时返回 false');
    assert.equal(book.pageCount(), 1, '失败不得改状态');
    assertInvariants(book);
  });

  test('越界/非法下标返回 false，state 不变', () => {
    const book = bookWithPages(3);
    book.setRegions(0, [box(0.1, 0.1)]);
    const beforeSlots = book.slots.slice();
    const beforeRegions = book.regionsAt(0);
    for (const bad of [-1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(book.removePage(bad), false, `应拒绝：${bad}`);
    }
    assert.deepEqual(book.slots, beforeSlots);
    assert.deepEqual(book.regionsAt(0), beforeRegions);
    assert.equal(book.current, 2);
    assertInvariants(book);
  });
});

describe('PageBook：删页后 addPage 复用被回收的槽位', () => {
  test('删中间页再新增：复用旧槽位（不是新槽 3），新页区域为空', () => {
    const book = bookWithPages(3);
    assert.deepEqual(book.slots, [0, 1, 2]);

    assert.equal(book.removePage(1), true);
    assert.deepEqual(book.slots, [0, 2]);

    assert.equal(book.addPage(), true);
    assert.equal(book.pageCount(), 3);
    assert.deepEqual(book.slots, [0, 2, 1], '回收的槽位 1 被复用，而不是继续递增到 3');
    assert.deepEqual(book.regionsAt(2), [], '新页区域为空');
    assert.equal(book.current, 2, 'current 指向新页');
    assert.ok(
      book.slots.every((slot) => slot < MAX_HANDWRITING_PAGES),
      '槽位永不超过上限'
    );
    assertInvariants(book);
  });

  test('满 10 页时删 1 页再加回：页数回到 10、槽位不越界、不重复', () => {
    const book = bookWithPages(MAX_HANDWRITING_PAGES);
    assert.equal(book.slots.length, 10);
    assert.equal(book.removePage(4), true);
    assert.equal(book.pageCount(), 9);
    assert.equal(book.slots.includes(4), false);

    assert.equal(book.addPage(), true);
    assert.equal(book.pageCount(), 10);
    assert.equal(book.slots[9], 4, '复用的是被删掉的槽位 4');
    assert.equal(new Set(book.slots).size, 10);
    assertInvariants(book);
    assert.equal(book.addPage(), false, '回到 10 页后仍是上限');
  });
});

describe('PageBook：jumpTo / prev / next', () => {
  test('首末页边界：越界返回 false 且 current 不变', () => {
    const book = bookWithPages(3);
    assert.equal(book.current, 2);

    assert.equal(book.jumpTo(0), true);
    assert.equal(book.current, 0);
    assert.equal(book.prev(), false, '首页再 prev 返回 false');
    assert.equal(book.current, 0, '失败不得移动 current');

    for (const bad of [-1, 3, 1.5, Number.NaN]) {
      assert.equal(book.jumpTo(bad), false, `应拒绝跳转：${bad}`);
    }
    assert.equal(book.current, 0);

    assert.equal(book.next(), true);
    assert.equal(book.current, 1);
    assert.equal(book.jumpTo(2), true);
    assert.equal(book.current, 2);
    assert.equal(book.next(), false, '末页再 next 返回 false');
    assert.equal(book.current, 2);

    assert.equal(book.prev(), true);
    assert.equal(book.current, 1);
    assertInvariants(book);
  });
});

describe('PageBook：setMaxPages 裁剪与夹紧', () => {
  test('setMaxPages(3)：5 页裁到 3 页，regions 同步裁剪，current 夹紧', () => {
    const book = bookWithPages(5);
    for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
      book.setRegions(pageIndex, [box(0.1, pageIndex * 0.1)]);
    }
    book.jumpTo(4);

    book.setMaxPages(3);
    assert.equal(book.maxPages, 3);
    assert.equal(book.pageCount(), 3);
    assert.deepEqual(book.slots, [0, 1, 2]);
    assert.equal(book.regions.length, 3, 'regions 与 slots 同步裁剪');
    assert.deepEqual(
      book.regions.map((pageBoxes) => pageBoxes.length),
      [1, 1, 1]
    );
    assert.deepEqual(book.regionsAt(2), [box(0.1, 0.2)], '第 3 页区域仍在（y = 页序 × 0.1）');
    assert.equal(book.current, 2, 'current 夹紧到新的末页');
    assertInvariants(book);
  });

  test('setMaxPages(99) 夹到 10；setMaxPages(0)/负数夹到 1 并把页裁到 1', () => {
    const book = bookWithPages(5);
    book.setRegions(1, [box(0.1, 0.1)]);
    book.setMaxPages(99);
    assert.equal(book.maxPages, MAX_HANDWRITING_PAGES, '上限夹到 10');
    assert.equal(book.pageCount(), 5, '放大上限不补页');
    assertInvariants(book);

    book.setMaxPages(0);
    assert.equal(book.maxPages, 1);
    assert.equal(book.pageCount(), 1);
    assert.equal(book.current, 0);
    assert.equal(book.slots.length, 1);
    assert.equal(book.regions.length, 1);
    assert.deepEqual(book.regionsAt(0), [], '留下的第 1 页本来就没有区域');
    assertInvariants(book);

    book.setMaxPages(Number.NaN);
    assert.equal(book.maxPages, MAX_HANDWRITING_PAGES, '非法上限回退到最大值');
    assert.equal(book.pageCount(), 1);
    assertInvariants(book);
  });

  test('裁剪释放的槽位可再复用（缩小后放大不越界）', () => {
    const book = bookWithPages(5);
    book.setMaxPages(2);
    assert.deepEqual(book.slots, [0, 1]);
    book.setMaxPages(MAX_HANDWRITING_PAGES);
    assert.equal(book.addPage(), true);
    assert.deepEqual(book.slots, [0, 1, 2], '放大上限后从最小的空闲槽位 2 继续，不重复、不越界');
    assertInvariants(book);
  });
});

describe('PageBook：区域增删改查', () => {
  test('setRegions / addRegion / removeRegion / updateRegion 正常路径', () => {
    const book = bookWithPages(2);
    const a = box(0.1, 0.1);
    const b = box(0.5, 0.5);

    book.setRegions(0, [a, b]);
    assert.deepEqual(book.regionsAt(0), [a, b]);
    assert.equal(book.regionsAt(0).length, 2);

    const c = box(0.2, 0.8);
    assert.equal(book.addRegion(0, c), true);
    assert.deepEqual(book.regionsAt(0), [a, b, c]);

    const d = box(0.4, 0.4);
    assert.equal(book.updateRegion(0, 1, d), true);
    assert.deepEqual(book.regionsAt(0), [a, d, c]);

    assert.equal(book.removeRegion(0, 1), true);
    assert.deepEqual(book.regionsAt(0), [a, c]);

    // 清空该页
    book.setRegions(0, []);
    assert.deepEqual(book.regionsAt(0), []);
    assert.equal(book.removeRegion(0, 0), false, '空区域的页删区域返回 false');
    assertInvariants(book);
  });

  test('addRegion / updateRegion 对非法框返回 false 且不改状态', () => {
    const book = bookWithPages(1);
    book.setRegions(0, [box(0.1, 0.1)]);
    const before = book.regionsAt(0);

    assert.equal(book.addRegion(0, { x: Number.NaN, y: 0, w: 0.2, h: 0.2 }), false);
    assert.equal(book.addRegion(0, { x: 0, y: 0, w: 0, h: 0 }), false, '零面积');
    assert.equal(book.addRegion(0, { x: 0.1, y: 0.1, w: 0.001, h: 0.001 }), false, '小于最小边长');
    assert.deepEqual(book.regionsAt(0), before, '失败的 addRegion 不得改状态');

    assert.equal(book.updateRegion(0, 0, { x: Number.NaN, y: 0, w: 0.2, h: 0.2 }), false);
    assert.equal(book.updateRegion(0, 0, { x: 0, y: 0, w: 0, h: 0 }), false);
    assert.deepEqual(book.regionsAt(0), before, '失败的 updateRegion 不得改状态');
    assertInvariants(book);
  });

  test('越界下标：setRegions 忽略、addRegion/removeRegion/updateRegion 返回 false', () => {
    const book = bookWithPages(2);
    book.setRegions(0, [box(0.1, 0.1)]);

    book.setRegions(9, [box(0.2, 0.2)]);
    book.setRegions(-1, [box(0.2, 0.2)]);
    assert.equal(book.regions.length, 2, 'setRegions 越界不得改长度');

    assert.equal(book.addRegion(9, box(0.2, 0.2)), false);
    assert.equal(book.addRegion(-1, box(0.2, 0.2)), false);
    assert.equal(book.updateRegion(9, 0, box(0.2, 0.2)), false);
    assert.equal(book.updateRegion(0, 9, box(0.2, 0.2)), false);
    assert.equal(book.removeRegion(9, 0), false);
    assert.equal(book.removeRegion(0, 9), false);

    assert.deepEqual(book.regionsAt(0), [box(0.1, 0.1)], '第 1 页区域未被越界操作污染');
    assertInvariants(book);
  });

  test('regionsAt 返回深拷贝：改返回值不影响账本；addRegion 内部也存清洗后的副本', () => {
    const book = bookWithPages(1);
    const original = box(0.1, 0.1);
    book.setRegions(0, [original]);

    const snapshot = book.regionsAt(0);
    snapshot[0].x = 0.9;
    snapshot.push(box(0.5, 0.5));
    assert.deepEqual(book.regionsAt(0), [original], '账本不被外部改动影响');

    // 入参也没有被账本持有（外部再改不影响）
    original.x = 0.8;
    assert.equal(book.regionsAt(0)[0].x, 0.1);
    assertInvariants(book);
  });

  test('setRegions 内部 sanitize：脏框被丢弃/夹紧后入库', () => {
    const book = bookWithPages(1);
    book.setRegions(0, [
      { x: -0.2, y: -0.2, w: 0.4, h: 0.4 },
      { x: Number.NaN, y: 0, w: 0.2, h: 0.2 },
      { x: 0, y: 0, w: 0, h: 0 }
    ]);
    const regions = book.regionsAt(0);
    assert.equal(regions.length, 1);
    assert.deepEqual(regions[0], { x: 0, y: 0, w: 0.2, h: 0.2 });
    assertInvariants(book);
  });
});

describe('PageBook：snapshotIds', () => {
  test('按页序拼 `${prefix}${slot}`，删页后跟随槽位', () => {
    const book = bookWithPages(3);
    assert.deepEqual(book.snapshotIds('hw-page-'), ['hw-page-0', 'hw-page-1', 'hw-page-2']);

    book.removePage(1);
    assert.deepEqual(book.snapshotIds('hw-page-'), ['hw-page-0', 'hw-page-2'], '中间页删除后 id 跟着槽位走');

    book.addPage();
    assert.deepEqual(book.snapshotIds('hw-page-'), ['hw-page-0', 'hw-page-2', 'hw-page-1']);

    const other = bookWithPages(2);
    assert.deepEqual(other.snapshotIds('canvas#'), ['canvas#0', 'canvas#1']);
  });
});
