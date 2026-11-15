// 两阶段批处理（`model/pageCapture.ts`）的编排测试：Node 假对象，不依赖 HarmonyOS SDK。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖：
// - 阶段 A 先逐页落盘（原始截图，含框内内容），之后才进入阶段 B 串行 OCR；
// - 阶段 B 有区域框的页：release 原图 → maskPage 填白 → 二次截图 → recognize → release 遮罩图；
// - 任何失败（截图/落盘/填白/遮罩截图/OCR）都抛 PageCaptureError 且 attachments 仍是全部 N 页；
// - 取消时已落盘附件保留、剩余 PixelMap 全部释放。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';

import { sha256Hex } from '../.build/model/sha256.js';

// Node 的 ESM 解析不做扩展名推断（`import './attachments'` 找不到 `attachments.js`），
// 而 ArkTS/HarmonyOS 源码必须写无扩展名的相对 import（validate 规则 2 也要求不能带 .js）。
// 这里用 Node 官方 module.registerHooks 只为**测试进程**的模块解析补 `.js` 后缀：
// 被测源码保持 ArkTS 原样，测试跑到的是 tsc 编译出的真实实现。
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

// 必须在 registerHooks 之后动态 import，钩子才会对 pageCapture.js 的内部 import 生效。
const { PageCaptureError, runPageCaptureBatch } = await import('../.build/model/pageCapture.js');
const { composePageBody } = await import('../.build/model/attachments.js');
const { regionsToMaskRects, sortRegionsByY } = await import('../.build/model/regions.js');

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 每页内容不同的一小段「PNG」字节，用来验证 sha256/附件命名。 */
function pngBytes(pageIndex) {
  return Uint8Array.from([...PNG_MAGIC, pageIndex, (pageIndex * 7) & 0xff, 0x00, 0x01]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 合法区域框（归一化坐标）。 */
function box(x, y, w = 0.3, h = 0.2) {
  return { x, y, w, h };
}

/**
 * 构造假依赖：记录 capture/save/mask/recognize/release/sha256 调用与**事件顺序**，
 * 并通过 options 注入失败、取消、缺失遮罩能力等场景。
 */
function createFixture(options = {}) {
  const calls = {
    capture: [],
    save: [],
    mask: [],
    recognize: [],
    release: [],
    sha256: []
  };
  /** 所有创建过的 PixelMap（按创建顺序；有框页会创建 2 个）。 */
  const pixelMaps = [];
  const state = {
    cancel: false,
    active: 0,
    maxActive: 0,
    /** 每次 recognize 开始时阶段 A 已落盘的页数（证明「先全部落盘再 OCR」）。 */
    savesBeforeRecognize: [],
    /** 每页截图次数（阶段 A 1 次；有框页遮罩后再 1 次）。 */
    captureCounts: {},
    /** 每次 recognize 收到的 pixelMap（用来确认识别的是遮罩图）。 */
    recognizePixels: [],
    /** 全局事件流（`capture:N` / `save:N` / `mask:N` / `recognize:N` / `release:N`）。 */
    events: []
  };

  const deps = {
    async capturePage(pageIndex) {
      calls.capture.push(pageIndex);
      state.events.push(`capture:${pageIndex}`);
      const attempt = (state.captureCounts[pageIndex] || 0) + 1;
      state.captureCounts[pageIndex] = attempt;
      await sleep(0);
      if (options.failCaptureAt === pageIndex && attempt === 1) {
        throw new Error(`capture failure #${pageIndex}`);
      }
      if (options.failMaskedCaptureAt === pageIndex && attempt > 1) {
        throw new Error(`masked capture failure #${pageIndex}`);
      }
      const pixelMap = { pageIndex, attempt, masked: attempt > 1, released: false };
      pixelMaps.push(pixelMap);
      return { pixelMap, bytes: pngBytes(pageIndex) };
    },
    async savePageAttachment(pageIndex, sha256, bytes) {
      calls.save.push({ pageIndex, sha256, bytes });
      state.events.push(`save:${pageIndex}`);
      if (options.failSaveAt === pageIndex) {
        throw new Error(`save failure #${pageIndex}`);
      }
      if (typeof options.onSave === 'function') {
        options.onSave(pageIndex, state);
      }
    },
    async maskPage(pageIndex, regions) {
      calls.mask.push({ pageIndex, regions });
      state.events.push(`mask:${pageIndex}`);
      if (options.failMaskAt === pageIndex) {
        throw new Error(`mask failure #${pageIndex}`);
      }
      if (typeof options.onMask === 'function') {
        options.onMask(pageIndex, state);
      }
    },
    async recognize(pixelMap, pageIndex) {
      calls.recognize.push(pageIndex);
      state.events.push(`recognize:${pageIndex}`);
      state.recognizePixels.push({ pageIndex, pixelMap });
      state.savesBeforeRecognize.push(calls.save.length);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        await sleep(1);
        if (options.failRecognizeAt === pageIndex) {
          throw new Error(`ocr failure #${pageIndex}`);
        }
        if (typeof options.onRecognize === 'function') {
          options.onRecognize(pageIndex, state);
        }
        if (options.emptyResultAt === pageIndex) {
          return '';
        }
        return `第${pageIndex}页文本`;
      } finally {
        state.active -= 1;
      }
    },
    release(pixelMap) {
      calls.release.push(pixelMap.pageIndex);
      state.events.push(`release:${pixelMap.pageIndex}`);
      if (options.releaseThrowsAt === pixelMap.pageIndex) {
        throw new Error(`release failure #${pixelMap.pageIndex}`);
      }
      pixelMap.released = true;
    },
    sha256(bytes) {
      calls.sha256.push(bytes);
      return options.fakeSha256 === undefined ? sha256Hex(bytes) : options.fakeSha256;
    }
  };

  // 模拟「设备/适配层没有填白能力」：有框时批次必须报错，而不是把框内文字送 OCR。
  if (options.noMask === true) {
    delete deps.maskPage;
  }

  return { deps, calls, pixelMaps, state };
}

function attachmentNamesFor(pageCount) {
  const names = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    names.push(`${sha256Hex(pngBytes(pageIndex))}.png`);
  }
  return names;
}

