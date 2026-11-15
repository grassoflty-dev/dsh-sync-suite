// 平台装配（P0-1）测试：运行时检测纯函数 + 构建配置分层（sourceRoots）+ 共享层装配逻辑的形状。
//
// 前置：本文件 import `../.build/common/platform.js`，需先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖点：
// 1. `detectPlatformFrom(osFullName?, deviceType?)` 纯函数：harmony/ohos → harmony，
//    android → android，无法判定/缺省 → android（fail-closed，第二道防线）；
// 2. 构建装配（方案 b）：`entry/build-profile.json5` 的 target 用 `source.sourceRoots` 区分构建输入
//    （鸿蒙 = main + harmony，Android = 只有 main），根 `build-profile.json5` 的 module.targets
//    把每个 target 映射到同名 product，且 root 的 target 名必须在 entry 里存在 —— 这正是 P0-1
//    「鸿蒙构建解析到 Android 默认 platformFeatures」的根因；
// 3. 共享层 `platformFeatures.ts#installPlatformFeatures()` 不再写死 `setPlatform('android')`，
//    改为依据 `getPlatform()` 装配（静态断言；该模块 import 了同级模块，Node 侧无法直接执行）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseJson5 } from '../json5.mjs';
import { detectPlatformFrom } from '../.build/common/platform.js';

const ROOT = new URL('../../', import.meta.url);

function readText(relPath) {
  return readFileSync(new URL(relPath, ROOT), 'utf8');
}

function readJson5(relPath) {
  return parseJson5(readText(relPath));
}

// ---------------------------------------------------------------- detectPlatformFrom

test('detectPlatformFrom：OpenHarmony / HarmonyOS 的 osFullName 判定为 harmony', () => {
  assert.equal(detectPlatformFrom('OpenHarmony 5.0.0', 'phone'), 'harmony');
  assert.equal(detectPlatformFrom('HarmonyOS NEXT', 'phone'), 'harmony');
  assert.equal(detectPlatformFrom('HARMONYOS 5.0.0', 'tablet'), 'harmony');
  assert.equal(detectPlatformFrom('ohos 5.0.0', 'phone'), 'harmony');
});

test('detectPlatformFrom：Android 的 osFullName 判定为 android', () => {
  assert.equal(detectPlatformFrom('Android 14', 'phone'), 'android');
  assert.equal(detectPlatformFrom('ANDROID 12', 'tablet'), 'android');
  assert.equal(detectPlatformFrom('android', ''), 'android');
});

test('detectPlatformFrom：无法判定 / 缺省 / 空串一律 fail-closed 为 android', () => {
  assert.equal(detectPlatformFrom(undefined, undefined), 'android');
  assert.equal(detectPlatformFrom(), 'android');
  assert.equal(detectPlatformFrom('', ''), 'android');
  assert.equal(detectPlatformFrom('iOS 18', 'phone'), 'android');
  assert.equal(detectPlatformFrom('Linux 6.6', 'default'), 'android');
});

test('detectPlatformFrom：deviceType 作兜底证据（大小写不敏感）', () => {
  assert.equal(detectPlatformFrom('', 'ohos'), 'harmony');
  assert.equal(detectPlatformFrom(undefined, 'HARMONY'), 'harmony');
  assert.equal(detectPlatformFrom(undefined, 'android'), 'android');
});

test('detectPlatformFrom：两个证据冲突时以鸿蒙为准（任一证据指向鸿蒙即认鸿蒙）', () => {
  assert.equal(detectPlatformFrom('Android 14', 'ohos'), 'harmony');
  assert.equal(detectPlatformFrom('OpenHarmony 5.0.0', 'android'), 'harmony');
});

// ---------------------------------------------------------------- 构建装配（方案 b）

