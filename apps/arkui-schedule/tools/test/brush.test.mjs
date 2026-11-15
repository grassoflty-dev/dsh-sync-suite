// 笔刷参数（`model/brush.ts`）测试：5 种笔刷的参数表、颜色换算、描边参数、速度调制、铅笔抖动。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 重点：参数表必须与契约逐项一致（UI 的笔刷面板直接照它显示/绘制）；
// 所有函数对脏输入（非法 hex、NaN、越界 alpha、Infinity 速度、越界 rng）都不抛异常。
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

const {
  BRUSHES,
  DEFAULT_BRUSH,
  EXTRA_SPEED_RANGES,
  PRESSURE_MAX,
  PRESSURE_MIN_SCALE,
  brushSpec,
  jitterPoint,
  paintFor,
  pressureWidth,
  pressureWidthScale,
  rgbaFromHex,
  speedWidthScale,
  speedWidthScaleFor,
  usesSpeedWidth
} = await import('../.build/model/brush.js');

/** 契约里的参数表（逐项对照的期望值）。 */
const EXPECTED = [
  {
    kind: 'pen',
    label: '钢笔',
    alpha: 1,
    widthScale: 1,
    jitter: 0,
    speedSensitive: true,
    maxSpeedScale: 1.35,
    minSpeedScale: 0.55
  },
  {
    kind: 'ballpoint',
    label: '圆珠笔',
    alpha: 1,
    widthScale: 1,
    jitter: 0,
    speedSensitive: false,
    maxSpeedScale: 1,
    minSpeedScale: 1
  },
  {
    kind: 'pencil',
    label: '铅笔',
    alpha: 0.7,
    widthScale: 1,
    jitter: 0.3,
    speedSensitive: false,
    maxSpeedScale: 1,
    minSpeedScale: 1
  },
  {
    kind: 'marker',
    label: '马克笔',
    alpha: 0.45,
    widthScale: 1.8,
    jitter: 0,
    speedSensitive: false,
    maxSpeedScale: 1,
    minSpeedScale: 1
  },
  {
    kind: 'highlighter',
    label: '荧光笔',
    alpha: 0.35,
    widthScale: 3,
    jitter: 0,
    speedSensitive: false,
    maxSpeedScale: 1,
    minSpeedScale: 1
  }
];

