import router from '@ohos.router';
import { FONT, SPACING } from '../common/uiTokens';
import { GATE_ROUTE_PARAM, GATE_ROUTE_VALUE, makeSyntheticCredential } from '../model/rc3GateHarness';
import {
  formatServerCounts,
  observeGateEndpoint,
  rc3GateActive,
  rc3GateSentinel,
  runGateWithSyntheticCredential
} from '../services/rc3GateHarness';


export function rc3GateRequested(): boolean {
  return rc3GateActive(gateParam());
}

/** 门禁 router 参数；普通导航不会带它，且它本身不是访问边界（还要过 DEBUG）。 */
function gateParam(): string {
    try {
      const params = router.getParams() as Record<string, string>;
      if (params === undefined || params === null) {
        return '';
      }
      const value = params[GATE_ROUTE_PARAM];
      return typeof value === 'string' ? value : '';
    } catch (error) {
      return '';
    }
  }

@Component
export struct Rc3GatePanel {
  @Prop endpoint: string = '';
  @State rc3GateText: string = '';
  @State rc3OrderConfirmed: boolean = false;
  @State expectedPin: string = '';
  @State rc3AuthCountText: string = '0';
  @State rc3DestCountText: string = '0';

  /**
   * RC-3 门禁视图：默认不挂；只有 debug 构建 + rc3Gate=1 可见。
   * 顺序固定：先「观察证书（无凭证）」，再显式确认，最后才「合成凭证请求」。
   * 文案只陈述计数与 typed 结果，不宣称连接被保护。
   */
  @Builder
  Rc3GateView() {
    Scroll() {
      Column({ space: SPACING.sm }) {
        Text(`RC3 门禁 ${rc3GateSentinel()}（${GATE_ROUTE_PARAM}=${GATE_ROUTE_VALUE}）`)
          .fontSize(FONT.body)
          .fontColor($r('app.color.text_secondary'))
        Text('第一步：观察证书，不携带凭证')
          .fontSize(FONT.body)
          .fontColor($r('app.color.text_primary'))
        Button('观察证书（无凭证）')
          .onClick(async () => {
            this.rc3GateText = await observeGateEndpoint(this.endpoint);
          })
        Text('第二步：确认观察证据已证明 leaf 身份（仅本门禁可确认）')
          .fontSize(FONT.caption)
          .fontColor($r('app.color.text_secondary'))
        Toggle({ type: ToggleType.Checkbox, isOn: this.rc3OrderConfirmed })
          .onChange((value: boolean) => {
            this.rc3OrderConfirmed = value;
          })
        TextInput({ text: this.expectedPin, placeholder: '填写带外取得的测试证书 SHA-256' })
          .onChange((value: string) => { this.expectedPin = value; })
        Text('第三步：仅用本地生成的合成凭证发起受控请求')
          .fontSize(FONT.body)
          .fontColor($r('app.color.text_primary'))
        Button('合成凭证请求')
          .onClick(async () => {
            const nonce: string = `rc3-${Date.now()}-${Math.random()}`;
            this.rc3GateText = await runGateWithSyntheticCredential(
              this.endpoint, makeSyntheticCredential(nonce), this.rc3OrderConfirmed, this.expectedPin
            );
          })
        Text(this.rc3GateText)
          .fontSize(FONT.caption)
          .fontColor($r('app.color.text_primary'))
        Text('服务端日志只记录次数，不回显凭证值')
          .fontSize(FONT.caption)
          .fontColor($r('app.color.text_secondary'))
        Row({ space: SPACING.sm }) {
          TextInput({ text: this.rc3AuthCountText })
            .width(80)
            .onChange((value: string) => { this.rc3AuthCountText = value; })
          TextInput({ text: this.rc3DestCountText })
            .width(80)
            .onChange((value: string) => { this.rc3DestCountText = value; })
        }
        Text(formatServerCounts(
          Number.parseInt(this.rc3AuthCountText, 10) || 0,
          Number.parseInt(this.rc3DestCountText, 10) || 0
        ))
          .fontSize(FONT.caption)
          .fontColor($r('app.color.text_secondary'))
      }
      .width('100%')
      .padding(SPACING.md)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .layoutWeight(1)
  }

  build() {
    Column() { this.Rc3GateView() }
      .layoutWeight(1)
  }
}
