// DeepSeek 请求/响应的纯逻辑（`model/aiRequest.ts`）测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖：
// 1. `buildAiRequest` 的 URL 拼接与请求体（model + prompt + temperature/max_tokens/stream）；
// 2. `AiOptions` 参数体系（默认 0.7 / 1024 / 30000 / 1、逐字段覆盖、非法值夹取）；
// 3. `classifyAiError` 的中文错误映射（401/402/403/404/429/5xx/超时/网络异常）；
// 4. `shouldRetry`（网络 / 429 / 5xx）与 `shouldFallback`（超时/网络/429/5xx 才切源）；
// 5. `runWithFallback` 只切一次备用源（含「不切第三次」与「确定性错误不切」）；
// 6. `parseAiReply` / `parseAiReplyFull` / `parseUsage` / `describeUsage`；
// 7. `clampAiTimeout`：整体超时的有效下限 = 连接超时 + 1s（C 批：超时加固）。
//
// 该模块没有任何运行时 import，因此不需要 registerHooks 补 `.js` 后缀。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const {
  AI_CONNECT_TIMEOUT_MS,
  AI_DEFAULT_MAX_TOKENS,
  AI_DEFAULT_RETRIES,
  AI_DEFAULT_TEMPERATURE,
  AI_MAX_MAX_TOKENS,
  AI_MAX_RETRIES,
  AI_MAX_TEMPERATURE,
  AI_MAX_TIMEOUT_MS,
  AI_MIN_MAX_TOKENS,
  AI_MIN_RETRIES,
  AI_MIN_TEMPERATURE,
  AI_MIN_TIMEOUT_MS,
  AI_MIN_TOTAL_TIMEOUT_MS,
  AI_PROBE_MAX_TOKENS,
  AI_PROBE_PROMPT,
  AI_READ_TIMEOUT_MS,
  AI_RETRY_BACKOFF_MS,
  AI_SESSION_HEADER,
  AI_STATUS_NETWORK,
  AI_STATUS_TIMEOUT,
  AI_TIMEOUT_MS,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  AiFallbackError,
  AiModelRefusalError,
  AiRouteRefusalError,
  aiChatUrl,
  aiModelRefusalError,
  aiRouteRefusalError,
  buildAiRequest,
  clampAiTimeout,
  classifyAiError,
  currentAiSessionId,
  defaultAiOptions,
  describeAiTestResult,
  describeUsage,
  isAiModelRefusal,
  isAiRouteRefusal,
  newAiSessionId,
  normalizeAiOptions,
  restartAiSession,
  parseAiReply,
  parseAiReplyFull,
  parseUsage,
  runWithFallback,
  shouldFallback,
  shouldRetry
} = await import('../.build/model/aiRequest.js');

/** 构造一次尝试结果（runWithFallback 的注入桩）。 */
function attempt(overrides = {}) {
  return {
    ok: true,
    status: 200,
    text: '正文',
    error: '',
    usage: null,
    elapsedMs: 10,
    providerId: 'deepseek',
    model: 'deepseek-chat',
    ...overrides
  };
}

describe('buildAiRequest：URL 与请求体构造', () => {
  test('默认基地址拼出 /chat/completions，请求体含 model 与 prompt', () => {
    const request = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, '请把今天的日程整理一下');
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.timeoutMs, AI_TIMEOUT_MS);
    assert.equal(AI_TIMEOUT_MS, 30000, '整体超时默认 30 秒（B2）');

    const body = JSON.parse(request.body);
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[0].content, '请把今天的日程整理一下');
    assert.equal(body.max_tokens, AI_DEFAULT_MAX_TOKENS);
    assert.equal(body.temperature, AI_DEFAULT_TEMPERATURE);
    assert.equal(body.stream, false);
  });

  test('基地址末尾多余斜杠被去掉；已含 /chat/completions 时原样使用', () => {
    assert.equal(
      buildAiRequest('https://api.deepseek.com///', 'deepseek-chat', 'ping').url,
      'https://api.deepseek.com/chat/completions'
    );
    assert.equal(
      buildAiRequest('https://api.deepseek.com/chat/completions', 'deepseek-chat', 'ping').url,
      'https://api.deepseek.com/chat/completions'
    );
    assert.equal(
      buildAiRequest('  https://proxy.example.com/v1  ', 'deepseek-chat', 'ping').url,
      'https://proxy.example.com/v1/chat/completions'
    );
  });

  test('模型名空串回退 deepseek-chat；自定义模型名原样保留', () => {
    assert.equal(JSON.parse(buildAiRequest(DEFAULT_AI_BASE_URL, '  ', 'ping').body).model, 'deepseek-chat');
    assert.equal(
      JSON.parse(buildAiRequest(DEFAULT_AI_BASE_URL, 'deepseek-reasoner', 'ping').body).model,
      'deepseek-reasoner'
    );
  });

  test('连通性测试的最小请求：prompt=ping、max_tokens=8', () => {
    const options = { ...defaultAiOptions(), maxTokens: AI_PROBE_MAX_TOKENS, retries: 0 };
    const request = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, AI_PROBE_PROMPT, options);
    const body = JSON.parse(request.body);
    assert.equal(AI_PROBE_MAX_TOKENS, 8);
    assert.equal(body.messages[0].content, 'ping');
    assert.equal(body.max_tokens, 8);
    assert.equal(request.retries, 0, '连通性测试自己控制重试，请求层不重试');
  });

  test('可选 system 消息排在第一，user 在后', () => {
    const request = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, '正文', null, '你是整理助手');
    const body = JSON.parse(request.body);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, '你是整理助手');
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[1].content, '正文');
  });

  test('空基地址 / 非 http(s) 基地址 / 空 prompt 都抛中文错误', () => {
    assert.throws(() => buildAiRequest('', 'deepseek-chat', 'ping'), /接口地址不能为空/);
    assert.throws(() => buildAiRequest('api.deepseek.com', 'deepseek-chat', 'ping'), /http/);
    assert.throws(() => buildAiRequest(DEFAULT_AI_BASE_URL, 'deepseek-chat', ''), /提示词不能为空/);
    assert.throws(() => buildAiRequest(DEFAULT_AI_BASE_URL, 'deepseek-chat', '   '), /提示词不能为空/);
    assert.throws(() => aiChatUrl('  '), /接口地址不能为空/);
  });
});

