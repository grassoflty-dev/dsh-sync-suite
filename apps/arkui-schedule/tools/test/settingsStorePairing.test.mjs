// `services/settingsStore.ets` 的键读写成对性与「AI 模型取用时序」静态检查。
//
// 为什么用静态检查：`settingsStore`/`deepseek`/`Index` 是 .ets（依赖 @kit.ArkData 与 ArkUI 运行时），
// 在 Node 里跑不了；但「每个 KEY 既在 load 读、又在 save 写」「新键有默认值」「模型在 load 之后才取」
// 是纯文本可判定的事实，用测试固化它们能挡住「加键忘记读写」「save 把新键丢掉」这类回归。
//
// 前置：无需构建（不 import .build），直接读源码。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const SETTINGS_STORE = readFileSync(new URL('services/settingsStore.ets', ETS), 'utf8');
const DEEPSEEK = readFileSync(new URL('services/deepseek.ets', ETS), 'utf8');
const INDEX = readFileSync(new URL('pages/Index.ets', ETS), 'utf8');
const SETTINGS_PAGE = readFileSync(new URL('pages/Settings.ets', ETS), 'utf8');

/** 取出所有 `const KEY_X: string = 'x';` 声明：常量名 → 存储键名。 */
function keyConstants(source) {
  const result = new Map();
  const pattern = /const\s+(KEY_[A-Z0-9_]+)\s*:\s*string\s*=\s*'([^']+)'\s*;/g;
  let matched;
  while ((matched = pattern.exec(source)) !== null) {
    result.set(matched[1], matched[2]);
  }
  return result;
}

