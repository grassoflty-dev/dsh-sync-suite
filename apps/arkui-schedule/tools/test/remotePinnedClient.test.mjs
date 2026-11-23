// mod-remote-pinned-client（RC-3 核心）：Node 级门禁。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型 model/remotePinnedClient.ts 零 SDK import，编译产物可直接被 Node 加载。
// 本文件只用「合成凭证」，不含任何真实 token / PEM / 证书值；断言只报存在性与计数。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../..');
const REPO = resolve(APP, '../..');
const SRC = resolve(APP, 'entry/src/main/ets');
const M = await import('../.build/model/remotePinnedClient.js');

// 只看代码，不把注释/文案里提到的 API 名称算作调用。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const {
  PIN_REFUSAL_WORDING,
  normalizePin,
  constantTimeEqualHex,
  pemToDer,
  verifyLeafPin,
  safeVerifyPinnedLeaf,
  buildPinnedRequestPlan,
  classifyPinnedResponse,
  executePinnedRequest,
  parsePinnedCards,
} = M;

/** 仅用于断言的合成凭证（不是任何真实 token）。 */
const SYNTH = 'SYNTHETIC-BEARER-RC3-TEST-ONLY';
const HOST = 'remote.example.test';
const IP = '10.0.0.7';

const DER_A = Uint8Array.from(Buffer.from('rc3-leaf-der-matched', 'utf8'));
const DER_B = Uint8Array.from(Buffer.from('rc3-leaf-der-wrong-leaf', 'utf8'));
const pinOf = (der) => createHash('sha256').update(der).digest('hex');

function baseInput(overrides = {}) {
  return {
    host: HOST,
    ip: IP,
    expectedHost: HOST,
    expectedIp: IP,
    expectedPin: pinOf(DER_A),
    leaves: [{ der: DER_A, source: 'pem' }],
    chainShape: { x509Count: 1, pemCount: 1 },
    leafOrderProven: true,
    ...overrides,
  };
}