/** 断言全部 PixelMap（含遮罩图）都被释放。 */
function assertAllReleased(pixelMaps) {
  assert.ok(
    pixelMaps.every((pixelMap) => pixelMap.released === true),
    '所有 PixelMap（含遮罩图）都必须被释放'
  );
}

describe('runPageCaptureBatch：正常两阶段', () => {
  test('3 页：先全部落盘（save 3 次）再串行 OCR，results 按 pageIndex 对齐，每页 release 1 次', async () => {
    const { deps, calls, pixelMaps, state } = createFixture();
    const outcome = await runPageCaptureBatch(3, deps);

    // 阶段 A：逐页截图 + 落盘
    assert.deepEqual(calls.capture, [0, 1, 2], '阶段 A 必须按 0→N 顺序逐页截图');
    assert.deepEqual(
      calls.save.map((item) => item.pageIndex),
      [0, 1, 2],
      '阶段 A 必须把每一页都落盘'
    );
    assert.equal(calls.save.length, 3);
    assert.equal(calls.sha256.length, 3, '每页落盘前都计算一次 sha256');
    assert.equal(outcome.savedPages, 3);

    // 阶段 B：串行识别，且第 1 页识别时 3 页都已落盘
    assert.deepEqual(calls.recognize, [0, 1, 2], '阶段 B 必须按 pageIndex 升序串行识别');
    assert.deepEqual(state.savesBeforeRecognize, [3, 3, 3], 'OCR 开始时全部截图必须已经落盘');
    assert.equal(state.maxActive, 1, '串行：同一时刻只能有 1 页在识别');

    // 结果对齐
    assert.deepEqual(outcome.results, ['第0页文本', '第1页文本', '第2页文本']);
    assert.equal(outcome.failedPage, null);
    assert.equal(outcome.attachments.length, 3);
    assert.deepEqual(
      outcome.attachments.map((item) => item.pageIndex),
      [0, 1, 2]
    );
    assert.deepEqual(
      outcome.attachments.map((item) => item.name),
      attachmentNamesFor(3),
      '附件名复用 `<sha256>.png`'
    );
    assert.deepEqual(
      outcome.attachments.map((item) => item.sha256),
      [0, 1, 2].map((pageIndex) => sha256Hex(pngBytes(pageIndex)))
    );
    // 保存的字节与页内容一致（不串页）
    assert.deepEqual(
      calls.save.map((item) => Array.from(item.bytes)),
      [0, 1, 2].map((pageIndex) => Array.from(pngBytes(pageIndex)))
    );

    // 无区域框：不做填白、没有二次截图
    assert.deepEqual(calls.mask, [], '没有区域框时不得调用 maskPage');
    assert.equal(outcome.maskedPages, 0);
    assert.deepEqual(outcome.pageRegions, [[], [], []], 'pageRegions 长度 = 总页数');

    // 每页 release 恰好 1 次，且全部释放
    assert.deepEqual(calls.release, [0, 1, 2], '每页识别完成立即释放');
    assert.equal(calls.release.length, 3);
    assertAllReleased(pixelMaps);
  });

  test('识别结果为空串时仍按 pageIndex 对齐（不塌缩、不补位）', async () => {
    const { deps } = createFixture({ emptyResultAt: 1 });
    const outcome = await runPageCaptureBatch(3, deps);
    assert.equal(outcome.results.length, 3);
    assert.deepEqual(outcome.results, ['第0页文本', '', '第2页文本']);
    assert.equal(outcome.attachments.length, 3);
  });

  test('单页也能跑通（0→1）', async () => {
    const { deps, calls } = createFixture();
    const outcome = await runPageCaptureBatch(1, deps);
    assert.deepEqual(calls.save.map((item) => item.pageIndex), [0]);
    assert.deepEqual(calls.release, [0]);
    assert.deepEqual(outcome.results, ['第0页文本']);
    assert.equal(outcome.attachments.length, 1);
    assert.equal(outcome.savedPages, 1);
  });

  test('sha256 依赖返回大写摘要时，附件名归一化为小写', async () => {
    const upper = 'A'.repeat(64);
    const { deps, calls } = createFixture({ fakeSha256: upper });
    const outcome = await runPageCaptureBatch(2, deps);
    assert.equal(calls.sha256.length, 2);
    assert.deepEqual(
      outcome.attachments.map((item) => item.name),
      [`${'a'.repeat(64)}.png`, `${'a'.repeat(64)}.png`]
    );
    assert.deepEqual(
      outcome.attachments.map((item) => item.sha256),
      ['a'.repeat(64), 'a'.repeat(64)]
    );
  });

  test('pageCount 为 0 时给出中文错误', async () => {
    const { deps } = createFixture();
    await assert.rejects(() => runPageCaptureBatch(0, deps), /没有可识别的手写页/);
    await assert.rejects(() => runPageCaptureBatch(-3, deps), /没有可识别的手写页/);
  });
});