describe('AiOptions：默认 0.7 / 1024 / 30000 / 1', () => {
  test('默认值逐项钉住，且每次返回新对象', () => {
    assert.equal(AI_DEFAULT_TEMPERATURE, 0.7);
    assert.equal(AI_DEFAULT_MAX_TOKENS, 1024);
    assert.equal(AI_TIMEOUT_MS, 30000);
    assert.equal(AI_DEFAULT_RETRIES, 1);
    assert.deepEqual(defaultAiOptions(), {
      temperature: 0.7,
      maxTokens: 1024,
      timeoutMs: 30000,
      retries: 1
    });
    const first = defaultAiOptions();
    const second = defaultAiOptions();
    assert.notStrictEqual(first, second, '不能把共享常量对象交给调用方修改');
  });

  test('null/undefined 归一为默认值', () => {
    assert.deepEqual(normalizeAiOptions(null), defaultAiOptions());
    assert.deepEqual(normalizeAiOptions(undefined), defaultAiOptions());
  });

  test('传入覆盖逐字段生效', () => {
    const options = normalizeAiOptions({
      temperature: 0.2,
      maxTokens: 512,
      timeoutMs: 8000,
      retries: 0
    });
    assert.deepEqual(options, { temperature: 0.2, maxTokens: 512, timeoutMs: 8000, retries: 0 });
  });

  test('越界/NaN/类型错误夹到边界或回落默认', () => {
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), temperature: 9 }).temperature, AI_MAX_TEMPERATURE);
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), temperature: -1 }).temperature, AI_MIN_TEMPERATURE);
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), temperature: Number.NaN }).temperature, 0.7);
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), maxTokens: 0 }).maxTokens, AI_MIN_MAX_TOKENS);
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), maxTokens: 1e9 }).maxTokens, AI_MAX_MAX_TOKENS);
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), maxTokens: 12.9 }).maxTokens, 12, '取整');
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), timeoutMs: 10 }).timeoutMs, AI_MIN_TIMEOUT_MS);
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), timeoutMs: 1e9 }).timeoutMs, AI_MAX_TIMEOUT_MS);
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), retries: -1 }).retries, AI_MIN_RETRIES);
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), retries: 99 }).retries, AI_MAX_RETRIES);
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), retries: 1.8 }).retries, 1);
    // 字段缺失（老调用点只传了部分字段）
    assert.deepEqual(normalizeAiOptions({ temperature: 0.1 }), { ...defaultAiOptions(), temperature: 0.1 });
  });

  test('buildAiRequest 把 options 写进请求体与请求对象', () => {
    const request = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, 'ping', {
      temperature: 0.3,
      maxTokens: 512,
      timeoutMs: 12000,
      retries: 2
    });
    const body = JSON.parse(request.body);
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.stream, false, '必须显式关闭流式，否则拿不到一次性 JSON');
    assert.equal(request.timeoutMs, 12000);
    assert.equal(request.retries, 2);
  });
});

