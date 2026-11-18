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
import { readSettingsSources } from './settingsSources.mjs';

const {
  ATTACHMENT_BASELINE_MISSING_REASON,
  ATTACHMENT_OVERWRITE_REASON,
  DEVICE_FINGERPRINT_FILE,
  DUPLICATE_DEVICE_CONFLICT_TEMPLATE,
  FINGERPRINT_OVERWRITTEN_TEMPLATE,
  checkDeviceIdentity,
  describeAttachmentPushBlock,
  describeIdentityConflict,
  deviceFingerprintPath,
  fingerprintFileText,
  generateFingerprint,
  isFingerprint,
  normalizeFingerprint,
  resolveIdentity,
  shouldBlockAttachmentPush
} = await import('../.build/model/deviceIdentity.js');

const UA = 'a'.repeat(64);
const UB = 'b'.repeat(64);
const FP_A = '11111111-2222-4333-8444-555555555555';
const FP_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const FP_C = 'cccccccc-dddd-4eee-8fff-000000000000';

/** registry 一行（`{deviceId, uuid, at}`，与 `toRegistryLine` 同形）。 */
const row = (deviceId, uuid) => ({ deviceId, uuid, at: '2026-11-18T00:00:00.000Z' });

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

describe('冲突文案：两种逐字（含 <id> 替换）', () => {
  test('describeIdentityConflict("phone-a") 默认 = 撞号文案，逐字等于契约', () => {
    assert.equal(
      describeIdentityConflict('phone-a'),
      '这台设备和另一台设备用了同一个设备标识（phone-a），附件 zip 会互相覆盖、历史会混在一起。'
    );
  });

  test('被覆盖走另一句文案（两种冲突必须能区分）', () => {
    assert.equal(
      describeIdentityConflict('device-2', 'fingerprint-overwritten'),
      '本机设备指纹被另一台设备覆盖（device-2），可能是两台设备共用了同一份应用数据。'
    );
    assert.notEqual(
      describeIdentityConflict('device-2', 'fingerprint-overwritten'),
      describeIdentityConflict('device-2', 'duplicate-device'),
      '两种冲突的文案不能相同'
    );
    assert.equal(describeIdentityConflict('device-2', 'none'), describeIdentityConflict('device-2'), 'none 走撞号文案（兼容旧调用）');
  });

  test('模板只替换 {deviceId}，其余字符不变；空 id 用占位符而不是空括号', () => {
    assert.equal(DUPLICATE_DEVICE_CONFLICT_TEMPLATE.includes('{deviceId}'), true);
    assert.equal(FINGERPRINT_OVERWRITTEN_TEMPLATE.includes('{deviceId}'), true);
    assert.equal(
      describeIdentityConflict('pc-b'),
      DUPLICATE_DEVICE_CONFLICT_TEMPLATE.replace('{deviceId}', 'pc-b')
    );
    assert.equal(
      describeIdentityConflict('pc-b', 'fingerprint-overwritten'),
      FINGERPRINT_OVERWRITTEN_TEMPLATE.replace('{deviceId}', 'pc-b')
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

describe('resolveIdentity：一个 uuid 的四态 + 两种冲突', () => {
  test('同一 uuid 命中 registry → reuse（日常启动按行里的 deviceId，不重新编号）', () => {
    const resolution = resolveIdentity({
      localUuid: FP_A,
      localDeviceId: 'device-9',
      registry: [row('device-1', FP_B), row('device-2', FP_A)]
    });
    assert.equal(resolution.action, 'reuse');
    assert.equal(resolution.deviceId, 'device-2', '必须用 registry 行里的 deviceId，不是本机旧值');
    assert.equal(resolution.uuid, FP_A, 'uuid 原样沿用');
    assert.equal(resolution.conflict, 'none');
  });

  test('老用户升级：registry 没有该 uuid、但本机 deviceId 目录存在 → register-existing（绝不换号）', () => {
    const resolution = resolveIdentity({
      localUuid: FP_C,
      localDeviceId: 'phone-a',
      registry: [row('device-1', FP_A), row('device-2', FP_B)]
    });
    assert.equal(resolution.action, 'register-existing');
    assert.equal(resolution.deviceId, 'phone-a', '沿用原标识，不许改成 device-3');
    assert.equal(resolution.uuid, FP_C);
    assert.equal(resolution.conflict, 'none');
  });

  test('老用户升级：编号是自动分配的 device-2 时同样不换号', () => {
    const resolution = resolveIdentity({
      localUuid: FP_C,
      localDeviceId: 'device-2',
      registry: [row('device-1', FP_A)]
    });
    assert.equal(resolution.action, 'register-existing');
    assert.equal(resolution.deviceId, 'device-2');
  });

  test('同 deviceId 两个 uuid（本机 uuid 在行里）→ duplicate-device，文案是「撞号」那句', () => {
    const resolution = resolveIdentity({
      localUuid: FP_A,
      localDeviceId: null,
      registry: [row('device-2', FP_A), row('device-2', FP_B)]
    });
    assert.equal(resolution.action, 'reuse');
    assert.equal(resolution.deviceId, 'device-2');
    assert.equal(resolution.conflict, 'duplicate-device');
    assert.equal(
      describeIdentityConflict(resolution.deviceId, resolution.conflict),
      '这台设备和另一台设备用了同一个设备标识（device-2），附件 zip 会互相覆盖、历史会混在一起。'
    );
  });

  test('本机 uuid 不在该 deviceId 的行里 → fingerprint-overwritten，文案是「被覆盖」那句', () => {
    const resolution = resolveIdentity({
      localUuid: FP_B,
      localDeviceId: 'device-2',
      registry: [row('device-2', FP_A)]
    });
    assert.equal(resolution.action, 'claim-new', '不能往别人的目录里补登记');
    assert.equal(resolution.deviceId, null, '必须换一个编号');
    assert.equal(resolution.conflict, 'fingerprint-overwritten');
    assert.equal(
      describeIdentityConflict('device-2', resolution.conflict),
      '本机设备指纹被另一台设备覆盖（device-2），可能是两台设备共用了同一份应用数据。'
    );
  });

  test('指纹丢失（localUuid 读不到）→ recreate：生成新 uuid，不认领旧目录', () => {
    for (const localUuid of [null, '', '   ', 'abc', undefined]) {
      const resolution = resolveIdentity({
        localUuid,
        localDeviceId: 'device-2',
        registry: [row('device-2', FP_A)]
      });
      assert.equal(resolution.action, 'recreate', `localUuid=${JSON.stringify(localUuid)} 必须走新设备流程`);
      assert.equal(resolution.deviceId, null, 'recreate 不能直接认领旧编号');
      assert.equal(resolution.conflict, 'none', '指纹丢失本身不是冲突');
      assert.match(resolution.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.notEqual(resolution.uuid, FP_A, '新 uuid 不能等于 registry 里别人的 uuid');
      assert.notEqual(resolution.uuid, resolution.uuid.toUpperCase(), '必须是归一形态（小写）');
    }
  });

  test('无 deviceId 且 registry 无该 uuid → claim-new', () => {
    for (const localDeviceId of [null, '', '   ', 'Phone A']) {
      const resolution = resolveIdentity({
        localUuid: FP_B,
        localDeviceId,
        registry: [row('device-1', FP_A)]
      });
      assert.equal(resolution.action, 'claim-new', `localDeviceId=${JSON.stringify(localDeviceId)}`);
      assert.equal(resolution.deviceId, null);
      assert.equal(resolution.conflict, 'none');
      assert.equal(resolution.uuid, FP_B, 'claim-new 沿用本机 uuid，只换编号');
    }
  });

  test('空 registry + 有 uuid + 无 deviceId → claim-new（首次接入的新设备）', () => {
    const resolution = resolveIdentity({ localUuid: FP_A, localDeviceId: null, registry: [] });
    assert.equal(resolution.action, 'claim-new');
    assert.equal(resolution.uuid, FP_A);
    assert.equal(resolution.deviceId, null);
  });

  test('registry 里的坏行（缺 uuid / deviceId 非法）不参与判定，也不崩', () => {
    const resolution = resolveIdentity({
      localUuid: FP_A,
      localDeviceId: 'device-2',
      registry: [null, {}, { deviceId: 'device-2', uuid: '' }, { deviceId: '../evil', uuid: FP_A }, row('device-2', FP_A)]
    });
    assert.equal(resolution.action, 'reuse');
    assert.equal(resolution.deviceId, 'device-2');
    assert.equal(resolution.conflict, 'none');
  });

  test('uuid 大小写/空白差异仍算同一个身份（不误判成新设备）', () => {
    const resolution = resolveIdentity({
      localUuid: `  ${FP_A.toUpperCase()}  `,
      localDeviceId: null,
      registry: [row('device-3', FP_A)]
    });
    assert.equal(resolution.action, 'reuse');
    assert.equal(resolution.deviceId, 'device-3');
    assert.equal(resolution.uuid, FP_A);
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
// 因 A2 拆分移动：同步组（含常驻 warning 的渲染）搬到了 components/settings/SyncSection.ets，
// 这里要审计的是「设置页整体」，所以锚点是页面 + 五个 section 的合并源码；断言不变。
const SETTINGS_PAGE = readSettingsSources();

describe('接线：settingsStore 的 deviceFingerprint 成对读写', () => {
  test('键常量 + load 读 + save 写（缺一个就会「每次都生成新指纹」）', () => {
    assert.match(SETTINGS_STORE, /const KEY_DEVICE_FINGERPRINT: string = 'deviceFingerprint';/);
    assert.match(SETTINGS_STORE, /prefs\.get\(KEY_DEVICE_FINGERPRINT,\s*''\)/, 'load() 必须读取指纹');
    assert.match(SETTINGS_STORE, /prefs\.put\(KEY_DEVICE_FINGERPRINT, next\.deviceFingerprint\)/, 'save() 必须写回指纹');
    assert.match(SETTINGS_STORE, /deviceFingerprint: string;/, 'ScheduleSettings 必须有该字段（否则保存即丢）');
  });
});

describe('接线：GitSyncService 的指纹写入 / 比对 / 拒推', () => {
  test('一个 uuid 两处存放：指纹文件与 registry 用同一个值，不独立生成', () => {
    assert.match(GIT_SERVICE, /resolveIdentity\(\{/, '四态判定必须走纯函数');
    assert.match(GIT_SERVICE, /loadLocalIdentity\(\)/, '日常启动要先读指纹文件');
    assert.match(GIT_SERVICE, /readRepoFingerprint\(\)/, '必须读 devices/<id>/.device-fingerprint');
    assert.match(
      GIT_SERVICE,
      /deviceUuid: uuid,\s*deviceFingerprint: uuid/,
      'settings 的两个键必须写同一个 uuid（否则又变成两套身份）'
    );
    assert.match(GIT_SERVICE, /adoptRepoFingerprintUnder\(/, '仓库里的写入路径必须走纯函数');
    assert.match(GIT_SERVICE, /fingerprintCache: string =/, '内存里要缓存本机身份，避免每次同步都读盘');
    assert.equal(
      /generateFingerprint\(\)/.test(GIT_SERVICE),
      false,
      'uuid 只由纯函数 resolveIdentity 生成（服务里不许再独立生成一个）'
    );
  });

  test('升级兼容：本机编号目录存在才算「已有 deviceId」，补登记不换号', () => {
    assert.match(GIT_SERVICE, /existingLocalDeviceId\(\)/, '必须只认同目录真实存在的本机编号');
    assert.match(GIT_SERVICE, /register-existing/, '四态里的补登记分支要接到服务上');
  });

  test('指纹丢失：结果里带 fingerprintRecreated 标记，pull/push 都要透传', () => {
    assert.match(GIT_SERVICE, /result\.fingerprintRecreated = true/);
    assert.match(GIT_SERVICE, /fingerprintRecreated\?: boolean/, 'GitSyncResult 必须有该可选字段');
    assert.match(GIT_SERVICE, /registration\.fingerprintRecreated === true/, 'pull 要透传登记结果里的重建标记');
  });

  test('拉取/推送后做身份比对，冲突时带 identityConflict 标记', () => {
    assert.match(GIT_SERVICE, /checkDeviceIdentity\(remote, localUuid\)/);
    assert.match(GIT_SERVICE, /result\.identityConflict = true/);
    assert.match(GIT_SERVICE, /describeIdentityConflict\(/, '身份冲突要给出逐字文案');
    assert.match(GIT_SERVICE, /identityConflict\?: boolean/, 'GitSyncResult 必须有该可选字段');
    assert.match(GIT_SERVICE, /identityStickyConflict/, '冲突横幅要常驻（解决后也不立刻消失）');
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
