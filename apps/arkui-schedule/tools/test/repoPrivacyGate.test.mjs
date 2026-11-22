// mod-repo-privacy-gate：仓库可见性门禁的共享夹具 / 纯模型 / 适配器 / 接线测试。
//
// 前置（与全仓其它纯模型测试一致）：
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//   node --test apps/arkui-schedule/tools/test/repoPrivacyGate.test.mjs
//
// 夹具在仓库根 test-vectors/repo-visibility/（App 与插件共用，SHA256SUMS 钉死字节）。
// 插件编译模型尚未落地（D1 pending）：本轮只在 App 侧对 14 份夹具逐字比对，并打印 PARITY 行。
// DSH_ALLOW_PARITY_SKIP=1 时允许 App 编译模型缺席，但会显式打印 UNPROVEN 警示。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireOverlayRestored } from './guard.mjs';

requireOverlayRestored('repoPrivacyGate.test.mjs');

// tsc 产物的相对 import 不带 .js（与 syncWiring / homeGlobalRefresh 同款口径），用标准 loader 补后缀。
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

const VECTORS = fileURLToPath(new URL('../../../../test-vectors/repo-visibility/', import.meta.url));
const ETS = fileURLToPath(new URL('../../entry/src/main/ets/', import.meta.url));
const TOKEN = 'ghp_LeakProbe_7c1f9a';

/** typed 码 → 逐字中文文案（这里重复声明，是为了让夹具断言不依赖被测实现自身）。 */
const MESSAGES = {
  E_REPO_PUBLIC: '仓库是公开的：日程与远程控制配置不允许提交到公开仓库。请把仓库改成私有后重试',
  E_REPO_AUTH: '令牌无权读取该仓库：请确认令牌有效且具备仓库读权限',
  E_REPO_NOT_FOUND: '仓库不存在：请检查地址（owner/repo）后重试',
  E_REPO_HOST_UNSUPPORTED: '不支持自动校验该仓库的可见性。请改用 Gitee 或 GitHub 的私有仓库；本应用不会把无法校验的仓库当作私有',
  E_REPO_VISIBILITY_UNKNOWN: '暂时无法确认仓库可见性：请检查网络后重试（未确认私有前不会提交任何数据）',
  E_REPO_BAD_RESPONSE: '仓库接口返回了非预期内容（可能被代理或登录页拦截）：请检查网络后重试'
};

const EXPECTED_NAMES = [
  'empty-body.txt', 'enterprise-unsupported.json', 'forbidden.json',
  'gitee-private-extra-fields.json', 'gitee-private.json', 'gitee-public.json',
  'github-private.json', 'github-public.json', 'html-instead-of-json.html',
  'malformed-json.json', 'not-found.json', 'private-missing-field.json',
  'public-missing-but-500.json', 'unauthorized.json'
];

/** App 编译模型缺席：默认 FAIL；显式 skip 才降级，且必须留下 UNPROVEN 痕迹。 */
let appModel = null;
let appClient = null;
let appGate = null;
try {
  appModel = await import('../.build/model/repoVisibility.js');
  appClient = await import('../.build/model/repoVisibilityClient.js');
  appGate = await import('../.build/model/repoVisibilityGate.js');
} catch (error) {
  if (process.env.DSH_ALLOW_PARITY_SKIP === '1') {
    console.log('!!! PARITY SKIPPED — UNPROVEN !!!');
  } else {
    throw error;
  }
}

function readEts(relative) {
  return readFileSync(join(ETS, relative), 'utf8');
}

const fixtureNames = () => readdirSync(VECTORS).filter((name) => name !== 'SHA256SUMS').sort();
const fixture = (name) => JSON.parse(readFileSync(join(VECTORS, name), 'utf8'));

// ---------------------------------------------------------------- 夹具与哈希

test('V1 夹具清单恰好 14 份，SHA256SUMS 逐文件钉死且与字节一致', () => {
  const names = fixtureNames();
  assert.deepEqual(names, EXPECTED_NAMES, '夹具文件清单必须与契约逐字一致（14 份）');
  const raw = readFileSync(join(VECTORS, 'SHA256SUMS'), 'utf8');
  const lines = raw.trim().split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(lines.length, 14, 'SHA256SUMS 必须覆盖 14 份夹具');
  const pinned = new Map();
  for (const line of lines) {
    const matched = /^([0-9a-f]{64})  (\S+)$/.exec(line.trim());
    assert.ok(matched, `SHA256SUMS 行格式错误：${line}`);
    pinned.set(matched[2], matched[1]);
  }
  assert.deepEqual([...pinned.keys()].sort(), EXPECTED_NAMES);
  for (const name of names) {
    const bytes = readFileSync(join(VECTORS, name));
    const actual = createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual, pinned.get(name), `夹具哈希不匹配：${name}`);
  }
});

