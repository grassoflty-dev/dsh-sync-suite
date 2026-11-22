// mod-status-honesty-regression：1000008「已同步 · 19:47」盖住「上次失败 · 16:26」的回归测试。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import test from 'node:test';

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
  clockOfIso,
  isOlderLocalDay,
  statusStateOf,
  syncStatusLineOf,
  syncStatusText
} = await import('../.build/model/syncStatusLine.js');

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const readEts = (rel) => readFileSync(new URL(rel, ETS), 'utf8');
const configured = { configured: true, missing: [], reason: '' };
const unconfigured = {
  configured: false,
  missing: ['访问令牌'],
  reason: '未配置：缺少访问令牌'
};
/** 设备实测：旧成功 ISO（2026-11-21 19:47）与最新失败戳（16:26）。 */
const STALE_SUCCESS = '2026-11-21T19:47:20+08:00';
const FAILED = { kind: 'failed', at: '16:26', reason: 'E_NO_MAIN' };
const FAILED_TEXT = '上次失败 · 16:26 · E_NO_MAIN';
const SYNCED = { kind: 'synced', at: '19:47', reason: '' };

const line = (over = {}) => syncStatusLineOf({
  latest: null,
  legacyLastSyncAt: STALE_SUCCESS,
  legacyLastSyncError: '',
  config: configured,
  blocked: false,
  blockAt: '',
  ...over
});

test('H1 成功 only ⇒ 已同步 + 真实时刻', () => {
  assert.equal(line({ latest: SYNCED }), '已同步 · 19:47');
  assert.deepEqual(statusStateOf({
    latest: SYNCED, legacyLastSyncAt: STALE_SUCCESS, legacyLastSyncError: '',
    config: configured, blocked: false, blockAt: ''
  }), { kind: 'synced', at: '19:47' });
});

test('H2 失败 only ⇒ 上次失败 + 真实时刻 + 同行原因（绝不成功、不弹 toast）', () => {
  assert.equal(line({ latest: FAILED }), FAILED_TEXT);
  const src = readEts('model/syncStatusLine.ts');
  assert.equal(/promptAction|showToast/.test(src), false, '渲染器不得弹 toast');
});

test('H3 成功 then 更新的失败 ⇒ 上次失败，旧成功时刻不得出现', () => {
  const text = line({ latest: FAILED, legacyLastSyncAt: STALE_SUCCESS });
  assert.equal(text, FAILED_TEXT);
  assert.equal(text.includes('19:47'), false, '旧成功时刻不得出现在任何失败文案里');
  assert.equal(text.includes('已同步'), false, '绝不能把旧成功冒充当前');
});

test('H4 失败 then 更新的成功 ⇒ 已同步', () => {
  const text = line({ latest: SYNCED, legacyLastSyncAt: '2026-11-21T16:26:00+08:00' });
  assert.equal(text, '已同步 · 19:47');
  assert.equal(text.includes('上次失败'), false);
});

test('H5 五态总函数：每个分支恰好一条文案，无 default 兜底', () => {
  const cases = [
    [{ kind: 'unconfigured', reason: '未配置：缺少访问令牌' }, '未配置：缺少访问令牌'],
    [{ kind: 'never' }, '已配置 · 尚未同步'],
    [{ kind: 'synced', at: '09:05' }, '已同步 · 09:05'],
    [{ kind: 'failed', at: '16:26', reason: 'E_NO_MAIN' }, '上次失败 · 16:26 · E_NO_MAIN'],
    [{ kind: 'blocked', at: '16:26' }, '已配置（可见性阻断，禁止推送） · 最近尝试 16:26']
  ];
  for (const [state, expected] of cases) {
    assert.equal(syncStatusText(state), expected);
  }
  const src = readEts('model/syncStatusLine.ts');
  assert.match(src, /switch \(state\.kind\)/);
  assert.equal(/default:/.test(src), false, 'total function 不允许 default 兜底分支');
  assert.match(src, /StatusLineState\s*=/, '必须是显式状态联合类型');
});

test('H6 注入时钟证明「19:47」与「16:26」可比：19:47 其实属于前一天', () => {
  // 注入 2026-11-22 16:26（Asia/Shanghai，与设备同一时区）。
  const now = new Date(2026, 10, 22, 16, 26, 0);
  const legacyClock = clockOfIso(STALE_SUCCESS, now);
  assert.equal(legacyClock, '19:47', '带 +08:00 的 ISO 折算到本机仍是 19:47：不是时区偏移');
  // 失败戳来自同一台本地时钟：hhmm(now) 的定义见 syncStatusStore.ets:92。
  const failureClock = `${`${now.getHours()}`.padStart(2, '0')}:${`${now.getMinutes()}`.padStart(2, '0')}`;
  assert.equal(failureClock, '16:26');
  assert.equal(isOlderLocalDay(STALE_SUCCESS, now), true, '19:47 是 11-21，早于 11-22 的 16:26');
  assert.equal(line({ latest: FAILED, legacyLastSyncAt: STALE_SUCCESS }).includes(legacyClock), false);
});

