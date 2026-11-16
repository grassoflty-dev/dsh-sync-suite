/**
 * `model/calendar.ts` 单测（纯逻辑，零 SDK 依赖）。
 *
 * 运行：`node --test apps/arkui-schedule/tools/test/calendar.test.mjs`
 * 前置：`node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json`
 *       （把 `model/**`、`common/**` 编译到 `tools/.build`，与其它纯逻辑单测同一口径）
 *
 * 覆盖：闰年、每月天数、6×7 网格首末与跨月补位、weekStart 两种、跨年 shiftMonth、
 * parseDateKey 非法输入、formatMonthTitle、clampDateKey、isToday 标记、网格长度恒为 6 周、
 * 可重复调用稳定，外加「日历结构组件」的源码结构守卫（组件本身跑不了 Node，只能静态断言）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  clampDateKey,
  daysInMonth,
  formatDateKey,
  formatMonthTitle,
  isLeapYear,
  monthGrid,
  parseDateKey,
  shiftMonth,
  weekdayLabels
} from '../.build/model/calendar.js'

const CALENDAR_TS = readFileSync(
  new URL('../../entry/src/main/ets/model/calendar.ts', import.meta.url),
  'utf8'
)
const PICKER_ETS = readFileSync(
  new URL('../../entry/src/main/ets/components/CalendarPicker.ets', import.meta.url),
  'utf8'
)

/** 把 6×7 网格拍平成一维（断言「本月格数」「找某一天」时更好写）。 */
function flatten(month) {
  return month.weeks.reduce((all, week) => all.concat(week), [])
}

/** 日期键 → UTC 毫秒（只用于算相邻两格是否差正好一天，不受本机时区影响）。 */
function utcMillis(dateKey) {
  const parts = parseDateKey(dateKey)
  assert.notEqual(parts, null, `${dateKey} 应该是合法日期键`)
  return Date.UTC(parts.year, parts.month - 1, parts.day)
}