test('build-profile（entry）：HarmonyOS = main + harmony；ArkUI-X = 只有 main', () => {
  const doc = readJson5('entry/build-profile.json5');
  assert.ok(Array.isArray(doc.targets), 'entry/build-profile.json5 必须有 targets 数组');
  const harmonyTarget = doc.targets.find((target) => target.name === 'default');
  assert.ok(harmonyTarget !== undefined, '缺少 default target');
  assert.deepEqual(harmonyTarget.source.sourceRoots, ['./src/main', './src/harmony']);

  // ArkUI-X/Android 变体：源码只有 main，手写/OCR 物理上不参与编译
  const arkuiX = readJson5('entry/build-profile.arkui-x.json5');
  const androidTarget = arkuiX.targets.find((target) => target.name === 'default');
  assert.ok(androidTarget !== undefined, 'ArkUI-X 变体缺少 default target');
  assert.deepEqual(androidTarget.source.sourceRoots, ['./src/main']);
});

test('build-profile（root）：target 与 product 一一对应，且两套 profile 都只有 HarmonyOS product', () => {
  for (const file of ['build-profile.json5', 'build-profile.arkui-x.json5']) {
    const rootDoc = readJson5(file);
    const entryDoc = readJson5(file === 'build-profile.json5' ? 'entry/build-profile.json5' : 'entry/build-profile.arkui-x.json5');
    const entryTargets = new Set(entryDoc.targets.map((target) => target.name));
    const products = new Set(rootDoc.app.products.map((product) => product.name));
    const entryModule = rootDoc.modules.find((item) => item.name === 'entry');
    assert.ok(entryModule !== undefined, file + ' 缺少 entry module');
    for (const target of entryModule.targets) {
      assert.ok(entryTargets.has(target.name), file + ' 的 module.target ' + target.name + ' 在 entry 里不存在');
      for (const product of target.applyToProducts) {
        assert.ok(products.has(product), 'applyToProducts 里的 ' + product + ' 不是已定义的 product');
      }
    }
    // ArkUI-X 的 hvigor 仍按 HarmonyOS schema 校验，不允许 runtimeOS:"Android"
    for (const product of rootDoc.app.products) {
      assert.equal(product.runtimeOS, 'HarmonyOS', file + ' 只能声明 HarmonyOS product');
    }
  }
});

test('ohosTest target 在 entry 里存在（ArkUI-X/ace 构建需要）', () => {
  for (const file of ['entry/build-profile.json5', 'entry/build-profile.arkui-x.json5']) {
    const doc = readJson5(file);
    assert.ok(doc.targets.some((target) => target.name === 'ohosTest'), file + ' 缺少 ohosTest target');
  }
});

// ---------------------------------------------------------------- 共享层装配逻辑（静态断言）

test('platformFeatures（共享层）：installPlatformFeatures 依据 getPlatform() 装配，不再写死 android', () => {
  const source = readText('entry/src/main/ets/common/platformFeatures.ets');
  const start = source.indexOf('export function installPlatformFeatures');
  assert.notEqual(start, -1, 'platformFeatures.ts 必须有 installPlatformFeatures');
  const body = source.slice(start, source.indexOf('\n}', start));

  assert.match(body, /getPlatform\(\)/, '必须读取 getPlatform() 决定装配结果');
  assert.doesNotMatch(body, /setPlatform\('android'\)/, '不能写死 setPlatform(\'android\')（P0-1 根因）');
  assert.match(body, /handwriting:\s*true/, 'harmony 分支必须打开手写');
  assert.match(body, /ocr:\s*true/, 'harmony 分支必须打开 OCR');
  assert.match(body, /handwriting:\s*false/, '非 harmony 分支必须关闭手写（fail-closed）');
});

test('platformFeatures（鸿蒙覆盖层）：无条件 setPlatform(harmony) + 打开手写/OCR', () => {
  const source = readText('entry/src/harmony/ets/common/platformFeatures.ets');
  const start = source.indexOf('export function installPlatformFeatures');
  assert.notEqual(start, -1, '鸿蒙覆盖层必须有 installPlatformFeatures');
  const body = source.slice(start, source.indexOf('\n}', start));

  assert.match(body, /setPlatform\('harmony'\)/);
  assert.match(body, /handwriting:\s*true/);
  assert.match(body, /ocr:\s*true/);
});
