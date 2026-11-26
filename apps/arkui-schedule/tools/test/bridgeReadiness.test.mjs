// mod-app-git-bridge-ready：桥就绪信号 / 有界超时 / 「读不到 ≠ 空」的纯模型测试 + 接线形状断言。
//
// 前置（纯模型测试靠 tsc 产物）：
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 真机缺陷（docs/VERIFICATION.md §15.22 追记 I，2026-11-26 19:18 冷启动）：
//   ① 设置页「同步仓库」永久停在「读取中…」，同进程 hilog 有 8 条
//      `C04500/…/webview: FindObject: Unknown object: objectId = 10737418`（代理未注册就被调用）；
//   ② 同一次启动「远程实例」显示「0 个实例」，实际存在 2 个（读失败被渲染成空）。
//   再冷启动一次两者都恢复 ⇒ 是竞态，不是永久损坏。
//
// 本文件钉住的契约：
//   A. 就绪只认页面回传的信号（令牌 + 页面加载时刻 + 页面身份），刷新后旧页面信号一律作废；
//   B. 有界等待：waiting 必须有出口（failed + typed 码 + 中文下一步），ready 不会被超时打回；
//   C. 行状态只有 loading / value / failed 三态，失败态一定带 typed 码 + 重试；
//   D. 「读不到」与「空」是两件事：读失败绝不产出「0 个实例」，空态只在读成功且 0 条时出现；
//   E. 接线形状：GitSyncService / gitRunner / git-bridge.js / Settings.ets / InstancesPane.ets。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { readEts, stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';
import { countRows, rowBindingRe } from './helpers/settingsRowBinding.mjs';

requireOverlayRestored('bridgeReadiness.test.mjs');

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
  E_BRIDGE_NOT_READY,
  E_BRIDGE_CALL_TIMEOUT,
  E_SETTINGS_READ_FAILED,
  E_INSTANCES_READ_FAILED,
  LOADING_TEXT,
  RETRY_HINT,
  EMPTY_INSTANCES_TEXT,
  secondsOf,
  bridgeNotReadyText,
  bridgeCallTimeoutText,
  readFailedText,
  readinessIdle,
  readinessArm,
  readinessAccept,
  readinessIsStale,
  readinessExpired,
  readinessFail,
  readinessReady,
  readinessText,
  rowLoading,
  rowValue,
  rowFailed,
  instancesReadOf,
  instancesRow,
  instancesCountLine,
  instancesMayShowEmpty
} = await import('../.build/model/bridgeReadiness.js');

// mod-app-settings-summary-resolve：重试序号 / 「重试也没读到」的文案 / 终态判定（纯模型）。
const {
  ROW_HINT_RETRY,
  ROW_HINT_OPEN,
  rowHintOf,
  nextAttemptOf,
  readNoOf,
  retryReasonOf,
  isTerminalRowText
} = await import('../.build/model/summaryResolve.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const BRIDGE_PATH = join(APP, 'entry', 'src', 'main', 'resources', 'rawfile', 'git', 'git-bridge.js');
const docker = (rel) => stripComments(readEts(join('main', 'ets', rel)));

const TOKEN = 'h1-1700000000000';
const SIGNAL = (token, pageId, pageAtMs) => ({ token, pageId, pageAtMs });

// ---------------------------------------------------------------------------
// A. 就绪状态机：信号（不是 onPageEnd、不是定时器）是唯一权威
// ---------------------------------------------------------------------------

test('R-01 初始态是 idle，且没有令牌（未武装的桥不允许开始任何调用）', () => {
  const idle = readinessIdle();
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.token, '');
  assert.equal(readinessReady(idle), false);
  assert.equal(readinessText(idle, 10000), '');
});

test('R-02 空令牌拒绝武装（空令牌区分不了新旧页面，宁可不武装）', () => {
  const idle = readinessIdle();
  assert.equal(readinessArm(idle, '', 1000, true), idle);
  assert.equal(readinessArm(idle, '   ', 1000, true), idle);
});

test('R-03 武装进入 waiting，并记录本次门槛（freshPage 时门槛=武装时刻）', () => {
  const armed = readinessArm(readinessIdle(), TOKEN, 1000, true);
  assert.equal(armed.phase, 'waiting');
  assert.equal(armed.token, TOKEN);
  assert.equal(armed.armedAtMs, 1000);
  assert.equal(armed.barrierMs, 1000);
  assert.equal(readinessReady(armed), false, 'waiting 不等于就绪');
});

