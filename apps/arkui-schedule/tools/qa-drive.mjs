#!/usr/bin/env node
/**
 * 真机交互小驱动（只做「取证 + 单步动作」，供人工/脚本分步验收用）。
 *
 * 为什么不是一条大脚本：插入图片要经过**系统相册选择器**（跨 App），页面结构不确定，
 * 必须逐步看布局文本再决定点哪里。这里把每一步做成一条命令，命令本身即报告里的证据。
 *
 * 用法：
 *   node tools/qa-drive.mjs texts                  # 打印当前页所有非空文本（含 bounds）
 *   node tools/qa-drive.mjs click "插入"            # 精确匹配优先，否则唯一子串匹配，点击中心点
 *   node tools/qa-drive.mjs tap 1200 800           # 按坐标点
 *   node tools/qa-drive.mjs key Back               # uitest uiInput keyEvent
 *   node tools/qa-drive.mjs shot pr-01-picker      # 截图到 .tmp-accept/qa-<name>.png，打印路径/sha/深色像素
 *   node tools/qa-drive.mjs dark <png>             # 只算画布深色像素
 *   node tools/qa-drive.mjs log 4 [正则]           # hilog -r → 等 N 秒 → hilog -x，过滤打印
 *   node tools/qa-drive.mjs sha <png>
 *
 * 约定：只依赖 hdc / devecocli；截图先删再拍（devecocli 不覆盖同名文件）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLayoutOutput, layoutTexts } from './layout-parse.mjs';

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
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
const sizeOf = (file) => readFileSync(file).length;

/** 画布区域的深色像素数：与 device-objects-check.mjs 同一窗口（x 650..2100, y 500..1100, 步长 2）。 */
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

function shot(name) {
  const file = join(TMP, `qa-${name}.png`);
  try { rmSync(file, { force: true }); } catch { /* ignore */ }
  const res = cli(['ui', 'screenshot', '--device', SERIAL, '--path', file]);
  if (!existsSync(file)) {
    return { file, ok: false, note: res.out.slice(0, 300) };
  }
  return { file, ok: true, sha: sha(file), bytes: sizeOf(file), dark: darkPixels(file) };
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'texts': {
    const flat = layout();
    const all = flat.filter((n) => n.text.length > 0);
    console.log(JSON.stringify({ count: all.length, nodes: all.map((n) => ({ text: n.text, bounds: n.bounds })) }, null, 2));
    break;
  }
  case 'device-layout': {
    // 设备端 `uitest dumpLayout`：能同时看到 App 窗口 + 系统相册选择器（UIExtension），
    // 这是唯一能看到「跨 App 弹窗」的布局来源（devecocli ui layout 只给聚焦的 App 窗口）。
    const remote = '/data/local/tmp/qa-layout.json';
    const local = join(TMP, 'qa-device-layout.json');
    hdc(['shell', `uitest dumpLayout -p ${remote}`]);
    try { rmSync(local, { force: true }); } catch { /* ignore */ }
    hdc(['file', 'recv', remote, local], 60000);
    const root = JSON.parse(readFileSync(local, 'utf8'));
    const wanted = rest[0] ? new RegExp(rest[0]) : null;
    const out = [];
    const bundles = new Set();
    const walk = (n, depth) => {
      const a = n.attributes || {};
      if (a.bundleName) bundles.add(`${a.bundleName}/${a.abilityName ?? ''}`);
      const line = { id: a.id || '', text: a.text || '', bounds: a.bounds || '', type: a.type || '', bundle: a.bundleName || '' };
      if (a.text || (a.id && (!wanted || wanted.test(a.id + ' ' + a.text)))) {
        if (!wanted || wanted.test(`${a.id} ${a.text}`)) out.push({ ...line, depth });
      }
      (n.children || []).forEach((c) => walk(c, depth + 1));
    };
    walk(root, 0);
    console.log(JSON.stringify({ bundles: [...bundles], nodes: out }, null, 1));
    break;
  }
  case 'nodes': {
    // 全量节点（含 id，便于找无文字的图标按钮）
    const flat = layout();
    console.log(JSON.stringify(flat.map((n) => ({ text: n.text, id: n.id, bounds: n.bounds })), null, 1));
    break;
  }
  case 'click': {
    const target = rest[0];
    const flat = layout();
    let node = flat.find((n) => n.text === target);
    if (!node) {
      const loose = flat.filter((n) => n.text.includes(target));
      if (loose.length === 1) node = loose[0];
      else if (loose.length > 1) {
        // 多个命中：取面积最小的（最内层可点元素）
        loose.sort((a, b) => (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) - (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]));
        node = loose[0];
        console.log(`# 注意：「${target}」有 ${loose.length} 个命中，取最小者 bounds=${node.bounds.join(',')}`);
      }
    }
    if (!node) {
      console.log(JSON.stringify({ ok: false, reason: 'not-found', texts: layoutTexts(flat) }));
      process.exitCode = 1;
      break;
    }
    const [x1, y1, x2, y2] = node.bounds;
    const x = Math.round((x1 + x2) / 2);
    const y = Math.round((y1 + y2) / 2);
    const res = hdc(['shell', `uitest uiInput click ${x} ${y}`]);
    console.log(JSON.stringify({ ok: true, text: node.text, bounds: node.bounds, click: [x, y], out: res.out }));
    break;
  }
  case 'tap': {
    const res = hdc(['shell', `uitest uiInput click ${rest[0]} ${rest[1]}`]);
    console.log(JSON.stringify({ ok: true, click: [Number(rest[0]), Number(rest[1])], out: res.out }));
    break;
  }
  case 'swipe': {
    const res = hdc(['shell', `uitest uiInput swipe ${rest[0]} ${rest[1]} ${rest[2]} ${rest[3]}`]);
    console.log(JSON.stringify({ ok: true, swipe: rest.slice(0, 4).map(Number), out: res.out }));
    break;
  }
  case 'key': {
    const res = hdc(['shell', `uitest uiInput keyEvent ${rest[0]}`]);
    console.log(JSON.stringify({ ok: true, key: rest[0], out: res.out }));
    break;
  }
  case 'shot': {
    const res = shot(rest[0] || `shot-${Date.now()}`);
    console.log(JSON.stringify(res));
    if (!res.ok) process.exitCode = 1;
    break;
  }
  case 'dark': {
    if (!existsSync(rest[0])) {
      console.log(JSON.stringify({ ok: false, reason: 'no-file' }));
      process.exitCode = 1;
      break;
    }
    console.log(JSON.stringify({ file: rest[0], sha: sha(rest[0]), bytes: sizeOf(rest[0]), dark: darkPixels(rest[0]) }));
    break;
  }
  case 'sha': {
    console.log(JSON.stringify({ file: rest[0], sha: sha(rest[0]), bytes: sizeOf(rest[0]) }));
    break;
  }
  case 'log': {
    const secs = Number(rest[0] || 4);
    const re = rest[1] ? new RegExp(rest[1]) : null;
    hdc(['shell', 'hilog', '-r']);
    sleep(secs);
    const out = hdc(['shell', 'hilog', '-x'], 90000).out;
    const lines = out.split(/\r?\n/).filter((l) => l.length > 0 && (!re || re.test(l)));
    console.log(lines.join('\n'));
    console.log(`# 共 ${lines.length} 行${re ? `（过滤 ${re}）` : ''}`);
    break;
  }
  default:
    console.log('用法：texts | click <文本> | tap <x> <y> | swipe <x1> <y1> <x2> <y2> | key <事件> | shot <name> | dark <png> | sha <png> | log <秒> [正则]');
    process.exitCode = 2;
}
