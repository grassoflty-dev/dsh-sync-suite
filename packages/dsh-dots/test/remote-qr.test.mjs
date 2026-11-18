/**
 * `dist/remote/qr.js` 的单测：零依赖二维码编码（byte 模式 / 版本 1–10 / EC L,M,Q,H / 标准掩码罚分）
 * 与 SVG 输出。
 *
 * "能被真实扫码器读懂"的验证方式：两组**外部参考向量**（`HELLO WORLD` 与 ≥100 字符的长 URL）
 * 由 Nayuki 的参考实现 `qrcodegen`（业界通用实现，`python/qrcodegen.py`，byte 模式、
 * `encode_segments`、自动选版本与掩码）生成后**逐模块**硬编码在本文件里：
 *   - 只要本插件的矩阵与它逐格相同，就说明数据编码、RS 纠错、块交织、功能图形、格式信息、
 *     掩码与掩码选择全部与参考实现一致（矩阵相同 ⇒ 扫码结果相同）；
 *   - 另外再做结构自检：三个定位图形位置/形状、分隔符、定时图形、暗模块、格式信息 BCH 自洽、
 *     版本信息（版本 ≥7）自洽、边长必须满足 `17 + 4*version`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { encodeQr, encodeQrDetail, qrPenalty, qrToSvg } from '../dist/remote/qr.js'

/** 参考向量 1：`HELLO WORLD`，version 1、EC M、mask 4、21×21。 */
const HELLO_WORLD = 'HELLO WORLD'
const HELLO_WORLD_MASK = 4
const HELLO_WORLD_ROWS = [
  '111111101100101111111',
  '100000100001001000001',
  '101110100101001011101',
  '101110101001001011101',
  '101110101110101011101',
  '100000101001001000001',
  '111111101010101111111',
  '000000001001100000000',
  '100010111111011111001',
  '000100001011100001111',
  '001111110011011010010',
  '111110001100010000000',
  '111110101010101100110',
  '000000001010111101011',
  '111111101110101011010',
  '100000100101110110011',
  '101110101101011000110',
  '101110100100100011011',
  '101110100111000111000',
  '100000100001010000000',
  '111111101111111110101',
]

/** 参考向量 2：113 字符的长 URL（真实用途形态：地址 + `?k=<token>`），version 7、EC M、mask 7、45×45。 */
const LONG_URL = 'https://dsh-sync.example.test:3081/remote/sync?k=' + 'A'.repeat(64)
const LONG_URL_MASK = 7
const LONG_URL_ROWS = [
  '111111100101110110111010011111111000101111111',
  '100000100000110001010011000111101001001000001',
  '101110100111110000100110100010000001001011101',
  '101110100111111010001100000001100001101011101',
  '101110100110100000101111101101101011101011101',
  '100000101010101100011000111100111100001000001',
  '111111101010101010101010101010101010101111111',
  '000000000111001110011000100101000011000000000',
  '100101101010101001111111110110110011110100000',
  '101101010001010000010101000100000000010011001',
  '110110100100010111111101010010111111100000101',
  '101010010010111000000000111100010000011100011',
  '100010111000000100100011011111111011000111000',
  '001101010111111110111111010010010010010011000',
  '111111101001101001100110100011101000001010110',
  '101010010101001010000100010100101100110100000',
  '010100111111001001101100101100001100001100111',
  '011110001010111110011010001001000001001000011',
  '010111110100011000101001101010001011001011111',
  '100110000111001010010010000111000110100000010',
  '101011111110011000111111110110010111111111100',
  '010110001110010001011000110001000001100010001',
  '011110101001110111011010111111011001101010111',
  '100010001111010010111000100010011100100011000',
  '111011111100010101011111111111111101111111001',
  '101001001000010111011001010010010011010011101',
  '000100111111010011101011011111100001110101110',
  '010111010101011111011000010101001001110011000',
  '011110100100100010010100101101101100010111011',
  '101011001110001001111101101001000100010000011',
  '101001110111101111000011101010101000101011111',
  '010010000000011110000011000111011110101110010',
  '101101111101011010100110110110010111010011100',
  '111100001101111011011101000001000001100001010',
  '000010111011101110010110111000000001101101101',
  '011110011100100011011111000011111101010101001',
  '100110110010001101001111100011011110111110101',
  '000000001010001101101000111000010010100010011',
  '111111100100000000101010100001000010101011100',
  '100000101100101001001000110111010110100010011',
  '101110100001000111011111111101101001111111010',
  '101110101100110010101011001111001100011100000',
  '101110100111101100101010100100101001111111111',
  '100000100011001000001011000111011000010011000',
  '111111101011001100010010110110110101100011010',
]

