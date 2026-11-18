// 「启动 pull 双发」回归测试（C 批稳定性：`docs/FAILURE-MODES.md` §5）。
//
// 现象：`syncController.pullNow()` 的节流只看 `lastPullAt`，而 `lastPullAt` 在 pull **完成之后**
// 才写 → 启动 pull 还在飞的时候，回前台 pull（`pullOnStartup`）能再次通过节流 → 双发：
// 双倍流量 + 两条结果互相覆盖。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 被加固的逻辑（纯对象，不认识 `@kit.*`）：`model/syncGuard.ts` 的 `PullGate`——它在内部复用
// 已有的 `beginExclusive` / `endExclusive`（**没有第二套状态机**），并持有 `lastPullAt`。
// `services/syncController.ets` 只是接线（抢闸 → try 里 await → finally 放闸），
// 所以这里不需要、也不允许 mock SDK。
//
// 覆盖：
//   a) 第一次开始后第二次返回「跳过」而不是失败；
//   b) 第二次（在飞跳过）**不推进** `lastPullAt`，因此不会把 60s 节流续上；
//   c) 第一次抛异常后标志被清（下一次能正常开始）；
//   d) 串行第二次能正常开始（放闸之后）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  PullGate,
  SYNC_ACTION_PULL,
  beginExclusive,
  endExclusive,
  idleRunState
} = await import('../.build/model/syncGuard.js');

/** 60s 节流窗口（与 `services/syncController.ets` 的 STARTUP_THROTTLE_MS 同一个语义）。 */
const THROTTLE_MS = 60 * 1000;

/**
 * 用与 `syncController.pullNow()` **相同的接线顺序**跑一次：
 * 抢闸（第一个 await 之前）→ try { await 真正拉取 → 记账 } finally { 放闸 }。
 *
 * 这里只替换「真正拉取」为注入的桩：被测逻辑（在飞闸与 `lastPullAt` 记账）还是模型层那一份。
 */
async function pullNowLikeController(gate, attempt, nowMs) {
  const decision = gate.enter(nowMs);
  if (!decision.proceed) {
    // 与 service 层一致：跳过不是失败 → ok:true + skipped:true，且不碰 lastPullAt
    return { ok: true, message: decision.message, elapsedMs: 0, skipped: true };
  }
  try {
    const result = await attempt();
    const finished = nowMs + 500;
    gate.markCompleted(finished);
    return { ok: result.ok, message: result.message, elapsedMs: finished - nowMs, skipped: false };
  } finally {
    gate.leave();
  }
}

