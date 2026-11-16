#!/usr/bin/env node
/**
 * 「插入▾ → 图片 → 系统相册 → 选中 → 确认」全链路取证（一条命令跑完，输出机器可读结果）。
 *
 * 关键点（都是真机踩出来的）：
 * - 系统相册是 UIExtension 窗口，`devecocli ui layout` 看不到它；必须用设备端 `uitest dumpLayout`。
 * - 相册单选的确认按钮位置会变（预览态在底部、网格态在顶部），所以按**文本 + 坐标排除 App 工具条**动态找。
 * - 判定「图片上了画布」用画布窗口深色像素数（与 device-objects-check.mjs 同一窗口）。
 *
 * 用法：node tools/qa-insert-image.mjs [--serial <s>] [--from-home]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const TMP = join(APP, '.tmp-accept');
const DEVECO_CLI = 'C:\\Users\\GWL\\Desktop\\itwillclaude\\.tmp\\deveco-cli\\node_modules\\.bin\\devecocli.cmd';
const HDC = 'D:\\A-DevEco\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const SERIAL = opt('--serial', process.env.ACCEPT_SERIAL || '6MFBB25C27205131');
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });

function run(bin, list, timeoutMs = 120000) {
  const isCmd = /\.(cmd|bat)$/i.test(bin);
  const command = isCmd ? (process.env.ComSpec ?? 'cmd.exe') : bin;
  const args = isCmd ? ['/d', '/s', '/c', bin, ...list] : list;
  const done = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, shell: false });
  const err = done.error ? `${done.error.name}: ${done.error.message}` : '';
  return { code: done.status === null ? -1 : done.status, out: `${done.stdout ?? ''}${done.stderr ?? ''}${err}`.trim() };
}
const cli = (list) => run(DEVECO_CLI, list);
const hdc = (list) => run(HDC, ['-t', SERIAL, ...list]);
const sleep = (s) => spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${Math.round(s * 1000)}`], { encoding: 'utf8' });

function dumpLayout(tag = 'x') {
  const remote = '/data/local/tmp/qa-ins.json';
  const local = join(TMP, `qa-ins-${tag}.json`);
  hdc(['shell', `uitest dumpLayout -p ${remote}`]);
  try { rmSync(local, { force: true }); } catch { /* ignore */ }
  hdc(['file', 'recv', remote, local], 60000);
  if (!existsSync(local)) return [];
  const root = JSON.parse(readFileSync(local, 'utf8'));
  const nodes = [];
  const walk = (n, d) => {
    const a = n.attributes || {};
    const m = String(a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    nodes.push({
      depth: d, id: a.id || '', text: a.text || '', type: a.type || '',
      bounds: a.bounds || '', x1: m ? +m[1] : 0, y1: m ? +m[2] : 0, x2: m ? +m[3] : 0, y2: m ? +m[4] : 0
    });
    (n.children || []).forEach((c) => walk(c, d + 1));
  };
  walk(root, 0);
  return nodes;
}
const center = (n) => [Math.round((n.x1 + n.x2) / 2), Math.round((n.y1 + n.y2) / 2)];
const tapAt = ([x, y]) => hdc(['shell', `uitest uiInput click ${x} ${y}`]);

