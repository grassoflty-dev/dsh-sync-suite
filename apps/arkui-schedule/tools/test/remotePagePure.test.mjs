// mod-app-remote-page-pure：远程页「只显示电脑自己的 DSH 页面」的纯模型单测 + 源码级守卫。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型 `model/remotePageChrome.ts` 零 SDK / 零 UI import，编译产物可直接被 Node 加载。
//
// 覆盖两类事实：
//   A–C：表面决策 / 浮动操作 / 配对诊断文本（纯函数，逐条钉死）；
//   D–G：页面源码形状——我们下架的东西确实不在页面上、错误路径的三段式仍在、成功路径上
//        除浮动图标轨外没有任何我们自己的东西、诊断只在浮层里出现且地址不带 token。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const ETS = resolve(HERE, '../../entry/src/main/ets');
const PAGE_ETS = resolve(ETS, 'pages/RemoteControl.ets');
const ERROR_STATE_ETS = resolve(ETS, 'components/state/ErrorState.ets');
const MODEL_TS = resolve(ETS, 'model/remotePageChrome.ts');

const chrome = await import('../.build/model/remotePageChrome.js');
const {
  remoteSurface,
  chromeAffordances,
  pairingDiagnostics,
  DIAGNOSTICS_TITLE,
  DIAGNOSTICS_LONG_PRESS_MS,
  DIAGNOSTICS_GLYPH,
  BACK_GLYPH,
  RELOAD_GLYPH,
  ADDRESS_PREFIX,
  PIN_PREFIX,
  PIN_MISSING_LINE
} = chrome;

/** 页面原文（含注释）：文案绝迹类守卫直接扫原文，等价于「用户一个字都看不到」。 */
const PAGE = readFileSync(PAGE_ETS, 'utf8');
/** 去掉注释后的源码：形状类守卫只看代码，不把注释里提到的名字算作实现。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const CODE = stripComments(PAGE);
const ERROR_STATE = readFileSync(ERROR_STATE_ETS, 'utf8');
const MODEL = readFileSync(MODEL_TS, 'utf8');

/** 取某个 `@Builder` / 方法之后的花括号块（同缩进的 `}` 结尾），只用于源码形状断言。 */
const blockAfter = (src, marker) => {
  const at = src.indexOf(marker);
  if (at < 0) {
    return '';
  }
  const open = src.indexOf('{', at + marker.length - 1);
  if (open < 0) {
    return '';
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(open + 1, i);
      }
    }
  }
  return '';
};

const SURFACES = ['loading', 'empty', 'page', 'error'];

describe('A. 表面决策：成功路径只能是 page', () => {
  test('A1 还在读地址 → loading', () => {
    assert.equal(remoteSurface({ phase: 'loading', webMounted: false, hasLoadError: false }), 'loading');
    assert.equal(remoteSurface({ phase: 'loading', webMounted: true, hasLoadError: true }), 'loading');
  });

  test('A2 没有可用地址（empty 及任何未知 phase）→ empty', () => {
    assert.equal(remoteSurface({ phase: 'empty', webMounted: false, hasLoadError: false }), 'empty');
    assert.equal(remoteSurface({ phase: 'nonsense', webMounted: true, hasLoadError: false }), 'empty');
  });

  test('A3 决策拒绝（ready 但未挂 Web）→ error（页面从未加载）', () => {
    assert.equal(remoteSurface({ phase: 'ready', webMounted: false, hasLoadError: false }), 'error');
    assert.equal(remoteSurface({ phase: 'ready', webMounted: false, hasLoadError: true }), 'error');
  });

  test('A4 ready + 已挂载 + 无错误 → page（屏幕上只有 DSH 页面）', () => {
    assert.equal(remoteSurface({ phase: 'ready', webMounted: true, hasLoadError: false }), 'page');
  });

  test('A5 ready + 已挂载 + 主文档加载失败 → error（整屏错误块替换页面）', () => {
    assert.equal(remoteSurface({ phase: 'ready', webMounted: true, hasLoadError: true }), 'error');
  });

  test('A6 返回值封闭：只有四种表面，绝不返回空串/undefined 让页面掉进空白', () => {
    for (const phase of ['loading', 'empty', 'ready', '', 'READY']) {
      for (const webMounted of [true, false]) {
        for (const hasLoadError of [true, false]) {
          const surface = remoteSurface({ phase, webMounted, hasLoadError });
          assert.ok(SURFACES.includes(surface), `未知表面 ${String(surface)}`);
        }
      }
    }
  });
});

