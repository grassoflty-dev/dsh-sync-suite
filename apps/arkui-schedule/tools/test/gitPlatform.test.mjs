// A1：托管平台预设、按仓库地址推断平台、手动选择优先、SSH 不可用的明确结论。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 范围：
// 1. 四个预设（GitHub / Gitee / GitLab / 自建）与文案（token 形态、用户名要求、示例地址）；
// 2. `hostFromRepoUrl` / `inferPlatformFromUrl`：https / ssh / scp 写法、子域、端口、userinfo；
// 3. `resolvePlatformSelection`：URL 自动推断（gitee/gitlab/自建）vs 用户手动改过（以用户为准，
//    `applied:false` 且提示里同时出现「地址看起来是 X / 已保留你的选择 Y」）；
// 4. SSH：`describeAuthModeBlocker('ssh')` 必须明说「仅支持 HTTPS」并给出原因（不能假装支持）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const {
  GIT_PLATFORM_PRESETS,
  GITEE_PLATFORM,
  PLATFORM_CUSTOM,
  PLATFORM_GITHUB,
  PLATFORM_GITLAB,
  SSH_UNSUPPORTED_REASON,
  SSH_UNSUPPORTED_SHORT,
  assertHttpsUsername,
  authHintFor,
  defaultHostOf,
  describeAuthModeBlocker,
  findPlatformPreset,
  gitUsernameHintFor,
  gitUsernamePlaceholderFor,
  hostFromRepoUrl,
  inferPlatformFromUrl,
  isSshAuthMode,
  normalizeGitPlatform,
  platformLabel,
  repoUrlExamplesFor,
  repoUrlPlaceholderFor,
  resolveGitUsername,
  resolvePlatformSelection,
  tokenPlaceholderFor
} = await import('../.build/model/gitAuth.js');

/** Gitee 的平台标识（gitAuth 里的规范名是 `GITEE_PLATFORM`，这里给测试一个短别名）。 */
const PLATFORM_GITEE = GITEE_PLATFORM;

describe('模块导出完整性', () => {
  test('平台/认证相关的常量都是非空字符串（页面 import 的名字必须真的存在）', async () => {
    const api = await import('../.build/model/gitAuth.js');
    for (const name of [
      'GITEE_PLATFORM',
      'PLATFORM_GITHUB',
      'PLATFORM_GITLAB',
      'PLATFORM_CUSTOM',
      'AUTH_MODE_HTTPS',
      'AUTH_MODE_SSH',
      'SSH_UNSUPPORTED_SHORT',
      'SSH_UNSUPPORTED_REASON'
    ]) {
      assert.equal(typeof api[name], 'string', `缺少导出 ${name}`);
      assert.ok(api[name].length > 0, `${name} 不能为空`);
    }
  });
});

