/**
 * 设备编号自动分配 + `devices/registry.jsonl` 抢占（纯逻辑，Node 可测）。
 *
 * 背景（数据边界）：`deviceId` 决定本机只写 `devices/<deviceId>/`。原先设备标识是**用户手填**的，
 * 两台设备填同一个值就写进同一目录、附件互相覆盖；而「让用户自己想一个不重复的名字」这种要求
 * 在手机上必然失败。这里改成：**用户不用填**，首次接入时向仓库登记一行，编号由 `devices/` 里
 * 已有的最大编号 +1 得到。
 *
 * 契约（`docs/DATA-CONTRACT.md`「devices/registry.jsonl」一节）：
 * - 身份 = `uuid`（本机生成一次、永久复用）；`deviceId` 只是目录名，可以换、可以沿用老值；
 * - registry **只追加**，每行一个 JSON：`{deviceId, uuid, at, host?}`；
 * - 编号空洞**不回填**：`devices/` 里有 `device-1`/`device-3` 时新设备拿 `device-4`
 *   （回填会让「编号 = 设备数量」这类外部脚本得出错误结论，也会和残留目录撞车）；
 * - 并发接入靠 **push 抢占 + 重试**：两个设备同时算到 `device-4`，谁先 push 成功谁拿到，
 *   另一个被拒后重新拉取、重算，最多 `MAX_CLAIM_ATTEMPTS` 次；**失败就失败**（fail-closed），
 *   绝不退回「随便用一个号继续写」。
 *
 * 本文件不 import 任何 SDK、不碰文件系统、不读时钟（`at` 由调用方传入），因此 Node 里可直接跑，
 * 也方便在测试里用假仓库桩模拟两台设备并发接入。
 */

/** 自动分配编号的格式（只有这种目录名参与「最大编号」计算）。 */
export const DEVICE_ID_RE: RegExp = /^device-(\d+)$/;

/** 合法的设备目录名（老标识 `phone-a` 也算合法，只是不参与编号计算）。 */
const DEVICE_DIR_NAME_RE: RegExp = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** `uuid` 的规范形态（与 `model/deviceIdentity.ts` 的指纹同一字符集：8–64 位字母数字短横线）。 */
const UUID_RE: RegExp = /^[0-9a-z][0-9a-z-]{7,63}$/;

/** registry 在仓库里的相对路径（`devices/` 下，与本机目录同级）。 */
export const REGISTRY_PATH: string = 'devices/registry.jsonl';

/** 设备目录所在的仓库子目录。 */
export const DEVICES_DIR: string = 'devices';

/** 申请编号时 push 被拒的最大重试次数（含首次尝试，最多 5 次）。 */
export const MAX_CLAIM_ATTEMPTS: number = 5;

/** 抢占失败（重试用尽）的错误码，与 `services/GitSyncService.ets` 的 `SyncError` 对齐。 */
export const DEVICE_ID_CONFLICT_CODE: string = 'E_DEVICE_ID_CONFLICT';

/** 抢占失败给用户看的中文（逐字固定，设置页与报告共用）。 */
export const DEVICE_ID_CONFLICT_MESSAGE: string = '没能抢到设备编号，请稍后重试（已重试 5 次）';

/** 读不到仓库登记表时的错误码（仓库不可读 / 拉取失败 / uuid 不合法）。 */
export const REGISTRY_UNREADABLE_CODE: string = 'E_DEVICE_ID_UNREADABLE';

/** 默认的作者/设备主机名占位（`host` 只是排查线索，允许为空）。 */
export const UNKNOWN_HOST: string = '';

/** registry 一行（只追加；`host` 仅用于排查，不参与判定）。 */
export interface RegistryEntry {
  /** 设备目录名（`device-2` / 老标识 `phone-a`）。 */
  deviceId: string;
  /** 本机身份串（uuid）。**身份靠它**。 */
  uuid: string;
  /** 登记时刻（ISO 8601，由调用方给）。 */
  at: string;
  /** 设备标识（可选，只用于排查；不含任何秘密）。 */
  host?: string;
}

