/**
 * census 守卫的**纯判定模块**（评审 b11c P2-3）：不读文件、不碰环境、不 import 运行时对象。
 *
 * 为什么单独一个文件：白名单条数守卫原来的"度量对象"是**源码文本重扫**（只认单引号、单行、
 * 以「推送失败：」开头的字面量），于是双引号 / 模板字面量 / 别的前缀写成的第 11 条都能骗过它，
 * 守卫全绿却证明了另一个对象。现在判定只需要三个**取到的值**：
 *   · `documented`（注释里的 N）、`allowedLength`（运行时导入的数组长度）、`shipped`（短语条数）；
 * 判定本身做成纯函数，同一个函数既跑真实值（必须绿）也跑 hostile 值（必须红），
 * 因此 `.tmp/` 里的探针与仓库内的用例可以复用**同一份**判定，不必各抄一遍。
 *
 * `countWhitelistEntries()` 只服务 hostile 场景：把"篡改后真实数组会变成几条"算出来。
 * 它对**真实源码**必须等于运行时数组长度（调用方负责断言），否则 hostile 结论不可信。
 */

/**
 * 数白名单块里的**真实元素个数**。
 *
 * 规则：先按行去掉 `//` 注释，再从 `Object.freeze([` 之后按**顶层逗号**切分，
 * 引号（' " `）与反斜杠转义内不切。只认逗号分隔的数组字面量——这正是白名单的写法。
 *
 * @param {string} block `Object.freeze([ … ])` 的源码切片（含闭合）
 * @returns {number} 元素个数
 */
export function countWhitelistEntries(block) {
  const text = block
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  const openTag = 'Object.freeze(['
  const openAt = text.indexOf(openTag)
  const closeAt = text.lastIndexOf('])')
  if (openAt === -1 || closeAt <= openAt) throw new Error('白名单块必须是闭合的 Object.freeze([...])')
  const body = text.slice(openAt + openTag.length, closeAt)
  let count = 0
  let quote = ''
  let escaped = false
  let sawToken = false
  for (const char of body) {
    if (escaped) {
      escaped = false
      continue
    }
    if (quote !== '') {
      if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      sawToken = true
      continue
    }
    if (char === ',') {
      if (sawToken) count += 1
      sawToken = false
      continue
    }
    if (!/\s/.test(char)) sawToken = true
  }
  if (sawToken) count += 1
  return count
}

/**
 * census 裁决：注释 N、运行时数组长度、shipped 条数三方一致才算通过。
 *
 * @param {{documented: unknown, allowedLength: unknown, shipped: unknown}} input
 * @returns {{ok: boolean, problems: string[]}}
 */
export function pushCensusVerdict({ documented, allowedLength, shipped }) {
  const problems = []
  if (!Number.isInteger(allowedLength) || allowedLength <= 0) {
    problems.push(`ALLOWED_PUSH_REASONS.length 必须是正整数（实际 ${String(allowedLength)}）`)
    return { ok: false, problems }
  }
  if (!Number.isInteger(documented)) {
    problems.push(`注释里的条数必须被解析成整数（实际 ${String(documented)}）`)
  } else if (documented !== allowedLength) {
    problems.push(
      `注释里的「白名单共 N 条短语」(${String(documented)})`
      + ` ≠ ALLOWED_PUSH_REASONS.length (${String(allowedLength)})`,
    )
  }
  if (shipped !== allowedLength) {
    problems.push(`shipped 短语条数 (${String(shipped)}) ≠ ALLOWED_PUSH_REASONS.length (${String(allowedLength)})`)
  }
  return { ok: problems.length === 0, problems }
}
