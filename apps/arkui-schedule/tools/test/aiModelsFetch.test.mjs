// mod-ai-models-fetch：模型下拉从服务商 `GET …/models` 取列表的测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 分两层：
// ① 纯模型层（model/aiProvider.ts，零 import）：注入假 fetch，验端点、规范 id、九种类型结果、
//    缓存编解码 / patch、自定义条目合并；HTTP 调用由测试注入，全程不联网。
// ② 源码形状断言：ArkTS 组件跑不起来，用静态断言钉住「下拉消费在线列表」「自定义 / 未知分支」
//    「缓存只写一个键、不覆盖其它设置」「刷新按钮可达」「没有 console 打印 key」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const {
  AI_PROVIDERS,
  MODELS_LIST_PROVIDERS,
  customModelLabel,
  decodeAiModelsCache,
  encodeAiModelsCache,
  fetchModels,
  findProvider,
  mergeModelIds,
  modelsURL,
  supportsModelsList,
  withCachedModels
} = await import('../.build/model/aiProvider.js');

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const readEts = (relative) => readFileSync(new URL(relative, ETS), 'utf8');
const PROVIDER = readEts('model/aiProvider.ts');
const PAGE = readEts('pages/SettingsApi.ets');
const SECTION = readEts('components/settings/AiSection.ets');
const STORE = readEts('services/settingsStore.ets');
const DEEPSEEK = readEts('services/deepseek.ets');

/** 去掉注释：只扫可执行代码，注释里提到 key 不算打印。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 假 fetch：返回固定状态 / 正文，并记录调用参数（含 Authorization 头）。 */
function fakeFetch(status, bodyText) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => bodyText };
  };
  return { impl, calls };
}

/** 永不返回的 fetch（测超时）。 */
function hangingFetch() {
  return { impl: async () => new Promise(() => {}) };
}

/** 抽取所有 console.* 调用的实参文本（带括号配平），用于「不打印 key」守卫。 */
function consoleCalls(src) {
  const found = [];
  const re = /console\.(?:log|info|warn|error|debug)\s*\(/g;
  let matched;
  while ((matched = re.exec(src)) !== null) {
    let depth = 0;
    let i = re.lastIndex - 1;
    let quote = '';
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote.length > 0) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === quote) {
          quote = '';
        }
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    found.push(src.slice(matched.index, i));
  }
  return found;
}

/** 取方法体：从签名到下一个两空格缩进的方法 / 注释。 */
function methodBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `找不到签名：${signature}`);
  const rest = src.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:private |async |\/\*\*)/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('端点与覆盖范围：resolved baseURL + /models', () => {
  test('五个预设都声明支持模型列表，未知源回退默认源也支持', () => {
    assert.deepEqual(MODELS_LIST_PROVIDERS, ['deepseek', 'opencode-go', 'codex', 'openrouter', 'custom']);
    for (const preset of AI_PROVIDERS) {
      assert.equal(supportsModelsList(preset.id), true, `${preset.id} 应支持 GET /models`);
    }
    assert.equal(supportsModelsList('nope'), supportsModelsList(findProvider('nope').id), '未知源按默认源判定');
  });

  test('opencode-go 拼的是预设 baseURL + /models；custom 用用户填的地址', async () => {
    const go = findProvider('opencode-go');
    assert.equal(go.baseURL, 'https://opencode.ai/inference/go/openai/v1');
    assert.equal(modelsURL(go.baseURL), 'https://opencode.ai/inference/go/openai/v1/models');
    const { impl, calls } = fakeFetch(200, '{"data":[{"id":"deepseek-v4.1-flash"}]}');
    await fetchModels('opencode-go', '', 'k', impl);
    assert.equal(calls[0].url, 'https://opencode.ai/inference/go/openai/v1/models');
    const custom = fakeFetch(200, '{"data":[{"id":"x"}]}');
    await fetchModels('custom', 'https://proxy.example.test/v1', '', custom.impl);
    assert.equal(custom.calls[0].url, 'https://proxy.example.test/v1/models');
  });

  test('规范 id 原样入列表：取 id 字段，不用 canonical_id / name 改写', async () => {
    const body = JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-v4.1-flash', canonical_id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash 1017' },
        { id: 'hy4-flash-free', canonical_id: 'tencent/hy4-flash', name: 'Hy4 flash Free' }
      ]
    });
    const { impl, calls } = fakeFetch(200, body);
    const result = await fetchModels('opencode-go', '', 'k', impl);
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.models, ['deepseek-v4.1-flash', 'hy4-flash-free'], '请求体 id 一个字符都不改');
    assert.equal(result.models.some((id) => id.includes('/')), false, 'canonical_id 不能混进来');
    assert.equal(calls[0].init.method, 'GET');
  });

  test('key 只进 Authorization 头，不进 URL，也不进结果文案', async () => {
    const { impl, calls } = fakeFetch(200, '{"data":[{"id":"a"}]}');
    const result = await fetchModels('opencode-go', '', 'sk-super-secret-value', impl);
    assert.equal(calls[0].init.headers['Authorization'], 'Bearer sk-super-secret-value');
    assert.equal(calls[0].url.includes('sk-super-secret-value'), false);
    assert.equal(result.message.includes('sk-super-secret-value'), false);
    assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['Accept', 'Authorization']);
  });
});

