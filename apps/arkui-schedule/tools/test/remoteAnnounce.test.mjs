// 签名公告纯模型（`model/remoteAnnounce.ts`）的 Node 单测 —— 本文件的断言就是验收标准 A1/A2/A3。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 本模块零 SDK import、零 IO：验签器 / 时钟 / 已钉住表全部注入。生产注入 ArkTS cryptoFramework
// 适配器，测试注入假实现；因此这里能逐条钉住「签名 → 指纹 → 时间 → 同 id」的固定顺序。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  ANNOUNCE_FIELDS,
  SIGNING_FIELDS,
  KEEP_WORDING,
  canonicalSerialise,
  signingPayload,
  containsSecret,
  normalizeAnnouncement,
  parseAnnouncement,
  verifyFingerprint,
  verifyAnnouncement,
  decideAutoRefresh,
  sanitiseForPublish,
  canPublish,
  problemText
} = await import('../.build/model/remoteAnnounce.js');

/** 固定时钟与固定公钥 / 指纹，保证断言可复现。 */
const NOW = 1763740800000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const PUBKEY = '00'.repeat(32);
const PIN_A = 'a'.repeat(64);
const PIN_B = 'b'.repeat(64);

/** 合法公告夹具（可局部覆盖）；updatedAt 默认等于「现在」，签名由假验签器接管。 */
function makeAnn(overrides = {}) {
  const base = {
    instanceId: 'inst-0123456789abcdef',
    scheme: 'https',
    host: 'dsh.example.local',
    port: 3080,
    transportKind: 'ipv6',
    publicKeyFingerprint: PIN_A,
    tlsFingerprint: PIN_B,
    tokenId: 'tok-9f3c2a1b7d4e5f60',
    updatedAt: NOW,
    nonce: 'n-4d2e7f1a',
    signature: 'deadbeef'
  };
  return { ...base, ...overrides };
}

/** 验证选项夹具；默认验签通过、已钉 PIN_A、显式非首配。 */
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

/** 只记调用参数、恒返回给定值的假验签器（spy）。 */
function spyVerifier(result) {
  const calls = [];
  const fn = (payload, signature, publicKey) => {
    calls.push({ payload, signature, publicKey });
    return result;
  };
  fn.calls = calls;
  return fn;
}

describe('A1 secret scan（字节扫描，不扫结构）', () => {
  test('A1 规范字节不含 token 值 / privateKey / BEGIN / "token" 字段，containsSecret 逐项抓到手工注入', () => {
    const TOKEN = 'sk-real-looking-token-9f3c2a1b7d4e5f60';
    // tokenId 长得像真令牌，但只是 id（schema 允许的唯一形态）
    const ann = makeAnn({ tokenId: TOKEN.slice(-16) });
    const bytes = canonicalSerialise(ann);

    assert.equal(bytes.includes(TOKEN), false, '序列化字节不得含令牌值');
    assert.equal(bytes.includes('privateKey'), false, '序列化字节不得含 privateKey');
    assert.equal(bytes.includes('BEGIN'), false, '序列化字节不得含 PEM BEGIN');
    assert.equal(bytes.includes('"token"'), false, '序列化字节不得含 "token" 字段（只有 tokenId）');
    assert.equal(containsSecret(bytes), false, '干净公告不得被误报');

    // 手工注入后按**字节**扫描，四种形态逐一命中
    assert.equal(containsSecret(`${bytes.slice(0, -1)},"token":"${TOKEN}"}`), true, '"token" 字段 + 令牌值');
    assert.equal(containsSecret(bytes.replace('"host"', '"privateKey"')), true, 'privateKey 字段');
    assert.equal(containsSecret('-----BEGIN PRIVATE KEY-----'), true, 'PEM BEGIN');
    // 令牌值原文不在规范字节里；手工注入一段后才用已知值扫描抓到
    assert.equal(containsSecret(`${bytes}${TOKEN}`, [TOKEN]), true, '显式给出的已知令牌值');
    assert.equal(containsSecret(`http://h/?token=${TOKEN}`), true, 'query 形态 token=');

    // 发布清洗：未知字段剥离，禁止字段 typed 拒绝
    const stripped = sanitiseForPublish({ ...ann, harmlessNote: 'x' });
    assert.equal(stripped.ok, true);
    assert.equal(canonicalSerialise(stripped.announcement), bytes, '未知字段必须被剥离');
    const refused = sanitiseForPublish({ ...ann, token: TOKEN });
    assert.equal(refused.ok, false);
    assert.equal(refused.problem, 'E_ANNOUNCE_SECRET');
  });
});

