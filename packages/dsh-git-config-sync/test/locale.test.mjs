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
