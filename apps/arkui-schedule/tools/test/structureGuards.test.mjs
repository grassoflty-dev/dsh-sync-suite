// 结构断言：**防「文本匹配抓得住出现、抓不住是否被用」**。
//
// 由来：A2 拆分把 `pages/Settings.ets` 的五个功能组搬进 `components/settings/*.ets` 之后，
// 原先的静态守卫都改成「在页面 + 五个 section 的合并源码里 grep」。合并源码里文本当然都在，
// 于是下面三种坏法一条都抓不到：
//   a. `@State` 字段声明了、只在方法里赋值，**界面上没有任何一处读它**（死状态）；
//   b. 校验类字段（`xxxIssue` / `xxxError` / `xxxWarning`）记进汇总，**没有渲染调用点**（幽灵报错）；
//   c. 页面把某个 prop 名字拼错 / 干脆忘了传，组件永远走默认值（数据在拆分处断掉）。
// 这三条都不是「文本在不在」的问题，是「结构连不连得上」的问题，所以单独一组断言盯着，
// 判据来自 `helpers/structureGuards.mjs`（`build()` / `@Builder` 区间 + 读写计数 + 双向装配）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { APP_ROOT, relToEts, stripComments } from './helpers/etsSource.mjs';
import { requireOverlayRestored } from './guard.mjs';
import {
  collectIssueFields,
  collectStateFields,
  componentFiles,
  declaredMembers,
  fieldUsage,
  fieldsWithoutRenderSite,
  hasRenderSite,
  passedKeys,
  propWiringViolations,
  structNameOf,
  unreadStateFields,
  wiringViolations
} from './helpers/structureGuards.mjs';

// 构建期 overlay 生效时，本文件的结构扫描结论无意义 → 硬失败（不跳过、不自动 restore）。
requireOverlayRestored('structureGuards.test.mjs');

// mod-settings-root（old→new）：section 装配点随实现从 pages/Settings.ets 搬到组件宿主，
// 断言（少传 / 多传都报）不变，只换锚点文件；根页现在是四行菜单，不再装配 section。
const PAGE_SETTINGS = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'components', 'settings', 'SettingsHost.ets');
// mod-settings-sync-page（old→new）：同步正文的真装配点在 pages/SettingsSync.ets，
// 不再由 SettingsHost 装配 SyncSection。断言跟着代码换锚点，双向对齐强度不变。
const PAGE_SYNC = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'pages', 'SettingsSync.ets');
// mod-settings-export-page（old→new）：数据正文的真装配点在 pages/SettingsExportImport.ets，
// 不再由 SettingsHost 装配 DataSection。断言跟着代码换锚点，双向对齐强度不变。
const PAGE_EXPORT = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'pages', 'SettingsExportImport.ets');
// mod-settings-api-page（old→new）：AI 正文的真装配点从 SettingsHost 换到 pages/SettingsApi.ets，
// 断言跟着代码换锚点，双向对齐强度不变。
const PAGE_API = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'pages', 'SettingsApi.ets');
// S4 外壳真值：装配（Home ↔ ShellRail）+ 两份页面清单登记。
const PAGE_HOME = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'pages', 'Home.ets');
const SHELL_RAIL = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'components', 'shell', 'ShellRail.ets');
const ENTRY_ABILITY = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'entryability', 'EntryAbility.ets');
const PANE_FILES = ['SchedulePane', 'InstancesPane', 'CloudChatPane', 'DotsPane']
  .map((name) => join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'pages', 'panes', `${name}.ets`));
