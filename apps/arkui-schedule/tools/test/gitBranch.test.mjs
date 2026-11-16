// A2：分支名校验、ahead/behind 计算、首次推送的分支创建参数（纯函数 + 源码级 + 真实仓库）。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 分层：
// 1. `model/syncError.ts`：`normalizeBranchName` / `validateBranchName`（空/非法给可读中文）、
//    `computeAheadBehind`（给本地/远端提交 sha 列表 → ahead/behind/diverged）；
// 2. `git-bridge.js` 的 `internals`：同一算法的 JS 版（两端结果必须一致）、`countConflicts`、
//    `pushPlan`（**force 恒为 false**）；
// 3. 源码级：push 调用点用 `plan.force`（不存在 `force: true`），首次推送会 `writeRef` 建分支；
// 4. 真实仓库：`switchBranchTo` 建出本地分支并 checkout，`status` 从真实 refs 算出 ahead/behind。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..', '..');
const GIT_DIR = join(APP_ROOT, 'entry/src/main/resources/rawfile/git');
const ISO_PATH = join(GIT_DIR, 'isomorphic-git.js');
const BRIDGE_PATH = join(GIT_DIR, 'git-bridge.js');
const BRIDGE_SOURCE = readFileSync(BRIDGE_PATH, 'utf8');
const nodeRequire = createRequire(import.meta.url);

