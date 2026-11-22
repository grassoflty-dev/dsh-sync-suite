// mod-instances-pairing（平板侧手动配对）的 Node 单测。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖四组：
//   P1–P5 纯解析器：两种载荷形态 / 每个 typed 码 / IPv6 方括号 / 指纹归一 / token 零回显；
//   P6    TOFU 钉住：不同指纹拒绝且不覆盖 pin，同指纹更新地址，pin 跨持久化存活；
//   P7    UI / 源码形状：粘贴入口与标记上屏、两步公告同意保持原样、只有一份 URL 拼装、无 console.*。
//
// 这些用例在「今天的代码」上必然失败：`.build/model/pairingPayload.js` 尚不存在，
// 且 InstancesPane 里没有任何粘贴入口 / 已固定指纹标记。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

// tsc 以 bundler 模式发出无扩展名的相对 import；Node ESM 需要 `.js`。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  }
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../entry/src/main/ets');

const P = await import('../.build/model/pairingPayload.js');
const I = await import('../.build/model/instances.js');

function src(relative) {
  return readFileSync(resolve(SRC, relative), 'utf8');
}

/** 注释可以提到 `http://` / token 字样，只有真实调用 / 字面量才算违规。 */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const FP_A = 'aa'.repeat(32);
const FP_B = 'bb'.repeat(32);
const FP_A_CANON = Array.from({ length: 32 }, () => 'AA').join(':');

/** 电脑插件 `formatPairingText()` 的真实输出（含 4 位 FNV 校验和）。 */
const PLUGIN_COMPACT =
  'DSHDOTS1|1|gwl-pc|lan|192.168.1.6|44996|AbCdEfGhIjKlMnOpQrStUvWxYz012345|' +
  'AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA||1ffd4f6b';

function payload(overrides = {}) {
  return {
    v: 1,
    instanceId: 'gwl-pc',
    transport: 'lan',
    host: '192.168.1.6',
    port: 44996,
    token: TOKEN,
    tlsFingerprint: FP_A,
    announceRef: '',
    ...overrides
  };
}

function json(overrides = {}) {
  return JSON.stringify(payload(overrides));
}

// ------------------------------------------------------------------ P1–P5 解析器

describe('P 纯解析器：两种形态 + typed 码 + 归一', () => {
  test('P1 规范 JSON 与插件生成的 DSHDOTS1|… 紧凑串都接受，且归一成同一载荷', () => {
    const viaJson = P.parsePairingPayload(json());
    assert.equal(viaJson.ok, true, JSON.stringify(viaJson));
    assert.equal(viaJson.code, 'ok');
    assert.deepEqual(viaJson.payload, {
      v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
      token: TOKEN, tlsFingerprint: FP_A_CANON, announceRef: ''
    });

    const viaCompact = P.parsePairingPayload(PLUGIN_COMPACT);
    assert.equal(viaCompact.ok, true, JSON.stringify(viaCompact));
    assert.deepEqual(viaCompact.payload, viaJson.payload, '两端同一 schema，逐字段相等');
    assert.equal(P.formatPairingText(payload()), PLUGIN_COMPACT, '回写紧凑串与插件字节一致');
  });

  test('P2 每个坏字段映射到唯一 typed 码（绝不混成一条「格式错误」）', () => {
    const badChecksum = `${PLUGIN_COMPACT.slice(0, -1)}0`;
    const cases = [
      ['E_PAIRING_MALFORMED', '{}'],
      ['E_PAIRING_MALFORMED', json({ extra: 'x' })],
      ['E_PAIRING_MALFORMED', 'this-is-not-json'],
      ['E_PAIRING_MALFORMED', ''],
      ['E_PAIRING_MALFORMED', 'garbage'],
      ['E_PAIRING_MALFORMED', badChecksum],
      ['E_PAIRING_VERSION', json({ v: 2 })],
      ['E_PAIRING_TRANSPORT', json({ transport: 'wifi' })],
      ['E_PAIRING_HOST', json({ host: 'http://192.168.1.6/' })],
      ['E_PAIRING_HOST', json({ host: '192.168.1.6:44996' })],
      ['E_PAIRING_PORT', json({ port: 0 })],
      ['E_PAIRING_PORT', json({ port: 65536 })],
      ['E_PAIRING_PORT', json({ port: 1.5 })],
      ['E_PAIRING_TOKEN', json({ token: 'short' })],
      ['E_PAIRING_FINGERPRINT', json({ tlsFingerprint: 'AA:BB' })]
    ];
    for (const [code, text] of cases) {
      const result = P.parsePairingPayload(text);
      assert.equal(result.ok, false, `应拒绝：${text}`);
      assert.equal(result.code, code, `typed 码不符：${text}`);
      assert.equal(result.payload, null, '失败时不得带出半截载荷');
    }
  });

  test('P3 IPv6 自动加方括号、展开零段并小写；scheme-less host 小写', () => {
    const parsed = P.parsePairingPayload(json({
      transport: 'ipv6', host: '2001:DB8:0:0:0:0:0:1'
    }));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.payload.host, '[2001:db8::1]');

    const bracketed = P.parsePairingPayload(json({ transport: 'ipv6', host: '[FE80::1]' }));
    assert.equal(bracketed.ok, true);
    assert.equal(bracketed.payload.host, '[fe80::1]');

    const named = P.parsePairingPayload(json({ transport: 'tailscale', host: 'GWL-PC.TS.NET' }));
    assert.equal(named.ok, true);
    assert.equal(named.payload.host, 'gwl-pc.ts.net');
    assert.equal(P.normalisePairingHost('192.168.1.6:44996', 'lan').ok, false, 'host 不得自带端口');
  });

  test('P4 指纹接受 64 位十六进制或冒号分隔，统一输出大写 32 段', () => {
    const plain = P.parsePairingPayload(json({ tlsFingerprint: FP_A.toUpperCase() }));
    const colon = P.parsePairingPayload(json({ tlsFingerprint: FP_A_CANON.toLowerCase() }));
    assert.equal(plain.ok, true);
    assert.equal(colon.ok, true);
    assert.equal(plain.payload.tlsFingerprint, FP_A_CANON);
    assert.equal(colon.payload.tlsFingerprint, FP_A_CANON);
    assert.equal(P.fingerprintPrefix(FP_A_CANON), 'AA:AA:AA:AA:AA:AA…', '展示只给前缀');
  });

  test('P5 任何错误字符串都不含 token（也不含 host / 指纹值）', () => {
    const distinctive = 'DISTINCTIVE_SECRET_VALUE_0123456789';
    const inputs = [
      json({ instanceId: 'BAD' }),
      json({ v: 2 }),
      json({ transport: 'wifi' }),
      json({ host: 'http://192.168.1.6/' }),
      json({ port: 0 }),
      json({ tlsFingerprint: 'AA:BB' }),
      json({ token: 'abcdefgh' }),
      `${PLUGIN_COMPACT.slice(0, -1)}0`
    ];
    for (const text of inputs) {
      const result = P.parsePairingPayload(text);
      assert.equal(result.ok, false);
      const printed = JSON.stringify(result);
      for (const secret of [TOKEN, distinctive, '192.168.1.6', FP_A]) {
        assert.equal(printed.includes(secret), false, `错误回显了敏感值：${printed}`);
      }
    }
  });
});

