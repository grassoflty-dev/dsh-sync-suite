// mod-settings-instances-entry-dedupe（2026-11-21）：设置树里恰好一处 Instances 入口。
//
// old → new：旧入口是 SettingsHost 长滚动里的「远程实例与云端对话 ›」行
// （ChatEntryRow → openInstances → router.pushUrl('pages/Instances')），与设置根页四行菜单的
// 「远程实例」行重复。本模块删掉旧行 + handler + RemoteGroup 装配 + 「远程」锚点，
// 保留根页那一行，实例页内部行为一字未改。
//
// 守卫按 Settings-gear dedupe 的正向口径（settingsPushFiles() === ['Home.ets']）写：
// 不是「旧文案不在就算过」，而是正向数出 Settings 树里 `pages/Instances` 路由字面量恰好 1 处，
// 且它必须是 pages/Settings.ets 四行菜单的 ROUTE_INSTANCES 常量；再钉住根行接线与路由仍可达。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { countRows, rowBindingRe } from './helpers/settingsRowBinding.mjs';

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);

/** 去掉块注释与整行行注释：只数可执行源码里的路由字面量，注释里的说明不算入口。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** 设置树：根页 + 三个真子页 + 实现宿主 + 六个 presentational 组件。 */
const SETTINGS_TREE = [
  'pages/Settings.ets',
  'pages/SettingsSync.ets',
  'pages/SettingsExportImport.ets',
  'pages/SettingsApi.ets',
  'components/settings/SettingsHost.ets',
  'components/settings/SettingsBits.ets',
  'components/settings/SyncSection.ets',
  'components/settings/AiSection.ets',
  'components/settings/DataSection.ets',
  'components/settings/AboutSection.ets'
].map((relative) => [relative, stripComments(readFileSync(new URL(relative, ETS), 'utf8'))]);

const ROUTE_TEST = /'pages\/Instances'/;
const ROUTE_ALL = /'pages\/Instances'/g;
const filesOf = (re) => SETTINGS_TREE.filter(([, code]) => re.test(code)).map(([file]) => file);
const occurrences = (re) => SETTINGS_TREE.reduce((sum, [, code]) => sum + (code.match(re) ?? []).length, 0);

const MAIN_PAGES = JSON.parse(readFileSync(
  new URL('../../entry/src/main/resources/base/profile/main_pages.json', import.meta.url), 'utf8'));
const HARMONY_PAGES = JSON.parse(readFileSync(
  new URL('../../entry/src/harmony/resources/base/profile/main_pages.json', import.meta.url), 'utf8'));

describe('mod-settings-instances-entry-dedupe', () => {
  test('D1 正向计数：设置树里 pages/Instances 恰好一处，且是根页的 ROUTE_INSTANCES', () => {
    assert.deepEqual(filesOf(ROUTE_TEST), ['pages/Settings.ets'],
      '正向断言：Instances 路由文件列表恰好一项、位于 Settings 根页（不是只查旧文案不在）');
    assert.equal(occurrences(ROUTE_ALL), 1,
      '整个 Settings 树只能有一处 pages/Instances 路由字面量（count == 1）');
    const root = SETTINGS_TREE.find(([file]) => file === 'pages/Settings.ets')[1];
    assert.match(root, /const ROUTE_INSTANCES: string = 'pages\/Instances';/,
      '唯一一处必须是根页的路由常量');
    assert.match(root, rowBindingRe('远程实例', 'instanceSummary', 'ROUTE_INSTANCES'),
      '四行菜单的「远程实例」行及其摘要接线仍在');
    assert.match(root, /private push\(route: string\): void \{[\s\S]{0,160}router\.pushUrl\(\{ url: route \}\)/,
      '根行仍经唯一的 push() 落到 router');
  });

  test('D2 旧入口绝迹：文案 / builder / handler / 锚点全部删除', () => {
    for (const [file, code] of SETTINGS_TREE) {
      assert.equal(code.includes('远程实例与云端对话'), false, `${file} 残留旧入口文案`);
    }
    const host = SETTINGS_TREE.find(([file]) => file === 'components/settings/SettingsHost.ets')[1];
    for (const token of ['ChatEntryRow(', 'openInstances(', 'RemoteGroup(', "GroupAnchorChip('远程'"]) {
      assert.equal(host.includes(token), false, `SettingsHost 残留旧入口 ${token}`);
    }
    assert.equal(/router\.pushUrl\(\{\s*url:\s*'pages\/Instances'\s*\}\)/.test(host), false,
      'SettingsHost 不得再直接 push pages/Instances（即使换了文案）');
  });

  test('D3 页面仍可达：两份清单登记 + 顶层页仍装配 InstancesPane（配置模式不变）', () => {
    for (const [name, pages] of [['main', MAIN_PAGES], ['harmony', HARMONY_PAGES]]) {
      assert.ok(pages.src.includes('pages/Instances'), `${name} 清单缺少 pages/Instances 路由`);
    }
    const route = stripComments(readFileSync(new URL('../../entry/src/main/ets/pages/Instances.ets', import.meta.url), 'utf8'));
    assert.match(route, /InstancesPane\(\{/, 'pages/Instances 顶层页必须仍装配 InstancesPane（单一事实来源）');
    assert.match(route, /configurable: true/, '设置路由仍以配置模式装配，实例页内部行为不变');
  });
});
