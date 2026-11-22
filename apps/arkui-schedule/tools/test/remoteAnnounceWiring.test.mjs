// 公告刷新接线（`mod-remote-announce-wiring`）的 Node 单测。
//
// 前置（与 remoteAnnounce.test.mjs 同一条命令）：
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 两类断言：
//   ① 行为：纯决策层 `model/remoteAnnounceRefresh.ts` 在 Node 里直接跑，注入假验签器 / 时钟，
//      覆盖「陈旧地址 + 有效公告 ⇒ 更新」与四类不可信 ⇒ 保旧地址；
//   ② 接线（source-shape）：.ets 不能被 Node 执行，就按源码文本断言
//      页面 → 服务 → remoteAnnounceStore 的 import / 调用链真实存在（避免再次出现「无 importer
//      的死代码」），并钉住「只读仓库 / 无后台定时器 / 不抛到 UI / 文案上屏」这些纪律。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

// tsc 以 bundler 模式发出无扩展名的 `./remoteAnnounce`；Node ESM 需要 `.js`。
// 只在测试进程里补一次后缀，源码保持 ArkTS 可解析的写法（不改编译配置、不改纯模型）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './remoteAnnounce') {
      return nextResolve('./remoteAnnounce.js', context);
    }
    return nextResolve(specifier, context);
  }
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../entry/src/main/ets');

const {
  KEEP_WORDING
} = await import('../.build/model/remoteAnnounce.js');
const {
  decideAnnounceRefresh,
  completeRefresh,
  announcementBaseUrl,
  REFRESHED_WORDING,
  REFUSAL_WORDING,
  NO_ANNOUNCEMENT_WORDING,
  NOT_NEWER_WORDING,
  FIRST_PAIRING_WORDING,
  FIRST_PAIRING_DETAIL,
  AWAITING_CONSENT_WORDING
} = await import('../.build/model/remoteAnnounceRefresh.js');

/** 读源码文本（接线断言用；路径相对 entry/src/main/ets）。 */
function src(relative) {
  return readFileSync(resolve(SRC, relative), 'utf8');
}

/** 去掉注释后的代码：中文说明里提到 write/git 是允许的，只有真实调用才算违规。 */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 固定时钟 / 公钥，保证断言可复现。 */
const NOW = 1763740800000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const PUBKEY = '00'.repeat(32);
const PIN_A = 'a'.repeat(64);
const PIN_B = 'b'.repeat(64);
const OLD_URL = 'http://10.0.0.7:3080';
const CURRENT = { id: 'inst-0123456789abcdef', updatedAt: NOW - 60 * MINUTE };

/** 合法公告夹具（可局部覆盖）；signature 由假验签器接管。 */
function makeAnn(overrides = {}) {
  return {
    instanceId: CURRENT.id,
    scheme: 'https',
    host: 'dsh.example.local',
    port: 3080,
    transportKind: 'ipv6',
    publicKeyFingerprint: PIN_A,
    tlsFingerprint: PIN_B,
    tokenId: 'tok-9f3c2a1b7d4e5f60',
    updatedAt: NOW,
    nonce: 'n-4d2e7f1a',
    signature: 'deadbeef',
    ...overrides
  };
}

/** 默认验签通过、已钉 PIN_A、显式非首配、固定时钟。 */
function makeOpts(overrides = {}) {
  return {
    verifier: () => true,
    publicKey: PUBKEY,
    pinnedKey: PIN_A,
    firstPairing: false,
    knownPins: {},
    now: () => NOW,
    ...overrides
  };
}

/** 走完整接线决策：公告文本 + 选项 → 结果。 */
function run(text, overrides = {}, current = CURRENT) {
  return decideAnnounceRefresh(current, text, 'tablet', makeOpts(overrides));
}

/** 合法公告的 JSON 文本。 */
function announceText(overrides = {}) {
  return JSON.stringify(makeAnn(overrides));
}

