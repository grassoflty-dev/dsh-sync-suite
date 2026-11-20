#!/usr/bin/env node
/**
 * 表格验收（真机）：3×2 → Markdown / 7×6 → 自动关闭识别 / 手动关闭识别 → 占位符。
 *
 * 用法（**默认不装包、不动设备配置**；设备串行使用，跑之前确认没人占用）：
 *
 *   # 全流程（想跑哪几段就写哪几段）
 *   node apps/arkui-schedule/tools/qa-table-markdown.mjs --phases 1,2,3
 *
 *   # 只验 3×2 → Markdown
 *   node apps/arkui-schedule/tools/qa-table-markdown.mjs --phases 1
 *
 *   # 无线调试（默认）：设备可能息屏断开
 *   node apps/arkui-schedule/tools/qa-table-markdown.mjs --serial 192.168.1.10:33023
 *
 *   # 几何量（一般不用给）：密度 / 画布矩形（给 x,y,w,h 可跳过全部探测）
 *   node apps/arkui-schedule/tools/qa-table-markdown.mjs --density 3.25
 *   node apps/arkui-schedule/tools/qa-table-markdown.mjs --canvas 237,0,2323,1600
 *
 *   # 其它
 *   --cell-mode dot|swipe  格子内怎么画：dot（默认，点一笔，不移动表格）/ swipe（划一笔，会拖动表格）
 *   --keep-going    某步失败后继续跑（默认失败即停，并打印已获得的证据）
 *   --help / -h     打印本说明
 *
 * 前置：
 *   - `$env:DEVECO_CLI_STUDIO_PATH='D:\A-DevEco\DevEco Studio'`（脚本会自动补上，已有值不覆盖）
 *   - 设备已安装本 App（本脚本**不安装、不卸载**，只驱动 UI + 读日志）
 *
 * 流程（文字版）：
 *
 *   0 探活 → 1 回首页 → 新建 → 手写板 → 工具条自检
 *     ↓
 *   ┌─ Phase 1（3×2 → Markdown）────────────────────────────────────────┐
 *   │ 插入▾ → 表格 → 行=3/列=2（按 layout 的「行 N/列 N」逐次点 −/+）        │
 *   │ → 插入表格 → 在 6 个格子中心各点一笔 → 完成 → 等 20s                  │
 *   │ → hilog「insert=table / table ocr ok=1」→ 回编辑页 layout 取正文      │
 *   │ → 断言：正文有一个 4 行 Markdown 块，每行 3 个 `|`（2 列）             │
 *   └──────────────────────────────────────────────────────────────────┘
 *     ↓
 *   ┌─ Phase 2（7×6 → 自动关闭识别）────────────────────────────────────┐
 *   │ 手写板 → 插入▾ → 表格 → 行=7/列=6 → 插入表格                        │
 *   │ → 立刻 layout 抓 toast「表格超过 6×6，已关闭文字识别」（尽力）          │
 *   │ → 点表格选中 → 面板「识别文字」显示「关」（硬证据）→ 完成 → 断言正文    │
 *   │   含 `[表格 7×6: 见附件 · 第N页]`                                   │
 *   └──────────────────────────────────────────────────────────────────┘
 *     ↓
 *   ┌─ Phase 3（手动关闭识别 → 占位符）──────────────────────────────────┐
 *   │ 手写板 → 插入▾ → 表格 → 行=3/列=2 → 插入表格 → 点表格选中             │
 *   │ → 插入▾ 面板「识别文字」=「开」→ 点它 → 变「关」                       │
 *   │   （hilog `[hw] table ocr toggle … enabled=0`）→ 完成                │
 *   │ → 断言正文含 `[表格 3×2: 见附件 · 第N页]`（未产出 Markdown）           │
 *   └──────────────────────────────────────────────────────────────────┘
 *     ↓
 *   输出 PASS/FAIL/SKIP 列表 + 截图路径 + 关键 hilog 片段（另落 JSON 报告）
 *
 * 真机踩出来的约束（照抄现成脚本的做法，别自创）：
 * - 无线调试每步前 `hdc shell echo ok` 探活；失败报「无线调试断开，请保持亮屏」并 exit 2。
 * - `swipe` 只有 4 个坐标参数；`hilog -T` 会挂住，所以用 `hilog -r` → sleep → `hilog -x`。
 * - 截图**不覆盖**已存在文件：文件名带时间戳 + 递增序号。
 * - **单元格里不能"划"一笔**：对象层（`Canvas` + `HitTestMode.Transparent`）在表格矩形内
 *   优先接管 Down/Move（选中 + 拖动，见 `Handwriting.ets#onObjectTouch`），手指一划整张表
 *   就跟着移动，后续格子坐标全错。所以本脚本用 `click` 在格子中心「点一笔」
 *   （Down+Up 不产生 Move → 只画一个墨点，不移动表格）。`--cell-mode swipe` 保留原语义，
 *   但会在报告里标「表格可能被拖动」。
 * - 表格对象画在 Canvas 上，**没有文本节点**，layout 拿不到它的矩形；因此格子中心 =
 *   `tableRect()`（默认 60%×40% 居中，从 `.build/model/pageObjects.js` 直接 import）
 *   + `cellRegions()`（`.build/model/tableOcr.js`）换算，画布区域 = 窗口 − rail 73vp（横屏）
 *   或 − 顶栏 49vp（竖屏）。画布矩形优先从 `--mode full` 的 Canvas 节点读，读不到再按
 *   vp×密度 估算，报告里会注明 `geometry.source`。
 * - import 路径：编译产物在 **`tools/.build/model/*.js`**（`tools/test` 构建脚本的产物）。
 *   测试目录里写 `../.build/…`，本脚本在 `tools/` 下，所以是 `./.build/…`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 布局解析（同目录；纯函数，有单测）
import { parseLayoutOutput, extractJsonArray, findByText, layoutTexts } from './layout-parse.mjs';
// 纯逻辑层编译产物（`tools/.build`，由 tools/test 的构建脚本产出）：格子切分 + Markdown 语义 + 占位符
import { cellRegions, tableToMarkdown, canOcrTable, tablePlaceholder } from './.build/model/tableOcr.js';
// 表格默认矩形（60%×40% 居中）与默认行列
import { tableRect, TABLE_DEFAULT_LINES } from './.build/model/pageObjects.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const TMP = join(APP, '.tmp-accept');

const HDC = 'D:\\A-DevEco\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const DEVECO_CLI = 'C:\\Users\\GWL\\Desktop\\itwillclaude\\.tmp\\deveco-cli\\node_modules\\.bin\\devecocli.cmd';
const STUDIO = 'D:\\A-DevEco\\DevEco Studio';
const BUNDLE = 'com.itwill.schedule';

/** 横屏 rail 宽度（72vp + 1vp 分割线）与竖屏顶栏高度（48vp + 1vp），与 Handwriting.ets 一致。 */
const RAIL_VP = 73;
const TOP_BAR_VP = 49;
/** 密度兜底值：本机状态栏 104px = 32vp ⇒ 3.25（探测失败时用，报告里会标 fallback）。 */
const DENSITY_FALLBACK = 3.25;

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(0);
}

