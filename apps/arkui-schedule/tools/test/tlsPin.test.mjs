// mod-remote-tls-termination：平板侧证书 pin 判定的 Node 单测。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型 `model/tlsPin.ts` 只 import `./sha256`，编译产物可直接被 Node 加载。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const SRC = resolve(HERE, '../../entry/src/main/ets');
const T = await import('../.build/model/tlsPin.js');

const {
  TLS_PIN_MISMATCH_WORDING,
  TLS_NO_PIN_WORDING,
  TLS_CHAIN_UNVERIFIABLE_WORDING,
  pinKey,
  fingerprintFromDer,
  verifyPinnedCertificate,
} = T;

/** 插件侧同一算法：SHA-256(DER) → 32 段大写冒号分隔。 */
function expectedFingerprint(der) {
  const hex = createHash('sha256').update(der).digest('hex').toUpperCase();
  return (hex.match(/.{2}/g) ?? []).join(':');
}

const DER_A = Uint8Array.from(Buffer.from('leaf-der-of-paired-certificate-A', 'utf8'));
const DER_B = Uint8Array.from(Buffer.from('leaf-der-of-swapped-certificate-B', 'utf8'));
const PIN_A = expectedFingerprint(DER_A);
const PIN_B = expectedFingerprint(DER_B);

describe('证书指纹算法与 pin 归一', () => {
  test('fingerprintFromDer 与插件 pairingFingerprintOf 的 SHA-256(DER) 算法一致', () => {
    assert.equal(fingerprintFromDer(DER_A), PIN_A);
    assert.equal(fingerprintFromDer(DER_B), PIN_B);
    assert.notEqual(PIN_A, PIN_B);
  });

  test('pinKey 接受冒号/十六进制/大小写，坏值一律空串（不等于任意匹配）', () => {
    assert.equal(pinKey(PIN_A), PIN_A.replace(/:/g, ''));
    assert.equal(pinKey(PIN_A.replace(/:/g, '').toLowerCase()), PIN_A.replace(/:/g, ''));
    assert.equal(pinKey(''), '');
    assert.equal(pinKey(undefined), '');
    assert.equal(pinKey('AA:BB'), '');
  });
});

describe('三种拒绝结果严格分开', () => {
  test('(a) pin 存在、leaf 指纹不同 ⇒ mismatch，且文案逐字固定', () => {
    const result = verifyPinnedCertificate([DER_B], PIN_A);
    assert.equal(result.outcome, 'mismatch');
    assert.equal(result.wording, TLS_PIN_MISMATCH_WORDING);
    assert.equal(
      TLS_PIN_MISMATCH_WORDING,
      '证书指纹与配对时固定的一致才能连接：当前证书指纹不匹配，已拒绝连接（可能是换了机器、换了证书或中间人）',
    );
  });

  test('(b) 无 pin：undefined / 空串 / 损坏指纹 / 字段缺失统一拒绝，文案与 (a)(c) 不同', () => {
    for (const pin of [undefined, null, '', '   ', 'AA:BB', 'not-a-fingerprint']) {
      const result = verifyPinnedCertificate([DER_A], pin);
      assert.equal(result.outcome, 'no-pin', `pin=${String(pin)}`);
      assert.equal(result.wording, TLS_NO_PIN_WORDING);
    }
    assert.equal(
      TLS_NO_PIN_WORDING,
      '该实例从未配对过（无 pin），没有固定的证书指纹，已拒绝连接；请先回设置页用二维码配对，连接本身不会自动信任证书',
    );
    assert.notEqual(TLS_NO_PIN_WORDING, TLS_PIN_MISMATCH_WORDING);
    assert.notEqual(TLS_NO_PIN_WORDING, TLS_CHAIN_UNVERIFIABLE_WORDING);
  });

  test('(c) 证书链拿不到 / 不可 hash ⇒ unverifiable，绝不当成 (a) 或成功', () => {
    for (const chain of [undefined, [], [undefined], [new Uint8Array(0)]]) {
      const result = verifyPinnedCertificate(chain, PIN_A);
      assert.equal(result.outcome, 'unverifiable', `chain=${String(chain)}`);
      assert.equal(result.wording, TLS_CHAIN_UNVERIFIABLE_WORDING);
    }
    assert.equal(TLS_CHAIN_UNVERIFIABLE_WORDING, '无法校验证书链，已拒绝连接');
    assert.notEqual(TLS_CHAIN_UNVERIFIABLE_WORDING, TLS_PIN_MISMATCH_WORDING);
  });

  test('优先序：pin 缺失时不因"链也没有"被误报成 (c)；成功只来自 pin 命中', () => {
    assert.equal(verifyPinnedCertificate(undefined, undefined).outcome, 'no-pin');
    const ok = verifyPinnedCertificate([DER_A], PIN_A);
    assert.equal(ok.outcome, 'match');
    assert.equal(ok.wording, '');
    // leaf 必须是链的第一项：把真证书放在第二项不得被当成命中
    assert.equal(verifyPinnedCertificate([DER_B, DER_A], PIN_A).outcome, 'mismatch');
  });

  test('纯函数：不写 pin、不改入参（连接路径没有 TOFU 副作用）', () => {
    const chain = [Uint8Array.from(DER_A)];
    const before = Array.from(chain[0]);
    const pin = PIN_A.slice();
    assert.equal(verifyPinnedCertificate(chain, pin).outcome, 'match');
    assert.deepEqual(Array.from(chain[0]), before, '不得修改平台给的证书 DER');
    assert.equal(pin, PIN_A, '不得修改传入的 pin');
    assert.equal(chain.length, 1, '不得往证书链里追加/替换元素');
  });
});

describe('配对落表侧的无 pin 决策（只读源码守卫，不改那个被锁定的文件）', () => {
  test('配对更新分支对空/缺失指纹是拒绝，不是"任意证书匹配"', () => {
    const src = readFileSync(resolve(SRC, 'model/pairingPayload.ts'), 'utf8');
    assert.match(src, /storedKey\.length === 0 \|\| storedKey !== incomingKey/,
      '空指纹必须与不一致一样被拒绝');
    assert.match(src, /E_PAIRING_FINGERPRINT_MISMATCH/, '拒绝必须使用 typed code');
  });
});
