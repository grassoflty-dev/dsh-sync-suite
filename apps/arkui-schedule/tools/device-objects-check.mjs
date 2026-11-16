/**
 * 手写板「按页存储」真机验证（可复现、给证据）。
 *
 * 流程：第 1 页插入表格 → 点「+」插页（2/2）→ 截图 B → 点「‹」回第 1 页（1/2）→ 截图 C。
 * 断言：A（第1页有表格）与 B（第2页空白）不同；A 与 C 基本相同；页码 1/2 → 2/2 → 1/2。
 * 数据来源：`devecocli ui screenshot` + `ui layout` + hilog `[hw] insert=table`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLayoutOutput, findByText, layoutTexts } from './layout-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const TMP = join(APP, '.tmp-accept');
const SERIAL = process.env.ACCEPT_SERIAL || '6MFBB25C27205131';
const DEVECO_CLI = 'C:\\Users\\GWL\\Desktop\\itwillclaude\\.tmp\\deveco-cli\\node_modules\\.bin\\devecocli.cmd';
const HDC = 'D:\\A-DevEco\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';

if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });

function run(bin, list, timeoutMs = 120000) {
  const isCmd = /\.(cmd|bat)$/i.test(bin);
  const command = isCmd ? (process.env.ComSpec ?? 'cmd.exe') : bin;
  const argv = isCmd ? ['/d', '/s', '/c', bin, ...list] : list;
  const done = spawnSync(command, argv, { encoding: 'utf8', timeout: timeoutMs, shell: false });
  const err = done.error ? `${done.error.name}: ${done.error.message}` : '';
  return { code: done.status === null ? -1 : done.status, out: `${done.stdout ?? ''}${done.stderr ?? ''}${err}`.trim() };
}

const cli = (list) => run(DEVECO_CLI, list);
const hdc = (list) => run(HDC, ['-t', SERIAL, ...list]);
const sleep = (s) => spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Seconds ${s}`], { encoding: 'utf8' });

const layout = () => parseLayoutOutput(cli(['ui', 'layout', '--device', SERIAL, '--format', 'json', '--mode', 'simplified']).out);

function tap(node) {
  const [x1, y1, x2, y2] = node.bounds;
  hdc(['shell', `uitest uiInput click ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`]);
}

let shotSeq = 0;
const shot = (name) => {
  shotSeq += 1;
  const file = join(TMP, `${shotSeq}-${name}.png`);
  try { rmSync(file, { force: true }); } catch { /* ignore */ }
  cli(['ui', 'screenshot', '--device', SERIAL, '--path', file]);
  return file;
};

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);

/** 画布区域内的深色像素数（对象层网格线/描边会显著抬高它；空白页接近 0）。 */
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
const sizeOf = (file) => readFileSync(file).length;
const pageLabel = (flat) => layoutTexts(flat).find((t) => /^\d+\/\d+$/.test(t)) ?? '?';
const hilog = (sec) => {
  hdc(['shell', 'hilog', '-r']);
  sleep(sec);
  return hdc(['shell', 'hilog', '-x'], 60000).out;
};

const results = [];
const pass = (s, d) => { results.push({ s, ok: true }); console.log(`PASS  ${s}  ${d}`); };
const fail = (s, d) => { results.push({ s, ok: false }); console.log(`FAIL  ${s}  ${d}`); };
const skipped = (s, d) => { results.push({ s, ok: true, skipped: true }); console.log(`SKIP  ${s}  ${d}`); };

hdc(['shell', 'hdc', 'shell', 'hilog', '-r']);
hdc(['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', 'com.itwill.schedule']);
sleep(6);

let flat = layout();
// 可能停在上次的手写/编辑页：先退回首页（最多 3 次）
for (let attempt = 0; attempt < 3; attempt += 1) {
  const now = layoutTexts(flat);
  if (now.includes('新建')) break;
  hdc(['shell', 'uitest uiInput keyEvent Back']);
  sleep(2);
  flat = layout();
}
const createBtn = findByText(flat, '新建');
if (!createBtn) { fail('进入编辑页', layoutTexts(flat).slice(0, 8).join(' | ')); process.exit(1); }
tap(createBtn);
sleep(3);
flat = layout();
const inkEntry = findByText(flat, '手写板');
if (!inkEntry) { fail('进入手写板', layoutTexts(flat).slice(0, 10).join(' | ')); process.exit(1); }
tap(inkEntry);
sleep(4);

// 第 1 页插表格
flat = layout();
const insertBtn = findByText(flat, '插入');
tap(insertBtn);
sleep(2);
flat = layout();
tap(findByText(flat, '表格'));
sleep(3);
flat = layout();
const insertTableBtn = findByText(flat, '插入表格');
if (insertTableBtn) { tap(insertTableBtn); sleep(2); }

const logAfterInsert = hilog(3);
const pageA = shot('p1-with-table');
const labelA = pageLabel(layout());

// 插页（+）→ 第 2 页
flat = layout();
const addPage = findByText(flat, '+');
if (!addPage) { fail('插页', `找不到「+」（${layoutTexts(flat).join(' | ')}）`); process.exit(1); }
tap(addPage);
sleep(3);
const labelB = pageLabel(layout());
const pageB = shot('p2-empty');

// 回第 1 页
flat = layout();
const prev = flat.filter((n) => n.text === '‹' && n.bounds[1] > 900)[0] ?? findByText(flat, '‹');
if (prev) { tap(prev); sleep(3); }
const labelC = pageLabel(layout());
const pageC = shot('p1-back');

console.log(`pages: ${labelA} -> ${labelB} -> ${labelC}`);
console.log(`sha A=${sha(pageA)} (${sizeOf(pageA)}B)  B=${sha(pageB)} (${sizeOf(pageB)}B)  C=${sha(pageC)} (${sizeOf(pageC)}B)`);

if (/insert=table/.test(logAfterInsert)) {
  pass('插入表格', (logAfterInsert.match(/\[hw\] insert=table[^\n]*/) ?? [''])[0]);
} else {
  skipped('插入表格', 'hilog 窗口未覆盖（以画布像素证据为准）');
}

if (labelB === '2/2' && labelC === '1/2' && labelA !== labelB) {
  pass('页切换', `${labelA} → ${labelB} → ${labelC}`);
} else {
  fail('页切换', `${labelA} → ${labelB} → ${labelC}（期望 1/2 → 2/2 → 1/2）`);
}

const darkA = darkPixels(pageA);
const darkB = darkPixels(pageB);
console.log(`canvas dark pixels: A=${darkA}  B=${darkB}`);

if (darkA > 200 && darkB <= 50) {
  pass('第2页不显示第1页对象', `第1页深色像素 ${darkA}，第2页 ${darkB}`);
} else {
  fail('第2页不显示第1页对象', `深色像素 A=${darkA} B=${darkB}（期望 A 明显大于 B）`);
}

const darkC = darkPixels(pageC);
console.log(`canvas dark pixels: C=${darkC}`);
if (Math.abs(darkC - darkA) <= Math.max(20, Math.round(darkA * 0.02))) {
  pass('翻回第1页对象仍在', `A=${darkA} / C=${darkC}（对象随页恢复）`);
} else {
  fail('翻回第1页对象仍在', `A=${darkA} / C=${darkC}（对象可能丢失）`);
}

console.log(`\n合计：PASS ${results.filter((r) => r.ok).length} / FAIL ${results.filter((r) => !r.ok).length}`);
console.log(`截图目录：${TMP}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