/** 按顺序返回固定序列的假 rng（序列用完后返回最后一个值）。 */
function sequenceRng(values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

describe('BRUSHES 参数表', () => {
  test('5 种笔刷且顺序固定：pen → ballpoint → pencil → marker → highlighter', () => {
    assert.equal(BRUSHES.length, 5);
    assert.deepEqual(
      BRUSHES.map((item) => item.kind),
      ['pen', 'ballpoint', 'pencil', 'marker', 'highlighter']
    );
    assert.deepEqual(
      BRUSHES.map((item) => item.label),
      ['钢笔', '圆珠笔', '铅笔', '马克笔', '荧光笔']
    );
  });

  test('五种笔刷的 alpha/widthScale/jitter/speedSensitive/max/min 与契约定表逐项一致', () => {
    for (let index = 0; index < EXPECTED.length; index++) {
      const actual = BRUSHES[index];
      const expected = EXPECTED[index];
      assert.deepEqual(actual, expected, `${expected.kind} 的参数必须与契约表一致`);
      assert.equal(actual.alpha, expected.alpha);
      assert.equal(actual.widthScale, expected.widthScale);
      assert.equal(actual.jitter, expected.jitter);
      assert.equal(actual.speedSensitive, expected.speedSensitive);
      assert.equal(actual.maxSpeedScale, expected.maxSpeedScale);
      assert.equal(actual.minSpeedScale, expected.minSpeedScale);
    }
    // 只有铅笔有抖动、只有钢笔吃速度
    assert.deepEqual(
      BRUSHES.filter((item) => item.jitter > 0).map((item) => item.kind),
      ['pencil']
    );
    assert.deepEqual(
      BRUSHES.filter((item) => item.speedSensitive).map((item) => item.kind),
      ['pen']
    );
  });
});

describe('DEFAULT_BRUSH / brushSpec', () => {
  test('DEFAULT_BRUSH 是 pen；brushSpec 返回对应参数', () => {
    assert.equal(DEFAULT_BRUSH, 'pen');
    for (const expected of EXPECTED) {
      assert.deepEqual(brushSpec(expected.kind), expected);
    }
  });

  test('未知/非法 kind 回退 pen（不抛异常）', () => {
    for (const bad of ['xxx', 'PEN', '', undefined, null, 42, {}]) {
      assert.doesNotThrow(() => brushSpec(bad), `brushSpec(${String(bad)}) 不应抛错`);
      assert.equal(brushSpec(bad).kind, 'pen', `brushSpec(${String(bad)}) 应回退 pen`);
      assert.equal(brushSpec(bad).label, '钢笔');
    }
  });

  test('brushSpec 返回副本：改返回值不污染 BRUSHES 表', () => {
    const spec = brushSpec('pen');
    spec.alpha = 0.01;
    spec.label = '坏了';
    assert.equal(BRUSHES[0].alpha, 1, 'BRUSHES 表未被外部修改');
    assert.equal(BRUSHES[0].label, '钢笔');
    assert.equal(brushSpec('pen').alpha, 1);
  });
});

describe('rgbaFromHex', () => {
  test('#D93025 + 0.5 → rgba(217,48,37,0.5)', () => {
    assert.equal(rgbaFromHex('#D93025', 0.5), 'rgba(217,48,37,0.5)');
    assert.equal(rgbaFromHex('#1A1A1A', 1), 'rgba(26,26,26,1)');
    assert.equal(rgbaFromHex('#FFFFFF', 0), 'rgba(255,255,255,0)');
  });

  test('非法 hex 回退 rgba(0,0,0,alpha)，不抛异常', () => {
    for (const bad of ['bad', '', '#12345', '#GGGGGG', 'rgba(1,2,3,1)', null, undefined]) {
      assert.doesNotThrow(() => rgbaFromHex(bad, 1), `rgbaFromHex(${String(bad)}) 不应抛错`);
      assert.ok(rgbaFromHex(bad, 1).startsWith('rgba('), '必须回退成合法 rgba 文案');
      assert.equal(rgbaFromHex(bad, 1), 'rgba(0,0,0,1)');
    }
  });

  test('alpha 夹到 0..1：-1→0、2→1、NaN→0', () => {
    assert.equal(rgbaFromHex('#1A1A1A', -1), 'rgba(26,26,26,0)');
    assert.equal(rgbaFromHex('#1A1A1A', 2), 'rgba(26,26,26,1)');
    assert.equal(rgbaFromHex('#1A1A1A', Number.NaN), 'rgba(26,26,26,0)');
    assert.equal(rgbaFromHex('#1A1A1A', 0.35), 'rgba(26,26,26,0.35)');
  });

  test('大小写与省略 # 都接受', () => {
    assert.equal(rgbaFromHex('#d93025', 0.5), rgbaFromHex('#D93025', 0.5));
    assert.equal(rgbaFromHex('d93025', 0.5), 'rgba(217,48,37,0.5)');
  });
});

describe('paintFor', () => {
  test('ballpoint：source-over、lineWidth=5、不透明黑', () => {
    const paint = paintFor('ballpoint', '#1A1A1A', 5);
    assert.equal(paint.composite, 'source-over');
    assert.equal(paint.lineWidth, 5);
    assert.equal(paint.strokeStyle, 'rgba(26,26,26,1)');
    assert.equal(paint.jitter, 0);
  });

  test('marker：lineWidth=9（5×1.8）、alpha 0.45', () => {
    const paint = paintFor('marker', '#1A1A1A', 5);
    assert.equal(paint.lineWidth, 9);
    assert.equal(paint.strokeStyle, 'rgba(26,26,26,0.45)');
    assert.equal(paint.composite, 'source-over');
    assert.equal(paint.jitter, 0);
  });

  test('highlighter：lineWidth=15（5×3）、strokeStyle 固定荧光黄（忽略传入颜色）', () => {
    const paint = paintFor('highlighter', '#1A1A1A', 5);
    assert.equal(paint.lineWidth, 15);
    assert.equal(paint.strokeStyle, 'rgba(255,235,59,0.35)');
    assert.ok(paint.strokeStyle.includes('255,235,59'));
    // 换颜色也一样是荧光黄
    assert.equal(paintFor('highlighter', '#D93025', 5).strokeStyle, paint.strokeStyle);
    assert.equal(paint.composite, 'source-over');
  });

  test('pencil：alpha 0.7、jitter 0.3、lineWidth 不加倍', () => {
    const paint = paintFor('pencil', '#1A1A1A', 3.5);
    assert.equal(paint.strokeStyle, 'rgba(26,26,26,0.7)');
    assert.equal(paint.lineWidth, 3.5);
    assert.equal(paint.jitter, 0.3);
    assert.equal(paint.composite, 'source-over');
    // 钢笔不吃 widthScale，但 alpha 1
    assert.equal(paintFor('pen', '#1A1A1A', 3.5).lineWidth, 3.5);
    assert.equal(paintFor('pen', '#1A1A1A', 3.5).strokeStyle, 'rgba(26,26,26,1)');
  });

  test('baseWidth 为 0/负数/NaN 时 lineWidth 不小于 0.5（不出现 0）', () => {
    assert.equal(paintFor('pen', '#1A1A1A', 0).lineWidth, 0.5);
    assert.equal(paintFor('marker', '#1A1A1A', 0).lineWidth, 0.5);
    assert.equal(paintFor('ballpoint', '#1A1A1A', -3).lineWidth, 0.5);
    assert.equal(paintFor('ballpoint', '#1A1A1A', Number.NaN).lineWidth, 0.5);
    assert.ok(paintFor('pen', '#1A1A1A', 0).lineWidth > 0);
  });

  test('橡皮：composite=destination-out、alpha 1、lineWidth = baseWidth×4', () => {
    const paint = paintFor('ballpoint', '#1A1A1A', 3.5, true);
    assert.equal(paint.composite, 'destination-out');
    assert.equal(paint.lineWidth, 14, '3.5 × 4 = 14');
    assert.equal(paint.strokeStyle, 'rgba(26,26,26,1)', '橡皮 alpha 1');
    assert.equal(paint.jitter, 0, '橡皮不抖动');

    // 橡皮宽度与笔刷无关：任何笔刷下都是 ×4
    assert.equal(paintFor('highlighter', '#1A1A1A', 5, true).lineWidth, 20);
    assert.equal(paintFor('pen', '#1A1A1A', 5, true).lineWidth, 20);
    assert.equal(paintFor('pen', '#1A1A1A', 0, true).lineWidth, 0.5);
  });
});

describe('speedWidthScale', () => {
  test('pen：speed 0 → 1.35；speed 2 → 0.55；speed ≥2 恒 0.55；0.5 处居中', () => {
    assert.equal(speedWidthScale('pen', 0), 1.35);
    assert.equal(speedWidthScale('pen', 0.5), 1.15, '线性插值：1.35 → 0.55 的四分之一处');
    assert.ok(speedWidthScale('pen', 0.5) < 1.35);
    assert.ok(speedWidthScale('pen', 0.5) > 0.55);
    assert.equal(speedWidthScale('pen', 1), 0.95, '线性插值：1.35 → 0.55 的中点');
    assert.equal(speedWidthScale('pen', 2), 0.55);
    assert.equal(speedWidthScale('pen', 2.5), 0.55);
    assert.equal(speedWidthScale('pen', 100), 0.55);
  });

  test('pen 随速度单调递减（0 → 2 之间）', () => {
    let previous = speedWidthScale('pen', 0);
    for (const speed of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      const current = speedWidthScale('pen', speed);
      assert.ok(current < previous, `speed=${speed} 应更细（${current} < ${previous}）`);
      previous = current;
    }
  });

  test('非 speedSensitive 笔刷恒返回 1（任意速度）', () => {
    for (const kind of ['ballpoint', 'pencil', 'marker', 'highlighter']) {
      for (const speed of [0, 0.3, 1, 2, 10, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
        assert.equal(speedWidthScale(kind, speed), 1, `${kind} 在 speed=${speed} 时应恒为 1`);
      }
    }
  });

  test('非法 speed 不抛异常（NaN/-1 取最粗，Infinity 取最细）', () => {
    assert.equal(speedWidthScale('pen', Number.NaN), 1.35);
    assert.equal(speedWidthScale('pen', -1), 1.35);
    assert.equal(speedWidthScale('pen', Number.NEGATIVE_INFINITY), 1.35);
    assert.equal(speedWidthScale('pen', Number.POSITIVE_INFINITY), 0.55);
    assert.doesNotThrow(() => speedWidthScale('xxx', Number.NaN));
    assert.equal(speedWidthScale('xxx', 0), 1.35, '未知笔刷回退 pen（speedSensitive）');
    assert.equal(speedWidthScale('xxx', 2), 0.55, '未知笔刷回退 pen 的区间');
  });
});

describe('jitterPoint', () => {
  test('amount 0/负数/NaN 原样返回（且是新对象，不修改入参）', () => {
    const point = { x: 10, y: 20 };
    for (const amount of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const result = jitterPoint(point, amount);
      assert.deepEqual(result, { x: 10, y: 20 }, `amount=${amount} 应原样返回`);
      assert.notEqual(result, point, '返回新对象');
    }
    assert.deepEqual(point, { x: 10, y: 20 }, '入参对象未被修改');
  });

  test('注入固定 rng → 结果可预测（angle=0、radius=amount）', () => {
    const rng = sequenceRng([0, 1]);
    const result = jitterPoint({ x: 10, y: 20 }, 2, rng);
    assert.equal(result.x, 12, 'cos(0)×2 = 2');
    assert.equal(result.y, 20, 'sin(0)×2 = 0');
  });

  test('注入固定 rng（angle=90°）→ 只偏移 y', () => {
    const rng = sequenceRng([0.25, 1]);
    const result = jitterPoint({ x: 10, y: 20 }, 2, rng);
    assert.ok(Math.abs(result.x - 10) < 1e-9, `x 几乎不变：${result.x}`);
    assert.ok(Math.abs(result.y - 22) < 1e-9, `y = 20 + 2：${result.y}`);
  });

  test('抖动半径始终 ≤ amount（随机 200 次）', () => {
    for (const amount of [0.1, 0.3, 1, 5]) {
      for (let index = 0; index < 200; index++) {
        const origin = { x: 3, y: 7 };
        const result = jitterPoint(origin, amount);
        const distance = Math.hypot(result.x - origin.x, result.y - origin.y);
        assert.ok(distance <= amount + 1e-9, `距离 ${distance} 超过 amount ${amount}`);
      }
    }
  });

  test('注入非法 rng 值（越界/NaN）也不产生 NaN 坐标', () => {
    for (const values of [
      [2, 2],
      [-1, -1],
      [Number.NaN, Number.NaN],
      [0.5, Number.POSITIVE_INFINITY]
    ]) {
      const result = jitterPoint({ x: 1, y: 1 }, 1, sequenceRng(values));
      assert.ok(Number.isFinite(result.x), `x 必须有限：${result.x}`);
      assert.ok(Number.isFinite(result.y), `y 必须有限：${result.y}`);
      const distance = Math.hypot(result.x - 1, result.y - 1);
      assert.ok(distance <= 1 + 1e-9);
    }
  });

  test('不传 rng 也能用（默认 Math.random），结果在半径内', () => {
    const result = jitterPoint({ x: 0, y: 0 }, 1);
    assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y));
    assert.ok(Math.hypot(result.x, result.y) <= 1 + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// 以下为「手写笔手感」追加（2026-11-15）：压感映射 + 圆珠笔/铅笔的速度调制。
// 既有 `speedWidthScale` 的语义与 `BRUSHES` 参数表**保持不变**（上面那组断言仍在跑），
// 新能力以 `pressureWidthScale` / `pressureWidth` / `speedWidthScaleFor` 追加提供。
// ---------------------------------------------------------------------------

describe('pressureWidthScale（压感 0..65535 → 线宽系数）', () => {
  test('0 → 0.35；32768 ≈ 0.675；65535 → 1（线性 0.35 + 0.65×ratio）', () => {
    assert.equal(PRESSURE_MAX, 65535);
    assert.equal(PRESSURE_MIN_SCALE, 0.35);
    assert.equal(pressureWidthScale(0), 0.35);
    assert.equal(pressureWidthScale(32768), 0.675, '32768/65535 ≈ 0.5 → 0.35 + 0.325');
    assert.equal(pressureWidthScale(65535), 1);
  });

  test('越界压力被夹紧：负数 → 0.35，超过 65535 → 1', () => {
    assert.equal(pressureWidthScale(-1), 0.35);
    assert.equal(pressureWidthScale(-65535), 0.35);
    assert.equal(pressureWidthScale(65536), 1);
    assert.equal(pressureWidthScale(1e9), 1);
  });

  test('NaN / ±Infinity → 1（没有压感信息时不缩放，避免笔画莫名变细）', () => {
    assert.equal(pressureWidthScale(Number.NaN), 1);
    assert.equal(pressureWidthScale(Number.POSITIVE_INFINITY), 1);
    assert.equal(pressureWidthScale(Number.NEGATIVE_INFINITY), 1);
    assert.equal(pressureWidthScale(undefined), 1);
  });

  test('随压力单调不减，且始终落在 [0.35, 1]', () => {
    let previous = 0;
    for (const pressure of [0, 1000, 8000, 16000, 32768, 50000, 64000, 65535]) {
      const scale = pressureWidthScale(pressure);
      assert.ok(scale >= previous, `pressure=${pressure} 应单调不减（${scale} ≥ ${previous}）`);
      assert.ok(scale >= 0.35 && scale <= 1, `pressure=${pressure} 的系数越界：${scale}`);
      previous = scale;
    }
  });
});

describe('pressureWidth（压感 → 最终线宽，夹在 [0.5, base×1.6]）', () => {
  test('基础线宽 3.5：空压 1.225、半压 2.363、满压 3.5', () => {
    assert.equal(pressureWidth(3.5, 0), 1.225);
    assert.equal(pressureWidth(3.5, 32768), 2.363, '3.5 × 0.675 = 2.3625 → 2.363');
    assert.equal(pressureWidth(3.5, 65535), 3.5);
  });

  test('永远不超过 base×1.6，也不小于 0.5', () => {
    for (const base of [2, 3.5, 5, 10]) {
      for (const pressure of [0, 1, 32768, 65534, 65535, 1e9]) {
        const width = pressureWidth(base, pressure);
        assert.ok(width >= 0.5, `base=${base} pressure=${pressure} 线宽过小：${width}`);
        assert.ok(width <= base * 1.6 + 1e-9, `base=${base} pressure=${pressure} 线宽过大：${width}`);
      }
    }
  });

  test('基础线宽非正/NaN → 0.5（与 paintFor 的最小线宽一致）', () => {
    assert.equal(pressureWidth(0, 32768), 0.5);
    assert.equal(pressureWidth(-3, 65535), 0.5);
    assert.equal(pressureWidth(Number.NaN, 0), 0.5);
  });

  test('越界/NaN 压力不抛异常（NaN 压力 = 不缩放）', () => {
    assert.equal(pressureWidth(5, Number.NaN), 5);
    assert.doesNotThrow(() => pressureWidth(5, Number.POSITIVE_INFINITY));
  });
});

describe('usesSpeedWidth / speedWidthScaleFor（钢笔之外的「快细慢粗」）', () => {
  test('钢笔/圆珠笔/铅笔参与速度调制；马克笔/荧光笔不参与', () => {
    for (const kind of ['pen', 'ballpoint', 'pencil']) {
      assert.equal(usesSpeedWidth(kind), true, `${kind} 应参与速度调制`);
    }
    for (const kind of ['marker', 'highlighter']) {
      assert.equal(usesSpeedWidth(kind), false, `${kind} 不参与速度调制`);
    }
    assert.equal(usesSpeedWidth('xxx'), true, '未知笔刷回退 pen（参与）');
  });

  test('钢笔：与原 speedWidthScale 完全一致（不复制逻辑、不改变语义）', () => {
    for (const speed of [0, 0.25, 0.5, 1, 1.5, 2, 3, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      assert.equal(speedWidthScaleFor('pen', speed), speedWidthScale('pen', speed), `speed=${speed}`);
    }
  });

  test('圆珠笔：0 → 1.2、1 → 0.975、2 → 0.75（保守区间 1.2/0.75）', () => {
    assert.deepEqual(
      EXTRA_SPEED_RANGES.map((item) => item.kind),
      ['ballpoint', 'pencil']
    );
    assert.equal(speedWidthScaleFor('ballpoint', 0), 1.2);
    assert.equal(speedWidthScaleFor('ballpoint', 1), 0.975);
    assert.equal(speedWidthScaleFor('ballpoint', 2), 0.75);
    assert.equal(speedWidthScaleFor('ballpoint', 5), 0.75);
  });

  test('铅笔：0 → 1.15、2 → 0.8（区间 1.15/0.8）', () => {
    assert.equal(speedWidthScaleFor('pencil', 0), 1.15);
    assert.equal(speedWidthScaleFor('pencil', 1), 0.975, '1.15 → 0.8 的中点');
    assert.equal(speedWidthScaleFor('pencil', 2), 0.8);
  });

  test('马克笔/荧光笔恒返回 1；非法 speed 不抛异常', () => {
    for (const kind of ['marker', 'highlighter']) {
      for (const speed of [0, 1, 2, 100, Number.NaN]) {
        assert.equal(speedWidthScaleFor(kind, speed), 1, `${kind} speed=${speed}`);
      }
    }
    assert.equal(speedWidthScaleFor('ballpoint', Number.NaN), 1.2, 'NaN → 取最粗');
    assert.equal(speedWidthScaleFor('ballpoint', -1), 1.2);
    assert.equal(speedWidthScaleFor('ballpoint', Number.POSITIVE_INFINITY), 0.75);
    assert.doesNotThrow(() => speedWidthScaleFor('xxx', Number.NaN));
  });

  test('追加的速度区间不影响既有 paintFor 的线宽（只调速、不改笔画基准宽度）', () => {
    assert.equal(paintFor('ballpoint', '#1A1A1A', 3.5).lineWidth, 3.5);
    assert.equal(paintFor('pencil', '#1A1A1A', 3.5).lineWidth, 3.5);
  });
});
