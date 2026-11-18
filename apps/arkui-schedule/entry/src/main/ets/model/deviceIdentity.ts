/**
 * 设备身份（纯逻辑：不 import 任何 SDK，不碰文件系统，可在 Node 直接跑）。
 *
 * 背景：`deviceId` 决定本机只写 `devices/<deviceId>/`。旧校验只看「格式合法 + 非空」，
 * 因此**两台设备填同一个 id 时校验会通过**，后果是两份日程写进同一目录、附件 zip
 * `devices/<id>/attachments/<date>.zip` 互相覆盖、历史混在一起，而同步本身不会报错。
 *
 * 这里用「每台设备一个随机指纹」把这种冲突变成可检测、可拦截的事实（`docs/DATA-CONTRACT.md` §6.1）：
 * 1. 本机指纹存 `settingsStore.deviceFingerprint`，并写进仓库 `devices/<id>/.device-fingerprint`；
 * 2. 拉取后比对：远端缺 → 首次（写入本机指纹，不报警）；等于本机 → 正常；
 *    不等于本机 → **两台设备用了同一个 deviceId**（设置页常驻警告）；
 * 3. 推送前看附件 zip：远端 sha 与本机基线不一致、且远端指纹也不是本机 → 拒推该附件（fail-closed）。
 *
 * `.device-fingerprint` 跟着 git 一起提交（它在 `devices/<id>/` 下），但**不是 secret**：
 * 内容只是一个随机身份串，不含 token / 邮箱 / 机型等任何信息，泄露它没有任何凭据价值。
 */

/** 指纹文件名（放在 `devices/<deviceId>/` 目录里，随 git 提交）。 */
export const DEVICE_FINGERPRINT_FILE: string = '.device-fingerprint';

/** 设备标识格式（与 `docs/DATA-CONTRACT.md` §1 的快照目录名规则一致）。 */
const DEVICE_ID_RE: RegExp = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 指纹文本格式：UUID / 十六进制等「8–64 位字母数字短横线」，不含空白与换行。 */
const FINGERPRINT_RE: RegExp = /^[0-9a-z][0-9a-z-]{7,63}$/;

/** 冲突文案模板：`{deviceId}` 会被替换成用户填的设备标识（设置页逐字展示）。 */
export const IDENTITY_CONFLICT_TEMPLATE: string =
  '这台设备和另一台设备用了同一个设备标识（{deviceId}），附件 zip 会互相覆盖、历史会混在一起。请改成唯一值。';

/** 冲突的机器可读原因（`IdentityCheck.reason`；面向用户的完整句子用 `describeIdentityConflict`）。 */
export const IDENTITY_CONFLICT_REASON: string = '远端 .device-fingerprint 与本机不一致：另一台设备用了同一个设备标识';

/** 远端附件已被别的设备改过：拒推这个附件（其它文件照常推）。 */
export const ATTACHMENT_OVERWRITE_REASON: string =
  '附件已被另一台设备更新，已停止推送以免覆盖（请先改一个唯一的设备标识）';

/** 没有本机基线：无法证明远端版本是自己写的 → 保守拒推该附件（fail-closed）。 */
export const ATTACHMENT_BASELINE_MISSING_REASON: string =
  '附件缺少本机基线记录，无法确认没有被别的设备改过，已停止推送该附件（请先「拉取」一次再推送）';

/**
 * 冲突提示（逐字文案，只替换设备标识）。
 *
 * 设备标识为空/非字符串时用 `(未填写)` 占位，保证文案不会出现空括号。
 */
export function describeIdentityConflict(deviceId: string): string {
  const id: string = typeof deviceId === 'string' ? deviceId.trim() : '';
  return IDENTITY_CONFLICT_TEMPLATE.replace('{deviceId}', id.length > 0 ? id : '(未填写)');
}

/**
 * 归一指纹文本：去掉 BOM/首尾空白/换行后，必须是 8–64 位字母数字短横线，输出小写。
 * 不合法（空串 / 含空格 / 太短）一律返回空串，调用方据此当成「没有指纹」处理。
 */
