// 「远程控制」地址归一/校验（`model/remoteUrl.ts`）的纯函数测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 重点：这个地址是**用户手输的不可信输入**（缺协议、夹空格、协议乱写、只有 `http://`），
// 规则必须 fail-closed 且给中文原因；通过时只补协议、其余（端口/路径/query/token 值）原样保留。
// 本轮新增：IPv6 字面量（`http://[2409:…:763c]:3080/`）从「拒绝」改为「接受」——「公网 IPv6 直连」
// 是 App 支持的访问方式之一，方括号里的形态与 `]` 之后的端口都要校验，非法 IPv6 仍然拒绝。
// 该模块没有任何 import，因此不需要 registerHooks 补 `.js` 后缀。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  isIpv6Literal,
  normalizeRemoteUrl,
  routeToRemote,
  parseRemoteInput,
  mergeRemoteToken,
  encodeLastOk,
  decodeLastOk,
  canReconnect,
  reconnectLabel,
  sanitizeUrlForDisplay
} = await import('../.build/model/remoteUrl.js');

/** 断言「拒绝」：ok=false、url 为空串、reason 逐字匹配。 */
function assertRejected(raw, reason) {
  const check = normalizeRemoteUrl(raw);
  assert.equal(check.ok, false, `应拒绝：${JSON.stringify(raw)}`);
  assert.equal(check.url, '', '拒绝时 url 必须为空串（fail-closed）');
  assert.equal(check.reason, reason, `拒绝原因不匹配：${JSON.stringify(raw)} → ${check.reason}`);
  assert.equal(check.hasToken, false, '拒绝时 hasToken 必须是 false');
  assert.equal(check.hadScheme, false, '拒绝时 hadScheme 必须是 false');
  return check;
}

/** 断言「接受」：ok=true、reason 为空串，返回归一结果。 */
function assertAccepted(raw, expectedUrl) {
  const check = normalizeRemoteUrl(raw);
  assert.equal(check.ok, true, `应接受：${JSON.stringify(raw)}（reason=${check.reason}）`);
  assert.equal(check.reason, '', '通过时 reason 必须为空串');
  assert.equal(check.url, expectedUrl, `归一结果不匹配：${JSON.stringify(raw)}`);
  return check;
}

const REASON_EMPTY = '请先填写电脑上的 DSH 地址';
const REASON_SCHEME = '只支持 http:// 或 https:// 开头的地址';
const REASON_SPACE = '地址里不能有空格';
const REASON_INCOMPLETE = '地址不完整，请填写 ip:端口/路径';

describe('normalizeRemoteUrl：补协议（无协议的内网地址）', () => {
  test('192.168.1.6:3080/?token=x：补 http://、保留端口与 query、识别 token（完整期望）', () => {
    const check = assertAccepted('192.168.1.6:3080/?token=x', 'http://192.168.1.6:3080/?token=x');
    assert.equal(check.hasToken, true, '?token= 必须识别为 hasToken');
    assert.equal(check.hadScheme, false, '原文没写协议 → hadScheme=false');
  });

  test('host/path 形态（无端口、无协议）：补 http:// 并保留路径', () => {
    const check = assertAccepted('dsh.local/ui/index.html', 'http://dsh.local/ui/index.html');
    assert.equal(check.hadScheme, false);
    assert.equal(check.hasToken, false);
  });

  test('localhost:3080：本地回环 + 端口也补 http://', () => {
    assertAccepted('localhost:3080', 'http://localhost:3080');
  });

  test('已写协议时 hadScheme=true，且不再重复补协议', () => {
    const check = assertAccepted('http://192.168.1.6:3080/?token=x', 'http://192.168.1.6:3080/?token=x');
    assert.equal(check.hadScheme, true);
  });
});

describe('normalizeRemoteUrl：http / https 与大小写', () => {
  test('https 地址原样保留（含端口、路径、多参数 query）', () => {
    assertAccepted(
      'https://192.168.1.6:8443/dsh/ui?token=abc&x=1',
      'https://192.168.1.6:8443/dsh/ui?token=abc&x=1'
    );
  });

  test('协议大小写不敏感，归一为小写；host 与路径大小写保留', () => {
    assertAccepted('HTTP://192.168.1.6:3080/?token=x', 'http://192.168.1.6:3080/?token=x');
    assertAccepted('HtTpS://DSH.Local/Ui/Index', 'https://DSH.Local/Ui/Index');
  });

  test('其它协议一律拒绝（ftp / file / ws）', () => {
    for (const raw of ['ftp://192.168.1.6:3080', 'file:///data/x', 'ws://192.168.1.6:3080']) {
      assertRejected(raw, REASON_SCHEME);
    }
  });
});

