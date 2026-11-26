// 模块 `mod-app-settings-summary-resolve` 的两条**结构性**守卫（Node 侧，源码级）：
//
//   S-01 反应性守卫：四行摘要必须经**真组件 + @Prop** 渲染，绝不经过按值 @Builder 参数表。
//        这一条必须能抓住修复前的 `pages/Settings.ets`（`@Builder MenuRow(title, summary, route)`
//        + `this.MenuRow('同步仓库', this.repoSummary, ROUTE_SYNC)`）——抓不住就是白写。
//   S-02 同源守卫：汇总行读的必须是**子页同一批 services 单例 + 同一批纯判定函数**，
//        这样「一个能用一个卡死」不可能再靠两条并行读路径上线。
//
// 为什么是源码级：`pages/Settings.ets` 是 ArkTS（`@Entry @Component` + `$r('app.color…')`），
// Node 里跑不起来；但「行有没有可能随 @State 刷新」是纯文本可判定的事实（见
// `helpers/settingsRowBinding.mjs` 的来由）。真机复测另记在 `docs/VERIFICATION.md`。
//
// 前置：无需构建（本文件不 import `.build`）。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { readEts, stripComments } from './helpers/etsSource.mjs';
import { countRows, rowBindingRe } from './helpers/settingsRowBinding.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('settingsSummaryResolve.test.mjs');

const code = (relative) => stripComments(readEts(join('main', 'ets', relative)));
/** 读一个「修复后才存在」的文件：缺失时返回空串，让断言自己的报错说话（而不是 ENOENT 吞掉全部用例）。 */
const codeOrEmpty = (relative) => {
  try {
    return code(relative);
  } catch (error) {
    return '';
  }
};
const PAGE = code('pages/Settings.ets');
const ROW = codeOrEmpty('components/settings/MenuSummaryRow.ets');
const SUB = code('pages/SettingsSync.ets');

/** 四行的（标题, 摘要 @State, 路由常量）；顺序与界面自上而下一致。 */
const ROWS = [
  ['同步仓库', 'repoSummary', 'ROUTE_SYNC'],
  ['远程实例', 'instanceSummary', 'ROUTE_INSTANCES'],
  ['数据导入导出', 'dataSummary', 'ROUTE_DATA'],
  ['API 配置', 'apiSummary', 'ROUTE_API']
];

// ---------------------------------------------------------------------------
// S-01 反应性守卫（修复前必须红）
// ---------------------------------------------------------------------------

