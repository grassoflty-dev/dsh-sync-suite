// mod-remote-pinned-client：RC-3 门禁 harness 纯判定层的 Node 单测。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const SRC = resolve(APP, 'entry/src/main/ets');
const H = await import('../.build/model/rc3GateHarness.js');
const {
  GATE_ALLOWLIST,
  makeSyntheticCredential,
  classifyGateCredential,
  isAllowedGateEndpoint,
  emptyObservation,
  leafOrderEvidence,
  canRunCredentialPhase,
  formatGateCounts,
} = H;

const digestA = 'a'.repeat(64);
const observed = (x509, pem, digest = digestA) => ({
  callbackFired: true, host: '127.0.0.1', ip: '127.0.0.1',
  x509Count: x509, pemCount: pem, leafDigests: [digest],
});

describe('A. 受控端点白名单', () => {
  test('只接受表内精确 https host:port', () => {
    for (const authority of GATE_ALLOWLIST) {
      assert.equal(isAllowedGateEndpoint(`https://${authority}/probe`), true);
    }
  });

  test('表外端点 / http / 查询串 / userinfo 一律拒绝', () => {
    for (const bad of [
      'https://attacker.example.test:9443/probe',
      'http://127.0.0.1:9443/probe',
      'https://127.0.0.1:9443/?x=1',
      'https://u:p@127.0.0.1:9443/probe',
      'https://127.0.0.1:9444/probe',
      '',
    ]) {
      assert.equal(isAllowedGateEndpoint(bad), false, `endpoint=${bad}`);
    }
  });
});

describe('B. 合成凭证守卫（绝不接收用户真实 token）', () => {
  test('只接受本 harness 生成的形状', () => {
    const synth = makeSyntheticCredential('rc3-observation-pass');
    assert.match(synth, /^Bearer SYNTHETIC-RC3-[0-9a-f]{16}$/);
    assert.equal(classifyGateCredential(synth), 'synthetic');
  });

  test('真实 token 形状 / 空值 / 伪造前缀一律拒绝', () => {
    const realistic = 'Bearer sk-' + 'x'.repeat(48);
    const jwt = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature';
    for (const bad of [realistic, jwt, '', null, undefined, 'Bearer SYNTHETIC-RC3-xyz', 'Basic abc']) {
      assert.notEqual(classifyGateCredential(bad), 'synthetic', `credential kind=${typeof bad}`);
    }
  });
});

describe('C. 观察先行 + leaf 身份证据（不从单个 fixture 推断元素 0）', () => {
  test('未观察 / 多证书 / 无 PEM / 坏摘要 ⇒ E_LEAF_ORDER_UNPROVEN', () => {
    assert.equal(leafOrderEvidence(emptyObservation()), 'E_LEAF_ORDER_UNPROVEN');
    assert.equal(leafOrderEvidence(observed(2, 2)), 'E_LEAF_ORDER_UNPROVEN');
    assert.equal(leafOrderEvidence(observed(1, 2)), 'E_LEAF_ORDER_UNPROVEN');
    assert.equal(leafOrderEvidence(observed(1, 0)), 'E_LEAF_ORDER_UNPROVEN');
    assert.equal(leafOrderEvidence(observed(1, 1, 'not-a-digest')), 'E_LEAF_ORDER_UNPROVEN');
  });

  test('形状唯一（一份 PEM + x509≤1 + 一个摘要）⇒ proven（仍须 debug harness 显式确认）', () => {
    const obs = observed(1, 1);
    assert.equal(leafOrderEvidence(obs), 'proven');
    assert.equal(canRunCredentialPhase('observe', obs, true), false, '观察阶段永不携带凭证');
    assert.equal(canRunCredentialPhase('credentials', obs, false), false, '没有 harness 确认不得带凭证');
    assert.equal(canRunCredentialPhase('credentials', obs, true), true);
  });

  test('计数格式只含数字，不含凭证值', () => {
    const synthetic = makeSyntheticCredential('count-check');
    const text = formatGateCounts({ authCount: 0, destinationRequestCount: 2 });
    assert.match(text, /次数：0/);
    assert.match(text, /次数：2/);
    assert.equal(text.includes(synthetic), false);
  });
});

/** 源码守卫只看代码，不把注释里提到的名称算作实现/依赖。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('D. debug-only / release-exclusion 源码守卫', () => {
  const read = (rel) => stripComments(readFileSync(resolve(SRC, rel), 'utf8'));
  const debug = (rel) => read(`../../harmony-debug/ets/${rel}`);
  const harness = debug('services/rc3GateHarness.ets');
  const panel = debug('components/Rc3GatePanel.ets');
  const stub = read('components/Rc3GatePanel.ets');
  const page = read('pages/RemoteControl.ets');
  const pure = read('model/rc3GateHarness.ts');
  const adapter = read('services/remotePinnedClient.ets');

  test('sentinel 只在 debug harness 服务里出现一次', () => {
    const all = [harness, page, pure, adapter].join('\n');
    const hits = all.split('PIN-ATTACK-01').length - 1;
    assert.equal(hits, 1, `sentinel 出现次数=${hits}`);
  });

  test('harness 不读用户 token / 设置 / ~/.dsh/dots', () => {
    for (const forbidden of ['settingsStore', 'remoteToken', '~/.dsh', 'credentialFile', 'apiKey']) {
      assert.equal(harness.includes(forbidden), false, `harness 不得触碰 ${forbidden}`);
    }
  });

  test('debug 闸：页面通过 rc3GateActive + BuildProfile，且默认 false', () => {
    assert.match(page, /this\.rc3Gate = rc3GateRequested\(\)/);
    assert.match(page, /@State rc3Gate: boolean = false/);
    assert.match(panel, /rc3GateActive\(gateParam\(\)\)/);
    assert.match(harness, /BuildProfile\.DEBUG === true/);
    assert.match(stub, /rc3GateRequested\(\): boolean\s*\{\s*return false;/);
    assert.doesNotMatch(stub, /\bimport\b|PIN-ATTACK-01/);
    const overlay = readFileSync(resolve(APP, 'tools/overlay.mjs'), 'utf8');
    assert.match(overlay, /if \(mode === 'debug'\) \{\s*for \(const rel of walk\(debugDir\)\)/);
    assert.equal(harness.includes('import BuildProfile from \'BuildProfile\''), true);
  });

  test('leafOrderProven 的生产值为 false，只有 debug harness 才能给 true', () => {
    assert.match(adapter, /plan\.leafOrderProven/);
    assert.match(harness, /leafOrderProven: true/);
    assert.equal(pure.includes('leafOrderProven: true'), false);
  });

  test('带凭证阶段使用带外指纹且观察与端点绑定', () => {
    assert.match(harness, /normalizeGateExpectedPin\(expectedPinInput\)/);
    assert.match(harness, /observedEndpoint !== url/);
    assert.match(harness, /expectedPin: expectedPin/);
    assert.doesNotMatch(harness, /expectedPin:\s*observedPin\(/);
  });

  test('release-exclusion 检查脚本存在并钉住 sentinel', () => {
    const script = readFileSync(resolve(APP, 'tools/check-rc3-release-exclusion.mjs'), 'utf8');
    assert.match(script, /PIN-ATTACK-01/);
    assert.match(script, /modules\.abc/);
    assert.match(script, /process\.exit\(1\)/);
  });
});
