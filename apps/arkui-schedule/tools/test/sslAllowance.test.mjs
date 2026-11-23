// mod-remote-page-webview：model/sslAllowance.ts 一次性放行状态机门禁。
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

const S = await import('../.build/model/sslAllowance.js');
const {
  SSL_ALLOWANCE_TTL_MS, grant, isAllowed, consume, clear, size, SSL_ALLOWANCE_REFUSAL_WORDING
} = S;

const KEY = '192.168.1.6:3080';
const V6 = '[fd7a:115c:a1e0::1]:44996';

describe('A. 单次使用与 TTL', () => {
  test('A1 默认 TTL 10 s；新鲜授权 isAllowed=true，consume 一次后永久 false', () => {
    assert.equal(SSL_ALLOWANCE_TTL_MS, 10_000);
    clear();
    assert.equal(grant(KEY, true, 1_000), true);
    assert.equal(isAllowed(KEY, 1_000), true);
    assert.equal(consume(KEY, 1_000), true);
    assert.equal(consume(KEY, 1_001), false, 'TTL 内第二次也必须为 false');
    assert.equal(isAllowed(KEY, 1_001), false);
  });

  test('A2 TTL 边界：now = grantedAt + TTL 即过期（不取等号）', () => {
    clear();
    grant(KEY, true, 1_000);
    assert.equal(isAllowed(KEY, 1_000 + SSL_ALLOWANCE_TTL_MS - 1), true);
    assert.equal(isAllowed(KEY, 1_000 + SSL_ALLOWANCE_TTL_MS), false);
    assert.equal(consume(KEY, 1_000 + SSL_ALLOWANCE_TTL_MS), false);
  });

  test('A3 host:port 精确绑定：换端口 / 换主机 / IPv6 不同键都不匹配', () => {
    clear();
    grant(KEY, true, 1_000);
    assert.equal(isAllowed('192.168.1.6:3081', 1_000), false);
    assert.equal(isAllowed('192.168.1.7:3080', 1_000), false);
    assert.equal(isAllowed(V6, 1_000), false);
    assert.equal(consume(KEY, 1_000), true);
  });

  test('A4 刷新式再 grant = 新的一次性放行：两轮各只消费一次', () => {
    clear();
    // 第一轮：预检通过后的放行，只放行一次握手
    assert.equal(grant(KEY, true, 1_000), true);
    assert.equal(consume(KEY, 1_000), true);
    assert.equal(consume(KEY, 1_001), false, '同一 grant 在 TTL 内第二次也必须拒绝');
    // 第二轮：RemoteControl.refresh() 在 controller.refresh() 之前重新 grant
    assert.equal(grant(KEY, true, 1_002), true, '新的 grant 必须重新放行');
    assert.equal(consume(KEY, 1_002), true);
    assert.equal(consume(KEY, 1_003), false, '新 grant 同样只能消费一次');
  });
});

describe('B. pin / 主机变更 / 有界性', () => {
  test('B1 无 pin 永不授权（grant 自己拒绝，请求根本不会发生）', () => {
    clear();
    for (const pinPresent of [false, undefined, null, 'true', 1]) {
      assert.equal(grant(KEY, pinPresent, 1_000), false, `pinPresent=${String(pinPresent)}`);
    }
    assert.equal(isAllowed(KEY, 1_000), false);
    assert.equal(size(), 0, '被拒授权不得留下条目');
  });

  test('B2 主机切换清空旧授权；同一主机换端口视为新键', () => {
    clear();
    grant(KEY, true, 1_000);
    grant(V6, true, 1_001);
    assert.equal(isAllowed(KEY, 1_001), false, '换主机后旧键必须清空');
    assert.equal(isAllowed(V6, 1_001), true);
    assert.equal(consume(V6, 1_002), true);
  });

  test('B3 有界：反复 grant 不同键不会增长到上限之外，访问时 prune', () => {
    clear();
    for (let i = 0; i < 200; i++) {
      // 同一主机不同端口不会触发「换主机清空」，专门压测上限。
      grant(`10.0.0.1:${1000 + i}`, true, 1_000);
    }
    assert.ok(size() <= 32, `条目数 ${size()} 必须 ≤32`);
    assert.equal(grant(KEY, true, 2_000), true, '过期项 prune 后新授权仍可用');
    assert.ok(size() <= 32);
    assert.equal(consume(KEY, 2_000), true);
  });

  test('B4 clear() 清空；非法 nowMs / 空键一律拒绝；拒绝文案已集中', () => {
    clear();
    grant(KEY, true, 1_000);
    clear();
    assert.equal(isAllowed(KEY, 1_000), false);
    assert.equal(size(), 0);
    assert.equal(grant('', true, 1_000), false);
    assert.equal(grant(KEY, true, Number.NaN), false);
    assert.equal(grant(KEY, true, -1), false);
    assert.equal(consume(KEY, Number.NaN), false);
    assert.match(SSL_ALLOWANCE_REFUSAL_WORDING, /已过期或已使用/);
    assert.match(SSL_ALLOWANCE_REFUSAL_WORDING, /未放行/);
  });
});
