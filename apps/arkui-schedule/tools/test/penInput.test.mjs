/**
 * 手写输入方式（「仅手写笔输入」开关）的纯逻辑 + 画布接线测试。
 *
 * 三条硬规则：
 * 1. `penOnly=false` → 手指和笔全都接受（默认行为，升级不改变老用户手感）；
 * 2. `penOnly=true` → **只有手指**被拒绝，笔 / Unknown / 其它取值一律放行；
 * 3. Unknown 必须放行——部分设备拿不到笔类型，拒掉它就等于让人写不了字。
 *
 * 另外两条「提示节流」规则（2026-11-18 缺陷 1）：
 * 4. 手指连点会产生几十次触摸事件，提示**每 N 次一次**（`shouldShowRejectNotice`），不是每次都弹；
 * 5. 提示文案要指到**当前**的关闭位置（手写板「笔迹 → 更多」），老的设置页入口已删除。
 *
 * 前置：先跑 `tsc -p tools/tsconfig.json`（测试 import `.build/model/penInput.js`）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FINGER_REJECT_THRESHOLD,
  FINGER_TOOL,
  PEN_TOOL,
  UNKNOWN_TOOL,
  fingerRejectNotice,
  fingerRejectNoticeOnBoard,
  shouldAcceptTouch,
  shouldShowRejectNotice
} from '../.build/model/penInput.js';

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const HARMONY_ETS = new URL('../../entry/src/harmony/ets/', import.meta.url);
const SETTINGS_STORE = readFileSync(new URL('services/settingsStore.ets', ETS), 'utf8');
const PAGER = readFileSync(new URL('handwriting/HandwritingPager.ets', HARMONY_ETS), 'utf8');

/** 截取某个方法体（从签名到下一个顶层成员）。 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到方法：${signature}`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:async |private |\/\*\*)/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('penInput：sourceTool 常量与 SourceTool 对齐', () => {
  it('PEN=3 / FINGER=1 / UNKNOWN=0（与 @kit.ArkUI 的 SourceTool 一致，不 import SDK）', () => {
    assert.equal(PEN_TOOL, 3);
    assert.equal(FINGER_TOOL, 1);
    assert.equal(UNKNOWN_TOOL, 0);
  });

  it('阈值是 3（连续拒绝 3 次才提示，第一次误触不弹）', () => {
    assert.equal(FINGER_REJECT_THRESHOLD, 3);
  });
});

// ---------------------------------------------------------------------------
// 四态全矩阵：penOnly(false/true) × sourceTool(FINGER / UNKNOWN / PEN / 其它值)
// 「其它值」= 2、4、99、-1、NaN（未来 SDK 加的枚举、坏数据），一律放行。
// ---------------------------------------------------------------------------

const OTHER_TOOLS = [2, 4, 99, -1, Number.NaN];

describe('shouldAcceptTouch：penOnly=false × 四种 sourceTool → 全部接受', () => {
  it('手指 / 未知 / 笔 / 其它值全部 true（默认手感不变）', () => {
    for (const tool of [FINGER_TOOL, UNKNOWN_TOOL, PEN_TOOL, ...OTHER_TOOLS]) {
      assert.equal(shouldAcceptTouch(false, tool), true, `penOnly=false 时 sourceTool=${tool} 应接受`);
    }
  });
});

describe('shouldAcceptTouch：penOnly=true × 四种 sourceTool → 只拒手指', () => {
  it('手指被拒绝', () => {
    assert.equal(shouldAcceptTouch(true, FINGER_TOOL), false);
  });

  it('未知 / 笔 / 其它值全部放行（Unknown 放行是硬要求：它可能就是笔）', () => {
    for (const tool of [UNKNOWN_TOOL, PEN_TOOL, ...OTHER_TOOLS]) {
      assert.equal(shouldAcceptTouch(true, tool), true, `penOnly=true 时 sourceTool=${tool} 应放行`);
    }
  });

  it('矩阵不随 penOnly 的「非布尔真值」变形（true 之外一律按关处理）', () => {
    // 页面只可能传 boolean；这里锁住「只有严格 true 才拦手指」，防止有人改成 `if (penOnly)`
    for (const truthy of [1, 'true', {}, []]) {
      assert.equal(shouldAcceptTouch(truthy, FINGER_TOOL), true, `penOnly=${JSON.stringify(truthy)} 必须按「关」处理`);
    }
  });
});

describe('fingerRejectNotice：提示文案带次数', () => {
  it('含实际次数，并说明是「仅手写笔输入」拦下的', () => {
    const text = fingerRejectNotice(3);
    assert.ok(text.includes('3'), `文案应含次数 3：${text}`);
    assert.ok(text.includes('仅手写笔输入'), `文案应点明开关：${text}`);
    assert.ok(text.includes('手写笔'), `文案应告诉用户改用笔：${text}`);
  });

  it('次数随入参变化（不是写死的 3）', () => {
    for (const count of [3, 4, 7, 12]) {
      assert.ok(fingerRejectNotice(count).includes(String(count)), `文案应含次数 ${count}`);
    }
  });

  it('非法次数回落阈值，不出现 NaN/小数', () => {
    assert.ok(fingerRejectNotice(Number.NaN).includes(String(FINGER_REJECT_THRESHOLD)));
    assert.ok(fingerRejectNotice(0).includes(String(FINGER_REJECT_THRESHOLD)));
    assert.ok(fingerRejectNotice(-5).includes(String(FINGER_REJECT_THRESHOLD)));
    assert.equal(/NaN/.test(fingerRejectNotice(Number.NaN)), false);
    assert.ok(fingerRejectNotice(3.9).includes('3'), '小数向下取整');
    assert.ok(fingerRejectNotice(Number.POSITIVE_INFINITY).includes(String(FINGER_REJECT_THRESHOLD)), 'Infinity 回落阈值');
  });
});

describe('fingerRejectNoticeOnBoard：手写板场景的文案（关的地方在「笔迹 → 更多」）', () => {
  it('带次数 + 指到手写板自己的入口（不是已删除的设置页开关）', () => {
    const text = fingerRejectNoticeOnBoard(3);
    assert.ok(text.includes('3'), `文案应含次数 3：${text}`);
    assert.ok(text.includes('仅手写笔输入'), `文案应点明开关：${text}`);
    assert.ok(text.includes('笔迹'), `文案应指到「笔迹」面板：${text}`);
    assert.ok(text.includes('更多'), `文案应指到二级菜单「更多」：${text}`);
    assert.equal(text.includes('设置'), false, '不得再把用户指去设置页（那条开关已删除）');
  });

  it('边界与 fingerRejectNotice 一致：0 / 负数 / NaN / Infinity 回落阈值', () => {
    for (const bad of [0, -1, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.ok(
        fingerRejectNoticeOnBoard(bad).includes(String(FINGER_REJECT_THRESHOLD)),
        `非法次数 ${bad} 应回落阈值`
      );
      assert.equal(/NaN/.test(fingerRejectNoticeOnBoard(bad)), false, `非法次数 ${bad} 不得出现 NaN`);
    }
    assert.ok(fingerRejectNoticeOnBoard(6).includes('6'), '正常值原样显示');
    assert.ok(fingerRejectNoticeOnBoard(6.9).includes('6'), '小数向下取整');
  });
});

describe('shouldShowRejectNotice：每 N 次才提示一次（不是每次点击都弹）', () => {
  it('阈值整数倍才提示：3 / 6 / 9 是 true', () => {
    for (const count of [3, 6, 9, 12, 30]) {
      assert.equal(shouldShowRejectNotice(count), true, `${count} 次应提示`);
    }
  });

  it('非整数倍不提示：1 / 2 / 4 / 5 / 7', () => {
    for (const count of [1, 2, 4, 5, 7, 8]) {
      assert.equal(shouldShowRejectNotice(count), false, `${count} 次不该提示`);
    }
  });

  it('边界：0 / 负数 / NaN / Infinity 一律不提示（不抛异常）', () => {
    for (const bad of [0, -1, -3, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(shouldShowRejectNotice(bad), false, `${bad} 不该提示`);
    }
  });

  it('小数按向下取整判断（3.9 → 3 次 → 提示）', () => {
    assert.equal(shouldShowRejectNotice(3.9), true);
    assert.equal(shouldShowRejectNotice(2.9), false);
  });
});

// ---------------------------------------------------------------------------
// 画布接线（缺陷 1 的真身：`shouldAcceptTouch` 以前**没有任何调用点**）
// ---------------------------------------------------------------------------

describe('HandwritingPager：penOnly 过滤接在画布触摸 / 框选手势的最前面', () => {
  it('import 了纯函数模块（不在 ETS 里重写一遍规则）', () => {
    assert.ok(
      /import \{ FINGER_TOOL, fingerRejectNoticeOnBoard, shouldAcceptTouch, shouldShowRejectNotice \} from '\.\.\/model\/penInput';/.test(
        PAGER
      ),
      '必须从 model/penInput 引入规则与文案'
    );
  });

  it('handleTouch：第一条语句就是 penOnly 过滤（在框选/落笔判断之前）', () => {
    const body = PAGER.slice(PAGER.indexOf('private handleTouch('));
    const filterAt = body.indexOf('this.penInputAllowedFor(');
    const selectAt = body.indexOf('this.isSelectMode()');
    assert.ok(filterAt > 0, 'handleTouch 必须调用 penInputAllowedFor()');
    assert.ok(filterAt < selectAt, 'penOnly 过滤必须早于框选判断（被拒的触摸不能进框选）');
    assert.ok(
      /penInputAllowedFor\(Number\(event\.sourceTool\), event\.type === TouchType\.Down\)/.test(body.slice(0, 600)),
      '必须把 event.sourceTool 传进去，且只在 Down 上计数'
    );
    assert.ok(
      /if \(!this\.penInputAllowedFor\(/.test(body.slice(0, 600)),
      '被拒时直接 return（不落笔、不进橡皮、不动撤销栈）'
    );
  });

  it('handleGestureStart（手动框建框）也过滤 —— 框选走 PanGesture，不经过 handleTouch', () => {
    const body = PAGER.slice(PAGER.indexOf('private handleGestureStart('));
    const filterAt = body.indexOf('this.penInputAllowedFor(');
    assert.ok(filterAt > 0, 'handleGestureStart 必须也调 penInputAllowedFor()');
    assert.ok(
      /penInputAllowedFor\(Number\(event\.sourceTool\), true\)/.test(body.slice(0, 600)),
      '手势起手 = 一次触摸，必须计数'
    );
    assert.ok(/if \(!this\.penInputAllowedFor\(/.test(body.slice(0, 600)), '被拒时直接 return（不建框）');
  });

  it('过滤逻辑：读 state.penOnlyInput、拒绝累加、阈值提示、非手指清零', () => {
    const body = methodBody(PAGER, 'private penInputAllowedFor(');
    assert.ok(/shouldAcceptTouch\(this\.state\.penOnlyInput, sourceTool\)/.test(body), '必须用 state.penOnlyInput + sourceTool 判');
    assert.ok(/this\.fingerRejectCount = this\.fingerRejectCount \+ 1;/.test(body), '被拒必须累加连续次数');
    assert.ok(/shouldShowRejectNotice\(this\.fingerRejectCount\)/.test(body), '达到阈值必须走 shouldShowRejectNotice 节流');
    assert.ok(/fingerRejectNoticeOnBoard\(this\.fingerRejectCount\)/.test(body), '提示文案必须带次数（手写板版）');
    assert.ok(/promptAction\.showToast\(/.test(body), '必须 toast 提示');
    assert.ok(/if \(sourceTool !== FINGER_TOOL\) \{/.test(body), '非手指输入必须清零');
    assert.ok(/this\.fingerRejectCount = 0;/.test(body), '清零必须落在这个方法里');
  });

  it('penOnly 值存在 @Observed state 上（父页面写入后立刻生效，不用重建画布）', () => {
    const stateStart = PAGER.indexOf('export class HandwritingPagerState');
    assert.ok(stateStart > 0, '找不到 HandwritingPagerState');
    const state = PAGER.slice(stateStart, PAGER.indexOf('@Component'));
    assert.ok(/penOnlyInput: boolean = false;/.test(state), 'state 必须有 penOnlyInput 字段（默认 false）');
    assert.ok(/setPenOnlyInput\(enabled: boolean\): void \{/.test(state), 'state 必须有 setPenOnlyInput() 写入器');
    assert.ok(/this\.penOnlyInput = enabled === true;/.test(state), '只认 true，其余按关处理（坏值不能把笔锁死）');
  });
});

describe('settingsStore：penOnlyInput 在 load / save / saveSyncState 三处都落地', () => {
  const LOAD_BODY = methodBody(SETTINGS_STORE, 'async load(');
  const SAVE_BODY = methodBody(SETTINGS_STORE, 'async save(');
  const SYNC_STATE_BODY = methodBody(SETTINGS_STORE, 'async saveSyncState(');

  it('接口与键常量都在（ScheduleSettings / SettingsPatch / KEY_PEN_ONLY_INPUT）', () => {
    assert.match(SETTINGS_STORE, /penOnlyInput: boolean;/, 'ScheduleSettings 缺 penOnlyInput');
    assert.match(SETTINGS_STORE, /penOnlyInput\?: boolean;/, 'SettingsPatch 缺 penOnlyInput');
    assert.match(SETTINGS_STORE, /const KEY_PEN_ONLY_INPUT: string = 'penOnlyInput';/);
  });

  it('load()：默认 false，且写进返回对象', () => {
    assert.match(LOAD_BODY, /prefs\.get\(KEY_PEN_ONLY_INPUT,\s*false\)/, '旧数据缺字段必须回落 false');
    assert.ok(LOAD_BODY.includes('penOnlyInput:'), 'load() 未构造 penOnlyInput');
  });

  it('save()：逐字段构造 + 写回 preferences', () => {
    assert.ok(SAVE_BODY.includes('penOnlyInput:'), 'save() 未构造 penOnlyInput');
    assert.ok(SAVE_BODY.includes('prefs.put(KEY_PEN_ONLY_INPUT'), 'save() 没有写回 penOnlyInput');
  });

  it('saveSyncState()：同步状态回写不会丢掉 penOnlyInput', () => {
    assert.ok(SYNC_STATE_BODY.includes('penOnlyInput:'), 'saveSyncState() 未构造 penOnlyInput');
  });
});

// 注：设置页（`pages/Settings.ets`）里的「手写」开关已按要求删除，开关现在在
// 手写板「笔迹 → 更多」里 —— 那条 UI 接线由 `tools/test/handwritingToolbar.test.mjs`
// 的「缺陷 1 / 2」describe 断言（哪个页面渲染它，就由哪个页面的测试负责）。