/** 截取某个方法体（从 `签名` 到下一个顶层 `async `/`/**` 段落）。 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到方法：${signature}`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:async |private |\/\*\*)/);
  return end < 0 ? rest : rest.slice(0, end);
}

const KEYS = keyConstants(SETTINGS_STORE);
const LOAD_BODY = methodBody(SETTINGS_STORE, 'async load(');
const SAVE_BODY = methodBody(SETTINGS_STORE, 'async save(');
const SYNC_STATE_BODY = methodBody(SETTINGS_STORE, 'async saveSyncState(');

describe('settingsStore：每个 KEY 都成对读写', () => {
  test('至少 11 个键（8 个设置 + 3 个同步状态）', () => {
    assert.ok(KEYS.size >= 11, `键太少：${KEYS.size} → ${[...KEYS.keys()].join(',')}`);
  });

  test('每个 KEY 在 load() 里被 prefs.get 读取', () => {
    for (const [constant, storageKey] of KEYS) {
      assert.ok(LOAD_BODY.includes(`prefs.get(${constant}`), `load() 没有读取 ${constant}（${storageKey}）`);
    }
  });

  test('每个 KEY 在 save() 里被 prefs.put 写回（否则保存会丢掉新键）', () => {
    for (const [constant, storageKey] of KEYS) {
      const inSave = SAVE_BODY.includes(`prefs.put(${constant}`);
      const inSyncState = SYNC_STATE_BODY.includes(`prefs.put(${constant}`);
      assert.ok(inSave || inSyncState, `save()/saveSyncState() 都没有写入 ${constant}（${storageKey}）`);
    }
  });

  test('三个同步状态键只在 saveSyncState() 里写（save 不应重置它们）', () => {
    for (const name of ['KEY_LAST_SYNC_AT', 'KEY_LAST_SYNC_ERROR', 'KEY_LAST_SYNC_ACTION']) {
      assert.ok(SYNC_STATE_BODY.includes(`prefs.put(${name}`), `saveSyncState() 缺少 ${name}`);
    }
  });

  test('P1/P2 新键的默认值符合契约（github / https / deepseek-chat）', () => {
    assert.match(LOAD_BODY, /prefs\.get\(KEY_AI_MODEL,\s*DEFAULT_AI_MODEL\)/, 'aiModel 默认必须是 DEFAULT_AI_MODEL');
    assert.match(LOAD_BODY, /prefs\.get\(KEY_GIT_PLATFORM,\s*PLATFORM_GITHUB\)/, 'gitPlatform 默认必须是 github');
    assert.match(LOAD_BODY, /prefs\.get\(KEY_AUTH_MODE,\s*AUTH_HTTPS\)/, 'authMode 默认必须是 https');
    assert.match(LOAD_BODY, /prefs\.get\(KEY_LAST_SYNC_AT,\s*''\)/, 'lastSyncAt 默认空串');
    assert.match(LOAD_BODY, /prefs\.get\(KEY_LAST_SYNC_ERROR,\s*''\)/, 'lastSyncError 默认空串');
    assert.match(LOAD_BODY, /prefs\.get\(KEY_LAST_SYNC_ACTION,\s*''\)/, 'lastSyncAction 默认空串');
  });

  test('读取到未知值时归一化（aiModel / 平台 / 认证方式），不把脏值带进界面', () => {
    assert.match(LOAD_BODY, /normalizeAiModel\(aiModel\)/);
    assert.match(LOAD_BODY, /normalizePlatform\(gitPlatform\)/);
    assert.match(LOAD_BODY, /normalizeAuthMode\(authMode\)/);
    assert.match(LOAD_BODY, /normalizeSyncAction\(lastSyncAction\)/);
  });

  test('load() 的返回值覆盖 ScheduleSettings 的全部字段（逐字段构造，不用展开）', () => {
    const interfaceBlock = SETTINGS_STORE.slice(
      SETTINGS_STORE.indexOf('export interface ScheduleSettings'),
      SETTINGS_STORE.indexOf('/** 同步状态的部分更新')
    );
    const fields = [...interfaceBlock.matchAll(/^\s{2}([a-zA-Z]+)\s*:\s*string\s*;/gm)].map((item) => item[1]);
    assert.ok(fields.length >= 11, `字段太少：${fields.join(',')}`);
    for (const field of fields) {
      assert.ok(LOAD_BODY.includes(`${field}:`), `load() 未构造字段 ${field}`);
      assert.ok(SAVE_BODY.includes(`${field}:`), `save() 未构造字段 ${field}`);
      assert.ok(SYNC_STATE_BODY.includes(`${field}:`), `saveSyncState() 未构造字段 ${field}`);
    }
  });
});

describe('设置页：仓库地址可空保存，但同步/测试连接前强校验（P5 决策 1）', () => {
  test('saveSettings 先算 repoEmpty，空地址时不强制 token/地址格式', () => {
    assert.match(SETTINGS_PAGE, /const repoEmpty: boolean = this\.repoUrl\.trim\(\)\.length === 0;/);
    assert.match(
      SETTINGS_PAGE,
      /const tokenError: string = repoEmpty \? '' : validateToken\(this\.authMode, this\.token\);/,
      'token 必填必须被 repoEmpty 短路，否则首次使用无法保存'
    );
    assert.match(SETTINGS_PAGE, /const repoError: string = repoEmpty \|\| repoCheck\.ok \? '' : repoCheck\.error;/, '空地址不报错');
    assert.match(SETTINGS_PAGE, /repoUrl: repoEmpty \? '' : repoCheck\.url,/, '空地址存空串，不把非法原文写进设置');
  });

  test('空地址保存时给提示（用户知道同步前还要补填）', () => {
    assert.match(SETTINGS_PAGE, /设置已保存（\$\{nowIso\(\)\}）；仓库地址为空，同步前需要先填写/);
  });

  test('发请求前仍有强校验：saveSettings / testConnection / runAction 共三处校验仓库地址', () => {
    const checks = [...SETTINGS_PAGE.matchAll(/validateRepoUrl\(this\.repoUrl\)/g)];
    assert.ok(checks.length >= 3, `仓库地址校验点太少：${checks.length}`);
    assert.match(SETTINGS_PAGE, /if \(!repoCheck\.ok\) \{\s*this\.syncMessage = `请先修正仓库地址：\$\{repoCheck\.error\}`;/, '同步前必须拦住非法/空地址');
    assert.match(SETTINGS_PAGE, /if \(!repoCheck\.ok\) \{\s*this\.connectionText = `❌ 无法测试：\$\{repoCheck\.error\}`;/, '测试连接前必须拦住非法/空地址');
  });

  test('同步区展示上次同步时间、上次错误与重试按钮', () => {
    assert.match(SETTINGS_PAGE, /Text\(describeLastSync\(this\.lastSyncAt, nowIso\(\)\)\)/);
    assert.match(SETTINGS_PAGE, /if \(this\.lastSyncError\.length > 0\) \{\s*Text\(`上次错误：\$\{this\.lastSyncError\}`\)/);
    assert.match(SETTINGS_PAGE, /if \(canRetrySync\(this\.lastSyncAction, this\.syncBusy\)\) \{/, '重试按钮必须由上次动作驱动');
    assert.match(SETTINGS_PAGE, /this\.runAction\(this\.lastSyncAction\);/, '重试要重放上一次动作');
  });
});

describe('cachedAiModel 与 load() 的时序：summarize 不会拿不到模型', () => {
  test('cachedAiModel 在缓存为空时返回空串，有缓存时返回归一化后的模型名', () => {
    assert.match(SETTINGS_STORE, /cachedAiModel\(\): string \{[\s\S]*?if \(this\.cache === null\) \{[\s\S]*?return '';/);
    assert.match(SETTINGS_STORE, /return this\.cache\.aiModel\.trim\(\);/);
  });

  test('deepseek.resolveModel 的优先级：显式参数 > 设置缓存 > 默认 deepseek-chat', () => {
    const body = methodBody(DEEPSEEK, 'function resolveModel(');
    const explicitIndex = body.indexOf('explicit');
    const cachedIndex = body.indexOf('cachedAiModel()');
    const defaultIndex = body.lastIndexOf('DEFAULT_AI_MODEL');
    assert.ok(explicitIndex >= 0 && cachedIndex > explicitIndex, '先看显式参数，再回落缓存');
    assert.ok(defaultIndex > cachedIndex, '缓存为空才回落默认模型');
    assert.match(body, /return DEFAULT_AI_MODEL;/);
  });

  test('Index 的 AI 汇总流程：先 settingsStore.load()、后 summarize()（缓存已就绪）', () => {
    const loadIndex = INDEX.indexOf('settingsStore.load(');
    const summarizeIndex = INDEX.indexOf('await summarize(');
    assert.ok(loadIndex > 0, 'Index 没有加载设置');
    assert.ok(summarizeIndex > loadIndex, 'summarize 必须在 settingsStore.load() 之后调用，否则 cachedAiModel() 为空');
    // 同一方法内：aiKey 也来自刚才 load 的结果，避免与缓存的模型版本错位
    assert.match(INDEX, /aiKey = settings\.aiKey;/);
  });

  test('设置页保存模型后无需重启：applySettings 把 saved.aiModel 铺回 @State', () => {
    assert.match(SETTINGS_PAGE, /this\.aiModel = settings\.aiModel;/);
    assert.match(SETTINGS_PAGE, /aiModel: this\.aiModel,/);
  });
});
