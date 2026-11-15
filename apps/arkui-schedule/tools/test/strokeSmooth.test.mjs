// 笔迹平滑（`model/strokeSmooth.ts`）测试：二次 B 样条（二次贝塞尔片段链）平滑的契约。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 重点：平滑结果要进 `StrokeHistory` 持久化并用于撤销/重放，因此
// - **点数不变**（不膨胀）、首尾点不动（起笔/收笔位置不漂移）、不产生 NaN；
// - 空/单点/两点/脏输入都安全。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';

// ArkTS 源码写无扩展名的相对 import；Node 的 ESM 不做扩展名推断，这里只为测试进程补 `.js`。
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

const { DEFAULT_SMOOTH_ITERATIONS, MAX_SMOOTH_ITERATIONS, smoothPath } = await import(
  '../.build/model/strokeSmooth.js'
);

const point = (x, y) => ({ x, y });

/** 带锯齿的一条线（y 在 0 / 4 之间抖动）。 */
function jitteredLine(count) {
  const points = [];
  for (let index = 0; index < count; index++) {
    points.push(point(index * 10, index % 2 === 0 ? 0 : 4));
  }
  return points;
}

describe('smoothPath', () => {
  test('点数不变，首尾点完全不动', () => {
    const input = jitteredLine(11);
    const output = smoothPath(input);
    assert.equal(output.length, input.length, '点数不变（不膨胀，重放开销可控）');
    assert.deepEqual(output[0], input[0], '首点不动（起笔位置不漂移）');
    assert.deepEqual(output[output.length - 1], input[input.length - 1], '末点不动（收笔位置不漂移）');
    assert.equal(DEFAULT_SMOOTH_ITERATIONS, 2);
  });

  test('内部点被拉向相邻两点的中点（二次 B 样条 Q[i]=(P[i-1]+2P[i]+P[i+1])/4）', () => {
    const input = [point(0, 0), point(10, 10), point(20, 0)];
    const output = smoothPath(input, 1);
    // 中间点：(0+2×10+20)/4 = 10、(0+2×10+0)/4 = 5
    assert.deepEqual(output, [point(0, 0), point(10, 5), point(20, 0)]);
  });

  test('锯齿被削平（一轮后幅度明显变小，再一轮不再变大 = 收敛）', () => {
    const input = jitteredLine(11);
    const oneRound = smoothPath(input, 1);
    const twoRounds = smoothPath(input, 2);
    const amplitude = (points) => Math.max(...points.map((item) => Math.abs(item.y)));
    assert.equal(amplitude(input), 4, '输入抖动幅度 4');
    assert.ok(amplitude(oneRound) < amplitude(input), `一轮后幅度变小：${amplitude(oneRound)} < 4`);
    assert.ok(amplitude(twoRounds) <= amplitude(oneRound), '再一轮不会反弹');
    assert.equal(twoRounds.length, input.length, '两轮后点数仍不变');
  });

  test('空数组 / 单点 / 两点安全（两点的线段不能被平滑掉）', () => {
    assert.deepEqual(smoothPath([]), []);
    assert.deepEqual(smoothPath([point(3, 4)]), [point(3, 4)]);
    assert.deepEqual(smoothPath([point(0, 0), point(10, 10)]), [point(0, 0), point(10, 10)]);
    assert.deepEqual(smoothPath(null), [], '非数组入参 → 空数组');
    assert.deepEqual(smoothPath(undefined), []);
    assert.doesNotThrow(() => smoothPath(null));
  });

  test('iterations 缺省 2；<=0 原样返回；NaN 回退默认；超大值夹到上限', () => {
    const input = [point(0, 0), point(10, 10), point(20, 0)];
    assert.deepEqual(smoothPath(input, 0), input, '0 轮 = 原样（深拷贝）');
    assert.deepEqual(smoothPath(input, -3), input, '负数轮 = 原样');
    assert.deepEqual(smoothPath(input), smoothPath(input, DEFAULT_SMOOTH_ITERATIONS), '缺省 = 2 轮');
    assert.deepEqual(smoothPath(input, Number.NaN), smoothPath(input, DEFAULT_SMOOTH_ITERATIONS), 'NaN → 默认');
    assert.deepEqual(
      smoothPath(input, 1e9),
      smoothPath(input, MAX_SMOOTH_ITERATIONS),
      '超大轮数夹到 MAX_SMOOTH_ITERATIONS'
    );
    assert.ok(MAX_SMOOTH_ITERATIONS >= 2);
  });

  test('不产生 NaN；非有限输入点被丢弃（其余点仍平滑）', () => {
    const input = [point(0, 0), point(Number.NaN, 5), point(10, 10), point(Number.POSITIVE_INFINITY, 0), point(20, 0)];
    const output = smoothPath(input);
    assert.equal(output.length, 3, '两个脏点被丢弃');
    for (const item of output) {
      assert.ok(Number.isFinite(item.x) && Number.isFinite(item.y), `坐标必须有限：${JSON.stringify(item)}`);
    }
    assert.deepEqual(output[0], point(0, 0));
    assert.deepEqual(output[output.length - 1], point(20, 0));
  });

  test('全是脏点 → 空数组（不抛异常）', () => {
    assert.deepEqual(smoothPath([point(Number.NaN, Number.NaN), null]), []);
  });

  test('不修改入参（输出是新数组 + 新点对象）', () => {
    const input = [point(0, 0), point(10, 10), point(20, 0)];
    const snapshot = JSON.stringify(input);
    const output = smoothPath(input);
    assert.equal(JSON.stringify(input), snapshot, '入参未被修改');
    assert.notEqual(output, input, '返回新数组');
    assert.notEqual(output[0], input[0], '点对象也是新的');
    assert.notEqual(output[1], input[1]);
  });

  test('大轨迹（1000 点）不抛异常且点数不变', () => {
    const input = jitteredLine(1000);
    const output = smoothPath(input);
    assert.equal(output.length, 1000);
    assert.deepEqual(output[0], input[0]);
    assert.deepEqual(output[999], input[999]);
  });
});
