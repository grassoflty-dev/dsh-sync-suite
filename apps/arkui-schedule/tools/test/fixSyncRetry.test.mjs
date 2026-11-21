// fix-sync-retry：真机复现路径的回归守卫（fake runner）+ 设置页唯一帮助/更多入口。
//
// 复现事实（2026-11-21，hdc + uitest dumpLayout）：
//   失败：E_SYNC_UNAVAILABLE: 同步内核或 GitRunner 未就绪
//   该短文案只存在于旧编译产物 gitRunner.ts 的 `service()` 首调即抛路径；现源码的 typed 文案带
//   「；下一步：...」。同时设备 HAP 内没有 bindAtStartup/requireService（versionCode 1000001）。
// 因此本文件钉住两件事：
//   1. 未绑定 → typed 失败（中文下一步、意图不动），绑定后同一 fake runner 能跑通重试与建记录路径；
//   2. SettingsSync/SyncSection 只有组头「更多」一个帮助/动作入口（承载查看状态/测试连接/重试）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('fixSyncRetry.test.mjs');

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
  E_SYNC_UNAVAILABLE_CODE, E_SYNC_UNAVAILABLE_MESSAGE, E_SYNC_UNAVAILABLE_NEXT_STEP
} = await import('../.build/model/syncCycle.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const ETS = join(APP, 'entry', 'src', 'main', 'ets');
function src(rel) {
  return stripComments(readFileSync(join(ETS, rel), 'utf8'));
}

const DAY = '2026-11-20';
const INTENT = {
  intentId: 'retry-after-unavailable', op: 'upsert', date: DAY, id: 'x1',
  ts: `${DAY}T09:00:00+08:00`, line: '{}', enqueuedAt: `${DAY}T09:00:00+08:00`,
  attempts: 1, state: 'failed', lastError: E_SYNC_UNAVAILABLE_MESSAGE
};

/** fake runner：模拟「桥未 ready → 有界等待 → ready/超时」，不依赖 @kit，纯判定可钉。 */
function fakeRunnerCycle(bound, readyAtTick, outbox) {
  if (!bound) {
    return { result: unavailableOutcome(outbox), trace: ['unbound'] };
  }
  const trace = [];
  let waited = 0;
  let tick = 0;
  for (;;) {
    const ready = readyAtTick >= 0 && tick >= readyAtTick;
    const decision = runnerReadyDecision(ready, waited, 100);
    trace.push(decision);
    if (decision === 'ready') {
      return { result: { ok: true, code: 'ok', message: '已同步', days: 1 }, trace };
    }
    if (decision === 'unavailable') {
      return { result: unavailableOutcome(outbox), trace };
    }
    waited += 50;
    tick += 1;
  }
}

test('R1 reproduced: unbound retry → typed E_SYNC_UNAVAILABLE with actionable next step (fake runner)', () => {
  const out = fakeRunnerCycle(false, -1, [INTENT]);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.code, E_SYNC_UNAVAILABLE_CODE);
  assert.equal(out.result.message, E_SYNC_UNAVAILABLE_MESSAGE);
  assert.match(out.result.message, /下一步/);
  assert.match(E_SYNC_UNAVAILABLE_NEXT_STEP, /重试同步/);
  assert.deepEqual(out.trace, ['unbound'], 'typed immediately only when genuinely unbound');
  assert.equal(out.result.resultOutbox.length, 1, 'parked intent is never dropped');
  assert.equal(out.result.resultOutbox[0].state, 'failed', 'failed intent stays until user retry');
  assert.equal(out.result.days.length, 0, 'zero write / zero commit');
});

test('R2 reproduced: bounded wait then ready → same cycle succeeds; only timeout fails', () => {
  const later = fakeRunnerCycle(true, 1, [INTENT]);
  assert.deepEqual(later.trace, ['wait', 'ready']);
  assert.equal(later.result.ok, true, 'bridge ready during wait → retry succeeds');

  const never = fakeRunnerCycle(true, -1, [INTENT]);
  assert.equal(never.trace[0], 'wait', 'first poll must WAIT, not throw');
  assert.equal(never.trace[never.trace.length - 1], 'unavailable', 'only timeout fails');
  assert.equal(never.result.code, E_SYNC_UNAVAILABLE_CODE);
  assert.equal(never.result.message, E_SYNC_UNAVAILABLE_MESSAGE);
});

