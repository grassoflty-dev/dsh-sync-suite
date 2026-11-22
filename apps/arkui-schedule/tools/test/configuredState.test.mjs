// mod-settings-configured-state：已配置判据（设置页 / 同步周期共用）回归测试。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

// 编译产物里的相对 import 不带扩展名（与 aiFallback.test.mjs 同一套写法）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const {
  E_REPO_UNCONFIGURED,
  isRepoConfigured,
  readRepoConfigFromPrefs,
  repoConfigStateOf,
  repoCycleGuard,
  repoRowSummary
} = await import('../.build/model/repoConfigured.js');
const { encodeEnvelope } = await import('../.build/model/configSchema.js');
const { repoHostOf } = await import('../.build/model/settingsMenu.js');

const readEts = (rel) => readFileSync(new URL(`../../entry/src/main/ets/${rel}`, import.meta.url), 'utf8');
const SETTINGS_PAGE = readEts('pages/Settings.ets');
const CYCLE_STORE = readEts('services/syncProtocolStore.ets');
const SETTINGS_STORE = readEts('services/settingsStore.ets');
const SYNC_PAGE = readEts('pages/SettingsSync.ets');
const PURE = readEts('model/repoConfigured.ts');

const REPO = 'https://gitee.com/ding_haoran/dsh-dots-test.git';
const TOKEN = 'x'.repeat(32); // 形状占位，不是任何真实凭据
const FLAT = { repoUrl: REPO, token: TOKEN, authMode: 'https' };

/**
 * 内存偏好 seam：与生产 `settingsStore.load()` 注入的是同一个接口（getFlat / getEnvelope）。
 * 额外暴露 put 计数器：若合并读口偷偷写盘，测试会抓到（该读口必须是零写入）。
 */
function prefsSeam(flat = {}, envelope = '') {
  const state = { writes: 0 };
  const seam = {
    state,
    getFlat: async (key) => (typeof flat[key] === 'string' ? flat[key] : ''),
    getEnvelope: async () => envelope,
    put: async () => { state.writes += 1; }
  };
  return seam;
}

