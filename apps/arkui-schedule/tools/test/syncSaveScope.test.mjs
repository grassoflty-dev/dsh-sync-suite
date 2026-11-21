// mod-settings-sync-page（风险守卫）：同步字段的“单一写入路径 + patch 不覆盖”契约。
//
// 背景：架构 A 保留了 SettingsHost 里的 sync @State / saveSettings 供 API / Data 子页复用。
// 若 settingsStore.save() 是整表替换，那么从 API / Data 页点「保存」会用那份陈旧状态覆盖
// repoUrl / token —— 这正是需要钉住的回归。这里用源码守卫固化三条事实：
//   1. save() 对未提供的键保留原值（patch 语义），尤其 repoUrl / token；
//   2. SettingsHost 保存前必从 settingsStore.load() 铺回这两个值（pass-through，不是空默认值）；
//   3. 唯一可编辑路径在 pages/SettingsSync；两处写入同时存在时，以用户实际编辑的同步页为准，
//      宿主只回写原值（字节不变）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ETS_ROOT } from './settingsSources.mjs';

const store = readFileSync(join(ETS_ROOT, 'services', 'settingsStore.ets'), 'utf8');
const host = readFileSync(join(ETS_ROOT, 'components', 'settings', 'SettingsHost.ets'), 'utf8');
const page = readFileSync(join(ETS_ROOT, 'pages', 'SettingsSync.ets'), 'utf8');

describe('syncSaveScope：同步字段的 patch 安全 / 单一写入路径', () => {
  test('P-1 settingsStore.save 是 patch：repoUrl / token 未提供键时保留 current 原值', () => {
    assert.match(
      store,
      /repoUrl:\s*patch\.repoUrl === undefined \? current\.repoUrl : patch\.repoUrl\.trim\(\)/,
      'repoUrl 未出现在 patch 中必须保持原值'
    );
    assert.match(
      store,
      /token:\s*patch\.token === undefined \? current\.token : patch\.token\.trim\(\)/,
      'token 未出现在 patch 中必须保持原值'
    );
    assert.match(store, /const current = await this\.load\(\);/, 'patch 必须基于磁盘当前值合并');
  });

  test('P-2 API / Data 页的宿主 save：保存前从 store 铺回 repoUrl / token（不是空默认值）', () => {
    assert.match(host, /const settings = await settingsStore\.load\(\);/, '宿主保存链必须先读盘');
    assert.match(host, /this\.repoUrl = settings\.repoUrl;/, 'repoUrl 铺回宿主状态');
    assert.match(host, /this\.token = settings\.token;/, 'token 铺回宿主状态');
    assert.match(host, /repoUrl: repoEmpty \? '' : repoCheck\.url,/, '宿主回写的是读盘原值 / 校验后原值');
    assert.match(host, /token: effectiveToken\(this\.token, this\.savedToken\),/, 'token 留空沿用已存值');
  });

  test('P-3 唯一可编辑路径：同步页自己的 patch 写 repoUrl / token，宿主不再装配该表单', () => {
    assert.match(page, /const patch: SettingsPatch = \{[\s\S]{0,240}repoUrl: repoEmpty \? '' : repoCheck\.url,/,
      '同步页写入 repoUrl');
    assert.match(page, /token: effectiveToken\(this\.token, this\.savedToken\),/, '同步页写入 token');
    assert.equal(/SyncSection\(\{/.test(host), false, '宿主不得再装配同步表单');
    // 写入冲突时的胜者：同步页是唯一让用户改这两个字段的入口；宿主只在 API / Data 保存时
    // 把读盘值原样回写（P-2），因此两处同时写不会产生分歧。
    assert.match(page, /SyncSection\(\{/, '同步页装配真实表单（写入者）');
  });
});
