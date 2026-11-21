/**
 * 远程 DSH 面板（mod-shell-instances-pane）：从 pages/Instances.ets 迁入的真实实例列表。
 *
 * 逐字承接原页的实例正文：本机首行 / 远程行（名称 + 方式徽章 + 可达三态 + 相对 lastSeen +
 * 打码 URL）/ 三动作（打开 / 编辑 / 删除；本机无删除、编辑不显示地址框）/ typed 问题行 /
 * 空态 / 首次播种与旧配置迁移。令牌纪律不变：只渲染 store.redacted() 的视图，URL 再过 redactUrl()。
 *
 * 对外契约（Home 的四面板装配）：
 *   - `deepLinkId: string`：深链携带的实例 id，预留给「按 id 打开指定实例」，当前不消费；
 *   - `active: boolean`：由 Home 按当前分段传入，根 Scroll 据此在 Visible / Hidden 间切换；
 *     Hidden 留在树上，@State / 滚动位置 / 表单面板状态不丢。
 *
 * 布局纪律：根 Scroll + 自带分段页头，没有固定高度 Column 包裹层；行内名称 / 页头标题的
 * layoutWeight(1) 只是省略号，不是整页的第二层 flex 切分（整页唯一的切分在 Home.build()）。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common, Want } from '@kit.AbilityKit';
import { ActionButton } from '../../components/ActionButton';
import { EmptyState } from '../../components/state/EmptyState';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../../common/uiTokens';
import {
  LOCAL_INSTANCE_ID,
  instanceIdFromUrl,
  normalizeInstance,
  problemText,
  redactUrl
} from '../../model/instances';
import type { DsInstance, InstanceProblem, RawInstance, RedactedInstance } from '../../model/instances';
import { reachabilityLabel, relativeLastSeen } from '../../model/instanceSeed';
import { REMOTE_MODE_LAN, REMOTE_MODE_ORDER, findRemoteMode } from '../../model/remoteAccess';
import { mergeRemoteToken, normalizeRemoteUrl, routeToRemote, stripRemoteToken } from '../../model/remoteUrl';
import { instanceStore } from '../../services/instanceStore';
import { settingsStore } from '../../services/settingsStore';
import { describeError } from '../../services/scheduleStore';

/** 系统浏览器的 dataability 动作（空态次操作「用浏览器打开」兜底）。 */
const ACTION_VIEW_DATA: string = 'ohos.want.action.viewData';

/** 空态文案：§1 逐字口径（标题 + 指引 + 主操作 + 次操作）。 */
const EMPTY_TITLE: string = '还没有可管理的 DSH 实例';
const EMPTY_DETAIL: string =
  '在电脑 DSH → 远程访问 → 启动并点「显示二维码与链接」，把地址粘进来；本机（默认）实例会自动出现';
const EMPTY_ACTION: string = '添加实例';
const EMPTY_SECONDARY: string = '用浏览器打开';

/** 面板模式：空 = 收起；`add` = 添加实例；`edit` = 编辑当前行。 */
const PANEL_ADD: string = 'add';
const PANEL_EDIT: string = 'edit';

@Component
export struct InstancesPane {
  /** 深链 id：预留给后续按 id 打开指定实例。 */
  @Prop deepLinkId: string = '';
  /** 保活可见性：Home 当前分段为 instances 时传 true。 */
  @Prop active: boolean = true;

  /** 实例真身（只供打开 / 编辑取 token / 原值，不直接进 Text）。 */
  @State rows: DsInstance[] = [];
  /** 渲染视图：结构上没有 token，URL 已由 store 的 `redacted()` 打码。 */
  @State views: RedactedInstance[] = [];
  /** 存储 typed 问题码（坏信封 / 存储不可用）。 */
  @State problem: InstanceProblem = 'ok';
  /** 首次加载中（避免闪一帧空态）。 */
  @State loading: boolean = true;
  /** 添加 / 编辑面板模式。 */
  @State panelMode: string = '';
  /** 正在编辑的 id（添加时空串）。 */
  @State formId: string = '';
  /** 表单：名称 / 地址（本机不显示地址框）/ 方式。 */
  @State formName: string = '';
  @State formUrl: string = '';
  @State formMode: string = REMOTE_MODE_LAN;
  /** 表单错误文案（中文，永不回显 token）。 */
  @State formError: string = '';

