// 「远程访问方式」配置模型（`model/remoteAccess.ts`）的纯函数测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 这个文件与插件侧 `packages/dsh-git-config-sync/src/remote/accessMode.ts` / `urls.ts`
// 共用同一套字段语义（`docs/REMOTE-ACCESS-OPTIONS.md` §3 是唯一事实来源），因此断言里有
// 不少「逐字文案」：方式可用性、uu 的不可用原因、tailscale 的卓易通提醒、字段键名与顺序。
// 改文案就是改契约，必须两端一起改——测试就是这条契约的钉子。
//
// `remoteAccess.ts` 运行期 import `./remoteUrl`（无扩展名），Node 的 ESM 不做扩展名推断，
// 这里只为测试进程补 `.js` 后缀（与 attachmentMerge.test.mjs 同一套写法）。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.js')
      ) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const {
  REMOTE_AVAILABILITY_NEEDS_SETUP,
  REMOTE_AVAILABILITY_READY,
  REMOTE_AVAILABILITY_UNSUPPORTED,
  REMOTE_MODE_CLOUDFLARE,
  REMOTE_MODE_IPV6,
  REMOTE_MODE_LAN,
  REMOTE_MODE_MANUAL,
  REMOTE_MODE_ORDER,
  REMOTE_MODE_TAILSCALE,
  REMOTE_MODES,
  REMOTE_MODE_UU,
  buildRemoteAccessUrl,
  defaultRemoteAccessConfig,
  findRemoteMode,
  listRemoteModes,
  missingFields,
  normalizeRemoteAccessConfig,
  normalizeRemoteMode,
  normalizeRemotePort,
  remoteModeUsable,
  serializeRemoteAccessConfig
} = await import('../.build/model/remoteAccess.js');

/** 造一份配置（只覆盖关心的字段，其余保持默认）。 */
function configOf(overrides) {
  // 端口默认给 3080：`lan` / `ipv6` / `tailscale` 下端口是必填（App 拿不到电脑上的 DSH 端口，
  // 省略端口只会打开 80）。要测「没填端口」就显式传 `port: 0`。
  return { ...defaultRemoteAccessConfig(), port: 3080, ...overrides };
}

/** 断言「拼不出地址」：ok=false、url 为空串、reason 非空且包含给定关键字。 */
function assertUrlFailed(config, keyword) {
  const built = buildRemoteAccessUrl(config);
  assert.equal(built.ok, false, `应拼不出地址：${JSON.stringify(config)}`);
  assert.equal(built.url, '', '失败时 url 必须是空串（fail-closed）');
  assert.equal(built.reason.length > 0, true, '失败必须给中文原因');
  assert.ok(built.reason.includes(keyword), `原因应包含「${keyword}」，实际：${built.reason}`);
  return built;
}

/** 断言「拼出了地址」。 */
function assertUrl(config, expected) {
  const built = buildRemoteAccessUrl(config);
  assert.equal(built.ok, true, `应拼出地址：${JSON.stringify(config)}（reason=${built.reason}）`);
  assert.equal(built.url, expected, '拼出的地址不匹配');
  assert.equal(built.reason, '', '成功时 reason 必须为空串');
  return built;
}

