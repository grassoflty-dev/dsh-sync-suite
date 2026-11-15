/**
 * 日程列表行：左勾选 / 中标题 + 时间 + 记录者 / 右手迹标记。
 *
 * 约定：BRIEF §3.5「列表行（左 Checkbox 勾选写回、中标题+截止时间、右图标表示有手迹附件）」。
 * 共享层组件：只读记录字段，勾选与进详情通过回调交给页面（页面负责追加写回）。
 *
 * 设计（`docs/UI-DESIGN.md`）：
 * - 不再用「白卡片 + 圆角 + 间距」分隔行，改为**行 + 1vp 细分割线**（去掉卡片层）；
 * - 勾选区从 24vp 放大到 40vp（`TOUCH_MIN`），整行高度 ≥ 56vp；
 * - 字号只用两级：标题 16fp（正文级）、时间/记录者 14fp（辅助级）。
 */
import { formatClock } from '../common/date';
import { recordDateKey } from '../model/jsonl';
import type { ScheduleRecord } from '../model/types';
import { DIVIDER, FONT, LINE_HEIGHT, SPACING, TOUCH_MIN } from '../common/uiTokens';

@Component
export struct RecordRow {
  /** 展示用的日程记录（父组件重新加载列表时整体替换，触发刷新）。 */
  @Prop record: ScheduleRecord = {
    id: '',
    ts: '',
    title: '',
    body: '',
    author: '',
    done: false,
    ai_processed: false
  };
  /** 勾选回调：页面负责 appendRecord 追加新记录。 */
  onToggle: (id: string, done: boolean) => void = () => {};
  /** 点击行回调：进入详情（紧凑屏跳页 / 主从布局切右栏）。 */
  onOpen: (id: string) => void = () => {};
  /** 是否选中（主从布局的左侧列表用：浅蓝底 + 2vp 品牌竖条）。 */
  @Prop selected: boolean = false;

  private attachmentCount(): number {
    const list = this.record.attachments;
    return list === undefined ? 0 : list.length;
  }

  private displayTitle(): string {
    const title = this.record.title.trim();
    return title.length > 0 ? title : '(未命名日程)';
  }

  /** 时间标签：同日显示 HH:MM，跨日补日期。 */
  private timeLabel(): string {
    const clock = formatClock(this.record.ts);
    const date = recordDateKey(this.record.ts);
    const at = clock.length > 0 ? clock : this.record.ts;
    return date.length === 10 ? `${date} ${at}` : at;
  }

  private hasAi(): boolean {
    return this.record.ai_structured !== undefined && this.record.ai_structured.length > 0;
  }

  build() {
    Column() {
      Row({ space: SPACING.sm }) {
        Checkbox({ name: `record-${this.record.id}` })
          .select(this.record.done)
          .selectedColor($r('app.color.brand'))
          .width(TOUCH_MIN)
          .height(TOUCH_MIN)
          .onChange((value: boolean) => {
            if (value !== this.record.done) {
              this.onToggle(this.record.id, value);
            }
          })

        Column({ space: SPACING.xs }) {
          Text(this.displayTitle())
            .fontSize(FONT.body)
            .lineHeight(LINE_HEIGHT.body)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.record.done ? $r('app.color.text_secondary') : $r('app.color.text_primary'))
            .decoration({
              type: this.record.done ? TextDecorationType.LineThrough : TextDecorationType.None,
              color: $r('app.color.text_secondary')
            })
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .textAlign(TextAlign.Start)

          Row({ space: SPACING.sm }) {
            Text(this.timeLabel())
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
            if (this.record.author.length > 0) {
              Text(this.record.author)
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor($r('app.color.text_secondary'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            if (this.attachmentCount() > 0) {
              Text(`手迹 ${this.attachmentCount()}`)
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor($r('app.color.brand'))
            }
            if (this.hasAi()) {
              Text('AI 已整理')
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor($r('app.color.brand'))
            }
          }
          .width('100%')
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .onClick(() => {
          this.onOpen(this.record.id);
        })
      }
      .width('100%')
      .padding({ top: SPACING.md, bottom: SPACING.md })
      .alignItems(VerticalAlign.Center)
      .backgroundColor(this.selected ? $r('app.color.brand_soft') : $r('app.color.page_background'))
      .border({
        width: { left: this.selected ? 2 : 0 },
        color: { left: $r('app.color.brand') }
      })

      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
    }
    .width('100%')
  }
}
