// 空态契约守卫（ED-01…ED-07）。为什么必须有这份测试：
// 37c81f9 采纳了空态 doctrine，pages/Chats.ets 已按契约走 `EmptyState` + `showAction:false`，
// 但两个 chat 面板没有跟进：DotsPane 在空态硬编码「Text('还没有 dots 对话')」+「ActionButton({label:'刷新'})」，
// 设备验证抓到这个同步形状的「刷新」按钮，直接违反产品规则「不要有同步或者导出按钮」。
// CloudChatPane 是同一个抄过来的形状。本文件把「守卫会说不」的证据固化成下面的旁路表：
//   R1 字面标题 + Button；R2 字面标题 + ActionButton；R3 同对组合藏进 @Builder；
//   R4 文件内 marker 常量 + Text(NAME)；R5 模板静态前缀；R6 只有 actionLabel:、没有 Button token。
// 六条都必须被**同一个**探测器判红（不写第二套检测器），且形状 / 行号要对得上；
// N1/N2/N3 三条负控必须保持绿，证明这不是「见 Text 就禁」的一刀切。
// 范围、刻意排除项与「词法探针 ≠ 语义证明」的边界都写在 helpers/emptyStateScan.mjs 里；
// 语义判据始终是 model/stateView.ts 的 emptyStateIssue()，本文件只在 ED-05 直接调用它。
// ED-08 / ED-09 是后补的第二条规则：同一探测器还判 `EmptyState({…})` 的按钮形状——
// 没有 `showAction: false` 时，无 actionLabel 会静默回落「刷新」，同步形状的 actionLabel
// 与无法解析的变量也都必须红；真实出路文案（添加实例 / 去设置 / 生成汇总 / 全选 / 返回）保持绿。
// 这条规则在真实树上没有 red-before 历史（修复前两个面板没有 EmptyState），证据是 fixture 探针 + ED-08 的逐点枚举。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ETS_ROOT, listFiles, matchBrace, relToEts, stripComments } from './helpers/etsSource.mjs';
import {
  EMPTY_TITLE_MARKERS,
  FALLBACK_ACTION_MESSAGE,
  UNRESOLVABLE_ACTION_MESSAGE,
  findEmptyStateActionViolations,
  findEmptyStateBypass,
  scanEmptyStateActions
} from './helpers/emptyStateScan.mjs';

// 与 stateView.test.mjs 同一套 import 风格：纯逻辑源码的相对 import 不带 .js 后缀，Node ESM 解析时补上。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});
const { emptyStateIssue } = await import('../.build/model/stateView.js');

/** 取 marker 之后那对花括号的内部文本（行号无关，只取渲染块）。 */
function blockAfter(source, marker) {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `找不到渲染块 ${marker}`);
  const brace = source.indexOf('{', at);
  assert.notEqual(brace, -1, `${marker} 后面没有花括号`);
  const [start, end] = matchBrace(source, brace);
  return source.slice(start + 1, end - 1);
}

/** 逐字取 `const NAME: string = '…';`（含跨行的 `=\n  '…'` 写法）。 */
function stringConst(source, name) {
  const pattern = new RegExp(`const\\s+${name}\\s*:\\s*string\\s*=\\s*'([^'\\n]*)'\\s*;`);
  const matched = pattern.exec(source);
  assert.ok(matched, `找不到字符串常量 ${name} 的逐字定义`);
  return matched[1];
}

