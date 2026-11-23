// mod-remote-command-wire（RC-4 接线）：草稿状态 + 组件/接线形状守卫的 Node 单测。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型 `model/remoteCommandDraft.ts` 只 import 纯模型，编译产物可直接被 Node 加载。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const DRAFT_TS = resolve(HERE, '../../entry/src/main/ets/model/remoteCommandDraft.ts');
const COMPONENT_ETS = resolve(HERE, '../../entry/src/main/ets/components/RemoteCommandComposer.ets');
const REMOTE_ETS = resolve(HERE, '../../entry/src/main/ets/pages/RemoteControl.ets');
const ACTION_BUTTON_ETS = resolve(HERE, '../../entry/src/main/ets/components/ActionButton.ets');

const draftModel = await import('../.build/model/remoteCommandDraft.js');
const gate = await import('../.build/model/remoteCommandGate.js');
const buttonModel = await import('../.build/model/actionButton.js');

const {
  COMMAND_TOOL,
  REMOTE_CHANNEL_VERIFIED,
  remoteChannelVerified,
  emptyComposerState,
  changeText,
  changeTarget,
  setConfirmed,
  composerGateInput,
  composerDecision,
  composerReason,
  placeholderRefusalReason
} = draftModel;
const { COMMAND_TEXT_LIMIT, COMMAND_WORDING, decideCommandSend } = gate;

const componentSrc = readFileSync(COMPONENT_ETS, 'utf8');
const remoteSrc = readFileSync(REMOTE_ETS, 'utf8');
const draftSrc = readFileSync(DRAFT_TS, 'utf8');
const actionButtonSrc = readFileSync(ACTION_BUTTON_ETS, 'utf8');

const ID = 'inst-a1b2c3d4e5f60718';
const OTHER_ID = 'inst-0011223344556677';
const NAME = '书房电脑';
const TEXT = '把明天的日程同步一下';

const fresh = () => emptyComposerState(ID, NAME);
const withText = () => changeText(fresh(), TEXT);
const confirmed = () => setConfirmed(withText(), true);

describe('A. 默认态与闸门文案', () => {
  test('A1 空正文 → E_COMMAND_TEXT_EMPTY，原因逐字等于闸门 wording', () => {
    const state = fresh();
    assert.equal(state.instanceId, ID);
    assert.equal(state.instanceName, NAME);
    assert.equal(state.tool, 'session.prompt');
    assert.equal(state.text, '');
    assert.equal(state.confirmed, false);
    assert.equal(state.confirmedFingerprint, '');
    assert.equal(COMMAND_TOOL, 'session.prompt');

    const decision = composerDecision(state, true);
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'E_COMMAND_TEXT_EMPTY');
    assert.equal(decision.wording, COMMAND_WORDING.E_COMMAND_TEXT_EMPTY);
    assert.equal(composerReason(state, true), COMMAND_WORDING.E_COMMAND_TEXT_EMPTY);
  });

  test('A2 组件不写第二份文案：8 条 wording 在组件源码里逐字绝迹', () => {
    assert.equal(Object.keys(COMMAND_WORDING).length, 8);
    for (const [code, wording] of Object.entries(COMMAND_WORDING)) {
      assert.equal(componentSrc.includes(wording), false,
        `组件不得复制闸门文案 ${code}：${wording}`);
    }
  });

  test('A3 只读面板原因映射逐字来自 COMMAND_WORDING（D2，无手写「尚未接线」）', () => {
    assert.equal(
      placeholderRefusalReason({ hasTarget: false, commandGranted: true, remoteVerified: true }),
      COMMAND_WORDING.E_COMMAND_TARGET_MISSING);
    assert.equal(
      placeholderRefusalReason({ hasTarget: true, commandGranted: false, remoteVerified: true }),
      COMMAND_WORDING.E_COMMAND_NOT_GRANTED);
    assert.equal(
      placeholderRefusalReason({ hasTarget: true, commandGranted: true, remoteVerified: false }),
      COMMAND_WORDING.E_COMMAND_REMOTE_UNVERIFIED);
    assert.equal(
      placeholderRefusalReason({ hasTarget: true, commandGranted: true, remoteVerified: true }), '');
    assert.equal(draftSrc.includes('指令确认闸尚未接线'), false, '纯模型不得保留旧假文案');
  });
});

