// A 批第 1 步：三态纯逻辑（`model/stateView.ts`）的行为契约 —— `docs/STATE-UI.md` §2。
//
// 前置：先构建纯逻辑层（`node --test` 不负责编译）
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 关注点（每条失败都有明确含义）：
// - 四要素齐全：诊断行永远是「版本 / 设备 / 错误码 / 时间」四段，缺字段用兜底词，绝不省略；
// - 时间格式：固定 `YYYY-MM-DD HH:mm:ss`（用本地时间构造期望值，不依赖跑测机器的时区）；
// - 幂等：`describeFailure(f(x), '', '') === f(x)`，页面重复包一层不会出现「失败：失败：」；
// - 空态必须有动作：`emptyStateIssue` 只抓「标题像空态且没有动作」，不误伤普通标题；
// - 非法输入不抛、不产出 `undefined` 字样（运行时脏数据是常态，纯逻辑层是最后一道防线）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANCEL_AFTER_MS,
  STATE_EMPTY,
  STATE_ERROR,
  STATE_LOADING,
  canCancelLoading,
  describeFailure,
  emptyStateIssue,
  formatDiagnostics,
  progressText
} from '../.build/model/stateView.js';

/** 用本地时间构造毫秒时间戳（期望值也用本地时间写，跑测机器时区无关）。 */
function localStamp(year, month, day, hours, minutes, seconds) {
  return new Date(year, month - 1, day, hours, minutes, seconds).getTime();
}

/** 断言结果里绝不含 `undefined` / `null` 字样（文案层的硬底线）。 */
function assertClean(text, label) {
  assert.equal(typeof text, 'string', `${label} 必须返回字符串，实际 ${typeof text}`);
  assert.equal(/undefined/.test(text), false, `${label} 产出了 undefined 字样：${text}`);
  assert.equal(/null/.test(text), false, `${label} 产出了 null 字样：${text}`);
}

// ---------------------------------------------------------------- 常量

test('三态常量与取消阈值：取值固定、互不相同', () => {
  assert.equal(STATE_LOADING, 'loading');
  assert.equal(STATE_EMPTY, 'empty');
  assert.equal(STATE_ERROR, 'error');
  assert.equal(new Set([STATE_LOADING, STATE_EMPTY, STATE_ERROR]).size, 3, '三态必须互不相同');
  assert.equal(CANCEL_AFTER_MS, 3000, '取消阈值必须是 3000ms（文档 §2）');
});

// ---------------------------------------------------------------- canCancelLoading

test('canCancelLoading：正好 3000ms 起可取消，之前不行', () => {
  assert.equal(canCancelLoading(CANCEL_AFTER_MS), true, '正好到阈值就算可取消');
  assert.equal(canCancelLoading(CANCEL_AFTER_MS - 1), false);
  assert.equal(canCancelLoading(CANCEL_AFTER_MS + 1), true);
  assert.equal(canCancelLoading(0), false);
  assert.equal(canCancelLoading(60000), true);
});

test('canCancelLoading：负数 / NaN / Infinity / 脏数据按 0 处理（不抛、不早给取消）', () => {
  for (const value of [-1, -99999, Number.NaN, undefined, null, '3000']) {
    assert.equal(canCancelLoading(value), false, `${String(value)} 不应判为可取消`);
  }
  assert.equal(canCancelLoading(Number.POSITIVE_INFINITY), false, 'Infinity 不是有效时长，按 0 处理');
});

// ---------------------------------------------------------------- progressText

test('progressText：负数/NaN 走不确定进度文案', () => {
  assert.equal(progressText(-1), '正在处理…');
  assert.equal(progressText(-100), '正在处理…');
  assert.equal(progressText(Number.NaN), '正在处理…');
  assert.equal(progressText(undefined), '正在处理…');
});

test('progressText：0..100 夹取并四舍五入取整', () => {
  assert.equal(progressText(0), '正在处理 0%…');
  assert.equal(progressText(42), '正在处理 42%…');
  assert.equal(progressText(42.4), '正在处理 42%…');
  assert.equal(progressText(42.5), '正在处理 43%…');
  assert.equal(progressText(99.6), '正在处理 100%…');
  assert.equal(progressText(100), '正在处理 100%…');
  assert.equal(progressText(150), '正在处理 100%…', '超过 100 必须夹到 100，不能出现 150%');
});

