// 「远程控制」设置项（`remoteUrl`）的源码级守卫 + `model/remoteUrl` 纯函数行为。
//
// 为什么大部分是静态断言：`Settings.ets` / `settingsStore.ets` 是 ArkTS（依赖 @kit.ArkData 与
// ArkUI 运行时），Node 里跑不起来。但「地址既在 load 读又在 save/saveSyncState 构造」
// 「点击先归一 → 再落盘 → 最后跳转」「空地址禁用按钮」都是纯文本可判定的事实，用测试固化它们
// 能挡住「加字段忘记读写」「先跳转后保存」这类回归。
//
// 前置：源码断言无需构建；纯函数行为断言用 `tools/.build/model/remoteUrl.js`
// （由 `node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json` 产出，
// 该文件尚未落地时这三例自动跳过，不影响其余用例）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const STORE = readFileSync(new URL('services/settingsStore.ets', ETS), 'utf8');
const PAGE = readFileSync(new URL('pages/Settings.ets', ETS), 'utf8');

/**
 * 截取某个方法体（从 `签名` 到下一个顶层 `async `/`private `/`/**` 段落）。
 *
 * 与 `settingsStorePairing.test.mjs` 同一套规则：三处落盘的断言必须各自只看自己的方法体，
 * 否则「save 里写了、saveSyncState 里漏了」会被整文件搜索放过。
 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到方法：${signature}`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:async |private |\/\*\*)/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** 截取 `@Builder Name() { ... }` 的方法体（按大括号配平，避免相邻 builder 互相污染）。 */
function builderBody(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, `找不到 builder：${name}`);
  let depth = 0;
  let index = source.indexOf('{', start);
  const from = index;
  for (; index < source.length; index++) {
    const char = source[index];
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(from, index + 1);
      }
    }
  }
  assert.fail(`builder ${name} 的大括号不配平`);
}

const LOAD_BODY = methodBody(STORE, 'async load(');
const SAVE_BODY = methodBody(STORE, 'async save(');
const SYNC_STATE_BODY = methodBody(STORE, 'async saveSyncState(');
const REMOTE_GROUP = builderBody(PAGE, 'RemoteGroup');
// openRemote 后面紧跟「通用 Builder」分节：按这个分节标记切，避免把整页后续代码都算进方法体
const OPEN_REMOTE = PAGE.slice(
  PAGE.indexOf('private async openRemote('),
  PAGE.indexOf('// ------------------------------------------------------------------ 通用 Builder')
);

const BUILT = fileURLToPath(new URL('../.build/model/remoteUrl.js', import.meta.url));
const BUILT_HINT = 'model/remoteUrl 尚未落地或未编译到 tools/.build（先跑 tsc，再跑本测试）';

describe('settingsStore：remoteUrl 在 load / save / saveSyncState 三处都落盘', () => {
  test('接口有 remoteUrl 字段（默认空串）且键名是 remoteUrl、SettingsPatch 可局部更新', () => {
    const interfaceBlock = STORE.slice(
      STORE.indexOf('export interface ScheduleSettings'),
      STORE.indexOf('/** 同步状态的部分更新')
    );
    assert.match(interfaceBlock, /remoteUrl: string;/, 'ScheduleSettings 必须有 remoteUrl: string');
    assert.match(STORE, /const KEY_REMOTE_URL: string = 'remoteUrl';/, '键名必须是 remoteUrl');
    const patchBlock = STORE.slice(STORE.indexOf('export interface SettingsPatch'), STORE.indexOf('/** 备用源配置'));
    assert.match(patchBlock, /remoteUrl\?: string;/, 'SettingsPatch 必须可只更新 remoteUrl');
  });

  test('load() 读空串兜底并在返回值里构造（旧数据无该字段 → 空串）', () => {
    assert.match(LOAD_BODY, /prefs\.get\(KEY_REMOTE_URL,\s*''\)/, 'load 必须读 KEY_REMOTE_URL，默认空串');
    assert.match(LOAD_BODY, /remoteUrl: remoteUrl,/, 'load 的返回值必须构造 remoteUrl');
  });

  test('save() 构造 remoteUrl 并写回 preferences（漏写会让保存丢值）', () => {
    assert.match(SAVE_BODY, /remoteUrl: patch\.remoteUrl === undefined \? current\.remoteUrl : patch\.remoteUrl\.trim\(\)/);
    assert.match(SAVE_BODY, /prefs\.put\(KEY_REMOTE_URL, next\.remoteUrl\)/, 'save 必须落盘 KEY_REMOTE_URL');
  });

  test('saveSyncState() 也逐字段构造 remoteUrl（逐字段构造不能漏）', () => {
    assert.match(SYNC_STATE_BODY, /remoteUrl: current\.remoteUrl,/, 'saveSyncState 的逐字段构造里必须有 remoteUrl');
  });
});