const rowsOf = (modules) => modules.map((row) => row.map((m) => (m ? '1' : '0')).join(''))

/** 从矩阵里回读 15 位格式信息，验证 BCH 自洽并解出 EC 级别与掩码号。 */
function readFormatInfo(modules) {
  const seq = []
  for (let i = 0; i <= 5; i++) seq.push([8, i])
  seq.push([8, 7], [8, 8], [7, 8])
  for (let i = 9; i < 15; i++) seq.push([14 - i, 8])
  let bits = 0
  for (let i = 0; i < 15; i++) {
    const [x, y] = seq[i]
    if (modules[y][x]) bits |= 1 << i
  }
  const unmasked = bits ^ 0x5412
  const data = unmasked >> 10
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bchOk = (((data << 10) | rem) & 0x7fff) === (unmasked & 0x7fff)
  return { bchOk, ec: ['M', 'L', 'H', 'Q'][(data >> 3) & 3], mask: data & 7 }
}

/** 检查三个 7×7 定位图形（含各自的白色分隔符）。 */
function assertFinderPatterns(modules) {
  const size = modules.length
  const corners = [[0, 0], [size - 7, 0], [0, size - 7]]
  for (const [ox, oy] of corners) {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
        assert.equal(modules[oy + dy][ox + dx], dist !== 2, `finder(${ox},${oy}) at ${dx},${dy}`)
      }
    }
  }
  // 分隔符：定位图形外侧一格必须全白
  for (let i = 0; i < 8; i++) {
    assert.equal(modules[7][i], false, `top-left separator row 7 col ${i}`)
    assert.equal(modules[i][7], false, `top-left separator col 7 row ${i}`)
    assert.equal(modules[7][size - 1 - i], false, `top-right separator row 7 col ${size - 1 - i}`)
    assert.equal(modules[i][size - 8], false, `top-right separator col size-8 row ${i}`)
    assert.equal(modules[size - 8][i], false, `bottom-left separator row size-8 col ${i}`)
    assert.equal(modules[size - 1 - i][7], false, `bottom-left separator col 7 row ${size - 1 - i}`)
  }
}

/** 检查定时图形（第 6 行/第 6 列，隔一格黑白交替，黑在偶数位）。 */
function assertTimingPatterns(modules) {
  const size = modules.length
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `timing row 6 col ${i}`)
    assert.equal(modules[i][6], i % 2 === 0, `timing col 6 row ${i}`)
  }
}

test('encodeQr：短 payload 落在 version 1（21×21），矩阵与参考实现逐模块一致', async (t) => {
  await t.test('尺寸 21×21，版本 1，掩码 4', () => {
    const code = encodeQrDetail(HELLO_WORLD)
    assert.equal(code.size, 21)
    assert.equal(code.version, 1)
    assert.equal(code.ecLevel, 'M')
    assert.equal(code.mask, HELLO_WORLD_MASK)
  })

  await t.test('矩阵与 Nayuki qrcodegen 参考向量完全相同', () => {
    const { modules } = encodeQr(HELLO_WORLD)
    assert.deepEqual(rowsOf(modules), HELLO_WORLD_ROWS)
  })

  await t.test('三个定位图形 + 分隔符 + 定时图形 + 暗模块位置正确', () => {
    const { modules, size } = encodeQr(HELLO_WORLD)
    assert.equal(size, modules.length)
    for (const row of modules) assert.equal(row.length, size)
    assertFinderPatterns(modules)
    assertTimingPatterns(modules)
    // 固定的暗模块：格式信息区右下角 (8, size-8)
    assert.equal(modules[size - 8][8], true)
  })

  await t.test('格式信息 BCH 自洽，且写的就是 M + mask 4', () => {
    const { modules } = encodeQr(HELLO_WORLD)
    const info = readFormatInfo(modules)
    assert.equal(info.bchOk, true)
    assert.equal(info.ec, 'M')
    assert.equal(info.mask, HELLO_WORLD_MASK)
  })
})

