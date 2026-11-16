// A1 第 4 条：错误分级表 —— 401/403/404/超时/DNS/证书，每类都给可操作的中文建议。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 这组用例是**表驱动**的：一行一个「远端实际会吐出来的东西」→ 期望分类 + 文案里必须出现的
// 关键词。文案变了但语义没变（关键词还在）不会红；语义丢了（例如 401 不再提用户名/登录名）就红。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  classifySyncError,
  describeAheadBehind,
  describeLastSyncOutcome,
  describePushReadiness,
  describeSyncStatus,
  shortSha
} = await import('../.build/model/syncError.js');

const LEVELS = ['fatal', 'retry', 'conflict', 'auth'];

/** 表：`[入参 code, 入参 message, 期望 kind, 期望 level, 文案必须命中的正则, 说明]`。 */
const GRADES = [
  [
    'E_AUTH',
    '认证失败（HTTP 401）：请检查访问令牌是否有效',
    'auth',
    'auth',
    /用户名/,
    '401 必须提示检查用户名（P0 的教训：Gitee 写死 x-access-token 必 401）'
  ],
  [401, '', 'auth', 'auth', /Gitee/, '401 文案要点名 Gitee 的用户名规则'],
  [401, '', 'auth', 'auth', /登录名/, '401 要说清「Gitee 用户名是登录名」'],
  [401, '', 'auth', 'auth', /不是邮箱/, '401 要明说「不是邮箱」（用户最常踩的坑）'],
  [401, '', 'auth', 'auth', /token|令牌/, '401 要指向令牌'],
  [401, '', 'auth', 'auth', /设置页/, '401 要指路去设置页'],
  [403, '', 'forbidden', 'auth', /权限/, '403 是「令牌有效但没权限」'],
  [403, '', 'forbidden', 'auth', /write|读写/, '403 要说明需要读写权限'],
  [404, '', 'notfound', 'fatal', /404/, '404 文案要带状态码'],
  [404, '', 'notfound', 'fatal', /私有/, '404 要提醒「私有仓库无凭据也会 404」'],
  [404, '', 'notfound', 'fatal', /分支/, '404 要提醒分支名也可能错'],
  [
    'E_GIT',
    '同步超时（60 秒）：Web 页面可能未就绪或网络不可用',
    'timeout',
    'retry',
    /60 秒/,
    '超时要说明 60 秒上限'
  ],
  ['', 'request timed out', 'timeout', 'retry', /重试/, '超时可直接重试'],
  ['', '域名解析失败，无法连接仓库', 'dns', 'retry', /域名/, 'DNS 要指向域名拼写'],
  ['E_HTTP', '网络请求失败：ENOTFOUND git.example.com', 'dns', 'retry', /DNS|解析/, 'ENOTFOUND 属 DNS'],
  ['E_HTTP', '网络请求失败：EAI_AGAIN', 'dns', 'retry', /DNS|解析/, 'EAI_AGAIN 属 DNS'],
  ['', '无法解析域名 git.example.com', 'dns', 'retry', /网络|DNS/, 'DNS 要提示查网络'],
  [
    'E_HTTP',
    '证书错误（HTTPS 校验未通过）：CERT_HAS_EXPIRED',
    'certificate',
    'fatal',
    /证书/,
    '证书错误要单独一档'
  ],
  ['', 'SSL handshake failed: self-signed certificate', 'certificate', 'fatal', /自签名|证书/, '自签名证书'],
  ['E_HTTP', 'unable to get local issuer certificate', 'certificate', 'fatal', /证书/, '证书链不完整'],
  ['', '证书过期：notAfter 2020-01-01', 'certificate', 'fatal', /时间/, '证书错误要提醒检查系统时间'],
  ['', '证书过期：notAfter 2020-01-01', 'certificate', 'fatal', /不会跳过/, '应用不提供跳过证书校验']
];

