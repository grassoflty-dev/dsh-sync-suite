// 凭据打码工具的单元测试。
// 关键纪律：fixture 必须在本文件里生成（合成值，不是任何真实凭据），
// 断言只检查「占位符出现 / fixture 不出现」，绝不打印或回显 fixture 本身。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { redact } from '../../../../tools/redact.mjs';

/** 生成合成密钥：固定 LCG 保证可复现，且强制含数字与大写以命中「像密钥」判据。 */
function makeFixtureSecret() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let seed = 0x5eed1234;
  const body = [];
  for (let i = 0; i < 48; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    body.push(alphabet[seed % alphabet.length]);
  }
  body[10] = '7';
  body[20] = 'Q';
  return 'sk-' + body.join('');
}

const FIXTURE = makeFixtureSecret();
// 第二个合成 fixture：17 位纯小写、无数字、长度 <24 —— 形状启发式抓不到，
// 只有语义键名绑定能遮罩（B1 回归用）。
const SHORT_FIXTURE = 'shortsecret' + 'abcabc';
const PH = '<redacted>';
const PH_HEX = '<redacted-hex>';

function assertMasked(out, fixture = SHORT_FIXTURE) {
  assert.ok(out.includes(PH) || out.includes(PH_HEX), '占位符缺失');
  assert.equal(out.includes(fixture), false, 'fixture 泄漏');
}

