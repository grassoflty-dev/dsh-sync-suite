// fix-sync-init：E_SYNC_UNAVAILABLE 的确定性接线 + 有界等待 + 可执行中文下一步。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯判定 / typed 结果从 ../.build 导入；.ets 服务与页面因 @kit.* 只能做源码形状断言（本仓既有口径）。
//
// 覆盖：
// 1. 周期在 runner 未就绪时发起 → 先等待、超时才 typed 失败，意图不丢、文案带下一步（fake runner）；
// 2. typed 文案逐字可执行（中文原因 + 下一步 + 重试入口）；
// 3. 启动期确定性绑定 runner + filesDir（EntryAbility.onCreate），页面 bootstrap 仅幂等兜底；
// 4. BridgeGitRunner 等待内核而不是首调即抛；
// 5. 建记录后的自动同步与手动「同步/下拉刷新」走同一个周期函数（post-create = manual）；
// 6. E_SYNC_UNAVAILABLE 落到失败三态行；mod-sync-ui-silence PHASE A 后状态行只读、无手动重试控件。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('syncInit.test.mjs');

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

const {
  runnerReadyDecision, unavailableOutcome,
  E_SYNC_UNAVAILABLE_CODE, E_SYNC_UNAVAILABLE_REASON,
  E_SYNC_UNAVAILABLE_NEXT_STEP, E_SYNC_UNAVAILABLE_MESSAGE
} = await import('../.build/model/syncCycle.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const ETS = join(APP, 'entry', 'src', 'main', 'ets');
function src(rel) {
  return stripComments(readFileSync(join(ETS, rel), 'utf8'));
}

const DAY = '2026-11-19';
const TS = `${DAY}T09:30:00+08:00`;
const INTENT = {
  intentId: 'wait-ready', op: 'upsert', date: DAY, id: 'a1', ts: TS,
  line: '{}', enqueuedAt: TS, attempts: 0, state: 'pending', lastError: ''
};

/** fake runner：虚拟时钟每次轮询 +50ms，超时 100ms；readyAtTick<0 表示永不就绪。 */
function requestCycleWithFakeRunner(readyAtTick, outbox) {
  const trace = [];
  let waited = 0;
  let tick = 0;
  for (;;) {
    const ready = readyAtTick >= 0 && tick >= readyAtTick;
    const decision = runnerReadyDecision(ready, waited, 100);
    trace.push(decision);
    if (decision === 'unavailable') {
      return { result: unavailableOutcome(outbox), trace };
    }
    if (decision === 'ready') {
      return { result: { ok: true, code: 'ok', message: '已同步' }, trace };
    }
    waited += 50;
    tick += 1;
  }
}

test('1 cycle requested before runner ready → typed reason + retry, no silent failure (fake runner)', () => {
  const never = requestCycleWithFakeRunner(-1, [INTENT]);
  assert.equal(never.result.ok, false, 'never silently succeed');
  assert.equal(never.result.code, E_SYNC_UNAVAILABLE_CODE);
  assert.equal(never.result.message, E_SYNC_UNAVAILABLE_MESSAGE);
  assert.equal(never.trace[0], 'wait', 'first cycle must WAIT, not fail immediately');
  assert.ok(never.trace.indexOf('wait') >= 0);
  assert.equal(never.trace[never.trace.length - 1], 'unavailable', 'only timeout fails');
  assert.equal(never.result.resultOutbox.length, 1, 'intent kept for retry, never dropped');
  assert.equal(never.result.resultOutbox[0].state, 'pending');
  assert.equal(never.result.pending, 1);
  assert.equal(never.result.days.length, 0, 'zero write / zero commit');

  const later = requestCycleWithFakeRunner(1, [INTENT]);
  assert.deepEqual(later.trace, ['wait', 'ready']);
  assert.equal(later.result.ok, true, 'bridge ready during wait → same cycle proceeds');
});

test('2 typed E_SYNC_UNAVAILABLE copy carries Chinese reason + next step + retry cue', () => {
  assert.equal(E_SYNC_UNAVAILABLE_CODE, 'E_SYNC_UNAVAILABLE');
  assert.match(E_SYNC_UNAVAILABLE_REASON, /同步内核/);
  assert.match(E_SYNC_UNAVAILABLE_REASON, /GitRunner/);
  assert.match(E_SYNC_UNAVAILABLE_NEXT_STEP, /^下一步/);
  assert.match(E_SYNC_UNAVAILABLE_NEXT_STEP, /下拉刷新/);
  // mod-app-retry-removal (old → new): next step must not name the deleted control.
  assert.doesNotMatch(E_SYNC_UNAVAILABLE_NEXT_STEP, /重试同步/,
    '手动重试控件已删除，下一步文案不得再指向它');
  assert.equal(
    E_SYNC_UNAVAILABLE_MESSAGE,
    `${E_SYNC_UNAVAILABLE_CODE}: ${E_SYNC_UNAVAILABLE_REASON}；${E_SYNC_UNAVAILABLE_NEXT_STEP}`
  );
});

test('3 static: runner + filesDir bound at app start, before any page/cycle', () => {
  const ability = src('entryability/EntryAbility.ets');
  assert.match(ability, /import \{ syncProtocolStore \} from '\.\.\/services\/syncProtocolStore'/);
  assert.match(ability, /import \{ bridgeGitRunner \} from '\.\.\/services\/gitRunner'/);
  const onCreate = /onCreate\(want: Want, launchParam: AbilityConstant\.LaunchParam\): void \{([\s\S]*?)\n  \}/.exec(ability);
  assert.ok(onCreate, 'onCreate body not found');
  assert.match(onCreate[1], /syncProtocolStore\.bindAtStartup\(bridgeGitRunner, this\.context\)/);
  const store = src('services/syncProtocolStore.ets');
  const bind = /bindAtStartup\(port: GitPort, ability: common\.UIAbilityContext\): void \{([\s\S]*?)\n  \}/.exec(store);
  assert.ok(bind, 'bindAtStartup body not found');
  assert.match(bind[1], /this\.runner = port/);
  assert.match(bind[1], /this\.filesDir = ability\.filesDir/);
  assert.match(bind[1], /this\.ready = true/);
  // 页面 bootstrap 仍保留幂等绑定（fallback 路由 / 重建场景），不是被删掉的弱断言。
  assert.match(src('pages/panes/SchedulePane.ets'), /syncProtocolStore\.setRunner\(bridgeGitRunner\)/);
  assert.match(src('pages/Index.ets'), /syncProtocolStore\.setRunner\(bridgeGitRunner\)/);
});

test('4 static: BridgeGitRunner waits for the kernel instead of throwing on first call', () => {
  const runner = src('services/gitRunner.ets');
  const require = /private async requireService\(\): Promise<GitSyncService> \{([\s\S]*?)\n  \}/.exec(runner);
  assert.ok(require, 'requireService body not found');
  assert.match(require[1], /runnerReadyDecision\(ready, waited, READY_TIMEOUT_MS\)/);
  assert.match(require[1], /throw new Error\(E_SYNC_UNAVAILABLE_MESSAGE\)/);
  assert.match(require[1], /setTimeout\(resolve, READY_POLL_MS\)/);
  assert.ok(require[1].indexOf('runnerReadyDecision') < require[1].indexOf('throw new Error'),
    'wait decision must come BEFORE the typed throw');
  assert.doesNotMatch(runner, /const UNAVAILABLE: string/, 'old dead-end message must be gone');
});

test('5 static: post-create triggers the same cycle function as the manual 同步 path', () => {
  const writer = src('services/recordWriter.ets');
  const trig = /private triggerSync\(\): void \{([\s\S]*?)\n  \}/.exec(writer);
  assert.ok(trig, 'triggerSync body not found');
  assert.match(trig[1], /syncStatusStore\.setSyncing\(\)/);
  assert.match(trig[1], /syncProtocolStore\.runConfiguredCycle\(\)/);
  assert.match(trig[1], /syncStatusStore\.fromCycle\(result/);
  assert.doesNotMatch(trig[1], /runCyclePure\(/, 'no second cycle implementation');

  const pane = src('pages/panes/SchedulePane.ets');
  const pull = /private async onPullRefresh\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(pane);
  assert.ok(pull, 'onPullRefresh body not found');
  assert.match(pull[1], /await syncProtocolStore\.runConfiguredCycle\(\)/);
  assert.match(pull[1], /syncStatusStore\.fromCycle\(result/);
  assert.doesNotMatch(pull[1], /syncController\.pullNow/);

  const store = src('services/syncProtocolStore.ets');
  const configured = /async runConfiguredCycle\(ctx\?: SyncCycleContext\): Promise<CycleResult \| null> \{([\s\S]*?)\n  \}/.exec(store);
  assert.ok(configured, 'runConfiguredCycle body not found');
  assert.match(configured[1], /return await this\.runCycle\(ctx\)/);
  assert.match(configured[1], /return await this\.runWiredCycle\(\)/);
  assert.match(store, /if \(this\.runner !== null\) \{\s*return await this\.runWiredCycle\(\);/);
  assert.doesNotMatch(store, /return null;/, 'no silent null path (old stuck-at-同步中)');

  const retry = /private async retrySync\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(pane);
  assert.ok(retry, 'retrySync body not found');
  assert.match(retry[1], /syncProtocolStore\.runConfiguredCycle\(ctx\)/, 'retry converges on the same cycle');
});

test('6 static: E_SYNC_UNAVAILABLE lands in read-only failed three-state row (no retry control)', () => {
  const pane = src('pages/panes/SchedulePane.ets');
  const row = /SyncStatusRow\(\) \{([\s\S]*?)\n  \}/.exec(pane);
  assert.ok(row, 'SyncStatusRow builder not found');
  assert.match(row[1], /this\.syncStatus\.text/, '状态行仍显示 typed 失败文案');
  assert.match(row[1], /this\.syncStatus\.state === 'failed'/);
  // mod-sync-ui-silence PHASE A：用户不需要手动同步。状态行只读，retrySync 只留能力、不留控件。
  assert.doesNotMatch(row[1], /重试同步|立即同步|查看状态|测试连接/);
  assert.doesNotMatch(row[1], /\.onClick\s*\(/, '状态行不挂任何点击 handler');
  assert.doesNotMatch(pane, /this\.retrySync\(\)/, 'retrySync 能力保留但无 UI 调用点');
  const status = src('services/syncStatusStore.ets');
  const fromCycle = /fromCycle\(outcome: CycleResult, now: Date\): SyncStatusView \{([\s\S]*?)\n  \}/.exec(status);
  assert.ok(fromCycle, 'fromCycle body not found');
  assert.match(fromCycle[1], /!outcome\.ok/);
  assert.match(fromCycle[1], /this\.setFailed\(reason/);
  const writer = src('services/recordWriter.ets');
  assert.match(writer, /syncStatusStore\.setPending\(0, this\.errorText\(error\)\)/);
});