  /** 页面是否已销毁（异步 bootstrap 回来后不再 setState）。 */
  private disposed: boolean = false;
  /** 下拉框顺序与 `REMOTE_MODE_ORDER` 同源。 */
  private modeOptions: string[] = REMOTE_MODE_ORDER.slice();

  aboutToAppear(): void {
    this.bootstrap();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  onPageShow(): void {
    if (!this.disposed) {
      this.reload();
    }
  }

  // ------------------------------------------------------------------ 数据

  /** 读一次旧设置做幂等播种；读失败也要保证本机首行出现（旧迁移留空、不算失败）。 */
  private async bootstrap(): Promise<void> {
    try {
      const settings = await settingsStore.load(getContext(this) as common.UIAbilityContext);
      if (!this.disposed) {
        instanceStore.ensureSeeded({
          remoteUrl: settings.remoteUrl,
          remoteLastOk: settings.remoteLastOk,
          remoteMode: settings.remoteMode,
          // 旧令牌与地址分开存，必须一并迁进实例行（mod-settings-remote-dedupe）
          remoteToken: settings.remoteToken
        });
      }
    } catch (error) {
      // 设置读不到不影响实例表：只播种本机，不在 UI 回显错误细节
      if (!this.disposed) {
        instanceStore.ensureSeeded({ remoteUrl: '', remoteLastOk: '', remoteMode: '', remoteToken: '' });
      }
    }
    if (!this.disposed) {
      this.reload();
    }
  }

  /** 内存镜像 → 两组状态：真身给动作、打码视图给渲染。 */
  private reload(): void {
    this.rows = instanceStore.list();
    this.views = instanceStore.redacted();
    this.problem = instanceStore.lastProblem();
    this.loading = false;
  }

  /** 按 id 取真身（只为拼一次性打开地址 / 保留令牌，不参与渲染）。 */
  private fullOf(id: string): DsInstance | null {
    for (const item of this.rows) {
      if (item.id === id) {
        return item;
      }
    }
    return null;
  }

  /** 方式徽章：六种枚举给中文标签，未知值原样显示（不猜、不回落）。 */
  private modeLabel(mode: string): string {
    const spec = findRemoteMode(mode);
    return spec === null ? mode : spec.label;
  }

  /** 表单下拉选项（顺序 = REMOTE_MODE_ORDER，标签取自唯一的枚举元数据表）。 */
  private modeSelectOptions(): SelectOption[] {
    const options: SelectOption[] = [];
    for (const mode of this.modeOptions) {
      options.push({ value: this.modeLabel(mode) });
    }
    return options;
  }

  /** 当前方式在下拉里的下标（未知值按第 0 项，保证 `Select.selected` 合法）。 */
  private modeIndex(): number {
    const index: number = this.modeOptions.indexOf(this.formMode);
    return index >= 0 ? index : 0;
  }

  // ------------------------------------------------------------------ 动作

  /**
   * 打开：复用 `RemoteControl` 的内嵌 Web。远程行把 base 与一次性 token 现拼，
   * 本机行走参数缺省（`RemoteControl` 自己回退到 `settingsStore.remoteUrl`）。
   * 跳转成功记 ok、跳转抛错记 fail；Web 加载失败由 RemoteControl 自己的错误卡负责。
   */
  private openInstance(view: RedactedInstance): void {
    const full: DsInstance | null = this.fullOf(view.id);
    const params: Record<string, string> = {};
    if (view.id !== LOCAL_INSTANCE_ID && full !== null) {
      const token: string = full.token === undefined ? '' : full.token;
      const url: string = mergeRemoteToken(full.url, token);
      if (url.length > 0) {
        params['url'] = url;
      }
    }
    router
      .pushUrl({ url: routeToRemote(), params: params })
      .then((): void => {
        instanceStore.markReachable(view.id, 'ok', Date.now());
        this.reload();
      })
      .catch((): void => {
        instanceStore.markReachable(view.id, 'fail', Date.now());
        this.reload();
      });
  }

  /** 打开添加面板（空态主操作与错误行的「重新添加」共用）。 */
  private showAdd(): void {
    this.panelMode = PANEL_ADD;
    this.formId = '';
    this.formName = '';
    this.formUrl = '';
    this.formMode = REMOTE_MODE_LAN;
    this.formError = '';
  }

  /** 打开编辑面板；本机行只带名称（URL 输入框按 §2「本机不可改 URL」隐藏）。 */
  private showEdit(view: RedactedInstance): void {
    const full: DsInstance | null = this.fullOf(view.id);
    this.panelMode = PANEL_EDIT;
    this.formId = view.id;
    this.formName = view.name;
    this.formUrl = full === null ? '' : full.url;
    this.formMode = view.mode;
    this.formError = '';
  }

  /** 面板下拉：下标 → 六方式枚举。 */
  private pickMode(index: number): void {
    if (index >= 0 && index < this.modeOptions.length) {
      this.formMode = this.modeOptions[index];
    }
  }

  /** 保存：先归一（旧裸地址补 http://），再交给 store 的 typed upsert；坏值只出中文原因。 */
  private submitForm(): void {
    const name: string = this.formName.trim();
    if (name.length === 0) {
      this.formError = '实例名称不能为空';
      return;
    }
    if (this.formId === LOCAL_INSTANCE_ID) {
      const result = normalizeInstance({ id: LOCAL_INSTANCE_ID, name: name, mode: REMOTE_MODE_LAN });
      if (!result.ok || result.instance === null) {
        this.formError = result.reason;
        return;
      }
      instanceStore.upsert(result.instance);
      this.panelMode = '';
      this.reload();
      return;
    }
    const check = normalizeRemoteUrl(this.formUrl.trim());
    if (!check.ok) {
      this.formError = `地址不可用：${check.reason}`;
      return;
    }
    const id: string = instanceIdFromUrl(check.url);
    if (id.length === 0) {
      this.formError = '地址不可用：请填写完整的 http(s) 地址';
      return;
    }
    const existing: DsInstance | null = this.fullOf(this.formId);
    const raw: RawInstance = {
      id: id,
      name: name,
      url: check.url,
      mode: this.formMode,
      reachable: existing === null ? 'unknown' : existing.reachable
    };
    if (existing !== null && existing.token !== undefined && existing.token.length > 0) {
      raw.token = existing.token;
    }
    if (existing !== null && existing.lastSeen !== undefined && existing.lastSeen > 0) {
      raw.lastSeen = existing.lastSeen;
    }
    const result = normalizeInstance(raw);
    if (!result.ok || result.instance === null) {
      this.formError = result.reason;
      return;
    }
    // 改地址 = 换 id：先删旧行再落新行，避免列表里同时留两条
    if (this.panelMode === PANEL_EDIT && id !== this.formId) {
      instanceStore.remove(this.formId);
    }
    instanceStore.upsert(result.instance);
    this.panelMode = '';
    this.reload();
  }

  /** 删除：本机行没有这个动作（模型层也会拒），删完立刻重读内存镜像。 */
  private deleteInstance(view: RedactedInstance): void {
    if (view.id === LOCAL_INSTANCE_ID) {
      return;
    }
    instanceStore.remove(view.id);
    this.reload();
  }

  /** 原有「云端对话（只读）」列表仍是独立页：设置入口升级到本页后，从这里保留一条桥接路径。 */
  private openChats(): void {
    router.pushUrl({ url: 'pages/Chats' }).catch((error: Error) => {
      promptAction.showToast({ message: `打开云端对话失败：${describeError(error)}`, duration: 3000 });
    });
  }

  /**
   * 空态次操作：把旧设置里的 DSH 地址交给系统浏览器；没填就说明原因，不假装能开。
   *
   * 令牌出口边界：`settingsStore.cached().remoteUrl` 可能带 `?token=` / `?k=`，
   * 绝不能把它直接交给 `Want.uri`（Intent / 浏览器历史会留明文令牌）。这里复用
   * `stripRemoteToken()` 整对删掉令牌参数后再拼 `Want`——与 `remoteShowLink`
   * 「用户显式出口才出明文」的纪律一致；URL 本身没有令牌时逐字不变。
   */
  private async openInBrowser(): Promise<void> {
    const cached = settingsStore.cached();
    const raw: string = cached === null ? '' : cached.remoteUrl.trim();
    if (raw.length === 0) {
      promptAction.showToast({ message: '先在设置里填写电脑上的 DSH 地址', duration: 3000 });
      return;
    }
    const url: string = stripRemoteToken(raw); // 唯一进 Want.uri 的地址：已去令牌
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const want: Want = { action: ACTION_VIEW_DATA, uri: url };
      await context.startAbility(want);
    } catch (error) {
      promptAction.showToast({ message: `打开浏览器失败：${describeError(error)}`, duration: 3000 });
    }
  }