describe('A2 order（验签先于时间判定，固定四步顺序）', () => {
  test('A2 spy 证明验签在时钟之前；反序参考路径会错报，真实流水线报签名码', () => {
    // ① 全通过：spy 记录到严格 ["verify","clock"] —— 时钟只在第 ③ 步被读一次
    const order = [];
    const verifier = (payload, signature, publicKey) => { order.push('verify'); return true; };
    const clock = () => { order.push('clock'); return NOW; };
    const ok = verifyAnnouncement(makeAnn(), makeOpts({ verifier, now: clock }));
    assert.equal(ok.ok, true);
    assert.deepEqual(order, ['verify', 'clock'], '验签必须先于任何时间判定');
    assert.ok(order.indexOf('verify') < order.indexOf('clock'));

    // ② 坏签名 + 过期时间：真实流水线停在 ①，时钟根本没被调用
    const badAnn = makeAnn({ signature: 'bad', updatedAt: NOW - 31 * DAY });
    const badOrder = [];
    const badVerifier = (payload, signature, publicKey) => { badOrder.push('verify'); return false; };
    const badResult = verifyAnnouncement(
      badAnn,
      makeOpts({ verifier: badVerifier, now: () => { badOrder.push('clock'); return NOW; } })
    );
    assert.equal(badResult.problem, 'E_ANNOUNCE_SIGNATURE', '错误码必须是签名码，证明 ① 先于 ③');
    assert.deepEqual(badOrder, ['verify'], '过期时钟在真实路径里从未被读取');

    // ③ 测试内故意实现的「反序参考路径」：先查时间再验签
    function reversedFirst(a) {
      if (a.updatedAt < NOW - 30 * DAY) return 'E_ANNOUNCE_TOO_OLD';
      if (!badVerifier('', a.signature, '')) return 'E_ANNOUNCE_SIGNATURE';
      return 'ok';
    }
    assert.equal(reversedFirst(badAnn), 'E_ANNOUNCE_TOO_OLD', '反序会先报时间码（错误）');
    assert.notEqual(reversedFirst(badAnn), badResult.problem, '真实流水线不报反序的码');
  });
});

describe('A3 public repo（发布门禁 fail-closed）', () => {
  test('A3 canPublish private 允许、public/unknown 各自 typed 拒绝且码不同', () => {
    const priv = canPublish('private');
    const pub = canPublish('public');
    const unk = canPublish('unknown');
    assert.equal(priv.ok, true);
    assert.equal(priv.problem, 'ok');
    assert.equal(pub.ok, false);
    assert.equal(pub.problem, 'E_ANNOUNCE_REPO_PUBLIC');
    assert.equal(unk.ok, false);
    assert.equal(unk.problem, 'E_ANNOUNCE_REPO_UNKNOWN');
    assert.notEqual(pub.problem, unk.problem, '两种拒绝必须是不同 typed 码');
    // 任何非三者值也 fail-closed 到 unknown
    assert.equal(canPublish('maybe').problem, 'E_ANNOUNCE_REPO_UNKNOWN');
    assert.equal(canPublish(undefined).problem, 'E_ANNOUNCE_REPO_UNKNOWN');
  });
});

