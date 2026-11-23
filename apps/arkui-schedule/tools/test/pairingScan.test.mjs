// mod-app-pairing-qr-scan：model/pairingScan.ts 纯函数门禁（零 SDK import，Node 直测）。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖三组：
//   S1–S7 归一化：空白 / 不可见字符 / URL 包装 / 坏转义，成功时 text 必须能被粘贴路径再解析；
//   S8–S10 单源文案：非配对载荷与空串的 code / reason 逐字等于 parsePairingPayload() 的输出；
//   S11   源码守卫：没有第二套字段校验、没有第二份解析器拒绝句、扫码失败文案只有一条。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';

// tsc 以 bundler 模式发出无扩展名的相对 import；Node ESM 需要 `.js`。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

const S = await import('../.build/model/pairingScan.js');
const P = await import('../.build/model/pairingPayload.js');
const SRC = readFileSync(
  new URL('../../entry/src/main/ets/model/pairingScan.ts', import.meta.url), 'utf8');

// 用唯一解析器自己的校验和函数构造夹具，避免测试里手抄 8 位十六进制。
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const FP = Array.from({ length: 32 }, () => 'AA').join(':');
const BODY = ['1', 'gwl-pc', 'lan', '192.168.1.6', '44996', TOKEN, FP, ''].join('|');
const COMPACT = `DSHDOTS1|${BODY}|${P.pairingChecksum(BODY)}`;

/** 成功归一断言：规范串逐字节相等，且粘贴路径（同一解析器）能再次解析。 */
function expectOk(raw, label) {
  const r = S.normaliseScannedPairing(raw);
  assert.equal(r.ok, true, `${label}: ${JSON.stringify(r)}`);
  assert.equal(r.code, 'ok', label);
  assert.equal(r.reason, '', label);
  assert.equal(r.text, COMPACT, `${label}: text 必须是未重新序列化的规范串`);
  assert.equal(P.parsePairingPayload(r.text).ok, true, `${label}: text 必须能被粘贴路径再解析`);
  return r;
}

describe('S. 扫码文本归一化（纯模型）', () => {
  test('S1 干净紧凑串原样通过，text 逐字节不变', () => {
    expectOk(COMPACT, 'clean');
  });

  test('S2 首尾空白 / 换行被 trim', () => {
    expectOk(` \r\n\t${COMPACT}\n\r  `, 'surrounding');
  });

  test('S3 串内 CRLF 与 TAB 被剥掉', () => {
    const broken = COMPACT.replace('|1|', '|\r\n1|').replace('|lan|', '|\tlan\t|');
    expectOk(broken, 'internal-crlf-tab');
  });

  test('S4 UTF-8 BOM 与零宽字符（U+200B–U+200D / U+FEFF）被剥掉', () => {
    expectOk(`\uFEFF\u200B${COMPACT}\u200C\u200D\uFEFF`, 'bom-zero-width');
  });

  test('S5 整串 URL-encoded 只解码一次', () => {
    expectOk(encodeURIComponent(COMPACT), 'url-encoded');
  });

  test('S6 载荷在 URL query（p / payload / text）与 fragment 中都能抽出', () => {
    for (const key of ['p', 'payload', 'text']) {
      expectOk(`dshdots://pair?${key}=${encodeURIComponent(COMPACT)}`, `query-${key}`);
    }
    expectOk(`https://host/path#${encodeURIComponent(COMPACT)}`, 'fragment');
  });

  test('S7 扫描 URL 不是配对载荷 ⇒ E_PAIRING_MALFORMED，reason 与解析器逐字相同', () => {
    const direct = S.normaliseScannedPairing('https://example.com');
    const fromParser = P.parsePairingPayload('https://example.com');
    assert.equal(direct.ok, false);
    assert.equal(direct.code, 'E_PAIRING_MALFORMED');
    assert.equal(direct.reason, fromParser.reason, '单一事实来源：不许抄一份拒绝句');

    // URL 包装后仍然退回同一句话（抽出来的还是普通网址，交给同一个解析器）
    const wrapped = S.normaliseScannedPairing(
      `dshdots://pair?p=${encodeURIComponent('https://example.com')}`);
    assert.equal(wrapped.ok, false);
    assert.equal(wrapped.code, 'E_PAIRING_MALFORMED');
    assert.equal(wrapped.reason, fromParser.reason);
  });

  test('S8 空串 / 非字符串与解析器同码同文案', () => {
    for (const raw of ['', '   \r\n ', null, 42]) {
      const got = S.normaliseScannedPairing(raw);
      const expected = P.parsePairingPayload(typeof raw === 'string' ? raw.trim() : '');
      assert.equal(got.ok, false);
      assert.equal(got.code, expected.code);
      assert.equal(got.reason, expected.reason);
    }
  });

  test('S9 坏百分号转义不抛异常，原样交给解析器并透传其 typed 结果', () => {
    const raw = '%E0%A4%A';
    assert.doesNotThrow(() => S.normaliseScannedPairing(raw));
    const got = S.normaliseScannedPairing(raw);
    const expected = P.parsePairingPayload(raw);
    assert.equal(got.ok, false);
    assert.equal(got.code, expected.code);
    assert.equal(got.reason, expected.reason);
  });

  test('S10 校验和错的紧凑串：code / reason 逐字来自解析器（非「不认识」兜底）', () => {
    const bad = `${COMPACT.slice(0, -1)}${COMPACT.endsWith('0') ? '1' : '0'}`;
    const got = S.normaliseScannedPairing(bad);
    const expected = P.parsePairingPayload(bad);
    assert.equal(got.ok, false);
    assert.equal(got.code, expected.code);
    assert.equal(got.reason, expected.reason);
    assert.match(got.reason, /校验和/);
  });

  test('S11 扫码 API 失败文案只有一条，且 typed 码固定', () => {
    assert.deepEqual(Object.keys(S.PAIRING_SCAN_WORDING), ['E_PAIRING_SCAN_UNAVAILABLE']);
    const unavailable = S.scanUnavailableResult();
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.code, 'E_PAIRING_SCAN_UNAVAILABLE');
    assert.equal(unavailable.text, '', '失败结果绝不携带扫描原文');
    assert.equal(unavailable.reason, S.PAIRING_SCAN_WORDING['E_PAIRING_SCAN_UNAVAILABLE']);
  });
});

describe('D. 单一解析器守卫（源码形状）', () => {
  test('D1 只委托 parsePairingPayload，没有第二套字段校验 / 拒绝句', () => {
    assert.match(SRC, /import\s*\{\s*parsePairingPayload\s*\}\s*from\s*'\.\/pairingPayload'/);
    assert.match(SRC, /parsePairingPayload\(text\)/);
    const banned = [
      'JSON.parse', 'PAIRING_KEYS', 'hasOwnProperty', 'instanceId', 'tlsFingerprint',
      'announceRef', 'formatPairingText', '不认识的配对串格式', '配对载荷不能为空',
      '配对载荷必须是字符串'
    ];
    for (const token of banned) {
      assert.equal(SRC.includes(token), false, `pairingScan.ts 不得含有 ${token}`);
    }
  });

  test('D2 零 SDK import', () => {
    assert.equal(/from\s*'@kit\./.test(SRC), false);
    assert.equal(/from\s*'@ohos\./.test(SRC), false);
  });
});
