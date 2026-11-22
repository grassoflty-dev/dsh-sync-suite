// mod-sync-silence-phase-b — 静默同步触发矩阵 / 阻塞恢复 / 防过度删除 / 措辞守卫。
//
// 四层证据：
//   ① **真 spy（Node 可跑）**：`model/homeGlobalRefresh.ts` 的 leader-only 日志 + 单飞周期，
//      五个触发名各一次、突发合并、5 分钟内为零、未配置为零；
//   ② **纯决策模型**：前台 5 分钟 / 网络同类型过滤 + 阻塞态强制实时复核（<60 s）；
//   ③ **源码形状**：ArkUI 不能进 Node，状态行 / 下拉 / 保存 / 字段 / 规则行 / 三按钮缺失
//      只能静态钉住（复用 syncUiSilence 的 helper 底座）；
//   ④ **凭据卫生**：credentialHygiene 的受限文件集里不得出现任何 [sync-trigger] 文本。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEts, stripComments, matchBrace, renderRegions } from './helpers/etsSource.mjs';
import { readSettingsSources } from './settingsSources.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('syncTriggerMatrix.test.mjs');

// tsc 产物的相对 import 不带 .js（与 homeGlobalRefresh.test.mjs 同款口径）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error !== null && typeof error === 'object' &&
          error.code === 'ERR_MODULE_NOT_FOUND' &&
          specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const { GlobalRefreshCoordinator } = await import('../.build/model/homeGlobalRefresh.js');
const {
  shouldRunForegroundTrigger,
  shouldArmNetworkDebounce,
  FOREGROUND_MIN_AGE_MS,
  NETWORK_DEBOUNCE_MS
} = await import('../.build/model/syncTriggerPolicy.js');
const {
  shouldRunRepoVisibilityCheck,
  applyRepoVisibilityDecision,
  initialRepoVisibilityGate,
  REPO_VISIBILITY_DEDUPE_MS
} = await import('../.build/model/repoVisibilityGate.js');
const { describeSyncStatus } = await import('../.build/model/syncError.js');

const SETTINGS_SYNC = stripComments(readEts('main/ets/pages/SettingsSync.ets'));
const SYNC_SECTION = stripComments(readEts('main/ets/components/settings/SyncSection.ets'));
const SCHEDULE_PANE = stripComments(readEts('main/ets/pages/panes/SchedulePane.ets'));
const HOME = stripComments(readEts('main/ets/pages/Home.ets'));
const COORDINATOR = stripComments(readEts('main/ets/model/homeGlobalRefresh.ts'));
const CHECKER = stripComments(readEts('main/ets/services/repoVisibilityChecker.ets'));
const STATUS_STORE = stripComments(readEts('main/ets/services/syncStatusStore.ets'));

const NAMES = ['cold-launch', 'save', 'pull', 'foreground', 'network'];

/** 与 CycleResult 同形的一次成功结果。 */
function okResult() {
  return { ok: true, code: 'ok', message: '已同步', days: 1, conflicts: 0, added: 0,
    dropped: [], pending: 0, failed: 0, attempts: 1 };
}

/** 未配置时的 typed 结果（编译真实 runConfiguredCycle 的行为：零 git IO、不算一个周期）。 */
function unconfiguredResult() {
  return { ok: false, code: 'E_REPO_UNCONFIGURED', message: '仓库地址与 token 未配置',
    days: 0, conflicts: 0, added: 0, dropped: [], pending: 0, failed: 0, attempts: 0 };
}

/** 装配一个真协调器 + spy：返回 coordinator / cycles / logs / runCycle。 */
function harness(nowMs = { value: 1_000_000 }, configured = true) {
  const cycles = { count: 0 };
  const logs = [];
  const coordinator = new GlobalRefreshCoordinator(
    () => nowMs.value,
    (line) => { logs.push(line); }
  );
  const runCycle = async () => {
    if (!configured) {
      return unconfiguredResult();
    }
    cycles.count++;
    return okResult();
  };
  return { coordinator, cycles, logs, runCycle, nowMs };
}