test('encodeQr：≥100 字符长 URL 自动升版，尺寸满足 17+4*version', async (t) => {
  await t.test('113 字符 URL → version 7（45×45），与参考向量一致', () => {
    const code = encodeQrDetail(LONG_URL)
    assert.ok(LONG_URL.length >= 100)
    assert.equal(code.version, 7)
    assert.equal(code.size, 17 + 4 * 7)
    assert.equal(code.size, 45)
    assert.equal(code.mask, LONG_URL_MASK)
    assert.deepEqual(rowsOf(code.modules), LONG_URL_ROWS)
  })

  await t.test('长 URL 的定位图形/定时图形/格式信息同样正确', () => {
    const { modules } = encodeQr(LONG_URL)
    assertFinderPatterns(modules)
    assertTimingPatterns(modules)
    const info = readFormatInfo(modules)
    assert.equal(info.bchOk, true)
    assert.equal(info.ec, 'M')
    assert.equal(info.mask, LONG_URL_MASK)
  })

  await t.test('版本信息（version ≥7 才有）自洽', () => {
    const { modules, size } = encodeQr(LONG_URL)
    const version = 7
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const expectBits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const expected = ((expectBits >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      assert.equal(modules[b][a], expected, `version info copy1 at ${i}`)
      assert.equal(modules[a][b], expected, `version info copy2 at ${i}`)
    }
  })
})

test('encodeQr：版本选择与容量边界（1–10 版）', async (t) => {
  await t.test('各种长度的边长都满足 17+4*version，且版本单调不减', () => {
    let lastVersion = 0
    for (const len of [1, 5, 10, 20, 40, 60, 80, 100, 130, 160, 200]) {
      const code = encodeQrDetail('x'.repeat(len))
      assert.equal(code.size, 17 + 4 * code.version)
      assert.ok(code.version >= 1 && code.version <= 10)
      assert.ok(code.version >= lastVersion, `len=${len} version 回退`)
      lastVersion = code.version
    }
  })

  await t.test('M 级 byte 模式上限 213 字节；214 字节 fail-closed 抛错', () => {
    assert.equal(encodeQrDetail('x'.repeat(213)).version, 10)
    assert.throws(() => encodeQr('x'.repeat(214)), RangeError)
  })

  await t.test('纠错级别越高，版本不会更小（同 payload）', () => {
    const payload = 'https://example.test:3081/sync?k=' + 'A'.repeat(43)
    const versions = ['L', 'M', 'Q', 'H'].map((ecl) => encodeQrDetail(payload, ecl).version)
    for (let i = 1; i < versions.length; i++) {
      assert.ok(versions[i] >= versions[i - 1], `${versions.join(',')}`)
    }
    // 每个级别都要能编码，并且格式信息里写对了级别
    for (const ecl of ['L', 'M', 'Q', 'H']) {
      const code = encodeQrDetail(payload, ecl)
      const info = readFormatInfo(code.modules)
      assert.equal(info.bchOk, true)
      assert.equal(info.ec, ecl)
      assert.equal(info.mask, code.mask)
    }
  })

  await t.test('UTF-8 内容按字节计（中文/emoji 可编码）', () => {
    const code = encodeQrDetail('远程访问 二维码 token 测试 ★')
    assert.equal(code.size, 17 + 4 * code.version)
    assertFinderPatterns(code.modules)
    // 中文 39 字节 → 至少 version 2
    assert.ok(code.version >= 2)
  })

  await t.test('空串 / 非法纠错级别 → 抛错（不产出不可扫的空码）', () => {
    assert.throws(() => encodeQr(''), RangeError)
    assert.throws(() => encodeQr('abc', 'X'), RangeError)
  })

  await t.test('内容过长时错误消息不含原文（原文可能是带 token 的地址）', () => {
    const secret = 'https://host.test:3081/sync?k=' + 'Z'.repeat(300)
    try {
      encodeQr(secret)
      assert.fail('应当抛错')
    } catch (error) {
      assert.ok(error instanceof RangeError)
      assert.ok(!error.message.includes('Z'.repeat(10)))
      assert.ok(!error.message.includes('host.test'))
      assert.match(error.message, /字节/)
    }
  })

  await t.test('同一输入多次编码结果稳定', () => {
    assert.deepEqual(encodeQr(HELLO_WORLD), encodeQr(HELLO_WORLD))
  })
})

test('qrToSvg：quiet zone、尺寸、颜色与"不泄露内容"', async (t) => {
  await t.test('默认 margin=4 模块、moduleSize=8：viewBox 与 width/height 正确', () => {
    const svg = qrToSvg(HELLO_WORLD)
    const size = 21
    const total = size + 4 * 2
    assert.ok(svg.startsWith('<svg '))
    assert.ok(svg.endsWith('</svg>'))
    assert.match(svg, /viewBox="0 0 29 29"/)
    assert.match(svg, /width="232"/)
    assert.match(svg, /height="232"/)
    assert.match(svg, /shape-rendering="crispEdges"/)
    assert.match(svg, /fill="#000000"/)
    assert.match(svg, /fill="#ffffff"/)
    assert.equal((svg.match(/<path/g) ?? []).length, 1, '单 path 输出')
    assert.equal((svg.match(/<svg/g) ?? []).length, 1)
    assert.equal(total, 29)
  })

  await t.test('quiet zone：所有黑格都落在 margin 之内，四周各留 4 模块', () => {
    const svg = qrToSvg(HELLO_WORLD)
    const runs = [...svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)]
    assert.ok(runs.length > 0)
    const size = 21
    const margin = 4
    for (const [, xs, ys, ws] of runs) {
      const x = Number(xs)
      const y = Number(ys)
      const w = Number(ws)
      assert.ok(x >= margin && y >= margin, `run at ${x},${y} 侵入 quiet zone`)
      assert.ok(x + w <= size + margin, `run 末端 ${x + w} 越界`)
      assert.ok(y <= size + margin - 1)
    }
  })

  await t.test('自定义 moduleSize / margin / 颜色', () => {
    const svg = qrToSvg(HELLO_WORLD, { moduleSize: 2, margin: 0, dark: '#123456', light: '#abcdef' })
    assert.match(svg, /viewBox="0 0 21 21"/)
    assert.match(svg, /width="42"/)
    assert.match(svg, /height="42"/)
    assert.match(svg, /fill="#123456"/)
    assert.match(svg, /fill="#abcdef"/)
  })

  await t.test('非法颜色回退默认值（不把用户串拼进 SVG，防注入）', () => {
    const svg = qrToSvg(HELLO_WORLD, { dark: '"><script>alert(1)</script>' })
    assert.ok(!svg.includes('<script>'))
    assert.match(svg, /fill="#000000"/)
  })

  await t.test('长 URL 的 SVG 尺寸跟随矩阵（45+8 = 53 模块）', () => {
    const svg = qrToSvg(LONG_URL)
    assert.match(svg, /viewBox="0 0 53 53"/)
    assert.match(svg, /width="424"/) // 53 * 默认 8
  })

  await t.test('SVG 里不含二维码承载的内容（地址/token 不外泄到文本节点）', () => {
    const token = 'q'.repeat(43)
    const url = `https://192.168.1.6:3081/sync?k=${token}`
    const svg = qrToSvg(url)
    assert.ok(!svg.includes(token))
    assert.ok(!svg.includes('192.168.1.6'))
    assert.match(svg, /aria-label="QR code"/)
    // 只剩图形元素：没有 <text>/<title>/注释
    assert.ok(!/<text|<title|<!--/.test(svg))
  })
})

test('qrPenalty：标准罚分实现（与 Nayuki qrcodegen 同值）', async (t) => {
  await t.test('HELLO WORLD 矩阵罚分为 1011，长 URL 为 1989', () => {
    assert.equal(qrPenalty(encodeQr(HELLO_WORLD).modules), 1011)
    assert.equal(qrPenalty(encodeQr(LONG_URL).modules), 1989)
  })

  await t.test('罚分随同色大块上升（全黑矩阵远高于正常矩阵）', () => {
    const size = 21
    const allDark = Array.from({ length: size }, () => new Array(size).fill(true))
    assert.ok(qrPenalty(allDark) > qrPenalty(encodeQr(HELLO_WORLD).modules))
  })
})
