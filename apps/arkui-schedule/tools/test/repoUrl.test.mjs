// 仓库地址校验 + 设置页表单规则（`model/repoUrl.ts` / `model/settingsForm.ts`）测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 重点：仓库地址是**用户手输的不可信输入**（缺 host、缺路径、夹空格、带 token、乱协议），
// 校验必须 fail-closed 并给中文原因；通过时只做 trim，不擅自增删 `.git`。
// 这两个模块没有任何运行时 import，因此不需要 registerHooks 补 `.js` 后缀。
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, test } from 'node:test';

// settingsForm.ts 已开始 import ./aiProvider（运行时依赖），编译产物里是**无后缀**的 ESM 说明符，
// 必须补 .js 才能被 Node 解析（与 pageBook / draft 等测试同一套 hook）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.js')
      ) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  }
});

const { describeRepoProbe, repoProbeUrl, validateRepoUrl } = await import('../.build/model/repoUrl.js');
const {
  AUTH_HTTPS,
  AUTH_SSH,
  PLATFORM_GITHUB,
  PLATFORM_GITEE,
  authHint,
  normalizeAuthMode,
  normalizePlatform,
  repoUrlExamples,
  repoUrlPlaceholder,
  validateAuthorName,
  validateDeviceIdText,
  validateToken
} = await import('../.build/model/settingsForm.js');

/** 断言校验失败且给了中文原因。 */
function assertRejected(raw, keyword) {
  const result = validateRepoUrl(raw);
  assert.equal(result.ok, false, `应拒绝：${JSON.stringify(raw)}`);
  assert.ok(result.error.length > 0, '失败必须给中文原因');
  assert.equal(result.url, '', '失败时 url 必须为空串');
  if (keyword !== undefined) {
    assert.match(result.error, keyword, `错误文案不匹配：${result.error}`);
  }
  return result;
}

describe('validateRepoUrl：接受的四种形态', () => {
  test('https://github.com/user/repo.git → https / host / 去掉 .git 的路径', () => {
    const result = validateRepoUrl('https://github.com/user/repo.git');
    assert.equal(result.ok, true);
    assert.equal(result.scheme, 'https');
    assert.equal(result.host, 'github.com');
    assert.equal(result.repoPath, 'user/repo');
    assert.equal(result.url, 'https://github.com/user/repo.git', '保存值保留用户原文（含 .git）');
    assert.equal(result.error, '');
  });

  test('末尾没有 .git 也接受，且 url 不被追加后缀', () => {
    const result = validateRepoUrl('https://github.com/user/repo');
    assert.equal(result.ok, true);
    assert.equal(result.repoPath, 'user/repo');
    assert.equal(result.url, 'https://github.com/user/repo');
  });

  test('首尾空白被 trim，内部原文保留', () => {
    const result = validateRepoUrl('   https://github.com/user/repo.git  \n');
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://github.com/user/repo.git');
  });

  test('http:// 也被接受（自建 gitlab / 内网仓库）', () => {
    const result = validateRepoUrl('http://gitlab.example.com/team/app.git');
    assert.equal(result.ok, true);
    assert.equal(result.scheme, 'http');
    assert.equal(result.host, 'gitlab.example.com');
    assert.equal(result.repoPath, 'team/app');
  });

  test('ssh://git@host/path 形式', () => {
    const result = validateRepoUrl('ssh://git@github.com/user/repo.git');
    assert.equal(result.ok, true);
    assert.equal(result.scheme, 'ssh');
    assert.equal(result.host, 'github.com');
    assert.equal(result.repoPath, 'user/repo');
  });

  test('git@host:path（scp 形式）与带端口的 ssh', () => {
    const scp = validateRepoUrl('git@github.com:user/repo.git');
    assert.equal(scp.ok, true);
    assert.equal(scp.scheme, 'scp');
    assert.equal(scp.host, 'github.com');
    assert.equal(scp.repoPath, 'user/repo');

    const gitee = validateRepoUrl('git@gitee.com:someone/schedule');
    assert.equal(gitee.ok, true);
    assert.equal(gitee.host, 'gitee.com');
    assert.equal(gitee.repoPath, 'someone/schedule');

    const withPort = validateRepoUrl('ssh://git@example.com:2222/team/repo.git');
    assert.equal(withPort.ok, true);
    assert.equal(withPort.host, 'example.com');
    assert.equal(withPort.repoPath, 'team/repo');
  });

  test('localhost + 端口（本地测试仓库）', () => {
    const result = validateRepoUrl('http://localhost:8080/repo.git');
    assert.equal(result.ok, true);
    assert.equal(result.host, 'localhost');
    assert.equal(result.repoPath, 'repo');
  });

  test('幂等：通过后把结果 url 再校验一次仍通过且不变', () => {
    const first = validateRepoUrl(' https://github.com/user/repo.git ');
    const second = validateRepoUrl(first.url);
    assert.equal(second.ok, true);
    assert.equal(second.url, first.url);
    assert.equal(second.repoPath, first.repoPath);
  });
});

