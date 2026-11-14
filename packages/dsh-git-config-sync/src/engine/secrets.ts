/**
 * 密钥脱敏与回填。
 *
 * 三条路径：
 *   1. JSON 树（providers.json / mcp.json 等结构化载荷）：按 key 递归替换为 `__SECRET__`；
 *   2. patch 文本（cordis.patch.yml）：按行处理 `key: value` / `key = value`，保留行内 `#` 注释，
 *      也覆盖 `!!js` 表达式与 `{ a: b }` 这种行内 flow map；
 *   3. 恢复：远端占位符用本地同 key 的值回填，本地没有则保留占位符并记入 needsLocal（fail-closed）。
 *
 * 本文件同时导出几个 YAML 行级小工具（splitYamlComment / unquoteYamlScalar / scanMappingLine 等），
 * 供 patch.ts / collect.ts 复用；依赖方向只有 patch → secrets，不存在循环依赖。
 */

export const SECRET_PLACEHOLDER = '__SECRET__'

/**
 * 兼容导出：历史上的子串匹配正则（`maxTokens` / `apiKeyEnv` 会被误伤）。
 * 脱敏与回填**一律**走 `isSecretKey`，本常量只为旧代码/外部消费者保留。
 */
export const SECRET_KEY_RE = /token|secret|password|apikey|api_key|authorization|bearer/i

/** 单个词即视为密钥的词（必须精确相等；`tokens`、`tokenizer` 不算）。 */
const SECRET_WORDS: ReadonlySet<string> = new Set(['token', 'secret', 'password', 'authorization', 'bearer'])

/**
 * 把配置 key 切成小写词：先按 `_` / `-` / `.` / 其它非字母数字分隔，再按 camelCase 边界切
 * （`maxTokens` → `max` + `tokens`；`APIKey` → `api` + `key`；`api2Key` → `api2` + `key`）。
 */
export function splitKeyWords(key: string): string[] {
  if (typeof key !== 'string' || key === '') return []
  const words: string[] = []
  for (const part of key.split(/[^A-Za-z0-9]+/)) {
    if (part === '') continue
    const segments = part
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(' ')
    for (const segment of segments) {
      if (segment !== '') words.push(segment.toLowerCase())
    }
  }
  return words
}

/**
 * key 是否为密钥字段（词边界匹配，不是子串匹配）。
 *
 * 规则（BRIEF §2.3 / 审计 B2）：
 *   a) 任一词精确等于 `token`/`secret`/`password`/`authorization`/`bearer` → 是；
 *      `tokens`、`maxTokens`、`tokenizer` 等不算。
 *   b) 相邻词 `api`+`key`（`apiKey` / `api_key`）→ 是；但尾部另有 `env` 词
 *      （`apiKeyEnv` / `api_key_env`）→ 不算；单独一个词 `apikey` → 是。
 */
export function isSecretKey(key: string): boolean {
  const words = splitKeyWords(key)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    if (SECRET_WORDS.has(word)) return true
    if (word === 'apikey') return true
    if (word === 'api' && words[index + 1] === 'key') {
      // `apiKeyEnv` / `api_key_env` 只是"密钥所在的环境变量名"，本身不是密钥。
      if (words.slice(index + 2).includes('env')) continue
      return true
    }
  }
  return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isEmptySecret(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/** 值是否已经是占位符（含 `'__SECRET__'` / `"__SECRET__"` 两种引号形态）。 */
export function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === SECRET_PLACEHOLDER || unquoteYamlScalar(trimmed) === SECRET_PLACEHOLDER
}

/* -------------------------------------------------------------------------- */
/* YAML 行级工具（patch.ts 与 collect.ts 共用）                                  */
/* -------------------------------------------------------------------------- */

/**
 * 拆出 YAML 行内注释。注释判定与 YAML 一致：`#` 位于行首或前面是空白，
 * 且不在单/双引号内。返回的 code + comment 拼回等于原行。
 */
export function splitYamlComment(line: string): { code: string; comment: string } {
  let quote: string | null = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quote !== null) {
      if (quote === '"' && ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#') {
      const prev = i === 0 ? ' ' : line[i - 1]!
      if (prev === ' ' || prev === '\t') return { code: line.slice(0, i), comment: line.slice(i) }
    }
  }
  return { code: line, comment: '' }
}

