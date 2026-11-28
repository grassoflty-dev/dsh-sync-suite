// mod-app-git-commit-atomic：add→commit→push 串行闸的确定性并发回归。
//
// 背景（review of mod-app-chat-hide / 6b176d1）：BridgeGitRunner 把待提交路径缓冲在
// 单例 pendingPaths，hideChat 与 syncCycle 各自 addPaths(...) → await → commit(...) 两次
// 调用之间可以互相覆盖：隐藏行被并进 `[v2] sync N days`，或隐藏路径被同步提交吃掉，
// 而 hideChat 照样返回 ok:true。修复采用形状 B：runner 实例持有一把 GitCommitLock，
// 两个写口（hideChat 直接、syncCycle 经可选 GitPort.withWriteLock）把整段
// add→commit→push 放进同一把闸；runner 的缓冲仍只在 commit 里排空一次。
//
// 本文件是**确定性**并发测试：用 deferred 钩子在「addPaths 之后、commit 之前」强制开窗，
// 不用 sleep / 随机竞态。GCA-01 证明持闸写者不会被越过；GCA-02 是负控（去掉闸后同一
// 交错必然损坏缓冲，证明测试对该突变敏感）；GCA-03 用真实的编译后 runCyclePure 证明
// 同步周期确实走端口的写闸，并给出无闸负控；GCA-04 是接线守卫（任一写口摘掉
// withWriteLock / runGitWrite 即红灯）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('gitCommitAtomic.test.mjs');

// Compiled pure models use extension-less relative './model.js' specifiers (ArkTS style).
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

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const src = (rel) => readFileSync(new URL(rel, ETS), 'utf8').replace(/\r\n/g, '\n');

const { GitCommitLock } = await import('../.build/model/gitCommitLock.js');
const { runCyclePure } = await import('../.build/model/syncCycle.js');

const HIDE_PATH = 'chats/index.jsonl';
const DAY = '2026-11-28';
const TIMELINE_PATH = `timeline/${DAY}/records.json`;
const HIDE_MESSAGE = 'chats: delete sess-1';
const SYNC_MESSAGE = '[v2] sync 1 days';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Fixed number of microtask turns — deterministic scheduling, never wall-clock time. */
async function microtasks(count = 40) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

/** A faithful stand-in for BridgeGitRunner's singleton buffer + bridge call. */
function recordingBridge() {
  const events = [];
  const commits = [];
  let pending = [];
  return {
    events,
    commits,
    get pending() { return pending; },
    async addPaths(paths) {
      pending = paths.slice();
      events.push(`add:${paths[0]}`);
    },
    async commit(message) {
      commits.push({ message, paths: pending.slice() });
      pending = [];
      events.push(`commit:${message}`);
    },
    async pushMain() { events.push('push'); }
  };
}

// ---------------------------------------------------------------- GCA-01/02: forced interleaving

test('GCA-01 locked writers: sync cannot enter addPaths inside hide add→commit→push', async () => {
  const lock = new GitCommitLock();
  assert.equal(lock.active(), 0, '前置条件：闸必须空闲');
  const bridge = recordingBridge();
  const holdHide = deferred();
  const hideAtAdd = deferred();

  const hide = lock.run(async () => {
    bridge.events.push('hide-enter');
    await bridge.addPaths([HIDE_PATH]);
    bridge.events.push('hide-at-add');
    hideAtAdd.resolve();
    await holdHide.promise; // 强制窗口：此刻任何无闸写者都会覆盖 pendingPaths
    await bridge.commit(HIDE_MESSAGE);
    await bridge.pushMain();
    bridge.events.push('hide-done');
  });

  await hideAtAdd.promise;
  const sync = lock.run(async () => {
    bridge.events.push('sync-enter');
    await bridge.addPaths([TIMELINE_PATH]);
    await bridge.commit(SYNC_MESSAGE);
    await bridge.pushMain();
    bridge.events.push('sync-done');
  });

  await microtasks();
  assert.equal(
    bridge.events.includes(`add:${TIMELINE_PATH}`), false,
    '同步周期不得在隐藏写者持闸期间触碰共享缓冲');
  assert.equal(bridge.pending.length, 1, '隐藏路径仍独占缓冲');
  assert.equal(bridge.pending[0], HIDE_PATH);

  holdHide.resolve();
  await Promise.all([hide, sync]);
  assert.deepEqual(bridge.events, [
    'hide-enter', `add:${HIDE_PATH}`, 'hide-at-add',
    `commit:${HIDE_MESSAGE}`, 'push', 'hide-done',
    'sync-enter', `add:${TIMELINE_PATH}`, `commit:${SYNC_MESSAGE}`, 'push', 'sync-done'
  ]);
  assert.deepEqual(bridge.commits, [
    { message: HIDE_MESSAGE, paths: [HIDE_PATH] },
    { message: SYNC_MESSAGE, paths: [TIMELINE_PATH] }
  ], '两次提交各带各的缓冲路径：共享 pendingPaths 不被另一写口覆盖；闸只消除缓冲竞态，'
    + '落盘后被周期扫到的发现竞态由 mod-app-hide-commit-reconcile 在闸内对账处理');
  assert.equal(lock.active(), 0, '闸必须在成功路径释放');
});

