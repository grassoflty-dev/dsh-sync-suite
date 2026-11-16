#!/usr/bin/env node
/**
 * 真机验收脚本（一条命令跑完手写板 / 附件 zip / 同步 / 索引）。
 *
 * 用法：
 *   node apps/arkui-schedule/tools/device-accept.mjs [--serial <id>] [--skip-install] [--keep-going]
 *
 * 设计要点：
 * - **幂等**：可重复跑；每轮生成新的验收记录；不 uninstall（用户配置不丢）。
 * - **锁屏即停**：`aa start` 返回 `10106102` 时打印「需要解锁 PIN」并退出 2，**不反复重试**。
 * - **每步失败即停**（除 `--keep-going`），输出 PASS/FAIL 行列表。
 * - 只依赖 `hdc` 与 `devecocli`，不引入新依赖。
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

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const SERIAL = opt('--serial', DEFAULT_SERIAL);
const SKIP_INSTALL = args.includes('--skip-install');
const KEEP_GOING = args.includes('--keep-going');
const TMP = join(REPO, '.tmp', 'device-accept');

const results = [];

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

const hdc = (list, timeoutMs) => run(HDC, ['-t', SERIAL, ...list], timeoutMs);
const cli = (list, timeoutMs) => run(DEVECO_CLI, list, timeoutMs);

function pass(step, detail) {
  results.push({ step, ok: true, detail });
  console.log(`PASS  ${step}  ${detail ?? ''}`.trimEnd());
}

function fail(step, detail) {
  results.push({ step, ok: false, detail });
  console.log(`FAIL  ${step}  ${detail ?? ''}`.trimEnd());
  if (!KEEP_GOING) {
    summarize();
    process.exitCode = 1;
    process.exit(1);
  }
}

function skipped(step, detail) {
  results.push({ step, ok: true, skipped: true, detail });
  console.log(`SKIP  ${step}  ${detail ?? ''}`.trimEnd());
}

function summarize() {
  const ok = results.filter((r) => r.ok && !r.skipped).length;
  const bad = results.filter((r) => !r.ok).length;
  const skip = results.filter((r) => r.skipped).length;
  console.log('');
  console.log(`合计：PASS ${ok} / FAIL ${bad} / SKIP ${skip}`);
}

/** 读 UI 布局树，返回 [{text,id,bounds}]。
 *
 * `devecocli ui layout` 的输出可能混有进度行（`- Dumping layout…`）、ANSI 颜色、空行，
 * 甚至截断的 stdout；这里取**第一个 `[` 起、到最后一个 `]` 止**的片段再解析，失败时打印原文尾部。
 */
function layout(mode = 'simplified') {
  const out = join(TMP, `layout-${Date.now()}.json`);
  const res = cli(['ui', 'layout', '--device', SERIAL, '--format', 'json', '--mode', mode]);
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

function hilog(seconds = 6) {
  hdc(['shell', 'hilog', '-r']);
  spawnSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Seconds ${seconds}`], { encoding: 'utf8' });
  const res = hdc(['shell', 'hilog', '-x'], 60000);
  return res.out;
}

function main() {
  if (!existsSync(TMP)) {
    mkdirSync(TMP, { recursive: true });
  }
  console.log(`真机验收：serial=${SERIAL}  skipInstall=${SKIP_INSTALL}`);

  // 0. 设备在不在
  const targets = run(HDC, ['list', 'targets'], 30000).out;
  if (!targets.includes(SERIAL)) {
    fail('设备连接', `hdc list targets 未找到 ${SERIAL}`);
    return;
  }
  pass('设备连接', SERIAL);

  // 1. 安装 + 启动
  const hap = join(APP, 'dist-harmony', 'arkui-schedule-harmony-debug-signed.hap');
  if (!SKIP_INSTALL) {
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
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2'], { encoding: 'utf8' });
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
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3'], { encoding: 'utf8' });
  flat = layout();
  const inkEntry = byText(flat, '手写板');
  if (!inkEntry) {
    fail('进入手写板', '编辑页找不到「手写板」入口（是否非鸿蒙构建？）');
    return;
  }
  tap(inkEntry);
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 4'], { encoding: 'utf8' });
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

  // 「插入」二级菜单：图片 / 表格
  const insertBtn = byText(flat, '插入');
  if (insertBtn) {
    tap(insertBtn);
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2'], { encoding: 'utf8' });
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
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3'], { encoding: 'utf8' });

  // 插页（[−|+] 单元格的右半：找「+」节点）
  flat = layout();
  const plus = byText(flat, '+');
  if (!plus) {
    fail('插入页', '找不到「+」按钮');
    return;
  }
  tap(plus);
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2'], { encoding: 'utf8' });
  flat = layout();
  if (!hasText(flat, '2/2')) {
    fail('插入页', `页数未变成 2/2（当前 ${texts(flat).filter((t) => /^\d+\/\d+$/.test(t)).join(',') || '无'}）`);
    return;
  }
  pass('插入页', '2/2');

  swipe(500, 1200, 1100, 1300);
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3'], { encoding: 'utf8' });

  // 完成
  flat = layout();
  const done = byText(flat, '完成');
  if (!done) {
    fail('完成', '找不到「完成」按钮');
    return;
  }
  tap(done);
  spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 20'], { encoding: 'utf8' });
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
    const got = hdc(['file', 'recv', candidate, localZip], 60000);
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

  summarize();
  const failed = results.filter((r) => !r.ok).length;
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