describe('方式元数据表：六种方式、可用性、字段键名', () => {
  test('REMOTE_MODE_ORDER 是下拉框顺序（uu 恒排末尾），listRemoteModes 与之一一对应', () => {
    assert.deepEqual([...REMOTE_MODE_ORDER], [
      REMOTE_MODE_LAN,
      REMOTE_MODE_TAILSCALE,
      REMOTE_MODE_IPV6,
      REMOTE_MODE_CLOUDFLARE,
      REMOTE_MODE_MANUAL,
      REMOTE_MODE_UU
    ]);
    const modes = listRemoteModes();
    assert.equal(modes.length, 6, '六个方式都要有元数据');
    assert.deepEqual(
      modes.map((spec) => spec.mode),
      [...REMOTE_MODE_ORDER],
      'listRemoteModes 的顺序必须与 REMOTE_MODE_ORDER 一致'
    );
    // 返回的是新数组：调用方乱改不会污染常量表
    modes.length = 0;
    assert.equal(listRemoteModes().length, 6, 'listRemoteModes 每次都要返回完整的新数组');
    assert.equal(REMOTE_MODE_ORDER[0], 'lan', '默认方式 lan 必须排第一');
    assert.equal(REMOTE_MODE_ORDER[5], 'uu', '不可用的 uu 必须排最后');
  });

  test('lan / manual = ready（本仓库可直接落地）', () => {
    assert.equal(REMOTE_MODES[REMOTE_MODE_LAN].availability, REMOTE_AVAILABILITY_READY);
    assert.equal(REMOTE_MODES[REMOTE_MODE_MANUAL].availability, REMOTE_AVAILABILITY_READY);
    assert.equal(REMOTE_AVAILABILITY_READY, 'ready');
    assert.equal(REMOTE_MODES[REMOTE_MODE_LAN].unavailableReason, '');
  });

  test('ipv6 / cloudflare / tailscale = needs-setup（要用户先做环境准备）', () => {
    for (const mode of [REMOTE_MODE_IPV6, REMOTE_MODE_CLOUDFLARE, REMOTE_MODE_TAILSCALE]) {
      assert.equal(REMOTE_MODES[mode].availability, REMOTE_AVAILABILITY_NEEDS_SETUP, `${mode} 应是 needs-setup`);
      assert.equal(REMOTE_MODES[mode].requires.length > 0, true, `${mode} 必须给出前置条件`);
      assert.equal(REMOTE_MODES[mode].unavailableReason, '', `${mode} 可用，不该有不可用原因`);
    }
    assert.equal(REMOTE_AVAILABILITY_NEEDS_SETUP, 'needs-setup');
  });

  test('uu = unsupported，原因逐字：画面串流不产生端口/虚拟网卡', () => {
    const spec = REMOTE_MODES[REMOTE_MODE_UU];
    assert.equal(spec.availability, REMOTE_AVAILABILITY_UNSUPPORTED);
    assert.equal(
      spec.unavailableReason,
      '网易 UU 远程是画面串流（远程桌面），不产生端口或虚拟网卡，没法让 App 打开一个网址。'
    );
    assert.ok(spec.unavailableReason.includes('画面串流'), '原因必须点明「画面串流」');
    assert.deepEqual(spec.fields, [], 'uu 没有任何可填字段');
    assert.deepEqual(spec.steps, [], 'uu 没有操作步骤（它做不到）');
    assert.equal(REMOTE_AVAILABILITY_UNSUPPORTED, 'unsupported');
  });

  test('方式字段与 §3 表逐字对齐（键名 + 顺序 + 标签）', () => {
    const keysOf = (mode) => REMOTE_MODES[mode].fields.map((field) => field.key);
    assert.deepEqual(keysOf(REMOTE_MODE_LAN), ['lanAddress', 'port']);
    assert.deepEqual(keysOf(REMOTE_MODE_IPV6), ['ipv6Address', 'port']);
    assert.deepEqual(keysOf(REMOTE_MODE_TAILSCALE), ['tailscaleHost', 'port']);
    assert.deepEqual(keysOf(REMOTE_MODE_CLOUDFLARE), ['cloudflareHost']);
    assert.deepEqual(keysOf(REMOTE_MODE_MANUAL), ['manualUrl']);
    const labels = {};
    for (const mode of REMOTE_MODE_ORDER) {
      for (const field of REMOTE_MODES[mode].fields) {
        labels[field.key] = field.label;
      }
    }
    assert.equal(labels.lanAddress, '局域网地址');
    assert.equal(labels.tailscaleHost, 'Tailscale 地址');
    assert.equal(labels.cloudflareHost, '隧道域名');
    assert.equal(labels.ipv6Address, 'IPv6 地址');
    assert.equal(labels.manualUrl, '完整地址');
    assert.equal(labels.port, '端口');
    assert.equal(REMOTE_MODES[REMOTE_MODE_LAN].label, '局域网直连');
    assert.equal(REMOTE_MODES[REMOTE_MODE_UU].label, '网易 UU 远程');
  });

  test('tailscale：requires 必含鸿蒙原生客户端（HarmoTail，需侧载），且提醒卓易通不可用', () => {
    const spec = REMOTE_MODES[REMOTE_MODE_TAILSCALE];
    const joined = spec.requires.join('|');
    assert.ok(
      spec.requires.includes('平板需装鸿蒙原生 Tailscale 客户端（如 HarmoTail，需侧载）'),
      'requires 必须逐字含「平板需装鸿蒙原生 Tailscale 客户端（如 HarmoTail，需侧载）」'
    );
    assert.ok(joined.includes('鸿蒙原生'), 'requires 要明写「鸿蒙原生」');
    assert.ok(spec.description.includes('卓易通'), 'description 必须提醒卓易通里装的安卓 Tailscale 不能给本机 App 用');
    assert.equal(spec.requires[0], '平板需装鸿蒙原生 Tailscale 客户端（如 HarmoTail，需侧载）', 'UI 显示 requires[0]，必须是那条硬门槛');
    assert.ok(spec.steps.length >= 3, 'tailscale 要给操作步骤');
  });

  test('findRemoteMode：只认精确枚举值（不做 trim / 大小写容错）', () => {
    assert.equal(findRemoteMode('lan').mode, 'lan');
    assert.equal(findRemoteMode('uu').mode, 'uu');
    assert.equal(findRemoteMode('LAN'), null, '大小写不同就是未知值');
    assert.equal(findRemoteMode(' lan '), null, '带空白也是未知值');
    assert.equal(findRemoteMode(''), null);
    assert.equal(findRemoteMode('nope'), null);
    assert.equal(findRemoteMode(undefined), null, '非字符串必须返回 null（不抛异常）');
    assert.equal(findRemoteMode(null), null);
  });

  test('normalizeRemoteMode：未知/空一律回落 lan', () => {
    assert.equal(normalizeRemoteMode('lan'), 'lan');
    assert.equal(normalizeRemoteMode('ipv6'), 'ipv6');
    assert.equal(normalizeRemoteMode('cloudflare'), 'cloudflare');
    assert.equal(normalizeRemoteMode('uu'), 'uu', 'uu 是已知方式（允许选中看原因），不能被折成 lan');
    assert.equal(normalizeRemoteMode(''), 'lan');
    assert.equal(normalizeRemoteMode('   '), 'lan');
    assert.equal(normalizeRemoteMode('nope'), 'lan');
    assert.equal(normalizeRemoteMode('LAN'), 'lan');
    assert.equal(normalizeRemoteMode(undefined), 'lan');
    assert.equal(normalizeRemoteMode(null), 'lan');
  });

  test('remoteModeUsable：只有 unsupported 为 false，未知方式 fail-closed', () => {
    assert.equal(remoteModeUsable('lan'), true);
    assert.equal(remoteModeUsable('manual'), true);
    assert.equal(remoteModeUsable('ipv6'), true, 'needs-setup 仍然「可用」，只是要用户先准备');
    assert.equal(remoteModeUsable('cloudflare'), true);
    assert.equal(remoteModeUsable('tailscale'), true);
    assert.equal(remoteModeUsable('uu'), false, 'unsupported 必须 false（不做假开关）');
    assert.equal(remoteModeUsable('zzz'), false, '未知方式 fail-closed');
    assert.equal(remoteModeUsable(''), false);
  });
});

