// mod-settings-ia-guards（2026-11-21）：设置信息架构（IA）**整体**守卫，TESTS + DOCS ONLY。
//
// 目标：把「根页只导航 → 四个目的地 → 每页一个主操作 → 页间无横跳 → 无死锚点」这条链路
// 作为一个整体钉住，防止将来某次重构只改其中一处、却因为没有任何一处总览而静默破坏导航模型。
//
// 编号按不变量对齐；**未使用的号是有意跳过**（该不变量已被既有守卫逐字钉住，本文件不重复、不放宽）：
// - IA-02（不变量 2：四目的地各一次 / 行标签各一次 / 行序）已由
//   `b2Batch.test.mjs` B2-18（四个路由常量）/ B2-19（行序 + 恰好 4 行）/ B2-20（每行接自己的摘要与路由）、
//   `settingsCopyGuard.test.mjs` C5（四行 + 摘要来源 + 页脚版本）、
//   `instancesEntryDedupe.test.mjs` D1（`pages/Instances` 在 Settings 树里恰好 1 处）钉住。
// - IA-03（不变量 3：两份清单登记 + 常量被 MenuRow 使用）已由
//   `settingsCopyGuard.test.mjs` C7（四子路由 + Instances 在 main/harmony 两份 main_pages.json 都登记，
//   main 12 / harmony 13 页）、`b2Batch.test.mjs` B2-20（每个常量被对应行使用）、
//   `instancesEntryDedupe.test.mjs` D3（Instances 两清单 + 顶层页仍装配 InstancesPane）钉住。
// - IA-04（不变量 4：页头标题 ↔ 行标签一致）已由 `settingsMenu.test.mjs` M-07 / M-08 / M-11、
//   `settingsCopyGuard.test.mjs` C2 / C3 / C4、`uiTokens.test.mjs` U-S5 对三个真页面逐页钉住。
//   「远程实例」行**刻意不同**：路由壳 `pages/Instances.ets` 没有 PageLayout，真标题在
//   `pages/panes/InstancesPane.ets` 的 `Text('远程 DSH')`（`indexHeader` H-1 / `instanceList` U-11 /
//   `uiTokens` U-S5 / `shellLayout` L-19 / `paneLayout` P-19 已钉）。这是实际契约，不伪造一个
//   「远程实例」标题出来；本文件 IA-08 只保证承载它的读者确实读到真实字节。
//
// 本文件只新增 IA-01 / IA-05 / IA-06 / IA-07 / IA-08 五个角度，不删、不改任何既有断言。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  ETS_ROOT,
  readApiPage,
  readExportPage,
  readSettingsFile,
  readSettingsRoot,
  readSettingsSources,
  readSyncPage
} from './settingsSources.mjs';

/** 与 instancesEntryDedupe 同款：去块注释与整行行注释，只数可执行源码（注释里的说明不算控件/路由）。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** 四个目的地（顺序 = 根页四行顺序）：读者来自共享助手，struct 名用于「读到真文件」 sanity。 */
const DESTINATIONS = [
  { label: '同步仓库', route: 'pages/SettingsSync', read: readSyncPage, struct: 'struct SettingsSync' },
  {
    label: '远程实例',
    route: 'pages/Instances',
    read: () => readSettingsFile('pages/Instances.ets'),
    struct: 'struct Instances'
  },
  { label: '数据导入导出', route: 'pages/SettingsExportImport', read: readExportPage, struct: 'struct SettingsExportImport' },
  { label: 'API 配置', route: 'pages/SettingsApi', read: readApiPage, struct: 'struct SettingsApi' }
];
const ROUTE_LITERALS = DESTINATIONS.map(({ route }) => `'${route}'`);

/**
 * 每页的动作词表：方法名 + 用户可见动作标签，都是可执行源码里的真实字面量。
 * 这些 token 才是 IA-05 的主判据（跨页独占 + 本页确实渲染）；`primary` 的 Button 字面量
 * 只作次要的 syntactic 信号，不是唯一断言——改成共享 ActionButton / 变量标签也能过主判据。
 * 单个动作的存在性另由 M-07 / M-08 / M-11、U-S5 钉住，这里钉的是「不串页」。
 */
