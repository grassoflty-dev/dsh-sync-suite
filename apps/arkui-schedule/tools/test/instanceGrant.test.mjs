// `mod-instance-grant`：dots 授权纯模型 + 信封 + 显式命令规则 + 吊销/过期 + 存储源码守卫。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 纯模型 `model/instanceGrant.ts` 有相对 import（instances → remoteAccess / remoteUrl / sha256），
// 编译产物是扩展名省略的 ES import，故用 registerHooks 补 `.js`（与本仓其它测试同法）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const M = await import('../.build/model/instanceGrant.js');

const {
  PRINCIPAL_DOTS,
  TOOL_INSTANCE_LIST,
  TOOL_INSTANCE_INSPECT,
  TOOL_SESSION_LIST,
  TOOL_SESSION_READ,
  TOOL_SESSION_PROMPT,
  VIEW_TOOLS,
  COMMAND_TOOLS,
  ALL_GRANT_TOOLS,
  GRANT_ENVELOPE_VERSION,
  emptyTools,
  isKnownTool,
  isViewTool,
  isCommandTool,
  problemText,
  canonicalTools,
  makeGrantKey,
  grantKey,
  normalizeGrant,
  grantActive,
  isGranted,
  grantedTools,
  canPrompt,
  findGrant,
  sortGrants,
  upsertGrant,
  revokeGrant,
  redactGrant,
  encodeGrants,
  decodeGrants
} = M;

const ID_A = 'inst-0123456789abcdef';
const ID_B = 'inst-fedcba9876543210';
const SECRET = 'TOP_SECRET_NEVER_LOG_9f2a';

function rawGrant(overrides = {}) {
  const base = {
    grantId: 'g-1',
    instanceId: ID_A,
    principal: 'dots',
    tools: [TOOL_INSTANCE_LIST, TOOL_SESSION_LIST],
    grantedAt: 100
  };
  return { ...base, ...overrides };
}

function normalized(raw) {
  const result = normalizeGrant(raw);
  assert.equal(result.ok, true, `应通过归一：${JSON.stringify(raw)}（${result.reason}）`);
  assert.equal(result.problem, 'ok');
  assert.equal(result.reason, '');
  assert.notEqual(result.grant, null);
  return result.grant;
}

function refused(raw, code) {
  const result = normalizeGrant(raw);
  assert.equal(result.ok, false, `应拒绝：${JSON.stringify(raw)}`);
  assert.equal(result.grant, null);
  assert.equal(result.problem, code);
  assert.ok(result.reason.length > 0, '拒绝必须带中文原因');
  assert.equal(problemText(code), result.reason);
  return result;
}

// ---------------------------------------------------------------- 工具集合 / 分类

describe('工具集合：view 与 command 严格分开', () => {
  test('T-01 五个工具 id 逐字固定，顺序即 canonical 顺序', () => {
    assert.deepEqual(ALL_GRANT_TOOLS, [
      'instance.list', 'instance.inspect', 'session.list', 'session.read', 'session.prompt'
    ]);
    assert.equal(TOOL_SESSION_PROMPT, 'session.prompt');
    assert.equal(GRANT_ENVELOPE_VERSION, 1);
    assert.equal(PRINCIPAL_DOTS, 'dots');
  });

  test('T-02 view 四个、command 恰好一个，两者不相交', () => {
    assert.deepEqual(VIEW_TOOLS, ['instance.list', 'instance.inspect', 'session.list', 'session.read']);
    assert.deepEqual(COMMAND_TOOLS, ['session.prompt']);
    for (const tool of VIEW_TOOLS) {
      assert.equal(isViewTool(tool), true);
      assert.equal(isCommandTool(tool), false, `${tool} 不能是命令工具`);
    }
    for (const tool of COMMAND_TOOLS) {
      assert.equal(isCommandTool(tool), true);
      assert.equal(isViewTool(tool), false);
    }
    assert.deepEqual(emptyTools(), []);
  });

  test('T-03 isKnownTool 只认精确枚举；未知/大小写/别名一律 false', () => {
    for (const tool of ALL_GRANT_TOOLS) {
      assert.equal(isKnownTool(tool), true);
    }
    for (const bad of ['sessionPrompt', 'SESSION.PROMPT', 'session.prompt.extra', 'bash', '', null, 7]) {
      assert.equal(isKnownTool(bad), false);
    }
  });
});