describe('normalizeRemoteUrl：空、空格、残缺地址', () => {
  test('空串与纯空白：拒绝，提示先填地址', () => {
    assertRejected('', REASON_EMPTY);
    assertRejected('   ', REASON_EMPTY);
    assertRejected('\t\n', REASON_EMPTY);
  });

  test('只有 `http://` / `https://`：拒绝，提示地址不完整', () => {
    assertRejected('http://', REASON_INCOMPLETE);
    assertRejected('https://', REASON_INCOMPLETE);
    assertRejected('https:///dsh/ui', REASON_INCOMPLETE);
  });

  test('URL 内部有空格：拒绝（前后空白只 trim，不报错）', () => {
    assertRejected('192.168.1.6 :3080', REASON_SPACE);
    assertRejected('http://192.168.1.6:3080/a b', REASON_SPACE);
    assertAccepted('  192.168.1.6:3080/?token=x  ', 'http://192.168.1.6:3080/?token=x');
  });

  test('端口不是数字、host 为空、带账号密码：都归到「地址不完整」', () => {
    assertRejected('192.168.1.6:abc/', REASON_INCOMPLETE);
    assertRejected('http://192.168.1.6:/x', REASON_INCOMPLETE);
    assertRejected('http://:3080', REASON_INCOMPLETE);
    assertRejected('http://user:pass@192.168.1.6:3080', REASON_INCOMPLETE);
  });
});

describe('normalizeRemoteUrl：IPv6 字面量（本轮从拒绝改为接受）', () => {
  test('公网 IPv6 + 端口 + token：整条通过，方括号保留，hasToken 识别', () => {
    const check = assertAccepted(
      'http://[2409:8a20:4cad:ba20:1234:5678:9abc:def0]:3080/?token=abc',
      'http://[2409:8a20:4cad:ba20:1234:5678:9abc:def0]:3080/?token=abc'
    );
    assert.equal(check.hasToken, true);
    assert.equal(check.hadScheme, true);
  });

  test('压缩写法 `[::…]`（`::` 内嵌）也通过', () => {
    assertAccepted('http://[2409:8a20:4cad:ba20::763c]:3080/', 'http://[2409:8a20:4cad:ba20::763c]:3080/');
    assertAccepted('https://[::1]:8443/dsh/ui', 'https://[::1]:8443/dsh/ui');
  });

  test('回环 `[::1]`：带端口 / 不带端口都通过', () => {
    assertAccepted('http://[::1]:3080/', 'http://[::1]:3080/');
    assertAccepted('http://[::1]', 'http://[::1]');
  });

  test('缺协议：`[::1]:3080/` 自动补 http://（hadScheme=false）', () => {
    const check = assertAccepted('[::1]:3080/', 'http://[::1]:3080/');
    assert.equal(check.hadScheme, false);
    assert.equal(check.hasToken, false);
  });

  test('内嵌 IPv4 尾段（`::ffff:a.b.c.d`）与完整 8 组写法都接受', () => {
    assertAccepted('http://[::ffff:192.168.1.1]:3080/?token=x', 'http://[::ffff:192.168.1.1]:3080/?token=x');
    assertAccepted(
      'http://[2409:8a20:4cad:ba20:1234:5678:9abc:def0]:3080/',
      'http://[2409:8a20:4cad:ba20:1234:5678:9abc:def0]:3080/'
    );
  });

  test('协议大小写归一，方括号与地址原样保留', () => {
    assertAccepted('HTTP://[::1]:3080/', 'http://[::1]:3080/');
  });

  test('幂等：IPv6 归一结果再归一，url 不变', () => {
    const first = normalizeRemoteUrl('http://[2409:8a20::763c]:3080/?token=x');
    assert.equal(first.ok, true);
    const second = normalizeRemoteUrl(first.url);
    assert.equal(second.ok, true);
    assert.equal(second.url, first.url);
    assert.equal(second.hasToken, true);
  });

  test('非法 IPv6（5 条以上）：一律落到「地址不完整」', () => {
    for (const raw of [
      'http://[1:2:3]:3080', // 组数不足 8 且没有 `::`
      'http://[::1::2]:3080', // 两个 `::`
      'http://[gggg::1]:3080', // 非十六进制
      'http://[12345::1]:3080', // 单组超过 4 位
      'http://[1:2:3:4:5:6:7:8:9]:3080', // 组数超过 8
      'http://[::ffff:999.1.1.1]:3080', // 内嵌 IPv4 越界
      'http://[::1]:3080:9' // `]` 之后多一段端口
    ]) {
      assertRejected(raw, REASON_INCOMPLETE);
    }
  });

  test('裸 IPv6 / 未闭合 / 空方括号 / 带 @ / 端口非数字：仍然拒绝', () => {
    assertRejected('http://2409:8a20:4cad:ba20::763c:3080', REASON_INCOMPLETE);
    assertRejected('http://[::1:3080', REASON_INCOMPLETE);
    assertRejected('http://[]:3080', REASON_INCOMPLETE);
    assertRejected('http://user@[::1]:3080', REASON_INCOMPLETE);
    assertRejected('http://[::1]:abc', REASON_INCOMPLETE);
    assertRejected('http://[::1]x', REASON_INCOMPLETE);
    assertRejected('http://[::1] :3080', REASON_SPACE);
  });

  test('isIpv6Literal：形态判定（不借 URL 实现）', () => {
    assert.equal(isIpv6Literal('::1'), true);
    assert.equal(isIpv6Literal('2409:8a20:4cad:ba20:1234:5678:9abc:def0'), true);
    assert.equal(isIpv6Literal('::ffff:1.2.3.4'), true);
    assert.equal(isIpv6Literal('::'), true, '未指定地址 `::` 形态合法');
    assert.equal(isIpv6Literal(''), false);
    assert.equal(isIpv6Literal('1.2.3.4'), false, '纯 IPv4 不是 IPv6');
    assert.equal(isIpv6Literal('1:2:3'), false);
    assert.equal(isIpv6Literal('fe80::1%eth0'), false, '带 zone id 不接受');
  });
});