describe('classifyAiError：HTTP 状态 → 中文文案', () => {
  test('401 密钥无效 / 402 余额不足 / 403 无权限 / 404 接口不存在', () => {
    assert.match(classifyAiError(401, ''), /密钥无效/);
    assert.match(classifyAiError(401, ''), /AI 服务 401/);
    assert.match(classifyAiError(401, ''), /设置页/);
    assert.match(classifyAiError(402, ''), /余额不足/);
    assert.match(classifyAiError(403, ''), /无访问权限/);
    assert.match(classifyAiError(404, ''), /接口不存在/);
  });

  test('429 限流与 5xx 服务端错误', () => {
    assert.match(classifyAiError(429, ''), /请求过于频繁|额度超限/);
    assert.match(classifyAiError(429, ''), /AI 服务 429/);
    for (const status of [500, 502, 503, 504]) {
      assert.match(classifyAiError(status, ''), /服务端错误/);
      assert.match(classifyAiError(status, ''), new RegExp(`AI 服务 ${status}`));
    }
  });

  test('超时与网络异常使用伪状态码，也给出中文原因', () => {
    assert.match(classifyAiError(AI_STATUS_TIMEOUT, ''), /请求超时/);
    assert.match(classifyAiError(AI_STATUS_TIMEOUT, ''), /30 秒/);
    assert.match(classifyAiError(AI_STATUS_NETWORK, ''), /网络异常/);
    assert.match(classifyAiError(AI_STATUS_NETWORK, 'socket hang up'), /socket hang up/);
  });

  test('200 没有错误；400/422 参数类错误也有文案', () => {
    assert.equal(classifyAiError(200, ''), '');
    assert.match(classifyAiError(400, ''), /请求无效/);
    assert.match(classifyAiError(422, ''), /参数错误/);
    assert.match(classifyAiError(418, ''), /AI 服务 418/);
  });

  test('响应体里的 error.message 会被提取，非 JSON 则截断原文', () => {
    const json = JSON.stringify({ error: { message: 'Authentication Fails (invalid api key)' } });
    assert.match(classifyAiError(401, json), /Authentication Fails/);
    const long = 'x'.repeat(400);
    const banner = classifyAiError(503, long);
    assert.ok(banner.length < long.length + 40, '过长的响应体必须截断');
    assert.match(banner, /…/);
  });

  test('默认文案是中性的「AI 服务」，不含任何服务商名', () => {
    for (const status of [400, 401, 402, 403, 404, 422, 429, 418, 500, 503]) {
      const text = classifyAiError(status, '');
      assert.equal(text.includes('DeepSeek'), false, `HTTP ${status} 仍写着 DeepSeek`);
      assert.match(text, /^AI 服务/, `HTTP ${status} 少了中性前缀`);
    }
    for (const status of [AI_STATUS_NETWORK, AI_STATUS_TIMEOUT]) {
      assert.equal(classifyAiError(status, '').includes('DeepSeek'), false);
    }
    assert.equal(describeAiTestResult(false, 429, 'deepseek-chat', '').includes('DeepSeek'), false);
  });

  test('providerLabel 覆盖源名，空白回退中性前缀', () => {
    assert.match(classifyAiError(401, '', 'OpenCode Go'), /^OpenCode Go 401：密钥无效/);
    assert.match(classifyAiError(503, '', 'Codex API'), /^Codex API 503：服务端错误/);
    assert.match(classifyAiError(AI_STATUS_NETWORK, '', 'DeepSeek 官方'), /^DeepSeek 官方 网络异常/);
    assert.match(classifyAiError(429, '', '   '), /^AI 服务 429/);
  });
});

describe('shouldRetry：只有网络错误 / 429 / 5xx 值得退避重试', () => {
  test('可重试：网络错误、429、5xx', () => {
    assert.equal(shouldRetry(AI_STATUS_NETWORK), true);
    assert.equal(shouldRetry(429), true);
    for (const status of [500, 502, 503, 504, 599]) {
      assert.equal(shouldRetry(status), true, `HTTP ${status} 应重试`);
    }
  });

  test('不重试：超时、2xx、确定性 4xx', () => {
    assert.equal(shouldRetry(AI_STATUS_TIMEOUT), false, '30 秒超时再等一轮只会让用户白等');
    assert.equal(shouldRetry(200), false);
    for (const status of [400, 401, 402, 403, 404, 422]) {
      assert.equal(shouldRetry(status), false, `HTTP ${status} 重试没有意义`);
    }
  });

  test('退避时长是 1 秒（默认只重试一次）', () => {
    assert.equal(AI_RETRY_BACKOFF_MS, 1000);
  });
});

describe('shouldFallback：换源有没有用（表驱动）', () => {
  const cases = [
    [-1, true],
    [0, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [599, true],
    [401, false],
    [403, false],
    [404, false],
    [400, false]
  ];
  for (const [status, expected] of cases) {
    test(`HTTP ${status} → ${expected}`, () => {
      assert.equal(shouldFallback(status), expected);
    });
  }

  test('2xx / 其它未列出 4xx 默认不切源', () => {
    assert.equal(shouldFallback(200), false);
    assert.equal(shouldFallback(402), false);
    assert.equal(shouldFallback(422), false);
  });
});

describe('runWithFallback：只切一次备用源', () => {
  test('主源成功：一次调用、usedFallback=false', async () => {
    let calls = 0;
    const outcome = await runWithFallback(async () => {
      calls++;
      return attempt();
    }, async () => {
      calls++;
      return attempt({ providerId: 'openrouter' });
    });
    assert.equal(calls, 1);
    assert.equal(outcome.usedFallback, false);
    assert.equal(outcome.providerId, 'deepseek');
    assert.equal(outcome.text, '正文');
    assert.equal(outcome.primaryError, '');
  });

  test('主源超时 → 备用成功：恰好切 1 次（共 2 次调用）', async () => {
    let calls = 0;
    const outcome = await runWithFallback(
      async () => {
        calls++;
        return attempt({ ok: false, status: AI_STATUS_TIMEOUT, text: '', error: '主源超时' });
      },
      async () => {
        calls++;
        return attempt({ providerId: 'openrouter', model: 'deepseek/deepseek-chat', elapsedMs: 20 });
      }
    );
    assert.equal(calls, 2, '只允许切换一次');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.usedFallback, true);
    assert.equal(outcome.providerId, 'openrouter');
    assert.equal(outcome.elapsedMs, 30, '总耗时 = 主源 + 备用源');
    assert.equal(outcome.primaryError, '主源超时');
    assert.equal(outcome.fallbackError, '');
  });

  test('主源 5xx → 备用也失败：只切一次，抛 AiFallbackError 且带两段原因', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        runWithFallback(
          async () => {
            calls++;
            return attempt({ ok: false, status: 503, text: '', error: '主源 503' });
          },
          async () => {
            calls++;
            return attempt({ ok: false, status: 0, providerId: 'custom', text: '', error: '备用网络异常' });
          }
        ),
      (error) => {
        assert.ok(error instanceof AiFallbackError);
        assert.match(error.message, /主源 503/);
        assert.match(error.message, /备用源 custom 也失败/);
        assert.match(error.message, /备用网络异常/);
        assert.equal(error.primaryMessage, '主源 503');
        assert.equal(error.fallbackMessage, '备用网络异常');
        assert.equal(error.status, 0);
        assert.equal(error.fallbackProviderId, 'custom');
        return true;
      }
    );
    assert.equal(calls, 2, '不得尝试第三次');
  });

  test('主源 401 不切源（换源也没用）', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        runWithFallback(
          async () => {
            calls++;
            return attempt({ ok: false, status: 401, text: '', error: '主源 401 密钥无效' });
          },
          async () => {
            calls++;
            return attempt({ providerId: 'openrouter' });
          }
        ),
      /主源 401 密钥无效/
    );
    assert.equal(calls, 1);
  });

  test('没配备用源：直接抛主源错误（不空转）', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        runWithFallback(async () => {
          calls++;
          return attempt({ ok: false, status: 429, text: '', error: '主源限流' });
        }, null),
      /主源限流/
    );
    assert.equal(calls, 1);
  });
});

