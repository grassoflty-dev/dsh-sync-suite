/**
 * 笔迹平滑（纯逻辑：不 import 任何 SDK，可在 Node 直接跑）。
 *
 * 需求（手感）：手写笔采样点很密但略带抖动，直接用 `lineTo` 连点会出现毛刺；
 * 这里提供**二次贝塞尔片段链**（二次均匀 B 样条）的细分平滑：
 *
 *   对每个内部点 P[i]：Q[i] = (P[i-1] + 2·P[i] + P[i+1]) / 4
 *
 * 这正是「以相邻点中点为端点、以 P[i] 为控制点」的二次贝塞尔曲线的极点表示，
 * 也就是传统 Chaikin 细分在**不增加点数**时的等价写法。
 * 选择「点数不变」而不是 Chaikin 的「每轮翻倍」，原因是：
 * - 点序列要进 `StrokeHistory` 持久化并用于撤销/重放，长度暴涨会让重放开销不可控；
 * - 点数不变 ⇒ 首尾点天然保持不变（笔画的起笔/收笔位置不会漂移）。
 *
 * 端点处理：首尾点**永不移动**（否则起笔点会被拉短、笔画看起来缩了一截）。
 * 脏输入（非有限点）在入口被丢弃，因此输出不会出现 NaN。
 */
import type { StrokePoint } from './strokeHistory';

/** 默认平滑轮数（2 轮足够抹掉采样抖动，再多会让转折变钝）。 */
export const DEFAULT_SMOOTH_ITERATIONS: number = 2;

/** 平滑轮数上限：指数级钝化，超过 8 轮没有意义（也防止误传 1e9 时卡住 UI）。 */
export const MAX_SMOOTH_ITERATIONS: number = 8;

/** 点是否可用（数组元素可能缺失/被污染）。 */
function isFinitePoint(point: StrokePoint): boolean {
  return point !== null && point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** 复制点（输出绝不与入参共享对象）。 */
function copyPoint(point: StrokePoint): StrokePoint {
  return { x: point.x, y: point.y };
}

/** 平滑轮数归一化：缺省/NaN/±Infinity → 默认 2；<=0 → 0（原样返回）；超过上限 → 上限。 */
function normalizeIterations(iterations?: number): number {
  if (iterations === undefined || !Number.isFinite(iterations)) {
    return DEFAULT_SMOOTH_ITERATIONS;
  }
  const value: number = Math.floor(iterations);
  if (value <= 0) {
    return 0;
  }
  return value > MAX_SMOOTH_ITERATIONS ? MAX_SMOOTH_ITERATIONS : value;
}

/**
 * 单轮二次 B 样条平滑（不修改入参）：首尾不动，内部点取 `(prev + 2·cur + next) / 4`。
 * 入参必须是**已过滤**的有限点数组（长度 ≥ 3 才有意义，1~2 个点原样复制）。
 */
function smoothOnce(points: StrokePoint[]): StrokePoint[] {
  const count: number = points.length;
  if (count === 0) {
    return [];
  }
  if (count === 1) {
    return [copyPoint(points[0])];
  }
  const out: StrokePoint[] = [];
  out.push(copyPoint(points[0]));
  for (let index = 1; index < count - 1; index++) {
    const previous: StrokePoint = points[index - 1];
    const current: StrokePoint = points[index];
    const next: StrokePoint = points[index + 1];
    out.push({
      x: (previous.x + current.x * 2 + next.x) / 4,
      y: (previous.y + current.y * 2 + next.y) / 4
    });
  }
  out.push(copyPoint(points[count - 1]));
  return out;
}

/**
 * 轨迹平滑（二次贝塞尔/B 样条，默认 2 轮）。
 *
 * 契约：
 * - 入参不是数组 / 空数组 → `[]`；单点 → 单点副本；两点 → 两点副本（无从平滑，也不能移动端点）；
 * - **点数不变**（过滤掉非有限点后与输入点数一致），首尾点坐标不变；
 * - 输出是新数组 + 新点对象，不修改入参；
 * - 空/单点/全脏点都不抛异常，也不会产生 NaN。
 */
export function smoothPath(points: StrokePoint[], iterations?: number): StrokePoint[] {
  const list: StrokePoint[] = Array.isArray(points) ? points : [];
  const clean: StrokePoint[] = [];
  for (let index = 0; index < list.length; index++) {
    const point: StrokePoint = list[index];
    if (isFinitePoint(point)) {
      clean.push(copyPoint(point));
    }
  }
  if (clean.length === 0) {
    return [];
  }
  let result: StrokePoint[] = clean;
  const rounds: number = normalizeIterations(iterations);
  for (let round = 0; round < rounds; round++) {
    result = smoothOnce(result);
    if (result.length <= 2) {
      // 1~2 个点平滑等于原样，提前结束（也避免无意义的多轮复制）
      break;
    }
  }
  return result;
}
