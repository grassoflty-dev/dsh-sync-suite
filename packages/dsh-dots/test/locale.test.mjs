import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

test('meta.detail 必须是真实存在的包内 Markdown 文档路径（不是说明文本）', () => {
  // DSH 插件详情页把 meta.detail 当文件路径读取：写成多行说明文本会显示加载失败，
  // 而不是回退到 README（见 dsh-doc references/plugin-details.md）。
  for (const [lang, dict] of [['en', en], ['zh', zh]]) {
    const detail = dict['meta.detail']
    assert.match(detail, /^docs\/[A-Za-z0-9._-]+\.md$/, `${lang}.meta.detail 必须是 docs/*.md 路径，实际：${detail}`)
    assert.ok(!/[\r\n]/.test(detail), `${lang}.meta.detail 不能含换行`)
    assert.ok(existsSync(path.join(pkgDir, detail)), `${lang}.meta.detail 指向的文件必须存在：${detail}`)
  }
  assert.equal(en['meta.detail'], 'docs/DETAIL.md')
  assert.equal(zh['meta.detail'], 'docs/DETAIL.zh.md')
})

test('meta.description 是单行短文案（详情页展示用）', () => {
  for (const [lang, dict] of [['en', en], ['zh', zh]]) {
    const description = dict['meta.description']
    assert.ok(!/[\r\n]/.test(description), `${lang}.meta.description 不能含换行`)
    assert.ok(description.length <= 200, `${lang}.meta.description 不得超过 200 字符，实际 ${description.length}`)
    assert.ok(!/^(TODO|待补充|template)/i.test(description), `${lang}.meta.description 不能是模板文案`)
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

test('shipped 面板的文案 key 双份都在；dormant 旧面板文案已删除', () => {
  // retarget（mod-plugin-dormant-panel-removal）：原断言钉的是 dormant SettingsPanel 的
  // status.reachable / status.unreachable / status.unprobed / apply.fileSha / apply.blockSha，
  // 它们随旧面板一起删除。这里改钉 shipped DotsPanel 真正解析的文案 key（更强：逐条存在且非空）。
  const shippedKeys = [
    'meta.title', 'meta.description', 'meta.detail', 'panel.title', 'group.sync', 'group.remote',
    'error.badResponse', 'error.unknown',
    'lean.repo.url', 'lean.repo.token', 'lean.actions.save',
    'lean.remote.qr.show', 'lean.remote.copy', 'lean.remote.generate', 'lean.remote.selfcheck',
    'lean.status.failed', 'lean.status.synced', 'lean.status.never'
  ]
  for (const [lang, dict] of [['en', en], ['zh', zh]]) {
    for (const key of shippedKeys) {
      assert.equal(typeof dict[key], 'string', `${lang} 缺少 shipped key ${key}`)
      assert.ok(dict[key].trim().length > 0, `${lang}.${key} 不能为空`)
    }
    for (const dead of ['status.unprobed', 'actions.test', 'actions.push', 'actions.preview', 'error.retry']) {
      assert.equal(Object.hasOwn(dict, dead), false, `${lang} 不得复活 dormant 文案 key ${dead}`)
    }
  }
  // 246 个 dormant-only key 已删除：324 -> 78。精确计数同时阻止整批复活与误删 shipped 文案。
  assert.equal(Object.keys(en).length, 78, `locale 应恰好 78 个 shipped key，实际 ${Object.keys(en).length}`)
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
