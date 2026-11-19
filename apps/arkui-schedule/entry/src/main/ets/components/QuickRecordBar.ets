/**
 * 首页列表区底部的快捷记录条：输入标题 → 直接落盘到当前所选日期，不跳编辑页。
 *
 * 本组件只负责「收标题 + 成功才清空」这两件事，**不碰日期、不写存储、成功不弹 toast**：
 * - 日期取首页当前所选日期，由父页面在回调里传给 `planQuickRecord`，这里没有日期 UI；
 * - 落盘 / 报错 / 「已记下」反馈全在父页面的 `submitQuickRecord` 里，避免两处各弹一次；
 * - `onSubmit` 返回 `true` 才清空输入框：失败时保留原文，用户可以直接改了重试。
 *
 * 为什么保存键用全站唯一的 `ActionButton`（`docs/STATE-UI.md` §3）：ArkUI 的 `enabled` 修饰符
 * 会把点击事件一起吞掉，用户点不动又不知道为什么。`ActionButton` 永远可点，不可用时由它自己
 * 用 `disabledReason` 说出原因；因此这里的空标题 / 忙碌提示既走按钮的禁用原因，也在 `handleSave`
 * 里留一道防御（键盘或未来入口直接调回调时仍然正确）。
 *
 * 设计约束（`docs/UI-DESIGN.md`）：间距 / 圆角 / 字号 / 触控高度全走 `uiTokens` 令牌，颜色全走
 * `$r('app.color.*')`（`resources/dark` 已覆盖同名色，深色模式自动跟随），不硬编码色值。
 *
 * 关于回车提交：`TextInput.onSubmit` 的 ArkTS 事件签名在本环境无法验证（无 DevEco / SDK），
 * 为避免引入编译不过的 API，本版**只用「保存」按钮提交**，没有绑键盘回车事件；
 * 回车提交待真机验证后再接线（占位符也相应不再承诺回车）。
 */
import { promptAction } from '@kit.ArkUI';
import { toastMsFor } from '../common/copy';
import { FONT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import { ActionButton } from './ActionButton';

@Component
export struct QuickRecordBar {
  /** 父页面保存中：忙碌时按钮不可点，避免重复提交（正常同步落盘，一闪而过）。 */
  @Prop busy: boolean = false;
  /** 输入框内容（受控：保存成功后由本组件清空）。 */
  @State text: string = '';
  /**
   * 提交回调：父页面负责真正落盘。
   * 返回 `true` = 已保存，本组件清空输入框；返回 `false` = 失败，保留原文供重试。
   */
  onSubmit: (title: string) => boolean = () => false;

  /** 保存按钮当前不可用的原因：交给 `ActionButton` 自己弹 toast，不重复打扰用户。 */
  private disabledReason(): string {
    return this.busy ? '正在保存，请稍候' : '请输入标题';
  }

  /** 点击「保存」：空标题给出可执行提示；否则交给父页面，只有保存成功才清空。 */
  private handleSave(): void {
    if (this.text.trim().length === 0) {
      promptAction.showToast({ message: '请输入标题', duration: toastMsFor(true) });
      return;
    }
    const saved: boolean = this.onSubmit(this.text);
    if (saved) {
      this.text = '';
    }
  }

  build() {
    Row({ space: SPACING.sm }) {
      TextInput({ text: this.text, placeholder: '快速记一条：标题，点「保存」' })
        .fontSize(FONT.body)
        .placeholderFont({ size: FONT.caption })
        .fontColor($r('app.color.text_primary'))
        .height(TOUCH_MIN)
        .backgroundColor($r('app.color.surface'))
        .borderRadius(RADIUS.sm)
        .padding({ left: SPACING.md, right: SPACING.md })
        .layoutWeight(1)
        .onChange((value: string) => {
          this.text = value;
        })

      ActionButton({
        label: '保存',
        actionEnabled: !this.busy && this.text.trim().length > 0,
        disabledReason: this.disabledReason(),
        busy: this.busy,
        variant: 'primary',
        block: false,
        onTap: (): void => {
          this.handleSave();
        }
      })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }
}