describe('redact()：按模式遮罩凭据，不回显原值', () => {
  test('R01 合成密钥赋值 → 只留占位符，fixture 不出现', () => {
    const out = redact(`apiKey = ${FIXTURE}`);
    assert.match(out, new RegExp(PH.replace(/[<>/]/g, '\\$&')));
    assert.equal(out.includes(FIXTURE), false);
  });

  test('R02 合成密钥出现在普通叙述里 → fixture 不出现', () => {
    const out = redact(`日志：请求头里带了 ${FIXTURE}，请排查。`);
    assert.equal(out.includes(FIXTURE), false);
    assert.ok(out.includes(PH));
  });

  test('R03 32 位十六进制 → <redacted-hex>，不含长度类别', () => {
    const hex = 'a1'.repeat(16);
    const out = redact(`hash=${hex}`);
    assert.equal(out.includes(hex), false);
    assert.ok(out.includes(PH_HEX));
    assert.equal(/redacted-hex-\d|32hex|len=32/i.test(out), false);
  });

  test('R04 40 / 64 位十六进制 → 同一占位符（不泄露长度）', () => {
    const h40 = 'b2'.repeat(20);
    const h64 = 'c3'.repeat(32);
    const out = redact(`${h40} ${h64}`);
    assert.equal(out.includes(h40), false);
    assert.equal(out.includes(h64), false);
    assert.equal((out.match(/<redacted-hex>/g) || []).length, 2);
  });

  test('R05 长 base64/字母数字串 → <redacted>', () => {
    const out = redact(`payload: ${FIXTURE}`);
    assert.equal(out.includes(FIXTURE), false);
    assert.ok(out.includes(PH));
  });

  test('R06 Bearer 值被遮罩，Bearer 前缀保留', () => {
    const out = redact(`Authorization: Bearer ${FIXTURE}`);
    assert.equal(out.includes(FIXTURE), false);
    assert.match(out, /^Authorization: Bearer <redacted>$/);
  });

  test('R07 Basic 的 Authorization 值被遮罩，scheme 保留', () => {
    const value = 'dXNlcjpwYXNzd29yZA==';
    const out = redact(`Authorization: Basic ${value}`);
    assert.equal(out.includes(value), false);
    assert.match(out, /^Authorization: Basic <redacted>$/);
  });

  test('R08 ?token= 与 &access_token= 查询值被遮罩，path 保留', () => {
    const out = redact('https://example.com/api/v1?token=abcdef1234567890&access_token=ZZZ999yyy888xxx');
    assert.match(out, /^https:\/\/example\.com\/api\/v1\?token=<redacted>&access_token=<redacted>$/);
  });

  test('R09 URL userinfo 被遮罩，scheme/host/path 保留', () => {
    const out = redact('https://alice:s3cr3t@example.com/schedules?x=1');
    assert.equal(out.includes('s3cr3t'), false);
    assert.match(out, /^https:\/\/<redacted>@example\.com\/schedules\?x=<redacted>$/);
  });

  test('R10 敏感键赋值只遮罩值，保留键名', () => {
    for (const key of ['password', 'secret', 'apikey', 'storepass', 'keypass', 'token']) {
      const out = redact(`${key}=hunter2`);
      assert.match(out, new RegExp(`^${key}=<redacted>$`));
    }
  });

  test('R11 幂等：打码结果再打一次不变', () => {
    const once = redact(
      `token=${FIXTURE}\nBearer ${FIXTURE}\n${'d4'.repeat(16)}\nhttps://u:p@h/x?token=abcdef123456`
    );
    assert.equal(redact(once), once);
  });

  test('R12 null / undefined / 怪对象不抛异常', () => {
    assert.equal(redact(null), '');
    assert.equal(redact(undefined), '');
    assert.equal(redact(Object.create(null)), '');
    assert.doesNotThrow(() => redact({ toString: () => { throw new Error('odd'); } }));
  });

  test('R13 unicode 与超大输入不抛异常，普通文本不变', () => {
    assert.equal(redact('中文日程：周会 ✓'), '中文日程：周会 ✓');
    const huge = '你'.repeat(200000);
    assert.doesNotThrow(() => redact(huge));
    assert.equal(redact(huge), huge);
  });

  test('R14 短的非敏感字母数字串不被误伤', () => {
    assert.equal(redact('deepseek-v4.1-flash 2026-11-22'), 'deepseek-v4.1-flash 2026-11-22');
  });

  // B1 回归：语义键名 + XML/JSON 形状，短小写值也必须遮罩。
  test('R15 aiKey= 短小写值', () => {
    const out = redact(`aiKey=${SHORT_FIXTURE}`);
    assertMasked(out);
    assert.match(out, /^aiKey=<redacted>$/);
  });

  test('R16 remoteToken= 短小写值', () => {
    const out = redact(`remoteToken=${SHORT_FIXTURE}`);
    assertMasked(out);
    assert.match(out, /^remoteToken=<redacted>$/);
  });

  test('R17 JSON {"aiKey":"…"}', () => {
    const out = redact(`{"aiKey":"${SHORT_FIXTURE}"}`);
    assertMasked(out);
    assert.match(out, /^\{"aiKey":"<redacted>"\}$/);
  });

  test('R18 JSON {"remoteToken":"…"}', () => {
    const out = redact(`{"remoteToken":"${SHORT_FIXTURE}"}`);
    assertMasked(out);
    assert.match(out, /^\{"remoteToken":"<redacted>"\}$/);
  });

  test('R19 XML 元素 <string key="aiKey">…</string>', () => {
    assertMasked(redact(`<string key="aiKey">${SHORT_FIXTURE}</string>`));
  });

  test('R20 XML 元素 <string key="token">…</string>', () => {
    assertMasked(redact(`<string key="token">${SHORT_FIXTURE}</string>`));
  });

  test('R21 XML 属性对 key="token" value="…"', () => {
    assertMasked(redact(`key="token" value="${SHORT_FIXTURE}"`));
  });

  test('R22 XML CDATA 体 <![CDATA[…]]>', () => {
    assertMasked(redact(`<string key="token"><![CDATA[${SHORT_FIXTURE}]]></string>`));
  });

  test('R23 前后缀键名 aiFallbackKey / clientSecret / api_key', () => {
    for (const key of ['aiFallbackKey', 'clientSecret', 'api_key', 'mytoken']) {
      const out = redact(`${key}=${SHORT_FIXTURE}`);
      assertMasked(out);
      assert.ok(out.startsWith(key + '=<redacted>'));
    }
  });

  test('R24 &quot; 实体编码的 aiKey 键值', () => {
    const out = redact(`&quot;aiKey&quot;:&quot;${SHORT_FIXTURE}&quot;`);
    assertMasked(out);
    assert.match(out, /&quot;aiKey&quot;:&quot;<redacted>&quot;/);
  });

  test('R25 新形状全部幂等', () => {
    const once = [
      `aiKey=${SHORT_FIXTURE}`,
      `remoteToken=${SHORT_FIXTURE}`,
      `{"aiKey":"${SHORT_FIXTURE}"}`,
      `<string key="aiKey">${SHORT_FIXTURE}</string>`,
      `key="token" value="${SHORT_FIXTURE}"`,
      `<string key="token"><![CDATA[${SHORT_FIXTURE}]]></string>`,
      `&quot;clientSecret&quot;:&quot;${SHORT_FIXTURE}&quot;`
    ].join('\n');
    const redacted = redact(once);
    assert.equal(redact(redacted), redacted);
    assertMasked(redacted);
  });

  test('R26 authorization 键：带 scheme 保留 scheme，裸值遮罩', () => {
    const withScheme = redact(`Authorization: Bearer ${SHORT_FIXTURE}`);
    assert.equal(withScheme, 'Authorization: Bearer <redacted>');
    const bare = redact(`authorization: ${SHORT_FIXTURE}`);
    assertMasked(bare);
  });

  test('R27 aiBaseURL 不是凭据键：端点保留，query 值仍遮罩', () => {
    const out = redact(`aiBaseURL=https://opencode.ai/inference/go/v1?token=${SHORT_FIXTURE}`);
    assert.ok(out.includes('https://opencode.ai/inference/go/v1?token=<redacted>'));
  });
});
