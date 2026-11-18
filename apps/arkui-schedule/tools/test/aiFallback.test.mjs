// AI 多源 fallback 纯决策层（`model/aiFallback.ts`）的单元测试 + 三个「约束型」源码断言。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 测试分两部分：
// A. 真跑纯函数（决策表逐行、planFallback 夹取/去重、脱敏、诊断汇总、连续错误序列）；
// B. 源码级不变量（运行器每次尝试前重读设置、settingsStore 三个新键成对读写、组件回调名、
//    文档里存在决策表）——`.ets` 在 Node 里跑不了，但这些事实是纯文本可判定的。
//
// `aiFallback.ts` 运行期 import `./aiProvider` / `./aiRequest`（无扩展名），Node 的 ESM 不做扩展名推断，
// 这里只为测试进程补 `.js` 后缀（与 `remoteAccess.test.mjs` 同一套写法）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.js')
      ) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const {
  DEFAULT_MAX_ATTEMPTS,
  DIAGNOSTIC_MESSAGE_MAX,
  KIND_AUTH,
  KIND_BAD_REQUEST,
  KIND_CONFIG,
  KIND_NETWORK,
  KIND_OK,
  KIND_PARSE,
  KIND_RATE_LIMIT,
  KIND_SERVER,
  KIND_TIMEOUT,
  MAX_ATTEMPTS_LIMIT,
  MAX_FALLBACK_SOURCES,
  attemptKindForStatus,
  categoryOfAttempt,
  classifyAttempt,
  dedupeSources,
  isSameSource,
  normalizeMaxAttempts,
  parseFallbackOrder,
  planFallback,
  sanitizeDiagnostic,
  serializeFallbackOrder,
  sourceLabel,
  summarizeDiagnostics
} = await import('../.build/model/aiFallback.js');

/** 造一个源的期望值（`baseURL` 省略时不带该键，避免 deepEqual 因 undefined 键失败）。 */
function source(providerId, modelId) {
  return { providerId, modelId };
}

/** 造一次尝试结果（默认失败、耗时 1ms，只覆盖关心的字段）。 */
function attempt(overrides) {
  return { ok: false, elapsedMs: 1, ...overrides };
}

/** 造一条诊断（默认失败、`abort`，只覆盖关心的字段）。 */
function diagnostic(overrides) {
  return {
    attempt: 1,
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    outcome: 'next-source',
    elapsedMs: 100,
    category: KIND_SERVER,
    message: '服务端错误',
    ...overrides
  };
}

/** 三个源：主源 + 两个备用源。 */
const A = source('deepseek', 'deepseek-chat');
const B = source('opencode-go', 'deepseek-v4-pro');
const C = source('codex', 'gpt-5.1-codex');

// ---------------------------------------------------------------- A1 决策表逐行

