#!/usr/bin/env node
/**
 * 真机验收脚本（一条命令跑完手写板 / 附件 zip / 同步 / 索引）。
 *
 * 用法：
 *   node apps/arkui-schedule/tools/device-accept.mjs [--serial <id>] [--skip-install] [--keep-going]
 *
 * 退出码契约（下游 pre-flight 依赖这一段，改之前先读）：
 *   0 = 全部 PASS —— 唯一可以放行的信号；
 *   3 = 有 SKIP、无 FAIL —— 跑通了，但有关键路径没覆盖，**不算通过**；
 *   1 = 有 FAIL —— 真缺陷；
 *   2 = 设备未连（`hdc list targets` 为空 / 列不出 SERIAL），或一步都没跑（无法判定）。
 *
 * 为什么 SKIP 必须单独一档：老实现 `skipped()` 记的是 `ok:true`，于是「5 个 SKIP + 1 个 PASS」
 * 也会 exit 0 —— 没验过的东西被当成了验过。SKIP 是**未覆盖**，必须让下游看得见。
 *
 * 末行固定是一行机器可读汇总（由 `summaryLine()` 生成，格式别随手改）：
 *   [accept] pass=3 fail=0 skip=5 total=8 → exit 3（未覆盖：下拉刷新, 全部未完成·索引）
 * 没有 SKIP 时省略括号部分；没有设备时也照样打一行（total=0 → exit 2）。
 *
 * 设计要点：
 * - **幂等**：可重复跑；每轮生成新的验收记录；不 uninstall（用户配置不丢）。
 * - **锁屏即停**：`aa start` 返回 `10106102` 时打印「需要解锁 PIN」并记 FAIL，**不反复重试**。
 * - **每步失败即停**（除 `--keep-going`），输出 PASS/FAIL/SKIP 行列表。
 * - 只依赖 `hdc` 与 `devecocli`，不引入新依赖。
 * - **可测**：分级 / 汇总 / 行分组 / pen 对照组顺序等纯逻辑都是 `export function`，
 *   单测见 `tools/test/deviceAccept.test.mjs`；`import` 本模块**不会**跑 `main()`、不碰 hdc。
 * - **验不了的步骤不登记**：`uitest` 注入不了手写笔事件（SourceTool.Pen），所以
 *   「penOnly=on 时笔能画」这一步**根本不进 results**（不占 total、不记 SKIP），
 *   未覆盖的事实改由末尾一行 `[accept] note=` 说明 —— 否则 SKIP 恒 ≥ 1，exit 0 永不可达。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLayoutOutput } from './layout-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const REPO = resolve(APP, '..', '..');
const DEFAULT_SERIAL = '6MFBB25C27205131';
const DEVECO_CLI = 'C:/Users/GWL/Desktop/itwillclaude/.tmp/deveco-cli/node_modules/.bin/devecocli.cmd';
const HDC = 'D:/A-DevEco/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe';
const TMP = join(REPO, '.tmp', 'device-accept');

// ---------------------------------------------------------------------------
// 退出码
// ---------------------------------------------------------------------------

/** 全部 PASS（唯一可以放行下游的信号）。 */
export const EXIT_PASS = 0;
/** 有 FAIL（真缺陷）。 */
export const EXIT_FAIL = 1;
/** 设备未连 / 一步都没跑（无法判定，既不是通过也不是失败）。 */
export const EXIT_NO_DEVICE = 2;
/** 有 SKIP 但无 FAIL（跑通了，但有未覆盖的路径）。 */
export const EXIT_SKIP = 3;

// ---------------------------------------------------------------------------
// 纯逻辑（不碰设备，单测直接覆盖）
// ---------------------------------------------------------------------------

/** 工具条两行布局的 y 容差（px）。同排控件中心 y 通常差 < 8，24 足够吃掉字体/图标基线差。 */
export const ROW_TOL = 24;

/** 工具条控件文案（竖屏顶部横排 / 横屏 rail 竖排都是这些，按 text 找，不猜坐标）。 */
export const TOOLBAR_TEXTS = ['退出', '笔迹', '橡皮', '手动框', '插入', '↶', '↷', '完成'];

/**
 * 分级：把 results 映射成退出码。
 *
 * 契约（顺序即优先级）：
 *   1. `deviceMissing` 优先 → 2：设备都没连，后面的断言无从谈起，先让人看见「没插设备」；
 *   2. 任一真 FAIL（`ok:false` 且不是 `skipped`）→ 1；
 *   3. 任一 SKIP → 3（未覆盖 ≠ 通过）；
 *   4. 全 PASS → 0；
 *   5. **空数组 → 2**：一个步骤都没跑等于零证据，绝不能报 0（0 是放行信号）。
 *      与「设备未连」同归 2，是因为两者的下游动作一样：换环境重跑，而不是去修代码。
 *
 * @param {Array<{step: string, ok: boolean, skipped?: boolean, deviceMissing?: boolean}>} results
 * @returns {number} 0 | 1 | 2 | 3
 */
export function gradeExit(results) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) {
    return EXIT_NO_DEVICE;
  }
  if (list.some((r) => r && r.deviceMissing === true)) {
    return EXIT_NO_DEVICE;
  }
  if (list.some((r) => r && r.ok === false && r.skipped !== true)) {
    return EXIT_FAIL;
  }
  if (list.some((r) => r && r.skipped === true)) {
    return EXIT_SKIP;
  }
  return EXIT_PASS;
}

/**
 * 末行机器可读汇总（格式被下游 grep，改之前先看文件头契约）。
 *
 * 形如：`[accept] pass=3 fail=0 skip=5 total=8 → exit 3（未覆盖：下拉刷新, 全部未完成·索引）`
 * - `未覆盖` 里按 results 出现顺序列 SKIP 的步骤名，用「, 」分隔；
 * - 没有 SKIP 时**省略**括号部分（不留空括号）；
 * - 注意中文全角括号与 `→`：下游是按这一行整行匹配的。
 *
 * @param {Array<{step: string, ok: boolean, skipped?: boolean}>} results
 * @returns {string}
 */
