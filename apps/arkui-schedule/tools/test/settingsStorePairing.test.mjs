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
import { readSettingsSources } from './settingsSources.mjs';

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const SETTINGS_STORE = readFileSync(new URL('services/settingsStore.ets', ETS), 'utf8');
const DEEPSEEK = readFileSync(new URL('services/deepseek.ets', ETS), 'utf8');
const INDEX = readFileSync(new URL('pages/Index.ets', ETS), 'utf8');
// 因 A2 拆分移动：上次同步行 / 重试入口现在分别渲染在 AboutSection 与页面的「更多」弹层里。
// 断言关心的是「设置页整体有没有读写/渲染这些键」，锚点改成页面 + 五个 section 的合并源码。
const SETTINGS_PAGE = readSettingsSources();

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
/**
 * mod-ai-models-fetch：模型列表缓存是**独立读写路径**的键，不进 `load()` / `save()` 整表 patch。
 * 因此从「整表成对」清单里单独列出，并在下面用更强的断言钉住它自己的 get/put 成对性
 * （不能因为表单保存把它清掉，也不能因为刷新缓存把其它设置清掉）。
 */
const INDEPENDENT_KEYS = new Set(['KEY_AI_MODELS_CACHE']);
const LOAD_BODY = methodBody(SETTINGS_STORE, 'async load(');
const SAVE_BODY = methodBody(SETTINGS_STORE, 'async save(');
const SYNC_STATE_BODY = methodBody(SETTINGS_STORE, 'async saveSyncState(');