describe('规范序列化与签名载荷', () => {
  test('字段顺序与 FIXED schema 逐字一致，载荷恰好去掉 signature', () => {
    assert.deepEqual([...ANNOUNCE_FIELDS], [
      'instanceId', 'scheme', 'host', 'port', 'transportKind', 'publicKeyFingerprint',
      'tlsFingerprint', 'tokenId', 'updatedAt', 'nonce', 'signature'
    ]);
    assert.deepEqual([...SIGNING_FIELDS], [...ANNOUNCE_FIELDS.slice(0, 10)]);
    const ann = makeAnn();
    const bytes = canonicalSerialise(ann);
    assert.equal(Object.keys(JSON.parse(bytes)).join(','), ANNOUNCE_FIELDS.join(','));
    assert.equal(/\s/.test(bytes), false, '规范字节不得有空白');
    const payload = signingPayload(ann);
    assert.equal(payload.includes('signature'), false, '签名载荷不得含 signature 自身');
    assert.equal(Object.keys(JSON.parse(payload)).join(','), SIGNING_FIELDS.join(','));
    assert.notEqual(payload, bytes, '载荷与完整公告字节必须不同');
  });

  test('确定性：乱序输入归一后字节相等；重复序列化与解析往返逐字节相等', () => {
    const a = makeAnn();
    const shuffled = {
      signature: a.signature, nonce: a.nonce, updatedAt: a.updatedAt, tokenId: a.tokenId,
      tlsFingerprint: a.tlsFingerprint, publicKeyFingerprint: a.publicKeyFingerprint,
      transportKind: a.transportKind, port: a.port, host: a.host, scheme: a.scheme,
      instanceId: a.instanceId
    };
    const n1 = normalizeAnnouncement(a, 'tablet');
    const n2 = normalizeAnnouncement(shuffled, 'tablet');
    assert.equal(n1.ok, true);
    assert.equal(n2.ok, true);
    assert.equal(canonicalSerialise(n1.announcement), canonicalSerialise(n2.announcement));
    assert.equal(canonicalSerialise(n1.announcement), canonicalSerialise(a));
    const parsed = parseAnnouncement(canonicalSerialise(a), 'tablet');
    assert.equal(parsed.ok, true);
    assert.equal(canonicalSerialise(parsed.announcement), canonicalSerialise(a));
  });

  test('sign/verify 往返：假验签器拿到的正是 signingPayload，验签通过', () => {
    const ann = makeAnn();
    const verifier = spyVerifier(true);
    const result = verifyAnnouncement(ann, makeOpts({ verifier }));
    assert.equal(result.ok, true);
    assert.equal(verifier.calls.length, 1);
    assert.equal(verifier.calls[0].payload, signingPayload(ann));
    assert.equal(verifier.calls[0].signature, ann.signature);
    assert.equal(verifier.calls[0].publicKey, PUBKEY);
  });

  test('验签器抛异常时按失败处理，绝不返回通过', () => {
    const throwing = () => { throw new Error('platform mismatch'); };
    const result = verifyAnnouncement(makeAnn(), makeOpts({ verifier: throwing }));
    assert.equal(result.ok, false);
    assert.equal(result.problem, 'E_ANNOUNCE_SIGNATURE');
  });
});

describe('TOFU 指纹与钉住', () => {
  test('无 pin + 显式首配 ⇒ 通过并返回待保存 pin', () => {
    const result = verifyAnnouncement(makeAnn(), makeOpts({ pinnedKey: '', firstPairing: true }));
    assert.equal(result.ok, true);
    assert.equal(result.pin, PIN_A);
  });

  test('无 pin 但没有首配标志 ⇒ E_ANNOUNCE_PIN_REQUIRED', () => {
    const result = verifyAnnouncement(makeAnn(), makeOpts({ pinnedKey: '', firstPairing: false }));
    assert.equal(result.ok, false);
    assert.equal(result.problem, 'E_ANNOUNCE_PIN_REQUIRED');
  });

  test('pin 不匹配 ⇒ E_ANNOUNCE_PIN_MISMATCH', () => {
    const result = verifyAnnouncement(makeAnn(), makeOpts({ pinnedKey: PIN_B }));
    assert.equal(result.ok, false);
    assert.equal(result.problem, 'E_ANNOUNCE_PIN_MISMATCH');
  });

  test('verifyFingerprint 大小写 / 空白归一后精确相等', () => {
    assert.equal(verifyFingerprint(`  ${PIN_A.toUpperCase()}  `, PIN_A), true);
    assert.equal(verifyFingerprint(PIN_A, PIN_B), false);
    assert.equal(verifyFingerprint('', PIN_A), false);
  });
});