describe('runPageCaptureBatch：OCR 失败（回归点）', () => {
  test('第 1 页 OCR 抛错：attachments 仍为 N 个、savedPages=N、全部 PixelMap 释放、错误含 pageIndex', async () => {
    const { deps, calls, pixelMaps } = createFixture({ failRecognizeAt: 0 });

    const failure = await runPageCaptureBatch(3, deps).then(
      () => null,
      (error) => error
    );

    assert.ok(failure instanceof Error, 'OCR 失败必须抛错');
    assert.ok(failure instanceof PageCaptureError, '必须是带上下文的 PageCaptureError');
    assert.equal(failure.pageIndex, 0, '错误必须带失败页码');
    assert.match(failure.message, /第 1 页 OCR 识别失败/);
    assert.match(failure.message, /3 页截图已全部落盘/, '错误信息要提示截图已兜底');

    // 回归点：OCR 失败不影响「手迹先全部落盘」
    assert.equal(calls.save.length, 3, '阶段 A 的 3 次落盘都必须完成');
    assert.equal(failure.savedPages, 3);
    assert.equal(failure.attachments.length, 3, 'attachments 必须包含全部 N 页');
    assert.deepEqual(
      failure.attachments.map((item) => item.pageIndex),
      [0, 1, 2]
    );
    assert.deepEqual(
      failure.attachments.map((item) => item.name),
      attachmentNamesFor(3)
    );

    // 失败页 + 未处理页全部释放；失败前无结果
    assert.deepEqual(calls.recognize, [0]);
    assert.deepEqual(calls.release.slice().sort(), [0, 1, 2]);
    assert.equal(calls.release.length, 3);
    assertAllReleased(pixelMaps);
    assert.deepEqual(failure.results, []);
  });

  test('中间页（第 2 页）OCR 抛错：前面已识别结果保留在 error.results，附件仍是 3 页', async () => {
    const { deps, calls, pixelMaps } = createFixture({ failRecognizeAt: 1 });
    const failure = await runPageCaptureBatch(3, deps).then(
      () => null,
      (error) => error
    );

    assert.equal(failure.pageIndex, 1);
    assert.match(failure.message, /第 2 页 OCR 识别失败/);
    assert.equal(failure.attachments.length, 3);
    assert.deepEqual(failure.results, ['第0页文本']);
    assert.deepEqual(calls.recognize, [0, 1]);
    assert.deepEqual(calls.release.slice().sort(), [0, 1, 2]);
    assertAllReleased(pixelMaps);
  });

  test('阶段 A 截图失败：错误带页码，已落盘页的 PixelMap 也被释放', async () => {
    const { deps, calls, pixelMaps } = createFixture({ failCaptureAt: 1 });
    const failure = await runPageCaptureBatch(3, deps).then(
      () => null,
      (error) => error
    );

    assert.equal(failure.pageIndex, 1);
    assert.match(failure.message, /第 2 页截图\/落盘失败/);
    assert.equal(failure.savedPages, 1);
    assert.equal(failure.attachments.length, 1);
    assert.deepEqual(calls.save.map((item) => item.pageIndex), [0]);
    assert.deepEqual(calls.recognize, [], '阶段 A 失败不得进入 OCR');
    assert.deepEqual(calls.release, [0], '已落盘页的 PixelMap 必须释放');
    assertAllReleased(pixelMaps);
  });

  test('阶段 A 落盘失败：该页 PixelMap 与已落盘页一起释放，不会双重释放', async () => {
    const { deps, calls, pixelMaps } = createFixture({ failSaveAt: 1 });
    const failure = await runPageCaptureBatch(3, deps).then(
      () => null,
      (error) => error
    );

    assert.equal(failure.pageIndex, 1);
    assert.match(failure.message, /已落盘 1 页/);
    assert.equal(failure.savedPages, 1);
    assert.equal(failure.attachments.length, 1);
    assert.deepEqual(calls.release.slice().sort(), [0, 1]);
    assertAllReleased(pixelMaps);
  });

  test('deps.release 抛错被吞掉，不中断整批识别', async () => {
    const { deps } = createFixture({ releaseThrowsAt: 0 });
    const outcome = await runPageCaptureBatch(3, deps);
    assert.deepEqual(outcome.results, ['第0页文本', '第1页文本', '第2页文本']);
    assert.equal(outcome.attachments.length, 3);
  });
});