describe('classifyAttempt：决策表逐行', () => {
  test('ok=true → success（不看状态码）', () => {
    assert.equal(classifyAttempt(attempt({ ok: true, status: 200, elapsedMs: 12 })), 'success');
    assert.equal(classifyAttempt(attempt({ ok: true, elapsedMs: 0 })), 'success');
  });

  test('401 / 403 → next-source（鉴权被拒，同源重试没意义）', () => {
    assert.equal(classifyAttempt(attempt({ status: 401 })), 'next-source');
    assert.equal(classifyAttempt(attempt({ status: 403, kind: KIND_AUTH })), 'next-source');
  });

  test('429 → next-source（限流，别继续打同一家）', () => {
    assert.equal(classifyAttempt(attempt({ status: 429 })), 'next-source');
    assert.equal(classifyAttempt(attempt({ status: 429, kind: KIND_RATE_LIMIT })), 'next-source');
  });

  test('超时（kind=timeout 或伪状态码 -1）→ next-source', () => {
    assert.equal(classifyAttempt(attempt({ kind: KIND_TIMEOUT })), 'next-source');
    assert.equal(classifyAttempt(attempt({ status: -1 })), 'next-source');
    assert.equal(classifyAttempt(attempt({ status: -1, kind: KIND_TIMEOUT })), 'next-source');
  });

  test('网络失败（kind=network 或伪状态码 0）→ next-source', () => {
    assert.equal(classifyAttempt(attempt({ kind: KIND_NETWORK })), 'next-source');
    assert.equal(classifyAttempt(attempt({ status: 0 })), 'next-source');
    assert.equal(classifyAttempt(attempt({ status: 0, kind: KIND_NETWORK })), 'next-source');
  });

  test('5xx → next-source（服务端故障，换家可能就好）', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      assert.equal(classifyAttempt(attempt({ status })), 'next-source', `HTTP ${status} 应换源`);
    }
  });

  test('解析失败（kind=parse，哪怕 HTTP 200）→ next-source', () => {
    assert.equal(classifyAttempt(attempt({ ok: false, status: 200, kind: KIND_PARSE })), 'next-source');
    assert.equal(classifyAttempt(attempt({ kind: KIND_PARSE })), 'next-source');
  });

  test('其它 4xx（400 / 404 / 422 …）→ abort（我们自己的请求有问题，别浪费额度）', () => {
    for (const status of [400, 404, 405, 408, 413, 422, 451, 499]) {
      assert.equal(classifyAttempt(attempt({ status })), 'abort', `HTTP ${status} 应停止而不是换源`);
    }
  });

  test('402（余额/配额不足）→ next-source：是这家的账务问题，换一家通常立刻可用', () => {
    assert.equal(classifyAttempt(attempt({ status: 402 })), 'next-source');
  });

  test('本地配置问题（kind=config：缺 key / 地址非法）→ next-source（下一个源有自己的配置）', () => {
    assert.equal(classifyAttempt(attempt({ kind: KIND_CONFIG })), 'next-source');
    assert.equal(classifyAttempt(attempt({ kind: KIND_CONFIG, status: 400 })), 'next-source');
  });

  test('无状态码且无类别 / 未知状态 / 2xx 但 ok=false → abort（无法证明换源有用）', () => {
    assert.equal(classifyAttempt(attempt({})), 'abort');
    assert.equal(classifyAttempt(attempt({ status: 200 })), 'abort');
    assert.equal(classifyAttempt(attempt({ status: 302 })), 'abort');
    assert.equal(classifyAttempt(attempt({ status: 600 })), 'abort');
  });

  test('没有状态码时鉴权/限流/服务端类别仍换源', () => {
    assert.equal(classifyAttempt(attempt({ kind: KIND_AUTH })), 'next-source');
    assert.equal(classifyAttempt(attempt({ kind: KIND_RATE_LIMIT })), 'next-source');
    assert.equal(classifyAttempt(attempt({ kind: KIND_SERVER })), 'next-source');
    assert.equal(classifyAttempt(attempt({ kind: 'weird-unknown-kind' })), 'abort');
  });
});

// ---------------------------------------------------------------- A2 类别映射

describe('attemptKindForStatus / categoryOfAttempt：类别与决策同源', () => {
  test('状态码 → 类别', () => {
    assert.equal(attemptKindForStatus(200), KIND_OK);
    assert.equal(attemptKindForStatus(-1), KIND_TIMEOUT);
    assert.equal(attemptKindForStatus(0), KIND_NETWORK);
    assert.equal(attemptKindForStatus(401), KIND_AUTH);
    assert.equal(attemptKindForStatus(429), KIND_RATE_LIMIT);
    assert.equal(attemptKindForStatus(503), KIND_SERVER);
    assert.equal(attemptKindForStatus(400), KIND_BAD_REQUEST);
    assert.equal(attemptKindForStatus(418), KIND_BAD_REQUEST);
    assert.equal(attemptKindForStatus(Number.NaN), 'unknown');
  });

  test('categoryOfAttempt：成功是 ok，失败优先用调用方的 kind，否则按状态码推', () => {
    assert.equal(categoryOfAttempt(attempt({ ok: true, status: 200 })), KIND_OK);
    assert.equal(categoryOfAttempt(attempt({ status: 429 })), KIND_RATE_LIMIT);
    assert.equal(categoryOfAttempt(attempt({ status: 200, kind: KIND_PARSE })), KIND_PARSE);
    assert.equal(categoryOfAttempt(attempt({ kind: KIND_CONFIG })), KIND_CONFIG);
    assert.equal(categoryOfAttempt(attempt({})), 'unknown');
  });
});