test('progressText：结果里只有整数百分比（不出现小数点）', () => {
  for (const value of [0, 1, 7.8, 33.3333, 88.88, 100]) {
    const text = progressText(value);
    assert.match(text, /^正在处理 \d{1,3}%…$/, `格式不对：${text}`);
    assert.equal(text.includes('.'), false, `出现了小数点：${text}`);
  }
});

// ---------------------------------------------------------------- formatDiagnostics

test('formatDiagnostics：四要素齐全且顺序固定（版本 → 设备 → 错误码 → 时间）', () => {
  const timestamp = localStamp(2026, 11, 18, 20, 41, 5);
  const line = formatDiagnostics(
    { version: '1.0.0', deviceId: 'device-2', errorCode: 'E_GIT_TIMEOUT', timestamp },
    timestamp
  );
  assert.equal(line, '版本 1.0.0 · 设备 device-2 · 错误码 E_GIT_TIMEOUT · 2026-11-18 20:41:05');
  const parts = line.split(' · ');
  assert.equal(parts.length, 4, `必须是四段（实际 ${parts.length}）：${line}`);
  assert.ok(parts[0].startsWith('版本 '), `第 1 段必须是版本：${parts[0]}`);
  assert.ok(parts[1].startsWith('设备 '), `第 2 段必须是设备：${parts[1]}`);
  assert.ok(parts[2].startsWith('错误码 '), `第 3 段必须是错误码：${parts[2]}`);
  assert.match(parts[3], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `第 4 段必须是时间：${parts[3]}`);
});

test('formatDiagnostics：时间格式补零（个位数月/日/时/分/秒都是两位）', () => {
  const timestamp = localStamp(2026, 1, 2, 3, 4, 5);
  const line = formatDiagnostics({ version: '1.0.0', deviceId: 'device-2', errorCode: '', timestamp }, timestamp);
  assert.ok(line.endsWith('2026-01-02 03:04:05'), `补零不对：${line}`);
});

test('formatDiagnostics：缺失字段用兜底词，四段仍然都在（不省略段）', () => {
  const timestamp = localStamp(2026, 11, 18, 20, 41, 5);
  const line = formatDiagnostics({ version: '', deviceId: '', errorCode: '', timestamp }, timestamp);
  const parts = line.split(' · ');
  assert.equal(parts.length, 4, `缺字段也必须四段：${line}`);
  assert.equal(parts[0], '版本 未取到版本');
  assert.equal(parts[1], '设备 未登记');
  assert.equal(parts[2], '错误码 无');
  assert.equal(parts[3], '2026-11-18 20:41:05');
  assertClean(line, 'formatDiagnostics');
});

test('formatDiagnostics：时间戳非法时用调用方给的 now（不编造"当前时间"进测试结果）', () => {
  const now = localStamp(2026, 11, 18, 21, 0, 0);
  const broken = formatDiagnostics({ version: '1.0.0', deviceId: 'device-2', errorCode: 'E_X', timestamp: Number.NaN }, now);
  const valid = formatDiagnostics({ version: '1.0.0', deviceId: 'device-2', errorCode: 'E_X', timestamp: now }, now);
  assert.equal(broken, valid, '非法时间戳必须回落到 now');
  assert.ok(broken.endsWith('2026-11-18 21:00:00'), `回落结果不对：${broken}`);

  const zero = formatDiagnostics({ version: '1.0.0', deviceId: 'device-2', errorCode: 'E_X', timestamp: 0 }, now);
  assert.equal(zero, valid, 'timestamp=0 视为非法（1970 不是有效诊断时间）');
});

test('formatDiagnostics：input / now 全非法时不抛、不产出 undefined、仍是四段', () => {
  for (const input of [undefined, null, {}, { version: null, deviceId: null, errorCode: null, timestamp: null }]) {
    const line = formatDiagnostics(input, Number.NaN);
    assertClean(line, 'formatDiagnostics(脏 input)');
    assert.equal(line.split(' · ').length, 4, `脏 input 也要四段：${line}`);
    assert.match(line, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `时间段落缺失：${line}`);
  }
});

// ---------------------------------------------------------------- describeFailure

test('describeFailure：标准三段式', () => {
  const line = describeFailure('同步', '网络不可达', '检查网络后重试');
  assert.equal(line, '同步失败：网络不可达。下一步：检查网络后重试');
  assertClean(line, 'describeFailure');
});