describe('runPageCaptureBatch：取消', () => {
  test('识别完第 1 页即取消：results 只含已识别页，剩余 PixelMap 全部释放（release 次数 = N）', async () => {
    const fixture = createFixture({
      onRecognize(pageIndex, state) {
        if (pageIndex === 0) {
          state.cancel = true;
        }
      }
    });
    const outcome = await runPageCaptureBatch(3, fixture.deps, { cancelled: () => fixture.state.cancel });

    assert.equal(outcome.failedPage, null);
    assert.deepEqual(outcome.results, ['第0页文本'], 'results 只含已识别页');
    assert.equal(outcome.attachments.length, 3, '阶段 A 已落盘的附件必须保留');
    assert.equal(outcome.savedPages, 3);
    assert.equal(fixture.calls.recognize.length, 1, '取消后不再识别后续页');
    assert.deepEqual(fixture.calls.recognize, [0]);
    assert.equal(fixture.calls.release.length, 3, '每页恰好释放一次（3 页 = 3 次）');
    assert.deepEqual(fixture.calls.release.slice().sort(), [0, 1, 2]);
    assertAllReleased(fixture.pixelMaps);
  });

  test('阶段 A 落盘第 1 页后取消：保留已落盘页，该页 PixelMap 释放、不再识别', async () => {
    const fixture = createFixture({
      onSave(pageIndex, state) {
        if (pageIndex === 0) {
          state.cancel = true;
        }
      }
    });
    const outcome = await runPageCaptureBatch(3, fixture.deps, { cancelled: () => fixture.state.cancel });

    assert.equal(outcome.failedPage, null);
    assert.equal(outcome.savedPages, 1);
    assert.equal(outcome.attachments.length, 1, '已落盘的附件保留');
    assert.deepEqual(outcome.results, []);
    assert.deepEqual(fixture.calls.recognize, [], '取消后不得进入 OCR');
    assert.deepEqual(fixture.calls.release, [0]);
    assertAllReleased(fixture.pixelMaps);
  });

  test('开始前就取消：不截图、不落盘、不释放', async () => {
    const { deps, calls } = createFixture();
    const outcome = await runPageCaptureBatch(3, deps, { cancelled: () => true });

    assert.equal(outcome.savedPages, 0);
    assert.deepEqual(outcome.attachments, []);
    assert.deepEqual(outcome.results, []);
    assert.deepEqual(calls.capture, []);
    assert.deepEqual(calls.save, []);
    assert.deepEqual(calls.release, []);
  });
});