// ---------------------------------------------------------------- A3 planFallback

describe('planFallback：未开启只回主源 / 夹取 / 去重 / 空数组', () => {
  test('enabled=false 只返回主源（绝不把内容发给别的供应商）', () => {
    const plan = planFallback([A, B, C], false, 3);
    assert.equal(plan.length, 1);
    assert.deepEqual(plan[0], A);
  });

  test('enabled=false 且没有主源 → 空数组', () => {
    assert.deepEqual(planFallback([], false, 2), []);
    assert.deepEqual(planFallback([], true, 2), []);
  });

  test('enabled=true 按 maxAttempts 取前 N 个', () => {
    assert.deepEqual(planFallback([A, B, C], true, 2), [A, B]);
    assert.deepEqual(planFallback([A, B, C], true, 1), [A]);
    assert.deepEqual(planFallback([A, B, C], true, 3), [A, B, C]);
  });

  test('maxAttempts 夹到 1..源数（0/负数 → 1，超大 → 源数）', () => {
    assert.equal(planFallback([A, B, C], true, 0).length, 1);
    assert.equal(planFallback([A, B, C], true, -5).length, 1);
    assert.equal(planFallback([A, B, C], true, 99).length, 3);
    assert.equal(planFallback([A], true, 3).length, 1);
  });

  test('maxAttempts 非法（NaN / 小数）回落默认 2 或向下取整', () => {
    assert.equal(planFallback([A, B, C], true, Number.NaN).length, DEFAULT_MAX_ATTEMPTS);
    assert.equal(planFallback([A, B, C], true, 2.9).length, 2);
    assert.equal(planFallback([A, B, C], true, undefined).length, DEFAULT_MAX_ATTEMPTS);
  });

  test('去重：同 provider+model 只留一次（大小写不敏感），首次出现的顺序优先', () => {
    const plan = planFallback([A, B, source('opencode-go', 'deepseek-v4-pro'), C], true, 4);
    assert.equal(plan.length, 3);
    assert.deepEqual(plan.map((item) => item.modelId), ['deepseek-chat', 'deepseek-v4-pro', 'gpt-5.1-codex']);
    assert.equal(planFallback([A, source('DEEPSEEK', 'DeepSeek-Chat')], true, 2).length, 1);
  });

  test('主源（sources[0]）在备用列表里重复出现时被过滤掉', () => {
    const plan = planFallback([A, B, A, C], true, 3);
    assert.deepEqual(plan, [A, B, C]);
    const trailing = planFallback([A, B, C, A], true, 4);
    assert.equal(trailing.filter((item) => item.providerId === 'deepseek').length, 1);
  });

  test('空条目（缺 provider/model）被丢弃，剩余次序不变', () => {
    const plan = planFallback([A, source('', 'x'), source('codex', ''), B], true, 4);
    assert.deepEqual(plan, [A, B]);
  });

  test('返回值是归一后的副本（去空白 + provider 小写），不改动入参', () => {
    const input = [source(' DeepSeek ', ' deepseek-chat ')];
    const plan = planFallback(input, false, 2);
    assert.deepEqual(plan[0], { providerId: 'deepseek', modelId: 'deepseek-chat' });
    assert.equal(input[0].providerId, ' DeepSeek ', '入参不能被改写');
  });

  test('baseURL 只在非空时出现在结果里', () => {
    const withBase = planFallback([{ providerId: 'custom', modelId: 'm', baseURL: ' https://x.test/v1 ' }], false, 1);
    assert.equal(withBase[0].baseURL, 'https://x.test/v1');
    const withoutBase = planFallback([{ providerId: 'custom', modelId: 'm', baseURL: '  ' }], false, 1);
    assert.equal('baseURL' in withoutBase[0], false);
  });
});

