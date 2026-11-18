// 重入闸的**并发行为**回归（C 批稳定性：连点同步 / 启动 pull 与回前台 pull 撞车）。
//
// 为什么不直接 import `GitSyncService.ets`：它 import 了 `@kit.ArkWeb` / `@kit.CoreFileKit` /
// `@kit.NetworkKit`，在 Node 里没有这些模块（也不该为了测试去 mock SDK）。所以这里测的是
// service 里那段「判定 + 置位 + finally 放闸」的**同款包装器**，闸本身来自 `model/syncGuard.ts`
// 的真实实现（`beginExclusive` / `busyRejection` / `endExclusive`）。
// service 侧是静态接线（第一行抢闸、finally 放闸），靠 code review + 运行时文案验证。
//
// 锁死四件事：
//   a) 两个并发入口：第二个被拒，且返回 E_BUSY + 可读中文（不是异常、不是排队）；
//   b) 第一个 finally 之后，第三个能进（状态真的被清）；
//   c) 第一个**抛异常**时状态也被清（try/finally，不许只测 happy path）；
//   d) 文案里不含 undefined / null / 裸错误码。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  beginExclusive,
  busyRejection,
  endExclusive,
  idleRunState,
  SYNC_BUSY_CODE,
  SYNC_ACTION_PULL,
  SYNC_ACTION_PUSH,
  SYNC_ACTION_STATUS
} = await import('../.build/model/syncGuard.js');

/** 手动控制完成时机的 promise（用来把「在飞」这个窗口卡住）。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 与 `GitSyncService.beginRun()` / `endRun()` 等价的临界区包装器。
 *
 * 关键点与 service 一一对应：
 * 1. `beginExclusive` 是**同步**调用的（在 `run` 返回之前就置位）——这就是「判定必须在第一个
 *    await 之前」的意义；
 * 2. 抢不到闸 → 立刻 resolve 成结构化失败（不抛、不排队）；
 * 3. 抢到闸 → `try { await task() } finally { endExclusive(state, action) }`，异常/正常都放闸；
 * 4. 只读动作（`status`）`acquired === false` → 不进 `finally` 放闸（不碰写动作的闸）。
 */
function createGate() {
  const state = idleRunState();
  return {
    state,
    busy() {
      return state.action.length > 0;
    },
    run(action, task) {
      const begin = beginExclusive(state, action);
      if (!begin.ok) {
        return Promise.resolve({ ok: false, code: SYNC_BUSY_CODE, message: begin.message, value: undefined });
      }
      const body = async () => {
        try {
          const value = await task();
          return { ok: true, code: '', message: '', value };
        } finally {
          // service 里同款位置：成功、失败、超时、提前 return 都会走到；带 owner 校验
          if (begin.acquired) {
            endExclusive(state, action);
          }
        }
      };
      return body();
    }
  };
}

