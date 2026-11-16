// 设置页保存校验的纯逻辑回归测试（`model/settingsForm.ts`）。
//
// 对应线上 bug：用户填完所有可见项，点「保存设置」却一直提示「有报红的项需要处理」，
// 界面上看不到任何红字（根因：错误文案用灰色 FieldLabel 渲染 + 校验项与可见字段不匹配）。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';

// settingsForm.ts 运行时 import ./aiProvider（isValidBaseURL），编译产物里是无后缀 ESM 说明符
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.js')
      ) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const {
  AUTH_HTTPS,
  AUTH_SSH,
  FIELD_AI_BASE_URL,
  FIELD_AI_MODEL,
  FIELD_AUTHOR,
  FIELD_DEVICE_ID,
  FIELD_REPO_URL,
  FIELD_TOKEN,
  PLATFORM_GITHUB,
  PLATFORM_GITEE,
  checkSettingsFields,
  describeFirstIssue,
  describeIssues,
  effectiveToken,
  platformForRepoUrl,
  settingsFieldLabel
} = await import('../.build/model/settingsForm.js');
const { validateRepoUrl } = await import('../.build/model/repoUrl.js');

/** 一份「全部填好」的基线输入，单测里只改需要的那一两个字段。 */
function baseInput(overrides = {}) {
  return {
    deviceId: 'phone-a',
    author: '张三',
    repoUrl: 'https://gitee.com/zhangsan/schedule.git',
    token: 'token-123',
    authMode: AUTH_HTTPS,
    savedToken: '',
    customProvider: false,
    aiModel: '',
    aiBaseURL: '',
    ...overrides
  };
}

function check(overrides = {}) {
  const input = baseInput(overrides);
  return checkSettingsFields(input, validateRepoUrl(input.repoUrl));
}

function fieldsOf(issues) {
  return issues.map((issue) => issue.field);
}

describe('设置页保存校验：可见字段（token 留空沿用、平台纠正）', () => {
  test('① gitee + 空 username 场景：token 为空且无已保存值 → 报 token，且字段可见', () => {
    const issues = check({ token: '', savedToken: '' });
    assert.deepEqual(fieldsOf(issues), [FIELD_TOKEN], '只应报 token 一项');
    assert.match(issues[0].message, /token/);
    // 字段标识必须能被页面映射成中文并挂到可见的 token 输入框
    assert.equal(settingsFieldLabel(FIELD_TOKEN), 'token');
    assert.equal(FIELD_TOKEN, 'token');
  });

  test('① 变体：gitee 地址 + 空 token + 空设备标识 → 一次返回全部问题（不再只报第一条）', () => {
    const issues = check({ token: '', deviceId: '' });
    assert.equal(issues.length, 2, `应同时报 token 与设备标识：${JSON.stringify(issues)}`);
    assert.deepEqual(fieldsOf(issues), [FIELD_TOKEN, FIELD_DEVICE_ID]);
    assert.match(describeIssues(issues), /还有 2 项需要处理：token、设备标识/);
  });

  test('② github + 空 username 不参与校验（用户名不是必填项）→ 合法', () => {
    const issues = check({ repoUrl: 'https://github.com/zhangsan/schedule.git' });
    assert.deepEqual(issues, [], 'github 仓库地址本身合法，不应报错');
    // 平台自动纠正：github 域名 → github
    assert.equal(platformForRepoUrl(PLATFORM_GITEE, 'https://github.com/u/r.git'), PLATFORM_GITHUB);
  });

  test('③ token 留空但有已保存 token → 合法，且落盘沿用旧值', () => {
    const issues = check({ token: '   ', savedToken: 'saved-token-abc' });
    assert.deepEqual(issues, []);
    assert.equal(effectiveToken('   ', 'saved-token-abc'), 'saved-token-abc');
    assert.equal(effectiveToken(' typed ', 'saved-token-abc'), 'typed', '用户改了就用自己的');
    assert.equal(effectiveToken('', ''), '');
  });

  test('④ URL 含 gitee 但平台还是 github → 自动纠正后合法', () => {
    assert.equal(platformForRepoUrl(PLATFORM_GITHUB, 'https://gitee.com/u/r.git'), PLATFORM_GITEE);
    // 纠正只影响平台提示，不影响地址校验结论
    const issues = check({ repoUrl: 'https://gitee.com/u/r.git' });
    assert.deepEqual(issues, []);
    // 未知域名/空地址时保持原平台
    assert.equal(platformForRepoUrl(PLATFORM_GITHUB, 'https://git.example.com/u/r.git'), PLATFORM_GITHUB);
    assert.equal(platformForRepoUrl(PLATFORM_GITEE, ''), PLATFORM_GITEE);
  });

  test('SSH 认证下 token 可空（不误报）', () => {
    const issues = check({ authMode: AUTH_SSH, token: '', savedToken: '' });
    assert.deepEqual(issues, []);
  });

  test('仓库地址为空：不校验 token / 地址格式，其余字段照常校验', () => {
    const issues = check({ repoUrl: '', token: '', author: '' });
    assert.deepEqual(fieldsOf(issues), [FIELD_AUTHOR], '空地址不该拦 token，但作者名仍必填');
  });

  test('非法仓库地址 → 报 repoUrl，消息来自 validateRepoUrl', () => {
    const issues = check({ repoUrl: 'ftp://gitee.com/u/r.git' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].field, FIELD_REPO_URL);
    assert.match(issues[0].message, /协议/);
  });

  test('AI：预设源不校验模型/地址；自定义源缺模型与地址都要报', () => {
    assert.deepEqual(check({ customProvider: false, aiModel: '', aiBaseURL: '' }), []);
    const issues = check({ customProvider: true, aiModel: '', aiBaseURL: '' });
    assert.deepEqual(fieldsOf(issues), [FIELD_AI_MODEL, FIELD_AI_BASE_URL]);
    const badBase = check({ customProvider: true, aiModel: 'my-model', aiBaseURL: 'https://' });
    assert.deepEqual(fieldsOf(badBase), [FIELD_AI_BASE_URL], '缺域名要报');
    assert.deepEqual(check({ customProvider: true, aiModel: 'my-model', aiBaseURL: 'https://api.x.com/v1' }), []);
  });

  test('汇总文案：去重字段名、按数量报告', () => {
    const issues = [
      { field: FIELD_TOKEN, message: 'a' },
      { field: FIELD_TOKEN, message: 'b' },
      { field: FIELD_AUTHOR, message: 'c' }
    ];
    assert.equal(describeIssues(issues), '还有 3 项需要处理：token、作者名');
    assert.equal(describeIssues([]), '');
  });
});

