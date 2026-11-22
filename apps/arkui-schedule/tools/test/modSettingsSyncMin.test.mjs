// mod-settings-sync-min：同步仓库配置「删掉高级选项及配置，仅保留仓库地址和访问令牌」
// 的源码级守卫。ArkTS 组件跑不起来，所以用静态断言钉住四件事：
// ① 高级折叠区与其三个字段（用户名 / 设备标识 / 作者名）确实消失；
// ② 同步组主表单恰好两个输入框（仓库地址 + 访问令牌）；
// ③ 分支固定为 DEFAULT_BRANCH='main'，并与 syncProtocolStore 的 origin/main 真值对齐；
// ④ 诚实状态行 / 错误态重试仍在（失败 affordance 不随折叠区一起删）。
// 旧断言（高级默认收起、三字段在折叠区、三种情况自动展开）在 settingsFormValidation.test.mjs
// 已 retarget 到这里的「已删除 + 静默默认值」口径，不是简单删除。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readSettingsFile, readSettingsPage, readSettingsSources, readSyncPage } from './settingsSources.mjs';

// mod-settings-root（old→new）：业务实现从 pages/Settings.ets 搬到组件宿主，断言不变。
const PAGE = readSettingsPage();
// mod-settings-sync-page（new）：真正的同步页面自带三态文案与失败出口，三态断言锚这里。
const SYNC_PAGE = readSyncPage();
const SYNC = readSettingsFile('components/settings/SyncSection.ets');
const SOURCES = readSettingsSources();

function buildBody(source) {
  const start = source.indexOf('build() {');
  assert.ok(start >= 0, '找不到同步组 build()');
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail('build() 大括号不配平');
}