describe('B. 拒绝顺序（与冻结闸门逐字一致）', () => {
  test('B1 有正文但未授权 → E_COMMAND_NOT_GRANTED', () => {
    const decision = composerDecision(withText(), false);
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'E_COMMAND_NOT_GRANTED');
    assert.equal(composerReason(withText(), false), COMMAND_WORDING.E_COMMAND_NOT_GRANTED);
  });

  test('B2 已授权但未确认 → E_COMMAND_UNCONFIRMED', () => {
    assert.equal(composerDecision(withText(), true).code, 'E_COMMAND_UNCONFIRMED');
    assert.equal(composerReason(withText(), true), COMMAND_WORDING.E_COMMAND_UNCONFIRMED);
  });

  test('B3 已确认 → E_COMMAND_REMOTE_UNVERIFIED（闸门决定，不隐藏按钮）', () => {
    const state = confirmed();
    const decision = composerDecision(state, true);
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'E_COMMAND_REMOTE_UNVERIFIED');
    assert.equal(decision.wording, COMMAND_WORDING.E_COMMAND_REMOTE_UNVERIFIED);
    assert.match(decision.wording, /未发送任何内容/);
    assert.equal(decision.wording.includes('已发送'), false);
    assert.equal(composerReason(state, true), decision.wording);
  });

  test('B4 gate input 的通道位来自 remoteChannelVerified()（恒 false）', () => {
    const input = composerGateInput(confirmed(), true);
    assert.equal(input.remoteVerified, false);
    assert.equal(input.confirmed, true);
    assert.equal(input.commandGranted, true);
    assert.equal(input.draft.text, TEXT);
  });
});

describe('C. 确认与草稿绑定（防 TOCTOU）', () => {
  test('C1 确认后改正文 → confirmed=false，判定落到 E_COMMAND_UNCONFIRMED', () => {
    const after = changeText(confirmed(), '换一句');
    assert.equal(after.confirmed, false);
    assert.equal(after.confirmedFingerprint, '');
    assert.equal(composerDecision(after, true).code, 'E_COMMAND_UNCONFIRMED');
  });

  test('C2 确认后换目标 → confirmed=false，判定落到 E_COMMAND_UNCONFIRMED', () => {
    const after = changeTarget(confirmed(), OTHER_ID, '另一个电脑');
    assert.equal(after.confirmed, false);
    assert.equal(after.confirmedFingerprint, '');
    assert.equal(composerDecision(after, true).code, 'E_COMMAND_UNCONFIRMED');
  });

  test('C3 改动后重新勾选 → 回到 E_COMMAND_REMOTE_UNVERIFIED（指纹是重新抓的）', () => {
    const after = changeText(confirmed(), '换一句');
    const again = setConfirmed(after, true);
    assert.equal(again.confirmed, true);
    assert.notEqual(again.confirmedFingerprint, '');
    assert.notEqual(again.confirmedFingerprint, after.confirmedFingerprint);
    assert.equal(composerDecision(again, true).code, 'E_COMMAND_REMOTE_UNVERIFIED');
  });

  test('C4 取消勾选清空指纹', () => {
    const off = setConfirmed(confirmed(), false);
    assert.equal(off.confirmed, false);
    assert.equal(off.confirmedFingerprint, '');
  });
});

describe('D. 长度是本地硬上限', () => {
  test('D1 changeText 截断到 COMMAND_TEXT_LIMIT，不可能命中 E_COMMAND_TEXT_TOO_LONG', () => {
    const state = changeText(fresh(), 'x'.repeat(COMMAND_TEXT_LIMIT + 50));
    assert.equal(state.text.length, COMMAND_TEXT_LIMIT);
    const decision = composerDecision(state, true);
    assert.notEqual(decision.code, 'E_COMMAND_TEXT_TOO_LONG');
    assert.equal(decision.code, 'E_COMMAND_UNCONFIRMED');
  });

  test('D2 组件把上限接在 TextArea.maxLength 上，不硬编码 2000', () => {
    assert.match(componentSrc, /\.maxLength\(COMMAND_TEXT_LIMIT\)/);
    assert.equal(componentSrc.includes('2000'), false);
    assert.ok(draftSrc.includes('text.slice(0, COMMAND_TEXT_LIMIT)'));
  });
});

