// `mod-pairing-badge-truth`：远程打开一次性结果标记的 Node 单测（纯模型 + 源码形状）。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 修的是 REVIEW-instances-pairing-reachability.md m2：
//   监听器停了 / 远程页没建立起来时，「已配对（地址可达，尚未校验证书）」不能一直挂着。
// 传输失败必须沿 RemoteControl → AppStorage 一次性标记 → InstancesPane 的 @StorageLink/@Watch
// 到达 instanceStore.markReachable('fail')；导航成功不再冒充可达性。
//
// 纯模型 `model/remoteOutcome.ts` 零 import，编译产物仍按本仓惯例走 registerHooks。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';
import { matchBrace } from './helpers/etsSource.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  }
});

const O = await import('../.build/model/remoteOutcome.js');

const PANE_URL = new URL('../../entry/src/main/ets/pages/panes/InstancesPane.ets', import.meta.url);
const REMOTE_URL = new URL('../../entry/src/main/ets/pages/RemoteControl.ets', import.meta.url);
const HOME_URL = new URL('../../entry/src/main/ets/pages/Home.ets', import.meta.url);
const MODEL_URL = new URL('../../entry/src/main/ets/model/remoteOutcome.ts', import.meta.url);
const PANE = readFileSync(PANE_URL, 'utf8');
const REMOTE = readFileSync(REMOTE_URL, 'utf8');
const HOME = readFileSync(HOME_URL, 'utf8');
const MODEL = readFileSync(MODEL_URL, 'utf8');

const ID = 'inst-a1b2c3d4e5f60718';
const OTHER_ID = 'inst-0011223344556677';
const NOW = 1_700_000_000_000;

/** 取方法签名之后的花括号内部文本（保留偏移用 matchBrace，位置变了断言也不脆）。 */
function methodBody(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `找不到方法 ${signature}`);
  const [start, end] = matchBrace(source, source.indexOf('{', at));
  return source.slice(start + 1, end - 1);
}

// ------------------------------------------------------------------ A: 纯模型编解码

describe('A. 一次性标记的严格编解码', () => {
  test('A1 常量 / 形状：键名固定，v=1，四字段齐全', () => {
    assert.equal(O.REMOTE_OUTCOME_KEY, 'remote.lastOutcome');
    const encoded = O.encodeRemoteOutcome({ v: 1, instanceId: ID, status: 'fail', at: NOW });
    const parsed = JSON.parse(encoded);
    assert.deepEqual(Object.keys(parsed).sort(), ['at', 'instanceId', 'status', 'v']);
    assert.equal(parsed.v, 1);
  });

  test('A2 encode → decode 往返（ok / fail 两种状态）', () => {
    for (const status of ['ok', 'fail']) {
      const outcome = { v: 1, instanceId: ID, status: status, at: NOW };
      const decoded = O.decodeRemoteOutcome(O.encodeRemoteOutcome(outcome));
      assert.deepEqual(decoded, outcome, `往返必须逐字段相等：${status}`);
    }
  });

  test('A3 一切畸形输入 ⇒ null（fail-closed，不抛）', () => {
    const bad = [
      '',                                                   // 空串
      '   ',                                                // 纯空白
      null, undefined,                                      // 空值
      '{not json',                                          // 坏 JSON
      '[]', '42', '"text"', 'true',                         // 非对象
      JSON.stringify({ v: 2, instanceId: ID, status: 'ok', at: NOW }),          // 未知 v
      JSON.stringify({ v: 1, instanceId: ID, status: 'weird', at: NOW }),       // 未知 status
      JSON.stringify({ v: 1, instanceId: 'inst-xyz', status: 'ok', at: NOW }),  // 坏 id
      JSON.stringify({ v: 1, instanceId: '', status: 'ok', at: NOW }),          // 空 id
      JSON.stringify({ v: 1, instanceId: ID, status: 'ok', at: -1 }),           // 负 at
      JSON.stringify({ v: 1, instanceId: ID, status: 'ok', at: NaN }),          // NaN at
      JSON.stringify({ v: 1, instanceId: ID, status: 'ok', at: '1700' })        // 字符串 at
    ];
    for (const raw of bad) {
      assert.equal(O.decodeRemoteOutcome(raw), null, `畸形输入必须 → null: ${JSON.stringify(raw)}`);
    }
  });

  test('A4 空 id 被 encode 兜住时也解不回来（不产生可应用的半成品）', () => {
    const encoded = O.encodeRemoteOutcome({ v: 1, instanceId: '', status: 'ok', at: NOW });
    assert.equal(O.decodeRemoteOutcome(encoded), null);
  });
});

// ------------------------------------------------------------------ B: 拒绝映射