describe('重入闸：并发行为', () => {
  test('a) 两个并发 pull：第二个被拒（E_BUSY + 中文原因），不是异常也不是排队', async () => {
    const gate = createGate();
    const first = deferred();
    let entered = 0;

    const run1 = gate.run(SYNC_ACTION_PULL, async () => {
      entered += 1;
      return first.promise;
    });
    // 关键断言：抢闸是同步完成的（第二个调用还没发生，状态就已经是「在跑」）
    assert.equal(gate.busy(), true, '判定 + 置位必须在第一个 await 之前同步完成');
    assert.equal(gate.state.action, SYNC_ACTION_PULL);

    const run2 = gate.run(SYNC_ACTION_PULL, async () => {
      entered += 1;
      return 'should-not-run';
    });
    const result2 = await run2;
    assert.equal(result2.ok, false);
    assert.equal(result2.code, SYNC_BUSY_CODE, '忙拒绝必须用 E_BUSY，不是 E_INPUT');
    assert.ok(result2.message.length > 0, '必须给可读原因');
    assert.ok(result2.message.includes('还没结束'), '用户要看得懂：' + result2.message);
    assert.equal(entered, 1, '第二个入口不得真正开始（不排队、不静默并行）');

    first.resolve('done-1');
    const result1 = await run1;
    assert.equal(result1.ok, true);
    assert.equal(result1.value, 'done-1');
  });

  test('b) 第一个 finally 之后，第三个能进（状态确实被清）', async () => {
    const gate = createGate();
    const result1 = await gate.run(SYNC_ACTION_PULL, async () => 'first');
    assert.equal(result1.ok, true);
    assert.equal(gate.busy(), false, '正常完成后必须放闸');
    assert.equal(busyRejection(gate.state, SYNC_ACTION_PULL), '', '空闲时不得再报忙');

    const result3 = await gate.run(SYNC_ACTION_PULL, async () => 'third');
    assert.equal(result3.ok, true);
    assert.equal(result3.value, 'third');
    assert.equal(gate.busy(), false);
  });

  test('c) 第一个抛异常：状态也要被清，第三个能进（不许卡死在忙）', async () => {
    const gate = createGate();
    const result1 = gate.run(SYNC_ACTION_PULL, async () => {
      throw new Error('桥调用超时');
    });
    await assert.rejects(result1, /桥调用超时/);
    assert.equal(gate.busy(), false, '异常路径必须放闸（否则永久「忙」）');
    assert.equal(busyRejection(gate.state, SYNC_ACTION_PULL), '');

    const result3 = await gate.run(SYNC_ACTION_PUSH, async () => 'after-throw');
    assert.equal(result3.ok, true);
    assert.equal(result3.value, 'after-throw');
  });

  test('c2) 被拒的那次不会误放闸（持有者继续持有）', async () => {
    const gate = createGate();
    const first = deferred();
    const run1 = gate.run(SYNC_ACTION_PULL, async () => first.promise);
    const rejected = await gate.run(SYNC_ACTION_PUSH, async () => 'nope');
    assert.equal(rejected.ok, false);
    assert.equal(gate.state.action, SYNC_ACTION_PULL, '被拒的调用不得清掉别人的闸');
    first.resolve('done');
    await run1;
    assert.equal(gate.busy(), false);
  });

  test('d) 并发拒绝文案：不含 undefined / null / 裸错误码', async () => {
    const gate = createGate();
    const first = deferred();
    const run1 = gate.run(SYNC_ACTION_PULL, async () => first.promise);
    const rejected = await gate.run(SYNC_ACTION_PUSH, async () => 'nope');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.message.includes('undefined'), false, rejected.message);
    assert.equal(rejected.message.includes('null'), false, rejected.message);
    assert.equal(rejected.message.includes('NaN'), false, rejected.message);
    assert.equal(/E_[A-Z_]+/.test(rejected.message), false, '文案里不许出现裸错误码：' + rejected.message);
    assert.ok(rejected.message.includes('拉取') && rejected.message.includes('推送'), rejected.message);
    first.resolve('done');
    await run1;
  });

  test('e) status 与写动作并发：status 放行且不影响写动作的持有状态', async () => {
    const gate = createGate();
    const first = deferred();
    const run1 = gate.run(SYNC_ACTION_PULL, async () => first.promise);
    const statusResult = await gate.run(SYNC_ACTION_STATUS, async () => 'status-ok');
    assert.equal(statusResult.ok, true);
    assert.equal(gate.state.action, SYNC_ACTION_PULL, 'status 结束后不得把写动作的闸清掉');
    first.resolve('done');
    await run1;
    assert.equal(gate.busy(), false);
  });

  test('f) 串行三次不同写动作：全部成功（不会因为「上一次」残留而误拒）', async () => {
    const gate = createGate();
    const order = [];
    for (const action of [SYNC_ACTION_PULL, SYNC_ACTION_PUSH, SYNC_ACTION_PULL]) {
      const result = await gate.run(action, async () => {
        order.push(action);
        return action;
      });
      assert.equal(result.ok, true);
    }
    assert.deepEqual(order, [SYNC_ACTION_PULL, SYNC_ACTION_PUSH, SYNC_ACTION_PULL]);
  });
});
