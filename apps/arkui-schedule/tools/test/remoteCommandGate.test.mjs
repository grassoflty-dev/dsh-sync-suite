// mod-remote-command-gate（RC-4）：指令单次确认闸的 Node 单测。
//
// 前置：node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
// 纯模型 `model/remoteCommandGate.ts` 只 import `./instanceGrant`，编译产物可直接被 Node 加载。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const MODEL_TS = resolve(HERE, '../../entry/src/main/ets/model/remoteCommandGate.ts');
const gate = await import('../.build/model/remoteCommandGate.js');

const { decideCommandSend, commandFingerprint, commandPreview, COMMAND_TEXT_LIMIT } = gate;
const src = readFileSync(MODEL_TS, 'utf8');

const draft = (over = {}) => ({
  instanceId: 'pc-1',
  instanceName: '书房电脑',
  tool: 'session.prompt',
  text: '把明天的日程同步一下',
  ...over,
});
const input = (over = {}) => ({
  draft: draft(),
  commandGranted: true,
  confirmed: true,
  confirmedFingerprint: commandFingerprint(draft()),
  remoteVerified: true,
  ...over,
});

describe('A. 判定顺序与 typed 拒绝', () => {
  test('A1 合法输入通过，指纹确定且预览含目标与工具', () => {
    const out = decideCommandSend(input());
    assert.equal(out.ok, true);
    assert.equal(out.fingerprint, commandFingerprint(draft()));
    assert.match(out.preview, /书房电脑/);
    assert.match(out.preview, /session\.prompt/);
  });

  test('A2 空目标 / 非法工具 / 空正文 / 超长正文 各自 typed', () => {
    assert.equal(decideCommandSend(input({ draft: draft({ instanceId: '' }) })).code, 'E_COMMAND_TARGET_MISSING');
    assert.equal(decideCommandSend(input({ draft: draft({ tool: 'session.read' }) })).code, 'E_COMMAND_TOOL_NOT_ALLOWED');
    assert.equal(decideCommandSend(input({ draft: draft({ text: '   ' }) })).code, 'E_COMMAND_TEXT_EMPTY');
    assert.equal(
      decideCommandSend(input({ draft: draft({ text: 'x'.repeat(COMMAND_TEXT_LIMIT + 1) }) })).code,
      'E_COMMAND_TEXT_TOO_LONG'
    );
  });

  test('A3 view 权不隐含 command 权', () => {
    assert.equal(decideCommandSend(input({ commandGranted: false })).code, 'E_COMMAND_NOT_GRANTED');
  });

  test('A4 未勾选确认不得发送', () => {
    assert.equal(decideCommandSend(input({ confirmed: false })).code, 'E_COMMAND_UNCONFIRMED');
  });
});

describe('B. 确认与草稿绑定（防 TOCTOU）', () => {
  test('B1 正文改动后旧确认失效', () => {
    const fp = commandFingerprint(draft());
    assert.equal(decideCommandSend(input({ draft: draft({ text: '换一句' }), confirmedFingerprint: fp })).code,
      'E_COMMAND_CONFIRM_STALE');
  });

  test('B2 目标改动同样失效', () => {
    const fp = commandFingerprint(draft());
    assert.equal(decideCommandSend(input({ draft: draft({ instanceId: 'pc-2' }), confirmedFingerprint: fp })).code,
      'E_COMMAND_CONFIRM_STALE');
  });

  test('B3 指纹对分隔符注入不碰撞', () => {
    const a = commandFingerprint(draft({ instanceId: 'a|b', text: 'c' }));
    const b = commandFingerprint(draft({ instanceId: 'a', text: 'b|c' }));
    assert.notEqual(a, b);
  });

  test('B4 预览只含实例名 / 工具 / 正文，不含凭据字样', () => {
    const text = commandPreview(draft());
    for (const bad of ['Bearer ', 'Authorization', 'token=', 'https://']) {
      assert.equal(text.includes(bad), false, `预览不得包含 ${bad}`);
    }
  });
});

describe('C. 未验证通道一律不发', () => {
  test('C1 remoteVerified=false 时 typed 拒绝，文案不说「已发送」', () => {
    const out = decideCommandSend(input({ remoteVerified: false }));
    assert.equal(out.ok, false);
    assert.equal(out.code, 'E_COMMAND_REMOTE_UNVERIFIED');
    assert.equal(/已发送/.test(out.wording), false);
  });

  test('C2 模型不含 WebView 凭据路径', () => {
    for (const bad of ['Bearer ', 'Authorization', 'loadUrl(', 'handleConfirm(', 'WebviewController']) {
      assert.equal(src.includes(bad), false, `模型不得触碰 ${bad}`);
    }
  });
});
