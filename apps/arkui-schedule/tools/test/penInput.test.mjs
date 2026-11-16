/**
 * 手写输入方式（「仅手写笔输入」开关）的纯逻辑测试。
 *
 * 三条硬规则：
 * 1. `penOnly=false` → 手指和笔全都接受（默认行为，升级不改变老用户手感）；
 * 2. `penOnly=true` → **只有手指**被拒绝，笔 / Unknown / 其它取值一律放行；
 * 3. Unknown 必须放行——部分设备拿不到笔类型，拒掉它就等于让人写不了字。
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
  shouldAcceptTouch
} from '../.build/model/penInput.js';

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const SETTINGS_STORE = readFileSync(new URL('services/settingsStore.ets', ETS), 'utf8');
const SETTINGS_PAGE = readFileSync(new URL('pages/Settings.ets', ETS), 'utf8');

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

describe('shouldAcceptTouch：penOnly=false 时全都接受', () => {
  it('笔 / 手指 / Unknown / 其它值 → 一律 true', () => {
    for (const tool of [PEN_TOOL, FINGER_TOOL, UNKNOWN_TOOL, 2, 4, 99, -1, Number.NaN]) {
      assert.equal(shouldAcceptTouch(false, tool), true, `penOnly=false 时 sourceTool=${tool} 应接受`);
    }
  });
});

describe('shouldAcceptTouch：penOnly=true 时只拒绝手指', () => {
  it('手指被拒绝', () => {
    assert.equal(shouldAcceptTouch(true, FINGER_TOOL), false);
  });

  it('笔 / Unknown / 其它值都放行（Unknown 放行是硬要求，否则拿不到笔类型的设备写不了字）', () => {
    for (const tool of [PEN_TOOL, UNKNOWN_TOOL, 2, 4, 99, -1, Number.NaN]) {
      assert.equal(shouldAcceptTouch(true, tool), true, `penOnly=true 时 sourceTool=${tool} 应放行`);
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

describe('设置页「手写」组：开关文案与接线', () => {
  it('标题 / 副标题按用户要求', () => {
    assert.ok(SETTINGS_PAGE.includes('仅手写笔输入'), '缺标题「仅手写笔输入」');
    assert.ok(SETTINGS_PAGE.includes('开启后手指不能书写，只能用手写笔'), '缺副标题');
    assert.ok(SETTINGS_PAGE.includes("Text('手写')"), '缺「手写」组标题');
  });

  it('Toggle 绑定 penOnlyInput，切换即保存', () => {
    assert.match(SETTINGS_PAGE, /Toggle\(\{ type: ToggleType\.Switch, isOn: this\.penOnlyInput \}\)/);
    assert.match(SETTINGS_PAGE, /this\.savePenOnlyInput\(isOn\)/);
    assert.match(SETTINGS_PAGE, /\{ penOnlyInput: isOn \}/, '保存补丁要带 penOnlyInput');
    assert.match(SETTINGS_PAGE, /this\.penOnlyInput = settings\.penOnlyInput;/, 'load 后要铺回开关状态');
  });
});