describe('buildRemoteAccessUrl：六种方式各拼一条地址', () => {
  test('lan → http://<地址>:<端口>/', () => {
    assertUrl(configOf({ mode: 'lan', lanAddress: '192.168.1.6', port: 3080 }), 'http://192.168.1.6:3080/');
  });

  test('lan：port=0 → 拼不出地址（端口必填，不能静默落到 80）', () => {
    assertUrlFailed(configOf({ mode: 'lan', lanAddress: '192.168.1.6', port: 0 }), '请先填端口');
  });

  test('lan：地址留空 / 地址里带协议 / 带路径 / 带端口 → 都拼不出地址', () => {
    assertUrlFailed(configOf({ mode: 'lan', lanAddress: '', port: 3080 }), '还没有填写局域网地址');
    assertUrlFailed(configOf({ mode: 'lan', lanAddress: 'http://192.168.1.6' }), '不要带 http:// 或 https://');
    assertUrlFailed(configOf({ mode: 'lan', lanAddress: '192.168.1.6/dsh' }), '不要带路径');
    assertUrlFailed(configOf({ mode: 'lan', lanAddress: '192.168.1.6:3080' }), '不要带端口');
  });

  test('lan / ipv6：通配地址（0.0.0.0 / * / ::）拒绝——那不是能打开的地址', () => {
    assertUrlFailed(configOf({ mode: 'lan', lanAddress: '0.0.0.0' }), '不能用通配地址');
    assertUrlFailed(configOf({ mode: 'lan', lanAddress: '*' }), '不能用通配地址');
    assertUrlFailed(configOf({ mode: 'ipv6', ipv6Address: '::' }), '不能用未指定地址');
    assertUrlFailed(configOf({ mode: 'cloudflare', cloudflareHost: '*' }), '不能用通配地址');
  });

  test('ipv6 → http://[<地址>]:<端口>/（方括号由函数补，不来自用户输入）', () => {
    assertUrl(
      configOf({ mode: 'ipv6', ipv6Address: '2409:8a20:4cad:ba20:1234:5678:9abc:def0', port: 3080 }),
      'http://[2409:8a20:4cad:ba20:1234:5678:9abc:def0]:3080/'
    );
  });

  test('ipv6：用户粘贴时带了方括号也要容错（§3 要求字段本身不带方括号）', () => {
    assertUrl(configOf({ mode: 'ipv6', ipv6Address: '[::1]', port: 3080 }), 'http://[::1]:3080/');
    assertUrlFailed(configOf({ mode: 'ipv6', ipv6Address: '::1', port: 0 }), '请先填端口');
  });

  test('ipv6：空地址 / 没有冒号的地址 → 拼不出地址', () => {
    assertUrlFailed(configOf({ mode: 'ipv6', ipv6Address: '', port: 3080 }), '还没有填写 IPv6 地址');
    assertUrlFailed(configOf({ mode: 'ipv6', ipv6Address: '192.168.1.6', port: 3080 }), '必须带冒号');
  });

  test('tailscale → http://<100.x>:<端口>/', () => {
    assertUrl(configOf({ mode: 'tailscale', tailscaleHost: '100.101.102.103', port: 41641 }), 'http://100.101.102.103:41641/');
    assertUrlFailed(configOf({ mode: 'tailscale', tailscaleHost: '', port: 3080 }), '还没有填写 Tailscale 地址');
    assertUrlFailed(
      configOf({ mode: 'tailscale', tailscaleHost: '100.101.102.103:41641' }),
      '不要带端口'
    );
  });

  test('cloudflare → https://<域名>/（隧道对外恒 443，端口不参与）', () => {
    assertUrl(configOf({ mode: 'cloudflare', cloudflareHost: 'xxx.trycloudflare.com', port: 3080 }), 'https://xxx.trycloudflare.com/');
    assertUrlFailed(configOf({ mode: 'cloudflare', cloudflareHost: '' }), '还没有填写隧道域名');
    assertUrlFailed(configOf({ mode: 'cloudflare', cloudflareHost: 'https://xxx.trycloudflare.com' }), '不要带 http:// 或 https://');
    assertUrlFailed(configOf({ mode: 'cloudflare', cloudflareHost: 'xxx.trycloudflare.com/ui' }), '不要带路径');
  });

  test('manual → 复用 normalizeRemoteUrl（缺协议自动补 http://、保留 token）', () => {
    assertUrl(configOf({ mode: 'manual', manualUrl: '192.168.1.6:3080/?token=abc' }), 'http://192.168.1.6:3080/?token=abc');
    assertUrl(configOf({ mode: 'manual', manualUrl: 'https://example.com/' }), 'https://example.com/');
    assertUrl(configOf({ mode: 'manual', manualUrl: 'https://dsh.example.com/?token=abc&x=1' }), 'https://dsh.example.com/?token=abc&x=1');
    assertUrlFailed(configOf({ mode: 'manual', manualUrl: '' }), '请先填写电脑上的 DSH 地址');
    assertUrlFailed(configOf({ mode: 'manual', manualUrl: 'ftp://example.com' }), '只支持 http:// 或 https://');
  });

  test('uu → 恒 ok:false，原因是「画面串流」那段原话', () => {
    const built = buildRemoteAccessUrl(configOf({ mode: 'uu' }));
    assert.equal(built.ok, false);
    assert.equal(built.url, '', 'uu 绝不能产出地址');
    assert.equal(built.reason, REMOTE_MODES[REMOTE_MODE_UU].unavailableReason);
    assert.ok(built.reason.includes('虚拟网卡'));
  });

  test('未知 mode 回落 lan（不猜、也不报错）', () => {
    assertUrl(configOf({ mode: 'zzz', lanAddress: '10.0.0.9', port: 8080 }), 'http://10.0.0.9:8080/');
    assertUrlFailed(configOf({ mode: '', lanAddress: '' }), '还没有填写局域网地址');
  });
});