describe('classifySyncError：表驱动分级 + 可操作建议', () => {
  test('每一行的 kind/level/retryable 与文案关键词都成立', () => {
    for (const [code, message, kind, level, pattern, note] of GRADES) {
      const info = classifySyncError(code, message);
      assert.equal(info.kind, kind, `${note}（kind=${info.kind} / ${info.detail}）`);
      assert.equal(info.level, level, `${note}（level=${info.level} / ${info.detail}）`);
      assert.ok(LEVELS.includes(info.level), `${note}：等级必须是四档之一`);
      assert.equal(info.retryable, info.level === 'retry', `${note}：只有 retry 档可重试`);
      assert.match(info.title, /\S/, `${note}：title 不能为空`);
      assert.match(info.detail, pattern, `${note}：文案缺少 ${pattern}（实际：${info.detail}）`);
      assert.ok(info.detail.length <= 301, `${note}：detail 必须截断到 300 字以内`);
      // 每类文案都必须给「下一步做什么」，而不是只报错
      assert.match(info.detail, /请|要|可|检查|确认|重试|换|让|等/, `${note}：文案缺少可操作指引`);
    }
  });

  test('六类错误的标题互不相同（用户能一眼分辨）', () => {
    const samples = [
      [401, ''],
      [403, ''],
      [404, ''],
      ['E_GIT', '同步超时'],
      ['', '域名解析失败'],
      ['', '证书错误：CERT_HAS_EXPIRED']
    ];
    const titles = samples.map(([code, message]) => classifySyncError(code, message).title);
    assert.equal(new Set(titles).size, titles.length, `标题重复：${titles.join(' | ')}`);
    for (const title of titles) {
      assert.match(title, /401|403|404|超时|DNS|证书/, `标题要能看出类别：${title}`);
    }
  });

  test('同类建议里不出现凭据（打码 + 不拼 token）', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    for (const [code, message] of [
      ['E_AUTH', `认证失败（HTTP 401）token=${secret}`],
      ['', `证书错误：Basic ${secret}`],
      ['', `域名解析失败 token=${secret}`]
    ]) {
      const info = classifySyncError(code, message);
      const joined = `${info.title}|${info.detail}`;
      assert.equal(joined.includes(secret), false, `回显了令牌：${joined}`);
      assert.equal(joined.includes('ghp_'), false, `回显了令牌前缀：${joined}`);
    }
  });

  test('DNS/证书都在「网络不可达」之前分出去（否则建议会指错方向）', () => {
    assert.equal(classifySyncError('E_HTTP', '网络请求失败：ENOTFOUND').kind, 'dns');
    assert.equal(classifySyncError('E_HTTP', '网络请求失败：ECONNREFUSED').kind, 'network');
    assert.equal(
      classifySyncError('', '网络请求未取得响应（DNS/证书/网络不可达）：https://x/y.git').kind,
      'network',
      '桥里的「DNS/证书/网络不可达」只是列举，不能当成证书错误'
    );
  });
});

describe('最近一次同步：时间 + 动作 + 成败', () => {
  const NOW = '2026-11-16T15:00:00+08:00';

  test('从未同步', () => {
    assert.equal(describeLastSyncOutcome('', '', '', NOW), '上次同步：从未同步');
  });

  test('成功：带动作名', () => {
    const at = new Date(2026, 10, 16, 14, 32).toISOString();
    const line = describeLastSyncOutcome(at, '', 'push', new Date(2026, 10, 16, 15, 0).toISOString());
    assert.match(line, /上次同步：今天 14:32/);
    assert.match(line, /上次推送成功/);
  });

  test('失败：原因写进同一行（过长会截断）', () => {
    const at = new Date(2026, 10, 16, 14, 32).toISOString();
    const line = describeLastSyncOutcome(at, '认证失败（401：用户名或 token）：检查用户名', 'pull', at);
    assert.match(line, /上次拉取失败/);
    assert.match(line, /认证失败/);

    const long = describeLastSyncOutcome(at, '错'.repeat(200), 'status', at);
    assert.ok(long.length < 220, `过长的失败原因要截断：${long.length}`);
    assert.match(long, /…$/);
  });

  test('没有动作时用「同步」兜底，动作非法也不崩', () => {
    const at = new Date(2026, 10, 16, 9, 5).toISOString();
    assert.match(describeLastSyncOutcome(at, '', '', at), /上次同步成功/);
    assert.match(describeLastSyncOutcome(at, '', 'clone', at), /上次同步成功/);
  });
});

