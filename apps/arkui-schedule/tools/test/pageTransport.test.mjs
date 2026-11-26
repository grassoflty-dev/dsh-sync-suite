// mod-remote-page-webview：pageDecision 表 + RemoteControl 接线形状守卫。
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

const P = await import('../.build/model/pageTransport.js');
const { pageDecision, PAGE_TRANSPORT_TABLE, TOCTOU_SENTENCE } = P;

/** 模型头声明的三条禁用词（模型里只有注释声明，可执行源码与页面都不得出现）。 */
const BANNED_PAGE_WORDING = ['防中间人', '已验证身份', '校验证书链', '安全连接已启用'];

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(resolve(HERE, '../../entry/src/main/ets/pages/RemoteControl.ets'), 'utf8');
const MODEL = readFileSync(resolve(HERE, '../../entry/src/main/ets/model/pageTransport.ts'), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('A. pageDecision 五行', () => {
  test('A1 http ⇒ load + 明文标签（pin 状态无关）', () => {
    for (const pinState of ['absent', 'verified', 'mismatch']) {
      const d = pageDecision({ scheme: 'HTTP', pinState });
      assert.equal(d.action, 'load');
      assert.equal(d.labelKey, 'PLAINTEXT_HTTP');
      assert.equal(d.label, '明文传输，令牌随地址明文发送，仅在你信任的网络内使用');
    }
  });

  test('A2 https + 已验证 pin ⇒ load + 校验标签', () => {
    const d = pageDecision({ scheme: 'https', pinState: 'verified' });
    assert.deepEqual([d.action, d.labelKey, d.label],
      ['load', 'HTTPS_PIN_VERIFIED', '已比对叶证书指纹与配对记录一致']);
  });

  test('A3 https 无 pin ⇒ refuse 且文案点名「未配对 / 没有证书指纹」', () => {
    const d = pageDecision({ scheme: 'https', pinState: 'absent' });
    assert.equal(d.action, 'refuse');
    assert.equal(d.labelKey, 'HTTPS_NO_PIN');
    assert.match(d.label, /未配对/);
    assert.match(d.label, /没有证书指纹/);
  });

  test('A4 https pin 不匹配 ⇒ refuse 且文案点名 "不一致"', () => {
    const d = pageDecision({ scheme: 'https', pinState: 'mismatch' });
    assert.equal(d.action, 'refuse');
    assert.equal(d.labelKey, 'HTTPS_PIN_MISMATCH');
    assert.match(d.label, /不一致/);
  });

  test('A5 Tailscale 没有专属行：同一 verified 文案，零附加形容词', () => {
    const d = pageDecision({ scheme: 'https', pinState: 'verified' });
    assert.equal(d.label, PAGE_TRANSPORT_TABLE['https:verified'].label);
    for (const word of ['安全', '可信', '加密更强', 'Tailscale']) {
      assert.equal(d.label.includes(word), false, `verified 行不得含「${word}」`);
    }
  });

  test('A6 预检未完成 / 未知 scheme 也落在表内拒绝行', () => {
    assert.equal(pageDecision({ scheme: 'https', pinState: 'preflight-failed' }).action, 'refuse');
    assert.equal(pageDecision({ scheme: 'ftp', pinState: 'verified' }).labelKey, 'UNSUPPORTED_SCHEME');
    assert.equal(Object.isFrozen(PAGE_TRANSPORT_TABLE), true, '决策表必须冻结');
  });

  test('A7 https 成功行逐字钉死：只说叶指纹比对，不声称证书链/身份/安全', () => {
    const label = PAGE_TRANSPORT_TABLE['https:verified'].label;
    assert.equal(label, '已比对叶证书指纹与配对记录一致');
    for (const bad of ['校验证书链', '已验证身份', '安全', '防中间人']) {
      assert.equal(label.includes(bad), false, `verified 文案不得含「${bad}」`);
    }
  });

  test('A8 明文 http 行逐字钉死：点名令牌随地址明文发送', () => {
    const label = PAGE_TRANSPORT_TABLE['http'].label;
    assert.equal(label, '明文传输，令牌随地址明文发送，仅在你信任的网络内使用');
    assert.match(label, /令牌随地址明文发送/);
  });
});

describe('B. 禁用词与 TOCTOU 文案', () => {
  test('B1 四个禁用词在模型头声明，在可执行源码与页面里逐字绝迹', () => {
    for (const bad of BANNED_PAGE_WORDING) {
      assert.equal(MODEL.includes(bad), true, `模型头必须声明禁用词 ${bad}`);
      assert.equal(stripComments(MODEL).includes(bad), false, `模型可执行源码不得出现 ${bad}`);
      assert.equal(stripComments(PAGE).includes(bad), false, `页面不得出现 ${bad}`);
    }
  });

  test('B2 TOCTOU 句子点名「另一次独立连接」与「更换证书」', () => {
    assert.match(TOCTOU_SENTENCE, /另一次独立连接/);
    assert.match(TOCTOU_SENTENCE, /更换证书/);
    assert.match(TOCTOU_SENTENCE, /不会发现/);
    assert.equal(PAGE.includes('TOCTOU_SENTENCE'), true, '页面必须从模型渲染这句话');
  });

  test('B3 旧页面级凭据拒绝句已从页面整体消失', () => {
    assert.equal(PAGE.includes('安全连接尚未启用'), false);
    assert.equal(PAGE.includes('未向电脑发送凭据'), false);
  });
});

describe('C. RemoteControl 接线形状（没有内联分类/标签、只有决策成功才挂 Web）', () => {
  const code = stripComments(PAGE);

  test('C1 页面调用纯函数，不内联分类或标签文案', () => {
    for (const call of ['normalizeHostPort(', 'classifyTransport(', 'transportChip(',
      'pageDecision(', 'sslGrant(', 'sslConsume(']) {
      assert.ok(code.includes(call), `页面必须调用 ${call}`);
    }
    for (const bad of ['局域网', 'IPv6', 'Tailscale', '明文传输', '已比对叶证书指纹与配对记录一致']) {
      assert.equal(code.includes(bad), false, `页面不得内联文案 ${bad}`);
    }
  });

  test('C2 Web 只在 webMounted（决策 action=load）后挂载', () => {
    assert.match(code, /this\.webMounted = decision\.action === 'load'/);
    const buildBody = code.slice(code.indexOf('build() {'), code.indexOf('build() {') + 1600);
    assert.match(buildBody, /if \(this\.webMounted\) \{\s*this\.RemoteBody\(\)\s*\} else \{\s*this\.RefusedView\(\)\s*\}/,
      'build() 必须把 Web 放在 webMounted 分支里');
    assert.equal((code.match(/Web\(\{ src: this\.url/g) ?? []).length, 1, 'Web 只能有一处挂载');
  });

  test('C3 SSL 错误只经 sslConsume 确认；pageDecision 拒绝路径绝不 grant', () => {
    const ssl = code.slice(code.indexOf('private handleSslError('), code.indexOf('private recordLastOk('));
    assert.match(ssl, /if \(sslConsume\(this\.allowanceKey\(\), Date\.now\(\)\)\)/);
    assert.equal((ssl.match(/handleConfirm\(\)/g) ?? []).length, 1);
    assert.equal((ssl.match(/handleCancel\(true\)/g) ?? []).length, 1);
    assert.equal(ssl.includes('verifyPinnedCertificate'), false, 'SSL 回调不再重复读 pin');
    assert.equal(ssl.includes('tlsFingerprint'), false, 'SSL 回调绝不写/读 pin 字段');
    const apply = code.slice(code.indexOf('private applyAddress('), code.indexOf('private applyDecision('));
    assert.equal(apply.includes('sslGrant('), false, '决策拒绝路径不得预授权');
  });

  // retarget（mod-app-remote-page-pure，不放松）：产品决定把「发指令到这台电脑」整块从本页删除，
  // 旧的「挂载调用逐字节未变」因此失去主体（那段调用已不存在）。改为钉住新事实——同一处切片位置、
  // 同一组组件名，期望值取反：0 次 import、0 次挂载、命令通道的页面侧接线（目标名 / 授权查询）0 处。
  // 下架不等于放宽：以前要求「恰好一次」，现在要求「一处都没有」，两边都是精确计数。
  test('C4 composer 已从本页删除：0 次 import / 0 次挂载 / 无命令通道接线', () => {
    assert.equal(PAGE.includes('RemoteCommandComposer'), false,
      '远程页不得再 import 或挂载 composer（发指令面板已下架）');
    assert.equal((PAGE.match(/RemoteCommandComposer\s*\(/g) ?? []).length, 0,
      '整页不允许任何 composer 挂载调用');
    for (const gone of ['targetDisplayName', 'targetCommandGranted', 'instanceGrantStore', 'canPrompt(']) {
      assert.equal(PAGE.includes(gone), false, `页面不得再有命令通道接线 ${gone}`);
    }
  });

  test('C5 TOCTOU 行只在预检真正通过后显示（httpsVerified 守卫），全页恰好一处', () => {
    const info = code.slice(code.indexOf('TransportInfo() {'), code.indexOf('RemoteBody() {'));
    assert.match(info, /if \(this\.httpsVerified\) \{/,
      'TOCTOU 行必须受 httpsVerified（预检通过）守卫保护');
    assert.equal(info.includes("this.address.scheme === 'https'"), false,
      '不得回退到只看 scheme：https 无 pin / 预检失败时并没有预检可描述');
    assert.equal((info.match(/Text\(TOCTOU_SENTENCE\)/g) ?? []).length, 1,
      'TransportInfo 内 TOCTOU 行恰好一处');
    assert.equal((code.match(/Text\(TOCTOU_SENTENCE\)/g) ?? []).length, 1,
      '全页 Text(TOCTOU_SENTENCE) 恰好一处，不能另有无条件副本');
    const guardAt = info.indexOf('if (this.httpsVerified)');
    const textAt = info.indexOf('Text(TOCTOU_SENTENCE)');
    assert.ok(guardAt >= 0 && textAt > guardAt, 'TOCTOU 行必须出现在 httpsVerified 守卫之后');
    assert.equal(info.slice(guardAt, textAt).includes('}'), false,
      'TOCTOU 行必须在 httpsVerified 守卫块内部，不能落在块外无条件渲染');
  });

  test('C6 预检先剥观察 host 的方括号，再调用 verifyLeafPin（IPv6 不误拒）', () => {
    const pre = code.slice(code.indexOf('private async preflight('), code.indexOf('private allowanceKey('));
    const normalizeAt = pre.indexOf('this.normalizeObservedHost(context.host)');
    const verifyAt = pre.indexOf('verifyLeafPin(');
    assert.ok(normalizeAt >= 0, '预检必须先归一观察到的 host');
    assert.ok(verifyAt > normalizeAt, '剥括号的源码位置必须在 verifyLeafPin( 之前');
    assert.match(pre, /host: observedHost,/, 'verifyLeafPin 必须收到归一后的 host');
    assert.equal(pre.includes('host: context.host'), false, '不得把原始 context.host 直传');
    const helper = code.slice(code.indexOf('private normalizeObservedHost('),
      code.indexOf('private async preflight('));
    assert.match(helper, /startsWith\('\['\)/, '必须剥前导 [');
    assert.match(helper, /endsWith\('\]'\)/, '必须剥结尾 ]');
  });

  test('C7 sslGrant 只在 pin 校验成功之后执行（mismatch 分支先 return）', () => {
    const pre = code.slice(code.indexOf('private async preflight('), code.indexOf('private allowanceKey('));
    const mismatchAt = pre.indexOf("'E_PIN_MISMATCH'");
    const pinOkAt = pre.indexOf('if (!pinOk)');
    const grantAt = pre.indexOf('sslGrant(');
    assert.ok(mismatchAt >= 0 && pinOkAt >= 0 && grantAt >= 0, '预检必须含拒绝分支与 grant');
    assert.ok(pinOkAt < grantAt, '!pinOk 拒绝分支必须在 sslGrant( 之前');
    assert.ok(mismatchAt < grantAt, 'E_PIN_MISMATCH 分支必须在 sslGrant( 之前');
    assert.match(pre.slice(pinOkAt, grantAt), /return;/, '拒绝分支必须先 return 才可能走到 grant');
  });
});