describe('normalizeRemoteUrl：hasToken 判定', () => {
  test('键名大小写不敏感：?token= / ?TOKEN= 都算有 token', () => {
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?token=abc').hasToken, true);
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?TOKEN=abc').hasToken, true);
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?Token=abc').hasToken, true);
  });

  test('没有 token 参数、或只有相似键名：hasToken=false', () => {
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/').hasToken, false);
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?notoken=1').hasToken, false);
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?access_token=1').hasToken, false);
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/#/ui').hasToken, false);
  });

  test('token 在 query 中间也识别；fragment 里的 ?token= 不算 query', () => {
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?a=1&token=abc&b=2').hasToken, true);
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/#/ui?token=abc').hasToken, false);
  });

  test('?token= 空值也算「有这个参数」（有效性由 DSH 判断）', () => {
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?token=').hasToken, true);
  });

  // 与插件侧同源：`src/remote/routes.ts` 的令牌门同时接受 `?token=` 与 `?k=`（评审 M4 让两者等价），
  // App 侧只认 token 会把用户从插件复制来的 `?k=` 地址误判成「未包含 token」。
  test('?k= 与 ?K= 也必须有 token（与服务端令牌门同源）', () => {
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?k=abc').hasToken, true);
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?K=abc').hasToken, true);
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?a=1&k=abc').hasToken, true);
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/#/ui?k=abc').hasToken, false, 'fragment 里的 k 仍不算 query');
    assert.equal(normalizeRemoteUrl('192.168.1.6:3080/?kay=1').hasToken, false, '相似键名 k 开头的不能误判');
  });
});

