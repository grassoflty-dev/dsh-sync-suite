// validate-app.mjs 的规则测试：用临时目录构造最小工程树，逐条制造违规并断言退出码与输出。
//
// 前置：本文件不依赖 .build（只跑 validate-app.mjs），可直接
//   node --test apps/arkui-schedule/tools/test/validate.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseJson5 } from '../json5.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'validate-app.mjs');

/** 假 isomorphic-git（≥100KB，仅用于通过规则 6 的体积检查）。 */
const bigIsomorphicGit = () => `/* fixture: fake isomorphic-git bundle */\n${'x'.repeat(120 * 1024)}`;

/** 最小合法工程树：7 条规则全部满足。 */
function legalFiles() {
  return {
    'AppScope/app.json5': `{
      // 应用级配置（JSON5 注释 + 尾逗号 + 单引号）
      "app": {
        "bundleName": 'com.itwill.schedule',
        "versionCode": 1000,
        "versionName": "1.0.0",
        "icon": "$media:icon",
        "label": "$string:app_name",
        "minAPIVersion": 12,
        "targetAPIVersion": 12,
      },
    }`,
    'AppScope/resources/base/element/string.json': `{
  "string": [{ "name": "app_name", "value": "日程助手" }]
}`,
    'build-profile.json5': `{
  "app": {
    "signingConfigs": [],
    "products": [
      { "name": "default", "compatibleSdkVersion": 12, "runtimeOS": "HarmonyOS" },
      { "name": "android", "compatibleSdkVersion": 12, "runtimeOS": "Android" }
    ]
  },
  "modules": [{ "name": "entry", "srcPath": "./entry" }]
}`,
    'oh-package.json5': `{
  "modelVersion": "5.0.0",
  "name": "fixture-app",
}`,
    'hvigorfile.ts': `import { appTasks } from '@ohos/hvigor-ohos-plugin';
export default { system: appTasks, plugins: [] }`,
    'entry/build-profile.json5': `{
  "apiType": "stageMode",
  "targets": [{ "name": "default" }]
}`,
    'entry/hvigorfile.ts': `import { hapTasks } from '@ohos/hvigor-ohos-plugin';
export default { system: hapTasks, plugins: [] }`,
    'entry/oh-package.json5': `{ "name": "entry", "version": "1.0.0" }`,
    'entry/src/main/module.json5': `{
  "module": {
    "name": "entry",
    "type": "entry",
    "mainElement": "EntryAbility",
    "pages": "$profile:main_pages",
    "abilities": [
      {
        "name": "EntryAbility",
        "srcEntry": "./ets/entryability/EntryAbility.ets",
        "icon": "$media:icon",
        "label": "$string:EntryAbility_label",
        "startWindowIcon": "$media:icon",
        "startWindowBackground": "$color:start_window_background"
      }
    ],
    "requestPermissions": [{ "name": "ohos.permission.INTERNET" }]
  }
}`,
    'entry/src/main/resources/base/element/string.json': `{
  "string": [{ "name": "EntryAbility_label", "value": "日程助手" }]
}`,
    'entry/src/main/resources/base/element/color.json': `{
  "color": [{ "name": "start_window_background", "value": "#FFFFFF" }]
}`,
    'entry/src/main/resources/base/media/icon.png': 'fake-png-bytes-for-fixture',
    'entry/src/main/resources/base/profile/main_pages.json': `{
  "src": ["pages/Index", "pages/Edit"]
}`,
    'entry/src/main/ets/entryability/EntryAbility.ets': `import { UIAbility } from '@kit.AbilityKit';

export default class EntryAbility extends UIAbility {
  onCreate(): void {
  }
}`,
    'entry/src/main/ets/common/platform.ts': `export function isHarmonyOS(): boolean {
  return globalThis.__arkuiXPlatform !== 'android';
}`,
    'entry/src/main/ets/pages/Index.ets': `import { isHarmonyOS } from '../common/platform';

@Entry
@Component
@crossplatform
export struct Index {
  build() {
    Column() {
      Text(isHarmonyOS() ? '鸿蒙' : '安卓')
    }
  }
}`,
    'entry/src/main/ets/pages/Edit.ets': `@Entry
@Component
@crossplatform
export struct Edit {
  build() {
    Column() {
    }
  }
}`,
    'entry/src/harmony/ets/pages/Handwriting.ets': `@Entry
@Component
@crossplatform
export struct Handwriting {
  build() {
    Column() {
    }
  }
}`,
    'entry/src/harmony/resources/base/profile/main_pages.json': `{
  "src": ["pages/Index", "pages/Edit", "pages/Handwriting"]
}`,
    'entry/src/main/resources/rawfile/git/isomorphic-git.js': bigIsomorphicGit,
    'entry/src/main/resources/rawfile/git/git-bridge.js': `globalThis.DshGitBridge = { version: 'fixture' };\n`,
    'entry/src/main/resources/rawfile/git/index.html': `<!doctype html>
<html>
  <body>
    <script src="./isomorphic-git.js"></script>
    <script src="./git-bridge.js"></script>
  </body>
</html>
`
  };
}

function writeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'arkui-validate-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'function' ? content() : content, 'utf8');
  }
  return root;
}

function runValidate(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

/** 建树 + 断言失败规则 + 自动清理。 */
function expectFailure(t, mutate, ruleNumber, extraPattern) {
  const files = legalFiles();
  mutate(files);
  const root = writeTree(files);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runValidate(['--root', root]);
  assert.equal(result.status, 1, `应非零退出，实际 ${result.status}\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, new RegExp(`❌ 规则 ${ruleNumber} `), `输出应包含规则 ${ruleNumber} 的失败明细`);
  if (extraPattern !== undefined) {
    assert.match(result.stdout, extraPattern);
  }
  return result;
}

test('validate：最小合法工程树通过 8 条规则并以 0 退出', (t) => {
  const root = writeTree(legalFiles());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runValidate(['--root', root]);
  assert.equal(result.status, 0, `合法树应通过，实际输出：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /✅ 全部通过：8\/8 条规则/);
  assert.doesNotMatch(result.stdout, /❌/);
});

test('validate：规则 1 —— 坏 JSON5（缺少闭合括号）', (t) => {
  const result = expectFailure(
    t,
    (files) => {
      files['oh-package.json5'] = "{ 'modelVersion': '5.0.0', ";
    },
    1,
    /oh-package\.json5/
  );
  assert.doesNotMatch(result.stdout, /❌ 规则 2 /, '只应命中规则 1');
});

test('validate：规则 2 —— 断链 import', (t) => {
  expectFailure(
    t,
    (files) => {
      files['entry/src/main/ets/pages/Index.ets'] = `import { helper } from '../common/missing-helper';

@Entry
@Component
@crossplatform
export struct Index {
  build() {
  }
}`;
    },
    2,
    /断链 import/
  );
});

test('validate：规则 2 —— main 文件的 import 不能只依赖 harmony 覆盖层', (t) => {
  const result = expectFailure(
    t,
    (files) => {
      files['entry/src/harmony/ets/ocr/OcrBatchManager.ets'] = `@crossplatform
export class OcrBatchManager {
  run(): void {
  }
}`;
      files['entry/src/main/ets/components/OcrPanel.ets'] = `import { OcrBatchManager } from '../ocr/OcrBatchManager';

export function makePanel(): OcrBatchManager {
  return new OcrBatchManager();
}`;
    },
    2,
    /不能只依赖 harmony 覆盖层/
  );
  assert.match(result.stdout, /❌ 规则 4 /, '同时应命中规则 4（Android 侧引用 OCR）');
});