describe('设置页保存校验：与页面源码的接线（防止退回「只报第一条 + 灰字」）', () => {
  const SETTINGS_PAGE = readSettingsPage();

  test('逐字段错误用 danger 令牌渲染（不再用灰色 FieldLabel）', () => {
    // ErrorText builder 必须是 danger 色
    const builder = SETTINGS_PAGE.slice(
      SETTINGS_PAGE.indexOf('ErrorText(text: string)'),
      SETTINGS_PAGE.indexOf('IssuesBanner()')
    );
    assert.match(builder, /app\.color\.danger/, 'ErrorText 必须用 danger');
    for (const field of ['repoUrlError', 'tokenError', 'deviceIdError', 'authorError']) {
      assert.match(SETTINGS_PAGE, new RegExp(`this\\.ErrorText\\(this\\.${field}\\)`), `${field} 必须用红色 ErrorText 渲染`);
      assert.equal(
        new RegExp(`this\\.FieldLabel\\(this\\.${field}\\)`).test(SETTINGS_PAGE),
        false,
        `${field} 不能再用灰色 FieldLabel`
      );
    }
  });

  test('校验失败：写汇总 + 滚到顶部（第一个错误字段可见）', () => {
    // 只把「有可见落点」的问题计入汇总（applyIssues 过滤后的 issuesSummary），再写进 saveHint。
    assert.match(SETTINGS_PAGE, /this\.saveHint = this\.issuesSummary/, '顶部提示要用已过滤的汇总（带字段名）');
    assert.match(SETTINGS_PAGE, /pageScroller\.scrollEdge\(Edge\.Top\)/, '必须自动滚到第一个错误字段');
    assert.match(SETTINGS_PAGE, /this\.IssuesBanner\(\)/, '表单顶部要有红色汇总条');
  });

  test('幽灵拦截守卫：issuesSummary 为空时不拦保存', () => {
    assert.match(
      SETTINGS_PAGE,
      /const blocking: boolean = this\.issuesSummary\.length > 0/,
      '拦截条件必须基于 issuesSummary（已过滤、有落点的问题）'
    );
    assert.match(SETTINGS_PAGE, /if \(blocking\)/, '存在 blocking 分支');
    assert.equal(
      /console\.(log|info|warn|error)/.test(SETTINGS_PAGE),
      false,
      'Settings 属凭据敏感文件，不允许 console（无落点问题静默跳过即可）'
    );
  });

  test('保存成功要清掉汇总；失败不再用「请先修正标红的问题」', () => {
    assert.match(SETTINGS_PAGE, /this\.issuesSummary = ''/);
    assert.equal(/请先修正标红的问题/.test(SETTINGS_PAGE), false, '旧文案要点名具体字段');
  });
});