/** `parseRegistry` 的结果（坏行计数，好行照常可用）。 */
export interface RegistryParseResult {
  entries: RegistryEntry[];
  /** 无法解析/字段不合法的行数（坏行被丢弃，不阻断其它行）。 */
  errors: number;
}

/** JSON 解析的落点（全部可选，逐字段校验；这样坏数据不会把整张表带崩）。 */
interface RawRegistryEntry {
  deviceId?: string;
  uuid?: string;
  at?: string;
  host?: string;
}

function textOf(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 规范化 uuid：去空白、转小写；不合法返回空串（调用方按「没有身份」处理）。 */
export function normalizeUuid(raw: string | null | undefined): string {
  const text: string = textOf(raw).toLowerCase();
  return UUID_RE.test(text) ? text : '';
}

/** 目录名是否是 `device-<n>` 形态。 */
export function isAutoDeviceId(name: string): boolean {
  return DEVICE_ID_RE.test(textOf(name));
}

/** 目录名是否是合法的设备目录（含老标识）。 */
export function isValidDeviceId(name: string): boolean {
  return DEVICE_DIR_NAME_RE.test(textOf(name).toLowerCase());
}

/**
 * 从目录名列里取出所有 `device-N` 的编号（去重、升序）。
 * 非 `device-N` 的目录（`phone-a`、`attachments.tmp` 等）**不参与计数**。
 */
export function parseDeviceIds(dirNames: string[]): number[] {
  const result: number[] = [];
  if (!Array.isArray(dirNames)) {
    return result;
  }
  for (let index = 0; index < dirNames.length; index++) {
    const matched: RegExpExecArray | null = DEVICE_ID_RE.exec(textOf(dirNames[index]));
    if (matched === null) {
      continue;
    }
    const value: number = parseInt(matched[1], 10);
    if (!Number.isFinite(value) || result.indexOf(value) >= 0) {
      continue;
    }
    result.push(value);
  }
  result.sort((left: number, right: number) => left - right);
  return result;
}

/**
 * 下一个设备编号：**最大编号 + 1**（不是「个数 + 1」）。
 *
 * 空仓库 → `device-1`；`['device-1','device-3']` → `device-4`（空洞不回填）；
 * `['phone-a']` → `device-1`（非 `device-N` 不参与计数）。
 */
export function nextDeviceId(existing: string[]): string {
  const ids: number[] = parseDeviceIds(existing);
  let max: number = 0;
  for (let index = 0; index < ids.length; index++) {
    if (ids[index] > max) {
      max = ids[index];
    }
  }
  return 'device-' + (max + 1).toString();
}

/**
 * 解析 registry（JSONL：一行一条，空行跳过）。
 *
 * 坏行（非 JSON / 缺字段 / 字段形态不合法）**丢弃并计数**，不会让整张表失效——
 * 一张表被手改坏一行不该导致所有设备都抢不到编号。
 */
export function parseRegistry(jsonlText: string): RegistryParseResult {
  const entries: RegistryEntry[] = [];
  let errors: number = 0;
  const source: string = typeof jsonlText === 'string' ? jsonlText : '';
  const lines: string[] = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    let line: string = lines[index];
    if (line.charCodeAt(line.length - 1) === 13) {
      line = line.slice(0, line.length - 1);
    }
    if (line.trim().length === 0) {
      continue;
    }
    let raw: RawRegistryEntry | null = null;
    try {
      raw = JSON.parse(line) as RawRegistryEntry | null;
    } catch (error) {
      errors++;
      continue;
    }
    if (raw === null || typeof raw !== 'object') {
      errors++;
      continue;
    }
    const deviceId: string = textOf(raw.deviceId).toLowerCase();
    const uuid: string = normalizeUuid(raw.uuid);
    if (!isValidDeviceId(deviceId) || uuid.length === 0) {
      errors++;
      continue;
    }
    const entry: RegistryEntry = { deviceId: deviceId, uuid: uuid, at: textOf(raw.at) };
    const host: string = textOf(raw.host);
    if (host.length > 0) {
      entry.host = host;
    }
    entries.push(entry);
  }
  return { entries: entries, errors: errors };
}

