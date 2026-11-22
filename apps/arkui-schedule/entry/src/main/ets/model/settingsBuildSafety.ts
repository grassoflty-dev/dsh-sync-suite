/**
 * 设置页「同步仓库」构建期文件系统安全（mod-crash-settings-sync）。
 *
 * 背景：真机 `设置 → 同步仓库` 首开必杀进程。栈底是 `GitSyncService.readdir()` 里的
 * `fs.listFileSync()` 抛 `13900018 (ENOTDIR)`，调用点落在 `SettingsSync.build()` 的组件构造上。
 * ArkUI 在 build / aboutToAppear 期间不允许异常外泄——一个「目录不存在 / 路径被文件挡住」
 * 的磁盘事实会直接升级成 fatal Js Error 并杀进程。
 *
 * 本模块是**零 SDK 依赖的纯层**，把两层契约都做成可执行函数：
 *
 * 1. UI / 构建层：`safeList()` 永远不 throw。ENOENT / ENOTDIR = 良性「没有 issue 可报」；
 *    EACCES / I/O = typed warning（照实报，不吞成「没问题」）。
 * 2. 桥 / isomorphic-git 层：`bridgeFailureEnvelope()` 生成一个 typed 失败信封，
 *    WebView 侧的 fs adapter 据此把失败变成**带 ENOENT code 的 rejected promise**。
 *    绝不能给 git 返回 `[]`——那等于谎报「目录存在但为空」，会把 unborn `.git`
 *    伪装成空仓库，是比闪退更隐蔽的数据错误。
 *
 * 生产缝在 `services/GitSyncService.ets`（真 `fs.listFileSync` + hilog 一次性日志），
 * 测试缝在 `tools/test/settingsBuildSafety.test.mjs`（逐码注入 ENOTDIR / ENOENT / EACCES）。
 */

/** 目录列举的 typed 结果：失败也是一等公民，调用方不需要 try/catch。 */
export interface FsListResult {
  /** 列举是否成功；false 时 names 必为空数组。 */
  ok: boolean;
  /** 文件名列表；失败恒为 []。 */
  names: string[];
  /** 空串 = 成功；否则 ENOTDIR / ENOENT / EACCES / E_<数字> / E_FS_UNKNOWN。 */
  code: string;
  /** 被列举的路径（原样，便于日志与排障）。 */
  path: string;
}

/** 可注入的目录列举缝：生产是 `fs.listFileSync`，测试可注入会抛的假实现。 */
export type ListNames = (path: string) => string[];

/** 可注入的日志缝：生产接到 `common/fsSafetyLog.ets`（hilog，只含 path + code）。 */
export type FsLog = (path: string, code: string) => void;

export const FS_OK: string = '';
export const FS_UNKNOWN: string = 'E_FS_UNKNOWN';
export const FS_ENOTDIR: string = 'ENOTDIR';
export const FS_ENOENT: string = 'ENOENT';
export const FS_EACCES: string = 'EACCES';

/** 桥失败信封的判别键（WebView fs adapter 靠它把成功/失败分开）。 */
export const FS_FAILURE_MARKER: string = '__fsFailure';

/** HarmonyOS errno 数值：13900018 = ENOTDIR（真机栈里的 code），13900002 = ENOENT。 */
const HARMONY_ENOTDIR: number = 13900018;
const HARMONY_ENOENT: number = 13900002;
const HARMONY_EACCES: number = 13900001;

/**
 * 把任意 thrown 值归一成稳定的 typed code。
 * 同时认 HarmonyOS 数值 errno、标准 name、以及英文 message——任一命中即可，
 * 避免某个运行时只给其中一种而漏判。
 */
export function fsErrorCode(error: unknown): string {
  if (error === null || error === undefined) {
    return FS_UNKNOWN;
  }
  if (typeof error === 'string') {
    return error.length > 0 ? error : FS_UNKNOWN;
  }
  if (typeof error !== 'object') {
    return FS_UNKNOWN;
  }
  const value: { code?: unknown; name?: unknown; message?: unknown } =
    error as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof value.code === 'string' && value.code.length > 0) {
    return value.code;
  }
  if (typeof value.code === 'number') {
    if (value.code === HARMONY_ENOTDIR) {
      return FS_ENOTDIR;
    }
    if (value.code === HARMONY_ENOENT) {
      return FS_ENOENT;
    }
    if (value.code === HARMONY_EACCES) {
      return FS_EACCES;
    }
    return 'E_' + value.code.toString();
  }
  if (typeof value.name === 'string' && value.name.length > 0) {
    return value.name;
  }
  if (typeof value.message === 'string') {
    const text: string = value.message.toLowerCase();
    if (text.indexOf('not a directory') >= 0) {
      return FS_ENOTDIR;
    }
    if (text.indexOf('no such file') >= 0 || text.indexOf('does not exist') >= 0) {
      return FS_ENOENT;
    }
    if (text.indexOf('permission denied') >= 0 || text.indexOf('eacces') >= 0) {
      return FS_EACCES;
    }
  }
  return FS_UNKNOWN;
}