// ---------------------------------------------------------------- 归一 / typed 拒绝

describe('normalizeGrant：字段校验与 typed 拒绝', () => {
  test('N-01 合法授权：字段逐字保留，工具 canonical 去重排序，note trim', () => {
    const g = normalized(rawGrant({
      tools: [TOOL_SESSION_PROMPT, TOOL_SESSION_LIST, TOOL_SESSION_LIST],
      grantedAt: 100.9, revokedAt: 200.8, expiresAt: 300.7, note: '  仅本机审批  '
    }));
    assert.equal(g.grantId, 'g-1');
    assert.equal(g.instanceId, ID_A);
    assert.equal(g.principal, 'dots');
    assert.deepEqual(g.tools, [TOOL_SESSION_LIST, TOOL_SESSION_PROMPT]);
    assert.equal(g.grantedAt, 100);
    assert.equal(g.revokedAt, 200);
    assert.equal(g.expiresAt, 300);
    assert.equal(g.note, '仅本机审批');
  });

  test('N-02 脏入参（null / 数组 / 数字 / 字符串）给 E_GRANT_SHAPE，不抛错', () => {
    for (const raw of [null, undefined, [], 7, 'x']) {
      refused(raw, 'E_GRANT_SHAPE');
    }
  });

  test('N-03 空 grantId 给 E_GRANT_ID', () => {
    refused(rawGrant({ grantId: '   ' }), 'E_GRANT_ID');
    refused(rawGrant({ grantId: 42 }), 'E_GRANT_ID');
  });

  test('N-04 坏 instanceId 形状给 E_GRANT_INSTANCE_ID（local 与 inst-<16hex> 合法）', () => {
    for (const id of ['', 'bad', 'inst-xyz', 'LOCAL', 'local/..', 'inst-0123456789abcdef0', 7]) {
      refused(rawGrant({ instanceId: id }), 'E_GRANT_INSTANCE_ID');
    }
    assert.equal(normalized(rawGrant({ instanceId: 'local' })).instanceId, 'local');
    assert.equal(normalized(rawGrant({ instanceId: ID_A })).instanceId, ID_A);
  });

  test('N-05 未知 principal 给 E_GRANT_PRINCIPAL（只有 dots）', () => {
    for (const principal of ['device', 'root', 'DOTS', '', 7]) {
      refused(rawGrant({ principal }), 'E_GRANT_PRINCIPAL');
    }
  });

  test('N-06 tools 非数组 / 空数组分别给 E_GRANT_TOOLS_SHAPE / E_GRANT_TOOLS_EMPTY', () => {
    refused(rawGrant({ tools: 'session.list' }), 'E_GRANT_TOOLS_SHAPE');
    refused(rawGrant({ tools: null }), 'E_GRANT_TOOLS_SHAPE');
    refused(rawGrant({ tools: [] }), 'E_GRANT_TOOLS_EMPTY');
  });

  test('N-07 未知工具给 E_GRANT_TOOL_UNKNOWN（含空串与非字符串）', () => {
    for (const tools of [
      ['session.list', 'bash'], ['sessionPrompt'], ['  '], ['session.prompt', 7]
    ]) {
      refused(rawGrant({ tools }), 'E_GRANT_TOOL_UNKNOWN');
    }
  });

  test('N-08 坏 grantedAt / revokedAt / expiresAt 给各自 typed 码', () => {
    for (const t of [0, -1, NaN, Infinity, '100', null]) {
      refused(rawGrant({ grantedAt: t }), 'E_GRANT_GRANTED_AT');
    }
    refused(rawGrant({ revokedAt: '200' }), 'E_GRANT_REVOKED_AT');
    refused(rawGrant({ revokedAt: -1 }), 'E_GRANT_REVOKED_AT');
    refused(rawGrant({ expiresAt: 0 }), 'E_GRANT_EXPIRES_AT');
    refused(rawGrant({ expiresAt: '300' }), 'E_GRANT_EXPIRES_AT');
  });

  test('N-09 可选字段缺失不落字段；空 note 不落字段', () => {
    const g = normalized(rawGrant());
    assert.equal(g.revokedAt, undefined);
    assert.equal(g.expiresAt, undefined);
    assert.equal(g.note, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(g, 'revokedAt'), false);
  });
});