// ---------------------------------------------------------------- A4 去重与源比较

describe('isSameSource / dedupeSources', () => {
  test('同 provider+model 视为同一个源，provider 大小写不敏感', () => {
    assert.equal(isSameSource(A, source('DEEPSEEK', 'deepseek-chat')), true);
    assert.equal(isSameSource(A, B), false);
    assert.equal(isSameSource(A, source('deepseek', 'deepseek-reasoner')), false);
    assert.equal(isSameSource(source('', 'x'), source('', 'x')), false, '空 provider 不算同一个源');
  });

  test('dedupeSources 保持顺序并丢弃空条目', () => {
    const result = dedupeSources([A, B, B, C, A]);
    assert.deepEqual(result, [A, B, C]);
    assert.deepEqual(dedupeSources([]), []);
    assert.deepEqual(dedupeSources([source('', ''), source('deepseek', '')]), []);
  });
});

// ---------------------------------------------------------------- A5 脱敏

describe('sanitizeDiagnostic：抹掉凭据痕迹并截断', () => {
  test('sk- 开头的 key 变 ***', () => {
    const diag = sanitizeDiagnostic(diagnostic({ message: '请求失败：sk-abc123def456 无效' }));
    assert.equal(diag.message.includes('sk-'), false, `仍有 sk- 片段：${diag.message}`);
    assert.equal(diag.message.includes('abc123def456'), false);
    assert.ok(diag.message.includes('***'));
  });

  test('Bearer 凭据整体变 ***（连 Bearer 字样一起抹掉）', () => {
    const diag = sanitizeDiagnostic(diagnostic({ message: 'Authorization: Bearer abc.def.ghi 被拒绝' }));
    assert.equal(/bearer/i.test(diag.message), false, `仍有 Bearer：${diag.message}`);
    assert.equal(diag.message.includes('abc.def.ghi'), false);
    assert.ok(diag.message.includes('***'));
  });

  test('api_key=... / token=... 变 ***（键名也不留）', () => {
    const key = sanitizeDiagnostic(diagnostic({ message: 'bad request: api_key=AKIA1234567890 rejected' }));
    assert.equal(/api_key/i.test(key.message), false);
    assert.equal(key.message.includes('AKIA1234567890'), false);
    const token = sanitizeDiagnostic(diagnostic({ message: 'token=ghp_abcdef123456 已过期' }));
    assert.equal(/token/i.test(token.message), false);
    assert.equal(token.message.includes('ghp_abcdef123456'), false);
  });

  test('带引号的值与裸 key 单词都被抹掉', () => {
    const quoted = sanitizeDiagnostic(diagnostic({ message: '{"apiKey": "sk-live-999888777"}' }));
    assert.equal(quoted.message.includes('sk-live-999888777'), false);
    const loose = sanitizeDiagnostic(diagnostic({ message: '缺少 key，请到控制台复制' }));
    assert.equal(/\bkey\b/i.test(loose.message), false);
  });

  test('message 超长截断到 200 字符', () => {
    const long = 'x'.repeat(500);
    const diag = sanitizeDiagnostic(diagnostic({ message: long }));
    assert.equal(diag.message.length, DIAGNOSTIC_MESSAGE_MAX);
    assert.equal(DIAGNOSTIC_MESSAGE_MAX, 200);
    // 刚好 200 不截断
    const exact = sanitizeDiagnostic(diagnostic({ message: 'y'.repeat(200) }));
    assert.equal(exact.message.length, 200);
  });

  test('耗时/序号归一成非负整数，未知 outcome 归一成 abort', () => {
    const diag = sanitizeDiagnostic(diagnostic({ elapsedMs: -5, attempt: 2.8, outcome: 'weird' }));
    assert.equal(diag.elapsedMs, 0);
    assert.equal(diag.attempt, 2);
    assert.equal(diag.outcome, 'abort');
    const nan = sanitizeDiagnostic(diagnostic({ elapsedMs: Number.NaN, attempt: Number.NaN }));
    assert.equal(nan.elapsedMs, 0);
    assert.equal(nan.attempt, 0);
  });

  test('源名去空白；category 为空时回落 unknown；整条记录里没有任何凭据痕迹', () => {
    const diag = sanitizeDiagnostic(
      diagnostic({
        providerId: ' opencode-go ',
        modelId: ' deepseek-v4-pro ',
        category: '',
        message: 'Bearer sk-zzzz11112222 api_key=k1 token=t1 全部拒绝'
      })
    );
    assert.equal(diag.providerId, 'opencode-go');
    assert.equal(diag.modelId, 'deepseek-v4-pro');
    assert.equal(diag.category, 'unknown');
    const serialized = JSON.stringify(diag);
    for (const fragment of ['sk-', 'Bearer', 'bearer', 'api_key', 'token=', 'zzzz11112222', 'k1 ', 't1 ']) {
      assert.equal(serialized.includes(fragment), false, `诊断里仍有「${fragment}」：${serialized}`);
    }
  });
});