/**
 * UI 侧唯一允许的目录列举：永不 throw。
 *
 * 成功：全部字符串文件名（`ok=true`）。
 * 失败：`ok=false, names=[]`，且**恰好调一次**日志缝（path + code，不打印内容）。
 */
export function safeList(path: string, list: ListNames, log?: FsLog): FsListResult {
  try {
    const raw: unknown = list(path);
    if (Array.isArray(raw)) {
      const names: string[] = [];
      for (let index = 0; index < raw.length; index++) {
        const entry: unknown = raw[index];
        if (typeof entry === 'string') {
          names.push(entry);
        }
      }
      return { ok: true, names: names, code: FS_OK, path: path };
    }
    // 宿主返回了非数组：同等对待为 typed 失败，绝不在 build 路径上抛。
    if (log !== undefined) {
      log(path, FS_UNKNOWN);
    }
    return { ok: false, names: [], code: FS_UNKNOWN, path: path };
  } catch (error) {
    const code: string = fsErrorCode(error);
    if (log !== undefined) {
      log(path, code);
    }
    return { ok: false, names: [], code: code, path: path };
  }
}

/** 任意同步 fs 调用的 typed 包装（stat / mkdirp 等非列举操作共用）。 */
export interface FsCallResult<T> {
  ok: boolean;
  value: T | null;
  code: string;
  path: string;
}

/** 把一次可能抛的 fs 调用包成 typed 结果；失败恰好记一次日志，绝不外泄异常。 */
export function safeCall<T>(path: string, call: () => T, log?: FsLog): FsCallResult<T> {
  try {
    const value: T = call();
    return { ok: true, value: value, code: FS_OK, path: path };
  } catch (error) {
    const code: string = fsErrorCode(error);
    if (log !== undefined) {
      log(path, code);
    }
    return { ok: false, value: null, code: code, path: path };
  }
}

/** 只有「路不存在 / 被文件挡住」是良性的；权限与 I/O 失败必须照实报。 */
export function isBenignFsCode(code: string): boolean {
  return code === FS_ENOTDIR || code === FS_ENOENT;
}

/**
 * 目录扫描结果 → issue 文案（UI 侧）。
 *
 * - 成功且非空：`whenPresent` 由调用方给出（当前设置页没有这类基于内容的横幅，传空串即可）；
 * - ENOENT / ENOTDIR：[]——「没有 issue 可报」，不是错误态；
 * - EACCES / 其它 I/O：一条 typed warning，路径与 code 都在，绝不静默吞。
 */
export function issuesFromList(result: FsListResult, whenPresent: string): string[] {
  if (result.ok) {
    return result.names.length > 0 && whenPresent.length > 0 ? [whenPresent] : [];
  }
  if (isBenignFsCode(result.code)) {
    return [];
  }
  return ['目录读取失败（' + result.code + '）：' + result.path];
}

/** 一次扫描多个路径：失败不中断，结果逐条保留 typed code。 */
export function collectBuildIssues(
  paths: string[],
  list: ListNames,
  log?: FsLog
): { issues: string[]; results: FsListResult[] } {
  const issues: string[] = [];
  const results: FsListResult[] = [];
  for (let index = 0; index < paths.length; index++) {
    const path: string = paths[index];
    if (path.length === 0) {
      continue;
    }
    const result: FsListResult = safeList(path, list, log);
    results.push(result);
    const found: string[] = issuesFromList(result, path);
    for (let item = 0; item < found.length; item++) {
      issues.push(found[item]);
    }
  }
  return { issues: issues, results: results };
}

/**
 * 桥侧 code 映射：git 期望「目录不存在」统一表达为 ENOENT。
 * ENOTDIR 在此映射为 ENOENT——对 isomorphic-git 来说路径就是不存在；
 * 但 UI 侧仍保留 ENOTDIR 原码用于 log / 排障。
 */
export function bridgeFsCode(code: string): string {
  if (isBenignFsCode(code)) {
    return FS_ENOENT;
  }
  return code.length > 0 ? code : FS_UNKNOWN;
}

/**
 * 桥侧失败信封（JSON 字符串）：`readdir`/`stat` 失败时返回它，
 * WebView fs adapter 检测 `FS_FAILURE_MARKER` 并在 Promise 链里抛带 code 的 Error。
 * 这样 git 收到的是 rejected promise，而不是「空目录」或跨代理的同步 throw。
 */
export function bridgeFailureEnvelope(result: FsListResult): string {
  const envelope: { __fsFailure: boolean; code: string; path: string } = {
    __fsFailure: true,
    code: bridgeFsCode(result.code),
    path: result.path
  };
  return JSON.stringify(envelope);
}