// ---------------------------------------------------------------- grantKey / 确定性

describe('grantKey 与确定性', () => {
  test('K-01 grantKey = (instanceId, principal)，同实例同 principal 同键，跨实例不同键', () => {
    const g = normalized(rawGrant());
    assert.equal(grantKey(g), makeGrantKey(ID_A, 'dots'));
    assert.equal(grantKey(g), `${ID_A}|dots`);
    assert.notEqual(grantKey(normalized(rawGrant({ grantId: 'g-2', instanceId: ID_B }))), grantKey(g));
  });

  test('K-02 canonicalTools 去重 + 按合法顺序排序，未知工具被丢弃，入参不被改', () => {
    const input = [TOOL_SESSION_READ, TOOL_INSTANCE_LIST, TOOL_SESSION_READ, TOOL_SESSION_PROMPT];
    const out = canonicalTools(input);
    assert.deepEqual(out, [TOOL_INSTANCE_LIST, TOOL_SESSION_READ, TOOL_SESSION_PROMPT]);
    assert.equal(input.length, 4, '不就地修改入参');
    assert.deepEqual(canonicalTools([]), []);
  });
});

// ---------------------------------------------------------------- isGranted / 显式命令规则

describe('isGranted：显式命令规则、吊销、过期、per-instance 隔离', () => {
  test('G-01 纯 view grant 绝不能 prompt（hard rule）', () => {
    const viewOnly = normalized(rawGrant({ tools: [TOOL_INSTANCE_LIST, TOOL_SESSION_LIST] }));
    assert.equal(isGranted([viewOnly], ID_A, TOOL_SESSION_PROMPT, 200), false);
    assert.equal(canPrompt([viewOnly], ID_A, 200), false);
    assert.deepEqual(grantedTools([viewOnly], ID_A, 200), [TOOL_INSTANCE_LIST, TOOL_SESSION_LIST]);
    assert.equal(grantedTools([viewOnly], ID_A, 200).includes(TOOL_SESSION_PROMPT), false);
  });

  test('G-02 显式列出 session.prompt 才授权命令；view + command 可共存', () => {
    const withPrompt = normalized(rawGrant({ tools: [TOOL_SESSION_PROMPT] }));
    assert.equal(canPrompt([withPrompt], ID_A, 200), true);
    const both = normalized(rawGrant({
      tools: [TOOL_INSTANCE_LIST, TOOL_SESSION_READ, TOOL_SESSION_PROMPT]
    }));
    assert.equal(isGranted([both], ID_A, TOOL_SESSION_READ, 200), true);
    assert.equal(canPrompt([both], ID_A, 200), true);
    assert.deepEqual(grantedTools([both], ID_A, 200), [
      TOOL_INSTANCE_LIST, TOOL_SESSION_READ, TOOL_SESSION_PROMPT
    ]);
  });

  test('G-03 command-only grant 不隐含任何 view 权（分离是对称的）', () => {
    const cmdOnly = normalized(rawGrant({ tools: [TOOL_SESSION_PROMPT] }));
    assert.equal(isGranted([cmdOnly], ID_A, TOOL_SESSION_LIST, 200), false);
    assert.equal(isGranted([cmdOnly], ID_A, TOOL_INSTANCE_LIST, 200), false);
    assert.deepEqual(grantedTools([cmdOnly], ID_A, 200), [TOOL_SESSION_PROMPT]);
  });

  test('G-04 per-instance 隔离：A 的 grant 永不授权 B（含 prompt）', () => {
    const g = normalized(rawGrant({ tools: [TOOL_SESSION_LIST, TOOL_SESSION_PROMPT] }));
    assert.equal(isGranted([g], ID_B, TOOL_SESSION_LIST, 200), false);
    assert.equal(isGranted([g], ID_B, TOOL_SESSION_PROMPT, 200), false);
    assert.equal(canPrompt([g], ID_B, 200), false);
    assert.deepEqual(grantedTools([g], ID_B, 200), []);
  });

  test('G-05 不存在的 grant / 未知工具 / 非法 nowMs 一律 false', () => {
    const g = normalized(rawGrant({ tools: [TOOL_SESSION_LIST] }));
    assert.equal(isGranted([], ID_A, TOOL_SESSION_LIST, 200), false);
    assert.equal(isGranted([g], ID_A, 'bash', 200), false);
    for (const now of [0, -1, NaN, Infinity, '200', null]) {
      assert.equal(isGranted([g], ID_A, TOOL_SESSION_LIST, now), false, `nowMs=${String(now)}`);
      assert.deepEqual(grantedTools([g], ID_A, now), []);
    }
  });

  test('G-06 未生效（grantedAt 在未来）不授权，到点后生效', () => {
    const g = normalized(rawGrant({ grantedAt: 300, tools: [TOOL_SESSION_PROMPT] }));
    assert.equal(grantActive(g, 200), false);
    assert.equal(isGranted([g], ID_A, TOOL_SESSION_PROMPT, 200), false);
    assert.equal(isGranted([g], ID_A, TOOL_SESSION_PROMPT, 300), true);
    assert.equal(grantActive(g, 299), false);
  });

  test('G-07 过期（expiresAt）即刻降权，且不换令牌重试', () => {
    const g = normalized(rawGrant({
      tools: [TOOL_SESSION_LIST, TOOL_SESSION_PROMPT], expiresAt: 300
    }));
    assert.equal(grantActive(g, 299), true);
    assert.equal(isGranted([g], ID_A, TOOL_SESSION_PROMPT, 299), true);
    assert.equal(grantActive(g, 300), false);
    assert.equal(isGranted([g], ID_A, TOOL_SESSION_PROMPT, 300), false);
    assert.equal(canPrompt([g], ID_A, 400), false);
    assert.deepEqual(grantedTools([g], ID_A, 300), []);
  });

  test('G-08 revokedAt 未来的授权在吊销前有效、吊销时刻起失效', () => {
    const g = normalized(rawGrant({ revokedAt: 200, tools: [TOOL_SESSION_PROMPT] }));
    assert.equal(grantActive(g, 199), true);
    assert.equal(canPrompt([g], ID_A, 199), true);
    assert.equal(grantActive(g, 200), false);
    assert.equal(canPrompt([g], ID_A, 200), false);
  });

  test('G-09 多 grant：任一有效且含工具才授权，全部失效则不授权', () => {
    const view = normalized(rawGrant({ grantId: 'g-view', tools: [TOOL_SESSION_LIST] }));
    const cmd = normalized(rawGrant({
      grantId: 'g-cmd', tools: [TOOL_SESSION_PROMPT], expiresAt: 200
    }));
    assert.equal(canPrompt([view, cmd], ID_A, 150), true);
    assert.equal(canPrompt([view, cmd], ID_A, 200), false);
    assert.equal(isGranted([view, cmd], ID_A, TOOL_SESSION_LIST, 200), true);
  });
});

