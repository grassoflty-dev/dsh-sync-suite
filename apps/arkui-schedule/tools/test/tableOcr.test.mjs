/**
 * 表格逐格 OCR 纯逻辑测试（方案 C）。
 *
 * 覆盖：规模上限、单元格矩形切分（row-major/取整/夹紧）、Markdown 生成
 * （转义、空单元格、列数对齐）、遮罩规则（表格开启识别时不填白）与能力白名单。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TABLE_OCR_MAX_CELLS,
  canOcrTable,
  cellRegions,
  objectsToMask,
  shouldOcrObject,
  tableOcrEnabled,
  tablePlaceholder,
  tableToMarkdown
} from '../.build/model/tableOcr.js';
import { makePageObject } from '../.build/model/pageObjects.js';

const pageW = 1000;
const pageH = 1600;

describe('tableOcr：表格逐格识别', () => {
  it('canOcrTable：≤36 格允许，>36 与非法输入拒绝', () => {
    assert.equal(canOcrTable(1, 1), true);
    assert.equal(canOcrTable(3, 2), true);
    assert.equal(canOcrTable(6, 6), true);
    assert.equal(canOcrTable(6, 7), false);
    assert.equal(canOcrTable(7, 6), false);
    assert.equal(canOcrTable(0, 3), false);
    assert.equal(canOcrTable(3, -1), false);
    assert.equal(canOcrTable(2.5, 3), false);
    assert.equal(canOcrTable(Number.NaN, 3), false);
    assert.equal(canOcrTable(11, 1), false);
    assert.equal(TABLE_OCR_MAX_CELLS, 36);
  });

  it('cellRegions：5×5 → 25 个矩形，row-major 且都在页内', () => {
    const rect = { x: 0.2, y: 0.1, w: 0.6, h: 0.4 };
    const regions = cellRegions(rect, pageW, pageH, 5, 5);
    assert.equal(regions.length, 25);
    // row-major：前 5 个 y 相同、x 递增
    assert.equal(regions[0].y, regions[4].y);
    assert.ok(regions[0].x < regions[4].x);
    // 第二个行组 y 更大
    assert.ok(regions[5].y > regions[0].y);
    for (const r of regions) {
      assert.ok(r.x >= 0 && r.y >= 0);
      assert.ok(r.x + r.w <= pageW, `x+w 越界: ${JSON.stringify(r)}`);
      assert.ok(r.y + r.h <= pageH, `y+h 越界: ${JSON.stringify(r)}`);
      assert.ok(r.w >= 1 && r.h >= 1);
    }
  });

  it('cellRegions：3×2 的单元格覆盖整块表格（首格贴左上、末格贴右下）', () => {
    const rect = { x: 0, y: 0, w: 1, h: 1 };
    const regions = cellRegions(rect, pageW, pageH, 2, 3);
    assert.equal(regions.length, 6);
    assert.deepEqual([regions[0].x, regions[0].y], [0, 0]);
    const last = regions[regions.length - 1];
    assert.equal(last.x + last.w, pageW);
    assert.equal(last.y + last.h, pageH);
  });

  it('cellRegions：非法入参返回空数组（不抛）', () => {
    assert.deepEqual(cellRegions({ x: 0, y: 0, w: 1, h: 1 }, 0, 100, 2, 2), []);
    assert.deepEqual(cellRegions({ x: 0, y: 0, w: 1, h: 1 }, 100, 100, 0, 2), []);
    assert.deepEqual(cellRegions({ x: 0, y: 0, w: 0, h: 1 }, 100, 100, 2, 2), []);
  });

  it('tableToMarkdown：3×2 生成正确的 Markdown 表格', () => {
    const md = tableToMarkdown([
      ['姓名', '年龄'],
      ['张三', '28'],
      ['李四', '31']
    ]);
    assert.equal(md, ['| 姓名 | 年龄 |', '| --- | --- |', '| 张三 | 28 |', '| 李四 | 31 |'].join('\n'));
  });

  it('tableToMarkdown：文本里的 | 被转义，换行折成空格', () => {
    const md = tableToMarkdown([['a|b', 'c\nd']]);
    assert.ok(md.includes('a\\|b'), md);
    assert.ok(md.includes('c d'), md);
  });

  it('tableToMarkdown：空单元格写一个空格，列数对齐', () => {
    const md = tableToMarkdown([['A', 'B', 'C'], ['', 'x']]);
    assert.equal(md, ['| A | B | C |', '| --- | --- | --- |', '|   | x |   |'].join('\n'));
  });

  it('tableToMarkdown：空输入返回空串（调用方回退占位符）', () => {
    assert.equal(tableToMarkdown([]), '');
    assert.equal(tableToMarkdown([[]]), '');
  });

  it('objectsToMask：D1 修复后，开启识别的表格**也**要填白（防正文重复），图片与框同样填白', () => {
    const box = makePageObject('box-1', 'box', { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const image = makePageObject('image-abc', 'image', { x: 0.1, y: 0.3, w: 0.4, h: 0.2 }, { sha256: 'a'.repeat(64), name: 'x.jpg' });
    const table = makePageObject('table-1', 'table', { x: 0.1, y: 0.6, w: 0.6, h: 0.3 }, { rows: 3, cols: 2 });
    const masks = objectsToMask([box, image, table]);
    // D1：表格永远进遮罩 —— 否则页级 OCR 会把表格手写再读一遍，正文出现两份
    assert.equal(masks.length, 3, '三类对象都要填白（含开启识别的表格）');
    assert.deepEqual(masks[0], { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    assert.deepEqual(masks[2], { x: 0.1, y: 0.6, w: 0.6, h: 0.3 }, '表格矩形必须在遮罩里');
  });

  it('objectsToMask：关闭识别（ocrEnabled=false）的表格仍要填白', () => {
    const table = makePageObject('table-2', 'table', { x: 0.1, y: 0.6, w: 0.6, h: 0.3 }, { rows: 3, cols: 2, ocrEnabled: false });
    assert.equal(tableOcrEnabled(table), false);
    assert.equal(objectsToMask([table]).length, 1);
  });

  it('makePageObject：表格默认开启识别，>6×6 强制关闭', () => {
    const ok = makePageObject('t1', 'table', { x: 0, y: 0, w: 1, h: 1 }, { rows: 6, cols: 6 });
    assert.equal(ok.ocrEnabled, true);
    const big = makePageObject('t2', 'table', { x: 0, y: 0, w: 1, h: 1 }, { rows: 7, cols: 6 });
    assert.equal(big.ocrEnabled, false);
    assert.equal(tableOcrEnabled(big), false);
  });

  it('shouldOcrObject：image/table 可识别，box 不可', () => {
    assert.equal(shouldOcrObject(makePageObject('b', 'box', { x: 0, y: 0, w: 1, h: 1 })), false);
    assert.equal(shouldOcrObject(makePageObject('i', 'image', { x: 0, y: 0, w: 1, h: 1 }, { sha256: 'b'.repeat(64), name: 'a.jpg' })), true);
    assert.equal(shouldOcrObject(makePageObject('t', 'table', { x: 0, y: 0, w: 1, h: 1 }, { rows: 2, cols: 2 })), true);
  });

  it('tablePlaceholder：关闭识别时的占位符', () => {
    assert.equal(tablePlaceholder(3, 4, 2), '[表格 3×4: 见附件 · 第2页]');
    assert.equal(tablePlaceholder(3, 4, 0), '[表格 3×4: 见附件 · 第1页]');
  });
});
