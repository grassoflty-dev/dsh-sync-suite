// B3 · 路径 2「加手写 8→目标 6」的**消费者侧**（编辑页）源码级守卫。
//
// 生产者（Handwriting.finish）在识别成功且有内容时写一次性键 `handwriting.autosave='1'`；
// 消费者（RecordEditorView.onRefreshTick）回填后读这个键并**立即清空**，满足前置条件就调 save()，
// 省掉「保存日程」1 tap 与回首页 1 wait。任何失败模式都只给原因、停在可继续操作的状态，
// 绝不写半条坏记录（docs/FAILURE-MODES.md §6）。
//
// 只读源码、不 import `.build`、不依赖 ArkTS 编译器，`node --test` 毫秒级跑完。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const editorPath = join(here, '..', '..', 'entry', 'src', 'main', 'ets', 'components', 'RecordEditorView.ets');
const handwritingPath = join(here, '..', '..', 'entry', 'src', 'harmony', 'ets', 'pages', 'Handwriting.ets');

/** 去掉块注释与整行行注释：`//` 前必须是行首或冒号以外的字符（避开注释里的 `http://`）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const editorCode = stripComments(readFileSync(editorPath, 'utf8'));
const handwritingCode = stripComments(readFileSync(handwritingPath, 'utf8'));

/**
 * 取某个方法**定义**体（两空格缩进的方法名开头 → 下一个两空格收尾大括号）。
 *
 * 必须匹配定义而不是调用点，且允许 `private` / `async` 等修饰符；嵌套块缩进都 ≥4 空格，
 * 不会误判为方法结束。沿用 `handwritingToolbar.test.mjs:43-51` 的简化套路。
 */
function methodBody(name, code) {
  const match = new RegExp(`\\n  (?:private |static |async |protected )*${name}\\(`).exec(code);
  assert.ok(match !== null, `找不到 ${name} 的方法定义`);
  const start = match.index;
  const end = code.indexOf('\n  }\n', start);
  assert.ok(end > 0, `${name} 找不到两空格缩进的收尾大括号`);
  return code.slice(start, end + 5);
}

const RESULT_KEYS = ['handwriting.result', 'handwriting.ocrText', 'handwriting.attachments', 'handwriting.pageObjects'];