describe('parseAiReply：取 choices[0].message.content', () => {
  test('正常回复返回 trim 后的正文', () => {
    const text = JSON.stringify({
      id: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: '  今天的重点：周会  ' }, finish_reason: 'stop' }]
    });
    assert.equal(parseAiReply(text), '今天的重点：周会');
  });

  test('缺 choices / choices 为空 / 缺 message / 缺 content 各有明确中文错误', () => {
    assert.throws(() => parseAiReply('{"id":"x"}'), /缺少 choices/);
    assert.throws(() => parseAiReply('{"choices":[]}'), /缺少 choices/);
    assert.throws(() => parseAiReply('{"choices":[{"index":0}]}'), /choices\[0\]\.message/);
    assert.throws(() => parseAiReply('{"choices":[{"message":{"role":"assistant"}}]}'), /content/);
    assert.throws(() => parseAiReply('{"choices":[{"message":{"content":123}}]}'), /content/);
  });

  test('content 为空（含纯空白）与空响应体', () => {
    assert.throws(() => parseAiReply('{"choices":[{"message":{"content":""}}]}'), /为空/);
    assert.throws(() => parseAiReply('{"choices":[{"message":{"content":"   "}}]}'), /为空/);
    assert.throws(() => parseAiReply(''), /响应体为空/);
    assert.throws(() => parseAiReply('   '), /响应体为空/);
  });

  test('非 JSON（网关 HTML / 被截断的 JSON）给中文错误', () => {
    assert.throws(() => parseAiReply('<html>502 Bad Gateway</html>'), /不是合法 JSON/);
    assert.throws(() => parseAiReply('{"choices":[{"message":{"content":"abc"'), /不是合法 JSON/);
    assert.throws(() => parseAiReply('null'), /缺少 choices/);
  });

  test('带 error 字段的错误响应不会被当成正常回复', () => {
    const errorBody = JSON.stringify({ error: { message: 'quota exceeded', type: 'insufficient_quota' } });
    assert.throws(() => parseAiReply(errorBody), /quota exceeded/);
  });
});

describe('usage：解析与展示（B4）', () => {
  test('parseAiReplyFull 同时给出正文、usage 与 finish_reason', () => {
    const text = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '摘要' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 }
    });
    const reply = parseAiReplyFull(text);
    assert.equal(reply.text, '摘要');
    assert.equal(reply.finishReason, 'stop');
    assert.deepEqual(reply.usage, { promptTokens: 120, completionTokens: 340, totalTokens: 460 });
  });

  test('没有 usage / 全 0 时 usage 为 null', () => {
    assert.equal(parseUsage('{"choices":[]}'), null);
    assert.equal(parseUsage(''), null);
    assert.equal(parseUsage('not-json'), null);
    assert.equal(parseUsage('{"usage":{}}'), null);
    assert.equal(parseUsage('{"usage":{"prompt_tokens":0,"completion_tokens":0}}'), null);
    assert.equal(parseAiReplyFull('{"choices":[{"message":{"content":"x"}}]}').usage, null);
  });

  test('total_tokens 缺失时用输入+输出补，负数归 0', () => {
    assert.deepEqual(parseUsage('{"usage":{"prompt_tokens":10,"completion_tokens":5}}'), {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15
    });
    assert.deepEqual(parseUsage('{"usage":{"prompt_tokens":-3,"completion_tokens":5.9}}'), {
      promptTokens: 0,
      completionTokens: 5,
      totalTokens: 5
    });
  });

  test('describeUsage → 「输入 120 / 输出 340 tokens」', () => {
    assert.equal(describeUsage({ promptTokens: 120, completionTokens: 340, totalTokens: 460 }), '输入 120 / 输出 340 tokens');
    assert.equal(describeUsage(null), '');
    assert.equal(describeUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }), '');
    assert.equal(describeUsage({ promptTokens: 7, completionTokens: 0, totalTokens: 7 }), '输入 7 / 输出 0 tokens');
  });
});

