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
  SYNC_BUSY_MESSAGE,
  SYNC_BUSY_CODE,
  SYNC_ACTION_PULL,
  SYNC_ACTION_PUSH,
  SYNC_ACTION_REGISTER,
  SYNC_ACTION_STATUS,
  busyRejection,
  describeElapsed,
  beginExclusive,
  endExclusive,
  idleRunState
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

// ---------------------------------------------------------------- 重入闸（C 批稳定性）

describe('busyRejection：重入闸的纯函数判定', () => {
  const run = (action, startedAt) => ({ action, startedAt });

  test('空闲 → 空串（放行）', () => {
    assert.equal(busyRejection(idleRunState(), SYNC_ACTION_PULL), '');
    assert.equal(busyRejection({ action: '', startedAt: 0 }, SYNC_ACTION_PUSH), '');
  });

  test('同一动作在跑 → 拒绝，文案含「还没结束」+ 已跑时长 + 怎么办', () => {
    const message = busyRejection({ action: SYNC_ACTION_PULL, startedAt: 1_000_000 }, SYNC_ACTION_PULL, 1_003_200);
    assert.notEqual(message, '');
    assert.ok(message.includes('还没结束'), '必须能直接展示给用户：' + message);
    assert.ok(message.includes('3.2 秒'), '要带上已跑时长：' + message);
    assert.ok(message.includes('请等它完成再点'), '要告诉用户怎么办：' + message);
  });

  test('pull 在跑时 push 被拒 / push 在跑时 pull 被拒（写动作互斥）', () => {
    const pulling = busyRejection(run(SYNC_ACTION_PULL, 1000), SYNC_ACTION_PUSH, 3000);
    const pushing = busyRejection(run(SYNC_ACTION_PUSH, 1000), SYNC_ACTION_PULL, 3000);
    assert.ok(pulling.includes('还没结束') && pulling.includes('推送'), pulling);
    assert.ok(pushing.includes('还没结束') && pushing.includes('拉取'), pushing);
  });

  test('设备登记也是写动作：与 pull / push 互斥，重复登记也拒', () => {
    assert.notEqual(busyRejection(run(SYNC_ACTION_REGISTER, 1000), SYNC_ACTION_PULL, 2000), '');
    assert.notEqual(busyRejection(run(SYNC_ACTION_PULL, 1000), SYNC_ACTION_REGISTER, 2000), '');
    assert.notEqual(busyRejection(run(SYNC_ACTION_REGISTER, 1000), SYNC_ACTION_REGISTER, 2000), '');
  });

  test('status 只读 → 任何写动作在跑时都放行（不拦状态刷新）', () => {
    for (const action of [SYNC_ACTION_PULL, SYNC_ACTION_PUSH, SYNC_ACTION_REGISTER]) {
      assert.equal(busyRejection(run(action, 1000), SYNC_ACTION_STATUS, 2000), '');
    }
  });

  test('未知/空动作名按写动作保守处理（不会因为动作名拼错就放行）', () => {
    assert.notEqual(busyRejection(run(SYNC_ACTION_PULL, 1000), '', 2000), '');
    assert.notEqual(busyRejection(run(SYNC_ACTION_PULL, 1000), 'fetch', 2000), '');
  });

  test('文案不含裸错误码 / undefined / null（错误码只放结果对象的 code 里）', () => {
    const messages = [
      busyRejection(run(SYNC_ACTION_PULL, 1000), SYNC_ACTION_PULL, 2000),
      busyRejection(run(SYNC_ACTION_PUSH, 1000), SYNC_ACTION_PULL, 2000),
      busyRejection(run(SYNC_ACTION_REGISTER, 1000), SYNC_ACTION_PUSH, 2000)
    ];
    for (const message of messages) {
      assert.equal(/E_[A-Z_]+/.test(message), false, '不得出现裸错误码：' + message);
      assert.equal(message.includes('undefined'), false, '不得把 undefined 拼进文案：' + message);
      assert.equal(message.includes('null'), false, '不得把 null 拼进文案：' + message);
    }
    assert.equal(SYNC_BUSY_CODE, 'E_BUSY');
  });

  test('判定是只读的：忙拒绝不污染状态（持有者继续持有）', () => {
    const state = run(SYNC_ACTION_PULL, 1000);
    busyRejection(state, SYNC_ACTION_PUSH, 5000);
    assert.equal(state.action, SYNC_ACTION_PULL);
    assert.equal(state.startedAt, 1000);
  });

  test('时钟异常（startedAt 在未来 / 为 0）→ 不出现 NaN / 负数时长', () => {
    for (const state of [run(SYNC_ACTION_PULL, 9_999_999), run(SYNC_ACTION_PULL, 0)]) {
      const message = busyRejection(state, SYNC_ACTION_PULL, 1000);
      assert.ok(message.includes('还没结束'), message);
      assert.equal(message.includes('NaN'), false, '不得出现 NaN：' + message);
      assert.equal(message.includes('-'), false, '不得出现负数时长：' + message);
    }
  });
});

describe('describeElapsed：时长文案', () => {
  test('< 1 秒 / 秒级 / 分钟级', () => {
    assert.equal(describeElapsed(0), '不到 1 秒');
    assert.equal(describeElapsed(999), '不到 1 秒');
    assert.equal(describeElapsed(3200), '3.2 秒');
    assert.equal(describeElapsed(59_800), '1 分 0 秒');
    assert.equal(describeElapsed(125_000), '2 分 5 秒');
  });
});

describe('beginExclusive / endExclusive：抢闸与放闸', () => {
  test('空闲时抢到 → 置位；放闸后回到空闲', () => {
    const state = idleRunState();
    const begin = beginExclusive(state, SYNC_ACTION_PULL, 1000);
    assert.equal(begin.ok, true);
    assert.equal(begin.message, '');
    assert.equal(state.action, SYNC_ACTION_PULL);
    assert.equal(state.startedAt, 1000);
    endExclusive(state);
    assert.equal(state.action, '');
    assert.equal(state.startedAt, 0);
  });

  test('在跑时抢闸被拒，且不覆盖原状态', () => {
    const state = idleRunState();
    beginExclusive(state, SYNC_ACTION_PULL, 1000);
    const second = beginExclusive(state, SYNC_ACTION_PUSH, 2000);
    assert.equal(second.ok, false);
    assert.ok(second.message.length > 0);
    assert.equal(state.action, SYNC_ACTION_PULL, '被拒的调用不得改写持有者');
    assert.equal(state.startedAt, 1000);
  });

  test('endExclusive 幂等（重复调用 / undefined / null 都不抛）', () => {
    const state = idleRunState();
    assert.doesNotThrow(() => {
      endExclusive(state);
      endExclusive(state);
      endExclusive(undefined);
      endExclusive(null);
    });
  });
});