  // ------------------------------------------------------------------ 渲染

  /** 分段页头：左侧标题（省略号），右侧主操作「添加实例」+ 原页保留的「云端对话」桥接出口。 */
  @Builder
  Header() {
    Row() {
      Text('远程 DSH')
        .fontSize(FONT.title)
        .lineHeight(LINE_HEIGHT.title)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text('添加实例')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.brand'))
        .height(TOUCH_MIN)
        .padding({ left: SPACING.sm, right: SPACING.sm })
        .onClick(() => {
          this.showAdd();
        })
      Text('云端对话')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.brand'))
        .height(TOUCH_MIN)
        .padding({ left: SPACING.sm, right: SPACING.sm })
        .onClick(() => {
          this.openChats();
        })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .border({ width: { bottom: DIVIDER }, color: $r('app.color.divider') })
  }

  /** 空态：§1 的逐字文案 + 主操作「添加实例」，次操作「用浏览器打开」另起一行。 */
  @Builder
  EmptyView() {
    Column({ space: SPACING.sm }) {
      EmptyState({
        title: EMPTY_TITLE,
        detail: EMPTY_DETAIL,
        actionLabel: EMPTY_ACTION,
        compact: false,
        onAction: (): void => {
          this.showAdd();
        }
      })
      ActionButton({
        label: EMPTY_SECONDARY,
        actionEnabled: true,
        disabledReason: '',
        busy: false,
        variant: 'secondary',
        block: true,
        onTap: (): void => {
          this.openInBrowser();
        },
        onBlockedTap: null
      })
    }
    .width('100%')
  }

  /** 存储问题行：typed 原因逐字上屏 +「重新添加」（不静默吞掉坏信封 / 存储不可用）。 */
  @Builder
  ProblemRow() {
    if (this.problem !== 'ok') {
      Column({ space: SPACING.xs }) {
        Text(problemText(this.problem))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.danger'))
          .width('100%')
          .textAlign(TextAlign.Start)
        ActionButton({
          label: '重新添加',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'secondary',
          block: false,
          onTap: (): void => {
            this.showAdd();
          },
          onBlockedTap: null
        })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding(SPACING.md)
      .backgroundColor($r('app.color.warning_soft'))
      .borderRadius(RADIUS.sm)
    }
  }

  /** 单行：名称 / 方式 / 三态 + 相对时间 / 打码 URL / 三个动作（本机缺删除）。 */
  @Builder
  InstanceRow(view: RedactedInstance) {
    Column({ space: SPACING.xs }) {
      Row({ space: SPACING.sm }) {
        Text(view.name)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Start)
        Text(this.modeLabel(view.mode))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .flexShrink(0)
          .maxLines(1)
        Text(reachabilityLabel(view.reachable))
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor(view.reachable === 'fail' ? $r('app.color.danger') : $r('app.color.text_secondary'))
          .flexShrink(0)
          .maxLines(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Text(`${reachabilityLabel(view.reachable)} · ${relativeLastSeen(view.lastSeen, Date.now())}`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)

      // 展示路径唯一出口：store 先 redacted()，这里再过一次 redactUrl()，token 永不出现
      Text(redactUrl(view.url))
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.Start)

      Row({ space: SPACING.sm }) {
        ActionButton({
          label: '打开',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.openInstance(view);
          },
          onBlockedTap: null
        })
        ActionButton({
          label: '编辑',
          actionEnabled: true,
          disabledReason: '',
          busy: false,
          variant: 'ghost',
          block: false,
          onTap: (): void => {
            this.showEdit(view);
          },
          onBlockedTap: null
        })
        if (view.id !== LOCAL_INSTANCE_ID) {
          ActionButton({
            label: '删除',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'danger',
            block: false,
            onTap: (): void => {
              this.deleteInstance(view);
            },
            onBlockedTap: null
          })
        }
      }
      .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ top: SPACING.md, bottom: SPACING.md })
    .borderRadius(RADIUS.none)
  }

