// Git HTTPS 用户名解析（P0 线上问题回归）：Gitee 写死 x-access-token 必然 401。
//
// 锁死四件事：
//   ① Gitee + 空用户名 → 报错（且同步入口不会发请求，见 GitSyncService.validateForSync 的断言）；
//   ② Gitee + 有用户名 → 用户名被采用；
//   ③ GitHub 留空 → 仍是 x-access-token；
//   ④ token 不出现在任何日志字符串里（describeAuthForLog 只显示 ***）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..');

const {
  resolveGitUsername,
  assertHttpsUsername,
  describeAuthForLog,
  GITHUB_TOKEN_USERNAME,
  GITEE_USERNAME_REQUIRED
} = await import('../.build/model/gitAuth.js');

const GIT_SERVICE = readFileSync(join(appRoot, 'entry', 'src', 'main', 'ets', 'services', 'GitSyncService.ets'), 'utf8');
const BRIDGE = readFileSync(
  join(appRoot, 'entry', 'src', 'main', 'resources', 'rawfile', 'git', 'git-bridge.js'),
  'utf8'
);

describe('resolveGitUsername：HTTPS 认证用户名', () => {
  test('② Gitee + 填了用户名 → 用用户的（trim）', () => {
    assert.equal(resolveGitUsername('gitee', '  zhangsan  '), 'zhangsan');
    assert.equal(resolveGitUsername('gitee', 'li.si@example.com'), 'li.si@example.com');
  });

  test('① Gitee + 空用户名 → 空串（**绝不**兜底 x-access-token，否则必然 401）', () => {
    for (const empty of ['', '   ', '\t']) {
      assert.equal(resolveGitUsername('gitee', empty), '');
    }
    assert.notEqual(resolveGitUsername('gitee', ''), GITHUB_TOKEN_USERNAME, 'Gitee 不得回落到 x-access-token');
  });

  test('③ GitHub 留空 → x-access-token（GitHub 对 PAT 的约定用户名）', () => {
    assert.equal(resolveGitUsername('github', ''), 'x-access-token');
    assert.equal(resolveGitUsername('', ''), 'x-access-token', '平台未知时按 GitHub 处理');
  });

  test('用户填了名字时优先于平台默认值（GitHub 也可用真实用户名）', () => {
    assert.equal(resolveGitUsername('github', 'octocat'), 'octocat');
  });
});

describe('assertHttpsUsername：发请求前的可读错误', () => {
  test('① Gitee + https + 空用户名 → 返回中文错误文案', () => {
    const problem = assertHttpsUsername('gitee', 'https', '');
    assert.equal(problem, GITEE_USERNAME_REQUIRED);
    assert.match(problem, /Gitee/);
    assert.match(problem, /用户名/);
    assert.match(problem, /token/);
  });

  test('② Gitee + 有用户名 → null（放行）', () => {
    assert.equal(assertHttpsUsername('gitee', 'https', 'zhangsan'), null);
  });

  test('③ GitHub + 空用户名 → null（放行，用 x-access-token）', () => {
    assert.equal(assertHttpsUsername('github', 'https', ''), null);
  });

  test('SSH 模式下不重复报错（另有校验负责）', () => {
    assert.equal(assertHttpsUsername('gitee', 'ssh', ''), null);
  });
});

describe('describeAuthForLog：日志里不得出现 token', () => {
  test('④ token 只显示为 ***，用户名可读', () => {
    const line = describeAuthForLog('gitee', 'zhangsan', true);
    assert.match(line, /username=zhangsan/);
    assert.match(line, /token=\*\*\*/);
  });

  test('④ 空 token / 空用户名都可读，不含 undefined', () => {
    const line = describeAuthForLog('gitee', '', false);
    assert.equal(line.includes('undefined'), false);
    assert.match(line, /token=\(空\)/);
    assert.match(line, /未填写用户名/);
  });
});

describe('三处硬编码是否清零（源码级断言）', () => {
  test('GitSyncService：Basic header 用 authUsername()，不再写死 x-access-token', () => {
    assert.equal(
      /'Basic '\s*\+\s*this\.base64Text\('x-access-token:'/.test(GIT_SERVICE),
      false,
      'Basic header 不得再写死 x-access-token'
    );
    assert.match(GIT_SERVICE, /this\.base64Text\(this\.authUsername\(\) \+ ':' \+ this\.config\.token\)/);
    assert.match(GIT_SERVICE, /'username': this\.authUsername\(\)/, '桥的 onAuth 用户名必须通过 args 传下去');
  });

  test('GitSyncService：Gitee 缺用户名在 validateForSync 里被拦住（不发请求）', () => {
    assert.match(GIT_SERVICE, /assertHttpsUsername\(/);
    const index = GIT_SERVICE.indexOf('assertHttpsUsername(');
    const probe = GIT_SERVICE.indexOf('probeRemote');
    assert.ok(index > 0 && probe > 0, '两个符号都应存在');
  });

  test('git-bridge.js：onAuth 用传入的 username，不再硬编码', () => {
    assert.equal(/return \{ username: 'x-access-token', password: token \};/.test(BRIDGE), false, '桥里不得再硬编码');
    assert.match(BRIDGE, /var username = config && config\.username;/);
    assert.match(BRIDGE, /return \{ username: username, password: token \};/);
    assert.match(BRIDGE, /'username'/, 'CONFIG_KEYS 必须放行 username');
  });
});
