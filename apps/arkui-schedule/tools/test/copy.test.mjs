// Wave 2-B：三态（loading/empty/error+retry）文案规范 —— `common/copy.ts` 的行为契约
// + `components/StateView.ets` 的接线守卫。
//
// 前置：先构建纯逻辑层（`node --test` 不负责编译）
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
//
// 关注点（每条都有明确失败含义）：
// - 幂等：页面重复包装一层文案不会出现「正在加载正在加载日程……」；
// - 容错：脏数据（空串/undefined）不抛、不产出「undefined」字样；
// - 只去行首错误码：正文里的 `E_GIT` 是用户要反馈给开发者的原始信息，不能吞；
// - 接线：StateView 真的被用到、toast 时长真的走 `toastMsFor()`。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TOAST_ERROR_MS,
  TOAST_MS,
  countText,
  emptyText,
  errorText,
  issueText,
  loadingText,
  retryText,
  stripErrorCode,
  toastMsFor
} from '../.build/common/copy.js';

const ETS = (relPath) => readFileSync(new URL(`../../entry/src/main/ets/${relPath}`, import.meta.url), 'utf8');
const COPY_SRC = ETS('common/copy.ts');
const STATE_VIEW = ETS('components/StateView.ets');
const EMPTY_STATE = ETS('components/EmptyState.ets');
const DETAIL_VIEW = ETS('components/RecordDetailView.ets');
const EDITOR_VIEW = ETS('components/RecordEditorView.ets');
const DETAIL_PAGE = ETS('pages/Detail.ets');
const EDIT_PAGE = ETS('pages/Edit.ets');

