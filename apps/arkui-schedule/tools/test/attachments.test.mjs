// 附件命名 / 分页拼接 / 表格公式占位符 / 区域占位符测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// `attachments.ts` 会运行期 import `./regions`（无扩展名，ArkTS 要求）；
// Node 的 ESM 不做扩展名推断，这里只为测试进程补 `.js` 后缀。
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
  STRUCTURED_PLACEHOLDER,
  attachmentFileName,
  buildAttachmentRefs,
  composePageBody,
  concatPageTexts,
  replaceComplexBlocks
} = await import('../.build/model/attachments.js');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

/** 合法的小区域框（归一化坐标，边长 > MIN_REGION_SIDE）。 */
function box(y, x = 0.1, w = 0.3, h = 0.2) {
  return { x, y, w, h };
}

test('attachmentFileName：`<sha256>.png`，大写摘要归一化为小写', () => {
  assert.equal(attachmentFileName(SHA_A), `${SHA_A}.png`);
  assert.equal(attachmentFileName(SHA_A.toUpperCase()), `${SHA_A}.png`);
});

test('attachmentFileName：非法摘要抛错（防止路径注入）', () => {
  assert.throws(() => attachmentFileName(''), /sha256/);
  assert.throws(() => attachmentFileName('../../etc/passwd'), /sha256/);
  assert.throws(() => attachmentFileName('abc'), /sha256/);
});

test('buildAttachmentRefs：按 pageIndex 升序，缺 name 时回退为 `<sha>.png`', () => {
  const refs = buildAttachmentRefs([
    { sha256: SHA_B, name: `${SHA_B}.png`, pageIndex: 2 },
    { sha256: SHA_A, name: '', pageIndex: 0 },
    { sha256: SHA_B, name: '第二页.png', pageIndex: 1 }
  ]);
  assert.deepEqual(refs, [
    { sha256: SHA_A, name: `${SHA_A}.png`, pageIndex: 0 },
    { sha256: SHA_B, name: '第二页.png', pageIndex: 1 },
    { sha256: SHA_B, name: `${SHA_B}.png`, pageIndex: 2 }
  ]);
});

test('buildAttachmentRefs：含路径分隔符的 name 被替换为安全文件名', () => {
  const refs = buildAttachmentRefs([{ sha256: SHA_A, name: '../../evil.png', pageIndex: 0 }]);
  assert.equal(refs[0].name, `${SHA_A}.png`);
});

test('buildAttachmentRefs：非法 sha256 抛错，pageIndex 归一化为非负整数', () => {
  assert.throws(() => buildAttachmentRefs([{ sha256: 'nope', name: 'x.png', pageIndex: 0 }]), /sha256/);
  const refs = buildAttachmentRefs([{ sha256: SHA_A, name: `${SHA_A}.png`, pageIndex: 1.7 }]);
  assert.equal(refs[0].pageIndex, 1);
});

test('concatPageTexts：0→N 顺序拼接、空页跳过、页间单换行、每页去首尾空白', () => {
  assert.equal(concatPageTexts(['第一页\n', '   ', '', '第二页  ']), '第一页\n第二页');
  assert.equal(concatPageTexts([]), '');
  assert.equal(concatPageTexts(['', '  \n ']), '');
  assert.equal(concatPageTexts(['单页']), '单页');
  assert.equal(concatPageTexts(['一', '二', '三']), '一\n二\n三');
});

test('STRUCTURED_PLACEHOLDER 常量值符合契约', () => {
  assert.equal(STRUCTURED_PLACEHOLDER, '[公式/图表: 查看手迹]');
});

test('replaceComplexBlocks：表格整块只保留一个占位符', () => {
  const input = ['会议记录', '', '| 项目 | 负责人 |', '| --- | --- |', '| 排期 | 我 |', '', '结论：按期交付'].join('\n');
  const expected = ['会议记录', '', STRUCTURED_PLACEHOLDER, '', '结论：按期交付'].join('\n');
  assert.equal(replaceComplexBlocks(input), expected);
});

test('replaceComplexBlocks：行间公式与 LaTeX 命令行被替换', () => {
  assert.equal(
    replaceComplexBlocks('公式如下：\n$$E = mc^2$$\n解释文字'),
    `公式如下：\n${STRUCTURED_PLACEHOLDER}\n解释文字`
  );
  assert.equal(replaceComplexBlocks('\\frac{a}{b}\n普通行'), `${STRUCTURED_PLACEHOLDER}\n普通行`);
  assert.equal(replaceComplexBlocks('行内 $x^2$ 说明'), STRUCTURED_PLACEHOLDER);
  assert.equal(replaceComplexBlocks('+----+----+\n| a | b |'), STRUCTURED_PLACEHOLDER);
});

