// mod-ui-copy-1 — Settings 用户可见文案守卫。
//
// 只允许断言「用户看得见的字」：从 Settings 树 .ets 源码里抽出字符串字面量（跳过注释），
// 禁止其中出现 `v2` / `时间线`（大小写不敏感）。标识符（V2Section / v2PlanReady 等）与注释
// 不算用户可见文案，故意不扫——v2 的导出/导入是保留的产品功能，只是不再用版本号包装它。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSettingsFile, readSettingsSources } from './settingsSources.mjs';

const FILES = [
  'pages/Settings.ets',
  'components/settings/SettingsBits.ets',
  'components/settings/SyncSection.ets',
  'components/settings/AiSection.ets',
  // RemoteSection.ets 随 mod-settings-remote-dedupe 删除（配置统一在 pages/Instances）
  'components/settings/DataSection.ets',
  'components/settings/AboutSection.ets',
  'components/ExportImportPanel.ets', // 由 DataSection 直接渲染，属设置页界面树
  'services/syncStatusStore.ets'       // 设置页/首页共用的状态行文案来源
];

const BANNED = /v2|时间线/i;

/**
 * 允许表：确定无法改名、且不是用户可见文案的字面量才登记。
 * 当前为空：所有曾含 v2 / 时间线的文案已改成中性中文（「日程备份」/「导入备份」…）；
 * 模板串的 `${…}` 插值在 literalsOf 里统一剥离（它们是代码标识符，不算文案）。
 */
const ALLOWED_LITERALS = [];

/** 模板串里的 `${…}` 是代码标识符（如 v2RefusalNext / v2PlanText），不是用户看到的字。 */
function withoutInterpolations(value) {
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] === '$' && value[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < value.length && depth > 0) {
        if (value[i] === '{') {
          depth++;
        } else if (value[i] === '}') {
          depth--;
        }
        i++;
      }
      continue;
    }
    out += value[i++];
  }
  return out;
}

/**
 * 抽字符串字面量（单引号 / 双引号 / 模板串），跳过块注释与行注释。
 * 逐字符扫描而不是正则：注释里的 `v2 备份` 说明不算文案，URL 里的 // 也不是注释。
 */
function literalsOf(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let value = '';
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          value += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        value += source[i++];
      }
      out.push(quote === '`' ? withoutInterpolations(value) : value);
      continue;
    }
    i++;
  }
  return out;
}

test('C1 用户可见文案不含 v2 / 时间线（允许表为空）', () => {
  for (const file of FILES) {
    const hits = literalsOf(readSettingsFile(file))
      .filter((text) => BANNED.test(text) && !ALLOWED_LITERALS.includes(text));
    assert.deepEqual(hits, [], `${file} 残留 v2/时间线 文案：${hits.join(' | ')}`);
  }
  assert.deepEqual(ALLOWED_LITERALS, [], '允许表必须为空；新增条目要有明确理由');
});

test('C2 中性区块标题 + 数据组只有一个导入/导出入口', () => {
  const sync = readSettingsFile('components/settings/SyncSection.ets');
  const data = readSettingsFile('components/settings/DataSection.ets');
  const panel = readSettingsFile('components/ExportImportPanel.ets');
  assert.match(sync, /Text\('同步仓库'\)/, '同步组标题必须是自然的中文「同步仓库」');
  assert.match(data, /Text\('数据'\)/, '数据组标题保持「数据」');
  assert.match(panel, /this\.GroupTitle\('导出'\)/, '面板必须保留唯一的导出组');
  assert.match(panel, /this\.GroupTitle\('导入'\)/, '面板必须保留唯一的导入组');
  assert.match(panel, /label: '导出完整包'/, '主导出按钮必须产出含媒体的完整包');
  assert.equal((data.match(/ExportImportPanel\(\{/g) ?? []).length, 1, '数据组只能装配一个面板');
  assert.equal((panel.match(/this\.GroupTitle\('导出'\)/g) ?? []).length, 1, '导出标题只能出现一次');
  assert.equal((panel.match(/this\.GroupTitle\('导入'\)/g) ?? []).length, 1, '导入标题只能出现一次');
  assert.equal((panel.match(/label: '导出完整包'/g) ?? []).length, 1, '只能有一个导出按钮');
  assert.match(sync, /Text\('仓库地址'\)/, '仓库地址输入必须保留');
  assert.match(sync, /this\.FieldLabel\('访问令牌（仅存本机）'\)/, '令牌输入必须保留');
  assert.match(sync, /Text\(this\.syncMessage\)/, '诚实同步状态行必须保留');
  assert.match(sync, /ErrorState\(\{/, '同步失败三段式（原因 + 重试）必须保留');
  assert.match(sync, /this\.syncMessage\.startsWith\('❌'\)/, '状态行只按成功/失败着色，不按模式着色');
});

/** 注释里允许写「已删除备份节」这类说明，只检查可执行源码里的残留。 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('C3 备份节已删、媒体能力并入主流程（没有孤儿 props/handlers）', () => {
  const panel = withoutComments(readSettingsFile('components/ExportImportPanel.ets'));
  const data = withoutComments(readSettingsFile('components/settings/DataSection.ets'));
  const page = withoutComments(readSettingsFile('pages/Settings.ets'));
  for (const [name, source] of [['panel', panel], ['data', data], ['page', page]]) {
    for (const token of [
      'V2Section', '日程备份', '导出备份', '选择备份并试算', '确认导入备份',
      'v2PlanReady', 'v2PlanText', 'v2Message', 'v2Busy',
      'onV2Export', 'onV2Pick', 'onV2Apply', 'onV2Cancel',
      'handleV2Export', 'handleV2Pick', 'handleV2Apply', 'handleV2Cancel'
    ]) {
      assert.equal(source.includes(token), false, `${name} 残留已删备份节的 token：${token}`);
    }
  }
  // 能力保留：媒体走主导出/导入同一入口的分支，不再有第二个 section。
  assert.match(page, /exportV2Timeline\(/, '主导出必须调完整包导出（含 media.zip）');
  assert.match(page, /planV2ImportFromPicked\(/, '主导入试算必须能识别完整包');
  assert.match(page, /applyV2Import\(/, '主确认导入必须能落盘完整包（含媒体）');
  assert.match(panel, /导出完整包/, '面板文案必须说明主导出含媒体');
});

// mod-ai-drop-advanced：AI/API 配置的「高级」按钮与手输模型名已删除。
// 用户可见文案守卫同样覆盖这次删除：折叠开关 / 字段标题不能再出现；
// 服务 / 模型两个预设下拉与自定义源接口地址必须还在。
test('C4 AI 配置无「高级」按钮与手输模型名文案，预设服务/模型下拉仍在', () => {
  const ai = readSettingsFile('components/settings/AiSection.ets');
  const settings = readSettingsSources();
  assert.equal(/高级\s*[▸▾]/.test(ai), false, 'AI 组不应再出现「高级 ▸ / ▾」开关文案');
  assert.equal(/模型名（可手输，留空用默认）|模型名（必填）/.test(settings), false, '手输模型名的字段标题必须删除');
  assert.equal(/自定义源必须填写模型名|点「高级」手输/.test(settings), false, '手输模型名的校验文案必须删除');
  assert.match(ai, /Text\('服务'\)/, '服务下拉行仍在');
  assert.match(ai, /Text\('模型'\)/, '模型下拉行仍在');
  assert.match(ai, /this\.FieldLabel\('接口地址 baseURL'\)/, '自定义源接口地址仍在');
});
