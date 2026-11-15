// 多 AI 源预设与归一逻辑（`model/aiProvider.ts`）+ settingsStore 迁移的测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// `aiProvider.ts` 零 import，因此不需要 registerHooks 补 `.js` 后缀；
// `settingsStore.ets` / `deepseek.ets` 依赖 ArkTS 运行时，只能读源码做静态断言。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  DEFAULT_PROVIDER_ID,
  chatCompletionsURL,
  defaultModelOf,
  findProvider,
  isValidBaseURL,
  modelsOf,
  normalizeBaseURL,
  resolveModel
} = await import('../.build/model/aiProvider.js');

const { DEFAULT_AI_MODEL } = await import('../.build/model/aiRequest.js');

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const SETTINGS_STORE = readFileSync(new URL('services/settingsStore.ets', ETS), 'utf8');
const DEEPSEEK = readFileSync(new URL('services/deepseek.ets', ETS), 'utf8');

/** 取某个方法体：从签名到下一个两空格缩进的 `async`/`private`/`/**` 段落。 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到签名：${signature}`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:async |private |\/\*\*)/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('AI_PROVIDERS：预设表', () => {
  test('4 个源，顺序固定', () => {
    assert.equal(AI_PROVIDERS.length, 4);
    assert.deepEqual(
      AI_PROVIDERS.map((preset) => preset.id),
      ['deepseek', 'opencode-go', 'codex', 'custom']
    );
  });

  test('id 唯一、label 与 keyHint 非空', () => {
    assert.equal(new Set(AI_PROVIDERS.map((preset) => preset.id)).size, 4);
    for (const preset of AI_PROVIDERS) {
      assert.equal(typeof preset.label, 'string');
      assert.ok(preset.label.trim().length > 0, `${preset.id} 少了 label`);
      assert.ok(preset.keyHint.trim().length > 0, `${preset.id} 少了 keyHint`);
    }
  });

  test('预设源 baseURL 合法，custom 留空', () => {
    for (const preset of AI_PROVIDERS) {
      if (preset.id === CUSTOM_PROVIDER_ID) {
        assert.equal(preset.baseURL, '');
      } else {
        assert.ok(isValidBaseURL(preset.baseURL), `${preset.id} 的 baseURL 不合法：${preset.baseURL}`);
      }
    }
  });

  test('每个源都有非空且唯一的模型 id', () => {
    for (const preset of AI_PROVIDERS) {
      assert.ok(preset.models.length >= 1, `${preset.id} 没有模型`);
      const ids = preset.models.map((model) => model.id);
      assert.equal(new Set(ids).size, ids.length, `${preset.id} 有重复模型`);
      for (const id of ids) {
        assert.ok(id.trim().length > 0, `${preset.id} 有空模型 id`);
      }
    }
  });

  test('默认源是 deepseek，默认模型与 aiRequest 常量一致', () => {
    assert.equal(DEFAULT_PROVIDER_ID, 'deepseek');
    assert.equal(defaultModelOf(DEFAULT_PROVIDER_ID), DEFAULT_AI_MODEL);
  });
});

describe('findProvider：未知一律回退默认源', () => {
  test('未知 / 空 / 空白 回退默认源', () => {
    assert.equal(findProvider('nope').id, 'deepseek');
    assert.equal(findProvider('').id, 'deepseek');
    assert.equal(findProvider('   ').id, 'deepseek');
  });

  test('大小写与首尾空白容错', () => {
    assert.equal(findProvider(' DeepSeek ').id, 'deepseek');
    assert.equal(findProvider('OPENCODE-GO').id, 'opencode-go');
  });
});

describe('模型归一', () => {
  test('modelsOf 未知源回退默认源列表', () => {
    assert.deepEqual(modelsOf('nope'), modelsOf('deepseek'));
  });

  test('defaultModelOf 取列表首个', () => {
    assert.equal(defaultModelOf('deepseek'), 'deepseek-chat');
    assert.equal(defaultModelOf('opencode-go'), 'deepseek-v4-pro');
    assert.equal(defaultModelOf('codex'), 'gpt-5-codex');
  });

  test('resolveModel 空模型回退该源默认', () => {
    assert.equal(resolveModel('opencode-go', ''), 'deepseek-v4-pro');
    assert.equal(resolveModel('codex', '   '), 'gpt-5-codex');
  });

  test('resolveModel 未知模型回退该源默认', () => {
    assert.equal(resolveModel('deepseek', 'gpt-5'), 'deepseek-chat');
    assert.equal(resolveModel('opencode-go', 'deepseek-chat'), 'deepseek-v4-pro');
  });

  test('resolveModel 合法模型原样返回', () => {
    assert.equal(resolveModel('deepseek', 'deepseek-reasoner'), 'deepseek-reasoner');
    assert.equal(resolveModel('opencode-go', 'deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  });

  test('resolveModel 未知源按默认源解析', () => {
    assert.equal(resolveModel('nope', 'deepseek-reasoner'), 'deepseek-reasoner');
  });

  test('resolveModel 自定义源保留任意模型名', () => {
    assert.equal(resolveModel('custom', 'my-local-model'), 'my-local-model');
    assert.equal(resolveModel('custom', ''), 'custom-model');
  });
});

describe('normalizeBaseURL', () => {
  test('缺协议补 https', () => {
    assert.equal(normalizeBaseURL('api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
  });

  test('去掉尾斜杠', () => {
    assert.equal(normalizeBaseURL('https://api.deepseek.com/v1///'), 'https://api.deepseek.com/v1');
  });

  test('协议与域名小写，路径大小写保留', () => {
    assert.equal(normalizeBaseURL('HTTPS://API.DeepSeek.com/V1'), 'https://api.deepseek.com/V1');
  });

  test('去掉尾随与内部空白', () => {
    assert.equal(normalizeBaseURL('  https:// api.deepseek.com /v1  '), 'https://api.deepseek.com/v1');
  });

  test('空串保持空串', () => {
    assert.equal(normalizeBaseURL(''), '');
    assert.equal(normalizeBaseURL('   '), '');
  });
});

describe('isValidBaseURL', () => {
  test('http(s) 地址与裸域名放行', () => {
    assert.equal(isValidBaseURL('https://api.deepseek.com/v1'), true);
    assert.equal(isValidBaseURL('api.deepseek.com'), true);
    assert.equal(isValidBaseURL('http://localhost:11434/v1'), true);
  });

  test('空串、其它协议、缺主机都拒绝', () => {
    assert.equal(isValidBaseURL(''), false);
    assert.equal(isValidBaseURL('   '), false);
    assert.equal(isValidBaseURL('ftp://api.deepseek.com'), false);
    assert.equal(isValidBaseURL('https://'), false);
  });
});

describe('chatCompletionsURL', () => {
  test('补 /chat/completions', () => {
    assert.equal(chatCompletionsURL('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  });

  test('已含路径不重复拼', () => {
    assert.equal(
      chatCompletionsURL('https://api.deepseek.com/v1/chat/completions'),
      'https://api.deepseek.com/v1/chat/completions'
    );
    assert.equal(
      chatCompletionsURL('https://api.deepseek.com/chat/completions/'),
      'https://api.deepseek.com/chat/completions'
    );
  });

  test('自定义路径原样保留', () => {
    assert.equal(
      chatCompletionsURL('api.proxy.example.com/openai/v1'),
      'https://api.proxy.example.com/openai/v1/chat/completions'
    );
  });

  test('空地址与非法协议抛中文错误', () => {
    assert.throws(() => chatCompletionsURL(''), /接口地址不能为空/);
    assert.throws(() => chatCompletionsURL('   '), /接口地址不能为空/);
    assert.throws(() => chatCompletionsURL('ftp://api.deepseek.com'), /格式不正确/);
  });
});

describe('settingsStore 迁移：旧 aiKey → deepseek + deepseek-chat', () => {
  test('迁移目标的三个值可复现', () => {
    assert.equal(findProvider('').id, 'deepseek');
    assert.equal(resolveModel('deepseek', ''), 'deepseek-chat');
    assert.equal(findProvider('deepseek').baseURL, 'https://api.deepseek.com/v1');
  });

  test('load() 读取 providerId / aiModel / aiBaseURL', () => {
    const body = methodBody(SETTINGS_STORE, 'async load(');
    assert.match(body, /prefs\.get\(KEY_AI_PROVIDER_ID/);
    assert.match(body, /prefs\.get\(KEY_AI_MODEL, DEFAULT_AI_MODEL\)/);
    assert.match(body, /prefs\.get\(KEY_AI_BASE_URL/);
  });

  test('load() 里 provider → 模型 → 地址 依次成对归一', () => {
    const body = methodBody(SETTINGS_STORE, 'async load(');
    const providerAt = body.indexOf('findProvider(aiProviderIdRaw).id');
    const modelAt = body.indexOf('resolveAiModel(aiProviderId, normalizeAiModel(aiModel))');
    const baseAt = body.indexOf('aiBaseURLFor(aiProviderId, aiBaseURLRaw)');
    assert.ok(providerAt >= 0, '缺少 providerId 归一');
    assert.ok(modelAt > providerAt, '模型必须在 providerId 之后解析');
    assert.ok(baseAt > modelAt, '基地址必须跟着 providerId 走');
  });

  test('save() 写回三个新键（否则迁移值会丢）', () => {
    const body = methodBody(SETTINGS_STORE, 'async save(');
    assert.match(body, /prefs\.put\(KEY_AI_PROVIDER_ID/);
    assert.match(body, /prefs\.put\(KEY_AI_MODEL/);
    assert.match(body, /prefs\.put\(KEY_AI_BASE_URL/);
  });

  test('aiBaseURLFor：预设源用预设地址，custom 才用填写值', () => {
    const body = methodBody(SETTINGS_STORE, 'export function aiBaseURLFor(');
    assert.match(body, /preset\.id !== CUSTOM_PROVIDER_ID/);
    assert.match(body, /return preset\.baseURL;/);
    assert.match(body, /normalizeBaseURL\(/);
  });
});

describe('deepseek 接入多源', () => {
  test('请求地址走 chatCompletionsURL(route.baseURL)', () => {
    assert.match(DEEPSEEK, /buildAiRequest\(\s*chatCompletionsURL\(route\.baseURL\)/);
  });

  test('summarize 新增参数都是可选的（旧调用不受影响）', () => {
    assert.match(DEEPSEEK, /model\?: string,\s*\n\s*providerId\?: string,\s*\n\s*baseURL\?: string/);
  });

  test('testAiConnection 兼容旧签名（第二参非源 id 按模型名处理）', () => {
    assert.match(DEEPSEEK, /const legacyCall: boolean = !isProviderId\(providerIdOrModel\);/);
  });

  test('密钥只进 Authorization 头', () => {
    assert.match(DEEPSEEK, /'Authorization': `Bearer \$\{apiKey\}`/);
  });
});