describe('A. verifyPinnedLeaf 语义（stub 级全覆盖）', () => {
  test('match ⇒ true', () => {
    assert.equal(safeVerifyPinnedLeaf(baseInput()), true);
  });

  test('wrong leaf ⇒ false，且是 typed E_PIN_MISMATCH（PEM-only 候选）', () => {
    const out = verifyLeafPin(baseInput({ leaves: [{ der: DER_B, source: 'pem' }] }));
    assert.equal(out.ok, false);
    assert.equal(out.refusal.code, 'E_PIN_MISMATCH');
    assert.equal(safeVerifyPinnedLeaf(baseInput({ leaves: [{ der: DER_B, source: 'pem' }] })), false);
  });

  test('exception ⇒ false（hash 抛异常也被吞成 fail-closed）', () => {
    const out = verifyLeafPin(baseInput(), {
      hash: () => { throw new Error('boom'); },
    });
    assert.equal(out.ok, false);
    assert.equal(out.refusal.code, 'E_VERIFY_EXCEPTION');
    assert.equal(safeVerifyPinnedLeaf(baseInput(), { hash: () => { throw new Error('boom'); } }), false);
  });

  test('ambiguous chain ⇒ false（PEM-only 设计：任一表示多证书即无法唯一确定 leaf）', () => {
    const out = verifyLeafPin(baseInput({
      chainShape: { x509Count: 2, pemCount: 2 },
      leaves: [{ der: DER_A, source: 'pem' }, { der: DER_B, source: 'pem' }],
    }));
    assert.equal(out.ok, false);
    assert.equal(out.refusal.code, 'E_CHAIN_AMBIGUOUS');
  });

  test('只有 x509Certs、没有 PEM 字节 ⇒ E_CHAIN_MISSING（x509 只作形状信号）', () => {
    const out = verifyLeafPin(baseInput({
      chainShape: { x509Count: 1, pemCount: 0 },
      leaves: [],
    }));
    assert.equal(out.ok, false);
    assert.equal(out.refusal.code, 'E_CHAIN_MISSING');
  });

  test('missing / empty / 非 Uint8Array leaf ⇒ false', () => {
    for (const leaves of [[], [new Uint8Array(0)], [null], [{}]]) {
      const out = verifyLeafPin(baseInput({ leaves }));
      assert.equal(out.ok, false, `leaves=${JSON.stringify(leaves.map((x) => x === null ? 'null' : typeof x))}`);
      assert.ok(['E_CHAIN_MISSING', 'E_LEAF_UNREADABLE'].includes(out.refusal.code));
    }
  });

  test('leaf 顺序未真机证实 ⇒ false（E_LEAF_ORDER_UNPROVEN，不因「通常第一个是 leaf」放行）', () => {
    const out = verifyLeafPin(baseInput({ leafOrderProven: false }));
    assert.equal(out.ok, false);
    assert.equal(out.refusal.code, 'E_LEAF_ORDER_UNPROVEN');
  });

  test('host / ip 白名单不符 ⇒ false', () => {
    assert.equal(verifyLeafPin(baseInput({ host: 'attacker.example.test' })).refusal.code, 'E_HOST_MISMATCH');
    assert.equal(verifyLeafPin(baseInput({ ip: '192.0.2.9' })).refusal.code, 'E_IP_MISMATCH');
  });

  test('pin 缺失/坏值 ⇒ false（空串绝不等于任意匹配）', () => {
    for (const bad of ['', 'AA:BB', null, undefined, 42, 'z'.repeat(64)]) {
      const out = verifyLeafPin(baseInput({ expectedPin: bad }));
      assert.equal(out.ok, false, `pin kind=${typeof bad}`);
      assert.equal(out.refusal.code, 'E_NO_PIN');
    }
  });

  test('normalizePin / 恒定时间比较：冒号大小写可归一，长度与逐字节都参与', () => {
    const hex = pinOf(DER_A);
    assert.equal(normalizePin(hex.toUpperCase().match(/.{2}/g).join(':')), hex);
    assert.equal(constantTimeEqualHex(hex, hex), true);
    assert.equal(constantTimeEqualHex(hex, pinOf(DER_B)), false);
    assert.equal(constantTimeEqualHex(hex, hex.slice(0, 63) + '0'), false);
  });

  test('pemToDer 与 Node base64 解码逐字节一致；坏输入返回 null', () => {
    const b64 = Buffer.from(DER_A).toString('base64');
    const pem = `-----BEGIN CERTIFICATE-----\n${b64.replace(/(.{16})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
    assert.deepEqual(Array.from(pemToDer(pem)), Array.from(DER_A));
    assert.equal(pemToDer('not base64 @@@'), null);
    assert.equal(pemToDer(''), null);
  });
});

describe('B. header-only：URL 无凭证，header 是唯一载体', () => {
  const plan = buildPinnedRequestPlan({
    url: `https://${HOST}/api/remote/state`,
    host: HOST,
    authorization: `Bearer ${SYNTH}`,
    expectedPin: pinOf(DER_A),
    expectedIp: IP,
    leafOrderProven: true,
  });

  test('凭证不出现在 URL；header 对象里恰好一次', () => {
    assert.equal(plan.url.includes(SYNTH), false);
    assert.equal(plan.options.header['Authorization'], `Bearer ${SYNTH}`);
    const serialized = JSON.stringify(plan.options);
    assert.equal(serialized.split(SYNTH).length - 1, 1, 'header 对象只能是唯一载体');
  });

  test('no-follow / no-proxy / 校验标记固定在计划里', () => {
    assert.equal(plan.options.maxRedirects, 0);
    assert.equal(plan.options.usingProxy, false);
    assert.equal(plan.options.remoteValidation, 'verifyPinnedLeaf');
    assert.equal(plan.options.method, 'POST');
  });

  test('任何 typed 拒绝文案与错误分类串都不含凭证', () => {
    for (const wording of Object.values(PIN_REFUSAL_WORDING)) {
      assert.equal(wording.includes(SYNTH), false);
    }
    const refused = classifyPinnedResponse({ responseCode: 0, location: '', body: '', errorCode: 2300060 });
    assert.equal(refused.kind, 'refused');
    assert.equal(refused.refusal.code, 'E_PIN_REJECTED');
    assert.equal(JSON.stringify(refused).includes(SYNTH), false);
    const transportFail = classifyPinnedResponse({ responseCode: 0, location: '', body: '', errorCode: -173 });
    assert.equal(JSON.stringify(transportFail).includes(SYNTH), false, '不得把可能带 token 的 error.message 拼进文案');
  });

  // retarget（mod-pinned-view-removal）：本模块删除了 components/PinnedRemoteView.ets（死渲染器，
  // 零 importer / 从未进 entry 图 / abc 命中 0）。它原是本用例的第三个 source，文件已不存在，
  // 故从 source 列表移除——stripComments 后它只有 Text/List/ForEach，对下列断言本无贡献。
  // 安全断言不删、不放宽：adapter + model 仍是被删除后唯一承载「pinned 原生路径不带凭证走 WebView」的源码。
  test('源码形态：无 handleConfirm / 无 loadUrl 携带凭证 / 唯一请求构造点（含 release 排除锚点）', () => {
    const adapter = stripComments(readFileSync(resolve(SRC, 'services/remotePinnedClient.ets'), 'utf8'));
    const model = stripComments(readFileSync(resolve(SRC, 'model/remotePinnedClient.ts'), 'utf8'));
    const all = adapter + model;
    assert.equal(all.includes('handleConfirm('), false, '绝不调用 SSL 错误处理放行接口');
    assert.equal(/loadUrl\([^)]*SYNTH/i.test(all), false);
    assert.equal(all.match(/loadUrl\(/g)?.length ?? 0, 0, 'pinned client 路径不挂 WebView');
    assert.equal(adapter.match(/http\.createHttp\(\)/g)?.length, 1, '带凭证请求恰好一个构造点');
    assert.equal(adapter.match(/\.request\(url, httpOptions\)/g)?.length, 1, '构造点里恰好一次 request 调用');
    assert.equal(adapter.includes('maxRedirects: 0'), true);
    assert.equal(adapter.includes('getEncoded('), false, '同步判定只走 PEM，不在回调里读异步 DER');

    // RC-3 release 排除锚点：release 产物里不得含 debug harness。脚本默认以 absent 断言 sentinel，
    // 把「release 构建不携带被排除的调试/凭证路径」从意图变成可跑的检查（独立 gate 另验产物）。
    const exclusion = readFileSync(resolve(APP, 'tools/check-rc3-release-exclusion.mjs'), 'utf8');
    assert.match(exclusion, /PIN-ATTACK-01/, '排除脚本必须钉住 debug sentinel');
    assert.match(exclusion, /expect\s*===\s*'absent'\s*\?\s*count\s*===\s*0/, '默认必须断言 sentinel 缺席');
  });
});

describe('C. 受控 302 fixture：目标端零凭证请求', () => {
  const DEST = 'https://owned-redirect-target.example.test/collect';
  const plan = buildPinnedRequestPlan({
    url: `https://${HOST}/api/remote/state`,
    host: HOST,
    authorization: `Bearer ${SYNTH}`,
    expectedPin: pinOf(DER_A),
    expectedIp: IP,
    leafOrderProven: true,
  });

  /** 假传输忠实实现 SDK 的 `maxRedirects:0` 契约：3xx 原样返回，不再发第二次请求。 */
  function makeTransport(response) {
    const log = [];
    return {
      log,
      request: async (url, options) => {
        log.push({ url, auth: options.header['Authorization'] ?? '' });
        assert.equal(options.maxRedirects, 0, 'SDK 级 no-follow 必须打开');
        return response;
      },
    };
  }

  test('302 + location ⇒ 拒绝；目标端 server log 中凭证请求计数 = 0', async () => {
    const transport = makeTransport({
      responseCode: 302,
      location: DEST,
      body: '',
      errorCode: 0,
    });
    const execution = await executePinnedRequest(plan, transport);
    assert.equal(execution.disposition.kind, 'refused');
    assert.equal(execution.disposition.refusal.code, 'E_REDIRECT_REFUSED');
    assert.equal(execution.requestCount, 1, '编排层不再发第二次请求');
    assert.equal(transport.log.length, 1, '只有最初那条请求');
    assert.equal(transport.log.filter((e) => e.url === DEST).length, 0, '目标端零请求');
    assert.equal(transport.log.filter((e) => e.auth.includes(SYNTH) && e.url === DEST).length, 0);
  });

  test('2300047（跳转超过上限）⇒ typed 拒绝；零凭据继续外发', async () => {
    const transport = makeTransport({ responseCode: 0, location: '', body: '', errorCode: 2300047 });
    const execution = await executePinnedRequest(plan, transport);
    assert.equal(execution.disposition.refusal.code, 'E_REDIRECT_LIMIT');
    assert.equal(execution.requestCount, 1);
    assert.equal(transport.log.filter((e) => e.auth.includes(SYNTH) && e.url === DEST).length, 0);
  });

  test('阴性对照：非跳转 200 ⇒ 目标端恰好一条带凭证请求', async () => {
    const transport = makeTransport({
      responseCode: 200,
      location: '',
      body: JSON.stringify({ cards: [{ title: 'ok', detail: 'matched' }] }),
      errorCode: 0,
    });
    const execution = await executePinnedRequest(plan, transport);
    assert.equal(execution.disposition.kind, 'ok');
    assert.equal(execution.requestCount, 1);
    assert.equal(transport.log.filter((e) => e.auth.includes(SYNTH)).length, 1);
    assert.equal(transport.log.filter((e) => e.url === DEST).length, 0);
  });
});

describe('D. 原生渲染解析（不启用 WebView）', () => {
  test('结构化 JSON ⇒ 卡片数组；坏 JSON / 错形状 ⇒ 空数组（不回显原文）', () => {
    assert.deepEqual(parsePinnedCards(JSON.stringify({
      cards: [{ title: 'A', detail: 'B' }, { title: 'C' }],
    })), [{ title: 'A', detail: 'B' }, { title: 'C', detail: '' }]);
    assert.deepEqual(parsePinnedCards('{not json'), []);
    assert.deepEqual(parsePinnedCards('{"other":1}'), []);
    assert.deepEqual(parsePinnedCards(''), []);
  });
});

describe('E. SDK 证据（文件在机器上也由测试钉住；缺失则跳过）', () => {
  const SDK = 'D:\\A-DevEco\\DevEco Studio\\sdk\\default\\openharmony\\ets\\api\\@ohos.net.http.d.ts';
  const hasSdk = existsSync(SDK);
  test('maxRedirects:0 禁用重定向 + remoteValidation 回调均在同一 HttpRequestOptions', {
    skip: !hasSdk,
  }, () => {
    const src = readFileSync(SDK, 'utf8');
    assert.match(src, /maxRedirects\?: number;/);
    assert.match(src, /If the value is set to \*\*0\*\*, redirection is disabled\./);
    assert.match(src, /remoteValidation\?: RemoteValidation;/);
    assert.match(src, /export type ValidationCallback = \(context: ValidationContext\) => boolean \| Promise<boolean>;/);
  });

  test('本模块没有 fallback 到凭证 WebView 的代码路径', () => {
    const adapter = stripComments(readFileSync(resolve(SRC, 'services/remotePinnedClient.ets'), 'utf8'));
    assert.equal(/@kit\.ArkWeb/.test(adapter), false);
    assert.equal(/SslErrorHandler/.test(adapter), false);
    assert.equal(/certificatePinning/.test(adapter), false, '不用公钥 pin 替代 leaf DER pin');
  });
});
