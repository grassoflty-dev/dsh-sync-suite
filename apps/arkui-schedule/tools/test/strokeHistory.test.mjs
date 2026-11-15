// 笔迹历史（`model/strokeHistory.ts`）测试：按页隔离的撤销/重做 + 笔工具常量。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 重点（UI 依赖的保证）：
// - 撤销返回「撤销后该页应重绘的笔迹」，UI 清屏后按此重放；
// - 撤销深度 ≥ MIN_UNDO_DEPTH（不设历史上限）；
// - 每页独立；橡皮也是普通一笔，撤销橡皮后笔迹恢复；
// - 所有返回值都是深拷贝，UI 乱改不会污染账本。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';

// ArkTS 源码写无扩展名的相对 import；Node 的 ESM 不做扩展名推断，这里只为测试进程补 `.js`。
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
  DEFAULT_PEN_COLOR,
  DEFAULT_PEN_WIDTH,
  ERASER_WIDTH,
  MIN_UNDO_DEPTH,
  PEN_COLORS,
  PEN_WIDTHS,
  StrokeHistory
} = await import('../.build/model/strokeHistory.js');
const { DEFAULT_BRUSH } = await import('../.build/model/brush.js');

/** 一笔普通笔迹（两个点，便于验证深拷贝与顺序）。 */
function makeStroke(x = 1, y = 2, options = {}) {
  return {
    points: [
      { x: x, y: y },
      { x: x + 1, y: y + 1 }
    ],
    width: options.width === undefined ? DEFAULT_PEN_WIDTH : options.width,
    color: options.color === undefined ? DEFAULT_PEN_COLOR : options.color,
    erase: options.erase === true,
    brush: options.brush === undefined ? DEFAULT_BRUSH : options.brush
  };
}

/** 一笔橡皮笔迹。 */
function makeEraser(x = 5, y = 5) {
  return makeStroke(x, y, { width: ERASER_WIDTH, erase: true });
}

describe('StrokeHistory：撤销深度', () => {
  test('追加 25 笔后 undoDepth=25；连续撤销 20 次（MIN_UNDO_DEPTH）仍成功，长度递减到剩 5 笔', () => {
    const history = new StrokeHistory(1);
    for (let index = 0; index < 25; index++) {
      history.push(0, makeStroke(index, index));
    }
    assert.equal(MIN_UNDO_DEPTH, 20);
    assert.equal(history.undoDepth(0), 25, '不设历史上限：25 笔全部可撤销');
    assert.equal(history.canUndo(0), true);

    for (let step = 1; step <= MIN_UNDO_DEPTH; step++) {
      const remaining = history.undo(0);
      assert.ok(remaining !== null, `第 ${step} 次撤销应成功（撤销深度至少 ${MIN_UNDO_DEPTH}）`);
      assert.equal(remaining.length, 25 - step, `第 ${step} 次撤销后剩余笔迹数`);
      assert.equal(history.undoDepth(0), 25 - step, 'undoDepth 与返回数组等长');
      assert.equal(remaining.length, history.strokesAt(0).length);
    }

    assert.equal(history.undoDepth(0), 5, '20 次撤销后仍剩 5 笔');
    assert.equal(history.strokesAt(0).length, 5);
    // 剩下的是最早画的 5 笔（顺序不变）
    assert.deepEqual(
      history.strokesAt(0).map((item) => item.points[0].x),
      [0, 1, 2, 3, 4]
    );
    assert.equal(history.canUndo(0), true);
    assert.equal(history.canRedo(0), true);
  });

  test('撤销到空后返回 null、canUndo=false（空页再撤销也安全）', () => {
    const history = new StrokeHistory(1);
    history.push(0, makeStroke(1, 1));
    history.push(0, makeStroke(2, 2));

    assert.deepEqual(
      history.undo(0).map((item) => item.points[0].x),
      [1],
      '撤销 1 次后剩第 1 笔'
    );
    const empty = history.undo(0);
    assert.deepEqual(empty, [], '撤销最后一笔后返回空数组（画布应清空）');
    assert.equal(history.canUndo(0), false);
    assert.equal(history.undo(0), null, '没有可撤销的笔返回 null');
    assert.equal(history.canRedo(0), true, '两笔都进了重做栈');
  });
});