describe('时间界限', () => {
  test('未来 >5 分钟 ⇒ E_ANNOUNCE_FUTURE，边界恰好 5 分钟放行', () => {
    const tooFuture = makeAnn({ updatedAt: NOW + 5 * MINUTE + 1 });
    const atBound = makeAnn({ updatedAt: NOW + 5 * MINUTE });
    assert.equal(verifyAnnouncement(tooFuture, makeOpts()).problem, 'E_ANNOUNCE_FUTURE');
    assert.equal(verifyAnnouncement(atBound, makeOpts()).ok, true);
  });

  test('过去 >30 天 ⇒ E_ANNOUNCE_TOO_OLD，边界恰好 30 天放行，且与未来码不同', () => {
    const tooOld = makeAnn({ updatedAt: NOW - 30 * DAY - 1 });
    const atBound = makeAnn({ updatedAt: NOW - 30 * DAY });
    const futureCode = verifyAnnouncement(makeAnn({ updatedAt: NOW + 5 * MINUTE + 1 }), makeOpts()).problem;
    assert.equal(verifyAnnouncement(tooOld, makeOpts()).problem, 'E_ANNOUNCE_TOO_OLD');
    assert.equal(verifyAnnouncement(atBound, makeOpts()).ok, true);
    assert.notEqual('E_ANNOUNCE_TOO_OLD', futureCode);
  });
});

describe('同 id 拒并与 transportKind 边界', () => {
  test('同 instanceId 钉住不同公钥 ⇒ E_ANNOUNCE_ID_CONFLICT，永不合并', () => {
    const ann = makeAnn();
    const result = verifyAnnouncement(ann, makeOpts({
      pinnedKey: PIN_A,
      knownPins: { 'inst-0123456789abcdef': PIN_B }
    }));
    assert.equal(result.ok, false);
    assert.equal(result.problem, 'E_ANNOUNCE_ID_CONFLICT');
  });

  test('同 instanceId 钉住相同公钥 ⇒ 通过（合法重复公告）', () => {
    const result = verifyAnnouncement(makeAnn(), makeOpts({
      knownPins: { 'inst-0123456789abcdef': PIN_A }
    }));
    assert.equal(result.ok, true);
  });

  test('tailcat 对平板 typed 拒绝，对 host↔host 允许', () => {
    const tablet = normalizeAnnouncement(makeAnn({ transportKind: 'tailcat' }), 'tablet');
    assert.equal(tablet.ok, false);
    assert.equal(tablet.problem, 'E_ANNOUNCE_TRANSPORT_UNSUPPORTED');
    const host = normalizeAnnouncement(makeAnn({ transportKind: 'tailcat' }), 'host');
    assert.equal(host.ok, true);
    assert.equal(host.announcement.transportKind, 'tailcat');
  });

  test('未知 transportKind ⇒ E_ANNOUNCE_TRANSPORT', () => {
    const result = normalizeAnnouncement(makeAnn({ transportKind: 'relay' }), 'host');
    assert.equal(result.ok, false);
    assert.equal(result.problem, 'E_ANNOUNCE_TRANSPORT');
  });
});

describe('自动刷新决策', () => {
  test('四步全过且 updatedAt 严格更新 ⇒ refresh', () => {
    const ann = makeAnn({ updatedAt: NOW });
    const decision = decideAutoRefresh(ann, NOW - 1, makeOpts());
    assert.equal(decision.action, 'refresh');
    assert.equal(decision.pin, PIN_A);
    assert.equal(decision.reason, '');
  });

  test('更旧的 updatedAt ⇒ keep，文案逐字「公告不可信，请手动确认」', () => {
    const decision = decideAutoRefresh(makeAnn({ updatedAt: NOW - 10 }), NOW, makeOpts());
    assert.equal(decision.action, 'keep');
    assert.equal(decision.reason, KEEP_WORDING);
    assert.equal(KEEP_WORDING, '公告不可信，请手动确认');
  });

  test('验证不通过 ⇒ keep 且 reason 恒为 KEEP_WORDING', () => {
    const decision = decideAutoRefresh(makeAnn({ signature: 'bad' }), 0, makeOpts({ verifier: () => false }));
    assert.equal(decision.action, 'keep');
    assert.equal(decision.reason, KEEP_WORDING);
    assert.equal(decision.pin, '');
  });
});