describe('B. 浮动操作：返回永远在，刷新只在有地址且已到终态时出现', () => {
  test('B1 back 恒为 true（任何表面 × 有无地址 × 是否拒绝终态）', () => {
    for (const surface of SURFACES) {
      for (const hasAddress of [true, false]) {
        for (const refusalTerminal of [true, false]) {
          assert.equal(chromeAffordances(surface, hasAddress, refusalTerminal).back, true,
            `${surface}/${hasAddress}/${refusalTerminal} 不能没有出口`);
        }
      }
    }
  });

  test('B2 reload 只在 page / error + 地址非空 + 非拒绝终态时为 true', () => {
    const expected = [
      ['loading', true, false, false], ['loading', false, false, false],
      ['empty', true, false, false], ['empty', false, false, false],
      ['page', true, false, true], ['page', false, false, false],
      ['error', true, false, true], ['error', false, false, false],
      // 证书拒绝终态：重新加载不会换一张证书，不给一个点了没反应的刷新图标。
      ['error', true, true, false], ['page', true, true, false]
    ];
    for (const [surface, hasAddress, refusalTerminal, want] of expected) {
      assert.equal(chromeAffordances(surface, hasAddress, refusalTerminal).reload, want,
        `${surface}/${hasAddress}/${refusalTerminal}`);
    }
  });

  test('B3 只有两个操作位（没有第三块自造 chrome 的位置）', () => {
    const keys = Object.keys(chromeAffordances('page', true, false)).sort();
    assert.deepEqual(keys, ['back', 'reload']);
  });
});

describe('C. 配对诊断文本（从页面搬进浮层，文案仍只有一处）', () => {
  test('C1 有指纹：两行，前缀逐字来自常量', () => {
    const text = pairingDiagnostics({ address: 'http://192.168.1.6:3080/', pin: 'AB:CD' });
    assert.equal(text, `${ADDRESS_PREFIX}http://192.168.1.6:3080/\n${PIN_PREFIX}AB:CD`);
    assert.equal(text.split('\n').length, 2);
  });

  test('C2 未配对：末行说清后果，不输出空指纹冒充匹配', () => {
    const text = pairingDiagnostics({ address: 'https://pc.local:3080/', pin: '' });
    const lines = text.split('\n');
    assert.equal(lines[lines.length - 1], PIN_MISSING_LINE);
    assert.match(PIN_MISSING_LINE, /未配对/);
    assert.equal(text.includes(`${PIN_PREFIX}\n`), false, '不得出现「配对指纹：」后接空值');
  });

  test('C3 地址还没解析出来时只出指纹行（不渲染空地址行）', () => {
    const text = pairingDiagnostics({ address: '   ', pin: 'AB:CD' });
    assert.equal(text, `${PIN_PREFIX}AB:CD`);
    assert.equal(text.includes(ADDRESS_PREFIX), false);
  });

  test('C4 两端空白被裁掉（地址 / 指纹都不带多余空格）', () => {
    assert.equal(pairingDiagnostics({ address: '  a  ', pin: '  b  ' }), `${ADDRESS_PREFIX}a\n${PIN_PREFIX}b`);
  });

  test('C5 常量：浮层首行 / 长按时长 / 三个字形都在模型里，组件不写第二份', () => {
    assert.equal(DIAGNOSTICS_TITLE, '连接诊断');
    assert.equal(DIAGNOSTICS_LONG_PRESS_MS, 600);
    for (const glyph of [BACK_GLYPH, RELOAD_GLYPH, DIAGNOSTICS_GLYPH]) {
      assert.equal(typeof glyph, 'string');
      assert.ok(glyph.length > 0);
    }
    assert.notEqual(new Set([BACK_GLYPH, RELOAD_GLYPH, DIAGNOSTICS_GLYPH]).size, 1, '三个字形不能重复');
    for (const constant of ['DIAGNOSTICS_TITLE', 'DIAGNOSTICS_LONG_PRESS_MS', 'BACK_GLYPH',
      'RELOAD_GLYPH', 'DIAGNOSTICS_GLYPH']) {
      assert.equal(MODEL.includes(constant), true, `模型必须定义 ${constant}`);
      assert.equal(PAGE.includes(`'连接诊断'`), false, '页面不得写死浮层标题（从模型取）');
    }
  });
});