describe('B. 终局种类 → 可达结论', () => {
  test('B1 六种拒绝终局一律 fail（被拒绝的通道不是可达性）', () => {
    for (const kind of [
      'no-pin', 'not-https', 'permanent-refusal',
      'tls-mismatch', 'chain-unverifiable', 'web-load-error'
    ]) {
      const outcome = O.outcomeForRefusal(kind, ID, NOW);
      assert.equal(O.refusalStatusOf(kind), 'fail', `kind=${kind}`);
      assert.equal(outcome.status, 'fail', `kind=${kind}`);
      assert.equal(outcome.instanceId, ID);
      assert.equal(outcome.at, NOW);
    }
  });

  test('B2 未知 kind 也 fail-closed 到 fail', () => {
    assert.equal(O.refusalStatusOf('something-new'), 'fail');
  });

  test('B3 只有真实加载成功才产生 ok', () => {
    const ok = O.outcomeForLoadSuccess(ID, NOW);
    assert.equal(ok.status, 'ok');
    assert.equal(O.decodeRemoteOutcome(O.encodeRemoteOutcome(ok)).status, 'ok');
  });
});

// ------------------------------------------------------------------ C: 应用判定

describe('C. shouldApplyOutcome（新鲜 / 异 id / 幂等）', () => {
  test('C1 新鲜且 id 匹配 ⇒ true', () => {
    const outcome = O.outcomeForRefusal('web-load-error', ID, NOW);
    assert.equal(O.shouldApplyOutcome(outcome, ID, NOW), true);
    assert.equal(O.shouldApplyOutcome(outcome, ID, NOW + 1000), true);
    // 纯函数重复调用结果不变（真正的一次性由消费者清标记保证）
    assert.equal(O.shouldApplyOutcome(outcome, ID, NOW + 1000),
      O.shouldApplyOutcome(outcome, ID, NOW + 1000));
  });

  test('C2 陈旧标记 ⇒ false（默认窗口 ≤ 120 s）', () => {
    const outcome = O.outcomeForRefusal('no-pin', ID, NOW);
    assert.equal(O.shouldApplyOutcome(outcome, ID, NOW + 120_001), false);
    assert.equal(O.shouldApplyOutcome(outcome, ID, NOW + 120_000), true);
    // 传入的 maxAgeMs 不得把窗口放宽到 120 s 以上
    assert.equal(O.shouldApplyOutcome(outcome, ID, NOW + 120_001, 999_999), false);
    assert.equal(O.shouldApplyOutcome(outcome, ID, NOW + 5_000, 5_000), true);
    assert.equal(O.shouldApplyOutcome(outcome, ID, NOW + 5_001, 5_000), false);
  });

  test('C3 异 id / 空 id / null / 时钟回拨 ⇒ false', () => {
    const outcome = O.outcomeForRefusal('not-https', ID, NOW);
    assert.equal(O.shouldApplyOutcome(outcome, OTHER_ID, NOW), false);
    assert.equal(O.shouldApplyOutcome(outcome, '', NOW), false);
    assert.equal(O.shouldApplyOutcome(null, ID, NOW), false);
    assert.equal(O.shouldApplyOutcome(outcome, ID, NOW - 1), false, '未来戳（时钟回拨）不应用');
    assert.equal(O.shouldApplyOutcome(
      { v: 1, instanceId: ID, status: 'weird', at: NOW }, ID, NOW), false);
  });
});

// ------------------------------------------------------------------ D: 源码形状守卫

