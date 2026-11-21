/**
 * 左侧导航轨（mod-shell-rail / S1）——只做「四个平级 section 的选择 + 设置出口」。
 *
 * 契约：
 * - 四节是**平级**的：dots / 日程 / 远程 DSH / 云端对话，顺序固定，视觉权重完全相同；
 *   选中态只改底色与字色（外加一条 2vp 品牌竖条，沿用 UI-DESIGN §4 的既有选中语义），
 *   不加图标、角标或主按钮，因此不存在「哪个更重要」的暗示。
 * - 本组件**不导航、不碰 store、不调 router**：当前节与三个回调全部由父页面传入
 *   （S2 的 shell 页面持有 `@State section` 并决定换哪个子页 / 何时 push 设置页）。
 * - 两种形态共用同一份列表：常驻轨 240vp（横屏 / 宽屏），紧凑抽屉 72vp（icon-only，
 *   label 改走 accessibilityText）。抽屉容器由父页面拥有，本组件只渲染列表本身。
 *
 * 图标口径：本 app 没有图标字体（全仓无 SymbolGlyph / fontIcon），沿用既有做法——
 * 每节一个单字符 glyph，放在 TOUCH_MIN(40vp) 的方块里；设置齿轮沿用页头的 '⚙'。
 *
 * 尺寸与颜色全部走令牌：SPACING / FONT / LINE_HEIGHT / TOUCH_MIN / DIVIDER +
 * $r('app.color.*')；不新增令牌、不写裸色值、不引入新依赖。
 */

import { DIVIDER, FONT, LINE_HEIGHT, SPACING, TOUCH_MIN } from '../../common/uiTokens';

/** 左侧轨常驻宽度（vp）：横屏 / 宽屏。 */
const RAIL_WIDTH: number = 240;

/** 抽屉里的窄轨宽度（vp）：icon-only。 */
const RAIL_COMPACT_WIDTH: number = 72;

/** 单行高度（vp）：四节与齿轮行同高，且 ≥ TOUCH_MIN。 */
const RAIL_ROW_HEIGHT: number = 48;

/** 选中行左侧竖条宽度（vp）：UI-DESIGN §4 的既有选中语义。 */
const RAIL_SELECTION_BAR: number = 2;

/** 设置行图标：与首页页头「⚙ 设置」同一个 glyph。 */
const SETTINGS_GLYPH: string = '⚙';

/** 设置行文案（紧凑形态下作为 accessibilityText）。 */
const SETTINGS_LABEL: string = '设置';

/**
 * 四个 section 的稳定 id。
 *
 * 用字符串字面量联合而不是 enum：与 `model/theme.ts` 的 `ThemeMode` 同口径，
 * tsc 与 ArkTS 都吃得下；取值永远只有这四个，落盘/埋点都不会漂。
 */
export type ShellSection = 'dots' | 'schedule' | 'instances' | 'cloudChat';

/** id 常量：父页面与测试都引用它们，避免拼写漂移。 */
export const SHELL_SECTION_DOTS: ShellSection = 'dots';
export const SHELL_SECTION_SCHEDULE: ShellSection = 'schedule';
export const SHELL_SECTION_INSTANCES: ShellSection = 'instances';
export const SHELL_SECTION_CLOUD_CHAT: ShellSection = 'cloudChat';

/** 一节的展示信息：id + 中文标签 + 单字符图标。 */
export interface ShellSectionInfo {
  id: ShellSection;
  label: string;
  glyph: string;
}

/** dots：AI 助手（首页「与 dots 对话」入口对应的那一节）。 */
export const SHELL_INFO_DOTS: ShellSectionInfo = {
  id: SHELL_SECTION_DOTS,
  label: 'dots',
  glyph: '✦'
};

/** 日程：本机日程列表。 */
export const SHELL_INFO_SCHEDULE: ShellSectionInfo = {
  id: SHELL_SECTION_SCHEDULE,
  label: '日程',
  glyph: '▤'
};

/** 远程 DSH：实例管理（远程控制 / 远程实例）。 */
export const SHELL_INFO_INSTANCES: ShellSectionInfo = {
  id: SHELL_SECTION_INSTANCES,
  label: '远程 DSH',
  glyph: '◈'
};

/** 云端对话：只读会话浏览 + dots 对话。 */
export const SHELL_INFO_CLOUD_CHAT: ShellSectionInfo = {
  id: SHELL_SECTION_CLOUD_CHAT,
  label: '云端对话',
  glyph: '☁'
};

/** 展示顺序：数组顺序即渲染顺序，四节平级。 */
export const SHELL_SECTION_ORDER: ShellSectionInfo[] = [
  SHELL_INFO_DOTS,
  SHELL_INFO_SCHEDULE,
  SHELL_INFO_INSTANCES,
  SHELL_INFO_CLOUD_CHAT
];

/**
 * id → 展示信息；未知值 fail-closed 回落到 dots（不渲染空白行）。
 *
 * 父页面若从字符串/持久化值转过来，仍走这个查表，不必自己判空。
 */
export function shellSectionInfo(section: ShellSection): ShellSectionInfo {
  for (const item of SHELL_SECTION_ORDER) {
    if (item.id === section) {
      return item;
    }
  }
  return SHELL_INFO_DOTS;
}

@Component
export struct ShellRail {
  /** 当前选中节（父页面持有；本组件只读呈现，不自己改）。 */
  @Prop section: ShellSection = SHELL_SECTION_DOTS;

  /** 抽屉形态：true = 72vp 窄轨、只显示图标（label 进 accessibilityText）。 */
  @Prop compact: boolean = false;

