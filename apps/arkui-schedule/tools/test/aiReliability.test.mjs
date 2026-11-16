// B3 可靠性 / B4 用量的静态与源码级断言（`services/deepseek.ets` / `services/settingsStore.ets`）。
//
// 为什么用源码断言：这两个文件依赖 `@kit.NetworkKit` / `@kit.ArkData`，Node 里跑不了；
// 但「日志模板只含 provider/model/latency/ok」「只切一次备用源」「参数键读写成套」
// 都是纯文本可判定的事实。可执行的部分（shouldFallback 表、runWithFallback 只切一次）
// 在 `aiRequest.test.mjs` 里跑真代码。
//
// 前置：无需构建（只读源码）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const DEEPSEEK = readFileSync(new URL('services/deepseek.ets', ETS), 'utf8');
const SETTINGS_STORE = readFileSync(new URL('services/settingsStore.ets', ETS), 'utf8');
const AI_REQUEST = readFileSync(new URL('model/aiRequest.ts', ETS), 'utf8');

/** 去掉整行注释，只留代码行。 */
function codeLines(source) {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(\/\/|\*|\/\*)/.test(line));
}

/** 截取某个方法体（从签名到下一个两空格缩进的 `async`/`private`/`/**` 段落）。 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到签名：${signature}`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:async |private |\/\*\*)/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** 请求日志模板（唯一允许的日志行）。 */
const LOG_TEMPLATE = "console.info('[ai] provider=%s model=%s latency=%dms ok=%s', providerId, model, latencyMs, ok ? 'true' : 'false');";

describe('请求日志：只有一条 [ai] 模板，且不含 key / 正文 / prompt', () => {
  test('deepseek.ets 里唯一的 console 调用就是这条模板', () => {
    const calls = codeLines(DEEPSEEK).filter((line) => /console\./.test(line) || /hilog\./.test(line));
    assert.equal(calls.length, 1, `日志调用必须只有 1 条，实际 ${calls.length} 条：\n${calls.join('\n')}`);
    assert.equal(calls[0], LOG_TEMPLATE);
  });

  test('模板本身只含 provider/model/latency/ok 四个占位符', () => {
    const template = /'(\[ai\][^']*)'/.exec(DEEPSEEK);
    assert.ok(template !== null, '找不到 [ai] 日志模板');
    assert.equal(template[1], '[ai] provider=%s model=%s latency=%dms ok=%s');
    const specifiers = [...template[1].matchAll(/%[sdifjo]/g)].map((item) => item[0]);
    assert.deepEqual(specifiers, ['%s', '%s', '%d', '%s'], '占位符数量/顺序就是四个字段');
    assert.equal(/key|token|secret|body|prompt|content|text/i.test(template[1]), false);
  });

  test('日志实参只能是 providerId / model / latencyMs / ok（不碰 apiKey / prompt / body）', () => {
    const line = codeLines(DEEPSEEK).find((item) => item.includes('[ai]'));
    assert.ok(line !== undefined);
    const args = line.slice(line.indexOf("'[ai]") + 1);
    const argText = args.slice(args.indexOf(',') + 1);
    assert.match(argText, /providerId, model, latencyMs, ok \? 'true' : 'false'\);$/);
    for (const forbidden of ['apiKey', 'key', 'prompt', 'body', 'request.body', 'outcome.body', 'text']) {
      assert.equal(
        new RegExp(`\\b${forbidden.replace('.', '\\.')}\\b`).test(argText),
        false,
        `日志实参里出现 ${forbidden}：${argText}`
      );
    }
  });

  test('日志调用点在一次尝试之后（有真实耗时，不是发请求前）', () => {
    const body = methodBody(DEEPSEEK, 'async function attemptOnce(');
    const logAt = body.indexOf('logAttempt(');
    const raceAt = body.indexOf('Promise.race');
    assert.ok(raceAt >= 0, 'attemptOnce 必须真的发请求');
    assert.ok(logAt > raceAt, '日志必须排在请求之后才有耗时');
    assert.match(body, /logAttempt\(route\.providerId, route\.model, outcome\.elapsedMs, outcome\.responded && outcome\.status === 200\)/);
  });

  test('logAttempt 函数体只有一次 console.info，不拼请求体/响应体', () => {
    const start = DEEPSEEK.indexOf('function logAttempt(');
    assert.ok(start >= 0);
    const end = DEEPSEEK.indexOf('\n}', start);
    const body = DEEPSEEK.slice(start, end);
    assert.equal((body.match(/console\.info\(/g) ?? []).length, 1);
    assert.equal(/JSON\.stringify|\$\{key\}|apiKey|request\.body|outcome\.body/.test(body), false, body);
  });
});