/** 去掉 YAML 标量外层的引号（`''` → `'`，双引号处理常见转义）。 */
export function unquoteYamlScalar(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length >= 2) {
    const quote = trimmed[0]
    if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
      const inner = trimmed.slice(1, -1)
      if (quote === "'") return inner.replace(/''/g, "'")
      return inner.replace(/\\(["\\/nrt])/g, (_match, ch: string) => {
        if (ch === 'n') return '\n'
        if (ch === 'r') return '\r'
        if (ch === 't') return '\t'
        return ch
      })
    }
  }
  return trimmed
}

/** 按 sample 的引号风格重新包一个值；sample 没有引号时原样返回。 */
export function requoteLike(sample: string, value: string): string {
  const trimmedSample = sample.trim()
  const inner = unquoteYamlScalar(value)
  if (trimmedSample.startsWith('"')) {
    return `"${inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  if (trimmedSample.startsWith("'")) return `'${inner.replace(/'/g, "''")}'`
  return value.trim()
}

export interface MappingScan {
  key: string
  /** 从行首到 `key:` 之后空白的原文（含缩进、`- `、引号）。 */
  prefix: string
  /** 分隔符之后的原始值（可能为空串，可能带行尾空白）。 */
  value: string
}

/** 识别 `key: value` / `key = value`（分隔符后必须空白或行尾），忽略引号内的分隔符。 */
export function scanMappingLine(code: string): MappingScan | null {
  let quote: string | null = null
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]!
    if (quote !== null) {
      if (quote === '"' && ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ':' || ch === '=') {
      const next = code[i + 1]
      if (next !== undefined && next !== ' ' && next !== '\t') continue
      const keyRaw = code.slice(0, i).replace(/^\s*-\s+/, '').trim()
      if (keyRaw === '') return null
      let j = i + 1
      while (j < code.length && (code[j] === ' ' || code[j] === '\t')) j += 1
      return { key: unquoteYamlScalar(keyRaw), prefix: code.slice(0, j), value: code.slice(j) }
    }
  }
  return null
}