/** 空态构造的公共正向契约：走 EmptyState、显式 opt-out、动作 token 与假刷新一律绝迹。 */
function assertEmptyStateContract(source, kind) {
  const upper = kind.toUpperCase();
  assert.match(source, new RegExp(`import\\s*\\{\\s*EmptyState\\s*\\}\\s*from\\s*['"][^'"]*components/state/EmptyState['"];`),
    `${kind} 面板必须 import EmptyState，不得自己拼空态渲染树`);
  const empty = blockAfter(source, '\n  EmptyChats() {');
  assert.match(empty, /EmptyState\(\{/, `${kind} 空态必须调用 EmptyState({…})`);
  assert.match(empty, /showAction:\s*false/, `${kind} 空态必须显式 showAction: false（唯一 opt-out）`);
  assert.match(empty, new RegExp(`title:\\s*EMPTY_${upper}_TITLE`), `${kind} 空态标题必须走本文件的 EMPTY_${upper}_TITLE`);
  assert.match(empty, new RegExp(`detail:\\s*EMPTY_${upper}_DETAIL`), `${kind} 空态事实句必须走本文件的 EMPTY_${upper}_DETAIL`);
  for (const token of ['ActionButton(', 'Button(', 'actionLabel:', 'onAction:', '.onClick(', "'刷新'"]) {
    assert.equal(empty.includes(token), false, `${kind} 空态块不得残留动作 token「${token}」（空态没有按钮）`);
  }
  return empty;
}

describe('空态 doctrine：面板不再旁路 EmptyState（old→new，只收紧不放宽）', () => {
  test('ED-01 扫描集合非空且覆盖两个面板与 Chats.ets', () => {
    const files = listFiles(join(ETS_ROOT, 'main', 'ets', 'pages'), ['.ets']);
    assert.ok(files.length > 10, `pages 递归扫描必须 > 10 个 .ets，实测 ${files.length}`);
    for (const name of ['DotsPane.ets', 'CloudChatPane.ets', 'Chats.ets']) {
      assert.ok(files.some((file) => file.replace(/\\/g, '/').endsWith(`/${name}`)),
        `扫描集合必须包含 ${name}`);
    }
    assert.ok(EMPTY_TITLE_MARKERS.length >= 3, '空态 marker 表不能退化为空白名单');
  });

  test('ED-02 真实树：pages/** 下没有任何「渲染空态标题 + 同文件动作」的旁路', () => {
    const files = listFiles(join(ETS_ROOT, 'main', 'ets', 'pages'), ['.ets']);
    assert.ok(files.length > 10, '扫描集合必须是非空集合，不能 vacuous pass');
    const violations = [];
    for (const file of files) {
      const rel = relToEts(file);
      for (const hit of findEmptyStateBypass(readFileSync(file, 'utf8'), rel)) {
        violations.push(`${hit.file}:${hit.line} [${hit.shape}] Text(「${hit.title}」) 与同一文件的按钮 / actionLabel 共存`);
      }
    }
    // 修复前这条断言必须点名两个面板；把全部命中一次性打出来，避免只报排序靠前的那一个。
    assert.deepEqual(violations, [],
      `空态标题 + 按钮的同文件旁路必须为零；修复前此处应同时点名 DotsPane.ets 与 CloudChatPane.ets，实测：\n${violations.join('\n')}`);
  });

  test('ED-03 DotsPane 正向契约：EmptyState + showAction:false，旧短下一步绝迹', () => {
    const raw = readFileSync(join(ETS_ROOT, 'main', 'ets', 'pages', 'panes', 'DotsPane.ets'), 'utf8');
    const source = stripComments(raw);
    assertEmptyStateContract(source, 'dots');
    assert.match(source, /const EMPTY_DOTS_TITLE: string = '还没有 dots 对话';/, '新标题常量逐字保留');
    assert.match(source, /const EMPTY_DOTS_DETAIL: string =/, '新事实句常量逐字保留');
    assert.equal(source.includes('先在设置里同步一次仓库'), false, '旧的「同步一次仓库」短下一步必须绝迹');
    assert.equal(source.includes('DOTS_NEXT_STEP'), false, '旧常量 DOTS_NEXT_STEP 必须彻底删除');
  });

  test('ED-04 CloudChatPane 正向契约：EmptyState + showAction:false，历史锚点保留', () => {
    const raw = readFileSync(join(ETS_ROOT, 'main', 'ets', 'pages', 'panes', 'CloudChatPane.ets'), 'utf8');
    const source = stripComments(raw);
    assertEmptyStateContract(source, 'cloud');
    assert.match(source, /const EMPTY_CLOUD_TITLE: string = '还没有云端对话';/, '新标题常量逐字保留');
    assert.match(source, /const EMPTY_CLOUD_DETAIL: string =/, '新事实句常量逐字保留');
    assert.equal(source.includes('CLOUD_REPO_SETUP'), false, '旧常量 CLOUD_REPO_SETUP 必须彻底删除');
    // 历史锚点注释里 REASON_CLOUD 是迁移记录，旧守卫钉着它——删注释会让那条守卫红。
    assert.ok(raw.includes('REASON_CLOUD'), '历史锚点注释必须保留 REASON_CLOUD（迁移记录，勿当作现行语义）');
  });

  // ED-05 old→new：旧守卫只钉「面板 cloud 句 === Chats.ets cloud 句」这一条字节等号，
  // 于是页面那句真话（onPageShow 真会重读）被原样抄进保活面板，变成当时做不到的空头支票：
  // 当时面板只在 aboutToAppear / 全局刷新 tick 重读，回到本页并不会自动读到新数据；
  // d90c75e 起 Home.onPageShow() 在每次从其他页面返回首页（页级返回）时无条件推进 dots / cloudChat 两个 tick，
  // 面板的 @Watch 因此每次返回都做一次本地会话索引重读（无网络 / 无第二个周期 / 无定时器 / 无 toast）；
  // 页内切段由 Home.selectSection 只赋 section / drawerOpen、不推进 tick，保活面板不重读，旧前提只指页级返回。
  // R2-01：第三句「本页显示最近一次同步的结果」仍在一条可达路径上为假——Chats 页 pull 走
  // syncController.pullNow() 绕过 globalRefreshCoordinator；若用户在该 pull 仍在飞行时回到首页，
  // 本次本地重读可能早于 pull 落地，面板停在上次读取到的结果；无后续订阅，下一次触发才反映。
  // Lead 判据是「逐字可证为真」，所以第三句改成「本页显示上次读取到的同步结果」，并把「最近一次」列为拒绝形状。
  // 新守卫换成四段更紧的钉子：(a) 批准前缀两边逐字相同；(a2) R2-02 dots 专属前缀存在，让 (c) 的名词归一不空转；
  // (b) 第三句必须是诚实句且不含假承诺形状；
  // (c) 两个面板除名词外逐字相同、页面原句必须仍保留「回到本页即可看到」，防止有人反向把页面文案也抹掉。
  test('ED-05 事实句诚实：emptyStateIssue 通过、占位符被拒、无命令词、批准前缀 / 诚实第三句 / 两面板只差名词 / 页面保留自己的真句', () => {
    const dots = stripComments(readFileSync(join(ETS_ROOT, 'main', 'ets', 'pages', 'panes', 'DotsPane.ets'), 'utf8'));
    const cloud = stripComments(readFileSync(join(ETS_ROOT, 'main', 'ets', 'pages', 'panes', 'CloudChatPane.ets'), 'utf8'));
    const chats = stripComments(readFileSync(join(ETS_ROOT, 'main', 'ets', 'pages', 'Chats.ets'), 'utf8'));
    const dotsTitle = stringConst(dots, 'EMPTY_DOTS_TITLE');
    const dotsDetail = stringConst(dots, 'EMPTY_DOTS_DETAIL');
    const cloudTitle = stringConst(cloud, 'EMPTY_CLOUD_TITLE');
    const cloudDetail = stringConst(cloud, 'EMPTY_CLOUD_DETAIL');
    const chatsDetail = stringConst(chats, 'EMPTY_CLOUD_DETAIL');

    for (const [title, detail] of [[dotsTitle, dotsDetail], [cloudTitle, cloudDetail]]) {
      assert.equal(emptyStateIssue(title, '', false, detail), '',
        `「${title}」的 detail 必须是事实句，emptyStateIssue 不得报问题：「${detail}」`);
      assert.notEqual(emptyStateIssue(title, '', false, '暂无数据'), '',
        `「${title}」配占位符 detail「暂无数据」必须被 emptyStateIssue 拒绝`);
      for (const word of ['点', '按', '请', '试试', '导出', '同步一次']) {
        assert.equal(detail.includes(word), false,
          `空态事实句只讲事实，不得含命令 / 同步 / 导出词「${word}」：「${detail}」`);
      }
    }

    // (a) 已批准的前缀：页面与面板逐字相同，锁住 clauses 1–2 不被顺手改掉。
    const approvedPrefix = '先在设置里配置仓库；之后云端会话会在后台自动同步过来；';
    for (const [label, detail] of [['CloudChatPane', cloudDetail], ['Chats.ets', chatsDetail]]) {
      assert.ok(detail.startsWith(approvedPrefix),
        `${label} 的 EMPTY_CLOUD_DETAIL 必须以批准前缀逐字开头「${approvedPrefix}」，实测「${detail}」`);
    }

    // (a2) R2-02 存在性钉：dots 句必须以 dots 专属的批准前缀逐字开头。否则 (c) 把 dots 归一成「云端」
    // 后再比相等就可能空转——未来作者把 dots 句里的名词删掉，(c) 仍会静默通过。
    const approvedDotsPrefix = '先在设置里配置仓库；之后 dots 会话会在后台自动同步过来；';
    assert.ok(dotsDetail.startsWith(approvedDotsPrefix),
      `DotsPane 的 EMPTY_DOTS_DETAIL 必须以 dots 专属批准前缀逐字开头「${approvedDotsPrefix}」，实测「${dotsDetail}」`);

    // (b) 第三句诚实：两个面板都只陈述「显示上次读取到的同步结果」，不得残留做不到的承诺形状（含「最近一次」）。
    const honestTail = '本页显示上次读取到的同步结果。';
    const falsePromises = ['回到本页', '即可看到', '立即', '马上', '自动刷新', '最近一次'];
    for (const [label, detail] of [['DotsPane', dotsDetail], ['CloudChatPane', cloudDetail]]) {
      assert.ok(detail.endsWith(honestTail),
        `${label} 的 detail 必须以诚实句结尾「${honestTail}」（回到首页现在会通过推进的 tick 触发本地重读，但 Chats 页发起的 pull 若仍在飞行，读取可能早于其落地，故仍不能声称「最近一次」），实测「${detail}」`);
      for (const shape of falsePromises) {
        assert.equal(detail.includes(shape), false,
          `${label} 的 detail 不得含做不到的承诺形状「${shape}」，实测「${detail}」`);
      }
    }

    // (c) 两面板只差名词；页面自己的真句必须保留，防止有人「统一文案」把页面的真承诺删掉。
    // 名词两侧的排版空格是 dots 句自带的（批准文案里是「 dots 」对「云端」），只把名词连同两侧空格
    // 一起归一，其余字节仍要求逐字相等——不能因为空格就放弃「两面板只差名词」这条钉子。
    assert.equal(dotsDetail.replace(/\s*dots\s*/, '云端'), cloudDetail,
      `两个面板的事实句必须只差名词（ dots → 云端，空格随名词归一）：\nDotsPane =「${dotsDetail}」\nCloudChatPane =「${cloudDetail}」`);
    assert.ok(chatsDetail.includes('回到本页即可看到'),
      `pages/Chats.ets 在 onPageShow 真会重读，它的原句必须保留「回到本页即可看到」，实测「${chatsDetail}」`);
  });

  test('ED-06 六条旁路红探针：同一探测器必须逐个判红且形状 / 行号正确', () => {
    const fixtures = [
      {
        id: 'R1', shape: 'text-literal', line: 4, title: '还没有 dots 对话',
        source: [
          '@Component',
          'struct R1 {',
          '  build() {',
          "    Text('还没有 dots 对话')",
          "    Button('刷新')",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'R2', shape: 'text-literal', line: 4, title: '还没有云端对话',
        source: [
          '@Component',
          'struct R2 {',
          '  build() {',
          "    Text('还没有云端对话')",
          "    ActionButton({ label: '刷新', actionEnabled: true })",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'R3', shape: 'text-literal', line: 6, title: '还没有 dots 对话',
        source: [
          '// 这个文件除 @Builder 外没有按钮；按钮藏在 builder 里也要被抓到',
          '@Component',
          'struct R3 {',
          '  @Builder',
          '  EmptyChats() {',
          "    Text('还没有 dots 对话')",
          "    Button('刷新')",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'R4', shape: 'text-const', line: 5, title: '还没有 dots 对话',
        source: [
          "const T: string = '还没有 dots 对话';",
          '@Component',
          'struct R4 {',
          '  build() {',
          '    Text(T)',
          "    ActionButton({ label: '刷新' })",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'R5', shape: 'text-template', line: 4, title: '还没有 ',
        source: [
          '@Component',
          'struct R5 {',
          '  build() {',
          '    Text(`还没有 ${this.kind} 对话`)',
          "    Button('刷新')",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'R6', shape: 'text-literal', line: 4, title: '还没有 dots 对话',
        source: [
          '@Component',
          'struct R6 {',
          '  build() {',
          "    Text('还没有 dots 对话')",
          "    actionLabel: '刷新'",
          '  }',
          '}'
        ].join('\n')
      }
    ];
    for (const fixture of fixtures) {
      const hits = findEmptyStateBypass(fixture.source, fixture.id);
      assert.equal(hits.length, 1, `${fixture.id} 必须恰好命中一条旁路，实测 ${JSON.stringify(hits)}`);
      assert.equal(hits[0].file, fixture.id, `${fixture.id} 必须回传 fixture id`);
      assert.equal(hits[0].shape, fixture.shape, `${fixture.id} 的形状必须是 ${fixture.shape}，实测 ${hits[0].shape}`);
      assert.equal(hits[0].line, fixture.line, `${fixture.id} 必须报在标题那一行 ${fixture.line}，实测 ${hits[0].line}`);
      assert.equal(hits[0].title, fixture.title, `${fixture.id} 的 title 必须是「${fixture.title}」，实测「${hits[0].title}」`);
    }
  });

  test('ED-07 三条负控：不是见标题就禁，弱提示 / 筛选族 / 传给 EmptyState 的 prop 都要绿', () => {
    const controls = [
      {
        id: 'N1',
        source: [
          '@Component',
          'struct N1 {',
          '  build() {',
          "    EmptyState({ title: '还没有 dots 对话', detail: '一句事实', showAction: false })",
          "    ActionButton({ label: '别处的按钮' })",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'N2',
        source: [
          '@Component',
          'struct N2 {',
          '  build() {',
          "    Text('今天还没有日程')",
          "    ActionButton({ label: '刷新' })",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'N3',
        source: [
          '@Component',
          'struct N3 {',
          '  build() {',
          "    Text('没有匹配的会话')",
          "    ActionButton({ label: '清空搜索' })",
          '  }',
          '}'
        ].join('\n')
      }
    ];
    for (const control of controls) {
      assert.deepEqual(findEmptyStateBypass(control.source, control.id), [],
        `${control.id} 必须保持绿：它不是「渲染的空态标题 + 按钮」旁路`);
    }
  });

  test('ED-08 规则 2 在真实树非空洞：逐点访问 pages/** 的每个 EmptyState(…)（添加实例 / 去设置 / 生成汇总 / 全选 / 返回 / showAction:false 都要被判过）且零违规', () => {
    const files = listFiles(join(ETS_ROOT, 'main', 'ets', 'pages'), ['.ets']);
    assert.ok(files.length > 10, '扫描集合必须是非空集合，不能 vacuous pass');

    const records = [];
    let rawSites = 0;
    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      const code = stripComments(raw);
      rawSites += (code.match(/\bEmptyState\s*\(\s*\{/g) || []).length;
      records.push(...scanEmptyStateActions(code, relToEts(file)));
    }
    const summary = records.map((r) => `${r.file}:${r.line} [${r.shape}]「${r.label}」${r.verdict}${r.message ? `（${r.message}）` : ''}`).join('\n');
    // 独立计数 vs 探测器访问数相等，证明没有任何调用点被跳过（而不是只扫到前十个）。
    assert.equal(records.length, rawSites,
      `探测器必须访问 pages/** 下每一个 EmptyState(…) 调用点；源码 ${rawSites} 个，实测访问 ${records.length} 个：\n${summary}`);
    assert.ok(records.length >= 10,
      `规则 2 的枚举不能退化：今天应至少 10 个调用点，实测 ${records.length} 个：\n${summary}`);

    // 每条真实出路都确实被解析并判过；失败信息把全部判定摊开，读者能逐条核对。
    for (const needle of ['添加实例', '去设置', '生成汇总', '全选', '返回', 'showAction:false']) {
      assert.ok(summary.includes(needle),
        `枚举必须实际判过「${needle}」，实测 ${records.length} 个调用点的判定为：\n${summary}`);
    }
    const violations = records.filter((r) => r.verdict === 'violation');
    assert.deepEqual(violations, [],
      `真实树的 EmptyState 动作形状必须全部合规（showAction:false 或可解析的非同步文案）；实测违规：\n${violations.map((v) => `${v.file}:${v.line} [${v.shape}]「${v.label}」${v.message}`).join('\n')}\n全部判定：\n${summary}`);
  });

  test('ED-09 规则 2 红 / 绿探针：同一探测器判 R7/R8/N6 红、N4/N5 绿', () => {
    const fixtures = [
      {
        id: 'R7', expected: 'violation', shape: 'no-action',
        source: [
          '@Component',
          'struct R7 {',
          '  build() {',
          "    EmptyState({ title: '还没有 X', detail: '一句事实' })",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'R8', expected: 'violation', shape: 'action-literal',
        source: [
          '@Component',
          'struct R8 {',
          '  build() {',
          "    EmptyState({ title: '还没有 X', detail: '一句事实', actionLabel: '刷新', onAction: (): void => { this.refresh(); } })",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'N4', expected: 'pass', shape: 'action-const',
        source: [
          "const EMPTY_ACTION: string = '添加实例';",
          '@Component',
          'struct N4 {',
          '  build() {',
          "    EmptyState({ title: '还没有可管理的 DSH 实例', detail: '一句事实', actionLabel: EMPTY_ACTION, onAction: (): void => { this.showAdd(); } })",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'N5', expected: 'pass', shape: 'action-literal',
        source: [
          '@Component',
          'struct N5 {',
          '  build() {',
          "    EmptyState({ title: '还没有 X', detail: '一句事实', actionLabel: '清空', onAction: (): void => { this.clearAll(); } })",
          '  }',
          '}'
        ].join('\n')
      },
      {
        id: 'N6', expected: 'violation', shape: 'unresolvable',
        source: [
          '@Component',
          'struct N6 {',
          '  build() {',
          "    EmptyState({ title: '还没有 X', detail: '一句事实', actionLabel: someUnknownVar, onAction: (): void => { this.doSomething(); } })",
          '  }',
          '}'
        ].join('\n')
      }
    ];

    for (const fixture of fixtures) {
      const records = scanEmptyStateActions(fixture.source, fixture.id);
      assert.equal(records.length, 1, `${fixture.id} 必须恰好访问一个 EmptyState 调用点，实测 ${JSON.stringify(records)}`);
      const record = records[0];
      assert.equal(record.file, fixture.id, `${fixture.id} 必须回传 fixture id`);
      assert.equal(record.shape, fixture.shape, `${fixture.id} 的形状必须是 ${fixture.shape}，实测 ${record.shape}`);
      assert.equal(record.verdict, fixture.expected,
        `${fixture.id} 期望 ${fixture.expected}，实测 ${record.verdict}（${record.message}）`);
      assert.equal(findEmptyStateActionViolations(fixture.source, fixture.id).length,
        fixture.expected === 'violation' ? 1 : 0,
        `${fixture.id} 必须通过同一个违规集合函数得到 ${fixture.expected} 的结论`);
    }

    // 判词逐字钉住：静默回落要点名「刷新」，同步形状要点名文案，无法解析用固定文案。
    const byId = Object.fromEntries(fixtures.map((fixture) => {
      const record = scanEmptyStateActions(fixture.source, fixture.id)[0];
      return [fixture.id, record];
    }));
    assert.equal(byId.R7.message, FALLBACK_ACTION_MESSAGE, 'R7 必须点名静默回落到 FALLBACK_ACTION_LABEL「刷新」');
    assert.ok(byId.R7.message.includes('刷新'), 'R7 判词必须含「刷新」');
    assert.ok(byId.R8.message.includes('刷新') && byId.R8.message.includes('同步形状'),
      `R8 判词必须点名同步形状的 actionLabel「刷新」，实测：${byId.R8.message}`);
    assert.equal(byId.N4.label, '添加实例', 'N4 必须解析到本文件常量「添加实例」并保持绿');
    assert.equal(byId.N5.label, '清空', 'N5 必须解析到字面量「清空」并保持绿');
    assert.equal(byId.N6.message, UNRESOLVABLE_ACTION_MESSAGE, 'N6 必须用固定的「无法解析」判词');
  });
});