test('R-04 不换页面的重复武装沿用旧门槛（同一页面的信号不会被自己判成旧的）', () => {
  const first = readinessArm(readinessIdle(), TOKEN, 1000, true);
  const second = readinessArm(first, 'h2-2000', 2000, false);
  assert.equal(second.barrierMs, 1000, '门槛必须沿用，否则当前页面永远发不出有效信号');
  assert.equal(second.armedAtMs, 2000);
});

test('R-05 令牌一致 + 页面在门槛之后加载 ⇒ 就绪', () => {
  const armed = readinessArm(readinessIdle(), TOKEN, 1000, true);
  const ready = readinessAccept(armed, SIGNAL(TOKEN, 'p2', 1500));
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.pageId, 'p2');
  assert.equal(readinessReady(ready), true);
  assert.equal(readinessText(ready, 10000), '');
});

test('R-06 令牌不一致 ⇒ 拒绝（刷新后的旧页面拿旧令牌，永远不认）', () => {
  const armed = readinessArm(readinessIdle(), TOKEN, 1000, true);
  const after = readinessAccept(armed, SIGNAL('h0-999', 'p1', 5000));
  assert.equal(after, armed);
  assert.equal(after.phase, 'waiting');
});

test('R-07 页面在门槛之前加载 ⇒ 拒绝（这正是刷新前旧页面抢发信号的竞态）', () => {
  const armed = readinessArm(readinessIdle(), TOKEN, 5000, true);
  const stale = readinessAccept(armed, SIGNAL(TOKEN, 'p1', 4000));
  assert.equal(stale, armed, '刷新前加载的页面不得把桥标成就绪');
  const fresh = readinessAccept(armed, SIGNAL(TOKEN, 'p2', 5001));
  assert.equal(fresh.phase, 'ready');
});

test('R-08 同一页面重复回传是幂等的（不产生第二次就绪事件）', () => {
  const armed = readinessArm(readinessIdle(), TOKEN, 1000, true);
  const ready = readinessAccept(armed, SIGNAL(TOKEN, 'p2', 1500));
  const again = readinessAccept(ready, SIGNAL(TOKEN, 'p2', 1500));
  assert.equal(again, ready);
  assert.equal(readinessReady(again), true);
});

test('R-09 刷新（重新武装 + freshPage）不可能残留 stale ready：就绪被打回 waiting', () => {
  const ready = readinessAccept(
    readinessArm(readinessIdle(), TOKEN, 1000, true), SIGNAL(TOKEN, 'p2', 1500));
  assert.equal(ready.phase, 'ready');
  const reloaded = readinessArm(ready, 'h2-9000', 9000, true);
  assert.equal(reloaded.phase, 'waiting', '重新加载后必须重新等信号');
  assert.equal(readinessReady(reloaded), false);
  assert.equal(readinessAccept(reloaded, SIGNAL(TOKEN, 'p2', 1500)), reloaded, '旧页面信号已作废');
  assert.equal(readinessAccept(reloaded, SIGNAL('h2-9000', 'p3', 9100)).phase, 'ready');
});

test('R-10 readinessIsStale：旧令牌 / 旧页面为真；空令牌交给宿主递令牌', () => {
  const armed = readinessArm(readinessIdle(), TOKEN, 1000, true);
  assert.equal(readinessIsStale(armed, SIGNAL('h0', 'p1', 2000)), true);
  assert.equal(readinessIsStale(armed, SIGNAL(TOKEN, 'p1', 500)), true);
  assert.equal(readinessIsStale(armed, SIGNAL(TOKEN, 'p2', 2000)), false);
  assert.equal(readinessIsStale(armed, SIGNAL('', 'p2', 2000)), false, '首次问候必须被放行去拿令牌');
});

test('R-11 预算内不判超时（waiting 原样返回）', () => {
  const armed = readinessArm(readinessIdle(), TOKEN, 1000, true);
  assert.equal(readinessExpired(armed, 9999, 10000), armed);
});

test('R-12 到达预算 ⇒ failed + E_BRIDGE_NOT_READY（有界等待的唯一出口）', () => {
  const armed = readinessArm(readinessIdle(), TOKEN, 1000, true);
  const failed = readinessExpired(armed, 11000, 10000);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.code, E_BRIDGE_NOT_READY);
  const text = readinessText(failed, 10000);
  assert.match(text, /^E_BRIDGE_NOT_READY：/);
  assert.match(text, /重试/, '必须带下一步（重试）');
  assert.match(text, /10 秒/);
});