describe('validateRepoUrl：明显非法的输入给中文错误', () => {
  test('空串与纯空白', () => {
    assertRejected('', /不能为空/);
    assertRejected('   ', /不能为空/);
    assertRejected(null, /不能为空/);
    assertRejected(undefined, /不能为空/);
  });

  test('内部空白（含制表符/全角空格）', () => {
    assertRejected('https://github.com/user /repo.git', /空格/);
    assertRejected('https://git hub.com/user/repo', /空格/);
    assertRejected('https://github.com/user/repo\t.git', /空格/);
    assertRejected('https://github.com/user\u3000/repo', /空格/);
  });

  test('https:// 后面没东西 / 缺 host / 缺路径', () => {
    assertRejected('https://', /缺少域名/);
    assertRejected('http://', /缺少域名/);
    assertRejected('ssh://', /缺少域名/);
    assertRejected('https://github.com', /缺少路径/);
    assertRejected('https://github.com/', /缺少路径/);
    assertRejected('git@github.com', /git@/);
    assertRejected('git@:user/repo.git', /git@/);
  });

  test('没有协议前缀 / 不支持的协议 / 明显不是地址', () => {
    assertRejected('github.com/user/repo', /https:\/\//);
    assertRejected('ftp://github.com/user/repo.git', /不支持的协议/);
    assertRejected('file:///c:/repo', /不支持的协议/);
    assertRejected('../../../etc/passwd', /https:\/\//);
    assertRejected('just some text', /空格/);
  });

  test('地址里带账号密码/token 一律拒绝（认证信息另填）', () => {
    assertRejected('https://user:ghp_secret@github.com/user/repo.git', /token/);
    assertRejected('https://ghp_secret@github.com/user/repo.git', /token/);
  });

  test('域名不像域名（无点且不是 localhost）', () => {
    assertRejected('https://github/repo.git', /缺少有效域名/);
    assertRejected('git@github:user/repo.git', /缺少有效域名/);
  });
});

describe('repoProbeUrl / describeRepoProbe：测试连接的纯逻辑', () => {
  test('https 地址拼出 Git smart-HTTP 探测 URL（保留 .git）', () => {
    assert.equal(
      repoProbeUrl('https://github.com/user/repo.git'),
      'https://github.com/user/repo.git/info/refs?service=git-upload-pack'
    );
    assert.equal(
      repoProbeUrl(' https://github.com/user/repo/ '),
      'https://github.com/user/repo/info/refs?service=git-upload-pack'
    );
  });

  test('ssh/scp 与非法地址没有 HTTP 探测地址', () => {
    assert.equal(repoProbeUrl('git@github.com:user/repo.git'), '');
    assert.equal(repoProbeUrl('ssh://git@github.com/user/repo.git'), '');
    assert.equal(repoProbeUrl(''), '');
    assert.equal(repoProbeUrl('https://'), '');
  });

  test('探测结果文案：可达 / 认证失败 / 不存在 / 网络错误', () => {
    assert.match(describeRepoProbe(200, ''), /可达/);
    assert.match(describeRepoProbe(401, ''), /认证失败/);
    assert.match(describeRepoProbe(403, ''), /认证失败/);
    assert.match(describeRepoProbe(404, ''), /404/);
    assert.match(describeRepoProbe(404, ''), /不可达/);
    assert.match(describeRepoProbe(503, ''), /不可达/);
    assert.match(describeRepoProbe(0, '域名解析失败'), /域名解析失败/);
    assert.match(describeRepoProbe(0, ''), /没有拿到 HTTP 响应/);
  });
});

describe('settingsForm：平台/认证文案', () => {
  test('normalizePlatform / normalizeAuthMode 对未知值回退默认', () => {
    assert.equal(normalizePlatform('gitee'), PLATFORM_GITEE);
    assert.equal(normalizePlatform(' GitHub '), PLATFORM_GITHUB);
    assert.equal(normalizePlatform('gitlab'), PLATFORM_GITHUB);
    assert.equal(normalizePlatform(''), PLATFORM_GITHUB);
    assert.equal(normalizeAuthMode('ssh'), AUTH_SSH);
    assert.equal(normalizeAuthMode('SSH'), AUTH_SSH);
    assert.equal(normalizeAuthMode('token'), AUTH_HTTPS);
    assert.equal(normalizeAuthMode(''), AUTH_HTTPS);
  });

  test('仓库地址占位符随平台/认证方式变化', () => {
    assert.equal(repoUrlPlaceholder(PLATFORM_GITHUB, AUTH_HTTPS), 'https://github.com/<用户名>/<仓库名>.git');
    assert.equal(repoUrlPlaceholder(PLATFORM_GITEE, AUTH_HTTPS), 'https://gitee.com/<用户名>/<仓库名>.git');
    assert.equal(repoUrlPlaceholder(PLATFORM_GITHUB, AUTH_SSH), 'git@github.com:<用户名>/<仓库名>.git');
    assert.equal(repoUrlPlaceholder(PLATFORM_GITEE, AUTH_SSH), 'git@gitee.com:<用户名>/<仓库名>.git');
  });

  test('SSH 示例说明依赖 ssh-agent、不保存私钥；HTTPS 说明 token', () => {
    const sshText = repoUrlExamples(PLATFORM_GITHUB, AUTH_SSH);
    assert.match(sshText, /git@github\.com:user\/repo\.git/);
    assert.match(sshText, /ssh-agent/);
    assert.match(sshText, /私钥/);

    const httpsText = repoUrlExamples(PLATFORM_GITEE, AUTH_HTTPS);
    assert.match(httpsText, /https:\/\/gitee\.com\/user\/repo\.git/);
    assert.match(httpsText, /token/);
    assert.match(httpsText, /\.git 可有可无/);
  });

  test('authHint：SSH 说明可留空 token 且同步内核只支持 HTTPS', () => {
    assert.match(authHint(AUTH_SSH), /ssh-agent/);
    assert.match(authHint(AUTH_SSH), /可以留空/);
    assert.match(authHint(AUTH_SSH), /HTTPS/);
    assert.match(authHint(AUTH_HTTPS), /必须填写 token/);
  });
});

describe('settingsForm：设备标识 / 作者名 / token 校验', () => {
  test('设备标识：非空、≥3、无空白与斜杠、合法字符', () => {
    assert.equal(validateDeviceIdText('phone-a'), '');
    assert.equal(validateDeviceIdText('  pad-01  '), '');
    assert.match(validateDeviceIdText(''), /不能为空/);
    assert.match(validateDeviceIdText('   '), /不能为空/);
    assert.match(validateDeviceIdText('ab'), /至少/);
    assert.match(validateDeviceIdText('phon e'), /空格/);
    assert.match(validateDeviceIdText('phone/a'), /斜杠/);
    assert.match(validateDeviceIdText('phone\\a'), /斜杠/);
    assert.match(validateDeviceIdText('Phone-A'), /小写字母/);
    assert.match(validateDeviceIdText('-phone'), /小写字母/);
    assert.match(validateDeviceIdText('a'.repeat(33)), /最长/);
  });

  test('作者名：非空、最长 32', () => {
    assert.equal(validateAuthorName('我'), '');
    assert.match(validateAuthorName(''), /不能为空/);
    assert.match(validateAuthorName('   '), /不能为空/);
    assert.match(validateAuthorName('a'.repeat(33)), /最长/);
  });

  test('token：HTTPS 必填，SSH 可空，含空白拒绝', () => {
    assert.equal(validateToken(AUTH_HTTPS, 'ghp_abc'), '');
    assert.match(validateToken(AUTH_HTTPS, ''), /HTTPS 认证需要 token/);
    assert.match(validateToken(AUTH_HTTPS, '   '), /HTTPS 认证需要 token/);
    assert.match(validateToken(AUTH_HTTPS, 'ghp abc'), /空格/);
    assert.equal(validateToken(AUTH_SSH, ''), '');
    assert.equal(validateToken(AUTH_SSH, 'anything'), '');
  });
});