/** 去掉块注释与整行行注释：源码断言只对「代码」生效（注释里允许写「已删除」之类的说明）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const STATE_VIEW_CODE = stripComments(STATE_VIEW);
const DETAIL_VIEW_CODE = stripComments(DETAIL_VIEW);
const EDITOR_VIEW_CODE = stripComments(EDITOR_VIEW);

// ---------------------------------------------------------------- toast 时长

test('toast 时长：普通 3000ms、错误 5000ms，且 toastMsFor 只在这两个值之间切换', () => {
  assert.equal(TOAST_MS, 3000);
  assert.equal(TOAST_ERROR_MS, 5000);
  assert.equal(toastMsFor(true), 5000);
  assert.equal(toastMsFor(false), 3000);
  assert.ok(TOAST_ERROR_MS > TOAST_MS, '错误提示必须比普通提示停留更久（要读完原因 + 下一步）');
  // 幂等：同一个入参永远同一个结果
  assert.equal(toastMsFor(true), toastMsFor(true));
});

// ---------------------------------------------------------------- issueText

test('issueText：统一「原因。下一步：Y」格式', () => {
  assert.equal(issueText('网络不可达', '检查网络后重试'), '网络不可达。下一步：检查网络后重试');
  assert.equal(issueText('推送被拒绝', '先拉取再推送'), '推送被拒绝。下一步：先拉取再推送');
});

test('issueText：原因已带句末标点时不重复补「。」', () => {
  assert.equal(issueText('推送被拒绝。', '先拉取再推送'), '推送被拒绝。下一步：先拉取再推送');
  assert.equal(issueText('真的失败了吗？', '重新试一次'), '真的失败了吗？下一步：重新试一次');
  assert.equal(issueText('还在等…', '稍后再看'), '还在等…下一步：稍后再看');
  // 不允许出现「。。」
  assert.equal(issueText('已结束。', '无需操作').includes('。。'), false);
});

test('issueText：空原因只给下一步、空下一步只给原因、都空给空串', () => {
  assert.equal(issueText('', '去设置页检查令牌'), '下一步：去设置页检查令牌');
  assert.equal(issueText('网络不可达', ''), '网络不可达。');
  assert.equal(issueText('', ''), '');
  assert.equal(issueText('   ', '  '), '', '纯空白等同空串');
});

test('issueText 幂等：对自身输出再套同一个下一步不会重复拼接', () => {
  const once = issueText('网络不可达', '检查网络后重试');
  assert.equal(issueText(once, '检查网络后重试'), once);
  assert.equal(issueText(issueText(once, '检查网络后重试'), '检查网络后重试'), once);
});

// ---------------------------------------------------------------- errorText

test('errorText：剥掉行首裸错误码，并补默认下一步', () => {
  assert.equal(errorText('E_GIT: 推送被拒绝'), '推送被拒绝。下一步：重试，或到设置页检查配置');
  assert.equal(errorText('HTTP 500: 服务端异常'), '服务端异常。下一步：重试，或到设置页检查配置');
  assert.equal(errorText('网络不可达'), '网络不可达。下一步：重试，或到设置页检查配置');
});

test('errorText：空原因给可读兜底，绝不产出「undefined」', () => {
  const text = errorText('');
  assert.equal(text.includes('undefined'), false);
  assert.match(text, /下一步：/);
  assert.equal(errorText(undefined).includes('undefined'), false);
});

test('errorText 幂等：重复应用不会再叠一层「下一步」', () => {
  const once = errorText('读取记录失败');
  assert.equal(errorText(once), once);
});

// ---------------------------------------------------------------- emptyText

test('emptyText：暂无 + 主语；带 hint 时拼成一句可读说明', () => {
  assert.equal(emptyText('日程'), '暂无日程');
  assert.equal(emptyText('日程', '点右上角「新建」记录一条'), '暂无日程。点右上角「新建」记录一条');
  assert.equal(emptyText(''), '暂无内容', '没主语用「暂无内容」而不是「暂无」');
  assert.equal(emptyText('', ''), '暂无内容');
});

test('emptyText 幂等：重复包装不会出现「暂无暂无」或重复的 hint', () => {
  assert.equal(emptyText(emptyText('日程')), '暂无日程');
  const withHint = emptyText('日程', '点右上角「新建」记录一条');
  assert.equal(emptyText(withHint, '点右上角「新建」记录一条'), withHint);
  assert.equal(/暂无暂无/.test(emptyText(withHint)), false);
});

// ---------------------------------------------------------------- loadingText

test('loadingText：正在加载 + 宾语 + 省略号', () => {
  assert.equal(loadingText('日程'), '正在加载日程…');
  assert.equal(loadingText('存储'), '正在加载存储…');
  assert.equal(loadingText(''), '正在加载…');
});

test('loadingText 幂等：已是加载文案时原样返回（不叠「正在加载正在加载」）', () => {
  const once = loadingText('日程');
  assert.equal(loadingText(once), once);
  assert.equal(loadingText(loadingText(once)), once);
  assert.equal(/正在加载正在加载/.test(loadingText(once)), false);
  assert.equal(loadingText(undefined).includes('undefined'), false);
});

// ---------------------------------------------------------------- retryText

test('retryText：默认「重试」，带宾语时「重试+宾语」', () => {
  assert.equal(retryText(''), '重试');
  assert.equal(retryText('加载'), '重试加载');
  assert.equal(retryText('   '), '重试');
});

test('retryText 幂等：已以「重试」开头时原样返回', () => {
  const once = retryText('加载');
  assert.equal(retryText(once), once);
  assert.equal(retryText('重试'), '重试');
  assert.equal(/重试重试/.test(retryText(once)), false);
  assert.equal(retryText(undefined), '重试');
});

// ---------------------------------------------------------------- countText

test('countText：共 N 单位（负数/NaN/Infinity 一律按 0）', () => {
  assert.equal(countText(5, '条'), '共 5 条');
  assert.equal(countText(0, '条'), '共 0 条');
  assert.equal(countText(1, '页'), '共 1 页');
  assert.equal(countText(-3, '条'), '共 0 条', '负数计数没有意义，夹到 0');
  assert.equal(countText(Number.NaN, '条'), '共 0 条');
  assert.equal(countText(Number.POSITIVE_INFINITY, '条'), '共 0 条');
  assert.equal(countText(5, ''), '共 5', '没有单位就不要多一个空格');
  assert.equal(countText(undefined, undefined).includes('undefined'), false);
});

// ---------------------------------------------------------------- stripErrorCode

test('stripErrorCode：只剥行首的 E_XXX: / HTTP nnn: 前缀', () => {
  assert.equal(stripErrorCode('E_GIT: 推送被拒绝'), '推送被拒绝');
  assert.equal(stripErrorCode('E_AUTH:认证失败'), '认证失败');
  assert.equal(stripErrorCode('HTTP 500: 服务端异常'), '服务端异常');
  assert.equal(stripErrorCode('http 404：仓库不存在'), '仓库不存在', '小写 http 与全角冒号同样剥');
  assert.equal(stripErrorCode('E_GIT: E_AUTH: 认证失败'), '认证失败', '多层前缀一次剥完');
});

test('stripErrorCode：正文里的错误码不动，非行首码不动，幂等', () => {
  assert.equal(stripErrorCode('推送失败（E_GIT）'), '推送失败（E_GIT）', '正文里的码是要反馈给开发者的信息');
  assert.equal(stripErrorCode('同步 HTTP 500 失败'), '同步 HTTP 500 失败');
  assert.equal(stripErrorCode('E_GIT 推送失败'), 'E_GIT 推送失败', '没有冒号就不是前缀码');
  assert.equal(stripErrorCode(''), '');
  assert.equal(stripErrorCode(undefined), '');
  const once = stripErrorCode('E_GIT: E_AUTH: 认证失败');
  assert.equal(stripErrorCode(once), once);
});

// ---------------------------------------------------------------- 纯逻辑 / 不引 SDK

test('copy.ts 是纯逻辑：零 import、不碰 SDK、不读时间/随机', () => {
  assert.equal(/^\s*import\s/m.test(COPY_SRC), false, 'copy.ts 不得 import 任何模块（Node 要能直接跑）');
  for (const forbidden of ['@kit.', '@ohos.', '$r(', 'promptAction', 'Date.now', 'Math.random']) {
    assert.equal(COPY_SRC.includes(forbidden), false, `copy.ts 不应出现 ${forbidden}`);
  }
  // 要求的 API 全部导出
  for (const name of [
    'TOAST_MS',
    'TOAST_ERROR_MS',
    'toastMsFor',
    'issueText',
    'errorText',
    'emptyText',
    'loadingText',
    'retryText',
    'countText',
    'stripErrorCode'
  ]) {
    assert.match(COPY_SRC, new RegExp(`export (?:function|const) ${name}`), `缺少导出 ${name}`);
  }
});

// ---------------------------------------------------------------- StateView 契约

test('StateView：三态入参齐全（kind/title/detail/retryLabel/compact/onRetry）', () => {
  assert.match(STATE_VIEW, /export struct StateView/);
  assert.match(STATE_VIEW, /@Prop kind: string = 'empty'/);
  assert.match(STATE_VIEW, /@Prop title: string = ''/);
  assert.match(STATE_VIEW, /@Prop detail: string = ''/);
  assert.match(STATE_VIEW, /@Prop retryLabel: string = ''/);
  assert.match(STATE_VIEW, /@Prop compact: boolean = false/);
  assert.match(STATE_VIEW, /onRetry: \(\(\) => void\) \| null = null/);
  assert.match(STATE_VIEW_CODE, /this\.kind === 'loading'/, '必须单独处理 loading');
  assert.match(STATE_VIEW_CODE, /this\.kind === 'error'/, '必须单独处理 error');
});

test('StateView：loading 用 LoadingProgress、error 用 danger 色、按钮高 TOUCH_MIN', () => {
  assert.match(STATE_VIEW, /LoadingProgress\(\)/);
  assert.match(STATE_VIEW, /\$r\('app\.color\.danger'\)/, '错误标题必须是 danger 色');
  assert.match(STATE_VIEW, /\.height\(TOUCH_MIN\)/, '重试按钮高度取 TOUCH_MIN（40vp 触控目标）');
  assert.match(STATE_VIEW, /from '\.\.\/common\/uiTokens'/, '间距/字号/圆角必须来自令牌');
  assert.match(STATE_VIEW, /loadingText\(|retryText\(/, '文案必须走 common/copy');
  // 反例守卫：不允许在组件里写死颜色值或字号
  assert.equal(/#[0-9A-Fa-f]{6}/.test(STATE_VIEW_CODE), false, '颜色必须走 $r() 资源（深色模式）');
  assert.equal(/@crossplatform/.test(STATE_VIEW_CODE), false, 'ArkUI-X 编译器不认识 @crossplatform');
  for (const forbidden of ['PixelMap', '@kit.ImageKit', 'Handwriting', 'OcrManager']) {
    assert.equal(STATE_VIEW_CODE.includes(forbidden), false, `组件不得引用 ${forbidden}（Android 侧编译失败）`);
  }
});

test('StateView：内部 @Builder 复用（标题/说明/按钮/加载各一块，不重复写样式）', () => {
  const builders = STATE_VIEW.match(/@Builder\s*\n\s*[A-Z][A-Za-z]*\(/g) || [];
  assert.ok(builders.length >= 4, `至少拆出 4 个 @Builder 子块，实际 ${builders.length} 个`);
  assert.match(STATE_VIEW, /this\.TitleLine\(\)/);
  assert.match(STATE_VIEW, /this\.ActionButton\(\)/);
});

// ---------------------------------------------------------------- 接线

test('RecordDetailView：三态都走 StateView（空态/加载/错误+重试）', () => {
  assert.match(DETAIL_VIEW_CODE, /StateView\(/, '详情视图必须用 StateView 渲染三态');
  assert.match(DETAIL_VIEW_CODE, /kind: 'empty'/, '空态');
  assert.match(DETAIL_VIEW_CODE, /kind: 'loading'/, '加载态');
  assert.match(DETAIL_VIEW_CODE, /kind: 'error'/, '错误态');
  assert.match(DETAIL_VIEW_CODE, /retryLabel: '重试'/, '错误态必须给「重试」');
  assert.match(DETAIL_VIEW_CODE, /this\.retryLoad\(\)/, '重试必须有真实动作，不能是空回调');
  assert.match(DETAIL_VIEW_CODE, /loadingText\('日程'\)/, '加载文案走 copy.loadingText');
  assert.match(DETAIL_VIEW, /从左侧选一条日程查看/, '右栏空态文案不能丢');
  // 旧的裸文案分支必须消失
  assert.equal(/正在读取记录…/.test(DETAIL_VIEW_CODE), false, '旧的裸 loading 文案应已删除');
});

test('RecordEditorView：至少 loading 与错误两态走 StateView（行内紧凑）', () => {
  assert.match(EDITOR_VIEW_CODE, /StateView\(/);
  assert.match(EDITOR_VIEW_CODE, /kind: 'error'/);
  assert.match(EDITOR_VIEW_CODE, /kind: 'loading'/);
  assert.match(EDITOR_VIEW_CODE, /compact: true/, '表单里的状态是行内小块，必须 compact');
  assert.match(EDITOR_VIEW_CODE, /loadingText\('存储'\)/);
  assert.match(EDITOR_VIEW_CODE, /this\.retryLoad\(\)/);
  assert.equal(/正在准备存储…/.test(EDITOR_VIEW_CODE), false, '旧的裸 loading 文案应已删除');
});

test('toast 时长统一：可改文件里不再有 duration 字面量，全部走 toastMsFor()', () => {
  for (const [name, code] of [
    ['RecordDetailView', DETAIL_VIEW_CODE],
    ['RecordEditorView', EDITOR_VIEW_CODE]
  ]) {
    assert.equal(/duration:\s*\d+/.test(code), false, `${name} 不应再有 duration 字面量`);
  }
  assert.match(DETAIL_VIEW_CODE, /duration: toastMsFor\(true\)/, '错误 toast 用错误时长');
  assert.match(DETAIL_VIEW_CODE, /duration: toastMsFor\(false\)/, '普通 toast 用普通时长');
  assert.match(EDITOR_VIEW_CODE, /duration: toastMsFor\(true\)/);
  // 常量必须真的从 copy.ts 来（不是本地又定义一份）
  assert.match(DETAIL_VIEW_CODE, /import \{[^}]*toastMsFor[^}]*\} from '\.\.\/common\/copy'/, 'toastMsFor 必须来自 common/copy');
});

test('EmptyState 兼容层：保留旧导出，内部转调 StateView（将来可删）', () => {
  assert.match(EMPTY_STATE, /export struct EmptyState/);
  assert.match(EMPTY_STATE, /from '\.\/StateView'/, '必须复用 StateView，而不是留一份自己的样式');
  assert.match(EMPTY_STATE, /StateView\(\{ kind: 'empty'/, '内部转调 empty 形态');
  // 旧入参全部保留，避免既有调用方编译失败
  for (const prop of ['@Prop title: string', '@Prop hint: string', '@Prop icon: string']) {
    assert.ok(EMPTY_STATE.includes(prop), `兼容层必须保留 ${prop}`);
  }
});

test('Detail / Edit 仍是薄壳：状态由组件表达，页面不自己拼文案', () => {
  assert.match(DETAIL_PAGE, /RecordDetailView\(\{/);
  assert.match(EDIT_PAGE, /RecordEditorView\(\{/);
  // 页面层不该出现三态文案字面量（它们都在组件/StateView 里）
  for (const [name, code] of [
    ['Detail.ets', DETAIL_PAGE],
    ['Edit.ets', EDIT_PAGE]
  ]) {
    assert.equal(/正在加载|暂无内容|读取失败/.test(code), false, `${name} 不应自带三态文案`);
    assert.equal(/promptAction\.showToast/.test(code), false, `${name} 不应自己弹 toast（统一在组件里）`);
  }
});
