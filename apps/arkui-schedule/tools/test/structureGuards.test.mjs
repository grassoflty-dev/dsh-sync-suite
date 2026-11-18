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
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { APP_ROOT } from './helpers/etsSource.mjs';
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
  unreadStateFields,
  wiringViolations
} from './helpers/structureGuards.mjs';

// 构建期 overlay 生效时，本文件的结构扫描结论无意义 → 硬失败（不跳过、不自动 restore）。
requireOverlayRestored('structureGuards.test.mjs');

const PAGE_SETTINGS = join(APP_ROOT, 'entry', 'src', 'main', 'ets', 'pages', 'Settings.ets');
const SECTION_FILES = [
  'components/settings/SyncSection.ets',
  'components/settings/AiSection.ets',
  'components/settings/RemoteSection.ets',
  'components/settings/DataSection.ets',
  'components/settings/AboutSection.ets'
].map((relative) => join(APP_ROOT, 'entry', 'src', 'main', 'ets', ...relative.split('/')));

/**
 * 「只被写、从未被读」的 `@State` 白名单——**逐条写理由**。
 *
 * 这两条都是「只被 PageLayout 的 onBreakpointChange 布局回调写入」的半个断点字段：
 * 页面真正参与布局的是同一次回调里的另一个字段（Index 读 `contentWidth` 算栏宽、
 * Settings 读 `breakpoint` 选骨架），留下来的这个既没有渲染影响，也不拦保存。
 * 之所以不直接删：回调签名 `(breakpoint, widthVp)` 是 PageLayout 定的，删一个字段要动
 * 组件的对外契约，属于另一件事；这里先用白名单把「新出现的死状态」挡住。
 */
const STATE_READ_ALLOWLIST = [
  {
    file: 'main/ets/pages/Index.ets',
    field: 'breakpoint',
    reason: '只由 PageLayout.onBreakpointChange 写入；Index 的栏宽分支读 contentWidth，breakpoint 暂无消费者'
  },
  {
    file: 'main/ets/pages/Settings.ets',
    field: 'contentWidth',
    reason: '只由 PageLayout.onBreakpointChange 写入；Settings 的骨架分支读 breakpoint，contentWidth 暂无消费者'
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

  test('死状态检查不会漏：临时把 contentWidth 从白名单里去掉必须被抓住（自测）', () => {
    const { violations } = unreadStateFields(componentFiles(), STATE_READ_ALLOWLIST.filter((item) => item.field !== 'contentWidth'));
    assert.deepEqual(
      violations.map((item) => `${item.file} ${item.field}`),
      ['main/ets/pages/Settings.ets contentWidth'],
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
    // 覆盖率下限：Settings 的 9 个内联错误 + 2 个警告 + 页面侧同类字段都要被扫到
    const settingsFields = collectIssueFields(files).filter((item) => item.file.startsWith('main/ets/pages/Settings.ets'));
    assert.ok(settingsFields.length >= 12, `Settings 的校验类字段只剩 ${settingsFields.length} 个，检查范围疑似缩了`);
  });

  test('装配对齐：页面传给五个 section 的 props 与组件声明双向一致', (t) => {
    const violations = propWiringViolations(PAGE_SETTINGS, SECTION_FILES);
    t.diagnostic(`装配点 ${SECTION_FILES.length} 个`);
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
    const stale = [
      { file: 'main/ets/pages/Settings.ets', field: 'deviceId', reason: 'fake：这个字段其实会被读' },
      { file: 'main/ets/pages/Settings.ets', field: 'noSuchField', reason: 'fake：这个字段不存在' }
    ];
    const { violations } = unreadStateFields(componentFiles(), stale);
    const messages = violations.map((item) => `${item.field}: ${item.reason}`);
    assert.ok(messages.includes('deviceId: 白名单条目已过期（字段现在会被读了），请删掉'), `应报「字段现在会被读」：\n${messages.join('\n')}`);
    assert.ok(messages.includes('noSuchField: 白名单条目已过期（源码里没有这个 @State），请删掉'), `应报「字段不存在」：\n${messages.join('\n')}`);
  });

  test('collectStateFields 覆盖到页面与组件（不是只扫一个文件）', () => {
    const fields = collectStateFields(componentFiles());
    const files = new Set(fields.map((item) => item.file));
    assert.ok(files.has('main/ets/pages/Settings.ets'), '必须扫到 Settings 页面');
    assert.ok(files.has('main/ets/pages/Index.ets'), '必须扫到 Index 页面');
    assert.ok(fields.length > 100, `@State 总数 ${fields.length} 明显偏少`);
  });
});