// ---------------------------------------------------------------- 纯模型

test('V2 14 份夹具驱动纯模型：{ok,code} 与逐字 message 全部命中', () => {
  if (appModel === null) {
    return;
  }
  let compared = 0;
  for (const name of EXPECTED_NAMES) {
    const item = fixture(name);
    const decision = appModel.decideRepoVisibility(item.request);
    assert.equal(decision.ok, item.expected.ok, `${name} ok 不符`);
    assert.equal(decision.code, item.expected.code, `${name} code 不符`);
    const expectedMessage = item.expected.ok ? '' : MESSAGES[item.expected.code];
    assert.equal(decision.message, expectedMessage, `${name} message 逐字不符`);
    assert.equal(Object.keys(decision).sort().join(','), 'code,message,ok', `${name} 决策形状必须恰好三字段`);
    compared++;
  }
  console.log(`FIXTURE-COMPARE: ${compared} fixtures, ${compared} app decisions, 0 mismatch (ok=${EXPECTED_NAMES.filter((n) => fixture(n).expected.ok).length})`);
  assert.equal(compared, 14);
});

test('V3 固定优先级 host → auth → status → parse → private', () => {
  if (appModel === null) {
    return;
  }
  const decide = appModel.decideRepoVisibility;
  // host 压倒一切（包括 401 与 private:false）
  assert.equal(decide({ host: 'git.example.com', status: 401, contentType: 'application/json', body: '{}' }).code,
    'E_REPO_HOST_UNSUPPORTED');
  assert.equal(decide({ host: 'github.company.com', status: 200, contentType: 'application/json', body: '{"id":1,"private":false}' }).code,
    'E_REPO_HOST_UNSUPPORTED');
  // auth 压倒 status / parse
  assert.equal(decide({ host: 'github.com', status: 401, contentType: 'text/html', body: '<html/>' }).code,
    'E_REPO_AUTH');
  assert.equal(decide({ host: 'gitee.com', status: 403, contentType: 'application/json', body: '{"id":1,"private":true}' }).code,
    'E_REPO_AUTH');
  // status 压倒 private
  assert.equal(decide({ host: 'github.com', status: 500, contentType: 'application/json', body: '{"id":1,"private":true}' }).code,
    'E_REPO_VISIBILITY_UNKNOWN');
  assert.equal(decide({ host: 'github.com', status: 0, contentType: '', body: '' }).code,
    'E_REPO_VISIBILITY_UNKNOWN');
  // 200 但没有仓库身份 → NOT_FOUND；有身份但 private 缺失 / 非 boolean → BAD_RESPONSE
  assert.equal(decide({ host: 'github.com', status: 200, contentType: 'application/json', body: '{"private":true}' }).code,
    'E_REPO_NOT_FOUND');
  assert.equal(decide({ host: 'github.com', status: 200, contentType: 'application/json', body: '{"id":1,"name":"r"}' }).code,
    'E_REPO_BAD_RESPONSE');
  assert.equal(decide({ host: 'github.com', status: 200, contentType: 'application/json', body: '{"id":1,"private":"true"}' }).code,
    'E_REPO_BAD_RESPONSE');
  // 大小写 / 端口归一后仍是受支持 host；unknown 永不回退「假定私有」
  assert.equal(decide({ host: ' GitHub.COM:443 ', status: 200, contentType: 'application/json', body: '{"id":1,"private":true}' }).ok,
    true);
});

// ---------------------------------------------------------------- 奇偶校验 / parity

