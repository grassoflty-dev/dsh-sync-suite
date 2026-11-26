// mod-ui-copy-1 — Settings 用户可见文案守卫。
//
// 只允许断言「用户看得见的字」：从 Settings 树 .ets 源码里抽出字符串字面量（跳过注释），
// 禁止其中出现 `v2` / `时间线`（大小写不敏感）。标识符（V2Section / v2PlanReady 等）与注释
// 不算用户可见文案，故意不扫——v2 的导出/导入是保留的产品功能，只是不再用版本号包装它。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ETS_ROOT, readApiPage, readExportPage, readSettingsFile, readSettingsPage, readSettingsRoot, readSettingsSources } from './settingsSources.mjs';
import { countRows, rowBindingRe } from './helpers/settingsRowBinding.mjs';

const FILES = [
  'pages/Settings.ets',
  'pages/SettingsSync.ets',
  'pages/SettingsExportImport.ets',
  'pages/SettingsApi.ets',
  'components/settings/SettingsHost.ets',
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
  // mod-settings-sync-page：同步正文的宿主从 SettingsHost 换到 pages/SettingsSync。
  // SyncSection 仍是 presentational body，上面所有逐字段断言一字不改；下面补钉真页面。
  const syncPage = readSettingsFile('pages/SettingsSync.ets');
  const exportPage = readExportPage();
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
  // mod-sync-silent-autoinit（old→new，非放宽）：失败前缀从 ❌ 改为三态词汇「失败：」，
  // 着色判据仍只按成功/失败、不看模式；文案更严格（逐字钉三态，不再容忍任意 ❌ 开头）。
  assert.match(sync, /this\.syncMessage\.startsWith\('失败：'\)/, '状态行只按成功/失败着色，不按模式着色');

  // 真页面（old→new，新增不替代）：标题 / 唯一主操作 / 两个字段 / 三态状态行 / 三个失败出口。
  assert.match(syncPage, /title: '同步仓库'/, '真页面标题必须是「同步仓库」');
  assert.match(syncPage, /Button\('保存'\)/, '唯一主操作是「保存」（wire 到同一校验入口）');
  assert.match(syncPage, /SyncSection\(\{/, '真页面装配 SyncSection 正文');
  assert.match(syncPage, /checkSettingsFields\(/, '保存复用拆分前同一整表校验');
  // mod-sync-silent-autoinit（old→new）：页面不再调用 syncRowSummary；唯一来源直接喂给正文。
  assert.match(syncPage, /syncMessage: this\.honestStatus\(\)/, '状态行唯一来源是 honestStatus()');
  assert.doesNotMatch(syncPage, /syncRowSummary\(/, '根页摘要函数不得出现在同步页');
  assert.doesNotMatch(syncPage, /nowIso\(\), this\.lastSyncError/, '保存 / 普通事件不得伪造成功时刻');
  // mod-status-honesty-regression：忙碌文案收敛到纯模型常量，页面只委托唯一渲染器。
  assert.match(readSettingsFile('model/syncStatusPersist.ts'), /TEXT_SYNCING: string = '同步中…'/, '忙碌态文案');
  assert.match(syncPage, /syncStatusLineOf\(\{/, '页面委托唯一渲染器');
  // mod-sync-silence-phase-b：三个手动同步出口必须**不在**真页面渲染树里（标签 + handler 双层扫描）。
  for (const action of ['查看状态', '测试连接', '重试', '立即同步', '推送']) {
    assert.doesNotMatch(syncPage, new RegExp(`Text\\('${action}'\\)`), `真页面不得有「${action}」按钮`);
    assert.doesNotMatch(syncPage, new RegExp(`label:\\s*'${action}'`), `真页面不得有「${action}」控件`);
  }
  assert.doesNotMatch(syncPage, /onClick\(\(\) => \{\s*this\.(runAction|testConnection|retryFromStatus)\(/);
  // 只扫可执行源码：注释里的「没有高级 / 没有推送」说明不算入口；「已暂停推送 N 个附件」
  // 是常驻 warning 文案（附件被远端改动），不是手动按钮，故只匹配按钮 / 文字入口的写法。
  const pageCode = withoutComments(syncPage);
  assert.equal(/高级/.test(pageCode), false, '真页面不得出现「高级」控件');
  assert.equal(/label: '推送'|label: '立即同步'|Text\('推送'\)|Text\('立即同步'\)/.test(pageCode), false,
    '真页面不得有手动推送 / 立即同步按钮');

  // mod-settings-export-page（old→new，不替代上面的正文断言）：数据子页也是真页面，
  // 自己有页头 / 唯一「导出」/ 一层 Scroll / DataSection 装配；两者都锚定，避免只真了页头。
  assert.match(exportPage, /title: '数据导入导出'/, '真页面标题必须是「数据导入导出」');
  assert.match(exportPage, /Button\('导出'\)/, '唯一主操作是「导出」');
  assert.match(exportPage, /Scroll\(this\.pageScroller\)/, '自带唯一 Scroll');
  assert.match(exportPage, /DataSection\(\{/, '真页面装配 DataSection 正文');
  assert.equal(/SettingsHost\(\{/.test(exportPage), false, '不得再是复用宿主的薄壳');
  assert.equal(/填今天/.test(withoutComments(exportPage)), false, '不得有与 chip 重复的「填今天」提示');
});

/** 注释里允许写「已删除备份节」这类说明，只检查可执行源码里的残留。 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('C3 备份节已删、媒体能力并入主流程（没有孤儿 props/handlers）', () => {
  const panel = withoutComments(readSettingsFile('components/ExportImportPanel.ets'));
  const data = withoutComments(readSettingsFile('components/settings/DataSection.ets'));
  // mod-settings-root → mod-settings-export-page（old→new，不是放宽）：实现从
  // pages/Settings.ets 搬到组件宿主，再随真页面迁到 pages/SettingsExportImport.ets；
  // 正文文本不变，断言跟着代码换锚点，仍钉住同一条「主流程完整包导出 / 试算 / 落盘」契约。
  const page = withoutComments(readExportPage());
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

  // mod-settings-api-page（old→new，不替代上面的 AiSection 断言）：用户可见文案的根锚点
  // 从薄壳 SettingsApi 换到真页面，逐字复用的正文断言仍指向 AiSection。
  const api = readApiPage();
  assert.match(api, /title: 'API 配置'/, 'API 真页面页头标题');
  assert.match(api, /AiSection\(\{/, 'API 真页面装配 AI 正文');
  assert.match(api, /Button\('保存'\)/, '唯一主操作「保存」');
  assert.equal(/SettingsHost\(\{/.test(api), false, 'API 子页不得再是复用宿主的薄壳');
  const apiCode = withoutComments(api);
  assert.equal(/高级/.test(apiCode), false, 'API 真页面不得出现「高级」控件');
  assert.equal(/模型名（可手输|模型名（必填）/.test(apiCode), false, 'API 真页面不得有手输模型名文案');
  const aiCode = withoutComments(ai);
  assert.equal(/TextInput\(\{ text: this\.aiModel/.test(aiCode), false, '正文不得有手输模型名输入框');
  assert.match(aiCode, /\.type\(InputType\.Password\)/, 'API Key 仍以密码框掩码显示');
});

// ---------------------------------------------------------------- mod-settings-root
//
// 旧断言组（组锚点 5 段、长滚动五组）随实现迁到 SettingsHost，原来的文本断言在
// readSettingsPage() 换锚点后逐字保留、没有删。下面三条是新增的正向断言，钉住新结构：
// C5 四行 + 摘要来源（不是「只有四个字」的空壳），C6 根页不渲染任何 section body，
// C7 四个路由在两份 main_pages.json 都登记（页数 12 / 13 与 validate-app 一致）。
// 设置入口唯一性继续由 uiTokens.test.mjs 的 U-S4 `settingsPushFiles() === ['Home.ets']` 钉住，
// 本文件不重复、也不放宽那条断言。

test('C5 根页恰好四行菜单：标题 / 摘要来源 / 页脚版本号', () => {
  const root = readSettingsRoot();
  assert.equal(countRows(root), 4, '根页只能有四行菜单');
  for (const [title, summary, route] of [
    ['同步仓库', 'repoSummary', 'ROUTE_SYNC'],
    ['远程实例', 'instanceSummary', 'ROUTE_INSTANCES'],
    ['数据导入导出', 'dataSummary', 'ROUTE_DATA'],
    ['API 配置', 'apiSummary', 'ROUTE_API']
  ]) {
    assert.match(root, rowBindingRe(title, summary, route),
      `缺少「${title}」行或其摘要接线`);
  }
  // 摘要来源必须读真实持久化状态，不允许写死文案。
  // mod-status-honesty-regression：严格化——必须带权威最新尝试。
  assert.match(root, /syncRowSummary\(\s*settings\.lastSyncAt, settings\.lastSyncError, syncStatusStore\.latestAttempt\(\)\s*\)/,
    '同步行摘要来源必须是权威最新尝试');
  assert.match(root, /repoHostOf\(settings\.repoUrl\)/, '同步行的仓库主机来源');
  assert.match(root, /instanceStore\.list\(\)\.length/, '实例行计数来源');
  assert.match(root, /dataRowSummary\(/, '数据行摘要来源');
  assert.match(root, /LAST_EXPORT_AT_KEY/, '导出时刻键');
  assert.match(root, /LAST_IMPORT_AT_KEY/, '导入时刻键');
  assert.match(root, /apiRowSummary\(/, 'API 行摘要来源');
  assert.match(root, /关于 · v\$\{APP_VERSION\}/, '页脚保留版本信息');
});

test('C6 根页不渲染任何 section body（也不直接挂实现宿主）', () => {
  const root = withoutComments(readSettingsRoot());
  for (const token of [
    'SyncSection(', 'AiSection(', 'DataSection(', 'AboutSection(',
    'ExportImportPanel(', 'SettingsHost(', 'ChatEntryRow('
  ]) {
    assert.equal(root.includes(token), false, `根页不得渲染 ${token}`);
  }
  // 旧五组锚点也绝不在根页复活：那会退回长滚动、破坏四行菜单。
  for (const token of ['CompactBody()', 'WideBody()', 'GroupAnchorBar()', 'SaveButton()']) {
    assert.equal(root.includes(`this.${token}`), false, `根页不得调用 ${token}`);
  }
});

test('C7 四个子路由 + Instances 在两份页面清单都登记（main 12 / harmony 13）', () => {
  const readPages = (relative) => JSON.parse(readFileSync(join(ETS_ROOT, '..', 'resources', relative), 'utf8')).src;
  const main = readPages('base/profile/main_pages.json');
  const harmony = readPages('../../harmony/resources/base/profile/main_pages.json');
  for (const route of [
    'pages/Settings', 'pages/SettingsSync', 'pages/SettingsExportImport',
    'pages/SettingsApi', 'pages/Instances'
  ]) {
    assert.ok(main.includes(route), `main 清单缺少 ${route}`);
    assert.ok(harmony.includes(route), `harmony 清单缺少 ${route}`);
  }
  assert.equal(main.length, 12, 'main 清单应为 12 页（原 9 + 三个设置子页）');
  assert.equal(harmony.length, 13, 'harmony 清单应为 13 页（原 10 + 三个设置子页）');
  assert.equal(new Set(main).size, main.length, 'main 清单不得重复登记');
});

// mod-sync-silent-autoinit：用户可见文案守新 truth —— 三态词汇 + 诊断区标注，
// 「尚未初始化 / 先拉取 / 首次克隆 / HEAD / outbox」等事实只能在诊断区，不能是提示或死结。
const SYNC_SURFACE_FILES = [
  'pages/SettingsSync.ets',
  'components/settings/SyncSection.ets',
  'services/GitSyncService.ets',
  // mod-status-honesty-regression：三态文案只在纯模型常量里定义，守卫跟到唯一来源。
  'model/syncStatusPersist.ts'
];
/** 只扫可执行字符串字面量（literalsOf 已跳过注释与模板插值）。 */
function syncLiterals(file) {
  return literalsOf(readSettingsFile(file));
}

test('C8 同步用户可见文案只有三态 + 诊断区，旧的初始化死结文案绝迹', () => {
  const all = SYNC_SURFACE_FILES.map((file) => syncLiterals(file).join('\n')).join('\n');
  // 三态词汇逐字存在（忙碌 / 成功 / 失败，失败带可重试后缀）。
  for (const token of ['同步中…', '已同步 · ', '失败：', '（可重试）']) {
    assert.ok(all.includes(token), `三态词汇缺失：${token}`);
  }
  // 诊断区标注：页面「更多」弹层与同步正文各一处，事实不再是提示。
  const page = readSettingsFile('pages/SettingsSync.ets');
  const section = readSettingsFile('components/settings/SyncSection.ets');
  for (const [name, source] of [['page', page], ['section', section]]) {
    assert.ok(source.includes('诊断（仅排查用）'), `${name} 必须有标注为诊断的区域`);
  }
  const labelAt = section.indexOf('诊断（仅排查用）');
  const statusAt = section.indexOf('Text(this.statusLine)');
  assert.ok(labelAt > 0 && statusAt > labelAt, '分支/HEAD/领先落后事实必须落在诊断标注之后');
  // 旧死结文案：这三个文件里一句都不许有（桥内部不变量不在此扫描范围，正常流程不可达）。
  for (const file of SYNC_SURFACE_FILES) {
    for (const text of syncLiterals(file)) {
      for (const banned of [/尚未初始化/, /首次克隆/, /先执行「拉取」/, /先拉取克隆仓库/]) {
        assert.equal(banned.test(text), false, `${file} 残留用户可见死结文案：${text}`);
      }
    }
  }
});

// mod-p0a-no-main-probe（C9，只加不删）：非空无 main 的 known typed 文案不套「未知错误…原始信息」；
// 空仓库是正常起点；已撤回的「以远端分支建 main」动作不得出现在用户可见文案里。
test('C9 同步面文案：known typed 不嵌套转储，空仓库不是失败，无 adopt 动作', () => {
  const all = SYNC_SURFACE_FILES.map((file) => syncLiterals(file).join('\n')).join('\n');
  for (const banned of [
    /未知错误：可以直接重试一次/, /原始信息：/, /以远端分支/, /创建 main/, /覆盖并重建/
  ]) {
    assert.equal(banned.test(all), false, `用户可见文案残留：${banned}`);
  }
  const model = readSettingsFile('model/syncError.ts');
  assert.match(model, /no-main/, 'no-main 分类必须存在');
  assert.match(model, /remote-indeterminate/, '探测未定分类必须存在');
  const cycle = readSettingsFile('model/syncCycle.ts');
  assert.match(cycle, /远端已有分支：\$\{names\}；缺少 main/, '文案必须点名真实分支');
  assert.match(cycle, /远端并非空仓库/, '非空仓库绝不能说成空仓库');
});