describe('StrokeHistory：重做分支', () => {
  test('undo → push 新笔 → canRedo=false（重做栈被清空）', () => {
    const history = new StrokeHistory(1);
    history.push(0, makeStroke(1, 1));
    history.push(0, makeStroke(2, 2));
    history.undo(0);
    assert.equal(history.canRedo(0), true);

    history.push(0, makeStroke(3, 3));
    assert.equal(history.canRedo(0), false, '画了新笔，旧的重做分支作废');
    assert.equal(history.redo(0), null);
    assert.equal(history.undoDepth(0), 2);
    assert.deepEqual(
      history.strokesAt(0).map((item) => item.points[0].x),
      [1, 3],
      '被撤销的第 2 笔不会回来，新笔记在最后'
    );
  });

  test('undo → redo 恢复顺序与内容（含 erase=true 的橡皮笔迹）', () => {
    const history = new StrokeHistory(1);
    const first = makeStroke(1, 1);
    const eraser = makeEraser(2, 2);
    const third = makeStroke(3, 3, { width: PEN_WIDTHS[4], color: PEN_COLORS[1] });
    history.push(0, first);
    history.push(0, eraser);
    history.push(0, third);

    const afterUndo = history.undo(0);
    assert.deepEqual(afterUndo, [first, eraser], '撤销掉第 3 笔，橡皮与第 1 笔仍在');

    const afterRedo = history.redo(0);
    assert.deepEqual(afterRedo, [first, eraser, third], '重做恢复原顺序与原内容');
    assert.equal(afterRedo.length, 3);

    const stored = history.strokesAt(0);
    assert.equal(stored[1].erase, true, '橡皮笔迹的 erase 标记被保留');
    assert.equal(stored[1].width, ERASER_WIDTH, '橡皮笔宽 = ERASER_WIDTH');
    assert.equal(stored[2].color, PEN_COLORS[1], '颜色被保留');
    assert.equal(stored[2].width, PEN_WIDTHS[4], '笔宽被保留');
    assert.deepEqual(
      stored.map((item) => item.erase),
      [false, true, false]
    );

    // 重做到头返回 null
    assert.equal(history.redo(0), null);
    assert.equal(history.canRedo(0), false);
  });

  test('连续撤销 2 笔后连续重做 2 笔：顺序完全还原（栈序为后进先出）', () => {
    const history = new StrokeHistory(1);
    const strokes = [makeStroke(1, 1), makeStroke(2, 2), makeStroke(3, 3)];
    for (const item of strokes) {
      history.push(0, item);
    }
    history.undo(0); // 去掉第 3 笔
    history.undo(0); // 去掉第 2 笔
    assert.deepEqual(history.strokesAt(0), [strokes[0]]);

    assert.deepEqual(history.redo(0), [strokes[0], strokes[1]], '先恢复第 2 笔');
    assert.deepEqual(history.redo(0), strokes, '再恢复第 3 笔');
    assert.equal(history.canRedo(0), false);
  });
});

describe('StrokeHistory：按页隔离与清空', () => {
  test('page0 记 3 笔、page1 记 1 笔；undo(0) 不影响 page1', () => {
    const history = new StrokeHistory(2);
    history.push(0, makeStroke(1, 1));
    history.push(0, makeStroke(2, 2));
    history.push(0, makeStroke(3, 3));
    history.push(1, makeStroke(9, 9));

    const remaining = history.undo(0);
    assert.equal(remaining.length, 2);
    assert.equal(history.undoDepth(0), 2);
    assert.equal(history.strokesAt(1).length, 1, '别的页笔迹不受影响');
    assert.equal(history.undoDepth(1), 1);
    assert.deepEqual(
      history.strokesAt(1).map((item) => item.points[0].x),
      [9]
    );
    assert.equal(history.canRedo(0), true);
    assert.equal(history.canRedo(1), false, 'page1 没撤销过，重做栈为空');
  });

  test('clearPage(0) 清空笔迹与重做栈，page1 不受影响', () => {
    const history = new StrokeHistory(2);
    history.push(0, makeStroke(1, 1));
    history.push(0, makeStroke(2, 2));
    history.undo(0); // 制造重做栈
    history.push(1, makeStroke(9, 9));

    assert.equal(history.canRedo(0), true);
    history.clearPage(0);

    assert.deepEqual(history.strokesAt(0), [], '笔迹清空');
    assert.equal(history.canRedo(0), false, '重做栈也清空');
    assert.equal(history.undoDepth(0), 0);
    assert.equal(history.canUndo(0), false);
    assert.equal(history.strokesAt(1).length, 1, 'page1 不受影响');
    assert.equal(history.undoDepth(1), 1);
  });

  test('ensurePageCount(5) 后 5 页可写；push 越界页自动扩容；缩小不丢数据', () => {
    const history = new StrokeHistory(1);
    assert.equal(history.pageCount(), 1, '默认 1 页');

    history.ensurePageCount(5);
    assert.equal(history.pageCount(), 5);
    for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
      history.push(pageIndex, makeStroke(pageIndex, pageIndex));
      assert.equal(history.undoDepth(pageIndex), 1, `第 ${pageIndex + 1} 页可写`);
    }

    // 越界页自动扩容（不抛异常）
    history.push(7, makeStroke(7, 7));
    assert.equal(history.pageCount(), 8, 'push 到第 8 页自动扩容到 8 页');
    assert.equal(history.undoDepth(7), 1);
    assert.equal(history.undoDepth(6), 0, '中间补出来的页是空页');

    // 缩小：不抛异常、不丢数据
    history.ensurePageCount(3);
    assert.equal(history.pageCount(), 8, 'ensurePageCount 只增不减');
    assert.equal(history.undoDepth(0), 1, '已有页笔迹保留');
    assert.equal(history.undoDepth(4), 1);
    assert.equal(history.undoDepth(7), 1);
  });
});