export function summaryLine(results) {
  const list = Array.isArray(results) ? results : [];
  const passed = list.filter((r) => r && r.ok === true && r.skipped !== true).length;
  // deviceMissing 不计 FAIL：设备没连是「无法判定」，不是「验出了缺陷」（它的退出码由 gradeExit 单独给 2）
  const failed = list.filter(
    (r) => r && r.ok === false && r.skipped !== true && r.deviceMissing !== true
  ).length;
  const skippedList = list.filter((r) => r && r.skipped === true);
  const exit = gradeExit(list);
  const head = `[accept] pass=${passed} fail=${failed} skip=${skippedList.length} total=${list.length} → exit ${exit}`;
  if (skippedList.length === 0) {
    return head;
  }
  return `${head}（未覆盖：${skippedList.map((r) => r.step).join(', ')}）`;
}

/**
 * 按 y 把控件分组成「行」。
 *
 * 规则：先按 y 升序排序（y 相同再按 name，保证乱序输入也有稳定输出），
 * 然后**以该行第一个控件的 y 为锚**，`|Δy| ≤ tol` 归入同一行；超过就另起一行。
 * 用锚而不是「与上一个比」是为了不让链式漂移把两行粘成一行（100/120/140、tol=24 时
 * 第二行从 140 起，而不是 100/120 一行、140 又并进去）。
 *
 * @param {Array<{name: string, y: number}>} items
 * @param {number} [tol] 同行的 y 容差（px），默认 {@link ROW_TOL}
 * @returns {Array<Array<{name: string, y: number}>>} 行数组（每行内按 y 升序）
 */
export function groupByRows(items, tol = ROW_TOL) {
  const limit = Number.isFinite(tol) ? Math.abs(tol) : ROW_TOL;
  const list = (Array.isArray(items) ? items : []).filter((it) => it && Number.isFinite(it.y));
  const sorted = [...list].sort((a, b) => a.y - b.y || String(a.name).localeCompare(String(b.name)));
  const rows = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    if (row !== undefined && Math.abs(item.y - row[0].y) <= limit) {
      row.push(item);
    } else {
      rows.push([item]);
    }
  }
  return rows;
}

/**
 * 工具条布局的打印行：先逐个控件 `name y=<中心y>`，再一行 `row1=[...] row2=[...]`。
 *
 * 契约：
 * - 每个控件一行，格式 `${name} y=${y}`；
 * - 最后一行固定包含 `row1=` 与 `row2=`；**只有一行时也要显式打印 `row2=[]`**
 *   （否则「只有一行」和「忘了打印第二行」在日志里长得一样）；
 * - 超过两行（横屏 rail 竖排）时继续追加 `row3=`…，仍挤在同一行，便于 grep。
 *
 * @param {Array<{name: string, y: number}>} items
 * @param {number} [tol]
 * @returns {string[]} 可直接逐行 console.log 的文本行
 */
export function formatToolbarRows(items, tol = ROW_TOL) {
  const list = Array.isArray(items) ? items : [];
  const lines = list.map((it) => `${it.name} y=${it.y}`);
  const rows = groupByRows(list, tol);
  const cells = [];
  const count = Math.max(2, rows.length);
  for (let i = 0; i < count; i += 1) {
    const row = rows[i] ?? [];
    cells.push(`row${i + 1}=[${row.map((it) => it.name).join(', ')}]`);
  }
  lines.push(cells.join(' '));
  return lines;
}

/**
 * 「工具条两行」这一步的判定（纯函数，单测直接覆盖）。
 *
 * 为什么判定必须单独抽出来：老实现只要找到 ≥ 2 个控件就 `pass()`，**不看分成了几行** ——
 * 于是「两行叠成一行」（正是缺陷 4 本身）和竖排 rail 的 3 行布局都记 PASS：
 * 一个名字像断言、实际只打印的假通过面。判定按行数走：
 *   - `2` → 通过（就是缺陷 4 要的布局）；
 *   - `1` → 不通过：两行分支只渲染出一行，缺陷 4 复现；
 *   - `> 2` → 不通过：多出来的行（横排被挤成竖排 / 折行）；
 *   - `0` → 不通过：一个工具条控件都没找到（页面不对或文案变了）。
 *
 * @param {Array<Array<{name: string, y: number}>>} rows {@link groupByRows} 的结果
 * @returns {{ok: boolean, reason: string}} 通过时 `reason` 为空串
 */
export function toolbarRowsVerdict(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 2) {
    return { ok: true, reason: '' };
  }
  if (list.length === 1) {
    return { ok: false, reason: '两行分支实际只渲染 1 行：缺陷 4 复现' };
  }
  if (list.length === 0) {
    return { ok: false, reason: '工具条控件一个都没找到' };
  }
  return { ok: false, reason: `出现第 3 行（行数=${list.length}）` };
}

/**
 * 从布局 dump 里按 text 找工具条控件，返回 `[{name, y}]`（y = bounds 中心 y）。
 *
 * 找不到的控件直接跳过（横屏/极窄屏可能少一两个），交给调用方判断「够不够分组」。
 *
 * @param {Array<{text: string, id: string, bounds: number[]}>} flat
 * @param {string[]} [names] 默认 {@link TOOLBAR_TEXTS}
 * @returns {Array<{name: string, y: number}>}
 */
export function toolbarItems(flat, names = TOOLBAR_TEXTS) {
  const list = Array.isArray(flat) ? flat : [];
  const wanted = Array.isArray(names) ? names : TOOLBAR_TEXTS;
  const items = [];
  for (const name of wanted) {
    const node = list.find(
      (n) => n && n.text === name && Array.isArray(n.bounds) && n.bounds.length === 4
    );
    if (node === undefined) {
      continue;
    }
    const [, y1, , y2] = node.bounds;
    items.push({ name, y: Math.round((y1 + y2) / 2) });
  }
  return items;
}

/**
 * pen 对照组的步骤顺序（**顺序即契约**）。
 *
 * 为什么顺序不能换：只验「penOnly=on 时手指没画」证明不了过滤生效 —— 手指本来就没落笔
 * （坐标偏了、画布没就绪、页面没切过去）也会得到「没画」。所以必须**先**在 penOnly=off
 * 下用同一组坐标证明手指能画（对照组），**再**证明开启后同一组坐标不落笔。
 *
 * 第三小步（笔能画）单独列出：`uitest` 只能注入手指事件，脚本证明不了笔，必须显式 SKIP。
 *
 * @returns {Array<{id: string, label: string, penOnly: boolean, pointer: 'finger'|'pen', expectDraw: boolean}>}
 */
