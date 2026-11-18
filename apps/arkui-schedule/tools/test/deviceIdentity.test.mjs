// 设备身份与「设备标识重复」防护的纯逻辑回归测试（`model/deviceIdentity.ts`）。
//
// 背景：旧校验只看设备标识的格式与长度，两台设备填同一个 id 时**校验会通过**；
// 后果是附件 zip `devices/<id>/attachments/<date>.zip` 互相覆盖、历史混在一起。
// 本文件把「指纹三态判定」「推送前附件判定（fail-closed）」「冲突文案逐字」钉成规则表。
//
// 前置：先构建纯逻辑层
//   node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const {
  ATTACHMENT_BASELINE_MISSING_REASON,
  ATTACHMENT_OVERWRITE_REASON,
  DEVICE_FINGERPRINT_FILE,
  IDENTITY_CONFLICT_TEMPLATE,
  checkDeviceIdentity,
  describeAttachmentPushBlock,
  describeIdentityConflict,
  deviceFingerprintPath,
  fingerprintFileText,
  generateFingerprint,
  isFingerprint,
  normalizeFingerprint,
  shouldBlockAttachmentPush
} = await import('../.build/model/deviceIdentity.js');

const UA = 'a'.repeat(64);
const UB = 'b'.repeat(64);
const FP_A = '11111111-2222-4333-8444-555555555555';
const FP_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

