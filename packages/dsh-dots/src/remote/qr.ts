/**
 * 远程访问域：**零依赖**二维码编码器（byte 模式，版本 1–10，EC L/M/Q/H，标准掩码罚分）+ SVG 输出。
 *
 * 为什么自己写：二维码要装的是**带 token 的地址**，链接不能出本机、不能依赖 npm 包
 * （插件运行时只有 `node:` 内置模块；装包意味着用户机器上多一份供应链风险）。
 *
 * 实现遵循 ISO/IEC 18004 的可扫描子集：
 *   - 唯一数据编码：**byte 模式**（UTF-8 字节，中文/emoji 都走这条路），不做 alphanumeric
 *     优化——版本选择按字节数算，短链接也一样能扫；
 *   - 版本 **1–10** 自动选择（`17 + 4*version` 边长，最多 213 字节 @M），超出即抛错（fail-closed，
 *     不静默降级成不可扫的东西）；
 *   - 纠错块结构、GF(256) Reed–Solomon（本原多项式 0x11D）、交织顺序按标准表；
 *   - 函数图形（3 个定位图形 + 分隔符 + 定时图形 + 校正图形 + 暗模块 + 格式信息 + 版本信息）；
 *   - **8 种掩码全试，按标准 4 条罚分规则取最小**（等价于最优掩码，扫码器兼容性最好）；
 *   - 格式信息 BCH(15,5)、版本信息 BCH(18,6) 均带标准掩码，不变式由测试回读校验。
 *
 * 输出契约见 `src/remote/types.ts` 的 `qr: { size, modules }`（`true` = 黑格，行优先）。
 */
import { Buffer } from 'node:buffer'

/** 二维码矩阵：`size` 为边长（模块数），`modules[y][x]` 为 true 表示黑格。 */
export interface QrMatrix {
  size: number
  modules: boolean[][]
}

/** 纠错级别。 */
export type QrEcLevel = 'L' | 'M' | 'Q' | 'H'

/** SVG 输出选项。 */
export interface QrSvgOptions {
  /** 单个模块的像素边长；默认 8（手机屏上直接可扫）。会被夹到 1..64。 */
  moduleSize?: number
  /** quiet zone（静区）模块数；默认 4（标准最小值）。会被夹到 0..16。 */
  margin?: number
  /** 黑格颜色；默认 `#000000`。非法值回退默认。 */
  dark?: string
  /** 白底颜色；默认 `#ffffff`。非法值回退默认。 */
  light?: string
}

const MIN_VERSION = 1
const MAX_VERSION = 10

/** 罚分权重（标准 N1..N4）。 */
const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

/** 每块纠错码字数（下标 = 版本，0 位占位）。 */
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcLevel, readonly number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
}

/** 纠错块数（下标 = 版本，0 位占位）。 */
const NUM_EC_BLOCKS: Record<QrEcLevel, readonly number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
}

/** 格式信息里的纠错级别编码（L=01, M=00, Q=11, H=10）。 */
const ECL_FORMAT_BITS: Record<QrEcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 }

function normalizeEcLevel(ecLevel: unknown): QrEcLevel {
  if (ecLevel === undefined || ecLevel === null) return 'M'
  const s = String(ecLevel).toUpperCase()
  if (s === 'L' || s === 'M' || s === 'Q' || s === 'H') return s
  throw new RangeError('纠错级别必须是 L / M / Q / H 之一')
}

/** 该版本去掉功能图形后可放码字的模块数（bit）。 */
function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** 该版本 + 纠错级别下的**数据**码字数（不含纠错码字）。 */
function numDataCodewords(version: number, ecl: QrEcLevel): number {
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[ecl][version] as number
  const blocks = NUM_EC_BLOCKS[ecl][version] as number
  return Math.floor(numRawDataModules(version) / 8) - eccPerBlock * blocks
}

/** GF(2^8) 乘法，本原多项式 0x11D（位运算实现，免查表）。 */
function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** Reed–Solomon 生成多项式 = ∏(x - α^i)，返回去掉首项 1 的系数（高次在前）。 */
function rsComputeDivisor(degree: number): number[] {
  const result: number[] = new Array(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j] as number, root)
      if (j + 1 < degree) result[j] = (result[j] as number) ^ (result[j + 1] as number)
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

