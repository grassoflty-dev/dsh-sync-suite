import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')

function readLocale(lang) {
  return JSON.parse(readFileSync(path.join(pkgDir, 'locale', `${lang}.json`), 'utf8'))
}

const en = readLocale('en')
const zh = readLocale('zh')

/**
 * 从 src/client.js 里取出内置的 zh/en 字典字面量（浏览器半侧必须与 locale JSON 一致，
 * 否则 host 注册的 key 与客户端兜底文案会漂移）。用括号配平扫描而不是正则，避免被字符串里的
 * `{` / `}` 干扰。
 */
function readClientDicts() {
  const source = readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  const pick = (name) => {
    const start = source.indexOf(`const ${name} = {`)
    assert.ok(start >= 0, `src/client.js 里找不到 const ${name} = {`)
    const open = source.indexOf('{', start)
    let depth = 0
    let i = open
    let inString = false
    let quote = ''
    for (; i < source.length; i += 1) {
      const ch = source[i]
      if (inString) {
        if (ch === '\\') {
          i += 1
          continue
        }
        if (ch === quote) inString = false
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true
        quote = ch
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          i += 1
          break
        }
      }
    }
    const literal = source.slice(open, i)
    // 只解析本文件自己的字面量（无外部可执行内容），用 Function 读回对象。
    return new Function(`return (${literal})`)()
  }
  return { zh: pick('zh'), en: pick('en') }
}

test('en/zh locale key sets are identical', () => {
  const a = Object.keys(en).sort()
  const b = Object.keys(zh).sort()
  assert.deepEqual(a, b, 'en 与 zh 的 key 集合必须完全一致')
})

test('locale exposes meta.title/description/detail', () => {
  for (const [lang, dict] of [['en', en], ['zh', zh]]) {
    for (const key of ['meta.title', 'meta.description', 'meta.detail']) {
      assert.equal(typeof dict[key], 'string', `${lang} 缺少 ${key}`)
      assert.ok(dict[key].length > 0, `${lang}.${key} 不能为空`)
    }
  }
})

test('every UI string is non-empty', () => {
  for (const [lang, dict] of [['en', en], ['zh', zh]]) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${lang}.${key} 必须是字符串`)
      assert.ok(value.trim().length > 0, `${lang}.${key} 不能为空`)
    }
  }
})

test('reachable 三态与 apply 双 SHA 的文案 key 双份都在', () => {
  for (const [lang, dict] of [['en', en], ['zh', zh]]) {
    for (const key of ['status.reachable', 'status.unreachable', 'status.unprobed', 'apply.fileSha', 'apply.blockSha']) {
      assert.equal(typeof dict[key], 'string', `${lang} 缺少 ${key}`)
    }
    assert.match(dict['status.unprobed'], lang === 'zh' ? /未探测/ : /Not probed/)
    assert.match(dict['apply.fileSha'], lang === 'zh' ? /文件 SHA-256/ : /File SHA-256/)
  }
  assert.ok(Object.keys(en).length >= 151, `locale 至少 151 个 key（原 148 + 新增 3），实际 ${Object.keys(en).length}`)
})

test('src/client.js 内置字典与 locale JSON 完全一致（key 与文案）', () => {
  const client = readClientDicts()
  for (const lang of ['en', 'zh']) {
    const json = lang === 'en' ? en : zh
    assert.deepEqual(Object.keys(client[lang]).sort(), Object.keys(json).sort(), `client.js ${lang} 的 key 集合必须与 locale/${lang}.json 一致`)
    for (const key of Object.keys(json)) {
      assert.equal(client[lang][key], json[key], `client.js ${lang}.${key} 必须与 locale/${lang}.json 逐字一致`)
    }
  }
})