describe('D. 源码守卫：我们下架的文案在页面原文里逐字绝迹', () => {
  // 产品决定原文：「把你写的发指令给电脑 / 顶部的传输分类：局域网 等等的提示全部都删了」。
  const REMOVED = [
    '发指令到这台电脑',
    '确认发送',
    '传输分类',
    '已比对叶证书指纹',
    '浏览器实时视图'
  ];

  test('D1 五个下架文案一处都不剩（扫原文，注释也不算数）', () => {
    for (const text of REMOVED) {
      assert.equal(PAGE.includes(text), false, `页面不得再出现「${text}」`);
    }
  });

  test('D2 命令面板的其余文案与按钮也绝迹（不是只删了标题）', () => {
    for (const text of ['发送指令', '目标：', '工具：', '预览版']) {
      assert.equal(PAGE.includes(text), false, `页面不得再出现「${text}」`);
    }
  });

  test('D3 组件与命令通道接线绝迹：0 次 import / 0 次挂载 / 不再派生目标名与授权', () => {
    assert.equal(CODE.includes('RemoteCommandComposer'), false, '页面不得 import 或挂载 composer');
    for (const gone of ['targetDisplayName', 'targetCommandGranted', 'instanceGrantStore', 'canPrompt(']) {
      assert.equal(CODE.includes(gone), false, `页面不得再有命令通道接线 ${gone}`);
    }
  });
});

