#!/usr/bin/env node
/**
 * 插入图片链路的「用户可见反馈」取证：取消后的 toast、失败时的 toast。
 *
 * 为什么单独一个脚本：toast 只有 1.5–3s，必须在点击后**立刻** dump 布局（同进程内完成），
 * 分成多条 shell 命令会错过窗口。判定依据：
 *   - `uitest dumpLayout`（设备端，能看到 App 窗口 + UIExtension + 浮层）
 *   - hilog `[hw] insert=image ...` / toast 文本节点
 *
 * 用法：node tools/qa-image-probe.mjs [cancel|fail|both]
 * 前置：App 已停在编辑页（有「手写板」入口），或已在手写板。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const sleep = (s) => spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${Math.round(s * 1000)}`], { encoding: 'utf8' });

/** 设​备端 dumpLayout：一次拿到 App 窗口 + 系统相册选择器（UIExtension）+ toast 浮层。 */
function dumpLayout(tag = 'probe') {
  const remote = '/data/local/tmp/qa-probe.json';
  const local = join(TMP, `qa-${tag}-layout.json`);
  hdc(['shell', `uitest dumpLayout -p ${remote}`]);
  try { rmSync(local, { force: true }); } catch { /* ignore */ }
  hdc(['file', 'recv', remote, local], 60000);
  if (!existsSync(local)) return { nodes: [], texts: [] };
  const root = JSON.parse(readFileSync(local, 'utf8'));
  const nodes = [];
  const walk = (n, d) => {
    const a = n.attributes || {};
    nodes.push({ depth: d, id: a.id || '', text: a.text || '', type: a.type || '', bounds: a.bounds || '' });
    (n.children || []).forEach((c) => walk(c, d + 1));
  };
  walk(root, 0);
  return { root, nodes, texts: nodes.map((n) => n.text).filter(Boolean) };
}

/** 在 dump 结果里按文本精确/子串找节点并点它。 */
function tapText(text, { exact = true } = {}) {
  const { nodes } = dumpLayout('tap');
  const hit = nodes.find((n) => (exact ? n.text === text : n.text.includes(text)) && n.bounds);
  if (!hit) return { ok: false, texts: nodes.map((n) => n.text).filter(Boolean).slice(0, 15) };
  const m = hit.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return { ok: false, reason: 'bounds-parse', bounds: hit.bounds };
  const x = Math.round((Number(m[1]) + Number(m[3])) / 2);
  const y = Math.round((Number(m[2]) + Number(m[4])) / 2);
  hdc(['shell', `uitest uiInput click ${x} ${y}`]);
  return { ok: true, text: hit.text, click: [x, y], bounds: hit.bounds };
}

function tapNode(pred) {
  const { nodes } = dumpLayout('tap');
  const hit = nodes.find((n) => pred(n) && n.bounds);
  if (!hit) return { ok: false, seen: nodes.map((n) => `${n.type}:${n.id}:${n.text}`).slice(0, 20) };
  const m = hit.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return { ok: false, reason: 'bounds-parse' };
  const x = Math.round((Number(m[1]) + Number(m[3])) / 2);
  const y = Math.round((Number(m[2]) + Number(m[4])) / 2);
  hdc(['shell', `uitest uiInput click ${x} ${y}`]);
  return { ok: true, id: hit.id, text: hit.text, click: [x, y] };
}

const hilogNow = () => hdc(['shell', 'hilog', '-x'], 90000).out.split(/\r?\n/).filter((l) => l.includes('[hw]') || l.includes('jscrash'));

/** 等相册选择器起来（photo_grid_base 出现）。 */
function waitPicker(limitMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    const { nodes } = dumpLayout('wait');
    if (nodes.some((n) => n.id === 'photo_grid_base')) return true;
    sleep(0.6);
  }
  return false;
}

function ensureHandwriting() {
  const { texts } = dumpLayout('state');
  if (texts.includes('笔迹') && texts.includes('完成')) return 'already-handwriting';
  if (texts.includes('手写板')) {
    tapText('手写板');
    sleep(3.5);
    return 'entered-handwriting';
  }
  return `unknown-state:${texts.slice(0, 8).join('|')}`;
}

function toastTexts(tag) {
  const { nodes } = dumpLayout(tag);
  const toast = nodes.filter((n) => /插入图片|已保存|失败/.test(n.text));
  return { toast, texts: nodes.map((n) => n.text).filter(Boolean) };
}

const mode = process.argv[2] || 'both';
const report = {};

hdc(['shell', 'hilog', '-r']);
const state = ensureHandwriting();
report.state = state;

if (mode === 'cancel' || mode === 'both') {
  tapText('插入');
  sleep(1.6);
  const img = tapText('图片');
  const opened = waitPicker();
  report.cancel = { clickImage: img, pickerOpened: opened };
  if (opened) {
    // 点关闭（X）：Third_Select_PickerClose
    const closed = tapNode((n) => n.id === 'Third_Select_PickerClose');
    report.cancel.closeClick = closed;
    sleep(0.7);
    // 立刻看有没有 toast（不 sleep 到 toast 消失）
    const after = toastTexts('cancel-toast');
    report.cancel.toastAfterCancel = after.toast;
    report.cancel.backToBoard = after.texts.includes('笔迹') && after.texts.includes('完成');
    report.cancel.log = hilogNow();
  }
}

if (mode === 'fail' || mode === 'both') {
  if (!report.cancel || !report.cancel.backToBoard) {
    tapText('插入');
    sleep(1.6);
    tapText('图片');
    waitPicker();
  }
  // 选相册里的第一张图（ImageGridItem_Column_0）
  const picked = tapNode((n) => n.id === 'ImageGridItem_Column_0');
  report.fail = { pickThumb: picked };
  sleep(2.2);
  const confirm = tapText('完成', { exact: true });
  report.fail.confirm = confirm;
  sleep(1.0);
  const after = toastTexts('fail-toast');
  report.fail.toastAfterConfirm = after.toast;
  report.fail.log = hilogNow();
}

console.log(JSON.stringify(report, null, 1));