describe('normalizeRemoteUrl：幂等与路由常量', () => {
  test('幂等：对归一结果再归一，url 不变（第二次 hadScheme 变 true）', () => {
    const first = normalizeRemoteUrl('192.168.1.6:3080/?token=x');
    const second = normalizeRemoteUrl(first.url);
    assert.equal(second.ok, true);
    assert.equal(second.url, first.url);
    assert.equal(second.hadScheme, true);
    assert.equal(second.hasToken, true);
  });

  test('routeToRemote() 恒为 pages/RemoteControl（设置页跳转的唯一定义）', () => {
    assert.equal(routeToRemote(), 'pages/RemoteControl');
    assert.equal(routeToRemote(), routeToRemote());
  });
});

// ---------------------------------------------------------------------------
// 本轮新增：粘贴即用（地址 / 令牌混输）+ 一键重连判定模型。
//
// 这两块都是**纯函数**：不读偏好文件、不发网络请求、不碰 UI。测试只断言返回的
// 结构化字段，因此 UI 接入方（设置页 / 远程控制页）可以按这里的口径写文案与状态机。
// ---------------------------------------------------------------------------

describe('parseRemoteInput：四类输入（url / token / empty / invalid）', () => {
  test('整条 URL（带 token）：kind=url，url 用 normalizeRemoteUrl 的结果，token 抽出', () => {
    const result = parseRemoteInput('http://192.168.1.6:3080/?token=abc');
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'url');
    assert.equal(result.url, 'http://192.168.1.6:3080/?token=abc');
    assert.equal(result.token, 'abc');
    assert.equal(result.reason, '');
    assert.equal(result.hadScheme, true);
  });

  test('整条 URL（不带 token）：kind=url，token 空串', () => {
    const result = parseRemoteInput('https://dsh.local/ui');
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'url');
    assert.equal(result.url, 'https://dsh.local/ui');
    assert.equal(result.token, '');
    assert.equal(result.hadScheme, true);
  });

  test('host:port：与整条 URL 走同一条路（补 http://、hadScheme=false、token 空）', () => {
    const result = parseRemoteInput('192.168.1.6:3080');
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'url');
    assert.equal(result.url, 'http://192.168.1.6:3080');
    assert.equal(result.token, '');
    assert.equal(result.hadScheme, false);
  });

  test('`?k=` / `k=` / `token=` / `?k=…&…` 都识别为纯令牌片段（url 为空串）', () => {
    for (const raw of ['?k=abc', 'k=abc', 'token=abc', '?token=abc&x=1', '?K=abc', 'TOKEN=abc']) {
      const result = parseRemoteInput(raw);
      assert.equal(result.ok, true, `应识别为令牌：${raw}`);
      assert.equal(result.kind, 'token', `类别错误：${raw}`);
      assert.equal(result.token, 'abc', `令牌值错误：${raw}`);
      assert.equal(result.url, '', '令牌片段的 url 必须为空串（由调用方合并到已填地址）');
      assert.equal(result.reason, '');
      assert.equal(result.hadScheme, false);
    }
  });

  test('空串与纯空白：kind=empty，文案与 normalizeRemoteUrl 一致', () => {
    for (const raw of ['', '   ', '\t\n', '\u3000']) {
      const result = parseRemoteInput(raw);
      assert.equal(result.ok, false);
      assert.equal(result.kind, 'empty');
      assert.equal(result.reason, REASON_EMPTY);
      assert.equal(result.url, '');
      assert.equal(result.token, '');
      assert.equal(result.hadScheme, false);
    }
  });

  test('非法输入：file:// / javascript: / 带空格 / 只有 http:// → kind=invalid 且沿用中文原因', () => {
    assert.equal(parseRemoteInput('file://x').kind, 'invalid');
    assert.equal(parseRemoteInput('file://x').reason, REASON_SCHEME);
    assert.equal(parseRemoteInput('javascript://x').reason, REASON_SCHEME);
    // 没写 `://` 的 `javascript:alert(1)` 会被当成「host:端口」→ 端口不是数字
    assert.equal(parseRemoteInput('javascript:alert(1)').kind, 'invalid');
    assert.equal(parseRemoteInput('javascript:alert(1)').reason, REASON_INCOMPLETE);
    assert.equal(parseRemoteInput('192.168.1.6 :3080').reason, REASON_SPACE);
    assert.equal(parseRemoteInput('http://').reason, REASON_INCOMPLETE);
    assert.equal(parseRemoteInput('http://user:pass@192.168.1.6:3080').reason, REASON_INCOMPLETE);
    for (const raw of ['file://x', 'javascript://x', 'http://', '192.168.1.6 :3080']) {
      const result = parseRemoteInput(raw);
      assert.equal(result.ok, false, `应拒绝：${raw}`);
      assert.equal(result.url, '', '非法时 url 必须为空串（fail-closed）');
      assert.equal(result.token, '', '非法时 token 必须为空串');
    }
  });

  test('抽不出令牌值的令牌片段：按 invalid 处理（不返回空令牌）', () => {
    for (const raw of ['?', 'token=', 'k=', '?token=&x=1']) {
      const result = parseRemoteInput(raw);
      assert.equal(result.ok, false, `应拒绝：${raw}`);
      assert.equal(result.kind, 'invalid', `类别错误：${raw}`);
      assert.equal(result.token, '');
      assert.notEqual(result.reason, '');
    }
  });

  test('IPv6 方括号地址原样透传（不因粘贴层再加一套规则）', () => {
    const result = parseRemoteInput('[::1]:3080/?k=x');
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'url');
    assert.equal(result.url, 'http://[::1]:3080/?k=x');
    assert.equal(result.token, 'x');
    assert.equal(result.hadScheme, false);
  });
});

