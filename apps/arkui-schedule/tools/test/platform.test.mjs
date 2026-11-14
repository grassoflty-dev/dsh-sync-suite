// 平台门控 / 能力开关 / 本地时间工具测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatClock, localDateKey, nowIso } from '../.build/common/date.js';
import { getFeatures, resetFeatures, setFeatures } from '../.build/common/features.js';
import { getPlatform, isHarmonyOS, setPlatform } from '../.build/common/platform.js';

const PLATFORM_KEY = '__arkuiXPlatform';

function clearPlatform() {
  delete globalThis[PLATFORM_KEY];
}

test('platform：未设置 globalThis.__arkuiXPlatform 时默认 harmony', () => {
  clearPlatform();
  assert.equal(getPlatform(), 'harmony');
  assert.equal(isHarmonyOS(), true);
});

test('platform：读取 globalThis.__arkuiXPlatform（ArkUI-X 启动注入）', () => {
  clearPlatform();
  globalThis[PLATFORM_KEY] = 'android';
  assert.equal(getPlatform(), 'android');
  assert.equal(isHarmonyOS(), false);

  globalThis[PLATFORM_KEY] = 'harmony';
  assert.equal(getPlatform(), 'harmony');
  assert.equal(isHarmonyOS(), true);
  clearPlatform();
});

test('platform：setPlatform 写回 globalThis，未知值归一化为 harmony', () => {
  clearPlatform();
  setPlatform('android');
  assert.equal(globalThis[PLATFORM_KEY], 'android');
  assert.equal(isHarmonyOS(), false);

  setPlatform('harmony');
  assert.equal(globalThis[PLATFORM_KEY], 'harmony');

  globalThis[PLATFORM_KEY] = 'windows';
  assert.equal(getPlatform(), 'harmony', '无法识别的平台值按 fail-closed 视为 harmony');

  setPlatform('ios');
  assert.equal(getPlatform(), 'harmony');
  clearPlatform();
});

test('features：默认全部关闭（Android 侧 fail-closed）', () => {
  resetFeatures();
  assert.deepEqual(getFeatures(), { handwriting: false, ocr: false });
});

test('features：setFeatures 按字段合并，非布尔值按 false 处理', () => {
  resetFeatures();
  setFeatures({ handwriting: true });
  assert.deepEqual(getFeatures(), { handwriting: true, ocr: false });

  setFeatures({ ocr: true });
  assert.deepEqual(getFeatures(), { handwriting: true, ocr: true });

  setFeatures({ handwriting: false });
  assert.deepEqual(getFeatures(), { handwriting: false, ocr: true });

  setFeatures({ ocr: 'yes' });
  assert.deepEqual(getFeatures(), { handwriting: false, ocr: false });

  setFeatures({});
  assert.deepEqual(getFeatures(), { handwriting: false, ocr: false });

  setFeatures({ handwriting: true, ocr: true });
  resetFeatures();
  assert.deepEqual(getFeatures(), { handwriting: false, ocr: false });
});

test('features：getFeatures 返回副本，外部修改不影响全局状态', () => {
  resetFeatures();
  setFeatures({ ocr: true });
  const snapshot = getFeatures();
  snapshot.ocr = false;
  snapshot.handwriting = true;
  assert.deepEqual(getFeatures(), { handwriting: false, ocr: true });
  resetFeatures();
});

test('date：localDateKey 使用本机时区（补零）', () => {
  assert.equal(localDateKey(new Date(2026, 0, 5, 23, 59, 59)), '2026-01-05');
  assert.equal(localDateKey(new Date(2026, 11, 31, 0, 0, 0)), '2026-12-31');
  assert.equal(localDateKey(new Date(2026, 10, 14, 9, 30)), '2026-11-14');
});

test('date：nowIso 输出带本地时区偏移的 ISO 8601 且可回解析', () => {
  const date = new Date(2026, 10, 14, 22, 5, 9, 0);
  const iso = nowIso(date);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(iso.slice(0, 19), '2026-11-14T22:05:09');
  assert.equal(Date.parse(iso), date.getTime(), 'offset 必须正确，回解析得到同一时刻');
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('date：formatClock 取 ISO 自带的本地时钟（跨时区阅读不漂移）', () => {
  assert.equal(formatClock('2026-11-14T09:30:00+08:00'), '09:30');
  assert.equal(formatClock('2026-11-14T00:00:00+08:00'), '00:00');
  assert.equal(formatClock('2026-11-14T23:59:59Z'), '23:59');
  assert.equal(formatClock(''), '');
  assert.equal(formatClock('not-a-time'), '');
});
