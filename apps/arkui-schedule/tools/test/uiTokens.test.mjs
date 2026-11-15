import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BREAKPOINTS,
  DIVIDER,
  FONT,
  LANDSCAPE_ASPECT,
  LINE_HEIGHT,
  RADIUS,
  SPACING,
  TOUCH_MIN,
  columnsFor,
  isCompact,
  isLandscapeSize,
  isWide,
  minWidthFor,
  resolveBreakpoint,
  sidebarWidth,
  touchPadding
} from '../.build/common/uiTokens.js'

const INDEX = readFileSync(new URL('../../entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8')
const PAGE_LAYOUT = readFileSync(new URL('../../entry/src/main/ets/components/PageLayout.ets', import.meta.url), 'utf8')

// ---------------------------------------------------------------- 断点边界

test('断点边界：599 / 600 / 601 竖屏分别为 compact / medium / medium', () => {
  assert.equal(resolveBreakpoint(599, false), 'compact')
  assert.equal(resolveBreakpoint(600, false), 'medium')
  assert.equal(resolveBreakpoint(601, false), 'medium')
})

test('断点边界：839 / 840 / 841 竖屏分别为 medium / medium / expanded', () => {
  assert.equal(resolveBreakpoint(839, false), 'medium')
  assert.equal(resolveBreakpoint(840, false), 'medium')
  assert.equal(resolveBreakpoint(841, false), 'expanded')
})

test('断点边界：0 与极小宽度是 compact，超宽是 expanded', () => {
  assert.equal(resolveBreakpoint(0, false), 'compact')
  assert.equal(resolveBreakpoint(1, false), 'compact')
  assert.equal(resolveBreakpoint(2560, false), 'expanded')
})

test('断点解析对非法宽度 fail-safe 到 compact（不抛出、不返回 undefined）', () => {
  assert.equal(resolveBreakpoint(Number.NaN, false), 'compact')
  assert.equal(resolveBreakpoint(-100, false), 'compact')
  // 非有限值统一按 0 处理（宁可单列也不要在异常宽度下漏掉控件）
  assert.equal(resolveBreakpoint(Number.POSITIVE_INFINITY, false), 'compact')
})

// ---------------------------------------------------------------- 横屏特例

test('横屏下 compact 也算 wide：宽度不足 600 时断点被抬到 medium 且 isWide 为真', () => {
  const landscape = resolveBreakpoint(320, true)
  assert.equal(landscape, 'medium', '横屏不允许返回 compact')
  assert.equal(isWide(landscape), true)
  assert.equal(isCompact(landscape), false)
})

test('横屏下所有 0..840 宽度都判为宽（单列分支不会被走到）', () => {
  for (let width = 0; width <= 840; width += 20) {
    const breakpoint = resolveBreakpoint(width, true)
    assert.equal(isWide(breakpoint), true, `横屏 ${width}vp 应判为宽，实际 ${breakpoint}`)
  }
  // 竖屏同样宽度仍然可以是紧凑 → 证明横屏抬升确实发生了
  assert.equal(resolveBreakpoint(320, false), 'compact')
})

test('横屏不会把 expanded 降级', () => {
  assert.equal(resolveBreakpoint(1280, true), 'expanded')
  assert.equal(resolveBreakpoint(841, true), 'expanded')
})

test('isWide / isCompact 对三种断点与未知值都给确定结果', () => {
  assert.equal(isWide('compact'), false)
  assert.equal(isWide('medium'), true)
  assert.equal(isWide('expanded'), true)
  assert.equal(isWide(''), false)
  assert.equal(isCompact('compact'), true)
  assert.equal(isCompact('medium'), false)
  assert.equal(isCompact('whatever'), true)
})

test('isLandscapeSize 只按宽高比判定（方屏不算横屏）', () => {
  assert.equal(isLandscapeSize(2560, 1600), true)
  assert.equal(isLandscapeSize(1600, 2560), false)
  assert.equal(isLandscapeSize(1000, 1000), false)
  assert.equal(isLandscapeSize(Number.NaN, 100), false)
  assert.ok(LANDSCAPE_ASPECT > 0)
})

// ---------------------------------------------------------------- 真实设备尺寸 → 两栏

test('真机横向 1280×800vp（2560×1600@2x）判为 expanded ⇒ 两栏', () => {
  assert.equal(isLandscapeSize(1280, 800), true)
  const breakpoint = resolveBreakpoint(1280, true)
  assert.equal(breakpoint, 'expanded')
  assert.equal(isWide(breakpoint), true)
  assert.ok(sidebarWidth(1280 - 48) > 280, '侧栏要够宽放日期条')
})

test('真机纵向 800×1280vp（1600×2560@2x）判为 medium ⇒ 也是两栏', () => {
  const breakpoint = resolveBreakpoint(800, isLandscapeSize(800, 1280))
  assert.equal(breakpoint, 'medium')
  assert.equal(isWide(breakpoint), true)
})

// ---------------------------------------------------------------- Index / PageLayout 结构守卫

test('Index 只按 breakpoint === compact 分支，且单列/双栏两套骨架都存在', () => {
  assert.match(INDEX, /if \(this\.breakpoint === 'compact'\) \{/, 'Index 必须只做一处粗粒度分支')
  assert.match(INDEX, /this\.CompactBody\(\)/)
  assert.match(INDEX, /this\.WideBody\(\)/)
  assert.match(INDEX, /sidebarWidth\(this\.contentWidth\)/, '双栏侧栏宽度必须走令牌函数')
  assert.match(INDEX, /onBreakpointChange:/, 'Index 必须接 PageLayout 的断点回调')
})

test('Index 双栏骨架：左日期列（DateBlock/ModeTabs/新建）+ 右列表', () => {
  const start = INDEX.indexOf('WideBody() {')
  assert.notEqual(start, -1)
  const body = INDEX.slice(start, INDEX.indexOf('\n  }', start))
  for (const piece of ['this.DateBlock()', 'this.ModeTabs()', 'this.SidebarAction()', 'this.WideList()']) {
    assert.ok(body.includes(piece), `WideBody 缺少 ${piece}`)
  }
  assert.match(body, /\.vertical\(true\)/, '两栏之间必须有竖分割线')
  assert.match(body, /records\.length > 0/, '空态时左栏不再放第二个主操作')
})

test('宽屏视觉四条：页头不重复日期 / 空态居中 CTA / 列表最大 900vp / 左栏按钮 240vp', () => {
  assert.match(INDEX, /const LIST_MAX_WIDTH: number = 900;/, '列表最大宽必须被常量约束')
  assert.match(INDEX, /const SIDEBAR_ACTION_WIDTH: number = 240;/, '左栏主操作固定 240vp')
  assert.match(INDEX, /\.constraintSize\(\{ maxWidth: LIST_MAX_WIDTH \}\)/, '列表要居中限宽')
  assert.match(INDEX, /this\.EmptyCta\(\)/, '空态右栏要有居中主操作')
  assert.match(INDEX, /subtitle: this\.subtitleText\(\)/, '页头副标题走 subtitleText()（空态不重复）')
  assert.equal(/return this\.showAllPending \? '全部未完成' : this\.selectedDate;/.test(INDEX), false, '页头不能直接显示日期')
  assert.match(INDEX, /return this\.selectedDate === localDateKey\(new Date\(\)\) \? '今天' : '日程';/)
})

test('PageLayout：onAreaChange + resolveBreakpoint + isLandscapeSize，且不把 Length 直接当 number', () => {
  assert.match(PAGE_LAYOUT, /\.onAreaChange\(/)
  assert.match(PAGE_LAYOUT, /resolveBreakpoint\(/)
  assert.match(PAGE_LAYOUT, /isLandscapeSize\(/)
  assert.match(PAGE_LAYOUT, /@State breakpoint: string/, '断点必须对外暴露为 @State')
  assert.equal(
    /area\.width as number/.test(PAGE_LAYOUT),
    false,
    'Area.width 是 Length（可能是字符串），直接 as number 会得到 0 → 横屏永远不出两栏'
  )
  assert.match(PAGE_LAYOUT, /typeof value === 'number'/, '必须有 Length → vp 的显式转换')
})

// ---------------------------------------------------------------- 断点表

test('BREAKPOINTS：minWidth 严格单调递增、列数合法、名称符合约定', () => {
  assert.equal(BREAKPOINTS.length, 3)
  assert.deepEqual(
    BREAKPOINTS.map((item) => item.name),
    ['compact', 'medium', 'expanded']
  )
  assert.equal(BREAKPOINTS[0].minWidth, 0)
  for (let index = 1; index < BREAKPOINTS.length; index++) {
    assert.ok(
      BREAKPOINTS[index].minWidth > BREAKPOINTS[index - 1].minWidth,
      `第 ${index} 档 minWidth 必须大于前一档`
    )
    assert.ok(BREAKPOINTS[index].columns >= 1)
  }
  for (const item of BREAKPOINTS) {
    assert.equal(Number.isFinite(item.minWidth), true)
    assert.equal(item.minWidth >= 0, true)
    assert.ok(Number.isInteger(item.columns))
  }
})

test('BREAKPOINTS 与 resolveBreakpoint 的阈值一致（600 / 841）', () => {
  assert.equal(minWidthFor('compact'), 0)
  assert.equal(minWidthFor('medium'), 600)
  assert.equal(minWidthFor('expanded'), 841)
  for (const item of BREAKPOINTS) {
    assert.equal(resolveBreakpoint(item.minWidth, false), item.name, `${item.name} 的起点应解析回自身`)
  }
})

test('columnsFor：compact 单列、宽屏双列、未知断点 fail-safe 单列', () => {
  assert.equal(columnsFor('compact'), 1)
  assert.equal(columnsFor('medium'), 2)
  assert.equal(columnsFor('expanded'), 2)
  assert.equal(columnsFor('nope'), 1)
  assert.equal(minWidthFor('nope'), 0)
})

// ---------------------------------------------------------------- 常量

test('SPACING 五档非负且严格递增（4 / 8 / 12 / 16 / 24）', () => {
  const values = [SPACING.xs, SPACING.sm, SPACING.md, SPACING.lg, SPACING.xl]
  assert.deepEqual(values, [4, 8, 12, 16, 24])
  for (let index = 1; index < values.length; index++) {
    assert.ok(values[index] > values[index - 1], '间距必须严格递增')
  }
})

test('RADIUS 非负且单调不降，none 为 0（卡片直角）', () => {
  assert.equal(RADIUS.none, 0)
  assert.ok(RADIUS.sm >= RADIUS.none)
  assert.ok(RADIUS.md >= RADIUS.sm)
  assert.equal(RADIUS.sm, 8)
  for (const value of [RADIUS.none, RADIUS.sm, RADIUS.md]) {
    assert.equal(Number.isFinite(value), true)
    assert.ok(value >= 0)
  }
})

test('FONT 只有三级且严格递减：title > body > caption >= 14', () => {
  assert.ok(FONT.title > FONT.body, '标题必须大于正文')
  assert.ok(FONT.body > FONT.caption, '正文必须大于辅助')
  assert.equal(FONT.title, 20)
  assert.equal(FONT.body, 16)
  assert.equal(FONT.caption, 14)
  assert.ok(FONT.caption >= 14, '最小字号不得低于 14fp')
})

test('LINE_HEIGHT 与 FONT 对应且严格递增、都大于字号本身', () => {
  const pairs = [
    [LINE_HEIGHT.caption, FONT.caption],
    [LINE_HEIGHT.body, FONT.body],
    [LINE_HEIGHT.title, FONT.title]
  ]
  for (const [line, font] of pairs) {
    assert.ok(line > font, `行高 ${line} 必须大于字号 ${font}`)
  }
  assert.ok(LINE_HEIGHT.title > LINE_HEIGHT.body)
  assert.ok(LINE_HEIGHT.body > LINE_HEIGHT.caption)
})

test('TOUCH_MIN 为 40 且不小于 40；DIVIDER 为 1', () => {
  assert.equal(TOUCH_MIN, 40)
  assert.ok(TOUCH_MIN >= 40, '触控目标不得小于 40vp')
  assert.equal(DIVIDER, 1)
})

test('touchPadding：矮控件补到 40vp，达标控件不补', () => {
  assert.equal(touchPadding(36), 2, '36vp 的按钮上下各补 2vp')
  assert.equal(touchPadding(24), 8)
  assert.equal(touchPadding(40), 0)
  assert.equal(touchPadding(44), 0)
  assert.equal(touchPadding(Number.NaN), 0)
})

// ---------------------------------------------------------------- 侧栏宽度

test('sidebarWidth：取 1/3 并夹在 280–420vp', () => {
  assert.equal(sidebarWidth(1280), 420, '1/3=427 应夹到 420 上限')
  assert.equal(sidebarWidth(840), 280, '1/3=280 落在下限')
  assert.equal(sidebarWidth(600), 280, '1/3=200 应抬到 280 下限')
  assert.equal(sidebarWidth(1200), 400, '1/3=400 保持')
  assert.equal(sidebarWidth(0), 280, '非法宽度回落 280')
  assert.equal(sidebarWidth(Number.NaN), 280)
  assert.equal(sidebarWidth(200), 200, '屏幕比下限还窄时不要超出屏幕')
})

test('sidebarWidth 结果永远不超过内容宽度（不产生横向溢出）', () => {
  for (const width of [200, 300, 600, 840, 1280, 2560]) {
    const side = sidebarWidth(width)
    assert.ok(side <= width, `${width}vp 的屏幕侧栏 ${side}vp 不应更宽`)
    assert.ok(side > 0)
  }
})