// ---------------------------------------------------------------- revokeGrant

describe('revokeGrant：吊销优先', () => {
  test('R-01 吊销后所有工具（含 command）立即失效，吊销前仍有效', () => {
    const g = normalized(rawGrant({ tools: [TOOL_SESSION_LIST, TOOL_SESSION_PROMPT] }));
    const revoked = revokeGrant([g], 'g-1', 200);
    assert.equal(revoked.ok, true);
    assert.equal(isGranted(revoked.items, ID_A, TOOL_SESSION_LIST, 200), false);
    assert.equal(canPrompt(revoked.items, ID_A, 200), false);
    assert.equal(canPrompt(revoked.items, ID_A, 199), true);
    assert.equal(revoked.items[0].revokedAt, 200);
    assert.equal(g.revokedAt, undefined, '入参不被修改');
  });

  test('R-02 重复吊销保留更早的 revokedAt，不延长授权窗口', () => {
    const g = normalized(rawGrant({ revokedAt: 150, tools: [TOOL_SESSION_PROMPT] }));
    const again = revokeGrant([g], 'g-1', 400);
    assert.equal(again.items[0].revokedAt, 150);
    const sooner = revokeGrant([g], 'g-1', 120);
    assert.equal(sooner.items[0].revokedAt, 120);
    assert.equal(canPrompt(sooner.items, ID_A, 200), false);
  });

  test('R-03 找不到 grantId 原样返回副本；非法 nowMs typed 拒绝且原表不动', () => {
    const g = normalized(rawGrant({ tools: [TOOL_SESSION_LIST] }));
    const input = [g];
    const result = revokeGrant(input, 'missing', 200);
    assert.equal(result.ok, true);
    assert.deepEqual(result.items, [g]);
    assert.notEqual(result.items, input, '即使未命中也返回新数组');
    for (const badNow of [0, -1, NaN, Infinity, '200', null]) {
      const bad = revokeGrant(input, 'g-1', badNow);
      assert.equal(bad.ok, false, `nowMs=${String(badNow)} 必须拒绝`);
      assert.equal(bad.problem, 'E_GRANT_NOW');
      assert.equal(bad.reason, problemText('E_GRANT_NOW'));
      assert.deepEqual(bad.items, [g], '原表原样，绝不写 revokedAt=0');
    }
    assert.equal(input[0].revokedAt, undefined, '入参不被修改');
  });

  test('R-04 非法 nowMs 吊销后整表仍可回读，不会清掉其它实例的授权', () => {
    const a = normalized(rawGrant({ tools: [TOOL_SESSION_LIST] }));
    const b = normalized(rawGrant({ grantId: 'g-2', instanceId: ID_B, tools: [TOOL_SESSION_PROMPT] }));
    const table = [a, b];
    const bad = revokeGrant(table, 'g-1', 0);
    assert.equal(bad.ok, false);
    assert.equal(bad.problem, 'E_GRANT_NOW');
    assert.deepEqual(bad.items, table);
    const decoded = decodeGrants(encodeGrants(bad.items));
    assert.equal(decoded.ok, true, '回读不能因坏吊销失败');
    assert.equal(decoded.items.length, 2, '所有实例授权都还在');
    assert.equal(canPrompt(decoded.items, ID_B, 200), true);
  });
});