// ------------------------------------------------------------------ P6 TOFU 钉住

describe('TOFU：同 instanceId 指纹必须一致', () => {
  test('P6-1 首次添加钉住指纹；同 id 不同指纹逐字拒绝且不覆盖 pin / 地址', () => {
    const first = P.addPairedInstance([], json());
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.action, 'added');
    assert.equal(first.code, 'ok');
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].pairingInstanceId, 'gwl-pc');
    assert.equal(first.items[0].tlsFingerprint, FP_A_CANON);
    assert.equal(first.items[0].url, 'http://192.168.1.6:44996');
    const before = JSON.stringify(first.items);

    const conflict = P.addPairedInstance(first.items, json({
      tlsFingerprint: FP_B, host: '192.168.1.7', port: 45000
    }));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'E_PAIRING_FINGERPRINT_MISMATCH');
    assert.equal(conflict.reason, P.PAIRING_FINGERPRINT_MISMATCH_WORDING);
    assert.match(conflict.reason, /换了机器或中间人/);
    assert.match(conflict.reason, /删除旧实例再重新配对/);
    assert.deepEqual(conflict.items, [], '冲突路径不产出任何新表');
    assert.equal(JSON.stringify(first.items), before, '旧 pin 与旧地址逐字不变');
  });

  test('P6-2 同 id 同指纹只更新地址 / 端口 / 令牌，pin 与行数不变', () => {
    const first = P.addPairedInstance([], json());
    const updated = P.addPairedInstance(first.items, json({
      host: '192.168.1.8', port: 45001, token: 'ZyXwVuTsRqPoNmLkJiHgFeDcBa098765'
    }));
    assert.equal(updated.ok, true);
    assert.equal(updated.action, 'updated');
    assert.equal(updated.items.length, 1, '不产生第二条记录');
    assert.equal(updated.items[0].url, 'http://192.168.1.8:45001');
    assert.equal(updated.items[0].tlsFingerprint, first.items[0].tlsFingerprint, 'pin 未被改写');
    assert.equal(updated.items[0].pairingInstanceId, 'gwl-pc');
    assert.equal(updated.items[0].token, 'ZyXwVuTsRqPoNmLkJiHgFeDcBa098765', '轮换后的令牌随载荷更新');
  });

  test('P6-3 pin 跨信封持久化与渲染前缀存活；IPv6 配对走同一地址出口', () => {
    const first = P.addPairedInstance([], json({
      transport: 'ipv6', host: '2001:DB8::1', port: 44996
    }));
    assert.equal(first.ok, true);
    assert.equal(first.items[0].url, 'http://[2001:db8::1]:44996');
    assert.equal(first.items[0].mode, 'ipv6');

    const round = I.decodeInstances(I.encodeInstances(first.items));
    assert.equal(round.ok, true);
    assert.equal(round.items[0].tlsFingerprint, FP_A_CANON);
    assert.equal(round.items[0].pairingInstanceId, 'gwl-pc');
    const view = I.redactInstance(round.items[0]);
    assert.equal(view.fingerprintPrefix, 'AA:AA:AA:AA:AA:AA…');
    assert.equal(JSON.stringify(view).includes(TOKEN), false, '渲染视图没有令牌');
  });
});

