// mod-ai-drop-advanced：AI 配置「高级」折叠区 + 手输模型名已删除的源码级守卫。
//
// 旧版（mod-ui-copy-3）钉的是「模型名（可手输…）」提示只在未配置模型时渲染；
// 本模块按用户要求整条删掉：高级按钮 / 折叠区 / 手输模型名 / 相关校验与文案。
// 这些是 ArkTS 组件，Node 跑不起来，所以用静态断言固化四件事：
// ① 高级控件与手输模型名确实消失；② 服务 / 模型两个预设下拉仍接线；
// ③ 自定义源的接口地址仍在（移出折叠区、选到 custom 时常驻显示）；
// ④ 存量手输模型名仍能解析（源码链路 + resolveModel 纯函数）。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { readApiPage, readSettingsFile, readSettingsSources } from './settingsSources.mjs';

const AI_SECTION = readSettingsFile('components/settings/AiSection.ets');
// mod-settings-root → mod-settings-api-page（old→new，不是放宽）：AI 实现先随根页拆到
// SettingsHost，再随 API 真页面迁到 pages/SettingsApi。断言逐字保留，只换锚点文件。
const PAGE = readApiPage();
const SOURCES = readSettingsSources();

const BUILT = fileURLToPath(new URL('../.build/model/aiProvider.js', import.meta.url));
const BUILT_HINT = 'model/aiProvider 尚未编译到 tools/.build（先跑 tsc，再跑本测试）';

describe('mod-ai-drop-advanced：高级折叠区与手输模型名已删除', () => {
  test('AiSection 没有「高级 ▸ / ▾」控件，也没有 advancedOpen 折叠区', () => {
    assert.equal(/高级\s*[▸▾]/.test(AI_SECTION), false, 'AI 组不应再渲染「高级」开关');
    assert.equal(/advancedOpen|onToggleAdvanced/.test(AI_SECTION), false, 'AI 组的 advancedOpen 状态 / 回调必须删除');
    assert.equal(/if \(this\.advancedOpen\)/.test(AI_SECTION), false, '高级折叠分支必须删除');
  });

  test('API 真页面不再持有 AI 组的 advancedOpen / aiModelError 状态', () => {
    assert.equal(/@State advancedOpen: boolean/.test(PAGE), false, '页面不该再有 AI 组 advancedOpen @State');
    assert.equal(/@State aiModelError: string/.test(PAGE), false, 'aiModelError 内联错误状态必须删除');
    assert.equal(/onToggleAdvanced|onChangeAiModel|aiModelError:/.test(PAGE), false, 'AiSection 接线里的高级/手输回调与 prop 必须删除');
  });

  test('手输模型名输入框与其文案全部消失（无手输路径）', () => {
    assert.equal(/TextInput\(\{ text: this\.aiModel/.test(AI_SECTION), false, '模型名输入框必须删除');
    assert.equal(/模型名（可手输，留空用默认）|模型名（必填）/.test(SOURCES), false, '手输模型名的两条字段文案必须删除');
    assert.equal(/自定义源必须填写模型名|点「高级」手输/.test(SOURCES), false, '手输模型名的校验文案必须删除');
    assert.equal(/this\.onChangeAiModel|this\.aiModelError/.test(SOURCES), false, '手输模型名的回调 / 错误渲染必须删除');
  });

  test('服务 / 模型两个预设下拉仍接线，模型只能从预设列表选', () => {
    assert.match(AI_SECTION, /onOpenProviderPanel: \(\) => void/, '服务行回调仍在');
    assert.match(AI_SECTION, /onOpenModelPanel: \(\) => void/, '模型行回调仍在');
    assert.match(AI_SECTION, /Text\('服务'\)/, '服务行仍渲染');
    assert.match(AI_SECTION, /Text\('模型'\)/, '模型行仍渲染');
    assert.match(PAGE, /this\.panel = PANEL_PROVIDER/, '服务弹层仍可打开');
    assert.match(PAGE, /this\.panel = PANEL_MODEL/, '模型弹层仍可打开');
    assert.match(PAGE, /modelsOf\(this\.aiProviderId\)/, '模型列表仍来自预设表');
    assert.match(PAGE, /this\.pickModel\(item\.id\)/, '点选预设模型仍写回 aiModel');
  });

  test('自定义源接口地址仍在，且不再依赖高级折叠', () => {
    assert.match(AI_SECTION, /if \(this\.customProvider\) \{/, '自定义源分支仍在');
    assert.match(AI_SECTION, /TextInput\(\{ text: this\.aiBaseURL/, '接口地址输入框仍在');
    assert.match(AI_SECTION, /this\.FieldLabel\('接口地址 baseURL'\)/, '接口地址字段名仍在');
    const customAt = AI_SECTION.indexOf('if (this.customProvider) {');
    const baseInputAt = AI_SECTION.indexOf('TextInput({ text: this.aiBaseURL', customAt);
    assert.ok(customAt >= 0 && baseInputAt > customAt, '接口地址必须直接渲染在自定义源分支里');
    assert.equal(/this\.advancedOpen/.test(AI_SECTION), false, '接口地址不能再被高级折叠包住');
  });
});

describe('mod-ai-drop-advanced：存量手输模型名不丢失', () => {
  test('applySettings 铺回 aiModel；modelLabel 不在预设表时原样显示 id', () => {
    assert.match(PAGE, /this\.aiModel = settings\.aiModel;/, '已保存的模型名必须铺回表单（不迁移、不清空）');
    assert.match(PAGE, /return id\.length > 0 \? id : defaultModelOf\(this\.aiProviderId\);/, '非预设模型名原样显示');
    assert.match(PAGE, /aiModel: this\.aiModel,/, '保存 patch 仍写回原模型名');
    assert.match(PAGE, /this\.aiModel,[\s\S]{0,80}this\.aiBaseURL/, '测试连接仍传当前模型名');
  });

  test('settingsStore 对非空模型名原样保留、不清空（不迁移）', () => {
    const store = readSettingsFile('services/settingsStore.ets');
    assert.match(store, /resolveAiModel\(aiProviderId, aiModelForSource\)/, 'load 仍归一模型名（非空保留）');
    assert.match(store, /requestedModel\.length > 0\s*\n\s*\? resolveAiModel\(nextProviderId, requestedModel\)/, 'save 仍原样保留请求里的模型名');
    assert.equal(/aiModel:\s*''/.test(store), false, '不得把模型名静默写成空串');
  });

  test(
    'resolveModel：手输的旧模型名被原样保留，空串才回落预设默认',
    { skip: existsSync(BUILT) ? false : BUILT_HINT },
    async () => {
      const { resolveModel, defaultModelOf } = await import(pathToFileURL(BUILT).href);
      assert.equal(resolveModel('deepseek', 'my-manual-model'), 'my-manual-model', '存量手输模型名必须仍然生效');
      assert.equal(resolveModel('custom', 'mistral:7b'), 'mistral:7b', '自定义源的手输模型名同样保留');
      assert.equal(resolveModel('deepseek', ''), defaultModelOf('deepseek'), '空串才回落默认模型');
      assert.equal(resolveModel('deepseek', '   '), 'deepseek-chat', '纯空白回落默认模型');
    }
  );
});
