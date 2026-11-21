import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readSettingsSources } from './settingsSources.mjs'
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
  isMasterDetailWidth,
  masterPaneWidth,
  minWidthFor,
  resolveBreakpoint,
  sidebarWidth,
  touchPadding
} from '../.build/common/uiTokens.js'

// S3：日程契约锚点从 fallback 路由 pages/Index.ets 移到真 body 所在的日程面板；断言不动。
const INDEX = readFileSync(new URL('../../entry/src/main/ets/pages/panes/SchedulePane.ets', import.meta.url), 'utf8')
const PAGE_LAYOUT = readFileSync(new URL('../../entry/src/main/ets/components/PageLayout.ets', import.meta.url), 'utf8')
// 因 A2 拆分移动：设置页界面拆到 `pages/Settings.ets` + `components/settings/*.ets`，
// 「设置页」的静态断言锚点改成两者合并（页面 + 五个 section + bits）；断言本身不变。
const SETTINGS = readSettingsSources()
const DETAIL_PAGE = readFileSync(new URL('../../entry/src/main/ets/pages/Detail.ets', import.meta.url), 'utf8')
const EDIT_PAGE = readFileSync(new URL('../../entry/src/main/ets/pages/Edit.ets', import.meta.url), 'utf8')
const DETAIL_VIEW = readFileSync(new URL('../../entry/src/main/ets/components/RecordDetailView.ets', import.meta.url), 'utf8')
const EDITOR_VIEW = readFileSync(new URL('../../entry/src/main/ets/components/RecordEditorView.ets', import.meta.url), 'utf8')
// S4 外壳：`pages/Home.ets` 是真首页，`ShellRail` 是它的导航轨。
const HOME = readFileSync(new URL('../../entry/src/main/ets/pages/Home.ets', import.meta.url), 'utf8')
const SHELL_RAIL = readFileSync(new URL('../../entry/src/main/ets/components/shell/ShellRail.ets', import.meta.url), 'utf8')
// S3：三个「即将迁入」占位的页头动作搬进各自文件，不再是 Home 的 @Builder。
const PANE_CODES = ['DotsPane.ets', 'InstancesPane.ets', 'CloudChatPane.ets'].map((name) =>
  stripComments(readFileSync(new URL(`../../entry/src/main/ets/pages/panes/${name}`, import.meta.url), 'utf8')))

