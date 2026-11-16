// 同步前置守卫（纯逻辑）：线上闪退的回归测试。
//
// 现象：设置页点「立即同步」直接闪退。根因是同步入口没有统一守卫 —— 桥（WebView 里的
// isomorphic-git）还没就绪就往下走，最终在 bridge 调用处抛未捕获异常，抛到 UI 线程把进程带走。
//
// 这里锁死三件事：
//   ① 未 ready 调用 → 返回错误对象，**不抛**；
//   ② repoUrl 为空 → 可读中文错误；
//   ③ bridge 抛异常 → 被归一成可展示文案（不抛）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  checkSyncPrecondition,
  describeBridgeFailure,
  BRIDGE_NOT_READY_MESSAGE,
  REPO_EMPTY_MESSAGE,
  SYNC_BUSY_MESSAGE
} = await import('../.build/model/syncGuard.js');

const OK_INPUT = { repoUrl: 'https://github.com/me/repo.git', token: 't', bridgeReady: true };

describe('checkSyncPrecondition：同步前置守卫（闪退回归）', () => {
  test('全部就绪 → ok，且不产生错误码/错误文案', () => {
    const result = checkSyncPrecondition(OK_INPUT);
    assert.equal(result.ok, true);
    assert.equal(result.code, '');
    assert.equal(result.message, '');
  });

  test('① 桥未就绪 → 返回 E_BRIDGE 错误对象，绝不抛异常', () => {
    let result;
    assert.doesNotThrow(() => {
      result = checkSyncPrecondition({ ...OK_INPUT, bridgeReady: false });
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_BRIDGE');
    assert.equal(result.message, BRIDGE_NOT_READY_MESSAGE);
    assert.ok(result.message.length > 0, '必须有可展示的中文原因');
  });

  test('① 输入缺失（undefined/null）→ 同样返回错误对象，不抛', () => {
    for (const input of [undefined, null]) {
      let result;
      assert.doesNotThrow(() => {
        result = checkSyncPrecondition(input);
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'E_BRIDGE');
    }
  });

  test('② repoUrl 为空 / 全空格 → E_CONFIG + 可读中文', () => {
    for (const repoUrl of ['', '   ', '\t\n']) {
      const result = checkSyncPrecondition({ ...OK_INPUT, repoUrl });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'E_CONFIG');
      assert.equal(result.message, REPO_EMPTY_MESSAGE);
    }
  });

  test('忙时优先报 E_BUSY（连点不会重复发起）', () => {
    const result = checkSyncPrecondition({ ...OK_INPUT, busy: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_BUSY');
    assert.equal(result.message, SYNC_BUSY_MESSAGE);
  });

  test('顺序：忙 > 桥 > 地址（桥没好时不先报「地址为空」误导用户）', () => {
    const result = checkSyncPrecondition({ repoUrl: '', token: '', bridgeReady: false, busy: false });
    assert.equal(result.code, 'E_BRIDGE', '桥未就绪必须优先于地址校验');
  });

  test('token 可以留空（公共仓库）：只拦地址为空', () => {
    const result = checkSyncPrecondition({ repoUrl: OK_INPUT.repoUrl, token: '', bridgeReady: true });
    assert.equal(result.ok, true);
  });
});

describe('describeBridgeFailure：bridge 异常归一（不抛）', () => {
  test('③ 普通 Error → 返回其 message', () => {
    assert.equal(describeBridgeFailure(new Error('Web 页面未就绪')), 'Web 页面未就绪');
  });

  test('③ 空 message / undefined / null → 兜底文案，不抛', () => {
    for (const input of [new Error(''), new Error('   '), undefined, null]) {
      let text = '';
      assert.doesNotThrow(() => {
        text = describeBridgeFailure(input);
      });
      assert.ok(text.length > 0, '必须有兜底文案');
      assert.equal(text.includes('undefined'), false, '不得把 undefined 拼进文案');
    }
  });

  test('③ 非 Error 对象（BusinessError 形态）→ 取 message 字段', () => {
    assert.equal(describeBridgeFailure({ code: 17100001, message: 'Init error' }), 'Init error');
  });
});