test('R-13 已就绪不会被超时打回（ready 是终态，除非重新武装）', () => {
  const ready = readinessAccept(
    readinessArm(readinessIdle(), TOKEN, 1000, true), SIGNAL(TOKEN, 'p2', 1500));
  assert.equal(readinessExpired(ready, 999999, 10000), ready);
});

test('R-14 页面加载失败 / 注册抛错：直接 failed（不是超时，但同样可重试）', () => {
  const armed = readinessArm(readinessIdle(), TOKEN, 1000, true);
  const failed = readinessFail(armed, E_BRIDGE_NOT_READY);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.code, E_BRIDGE_NOT_READY);
  assert.equal(readinessFail(armed, '').code, E_BRIDGE_NOT_READY, '空码回落到 typed 码');
});

test('R-15 调用超时的文案与就绪超时不同（两个 typed 码各有各的下一步）', () => {
  const text = readinessText(
    { phase: 'failed', token: TOKEN, armedAtMs: 0, barrierMs: 0, pageId: '', code: E_BRIDGE_CALL_TIMEOUT },
    60000);
  assert.match(text, /^E_BRIDGE_CALL_TIMEOUT：/);
  assert.match(text, /60 秒/);
  assert.match(text, /重试/);
  assert.notEqual(text, readinessText(readinessExpired(readinessArm(readinessIdle(), TOKEN, 0, true), 10000, 10000),
    10000));
});

test('R-16 秒数文案：向上取整、非正数给 0（不出现 0.3 秒这种说法）', () => {
  assert.equal(secondsOf(10000), '10');
  assert.equal(secondsOf(1), '1');
  assert.equal(secondsOf(0), '0');
  assert.equal(secondsOf(-5), '0');
  assert.match(bridgeNotReadyText(2000), /2 秒/);
  assert.match(bridgeCallTimeoutText(60000), /60 秒/);
});

// ---------------------------------------------------------------------------
// B. 行状态：loading 只在真的在飞时出现，结束只有「值」或「失败」
// ---------------------------------------------------------------------------

test('V-01 loading 态文案就是「读取中…」，且不可点', () => {
  const loading = rowLoading();
  assert.equal(loading.phase, 'loading');
  assert.equal(loading.text, LOADING_TEXT);
  assert.equal(loading.canRetry, false);
  assert.equal(loading.code, '');
});

test('V-02 值态可带附注（内核未就绪这类，不覆盖主文案）', () => {
  assert.equal(rowValue('已同步 · 19:18', '').text, '已同步 · 19:18');
  const noted = rowValue('已同步 · 19:18', '同步内核未就绪');
  assert.equal(noted.text, '已同步 · 19:18 · 同步内核未就绪');
  assert.equal(noted.canRetry, false);
});

test('V-03 值态主文案为空时给确定占位（不渲染空行）', () => {
  assert.equal(rowValue('', '').text, '—');
});

test('V-04 失败态：原因 + typed 码 + 重试下一步，且可点', () => {
  const failed = rowFailed(E_SETTINGS_READ_FAILED, '读取超时（超过 4 秒）', '');
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.code, E_SETTINGS_READ_FAILED);
  assert.equal(failed.canRetry, true);
  assert.match(failed.text, /^读不到：读取超时（超过 4 秒）（E_SETTINGS_READ_FAILED）· 轻点本行重试$/);
  assert.ok(failed.text.includes(RETRY_HINT));
});

test('V-05 失败态原因缺省时给固定中文（绝不出现「读不到：」后面空着）', () => {
  const failed = rowFailed(E_SETTINGS_READ_FAILED, '   ', '');
  assert.match(failed.text, /读不到：这次没读到本机设置/);
  assert.ok(failed.text.length > '读不到：（E_SETTINGS_READ_FAILED）'.length);
  assert.equal(readFailedText().includes(RETRY_HINT), true);
});

test('V-06 三态穷举：phase 只可能是 loading / value / failed，canRetry 只在 failed', () => {
  const views = [rowLoading(), rowValue('x', ''), rowFailed('E_X', 'y', '')];
  assert.deepEqual(views.map((view) => view.phase), ['loading', 'value', 'failed']);
  assert.deepEqual(views.map((view) => view.canRetry), [false, false, true]);
  for (const view of views) {
    assert.equal(typeof view.text, 'string');
    assert.ok(view.text.length > 0, '任何态都必须有可上屏的文案');
  }
});

// ---------------------------------------------------------------------------
// C. 实例表：「读不到」与「空」是两件事
// ---------------------------------------------------------------------------