const HOME_CODE = stripComments(readFileSync(PAGE_HOME, 'utf8'));
const RAIL_CODE = stripComments(readFileSync(SHELL_RAIL, 'utf8'));
const MAIN_PAGES = JSON.parse(readFileSync(join(APP_ROOT, 'entry', 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json'), 'utf8'));
const HARMONY_PAGES = JSON.parse(readFileSync(join(APP_ROOT, 'entry', 'src', 'harmony', 'resources', 'base', 'profile', 'main_pages.json'), 'utf8'));
// mod-settings-sync-page / mod-settings-export-page / mod-settings-api-page：SyncSection /
// DataSection / AiSection 从宿主装配集合移出，分别改由三个真页面单独装配；
// 本宿主只剩 AboutSection 一个装配点。
const SECTION_FILES = [
  // RemoteSection.ets 随 mod-settings-remote-dedupe 删除（配置统一在 pages/Instances）
  'components/settings/AboutSection.ets'
].map((relative) => join(APP_ROOT, 'entry', 'src', 'main', 'ets', ...relative.split('/')));
const SYNC_SECTION_FILE = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'components', 'settings', 'SyncSection.ets');
const DATA_SECTION_FILE = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'components', 'settings', 'DataSection.ets');
const AI_SECTION_FILE = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'components', 'settings', 'AiSection.ets');

/**
 * 「只被写、从未被读」的 `@State` 白名单——**逐条写理由**。
 *
 * 这两条都是「只被 PageLayout 的 onBreakpointChange 布局回调写入」的半个断点字段：
 * 页面真正参与布局的是同一次回调里的另一个字段（Index 读 `contentWidth` 算栏宽、
 * SchedulePane 依 `contentWidth` 决定主从），留下来的这个既没有渲染影响，也不拦保存。
 * mod-settings-root 后 SettingsHost 的两个半断点字段已删除，不再需要白名单条目。
 * 之所以不直接删：回调签名 `(breakpoint, widthVp)` 是 PageLayout 定的，删一个字段要动
 * 组件的对外契约，属于另一件事；这里先用白名单把「新出现的死状态」挡住。
 */
const STATE_READ_ALLOWLIST = [
  {
    file: 'main/ets/pages/Index.ets',
    field: 'breakpoint',
    reason: '只由 PageLayout.onBreakpointChange 写入；Index 的栏宽分支读 contentWidth，breakpoint 暂无消费者'
  },
  // mod-settings-root：SettingsHost 的 `breakpoint` / `contentWidth` 随旧断点骨架一起删除
  //（子页只有一层 Scroll、没有消费者），原来给 contentWidth 的白名单条目也一并移除，
  // 不留过期白名单。下表只剩 Index 与 SchedulePane 两个真实半断点字段。
  {
    file: 'main/ets/pages/panes/SchedulePane.ets',
    field: 'breakpoint',
    reason: 'S3 从 Index 逐字迁入：同理由只由 PageLayout.onBreakpointChange 写入；主从分支读 contentWidth，breakpoint 暂无消费者'
  }
];

