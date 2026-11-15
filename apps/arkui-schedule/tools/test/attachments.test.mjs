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
  buildArchivedAttachmentRefs,
  dayArchiveName,
  zipEntryName,
  parseZipEntryName,
  isLegacyAttachment,
  isDayArchiveName,
  parseAttachmentList,
  jpegFileName,
  ATTACHMENT_JPEG_QUALITY,
  ATTACHMENT_MAX_SIDE,
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

// ---------------------------------------------------------------------------
// 2026-11 附件改造：JPEG 压缩 + 按天 zip
// 用户原话：「附件需要进 git，可以每天的压缩上传，手写内容对画质要求也不高。」
// ---------------------------------------------------------------------------

test('JPEG 参数常量：quality 60、最长边 1440（一页目标 ≤150KB）', () => {
  assert.equal(ATTACHMENT_JPEG_QUALITY, 60);
  assert.equal(ATTACHMENT_MAX_SIDE, 1440);
});

test('jpegFileName：`<sha256>.jpg`（大写归一化为小写）', () => {
  assert.equal(jpegFileName(SHA_A), `${SHA_A}.jpg`);
  assert.equal(jpegFileName(SHA_A.toUpperCase()), `${SHA_A}.jpg`);
});

test('dayArchiveName：`YYYY-MM-DD.zip`，非法日期抛错', () => {
  assert.equal(dayArchiveName('2026-11-15'), '2026-11-15.zip');
  assert.equal(isDayArchiveName('2026-11-15.zip'), true);
  assert.equal(isDayArchiveName('2026-11-15.png'), false);
  assert.throws(() => dayArchiveName('2026-1-5'), /日期不合法/);
  assert.throws(() => dayArchiveName(''), /日期不合法/);
});

test('zipEntryName：`page-<页号>-<sha8>.jpg`，页号 0 起、非法页号按 0', () => {
  assert.equal(zipEntryName(0, SHA_A), 'page-0-aaaaaaaa.jpg');
  assert.equal(zipEntryName(3, SHA_A), 'page-3-aaaaaaaa.jpg');
  assert.equal(zipEntryName(-5, SHA_A), 'page-0-aaaaaaaa.jpg');
  assert.equal(zipEntryName(2.7, SHA_A), 'page-2-aaaaaaaa.jpg');
});

test('parseZipEntryName：合法条目解析出页号与 sha8，非法返回 null', () => {
  assert.deepEqual(parseZipEntryName('page-2-1a2b3c4d.jpg'), { pageIndex: 2, sha8: '1a2b3c4d' });
  for (const bad of ['page-2-1a2b3c4d.png', 'evil.jpg', 'page--1a2b3c4d.jpg', 'page-2-1A2B3C4D.jpg', '']) {
    assert.equal(parseZipEntryName(bad), null, `应拒绝：${bad}`);
  }
});

test('buildArchivedAttachmentRefs：新格式带 archive + entry，按页序去重', () => {
  const refs = buildArchivedAttachmentRefs(
    [
      { sha256: SHA_A, pageIndex: 1 },
      { sha256: 'b'.repeat(64), pageIndex: 0 },
      { sha256: 'c'.repeat(64), pageIndex: 1 } // 同页后者覆盖前者
    ],
    '2026-11-15'
  );
  assert.equal(refs.length, 2, '同一页只保留一条');
  assert.deepEqual(
    refs.map((item) => item.pageIndex),
    [0, 1],
    '必须按页序升序'
  );
  assert.deepEqual(refs[0], {
    sha256: 'b'.repeat(64),
    name: `page-0-bbbbbbbb.jpg`,
    pageIndex: 0,
    archive: '2026-11-15.zip',
    entry: 'page-0-bbbbbbbb.jpg'
  });
  assert.equal(refs[1].sha256, 'c'.repeat(64), '同页后写覆盖先写');
});

test('parseAttachmentList：新格式带 archive/entry；旧格式无 archive 仍可读', () => {
  const legacy = JSON.stringify([{ sha256: SHA_A, name: `${SHA_A}.png`, pageIndex: 0 }]);
  const parsedLegacy = parseAttachmentList(legacy);
  assert.equal(parsedLegacy.length, 1);
  assert.equal(parsedLegacy[0].archive, undefined, '旧数据不应凭空长出 archive');
  assert.equal(isLegacyAttachment(parsedLegacy[0]), true, '旧数据判定必须为 legacy');

  const fresh = JSON.stringify([
    { sha256: SHA_A, name: 'page-0-aaaaaaaa.jpg', pageIndex: 0, archive: '2026-11-15.zip', entry: 'page-0-aaaaaaaa.jpg' }
  ]);
  const parsedFresh = parseAttachmentList(fresh);
  assert.equal(parsedFresh.length, 1);
  assert.equal(parsedFresh[0].archive, '2026-11-15.zip');
  assert.equal(parsedFresh[0].entry, 'page-0-aaaaaaaa.jpg');
  assert.equal(isLegacyAttachment(parsedFresh[0]), false, '新数据不是旧格式');
});

test('parseAttachmentList：坏 archive/entry 退回旧格式（不丢整条）', () => {
  const json = JSON.stringify([
    { sha256: SHA_A, name: 'x.png', pageIndex: 0, archive: '2026-11-15', entry: 'page-0-aaaaaaaa.jpg' },
    { sha256: 'b'.repeat(64), name: 'y.png', pageIndex: 1, archive: '2026-11-15.zip', entry: '../../evil.jpg' }
  ]);
  const list = parseAttachmentList(json);
  assert.equal(list.length, 2, '不该因为 archive/entry 坏了就丢条目');
  for (const item of list) {
    assert.equal(item.archive, undefined, `${item.sha256} 的坏 archive 必须被丢掉`);
    assert.equal(isLegacyAttachment(item), true);
  }
});

test('parseAttachmentList：坏 sha256 / 坏 pageIndex 仍然跳过', () => {
  const json = JSON.stringify([
    { sha256: 'not-a-sha', name: 'a.png', pageIndex: 0 },
    { sha256: SHA_A, name: 'b.png', pageIndex: 'x' },
    { sha256: 'c'.repeat(64), name: 'c.png', pageIndex: 2 }
  ]);
  const list = parseAttachmentList(json);
  assert.equal(list.length, 1);
  assert.equal(list[0].pageIndex, 2);
});