/** 多项式取余：返回数据码字的纠错码字（长度 = 生成多项式阶数）。 */
function rsComputeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    for (let i = 0; i < divisor.length; i++) {
      result[i] = (result[i] as number) ^ gfMultiply(divisor[i] as number, factor)
    }
  }
  return result
}

/** 按标准把数据码字切块、加纠错、再交织（顺序错一位就扫不出来）。 */
function addEccAndInterleave(data: readonly number[], version: number, ecl: QrEcLevel): number[] {
  const numBlocks = NUM_EC_BLOCKS[ecl][version] as number
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version] as number
  const rawCodewords = Math.floor(numRawDataModules(version) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsComputeDivisor(blockEccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1)
    const dat = data.slice(k, k + datLen)
    k += datLen
    const ecc = rsComputeRemainder(dat, divisor)
    if (i < numShortBlocks) dat.push(0) // 占位，交织时跳过
    blocks.push(dat.concat(ecc))
  }
  const result: number[] = []
  for (let i = 0; i < (blocks[0] as number[]).length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push((blocks[j] as number[])[i] as number)
      }
    }
  }
  return result
}

/** 校正图形中心坐标（版本 1 无校正图形）。 */
function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return []
  const size = version * 4 + 17
  const numAlign = Math.floor(version / 7) + 2
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
  const result: number[] = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

function drawFinderPattern(
  setFn: (x: number, y: number, dark: boolean) => void,
  cx: number,
  cy: number,
): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4)
    }
  }
}

function drawAlignmentPattern(
  setFn: (x: number, y: number, dark: boolean) => void,
  cx: number,
  cy: number,
): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

/** 画 15 位格式信息（纠错级别 + 掩码号，BCH(15,5)，固定掩码 0x5412）。 */
function drawFormatBits(
  setFn: (x: number, y: number, dark: boolean) => void,
  size: number,
  ecl: QrEcLevel,
  mask: number,
): void {
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0

  for (let i = 0; i <= 5; i++) setFn(8, i, bit(i))
  setFn(8, 7, bit(6))
  setFn(8, 8, bit(7))
  setFn(7, 8, bit(8))
  for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i))

  for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i))
  setFn(8, size - 8, true) // 固定暗模块
}

/** 画 18 位版本信息（版本 ≥ 7 才需要，BCH(18,6)）。 */
function drawVersionBits(
  setFn: (x: number, y: number, dark: boolean) => void,
  size: number,
  version: number,
): void {
  if (version < 7) return
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = (version << 12) | rem
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    setFn(a, b, dark)
    setFn(b, a, dark)
  }
}

/** 按 zigzag 顺序把码字铺进非功能区（右下起、每列两格、蛇形向上/向下）。 */
function drawCodewords(
  modules: boolean[][],
  isFunction: boolean[][],
  size: number,
  codewords: readonly number[],
): void {
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // 跳过竖排定时图形
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] as number) >>> (7 - (i & 7))) % 2 !== 0
          i++
        }
      }
    }
  }
}

/** 按掩码号异或非功能区（掩码公式来自标准表）。 */
function applyMask(modules: boolean[][], isFunction: boolean[][], size: number, mask: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y][x]) continue
      let invert: boolean
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break
        case 1: invert = y % 2 === 0; break
        case 2: invert = x % 3 === 0; break
        case 3: invert = (x + y) % 3 === 0; break
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break
        default: throw new RangeError('掩码号必须是 0..7')
      }
      if (invert) modules[y][x] = !modules[y][x]
    }
  }
}

function finderPenaltyAddHistory(runLength: number, runHistory: number[], size: number): void {
  let len = runLength
  if (runHistory[0] === 0) len += size // 首段黑游程前面补上"边界外的白"
  runHistory.pop()
  runHistory.unshift(len)
}

function finderPenaltyCountPatterns(runHistory: readonly number[]): number {
  const n = runHistory[1] as number
  const core = n > 0 &&
    runHistory[2] === n &&
    runHistory[3] === n * 3 &&
    runHistory[4] === n &&
    runHistory[5] === n
  return (core && (runHistory[0] as number) >= n * 4 && (runHistory[6] as number) >= n ? 1 : 0) +
    (core && (runHistory[6] as number) >= n * 4 && (runHistory[0] as number) >= n ? 1 : 0)
}