test('I-01 ok 码 ⇒ 读到；条数原样保留', () => {
  const read = instancesReadOf(2, 'ok', '');
  assert.equal(read.ok, true);
  assert.equal(read.count, 2);
});

test('I-02 E_ENVELOPE_EMPTY 是「确实还没有实例」，不是读失败', () => {
  const read = instancesReadOf(0, 'E_ENVELOPE_EMPTY', '还没有保存过实例');
  assert.equal(read.ok, true);
  assert.equal(read.count, 0);
});

test('I-03 坏信封 / 存储不可用 ⇒ 读不到（ok=false，问题码保留）', () => {
  for (const problem of ['E_ENVELOPE_JSON', 'E_ENVELOPE_VERSION', 'E_STORAGE_UNAVAILABLE']) {
    const read = instancesReadOf(0, problem, '信封坏了');
    assert.equal(read.ok, false, `${problem} 必须判成读不到`);
    assert.equal(read.problem, problem);
  }
});

test('I-04 负数 / 非数字条数按 0 处理（不给 UI 负实例数）', () => {
  assert.equal(instancesReadOf(-3, 'ok', '').count, 0);
  assert.equal(instancesReadOf(2.9, 'ok', '').count, 2);
});

test('I-05 读到 2 条 ⇒ 「2 个实例」，不可重试', () => {
  const row = instancesRow(instancesReadOf(2, 'ok', ''), '');
  assert.equal(row.phase, 'value');
  assert.equal(row.text, '2 个实例');
  assert.equal(row.canRetry, false);
});

test('I-06 读到 0 条 ⇒ 「0 个实例」（这是唯一允许出现 0 的路径）', () => {
  const row = instancesRow(instancesReadOf(0, 'ok', ''), '');
  assert.equal(row.text, EMPTY_INSTANCES_TEXT);
  assert.equal(row.phase, 'value');
});

test('I-07 读不到 ⇒ 说读不到 + 原因 + typed 码 + 重试，绝不是「0 个实例」', () => {
  const row = instancesRow(instancesReadOf(0, 'E_ENVELOPE_JSON', '实例表 JSON 损坏，已回落空表'), '');
  assert.equal(row.phase, 'failed');
  assert.equal(row.canRetry, true);
  assert.equal(row.code, E_INSTANCES_READ_FAILED);
  assert.equal(row.text.includes(EMPTY_INSTANCES_TEXT), false, '读不到绝不能渲染成 0 个实例');
  assert.match(row.text, /实例表 JSON 损坏/);
  assert.match(row.text, /E_INSTANCES_READ_FAILED/);
  assert.ok(row.text.includes(RETRY_HINT));
});

test('I-08 读不到且没有中文原因时给兜底句（不留空）', () => {
  const row = instancesRow(instancesReadOf(0, 'E_STORAGE_UNAVAILABLE', ''), '');
  assert.match(row.text, /本地实例表读不出来/);
});

test('I-09 计数行：读成功给「共 N 个实例」，读不到给「读不到实例表：…」', () => {
  assert.equal(instancesCountLine(instancesReadOf(3, 'ok', '')), '共 3 个实例');
  assert.equal(instancesCountLine(instancesReadOf(0, 'ok', '')), '共 0 个实例');
  const failed = instancesCountLine(instancesReadOf(0, 'E_ENVELOPE_ITEM', '实例表中有损坏的记录'));
  assert.notEqual(failed.includes('共 0 个实例'), true);
  assert.match(failed, /读不到实例表：实例表中有损坏的记录（E_INSTANCES_READ_FAILED）/);
});

test('I-10 空态只在读成功且确实 0 条时允许渲染（读失败不显示「还没有实例」）', () => {
  assert.equal(instancesMayShowEmpty(instancesReadOf(0, 'ok', '')), true);
  assert.equal(instancesMayShowEmpty(instancesReadOf(0, 'E_ENVELOPE_EMPTY', '')), true);
  assert.equal(instancesMayShowEmpty(instancesReadOf(2, 'ok', '')), false);
  assert.equal(instancesMayShowEmpty(instancesReadOf(0, 'E_ENVELOPE_JSON', '')), false);
});