describe('配置归一：坏 JSON / 未知 mode / 负端口一律回落，不抛异常', () => {
  test('默认配置：lan + 端口 0 + 所有地址空串', () => {
    const config = defaultRemoteAccessConfig();
    assert.equal(config.mode, REMOTE_MODE_LAN);
    assert.equal(config.port, 0);
    assert.equal(config.lanAddress, '');
    assert.equal(config.tailscaleHost, '');
    assert.equal(config.cloudflareHost, '');
    assert.equal(config.ipv6Address, '');
    assert.equal(config.manualUrl, '');
  });

  test('坏 JSON / 空串 / 数组 / 标量 / null 都回落默认值（不抛）', () => {
    for (const raw of ['', '   ', 'not json', '{oops}', '[]', 'null', '"str"', '42', 'true']) {
      const config = normalizeRemoteAccessConfig(raw);
      assert.equal(config.mode, 'lan', `坏输入必须回落 lan：${JSON.stringify(raw)}`);
      assert.equal(config.port, 0);
      assert.equal(config.lanAddress, '');
    }
    assert.equal(normalizeRemoteAccessConfig(undefined).mode, 'lan');
    assert.equal(normalizeRemoteAccessConfig(null).mode, 'lan');
  });

  test('未知 mode → lan；已知 mode 原样保留', () => {
    assert.equal(normalizeRemoteAccessConfig('{"mode":"nope"}').mode, 'lan');
    assert.equal(normalizeRemoteAccessConfig('{"mode":"LAN"}').mode, 'lan');
    assert.equal(normalizeRemoteAccessConfig('{"mode":"ipv6"}').mode, 'ipv6');
    assert.equal(normalizeRemoteAccessConfig('{"mode":"uu"}').mode, 'uu');
    assert.equal(normalizeRemoteAccessConfig('{"mode":123}').mode, 'lan', '非字符串 mode 也回落');
  });

  test('端口：负数 / 超上限 / 小数 / 非数字都归一', () => {
    assert.equal(normalizeRemoteAccessConfig('{"port":-1}').port, 0, '负端口回落 0');
    assert.equal(normalizeRemoteAccessConfig('{"port":-3080}').port, 0);
    assert.equal(normalizeRemoteAccessConfig('{"port":70000}').port, 65535);
    assert.equal(normalizeRemoteAccessConfig('{"port":3080.9}').port, 3080);
    assert.equal(normalizeRemoteAccessConfig('{"port":"3080"}').port, 0, '字符串端口不算数');
    assert.equal(normalizeRemotePort(-5), 0);
    assert.equal(normalizeRemotePort(0), 0);
    assert.equal(normalizeRemotePort(3080), 3080);
    assert.equal(normalizeRemotePort(65535), 65535);
    assert.equal(normalizeRemotePort(65536), 65535);
    assert.equal(normalizeRemotePort(Number.NaN), 0);
    assert.equal(normalizeRemotePort(Number.POSITIVE_INFINITY), 0);
  });

  test('地址字段去首尾空白、非字符串按空串处理', () => {
    const config = normalizeRemoteAccessConfig(
      '{"mode":"manual","lanAddress":"  192.168.1.6  ","manualUrl":" https://x.example.com/?token=abc ","tailscaleHost":42}'
    );
    assert.equal(config.lanAddress, '192.168.1.6');
    assert.equal(config.manualUrl, 'https://x.example.com/?token=abc');
    assert.equal(config.tailscaleHost, '', '非字符串字段按空串');
    assert.equal(config.cloudflareHost, '');
  });

  test('序列化幂等：serialize(normalize(serialize(x))) 与 serialize(x) 逐字相同', () => {
    const config = configOf({
      mode: 'ipv6',
      ipv6Address: '2409:8a20:4cad:ba20::763c',
      port: 3080,
      lanAddress: ' 192.168.1.6 '
    });
    const once = serializeRemoteAccessConfig(config);
    const twice = serializeRemoteAccessConfig(normalizeRemoteAccessConfig(once));
    assert.equal(twice, once, '一次读写来回不能变形');
    const again = serializeRemoteAccessConfig(normalizeRemoteAccessConfig(twice));
    assert.equal(again, once);
    assert.deepEqual(JSON.parse(once), {
      mode: 'ipv6',
      lanAddress: '192.168.1.6',
      port: 3080,
      tailscaleHost: '',
      cloudflareHost: '',
      ipv6Address: '2409:8a20:4cad:ba20::763c',
      manualUrl: ''
    });
    // 反序列化后再序列化，内容等价（键顺序固定）
    assert.deepEqual(JSON.parse(serializeRemoteAccessConfig(normalizeRemoteAccessConfig(once))), JSON.parse(once));
  });
});

