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
import { readSettingsFile, readSettingsPage, readSettingsRoot } from './settingsSources.mjs';

const STORE = readSettingsFile('services/settingsStore.ets');
const PAGE = readSettingsPage();
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
// ---------------------------------------------------------------------------
// B/C. mod-settings-remote-dedupe（old→new）：设置页一键重连 / RemoteSection 已删除。
// 旧 B1–B9 + C1–C3 钉住 reconnectText / reconnectLastOk / openRemote 的 override 守卫 /
// RemoteSection 按钮顺序；配置收敛到实例页后这些入口整条删除，断言 retarget 到：
// ① 旧控件与逻辑确实消失；② 唯一入口在；③ 旧值仍可读且全量迁移进实例表。
// 原 D/E 段（RemoteControl 落盘脱敏 / ChatDetail 只读出口）不受本模块影响，保持原样。
// ---------------------------------------------------------------------------
describe('B/C. 设置页远程配置删除 + 唯一入口 + 旧值迁移（retarget）', () => {
  // mod-shell-instances-pane（old→new）：正文锚点 pages/Instances.ets → pages/panes/InstancesPane.ets。
  const instances = readFileSync(
    new URL('../../entry/src/main/ets/pages/panes/InstancesPane.ets', import.meta.url), 'utf8'
  );
  const seed = readFileSync(
    new URL('../../entry/src/main/ets/model/instanceSeed.ts', import.meta.url), 'utf8'
  );

  test('B1（old→new）@State remoteLastOk / onPageShow 局部刷新随远程组删除', () => {
    assert.equal(/@State remoteLastOk/.test(PAGE), false, '设置页不该再有 remoteLastOk 表单状态');
    assert.equal(/onPageShow\(\): void/.test(PAGE), false, 'onPageShow 只为刷新重连记录，随组一起删');
    assert.equal(/refreshRemoteLastOk/.test(PAGE), false, '刷新方法不该残留');
  });

  test('B2（old→new）reconnectText / reconnectLastOk / openRemote 全部删除', () => {
    for (const gone of [
      /private reconnectText\(/, /private async reconnectLastOk\(/, /private async openRemote\(/,
      /reconnectLabel\(/, /decodeLastOk\(/, /mergeRemoteToken\(/, /buildRemoteAccessUrl\(/
    ]) {
      assert.equal(gone.test(PAGE), false, `设置页残留已删远程方法：${gone}`);
    }
  });

  test('B3（old→new，收紧）唯一入口是根页「远程实例」行，旧 RemoteGroup 已删', () => {
    // mod-settings-instances-entry-dedupe：旧断言钉「RemoteGroup 里一行 ChatEntryRow」；
    // 现在正向钉住四行菜单根页那一行 + 旧组/builder/handler 消失，强度不降。
    const root = readSettingsRoot();
    assert.equal((root.match(/'pages\/Instances'/g) ?? []).length, 1, '唯一 Instances 路由在根页');
    assert.match(root, /this\.MenuRow\('远程实例', this\.instanceSummary, ROUTE_INSTANCES\)/, '四行菜单的「远程实例」行');
    assert.equal(/RemoteGroup\(|ChatEntryRow\(|openInstances\(/.test(PAGE), false, '旧入口组/builder/handler 已删');
  });

  test('C1（old→new）RemoteSection.ets 文件删除，设置页不再导入或装配', () => {
    let exists = true;
    try {
      readSettingsFile('components/settings/RemoteSection.ets');
    } catch {
      exists = false;
    }
    assert.equal(exists, false, 'RemoteSection.ets 必须删除');
    assert.equal(PAGE.includes("from '../components/settings/RemoteSection'"), false, '不该再导入');
  });

  test('C2（old→new）旧 remote* 键仍可读、全量播种且令牌不丢（不是静默丢弃）', () => {
    for (const [field, key] of [
      ['remoteUrl', 'KEY_REMOTE_URL'], ['remoteLastOk', 'KEY_REMOTE_LAST_OK'], ['remoteToken', 'KEY_REMOTE_TOKEN']
    ]) {
      assert.match(STORE, new RegExp(`${field}: string;`), `${field} 仍可读`);
      assert.match(STORE, new RegExp(`prefs\\.put\\(${key}`), `${field} 仍写回`);
    }
    for (const field of ['remoteUrl', 'remoteLastOk', 'remoteMode', 'remoteToken']) {
      assert.match(instances, new RegExp(`${field}: settings\\.${field}`), `播种带上旧 ${field}`);
    }
    assert.match(seed, /candidate\.token = legacyToken/, '旧令牌迁进实例 token 字段');
  });
});

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
