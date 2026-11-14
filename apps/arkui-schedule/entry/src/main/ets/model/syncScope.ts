/**
 * 同步作用域（纯逻辑：不 import @ohos / UI，可在 Node 直接跑）。
 *
 * 契约：`docs/DATA-CONTRACT.md` §1/§6 —— **每台设备只写自己的目录**
 * `devices/<deviceId>/`，其它设备目录只读。本模块把「提交路径必须落在本设备目录内」
 * 这条不变量抽成可执行函数，`GitSyncService` 在 push 前调用它做断言。
 *
 * 关键点（常见越界写法）：
 * - `devices/pc-a-evil/...` 不属于 `pc-a`：前缀必须带结尾 `/`，不能用裸 `devices/pc-a` 比较；
 * - `devices/pc-a/../pc-b/...` 是目录穿越，即使最终落点也在 `devices/` 下也必须拒绝；
 * - 绝对路径（`/devices/...`、`C:\...`、UNC）一律拒绝；
 * - 反斜杠先归一成 `/`，再判断穿越，避免 `..\\pc-b` 绕过。
 */

/** 设备标识合法格式（与 `docs/DATA-CONTRACT.md` §1 一致）。 */
export const DEVICE_ID_PATTERN: RegExp = new RegExp('^[a-z0-9][a-z0-9-]{0,31}$');

/** 仓库里设备快照的根目录名。 */
export const DEVICES_DIR_NAME: string = 'devices';

/** Windows 盘符绝对路径（`C:` / `C:/...` / `C:\...`）。 */
const WINDOWS_DRIVE_RE: RegExp = /^[A-Za-z]:/;

/** 把任意值安全转成可展示文本（错误信息用）。 */
function describe(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/**
 * 规范化设备标识：去首尾空白 + 转小写后必须匹配 `^[a-z0-9][a-z0-9-]{0,31}$`。
 * 非法值直接抛错（**不静默回退**：提交路径的校验不允许猜测）。
 */
export function normalizeDeviceId(raw: string): string {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!DEVICE_ID_PATTERN.test(text)) {
    throw new Error(`设备标识不合法（需匹配 ^[a-z0-9][a-z0-9-]{0,31}$）：${describe(raw)}`);
  }
  return text;
}

/** 本设备目录的仓库相对前缀，固定以 `/` 结尾：`devices/<deviceId>/`。 */
export function devicePathPrefix(deviceId: string): string {
  return `${DEVICES_DIR_NAME}/${normalizeDeviceId(deviceId)}/`;
}

/**
 * 把仓库相对路径规范成 `/` 分隔、无 `./` 与重复斜杠的形式。
 * 非法路径（绝对路径、包含 `..` 穿越、空串）返回 `null`。
 */
export function normalizeRepoPath(path: string): string | null {
  if (typeof path !== 'string') {
    return null;
  }
  const text: string = path.trim().replace(/\\/g, '/');
  if (text.length === 0) {
    return null;
  }
  // 绝对路径：POSIX 根、UNC、Windows 盘符
  if (text.startsWith('/') || WINDOWS_DRIVE_RE.test(text)) {
    return null;
  }
  const segments: string[] = [];
  const parts: string[] = text.split('/');
  for (let index = 0; index < parts.length; index++) {
    const segment: string = parts[index];
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      // 目录穿越：即便最终仍落在 devices/ 下也拒绝（不给 path.resolve 语义留口子）
      return null;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    return null;
  }
  return segments.join('/');
}

/** 规范化后的路径是否落在 `prefix` 内（`devices/<id>` 目录本身也算）。 */
function isWithinPrefix(normalizedPath: string, prefix: string): boolean {
  const dir: string = prefix.slice(0, prefix.length - 1);
  if (normalizedPath === dir) {
    return true;
  }
  return normalizedPath.startsWith(prefix);
}

/**
 * 过滤待提交路径：只保留落在 `devices/<deviceId>/` 内的路径，保持输入顺序。
 * 输出为规范化后的 `/` 分隔相对路径；越界/非法路径被丢弃（断言入口见 `assertWithinDevice`）。
 */
export function filterPathsForDevice(paths: string[], deviceId: string): string[] {
  const prefix: string = devicePathPrefix(deviceId);
  const kept: string[] = [];
  if (!Array.isArray(paths)) {
    return kept;
  }
  for (let index = 0; index < paths.length; index++) {
    const normalized: string | null = normalizeRepoPath(paths[index]);
    if (normalized !== null && isWithinPrefix(normalized, prefix)) {
      kept.push(normalized);
    }
  }
  return kept;
}

/**
 * 断言路径落在 `devices/<deviceId>/` 内；越界或非法（绝对路径 / `..` 穿越 / 空串）抛 `Error`。
 * 供 `GitSyncService.push()` 在提交前做 fail-closed 校验。
 */
export function assertWithinDevice(path: string, deviceId: string): void {
  const prefix: string = devicePathPrefix(deviceId);
  const normalized: string | null = normalizeRepoPath(path);
  if (normalized === null) {
    throw new Error(`提交路径非法（不允许绝对路径或 ../ 目录穿越）：${describe(path)}（允许范围：${prefix}）`);
  }
  if (!isWithinPrefix(normalized, prefix)) {
    throw new Error(`提交路径越界：${describe(path)} 不在 ${prefix} 内`);
  }
}
