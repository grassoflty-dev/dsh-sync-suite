// 模型列表在线拉取（`model/aiProvider.ts` 的 B2 部分）测试：解析 + 端点 + 注入 fetch。
//
// 前置：先构建纯逻辑层
//   node node_modules/tsc/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//   （实际命令：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json）
//
// 全部用例用**假 fetch**，不联网：200 / 401 / 500 / 超时 / 抛异常 / 返回体坏 JSON 六种情况。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  AI_MODELS_TIMEOUT_MS,
  fetchModels,
  modelsURL,
  parseModelsResponse
} = await import('../.build/model/aiProvider.js');

/** 假 fetch：返回固定状态与正文，并记录调用参数。 */
function fakeFetch(status, bodyText) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      text: async () => bodyText
    };
  };
  return { impl, calls };
}

/** 永不返回的 fetch（测超时）。 */
function hangingFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Promise(() => {});
  };
  return { impl, calls };
}

describe('parseModelsResponse：三种响应形态', () => {
  test('OpenAI 形态 { data: [{ id }] }', () => {
    const text = JSON.stringify({
      object: 'list',
      data: [{ id: 'deepseek-chat', object: 'model' }, { id: 'deepseek-reasoner', object: 'model' }]
    });
    assert.deepEqual(parseModelsResponse(text), ['deepseek-chat', 'deepseek-reasoner']);
  });

  test('直数组形态 [{ id }]', () => {
    assert.deepEqual(parseModelsResponse('[{"id":"llama3.2"},{"id":"qwen2.5"}]'), ['llama3.2', 'qwen2.5']);
  });

  test('{ models: [...] } 形态（对象或纯字符串都认）', () => {
    assert.deepEqual(parseModelsResponse('{"models":[{"name":"qwen2.5"},{"model":"deepseek-r1"}]}'), [
      'qwen2.5',
      'deepseek-r1'
    ]);
    assert.deepEqual(parseModelsResponse('{"models":["llama3.2"]}'), ['llama3.2']);
  });

  test('OpenRouter 的 provider/model 命名原样保留', () => {
    const text = '{"data":[{"id":"deepseek/deepseek-chat"},{"id":"anthropic/claude-3.5-sonnet"}]}';
    assert.deepEqual(parseModelsResponse(text), ['deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet']);
  });

  test('坏 JSON / 空串 / 不认识的结构 → []', () => {
    assert.deepEqual(parseModelsResponse('not json'), []);
    assert.deepEqual(parseModelsResponse('{"data":['), []);
    assert.deepEqual(parseModelsResponse(''), []);
    assert.deepEqual(parseModelsResponse('   '), []);
    assert.deepEqual(parseModelsResponse('null'), []);
    assert.deepEqual(parseModelsResponse('{"object":"list"}'), []);
    assert.deepEqual(parseModelsResponse('{"data":"nope"}'), []);
    assert.deepEqual(parseModelsResponse('123'), []);
  });

  test('去空、去重、保持顺序', () => {
    assert.deepEqual(
      parseModelsResponse('{"data":[{"id":"a"},{"id":"  "},{"id":"a"},{"id":"b"}]}'),
      ['a', 'b']
    );
    assert.deepEqual(parseModelsResponse('[{"id":""},{"id":"x"},{"name":"x"}]'), ['x']);
  });

  test('非字符串入参不抛异常', () => {
    assert.deepEqual(parseModelsResponse(undefined), []);
    assert.deepEqual(parseModelsResponse(null), []);
    assert.deepEqual(parseModelsResponse(42), []);
  });

  test('数组里混 null / 非法条目也不抛，好的照收', () => {
    assert.deepEqual(parseModelsResponse('[null,{"id":"ok"},null]'), ['ok']);
    assert.deepEqual(parseModelsResponse('[null]'), []);
    assert.deepEqual(parseModelsResponse('{"data":[{"id":null},{"id":"x"}]}'), ['x']);
  });
});

