/**
 * 月视图日历面板：月视图 + 6×7 网格，替代系统 `DatePicker` 的「三列滚轮」交互。
 * 名字避开 ArkUI 内置日历组件（struct 与内置组件同名会编译失败）。
 *
 * 为什么不用 `DatePicker`：滚轮一次只能改一列，且要滚好几圈才能跳到「三个月前的某天」；
 * 月视图 + 固定 6×7 网格能一眼看到整月、点一下就跳过去，跨月补位格也是真实日期（直接可点）。
 * 网格数据全部来自纯逻辑 `model/calendar.ts`（Node 可单测），本组件只负责画与转发事件。
 *
 * 结构与交互：
 * - 头部：`‹  2026 年 11 月  ›` + 「今天」快捷按钮（四个可点区域都 ≥ `TOUCH_MIN`）；
 * - 星期表头：按 `weekStart` 排（默认周一为首列，中文习惯）；
 * - 网格：6 行 × 7 列，`@Builder dayCell(day)` 每格高 ≥ `TOUCH_MIN`；
 * - 选中态 = 品牌实底 + 反白字；今天 = 品牌描边 + 品牌字；非本月 = 次要色；
 * - 点日期 → `onPick(dateKey)`；点「关闭」→ `onClose()`；`closeOnBlank` 为 true 时点空白也关。
 *
 * 设计约束（`docs/UI-DESIGN.md`）：间距/圆角/字号全走 `uiTokens` 令牌，颜色全走
 * `$r('app.color.*')`（`resources/dark` 已覆盖同名色，深色模式自动跟随），不硬编码色值。
 *
 * 共享层组件：不含任何手写 / OCR / PixelMap 代码，Android 与 HarmonyOS 都能编译。
 */
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import { formatDateKey, monthGrid, parseDateKey, shiftMonth, weekdayLabels } from '../model/calendar';
import type { CalendarDay, CalendarMonth } from '../model/calendar';

/** 面板最大宽度（vp）：平板/主从布局下不要把 7 列拉成一整行。 */
const PANEL_MAX_WIDTH: number = 400;
/** 兜底年月（`value` 与 `todayKey` 都非法时才会用到，正常路径不会走到）。 */
const FALLBACK_YEAR: number = 1970;
/** 兜底月份。 */
const FALLBACK_MONTH: number = 1;
/** 合法年份上下界（与 `model/calendar.ts` 保持一致，用于拦住 ‹ › 翻出边界）。 */
const MIN_YEAR: number = 1;
/** 合法年份上界。 */
const MAX_YEAR: number = 9999;

@Component
export struct MonthCalendar {
  /** 当前选中的日期键 `YYYY-MM-DD`（空串 = 不画选中态）。 */
  @Prop @Watch('onValueChange') value: string = '';
  /** 今天的日期键，由页面用 `localDateKey(new Date())` 传入（空串 = 不标今天）。 */
  @Prop todayKey: string = '';
  /** 每周首日：0 = 周日，1 = 周一（默认）。 */
  @Prop weekStart: number = 1;
  /**
   * 是否允许「点空白关闭」。
   *
   * 默认 `false`：面板整体挂了点击响应，若页面把它放进自己的遮罩层里，让页面统一处理
   * 「点遮罩关闭」更可控（首页已有 `app.color.scrim` + 点击关闭的现成写法）。
   */
  @Prop closeOnBlank: boolean = false;
  /** 选中某天（点日期格 / 点「今天」）。 */
  onPick: (dateKey: string) => void = () => {};
  /** 关闭（点「关闭」；`closeOnBlank` 为 true 时点空白也走这里）。 */
  onClose: () => void = () => {};

  /** 当前展示的年（与选中日期解耦：可以翻到别的月份看，不改变选中）。 */
  @State viewYear: number = FALLBACK_YEAR;
  /** 当前展示的月（1–12）。 */
  @State viewMonth: number = FALLBACK_MONTH;
  /** 头部标题（`2026 年 11 月`；网格不可用时为空串）。 */
  @State monthTitle: string = '';
  /** 6 行 × 7 列网格（`inMonth` 决定字形颜色）。 */
  @State weeks: CalendarDay[][] = [];

