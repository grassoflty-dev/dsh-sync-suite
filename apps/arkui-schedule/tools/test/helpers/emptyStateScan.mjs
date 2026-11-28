// 空态旁路词法探针（WS-09 风格：范围 / 形状 / 绕法 / 边界先写清楚，改规则前先读完这一段）。
//
// 【为什么会有这个文件】37c81f9 采纳了空态 doctrine：`pages/Chats.ets` 已走 `EmptyState`，
// 但两个 chat 面板绕过了 `components/state/EmptyState.ets` 与 `emptyStateIssue()` 契约：
// `DotsPane` / `CloudChatPane` 直接硬编码 `Text('还没有 …')` + `ActionButton({label:'刷新'})`。
// 设备验证抓到 dots 面板在空态露出同步形状的「刷新」按钮，违反产品规则「不要有同步或者导出按钮」。
// 本探针让「同一文件里渲染空态标题 + 出现任何动作」在静态测试里变红；`@Builder` 只是同文件里的一段
// 代码，因此自动被覆盖，不需要为它写第二套规则。
//
// 【判据】先剥注释（行号不变），再认三种「渲染出来的空态标题」——标题必须从 `Text(<x>)` 渲染：
//   A. 'text-literal'：Text('还没有 …') / Text("暂无 …")，字面量以 EMPTY_TITLE_MARKERS 之一开头；
//   B. 'text-template'：Text(`还没有 ${...} …`)，模板静态前缀（第一个 `${` 之前）以某个 marker 开头；
//   C. 'text-const'：本文件 `const|let NAME[: string] = '<marker 字面量>'`，随后 `Text(NAME)` 引用它。
// 「动作」= 同一文件里任意一处 `Button(` / `ActionButton(` / `actionLabel:`。同一文件同时出现 ≥1 个
// 渲染标题与 ≥1 个动作即为一条违规，返回 `{file, line, shape, title}`；`line` 是标题所在行（1 起）。
// 没有动作时直接返回空数组——只有标题没有按钮的空态是合规的，不是本探针的目标。
//
// 【范围】entry/src/main/ets/pages/**/*.ets，即页面 + `pages/panes` 下的面板。
//
// 【刻意不在这里管】（不是放宽，是不同契约 / 不同状态）：
//   - `components/**` 是契约本身的实现（`EmptyState` 内部就有 `ActionButton`），不在扫描范围；
//   - no-match / 筛选族「没有匹配…」「没有符合筛选条件…」是另一种状态，不是空态：见 `docs/UI-DESIGN.md:428`
//     （「没有匹配… / 没有符合筛选条件…」）、`docs/CHAT-APP.md:79`（§3.3 无匹配，title 行）与
//     `pages/Chats.ets` 的 `NoMatch`（pages/Chats.ets:531）；本探针只做 marker **前缀**匹配，这些句子不会被误判为空态标题；
//   - 弱提示（例如「今天还没有日程」）不以 marker 开头，属于提示而非空态标题，不命中；
//   - 任何经 helper 函数间接渲染的标题（`Text(titleOf(...))` / `Text(this.title())`）追不到，
//     本探针故意不管，不要靠加正则去「覆盖」它。
//   - 自定义 CTA 组件（假设某个面板新增 `@Builder RefreshCta()`（本文件只是扫描器，不是它的定义处），
//     或任何拿 `Row` / `Text` 加 `.onClick(` 画成按钮状的控件）对规则 1 是隐形的：那种文件里没有
//     `Button(` / `ActionButton(` / `actionLabel:` token，动作判定那一步直接返回空数组，渲染了标题也报不出旁路。
//     这是已知的洞；要补它就得先定义「什么算 CTA」，而那会把普通可点行也算成按钮、凭空添一堆假阳性。
//     想放宽这条规则的人先读完这里。
//   - 规则 1 的 marker 集合刻意只有三个前缀（还没有 / 暂无 / 空列表）。新写的空态若用了别的措辞，
//     例如 `Text('当前没有云端会话')`，或者标题是资源 backed 的，例如 `Text($r('app.string.empty_cloud'))`，
//     两者对规则 1 都隐形：前者不以任何 marker 开头，后者连字符串字面量都取不到。这是已知的洞，
//     不要以为这里已经覆盖；放宽 marker 集合又会把普通提示和筛选族标题一并拖进来，所以刻意不补。
//
// 【诚实边界】这是词法探针，不是证明：它只能抓到「把空态标题 Text 与按钮写在同一个文件」这种写法，
// 既判断不了文案说的是不是真的，也覆盖不了 helper 的间接渲染。空态语义的唯一判据仍是
// `model/stateView.ts` 的 `emptyStateIssue()`：显式 `showAction: false` 时 `detail` 必须是事实句，
// 空白与已知占位符会被它拒绝；本探针与它是两道互补的闸门，不能互相替代。
//
// 【规则 2：EmptyState 动作形状（ED-08 / ED-09）】规则 1 只抓「裸标题 + 按钮」，抓不到
// 已经走 `EmptyState` 但按钮形状错的情况：`EmptyState({ title, detail })` 不写
// `showAction: false` 时，`components/state/EmptyState.ets` 的 `FALLBACK_ACTION_LABEL`
// 会让按钮静默回落到「刷新」——正是产品规则禁止的「让数据出现」的控制；直接写
// `actionLabel: '刷新'` 则更明显违规。判据（同一模块、同一探测器，红探针必须打它，
// 绝不写第二套检测器）：
//   1. 先剥注释，再用 `EmptyState\s*\(\s*\{` 定位每个调用点，括号配对取完整实参块
//      （`onAction` 回调里也有花括号，配对比正则截取可靠）；
//   2. 块内 `showAction: false` → 通过（按构造没有动作）；
//   3. 否则若出现 `actionLabel:` → 解析取值：
//      a. 字符串字面量，或本文件 `const|let NAME[: string] = '<字面量>';` 的 NAME 引用；
//      b. **deny 集**：解析出的文案含 刷新 / 同步 / 导出 / 重新加载 / 重试 → 违规；
//      c. **allow 集**：解析出的文案不含上述任何词即通过——真实出路文案包括
//         添加实例 / 去设置 / 去设置添加实例 / 生成汇总 / 全选 / 清空 / 返回 / 返回列表 等。
//         这里是「合法文案举例」，实现按 deny 集判定，不按逐字白名单判定；
//      d. **无法解析**（标识符不在本文件定义，或是扫描器读不出字面量的表达式）→ 违规，
//         文案固定为「无法解析的 actionLabel：要么写 showAction: false，要么给一个本文件可解析的文案」，
//         绝不允许「刷新」藏在变量后面蒙混过关；
//   4. 既没有 `showAction: false` 也没有 `actionLabel:` → 违规（静默回落到「刷新」）。
// 【规则 2 的诚实边界】真实树上这条规则没有 red-before 历史：修复前两个面板根本没有
// `EmptyState`（它们是裸 Text + ActionButton，归规则 1 管），所以它的红线证据只能来自
// ED-09 的红 / 绿 fixture 探针，不能谎称「修复前真实树会红」。ED-08 用独立计数证明探测器
// 逐字访问了 pages/** 下每一个 `EmptyState(` 调用点并断言真实树零违规，避免它变成空跑。
// 这仍是词法判定：模板字符串、跨文件常量、运行时拼装一律按「无法解析」判红，不猜语义。
import { lineNumberAt, matchBrace, stripComments } from './etsSource.mjs';