describe('describeAiTestResult：设置页「测试 AI 连通性」文案', () => {
  test('成功文案含状态码与模型名', () => {
    const message = describeAiTestResult(true, 200, 'deepseek-chat', '');
    assert.equal(message, '成功：HTTP 200 / 模型 deepseek-chat');
  });

  test('失败文案优先用传入的中文原因，其次回落到状态码映射', () => {
    assert.equal(
      describeAiTestResult(false, 401, 'deepseek-chat', '密钥无效（HTTP 401）：DeepSeek API Key 不正确'),
      '失败：密钥无效（HTTP 401）：DeepSeek API Key 不正确'
    );
    assert.match(describeAiTestResult(false, 429, 'deepseek-chat', ''), /^失败：.*AI 服务 429/);
    assert.match(describeAiTestResult(false, AI_STATUS_TIMEOUT, '', ''), /^失败：.*请求超时/);
    assert.match(describeAiTestResult(true, 200, '', ''), /deepseek-chat/, '空模型名回退默认值');
  });
});

// ---------------------------------------------------------------- 超时的有效下限（C 批）
//
// 现象（`docs/FAILURE-MODES.md` §3）：`services/deepseek.ets` 里 `CONNECT_TIMEOUT_MS=20000`、
// `READ_TIMEOUT_MS=120000`，但整体超时是 `Promise.race` 的另一条分支，用的是 `request.timeoutMs`
// （默认 30s）。谁先到谁生效 → 用户把超时填成 3s 时，20s 的连接超时**永远不可达**。
// 修法：发请求前过 `clampAiTimeout`，把有效下限钳到「连接超时 + 1s」。
//
// 这里锁死三件事：
//   ① 下限是**从常量推导**的（`AI_CONNECT_TIMEOUT_MS + 1000`），不是散落的字面量；
//   ② 非法/未设 → 默认值；0/负数/小于下限 → 抬到下限；超过上限 → 夹到上限；
//   ③ 解析层（`normalizeAiOptions`）的 1s–180s 契约不变（有效下限只在发请求前收紧）。