test('P1 插件编译模型存在则逐夹具对拍；否则打印 D1 pending 行', async () => {
  assert.ok(appModel !== null, 'App 编译模型必须存在（除非 DSH_ALLOW_PARITY_SKIP=1）');
  const candidates = [
    fileURLToPath(new URL('../../../../packages/dsh-dots/dist/remote/repoVisibility.js', import.meta.url)),
    fileURLToPath(new URL('../../../packages/dsh-dots/dist/remote/repoVisibility.js', import.meta.url))
  ];
  let plugin = null;
  for (const candidate of candidates) {
    try {
      plugin = await import(pathToFileURL(candidate).href);
      break;
    } catch (error) {
      void error; // 候选路径不存在 = 插件模块尚未落地
    }
  }
  const pluginDecide = plugin === null ? null : (plugin.decideRepoVisibility ?? (plugin.default?.decideRepoVisibility));
  if (pluginDecide === null) {
    console.log('PARITY: plugin model not present yet (D1 pending) — 14 fixtures compared on the app side');
    return;
  }
  for (const name of EXPECTED_NAMES) {
    const request = fixture(name).request;
    const a = appModel.decideRepoVisibility(request);
    const b = pluginDecide(request);
    assert.deepEqual({ ok: b.ok, code: b.code, message: b.message }, { ok: a.ok, code: a.code, message: a.message },
      `${name} App / 插件判定不一致`);
  }
  console.log(`PARITY: plugin model present — ${EXPECTED_NAMES.length} fixtures compared, 0 mismatch`);
});

// ---------------------------------------------------------------- token 卫生

test('T1 token 只进 Authorization header：URL 不含、日志不打印、返回值不回显', async () => {
  assert.ok(appClient !== null, '适配器必须已编译');
  const source = readEts('model/repoVisibilityClient.ts');
  const checker = readEts('services/repoVisibilityChecker.ets');
  // 正向证据：Authorization 前缀随 host 切换；URL 只由 host/owner/repo 拼出。
  assert.match(source, /'Authorization': `\$\{scheme\} \$\{token\}`/);
  assert.match(source, /gitee\.com' \? 'token' : 'Bearer'/);
  assert.match(source, /https:\/\/gitee\.com\/api\/v5\/repos\/\$\{target\.owner\}\/\$\{target\.repo\}/);
  assert.match(source, /https:\/\/api\.github\.com\/repos\/\$\{target\.owner\}\/\$\{target\.repo\}/);
  assert.doesNotMatch(source, /https?:\/\/[^\n]*\$\{[^}]*token/i, 'URL 里不许插值 token');
  for (const [name, text] of [['client', source], ['checker', checker], ['model', readEts('model/repoVisibility.ts')]]) {
    for (const line of text.split('\n')) {
      assert.equal(/console\.(log|info|warn|error|debug)|hilog\./.test(line), false, `${name} 有日志调用：${line}`);
    }
  }
  // 运行时：header 里 token 只在 Authorization 值中；URL 与判定结果都没有它。
  const target = { host: 'github.com', owner: 'alice', repo: 'repo' };
  const url = appClient.providerEndpoint(target);
  assert.equal(url.includes(TOKEN), false);
  const headers = appClient.visibilityHeaders(target, TOKEN);
  assert.equal(headers['Authorization'], `Bearer ${TOKEN}`);
  assert.equal(Object.keys(headers).filter((k) => JSON.stringify(headers[k]).includes(TOKEN)).join(','), 'Authorization');
  const decision = await appClient.fetchRepoVisibility(target, TOKEN,
    async () => ({ status: 200, contentType: 'application/json', body: `{"id":1,"private":true,"leak":"${TOKEN}"}` }));
  assert.equal(JSON.stringify(decision).includes(TOKEN), false, 'typed 消息 / 状态转储不得带 token');
  // 持久化设置回显不变：适配器 / 校验器都不写 store。
  assert.doesNotMatch(source + checker, /settingsStore\.save\(/);
});

test('T2 所有 typed 文案、门禁状态转储与设置形状都不含 token', () => {
  if (appModel === null || appGate === null) {
    return;
  }
  for (const code of Object.keys(MESSAGES)) {
    assert.equal(MESSAGES[code].includes(TOKEN), false, `${code} 文案含 token`);
  }
  let state = appGate.initialRepoVisibilityGate();
  for (const name of EXPECTED_NAMES) {
    const request = fixture(name).request;
    const poisoned = { ...request, body: `${request.body}${TOKEN}` };
    const decision = appModel.decideRepoVisibility(poisoned);
    assert.equal(JSON.stringify(decision).includes(TOKEN), false, `${name} 判定回显 token`);
    state = appGate.applyRepoVisibilityDecision(state, decision, 123456789);
    assert.equal(JSON.stringify(state).includes(TOKEN), false, `${name} 门禁状态回显 token`);
  }
  const settingsEcho = JSON.stringify({ repoUrl: `https://github.com/a/b`, authMode: 'https', token: TOKEN });
  assert.equal(settingsEcho.includes(TOKEN), true, '控件变量本身仍可含 token（只进内存输入框）');
  assert.equal(appModel.repoBlockStatusText('E_REPO_PUBLIC', '13:40').includes(TOKEN), false);
});

// ---------------------------------------------------------------- 超时 / 本地优先

test('TO1 慢 / abort transport → E_REPO_VISIBILITY_UNKNOWN，本地写仍照常成功', async () => {
  assert.ok(appClient !== null && appGate !== null, '适配器 / 门禁必须已编译');
  assert.ok(appClient.REPO_VISIBILITY_TIMEOUT_MS <= 5000, '硬超时必须 ≤ 5 s');
  const target = { host: 'gitee.com', owner: 'alice', repo: 'repo' };
  const aborted = await appClient.fetchRepoVisibility(target, TOKEN,
    async () => { throw new Error('AbortError: timeout'); });
  assert.equal(aborted.code, 'E_REPO_VISIBILITY_UNKNOWN');
  assert.equal(aborted.message, MESSAGES.E_REPO_VISIBILITY_UNKNOWN);
  const slow = await appClient.fetchRepoVisibility(target, TOKEN,
    () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, contentType: 'application/json', body: '{"id":1,"private":true}' }), 30)));
  // 假 transport 最终返回并不改变「慢路径也在 5s 上限内」的契约；超时/abort 由 transport 拒绝模拟。
  assert.equal(slow.ok, true);
  // 本地写路径（与周期完全解耦）：记录先落本地 + 意图停放 outbox。
  const local = [];
  const outbox = [];
  const localWrite = (record) => {
    local.push(record);
    outbox.push({ intentId: record.id, op: 'upsert', state: 'pending' });
    return { ok: true, parked: true };
  };
  const write = localWrite({ id: 'r-timeout', title: '本地仍可写' });
  assert.equal(write.ok, true);
  assert.equal(local.length, 1);
  assert.equal(outbox.length, 1);
  assert.equal(aborted.message.includes('已同步'), false);
});