test('GCA-02 negative control: the same interleaving corrupts the buffer with the lock removed', async () => {
  // This is the mutation GCA-01 catches: drop withWriteLock from either writer.
  const bridge = recordingBridge();
  const holdHide = deferred();
  const hideAtAdd = deferred();
  const syncAtAdd = deferred();
  const holdSync = deferred();

  const hide = (async () => {
    await bridge.addPaths([HIDE_PATH]);
    hideAtAdd.resolve();
    await holdHide.promise;
    await bridge.commit(HIDE_MESSAGE); // 此刻 pending 已被同步写口覆盖
    await bridge.pushMain();
  })();

  await hideAtAdd.promise;
  const sync = (async () => {
    await bridge.addPaths([TIMELINE_PATH]);
    syncAtAdd.resolve();
    await holdSync.promise;
    await bridge.commit(SYNC_MESSAGE);
    await bridge.pushMain();
  })();

  await syncAtAdd.promise;
  holdHide.resolve(); // 隐藏提交先落地，但提交的是同步写口缓冲的路径
  await hide;
  holdSync.resolve(); // 隐藏提交完成后才放同步提交（仍拿到空缓冲）
  await sync;

  assert.deepEqual(bridge.commits[0],
    { message: HIDE_MESSAGE, paths: [TIMELINE_PATH] },
    '无闸时时间线路径被提交在 `chats: delete <id>` 下（review 的点名坏结果）');
  assert.deepEqual(bridge.commits[1],
    { message: SYNC_MESSAGE, paths: [] },
    '隐藏行留在工作区未提交，两个写口却都走完了成功路径');
});

