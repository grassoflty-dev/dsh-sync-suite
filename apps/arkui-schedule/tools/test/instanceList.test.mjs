// `mod-instance-list`：播种 / 旧配置迁移 / 列表展示纯逻辑 + 页面与入口静态断言。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型 `model/instanceSeed.ts` 有相对 import，编译产物是省略扩展名的 ES import，
// 故用 registerHooks 补 `.js`（与本仓其它测试同法）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchBrace, stripComments } from './helpers/etsSource.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const M = await import('../.build/model/instances.js');
const S = await import('../.build/model/instanceSeed.js');

const { LOCAL_INSTANCE_ID, normalizeInstance, encodeInstances, decodeInstances, redactInstance,
  redactUrl, applyReachability, sortInstances, instanceIdFromUrl, deriveCapabilities } = M;
const { seedInstances, reachabilityLabel, relativeLastSeen } = S;

const SECRET = 'LEGACY_SECRET_9f3a2b';
const RAW_LEGACY = `192.168.1.6:3080/?token=${SECRET}&a=1`;
const LAST_OK = JSON.stringify({ url: 'http://192.168.1.6:3080/?a=1', at: 1700000000000 });

// mod-shell-instances-pane（old→new）：正文锚点 `pages/Instances.ets` → 真 body 所在的
// `pages/panes/InstancesPane.ets`；顶层页只留一层 @Entry 路由壳。断言本身不删、不放宽，
// 只把「读哪个文件」跟着正文走；另增 ROUTE 断言钉住单一事实来源。
const PAGE = readFileSync(
  new URL('../../entry/src/main/ets/pages/panes/InstancesPane.ets', import.meta.url), 'utf8');
const ROUTE = readFileSync(new URL('../../entry/src/main/ets/pages/Instances.ets', import.meta.url), 'utf8');
const HOME = readFileSync(new URL('../../entry/src/main/ets/pages/Home.ets', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../../entry/src/main/ets/pages/Settings.ets', import.meta.url), 'utf8');
const STORE = readFileSync(new URL('../../entry/src/main/ets/services/instanceStore.ets', import.meta.url), 'utf8');
const MAIN_PAGES = JSON.parse(
  readFileSync(new URL('../../entry/src/main/resources/base/profile/main_pages.json', import.meta.url), 'utf8')
);
const HARMONY_PAGES = JSON.parse(
  readFileSync(new URL('../../entry/src/harmony/resources/base/profile/main_pages.json', import.meta.url), 'utf8')
);
const ETS_ROOT = fileURLToPath(new URL('../../entry/src/main/ets/', import.meta.url));

/** 全量 app 源码（.ets/.ts）：「占位串绝迹」断言的扫描集，避免只查一个文件漏掉别处残留。 */
function appSources(dir = ETS_ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      appSources(path, out);
    } else if (path.endsWith('.ets') || path.endsWith('.ts')) {
      out.push({ path, text: readFileSync(path, 'utf8') });
    }
  }
  return out;
}

/**
 * mod-instances-pane-readonly：同一个组件两种模式，静态守卫必须按「模式可见性」切源码，
 * 不能只做整文件 `includes` —— 配置代码仍留在组件里供设置路由使用。
 * `if (this.configurable) { … }` 块 = 只有配置模式可见；挖掉它们 = 首页只读模式可见。
 */
const CONFIG_GATE = 'if (this.configurable) {';

/** `FormPanel` builder 只在 `if (this.configurable) { this.FormPanel() }` 处被调用。 */
const CONFIG_BUILDER = '\n  FormPanel() {';

function blankBlock(source, markerAt) {
  const [start, end] = matchBrace(source, source.indexOf('{', markerAt));
  return source.slice(0, start) + ' '.repeat(end - start) + source.slice(end);
}

/** 所有配置专属区域：模式门控块 + 只在配置模式下被调用的 FormPanel builder。 */
function configBlocks(source) {
  const out = [];
  let at = source.indexOf(CONFIG_GATE);
  while (at >= 0) {
    const [start, end] = matchBrace(source, source.indexOf('{', at));
    out.push(source.slice(start + 1, end - 1));
    at = source.indexOf(CONFIG_GATE, end);
  }
  const builderAt = source.indexOf(CONFIG_BUILDER);
  if (builderAt >= 0) {
    const [start, end] = matchBrace(source, source.indexOf('{', builderAt));
    out.push(source.slice(start + 1, end - 1));
  }
  return out;
}

