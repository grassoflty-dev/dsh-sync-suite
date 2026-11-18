/**
 * App 版本号（纯常量，**零 SDK import**，可被 `tools/tsconfig.json` 编译成 JS 由 Node 单测直接验证）。
 *
 * 硬约束：本文件的值**必须与 `AppScope/app.json5` 的 `versionName` 完全一致**。
 * 原因：诊断信息（`model/stateView.ts` 的 `formatDiagnostics`）与设置页「关于」都要展示版本号，
 * 用户反馈问题时这一行是他能提供的唯一线索；两个来源一旦漂移，排查就会对不上号。
 * `tools/test/interactionGuards.test.mjs` 会跨文件比对两处（改版本时两处同步，不要只改一处）。
 *
 * 注意：设置页 `components/settings/AboutSection.ets` 里历史上自带一份同名常量（渲染用），
 * 那是 A 批之前的写法；新代码一律 import 这里的 `APP_VERSION`，不要各自再定义一份。
 */

/** 应用版本号（与 `AppScope/app.json5` 的 `versionName` 一致）。 */
export const APP_VERSION: string = '1.0.0';