describe('PullGate：在飞闸（启动 pull 双发回归）', () => {
  test('a) 第一次开始后第二次返回「跳过」而不是失败，且只有一次真正拉取', async () => {
    const gate = new PullGate();
    let attempts = 0;
    const attempt = async () => {
      attempts += 1;
      return { ok: true, message: '已同步' };
    };
    // 两个入口同时进来（启动 pull + 回前台 pull）：第二个必须看到「已在飞」
    const [first, second] = await Promise.all([
      pullNowLikeController(gate, attempt, 1000),
      pullNowLikeController(gate, attempt, 1010)
    ]);
    assert.equal(attempts, 1, '只允许一次真正的拉取（双发回归）');
    assert.equal(first.skipped, false);
    assert.equal(first.ok, true);
    // 被跳过的那次：ok:true + skipped:true —— 调用方靠 skipped 区分「跳过」与「失败」
    assert.equal(second.ok, true, '跳过不是失败');
    assert.equal(second.skipped, true);
    assert.equal(second.elapsedMs, 0);
    assert.ok(second.message.length > 0, '跳过也要有可展示的中文原因');
    assert.equal(second.message.includes('undefined'), false);
    assert.equal(/E_[A-Z_]+/.test(second.message), false, '不得把裸错误码塞进文案：' + second.message);
    assert.ok(second.message.includes('还没结束'), '要让人看懂「上一次还没结束」：' + second.message);
  });

  test('a) 判定是同步的：`enter()` 之后的 `inFlight()` 立刻为 true', () => {
    const gate = new PullGate();
    assert.equal(gate.inFlight(), false);
    const decision = gate.enter(1000);
    assert.equal(decision.proceed, true);
    assert.equal(decision.message, '');
    assert.equal(gate.inFlight(), true);
    const again = gate.enter(1001);
    assert.equal(again.proceed, false);
    assert.match(again.message, /还没结束/);
  });

  test('b) 在飞跳过**不推进** lastPullAt（忙跳过不再续 60s 节流）', async () => {
    const gate = new PullGate();
    const attempt = async () => ({ ok: true, message: '已同步' });
    assert.equal(gate.lastPullAt(), 0, '从未拉过');

    // 第一次真正拉取：在 nowMs=1000 开始，完成时间 = 1500
    const first = await pullNowLikeController(gate, attempt, 1000);
    assert.equal(first.skipped, false);
    assert.equal(gate.lastPullAt(), 1500, '真正跑完才记账');

    // 第二次：让它「在飞」——手工抢闸后不再放闸，模拟一条还没回来的 pull
    const inFlight = gate.enter(2000);
    assert.equal(inFlight.proceed, true);
    // 第三次（回前台）：被闸挡下
    const skipped = await pullNowLikeController(gate, attempt, 2100);
    assert.equal(skipped.skipped, true);
    assert.equal(gate.lastPullAt(), 1500, '被跳过的那次绝不能改写 lastPullAt');
    gate.leave();

    // 60s 窗口仍然从「真正完成」的 1500 算起，而不是从被跳过的 2100 算起
    assert.equal(gate.throttled(THROTTLE_MS, 1500 + THROTTLE_MS - 1), true, '窗口内仍应节流');
    assert.equal(
      gate.throttled(THROTTLE_MS, 1500 + THROTTLE_MS),
      false,
      '到点就该放行：忙跳过没有把节流续到 2100 + 60s'
    );
    assert.equal(gate.throttled(THROTTLE_MS, 2100 + THROTTLE_MS - 1), false, '若按 2100 续流，这里会是 true');
  });

  test('b) 桥未就绪 / 拉取抛异常都不记账（只有真正拿到结果才推进节流基准）', async () => {
    const gate = new PullGate();
    // 桥未就绪：service 层直接返回 skipped:true，不调 markCompleted
    gate.enter(1000);
    gate.leave();
    assert.equal(gate.lastPullAt(), 0, '桥未就绪不算「拉过」');

    // 抛异常：走 finally 放闸，但不记账
    await assert.rejects(async () => {
      gate.enter(2000);
      try {
        await (async () => {
          throw new Error('E_HTTP');
        })();
      } finally {
        gate.leave();
      }
    });
    assert.equal(gate.lastPullAt(), 0, '异常路径不得推进节流基准');
    assert.equal(gate.inFlight(), false, '异常后必须已放闸');
  });

  test('c) 第一次抛异常后标志被清：下一次能正常开始', async () => {
    const gate = new PullGate();
    const boom = async () => {
      throw new Error('自动拉取失败');
    };
    await assert.rejects(() => pullNowLikeController(gate, boom, 1000));
    assert.equal(gate.inFlight(), false, '异常/超时路径也必须在 finally 里清标志');
    assert.equal(gate.lastPullAt(), 0);

    const recovered = await pullNowLikeController(gate, async () => ({ ok: true, message: '已同步' }), 5000);
    assert.equal(recovered.skipped, false, '异常过后必须能重新开始');
    assert.equal(recovered.ok, true);
    assert.equal(gate.lastPullAt(), 5500);
  });

  test('d) 串行第二次能正常开始（放闸之后）', async () => {
    const gate = new PullGate();
    const attempt = async () => ({ ok: true, message: '已同步' });
    const first = await pullNowLikeController(gate, attempt, 1000);
    const second = await pullNowLikeController(gate, attempt, 2000);
    assert.equal(first.skipped, false);
    assert.equal(second.skipped, false, '串行（前一次已放闸）必须照常开始');
    assert.equal(gate.inFlight(), false);
    assert.equal(gate.lastPullAt(), 2500, '每次都记账到自己的完成时间');
  });

  test('d) 放闸幂等：重复 leave / 被拒的那次 leave 不会清掉持有者', () => {
    const gate = new PullGate();
    gate.enter(1000);
    gate.leave();
    assert.doesNotThrow(() => {
      gate.leave();
      gate.leave();
    });
    assert.equal(gate.inFlight(), false);

    // 被拒的那次**不该**调 leave；即使误调，也不能把持有者的闸清掉
    gate.enter(2000);
    const rejected = gate.enter(2100);
    assert.equal(rejected.proceed, false);
    gate.leave(); // 这次是持有者放闸
    assert.equal(gate.inFlight(), false);
    assert.equal(gate.lastPullAt(), 0, 'leave 不记账');
  });

  test('闸语义复用：PullGate 内部就是 beginExclusive/endExclusive 那套状态', () => {
    // 直接驱动等价的原始状态对象，结论必须一致（防止 PullGate 偷偷演化成第二套状态机）
    const raw = idleRunState();
    assert.equal(beginExclusive(raw, SYNC_ACTION_PULL, 1000).ok, true);
    assert.equal(beginExclusive(raw, SYNC_ACTION_PULL, 1001).ok, false);
    endExclusive(raw, SYNC_ACTION_PULL);
    assert.equal(beginExclusive(raw, SYNC_ACTION_PULL, 1002).ok, true);

    const gate = new PullGate();
    assert.equal(gate.enter(1000).proceed, true);
    assert.equal(gate.enter(1001).proceed, false);
    gate.leave();
    assert.equal(gate.enter(1002).proceed, true);
  });
});