describe('平台预设：四个平台与它们的文案', () => {
  test('预设清单固定为 GitHub / Gitee / GitLab / 自建，id 与顺序稳定', () => {
    assert.deepEqual(
      GIT_PLATFORM_PRESETS.map((preset) => preset.id),
      [PLATFORM_GITHUB, PLATFORM_GITEE, PLATFORM_GITLAB, PLATFORM_CUSTOM]
    );
    assert.deepEqual(
      GIT_PLATFORM_PRESETS.map((preset) => preset.label),
      ['GitHub', 'Gitee', 'GitLab', '自建']
    );
    // 每个预设都要有可用的用户名/token 说明与默认域名（界面直接展示，不能是空串）
    for (const preset of GIT_PLATFORM_PRESETS) {
      assert.ok(preset.label.length > 0, `${preset.id} 缺 label`);
      assert.match(preset.defaultHost, /^[a-z0-9.-]+\.[a-z]{2,}$/, `${preset.id} 的 defaultHost 不合法`);
      assert.ok(preset.usernameHint.length > 0, `${preset.id} 缺 usernameHint`);
      assert.ok(preset.tokenHint.length > 0, `${preset.id} 缺 tokenHint`);
    }
  });

  test('normalizeGitPlatform：四个合法值原样返回，未知值回落 github', () => {
    for (const id of [PLATFORM_GITHUB, PLATFORM_GITEE, PLATFORM_GITLAB, PLATFORM_CUSTOM]) {
      assert.equal(normalizeGitPlatform(id), id);
      assert.equal(normalizeGitPlatform(`  ${id.toUpperCase()}  `), id, '大小写/空白要容错');
    }
    for (const value of ['', '  ', 'bitbucket', 'GITEE.X', null, undefined]) {
      assert.equal(normalizeGitPlatform(value), PLATFORM_GITHUB, `${JSON.stringify(value)} 应回落 github`);
    }
    // findPlatformPreset 与 normalizeGitPlatform 同口径（永不返回 undefined）
    assert.equal(findPlatformPreset('gitea').id, PLATFORM_GITHUB);
    assert.equal(findPlatformPreset('gitlab').label, 'GitLab');
  });

  test('platformLabel / defaultHostOf：自建给的是占位域名，Gitee 的用户名必须写登录名', () => {
    assert.equal(platformLabel(PLATFORM_GITLAB), 'GitLab');
    assert.equal(defaultHostOf(PLATFORM_GITEE), 'gitee.com');
    assert.equal(defaultHostOf(PLATFORM_GITLAB), 'gitlab.com');
    assert.equal(defaultHostOf(PLATFORM_CUSTOM), 'git.example.com');
    assert.match(gitUsernamePlaceholderFor(PLATFORM_GITEE), /必填/);
    assert.match(gitUsernamePlaceholderFor(PLATFORM_GITLAB), /x-access-token/);
    assert.match(gitUsernameHintFor(PLATFORM_GITEE), /登录名/);
    assert.match(gitUsernameHintFor(PLATFORM_GITEE), /不是邮箱|不是邮箱?/);
    assert.match(tokenPlaceholderFor(PLATFORM_GITLAB), /glpat-/);
    assert.match(tokenPlaceholderFor(PLATFORM_GITHUB), /ghp_/);
  });

  test('仓库地址示例/占位跟着平台与认证方式变', () => {
    assert.equal(
      repoUrlPlaceholderFor(PLATFORM_GITLAB, 'https'),
      'https://gitlab.com/<用户名>/<仓库名>.git'
    );
    assert.equal(
      repoUrlPlaceholderFor(PLATFORM_CUSTOM, 'https'),
      'https://git.example.com/<用户名>/<仓库名>.git'
    );
    assert.equal(repoUrlPlaceholderFor(PLATFORM_GITEE, 'ssh'), 'git@gitee.com:<用户名>/<仓库名>.git');
    // SSH 示例必须自己就先说清「本版本只用 HTTPS」，不误导用户
    assert.match(repoUrlExamplesFor(PLATFORM_GITEE, 'ssh'), /SSH 地址不会被使用|只用 HTTPS/);
    assert.match(repoUrlExamplesFor(PLATFORM_GITLAB, 'https'), /gitlab\.com/);
  });
});

describe('hostFromRepoUrl：三种写法 + 端口/userinfo/大小写', () => {
  const cases = [
    ['https://gitee.com/u/r.git', 'gitee.com'],
    ['https://github.com/u/r', 'github.com'],
    ['http://git.example.com:8080/group/repo.git', 'git.example.com'],
    ['https://user:token@git.example.com/u/r.git', 'git.example.com'],
    ['https://GITEE.COM/u/r.git', 'gitee.com'],
    ['ssh://git@github.com/u/r.git', 'github.com'],
    ['ssh://git@gitee.com:2222/u/r.git', 'gitee.com'],
    ['git@gitee.com:u/r.git', 'gitee.com'],
    ['git@git.example.com:group/repo.git', 'git.example.com'],
    ['git.example.com/u/r.git', 'git.example.com'],
    ['', ''],
    ['   ', ''],
    ['not a url', ''],
    ['relative/path/repo.git', '']
  ];

  test('逐条解析主机名（小写、去端口、去 userinfo）', () => {
    for (const [input, expected] of cases) {
      assert.equal(hostFromRepoUrl(input), expected, `hostFromRepoUrl(${JSON.stringify(input)})`);
    }
  });
});

describe('inferPlatformFromUrl：gitee / github / gitlab / 自建', () => {
  const cases = [
    ['https://gitee.com/zhangsan/schedule.git', PLATFORM_GITEE],
    ['https://gitee.com/zhangsan/schedule', PLATFORM_GITEE],
    ['ssh://git@gitee.com/zhangsan/schedule.git', PLATFORM_GITEE],
    ['git@gitee.com:zhangsan/schedule.git', PLATFORM_GITEE],
    ['https://github.com/octocat/schedule.git', PLATFORM_GITHUB],
    ['https://gist.github.com/u/r.git', PLATFORM_GITHUB],
    ['https://gitlab.com/group/schedule.git', PLATFORM_GITLAB],
    ['ssh://git@gitlab.com/group/schedule.git', PLATFORM_GITLAB],
    // 其它有域名的主机一律归「自建」（私有 GitLab / Gitea / Forgejo 都在这一档）
    ['https://gitlab.example.com/group/schedule.git', PLATFORM_CUSTOM],
    ['https://gitea.example.org/u/r.git', PLATFORM_CUSTOM],
    ['https://code.example.cn/u/r.git', PLATFORM_CUSTOM],
    // 认不出主机 → 空串（调用方保留原值，不瞎猜）
    ['', ''],
    ['just-a-name', ''],
    ['ftp:/broken', '']
  ];

  test('按地址推断（含 http/ssh/scp 写法）', () => {
    for (const [url, expected] of cases) {
      assert.equal(inferPlatformFromUrl(url), expected, `inferPlatformFromUrl(${JSON.stringify(url)})`);
    }
  });
});