describe('类型化失败：每种都给短中文文案，不抛异常', () => {
  test('401 → unauthorized，文案点名 key', async () => {
    const result = await fetchModels('opencode-go', '', 'k', fakeFetch(401, '{"error":"bad key"}').impl);
    assert.equal(result.kind, 'unauthorized');
    assert.equal(result.ok, false);
    assert.match(result.message, /密钥无效/);
  });

  test('403 → forbidden，文案说权限', async () => {
    const result = await fetchModels('opencode-go', '', 'k', fakeFetch(403, 'forbidden').impl);
    assert.equal(result.kind, 'forbidden');
    assert.match(result.message, /无权限/);
  });

  test('5xx → http，文案说服务端错误', async () => {
    const result = await fetchModels('opencode-go', '', 'k', fakeFetch(503, 'upstream').impl);
    assert.equal(result.kind, 'http');
    assert.match(result.message, /服务端错误/);
  });

  test('其它非 2xx（418）→ http，文案带状态码', async () => {
    const result = await fetchModels('opencode-go', '', 'k', fakeFetch(418, 'teapot').impl);
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 418/);
  });

  test('200 但坏 JSON → malformed，明确说格式不认识', async () => {
    const result = await fetchModels('opencode-go', '', 'k', fakeFetch(200, '{{{not json').impl);
    assert.equal(result.kind, 'malformed');
    assert.deepEqual(result.models, []);
    assert.match(result.message, /格式无法识别/);
  });

  test('200 但 {"data":[]} → empty，与 malformed 区分', async () => {
    const result = await fetchModels('opencode-go', '', 'k', fakeFetch(200, '{"data":[]}').impl);
    assert.equal(result.kind, 'empty');
    assert.match(result.message, /列表为空/);
    assert.doesNotMatch(result.message, /格式无法识别/);
  });

  test('fetch 抛异常 → network，文案说无法连接', async () => {
    const throwing = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await fetchModels('opencode-go', '', 'k', throwing);
    assert.equal(result.kind, 'network');
    assert.equal(result.status, 0);
    assert.match(result.message, /网络异常/);
  });

  test('超时 → timeout，文案说超时', async () => {
    const result = await fetchModels('opencode-go', '', 'k', hangingFetch().impl, 20);
    assert.equal(result.kind, 'timeout');
    assert.equal(result.status, -1);
    assert.match(result.message, /超时/);
  });

  test('自定义源没填地址 → config，且不发请求', async () => {
    const probe = fakeFetch(200, '{"data":[{"id":"a"}]}');
    const result = await fetchModels('custom', '', 'k', probe.impl);
    assert.equal(result.kind, 'config');
    assert.equal(probe.calls.length, 0);
    assert.match(result.message, /接口地址不能为空/);
  });

  test('每条失败文案都是短中文（≤80 字）', async () => {
    const cases = [
      fakeFetch(401, 'x').impl,
      fakeFetch(403, 'x').impl,
      fakeFetch(500, 'x').impl,
      fakeFetch(200, 'bad').impl
    ];
    for (const impl of cases) {
      const result = await fetchModels('opencode-go', '', 'k', impl);
      assert.ok(result.message.length <= 80, `文案太长：${result.message}`);
      assert.match(result.message, /[\u4e00-\u9fff]/, '必须是中文文案');
    }
  });
});

