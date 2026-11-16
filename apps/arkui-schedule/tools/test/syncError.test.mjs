// 同步错误分级 + 上次同步状态 + 「同 id 后写覆盖」冲突语义的纯逻辑测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 重点：
// 1. 四档分级（fatal/retry/conflict/auth）必须稳定，且 `retryable` 与等级自洽；
// 2. 任何 message 里的凭据（Basic/Bearer/x-access-token:/token=/ghp_/sk-）都不得回显；
// 3. 「上次同步时间」文案只依赖入参（不读系统时钟），跨时区断言用本地 Date 反算；
// 4. 冲突语义按既有契约（以 `id` 为键、`ts` 较晚者胜、无 `deleted` 墓碑）而不是新格式。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  canRetrySync,
  classifySyncError,
  describeLastSync,
  normalizeSyncAction,
  redactSecrets,
  syncActionLabel
} = await import('../.build/model/syncError.js');
const { encodeRecord, foldById, parseJsonl } = await import('../.build/model/jsonl.js');

const LEVELS = ['fatal', 'retry', 'conflict', 'auth'];

/** 断言分类结果的结构合法（等级合法、文案非空、retryable 与等级自洽）。 */
function assertShape(info, expectedLevel, expectedKind) {
  assert.ok(LEVELS.includes(info.level), `等级必须是四档之一：${info.level}`);
  assert.ok(info.title.length > 0, 'title 不能为空');
  assert.ok(info.detail.length > 0, 'detail 不能为空');
  assert.ok(info.detail.length <= 301, 'detail 必须截断到 300 字以内');
  assert.equal(typeof info.retryable, 'boolean');
  if (expectedLevel !== undefined) {
    assert.equal(info.level, expectedLevel, `等级不符：${info.level} / ${info.detail}`);
  }
  if (expectedKind !== undefined) {
    assert.equal(info.kind, expectedKind, `分类不符：${info.kind} / ${info.detail}`);
  }
  // 只有 retry 档允许「直接重试」
  assert.equal(info.retryable, info.level === 'retry', 'retryable 只对 retry 档为 true');
  return info;
}

describe('classifySyncError：网络类（可重试）', () => {
  test('网络不可达（无响应 / DNS / 连接被拒）→ retry', () => {
    assertShape(classifySyncError('E_HTTP', '网络请求失败：EHOSTUNREACH'), 'retry', 'network');
    assertShape(classifySyncError(0, ''), 'retry', 'network');
    // A1 起 DNS 单独一档（排查手段不同：先看域名/网络/DNS），仍可重试
    const dns = assertShape(classifySyncError('', '域名解析失败，无法连接仓库'), 'retry', 'dns');
    assert.match(dns.title, /DNS|解析/);
    assertShape(classifySyncError('E_HTTP', '网络请求失败：ENOTFOUND git.example.com'), 'retry', 'dns');
    assertShape(classifySyncError('E_HTTP', '网络请求失败：ECONNREFUSED'), 'retry', 'network');
  });

  test('超时 → retry（文案说明 60 秒上限，且不建议无限重试）', () => {
    const info = assertShape(classifySyncError('E_GIT', '同步超时（60 秒）：Web 页面可能未就绪或网络不可用'), 'retry', 'timeout');
    assert.match(info.title, /超时/);
    assert.match(info.detail, /60 秒/);
    assert.match(classifySyncError('', 'request timed out').title, /超时/);
  });

  test('429 限流 → retry，文案提示等待', () => {
    const info = assertShape(classifySyncError('E_HTTP', '请求过于频繁（HTTP 429）：请稍后重试'), 'retry', 'rate-limit');
    assert.match(info.detail, /等|稍后/);
  });

  test('5xx → retry（远端暂时异常）', () => {
    assertShape(classifySyncError('E_HTTP', '远端服务异常（HTTP 503），请稍后重试'), 'retry', 'server');
    assertShape(classifySyncError(502, ''), 'retry', 'server');
    assertShape(classifySyncError('', '服务端错误：Bad Gateway'), 'retry', 'server');
  });
});