/** 首页只读模式可见源码：把配置专属区域替换成等长空白（保留偏移与行号）。 */
function readonlySource(source) {
  let result = source;
  let at = result.indexOf(CONFIG_GATE);
  while (at >= 0) {
    const [start, end] = matchBrace(result, result.indexOf('{', at));
    result = result.slice(0, start) + ' '.repeat(end - start) + result.slice(end);
    at = result.indexOf(CONFIG_GATE, end);
  }
  const builderAt = result.indexOf(CONFIG_BUILDER);
  if (builderAt >= 0) {
    result = blankBlock(result, builderAt);
  }
  return result;
}

function legacy(overrides = {}) {
  return { remoteUrl: RAW_LEGACY, remoteLastOk: LAST_OK, remoteMode: 'lan', ...overrides };
}

// ---------------------------------------------------------------- B: 播种 / 迁移

describe('播种与旧配置迁移', () => {
  test('S-01 空表播种：恰好一条本机行，id=local、URL 空、无 token', () => {
    const list = seedInstances([], { remoteUrl: '', remoteLastOk: '', remoteMode: '' });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, LOCAL_INSTANCE_ID);
    assert.equal(list[0].url, '');
    assert.equal(list[0].token, undefined);
    assert.equal(list[0].capabilities.webUI, false);
  });

  test('S-02 旧 remoteUrl 迁移：裸 host 补 http://、token 抽进 token 字段、url 无明文', () => {
    const list = seedInstances([], legacy());
    assert.equal(list.length, 2);
    assert.equal(list[0].id, LOCAL_INSTANCE_ID, '本机必须第一行');
    const remote = list[1];
    assert.match(remote.url, /^http:\/\//, 'schemeless 旧地址必须经 normalizeRemoteUrl 补协议');
    assert.equal(remote.url.includes(SECRET), false);
    assert.equal(remote.token, SECRET, 'token 只能进 token 字段');
    assert.equal(remote.mode, 'lan');
    assert.equal(remote.lastSeen, 1700000000000);
  });

  test('S-03 迁移幂等：同一份旧配置连续播种两次，信封字节相等、无第二条', () => {
    const once = seedInstances([], legacy());
    const twice = seedInstances(once, legacy());
    assert.equal(twice.length, once.length);
    assert.equal(encodeInstances(twice), encodeInstances(once));
    const thrice = seedInstances(twice, legacy());
    assert.equal(encodeInstances(thrice), encodeInstances(once));
  });

  test('S-04 迁移不覆盖用户后续编辑（名称 / 可达 / lastSeen 保留）', () => {
    const seeded = seedInstances([], legacy());
    const id = seeded[1].id;
    const edited = [seeded[0], {
      ...seeded[1], name: '我的电脑', reachable: 'ok', lastSeen: 1234, token: 'OWN'
    }];
    const again = seedInstances(edited, legacy());
    assert.equal(again.length, 2);
    assert.equal(again[1].name, '我的电脑');
    assert.equal(again[1].reachable, 'ok');
    assert.equal(again[1].lastSeen, 1234);
    assert.equal(again[1].token, 'OWN');
  });

  test('S-05 remoteUrl 为空时从 remoteLastOk 的 url/at 迁移', () => {
    const list = seedInstances([], legacy({ remoteUrl: '' }));
    assert.equal(list.length, 2);
    assert.equal(list[1].url, 'http://192.168.1.6:3080/?a=1');
    assert.equal(list[1].lastSeen, 1700000000000);
  });

  test('S-06 坏旧配置不添加远程行，也不抛错（ftp / 空串 / 坏 lastOk）', () => {
    for (const bad of [
      legacy({ remoteUrl: 'ftp://h/', remoteLastOk: '' }),
      legacy({ remoteUrl: '   ', remoteLastOk: '{not json' }),
      legacy({ remoteUrl: 'http://has space/', remoteLastOk: '' })
    ]) {
      const list = seedInstances([], bad);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, LOCAL_INSTANCE_ID);
    }
  });

  test('S-07 fragment 旧地址：落盘无 #token、id 与干净地址相等（P2-1 端到端）', () => {
    const frag = `http://h:3080/?k=${SECRET}#token=${SECRET}`;
    const list = seedInstances([], legacy({ remoteUrl: frag, remoteLastOk: '' }));
    assert.equal(list[1].url.includes('#'), false);
    assert.equal(list[1].url.includes(SECRET), false);
    assert.equal(list[1].token, SECRET);
    assert.equal(list[1].id, instanceIdFromUrl(`http://h:3080/?k=${SECRET}`));
  });

  test('S-08（mod-settings-remote-dedupe）旧 remoteToken 与地址分开存放也一并迁移，且幂等不丢', () => {
    const separate = 'SEPARATE_LEGACY_TOKEN';
    const input = { remoteUrl: 'http://h:3080/?a=1', remoteLastOk: '', remoteMode: 'manual', remoteToken: separate };
    const once = seedInstances([], input);
    assert.equal(once.length, 2, '本机行 + 一条迁移实例');
    assert.equal(once[1].token, separate, '分开存的旧令牌必须进 token 字段（不能只迁地址）');
    assert.equal(once[1].url.includes(separate), false, '令牌不得拼进可读 url');
    const twice = seedInstances(once, input);
    assert.equal(encodeInstances(twice), encodeInstances(once), '再播一次信封逐字节相等（幂等）');
    // 地址里已有令牌时，显式传入的旧 remoteToken 优先（normalizeInstance 的 token 优先级）
    const both = seedInstances([], { ...input, remoteUrl: `http://h:3080/?token=${SECRET}`, remoteToken: separate });
    assert.equal(both[1].token, separate, '显式旧令牌优先于 URL 里的旧令牌');
    assert.equal(both[1].url.includes(SECRET), false, 'URL 令牌也不得进可读 url');
  });

  test('S-08 旧 mode 非法 / 缺失回落 manual，不静默变成 lan', () => {
    const bad = seedInstances([], legacy({ remoteMode: 'wifi' }));
    const missing = seedInstances([], legacy({ remoteMode: undefined }));
    assert.equal(bad[1].mode, 'manual');
    assert.equal(missing[1].mode, 'manual');
  });
});