describe('mod-settings-sync-min：同步组只留仓库地址 + 访问令牌', () => {
  test('高级折叠区与三个字段（用户名 / 设备标识 / 作者名）整条删除', () => {
    const all = PAGE + '\n' + SYNC;
    for (const gone of [
      /SyncAdvancedFields/, /syncAdvancedOpen/, /syncAdvancedReason/,
      /toggleSyncAdvanced/, /openSyncAdvanced/, /高级\s*[▸▾]/,
      /用户名（HTTPS 认证）/, /this\.FieldLabel\('设备标识'\)/, /this\.FieldLabel\('作者名'\)/,
      /TextInput\(\{ text: this\.gitUsername/, /TextInput\(\{ text: this\.deviceId/,
      /TextInput\(\{ text: this\.author/, /onChangeDeviceId/, /onChangeAuthor/, /onChangeGitUsername/,
      /deviceIdNotice|deviceIdError|authorError|gitUsernameError/
    ]) {
      assert.equal(gone.test(all), false, `残留已删的高级字段/折叠区：${gone}`);
    }
  });

  test('主表单恰好两个输入框：仓库地址 + 访问令牌', () => {
    const form = buildBody(SYNC);
    assert.equal((form.match(/TextInput\(/g) ?? []).length, 2, '同步组只能有两个输入框');
    assert.match(form, /Text\('仓库地址'\)/);
    assert.match(form, /this\.FieldLabel\('访问令牌（仅存本机）'\)/);
    assert.match(form, /this\.HintLine\(SYNC_CAPTION\)/, '固定说明（平台按地址识别 · 分支固定 main）仍在');
    assert.match(SYNC, /const SYNC_CAPTION: string = '平台按地址自动识别 · 分支固定 main'/);
  });

  test('分支静默固定为 main（DEFAULT_BRANCH），与 syncProtocolStore 的 origin/main 真值一致', () => {
    const branchModel = readSettingsFile('model/syncError.ts');
    assert.match(branchModel, /export const DEFAULT_BRANCH: string = 'main';/);
    assert.match(PAGE, /branch: DEFAULT_BRANCH,/, 'configure() 下发给同步内核的分支固定为 DEFAULT_BRANCH');
    assert.match(PAGE, /gitExtrasStore\.save\(\s*\{[\s\S]{0,120}branch: DEFAULT_BRANCH/, '扩展设置里的旧 branch 也写成 main');
    const protocol = readSettingsFile('services/syncProtocolStore.ets');
    assert.match(protocol, /git push origin main|\['push', 'origin', 'main'\]/, '同步协议只对 main 推送');
    assert.match(protocol, /origin\/main/, '门禁/快进/回退都锚在 origin/main');
    assert.equal(/TextInput\(\{ text: this\.branch/.test(SOURCES), false, '不该有分支输入框');
  });

  test('认证方式由 HTTPS 静默派生：无选择器，存量 SSH 只读警告 + 显式出口仍在', () => {
    assert.equal(/pickAuthMode\(/.test(SOURCES), false, '不该有认证方式选择器');
    assert.match(SYNC, /Text\(SSH_STORED_WARNING\)/, '存量 SSH 仍给只读警告');
    assert.match(SYNC, /label: '改用 HTTPS 令牌'/, '保留显式切换出口（不清空存量 authMode）');
  });

  test('诚实状态行 + 只读错误态保留；手动重试出口已删（能力方法留作排障）', () => {
    const form = buildBody(SYNC);
    assert.match(form, /Text\(this\.syncMessage\)/, '诚实状态行必须存在');
    assert.match(form, /ErrorState\(\{/, '错误态三段式必须保留');
    assert.match(form, /onRetry: null/, '错误态不再挂手动重试');
    assert.doesNotMatch(form, /this\.runAction\(/);
    assert.match(SYNC_PAGE, /private retryFromStatus\(\): void/, '能力方法保留给支持');
    assert.match(SYNC_PAGE, /canRetrySync\(this\.lastSyncAction, this\.syncBusy\)/, '可重试判定仍在方法体内');
    assert.match(SYNC, /下一次自动同步会自行重试/, '下一步文案指向自动周期');
    // mod-sync-silent-autoinit（old→new，只加不删）：状态行文案改成三态；失败态按「失败：」着色，
    // 仓库事实（HEAD / 分支 / 领先落后）退到标注为诊断的区块，不再是无下一步的死结提示。
    assert.match(form, /this\.syncMessage\.startsWith\('失败：'\)/, '失败态按三态词汇着色');
    // mod-status-honesty-regression（old→new，收紧）：三态文案不再由页面各自插值，
    // 全部收敛到 model/syncStatusLine.ts + model/syncStatusPersist.ts 的常量；页面只做委托。
    const renderer = readSettingsFile('model/syncStatusLine.ts');
    const constants = readSettingsFile('model/syncStatusPersist.ts');
    assert.match(SYNC_PAGE, /syncStatusLineOf\(\{/, '页面委托唯一渲染器');
    assert.match(SYNC_PAGE, /syncStatusStore\.latestAttempt\(\)/, '事实来自权威最新尝试');
    assert.match(constants, /TEXT_SYNCING: string = '同步中…'/, '忙碌态三态文案只在纯模型定义');
    assert.match(constants, /TEXT_PAST_FAILED_PREFIX: string = '上次失败 · '/, '失败态三态文案只在纯模型定义');
    assert.match(constants, /TEXT_SYNCED_PREFIX: string = '已同步 · '/, '成功态三态文案只在纯模型定义');
    assert.match(renderer, /switch \(state\.kind\)/, '文案渲染是对五态联合类型的 total function');
    assert.match(renderer, /syncStatusText\(statusStateOf\(facts\)\)/, '事实先收敛为五态再渲染');
    assert.match(form, /诊断（仅排查用）/, '正文有诊断区标注');
    assert.match(form, /Text\(this\.statusLine\)/, '诊断区仍展示真实仓库事实（只换位置不删信息）');
    for (const banned of [/尚未初始化/, /首次克隆/, /先执行「拉取」/]) {
      assert.equal(banned.test(SYNC_PAGE + '\n' + SYNC), false, `用户可见文案残留死结：${banned}`);
    }
  });

  test('静默固定默认值：用户名按地址推断 / 设备编号由仓库分配 / 作者名默认「我」', () => {
    assert.match(PAGE, /httpsUsernameFor\(this\.gitPlatform, this\.repoUrl, ''\)/, '用户名按仓库地址推断');
    assert.match(PAGE, /branch: DEFAULT_BRANCH/, '分支固定 main');
    assert.match(SYNC, /const SYNC_CAPTION: string = '平台按地址自动识别 · 分支固定 main'/);
    const store = readSettingsFile('services/settingsStore.ets');
    assert.match(store, /DEFAULT_DEVICE_ID: string = 'phone-a'/, '设备标识默认来自既有身份');
    assert.match(store, /deviceIdAuto: boolean/, '设备编号自动分配状态仍在 store（旧值可读）');
  });

  test('存量值不丢：settingsStore 仍读写 gitUsername / deviceId / author / authMode', () => {
    const store = readSettingsFile('services/settingsStore.ets');
    for (const key of ['gitUsername', 'deviceId', 'author', 'authMode']) {
      assert.match(store, new RegExp(`${key}: string;`), `${key} 必须仍可读于 store`);
    }
    assert.match(PAGE, /this\.gitUsername = settings\.gitUsername/, '存量用户名铺回（不清空）');
    assert.match(PAGE, /this\.author = settings\.author/, '存量作者名铺回（不清空）');
    assert.match(PAGE, /gitUsername: this\.gitUsername\.trim\(\)/, '保存仍写回用户名（静默派生值）');
  });

  // mod-p0a-no-main-probe（只加不删）：同步面不新增「以远端分支建 main」等配置入口，
  // 分支仍静默固定 main；非空无 main 只给 typed 文案，不让用户改分支/建引用。
  test('同步面没有 adopt / 建分支入口，分支仍静默固定 main', () => {
    for (const [name, source] of [
      ['同步真页面', SYNC_PAGE], ['同步正文', SYNC], ['同步服务', readSettingsFile('services/GitSyncService.ets')]
    ]) {
      for (const banned of [
        /adopt(Branch|Main|Remote|AsMain)/i, /创建 main/, /以远端分支/, /branch\s+-D/, /--force/
      ]) {
        assert.equal(banned.test(source), false, `${name} 残留已撤回的建分支通道：${banned}`);
      }
    }
    const cycle = readSettingsFile('model/syncCycle.ts');
    assert.match(cycle, /把远端默认分支改名为 main/, '下一步只能是远端改名 / 换空仓库的纯提示');
    assert.match(SYNC_PAGE, /branch: DEFAULT_BRANCH/, 'configure() 仍固定 main');
  });
});