describe('clampAiTimeout：整体超时的有效下限 = 连接超时 + 1s', () => {
  test('① 下限由导出的连接超时常量推导（不允许出现第二个 20000）', () => {
    assert.equal(AI_CONNECT_TIMEOUT_MS, 20000, '连接超时 20s（与 services 层同一份来源）');
    assert.equal(AI_READ_TIMEOUT_MS, 120000, '读超时 120s（同上）');
    assert.equal(
      AI_MIN_TOTAL_TIMEOUT_MS,
      AI_CONNECT_TIMEOUT_MS + 1000,
      '下限必须是「连接超时 + 1000」算出来的，不能是写字面量'
    );
    assert.ok(AI_MIN_TOTAL_TIMEOUT_MS > AI_CONNECT_TIMEOUT_MS, '整体超时必须大于连接超时，否则连接超时不可达');
    assert.ok(AI_MIN_TOTAL_TIMEOUT_MS <= AI_MAX_TIMEOUT_MS, '下限不能超过上限');
    assert.ok(AI_TIMEOUT_MS >= AI_MIN_TOTAL_TIMEOUT_MS, '默认 30s 必须满足下限（否则默认值一上线就被改）');
  });

  test('② 非法/未设 → 默认值（没配就是默认，不是下限）', () => {
    const illegal = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '30000', {}, []];
    for (const raw of illegal) {
      assert.equal(clampAiTimeout(raw), AI_TIMEOUT_MS, `非法输入 ${String(raw)} 应回落默认值`);
    }
    assert.equal(clampAiTimeout(), AI_TIMEOUT_MS, '不传参数 = 未设 = 默认值');
  });

  test('② 0 / 负数 / 小于下限 → 抬到下限（用户显式填了「很小」）', () => {
    const tooSmall = [0, -1, -1000, 1, 999, 10000, AI_MIN_TOTAL_TIMEOUT_MS - 1];
    for (const raw of tooSmall) {
      assert.equal(clampAiTimeout(raw), AI_MIN_TOTAL_TIMEOUT_MS, `${raw} 应抬到下限`);
    }
  });

  test('② 等于下限 / 正常值 → 原样（只取整，不夹）', () => {
    assert.equal(clampAiTimeout(AI_MIN_TOTAL_TIMEOUT_MS), AI_MIN_TOTAL_TIMEOUT_MS);
    assert.equal(clampAiTimeout(AI_TIMEOUT_MS), AI_TIMEOUT_MS);
    assert.equal(clampAiTimeout(45000), 45000);
    assert.equal(clampAiTimeout(45000.9), 45000, '毫秒向下取整');
  });

  test('② 超过上限 → 夹到 AI_MAX_TIMEOUT_MS（沿用既有上限，不另造）', () => {
    assert.equal(clampAiTimeout(AI_MAX_TIMEOUT_MS), AI_MAX_TIMEOUT_MS);
    assert.equal(clampAiTimeout(AI_MAX_TIMEOUT_MS + 1), AI_MAX_TIMEOUT_MS);
    assert.equal(clampAiTimeout(1e9), AI_MAX_TIMEOUT_MS);
  });

  test('② 任何输入都落在 [下限, 上限] 且是整数（不会把 NaN 写进计时器）', () => {
    const samples = [-1e9, -1, 0, 1, 12345, AI_MIN_TOTAL_TIMEOUT_MS - 1, AI_MIN_TOTAL_TIMEOUT_MS, 6e8, Number.MAX_SAFE_INTEGER];
    for (const raw of samples) {
      const value = clampAiTimeout(raw);
      assert.equal(Number.isFinite(value), true, `${raw} → 必须是有限数`);
      assert.equal(Number.isInteger(value), true, `${raw} → 必须是整数`);
      assert.ok(value >= AI_MIN_TOTAL_TIMEOUT_MS, `${raw} → 不得低于下限：${value}`);
      assert.ok(value <= AI_MAX_TIMEOUT_MS, `${raw} → 不得高于上限：${value}`);
    }
  });

  test('③ 解析层契约不变：normalizeAiOptions 仍是 1s–180s（有效下限在发请求前才收紧）', () => {
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), timeoutMs: 10 }).timeoutMs, AI_MIN_TIMEOUT_MS);
    assert.equal(normalizeAiOptions({ ...defaultAiOptions(), timeoutMs: 30000 }).timeoutMs, 30000);
    // 解析层放过的 1s，发请求前会被 clampAiTimeout 抬起来 —— 两者是「输入夹取」与「有效值」两层
    assert.equal(clampAiTimeout(AI_MIN_TIMEOUT_MS), AI_MIN_TOTAL_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------- OpenCode Go live-test fix
//
// 线上 400 `request is missing x-opencode-session and cannot be routed`：官方 Console 文档
// `/docs/console/harnesses#sessions` 要求 Go 每条请求都带一个**稳定**的会话 id（路由 + prompt cache）。
// 本应用没有跨请求聊天会话概念，故把「会话」定为一次应用运行（进程内单例，懒生成，重启换新）：
// 同一会话内连续请求 / 重试链复用同一个 UUID v4；不写仓库、不写日志、不含 key。

const ETS_SRC = new URL('../../entry/src/main/ets/', import.meta.url);
const DEEPSEEK_SRC = readFileSync(new URL('services/deepseek.ets', ETS_SRC), 'utf8');
const FALLBACK_SRC = readFileSync(new URL('services/aiFallbackRunner.ets', ETS_SRC), 'utf8');
const AI_REQUEST_SRC = readFileSync(new URL('model/aiRequest.ts', ETS_SRC), 'utf8');

/**
 * 凭据前缀只在断言里**拼**出来：测试源码不出现连续的 key 前缀字面量，
 * 免得凭据扫描把「断言里写的反例」误判成夹具里藏了一把真 key。
 */
const KEYISH = new RegExp(['bearer', String.fromCharCode(115, 107, 45), ['oc', '_', 'sk_'].join('')].join('|'), 'i');

describe('x-opencode-session：会话级 UUID v4', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test('头名常量与官方一致；UUID v4 合法、每次新生成都不同、不含 key', () => {
    assert.equal(AI_SESSION_HEADER, 'x-opencode-session');
    const id = newAiSessionId();
    assert.match(id, UUID_V4);
    assert.notEqual(id, newAiSessionId(), '不能是写死的常量');
    assert.equal(KEYISH.test(id), false, '会话 id 不是密钥');
  });

  test('同一会话：连续请求与整条重试链复用同一个 sessionId', () => {
    const initial = restartAiSession();
    const first = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, 'ping');
    const second = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, '另一条汇总');
    assert.match(first.sessionId, UUID_V4);
    assert.equal(first.sessionId, initial, '第一个请求用当前会话 id');
    assert.equal(second.sessionId, first.sessionId, 'successive requests in one session 必须同 id');
    for (let retry = 0; retry < 3; retry++) {
      assert.equal(first.sessionId, currentAiSessionId(), `重试 ${retry + 1} 必须复用同一会话 id`);
      assert.equal(buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, 'ping').sessionId, first.sessionId);
    }
  });

  test('模拟应用重启：换新会话 id，之后的请求都用新值', () => {
    const before = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, 'ping').sessionId;
    const restarted = restartAiSession();
    const after = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, 'ping').sessionId;
    assert.match(restarted, UUID_V4);
    assert.notEqual(restarted, before, '重启必须换 id（证明它是会话 id，不是常量）');
    assert.equal(after, restarted);
  });

  test('sessionId 只走 HTTP 头：不进请求体、不与 key 混在一起', () => {
    const request = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, 'ping');
    assert.equal(KEYISH.test(request.sessionId), false);
    const body = JSON.parse(request.body);
    assert.equal('sessionId' in body, false, '会话头不能写进请求体');
    assert.equal(body.session_id, undefined);
    assert.equal(JSON.stringify(body).includes(request.sessionId), false);
  });
});