  /** 添加 / 编辑面板：本机只给名称；远程给名称 + 地址 + 方式（六选一）。 */
  @Builder
  FormPanel() {
    if (this.panelMode.length > 0) {
      Column({ space: SPACING.sm }) {
        Text(this.panelMode === PANEL_ADD ? '添加实例' : '编辑实例')
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_primary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        TextInput({ text: this.formName, placeholder: '实例名称' })
          .width('100%')
          .height(TOUCH_MIN)
          .fontSize(FONT.body)
          .onChange((value: string) => {
            this.formName = value;
            this.formError = '';
          })
        if (this.formId !== LOCAL_INSTANCE_ID) {
          TextInput({ text: this.formUrl, placeholder: 'http://192.168.1.6:3080/?token=…' })
            .width('100%')
            .height(TOUCH_MIN)
            .fontSize(FONT.body)
            .onChange((value: string) => {
              this.formUrl = value;
              this.formError = '';
            })
          Select(this.modeSelectOptions())
            .selected(this.modeIndex())
            .width('100%')
            .height(TOUCH_MIN)
            .onSelect((index: number) => {
              this.pickMode(index);
            })
        }
        if (this.formError.length > 0) {
          Text(this.formError)
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.danger'))
            .width('100%')
            .textAlign(TextAlign.Start)
        }
        Row({ space: SPACING.sm }) {
          ActionButton({
            label: '保存',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'primary',
            block: false,
            onTap: (): void => {
              this.submitForm();
            },
            onBlockedTap: null
          })
          ActionButton({
            label: '取消',
            actionEnabled: true,
            disabledReason: '',
            busy: false,
            variant: 'secondary',
            block: false,
            onTap: (): void => {
              this.panelMode = '';
              this.formError = '';
            },
            onBlockedTap: null
          })
        }
        .width('100%')
      }
      .width('100%')
      .padding(SPACING.md)
      .backgroundColor($r('app.color.surface'))
      .borderRadius(RADIUS.sm)
    }
  }

  build() {
    Scroll() {
      Column({ space: SPACING.md }) {
        this.Header()
        Text(`共 ${this.views.length} 个实例`)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
          .textAlign(TextAlign.Start)
        this.ProblemRow()
        this.FormPanel()
        if (this.loading) {
          Text('正在读取本机实例表…')
            .fontSize(FONT.caption)
            .lineHeight(LINE_HEIGHT.caption)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Start)
        } else if (this.views.length === 0) {
          this.EmptyView()
        } else {
          ForEach(this.views, (view: RedactedInstance): void => {
            this.InstanceRow(view)
          }, (view: RedactedInstance): string => view.id)
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ left: SPACING.lg, right: SPACING.lg, top: SPACING.md, bottom: SPACING.xl })
    }
    .width('100%')
    .height('100%')
    .scrollBar(BarState.Off)
    .visibility(this.active ? Visibility.Visible : Visibility.Hidden)
  }
}
