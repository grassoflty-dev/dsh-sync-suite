// A 批第 1 步：统一按钮状态模型（`model/actionButton.ts`）的行为契约 —— `docs/STATE-UI.md` §3。
//
// 前置：先构建纯逻辑层（`node --test` 不负责编译）
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 关注点（每条失败都有明确含义）：
// - 四象限：`enabled × busy` 四种组合各有一个确定结论，`busy` 优先于 `enabled`；
// - 禁用无原因兜底：`enabled=false` 且 `disabledReason` 为空时也必须给一句人话（绝不静默）；
// - opacity 三档：可点 1 / 忙 0.5 / 不可用 0.4，三档必须互不相同（视觉差异是断言项）；
// - `blockedTapText` 语义：可点 / 忙碌返回空串（不重复 toast），不可用返回非空原因。
import test from 'node:test';
import assert from 'node:assert/strict';

import { blockedTapText, resolveButton } from '../.build/model/actionButton.js';

/** 兜底原因（与 model 内常量同值；这里写字面量是为了「改文案就红」）。 */
const FALLBACK_REASON = '当前不可用，请稍后再试';

// ---------------------------------------------------------------- 四象限

test('四象限：enabled=true / busy=false → 可点、不透明、无原因', () => {
  const state = resolveButton(true, false, '不该出现的理由');
  assert.equal(state.tappable, true, '可用时必须可点');
  assert.equal(state.busy, false);
  assert.equal(state.opacity, 1, '可点时完全不透明');
  assert.equal(state.blockedReason, '', '可点时不带任何原因文案');
});

test('四象限：enabled=false / busy=false → 不可点、半透明（0.4）、必须有原因', () => {
  const state = resolveButton(false, false, '仓库地址为空');
  assert.equal(state.tappable, false);
  assert.equal(state.busy, false);
  assert.equal(state.opacity, 0.4);
  assert.equal(state.blockedReason, '仓库地址为空');
});

test('四象限：busy=true（enabled 两种取值）→ 忙碌态完全一致', () => {
  const busyWhenEnabled = resolveButton(true, true, '');
  const busyWhenDisabled = resolveButton(false, true, '仓库地址为空');
  assert.deepEqual(busyWhenEnabled, busyWhenDisabled, 'busy 必须优先于 enabled');
  assert.equal(busyWhenEnabled.tappable, false, '忙碌时不能真的执行动作');
  assert.equal(busyWhenEnabled.busy, true);
  assert.equal(busyWhenEnabled.opacity, 0.5, '忙碌是中间档透明度');
  assert.equal(busyWhenEnabled.blockedReason, '处理中，请稍候');
});

test('busy 优先：用了 busy 就不带禁用原因（状态单一，不混两种说法）', () => {
  const state = resolveButton(false, true, '仓库地址为空');
  assert.equal(state.blockedReason, '处理中，请稍候');
  assert.equal(state.blockedReason.includes('仓库地址为空'), false);
});

// ---------------------------------------------------------------- 禁用原因兜底

test('禁用无原因兜底：空串 / 纯空白 / undefined / null 都给同一句人话', () => {
  for (const reason of ['', '   ', undefined, null]) {
    const state = resolveButton(false, false, reason);
    assert.equal(state.tappable, false);
    assert.equal(state.blockedReason, FALLBACK_REASON, `${String(reason)} 必须回落兜底原因`);
    assert.ok(state.blockedReason.length > 0, 'tappable=false 时原因永远非空');
  }
});

test('禁用有原因：原样使用（去首尾空白），不覆盖调用方的具体说明', () => {
  const state = resolveButton(false, false, '  请先填写仓库地址  ');
  assert.equal(state.blockedReason, '请先填写仓库地址');
});

// ---------------------------------------------------------------- 透明度三档

test('opacity 三档互不相同：1 / 0.5 / 0.4', () => {
  const normal = resolveButton(true, false, '').opacity;
  const busy = resolveButton(true, true, '').opacity;
  const blocked = resolveButton(false, false, '原因').opacity;
  assert.deepEqual([normal, busy, blocked], [1, 0.5, 0.4]);
  assert.equal(new Set([normal, busy, blocked]).size, 3, '三档必须互不相同（视觉差异是断言项）');
  assert.ok(busy > blocked, '忙碌应比不可用更实一点（忙碌是"正在做"，不可用是"做不了"）');
  assert.ok(blocked < normal);
});

// ---------------------------------------------------------------- blockedTapText

test('blockedTapText：可点时返回空串（点下去真会执行，不该弹提示）', () => {
  assert.equal(blockedTapText(resolveButton(true, false, '')), '');
});

test('blockedTapText：忙碌时返回空串（已有「处理中…」，不重复 toast）', () => {
  assert.equal(blockedTapText(resolveButton(true, true, '')), '');
});

test('blockedTapText：不可用时返回原因（与 blockedReason 一致）', () => {
  const state = resolveButton(false, false, '仓库地址为空');
  assert.equal(blockedTapText(state), '仓库地址为空');
  assert.equal(blockedTapText(state), state.blockedReason);
});

test('blockedTapText：状态里原因为空也兜底，绝不返回空串给静默点击', () => {
  const broken = { tappable: false, busy: false, blockedReason: '', opacity: 0.4 };
  assert.equal(blockedTapText(broken), FALLBACK_REASON);
  assert.equal(blockedTapText(undefined), FALLBACK_REASON, '脏入参不抛异常');
  assert.equal(blockedTapText(null), FALLBACK_REASON);
});

test('语义闭环：tappable=false 且不忙时，一定有一句非空原因可 toast；tappable=true 时一定没有', () => {
  for (const enabled of [true, false]) {
    for (const busy of [true, false]) {
      const state = resolveButton(enabled, busy, '');
      const text = blockedTapText(state);
      if (state.tappable) {
        assert.equal(text, '', '可点不应有拦截文案');
      } else if (state.busy) {
        assert.equal(text, '', '忙碌静默（视觉已表达）');
      } else {
        assert.ok(text.length > 0, '不可用必须有原因文案');
      }
      if (state.tappable === false) {
        assert.ok(state.blockedReason.length > 0, 'tappable=false 时 blockedReason 必须非空');
      }
    }
  }
});

test('纯函数：同入参同结果（组件每次重绘都重新调用，不能抖）', () => {
  assert.deepEqual(resolveButton(false, false, '原因'), resolveButton(false, false, '原因'));
  assert.deepEqual(resolveButton(true, true, ''), resolveButton(true, true, ''));
});
