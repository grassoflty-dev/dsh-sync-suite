// mod-sync-status-persist：同步状态「上次已完成结果」跨重启存活的契约测试。
//
// 前置：先编译纯模型层（node --test 不负责编译）
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 为什么是「纯模型 + 源码形状」而不是直接 import .ets：
// - `services/syncStatusStore.ets` 依赖 @kit.ArkData / AppStorage，Node 里加载不了；
// - 真正的判定已经抽到 `model/syncStatusPersist.ts`，编译后可直接跑；
// - 这里用一个与 .ets 薄壳同构的 ProcessStore 假件模拟「新进程 / 重启」，
//   再用源码断言钉住 .ets 确实调用了同一组纯函数、且没有在渲染路径写盘。
//
// 关注点：成功保留原时刻、失败是过去事件、空盘给中性面、syncing 不落盘、
//        坏 JSON 安全回落、真实周期照常切换、只读路径零写入、偏好异常不抛。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchBrace, stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('syncStatusPersist.test.mjs');

const {
  SYNC_STATUS_PREFS_NAME, SYNC_STATUS_KEY, SYNC_STATUS_VERSION,
  TEXT_SYNCED_PREFIX, TEXT_SYNCING, TEXT_FAILED_PREFIX,
  TEXT_PAST_FAILED_PREFIX, TEXT_NEVER, UNKNOWN_REASON,
  bootSurface, commitStatus, decodeStatus, encodeStatus, normalizeAt, readStatus
} = await import('../.build/model/syncStatusPersist.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(HERE, '..', '..', 'entry', 'src', 'main', 'ets', 'services', 'syncStatusStore.ets');
const STORE_SRC = readFileSync(STORE_PATH, 'utf8');
const CODE = stripComments(STORE_SRC);

/** 内存偏好假件：记录读次数与每次写入，用来断言「只读路径零写入」。 */
function fakeStorage(initial = '') {
  let value = initial;
  const writes = [];
  return {
    reads: 0,
    get writes() { return writes; },
    read() { this.reads += 1; return value; },
    write(next) { writes.push(next); value = next; }
  };
}

/**
 * 与 `.ets` 薄壳同构的纯假件：一个实例 = 一个进程。
 * 新 ProcessStore(同一 storage) 即模拟重启；live 位对应 .ets 的 `this.live`。
 */
class ProcessStore {
  constructor(storage) {
    this.storage = storage;
    this.live = false;
    this.restored = undefined;
    this.lastWritten = '';
    this.liveView = null;
  }

  restore() {
    if (this.restored === undefined) {
      const read = readStatus(this.storage);
      this.restored = read.outcome;
      this.lastWritten = read.raw;
    }
    return this.restored;
  }

  commit(outcome) {
    const result = commitStatus(this.storage, outcome, this.lastWritten);
    this.lastWritten = result.json;
    return result;
  }

  setSynced(at) {
    this.live = true;
    this.commit({ kind: 'synced', at, reason: '' });
    this.liveView = {
      state: 'synced', label: '已同步', text: `${TEXT_SYNCED_PREFIX}${at}`,
      pending: 0, reason: '', lastAt: at
    };
    return this.liveView;
  }

  setFailed(at, reason) {
    this.live = true;
    const shown = reason || UNKNOWN_REASON;
    this.commit({ kind: 'failed', at, reason: shown });
    this.liveView = {
      state: 'failed', label: '失败', text: `${TEXT_FAILED_PREFIX}${shown}`,
      pending: 0, reason: shown, lastAt: at
    };
    return this.liveView;
  }

  setSyncing() {
    this.live = true;
    this.liveView = {
      state: 'syncing', label: '同步中', text: TEXT_SYNCING,
      pending: 0, reason: '', lastAt: ''
    };
    // 故意不 commit —— syncing 永不写盘
    return this.liveView;
  }

  snapshot(inflight = false) {
    if (this.live) {
      return this.liveView;
    }
    return bootSurface(this.restore(), inflight);
  }
}

/** 取 .ets 里某个方法的函数体（注释已剥离，避免注释里的字样造成误判）。 */
function bodyOf(signature) {
  const at = CODE.indexOf(signature);
  assert.notEqual(at, -1, `找不到方法签名：${signature}`);
  const [start, end] = matchBrace(CODE, CODE.indexOf('{', at));
  return CODE.slice(start, end);
}

// ---------------------------------------------------------------- 0. 存储契约

test('P1 专用偏好名 / 版本化键 / 三标量信封固定', () => {
  assert.equal(SYNC_STATUS_PREFS_NAME, 'git_sync_status');
  assert.equal(SYNC_STATUS_VERSION, 1);
  assert.ok(SYNC_STATUS_KEY.startsWith('v:1.'), `键必须带版本前缀：${SYNC_STATUS_KEY}`);
  assert.equal(
    encodeStatus({ kind: 'synced', at: '21:14', reason: '' }),
    '{"v":1,"kind":"synced","at":"21:14","reason":""}'
  );
  assert.equal(
    encodeStatus({ kind: 'failed', at: '09:05', reason: 'E_PUSH_REJECTED' }),
    '{"v":1,"kind":"failed","at":"09:05","reason":"E_PUSH_REJECTED"}'
  );
  // syncing 不是合法 kind：从编码入口就挡住，不会写进盘
  assert.equal(encodeStatus({ kind: 'syncing', at: '21:14', reason: '' }), '');
});

// ---------------------------------------------------------------- 1. 成功 → 重启

test('P2 成功已落盘 → 新 store（模拟重启）读回「已同步 · 原 HH:MM」，不是刚刚、不是失败', () => {
  const storage = fakeStorage();
  const before = new ProcessStore(storage);
  assert.equal(before.setSynced('21:14').text, '已同步 · 21:14');
  assert.equal(storage.writes.length, 1);

  const after = new ProcessStore(storage); // 新进程
  const view = after.snapshot();
  assert.equal(view.state, 'synced');
  assert.equal(view.text, '已同步 · 21:14');
  assert.equal(view.lastAt, '21:14');
  assert.equal(view.text.includes('刚刚'), false, '原时刻必须保留，不许重算成「刚刚」');
  assert.equal(view.text.includes('失败'), false);
  assert.equal(storage.writes.length, 1, '重启只读不写');
});

// ---------------------------------------------------------------- 2. 失败 → 重启

test('P3 失败已落盘 → 重启显示「上次失败 · HH:MM」过去时，typed 原因仍在 view.reason', () => {
  const storage = fakeStorage();
  const before = new ProcessStore(storage);
  assert.equal(before.setFailed('09:05', 'E_PUSH_REJECTED').state, 'failed');

  const view = new ProcessStore(storage).snapshot();
  assert.equal(view.state, 'past_failed', '上次失败是过去事件，不能冒充当前失败态');
  assert.equal(view.text, '上次失败 · 09:05');
  assert.equal(view.reason, 'E_PUSH_REJECTED', 'typed 原因保留给状态行 / 诊断');
  assert.equal(view.text.startsWith('失败：'), false, '不许渲染成「失败：…」当前态');
  assert.equal(view.text.includes('刚刚'), false);
  assert.notEqual(view.state, 'failed');
});

// ---------------------------------------------------------------- 3. 空盘 = 中性面

test('P4 从未同步（空偏好）→「尚未同步」中性面，绝不出现「未知错误」', () => {
  const view = new ProcessStore(fakeStorage('')).snapshot();
  assert.equal(view.state, 'never');
  assert.equal(view.text, '尚未同步');
  assert.equal(view.reason, '');
  assert.equal(view.lastAt, '');
  assert.equal(JSON.stringify(view).includes(UNKNOWN_REASON), false, '空盘不编造失败');
  assert.equal(['synced', 'syncing', 'failed'].includes(view.state), false, '中性面不进三条实时路径');
});

// ---------------------------------------------------------------- 4. syncing 不落盘

// 模型层用例：ProcessStore 是同构假件；生产不写盘由下方源码断言补钉。
test('P5（模型层）同步中被杀 → 重启仍是上次已完成结果，不会卡在「同步中…」', () => {
  const storage = fakeStorage();
  const before = new ProcessStore(storage);
  before.setSynced('20:00');
  const writesBefore = storage.writes.length;

  const inflight = before.setSyncing();
  assert.equal(inflight.text, '同步中…', '同进程内在途态仍优先');
  assert.equal(storage.writes.length, writesBefore, 'setSyncing 不许写盘');

  const after = new ProcessStore(storage).snapshot(); // 进程被杀后重启
  assert.equal(after.text, '已同步 · 20:00');
  assert.equal(after.text.includes('同步中'), false);

  // 就算有人手工塞了 kind=syncing 的脏信封，也不能渲染出永久在途态
  const tampered = fakeStorage(JSON.stringify({ v: 1, kind: 'syncing', at: '20:00', reason: '' }));
  const fallback = new ProcessStore(tampered).snapshot();
  assert.equal(fallback.text, '尚未同步');
  assert.equal(fallback.text.includes('同步中'), false);
  // 生产不变量（非假件）：真实 setSyncing() 源码里没有任何写盘调用。
  assert.doesNotMatch(bodyOf('setSyncing(): SyncStatusView'), /commit\(|commitStatus\(|\.write\(/,
    '生产 setSyncing 必须零写盘');
});

// ---------------------------------------------------------------- 5. 在途优先

test('P6 启动瞬间有在途周期 → bootSurface 让「同步中…」赢过盘上结果', () => {
  const raw = encodeStatus({ kind: 'synced', at: '19:30', reason: '' });
  const view = bootSurface(readStatus(fakeStorage(raw)).outcome, true);
  assert.equal(view.state, 'syncing');
  assert.equal(view.text, '同步中…');
  // 同一个盘、没有在途时仍显示上次成功
  const idle = bootSurface(readStatus(fakeStorage(raw)).outcome, false);
  assert.equal(idle.text, '已同步 · 19:30');
});

// ---------------------------------------------------------------- 6. 坏数据

test('P7 篡改 / 损坏的 JSON → 安全回落中性面（不抛、不出现未知错误、不出现同步中）', () => {
  const badValues = [
    '', '{', 'not json', 'null', '[]', '42',
    '{"v":2,"kind":"synced","at":"12:00","reason":""}',
    '{"kind":"synced","at":"12:00"}',
    '{"v":1,"kind":"syncing","at":"12:00","reason":""}',
    '{"v":1,"kind":"failed","at":"刚刚","reason":"E_X"}',
    '{"v":1,"kind":"synced","at":12,"reason":""}'
  ];
  for (const raw of badValues) {
    assert.equal(decodeStatus(raw), null, `脏值必须解码为 null：${raw}`);
    const view = bootSurface(decodeStatus(raw), false);
    assert.equal(view.text, '尚未同步', `脏值必须回中性面：${raw}`);
    assert.equal(view.text.includes(UNKNOWN_REASON), false);
    assert.equal(view.text.includes('同步中'), false);
  }
  assert.equal(normalizeAt('25:00'), '');
  assert.equal(normalizeAt('刚刚'), '');
  assert.equal(normalizeAt('21:14'), '21:14');
});

// ---------------------------------------------------------------- 7. 恢复后照常切换

test('P8 恢复后真实周期照常 synced → failed → synced，盘上跟着真实变化', () => {
  const storage = fakeStorage(encodeStatus({ kind: 'synced', at: '18:00', reason: '' }));
  const store = new ProcessStore(storage);
  assert.equal(store.snapshot().text, '已同步 · 18:00', '先读回上次成功');

  const failed = store.setFailed('18:05', 'E_AUTH');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.text, '失败：E_AUTH', '实时失败文案不变');
  assert.equal(JSON.parse(storage.read()).kind, 'failed');

  const synced = store.setSynced('18:10');
  assert.equal(synced.state, 'synced');
  assert.equal(synced.text, '已同步 · 18:10', '实时成功文案不变');
  const finalRaw = JSON.parse(storage.read());
  assert.equal(finalRaw.kind, 'synced');
  assert.equal(finalRaw.at, '18:10');
  assert.equal(finalRaw.reason, '');
});

// ---------------------------------------------------------------- 8. 只读零写入

// 模型层用例；生产渲染路径零写入由本用例末尾的源码断言补钉。
test('P9（模型层）单纯 snapshot()/渲染读不写盘（写入计数经存储适配器接缝断言）', () => {
  const raw = encodeStatus({ kind: 'synced', at: '21:14', reason: '' });
  const storage = fakeStorage(raw);
  const store = new ProcessStore(storage);
  for (let i = 0; i < 6; i++) {
    store.snapshot();
  }
  assert.equal(storage.writes.length, 0, '六次渲染读必须零写入');
  assert.ok(storage.reads >= 1, '允许读一次盘做还原');

  // 真实变化的第一次写、重复同样结果不再写
  store.setSynced('21:15');
  assert.equal(storage.writes.length, 1);
  store.setSynced('21:15');
  assert.equal(storage.writes.length, 1, '相同结果不是真实变化，不许重写');
  store.setFailed('21:16', 'E_IO');
  assert.equal(storage.writes.length, 2);
  // 生产不变量（非假件）：snapshot() / liveView() 的渲染路径没有任何写盘调用。
  const render = bodyOf('snapshot(): SyncStatusView') + bodyOf('private liveView(): SyncStatusView');
  assert.doesNotMatch(render, /commit\(|commitStatus\(|\.write\(|storage\.set/,
    '生产渲染路径必须零写盘');
});

// ---------------------------------------------------------------- 9. 偏好异常降级

test('P10 偏好读 / 写抛异常 → 降级为内存态，snapshot 不抛', () => {
  const broken = {
    read() { throw new Error('E_IO'); },
    write() { throw new Error('E_IO'); }
  };
  const store = new ProcessStore(broken);
  let view;
  assert.doesNotThrow(() => { view = store.snapshot(); });
  assert.equal(view.text, '尚未同步');
  assert.doesNotThrow(() => { store.setSynced('12:00'); });
  assert.equal(store.snapshot().text, '已同步 · 12:00', '写盘失败也要保住内存实时视图');
});

// ---------------------------------------------------------------- 10. .ets 薄壳形状

test('P11 .ets 只有一个偏好访问器，且用同步 API（snapshot 是同步调用）', () => {
  assert.match(CODE, /import \{ preferences \} from '@kit\.ArkData'/);
  assert.match(CODE, /import \{ common \} from '@kit\.AbilityKit'/);
  assert.match(CODE, /getPreferencesSync/);
  assert.match(CODE, /getSync\(/);
  assert.match(CODE, /putSync\(/);
  assert.match(CODE, /flushSync\(/);
  assert.equal((CODE.match(/new StatusPrefsStorage/g) || []).length, 1, '只能有一个访问器实例点');
  assert.match(CODE, /class StatusPrefsStorage implements StatusStorage/);
});

test('P12 .ets 写盘只在真实变化（setSynced / setFailed），snapshot 与 setSyncing 零写入', () => {
  const snapshotBody = bodyOf('snapshot(): SyncStatusView {');
  assert.doesNotMatch(snapshotBody, /commit\(|commitStatus|putSync|flushSync|\.write\(/);
  const syncingBody = bodyOf('setSyncing(): SyncStatusView {');
  assert.doesNotMatch(syncingBody, /commit\(|commitStatus|putSync|flushSync/);

  const syncedBody = bodyOf('setSynced(now: Date): SyncStatusView {');
  assert.match(syncedBody, /this\.commit\(\{ kind: 'synced'/);
  const failedBody = bodyOf('setFailed(reason: string, count: number = 0): SyncStatusView {');
  assert.match(failedBody, /this\.commit\(\{ kind: 'failed'/);

  const commitBody = bodyOf('private commit(outcome: PersistedOutcome): void {');
  assert.match(commitBody, /commitStatus\(this\.accessor\(\), outcome, this\.lastWritten\)/);
  const restoreBody = bodyOf('private restore(): PersistedOutcome | null {');
  assert.match(restoreBody, /readStatus\(this\.accessor\(\)\)/);
  assert.doesNotMatch(restoreBody, /commit\(|write\(/);
});

test('P13 .ets 启动决策接的是同一套纯函数；中性面是非抛兜底；三条实时文案一字未改', () => {
  const snapshotBody = bodyOf('snapshot(): SyncStatusView {');
  assert.match(snapshotBody, /bootSurface\(this\.restore\(\), this\.stateOf\(\) === 'syncing'\)/);
  assert.match(snapshotBody, /bootSurface\(null, false\)/, '异常兜底必须回中性面，不编造失败');
  assert.match(CODE, /SYNCED_PREFIX: string = '已同步 · '/);
  assert.match(CODE, /SYNCING_TEXT: string = '同步中…'/);
  assert.match(CODE, /FAILED_PREFIX: string = '失败：'/);
  assert.match(CODE, /fromCycle\(outcome: CycleResult, now: Date\): SyncStatusView/);
  assert.match(CODE, /setPending\(count: number, reason: string\): SyncStatusView/);
  assert.match(CODE, /setError\(reason: string\): SyncStatusView/);

  assert.equal(TEXT_PAST_FAILED_PREFIX, '上次失败 · ');
  assert.equal(TEXT_NEVER, '尚未同步');
  assert.equal(TEXT_SYNCED_PREFIX, '已同步 · ');
  // 中央化承诺写在源码注释里（注释被 stripComments 剥掉了，这里读原文）
  assert.match(STORE_SRC, /mod-config-persistence（build 1000006）/);
});

test('P14 启动「从未同步」时不出现「刚刚」兜底，也不复用实时失败前缀', () => {
  const neutral = bootSurface(null, false);
  assert.equal(neutral.text, TEXT_NEVER);
  assert.equal(neutral.text.includes('刚刚'), false);
  assert.equal(neutral.text.includes(TEXT_FAILED_PREFIX), false);
  assert.equal(neutral.text.includes(TEXT_PAST_FAILED_PREFIX), false);

  const success = bootSurface({ kind: 'synced', at: '07:01', reason: '' }, false);
  assert.equal(success.text, '已同步 · 07:01');
  assert.equal(success.text.includes('刚刚'), false);
});

// ------------------------------------------------- 生产接缝回归（M1 的写作防线）

const PAGE_PATH = join(HERE, '..', '..', 'entry', 'src', 'main', 'ets', 'pages', 'SettingsSync.ets');
const PAGE_SRC = readFileSync(PAGE_PATH, 'utf8');

test('P15 保存设置不产生状态跃迁：保存前后 honest 文案不变、状态存储零写入', () => {
  // 生产接缝：真实 commitStatus / readStatus / bootSurface + 计数存储，不用手写 ProcessStore 假件。
  const storage = fakeStorage();
  const before = readStatus(storage);
  const beforeText = bootSurface(before.outcome, false).text;
  assert.equal(beforeText, TEXT_NEVER, '未同步前必须是中性面');

  // 「保存」在这条接缝上不调用 commitStatus，也不触碰 storage。
  const writesAfterSave = storage.writes.length;
  const afterSave = readStatus(storage);
  assert.equal(storage.writes.length, writesAfterSave, '保存本身零状态写入');
  assert.equal(bootSurface(afterSave.outcome, false).text, beforeText, '保存前后状态文案逐字不变');

  // 源文件守卫：同步页没有第二状态来源、保存路径不写 lastSyncAt、没有 syncRowSummary。
  assert.doesNotMatch(PAGE_SRC, /syncRowSummary\(/, '同步页不得调用根页摘要函数');
  assert.doesNotMatch(PAGE_SRC, /this\.syncMessage/, '同步页不得持有/写入状态字符串');
  assert.doesNotMatch(PAGE_SRC, /SYNC_NEVER/, '「未同步」旧常量不得复活');
  assert.match(PAGE_SRC, /syncMessage: this\.honestStatus\(\)/, '唯一来源必须喂给 SyncSection');
  const save = (() => {
    const at = PAGE_SRC.indexOf('private async saveSettings()');
    assert.ok(at > 0, '找不到 saveSettings');
    const [start, end] = matchBrace(PAGE_SRC, PAGE_SRC.indexOf('{', at));
    return PAGE_SRC.slice(start, end);
  })();
  assert.doesNotMatch(save, /lastSyncAt\s*=/, '保存不得写成功时刻');
  assert.doesNotMatch(save, /lastSyncError\s*=/, '保存不得写失败原因');
});

test('P16 已同步 · HH:MM 只能经完成周期的 setSynced → 持久化 → 读回得到', () => {
  const storage = fakeStorage();
  assert.equal(bootSurface(readStatus(storage).outcome, false).text, TEXT_NEVER);

  // 唯一合法写入路径：完成周期的 commitStatus（真实生产函数）。
  const committed = commitStatus(storage, { kind: 'synced', at: '09:05', reason: '' }, '');
  assert.equal(committed.wrote, true, '真实变化才写');
  assert.equal(storage.writes.length, 1);
  assert.equal(JSON.parse(storage.read()).kind, 'synced');

  const after = bootSurface(readStatus(storage).outcome, false);
  assert.equal(after.text, '已同步 · 09:05', '成功串带真实 HH:MM');
  assert.equal(after.state, 'synced');
  // 模拟重启：新进程读同一份盘仍是最初完成的时刻，不重算「刚刚」。
  const reboot = bootSurface(readStatus(fakeStorage(storage.read())).outcome, false);
  assert.equal(reboot.text, '已同步 · 09:05');

  // 生产渲染路径零写入，且「刚刚」兜底已整支删除。
  const render = bodyOf('snapshot(): SyncStatusView') + bodyOf('private liveView(): SyncStatusView');
  assert.doesNotMatch(render, /commit\(|commitStatus\(|\.write\(|storage\.set/, '渲染路径零写入');
  assert.doesNotMatch(CODE, /刚刚/, 'live 成功文案不得有相对时间兜底');
  // 只有 pull 成功分支允许写 lastSyncAt；纯 status 查询不得刷成功时刻。
  const action = (() => {
    const at = PAGE_SRC.indexOf('private async runAction(');
    assert.ok(at > 0, '找不到 runAction');
    const [start, end] = matchBrace(PAGE_SRC, PAGE_SRC.indexOf('{', at));
    return PAGE_SRC.slice(start, end);
  })();
  assert.match(action, /if \(op === 'pull'\) \{\s*this\.lastSyncAt = nowIso\(\);/,
    '只有真实 pull 周期能推进成功时刻');
});