function finderPenaltyTerminateAndCount(
  currentRunColor: boolean,
  currentRunLength: number,
  runHistory: number[],
  size: number,
): number {
  let len = currentRunLength
  if (currentRunColor) {
    finderPenaltyAddHistory(len, runHistory, size)
    len = 0
  }
  len += size // 末尾补上"边界外的白"
  finderPenaltyAddHistory(len, runHistory, size)
  return finderPenaltyCountPatterns(runHistory)
}

/** 标准 4 条罚分（越大越差）。 */
function penaltyScore(modules: boolean[][], size: number): number {
  let result = 0

  // 规则 1（同色长游程）与规则 3（类定位图形 1:1:3:1:1）：逐行
  for (let y = 0; y < size; y++) {
    let runColor = false
    let runLen = 0
    const runHistory = [0, 0, 0, 0, 0, 0, 0]
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLen++
        if (runLen === 5) result += PENALTY_N1
        else if (runLen > 5) result++
      } else {
        finderPenaltyAddHistory(runLen, runHistory, size)
        if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3
        runColor = modules[y][x]
        runLen = 1
      }
    }
    result += finderPenaltyTerminateAndCount(runColor, runLen, runHistory, size) * PENALTY_N3
  }

  // 规则 1 + 3：逐列
  for (let x = 0; x < size; x++) {
    let runColor = false
    let runLen = 0
    const runHistory = [0, 0, 0, 0, 0, 0, 0]
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLen++
        if (runLen === 5) result += PENALTY_N1
        else if (runLen > 5) result++
      } else {
        finderPenaltyAddHistory(runLen, runHistory, size)
        if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3
        runColor = modules[y][x]
        runLen = 1
      }
    }
    result += finderPenaltyTerminateAndCount(runColor, runLen, runHistory, size) * PENALTY_N3
  }

  // 规则 2：2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x]
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        result += PENALTY_N2
      }
    }
  }

  // 规则 4：黑白比例偏离 50%
  let dark = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y][x]) dark++
  }
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  result += k * PENALTY_N4
  return result
}

/** 编码结果内部形态：带选中的掩码号与版本，供测试/调试自查。 */
export interface QrCode {
  size: number
  modules: boolean[][]
  version: number
  ecLevel: QrEcLevel
  mask: number
}

/**
 * 标准掩码罚分（越小越优）。导出它是为了让测试能独立复核"掩码选择"这一步：
 * 对同一矩阵与参考实现比对分值，比只比对最终图案更容易定位差异来源。
 */
export function qrPenalty(modules: boolean[][]): number {
  return penaltyScore(modules, modules.length)
}

/**
 * 编码成二维码矩阵（byte 模式）。
 *
 * 默认纠错级别 M（15% 冗余，屏幕直扫的平衡点）。文本按 UTF-8 字节编码；
 * 超过 10 版容量直接抛 `RangeError`（错误消息只含字节数，不含内容——内容里可能有 token）。
 */
