// 「远程控制」地址归一/校验（`model/remoteUrl.ts`）的纯函数测试。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 重点：这个地址是**用户手输的不可信输入**（缺协议、夹空格、协议乱写、只有 `http://`），
// 规则必须 fail-closed 且给中文原因；通过时只补协议、其余（端口/路径/query/token 值）原样保留。
// 该模块没有任何 import，因此不需要 registerHooks 补 `.js` 后缀。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { normalizeRemoteUrl, routeToRemote } = await import('../.build/model/remoteUrl.js');

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