  aboutToAppear(): void {
    this.syncToValue();
  }

  /** `value` 变化时跟随（页面若常驻本组件、只改 `value`，视图月也要跟着走）。 */
  onValueChange(): void {
    this.syncToValue();
  }

  /** 把视图月对齐到 `value`；`value` 非法时退回 `todayKey`，都不行才用兜底年月。 */
  private syncToValue(): void {
    let anchor = parseDateKey(this.value);
    if (anchor === null) {
      anchor = parseDateKey(this.todayKey);
    }
    if (anchor === null) {
      this.viewYear = FALLBACK_YEAR;
      this.viewMonth = FALLBACK_MONTH;
    } else {
      this.viewYear = anchor.year;
      this.viewMonth = anchor.month;
    }
    this.refreshGrid();
  }

  /** 重建网格与标题（唯一的数据入口，全部走纯逻辑）。 */
  private refreshGrid(): void {
    const grid: CalendarMonth = monthGrid(this.viewYear, this.viewMonth, this.weekStart, this.todayKey);
    if (grid.weeks.length === 0) {
      this.monthTitle = '';
      this.weeks = [];
      return;
    }
    this.monthTitle = grid.title;
    this.weeks = grid.weeks;
  }

  /** 翻月（`delta` 为 ±1）；翻出 1–9999 年就停住，不让网格变成不可用的空表。 */
  private shiftView(delta: number): void {
    const next = shiftMonth(this.viewYear, this.viewMonth, delta);
    if (next.year < MIN_YEAR || next.year > MAX_YEAR) {
      return;
    }
    this.viewYear = next.year;
    this.viewMonth = next.month;
    this.refreshGrid();
  }

  /** 「今天」：视图跳到今天所在月，并把今天交给 `onPick`（页面负责赋值 + 重载）。 */
  private pickToday(): void {
    const today = parseDateKey(this.todayKey);
    if (today === null) {
      return;
    }
    this.viewYear = today.year;
    this.viewMonth = today.month;
    this.refreshGrid();
    this.onPick(formatDateKey(today.year, today.month, today.day));
  }

  /** 该格是否为当前选中项。 */
  private isSelected(day: CalendarDay): boolean {
    return this.value.length > 0 && day.dateKey === this.value;
  }

  /** 该格是否需要「今天」描边（选中态优先级更高，不用再描边）。 */
  private needsTodayOutline(day: CalendarDay): boolean {
    return day.isToday && !this.isSelected(day);
  }

  /** 单元格文字色：选中 = 反白；今天 = 品牌色；本月 = 主文本；补位 = 次要文本。 */
  private dayTextColor(day: CalendarDay): Resource {
    if (this.isSelected(day)) {
      return $r('app.color.text_inverse');
    }
    if (day.isToday) {
      return $r('app.color.brand');
    }
    if (day.inMonth) {
      return $r('app.color.text_primary');
    }
    return $r('app.color.text_secondary');
  }

  /**
   * `ForEach` 的键必须带上「选中 / 今天」状态。
   *
   * `ForEach` 按 key 做增量更新：只把 `dateKey` 当键时，切换选中日期（`value` 变了但网格没变）
   * 不会重建格子，选中高亮就会停在旧日期上。把状态塞进键里，状态一变键就变，格子必然重建。
   */
  private dayCellKey(day: CalendarDay): string {
    const selected = this.isSelected(day) ? '1' : '0';
    const today = day.isToday ? '1' : '0';
    return `${day.dateKey}|${today}|${selected}`;
  }

  /** 整周的行键（行内 7 格的键由 `dayCellKey` 负责）。 */
  private weekRowKey(week: CalendarDay[], rowIndex: number): string {
    const first = week.length > 0 ? week[0].dateKey : '';
    return `${rowIndex}|${first}`;
  }