describe('缓存：编解码 / patch 语义 / 不覆盖', () => {
  test('坏串 / 空串 / 非对象 → 空表，不抛', () => {
    assert.deepEqual(decodeAiModelsCache(''), {});
    assert.deepEqual(decodeAiModelsCache('not json'), {});
    assert.deepEqual(decodeAiModelsCache('[]'), {});
    assert.deepEqual(decodeAiModelsCache('null'), {});
    assert.deepEqual(decodeAiModelsCache('{"opencode-go":"oops"}'), {});
  });

  test('编解码往返：ids 原样 + fetchedAt，坏条目丢掉、id 去重', () => {
    const entry = { ids: ['deepseek-v4.1-flash', 'hy4-flash-free'], fetchedAt: '2026-11-22T03:00:00.000Z' };
    const map = decodeAiModelsCache(encodeAiModelsCache({ 'opencode-go': entry, bad: { ids: [], fetchedAt: 'x' } }));
    assert.deepEqual(map['opencode-go'], entry);
    assert.equal('bad' in map, false, '空列表条目不进缓存');
    const dup = decodeAiModelsCache(
      encodeAiModelsCache({ go: { ids: ['a', 'a', ' ', 'b'], fetchedAt: 't' } })
    );
    assert.deepEqual(dup.go.ids, ['a', 'b']);
  });

  test('withCachedModels 是 patch：只换该源，其它源逐字保留', () => {
    const old = {
      deepseek: { ids: ['deepseek-chat'], fetchedAt: 't1' },
      'opencode-go': { ids: ['old-id'], fetchedAt: 't0' }
    };
    const next = withCachedModels(old, 'opencode-go', ['new-id'], 't2');
    assert.deepEqual(next.deepseek, old.deepseek, '其它源不能被覆盖');
    assert.deepEqual(next['opencode-go'], { ids: ['new-id'], fetchedAt: 't2' });
    assert.deepEqual(old['opencode-go'].ids, ['old-id'], '不原地改旧表');
  });

  test('空列表不写缓存：withCachedModels 返回原对象，失败绝不抹掉好列表', () => {
    const good = { go: { ids: ['kept-id'], fetchedAt: 't0' } };
    assert.equal(withCachedModels(good, 'go', [], 't9'), good);
    assert.equal(withCachedModels(good, 'other', [], 't9'), good);
    assert.deepEqual(good.go.ids, ['kept-id']);
  });
});

describe('自定义 / 未知条目：保存的模型不静默丢失', () => {
  test('mergeModelIds：id 不在列表里就追加，已在列表里不重复', () => {
    assert.deepEqual(mergeModelIds(['a', 'b'], 'c'), ['a', 'b', 'c']);
    assert.deepEqual(mergeModelIds(['a', 'b'], 'b'), ['a', 'b']);
    assert.deepEqual(mergeModelIds(['a', 'a'], 'a'), ['a']);
    assert.deepEqual(mergeModelIds(['a'], '   '), ['a'], '空 id 不追加');
    assert.deepEqual(mergeModelIds([], 'saved-id'), ['saved-id'], '列表为空也要保留保存值');
  });

  test('自定义条目的中文标签逐字钉住', () => {
    assert.equal(customModelLabel('deepseek-v4.1-flash'), '自定义 / 未知：deepseek-v4.1-flash');
    assert.equal(customModelLabel('x'), '自定义 / 未知：x');
  });
});