  /** 点节：把 id 回传给父页面，由父页面决定换哪个子页。 */
  onSelect: (section: ShellSection) => void = () => {};

  /** 点齿轮：只发事件，router / 侧滑关闭等动作由父页面决定。 */
  onOpenSettings: () => void = () => {};

  /** 悬停中的行 id（只做「微妙 surface」反馈，不改选中态）。 */
  @State hoveredSection: string = '';

  /** 按下中的行 id（抬手 / 取消即清空，避免残留高亮）。 */
  @State pressedSection: string = '';

  /** 齿轮行的悬停反馈。 */
  @State hoveredSettings: boolean = false;

  /** 齿轮行的按下反馈。 */
  @State pressedSettings: boolean = false;

  /** 当前节是否选中。 */
  private isActive(id: ShellSection): boolean {
    return id === this.section;
  }

  /** 行底色：按下/悬停 → 次级 surface；否则选中 → 品牌淡底；再否则 → 普通 surface。 */
  private rowBackground(id: ShellSection): Resource {
    if (this.pressedSection === id || this.hoveredSection === id) {
      return $r('app.color.control_fill');
    }
    if (this.isActive(id)) {
      return $r('app.color.brand_soft');
    }
    return $r('app.color.surface');
  }

  /** 行字色（图标与文字共用）：选中 → 强调色；其余 → 次级文字。 */
  private rowTextColor(id: ShellSection): Resource {
    return this.isActive(id) ? $r('app.color.brand') : $r('app.color.text_secondary');
  }

  /** 齿轮行底色：与节行同一套「按下/悬停 → 次级 surface」的反馈。 */
  private settingsBackground(): Resource {
    if (this.pressedSettings || this.hoveredSettings) {
      return $r('app.color.control_fill');
    }
    return $r('app.color.surface');
  }

  /** 当前形态下的轨道宽度。 */
  private railWidth(): number {
    return this.compact ? RAIL_COMPACT_WIDTH : RAIL_WIDTH;
  }

  /** 左右内边距：紧凑形态 16，让 40vp 图标在 72vp 轨里居中；常驻形态 12。 */
  private rowPaddingLeft(): number {
    return this.compact ? SPACING.lg : SPACING.md;
  }

  /** 节行：图标 + 文案（紧凑形态只有图标）；四节结构完全一致。 */
  @Builder
  SectionRow(info: ShellSectionInfo) {
    Row({ space: SPACING.sm }) {
      // 选中竖条只在常驻形态出现：72vp 窄轨要留给 40vp 图标 + 两侧 16vp 内边距
      if (!this.compact && this.isActive(info.id)) {
        Row()
          .width(RAIL_SELECTION_BAR)
          .height(SPACING.xl)
          .backgroundColor($r('app.color.brand'))
          .flexShrink(0)
      }
      Text(info.glyph)
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor(this.rowTextColor(info.id))
        .width(TOUCH_MIN)
        .height(TOUCH_MIN)
        .textAlign(TextAlign.Center)
        .flexShrink(0)
      if (!this.compact) {
        Text(info.label)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor(this.rowTextColor(info.id))
          .fontWeight(this.isActive(info.id) ? FontWeight.Medium : FontWeight.Normal)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Start)
      }
    }
    .width('100%')
    .height(RAIL_ROW_HEIGHT)
    .padding({ left: this.rowPaddingLeft(), right: this.rowPaddingLeft() })
    .backgroundColor(this.rowBackground(info.id))
    .alignItems(VerticalAlign.Center)
    .accessibilityText(info.label)
    .onHover((isHover: boolean) => {
      this.hoveredSection = isHover ? info.id : '';
    })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressedSection = info.id;
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressedSection = '';
      }
    })
    .onClick(() => {
      this.onSelect(info.id);
    })
  }

  /** 页脚齿轮行：与节行同高同宽；只发 onOpenSettings，不自行跳转。 */
  @Builder
  SettingsRow() {
    Row({ space: SPACING.sm }) {
      Text(SETTINGS_GLYPH)
        .fontSize(FONT.body)
        .lineHeight(LINE_HEIGHT.body)
        .fontColor($r('app.color.text_secondary'))
        .width(TOUCH_MIN)
        .height(TOUCH_MIN)
        .textAlign(TextAlign.Center)
        .flexShrink(0)
      if (!this.compact) {
        Text(SETTINGS_LABEL)
          .fontSize(FONT.body)
          .lineHeight(LINE_HEIGHT.body)
          .fontColor($r('app.color.text_secondary'))
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Start)
      }
    }
    .width('100%')
    .height(RAIL_ROW_HEIGHT)
    .padding({ left: this.rowPaddingLeft(), right: this.rowPaddingLeft() })
    .backgroundColor(this.settingsBackground())
    .alignItems(VerticalAlign.Center)
    .accessibilityText(SETTINGS_LABEL)
    .onHover((isHover: boolean) => {
      this.hoveredSettings = isHover;
    })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        this.pressedSettings = true;
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.pressedSettings = false;
      }
    })
    .onClick(() => {
      this.onOpenSettings();
    })
  }

  build() {
    Column() {
      ForEach(SHELL_SECTION_ORDER, (info: ShellSectionInfo) => {
        this.SectionRow(info)
      }, (info: ShellSectionInfo): string => info.id)

      Blank()

      // 页脚与四节之间一条细线：齿轮是「出口」不是第五个 section，视觉上必须分开
      Divider()
        .strokeWidth(DIVIDER)
        .color($r('app.color.divider'))
      this.SettingsRow()
    }
    .width(this.railWidth())
    .height('100%')
    .backgroundColor($r('app.color.surface'))
    .alignItems(HorizontalAlign.Start)
  }
}