describe('服务层：两条 HTTP 调用路径都发送 x-opencode-session（源码断言）', () => {
  test('deepseek.ets 与 aiFallbackRunner.ets 各自恰好一处会话头，值取 request.sessionId', () => {
    for (const [name, src] of [
      ['deepseek.ets', DEEPSEEK_SRC],
      ['aiFallbackRunner.ets', FALLBACK_SRC]
    ]) {
      const lines = src.split('\n').filter((line) => line.includes("'x-opencode-session'"));
      assert.equal(lines.length, 1, `${name} 应恰好一处会话头，实际 ${lines.length}`);
      assert.match(lines[0], /'x-opencode-session': request\.sessionId/);
      assert.equal(/apiKey|Bearer|\bkey\b/i.test(lines[0]), false, `${name} 会话头不得拼 key：${lines[0]}`);
    }
  });

  test('sessionId 由模型层单例生成，服务层不另造 UUID', () => {
    assert.match(AI_REQUEST_SRC, /sessionId: currentAiSessionId\(\)/);
    assert.match(DEEPSEEK_SRC, /await attemptOnce\(apiKey, request, route\)/, '重试链复用同一个 request 对象');
    assert.match(FALLBACK_SRC, /sendOnce\(key, request\)/);
    assert.equal(/randomUUID|newAiSessionId\(\)/.test(DEEPSEEK_SRC), false, '服务层不生成自己的会话 id');
    assert.equal(/randomUUID|newAiSessionId\(\)/.test(FALLBACK_SRC), false);
  });

  test('日志未变：只有 provider/model/latency/ok；会话值与 key 都不打印', () => {
    assert.match(DEEPSEEK_SRC, /console\.info\('\[ai\] provider=%s model=%s latency=%dms ok=%s'/);
    assert.equal(/console\.(log|info|warn|error|debug)[^\n]*session/i.test(DEEPSEEK_SRC), false);
    assert.equal(/console\.(log|info|warn|error|debug)/.test(FALLBACK_SRC), false, 'fallback 运行器本来就没有日志');
  });
});

describe('网关路由拒绝：类型化错误 + 中文可操作文案', () => {
  const RAW = 'request is missing x-opencode-session and cannot be routed';

  test('只把 400 + 路由特征判为拒绝，普通 400 / 其它状态不误判', () => {
    assert.equal(isAiRouteRefusal(400, RAW), true);
    assert.equal(isAiRouteRefusal(400, JSON.stringify({ error: { message: 'invalid model' } })), false);
    assert.equal(isAiRouteRefusal(400, ''), false);
    assert.equal(isAiRouteRefusal(401, RAW), false);
    assert.equal(isAiRouteRefusal(500, RAW), false);
  });

  test('工厂产出 AiRouteRefusalError：中文可操作 + status/code 诊断，不回显原始 body', () => {
    const codeBody = JSON.stringify({ error: { code: 'route_missing_session', message: RAW } });
    const refusal = aiRouteRefusalError(400, codeBody, 'OpenCode Go');
    assert.ok(refusal instanceof AiRouteRefusalError);
    assert.ok(refusal instanceof Error);
    assert.equal(refusal.name, 'AiRouteRefusalError');
    assert.equal(refusal.status, 400, '原始状态码留给诊断');
    assert.equal(refusal.code, 'route_missing_session', '错误码留给诊断');
    assert.match(refusal.message, /^OpenCode Go 400/);
    assert.match(refusal.message, /会话标识/);
    assert.match(refusal.message, /网关无法路由/);
    assert.match(refusal.message, /请重试/);
    assert.match(refusal.message, /切换其它 AI 源/);
    assert.equal(refusal.message.includes(RAW), false, '不回显网关原始响应文案');
    assert.equal(KEYISH.test(refusal.message), false, '错误文案不含 key');
  });

  test('非拒绝返回 null；classifyAiError 走类型化文案，普通 400 文案不变', () => {
    assert.equal(aiRouteRefusalError(400, 'invalid model', 'OpenCode Go'), null);
    const text = classifyAiError(400, RAW, 'OpenCode Go');
    assert.match(text, /会话标识/);
    assert.match(text, /网关无法路由/);
    assert.match(text, /请重试/);
    assert.equal(text.includes(RAW), false, '不把原始 body 摊给用户');
    assert.match(classifyAiError(400, '', 'OpenCode Go'), /请求无效/, '普通 400 保持原样');
  });

  test('服务层：单源抛类型化错误，多源用同一类型化文案（保留不抛契约）', () => {
    assert.match(DEEPSEEK_SRC, /const refusal = aiRouteRefusalError\(outcome\.status, outcome\.body, providerLabel\)/);
    assert.match(DEEPSEEK_SRC, /throw refusal;/);
    assert.match(FALLBACK_SRC, /aiRouteRefusalError\(response\.status, response\.body, preset\.label\)/);
    assert.match(FALLBACK_SRC, /refusal !== null\s*\?\s*refusal\.message/);
  });
});

// ---------------------------------------------------------------- OpenCode Go live-test 400 的模型拒绝修复
//
// 会话头修复后线上仍报 400「请求无效，请检查模型名 / ai_generate」。排查结论：模型 slug
// deepseek-v4.1-flash 是官方 id（不加 opencode/ 前缀），真正错的是端点路径：Go 网关的
// Chat Completions 在 /inference/go/openai/v1，旧预设 /inference/go/v1 只服务 /models。
// 这里钉住修正后的请求形状 + 兜底的类型化文案（万一服务端仍拒模型，用户能一眼看到源与模型）。

describe('OpenCode Go 请求形状：fake request 的 body 恰好五个键，无额外字段', () => {
  test('POST 体逐字钉住 model / messages / temperature / max_tokens / stream', () => {
    const request = buildAiRequest(
      'https://opencode.ai/inference/go/openai/v1',
      'deepseek-v4.1-flash',
      'ping',
      { ...defaultAiOptions(), maxTokens: 8, retries: 0 }
    );
    assert.equal(request.url, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
    const body = JSON.parse(request.body);
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
    assert.equal(body.model, 'deepseek-v4.1-flash');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'ping' }]);
    assert.equal(body.temperature, 0.7);
    assert.equal(body.max_tokens, 8, 'DeepSeek/OpenCode 兼容端点用 max_tokens，不是 max_completion_tokens');
    assert.equal(body.stream, false, '必须一次性拿 JSON，不能开流');
    for (const extra of ['reasoning_effort', 'top_p', 'session_id', 'apiKey', 'key']) {
      assert.equal(extra in body, false, `请求体不该出现额外字段 ${extra}`);
    }
    assert.equal(JSON.stringify(body).includes(request.sessionId), false, '会话 id 只走 HTTP 头');
  });

  test('服务层两条路径都带 Content-Type / Bearer 头模板 / x-opencode-session（源码断言）', () => {
    for (const [name, src] of [
      ['deepseek.ets', DEEPSEEK_SRC],
      ['aiFallbackRunner.ets', FALLBACK_SRC]
    ]) {
      assert.match(src, /'Content-Type': 'application\/json'/, `${name} 缺 Content-Type`);
      assert.equal(/'Authorization': `Bearer \$\{apiKey\}`/.test(src), true, `${name} 的 Authorization 必须是 Bearer 模板`);
      assert.equal(/'x-opencode-session': request\.sessionId/.test(src), true, `${name} 缺会话头`);
    }
  });
});