describe('同步状态一行 + 推送就绪说明（A2）', () => {
  const base = {
    initialized: true,
    branch: 'main',
    head: 'a1b2c3d4e5f6',
    ahead: 2,
    behind: 0,
    diverged: false,
    conflicts: 0,
    changedCount: 3,
    remoteConfigured: true,
    lastCommitMessage: 'phone-a: 日程同步'
  };

  test('未初始化：一句话说清「首次拉取会自动克隆」', () => {
    assert.match(describeSyncStatus({ ...base, initialized: false }), /尚未初始化[\s\S]*拉取/);
  });

  test('正常状态：分支 / HEAD / ahead / 本地改动 / 冲突 / 远端 / 最近提交', () => {
    const line = describeSyncStatus(base);
    for (const part of ['分支 main', 'HEAD a1b2c3', '领先远端 2 个提交', '本地改动 3 处', '冲突 0', '远端 已配置']) {
      assert.ok(line.includes(part), `状态行缺少「${part}」：${line}`);
    }
    assert.match(line, /最近提交/);
  });

  test('落后 / 分叉 / 空仓库的措辞', () => {
    assert.match(describeSyncStatus({ ...base, ahead: 0, behind: 4 }), /落后远端 4 个提交/);
    assert.match(
      describeSyncStatus({ ...base, ahead: 1, behind: 2, diverged: true }),
      /分叉：领先 1、落后 2/
    );
    const empty = describeSyncStatus({ ...base, head: '', ahead: 0, behind: 0 });
    assert.match(empty, /HEAD （空仓库）/);
    assert.match(empty, /领先\/落后未知/);
  });

  test('describeAheadBehind：四象限文案', () => {
    assert.equal(describeAheadBehind({ ahead: 0, behind: 0, diverged: false, comparable: true }), '与远端一致');
    assert.match(describeAheadBehind({ ahead: 3, behind: 0, diverged: false, comparable: true }), /领先远端 3/);
    assert.match(describeAheadBehind({ ahead: 0, behind: 2, diverged: false, comparable: true }), /落后远端 2/);
    assert.match(describeAheadBehind({ ahead: 1, behind: 1, diverged: true, comparable: true }), /分叉/);
    assert.match(describeAheadBehind({ ahead: 0, behind: 0, diverged: false, comparable: false }), /未知/);
    assert.match(describeAheadBehind(null), /未知/);
  });

  test('推送就绪：未克隆 / 分叉 / 没改动都给出具体原因', () => {
    assert.match(describePushReadiness(null), /先「立即同步」/);
    assert.match(describePushReadiness({ ...base, initialized: false }), /先「立即同步」/);
    assert.match(
      describePushReadiness({ ...base, ahead: 0, behind: 2, diverged: true }),
      /分叉[\s\S]*拉取/
    );
    assert.equal(
      describePushReadiness({ ...base, ahead: 0, changedCount: 0 }),
      '没有新的本地改动可推送'
    );
    assert.equal(describePushReadiness(base), '', '有改动可推时不该有额外说明');
    assert.equal(describePushReadiness({ ...base, ahead: 1, changedCount: 0 }), '', '已领先提交也能推');
  });

  test('shortSha：7 位 + 空仓库占位', () => {
    assert.equal(shortSha('a1b2c3d4e5f6'), 'a1b2c3d');
    assert.equal(shortSha('abc'), 'abc');
    assert.equal(shortSha(''), '（空仓库）');
    assert.equal(shortSha('   '), '（空仓库）');
  });
});
