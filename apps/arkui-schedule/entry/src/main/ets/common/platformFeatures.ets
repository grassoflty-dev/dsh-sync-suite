/**
 * 平台能力装配 —— **共享默认实现**（Android / 未知平台走本文件）。
 *
 * 平台覆盖语义（`docs/CONTRACT.md` §3.1）：构建某平台时源码 = `main` + 该平台目录，
 * 同名相对路径以后者为准。`entry/src/harmony/ets/common/platformFeatures.ts` 会整体替换本文件，
 * 在鸿蒙侧无条件打开手写/OCR 并显式 `setPlatform('harmony')`（不依赖运行时检测结果）。
 *
 * 本文件是**第二道防线**：不再写死 `'android'`，而是按 `getPlatform()` 装配 ——
 * `EntryAbility.onCreate` 先用 `setPlatform('android')` 把初值钉成 fail-closed，再被
 * `devicePlatform.detectPlatform()` 的结果覆盖（鸿蒙覆盖层读 `deviceInfo`，共享实现恒为 `'android'`）。
 * 因此 Android 产物里这里只会走关闭分支；只有「平台=harmony」时才打开能力（BRIEF §3.3）。
 *
 * 前提：调用方必须先 `setPlatform(...)` 再调本函数（`getPlatform()` 未设置时默认 `'harmony'`，
 * 这是契约 §3.2 的历史语义，EntryAbility 已按此顺序调用）。
 *
 * 契约：`docs/CONTRACT.md` §3.1 / §3.2、BRIEF §3.1。
 *
 * 除任务书指定的 `installPlatformFeatures()` 之外，本文件额外导出一个「平台钩子」：
 * - `handwritingPageRoute()`：共享层不能出现手写页面的路径字面量（validate 规则 4 会把
 *   共享/Android 侧的手写页名字符串判为不可编译），故由平台覆盖文件提供路由。
 */
import { setFeatures } from './features';
import { getPlatform } from './platform';

/**
 * 安装当前平台的能力开关。
 * 共享默认实现：按 `getPlatform()` 装配 —— harmony → 手写/OCR 可用，其余（含 Android）关闭。
 */
export function installPlatformFeatures(): void {
  const platform = getPlatform();
  if (platform === 'harmony') {
    setFeatures({ handwriting: true, ocr: true });
    return;
  }
  setFeatures({ handwriting: false, ocr: false });
}

/**
 * 手写板页面的路由路径。
 * 共享默认实现返回空串：Android 侧没有该页面（也不允许出现该路径字面量）。
 */
export function handwritingPageRoute(): string {
  return '';
}
