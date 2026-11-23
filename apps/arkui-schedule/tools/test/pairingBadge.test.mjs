// mod-pairing-badge-pin-guard（D3）：徽章 = 实例的 pin × reachable × scheme，面板不再内联映射。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const PANE_ETS = resolve(HERE, '../../entry/src/main/ets/pages/panes/InstancesPane.ets');
const BADGE_TS = resolve(HERE, '../../entry/src/main/ets/model/pairingBadge.ts');

const badge = await import('../.build/model/pairingBadge.js');
const payload = await import('../.build/model/pairingPayload.js');
const paneSrc = readFileSync(PANE_ETS, 'utf8');
const badgeSrc = readFileSync(BADGE_TS, 'utf8');

const { badgeOf, canShowFingerprint } = badge;
const {
  PAIRED_UNREACHABLE_WORDING, PAIRED_UNPROBED_WORDING,
  UNPAIRED_REACHABLE_WORDING, UNPAIRED_UNREACHABLE_WORDING, UNPAIRED_UNPROBED_WORDING
} = badge;

const PIN = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');
const CAPS = { webUI: true, rpc: false, chatExport: false, lease: false, sessionCreate: false };

/** 造一条合法实例；overrides 只覆盖关心的字段。 */
function instance(overrides = {}) {
  return {
    id: 'inst-a1b2c3d4e5f60718',
    name: '书房电脑',
    url: 'https://192.168.1.6:44996',
    mode: 'manual',
    reachable: 'ok',
    capabilities: CAPS,
    ...overrides
  };
}

describe('A. 纯模型 3×3 徽章表（pin × reachable）', () => {
  test('A1 pinned + ok / fail / unknown → 三条 pinned 文案逐字节不变', () => {
    assert.equal(badgeOf(instance({ tlsFingerprint: PIN, reachable: 'ok' })),
      payload.PAIRING_REACHABLE_WORDING);
    assert.equal(badgeOf(instance({ tlsFingerprint: PIN, reachable: 'fail' })),
      PAIRED_UNREACHABLE_WORDING);
    assert.equal(badgeOf(instance({ tlsFingerprint: PIN, reachable: 'unknown' })),
      PAIRED_UNPROBED_WORDING);
  });

  test('A2 unpinned（无指纹）三态 → 一律未配对口径', () => {
    assert.equal(badgeOf(instance({ reachable: 'ok' })), UNPAIRED_REACHABLE_WORDING);
    assert.equal(badgeOf(instance({ reachable: 'fail' })), UNPAIRED_UNREACHABLE_WORDING);
    assert.equal(badgeOf(instance({ reachable: 'unknown' })), UNPAIRED_UNPROBED_WORDING);
    for (const text of [UNPAIRED_REACHABLE_WORDING, UNPAIRED_UNREACHABLE_WORDING, UNPAIRED_UNPROBED_WORDING]) {
      assert.equal(text.includes('已配对'), false, `未配对文案不得含「已配对」：${text}`);
    }
  });

  test('A3 http 明文行即便误存合法 pin 也强制未配对口径（防御），且不显示指纹行', () => {
    for (const [reachable, expected] of [
      ['ok', UNPAIRED_REACHABLE_WORDING],
      ['fail', UNPAIRED_UNREACHABLE_WORDING],
      ['unknown', UNPAIRED_UNPROBED_WORDING]
    ]) {
      const row = instance({ url: 'http://192.168.137.1:44996', tlsFingerprint: PIN, reachable });
      const text = badgeOf(row);
      assert.equal(text, expected);
      assert.equal(text.includes('已配对'), false, 'http 行绝不能说「已配对」');
      assert.equal(text.includes('尚未校验证书'), false, 'http 行绝不能说「尚未校验证书」');
      assert.equal(canShowFingerprint(row), false, 'http 行不得展示「已固定指纹」');
    }
  });

  test('A4 坏指纹 / 脏可达值 fail-closed 到未配对 / unknown', () => {
    assert.equal(badgeOf(instance({ tlsFingerprint: 'AA:BB', reachable: 'ok' })),
      UNPAIRED_REACHABLE_WORDING);
    assert.equal(canShowFingerprint(instance({ tlsFingerprint: 'AA:BB' })), false);
    assert.equal(badgeOf(instance({ tlsFingerprint: PIN, reachable: 'weird' })),
      PAIRED_UNPROBED_WORDING);
    assert.equal(badgeOf(instance({ reachable: 'weird' })), UNPAIRED_UNPROBED_WORDING);
  });
});

describe('B. 面板源码形状：不再内联映射、不重复 pinned 文案', () => {
  test('B1 面板只调用纯函数，不自己算徽章', () => {
    assert.match(paneSrc, /import \{ badgeOf, canShowFingerprint \} from '\.\.\/\.\.\/model\/pairingBadge';/);
    assert.match(paneSrc, /badgeOf\(full\)/, '徽章必须经 badgeOf(真身)');
    assert.match(paneSrc, /canShowFingerprint\(full\)/, '指纹行必须与徽章共用同一判据');
    assert.equal(/PAIRING_REACHABLE_WORDING/.test(paneSrc), false,
      '面板不得再 import / 引用 pinned 文案常量');
    assert.equal(/view\.reachable === 'ok'[\s\S]{0,120}PAIRING_REACHABLE_WORDING/.test(paneSrc), false,
      '旧的内联三元映射必须移除');
  });

  test('B2 pinned 文案只有一份权威，面板零复制', () => {
    for (const text of [payload.PAIRING_REACHABLE_WORDING, PAIRED_UNREACHABLE_WORDING, PAIRED_UNPROBED_WORDING]) {
      assert.equal(paneSrc.includes(text), false, `面板不得复制 ${text}`);
    }
    // 成功文案的权威仍在 pairingPayload.ts：pairingBadge 引用常量，不复制字面量。
    assert.match(badgeSrc, /import \{ PAIRING_REACHABLE_WORDING \} from '\.\/pairingPayload';/);
    assert.equal(badgeSrc.includes(payload.PAIRING_REACHABLE_WORDING), false,
      '纯徽章模型不得复制成功文案字面量');
    assert.equal(payload.PAIRING_REACHABLE_WORDING, '已配对（地址可达，尚未校验证书）',
      '旧 pinned 文案逐字节不变');
    assert.equal(badgeSrc.includes(PAIRED_UNREACHABLE_WORDING), true);
    assert.equal(badgeSrc.includes(PAIRED_UNPROBED_WORDING), true);
    const payloadSrc = readFileSync(resolve(HERE, '../../entry/src/main/ets/model/pairingPayload.ts'), 'utf8');
    assert.equal((payloadSrc.split(payload.PAIRING_REACHABLE_WORDING).length - 1), 1,
      '成功文案字面量在权威模型里恰好一份');
  });

  test('B3 无 pin / http 行没有任何渲染路径能打印「已配对」', () => {
    assert.equal(/\b已配对\b/.test(paneSrc), false, '面板源码里不得残留任何「已配对」字面量');
    assert.match(badgeSrc, /if \(canShowFingerprint\(instance\)\) \{/,
      '只有 canShowFingerprint 为真才走 pinned 分支');
    assert.match(badgeSrc, /isHttpUrl\(instance\.url\)/,
      'http scheme 必须在判据里被显式拒绝');
  });
});