describe('B3 路径 2：手写完成回到编辑页自动保存', () => {
  test('onRefreshTick：先回填（applyPendingInkResult）再判定自动保存（maybeAutoSaveAfterInk）', () => {
    const body = methodBody('onRefreshTick', editorCode);
    const applyAt = body.indexOf('applyPendingInkResult()');
    const autoAt = body.indexOf('maybeAutoSaveAfterInk(');
    assert.ok(applyAt >= 0, 'onRefreshTick 必须先调 applyPendingInkResult() 回填内容');
    assert.ok(autoAt >= 0, 'onRefreshTick 必须调 maybeAutoSaveAfterInk(...) 做自动保存判定');
    assert.ok(applyAt < autoAt, '必须先回填再判定：applyPendingInkResult() 必须出现在 maybeAutoSaveAfterInk( 之前');
    assert.ok(
      /const applied: boolean = this\.applyPendingInkResult\(\);/.test(body),
      '回填结果必须存进显式 boolean 类型的 applied（ArkTS 严格类型，不许 any）'
    );
  });

  test('maybeAutoSaveAfterInk：一次性键读后立即清空（读位置 < 清位置，中间无早退）', () => {
    const body = methodBody('maybeAutoSaveAfterInk', editorCode);
    const getToken = "AppStorage.get<string>('handwriting.autosave')";
    const clearToken = "AppStorage.setOrCreate<string>('handwriting.autosave', '')";
    const getAt = body.indexOf(getToken);
    const clearAt = body.indexOf(clearToken);
    assert.ok(getAt >= 0, '必须读一次性键 handwriting.autosave 才能知道这次完成有没有内容');
    assert.ok(clearAt >= 0, '必须立即清空 handwriting.autosave（否则下次进编辑页会误触发自动保存）');
    assert.ok(getAt < clearAt, '必须先读后清：读的位置必须早于清空的位置');
    assert.equal(
      /return/.test(body.slice(getAt, clearAt)),
      false,
      '读和清之间不得有 return：任何判据都要在清空之后再判，绝不把标记留到下一次'
    );
  });

  test('maybeAutoSaveAfterInk：没信号 / 没回填 / 保存中三种情况直接早退且不 save', () => {
    const body = methodBody('maybeAutoSaveAfterInk', editorCode);
    assert.ok(
      body.includes("if (flag !== '1' || !applied)"),
      '必须有「没可保存信号 或 没回填内容 就早退」的合并判据（识别失败/空笔迹/点退出/空回来都不自动保存）'
    );
    assert.ok(
      /if \(this\.saving\) \{\s*return;\s*\}/.test(body),
      '正在保存中必须直接早退（save 自己虽有闸，这里再挡一层，避免重入）'
    );
    const early = body.slice(body.indexOf("if (flag !== '1' || !applied)"), body.indexOf('if (!this.ready'));
    assert.equal(/this\.save\(\)/.test(early), false, '没信号/没回填的早退分支不得自动保存（宁可多一步）');
  });

  test('maybeAutoSaveAfterInk：未就绪 / 标题为空 / 无内容三分支先 toast 再 return，且分支内不含 save', () => {
    const body = methodBody('maybeAutoSaveAfterInk', editorCode);
    const branches = [
      ['存储未就绪（ready/loaded 为假，originalTs 还没读到）', 'if (!this.ready || !this.loaded)'],
      ['标题为空（新记录必须先有标题）', 'if (this.title.trim().length === 0)'],
      ['没有可保存的内容', 'if (this.body.trim().length === 0 && this.attachments.length === 0 && this.pageObjectsJson.length === 0)']
    ];
    for (const [label, marker] of branches) {
      const at = body.indexOf(marker);
      assert.ok(at >= 0, `${label} 分支必须存在`);
      const nextIf = body.indexOf('if (', at + marker.length);
      const branch = body.slice(at, nextIf > 0 ? nextIf : body.indexOf('this.save();', at));
      assert.ok(branch.includes('promptAction.showToast('), `${label} 分支必须先 toast 说明原因（不是静默失败）`);
      assert.ok(/return;/.test(branch), `${label} 分支 toast 后必须 return，停在可继续操作的状态`);
      const toastAt = branch.indexOf('promptAction.showToast(');
      const returnAt = branch.indexOf('return;');
      assert.ok(toastAt >= 0 && returnAt >= 0 && toastAt < returnAt, `${label} 分支必须「先 toast 再 return」`);
      assert.equal(/this\.save\(\)/.test(branch), false, `${label} 分支不得写入半条记录（不调 save）`);
    }
  });

  test('maybeAutoSaveAfterInk：三处阻塞 toast 时长走 toastMsFor(false)，无 duration 数字字面量', () => {
    const body = methodBody('maybeAutoSaveAfterInk', editorCode);
    const toasts = body.split('promptAction.showToast(').slice(1);
    assert.equal(toasts.length, 3, '三处阻塞分支各一次 toast（未就绪 / 标题为空 / 无内容）');
    for (const toast of toasts) {
      assert.ok(
        toast.includes('duration: toastMsFor(false)'),
        'toast 时长必须走 toastMsFor(false)（copy.test.mjs 禁止 RecordEditorView 出现 duration: 数字）'
      );
    }
    assert.equal(/duration:\s*\d+/.test(body), false, '本方法不得出现 duration 数字字面量');
  });

  test('maybeAutoSaveAfterInk：只有全部前置校验通过才 this.save()，且它是方法最后一句', () => {
    const body = methodBody('maybeAutoSaveAfterInk', editorCode);
    const saveAt = body.indexOf('this.save();');
    assert.ok(saveAt >= 0, '全部条件满足时必须通过 this.save() 自动保存（省掉 1 tap + 1 wait）');
    assert.equal(body.split('this.save();').length - 1, 1, 'save 只能调用一次（不许重复落盘）');
    assert.ok(/this\.save\(\);\s*\}\s*$/.test(body), 'this.save() 必须是方法最后一句（前面所有 if 都是它的前置校验）');
    const ifPositions = [...body.matchAll(/\bif \(/g)].map((m) => m.index);
    assert.ok(ifPositions.length >= 5, `至少 5 道前置校验（无信号/没回填/保存中/未就绪/标题为空/无内容），实际 ${ifPositions.length}`);
    assert.ok(ifPositions.every((at) => at < saveAt), '所有前置校验都必须在 save 之前，不许先保存再补判');
  });

  test('applyPendingInkResult：返回 boolean 且四个一次性键「读后清空」语义不变', () => {
    const body = methodBody('applyPendingInkResult', editorCode);
    assert.ok(/private applyPendingInkResult\(\): boolean/.test(body), '方法签名必须显式返回 boolean（ArkTS 严格类型）');
    assert.ok(/let applied: boolean = false;/.test(body), '必须有显式 boolean 类型的 applied 累加器');
    for (const key of RESULT_KEYS) {
      const getAt = body.indexOf(`AppStorage.get<string>('${key}')`);
      const clearAt = body.indexOf(`AppStorage.setOrCreate<string>('${key}', '')`, getAt);
      assert.ok(getAt >= 0, `${key} 必须仍被读取（四个回填通道一个都不能少）`);
      assert.ok(clearAt > getAt, `${key} 非空时必须在读后立即清空（读后清空语义一个字都不许变）`);
      const branch = body.slice(getAt, clearAt + 80);
      assert.ok(branch.includes('applied = true;'), `${key} 回填分支必须置位 applied = true（真的取到内容才算）`);
    }
    const appliedSets = body.split('applied = true;').length - 1;
    assert.ok(appliedSets >= 4, `四个分支各自置位 applied（实际 ${appliedSets} 处）`);
    assert.ok(/return applied;\s*\}\s*$/.test(body), '方法末尾必须 return applied（不能只置位不返回）');
  });

  test('finish()：autosave=1 只在识别成功且有内容时写，且在四个结果键之后', () => {
    const body = methodBody('finish', handwritingCode);
    assert.ok(
      body.includes('const autoSaveReady: boolean = body.trim().length > 0 || objectsJson.length > 0;'),
      'finish 成功分支必须用 autoSaveReady 判定：空笔迹 / 识别不出字不写 1（宁可让用户手动补一句）'
    );
    const autoAt = body.indexOf("AppStorage.setOrCreate<string>('handwriting.autosave',");
    assert.ok(autoAt >= 0, 'finish 成功分支必须写一次性键 handwriting.autosave');
    let prev = -1;
    for (const key of RESULT_KEYS) {
      const at = body.indexOf(`AppStorage.setOrCreate<string>('${key}',`);
      assert.ok(at >= 0, `finish 成功分支必须先写结果键 ${key}`);
      assert.ok(at > prev, `${key} 的写入位置必须在上一个结果键之后（四路结果先全部写完）`);
      prev = at;
    }
    assert.ok(
      prev < autoAt,
      'handwriting.pageObjects（最后一个结果键）必须写在 handwriting.autosave 之前（先给内容，再给自动保存信号）'
    );
    const writes = handwritingCode.split("AppStorage.setOrCreate<string>('handwriting.autosave'").slice(1);
    assert.equal(writes.length, 2, '全文件恰好两处写 autosave：finish 成功分支 + exitWritingBoard（退出清空）');
    assert.equal(writes.filter((w) => w.includes("'1'")).length, 1, "autosave 写 '1' 只允许 finish 成功分支这一处");
  });

  test('finish()：成功仍先 discardDraft() 后 router.back()，最后一个 catch 不碰 autosave / 草稿', () => {
    const body = methodBody('finish', handwritingCode);
    const discardAt = body.indexOf('this.discardDraft();');
    const backAt = body.indexOf('router.back();');
    assert.ok(discardAt >= 0, 'finish 成功分支仍须 discardDraft()（只作废成功这一次的草稿）');
    assert.ok(backAt >= 0, 'finish 成功分支仍须 router.back() 回编辑页');
    assert.ok(discardAt < backAt, 'discardDraft() 必须在 router.back() 之前（返回后组件销毁就清不到了）');
    const lastCatch = body.slice(body.lastIndexOf('} catch (error) {'));
    assert.ok(lastCatch.length > 0, 'finish 必须有 catch 段（识别失败要能解释）');
    assert.equal(
      /handwriting\.autosave/.test(lastCatch),
      false,
      'finish 最后一个 catch（识别失败）里不得写 autosave 标记：失败不能让读者误以为成功'
    );
    assert.equal(/discardDraft/.test(lastCatch), false, 'finish 最后一个 catch（识别失败）里不得作废草稿：失败路径必须保留草稿');
  });

  test('exitWritingBoard()：点「退出」必须清空 autosave 且在 router.back() 之前', () => {
    const body = methodBody('exitWritingBoard', handwritingCode);
    const clearAt = body.indexOf("AppStorage.setOrCreate<string>('handwriting.autosave', '')");
    const backAt = body.indexOf('router.back();');
    assert.ok(clearAt >= 0, '退出路径必须清空 handwriting.autosave（退出 = 明确不保存，不能沿用上次完成的标记）');
    assert.ok(backAt >= 0, '退出路径必须返回上一页');
    assert.ok(clearAt < backAt, '清空必须在 router.back() 之前（一返回组件就销毁，之后再清就晚了）');
    assert.equal(body.includes("'1'"), false, '退出路径不得写 autosave=1（点了退出就绝不能自动保存）');
  });
});
