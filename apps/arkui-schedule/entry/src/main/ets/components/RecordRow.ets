/**
 * 日程列表行：左勾选 / 中标题 + 时间 + 记录者 / 右 📎 手迹标记。
 *
 * 契约：BRIEF §3.5「列表行（左 Checkbox 勾选写回、中标题+截止时间、右 📎 表示有手迹附件）」。
 * 共享层组件：只读记录字段，勾选与进详情通过回调交给页面（页面负责追加写回）。
 */
import { formatClock } from '../common/date';
import { recordDateKey } from '../model/jsonl';
import type { ScheduleRecord } from '../model/types';

@Component
@crossplatform
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
  /** 点击行回调：进入详情。 */
  onOpen: (id: string) => void = () => {};

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

  build() {
    Row({ space: 8 }) {
      Checkbox({ name: `record-${this.record.id}` })
        .select(this.record.done)
        .selectedColor($r('app.color.brand'))
        .width(24)
        .height(24)
        .onChange((value: boolean) => {
          if (value !== this.record.done) {
            this.onToggle(this.record.id, value);
          }
        })

      Column({ space: 6 }) {
        Text(this.displayTitle())
          .fontSize(16)
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

        Row({ space: 10 }) {
          Text(this.timeLabel())
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
          if (this.record.author.length > 0) {
            Text(this.record.author)
              .fontSize(12)
              .fontColor($r('app.color.text_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          if (this.attachmentCount() > 0) {
            Text(`📎 ${this.attachmentCount()} 页`)
              .fontSize(12)
              .fontColor($r('app.color.brand'))
          }
          if (this.record.ai_structured !== undefined && this.record.ai_structured.length > 0) {
            Text('AI 已整理')
              .fontSize(11)
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

      Text('›')
        .fontSize(20)
        .fontColor($r('app.color.text_secondary'))
        .onClick(() => {
          this.onOpen(this.record.id);
        })
    }
    .width('100%')
    .padding(12)
    .backgroundColor(Color.White)
    .borderRadius(12)
    .alignItems(VerticalAlign.Center)
  }
}
