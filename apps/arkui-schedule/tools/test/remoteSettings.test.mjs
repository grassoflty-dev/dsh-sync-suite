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
import { readSettingsFile, readSettingsPage, readSettingsSources } from './settingsSources.mjs';

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

  test('唯一入口：RemoteGroup 只渲染一行「远程实例与云端对话 ›」打开 pages/Instances', () => {
    const group = bodyOf(PAGE, 'RemoteGroup() {', '@Builder\n  DataGroup()');
    assert.equal((group.match(/this\.ChatEntryRow\(\)/g) ?? []).length, 1, '入口行恰好一行');
    assert.equal((group.match(/TextInput\(/g) ?? []).length, 0, '入口组里不该有任何输入框');
    assert.equal((PAGE.match(/this\.RemoteGroup\(\)/g) ?? []).length, 2, '紧凑屏 / 宽屏各装配一次');
    assert.equal((PAGE.match(/this\.ChatEntryRow\(\)/g) ?? []).length, 1, '整页只有这一处入口行调用');
    const entry = bodyOf(PAGE, 'ChatEntryRow() {', 'private openInstances()');
    assert.match(entry, /Text\('远程实例与云端对话'\)/, '入口文案仍在');
    assert.match(entry, /Text\('›'\)/, '入口仍是可点的 › 行');
    assert.match(PAGE, /router\.pushUrl\(\{ url: 'pages\/Instances' \}\)/, '入口指向实例页');
  });

  test('组顺序未回归：远程入口组仍排在「关于」之前（紧凑屏与宽屏）', () => {
    for (const [name, body] of [
      ['compact', bodyOf(PAGE, 'CompactBody() {', 'WideBody() {')],
      ['wide', bodyOf(PAGE, 'WideBody() {', '// ------------------------------------------------------------------ 弹层')]
    ]) {
      const remote = body.indexOf('this.RemoteGroup()');
      const about = body.indexOf('this.AboutGroup()');
      assert.ok(remote >= 0, `${name} 缺远程入口组`);
      assert.ok(about > remote, `${name} 里远程入口必须排在关于之前`);
    }
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
      const first = seedInstances([], legacy);
      assert.equal(first.length, 2, '本机行 + 一条迁移实例');
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