/** 空态标题的前缀标记（只做 startsWith，不做子串，避免误伤弱提示与筛选族）。 */
export const EMPTY_TITLE_MARKERS = ['还没有', '暂无', '空列表'];

/** 渲染标题：`Text('…')` / `Text("…")`。 */
const TITLE_LITERAL = /\bText\s*\(\s*(['"])([^'"\n`]*)\1\s*\)/g;
/** 渲染标题：`Text(`…`)`，模板静态前缀取到第一个 `${` 之前。 */
const TITLE_TEMPLATE = /\bText\s*\(\s*`([^`\n]*)`\s*\)/g;
/** 本文件里的 marker 常量：`const|let NAME[: string] = '<marker 字面量>';`。 */
const MARKER_CONST = /\b(?:const|let)\s+([A-Za-z_$]\w*)\s*(?::\s*string)?\s*=\s*(['"])([^'"\n`]*)\2\s*;/g;
/** 对该常量的渲染引用：`Text(NAME)`。 */
const TITLE_NAME = /\bText\s*\(\s*([A-Za-z_$]\w*)\s*\)/g;

/** 同一文件里任何一处动作 token 都算（空态里不该有按钮 / 按钮文案）。 */
const ACTION_TOKENS = [/\bButton\s*\(/, /\bActionButton\s*\(/, /\bactionLabel\s*:/];

/** 标题是否以某个 marker 开头（前缀匹配，不扫子串）。 */
function startsWithMarker(text) {
  return EMPTY_TITLE_MARKERS.some((marker) => text.startsWith(marker));
}

/**
 * 找出「渲染空态标题 + 同文件出现动作」的旁路。
 *
 * @param rawSource 原始 ArkTS 源码（函数内部自己剥注释）。
 * @param relPath 展示用的相对路径 / fixture id，原样写进每条结果的 `file`。
 * @returns {Array<{file: string, line: number, shape: string, title: string}>} 按行号排序。
 */
export function findEmptyStateBypass(rawSource, relPath = '(fixture)') {
  const code = stripComments(rawSource);
  // 没有动作就没有旁路：只有标题、没有可点东西的空态正是 doctrine 允许的另一支。
  if (!ACTION_TOKENS.some((pattern) => pattern.test(code))) {
    return [];
  }

  const hits = [];
  for (const matched of code.matchAll(TITLE_LITERAL)) {
    const title = matched[2];
    if (startsWithMarker(title)) {
      hits.push({ file: relPath, line: lineNumberAt(code, matched.index), shape: 'text-literal', title });
    }
  }
  for (const matched of code.matchAll(TITLE_TEMPLATE)) {
    const prefix = matched[1].split('${')[0];
    if (startsWithMarker(prefix)) {
      hits.push({ file: relPath, line: lineNumberAt(code, matched.index), shape: 'text-template', title: prefix });
    }
  }

  const markerConsts = new Map();
  for (const matched of code.matchAll(MARKER_CONST)) {
    if (startsWithMarker(matched[3])) {
      markerConsts.set(matched[1], matched[3]);
    }
  }
  if (markerConsts.size > 0) {
    for (const matched of code.matchAll(TITLE_NAME)) {
      const title = markerConsts.get(matched[1]);
      if (title !== undefined) {
        hits.push({ file: relPath, line: lineNumberAt(code, matched.index), shape: 'text-const', title });
      }
    }
  }

  hits.sort((left, right) => left.line - right.line || left.shape.localeCompare(right.shape));
  return hits;
}

// ── 规则 2：EmptyState 的按钮形状（动作文案）守卫 ────────────────────────────

/** deny 集：动作文案含其中任意一个即为同步形状，空态不允许。 */
export const SYNC_SHAPED_ACTIONS = ['刷新', '同步', '导出', '重新加载', '重试'];

/** allow 集举例：真实出路文案；实现按 deny 集 + 可解析性判定，不做逐字白名单。 */
export const ALLOWED_ACTION_EXAMPLES = ['添加实例', '去设置', '生成汇总', '全选', '清空', '返回'];

/** 无法解析的 actionLabel 的固定判词（ED-09 逐字钉住）。 */
export const UNRESOLVABLE_ACTION_MESSAGE = '无法解析的 actionLabel：要么写 showAction: false，要么给一个本文件可解析的文案';

/** 静默回落到 FALLBACK_ACTION_LABEL 的判词（ED-09 钉住其中的「刷新」）。 */
export const FALLBACK_ACTION_MESSAGE = 'EmptyState 既没有 showAction: false 也没有 actionLabel：按钮文案静默回落到 FALLBACK_ACTION_LABEL「刷新」，正是被禁止的「让数据出现」控制';

/** `EmptyState({ … })` 调用点；`{` 之后交给括号配对取完整实参块。 */
const EMPTY_STATE_CALL = /\bEmptyState\s*\(\s*\{/g;
/** 本文件内可解析的字符串常量：`const|let NAME[: string] = '<字面量>';`。 */
const STRING_CONST = /\b(?:const|let)\s+([A-Za-z_$]\w*)\s*(?::\s*[A-Za-z_$]\w*)?\s*=\s*(['"])([^'"\n`]*)\2\s*;/g;
/** actionLabel 的取值文本：截到逗号 / 换行 / 闭花括号 / 闭括号为止。 */
const ACTION_LABEL_VALUE = /\bactionLabel\s*:\s*([^,\n}\)]+)/;
/** 纯字符串字面量（单引号或双引号，成对）。 */
const STRING_LITERAL = /^(['"])([^'"\n`]*)\1$/;

/**
 * 逐个访问 `EmptyState({…})` 调用点，返回每个点的可枚举判定记录。
 *
 * @param rawSource 原始 ArkTS 源码（函数内部自己剥注释）。
 * @param relPath 展示用的相对路径 / fixture id，原样写进每条结果的 `file`。
 * @returns {Array<{file: string, line: number, shape: string, label: string, verdict: 'pass'|'violation', message: string}>}
 */
export function scanEmptyStateActions(rawSource, relPath = '(fixture)') {
  const code = stripComments(rawSource);
  const consts = new Map();
  for (const matched of code.matchAll(STRING_CONST)) {
    consts.set(matched[1], matched[3]);
  }

  const records = [];
  for (const matched of code.matchAll(EMPTY_STATE_CALL)) {
    const brace = code.indexOf('{', matched.index);
    const [start, end] = matchBrace(code, brace);
    const block = code.slice(start + 1, end - 1);
    const record = {
      file: relPath,
      line: lineNumberAt(code, matched.index),
      shape: '',
      label: '',
      verdict: 'pass',
      message: ''
    };

    // 显式 opt-out：按构造没有按钮，无需再看 actionLabel。
    if (/\bshowAction\s*:\s*false\b/.test(block)) {
      record.shape = 'showAction-false';
      record.label = 'showAction:false';
      records.push(record);
      continue;
    }

    const labelMatch = ACTION_LABEL_VALUE.exec(block);
    if (!labelMatch) {
      record.shape = 'no-action';
      record.label = '(无 actionLabel)';
      record.verdict = 'violation';
      record.message = FALLBACK_ACTION_MESSAGE;
      records.push(record);
      continue;
    }

    const raw = labelMatch[1].trim();
    const literal = STRING_LITERAL.exec(raw);
    const resolved = literal ? literal[2] : consts.get(raw);
    record.shape = literal ? 'action-literal' : (consts.has(raw) ? 'action-const' : 'unresolvable');
    record.label = resolved !== undefined ? resolved : raw;

    if (resolved === undefined) {
      record.verdict = 'violation';
      record.message = UNRESOLVABLE_ACTION_MESSAGE;
      records.push(record);
      continue;
    }
    if (resolved.length === 0) {
      // 空文案同样会回落到「刷新」，不能当作 opt-out。
      record.shape = 'no-action';
      record.label = '(空 actionLabel)';
      record.verdict = 'violation';
      record.message = FALLBACK_ACTION_MESSAGE;
      records.push(record);
      continue;
    }

    const syncHit = SYNC_SHAPED_ACTIONS.find((token) => resolved.includes(token));
    if (syncHit !== undefined) {
      record.verdict = 'violation';
      record.message = `actionLabel「${resolved}」含同步形状的动作词「${syncHit}」（刷新 / 同步 / 导出 / 重新加载 / 重试），空态不允许；要么 showAction: false，要么给真实出路文案`;
    }
    records.push(record);
  }
  return records;
}

/**
 * 规则 2 的违规集合（只返回红的调用点）；红 / 绿探针都直接打这个函数。
 */
export function findEmptyStateActionViolations(rawSource, relPath = '(fixture)') {
  return scanEmptyStateActions(rawSource, relPath).filter((record) => record.verdict === 'violation');
}