// ---------------------------------------------------------------- upsertGrant

describe('upsertGrant：按 grantKey 替换、确定性', () => {
  test('U-01 新键插入、同键替换（不产生第二条），跨实例并存', () => {
    const a = normalized(rawGrant({ tools: [TOOL_SESSION_LIST] }));
    const b = normalized(rawGrant({ grantId: 'g-2', instanceId: ID_B, tools: [TOOL_SESSION_LIST] }));
    const inserted = upsertGrant([a], b);
    assert.equal(inserted.ok, true);
    assert.deepEqual(inserted.items.map((x) => x.instanceId), [ID_A, ID_B]);
    const replaced = upsertGrant(inserted.items, normalized(rawGrant({ tools: [TOOL_SESSION_PROMPT] })));
    assert.equal(replaced.ok, true);
    assert.equal(replaced.items.length, 2, '同键替换不产生第二条');
    assert.deepEqual(findGrant(replaced.items, 'g-1').tools, [TOOL_SESSION_PROMPT], 'g-1 被同键新授权替换');
    assert.deepEqual(findGrant(replaced.items, 'g-2').tools, [TOOL_SESSION_LIST], '另一实例不受影响');
  });

  test('U-02 坏授权 typed 拒绝 + 原表副本；入参不被改', () => {
    const a = normalized(rawGrant());
    const input = [a];
    const next = upsertGrant(input, { grantId: '', instanceId: 'bad' });
    assert.equal(next.ok, false);
    assert.equal(next.problem, 'E_GRANT_ID');
    assert.equal(next.reason, problemText('E_GRANT_ID'));
    assert.deepEqual(next.items, [a]);
    assert.notEqual(next.items[0], a);
    assert.equal(input.length, 1);
  });

  test('U-04 吊销后显式再授：恢复 active，grantedAt 刷新，旧 revokedAt 清除', () => {
    const g = normalized(rawGrant({ tools: [TOOL_SESSION_LIST, TOOL_SESSION_PROMPT] }));
    const revoked = revokeGrant([g], 'g-1', 200);
    assert.equal(revoked.ok, true);
    assert.equal(canPrompt(revoked.items, ID_A, 200), false);
    const regranted = upsertGrant(revoked.items, normalized(rawGrant({
      grantedAt: 300, tools: [TOOL_SESSION_LIST, TOOL_SESSION_PROMPT]
    })));
    assert.equal(regranted.ok, true);
    assert.equal(regranted.items.length, 1, '同键替换仍然只有一条');
    const fresh = findGrant(regranted.items, 'g-1');
    assert.equal(fresh.grantedAt, 300);
    assert.equal(fresh.revokedAt, undefined, '旧吊销时间被清除');
    assert.equal(Object.prototype.hasOwnProperty.call(fresh, 'revokedAt'), false);
    assert.equal(canPrompt(regranted.items, ID_A, 250), false, '新授权生效前仍降权');
    assert.equal(canPrompt(regranted.items, ID_A, 300), true, '新授权生效后恢复命令权');
  });

  test('U-03 sortGrants 幂等，按 grantKey 再按 grantId 排序', () => {
    const a = normalized(rawGrant({ grantId: 'g-2', instanceId: ID_A }));
    const b = normalized(rawGrant({ grantId: 'g-1', instanceId: ID_B }));
    const c = normalized(rawGrant({ grantId: 'g-1', instanceId: ID_A }));
    const sorted = sortGrants([a, b, c]);
    assert.deepEqual(sorted.map((x) => x.grantId), ['g-1', 'g-2', 'g-1']);
    assert.deepEqual(sorted.map((x) => x.instanceId), [ID_A, ID_A, ID_B]);
    assert.deepEqual(sortGrants(sorted), sorted);
  });
});

