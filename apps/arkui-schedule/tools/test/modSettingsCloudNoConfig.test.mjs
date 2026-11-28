// mod-settings-cloud-no-config + mod-cloud-chat-no-config-note：
// ① 设置页 / 设置存储里没有云端会话的配置行、字段或键（原模块意图，断言一字未删）；
// ② 会话列表与外壳面板**没有任何配置/机制说明段落**（旧「只读来源说明」已删）——
//    「no cloud config」现在由「零设置 UI + 说明绝迹」证明，比旧「说明常驻」更强；
//    空态只给一句真依赖「先在设置里配置仓库」，不是讲存储机制的一大段；
// ③ 列表 / 点行进只读详情 / 下拉刷新路径逐条仍在（删的是说明，不是功能）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readSettingsFile, readSettingsPage, readSettingsRoot, readSettingsSources } from './settingsSources.mjs';
import { countRows, rowBindingRe } from './helpers/settingsRowBinding.mjs';

// mod-settings-root（old→new）：入口行随实现从 pages/Settings.ets 搬到组件宿主；
// 本用例只查「导航入口里没有配置控件」，断言不变，只换锚点。
const PAGE = readSettingsPage();
const SOURCES = readSettingsSources();
const STORE = readSettingsFile('services/settingsStore.ets');
const CHATS = readSettingsFile('pages/Chats.ets');
const PANE = readSettingsFile('pages/panes/CloudChatPane.ets');
const CHAT_STORE = readSettingsFile('services/chatStore.ets');

/** 已 retire 的旧只读来源说明：本模块断言它**绝迹**（old→new 的反面锚点，不是放宽）。 */
const RETIRED_EXPLANATION =
  '会话保存在同步仓库的 chats/ 目录，通过 Git 在多端同步；本页只读，对话续接请在电脑上继续。';