describe('parseRemoteInput：token 抽取口径', () => {
  test('`token` 与 `k` 两种键都能抽（含键名大小写）', () => {
    assert.equal(parseRemoteInput('http://a:1/?token=aaa').token, 'aaa');
    assert.equal(parseRemoteInput('http://a:1/?k=bbb').token, 'bbb');
    assert.equal(parseRemoteInput('http://a:1/?TOKEN=ccc').token, 'ccc');
    assert.equal(parseRemoteInput('http://a:1/?K=ddd').token, 'ddd');
  });

  test('同时出现两个键：取第一个并保持 ok=true', () => {
    const first = parseRemoteInput('http://a:1/?token=aaa&k=bbb');
    assert.equal(first.ok, true);
    assert.equal(first.kind, 'url');
    assert.equal(first.token, 'aaa');
    const second = parseRemoteInput('http://a:1/?k=bbb&token=aaa');
    assert.equal(second.ok, true);
    assert.equal(second.token, 'bbb');
  });

  test('空值不算令牌：`?token=&k=abc` 取到 abc', () => {
    assert.equal(parseRemoteInput('http://a:1/?token=&k=abc').token, 'abc');
  });

  test('percent 编码能解；非法转义原样保留（不整条作废）', () => {
    assert.equal(parseRemoteInput('?k=a%2Fb').token, 'a/b');
    assert.equal(parseRemoteInput('http://a:1/?token=a%20b%2Bc').token, 'a b+c');
    assert.equal(parseRemoteInput('http://a:1/?token=abc%ZZ').token, 'abc%ZZ');
  });

  test('相似键名不误抽：access_token / notoken / fragment 里的 token', () => {
    assert.equal(parseRemoteInput('http://a:1/?access_token=1').token, '');
    assert.equal(parseRemoteInput('http://a:1/?notoken=1').token, '');
    assert.equal(parseRemoteInput('http://a:1/#/ui?token=abc').token, '');
  });
});

describe('mergeRemoteToken：把粘贴的令牌合到已填地址', () => {
  test('地址还没 query：追加 ?token=…', () => {
    assert.equal(mergeRemoteToken('192.168.1.6:3080', 'abc'), 'http://192.168.1.6:3080?token=abc');
    assert.equal(mergeRemoteToken('http://192.168.1.6:3080/', 'abc'), 'http://192.168.1.6:3080/?token=abc');
  });

  test('已有旧令牌：就地替换，其它参数保持原顺序', () => {
    assert.equal(
      mergeRemoteToken('http://a:1/?token=old&x=1', 'new'),
      'http://a:1/?token=new&x=1'
    );
    assert.equal(mergeRemoteToken('http://a:1/?x=1&k=old', 'new'), 'http://a:1/?x=1&k=new');
  });

  test('重复令牌参数只留一个（避免服务端取到旧值）', () => {
    assert.equal(mergeRemoteToken('http://a:1/?token=old&k=old2&x=1', 'new'), 'http://a:1/?token=new&x=1');
  });

  test('空令牌 = 只把地址归一；地址非法 = 空串（fail-closed）', () => {
    assert.equal(mergeRemoteToken('192.168.1.6:3080', ''), 'http://192.168.1.6:3080');
    assert.equal(mergeRemoteToken('192.168.1.6:3080', '   '), 'http://192.168.1.6:3080');
    assert.equal(mergeRemoteToken('file://x', 'abc'), '');
    assert.equal(mergeRemoteToken('http://', 'abc'), '');
  });

  test('令牌值写入时做 percent 编码（与 parseRemoteInput 的解码往返一致）', () => {
    const merged = mergeRemoteToken('http://a:1/', 'a b+c/d');
    assert.equal(merged, 'http://a:1/?token=a%20b%2Bc%2Fd');
    assert.equal(parseRemoteInput(merged).token, 'a b+c/d');
  });

  test('fragment 保留在最后', () => {
    assert.equal(mergeRemoteToken('http://a:1/?x=1#/ui', 'new'), 'http://a:1/?x=1&token=new#/ui');
  });
});

