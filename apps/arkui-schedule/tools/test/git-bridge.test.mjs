#!/usr/bin/env node
/**
 * `git-bridge.js` 的真实行为测试（Node，无需网络、不写真实 profile）。
 *
 * 覆盖：
 * 1. vendored `isomorphic-git.js`（1.25.3 UMD）在 Node 下真实加载，核心 API 存在；
 * 2. 桥的 fs 适配器 + `init`/`status`/`log`/`currentBranch`/`resolveRef` 在**真实 git 仓库**上跑通
 *    （仓库由系统 git 建立，桥通过 `dshGitHost` 同步代理读写同一份文件）；
 * 3. 桥的 http 适配器：`httpRequest` → `onHttpResult` 回传 404/401 时状态码正确透传，
 *    认证失败时 token 只出现在 Authorization 头、不出现在错误信息里；
 * 4. `push` 的路径限定与前置校验（无 repoUrl / 未初始化时给出中文错误）；
 * 5. `index.html` 的脚本顺序与 `DshGitBridge` 暴露；两个 rawfile JS 通过 `node --check`；
 * 6. 内部纯函数（base64/utf8/jsonl 并集/克隆后本地文件补回）单测。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
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
const HTML_PATH = join(GIT_DIR, 'index.html');

const FAKE_TOKEN = 'test-token-not-real';

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

// ------------------------------------------------------------------ 假宿主

/**
 * 与 ArkTS `GitSyncService` 行为一致的同步代理假实现。
 * `respondHttp(id, options)` 用来在测试内决定 HTTP 结果。
 */