describe('modelsURL：拼 GET /models', () => {
  test('基地址补 /models；已含 /models 不重复', () => {
    assert.equal(modelsURL('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/models');
    assert.equal(modelsURL('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/models');
    assert.equal(modelsURL('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1/models');
    assert.equal(modelsURL('https://api.deepseek.com/v1/models'), 'https://api.deepseek.com/v1/models');
    assert.equal(modelsURL('https://api.deepseek.com/v1/models/'), 'https://api.deepseek.com/v1/models');
  });

  test('用户填了完整 /chat/completions 时换成 /models', () => {
    assert.equal(modelsURL('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1/models');
  });

  test('空/非法地址抛中文错误', () => {
    assert.throws(() => modelsURL(''), /接口地址不能为空/);
    assert.throws(() => modelsURL('ftp://api.deepseek.com'), /格式不正确/);
  });
});

describe('fetchModels：200 成功', () => {
  test('用注入的 fake fetch，GET + Accept/Authorization 头，返回模型列表', async () => {
    const { impl, calls } = fakeFetch(200, JSON.stringify({ data: [{ id: 'custom-model' }, { id: 'my-model' }] }));
    const result = await fetchModels('custom', 'https://proxy.example.test/v1', 'sk-test', impl);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.models, ['custom-model', 'my-model']);
    assert.match(result.message, /成功：HTTP 200 \/ 2 个模型/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://proxy.example.test/v1/models');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers['Accept'], 'application/json');
    assert.equal(calls[0].init.headers['Authorization'], 'Bearer sk-test');
  });

  test('没有 key 时不发 Authorization（自建本地服务通常不校验 key）', async () => {
    const { impl, calls } = fakeFetch(200, '{"data":[{"id":"my-model"}]}');
    const result = await fetchModels('custom', 'http://127.0.0.1:8080/v1', '', impl);
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/models', '用填入的本地地址');
    assert.equal('Authorization' in calls[0].init.headers, false);
    assert.deepEqual(Object.keys(calls[0].init.headers), ['Accept'], '不带 key 时只有 Accept 头');
  });

  test('带 key 时请求头恰好 Accept + Authorization（key 只在这里）', async () => {
    const { impl, calls } = fakeFetch(200, '{"data":[{"id":"a"}]}');
    await fetchModels('deepseek', '', 'sk-very-secret', impl);
    assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['Accept', 'Authorization']);
    assert.equal(calls[0].init.headers['Authorization'], 'Bearer sk-very-secret');
    assert.equal(calls[0].url.includes('sk-very-secret'), false, 'key 不得进 URL');
  });

  test('200 但列表为空：ok=true + 提示可手填', async () => {
    const { impl } = fakeFetch(200, '{"data":[]}');
    const result = await fetchModels('deepseek', '', 'k', impl);
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, []);
    assert.match(result.message, /列表为空/);
  });
});

describe('fetchModels：失败不抛', () => {
  test('401 → ok:false，文案带源名与 key 提示', async () => {
    const { impl } = fakeFetch(401, '{"error":{"message":"invalid key"}}');
    const result = await fetchModels('deepseek', 'https://api.deepseek.com/v1', 'bad', impl);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.deepEqual(result.models, []);
    assert.match(result.message, /DeepSeek 官方/);
    assert.match(result.message, /密钥无效/);
  });

  test('500 → ok:false，提示服务端错误', async () => {
    const { impl } = fakeFetch(503, 'upstream unavailable');
    const result = await fetchModels('openrouter', '', 'k', impl);
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.match(result.message, /服务端错误/);
  });

  test('超时 → status -1（注入的 fetch 永不返回）', async () => {
    const { impl } = hangingFetch();
    const result = await fetchModels('deepseek', '', 'k', impl, 20);
    assert.equal(result.ok, false);
    assert.equal(result.status, -1);
    assert.match(result.message, /超时/);
  });

  test('fetch 抛异常 → status 0（网络失败）', async () => {
    const impl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await fetchModels('custom', 'https://proxy.example.test/v1', '', impl);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.match(result.message, /网络异常/);
  });

  test('响应体读取失败 / 自定义源地址为空都不抛', async () => {
    const badText = async () => ({
      status: 200,
      text: async () => {
        throw new Error('boom');
      }
    });
    const first = await fetchModels('deepseek', '', 'k', badText);
    assert.equal(first.ok, false);
    assert.equal(first.status, 0);

    const { impl, calls } = fakeFetch(200, '{}');
    const second = await fetchModels('custom', '', 'k', impl);
    assert.equal(second.ok, false);
    assert.match(second.message, /接口地址不能为空/);
    assert.equal(calls.length, 0, '地址为空时不该发请求');
  });

  test('超时常量有默认值（页面不传也有限）', () => {
    assert.equal(typeof AI_MODELS_TIMEOUT_MS, 'number');
    assert.ok(AI_MODELS_TIMEOUT_MS > 0 && AI_MODELS_TIMEOUT_MS <= 30000);
  });
});
