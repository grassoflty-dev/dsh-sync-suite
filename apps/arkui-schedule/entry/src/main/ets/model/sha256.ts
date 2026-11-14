/**
 * 纯 TS 的 SHA-256 实现（FIPS 180-4 / RFC 6234），不依赖鸿蒙 SDK 运行时、`node:crypto`、
 * `TextEncoder` 等任何宿主 API，因此 ArkTS（HarmonyOS）、Android 与 Node 下表现一致。
 *
 * 用途：附件去重命名 `<sha256>.png`、manifest 校验、多设备折叠时的内容指纹。
 */

/** SHA-256 轮常量（前 64 个素数立方根小数部分的前 32 位）。 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/** 初始哈希值（前 8 个素数平方根小数部分的前 32 位）。 */
const INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

const HEX_DIGITS = '0123456789abcdef';

/**
 * 把 JS 字符串按 UTF-8 编码为字节（等价于标准 `TextEncoder`，包括孤立代理项 → U+FFFD）。
 * 手写实现是为了不依赖宿主 `TextEncoder`，保证 ArkTS/Android/Node 三端逐字节一致。
 */
function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        // 孤立高位代理 → U+FFFD
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // 孤立低位代理 → U+FFFD
      code = 0xfffd;
    }

    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return Uint8Array.from(out);
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** 对 UTF-8 字节流做 SHA-256，返回 32 字节摘要。 */
function sha256Digest(data: Uint8Array): Uint8Array {
  const length = data.length;
  // 填充到 64 字节块：消息 + 0x80 + 若干 0x00 + 8 字节大端比特长度
  const padded = (((length + 9 + 63) >> 6) << 6) >>> 0;
  const buffer = new Uint8Array(padded);
  buffer.set(data, 0);
  buffer[length] = 0x80;

  // 长度以 bit 计，按 64 位大端写入末尾 8 字节（支持 > 512MB 输入）
  const bitLength = length * 8;
  const hi = Math.floor(bitLength / 0x100000000) >>> 0;
  const lo = bitLength >>> 0;
  buffer[padded - 8] = (hi >>> 24) & 0xff;
  buffer[padded - 7] = (hi >>> 16) & 0xff;
  buffer[padded - 6] = (hi >>> 8) & 0xff;
  buffer[padded - 5] = hi & 0xff;
  buffer[padded - 4] = (lo >>> 24) & 0xff;
  buffer[padded - 3] = (lo >>> 16) & 0xff;
  buffer[padded - 2] = (lo >>> 8) & 0xff;
  buffer[padded - 1] = lo & 0xff;

  const h = new Uint32Array(INIT);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] =
        (((buffer[p] << 24) | (buffer[p + 1] << 16) | (buffer[p + 2] << 8) | buffer[p + 3]) >>> 0);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const digest = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const word = h[i];
    digest[i * 4] = (word >>> 24) & 0xff;
    digest[i * 4 + 1] = (word >>> 16) & 0xff;
    digest[i * 4 + 2] = (word >>> 8) & 0xff;
    digest[i * 4 + 3] = word & 0xff;
  }
  return digest;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_DIGITS[(bytes[i] >>> 4) & 0x0f] + HEX_DIGITS[bytes[i] & 0x0f];
  }
  return out;
}

/**
 * 计算 SHA-256，返回 64 字符小写十六进制。
 * 字符串入参按 UTF-8 编码，`Uint8Array` 入参按原始字节处理。
 */
export function sha256Hex(input: string | Uint8Array): string {
  if (typeof input === 'string') {
    return toHex(sha256Digest(utf8Encode(input)));
  }
  return toHex(sha256Digest(input));
}
