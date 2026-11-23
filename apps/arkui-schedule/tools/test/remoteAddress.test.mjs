// mod-remote-page-webview：model/remoteAddress.ts 纯函数门禁。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

const A = await import('../.build/model/remoteAddress.js');
const {
  normalizeHostPort, classifyTransport, hostPortKey, transportChip, TRANSPORT_LABELS
} = A;

describe('A. normalizeHostPort 归一规则', () => {
  test('A1 LAN IPv4 / host:port / 完整 URL 都归一为 origin', () => {
    for (const input of ['192.168.1.6:3080', 'http://192.168.1.6:3080/?token=SECRET',
      { host: '192.168.1.6', port: 3080 }]) {
      const r = normalizeHostPort(input);
      assert.equal(r.ok, true, `input=${JSON.stringify(input)}`);
      assert.deepEqual([r.host, r.port, r.scheme, r.url],
        ['192.168.1.6', 3080, 'http', 'http://192.168.1.6:3080']);
      assert.equal(r.url.includes('SECRET'), false, '归一结果不携带 query/token');
    }
  });

  test('A2 方括号 IPv6 输入 → 无括号存储 + 打印时补方括号', () => {
    const r = normalizeHostPort('https://[FD7A:115C:A1E0::1]:44996/');
    assert.equal(r.ok, true);
    assert.equal(r.host, 'fd7a:115c:a1e0::1', 'IPv6 内部无括号、小写十六进制');
    assert.equal(r.port, 44996);
    assert.equal(r.url, 'https://[fd7a:115c:a1e0::1]:44996');
    const obj = normalizeHostPort({ host: 'fd7a:115c:a1e0::1', port: 44996, scheme: 'https' });
    assert.equal(obj.url, r.url, '裸 IPv6 字段与方括号 URL 走同一结果');
    assert.equal(hostPortKey(r.host, r.port), '[fd7a:115c:a1e0::1]:44996', '键也带方括号，消歧');
  });

  test('A3 回环 ::1 与 IPv6 形态校验', () => {
    const loop = normalizeHostPort('[::1]:44996');
    assert.equal(loop.ok, true);
    assert.equal(loop.host, '::1');
    assert.equal(loop.url, 'http://[::1]:44996');
    assert.equal(normalizeHostPort('[gggg::1]:44996').ok, false);
    assert.equal(normalizeHostPort('[]:44996').ok, false);
  });

  test('A4 DNS 结尾点归一 + 大写转小写', () => {
    const r = normalizeHostPort('https://ABC.TS.NET.:443/');
    assert.equal(r.ok, true);
    assert.equal(r.host, 'abc.ts.net', '去一个尾部点并转小写');
    assert.equal(r.url, 'https://abc.ts.net:443');
  });

  test('A5 zone-id 一律拒绝（不猜网卡）', () => {
    for (const input of ['[fe80::1%eth0]:44996', '[FD7A::1%25eth0]:44996',
      { host: 'fe80::1%eth0', port: 44996 }]) {
      const r = normalizeHostPort(input);
      assert.equal(r.ok, false, `zone-id 必须拒绝：${JSON.stringify(input)}`);
      assert.match(r.reason, /网卡后缀/);
    }
  });

  test('A6 端口边界：0 / 65536 / 非数字 / 缺失全拒绝，1 与 65535 通过', () => {
    for (const p of [0, 65536, -1, 1.5, 'abc', '0', '65536', undefined]) {
      const r = normalizeHostPort({ host: '192.168.1.6', port: p });
      assert.equal(r.ok, false, `port=${String(p)} 必须拒绝`);
      assert.match(r.reason, /端口/);
    }
    assert.equal(normalizeHostPort({ host: '192.168.1.6', port: 1 }).ok, true);
    assert.equal(normalizeHostPort({ host: '192.168.1.6', port: 65535 }).ok, true);
    assert.equal(normalizeHostPort('192.168.1.6:3080:80').ok, false, '双端口不可猜');
  });

  test('A7 非 http(s) scheme 与 userinfo 拒绝；空 host 拒绝', () => {
    for (const input of ['ftp://1.2.3.4:21', 'ws://1.2.3.4:80', 'javascript://x',
      'http://user:pass@host:1234', { host: '', port: 3080 }, '   ']) {
      assert.equal(normalizeHostPort(input).ok, false, `必须拒绝：${JSON.stringify(input)}`);
    }
  });
});

describe('B. classifyTransport precedence 矩阵', () => {
  const kind = (host) => classifyTransport(host, 44996);

  test('B1 Tailscale IPv4 边界（/10 两端在内，紧邻外不在）', () => {
    assert.equal(kind('100.64.0.0'), 'tailscale');
    assert.equal(kind('100.127.255.255'), 'tailscale');
    assert.equal(kind('100.63.255.255'), 'manual');
    assert.equal(kind('100.128.0.0'), 'manual');
    assert.equal(kind('100.101.102.103'), 'tailscale', 'Tailscale 胜过普通私网 IP');
  });

  test('B2 Tailscale IPv6 /48 与 *.ts.net', () => {
    assert.equal(kind('fd7a:115c:a1e0::1'), 'tailscale');
    assert.equal(kind('FD7A:115C:A1E0:FFFF::9'), 'tailscale', '大写也命中 /48');
    assert.equal(kind('fd7a:115c:a1e1::1'), 'ipv6', '前缀外一位即普通 IPv6');
    assert.equal(kind('abc.ts.net'), 'tailscale');
    assert.equal(kind('ts.net'), 'tailscale');
    assert.equal(kind('abc.ts.net.evil.com'), 'manual', '不能靠子串嗅探');
  });

  test('B3 IPv6 / LAN IPv4 / loopback / manual', () => {
    assert.equal(kind('2409:8a20::1'), 'ipv6');
    assert.equal(kind('::1'), 'manual', '回环选 manual（见模型头注释）');
    assert.equal(kind('127.0.0.1'), 'manual');
    for (const h of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.6', '169.254.1.2']) {
      assert.equal(kind(h), 'lan', `${h} 应为 lan`);
    }
    assert.equal(kind('172.32.0.1'), 'manual', '172/12 边界外');
    assert.equal(kind('8.8.8.8'), 'manual');
    assert.equal(kind('example.com'), 'manual');
  });

  test('B4 precedence：Tailscale IPv4 不被 RFC1918 抢走；tailnet IPv6 不被 ipv6 抢走', () => {
    const r = normalizeHostPort('https://[FD7A:115C:A1E0::9]:44996/');
    assert.equal(classifyTransport(r.host, r.port), 'tailscale');
    const v4 = normalizeHostPort('http://100.64.0.1:3080/');
    assert.equal(classifyTransport(v4.host, v4.port), 'tailscale');
    assert.equal(transportChip(classifyTransport(v4.host, v4.port)), TRANSPORT_LABELS['tailscale']);
  });

  test('B5 chip 文案四格齐全，未知回落 manual', () => {
    assert.deepEqual(Object.values(TRANSPORT_LABELS), ['局域网', 'IPv6', 'Tailscale', '手动']);
    assert.equal(transportChip('bogus'), '手动');
  });
});