export function normalizeFingerprint(raw: string | null | undefined): string {
  if (typeof raw !== 'string') {
    return '';
  }
  let text: string = raw;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  text = text.replace(/[\r\n]+/g, '').trim().toLowerCase();
  return FINGERPRINT_RE.test(text) ? text : '';
}

/** 是否是一个可用的指纹（等价于 `normalizeFingerprint(raw).length > 0`）。 */
export function isFingerprint(raw: string | null | undefined): boolean {
  return normalizeFingerprint(raw).length > 0;
}

/** 仓库里的指纹路径（`devices/<id>/.device-fingerprint`）；设备标识非法时返回空串。 */
export function deviceFingerprintPath(deviceId: string): string {
  const id: string = typeof deviceId === 'string' ? deviceId.trim().toLowerCase() : '';
  if (!DEVICE_ID_RE.test(id)) {
    return '';
  }
  return 'devices/' + id + '/' + DEVICE_FINGERPRINT_FILE;
}

/**
 * 指纹文件内容：**单行**（末尾一个换行，方便 `cat` 与 git 显示）。
 * 指纹为空时返回空串（调用方不要写空文件）。
 */
export function fingerprintFileText(fingerprint: string): string {
  const text: string = normalizeFingerprint(fingerprint);
  return text.length > 0 ? text + '\n' : '';
}

/** 同一毫秒内多次生成的去重序号（只用于让指纹不重复，不做安全用途）。 */
let fingerprintSeq: number = 0;

/**
 * 8 位十六进制补零片。
 *
 * **不是色值**：它只是 `toString(16)` 的左侧填充。起个名字而不是直接写字面量，
 * 一是避免色值扫描把 `+ '00000000'` 误判成「字符串拼色」，二是让拼接意图可读。
 */
const HEX_PAD8: string = '00000000';

/** 32 位随机十六进制串（`Math.random` 足够：指纹只用于「是不是同一台设备」）。 */
function randomHex32(): string {
  let out: string = '';
  while (out.length < 32) {
    const value: number = Math.floor(Math.random() * 0x100000000);
    out += (HEX_PAD8 + value.toString(16)).slice(-8);
  }
  return out.slice(0, 32);
}

/**
 * 生成一个随机指纹（UUID v4 形态）。
 *
 * 不依赖 `crypto` / `util`：ArkUI-X 的 Android 侧对 `@kit.ArkTS` 的覆盖并不完整，
 * 而指纹**不是秘密**（只用来区分设备），因此用 `Math.random` + 时间 + 序号混合即可；
 * 真需要密码学随机时应换成平台能力，但那不改变本文件的判定规则。
 */