  /** 头部：`‹  2026 年 11 月  ›` + 「今天」。 */
  @Builder
  MonthNav() {
    Row({ space: SPACING.xs }) {
      Text('‹')
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontColor($r('app.color.brand'))
        .width(TOUCH_MIN)
        .height(TOUCH_MIN)
        .textAlign(TextAlign.Center)
        .accessibilityText('上一个月')
        .onClick(() => {
          this.shiftView(-1);
        })

      Text(this.monthTitle.length > 0 ? this.monthTitle : '—')
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      Text('›')
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontColor($r('app.color.brand'))
        .width(TOUCH_MIN)
        .height(TOUCH_MIN)
        .textAlign(TextAlign.Center)
        .accessibilityText('下一个月')
        .onClick(() => {
          this.shiftView(1);
        })

      Text('今天')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.brand'))
        .height(TOUCH_MIN)
        .padding({ left: SPACING.sm, right: SPACING.sm })
        .textAlign(TextAlign.Center)
        .onClick(() => {
          this.pickToday();
        })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 星期表头（首列跟随 `weekStart`）。 */
  @Builder
  WeekdayHeader() {
    Row() {
      ForEach(
        weekdayLabels(this.weekStart),
        (label: string) => {
          Text(label)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .layoutWeight(1)
            .height(SPACING.xl)
            .textAlign(TextAlign.Center)
        },
        (label: string) => label
      )
    }
    .width('100%')
  }

  /** 单个日期格：高度 ≥ `TOUCH_MIN`，选中 = 品牌底反白，今天 = 品牌描边。 */
  @Builder
  dayCell(day: CalendarDay) {
    Column() {
      Text(`${day.day}`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor(this.dayTextColor(day))
        .textAlign(TextAlign.Center)
        .maxLines(1)
    }
    .layoutWeight(1)
    .height(TOUCH_MIN)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .borderRadius(RADIUS.sm)
    .backgroundColor(this.isSelected(day) ? $r('app.color.brand') : $r('app.color.surface'))
    .border({
      width: this.needsTodayOutline(day) ? DIVIDER : 0,
      color: $r('app.color.brand')
    })
    .onClick(() => {
      this.onPick(day.dateKey);
    })
  }

  /** 6 行 × 7 列网格。 */
  @Builder
  MonthGrid() {
    Column({ space: SPACING.xs }) {
      ForEach(
        this.weeks,
        (week: CalendarDay[]) => {
          Row() {
            ForEach(
              week,
              (day: CalendarDay) => {
                this.dayCell(day);
              },
              (day: CalendarDay) => this.dayCellKey(day)
            )
          }
          .width('100%')
        },
        (week: CalendarDay[], rowIndex: number) => this.weekRowKey(week, rowIndex)
      )
    }
    .width('100%')
  }

  /** 底部：关闭（右对齐，触控高 40vp）。 */
  @Builder
  Footer() {
    Row() {
      Text('关闭')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .height(TOUCH_MIN)
        .padding({ left: SPACING.md, right: SPACING.md })
        .textAlign(TextAlign.Center)
        .onClick(() => {
          this.onClose();
        })
    }
    .width('100%')
    .justifyContent(FlexAlign.End)
  }

  build() {
    Column({ space: SPACING.sm }) {
      this.MonthNav()
      this.WeekdayHeader()
      if (this.weeks.length > 0) {
        this.MonthGrid()
      }
      this.Footer()
    }
    .width('100%')
    .constraintSize({ maxWidth: PANEL_MAX_WIDTH })
    .padding(SPACING.lg)
    .backgroundColor($r('app.color.surface'))
    .borderRadius(RADIUS.md)
    .border({ width: DIVIDER, color: $r('app.color.divider') })
    .onClick(() => {
      if (this.closeOnBlank) {
        this.onClose();
      }
    })
  }
}