test('GCA-02b negative control: an exception releases the lock (no deadlock on throw)', async () => {
  const lock = new GitCommitLock();
  await assert.rejects(lock.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(lock.active(), 0, '异常路径也必须释放闸');
  // 后续任务仍能进入：尾巴被归一，没有卡在前一次的 rejection 上。
  assert.equal(await lock.run(async () => 42), 42);
  assert.equal(lock.active(), 0);
});

// ---------------------------------------------------------------- GCA-03: real compiled cycle

function makeGatePort(withLock) {
  const events = [];
  const commits = [];
  const pending = [];
  const lock = new GitCommitLock();
  const entered = deferred();
  const release = deferred();
  const secondEntered = deferred();
  let addCalls = 0;
  return {
    events,
    commits,
    pending,
    async fetchMain() {},
    async headSha() { return '0'.repeat(40); },
    async originMainSha() { return '0'.repeat(40); },
    async showMain(path) {
      return path === 'timeline/schema.json' ? JSON.stringify({ schemaVersion: 2 }) : '';
    },
    async branchName() { return 'main'; },
    async headRelation() { return 'equal'; },
    async fastForward() {},
    async addPaths(paths) {
      addCalls += 1;
      const call = addCalls;
      events.push(`add:${paths[0]}`);
      pending.length = 0;
      pending.push(...paths);
      if (call === 1) {
        entered.resolve();
        await release.promise;
      } else if (call === 2) {
        secondEntered.resolve();
      }
    },
    async commit(message) {
      events.push(`commit:${message}`);
      commits.push({ message, paths: pending.slice() });
      pending.length = 0;
    },
    async pushMain() { events.push('push'); },
    async resetHardOrigin() { events.push('reset'); },
    async listRemoteDays() { return []; },
    withWriteLock: withLock ? (task) => lock.run(task) : undefined,
    firstEntered: entered.promise,
    secondEntered: secondEntered.promise,
    releaseFirst: release.resolve,
    get addCalls() { return addCalls; }
  };
}

const readDay = async () => ({ records: '', deleted: '', restore: '' });
const dirtyPathsOf = async () => [TIMELINE_PATH];
const cycle = (port) => runCyclePure(
  port, [DAY], readDay, [], new Date('2026-11-28T12:00:00.000Z'),
  undefined, undefined, dirtyPathsOf);

async function interleavingProbe(withLock) {
  const port = makeGatePort(withLock);
  const first = cycle(port);
  await port.firstEntered; // 第一个周期已停在 addPaths 之后
  const second = cycle(port);
  const sentinel = (async () => { await microtasks(); return 'yielded'; })();
  const winner = await Promise.race([
    port.secondEntered.then(() => 'entered'),
    sentinel
  ]);
  port.releaseFirst();
  const results = await Promise.all([first, second]);
  return { port, winner, results };
}

test('GCA-03 compiled runCyclePure serializes its own add→commit→push via the port lock', async () => {
  const { port, winner, results } = await interleavingProbe(true);
  assert.equal(winner, 'yielded',
    '第二个周期不得在第一个周期的 add→commit→push 完成前进入临界区');
  assert.equal(results[0].ok, true, results[0].message);
  assert.equal(results[1].ok, true, results[1].message);
  assert.deepEqual(port.events, [
    `add:${TIMELINE_PATH}`, `commit:${SYNC_MESSAGE}`, 'push',
    `add:${TIMELINE_PATH}`, `commit:${SYNC_MESSAGE}`, 'push'
  ]);
  assert.deepEqual(port.commits.map((c) => c.paths), [[TIMELINE_PATH], [TIMELINE_PATH]]);
});

test('GCA-03b negative control: the same compiled model without the port lock interleaves', async () => {
  const { winner } = await interleavingProbe(false);
  assert.equal(winner, 'entered',
    '摘掉 GitPort.withWriteLock 后第二个周期会闯入第一个的 add→commit 窗口——GCA-03 正是抓这个突变');
});

// ---------------------------------------------------------------- GCA-04: wiring guards

test('GCA-04 both writers take the same lock; buffer drain, subject and trailers unchanged', () => {
  const lockSrc = src('model/gitCommitLock.ts');
  const chatSrc = src('services/chatStore.ets');
  const cycleSrc = src('model/syncCycle.ts');
  const runnerSrc = src('services/gitRunner.ets');

  assert.match(lockSrc, /export class GitCommitLock/);
  assert.match(lockSrc, /this\.tail = result\.then\(/, '失败尾巴必须归一，不能卡闸');
  assert.match(lockSrc, /finally[\s\S]{0,120}this\.activeTasks -= 1/, '抛错路径必须释放闸');

  assert.match(runnerSrc, /private readonly writeLock: GitCommitLock = new GitCommitLock\(\)/);
  assert.match(runnerSrc, /withWriteLock<T>\(task: \(\) => Promise<T>\): Promise<T>/);
  assert.match(runnerSrc, /return this\.writeLock\.run\(task\)/, 'runner 只有一把实例级闸');

  const hideBody = chatSrc.slice(chatSrc.indexOf('async hideChat('));
  const lockAt = hideBody.indexOf('bridgeGitRunner.withWriteLock(');
  const addAt = hideBody.indexOf('addPaths([HIDE_INDEX_PATH])', lockAt);
  const commitAt = hideBody.indexOf('commit(message)', addAt);
  const pushAt = hideBody.indexOf('pushMain()', commitAt);
  assert.ok(lockAt >= 0 && addAt > lockAt && commitAt > addAt && pushAt > commitAt,
    'hideChat 必须把 add→commit→push 全部包进同一把闸');
  // 只扫 withWriteLock 之后的尾巴：空 subject 早退也有 'commit'，
  // 不切片则「catch 里所有失败都归 push」的突变会假绿。
  const lockCatchBody = hideBody.slice(lockAt);
  assert.match(lockCatchBody, /this\.hideFailure\('commit'\)/,
    '闸内 catch 仍须保留 commit 失败分支');
  assert.match(lockCatchBody, /this\.hideFailure\('push'\)/,
    '闸内 catch 仍须保留 push 失败分支');
  assert.match(hideBody, /hideCommitMessageOf\(safeId\)/, 'subject 仍由纯模型给出');
  assert.equal(/dsh-dots-chat-(export|sync):/.test(chatSrc), false,
    '隐藏提交绝不能带会话发布尾注');

  assert.match(cycleSrc, /withWriteLock\?<T>\(task: \(\) => Promise<T>\): Promise<T>;/);
  assert.match(cycleSrc, /async function runGitWrite<T>\(port: GitPort, task: \(\) => Promise<T>\): Promise<T>/);
  assert.equal((cycleSrc.match(/runGitWrite\(port, async/g) || []).length, 2,
    'bootstrap 与普通周期两处写口都必须进闸');
  assert.match(cycleSrc, /`\$\{COMMIT_PREFIX\}\$\{touchedDays\} days`/, 'subject 不能漂移');

  // runner 的缓冲仍存在，但只在 commit 里排空一次；桥参数与白名单保持原样。
  assert.equal((runnerSrc.match(/this\.pendingPaths = \[\]/g) || []).length, 1,
    'pendingPaths 只能被 commit 排空一次');
  assert.match(runnerSrc, /v2Git\('addCommit', args\)/);
});