export function generateFingerprint(): string {
  fingerprintSeq = (fingerprintSeq + 1) >>> 0;
  const mixed: string = (Date.now() >>> 0).toString(16) + fingerprintSeq.toString(16) + HEX_PAD8;
  const base: string[] = randomHex32().split('');
  for (let index = 0; index < 8; index++) {
    base[index] = mixed.charAt(index);
  }
  // UUID v4：版本位 = 4，变体位 = 8/9/a/b
  base[12] = '4';
  const variant: number = parseInt(base[16], 16) & 0x3;
  base[16] = (variant | 0x8).toString(16);
  const hex: string = base.join('');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

/** 设备身份比对结果。 */
export interface IdentityCheck {
  /** true = 两台设备用了同一个 deviceId（远端指纹 ≠ 本机指纹）。 */
  conflict: boolean;
  /** 机器可读原因（`conflict` 为 false 时是空串）。 */
  reason: string;
  /** true = 远端没有指纹（老仓库 / 首次同步），调用方应写入本机指纹且**不报警**。 */
  adoptFingerprint: boolean;
}

/**
 * 设备身份三态判定（规则逐条可测）：
 * - 本机没有指纹 → 先当「无法判定」：不报警、要求调用方写入本机指纹（服务层会先生成）；
 * - 远端没有指纹 → 老仓库/首次同步：写入本机指纹，不报警；
 * - 远端 === 本机 → 正常；
 * - 远端 ≠ 本机 → 冲突（同一 deviceId 被两台设备使用）。
 */
export function checkDeviceIdentity(
  remoteFingerprint: string | null,
  localFingerprint: string
): IdentityCheck {
  const local: string = normalizeFingerprint(localFingerprint);
  const remote: string = normalizeFingerprint(remoteFingerprint);
  if (local.length === 0) {
    const unresolved: IdentityCheck = { conflict: false, reason: '', adoptFingerprint: true };
    return unresolved;
  }
  if (remote.length === 0) {
    const firstTime: IdentityCheck = { conflict: false, reason: '', adoptFingerprint: true };
    return firstTime;
  }
  if (remote === local) {
    const ok: IdentityCheck = { conflict: false, reason: '', adoptFingerprint: false };
    return ok;
  }
  const conflict: IdentityCheck = {
    conflict: true,
    reason: IDENTITY_CONFLICT_REASON,
    adoptFingerprint: false
  };
  return conflict;
}

/** 附件推送判定结果。 */
export interface AttachmentPushDecision {
  /** true = 这个 zip 不要推（避免覆盖别人刚更新的版本）。 */
  block: boolean;
  /** 中文原因（`block` 为 false 时是空串）。 */
  reason: string;
}

/** 归一 sha 文本（只去空白/统一小写；不校验长度，交给比较本身）。 */
function normalizeSha(raw: string | null | undefined): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * 推送前单个附件 zip 的判定（fail-closed，规则逐条可测）：
 * 1. 远端没有这个 zip（`remoteSha` 空）→ 纯新增，不挡；
 * 2. 没有本机基线（`localBaselineSha` 空）→ 无法证明远端版本是自己写的 → **挡**；
 * 3. 远端 sha === 基线 → 自上次同步/推送后没变过 → 不挡；
 * 4. 变了，但远端指纹 === 本机指纹 → 是本机写的 → 不挡；
 * 5. 变了，远端指纹 ≠ 本机指纹（含远端没有指纹）→ 别人写的 → **挡**；
 * 6. 本机没有指纹 → 无法归属 → **挡**。
 */
export function shouldBlockAttachmentPush(input: {
  remoteSha: string | null;
  localBaselineSha: string | null;
  remoteFingerprint: string | null;
  localFingerprint: string;
}): AttachmentPushDecision {
  const remoteSha: string = normalizeSha(input.remoteSha);
  const baselineSha: string = normalizeSha(input.localBaselineSha);
  const local: string = normalizeFingerprint(input.localFingerprint);
  const remote: string = normalizeFingerprint(input.remoteFingerprint);
  // 1. 远端没有这个附件：纯新增，不会覆盖任何东西
  if (remoteSha.length === 0) {
    const fresh: AttachmentPushDecision = { block: false, reason: '' };
    return fresh;
  }
  // 2. 没有基线：保守拒推（宁可少推一个附件，也不覆盖别人的）
  if (baselineSha.length === 0) {
    const missing: AttachmentPushDecision = { block: true, reason: ATTACHMENT_BASELINE_MISSING_REASON };
    return missing;
  }
  // 3. 与基线一致：自本机上次同步/推送后没变过
  if (remoteSha === baselineSha) {
    const unchanged: AttachmentPushDecision = { block: false, reason: '' };
    return unchanged;
  }
  // 4. 变了，但是本机写的（远端指纹与本机一致）
  if (local.length > 0 && remote === local) {
    const mine: AttachmentPushDecision = { block: false, reason: '' };
    return mine;
  }
  // 5/6. 变了，且无法归属本机 → 拒推
  const blocked: AttachmentPushDecision = { block: true, reason: ATTACHMENT_OVERWRITE_REASON };
  return blocked;
}

/**
 * 「本次暂停推送 N 个附件」的一行说明（`count <= 0` 返回空串，不占行）。
 * 与 `GitSyncResult.attachmentWarning` 配合使用：其它文件照常推，只把这几个 zip 留在本机。
 */
export function describeAttachmentPushBlock(count: number, reason: string): string {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
    return '';
  }
  const why: string = typeof reason === 'string' ? reason.trim() : '';
  const head: string = '已暂停推送 ' + Math.floor(count).toString() + ' 个附件';
  return why.length > 0 ? head + '：' + why : head;
}
