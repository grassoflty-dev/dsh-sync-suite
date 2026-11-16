/**
 * `devecocli ui layout` 解析器单测（固定样例，不依赖真机）。
 *
 * 覆盖真实踩过的坑：
 * - 输出前缀 `- Dumping layout…` 与 PowerShell 的 stderr 混入；
 * - ANSI 颜色码（`[31m` 等）；
 * - JSON 前有空行/警告行；
 * - 输出被截断、无 JSON、节点为空。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripAnsi,
  extractJsonArray,
  parseLayoutOutput,
  layoutTexts,
  findByText,
  centerOf,
  screenSize
} from '../layout-parse.mjs';

const SAMPLE_CLEAN = `[
  {
    "bounds": [0, 0, 1600, 2560],
    "children": [
      { "type": "Text", "text": "今天", "bounds": [19, 147, 1194, 213] },
      { "type": "Text", "text": "新建", "bounds": [57, 2380, 1543, 2494], "clickable": true },
      { "id": "hw-page-p1", "type": "Canvas", "bounds": [0, 220, 1600, 2494], "children": [] }
    ]
  }
]`;

const SAMPLE_NOISY = [
  'devecocli.cmd : - Dumping layout…',
  '所在位置 行:1 字符: 42',
  '\u001b[31mWARN\u001b[0m some warning line',
  '',
  SAMPLE_CLEAN,
  '',
  '- done'
].join('\r\n');

describe('layout-parse：devecocli ui layout 输出解析', () => {
  it('干净输出：解析出扁平节点，含 text/id/bounds', () => {
    const flat = parseLayoutOutput(SAMPLE_CLEAN);
    // 根节点（仅 bounds）也会被收集 → 根 + 2 个 Text + 1 个 Canvas = 4
    assert.equal(flat.length, 4);
    const texts = layoutTexts(flat);
    assert.deepEqual(texts, ['今天', '新建']);
    const canvas = flat.find((n) => n.id === 'hw-page-p1');
    assert.ok(canvas, '应保留无 text 但有 id 的节点');
    assert.deepEqual(canvas.bounds, [0, 220, 1600, 2494]);
  });

  it('噪声输出：跳过 "Dumping layout…" 前缀、stderr 提示与 ANSI 颜色', () => {
    const flat = parseLayoutOutput(SAMPLE_NOISY);
    assert.deepEqual(layoutTexts(flat), ['今天', '新建']);
  });

  it('ANSI 转义被剥离（stripAnsi）', () => {
    assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
    assert.equal(stripAnsi('a\u001b[1;32mb\u001b[0mc'), 'abc');
  });

  it('extractJsonArray：从首行 "[" 起截到最后一个 "]"', () => {
    const json = extractJsonArray(SAMPLE_NOISY);
    assert.ok(json.startsWith('['));
    assert.ok(json.endsWith(']'));
    assert.doesNotThrow(() => JSON.parse(json));
  });

  it('无 JSON 数组 → 抛错并带原文尾部', () => {
    assert.throws(
      () => parseLayoutOutput('- Dumping layout…\nno json here'),
      /找不到 JSON 数组/
    );
  });

  it('JSON 被截断 → 抛错（不静默返回空）', () => {
    assert.throws(() => parseLayoutOutput('[\n  { "text": "今天", "bounds": [1,2,3,4]'), /找不到 JSON 数组|解析失败/);
  });

  it('空数组 → 抛错（页面未渲染）', () => {
    assert.throws(() => parseLayoutOutput('[]'), /没有任何节点/);
  });

  it('findByText / centerOf / screenSize 便于断言', () => {
    const flat = parseLayoutOutput(SAMPLE_CLEAN);
    const create = findByText(flat, '新建');
    assert.deepEqual(centerOf(create), [800, 2437]);
    assert.deepEqual(screenSize(flat), { w: 1600, h: 2560 });
    assert.equal(findByText(flat, '不存在'), undefined);
  });

  it('嵌套 children 会被递归摊平（含数组形式的根）', () => {
    const nested = `[{"bounds":[0,0,100,100],"children":[{"type":"Column","bounds":[0,0,100,100],"children":[{"text":"深层","bounds":[1,2,3,4]}]}]}]`;
    const flat = parseLayoutOutput(nested);
    assert.ok(layoutTexts(flat).includes('深层'));
  });
});