describe('模型拒绝：类型化文案同时点名 provider + model，不回显原始 body', () => {
  // 线上响应体的形状（只含错误码与文案，绝不含 key），用于判定与「不回显」回归。
  const RAW_MODEL_400 = JSON.stringify({ error: { code: 'ai_generate', message: '请求无效，请检查模型名' } });
  const TYPED =
    'AI 服务拒绝了请求（provider=opencode-go，model=deepseek-v4.1-flash）：模型名无效或该源不支持该模型，请在设置里改选模型或切换 AI 源。';

  test('只把 400/404/422 + 模型特征判为模型拒绝，路由拒绝与普通 400 不误判', () => {
    assert.equal(isAiModelRefusal(400, RAW_MODEL_400), true);
    assert.equal(isAiModelRefusal(400, JSON.stringify({ error: { message: 'invalid model name' } })), true);
    assert.equal(isAiModelRefusal(400, 'request is missing x-opencode-session and cannot be routed'), false);
    assert.equal(isAiModelRefusal(400, ''), false);
    assert.equal(isAiModelRefusal(401, RAW_MODEL_400), false);
    assert.equal(isAiModelRefusal(200, RAW_MODEL_400), false);
  });

  test('类型化错误点名源 id 与实际模型名；原始响应体与 key 都不出现在文案里', () => {
    const refusal = aiModelRefusalError(400, RAW_MODEL_400, 'opencode-go', 'deepseek-v4.1-flash');
    assert.ok(refusal instanceof AiModelRefusalError);
    assert.ok(refusal instanceof Error);
    assert.equal(refusal.name, 'AiModelRefusalError');
    assert.equal(refusal.status, 400);
    assert.equal(refusal.providerId, 'opencode-go');
    assert.equal(refusal.model, 'deepseek-v4.1-flash');
    assert.equal(refusal.message, TYPED);
    assert.equal(refusal.message.includes('请求无效，请检查模型名'), false, '不回显网关原始文案');
    assert.equal(refusal.message.includes('ai_generate'), false, '错误码只用于判定，不摊给用户');
    assert.equal(KEYISH.test(refusal.message), false, '文案不含 key');
  });

  test('classifyAiError：传源 id + 模型名走类型化文案；不传仍走原状态码映射', () => {
    assert.equal(classifyAiError(400, RAW_MODEL_400, 'OpenCode Go', 'opencode-go', 'deepseek-v4.1-flash'), TYPED);
    assert.match(classifyAiError(400, '', 'OpenCode Go', 'opencode-go', 'deepseek-v4.1-flash'), /请求无效/);
    assert.match(classifyAiError(400, RAW_MODEL_400, 'OpenCode Go'), /请求无效/, '中性调用不变');
    // 路由拒绝优先于模型拒绝（两者都是 400）
    const routeBody = 'request is missing x-opencode-session and cannot be routed';
    assert.match(classifyAiError(400, routeBody, 'OpenCode Go', 'opencode-go', 'deepseek-v4.1-flash'), /网关无法路由/);
  });

  test('服务层：单源与多源都把源 id + 实际模型名交给文案层（源码断言）', () => {
    assert.match(DEEPSEEK_SRC, /failureMessage\(outcome, providerLabel, route\.providerId, route\.model\)/);
    assert.match(DEEPSEEK_SRC, /classifyAiError\(outcome\.status, outcome\.body, providerLabel, providerId, model\)/);
    assert.match(FALLBACK_SRC, /aiModelRefusalError\(response\.status, response\.body, preset\.id, model\)/);
    assert.match(FALLBACK_SRC, /modelRefusal !== null\s*\?\s*modelRefusal\.message/);
  });
});