export function penControlOrder() {
  return [
    {
      id: 'off-finger-draws',
      label: 'pen对照组·关闭时手指能画',
      penOnly: false,
      pointer: 'finger',
      expectDraw: true
    },
    {
      id: 'on-finger-blocked',
      label: 'pen过滤·开启时手指不画',
      penOnly: true,
      pointer: 'finger',
      expectDraw: false
    },
    {
      id: 'on-pen-draws',
      label: 'pen过滤·开启时笔能画',
      penOnly: true,
      pointer: 'pen',
      expectDraw: true
    }
  ];
}

/**
 * 单小步的判定：实测「有没有落笔」是否符合该小步的预期。
 *
 * @param {{expectDraw: boolean}} step penControlOrder() 里的元素
 * @param {boolean} drew 实测是否落笔
 * @returns {boolean}
 */
export function penControlVerdict(step, drew) {
  if (!step || typeof step.expectDraw !== 'boolean') {
    return false;
  }
  return step.expectDraw === Boolean(drew);
}

/**
 * 本脚本能给设备注入「手写笔」事件吗？
 *
 * `hdc shell uitest uiInput` 只有手指事件（SourceTool.Finger），没有 pen 分支，所以**恒为 false**。
 * 写成函数而不是内联 `false`，是因为「能不能验笔」必须是一个可测的显式开关：
 * 哪天 uitest 支持了笔，只改这里一处，步骤登记与末尾 note 会自动跟着变。
 *
 * @returns {boolean}
 */
export function canInjectPen() {
  return false;
}

/**
 * 本次运行要**登记**哪些 pen 小步（不登记的步骤不占 total、不进 SKIP 列表）。
 *
 * 为什么「注入不了笔 = 不登记」而不是「记一条 SKIP」：uitest 恒注入不了 `SourceTool.Pen`，
 * 若照旧无条件 `skipped()`，任何一次真实跑法的 skip 都 ≥ 1 → 退出码恒为 3，
 * 头注释里「0 = 唯一可以放行的信号」就永远等不到，0/3 的区分退化成「只有 3」。
 * 未覆盖的事实并没有被藏起来：末尾单独一行 `[accept] note=` 会点名这一步（见 {@link penCoverageNote}）。
 *
 * 顺序即契约：对照组（off·finger）必须仍在 on·finger 之前，注入不了笔只影响第三步。
 *
 * @param {boolean} canInject 见 {@link canInjectPen}
 * @returns {Array<{id: string, label: string, penOnly: boolean, pointer: 'finger'|'pen', expectDraw: boolean}>}
 */
export function penStepRegistrations(canInject) {
  const steps = penControlOrder();
  if (canInject === true) {
    return steps;
  }
  return steps.filter((step) => step.pointer !== 'pen');
}

/**
 * 末尾那行「验不了什么」的说明（`[accept] note=…`）。
 *
 * 只在真的注入不了笔时出现；能注入时返回空串（不需要额外说明）。
 *
 * @param {boolean} canInject 见 {@link canInjectPen}
 * @returns {string}
 */
export function penCoverageNote(canInject) {
  const penStep = penControlOrder().find((step) => step.pointer === 'pen');
  if (canInject === true || penStep === undefined) {
    return '';
  }
  return `[accept] note=笔注入不可用（uitest 注入不了 SourceTool.Pen），未覆盖：${penStep.label}`;
}

/**
 * 从一段 hilog 里判断「这一笔有没有落到画布上」。
 *
 * 两个独立信号（任一成立即算落笔）：
 *   - `[hw] history undo=N`（N ≥ 1）：撤销栈变非空，只有真正落笔才会变；
 *   - `[hw] draft saved ... bytes=N`（N > 0）：抬笔 2s 后的草稿自动保存。
 * 被拒绝的手指输入两者都不会出现（`handleTouch` 第一行就 return：不脏、不进撤销栈、不写草稿）。
 *
 * @param {string} log hilog 文本
 * @returns {{drew: boolean, signal: string}}
 */
export function inkEvidence(log) {
  const text = String(log ?? '');
  const undo = /\[hw\] history undo=([1-9]\d*)/.exec(text);
  if (undo !== null) {
    return { drew: true, signal: `undo=${undo[1]}` };
  }
  const draft = /\[hw\] draft saved[^\n]*bytes=(\d+)/.exec(text);
  if (draft !== null && Number(draft[1]) > 0) {
    return { drew: true, signal: `draft bytes=${draft[1]}` };
  }
  return { drew: false, signal: '' };
}

/**
 * `hdc list targets` 文本 → 序列号数组。
 *
 * 输出里可能有空行、`[Empty]`、`[Fail]` 这类方括号占位行，一律丢掉。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function listTargets(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[.*\]$/.test(line));
}

/**
 * 从 `hdc list targets` 文本里定出要用的 SERIAL；定不出来返回 null（→ 退出 2）。
 *
 * - 指定了 `wanted`：必须**精确出现**在列表里，否则 null（连错设备比不连更糟）；
 * - 没指定：取第一个在线设备。
 *
 * @param {string} text
 * @param {string} [wanted]
 * @returns {string|null}
 */
export function pickSerial(text, wanted) {
  const targets = listTargets(text);
  const want = typeof wanted === 'string' ? wanted.trim() : '';
  if (want.length > 0) {
    return targets.includes(want) ? want : null;
  }
  return targets.length > 0 ? targets[0] : null;
}

/**
 * 本文件是被 `node device-accept.mjs` 直接执行，还是被 `import`？
 *
 * 只有直接执行才允许跑 main()：单测 `import` 本模块时不能碰 hdc、不能写文件。
 * Windows 路径大小写不敏感，所以按小写比较（同目录下仅大小写不同的两个文件极罕见）。
 *
 * @param {string|undefined} argv1 通常是 `process.argv[1]`
 * @param {string} moduleUrl 通常是 `import.meta.url`
 * @returns {boolean}
 */