describe('encodeLastOk / decodeLastOk：单行 JSON 与脏数据容忍', () => {
  const ENTRY = { url: 'http://192.168.1.6:3080/?token=abc', at: 1732000000000 };

  test('encode 就是单行 JSON（字段顺序固定）', () => {
    assert.equal(encodeLastOk(ENTRY), '{"url":"http://192.168.1.6:3080/?token=abc","at":1732000000000}');
  });

  test('往返幂等：decode(encode(x)) 等于 x，再 encode 逐字相同', () => {
    const decoded = decodeLastOk(encodeLastOk(ENTRY));
    assert.deepEqual(decoded, ENTRY);
    assert.equal(encodeLastOk(decoded), encodeLastOk(ENTRY));
  });

  test('脏数据一律 null 且不抛（空串 / {} / null / url 空 / at 非数字 / 非 JSON / 数组 / 缺字段）', () => {
    for (const raw of [
      '',
      '   ',
      '{}',
      'null',
      '[]',
      'not json',
      '{"url":"","at":1}',
      '{"url":"   ","at":1}',
      '{"url":"http://a:1/","at":"x"}',
      '{"url":"http://a:1/","at":null}',
      '{"url":"http://a:1/"}',
      '{"at":1}',
      '{"url":1,"at":1}',
      '{"url":"http://a:1/","at":1'
    ]) {
      assert.equal(decodeLastOk(raw), null, `应判脏数据：${JSON.stringify(raw)}`);
    }
  });

  test('非字符串输入也不抛（偏好文件读出来可能是 undefined）', () => {
    assert.equal(decodeLastOk(undefined), null);
    assert.equal(decodeLastOk(null), null);
    assert.equal(decodeLastOk(123), null);
  });

  test('多余字段被忽略，只返回 url / at', () => {
    const decoded = decodeLastOk('{"url":"http://a:1/","at":1,"way":"lan","x":true}');
    assert.deepEqual(decoded, { url: 'http://a:1/', at: 1 });
  });
});

describe('canReconnect：什么时候允许出「重新连接」', () => {
  test('有合法记录 → true', () => {
    assert.equal(canReconnect('{"url":"http://192.168.1.6:3080/?token=abc","at":1732000000000}'), true);
    assert.equal(canReconnect('{"url":"[::1]:3080/","at":1732000000000}'), true);
  });

  test('记录里 url 非法 → false', () => {
    assert.equal(canReconnect('{"url":"file://x","at":1}'), false);
    assert.equal(canReconnect('{"url":"http://","at":1}'), false);
    assert.equal(canReconnect('{"url":"http://a:1/ b","at":1}'), false);
  });

  test('空 / 脏数据 → false', () => {
    assert.equal(canReconnect(''), false);
    assert.equal(canReconnect('{}'), false);
    assert.equal(canReconnect('null'), false);
  });
});