// ---------------------------------------------------------------- A6 诊断汇总

describe('summarizeDiagnostics：尝试次数 / 失败源 / 成功位置', () => {
  test('第 2 次成功：failedSources 只有第一个源，succeededAt=2', () => {
    const list = [
      sanitizeDiagnostic(diagnostic({ attempt: 1, providerId: 'deepseek', outcome: 'next-source' })),
      sanitizeDiagnostic(
        diagnostic({ attempt: 2, providerId: 'opencode-go', modelId: 'deepseek-v4-pro', outcome: 'success' })
      )
    ];
    const summary = summarizeDiagnostics(list);
    assert.equal(summary.attempts, 2);
    assert.deepEqual(summary.failedSources, ['deepseek']);
    assert.equal(summary.succeededAt, 2);
  });

  test('全失败：succeededAt=null，失败源按首次出现顺序去重', () => {
    const list = [
      sanitizeDiagnostic(diagnostic({ attempt: 1, providerId: 'deepseek', outcome: 'next-source' })),
      sanitizeDiagnostic(diagnostic({ attempt: 2, providerId: 'opencode-go', outcome: 'next-source' })),
      sanitizeDiagnostic(diagnostic({ attempt: 3, providerId: 'opencode-go', outcome: 'abort' }))
    ];
    const summary = summarizeDiagnostics(list);
    assert.equal(summary.attempts, 3);
    assert.deepEqual(summary.failedSources, ['deepseek', 'opencode-go']);
    assert.equal(summary.succeededAt, null);
  });

  test('空列表 / 非数组：零值而不是抛异常', () => {
    assert.deepEqual(summarizeDiagnostics([]), { attempts: 0, failedSources: [], succeededAt: null });
    assert.deepEqual(summarizeDiagnostics(null), { attempts: 0, failedSources: [], succeededAt: null });
  });

  test('第一次就成功：没有失败源，succeededAt=1', () => {
    const summary = summarizeDiagnostics([
      sanitizeDiagnostic(diagnostic({ attempt: 1, providerId: 'deepseek', outcome: 'success', category: KIND_OK }))
    ]);
    assert.equal(summary.attempts, 1);
    assert.deepEqual(summary.failedSources, []);
    assert.equal(summary.succeededAt, 1);
  });
});

// ---------------------------------------------------------------- A7 连续错误序列

