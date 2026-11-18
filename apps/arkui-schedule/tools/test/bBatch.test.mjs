// B 批测试补齐：「最近一次成功记录 + 一键重连」链路的源码级契约守卫。
//
// 为什么是静态断言：Settings.ets / RemoteSection.ets / RemoteControl.ets / ChatDetail.ets 都是
// ArkTS（依赖 @kit.ArkUI 等运行时），Node 里跑不起来。但「新增键是否三处成对读写」「重连按钮
// 是否排在打开远程之前」「落盘前是否剥掉令牌」「聊天页是否只有跳转没有输入框」这些都是纯文本
// 可判定的事实，用测试固化能挡住「加字段忘记读写」「secret 漏进记录」「只读页长出输入框」这类回归。
//
// 本文件只断言契约，不迁就半成品：B/C/E 段对应的源码由并行子代理写入，未落地时红是预期行为。
// 前置：无需构建（不 import .build），直接读源码。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { readRemoteSection, readSettingsFile, readSettingsPage } from './settingsSources.mjs';

const STORE = readSettingsFile('services/settingsStore.ets');
const PAGE = readSettingsPage();
const REMOTE_SECTION = readRemoteSection();
const REMOTE_CONTROL = readFileSync(
  new URL('../../entry/src/main/ets/pages/RemoteControl.ets', import.meta.url),
  'utf8'
);
const CHAT_DETAIL = readFileSync(
  new URL('../../entry/src/main/ets/pages/ChatDetail.ets', import.meta.url),
  'utf8'
);
// 「只读纪律」的反向断言只对**可执行代码行**生效：文件头注释里原有的否定句
// （「底部没有输入框，也没有发送按钮」）是在描述纪律，不是入口，不能算违规。
const DETAIL_CODE = CHAT_DETAIL.split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
  .join('\n');

/**
 * 截取某个方法体（从 `签名` 到下一个顶层 `async `/`private `/`/**` 段落）。
 *
 * 与 `remoteSettings.test.mjs` / `settingsStorePairing.test.mjs` 同一套规则：三处落盘的断言
 * 必须各自只看自己的方法体，否则「save 里写了、saveSyncState 里漏了」会被整文件搜索放过。
 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到方法：${signature}`);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:async |private |\/\*\*)/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** 截取 `@Builder Name() { ... }` 的方法体（按大括号配平，避免相邻 builder 互相污染）。 */
function builderBody(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, `找不到 builder：${name}`);
  let depth = 0;
  let index = source.indexOf('{', start);
  const from = index;
  for (; index < source.length; index++) {
    const char = source[index];
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(from, index + 1);
      }
    }
  }
  assert.fail(`builder ${name} 的大括号不配平`);
}

// ---------------------------------------------------------------------------
// A. settingsStore.ets：新键 remoteLastOk 必须在接口 + load / save / saveSyncState 三处成对。
//    缺任何一处，用户「最近一次成功」的记录都会在保存设置时被悄悄抹掉。
// ---------------------------------------------------------------------------
describe('A. settingsStore.ets：remoteLastOk 在接口与三处落盘方法里成对出现', () => {
  const interfaceBlock = STORE.slice(
    STORE.indexOf('export interface ScheduleSettings'),
    STORE.indexOf('/** 同步状态的部分更新')
  );
  const patchBlock = STORE.slice(
    STORE.indexOf('export interface SettingsPatch'),
    STORE.indexOf('/** 备用源配置')
  );
  const loadBody = methodBody(STORE, 'async load(');
  const saveBody = methodBody(STORE, 'async save(');
  const syncStateBody = methodBody(STORE, 'async saveSyncState(');

  test('A1 ScheduleSettings / SettingsPatch 都声明 remoteLastOk（缺字段则整表保存丢值）', () => {
    assert.match(interfaceBlock, /remoteLastOk: string;/, '契约丢了：ScheduleSettings 缺 remoteLastOk: string;');
    assert.match(patchBlock, /remoteLastOk\?: string;/, '契约丢了：SettingsPatch 缺 remoteLastOk?: string;');
  });

  test('A2 存储键常量是 KEY_REMOTE_LAST_OK = remoteLastOk', () => {
    assert.match(
      STORE,
      /const KEY_REMOTE_LAST_OK: string = 'remoteLastOk';/,
      '契约丢了：缺少 remoteLastOk 对应的 preferences 键常量'
    );
  });

  test('A3 load() 读 KEY_REMOTE_LAST_OK（空串兜底）、赋值并在返回对象里构造', () => {
    assert.match(loadBody, /prefs\.get\(KEY_REMOTE_LAST_OK,\s*''\)/, '契约丢了：load() 没读 remoteLastOk（旧数据会丢记录）');
    assert.match(loadBody, /remoteLastOk\s*=\s*/, '契约丢了：load() 没把读到的值赋给 remoteLastOk');
    assert.match(
      loadBody,
      /remoteLastOk: remoteLastOk\.trim\(\),/,
      '契约丢了：load() 的返回对象缺 remoteLastOk: remoteLastOk.trim()'
    );
  });

  test('A4 save() 未传沿用 / 传了 trim，并写回 preferences', () => {
    assert.match(
      saveBody,
      /patch\.remoteLastOk === undefined \? current\.remoteLastOk : patch\.remoteLastOk\.trim\(\)/,
      '契约丢了：save() 缺 remoteLastOk 的「未传沿用、传了 trim」构造'
    );
    assert.match(
      saveBody,
      /prefs\.put\(KEY_REMOTE_LAST_OK, next\.remoteLastOk\)/,
      '契约丢了：save() 没把 remoteLastOk 写回 preferences'
    );
  });

  test('A5 saveSyncState() 的逐字段构造也带 remoteLastOk（三处必须成对）', () => {
    assert.match(
      syncStateBody,
      /remoteLastOk: current\.remoteLastOk,/,
      '契约丢了：saveSyncState() 的逐字段构造漏了 remoteLastOk，会抹掉重连记录'
    );
  });
});

