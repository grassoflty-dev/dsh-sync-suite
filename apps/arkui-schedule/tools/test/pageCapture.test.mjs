// OCR 两阶段批处理（`model/pageCapture.ts`）的编排测试：Node 假对象，不依赖 HarmonyOS SDK。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖 Lead 的回归点：
// - 阶段 A 先逐页落盘（3 页 → save 3 次），之后才进入阶段 B 串行 OCR；
// - 第 1 页 OCR 抛错时 attachments 仍是全部 N 页、savedPages=N、所有 PixelMap 均被释放；
// - 取消时已落盘附件保留、剩余 PixelMap 全部释放（release 次数 = N）。
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

// 必须在 registerHooks 之后动态 import，钩子才会对 ocrBatch.js 的内部 import 生效。
const { PageCaptureError, runPageCaptureBatch } = await import('../.build/model/pageCapture.js');

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 每页内容不同的一小段「PNG」字节，用来验证 sha256/附件命名。 */
function pngBytes(pageIndex) {
  return Uint8Array.from([...PNG_MAGIC, pageIndex, (pageIndex * 7) & 0xff, 0x00, 0x01]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 构造假依赖：记录 capture/save/recognize/release/sha256 调用，
 * 并通过 options 注入失败、取消与异常释放。
 */
function createFixture(options = {}) {
  const calls = {
    capture: [],
    save: [],
    recognize: [],
    release: [],
    sha256: []
  };
  const pixelMaps = [];
  const state = {
    cancel: false,
    active: 0,
    maxActive: 0,
    /** 每次 recognize 开始时阶段 A 已落盘的页数（用于证明「先全部落盘再 OCR」）。 */
    savesBeforeRecognize: []
  };

  const deps = {
    async capturePage(pageIndex) {
      calls.capture.push(pageIndex);
      await sleep(0);
      if (options.failCaptureAt === pageIndex) {
        throw new Error(`capture failure #${pageIndex}`);
      }
      const pixelMap = { pageIndex, released: false };
      pixelMaps[pageIndex] = pixelMap;
      return { pixelMap, bytes: pngBytes(pageIndex) };
    },
    async savePageAttachment(pageIndex, sha256, bytes) {
      calls.save.push({ pageIndex, sha256, bytes });
      if (options.failSaveAt === pageIndex) {
        throw new Error(`save failure #${pageIndex}`);
      }
      if (typeof options.onSave === 'function') {
        options.onSave(pageIndex, state);
      }
    },
    async recognize(pixelMap, pageIndex) {
      calls.recognize.push(pageIndex);
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
      pixelMaps[pixelMap.pageIndex] = pixelMap;
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

  return { deps, calls, pixelMaps, state };
}

function attachmentNamesFor(pageCount) {
  const names = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    names.push(`${sha256Hex(pngBytes(pageIndex))}.png`);
  }
  return names;
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

    // 每页 release 恰好 1 次，且全部释放
    assert.deepEqual(calls.release, [0, 1, 2], '每页识别完成立即释放');
    assert.equal(calls.release.length, 3);
    assert.ok(
      pixelMaps.every((pixelMap) => pixelMap.released === true),
      '所有 PixelMap 都必须被释放'
    );
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

    // Lead 的回归点：OCR 失败不影响「手迹先全部落盘」
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
    assert.ok(
      pixelMaps.every((pixelMap) => pixelMap.released === true),
      '失败后不得残留 PixelMap'
    );
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
    assert.ok(pixelMaps.every((pixelMap) => pixelMap.released === true));
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
    assert.equal(pixelMaps[0].released, true);
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
    assert.ok(pixelMaps.every((pixelMap) => pixelMap.released === true));
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
    assert.ok(
      fixture.pixelMaps.every((pixelMap) => pixelMap.released === true),
      '未处理的 PixelMap 全部释放'
    );
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
    assert.equal(fixture.pixelMaps[0].released, true);
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
