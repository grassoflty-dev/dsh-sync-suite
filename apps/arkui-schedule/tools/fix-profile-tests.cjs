const fs = require('fs')
const f = 'tools/test/platformDetect.test.mjs'
let s = fs.readFileSync(f, 'utf8')

const start = s.indexOf("test('build-profile（entry）")
const end = s.indexOf("// ---------------------------------------------------------------- 共享层装配逻辑")
if (start < 0 || end < 0) { console.error('markers not found'); process.exit(1) }

const replacement = `test('build-profile（entry）：HarmonyOS = main + harmony；ArkUI-X = 只有 main', () => {
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

`
s = s.slice(0, start) + replacement + s.slice(end)
fs.writeFileSync(f, s)
console.log('rewrote build-profile tests')