describe('StrokeHistory：深拷贝', () => {
  test('strokesAt 返回深拷贝：改点坐标/改笔宽/追加数组都不影响内部状态', () => {
    const history = new StrokeHistory(1);
    history.push(0, makeStroke(1, 2));

    const snapshot = history.strokesAt(0);
    snapshot[0].points[0].x = 999;
    snapshot[0].width = 999;
    snapshot[0].erase = true;
    snapshot.push(makeStroke(9, 9));

    const fresh = history.strokesAt(0);
    assert.equal(fresh.length, 1, '返回值追加元素不影响账本');
    assert.equal(fresh[0].points[0].x, 1, '点坐标未被外部修改');
    assert.equal(fresh[0].width, DEFAULT_PEN_WIDTH, '笔宽未被外部修改');
    assert.equal(fresh[0].erase, false, 'erase 未被外部修改');
  });

  test('undo/redo 返回值也是深拷贝；push 时也不持有调用方对象', () => {
    const history = new StrokeHistory(1);
    const first = makeStroke(1, 1);
    const second = makeStroke(2, 2);
    history.push(0, first);
    history.push(0, second);

    const afterUndo = history.undo(0);
    afterUndo[0].points[0].y = 999;
    assert.equal(history.strokesAt(0)[0].points[0].y, 1, 'undo 返回值是深拷贝');

    const afterRedo = history.redo(0);
    afterRedo[1].points[0].x = 999;
    assert.equal(history.strokesAt(0)[1].points[0].x, 2, 'redo 返回值是深拷贝');

    // 调用方事后改自己传入的 stroke，账本不变
    const third = makeStroke(3, 3);
    history.push(0, third);
    third.points[0].x = 777;
    third.color = '#FFFFFF';
    assert.equal(history.strokesAt(0)[2].points[0].x, 3, 'push 时已深拷贝点');
    assert.equal(history.strokesAt(0)[2].color, DEFAULT_PEN_COLOR, 'push 时已深拷贝颜色');
  });

  test('空 points 的 stroke 仍被记录（只按下没移动也算一笔）', () => {
    const history = new StrokeHistory(1);
    history.push(0, {
      points: [],
      width: DEFAULT_PEN_WIDTH,
      color: DEFAULT_PEN_COLOR,
      erase: false,
      brush: DEFAULT_BRUSH
    });
    assert.equal(history.undoDepth(0), 1);
    assert.deepEqual(history.strokesAt(0)[0].points, []);
    const remaining = history.undo(0);
    assert.deepEqual(remaining, []);
    assert.equal(history.canRedo(0), true);
    assert.deepEqual(history.redo(0)[0].points, [], '重做后空点笔迹也回来了');
  });

  test('笔刷字段：带 brush 的笔画能取回，撤销/重做后 brush 不丢（深拷贝仍保留）', () => {
    const history = new StrokeHistory(1);
    const pencil = makeStroke(1, 1, { brush: 'pencil' });
    const marker = makeStroke(2, 2, { brush: 'marker', width: PEN_WIDTHS[3], color: PEN_COLORS[2] });
    history.push(0, pencil);
    history.push(0, marker);

    assert.deepEqual(
      history.strokesAt(0).map((item) => item.brush),
      ['pencil', 'marker'],
      'strokesAt 取回每笔的 brush'
    );

    const afterUndo = history.undo(0);
    assert.deepEqual(
      afterUndo.map((item) => item.brush),
      ['pencil'],
      '撤销 marker 后只剩 pencil'
    );
    const afterRedo = history.redo(0);
    assert.deepEqual(
      afterRedo.map((item) => item.brush),
      ['pencil', 'marker'],
      '重做后 brush 不丢'
    );
    assert.equal(afterRedo[1].width, PEN_WIDTHS[3]);
    assert.equal(afterRedo[1].color, PEN_COLORS[2]);

    // 深拷贝：改返回值里的 brush 不影响账本
    afterRedo[0].brush = 'highlighter';
    assert.equal(history.strokesAt(0)[0].brush, 'pencil', 'brush 也走深拷贝');
  });
});