/** 按 uuid 找已登记的设备编号（**身份靠 uuid**）；没有该行返回 `null`。 */
export function findDeviceByUuid(entries: RegistryEntry[], uuid: string): string | null {
  const target: string = normalizeUuid(uuid);
  if (target.length === 0 || !Array.isArray(entries)) {
    return null;
  }
  for (let index = 0; index < entries.length; index++) {
    if (normalizeUuid(entries[index].uuid) === target) {
      return textOf(entries[index].deviceId);
    }
  }
  return null;
}

/** 某个设备编号是否被**别的身份**占着（`uuid` 相同 = 自己的行，不算占用）。 */
export function isDeviceIdTaken(entries: RegistryEntry[], deviceId: string, uuid: string): boolean {
  const id: string = textOf(deviceId).toLowerCase();
  const mine: string = normalizeUuid(uuid);
  if (id.length === 0) {
    return true;
  }
  for (let index = 0; index < entries.length; index++) {
    if (textOf(entries[index].deviceId) === id && normalizeUuid(entries[index].uuid) !== mine) {
      return true;
    }
  }
  return false;
}

/** registry 一行文本（**单行 JSON，不带换行**；键顺序固定，便于 diff 阅读）。 */
export function toRegistryLine(entry: RegistryEntry): string {
  const parts: string[] = [];
  parts.push('"deviceId":' + JSON.stringify(textOf(entry.deviceId).toLowerCase()));
  parts.push('"uuid":' + JSON.stringify(normalizeUuid(entry.uuid)));
  parts.push('"at":' + JSON.stringify(textOf(entry.at)));
  const host: string = textOf(entry.host);
  if (host.length > 0) {
    parts.push('"host":' + JSON.stringify(host));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * 在已有文本末尾**追加**一行（只追加语义；缺末尾换行时补一个，避免两行粘成一行）。
 * 空文本 → 就是这一行 + 换行。
 */
export function appendRegistryLine(jsonlText: string, entry: RegistryEntry): string {
  const line: string = toRegistryLine(entry);
  const source: string = typeof jsonlText === 'string' ? jsonlText : '';
  if (source.length === 0) {
    return line + '\n';
  }
  return source.endsWith('\n') ? source + line + '\n' : source + '\n' + line + '\n';
}

/**
 * 老设备是否原样沿用现有 `deviceId`（**不重编号**）。
 *
 * 条件（全部满足）：
 * 1. 标识合法（`phone-a` 这种非 `device-N` 也合法）；
 * 2. 该标识在 registry 里没有被**别的 uuid** 占着（否则就是真冲突，必须换号）；
 * 3. 仓库里**已经存在**同名的 `devices/<id>/` 目录（证明这台设备以前就在用这个号；
 *    目录不存在说明只是默认值/别人填过，应该走自动分配）。
 *
 * 第 3 条是关键：`settingsStore` 的默认值是 `phone-a`，新装的设备不该因此占用 `phone-a`
 * （那正是「两台设备同名」的来源）。老用户升级时目录已在仓库里，于是保持原样。
 */
export function canReuseLocalDeviceId(
  localDeviceId: string,
  entries: RegistryEntry[],
  repoDeviceDirs: string[],
  uuid: string
): boolean {
  const id: string = textOf(localDeviceId).toLowerCase();
  if (!isValidDeviceId(id)) {
    return false;
  }
  if (isDeviceIdTaken(entries, id, uuid)) {
    return false;
  }
  if (!Array.isArray(repoDeviceDirs)) {
    return false;
  }
  for (let index = 0; index < repoDeviceDirs.length; index++) {
    if (textOf(repoDeviceDirs[index]).toLowerCase() === id) {
      return true;
    }
  }
  return false;
}

/** 抢占所需的仓库能力（ArkTS 侧由 `GitSyncService` 用 git 桥实现；测试里用假仓库桩）。 */
export interface DeviceRegistryPort {
  /** 读 `devices/registry.jsonl` 文本（不存在返回空串）。 */
  readRegistry(): string;
  /** 列 `devices/` 下的目录名（用于算下一个编号；不可读返回空数组）。 */
  listDeviceDirs(): string[];
  /** 拉取远端（fast-forward only）；返回后 `readRegistry` / `listDeviceDirs` 应反映最新远端。 */
  pull(): Promise<void>;
  /** 提交 `devices/registry.jsonl`（**只动这个文件**）并推送；被拒时 reject。 */
  commitRegistry(text: string, message: string): Promise<void>;
}

/** 一次抢占的入参。 */
export interface ClaimInput {
  /** 本机设置里现有的设备标识（可能是默认值 `phone-a`，也可能是老用户自己起的名字）。 */
  localDeviceId: string;
  /** 本机身份串（uuid，必须是 `normalizeUuid` 认可的形态）。 */
  uuid: string;
  /** 登记时刻（ISO 8601）。纯函数不读时钟。 */
  at: string;
  /** 排查用主机名（可空）。 */
  host?: string;
  /** 调用方是否**已经**拉取过（true = 循环前不再多拉一次）。 */
  pulled?: boolean;
  /** 最大尝试次数（默认 `MAX_CLAIM_ATTEMPTS`，夹到 1..10）。 */
  maxAttempts?: number;
}

/** 抢占成功。 */
export interface ClaimSuccess {
  ok: true;
  /** 最终使用的设备编号（目录名）。 */
  deviceId: string;
  /** 本机身份串。 */
  uuid: string;
  /** 实际用了几次尝试（1 = 一次就 push 成功）。 */
  attempts: number;
  /** true = 编号是自动分配的；false = 沿用了本机老标识。 */
  auto: boolean;
  /** true = 这次真的新写了一行 registry；false = registry 里已有本机 uuid 的行（复用）。 */
  registered: boolean;
}

/** 抢占失败（fail-closed：调用方不得继续写仓库）。 */
export interface ClaimFailure {
  ok: false;
  /** `E_DEVICE_ID_CONFLICT` | `E_DEVICE_ID_UNREADABLE`。 */
  code: string;
  message: string;
  attempts: number;
}

export type ClaimOutcome = ClaimSuccess | ClaimFailure;

function clampAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return MAX_CLAIM_ATTEMPTS;
  }
  const rounded: number = Math.floor(value);
  if (rounded < 1) {
    return 1;
  }
  return rounded > 10 ? 10 : rounded;
}