describe('W1 接线存在（页面 → 服务 → remoteAnnounceStore，杜绝无 importer 死代码）', () => {
  test('页面 import 刷新服务，并在 reachable=fail 的按钮 onClick 中真正调用它', () => {
    const page = src('pages/panes/InstancesPane.ets');
    assert.match(page, /import\s*\{\s*remoteAnnounceRefreshService\s*\}\s*from\s*'[^']*services\/remoteAnnounceRefresh'/,
      '页面必须 import 刷新服务单例');
    assert.match(page, /refreshAddressFromAnnouncement/, '页面必须有刷新动作方法');
    assert.match(page, /remoteAnnounceRefreshService\.init\s*\(/, '页面必须预置 filesDir');
    assert.match(page, /remoteAnnounceRefreshService\.refresh\s*\(/, '页面必须实际调用服务');
    assert.match(page, /view\.reachable === 'fail'/, '刷新按钮只在地址不再应答时出现');
    assert.match(page, /'按公告刷新地址'/, '有 pin 时的普通刷新按钮文案必须上屏');
    assert.match(page, /FIRST_PAIRING_WORDING/, '无 pin 时改用首配按钮文案');
  });

  test('服务 import 纯决策层 + remoteAnnounceStore + instanceStore，并做四步验证', () => {
    const service = src('services/remoteAnnounceRefresh.ets');
    assert.match(service, /from '\.\.\/model\/remoteAnnounceRefresh'/, '服务 import 纯决策层');
    assert.match(service, /from '\.\.\/model\/remoteAnnounce'/, '服务 import 四步模型');
    assert.match(service, /from '\.\/remoteAnnounceStore'/, '服务 import remoteAnnounceStore');
    assert.match(service, /from '\.\/instanceStore'/, '服务 import 实例表');
    assert.match(service, /remoteAnnounceStore\.getPin\s*\(/, '读取已钉验签材料');
    assert.match(service, /remoteAnnounceStore\.allPins\s*\(/, '喂入同 id 冲突表');
    assert.match(service, /createEd25519Verifier\s*\(/, '生产注入 cryptoFramework 验签器');
    assert.match(service, /decideAnnounceRefresh\([^)]*'tablet'/,
      '平板侧 caller 固定为 tablet（tailcat 走 typed 拒绝）');
  });

  test('钉住表与已应用时间表都在 remoteAnnounceStore 中，且时间只在刷新成功后写入', () => {
    const store = src('services/remoteAnnounceStore.ets');
    assert.match(store, /getAppliedUpdatedAt\s*\(/, '提供已应用时间读取');
    assert.match(store, /applyUpdatedAt\s*\(/, '提供已应用时间写入');
    assert.match(store, /remote-announce-applied\.json/, '已应用表有独立持久键');
    const service = src('services/remoteAnnounceRefresh.ets');
    assert.match(service, /outcome\.state === 'refreshed'/, '写入动作必须受 refreshed 门控');
    assert.match(service, /instanceStore\.upsert\s*\(next\)/, '成功时才更新地址');
    assert.match(service, /remoteAnnounceStore\.applyUpdatedAt\s*\(/, '成功时才更新时间');
  });

  test('仓库读取是只读的：无写文件 / 建目录 / git 提交推送，无网络', () => {
    const service = src('services/remoteAnnounceRefresh.ets');
    assert.match(service, /fs\.readTextSync\s*\(/, '只读 API');
    assert.match(service, /\$\{REPO_DIR\}\/\$\{REMOTE_DIR\}/,
      '路径指向同步仓库工作副本 remote/');
    const code = codeOnly(service);
    assert.doesNotMatch(code,
      /fs\.(writeFile|writeText|mkdir|remove|rename|copyFile|unlink)|GitSyncService|\.commit\s*\(|\.push\s*\(/,
      '不得写仓库任何文件 / 提交 / 推送');
    assert.doesNotMatch(code, /http\.request|@ohos\.net|fetch\s*\(/,
      '不得发起网络调用');
  });

  test('没有后台定时器：刷新只由页面显式动作触发', () => {
    for (const file of [
      'pages/panes/InstancesPane.ets',
      'services/remoteAnnounceRefresh.ets',
      'services/remoteAnnounceStore.ets'
    ]) {
      const text = src(file);
      assert.doesNotMatch(text, /setInterval|setTimeout|@ohos\.resourcescheduler|backgroundTask|Timer/,
        `${file} 不得引入后台定时器`);
    }
  });

  test('刷新不抛到 UI 线程，且地址不进 @State / 日志', () => {
    const service = src('services/remoteAnnounceRefresh.ets');
    assert.match(service, /try\s*\{[\s\S]*catch\s*\{/, '服务整条路径必须吞异常');
    assert.doesNotMatch(service, /console\.|hilog|logger/, '服务零日志（地址是 capability）');
    const page = src('pages/panes/InstancesPane.ets');
    assert.match(page, /this\.announceNotice = outcome\.wording/, '页面只取文案');
    assert.doesNotMatch(page, /announceNotice\s*=\s*outcome\.newUrl/, '地址绝不进页面状态');
  });
});

describe('W2 刷新成功：陈旧地址 + 有效公告才更新地址', () => {
  test('四步全过且 updatedAt 更新 ⇒ refreshed，产出新地址 / 时间 / pin', () => {
    const out = run(announceText());
    assert.equal(out.state, 'refreshed');
    assert.equal(out.problem, 'ok');
    assert.equal(out.newUrl, 'https://dsh.example.local:3080');
    assert.equal(out.updatedAt, NOW);
    assert.equal(out.pin, PIN_A);
    assert.equal(out.wording, REFRESHED_WORDING);
    assert.notEqual(out.newUrl, OLD_URL, '必须确实是新地址');
  });

  test('新地址不等于旧地址时才会刷新；相同地址 + 更新时间仍按公告幂等产出', () => {
    const out = run(announceText(), {}, { id: CURRENT.id, updatedAt: 0 });
    assert.equal(out.state, 'refreshed');
    assert.equal(out.newUrl, 'https://dsh.example.local:3080');
  });

  test('IPv6 字面量 host 被包方括号，避免二次归一失败', () => {
    assert.equal(announcementBaseUrl(makeAnn({ host: '2001:db8::1' })),
      'https://[2001:db8::1]:3080');
    const out = run(announceText({ host: '2001:db8::1' }));
    assert.equal(out.state, 'refreshed');
    assert.equal(out.newUrl, 'https://[2001:db8::1]:3080');
  });

  test('公告不比已应用时间更新 ⇒ not-newer，保旧地址且不报「不可信」', () => {
    const out = run(announceText(), {}, { id: CURRENT.id, updatedAt: NOW });
    assert.equal(out.state, 'not-newer');
    assert.equal(out.problem, 'E_ANNOUNCE_NOT_NEWER');
    assert.equal(out.newUrl, '');
    assert.equal(out.wording, NOT_NEWER_WORDING);
  });
});

describe('W3 不可信：四类失败都保旧地址并上屏逐字文案', () => {
  /** 断言「保旧地址 + 不可信文案」的统一守卫。 */
  function assertHeld(out, problem) {
    assert.equal(out.state, 'untrusted');
    assert.equal(out.problem, problem);
    assert.equal(out.newUrl, '', '失败时绝不给出新地址');
    assert.equal(out.updatedAt, 0);
    assert.equal(out.pin, '');
    assert.equal(out.wording, KEEP_WORDING, '上屏文案逐字等于 KEEP_WORDING');
    assert.equal(REFUSAL_WORDING, KEEP_WORDING, '接线层文案常量必须复用模型常量');
  }

  test('签名无效 ⇒ 保旧地址', () => {
    assertHeld(run(announceText(), { verifier: () => false }), 'E_ANNOUNCE_SIGNATURE');
  });

  test('钉住指纹不匹配 ⇒ 保旧地址', () => {
    assertHeld(run(announceText(), { pinnedKey: 'c'.repeat(64) }), 'E_ANNOUNCE_PIN_MISMATCH');
  });

  test('更新时间超出未来 5 分钟 ⇒ 保旧地址', () => {
    assertHeld(run(announceText({ updatedAt: NOW + 6 * MINUTE })),
      'E_ANNOUNCE_FUTURE');
  });

  test('更新时间早于过去 30 天 ⇒ 保旧地址', () => {
    assertHeld(run(announceText({ updatedAt: NOW - 31 * DAY })),
      'E_ANNOUNCE_TOO_OLD');
  });

  test('同 id 但公钥不同 ⇒ 冲突拒绝且不合并', () => {
    assertHeld(run(announceText(), { knownPins: { [CURRENT.id]: 'd'.repeat(64) } }),
      'E_ANNOUNCE_ID_CONFLICT');
  });

  test('跨 id 公告 ⇒ 拒绝写到这一行', () => {
    assertHeld(run(announceText({ instanceId: 'inst-eeeeeeeeeeeeeeee' })),
      'E_ANNOUNCE_ID_CONFLICT');
  });

  test('尚未钉住且非显式首配 ⇒ 拒绝（自动刷新路径永不首配）', () => {
    assertHeld(run(announceText(), { pinnedKey: '', firstPairing: false }),
      'E_ANNOUNCE_PIN_REQUIRED');
  });

  test('坏 JSON / 形状错误 ⇒ 保旧地址', () => {
    assertHeld(run('{not json'), 'E_ANNOUNCE_JSON');
    assertHeld(run(JSON.stringify({ nope: true })), 'E_ANNOUNCE_MISSING');
  });

  test('含 token 字段的公告 ⇒ 凭据 typed 拒绝', () => {
    const withSecret = announceText();
    assertHeld(run(withSecret.slice(0, -1) + ',"token":"sk-should-never-appear"}'),
      'E_ANNOUNCE_SECRET');
  });

  test('tailcat 公告在平板侧 typed 拒绝（不静默降级、不做平板传输）', () => {
    assertHeld(run(announceText({ transportKind: 'tailcat' })),
      'E_ANNOUNCE_TRANSPORT_UNSUPPORTED');
  });

  test('验签器抛异常 ⇒ 按不可信处理，决策函数不向调用方抛', () => {
    const throwing = () => { throw new Error('platform crypto down'); };
    assertHeld(run(announceText(), { verifier: throwing }), 'E_ANNOUNCE_SIGNATURE');
  });

  test('验签仍严格先于时间判定（四步顺序不被接线层打乱）', () => {
    const order = [];
    const out = run(announceText(), {
      verifier: () => { order.push('verify'); return false; },
      now: () => { order.push('clock'); return NOW; }
    });
    assert.deepEqual(order, ['verify'], '签名失败时根本不读时钟');
    assertHeld(out, 'E_ANNOUNCE_SIGNATURE');
  });
});

describe('W4 无公告：typed 状态与保旧地址', () => {
  test('文件不存在 / 空文件 ⇒ no-announcement 专用状态与文案', () => {
    for (const text of [null, undefined, '', '   ']) {
      const out = run(text);
      assert.equal(out.state, 'no-announcement');
      assert.equal(out.problem, 'E_ANNOUNCE_MISSING');
      assert.equal(out.newUrl, '');
      assert.equal(out.wording, NO_ANNOUNCEMENT_WORDING);
      assert.notEqual(out.wording, KEEP_WORDING, '无公告不等于不可信');
    }
  });

  test('无公告状态不会触发地址更新（服务侧由 state 门控）', () => {
    const service = src('services/remoteAnnounceRefresh.ets');
    assert.match(service, /if \(outcome\.state === 'refreshed'\)/, '只有 refreshed 分支写地址');
    const out = run(null);
    assert.notEqual(out.state, 'refreshed');
  });
});

// ---------------------------------------------------------------------------
// 关闭评审 Major：原先 firstPairing 恒 false 且没有任何 setPin 调用者 ⇒ refreshed 永不可达。
// 下面五组把「首配提案 → 显式确认 → 落锚点 + 地址」整条成功路径钉死，并覆盖三项细化要求。
// ---------------------------------------------------------------------------

/** 端口写入都被记进一个可 JSON 快照的状态对象，用来做**字节级**不变断言。 */
function makePort(state) {
  return {
    storePin(pin) { state.pins[CURRENT.id] = pin; },
    storeAddress(url, at) {
      state.instances.push({ id: CURRENT.id, url: url });
      state.applied[CURRENT.id] = at;
    }
  };
}

/** 首配提案：没有 pin + firstPairing=true + 四步全过，但零写入。 */
function propose(overrides = {}) {
  return decideAnnounceRefresh(
    CURRENT,
    announceText(),
    'tablet',
    makeOpts({ pinnedKey: '', firstPairing: true, ...overrides })
  );
}

describe('W5 首配可达：显式确认才写 pin + 地址', () => {
  test('(a) 无 pin + 显式确认 ⇒ pin 落盘、地址更新、state 为 refreshed（成功路径可达）', () => {
    const pending = propose();
    assert.equal(pending.state, 'first-pairing-pending', '四步全过但没有 pin 时只能给提案');
    assert.equal(pending.pin, PIN_A);
    assert.equal(pending.newUrl, 'https://dsh.example.local:3080');

    const state = { pins: {}, applied: {}, instances: [] };
    const out = completeRefresh(pending, true, '', makePort(state));
    assert.equal(out.state, 'refreshed');
    assert.equal(out.problem, 'ok');
    assert.equal(out.pin, PIN_A);
    assert.equal(state.pins[CURRENT.id], PIN_A, 'TOFU 锚点必须落盘');
    assert.equal(state.instances.length, 1, '地址必须在同一次确认中写入');
    assert.equal(state.instances[0].url, 'https://dsh.example.local:3080');
    assert.equal(state.applied[CURRENT.id], NOW, 'updatedAt 必须与地址同一次写入');
  });

  test('(b) 取消确认 ⇒ 端口一次都不调用，pins / 实例表字节逐字不变（不是只不崩溃）', () => {
    const pending = propose();
    const state = { pins: {}, applied: {}, instances: [] };
    const before = JSON.stringify(state);

    const out = completeRefresh(pending, false, '', makePort(state));

    assert.equal(out.state, 'awaiting-consent');
    assert.equal(out.problem, 'E_ANNOUNCE_PIN_REQUIRED');
    assert.equal(out.newUrl, '', '取消后绝不能带出新地址');
    assert.equal(JSON.stringify(state), before, 'pins / 地址 / updatedAt 三段持久化字节必须完全不变');
    assert.equal(AWAITING_CONSENT_WORDING, FIRST_PAIRING_WORDING);
    assert.equal(out.wording, FIRST_PAIRING_WORDING, '取消后仍停在首配动作文案，不是成功文案');

    // 页面也没有把提案里的地址塞进任何 @State
    const page = src('pages/panes/InstancesPane.ets');
    assert.match(page, /this\.announceNotice = FIRST_PAIRING_WORDING/, '只上屏动作文案');
    assert.doesNotMatch(page, /announceNotice\s*=\s*(pending|outcome)\.newUrl/, '地址不进 @State');
    assert.match(page, /private pendingAnnounce: AnnounceRefreshOutcome \| null = null/,
      '提案存在非响应式私有字段，不触发 UI 地址态');
    const service = src('services/remoteAnnounceRefresh.ets');
    assert.match(service, /completeRefresh\(pending, true, '', port\)/, '只有显式确认传 consent=true');
    assert.doesNotMatch(service, /completeRefresh\([^)]*false/, '服务里没有暗中的取消写入路径');
  });

  test('(c) 已有 pin 但钥匙不同 ⇒ typed 拒绝、保旧地址，首配确认绝不重绑', () => {
    const pending = propose();
    const state = { pins: { [CURRENT.id]: PIN_B }, applied: {}, instances: [] };
    const before = JSON.stringify(state);

    const out = completeRefresh(pending, true, PIN_B, makePort(state));

    assert.equal(out.state, 'untrusted');
    assert.equal(out.problem, 'E_ANNOUNCE_PIN_MISMATCH');
    assert.equal(out.newUrl, '');
    assert.equal(out.wording, KEEP_WORDING);
    assert.equal(JSON.stringify(state), before, '冲突时 pin 与实例表字节都不变，绝不静默换钥');

    // 决策层同口径：钉 PIN_A 的公告改成 PIN_B ⇒ 拒绝
    const decided = run(announceText({ publicKeyFingerprint: PIN_B }));
    assert.equal(decided.problem, 'E_ANNOUNCE_PIN_MISMATCH');
    assert.equal(decided.newUrl, '');
  });

  test('(d) 首配后同一把钥匙 + 更新的 updatedAt ⇒ 无需再确认，直接 refreshed', () => {
    const newer = announceText({ updatedAt: NOW });
    const out = decideAnnounceRefresh(
      { id: CURRENT.id, updatedAt: NOW - 60 * 1000 },
      newer,
      'tablet',
      makeOpts({
        pinnedKey: PIN_A,
        publicKey: PUBKEY,
        firstPairing: false,
        knownPins: { [CURRENT.id]: PIN_A }
      })
    );
    assert.equal(out.state, 'refreshed', 'TOFU pin 的存在就是后续免确认刷新的依据');
    assert.equal(out.pin, PIN_A);
    assert.equal(out.newUrl, 'https://dsh.example.local:3080');

    // 同一把钥匙但时间更旧 ⇒ 不刷新（仍不会因为 pin 存在而放宽时序）
    const older = decideAnnounceRefresh(
      { id: CURRENT.id, updatedAt: NOW },
      newer,
      'tablet',
      makeOpts({ pinnedKey: PIN_A, publicKey: PUBKEY, firstPairing: false })
    );
    assert.equal(older.state, 'not-newer');
    assert.equal(older.newUrl, '');
  });

  test('(e) 没有静默信任路径：firstPairing 由「无 pin」推导，且只有显式按钮能进入', () => {
    const service = src('services/remoteAnnounceRefresh.ets');
    assert.match(service, /const firstPairing: boolean = pin\.length === 0/,
      'firstPairing 必须由无 pin 推导，不能硬编码 true');
    assert.match(service, /firstPairing: firstPairing/, '注入模型的就是这个推导值');
    assert.doesNotMatch(service, /firstPairing:\s*true/, '服务里没有恒 true 的首配');

    const confirmAt = service.indexOf('confirmFirstPairing(');
    assert.ok(confirmAt > 0, '必须存在独立的显式确认方法');
    const refreshBody = service.slice(service.indexOf('refresh(instance'), confirmAt);
    assert.doesNotMatch(refreshBody, /setPin\s*\(/, '提案方法绝不写 pin');
    assert.match(service.slice(confirmAt), /remoteAnnounceStore\.setPin\s*\(/,
      'pin 只在确认方法里通过端口写入');

    const page = src('pages/panes/InstancesPane.ets');
    const lifecycle = page.slice(page.indexOf('aboutToAppear()'), page.indexOf('// ------------------------------------------------------------------ 数据'));
    assert.doesNotMatch(lifecycle, /refreshAddressFromAnnouncement|confirmFirstPairing|remoteAnnounceRefreshService/,
      'aboutToAppear / onPageShow 不得自动触发刷新或首配');
    for (const file of [
      'pages/panes/InstancesPane.ets',
      'services/remoteAnnounceRefresh.ets',
      'services/remoteAnnounceStore.ets'
    ]) {
      assert.doesNotMatch(codeOnly(src(file)), /setInterval|setTimeout|backgroundTask|Timer/,
        `${file} 不得有后台定时器`);
    }
  });
});

describe('W6 用户可见文案：首配 / 后果 / 拒绝互不混淆', () => {
  test('首配动作、后果说明、拒绝文案逐字固定，且页面确实渲染它们', () => {
    assert.equal(FIRST_PAIRING_WORDING, '首次配对：确认信任该公告');
    assert.equal(FIRST_PAIRING_DETAIL, '信任后该实例的地址变更才会自动生效');
    assert.equal(REFUSAL_WORDING, '公告不可信，请手动确认');

    const page = src('pages/panes/InstancesPane.ets');
    assert.match(page, /FIRST_PAIRING_WORDING/, '失败行首配按钮引用逐字常量');
    assert.match(page, /FIRST_PAIRING_DETAIL/, '失败行渲染后果说明');
    assert.match(page, /private confirmFirstPairing\(\): void/, '首配有独立确认出口');
    assert.match(page, /private confirmAnnounceManually\(\): void/, '手动确认是另一个出口');
    assert.doesNotMatch(page, /重新配对/, '本模块不提供换钥入口，首配按钮不复用成换钥');
  });
});

describe('W7 结果行按种类渲染：成功不再显示成错误', () => {
  const page = src('pages/panes/InstancesPane.ets');
  const start = page.indexOf('AnnounceNoticeRow()');
  const end = page.indexOf('/** 单行：名称');
  const notice = page.slice(start, end);

  test('种类是显式 @State，并与文案在同一处设置（不从其它字段反推）', () => {
    assert.match(page, /@State announceNoticeKind: AnnounceNoticeKind = ''/);
    assert.match(page, /state === 'refreshed'[\s\S]{0,80}return 'success'/);
    assert.match(page, /state === 'first-pairing-pending' \|\| state === 'awaiting-consent'[\s\S]{0,80}return 'first-pairing'/);
    assert.match(page, /state === 'no-announcement'[\s\S]{0,80}return 'no-announcement'/);
    assert.equal(
      (page.match(/this\.announceNoticeKind = this\.noticeKindOf\(outcome\.state\)/g) || []).length,
      2,
      '两处写 announceNotice 的地方都必须同步写 kind'
    );
    assert.match(notice, /this\.announceNotice\.length > 0 && this\.announceNoticeKind\.length > 0/,
      '没有种类就不渲染结果行');
  });

  test('success / no-announcement ⇒ 中性色且没有任何 CTA', () => {
    assert.match(notice,
      /this\.announceNoticeKind === 'refusal' \? \$r\('app\.color\.danger'\) : \$r\('app\.color\.text_secondary'\)/,
      'danger 只属 refusal；success 与 no-announcement 都走中性色');
    assert.equal((notice.match(/\$r\('app\.color\.danger'\)/g) || []).length, 1,
      '整个结果行只有一处 danger 引用，且在 refusal 守卫的表达式里');
    assert.equal((notice.match(/ActionButton\(/g) || []).length, 2,
      '结果行只有两个 CTA，分别被 first-pairing / refusal 守卫');
    assert.doesNotMatch(notice, /label: this\.pendingAnnounce/,
      'CTA 不再由 pendingAnnounce 反推（否则 success 会误出「手动确认」）');
    assert.doesNotMatch(notice, /this\.announceNoticeKind === 'success'[\s\S]*?ActionButton/,
      'success 分支不得出现 CTA');
  });

  test('refusal ⇒ danger + 手动确认；first-pairing ⇒ 中性 + 确认信任该公告', () => {
    assert.match(notice,
      /if \(this\.announceNoticeKind === 'first-pairing'\) \{[\s\S]*?label: '确认信任该公告'/);
    assert.match(notice,
      /if \(this\.announceNoticeKind === 'refusal'\) \{[\s\S]*?label: '手动确认'/);
    assert.match(notice,
      /if \(this\.announceNoticeKind === 'first-pairing'\) \{[\s\S]*?FIRST_PAIRING_DETAIL/,
      '只有首配显示后果说明');
    assert.doesNotMatch(notice, /if \(this\.announceNoticeKind === 'no-announcement'\) \{[\s\S]*?ActionButton/,
      '无公告没什么可确认，不给 CTA');
  });
});