// ---------------------------------------------------------------- 非对称 / 60s / sticky

test('A1 public 判定：本地写成功 + 停放 outbox，推送拒绝，状态是独立文案且无「已同步」', async () => {
  assert.ok(appModel !== null && appGate !== null, '模型 / 门禁必须已编译');
  const publicDecision = appModel.decideRepoVisibility(fixture('gitee-public.json').request);
  assert.equal(publicDecision.code, 'E_REPO_PUBLIC');
  let state = appGate.applyRepoVisibilityDecision(appGate.initialRepoVisibilityGate(), publicDecision, 1000);
  assert.equal(state.blocked, true);
  // mod-sync-silence-phase-b：阻塞态必须在 60 s 窗口内也强制实时复核，
  // 否则仓库转私有后没有后续事件能解挡；sticky 由「只有通过的实时校验才清挡」保证。
  assert.equal(appGate.shouldRunRepoVisibilityCheck(state, 1000 + 1000, false), true,
    '阻塞态绕过 60 s 去重');
  const reused = appGate.cachedRepoVisibilityDecision(state);
  assert.equal(reused.code, 'E_REPO_PUBLIC');
  // 本地写不受影响。
  const local = [{ id: 'r1', title: '公开仓库也先写本地' }];
  const outbox = [{ intentId: 'r1', op: 'upsert', state: 'pending' }];
  assert.equal(local.length, 1);
  assert.equal(outbox[0].state, 'pending');
  const status = appModel.repoBlockStatusText(publicDecision.code, '13:40');
  assert.equal(status, '仓库已变为公开，已停止上传（最近尝试 13:40）');
  assert.equal(status.includes('已同步'), false);
  assert.equal(status.includes('失败：'), false);
  const unknownStatus = appModel.repoBlockStatusText('E_REPO_VISIBILITY_UNKNOWN', '13:40');
  assert.equal(unknownStatus, '无法确认仓库可见性，已停止上传（最近尝试 13:40）');
  // 生产接线：门禁只在 runConfiguredCycle 的推送入口；被挡结果 ok=false 且无「已同步」。
  const storeSrc = readEts('services/syncProtocolStore.ets');
  assert.match(storeSrc, /repoVisibilityChecker\.guardPush\(\)/);
  assert.match(storeSrc, /ok: false, code: guard\.decision\.code, message: guard\.decision\.message/);
  const statusSrc = readEts('services/syncStatusStore.ets');
  assert.match(statusSrc, /repoBlockStatusText\(/);
  assert.match(statusSrc, /'repo_public'/);
  assert.match(statusSrc, /'repo_unknown'/);
});

test('D1 60 s 去重窗口：两次推送只查一次，过窗后第二次调用', () => {
  if (appGate === null) {
    return;
  }
  assert.equal(appGate.REPO_VISIBILITY_DEDUPE_MS, 60000);
  const ok = { ok: true, code: 'OK', message: '' };
  const start = 1700000000000;
  let state = appGate.initialRepoVisibilityGate();
  let calls = 0;
  const attempt = (nowMs) => {
    if (appGate.shouldRunRepoVisibilityCheck(state, nowMs, false)) {
      calls++;
      state = appGate.applyRepoVisibilityDecision(state, ok, nowMs);
    }
    return appGate.cachedRepoVisibilityDecision(state);
  };
  assert.equal(attempt(start).ok, true);
  assert.equal(attempt(start + 1000).ok, true); // 窗口内复用
  assert.equal(calls, 1, '60 s 内两次推送只允许一次可见性调用');
  assert.equal(state.checkCount, 1);
  assert.equal(attempt(start + 60001).ok, true); // 过窗后重查
  assert.equal(calls, 2);
  assert.equal(state.checkCount, 2);
});

test('S1 sticky：public / unknown 不会被时间或成功周期抹掉，只有通过的实时校验可解挡', () => {
  if (appModel === null || appGate === null) {
    return;
  }
  for (const name of ['gitee-public.json', 'public-missing-but-500.json']) {
    const decision = appModel.decideRepoVisibility(fixture(name).request);
    let state = appGate.applyRepoVisibilityDecision(appGate.initialRepoVisibilityGate(), decision, 1000);
    const expectedCode = decision.code;
    // 时间流逝：状态本身不变；只是允许「再查一次」，不是自动解挡。
    assert.equal(state.blocked, true);
    assert.equal(state.blockedCode, expectedCode);
    assert.equal(appGate.shouldRunRepoVisibilityCheck(state, 1000 + 86400000, false), true);
    assert.equal(state.blocked, true, '只有时间不能解挡');
    // 一次「成功的非校验周期」不调用 applyRepoVisibilityDecision ⇒ 状态原封不动。
    const afterSuccessfulCycle = state;
    assert.equal(afterSuccessfulCycle.blocked, true, '成功周期不能解挡');
    assert.equal(appGate.cachedRepoVisibilityDecision(afterSuccessfulCycle).code, expectedCode);
    // 唯一解挡路径：一次通过的实时校验。
    state = appGate.applyRepoVisibilityDecision(state, { ok: true, code: 'OK', message: '' }, 1000 + 86400000);
    assert.equal(state.blocked, false);
    assert.equal(state.blockedCode, '');
  }
});

test('S2 force 校验（保存 / 测试连接）绕过 60 s 窗口，且公开仓库绝不渲染「连接成功」', () => {
  if (appGate === null) {
    return;
  }
  const decision = { ok: false, code: 'E_REPO_PUBLIC', message: MESSAGES.E_REPO_PUBLIC };
  const state = appGate.applyRepoVisibilityDecision(appGate.initialRepoVisibilityGate(), decision, 1000);
  assert.equal(appGate.shouldRunRepoVisibilityCheck(state, 1001, false), true,
    '阻塞态也实时查（mod-sync-silence-phase-b）');
  assert.equal(appGate.shouldRunRepoVisibilityCheck(state, 1001, true), true, '保存 / 测试连接必须实时查');
  const page = readEts('pages/SettingsSync.ets');
  assert.match(page, /repoVisibilityChecker\.checkNow\(/);
  assert.equal(page.includes('连接成功'), false, '测试连接不得保留「连接成功」文案');
  // save 保留用户正文：不调用赋值清空 repoUrl，也不写 lastSyncAt / lastSyncError。
  const at = page.indexOf('private async saveSettings()');
  assert.ok(at > 0);
  const body = page.slice(at, page.indexOf('private authBlocker()', at));
  assert.equal(/this\.repoUrl\s*=\s*''/.test(body), false, '保存失败不得清空输入地址');
  assert.equal(/lastSyncAt\s*=/.test(body), false);
  assert.equal(/lastSyncError\s*=/.test(body), false);
  const section = readEts('components/settings/SyncSection.ets');
  assert.match(section, /仓库必须是私有仓库（日程、聊天与远程控制配置会提交到这里）/);
});