// ---------------------------------------------------------------- C: 列表展示纯逻辑

describe('列表展示纯逻辑', () => {
  test('L-01 redacted 行文本永不出现 token（含 query / fragment / 大写键）', () => {
    const inst = normalizeInstance({
      id: instanceIdFromUrl('http://h/'), name: 'pc-b', url: `http://h/?token=${SECRET}`,
      mode: 'lan', token: SECRET, lastSeen: 999, reachable: 'ok',
      capabilities: deriveCapabilities('inst-0123456789abcdef')
    }).instance;
    const view = redactInstance(inst);
    assert.equal(Object.prototype.hasOwnProperty.call(view, 'token'), false);
    assert.equal(JSON.stringify(view).includes(SECRET), false);
    assert.equal(view.url.includes(SECRET), false);
    for (const raw of [`http://h/?token=${SECRET}`, `http://h/?TOKEN=${SECRET}`, `http://h/#token=${SECRET}`]) {
      const masked = redactUrl(raw);
      assert.equal(masked.includes(SECRET), false);
      assert.match(masked, /token=\*\*\*/i);
    }
  });

  test('L-02 列表顺序：本机第一，其余按 name 再按 id（排序不改入参）', () => {
    const local = seedInstances([], { remoteUrl: '', remoteLastOk: '', remoteMode: '' })[0];
    const mk = (id, name) => normalizeInstance({
      id, name, url: `http://${id.slice(5, 11)}.example/`, mode: 'lan'
    }).instance;
    const a = mk('inst-0123456789abcdef', 'a-电脑');
    const z = mk('inst-fedcba9876543210', 'z-电脑');
    const input = [z, local, a];
    const ordered = sortInstances(input).map((x) => redactInstance(x).name);
    assert.deepEqual(ordered, [local.name, 'a-电脑', 'z-电脑']);
    assert.equal(input[0].id, z.id);
  });

  test('L-03 可达标记：ok 推进 lastSeen、fail 保留、坏 nowMs 不改时间', () => {
    const inst = normalizeInstance({
      id: instanceIdFromUrl('http://h/'), name: 'pc-b', url: 'http://h/',
      mode: 'lan', reachable: 'fail', lastSeen: 1000
    }).instance;
    const ok = applyReachability([inst], inst.id, 'ok', 2000);
    assert.equal(ok[0].reachable, 'ok');
    assert.equal(ok[0].lastSeen, 2000);
    const fail = applyReachability(ok, inst.id, 'fail', 3000);
    assert.equal(fail[0].reachable, 'fail');
    assert.equal(fail[0].lastSeen, 2000);
    const bad = applyReachability(fail, inst.id, 'ok', NaN);
    assert.equal(bad[0].lastSeen, 2000);
  });

  test('L-04 相对 lastSeen：四档 + 暂无记录 + 时钟回拨', () => {
    const now = 1700000000000;
    assert.equal(relativeLastSeen(undefined, now), '暂无记录');
    assert.equal(relativeLastSeen(-1, now), '暂无记录');
    assert.equal(relativeLastSeen(now + 10, now), '暂无记录', '时钟回拨不给负数');
    assert.equal(relativeLastSeen(now - 1000, now), '刚刚');
    assert.equal(relativeLastSeen(now - 90 * 1000, now), '1 分钟前');
    assert.equal(relativeLastSeen(now - 2 * 3600 * 1000, now), '2 小时前');
    assert.equal(relativeLastSeen(now - 3 * 86400 * 1000, now), '3 天前');
  });

  test('L-05 可达三态文案：unknown 永不显示成「可达」', () => {
    assert.equal(reachabilityLabel('ok'), '可达');
    assert.equal(reachabilityLabel('fail'), '不可达');
    assert.equal(reachabilityLabel('unknown'), '未知');
    assert.equal(reachabilityLabel(undefined), '未知');
    assert.equal(reachabilityLabel('weird'), '未知');
  });

  test('L-06 坏信封解码后仍是空表 + typed problem，UI 才有错误行可渲染', () => {
    const result = decodeInstances('{not json');
    assert.equal(result.ok, false);
    assert.equal(result.problem, 'E_ENVELOPE_JSON');
    assert.deepEqual(result.items, []);
    assert.ok(M.problemText(result.problem).length > 0);
  });
});