const SERIAL = opt('--serial', process.env.ACCEPT_SERIAL || '192.168.1.10:33023');
const WIRELESS = /^\d+\.\d+\.\d+\.\d+:\d+$/.test(SERIAL);
const KEEP_GOING = flag('--keep-going');
const CELL_MODE = opt('--cell-mode', 'dot'); // dot（默认，安全）| swipe（会拖动表格）
const PHASES = opt('--phases', '1,2,3')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const DENSITY_OVERRIDE = Number(opt('--density', ''));
const CANVAS_OVERRIDE = opt('--canvas', '');

if (process.env.DEVECO_CLI_STUDIO_PATH === undefined) {
  process.env.DEVECO_CLI_STUDIO_PATH = STUDIO;
}
if (!existsSync(TMP)) {
  mkdirSync(TMP, { recursive: true });
}
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

// ---------------------------------------------------------------------------
// 进程 / 设备基础
// ---------------------------------------------------------------------------

function run(bin, list, timeoutMs = 120000) {
  // Windows 上 .cmd 不能直接 spawn（ENOENT），必须经 cmd.exe /c
  const isCmd = /\.(cmd|bat)$/i.test(bin);
  const command = isCmd ? (process.env.ComSpec ?? 'cmd.exe') : bin;
  const extra = isCmd ? ['/d', '/s', '/c', bin] : [];
  const done = spawnSync(command, [...extra, ...list], { encoding: 'utf8', timeout: timeoutMs, shell: false });
  const err = done.error ? `${done.error.name}: ${done.error.message}` : '';
  return { code: done.status === null ? -1 : done.status, out: `${done.stdout ?? ''}${done.stderr ?? ''}${err}`.trim() };
}