const ACTIONS = [
  {
    name: 'SettingsSync',
    read: readSyncPage,
    primary: "Button('保存')",
    own: [
      'this.SyncMoreSheet()', 'switchToHttpsToken()',
      "Text('查看状态')", "Text('测试连接')", "Text('重试')"
    ]
  },
  {
    name: 'SettingsExportImport',
    read: readExportPage,
    primary: "Button('导出')",
    own: [
      'this.PrimaryExportButton()', 'quickExportToday()', "{ text: '确认导入'"
    ]
  },
  {
    name: 'SettingsApi',
    read: readApiPage,
    primary: "Button('保存')",
    own: ['this.testAi()', 'AiSection({']
  },
  // Instances 是 @Entry 路由壳：没有 Button，配置动作在 InstancesPane 的页头（paneLayout P-19 已钉）。
  { name: 'Instances', read: () => readSettingsFile('pages/Instances.ets'), primary: null, own: ['InstancesPane({'] }
];

describe('mod-settings-ia-guards：设置信息架构整体契约', () => {
  test('IA-01 根页只导航：配置控件族整族缺席（TextInput / TextArea / Password / Toggle / Slider / Checkbox / Select）', () => {
    const root = stripComments(readSettingsRoot());
    // mod-settings-cloud-no-config 第一例只钉 TextInput 缺席，settingsCopyGuard C6 只钉根页不渲染
    // section body。这里把「配置控件族」补齐，防止后人换一种控件把配置塞回根页而那两例仍绿。
    for (const control of [
      'TextInput(', 'TextArea(', 'InputType.Password',
      'Toggle(', 'Slider(', 'Checkbox(', 'Select('
    ]) {
      assert.equal(root.includes(control), false, `根页只做导航，不得出现配置控件 ${control}`);
    }
    // 正证据：根页不是被删空，而是仍有导航骨架（四行的细节由 B2-19/B2-20、C5 钉住）。
    assert.equal((root.match(/this\.MenuRow\(/g) ?? []).length, 4, '根页仍是四行导航菜单');
    assert.match(
      root,
      /private push\(route: string\): void \{[\s\S]{0,160}router\.pushUrl\(\{ url: route \}\)/,
      '四行仍经唯一的 push() 落到 router'
    );
  });

  test('IA-05 动作词表：每个动作标识只在自己的页面出现，且每页确实渲染自己的动作（Button 计数仅次要信号）', () => {
    const codes = ACTIONS.map(({ name, read }) => [name, stripComments(read())]);

    // 主判据①（正向）：每页都必须渲染自己词表里的每个动作——空页 / 动作被整段删掉不可能通过。
    for (const { name, own } of ACTIONS) {
      const code = codes.find(([file]) => file === name)[1];
      for (const token of own) {
        assert.ok(code.includes(token), `${name} 必须渲染自己的动作「${token}」（不能变成空页）`);
      }
    }
    // 主判据②（独占）：任一动作标识只能出现在它的 owner 页，其它三个目的地都不许渲染。
    const owners = new Map();
    for (const { name, own } of ACTIONS) {
      for (const token of own) {
        owners.set(token, name);
      }
    }
    for (const [token, owner] of owners) {
      const hits = codes.filter(([, code]) => code.includes(token)).map(([name]) => name);
      assert.deepEqual(hits, [owner], `动作「${token}」只能在 ${owner} 出现，实际命中：${hits.join(', ') || '无'}`);
    }

    // 次要信号（不是主断言）：Button('…') 字面量的数量与标签与现状一致。若将来改用共享
    // ActionButton / 变量标签，只调整这一段即可，上面的动作词表判据仍然成立。
    for (const { name, primary } of ACTIONS) {
      const code = codes.find(([file]) => file === name)[1];
      const buttons = code.match(/Button\('[^']*'\)/g) ?? [];
      assert.equal(buttons.length, primary === null ? 0 : 1,
        `${name} 的 Button 字面量数量（次要信号）异常：${buttons.length}`);
      if (primary !== null) {
        assert.ok(buttons.includes(primary), `${name} 的 Button 标签（次要信号）异常`);
      }
    }
    // 说明：同步页的次要动作是「更多」弹层里的 查看状态 / 测试连接 / 重试（M-07 已钉），
    // 仓库里并没有「重试同步」这个字面量；这里钉的是源码中真实存在的那组动作词。
  });

  test('IA-06 四目的地之间无横跳：没有 pushUrl 到另一设置页，三真页面只 router.back()', () => {
    for (const { label, read } of DESTINATIONS) {
      const code = stripComments(read());
      assert.equal(/router\.pushUrl\(/.test(code), false, `${label} 页不得有横向 pushUrl（返回只用 back）`);
      for (const literal of ROUTE_LITERALS) {
        assert.equal(code.includes(literal), false, `${label} 页不得引用另一设置目的地路由 ${literal}`);
      }
    }
    // 三个真页面自带 PageLayout.onBack → router.back()；U-S5 已钉「不得再 push pages/Settings」。
    for (const label of ['同步仓库', '数据导入导出', 'API 配置']) {
      const code = stripComments(DESTINATIONS.find((d) => d.label === label).read());
      assert.match(code, /router\.back\(\)/, `${label} 页返回必须走 router.back()`);
    }
    // Instances 是只装配 InstancesPane 的 @Entry 路由壳，本身不持有 router。
    const instanceShell = stripComments(readSettingsFile('pages/Instances.ets'));
    assert.equal(/router\./.test(instanceShell), false, 'Instances 路由壳不自带 router（返回/换段由外壳与面板负责）');
  });

  test('IA-07 根页不声明锚点机制：无 GroupAnchorBar / GroupAnchorChip / measureGroup / scrollTo（锚点实现只在未挂路由的 SettingsHost）', () => {
    const root = stripComments(readSettingsRoot());
    // 本例只证明「被路由的根页不声明任何锚点机制」，**不**证明 chip↔行一致性：
    // 这四个 token 真实存在于未被任何路由渲染的 components/settings/SettingsHost.ets，
    // 那边的 chip 与行对应关系由 settingsCopyGuard C6 / instancesEntryDedupe D2 / remoteSettings 钉住。
    for (const token of ['GroupAnchorBar', 'GroupAnchorChip', 'measureGroup', 'scrollTo(']) {
      assert.equal(root.includes(token), false, `根页不得声明锚点机制 ${token}`);
    }
    // 正证据：被检查的确实是四行导航菜单，不是一个恰好为空的文件（非空 sanity 另见 IA-08）。
    assert.equal((root.match(/this\.MenuRow\(/g) ?? []).length, 4, '根页仍是四行导航菜单，不是空文件');
  });

  test('IA-08 读者读到真实字节：每个页面源码非空且 struct 名正确（改名 / 截断不能静默过关）', () => {
    for (const { label, read, struct } of DESTINATIONS) {
      const source = read();
      assert.equal(typeof source, 'string', `${label} 的读者必须返回字符串`);
      assert.ok(source.trim().length > 100, `${label} 的读者返回空或过短源码`);
      assert.ok(source.includes(struct), `${label} 的读者没读到 ${struct}（文件可能被改名/换内容）`);
    }
    const root = readSettingsRoot();
    assert.ok(root.includes('struct Settings {'), 'readSettingsRoot() 必须读到四行菜单根页');
    const sources = readSettingsSources();
    assert.ok(sources.includes('struct SettingsSync') && sources.includes('struct SettingsApi'),
      'readSettingsSources() 必须并入真子页源码');
    const pane = readSettingsFile('pages/panes/InstancesPane.ets');
    assert.ok(pane.includes('export struct InstancesPane'), '远程实例的真标题在 InstancesPane，读者必须读到它');
    // 两份清单也必须是真实可读的 JSON（登记的具体路由由 C7 钉，这里只保证字节来源可靠）。
    for (const manifest of [
      join(ETS_ROOT, '..', 'resources', 'base', 'profile', 'main_pages.json'),
      join(ETS_ROOT, '..', '..', 'harmony', 'resources', 'base', 'profile', 'main_pages.json')
    ]) {
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      assert.ok(Array.isArray(json.src) && json.src.length >= 5, `${manifest} 必须是真实页面清单`);
    }
  });
});