describe('连续两类错误的序列：不许无限重试', () => {
  test('429（换源）→ 400（停下）：2 次尝试后终止', () => {
    const outcomes = [];
    const attempts = [attempt({ status: 429, kind: KIND_RATE_LIMIT }), attempt({ status: 400, kind: KIND_BAD_REQUEST })];
    let index = 0;
    while (index < attempts.length) {
      const outcome = classifyAttempt(attempts[index]);
      outcomes.push(outcome);
      index++;
      if (outcome === 'abort' || outcome === 'success') {
        break;
      }
    }
    assert.deepEqual(outcomes, ['next-source', 'abort']);
    assert.equal(index, 2, '第二次 abort 之后不得再尝试');
  });

  test('429 → 500 → 503 → 401 全换源，最后一条 abort 前最多 N 次', () => {
    const statuses = [429, 500, 503, 401];
    const outcomes = statuses.map((status) => classifyAttempt(attempt({ status })));
    assert.deepEqual(outcomes, ['next-source', 'next-source', 'next-source', 'next-source']);
    const diagnostics = statuses.map((status, order) =>
      sanitizeDiagnostic(
        diagnostic({ attempt: order + 1, providerId: `p${order}`, outcome: outcomes[order], category: attemptKindForStatus(status) })
      )
    );
    const summary = summarizeDiagnostics(diagnostics);
    assert.equal(summary.attempts, 4);
    assert.equal(summary.succeededAt, null);
    assert.deepEqual(summary.failedSources, ['p0', 'p1', 'p2', 'p3']);
  });

  test('超时之后 400：第一次换源、第二次停下', () => {
    assert.equal(classifyAttempt(attempt({ kind: KIND_TIMEOUT })), 'next-source');
    assert.equal(classifyAttempt(attempt({ status: 400 })), 'abort');
  });
});

// ---------------------------------------------------------------- A8 设置值解析

describe('parseFallbackOrder / serializeFallbackOrder / normalizeMaxAttempts', () => {
  test('坏数据一律回落空数组（不抛）', () => {
    for (const raw of ['', '   ', 'not json', '{', '{}', 'null', '42', '"x"', '[1,2,3]']) {
      assert.deepEqual(parseFallbackOrder(raw), [], `坏数据应回落 []：${raw}`);
    }
    assert.deepEqual(parseFallbackOrder(undefined), []);
    assert.deepEqual(parseFallbackOrder(null), []);
  });

  test('正常 JSON 解析成源列表，未知源被丢弃（绝不静默回退默认源）', () => {
    const raw = JSON.stringify([
      { providerId: 'opencode-go', modelId: 'deepseek-v4-pro' },
      { providerId: 'not-a-provider', modelId: 'x' },
      { providerId: 'codex', modelId: 'gpt-5.1' }
    ]);
    const parsed = parseFallbackOrder(raw);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], source('opencode-go', 'deepseek-v4-pro'));
    assert.deepEqual(parsed[1], source('codex', 'gpt-5.1'));
  });

  test('缺模型名回落该源默认模型；缺 provider 的条目被丢弃', () => {
    const parsed = parseFallbackOrder(
      JSON.stringify([
        { providerId: 'codex' },
        { modelId: 'gpt-5.1' },
        { providerId: 'deepseek', modelId: 'deepseek-reasoner' }
      ])
    );
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].providerId, 'codex');
    assert.ok(parsed[0].modelId.length > 0, '缺模型名要补默认模型');
    assert.equal(parsed[1].modelId, 'deepseek-reasoner');
  });

  test('最多保留 3 个（MAX_FALLBACK_SOURCES）', () => {
    assert.equal(MAX_FALLBACK_SOURCES, 3);
    const raw = JSON.stringify([
      { providerId: 'deepseek', modelId: 'm1' },
      { providerId: 'opencode-go', modelId: 'm2' },
      { providerId: 'codex', modelId: 'm3' },
      { providerId: 'openrouter', modelId: 'm4' }
    ]);
    assert.equal(parseFallbackOrder(raw).length, 3);
  });

  test('序列化 → 解析 往返稳定，空列表是 []', () => {
    const list = [B, C];
    const serialized = serializeFallbackOrder(list);
    assert.equal(serialized, JSON.stringify([B, C]));
    assert.deepEqual(parseFallbackOrder(serialized), list);
    assert.equal(serializeFallbackOrder([]), '[]');
    assert.equal(serializeFallbackOrder([B, B]).includes('deepseek-v4-pro'), true);
    assert.equal(JSON.parse(serializeFallbackOrder([B, B])).length, 1, '序列化也要去重');
  });

  test('normalizeMaxAttempts：默认 2，夹 1..4，非法回落默认', () => {
    assert.equal(DEFAULT_MAX_ATTEMPTS, 2);
    assert.equal(MAX_ATTEMPTS_LIMIT, 4);
    assert.equal(normalizeMaxAttempts(1), 1);
    assert.equal(normalizeMaxAttempts(4), 4);
    assert.equal(normalizeMaxAttempts(0), 1);
    assert.equal(normalizeMaxAttempts(-3), 1);
    assert.equal(normalizeMaxAttempts(9), 4);
    assert.equal(normalizeMaxAttempts(2.9), 2);
    assert.equal(normalizeMaxAttempts(Number.NaN), DEFAULT_MAX_ATTEMPTS);
  });

  test('sourceLabel 用预设表的中文名 + 模型名', () => {
    assert.equal(sourceLabel(A), 'DeepSeek 官方 · deepseek-chat');
    assert.equal(sourceLabel(B), 'OpenCode Go · deepseek-v4-pro');
    assert.equal(sourceLabel(source('', 'm')), 'm');
  });
});