test('replaceComplexBlocks：普通中文/金额文本原样保留', () => {
  const plain = ['今天买了牛奶', '预算 $5 到 $10 元', '单价 ¥200', '第二行 |', '', '结束'].join('\n');
  assert.equal(replaceComplexBlocks(plain), plain);
  assert.equal(replaceComplexBlocks(''), '');
  assert.equal(replaceComplexBlocks('纯文本无表格'), '纯文本无表格');
});

test('replaceComplexBlocks：CRLF 输入按行处理且保留空行结构', () => {
  const input = '第一行\r\n| a | b |\r\n第二行';
  assert.equal(replaceComplexBlocks(input), `第一行\n${STRUCTURED_PLACEHOLDER}\n第二行`);
});

// ---------------------------------------------------------------------------
// composePageBody：文字页正文 + 该页框选区域的占位符
// ---------------------------------------------------------------------------

test('composePageBody：契约样例 —— 甲页 2 个乱序框、乙页无框，占位符按 y 升序插在甲之后', () => {
  // 第 1 页给的是 y=0.7 再 y=0.2（乱序），正文里区域 1 必须是 y=0.2 那个
  const body = composePageBody(['甲', '乙'], [[box(0.7), box(0.2)], []]);
  assert.equal(
    body,
    ['甲', '[图表/公式: 查看手迹 · 第1页·区域1]', '[图表/公式: 查看手迹 · 第1页·区域2]', '乙'].join('\n')
  );
  assert.equal(body.split('\n').length, 4);
});

test('composePageBody：占位符跟在自己的页后面，不串页', () => {
  const body = composePageBody(['甲', '乙', '丙'], [[box(0.5)], [], [box(0.1)]]);
  assert.equal(
    body,
    ['甲', '[图表/公式: 查看手迹 · 第1页·区域1]', '乙', '丙', '[图表/公式: 查看手迹 · 第3页·区域1]'].join('\n')
  );
});

test('composePageBody：文字页为空但有区域 → 只剩占位符', () => {
  assert.equal(composePageBody([''], [[box(0.3)]]), '[图表/公式: 查看手迹 · 第1页·区域1]');
  assert.equal(composePageBody(['   '], [[box(0.3), box(0.6)]]), [
    '[图表/公式: 查看手迹 · 第1页·区域1]',
    '[图表/公式: 查看手迹 · 第1页·区域2]'
  ].join('\n'));
});

test('composePageBody：pageRegions 缺失/短于 pageTexts → 该页按无区域拼接', () => {
  assert.equal(composePageBody(['一', '二'], undefined), '一\n二');
  assert.equal(composePageBody(['一', '二'], []), '一\n二');
  assert.equal(composePageBody(['一', '二'], [[]]), '一\n二');
  assert.equal(composePageBody(['一', '二'], [[], []]), '一\n二');
});

test('composePageBody：文字页去首尾空白、表格/公式行降级为占位符，区域占位符紧随其后', () => {
  assert.equal(composePageBody(['  记录  ', '   '], []), '记录');
  assert.equal(composePageBody(['| a | b |'], []), STRUCTURED_PLACEHOLDER);
  assert.equal(
    composePageBody(['| a | b |'], [[box(0.1), box(0.9)]]),
    [
      STRUCTURED_PLACEHOLDER,
      '[图表/公式: 查看手迹 · 第1页·区域1]',
      '[图表/公式: 查看手迹 · 第1页·区域2]'
    ].join('\n')
  );
});

test('composePageBody：脏区域（NaN/零面积/过小）被丢弃，不抛异常；重叠框都保留', () => {
  const dirty = [
    { x: Number.NaN, y: 0.1, w: 0.2, h: 0.2 },
    { x: 0, y: 0, w: 0, h: 0 },
    { x: 0.5, y: 0.5, w: 0.001, h: 0.001 },
    box(0.2),
    box(0.25)
  ];
  assert.equal(
    composePageBody(['文字'], [dirty]),
    ['文字', '[图表/公式: 查看手迹 · 第1页·区域1]', '[图表/公式: 查看手迹 · 第1页·区域2]'].join('\n')
  );
});

test('composePageBody：空输入返回空串；全空页不产生空行', () => {
  assert.equal(composePageBody([], []), '');
  assert.equal(composePageBody([], undefined), '');
  assert.equal(composePageBody(['', '  '], [[], []]), '');
});
