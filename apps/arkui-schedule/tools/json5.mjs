/**
 * JSON5 子集解析器（无第三方依赖，供 `tools/validate-app.mjs` 与测试使用）。
 *
 * 支持：
 * - `//` 行注释与 `/* *\/` 块注释；
 * - 尾逗号（对象、数组）；
 * - 单引号 / 双引号字符串，含 JSON5 转义（`\xHH`、`\uHHHH`、引号、续行）；
 * - 无引号的对象键（IdentifierName）；
 * - 数字：十进制、前导/后置小数点、指数、`0x` 十六进制、`Infinity`/`NaN`、前导正负号；
 * - 多行字符串（用 `\` + 换行续行）。
 *
 * 错误信息统一为 `JSON5 解析失败（第 N 行）：原因`，便于定位到具体文件行。
 * 重复键按 JSON5 规范「后者覆盖前者」。
 */

const WHITESPACE = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '\v',
  '\f',
  '\u00a0',
  '\ufeff',
  '\u2028',
  '\u2029'
]);

const ESCAPES = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  0: '\0'
};

const NUMBER_RE = /^[+-]?(?:Infinity|NaN|0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/;
const IDENT_RE = /^[A-Za-z_$\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/;

class Json5Parser {
  constructor(text) {
    this.text = String(text).replace(/^\ufeff/, '');
    this.pos = 0;
    this.length = this.text.length;
  }

  /** 计算某偏移对应的 1 起行号（错误信息用）。 */
  lineOf(position) {
    const limit = Math.max(0, Math.min(position, this.length));
    let line = 1;
    for (let i = 0; i < limit; i++) {
      if (this.text.charCodeAt(i) === 10) {
        line++;
      }
    }
    return line;
  }

  fail(reason, position = this.pos) {
    throw new SyntaxError(`JSON5 解析失败（第 ${this.lineOf(position)} 行）：${reason}`);
  }

  eof() {
    return this.pos >= this.length;
  }

  peek() {
    return this.text[this.pos];
  }

  skipTrivia() {
    while (this.pos < this.length) {
      const char = this.text[this.pos];
      if (WHITESPACE.has(char)) {
        this.pos++;
        continue;
      }
      if (char === '/' && this.text[this.pos + 1] === '/') {
        this.pos += 2;
        while (this.pos < this.length && this.text[this.pos] !== '\n' && this.text[this.pos] !== '\r') {
          this.pos++;
        }
        continue;
      }
      if (char === '/' && this.text[this.pos + 1] === '*') {
        const start = this.pos;
        this.pos += 2;
        let closed = false;
        while (this.pos < this.length) {
          if (this.text[this.pos] === '*' && this.text[this.pos + 1] === '/') {
            this.pos += 2;
            closed = true;
            break;
          }
          this.pos++;
        }
        if (!closed) {
          this.fail('块注释未闭合', start);
        }
        continue;
      }
      break;
    }
  }

  parseValue() {
    this.skipTrivia();
    if (this.eof()) {
      this.fail('意外的文件结尾，缺少值');
    }
    const char = this.peek();
    if (char === '{') {
      return this.parseObject();
    }
    if (char === '[') {
      return this.parseArray();
    }
    if (char === '"' || char === "'") {
      return this.parseString();
    }
    if (char === 't' || char === 'f' || char === 'n' || char === '+' || char === '-' || char === '.' || (char >= '0' && char <= '9')) {
      return this.parseNumberOrLiteral();
    }
    if (/[A-Za-z_$]/.test(char)) {
      return this.parseNumberOrLiteral();
    }
    this.fail(`无法识别的字符 ${JSON.stringify(char)}`);
    return undefined;
  }

  parseNumberOrLiteral() {
    const rest = this.text.slice(this.pos);
    const literalMatch = /^(true|false|null|Infinity|NaN)/.exec(rest);
    if (literalMatch !== null) {
      const word = literalMatch[1];
      const after = rest[word.length];
      if (after === undefined || !/[A-Za-z0-9_$]/.test(after)) {
        this.pos += word.length;
        if (word === 'true') {
          return true;
        }
        if (word === 'false') {
          return false;
        }
        if (word === 'null') {
          return null;
        }
        if (word === 'Infinity') {
          return Infinity;
        }
        return NaN;
      }
    }

    const match = NUMBER_RE.exec(rest);
    if (match === null) {
      this.fail('不是合法的 JSON5 值');
    }
    const raw = match[0];
    const after = rest[raw.length];
    if (after !== undefined && /[A-Za-z0-9_$]/.test(after)) {
      this.fail(`数字后面跟了多余字符 ${JSON.stringify(after)}`);
    }
    this.pos += raw.length;
    const sign = raw.startsWith('-') ? -1 : 1;
    const body = raw.replace(/^[+-]/, '');
    if (body === 'Infinity') {
      return sign * Infinity;
    }
    if (body === 'NaN') {
      return NaN;
    }
    if (/^0[xX]/.test(body)) {
      return sign * Number.parseInt(body.slice(2), 16);
    }
    return Number.parseFloat(raw);
  }

  parseString() {
    const quote = this.text[this.pos];
    const start = this.pos;
    this.pos++;
    let out = '';
    while (this.pos < this.length) {
      const char = this.text[this.pos];
      if (char === quote) {
        this.pos++;
        return out;
      }
      if (char === '\\') {
        this.pos++;
        out += this.readEscape();
        continue;
      }
      if (char === '\n' || char === '\r') {
        this.fail('字符串内不允许裸换行（多行请用反斜杠续行）', this.pos);
      }
      out += char;
      this.pos++;
    }
    this.fail('字符串未闭合', start);
    return out;
  }

  readEscape() {
    if (this.eof()) {
      this.fail('转义符后缺少字符');
    }
    const char = this.text[this.pos];
    this.pos++;
    if (char === '\n') {
      return '';
    }
    if (char === '\r') {
      if (this.text[this.pos] === '\n') {
        this.pos++;
      }
      return '';
    }
    if (Object.prototype.hasOwnProperty.call(ESCAPES, char)) {
      return ESCAPES[char];
    }
    if (char === 'x') {
      const hex = this.text.slice(this.pos, this.pos + 2);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        this.fail('\\x 后需要两位十六进制数');
      }
      this.pos += 2;
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    if (char === 'u') {
      const hex = this.text.slice(this.pos, this.pos + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        this.fail('\\u 后需要四位十六进制数');
      }
      this.pos += 4;
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    return char;
  }

  parseKey() {
    this.skipTrivia();
    const char = this.peek();
    if (char === '"' || char === "'") {
      return this.parseString();
    }
    const rest = this.text.slice(this.pos);
    const match = IDENT_RE.exec(rest);
    if (match === null) {
      this.fail('对象键必须是字符串或无引号标识符');
    }
    this.pos += match[0].length;
    return match[0];
  }

  setKey(target, key, value) {
    // 用 defineProperty 赋值，避免 '__proto__' 之类键污染原型
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
  }

  parseObject() {
    const start = this.pos;
    this.pos++; // '{'
    const result = {};
    while (true) {
      this.skipTrivia();
      if (this.eof()) {
        this.fail('对象未闭合', start);
      }
      if (this.peek() === '}') {
        this.pos++;
        return result;
      }
      const key = this.parseKey();
      this.skipTrivia();
      if (this.peek() !== ':') {
        this.fail(`对象键 ${JSON.stringify(key)} 后缺少冒号`);
      }
      this.pos++;
      const value = this.parseValue();
      this.setKey(result, key, value);
      this.skipTrivia();
      if (this.eof()) {
        this.fail('对象未闭合', start);
      }
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      if (this.peek() === '}') {
        this.pos++;
        return result;
      }
      this.fail(`对象成员之间缺少逗号（遇到 ${JSON.stringify(this.peek())}）`);
    }
  }

  parseArray() {
    const start = this.pos;
    this.pos++; // '['
    const result = [];
    while (true) {
      this.skipTrivia();
      if (this.eof()) {
        this.fail('数组未闭合', start);
      }
      if (this.peek() === ']') {
        this.pos++;
        return result;
      }
      result.push(this.parseValue());
      this.skipTrivia();
      if (this.eof()) {
        this.fail('数组未闭合', start);
      }
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      if (this.peek() === ']') {
        this.pos++;
        return result;
      }
      this.fail(`数组元素之间缺少逗号（遇到 ${JSON.stringify(this.peek())}）`);
    }
  }

  parseDocument() {
    const value = this.parseValue();
    this.skipTrivia();
    if (!this.eof()) {
      this.fail(`解析完成后仍有冗余内容 ${JSON.stringify(this.text.slice(this.pos, this.pos + 12))}`);
    }
    return value;
  }
}

/**
 * 解析 JSON5 文本。
 * @param {string} text 文件内容
 * @returns {unknown} 解析结果（对象/数组/标量）
 * @throws {SyntaxError} 错误信息含 1 起行号
 */
export function parseJson5(text) {
  if (typeof text !== 'string') {
    throw new SyntaxError('JSON5 解析失败：入参必须是字符串');
  }
  return new Json5Parser(text).parseDocument();
}

export default parseJson5;