describe('reconnectLabel：按钮文案（绝不回显令牌）', () => {
  const NOW = 1732000000000;
  const TOKEN_VALUE = 'S3CRET-token-value';

  test('可重连 → `重新连接 <host:port>`，且不含令牌值', () => {
    const label = reconnectLabel({ url: `http://192.168.1.6:3080/?token=${TOKEN_VALUE}`, at: NOW - 60_000 }, NOW);
    assert.equal(label, '重新连接 192.168.1.6:3080');
    assert.equal(label.includes(TOKEN_VALUE), false, '按钮文案绝不能回显令牌');
    assert.equal(label.includes('token'), false, '按钮文案连键名都不该出现');
  });

  test('IPv6：authority 保留方括号，不含令牌', () => {
    const label = reconnectLabel({ url: `http://[::1]:3080/dsh/ui?k=${TOKEN_VALUE}`, at: NOW }, NOW);
    assert.equal(label, '重新连接 [::1]:3080');
    assert.equal(label.includes(TOKEN_VALUE), false);
  });

  test('超过 7 天 → 文案仍给但加「（7 天前）」；正好 7 天不加', () => {
    const DAY = 24 * 60 * 60 * 1000;
    assert.equal(
      reconnectLabel({ url: 'http://a:1/', at: NOW - 8 * DAY }, NOW),
      '重新连接 a:1（7 天前）'
    );
    assert.equal(reconnectLabel({ url: 'http://a:1/', at: NOW - 7 * DAY }, NOW), '重新连接 a:1');
    assert.equal(reconnectLabel({ url: 'http://a:1/', at: NOW - 1000 }, NOW), '重新连接 a:1');
  });

  test('无记录 / 记录地址非法 / now 与 at 非数字 → 空串或无后缀，不抛', () => {
    assert.equal(reconnectLabel(null, NOW), '');
    assert.equal(reconnectLabel({ url: 'file://x', at: NOW }, NOW), '');
    assert.equal(reconnectLabel({ url: 'http://a:1/', at: NOW }, Number.NaN), '重新连接 a:1');
    assert.equal(reconnectLabel({ url: 'http://a:1/', at: 0 }, NOW), '重新连接 a:1');
  });
});

describe('sanitizeUrlForDisplay：展示/日志用地址打码', () => {
  test('token 与 k 的值都打码，其余 query 原样保留', () => {
    assert.equal(
      sanitizeUrlForDisplay('http://192.168.1.6:3080/?token=secret&x=1'),
      'http://192.168.1.6:3080/?token=***&x=1'
    );
    assert.equal(sanitizeUrlForDisplay('http://a:1/?k=s&b=2'), 'http://a:1/?k=***&b=2');
    assert.equal(sanitizeUrlForDisplay('http://a:1/?k=s'), 'http://a:1/?k=***');
  });

  test('键名大小写与顺序保留，多个令牌参数全部打码', () => {
    assert.equal(sanitizeUrlForDisplay('http://a:1/?TOKEN=s'), 'http://a:1/?TOKEN=***');
    assert.equal(
      sanitizeUrlForDisplay('http://a:1/?a=1&token=s1&k=s2&z=9'),
      'http://a:1/?a=1&token=***&k=***&z=9'
    );
  });

  test('无令牌时原样返回（可读可复制）；空输入返回空串', () => {
    assert.equal(sanitizeUrlForDisplay('http://a:1/?x=1'), 'http://a:1/?x=1');
    assert.equal(sanitizeUrlForDisplay('http://a:1/'), 'http://a:1/');
    assert.equal(sanitizeUrlForDisplay('http://a:1/?access_token=1'), 'http://a:1/?access_token=1');
    assert.equal(sanitizeUrlForDisplay(''), '');
    assert.equal(sanitizeUrlForDisplay(undefined), '');
  });

  test('fragment 与路径不受影响；fragment 里的 token 不算 query（与 hasToken 同口径）', () => {
    assert.equal(
      sanitizeUrlForDisplay('http://a:1/dsh/ui?token=s#/ui'),
      'http://a:1/dsh/ui?token=***#/ui'
    );
    assert.equal(sanitizeUrlForDisplay('http://a:1/#/ui?token=s'), 'http://a:1/#/ui?token=s');
  });

  test('打码结果里不含原始令牌值（回归断言）', () => {
    const secret = 'S3CRET-token-value';
    const shown = sanitizeUrlForDisplay(`http://192.168.1.6:3080/?token=${secret}&x=1`);
    assert.equal(shown.includes(secret), false);
    assert.equal(shown.includes('***'), true);
  });
});
