// 凭据打码工具：按「模式 + 语义键名」而非整条 URL 遮罩，供任何可能含凭据的命令输出在进 transcript 前使用。
//
// 设计约束（docs/MODULES.md §0 规则 11）：
//   - 只输出占位符 <redacted> / <redacted-hex>，绝不回显原值、长度或长度类别；
//   - 键名说了是凭据就遮罩，值多短、多普通都不例外（长度不是安全信号）；
//   - 幂等：已经打过的字符串再打一次不变；
//   - 对 null / 非字符串 / 超大 / unicode 输入不抛异常；异常时 fail-closed。
//
// CLI：node tools/redact.mjs < input.txt > output.txt

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PH = '<redacted>';
const PH_HEX = '<redacted-hex>';

/**
 * 语义凭据键：键名中任意位置出现这些成分即视为凭据，大小写不敏感、允许前后缀
 * （aiKey / remoteToken / api_key / clientSecret / aiFallbackKey / token ...）。
 * 不把 aiBaseURL 之类的「端点 URL 键」算作凭据：其 query 值仍由 URL 规则遮罩。
 */
function isCredentialKey(name) {
  return /token|key|secret|pass|pwd|credential|authorization/i.test(String(name));
}

/** 已是占位符的值原样返回，保证幂等（含 CDATA 与 XML 转义形态）。 */
function maskedValue(value) {
  return /^<redacted(?:-hex)?>$/.test(value) ||
    /^&lt;redacted(?:-hex)?&gt;$/.test(value) ||
    value.includes('<![CDATA[<redacted') ||
    value.includes('<![CDATA[<redacted-hex')
    ? value
    : PH;
}

/** 把任意输入安全地变成字符串；null/undefined 视作空串，怪对象也不抛。 */
function coerce(input) {
  if (typeof input === 'string') return input;
  if (input === null || input === undefined) return '';
  try {
    return String(input);
  } catch {
    return '';
  }
}

/** 长字母数字串「像不像密钥」：有数字，且有大小写混合 / 密钥常见符号 / 足够长。 */
function looksLikeSecret(run) {
  return /[0-9]/.test(run) && (/[A-Z]/.test(run) || /[_\-+/=]/.test(run) || run.length >= 32);
}

function mask(text) {
  let s = text;

  // 1) URL：保留 scheme + host + path，遮罩 userinfo 与所有 query 值。
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]+)@/gi, (_m, head) => head + PH + '@');
  s = s.replace(/([?&])([^=&?#\s]+)=([^&#\s"'<>]*)/g, (m, sep, key, value) =>
    value ? sep + key + '=' + maskedValue(value) : m
  );

  // 2) XML 属性对：key="X" value="Y"（含反序），键名是凭据就遮罩属性值。
  s = s.replace(
    /(\bkey\s*=\s*["'])([^"']+)(["']\s+value\s*=\s*["'])([^"']*)(["'])/gi,
    (m, head, name, mid, value, tail) =>
      isCredentialKey(name) ? head + name + mid + maskedValue(value) + tail : m
  );
  s = s.replace(
    /(\bvalue\s*=\s*["'])([^"']*)(["']\s+key\s*=\s*["'])([^"']+)(["'])/gi,
    (m, head, value, mid, name, tail) =>
      isCredentialKey(name) ? head + maskedValue(value) + mid + name + tail : m
  );

  // 3) XML 元素体：<string key="X">Y</string> 与 CDATA 体 <![CDATA[Y]]>。
  s = s.replace(
    /(<([\w.-]+)\s+)(key\s*=\s*(["'])([^"']+)\4)([^>]*>)(?:<!\[CDATA\[([^\]]*)\]\]>|([^<]*))(<\/\2\s*>)/gi,
    (m, open, _tag, keyAttr, _q, name, afterKey, cdata, plain, close) => {
      if (!isCredentialKey(name)) return m;
      const body = cdata !== undefined
        ? '<![CDATA[' + maskedValue(cdata) + ']]>'
        : maskedValue(plain);
      return open + keyAttr + afterKey + body + close;
    }
  );

  // 4) JSON / 类 JSON 键值（普通引号与 &quot; 实体编码），短值也要遮罩。
  s = s.replace(/(["'])([^"'\n]{1,200})\1(\s*[:=]\s*)(["'])([^"'\n]{0,512})\4/g, (m, q, name, sep, vq, value) =>
    isCredentialKey(name) ? q + name + q + sep + vq + maskedValue(value) + vq : m
  );
  s = s.replace(/(&quot;)([^&]{1,200})\1(\s*[:=]\s*)\1([^&]{0,512})\1/gi, (m, q, name, sep, value) =>
    isCredentialKey(name) ? q + name + q + sep + q + maskedValue(value) + q : m
  );

  // 5) 普通赋值 / 冒号绑定：捕获完整键名（aiKey、remoteToken 不再被 \b 锚漏掉）。
  s = s.replace(
    /\b([A-Za-z_$][\w.$\-\[\]]*)(\s*[:=]\s*)(?:(["'])([^"'\n]{1,512})\3|([^\s,;&<>"']{1,512}))/g,
    (m, name, sep, quote, quoted, plain) => {
      const value = quote ? quoted : plain;
      // key/value 是 XML 属性标记名，不是凭据值；Bearer/Basic 等 scheme 交给规则 6。
      if (!isCredentialKey(name) || /^(key|value)$/i.test(name) || /^(Bearer|Basic|Token|Digest)$/i.test(value)) return m;
      return name + sep + (quote ? quote + maskedValue(value) + quote : maskedValue(value));
    }
  );

  // 6) Authorization / Bearer：先处理带 scheme 的整行，避免 Bearer 被当成值二次遮罩。
  s = s.replace(
    /\b(Authorization\s*:\s*)((?:Bearer|Basic|Token|Digest)\s+)?(?!(?:Bearer|Basic|Token|Digest)\b)([^\s,;"'<>]+)/gi,
    (_m, head, scheme, _value) => head + (scheme || '') + PH
  );
  s = s.replace(/\b(Bearer\s+)([^\s,;"'<>]+)/gi, (_m, prefix) => prefix + PH);

  // 7) 裸十六进制串（24+，覆盖 24/32/40/64 等等级）；不输出长度类别。
  s = s.replace(/(?<![A-Za-z0-9])[0-9a-fA-F]{24,}(?![A-Za-z0-9])/g, PH_HEX);

  // 8) 裸 base64 / 长字母数字串（24+）中像密钥的那些。
  s = s.replace(/(?<![A-Za-z0-9])[A-Za-z0-9+/=_-]{24,}(?![A-Za-z0-9])/g, (run) =>
    looksLikeSecret(run) ? PH : run
  );

  return s;
}

/** 对文本做凭据打码。永远返回字符串、永不抛异常；异常时 fail-closed，只返回占位符。 */
export function redact(input) {
  const s = coerce(input);
  if (s.length === 0) return s;
  try {
    return mask(s);
  } catch {
    // 安全网绝不把可能含凭据的原文交回调用方（M1：fail closed，不 fail open）。
    return PH;
  }
}

export default redact;

// 直接执行时作为 stdin → stdout 的小 CLI；被 import 时不产生副作用。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    process.stdout.write(redact(readFileSync(0, 'utf8')));
  } catch (err) {
    process.stderr.write(String(err && err.message ? err.message : err) + '\n');
    process.exitCode = 1;
  }
}