/** 去掉注释：结构守卫只看代码，注释里出现 `any` / `$r(` 属正常文档说明。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// ---------------------------------------------------------------- 闰年

test('isLeapYear：2024 闰、2100 不闰、2000 闰、1900 不闰（4/100/400 三条规则齐全）', () => {
  assert.equal(isLeapYear(2024), true)
  assert.equal(isLeapYear(2023), false)
  assert.equal(isLeapYear(2100), false, '整百不闰')
  assert.equal(isLeapYear(2000), true, '四百年再闰')
  assert.equal(isLeapYear(1900), false)
  assert.equal(isLeapYear(2026), false)
})

test('isLeapYear / daysInMonth：非法年份与月份返回 false / 0，不抛异常', () => {
  for (const year of [Number.NaN, 2026.5, 0, -4, 10000, Number.POSITIVE_INFINITY]) {
    assert.equal(isLeapYear(year), false, `${year} 不是合法年份`)
    assert.equal(daysInMonth(year, 1), 0)
  }
  for (const month of [0, 13, -1, Number.NaN, 1.5]) {
    assert.equal(daysInMonth(2026, month), 0, `${month} 月不存在`)
  }
})

test('daysInMonth：平年 / 闰年 12 个月的天数表', () => {
  const normal = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const leap = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  for (let month = 1; month <= 12; month++) {
    assert.equal(daysInMonth(2026, month), normal[month - 1], `2026-${month}`)
    assert.equal(daysInMonth(2024, month), leap[month - 1], `2024-${month}`)
  }
})

// ---------------------------------------------------------------- 网格形状与首末

test('monthGrid：2026-11（周一起）恒为 6 行 × 7 列，首格 2026-10-26、末格 2026-12-06', () => {
  const grid = monthGrid(2026, 11, 1, '2026-11-16')
  assert.equal(grid.year, 2026)
  assert.equal(grid.month, 11)
  assert.equal(grid.title, '2026 年 11 月')
  assert.equal(grid.weeks.length, 6)
  for (const week of grid.weeks) {
    assert.equal(week.length, 7)
  }
  assert.equal(grid.weeks[0][0].dateKey, '2026-10-26', '周一为首列时 11-01 是周日 → 补 6 天')
  assert.equal(grid.weeks[5][6].dateKey, '2026-12-06')
  assert.equal(flatten(grid).length, 42)
})

test('monthGrid：1 号落在正确列（2026-11-01 周日 → 周一起网格的第 7 列，周日起网格的第 1 列）', () => {
  const mondayFirst = monthGrid(2026, 11, 1, '')
  const sundayFirst = monthGrid(2026, 11, 0, '')
  assert.equal(mondayFirst.weeks[0][6].dateKey, '2026-11-01')
  assert.equal(mondayFirst.weeks[0][6].weekday, 0, '周日 = 0')
  assert.equal(sundayFirst.weeks[0][0].dateKey, '2026-11-01')
  assert.equal(sundayFirst.weeks[0][0].weekday, 0)
  // 本月的 1 号在两种起点下的列号差一天（首格整体平移）
  assert.equal(sundayFirst.weeks[0][0].dateKey, mondayFirst.weeks[0][6].dateKey)
})

test('monthGrid：跨月补位 inMonth=false，本月格恰好覆盖 1..daysInMonth 且每格都是真实日期', () => {
  const grid = monthGrid(2026, 11, 1, '')
  const days = flatten(grid)
  const inMonth = days.filter((cell) => cell.inMonth)
  assert.equal(inMonth.length, 30, '11 月 30 天')
  assert.deepEqual(
    inMonth.map((cell) => cell.day),
    Array.from({ length: 30 }, (_, index) => index + 1)
  )
  // 补位格：一共 12 格（42 - 30），全部 inMonth=false 且日期键可解析（真实日期，可点击跳转）
  const outside = days.filter((cell) => !cell.inMonth)
  assert.equal(outside.length, 12)
  for (const cell of outside) {
    assert.notEqual(parseDateKey(cell.dateKey), null, `补位格 ${cell.dateKey} 必须是真实日期`)
  }
  for (const cell of days) {
    assert.equal(parseDateKey(cell.dateKey).day, cell.day, `${cell.dateKey} 的 day 字段要自洽`)
  }
})

test('monthGrid：weekStart 0 / 1 只差首格对齐，且每格 weekday 与所在列对齐', () => {
  const mondayFirst = monthGrid(2026, 11, 1, '')
  const sundayFirst = monthGrid(2026, 11, 0, '')
  assert.equal(mondayFirst.weeks[0][0].dateKey, '2026-10-26', '周一起：首格回溯到 10-26（周一）')
  assert.equal(sundayFirst.weeks[0][0].dateKey, '2026-11-01', '周日起：11-01 本身就是周日，不做回溯')
  assert.equal(sundayFirst.weeks[0][0].weekday, 0)
  // 周一起：第 0 列永远周一（1），第 6 列永远周日（0）
  for (const week of mondayFirst.weeks) {
    assert.equal(week[0].weekday, 1)
    assert.equal(week[6].weekday, 0)
  }
  // 周日起：第 0 列永远周日（0），第 6 列永远周六（6）
  for (const week of sundayFirst.weeks) {
    assert.equal(week[0].weekday, 0)
    assert.equal(week[6].weekday, 6)
  }
  // 非法的 weekStart（7 / undefined 之外的怪值）按周一兜底，不抛
  assert.equal(monthGrid(2026, 11, 7, '').weeks[0][0].dateKey, '2026-10-26')
  assert.equal(monthGrid(2026, 11, Number.NaN, '').weeks[0][0].dateKey, '2026-10-26')
})

test('monthGrid：网格长度恒为 6 周 × 7 列，且 42 格是连续的 42 天（2020–2030 全月扫描）', () => {
  for (let year = 2020; year <= 2030; year++) {
    for (let month = 1; month <= 12; month++) {
      for (const weekStart of [0, 1]) {
        const grid = monthGrid(year, month, weekStart, '2026-11-16')
        assert.equal(grid.weeks.length, 6, `${year}-${month} weekStart=${weekStart} 必须有 6 周`)
        const cells = flatten(grid)
        assert.equal(cells.length, 42)
        for (const week of grid.weeks) {
          assert.equal(week.length, 7)
        }
        for (let index = 1; index < cells.length; index++) {
          const gap = utcMillis(cells[index].dateKey) - utcMillis(cells[index - 1].dateKey)
          assert.equal(gap, 86400000, `${cells[index - 1].dateKey} → ${cells[index].dateKey} 必须正好差一天`)
        }
      }
    }
  }
})

test('monthGrid：跨年补位正确（2026-12 尾部是 2027-01，2026-01 头部是 2025-12）', () => {
  const december = monthGrid(2026, 12, 1, '')
  assert.equal(december.weeks[0][0].dateKey, '2026-11-30')
  assert.equal(december.weeks[5][6].dateKey, '2027-01-10')
  assert.equal(december.weeks[5][6].inMonth, false)
  assert.equal(december.weeks[5][6].weekday, 0)

  const january = monthGrid(2026, 1, 1, '')
  assert.equal(january.weeks[0][0].dateKey, '2025-12-29')
  assert.equal(january.weeks[0][0].inMonth, false)
  assert.equal(january.weeks[0][3].dateKey, '2026-01-01')
  assert.equal(january.weeks[5][6].dateKey, '2026-02-08')
})

test('monthGrid：2024-02 含 2024-02-29（闰日），2023-02 没有 29 号', () => {
  const leapFebruary = flatten(monthGrid(2024, 2, 1, '2024-02-29'))
  const leapDay = leapFebruary.filter((cell) => cell.dateKey === '2024-02-29')
  assert.equal(leapDay.length, 1)
  assert.equal(leapDay[0].day, 29)
  assert.equal(leapDay[0].inMonth, true)
  assert.equal(leapDay[0].isToday, true, 'todayKey 指向闰日时要有 isToday 标记')
  assert.equal(leapFebruary.filter((cell) => cell.inMonth).length, 29)

  const normalFebruary = flatten(monthGrid(2023, 2, 1, ''))
  assert.equal(normalFebruary.filter((cell) => cell.inMonth).length, 28)
  assert.equal(
    normalFebruary.filter((cell) => cell.dateKey === '2023-02-29').length,
    0,
    '2023 不是闰年，网格里不该出现 02-29'
  )
})

test('monthGrid：isToday 只标一格；todayKey 非法时全不标；今天落在补位格里也能标上', () => {
  const grid = monthGrid(2026, 11, 1, '2026-11-16')
  const marked = flatten(grid).filter((cell) => cell.isToday)
  assert.equal(marked.length, 1)
  assert.equal(marked[0].dateKey, '2026-11-16')

  for (const badToday of ['', 'abc', '2026-13-01', '2026-02-30']) {
    const none = flatten(monthGrid(2026, 11, 1, badToday)).filter((cell) => cell.isToday)
    assert.equal(none.length, 0, `非法 todayKey=${JSON.stringify(badToday)} 不应标记今天`)
  }

  // 补位格里的「今天」（2026-10-28 属于上个月，但仍在首行网格内）
  const padded = flatten(monthGrid(2026, 11, 1, '2026-10-28')).filter((cell) => cell.isToday)
  assert.equal(padded.length, 1)
  assert.equal(padded[0].dateKey, '2026-10-28')
  assert.equal(padded[0].inMonth, false)
})

test('monthGrid / formatMonthTitle：非法年月返回空网格 + 空标题，绝不抛异常', () => {
  for (const [year, month] of [
    [2026, 0],
    [2026, 13],
    [0, 1],
    [10000, 1],
    [Number.NaN, 1],
    [2026, Number.NaN]
  ]) {
    const grid = monthGrid(year, month, 1, '2026-11-16')
    assert.deepEqual(grid.weeks, [], `${year}-${month} 不应产出网格`)
    assert.equal(grid.title, '')
  }
})

// ---------------------------------------------------------------- 平移月份

test('shiftMonth：跨年 +1 / -1 / 0 / ±12 / 大跨度都正确', () => {
  assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2026, month: 12 })
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 }, '12 月 +1 → 次年 1 月')
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 }, '1 月 -1 → 上年 12 月')
  assert.deepEqual(shiftMonth(2026, 6, 0), { year: 2026, month: 6 })
  assert.deepEqual(shiftMonth(2026, 6, 12), { year: 2027, month: 6 })
  assert.deepEqual(shiftMonth(2026, 6, -12), { year: 2025, month: 6 })
  assert.deepEqual(shiftMonth(2026, 1, 13), { year: 2027, month: 2 })
  assert.deepEqual(shiftMonth(2026, 12, -24), { year: 2024, month: 12 })
  assert.deepEqual(shiftMonth(2024, 2, 11), { year: 2025, month: 1 })
})

test('shiftMonth：越界月份按「月序号」归一化，非数值兜底 1970-01（不抛）', () => {
  assert.deepEqual(shiftMonth(2026, 13, 0), { year: 2027, month: 1 })
  assert.deepEqual(shiftMonth(2026, 0, 0), { year: 2025, month: 12 })
  assert.deepEqual(shiftMonth(2026, -1, 0), { year: 2025, month: 11 })
  for (const [year, month, delta] of [
    [Number.NaN, 1, 0],
    [2026, Number.NaN, 0],
    [2026, 1, Number.NaN]
  ]) {
    const shifted = shiftMonth(year, month, delta)
    assert.equal(Number.isInteger(shifted.year), true)
    assert.equal(Number.isInteger(shifted.month), true)
    assert.ok(shifted.month >= 1 && shifted.month <= 12)
  }
  assert.deepEqual(shiftMonth(Number.NaN, 1, 0), { year: 1970, month: 1 })
})

// ---------------------------------------------------------------- 解析 / 格式化

test('parseDateKey：合法键返回年/月/日，2024-02-29 合法、2023-02-29 与 2026-13-01 拒绝', () => {
  assert.deepEqual(parseDateKey('2026-11-16'), { year: 2026, month: 11, day: 16 })
  assert.deepEqual(parseDateKey('2024-02-29'), { year: 2024, month: 2, day: 29 })
  assert.deepEqual(parseDateKey('  2026-11-16  '), { year: 2026, month: 11, day: 16 }, '允许首尾空白')
  for (const bad of [
    '2023-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-02-30',
    '2026-04-31',
    '2026-11-00',
    '2026-1-1',
    '2026-11-16T00:00:00',
    '2026/11/16',
    'abc',
    '',
    '   '
  ]) {
    assert.equal(parseDateKey(bad), null, `${JSON.stringify(bad)} 应解析失败`)
  }
})

test('formatMonthTitle：`2026 年 11 月`（月不补前导零），非法入参空串', () => {
  assert.equal(formatMonthTitle(2026, 11), '2026 年 11 月')
  assert.equal(formatMonthTitle(2026, 1), '2026 年 1 月')
  assert.equal(formatMonthTitle(2026, 12), '2026 年 12 月')
  assert.equal(formatMonthTitle(2026, 0), '')
  assert.equal(formatMonthTitle(2026, 13), '')
  assert.equal(formatMonthTitle(Number.NaN, 1), '')
  assert.equal(monthGrid(2026, 11, 1, '').title, formatMonthTitle(2026, 11))
})

test('formatDateKey：补零到 `YYYY-MM-DD`，非法日期返回空串', () => {
  assert.equal(formatDateKey(2026, 1, 5), '2026-01-05')
  assert.equal(formatDateKey(2026, 11, 16), '2026-11-16')
  assert.equal(formatDateKey(2024, 2, 29), '2024-02-29')
  assert.equal(formatDateKey(2023, 2, 29), '')
  assert.equal(formatDateKey(2026, 13, 1), '')
  assert.equal(formatDateKey(2026, 11, 31), '')
  assert.equal(formatDateKey(Number.NaN, 11, 1), '')
})

test('weekdayLabels：周一起 `一二三四五六日`、周日起 `日一二三四五六`，非法值兜底周一', () => {
  assert.deepEqual(weekdayLabels(1), ['一', '二', '三', '四', '五', '六', '日'])
  assert.deepEqual(weekdayLabels(0), ['日', '一', '二', '三', '四', '五', '六'])
  assert.deepEqual(weekdayLabels(), ['一', '二', '三', '四', '五', '六', '日'])
  assert.deepEqual(weekdayLabels(7), ['一', '二', '三', '四', '五', '六', '日'])
  assert.equal(weekdayLabels(0).length, 7)
  assert.equal(new Set(weekdayLabels(1)).size, 7, '七个标签不能重复')
})

// ---------------------------------------------------------------- 区间夹取

test('clampDateKey：区间内原样、低于下限取 min、高于上限取 max', () => {
  const min = '2024-01-01'
  const max = '2026-12-31'
  assert.equal(clampDateKey('2025-05-05', min, max), '2025-05-05')
  assert.equal(clampDateKey('2024-01-01', min, max), '2024-01-01')
  assert.equal(clampDateKey('2019-12-31', min, max), min, '早于下限取下限')
  assert.equal(clampDateKey('2030-06-01', min, max), max, '晚于上限取上限')
  assert.equal(clampDateKey(' 2025-05-05 ', min, max), '2025-05-05', '返回规范化结果')
})

test('clampDateKey：非法原值返回空串；未传/非法边界不生效；空区间下限优先', () => {
  assert.equal(clampDateKey('abc', '2024-01-01'), '')
  assert.equal(clampDateKey('', '2024-01-01'), '')
  assert.equal(clampDateKey('2026-02-30'), '', '非法日期键本身不接受')
  assert.equal(clampDateKey('2025-05-05'), '2025-05-05', '不给区间就原样返回')
  assert.equal(clampDateKey('2025-05-05', '', ''), '2025-05-05', '空串边界视为不生效')
  assert.equal(clampDateKey('2025-05-05', 'abc', '2026-12-31'), '2025-05-05', '非法边界被忽略')
  assert.equal(clampDateKey('2025-05-05', '2024-01-01', 'not-a-date'), '2025-05-05')
  assert.equal(clampDateKey('2025-05-05', '2026-01-01', '2024-01-01'), '2026-01-01', 'min > max 时下限优先')
})

// ---------------------------------------------------------------- 稳定性

test('monthGrid 可重复调用稳定：两次结果深度相等，且不修改入参 / 互相独立', () => {
  const first = monthGrid(2026, 11, 1, '2026-11-16')
  const second = monthGrid(2026, 11, 1, '2026-11-16')
  assert.deepEqual(first, second)
  assert.notEqual(first.weeks, second.weeks, '每次返回新的数组，调用方改动不会串味')

  first.weeks[0][0].day = 99
  const third = monthGrid(2026, 11, 1, '2026-11-16')
  assert.equal(third.weeks[0][0].day, 26, '上一次结果被改写不影响下一次调用')

  // 同一入参、不同 weekStart/todayKey 之间也不共享引用
  const other = monthGrid(2026, 11, 0, '2026-11-16')
  assert.notEqual(other.weeks, first.weeks)
  assert.notDeepEqual(other.weeks[0][0], second.weeks[0][0])
})

test('网格每一格的 weekday 与 dateKey 自洽（与 Date.UTC 交叉校验，不受本机时区影响）', () => {
  for (const [year, month] of [
    [2024, 2],
    [2026, 11],
    [2026, 12],
    [2020, 1]
  ]) {
    for (const weekStart of [0, 1]) {
      const cells = flatten(monthGrid(year, month, weekStart, ''))
      for (const cell of cells) {
        const parts = parseDateKey(cell.dateKey)
        const expected = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
        assert.equal(cell.weekday, expected, `${cell.dateKey} 的星期应为 ${expected}`)
        assert.ok(cell.weekday >= 0 && cell.weekday <= 6)
        assert.equal(cell.dateKey.length, 10)
      }
    }
  }
})

// ---------------------------------------------------------------- 源码结构守卫（组件无法在 Node 里渲染）

test('model/calendar.ts 是纯逻辑：零 SDK import、无 $r() 资源、无 ArkUI 装饰器', () => {
  const code = stripComments(CALENDAR_TS)
  assert.equal(/^\s*import\s/m.test(code), false, '日历逻辑不 import 任何模块（连相对路径都不需要）')
  assert.equal(/\$r\('/.test(code), false, '纯逻辑不许引用资源')
  assert.equal(/@ohos\.|@kit\./.test(code), false, '不许依赖鸿蒙 SDK')
  assert.equal(/new Date\(|Date\.UTC|Intl\./.test(code), false, '日期运算必须是纯整数算法（可跨时区复现）')
  assert.match(code, /export function isLeapYear/)
  assert.match(code, /export function daysInMonth/)
  assert.match(code, /export function monthGrid/)
  assert.match(code, /export function shiftMonth/)
  assert.match(code, /export function parseDateKey/)
  assert.match(code, /export function formatMonthTitle/)
  assert.match(code, /export function clampDateKey/)
})

test('CalendarPicker.ets：结构/令牌/回调齐全，且符合 ArkTS 严格模式约定', () => {
  const code = stripComments(PICKER_ETS)

  // 契约：@Prop value / todayKey + 两个回调（页面接线只依赖这四个）
  assert.match(code, /@Prop @Watch\('onValueChange'\) value: string/)
  assert.match(code, /@Prop todayKey: string/)
  assert.match(code, /onPick: \(dateKey: string\) => void/)
  assert.match(code, /onClose: \(\) => void/)
  // 6×7 网格由 @Builder dayCell 渲染，且全部从纯逻辑取数
  assert.match(code, /@Builder\s+dayCell\(day: CalendarDay\)/)
  assert.match(code, /monthGrid\(/)
  assert.match(code, /shiftMonth\(/)
  assert.match(code, /weekdayLabels\(/)
  // 触控目标 ≥ TOUCH_MIN、颜色走资源令牌（深色模式跟随）
  assert.match(code, /\.height\(TOUCH_MIN\)/)
  assert.match(code, /\.width\(TOUCH_MIN\)/)
  assert.match(code, /\$r\('app\.color\.brand'\)/)
  assert.match(code, /\$r\('app\.color\.text_secondary'\)/)
  // 间距/圆角/字号走令牌，不硬编码
  assert.match(code, /from '\.\.\/common\/uiTokens'/)
  assert.match(code, /SPACING\./)
  assert.match(code, /RADIUS\./)
  assert.match(code, /FONT\./)
  // ArkTS 严格模式：不用 any、相对 import 不带 .js、不带 @crossplatform（ArkUI-X 26 不认识）
  assert.equal(/\bany\b/.test(code), false, 'ArkTS 严格模式禁止 any')
  assert.equal(/from '\.\.[^']*\.js'/.test(code), false, '相对 import 不能带 .js')
  assert.equal(/@crossplatform/.test(code), false)
  // 不该碰页面 / 服务层
  assert.equal(/pages\//.test(code), false, '组件不直接依赖页面')
  assert.equal(/\$r\('app\.color\.(?!brand|brand_soft|surface|page_background|text_primary|text_secondary|divider|text_inverse|scrim|danger|warning)/.test(code), false, '颜色令牌必须存在于 resources')
})