describe('resolvePlatformSelection：保存时自动推断、手动选择优先', () => {
  test('未手动改过：gitee/gitlab/自建都自动采用，并给出「已按地址推断平台为 X」', () => {
    const gitee = resolvePlatformSelection('https://gitee.com/u/r.git', PLATFORM_GITHUB, false);
    assert.equal(gitee.platform, PLATFORM_GITEE);
    assert.equal(gitee.inferred, PLATFORM_GITEE);
    assert.equal(gitee.applied, true);
    assert.equal(gitee.notice, '已按地址推断平台为 Gitee');

    const gitlab = resolvePlatformSelection('https://gitlab.com/g/r.git', PLATFORM_GITHUB, false);
    assert.equal(gitlab.platform, PLATFORM_GITLAB);
    assert.match(gitlab.notice, /已按地址推断平台为 GitLab/);

    const selfHosted = resolvePlatformSelection('https://gitea.example.org/u/r.git', PLATFORM_GITHUB, false);
    assert.equal(selfHosted.platform, PLATFORM_CUSTOM);
    assert.match(selfHosted.notice, /已按地址推断平台为 自建/);

    // 推断结果与当前选择一致：不改值，但仍给「已按地址识别」的确认提示
    const same = resolvePlatformSelection('https://github.com/u/r.git', PLATFORM_GITHUB, false);
    assert.equal(same.platform, PLATFORM_GITHUB);
    assert.equal(same.applied, false);
    assert.match(same.notice, /已按地址识别平台为 GitHub/);
  });

  test('手动改过（platformTouched）：以用户为准，推断只出现在提示里', () => {
    const kept = resolvePlatformSelection('https://gitee.com/u/r.git', PLATFORM_GITHUB, true);
    assert.equal(kept.platform, PLATFORM_GITHUB, '用户手动选过 GitHub，保存时不能被地址覆盖');
    assert.equal(kept.applied, false);
    assert.equal(kept.inferred, PLATFORM_GITEE);
    assert.match(kept.notice, /Gitee/, '提示要点明地址看起来是 Gitee');
    assert.match(kept.notice, /GitHub/, '提示要说明保留了用户的选择');

    const custom = resolvePlatformSelection('https://gitea.example.org/u/r.git', PLATFORM_CUSTOM, true);
    assert.equal(custom.platform, PLATFORM_CUSTOM);
    assert.equal(custom.applied, false);
    assert.match(custom.notice, /你的选择/);
  });

  test('地址为空 / 认不出主机：平台保持原值且不提示（不瞎猜）', () => {
    for (const url of ['', '   ', 'not a url']) {
      const result = resolvePlatformSelection(url, PLATFORM_GITLAB, false);
      assert.equal(result.platform, PLATFORM_GITLAB);
      assert.equal(result.inferred, '');
      assert.equal(result.applied, false);
      assert.equal(result.notice, '');
    }
  });

  test('URL 里是自建、用户选的也是自建：提示锁定而不是推断', () => {
    const result = resolvePlatformSelection('https://git.example.com/u/r.git', PLATFORM_CUSTOM, true);
    assert.equal(result.platform, PLATFORM_CUSTOM);
    assert.equal(result.notice, '平台已按你的选择固定为 自建');
  });
});