// ---------------------------------------------------------------- 信封 / 恢复 / 确定性

describe('持久化信封 {v:1,items:[...]}', () => {
  test('E-01 round-trip：全部字段保留，确定性顺序', () => {
    const g1 = normalized(rawGrant({
      tools: [TOOL_SESSION_PROMPT, TOOL_SESSION_LIST], revokedAt: 900, expiresAt: 950, note: '审批一次'
    }));
    const g2 = normalized(rawGrant({ grantId: 'g-2', instanceId: ID_B, tools: [TOOL_INSTANCE_INSPECT] }));
    const json = encodeGrants([g2, g1]);
    const envelope = JSON.parse(json);
    assert.equal(envelope.v, GRANT_ENVELOPE_VERSION);
    assert.equal(envelope.items.length, 2);
    const decoded = decodeGrants(json);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.problem, 'ok');
    assert.deepEqual(decoded.items, sortGrants([g1, g2]));
    assert.deepEqual(decoded.items[0].tools, [TOOL_SESSION_LIST, TOOL_SESSION_PROMPT]);
  });

  test('E-02 逐字节确定性：工具顺序 / 记录顺序无关，重复 encode 字节相等', () => {
    const g = rawGrant({ tools: [TOOL_SESSION_PROMPT, TOOL_INSTANCE_LIST, TOOL_SESSION_PROMPT] });
    const one = normalized(g);
    const two = normalized(rawGrant({
      ...g, grantId: 'g-2', instanceId: ID_B, tools: [TOOL_INSTANCE_LIST, TOOL_SESSION_PROMPT]
    }));
    const a = encodeGrants([one, two]);
    const b = encodeGrants([two, one]);
    assert.equal(a, b);
    assert.equal(encodeGrants(decodeGrants(a).items), a);
    assert.equal(JSON.stringify(one).length > 0, true);
    assert.equal(encodeGrants(decodeGrants(a).items), encodeGrants(decodeGrants(a).items));
  });

  test('E-03 损坏信封一律回落空表 + typed reason，不抛异常', () => {
    const good = normalized(rawGrant());
    const cases = [
      ['', 'E_GRANT_ENVELOPE_EMPTY'],
      ['   ', 'E_GRANT_ENVELOPE_EMPTY'],
      ['{not json', 'E_GRANT_ENVELOPE_JSON'],
      ['[]', 'E_GRANT_ENVELOPE_SHAPE'],
      ['null', 'E_GRANT_ENVELOPE_SHAPE'],
      ['{}', 'E_GRANT_ENVELOPE_SHAPE'],
      [JSON.stringify({ v: 2, items: [] }), 'E_GRANT_ENVELOPE_VERSION'],
      [JSON.stringify({ v: 1, items: 'nope' }), 'E_GRANT_ENVELOPE_SHAPE'],
      [JSON.stringify({ v: 1, items: [{ ...good, tools: ['bash'] }] }), 'E_GRANT_ENVELOPE_ITEM'],
      [JSON.stringify({ v: 1, items: [{ ...good, instanceId: 'bad' }] }), 'E_GRANT_ENVELOPE_ITEM']
    ];
    for (const [raw, code] of cases) {
      const result = decodeGrants(raw);
      assert.equal(result.ok, false, `应拒绝：${raw}`);
      assert.deepEqual(result.items, []);
      assert.equal(result.problem, code);
      assert.equal(problemText(code), result.reason);
      assert.ok(result.reason.length > 0);
    }
  });

  test('E-04 空信封合法（空表）', () => {
    const result = decodeGrants(encodeGrants([]));
    assert.equal(result.ok, true);
    assert.deepEqual(result.items, []);
    assert.equal(result.problem, 'ok');
  });

  test('E-05 手写重复键信封：最新 grantedAt 胜出，canPrompt 只反映胜者', () => {
    const oldWithPrompt = rawGrant({ grantId: 'g-old', tools: [TOOL_SESSION_PROMPT], grantedAt: 100 });
    const newViewOnly = rawGrant({ grantId: 'g-new', tools: [TOOL_SESSION_LIST], grantedAt: 200 });
    const decoded = decodeGrants(JSON.stringify({ v: 1, items: [oldWithPrompt, newViewOnly] }));
    assert.equal(decoded.ok, true);
    assert.equal(decoded.items.length, 1, '同 grantKey 只留一条');
    assert.equal(decoded.items[0].grantId, 'g-new');
    assert.equal(decoded.items[0].grantedAt, 200);
    assert.equal(canPrompt(decoded.items, ID_A, 300), false, '旧 prompt 权不得并进胜者');
    assert.deepEqual(grantedTools(decoded.items, ID_A, 300), [TOOL_SESSION_LIST]);
    assert.equal(JSON.parse(encodeGrants(decoded.items)).items.length, 1, '再编码仍是单条');
  });

  test('E-06 重复键同 grantedAt：grantId 字典序更大者胜，与信封顺序无关', () => {
    const smaller = rawGrant({ grantId: 'g-a', tools: [TOOL_SESSION_PROMPT], grantedAt: 100 });
    const larger = rawGrant({ grantId: 'g-z', tools: [TOOL_SESSION_LIST], grantedAt: 100 });
    for (const order of [[smaller, larger], [larger, smaller]]) {
      const decoded = decodeGrants(JSON.stringify({ v: 1, items: order }));
      assert.equal(decoded.ok, true);
      assert.equal(decoded.items.length, 1);
      assert.equal(decoded.items[0].grantId, 'g-z');
      assert.equal(canPrompt(decoded.items, ID_A, 200), false);
      assert.deepEqual(grantedTools(decoded.items, ID_A, 200), [TOOL_SESSION_LIST]);
    }
  });
});