describe('settingsStore：每个 KEY 都成对读写', () => {
  test('至少 11 个键（8 个设置 + 3 个同步状态）', () => {
    assert.ok(KEYS.size >= 11, `键太少：${KEYS.size} → ${[...KEYS.keys()].join(',')}`);
  });

  test('每个整表 KEY 在 load() 里被 prefs.get 读取', () => {
    for (const [constant, storageKey] of KEYS) {
      if (INDEPENDENT_KEYS.has(constant)) {
        continue;
      }
      assert.ok(LOAD_BODY.includes(`prefs.get(${constant}`), `load() 没有读取 ${constant}（${storageKey}）`);
    }
  });

  test('每个整表 KEY 在 save() 里被 prefs.put 写回（否则保存会丢掉新键）', () => {
    for (const [constant, storageKey] of KEYS) {
      if (INDEPENDENT_KEYS.has(constant)) {
        continue;
      }
      const inSave = SAVE_BODY.includes(`prefs.put(${constant}`);
      const inSyncState = SYNC_STATE_BODY.includes(`prefs.put(${constant}`);
      assert.ok(inSave || inSyncState, `save()/saveSyncState() 都没有写入 ${constant}（${storageKey}）`);
    }
  });

  test('KEY_AI_MODELS_CACHE 独立成对：自有 get/put，且整表 load/save/saveSyncState 都不碰它', () => {
    const loadCache = methodBody(SETTINGS_STORE, 'async loadAiModelsCache(');
    const saveCache = methodBody(SETTINGS_STORE, 'async saveAiModelsCache(');
    assert.match(loadCache, /prefs\.get\(KEY_AI_MODELS_CACHE, ''\)/, '缓存读取必须成对');
    assert.match(saveCache, /prefs\.put\(KEY_AI_MODELS_CACHE, encodeAiModelsCache\(next\)\)/, '缓存写入必须成对');
    for (const [name, body] of [['load()', LOAD_BODY], ['save()', SAVE_BODY], ['saveSyncState()', SYNC_STATE_BODY]]) {
      assert.equal(body.includes('KEY_AI_MODELS_CACHE'), false, `${name} 不得覆盖模型列表缓存`);
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
    // 校验已搬到纯函数 checkSettingsFields：断言调用点 + 用它拿到全部问题
    assert.match(SETTINGS_PAGE, /checkSettingsFields\(/, '保存前必须走纯函数整表校验');
    assert.match(SETTINGS_PAGE, /const issues: SettingsFieldIssue\[\] = checkSettingsFields\(/, '收集全部问题而不是只报第一条');
    assert.match(SETTINGS_PAGE, /token: effectiveToken\(this\.token, this\.savedToken\),/, 'token 留空沿用已保存值');
    // A1：平台不再用 settingsForm 的两值纠正，而是按地址推断四值平台（gitlab/custom 也要保留）
    assert.match(
      SETTINGS_PAGE,
      /resolvePlatformSelection\(\s*this\.repoUrl,\s*this\.gitPlatform,\s*this\.platformTouched\s*\)/,
      '保存前按 URL 推断/纠正平台（手动选择优先）'
    );
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
    // A2：时间 + 动作 + 成败（describeLastSyncOutcome 内部仍调用 describeLastSync）
    assert.match(
      SETTINGS_PAGE,
      /Text\(describeLastSyncOutcome\(this\.lastSyncAt, this\.lastSyncError, this\.lastSyncAction, nowIso\(\)\)\)/
    );
    // A 批：单行「上次错误」Text 升级为结构化错误态 ErrorState
    //（三段式：发生了什么 / 为什么 / 下一步 + 可复制诊断 + 重试），见 docs/STATE-UI.md §4.3
    assert.match(
      SETTINGS_PAGE,
      /if \(this\.lastSyncError\.length > 0\) \{\s*ErrorState\(\{\s*what: SYNC_ERROR_WHAT,\s*why: this\.errorReason\(this\.lastSyncError\)/,
      '上次错误必须走 ErrorState（含 why = errorReason(lastSyncError)）'
    );
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

// ---------------------------------------------------------------- 数据边界：设备编号自动分配
//
// 主表单不再让用户填设备标识：编号由仓库 `devices/registry.jsonl` 分配（uuid 是身份）。
// 这条链路要成立，两个新键必须**成对**读写，且同步服务登记成功后必须写回设置。

describe('数据边界：deviceUuid / deviceIdAuto 的读写与回写', () => {
  const GIT_SERVICE = readFileSync(new URL('services/GitSyncService.ets', ETS), 'utf8');

  test('两个新键：常量 + 默认值 + load/save 成对', () => {
    assert.match(SETTINGS_STORE, /const KEY_DEVICE_UUID: string = 'deviceUuid';/);
    assert.match(SETTINGS_STORE, /const KEY_DEVICE_ID_AUTO: string = 'deviceIdAuto';/);
    assert.match(LOAD_BODY, /prefs\.get\(KEY_DEVICE_UUID,\s*''\)/, 'load() 必须读 uuid');
    assert.match(LOAD_BODY, /prefs\.get\(KEY_DEVICE_ID_AUTO,\s*false\)/, '旧数据没有该键 → false');
    assert.match(SAVE_BODY, /prefs\.put\(KEY_DEVICE_UUID, next\.deviceUuid\)/, 'save() 必须写回 uuid');
    assert.match(SAVE_BODY, /prefs\.put\(KEY_DEVICE_ID_AUTO, next\.deviceIdAuto\)/, 'save() 必须写回来源标记');
  });

  test('ScheduleSettings / SettingsPatch 都有这两个字段（否则保存即丢）', () => {
    assert.match(SETTINGS_STORE, /deviceUuid: string;/);
    assert.match(SETTINGS_STORE, /deviceIdAuto: boolean;/);
    assert.match(SETTINGS_STORE, /deviceUuid\?: string;/);
    assert.match(SETTINGS_STORE, /deviceIdAuto\?: boolean;/);
    // 未传 = 不改（设置页只改设备标识时不该把身份清空）
    assert.match(SETTINGS_STORE, /deviceUuid: patch\.deviceUuid === undefined \? current\.deviceUuid/);
  });

  test('同步服务登记成功后写回 {deviceId, deviceIdAuto, deviceUuid}', () => {
    assert.match(GIT_SERVICE, /deviceId: outcome\.deviceId/);
    assert.match(GIT_SERVICE, /deviceIdAuto: outcome\.auto/);
    assert.match(GIT_SERVICE, /deviceUuid: outcome\.uuid/);
    // 身份只留一个：`.device-fingerprint` 的内容 = registry 的 uuid = settings 的两个键（同一个值）
    assert.match(
      GIT_SERVICE,
      /deviceUuid: outcome\.uuid,\s*deviceFingerprint: outcome\.uuid/,
      '登记成功后 settings 的两个键必须是同一个 uuid'
    );
    assert.match(GIT_SERVICE, /adoptRepoFingerprintUnder\(outcome\.deviceId, outcome\.uuid\)/, '指纹文件写同一个 uuid');
    assert.equal(
      /generateFingerprint\(\)/.test(GIT_SERVICE),
      false,
      '服务里不许再独立生成一个身份串（uuid 只由 resolveIdentity 生成）'
    );
  });
});
