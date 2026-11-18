// 「远程访问方式」配置模型（`model/remoteAccess.ts`）的纯函数测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 这个文件与插件侧 `packages/dsh-git-config-sync/src/remote/accessMode.ts` / `urls.ts`
// 共用同一套字段语义（`docs/REMOTE-ACCESS-OPTIONS.md` §3 是唯一事实来源），因此断言里有
// 不少「逐字文案」：方式可用性、uu 的「图形化端口映射」准备项、tailscale 的卓易通提醒、
// 字段键名与顺序。
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
  REMOTE_TOKEN_INVALID_REASON,
  appendRemoteToken,
  buildRemoteAccessUrl,
  defaultRemoteAccessConfig,
  findRemoteMode,
  listRemoteModes,
  maskRemoteToken,
  missingFields,
  normalizeRemoteAccessConfig,
  normalizeRemoteMode,
  normalizeRemotePort,
  remoteModeUsable,
  serializeRemoteAccessConfig,
  validateRemoteToken
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
    assert.equal(REMOTE_MODE_ORDER[5], 'uu', 'uu 排最后（要用户先在 UU 远程里建映射，最不推荐）');
  });

  test('lan / manual = ready（本仓库可直接落地）', () => {
    assert.equal(REMOTE_MODES[REMOTE_MODE_LAN].availability, REMOTE_AVAILABILITY_READY);
    assert.equal(REMOTE_MODES[REMOTE_MODE_MANUAL].availability, REMOTE_AVAILABILITY_READY);
    assert.equal(REMOTE_AVAILABILITY_READY, 'ready');
    assert.equal(REMOTE_MODES[REMOTE_MODE_LAN].unavailableReason, '');
  });

  test('ipv6 / cloudflare / tailscale / uu = needs-setup（要用户先做环境准备）', () => {
    for (const mode of [REMOTE_MODE_IPV6, REMOTE_MODE_CLOUDFLARE, REMOTE_MODE_TAILSCALE, REMOTE_MODE_UU]) {
      assert.equal(REMOTE_MODES[mode].availability, REMOTE_AVAILABILITY_NEEDS_SETUP, `${mode} 应是 needs-setup`);
      assert.equal(REMOTE_MODES[mode].requires.length > 0, true, `${mode} 必须给出前置条件`);
      assert.equal(REMOTE_MODES[mode].unavailableReason, '', `${mode} 可用，不该有不可用原因`);
    }
    assert.equal(REMOTE_AVAILABILITY_NEEDS_SETUP, 'needs-setup');
  });

  test('uu = needs-setup（官方图形化端口映射，免费版含）：字段复用 manualUrl + token，5 步', () => {
    const spec = REMOTE_MODES[REMOTE_MODE_UU];
    // 结论订正：官方 blog（2026-11-10）明确「图形化端口映射」并提供给开发者（免费版包含），
    // 所以 uu 不再是 unsupported，也没有「不产生端口/虚拟网卡」这类原因。
    assert.equal(spec.availability, REMOTE_AVAILABILITY_NEEDS_SETUP);
    assert.equal(spec.availability, 'needs-setup');
    assert.equal(spec.unavailableReason, '', 'uu 可用，unavailableReason 必须是空串');
    assert.equal(
      spec.description,
      '用 UU 远程的图形化端口映射把本机 DSH 端口映射成对外入口，平板打开那个入口。'
    );
    assert.deepEqual(spec.requires, [
      '电脑装 UU 远程并登录（免费版含端口映射）',
      '在 UU 远程 →「图形化端口映射」里把内部端口设为 DSH 端口'
    ]);
    // 复用两个既有存储字段，不新增字段：manualUrl（对外入口）+ token（可选）
    assert.deepEqual(
      spec.fields.map((field) => field.key),
      ['manualUrl', 'token'],
      'uu 必须复用 manualUrl + token 两个既有字段'
    );
    assert.equal(spec.fields[0].label, '对外入口地址');
    assert.equal(spec.fields[0].placeholder, '从 UU 远程复制，如 abc.uuyc.com:12345 或 https://…');
    assert.equal(spec.fields[0].hint, 'UU远程 → 图形化端口映射 → 内部端口填 DSH 端口 → 复制生成的对外入口');
    assert.equal(spec.fields[1].label, '访问令牌（可选）');
    assert.equal(spec.steps.length, 5, 'uu 要给 5 步操作步骤');
    assert.ok(spec.steps[0].includes('启动 DSH'), '第 1 步是启动 DSH 记端口');
    assert.ok(spec.steps.join('|').includes('图形化端口映射'), '步骤里必须点明「图形化端口映射」');
    assert.ok(spec.steps[4].includes('平板打开'), '最后一步是平板打开入口');
    // `unsupported` 语义仍然保留给未来的方式，但当前没有任何方式使用它
    assert.equal(REMOTE_AVAILABILITY_UNSUPPORTED, 'unsupported');
    assert.deepEqual(
      REMOTE_MODE_ORDER.filter((mode) => REMOTE_MODES[mode].availability === REMOTE_AVAILABILITY_UNSUPPORTED),
      [],
      '当前没有 unsupported 方式（uu 已订正为 needs-setup）'
    );
  });

  test('方式字段与 §3 表逐字对齐（键名 + 顺序 + 标签）', () => {
    const keysOf = (mode) => REMOTE_MODES[mode].fields.map((field) => field.key);
    // 「访问令牌（可选）」出现在四种要拼地址的方式里，位置固定在地址/端口之后
    assert.deepEqual(keysOf(REMOTE_MODE_LAN), ['lanAddress', 'port', 'token']);
    assert.deepEqual(keysOf(REMOTE_MODE_IPV6), ['ipv6Address', 'port', 'token']);
    assert.deepEqual(keysOf(REMOTE_MODE_TAILSCALE), ['tailscaleHost', 'port', 'token']);
    assert.deepEqual(keysOf(REMOTE_MODE_CLOUDFLARE), ['cloudflareHost']);
    assert.deepEqual(keysOf(REMOTE_MODE_MANUAL), ['manualUrl']);
    // uu 复用 manualUrl + token（同一个键名 -> 同一份存储，不新增字段）
    assert.deepEqual(keysOf(REMOTE_MODE_UU), ['manualUrl', 'token']);
    const labelOf = (mode, key) => {
      const field = REMOTE_MODES[mode].fields.find((item) => item.key === key);
      return field === undefined ? undefined : field.label;
    };
    assert.equal(labelOf(REMOTE_MODE_LAN, 'lanAddress'), '局域网地址');
    assert.equal(labelOf(REMOTE_MODE_TAILSCALE, 'tailscaleHost'), 'Tailscale 地址');
    assert.equal(labelOf(REMOTE_MODE_CLOUDFLARE, 'cloudflareHost'), '隧道域名');
    assert.equal(labelOf(REMOTE_MODE_IPV6, 'ipv6Address'), 'IPv6 地址');
    assert.equal(labelOf(REMOTE_MODE_LAN, 'port'), '端口');
    assert.equal(labelOf(REMOTE_MODE_LAN, 'token'), '访问令牌（可选）');
    // 同一个键名 `manualUrl` 在两种方式下标签不同：手填 = 完整地址，uu = 对外入口地址
    assert.equal(labelOf(REMOTE_MODE_MANUAL, 'manualUrl'), '完整地址');
    assert.equal(labelOf(REMOTE_MODE_UU, 'manualUrl'), '对外入口地址');
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
    assert.equal(remoteModeUsable('uu'), true, 'needs-setup（要先在 UU 远程里建映射）仍然可用，不做假开关');
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

  test('uu → 按 manualUrl（对外入口）拼地址：三种入口形态各自的默认协议', () => {
    // 已带协议：原样（交给 normalizeRemoteUrl，不擅自升级 http -> https）
    assertUrl(configOf({ mode: 'uu', manualUrl: 'https://x.com' }), 'https://x.com');
    assertUrl(configOf({ mode: 'uu', manualUrl: 'http://h:1' }), 'http://h:1');
    // 没协议 + host:port：补 http://（UU 映射出来的端口通常直接是明文 HTTP）
    assertUrl(configOf({ mode: 'uu', manualUrl: 'abc.uuyc.com:12345' }), 'http://abc.uuyc.com:12345');
    // 没协议 + 含 `/`（像域名入口）：补 https://
    assertUrl(configOf({ mode: 'uu', manualUrl: 'abc.uuyc.com/dsh' }), 'https://abc.uuyc.com/dsh');
    // 粘贴时带首尾空白要能容错（trim 后同一条规则）
    assertUrl(configOf({ mode: 'uu', manualUrl: '  abc.uuyc.com:12345  ' }), 'http://abc.uuyc.com:12345');
  });

  test('uu：入口留空 → ok:false +「还没填」；入口非法 → ok:false（fail-closed）', () => {
    assertUrlFailed(configOf({ mode: 'uu', manualUrl: '' }), '还没填 UU 远程生成的对外入口');
    assertUrlFailed(configOf({ mode: 'uu', manualUrl: '   ' }), '还没填 UU 远程生成的对外入口');
    assertUrlFailed(configOf({ mode: 'uu', manualUrl: 'ftp://x.com' }), '只支持 http:// 或 https://');
    assertUrlFailed(configOf({ mode: 'uu', manualUrl: 'abc.uuyc.com:999999' }), '对外入口不可用');
  });

  test('uu：令牌非空时与其它三种方式一样追加 ?token=', () => {
    const token = 'AbCdEf0123456789';
    assertUrl(
      configOf({ mode: 'uu', manualUrl: 'abc.uuyc.com:12345', token: token }),
      `http://abc.uuyc.com:12345?token=${token}`
    );
    assertUrl(
      configOf({ mode: 'uu', manualUrl: 'https://x.com', token: token }),
      `https://x.com?token=${token}`
    );
    assertUrl(
      configOf({ mode: 'uu', manualUrl: 'https://x.com/?a=1', token: token }),
      `https://x.com/?a=1&token=${token}`,
      '入口自带 query 时必须用 & 追加'
    );
    // 令牌留空 = 不加参数（与其它方式一致）
    assertUrl(configOf({ mode: 'uu', manualUrl: 'https://x.com', token: '' }), 'https://x.com');
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
    assert.equal(config.token, '', '访问令牌默认空串 = 不带令牌');
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
      lanAddress: ' 192.168.1.6 ',
      // 令牌也走同一条归一（trim）：粘贴时常带换行/空格
      token: '  AbCdEf012345  '
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
      manualUrl: '',
      token: 'AbCdEf012345'
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

  test('uu 报 manualUrl（对外入口必填），令牌可选；未知方式归一成 lan（不抛）', () => {
    assert.deepEqual(missingFields('uu', configOf({ mode: 'uu' })), ['manualUrl']);
    assert.deepEqual(missingFields('uu', configOf({ mode: 'uu', manualUrl: '   ' })), ['manualUrl'], '只有空格不算填');
    assert.deepEqual(
      missingFields('uu', configOf({ mode: 'uu', manualUrl: 'abc.uuyc.com:12345' })),
      [],
      '填了对外入口就不缺（令牌可选）'
    );
    assert.deepEqual(
      missingFields('uu', configOf({ mode: 'uu', manualUrl: 'abc.uuyc.com:12345', token: 'AbCdEf012345' })),
      []
    );
    assert.deepEqual(missingFields('nope', configOf({ mode: 'nope' })), ['lanAddress'], '未知方式归一成 lan');
    assert.deepEqual(missingFields('', configOf({})), ['lanAddress'], '空方式归一成 lan，缺的是局域网地址');
  });

  test('只填空格不算填（trim 后为空）', () => {
    assert.deepEqual(missingFields('lan', configOf({ mode: 'lan', lanAddress: '   ' })), ['lanAddress']);
  });

  test('访问令牌是可选字段：空 / 非空都不算「缺字段」', () => {
    const filled = configOf({ mode: 'lan', lanAddress: '192.168.1.6', port: 3080 });
    assert.deepEqual(missingFields('lan', filled), [], '没填令牌不该报缺字段');
    assert.deepEqual(missingFields('lan', { ...filled, token: 'AbCdEf012345' }), [], '填了令牌同样不缺');
    assert.deepEqual(missingFields('ipv6', configOf({ mode: 'ipv6', ipv6Address: '::1' })), [], 'ipv6 填齐地址与端口即不缺');
    assert.deepEqual(
      missingFields('tailscale', configOf({ mode: 'tailscale', tailscaleHost: '100.101.102.103' })),
      [],
      'tailscale 填齐地址与端口即不缺'
    );
  });
});

// 访问令牌（可选）与插件侧 `RemoteSettings.token` 是同一套语义：字段名 `token`、只在
// lan / ipv6 / tailscale 的字段表里、空串 = 不加参数、非空 = `?token=<encodeURIComponent(值)>`。
// 这里断言的重点除了"能拼对"，还有**失败原因里不能出现令牌值**（secret 纪律）。
describe('访问令牌（可选）：字段表、校验、拼装、打码', () => {
  const TOKEN = 'AbCdEf0123456789';

  test('四种方式有 token 字段（地址/端口之后），cloudflare / manual 没有', () => {
    const hasToken = (mode) => REMOTE_MODES[mode].fields.some((field) => field.key === 'token');
    for (const mode of [REMOTE_MODE_LAN, REMOTE_MODE_IPV6, REMOTE_MODE_TAILSCALE]) {
      assert.equal(hasToken(mode), true, `${mode} 必须有「访问令牌（可选）」字段`);
      const keys = REMOTE_MODES[mode].fields.map((field) => field.key);
      assert.equal(keys.indexOf('token'), keys.indexOf('port') + 1, `${mode} 的 token 必须紧跟端口（端口之后）`);
    }
    // uu 复用同一个 token 字段（它没有端口字段，令牌紧跟对外入口）
    assert.equal(hasToken(REMOTE_MODE_UU), true, 'uu 也走 token 字段（映射出的入口可能仍要令牌校验）');
    const uuKeys = REMOTE_MODES[REMOTE_MODE_UU].fields.map((field) => field.key);
    assert.equal(uuKeys.indexOf('token'), uuKeys.indexOf('manualUrl') + 1, 'uu 的 token 紧跟对外入口');
    for (const mode of [REMOTE_MODE_CLOUDFLARE, REMOTE_MODE_MANUAL]) {
      assert.equal(hasToken(mode), false, `${mode} 不该有 token 字段`);
    }
    // 四种方式的令牌字段文案同源（都来自 tokenField()）
    for (const mode of [REMOTE_MODE_LAN, REMOTE_MODE_IPV6, REMOTE_MODE_TAILSCALE, REMOTE_MODE_UU]) {
      const field = REMOTE_MODES[mode].fields.find((item) => item.key === 'token');
      assert.equal(field.label, '访问令牌（可选）');
      assert.equal(field.placeholder, '粘贴电脑上 DSH 地址里的 token');
      assert.equal(field.hint, '留空则不带令牌；填了会在链接里追加 ?token=…');
    }
  });

  test('validateRemoteToken：空 / 空白合法；合法字符集与长度通过；其余给中文原因', () => {
    assert.equal(validateRemoteToken(''), '', '空串 = 不填令牌，合法');
    assert.equal(validateRemoteToken('   '), '', '只有空白也当没填');
    assert.equal(validateRemoteToken(TOKEN), '');
    assert.equal(validateRemoteToken('  ' + TOKEN + '\n'), '', '粘贴带换行/空格要 trim 后再判');
    assert.equal(validateRemoteToken('abc+def/ghi='), '', 'base64 字符集合法');
    assert.equal(validateRemoteToken('abc-def_ghi9'), '', 'base64url 字符集合法');
    assert.equal(validateRemoteToken('a'.repeat(512)), '', '512 位是上限');
    for (const bad of ['abc123', 'a'.repeat(513), 'abc def ghi', 'token&with=amp', '中文令牌abcdefgh', 'abc\u3000defgh']) {
      assert.equal(validateRemoteToken(bad), REMOTE_TOKEN_INVALID_REASON, `应判非法：${JSON.stringify(bad)}`);
    }
    assert.equal(
      REMOTE_TOKEN_INVALID_REASON,
      '访问令牌只允许字母数字与 + / = _ -，长度 8–512',
      '原因文案与插件侧逐字一致'
    );
  });

  test('空令牌：地址原样，不追加任何参数', () => {
    assertUrl(configOf({ mode: 'lan', lanAddress: '192.168.1.6', port: 3080, token: '' }), 'http://192.168.1.6:3080/');
    assertUrl(
      configOf({ mode: 'ipv6', ipv6Address: '2409:8a20:4cad:ba20:1234:5678:9abc:def0', port: 3080, token: '  ' }),
      'http://[2409:8a20:4cad:ba20:1234:5678:9abc:def0]:3080/'
    );
    assertUrl(
      configOf({ mode: 'tailscale', tailscaleHost: '100.101.102.103', port: 41641, token: '' }),
      'http://100.101.102.103:41641/'
    );
  });

  test('合法令牌：三种方式的地址后追加 ?token=<值>', () => {
    assertUrl(
      configOf({ mode: 'lan', lanAddress: '192.168.1.6', port: 3080, token: TOKEN }),
      `http://192.168.1.6:3080/?token=${TOKEN}`
    );
    assertUrl(
      configOf({ mode: 'ipv6', ipv6Address: '2409:8a20::1', port: 3080, token: TOKEN }),
      `http://[2409:8a20::1]:3080/?token=${TOKEN}`
    );
    assertUrl(
      configOf({ mode: 'tailscale', tailscaleHost: '100.101.102.103', port: 41641, token: TOKEN }),
      `http://100.101.102.103:41641/?token=${TOKEN}`
    );
  });

  test('令牌要被 encodeURIComponent（`+` / `/` / `=` 不能原样拼进 query）', () => {
    const built = buildRemoteAccessUrl(
      configOf({ mode: 'lan', lanAddress: '192.168.1.6', port: 3080, token: 'abc+/def==' })
    );
    assert.equal(built.ok, true, built.reason);
    assert.equal(built.url, 'http://192.168.1.6:3080/?token=abc%2B%2Fdef%3D%3D');
    assert.equal(built.url.includes('?token=abc+/def=='), false, '特殊字符必须编码，不能原样出现在 query 里');
  });

  test('appendRemoteToken：已有 query 用 &，且令牌落在 fragment 之前', () => {
    assert.equal(
      appendRemoteToken('http://192.168.1.6:3080/', TOKEN),
      `http://192.168.1.6:3080/?token=${TOKEN}`
    );
    assert.equal(
      appendRemoteToken('http://192.168.1.6:3080/?x=1', TOKEN),
      `http://192.168.1.6:3080/?x=1&token=${TOKEN}`,
      '已有 query 必须用 & 追加，不能出现两个 ?'
    );
    assert.equal(
      appendRemoteToken('http://192.168.1.6:3080/#/ui', TOKEN),
      `http://192.168.1.6:3080/?token=${TOKEN}#/ui`,
      '令牌必须在 # 之前（否则会被当成片段，发不出去）'
    );
    assert.equal(
      appendRemoteToken('http://192.168.1.6:3080/?x=1#/ui', TOKEN),
      `http://192.168.1.6:3080/?x=1&token=${TOKEN}#/ui`
    );
  });

  test('非法令牌 → ok:false + 中文原因，且原因里不带令牌值', () => {
    for (const bad of ['abc123', 'abc def ghi', 'abc!defgh', '中文令牌abcdefgh']) {
      const built = assertUrlFailed(
        configOf({ mode: 'lan', lanAddress: '192.168.1.6', port: 3080, token: bad }),
        '访问令牌只允许'
      );
      assert.equal(built.reason, REMOTE_TOKEN_INVALID_REASON, '原因就是那条规则说明，不拼接别的上下文');
      assert.equal(built.reason.includes(bad), false, `原因里绝不能回显令牌值：${JSON.stringify(bad)}`);
      assert.equal(built.url, '', '失败必须 fail-closed');
    }
    // 三种方式一致：ipv6 / tailscale 也不会因为"地址对了"就放过非法令牌
    assertUrlFailed(configOf({ mode: 'ipv6', ipv6Address: '2409:8a20::1', port: 3080, token: 'short' }), '访问令牌只允许');
    assertUrlFailed(
      configOf({ mode: 'tailscale', tailscaleHost: '100.101.102.103', port: 41641, token: 'bad token!!' }),
      '访问令牌只允许'
    );
  });

  test('cloudflare / manual 不吃 token（地址自带参数，残留令牌不污染手填地址）', () => {
    assertUrl(
      configOf({ mode: 'cloudflare', cloudflareHost: 'xxx.trycloudflare.com', token: TOKEN }),
      'https://xxx.trycloudflare.com/'
    );
    assertUrl(
      configOf({ mode: 'manual', manualUrl: 'https://dsh.example.com/?token=abc', token: TOKEN }),
      'https://dsh.example.com/?token=abc'
    );
    // 手动方式连"非法令牌"都不该影响它（token 没有该字段）
    assertUrl(configOf({ mode: 'manual', manualUrl: 'https://dsh.example.com/', token: 'bad token' }), 'https://dsh.example.com/');
  });

  test('normalizeRemoteAccessConfig：缺 token / 非字符串 / 坏 JSON 一律回落空串', () => {
    assert.equal(normalizeRemoteAccessConfig('').token, '', '空串配置 → 空令牌');
    assert.equal(normalizeRemoteAccessConfig('{"mode":"lan"}').token, '', '旧数据没有 token 字段');
    assert.equal(normalizeRemoteAccessConfig('{"mode":"lan","token":42}').token, '', '非字符串按空串');
    assert.equal(normalizeRemoteAccessConfig('{"mode":"lan","token":null}').token, '');
    assert.equal(normalizeRemoteAccessConfig('not json').token, '', '坏 JSON 也回落（不抛）');
    assert.equal(
      normalizeRemoteAccessConfig(`{"mode":"lan","token":"  ${TOKEN}  "}`).token,
      TOKEN,
      '令牌去首尾空白'
    );
    assert.equal(normalizeRemoteAccessConfig('{"mode":"lan","token":""}').token, '');
  });

  test('maskRemoteToken：前 4 + … + 后 4；短令牌一律 ***', () => {
    assert.equal(maskRemoteToken(TOKEN), 'AbCd…6789');
    assert.equal(maskRemoteToken('a'.repeat(12)), 'aaaa…aaaa');
    assert.equal(maskRemoteToken('a'.repeat(11)), '***', '小于 12 位一律打码成 ***');
    assert.equal(maskRemoteToken('abc'), '***');
    assert.equal(maskRemoteToken(''), '***');
    assert.equal(maskRemoteToken('   '), '***');
    assert.equal(maskRemoteToken(undefined), '***', '非字符串也不抛');
    const masked = maskRemoteToken(TOKEN);
    assert.equal(masked.includes(TOKEN), false, '打码串不能包含完整令牌');
    assert.equal(masked.length, 9, '4 + 1 + 4');
  });

  test('打码后的值永远不会被当成令牌拼进地址（mask 只用于展示）', () => {
    const masked = maskRemoteToken(TOKEN);
    const built = buildRemoteAccessUrl(
      configOf({ mode: 'lan', lanAddress: '192.168.1.6', port: 3080, token: masked })
    );
    // `AbCd…6789` 含 `…`（非允许字符）→ 必须被拒，而不是"看起来像令牌就放行"
    assert.equal(built.ok, false, '打码串不是合法令牌');
    assert.equal(built.url, '');
    assert.ok(built.reason.includes('访问令牌只允许'));
  });
});
