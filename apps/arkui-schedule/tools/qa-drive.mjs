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
 *
 * 复用方式（别再造一套 hdc 封装）：
 *   ```js
 *   import { createDriver } from './qa-drive.mjs'
 *   const drive = createDriver({ serial, tmp })
 *   drive.hdc(['shell', 'hilog -x'])      // 已带 `-t <serial>`
 *   drive.cli(['ui', 'layout', ...])      // devecocli
 *   drive.layout()                        // → [{ text, id, bounds: [x1,y1,x2,y2] }]
 *   ```
 * 本文件被直接执行时才跑 CLI（`createDriver` 的默认实例），被 import 时无副作用。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLayoutOutput, layoutTexts } from './layout-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');

/** 默认设备序列号（可用环境变量 `ACCEPT_SERIAL` 或 `createDriver({ serial })` 覆盖）。 */
export const DEFAULT_SERIAL = process.env.ACCEPT_SERIAL || '6MFBB25C27205131';
/** devecocli（DevEco 命令行）路径：跨 App 弹窗/布局只能靠它。 */
export const DEVECO_CLI = 'C:\\Users\\GWL\\Desktop\\itwillclaude\\.tmp\\deveco-cli\\node_modules\\.bin\\devecocli.cmd';
/** hdc 路径（DevEco SDK 自带；不在 PATH 里）。 */
export const HDC = 'D:\\A-DevEco\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';

/** 画布深色像素的默认采样窗口（横屏主从时代的坐标；`darkPixels(file, win)` 可覆盖）。 */
const DEFAULT_DARK_WINDOW = { x1: 650, y1: 500, x2: 2100, y2: 1100, step: 2 };

/**
 * 造一个绑定到具体设备/临时目录的驱动。
 * @param {{ serial?: string, tmp?: string, hdc?: string, cli?: string }} [options]
 */
export function createDriver(options = {}) {
  const serial = options.serial ?? DEFAULT_SERIAL;
  const tmp = options.tmp ?? join(APP, '.tmp-accept');
  const hdcBin = options.hdc ?? HDC;
  const cliBin = options.cli ?? DEVECO_CLI;

  function run(bin, list, timeoutMs = 120000) {
    const isCmd = /\.(cmd|bat)$/i.test(bin);
    const command = isCmd ? (process.env.ComSpec ?? 'cmd.exe') : bin;
    const argv = isCmd ? ['/d', '/s', '/c', bin, ...list] : list;
    const done = spawnSync(command, argv, { encoding: 'utf8', timeout: timeoutMs, shell: false });
    const err = done.error ? `${done.error.name}: ${done.error.message}` : '';
    return { code: done.status === null ? -1 : done.status, out: `${done.stdout ?? ''}${done.stderr ?? ''}${err}`.trim() };
  }

  const cli = (list, timeoutMs) => run(cliBin, list, timeoutMs);
  const hdc = (list, timeoutMs) => run(hdcBin, ['-t', serial, ...list], timeoutMs);
  const sleep = (s) => spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Seconds ${s}`], { encoding: 'utf8' });

  const layout = () => parseLayoutOutput(cli(['ui', 'layout', '--device', serial, '--format', 'json', '--mode', 'simplified']).out);
  const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
  const sizeOf = (file) => readFileSync(file).length;

  /**
   * 画布区域的深色像素数（笔迹「有没有画上去」的唯一廉价判据）。
   * @param {string} file 本机 png/jpeg 路径
   * @param {{x1:number,y1:number,x2:number,y2:number,step?:number}} [win]
   */
  function darkPixels(file, win = DEFAULT_DARK_WINDOW) {
    const step = win.step ?? 2;
    const script = [
      'Add-Type -AssemblyName System.Drawing;',
      `$b=[System.Drawing.Bitmap]::FromFile('${file}');`,
      '$n=0;',
      `for($y=${Math.round(win.y1)};$y -lt ${Math.round(win.y2)};$y+=${step}){ for($x=${Math.round(win.x1)};$x -lt ${Math.round(win.x2)};$x+=${step}){ $c=$b.GetPixel($x,$y); if(($c.R+$c.G+$c.B) -lt 600){ $n++ } } }`,
      '$b.Dispose();',
      'Write-Output $n'
    ].join(' ');
    const done = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 180000 });
    return Number((done.stdout ?? '0').trim()) || 0;
  }

  /** 用 devecocli 截图到 `.tmp-accept/qa-<name>.png`（跨 App 布局时也可用）。 */
  function shot(name) {
    if (!existsSync(tmp)) {
      mkdirSync(tmp, { recursive: true });
    }
    const file = join(tmp, `qa-${name}.png`);
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
    const res = cli(['ui', 'screenshot', '--device', serial, '--path', file]);
    if (!existsSync(file)) {
      return { file, ok: false, note: res.out.slice(0, 300) };
    }
    return { file, ok: true, sha: sha(file), bytes: sizeOf(file), dark: darkPixels(file) };
  }

  /**
   * 抓一段 hilog：`hilog -r` 清空 → 等 N 秒 → `hilog -x` 导出。
   * @returns {{ text: string, lines: string[] }} lines 已按 `pattern` 过滤（正则字符串）
   */
  function hilog(seconds = 4, pattern = null) {
    hdc(['shell', 'hilog', '-r']);
    sleep(seconds);
    const text = hdc(['shell', 'hilog', '-x'], 90000).out;
    const re = pattern === null ? null : new RegExp(pattern);
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0 && (re === null || re.test(l)));
    return { text, lines };
  }

  /** `hdc list targets` 的原始输出（判「设备在不在」用）。 */
  const targets = () => run(hdcBin, ['list', 'targets'], 30000).out;

  return { serial, tmp, run, cli, hdc, sleep, layout, sha, sizeOf, darkPixels, shot, hilog, targets };
}

// --------------------------------------------------------------------------- CLI
// 只有「本文件被直接执行」时才跑命令分发；被 import 时保持无副作用。
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const drive = createDriver();
  const { cli, hdc, layout, sha, sizeOf, shot, hilog, sleep } = drive;
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
      const local = join(drive.tmp, 'qa-device-layout.json');
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
      console.log(JSON.stringify({ file: rest[0], sha: sha(rest[0]), bytes: sizeOf(rest[0]), dark: drive.darkPixels(rest[0]) }));
      break;
    }
    case 'sha': {
      console.log(JSON.stringify({ file: rest[0], sha: sha(rest[0]), bytes: sizeOf(rest[0]) }));
      break;
    }
    case 'log': {
      const secs = Number(rest[0] || 4);
      const re = rest[1] ? rest[1] : null;
      const res = hilog(secs, re);
      console.log(res.lines.join('\n'));
      console.log(`# 共 ${res.lines.length} 行${re ? `（过滤 ${re}）` : ''}`);
      break;
    }
    default:
      console.log('用法：texts | click <文本> | tap <x> <y> | swipe <x1> <y1> <x2> <y2> | key <事件> | shot <name> | dark <png> | sha <png> | log <秒> [正则]');
      process.exitCode = 2;
  }
  // `sleep` 在部分分支里未被用到，显式引用一次避免 lint 抱怨
  void sleep;
}
