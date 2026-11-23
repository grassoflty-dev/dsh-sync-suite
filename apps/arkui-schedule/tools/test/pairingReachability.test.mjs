// mod-pairing-reachability（配对前真实可达性探测）的 Node 单测。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 纪律：pairing 是「本地写 + 探针实验」，不是「写一行就说配对成功」。
//  - R1 探针 OK ⇒ 落一行、钉住指纹、可达态由探针实验；
//  - R2/R3 未分类失败 / 超时 ⇒ typed 码 + 整表字节不变 + 不产行 / 不写 pin；
//    未分类失败用中性文案，不冒充 ECONNREFUSED；超时才用专属文案；
//  - R4 TLS 指纹不一致 ⇒ 独立 typed 码（握手未接入，这里只验纯决策接缝）；
//  - R5 源码形状：探针在 instanceStore 写盘**之前**；失败不清粘贴框；
//    成功文案逐字为「已配对（地址可达，尚未校验证书）」（TCP 可达 ≠ 证书身份已校验）；
//  - R6 坏载荷在探针之前被拒，零网络调用 / 零写入；
//  - R7 超时上限 ≤ 3 s，真实传输用 @kit.NetworkKit 的 socket 且异步不阻塞 UI。
//
// 这些用例在「今天的代码」上必然失败：`model/pairingProbe.ts` 与新 typed 码尚不存在。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

// tsc 以 bundler 模式发出无扩展名的相对 import；Node ESM 需要 `.js`。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  }
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../entry/src/main/ets');

const P = await import('../.build/model/pairingPayload.js');
const Q = await import('../.build/model/pairingProbe.js');
const I = await import('../.build/model/instances.js');

function src(relative) {
  return readFileSync(resolve(SRC, relative), 'utf8');
}

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const FP_A = 'aa'.repeat(32);
const FP_A_CANON = Array.from({ length: 32 }, () => 'AA').join(':');

function json(overrides = {}) {
  return JSON.stringify({
    v: 1, instanceId: 'gwl-pc', transport: 'lan', host: '192.168.1.6', port: 44996,
    token: TOKEN, tlsFingerprint: FP_A, announceRef: '', ...overrides
  });
}

/** 假 TCP/TLS 接缝：记录每次调用的 host/port/timeout，返回可编排的状态。 */
function fakeTransport(status) {
  const calls = [];
  const fn = async (host, port, timeoutMs) => {
    calls.push({ host: host, port: port, timeoutMs: timeoutMs });
    return { status: status };
  };
  return { fn: fn, calls: calls };
}

/**
 * 内存实例表的**字节级**接缝：复刻 instanceStore 的「只有 result.ok 才整表写回」纪律。
 * bytes 是持久化信封的真实字节；零写入断言直接比较它，不比较对象引用。
 */
function storeSeam(initialItems = []) {
  let bytes = I.encodeInstances(initialItems);
  return {
    get bytes() {
      return bytes;
    },
    async add(text, probe) {
      const decoded = I.decodeInstances(bytes);
      const result = await P.addPairedInstanceWithProbe(decoded.items, text, probe);
      if (result.ok) {
        bytes = I.encodeInstances(result.items);
      }
      return result;
    }
  };
}

// ------------------------------------------------------------------ R1 探针 OK