/** 按顶层逗号切分 flow 集合内容（`[a, b]` / `{a: 1, b: 2}`）。 */
export function splitFlowItems(inner: string): string[] {
  const items: string[] = []
  let quote: string | null = null
  let depth = 0
  let current = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!
    if (quote !== null) {
      current += ch
      if (quote === '"' && ch === '\\') {
        const next = inner[i + 1]
        if (next !== undefined) {
          current += next
          i += 1
        }
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) {
      items.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '' || items.length > 0) items.push(current)
  return items
}

/* -------------------------------------------------------------------------- */
/* JSON 树脱敏 / 回填                                                          */
/* -------------------------------------------------------------------------- */

export function stripSecretsDeep(value: unknown): { value: unknown; paths: string[] } {
  const paths: string[] = []
  const walk = (node: unknown, at: string): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${at}[${index}]`))
    if (!isPlainObject(node)) return node
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(node)) {
      const childPath = at === '' ? key : `${at}.${key}`
      if (isSecretKey(key)) {
        if (child === SECRET_PLACEHOLDER || isEmptySecret(child)) {
          out[key] = child
          continue
        }
        out[key] = SECRET_PLACEHOLDER
        paths.push(childPath)
        continue
      }
      out[key] = walk(child, childPath)
    }
    return out
  }
  return { value: walk(value, ''), paths }
}

export function restoreSecretsDeep(remote: unknown, local: unknown): { value: unknown; needsLocal: string[] } {
  const needsLocal: string[] = []
  const walk = (remoteNode: unknown, localNode: unknown, at: string): unknown => {
    if (remoteNode === SECRET_PLACEHOLDER) {
      if (!isEmptySecret(localNode) && localNode !== SECRET_PLACEHOLDER) return localNode
      needsLocal.push(at === '' ? '<root>' : at)
      return SECRET_PLACEHOLDER
    }
    if (Array.isArray(remoteNode)) {
      const localArray = Array.isArray(localNode) ? localNode : []
      return remoteNode.map((item, index) => walk(item, localArray[index], `${at}[${index}]`))
    }
    if (isPlainObject(remoteNode)) {
      const localObject = isPlainObject(localNode) ? localNode : {}
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(remoteNode)) {
        const childPath = at === '' ? key : `${at}.${key}`
        out[key] = walk(child, localObject[key], childPath)
      }
      return out
    }
    return remoteNode
  }
  return { value: walk(remote, local, ''), needsLocal }
}

/* -------------------------------------------------------------------------- */
/* patch 文本脱敏                                                              */
/* -------------------------------------------------------------------------- */

/** 行内 flow 集合里的 secret 值（如 `config: { apiKey: 'x' }`）。 */
function stripInlineFlow(code: string, counter: { stripped: number }): string {
  const openIndex = code.indexOf('{')
  if (openIndex < 0) return code
  const closeIndex = code.lastIndexOf('}')
  if (closeIndex <= openIndex) return code
  const inner = code.slice(openIndex + 1, closeIndex)
  const items = splitFlowItems(inner).map((item) => {
    const scan = scanMappingLine(item)
    if (scan === null || !isSecretKey(scan.key)) return item
    if (scan.value.trim() === '' || isPlaceholderValue(scan.value)) return item
    counter.stripped += 1
    return `${scan.prefix}${requoteLike(scan.value, SECRET_PLACEHOLDER)}`
  })
  return `${code.slice(0, openIndex + 1)}${items.join(',')}${code.slice(closeIndex)}`
}

/** 值替换为占位符时保留"值后面那段空白"，否则行内注释会贴到占位符上。 */
function maskValue(scan: MappingScan): string {
  const trailing = scan.value.slice(scan.value.trimEnd().length)
  return `${scan.prefix}${requoteLike(scan.value, SECRET_PLACEHOLDER)}${trailing}`
}

/** 把一行（不含注释部分）里的 secret 值替换为占位符。 */
function maskCode(code: string, counter: { stripped: number }): string {
  const scan = scanMappingLine(code)
  if (scan === null) return code
  const trimmedValue = scan.value.trim()
  if (isSecretKey(scan.key) && trimmedValue !== '' && !isPlaceholderValue(trimmedValue)) {
    counter.stripped += 1
    let masked = maskValue(scan)
    if (masked.includes('{')) masked = stripInlineFlow(masked, counter)
    return masked
  }
  if (trimmedValue.includes('{')) return `${scan.prefix}${stripInlineFlow(scan.value, counter)}`
  return code
}

/** 无 key 的行（secret 块的续行、块标量内容）：保留缩进与 `- `，内容整体替换。 */
function maskBareCode(code: string): string {
  const leadMatch = /^\s*(?:-\s+)?/.exec(code)
  const lead = leadMatch === null ? '' : leadMatch[0]
  return `${lead}${SECRET_PLACEHOLDER}`
}

/**
 * 逐个 YAML 行脱敏。`secretKey:` 后面若值为空，则把更深的续行整块脱敏
 * （覆盖 `tokens:` + 多行序列这类结构）。
 */
export function stripPatchSecrets(text: string): { text: string; stripped: number } {
  if (typeof text !== 'string' || text === '') return { text: text ?? '', stripped: 0 }
  const lines = text.split('\n')
  const counter = { stripped: 0 }
  const out: string[] = []
  let secretBlockIndent = -1

  for (const line of lines) {
    const { code, comment } = splitYamlComment(line)
    const trimmedCode = code.trim()
    const indent = code.length - code.trimStart().length

    if (secretBlockIndent >= 0) {
      if (trimmedCode === '') {
        out.push(line)
        continue
      }
      if (indent > secretBlockIndent) {
        const masked = maskBareCode(code)
        if (masked !== code) counter.stripped += 1
        out.push(`${masked}${comment}`)
        continue
      }
      secretBlockIndent = -1
    }

    const scan = trimmedCode === '' ? null : scanMappingLine(code)
    if (scan !== null && isSecretKey(scan.key)) {
      const value = scan.value.trim()
      if (value === '') {
        // 形如 `tokens:` / `authorization:`：真正的值在更深缩进的后续行里。
        secretBlockIndent = indent
        out.push(line)
        continue
      }
      if (isPlaceholderValue(value)) {
        out.push(line)
        continue
      }
      counter.stripped += 1
      let masked = maskValue(scan)
      if (masked.includes('{')) masked = stripInlineFlow(masked, counter)
      out.push(`${masked}${comment}`)
      continue
    }

    if (trimmedCode !== '' && code.includes('{')) {
      out.push(`${maskCode(code, counter)}${comment}`)
      continue
    }
    out.push(line)
  }
  return { text: out.join('\n'), stripped: counter.stripped }
}

/* -------------------------------------------------------------------------- */
/* patch 文本回填                                                              */
/* -------------------------------------------------------------------------- */

export interface LocalSecret {
  key: string
  value: string
}

/** 收集本地 patch 里所有"key 命中 secret 且值非空"的原始值文本（兼容导出，按出现顺序）。 */
export function collectLocalSecrets(localText: string): LocalSecret[] {
  const secrets: LocalSecret[] = []
  if (typeof localText !== 'string' || localText === '') return secrets
  for (const line of localText.split('\n')) {
    const { code } = splitYamlComment(line)
    if (code.trim() === '') continue
    const scan = scanMappingLine(code)
    if (scan === null) continue
    if (!isSecretKey(scan.key)) continue
    const value = scan.value.trim()
    if (value === '' || isPlaceholderValue(value)) continue
    secrets.push({ key: scan.key, value })
  }
  return secrets
}

/* -------------------------------------------------------------------------- */
/* 回填：按 entry block + key 路径匹配（绝不按出现顺序）                         */
/* -------------------------------------------------------------------------- */

interface SecretContext {
  indent: number
  key: string
}

interface ScannedSecretLine {
  index: number
  /** 去掉行内注释后的原文。 */
  code: string
  comment: string
  indent: number
  /** 祖先 key 列表（不含本行自身 key）。 */
  ancestors: string[]
  /** 本行自身的 key；块内续行（无 key）为 null。 */
  key: string | null
  /** 分隔符之后的值原文。 */
  value: string
  /** 行内 flow map（`{ apiKey: x }`）里的条目。 */
  flow: Array<{ key: string; value: string }>
}

/**
 * 逐行扫描一个 patch 文本（整份或单个 entry block），维护"祖先 key 栈"。
 * 栈让回填可以按 `config.providers.model-a.apiKey` 这样的路径精确配对。
 */
function scanSecretLines(lines: string[]): ScannedSecretLine[] {
  const scanned: ScannedSecretLine[] = []
  const stack: SecretContext[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const { code, comment } = splitYamlComment(lines[index]!)
    if (code.trim() === '') continue
    const indent = code.length - code.trimStart().length
    const scan = scanMappingLine(code)
    if (scan === null) {
      scanned.push({
        index,
        code,
        comment,
        indent,
        ancestors: stack.map((item) => item.key),
        key: null,
        value: code.trim(),
        flow: [],
      })
      continue
    }
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop()
    const ancestors = stack.map((item) => item.key)
    const flow: Array<{ key: string; value: string }> = []
    if (scan.value.includes('{')) {
      const open = code.indexOf('{')
      const close = code.lastIndexOf('}')
      if (close > open) {
        for (const item of splitFlowItems(code.slice(open + 1, close))) {
          const itemScan = scanMappingLine(item)
          if (itemScan !== null) flow.push({ key: itemScan.key, value: itemScan.value })
        }
      }
    }
    scanned.push({ index, code, comment, indent, ancestors, key: scan.key, value: scan.value, flow })
    if (scan.value.trim() === '') {
      stack.push({ indent, key: scan.key })
      continue
    }
    // 列表项形态的 provider（`- id: model-a`）：把条目 id 也编进路径，避免
    // `- id: a` / `- id: b` 两个兄弟项的 apiKey 落到同一条路径上而错配。
    if (scan.key === 'id' && /^\s*-\s+/.test(code)) {
      stack.push({ indent, key: `id=${unquoteYamlScalar(scan.value.trim())}` })
    }
  }
  return scanned
}

interface LocalSecretSlot {
  key: string
  /** 祖先 key + 自身 key，用 `.` 连接。 */
  path: string
  value: string
}

function localSecretSlots(lines: string[] | null): LocalSecretSlot[] {
  if (lines === null) return []
  const slots: LocalSecretSlot[] = []
  for (const line of scanSecretLines(lines)) {
    if (line.key !== null) {
      const value = line.value.trim()
      if (isSecretKey(line.key) && value !== '' && !isPlaceholderValue(value)) {
        slots.push({ key: line.key, path: [...line.ancestors, line.key].join('.'), value })
      }
      for (const item of line.flow) {
        const itemValue = item.value.trim()
        if (!isSecretKey(item.key) || itemValue === '' || isPlaceholderValue(itemValue)) continue
        slots.push({ key: item.key, path: [...line.ancestors, line.key, item.key].join('.'), value: itemValue })
      }
    }
  }
  return slots
}

interface EntryBlock {
  key: string
  lines: string[]
}

/** 与 patch.ts 的 key 规则保持一致（config 用 `id`，insert 用 `insert:<内部第一个 id>`）。 */
function entryBlockKey(lines: string[]): string | null {
  const first = lines[0] ?? ''
  const code = splitYamlComment(first).code
  if (/^-\s+id\s*:/.test(code)) {
    const value = unquoteYamlScalar(code.replace(/^-\s+id\s*:\s*/, ''))
    return value === '' ? null : value
  }
  if (/^-\s+insert\s*:\s*$/.test(code)) {
    for (let index = 1; index < lines.length; index += 1) {
      const match = /^\s+-\s+id\s*:\s*(.*)$/.exec(splitYamlComment(lines[index]!).code)
      if (match === null) continue
      const value = unquoteYamlScalar(match[1]!)
      if (value !== '') return `insert:${value}`
    }
  }
  return null
}

/** 按顶层 `- ` 序列项切块；块外的行（文件头注释/空行）原样保留在 preamble。 */
export function splitEntryBlocks(text: string): { preamble: string[]; blocks: EntryBlock[] } {
  const preamble: string[] = []
  const blocks: EntryBlock[] = []
  let current: EntryBlock | null = null
  for (const line of (typeof text === 'string' ? text : '').split('\n')) {
    if (/^-([ \t]|$)/.test(line)) {
      current = { key: '', lines: [line] }
      blocks.push(current)
      continue
    }
    if (current === null) preamble.push(line)
    else current.lines.push(line)
  }
  blocks.forEach((block, index) => {
    block.key = entryBlockKey(block.lines) ?? `entry:${index + 1}`
  })
  return { preamble, blocks }
}

function replacePlaceholder(code: string, value: string): string | null {
  const quoted = /(["'])__SECRET__\1/.exec(code)
  if (quoted !== null) return code.replace(quoted[0], requoteLike(quoted[0], value))
  if (!code.includes(SECRET_PLACEHOLDER)) return null
  return code.replace(SECRET_PLACEHOLDER, value.trim())
}

/** 单个 entry block 内按 key 路径回填；本地无值 → 记 needsLocal 且保留占位符（fail-closed）。 */
function restorePatchBlock(
  remoteLines: string[],
  localLines: string[] | null,
): { lines: string[]; needsLocal: string[] } {
  const slots = localSecretSlots(localLines)
  const byPath = new Map<string, LocalSecretSlot[]>()
  const byKey = new Map<string, LocalSecretSlot[]>()
  for (const slot of slots) {
    const pathList = byPath.get(slot.path)
    if (pathList === undefined) byPath.set(slot.path, [slot])
    else pathList.push(slot)
    const keyList = byKey.get(slot.key)
    if (keyList === undefined) byKey.set(slot.key, [slot])
    else keyList.push(slot)
  }
  const consumed = new Set<LocalSecretSlot>()

  const take = (list: LocalSecretSlot[] | undefined): string | null => {
    if (list === undefined) return null
    for (const slot of list) {
      if (consumed.has(slot)) continue
      consumed.add(slot)
      return slot.value
    }
    return null
  }

  /**
   * 先按完整路径匹配（同一条 entry 内不会跨 provider 错配）；
   * 路径缺失时只在"同 key 且唯一未使用"时才回填，否则视为本地缺失。
   */
  const lookup = (path: string, key: string): string | null => {
    const exact = take(byPath.get(path))
    if (exact !== null) return exact
    const remaining = (byKey.get(key) ?? []).filter((slot) => !consumed.has(slot))
    if (remaining.length === 1) return take(byKey.get(key))
    return null
  }

  const replacements = new Map<number, string>()
  const needsLocal: string[] = []
  const markMissing = (key: string): void => {
    if (!needsLocal.includes(key)) needsLocal.push(key)
  }

  for (const line of scanSecretLines(remoteLines)) {
    if (!line.code.includes(SECRET_PLACEHOLDER)) continue
    if (line.key === null) {
      // secret 块的续行（`password:` 下多行值）：无法按 key 配对 → fail-closed。
      const enclosing = line.ancestors.length > 0 ? line.ancestors[line.ancestors.length - 1]! : '<unknown>'
      markMissing(enclosing)
      continue
    }
    const path = [...line.ancestors, line.key].join('.')
    if (line.flow.length > 0 && line.value.includes(SECRET_PLACEHOLDER)) {
      const open = line.code.indexOf('{')
      const close = line.code.lastIndexOf('}')
      let resolved = true
      const items = splitFlowItems(line.code.slice(open + 1, close)).map((item) => {
        const itemScan = scanMappingLine(item)
        if (itemScan === null || !itemScan.value.includes(SECRET_PLACEHOLDER)) return item
        const value = lookup(`${path}.${itemScan.key}`, itemScan.key)
        if (value === null) {
          resolved = false
          markMissing(itemScan.key)
          return item
        }
        return replacePlaceholder(item, value) ?? item
      })
      if (resolved) {
        replacements.set(line.index, `${line.code.slice(0, open + 1)}${items.join(',')}${line.code.slice(close)}`)
      }
      continue
    }
    if (!isPlaceholderValue(line.value)) {
      markMissing(line.key)
      continue
    }
    const value = lookup(path, line.key)
    if (value === null) {
      markMissing(line.key)
      continue
    }
    const replaced = replacePlaceholder(line.code, value)
    if (replaced !== null) replacements.set(line.index, replaced)
  }

  const out = remoteLines.map((line, index) => {
    const replacement = replacements.get(index)
    if (replacement === undefined) return line
    return `${replacement}${splitYamlComment(line).comment}`
  })
  return { lines: out, needsLocal }
}

/**
 * 用本地同 key 的值回填远端 patch 文本里的 `__SECRET__`。
 *
 * - 逐 entry 对齐（按 `id` / `insert:<id>`），同一 entry 内再按 key 路径匹配；
 * - **不按出现顺序**回填，因此两个 provider 各带不同 secret 时不会错配；
 * - 保留远端行内注释与缩进，引号风格按远端；
 * - 本地没有对应值 → 保留占位符并把 key 记入 needsLocal（调用方据此跳过该条目）。
 */
export function restorePatchSecrets(remoteText: string, localText: string): { text: string; needsLocal: string[] } {
  const remote = typeof remoteText === 'string' ? remoteText : ''
  if (!remote.includes(SECRET_PLACEHOLDER)) return { text: remote, needsLocal: [] }

  const remoteDoc = splitEntryBlocks(remote)
  const localDoc = splitEntryBlocks(typeof localText === 'string' ? localText : '')
  const localByKey = new Map<string, string[]>()
  for (const block of localDoc.blocks) {
    if (!localByKey.has(block.key)) localByKey.set(block.key, block.lines)
  }

  const needsLocal: string[] = []
  const out: string[] = [...remoteDoc.preamble]
  for (const block of remoteDoc.blocks) {
    const local = localByKey.get(block.key) ?? null
    const restored = restorePatchBlock(block.lines, local)
    for (const key of restored.needsLocal) {
      if (!needsLocal.includes(key)) needsLocal.push(key)
    }
    out.push(...restored.lines)
  }
  return { text: out.join('\n'), needsLocal }
}

/** 载荷里是否残留已知 token 明文（推送前的最后一道闸）。 */
export function containsSecretValue(text: string, secret: string | null | undefined): boolean {
  if (secret === null || secret === undefined) return false
  const needle = secret.trim()
  if (needle.length < 4) return false
  return typeof text === 'string' && text.includes(needle)
}