test('S-01 反应性：四行经真组件 @Prop 绑定，不存在任何带参数的 @Builder 参数表', () => {
  // ① 页面里不许再出现**带参数**的 @Builder：那正是「@State 变了、Text 不重建」的形状。
  const builderWithParams = /@Builder\s*(?:\r?\n\s*)?[A-Za-z_$][\w$]*\s*\(\s*[A-Za-z_$]/;
  assert.equal(builderWithParams.test(PAGE), false,
    '页面不得用带参数的 @Builder 渲染摘要行（按值传参不会随 @State 重建）');
  // ② 旧形状彻底绝迹（连零参数的 builder 也不许回潮：四行只留一种渲染方式）。
  assert.equal(/@Builder/.test(PAGE), false, '四行菜单不得再用 @Builder 渲染动态摘要行');
  assert.equal(/this\.MenuRow\(/.test(PAGE), false, '旧的按值 builder 行 this.MenuRow(...) 必须绝迹');
  assert.equal(/MenuRow\(title: string/.test(PAGE), false, '旧的 MenuRow(title: string, …) 声明必须绝迹');

  // ③ 恰好四行，且每行都接自己的摘要 @State + 可重试 @State + 自己的路由。
  assert.equal(countRows(PAGE), 4, `根页必须恰好四行，实际 ${countRows(PAGE)}`);
  for (const [title, summary, route] of ROWS) {
    assert.equal(rowBindingRe(title, summary, route).test(PAGE), true,
      `「${title}」行必须把 this.${summary} 作为 @Prop 交给行组件，并点到自己那条 ${route}`);
  }

  // ④ 行组件本身必须是真 @Component + @Prop，且 Text 直接读 this.summary：
  //    读取发生在**节点自己的闭包**里，这才是 ArkUI 会跟踪的那一次读。
  assert.match(ROW, /@Component\s*(?:\r?\n\s*)?export struct MenuSummaryRow/, '行必须是真 @Component');
  assert.match(ROW, /@Prop summary: string/, '摘要必须是 @Prop（子组件单向 props）');
  assert.match(ROW, /@Prop retryable: boolean/, '失败态（可重试）也必须是 @Prop');
  assert.match(ROW, /Text\(this\.summary\)/, 'Text 必须直接读 this.summary（不是 builder 参数）');
  assert.match(ROW, /Text\(rowHintOf\(this\.retryable\)\)/, '行尾提示必须由 this.retryable 现算');
  assert.equal(/@Builder/.test(ROW), false, '行组件里不得夹带 @Builder');
});

// ---------------------------------------------------------------------------
// S-02 同源守卫：汇总行 == 子页那一套 resolver / services
// ---------------------------------------------------------------------------

test('S-02 同源：汇总行与子页读同一批 services 单例，同一个纯判定入口', () => {
  // ① 同一个 services 单例模块（逐字相同的 import specifier ⇒ 同一份单例对象）。
  for (const mod of ['../services/settingsStore', '../services/instanceStore']) {
    const spec = `from '${mod}'`;
    assert.equal(PAGE.includes(spec), true, `根页必须从 ${mod} 读（与子页同一单例）`);
  }
  assert.equal(SUB.includes("from '../services/settingsStore'"), true,
    '前置：子页也必须从 ../services/settingsStore 读（否则「同源」无从谈起）');
  assert.equal(SUB.includes("from '../services/syncStatusStore'"), true,
    '前置：子页状态行的事实来自 syncStatusStore');

  // ② 同一批事实来源：设置读盘 + 权威最新尝试 + 内核就绪 + 实例表。
  assert.match(PAGE, /settingsStore\.load\(\)/, '汇总行的设置必须走 settingsStore.load()');
  assert.match(PAGE, /syncStatusStore\.latestAttempt\(\)/, '同步行的事实必须是权威最新尝试');
  assert.match(PAGE, /syncController\.isReady\(\)/, '内核就绪必须由同一个 syncController 判');
  assert.match(PAGE, /instanceStore\.list\(\)/, '实例行必须读 instanceStore（不是第二份缓存）');
  assert.match(PAGE, /instanceStore\.lastProblem\(\)/, '实例「读不到」必须带 store 的 typed 问题码');

  // ③ 同一批纯判定：不许自己在页面里拼成功文案 / 自己判「读不到 vs 空」。
  assert.match(PAGE, /syncRowSummary\(/, '同步行文案必须委托唯一渲染器 syncRowSummary');
  assert.match(PAGE, /repoRowSummary\(/, '仓库行文案必须委托 repoRowSummary');
  assert.match(PAGE, /repoConfigStateOf\(/, '已配置判据必须与同步周期同一份');
  assert.match(PAGE, /instancesRow\(/, '实例行必须走 instancesRow（读不到 ≠ 空）');
  assert.match(PAGE, /problemText\(/, '实例问题码的中文原因必须走 problemText');
  for (const forbidden of [/已同步 · \$\{/, /已同步·\$\{/, /clockOf\(\s*(this|settings)\.lastSyncAt\s*\)/]) {
    assert.equal(forbidden.test(PAGE), false, `页面不得自己渲染成功文案：${forbidden}`);
  }
  // ④ 只有一条读路径：页面不直接碰 preferences、不自造 store 实例。
  for (const forbidden of [/getPreferences\(/, /new GitSyncService\(/, /new SettingsStore\(/]) {
    assert.equal(forbidden.test(PAGE), false, `页面不得另开一条读路径：${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// S-03 / S-04 终端态与「静默拒绝」的结构性守卫
// ---------------------------------------------------------------------------

test('S-03 终端态：「读取中…」只允许出现在两处初值 + 唯一的 rowLoading() 出口', () => {
  // 任何地方再写一次「读取中…」都可能是「静默回退到占位」的第二条路径；
  // 重试必须走纯模型的 rowLoading()，不许页面自己拼字符串。
  const loadingLiterals = PAGE.match(/读取中…/g) ?? [];
  assert.equal(loadingLiterals.length, 2,
    `「读取中…」只允许作为两行初值出现，实际 ${loadingLiterals.length} 处`);
  assert.match(PAGE, /@State repoSummary: string = '读取中…'/, '同步行初值仍是「读取中…」');
  assert.match(PAGE, /@State instanceSummary: string = '读取中…'/, '实例行初值仍是「读取中…」');
  assert.match(PAGE, /rowLoading\(\)/, '重试回到在飞态必须经纯模型 rowLoading()');
});

test('S-04 静默拒绝必须绝迹：aboutToAppear 里的 bootstrap() 一定挂了 .catch', () => {
  assert.equal(/aboutToAppear\(\): void \{\s*this\.bootstrap\(\)\.catch\(/.test(PAGE), true,
    'bootstrap() 的拒绝必须有处理器（否则行会永远停在「读取中…」）');
  assert.equal(/aboutToAppear\(\): void \{\s*this\.bootstrap\(\);\s*\}/.test(PAGE), false,
    '旧写法 this.bootstrap(); 没有 void 也没有 .catch，必须绝迹');
  // 有界读取的入口只留一个：getContext 这类同步抛错也要收敛成 typed 失败结论。
  assert.match(PAGE, /readSettingsWithinBudget\(context, ROW_READ_BUDGET_MS\)/, '读取必须有预算');
  assert.match(PAGE, /private applyRows\(read: RowRead\): void \{/, '结论统一由 applyRows 落到四行');
  assert.match(PAGE, /private settleFailed\(error: Object\): void \{/, '意外的拒绝也要有兜底终态');
});