function appLayout() {
  const out = cli(['ui', 'layout', '--device', SERIAL, '--format', 'json', '--mode', 'simplified']).out;
  const start = out.indexOf('[');
  if (start < 0) return [];
  try { return JSON.parse(out.slice(start, out.lastIndexOf(']') + 1)); } catch { return []; }
}
function appTexts() {
  const out = cli(['ui', 'layout', '--device', SERIAL, '--format', 'json', '--mode', 'simplified']).out;
  return (out.match(/"text"\s*:\s*"([^"]*)"/g) || []).map((s) => s.replace(/.*:\s*"/, '').replace(/"$/, '').replace(/\\n/g, ''));
}
function appTap(text) {
  const raw = cli(['ui', 'layout', '--device', SERIAL, '--format', 'json', '--mode', 'simplified']).out;
  const idx = raw.indexOf(text);
  if (idx < 0) return false;
  // 文本节点后面紧跟 bounds
  const after = raw.slice(idx);
  const m = after.match(/"bounds"\s*:\s*\[\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\s*\]/);
  if (!m) return false;
  const x = Math.round((+m[1] + +m[3]) / 2);
  const y = Math.round((+m[2] + +m[4]) / 2);
  tapAt([x, y]);
  return true;
}
function shot(name) {
  const file = join(TMP, `qa-${name}.png`);
  try { rmSync(file, { force: true }); } catch { /* ignore */ }
  cli(['ui', 'screenshot', '--device', SERIAL, '--path', file]);
  if (!existsSync(file)) return { file, ok: false };
  const dark = darkPixels(file);
  return { file, ok: true, sha: createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12), bytes: readFileSync(file).length, dark };
}
function darkPixels(file) {
  const script = [
    'Add-Type -AssemblyName System.Drawing;',
    `$b=[System.Drawing.Bitmap]::FromFile('${file}');`,
    '$n=0;',
    'for($y=500;$y -lt 1100;$y+=2){ for($x=650;$x -lt 2100;$x+=2){ $c=$b.GetPixel($x,$y); if(($c.R+$c.G+$c.B) -lt 600){ $n++ } } }',
    '$b.Dispose();',
    'Write-Output $n'
  ].join(' ');
  const done = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 120000 });
  return Number((done.stdout ?? '0').trim()) || 0;
}
const logLines = () => hdc(['shell', 'hilog', '-x'], 90000).out.split(/\r?\n/).filter((l) => l.includes('[hw]') || /jscrash|appfreeze/.test(l));

const report = { serial: SERIAL, steps: [] };
const note = (k, v) => { report.steps.push({ [k]: v }); console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`); };

// 0. 到编辑页 → 手写板
let texts = appTexts();
if (!texts.includes('手写板')) {
  if (texts.includes('新建')) { appTap('新建'); sleep(3); } // 首页
  else if (texts.includes('设置')) { appTap('‹'); sleep(3); appTap('新建'); sleep(3); }
}
texts = appTexts();
if (texts.includes('手写板')) { appTap('手写板'); sleep(4); }
texts = appTexts();
note('boardState', texts.includes('笔迹') && texts.includes('完成') ? 'handwriting' : `unexpected:${texts.slice(0, 8).join('|')}`);

// 1. 基线
report.baseline = shot('ins-baseline');
note('baselineDark', String(report.baseline.dark));

// 2. 插入 → 图片
hdc(['shell', 'hilog', '-r']);
note('tapInsert', String(appTap('插入')));
sleep(1.8);
note('tapImage', String(appTap('图片')));

// 3. 等相册
let picker = false;
for (let i = 0; i < 12; i += 1) {
  const nodes = dumpLayout(`wait${i}`);
  if (nodes.some((n) => n.id === 'photo_grid_base')) { picker = true; break; }
  sleep(0.6);
}
note('pickerOpened', String(picker));
if (!picker) { console.log(JSON.stringify(report, null, 1)); process.exit(2); }
report.pickerShot = shot('ins-picker');

// 4. 选第一张图
const nodes = dumpLayout('grid');
const item = nodes.find((n) => n.id === 'ImageGridItem_Column_0')
  ?? nodes.find((n) => n.id.startsWith('ThirdSelectAlbumGridBase_GridItemfile://'));
note('thumbFound', item ? item.id.slice(0, 60) : 'none');
if (item) {
  tapAt(center(item));
  sleep(2.2);
  // 5. 确认：找「完成」但排除 App 工具条（y1 > 1300 且 x2 < 200）
  const after = dumpLayout('preview');
  const confirm = after.filter((n) => n.text === '完成' && !(n.y1 > 1300 && n.x2 < 200))
    .sort((a, b) => (a.x2 - a.x1) * (a.y2 - a.y1) - (b.x2 - b.x1) * (b.y2 - b.y1))[0];
  note('confirmBtn', confirm ? `${confirm.bounds}` : 'not-found');
  if (confirm) {
    tapAt(center(confirm));
    sleep(5);
  }
}

// 6. 结果
report.after = shot('ins-after');
note('afterDark', String(report.after.dark));
const logs = logLines();
note('log', logs.filter((l) => /insert=image|archive/.test(l)).join(' || '));
note('pageAfter', appTexts().filter((t) => /笔迹|1\/1|完成/.test(t)).join('|'));
console.log(JSON.stringify(report, null, 1));