/**
 * 五态 × 是否有「更新的尝试」= 10 格矩阵。
 * 每一格都断言**逐字文案**：旧成功时刻在任何失败组合中都不能出现。
 */
test('H7 状态机矩阵：五态 × (有更新尝试 / 无更新尝试) 共 10 格', () => {
  const NEW_FAILED = { kind: 'failed', at: '16:26', reason: 'E_NEW' };
  const NEW_SYNCED = { kind: 'synced', at: '20:10', reason: '' };
  const base = {
    legacyLastSyncAt: STALE_SUCCESS,
    legacyLastSyncError: '',
    blockAt: '15:02'
  };
  const cells = [
    // 未配置：配置缺失永远压过任何尝试。
    ['未配置/无新尝试', unconfigured, false, null, '未配置：缺少访问令牌'],
    ['未配置/有新尝试', unconfigured, false, NEW_FAILED, '未配置：缺少访问令牌'],
    // 已配置 · 尚未同步：出现更新尝试就按最新事实走。
    ['尚未同步/无新尝试', configured, false, null, '已配置 · 尚未同步'],
    ['尚未同步/有新失败', configured, false, NEW_FAILED, '上次失败 · 16:26 · E_NEW'],
    // 已同步：有更新失败立刻翻成失败，旧成功时刻消失。
    ['已同步/无新尝试', configured, false, SYNCED, '已同步 · 19:47'],
    ['已同步/有新失败', configured, false, NEW_FAILED, '上次失败 · 16:26 · E_NEW'],
    // 上次失败：有更新成功则翻回成功。
    ['上次失败/无新尝试', configured, false, FAILED, FAILED_TEXT],
    ['上次失败/有新成功', configured, false, NEW_SYNCED, '已同步 · 20:10'],
    // 可见性阻断：阻断优先；阻断解除后由最新尝试决定。
    ['阻断/无新尝试', configured, true, null, '已配置（可见性阻断，禁止推送） · 最近尝试 15:02'],
    ['阻断/有更新成功（已解除）', configured, false, NEW_SYNCED, '已同步 · 20:10']
  ];
  for (const [name, config, blocked, latest, expected] of cells) {
    const text = line({ ...base, config, blocked, latest });
    assert.equal(text, expected, name);
    if (text.startsWith('上次失败')) {
      assert.equal(text.includes('19:47'), false, `${name} 不得带旧成功时刻`);
      assert.equal(text.includes('已同步'), false, `${name} 不得冒充成功`);
    }
  }
  assert.equal(cells.length, 10);
});

/** 递归收集可执行源码（跳过 .build / oh_modules / build 产物）。 */
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === '.build' || name === 'build' || name === 'oh_modules' || name === '.test') continue;
      sourceFiles(full, out);
    } else if (/\.(ets|ts)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

test('H8 源码形状：用户可见状态文案只有一个渲染器', () => {
  const files = sourceFiles(fileURLToPath(ETS));
  // 唯一允许拼「已同步 · <时刻>」的地方：持久化决策表 bootSurface（唯一拼串点）。
  // live 首页状态行由 syncStatusStore 用同名前缀常量渲染，是另一个既有面，不算设置面第二渲染器。
  const composers = files.filter((f) => {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    return /已同步 · \$\{/.test(src) || /已同步·\$\{/.test(src) || /\$\{TEXT_SYNCED_PREFIX\}\$\{/.test(src);
  });
  const rel = (f) => f.replace(/\\/g, '/').split('/entry/src/main/ets/')[1];
  assert.deepEqual(composers.map(rel).sort(), ['model/syncStatusPersist.ts'],
    '只有 syncStatusPersist 能拼成功文案；页面 / 其它模型一律委托');

  const page = readEts('pages/SettingsSync.ets');
  const root = readEts('pages/Settings.ets');
  const renderer = readEts('model/syncStatusLine.ts');
  for (const [name, src] of [['SettingsSync', page], ['Settings', root]]) {
    assert.equal(/clockOf\(\s*(this|settings)\.lastSyncAt\s*\)/.test(src), false,
      `${name} 不得再用 lastSyncAt 拼状态`);
    assert.equal(/已同步 · \$\{/.test(src), false, `${name} 不得自己渲染成功文案`);
    assert.match(src, /syncStatusLineOf\(|syncRowSummary\(/, `${name} 必须委托唯一渲染器`);
  }
  assert.match(page, /syncStatusStore\.latestAttempt\(\)/, '同步页事实来自权威最新尝试');
  assert.match(root, /syncStatusStore\.latestAttempt\(\)/, '根页事实来自权威最新尝试');
  // 旧 lastSyncAt 只能以「比较证据」身份进入唯一渲染器，绝不参与模板插值。
  assert.match(renderer, /legacyLastSyncAt/);
  assert.equal(/\$\{[^}]*legacyLastSyncAt/.test(renderer), false,
    '唯一渲染器也不得把 legacyLastSyncAt 插进文案');
  // 页面本地失败写入必须同时落权威 store，否则新失败不会驱动状态行。
  assert.match(page, /syncStatusStore\.setFailed\(reason\)/);
  assert.match(page, /syncStatusStore\.setSynced\(new Date\(\)\)/);
});