describe('R 配对前可达性探测', () => {
  test('R1 探针 OK ⇒ 落一行、钉住指纹、可达态由探针实验（不是 unknown）', async () => {
    const fake = fakeTransport('ok');
    const store = storeSeam([]);
    const before = store.bytes;

    const result = await store.add(json(), fake.fn);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.code, 'ok');
    assert.equal(result.reason, P.PAIRING_REACHABLE_WORDING,
      '成功文案必须逐字说明「地址可达，尚未校验证书」');
    assert.equal(result.reason.includes('已验证'), false, 'TCP 可达不得写成已验证（会被读成身份校验）');
    assert.match(result.reason, /地址可达/, '必须点名验证的是地址可达');
    assert.match(result.reason, /尚未校验证书/, '必须显式声明证书未校验');
    assert.equal(result.items.length, 1, '只落一行');
    assert.equal(result.items[0].pairingInstanceId, 'gwl-pc');
    assert.equal(result.items[0].tlsFingerprint, FP_A_CANON, '探针通过后照常钉住指纹');
    assert.equal(result.items[0].reachable, 'ok', '探针实验过的行不能停在 unknown');
    assert.notEqual(store.bytes, before, '成功路径必须整表写回');
    assert.equal(I.decodeInstances(store.bytes).items.length, 1);

    assert.equal(fake.calls.length, 1, '必须真的调用探针一次');
    assert.equal(fake.calls[0].host, '192.168.1.6');
    assert.equal(fake.calls[0].port, 44996);
    assert.ok(fake.calls[0].timeoutMs > 0 && fake.calls[0].timeoutMs <= 3000, '超时必须 ≤ 3 s');
  });

  test('R2 未分类连接失败 ⇒ E_PAIRING_UNREACHABLE + 中性文案 + 整表字节不变 + 不产行 / 不写 pin', async () => {
    const fake = fakeTransport('unreachable');
    const store = storeSeam([]);
    const before = store.bytes;

    const result = await store.add(json(), fake.fn);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PAIRING_UNREACHABLE', '必须是独立 typed 码');
    assert.equal(result.reason, '无法连接到该地址（44996）：连接被拒绝或地址不可达',
      '无错误码判别时只能给中性文案；点名端口，不回显 host / token / 指纹');
    assert.equal(result.reason.includes('连接被拒绝（'), false, '不得单独断言「连接被拒绝」');
    assert.match(result.reason, /连接被拒绝或地址不可达/, '必须同时保留两种可能');
    assert.deepEqual(result.items, [], '失败路径不产出半行');
    assert.equal(store.bytes, before, '零写入：持久化信封逐字节不变');
    assert.equal(I.decodeInstances(store.bytes).items.length, 0, '没有 healthy 行');
    assert.equal(JSON.stringify(store.bytes).includes(FP_A), false, 'pin 没有被写进去');
    assert.equal(fake.calls.length, 1);
  });

  test('R3 超时 ⇒ 同一 typed 类、独立「连接超时」文案、同样零写入', async () => {
    const fake = fakeTransport('timeout');
    const seeded = storeSeam([]);
    const beforeSeed = seeded.bytes;
    const ok = await seeded.add(json(), fakeTransport('ok').fn);
    assert.equal(ok.ok, true, '前置：先有一行 healthy 实例');
    const before = seeded.bytes;

    const result = await seeded.add(json({ port: 45000 }), fake.fn);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PAIRING_UNREACHABLE');
    assert.equal(result.reason, '无法连接到该地址：连接超时（45000）');
    assert.notEqual(result.reason,
      Q.pairingUnreachableWording('unreachable', 45000), '超时文案必须与中性失败文案不同');
    assert.deepEqual(result.items, []);
    assert.equal(seeded.bytes, before, '已有行的 pin / 地址逐字节不变');
    assert.notEqual(seeded.bytes, beforeSeed, '前置行仍在（这次失败没有删掉它）');
  });

  test('R4 TLS 指纹不一致（接缝级；TLS 握手尚未接入）⇒ 独立 typed 码，不落行', async () => {
    const fake = fakeTransport('tls-mismatch');
    const store = storeSeam([]);
    const before = store.bytes;
    const result = await store.add(json(), fake.fn);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PAIRING_TLS_MISMATCH', '指纹不同不得混成 E_PAIRING_UNREACHABLE');
    assert.equal(result.reason, Q.PAIRING_TLS_MISMATCH_WORDING);
    assert.deepEqual(result.items, []);
    assert.equal(store.bytes, before, '零写入');
  });

  test('R5 坏载荷在探针之前就被拒：零网络调用 + 零写入', async () => {
    const fake = fakeTransport('ok');
    const store = storeSeam([]);
    const before = store.bytes;
    const result = await store.add('{bad json', fake.fn);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PAIRING_MALFORMED');
    assert.equal(fake.calls.length, 0, '坏载荷不许发网络请求');
    assert.equal(store.bytes, before);
  });

  test('R6 探针异常（传输抛错）也失败关闭，绝不把异常当配对成功', async () => {
    const store = storeSeam([]);
    const before = store.bytes;
    const throwing = async () => {
      throw new Error('boom');
    };
    const result = await store.add(json(), throwing);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PAIRING_UNREACHABLE');
    assert.deepEqual(result.items, []);
    assert.equal(store.bytes, before, '零写入');
  });
});