// ---------------------------------------------------------------- 脱敏视图

describe('redactGrant：无自由文本、派生 active / canPrompt', () => {
  test('D-01 view grant 的 redacted.canPrompt=false，command grant 的 =true', () => {
    const view = normalized(rawGrant({ tools: [TOOL_SESSION_LIST], note: '内部备注' }));
    const cmd = normalized(rawGrant({ grantId: 'g-2', tools: [TOOL_SESSION_PROMPT] }));
    const viewV = redactGrant(view, 200);
    const cmdV = redactGrant(cmd, 200);
    assert.equal(viewV.canPrompt, false);
    assert.equal(cmdV.canPrompt, true);
    assert.equal(viewV.active, true);
    assert.deepEqual(viewV.tools, [TOOL_SESSION_LIST]);
    assert.equal(Object.prototype.hasOwnProperty.call(viewV, 'note'), false);
    assert.equal(JSON.stringify(viewV).includes('内部备注'), false);
  });

  test('D-02 吊销 / 过期后 active=false 且 canPrompt=false', () => {
    const g = normalized(rawGrant({ tools: [TOOL_SESSION_PROMPT], revokedAt: 200 }));
    const before = redactGrant(g, 199);
    const after = redactGrant(g, 200);
    assert.equal(before.active, true);
    assert.equal(before.canPrompt, true);
    assert.equal(after.active, false);
    assert.equal(after.canPrompt, false);
    assert.equal(after.revokedAt, 200);
  });

  test('D-03 expiresAt 分支：到期前 active/canPrompt=true，到点起=false', () => {
    const g = normalized(rawGrant({ tools: [TOOL_SESSION_PROMPT], expiresAt: 300 }));
    const before = redactGrant(g, 299);
    const at = redactGrant(g, 300);
    const after = redactGrant(g, 301);
    assert.equal(before.active, true);
    assert.equal(before.canPrompt, true);
    assert.equal(before.expiresAt, 300);
    assert.equal(at.active, false, 'expiresAt 当刻即失效');
    assert.equal(at.canPrompt, false);
    assert.equal(after.active, false);
    assert.equal(after.canPrompt, false);
    assert.equal(Object.prototype.hasOwnProperty.call(before, 'note'), false, '脱敏视图仍无自由文本');
  });
});

