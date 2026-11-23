// mod-remote-command-wire（RC-4 接线）：草稿状态 + 组件/接线形状守卫的 Node 单测。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型 `model/remoteCommandDraft.ts` 只 import 纯模型，编译产物可直接被 Node 加载。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

const draftModel = await import('../.build/model/remoteCommandDraft.js');
const gate = await import('../.build/model/remoteCommandGate.js');

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
  composerReason
} = draftModel;
const { COMMAND_TEXT_LIMIT, COMMAND_WORDING, decideCommandSend } = gate;

const componentSrc = readFileSync(COMPONENT_ETS, 'utf8');
const remoteSrc = readFileSync(REMOTE_ETS, 'utf8');
const draftSrc = readFileSync(DRAFT_TS, 'utf8');

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

  test('G4 对照组：死代码 PinnedRemoteView 仍零 importer，证明扫描能区分「进了入口图」与「只在磁盘上」', () => {
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

    // 负对照：死代码组件在磁盘上存在，但没有任何 import。
    const pinnedView = resolve(etsRoot, 'components/PinnedRemoteView.ets');
    assert.ok(sources.includes(pinnedView), 'PinnedRemoteView.ets 应仍在磁盘上（负对照成立的前提）');
    const pinnedImporters = sources.filter((file) =>
      file !== pinnedView && importsNamed(file, 'PinnedRemoteView'));
    assert.deepEqual(pinnedImporters, [], 'PinnedRemoteView 必须仍零 importer（死代码）');

    // 正对照：同一套扫描必须找到本模块 composer 的唯一 importer = 远程控制页。
    const composer = resolve(etsRoot, 'components/RemoteCommandComposer.ets');
    const composerImporters = sources.filter((file) =>
      file !== composer && importsNamed(file, 'RemoteCommandComposer'));
    assert.deepEqual(composerImporters, [REMOTE_ETS], 'composer 的唯一 importer 必须是入口图里的 RemoteControl.ets');
  });
});