describe('坏输入一律 typed 返回，绝不抛', () => {
  test('malformed JSON / 非字符串 ⇒ E_ANNOUNCE_JSON', () => {
    assert.equal(parseAnnouncement('{not json', 'tablet').problem, 'E_ANNOUNCE_JSON');
    assert.equal(parseAnnouncement('', 'tablet').problem, 'E_ANNOUNCE_JSON');
    assert.equal(parseAnnouncement(42, 'tablet').problem, 'E_ANNOUNCE_JSON');
  });

  test('缺字段 ⇒ E_ANNOUNCE_MISSING；错误类型 ⇒ E_ANNOUNCE_TYPE；均不抛', () => {
    const missing = makeAnn();
    delete missing.nonce;
    assert.equal(normalizeAnnouncement(missing, 'tablet').problem, 'E_ANNOUNCE_MISSING');
    const wrong = makeAnn({ port: '3080' });
    assert.equal(normalizeAnnouncement(wrong, 'tablet').problem, 'E_ANNOUNCE_TYPE');
    assert.doesNotThrow(() => normalizeAnnouncement(undefined, 'tablet'));
    assert.doesNotThrow(() => normalizeAnnouncement([], 'tablet'));
    assert.doesNotThrow(() => normalizeAnnouncement(makeAnn({ updatedAt: null }), 'tablet'));
  });

  test('非法字段值（scheme/host/port/id/指纹/时间）⇒ E_ANNOUNCE_FIELD', () => {
    assert.equal(normalizeAnnouncement(makeAnn({ scheme: 'ftp' }), 'tablet').problem, 'E_ANNOUNCE_FIELD');
    assert.equal(normalizeAnnouncement(makeAnn({ host: 'h?token=x' }), 'tablet').problem, 'E_ANNOUNCE_FIELD');
    assert.equal(normalizeAnnouncement(makeAnn({ port: 0 }), 'tablet').problem, 'E_ANNOUNCE_FIELD');
    assert.equal(normalizeAnnouncement(makeAnn({ instanceId: 'bad' }), 'tablet').problem, 'E_ANNOUNCE_FIELD');
    assert.equal(normalizeAnnouncement(makeAnn({ publicKeyFingerprint: 'zz' }), 'tablet').problem, 'E_ANNOUNCE_FIELD');
    assert.equal(normalizeAnnouncement(makeAnn({ updatedAt: -1 }), 'tablet').problem, 'E_ANNOUNCE_FIELD');
  });

  test('token / privateKey 字段经归一或解析 ⇒ E_ANNOUNCE_SECRET', () => {
    assert.equal(normalizeAnnouncement({ ...makeAnn(), token: 'x' }, 'tablet').problem, 'E_ANNOUNCE_SECRET');
    assert.equal(normalizeAnnouncement({ ...makeAnn(), privateKey: 'x' }, 'tablet').problem, 'E_ANNOUNCE_SECRET');
    const bytes = canonicalSerialise(makeAnn()).replace('"host"', '"token":"x","host"');
    assert.equal(parseAnnouncement(bytes, 'tablet').problem, 'E_ANNOUNCE_SECRET');
  });

  test('非法调用方 / 中文问题文案表', () => {
    assert.equal(normalizeAnnouncement(makeAnn(), 'gateway').problem, 'E_ANNOUNCE_CALLER');
    assert.equal(problemText('E_ANNOUNCE_PIN_MISMATCH'), '公告公钥指纹与钉住值不一致');
    assert.equal(problemText('E_ANNOUNCE_REPO_PUBLIC'), '仓库是公开的，拒绝发布地址公告');
  });
});