describe('mod-settings-cloud-no-config：设置页没有云端会话配置', () => {
  test('设置页没有云端地址 / 令牌 / 开关等配置行，只有导航入口', () => {
    for (const gone of [
      /chatUrl|chatToken|chatKey|cloudChatUrl|cloudChatToken|cloudChatEnabled|chatEndpoint/,
      /@State .*[Cc]hat/,
      /this\.FieldLabel\([^)]*[Cc]hat/,
      /云端会话地址|云端服务地址|会话服务地址/
    ]) {
      assert.equal(gone.test(PAGE), false, `设置页残留云端配置字段：${gone}`);
    }
    // mod-settings-instances-entry-dedupe（old→new，收紧）：旧「远程实例与云端对话 ›」
    // 导航行已删除，唯一入口是四行菜单根页的「远程实例」行；它同样只是导航，不是配置行。
    const root = readSettingsRoot();
    assert.equal(/TextInput\(/.test(root), false, '根页入口行不该有输入框');
    assert.match(root, rowBindingRe('远程实例', 'instanceSummary', 'ROUTE_INSTANCES'), '入口只做路由跳转');
    assert.equal(SOURCES.includes('远程实例与云端对话'), false, '旧入口文案绝迹，不再假设它仍在');
  });

  test('settingsStore 没有任何 chats 相关配置键（deepseek-chat 模型名不算）', () => {
    const keyLines = STORE.split('\n').filter((line) => /const KEY_/.test(line));
    const chatKeys = keyLines.filter((line) => /chat/i.test(line));
    assert.deepEqual(chatKeys, [], `settingsStore 不该有 chats 相关键：${chatKeys.join(' | ')}`);
    const settingsFields = STORE.slice(
      STORE.indexOf('export interface ScheduleSettings'),
      STORE.indexOf('/** 同步状态的部分更新')
    );
    assert.equal(/chat/i.test(settingsFields), false, 'ScheduleSettings 不该有 chat 配置字段');
  });
});

describe('mod-cloud-chat-no-config-note：零设置面（说明绝迹）+ 空态短下一步 + 列表路径不变', () => {
  // old → new：旧「列表常驻 CHAT_GIT_EXPLANATION 说明行」改为「该说明及机制提示绝迹、
  // 空态给一句配置仓库」。不是删断言/放弱——旧断言只证明「有一段只读文字」，
  // 新断言证明「整页没有任何设置/机制说明 UI」且功能路径完好，覆盖面严格更大。
  test('会话列表没有配置/机制说明段落；空态事实句以「先在设置里配置仓库」开头', () => {
    assert.equal(CHATS.includes(RETIRED_EXPLANATION), false, '旧的只读来源说明必须彻底删除');
    assert.equal(/CHAT_GIT_EXPLANATION/.test(CHATS), false, '说明常量必须删除，不是改名复活');
    assert.equal(/从同步仓库读取/.test(CHATS), false, '副标题不再解释存储机制');
    assert.equal(/TextInput\(\{ text: this\.chat/.test(CHATS), false, '云端列表页不该有配置输入框');
    assert.match(CHATS, /const EMPTY_CLOUD_TITLE: string = '还没有云端对话';/, '空态标题仍在');
    assert.match(CHATS, /const EMPTY_CLOUD_DETAIL: string =[\s\S]{0,120}先在设置里配置仓库/,
      '空态说明以配置仓库为短下一步');
    const body = CHATS.slice(CHATS.indexOf('Body() {'), CHATS.indexOf('build() {'));
    assert.equal(/Text\(CHAT_GIT_EXPLANATION\)/.test(body), false, '列表区不再渲染说明段落');
    const empty = CHATS.slice(CHATS.indexOf('EmptyCloudChats() {'), CHATS.indexOf('EmptyDotsChats() {'));
    assert.match(empty, /title: EMPTY_CLOUD_TITLE/, '空态仍渲染标题');
    assert.match(empty, /detail: EMPTY_CLOUD_DETAIL/, '空态仍渲染下一步文案');
    // Lead 已否决同步 / 导出按钮：正向钉住显式 opt-out，反向钉住按钮文案 / 回调 / 刷新动作绝迹。
    assert.match(empty, /showAction: false/, '空态显式不渲染按钮');
    assert.equal(/actionLabel:/.test(empty), false, '空态不再传按钮文案');
    assert.equal(/onAction:/.test(empty), false, '空态不再挂按钮回调');
    assert.equal(/this\.pullAndReload\(\)/.test(empty), false, '空态不再触发刷新');
  });

  test('外壳云端面板没有配置/说明段落；保留禁用原因与短下一步（不造假行）', () => {
    assert.equal(PANE.includes(RETIRED_EXPLANATION), false, 'CloudChatPane 必须删掉同一条只读说明');
    assert.equal(/CHAT_GIT_EXPLANATION/.test(PANE), false, '面板里的说明常量必须删除');
    assert.equal(/TextInput\(/.test(PANE), false, '云端面板不该有输入框');
    assert.match(PANE, /const CLOUD_REPO_SETUP: string = '先在设置里配置仓库';/, '面板空态给短下一步');
    assert.match(PANE, /Text\(CLOUD_REPO_SETUP\)/, '短下一步渲染在面板里');
    assert.match(PANE, /REASON_CLOUD/, '禁用主操作的逐字原因仍在（无假入口）');
    assert.match(PANE, /会话列表与只读详情即将迁入/, 'truthful 空态说明仍在');
  });

  test('列表 / 会话导航 / 同步路径都在：删的是说明，不是功能', () => {
    assert.match(CHAT_STORE, /chats\/index\.jsonl/, '数据源仍是 git 工作副本的 chats/index.jsonl');
    assert.match(CHATS, /chatStore\.listChats\(\)/, '列表仍从 chatStore 读取');
    assert.match(CHATS, /ForEach\(\s*this\.visibleChats/, '会话列表 ForEach 仍在');
    assert.match(CHATS, /this\.ChatList\(\)/, '列表区仍渲染 ChatList');
    assert.match(CHATS, /private openDetail\(id: string\): void/, '点行进只读详情的方法仍在');
    assert.match(CHATS, /router\.pushUrl\(\{ url: 'pages\/ChatDetail'/, '会话导航路由仍在');
    assert.match(CHATS, /pullAndReload/, '下拉刷新 / 同步路径仍在');
  });
});
