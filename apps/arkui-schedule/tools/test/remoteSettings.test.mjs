// mod-settings-remote-dedupe：「远程控制配置 / 远程实例 / 云端对话」三处重复收敛到实例页后的守卫。
//
// 旧版这里钉住设置页远程组（访问方式下拉 / DSH 地址 / 令牌框 / 一键重连 / 提示行）的逐字文案与
// 「归一 → 落盘 → 跳转」顺序。用户反馈配置重复后，整组删除、RemoteSection.ets 文件删除，
// 设置页只保留一行打开 pages/Instances 的入口。断言已 retarget（不是删除、不是放宽）：
// ① 旧字段确实消失；② 唯一入口仍在；③ 旧 settingsStore 键值仍可读；
// ④ 旧值经 normalizeRemoteUrl(raw).url → normalizeInstance 幂等迁移进实例表且令牌不丢。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { readSettingsFile, readSettingsPage, readSettingsRoot, readSettingsSources, readSyncPage, readSyncSection } from './settingsSources.mjs';
import { stripComments } from './helpers/etsSource.mjs';

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

// mod-settings-root（old→new）：远程入口行随实现搬到组件宿主，断言不变、只换锚点。
const PAGE = readSettingsPage();
const SOURCES = readSettingsSources();
const STORE = readSettingsFile('services/settingsStore.ets');
const SEED = readSettingsFile('model/instanceSeed.ts');
// mod-shell-instances-pane（old→new）：实例正文锚点 pages/Instances.ets → pages/panes/InstancesPane.ets。
const INSTANCES = readSettingsFile('pages/panes/InstancesPane.ets');
const SECTION_DIR = 'components/settings/RemoteSection.ets';

const BUILT_SEED = fileURLToPath(new URL('../.build/model/instanceSeed.js', import.meta.url));
const BUILT_URL = fileURLToPath(new URL('../.build/model/remoteUrl.js', import.meta.url));
const BUILT_HINT = 'model 尚未编译到 tools/.build（先跑 tsc，再跑本测试）';