test('I-11 不变量：「0 个实例」只在读成功且 0 条时出现（穷举问题码 × 条数）', () => {
  const problems = ['ok', 'E_ENVELOPE_EMPTY', 'E_ENVELOPE_JSON', 'E_ENVELOPE_SHAPE',
    'E_ENVELOPE_VERSION', 'E_ENVELOPE_ITEM', 'E_STORAGE_UNAVAILABLE'];
  for (const problem of problems) {
    for (const count of [0, 1, 2, 7]) {
      const read = instancesReadOf(count, problem, 'synthetic');
      const row = instancesRow(read, '');
      const claimsZero = row.text === EMPTY_INSTANCES_TEXT;
      assert.equal(claimsZero, read.ok && read.count === 0, `${problem}/${count} 违反「读不到≠空」`);
      const line = instancesCountLine(read);
      assert.equal(line.includes('共 0 个实例'), read.ok && read.count === 0, `${problem}/${count} 计数行撒谎`);
      assert.equal(instancesMayShowEmpty(read), read.ok && read.count === 0);
    }
  }
});

// ---------------------------------------------------------------------------
// D. 接线形状：纯模型之外只有薄适配
// ---------------------------------------------------------------------------

test('W-01 GitSyncService：代理方法表登记 onBridgeReady，且它就是就绪信号的唯一入口', () => {
  const service = docker('services/GitSyncService.ets');
  assert.match(service, /'onBridgeReady',/, 'registerJavaScriptProxy 的 methodList 必须登记 onBridgeReady');
  assert.match(service, /onBridgeReady\(json: string\): string \{/, '信号入口必须回传应答 JSON');
  assert.match(service, /readinessAccept\(this\.bridgeState, signal\)/, '接受判定走纯模型');
  assert.match(service, /readinessIsStale\(this\.bridgeState, signal\)/, '旧页面信号必须被识别');
});

test('W-02 GitSyncService.registerProxy：注册 + 刷新后**不再**直接置就绪（onPageEnd 不权威）', () => {
  const service = docker('services/GitSyncService.ets');
  const at = service.indexOf('registerProxy(): void {');
  assert.ok(at > 0, 'registerProxy 必须仍在');
  const body = service.slice(at, service.indexOf('\n  }', at));
  assert.match(body, /readinessArm\(this\.bridgeState, token, Date\.now\(\), freshPage\)/);
  assert.match(body, /this\.controller\.refresh\(\)/);
  assert.equal(body.includes('this.bridgeReady = true'), false,
    '注册代理只交出任一，不能把桥标成就绪');
  assert.match(body, /this\.wakePageHandshake\(\)/, '武装后必须唤醒页面握手');
});

test('W-03 GitSyncService：每次桥调用前都过就绪闸，且闸在提交 pending 之前', () => {
  const service = docker('services/GitSyncService.ets');
  for (const marker of ['private async callBridge(', 'private async callBridgeJson<T>(']) {
    const at = service.indexOf(marker);
    assert.ok(at > 0, `${marker} 必须存在`);
    const body = service.slice(at, at + 1400);
    const gate = body.indexOf('await this.ensureBridgeReady();');
    const submit = body.indexOf('this.pending.set(id, pending);');
    assert.ok(gate > 0, `${marker} 必须先过就绪闸`);
    assert.ok(submit > gate, `${marker} 的就绪闸必须早于真正下发`);
    assert.match(body, /E_BRIDGE_CALL_TIMEOUT/, '调用超时必须是 typed 码');
    assert.match(body, /bridgeCallTimeoutText\(REQUEST_TIMEOUT_MS\)/, '超时文案来自纯模型');
  }
});

test('W-04 gitRunner：等页面的就绪信号，而不是轮询 isBridgeReady', () => {
  const runner = docker('services/gitRunner.ets');
  const at = runner.indexOf('private async requireService(): Promise<GitSyncService> {');
  assert.ok(at > 0);
  const body = runner.slice(at, runner.indexOf('\n  }', at));
  assert.match(body, /await active\.awaitBridgeReady\(remaining\)/, '必须是等信号');
  assert.match(body, /runnerReadyDecision\(ready, waited, READY_TIMEOUT_MS\)/);
  assert.ok(body.indexOf('awaitBridgeReady') < body.indexOf('throw new Error(E_SYNC_UNAVAILABLE_MESSAGE)'),
    '先等信号，超时才 typed 失败');
  // 轮询只剩「连服务实例都还没有」这一条路径（等页面交出控制器），不是就绪判定。
  const poll = body.indexOf('setTimeout(resolve, READY_POLL_MS)');
  assert.ok(poll > body.indexOf('const active: GitSyncService | null = this.resolveService();'),
    '轮询只能出现在「取不到服务实例」的兜底分支');
  assert.equal(/isBridgeReady\(\)/.test(body), false, '就绪判定不得再回到 isBridgeReady 轮询');
});

test('W-05 git-bridge.js：页面侧握手 = 真的调一次代理才认就绪', () => {
  const source = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(source, /host\.onBridgeReady\(JSON\.stringify\(\{/);
  assert.match(source, /pageAtMs: pageLoadedAt/);
  assert.match(source, /announceReady: announceReady,/);
  assert.match(source, /return hostReady === true;/, 'isHostReady 必须是被证明过的（不是对象存在）');
  assert.match(source, /var canScheduleAnnounce = typeof global\.document === 'object'/,
    'Node（无 document）不得自启后台计时器');
  assert.match(source, /announceAttempts >= ANNOUNCE_MAX_ATTEMPTS/, '重试必须有界');
  assert.match(source, /parsed\.accept === true/, '接受与否只看宿主应答');
});

test('W-06 git-bridge.js：既有护栏与 E_BRIDGE 边界不动（只加握手）', () => {
  const source = readFileSync(BRIDGE_PATH, 'utf8');
  assert.match(source, /var E_BRIDGE = 'E_BRIDGE';/);
  assert.match(source, /bridgeErrorCode: E_BRIDGE,/);
  assert.match(source, /'宿主代理 dshGitHost 未注册：请在 Web 页面 onPageEnd 后调用 GitSyncService\.registerProxy\(\)'/,
    '未注册时的中文原因原样保留');
  assert.match(source, /function call\(requestJson\) \{/);
  assert.match(source, /emitResult\(id, toBridgeFailure\(error\)\)/, '异常仍以 typed 事件回传');
  assert.match(source, /noteHostLost\(\);/, '宿主失联要能自愈（打回未就绪并重握手）');
});

test('W-07 git-bridge.js 运行时：未注册 / 抛 FindObject 都只算「还没就绪」，不抛给调用方', () => {
  const source = readFileSync(BRIDGE_PATH, 'utf8');
  vm.runInThisContext(source, { filename: BRIDGE_PATH });
  const bridge = globalThis.DshGitBridge;
  assert.ok(bridge && typeof bridge.announceReady === 'function');
  const inner = bridge.internals;
  assert.equal(typeof inner.hostReadyOf, 'function');

  delete globalThis.dshGitHost;
  assert.doesNotThrow(() => bridge.announceReady());
  assert.equal(inner.hostReadyOf(), false);
  assert.equal(bridge.isHostReady(), false);

  // 模拟真机 FindObject：调用代理本身抛错 ⇒ 仍然只是「没就绪」
  globalThis.dshGitHost = {
    onBridgeReady() { throw new Error('FindObject: Unknown object: objectId = 10737418'); }
  };
  assert.doesNotThrow(() => bridge.announceReady());
  assert.equal(inner.hostReadyOf(), false, '抛错绝不能算就绪');
});

test('W-08 git-bridge.js 运行时：令牌往返（空 token → 宿主递令牌 → 采纳后重发 → 才就绪）', () => {
  const source = readFileSync(BRIDGE_PATH, 'utf8');
  const context = { seen: [], replies: [] };
  globalThis.dshGitHost = {
    onBridgeReady(json) {
      const signal = JSON.parse(json);
      context.seen.push(signal);
      // 第一次：页面还不知道令牌 → 宿主把当前令牌递回；第二次：令牌对上 → 接受
      const reply = context.seen.length === 1
        ? { accept: false, token: TOKEN }
        : { accept: signal.token === TOKEN, token: TOKEN };
      context.replies.push(reply);
      return JSON.stringify(reply);
    }
  };
  const bridge = globalThis.DshGitBridge;
  bridge.announceReady();
  assert.equal(bridge.internals.hostReadyOf(), false, '还没对上账，不许就绪');
  bridge.announceReady(); // 采纳令牌后的重发（Node 无 document，重试靠宿主唤醒）
  assert.equal(context.seen[0].token, '', '首次问候必须带空令牌去要令牌');
  assert.equal(context.seen[1].token, TOKEN, '第二轮必须采纳宿主递回的令牌');
  assert.equal(context.seen[0].pageAtMs, loopbackPageAt(bridge), '必须报页面加载时刻（不是回传时刻）');
  assert.equal(bridge.internals.hostReadyOf(), true, '真的调通了才算就绪');
  assert.equal(bridge.isHostReady(), true);
  delete globalThis.dshGitHost;
});

/** 页面加载时刻的单一来源（握手信号里的 pageAtMs 必须逐字来自它）。 */
function loopbackPageAt(bridge) {
  return bridge.internals.pageLoadedAtOf();
}

test('W-09 Settings.ets：四行仍是 4 次 MenuSummaryRow（真组件绑定），摘要仍来自权威来源（未被本次改动放宽）', () => {
  const page = docker('pages/Settings.ets');
  assert.equal(countRows(page), 4, '四行菜单不许变成别的形状');
  for (const [title, summary, route] of [
    ['同步仓库', 'repoSummary', 'ROUTE_SYNC'],
    ['远程实例', 'instanceSummary', 'ROUTE_INSTANCES'],
    ['数据导入导出', 'dataSummary', 'ROUTE_DATA'],
    ['API 配置', 'apiSummary', 'ROUTE_API']
  ]) {
    assert.match(page, rowBindingRe(title, summary, route));
  }
  assert.match(page, /syncRowSummary\(\s*settings\.lastSyncAt, settings\.lastSyncError, syncStatusStore\.latestAttempt\(\)\s*\)/);
  assert.match(page, /instanceStore\.list\(\)\.length/);
  assert.match(page, /router\.pushUrl\(\{ url: route \}\)/);
});

test('W-10 Settings.ets：读取有界 + 失败态 typed + 重试，实例行不再写死「0 个实例」', () => {
  const page = docker('pages/Settings.ets');
  assert.match(page, /@State repoSummary: string = '读取中…'/);
  assert.equal(page.includes("'0 个实例'"), false, '本次缺陷就是这句占位：读不到被渲染成 0');
  assert.match(page, /readSettingsWithinBudget\(context, ROW_READ_BUDGET_MS\)/, '读取必须有预算');
  assert.match(page, /setTimeout\(\(\): void => \{\s*finish\(\{ ok: false, settings: null,/, '超时必须收敛成失败态');
  assert.match(page, /rowLoading\(\)/, '重试先回「读取中…」');
  // mod-app-settings-summary-resolve（old→new，收紧）：失败原因先过 retryReasonOf（重试要换句子），
  // 再进 rowFailed —— 断言仍然钉住「typed 码 + 原因 + 附注」三件套，另加「重试文案」这一层。
  assert.match(page, /const reason: string = retryReasonOf\(this\.retryAttempt, read\.reason\)/);
  assert.match(page, /rowFailed\(E_SETTINGS_READ_FAILED, reason, note\)/);
  assert.match(page, /instancesRow\(read2, note\)/);
  assert.match(page, /private async retryRows\(\): Promise<void> \{/);
  // mod-app-settings-summary-resolve（old→new，等价）：点击出口仍只有 push(route) 一个，
  // 但重试分支改成早返回（`!isRetryable` → 直接 pushUrl；否则 → retryRows），
  // 于是「唯一出口 + 失败态重试」两件事都要钉住。
  assert.match(page, /if \(!this\.isRetryable\(route\)\) \{[\s\S]{0,80}router\.pushUrl\(\{ url: route \}\)/,
    '正常态必须直接 pushUrl（唯一出口仍是 push）');
  assert.match(page, /this\.retryRows\(\)\.catch\(/, '失败行的点击语义 = 重试本行');
  assert.match(page, /this\.engineNote\(\)/, '重试会重新判一次内核就绪');
});

test('W-11 InstancesPane.ets：计数行与空态都走纯模型（读失败不显示「共 0 个实例」/「还没有实例」）', () => {
  const pane = docker('pages/panes/InstancesPane.ets');
  assert.match(pane, /Text\(this\.countLine\(\)\)/);
  assert.match(pane, /private countLine\(\): string \{\s*return instancesCountLine\(this\.readOf\(\)\);/);
  assert.match(pane, /instancesReadOf\(this\.views\.length, this\.problem, problemText\(this\.problem\)\)/);
  assert.equal(pane.includes('共 ${this.views.length} 个实例'), false, '旧的无条件计数必须绝迹');
  assert.match(pane, /\} else if \(this\.mayShowEmpty\(\)\) \{\s*this\.EmptyView\(\)/,
    '空态必须由「读成功且 0 条」门控');
  assert.match(pane, /private mayShowEmpty\(\): boolean \{\s*return instancesMayShowEmpty\(this\.readOf\(\)\);/);
});

test('W-12 无 any / 无结构性赋值：新模型只导出具名接口，.ets 侧不出现 as any', () => {
  const model = readEts(join('main', 'ets', 'model', 'bridgeReadiness.ts'));
  assert.equal(/\bany\b/.test(stripComments(model)), false, '纯模型不得出现 any');
  for (const rel of ['services/GitSyncService.ets', 'services/gitRunner.ets',
    'pages/Settings.ets', 'pages/panes/InstancesPane.ets']) {
    assert.equal(/as any|as unknown/.test(docker(rel)), false, `${rel} 不得用 any / unknown 断言`);
  }
});

// ---------------------------------------------------------------------------
// W-13..W-17 mod-app-settings-summary-resolve：重试语义 + 终态不变量
// （真机症状：两行停在「读取中…」、typed 失败行一次都不出现。绑定修复在
//   settingsSummaryResolve.test.mjs 的 S-01；这里钉住「重试又超时」与「任何出口都离开在飞态」。）
// ---------------------------------------------------------------------------

test('W-13 尝试序号：首次 0，每点一次「重试」+1；非法值归一成 0（不产生负序号）', () => {
  assert.equal(nextAttemptOf(0), 1);
  assert.equal(nextAttemptOf(1), 2);
  assert.equal(nextAttemptOf(-5), 1, '负数归一成 0 再加一，不产生第 0 次这种说法');
  assert.equal(nextAttemptOf(Number.NaN), 1);
  assert.equal(readNoOf(0), 1, '序号 0 = 第 1 次读取');
  assert.equal(readNoOf(3), 4);
});

test('W-14 重试文案：首次原样、重试后一定换一句（空原因也给确定说法）', () => {
  assert.equal(retryReasonOf(0, '读取超时（超过 4 秒）'), '读取超时（超过 4 秒）', '首次不加前缀');
  const second = retryReasonOf(1, '读取超时（超过 4 秒）');
  assert.equal(second, '第 2 次仍没读到：读取超时（超过 4 秒）');
  assert.notEqual(second, retryReasonOf(0, '读取超时（超过 4 秒）'), '重试必须换句子');
  assert.equal(retryReasonOf(2, ''), '第 3 次仍没读到');
  assert.equal(retryReasonOf(0, ''), '', '首次的空原因保持空（由 rowFailed 给兜底句）');
});

test('W-15 「重试又超时」仍是 typed 失败行：码不变、句子变了、行仍可再点', () => {
  const first = rowFailed(E_SETTINGS_READ_FAILED, retryReasonOf(0, '读取超时（超过 4 秒）'), '');
  const again = rowFailed(E_SETTINGS_READ_FAILED, retryReasonOf(1, '读取超时（超过 4 秒）'), '');
  for (const view of [first, again]) {
    assert.equal(view.phase, 'failed');
    assert.equal(view.code, E_SETTINGS_READ_FAILED, 'typed 码不因重试而改变');
    assert.equal(view.canRetry, true, '仍然可以再点本行重试（不需要重启 App）');
    assert.ok(view.text.includes(E_SETTINGS_READ_FAILED));
    assert.ok(view.text.includes(RETRY_HINT), '失败行必须带「轻点本行重试」');
    assert.equal(isTerminalRowText(view.text), true, '失败行是终态');
  }
  assert.notEqual(again.text, first.text, '重试又超时不能是同一句（否则像是没反应）');
  assert.ok(again.text.includes('第 2 次'));
});

test('W-16 终态不变量：三态模型的每个出口都离开「读取中…」，只有 rowLoading() 在飞', () => {
  const exits = [
    rowValue('已同步 · 21:36', ''),
    rowValue('—', '同步内核未就绪（页面加载完会自行恢复）'),
    rowFailed(E_SETTINGS_READ_FAILED, '读取超时（超过 4 秒）', ''),
    instancesRow(instancesReadOf(2, 'ok', 'ok'), ''),
    instancesRow(instancesReadOf(0, 'E_ENVELOPE_EMPTY', '还没有实例'), ''),
    instancesRow(instancesReadOf(0, 'E_STORAGE_UNAVAILABLE', '本地实例表读不出来'), '')
  ];
  for (const view of exits) {
    assert.equal(isTerminalRowText(view.text), true, `出口文案必须是终态：${view.text}`);
  }
  assert.equal(isTerminalRowText(rowLoading().text), false, 'rowLoading() 是唯一的在飞态');
  assert.equal(isTerminalRowText('   '), false, '空串不算终态（会把行显示成空白）');
  assert.equal(rowLoading().text, LOADING_TEXT);
});

test('W-17 行尾提示：失败态「重试」/ 正常态「›」，两个常量各只有一处来源', () => {
  assert.equal(rowHintOf(true), ROW_HINT_RETRY);
  assert.equal(rowHintOf(false), ROW_HINT_OPEN);
  assert.equal(ROW_HINT_RETRY, '重试');
  assert.equal(ROW_HINT_OPEN, '›');
});