test('C1 扁平键 repoUrl + token（冷读）⇒ 已配置，周期 guard 放行（注入 seam 断言，不是文案）', async () => {
  const seam = prefsSeam(FLAT, '');
  const config = await readRepoConfigFromPrefs(seam);
  const state = repoConfigStateOf(config);
  assert.equal(state.configured, true);
  assert.deepEqual(state.missing, []);
  assert.equal(isRepoConfigured(config), true);
  const guard = repoCycleGuard(config); // seam 的返回值直接注入 guard
  assert.equal(guard.start, true, 'guard 必须真的允许周期启动');
  assert.equal(guard.code, '');
  assert.equal(guard.message, '');
  assert.equal(seam.state.writes, 0, '读路径不得写盘');
  // 生产 load() 用的确实是这个合并读口；扁平键 prefs.get 仍在（读写成对断言不放宽）。
  assert.match(SETTINGS_STORE, /readRepoConfigFromPrefs\(\{/);
  assert.match(SETTINGS_STORE, /getFlat: async/);
  assert.match(SETTINGS_STORE, /getEnvelope: async/);
  assert.match(SETTINGS_STORE, /prefs\.get\(KEY_REPO_URL, ''\)/);
  assert.match(SETTINGS_STORE, /prefs\.get\(KEY_TOKEN, ''\)/);
});

test('C2 扁平键全缺、只有 config.schema 信封 ⇒ 已配置（迁移装机态，行为证明）', async () => {
  const seam = prefsSeam({}, encodeEnvelope(FLAT));
  const config = await readRepoConfigFromPrefs(seam); // 走生产同一个合并函数
  assert.equal(config.repoUrl, REPO, '信封里的 repoUrl 必须被读到');
  assert.equal(config.token, TOKEN, '信封里的 token 必须被读到');
  assert.equal(repoConfigStateOf(config).configured, true);
  assert.equal(repoCycleGuard(config).start, true, '迁移态周期 guard 必须放行');
  assert.equal(seam.state.writes, 0, '兜底读不得写盘 / 不得覆盖原字节');
  // 源码形状保留，但已不是唯一证据。
  assert.match(PURE, /decoded\.state === 'ok' \|\| decoded\.state === 'legacy'/);
});

test('C3 什么都没存 ⇒ 未配置，UI 逐项点名缺失字段', () => {
  const empty = repoConfigStateOf({ repoUrl: '', token: '' });
  assert.equal(empty.configured, false);
  assert.deepEqual(empty.missing, ['仓库地址', '访问令牌']);
  assert.equal(repoRowSummary('未配置', '未同步', empty, false), '未配置：缺少仓库地址、访问令牌');
  assert.equal(
    repoRowSummary('未配置', '未同步', repoConfigStateOf({ repoUrl: REPO, token: '' }), false),
    '未配置：缺少访问令牌'
  );
  assert.equal(
    repoRowSummary('未配置', '未同步', repoConfigStateOf({ repoUrl: '', token: TOKEN }), false),
    '未配置：缺少仓库地址'
  );
  const guard = repoCycleGuard({ repoUrl: '', token: '' });
  assert.equal(guard.start, false);
  assert.equal(guard.code, E_REPO_UNCONFIGURED);
});

test('C4 被隐私阻断的仓库 ⇒ 已配置 AND 阻断，文案不是「未配置」', () => {
  const state = repoConfigStateOf(FLAT);
  assert.equal(state.configured, true);
  const text = repoRowSummary('gitee.com', '未同步', state, true);
  assert.match(text, /已配置/);
  assert.match(text, /阻断/);
  assert.equal(text.includes('未配置'), false, '阻断 ≠ 未配置，绝不能混为一谈');
  // 推送许可仍是独立的 privacy lane，没有因为新判据被删掉或放宽。
  assert.match(CYCLE_STORE, /repoVisibilityChecker\.guardPush\(\)/);
  assert.match(CYCLE_STORE, /if \(!guard\.allowed\)/);
  assert.match(PURE, /repoCycleGuard/);
});

test('C5 保存后冷读仍已配置 + 坏信封 fail-closed（行为证明 + 双写形状）', async () => {
  const envelope = encodeEnvelope({ ...FLAT, author: '我' });
  // 保存态：扁平键与信封同时存在 —— 仍须已配置。
  const saved = await readRepoConfigFromPrefs(prefsSeam(FLAT, envelope));
  assert.equal(repoConfigStateOf(saved).configured, true);
  assert.equal(repoCycleGuard(saved).start, true);
  // 冷读：扁平键被历史流程清掉、信封仍在 —— 仍须已配置。
  const coldSeam = prefsSeam({}, envelope);
  const cold = await readRepoConfigFromPrefs(coldSeam);
  assert.equal(cold.repoUrl, REPO);
  assert.equal(cold.token, TOKEN);
  assert.equal(repoConfigStateOf(cold).configured, true);
  assert.equal(repoCycleGuard(cold).start, true);
  assert.equal(coldSeam.state.writes, 0);
  // 坏信封 + 无扁平键 ⇒ 未配置，且零写入（不覆盖原字节）。
  const corruptSeam = prefsSeam({}, '{坏字节');
  const corrupt = await readRepoConfigFromPrefs(corruptSeam);
  assert.equal(repoConfigStateOf(corrupt).configured, false);
  assert.match(repoRowSummary('未配置', '未同步', repoConfigStateOf(corrupt), false), /未配置：缺少/);
  assert.equal(corruptSeam.state.writes, 0);
  // save() 双写的源码形状保留（任何一条断掉就是「保存后冷读丢配置」）。
  assert.match(SETTINGS_STORE, /prefs\.put\(KEY_REPO_URL, next\.repoUrl\)/);
  assert.match(SETTINGS_STORE, /prefs\.put\(KEY_TOKEN, next\.token\)/);
  assert.match(SETTINGS_STORE, /prefs\.put\(CONFIG_ENVELOPE_KEY, settingsEnvelopeBytes\(next\)\)/);
  // 隐私拒绝路径不落盘、不清空既有配置。
  assert.match(SYNC_PAGE, /if \(!verdict\.ok\) \{[\s\S]{0,200}return;\s*\}/);
});

test('C6 源码形状：UI 判据与周期 guard 读同一个函数，不存在第二份 predicate', () => {
  assert.match(PURE, /export function repoConfigStateOf\(/);
  assert.match(PURE, /export function isRepoConfigured\(/);
  assert.match(PURE, /return repoConfigStateOf\(input\)\.configured/, 'isRepoConfigured 必须复用 repoConfigStateOf');
  assert.match(PURE, /const state: RepoConfigState = repoConfigStateOf\(input\)/, 'repoCycleGuard 必须复用 repoConfigStateOf');

  assert.match(SETTINGS_PAGE, /from '\.\.\/model\/repoConfigured'/);
  assert.match(SETTINGS_PAGE, /repoConfigStateOf\(settings\)/);
  assert.match(SETTINGS_PAGE, /repoRowSummary\(/);
  assert.match(CYCLE_STORE, /from '\.\.\/model\/repoConfigured'/);
  assert.match(CYCLE_STORE, /repoCycleGuard\(repoConfig\)/);
  assert.match(CYCLE_STORE, /this\.configReader\(\)/, '周期配置经注入 seam 读取');
  assert.doesNotMatch(CYCLE_STORE, /repoUrl\.trim\(\)\.length === 0/, '周期里不得再写第二份 repoUrl 空判据');
  assert.doesNotMatch(SETTINGS_PAGE, /repoUrl\.trim\(\)\.length === 0/, 'UI 里不得再写第二份 repoUrl 空判据');
  // 旧断言仍成立：摘要来源依旧是已持久化字段（本模块只是包了一层）。
  assert.match(SETTINGS_PAGE, /repoHostOf\(settings\.repoUrl\)/);
  // mod-status-honesty-regression：严格化——摘要必须同时带权威最新尝试，杜绝旧成功盖住新失败。
  assert.match(SETTINGS_PAGE, /syncRowSummary\(\s*settings\.lastSyncAt, settings\.lastSyncError, syncStatusStore\.latestAttempt\(\)\s*\)/);
});

test('C7 过期缓存类：初值不再是「未配置」，周期每次入环前冷读刷新缓存', () => {
  assert.doesNotMatch(SETTINGS_PAGE, /@State repoSummary: string = '未配置 · 未同步'/);
  assert.match(SETTINGS_PAGE, /@State repoSummary: string = '读取中…'/);
  assert.match(CYCLE_STORE, /setConfigReader\(reader: \(\) => Promise<RepoConfigInput>\)/);
  assert.match(CYCLE_STORE, /const settings: ScheduleSettings = await settingsStore\.load\(\)/);
  assert.match(CYCLE_STORE, /repoUrl: settings\.repoUrl/);
  assert.match(CYCLE_STORE, /token: settings\.token/);
});

test('C8 M1：无主机 URL 不得透传 repoHostOf 的「未配置」占位串', () => {
  const input = { repoUrl: 'https://', token: TOKEN, authMode: 'https' };
  const state = repoConfigStateOf(input);
  assert.equal(state.configured, true, '判据只回答配置齐不齐');
  assert.equal(repoHostOf(input.repoUrl), '未配置', 'repoHostOf 对无主机 URL 确实返回占位串');
  const text = repoRowSummary(repoHostOf(input.repoUrl), '未同步', state, false);
  assert.equal(text, '未配置：仓库地址格式不正确', '必须点名真正的格式问题');
  assert.equal(text.includes('未配置 · '), false, '绝不能再拼出旧缺陷文案');
  const blocked = repoRowSummary(repoHostOf(input.repoUrl), '未同步', state, true);
  assert.equal(blocked, text, '阻断分支不得与格式错误拼成双重标签');
  assert.equal(blocked.includes('已配置（'), false);
  assert.match(PURE, /hostText === REPO_HOST_PLACEHOLDER/);
});