describe('指纹文本：归一 / 形态 / 文件内容', () => {
  test('normalizeFingerprint：去 BOM、去换行、转小写；非法一律空串', () => {
    assert.equal(normalizeFingerprint(`\ufeff${FP_A}\r\n`), FP_A, 'BOM 与 CRLF 必须去掉');
    assert.equal(normalizeFingerprint(`  ${FP_A.toUpperCase()}  `), FP_A, '统一小写');
    assert.equal(normalizeFingerprint(''), '');
    assert.equal(normalizeFingerprint('   '), '');
    assert.equal(normalizeFingerprint(null), '');
    assert.equal(normalizeFingerprint(undefined), '');
    assert.equal(normalizeFingerprint('abc'), '', '太短不算指纹（避免把设备标识当指纹）');
    assert.equal(normalizeFingerprint('has space in it'), '', '含空白不算指纹');
  });

  test('isFingerprint 与 normalizeFingerprint 一致', () => {
    assert.equal(isFingerprint(FP_A), true);
    assert.equal(isFingerprint(''), false);
    assert.equal(isFingerprint(null), false);
  });

  test('generateFingerprint：UUID v4 形态、两次不同、可被归一', () => {
    const first = generateFingerprint();
    const second = generateFingerprint();
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(second, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(first, second, '同一毫秒内连续生成也不能相同');
    assert.equal(normalizeFingerprint(first), first, '生成结果本身必须是规范指纹');
  });

  test('fingerprintFileText：单行、带一个换行；非法指纹不写文件', () => {
    const text = fingerprintFileText(FP_A);
    assert.equal(text, `${FP_A}\n`);
    assert.equal(text.trim().split('\n').length, 1, '内容必须只有一行');
    assert.equal(fingerprintFileText(''), '');
    assert.equal(fingerprintFileText('not a fingerprint'), '');
  });

  test('deviceFingerprintPath：仓库相对路径固定为 devices/<id>/.device-fingerprint', () => {
    assert.equal(DEVICE_FINGERPRINT_FILE, '.device-fingerprint');
    assert.equal(deviceFingerprintPath('phone-a'), 'devices/phone-a/.device-fingerprint');
    assert.equal(deviceFingerprintPath('  Phone-A '), 'devices/phone-a/.device-fingerprint', '设备标识先归一');
    assert.equal(deviceFingerprintPath(''), '', '空设备标识没有合法路径');
    assert.equal(deviceFingerprintPath('phone a'), '', '含空格的设备标识非法');
    assert.equal(deviceFingerprintPath('../evil'), '', '目录穿越不能拼出路径');
  });
});

describe('冲突文案：逐字（含 <id> 替换）', () => {
  test('describeIdentityConflict("phone-a") 逐字等于契约文案', () => {
    assert.equal(
      describeIdentityConflict('phone-a'),
      '这台设备和另一台设备用了同一个设备标识（phone-a），附件 zip 会互相覆盖、历史会混在一起。请改成唯一值。'
    );
  });

  test('模板只替换 {deviceId}，其余字符不变；空 id 用占位符而不是空括号', () => {
    assert.equal(IDENTITY_CONFLICT_TEMPLATE.includes('{deviceId}'), true);
    assert.equal(
      describeIdentityConflict('pc-b'),
      IDENTITY_CONFLICT_TEMPLATE.replace('{deviceId}', 'pc-b')
    );
    assert.equal(describeIdentityConflict('   ').includes('（(未填写)）'), true);
    assert.equal(describeIdentityConflict('').includes('{}'), false);
  });

  test('拒推原因文案逐字（附件 / 基线两条）', () => {
    assert.equal(
      ATTACHMENT_OVERWRITE_REASON,
      '附件已被另一台设备更新，已停止推送以免覆盖（请先改一个唯一的设备标识）'
    );
    assert.match(ATTACHMENT_BASELINE_MISSING_REASON, /缺少本机基线记录/);
  });
});

describe('checkDeviceIdentity：三态 + 归一化边界', () => {
  test('远端没有指纹（老仓库 / 首次）→ 不冲突，要求写入本机指纹', () => {
    for (const remote of [null, '', '   ']) {
      const check = checkDeviceIdentity(remote, FP_A);
      assert.equal(check.conflict, false, `remote=${JSON.stringify(remote)} 不该报警`);
      assert.equal(check.reason, '');
      assert.equal(check.adoptFingerprint, true, '首次同步要写入本机指纹');
    }
  });

  test('远端指纹 === 本机 → 正常（含大小写/换行/BOM 差异）', () => {
    for (const remote of [FP_A, FP_A.toUpperCase(), `\ufeff${FP_A}\r\n`, ` ${FP_A} `]) {
      const check = checkDeviceIdentity(remote, FP_A);
      assert.equal(check.conflict, false, `remote=${JSON.stringify(remote)} 应判为同一台设备`);
      assert.equal(check.adoptFingerprint, false, '已有指纹不能覆盖');
      assert.equal(check.reason, '');
    }
  });

  test('远端指纹 ≠ 本机 → 冲突（两台设备同一个 deviceId）', () => {
    const check = checkDeviceIdentity(FP_B, FP_A);
    assert.equal(check.conflict, true);
    assert.equal(check.adoptFingerprint, false, '冲突时绝不能覆盖远端指纹');
    assert.match(check.reason, /同一个设备标识/);
  });

  test('本机没有指纹 → 不报警但要求先写入（避免拿空指纹去比出假冲突）', () => {
    for (const local of ['', 'abc']) {
      const check = checkDeviceIdentity(FP_A, local);
      assert.equal(check.conflict, false);
      assert.equal(check.adoptFingerprint, true);
    }
  });

  test('远端与本机都缺失 → 不冲突（交给首次写入流程）', () => {
    const check = checkDeviceIdentity(null, '');
    assert.equal(check.conflict, false);
    assert.equal(check.adoptFingerprint, true);
  });
});

describe('shouldBlockAttachmentPush：6 种组合（fail-closed）', () => {
  const base = {
    remoteSha: UA,
    localBaselineSha: UA,
    remoteFingerprint: FP_A,
    localFingerprint: FP_A
  };

  test('① 远端没有该 zip（remoteSha 空）→ 纯新增，不挡', () => {
    for (const remoteSha of [null, '', '  ']) {
      const decision = shouldBlockAttachmentPush({ ...base, remoteSha });
      assert.equal(decision.block, false);
      assert.equal(decision.reason, '');
    }
  });

  test('② 没有本机基线 → 保守拒推（fail-closed），原因逐字来自常量', () => {
    for (const localBaselineSha of [null, '']) {
      const decision = shouldBlockAttachmentPush({ ...base, localBaselineSha });
      assert.equal(decision.block, true, '基线缺失必须拒推');
      assert.equal(decision.reason, ATTACHMENT_BASELINE_MISSING_REASON);
    }
  });

  test('③ 远端 sha === 基线 → 自上次同步后没变，不挡（即使指纹不同）', () => {
    const decision = shouldBlockAttachmentPush({ ...base, remoteFingerprint: FP_B });
    assert.equal(decision.block, false, '内容没变就不会覆盖任何东西');
    assert.equal(decision.reason, '');
  });

  test('④ 远端 sha 变了，但远端指纹 === 本机 → 是本机写的，不挡', () => {
    for (const remoteSha of [UB, UA.toUpperCase(), ` ${UB} `]) {
      const decision = shouldBlockAttachmentPush({ ...base, remoteSha });
      assert.equal(decision.block, false, `remoteSha=${JSON.stringify(remoteSha)} 属本机写入`);
    }
  });

  test('⑤ 远端 sha 变了且远端指纹 ≠ 本机 → 拒推，原因逐字', () => {
    const decision = shouldBlockAttachmentPush({ ...base, remoteSha: UB, remoteFingerprint: FP_B });
    assert.equal(decision.block, true);
    assert.equal(decision.reason, ATTACHMENT_OVERWRITE_REASON);
  });

  test('⑥ 远端 sha 变了且远端没有指纹 → 无法归属，拒推', () => {
    for (const remoteFingerprint of [null, '', '   ']) {
      const decision = shouldBlockAttachmentPush({ ...base, remoteSha: UB, remoteFingerprint });
      assert.equal(decision.block, true, '没有远端指纹时不能假定是自己写的');
      assert.equal(decision.reason, ATTACHMENT_OVERWRITE_REASON);
    }
  });

  test('本机没有指纹：内容没变不挡，内容变了拒推（不能瞎认领）', () => {
    assert.equal(
      shouldBlockAttachmentPush({ ...base, localFingerprint: '' }).block,
      false,
      'sha 相同就不涉及覆盖'
    );
    assert.equal(
      shouldBlockAttachmentPush({ ...base, remoteSha: UB, localFingerprint: '' }).block,
      true
    );
  });

  test('describeAttachmentPushBlock：只在 count>0 时给一行中文', () => {
    assert.equal(describeAttachmentPushBlock(0, ATTACHMENT_OVERWRITE_REASON), '');
    assert.equal(describeAttachmentPushBlock(-1, ''), '');
    assert.equal(
      describeAttachmentPushBlock(2, ATTACHMENT_OVERWRITE_REASON),
      `已暂停推送 2 个附件：${ATTACHMENT_OVERWRITE_REASON}`
    );
    assert.equal(describeAttachmentPushBlock(1, ''), '已暂停推送 1 个附件');
  });
});

// ---------------------------------------------------------------- 接线守卫（静态）
//
// 纯函数对了但没接进服务/页面，等于什么都没做。下面把「谁在哪一步调用」固化成断言。

const ETS = new URL('../../entry/src/main/ets/', import.meta.url);
const SETTINGS_STORE = readFileSync(new URL('services/settingsStore.ets', ETS), 'utf8');
const GIT_SERVICE = readFileSync(new URL('services/GitSyncService.ets', ETS), 'utf8');
const SETTINGS_PAGE = readFileSync(new URL('pages/Settings.ets', ETS), 'utf8');

describe('接线：settingsStore 的 deviceFingerprint 成对读写', () => {
  test('键常量 + load 读 + save 写（缺一个就会「每次都生成新指纹」）', () => {
    assert.match(SETTINGS_STORE, /const KEY_DEVICE_FINGERPRINT: string = 'deviceFingerprint';/);
    assert.match(SETTINGS_STORE, /prefs\.get\(KEY_DEVICE_FINGERPRINT,\s*''\)/, 'load() 必须读取指纹');
    assert.match(SETTINGS_STORE, /prefs\.put\(KEY_DEVICE_FINGERPRINT, next\.deviceFingerprint\)/, 'save() 必须写回指纹');
    assert.match(SETTINGS_STORE, /deviceFingerprint: string;/, 'ScheduleSettings 必须有该字段（否则保存即丢）');
  });
});

describe('接线：GitSyncService 的指纹写入 / 比对 / 拒推', () => {
  test('首次同步生成指纹并写进仓库 devices/<id>/.device-fingerprint', () => {
    assert.match(GIT_SERVICE, /generateFingerprint\(\)/, '本机首次同步要生成随机指纹');
    assert.match(GIT_SERVICE, /deviceFingerprint: fingerprint/, '生成的指纹要落进 settingsStore');
    assert.match(GIT_SERVICE, /deviceFingerprintPath\(/, '仓库里的写入路径必须走纯函数');
    assert.match(GIT_SERVICE, /fingerprintCache: string =/, '内存里要缓存本机指纹，避免每次同步都读盘');
  });

  test('拉取/推送后做身份比对，冲突时带 identityConflict 标记', () => {
    assert.match(GIT_SERVICE, /checkDeviceIdentity\(remote, local\)/);
    assert.match(GIT_SERVICE, /result\.identityConflict = true/);
    assert.match(GIT_SERVICE, /describeIdentityConflict\(/, '身份冲突要给出逐字文案');
    assert.match(GIT_SERVICE, /identityConflict\?: boolean/, 'GitSyncResult 必须有该可选字段');
  });

  test('push 前调 shouldBlockAttachmentPush，被挡的 zip 不提交（其它文件照常推）', () => {
    assert.match(GIT_SERVICE, /shouldBlockAttachmentPush\(\{/, '必须在提交前逐个附件判定');
    assert.match(GIT_SERVICE, /attachmentsBlocked/, '结果里要带被暂停的附件数');
    assert.match(GIT_SERVICE, /restoreQuarantined\(/, '临时挪走的附件必须在 finally 里放回');
    assert.match(GIT_SERVICE, /recordBaselineEntry\(/, '推送成功后要记录基线 sha');
  });
});

describe('接线：设置页把冲突做成常驻警告（不是 toast）', () => {
  test('有 identityWarning 状态 + warning 色渲染，且不经 toast', () => {
    assert.match(SETTINGS_PAGE, /@State identityWarning: string = ''/, '常驻警告必须有页面状态');
    assert.match(SETTINGS_PAGE, /Text\(this\.identityWarning\)/, '警告文案必须上屏');
    assert.match(
      SETTINGS_PAGE,
      /Text\(this\.identityWarning\)[\s\S]{0,240}app\.color\.warning/,
      '警告必须用 warning 档颜色（不是普通小字）'
    );
    assert.equal(
      /promptAction\.showToast\([^)]{0,120}identity/i.test(SETTINGS_PAGE),
      false,
      '设备标识冲突不能只闪一个 toast'
    );
    assert.match(SETTINGS_PAGE, /result\.identityConflict === true/, '页面要读同步结果里的冲突标记');
  });
});