const {
  DEFAULT_BRANCH,
  computeAheadBehind,
  normalizeBranchName,
  validateBranchName
} = await import('../.build/model/syncError.js');

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结论
    }
  }
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function toPosix(path) {
  return path.replace(/\\/g, '/');
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const GIT_IDENTITY = ['-c', 'user.name=Test Runner', '-c', 'user.email=test@localhost'];

// ------------------------------------------------------------------ 分支名（纯函数）

describe('分支名：默认 main、可配、空/非法给可读中文', () => {
  test('默认分支是 main', () => {
    assert.equal(DEFAULT_BRANCH, 'main');
  });

  test('normalizeBranchName：去空白、去 refs/heads/ 前缀、去首尾斜杠', () => {
    assert.equal(normalizeBranchName('main'), 'main');
    assert.equal(normalizeBranchName('  dev  '), 'dev');
    assert.equal(normalizeBranchName('refs/heads/dev'), 'dev');
    assert.equal(normalizeBranchName('/feature/x/'), 'feature/x');
    assert.equal(normalizeBranchName(''), '');
    assert.equal(normalizeBranchName(null), '');
  });

  test('合法分支名全部通过（含常见的 feature/ 前缀）', () => {
    for (const name of ['main', 'master', 'dev', 'release-1.0', 'feature/login', 'fix/2026-11', 'a_b.c']) {
      assert.equal(validateBranchName(name), '', `${name} 应合法：${validateBranchName(name)}`);
    }
  });

  test('非法分支名逐类给出可读原因（不是一句「格式错误」）', () => {
    const cases = [
      ['', /不能为空[\s\S]*main/],
      ['   ', /不能为空/],
      ['feat ure', /空格/],
      ['feat\u3000ure', /空格/],
      ['a..b', /两个点/],
      ['a//b', /斜杠/],
      ['a/../b', /两个点|段/],
      ['-dev', /开头/],
      ['dev.', /结尾/],
      ['dev.lock', /lock/],
      ['dev~1', /不能包含/],
      ['dev^1', /不能包含/],
      ['dev:1', /不能包含/],
      ['dev?1', /不能包含/],
      ['dev*1', /不能包含/],
      ['dev[1', /不能包含/],
      ['dev\\1', /不能包含/],
      ['a/./b', /「\.」|段/],
      ['@', /「@」/],
      ['a@{b', /@\{/],
      ['x'.repeat(121), /最长 120/]
    ];
    for (const [name, pattern] of cases) {
      const problem = validateBranchName(name);
      assert.ok(problem.length > 0, `${JSON.stringify(name)} 应被判非法`);
      assert.match(problem, pattern, `${JSON.stringify(name)} 的提示不对：${problem}`);
    }
  });

  test('归一后再校验：refs/heads/dev 合法，说明用户粘贴 ref 全名也能用', () => {
    assert.equal(validateBranchName('refs/heads/feature/x'), '');
    assert.equal(normalizeBranchName('refs/heads/feature/x'), 'feature/x');
    // 首尾斜杠会被归一掉（属于「明显冗余」而不是非法），不会让用户白改一遍
    assert.equal(validateBranchName('/dev'), '');
    assert.equal(normalizeBranchName('/dev'), 'dev');
  });
});

// ------------------------------------------------------------------ ahead/behind（纯函数）

describe('computeAheadBehind：给本地/远端提交列表 → 数字', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  const D = 'd'.repeat(40);

  test('本地多一个 / 远端多两个 / 分叉 / 完全一致', () => {
    assert.deepEqual(computeAheadBehind([A, B], [B]), {
      ahead: 1,
      behind: 0,
      diverged: false,
      comparable: true
    });
    assert.deepEqual(computeAheadBehind([B], [A, B]), {
      ahead: 0,
      behind: 1,
      diverged: false,
      comparable: true
    });
    assert.deepEqual(computeAheadBehind([A, B], [C, D]), {
      ahead: 2,
      behind: 2,
      diverged: true,
      comparable: true
    });
    assert.deepEqual(computeAheadBehind([A, B], [B, A]), {
      ahead: 0,
      behind: 0,
      diverged: false,
      comparable: true
    });
  });

  test('空侧 / 双侧为空：comparable 为 false（界面据此说「未知」）', () => {
    assert.deepEqual(computeAheadBehind([], []), {
      ahead: 0,
      behind: 0,
      diverged: false,
      comparable: false
    });
    assert.deepEqual(computeAheadBehind([A, B], []), {
      ahead: 2,
      behind: 0,
      diverged: false,
      comparable: true
    });
    assert.deepEqual(computeAheadBehind([], [A]), {
      ahead: 0,
      behind: 1,
      diverged: false,
      comparable: true
    });
  });

  test('重复 sha 只算一次；顺序无关；空白/非数组安全', () => {
    assert.deepEqual(computeAheadBehind([A, A, B], [A]), {
      ahead: 1,
      behind: 0,
      diverged: false,
      comparable: true
    });
    assert.deepEqual(computeAheadBehind([B, A], [A]), computeAheadBehind([A, B], [A]));
    assert.deepEqual(computeAheadBehind(['  ' + A + '  ', ''], [A]), {
      ahead: 0,
      behind: 0,
      diverged: false,
      comparable: true
    });
    assert.equal(computeAheadBehind(null, undefined).comparable, false);
  });
});

// ------------------------------------------------------------------ 桥内部：同算法 + pushPlan

/** 最小假宿主：只够加载桥、建立会话（纯函数与真实仓库用例都不发 HTTP）。 */
function createFakeHost(repoRoot) {
  const events = [];
  const waiters = new Map();
  const calls = [];
  const host = {
    readFileBase64(path) {
      calls.push(['readFileBase64', path]);
      try {
        return readFileSync(path).toString('base64');
      } catch {
        return '';
      }
    },
    writeFileBase64(path, base64) {
      calls.push(['writeFileBase64', path]);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(base64, 'base64'));
      return true;
    },
    fileExists(path) {
      calls.push(['fileExists', path]);
      return existsSync(path);
    },
    mkdirp(path) {
      mkdirSync(path, { recursive: true });
      return true;
    },
    readdir(path) {
      calls.push(['readdir', path]);
      return JSON.stringify(readdirSync(path));
    },
    stat(path) {
      const info = statSync(path, { throwIfNoEntry: false });
      if (!info) {
        const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return JSON.stringify({
        mode: info.mode,
        size: info.size,
        mtimeMs: info.mtimeMs,
        type: info.isDirectory() ? 'dir' : 'file'
      });
    },
    unlink(path) {
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },
    rename(oldPath, newPath) {
      mkdirSync(dirname(newPath), { recursive: true });
      renameSync(oldPath, newPath);
      return true;
    },
    getRepoRoot() {
      return repoRoot;
    },
    httpRequest() {
      throw new Error('本用例不应发起 HTTP 请求');
    },
    onEvent(json) {
      const event = JSON.parse(json);
      events.push(event);
      const waiter = waiters.get(String(event.id));
      if (waiter) {
        waiters.delete(String(event.id));
        waiter(event);
      }
    }
  };
  host.waiters = waiters;
  host.events = events;
  host.calls = calls;
  return host;
}

function loadBridge(host) {
  // 桥依赖全局 `git`（index.html 里先加载 isomorphic-git.js）：Node 里先手动加载一次
  if (!(typeof globalThis.git === 'object' && globalThis.git !== null && typeof globalThis.git.clone === 'function')) {
    globalThis.self = globalThis;
    nodeRequire(ISO_PATH);
  }
  assert.equal(typeof globalThis.git, 'object', 'isomorphic-git 没有暴露全局 git');
  globalThis.dshGitHost = host;
  delete globalThis.DshGitBridge;
  vm.runInThisContext(BRIDGE_SOURCE, { filename: BRIDGE_PATH });
  assert.equal(typeof globalThis.DshGitBridge, 'object');
  return globalThis.DshGitBridge;
}

let requestSeq = 0;

function invoke(bridge, host, op, args, timeoutMs = 30000) {
  const id = `branch-${++requestSeq}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      host.waiters.delete(id);
      rejectPromise(new Error(`桥操作超时：${op}`));
    }, timeoutMs);
    host.waiters.set(id, (event) => {
      clearTimeout(timer);
      resolvePromise(event);
    });
    bridge.call(JSON.stringify({ id, op, args }));
  });
}

async function expectOk(bridge, host, op, args) {
  const event = await invoke(bridge, host, op, args);
  assert.equal(event.ok, true, `${op} 失败：${JSON.stringify(event.error)}`);
  return event.data;
}

/** 建一个真实仓库：两笔提交（C1、C2），工作区干净，remote origin 指向假地址。 */
function makeRepoWithTwoCommits(prefix) {
  const work = makeTempDir(prefix);
  const repoRoot = toPosix(join(work, 'git-repo'));
  mkdirSync(repoRoot, { recursive: true });
  runGit(['init', '-b', 'main', repoRoot], work);
  const day1 = join(repoRoot, 'devices/phone-a/schedules/2026-11-15.jsonl');
  mkdirSync(dirname(day1), { recursive: true });
  writeFileSync(day1, '{"id":"r1","ts":"2026-11-15T09:00:00+08:00"}\n', 'utf8');
  runGit(['-C', repoRoot, ...GIT_IDENTITY, 'add', '-A'], work);
  runGit(['-C', repoRoot, ...GIT_IDENTITY, 'commit', '-m', 'C1: 初始日程'], work);
  const c1 = runGit(['-C', repoRoot, 'rev-parse', 'HEAD'], work).trim();
  writeFileSync(
    join(repoRoot, 'devices/phone-a/schedules/2026-11-16.jsonl'),
    '{"id":"r2","ts":"2026-11-16T09:00:00+08:00"}\n',
    'utf8'
  );
  runGit(['-C', repoRoot, ...GIT_IDENTITY, 'add', '-A'], work);
  runGit(['-C', repoRoot, ...GIT_IDENTITY, 'commit', '-m', 'C2: 第二条日程'], work);
  const c2 = runGit(['-C', repoRoot, 'rev-parse', 'HEAD'], work).trim();
  runGit(['-C', repoRoot, 'remote', 'add', 'origin', 'https://git.example.invalid/owner/repo.git'], work);
  return { work, repoRoot, c1, c2 };
}

describe('桥内部：与 ArkTS 侧同一套 ahead/behind 算法', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);

  test('同一输入下 model 与 bridge 的结果逐字段一致', () => {
    const work = makeTempDir('dsh-branch-pure-');
    const bridge = loadBridge(createFakeHost(toPosix(join(work, 'git-repo'))));
    const samples = [
      [[A, B], [B]],
      [[B], [A, B]],
      [[A, B], [C]],
      [[A, B], [B, A]],
      [[], []],
      [[A], []],
      [[], [A]]
    ];
    for (const [local, remote] of samples) {
      assert.deepEqual(
        bridge.internals.computeAheadBehind(local, remote),
        computeAheadBehind(local, remote),
        `两侧算法不一致：${JSON.stringify({ local, remote })}`
      );
    }
    assert.equal(typeof bridge.internals.branchStateOf, 'function');
    assert.equal(typeof bridge.internals.switchBranchTo, 'function');
  });

  test('countConflicts：只有 HEAD/工作区/暂存区三者互不相同才算冲突', () => {
    const work = makeTempDir('dsh-branch-conflicts-');
    const bridge = loadBridge(createFakeHost(toPosix(join(work, 'git-repo'))));
    const { countConflicts } = bridge.internals;

    assert.equal(countConflicts([]), 0);
    assert.equal(countConflicts(null), 0);
    // 干净：三者都是 1
    assert.equal(countConflicts([['a.jsonl', 1, 1, 1]]), 0);
    // 常规改动：工作区变了但暂存区没变 / 或两者一致 → 不是冲突
    assert.equal(countConflicts([['a.jsonl', 1, 2, 1]]), 0);
    assert.equal(countConflicts([['a.jsonl', 1, 2, 2]]), 0);
    assert.equal(countConflicts([['a.jsonl', 0, 2, 0]]), 0);
    // 三者互不相同 → 记一个冲突
    assert.equal(countConflicts([['a.jsonl', 1, 2, 3]]), 1);
    assert.equal(
      countConflicts([
        ['a.jsonl', 1, 2, 3],
        ['b.jsonl', 1, 1, 1],
        ['c.jsonl', 0, 2, 3]
      ]),
      2
    );
    // 非数组行不崩
    assert.equal(countConflicts([null, 'x', ['only']]), 0);
  });

  test('pushPlan：remote=origin、ref 是分支名、**force 恒为 false**', () => {
    const work = makeTempDir('dsh-branch-plan-');
    const bridge = loadBridge(createFakeHost(toPosix(join(work, 'git-repo'))));
    const { pushPlan } = bridge.internals;

    assert.deepEqual(pushPlan('main'), {
      remote: 'origin',
      ref: 'main',
      refspec: 'refs/heads/main',
      force: false
    });
    assert.deepEqual(pushPlan('release/1.0'), {
      remote: 'origin',
      ref: 'release/1.0',
      refspec: 'refs/heads/release/1.0',
      force: false
    });
    assert.equal(pushPlan('').ref, 'main', '空分支回落 main');
    assert.equal(pushPlan(undefined).force, false);
  });
});

describe('源码级：push 永不 force，首次推送会建本地/远端分支', () => {
  test('push 调用点用的是 pushPlan 的 force（git.push 里没有 force: true）', () => {
    assert.match(BRIDGE_SOURCE, /var plan = pushPlan\(branch\);/, 'push 必须先算 pushPlan');
    assert.match(BRIDGE_SOURCE, /force: plan\.force,/, 'git.push 的 force 必须来自 pushPlan（恒 false）');
    // force:true 只允许出现在 writeRef / addRemote（建分支、改远端地址），不允许出现在 push
    const pushBlock = /await git\.push\(\{[\s\S]{0,400}?\n    \}\);/.exec(BRIDGE_SOURCE);
    assert.ok(pushBlock !== null, '找不到 git.push 调用点');
    assert.equal(/force:\s*true/.test(pushBlock[0]), false, `git.push 里出现 force: true：${pushBlock[0]}`);
    // CONFIG_KEYS 必须放行分支名，否则分支永远只能用 main
    assert.match(BRIDGE_SOURCE, /var CONFIG_KEYS = \[[^\]]*'branch'/, 'CONFIG_KEYS 必须包含 branch');
  });

  test('首次推送：提交后补写 refs/heads/<branch>，并回报 branchCreated', () => {
    // 提交后若本地分支引用不存在 → writeRef 指向本次提交
    assert.match(
      BRIDGE_SOURCE,
      /await git\.writeRef\(\{[\s\S]{0,200}ref: 'refs\/heads\/' \+ branch,[\s\S]{0,80}value: commitOid/,
      '首次推送要把 refs/heads/<branch> 指向本次提交'
    );
    // 远端此前有没有该分支 → branchCreated（页面据此提示「已在远端创建分支」）
    assert.match(BRIDGE_SOURCE, /var remoteBranchExisted = \(await refOid\(git, 'refs\/remotes\/origin\/' \+ branch\)\) !== null/);
    assert.match(BRIDGE_SOURCE, /branchCreated: !remoteBranchExisted/);
    // 拉取/推送前先把 HEAD 换到目标分支（否则 commit 会落到别的分支）
    assert.match(BRIDGE_SOURCE, /await ensureOnBranch\(git, branch\);/, 'pull/push 前必须切到目标分支');
  });
});

describe('设置页接线（源码级）：分支输入、推送按钮、同步状态行', () => {
  const PAGE = readFileSync(new URL('../../entry/src/main/ets/pages/Settings.ets', import.meta.url), 'utf8');

  test('分支可配：默认 main、输入框、校验红字、保存进扩展设置', () => {
    const has = (pattern) => assert.ok(pattern.test(PAGE), `页面缺少：${pattern}`);
    has(/@State branch: string = DEFAULT_BRANCH;/);
    has(/TextInput\(\{ text: this\.branch, placeholder: DEFAULT_BRANCH \}\)/);
    has(/const branchProblem: string = validateBranchName\(this\.branch\);/);
    has(/this\.branchError = branchProblem;/);
    has(/this\.ErrorText\(this\.branchError\)/);
    has(/gitExtrasStore\.save\(\s*\{[\s\S]{0,200}branch: normalizeBranchName\(this\.branch\)/);
    has(/gitExtrasStore\.load\(context\)/);
  });

  test('配置下发给服务：branch / platform / authMode 都要带上', () => {
    const config = /const config: GitSyncConfig = \{[\s\S]{0,600}?\};/.exec(PAGE);
    assert.ok(config !== null, '找不到 configure() 里的 GitSyncConfig');
    for (const field of ['branch:', 'platform:', 'gitUsername:', 'authMode:']) {
      assert.ok(config[0].includes(field), `下发的配置缺 ${field}`);
    }
    assert.match(config[0], /branch: normalizeBranchName\(this\.branch\)[\s\S]{0,80}?DEFAULT_BRANCH/);
  });

  test('手动推送按钮：按 pushBlockedReason 禁用，且给出禁用原因', () => {
    assert.match(PAGE, /Button\('推送'\)/, '同步组要有手动推送按钮');
    assert.match(PAGE, /this\.runAction\('push'\);/, '点推送要触发 push 动作');
    assert.match(PAGE, /\.enabled\(!this\.syncBusy && this\.webReady && this\.pushBlockedReason\(\)\.length === 0\)/);
    assert.match(PAGE, /推送不可用：\$\{this\.pushBlockedReason\(\)\}/, '禁用时要写原因');
  });

  test('同步状态：statusLine 展示 + 同步成功后自动刷新（只读本地）', () => {
    assert.match(PAGE, /@State statusLine: string = '';/, '需要 statusLine 状态');
    assert.match(PAGE, /this\.statusLine = result\.message;/, '状态结果要落到界面');
    assert.match(PAGE, /Text\(this\.statusLine\)/, '状态行要渲染');
    assert.match(PAGE, /await this\.refreshStatus\(true\);/, '动作成功后刷新本地状态');
    assert.match(PAGE, /this\.sync\.status\(!localOnly\)/, 'localOnly 时不发连通性探测');
    assert.match(PAGE, /describePushReadiness\(this\.statusView\(\)\)/, '「能不能推」的说明来自纯函数');
  });

  test('最近一次同步：时间 + 动作 + 成败（describeLastSyncOutcome）', () => {
    assert.match(PAGE, /Text\(describeLastSyncOutcome\(this\.lastSyncAt, this\.lastSyncError, this\.lastSyncAction, nowIso\(\)\)\)/);
  });
});

describe('真实仓库：分支切换 + status 的 ahead/behind', () => {
  test('switchBranchTo：本地没有该分支时按 HEAD 建出并 checkout', async () => {
    const { work, repoRoot, c2 } = makeRepoWithTwoCommits('dsh-branch-switch-');
    const host = createFakeHost(repoRoot);
    const bridge = loadBridge(host);
    bridge.getInternalFs(); // 建立会话（repoRoot 生效）

    assert.equal(runGit(['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], work).trim(), 'main');
    const switched = await bridge.internals.switchBranchTo('dev');
    assert.equal(switched.switched, true);
    assert.equal(switched.createdLocalBranch, true);
    assert.equal(switched.from, 'head');

    assert.equal(runGit(['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], work).trim(), 'dev');
    assert.equal(runGit(['-C', repoRoot, 'rev-parse', 'refs/heads/dev'], work).trim(), c2, '新分支应指向原 HEAD');
    assert.equal(runGit(['-C', repoRoot, 'rev-parse', 'refs/heads/main'], work).trim(), c2, '不应动 main');

    // 已在目标分支 → 幂等（不再 checkout）
    const again = await bridge.internals.switchBranchTo('dev');
    assert.equal(again.switched, false);
    assert.equal(again.from, 'current');
  });

  test('status：ahead/behind/conflicts 从真实 refs 与提交历史算出', async () => {
    const { work, repoRoot, c1, c2 } = makeRepoWithTwoCommits('dsh-branch-status-');
    const host = createFakeHost(repoRoot);
    const bridge = loadBridge(host);
    bridge.getInternalFs();
    const config = {
      branch: 'dev',
      deviceId: 'phone-a',
      repoUrl: 'https://git.example.invalid/owner/repo.git'
    };

    // ① dev 存在、远端还没有该分支 → 领先 2、落后 0
    await bridge.internals.switchBranchTo('dev');
    const first = await expectOk(bridge, host, 'status', config);
    assert.equal(first.initialized, true);
    assert.equal(first.targetBranch, 'dev');
    assert.equal(first.localBranchExists, true);
    assert.equal(first.remoteBranchExists, false);
    assert.equal(first.ahead, 2);
    assert.equal(first.behind, 0);
    assert.equal(first.diverged, false);
    assert.equal(first.conflicts, 0);

    // ② 远端 = C1 → 本地多 C2 → 领先 1
    runGit(['-C', repoRoot, 'update-ref', 'refs/remotes/origin/dev', c1], work);
    const second = await expectOk(bridge, host, 'status', config);
    assert.equal(second.remoteBranchExists, true);
    assert.equal(second.remoteBranchOid, c1);
    assert.equal(second.ahead, 1);
    assert.equal(second.behind, 0);

    // ③ 远端出现一个本地没有的提交（基于 C1）→ 分叉：领先 1、落后 1
    const tree = runGit(['-C', repoRoot, 'rev-parse', 'HEAD^{tree}'], work).trim();
    const remoteOnly = runGit(
      ['-C', repoRoot, ...GIT_IDENTITY, 'commit-tree', tree, '-p', c1, '-m', '远端独有'],
      work
    ).trim();
    runGit(['-C', repoRoot, 'update-ref', 'refs/remotes/origin/dev', remoteOnly], work);
    const third = await expectOk(bridge, host, 'status', config);
    assert.equal(third.ahead, 1);
    assert.equal(third.behind, 1);
    assert.equal(third.diverged, true);

    // ④ 远端 = C2 的子提交 → 本地只落后 1
    const remoteAhead = runGit(
      ['-C', repoRoot, ...GIT_IDENTITY, 'commit-tree', tree, '-p', c2, '-m', '远端新提交'],
      work
    ).trim();
    runGit(['-C', repoRoot, 'update-ref', 'refs/remotes/origin/dev', remoteAhead], work);
    const fourth = await expectOk(bridge, host, 'status', config);
    assert.equal(fourth.ahead, 0);
    assert.equal(fourth.behind, 1);
    assert.equal(fourth.diverged, false);
  });

  test('status：工作区有改动时 changedCount 增加、conflicts 仍为 0（应用不 merge）', async () => {
    const { repoRoot } = makeRepoWithTwoCommits('dsh-branch-dirty-');
    const host = createFakeHost(repoRoot);
    const bridge = loadBridge(host);
    bridge.getInternalFs();
    writeFileSync(
      join(repoRoot, 'devices/phone-a/schedules/2026-11-15.jsonl'),
      '{"id":"r1","ts":"2026-11-15T09:00:00+08:00"}\n{"id":"r1b"}\n',
      'utf8'
    );

    const status = await expectOk(bridge, host, 'status', { branch: 'main', deviceId: 'phone-a' });
    assert.equal(status.changedCount, 1);
    assert.equal(status.conflicts, 0);
    assert.equal(status.targetBranch, 'main');
    assert.equal(status.localBranchExists, true);
  });

  test('status：分支不存在时 targetBranch 仍回显配置值（页面据此提示「首次推送会创建」）', async () => {
    const { repoRoot } = makeRepoWithTwoCommits('dsh-branch-missing-');
    const host = createFakeHost(repoRoot);
    const bridge = loadBridge(host);
    bridge.getInternalFs();

    const status = await expectOk(bridge, host, 'status', {
      branch: 'feature/new',
      deviceId: 'phone-a',
      repoUrl: 'https://git.example.invalid/owner/repo.git'
    });
    assert.equal(status.targetBranch, 'feature/new');
    assert.equal(status.localBranchExists, false);
    assert.equal(status.remoteBranchExists, false);
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);
    assert.ok(existsSync(join(repoRoot, '.git')), '只读状态不该破坏仓库');
  });

  test('status：仓库还没初始化时也回显 targetBranch（ArkTS 侧据此给出可读提示，不读 null）', async () => {
    const work = makeTempDir('dsh-branch-uninit-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    mkdirSync(repoRoot, { recursive: true });
    const host = createFakeHost(repoRoot);
    const bridge = loadBridge(host);

    const status = await expectOk(bridge, host, 'status', { branch: 'dev', deviceId: 'phone-a' });
    assert.equal(status.initialized, false);
    assert.equal(status.targetBranch, 'dev');
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);
    assert.equal(status.conflicts, 0);
    assert.equal(status.lastCommit, null);
    assert.equal(status.head, null);
  });
});