test('describeFailure：缺项不编造，但四要素永远在（原因未知 / 默认建议）', () => {
  const noWhy = describeFailure('同步', '', '稍后再试');
  assert.equal(noWhy, '同步失败：原因未知。下一步：稍后再试');

  const noNext = describeFailure('同步', '网络不可达', '');
  assert.equal(noNext, '同步失败：网络不可达。下一步：重试，或到设置页检查配置');

  const neither = describeFailure('同步', '', '');
  assert.equal(neither, '同步失败：原因未知。下一步：重试，或到设置页检查配置');

  const noWhat = describeFailure('', '网络不可达', '检查网络');
  assert.equal(noWhat, '操作失败：网络不可达。下一步：检查网络');
});

test('describeFailure：幂等（已格式化过就不重复包装）', () => {
  const once = describeFailure('同步', '网络不可达', '检查网络后重试');
  assert.equal(describeFailure(once, '', ''), once, 'f(f(x)) 必须等于 f(x)');
  assert.equal(describeFailure(describeFailure(once, '', ''), '', ''), once, '两轮之后仍不变');
  assert.equal(once.includes('失败：同步失败：'), false);
});

test('describeFailure：what 自带「失败」或标点时不叠字', () => {
  assert.equal(describeFailure('同步失败', '网络不可达', '重试'), '同步失败：网络不可达。下一步：重试');
  assert.equal(describeFailure('同步。', '网络不可达', '重试'), '同步失败：网络不可达。下一步：重试');
  assert.equal(describeFailure('同步失败。', '网络不可达', '重试').includes('失败失败'), false);
  assert.equal(describeFailure('推送', '推送被拒绝。', '先拉取再推送'), '推送失败：推送被拒绝。下一步：先拉取再推送');
});

test('describeFailure：next 自带「下一步：」时不重复标记', () => {
  const line = describeFailure('同步', '网络不可达', '下一步：检查网络后重试');
  assert.equal(line, '同步失败：网络不可达。下一步：检查网络后重试');
  assert.equal(line.split('下一步：').length - 1, 1, `「下一步：」只允许出现一次：${line}`);
});

test('describeFailure：脏入参不抛、不产出 undefined', () => {
  for (const [what, why, next] of [
    [undefined, undefined, undefined],
    [null, null, null],
    ['   ', '  ', '  ']
  ]) {
    const line = describeFailure(what, why, next);
    assertClean(line, 'describeFailure(脏入参)');
    assert.ok(line.includes('失败：'), `必须仍是失败语句：${line}`);
    assert.ok(line.includes('下一步：'), `必须仍给下一步：${line}`);
  }
});

// ---------------------------------------------------------------- emptyStateIssue

test('emptyStateIssue：标题像空态且没有动作 → 报问题（含标题与「动作」字样）', () => {
  const issue = emptyStateIssue('暂无日程', '');
  assert.notEqual(issue, '', '空态没有动作必须报问题');
  assert.ok(issue.includes('暂无日程'), `问题说明应带标题便于定位：${issue}`);
  assert.ok(issue.includes('动作'), `问题说明应点明缺少动作：${issue}`);
  assertClean(issue, 'emptyStateIssue');
});

test('emptyStateIssue：三种识别词（暂无 / 没有 / 空）都能抓到', () => {
  assert.notEqual(emptyStateIssue('暂无日程', ''), '');
  assert.notEqual(emptyStateIssue('还没有云端会话', ''), '', '「没有」也是空态，必须带动作');
  assert.notEqual(emptyStateIssue('空列表', ''), '');
});

test('emptyStateIssue：纯空白动作等同没有动作', () => {
  assert.notEqual(emptyStateIssue('暂无日程', '   '), '');
  assert.equal(emptyStateIssue('暂无日程', '换个区间'), '', '有动作就合规');
});

test('emptyStateIssue：标题不像空态时不误伤（不属于本函数判定范围）', () => {
  assert.equal(emptyStateIssue('日程列表', ''), '');
  assert.equal(emptyStateIssue('同步设置', ''), '');
  assert.equal(emptyStateIssue('', ''), '', '空标题无法判断是空态，不编造问题');
});

test('emptyStateIssue：脏入参不抛异常', () => {
  assert.equal(emptyStateIssue(undefined, undefined), '');
  assert.equal(emptyStateIssue(null, null), '');
  assert.notEqual(emptyStateIssue('暂无日程', undefined), '');
});
