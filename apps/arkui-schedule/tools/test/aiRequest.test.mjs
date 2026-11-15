// DeepSeek 请求/响应的纯逻辑（`model/aiRequest.ts`）测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 覆盖 P2 的四块可测逻辑：
// 1. `buildAiRequest` 的 URL 拼接与请求体（model + prompt + max_tokens）；
// 2. `classifyAiError` 的中文错误映射（401/402/403/404/429/5xx/超时/网络异常）；
// 3. `shouldRetry` 的重试判定（网络错误 / 429 / 5xx 才重试，超时与确定性错误不重试）；
// 4. `parseAiReply` 的回复解析（正常 / 缺字段 / 非 JSON / 空内容）。
//
// 该模块没有任何运行时 import，因此不需要 registerHooks 补 `.js` 后缀。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  AI_DEFAULT_MAX_TOKENS,
  AI_PROBE_MAX_TOKENS,
  AI_PROBE_PROMPT,
  AI_RETRY_BACKOFF_MS,
  AI_STATUS_NETWORK,
  AI_STATUS_TIMEOUT,
  AI_TIMEOUT_MS,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  aiChatUrl,
  buildAiRequest,
  classifyAiError,
  describeAiTestResult,
  parseAiReply,
  shouldRetry
} = await import('../.build/model/aiRequest.js');

describe('buildAiRequest：URL 与请求体构造', () => {
  test('默认基地址拼出 /chat/completions，请求体含 model 与 prompt', () => {
    const request = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, '请把今天的日程整理一下');
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.timeoutMs, AI_TIMEOUT_MS);
    assert.equal(AI_TIMEOUT_MS, 20000, '整体超时固定 20 秒');

    const body = JSON.parse(request.body);
    assert.equal(body.model, 'deepseek-chat');
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[0].content, '请把今天的日程整理一下');
    assert.equal(body.max_tokens, AI_DEFAULT_MAX_TOKENS);
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
    const request = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, AI_PROBE_PROMPT, AI_PROBE_MAX_TOKENS);
    const body = JSON.parse(request.body);
    assert.equal(AI_PROBE_MAX_TOKENS, 8);
    assert.equal(body.messages[0].content, 'ping');
    assert.equal(body.max_tokens, 8);
  });

  test('可选 system 消息排在第一，user 在后', () => {
    const request = buildAiRequest(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, '正文', 100, '你是整理助手');
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
    assert.match(classifyAiError(AI_STATUS_TIMEOUT, ''), /20 秒/);
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
    assert.equal(shouldRetry(AI_STATUS_TIMEOUT), false, '20 秒超时再等一轮只会让用户白等');
    assert.equal(shouldRetry(200), false);
    for (const status of [400, 401, 402, 403, 404, 422]) {
      assert.equal(shouldRetry(status), false, `HTTP ${status} 重试没有意义`);
    }
  });

  test('退避时长是 1 秒（只重试一次）', () => {
    assert.equal(AI_RETRY_BACKOFF_MS, 1000);
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
