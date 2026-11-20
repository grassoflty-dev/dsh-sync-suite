// `mod-instance-list`：播种 / 旧配置迁移 / 列表展示纯逻辑 + 页面与入口静态断言。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型 `model/instanceSeed.ts` 有相对 import，编译产物是省略扩展名的 ES import，
// 故用 registerHooks 补 `.js`（与本仓其它测试同法）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

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

const PAGE = readFileSync(new URL('../../entry/src/main/ets/pages/Instances.ets', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../../entry/src/main/ets/pages/Settings.ets', import.meta.url), 'utf8');
const STORE = readFileSync(new URL('../../entry/src/main/ets/services/instanceStore.ets', import.meta.url), 'utf8');
const MAIN_PAGES = JSON.parse(
  readFileSync(new URL('../../entry/src/main/resources/base/profile/main_pages.json', import.meta.url), 'utf8')
);
const HARMONY_PAGES = JSON.parse(
  readFileSync(new URL('../../entry/src/harmony/resources/base/profile/main_pages.json', import.meta.url), 'utf8')
);

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

  test('U-02 空态四段文案逐字符合 §1', () => {
    assert.match(PAGE, /还没有可管理的 DSH 实例/);
    assert.match(PAGE, /在电脑 DSH → 远程访问 → 启动并点「显示二维码与链接」，把地址粘进来；本机（默认）实例会自动出现/);
    assert.match(PAGE, /const EMPTY_ACTION: string = '添加实例'/);
    assert.match(PAGE, /const EMPTY_SECONDARY: string = '用浏览器打开'/);
  });

  test('U-03 行内 URL 只走 redactUrl()/redacted()，绝不直接渲染实例 url', () => {
    assert.match(PAGE, /instanceStore\.redacted\(\)/, '必须消费 store 的打码视图');
    assert.match(PAGE, /Text\(redactUrl\(view\.url\)\)/, 'URL 必须再过 redactUrl()');
    assert.doesNotMatch(PAGE, /Text\(full\.url\)/, '真身 url 不能进 Text');
    assert.equal(PAGE.includes(SECRET), false);
  });

  test('U-04 本机守卫：无删除按钮、编辑不显示 URL 输入框', () => {
    assert.match(PAGE, /view\.id !== LOCAL_INSTANCE_ID/, '删除按钮必须排除本机');
    assert.match(PAGE, /this\.formId !== LOCAL_INSTANCE_ID/, 'URL / 方式输入框必须排除本机');
    assert.match(PAGE, /label: '删除'/, '远程行必须有删除动作');
    assert.match(PAGE, /label: '编辑'/, '每行必须有编辑动作');
  });

  test('U-05 打开复用内嵌 Web 并记可达：routeToRemote + mergeRemoteToken + markReachable(ok|fail, Date.now())', () => {
    assert.match(PAGE, /routeToRemote\(\)/);
    assert.match(PAGE, /mergeRemoteToken\(full\.url, token\)/);
    assert.match(PAGE, /markReachable\(view\.id, 'ok', Date\.now\(\)\)/);
    assert.match(PAGE, /markReachable\(view\.id, 'fail', Date\.now\(\)\)/);
  });

  test('U-06 问题行：problemText() + 「重新添加」', () => {
    assert.match(PAGE, /this\.problem !== 'ok'/);
    assert.match(PAGE, /problemText\(this\.problem\)/);
    assert.match(PAGE, /label: '重新添加'/);
  });

  test('U-07 设置入口升级为「远程实例与云端对话 ›」且指向 pages/Instances', () => {
    assert.match(SETTINGS, /Text\('远程实例与云端对话'\)/);
    assert.match(SETTINGS, /router\.pushUrl\(\{ url: 'pages\/Instances' \}\)/);
    assert.equal(SETTINGS.includes("router.pushUrl({ url: 'pages/Chats' })"), false, '旧入口不得残留');
    assert.match(SETTINGS, /this\.ChatEntryRow\(\)/);
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

  test('U-10 菜单动作齐全且本机不可删：打开 / 编辑 / 删除三个 label', () => {
    for (const label of ['打开', '编辑', '删除']) {
      assert.match(PAGE, new RegExp(`label: '${label}'`));
    }
    assert.match(PAGE, /EMPTY_TITLE: string = '还没有可管理的 DSH 实例'/);
  });

  test('U-11 设置入口升级后仍可从实例页桥接回原云端对话列表', () => {
    assert.match(PAGE, /router\.pushUrl\(\{ url: 'pages\/Chats' \}\)/);
    assert.match(PAGE, /headerActionTwo: '云端对话'/);
  });

  test('U-12 令牌出口边界：Want.uri 只能来自 stripRemoteToken() 后的地址', async () => {
    // 带 token 的原始 settings 值绝不直接进 Want / startAbility / 日志。
    assert.match(PAGE, /import \{[^}]*\bstripRemoteToken\b[^}]*\} from '\.\.\/model\/remoteUrl'/,
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
});