describe('结构断言：@State 至少被读一次 / issue 必须有渲染落点', () => {
  test('死状态：pages/*.ets 与 components/**/*.ets 里每个 @State 至少被读一次', (t) => {
    const files = componentFiles();
    assert.ok(files.length >= 20, `扫描文件太少（${files.length}），说明目录写错了`);
    const { violations, fields } = unreadStateFields(files, STATE_READ_ALLOWLIST);
    t.diagnostic(`扫描 ${files.length} 个文件 / ${fields.length} 个 @State / 白名单 ${STATE_READ_ALLOWLIST.length} 条`);
    assert.deepEqual(
      violations.map((item) => `${item.file}:${item.line} ${item.field} —— ${item.reason}`),
      [],
      '死状态：@State 只写不读（要么补渲染，要么删掉，要么进白名单并写理由）'
    );
  });

  // mod-settings-root（old→new，不是放宽）：旧自测拿 SettingsHost.contentWidth 当样本；
  // 该字段随旧断点骨架删除后，改用 Index.breakpoint（同类型「只写不读」字段）验证检查器有效性。
  test('死状态检查不会漏：临时把 Index.breakpoint 从白名单里去掉必须被抓住（自测）', () => {
    const { violations } = unreadStateFields(componentFiles(), STATE_READ_ALLOWLIST.filter((item) => !(item.file.endsWith('pages/Index.ets') && item.field === 'breakpoint')));
    assert.deepEqual(
      violations.map((item) => `${item.file} ${item.field}`),
      ['main/ets/pages/Index.ets breakpoint'],
      '去掉白名单条目后必须只剩这一条死状态，否则检查本身失效了'
    );
  });

  test('可见落点：校验类字段必须出现在 build()/@Builder 里（不是只声明）', (t) => {
    const files = componentFiles();
    const { violations, fields } = fieldsWithoutRenderSite(files);
    t.diagnostic(`校验类字段 ${fields.length} 个（@State+@Prop），全部要求有渲染调用点`);
    assert.deepEqual(
      violations.map((item) => `${item.file}:${item.line} ${item.field} —— ${item.reason}`),
      [],
      '幽灵报错：issue 字段没有渲染落点'
    );
    // 覆盖率下限：Settings 的 3 个内联错误（repoUrlError / tokenError / aiBaseUrlError；
    // branchError 随 mod-settings-lean、aiModelError 随 mod-ai-drop-advanced、
    // deviceIdError / authorError / gitUsernameError 随 mod-settings-sync-min 删除）
    // + 2 个警告（identityWarning / attachmentWarning）
    // + 页面侧同类字段（lastSyncError / remoteUrlError）都要被扫到；删除控件后下限同步减。
    // mod-settings-root（old→new）：锚点从 pages/Settings.ets 换到实现宿主，字段集合与下限不变。
    // mod-settings-sync-page / mod-settings-export-page（old→new，不是放宽）：repoUrlError /
    // tokenError / identityWarning / attachmentWarning / lastSyncError 随同步正文迁到
    // pages/SettingsSync，aiBaseUrlError 随 mod-settings-api-page 迁到 pages/SettingsApi；
    // 数据页没有任何校验类字段，宿主亦不再持有字段错误态。
    // 断言范围改为「宿主 + 同步页 + 数据页」并集，原来 6 个字段一个不少，下限不降。
    const settingsFields = collectIssueFields(files).filter((item) =>
      item.file.startsWith('main/ets/components/settings/SettingsHost.ets') ||
      item.file.startsWith('main/ets/pages/SettingsSync.ets') ||
      item.file.startsWith('main/ets/pages/SettingsExportImport.ets') ||
      item.file.startsWith('main/ets/pages/SettingsApi.ets'));
    // 6 = 3 内联错误（repoUrlError / tokenError / aiBaseUrlError）+ 2 警告 + lastSyncError
    // mod-settings-api-page（old→new，不是放宽）：aiBaseUrlError 随 AI 正文从宿主迁到
    // pages/SettingsApi，断言范围改为「宿主 + 同步页 + 数据页 + API 页」并集，6 个字段一个不少。
    assert.ok(settingsFields.length >= 6, `Settings 的校验类字段只剩 ${settingsFields.length} 个，检查范围疑似缩了`);
  });

  test('装配对齐：页面传给各 section 的 props 与组件声明双向一致', (t) => {
    // mod-settings-sync-page / mod-settings-export-page（old→new，不是放宽）：SyncSection 与
    // DataSection 的装配点从 SettingsHost 换到各自真页面；Ai/About 仍在宿主。三条断言各自
    // 双向对齐，覆盖的组件集合不变（少传 = 永远默认值，多传 = 名字拼错）。
    const hostViolations = propWiringViolations(PAGE_SETTINGS, SECTION_FILES);
    const syncViolations = propWiringViolations(PAGE_SYNC, [SYNC_SECTION_FILE]);
    const dataViolations = propWiringViolations(PAGE_EXPORT, [DATA_SECTION_FILE]);
    const apiViolations = propWiringViolations(PAGE_API, [AI_SECTION_FILE]);
    const violations = hostViolations.concat(syncViolations, dataViolations, apiViolations);
    t.diagnostic(`宿主装配点 ${SECTION_FILES.length} 个 + 同步页 1 个 + 数据页 1 个 + API 页 1 个`);
    assert.deepEqual(
      violations.map((item) => `${item.file} —— ${item.reason}`),
      [],
      'section 装配断了（少传 = 永远默认值，多传 = 名字拼错被静默忽略）'
    );
  });

  test('helper 自测：读写判定 / 声明解析 / 装配 key 解析（纯文本用例）', () => {
    const sample = [
      'struct Demo {',
      '  @State label: string = "";',
      '  @State count: number = 0;',
      '  save() {',
      '    this.label = "a";',
      '    this.count = 1;',
      '    this.count += 1;',
      '  }',
      '  @Builder Row() {',
      '    Text(this.label)',
      '  }',
      '}'
    ].join('\n');
    assert.deepEqual(fieldUsage(sample, 'label'), { reads: 1, writes: 1, total: 2 }, '读一次写一次');
    assert.deepEqual(fieldUsage(sample, 'count'), { reads: 0, writes: 2, total: 2 }, '`+=` 也算写');
    assert.deepEqual(
      fieldUsage('if (this.count == 1) {}', 'count'),
      { reads: 1, writes: 0, total: 1 },
      '`==` 是读，不是写'
    );
    assert.deepEqual(
      declaredMembers('  @Prop a: string = "";\n  onChange: (v: string) => void;\n  build() {\n  }\n').map((m) => m.name),
      ['a', 'onChange'],
      '声明解析要能认出回调函数成员'
    );
    const call = 'FooSection({\n      a: this.a,\n      b: this.b,\n      onChange: (v: string): void => {\n        this.a = v;\n      }\n    })';
    assert.deepEqual(passedKeys(call, 'FooSection'), ['a', 'b', 'onChange'], '装配 key 只取顶层缩进，不把回调体里的字段算进来');
    assert.equal(passedKeys(call, 'Missing'), null, '找不到调用点返回 null');
  });

  test('helper 自测：可见落点要「作为值」出现，只在条件里读不算（幽灵报错）', () => {
    const ghost = [
      'struct Demo {',
      "  @State deviceIdError: string = '';",
      '  build() {',
      '    if (this.deviceIdError.length > 0) {',
      "      Text('')",
      '    }',
      '  }',
      '}'
    ].join('\n');
    assert.equal(hasRenderSite(ghost, 'deviceIdError'), false, '只在 if 条件里读 = 界面上没有红字，必须判为没有落点');

    const rendered = ghost.replace("      Text('')", '      this.ErrorText(this.deviceIdError)');
    assert.equal(hasRenderSite(rendered, 'deviceIdError'), true, '作为参数传给 ErrorText 才是真落点');

    const templated = ghost.replace("      Text('')", '      Text(`${this.deviceIdError}`)');
    assert.equal(hasRenderSite(templated, 'deviceIdError'), true, '模板插值也算渲染');

    const outsideBuild = ghost.replace('  build() {', '  helper() {\n    this.ErrorText(this.deviceIdError);\n  }\n  build() {');
    assert.equal(hasRenderSite(outsideBuild, 'deviceIdError'), false, '只在普通方法里传给 ErrorText，不在渲染树里');
  });

  test('helper 自测：装配少传 / 多传都要报（拆分处断线）', () => {
    const section = [
      'export struct FooSection {',
      "  @Prop token: string = '';",
      "  @Prop tokenError: string = '';",
      '  onChangeToken: (v: string) => void;',
      '  build() {',
      '  }',
      '}'
    ].join('\n');
    const pageMissing = 'FooSection({\n      token: this.token,\n      onChangeToken: (v: string): void => {}\n    })';
    const missing = wiringViolations(pageMissing, 'FooSection', section).map((item) => item.reason);
    assert.deepEqual(
      missing,
      ['页面没给 FooSection.tokenError 传值（组件只会用默认值，拆分后数据断了）'],
      `少传必须报出来：\n${missing.join('\n')}`
    );

    const pageExtra = pageMissing.replace('      token: this.token,', '      token: this.token,\n      tokenErr: this.tokenError,');
    const extra = wiringViolations(pageExtra, 'FooSection', section).map((item) => item.reason);
    assert.deepEqual(
      extra,
      [
        '页面没给 FooSection.tokenError 传值（组件只会用默认值，拆分后数据断了）',
        '页面给 FooSection 传了未声明的 tokenErr（拼错名字会被静默忽略）'
      ],
      `拼错名字必须报出来：\n${extra.join('\n')}`
    );

    assert.deepEqual(wiringViolations('nothing here', 'FooSection', section), [
      { reason: '页面里找不到 FooSection({ … }) 调用点（组件没被挂上）' }
    ]);
  });

  test('白名单过期要报错（防止只增不减）', () => {
    // mod-settings-root（old→new）：deviceId 随实现搬到组件宿主，假白名单的文件锚点跟着改；
    // 自测意图不变（一条「字段现在会被读」+ 一条「字段不存在」）。
    const stale = [
      { file: 'main/ets/components/settings/SettingsHost.ets', field: 'deviceId', reason: 'fake：这个字段其实会被读' },
      { file: 'main/ets/components/settings/SettingsHost.ets', field: 'noSuchField', reason: 'fake：这个字段不存在' }
    ];
    const { violations } = unreadStateFields(componentFiles(), stale);
    const messages = violations.map((item) => `${item.field}: ${item.reason}`);
    assert.ok(messages.includes('deviceId: 白名单条目已过期（字段现在会被读了），请删掉'), `应报「字段现在会被读」：\n${messages.join('\n')}`);
    assert.ok(messages.includes('noSuchField: 白名单条目已过期（源码里没有这个 @State），请删掉'), `应报「字段不存在」：\n${messages.join('\n')}`);
  });

  test('collectStateFields 覆盖到页面与组件（不是只扫一个文件；S4 追加外壳两文件）', () => {
    const fields = collectStateFields(componentFiles());
    const files = new Set(fields.map((item) => item.file));
    assert.ok(files.has('main/ets/pages/Settings.ets'), '必须扫到 Settings 四行根页');
    // mod-settings-root：实现宿主搬到 components/settings，必须一并进死状态扫描范围。
    assert.ok(files.has('main/ets/components/settings/SettingsHost.ets'), '必须扫到 SettingsHost 实现宿主');
    assert.ok(files.has('main/ets/pages/Index.ets'), '必须扫到 Index 页面');
    // S4：新增的两个文件必须进扫描范围（否则外壳的 @State 死状态检查等于没跑）。
    assert.ok(files.has('main/ets/pages/Home.ets'), '必须扫到新的外壳页 Home.ets');
    assert.ok(files.has('main/ets/components/shell/ShellRail.ets'), '必须扫到 ShellRail.ets');
    // mod-settings-export-page：真页面也必须进死状态扫描，否则它的 @State 等于没检查。
    assert.ok(files.has('main/ets/pages/SettingsExportImport.ets'), '必须扫到数据真页面 SettingsExportImport.ets');
    assert.ok(files.has('main/ets/pages/SettingsApi.ets'), '必须扫到 API 真页面 SettingsApi.ets（AI @State 的死状态检查不能漏）');
    assert.ok(fields.length > 100, `@State 总数 ${fields.length} 明显偏少`);
    // S3：四个面板下沉到 pages/panes/，必须全部进扫描文件集（三个占位只有 @Prop，
    // 不产生 @State 字段，所以要直接查 componentFiles() 而不是查 fields）。
    const scanned = new Set(componentFiles().map((file) => relToEts(file)));
    for (const pane of ['SchedulePane', 'InstancesPane', 'CloudChatPane', 'DotsPane']) {
      assert.ok(scanned.has(`main/ets/pages/panes/${pane}.ets`), `必须扫到面板 ${pane}.ets`);
    }
  });
});

