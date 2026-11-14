// SHA-256 纯实现测试：RFC 6234 / FIPS 180-4 标准向量 + 与 node:crypto 的交叉校验。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 再运行：
//   node --test apps/arkui-schedule/tools/test
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { sha256Hex } from '../.build/model/sha256.js';

const reference = (data) =>
  createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');

test('sha256Hex：空串向量', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256Hex："abc" 向量（RFC 6234 附录）', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256Hex：448bit 两段式向量', () => {
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  );
});

test('sha256Hex：1000 个 "a"（跨多个 64 字节块）', () => {
  assert.equal(sha256Hex('a'.repeat(1000)), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
});

test('sha256Hex：100 万个 "a"（百万级填充）', () => {
  assert.equal(sha256Hex('a'.repeat(1000000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('sha256Hex：UTF-8 多字节（中文 + emoji 代理对）', () => {
  assert.equal(sha256Hex('中文abc🚀'), '1f8c359c736b0ccd21974367d7d59088d187b2690484c89924f27f5a1004436a');
  assert.equal(
    sha256Hex('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'
  );
});

test('sha256Hex：Uint8Array 入参与字符串入参对 ASCII 等价', () => {
  const bytes = Uint8Array.from([0x61, 0x62, 0x63]);
  assert.equal(sha256Hex(bytes), sha256Hex('abc'));
  assert.equal(sha256Hex(bytes), reference(Buffer.from('abc', 'utf8')));
});

test('sha256Hex：任意二进制字节（含 0x00 / 0xFF）与 node:crypto 一致', () => {
  const bytes = Uint8Array.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x00, 0x01]);
  assert.equal(sha256Hex(bytes), reference(Buffer.from(bytes)));
});

test('sha256Hex：输出为 64 位小写十六进制', () => {
  const digest = sha256Hex('格式检查');
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('sha256Hex：UTF-8 长度边界（1/2/3/4 字节字符与孤立代理）', () => {
  const cases = [
    'a',
    'é',
    '中',
    '😀',
    'aé中😀',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    '\ud800', // 孤立高位代理 → U+FFFD
    '\udc00', // 孤立低位代理 → U+FFFD
    'x\ud800y'
  ];
  for (const value of cases) {
    assert.equal(sha256Hex(value), reference(Buffer.from(value, 'utf8')), `入参 ${JSON.stringify(value)}`);
  }
});

test('sha256Hex：确定性伪随机批量交叉校验（120 例）', () => {
  // 线性同余生成器，保证可复现
  let seed = 20261114;
  const nextInt = (bound) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % bound;
  };
  const alphabet = ['a', 'Z', '0', ' ', '\n', '中', '文', 'é', '😀', '\ud800', '$', '"'];
  for (let i = 0; i < 120; i++) {
    const length = nextInt(200);
    let text = '';
    for (let j = 0; j < length; j++) {
      text += alphabet[nextInt(alphabet.length)];
    }
    assert.equal(sha256Hex(text), reference(Buffer.from(text, 'utf8')), `第 ${i} 例长度 ${length}`);
  }
});