describe('missingFields：报必填字段；端口在 lan/ipv6/tailscale 下也算必填', () => {
  test('lan：空地址 → 只报 lanAddress；填了地址与端口 → 不报', () => {
    assert.deepEqual(missingFields('lan', configOf({ mode: 'lan' })), ['lanAddress']);
    assert.deepEqual(missingFields('lan', configOf({ mode: 'lan', lanAddress: '192.168.1.6', port: 3080 })), []);
  });

  test('端口在 lan/ipv6/tailscale 下必填（0 会报缺失）；cloudflare/manual 不看端口', () => {
    for (const mode of ['lan', 'ipv6', 'tailscale']) {
      assert.equal(missingFields(mode, configOf({ mode: mode, port: 0 })).includes('port'), true, `${mode} 应报端口缺失`);
    }
    assert.equal(missingFields('cloudflare', configOf({ mode: 'cloudflare', port: 0 })).includes('port'), false);
    assert.equal(missingFields('manual', configOf({ mode: 'manual', port: 0 })).includes('port'), false);
  });

  test('ipv6 / tailscale / cloudflare / manual 各报自己的字段', () => {
    assert.deepEqual(missingFields('ipv6', configOf({ mode: 'ipv6' })), ['ipv6Address']);
    assert.deepEqual(missingFields('tailscale', configOf({ mode: 'tailscale' })), ['tailscaleHost']);
    assert.deepEqual(missingFields('cloudflare', configOf({ mode: 'cloudflare' })), ['cloudflareHost']);
    assert.deepEqual(missingFields('manual', configOf({ mode: 'manual' })), ['manualUrl']);
    assert.deepEqual(missingFields('manual', configOf({ mode: 'manual', manualUrl: 'https://x.example.com/' })), []);
  });

  test('uu 没有字段因此不缺任何东西；未知方式归一成 lan（不抛）', () => {
    assert.deepEqual(missingFields('uu', configOf({ mode: 'uu' })), []);
    assert.deepEqual(missingFields('nope', configOf({ mode: 'nope' })), ['lanAddress'], '未知方式归一成 lan');
    assert.deepEqual(missingFields('', configOf({})), ['lanAddress'], '空方式归一成 lan，缺的是局域网地址');
  });

  test('只填空格不算填（trim 后为空）', () => {
    assert.deepEqual(missingFields('lan', configOf({ mode: 'lan', lanAddress: '   ' })), ['lanAddress']);
  });
});