// ---------------------------------------------------------------- 外壳装配（S4 新增）
//
// 旧断言 → 新断言（都不是削弱）：
//   · 「页面传给五个 section 的 props 双向一致」→ SG-S1：Home 两处 ShellRail 装配的四个 props 双向齐全；
//   · 「@State 扫描覆盖 Index/Settings」→ 上方同一条用例扩展为 +Home/+ShellRail；
//   · 「结构守卫只管组件内部」→ SG-S2/SG-S3：把页面清单登记与四节/齿轮结构纳入结构检查。
describe('结构断言：外壳装配（Home ↔ ShellRail）', () => {
  test('SG-S1 两处 ShellRail 装配的四个 props 双向齐全（宽屏常驻轨 + compact 抽屉轨）', () => {
    const calls = [...HOME_CODE.matchAll(/ShellRail\(\{/g)];
    assert.equal(calls.length, 2, '常驻轨与抽屉轨各一处装配，缺一即某断点无导航');
    const expected = ['compact', 'onOpenSettings', 'onSelect', 'section'].sort();
    for (const call of calls) {
      const keys = passedKeys(HOME_CODE.slice(call.index), 'ShellRail');
      assert.ok(keys !== null, 'ShellRail 装配点必须有属性区');
      assert.deepEqual([...keys].sort(), expected, '少传 = 永远默认值，多传 = 拼错被静默忽略');
    }
    // 组件侧四个对外成员必须在（内部 @State 不算对外契约）。
    for (const member of ['@Prop section:', '@Prop compact:', 'onSelect:', 'onOpenSettings:']) {
      assert.ok(RAIL_CODE.includes(member), `ShellRail 缺少对外成员 ${member}`);
    }
  });

  test('SG-S2 外壳登记进两份页面清单（mod-settings-root 后 main 12 页，harmony 13 页为超集）', () => {
    assert.ok(MAIN_PAGES.src.includes('pages/Home'), 'main main_pages.json 缺少 pages/Home');
    assert.ok(HARMONY_PAGES.src.includes('pages/Home'), 'harmony main_pages.json 缺少 pages/Home');
    // 旧断言 main 9 → 新 main 12（+ 三个设置子页）；不是放宽：页数与 validate-app 的 pages 计数
    // 必须一致，且四个设置路由逐个钉住，harmony 13 必须是真超集。
    assert.equal(MAIN_PAGES.src.length, 12, 'main 清单应为 12 页（与 validate-app 的 pages 12 一致）');
    assert.equal(HARMONY_PAGES.src.length, 13, 'harmony 清单应为 13 页（原 10 + 三个设置子页）');
    assert.equal(new Set(MAIN_PAGES.src).size, MAIN_PAGES.src.length, 'main 清单不得重复');
    for (const route of ['pages/Settings', 'pages/SettingsSync', 'pages/SettingsExportImport', 'pages/SettingsApi']) {
      assert.ok(MAIN_PAGES.src.includes(route), `main 清单缺少 ${route}`);
      assert.ok(HARMONY_PAGES.src.includes(route), `harmony 清单缺少 ${route}`);
    }
    for (const entry of MAIN_PAGES.src) {
      assert.ok(HARMONY_PAGES.src.includes(entry), `harmony 清单必须是 main 的超集，缺少 ${entry}`);
    }
  });

  test('SG-S3 四节平级顺序表 + 齿轮行与回调装配，齿轮不是第五个 section', () => {
    const order = /SHELL_SECTION_ORDER: ShellSectionInfo\[\] = \[([\s\S]*?)\];/.exec(RAIL_CODE);
    assert.ok(order, '必须存在 SHELL_SECTION_ORDER 顺序表');
    const ids = [...order[1].matchAll(/SHELL_INFO_([A-Z_]+)/g)].map((match) => match[1]);
    assert.deepEqual(ids, ['DOTS', 'SCHEDULE', 'INSTANCES', 'CLOUD_CHAT'],
      '顺序固定为 dots / schedule / instances / cloudChat');
    const build = RAIL_CODE.slice(RAIL_CODE.indexOf('  build() {'));
    assert.match(build, /ForEach\(SHELL_SECTION_ORDER,[\s\S]{0,140}this\.SectionRow\(info\)/, '四节共用一个顺序表');
    assert.equal((build.match(/this\.SectionRow\(/g) ?? []).length, 1, '不手写第五个节行');
    assert.match(build, /Divider\(\)[\s\S]{0,200}this\.SettingsRow\(\)/, '齿轮行在分隔线之后');
    const settingsRow = RAIL_CODE.slice(RAIL_CODE.indexOf('  SettingsRow() {'));
    assert.match(settingsRow, /\.onClick\(\(\) => \{\s*\n\s*this\.onOpenSettings\(\);/, '齿轮只发 onOpenSettings');
    assert.match(HOME_CODE, /onOpenSettings: \(\): void => \{\s*\n\s*this\.openSettings\(\);/, '父页接住齿轮事件');
    const fired = RAIL_CODE.match(/this\.onOpenSettings\(\)/g) ?? [];
    assert.equal(fired.length, 1, 'rail 只在齿轮行 onClick 发一次事件，不得自行跳页或重复触发');
  });

  test('SG-S4 四面板的 id / active props 与 Home 的四处装配双向齐全', () => {
    assert.equal(PANE_FILES.length, 4, '四个面板文件必须齐全');
    const calls = [...HOME_CODE.matchAll(/\b(?:Dots|Schedule|Instances|CloudChat)Pane\(\{/g)];
    assert.equal(calls.length, 4, 'Home 必须装配四个面板（不卸载）');
    for (const file of PANE_FILES) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const name = structNameOf(file);
      assert.ok(name.length > 0, `${file} 必须导出一个 struct`);
      assert.match(code, /@Prop deepLinkId: string/, `${name} 缺少深链 id prop`);
      assert.match(code, /@Prop active: boolean/, `${name} 缺少保活 active prop`);
      const at = HOME_CODE.indexOf(`${name}({`);
      assert.ok(at >= 0, `Home 没有装配 ${name}`);
      const keys = passedKeys(HOME_CODE.slice(at), name);
      assert.ok(keys !== null, `${name} 装配点必须有属性区`);
      assert.deepEqual([...keys].sort(), ['active', 'deepLinkId'], '少传 = 保活/深链断线；多传 = 名字拼错被静默忽略');
    }
  });

  test('SG-S5 启动入口是 pages/Home，pages/Index 仍登记为 fallback 路由', () => {
    const entry = stripComments(readFileSync(ENTRY_ABILITY, 'utf8'));
    assert.match(entry, /loadContent\('pages\/Home'/, '入口必须翻到外壳 Home');
    assert.equal(entry.includes("loadContent('pages/Index'"), false, '入口不得再指向旧首页');
    for (const pages of [MAIN_PAGES, HARMONY_PAGES]) {
      assert.ok(pages.src.includes('pages/Home'), '页面清单必须登记外壳 Home');
      assert.ok(pages.src.includes('pages/Index'), '页面清单必须保留 fallback Index');
    }
  });

  test('SG-S6 设置出口唯一（mod-settings-entry-dedupe）：外壳 + 四面板恰好一处 Settings push、位于 Home，面板页头无设置动作', () => {
    const sources = [
      ['Home.ets', HOME_CODE],
      ['ShellRail.ets', RAIL_CODE],
      ...PANE_FILES.map((file) => [file.split(/[\\/]/).pop(), stripComments(readFileSync(file, 'utf8'))])
    ];
    const hits = sources
      .filter(([, code]) => /pushUrl\(\{\s*url:\s*'pages\/Settings'\s*\}\)/.test(code))
      .map(([name]) => name);
    assert.deepEqual(hits, ['Home.ets'],
      '正向断言：Settings push 恰好一处、位于 Home.ets（rail 齿轮 → Home.openSettings）');
    for (const [name, code] of sources.filter(([file]) => file.endsWith('Pane.ets'))) {
      assert.equal(/headerActionTwo|onHeaderActionTwo|⚙ 设置|private openSettings/.test(code), false,
        `${name} 不得含有设置动作（唯一出口 = rail 齿轮）`);
    }
    assert.match(RAIL_CODE, /this\.SettingsRow\(\)/, '唯一 UI 入口是 rail 页脚齿轮');
    assert.equal((HOME_CODE.match(/onOpenSettings: \(\): void => \{\s*\n\s*this\.openSettings\(\);/g) ?? []).length, 2,
      '宽屏常驻轨与 compact 抽屉轨都必须把齿轮事件接到 openSettings');
  });
});
