// mod-settings-cloud-no-config：云端会话不需要配置，靠同步仓库的 chats/ 做多端同步与续接。
// 守卫三件事：① 设置页 / 设置存储里没有云端会话的配置行、字段或键；
// ② 会话列表与外壳面板都常驻一行**只读来源说明**（Git + chats/），不是设置行、不可编辑；
// ③ 列表仍然从 git 工作副本的 chats/index.jsonl 读数据（没有把功能一起删掉）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readSettingsFile, readSettingsPage, readSettingsSources } from './settingsSources.mjs';

// mod-settings-root（old→new）：入口行随实现从 pages/Settings.ets 搬到组件宿主；
// 本用例只查「导航入口里没有配置控件」，断言不变，只换锚点。
const PAGE = readSettingsPage();
const SOURCES = readSettingsSources();
const STORE = readSettingsFile('services/settingsStore.ets');
const CHATS = readSettingsFile('pages/Chats.ets');
const PANE = readSettingsFile('pages/panes/CloudChatPane.ets');
const CHAT_STORE = readSettingsFile('services/chatStore.ets');

const EXPECTED = '会话保存在同步仓库的 chats/ 目录，通过 Git 在多端同步；本页只读，对话续接请在电脑上继续。';

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
    // 「远程实例与云端对话 ›」只是导航入口，不是配置行：没有输入框、没有 URL / token。
    const entry = PAGE.slice(PAGE.indexOf('ChatEntryRow() {'), PAGE.indexOf('private openInstances()'));
    assert.equal(/TextInput\(/.test(entry), false, '入口行不该有输入框');
    assert.match(entry, /router\.pushUrl|this\.openInstances\(\)/, '入口只做跳转');
    assert.match(SOURCES, /远程实例与云端对话/, '入口文案仍在（导航，不是配置）');
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

describe('mod-settings-cloud-no-config：只读来源说明常驻，列表仍从 chats/ 读', () => {
  test('会话列表有只读说明行：Git + chats/ + 电脑上续接', () => {
    assert.ok(CHATS.includes(EXPECTED), 'Chats 页必须常驻这条只读说明');
    assert.match(CHATS, /const CHAT_GIT_EXPLANATION: string =/, '说明必须是常量，不是可编辑字段');
    const body = CHATS.slice(CHATS.indexOf('Body() {'), CHATS.indexOf('build() {'));
    assert.match(body, /Text\(CHAT_GIT_EXPLANATION\)/, '说明要在列表区渲染（不是设置弹层）');
    assert.equal(/TextInput\(\{ text: this\.chat/.test(body), false, '说明旁不该出现配置输入框');
  });

  test('外壳云端面板也有同一条说明（面板不是设置行）', () => {
    assert.ok(PANE.includes(EXPECTED), 'CloudChatPane 必须常驻同一条只读说明');
    assert.match(PANE, /Text\(CHAT_GIT_EXPLANATION\)/, '说明要在面板里渲染');
    assert.equal(/TextInput\(/.test(PANE), false, '云端面板不该有输入框');
  });

  test('列表数据源没变：chatStore 仍读同步仓库的 chats/index.jsonl', () => {
    assert.match(CHAT_STORE, /chats\/index\.jsonl/, '数据源仍是 git 工作副本的 chats/index.jsonl');
    assert.match(CHATS, /chatStore/, '页面仍从 chatStore 读取');
    assert.match(CHATS, /pullAndReload/, '下拉刷新 / 同步路径仍在');
  });
});