function bodyOf(source, marker, endMarker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到 ${marker}`);
  const end = source.indexOf(endMarker, start + marker.length);
  assert.ok(end > start, `找不到结束标记 ${endMarker}`);
  return source.slice(start, end);
}

describe('mod-settings-remote-dedupe：设置页不再重复配置，只留唯一入口', () => {
  test('RemoteSection.ets 已删除，设置页不再渲染访问方式/地址/令牌/重连/提示', () => {
    let exists = true;
    try {
      readSettingsFile(SECTION_DIR);
    } catch {
      exists = false;
    }
    assert.equal(exists, false, 'RemoteSection.ets 必须删除（配置只在实例页）');
    for (const gone of [
      /RemoteSection\(/, /访问方式/, /DSH 地址/, /打开远程控制/, /一键重连/, /清除令牌/,
      /remoteUrlError/, /remoteMode/, /remoteToken/, /remoteManualUrl/, /remoteLanAddress/,
      /remoteModeHint/, /remoteTokenHint/, /remoteTokenStatus/, /onOpenRemote/, /onReconnect/,
      /routeToRemote/, /normalizeRemoteUrl/, /reconnectLabel/, /decodeLastOk/
    ]) {
      assert.equal(gone.test(PAGE), false, `设置页残留远程配置字段/提示：${gone}`);
    }
  });

  test('唯一入口（old→new，收紧）：根页「远程实例」行指向 pages/Instances，旧入口行已删除', () => {
    // mod-settings-instances-entry-dedupe：旧入口是本宿主里的 ChatEntryRow → openInstances
    // → push('pages/Instances')，与四行菜单根页的「远程实例」行重复。旧断言钉「旧行存在」，
    // 现在正向钉「唯一的新行 + 旧行绝迹」——不是删断言、也不是只查 absence。
    const root = readSettingsRoot();
    assert.match(root, /const ROUTE_INSTANCES: string = 'pages\/Instances'/, '唯一入口的路由常量');
    assert.match(root, /this\.MenuRow\('远程实例', this\.instanceSummary, ROUTE_INSTANCES\)/, '四行菜单的「远程实例」行');
    assert.equal((root.match(/'pages\/Instances'/g) ?? []).length, 1, '根页只有一处 Instances 路由');
    for (const gone of [/ChatEntryRow\(/, /openInstances\(/, /RemoteGroup\(/, /远程实例与云端对话/]) {
      assert.equal(gone.test(PAGE), false, `实现宿主残留旧入口：${gone}`);
    }
    assert.equal(SOURCES.includes('远程实例与云端对话'), false, '设置树里旧入口文案绝迹');
  });

  test('旧入口装配绝迹：历史骨架不再渲染远程组与「远程」锚点（old→new）', () => {
    // 旧断言「远程入口组仍排在关于之前」随入口删除而失效；改为钉住旧装配确实从两套历史骨架
    // 里清掉，避免只删 builder、留下指向已删 builder 的死调用或永远 toast 的死锚点。
    for (const [name, body] of [
      ['compact', bodyOf(PAGE, 'CompactBody() {', 'WideBody() {')],
      ['wide', bodyOf(PAGE, 'WideBody() {', '// ------------------------------------------------------------------ 弹层')]
    ]) {
      assert.equal(/this\.RemoteGroup\(\)/.test(body), false, `${name} 仍装配已删的远程入口组`);
      assert.equal(/measureGroup\(2,/.test(body), false, `${name} 仍测量已删的远程组锚点`);
    }
    const anchors = bodyOf(PAGE, 'GroupAnchorBar() {', '// ------------------------------------------------------------------ 装配');
    assert.equal(/GroupAnchorChip\('远程'/.test(anchors), false, '「远程」锚点 chip 已随入口一起删除');
  });

  test('旧值仍可读：settingsStore 的 remoteUrl / remoteToken / remoteLastOk 三键未删', () => {
    for (const [field, key] of [
      ['remoteUrl', 'KEY_REMOTE_URL'], ['remoteToken', 'KEY_REMOTE_TOKEN'], ['remoteLastOk', 'KEY_REMOTE_LAST_OK']
    ]) {
      assert.match(STORE, new RegExp(`${field}: string;`), `ScheduleSettings 仍可读 ${field}`);
      assert.match(STORE, new RegExp(`const ${key}: string = '${field}';`), `键常量 ${key} 仍在`);
      assert.match(STORE, new RegExp(`prefs\\.get\\(${key}`), `load 仍读 ${field}`);
      assert.match(STORE, new RegExp(`prefs\\.put\\(${key}`), `save 仍写 ${field}`);
    }
    assert.match(INSTANCES, /settingsStore\.cached\(\)/, '实例页「用浏览器打开」仍可读旧地址');
    assert.match(INSTANCES, /cached\.remoteUrl/, '旧 remoteUrl 仍被实例页读取（可读但不再重复配置）');
  });

  test('实例页把旧 URL / lastOk / mode / token 一起交给幂等播种', () => {
    const bootstrap = bodyOf(INSTANCES, 'private async bootstrap()', '/** 内存镜像');
    for (const field of ['remoteUrl', 'remoteLastOk', 'remoteMode', 'remoteToken']) {
      assert.match(bootstrap, new RegExp(`${field}: settings\\.${field}`), `播种必须带上旧 ${field}`);
    }
    assert.match(SEED, /remoteToken\?: string/, 'LegacyInstanceSettings 声明旧令牌');
    assert.match(SEED, /candidate\.token = legacyToken/, '旧令牌写进实例行的 token 字段');
  });
});

describe('mod-settings-remote-dedupe：迁移幂等、令牌不丢（纯函数）', () => {
  test(
    '旧 URL + 独立令牌 → 一条实例，令牌进 token 字段、URL 不含明文；再播一次不产生第二条',
    { skip: existsSync(BUILT_SEED) ? false : BUILT_HINT },
    async () => {
      const { seedInstances } = await import(pathToFileURL(BUILT_SEED).href);
      const legacy = {
        remoteUrl: '192.168.1.6:3080/?a=1',
        remoteLastOk: JSON.stringify({ url: 'http://192.168.1.6:3080/?a=1', at: 1700000000000 }),
        remoteMode: 'manual',
        remoteToken: 'LEGACY_SECRET_9f3a2b'
      };
      // mod-instances-drop-local：平板不跑原生 DSH，实例全是远程，播种不再补本机行。
      // 旧断言「2 = 本机行 + 迁移实例」收紧为「1 条远程实例且零 local 行」。
      const first = seedInstances([], legacy);
      assert.equal(first.length, 1, '只有一条迁移实例，没有本机行');
      assert.equal(first.filter((item) => item.id === 'local').length, 0, '绝不播种本机行');
      const remote = first.find((item) => item.id !== 'local');
      assert.ok(remote !== undefined, '旧地址必须落成远程实例');
      assert.equal(remote.url, 'http://192.168.1.6:3080/?a=1', 'normalizeRemoteUrl 补 http://');
      assert.equal(remote.url.includes('LEGACY_SECRET'), false, 'url 不得含明文令牌');
      assert.equal(remote.token, 'LEGACY_SECRET_9f3a2b', '独立存放的旧令牌必须迁进 token 字段');
      assert.equal(remote.lastSeen, 1700000000000, '最近成功时间也要迁');
      const second = seedInstances(first, legacy);
      assert.equal(second.length, first.length, '幂等：第二次启动不多出实例');
      assert.equal(second.find((item) => item.id === remote.id).token, remote.token, '不覆盖已迁好的令牌');
    }
  );

  // mod-sync-silent-autoinit：设置面同步文案的新 truth —— 仓库事实只在诊断区，
  // 用户不会看到「尚未初始化 / 首次克隆 / 先执行拉取」这种要先手动做事的死结。
  test('同步面用户可见文案没有初始化死结，仓库事实有诊断区标注', () => {
    const sync = stripComments(readSyncPage()) + '\n' + stripComments(readSyncSection());
    for (const banned of [/尚未初始化/, /首次克隆/, /先执行「拉取」/, /先拉取克隆仓库/]) {
      assert.equal(banned.test(sync), false, `同步面残留死结文案：${banned}`);
    }
    assert.ok(sync.includes('诊断（仅排查用）'), '同步面必须把仓库事实标成诊断');
  });

  test(
    'normalizeRemoteUrl：裸 host 补 http:// 且识别 query 令牌（迁移前置不变量）',
    { skip: existsSync(BUILT_URL) ? false : BUILT_HINT },
    async () => {
      const { normalizeRemoteUrl } = await import(pathToFileURL(BUILT_URL).href);
      const check = normalizeRemoteUrl('192.168.1.6:3080/?token=abc');
      assert.equal(check.ok, true);
      assert.equal(check.url, 'http://192.168.1.6:3080/?token=abc');
      assert.equal(check.hasToken, true);
      assert.equal(check.hadScheme, false);
      assert.equal(normalizeRemoteUrl('').ok, false);
    }
  );
});