/** 去掉块注释与整行行注释：结构守卫只对「代码」生效，注释里允许写「已删除」之类的说明 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const INDEX_CODE = stripComments(INDEX)
const SETTINGS_CODE = stripComments(SETTINGS)

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

// ---------------------------------------------------------------- 真实设备尺寸 → 单列 / 主从

test('竖屏平板 673vp 内容宽 ⇒ 单列（用户拍板：竖屏不渲染右栏）', () => {
  assert.equal(isMasterDetailWidth(673), false)
  assert.equal(isMasterDetailWidth(839), false, '839 仍不到 840 门槛')
  // 单列时走的是窄屏骨架，不依赖 isWide
  assert.equal(resolveBreakpoint(673, false), 'medium')
})

test('横向 1024vp 内容宽 ⇒ 左右主从（两栏）', () => {
  assert.equal(isMasterDetailWidth(1024), true)
  assert.equal(isMasterDetailWidth(840), true, '840 正好达到门槛')
  assert.equal(isLandscapeSize(1024, 768), true)
  const master = masterPaneWidth(1024)
  assert.ok(master >= 360 && master <= 420, `主栏应在 360–420vp，实际 ${master}`)
  const right = 1024 - master - 33
  assert.ok(right >= 360, `右栏至少 360vp，实际 ${right}`)
})

test('真机横向 1280×800vp（2560×1600@2x）⇒ 主从，主栏够宽放日期条', () => {
  assert.equal(isLandscapeSize(1280, 800), true)
  assert.equal(resolveBreakpoint(1280, true), 'expanded')
  assert.equal(isMasterDetailWidth(1280 - 48), true)
  assert.ok(masterPaneWidth(1280 - 48) > 280, '主栏要够宽放日期条')
})

test('竖屏平板 800×1280vp（1600×2560@2x）⇒ 仍是单列', () => {
  const breakpoint = resolveBreakpoint(800, isLandscapeSize(800, 1280))
  assert.equal(breakpoint, 'medium')
  assert.equal(isMasterDetailWidth(800 - 32), false, '800−32=768 < 840 → 单列')
})

// ---------------------------------------------------------------- Index / PageLayout 结构守卫

test('Index 用「内容宽 ≥840」决定主从，两套骨架都存在', () => {
  assert.match(INDEX, /this\.masterDetail = isMasterDetailWidth\(widthVp\)/, '主从门槛必须走 isMasterDetailWidth')
  assert.match(INDEX, /if \(this\.masterDetail\) \{/, 'Index 只做一处主从分支')
  assert.match(INDEX, /this\.CompactBody\(\)/)
  assert.match(INDEX, /this\.WideBody\(\)/)
  assert.match(INDEX, /masterPaneWidth\(this\.contentWidth\)/, '主从布局主栏宽度必须走令牌函数（360–420vp）')
  assert.match(INDEX, /constraintSize\(\{ minWidth: 360 \}\)/, '主从右栏最小 360vp')
  assert.match(INDEX, /onBreakpointChange:/, 'Index 必须接 PageLayout 的断点回调')
  assert.equal(/this\.breakpoint === 'compact'\) \{[\s\S]{0,40}this\.CompactBody/.test(INDEX), false, '不再用 breakpoint 档位决定主从')
})

test('Index 双栏骨架：左日期列（DateBlock/ModeTabs/新建）+ 右列表', () => {
  const start = INDEX.indexOf('WideBody() {')
  assert.notEqual(start, -1)
  const body = INDEX.slice(start, INDEX.indexOf('\n  }', start))
  for (const piece of ['this.DateBlock()', 'this.ModeTabs()', 'this.SidebarAction()', 'this.RecordList()']) {
    assert.ok(body.includes(piece), `WideBody 缺少 ${piece}`)
  }
  assert.match(body, /\.vertical\(true\)/, '两栏之间必须有竖分割线')
  assert.match(INDEX, /this\.RightPane\(\)/, '右栏必须渲染主从详情/编辑');
  assert.match(INDEX, /paneMode === 'editor'[\s\S]{0,120}RecordEditorView\(/, '编辑模式渲染 RecordEditorView');
  assert.match(INDEX, /RecordDetailView\(\{[\s\S]{0,160}recordId: this\.paneMode === 'detail' \? this\.selectedId : ''/, '详情/空态共用 RecordDetailView');
})

test('首页只有一个创建入口：快捷记录行与其回车/失焦提交痕迹全部删除', () => {
  assert.equal(/QuickRecordBar|QuickRecordRow|quickBusy|submitQuickRecord|快速记一条|回车保存/.test(INDEX_CODE), false,
    '快捷记录行 / 回车 + 失焦提交必须从首页彻底删除')
  for (const [builder, action] of [['CompactBody', 'PrimaryAction'], ['WideBody', 'SidebarAction']]) {
    const start = INDEX_CODE.indexOf(`${builder}() {`)
    assert.notEqual(start, -1)
    const body = INDEX_CODE.slice(start, INDEX_CODE.indexOf('\n  }', start))
    assert.ok(body.includes(`this.${action}()`), `${builder} 仍须渲染唯一创建入口 ${action}`)
  }
})

test('宽屏视觉四条：页头不重复日期 / 空态居中 CTA / 列表最大 720vp / 左栏按钮 240vp', () => {
  assert.match(INDEX, /const LIST_MAX_WIDTH: number = 720;/, '列表最大宽必须被常量约束（720vp ≈ 45–50 字/行）')
  assert.match(INDEX, /const SIDEBAR_ACTION_WIDTH: number = 240;/, '左栏主操作固定 240vp')
  assert.match(INDEX, /\.constraintSize\(\{ maxWidth: LIST_MAX_WIDTH \}\)/, '列表要居中限宽')
  assert.match(INDEX_CODE, /RecordRow\(\{[\s\S]{0,160}selected: this\.selectedId === item\.id/, '选中行要高亮')
  assert.match(INDEX_CODE, /showDialog\(/, '未保存冲突要弹确认框')
  assert.match(INDEX_CODE, /放弃当前编辑/, '冲突提示文案')
  assert.match(DETAIL_VIEW, /从左侧选一条日程查看/, '右栏空态文案在详情组件里')
  assert.match(INDEX, /subtitle: this\.subtitleText\(\)/, '页头副标题走 subtitleText()（空态不重复）')
  assert.equal(/return this\.tab === 'pending' \? '未完成' : this\.selectedDate;/.test(INDEX), false, '页头不能直接显示日期')
  assert.match(INDEX, /return this\.selectedDate === localDateKey\(new Date\(\)\) \? '今天' : '日程';/)
  assert.match(INDEX, /return '未完成';/, '未完成 tab 仍用于页头相对标签')
})

test('首页头只留「⚙ 设置」：AI 汇总图标入口已删除，也没有「更多」/ActionSheet', () => {
  assert.equal(/MoreSheet|this\.showMore/.test(INDEX), false, '首页不应再有「更多」底部面板');
  assert.equal(/onMore:/.test(INDEX), false, '首页不应把菜单挂在 PageLayout 的 onMore 上');
  assert.match(INDEX, /headerActionTwo: '⚙ 设置'/, '页头保留唯一动作「⚙ 设置」');
  // 用户反馈：页头 AI 汇总图标点了没反应但图标还在 → 整条入口删除（AI 汇总只在列表第一项）
  assert.equal(/headerActionOne|onHeaderActionOne/.test(INDEX), false, '页头不得再有第一个动作（✨ AI 汇总 入口）');
  assert.equal(/✨ AI 汇总/.test(INDEX), false, '页头「✨ AI 汇总」文案必须删除');
  assert.equal(/onHeaderSummaryAction/.test(INDEX), false, '页头汇总 handler 必须删除');
  assert.match(INDEX, /router\.pushUrl\(\{ url: 'pages\/Settings' \}\)/, '设置动作要能进设置页');
  assert.doesNotMatch(INDEX, /HOME_INCLUDE_OTHER_KEY/, 'v2-only：首页不再有「含其他设备」v1 过滤开关');
});

test('今日汇总块：持久化数据源（read/换日期 re-read/generate 失败不清空）', () => {
  const loadSummaryCalls = (INDEX_CODE.match(/this\.loadSummary\(\)/g) || []).length;
  assert.ok(loadSummaryCalls >= 4, `初始加载 + 换日期/回今天/返回前台都要重读，实际 ${loadSummaryCalls} 处`);
  assert.match(INDEX_CODE, /summaryStore\.ensureReady\(/, '初始化要与 scheduleStore 同款幂等 ready');
  // 失败分支必须重新 read 旧汇总，不能用空值覆盖 UI
  assert.match(INDEX_CODE, /this\.summaryError = describeError\(error\);\s*\n?\s*try \{\s*\n?\s*this\.applySummary\(summaryStore\.read\(this\.selectedDate\)\);/);
});

test('今日汇总块：是列表第一项，五态互斥，AI 汇总只从这里进入', () => {
  assert.match(INDEX_CODE, /this\.SummaryCard\(\)/, '汇总块必须被渲染');
  assert.match(INDEX_CODE, /✨ 今日汇总/);
  assert.match(INDEX_CODE, /actionLabel: '生成汇总'/, '无汇总时的生成入口走空态动作（A 批 STATE-UI §5）');
  assert.match(INDEX_CODE, /今天还没有日程/, '无日程要有灰字提示');
  assert.match(INDEX_CODE, /LoadingState\(\{/, '生成中要走 LoadingState（带进度与 3 秒后可取消）');
  assert.match(INDEX_CODE, /loadingText\('AI 汇总'\)/, '生成中文案走 copy.loadingText');
  assert.match(INDEX_CODE, /更新于 \$\{this\.summaryUpdatedAt\}/);
  assert.match(INDEX_CODE, /重新生成/);
  assert.match(INDEX_CODE, /查看全部/, '要点超过 3 条要有「查看全部」');
  assert.match(INDEX_CODE, /summaryStore\.read\(this\.selectedDate\)/, '汇总必须从持久化存储读取');
  assert.match(INDEX_CODE, /summaryStore\.generate\(/, '生成必须走 summaryStore（内部保证失败不覆盖）');
  assert.match(INDEX_CODE, /truncateSummaryForDisplay\(summary, SUMMARY_MAX_POINTS\)/, '块内最多展示 3 条要点');
  assert.equal(/applySummaryFromAiText/.test(INDEX_CODE), false, '旧的「解析自由文本」通道应已退休');
  // 页头已无 AI 汇总入口：生成的入口全部在汇总块内（生成/重试/重新生成）
  assert.equal(/headerActionOne/.test(INDEX_CODE), false, '页头不得再有 AI 汇总图标入口');
  const calls = (INDEX_CODE.match(/this\.generateSummary\(\)/g) || []).length;
  assert.ok(calls >= 3, `汇总生成入口应有生成行/重试/重新生成，实际 ${calls} 处`);
  // 空态文案只保留在汇总块里；旧的 EmptyHint 已删除，但 A 批后汇总块的空态必须走 EmptyState
  assert.equal(/EmptyHint/.test(INDEX_CODE), false, '旧的空态文案 builder 应已删除');
  assert.match(INDEX_CODE, /EmptyState\(\{/, '无汇总时的空态走 EmptyState（必须带下一步动作）');
});


test('提醒功能已删除：首页与设置页不再有提醒入口/文案/调用', () => {
  assert.equal(/createReminders|canRemind|isHarmonyOS/.test(INDEX_CODE), false, '首页不应再引用提醒能力');
  assert.equal(/提醒/.test(INDEX_CODE), false, '首页代码里不应再出现「提醒」文案');
  assert.equal(/提醒/.test(SETTINGS_CODE), false, '设置页代码里不应再出现「提醒」文案');
  assert.equal(/PANEL_AGC/.test(SETTINGS_CODE), false, 'AGC 帮助面板应已移除');
});


// mod-auto-sync 重定位：原用例钉住「含其他设备」开关 + 「立即同步」手动按钮；
// 手动按钮按新需求整体删除，这里改钉「开关仍在 + 手动同步按钮确实消失」，
// 既防旧按钮复活，也防开关被一起误删（断言不比原来弱）。
test('设置页同步组：主行可见「含其他设备」开关，无手动同步按钮', () => {
  assert.match(SETTINGS, /Toggle\(\{ type: ToggleType\.Switch, isOn: this\.includeOtherDevices \}\)/);
  assert.match(SETTINGS, /AppStorage\.setOrCreate<boolean>\(HOME_INCLUDE_OTHER_KEY, isOn\)/);
  assert.equal(/'立即同步'/.test(SETTINGS), false, '手动同步按钮文案必须删除');
  assert.equal(/label: '推送'/.test(SETTINGS), false, '手动推送按钮必须删除');
  assert.match(SETTINGS, /HOME_INCLUDE_OTHER_KEY/, '开关键必须来自 uiTokens，避免两处字号/键漂移');
});


test('PageLayout：onAreaChange + resolveBreakpoint + isLandscapeSize，且不把 Length 直接当 number', () => {
  assert.match(PAGE_LAYOUT, /\.onAreaChange\(/)
  assert.match(PAGE_LAYOUT, /resolveBreakpoint\(/)
  assert.match(PAGE_LAYOUT, /isLandscapeSize\(/)
  assert.match(PAGE_LAYOUT, /@State breakpoint: string/, '断点必须对外暴露为 @State')
  assert.match(PAGE_LAYOUT, /headerActionOne: string/, '标题栏要支持明确的动作标签');
  assert.match(PAGE_LAYOUT, /onHeaderActionTwo: \(\(\) => void\) \| null/, '第二个动作回调可为空');
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

test('masterPaneWidth：主栏夹在 360–420vp，窄屏退回屏幕宽', () => {
  assert.equal(masterPaneWidth(1280), 420, '1/3=427 应夹到 420 上限')
  assert.equal(masterPaneWidth(1080), 360, '1/3=360 正好下限')
  assert.equal(masterPaneWidth(900), 360, '1/3=300 应抬到 360 下限')
  assert.equal(masterPaneWidth(1200), 400, '1/3=400 保持在区间内')
  assert.equal(masterPaneWidth(320), 320, '屏幕比下限还窄时不要超出屏幕')
  assert.equal(masterPaneWidth(0), 360, '非法宽度回落 360')
  assert.equal(masterPaneWidth(Number.NaN), 360)
})

test('Detail / Edit 已改成薄壳：只做路由参数 + 复用组件，不再自带业务逻辑', () => {
  assert.match(DETAIL_PAGE, /RecordDetailView\(\{/)
  assert.match(EDIT_PAGE, /RecordEditorView\(\{/)
  for (const heavy of ['appendRecord', 'cloneRecord', 'attachmentStore']) {
    assert.equal(new RegExp(heavy).test(DETAIL_PAGE), false, `Detail.ets 不应再自带 ${heavy}`)
    assert.equal(new RegExp(heavy).test(EDIT_PAGE), false, `Edit.ets 不应再自带 ${heavy}`)
  }
  assert.equal(/summarize\(/.test(DETAIL_PAGE), false, 'Detail.ets 不应再直接调摘要')
})

test('两个可复用视图：入参与回调齐全，手写回填走 refreshTick + @Watch', () => {
  assert.match(DETAIL_VIEW, /@Prop recordId: string/)
  assert.match(DETAIL_VIEW, /@Prop( @Watch\('onRefreshTick'\))? refreshTick: number/)
  assert.match(DETAIL_VIEW, /onEdit: \(\(\) => void\) \| null/)
  assert.match(DETAIL_VIEW, /onAi: \(\(\) => void\) \| null/)
  assert.match(DETAIL_VIEW, /onDelete: \(\(\) => void\) \| null/)
  assert.match(EDITOR_VIEW, /onSaved: \(record: ScheduleRecord\) => void/)
  assert.match(EDITOR_VIEW, /onCancel: \(\(\) => void\) \| null/)
  assert.match(EDITOR_VIEW, /onDirtyChange: \(\(dirty: boolean\) => void\) \| null/)
  // ArkTS 要求 @Watch 挂在属性声明上（不能装饰方法），断言正确形态。
  assert.match(EDITOR_VIEW, /@Prop @Watch\('onRefreshTick'\) refreshTick: number/)
  assert.equal(/@Watch\('refreshTick'\)\s*\n\s*onRefreshTick/.test(EDITOR_VIEW), false, '@Watch 不能装饰方法')
  assert.match(EDITOR_VIEW, /AppStorage\.setOrCreate<string>\('handwriting\.result', ''\)/, '回填后必须清键')
  assert.match(EDITOR_VIEW, /handwritingPageRoute\(\)/, '手写板入口两种容器都可用')
})

test('主从右栏支持下拉刷新，且编辑有未保存内容时不推进 paneTick', () => {
  assert.match(INDEX_CODE, /@State paneRefreshing: boolean = false/, '右栏要有独立的刷新状态')
  assert.match(INDEX_CODE, /Refresh\(\{ refreshing: \$\$this\.paneRefreshing \}\)/, '右栏要用 Refresh 包住内容')
  assert.match(INDEX_CODE, /\.onRefreshing\(/, '右栏要处理下拉事件')
  assert.match(INDEX_CODE, /this\.onPullRefresh\(\)/, '复用左栏同一套 pull + reload 逻辑')
  assert.match(INDEX_CODE, /this\.paneMode === 'editor' && this\.editorDirty/, '编辑脏态要特殊处理')
  assert.match(INDEX_CODE, /this\.paneRefreshing = false/, '刷新结束必须复位')
})

// ---------------------------------------------------------------- 外壳断点 / 令牌 / 页头（S4 新增）
//
// 旧断言 → 新断言（都不是削弱）：
//   · 「PageLayout 用 onAreaChange + resolveBreakpoint + isLandscapeSize」→ U-S1：Home 复用同一套，且不写死 600/840；
//   · 「页头副标题走 subtitleText()/相对日期」→ U-S2：日程 pane 断言原样保留，外壳页头改钉分段标签；
//   · 「TOUCH_MIN / SPACING / FONT 常量与无裸色值」→ U-S3：轨道 240/72/48 + 同一套令牌；
//   · 「首页头只留 ⚙ 设置」→ U-S4：外壳唯一设置出口在 rail 齿轮，面板动作槽全禁用。
test('U-S1 外壳断点与 Index / PageLayout 同源：onAreaChange + resolveBreakpoint，compact <600 走抽屉', () => {
  assert.match(HOME, /\.onAreaChange\(/, 'Home 必须从 Area 取真实宽高')
  assert.match(HOME, /resolveBreakpoint\(width, isLandscapeSize\(width, height\)\)/, '断点判据必须复用 uiTokens')
  assert.match(HOME, /@State breakpoint: string/, '断点必须对外暴露为 @State')
  assert.match(HOME, /return this\.breakpoint === 'compact';/, '页面只判 compact 一档')
  assert.equal(/600|840/.test(HOME), false, '断点阈值只允许写在 uiTokens.ts / PageLayout，不得写死在本页')
  assert.match(HOME, /if \(this\.isCompact\(\) && this\.drawerOpen\)/, 'compact 抽屉蒙层分支')
  assert.match(HOME, /\.visibility\(this\.drawerOpen \? Visibility\.Visible : Visibility\.None\)/, '抽屉轨挂起')
  // 纯函数口径：599 → compact（抽屉）、600 → medium（常驻轨），与上一节的边界测试同源。
  assert.equal(resolveBreakpoint(599, false), 'compact')
  assert.equal(resolveBreakpoint(600, false), 'medium')
})

test('U-S2 外壳页头标题是分段标签；日程 pane 的相对日期标题契约仍在（不删旧断言）', () => {
  // 旧 PaneHeader 四行调用随 S3 拆成：三个占位各自带标签页头 + 日程面板的真 PageLayout 页头。
  const labels = ['dots', '远程 DSH', '云端对话']
  labels.forEach((label, index) => {
    assert.match(PANE_CODES[index], new RegExp(`Text\\('${label}'\\)`), `缺少分段标签「${label}」`)
    assert.match(PANE_CODES[index], /REASON_[A-Z]+/, `「${label}」必须写出禁用原因`)
  })
  assert.match(INDEX, /title: this\.pageTitle\(\)/, '日程面板标题仍走相对日期语义')
  assert.match(SHELL_RAIL, /label: 'dots'/)
  assert.match(SHELL_RAIL, /label: '日程'/)
  assert.match(SHELL_RAIL, /label: '云端对话'/)
  assert.equal(/pageTitle\(\)|subtitleText\(\)/.test(HOME), false, '相对日期标题属于日程面板，不属于外壳')
  // 旧断言已随 S3 迁到 pages/panes/SchedulePane.ets（锚点换了，断言不动）。
  assert.match(INDEX, /subtitle: this\.subtitleText\(\)/)
  assert.match(INDEX, /return this\.selectedDate === localDateKey\(new Date\(\)\) \? '今天' : '日程';/)
})

test('U-S3 导航轨尺寸令牌化：240 / 72 / 48 ≥ TOUCH_MIN，颜色全走 $r()', () => {
  const rail = stripComments(SHELL_RAIL)
  assert.match(rail, /const RAIL_WIDTH: number = 240;/, '常驻轨 240vp')
  assert.match(rail, /const RAIL_COMPACT_WIDTH: number = 72;/, '抽屉窄轨 72vp')
  assert.match(rail, /const RAIL_ROW_HEIGHT: number = 48;/, '四节与齿轮行同高 48vp')
  assert.ok(48 >= TOUCH_MIN, '行高 48 必须 ≥ TOUCH_MIN 40')
  for (const token of ['DIVIDER', 'FONT', 'LINE_HEIGHT', 'SPACING', 'TOUCH_MIN']) {
    assert.match(rail, new RegExp(`\\b${token}\\b`), `轨道必须引用令牌 ${token}`)
  }
  assert.equal(/(?:#[0-9A-Fa-f]{3,8}|Color\.[A-Z]|rgba?\()/.test(rail), false, '轨道不得写裸色值')
  assert.match(rail, /\.height\(RAIL_ROW_HEIGHT\)/, '节行与齿轮行同高')
})

test('U-S4 外壳只有一个设置出口：rail 齿轮 + 父页 openSettings，面板动作全禁用', () => {
  const rail = stripComments(SHELL_RAIL)
  const home = stripComments(HOME)
  assert.match(rail, /const SETTINGS_GLYPH: string = '⚙';/)
  assert.match(rail, /this\.SettingsRow\(\)/, '齿轮行必须渲染')
  assert.equal(/router|@kit\.ArkUI/.test(rail), false, 'rail 只发事件，不自己跳页')
  const pushes = home.match(/pushUrl\(\{ url: 'pages\/Settings' \}\)/g) ?? []
  assert.equal(pushes.length, 1, '外壳里只能有一处进设置页')
  assert.match(home, /private openSettings\(\): void/, '跳转集中在 openSettings()')
  const disabled = PANE_CODES.flatMap((code) => code.match(/\.enabled\(false\)/g) ?? [])
  assert.equal(disabled.length, 4, '三个占位动作槽 + dots 输入框禁用（随页头抽壳搬进各自文件）')
  // 旧断言未删：Index 仍钉着「页头唯一动作 ⚙ 设置」（S3 后随日程 pane body 迁移）。
  assert.match(INDEX, /headerActionTwo: '⚙ 设置'/)
})