function readableReason(error: Object | null | undefined): string {
  if (error === null || error === undefined) {
    return '';
  }
  const message: string = textOf((error as Error).message);
  return message.length > 0 ? message : '';
}

/**
 * 抢占一个设备编号（**尽力而为一次，失败由调用方决定怎么报**）。
 *
 * 流程（与合约一致）：
 * 1. `pull()`（fast-forward）→ registry 与 `devices/` 目录名都是最新的；
 * 2. registry 里有本机 uuid 的行 → 直接用那一行的 `deviceId`（**不重复登记**）；
 * 3. 否则：老标识可沿用就沿用，否则 `nextDeviceId()`；追加一行 → 提交+推送（只动 registry.jsonl）；
 * 4. push 被拒（别人抢先）→ 重新拉取 → 重算 → 重试，最多 `maxAttempts` 次；
 * 5. 仍失败 → `{ ok:false, code:'E_DEVICE_ID_CONFLICT', message:'没能抢到设备编号，请稍后重试（已重试 5 次）' }`，
 *    **不**返回任何可用编号。
 */
export async function claimDeviceId(port: DeviceRegistryPort, input: ClaimInput): Promise<ClaimOutcome> {
  const uuid: string = normalizeUuid(input.uuid);
  const attemptsCap: number = clampAttempts(input.maxAttempts);
  if (uuid.length === 0) {
    const invalid: ClaimFailure = {
      ok: false,
      code: REGISTRY_UNREADABLE_CODE,
      message: '本机设备身份（uuid）不合法，无法登记设备编号：请清除后重试',
      attempts: 0
    };
    return invalid;
  }
  if (input.pulled !== true) {
    try {
      await port.pull();
    } catch (error) {
      const failed: ClaimFailure = {
        ok: false,
        code: REGISTRY_UNREADABLE_CODE,
        message: '读不到仓库里的设备登记表（拉取失败）：' + readableReason(error as Object),
        attempts: 0
      };
      return failed;
    }
  }
  let attempts: number = 0;
  while (attempts < attemptsCap) {
    attempts++;
    const parsed: RegistryParseResult = parseRegistry(port.readRegistry());
    const entries: RegistryEntry[] = parsed.entries;
    const known: string | null = findDeviceByUuid(entries, uuid);
    if (known !== null) {
      const reused: ClaimSuccess = {
        ok: true,
        deviceId: known,
        uuid: uuid,
        attempts: attempts,
        auto: isAutoDeviceId(known),
        registered: false
      };
      return reused;
    }
    const dirNames: string[] = port.listDeviceDirs();
    const knownIds: string[] = [];
    for (let index = 0; index < dirNames.length; index++) {
      knownIds.push(dirNames[index]);
    }
    for (let index = 0; index < entries.length; index++) {
      knownIds.push(entries[index].deviceId);
    }
    let candidate: string = '';
    let legacy: boolean = false;
    if (canReuseLocalDeviceId(input.localDeviceId, entries, dirNames, uuid)) {
      candidate = textOf(input.localDeviceId).toLowerCase();
      legacy = true;
    } else {
      candidate = nextDeviceId(knownIds);
    }
    // 候选号必须真的空闲（registry 里可能已有同名但不同 uuid 的行：换号，不要覆盖）
    let guard: number = 0;
    while (isDeviceIdTaken(entries, candidate, uuid) && guard < 64) {
      candidate = nextDeviceId(knownIds);
      knownIds.push(candidate);
      legacy = false;
      guard++;
    }
    const entry: RegistryEntry = { deviceId: candidate, uuid: uuid, at: textOf(input.at) };
    const host: string = textOf(input.host);
    if (host.length > 0) {
      entry.host = host;
    }
    const nextText: string = appendRegistryLine(port.readRegistry(), entry);
    try {
      await port.commitRegistry(nextText, '登记设备编号 ' + candidate);
    } catch (error) {
      if (attempts >= attemptsCap) {
        break;
      }
      // 被抢了：重新拉取，下一轮用最新的目录名与 registry 重算
      try {
        await port.pull();
      } catch (pullError) {
        const unreadable: ClaimFailure = {
          ok: false,
          code: REGISTRY_UNREADABLE_CODE,
          message: '抢设备编号时拉取失败：' + readableReason(pullError as Object),
          attempts: attempts
        };
        return unreadable;
      }
      continue;
    }
    const claimed: ClaimSuccess = {
      ok: true,
      deviceId: candidate,
      uuid: uuid,
      attempts: attempts,
      auto: !legacy,
      registered: true
    };
    return claimed;
  }
  const conflict: ClaimFailure = {
    ok: false,
    code: DEVICE_ID_CONFLICT_CODE,
    message: DEVICE_ID_CONFLICT_MESSAGE,
    attempts: attempts
  };
  return conflict;
}

/** 设置页展示用的一行：`本机：device-2（自动分配）` / `本机：phone-a（沿用原标识）`。 */
export function describeClaimOutcome(deviceId: string, auto: boolean): string {
  const id: string = textOf(deviceId);
  if (id.length === 0) {
    return '';
  }
  return '本机：' + id + '（' + (auto ? '自动分配' : '沿用原标识') + '）';
}
