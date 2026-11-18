/**
 * `device-accept.mjs` 的纯逻辑单测（**不依赖真机**）。
 *
 * 为什么这些逻辑必须单测：退出码分级 / 末行汇总 / 工具条行分组 / pen 对照组顺序都是纯函数，
 * 但只有在真机上才会「跑」到 —— 一旦改坏，要等插上手机、装完包、点进手写板才发现，
 * 而且旧缺陷（5 SKIP + 1 PASS 也 exit 0）恰恰是「看起来通过了」的那种坏。
 *
 * 覆盖（D 批四项缺陷）：
 *   a) 分级矩阵：全 PASS→0；PASS+SKIP→3；有 FAIL→1（即使有 SKIP）；空→2；设备未连→2；
 *   b) 汇总行逐字断言（含 5 SKIP + 1 PASS→3 的回归：旧实现 exit 0）；
 *   c) 行分组：y 容差 / 只有一行时显式 row2=[] / 乱序输入也稳定；
 *   d) pen 对照组顺序：penOnly=off 的手指绘制步骤必须排在 penOnly=on 之前（断言顺序，不是断言文本）；
 *   e) import 本模块无副作用（不跑 main、不碰 hdc、不写 .tmp）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXIT_FAIL,
  EXIT_NO_DEVICE,
  EXIT_PASS,
  EXIT_SKIP,
  ROW_TOL,
  canInjectPen,
  formatToolbarRows,
  gradeExit,
  groupByRows,
  inkEvidence,
  isDirectRun,
  listTargets,
  penControlOrder,
  penControlVerdict,
  penCoverageNote,
  penStepRegistrations,
  pickSerial,
  summaryLine,
  toolbarItems,
  toolbarRowsVerdict
} from '../device-accept.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, '..', 'device-accept.mjs');
const TOOL_URL = pathToFileURL(TOOL).href;
const REPO = resolve(HERE, '..', '..', '..', '..');
const TMP = join(REPO, '.tmp', 'device-accept');

// 三种结果的构造器（与 device-accept.mjs 里 pass/fail/skipped 写出的形状一致）
const pass = (step) => ({ step, ok: true, detail: '' });
const fail = (step) => ({ step, ok: false, detail: '' });
const skip = (step) => ({ step, ok: false, skipped: true, detail: '' });

describe('a) 退出码分级 gradeExit', () => {
  it('全 PASS → 0', () => {
    assert.equal(gradeExit([pass('设备连接'), pass('启动')]), EXIT_PASS);
    assert.equal(EXIT_PASS, 0);
  });

  it('PASS + SKIP → 3（未覆盖 ≠ 通过）', () => {
    assert.equal(gradeExit([pass('启动'), skip('下拉刷新')]), EXIT_SKIP);
    assert.equal(EXIT_SKIP, 3);
  });

  it('有 FAIL → 1（即使同时有 SKIP 和 PASS）', () => {
    assert.equal(gradeExit([pass('启动'), skip('下拉刷新'), fail('完成反馈')]), EXIT_FAIL);
    assert.equal(EXIT_FAIL, 1);
  });

  it('空 results → 2：零步骤 = 零证据，绝不能报 0（0 是下游放行信号）', () => {
    // 定 2 而不是 0：空结果说明一步都没跑，跟「设备没连」一样属于「无法判定」；
    // 下游对 2 的动作是「换环境重跑」，对 0 的动作是「放行」，两者绝不能混。
    assert.equal(gradeExit([]), EXIT_NO_DEVICE);
    assert.equal(EXIT_NO_DEVICE, 2);
  });

  it('设备未连（deviceMissing）→ 2，且不因 skip/ok 的其他取值漂移', () => {
    const results = [{ step: '设备连接', ok: false, deviceMissing: true, detail: '设备未连接' }];
    assert.equal(gradeExit(results), EXIT_NO_DEVICE);
    // 即使同一批里混了 PASS，设备没连仍然是 2（这条规则优先级最高）
    assert.equal(gradeExit([...results, pass('启动')]), EXIT_NO_DEVICE);
  });

  it('非法输入不抛（当空处理 → 2）', () => {
    assert.equal(gradeExit(undefined), EXIT_NO_DEVICE);
    assert.equal(gradeExit(null), EXIT_NO_DEVICE);
    assert.equal(gradeExit('nope'), EXIT_NO_DEVICE);
  });
});

describe('b) 末行汇总 summaryLine（逐字）', () => {
  it('规格里的那一行（3 PASS + 5 SKIP → exit 3）逐字相等', () => {
    const results = [
      pass('设备连接'),
      pass('启动'),
      pass('完成'),
      skip('下拉刷新'),
      skip('全部未完成·索引'),
      skip('正文占位符'),
      skip('详情页附件'),
      skip('启动自动 pull')
    ];
    assert.equal(
      summaryLine(results),
      '[accept] pass=3 fail=0 skip=5 total=8 → exit 3（未覆盖：下拉刷新, 全部未完成·索引, 正文占位符, 详情页附件, 启动自动 pull）'
    );
  });

  it('回归：5 SKIP + 1 PASS 必须是 exit 3（旧实现这里 exit 0）', () => {
    const results = [
      pass('设备连接'),
      skip('下拉刷新'),
      skip('全部未完成·索引'),
      skip('正文占位符'),
      skip('详情页附件'),
      skip('启动自动 pull')
    ];
    const line = summaryLine(results);
    assert.equal(gradeExit(results), EXIT_SKIP, '旧实现把 skipped 记成 ok:true，于是这里返回 0');
    assert.equal(
      line,
      '[accept] pass=1 fail=0 skip=5 total=6 → exit 3（未覆盖：下拉刷新, 全部未完成·索引, 正文占位符, 详情页附件, 启动自动 pull）'
    );
  });

  it('没有 SKIP 时省略括号部分', () => {
    assert.equal(summaryLine([pass('设备连接'), pass('启动')]), '[accept] pass=2 fail=0 skip=0 total=2 → exit 0');
  });

  it('有 FAIL 时 exit 1，且 SKIP 仍列进「未覆盖」', () => {
    assert.equal(
      summaryLine([pass('启动'), fail('完成反馈'), skip('下拉刷新')]),
      '[accept] pass=1 fail=1 skip=1 total=3 → exit 1（未覆盖：下拉刷新）'
    );
  });

  it('无设备（空 results）也打一行汇总：total=0 → exit 2', () => {
    assert.equal(summaryLine([]), '[accept] pass=0 fail=0 skip=0 total=0 → exit 2');
  });

  it('设备未连条目不计入 fail（无法判定 ≠ 验出缺陷）', () => {
    assert.equal(
      summaryLine([{ step: '设备连接', ok: false, deviceMissing: true }]),
      '[accept] pass=0 fail=0 skip=0 total=1 → exit 2'
    );
  });

  it('未覆盖按 results 出现顺序，不排序', () => {
    assert.equal(
      summaryLine([skip('乙'), skip('甲')]),
      '[accept] pass=0 fail=0 skip=2 total=2 → exit 3（未覆盖：乙, 甲）'
    );
  });
});

describe('c) 工具条行分组 groupByRows / formatToolbarRows', () => {
  const at = (name, y) => ({ name, y });

  it('y=[100,102,104,300,301] → row1 3 个 / row2 2 个', () => {
    const rows = groupByRows([at('a', 100), at('b', 102), at('c', 104), at('d', 300), at('e', 301)]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].map((it) => it.name), ['a', 'b', 'c']);
    assert.deepEqual(rows[1].map((it) => it.name), ['d', 'e']);
  });

  it('阈值边界：|Δy| == tol 算同一行，> tol 另起一行', () => {
    assert.equal(groupByRows([at('a', 100), at('b', 100 + ROW_TOL)]).length, 1);
    assert.equal(groupByRows([at('a', 100), at('b', 100 + ROW_TOL + 1)]).length, 2);
  });

  it('全同 y → 只有一行，formatToolbarRows 仍显式打印 row2=[]', () => {
    const items = [at('笔迹', 210), at('插入', 210), at('橡皮', 210)];
    const rows = groupByRows(items);
    assert.equal(rows.length, 1);
    const lines = formatToolbarRows(items);
    assert.deepEqual(lines, [
      '笔迹 y=210',
      '插入 y=210',
      '橡皮 y=210',
      'row1=[笔迹, 插入, 橡皮] row2=[]'
    ]);
  });

  it('两行时 row1 / row2 都带出来（行内按 y 升序）', () => {
    const items = [at('完成', 300), at('笔迹', 102), at('插入', 100), at('橡皮', 104)];
    assert.deepEqual(formatToolbarRows(items), [
      '完成 y=300',
      '笔迹 y=102',
      '插入 y=100',
      '橡皮 y=104',
      'row1=[插入, 笔迹, 橡皮] row2=[完成]'
    ]);
  });

  it('乱序输入也稳定（按 y 排序，与输入顺序无关）', () => {
    const ordered = [at('a', 100), at('b', 102), at('c', 104), at('d', 300), at('e', 301)];
    const shuffled = [at('e', 301), at('c', 104), at('a', 100), at('d', 300), at('b', 102)];
    assert.deepEqual(groupByRows(shuffled), groupByRows(ordered));
    assert.deepEqual(
      groupByRows(shuffled).map((row) => row.map((it) => it.name)),
      [['a', 'b', 'c'], ['d', 'e']]
    );
  });

  it('y 相同按 name 排（同样输入顺序无关）', () => {
    const forward = groupByRows([at('乙', 200), at('甲', 200)]).map((row) => row.map((it) => it.name));
    const backward = groupByRows([at('甲', 200), at('乙', 200)]).map((row) => row.map((it) => it.name));
    // 不锁死具体字典序（ICU 对中文的排序随 locale 变），只锁「两种输入顺序结果一致」
    assert.deepEqual(forward, backward);
    assert.deepEqual([...forward[0]].sort(), ['乙', '甲'].sort());
  });

  it('空输入不抛：row1=[] row2=[]', () => {
    assert.deepEqual(formatToolbarRows([]), ['row1=[] row2=[]']);
    assert.deepEqual(groupByRows(undefined), []);
  });

  it('toolbarItems：按 text 找控件、y 取 bounds 中心、缺的跳过', () => {
    const flat = [
      { text: '笔迹', id: '', bounds: [10, 100, 90, 140] },
      { text: '插入', id: '', bounds: [200, 104, 280, 144] },
      { text: '橡皮', id: '', bounds: [100, 98, 180, 138] },
      { text: '正文', id: '', bounds: [10, 600, 400, 700] }
    ];
    assert.deepEqual(toolbarItems(flat), [
      { name: '笔迹', y: 120 },
      { name: '橡皮', y: 118 },
      { name: '插入', y: 124 }
    ]);
    // 端到端：从布局到分组行（三控件 y 差 ≤ 24 → 一行）
    assert.deepEqual(formatToolbarRows(toolbarItems(flat)), [
      '笔迹 y=120',
      '橡皮 y=118',
      '插入 y=124',
      'row1=[橡皮, 笔迹, 插入] row2=[]'
    ]);
  });
});

describe('c2) 工具条两行判定 toolbarRowsVerdict（A1：1 行 / 3 行不许再记 PASS）', () => {
  // 造 n 行：每行一个控件（y 间隔远大于 ROW_TOL）
  const rowsOf = (n) => Array.from({ length: n }, (_, i) => [{ name: `c${i}`, y: i * 100 }]);

  it('2 行 → 通过（缺陷 4 要的布局）', () => {
    assert.deepEqual(toolbarRowsVerdict(rowsOf(2)), { ok: true, reason: '' });
  });

  it('1 行 → 不通过：两行叠成一行 = 缺陷 4 复现，不是通过', () => {
    const verdict = toolbarRowsVerdict(rowsOf(1));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /只渲染 1 行/);
    assert.match(verdict.reason, /缺陷 4/);
  });

  it('3 行 → 不通过，且 reason 点名行数', () => {
    const verdict = toolbarRowsVerdict(rowsOf(3));
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /第 3 行/);
    assert.match(verdict.reason, /行数=3/);
  });

  it('0 行 → 不通过：一个控件都没找到（不是「未覆盖」）', () => {
    const verdict = toolbarRowsVerdict([]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /一个都没找到/);
    // 非数组也按 0 行处理，不抛
    assert.equal(toolbarRowsVerdict(undefined).ok, false);
  });

  it('四条 reason 两两不同（日志里能分清是哪种坏法）', () => {
    const reasons = [rowsOf(1), rowsOf(3), []].map((rows) => toolbarRowsVerdict(rows).reason);
    reasons.push(toolbarRowsVerdict(rowsOf(2)).reason);
    assert.equal(new Set(reasons).size, 4, `reason 有重复：${JSON.stringify(reasons)}`);
    for (const reason of reasons.slice(0, 3)) {
      assert.ok(reason.length > 0, '不通过时 reason 不能为空');
    }
  });
});

describe('d) pen 对照组顺序 penControlOrder', () => {
  it('penOnly=off 的手指绘制必须排在 penOnly=on 之前（顺序断言）', () => {
    const order = penControlOrder();
    const offFinger = order.findIndex((s) => s.penOnly === false && s.pointer === 'finger');
    const onFinger = order.findIndex((s) => s.penOnly === true && s.pointer === 'finger');
    assert.ok(offFinger >= 0, '缺少 penOnly=off 的手指对照组');
    assert.ok(onFinger >= 0, '缺少 penOnly=on 的手指过滤步骤');
    assert.ok(
      offFinger < onFinger,
      `对照组必须在前：off-finger 在 ${offFinger}，on-finger 在 ${onFinger}`
    );
    assert.equal(order[0].penOnly, false, '第一步就必须是对照组，否则后面的「没画」不成立');
  });

  it('三步齐全且 id 唯一：off 手指 / on 手指 / on 笔', () => {
    const order = penControlOrder();
    assert.equal(order.length, 3);
    assert.equal(new Set(order.map((s) => s.id)).size, 3);
    assert.deepEqual(
      order.map((s) => [s.penOnly, s.pointer, s.expectDraw]),
      [
        [false, 'finger', true],
        [true, 'finger', false],
        [true, 'pen', true]
      ]
    );
  });

  it('penControlVerdict：落笔与否按每步预期判', () => {
    const [offFinger, onFinger, onPen] = penControlOrder();
    assert.equal(penControlVerdict(offFinger, true), true);
    assert.equal(penControlVerdict(offFinger, false), false, '关闭时手指画不上 = 对照组失败');
    assert.equal(penControlVerdict(onFinger, false), true);
    assert.equal(penControlVerdict(onFinger, true), false, '开启后手指还能画 = 过滤失效');
    assert.equal(penControlVerdict(onPen, true), true);
    assert.equal(penControlVerdict(undefined, true), false);
  });

  it('inkEvidence：落笔证据只认 hilog 的两个信号，拒绝提示不算落笔', () => {
    assert.equal(inkEvidence('[hw] history undo=1 redo=0').drew, true);
    assert.equal(inkEvidence('[hw] draft saved key=hw-draft pages=1 bytes=2048').drew, true);
    assert.equal(inkEvidence('[hw] draft saved key=x pages=1 bytes=0').drew, false);
    assert.equal(
      inkEvidence('[hw] penOnly=1 source=panel\n已连续忽略 3 次手指输入：当前开启了「仅手写笔输入」').drew,
      false
    );
    assert.equal(inkEvidence('').drew, false);
    assert.equal(inkEvidence(undefined).drew, false);
  });
});

describe('f) 笔注入不了 → 该步骤不登记（A2：exit 0 可达）', () => {
  const PEN_LABEL = penControlOrder().find((step) => step.pointer === 'pen').label;

  it('canInjectPen() 为 false：uitest uiInput 只有手指，注不了 SourceTool.Pen', () => {
    assert.equal(canInjectPen(), false);
  });

  it('penStepRegistrations(false)：只登记两个手指步骤，笔步骤不占位', () => {
    const list = penStepRegistrations(false);
    assert.deepEqual(
      list.map((step) => step.id),
      ['off-finger-draws', 'on-finger-blocked'],
      '顺序即契约：对照组必须在过滤组之前，且笔步骤不该出现'
    );
    assert.equal(
      list.some((step) => step.label === PEN_LABEL),
      false,
      '注入不了笔时该步骤根本不登记（不占 total、不进 SKIP 列表）'
    );
  });

  it('penStepRegistrations(true)：三步齐全（哪天 uitest 支持笔，自动恢复该步骤）', () => {
    assert.deepEqual(
      penStepRegistrations(true).map((step) => step.id),
      penControlOrder().map((step) => step.id)
    );
  });

  it('penCoverageNote：注入不了才有一行 [accept] note=，并点名未覆盖的那一步', () => {
    assert.equal(penCoverageNote(true), '');
    const note = penCoverageNote(false);
    assert.match(note, /^\[accept\] note=/);
    assert.match(note, /未覆盖/);
    assert.ok(note.includes(PEN_LABEL), `note 应点名「${PEN_LABEL}」，实际：${note}`);
  });

  it('「除笔注入外全 PASS」→ exit 0，且汇总行没有「未覆盖」括号', () => {
    const steps = [
      '设备连接',
      '安装',
      '启动',
      '启动无崩溃',
      '布局·竖屏单列',
      '布局·竖屏无右栏',
      '手写板工具条',
      '工具条两行',
      '插入菜单',
      '插入页',
      '完成',
      '完成反馈',
      '正文占位符',
      '附件 zip 存在',
      '仓库无散图',
      '详情页附件',
      '启动自动 pull',
      '下拉刷新',
      '全部未完成·索引'
    ];
    const results = steps.map((step) => pass(step));
    assert.equal(gradeExit(results), EXIT_PASS);
    const line = summaryLine(results);
    assert.equal(line.includes('未覆盖'), false, `不该再有「未覆盖」括号：${line}`);
    assert.equal(line.includes(PEN_LABEL), false, `笔步骤不该占 total：${line}`);
    assert.equal(
      line,
      `[accept] pass=${steps.length} fail=0 skip=0 total=${steps.length} → exit 0`
    );
  });

  it('反例（旧行为）：笔步骤若被记 SKIP 就恒为 3 —— 所以要结构性不登记，而不是指望偶然', () => {
    const results = [pass('设备连接'), skip(PEN_LABEL)];
    assert.equal(gradeExit(results), EXIT_SKIP);
    assert.equal(
      summaryLine(results),
      `[accept] pass=1 fail=0 skip=1 total=2 → exit 3（未覆盖：${PEN_LABEL}）`
    );
  });

  it('结构性：没有任何无条件的 skipped(…笔…)，登记与 SKIP 都被 penStep 判定包住', () => {
    const source = readFileSync(TOOL, 'utf8');
    // 旧的无条件 SKIP 行（exit 0 不可达的根因）必须消失
    assert.equal(source.includes('skipped(onPen.label'), false, '仍有无条件的 skipped(onPen.label, …)');
    // 三个 SKIP 点都在 `if (penStep !== undefined) {` 里
    assert.equal((source.match(/if \(penStep !== undefined\) \{/g) ?? []).length, 3);
    assert.equal((source.match(/skipped\(penStep\.label/g) ?? []).length, 3);
    // 登记入口必须走 canInjectPen → penStepRegistrations
    assert.match(source, /penStepRegistrations\(canInjectPen\(\)\)/);
    // 末尾的 note 也由同一开关决定
    assert.match(source, /penCoverageNote\(canInjectPen\(\)\)/);
  });
});

describe('e) import 本模块无副作用', () => {
  it('静态结构：CLI 入口由 isDirectRun 守卫，没有顶层 main() 调用', () => {
    const source = readFileSync(TOOL, 'utf8');
    assert.ok(
      /if \(isDirectRun\(process\.argv\[1\], import\.meta\.url\)\) \{/.test(source),
      'CLI 入口必须是 `if (isDirectRun(process.argv[1], import.meta.url))`'
    );
    // 顶层（顶格）的 `main();` 才会在 import 时执行；守卫块里的那行是缩进的
    assert.equal(/^main\(\);/m.test(source), false, '不允许顶格的 `main();`（import 会跑起来）');
    assert.equal(
      (source.match(/main\(\);/g) ?? []).length,
      1,
      '`main();` 只应出现在 isDirectRun 守卫里一次'
    );
  });

  it('isDirectRun：自己是 true，别的文件/空参数是 false', () => {
    assert.equal(isDirectRun(TOOL, TOOL_URL), true);
    assert.equal(isDirectRun(resolve(HERE, 'other.mjs'), TOOL_URL), false);
    assert.equal(isDirectRun(undefined, TOOL_URL), false);
    assert.equal(isDirectRun('', TOOL_URL), false);
  });

  it('子进程 import：退出码 0，不打印「真机验收」/汇总行，也不建 .tmp/device-accept', () => {
    const script = [
      "import fs from 'node:fs';",
      `const before = fs.existsSync(${JSON.stringify(TMP)});`,
      `const mod = await import(${JSON.stringify(TOOL_URL)});`,
      `const after = fs.existsSync(${JSON.stringify(TMP)});`,
      'console.log(JSON.stringify({',
      '  before,',
      '  after,',
      '  gradeExit: typeof mod.gradeExit,',
      '  summaryLine: typeof mod.summaryLine,',
      '  penControlOrder: typeof mod.penControlOrder,',
      '  groupByRows: typeof mod.groupByRows',
      '}));'
    ].join('\n');
    const done = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 60000
    });
    assert.equal(done.status, 0, `子进程 exit=${done.status}；stderr=${done.stderr ?? ''}`);
    const stdout = done.stdout ?? '';
    // main() 第一行就会打印「真机验收：serial=…」，收尾会打印 `[accept] …` —— 两者都不该出现
    assert.equal(stdout.includes('真机验收'), false, 'import 触发了 main()（打了「真机验收」）');
    assert.equal(stdout.includes('[accept]'), false, 'import 触发了 main()（打了汇总行）');
    const lines = stdout.trim().split(/\r?\n/);
    const payload = JSON.parse(lines[lines.length - 1]);
    assert.equal(payload.gradeExit, 'function');
    assert.equal(payload.summaryLine, 'function');
    assert.equal(payload.penControlOrder, 'function');
    assert.equal(payload.groupByRows, 'function');
    // 不写文件：import 前后 .tmp/device-accept 的存在性不变
    assert.equal(payload.after, payload.before, 'import 期间创建/改动了 .tmp/device-accept');
  });
});

describe('设备探测纯逻辑（无设备也能验证 exit 2 的判定）', () => {
  it('listTargets：丢掉空行与 [Empty] 这类占位行', () => {
    assert.deepEqual(listTargets(''), []);
    assert.deepEqual(listTargets('[Empty]'), []);
    assert.deepEqual(listTargets('[Empty]\r\n\r\n'), []);
    assert.deepEqual(listTargets('6MFBB25C27205131\r\n\r\n'), ['6MFBB25C27205131']);
  });

  it('pickSerial：列表为空 / 找不到指定 SERIAL → null（调用方据此退出 2）', () => {
    assert.equal(pickSerial('[Empty]', '6MFBB25C27205131'), null);
    assert.equal(pickSerial('', '6MFBB25C27205131'), null);
    assert.equal(pickSerial('AAA\tUSB\nBBB', 'CCC'), null);
    assert.equal(pickSerial('AAA\nBBB', 'BBB'), 'BBB');
    assert.equal(pickSerial('AAA\nBBB', ''), 'AAA', '没指定 serial 时取第一个在线设备');
  });
});
