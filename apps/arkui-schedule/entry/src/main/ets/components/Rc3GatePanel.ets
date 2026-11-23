/** 常规构建不链接调试门禁，也不接受门禁路由参数。 */
export function rc3GateRequested(): boolean {
  return false;
}

@Component
export struct Rc3GatePanel {
  @Prop endpoint: string = '';
  build() {
    Column() {}
  }
}
