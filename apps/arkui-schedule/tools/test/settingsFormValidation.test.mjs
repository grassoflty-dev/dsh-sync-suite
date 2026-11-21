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
import { readSettingsSources } from './settingsSources.mjs';

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

  test('AI：模型只能下拉选，不再校验手输模型名；自定义源只校验接口地址', () => {
    assert.deepEqual(check({ customProvider: false, aiModel: '', aiBaseURL: '' }), []);
    const issues = check({ customProvider: true, aiModel: '', aiBaseURL: '' });
    assert.deepEqual(fieldsOf(issues), [FIELD_AI_BASE_URL], '不再报 AI 模型名（手输入口已删除）');
    const badBase = check({ customProvider: true, aiModel: '', aiBaseURL: 'https://' });
    assert.deepEqual(fieldsOf(badBase), [FIELD_AI_BASE_URL], '缺域名要报');
    assert.deepEqual(check({ customProvider: true, aiModel: '', aiBaseURL: 'https://api.x.com/v1' }), []);
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
    // 因 A2 拆分移动：ErrorText / IssuesBanner 不再同处一页 —— ErrorText 抽到
    // components/settings/SettingsBits.ets（五个 section 共用），IssuesBanner 仍在页面顶部。
    // 切片锚点跟着 ErrorText 走（bits 文件里它后面是 HintLine），断言（必须是 danger 色）不变。
    const bits = readSettingsFile('components/settings/SettingsBits.ets');
    const builder = bits.slice(
      bits.indexOf('ErrorText(text: string)'),
      bits.indexOf('HintLine(text: string)')
    );
    assert.ok(builder.length > 0, 'SettingsBits 里必须能找到 ErrorText 的实现');
    assert.match(builder, /app\.color\.danger/, 'ErrorText 必须用 danger');
    // mod-settings-sync-min（old→new）：deviceIdError / authorError 随「高级」折叠区删除，
    // 页面只保留三处有输入控件的错误落点；断言改钉这三处，仍逐字段检查 ErrorText 渲染。
    for (const field of ['repoUrlError', 'tokenError', 'aiBaseUrlError']) {
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
  // 因 A2 拆分移动：设置页界面拆到 `pages/Settings.ets` + `components/settings/*.ets`。
  // 本文件里「存在性」断言（某段文案 / 某个 ErrorText 调用必须在）仍然成立，因为语义没变，
  // 只是文件位置变了 —— 锚点从「单文件」改成「页面 + 三个真子页 + section + bits」的合并源码。
  // mod-settings-api-page（old→new）：readSettingsSources() 已并入 pages/SettingsApi.ets，
  // AI 错误态的存在性断言跟着代码换锚点，断言本身不变、不放宽。
  // 需要按 builder 切片、比较相对顺序的断言，另用 readSettingsFile() 指向**搬过去之后**的文件。
  return readSettingsSources();
}

/** 读设置页拆分后的某个文件（相对 `entry/src/main/ets`）。 */
function readSettingsFile(relative) {
  return readFileSyncSafe(`../../entry/src/main/ets/${relative}`);
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
  /**
   * field → Settings 页面里的内联错误状态名。
   *
   * mod-settings-sync-min（old→new）：deviceId / author / gitUsername 三个字段的输入控件与
   * 「高级」折叠区一并删除，页面不再为它们保留内联错误状态（留着会触发 structureGuards 的
   * 「幽灵报错：字段没有渲染落点」）。它们由页面传静默兜底值保证 issue 不可达，见下方用例。
   */
  const FIELD_TO_STATE = {
    [FIELD_REPO_URL]: 'repoUrlError',
    [FIELD_TOKEN]: 'tokenError',
    [FIELD_AI_BASE_URL]: 'aiBaseUrlError'
  };

  /** `checkSettingsFields`（model 侧）能返回的 field：不含页面自行追加的 gitUsername。 */
  const MODEL_FIELDS = [
    FIELD_DEVICE_ID,
    FIELD_AUTHOR,
    FIELD_REPO_URL,
    FIELD_TOKEN,
    FIELD_AI_BASE_URL
  ];

  test('checkSettingsFields 的 model field 集合不变；无控件的三个由页面静默兜底值消解', () => {
    // 一次把所有分支都踩中：空设备标识 / 空作者 / 坏地址 / 无 token / 自定义源缺地址（模型名已不校验）
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
    assert.deepEqual(returned, [...MODEL_FIELDS].sort(), 'model 侧 field 集合变了就要同步核对该模块');
    // 有输入控件的三个仍逐字段映射（不是删断言）
    for (const field of [FIELD_REPO_URL, FIELD_TOKEN, FIELD_AI_BASE_URL]) {
      assert.ok(field in FIELD_TO_STATE, `field ${field} 没有页面映射（会变成幽灵报错）`);
    }
    // 无控件的三个：页面在校验入口传已归一 / 已兜底的值，issue 不可达；不再有内联状态。
    for (const field of [FIELD_DEVICE_ID, FIELD_AUTHOR]) {
      assert.equal(field in FIELD_TO_STATE, false, `${field} 的输入控件已删，不该再有内联错误落点`);
    }
    const page = readSettingsPage();
    assert.match(page, /deviceId: normalizeDeviceId\(this\.deviceId\)/, '设备标识必须传归一值');
    assert.match(page, /const silentAuthor: string = this\.author\.trim\(\)\.length > 0 \? this\.author\.trim\(\) : '我'/, '作者名必须传兜底值');
    assert.match(page, /author: silentAuthor/, '保存 patch 也写回兜底值（不丢存量作者名）');
  });

  test('P0（old→new）：用户名无输入控件，改由 httpsUsernameFor 静默推断且存量值不清空', () => {
    // 旧断言钉住 assertHttpsUsername + FIELD_GIT_USERNAME 校验管线 + 用户名框仅 HTTPS 显示；
    // mod-settings-sync-min 删除了用户名字段与「高级」折叠区，故 retarget 到静默派生入口：
    // 不再是「校验/回填/红字」三件套，而是「推断/保留/写回」三件事，强度不降。
    const page = readSettingsPage();
    assert.equal(/FIELD_GIT_USERNAME|gitUsernameIssue|assertHttpsUsername\(/.test(page), false, '用户名校验管线必须随字段一起删除');
    assert.equal(/用户名（HTTPS 认证）/.test(page), false, '不该再有用户名输入控件文案');
    assert.match(
      page,
      /private ensureGiteeUsernameResolved\(\): void \{[\s\S]{0,320}?httpsUsernameFor\(this\.gitPlatform, this\.repoUrl, ''\)/,
      '必须按仓库地址静默推断用户名'
    );
    assert.match(page, /gitUsername: this\.gitUsername\.trim\(\)/, '保存时仍写回派生用户名');
    assert.match(page, /this\.gitUsername = settings\.gitUsername;/, '存量用户名仍可读回（不清空）');
  });

  test('P0：用户名占位文案仍留在 model/gitAuth（其它调用方复用），页面只做静默推断', () => {
    const model = readFileSyncSafe('../../entry/src/main/ets/model/gitAuth.ts');
    assert.match(model, /'必填：Gitee 登录名'/, 'Gitee 占位必须写「必填」');
    assert.match(model, /'可留空（默认 x-access-token）'/, 'GitHub 占位要说明可留空');
    assert.match(model, /'可选（留空用 x-access-token）'/, '未知平台占位');
    const page = readSettingsPage();
    assert.equal(/gitUsernamePlaceholderFor\(|gitUsernameHintFor\(/.test(page), false, '占位/提示函数不再由设置页调用');
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
      // 普通字段的清除写在 applyIssues 开头，AI 接口地址态也在其中
      assert.ok(page.indexOf(`this.${state} = '';`) < page.indexOf(`this.${state} = issue.message`), `${state} 必须先清后赋`)
    });
  }

  test('API 真页面：aiBaseUrlError 先在页面清空/赋值，再把值传给 AiSection 渲染', () => {
    // mod-settings-api-page（old→new，不替代上面的副作用断言）：AI 错误态从 SettingsHost
    // 迁到 pages/SettingsApi，这里按页锚定「清空 → 赋值 → 作为 prop 传给正文」三点，
    // 避免合并源码里文本还在、但页面侧装配断掉时漏检。
    const api = readSettingsFile('pages/SettingsApi.ets');
    assert.match(api, /@State aiBaseUrlError: string = ''/, '错误态归 API 真页面所有');
    assert.match(api, /this\.aiBaseUrlError = '';/, '每次保存前先清空');
    assert.match(api, /this\.aiBaseUrlError = issue\.message/, 'issue 必须写进内联错误态');
    assert.match(api, /aiBaseUrlError: this\.aiBaseUrlError,/, '页面必须把值传给 AiSection 才能渲染');
    assert.match(api, /checkSettingsFields\(/, '仍复用同一整表校验入口');
    const clearAt = api.indexOf('this.aiBaseUrlError = \'\';');
    const assignAt = api.indexOf('this.aiBaseUrlError = issue.message');
    assert.ok(clearAt > 0 && assignAt > clearAt, '必须先清后赋，避免上次红字残留');
  });

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
    // mod-settings-sync-page（old→new，不是放宽）：旧断言钉住宿主的 CompactBody / WideBody 两套骨架
    // 都是 Scroll → IssuesBanner → SyncGroup；同步正文与保存已迁到 pages/SettingsSync，那里是
    // 唯一真装配点。断言改为钉住同步页本身：Scroll(pageScroller) → IssuesBanner → SyncSection，
    // 同一条「横幅在 Scroll 内、在正文之前」契约，覆盖的骨架从历史锚点换成真页面。
    const page = readFileSyncSafe('../../entry/src/main/ets/pages/SettingsSync.ets');
    assert.match(page, /Scroll\(this\.pageScroller\)/, '滚动容器必须绑定 pageScroller');
    const scrollAt = page.indexOf('Scroll(this.pageScroller)');
    const bannerAt = page.indexOf('this.IssuesBanner()');
    const groupAt = page.indexOf('SyncSection({');
    assert.ok(scrollAt > 0 && bannerAt > scrollAt && bannerAt < groupAt,
      '横幅必须在 Scroll 内、且在同步正文之前');
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

// ---------------------------------------------------------------- 三个字段的说明随折叠区一起删除
//
// mod-settings-sync-min（old→new）：旧版在这里钉住 Git 用户名 / 设备标识 / 作者名三条「人话说明」
// 及其排版（FieldNote + 紧跟 FieldLabel）。用户要求「删掉高级选项及配置，其他都软件静默安排」后，
// 三条说明随输入控件与折叠区整条删除；这里改成钉住「说明已删 + 静默默认值仍在代码中」，
// 防止后来者把字段加回来却忘记补说明（或反过来只删说明、留着控件）。

describe('同步组：三个字段的标题/说明/输入框已删除，静默默认值仍在', () => {
  const page = readSettingsPage();
  const sync = readSettingsFile('components/settings/SyncSection.ets');

  test('三条字段说明与三个标题都不再出现（随折叠区删除）', () => {
    for (const gone of [
      /HTTPS 认证用；GitHub 可留空（自动 x-access-token），Gitee 自动取仓库 owner/,
      /自动分配；仅当你要手工指定时才改/,
      /默认「我」，只影响记录里的"谁记的"/,
      /用户名（HTTPS 认证）/,
      /this\.FieldLabel\('设备标识'\)/,
      /this\.FieldLabel\('作者名'\)/
    ]) {
      assert.equal(gone.test(page), false, `不该再有已删字段的标题/说明：${gone}`);
    }
  });

  test('SyncSection 不再调用 FieldNote，也不再有「高级」折叠区', () => {
    assert.equal(/this\.FieldNote\(/.test(sync), false, '同步组不该再渲染字段说明');
    assert.equal(/SyncAdvancedFields|高级\s*[▸▾]|syncAdvancedOpen/.test(sync), false, '同步组不该再有折叠区');
  });

  test('静默默认值仍在：作者名默认「我」、设备标识归一、用户名按地址推断', () => {
    assert.match(page, /this\.author\.trim\(\)\.length > 0 \? this\.author\.trim\(\) : '我'/, '作者名默认「我」');
    assert.match(page, /deviceId: normalizeDeviceId\(this\.deviceId\)/, '设备标识仍按既有 identity 归一');
    assert.match(page, /httpsUsernameFor\(this\.gitPlatform, this\.repoUrl, ''\)/, '用户名按仓库地址推断');
  });

  test('共享 FieldNote 构件仍在（其它 section 可复用），其排版契约不变', () => {
    const bits = readSettingsFile('components/settings/SettingsBits.ets');
    const builder = bits.slice(bits.indexOf('FieldNote(text: string)'));
    assert.ok(builder.length > 0, 'SettingsBits 里必须能找到 FieldNote 的实现');
    assert.match(builder, /FONT\.caption/, '说明字号必须是 caption');
    assert.match(builder, /text_secondary/, '说明颜色必须是 text_secondary');
    assert.equal(/maxLines\(1\)/.test(builder), false, '字段语义说明不能被单行省略号截断');
  });
});

// ---------------------------------------------------------------- 数据边界：主表单只留两个控件
//
// mod-settings-sync-min（old→new）：旧版在这里钉住「三个原字段藏在高级里、三种情况自动展开」。
// 用户要求删掉高级选项及配置后，折叠区整条删除、三字段改为软件静默安排；这里把断言 retarget 到
// 「控件确实消失 + 静默默认值仍在 + 失败仍有诚实状态行与重试」，不是放宽、也不是只删断言。

describe('数据边界（mod-settings-sync-min）：主表单只有两个控件，「高级」折叠区已删除', () => {
  const page = readSettingsPage();
  const syncSection = readSettingsFile('components/settings/SyncSection.ets');
  /** 同步组根 builder（就是整个表单区）。 */
  const mainForm = syncSection.slice(syncSection.indexOf('build() {'));

  test('「高级」折叠区 / 开关 / 自动展开入口全部消失', () => {
    for (const gone of [
      /@State syncAdvancedOpen/, /@State syncAdvancedReason/, /SyncAdvancedFields/,
      /高级\s*[▸▾]/, /toggleSyncAdvanced/, /openSyncAdvanced/, /syncAdvancedReason/
    ]) {
      assert.equal(gone.test(page), false, `不该再有折叠区残留：${gone}`);
    }
    assert.equal(/SyncAdvancedFields|syncAdvancedOpen/.test(syncSection), false, '组件里不该再有折叠区');
  });

  test('主表单只剩「仓库地址 / 访问令牌」两个输入框 + 固定说明 + SSH 只读警告 + 诚实状态行', () => {
    assert.match(mainForm, /Text\('仓库地址'\)/, '仓库地址是主表单字段');
    assert.match(mainForm, /this\.FieldLabel\('访问令牌（仅存本机）'\)/, '访问令牌是主表单字段');
    assert.equal((mainForm.match(/TextInput\(/g) ?? []).length, 2, '主表单恰好两个输入框：仓库地址 + 访问令牌');
    assert.equal(mainForm.includes("Text('分支')"), false, '分支不该有输入框');
    assert.equal(mainForm.includes('this.PlatformChip('), false, '主表单不该有平台 chip');
    assert.equal(/pickAuthMode\(/.test(mainForm), false, '主表单不该有认证方式选择器');
    assert.match(mainForm, /this\.HintLine\(SYNC_CAPTION\)/, '固定说明必须渲染');
    assert.match(mainForm, /Text\(SSH_STORED_WARNING\)/, '已保存 SSH 的只读警告必须渲染');
    assert.match(mainForm, /Text\(this\.syncMessage\)/, '诚实状态行必须保留');
    assert.match(mainForm, /ErrorState\(\{/, '失败三段式（原因 + 重试）必须保留');
  });

  test('三个原字段（用户名 / 设备标识 / 作者名）连折叠区一起消失，不再有任何输入框', () => {
    for (const gone of ['用户名（HTTPS 认证）', '设备标识', '作者名']) {
      assert.equal(syncSection.includes(`this.FieldLabel('${gone}')`), false, `${gone} 的标题不该出现`);
    }
    for (const gone of [/TextInput\(\{ text: this\.gitUsername/, /TextInput\(\{ text: this\.deviceId/, /TextInput\(\{ text: this\.author/]) {
      assert.equal(gone.test(syncSection), false, `${gone} 输入框不该存在`);
    }
    assert.equal(/onChangeDeviceId|onChangeAuthor|onChangeGitUsername/.test(syncSection), false, '三个字段的回调不该残留');
  });

  test('静默默认值仍在代码中：自动分配 / 作者名兜底 / 用户名推断，旧值仍可读于 store', () => {
    assert.match(page, /this\.deviceIdAuto = settings\.deviceIdAuto/, '设备编号来源仍从 store 读出');
    assert.match(page, /this\.author = settings\.author\.trim\(\)\.length > 0 \? settings\.author : '我'/, '存量作者名仍可读');
    assert.match(page, /this\.gitUsername = settings\.gitUsername/, '存量用户名仍可读');
    assert.match(page, /httpsUsernameFor\(this\.gitPlatform, this\.repoUrl, ''\)/, '用户名按地址推断');
  });

  test('失败仍有出口：身份冲突常驻警告 + 状态行 + ErrorState 重试（原「展开高级给原因」的替代）', () => {
    assert.match(mainForm, /this\.identityWarning\.length > 0/, '设备标识冲突仍是常驻警告');
    assert.match(mainForm, /ErrorState\(\{/, '同步失败仍给三段式 + 重试');
    assert.match(page, /private async runAction\(action: string\): Promise<void>/, '重试路径入口仍在');
    assert.match(page, /this\.syncMessage = `❌ \$\{info\.title\}/, '失败仍写入诚实状态行');
  });

  test('页面不打印凭据（新增代码也遵守）：无 console/hilog', () => {
    assert.equal(/console\.(log|info|warn|error)/.test(page), false);
    assert.equal(/\bHilog\./.test(page), false);
  });
});

// ---------------------------------------------------------------- F1（review P1）：旧 SSH 用户的显式出口
//
// `authMode='ssh'` 的存量用户此前只能看到一句「建议改成 HTTPS 地址后保存」，但页面上没有任何控件
// 能改 authMode —— 照做之后警告仍在、同步仍被拦。现在 SSH 警告行恰好一个显式按钮，回调只切本地
// @State（下一拍由用户点「保存设置」落盘），**不**在这里保存或下发内核。

describe('F1（review P1）：SSH 警告行的显式出口（切换不落盘）', () => {
  const page = readSettingsPage();
  const syncSection = readSettingsFile('components/settings/SyncSection.ets');

  test('警告行恰好一个「改用 HTTPS 令牌」ActionButton；handler 只切状态 + toast，不保存/不下发', () => {
    // ① 警告行（SSH 分支 → 主表单结束标记）里恰好一个动作
    const row = syncSection.slice(
      syncSection.indexOf('if (this.authMode === AUTH_SSH) {'),
      syncSection.indexOf('// ---- 主表单到此结束')
    );
    assert.ok(row.length > 0, '找不到 SSH 警告行');
    assert.match(row, /Text\(SSH_STORED_WARNING\)/, '只读警告文案必须仍在');
    const actions = [...row.matchAll(/ActionButton\(\{/g)];
    assert.equal(actions.length, 1, '警告行必须恰好一个动作（显式切换，不是隐式迁移）');
    const button = row.slice(actions[0].index);
    assert.match(button, /label: '改用 HTTPS 令牌'/, '按钮文案必须是「改用 HTTPS 令牌」');
    assert.match(button, /variant: '(ghost|secondary)'/, '沿用设置页既有按钮档位');
    assert.match(button, /onTap: \(\): void => \{\s*this\.onSwitchToHttpsToken\(\);/, '点按交给页面 handler');

    // ② 页面 handler：只切 @State + 清过时红字 + 短 toast（@Prop 单向，不能只改组件副本）
    const at = page.indexOf('private switchToHttpsToken(): void {');
    assert.ok(at > 0, '页面必须有 switchToHttpsToken handler');
    const handler = page.slice(at, page.indexOf('\n  }', at));
    assert.match(handler, /this\.authMode = AUTH_HTTPS;/, '必须显式切到 HTTPS（import AUTH_HTTPS）');
    assert.match(handler, /this\.syncMessage = '';/, '清掉上次 SSH 拦截留下的过时红字');
    assert.match(
      handler,
      /promptAction\.showToast\(\{ message: '已切换为 HTTPS \+ 令牌，保存后生效' \}\)/,
      '短提示文案'
    );
    assert.equal(/settingsStore\.save\(/.test(handler), false, '不在这里自动保存');
    assert.equal(/this\.configure\(/.test(handler), false, '不在这里自动下发同步内核');

    // ③ 装配：组件的回调 prop 必须接到页面 handler（少传 = 永远默认值，按钮白点）
    assert.match(
      page,
      /onSwitchToHttpsToken: \(\): void => \{\s*this\.switchToHttpsToken\(\);/,
      'SyncGroup 必须把回调接到页面 handler'
    );
    assert.match(syncSection, /onSwitchToHttpsToken: \(\) => void = \(\) => \{\};/, '组件必须声明回调 prop');
  });
});

// ---------------------------------------------------------------- OpenCode Go live-test 400 的表单入口
// 会话头修复不改变设置页可见字段：预设源的地址/模型由预设表提供，自定义源才校验地址。
describe('AI 源/模型字段：预设 opencode-go 不被整表校验误拦', () => {
  test('opencode-go + deepseek-v4.1-flash 走预设（无需手填地址），校验通过', async () => {
    const { findProvider, resolveModel } = await import('../.build/model/aiProvider.js');
    const preset = findProvider('opencode-go');
    assert.equal(preset.baseURL, 'https://opencode.ai/inference/go/v1');
    assert.equal(resolveModel('opencode-go', 'deepseek-v4.1-flash'), 'deepseek-v4.1-flash');

    const issues = check({ customProvider: false, aiModel: 'deepseek-v4.1-flash', aiBaseURL: '' });
    assert.deepEqual(issues, [], '预设源不该因为「没填接口地址/模型」被拦（模型只能下拉选）');
  });

  test('自定义源仍必须填地址（会话头不能掩盖配置错误）', () => {
    const issues = check({ customProvider: true, aiModel: 'custom-model', aiBaseURL: '' });
    assert.deepEqual(fieldsOf(issues), [FIELD_AI_BASE_URL]);
  });
});