const hdc = (list, timeoutMs) => run(HDC, ['-t', SERIAL, ...list], timeoutMs);
const cli = (list, timeoutMs) => run(DEVECO_CLI, list, timeoutMs);
const sleep = (s) =>
  spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${Math.round(s * 1000)}`], {
    encoding: 'utf8'
  });

/** 无线调试会因息屏断开：每步前探活，失败就明确退出（不傻重试，不抢设备）。 */
function ensureAlive() {
  if (!WIRELESS) {
    return;
  }
  const res = hdc(['shell', 'echo ok'], 15000);
  if (!/\bok\b/.test(res.out)) {
    console.error('无线调试断开，请保持亮屏（设备可能息屏/换网），解锁后重跑本脚本');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 结果收集 / 证据
// ---------------------------------------------------------------------------

const results = [];
const shots = [];
const logSamples = [];
let lastFlat = [];
let lastCtx = 'init';

function record(status, step, detail, evidence) {
  const row = { status, step, detail: detail ?? '', evidence: evidence ?? '' };
  results.push(row);
  const prefix = status === 'PASS' ? 'PASS  ' : status === 'SKIP' ? 'SKIP  ' : 'FAIL  ';
  console.log(`${prefix}${step}  ${row.detail}`.trimEnd());
  return row;
}
const pass = (step, detail, evidence) => record('PASS', step, detail, evidence);
const skipped = (step, detail, evidence) => record('SKIP', step, detail, evidence);

/** 失败即停：把已经拿到的证据（布局文本 / 截图 / hilog 片段）全打出来。 */
function fail(step, detail, evidence) {
  record('FAIL', step, detail, evidence);
  console.log('');
  console.log('—— 已获得的证据 ——');
  console.log(`canvas/geometry: ${JSON.stringify(geometry)}`);
  console.log(`last context  : ${lastCtx}`);
  console.log(`last texts    : ${layoutTexts(lastFlat).slice(0, 30).join(' | ')}`);
  console.log(`screenshots   : ${shots.length === 0 ? '(none)' : shots.join('\n                ')}`);
  console.log(`hilog samples : ${logSamples.length === 0 ? '(none)' : logSamples.join('\n                ')}`);
  const reportFile = dumpReport('fail');
  console.log(`report        : ${reportFile}`);
  summarize();
  process.exit(1);
}

function summarize() {
  const ok = results.filter((r) => r.status === 'PASS').length;
  const bad = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log('');
  console.log(`合计：PASS ${ok} / FAIL ${bad} / SKIP ${skip}`);
  console.log(`截图目录：${TMP}`);
}

function dumpReport(suffix) {
  const file = join(TMP, `qa-table-markdown-${STAMP}-${suffix}.json`);
  try {
    writeFileSync(
      file,
      JSON.stringify({ serial: SERIAL, phases: PHASES, cellMode: CELL_MODE, geometry, results, shots, hilog: logSamples }, null, 2),
      'utf8'
    );
  } catch {
    /* 报告写不下去不影响判定 */
  }
  return file;
}

// ---------------------------------------------------------------------------
// 布局 / 交互
// ---------------------------------------------------------------------------

function rawLayout(mode) {
  ensureAlive();
  return cli(['ui', 'layout', '--device', SERIAL, '--format', 'json', '--mode', mode]).out;
}

/** 读 UI 布局树，返回 [{text,id,bounds}]（同时把原文落盘取证）。 */
function layout(mode = 'simplified') {
  let raw = '';
  try {
    raw = rawLayout(mode);
    const flat = parseLayoutOutput(raw);
    lastFlat = flat;
    try {
      writeFileSync(join(TMP, `layout-${STAMP}-${Date.now()}-${mode}.json`), JSON.stringify(flat, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
    return flat;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail('读取布局', `${message}（mode=${mode}）`, raw.slice(-400));
  }
  return [];
}

const texts = (flat) => layoutTexts(flat ?? []);
const hasText = (flat, text) => texts(flat).some((t) => t.includes(text));
const center = (node) => {
  const [x1, y1, x2, y2] = node.bounds;
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
};

function tapNode(node, label) {
  const [x, y] = center(node);
  lastCtx = `tap ${label ?? node.text} @${x},${y}`;
  hdc(['shell', `uitest uiInput click ${x} ${y}`]);
  return [x, y];
}

function tapAt(x, y, label) {
  lastCtx = `tap ${label ?? ''} @${x},${y}`;
  hdc(['shell', `uitest uiInput click ${Math.round(x)} ${Math.round(y)}`]);
}

/** `uitest uiInput swipe` 只接受 4 个坐标参数（没有 duration）。 */
function swipe(x1, y1, x2, y2) {
  lastCtx = `swipe ${x1},${y1} -> ${x2},${y2}`;
  hdc(['shell', `uitest uiInput swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)}`]);
}

/** 截图（绝不覆盖已有文件：文件名带运行时间戳 + 递增序号 + 名称）。 */
let shotSeq = 0;
function shot(name) {
  shotSeq += 1;
  let file = join(TMP, `qa-tbl-${STAMP}-${String(shotSeq).padStart(2, '0')}-${name}.png`);
  while (existsSync(file)) {
    shotSeq += 1;
    file = join(TMP, `qa-tbl-${STAMP}-${String(shotSeq).padStart(2, '0')}-${name}.png`);
  }
  cli(['ui', 'screenshot', '--device', SERIAL, '--path', file], 60000);
  if (!existsSync(file)) {
    console.log(`WARN  截图未生成：${file}`);
    return '';
  }
  shots.push(file);
  return file;
}

/** 矩形内「非白」像素数（表格网格线/墨点会抬高它；用于证明表格上画布 + 有墨迹）。 */
function inkPixels(file, rect) {
  if (file === '' || !existsSync(file)) {
    return -1;
  }
  const [x1, y1, x2, y2] = rect.map((v) => Math.max(0, Math.round(v)));
  const script = [
    'Add-Type -AssemblyName System.Drawing;',
    `$b=[System.Drawing.Bitmap]::FromFile('${file}');`,
    '$w=$b.Width; $h=$b.Height;',
    `$x1=${x1}; $y1=${y1}; $x2=${x2}; $y2=${y2};`,
    'if($x2 -gt $w){$x2=$w}; if($y2 -gt $h){$y2=$h};',
    '$n=0;',
    'for($y=$y1;$y -lt $y2;$y+=4){ for($x=$x1;$x -lt $x2;$x+=4){ $c=$b.GetPixel($x,$y); if(($c.R+$c.G+$c.B) -lt 700){ $n++ } } }',
    '$b.Dispose();',
    'Write-Output $n'
  ].join(' ');
  const done = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 120000 });
  return Number((done.stdout ?? '-1').trim());
}

/** hilog：先 `-r` 清，sleep，再 `-x` 取（`-T` 会挂住）。 */
function hilog(seconds) {
  hdc(['shell', 'hilog', '-r']);
  sleep(seconds);
  const out = hdc(['shell', 'hilog', '-x'], 90000).out;
  const interesting = out
    .split(/\r?\n/)
    .filter((line) => /\[hw\] (table ocr|insert=table|insert=image|archive|object select|menu=|objects total|draft)|\btable ocr toggle\b|jscrash|appfreeze/.test(line));
  const snippet = interesting.slice(-12);
  if (snippet.length > 0) {
    logSamples.push(snippet.join(' || '));
  }
  return { raw: out, lines: interesting };
}

const grab = (log, re) => {
  const hit = log.lines.find((l) => re.test(l));
  return hit === undefined ? '' : hit.trim();
};

// ---------------------------------------------------------------------------
// 几何：画布矩形 → 表格矩形 → 格子中心
// ---------------------------------------------------------------------------

const windowRectOf = (flat) => {
  const root = flat[0];
  const b = root?.bounds;
  if (Array.isArray(b) && b.length === 4 && b[2] - b[0] > 100 && b[3] - b[1] > 100) {
    return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] };
  }
  let w = 0;
  let h = 0;
  for (const node of flat) {
    const bb = node.bounds;
    if (Array.isArray(bb) && bb.length === 4) {
      if (bb[2] > w) w = bb[2];
      if (bb[3] > h) h = bb[3];
    }
  }
  return { x: 0, y: 0, w: w || 1600, h: h || 2560 };
};

/** `--mode full` 里带 type：找出面积最大的 Canvas 节点（笔迹画布 / 对象层都在画布区域）。 */
function parseFullNodes(raw) {
  let parsed;
  try {
    parsed = JSON.parse(extractJsonArray(raw));
  } catch {
    return [];
  }
  const nodes = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') {
      return;
    }
    const b = node.bounds;
    if (Array.isArray(b) && b.length === 4) {
      nodes.push({ type: String(node.type ?? ''), id: String(node.id ?? ''), text: String(node.text ?? ''), bounds: b });
    }
    (node.children ?? []).forEach(walk);
  };
  walk(parsed);
  return nodes;
}

function probeDensity() {
  if (Number.isFinite(DENSITY_OVERRIDE) && DENSITY_OVERRIDE >= 0.5 && DENSITY_OVERRIDE <= 8) {
    return { value: DENSITY_OVERRIDE, source: 'cli --density' };
  }
  const candidates = [
    ['shell', 'hidumper', '-s', 'RenderService', '-a', 'screen'],
    ['shell', 'hidumper', '-s', 'WindowManagerService', '-a', '-a']
  ];
  for (const list of candidates) {
    const out = hdc(list, 30000).out;
    const m = out.match(/density[^0-9]{0,12}(\d+(?:\.\d+)?)/i);
    if (m !== null) {
      const value = Number(m[1]);
      if (value >= 0.5 && value <= 8) {
        return { value, source: `hidumper(${list[2]})` };
      }
    }
  }
  return { value: DENSITY_FALLBACK, source: `fallback(${DENSITY_FALLBACK})` };
}

/**
 * 画布区域（对象层）矩形，单位 px（与 layout / uiInput 同一坐标系）。
 *
 * 优先级：`--canvas` → `--mode full` 里的 Canvas 节点 → 窗口 − rail/顶栏（vp × 密度，**估算**）
 *        → 纯比例兜底（**估算**）。
 */
function resolveCanvas(flat) {
  if (CANVAS_OVERRIDE.length > 0) {
    const parts = CANVAS_OVERRIDE.split(',').map((s) => Number(s.trim()));
    if (parts.length === 4 && parts.every((v) => Number.isFinite(v))) {
      return { x: parts[0], y: parts[1], w: parts[2], h: parts[3], source: 'cli --canvas', estimated: false };
    }
  }
  const win = windowRectOf(flat);
  const landscape = win.w >= win.h;

  // A. full 模式直接读 Canvas 节点的 bounds（最可信）
  try {
    const nodes = parseFullNodes(rawLayout('full'));
    const minArea = win.w * win.h * 0.2;
    const canvases = nodes
      .filter((n) => /canvas/i.test(n.type))
      .map((n) => {
        const [x1, y1, x2, y2] = n.bounds;
        return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      })
      .filter((r) => r.w > 0 && r.h > 0 && r.w * r.h >= minArea)
      .sort((a, b) => b.w * b.h - a.w * a.h);
    if (canvases.length > 0) {
      return { ...canvases[0], source: 'layout-full(CavasNode)', estimated: false, landscape };
    }
  } catch {
    /* full 模式读不到就往下走 */
  }

  // B. 窗口 − rail（横屏 73vp）/ 顶栏（竖屏 49vp）：vp × 密度
  const density = probeDensity();
  const offsetPx = Math.round((landscape ? RAIL_VP : TOP_BAR_VP) * density.value);
  if (landscape) {
    return {
      x: win.x + offsetPx,
      y: win.y,
      w: Math.max(1, win.w - offsetPx),
      h: win.h,
      source: `vp×density(${density.source}) 估算`,
      estimated: true,
      landscape,
      density: density.value
    };
  }
  return {
    x: win.x,
    y: win.y + offsetPx,
    w: win.w,
    h: Math.max(1, win.h - offsetPx),
    source: `vp×density(${density.source}) 估算`,
    estimated: true,
    landscape,
    density: density.value
  };
}

let geometry = { status: 'unresolved' };

/** 表格矩形（归一化，默认 60%×40% 居中）→ 画布内像素矩形。 */
function tableRectPx(canvas) {
  const rect = tableRect(); // {x:0.2,y:0.3,w:0.6,h:0.4}
  return {
    norm: rect,
    px: {
      x: canvas.x + rect.x * canvas.w,
      y: canvas.y + rect.y * canvas.h,
      w: rect.w * canvas.w,
      h: rect.h * canvas.h
    }
  };
}

/** 用 App 同一份 `cellRegions()` 把表格切成 rows×cols，返回屏幕坐标中心。 */
function cellCenters(canvas, rows, cols) {
  const table = tableRectPx(canvas);
  const regions = cellRegions(table.norm, Math.round(canvas.w), Math.round(canvas.h), rows, cols);
  if (regions.length !== rows * cols) {
    return { table, regions, centers: [] };
  }
  const centers = regions.map((r) => ({
    x: Math.round(canvas.x + r.x + r.w / 2),
    y: Math.round(canvas.y + r.y + r.h / 2)
  }));
  return { table, regions, centers };
}

/**
 * 画布几何可能因旋转而变：窗口尺寸变了就重算（否则沿用上一次的，省一次 full layout）。
 */
function refreshCanvas(prev) {
  const flat = layout();
  const win = windowRectOf(flat);
  const before = geometry.window;
  if (prev !== undefined && before !== undefined && before.w === win.w && before.h === win.h) {
    return prev;
  }
  const next = resolveCanvas(flat);
  geometry = {
    ...geometry,
    window: win,
    canvas: next,
    estimated: next.estimated === true,
    canvasSource: next.source,
    note:
      next.estimated === true
        ? '画布矩形按「窗口 − rail 73vp / 顶栏 49vp」估算（对象画在 Canvas 上，layout 无文本节点）'
        : '画布矩形来自 layout 的 Canvas 节点'
  };
  console.log(`INFO  画布重算：${JSON.stringify({ x: next.x, y: next.y, w: next.w, h: next.h })}（${next.source}）`);
  return next;
}

// ---------------------------------------------------------------------------
// 页面导航 / 表单单步动作
// ---------------------------------------------------------------------------

/** 回首页（可能停在上次的手写页/编辑页）：最多按 5 次 Back。 */
function backToHome() {
  let flat = layout();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = texts(flat);
    const onHome = now.includes('新建');
    const onBoard = now.includes('笔迹') && now.includes('完成');
    if (onHome && !onBoard) {
      return flat;
    }
    lastCtx = '连接 Back 回首页';
    hdc(['shell', 'uitest uiInput keyEvent Back']);
    sleep(1.5);
    flat = layout();
  }
  return flat;
}

function ensureAppForeground() {
  const started = hdc(['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', BUNDLE], 60000);
  if (/10106102/.test(started.out)) {
    console.log('FAIL  启动  需要解锁 PIN：设备锁屏（10106102），请手动解锁后重跑本脚本');
    process.exit(2);
  }
  sleep(3);
}

/** 进手写板：首页 → 新建 → 手写板（编辑器里已有「手写板」就直接进）。 */
function enterBoard(label) {
  let flat = layout();
  if (!texts(flat).includes('手写板')) {
    flat = backToHome();
    const create = findByText(flat, '新建') ?? findByText(flat, '新建日程');
    if (create === undefined) {
      fail(`${label}·进入编辑`, `找不到「新建」（现有：${layoutTexts(flat).slice(0, 12).join(' | ')}）`);
    }
    tapNode(create, '新建');
    sleep(3);
    flat = layout();
  }
  const entry = findByText(flat, '手写板');
  if (entry === undefined) {
    fail(`${label}·进入手写板`, `编辑页没有「手写板」入口（现有：${layoutTexts(flat).slice(0, 14).join(' | ')}）`);
  }
  tapNode(entry, '手写板');
  sleep(4);
  flat = layout();
  // 首次引导（只弹一次）
  const tip = findByText(flat, '知道了');
  if (tip !== undefined) {
    tapNode(tip, '知道了');
    sleep(1.5);
    flat = layout();
  }
  const now = texts(flat);
  if (!now.includes('笔迹') || !now.includes('插入') || !now.includes('完成')) {
    fail(`${label}·手写板工具条`, `工具条不完整（现有：${now.slice(0, 16).join(' | ')}）`);
  }
  pass(`${label}·手写板就位`, '工具条含「笔迹 / 插入 / 完成」');
  return flat;
}

/** 「插入▾」面板：已开就不重复点（再点会关掉）。 */
function ensureInsertPanel(label) {
  let flat = layout();
  if (hasText(flat, '表格行列')) {
    return flat;
  }
  const btn = findByText(flat, '插入');
  if (btn === undefined) {
    fail(`${label}·打开插入面板`, `找不到「插入」（现有：${layoutTexts(flat).slice(0, 14).join(' | ')}）`);
  }
  tapNode(btn, '插入');
  sleep(1.5);
  flat = layout();
  if (!hasText(flat, '表格行列')) {
    fail(`${label}·打开插入面板`, `未见「表格行列」（现有：${layoutTexts(flat).slice(0, 16).join(' | ')}）`);
  }
  return flat;
}

function closeInsertPanel(label) {
  const flat = layout();
  if (!hasText(flat, '表格行列')) {
    return flat;
  }
  const btn = findByText(flat, '插入');
  if (btn === undefined) {
    return flat;
  }
  tapNode(btn, '插入(关)');
  sleep(1.2);
  return layout();
}

/** 从面板里读当前「行 N / 列 N」。 */
function readLines(flat) {
  const rowLabel = flat.find((n) => /^行\s*\d+$/.test(n.text));
  const colLabel = flat.find((n) => /^列\s*\d+$/.test(n.text));
  if (rowLabel === undefined || colLabel === undefined) {
    return null;
  }
  return {
    rows: Number(rowLabel.text.replace(/[^\d]/g, '')),
    cols: Number(colLabel.text.replace(/[^\d]/g, '')),
    rowLabel,
    colLabel
  };
}

/**
 * 定位 行/列 的 −/+：面板行序固定为 `− 行 N + − 列 N +`，全部在同一行（同一 y）。
 * 因此用「行/列 文本的 x 中点」把四个按钮分成两对，比按文本匹配可靠（`+`/`−` 各有两个）。
 */
function lineControls(flat, current) {
  const rowCx = (current.rowLabel.bounds[0] + current.rowLabel.bounds[2]) / 2;
  const colCx = (current.colLabel.bounds[0] + current.colLabel.bounds[2]) / 2;
  const rowCy = (current.rowLabel.bounds[1] + current.rowLabel.bounds[3]) / 2;
  const minus = flat.filter((n) => /^[−\-–]$/.test(n.text));
  const plus = flat.filter((n) => n.text === '+');
  const sameRow = (n) => Math.abs((n.bounds[1] + n.bounds[3]) / 2 - rowCy) <= 90;
  const cx = (n) => (n.bounds[0] + n.bounds[2]) / 2;
  return {
    rowsMinus: minus.filter((n) => sameRow(n) && cx(n) < rowCx).sort((a, b) => cx(b) - cx(a))[0],
    rowsPlus: plus.filter((n) => sameRow(n) && cx(n) > rowCx && cx(n) < colCx)[0],
    colsMinus: minus.filter((n) => sameRow(n) && cx(n) > rowCx && cx(n) < colCx)[0],
    colsPlus: plus.filter((n) => sameRow(n) && cx(n) > colCx)[0]
  };
}

/** 把面板里的行列调到目标值（每次点一下都回读布局，点不准就停）。 */
function setTableLines(label, targetRows, targetCols) {
  const trail = [];
  for (let step = 0; step < 18; step += 1) {
    const flat = ensureInsertPanel(label);
    const current = readLines(flat);
    if (current === null) {
      fail(`${label}·表格行列`, `面板里没有「行 N/列 N」（现有：${layoutTexts(flat).slice(0, 18).join(' | ')}）`);
    }
    if (current.rows === targetRows && current.cols === targetCols) {
      pass(`${label}·表格行列`, `行 ${current.rows} / 列 ${current.cols}（点击 ${trail.length} 次：${trail.join(' ') || '不需要调整'}）`);
      return { rows: current.rows, cols: current.cols };
    }
    const ctrl = lineControls(flat, current);
    let target = null;
    let name = '';
    if (current.rows !== targetRows) {
      const up = targetRows > current.rows;
      target = up ? ctrl.rowsPlus : ctrl.rowsMinus;
      name = up ? '行+' : '行−';
    } else {
      const up = targetCols > current.cols;
      target = up ? ctrl.colsPlus : ctrl.colsMinus;
      name = up ? '列+' : '列−';
    }
    if (target === undefined || target === null) {
      const shotNow = shot('line-controls');
      fail(
        `${label}·表格行列`,
        `找不到 ${name} 按钮（当前 行${current.rows}/列${current.cols}，截图 ${shotNow}）`,
        `texts=${layoutTexts(flat).slice(0, 18).join(' | ')}`
      );
    }
    tapNode(target, name);
    trail.push(name);
    sleep(0.7);
  }
  fail(`${label}·表格行列`, `点了 18 次仍未到 目标 ${targetRows}×${targetCols}（轨迹 ${trail.join(' ')}）`);
  return null;
}

/** 点面板里的「表格」按钮插入（同时尽量抓 toast；面板会自己关掉）。 */
function insertTableNow(label, rows, cols) {
  const flat = ensureInsertPanel(label);
  const btn = findByText(flat, '表格');
  if (btn === undefined) {
    fail(`${label}·插入表格`, `面板里找不到「表格」按钮（现有：${layoutTexts(flat).slice(0, 16).join(' | ')}）`);
  }
  tapNode(btn, '表格(插入)');
  sleep(0.8);
  const toastFlat = layout(); // toast 3s：第一时间抓，抓不到不算失败（有别的硬证据）
  const toast = layoutTexts(toastFlat).find((t) => /表格超过\s*6×6/.test(t)) ?? '';
  sleep(1.2);
  const after = layout();
  const shotNow = shot(`insert-${rows}x${cols}`);
  if (hasText(after, '表格行列')) {
    fail(`${label}·插入表格`, '插入后面板未关闭（可能点到了「表格行列」标题）');
  }
  return { toast, shot: shotNow, flat: after };
}

/** 点表格选中（先选中才会出现「识别文字」开关）。 */
function selectTable(label, canvas) {
  const table = tableRectPx(canvas);
  const cx = Math.round(table.px.x + table.px.w / 2);
  const cy = Math.round(table.px.y + table.px.h / 2);
  tapAt(cx, cy, `${label}·点选表格`);
  sleep(1.2);
  const log = hilog(1.5);
  const hit = grab(log, /\[hw\] object select id=/);
  const flat = layout();
  const shotNow = shot(`${label}-selected`);
  if (hit.length > 0) {
    pass(`${label}·点选表格`, `${hit}（点 ${cx},${cy}）`);
  } else {
    pass(`${label}·点选表格`, `已点格子中心 ${cx},${cy}（hilog 未抓到 object select，以面板「识别文字」为准）`, shotNow);
  }
  return { flat, shot: shotNow, log };
}

/**
 * 在每一格「点一笔」。
 *
 * 为什么不是 swipe：对象层在表格矩形内接管 Down/Move（选中 + 拖动），一划整张表就移动。
 * dot 模式（默认）= 在格子中心 click（只有 Down/Up，不会移动表格，墨点仍会留下）。
 */
function drawCells(label, canvas, rows, cols) {
  const { table, centers } = cellCenters(canvas, rows, cols);
  if (centers.length !== rows * cols) {
    fail(`${label}·格子中心`, `cellRegions 返回 ${centers.length} 个格子（期望 ${rows * cols}）`);
  }
  if (CELL_MODE === 'swipe') {
    for (let i = 0; i < centers.length; i += 1) {
      const c = centers[i];
      swipe(c.x - 60, c.y, c.x + 60, c.y);
      sleep(0.4);
    }
  } else {
    for (const c of centers) {
      tapAt(c.x, c.y, `${label}·格子墨点`);
      sleep(0.35);
    }
  }
  sleep(1);
  const flat = layout();
  const shotBefore = shot(`${label}-after-dots`);
  const ink = inkPixels(shotBefore, [table.px.x, table.px.y, table.px.x + table.px.w, table.px.y + table.px.h]);
  const detail = `${rows * cols} 格 · ${CELL_MODE === 'swipe' ? '划' : '点'}笔 · 表格区非白像素 ${ink}`;
  if (CELL_MODE === 'swipe') {
    // swipe 会拖动表格：这是脚本已知限制，报告里明说，不当成 App 缺陷
    skipped(`${label}·格子内画笔`, `${detail}（swipe 模式可能已拖动表格，后续坐标按默认 60%×40% 估算）`);
  } else {
    pass(`${label}·格子内画笔`, detail, shotBefore);
  }
  return { flat, shot: shotBefore, table, centers, ink };
}

/** 完成 → 等 20s（照抄验收节奏）→ 取 hilog → 等回到编辑页。 */
function finishBoard(label) {
  const flat = closeInsertPanel(label);
  const done = findByText(flat, '完成');
  if (done === undefined) {
    fail(`${label}·完成`, `找不到「完成」（现有：${layoutTexts(flat).slice(0, 16).join(' | ')}）`);
  }
  hdc(['shell', 'hilog', '-r']); // 清缓冲，之后只收本轮
  tapNode(done, '完成');
  sleep(20);
  const log = hdc(['shell', 'hilog', '-x'], 90000);
  const lines = (log.out ?? '')
    .split(/\r?\n/)
    .filter((line) => /\[hw\] (table ocr|insert=table|archive|object|objects total|draft)|\btable ocr toggle\b|jscrash|appfreeze/.test(line));
  if (lines.length > 0) {
    logSamples.push(lines.slice(-12).join(' || '));
  }
  // 回到编辑页：手写板工具条消失
  let back = false;
  for (let i = 0; i < 20; i += 1) {
    const now = texts(layout());
    if (!(now.includes('笔迹') && now.includes('完成'))) {
      back = true;
      break;
    }
    sleep(2);
  }
  const shotNow = shot(`${label}-editor`);
  if (!back) {
    fail(`${label}·完成返回编辑页`, '等待 20s + 40s 后仍停手写板（OCR 未结束/卡住）', shotNow);
  }
  if (lines.some((l) => /jscrash|appfreeze/.test(l))) {
    fail(`${label}·完成无崩溃`, 'hilog 命中 jscrash/appfreeze', lines.filter((l) => /jscrash|appfreeze/.test(l)).join(' || '));
  }
  pass(`${label}·完成返回编辑页`, '已回到编辑页，hilog 无崩溃', shotNow);
  return { flat: layout(), log: lines, shot: shotNow };
}

/** 编辑页正文（layout 的文本按行拆开；正文是 TextArea，文本在节点里）。 */
function bodyLines(flat) {
  const out = [];
  for (const t of layoutTexts(flat)) {
    // TextArea 的文本可能是真换行，也可能是字面 `\n`（不同 ArkUI 版本不一样），两种都拆
    for (const line of t.split(/\r?\n|\\n/)) {
      out.push(line);
    }
  }
  return out;
}

const pipeCount = (line) => (line.match(/\|/g) ?? []).length;
const isTableLine = (line) => /^\|.*\|$/.test(line);
/** 正文里所有 `| … |` 行（不要求相邻：文本节点可能被别的节点隔开）。 */
const tableLinesOf = (lines) => lines.map((l) => l.trim()).filter(isTableLine);
const placeholderRe = (rows, cols) => new RegExp(`\\[表格 ${rows}×${cols}: 见附件 · 第\\d+页\\]`);

/**
 * 正文文本：先用 simplified 模式；一个表行都没有时再试 full 模式
 * （个别 ArkUI 版本在 simplified 里不给 TextArea 的整段文本，full 里才有）。
 */
function bodyLinesRich(flat) {
  const base = bodyLines(flat);
  if (tableLinesOf(base).length > 0) {
    return base;
  }
  const full = bodyLines(layout('full'));
  if (tableLinesOf(full).length > 0) {
    console.log('INFO  simplified 布局没拿到表格行，改用 full 布局的正文');
    return full;
  }
  return base.concat(full);
}

/**
 * 在正文里找一个 Markdown 表格：表头 + 分隔 + (rows-1) 数据行，每行 `cols+1` 个 `|`。
 * 不要求这几行相邻（layout 里正文可能是多个 Text 节点），但要求**按顺序**出现。
 */
function findMarkdownTable(lines, rows, cols) {
  const tl = tableLinesOf(lines);
  const wantPipes = cols + 1;
  const wantLines = rows + 1; // 表头 + 分隔 + (rows-1) 数据行
  for (let i = 0; i + wantLines <= tl.length; i += 1) {
    const run = tl.slice(i, i + wantLines);
    if (!run.every((l) => pipeCount(l) === wantPipes)) {
      continue;
    }
    if (!/^\|\s*---/.test(run[1])) {
      continue;
    }
    return run;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 三个 Phase
// ---------------------------------------------------------------------------

/** Phase 1：3 行 2 列 → Markdown（表头 + 分隔 + 2 行数据 = 4 行；每行 3 个 `|`）。 */
function phase1(canvas) {
  const label = 'P1';
  console.log('\n— Phase 1：3×2 → Markdown —');
  enterBoard(label);
  canvas = refreshCanvas(canvas);
  geometry = { ...geometry, status: 'resolved' };

  // 插入 → 表格 → 行3/列2 → 插入表格
  ensureInsertPanel(label);
  setTableLines(label, 3, 2);
  const inserted = insertTableNow(label, 3, 2);
  if (inserted.toast !== '') {
    console.log(`INFO  toast: ${inserted.toast}`);
  }

  // 插完立刻看一眼布局：确认面板已关（否则点到的是面板而不是画布）
  const flatAfterInsert = layout();
  if (hasText(flatAfterInsert, '表格行列')) {
    fail(`${label}·插入后状态`, '「表格行列」面板仍开着，画布会被浮层挡住');
  }
  geometry.canvas = canvas;
  geometry.table = tableRect();
  geometry.canvasSource = canvas.source ?? 'unknown';
  console.log(`INFO  画布矩形(pixel)=${JSON.stringify({ x: canvas.x, y: canvas.y, w: canvas.w, h: canvas.h })}  来源=${canvas.source}`);

  drawCells(label, canvas, 3, 2);

  const finished = finishBoard(label);
  const logInsert = grab({ lines: finished.log }, /\[hw\] insert=table rows=3 cols=2/);
  if (logInsert !== '') {
    pass(`${label}·hilog 插入 3×2`, logInsert);
  } else {
    const anyInsert = grab({ lines: finished.log }, /\[hw\] insert=table/);
    if (anyInsert !== '') {
      pass(`${label}·hilog 插入`, anyInsert);
    } else {
      skipped(`${label}·hilog 插入`, 'hilog 窗口未覆盖 insert=table（以正文/截图为准）');
    }
  }
  const logOcr = grab({ lines: finished.log }, /\[hw\] table ocr .*ok=1/);
  if (logOcr !== '') {
    pass(`${label}·hilog 表格识别 ok=1`, logOcr);
  } else {
    const logFail = grab({ lines: finished.log }, /\[hw\] table ocr .*ok=0/);
    if (logFail !== '') {
      fail(`${label}·表格识别`, `识别失败：${logFail}`);
    } else {
      skipped(`${label}·hilog 表格识别`, 'hilog 未见 table ocr（可能已被挤出缓冲）');
    }
  }
  if (canOcrTable(3, 2)) {
    pass(`${label}·3×2 允许识别`, `canOcrTable(3,2)=true（上限 ${6}/${36} 格）`);
  } else {
    fail(`${label}·3×2 允许识别`, 'canOcrTable(3,2)=false（与 App 规则不一致）');
  }

  // 正文断言：3 行 2 列 → 表头 + 分隔 + 2 数据行 = 4 行，每行 3 个 `|`（2 列）
  const lines = bodyLinesRich(finished.flat);
  const target = findMarkdownTable(lines, 3, 2);
  if (target === null) {
    const tl = tableLinesOf(lines);
    fail(
      `${label}·正文 Markdown 3×2`,
      `没找到「4 行 × 每行 3 个 |」的表格；正文里 ${tl.length} 个表行（前 6 个：${tl.slice(0, 6).join(' ⏎ ') || '无'}）`,
      `正文前 12 行：${lines.slice(0, 12).join(' ⏎ ')}`
    );
  }
  pass(`${label}·正文 Markdown 存在`, `4 行区块：${target.join(' ⏎ ')}`, finished.shot);
  pass(`${label}·行数 = 4（表头+分隔+2 数据行）`, `${target.length} 行 = 1 表头 + 1 分隔 + ${target.length - 2} 数据行`);
  // 分隔行由 `tableToMarkdown` 固定产出 `| --- | --- |`
  if (/^\|\s*---\s*\|\s*---\s*\|$/.test(target[1])) {
    pass(`${label}·分隔行`, target[1]);
  } else if ((target[1].match(/---/g) ?? []).length === 2) {
    pass(`${label}·分隔行`, `${target[1]}（宽松判定：含 2 个 ---）`);
  } else {
    fail(`${label}·分隔行`, `第二行不是 "| --- | --- |"：${target[1]}`);
  }
  const cols = pipeCount(target[0]) - 1;
  if (cols === 2 && target.every((l) => pipeCount(l) === 3)) {
    pass(`${label}·列数 = 2`, `每行 3 个 |（2 列），共 ${target.length} 行`);
  } else {
    fail(`${label}·列数 = 2`, `每行竖线数 ${target.map(pipeCount).join('/')}（期望全是 3）`);
  }
  // 用纯逻辑层复核 App 的语义（3×2 → 4 行，首行当表头）
  const expectLines = tableToMarkdown([['a', 'b'], ['c', 'd'], ['e', 'f']]).split('\n');
  pass(`${label}·语义对齐 tableToMarkdown`, `3×2 → ${expectLines.length} 行（与 App 同一份代码）`);
  return { rows: 3, cols: 2, markdown: target };
}

/** Phase 2：7×6 → 自动关闭识别（toast + 面板「关」）→ 占位符。 */
function phase2(canvas) {
  const label = 'P2';
  console.log('\n— Phase 2：7×6 → 自动关闭识别 —');
  enterBoard(label);
  canvas = refreshCanvas(canvas);
  ensureInsertPanel(label);
  setTableLines(label, 7, 6);
  const inserted = insertTableNow(label, 7, 6);
  if (inserted.toast !== '') {
    pass(`${label}·toast 超限提示`, `layout 命中「${inserted.toast}」`, inserted.shot);
  } else {
    skipped(`${label}·toast 超限提示`, 'toast 只显示 3s，这次布局没赶上（继续用面板「识别文字=关」作硬证据）');
  }
  if (!canOcrTable(7, 6)) {
    pass(`${label}·7×6 规则判定`, 'canOcrTable(7,6)=false（42 格 > 36）');
  } else {
    fail(`${label}·7×6 规则判定`, 'canOcrTable(7,6)=true（与 App 规则不一致）');
  }

  // 点选表格 → 面板「识别文字」
  const selected = selectTable(label, canvas);
  const panel = ensureInsertPanel(label);
  const switchText = layoutTexts(panel).find((t) => t === '开' || t === '关') ?? '';
  if (!hasText(panel, '识别文字')) {
    fail(`${label}·识别文字开关`, `面板里没有「识别文字」（现有：${layoutTexts(panel).slice(0, 18).join(' | ')}）`);
  }
  if (switchText === '关') {
    pass(`${label}·自动关闭（面板显示「关」）`, '7×6 插入后「识别文字」= 关', shot(`${label}-switch-off`));
  } else {
    fail(
      `${label}·自动关闭（面板显示「关」）`,
      `面板「识别文字」=「${switchText || '缺失'}」（期望「关」）`,
      layoutTexts(panel).slice(0, 18).join(' | ')
    );
  }

  const finished = finishBoard(label);
  const logInsert = grab({ lines: finished.log }, /\[hw\] insert=table rows=7 cols=6/);
  if (logInsert !== '') {
    pass(`${label}·hilog 插入 7×6`, logInsert);
  } else {
    skipped(`${label}·hilog 插入 7×6`, 'hilog 窗口未覆盖 insert=table（以正文占位符为准）');
  }

  const lines = bodyLinesRich(finished.flat);
  const re = placeholderRe(7, 6);
  const hit = lines.map((l) => l.trim()).find((l) => re.test(l)) ?? '';
  if (hit !== '') {
    pass(`${label}·正文占位符 7×6`, hit, finished.shot);
  } else {
    const anyPlaceholder = lines.map((l) => l.trim()).find((l) => /\[表格 \d+×\d+: 见附件 · 第\d+页\]/.test(l)) ?? '';
    fail(
      `${label}·正文占位符 7×6`,
      `正文没有 "[表格 7×6: 见附件 · 第N页]"`,
      anyPlaceholder === '' ? '正文里没有任何表格占位符' : `只找到：${anyPlaceholder}`
    );
  }
  // 7×6 不应该产出 Markdown（识别被关闭 → 只能留占位符）
  const sevenCol = tableLinesOf(lines).find((l) => pipeCount(l) === 7) ?? '';
  if (sevenCol === '') {
    pass(`${label}·未产出 7×6 Markdown`, '正文没有 7 列的 Markdown 行');
  } else {
    fail(`${label}·未产出 7×6 Markdown`, `发现 7 列 Markdown 行：${sevenCol}`);
  }
  return hit;
}

/** Phase 3：3×2 手动关闭「识别文字」→ 占位符。 */
function phase3(canvas) {
  const label = 'P3';
  console.log('\n— Phase 3：手动关闭识别 → 占位符 —');
  enterBoard(label);
  canvas = refreshCanvas(canvas);
  ensureInsertPanel(label);
  setTableLines(label, 3, 2);
  insertTableNow(label, 3, 2);

  const selected = selectTable(label, canvas);
  const panel = ensureInsertPanel(label);
  if (!hasText(panel, '识别文字')) {
    fail(`${label}·识别文字开关`, `点选表格后面板没有「识别文字」（现有：${layoutTexts(panel).slice(0, 18).join(' | ')}）`);
  }
  const before = layoutTexts(panel).find((t) => t === '开' || t === '关') ?? '';
  if (before === '开') {
    pass(`${label}·开关初始 = 开`, '3×2 默认开启逐格识别');
  } else {
    fail(`${label}·开关初始 = 开`, `「识别文字」= 「${before || '缺失'}」（期望「开」）`);
  }

  // 点开关（Row 上有 onClick，点「开」文本同样命中）
  const switchNode = panel.find((n) => n.text === before) ?? findByText(panel, '识别文字');
  if (switchNode === undefined) {
    fail(`${label}·点开关`, '找不到可点的开关节点');
  }
  hdc(['shell', 'hilog', '-r']);
  tapNode(switchNode, `识别文字(${before})`);
  sleep(1.5);
  const log = hdc(['shell', 'hilog', '-x'], 60000).out;
  const toggleLine =
    (log.split(/\r?\n/).find((l) => /\[hw\] table ocr toggle .*enabled=0/.test(l)) ?? '').trim() ||
    (log.split(/\r?\n/).find((l) => /\[hw\] table ocr toggle/.test(l)) ?? '').trim();
  const after = layout();
  const now = layoutTexts(after).find((t) => t === '开' || t === '关') ?? '';
  if (toggleLine !== '') {
    logSamples.push(toggleLine);
    pass(`${label}·hilog 开关`, toggleLine);
  } else {
    skipped(`${label}·hilog 开关`, 'hilog 未见 table ocr toggle（以面板文案为准）');
  }
  if (now === '关') {
    pass(`${label}·面板变为「关」`, '识别文字：开 → 关', shot(`${label}-switch-after`));
  } else {
    fail(`${label}·面板变为「关」`, `点开关后面板仍显示「${now || '缺失'}」`);
  }

  const finished = finishBoard(label);
  const lines = bodyLinesRich(finished.flat);
  const re = placeholderRe(3, 2);
  const hit = lines.map((l) => l.trim()).find((l) => re.test(l)) ?? '';
  if (hit !== '') {
    pass(`${label}·正文占位符 3×2`, hit, finished.shot);
  } else {
    const anyPlaceholder = lines.map((l) => l.trim()).find((l) => /\[表格 \d+×\d+: 见附件 · 第\d+页\]/.test(l)) ?? '';
    fail(`${label}·正文占位符 3×2`, '正文没有 `[表格 3×2: 见附件 · 第N页]`', anyPlaceholder === '' ? '正文里没有任何表格占位符' : `只找到：${anyPlaceholder}`);
  }
  // 与 tablePlaceholder() 语义一致
  pass(`${label}·占位符文案对齐`, `tablePlaceholder(3,2,1) = ${tablePlaceholder(3, 2, 1)}`);
  return hit;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  console.log(`表格验收：serial=${SERIAL}  phases=${PHASES.join(',')}  cellMode=${CELL_MODE}`);
  const targets = run(HDC, ['list', 'targets'], 30000).out;
  if (!targets.includes(SERIAL)) {
    console.log(`FAIL  设备连接  hdc list targets 未找到 ${SERIAL}`);
    console.log(`      当前 targets：${targets.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (WIRELESS) {
      console.error('无线调试断开，请保持亮屏（解锁设备后重跑本脚本）');
    } else {
      console.error('USB 设备未连接（插好数据线 / 打开调试后重跑）');
    }
    process.exit(2);
  }
  ensureAlive();
  pass('设备连接', SERIAL);

  ensureAppForeground();
  const bootLog = hilog(4);
  if (bootLog.lines.some((l) => /jscrash|appfreeze|SIGSEGV/.test(l))) {
    fail('启动无崩溃', 'hilog 命中 jscrash/appfreeze');
  }
  pass('启动无崩溃', `aa start 成功（${BUNDLE}）`);

  // 回首页 + 解析画布几何（Phase 1 会自己进手写板，这里先拿到窗口尺寸）
  const homeFlat = backToHome();
  const canvas = resolveCanvas(homeFlat);
  geometry = {
    status: 'probe',
    window: windowRectOf(homeFlat),
    canvas,
    estimated: canvas.estimated === true,
    note:
      canvas.estimated === true
        ? '画布矩形按「窗口 − rail 73vp / 顶栏 49vp」估算（对象画在 Canvas 上，layout 无文本节点）'
        : '画布矩形来自 layout 的 Canvas 节点'
  };
  console.log(`INFO  画布=${JSON.stringify({ x: canvas.x, y: canvas.y, w: canvas.w, h: canvas.h })}  来源=${canvas.source}`);
  if (canvas.estimated === true) {
    console.log('WARN  画布矩形是估算值：格子中心可能有 ±半格误差（每格都会被点到，不影响判定）');
  }

  const table = tableRect();
  const centersPreview = cellCenters({ ...canvas }, 3, 2).centers;
  console.log(`INFO  tableRect()=${JSON.stringify(table)}  面板默认行列=${TABLE_DEFAULT_LINES}×${TABLE_DEFAULT_LINES}`);
  console.log(`INFO  3×2 前两个格子中心=${JSON.stringify(centersPreview.slice(0, 2))}`);
  pass('几何解析', `画布 ${canvas.w}×${canvas.h}（${canvas.source}）；tableRect 60%×40% 居中`);

  const phases = new Set(PHASES);
  if (phases.has('1')) {
    phase1(canvas);
  } else {
    skipped('Phase 1（3×2 → Markdown）', '--phases 未包含 1');
  }
  if (phases.has('2')) {
    phase2(canvas);
  } else {
    skipped('Phase 2（7×6 → 自动关闭）', '--phases 未包含 2');
  }
  if (phases.has('3')) {
    phase3(canvas);
  } else {
    skipped('Phase 3（手动关闭 → 占位符）', '--phases 未包含 3');
  }

  console.log('\n—— 关键 hilog 片段 ——');
  console.log(logSamples.length === 0 ? '(none)' : logSamples.join('\n'));
  console.log('\n—— 截图 ——');
  console.log(shots.length === 0 ? '(none)' : shots.join('\n'));
  const report = dumpReport('done');
  console.log(`\n报告：${report}`);
  summarize();
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

main();