// ---------------------------------------------------------------------------
// B. pages/Settings.ets：一键重连按钮 + onPageShow 只做局部刷新。
//    整表 applySettings 会把用户正在编辑的输入框退回旧值，所以 onPageShow 里明令禁止调用它。
// ---------------------------------------------------------------------------
describe('B. pages/Settings.ets：一键重连入口 + onPageShow 局部刷新', () => {
  const applySettingsBody = methodBody(PAGE, 'private applySettings(');
  const reconnectTextBody = methodBody(PAGE, 'private reconnectText(');
  const reconnectLastOkBody = methodBody(PAGE, 'private async reconnectLastOk(');
  const onPageShowBody = methodBody(PAGE, 'onPageShow(');
  const remoteGroup = builderBody(PAGE, 'RemoteGroup');
  const openRemoteBody = methodBody(PAGE, 'private async openRemote(');

  test('B1 @State remoteLastOk 存在，且 applySettings 把它铺回表单', () => {
    assert.match(PAGE, /@State remoteLastOk: string = '';/, '契约丢了：设置页缺 @State remoteLastOk: string = \'\';');
    assert.match(
      applySettingsBody,
      /this\.remoteLastOk = settings\.remoteLastOk;/,
      '契约丢了：applySettings 没把读到的记录铺回表单'
    );
  });

  test('B2 reconnectText() 用 reconnectLabel(decodeLastOk(...), Date.now()) 生成文案', () => {
    assert.match(PAGE, /private reconnectText\(\): string/, '契约丢了：缺 private reconnectText(): string');
    assert.match(
      reconnectTextBody,
      /reconnectLabel\(\s*decodeLastOk\(this\.remoteLastOk\)\s*,\s*Date\.now\(\)\s*\)/,
      '契约丢了：reconnectText 没按同一口径生成重连按钮文案'
    );
  });

  test('B3 reconnectLastOk() 解码记录 → 现拼令牌 → 打开远程；失败分支给红字', () => {
    assert.match(
      PAGE,
      /private async reconnectLastOk\(\): Promise<void>/,
      '契约丢了：缺 private async reconnectLastOk(): Promise<void>'
    );
    assert.match(reconnectLastOkBody, /decodeLastOk\(this\.remoteLastOk\)/, '契约丢了：重连没解码最近一次成功记录');
    assert.match(
      reconnectLastOkBody,
      /mergeRemoteToken\(\s*entry\.url\s*,\s*this\.effectiveRemoteToken\(\)\s*\)/,
      '契约丢了：重连没用已保存令牌现拼地址（记录里不带 secret）'
    );
    assert.match(reconnectLastOkBody, /this\.openRemote\(/, '契约丢了：重连没调用 openRemote 打开页面');
    assert.match(reconnectLastOkBody, /重连失败：/, '契约丢了：重连失败分支缺「重连失败：」红字');
  });

  test('B4 onPageShow() 只刷新最近成功记录，不整表 reload（防止覆盖正在编辑的表单）', () => {
    assert.match(PAGE, /onPageShow\(\): void/, '契约丢了：缺 onPageShow(): void');
    assert.match(onPageShowBody, /refreshRemoteLastOk/, '契约丢了：onPageShow 没刷新最近成功记录');
    assert.doesNotMatch(
      onPageShowBody,
      /applySettings/,
      '契约丢了：onPageShow 调用了 applySettings，会把用户正在编辑的表单覆盖成旧值'
    );
  });

  test('B5 RemoteGroup() 把 reconnectText / onReconnect 传给 RemoteSection', () => {
    assert.match(
      remoteGroup,
      /reconnectText: this\.reconnectText\(\),/,
      '契约丢了：RemoteGroup 没把重连按钮文案传给 RemoteSection'
    );
    assert.match(remoteGroup, /onReconnect:/, '契约丢了：RemoteGroup 没把重连回调传给 RemoteSection');
  });

  test('B6 openRemote 带可选 overrideUrl 参数（重连时传入现拼的地址）', () => {
    assert.match(
      PAGE,
      /private async openRemote\(overrideUrl: string = ''\): Promise<void>/,
      '契约丢了：openRemote 缺可选参数 overrideUrl: string = \'\''
    );
  });

  test('B7 openRemote 仍是「先 save 再 push」（重连走同一条落盘路径）', () => {
    const saveIndex = openRemoteBody.indexOf('await settingsStore.save({ remoteUrl: check.url });');
    const pushIndex = openRemoteBody.indexOf('router.pushUrl(');
    assert.ok(saveIndex >= 0, '契约丢了：openRemote 缺「先保存归一地址」的调用');
    assert.ok(pushIndex > saveIndex, '契约丢了：必须先 save 再 pushUrl');
  });

  test('B8 重连（override 非空）跳过方式推导：build/save 都在 override 为空的守卫内', () => {
    // §B.4 核心语义：重连传入现拼地址（override 非空）时，openRemote 不得再用当前方式字段重新
    // 推导地址，也不得回写「方式字段 / 手输地址」。实现方式是把这两段逻辑分别关进两处
    // `if (override.length === 0) {` 守卫。这里用下标关系钉住「顺序 + 归属」，防止重构改坏不红。
    const firstGuard = openRemoteBody.indexOf('if (override.length === 0) {');
    const buildIdx = openRemoteBody.indexOf('buildRemoteAccessUrl(');
    const firstSaveIdx = openRemoteBody.indexOf('await settingsStore.save({ remoteUrl: check.url });');
    const manualIdx = openRemoteBody.indexOf('this.remoteManualUrl = check.url;');
    const secondGuard = openRemoteBody.indexOf('if (override.length === 0) {', firstGuard + 1);

    // 先用 >=0 兜底，避免某个下标为 -1 时后面的大小比较「看似通过」而实际无意义。
    assert.ok(firstGuard >= 0, '§B.4 语义丢了：openRemote 缺第一处 override 守卫（重连会重新拼地址）');
    assert.ok(buildIdx >= 0, '§B.4 语义丢了：openRemote 找不到 buildRemoteAccessUrl(，无法判定是否进了守卫');
    assert.ok(firstSaveIdx >= 0, '§B.4 语义丢了：openRemote 找不到第一次 save，无法判定守卫顺序');
    assert.ok(secondGuard >= 0, '§B.4 语义丢了：openRemote 缺第二处 override 守卫（重连会回写方式字段）');
    assert.ok(manualIdx >= 0, '§B.4 语义丢了：openRemote 找不到 remoteManualUrl 同步，无法判定是否在守卫内');

    // 顺序：第一处守卫 → 按方式拼地址 → 第一次 save → 第二处守卫 → 手输地址同步。
    assert.ok(
      buildIdx > firstGuard,
      '§B.4 语义丢了：「按方式拼地址」必须关在第一处 override 为空的守卫内（重连不重新推导）'
    );
    assert.ok(
      firstSaveIdx > buildIdx,
      '§B.4 语义丢了：顺序应为「守卫 → buildRemoteAccessUrl → 第一次 save」'
    );
    assert.ok(
      secondGuard > firstSaveIdx,
      '§B.4 语义丢了：第二处 override 守卫必须在第一次 save 之后（重连不写方式字段）'
    );
    assert.ok(
      manualIdx > secondGuard,
      '§B.4 语义丢了：remoteManualUrl 同步必须在第二处守卫内（重连不误改手输地址）'
    );
    // 恰好两处守卫：多一处=语义漂移，少一处=漏守卫。
    assert.equal(
      openRemoteBody.split('if (override.length === 0) {').length - 1,
      2,
      '§B.4 语义丢了：override 守卫必须恰好两处（少一处漏守卫，多一处语义漂移）'
    );
  });

  test('B9 重连地址失效（merged 为空）→ 先给红字并 return，绝不把空串交给 openRemote', () => {
    // mergeRemoteToken 在记录里的地址已不合法时返回空串；空串交给 openRemote 会退化成
    // 「按当前方式字段重新拼」，把一次「重连失败」悄悄变成「按别的方式打开」，红字也会
    // 变成「请先填写电脑上的 DSH 地址」（与真实原因「记录失效」不符）。这里用下标关系
    // 钉住「先算 merged → 空串早退 → 再 openRemote(merged)」的顺序，防止重构改坏不红。
    const mergedIdx = reconnectLastOkBody.indexOf('const merged: string = mergeRemoteToken(entry.url, this.effectiveRemoteToken());');
    const guardIdx = reconnectLastOkBody.indexOf('if (merged.length === 0) {', mergedIdx);
    const returnIdx = reconnectLastOkBody.indexOf('return;', guardIdx);
    const openIdx = reconnectLastOkBody.indexOf('this.openRemote(merged)', mergedIdx);

    assert.ok(mergedIdx >= 0, '契约丢了：缺 merged 变量（重连必须先算合并地址）');
    assert.ok(guardIdx > mergedIdx, '契约丢了：merged 为空必须早退（不能把空串交给 openRemote）');
    assert.ok(returnIdx > guardIdx, '契约丢了：空 merged 分支缺 return');
    assert.ok(openIdx > returnIdx, '契约丢了：openRemote(merged) 必须在守卫之后调用');
    assert.match(reconnectLastOkBody, /重连失败：最近一次成功的地址已失效/, '契约丢了：地址失效的红字文案不符');
    assert.equal(reconnectLastOkBody.indexOf('this.openRemote(mergeRemoteToken('), -1, '契约丢了：不得再把 mergeRemoteToken 的结果内联传给 openRemote');
  });
});

// ---------------------------------------------------------------------------
// C. components/settings/RemoteSection.ets：重连按钮排在「打开远程控制」之前，且文案不带令牌。
// ---------------------------------------------------------------------------
describe('C. components/settings/RemoteSection.ets：重连按钮的位置与形态', () => {
  const reconnectIndex = REMOTE_SECTION.indexOf('label: this.reconnectText');
  const openIndex = REMOTE_SECTION.indexOf("label: '打开远程控制'");

  test('C1 props：reconnectText 文案与 onReconnect 回调都接进来了', () => {
    assert.match(
      REMOTE_SECTION,
      /@Prop reconnectText: string = '';/,
      '契约丢了：RemoteSection 缺 @Prop reconnectText: string = \'\';'
    );
    assert.match(REMOTE_SECTION, /onReconnect:\s*\(\)\s*=>\s*void/, '契约丢了：RemoteSection 缺 onReconnect: () => void');
  });

  test('C2 重连 ActionButton 存在，且排在「打开远程控制」之前', () => {
    assert.ok(reconnectIndex > -1, '契约丢了：找不到重连按钮（label: this.reconnectText）');
    assert.ok(openIndex > -1, '契约丢了：找不到「打开远程控制」按钮');
    assert.ok(reconnectIndex < openIndex, '契约丢了：重连按钮必须排在「打开远程控制」之前');
  });

  test('C3 重连按钮是 secondary + block 的次要动作，label 直接取 reconnectText（不拼 token）', () => {
    assert.ok(reconnectIndex > -1, '契约丢了：找不到重连按钮，无法校验按钮形态');
    const nextLabel = REMOTE_SECTION.indexOf('label:', reconnectIndex + 1);
    const button = REMOTE_SECTION.slice(reconnectIndex, nextLabel > reconnectIndex ? nextLabel : reconnectIndex + 600);
    assert.match(button, /variant: 'secondary'/, '契约丢了：重连按钮必须是 secondary（次要动作）');
    assert.match(button, /block: true/, '契约丢了：重连按钮必须占满整行（block: true）');
    assert.match(button, /label: this\.reconnectText/, '契约丢了：label 必须用 reconnectText，不能自己拼 token 进文案');
  });
});

// ---------------------------------------------------------------------------
// D. pages/RemoteControl.ets：onPageEnd 落盘「最近一次成功」，且记录里不含 secret。
// ---------------------------------------------------------------------------
describe('D. pages/RemoteControl.ets：onPageEnd 记录最近一次成功（记录不含 secret）', () => {
  const importLine = REMOTE_CONTROL.split('\n').find((line) => line.includes("from '../model/remoteUrl'")) ?? '';
  const recordBody = methodBody(REMOTE_CONTROL, 'private recordLastOk(');
  const onPageEndIndex = REMOTE_CONTROL.indexOf('onPageEnd(');
  const callIndex = REMOTE_CONTROL.indexOf('this.recordLastOk();', onPageEndIndex);

  test('D1 import 同时引入 stripRemoteToken 与 encodeLastOk', () => {
    assert.match(importLine, /\bstripRemoteToken\b/, '契约丢了：RemoteControl 没 import stripRemoteToken');
    assert.match(importLine, /\bencodeLastOk\b/, '契约丢了：RemoteControl 没 import encodeLastOk');
  });

  test('D2 recordLastOk() 存在且失败早退（不用失败页覆盖旧记录）', () => {
    assert.match(REMOTE_CONTROL, /private recordLastOk\(\): void/, '契约丢了：缺 private recordLastOk(): void');
    assert.match(
      recordBody,
      /this\.loadError\.length > 0[\s\S]*?\breturn;/,
      '契约丢了：loadError 非空时必须早退，不能让失败页覆盖旧的成功记录'
    );
  });

  test('D3 落盘前 stripRemoteToken 剥令牌，并用 encodeLastOk 序列化记录', () => {
    assert.match(recordBody, /stripRemoteToken\(this\.url\)/, '契约丢了：落盘记录必须先删掉 token / k 整组参数');
    assert.match(recordBody, /encodeLastOk\(entry\)/, '契约丢了：记录必须用 encodeLastOk 序列化成单行 JSON');
  });

  test('D4 onPageEnd 回调里调用 recordLastOk()（主文档加载完成 = 最接近成功）', () => {
    assert.ok(onPageEndIndex >= 0, '契约丢了：Web 没有 onPageEnd 回调');
    assert.ok(
      callIndex > onPageEndIndex && callIndex - onPageEndIndex < 500,
      '契约丢了：onPageEnd 回调里必须调用 this.recordLastOk();'
    );
  });
});

// ---------------------------------------------------------------------------
// E. pages/ChatDetail.ets：只读聊天页，唯一出口是跳远程控制页，不给假的输入/发送入口。
// ---------------------------------------------------------------------------
describe('E. pages/ChatDetail.ets：在电脑上继续（只读，不接管不发送）', () => {
  test('E1 出口文案、禁用原因、说明文案逐字存在', () => {
    assert.match(CHAT_DETAIL, /label: '在电脑上继续'/, '契约丢了：缺「在电脑上继续」出口按钮文案');
    assert.match(
      CHAT_DETAIL,
      /disabledReason: '先在设置里填写电脑上的 DSH 地址'/,
      '契约丢了：没有地址时的禁用原因文案不符'
    );
    assert.match(CHAT_DETAIL, /写入仍是电脑端的事/, '契约丢了：说明文案必须写清「写入仍是电脑端的事」');
  });

  test('E2 点击跳到 RemoteControl 并带走归一后的地址', () => {
    assert.match(
      CHAT_DETAIL,
      /router\.pushUrl\(\{ url: routeToRemote\(\), params: \{ url: this\.remoteUrl \} \}\)/,
      '契约丢了：跳转调用不符（要用 routeToRemote + 带上 this.remoteUrl）'
    );
    assert.match(
      CHAT_DETAIL,
      /normalizeRemoteUrl\(settings\.remoteUrl\)/,
      '契约丢了：进页面必须读并用同一份规则归一设置里的地址'
    );
  });

  test('E3 只读纪律：可执行代码里没有 TextInput / TextArea / 「发送」（ActionButton 不算输入框）', () => {
    // 只对可执行代码行断言，不扫描注释：文件头原有的否定句（「底部没有输入框，也没有发送按钮」）
    // 是在声明纪律而非提供入口，不能因为这句话把测试弄红；同样也不该去改那段正确注释。
    assert.equal(/\bTextInput\b/.test(DETAIL_CODE), false, '契约丢了：ChatDetail 不得出现输入框（TextInput）');
    assert.equal(/\bTextArea\b/.test(DETAIL_CODE), false, '契约丢了：ChatDetail 不得出现文本域（TextArea）');
    assert.equal(/发送/.test(DETAIL_CODE), false, '契约丢了：ChatDetail 不得出现发送入口');
    assert.equal(/Button\(\s*['"`]发送/.test(DETAIL_CODE), false, '契约丢了：ChatDetail 不得出现发送按钮');
  });
});