test('R3 static: retry + post-create + pull-refresh all bind deterministically before a cycle', () => {
  const runner = src('services/gitRunner.ets');
  const writer = src('services/recordWriter.ets');
  const pane = src('pages/panes/SchedulePane.ets');
  const index = src('pages/Index.ets');
  const controller = src('services/syncController.ets');

  // 单点绑定 helper：所有用户路径共用，EntryAbility 的启动绑定仍保留。
  assert.match(runner, /export function bindBridgeRunner\(ability: common\.UIAbilityContext\): void \{/);
  assert.match(runner, /syncProtocolStore\.bindAtStartup\(bridgeGitRunner, ability\)/);
  assert.match(src('entryability/EntryAbility.ets'),
    /syncProtocolStore\.bindAtStartup\(bridgeGitRunner, this\.context\)/);

  // 建记录后的 fire-and-forget：不再赌「onCreate 先跑过 / bootstrap 已完成」。
  const trig = /private triggerSync\(\): void \{([\s\S]*?)\n  \}/.exec(writer);
  assert.ok(trig, 'triggerSync body not found');
  assert.match(trig[1], /bindBridgeRunner\(getContext\(\) as common\.UIAbilityContext\)/);
  assert.match(trig[1], /syncProtocolStore\.runConfiguredCycle\(\)/);

  // 真机路径：日程面板「重试同步」与「下拉刷新」；fallback 路由同样接线。
  for (const [name, body] of [
    ['SchedulePane.retrySync', /private async retrySync\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(pane)?.[1]],
    ['SchedulePane.onPullRefresh', /private async onPullRefresh\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(pane)?.[1]],
    ['Index.retrySync', /private async retrySync\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(index)?.[1]],
    ['Index.onPullRefresh', /private async onPullRefresh\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(index)?.[1]]
  ]) {
    assert.ok(body, `${name} body not found`);
    assert.match(body, /bindBridgeRunner\(getContext\((?:this)?\) as common\.UIAbilityContext\)/,
      `${name} must bind deterministically`);
  }

  // 确定性取桥：v2 runner 先认 App 级 syncController 实例，设置页自建服务不能抢走。
  assert.match(runner, /const canonical: GitSyncService \| null = syncController\.readyService\(\)/);
  assert.match(runner, /return canonical !== null \? canonical : GitSyncService\.active\(\)/);
  assert.match(controller, /readyService\(\): GitSyncService \| null \{/);
  // 真正的「不能绑定」仍返回 typed 结果，绝不静默成功、不返回 null。
  assert.match(src('services/syncProtocolStore.ets'), /outcomeToResult\(unavailableOutcome\(outbox\)\)/);
});

test('R4 static: Settings → 同步仓库 has exactly ONE help/更多 entry, carrying status/test/retry', () => {
  const section = src('components/settings/SyncSection.ets');
  const page = src('pages/SettingsSync.ets');

  // 组头「更多」是唯一入口；仓库地址行的 `?` 与旧 HelpSheet 已删除。
  assert.equal((section.match(/label: '更多'/g) || []).length, 1, 'exactly one 更多 entry');
  assert.equal((section.match(/label: '\?'/g) || []).length, 0, 'no duplicate ? help entry');
  assert.equal((page.match(/label: '\?'/g) || []).length, 0, 'page has no ? help entry');
  assert.equal((page.match(/HelpSheet\(\)/g) || []).length, 0, 'old duplicate help sheet is gone');
  assert.equal((page.match(/SyncMoreSheet\(\)/g) || []).length, 2, 'builder + single render');
  assert.match(section, /onOpenSyncMore: \(\) => void = \(\) => \{\};/);
  assert.doesNotMatch(section, /onOpenRepoHelp/);
  assert.doesNotMatch(page, /onOpenRepoHelp/);

  // 被保留的那一个入口确实承载三个失败出口（正向断言，不是只数次数）。
  const sheet = /SyncMoreSheet\(\) \{([\s\S]*?)\n  \}/.exec(page);
  assert.ok(sheet, 'SyncMoreSheet builder not found');
  for (const action of ['查看状态', '测试连接', '重试']) {
    assert.match(sheet[1], new RegExp(`Text\\('${action}'\\)`), `更多 sheet must carry ${action}`);
  }
  assert.match(sheet[1], /仓库地址可以先留空/, 'repo help folded into the single sheet');
});