describe('classifySyncError：鉴权类（auth，需用户改配置）', () => {
  test('401 / E_AUTH → auth，指引去设置页换 token', () => {
    for (const info of [
      classifySyncError(401, ''),
      classifySyncError('E_AUTH', '认证失败：请在设置页填写有效的 HTTPS 访问令牌'),
      classifySyncError('E_AUTH', '认证失败（HTTP 401）：请检查访问令牌是否有效'),
      classifySyncError('', '认证失败（HTTP 401）')
    ]) {
      assertShape(info, 'auth', 'auth');
      assert.match(info.title, /认证失败/);
      assert.match(info.detail, /设置页|token/);
    }
  });

  test('403 → auth/forbidden（token 有效但没权限），文案与 401 不同', () => {
    const forbidden = assertShape(classifySyncError(403, ''), 'auth', 'forbidden');
    assert.match(forbidden.title, /无权限/);
    assert.match(forbidden.detail, /权限/);
    const viaMessage = assertShape(classifySyncError('E_AUTH', '无权限（HTTP 403）'), 'auth', 'forbidden');
    assert.match(viaMessage.title, /无权限/);
    // 401 的文案不能出现「无权限」的措辞，避免用户误以为要加组织权限
    assert.equal(/无权限/.test(classifySyncError(401, '').title), false);
  });
});

describe('classifySyncError：冲突类（conflict）', () => {
  test('推送被拒绝 / 无法快进 / 409 → conflict，指引先拉取（应用不 merge）', () => {
    const rejected = assertShape(
      classifySyncError('E_GIT', '推送被拒绝：远端已有新提交。请先执行「拉取」，本应用不会强制覆盖远端'),
      'conflict',
      'conflict'
    );
    assert.match(rejected.detail, /拉取/);
    assert.match(rejected.detail, /不会自动合并/);
    assertShape(classifySyncError(409, ''), 'conflict', 'conflict');
    assertShape(classifySyncError('E_GIT', '无法快进合并：本机与远端已分叉'), 'conflict', 'conflict');
    assertShape(classifySyncError('E_GIT', '存在冲突：本应用不执行自动合并'), 'conflict', 'conflict');
  });
});

describe('classifySyncError：确定性失败（fatal）', () => {
  test('404 / 仓库不存在 → fatal，提示私有仓库无凭据也可能 404', () => {
    const info = assertShape(classifySyncError(404, ''), 'fatal', 'notfound');
    assert.match(info.title, /仓库不存在/);
    assert.match(info.detail, /404/);
    assertShape(classifySyncError('E_HTTP', '远端返回 404：仓库地址或分支不存在'), 'fatal', 'notfound');
  });

  test('E_FS / 磁盘满 / 权限错误 → fatal 本地磁盘，不当作网络问题', () => {
    for (const info of [
      classifySyncError('E_FS', '本地文件读写失败：EACCES'),
      classifySyncError('E_FS', '本设备目录不存在：devices/phone-a（请先保存一条日程）'),
      classifySyncError('', '磁盘空间不足：ENOSPC'),
      classifySyncError('', '创建目录失败（/data/...）：EPERM')
    ]) {
      assertShape(info, 'fatal', 'disk');
      assert.match(info.title, /磁盘/);
    }
  });

  test('配置不全（E_INPUT）→ fatal，不要鼓励直接重试', () => {
    for (const info of [
      classifySyncError('E_INPUT', '请先在设置页填写仓库地址（HTTPS）'),
      classifySyncError('', '同步页面尚未就绪：请等待 Web 组件加载完成'),
      classifySyncError('E_INPUT', '请填写访问令牌（GitHub/Gitee Personal Access Token）')
    ]) {
      assertShape(info, 'fatal', 'input');
      assert.match(info.title, /配置/);
    }
  });

  test('未知错误兜底：也给中文标题、detail 非空、不重试', () => {
    const info = assertShape(classifySyncError('', ''), 'fatal', 'unknown');
    assert.match(info.title, /失败/);
    assert.match(info.detail, /未知/);
    assertShape(classifySyncError('E_GIT', 'Git 操作失败：some internal thing'), 'fatal', 'unknown');
  });

  test('其它 4xx（418/451）→ fatal，文案带状态码', () => {
    const info = assertShape(classifySyncError(451, ''), 'fatal', 'unknown');
    assert.match(info.title, /451/);
  });
});