function createFakeHost(repoRoot, responseProvider) {
  const events = [];
  const waiters = new Map();
  const calls = [];
  const httpRequests = [];

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
      calls.push(['mkdirp', path]);
      mkdirSync(path, { recursive: true });
      return true;
    },
    readdir(path) {
      calls.push(['readdir', path]);
      return JSON.stringify(readdirSync(path));
    },
    stat(path) {
      calls.push(['stat', path]);
      const info = statSync(path, { throwIfNoEntry: false });
      if (!info) {
        const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
        error.code = 'ENOENT';
        throw error;
      }
      const type = info.isDirectory() ? 'dir' : 'file';
      return JSON.stringify({ mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, type });
    },
    unlink(path) {
      calls.push(['unlink', path]);
      try {
        unlinkSync(path);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    },
    rename(oldPath, newPath) {
      calls.push(['rename', oldPath]);
      mkdirSync(dirname(newPath), { recursive: true });
      renameSync(oldPath, newPath);
      return true;
    },
    getRepoRoot() {
      calls.push(['getRepoRoot', repoRoot]);
      return repoRoot;
    },
    httpRequest(id, optionsJson) {
      const options = JSON.parse(optionsJson);
      calls.push(['httpRequest', id]);
      httpRequests.push({ id, options });
      const response = responseProvider(id, options);
      // 与 ArkTS 一致：异步完成后通过 runJavaScript 调 window.DshGitBridge.onHttpResult
      Promise.resolve().then(() => {
        globalThis.DshGitBridge.onHttpResult(JSON.stringify({ ...response, id }));
      });
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

  // 测试脚手架直接挂在宿主对象上，便于 loadBridge 后统一用 host 访问
  host.waiters = waiters;
  host.events = events;
  return { host, events, waiters, calls, httpRequests };
}

const nodeRequire = createRequire(import.meta.url);

// ------------------------------------------------------------------ 桥加载

/**
 * 每次调用都重新执行 git-bridge.js，得到**独立会话**（内部 session 状态互不影响）。
 * 使用 vm.runInThisContext 模拟 WebView 的经典脚本加载语义（非 ESM）。
 */
function loadBridge(host) {
  globalThis.dshGitHost = host;
  delete globalThis.DshGitBridge;
  vm.runInThisContext(readFileSync(BRIDGE_PATH, 'utf8'), { filename: BRIDGE_PATH });
  assert.equal(typeof globalThis.DshGitBridge, 'object', 'git-bridge.js 应暴露 globalThis.DshGitBridge');
  return globalThis.DshGitBridge;
}

let requestSeq = 0;

function invoke(bridge, host, op, args, timeoutMs = 30000) {
  const id = `req-${++requestSeq}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      host.waiters.delete(id);
      rejectPromise(new Error(`桥操作超时：${op}`));
    }, timeoutMs);
    host.waiters.set(id, (event) => {
      clearTimeout(timer);
      resolvePromise(event);
    });
    assert.equal(
      bridge.call(JSON.stringify({ id, op, args })),
      undefined,
      'call 只负责发起，必须没有返回值'
    );
  });
}

async function expectOk(bridge, host, op, args) {
  const event = await invoke(bridge, host, op, args);
  assert.equal(event.ok, true, `${op} 失败：${event.ok ? '' : JSON.stringify(event.error)}`);
  return event.data;
}

async function expectFail(bridge, host, op, args) {
  const event = await invoke(bridge, host, op, args);
  assert.equal(event.ok, false, `${op} 本应失败，却返回：${JSON.stringify(event.data)}`);
  assert.equal(typeof event.error.code, 'string');
  assert.equal(typeof event.error.message, 'string');
  assert.ok(event.error.message.length > 0, '错误信息不能为空');
  return event.error;
}

// ------------------------------------------------------------------ 1. vendored isomorphic-git

describe('vendored isomorphic-git UMD', () => {
  test('createRequire 真实加载 1.25.3 UMD 并暴露核心 API', () => {
    globalThis.self = globalThis;
    const moduleExports = nodeRequire(ISO_PATH);
    const git =
      moduleExports && typeof moduleExports.clone === 'function' ? moduleExports : globalThis.git;
    assert.ok(git, 'UMD 应通过 globalThis.git 暴露（Node 把该文件按包作用域当作 ESM 求值，module.exports 为空）');
    for (const api of [
      'clone',
      'fetch',
      'pull',
      'push',
      'status',
      'statusMatrix',
      'log',
      'add',
      'commit',
      'init',
      'currentBranch',
      'resolveRef',
      'getConfig',
      'setConfig',
      'addRemote'
    ]) {
      assert.equal(typeof git[api], 'function', `isomorphic-git 缺少 API：${api}`);
    }
    assert.equal(git.version(), '1.25.3');
    // 版本文件与 vendored 构建一致
    assert.equal(readFileSync(join(GIT_DIR, 'isomorphic-git.VERSION'), 'utf8').trim(), '1.25.3');
    assert.ok(statSync(ISO_PATH).size > 100 * 1024, 'isomorphic-git.js 应为真实构建（>100KB）');
  });
});

// ------------------------------------------------------------------ 2. fs 桥 + 真实仓库

describe('fs 桥（真实 git 仓库）', () => {
  test('init/status/log/currentBranch/resolveRef 都经过宿主代理并读出真实仓库状态', async () => {
    const work = makeTempDir('dsh-git-bridge-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    mkdirSync(repoRoot, { recursive: true });

    // 系统 git 建仓 + 一次提交（身份用 -c，不改全局配置）
    runGit(['init', '-b', 'main', repoRoot], work);
    const seedFile = join(repoRoot, 'devices/pc-a/schedules/2026-11-13.jsonl');
    mkdirSync(dirname(seedFile), { recursive: true });
    writeFileSync(
      seedFile,
      '{"id":"seed-1","ts":"2026-11-13T09:00:00+08:00","title":"种子记录","body":"","author":"pc-a","done":false,"ai_processed":false}\n',
      'utf8'
    );
    runGit(['-C', repoRoot, ...GIT_IDENTITY, 'add', '-A'], work);
    runGit(['-C', repoRoot, ...GIT_IDENTITY, 'commit', '-m', 'pc-a: 初始日程'], work);
    const seedCommit = runGit(['-C', repoRoot, 'rev-parse', 'HEAD'], work).trim();

    const { host, calls } = createFakeHost(repoRoot, () => {
      throw new Error('本用例不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);

    const initData = await expectOk(bridge, host, 'init', {
      branch: 'main',
      deviceId: 'phone-a',
      authorName: '测试设备',
      authorEmail: 'phone-a@localhost'
    });
    assert.equal(initData.initialized, true);
    assert.equal(initData.alreadyInitialized, true, '系统 git 已建仓，桥的 init 应识别为已初始化');
    assert.equal(initData.branch, 'main');
    assert.equal(initData.repoRoot, repoRoot);

    // 通过桥的 fs 适配器写一条日程（isomorphic-git 同一条读写路径）
    const fsAdapter = bridge.getInternalFs();
    const newFile = `${repoRoot}/devices/phone-a/schedules/2026-11-14.jsonl`;
    await fsAdapter.writeFile(
      newFile,
      Buffer.from(
        '{"id":"phone-a-1","ts":"2026-11-14T08:00:00+08:00","title":"手机草稿","body":"","author":"我","done":false,"ai_processed":false}\n',
        'utf8'
      )
    );
    assert.ok(existsSync(newFile), '桥的 writeFile 应真正落盘');
    assert.deepEqual(Array.from(await fsAdapter.readFile(newFile)).length > 0, true);

    const statusData = await expectOk(bridge, host, 'status', {});
    assert.equal(statusData.initialized, true);
    assert.equal(statusData.branch, 'main');
    assert.equal(statusData.head, seedCommit);
    assert.ok(statusData.changedCount >= 1, '应读出未跟踪文件');
    const untracked = statusData.changed.find((row) => row.path === 'devices/phone-a/schedules/2026-11-14.jsonl');
    assert.ok(untracked, `status 应包含新写的日程文件，实际：${JSON.stringify(statusData.changed)}`);
    assert.equal(untracked.head, 0);
    assert.equal(untracked.workdir, 2);
    assert.equal(statusData.lastCommit.message, 'pc-a: 初始日程');

    const logData = await expectOk(bridge, host, 'log', { depth: 5 });
    assert.equal(logData.commits.length, 1);
    assert.equal(logData.commits[0].sha, seedCommit);
    assert.equal(logData.commits[0].message, 'pc-a: 初始日程');
    assert.match(logData.commits[0].time, /^\d{4}-\d{2}-\d{2}T/);

    const branchData = await expectOk(bridge, host, 'currentBranch', {});
    assert.equal(branchData.branch, 'main');
    assert.equal(branchData.initialized, true);

    const refData = await expectOk(bridge, host, 'resolveRef', { ref: 'HEAD' });
    assert.equal(refData.oid, seedCommit);

    // 宿主代理确实被调用，且路径一律使用 '/'（ArkTS 侧统一处理）
    const usedMethods = new Set(calls.map(([name]) => name));
    for (const name of ['getRepoRoot', 'fileExists', 'readFileBase64', 'writeFileBase64', 'readdir', 'stat']) {
      assert.ok(usedMethods.has(name), `桥未通过宿主代理调用 ${name}（实际：${[...usedMethods].join(',')}）`);
    }
    for (const [, path] of calls) {
      if (typeof path === 'string') {
        assert.equal(path.includes('\\'), false, `传给宿主的路径必须是 '/' 分隔：${path}`);
      }
    }

    // 读不存在的文件必须抛 ENOENT（isomorphic-git 依赖该语义判断新文件）
    await assert.rejects(
      () => fsAdapter.readFile(`${repoRoot}/devices/phone-a/schedules/1999-01-01.jsonl`),
      (error) => error.code === 'ENOENT'
    );
  });

  test('在空目录上 init → 生成 .git 配置与 HEAD，status 返回已初始化', async () => {
    const work = makeTempDir('dsh-git-init-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host } = createFakeHost(repoRoot, () => {
      throw new Error('本用例不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);

    const initData = await expectOk(bridge, host, 'init', {
      branch: 'main',
      deviceId: 'pc-b',
      authorName: '空仓测试',
      authorEmail: 'pc-b@localhost'
    });
    assert.equal(initData.initialized, true);
    assert.equal(initData.alreadyInitialized, false);
    assert.equal(initData.head, null, '空仓库还没有提交');
    assert.ok(existsSync(join(repoRoot, '.git/HEAD')), 'init 应写出 .git/HEAD');
    const configText = readFileSync(join(repoRoot, '.git/config'), 'utf8');
    assert.match(configText, /\[core\]/);
    assert.match(configText, /name = 空仓测试/, 'init 应把提交身份写进仓库配置');
    assert.match(configText, /email = pc-b@localhost/);

    const statusData = await expectOk(bridge, host, 'status', {});
    assert.equal(statusData.initialized, true);
    assert.equal(statusData.branch, 'main');
    assert.equal(statusData.head, null);
    assert.equal(statusData.changedCount, 0);
  });

  test('未知 op / 非法 JSON 返回 E_GIT 中文错误且 call 不抛异常', async () => {
    const work = makeTempDir('dsh-git-ops-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host, events } = createFakeHost(repoRoot, () => {
      throw new Error('本用例不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);

    assert.equal(bridge.call(JSON.stringify({ id: 'bad-1', op: 'nope', args: {} })), undefined);
    const unknown = events.find((event) => event.id === 'bad-1');
    assert.ok(unknown, '未知 op 应立即回传错误');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, 'E_GIT');
    assert.match(unknown.error.message, /不支持的操作/);

    assert.equal(bridge.call('{not json'), undefined);
    const invalid = events.find((event) => event.id === null);
    assert.ok(invalid, '非法 JSON 应回传错误');
    assert.equal(invalid.ok, false);
    assert.match(invalid.error.message, /JSON/);

    // 宿主未注册时不得抛异常（没有回传通道，只能静默失败）
    delete globalThis.dshGitHost;
    assert.doesNotThrow(() => bridge.call(JSON.stringify({ id: 'no-host', op: 'status', args: {} })));
    globalThis.dshGitHost = host;
  });
});

// ------------------------------------------------------------------ 3. http 桥

describe('http 桥（不联网，宿主回传伪造响应）', () => {
  test('clone 遇 404：URL/方法正确、statusCode 透传、中文 E_HTTP', async () => {
    const work = makeTempDir('dsh-git-http404-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host, httpRequests } = createFakeHost(repoRoot, (id, options) => ({
      statusCode: 404,
      statusMessage: 'Not Found',
      headers: { 'content-type': 'text/plain' },
      bodyBase64: Buffer.from('not found', 'utf8').toString('base64'),
      url: options.url
    }));
    const bridge = loadBridge(host);

    const error = await expectFail(bridge, host, 'clone', {
      repoUrl: 'https://git.example.invalid/owner/repo.git',
      branch: 'main',
      deviceId: 'phone-a',
      token: FAKE_TOKEN
    });
    assert.equal(error.code, 'E_HTTP');
    assert.match(error.message, /404/);
    assert.equal(error.message.includes(FAKE_TOKEN), false, '错误信息不得包含 token');

    assert.ok(httpRequests.length >= 1, '桥应通过宿主发起 HTTP 请求');
    const first = httpRequests[0].options;
    assert.equal(first.method, 'GET');
    assert.match(first.url, /^https:\/\/git\.example\.invalid\/owner\/repo\.git\/info\/refs\?service=git-upload-pack$/);
    assert.equal(typeof first.headers, 'object');
    assert.equal(existsSync(join(repoRoot, 'devices')), false, '克隆失败不应留下已 checkout 的工作区文件');
  });

  test('401：onAuth 用 x-access-token + token 重试，最终 E_AUTH 且不泄漏 token', async () => {
    const work = makeTempDir('dsh-git-http401-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host, httpRequests } = createFakeHost(repoRoot, (id, options) => ({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      headers: { 'content-type': 'text/plain' },
      bodyBase64: '',
      url: options.url
    }));
    const bridge = loadBridge(host);

    const error = await expectFail(bridge, host, 'clone', {
      repoUrl: 'https://git.example.invalid/owner/private.git',
      branch: 'main',
      deviceId: 'phone-a',
      // 用户名由 ArkTS 侧解析后传入（GitHub 取 x-access-token；Gitee 是登录名）
      username: 'x-access-token',
      token: FAKE_TOKEN
    });
    assert.equal(error.code, 'E_AUTH');
    assert.equal(error.message.includes(FAKE_TOKEN), false, '错误信息不得包含 token');

    assert.equal(httpRequests.length, 2, '首次无认证 401 后应带认证重试一次');
    assert.equal(httpRequests[0].options.headers.authorization, undefined);
    const authorization = httpRequests[1].options.headers.authorization;
    assert.ok(authorization, '重试请求必须带 Authorization');
    assert.match(authorization, /^Basic /);
    const decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
    assert.equal(decoded, `x-access-token:${FAKE_TOKEN}`, 'HTTPS 认证应为 x-access-token:<token>');
  });

  test('无 token 时 401 直接给出 E_AUTH 中文提示（不发空密码重试）', async () => {
    const work = makeTempDir('dsh-git-httpauth-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host, httpRequests } = createFakeHost(repoRoot, (id, options) => ({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      headers: {},
      bodyBase64: '',
      url: options.url
    }));
    const bridge = loadBridge(host);

    const error = await expectFail(bridge, host, 'clone', {
      repoUrl: 'https://git.example.invalid/owner/private.git',
      branch: 'main',
      deviceId: 'phone-a',
      token: ''
    });
    assert.equal(error.code, 'E_AUTH');
    assert.match(error.message, /令牌/);
    assert.equal(httpRequests.length, 1, '没有 token 时不应反复重试');
  });

  test('非 http(s) 远端直接拒绝（不下发请求）', async () => {
    const work = makeTempDir('dsh-git-ssh-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host, httpRequests } = createFakeHost(repoRoot, () => {
      throw new Error('不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);

    const error = await expectFail(bridge, host, 'clone', {
      repoUrl: 'git@github.com:owner/repo.git',
      branch: 'main',
      deviceId: 'phone-a',
      token: FAKE_TOKEN
    });
    assert.equal(error.code, 'E_GIT');
    assert.match(error.message, /HTTPS/);
    assert.equal(httpRequests.length, 0);
  });

  test('clone 失败后隔离半成品 .git，再次 pull 会重新尝试克隆（不会卡死）', async () => {
    const work = makeTempDir('dsh-git-quarantine-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host, httpRequests } = createFakeHost(repoRoot, (id, options) => ({
      statusCode: 404,
      statusMessage: 'Not Found',
      headers: {},
      bodyBase64: '',
      url: options.url
    }));
    const bridge = loadBridge(host);
    const config = {
      repoUrl: 'https://git.example.invalid/owner/repo.git',
      branch: 'main',
      deviceId: 'phone-a',
      token: FAKE_TOKEN
    };

    const first = await expectFail(bridge, host, 'clone', config);
    assert.equal(first.code, 'E_HTTP');
    assert.match(first.message, /已隔离/);
    assert.equal(existsSync(join(repoRoot, '.git')), false, '半成品 .git 应被改名隔离');
    const quarantined = readdirSync(repoRoot).filter((name) => name.indexOf('.git.clone-failed-') === 0);
    assert.equal(quarantined.length, 1);

    const statusData = await expectOk(bridge, host, 'status', config);
    assert.equal(statusData.initialized, false, '隔离后应视为未初始化，可重新克隆');

    const before = httpRequests.length;
    const second = await expectFail(bridge, host, 'pull', config);
    assert.equal(second.code, 'E_HTTP');
    assert.ok(httpRequests.length > before, '第二次 pull 应重新发起 clone 请求');
  });
});

// ------------------------------------------------------------------ 4. push 前置校验

describe('push 的路径限定与前置校验', () => {
  test('未配置 repoUrl → 中文 E_GIT，不触碰网络', async () => {
    const work = makeTempDir('dsh-git-push-nourl-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    mkdirSync(repoRoot, { recursive: true });
    runGit(['init', '-b', 'main', repoRoot], work);
    mkdirSync(join(repoRoot, 'devices/phone-a/schedules'), { recursive: true });
    writeFileSync(join(repoRoot, 'devices/phone-a/schedules/2026-11-14.jsonl'), '{}\n', 'utf8');
    const { host, httpRequests } = createFakeHost(repoRoot, () => {
      throw new Error('不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);

    const error = await expectFail(bridge, host, 'push', {
      branch: 'main',
      deviceId: 'phone-a',
      message: '测试推送'
    });
    assert.equal(error.code, 'E_GIT');
    assert.match(error.message, /repoUrl/);
    assert.equal(httpRequests.length, 0);
  });

  test('仓库未初始化 → 提示先拉取；设备标识非法 → E_GIT', async () => {
    const work = makeTempDir('dsh-git-push-noinit-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host } = createFakeHost(repoRoot, () => {
      throw new Error('不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);

    const statusBefore = await expectOk(bridge, host, 'status', {
      repoUrl: 'https://git.example.invalid/owner/repo.git',
      branch: 'main',
      deviceId: 'phone-a'
    });
    assert.equal(statusBefore.initialized, false);
    assert.equal(statusBefore.config.hasToken, false);
    assert.equal(statusBefore.config.branch, 'main');

    const notInitialized = await expectFail(bridge, host, 'push', {
      repoUrl: 'https://git.example.invalid/owner/repo.git',
      branch: 'main',
      deviceId: 'phone-a',
      token: FAKE_TOKEN,
      message: '测试推送'
    });
    assert.equal(notInitialized.code, 'E_GIT');
    assert.match(notInitialized.message, /尚未初始化/);
  });

  test('设备标识不合规时不接受（即使仓库已初始化）', async () => {
    const work = makeTempDir('dsh-git-push-device-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    mkdirSync(repoRoot, { recursive: true });
    runGit(['init', '-b', 'main', repoRoot], work);
    const { host, httpRequests } = createFakeHost(repoRoot, () => {
      throw new Error('不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);

    const error = await expectFail(bridge, host, 'push', {
      repoUrl: 'https://git.example.invalid/owner/repo.git',
      branch: 'main',
      deviceId: 'Phone_A',
      token: FAKE_TOKEN,
      message: '测试推送'
    });
    assert.equal(error.code, 'E_GIT');
    assert.match(error.message, /deviceId/);
    assert.equal(httpRequests.length, 0, '设备标识校验在联网之前');
  });

  test('push 只 add+commit 本设备目录：其它设备的未提交改动不进入提交；远端 404 转 E_HTTP', async () => {
    const work = makeTempDir('dsh-git-push-scope-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    mkdirSync(repoRoot, { recursive: true });
    runGit(['init', '-b', 'main', repoRoot], work);
    mkdirSync(join(repoRoot, 'devices/pc-a/schedules'), { recursive: true });
    mkdirSync(join(repoRoot, 'devices/phone-a/schedules'), { recursive: true });
    writeFileSync(join(repoRoot, 'devices/pc-a/schedules/2026-11-13.jsonl'), '{"id":"pc-a-1"}\n', 'utf8');
    writeFileSync(join(repoRoot, 'devices/phone-a/schedules/2026-11-14.jsonl'), '{"id":"phone-a-1"}\n', 'utf8');
    runGit(['-C', repoRoot, ...GIT_IDENTITY, 'add', '-A'], work);
    runGit(['-C', repoRoot, ...GIT_IDENTITY, 'commit', '-m', '初始提交'], work);
    runGit(['-C', repoRoot, 'remote', 'add', 'origin', 'https://git.example.invalid/owner/repo.git'], work);

    // 另一台设备目录有未提交改动：push 必须无视它
    writeFileSync(join(repoRoot, 'devices/pc-a/schedules/2026-11-13.jsonl'), '{"id":"pc-a-1"}\n{"id":"pc-a-2"}\n', 'utf8');
    // 本设备目录新增一条
    writeFileSync(
      join(repoRoot, 'devices/phone-a/schedules/2026-11-14.jsonl'),
      '{"id":"phone-a-1"}\n{"id":"phone-a-2"}\n',
      'utf8'
    );

    const { host, httpRequests } = createFakeHost(repoRoot, (id, options) => ({
      statusCode: 404,
      statusMessage: 'Not Found',
      headers: {},
      bodyBase64: '',
      url: options.url
    }));
    const bridge = loadBridge(host);

    const error = await expectFail(bridge, host, 'push', {
      repoUrl: 'https://git.example.invalid/owner/repo.git',
      branch: 'main',
      deviceId: 'phone-a',
      token: FAKE_TOKEN,
      authorName: '手机 A',
      authorEmail: 'phone-a@localhost',
      message: 'phone-a: 提交日程'
    });
    assert.equal(error.code, 'E_HTTP');
    assert.match(error.message, /404/);
    assert.equal(error.message.includes(FAKE_TOKEN), false);
    assert.ok(httpRequests.length >= 1);

    // 本地确实产生了一次提交，且只包含本设备目录
    const headMessage = runGit(['-C', repoRoot, 'log', '-1', '--pretty=%s'], work).trim();
    assert.equal(headMessage, 'phone-a: 提交日程');
    const changedFiles = runGit(['-C', repoRoot, 'show', '--name-only', '--pretty=format:', 'HEAD'], work)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    assert.deepEqual(changedFiles, ['devices/phone-a/schedules/2026-11-14.jsonl']);
    const porcelain = runGit(['-C', repoRoot, 'status', '--porcelain'], work);
    assert.match(porcelain, /devices\/pc-a\/schedules\/2026-11-13\.jsonl/, '其它设备的改动必须仍是未提交状态');
    assert.doesNotMatch(porcelain, /devices\/phone-a\//, '本设备目录已提交，不应残留改动');
  });
});

// ------------------------------------------------------------------ 4b. fetch / pull 失败转中文

describe('fetch / pull 的远端错误处理', () => {
  test('pull 遇 404 报 E_HTTP，HEAD 保持不变（不丢本地提交）', async () => {
    const work = makeTempDir('dsh-git-pull404-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    mkdirSync(repoRoot, { recursive: true });
    runGit(['init', '-b', 'main', repoRoot], work);
    mkdirSync(join(repoRoot, 'devices/phone-a/schedules'), { recursive: true });
    writeFileSync(join(repoRoot, 'devices/phone-a/schedules/2026-11-14.jsonl'), '{"id":"a"}\n', 'utf8');
    runGit(['-C', repoRoot, ...GIT_IDENTITY, 'add', '-A'], work);
    runGit(['-C', repoRoot, ...GIT_IDENTITY, 'commit', '-m', '本地提交'], work);
    runGit(['-C', repoRoot, 'remote', 'add', 'origin', 'https://git.example.invalid/owner/repo.git'], work);
    const headBefore = runGit(['-C', repoRoot, 'rev-parse', 'HEAD'], work).trim();

    const { host, httpRequests } = createFakeHost(repoRoot, (id, options) => ({
      statusCode: 404,
      statusMessage: 'Not Found',
      headers: {},
      bodyBase64: '',
      url: options.url
    }));
    const bridge = loadBridge(host);

    const error = await expectFail(bridge, host, 'pull', {
      repoUrl: 'https://git.example.invalid/owner/repo.git',
      branch: 'main',
      deviceId: 'phone-a',
      token: FAKE_TOKEN
    });
    assert.equal(error.code, 'E_HTTP');
    assert.match(error.message, /404/);
    assert.ok(httpRequests.length >= 1);
    assert.equal(runGit(['-C', repoRoot, 'rev-parse', 'HEAD'], work).trim(), headBefore);
    assert.equal(readFileSync(join(repoRoot, 'devices/phone-a/schedules/2026-11-14.jsonl'), 'utf8'), '{"id":"a"}\n');

    const fetchError = await expectFail(bridge, host, 'fetch', {
      repoUrl: 'https://git.example.invalid/owner/repo.git',
      branch: 'main',
      token: FAKE_TOKEN
    });
    assert.equal(fetchError.code, 'E_HTTP');
  });
});

// ------------------------------------------------------------------ 5. index.html / node --check

describe('rawfile 静态契约', () => {
  test('index.html 按顺序加载三个脚本（isomorphic-git → jszip → git-bridge）并暴露 DshGitBridge', () => {
    const html = readFileSync(HTML_PATH, 'utf8');
    const matches = [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)];
    const scripts = matches.map((match) => match[1]);
    assert.deepEqual(
      scripts,
      ['isomorphic-git.js', 'jszip.min.js', 'git-bridge.js'],
      '脚本顺序固定：isomorphic-git → jszip（附件按天 zip）→ git-bridge'
    );
    assert.ok(matches[0].index < matches[1].index && matches[1].index < matches[2].index, '三个脚本必须先 git 后 jszip 再 bridge');
    assert.match(html, /DshGitBridge\.call/, 'index.html 必须引用 window.DshGitBridge');
    assert.match(html, /__dshGitBridgeReady/, 'index.html 应提供就绪自检标志');
    for (const script of scripts) {
      assert.ok(existsSync(join(GIT_DIR, script)), `index.html 引用的脚本不存在：${script}`);
    }
  });

  test('两个 rawfile JS 通过 node --check', () => {
    for (const file of [ISO_PATH, BRIDGE_PATH]) {
      execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
  });
});

// ------------------------------------------------------------------ 6. 内部纯函数

describe('桥内部工具', () => {
  const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, index) => index);

  test('base64 编解码零依赖且可逆', () => {
    const work = makeTempDir('dsh-git-b64-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host } = createFakeHost(repoRoot, () => {
      throw new Error('不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);
    const { bytesToBase64, base64ToBytes } = bridge.internals;

    assert.equal(bytesToBase64(new Uint8Array(0)), '');
    assert.equal(bytesToBase64(Uint8Array.from([0x66])), 'Zg==');
    assert.equal(bytesToBase64(Uint8Array.from([0x66, 0x6f])), 'Zm8=');
    assert.equal(bytesToBase64(Uint8Array.from([0x66, 0x6f, 0x6f])), 'Zm9v');
    for (const length of [0, 1, 2, 3, 4, 5, 100, 256]) {
      const input = ALL_BYTES.subarray(0, length);
      assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(input))), Array.from(input));
    }
    assert.equal(Buffer.from(bytesToBase64(ALL_BYTES), 'base64').compare(Buffer.from(ALL_BYTES)), 0);
  });

  test('utf8 编解码与 Node Buffer 一致（含中文与 emoji）', () => {
    const work = makeTempDir('dsh-git-utf8-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host } = createFakeHost(repoRoot, () => {
      throw new Error('不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);
    const { utf8Encode, utf8Decode } = bridge.internals;

    for (const text of ['', 'hello', '日程助手', '周会 09:30 🚀', '混合 mixed 中文 \n\t']) {
      const encoded = utf8Encode(text);
      assert.deepEqual(Buffer.from(encoded), Buffer.from(text, 'utf8'));
      assert.equal(utf8Decode(encoded), text);
    }
  });

  test('HTTP 请求体收集：支持 Uint8Array / 字符串 / 异步迭代器（push 的 packfile 路径）', async () => {
    const work = makeTempDir('dsh-git-body-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host } = createFakeHost(repoRoot, () => {
      throw new Error('不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);
    const { collectBody } = bridge.internals;

    assert.deepEqual(Array.from(await collectBody(undefined)), []);
    assert.deepEqual(Array.from(await collectBody(Uint8Array.from([1, 2, 3]))), [1, 2, 3]);
    assert.deepEqual(Array.from(await collectBody('abc')), Array.from(Buffer.from('abc', 'utf8')));

    const chunks = [Uint8Array.from([1, 2]), Uint8Array.from([3]), Uint8Array.from([]), Uint8Array.from([4, 5])];
    async function* stream() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    assert.deepEqual(Array.from(await collectBody(stream())), [1, 2, 3, 4, 5]);

    function* syncStream() {
      yield Uint8Array.from([9, 8]);
      yield Uint8Array.from([7]);
    }
    assert.deepEqual(Array.from(await collectBody(syncStream())), [9, 8, 7]);
  });

  test('HTTP 响应体流：asyncIterator 只产出一块 Uint8Array 并正常结束', async () => {
    const work = makeTempDir('dsh-git-stream-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host } = createFakeHost(repoRoot, () => {
      throw new Error('不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);
    const { byteStream } = bridge.internals;

    const collected = [];
    for await (const chunk of byteStream(Uint8Array.from([5, 6, 7]))) {
      collected.push(...Array.from(chunk));
    }
    assert.deepEqual(collected, [5, 6, 7]);

    const empty = [];
    for await (const chunk of byteStream(new Uint8Array(0))) {
      empty.push(...Array.from(chunk));
    }
    assert.deepEqual(empty, [], '空响应体不应产出数据块');
  });

  test('JSONL 按行求并集：保留远端行、追加本地独有行、完全相同的行去重', () => {
    const work = makeTempDir('dsh-git-union-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host } = createFakeHost(repoRoot, () => {
      throw new Error('不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);
    const { unionJsonl } = bridge.internals;

    assert.equal(unionJsonl('', ''), '');
    assert.equal(unionJsonl('{"id":"a"}\n', ''), '{"id":"a"}\n');
    assert.equal(unionJsonl('{"id":"a"}\n{"id":"b"}\n', '{"id":"b"}\n{"id":"c"}\n'), '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n');
    // 同一 id 的两个版本（不同行文本）都保留，交给 foldById 按 ts 折叠
    const older = '{"id":"x","ts":"2026-11-14T08:00:00+08:00"}';
    const newer = '{"id":"x","ts":"2026-11-14T09:00:00+08:00"}';
    assert.equal(unionJsonl(older + '\n', newer + '\n'), older + '\n' + newer + '\n');
    assert.equal(unionJsonl('\n\n', '\n'), '');
  });

  test('clone 前的本地设备文件快照 + clone 后补回（缺失写回、jsonl 求并集、附件保留远端）', async () => {
    const work = makeTempDir('dsh-git-restore-');
    const repoRoot = toPosix(join(work, 'git-repo'));
    const { host, calls } = createFakeHost(repoRoot, () => {
      throw new Error('不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);
    bridge.getInternalFs(); // 建立会话（repoRoot 生效）

    const schedulesDir = join(repoRoot, 'devices/phone-a/schedules');
    const attachmentsDir = join(repoRoot, 'devices/phone-a/attachments');
    mkdirSync(schedulesDir, { recursive: true });
    mkdirSync(attachmentsDir, { recursive: true });

    const localDay = join(schedulesDir, '2026-11-14.jsonl');
    writeFileSync(localDay, '{"id":"local-only"}\n{"id":"both"}\n', 'utf8');
    const localAttachment = join(attachmentsDir, 'abc123.png');
    writeFileSync(localAttachment, Buffer.from([1, 2, 3]));

    const backup = bridge.internals.snapshotDeviceFiles('phone-a');
    assert.deepEqual(
      backup.map((item) => item.relative).sort(),
      ['devices/phone-a/attachments/abc123.png', 'devices/phone-a/schedules/2026-11-14.jsonl']
    );

    // 模拟 clone：远端同名日程只有 both，本地独有行必须被补回；附件被远端“覆盖”
    writeFileSync(localDay, '{"id":"both"}\n', 'utf8');
    writeFileSync(localAttachment, Buffer.from([9, 9, 9]));

    const report = bridge.internals.restoreDeviceFiles(backup);
    assert.deepEqual(report.unioned, ['devices/phone-a/schedules/2026-11-14.jsonl']);
    assert.deepEqual(report.kept, ['devices/phone-a/attachments/abc123.png']);
    assert.equal(readFileSync(localDay, 'utf8'), '{"id":"both"}\n{"id":"local-only"}\n');
    assert.deepEqual(Array.from(readFileSync(localAttachment)), [9, 9, 9], '附件按 sha256 命名，保留远端版本');

    // 远端缺失的文件整体写回
    unlinkSync(localDay);
    const secondReport = bridge.internals.restoreDeviceFiles(backup);
    assert.ok(secondReport.restored.includes('devices/phone-a/schedules/2026-11-14.jsonl'));
    assert.equal(readFileSync(localDay, 'utf8'), '{"id":"local-only"}\n{"id":"both"}\n');
    assert.ok(calls.some(([name]) => name === 'writeFileBase64'));
  });
});

// ------------------------------------------------------------------ 8. 设备登记表提交（commitPaths）
//
// 设备编号自动分配要往 `devices/registry.jsonl` 追加一行（与本机目录同级，不在
// `devices/<deviceId>/` 内），所以桥开了一个**白名单**提交通道：只允许这一个文件。
// 越权路径必须在**发请求前**被拒，否则「本机只写自己目录」的数据边界就破了。

describe('设备登记表提交（commitPaths）：白名单 + 只动 registry.jsonl', () => {
  test('supportedOps 暴露 commitPaths；白名单只有 devices/registry.jsonl', () => {
    const repoRoot = toPosix(join(makeTempDir('dsh-git-cp0-'), 'git-repo'));
    const { host } = createFakeHost(repoRoot, () => {
      throw new Error('本用例不应发起 HTTP 请求');
    });
    const bridge = loadBridge(host);
    assert.ok(bridge.supportedOps.includes('commitPaths'), '桥必须支持 commitPaths');
    assert.deepEqual(bridge.internals.commitPathWhitelist, ['devices/registry.jsonl'], '白名单只放行登记表');
    assert.equal(typeof bridge.internals.commitPaths, 'function', 'internals 里要能直接调到实现');
  });

  test('越权路径（别人的设备目录 / 仓库根文件 / 上级目录）一律 E_GIT 且不发请求', async () => {
    const repoRoot = toPosix(join(makeTempDir('dsh-git-cp1-'), 'git-repo'));
    mkdirSync(repoRoot, { recursive: true });
    runGit(['init', '-b', 'main'], repoRoot);
    const { host, httpRequests } = createFakeHost(repoRoot, () => {
      throw new Error('越权路径不该发请求');
    });
    const bridge = loadBridge(host);
    const badPaths = [
      'devices/device-1/schedules/2026-11-18.jsonl',
      'README.md',
      '../escape.txt',
      'devices/registry.jsonl,devices/device-2/x.jsonl'
    ];
    for (const paths of badPaths) {
      const error = await expectFail(bridge, host, 'commitPaths', {
        repoUrl: 'https://git.example.invalid/o/r.git',
        branch: 'main',
        paths
      });
      assert.equal(error.code, 'E_GIT', `路径 ${paths} 必须被拒`);
      assert.match(error.message, /只允许提交/);
    }
    assert.equal(httpRequests.length, 0, '越权必须在联网前被拦住');
  });

  test('文件不存在 → E_FS（宁可不提交，也不提交半套）', async () => {
    const repoRoot = toPosix(join(makeTempDir('dsh-git-cp2-'), 'git-repo'));
    mkdirSync(repoRoot, { recursive: true });
    runGit(['init', '-b', 'main'], repoRoot);
    const { host } = createFakeHost(repoRoot, () => {
      throw new Error('文件缺失不该发请求');
    });
    const bridge = loadBridge(host);
    const error = await expectFail(bridge, host, 'commitPaths', {
      repoUrl: 'https://git.example.invalid/o/r.git',
      branch: 'main',
      paths: 'devices/registry.jsonl'
    });
    assert.equal(error.code, 'E_FS');
    assert.match(error.message, /待提交的文件不存在/);
  });

  test('未初始化仓库 → 中文 E_GIT（先拉取再登记，不给半成品提交）', async () => {
    const repoRoot = toPosix(join(makeTempDir('dsh-git-cp3-'), 'git-repo'));
    const { host } = createFakeHost(repoRoot, () => {
      throw new Error('未初始化不该发请求');
    });
    const bridge = loadBridge(host);
    const error = await expectFail(bridge, host, 'commitPaths', {
      repoUrl: 'https://git.example.invalid/o/r.git',
      branch: 'main',
      paths: 'devices/registry.jsonl'
    });
    assert.equal(error.code, 'E_GIT');
    assert.match(error.message, /尚未初始化/);
  });
});