/** 取 `name(...) { … }` 方法体（保留换行，用于源码形状断言）。 */
function memberBody(source, name) {
  const found = new RegExp(`(?:private |public |async )*${name}\\s*\\([^)]*\\)\\s*(?::[^\\{]+)?\\{`).exec(source);
  assert.ok(found !== null, `找不到方法 ${name}`);
  const [start, end] = matchBrace(source, source.indexOf('{', found.index));
  return source.slice(start, end);
}

/** 控件文案：位置字面量 + 组件 prop（与 syncUiSilence 的 controlLabels 同口径）。 */
function controlLabels(code) {
  const labels = [];
  for (const m of code.matchAll(/(?:Text|Button)\(\s*(['"`])([^'"`]*?)\1\s*\)/g)) {
    labels.push(m[2]);
  }
  for (const m of code.matchAll(/\b(?:label|text|title)\s*:\s*(['"`])([^'"`]*?)\1/g)) {
    labels.push(m[2]);
  }
  return labels;
}

// ---------------------------------------------------------------- ① 触发矩阵

/** 从纯层源码里抽出 TRIGGER_LOG 的键集合（不依赖运行时的模块私有常量）。 */
function triggerTableKeys(source) {
  const at = source.indexOf('const TRIGGER_LOG');
  assert.ok(at >= 0, 'TRIGGER_LOG 表必须存在');
  const [start, end] = matchBrace(source, source.indexOf('{', at));
  const body = source.slice(start + 1, end - 1);
  return [...body.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]);
}

/** 闭集断言：多一个触发名（例如有人加第六个）也必须失败，而不只是「五个都在」。 */
function assertClosedTriggerSet(source) {
  assert.deepEqual([...triggerTableKeys(source)].sort(), [...NAMES].sort(),
    '触发名集合必须恰好是五个（不多不少）');
}

test('T1 触发名闭集 + 五个名字各恰好一个周期 / 一条自己的日志（leader-only）', async () => {
  assertClosedTriggerSet(COORDINATOR);
  for (const name of NAMES) {
    const h = harness();
    const outcome = await h.coordinator.runOnce({ runCycle: h.runCycle }, name);
    assert.equal(outcome.leader, true, `${name}: 必须是 leader`);
    assert.equal(outcome.cycleInvoked, true, `${name}: 必须发起周期`);
    assert.equal(h.cycles.count, 1, `${name}: spy 恰好一个周期`);
    assert.deepEqual(h.logs, [`[sync-trigger] ${name}`], `${name}: 恰好一条自己的日志`);
  }
});

test('T1b 正对照：往表里注入第六个触发名，闭集断言必须失败', () => {
  const mutated = COORDINATOR.replace(
    /('network':\s*'\[sync-trigger\] network')/,
    "$1,\n  'timer': '[sync-trigger] timer'"
  );
  assert.notEqual(mutated, COORDINATOR, '变异必须真的写入');
  assert.deepEqual(triggerTableKeys(mutated).includes('timer'), true, '变异后应能看到第六个名字');
  assert.throws(() => assertClosedTriggerSet(mutated), /触发名集合必须恰好是五个/,
    '闭集守卫必须能抓到新增的第六个触发名');
  // 负对照：未变异的真源码仍然通过。
  assertClosedTriggerSet(COORDINATOR);
});

test('T2 跟随者（在飞共享）不重复打日志 / 不重复跑周期', async () => {
  const h = harness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runCycle = async () => {
    await gate;
    h.cycles.count++;
    return okResult();
  };
  const first = h.coordinator.runOnce({ runCycle }, 'network');
  const second = h.coordinator.runOnce({ runCycle }, 'foreground');
  // 先放开闸再 await：否则两个 Promise 都挂在 gate 上，测试自己死锁。
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.leader, true);
  assert.equal(b.leader, false, '第二个触发是跟随者');
  assert.equal(h.cycles.count, 1, '在飞只跑一个周期');
  assert.deepEqual(h.logs, ['[sync-trigger] network'], '只有 leader 打一行');
});

test('T3 网络突发合并：同类型忽略 + 后一次不同 transport 覆盖，最终仍只一个周期', async () => {
  const h = harness();
  assert.equal(NETWORK_DEBOUNCE_MS, 2000, 'debounce 约 2 s');
  let pending = '';
  let lastTransport = '';
  const onNetEvent = (transport) => {
    const arm = shouldArmNetworkDebounce({
      configured: true,
      inFlight: false,
      transport,
      lastTransport
    });
    if (arm) {
      pending = transport; // 真实现里是 clearTimeout + 重新武装
    }
  };
  onNetEvent('wifi');
  onNetEvent('cellular');
  onNetEvent('cellular'); // 同类型：忽略
  onNetEvent('unknown');  // 非 transport：忽略
  assert.equal(pending, 'cellular', '突发合并后只剩最后一次 armed');
  // debounce 到期只递交一次：真实现的定时器只回调一次 ⇒ 一个周期、一行日志。
  await h.coordinator.runOnce({ runCycle: h.runCycle }, 'network');
  assert.equal(h.cycles.count, 1, '合并后的突发只跑一个周期');
  assert.deepEqual(h.logs, ['[sync-trigger] network']);

  // 突发决策本身：wifi → cellular 各武装一次，同类型的第三次被忽略。
  let arms = 0;
  let last = '';
  for (const t of ['wifi', 'cellular', 'cellular']) {
    if (shouldArmNetworkDebounce({ configured: true, inFlight: false, transport: t, lastTransport: last })) {
      arms++;
      last = t;
    }
  }
  assert.equal(arms, 2, '同类型事件被忽略');
});

test('T4 前台 5 分钟内零周期；过窗后恰好一个周期', async () => {
  const h = harness();
  assert.equal(FOREGROUND_MIN_AGE_MS, 5 * 60 * 1000, '5 分钟冷却');
  await h.coordinator.runOnce({ runCycle: h.runCycle }, 'cold-launch');
  assert.equal(h.cycles.count, 1);
  const coldAt = h.coordinator.lastAttemptAt();
  assert.ok(coldAt !== null, '协调器记录最近尝试时刻');

  const tooSoon = shouldRunForegroundTrigger({
    configured: true, inFlight: false,
    nowMs: coldAt + 60 * 1000, lastAttemptMs: coldAt
  });
  assert.equal(tooSoon, false, '冷启动 1 分钟后回前台 ⇒ 零周期');

  const due = shouldRunForegroundTrigger({
    configured: true, inFlight: false,
    nowMs: coldAt + FOREGROUND_MIN_AGE_MS + 1, lastAttemptMs: coldAt
  });
  assert.equal(due, true, '5 分钟后回前台 ⇒ 放行');
  if (due) {
    await h.coordinator.runOnce({ runCycle: h.runCycle }, 'foreground');
  }
  assert.equal(h.cycles.count, 2, '只多了一个前台周期');
  assert.deepEqual(h.logs, ['[sync-trigger] cold-launch', '[sync-trigger] foreground']);
});

test('T5 未配置 ⇒ 五个触发都零周期（真实 runConfiguredCycle 短路语义）', async () => {
  for (const name of NAMES) {
    const h = harness(undefined, false);
    await h.coordinator.runOnce({ runCycle: h.runCycle }, name);
    assert.equal(h.cycles.count, 0, `${name}: 未配置不得跑周期`);
  }
  const fg = shouldRunForegroundTrigger({
    configured: false, inFlight: false, nowMs: 1_000_000, lastAttemptMs: null
  });
  assert.equal(fg, false, '前台触发的配置闸');
  const net = shouldArmNetworkDebounce({
    configured: false, inFlight: false, transport: 'wifi', lastTransport: ''
  });
  assert.equal(net, false, '网络触发的配置闸');
});

// ---------------------------------------------------------------- ② 阻塞 → 私有恢复

test('T6 blocked → 仓库私有 → 下一周期 <60 s：decision.ok 且解挡；清挡不写成功', () => {
  assert.equal(REPO_VISIBILITY_DEDUPE_MS, 60_000);
  const start = 1_700_000_000_000;
  const blocked = { ok: false, code: 'E_REPO_PUBLIC', message: '仓库已公开' };
  const pass = { ok: true, code: 'OK', message: '' };
  let state = applyRepoVisibilityDecision(initialRepoVisibilityGate(), blocked, start);
  assert.equal(state.blocked, true);
  assert.equal(shouldRunRepoVisibilityCheck(state, start + 1000, false), true,
    '阻塞态在 60 s 窗口内也强制实时复核');
  state = applyRepoVisibilityDecision(state, pass, start + 1000);
  assert.equal(state.blocked, false, '只有通过的实时校验解挡');
  assert.equal(state.verdict, 'private');

  // 逆向：仍然公开 ⇒ 继续挡，且绝不伪造成功。
  let still = applyRepoVisibilityDecision(initialRepoVisibilityGate(), blocked, start);
  assert.equal(shouldRunRepoVisibilityCheck(still, start + 59_000, false), true);
  still = applyRepoVisibilityDecision(still, blocked, start + 59_000);
  assert.equal(still.blocked, true, '实时复核仍失败 ⇒ sticky 保持');
  assert.equal(still.blockedCode, 'E_REPO_PUBLIC');

  // ETS 接线：guardPush 在阻塞态强制实时；只有 decision.ok 才清挡。
  const guard = memberBody(CHECKER, 'guardPush');
  assert.match(guard, /this\.state\.blocked/, 'guardPush 点名阻塞态');
  assert.match(guard, /runCheck\(target, settings\.token, this\.state\.blocked\)/);
  const check = memberBody(CHECKER, 'runCheck');
  assert.match(check, /if \(decision\.ok\)/);
  assert.match(check, /syncStatusStore\.clearRepoBlock\(\)/);
  // 清挡不写同步成功：clearRepoBlock 方法体内没有 setSynced / KEY_LAST_AT。
  const clear = memberBody(STATUS_STORE, 'clearRepoBlock');
  assert.doesNotMatch(clear, /setSynced\(|KEY_LAST_AT|lastSyncAt/,
    '清挡不得写 setSynced / lastSyncAt');
});

// ---------------------------------------------------------------- ③ 防过度删除

test('T7 状态行 / 下拉手势 / 保存 / 字段 + 规则行保留；三个手动按钮 absent', () => {
  // 状态行渲染（只读，无 onClick）。
  assert.match(SYNC_SECTION, /Text\(this\.syncMessage\)/, '唯一状态行仍渲染');
  const rowAt = SYNC_SECTION.indexOf('Text(this.syncMessage)');
  const rowWindow = SYNC_SECTION.slice(rowAt, rowAt + 420);
  assert.doesNotMatch(rowWindow, /\.onClick\(/, '状态行不得可点');
  // 下拉手势仍走协调器（Phase A 的 pull 日志恰好一处）。
  assert.match(SCHEDULE_PANE, /Refresh\(\{\s*refreshing: \$\$this\.refreshing\s*\}/);
  assert.match(SCHEDULE_PANE, /this\.onPullRefresh\(\)/);
  const pull = memberBody(SCHEDULE_PANE, 'onPullRefresh');
  assert.equal((pull.match(/console\.info\('\[sync-trigger\] pull'\);/g) || []).length, 1);
  assert.equal((SCHEDULE_PANE.match(/console\.info\('\[sync-trigger\] pull'\);/g) || []).length, 1);
  // 保存 + 两个字段 + 隐私规则行。
  assert.match(SETTINGS_SYNC, /Button\('保存'\)/, '保存仍存在');
  assert.match(SYNC_SECTION, /Text\('仓库地址'\)/);
  assert.match(SYNC_SECTION, /this\.FieldLabel\('访问令牌（仅存本机）'\)/);
  assert.match(SYNC_SECTION, /this\.HintLine\(REPO_PRIVATE_RULE\)/, '隐私规则行保留');

  // 三个按钮：渲染树里按 label 扫描 + handler prop 扫同步调用，均在页面与 section 上断言。
  const forbidden = ['查看状态', '测试连接', '重试'];
  for (const source of [SETTINGS_SYNC, SYNC_SECTION]) {
    const regions = renderRegions(source);
    assert.ok(regions.length > 0);
    for (const [start, end] of regions) {
      const region = source.slice(start, end);
      for (const label of controlLabels(region)) {
        for (const word of forbidden) {
          assert.equal(label.includes(word), false, `渲染树里仍有「${label}」（含 ${word}）`);
        }
      }
      assert.doesNotMatch(region, /onClick\(\(\) => \{\s*this\.(runAction|testConnection|retryFromStatus)\(/);
    }
  }
  // 能力方法保留（零 UI 调用点）。
  assert.match(SETTINGS_SYNC, /private async testConnection\(\): Promise<void>/);
  assert.match(SETTINGS_SYNC, /private retryFromStatus\(\): void/);
  assert.match(SETTINGS_SYNC, /private async runAction\(action: string\): Promise<void>/);
  assert.doesNotMatch(SETTINGS_SYNC, /onRetryStatus:/);
});

// ---------------------------------------------------------------- ④ 措辞

test('T8 R2 措辞：本机未上传 + 上传状态成对出现，绝不暗示云端已拥有', () => {
  const base = {
    initialized: true, branch: 'main', head: 'a1b2c3d4e5f6',
    ahead: 0, behind: 0, diverged: false, conflicts: 0,
    changedCount: 3, remoteConfigured: true, lastCommitMessage: ''
  };
  const cases = [
    [undefined, '待上传'],
    ['pending', '待上传'],
    ['blocked', '已停止上传'],
    ['failed', '上传失败'],
    ['retrying', '重试中']
  ];
  for (const [state, label] of cases) {
    const line = describeSyncStatus({ ...base, uploadState: state });
    assert.match(line, /本地改动 3 处/, '既有改动数措辞保留（不删断言）');
    assert.match(line, new RegExp(`本机未上传·${label}`), `必须成对出现 ${label}`);
    assert.doesNotMatch(line, /已上传|云端已有|云端已同步/, '绝不宣称云端已经拥有');
  }
  // 诊断区仍是只读区：文案由纯模型给出，页面不自行拼。
  assert.match(SYNC_SECTION, /Text\(this\.statusLine\)/, '诊断区只读渲染保留');
});

// ---------------------------------------------------------------- ⑤ 凭据卫生

test('T9 credentialHygiene 受限文件里没有任何 [sync-trigger] 文本', () => {
  // 与 credentialHygiene.test.mjs 的 SECRET_TOUCHING_SOURCES 同集合
  //（合并的 SETTINGS_PAGE = readSettingsSources() 的十个文件逐列出来，逐文件扫更严格）。
  void readSettingsSources();
  const files = [
    'main/ets/pages/Settings.ets',
    'main/ets/pages/SettingsSync.ets',
    'main/ets/pages/SettingsExportImport.ets',
    'main/ets/pages/SettingsApi.ets',
    'main/ets/components/settings/SettingsHost.ets',
    'main/ets/components/settings/SettingsBits.ets',
    'main/ets/components/settings/SyncSection.ets',
    'main/ets/components/settings/AiSection.ets',
    'main/ets/components/settings/DataSection.ets',
    'main/ets/components/settings/AboutSection.ets',
    'main/ets/services/GitSyncService.ets',
    'main/ets/services/settingsStore.ets',
    'main/ets/services/scheduleStore.ets',
    'main/ets/services/deepseek.ets',
    'main/ets/model/types.ts'
  ];
  for (const rel of files) {
    const source = readFileSync(join(fileURLToPath(new URL('../../entry/src/', import.meta.url)), rel), 'utf8');
    assert.doesNotMatch(source, /\[sync-trigger\]/, `${rel} 属凭据卫生受限文件`);
  }
  // 日志本身无插值 / 无 token / URL；名字都是字面量。
  const logTable = COORDINATOR.slice(COORDINATOR.indexOf('const TRIGGER_LOG'), COORDINATOR.indexOf('/** 日志落点'));
  for (const name of NAMES) {
    assert.match(logTable, new RegExp(`'\\[sync-trigger\\] ${name}'`));
  }
  assert.doesNotMatch(logTable, /\$\{|token|secret|password|repoUrl|hilog/i);
  assert.match(HOME, /console\.info\(line\)/, 'ETS 侧安装 console.info 落点');
  assert.match(HOME, /runOnce\(undefined, 'foreground'\)/);
  assert.match(HOME, /runOnce\(undefined, 'network'\)/);
  assert.match(HOME, /runOnce\(undefined, 'pull'\)/);
  assert.match(HOME, /runOnce\(undefined, 'cold-launch'\)/);
});