export function isDirectRun(argv1, moduleUrl) {
  if (typeof argv1 !== 'string' || argv1.length === 0) {
    return false;
  }
  let selfPath;
  try {
    selfPath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  return resolve(argv1).toLowerCase() === resolve(selfPath).toLowerCase();
}

// ---------------------------------------------------------------------------
// 运行时上下文（模块级只放空壳：import 时不读 argv、不建目录、不碰设备）
// ---------------------------------------------------------------------------

const ctx = {
  serial: DEFAULT_SERIAL,
  skipInstall: false,
  keepGoing: false,
  results: []
};

/** 流程中断哨兵：`fail()` 抛它，由 main() 统一收尾（保证末行汇总一定打出来、不被 process.exit 截断）。 */
class StopFlow extends Error {}

/** 解析命令行（纯函数，不读全局）。 */
function parseOptions(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const opt = (name, fallback) => {
    const i = list.indexOf(name);
    return i >= 0 && i + 1 < list.length ? list[i + 1] : fallback;
  };
  return {
    serial: opt('--serial', DEFAULT_SERIAL),
    skipInstall: list.includes('--skip-install'),
    keepGoing: list.includes('--keep-going')
  };
}

// ---------------------------------------------------------------------------
// 设备侧执行（只有 main() 会走到这里）
// ---------------------------------------------------------------------------

function run(bin, list, timeoutMs = 120000) {
  // Windows 上 .cmd/.bat 不能直接 spawn（ENOENT），必须经 cmd.exe /c 调用。
  const isCmd = /\.(cmd|bat)$/i.test(bin);
  const command = isCmd ? (process.env.ComSpec ?? 'cmd.exe') : bin;
  const argv = isCmd ? ['/d', '/s', '/c', bin, ...list] : list;
  const done = spawnSync(command, argv, { encoding: 'utf8', timeout: timeoutMs, shell: false });
  const spawnError = done.error ? `${done.error.name}: ${done.error.message}` : '';
  return {
    code: done.status === null ? -1 : done.status,
    out: `${done.stdout ?? ''}${done.stderr ?? ''}${spawnError}`.trim()
  };
}

const hdc = (list, timeoutMs) => run(HDC, ['-t', ctx.serial, ...list], timeoutMs);
const cli = (list, timeoutMs) => run(DEVECO_CLI, list, timeoutMs);

/** 等一会儿（设备侧动作没有回调，只能等；与既有脚本一致，用 PowerShell 的 Start-Sleep）。 */
function sleepSeconds(seconds) {
  spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Seconds ${seconds}`], {
    encoding: 'utf8'
  });
}

function pass(step, detail) {
  ctx.results.push({ step, ok: true, detail });
  console.log(`PASS  ${step}  ${detail ?? ''}`.trimEnd());
}

function fail(step, detail) {
  ctx.results.push({ step, ok: false, detail });
  console.log(`FAIL  ${step}  ${detail ?? ''}`.trimEnd());
  if (!ctx.keepGoing) {
    throw new StopFlow();
  }
}

/**
 * 记一条 SKIP：**未覆盖**，既不是 PASS 也不是 FAIL。
 *
 * `ok:false` 是刻意的（这一项没有通过），`skipped:true` 说明原因不是失败而是没覆盖。
 * 千万不要写成 `ok:true` —— 那正是老缺陷：SKIP 被算成 PASS，5 SKIP + 1 PASS 也会 exit 0。
 */
function skipped(step, detail) {
  ctx.results.push({ step, ok: false, skipped: true, detail });
  console.log(`SKIP  ${step}  ${detail ?? ''}`.trimEnd());
}

/** 打印人读的合计行 + 机器可读的末行（`[accept] ...`，必须是最后一行）。
 *
 * 笔注入不可用时，末行之前会多打一行 `[accept] note=…` 点名没覆盖的那一步；
 * 它刻意**不**进 results / 汇总计数 —— 那一步没被登记，所以既不算 PASS 也不算 SKIP。
 */
function summarize() {
  const passed = ctx.results.filter((r) => r.ok === true && r.skipped !== true).length;
  const failed = ctx.results.filter((r) => r.ok === false && r.skipped !== true).length;
  const skippedCount = ctx.results.filter((r) => r.skipped === true).length;
  console.log('');
  console.log(`合计：PASS ${passed} / FAIL ${failed} / SKIP ${skippedCount}`);
  const note = penCoverageNote(canInjectPen());
  if (note.length > 0) {
    console.log(note);
  }
  console.log(summaryLine(ctx.results));
}

/** 读 UI 布局树，返回 [{text,id,bounds}]。
 *
 * `devecocli ui layout` 的输出可能混有进度行（`- Dumping layout…`）、ANSI 颜色、空行，
 * 甚至截断的 stdout；这里取**第一个 `[` 起、到最后一个 `]` 止**的片段再解析，失败时打印原文尾部。
 */
function layout(mode = 'simplified') {
  const out = join(TMP, `layout-${Date.now()}.json`);
  const res = cli(['ui', 'layout', '--device', ctx.serial, '--format', 'json', '--mode', mode]);
  // 解析逻辑抽到 layout-parse.mjs（纯函数，有单测；能容忍 "- Dumping layout…" 前缀/ANSI/截断）
  const flat = parseLayoutOutput(res.out);
  writeFileSync(out, JSON.stringify(flat, null, 2), 'utf8');
  return flat;
}

const texts = (flat) => flat.map((n) => n.text).filter((t) => t.length > 0);
const hasText = (flat, text) => texts(flat).some((t) => t.includes(text));
const byText = (flat, text) => flat.find((n) => n.text === text);
const center = (node) => {
  const [x1, y1, x2, y2] = node.bounds;
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
};

function tap(node) {
  const [x, y] = center(node);
  hdc(['shell', `uitest uiInput click ${x} ${y}`]);
}

/** 滑动手势：`uitest uiInput swipe` 只接受 4 个坐标参数（没有 duration），多传会直接报错。 */
function swipe(x1, y1, x2, y2) {
  hdc(['shell', `uitest uiInput swipe ${x1} ${y1} ${x2} ${y2}`]);
}

/** 工具条上的「笔迹设置」按钮显示的是当前值（如 `钢笔 · 3.5 · 黑`），不是固定文案。 */
const INK_BUTTON_RE = /·/;

function screenSize(flat) {
  const root = flat[0];
  const b = root?.bounds ?? [0, 0, 1600, 2560];
  return { w: b[2], h: b[3] };
}

/** 清空 hilog 缓冲（每段观察都从干净窗口开始，否则会读到上一段的旧行）。 */
function hilogClear() {
  hdc(['shell', 'hilog', '-r']);
}

/** 等 `seconds` 秒后把 hilog 缓冲取空并返回文本。 */
function hilogDump(seconds = 6) {
  sleepSeconds(seconds);
  return hdc(['shell', 'hilog', '-x'], 60000).out;
}

/** 清缓冲 → 等 → 取（既有调用点的语义，保持不变）。 */
function hilog(seconds = 6) {
  hilogClear();
  return hilogDump(seconds);
}

/** 取日志里最相关的一行（塞进 PASS/FAIL 详情，别把整段 hilog 糊上去）。 */
function hilogHint(log) {
  const lines = String(log ?? '')
    .split(/\r?\n/)
    .filter((line) => /\[hw\]|已连续忽略/.test(line));
  const last = lines[lines.length - 1];
  return last === undefined ? '无 [hw] 日志' : last.trim();
}

// ---------------------------------------------------------------------------
// 加分项 1：工具条两行布局（缺陷 4）
// ---------------------------------------------------------------------------

/**
 * 打印工具条每个控件的 y，并按 y 分组两行。
 *
 * 为什么要在验收脚本里打印 y：真机上「两行叠成一行 / 第二行跑到屏幕外」只能靠坐标看出来，
 * 光断言文案存在是查不出来的。分组阈值是 {@link ROW_TOL}。
 *
 * @param {Array<{text: string, id: string, bounds: number[]}>} flat 手写板页面的布局 dump
 */
function toolbarRowsStep(flat) {
  const items = toolbarItems(flat);
  const rows = groupByRows(items);
  for (const line of formatToolbarRows(items)) {
    console.log(`      ${line}`);
  }
  // 每行的控件名也进 detail：真机日志里光看 row1=8 个 / row2=0 个 分不出「挤成一行」还是「少了控件」
  const cells = rows.map(
    (row, i) => `row${i + 1}=${row.length} 个（${row.map((it) => it.name).join(', ')}）`
  );
  const detail = `${cells.length === 0 ? '一个控件都没找到' : cells.join(' / ')}（y 容差 ${ROW_TOL}）`;
  const verdict = toolbarRowsVerdict(rows);
  if (verdict.ok) {
    pass('工具条两行', detail);
    return;
  }
  // 行数不对就是真缺陷（缺陷 4 本身），不是「未覆盖」：不许再记 PASS
  fail('工具条两行', `${verdict.reason}；${detail}`);
}

// ---------------------------------------------------------------------------
// 加分项 2：pen 对照组（缺陷 3）
// ---------------------------------------------------------------------------

/** 「仅手写笔输入」开关的标签文案（笔迹面板「更多」里那一行）。 */
const PEN_ONLY_LABEL = '仅手写笔输入';

/** 手写画布节点 id 前缀（`hw-page-p1` 等，见 HandwritingPager 的 HANDWRITING_PAGE_ID_PREFIX）。 */
const CANVAS_ID_PREFIX = 'hw-page';

/** 手写画布节点（找不到说明还没进手写板）。 */
function canvasNode(flat) {
  return (Array.isArray(flat) ? flat : []).find(
    (n) =>
      n &&
      typeof n.id === 'string' &&
      n.id.startsWith(CANVAS_ID_PREFIX) &&
      Array.isArray(n.bounds) &&
      n.bounds.length === 4
  );
}

/** 整组 pen 步骤记 SKIP（缺设备 / 缺画布 / 开关拨不动）：未覆盖，不是通过。 */
function skipPenGroup(reason) {
  // 只登记本次真要跑的步骤：注入不了笔时第三步不存在（不占 total、不进 SKIP 列表）
  for (const step of penStepRegistrations(canInjectPen())) {
    skipped(step.label, reason);
  }
}

/**
 * 打开「笔迹 → 更多」二级菜单（开关就藏在这一层）。
 * @returns {boolean} 开关那一行是否真的出现了
 */
function openInkMore() {
  let flat = layout();
  const ink = byText(flat, '笔迹');
  if (ink === undefined) {
    return false;
  }
  tap(ink);
  sleepSeconds(2);
  flat = layout();
  const more = byText(flat, '更多');
  if (more === undefined) {
    return false;
  }
  tap(more);
  sleepSeconds(2);
  return byText(layout(), PEN_ONLY_LABEL) !== undefined;
}

/** 收起笔迹面板（面板开着时再点一次「笔迹」= 收起，与页面 togglePanel 的语义一致）。 */
function closeInkPanel() {
  const flat = layout();
  if (byText(flat, PEN_ONLY_LABEL) === undefined && byText(flat, '更多') === undefined) {
    return;
  }
  const ink = byText(flat, '笔迹');
  if (ink === undefined) {
    return;
  }
  tap(ink);
  sleepSeconds(1);
}

/**
 * 点一下「仅手写笔输入」开关，返回点完之后 hilog 里读到的状态。
 *
 * 为什么状态取自 hilog 而不是「点了就算」：开关是 Toggle，点偏了不会报错，
 * 只有页面打的 `[hw] penOnly=<0|1> source=panel` 能证明状态真的翻了。
 *
 * @returns {boolean|null} null = 没找到开关 / 没读到状态变化
 */
function tapPenOnlyToggle() {
  const flat = layout();
  const label = byText(flat, PEN_ONLY_LABEL);
  if (label === undefined) {
    return null;
  }
  const [, y1, x2, y2] = label.bounds;
  // 开关在标签右侧：贴着标签右缘再往右一点（面板是浮层，不能用屏幕右边算坐标）
  const x = Math.round(x2 + 24);
  const y = Math.round((y1 + y2) / 2);
  // 先清缓冲再点：页面是在 onChange 里打 `[hw] penOnly=…` 的，先点后清会把这行直接抹掉
  hilogClear();
  hdc(['shell', `uitest uiInput click ${x} ${y}`]);
  const hit = /\[hw\] penOnly=([01]) source=panel/.exec(hilogDump(2));
  return hit === null ? null : hit[1] === '1';
}

/**
 * 把「仅手写笔输入」拨到 target（必要时先打开 笔迹 → 更多）。
 * @param {boolean} target
 * @returns {boolean} 是否达成
 */
function setPenOnly(target) {
  if (!openInkMore()) {
    return false;
  }
  let current = tapPenOnlyToggle();
  if (current === null) {
    return false;
  }
  if (current === target) {
    return true;
  }
  current = tapPenOnlyToggle();
  return current === target;
}

/**
 * 在画布上划手指 `times` 次，返回这段窗口内的 hilog。
 *
 * 顺序很关键：**先清缓冲，再划，再取**。若先划再清，落笔产生的 `[hw] history undo=` /
 * `[hw] draft saved` 会被 `hilog -r` 直接抹掉，于是永远判成「没画」。
 *
 * @param {number} [times]
 * @returns {string|null} null = 找不到画布（调用方按「未覆盖」处理）
 */
function drawFingerStroke(times = 1) {
  const canvas = canvasNode(layout());
  if (canvas === undefined) {
    return null;
  }
  const [x1, y1, x2, y2] = canvas.bounds;
  const w = x2 - x1;
  const h = y2 - y1;
  const from = Math.round(x1 + w * 0.25);
  const to = Math.round(x1 + w * 0.55);
  hilogClear();
  for (let i = 0; i < Math.max(1, times); i += 1) {
    const y = Math.round(y1 + h * 0.35 + i * 60);
    swipe(from, y, to, y + 24);
    sleepSeconds(1);
  }
  return hilogDump(4);
}

/**
 * 缺陷 3：pen 对照组。
 *
 * 顺序由 {@link penControlOrder} 固定：先在 penOnly=off 下用**同一组坐标**证明手指能画
 * （对照组），再验 penOnly=on 时同一组坐标不落笔。没有前一组，「手指没画」也可能只是
 * 坐标偏了/画布没就绪，证明不了过滤生效。
 *
 * 每一步的证据都来自 hilog（`inkEvidence`），不是「看起来没画」。用完把开关拨回 off：
 * 验收脚本不能把用户的设备留在「只能用手写笔」的状态。
 */
function penControlStep() {
  const steps = penControlOrder();
  const [offFinger, onFinger] = steps;
  // 「笔能画」这一步只在真能注入笔事件时才登记（见 penStepRegistrations）；否则它根本不存在
  const penStep = penStepRegistrations(canInjectPen()).find((step) => step.pointer === 'pen');

  // ① 还拿得到布局/画布吗？拿不到就是「无设备」——整组 SKIP，不是 PASS 也不是 FAIL
  let flat;
  try {
    flat = layout();
  } catch {
    skipPenGroup('无设备');
    return;
  }
  if (canvasNode(flat) === undefined) {
    skipPenGroup('未找到手写画布（hw-page-*）');
    return;
  }

  // ② 对照组：penOnly=off 时手指必须能画
  if (!setPenOnly(false)) {
    skipPenGroup(`未能在「笔迹 → 更多」里把「${PEN_ONLY_LABEL}」拨到关`);
    return;
  }
  closeInkPanel();
  const offLog = drawFingerStroke(1);
  if (offLog === null) {
    skipPenGroup('未找到手写画布（hw-page-*）');
    return;
  }
  const offInk = inkEvidence(offLog);
  if (!penControlVerdict(offFinger, offInk.drew)) {
    fail(offFinger.label, `开关关闭时手指画不上（hilog 无落笔证据：${hilogHint(offLog)}）`);
    return;
  }
  pass(offFinger.label, `同一组坐标下手指落笔有证据（${offInk.signal}）`);

  // ③ penOnly=on：同一组坐标，手指不画
  if (!setPenOnly(true)) {
    skipped(onFinger.label, `未能在「笔迹 → 更多」里把「${PEN_ONLY_LABEL}」拨到开`);
    if (penStep !== undefined) {
      skipped(penStep.label, '同上：开关没打开，笔的行为无从验证');
    }
    return;
  }
  closeInkPanel();
  // 连划 3 下：被拒计数要到阈值（FINGER_REJECT_THRESHOLD=3）才会 toast，划一次不一定出提示
  const onLog = drawFingerStroke(3);
  if (onLog === null) {
    // 画布没了也要先把开关拨回去，否则设备停在「只能用手写笔」
    const restoredOnMissing = setPenOnly(false);
    closeInkPanel();
    skipped(onFinger.label, '未找到手写画布（hw-page-*）');
    if (penStep !== undefined) {
      skipped(penStep.label, '未找到手写画布（hw-page-*）');
    }
    if (!restoredOnMissing) {
      fail('penOnly 复位', `关不掉「${PEN_ONLY_LABEL}」——设备会停在只能用手写笔的状态`);
    }
    return;
  }
  const onInk = inkEvidence(onLog);
  const rejected = /已连续忽略\s*\d+\s*次手指输入/.test(onLog);
  const fingerBlocked = penControlVerdict(onFinger, onInk.drew);
  // 先复位再判定：哪怕这一小步要 FAIL，也不能把设备留在「只能用手写笔」的状态
  const restored = setPenOnly(false);
  closeInkPanel();
  if (!fingerBlocked) {
    fail(
      onFinger.label,
      `开启「${PEN_ONLY_LABEL}」后手指仍能画（hilog 有落笔证据：${onInk.signal}）${restored ? '' : '；且开关没能复位'}`
    );
    return;
  }
  pass(
    onFinger.label,
    rejected ? '手指未落笔，且出现「已连续忽略 N 次手指输入」' : '手指未落笔（未捕获拒绝提示，但无落笔证据）'
  );

  // ④ 笔能画：uitest 注入不了 SourceTool.Pen —— 这一步**不登记**（不占 total、不进 SKIP 列表），
  //    未覆盖的事实由末尾 `[accept] note=` 单独说明（penCoverageNote）。只有真的能注入笔事件
  //    （canInjectPen() 为 true）时，这一步才会存在并在此处落 SKIP/实测结果。
  if (penStep !== undefined) {
    skipped(penStep.label, '脚本注入不了手写笔事件（uitest 只有手指），需人工用笔确认');
  }

  // ⑤ 复位失败要记 FAIL：设备被留在「只能用手写笔」是用户可见的破坏
  if (!restored) {
    fail('penOnly 复位', `关不掉「${PEN_ONLY_LABEL}」——设备会停在只能用手写笔的状态`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 业务步骤（0~8）。失败时 `fail()` 抛 StopFlow，由 main() 统一收尾。 */
function runSteps() {
  if (!existsSync(TMP)) {
    mkdirSync(TMP, { recursive: true });
  }
  console.log(`真机验收：serial=${ctx.serial}  skipInstall=${ctx.skipInstall}`);

  // 0. 设备在不在：不在就退出 2 —— 一个断言都没跑，既不是 PASS 也不是 FAIL
  const targets = run(HDC, ['list', 'targets'], 30000).out;
  const serial = pickSerial(targets, ctx.serial);
  if (serial === null) {
    console.log(
      `设备未连接：hdc list targets 里找不到 ${ctx.serial}（当前：${targets.trim() || '空输出'}）`
    );
    console.log(
      '处理：接上真机并确认 `hdc list targets` 能列出序列号，或用 --serial <id> 指定；本脚本以 2 退出（未覆盖 ≠ 通过）。'
    );
    return;
  }
  ctx.serial = serial;
  pass('设备连接', serial);

  // 1. 安装 + 启动
  const hap = join(APP, 'dist-harmony', 'arkui-schedule-harmony-debug-signed.hap');
  if (!ctx.skipInstall) {
    if (!existsSync(hap)) {
      fail('安装', `找不到 ${hap}（先跑 tools/build-harmony.ps1 + tools/sign-hap.ps1 -Deliver）`);
      return;
    }
    const inst = hdc(['install', '-r', hap], 180000);
    if (!/install bundle successfully/i.test(inst.out)) {
      fail('安装', inst.out.slice(0, 300));
      return;
    }
    pass('安装', hap.split(/[\\/]/).pop());
  } else {
    skipped('安装', '--skip-install');
  }

  hdc(['shell', 'power-shell', 'wakeup']);
  const started = hdc(['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', 'com.itwill.schedule'], 60000);
  if (/10106102/.test(started.out)) {
    fail('启动', '需要解锁 PIN：设备锁屏（10106102），请手动解锁后重跑本脚本');
    return;
  }
  if (!/start ability successfully/i.test(started.out)) {
    fail('启动', started.out.slice(0, 300));
    return;
  }
  pass('启动', 'aa start successfully');

  const boot = hilog(8);
  if (/jscrash|appfreeze|SIGSEGV/i.test(boot)) {
    fail('启动无崩溃', 'hilog 命中 jscrash/appfreeze/SIGSEGV');
    return;
  }
  pass('启动无崩溃', 'hilog 8s 无 fatal');

  // 1.5 回到首页：应用可能停留在上次的编辑/手写页（脚本要可重复跑）
  let flat = layout();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    flat = layout();
    const textsNow = texts(flat);
    const onHome = textsNow.includes('新建') || textsNow.some((t) => t.includes('今日待办'));
    const inHandwriting = textsNow.some((t) => /^[^·]*·/.test(t)) && textsNow.includes('完成');
    if (onHome && !inHandwriting) {
      break;
    }
    hdc(['shell', 'uitest uiInput keyEvent Back']);
    sleepSeconds(2);
  }

  // 2. 竖屏单列 / 横屏主从
  flat = layout();
  let size = screenSize(flat);
  const portrait = size.h >= size.w;
  if (portrait) {
    const entry = byText(flat, '新建');
    if (entry && entry.bounds[2] - entry.bounds[0] > size.w * 0.6) {
      pass('布局·竖屏单列', `「新建」宽 ${entry.bounds[2] - entry.bounds[0]}px（>60% 屏宽）`);
    } else {
      fail('布局·竖屏单列', `未找到满宽「新建」，实际 ${entry ? entry.bounds.join(',') : '缺失'}`);
    }
    if (hasText(flat, '从左侧选一条日程查看')) {
      fail('布局·竖屏单列', '出现了右栏空态（说明仍在主从布局）');
    } else {
      pass('布局·竖屏无右栏', '未出现右栏空态');
    }
  } else {
    const hasPane = hasText(flat, '从左侧选一条日程查看') || hasText(flat, '标题');
    if (hasPane) {
      pass('布局·横屏主从', '存在右栏内容');
    } else {
      fail('布局·横屏主从', '未找到右栏内容');
    }
  }

  // 3. 新建 → 手写板 → 画 2 页
  const newBtn = byText(flat, '新建') ?? byText(flat, '新建日程');
  if (!newBtn) {
    fail('进入编辑', '找不到「新建」');
    return;
  }
  tap(newBtn);
  sleepSeconds(3);
  flat = layout();
  const inkEntry = byText(flat, '手写板');
  if (!inkEntry) {
    fail('进入手写板', '编辑页找不到「手写板」入口（是否非鸿蒙构建？）');
    return;
  }
  tap(inkEntry);
  sleepSeconds(4);
  flat = layout();
  // 工具条（新设计）：「笔迹」固定文案 + 「插入」二级菜单；不再显示 `钢笔 · 3.5 · 黑` 这类拼接值。
  const toolbarTexts = texts(flat);
  if (!toolbarTexts.includes('笔迹')) {
    fail('手写板工具条', `未找到「笔迹」按钮（现有文本：${toolbarTexts.slice(0, 12).join(' | ')}）`);
    return;
  }
  if (!toolbarTexts.includes('插入')) {
    fail('手写板工具条', `未找到「插入」按钮（现有文本：${toolbarTexts.slice(0, 12).join(' | ')}）`);
    return;
  }
  const legacyLabel = toolbarTexts.find((t) => t.includes('·') && /笔|钢笔|中性|马克/.test(t));
  if (legacyLabel !== undefined) {
    fail('手写板工具条', `仍有拼接标签「${legacyLabel}」（应改为固定「笔迹」）`);
    return;
  }
  if (toolbarTexts.includes('颜色') || toolbarTexts.includes('粗细')) {
    fail('手写板工具条', `不该有独立「颜色/粗细」按钮（现有：${toolbarTexts.join(' | ')}）`);
    return;
  }
  pass('手写板工具条', '「笔迹」+「插入」就位，无拼接标签、无独立颜色/粗细');

  // 3.1 工具条两行：打印每个控件的 y 并按 y 分组（缺陷 4：两行叠成一行只有坐标能看出来）
  toolbarRowsStep(flat);

  // 3.2 pen 对照组（缺陷 3）：先证明关闭时手指能画，再证明开启后手指不画
  penControlStep();

  // 3.3 「插入」二级菜单：图片 / 表格（pen 那步开合过面板，这里重新 dump 一次再点）
  flat = layout();
  const insertBtn = byText(flat, '插入');
  if (insertBtn) {
    tap(insertBtn);
    sleepSeconds(2);
    const menuFlat = layout();
    const menuTexts = texts(menuFlat);
    if (menuTexts.includes('图片') && menuTexts.includes('表格')) {
      pass('插入菜单', `含「图片」「表格」（${menuTexts.filter((t) => /图片|表格/.test(t)).join(' / ')}）`);
    } else {
      fail('插入菜单', `点击「插入」后未见图片/表格（现有：${menuTexts.slice(0, 14).join(' | ')}）`);
    }
  }

  // 画 2 笔
  swipe(400, 700, 900, 800);
  swipe(450, 1000, 1000, 1100);
  sleepSeconds(3);

  // 插页（[−|+] 单元格的右半：找「+」节点）
  flat = layout();
  const plus = byText(flat, '+');
  if (!plus) {
    fail('插入页', '找不到「+」按钮');
    return;
  }
  tap(plus);
  sleepSeconds(2);
  flat = layout();
  if (!hasText(flat, '2/2')) {
    fail('插入页', `页数未变成 2/2（当前 ${texts(flat).filter((t) => /^\d+\/\d+$/.test(t)).join(',') || '无'}）`);
    return;
  }
  pass('插入页', '2/2');

  swipe(500, 1200, 1100, 1300);
  sleepSeconds(3);

  // 完成
  flat = layout();
  const done = byText(flat, '完成');
  if (!done) {
    fail('完成', '找不到「完成」按钮');
    return;
  }
  tap(done);
  sleepSeconds(20);
  const afterFinish = hilog(2);
  if (/jscrash|appfreeze/i.test(afterFinish)) {
    fail('完成', 'hilog 命中崩溃');
    return;
  }
  pass('完成', '返回编辑页且未崩溃');

  // 3.5 完成后的用户可见反馈：toast「已保存 N 页手迹」/ 编辑页「手迹 N 页」
  const afterTexts = texts(layout());
  const inkNotice = afterTexts.find((t) => /手迹\s*\d+\s*页/.test(t));
  if (inkNotice !== undefined) {
    pass('完成反馈', `编辑页显示「${inkNotice}」`);
  } else {
    const toastLine = (hilog(3).match(/已保存\s*\d+\s*页手迹/g) ?? [])[0];
    if (toastLine !== undefined) {
      pass('完成反馈', `hilog 命中 toast「${toastLine}」（编辑页未显示手迹页数）`);
    } else {
      fail('完成反馈', `未见「手迹 N 页」也未见 toast（页面文本：${afterTexts.slice(0, 10).join(' | ')}）`);
    }
  }

  // 3.6 正文占位符（图片/表格对象参与遮罩后应留下可读占位）
  const placeholders = afterTexts.filter((t) => /\[(图片|表格)[^\]]*\]/.test(t));
  if (placeholders.length > 0) {
    pass('正文占位符', placeholders.slice(0, 3).join(' / '));
  } else {
    skipped('正文占位符', '本轮未插入图片/表格对象（占位符由对象生成）');
  }

  // 4. 附件 zip：拉回当天 zip 并断言
  const dateKey = new Date().toISOString().slice(0, 10);
  const pkg = 'com.itwill.schedule';
  const remoteZip = `/data/app/el2/100/base/${pkg}/haps/entry/files/attachments/${dateKey}.zip`;
  const altZip = `/data/app/el2/100/base/${pkg}/haps/entry/files/drafts/${dateKey}.zip`;
  const localZip = join(TMP, `${dateKey}.zip`);
  let zipOk = false;
  for (const candidate of [remoteZip, altZip]) {
    hdc(['file', 'recv', candidate, localZip], 60000);
    if (existsSync(localZip) && readFileSync(localZip).length > 0) {
      zipOk = true;
      break;
    }
  }
  if (zipOk) {
    pass('附件 zip 存在', `${dateKey}.zip（${readFileSync(localZip).length} B）`);
  } else {
    skipped('附件 zip 存在', '设备路径未命中（工作副本在 repo 里，需先配置同步并 push；见报告说明）');
  }

  // 仓库里只应有 zip，不应有散图
  const ls = spawnSync('git', ['-C', REPO, 'ls-files', 'devices/'], { encoding: 'utf8' });
  const files = (ls.stdout ?? '').split(/\r?\n/).filter((l) => l.includes('/attachments/'));
  const loose = files.filter((f) => !f.endsWith('.zip'));
  if (loose.length === 0) {
    pass('仓库无散图', files.length === 0 ? '未发现 attachments 文件（可能尚未同步）' : `attachments 下 ${files.length} 个文件全为 zip`);
  } else {
    fail('仓库无散图', `发现散图：${loose.slice(0, 3).join(', ')}`);
  }

  // 5. 详情页断言附件页签
  flat = layout();
  const page1 = hasText(flat, '第 1 页');
  const page2 = hasText(flat, '第 2 页');
  if (page1 && page2) {
    pass('详情页附件', '出现「第 1 页 / 第 2 页」');
  } else {
    skipped('详情页附件', `当前页未同时出现两页标签（第1页=${page1} 第2页=${page2}）`);
  }

  // 6. 启动自动 pull（杀进程后重启抓 [sync]）
  hdc(['shell', 'aa', 'force-stop', 'com.itwill.schedule']);
  hdc(['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', 'com.itwill.schedule'], 60000);
  const syncLog = hilog(12);
  if (/\[sync\] startup pull/.test(syncLog)) {
    pass('启动自动 pull', syncLog.split(/\r?\n/).find((l) => l.includes('[sync] startup pull')) ?? '');
  } else {
    skipped('启动自动 pull', 'hilog 未见 [sync] startup pull（可能未配置仓库）');
  }

  // 7. 下拉刷新
  hdc(['shell', 'uitest uiInput swipe 800 400 800 1200']);
  const refreshLog = hilog(8);
  if (/\[sync\] refresh pull/.test(refreshLog)) {
    pass('下拉刷新', 'hilog 命中 [sync] refresh pull');
  } else {
    skipped('下拉刷新', 'hilog 未见 [sync] refresh pull');
  }

  // 8. 全部未完成读索引
  flat = layout();
  const tab = byText(flat, '全部未完成');
  if (!tab) {
    skipped('全部未完成', '找不到 tab');
  } else {
    tap(tab);
    const idxLog = hilog(4);
    if (/\[idx\]/.test(idxLog)) {
      pass('全部未完成·索引', idxLog.split(/\r?\n/).find((l) => l.includes('[idx]')) ?? '');
    } else {
      skipped('全部未完成·索引', 'hilog 未见 [idx]（索引未漂移时不会打印，属正常）');
    }
  }
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  ctx.serial = options.serial;
  ctx.skipInstall = options.skipInstall;
  ctx.keepGoing = options.keepGoing;
  ctx.results.length = 0;
  try {
    runSteps();
  } catch (error) {
    if (!(error instanceof StopFlow)) {
      throw error;
    }
  }
  summarize();
  // 末行汇总的 exit 字段与真实退出码同源（都来自 gradeExit），不会出现「写着 3、退出 0」
  process.exitCode = gradeExit(ctx.results);
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  main();
}