// ---------------------------------------------------------------- C: 静态 UI / 接线断言

describe('静态断言：页面、入口与存储接线', () => {
  test('U-01 新页面存在且登记进两份 main_pages.json', () => {
    assert.ok(MAIN_PAGES.src.includes('pages/Instances'));
    assert.ok(HARMONY_PAGES.src.includes('pages/Instances'));
  });

  // mod-instances-pane-readonly（old→new，不比原来弱）：原来只有一套空态「添加实例」；
  // 现在可配置模式沿用逐字四段，只读模式另有「去设置添加实例」，标题/指引/次操作仍逐字共用。
  test('U-02 空态文案逐字符合 §1，两种模式各有自己的主操作', () => {
    assert.match(PAGE, /还没有可管理的 DSH 实例/);
    assert.match(PAGE, /在电脑 DSH → 远程访问 → 启动并点「显示二维码与链接」，把地址粘进来；本机（默认）实例会自动出现/);
    assert.match(PAGE, /const EMPTY_ACTION: string = '添加实例'/);
    assert.match(PAGE, /const EMPTY_ACTION_READONLY: string = '去设置添加实例'/);
    assert.match(PAGE, /const EMPTY_SECONDARY: string = '用浏览器打开'/);
  });

  test('U-03 行内 URL 只走 redactUrl()/redacted()，绝不直接渲染实例 url', () => {
    assert.match(PAGE, /instanceStore\.redacted\(\)/, '必须消费 store 的打码视图');
    assert.match(PAGE, /Text\(redactUrl\(view\.url\)\)/, 'URL 必须再过 redactUrl()');
    assert.doesNotMatch(PAGE, /Text\(full\.url\)/, '真身 url 不能进 Text');
    assert.equal(PAGE.includes(SECRET), false);
  });

  // mod-instances-pane-readonly（old→new，收紧）：旧断言在整文件里找「编辑 / 删除」，
  // 现在这些只属于 configurable=true 的配置模式；改在配置块内逐条断言，README 首页侧另在
  // U-18 做「绝迹」断言，两边合起来比旧的整文件 includes 更强。
  test('U-04 配置模式守卫：本机无删除、编辑不显示 URL 输入框', () => {
    const config = configBlocks(PAGE).join('\n');
    assert.ok(config.length > 0, '必须存在配置专属块');
    assert.match(config, /view\.id !== LOCAL_INSTANCE_ID/, '删除按钮必须排除本机');
    assert.match(config, /this\.formId !== LOCAL_INSTANCE_ID/, 'URL / 方式输入框必须排除本机');
    assert.match(config, /label: '删除'/, '配置模式的远程行必须有删除动作');
    assert.match(config, /label: '编辑'/, '配置模式的每行必须有编辑动作');
  });

  test('U-05 打开复用内嵌 Web 并记可达：routeToRemote + mergeRemoteToken + markReachable(ok|fail, Date.now())', () => {
    assert.match(PAGE, /routeToRemote\(\)/);
    assert.match(PAGE, /mergeRemoteToken\(full\.url, token\)/);
    assert.match(PAGE, /markReachable\(view\.id, 'ok', Date\.now\(\)\)/);
    assert.match(PAGE, /markReachable\(view\.id, 'fail', Date\.now\(\)\)/);
  });

  // mod-instances-pane-readonly（old→new，收紧）：typed 原因两种模式都渲染；
  // 「重新添加」只在配置模式，只读模式换成导航到设置的「去设置添加实例」。
  test('U-06 问题行：problemText() 常在，恢复动作按模式分叉', () => {
    assert.match(PAGE, /this\.problem !== 'ok'/);
    assert.match(PAGE, /problemText\(this\.problem\)/);
    const config = configBlocks(PAGE).join('\n');
    const readonly = readonlySource(PAGE);
    assert.match(config, /label: '重新添加'/, '配置模式就地重开添加表单');
    assert.match(readonly, /label: '去设置添加实例'/, '只读模式只给导航出口');
    assert.match(readonly, /this\.openInstanceConfig\(\)/, '只读恢复动作走统一配置出口');
  });

  // mod-settings-root（old→new，不比原来弱）：旧入口是长滚动里的一行「远程实例与云端对话 ›」；
  // 现在是四行菜单中的「远程实例」行，摘要从实例数派生，仍指向同一个 pages/Instances 路由。
  test('U-07 设置入口升级为四行菜单的「远程实例」行且指向 pages/Instances', () => {
    assert.match(SETTINGS, /ROUTE_INSTANCES: string = 'pages\/Instances'/);
    assert.match(SETTINGS, /this\.MenuRow\('远程实例', this\.instanceSummary, ROUTE_INSTANCES\)/);
    assert.match(SETTINGS, /instanceStore\.list\(\)\.length/, '摘要必须是真实实例数');
    assert.equal(SETTINGS.includes("router.pushUrl({ url: 'pages/Chats' })"), false, '旧入口不得残留');
    assert.equal(SETTINGS.includes('远程实例与云端对话'), false, '旧入口文案已从根页移除');
  });

  test('U-08 store 的 ensureSeeded 幂等接线（比较信封、无变化不写盘）', () => {
    assert.match(STORE, /seedInstances\(before, legacy\)/);
    assert.match(STORE, /encodeInstances\(seeded\) === encodeInstances\(sortInstances\(before\)\)/);
    assert.match(STORE, /ensureSeeded\(legacy: LegacyInstanceSettings\)/);
  });

  test('U-09 迁移传的是 normalizeRemoteUrl(...).url，不是原始 raw 字符串', () => {
    const SEED = readFileSync(new URL('../../entry/src/main/ets/model/instanceSeed.ts', import.meta.url), 'utf8');
    assert.match(SEED, /const check = normalizeRemoteUrl\(raw\)/);
    assert.match(SEED, /instanceIdFromUrl\(check\.url\)/);
    assert.match(SEED, /url: check\.url/);
    assert.doesNotMatch(SEED, /url: raw/);
  });

  // mod-instances-pane-readonly（old→new，收紧）：旧断言要求三动作都在；现在「打开」
  // 是两种模式共用的使用动作，「编辑 / 删除」只属于配置模式，分别钉住。
  test('U-10 打开常在两种模式；编辑 / 删除只在配置模式', () => {
    const readonly = readonlySource(PAGE);
    const config = configBlocks(PAGE).join('\n');
    assert.match(readonly, /label: '打开'/, '首页面板必须有打开动作');
    assert.match(config, /label: '编辑'/);
    assert.match(config, /label: '删除'/);
    assert.equal(/label: '编辑'|label: '删除'/.test(readonly), false, '首页面板不得有编辑 / 删除');
    assert.match(PAGE, /EMPTY_TITLE: string = '还没有可管理的 DSH 实例'/);
  });

  test('U-11 设置入口升级后仍可从实例面板桥接回原云端对话列表', () => {
    assert.match(PAGE, /router\.pushUrl\(\{ url: 'pages\/Chats' \}\)/);
    // old: PageLayout.headerActionTwo:'云端对话' → new: 面板页头的 Text('云端对话') 出口。
    assert.match(PAGE, /Text\('云端对话'\)/);
  });

  test('U-12 令牌出口边界：Want.uri 只能来自 stripRemoteToken() 后的地址', async () => {
    // 带 token 的原始 settings 值绝不直接进 Want / startAbility / 日志。
    // old: '../model/remoteUrl' → new: '../../model/remoteUrl'（文件下沉到 pages/panes/）。
    assert.match(PAGE, /import \{[^}]*\bstripRemoteToken\b[^}]*\} from '\.\.\/\.\.\/model\/remoteUrl'/,
      '必须 import 已有的去令牌纯函数');
    const browser = PAGE.slice(PAGE.indexOf('private async openInBrowser()'), PAGE.indexOf('// ------------------------------------------------------------------ 渲染'));
    assert.ok(browser.length > 0, 'openInBrowser 段必须存在');
    assert.match(browser, /const raw: string = cached === null \? '' : cached\.remoteUrl\.trim\(\)/,
      '原始 remoteUrl 先落到 raw 局部变量');
    assert.match(browser, /const url: string = stripRemoteToken\(raw\)/,
      'Want.uri 只能取 stripRemoteToken(raw) 的结果');
    assert.match(browser, /uri: url \}/, 'Want 的 uri 只能是去令牌后的 url');
    assert.equal(/uri: raw/.test(browser), false, '原始带令牌地址不得进 Want');
    assert.equal(/uri: cached\.remoteUrl/.test(browser), false, 'settings 原值不得进 Want');
    assert.doesNotMatch(browser, /(console|hilog|logger)\./, '兜底路径不得打日志（令牌不外泄）');
    // 纯函数侧：?token= 与 ?k= 整对删掉，无令牌原串逐字不变（与出口静态断言互补）。
    const REMOTE = readFileSync(new URL('../../entry/src/main/ets/model/remoteUrl.ts', import.meta.url), 'utf8');
    assert.match(REMOTE, /export function stripRemoteToken\(url: string\): string/);
    const U = await import('../.build/model/remoteUrl.js');
    assert.equal(U.stripRemoteToken(`http://h:3080/?token=${SECRET}&a=1`), 'http://h:3080/?a=1');
    assert.equal(U.stripRemoteToken(`http://h:3080/?k=${SECRET}`), 'http://h:3080/');
    assert.equal(U.stripRemoteToken('http://h:3080/?a=1'), 'http://h:3080/?a=1');
  });

  // mod-instances-pane-readonly（old→new，收紧）：路由壳是设置里的配置落点，必须显式
  // 传 configurable: true；旧断言只钉装配，不区分模式。
  test('U-13 单一事实来源：顶层页只装配 InstancesPane 并打开配置模式', () => {
    assert.match(ROUTE, /import \{ InstancesPane \} from '\.\/panes\/InstancesPane'/);
    assert.match(ROUTE, /InstancesPane\(\{\s*deepLinkId: '', active: true, configurable: true \}\)/);
    // 路由壳不得自己持有实例正文状态 / 动作（否则双份播种、双份渲染）。
    for (const body of ['instanceStore.', 'settingsStore.', 'EMPTY_TITLE', 'InstanceRow(', 'ForEach(']) {
      assert.equal(ROUTE.includes(body), false, `路由壳不得复制正文：${body}`);
    }
    assert.ok(PAGE.includes('export struct InstancesPane'), '真 body 必须在面板里');
  });

  // mod-instances-pane-readonly（old→new，收紧）：把「三动作都在」改成模式分叉断言。
  test('U-14 面板渲染本机首行 + 远程行 + 打开；配置动作只在配置模式', () => {
    assert.match(PAGE, /ForEach\(\s*this\.views,\s*\(view: RedactedInstance\)/, '渲染真实实例视图');
    assert.match(PAGE, /this\.InstanceRow\(view\)/, '每行装配 InstanceRow');
    assert.match(PAGE, /ensureSeeded\(\{/, '面板仍负责首次播种（本机首行）');
    const readonly = readonlySource(PAGE);
    const config = configBlocks(PAGE).join('\n');
    assert.match(readonly, /label: '打开'/, '使用动作在首页面板常驻');
    assert.match(config, /view\.id !== LOCAL_INSTANCE_ID/, '删除只对远程行渲染');
    assert.match(config, /label: '编辑'/);
    assert.match(config, /label: '删除'/);
    // 本机排序第一由 L-02 的纯逻辑钉住；面板消费 store 的 sortInstances 后副本。
    assert.match(STORE, /redacted\(\): RedactedInstance\[\]/, '渲染视图来自 store 的排序副本');
  });

  // mod-instances-pane-readonly（old→new，收紧）：页头主操作按模式分叉，保活 / Scroll 不变。
  test('U-15 面板页头 + 自带 Scroll + 保活接线；添加实例只在配置模式', () => {
    assert.match(PAGE, /Text\('远程 DSH'\)/, '分段标题');
    assert.match(configBlocks(PAGE).join('\n'), /Text\('添加实例'\)/, '配置模式主操作');
    assert.match(readonlySource(PAGE), /Text\('云端对话'\)/, '只读页头保留桥接出口');
    assert.equal(/Text\('添加实例'\)/.test(readonlySource(PAGE)), false,
      '首页面板不得展示添加实例');
    assert.match(PAGE, /^\s*Scroll\(\) \{/m, '面板自带 Scroll');
    assert.match(PAGE, /\.visibility\(this\.active \? Visibility\.Visible : Visibility\.Hidden\)/);
    assert.equal(/PageLayout\(/.test(PAGE), false, '面板不得再套固定页头 + 内容双层壳');
  });

  test('U-16 占位串绝迹：远程面板即将迁入 / 逐字说明不在任何 app 源码里', () => {
    const stale = ['远程面板即将迁入', '实例列表与连接操作即将迁入，本页暂不展示任何记录。'];
    const sources = appSources();
    assert.ok(sources.length > 0, '必须扫描到 app 源码');
    for (const { path, text } of sources) {
      for (const needle of stale) {
        assert.equal(text.includes(needle), false, `${path} 残留占位串「${needle}」`);
      }
    }
  });

  // ------------------------------------------------ mod-instances-pane-readonly（正向守卫）

  test('U-17 单一 prop 两种调用点：默认 false 的 Home 分段 + 显式 true 的设置路由', () => {
    assert.match(PAGE, /@Prop configurable: boolean = false;/, 'prop 必须存在且默认 false');
    const homeCall = HOME.slice(HOME.indexOf('InstancesPane({'), HOME.indexOf('CloudChatPane({'));
    assert.ok(homeCall.length > 0, 'Home 装配点必须存在');
    assert.equal(/configurable/.test(homeCall), false, 'Home 分段不得打开配置模式（默认只读）');
    assert.match(ROUTE, /configurable: true/, '设置路由必须显式打开配置模式');
    assert.equal(configBlocks(PAGE).length >= 4, true, '页头 / 空态 / 问题行 / 行内 / 表单都按模式分叉');
  });

  test('U-18 首页面板（只读模式可见源码）没有配置入口，也没有地址 / 令牌 / 方式输入', () => {
    const readonly = readonlySource(PAGE);
    for (const needle of [
      'label: \'添加实例\'', 'label: \'编辑\'', 'label: \'删除\'', 'label: \'保存\'', 'label: \'取消\'',
      'Text(\'添加实例\')', 'label: \'重新添加\'', 'TextInput(', 'Select(', 'this.showAdd()',
      'this.showEdit(', 'this.submitForm()', 'this.FormPanel()', 'this.deleteInstance('
    ]) {
      assert.equal(readonly.includes(needle), false, `只读面板不得出现配置入口「${needle}」`);
    }
    // 展示面保留：本机首行 / 状态 / 打码 URL / 打开 / 播种。
    for (const keep of [
      'instanceStore.ensureSeeded(', 'instanceStore.redacted()', 'ForEach(this.views',
      'Text(redactUrl(view.url))', 'label: \'打开\'', 'reachabilityLabel(view.reachable)'
    ]) {
      assert.ok(readonly.includes(keep), `只读面板必须保留「${keep}」`);
    }
  });

  test('U-19 设置路由模式保留全部配置能力（添加 / 编辑 / 删除 / 地址·令牌·方式表单）', () => {
    const config = configBlocks(PAGE).join('\n');
    for (const needle of [
      'Text(\'添加实例\')', 'label: \'编辑\'', 'label: \'删除\'', 'label: \'重新添加\'',
      'TextInput({ text: this.formUrl', 'Select(this.modeSelectOptions())',
      'this.showAdd()', 'this.showEdit(view)', 'this.submitForm()', 'this.FormPanel()',
      'this.deleteInstance(view)'
    ]) {
      assert.ok(config.includes(needle), `配置模式必须保留「${needle}」`);
    }
    assert.match(config, /EMPTY_ACTION/, '配置模式空态主操作仍是「添加实例」');
  });

  test('U-20 空态分叉：只读跳设置 → 远程实例路由；配置模式就地添加', () => {
    assert.match(PAGE, /const ROUTE_INSTANCES: string = 'pages\/Instances'/,
      '配置唯一落点常量必须与设置根页的路由一致');
    const method = PAGE.slice(PAGE.indexOf('private openInstanceConfig()'), PAGE.indexOf('private showAdd()'));
    assert.ok(method.length > 0, '统一配置出口方法必须存在');
    assert.match(method, /router\.pushUrl\(\{ url: ROUTE_INSTANCES \}\)/, '只读模式的配置动作必须跳设置实例路由');
    assert.equal(/pushUrl\(\{ url: 'pages\/Settings'/.test(PAGE), false,
      '不新增第二处 Settings push（唯一出口仍是 Home 齿轮）');
    const readonly = readonlySource(PAGE);
    const config = configBlocks(PAGE).join('\n');
    assert.match(readonly, /actionLabel: EMPTY_ACTION_READONLY/, '只读空态主操作是「去设置添加实例」');
    assert.match(readonly, /this\.openInstanceConfig\(\)/, '只读空态主操作走统一出口');
    assert.match(config, /actionLabel: EMPTY_ACTION\b/, '配置模式空态主操作仍是「添加实例」');
    assert.match(config, /this\.showAdd\(\)/, '配置模式空态就地打开表单');
  });

  test('U-21 「打开」在两种模式都存在，且仍复用内嵌 Web + 记可达', () => {
    const readonly = readonlySource(PAGE);
    const config = configBlocks(PAGE).join('\n');
    assert.equal(readonly.includes('label: \'打开\''), true, '只读模式必须能打开实例');
    assert.equal(config.includes('label: \'打开\''), false, '打开不在配置专属块里：两种模式共用同一行');
    assert.match(PAGE, /this\.openInstance\(view\)/, '行内打开动作接线');
    assert.match(PAGE, /this\.InstanceRow\(view\)/, '两种模式都装配同一实例行');
  });
});