describe('SSH：明确「当前版本仅支持 HTTPS」，不假装支持', () => {
  test('describeAuthModeBlocker：https 放行、ssh 给完整原因、其它写法容错', () => {
    assert.equal(describeAuthModeBlocker('https'), '');
    assert.equal(describeAuthModeBlocker(''), '', '空值按 HTTPS 处理');
    assert.equal(describeAuthModeBlocker(undefined), '');

    const blocker = describeAuthModeBlocker('ssh');
    assert.equal(blocker, SSH_UNSUPPORTED_REASON);
    assert.match(blocker, /仅支持 HTTPS/);
    // 原因必须落在可验证的事实上（不是「暂未实现」）
    assert.match(blocker, /isomorphic-git/);
    assert.match(blocker, /没有 SSH 私钥通道|onAuth/);
    assert.match(blocker, /~\/\.ssh\/id_ed25519/);
    assert.match(blocker, /ssh-agent/);

    assert.equal(describeAuthModeBlocker(' SSH '), SSH_UNSUPPORTED_REASON, '大小写/空白要容错');
    assert.equal(isSshAuthMode('ssh'), true);
    assert.equal(isSshAuthMode('https'), false);
    assert.equal(SSH_UNSUPPORTED_SHORT, '当前版本仅支持 HTTPS');
  });

  test('HTTPS 文案里不误导：SSH 模式下 authHintFor 也点明「只实现 HTTPS」', () => {
    assert.match(authHintFor(PLATFORM_GITHUB, 'ssh'), /仅支持 HTTPS/);
    assert.match(authHintFor(PLATFORM_GITHUB, 'https'), /token/);
    assert.match(authHintFor(PLATFORM_GITEE, 'https'), /Gitee|私人令牌/);
  });

  test('平台不会让 SSH 变得可用（assertHttpsUsername 对 gitee+ssh 仍放行，由 auth 方式校验负责）', () => {
    // 两个校验分工明确：用户名规则只管 HTTPS；能不能用 SSH 由 describeAuthModeBlocker 决定
    assert.equal(assertHttpsUsername(PLATFORM_GITEE, 'ssh', ''), null);
    assert.match(String(describeAuthModeBlocker('ssh')), /仅支持 HTTPS/);
  });
});

describe('平台与 HTTPS 用户名兜底（P0 不回归）', () => {
  test('Gitee 空用户名 → 空串；GitHub/GitLab/自建 → x-access-token', () => {
    assert.equal(resolveGitUsername(PLATFORM_GITEE, ''), '');
    for (const platform of [PLATFORM_GITHUB, PLATFORM_GITLAB, PLATFORM_CUSTOM, '']) {
      assert.equal(resolveGitUsername(platform, ''), 'x-access-token', `${platform} 应回落 x-access-token`);
    }
    assert.equal(resolveGitUsername(PLATFORM_GITLAB, 'alice'), 'alice');
  });
});

describe('设置页接线（源码级）：四个平台 chip、推断提示、SSH 说明', () => {
  const PAGE = readFileSync(new URL('../../entry/src/main/ets/pages/Settings.ets', import.meta.url), 'utf8');

  test('四个平台 chip 都在，且平台值走 normalizeGitPlatform（不是旧的二值归一）', () => {
    for (const chip of ['PLATFORM_GITHUB', 'GITEE_PLATFORM', 'PLATFORM_GITLAB', 'PLATFORM_CUSTOM']) {
      assert.ok(PAGE.includes(`this.PlatformChip(${chip})`), `缺少平台 chip：${chip}`);
    }
    assert.match(PAGE, /this\.gitPlatform = normalizeGitPlatform\(value\);/, '选平台要归一成四值');
    assert.match(PAGE, /this\.platformTouched = true;/, '手动选平台要置 platformTouched');
  });

  test('保存前按地址推断 + 页面提示（手动选择优先）', () => {
    assert.match(PAGE, /resolvePlatformSelection\(\s*this\.repoUrl,\s*this\.gitPlatform,\s*this\.platformTouched\s*\)/);
    assert.match(PAGE, /this\.platformNotice = platformResolution\.notice;/, '保存后把推断提示展示出来');
    assert.match(PAGE, /this\.syncPlatformNotice\(\);/, '改地址时即时更新推断提示');
    assert.match(PAGE, /this\.HintLine\(this\.platformNotice\)/, '提示必须渲染出来');
  });

  test('平台文案/示例/用户名占位都复用 model/gitAuth（不再页面自带一套）', () => {
    for (const call of [
      /repoUrlPlaceholderFor\(this\.gitPlatform, this\.authMode\)/,
      /repoUrlExamplesFor\(this\.gitPlatform, this\.authMode\)/,
      /gitUsernamePlaceholderFor\(this\.gitPlatform\)/,
      /gitUsernameHintFor\(this\.gitPlatform\)/,
      /tokenPlaceholderFor\(this\.gitPlatform\)/,
      /authHintFor\(this\.gitPlatform, this\.authMode\)/
    ]) {
      assert.match(PAGE, call, `页面没有复用：${call}`);
    }
  });

  test('SSH 必须写「仅支持 HTTPS」+ 原因，并且拦在同步入口', () => {
    assert.match(PAGE, /SSH（本版本不可用）/, 'SSH chip 要直接标不可用');
    assert.match(PAGE, /describeAuthModeBlocker\(this\.authMode\)/, 'SSH 原因要展示');
    assert.match(PAGE, /this\.syncMessage = `❌ \$\{authBlocker\}`;/, '同步前拦 SSH 并说明原因');
    assert.match(PAGE, /pushBlockedReason\(\)/, '推送按钮也要按认证方式禁用');
  });
});