// ---------------------------------------------------------------------------
// 区域框选：框内不参与 OCR（release 原图 → maskPage 填白 → 二次截图 → recognize）
// ---------------------------------------------------------------------------

describe('runPageCaptureBatch：区域框选', () => {
  test('2 页：第 1 页 2 个框（y 乱序）、第 2 页 0 个框 → attachments=2、recognize 2 次、maskedPages=1', async () => {
    const { deps, calls, pixelMaps } = createFixture();
    const progress = [];
    const outcome = await runPageCaptureBatch(2, deps, {
      pageRegions: [[box(0.1, 0.7), box(0.1, 0.2)], []],
      onProgress: (done, total) => progress.push([done, total])
    });

    // 阶段 A 不变：两页都落盘原始截图（含框内内容）
    assert.deepEqual(calls.save.map((item) => item.pageIndex), [0, 1]);
    assert.equal(outcome.attachments.length, 2);
    assert.equal(outcome.savedPages, 2);

    // 只有第 1 页做了填白 + 二次截图
    assert.equal(calls.mask.length, 1);
    assert.equal(calls.mask[0].pageIndex, 0);
    assert.equal(calls.mask[0].regions.length, 2, '两个框都要填白');
    assert.equal(outcome.maskedPages, 1);
    assert.deepEqual(calls.capture, [0, 1, 0], '阶段 A 两页 + 第 1 页遮罩二次截图');
    assert.equal(calls.sha256.length, 2, '遮罩图不落盘，不算 sha256');

    // 每页都识别 1 次（有框页识别的是遮罩图）
    assert.deepEqual(calls.recognize, [0, 1]);
    assert.deepEqual(outcome.results, ['第0页文本', '第1页文本']);
    assert.equal(outcome.pageRegions.length, 2, 'pageRegions 长度 = 总页数');
    assert.equal(outcome.pageRegions[0].length, 2);
    assert.deepEqual(
      outcome.pageRegions[0].map((item) => item.y),
      [0.7, 0.2],
      'pageRegions 保留输入顺序（排序只发生在生成占位符时）'
    );
    assert.deepEqual(progress, [
      [1, 2],
      [2, 2]
    ]);
    assertAllReleased(pixelMaps);
  });

  test('2 页框选：正文里 2 个占位符按 y 升序，夹在第 1 页文字之后、第 2 页文字之前', async () => {
    const { deps } = createFixture();
    const outcome = await runPageCaptureBatch(2, deps, {
      pageRegions: [[box(0.1, 0.7), box(0.1, 0.2)], []]
    });

    // 排序证据：y 最小（0.2）的框排在前面
    assert.deepEqual(
      sortRegionsByY(outcome.pageRegions[0]).map((item) => item.y),
      [0.2, 0.7]
    );

    const body = composePageBody(outcome.results, outcome.pageRegions);
    assert.equal(
      body,
      [
        '第0页文本',
        '[图表/公式: 查看手迹 · 第1页·区域1]',
        '[图表/公式: 查看手迹 · 第1页·区域2]',
        '第1页文本'
      ].join('\n')
    );
    assert.equal(body.split('\n').length, 4);
    // 占位符数量 = 框数
    assert.equal(body.match(/\[图表\/公式: 查看手迹/g).length, 2);
  });

  test('框覆盖整页（{0,0,1,1}）：maskPage 收到整页矩形，识别为空串时 results[0]==="" 但附件不丢', async () => {
    const { deps, calls } = createFixture({ emptyResultAt: 0 });
    const outcome = await runPageCaptureBatch(2, deps, {
      pageRegions: [[{ x: 0, y: 0, w: 1, h: 1 }], []]
    });

    assert.equal(calls.mask.length, 1);
    assert.deepEqual(calls.mask[0].regions, [{ x: 0, y: 0, w: 1, h: 1 }], '整页框原样传入填白');
    assert.equal(outcome.results[0], '', '框覆盖整页 → 识别结果为空串');
    assert.deepEqual(outcome.results, ['', '第1页文本']);
    assert.equal(outcome.attachments.length, 2, '识别为空不影响已落盘的 N 页附件');
    assert.equal(outcome.savedPages, 2);
    assert.equal(outcome.maskedPages, 1);
    // 正文只剩占位符，不丢页
    assert.equal(
      composePageBody(outcome.results, outcome.pageRegions),
      ['[图表/公式: 查看手迹 · 第1页·区域1]', '第1页文本'].join('\n')
    );
  });

  test('越界/零面积/重叠/NaN：清洗后只保留合法框，填白矩形在画布内，正文不抛异常', async () => {
    const dirty = [
      { x: -0.2, y: -0.2, w: 0.4, h: 0.4 }, // 夹紧成 {0,0,0.2,0.2}
      { x: 0.9, y: 0.5, w: 0.3, h: 0.4 }, // 右侧裁到 1.0
      { x: 0, y: 0, w: 0, h: 0 }, // 零面积 → 丢弃
      { x: Number.NaN, y: 0.1, w: 0.2, h: 0.2 }, // NaN → 丢弃
      { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } // 与第 1 个重叠 → 保留
    ];
    const { deps, calls } = createFixture();
    const outcome = await runPageCaptureBatch(1, deps, { pageRegions: [dirty] });

    assert.equal(outcome.pageRegions[0].length, 3, '脏框只留下 3 个合法框');
    assert.equal(calls.mask[0].regions.length, 3);
    for (const region of calls.mask[0].regions) {
      assert.ok(region.x >= 0 && region.y >= 0, `不得为负：${JSON.stringify(region)}`);
      assert.ok(region.x + region.w <= 1 + 1e-9, `右边不得越界：${JSON.stringify(region)}`);
      assert.ok(region.y + region.h <= 1 + 1e-9, `下边不得越界：${JSON.stringify(region)}`);
    }

    const rects = regionsToMaskRects(calls.mask[0].regions, 100, 50);
    assert.equal(rects.length, 3);
    for (const rect of rects) {
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.w >= 1 && rect.h >= 1, JSON.stringify(rect));
      assert.ok(rect.x + rect.w <= 100 && rect.y + rect.h <= 50, `矩形越界：${JSON.stringify(rect)}`);
    }

    const body = composePageBody(outcome.results, outcome.pageRegions);
    assert.equal(body.match(/\[图表\/公式: 查看手迹/g).length, 3);
    assert.equal(outcome.maskedPages, 1);
  });

  test('事件顺序：所有 save 早于任何 recognize；save→mask→capture(第二次)→recognize，原图先 release', async () => {
    const { deps, state } = createFixture();
    const outcome = await runPageCaptureBatch(2, deps, {
      pageRegions: [[box(0.1, 0.2)], []]
    });

    // 完整事件流（阶段 A → 阶段 B）
    assert.deepEqual(state.events, [
      'capture:0',
      'save:0',
      'capture:1',
      'save:1',
      'release:0', // 原图先释放
      'mask:0', // 再填白
      'capture:0', // 遮罩图（二次截图）
      'recognize:0',
      'release:0', // 遮罩图释放
      'recognize:1',
      'release:1'
    ]);

    const lastSave = state.events.map((event) => event.startsWith('save:')).lastIndexOf(true);
    const firstRecognize = state.events.findIndex((event) => event.startsWith('recognize:'));
    assert.ok(lastSave < firstRecognize, '所有页的落盘都必须早于任何 recognize');

    const releaseIndex = state.events.indexOf('release:0');
    const maskIndex = state.events.indexOf('mask:0');
    assert.ok(releaseIndex < maskIndex, '有框页的原始 PixelMap 必须在 maskPage 之前 release');

    // 识别到的确实是遮罩图（attempt=2），无框页是原图（attempt=1）
    assert.deepEqual(
      state.recognizePixels.map((item) => item.pixelMap.attempt),
      [2, 1]
    );
    assert.equal(state.recognizePixels[0].pixelMap.masked, true);
    assert.deepEqual(state.captureCounts, { 0: 2, 1: 1 });
    assert.equal(outcome.maskedPages, 1);
  });

  test('无区域框：maskPage 完全不被调用、maskedPages=0、results 按页对齐（与改动前一致）', async () => {
    const { deps, calls } = createFixture();
    const outcome = await runPageCaptureBatch(3, deps, { pageRegions: [[], [], []] });

    assert.deepEqual(calls.mask, [], '没有框就不得调用 maskPage');
    assert.equal(outcome.maskedPages, 0);
    assert.deepEqual(calls.capture, [0, 1, 2], '没有二次截图');
    assert.deepEqual(outcome.results, ['第0页文本', '第1页文本', '第2页文本']);
    assert.deepEqual(outcome.pageRegions, [[], [], []]);
  });

  test('有框页 OCR 失败：attachments 仍是全部 N 页、pageRegions 长度 N、无 PixelMap 泄漏', async () => {
    // 3 页，第 2 页有框；第 2 页（遮罩图）OCR 抛错
    const { deps, calls, pixelMaps } = createFixture({ failRecognizeAt: 1 });
    const failure = await runPageCaptureBatch(3, deps, {
      pageRegions: [[], [box(0.2, 0.3)], []]
    }).then(
      () => null,
      (error) => error
    );

    assert.ok(failure instanceof PageCaptureError);
    assert.equal(failure.pageIndex, 1);
    assert.match(failure.message, /第 2 页 OCR 识别失败/);
    assert.match(failure.message, /3 页截图已全部落盘/);
    assert.equal(failure.attachments.length, 3, '有框页失败也不影响已全部落盘的 N 页');
    assert.equal(failure.savedPages, 3);
    assert.deepEqual(failure.results, ['第0页文本']);
    assert.equal(failure.pageRegions.length, 3);
    assert.equal(failure.pageRegions[1].length, 1);
    assert.equal(calls.save.length, 3, '遮罩图不落盘：仍只有 3 次 save');
    assert.equal(calls.mask.length, 1);
    assertAllReleased(pixelMaps);
  });

  test('有框但 deps 未提供 maskPage：抛 PageCaptureError（消息含「未提供遮罩能力」），attachments 仍是 N 页', async () => {
    const { deps, calls, pixelMaps } = createFixture({ noMask: true });
    const failure = await runPageCaptureBatch(2, deps, {
      pageRegions: [[box(0.1, 0.1)], []]
    }).then(
      () => null,
      (error) => error
    );

    assert.ok(failure instanceof PageCaptureError);
    assert.match(failure.message, /第 1 页有区域框但未提供遮罩能力/);
    assert.equal(failure.attachments.length, 2, '错误仍带全部已落盘页');
    assert.equal(failure.savedPages, 2);
    assert.deepEqual(failure.results, [], '没有识别任何页');
    assert.equal(failure.pageRegions.length, 2);
    assert.deepEqual(calls.recognize, [], '不得把框内文字直接送 OCR');
    assert.equal(failure.pageIndex, 0);
    assertAllReleased(pixelMaps);
  });

  test('有框页处理完后取消：已落盘保留、results 是前缀、全部 PixelMap 释放', async () => {
    const fixture = createFixture({
      onRecognize(pageIndex, state) {
        if (pageIndex === 0) {
          state.cancel = true;
        }
      }
    });
    const outcome = await runPageCaptureBatch(2, fixture.deps, {
      pageRegions: [[box(0.1, 0.1)], []],
      cancelled: () => fixture.state.cancel
    });

    assert.equal(outcome.failedPage, null);
    assert.deepEqual(outcome.results, ['第0页文本'], '只处理了第 1 页');
    assert.equal(outcome.attachments.length, 2, '阶段 A 的附件全部保留');
    assert.equal(outcome.savedPages, 2);
    assert.equal(outcome.maskedPages, 1);
    assert.equal(fixture.calls.recognize.length, 1);
    assert.equal(fixture.calls.release.length, 3, '原图 2 个 + 遮罩图 1 个，各释放 1 次');
    assert.deepEqual(fixture.calls.release.slice().sort(), [0, 0, 1]);
    assertAllReleased(fixture.pixelMaps);
  });
});