describe('E. 通道是唯一剩余的阻塞点', () => {
  test('E1 常量与取值函数都是 false', () => {
    assert.equal(REMOTE_CHANNEL_VERIFIED, false);
    assert.equal(remoteChannelVerified(), false);
  });

  test('E2 直接给闸门传 remoteVerified:true 就通过 → 没有别的隐藏阻塞', () => {
    const input = composerGateInput(confirmed(), true);
    const forced = {
      draft: input.draft,
      commandGranted: input.commandGranted,
      confirmed: input.confirmed,
      confirmedFingerprint: input.confirmedFingerprint,
      remoteVerified: true
    };
    const out = decideCommandSend(forced);
    assert.equal(out.ok, true);
    assert.equal(out.fingerprint, input.confirmedFingerprint);
  });
});

describe('F. 组件源码形状（诚实、无投递、令牌化）', () => {
  test('F1 没有在途 / 成功态、没有网络与凭据字样', () => {
    for (const bad of ['console.', 'Bearer', 'http', 'fetch(', 'Web(', '已发送', '发送中', 'LoadingProgress']) {
      assert.equal(componentSrc.includes(bad), false, `组件不得包含 ${bad}`);
    }
  });

  test('F2 发送动作永久禁用，原因既传给 disabledReason 也渲染为可见 Text', () => {
    assert.match(componentSrc, /label: '发送指令'/);
    assert.match(componentSrc, /actionEnabled: false/);
    assert.match(componentSrc, /disabledReason: this\.reason/);
    assert.match(componentSrc, /Text\(this\.reason\)/);
    assert.match(componentSrc, /composerReason\(this\.currentState\(\), this\.commandGranted\)/);
    assert.match(componentSrc, /COMMAND_TOOL/);
  });

  // D1 真机缺陷收口：发送按钮此前 enabled:"true" / clickable:"true" / opacity:0.4 —— 只是「看着禁用」。
  // 这里用三层证明它不是视觉骗局：(i) composer 显式传 hardDisabled:true；
  // (ii) ActionButton 据它挂 .enabled(false)、handleClick 早退、false 时 .onClick 仍在；
  // (iii) 模型 resolveButton(...,true) 直接 tappable=false（点击路径短路）；
  // 外加一个变异负对照：把 composer 的 flag 去掉，断言必然转红。
  test('F4 hardDisabled 让发送按钮真不可点：源码形状 + 模型短路 + 负对照', () => {
    assert.match(componentSrc, /hardDisabled:\s*true/, 'composer 必须显式打开 hardDisabled');
    assert.match(componentSrc, /Text\(this\.reason\)/, '原因仍须常驻可见 Text（不靠点击才知道）');

    assert.match(actionButtonSrc, /@Prop hardDisabled: boolean = false/, 'additive 属性默认 false');
    assert.match(actionButtonSrc, /\.enabled\(!this\.hardDisabled\)/,
      'hardDisabled=true 时渲染 ArkUI .enabled(false)；false 时 .enabled(true) 不吞 onClick');
    assert.match(actionButtonSrc, /if \(this\.hardDisabled === true\) \{\s*return;\s*\}/,
      'handleClick 必须早退（belt and braces）');
    assert.match(actionButtonSrc, /\.onClick\(\(\) => this\.handleClick\(\)\)/,
      '默认路径的 onClick 仍在（不改变其它调用点）');

    const blocked = buttonModel.resolveButton(false, false, '原因', true);
    assert.equal(blocked.tappable, false, '模型层点击路径必须短路');
    assert.equal(buttonModel.blockedTapText(blocked), '原因');
    const normal = buttonModel.resolveButton(true, false, '');
    assert.equal(normal.tappable, true, '默认（hardDisabled=false）行为不变');

    const mutated = componentSrc.replace(/hardDisabled:\s*true,?/, '');
    assert.equal(/hardDisabled:\s*true/.test(mutated), false, '负对照必须先真的去掉 flag');
    let mutatedFailed = false;
    try {
      assert.match(mutated, /hardDisabled:\s*true/);
    } catch {
      mutatedFailed = true;
    }
    assert.equal(mutatedFailed, true, '负对照：去掉 flag 后断言必须转红');
  });

  test('F3 只用设计令牌与 $r 颜色', () => {
    for (const token of ['DIVIDER', 'FONT', 'LINE_HEIGHT', 'RADIUS', 'SPACING', 'TOUCH_MIN']) {
      assert.match(componentSrc, new RegExp(`\\b${token}\\b`), `组件必须引用令牌 ${token}`);
    }
    assert.equal(/(?:#[0-9A-Fa-f]{3,8}|Color\.[A-Z]|rgba?\()/.test(componentSrc), false,
      '组件不得写裸色值');
  });
});

describe('G. RemoteControl.ets 接线形状', () => {
  test('G1 import + mount 唯一一次，且钉在真实可达的 PHASE_READY 主体内（含三个 prop）', () => {
    assert.match(remoteSrc,
      /import \{ RemoteCommandComposer \} from '\.\.\/components\/RemoteCommandComposer';/);
    assert.equal((remoteSrc.match(/RemoteCommandComposer\(\{/g) ?? []).length, 1,
      'composer 只能挂载一次');

    // 全文件只有一次挂载调用（import 语句不算调用点）。
    const allMounts = remoteSrc.match(/RemoteCommandComposer\s*\(/g) ?? [];
    assert.equal(allMounts.length, 1, '整页只允许一处 composer 挂载调用');

    // 区域切片：从 PHASE_READY 分支标记到同缩进的下一个分支标记（PHASE_EMPTY）。
    // 挂载移到 loading / empty / build 之外都会落在这个切片外而失败。
    const readyMarker = '} else if (this.phase === PHASE_READY) {';
    const readyAt = remoteSrc.indexOf(readyMarker);
    assert.ok(readyAt > 0, '必须存在 PHASE_READY 分支标记');
    const nextBranchAt = remoteSrc.indexOf('} else if (this.phase === PHASE_EMPTY) {',
      readyAt + readyMarker.length);
    assert.ok(nextBranchAt > readyAt, '必须存在同缩进的下一个分支标记');
    const readyBody = remoteSrc.slice(readyAt + readyMarker.length, nextBranchAt);
    const regionMounts = readyBody.match(/RemoteCommandComposer\s*\(/g) ?? [];
    assert.equal(regionMounts.length, 1, '唯一的挂载必须落在 PHASE_READY 分支主体内');

    // 可达性：挂载必须在 RefusedView() 之后，而不是 debug-only 的 rc3Gate 子分支里。
    const mountAt = remoteSrc.indexOf('RemoteCommandComposer({');
    const refusedAt = remoteSrc.indexOf('this.RefusedView()', readyAt);
    assert.ok(refusedAt > readyAt && mountAt > refusedAt,
      '挂载必须在 RefusedView() 之后（今天唯一可达的 PHASE_READY 路径），不能在 rc3Gate 子分支');

    // 三个 prop 必须全部出现在挂载调用文本里，不能只传子集。
    const mountEnd = remoteSrc.indexOf('})', mountAt);
    assert.ok(mountEnd > mountAt, '挂载调用必须闭合');
    const mountCall = remoteSrc.slice(mountAt, mountEnd + 2);
    for (const prop of ['instanceId:', 'instanceName:', 'commandGranted:']) {
      assert.ok(mountCall.includes(prop), `挂载必须传 ${prop}，不能只传子集`);
    }
    assert.match(remoteSrc, /instanceId: this\.targetInstanceId\(\)/);
    assert.match(remoteSrc, /instanceName: this\.targetDisplayName\(\)/);
    assert.match(remoteSrc, /commandGranted: this\.targetCommandGranted\(\)/);
  });

  test('G2 原有硬拒绝文案逐字保留且只出现一次', () => {
    const line = '安全连接尚未启用，未向电脑发送凭据。';
    assert.equal(remoteSrc.split(line).length - 1, 1, '原文案必须保持且计数不变');
  });

  test('G3 实例 id 派生只有一处，授权只读且 fail-closed', () => {
    assert.equal((remoteSrc.match(/instanceIdFromUrl\(this\.url\)/g) ?? []).length, 1,
      'URL→实例 id 派生不得重复');
    assert.match(remoteSrc, /canPrompt\(instanceGrantStore\.list\(\), id, Date\.now\(\)\)/);
    assert.match(remoteSrc, /instanceGrantStore\.lastProblem\(\) !== 'ok'/);
    assert.match(remoteSrc, /findInstance\(instanceStore\.list\(\), id\) === null/);
  });

  // G4 retarget（mod-pinned-view-removal）：旧对照组的前提「死文件 PinnedRemoteView.ets 在磁盘上且零 importer」
  // 已被本模块删除。删除事实：零 importer、从未进 entry 图、旧产物 abc 命中 0——不可能回归行为，也不省字节。
  // 新对照组保留同一套 importer 扫描：
  //   (a) 钉住死文件已不存在；
  //   (b) 正对照不变——composer 的唯一 importer 仍是入口图里的 RemoteControl.ets；
  //   (c) 负对照从「磁盘上但零 importer」改写为「删除后无任何悬空 import PinnedRemoteView」——
  //       仍真实遍历同一套扫描的零分支，且是删除后的真实完整性不变量（悬空 import 会断编译）。
  // 「编译 vs 仅存在于磁盘」的另一端由 G1（挂载钉在 live PHASE_READY 主体内）证明，未放宽。
  // 未做全局「每个 .ets 至少 1 importer」不变量：删除后 24 个（删除前 25 个）合法零 importer 源文件
  //（删除后共 153 个源文件；@Entry 页 / EntryAbility / scaffold 桩 / 纯 model 辅助，例见 .tmp/enumerate-zero-importers.mjs），
  // 需要一份本模块无法证明合理的白名单，故不引入。
  test('G4 对照组：死渲染器已删除、无悬空 import，composer 仍恰有一个入口图 importer', () => {
    const etsRoot = resolve(HERE, '../../entry/src/main/ets');
    const sources = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ets') || entry.name.endsWith('.ts')) {
          sources.push(full);
        }
      }
    };
    walk(etsRoot);
    const importsNamed = (file, name) => {
      const text = readFileSync(file, 'utf8');
      return new RegExp(`from\\s+['"][^'"]*${name}['"]`).test(text);
    };

    // (a) 删除事实：PinnedRemoteView.ets 必须已不在磁盘上，也不再被扫描枚举到。
    const pinnedView = resolve(etsRoot, 'components/PinnedRemoteView.ets');
    assert.equal(existsSync(pinnedView), false, 'PinnedRemoteView.ets 必须已删除');
    assert.equal(sources.includes(pinnedView), false, '扫描不得再枚举到 PinnedRemoteView.ets');

    // (c) 负对照（保留零 importer 扫描分支）：删除后不得留下任何 import PinnedRemoteView 的悬空引用。
    const pinnedImporters = sources.filter((file) => importsNamed(file, 'PinnedRemoteView'));
    assert.deepEqual(pinnedImporters, [], '删除后不得有任何文件仍 import PinnedRemoteView（悬空 import）');

    // (b) 正对照：同一套扫描必须找到本模块 composer 的唯一 importer = 远程控制页。
    const composer = resolve(etsRoot, 'components/RemoteCommandComposer.ets');
    const composerImporters = sources.filter((file) =>
      file !== composer && importsNamed(file, 'RemoteCommandComposer'));
    assert.deepEqual(composerImporters, [REMOTE_ETS], 'composer 的唯一 importer 必须是入口图里的 RemoteControl.ets');
  });
});