// ------------------------------------------------------------------ P7 接线 / 源码形状

describe('P7 UI 与源码形状（静态守卫）', () => {
  const PAGE = src('pages/panes/InstancesPane.ets');
  const STORE = src('services/instanceStore.ets');
  const MODEL = src('model/pairingPayload.ts');
  const INSTANCES = src('model/instances.ts');
  const REFRESH = src('model/remoteAnnounceRefresh.ts');

  test('P7-1 粘贴字段 + 添加实例按钮 + typed 错误区 + 已固定指纹标记都在实例页', () => {
    assert.match(PAGE, /TextInput\(\{ text: this\.pairingText, placeholder: 'DSHDOTS1\|… 或 \{\…\} 配对 JSON' \}\)/,
      '必须有粘贴配对串的输入框');
    assert.match(PAGE, /label: '添加实例'[\s\S]{0,200}this\.addByPairing\(\)/, '粘贴面板的添加按钮调用配对落表');
    assert.match(PAGE, /Text\(this\.pairingError\)/, 'typed 错误中文文案必须上屏');
    assert.match(PAGE, /已固定指纹/, '钉过指纹的行必须有可见标记');
    assert.match(PAGE, /view\.fingerprintPrefix/, '行内只展示指纹前缀');
    assert.match(PAGE, /instanceStore\.addByPairing\(/, '页面必须走 store 的 TOFU 门禁，不能自己写表');
  });

  test('P7-2 两步公告同意流程保持原样（手动配对是另一条路径）', () => {
    for (const needle of [
      'remoteAnnounceRefreshService.refresh(', 'confirmFirstPairing(', 'FIRST_PAIRING_WORDING',
      'FIRST_PAIRING_DETAIL', 'view.reachable === \'fail\''
    ]) {
      assert.ok(PAGE.includes(needle), `公告两步流程不得被配对路径替换：${needle}`);
    }
    assert.match(REFRESH, /export function completeRefresh\(/, '公告的显式确认出口仍在');
  });

  test('P7-3 只有一份 URL 拼装；新代码没有 console.* 回显载荷 / 令牌', () => {
    const modelCode = codeOnly(MODEL);
    assert.match(modelCode, /announcementBaseUrl\(\{ scheme: 'http', host: innerHost, port: payload\.port \}\)/,
      '必须复用 scheme/host/port 的唯一 URL 出口');
    assert.equal(/[`'"][^`'"\n]*:\/\/\$\{/.test(modelCode), false, '配对模型不得写第二份 URL 拼装');
    for (const [name, text] of [
      ['model/pairingPayload.ts', MODEL], ['services/instanceStore.ets', STORE],
      ['pages/panes/InstancesPane.ets', PAGE], ['model/instances.ts', INSTANCES]
    ]) {
      assert.equal(/console\./.test(codeOnly(text)), false, `${name} 不得用 console.* 打印载荷 / 令牌`);
    }
  });

  test('P7-4 直连，无网关：配对 transport 只映射三种直连方式', () => {
    assert.match(MODEL, /REMOTE_MODE_TAILSCALE/);
    assert.match(MODEL, /REMOTE_MODE_LAN/);
    assert.match(MODEL, /REMOTE_MODE_IPV6/);
    assert.equal(/REMOTE_MODE_CLOUDFLARE|REMOTE_MODE_UU|gateway|网关/.test(codeOnly(MODEL)), false,
      '手动配对不得产生网关 / 隧道方式');
  });
});

// ------------------------------------------------------------------ P8 更新路径 id 稳定性

describe('P8 配对更新保留实例 id（公告 pin 的键不能被换掉）', () => {
  /**
   * 签名公告 pin 表的接缝：复刻 `services/remoteAnnounceStore.ets` 的 setPin/getPin 语义 ——
   * pin 以**实例 id**（`inst-<hex16>`，而不是 URL / 端口 / instanceId）为键。纯内存镜像，
   * 不依赖 @kit.CryptoArchitectureKit / PersistentStorage，Node 单测可直接断言 pin 是否仍解析。
   */
  function announcePinSeam() {
    const pins = {};
    return {
      setPin(id, key) { pins[id] = key; },
      getPin(id) { return Object.prototype.hasOwnProperty.call(pins, id) ? pins[id] : ''; }
    };
  }

  test('P8-1 同 instanceId + 同指纹更新：id 不变、能力集按该 id 派生、公告 pin 仍解析', () => {
    const first = P.addPairedInstance([], json());
    assert.equal(first.ok, true, JSON.stringify(first));
    const oldId = first.items[0].id;
    const announceKey = 'a1'.repeat(32);
    const pins = announcePinSeam();
    pins.setPin(oldId, announceKey);
    assert.equal(pins.getPin(oldId), announceKey, '前置：公告 pin 以原实例 id 为键');

    const updated = P.addPairedInstance(first.items, json({
      host: '192.168.1.8', port: 45001, token: 'ZyXwVuTsRqPoNmLkJiHgFeDcBa098765'
    }));
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.action, 'updated');
    assert.equal(updated.items.length, 1, '只更新一行，不新增记录');
    const row = updated.items[0];
    assert.equal(row.id, oldId, '配对更新不得按新 URL 重算实例 id');
    assert.deepEqual(row.capabilities, I.deriveCapabilities(oldId), '能力集必须由保留的 id 派生');
    assert.equal(pins.getPin(row.id), announceKey,
      '公告 pin 仍用更新行的 id 解析，不会在读侧变成「机器换了身份」');
    assert.equal(row.url, 'http://192.168.1.8:45001', '地址仍随载荷更新');
    assert.equal(row.token, 'ZyXwVuTsRqPoNmLkJiHgFeDcBa098765', '令牌仍随载荷更新');
    assert.equal(row.tlsFingerprint, first.items[0].tlsFingerprint, '证书 TOFU pin 未改写');
  });

  test('P8-2 新 instanceId 才重新派生 id，绝不复用旧行的 id', () => {
    const first = P.addPairedInstance([], json());
    const second = P.addPairedInstance(first.items, json({
      instanceId: 'new-pc', host: '192.168.1.9', port: 45002
    }));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.action, 'added');
    assert.equal(second.items.length, 2, '新实例必须新增一行，而不是覆盖旧实例');
    const added = second.items.find((item) => item.pairingInstanceId === 'new-pc');
    assert.ok(added, '新增行必须带新 instanceId');
    assert.equal(added.id, I.instanceIdFromUrl('http://192.168.1.9:45002'),
      '新增路径仍按新 URL 派生 id');
    assert.notEqual(added.id, first.items[0].id, '新实例不得复用旧 id');
  });

  test('P8-3 同 instanceId + 不同指纹仍逐字拒绝，零写入', () => {
    const first = P.addPairedInstance([], json());
    const updated = P.addPairedInstance(first.items, json({ host: '192.168.1.8', port: 45001 }));
    assert.equal(updated.ok, true);
    const before = JSON.stringify(updated.items);
    const conflict = P.addPairedInstance(updated.items, json({
      tlsFingerprint: FP_B, host: '192.168.1.7', port: 45000
    }));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'E_PAIRING_FINGERPRINT_MISMATCH');
    assert.equal(conflict.reason, P.PAIRING_FINGERPRINT_MISMATCH_WORDING);
    assert.deepEqual(conflict.items, [], '拒绝路径不产出任何新表');
    assert.equal(JSON.stringify(updated.items), before, '旧行的 id / pin / 地址逐字不变');
  });

  test('P8-4 源码形状：更新分支用 existing.id，只有新增分支用 instanceIdFromUrl', () => {
    const model = src('model/pairingPayload.ts');
    const updateAt = model.indexOf('if (existingIndex >= 0) {');
    const createAt = model.indexOf('const created: DsInstance = {');
    assert.ok(updateAt >= 0 && createAt > updateAt, '定位更新分支失败');
    const updateBranch = model.slice(updateAt, createAt);
    assert.match(updateBranch, /id:\s*existing\.id\s*,/, '更新行必须写 existing.id');
    assert.match(updateBranch, /capabilities:\s*deriveCapabilities\(existing\.id\)/,
      '能力集必须从 existing.id 派生');
    assert.doesNotMatch(updateBranch, /\bid:\s*id\b/, '更新行不得写刚从 URL 派生的 id');
    assert.doesNotMatch(updateBranch, /instanceIdFromUrl\s*\(/, '更新分支不得重算实例 id');
    assert.match(model.slice(0, updateAt), /const id:\s*string = instanceIdFromUrl\(check\.url\)/,
      '新增路径仍从 URL 派生 id');
  });
});