export function encodeQrDetail(text: string, ecLevel?: QrEcLevel): QrCode {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const ecl = normalizeEcLevel(ecLevel)
  const bytes = Buffer.from(raw, 'utf8')
  if (bytes.length === 0) throw new RangeError('二维码内容不能为空')

  // 版本选择：byte 模式字符计数位宽在 10 版起从 8 位变 16 位
  let version = -1
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const capacityBits = numDataCodewords(v, ecl) * 8
    const needBits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8
    if (needBits <= capacityBits) {
      version = v
      break
    }
  }
  if (version < 0) {
    throw new RangeError(
      `二维码内容过长：${bytes.length} 字节超出 ${MAX_VERSION} 版 byte 模式容量（${ecl} 级）`,
    )
  }

  // 数据位串：模式指示 0100 + 字符计数 + 字节 + 终止符 + 字节对齐 + 填充字节
  const bits: number[] = []
  const appendBits = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  appendBits(0b0100, 4)
  appendBits(bytes.length, version <= 9 ? 8 : 16)
  for (const b of bytes) appendBits(b, 8)
  const capacityBits = numDataCodewords(version, ecl) * 8
  appendBits(0, Math.min(4, capacityBits - bits.length))
  appendBits(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8)

  const dataCodewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] as number)
    dataCodewords.push(b)
  }
  const allCodewords = addEccAndInterleave(dataCodewords, version, ecl)

  const size = version * 4 + 17
  const modules: boolean[][] = []
  const isFunction: boolean[][] = []
  for (let y = 0; y < size; y++) {
    modules.push(new Array<boolean>(size).fill(false))
    isFunction.push(new Array<boolean>(size).fill(false))
  }
  const setFn = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    modules[y][x] = dark
    isFunction[y][x] = true
  }

  // 功能图形
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0)
    setFn(i, 6, i % 2 === 0)
  }
  drawFinderPattern(setFn, 3, 3)
  drawFinderPattern(setFn, size - 4, 3)
  drawFinderPattern(setFn, 3, size - 4)
  const alignPos = alignmentPatternPositions(version)
  for (let i = 0; i < alignPos.length; i++) {
    for (let j = 0; j < alignPos.length; j++) {
      const x = alignPos[i] as number
      const y = alignPos[j] as number
      const isFinderCorner = (x === 6 && y === 6) ||
        (x === 6 && y === size - 7) ||
        (x === size - 7 && y === 6)
      if (!isFinderCorner) drawAlignmentPattern(setFn, x, y)
    }
  }
  drawFormatBits(setFn, size, ecl, 0) // 先占位，选定掩码后重画
  drawVersionBits(setFn, size, version)

  drawCodewords(modules, isFunction, size, allCodewords)

  // 掩码选择：8 种全试，取罚分最小（同分取编号小的）
  let bestMask = 0
  let minPenalty = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, isFunction, size, mask)
    drawFormatBits(setFn, size, ecl, mask)
    const penalty = penaltyScore(modules, size)
    if (penalty < minPenalty) {
      minPenalty = penalty
      bestMask = mask
    }
    applyMask(modules, isFunction, size, mask) // 异或自反，撤销
  }
  applyMask(modules, isFunction, size, bestMask)
  drawFormatBits(setFn, size, ecl, bestMask)

  return { size, modules, version, ecLevel: ecl, mask: bestMask }
}

/** 编码成二维码矩阵（外部契约形态，`types.ts` 的 `qr` 字段同构）。 */
export function encodeQr(text: string, ecLevel?: QrEcLevel): QrMatrix {
  const code = encodeQrDetail(text, ecLevel)
  return { size: code.size, modules: code.modules }
}

const SAFE_COLOR = /^[#A-Za-z0-9(),.%\s-]{1,64}$/

function sanitizeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const s = value.trim()
  if (s.length === 0 || !SAFE_COLOR.test(s)) return fallback
  return s
}

/**
 * 生成可独立打开的 SVG 字符串（含 quiet zone）。
 *
 * 单 `<path>` 输出（每行把连续黑格合成一条 run），比逐格 `<rect>` 小一个数量级；
 * `viewBox` 以**模块**为单位，`width/height` 乘上 `moduleSize`，因此任意缩放都不糊边。
 * `aria-label` 固定为「QR code」——**不写内容**，免把 token 泄露到无障碍文本/截图标注里。
 */
export function qrToSvg(text: string, options?: QrSvgOptions): string {
  const opts = options ?? {}
  const rawModuleSize = Number.isFinite(opts.moduleSize) ? Math.trunc(opts.moduleSize as number) : 8
  const moduleSize = Math.min(64, Math.max(1, rawModuleSize))
  const rawMargin = Number.isFinite(opts.margin) ? Math.trunc(opts.margin as number) : 4
  const margin = Math.min(16, Math.max(0, rawMargin))
  const dark = sanitizeColor(opts.dark, '#000000')
  const light = sanitizeColor(opts.light, '#ffffff')

  const { size, modules } = encodeQr(text)
  const total = size + margin * 2
  const dim = total * moduleSize

  const runs: string[] = []
  for (let y = 0; y < size; y++) {
    let x = 0
    while (x < size) {
      if (!modules[y][x]) {
        x++
        continue
      }
      let run = 1
      while (x + run < size && modules[y][x + run]) run++
      runs.push(`M${x + margin} ${y + margin}h${run}v1h-${run}z`)
      x += run
    }
  }

  return '<svg xmlns="http://www.w3.org/2000/svg"' +
    ` width="${dim}" height="${dim}" viewBox="0 0 ${total} ${total}"` +
    ' shape-rendering="crispEdges" role="img" aria-label="QR code">' +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${runs.join('')}" fill="${dark}"/></svg>`
}
