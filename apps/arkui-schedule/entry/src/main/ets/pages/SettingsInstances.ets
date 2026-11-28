/**
 * 设置子页：实例删除（mod-app-instance-delete-in-settings）。
 *
 * 删除入口**只在本页**：首页「远程 DSH」面板与设置里的 `pages/Instances`（`InstancesPane`）都
 * 只保留打开 / 配对 / 编辑，绝无滑动删除、长按菜单或行尾删除图标，避免日常使用时误删。
 *
 * 「彻底删干净」的一次确认写三处，顺序固定：
 * 1. `instanceGrantStore.revokeAllForInstance(id, nowMs)`：该实例的全部授权记录被移除
 *    （不留 dangling instanceId），其它实例的授权逐字不动；授权表今天可能本来就是空的，
 *    所以文案保留「如果从未授权过，这里是空的」。
 * 2. `instanceStore.remove(id)`：整条实例记录（含 token / tlsFingerprint / pairingInstanceId）
 *    一次整表替换消失，并写墓碑，使旧地址在下次启动 `ensureSeeded()` 时也不能复活。
 * 3. `settingsStore.save({ remoteUrl: '', remoteLastOk: '' }, context)`：旧播种镜像本身清空，
 *    即使将来有别的播种路径读它也不会重新造出这条实例。
 *
 * **不碰** `git-repo/chats/**` 与同步 outbox：它们按 repo 归档、由所有实例共享，清掉会让
 * 其它实例的聊天列表一起变空；确认 sheet 的文案逐字说明这一点。
 *
 * 确认是两步：先在本页点「删除实例」打开 bindSheet，再在 sheet 里点「删除实例」或「取消」。
 * 已打开的实例允许删除：页面 URL 已加载，关掉前继续可用；不杀会话、不假装被拦住。
 * sheet 的全部文案来自 `model/instanceDelete.ts` 的 `deletePlanOf()`，页面不自己拼规则。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { DIVIDER, FONT, LINE_HEIGHT, SPACING } from '../common/uiTokens';
import { PageLayout } from '../components/PageLayout';
import { ActionButton } from '../components/ActionButton';
import { instanceStore } from '../services/instanceStore';
import { instanceGrantStore } from '../services/instanceGrantStore';
import { settingsStore } from '../services/settingsStore';
import { describeError } from '../services/scheduleStore';
import { problemText, redactUrl } from '../model/instances';
import type { RedactedInstance, InstanceProblem } from '../model/instances';
import { deletePlanOf } from '../model/instanceDelete';
import type { DeletePlan } from '../model/instanceDelete';

@Entry
@Component
struct SettingsInstances {
  /** store 的打码视图（结构上没有 token）。 */
  @State views: RedactedInstance[] = [];
  /** 存储 typed 问题码；读不到就说读不到，不伪造空表。 */
  @State problem: InstanceProblem = 'ok';
  /** 正在确认的实例 id（空串 = 没有待确认项）。 */
  @State pendingId: string = '';
  /** sheet 文案：纯模型的确认计划，不在此处拼规则。 */
  @State plan: DeletePlan = deletePlanOf(null);
  /** 确认 sheet 是否打开（bindSheet 唯一开关）。 */
  @State showDeleteSheet: boolean = false;
  /** 删除进行中：重复点击不产生第二次写。 */
  @State busy: boolean = false;
  /** 结果 / 失败说明（空串 = 不显示）。 */
  @State hint: string = '';

  aboutToAppear(): void {
    this.reload();
  }

  /** 读真实实例表与 typed 问题码；只消费打码视图。 */
  private reload(): void {
    this.views = instanceStore.redacted();
    this.problem = instanceStore.lastProblem();
  }

  /** 第一步：选中一行只打开确认 sheet，不写任何数据。 */
  private askDelete(view: RedactedInstance): void {
    this.pendingId = view.id;
    this.plan = deletePlanOf(view);
    this.showDeleteSheet = true;
  }

  /** 取消：sheet 关闭、待确认项清空，不写任何数据。 */
  private cancelDelete(): void {
    this.showDeleteSheet = false;
    this.pendingId = '';
    this.plan = deletePlanOf(null);
  }

  /** 第二步：一次确认里的三处写入；任何一步失败都如实说明，绝不声称已删干净。 */
  private async confirmDelete(): Promise<void> {
    const id: string = this.pendingId;
    if (this.busy || id.length === 0) {
      return;
    }
    this.busy = true;
    try {
      instanceGrantStore.revokeAllForInstance(id, Date.now());
      instanceStore.remove(id);
      const context = getContext(this) as common.UIAbilityContext;
      // 旧播种镜像与配对令牌一并清空：remoteToken 是配对密钥，删实例后不得留在偏好里。
      await settingsStore.save({ remoteUrl: '', remoteLastOk: '', remoteToken: '' }, context);
      this.showDeleteSheet = false;
      this.pendingId = '';
      this.plan = deletePlanOf(null);
      this.hint = '实例已删除；聊天缓存与同步队列属于仓库，未受影响';
      promptAction.showToast({ message: '实例已删除' });
      this.reload();
    } catch (error) {
      this.hint = `删除未完成：${describeError(error)}`;
    } finally {
      this.busy = false;
    }
  }

  /** 确认 sheet：逐字渲染纯模型给的行， destructive 动词与取消都来自同一份计划。 */
  @Builder
  DeleteConfirmSheet() {
    Column({ space: SPACING.md }) {
      Text(this.plan.title)
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      ForEach(this.plan.lines, (line: string) => {
        Text(line)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
      }, (line: string) => line)
      Row({ space: SPACING.sm }) {
        Column() {
          ActionButton({
            label: this.plan.cancelLabel,
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'secondary',
            block: true,
            onTap: (): void => {
              this.cancelDelete();
            },
            onBlockedTap: null
          })
        }
        .layoutWeight(1)
        Column() {
          ActionButton({
            label: this.plan.confirmLabel,
            actionEnabled: true,
            disabledReason: '',
            busy: this.busy,
            variant: 'danger',
            block: true,
            onTap: (): void => {
              this.confirmDelete();
            },
            onBlockedTap: null
          })
        }
        .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding(SPACING.lg)
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      PageLayout({
        title: '删除实例',
        subtitle: '',
        onBack: () => {
          router.back();
        }
      }) {
        Scroll() {
          Column({ space: SPACING.md }) {
            Text('只在这里删除实例；首页与「远程实例」页只有打开 / 配对 / 编辑。')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
              .textAlign(TextAlign.Start)
            ForEach(this.views, (view: RedactedInstance) => {
              Column({ space: SPACING.xs }) {
                Text(view.name)
                  .fontSize(FONT.body)
                  .lineHeight(LINE_HEIGHT.body)
                  .fontColor($r('app.color.text_primary'))
                  .width('100%')
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .textAlign(TextAlign.Start)
                // 展示路径唯一出口：store 已 redactInstance()，这里再过 redactUrl() 兜底
                Text(redactUrl(view.url))
                  .fontSize(FONT.caption)
                  .lineHeight(LINE_HEIGHT.caption)
                  .fontColor($r('app.color.text_secondary'))
                  .width('100%')
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .textAlign(TextAlign.Start)
                ActionButton({
                  label: '删除实例',
                  actionEnabled: true,
                  disabledReason: '',
                  busy: false,
                  variant: 'danger',
                  block: false,
                  onTap: (): void => {
                    this.askDelete(view);
                  },
                  onBlockedTap: null
                })
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
              .padding({ top: SPACING.md, bottom: SPACING.md })
              .borderRadius(0)
              Divider()
                .strokeWidth(DIVIDER)
                .color($r('app.color.divider'))
            }, (view: RedactedInstance) => view.id)
            if (this.problem !== 'ok') {
              Text(problemText(this.problem))
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor($r('app.color.danger'))
                .width('100%')
                .textAlign(TextAlign.Start)
            }
            if (this.hint.length > 0) {
              Text(this.hint)
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor($r('app.color.text_secondary'))
                .width('100%')
                .textAlign(TextAlign.Start)
            }
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding({ bottom: SPACING.xl })
        }
        .width('100%')
        .height('100%')
        .scrollBar(BarState.Off)
        .align(Alignment.TopStart)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
    .bindSheet(this.showDeleteSheet, this.DeleteConfirmSheet(), {
      height: SheetSize.MEDIUM,
      dragBar: true,
      showClose: true,
      onDisappear: (): void => {
        this.showDeleteSheet = false;
      }
    })
  }
}