describe('备用源切换：只切一次', () => {
  test('summarizeWithFallback 把两个尝试交给 runWithFallback（由纯函数保证只切一次）', () => {
    const body = methodBody(DEEPSEEK, 'export async function summarizeWithFallback(');
    assert.match(body, /primaryAttempt: AiAttemptFn = async/);
    assert.match(body, /fallbackAttempt = async/);
    assert.match(body, /return runWithFallback\(primaryAttempt, fallbackAttempt\)/);
    assert.equal(/while|for \(/.test(body), false, '编排里不该有自己的循环（切源次数由 runWithFallback 决定）');
  });

  test('备用源配置缺省读设置缓存，调用方可显式覆盖', () => {
    const body = methodBody(DEEPSEEK, 'export async function summarizeWithFallback(');
    assert.match(body, /fallback === undefined \? settingsStore\.cachedAiFallback\(\) : fallback/);
    assert.match(body, /fallbackSettings\.configured/);
  });

  test('runWithFallback 源码只有两处 attempt 调用（主 + 备，不存在第三次）', () => {
    const start = AI_REQUEST.indexOf('export async function runWithFallback(');
    assert.ok(start >= 0);
    const body = AI_REQUEST.slice(start, AI_REQUEST.indexOf('\n}\n', start));
    assert.equal((body.match(/await primaryAttempt\(\)/g) ?? []).length, 1);
    assert.equal((body.match(/await fallbackAttempt\(\)/g) ?? []).length, 1);
    assert.match(body, /if \(fallbackAttempt === null \|\| !shouldFallback\(primary\.status\)\)/);
  });

  test('主备都失败抛 AiFallbackError（message 同时带两段原因）', () => {
    assert.match(AI_REQUEST, /export class AiFallbackError extends Error/);
    assert.match(AI_REQUEST, /super\(`\$\{primary\.error\}；备用源 \$\{fallback\.providerId\} 也失败：\$\{fallback\.error\}`\)/);
    assert.match(AI_REQUEST, /this\.primaryMessage = primary\.error;/);
    assert.match(AI_REQUEST, /this\.fallbackMessage = fallback\.error;/);
  });

  test('shouldFallback 的判定：超时/网络/429/5xx → true；确定性 4xx → false', () => {
    const start = AI_REQUEST.indexOf('export function shouldFallback(');
    const body = AI_REQUEST.slice(start, AI_REQUEST.indexOf('\n}\n', start));
    assert.match(body, /status === AI_STATUS_TIMEOUT/);
    assert.match(body, /status === AI_STATUS_NETWORK/);
    assert.match(body, /status === 429/);
    assert.match(body, /return status >= 500;/);
  });
});

describe('用量（B4）', () => {
  test('summarize 仍返回字符串（调用点 3 处不变），summarizeDetailed 返回 usage/elapsedMs', () => {
    const summarizeBody = methodBody(DEEPSEEK, 'export async function summarize(');
    assert.match(summarizeBody, /Promise<string>/);
    assert.match(summarizeBody, /summarizeDetailed\(/);
    const detailed = methodBody(DEEPSEEK, 'export async function summarizeDetailed(');
    assert.match(detailed, /Promise<AiSummaryResult>/);
    assert.match(detailed, /usage: outcome\.usage/);
    assert.match(detailed, /elapsedMs: outcome\.elapsedMs/);
  });

  test('解析响应走 parseAiReplyFull（拿得到 usage），不再只用 parseAiReply', () => {
    assert.match(DEEPSEEK, /parseAiReplyFull\(outcome\.body\)/);
    assert.equal(/parseAiReply\(/.test(DEEPSEEK), false, '不该再用只取正文的旧解析');
    assert.match(DEEPSEEK, /usage: AiUsage \| null;/);
  });

  test('describeUsage 的文案格式被纯函数钉住', () => {
    assert.match(AI_REQUEST, /return `输入 \$\{promptTokens\} \/ 输出 \$\{completionTokens\} tokens`;/);
  });
});

describe('参数与备用源：settingsStore 键读写成套', () => {
  test('B2 四个参数键都声明、读取（带默认值）、写回', () => {
    for (const name of ['KEY_AI_TEMPERATURE', 'KEY_AI_MAX_TOKENS', 'KEY_AI_TIMEOUT_MS', 'KEY_AI_RETRIES']) {
      assert.match(SETTINGS_STORE, new RegExp(`const ${name}: string = '`), `缺少 ${name}`);
      assert.ok(methodBody(SETTINGS_STORE, 'async load(').includes(`prefs.get(${name}`), `load() 没读 ${name}`);
      assert.ok(methodBody(SETTINGS_STORE, 'async save(').includes(`prefs.put(${name}`), `save() 没写 ${name}`);
    }
  });

  test('旧数据读默认：0.7 / 1024 / 30000 / 1', () => {
    const body = methodBody(SETTINGS_STORE, 'async load(');
    assert.match(body, /prefs\.get\(KEY_AI_TEMPERATURE, AI_DEFAULT_TEMPERATURE\)/);
    assert.match(body, /prefs\.get\(KEY_AI_MAX_TOKENS, AI_DEFAULT_MAX_TOKENS\)/);
    assert.match(body, /prefs\.get\(KEY_AI_TIMEOUT_MS, AI_TIMEOUT_MS\)/);
    assert.match(body, /prefs\.get\(KEY_AI_RETRIES, AI_DEFAULT_RETRIES\)/);
    assert.match(body, /const rawOptions: AiOptions = \{/);
    assert.match(body, /normalizeAiOptions\(rawOptions\)/);
  });

  test('B3 四个备用源键都声明、读取、写回', () => {
    for (const name of ['KEY_AI_FALLBACK_PROVIDER_ID', 'KEY_AI_FALLBACK_MODEL', 'KEY_AI_FALLBACK_BASE_URL', 'KEY_AI_FALLBACK_KEY']) {
      assert.match(SETTINGS_STORE, new RegExp(`const ${name}: string = '`), `缺少 ${name}`);
      assert.ok(methodBody(SETTINGS_STORE, 'async load(').includes(`prefs.get(${name}`), `load() 没读 ${name}`);
      assert.ok(methodBody(SETTINGS_STORE, 'async save(').includes(`prefs.put(${name}`), `save() 没写 ${name}`);
    }
  });

  test('备用源 id 未知/空 → 不启用（不回退默认源，避免悄悄多花一次钱）', () => {
    assert.match(SETTINGS_STORE, /export function normalizeFallbackProviderId\(value: string\): string \{[\s\S]*?return findProvider\(text\)\.id === text \? text : '';/);
    assert.match(SETTINGS_STORE, /return '';/);
  });

  test('清空备用源时连 model/baseURL/key 一起清掉（不留半套凭据）', () => {
    const body = methodBody(SETTINGS_STORE, 'async save(');
    assert.match(body, /requestedFallbackProviderId\.length > 0[\s\S]*?: ''/);
    assert.match(body, /aiFallbackKey:/);
  });

  test('服务层拿参数的入口是 cachedAiOptions / cachedAiFallback', () => {
    assert.match(SETTINGS_STORE, /cachedAiOptions\(\): AiOptions/);
    assert.match(SETTINGS_STORE, /cachedAiFallback\(\): AiFallbackSettings/);
    assert.match(DEEPSEEK, /settingsStore\.cachedAiOptions\(\)/);
  });

  test('saveSyncState 也逐字段构造新字段（否则同步状态回写会丢配置）', () => {
    const body = methodBody(SETTINGS_STORE, 'async saveSyncState(');
    for (const field of [
      'aiTemperature',
      'aiMaxTokens',
      'aiTimeoutMs',
      'aiRetries',
      'aiFallbackProviderId',
      'aiFallbackModel',
      'aiFallbackBaseURL',
      'aiFallbackKey'
    ]) {
      assert.ok(body.includes(`${field}:`), `saveSyncState 未构造 ${field}`);
    }
  });

  test('连通性测试仍是 max_tokens=8 最小请求', () => {
    assert.match(DEEPSEEK, /AI_PROBE_MAX_TOKENS/);
    assert.match(DEEPSEEK, /maxTokens: AI_PROBE_MAX_TOKENS/);
  });
});

describe('在线拉模型列表：真机走 @kit.NetworkKit（不赌全局 fetch）', () => {
  test('fetchModelsOnline 用注入的 httpFetch，GET + 透传 init.headers', () => {
    assert.match(DEEPSEEK, /export async function fetchModelsOnline\(/);
    assert.match(DEEPSEEK, /return fetchModels\(providerId, baseURL, apiKey, HTTP_FETCH_IMPL\);/);
    assert.match(DEEPSEEK, /const HTTP_FETCH_IMPL: AiFetchImpl = httpFetch;/);
    assert.match(DEEPSEEK, /method: http\.RequestMethod\.GET/);
    assert.match(DEEPSEEK, /header: init\.headers/);
    assert.match(DEEPSEEK, /MODELS_CONNECT_TIMEOUT_MS/);
  });

  test('拉列表不写日志（失败原因只进返回值）', () => {
    const body = methodBody(DEEPSEEK, 'async function httpFetch(');
    assert.equal(/console\./.test(body), false);
    assert.equal(/\[ai\]/.test(body), false);
  });
});