function readSettingsPage() {
  return readFileSyncSafe('../../entry/src/main/ets/pages/Settings.ets');
}

function readFileSyncSafe(relative) {
  // 用 URL 解析，保证从仓库任意工作目录跑都成立
  const url = new URL(relative, import.meta.url);
  return readText(url);
}

function readText(url) {
  const { readFileSync } = process.getBuiltinModule('node:fs');
  return readFileSync(url, 'utf8');
}

// ---------------------------------------------------------------- 幽灵报错守卫
//
// 线上现象：横幅说「还有 N 项需要处理」，界面上却**没有任何一处红字**。
// 根因：某类 issue 只被记进汇总、没有落到可见字段的内联错误状态（baseURL 曾如此）。
// 这组用例把「每个 field ↔ 内联状态 ↔ 渲染分支」钉成一张表，任何一边缺失就红。

describe('幽灵报错守卫：每个 issue 都必须有可见落点', () => {
  /** field → Settings 页面里的内联错误状态名。 */
  const FIELD_TO_STATE = {
    [FIELD_DEVICE_ID]: 'deviceIdError',
    [FIELD_AUTHOR]: 'authorError',
    [FIELD_REPO_URL]: 'repoUrlError',
    [FIELD_TOKEN]: 'tokenError',
    [FIELD_AI_MODEL]: 'aiModelError',
    [FIELD_AI_BASE_URL]: 'aiBaseUrlError',
    // P0：HTTPS 用户名（Gitee 必填登录名）。字段常量定义在 Settings 页里（model 侧由别人维护）
    gitUsername: 'gitUsernameError'
  };

  /** `checkSettingsFields`（model 侧）能返回的 field：不含页面自行追加的 gitUsername。 */
  const MODEL_FIELDS = [
    FIELD_DEVICE_ID,
    FIELD_AUTHOR,
    FIELD_REPO_URL,
    FIELD_TOKEN,
    FIELD_AI_MODEL,
    FIELD_AI_BASE_URL
  ];

  test('checkSettingsFields 可能返回的 field 全部有页面映射', () => {
    // 一次把所有分支都踩中：空设备标识 / 空作者 / 坏地址 / 无 token / 自定义源缺模型与地址
    const issues = check({
      deviceId: '',
      author: '',
      repoUrl: 'ftp://gitee.com/u/r.git',
      token: '',
      savedToken: '',
      customProvider: true,
      aiModel: '',
      aiBaseURL: ''
    });
    const returned = [...new Set(issues.map((issue) => issue.field))].sort();
    assert.deepEqual(returned, [...MODEL_FIELDS].sort(), 'model 侧 field 集合变了就要同步补 UI');
    for (const field of returned) {
      assert.ok(field in FIELD_TO_STATE, `field ${field} 没有页面映射（会变成幽灵报错）`);
    }
  });

  test('P0：HTTPS 用户名复用 assertHttpsUsername，且 FIELD_GIT_USERNAME 走同一套管线', () => {
    const page = readSettingsPage();
    assert.match(page, /const FIELD_GIT_USERNAME: string = 'gitUsername';/, '页面必须有该字段常量');
    assert.match(
      page,
      /assertHttpsUsername\(platform, this\.authMode, this\.gitUsername\)/,
      '必须复用 model/gitAuth 的规则（不要页面自带一套）'
    );
    assert.match(page, /if \(usernameIssue !== null\) \{\s*\n\s*issues\.push\(usernameIssue\);/, '用户名问题要进同一份 issues');
    assert.match(page, /gitUsername: this\.gitUsername\.trim\(\)/, '保存时必须写进 SettingsPatch');
    assert.match(page, /this\.gitUsername = settings\.gitUsername;/, '进页面时要回填已保存的用户名');
  });

  test('P0：用户名占位文案跟着平台变（GitHub 可留空 / Gitee 必填 / 其它可选）', () => {
    const page = readSettingsPage();
    assert.match(page, /'必填：Gitee 登录名'/, 'Gitee 占位必须写「必填」');
    assert.match(page, /'可留空（默认 x-access-token）'/, 'GitHub 占位要说明可留空');
    assert.match(page, /return '可选';/, '未知平台占位');
    // 只在 HTTPS 下渲染用户名框（SSH 不该出现）
    assert.match(page, /if \(this\.authMode === AUTH_HTTPS\) \{[\s\S]{0,400}用户名（HTTPS 认证）/, '用户名框仅 HTTPS 显示');
  });

  for (const [field, state] of Object.entries(FIELD_TO_STATE)) {
    test(`${field} → this.${state}：既有赋值也有红色渲染`, () => {
      const page = readSettingsPage();
      assert.match(
        page,
        new RegExp(`this\\.${state} = issue\\.message`),
        `${field} 必须在 applyIssues 里写 this.${state}（否则汇总说有、界面没红字）`
      );
      assert.match(
        page,
        new RegExp(`this\\.ErrorText\\(this\\.${state}\\)`),
        `${field} 必须在字段下方用 ErrorText 渲染 this.${state}`
      );
      // 每次保存前必须清空（避免上次红字残留 / 幽灵）
      assert.match(page, new RegExp(`this\\.${state} = '';`), `${state} 必须被清空`)
      // 普通字段的清除写在 applyIssues 开头，AI 两态也在其中
      assert.ok(page.indexOf(`this.${state} = '';`) < page.indexOf(`this.${state} = issue.message`), `${state} 必须先清后赋`)
    });
  }

  test('横幅只统计「真正落到可见字段」的问题（不从原始 issues 直接算）', () => {
    const page = readSettingsPage();
    assert.match(page, /const applied: SettingsFieldIssue\[\] = \[\]/, 'applyIssues 必须累积 applied')
    assert.match(page, /applied\.push\(issue\)/, '每个写进内联状态的 issue 才计入 applied')
    assert.match(page, /describeIssues\(applied\.length > 0 \|\| issues\.length === 0 \? applied : issues\)/, '横幅数据源必须是 applied')
    assert.equal(/this\.issuesSummary = describeIssues\(issues\);/.test(page), false, '不能直接从原始 issues 出汇总')
    assert.match(page, /describeFirstIssue\(applied\)/, '横幅第二行给第一条原因')
    assert.match(page, /if \(this\.firstIssueText\.length > 0\)/, 'firstIssueText 必须渲染')
  });

  test('横幅在可滚动区域内部顶部（scrollEdge(Edge.Top) 才有效）', () => {
    const page = readSettingsPage();
    // 两套骨架（紧凑/宽屏）都要：Scroll(pageScroller) → IssuesBanner → SyncGroup
    const compact = page.slice(page.indexOf('CompactBody() {'), page.indexOf('WideBody() {'));
    const wide = page.slice(page.indexOf('WideBody() {'), page.indexOf('SaveButton()', page.indexOf('WideBody() {')));
    for (const body of [compact, wide]) {
      assert.match(body, /Scroll\(this\.pageScroller\)/, '滚动容器必须绑定 pageScroller');
      const scrollAt = body.indexOf('Scroll(this.pageScroller)');
      const bannerAt = body.indexOf('this.IssuesBanner()');
      const groupAt = body.indexOf('this.SyncGroup()');
      assert.ok(bannerAt > scrollAt && bannerAt < groupAt, '横幅必须在 Scroll 内、且在第一个分组之前');
    }
  });

  test('token 第二次进入：输入框留空 + 有已存 token → 合法（回归用户场景）', () => {
    // 用户第一次填好并保存；第二次只改别的项，token 框是空的（不想改 token）
    const issues = check({ token: '', savedToken: 'ghp_saved_token_value' });
    assert.deepEqual(issues, [], '留空且已存 token 时不该报 token');
    // 且落盘时用旧值，不能把 token 清空
    assert.equal(effectiveToken('', 'ghp_saved_token_value'), 'ghp_saved_token_value');
  });

  test('gitee + 一切正常时整表零问题（用户「都填好了」的期望状态）', () => {
    const issues = check({
      repoUrl: 'https://gitee.com/zhangsan/schedule.git',
      token: '',
      savedToken: 'gitee-token-saved',
      deviceId: 'phone-a',
      author: '张三'
    });
    assert.deepEqual(issues, []);
    assert.equal(describeIssues(issues), '');
    assert.equal(describeFirstIssue(issues), '');
  });
});