// ------------------------------------------------------------------ R7 源码形状

describe('R7 源码形状：探针在写盘之前 / 粘贴框保留 / 真实 socket 传输', () => {
  const STORE = src('services/instanceStore.ets');
  const PAGE = src('pages/panes/InstancesPane.ets');
  const MODEL = src('model/pairingPayload.ts');
  const PROBE = src('model/pairingProbe.ts');
  const SERVICE = src('services/pairingProbeService.ets');

  test('R7-1 store 的 addByPairing：先 await 探针，后 commit，且 commit 被 result.ok 守卫', () => {
    const start = STORE.indexOf('async addByPairing(');
    assert.ok(start >= 0, 'store 必须提供异步配对入口');
    const body = STORE.slice(start, STORE.indexOf('\n  }', start));
    const probeAt = body.indexOf('addPairedInstanceWithProbe(');
    const commitAt = body.indexOf('this.commit(');
    assert.ok(probeAt >= 0 && commitAt > probeAt, '探针调用必须在写盘之前');
    assert.match(body, /if \(result\.ok\) \{[\s\S]{0,120}this\.commit\(/, '只有探针通过才写盘');
  });

  test('R7-2 纯模型：probePairingTarget 在 addPairedInstance 之前，失败路径 items 为空', () => {
    const start = MODEL.indexOf('export async function addPairedInstanceWithProbe(');
    assert.ok(start >= 0, '纯模型必须导出带探针的新增入口');
    const body = MODEL.slice(start, MODEL.indexOf('\n}', start));
    const probeAt = body.indexOf('await probePairingTarget(');
    const addAt = body.indexOf('addPairedInstance(list, text)');
    assert.ok(probeAt >= 0 && addAt > probeAt, '必须先探活再构造落表结果');
    assert.match(body, /if \(!outcome\.ok\) \{[\s\S]{0,320}addFail\(/, '探针失败走 addFail');
    assert.match(body, /outcome\.code === 'E_PAIRING_TLS_MISMATCH'/,
      'typed 码必须显式投影（ArkTS 不做跨联合分支收窄）');
  });

  test('R7-3 UI：添加按钮 await 配对入口；失败保留粘贴原文；成功只说地址可达且证书未校验', () => {
    const start = PAGE.indexOf('private async addByPairing(): Promise<void> {');
    assert.ok(start >= 0, 'UI 的添加出口必须是异步的（探针不阻塞 UI 线程）');
    const body = PAGE.slice(start, PAGE.indexOf('\n  }', start));
    assert.match(body, /await instanceStore\.addByPairing\(/, '页面必须 await 带探针的 store 入口');
    const failureAt = body.indexOf('if (!result.ok)');
    const clearAt = body.indexOf('this.pairingText = \'\'');
    assert.ok(failureAt >= 0 && clearAt > failureAt, '失败分支在前，且粘贴框清空只发生在成功之后');
    assert.match(body, /return;/, '失败分支必须直接返回，不清空粘贴框');
    // mod-pairing-badge-pin-guard（retarget，不放宽）：成功提示仍逐字用 store 返回的 typed 原因；
    // 常量继续由配对模型持有，面板不再内联引用它（徽章已交给纯函数 badgeOf）。
    assert.match(body, /promptAction\.showToast\(\{ message: result\.reason/,
      '成功提示必须逐字用 store 的 typed 原因，不在页面里另写文案');
    assert.equal(P.PAIRING_REACHABLE_WORDING, '已配对（地址可达，尚未校验证书）',
      '成功文案常量必须仍由 pairingPayload.ts 持有且逐字节不变');
    assert.match(PAGE, /badgeOf\(full\)/, '配对行徽章必须交由纯函数，不再内联取常量');
    assert.equal(PAGE.includes('已配对（已验证可连接）'), false, '旧的裸「已验证」成功文案必须绝迹');
    assert.equal(PAGE.includes('已配对（尚未验证可连接）'), false, '旧的裸「未验证」文案必须绝迹');
    assert.match(PAGE, /busy: this\.pairingBusy/, '探测期间按钮进入 busy，防重复点击');
  });

  test('R7-4 纯探针：超时上限 ≤ 3 s；TLS 模式当前为 tcp（指纹只存不验）', () => {
    assert.match(PROBE, /PAIRING_PROBE_TIMEOUT_MS: number = 3000/, '硬超时必须写在纯探针里');
    assert.match(PROBE, /export const PAIRING_PROBE_MODE: 'tcp' \| 'tls' = 'tcp'/,
      '当前实现必须逐字声明 TCP；TLS 握手未接入');
    assert.match(PROBE, /void expectedFingerprint;/, 'TCP 模式下指纹只存不验，不能假装比对过');
    assert.match(PROBE, /可达性（TCP）≠ 配对真实性（TLS 指纹）/,
      '源码注释必须点明 TCP 可达 ≠ TLS 身份真实，真实性由 TLS 模块 gate');
    assert.match(PROBE, /配对真实性由 TLS 模块 gate/, '未来读者必须看到真实性归 TLS lane');
  });

  test('R7-5 真实传输：@kit.NetworkKit socket + 硬超时 watchdog，纯异步 Promise', () => {
    assert.match(SERVICE, /import \{ socket \} from '@kit\.NetworkKit'/, '必须走系统 socket 出口');
    assert.match(SERVICE, /constructTCPSocketInstance\(\)/, '必须是真 TCP connect，不是伪探针');
    assert.match(SERVICE, /timeout:/, 'connect 必须带系统级超时');
    assert.match(SERVICE, /setTimeout\(/, '还要有应用层 watchdog，防止 SDK 不守时');
    assert.match(SERVICE, /new Promise<PairingProbeTransportResult>/, '全程 Promise，不阻塞 UI 线程');
    assert.match(SERVICE, /settle\('unreachable'\)/, 'SDK 拒绝落中性 unreachable，不冒充 ECONNREFUSED');
    assert.equal(SERVICE.includes("settle('refused')"), false, '真实传输不得使用暗示已分类的 refused');
    assert.equal(/console\./.test(SERVICE), false, '真实传输不得打印地址 / 载荷');
  });

  test('R7-6 typed 码进入公共错误码表；失败文案不回显 host / token / 指纹', () => {
    const model = src('model/pairingPayload.ts');
    const modelProbe = src('model/pairingProbe.ts');
    assert.match(model, /E_PAIRING_UNREACHABLE/, 'typed 码进入 PairingErrorCode');
    assert.match(model, /E_PAIRING_TLS_MISMATCH/, 'TLS 冲突也进入 typed 码表');
    for (const [name, text] of [['model/pairingPayload.ts', model], ['model/pairingProbe.ts', modelProbe]]) {
      assert.equal(/console\./.test(text), false, `${name} 不得用 console.* 回显载荷 / 令牌`);
    }
    const neutral = Q.pairingUnreachableWording('unreachable', 44996);
    const timeout = Q.pairingUnreachableWording('timeout', 44996);
    assert.equal(neutral, '无法连接到该地址（44996）：连接被拒绝或地址不可达');
    assert.equal(neutral.includes('连接被拒绝（'), false, '未分类失败不得单独断言「被拒绝」');
    assert.equal(timeout, '无法连接到该地址：连接超时（44996）');
    assert.notEqual(timeout, neutral, '超时必须与中性失败逐字不同');
    assert.equal(P.PAIRING_REACHABLE_WORDING, '已配对（地址可达，尚未校验证书）');
    assert.equal(P.PAIRING_REACHABLE_WORDING.includes('已验证'), false, '成功文案不得裸写「已验证」');
    for (const secret of ['192.168.1.6', TOKEN, FP_A]) {
      assert.equal(neutral.includes(secret), false);
      assert.equal(timeout.includes(secret), false);
    }
  });
});