describe('classifySyncError：入参容错与幂等', () => {
  test('kindOrStatus 接受数字 / HTTP 文本 / 错误码 / 空值', () => {
    assert.equal(classifySyncError('HTTP 401', '').kind, 'auth');
    assert.equal(classifySyncError('http 404', '').kind, 'notfound');
    assert.equal(classifySyncError('E_AUTH', '').kind, 'auth');
    assert.equal(classifySyncError(null, '').level, 'fatal');
    assert.equal(classifySyncError(undefined, undefined).level, 'fatal');
  });

  test('同一输入多次调用结果完全一致（纯函数）', () => {
    const first = classifySyncError('E_GIT', '推送被拒绝：远端已有新提交');
    const second = classifySyncError('E_GIT', '推送被拒绝：远端已有新提交');
    assert.deepEqual(second, first);
  });

  test('message 里的多余空白被折叠（界面行长可控）', () => {
    const info = classifySyncError('', '未知\n\n   错误\t出现');
    assert.equal(/\s{2,}/.test(info.detail), false);
  });
});

describe('凭据绝不回显', () => {
  test('redactSecrets：Basic / Bearer / x-access-token / token= / ghp_ / sk- 全部打码', () => {
    const raw =
      'Authorization: Basic dXNlcjpwYXNzd29yZA== Bearer abcdef0123456789 ' +
      'x-access-token:ghp_realtokenvalue1234567890 token=ghp_zzzzzzzzzzzzzzzzzzzz ' +
      'api_key=sk-abcdefghijklmnop1234567890';
    const text = redactSecrets(raw);
    for (const secret of [
      'dXNlcjpwYXNzd29yZA==',
      'abcdef0123456789',
      'ghp_realtokenvalue1234567890',
      'ghp_zzzzzzzzzzzzzzzzzzzz',
      'sk-abcdefghijklmnop1234567890'
    ]) {
      assert.equal(text.includes(secret), false, `必须打码：${secret}`);
    }
    assert.match(text, /Basic \*\*\*/);
    assert.match(text, /Bearer \*\*\*/);
    assert.match(text, /x-access-token:\*\*\*/);
    assert.match(text, /token=\*\*\*/);
  });

  test('classifySyncError 的 title/detail 与四档结果都不含任何凭据片段', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    const inputs = [
      ['E_AUTH', `认证失败（HTTP 401）：token=${secret}`],
      ['E_HTTP', `网络请求失败：Basic ${secret}`],
      ['E_GIT', `推送被拒绝 Bearer ${secret}`],
      ['', `未知错误 x-access-token:${secret}`]
    ];
    for (const [kind, message] of inputs) {
      const info = classifySyncError(kind, message);
      const joined = `${info.title}|${info.detail}|${info.kind}|${info.level}`;
      assert.equal(joined.includes(secret), false, `结果不得回显 token：${joined}`);
      assert.equal(joined.includes('abcdefghijklmnopqrstuvwxyz0123'), false);
    }
  });

  test('redactSecrets 对非字符串与空值安全', () => {
    assert.equal(redactSecrets(''), '');
    assert.equal(redactSecrets(null), '');
    assert.equal(redactSecrets(undefined), '');
    assert.equal(redactSecrets(12345), '');
  });
});

describe('describeLastSync：上次同步时间文案（不读系统时钟）', () => {
  /** 用本地时间构造 ISO，规避测试机时区差异。 */
  function localIso(year, month, day, hour, minute) {
    return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
  }
  function pad(value) {
    return `${value}`.padStart(2, '0');
  }

  test('空串 → 从未同步', () => {
    assert.equal(describeLastSync('', localIso(2026, 11, 15, 12, 0)), '上次同步：从未同步');
    assert.equal(describeLastSync('   ', localIso(2026, 11, 15, 12, 0)), '上次同步：从未同步');
  });

  test('今天的同步 → 「今天 HH:MM」（补零）', () => {
    const at = localIso(2026, 11, 15, 9, 5);
    const now = new Date(Date.parse(at) + 3600 * 1000).toISOString();
    assert.equal(describeLastSync(at, now), `上次同步：今天 09:05`);
    const at2 = localIso(2026, 11, 15, 14, 32);
    const now2 = new Date(Date.parse(at2) + 60 * 1000).toISOString();
    assert.equal(describeLastSync(at2, now2), '上次同步：今天 14:32');
  });

  test('同年其它日期 → 「MM-DD HH:MM」', () => {
    const at = localIso(2026, 11, 14, 9, 5);
    const now = localIso(2026, 11, 15, 12, 0);
    const date = new Date(Date.parse(at));
    assert.equal(
      describeLastSync(at, now),
      `上次同步：${pad(date.getMonth() + 1)}-${pad(date.getDate())} 09:05`
    );
  });

  test('跨年 → 「YYYY-MM-DD HH:MM」', () => {
    const at = localIso(2025, 11, 14, 9, 5);
    assert.equal(describeLastSync(at, localIso(2026, 11, 15, 12, 0)), '上次同步：2025-11-14 09:05');
  });

  test('无法解析的时间 → 时间未知；nowIso 不可解析时退回绝对时间（结果确定）', () => {
    assert.equal(describeLastSync('not-a-date', '2026-11-15T12:00:00+08:00'), '上次同步：时间未知');
    const at = localIso(2025, 11, 14, 9, 5);
    assert.equal(describeLastSync(at, 'garbage'), describeLastSync(at, ''));
    assert.match(describeLastSync(at, ''), /^上次同步：2025-11-14 09:05$/);
  });
});