// ---------------------------------------------------------------- B 源码级不变量

const APP = new URL('../../entry/src/main/ets/', import.meta.url);
const RUNNER = readFileSync(new URL('services/aiFallbackRunner.ets', APP), 'utf8');
const SETTINGS_STORE = readFileSync(new URL('services/settingsStore.ets', APP), 'utf8');
const PANEL = readFileSync(new URL('components/AiFallbackPanel.ets', APP), 'utf8');
const DEEPSEEK = readFileSync(new URL('services/deepseek.ets', APP), 'utf8');
const DOC = readFileSync(new URL('../../../../docs/AI-FALLBACK.md', import.meta.url), 'utf8');

/**
 * 去掉注释（与 `tools/validate-app.mjs` 的 `stripComments` 同义）。
 *
 * 结构守卫只对**代码**生效：注释里写「不带 @crossplatform」「不 import settingsStore」属于文档说明，
 * 不能因此判失败；反之注释里写「有 console 日志」也不能算通过。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const PANEL_CODE = stripComments(PANEL);
const RUNNER_CODE = stripComments(RUNNER);

describe('运行器：复用决策层、每次尝试前重读设置、不外泄内容', () => {
  test('决策层是唯一判定来源（import 了 classifyAttempt / planFallback / sanitizeDiagnostic）', () => {
    assert.match(RUNNER, /from '\.\.\/model\/aiFallback'/);
    assert.match(RUNNER, /classifyAttempt\(/);
    assert.match(RUNNER, /planFallback\(/);
    assert.match(RUNNER, /sanitizeDiagnostic\(/);
  });

  test('每次尝试前重新读设置（get / load 都在循环里，关掉 fallback 立刻生效）', () => {
    assert.match(RUNNER, /await settingsStore\.load\(\)/, '必须用 load() 重读 preferences');
    // readLiveSettings 被 while 循环体调用：断言它出现在 for/while 之后
    const loopIndex = RUNNER.search(/while \(true\)|for \(let /);
    assert.ok(loopIndex > 0, '运行器必须是显式串行循环');
    const reloadIndex = RUNNER.indexOf('await readLiveSettings(');
    assert.ok(reloadIndex > loopIndex, '重读设置必须发生在循环体内（每轮一次）');
  });

  test('串行而不是并发（没有 Promise.all / forEach 并发），失败也不抛异常', () => {
    assert.equal(/Promise\.all/.test(RUNNER_CODE), false, '不得并发，避免同一内容同时发给多家');
    assert.equal(/\.forEach\(async/.test(RUNNER_CODE), false);
    assert.match(RUNNER, /lastError/);
  });

  test('不打印任何日志（诊断只经 onAttempt 交给界面）', () => {
    assert.equal(/console\.(log|info|warn|error|debug)/.test(RUNNER_CODE), false);
    assert.equal(/hilog\.(debug|info|warn|error|fatal)/.test(RUNNER_CODE), false);
  });

  test('system 提示词与 deepseek.ets 保持一致（同一套整理约束）', () => {
    const pattern = /const SYSTEM_PROMPT: string =\s*\n?\s*'([^']+)';/;
    const deepseekPrompt = pattern.exec(DEEPSEEK);
    const runnerPrompt = pattern.exec(RUNNER);
    assert.ok(deepseekPrompt !== null && runnerPrompt !== null, '两处都要有 SYSTEM_PROMPT 常量');
    assert.equal(runnerPrompt[1], deepseekPrompt[1], '提示词漂移会让 fallback 的汇总口径与主路径不同');
  });
});

describe('设置项：三个 fallback 键成对读写', () => {
  for (const [constant, storageKey] of [
    ['KEY_AI_FALLBACK_ENABLED', 'aiFallbackEnabled'],
    ['KEY_AI_FALLBACK_MAX_ATTEMPTS', 'aiFallbackMaxAttempts'],
    ['KEY_AI_FALLBACK_ORDER', 'aiFallbackOrder']
  ]) {
    test(`${storageKey}：声明 + load 读 + save 写`, () => {
      assert.match(SETTINGS_STORE, new RegExp(`const ${constant}: string = '${storageKey}';`));
      assert.match(SETTINGS_STORE, new RegExp(`prefs\\.get\\(${constant}`));
      assert.match(SETTINGS_STORE, new RegExp(`prefs\\.put\\(${constant}`));
    });
  }

  test('默认值符合契约（false / 2 / []），坏数据回落', () => {
    assert.match(SETTINGS_STORE, /prefs\.get\(KEY_AI_FALLBACK_ENABLED,\s*false\)/);
    assert.match(SETTINGS_STORE, /prefs\.get\(KEY_AI_FALLBACK_MAX_ATTEMPTS,\s*DEFAULT_MAX_ATTEMPTS\)/);
    assert.match(SETTINGS_STORE, /prefs\.get\(KEY_AI_FALLBACK_ORDER,\s*''\)/);
    assert.match(SETTINGS_STORE, /parseFallbackOrder\(/, '落地值必须过纯函数解析（坏数据 → []）');
    assert.match(SETTINGS_STORE, /normalizeMaxAttempts\(/, '尝试次数必须夹到 1..4');
  });
});

describe('UI 组件：纯展示 + 回调，不落盘', () => {
  test('五个回调齐全（onToggle / onAdd / onRemove / onMove / onChange）', () => {
    for (const callback of ['onToggle', 'onAdd', 'onRemove', 'onMove', 'onChange']) {
      assert.match(PANEL, new RegExp(`\\b${callback}:`), `组件缺少回调 ${callback}`);
    }
  });

  test('明示「同样的内容会发给备用源」的文案，且最多 3 个', () => {
    assert.match(PANEL, /同样的内容/, '必须显式告知内容会被发给备用源');
    assert.match(PANEL, /MAX_FALLBACK_SOURCES/);
  });

  test('不做 IO（不 import settingsStore / 不写 preferences），也不带 @crossplatform', () => {
    assert.equal(/from '\.\.\/services\/settingsStore'/.test(PANEL_CODE), false, '组件只做展示 + 回调');
    assert.equal(/preferences|@kit\./.test(PANEL_CODE), false);
    assert.equal(/@crossplatform/.test(PANEL_CODE), false, 'ArkUI-X 26 编译器不认识该装饰器');
  });
});

describe('文档：决策表与隐私说明已落盘', () => {
  test('docs/AI-FALLBACK.md 覆盖决策表每一行 + 隐私红线', () => {
    for (const fragment of ['401', '403', '429', '超时', '网络', '5xx', '解析', 'abort', 'next-source']) {
      assert.ok(DOC.includes(fragment), `决策表缺少「${fragment}」`);
    }
    assert.ok(DOC.includes('未开启'), '必须写明未开启时绝不外发');
    assert.ok(DOC.includes('不落盘') || DOC.includes('只在内存'), '必须写明诊断不落盘');
    assert.ok(DOC.includes('***'), '必须写明脱敏规则');
  });
});