describe('E. 源码守卫：错误路径仍是唯一可以替换页面的东西', () => {
  test('E1 中文三段式的「发生了什么 / 下一步」逐字仍在', () => {
    assert.equal(PAGE.includes('打不开这台电脑上的 DSH 页面'), true, '缺错误标题');
    assert.equal(PAGE.includes('确认电脑上的 DSH 已启动'), true, '缺「下一步」建议');
  });

  test('E2 错误块仍由 ErrorState 渲染（重试 / 下一步标记仍在组件里）', () => {
    assert.match(CODE, /import \{ ErrorState \} from '\.\.\/components\/state\/ErrorState';/);
    assert.equal((CODE.match(/ErrorState\(\{/g) ?? []).length, 1, '错误块只能有一处实例化');
    assert.match(ERROR_STATE, /const RETRY_LABEL: string = '重试'/);
    assert.match(ERROR_STATE, /const NEXT_MARK: string = '下一步：'/);
    assert.match(CODE, /onRetry: \(\): void => \{\s*this\.refresh\(\);/,
      '「重试」仍接 refresh()，不是死按钮');
  });

  test('E3 整屏：错误块在两处（Web 上的加载失败 / 证书拒绝终态）都撑满容器', () => {
    const calls = [...CODE.matchAll(/this\.ErrorView\(\)/g)].map((m) => m.index);
    assert.equal(calls.length, 2, '错误块必须且只能出现在「加载失败」与「拒绝终态」两处');
    for (const at of calls) {
      const around = CODE.slice(at, at + 260);
      assert.match(around, /\.height\('100%'\)/, '错误块容器必须整屏高，不能只占一条');
    }
    assert.match(CODE, /if \(this\.surface\(\) === 'error'\) \{/, '加载失败必须由纯模型表面决策触发');
  });

  test('E4 错误路径不出现英文页/空白页兜底：只在主文档失败时换页，子资源失败放行', () => {
    assert.equal(CODE.includes('isMainFrame()'), true);
    assert.equal((CODE.match(/isMainFrame\(\)/g) ?? []).length, 2,
      'onErrorReceive / onHttpErrorReceive 都必须只看主文档');
    assert.equal(/Page failed|Failed to load|Error loading/i.test(PAGE), false, '不得渲染英文错误页');
  });
});

describe('F. 源码守卫：成功路径上没有我们自己的 chrome', () => {
  test('F1 build() 只有四态分支 + 浮动图标轨，主体分支里没有我们自造的文案', () => {
    const build = blockAfter(CODE, 'build() {');
    assert.ok(build.length > 0);
    assert.equal((build.match(/this\.RemoteBody\(\)/g) ?? []).length, 1);
    assert.equal((build.match(/this\.RefusedView\(\)/g) ?? []).length, 1);
    assert.equal((build.match(/this\.Rail\(\)/g) ?? []).length, 1);
    for (const banned of ['TransportInfo', 'Text(', 'Divider(', 'ActionButton']) {
      assert.equal(build.includes(banned), false, `build() 不得直接渲染 ${banned}`);
    }
  });

  test('F2 传输/证书诊断只经 DiagnosticsSheet 渲染（成功路径上不出现）', () => {
    const sheetAt = CODE.indexOf('DiagnosticsSheet() {');
    const transportAt = CODE.indexOf('TransportInfo() {');
    assert.ok(sheetAt > 0 && transportAt > sheetAt, '浮层 builder 必须在 TransportInfo 之前');
    const infoCalls = [...CODE.matchAll(/this\.TransportInfo\(\)/g)].map((m) => m.index);
    assert.equal(infoCalls.length, 1, 'TransportInfo 只能被调用一次（在浮层里）');
    assert.ok(infoCalls[0] > sheetAt && infoCalls[0] < transportAt,
      '唯一一次调用必须落在 DiagnosticsSheet 内部');
    const pairingCalls = [...CODE.matchAll(/this\.pairingText\(\)/g)].map((m) => m.index);
    assert.equal(pairingCalls.length, 1, '配对诊断正文只能渲染一次');
    assert.ok(pairingCalls[0] > sheetAt && pairingCalls[0] < transportAt);
  });

  test('F3 浮层默认关闭且只有一个入口：bindSheet 恰好一次，绑本页 DiagnosticsSheet', () => {
    assert.equal((CODE.match(/\.bindSheet\(/g) ?? []).length, 1);
    assert.match(CODE, /\.bindSheet\(this\.showDiagnostics, this\.DiagnosticsSheet\(\)/);
    assert.match(CODE, /@State showDiagnostics: boolean = false;/, '默认必须是关的');
  });

  test('F4 浮动图标轨只有字形，没有标题 / 分类 / 说明文字', () => {
    const rail = blockAfter(CODE, 'Rail() {');
    assert.ok(rail.length > 0);
    for (const glyphConst of ['BACK_GLYPH', 'RELOAD_GLYPH', 'DIAGNOSTICS_GLYPH']) {
      assert.equal(rail.includes(glyphConst), true, `图标轨必须渲染 ${glyphConst}`);
    }
    assert.equal(/[\u4e00-\u9fff]/.test(rail), false, '图标轨里不得出现任何中文文案');
    assert.equal(rail.includes('Text(`'), false, '图标轨不得拼任何字符串');
  });

  test('F5 没有我们自己的标题栏：Header builder 与页面标题都不在了', () => {
    assert.equal(CODE.includes('Header() {'), false, '不得再有自造标题栏');
    assert.equal(CODE.includes('远程控制'), false, '页面不再渲染自己的标题文字');
    assert.equal(CODE.includes('REFRESH_LABEL'), false, '刷新不再是按钮文案');
  });

  test('F6 出口接线：返回走 router.back()，刷新走 controller.refresh()，长按开诊断', () => {
    assert.match(CODE, /private goBack\(\): void \{\s*router\.back\(\);/, '返回必须真的后退');
    assert.match(CODE, /\.onClick\(\(\): void => \{\s*this\.goBack\(\);/, '返回图标必须接 goBack()');
    assert.match(CODE, /\.onClick\(\(\): void => \{\s*this\.refresh\(\);/, '刷新图标必须接 refresh()');
    assert.match(CODE, /LongPressGesture\(\{ repeat: false, duration: DIAGNOSTICS_LONG_PRESS_MS \}\)/,
      '长按刷新图标必须以模型时长打开诊断');
    assert.ok((CODE.match(/this\.showDiagnostics = true;/g) ?? []).length >= 2,
      'ⓘ 与长按两条入口都要能打开浮层');
    assert.match(CODE, /chromeAffordances\(this\.surface\(\), this\.url\.length > 0, this\.tlsBlocked\)/,
      '刷新图标的可见性必须把证书拒绝终态一起交给纯模型判定');
  });
});

describe('G. 源码守卫：诊断浮层里也不出现令牌', () => {
  test('G1 地址先剥 token 再交给纯模型（浮层与落盘同一口径）', () => {
    const pairing = blockAfter(CODE, 'private pairingText(): string');
    assert.ok(pairing.length > 0, '缺 pairingText()');
    assert.match(pairing, /address: stripRemoteToken\(this\.url\)/);
    assert.equal(/address:\s*this\.url\b/.test(pairing), false, '不得把带 token 的原 URL 交给诊断');
  });

  test('G2 传输分类 / 证书标签只在 TransportInfo() 里被读（浮层内容，不是页面 chrome）', () => {
    const transport = blockAfter(CODE, 'TransportInfo() {');
    assert.ok(transport.length > 0);
    assert.equal((transport.match(/this\.transportLabel/g) ?? []).length, 1,
      'TransportInfo 里只许读一次 transportLabel');
    assert.equal((transport.match(/this\.pageLabel/g) ?? []).length, 1,
      'TransportInfo 里只许读一次 pageLabel');
    // 页面上只有「赋值 + 浮层里的这一处读」：绝不另开一份可见副本。
    assert.equal((CODE.match(/this\.transportLabel/g) ?? []).length, 3,
      'transportLabel 只允许两处赋值 + 浮层一次读');
    assert.equal((CODE.match(/this\.pageLabel/g) ?? []).length, 3,
      'pageLabel 只允许两处赋值 + 浮层一次读');
  });
});