describe('源码形状守卫：接线、缓存键、刷新入口、日志', () => {
  test('模型弹层消费在线 / 缓存列表，而不是写死 modelsOf', () => {
    assert.match(PAGE, /ForEach\(\s*this\.modelOptions\(\)/, '弹层数据源必须是页面计算出的选项');
    assert.match(PAGE, /this\.aiModelOptions = options/, '在线 / 预设列表要写进 @State');
    assert.match(PAGE, /fetchModelsOnline\(providerId, baseURL, this\.aiKey\)/, '刷新必须走服务层 GET');
    assert.match(PAGE, /settingsStore\.loadAiModelsCache\(context\)/, '页面打开读缓存');
    assert.match(PAGE, /settingsStore\.saveAiModelsCache\(providerId, result\.models, nowIso\(\), context\)/, '成功才写缓存');
    assert.match(PAGE, /mergeModelIds\(ids, this\.aiModel\)/, '选项合并要保留保存值');
    assert.match(PAGE, /let label: string = customModelLabel\(id\)/, '未知 id 用自定义标签');
  });

  test('自定义 / 未知分支可达：选项仍可选中并写回 aiModel', () => {
    assert.match(PAGE, /this\.pickModel\(item\.id\)/, '点选项仍写回保存值');
    assert.match(PAGE, /item\.id === this\.aiModel \? '✓' : ''/, '当前项仍打勾');
    assert.match(PAGE, /customModelLabel\(id\)/);
    assert.match(SECTION, /onOpenModelPanel: \(\) => void/, '模型行入口仍在');
  });

  test('失败不动缓存：只用类型化提示标注过期，不重铺 aiModelOptions', () => {
    const body = methodBody(PAGE, 'private async refreshModels()');
    assert.match(body, /result\.kind === 'ok' && result\.models\.length > 0/, '只有成功才进写缓存分支');
    assert.match(body, /this\.applyFetchedIds\(/, '成功才重铺列表');
    assert.match(body, /this\.modelsStale = true/, '失败标注过期');
    assert.match(body, /继续使用上次缓存，可能已过期/, '失败文案说明缓存仍可用');
    const applyAt = body.indexOf('this.applyFetchedIds(');
    const failAt = body.indexOf('this.modelsStale = true', applyAt);
    assert.ok(applyAt > 0 && failAt > applyAt, '重铺只在成功分支，失败分支在其后');
  });

  test('缓存持久化只写一个键；save() / saveSyncState() 不碰它（patch 不覆盖）', () => {
    assert.match(STORE, /const KEY_AI_MODELS_CACHE: string = 'aiModelsCache';/);
    const loadBody = methodBody(STORE, 'async loadAiModelsCache(');
    const saveBody = methodBody(STORE, 'async saveAiModelsCache(');
    assert.match(loadBody, /prefs\.get\(KEY_AI_MODELS_CACHE, ''\)/);
    assert.match(saveBody, /prefs\.put\(KEY_AI_MODELS_CACHE, encodeAiModelsCache\(next\)\)/);
    assert.match(saveBody, /withCachedModels\(current, providerId, ids, fetchedAt\)/);
    const fullSave = STORE.slice(STORE.indexOf('async save(patch: SettingsPatch'), STORE.indexOf('async saveSyncState('));
    const syncSave = STORE.slice(STORE.indexOf('async saveSyncState('), STORE.indexOf('async loadAiModelsCache('));
    assert.equal(KEY_IN(fullSave), false, '整表 save 不得写缓存键');
    assert.equal(KEY_IN(syncSave), false, '同步状态回写不得写缓存键');
    const patchShape = STORE.slice(STORE.indexOf('export interface SettingsPatch'), STORE.indexOf('export interface AiFallbackSettings'));
    assert.equal(KEY_IN(patchShape), false, '缓存键不进 SettingsPatch（不随表单保存被覆盖）');
  });

  test('「刷新模型列表」按钮常驻且可达；没有后台定时器', () => {
    assert.match(SECTION, /'刷新模型列表'/, '按钮文案逐字钉住');
    assert.match(SECTION, /this\.onRefreshModels\(\)/, '按钮必须调回调');
    assert.match(SECTION, /this\.modelsBusy \? '刷新中…' : '刷新模型列表'/, '忙碌态有明确文案');
    assert.match(PAGE, /onRefreshModels: \(\): void => \{\s*this\.refreshModels\(\);/, '页面必须接回调');
    const code = stripComments(PAGE + '\n' + SECTION);
    assert.equal(/setInterval|setTimeout/.test(code), false, '不得引入后台定时器 / 自动刷新');
  });

  test('没有任何 console.* 打印 key / 请求头（含服务层唯一日志模板）', () => {
    const calls = [
      ...consoleCalls(stripComments(PROVIDER)),
      ...consoleCalls(stripComments(DEEPSEEK)),
      ...consoleCalls(stripComments(PAGE)),
      ...consoleCalls(stripComments(SECTION)),
      ...consoleCalls(stripComments(STORE))
    ];
    for (const text of calls) {
      for (const token of ['apiKey', 'aiKey', 'Authorization', 'Bearer', 'headers', 'response', 'bodyText']) {
        assert.equal(text.includes(token), false, `console 调用里不许出现 ${token}：${text}`);
      }
    }
    // 页面 / 组件 / store 是凭据敏感文件：一条 console / hilog 都不允许。
    for (const src of [PAGE, SECTION, STORE]) {
      assert.equal(/console\.(log|info|warn|error)|\bHilog\./.test(stripComments(src)), false);
    }
    // 模型层的 `${key}` 只允许出现在 Authorization 构造那一行，不能进任何文案。
    const keyInterpolations = PROVIDER.match(/\$\{key\}/g) ?? [];
    assert.equal(keyInterpolations.length, 1, 'key 只在 Bearer 头里插值一次');
    assert.match(PROVIDER, /headers\['Authorization'\] = `Bearer \$\{key\}`;/);
    assert.equal(/\$\{apiKey\}/.test(PROVIDER), false, 'apiKey 不得进任何文案模板');
  });
});

/** 源码里是否出现缓存键字面量。 */
function KEY_IN(src) {
  return /KEY_AI_MODELS_CACHE|aiModelsCache/.test(src);
}