describe('同步动作与重试按钮的前置条件', () => {
  test('normalizeSyncAction 只接受 pull/push/status', () => {
    assert.equal(normalizeSyncAction('pull'), 'pull');
    assert.equal(normalizeSyncAction(' PUSH '), 'push');
    assert.equal(normalizeSyncAction('Status'), 'status');
    assert.equal(normalizeSyncAction('clone'), '');
    assert.equal(normalizeSyncAction(''), '');
  });

  test('syncActionLabel 给出中文按钮名', () => {
    assert.equal(syncActionLabel('pull'), '拉取');
    assert.equal(syncActionLabel('push'), '推送');
    assert.equal(syncActionLabel('status'), '查看状态');
    assert.equal(syncActionLabel('whatever'), '同步');
  });

  test('canRetrySync：有动作且不忙时才可点', () => {
    assert.equal(canRetrySync('pull', false), true);
    assert.equal(canRetrySync('push', false), true);
    assert.equal(canRetrySync('status', false), true);
    assert.equal(canRetrySync('pull', true), false, '同步进行中不能再点');
    assert.equal(canRetrySync('', false), false, '没有上次动作时没有重试按钮');
    assert.equal(canRetrySync('clone', false), false);
  });
});

describe('冲突语义（沿用既有契约，不发明新格式）', () => {
  /** 构造一条合法记录。 */
  function record(id, ts, extra = {}) {
    return {
      id,
      ts,
      title: `t-${id}`,
      body: 'b',
      author: 'phone-a',
      done: false,
      ai_processed: false,
      ...extra
    };
  }

  test('两个设备写同一 id：以 id 为键、ts 较晚者胜（foldById）', () => {
    const fromA = record('same-id', '2026-11-15T09:00:00+08:00', { title: '设备 A 的版本' });
    const fromB = record('same-id', '2026-11-15T09:00:01+08:00', { title: '设备 B 的版本' });
    const folded = foldById([fromA, fromB]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].title, '设备 B 的版本');
    // 入参顺序不影响结果（先按 ts 稳定排序再折叠）
    assert.equal(foldById([fromB, fromA])[0].title, '设备 B 的版本');
    // 反过来：A 更晚则 A 胜
    const laterA = record('same-id', '2026-11-15T09:00:02+08:00', { title: 'A 更新' });
    assert.equal(foldById([fromB, laterA])[0].title, 'A 更新');
  });

  test('历史行全部保留（追加写 + 折叠只在读取时发生）', () => {
    const older = record('r1', '2026-11-15T09:00:00+08:00', { title: '旧' });
    const newer = record('r1', '2026-11-15T09:00:00.500+08:00', { title: '新' });
    const text = `${encodeRecord(older)}${encodeRecord(newer)}`;
    const parsed = parseJsonl(text);
    assert.equal(parsed.records.length, 2, '两行都在，历史不被重写');
    assert.equal(parsed.errors.length, 0);
    assert.equal(foldById(parsed.records)[0].title, '新');
  });

  test('契约里没有 deleted 墓碑：带 deleted 的行仍按普通记录折叠（不被隐藏）', () => {
    // docs/CONTRACT.md §3.2 的 ScheduleRecord 没有 deleted 字段，UI 也没有删除入口；
    // 这里固化「不要凭空发明墓碑语义」：额外字段原样保留，但折叠只看 ts。
    const alive = record('r9', '2026-11-15T09:00:00+08:00', { title: '正常记录' });
    const withDeleted = record('r9', '2026-11-15T10:00:00+08:00', { deleted: true });
    const folded = foldById([alive, withDeleted]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].deleted, true, '额外字段不被丢弃（与 jsonl.ts normalizeRecord 一致）');
    assert.equal(folded[0].ts, '2026-11-15T10:00:00+08:00');
  });
});