// ---------------------------------------------------------------- 源码守卫

const MODEL_SRC = readFileSync(new URL('../../entry/src/main/ets/model/instanceGrant.ts', import.meta.url), 'utf8');
const STORE_SRC = readFileSync(new URL('../../entry/src/main/ets/services/instanceGrantStore.ets', import.meta.url), 'utf8');

describe('静态守卫：无凭据 / 无日志 / 存储接线', () => {
  test('S-01 两份新文件都没有日志调用', () => {
    const logWord = 'con' + 'sole';
    const logRe = new RegExp(`(?:${logWord}|hilog|logger)\\s*\\.`, 'i');
    for (const [name, src] of [['model', MODEL_SRC], ['store', STORE_SRC]]) {
      assert.equal(logRe.test(src), false, `${name} 不得有日志调用`);
    }
  });

  test('S-02 model/store 不出现任何 token/secret/password 或凭据值', () => {
    const secretRe = /token|secret|password|bearer|authorization/i;
    for (const [name, src] of [['model', MODEL_SRC], ['store', STORE_SRC]]) {
      assert.equal(secretRe.test(src), false, `${name} 不得出现凭据字样`);
      assert.equal(src.includes(SECRET), false, `${name} 不得含测试凭据字面量`);
    }
  });

  test('S-03 store 只用单个 PersistentStorage 键 + 一次整串原子写 + typed recovery', () => {
    assert.match(STORE_SRC, /const GRANT_STORAGE_KEY: string = 'instance-grants\.json'/);
    assert.match(STORE_SRC, /PersistentStorage\.persistProp<string>\(GRANT_STORAGE_KEY/);
    assert.match(STORE_SRC, /AppStorage\.setOrCreate<string>\(GRANT_STORAGE_KEY, json\)/);
    assert.match(STORE_SRC, /decodeGrants\(raw\)/);
    assert.match(STORE_SRC, /encodeGrants\(sorted\)/);
    assert.match(STORE_SRC, /lastProblem\(\)/);
    // 只有一个 persistProp 键
    const binds = STORE_SRC.match(/persistProp<string>\(/g) ?? [];
    assert.equal(binds.length, 1);
  });

  test('S-04 模型把 view 与 command 分开，且没有从 view 推导 prompt 的合并路径', () => {
    assert.match(MODEL_SRC, /export const COMMAND_TOOLS: GrantTool\[\] = \[TOOL_SESSION_PROMPT\]/);
    assert.match(MODEL_SRC, /export const TOOL_SESSION_PROMPT: GrantTool = 'session\.prompt'/);
    assert.match(MODEL_SRC, /export function canPrompt\(/);
    // isGranted / grantedTools 只允许「工具显式出现在 tools 里」这一条路径
    assert.match(MODEL_SRC, /g\.tools\.indexOf\(wanted\) >= 0/);
    assert.equal(/VIEW_TOOLS\.indexOf\([^)]*PROMPT/.test(MODEL_SRC), false);
  });

  test('S-05 nowMs 先校验后改表；store 拒绝时不写回（store 类 .ets 无法在 Node 运行）', () => {
    assert.match(MODEL_SRC, /export interface GrantMutationResult/);
    assert.match(MODEL_SRC, /\| 'E_GRANT_NOW'/);
    assert.match(MODEL_SRC, /if \(!validTime\(nowMs\)\) \{\s*return mutationRefused\('E_GRANT_NOW', grants\);/);
    assert.equal(/revokedAt = 0/.test(MODEL_SRC), false, '不得再产生 normalize 拒收的 revokedAt');
    assert.match(MODEL_SRC, /function winsDuplicate\(/);
    assert.match(STORE_SRC, /if \(!result\.ok\) \{\s*this\.problem = result\.problem;/);
  });
});