describe('设置页：远程控制组（DSH 地址 → 打开远程控制）', () => {
  test('组名 / 字段名 / 按钮 / 占位符逐字存在', () => {
    assert.match(PAGE, /Text\('远程控制'\)/, '缺「远程控制」组标题');
    assert.match(REMOTE_GROUP, /this\.FieldLabel\('DSH 地址'\)/, '缺「DSH 地址」字段名');
    assert.match(REMOTE_GROUP, /TextInput\(\{ text: this\.remoteUrl, placeholder: 'http:\/\/192\.168\.1\.6:3080\/\?token=…' \}\)/);
    assert.match(REMOTE_GROUP, /Button\('打开远程控制'\)/, '缺「打开远程控制」主按钮');
  });

  test('一行灰字说明：局域网 + token 只存本机', () => {
    assert.match(REMOTE_GROUP, /this\.HintLine\('平板需与电脑在同一局域网；地址含 token，只存本机'\)/);
  });

  test('地址为空时按钮禁用，并在按钮下方给出「先填写…」提示', () => {
    assert.match(REMOTE_GROUP, /\.enabled\(this\.remoteUrl\.trim\(\)\.length > 0\)/, '空地址必须 .enabled(false)');
    assert.match(REMOTE_GROUP, /Text\('先填写电脑上的 DSH 地址'\)/);
    // 提示必须在按钮之后（按钮下方），不是按钮之前
    const buttonIndex = REMOTE_GROUP.indexOf("Button('打开远程控制')");
    const hintIndex = REMOTE_GROUP.indexOf("Text('先填写电脑上的 DSH 地址')");
    assert.ok(buttonIndex >= 0 && hintIndex > buttonIndex, '「先填写…」提示要渲染在按钮下方');
  });

  test('点击路径：先 normalizeRemoteUrl → 再保存 → 最后 routeToRemote 跳转（顺序不可颠倒）', () => {
    assert.match(PAGE, /import \{ normalizeRemoteUrl, routeToRemote \} from '\.\.\/model\/remoteUrl';/);
    assert.match(OPEN_REMOTE, /const check: RemoteUrlCheck = normalizeRemoteUrl\(this\.remoteUrl\);/, '点击必须先归一地址');
    assert.match(OPEN_REMOTE, /if \(!check\.ok\) \{[\s\S]*?return;/, '不合法必须早退（不保存、不跳转）');
    assert.match(OPEN_REMOTE, /this\.remoteUrlError = reason\.length > 0 \? `地址不可用：\$\{reason\}`/, '不合法要用 red 文本链路报出可读原因');
    assert.match(OPEN_REMOTE, /await settingsStore\.save\(\{ remoteUrl: check\.url \}\);/, '合法要先保存归一后的地址');
    assert.match(OPEN_REMOTE, /router\.pushUrl\(\{ url: routeToRemote\(\), params: \{ url: check\.url \} \}\);/, '再跳内嵌页并带上 url');
    const saveIndex = OPEN_REMOTE.indexOf('await settingsStore.save(');
    const pushIndex = OPEN_REMOTE.indexOf('router.pushUrl(');
    assert.ok(saveIndex >= 0 && pushIndex > saveIndex, '必须先保存再跳转');
    // 红字渲染走页面已有的 danger 风格 builder
    assert.match(REMOTE_GROUP, /if \(this\.remoteUrlError\.length > 0\) \{\s*this\.ErrorText\(this\.remoteUrlError\)/);
  });

  test('缺 token：橙色次要提示（不是错误），文案逐字存在', () => {
    assert.match(PAGE, /if \(!check\.ok \|\| check\.hasToken\) \{\s*return '';/);
    assert.match(PAGE, /return '地址未包含 token，DSH 可能要求登录';/);
    const hint = PAGE.slice(PAGE.indexOf('private remoteTokenHint('), PAGE.indexOf('private async openRemote('));
    assert.match(hint, /if \(this\.remoteUrl\.trim\(\)\.length === 0\) \{\s*return '';/, '空地址不显示缺 token 提示');
    assert.match(hint, /check\.hasToken/, '缺 token 才提示');
    // 橙色/次要色：warning 令牌，且不是 danger
    const tokenHintBlock = REMOTE_GROUP.slice(REMOTE_GROUP.indexOf('this.remoteTokenHint()'));
    assert.match(tokenHintBlock, /\$r\('app\.color\.warning'\)/, '缺 token 提示要用 warning（橙色），不是 danger');
    assert.equal(/remoteTokenHint\(\)[\s\S]{0,400}?\$r\('app\.color\.danger'\)/.test(REMOTE_GROUP), false, '缺 token 不是错误，不能用 danger');
  });

  test('组顺序：远程控制排在「关于」之前（紧凑屏与宽屏两处都接上）', () => {
    const calls = [...PAGE.matchAll(/this\.RemoteGroup\(\)/g)].length;
    assert.ok(calls >= 2, `紧凑屏与宽屏都要渲染远程控制组，实际 ${calls} 处`);
    const compact = PAGE.slice(PAGE.indexOf('CompactBody() {'), PAGE.indexOf('WideBody() {'));
    const wide = PAGE.slice(PAGE.indexOf('WideBody() {'));
    for (const [name, body] of [
      ['CompactBody', compact],
      ['WideBody', wide]
    ]) {
      const remoteIndex = body.indexOf('this.RemoteGroup()');
      const aboutIndex = body.indexOf('this.AboutGroup()');
      assert.ok(remoteIndex >= 0, `${name} 没有渲染远程控制组`);
      assert.ok(aboutIndex > remoteIndex, `${name} 里远程控制必须在「关于」之前`);
    }
  });

  test('load 后把 remoteUrl 铺回表单；整表「保存设置」也带上它（不被旧值覆盖）', () => {
    assert.match(PAGE, /this\.remoteUrl = settings\.remoteUrl;/, 'applySettings 必须铺回 remoteUrl');
    assert.match(PAGE, /remoteUrl: this\.remoteUrl/, '「保存设置」的 patch 里要带 remoteUrl');
    assert.match(PAGE, /promptAction\.showToast\(\{ message: '已保存', duration: toastMsFor\(false\) \}\)/, '保存成功要 toast「已保存」');
  });
});

// 「访问令牌（可选）」是 secret：settingsStore 必须**成对**读写（load 读、save 写、
// saveSyncState 逐字段构造），设置页必须走"只写"通道（已保存的明文只 mask 后上屏，
// 绝不回填输入框）。这些都是纯文本可判定的契约，用静态断言钉住。
describe('访问令牌（可选）：settingsStore 成对读写 + 设置页只写通道', () => {
  test('接口 / SettingsPatch / 键名三处都有 remoteToken', () => {
    const interfaceBlock = STORE.slice(
      STORE.indexOf('export interface ScheduleSettings'),
      STORE.indexOf('/** 同步状态的部分更新')
    );
    assert.match(interfaceBlock, /remoteToken: string;/, 'ScheduleSettings 必须有 remoteToken: string');
    assert.match(STORE, /const KEY_REMOTE_TOKEN: string = 'remoteToken';/, '键名必须是 remoteToken');
    const patchBlock = STORE.slice(STORE.indexOf('export interface SettingsPatch'), STORE.indexOf('/** 备用源配置'));
    assert.match(patchBlock, /remoteToken\?: string;/, 'SettingsPatch 必须可只更新 remoteToken');
  });

  test('load 读 / save 写 / saveSyncState 逐字段构造，三处成对（漏一处会丢令牌）', () => {
    assert.match(LOAD_BODY, /prefs\.get\(KEY_REMOTE_TOKEN,\s*''\)/, 'load 必须读 KEY_REMOTE_TOKEN，默认空串');
    assert.match(LOAD_BODY, /remoteToken: remoteToken\.trim\(\)/, 'load 的返回值必须构造 remoteToken（trim）');
    assert.match(
      SAVE_BODY,
      /remoteToken: patch\.remoteToken === undefined \? current\.remoteToken : patch\.remoteToken\.trim\(\)/,
      'save 必须「未传则沿用、传了则 trim」——不能把空串当默认往里写'
    );
    assert.match(SAVE_BODY, /prefs\.put\(KEY_REMOTE_TOKEN, next\.remoteToken\)/, 'save 必须落盘 KEY_REMOTE_TOKEN');
    assert.match(SYNC_STATE_BODY, /remoteToken: current\.remoteToken,/, 'saveSyncState 的逐字段构造里必须有 remoteToken');
  });

  test('设置页：password 输入框 + 已保存只显示打码 + 「清除令牌」按钮', () => {
    assert.match(PAGE, /maskRemoteToken/, '页面必须用 maskRemoteToken 打码');
    assert.match(PAGE, /if \(this\.remoteUsesToken\(\)\) \{/, '令牌输入框只在方式的 fields 含 token 时渲染');
    assert.match(
      REMOTE_GROUP,
      /TextInput\(\{ text: this\.remoteToken, placeholder: this\.remoteFieldPlaceholder\('token'\) \}\)/,
      '令牌输入框绑定"这次想改成的值" remoteToken'
    );
    assert.match(REMOTE_GROUP, /\.type\(InputType\.Password\)/, '令牌输入框必须是密码类型');
    assert.match(PAGE, /return '保存后生效';/, '输入框有值时要提示「保存后生效」');
    assert.match(
      PAGE,
      /已保存访问令牌（\$\{maskRemoteToken\(this\.savedRemoteToken\)\}）/,
      '已保存时显示「已保存访问令牌（<mask>）」'
    );
    assert.match(REMOTE_GROUP, /Text\('清除令牌'\)/, '缺「清除令牌」小按钮');
    assert.match(PAGE, /await settingsStore\.save\(\{ remoteToken: '' \}/, '「清除令牌」必须落盘空串');
  });

  test('只写通道：明文不回填输入框（输入框只在用户输入时被写）', () => {
    assert.match(PAGE, /this\.savedRemoteToken = settings\.remoteToken\.trim\(\);/, '已保存令牌只进 private 的 savedRemoteToken');
    assert.equal(
      /this\.remoteToken = settings\.remoteToken/.test(PAGE),
      false,
      '绝不能把已保存的明文回填到输入框（旁人就该看不到明文）'
    );
    assert.equal(
      /TextInput\(\{ text: this\.savedRemoteToken/.test(PAGE),
      false,
      '输入框不能绑定已保存的明文'
    );
    assert.match(PAGE, /this\.remoteToken = '';/, '铺表单 / 保存成功后要把输入框清空');
    // 留空 = 不改：整表保存必须走 effectiveRemoteToken()，否则空输入框会悄悄清掉已保存令牌
    assert.match(PAGE, /remoteToken: this\.effectiveRemoteToken\(\)/, '整表保存要沿用已保存的令牌');
    assert.match(
      PAGE,
      /return effectiveToken\(this\.remoteToken, this\.savedRemoteToken\);/,
      '沿用语义与 Git token 同一套实现'
    );
  });
});

describe('model/remoteUrl：纯函数行为（编译产物存在时执行）', () => {
  test(
    'normalizeRemoteUrl：192.168.1.6:3080/?token=abc → http://192.168.1.6:3080/?token=abc 且 hasToken=true',
    { skip: existsSync(BUILT) ? false : BUILT_HINT },
    async () => {
      const { normalizeRemoteUrl } = await import(pathToFileURL(BUILT).href);
      const check = normalizeRemoteUrl('192.168.1.6:3080/?token=abc');
      assert.equal(check.ok, true, '合法内网地址必须 ok');
      assert.equal(check.url, 'http://192.168.1.6:3080/?token=abc', '缺 scheme 时补 http://');
      assert.equal(check.hasToken, true, '带 ?token= 必须识别为 hasToken');
      assert.equal(typeof check.hadScheme, 'boolean', 'hadScheme 必须是布尔值');
      assert.equal(check.hadScheme, false, '原文没有 scheme，hadScheme 应为 false');
    }
  );

  test(
    'normalizeRemoteUrl：空地址不合法（ok=false），按钮禁用与红字的前提',
    { skip: existsSync(BUILT) ? false : BUILT_HINT },
    async () => {
      const { normalizeRemoteUrl } = await import(pathToFileURL(BUILT).href);
      const empty = normalizeRemoteUrl('');
      assert.equal(empty.ok, false, '空地址必须 ok=false');
      assert.equal(typeof empty.reason, 'string', '不合法要给可展示的 reason');
    }
  );

  test(
    'routeToRemote：返回非空路由，指向内嵌的 RemoteControl 页',
    { skip: existsSync(BUILT) ? false : BUILT_HINT },
    async () => {
      const { routeToRemote } = await import(pathToFileURL(BUILT).href);
      const route = routeToRemote();
      assert.equal(typeof route, 'string');
      assert.ok(route.length > 0, '路由不能是空串');
      assert.match(route, /RemoteControl/, '路由必须指向 RemoteControl 页');
    }
  );
});
