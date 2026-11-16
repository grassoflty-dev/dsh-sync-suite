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
// 6. `parseAiReply` / `parseAiReplyFull` / `parseUsage` / `describeUsage`。
//
// 该模块没有任何运行时 import，因此不需要 registerHooks 补 `.js` 后缀。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
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
  AI_PROBE_MAX_TOKENS,
  AI_PROBE_PROMPT,
  AI_RETRY_BACKOFF_MS,
  AI_STATUS_NETWORK,
  AI_STATUS_TIMEOUT,
  AI_TIMEOUT_MS,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  AiFallbackError,
  aiChatUrl,
  buildAiRequest,
  classifyAiError,
  defaultAiOptions,
  describeAiTestResult,
  describeUsage,
  normalizeAiOptions,
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