test('validate：规则 8 —— main 树静态 import harmony 树文件（允许动态 import）', (t) => {
  const result = expectFailure(
    t,
    (files) => {
      files['entry/src/harmony/ets/common/harmonyOnly.ts'] = `export const harmonyOnly = 'harmony-only';
export interface HarmonyOnlyType {
  value: string;
}
`;
      files['entry/src/main/ets/common/useHarmony.ts'] = `import type { HarmonyOnlyType } from '../../../harmony/ets/common/harmonyOnly';
import { harmonyOnly } from '../../../harmony/ets/common/harmonyOnly';

export const value: string = harmonyOnly;
export type Alias = HarmonyOnlyType;
`;
    },
    8,
    /useHarmony\.ts:1/
  );
  assert.match(result.stdout, /静态 import 了 harmony 覆盖层/, '错误信息应说明规则 8 的原因');
  assert.match(result.stdout, /:2 /, '`import type` 之后的值 import 同样要报（第 2 行）');
  assert.match(result.stdout, /动态 import\(\)/, '错误信息应给出修复建议');
});

test('validate：规则 8 —— main 树用动态 import() 引 harmony 文件时通过', (t) => {
  const files = legalFiles();
  files['entry/src/harmony/ets/common/harmonyOnly.ts'] = `export const harmonyOnly = 'harmony-only';
`;
  files['entry/src/main/ets/common/lazyHarmony.ts'] = `export function loadHarmonyOnly(): Promise<unknown> {
  return import('../../../harmony/ets/common/harmonyOnly');
}
`;
  const root = writeTree(files);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runValidate(['--root', root]);
  assert.equal(result.status, 0, `动态 import 应放行，实际输出：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /✅ 全部通过：8\/8 条规则/);
  assert.doesNotMatch(result.stdout, /❌ 规则 8 /);
});

test('validate：规则 3 —— main_pages 与 pages 目录不一致', (t) => {
  expectFailure(
    t,
    (files) => {
      delete files['entry/src/main/ets/pages/Edit.ets'];
    },
    3,
    /pages\/Edit/
  );
});

test('validate：规则 3 —— 页面文件存在但未登记到 main_pages.json', (t) => {
  expectFailure(
    t,
    (files) => {
      files['entry/src/main/ets/pages/Detail.ets'] = `@Entry
@Component
@crossplatform
export struct Detail {
  build() {
  }
}`;
    },
    3,
    /未登记到 main_pages\.json/
  );
});

test('validate：规则 4 —— Android 可见路径引用 @ohos.multimedia.image / PixelMap', (t) => {
  expectFailure(
    t,
    (files) => {
      files['entry/src/main/ets/components/Screenshot.ets'] = `import { createImageSource } from '@ohos.multimedia.image';

export const shot = createImageSource(new ArrayBuffer(0));
`;
    },
    4,
    /@ohos\.multimedia\.image|PixelMap|图像识别/
  );
});

test('validate：规则 4 —— android 覆盖层引用手写/OCR 目录', (t) => {
  expectFailure(
    t,
    (files) => {
      files['entry/src/android/ets/platform/platformFeatures.ts'] = `import { HandwritingPager } from '../../../../harmony/ets/handwriting/HandwritingPager';

export const pager = HandwritingPager;
`;
    },
    4,
    /Handwriting|handwriting/
  );
});

test('validate：规则 5 —— 含 struct 的 .ets 缺 @crossplatform', (t) => {
  expectFailure(
    t,
    (files) => {
      files['entry/src/main/ets/pages/Edit.ets'] = `@Entry
@Component
export struct Edit {
  build() {
  }
}`;
    },
    5,
    /@crossplatform/
  );
});

test('validate：规则 6 —— rawfile/git 缺少 git-bridge.js', (t) => {
  expectFailure(
    t,
    (files) => {
      delete files['entry/src/main/resources/rawfile/git/git-bridge.js'];
    },
    6,
    /git-bridge\.js/
  );
});

test('validate：规则 6 —— isomorphic-git.js 过小（占位文件）', (t) => {
  expectFailure(
    t,
    (files) => {
      files['entry/src/main/resources/rawfile/git/isomorphic-git.js'] = 'placeholder\n';
    },
    6,
    /小于 102400 字节/
  );
});

test('validate：规则 6 —— index.html 引用的脚本不存在', (t) => {
  expectFailure(
    t,
    (files) => {
      files['entry/src/main/resources/rawfile/git/index.html'] = `<script src="./nope.js"></script>`;
    },
    6,
    /nope\.js/
  );
});

test('validate：规则 7 —— abilities.srcEntry 指向不存在的文件', (t) => {
  expectFailure(
    t,
    (files) => {
      files['entry/src/main/module.json5'] = files['entry/src/main/module.json5'].replace(
        './ets/entryability/EntryAbility.ets',
        './ets/entryability/Nope.ets'
      );
    },
    7,
    /srcEntry/
  );
});

test('validate：规则 7 —— $string / $color 资源名未定义', (t) => {
  expectFailure(
    t,
    (files) => {
      files['entry/src/main/resources/base/element/color.json'] = `{ "color": [] }`;
      files['entry/src/main/resources/base/element/string.json'] = `{ "string": [] }`;
    },
    7,
    /\$string:EntryAbility_label|\$color:start_window_background/
  );
});

test('validate：默认根目录是 apps/arkui-schedule（无需 --root）', () => {
  const result = runValidate([]);
  assert.match(result.stdout, /校验 ArkUI-X 工程：/);
  assert.match(result.stdout.replace(/\\/g, '/'), /apps\/arkui-schedule\s*$/m);
});

test('validate：目录不存在时以 2 退出并给出提示', () => {
  const result = runValidate(['--root', join(tmpdir(), 'arkui-validate-definitely-missing-dir')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /目录不存在/);
});

test('validate：--json 输出机器可读结果', (t) => {
  const root = writeTree(legalFiles());
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runValidate(['--root', root, '--json']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.failures, []);
});

// ---------------------------------------------------------------- json5.mjs 直接单测
// validate-app.mjs 的规则 1 依赖该解析器，这里单独覆盖语法子集与错误定位。

test('json5：注释 / 尾逗号 / 单引号 / 无引号 key 全部支持', () => {
  const doc = parseJson5(`{
    // 行注释
    app: {
      /* 块
         注释 */
      bundleName: 'com.itwill.schedule',
      versionCode: 1000,
      tags: ['a', 'b',],
    },
  }`);
  assert.deepEqual(doc, {
    app: { bundleName: 'com.itwill.schedule', versionCode: 1000, tags: ['a', 'b'] }
  });
});

test('json5：数字形态（负数 / 指数 / 前导小数点 / 十六进制 / Infinity / NaN）', () => {
  const doc = parseJson5(`{ a: -1.5, b: 2e3, c: .5, d: 0x10, e: Infinity, f: NaN, g: true, h: null }`);
  assert.equal(doc.a, -1.5);
  assert.equal(doc.b, 2000);
  assert.equal(doc.c, 0.5);
  assert.equal(doc.d, 16);
  assert.equal(doc.e, Infinity);
  assert.equal(Number.isNaN(doc.f), true);
  assert.equal(doc.g, true);
  assert.equal(doc.h, null);
});

test('json5：字符串转义与反斜杠续行（多行字符串）', () => {
  const doc = parseJson5(`{
    plain: 'a\\tb',
    hex: "\\x41",
    uni: '\\u4e2d',
    quoted: 'it\\'s',
    continued: 'line1\\
line2',
  }`);
  assert.equal(doc.plain, 'a\tb');
  assert.equal(doc.hex, 'A');
  assert.equal(doc.uni, '中');
  assert.equal(doc.quoted, "it's");
  assert.equal(doc.continued, 'line1line2');
});

test('json5：重复 key 后者覆盖，__proto__ 不污染原型', () => {
  const doc = parseJson5(`{ a: 1, a: 2, __proto__: { polluted: true } }`);
  assert.equal(doc.a, 2);
  assert.equal({}.polluted, undefined);
});

test('json5：错误信息带 1 起行号（字符串未闭合 / 缺冒号 / 未闭合对象 / 冗余内容）', () => {
  assert.throws(() => parseJson5(`{\n  a: 'oops\n}`), /第 2 行/);
  assert.throws(() => parseJson5(`{\n  a 1\n}`), /第 2 行/);
  assert.throws(() => parseJson5(`{\n  a: 1,\n`), /第 3 行|对象未闭合/);
  assert.throws(() => parseJson5(`{ a: 1 } extra`), /第 1 行/);
  assert.throws(() => parseJson5(`// 只有注释`), /第 1 行/);
});