describe('StrokeHistory：笔工具常量', () => {
  test('PEN_WIDTHS 5 档升序（新规格 2/3.5/5/7/10）含 3.5；PEN_COLORS ≥4 且首色为黑；橡皮比最粗的笔更宽', () => {
    assert.equal(PEN_WIDTHS.length, 5, '笔粗细 5 档');
    assert.deepEqual(PEN_WIDTHS, [2, 3.5, 5, 7, 10], '5 档是新规格');
    for (let index = 1; index < PEN_WIDTHS.length; index++) {
      assert.ok(PEN_WIDTHS[index] > PEN_WIDTHS[index - 1], `PEN_WIDTHS 必须升序：${PEN_WIDTHS}`);
    }
    assert.ok(PEN_WIDTHS.includes(3.5), '默认笔宽 3.5 必须在预设里');

    assert.ok(PEN_COLORS.length >= 4, '颜色至少 4 种');
    assert.equal(PEN_COLORS[0], '#1A1A1A', '首色是黑');
    for (const color of PEN_COLORS) {
      assert.match(color, /^#[0-9A-Fa-f]{6}$/, `颜色必须是 #RRGGBB：${color}`);
    }

    assert.equal(DEFAULT_PEN_WIDTH, 3.5);
    assert.equal(DEFAULT_PEN_COLOR, '#1A1A1A');
    assert.equal(ERASER_WIDTH, 20);
    assert.equal(MIN_UNDO_DEPTH, 20);
    assert.ok(
      ERASER_WIDTH > PEN_WIDTHS[PEN_WIDTHS.length - 1],
      '橡皮宽度必须大于最粗的笔'
    );
    assert.ok(PEN_WIDTHS.includes(DEFAULT_PEN_WIDTH), 'DEFAULT_PEN_WIDTH 在 PEN_WIDTHS 里');
    assert.ok(PEN_COLORS.includes(DEFAULT_PEN_COLOR), 'DEFAULT_PEN_COLOR 在 PEN_COLORS 里');
  });
});

describe('StrokeHistory：非法入参不抛异常', () => {
  test('push 非法页序被忽略；undo/redo/strokesAt/undoDepth/canUndo/clearPage 越界安全', () => {
    const history = new StrokeHistory(2);
    history.push(0, makeStroke(1, 1));

    // 非法页序：忽略、不抛、不扩容
    for (const bad of [-1, -3, Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.doesNotThrow(() => history.push(bad, makeStroke(2, 2)), `push(${bad}) 不应抛错`);
    }
    assert.equal(history.pageCount(), 2, '非法 push 不得扩容');
    assert.equal(history.undoDepth(0), 1, '非法 push 不得写入任何页');

    // 越界页读取/操作
    assert.equal(history.strokesAt(-3).length, 0);
    assert.deepEqual(history.strokesAt(99), []);
    assert.equal(history.undo(99), null);
    assert.equal(history.redo(99), null);
    assert.equal(history.undoDepth(-1), 0);
    assert.equal(history.undoDepth(99), 0);
    assert.equal(history.canUndo(99), false);
    assert.equal(history.canRedo(99), false);
    assert.doesNotThrow(() => history.clearPage(99));
    assert.doesNotThrow(() => history.clearPage(-1));
    assert.doesNotThrow(() => history.ensurePageCount(Number.NaN));
    assert.equal(history.pageCount(), 2, '非法 ensurePageCount 不改页数');
  });
});