describe('D. InstancesPane：保活安全的消费者（不是 onPageShow）', () => {
  test('D1 用 @StorageLink(REMOTE_OUTCOME_KEY) + @Watch(\'onRemoteOutcome\') 绑定', () => {
    assert.match(PANE,
      /@StorageLink\(REMOTE_OUTCOME_KEY\)\s+@Watch\('onRemoteOutcome'\)\s+lastOutcome:\s*string\s*=\s*'';/,
      '必须是 AppStorage 绑定 + @Watch，不能是页面生命周期');
    assert.match(PANE, /import\s*\{[^}]*REMOTE_OUTCOME_KEY[^}]*\}\s*from\s*'\.\.\/\.\.\/model\/remoteOutcome'/);
  });

  test('D2 watcher 完整链路：decode → shouldApply → markReachable → reload → 恰好清一次', () => {
    const body = methodBody(PANE, 'onRemoteOutcome(): void');
    assert.match(body, /decodeRemoteOutcome\(raw\)/, '必须解码');
    assert.match(body, /shouldApplyOutcome\(outcome, outcome\.instanceId, nowMs\)/, '必须判新鲜 / 归属');
    assert.match(body, /instanceStore\.markReachable\(outcome\.instanceId, outcome\.status, nowMs\)/,
      '必须把终局写回实例表');
    assert.match(body, /this\.reload\(\)/, '必须刷新渲染行');
    assert.equal((body.match(/AppStorage\.setOrCreate<string>\(REMOTE_OUTCOME_KEY, ''\)/g) ?? []).length, 1,
      '标记恰好清一次');
    assert.match(body, /if \(raw\.length === 0\) \{[\s\S]{0,40}return;/, '空串早退，挡住清空回写的二次 watch');
  });

  test('D3 onPageShow 不消费结果标记；Home 也不给面板传刷新 tick', () => {
    const pageShow = methodBody(PANE, 'onPageShow(): void');
    for (const needle of ['lastOutcome', 'decodeRemoteOutcome', 'shouldApplyOutcome',
      'markReachable', 'REMOTE_OUTCOME_KEY']) {
      assert.equal(pageShow.includes(needle), false, `消费路径不得挂在 onPageShow：${needle}`);
    }
    const homeCall = HOME.slice(HOME.indexOf('InstancesPane({'), HOME.indexOf('CloudChatPane({'));
    assert.ok(homeCall.length > 0, 'Home 的分段装配点必须存在');
    assert.match(homeCall, /InstancesPane\(\{[\s\S]*active: this\.section === SHELL_SECTION_INSTANCES/);
    assert.equal(/Tick|tick|lastOutcome|REMOTE_OUTCOME/.test(homeCall), false,
      'Home 没有给 InstancesPane 传任何刷新 tick，证明 @Watch 是唯一机制');
  });

  test('D4 导航成功不再标 ok；pushUrl 失败的 fail 分支仍在', () => {
    const body = methodBody(PANE, 'private openInstance(view: RedactedInstance): void');
    assert.match(body, /router[\s\S]*pushUrl\(\{ url: routeToRemote\(\), params: params \}\)/,
      '仍走原来的路由');
    assert.equal(/markReachable\(view\.id, 'ok', Date\.now\(\)\)/.test(body), false,
      'router.pushUrl 成功不是可达性，绝不再写 ok（原 :314 调用已删）');
    assert.equal(/\.then\(/.test(body), false, '不再有导航成功回调');
    assert.match(body, /\.catch\(\(\): void => \{[\s\S]*instanceStore\.markReachable\(view\.id, 'fail', Date\.now\(\)\)/,
      '跳转抛错的 fail 分支必须保留');
  });

  test('D5 三条 pinned 徽章文案逐字不变（迁到纯模型）；过度承诺文案绝迹', () => {
    // mod-pairing-badge-pin-guard（retarget，不放宽）：文案从面板内联映射迁到 model/pairingBadge.ts，
    // 三条 pinned 逐字节不变；面板改为调用 badgeOf，且不再复制任何一条（无第二份拷贝）。
    const badgeSrc = readFileSync(new URL('../../entry/src/main/ets/model/pairingBadge.ts', import.meta.url), 'utf8');
    assert.equal(badgeSrc.includes('PAIRING_REACHABLE_WORDING'), true);
    assert.equal(badgeSrc.includes('已配对（当前不可连接）'), true);
    assert.equal(badgeSrc.includes('已配对（尚未探测地址可达性）'), true);
    assert.match(PANE, /badgeOf\(full\)/, '面板必须经纯函数取徽章');
    assert.equal(PANE.includes('已配对（'), false, '面板不得复制任何 pinned 文案');
    for (const [label, text] of [['InstancesPane.ets', PANE], ['RemoteControl.ets', REMOTE],
      ['remoteOutcome.ts', MODEL]]) {
      for (const bad of ['已配对（已校验可连接）', '防中间人', '已验证身份', '已配对（已验证可连接）']) {
        assert.equal(text.includes(bad), false, `${label} 不得出现过度承诺文案「${bad}」`);
      }
    }
  });
});

describe('E. RemoteControl：每次尝试只写一次，失败一律 fail', () => {
  test('E1 写口有 guard 标志，且一次尝试只 setOrCreate 一次', () => {
    assert.match(REMOTE, /private outcomeWritten: boolean = false;/, '必须有私有 guard 标志');
    const write = methodBody(REMOTE, 'private writeOutcome(outcome: RemoteOutcome): void');
    assert.match(write, /if \(this\.outcomeWritten \|\| outcome\.instanceId\.length === 0\)/,
      'guard + 无 id 早退');
    assert.equal((write.match(/AppStorage\.setOrCreate<string>\(REMOTE_OUTCOME_KEY, encodeRemoteOutcome\(outcome\)\)/g) ?? []).length, 1,
      '唯一写口');
    assert.match(write, /this\.outcomeWritten = true;/, '写后置位，重渲染不重复写');
    assert.match(REMOTE, /import\s*\{[^}]*REMOTE_OUTCOME_KEY[^}]*\}\s*from\s*'\.\.\/model\/remoteOutcome'/);
  });

  test('E2 新尝试重置 guard（applyAddress 与真正执行的 refresh）', () => {
    const apply = methodBody(REMOTE, 'private applyAddress(raw: string): void');
    assert.match(apply, /this\.outcomeWritten = false;/, '每次地址解析都是新尝试');
    const refresh = methodBody(REMOTE, 'private refresh(): void');
    assert.match(refresh, /if \(this\.tlsBlocked\)[\s\S]*return;/, '证书拒绝不静默重试');
    assert.match(refresh, /this\.outcomeWritten = false;/, '真正 reload 才算新尝试');
  });

  // retarget（mod-remote-page-webview）：http 现在按明文标签正常 load，「非 https 永久拒绝」
  // 分支不存在了；https 的失败终局改为「无 pin（applyAddress 内）」与「预检失败（preflight 内）」
  // 两条，二者仍统一经 refuse()→reportRefusal() 落到 fail。旧断言逐条改为钉新位置，未删。
  test('E3 无 pin / 预检失败两条分支都报 fail（旧「非 https」分支已不存在）', () => {
    const apply = methodBody(REMOTE, 'private applyAddress(raw: string): void');
    assert.match(apply, /this\.refuse\('no-pin'\)/);
    assert.equal(apply.includes('not-https'), false, 'http 明文现在正常 load，不再有非 https 拒绝分支');
    const preflight = methodBody(REMOTE, 'private async preflight(addr: HostPortCheck, pin: string): Promise<void>');
    assert.match(preflight, /'permanent-refusal'/, '预检请求失败仍是永久拒绝');
    assert.match(preflight, /'tls-mismatch'/, '指纹不匹配仍是 TLS 拒绝');
    assert.match(REMOTE, /private refuse\(kind: RemoteRefusalKind\): void[\s\S]*this\.reportRefusal\(kind\)/,
      '两条分支共用一个 reportRefusal 出口');
  });

  // retarget（同上）：SSL 回调不再重复读 pin，只消费一次性放行凭据；终局仍 fail。
  test('E4 TLS / Web 终局报 fail，只有 onPageEnd 报 ok', () => {
    const ssl = methodBody(REMOTE, 'private handleSslError(event: OnSslErrorEventReceiveEvent): void');
    assert.match(ssl, /sslConsume\(this\.allowanceKey\(\), Date\.now\(\)\)/,
      '只有一次性放行凭据命中才 handleConfirm');
    assert.match(ssl, /this\.refuse\('tls-mismatch'\)/, '放行凭据失效按 tls-mismatch 落 fail');
    assert.match(ssl, /handleConfirm\(\)/);
    assert.match(ssl, /handleCancel\(true\)/);
    const count = (REMOTE.match(/this\.reportRefusal\('web-load-error'\)/g) ?? []).length;
    assert.equal(count, 2, 'onErrorReceive + onHttpErrorReceive 都报 web-load-error');
    assert.match(REMOTE, /\.onPageEnd\(\(\) => \{[\s\S]{0,300}this\.reportLoadSuccess\(\);/,
      'ok 只来自真正的页面加载完成');
  });

  // retarget（同上）：旧「页面必须出现硬拒绝句一次」转红，改为「页面 0 命中 + 命令面板接线 0 命中」。
  // 命令通道的诚实原因仍由 composer 的闸门 wording 承载（组件级断言在 remoteCommandComposer.test.mjs）。
  // 再 retarget（mod-app-remote-page-pure）：产品决定把「发指令到这台电脑」整块下架，页面不再挂载
  // composer，也不再 import 它；同一处切片、同一份计数，期望值由 1 变 0（精确计数，不是放宽）。
  test('composer 已从远程页下架（0 次挂载 / 0 次 import）；旧页面级凭据拒绝句仍绝迹', () => {
    assert.equal((REMOTE.match(/RemoteCommandComposer\(\{/g) ?? []).length, 0,
      '发指令面板下架后 composer 挂载 0 次');
    assert.equal(REMOTE.includes('RemoteCommandComposer'), false,
      '远程页不得再 import RemoteCommandComposer');
    assert.equal(REMOTE.includes('安全连接尚未启用'), false);
    assert.equal(REMOTE.includes('未向电脑发送凭据'), false);
    assert.match(REMOTE, /instanceIdFromUrl\(this\.url\)/, '唯一 URL→id 派生仍在');
  });
});
