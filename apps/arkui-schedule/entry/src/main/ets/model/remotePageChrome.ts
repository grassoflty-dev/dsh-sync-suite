/**
 * mod-app-remote-page-pure（App 远程页）：页面表面 / 浮动操作 / 配对诊断的**纯决策**，唯一事实来源。
 *
 * 产品决定（用户原话）：「该页面只要显示最纯净的远程控制的 DSH 的页面原生就好了」——
 * 成功路径上只允许出现电脑自己的 DSH 页面；我们加的东西一律不许压在页面上下。
 * 因此本文件把「屏幕上到底该显示什么」收成纯函数，`.ets` 只做接线，不写任何判断文案：
 *
 * - `remoteSurface()`：loading / empty / page / error 四选一，`page` = 只有 DSH 页面；
 * - `chromeAffordances()`：浮动操作只有「返回 / 刷新」两个必需要点（诊断是第三个可选小图标），
 *   没有标题栏、没有分类 chip、没有任何说明文字；
 * - `pairingDiagnostics()`：配对 / 指纹诊断从页面搬到长按浮层里，文字仍由纯函数拼，组件不写第二份。
 *
 * 刻意保留的诚实项：预检与 WebView 握手是两条独立连接（TOCTOU），这句话没有删除，
 * 只是从页面顶部搬进「连接诊断」浮层——`model/pageTransport.ts` 的 `TOCTOU_SENTENCE` 是唯一文案源，
 * 本文件不复制它，组件仍在 `TransportInfo()` 里逐字渲染。
 *
 * 零 SDK import、零 UI import，因此可被 `tools/tsconfig.json` 编译并由 Node 单测直接验证。
 */

/** 页面表面：四选一。`page` 是唯一允许「只有 DSH 页面」的状态。 */
export type RemoteSurface = 'loading' | 'empty' | 'page' | 'error';

/** 表面判定输入：全部是页面已有的状态位，不新增持久化字段。 */
export interface RemoteSurfaceInput {
  /** 页面状态机（`pages/RemoteControl.ets` 的 PHASE_*）。 */
  phase: string;
  /** 决策 action='load' 且 Web 已挂载。 */
  webMounted: boolean;
  /** 主文档加载失败文案非空（`loadError.length > 0`）。 */
  hasLoadError: boolean;
}

/**
 * 唯一表面决策：
 * - 还没读完地址 → loading；
 * - 没有可用地址 → empty；
 * - 决策拒绝（https 无 pin / 指纹不符 / 预检失败）→ error（页面从未加载）；
 * - 已挂载但主文档加载失败 → error（**整屏**替换页面，不许出现空白页）；
 * - 其余 → page（成功路径，屏幕上只有 DSH 页面本身）。
 */
export function remoteSurface(input: RemoteSurfaceInput): RemoteSurface {
  if (input.phase === 'loading') {
    return 'loading';
  }
  if (input.phase !== 'ready') {
    return 'empty';
  }
  if (!input.webMounted) {
    return 'error';
  }
  return input.hasLoadError ? 'error' : 'page';
}

/** 浮动操作的可见性：返回永远在（用户不能被关在页面里），刷新只在有地址且已到终态时出现。 */
export interface ChromeAffordances {
  back: boolean;
  reload: boolean;
}

/**
 * 浮动操作可见性。
 *
 * `back` 恒为 true：任何状态下都必须有一个不用读文字就能找到的出口（系统返回手势不是保证）。
 * `reload` 只在 page / error 且地址非空时出现：loading 时还没有地址，点了也没有意义；
 * empty 的出路是「去设置」，不是刷新。
 * `refusalTerminal`（证书拒绝终态）下连 error 也不给刷新：拒绝是终态，重新加载不会换一张证书，
 * 留一个点了没反应的图标等于假动作——那个状态下的出路是「返回」与诊断浮层里的原因。
 */
export function chromeAffordances(surface: RemoteSurface, hasAddress: boolean,
  refusalTerminal: boolean): ChromeAffordances {
  const settled: boolean = surface === 'page' || surface === 'error';
  return { back: true, reload: hasAddress && settled && !refusalTerminal };
}

/** 图标字形（只在这里定义一次；组件不写第二份）。 */
export const BACK_GLYPH: string = '‹';
export const RELOAD_GLYPH: string = '↻';
export const DIAGNOSTICS_GLYPH: string = 'ⓘ';

/** 诊断浮层的首行标题（报告里逐字引用）。 */
export const DIAGNOSTICS_TITLE: string = '连接诊断';

/** 长按刷新图标打开诊断浮层的时长（ms）。 */
export const DIAGNOSTICS_LONG_PRESS_MS: number = 600;

/** 诊断浮层里地址行的前缀（地址必须已剥掉 token 才传进来）。 */
export const ADDRESS_PREFIX: string = '地址：';

/** 诊断浮层里指纹行的前缀。 */
export const PIN_PREFIX: string = '配对指纹：';

/** 没配对时的指罪行：说清后果（https 会被拒绝），不假装「已配对」。 */
export const PIN_MISSING_LINE: string = '配对指纹：未配对（https 地址会被拒绝加载）';

/** 配对诊断输入：地址（已剥 token）+ 配对记录里的叶证书指纹（空串 = 未配对）。 */
export interface PairingDiagnosticsInput {
  address: string;
  pin: string;
}

/**
 * 配对诊断正文（多行，逐行前缀只在本文件出现一次）。
 *
 * 地址为空（还没解析出来）就不渲染该行；指纹为空时输出「未配对」，绝不输出空指纹当成匹配。
 */
export function pairingDiagnostics(input: PairingDiagnosticsInput): string {
  const address: string = typeof input.address === 'string' ? input.address.trim() : '';
  const pin: string = typeof input.pin === 'string' ? input.pin.trim() : '';
  const lines: string[] = [];
  if (address.length > 0) {
    lines.push(`${ADDRESS_PREFIX}${address}`);
  }
  lines.push(pin.length > 0 ? `${PIN_PREFIX}${pin}` : PIN_MISSING_LINE);
  return lines.join('\n');
}
