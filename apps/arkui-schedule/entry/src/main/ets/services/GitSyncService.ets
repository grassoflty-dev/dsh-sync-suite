/**
 * GitSyncService — ArkUI-X DSH-Dots的 Git 同步服务（ArkTS 侧）
 * ============================================================================
 * 结构：
 *   `Web` 组件加载 `rawfile/git/index.html`（内含 isomorphic-git 1.25.3 + git-bridge.js），
 *   本服务通过 `registerJavaScriptProxy` 把幕后的文件系统（同步）与 HTTP（异步）能力暴露给
 *   桥脚本，桥脚本在 Web 内跑真实的 git 逻辑，结果通过 `dshGitHost.onEvent(json)` 回传。
 *
 * 与桥的协议（详见 `rawfile/git/git-bridge.js` 头部注释，两侧必须一致）：
 *   - 发起：`window.DshGitBridge.call(JSON.stringify({ id, op, args }))`，无返回值；
 *     op ∈ init | clone | fetch | pull | push | status | log | currentBranch | resolveRef
 *   - 结果：`dshGitHost.onEvent(JSON.stringify({ id, ok: true, data }))`
 *            `dshGitHost.onEvent(JSON.stringify({ id, ok: false, error: { code, message } }))`
 *   - HTTP：桥调用 `dshGitHost.httpRequest(id, optionsJson)`，本服务用 `@ohos.net.http` 发请求，
 *     完成后执行 `controller.runJavaScript("window.DshGitBridge.onHttpResult(<json>)")`。
 *   - 文件：`readFileBase64/writeFileBase64/fileExists/mkdirp/readdir/stat/unlink/rename/getRepoRoot`
 *     都是**同步**方法（JS 侧同步取回返回值），路径统一使用 `/` 分隔。
 *
 * 范围约束（与 docs/DATA-CONTRACT.md §6 一致）：本机只写 `devices/<deviceId>/`；
 * 其它设备目录只读；`pull` 固定 fast-forward，永不 merge。
 *
 * 目录：仓库工作副本固定为 `<filesDir>/git-repo`。
 * 说明：`getRepoRoot()` 依赖应用文件目录。优先使用 `GitSyncService.setFilesDir()` 预置的值
 *      （设置页在 bootstrap 时已调用），未预置时才回落到 `getContext().filesDir`。
 * ============================================================================
 */
import { webview } from '@kit.ArkWeb';
import { fileIo as fs } from '@kit.CoreFileKit';
import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { checkSyncPrecondition, describeBridgeFailure } from '../model/syncGuard';
import { assertHttpsUsername, describeAuthModeBlocker, httpsAuthUsername, resolveGitUsername } from '../model/gitAuth';
import { AUTH_HTTPS } from '../model/settingsForm';
import {
  DEFAULT_BRANCH,
  describeSyncStatus,
  validateBranchName
} from '../model/syncError';
import type { SyncStatusView } from '../model/syncError';
import type { SyncPreconditionInput, SyncPreconditionResult } from '../model/syncGuard';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  assertWithinDevice,
  devicePathPrefix,
  filterPathsForDevice,
  normalizeDeviceId
} from '../model/syncScope';
import {
  checkDeviceIdentity,
  describeAttachmentPushBlock,
  describeIdentityConflict,
  deviceFingerprintPath,
  fingerprintFileText,
  normalizeFingerprint,
  resolveIdentity,
  shouldBlockAttachmentPush
} from '../model/deviceIdentity';
import type {
  AttachmentPushDecision,
  IdentityCheck,
  IdentityConflictKind,
  IdentityResolution
} from '../model/deviceIdentity';
import {
  DEVICES_DIR,
  REGISTRY_PATH,
  claimDeviceId,
  describeClaimOutcome,
  parseRegistry
} from '../model/deviceRegistry';
import type { ClaimFailure, ClaimOutcome, DeviceRegistryPort, RegistryEntry, RegistryParseResult } from '../model/deviceRegistry';
import { sha256Hex } from '../model/sha256';
import { settingsStore } from './settingsStore';

// ---------------------------------------------------------------- 对外接口

export interface GitSyncConfig {
  /** HTTPS 仓库地址（GitHub/Gitee/GitLab/自建），不支持 SSH */
  repoUrl: string;
  /** 分支名，默认 main；可配（A2） */
  branch: string;
  /** 设备标识，匹配 ^[a-z0-9][a-z0-9-]{0,31}$，决定 devices/<deviceId>/ 目录 */
  deviceId: string;
  /** Personal Access Token（只用于 HTTPS Basic 认证，不落盘、不进日志） */
  token: string;
  /** 提交作者名 */
  authorName: string;
  /** 提交作者邮箱 */
  authorEmail: string;
  /** 托管平台：`github` | `gitee` | `gitlab` | `custom`（决定 HTTPS 用户名兜底规则）。旧数据可缺省。 */
  platform?: string;
  /** HTTPS 认证用户名（Gitee 必填 = 登录名）；空串表示未填写。旧数据可缺省。 */
  gitUsername?: string;
  /** 认证方式：`https`（本版本唯一可用）| `ssh`（会被拦，见 `describeAuthModeBlocker`）。旧数据可缺省。 */
  authMode?: string;
}

export interface GitSyncResult {
  ok: boolean;
  /** 面向用户的中文结果或错误说明 */
  message: string;
  /** 成功且产生了提交/HEAD 时给出 commit sha */
  commit?: string;
  /**
   * 失败时的机器可读错误码，供 `model/syncError.ts` 分级：
   * `E_AUTH` | `E_HTTP` | `E_GIT` | `E_FS`（来自桥）或 `E_INPUT`（本服务的配置/范围预检）。
   * 成功时为空。
   */
  code?: string;
  /** 本次操作涉及的分支（成功时给出，供页面展示）。 */
  branch?: string;
  /** 本地独有提交数（仅 status 返回）。 */
  ahead?: number;
  /** 远端独有提交数（仅 status 返回）。 */
  behind?: number;
  /** 冲突条目数（仅 status 返回；应用不 merge，正常为 0）。 */
  conflicts?: number;
  /** 本地与远端是否双向分叉（仅 status 返回）。 */
  diverged?: boolean;
  /** 工作区改动数（仅 status 返回）。 */
  changedCount?: number;
  /** 本机仓库是否已初始化（仅 status 返回）。 */
  initialized?: boolean;
  /** 远端是否已配置（仅 status 返回）。 */
  remoteConfigured?: boolean;
  /**
   * 设备身份冲突（两种，见 `model/deviceIdentity.ts#resolveIdentity`）：
   * 两台设备撞号 / 本机指纹被另一台设备覆盖。
   *
   * true 时设置页要显示**常驻**警告（warning 档），而不是一闪而过的 toast；
   * 文案见 `identityWarning`（逐字文案，含设备标识）。
   */
  identityConflict?: boolean;
  /** 身份冲突的中文说明（`identityConflict === true` 时给出）。 */
  identityWarning?: string;
  /**
   * true = 本机 `.device-fingerprint` 读不到，本次按「新设备」重新生成了 uuid。
   *
   * 这种情况下会**另抢一个设备编号**（旧目录不动），因此要让用户知道身份换了。
   */
  fingerprintRecreated?: boolean;
  /** 本次因「附件可能被别的设备改过」而暂停推送的附件个数（不影响其它文件）。 */
  attachmentsBlocked?: number;
  /** 附件被暂停推送的中文原因（`attachmentsBlocked > 0` 时给出）。 */
  attachmentWarning?: string;
  /**
   * 本次生效的设备编号（自动分配或沿用老标识）。
   *
   * 设置页拿到后回填只读的一行「本机：device-2（自动分配）」，不要求用户手填。
   */
  deviceId?: string;
  /** 设备编号是否由仓库自动分配（true = 自动分配；false = 沿用原标识）。 */
  deviceIdAuto?: boolean;
  /** 设备编号的展示文案（`describeClaimOutcome` 的产物，空串 = 不展示）。 */
  deviceIdNotice?: string;
  /**
   * 设备编号登记失败的中文原因（空串 = 成功）。
   *
   * 非空时设置页要把「高级」自动展开并显示这一行；**推送**不会继续（fail-closed）。
   */
  deviceRegistrationError?: string;
}

/**
 * 本机身份读取结果（`GitSyncService.loadLocalIdentity`）。
 *
 * `uuid` 是**一个**身份串：`.device-fingerprint` 的内容、settings 的 `deviceUuid`/`deviceFingerprint`、
 * registry 里的 `uuid` 三者必须是同一个值。
 */
interface LocalIdentity {
  /** 归一后的 uuid（空串 = 读不到，需要走 `recreate`）。 */
  uuid: string;
  /** true = 指纹文件与设置都没有，本次按「新设备」处理。 */
  recreated: boolean;
  /** 来源，仅用于排查：`cache` | `repo` | `settings` | `missing`。 */
  source: string;
}

// ---------------------------------------------------------------- 桥协议类型

interface BridgeEventError {
  code?: string;
  message?: string;
}

interface BridgeEvent {
  id?: string;
  ok?: boolean;
  data?: Object;
  error?: BridgeEventError;
}

interface BridgeCallRequest {
  id: string;
  op: string;
  args: Record<string, string>;
}

interface BridgeHttpOptions {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
}

interface BridgeHttpResult {
  id: string;
  url: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  bodyBase64: string;
  error?: BridgeEventError;
}

interface PendingRequest {
  resolve: (event: BridgeEvent) => void;
  reject: (error: Object) => void;
  timer: number;
}

/** 写入 zip 的一个条目（`data` 由调用方分块成 base64，每块 ≤256KB 文本）。 */
export interface ZipEntryInput {
  name: string;
  chunks: string[];
}

/** zip 条目信息（`size` 是解压后字节数）。 */
export interface ZipEntryInfo {
  name: string;
  size: number;
}

/** `zipUpsert` 的返回。 */
export interface ZipUpsertResult {
  archivePath: string;
  bytes: number;
  entries: ZipEntryInfo[];
}

/** 桥调用的请求形状（显式接口：ArkTS 禁止内联对象类型）。 */
interface ZipUpsertRequest {
  archivePath: string;
  entries: ZipEntryInput[];
}

interface ZipListRequest {
  archivePath: string;
}

interface ZipReadRequest {
  archivePath: string;
  entryName: string;
}

interface ZipListPayload {
  archivePath: string;
  entries: ZipEntryInfo[];
}

interface ZipReadPayload {
  name: string;
  size: number;
  chunks: string[];
}

interface StatPayload {
  mode: number;
  size: number;
  mtimeMs: number;
  type: string;
}

interface CommitPayload {
  sha?: string;
  message?: string;
  time?: string;
}

interface PreservePayload {
  restored?: string[];
  unioned?: string[];
  kept?: string[];
}

interface StatusPayload {
  initialized?: boolean;
  /** 桥用 null 表示「没有值」（未初始化/空仓库），读取时必须过 `textOf`。 */
  branch?: string | null;
  head?: string | null;
  remoteUrl?: string | null;
  repoRoot?: string | null;
  changedCount?: number | null;
  lastCommit?: CommitPayload | null;
  /** 目标分支（配置里的分支名，可能是本地还没建出来的）。 */
  targetBranch?: string | null;
  localBranchExists?: boolean;
  remoteBranchExists?: boolean;
  localBranchOid?: string | null;
  remoteBranchOid?: string | null;
  /** 本地独有提交数（A2）。 */
  ahead?: number | null;
  /** 远端独有提交数（A2）。 */
  behind?: number | null;
  diverged?: boolean;
  comparable?: boolean;
  /** 冲突条目数（A2；应用不 merge，正常为 0）。 */
  conflicts?: number | null;
}

interface PullPayload {
  cloned?: boolean;
  branch?: string | null;
  head?: string | null;
  previousHead?: string | null;
  fastForward?: boolean;
  alreadyUpToDate?: boolean;
  url?: string | null;
  localPreserved?: PreservePayload;
}

interface PushPayload {
  branch?: string | null;
  deviceId?: string | null;
  files?: number | null;
  /** 没有新改动可提交时桥返回 null。 */
  commit?: string | null;
  pushed?: boolean;
  message?: string | null;
  /** 本次推送是否在远端**新建**了分支（A2：首次推送自动建分支）。 */
  branchCreated?: boolean;
  /** 本次是否在本地新建了分支引用（空仓库 / 换了新分支名）。 */
  branchCreatedLocal?: boolean;
  /** 实际推送的 refspec（`refs/heads/<branch>`）。 */
  refspec?: string | null;
  /** 推送是否带 force（恒为 false；仅用于断言）。 */
  force?: boolean;
}

interface RemoteProbe {
  reachable: boolean;
  statusCode: number;
  detail: string;
}

/**
 * 附件基线文档（本机状态文件 `<filesDir>/sync-baseline.json`，**不在 git 仓库里**）。
 *
 * 记录「上次同步/推送后看到的附件 zip sha」：push 前用它判断远端 zip 是否被别人改过
 * （判定在纯函数 `shouldBlockAttachmentPush`，见 `model/deviceIdentity.ts`）。
 */
interface AttachmentBaselineDoc {
  /** 基线所属设备标识（换了设备标识则整份基线作废，避免拿 A 的基线去判 B 的附件）。 */
  deviceId: string;
  /** 仓库相对路径（`devices/<id>/attachments/<date>.zip`）→ sha256。 */
  files: Record<string, string>;
}

/** 一个被临时挪出仓库的附件（防止被本次提交覆盖）。 */
interface QuarantinedFile {
  from: string;
  to: string;
}

/** push 前附件守卫的结果。 */
interface PushAttachmentGuard {
  /** 被暂停推送（临时挪走）的附件个数。 */
  blocked: number;
  /** 第一条中文原因（空串 = 没有拦截）。 */
  reason: string;
  /** 非空 = 连「挪走」都失败 → 整次推送失败（fail-closed，绝不冒险覆盖）。 */
  failure: string;
  /** 挪走的文件（推送结束后必须在 finally 里放回）。 */
  moved: QuarantinedFile[];
}

// ---------------------------------------------------------------- 常量

const REQUEST_TIMEOUT_MS: number = 60000;
const HTTP_CONNECT_TIMEOUT_MS: number = 15000;
const HTTP_READ_TIMEOUT_MS: number = 45000;
const REPO_DIR_NAME: string = 'git-repo';
/** 附件基线文件名（本机 filesDir 下，不进仓库）。 */
const BASELINE_FILE_NAME: string = 'sync-baseline.json';
/** 被暂停推送的附件的临时隔离目录（本机 filesDir 下，不进仓库）。 */
const QUARANTINE_DIR_NAME: string = 'sync-quarantine';
const BRIDGE_PROXY_NAME: string = 'dshGitHost';
const DEVICE_ID_PATTERN: string = '^[a-z0-9][a-z0-9-]{0,31}$';
/** 0o100644：普通文件 */
const MODE_FILE: number = 33188;
/** 0o040000：目录 */
const MODE_DIR: number = 16384;

const EMPTY_HEADERS: Record<string, string> = {};

// ---------------------------------------------------------------- 错误

/** 携带桥错误码（E_GIT | E_HTTP | E_AUTH | E_FS）的异常。 */
class SyncError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function messageOf(error: Object): string {
  if (error instanceof Error) {
    return error.message;
  }
  return '未知错误';
}

function failed(prefix: string, error: Object): GitSyncResult {
  const result: GitSyncResult = { ok: false, message: prefix + '：' + messageOf(error) };
  if (error instanceof SyncError) {
    result.code = error.code;
  }
  return result;
}

/** 预检失败（配置/范围/未就绪）：统一标 `E_INPUT`，设置页据此显示「配置不完整」。 */
function rejected(prefix: string, problem: string): GitSyncResult {
  const result: GitSyncResult = { ok: false, message: prefix + '：' + problem, code: 'E_INPUT' };
  return result;
}

function shortSha(sha: string): string {
  if (sha.length === 0) {
    return '（空仓库）';
  }
  return sha.length > 7 ? sha.substring(0, 7) : sha;
}

function normalizePath(path: string): string {
  let text: string = path.replace(/\\/g, '/');
  while (text.indexOf('//') >= 0) {
    text = text.replace('//', '/');
  }
  if (text.length > 1 && text.charAt(text.length - 1) === '/') {
    text = text.substring(0, text.length - 1);
  }
  return text;
}

function dirnameOf(path: string): string {
  const index: number = path.lastIndexOf('/');
  if (index < 0) {
    return '';
  }
  if (index === 0) {
    return '/';
  }
  return path.substring(0, index);
}

function mapHttpMethod(method: string): http.RequestMethod {
  const upper: string = method.toUpperCase();
  if (upper === 'POST') {
    return http.RequestMethod.POST;
  }
  if (upper === 'PUT') {
    return http.RequestMethod.PUT;
  }
  if (upper === 'DELETE') {
    return http.RequestMethod.DELETE;
  }
  if (upper === 'HEAD') {
    return http.RequestMethod.HEAD;
  }
  if (upper === 'OPTIONS') {
    return http.RequestMethod.OPTIONS;
  }
  return http.RequestMethod.GET;
}

function statusTextOf(code: number): string {
  if (code === 200) {
    return 'OK';
  }
  if (code === 201) {
    return 'Created';
  }
  if (code === 204) {
    return 'No Content';
  }
  if (code === 301) {
    return 'Moved Permanently';
  }
  if (code === 302) {
    return 'Found';
  }
  if (code === 304) {
    return 'Not Modified';
  }
  if (code === 400) {
    return 'Bad Request';
  }
  if (code === 401) {
    return 'Unauthorized';
  }
  if (code === 403) {
    return 'Forbidden';
  }
  if (code === 404) {
    return 'Not Found';
  }
  if (code === 409) {
    return 'Conflict';
  }
  if (code === 422) {
    return 'Unprocessable Entity';
  }
  if (code === 500) {
    return 'Internal Server Error';
  }
  if (code === 502) {
    return 'Bad Gateway';
  }
  if (code === 503) {
    return 'Service Unavailable';
  }
  return '';
}

// ---------------------------------------------------------------- 服务

export class GitSyncService {
  /**
   * 暴露给 Web 的代理方法名（顺序与 `registerJavaScriptProxy` 的 methodList 一致）。
   * 与 `git-bridge.js` 中调用 `dshGitHost.*` 的位置一一对应。
   */
  static readonly proxyMethodList: string[] = [
    'onEvent',
    'onHttpResult',
    'readFileBase64',
    'writeFileBase64',
    'fileExists',
    'mkdirp',
    'readdir',
    'stat',
    'unlink',
    'rename',
    'getRepoRoot',
    'httpRequest'
  ];

  /** 应用文件目录（建议设置页/EntryAbility 启动时设置；未设置时回落到 getContext().filesDir）。 */
  private static filesDirOverride: string = '';
  private static base64Helper: util.Base64Helper | null = null;

  private controller: webview.WebviewController;
  private config: GitSyncConfig = {
    repoUrl: '',
    branch: 'main',
    deviceId: '',
    token: '',
    authorName: 'DSH-Dots',
    authorEmail: 'schedule@localhost'
  };
  private pending: Map<string, PendingRequest> = new Map<string, PendingRequest>();
  private requestSeq: number = 0;
  private ready: boolean = false;
  /** 桥（WebView 内核）是否真的可用：注册成功 + 页面加载完成（闪退回归：未就绪必须先拦住）。 */
  private bridgeReady: boolean = false;
  /** 桥不可用的原因（空串表示没有失败）。 */
  private bridgeError: string = '';
  /** 本机设备指纹缓存（= 统一后的身份 uuid；空串 = 还没解析/生成）。 */
  private fingerprintCache: string = '';
  /** 最近一次身份比对的结论文案（空串 = 正常；非空 = 撞号 / 指纹被覆盖）。 */
  private identityNotice: string = '';
  /** 最近一次身份比对是否冲突（与 `identityNotice` 成对）。 */
  private identityConflict: boolean = false;
  /**
   * 本会话已确认过的冲突种类（`none` = 没有）。
   *
   * 为什么不每次重算：`fingerprint-overwritten` 在解决之后（本机换到新编号目录）证据会消失，
   * 而设置页要的是**常驻**横幅——用户得有机会看到「我的指纹被别人覆盖过」。
   * 重启后按最新证据重算（不同步恢复，避免历史噪音永久粘住）。
   */
  private identityStickyConflict: IdentityConflictKind = 'none';
  /**
   * 本会话里发生过「指纹丢失」（仓库里本机目录还在、uuid 读不到）。
   *
   * 单独记一个标记的原因：`applyIdentityCheck` 可能先把新 uuid 生成并落盘，等
   * `registerDevice` 再解析时已经「读得到」了，于是 `recreate` 这一态就看不到了——
   * 但用户仍然需要知道「这台设备换了新身份」。
   */
  private identityRecreated: boolean = false;

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
    // 自注册：附件按天 zip 需要桥能力，但鸿蒙只允许页面里创建 Web 控制器，
    // 所以 unify 到「最后创建的那个实例」，供 attachmentStore 取用（未打开设置页时为 null）。
    GitSyncService.activeService = this;
  }

  /** 当前可用的同步服务（没有则 null：附件走本地散图，zip 能力不可用）。 */
  static active(): GitSyncService | null {
    return GitSyncService.activeService;
  }

  /** base64 编码（供 attachmentStore 把 JPEG 分块传给桥）。 */
  static encodeBase64(bytes: Uint8Array): string {
    return GitSyncService.base64().encodeToStringSync(bytes);
  }

  private static activeService: GitSyncService | null = null;

  /** 预置应用文件目录（设置页在 bootstrap 时用 `context.filesDir` 调用）。 */
  static setFilesDir(filesDir: string): void {
    GitSyncService.filesDirOverride = normalizePath(filesDir);
  }

  private static base64(): util.Base64Helper {
    if (GitSyncService.base64Helper === null) {
      GitSyncService.base64Helper = new util.Base64Helper();
    }
    return GitSyncService.base64Helper as util.Base64Helper;
  }

  // -------------------------------------------------------------- 生命周期

  /**
   * 注册 JS 代理并刷新页面。**必须在 Web 页面 onPageEnd 之后调用**，
   * 否则页面里的 `window.dshGitHost` 不存在，桥会报 E_FS「宿主代理未注册」。
   * 注意：内部会 `controller.refresh()`，因此 onPageEnd 会再次触发；
   * 调用方用 `isReady()` 做幂等保护即可（设置页已这样处理）。
   */
  /**
   * 注册 JavaScript 代理并刷新页面。
   *
   * **闪退回归点**：`registerJavaScriptProxy` / `refresh` 在控制器尚未绑定到任何 `Web`
   * 组件时会抛 `BusinessError`（17100001 等）。历史上这条异常一路上抛到 UI 线程，
   * 把进程带走。现在整段包 try/catch，失败只把桥标记为「未就绪 + 原因」。
   */
  registerProxy(): void {
    try {
      this.controller.registerJavaScriptProxy(this, BRIDGE_PROXY_NAME, GitSyncService.proxyMethodList);
      this.controller.refresh();
      this.ready = true;
      this.bridgeReady = true;
      this.bridgeError = '';
    } catch (error) {
      this.ready = false;
      this.bridgeReady = false;
      this.bridgeError = `同步内核注册失败：${describeBridgeFailure(error as Object)}`;
    }
  }

  /** Web 页面是否已完成代理注册（未就绪时所有操作会直接返回中文错误）。 */
  isReady(): boolean {
    return this.ready;
  }

  configure(config: GitSyncConfig): void {
    this.config = config;
  }

  getConfig(): GitSyncConfig {
    return this.config;
  }

  // -------------------------------------------------------------- 附件按天 zip（JSZip 在桥里）

  /**
   * 把若干条目写进（或合并进）一个 zip：`zipUpsert(archivePath, entries)`。
   *
   * 桥里用 JSZip（两端 WebView 都有），本方法只负责分块 base64 与错误归一。
   */
  async zipUpsert(archivePath: string, entries: ZipEntryInput[]): Promise<ZipUpsertResult> {
    const payload: ZipUpsertRequest = { archivePath: archivePath, entries: entries };
    const data: ZipUpsertResult = await this.callBridgeJson<ZipUpsertResult>('zipUpsert', payload);
    // 本机刚写出的版本就是「基线」：push 前据此判断远端这个 zip 后来有没有被别人改过
    this.rememberAttachmentBaseline(archivePath);
    return data;
  }

  /**
   * 把本机刚写出的附件 zip 记成基线（只认仓库内 `devices/<id>/attachments/` 下的路径）。
   *
   * 不记的话，「本地新建的附件」会因为没有基线被 fail-closed 拒推（永远推不上去）。
   */
  private rememberAttachmentBaseline(archivePath: string): void {
    try {
      const deviceId: string = normalizeDeviceId(this.config.deviceId);
      const root: string = normalizePath(this.getRepoRoot());
      const path: string = normalizePath(archivePath);
      const prefix: string = root + '/' + devicePathPrefix(deviceId) + 'attachments/';
      if (path.indexOf(prefix) !== 0) {
        return;
      }
      const relPath: string = devicePathPrefix(deviceId) + 'attachments/' + path.substring(prefix.length);
      this.recordBaselineEntry(relPath, this.sha256OfFile(path));
    } catch (error) {
      // 设备标识非法 / 路径不在本设备目录：不记基线（下次推送按 fail-closed 处理）
    }
  }

  /** 列出 zip 条目（包不存在 → 空数组）。 */
  async zipList(archivePath: string): Promise<ZipEntryInfo[]> {
    const payload: ZipListRequest = { archivePath: archivePath };
    const data: ZipListPayload = await this.callBridgeJson<ZipListPayload>('zipList', payload);
    return data.entries === undefined ? [] : data.entries;
  }

  /** 读一个 zip 条目（不存在 → null）。分块 base64 在这里拼回字节。 */
  async zipRead(archivePath: string, entryName: string): Promise<Uint8Array | null> {
    const payload: ZipReadRequest = { archivePath: archivePath, entryName: entryName };
    const data: ZipReadPayload = await this.callBridgeJson<ZipReadPayload>('zipRead', payload);
    const chunks: string[] = data.chunks === undefined ? [] : data.chunks;
    if (chunks.length === 0) {
      return null;
    }
    const parts: Uint8Array[] = [];
    let total: number = 0;
    for (let index = 0; index < chunks.length; index++) {
      const bytes: Uint8Array = GitSyncService.base64().decodeSync(chunks[index]);
      parts.push(bytes);
      total += bytes.length;
    }
    const merged: Uint8Array = new Uint8Array(total);
    let offset: number = 0;
    for (let index = 0; index < parts.length; index++) {
      merged.set(parts[index], offset);
      offset += parts[index].length;
    }
    return merged;
  }

  /**
   * 通用桥调用（args 是任意 JSON 对象，不像 `callBridge` 只接受字符串表）。
   *
   * 复用同一套 `pending` 机制与超时：失败一律抛 `SyncError`。
   */
  private callBridgeJson<T>(op: string, args: Object): Promise<T> {
    const id: string = 'g' + Date.now().toString() + '-' + (++this.requestSeq).toString();
    const payload: string = JSON.stringify({ id: id, op: op, args: args });
    return new Promise<T>((resolve: (value: T) => void, reject: (error: Object) => void) => {
      const timer: number = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new SyncError(
            'E_GIT',
            '同步超时（' + (REQUEST_TIMEOUT_MS / 1000).toString() + ' 秒）：Web 页面可能未就绪或网络不可用'
          )
        );
      }, REQUEST_TIMEOUT_MS);
      const pending: PendingRequest = {
        resolve: (event: BridgeEvent) => {
          if (event.ok === true) {
            resolve(event.data as T);
          } else {
            const failure: BridgeEventError | undefined = event.error;
            const code: string =
              failure === undefined || failure.code === undefined || failure.code.length === 0
                ? 'E_GIT'
                : failure.code;
            const text: string =
              failure === undefined || failure.message === undefined ? '桥调用失败' : failure.message;
            reject(new SyncError(code, text));
          }
        },
        reject: reject,
        timer: timer
      };
      this.pending.set(id, pending);
      this.runScript('window.DshGitBridge && window.DshGitBridge.call(' + JSON.stringify(payload) + ')');
    });
  }

  // -------------------------------------------------------------- 对外操作

  /** 拉取：本机无仓库时自动 clone；有仓库时 fetch + fast-forward（永不 merge）。 */
  async pull(): Promise<GitSyncResult> {
    const guard: SyncPreconditionResult = this.precondition(false);
    if (!guard.ok) {
      return rejected('拉取失败', guard.message);
    }
    const problem: string = this.validateForSync();
    if (problem.length > 0) {
      return rejected('拉取失败', problem);
    }
    try {
      const event: BridgeEvent = await this.callBridge('pull', this.configArgs());
      const data: PullPayload = event.data === undefined ? {} : event.data as PullPayload;
      const branch: string = GitSyncService.textOf(data.branch, this.branchName());
      const head: string = GitSyncService.textOf(data.head, '');
      let message: string;
      if (data.cloned === true) {
        message = '已克隆远端仓库（分支 ' + branch + '，HEAD ' + shortSha(head) + '）';
      } else if (data.alreadyUpToDate === true) {
        message = '已是最新（分支 ' + branch + '，HEAD ' + shortSha(head) + '）';
      } else if (data.fastForward === true) {
        message = '拉取完成（快进更新，分支 ' + branch + '，HEAD ' + shortSha(head) + '）';
      } else {
        message = '拉取完成（分支 ' + branch + '，HEAD ' + shortSha(head) + '）';
      }
      const preserved: string = describePreserved(data.localPreserved);
      if (preserved.length > 0) {
        message = message + '；' + preserved;
      }
      const result: GitSyncResult = { ok: true, message: message, branch: branch };
      if (head.length > 0) {
        result.commit = head;
      }
      // 设备身份（拉取**之后**才有远端版本可读）：老仓库缺指纹 → 写入本机指纹、不报警；
      // 远端指纹≠本机 → 两台设备用了同一个 deviceId，带上标记让设置页做常驻警告。
      try {
        await this.applyIdentityCheck(true);
        if (this.identityConflict) {
          result.identityConflict = true;
          result.identityWarning = this.identityNotice;
          result.message = result.message + '；' + this.identityNotice;
        }
        // 拉取成功后把工作副本里的附件 sha 记成基线：下次推送据此判断「是不是别人改的」
        this.snapshotAttachmentBaselines();
      } catch (error) {
        // 身份比对 / 基线快照失败，不影响「已经拉取成功」这个事实（下次同步再比）
      }
      // 设备编号自动登记（数据边界）：拉取后 registry 才是最新的，算号/抢占都在这一步。
      // 失败**不阻断本次拉取**（拉取本身没有写仓库），但必须把原因交回设置页（自动展开「高级」）；
      // 推送侧则是 fail-closed（见 push 里的 ensureDeviceRegistered）。
      const registration: GitSyncResult = await this.registerDevice(true);
      if (registration.ok) {
        result.deviceId = registration.deviceId;
        result.deviceIdAuto = registration.deviceIdAuto;
        result.deviceIdNotice = registration.deviceIdNotice;
        if (registration.fingerprintRecreated === true) {
          result.fingerprintRecreated = true;
        }
        if (registration.message.length > 0) {
          result.message = result.message + '；' + registration.message;
        }
      } else {
        result.deviceRegistrationError = registration.message;
        result.message = result.message + '；' + registration.message;
      }
      return result;
    } catch (error) {
      return failed('拉取失败', error as Object);
    }
  }

  /** 推送：只 add + commit `devices/<deviceId>/`，再推 origin/<branch>；永不 force。 */
  async push(message: string): Promise<GitSyncResult> {
    const guard: SyncPreconditionResult = this.precondition(false);
    if (!guard.ok) {
      return rejected('推送失败', guard.message);
    }
    const problem: string = this.validateForSync(false);
    if (problem.length > 0) {
      return rejected('推送失败', problem);
    }
    // 设备编号登记（数据边界，**fail-closed**）：必须先在 devices/registry.jsonl 里有本机的行，
    // 才能写 devices/<deviceId>/。抢不到编号 → 整次推送失败，绝不用一个可能撞车的号继续写。
    let fingerprintRecreated: boolean = false;
    try {
      const registration: GitSyncResult = await this.ensureDeviceRegistered(false);
      fingerprintRecreated = registration.fingerprintRecreated === true;
    } catch (error) {
      const registrationFailure: GitSyncResult = failed('推送失败', error as Object);
      if (registrationFailure.code === undefined || registrationFailure.code.length === 0) {
        registrationFailure.code = 'E_DEVICE_ID_UNREADABLE';
      }
      registrationFailure.deviceRegistrationError = registrationFailure.message;
      return registrationFailure;
    }
    // 编号已经就位：再跑一次完整校验（设备标识这条现在必然通过，其余检查不重复联网）
    const deviceProblem: string = this.validateForSync();
    if (deviceProblem.length > 0) {
      return rejected('推送失败', deviceProblem);
    }
    // 提交范围不变量（docs/DATA-CONTRACT.md §1/§6）：待提交路径越界一律拒绝，且不触碰网络
    const scopeProblem: string = this.verifyPushScope();
    if (scopeProblem.length > 0) {
      return rejected('推送失败', scopeProblem);
    }
    // 设备身份比对（首次同步会写入本机指纹；冲突不阻断推送，只带标记给页面做常驻警告）
    try {
      await this.applyIdentityCheck(true);
    } catch (error) {
      // 比对失败不阻断推送：附件守卫仍按 fail-closed 处理（拿不到指纹就拒推附件）
    }
    // 附件守卫：远端版本可能被另一台设备改过的 zip 先挪出仓库，避免被本次提交覆盖
    const attachmentGuard: PushAttachmentGuard = this.guardAttachmentsBeforePush();
    if (attachmentGuard.failure.length > 0) {
      return rejected('推送失败', attachmentGuard.failure);
    }
    try {
      const args: Record<string, string> = this.configArgs();
      args['message'] = message.length > 0 ? message : '日程同步 ' + new Date().toISOString();
      const event: BridgeEvent = await this.callBridge('push', args);
      const data: PushPayload = event.data === undefined ? {} : event.data as PushPayload;
      const branch: string = GitSyncService.textOf(data.branch, this.branchName());
      // 桥在没有新改动可提交时返回 commit:null —— 必须当空串处理（否则 .length 抛异常）
      const commit: string = GitSyncService.textOf(data.commit, '');
      const fileCount: number = GitSyncService.numberOf(data.files, 0);
      const pushed: boolean = data.pushed !== false;
      // 无改动 / 首次建分支都要说清楚，不能让用户看着「推送完成」却不知道推了什么
      let detail: string;
      if (commit.length > 0) {
        detail = '提交 ' + shortSha(commit) + '，文件 ' + fileCount.toString() + ' 个';
      } else if (fileCount === 0) {
        detail = '没有新的本地改动';
      } else {
        detail = '没有新的改动可提交';
      }
      let summary: string = (pushed ? '推送完成' : '推送未完成') + '（分支 ' + branch + '，' + detail + '）';
      if (data.branchCreated === true) {
        summary = summary + '；已在远端创建分支 ' + branch;
      } else if (data.branchCreatedLocal === true) {
        summary = summary + '；已在本地创建分支 ' + branch;
      }
      if (attachmentGuard.blocked > 0) {
        summary = summary + '；' + describeAttachmentPushBlock(attachmentGuard.blocked, attachmentGuard.reason);
      }
      if (this.identityConflict) {
        summary = summary + '；' + this.identityNotice;
      }
      const result: GitSyncResult = { ok: true, message: summary, branch: branch };
      if (commit.length > 0) {
        result.commit = commit;
      }
      if (attachmentGuard.blocked > 0) {
        result.attachmentsBlocked = attachmentGuard.blocked;
        result.attachmentWarning = attachmentGuard.reason;
      }
      if (this.identityConflict) {
        result.identityConflict = true;
        result.identityWarning = this.identityNotice;
      }
      if (fingerprintRecreated) {
        result.fingerprintRecreated = true;
      }
      // 推送成功后把「本次真正推上去的附件」记成基线（被挪走的那几个不在工作副本里，不会被记）
      try {
        this.snapshotAttachmentBaselines();
      } catch (error) {
        // 基线写失败不影响已完成的推送（下次拉取会重建基线）
      }
      return result;
    } catch (error) {
      return failed('推送失败', error as Object);
    } finally {
      // 无论成败都把临时挪走的附件放回（否则用户会以为附件丢了）
      this.restoreQuarantined(attachmentGuard);
    }
  }

  /**
   * 启动 / 回前台时的**静默 pull**（B 段同步时机）。
   *
   * 约定：
   * - 未配置仓库（`repoUrl` 为空）→ 直接返回「跳过」，**不报错**（用户还没配）；
   * - 失败只返回 `ok:false` 的结果（调用方 toast 一句即可），**绝不抛异常、不阻塞 UI**；
   * - 无定时器 / 无后台任务，只在显式调用点跑一次（Index 启动、回前台、下拉刷新）。
   */
  async pullOnStartup(): Promise<GitSyncResult> {
    if (this.config.repoUrl.trim().length === 0) {
      return { ok: true, message: '未配置同步仓库，跳过自动拉取' };
    }
    const guard: SyncPreconditionResult = this.precondition(false);
    if (!guard.ok) {
      return rejected('自动拉取跳过', guard.message);
    }
    try {
      // 说明：services 层**禁止任何 console/hilog**（credentialHygiene 测试硬性检查），
      // 因此这里不打日志，成败信息通过返回的 message 交给调用方展示。
      return await this.pull();
    } catch (error) {
      return failed('自动拉取失败', error as Object);
    }
  }

  // -------------------------------------------------------------- 就绪状态与前置守卫

  /** 桥（WebView 内核）是否已注册代理并完成刷新。 */
  isBridgeReady(): boolean {
    return this.bridgeReady;
  }

  /** 标记桥就绪（由页面 `onPageEnd`/`Web` 回调调用）。 */
  markBridgeReady(): void {
    this.bridgeReady = true;
  }

  /** 桥加载失败：置未就绪并记下原因（页面据此禁用「立即同步」并展示）。 */
  markBridgeFailed(reason: string): void {
    this.bridgeReady = false;
    this.bridgeError = reason;
  }

  /** 桥不可用的原因（`bridgeReady === true` 时为空串）。 */
  bridgeFailure(): string {
    return this.bridgeError;
  }

  /**
   * 同步前置守卫（**永不抛异常**）：忙 → 桥未就绪 → 仓库地址为空。
   * 结论来自纯函数 `model/syncGuard.ts`，与页面/控制器共用一套文案。
   */
  private precondition(busy: boolean): SyncPreconditionResult {
    const input: SyncPreconditionInput = {
      repoUrl: this.config.repoUrl,
      token: this.config.token,
      bridgeReady: this.bridgeReady,
      busy: busy
    };
    return checkSyncPrecondition(input);
  }

  /**
   * 状态：当前分支 / HEAD / ahead / behind / 冲突 / 本地改动 / 远端是否可连。
   *
   * @param withProbe 是否额外发一次真实的 `info/refs` 探测（默认 true）。
   *                  页面里「同步完成后刷新状态」用 `false`：只看本地仓库，不额外联网。
   */
  async status(withProbe: boolean = true): Promise<GitSyncResult> {
    const guard: SyncPreconditionResult = this.precondition(false);
    if (!guard.ok) {
      return rejected('查询失败', guard.message);
    }
    const problem: string = this.validateForStatus();
    if (problem.length > 0) {
      return rejected('查询失败', problem);
    }
    try {
      const event: BridgeEvent = await this.callBridge('status', this.configArgs());
      const data: StatusPayload = event.data === undefined ? {} : event.data as StatusPayload;
      const view: SyncStatusView = this.statusViewOf(data);
      const result: GitSyncResult = {
        ok: true,
        message: describeSyncStatus(view),
        branch: view.branch,
        ahead: view.ahead,
        behind: view.behind,
        conflicts: view.conflicts,
        diverged: view.diverged,
        changedCount: view.changedCount,
        initialized: view.initialized,
        remoteConfigured: view.remoteConfigured
      };
      if (withProbe) {
        const probe: RemoteProbe = await this.probeRemote();
        result.message = result.message + '｜连接 ' + probe.detail;
      }
      return result;
    } catch (error) {
      return failed('查询失败', error as Object);
    }
  }

  /**
   * 桥的 status 载荷 → 纯逻辑视图（页面文案由 `describeSyncStatus` 统一生成）。
   *
   * 一律走 `textOf` / `numberOf`：桥里「没有值」是 **null**（`report.branch = null`），
   * 直接 `.length` 会抛 TypeError（历史上这类异常被 catch 成「查询失败」）。
   */
  private statusViewOf(data: StatusPayload): SyncStatusView {
    const remoteUrl: string = GitSyncService.textOf(data.remoteUrl, '');
    const targetText: string = GitSyncService.textOf(data.targetBranch, '');
    const headText: string = GitSyncService.textOf(data.head, '');
    const currentText: string = GitSyncService.textOf(data.branch, '');
    let branch: string = this.branchName();
    if (targetText.length > 0) {
      branch = targetText;
    } else if (currentText.length > 0) {
      branch = currentText;
    }
    const lastCommit: CommitPayload | null | undefined = data.lastCommit;
    let lastCommitMessage: string = '';
    if (lastCommit !== undefined && lastCommit !== null) {
      lastCommitMessage = GitSyncService.textOf(lastCommit.message, '');
    }
    const view: SyncStatusView = {
      initialized: data.initialized === true,
      branch: branch,
      head: headText,
      ahead: GitSyncService.numberOf(data.ahead, 0),
      behind: GitSyncService.numberOf(data.behind, 0),
      diverged: data.diverged === true,
      conflicts: GitSyncService.numberOf(data.conflicts, 0),
      changedCount: GitSyncService.numberOf(data.changedCount, 0),
      remoteConfigured: remoteUrl.length > 0,
      lastCommitMessage: lastCommitMessage
    };
    return view;
  }

  /** 桥字段 → 字符串：非字符串（含 null/undefined）一律回落（桥用 null 表示「没有值」）。 */
  private static textOf(value: string | null | undefined, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
  }

  /** 桥字段 → 数字：非有限数字一律回落。 */
  private static numberOf(value: number | null | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  // -------------------------------------------------------------- 宿主代理：事件回传

  /** 桥的操作结果回传入口（JS 同步调用）。 */
  onEvent(json: string): void {
    let event: BridgeEvent;
    try {
      event = JSON.parse(json) as BridgeEvent;
    } catch (error) {
      return;
    }
    const id: string = event.id === undefined ? '' : event.id;
    const pending: PendingRequest | undefined = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (event.ok === true) {
      pending.resolve(event);
      return;
    }
    const failure: BridgeEventError = event.error === undefined ? {} : event.error;
    const code: string = failure.code === undefined ? 'E_GIT' : failure.code;
    const text: string = failure.message === undefined ? '未知错误' : failure.message;
    pending.reject(new SyncError(code, text));
  }

  /** 把 HTTP 结果送回桥（由 httpRequest 内部调用）。 */
  onHttpResult(json: string): void {
    const script: string =
      'window.DshGitBridge && window.DshGitBridge.onHttpResult(' + JSON.stringify(json) + ')';
    this.runScript(script);
  }

  // -------------------------------------------------------------- 宿主代理：文件系统（同步）

  readFileBase64(path: string): string {
    const target: string = normalizePath(path);
    if (!this.fileExists(target)) {
      return '';
    }
    let file: fs.File | null = null;
    try {
      file = fs.openSync(target, fs.OpenMode.READ_ONLY);
      const info: fs.Stat = fs.statSync(target);
      const size: number = info.size;
      if (size <= 0) {
        return '';
      }
      const buffer: ArrayBuffer = new ArrayBuffer(size);
      const readLength: number = fs.readSync(file.fd, buffer);
      if (readLength <= 0) {
        return '';
      }
      const bytes: Uint8Array = new Uint8Array(buffer, 0, readLength);
      return GitSyncService.base64().encodeToStringSync(bytes);
    } catch (error) {
      return '';
    } finally {
      if (file !== null) {
        try {
          fs.closeSync(file);
        } catch (error) {
          // 关闭失败不影响读取结果
        }
      }
    }
  }

  writeFileBase64(path: string, base64: string): boolean {
    const target: string = normalizePath(path);
    this.mkdirp(dirnameOf(target));
    const decoded: Uint8Array = GitSyncService.base64().decodeSync(base64);
    const bytes: Uint8Array = new Uint8Array(decoded.length);
    bytes.set(decoded);
    const file: fs.File = fs.openSync(
      target,
      fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC
    );
    try {
      if (bytes.length > 0) {
        fs.writeSync(file.fd, bytes.buffer as ArrayBuffer);
      }
    } finally {
      try {
        fs.closeSync(file);
      } catch (error) {
        // 关闭失败按写入成功处理（内容已落盘）
      }
    }
    return true;
  }

  fileExists(path: string): boolean {
    try {
      return fs.accessSync(normalizePath(path));
    } catch (error) {
      return false;
    }
  }

  mkdirp(path: string): boolean {
    const target: string = normalizePath(path);
    if (target.length === 0 || target === '/' || target === '.') {
      return true;
    }
    if (this.isDirectory(target)) {
      return true;
    }
    const parent: string = dirnameOf(target);
    if (parent.length > 0 && parent !== target) {
      this.mkdirp(parent);
    }
    try {
      fs.mkdirSync(target);
    } catch (error) {
      // 已存在或并发创建：都视为成功
    }
    return true;
  }

  readdir(path: string): string {
    const names: string[] = fs.listFileSync(normalizePath(path));
    return JSON.stringify(names);
  }

  stat(path: string): string {
    const target: string = normalizePath(path);
    const info: fs.Stat = fs.statSync(target);
    const isDir: boolean = info.isDirectory();
    let mode: number = isDir ? MODE_DIR : MODE_FILE;
    if (info.mode > 0) {
      mode = info.mode;
    }
    const payload: StatPayload = {
      mode: mode,
      size: info.size,
      mtimeMs: info.mtime * 1000,
      type: isDir ? 'dir' : 'file'
    };
    return JSON.stringify(payload);
  }

  unlink(path: string): boolean {
    try {
      fs.unlinkSync(normalizePath(path));
      return true;
    } catch (error) {
      return false;
    }
  }

  rename(oldPath: string, newPath: string): boolean {
    const from: string = normalizePath(oldPath);
    const to: string = normalizePath(newPath);
    this.mkdirp(dirnameOf(to));
    try {
      fs.renameSync(from, to);
      return true;
    } catch (error) {
      return false;
    }
  }

  /** 仓库工作副本根目录：`<filesDir>/git-repo`（绝对路径、`/` 分隔）。 */
  getRepoRoot(): string {
    const filesDir: string =
      GitSyncService.filesDirOverride.length > 0
        ? GitSyncService.filesDirOverride
        : this.resolveFilesDir();
    const root: string = normalizePath(filesDir) + '/' + REPO_DIR_NAME;
    this.mkdirp(root);
    return root;
  }

  // -------------------------------------------------------------- 设备身份（指纹 / 附件基线）

  /** 本机状态文件的绝对路径（`<filesDir>/<name>`，在 git 仓库**之外**，不会被提交）。 */
  private stateFilePath(name: string): string {
    const filesDir: string =
      GitSyncService.filesDirOverride.length > 0
        ? GitSyncService.filesDirOverride
        : this.resolveFilesDir();
    return normalizePath(filesDir) + '/' + name;
  }

  /** 字节 → ASCII 文本（指纹与基线 JSON 都是 ASCII，不引入 TextDecoder 的平台差异）。 */
  private static asciiOf(bytes: Uint8Array): string {
    let out: string = '';
    for (let index = 0; index < bytes.length; index++) {
      out += String.fromCharCode(bytes[index]);
    }
    return out;
  }

  /** 读一个文本文件（不存在 / 读失败 → 空串）。 */
  private readTextFile(path: string): string {
    if (path.length === 0 || !this.fileExists(path)) {
      return '';
    }
    const encoded: string = this.readFileBase64(path);
    if (encoded.length === 0) {
      return '';
    }
    return GitSyncService.asciiOf(GitSyncService.base64().decodeSync(encoded));
  }

  /** 写一个文本文件（复用现有 base64 通道，不再引一套文件 API）。 */
  private writeTextFile(path: string, text: string): void {
    if (path.length === 0 || text.length === 0) {
      return;
    }
    this.writeFileBase64(path, this.base64Text(text));
  }

  /**
   * 本机身份 uuid（= `devices/<id>/.device-fingerprint` 的内容 = registry 里的 `uuid`，**同一个值**）。
   *
   * 读取顺序（`docs/DATA-CONTRACT.md`「devices/registry.jsonl」）：
   * 1. 内存缓存（本次运行已解析过）；
   * 2. 仓库 `devices/<当前 id>/.device-fingerprint`（**日常启动先读指纹文件**）；
   * 3. settingsStore 的 `deviceUuid`（旧版本只在 `deviceFingerprint` 存过同一个值）；
   * 4. 都没有 → 不在这里生成，交给纯函数 `resolveIdentity` 的 `recreate` 分支生成
   *    （保证「四态」只有一处判定），调用方据此标记 `fingerprintRecreated`。
   *
   * 注意：**只读**，不写文件；落盘（settings 的 `deviceUuid`/`deviceFingerprint`）由
   * `resolveLocalIdentity` / `registerDevice` 在拿到最终 uuid 后一次性写入。
   */
  private async loadLocalIdentity(): Promise<LocalIdentity> {
    const cached: string = normalizeFingerprint(this.fingerprintCache);
    if (cached.length > 0) {
      const fromCache: LocalIdentity = { uuid: cached, recreated: false, source: 'cache' };
      return fromCache;
    }
    let stored: string = '';
    try {
      const settings = await settingsStore.load();
      stored = normalizeFingerprint(settings.deviceUuid);
      if (stored.length === 0) {
        stored = normalizeFingerprint(settings.deviceFingerprint);
      }
    } catch (error) {
      stored = '';
    }
    const fromRepo: string = this.readRepoFingerprint();
    let uuid: string = fromRepo;
    let source: string = 'repo';
    if (uuid.length === 0) {
      uuid = stored;
      source = 'settings';
    }
    if (uuid.length === 0) {
      const missing: LocalIdentity = { uuid: '', recreated: true, source: 'missing' };
      return missing;
    }
    this.fingerprintCache = uuid;
    if (source !== 'repo' || stored !== uuid) {
      // 两个键从此指向同一个身份（旧数据只有 deviceFingerprint 时补写 deviceUuid）
      try {
        await settingsStore.save({ deviceUuid: uuid, deviceFingerprint: uuid });
      } catch (error) {
        // 设置存储未初始化 / 写盘失败：本次用内存值即可（下次同步再试）
      }
    }
    const loaded: LocalIdentity = { uuid: uuid, recreated: false, source: source };
    return loaded;
  }

  /** 仓库里 `devices/<id>/.device-fingerprint` 的绝对路径（设备标识非法 → 空串）。 */
  private repoFingerprintFilePath(): string {
    let deviceId: string = '';
    try {
      deviceId = normalizeDeviceId(this.config.deviceId);
    } catch (error) {
      return '';
    }
    const relPath: string = deviceFingerprintPath(deviceId);
    if (relPath.length === 0) {
      return '';
    }
    return this.getRepoRoot() + '/' + relPath;
  }

  /** 仓库工作副本里的指纹（不存在 / 非法 → 空串）。 */
  private readRepoFingerprint(): string {
    const path: string = this.repoFingerprintFilePath();
    if (path.length === 0) {
      return '';
    }
    return normalizeFingerprint(this.readTextFile(path));
  }

  /** 仓库里指定设备目录下的指纹文件绝对路径（设备标识非法 → 空串）。 */
  private repoFingerprintFilePathUnder(deviceId: string): string {
    let id: string = '';
    try {
      id = normalizeDeviceId(deviceId);
    } catch (error) {
      return '';
    }
    const relPath: string = deviceFingerprintPath(id);
    if (relPath.length === 0) {
      return '';
    }
    return this.getRepoRoot() + '/' + relPath;
  }

  /** 指定设备目录下的指纹（不存在 / 非法 → 空串）。 */
  private readRepoFingerprintUnder(deviceId: string): string {
    const path: string = this.repoFingerprintFilePathUnder(deviceId);
    if (path.length === 0) {
      return '';
    }
    return normalizeFingerprint(this.readTextFile(path));
  }

  /**
   * 首次同步：把本机 uuid 写进 `devices/<id>/.device-fingerprint`（随后被 push 提交）。
   *
   * **已存在则绝不覆盖**：覆盖就等于掩盖「两台设备同 id」这件事（也是 `fingerprint-overwritten`
   * 冲突判定的证据来源）。
   */
  private adoptRepoFingerprintUnder(deviceId: string, fingerprint: string): void {
    const path: string = this.repoFingerprintFilePathUnder(deviceId);
    const uuid: string = normalizeFingerprint(fingerprint);
    if (path.length === 0 || uuid.length === 0) {
      return;
    }
    if (this.readRepoFingerprintUnder(deviceId).length > 0) {
      return;
    }
    const text: string = fingerprintFileText(uuid);
    if (text.length === 0) {
      return;
    }
    this.writeTextFile(path, text);
  }

  /** 当前 `config.deviceId` 对应的目录（`adoptRepoFingerprint` 的旧签名入口）。 */
  private adoptRepoFingerprint(fingerprint: string): void {
    this.adoptRepoFingerprintUnder(this.config.deviceId, fingerprint);
  }

  /** 归一后的当前设备标识（非法 / 未填 → 空串，不抛异常）。 */
  private currentDeviceId(): string {
    try {
      return normalizeDeviceId(this.config.deviceId);
    } catch (error) {
      return '';
    }
  }

  /**
   * 本机「已有、且仓库里确有 `devices/<id>/` 目录」的设备编号（没有 → `null`）。
   *
   * 这是升级兼容（`register-existing`）的前提：只有目录真存在，才说明这台设备以前就在用这个号；
   * 否则（`settingsStore` 的默认值 `phone-a`、或别人手填过的值）应该去抢新号。
   */
  private existingLocalDeviceId(): string | null {
    const id: string = this.currentDeviceId();
    if (id.length === 0) {
      return null;
    }
    const dir: string = normalizePath(this.getRepoRoot() + '/' + DEVICES_DIR + '/' + id);
    return this.isDirectory(dir) ? id : null;
  }

  /** registry 的当前内容（解析后的行；读不到 / 坏行 → 可用的行或空数组）。 */
  private readRegistryEntries(): RegistryEntry[] {
    try {
      const parsed: RegistryParseResult = parseRegistry(this.readTextFile(this.registryFilePath()));
      return parsed.entries;
    } catch (error) {
      return [];
    }
  }

  /**
   * 身份解析：`model/deviceIdentity.ts#resolveIdentity` 的接线（四态 + 两种冲突）。
   *
   * 同时把结论落到 `identityConflict` / `identityNotice`（设置页常驻警告靠它们）。
   * `recreate`（指纹读不到）时这里生成的新 uuid 会立刻写回 settings，避免下次又换一个。
   */
  private async resolveLocalIdentity(): Promise<IdentityResolution> {
    const local: LocalIdentity = await this.loadLocalIdentity();
    const uuid: string = normalizeFingerprint(local.uuid);
    const localDirId: string | null = this.existingLocalDeviceId();
    const resolution: IdentityResolution = resolveIdentity({
      localUuid: uuid.length > 0 ? uuid : null,
      localDeviceId: localDirId,
      registry: this.readRegistryEntries()
    });
    const resolvedUuid: string = normalizeFingerprint(resolution.uuid);
    if (resolvedUuid.length > 0 && resolvedUuid !== uuid) {
      this.fingerprintCache = resolvedUuid;
      try {
        await settingsStore.save({ deviceUuid: resolvedUuid, deviceFingerprint: resolvedUuid });
      } catch (error) {
        // 设置写不进去不影响本次判定（内存里已是新 uuid）
      }
    }
    // 指纹「丢失」= 仓库里本机目录还在、但 uuid 读不到了；全新安装（目录都没有）不算丢失。
    if (resolution.action === 'recreate' && localDirId !== null) {
      this.identityRecreated = true;
    }
    // 兜底：仓库 `devices/<id>/.device-fingerprint` 与本机不一致（没有 registry 证据时仍算撞号）
    const remote: string = this.readRepoFingerprint();
    const localUuid: string = normalizeFingerprint(this.fingerprintCache);
    const legacy: IdentityCheck = checkDeviceIdentity(remote, localUuid);
    let kind: IdentityConflictKind = resolution.conflict;
    if (kind === 'none' && legacy.conflict) {
      kind = 'duplicate-device';
    }
    const displayId: string = resolution.deviceId !== null ? resolution.deviceId : this.currentDeviceId();
    if (kind !== 'none') {
      this.identityStickyConflict = kind;
      this.identityNotice = describeIdentityConflict(displayId, kind);
    } else if (this.identityStickyConflict !== 'none' && this.identityNotice.length === 0) {
      this.identityNotice = describeIdentityConflict(displayId, this.identityStickyConflict);
    }
    this.identityConflict = kind !== 'none' || this.identityStickyConflict !== 'none';
    return resolution;
  }

  /**
   * 身份比对（拉取后 / 推送前 / 设置页进页面时调用）。
   *
   * @param adopt true = 编号已确定时把 uuid 补写进 `devices/<id>/.device-fingerprint`
   *              （首次同步 / 老用户升级）；false = 只读比对（页面查询用）。
   */
  private async applyIdentityCheck(adopt: boolean): Promise<void> {
    const resolution: IdentityResolution = await this.resolveLocalIdentity();
    const uuid: string = normalizeFingerprint(this.fingerprintCache);
    if (!adopt || uuid.length === 0 || resolution.deviceId === null) {
      // `claim-new` / `recreate` 还没有确定编号：不能先往默认/别人的目录里写指纹
      return;
    }
    this.adoptRepoFingerprintUnder(resolution.deviceId, uuid);
  }

  /**
   * 设置页用的身份警告（空串 = 正常；非空 = 常驻 warning 文案）。
   *
   * 只读比对（不写文件）：页面进入 / 同步后调用，用户改成唯一设备标识后警告会立刻消失。
   */
  async identityWarning(): Promise<string> {
    try {
      await this.applyIdentityCheck(false);
    } catch (error) {
      return this.identityNotice;
    }
    return this.identityNotice;
  }

  // -------------------------------------------------------------- 设备编号自动登记（数据边界）

  /** `devices/registry.jsonl` 的绝对路径（仓库工作副本内）。 */
  private registryFilePath(): string {
    return normalizePath(this.getRepoRoot() + '/' + REGISTRY_PATH);
  }

  /** 仓库里 `devices/` 下的**目录**名（不存在 → 空数组；只列目录，忽略 registry.jsonl 等文件）。 */
  private listDeviceDirNames(): string[] {
    const names: string[] = [];
    const dir: string = normalizePath(this.getRepoRoot() + '/' + DEVICES_DIR);
    if (!this.isDirectory(dir)) {
      return names;
    }
    let listing: string[] = [];
    try {
      listing = JSON.parse(this.readdir(dir)) as string[];
    } catch (error) {
      return names;
    }
    if (!Array.isArray(listing)) {
      return names;
    }
    for (let index = 0; index < listing.length; index++) {
      const name: string = listing[index];
      if (name.length === 0 || name === '.' || name === '..') {
        continue;
      }
      if (this.isDirectory(dir + '/' + name)) {
        names.push(name);
      }
    }
    return names;
  }

  /**
   * 抢占端口：把纯逻辑 `model/deviceRegistry.ts` 接到真实的 git 桥上。
   *
   * `commitRegistry` 只提交 `devices/registry.jsonl`（桥侧白名单，`commitPaths` op），
   * 并把追加前的原文一起传下去：push 被拒时桥会回滚这次提交，重试的 `pull` 才能快进。
   */
  private registryPort(): DeviceRegistryPort {
    const port: DeviceRegistryPort = {
      readRegistry: (): string => this.readTextFile(this.registryFilePath()),
      listDeviceDirs: (): string[] => this.listDeviceDirNames(),
      pull: async (): Promise<void> => {
        await this.callBridge('pull', this.configArgs());
      },
      commitRegistry: async (text: string, message: string): Promise<void> => {
        const path: string = this.registryFilePath();
        const previous: string = this.readTextFile(path);
        this.writeTextFile(path, text);
        const args: Record<string, string> = this.configArgs();
        args['paths'] = REGISTRY_PATH;
        args['message'] = message;
        // 抢占循环里刚刚拉过，不必在桥里再拉一次（省一次网络往返）
        args['prePull'] = 'false';
        args['previous'] = previous;
        await this.callBridge('commitPaths', args);
      }
    };
    return port;
  }

  /**
   * 设备编号登记（**主流程**）：读身份 → 拉取 → 四态判定 → 登记/抢号 → 写回设置。
   * 失败即 fail-closed。
   *
   * 步骤（`docs/DATA-CONTRACT.md`「devices/registry.jsonl」）：
   * 1. 读本机身份 uuid：`devices/<id>/.device-fingerprint` → settings → **生成新的**（`recreate`）；
   * 2. 拉取远端（fast-forward only）——`pulled` 为 true 时跳过（调用方刚拉过）；
   * 3. 纯逻辑四态 `resolveIdentity`：
   *    - `reuse`：registry 里有本机 uuid 的行 → 用该行 `deviceId`（不重复登记）；
   *    - `register-existing`：没有该 uuid 的行、但本机编号目录在仓库里 → **补登记一行，绝不换号**；
   *    - `claim-new` / `recreate`：算下一个编号（空洞不回填）→ 追加一行；
   *    - 升级兼容与首次接入都在**登记前**把 uuid 写进 `devices/<id>/.device-fingerprint`；
   * 4. push 被拒（别人抢先）→ 重新拉取 → 重算 → 重试，最多 5 次；
   * 5. 成功后写 `{deviceId, deviceIdAuto, deviceUuid, deviceFingerprint}` 到设置
   *    （两个键同一个值：`.device-fingerprint` 的内容就是 registry 里的 uuid）。
   *
   * @returns 本次生效的设备编号、展示文案，以及 `fingerprintRecreated`（指纹丢失重建）标记
   * @throws SyncError `E_DEVICE_ID_CONFLICT`（重试用尽）/ `E_DEVICE_ID_UNREADABLE`（仓库不可读）
   */
  async registerDevice(pulled: boolean = false): Promise<GitSyncResult> {
    const guard: SyncPreconditionResult = this.precondition(false);
    if (!guard.ok) {
      return rejected('设备编号登记失败', guard.message);
    }
    const problem: string = this.validateForSync(false);
    if (problem.length > 0) {
      return rejected('设备编号登记失败', problem);
    }
    try {
      // 1. 本机身份（先读指纹文件；读不到才由 resolveIdentity 生成新的）
      const local: LocalIdentity = await this.loadLocalIdentity();
      const localUuid: string = normalizeFingerprint(local.uuid);
      // 2. registry 必须是最新的，否则可能给已有 uuid 重复登记（多一行、多一个号）
      const port: DeviceRegistryPort = this.registryPort();
      if (!pulled) {
        try {
          await port.pull();
        } catch (error) {
          const unreadable: GitSyncResult = rejected(
            '设备编号登记失败',
            '读不到仓库里的设备登记表（拉取失败）'
          );
          unreadable.code = 'E_DEVICE_ID_UNREADABLE';
          unreadable.deviceRegistrationError = unreadable.message;
          return unreadable;
        }
      }
      // 3. 四态判定（纯逻辑）：指纹读不到 → 生成新 uuid 并当新设备处理
      const localDirId: string | null = this.existingLocalDeviceId();
      const resolution: IdentityResolution = resolveIdentity({
        localUuid: localUuid.length > 0 ? localUuid : null,
        localDeviceId: localDirId,
        registry: this.readRegistryEntries()
      });
      const uuid: string = normalizeFingerprint(resolution.uuid);
      if (uuid.length === 0) {
        throw new SyncError('E_DEVICE_ID_UNREADABLE', '无法生成设备身份串，请稍后重试');
      }
      // uuid 变了（recreate）→ 先落盘，保证「写进文件的 uuid」与「登记进 registry 的 uuid」是同一个
      this.fingerprintCache = uuid;
      try {
        await settingsStore.save({ deviceUuid: uuid, deviceFingerprint: uuid });
      } catch (error) {
        // 设置写不进去不影响本次登记（内存里已是同一个 uuid）
      }
      // 升级兼容 / 复用：编号已确定 → **先写指纹文件再登记**（规则：写文件 → 抢号）
      if (resolution.deviceId !== null) {
        this.adoptRepoFingerprintUnder(resolution.deviceId, uuid);
      }
      // 只有「补登记本机老编号」才把老标识交给 claimDeviceId；`claim-new`/`recreate` 必须抢新号
      const reuseLocalId: string =
        resolution.action === 'register-existing' && resolution.deviceId !== null ? resolution.deviceId : '';
      const outcome: ClaimOutcome = await claimDeviceId(port, {
        localDeviceId: reuseLocalId,
        uuid: uuid,
        at: new Date().toISOString(),
        // host 只写「本机接入前的原标识」，纯排查线索（不含 token / 机型等任何信息）
        host: this.currentDeviceId(),
        // 循环前已经拉过（见步骤 2），不再多拉一次
        pulled: true
      });
      // ArkTS 不对 `!x.ok` 做可辨识联合窄化；必须用 `=== false` 才能拿到 ClaimFailure 的字段。
      if (outcome.ok === false) {
        const failed: ClaimFailure = outcome;
        const failure: GitSyncResult = rejected('设备编号登记失败', failed.message);
        failure.code = failed.code;
        failure.deviceRegistrationError = failed.message;
        return failure;
      }
      this.config.deviceId = outcome.deviceId;
      // 编号确定后补写指纹文件（首次接入：新目录此刻才存在）
      this.adoptRepoFingerprintUnder(outcome.deviceId, outcome.uuid);
      try {
        await settingsStore.save({
          deviceId: outcome.deviceId,
          deviceIdAuto: outcome.auto,
          deviceUuid: outcome.uuid,
          deviceFingerprint: outcome.uuid
        });
      } catch (error) {
        // 设置写不进去不影响本次同步（编号已在内存里生效），下次接入会再写一次
      }
      const recreated: boolean =
        (resolution.action === 'recreate' && localDirId !== null) || this.identityRecreated;
      this.identityRecreated = false;
      const notice: string = describeClaimOutcome(outcome.deviceId, outcome.auto);
      let message: string = notice + (outcome.registered ? '（已在仓库登记）' : '（仓库里已登记）');
      if (recreated) {
        message = message + '；本机设备指纹文件缺失，已按新设备重新登记';
      }
      const result: GitSyncResult = {
        ok: true,
        message: message,
        deviceId: outcome.deviceId,
        deviceIdAuto: outcome.auto,
        deviceIdNotice: notice
      };
      if (recreated) {
        result.fingerprintRecreated = true;
      }
      // 冲突（撞号 / 被覆盖）要立刻反映到常驻警告，不等到下一次 pull
      if (resolution.conflict !== 'none') {
        this.identityStickyConflict = resolution.conflict;
        this.identityConflict = true;
        this.identityNotice = describeIdentityConflict(outcome.deviceId, resolution.conflict);
        result.identityConflict = true;
        result.identityWarning = this.identityNotice;
      }
      return result;
    } catch (error) {
      const failure: GitSyncResult = failed('设备编号登记失败', error as Object);
      failure.deviceRegistrationError = failure.message;
      return failure;
    }
  }

  /**
   * 同步流程里的「确保已登记」：失败抛 `SyncError`（推送必须**停下**，不许随便用一个号继续写）。
   *
   * @param pulled true = 调用方刚拉取过（省一次 pull）
   * @returns 登记结果（推送侧要把 `fingerprintRecreated` / 冲突标记带回给页面）
   */
  private async ensureDeviceRegistered(pulled: boolean): Promise<GitSyncResult> {
    const result: GitSyncResult = await this.registerDevice(pulled);
    if (!result.ok) {
      const code: string = result.code === undefined || result.code.length === 0 ? 'E_DEVICE_ID_UNREADABLE' : result.code;
      throw new SyncError(code, result.message);
    }
    return result;
  }

  /** 文件内容的 sha256（hex；读失败 → 空串）。附件 zip 的「版本指纹」。 */
  private sha256OfFile(path: string): string {    if (!this.fileExists(path)) {
      return '';
    }
    let file: fs.File | null = null;
    try {
      file = fs.openSync(path, fs.OpenMode.READ_ONLY);
      const info: fs.Stat = fs.statSync(path);
      const size: number = info.size;
      if (size <= 0) {
        return '';
      }
      const buffer: ArrayBuffer = new ArrayBuffer(size);
      const readLength: number = fs.readSync(file.fd, buffer);
      if (readLength <= 0) {
        return '';
      }
      return sha256Hex(new Uint8Array(buffer, 0, readLength));
    } catch (error) {
      return '';
    } finally {
      if (file !== null) {
        try {
          fs.closeSync(file);
        } catch (error) {
          // 关闭失败不影响 sha 结果
        }
      }
    }
  }

  /** 读本机附件基线（设备标识不匹配 / 文件坏 → 空表）。 */
  private readBaseline(deviceId: string): AttachmentBaselineDoc {
    const empty: AttachmentBaselineDoc = { deviceId: deviceId, files: {} };
    const path: string = this.stateFilePath(BASELINE_FILE_NAME);
    const text: string = this.readTextFile(path);
    if (text.length === 0) {
      return empty;
    }
    try {
      const doc: AttachmentBaselineDoc = JSON.parse(text) as AttachmentBaselineDoc;
      if (doc === null || doc === undefined) {
        return empty;
      }
      const owner: string = typeof doc.deviceId === 'string' ? doc.deviceId : '';
      if (owner !== deviceId) {
        return empty;
      }
      const files: Record<string, string> = doc.files === undefined || doc.files === null ? {} : doc.files;
      const result: AttachmentBaselineDoc = { deviceId: deviceId, files: files };
      return result;
    } catch (error) {
      return empty;
    }
  }

  /** 写本机附件基线（整份覆盖；调用方先读再改）。 */
  private writeBaseline(doc: AttachmentBaselineDoc): void {
    this.writeTextFile(this.stateFilePath(BASELINE_FILE_NAME), JSON.stringify(doc));
  }

  /** 记一个附件的基线 sha（本机写出的版本 / 推送成功后 / 拉取后看到的版本）。 */
  private recordBaselineEntry(relPath: string, sha: string): void {
    let deviceId: string = '';
    try {
      deviceId = normalizeDeviceId(this.config.deviceId);
    } catch (error) {
      return;
    }
    if (relPath.length === 0 || sha.length === 0) {
      return;
    }
    const doc: AttachmentBaselineDoc = this.readBaseline(deviceId);
    doc.files[relPath] = sha;
    this.writeBaseline(doc);
  }

  /** 本设备目录下的附件 zip 文件名（升序；目录不存在 → 空数组）。 */
  private listAttachmentArchives(deviceId: string): string[] {
    const dir: string = normalizePath(this.getRepoRoot() + '/' + devicePathPrefix(deviceId) + 'attachments');
    if (!this.fileExists(dir)) {
      return [];
    }
    let names: string[] = [];
    try {
      names = fs.listFileSync(dir);
    } catch (error) {
      return [];
    }
    names.sort();
    const archives: string[] = [];
    for (let index = 0; index < names.length; index++) {
      const name: string = names[index];
      if (name.toLowerCase().endsWith('.zip')) {
        archives.push(name);
      }
    }
    return archives;
  }

  /** 基线快照：把工作副本里当前所有附件 zip 的 sha 记成「已知状态」（拉取/推送成功后调）。 */
  private snapshotAttachmentBaselines(): void {
    let deviceId: string = '';
    try {
      deviceId = normalizeDeviceId(this.config.deviceId);
    } catch (error) {
      return;
    }
    const prefix: string = devicePathPrefix(deviceId);
    const dir: string = normalizePath(this.getRepoRoot() + '/' + prefix + 'attachments');
    const names: string[] = this.listAttachmentArchives(deviceId);
    if (names.length === 0) {
      return;
    }
    const doc: AttachmentBaselineDoc = this.readBaseline(deviceId);
    let changed: boolean = false;
    for (let index = 0; index < names.length; index++) {
      const name: string = names[index];
      const sha: string = this.sha256OfFile(dir + '/' + name);
      if (sha.length === 0) {
        continue;
      }
      const relPath: string = prefix + 'attachments/' + name;
      if (doc.files[relPath] !== sha) {
        doc.files[relPath] = sha;
        changed = true;
      }
    }
    if (changed) {
      this.writeBaseline(doc);
    }
  }

  /**
   * push 前的附件守卫（fail-closed）：把「可能被另一台设备改过」的 zip 临时挪出仓库。
   *
   * 为什么是「挪走」而不是「跳过提交」：桥的 push 会把 `devices/<id>/` 整个目录 add 进来，
   * 不挪走就无法保证它不被本次提交覆盖。挪走的文件在 push 结束后由 `restoreQuarantined` 放回。
   */
  private guardAttachmentsBeforePush(): PushAttachmentGuard {
    const guard: PushAttachmentGuard = { blocked: 0, reason: '', failure: '', moved: [] };
    let deviceId: string = '';
    try {
      deviceId = normalizeDeviceId(this.config.deviceId);
    } catch (error) {
      return guard;
    }
    const prefix: string = devicePathPrefix(deviceId);
    const dir: string = normalizePath(this.getRepoRoot() + '/' + prefix + 'attachments');
    if (!this.fileExists(dir)) {
      return guard;
    }
    const names: string[] = this.listAttachmentArchives(deviceId);
    if (names.length === 0) {
      return guard;
    }
    const local: string = normalizeFingerprint(this.fingerprintCache);
    const remote: string = this.readRepoFingerprint();
    const doc: AttachmentBaselineDoc = this.readBaseline(deviceId);
    const quarantineDir: string = this.stateFilePath(QUARANTINE_DIR_NAME + '/' + Date.now().toString());
    for (let index = 0; index < names.length; index++) {
      const name: string = names[index];
      const path: string = dir + '/' + name;
      if (!this.fileExists(path)) {
        continue;
      }
      const relPath: string = prefix + 'attachments/' + name;
      const baseline: string | null = doc.files[relPath] === undefined ? null : doc.files[relPath];
      const decision: AttachmentPushDecision = shouldBlockAttachmentPush({
        remoteSha: this.sha256OfFile(path),
        localBaselineSha: baseline,
        remoteFingerprint: remote,
        localFingerprint: local
      });
      if (!decision.block) {
        continue;
      }
      const target: string = quarantineDir + '/' + name;
      this.mkdirp(dirnameOf(target));
      try {
        fs.renameSync(path, target);
      } catch (error) {
        guard.failure = '附件守卫失败：无法暂存 ' + relPath + '，已停止推送以免覆盖（请重试）';
        return guard;
      }
      guard.blocked = guard.blocked + 1;
      if (guard.reason.length === 0) {
        guard.reason = decision.reason;
      }
      const moved: QuarantinedFile = { from: path, to: target };
      guard.moved.push(moved);
    }
    return guard;
  }

  /** 把 `guardAttachmentsBeforePush` 挪走的附件放回原位（push 的 finally 调用）。 */
  private restoreQuarantined(guard: PushAttachmentGuard): void {
    for (let index = 0; index < guard.moved.length; index++) {
      const item: QuarantinedFile = guard.moved[index];
      try {
        this.mkdirp(dirnameOf(item.from));
        fs.renameSync(item.to, item.from);
      } catch (error) {
        // 放回失败：文件仍在隔离目录（sync-quarantine），下次「拉取」会带回远端版本
      }
    }
  }

  // -------------------------------------------------------------- 宿主代理：HTTP（异步）

  /**
   * 桥发起的 HTTP 请求。请求完成（成功或失败）后统一通过
   * `controller.runJavaScript("window.DshGitBridge.onHttpResult(...)")` 回传。
   * 注意：token 只出现在 Authorization 头里，本方法不打印任何请求头。
   */
  httpRequest(id: string, optionsJson: string): void {
    let options: BridgeHttpOptions;
    try {
      options = JSON.parse(optionsJson) as BridgeHttpOptions;
    } catch (error) {
      this.deliverHttpFailure(id, '', 'E_HTTP', 'HTTP 请求参数不是合法 JSON');
      return;
    }
    const url: string = options.url === undefined ? '' : options.url;
    if (url.length === 0) {
      this.deliverHttpFailure(id, '', 'E_HTTP', 'HTTP 请求缺少 url');
      return;
    }
    const method: http.RequestMethod = mapHttpMethod(options.method === undefined ? 'GET' : options.method);
    const headers: Record<string, string> = options.headers === undefined ? EMPTY_HEADERS : options.headers;
    const bodyBase64: string = options.bodyBase64 === undefined ? '' : options.bodyBase64;
    const body: ArrayBuffer | string = bodyBase64.length > 0 ? this.decodeToArrayBuffer(bodyBase64) : '';
    const requestOptions: http.HttpRequestOptions = {
      method: method,
      header: headers,
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      connectTimeout: HTTP_CONNECT_TIMEOUT_MS,
      readTimeout: HTTP_READ_TIMEOUT_MS,
      extraData: body
    };
    const request: http.HttpRequest = http.createHttp();
    request.request(url, requestOptions).then((response: http.HttpResponse) => {
      const result: BridgeHttpResult = {
        id: id,
        url: url,
        statusCode: response.responseCode,
        statusMessage: statusTextOf(response.responseCode),
        headers: this.normalizeHeaders(response.header as Record<string, string>),
        bodyBase64: this.bodyToBase64(response.result)
      };
      this.safeDestroy(request);
      this.onHttpResult(JSON.stringify(result));
    }).catch((error: BusinessError) => {
      this.safeDestroy(request);
      this.deliverHttpFailure(id, url, 'E_HTTP', '网络请求失败：' + error.message);
    });
  }

  // -------------------------------------------------------------- 内部：桥调用

  private callBridge(op: string, args: Record<string, string>): Promise<BridgeEvent> {
    const id: string = 'g' + Date.now().toString() + '-' + (++this.requestSeq).toString();
    const request: BridgeCallRequest = { id: id, op: op, args: args };
    const payload: string = JSON.stringify(request);
    return new Promise<BridgeEvent>((resolve: (event: BridgeEvent) => void, reject: (error: Object) => void) => {
      const timer: number = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new SyncError(
            'E_GIT',
            '同步超时（' + (REQUEST_TIMEOUT_MS / 1000).toString() + ' 秒）：Web 页面可能未就绪或网络不可用'
          )
        );
      }, REQUEST_TIMEOUT_MS);
      const pending: PendingRequest = { resolve: resolve, reject: reject, timer: timer };
      this.pending.set(id, pending);
      this.runScript('window.DshGitBridge && window.DshGitBridge.call(' + JSON.stringify(payload) + ')');
    });
  }

  private runScript(script: string): void {
    try {
      this.controller.runJavaScript(script).catch(() => {
        // 页面已销毁/未加载完成：桥内有超时兜底，等待方会收到超时错误
      });
    } catch (error) {
      // 控制器未绑定：同上
    }
  }

  private deliverHttpFailure(id: string, url: string, code: string, message: string): void {
    const failure: BridgeHttpResult = {
      id: id,
      url: url,
      statusCode: 0,
      statusMessage: message,
      headers: EMPTY_HEADERS,
      bodyBase64: '',
      error: { code: code, message: message }
    };
    this.onHttpResult(JSON.stringify(failure));
  }

  private safeDestroy(request: http.HttpRequest): void {
    try {
      request.destroy();
    } catch (error) {
      // 已销毁/未开始：忽略
    }
  }

  private decodeToArrayBuffer(base64: string): ArrayBuffer {
    const decoded: Uint8Array = GitSyncService.base64().decodeSync(base64);
    const copy: Uint8Array = new Uint8Array(decoded.length);
    copy.set(decoded);
    return copy.buffer as ArrayBuffer;
  }

  private base64Text(text: string): string {
    const encoder: util.TextEncoder = new util.TextEncoder();
    return GitSyncService.base64().encodeToStringSync(encoder.encodeInto(text));
  }

  private bodyToBase64(result: ArrayBuffer | Object | string): string {
    if (result instanceof ArrayBuffer) {
      return GitSyncService.base64().encodeToStringSync(new Uint8Array(result));
    }
    if (typeof result === 'string') {
      return this.base64Text(result);
    }
    return '';
  }

  private normalizeHeaders(header: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    const keys: string[] = Object.keys(header);
    for (let index = 0; index < keys.length; index++) {
      const key: string = keys[index];
      result[key.toLowerCase()] = header[key];
    }
    return result;
  }

  private isDirectory(path: string): boolean {
    try {
      const info: fs.Stat = fs.statSync(path);
      return info.isDirectory();
    } catch (error) {
      return false;
    }
  }

  private resolveFilesDir(): string {
    const context: common.UIAbilityContext = getContext() as common.UIAbilityContext;
    return context.filesDir;
  }

  // -------------------------------------------------------------- 内部：配置与校验

  /**
   * 本次 HTTPS 认证使用的用户名。
   *
   * - 手填了用户名 → 一律用用户的（Gitee = 登录名；组织仓库时 owner 不是登录名，必须能手改）；
   * - 没填 → 按仓库地址推断（Gitee 取 owner），GitHub 等回落 `x-access-token`。
   */
  private authUsername(): string {
    const platform: string = this.config.platform === undefined ? '' : this.config.platform;
    const username: string = this.config.gitUsername === undefined ? '' : this.config.gitUsername;
    const inferred: string = httpsAuthUsername(platform, this.config.repoUrl, username);
    if (inferred.length > 0) {
      return inferred;
    }
    // 推不出来（Gitee 且地址不标准）：保持旧行为，由 assertHttpsUsername 给可读错误
    return resolveGitUsername(platform, username);
  }

  /** 生效分支名（空值回落 `main`；桥那边也有一层同样的兜底）。 */
  private branchName(): string {
    const branch: string = this.config.branch.trim();
    return branch.length > 0 ? branch : DEFAULT_BRANCH;
  }

  private configArgs(): Record<string, string> {
    const args: Record<string, string> = {
      'repoUrl': this.config.repoUrl,
      'branch': this.branchName(),
      'deviceId': this.config.deviceId,
      'token': this.config.token,
      'authorName': this.config.authorName,
      'authorEmail': this.config.authorEmail,
      // 桥的 onAuth 用这个用户名（Gitee = 登录名；GitHub = x-access-token）
      'username': this.authUsername()
    };
    return args;
  }

  private validateForSync(requireDeviceId: boolean = true): string {
    const config: GitSyncConfig = this.config;
    if (config.repoUrl.length === 0) {
      return '请先在设置页填写仓库地址（HTTPS）';
    }
    if (config.repoUrl.indexOf('https://') !== 0 && config.repoUrl.indexOf('http://') !== 0) {
      return '仓库地址必须以 https:// 开头（本应用不支持 SSH）';
    }
    // A1：认证方式。SSH 在本版本没有传输层（isomorphic-git 只实现 HTTP(S)），
    // 必须在发请求前拦住并说明原因，不能装作能同步。
    const authMode: string = config.authMode === undefined ? AUTH_HTTPS : config.authMode;
    const authBlocker: string = describeAuthModeBlocker(authMode);
    if (authBlocker.length > 0) {
      return authBlocker;
    }
    // A2：分支名。空/非法给可读错误（不再只是「请填写分支名」）。
    const branchProblem: string = validateBranchName(config.branch);
    if (branchProblem.length > 0) {
      return branchProblem;
    }
    if (requireDeviceId && config.deviceId.length === 0) {
      return '请填写设备标识（如 phone-a）';
    }
    if (requireDeviceId && !new RegExp(DEVICE_ID_PATTERN).test(config.deviceId)) {
      return '设备标识不合法：需小写字母/数字/短横线，1–32 位且以字母或数字开头';
    }
    if (config.token.length === 0) {
      return '请填写访问令牌（GitHub/Gitee Personal Access Token）';
    }
    // P0：Gitee 的 HTTPS 用户名必须=登录名（token 只作密码），不能兜底 x-access-token，
    // 否则一定 401。这里在**发请求前**拦住，任何情况下都不打网络。
    // 主表单不再要求手填用户名：能按仓库地址推断出 Gitee owner 时用推断值，推不出来才算问题。
    const usernameProblem: string | null = assertHttpsUsername(
      config.platform === undefined ? '' : config.platform,
      authMode,
      this.authUsername()
    );
    if (usernameProblem !== null) {
      return usernameProblem;
    }
    if (!this.ready) {
      return '同步页面尚未就绪：请等待 Web 组件加载完成（onPageEnd 会自动注册代理）';
    }
    return '';
  }

  private validateForStatus(): string {
    if (!this.ready) {
      return '同步页面尚未就绪：请等待 Web 组件加载完成（onPageEnd 会自动注册代理）';
    }
    return '';
  }

  // -------------------------------------------------------------- 内部：提交范围不变量

  /**
   * push 前的提交范围校验（fail-closed）：本设备目录下的**全部待提交路径**必须落在
   * `devices/<deviceId>/` 内。返回空串表示通过，否则返回中文原因。
   *
   * 步骤：设备标识严格规范化（非法直接失败）→ 枚举 `<repoRoot>/devices/<deviceId>/` 下文件
   * → 逐条 `assertWithinDevice` → `filterPathsForDevice` 与原始条数比对。
   * 任一断言失败都转成 `{ok:false, message}`（见 push 的调用点），不会发起网络请求。
   */
  private verifyPushScope(): string {
    let deviceId: string;
    let prefix: string;
    let paths: string[];
    try {
      deviceId = normalizeDeviceId(this.config.deviceId);
      prefix = devicePathPrefix(deviceId);
      paths = this.listDeviceRelativePaths(prefix);
    } catch (error) {
      return '提交路径校验失败：' + messageOf(error as Object);
    }
    if (paths.length === 0) {
      return '';
    }
    try {
      for (let index = 0; index < paths.length; index++) {
        assertWithinDevice(paths[index], deviceId);
      }
    } catch (error) {
      return '提交路径越界（只允许 ' + prefix + '）：' + messageOf(error as Object);
    }
    const scoped: string[] = filterPathsForDevice(paths, deviceId);
    if (scoped.length !== paths.length) {
      const outOfScope: number = paths.length - scoped.length;
      return '提交路径越界（只允许 ' + prefix + '）：' + outOfScope.toString() + ' 个待提交路径不在本设备目录内';
    }
    return '';
  }

  /** 递归列出本设备目录下所有文件（仓库相对路径、`/` 分隔、按名称升序）。 */
  private listDeviceRelativePaths(prefix: string): string[] {
    const root: string = this.getRepoRoot();
    const dir: string = normalizePath(root + '/' + prefix.replace(/\/$/, ''));
    const paths: string[] = [];
    this.walkDeviceFiles(dir, prefix, paths);
    return paths;
  }

  private walkDeviceFiles(dir: string, prefix: string, out: string[]): void {
    if (!this.fileExists(dir)) {
      return;
    }
    let names: string[] = [];
    try {
      names = fs.listFileSync(dir);
    } catch (error) {
      return;
    }
    names.sort();
    for (let index = 0; index < names.length; index++) {
      const name: string = names[index];
      // 文件名不允许带分隔符（理论上不会出现），出现即跳过，避免拼出越界路径
      if (name === '.' || name === '..' || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) {
        continue;
      }
      const child: string = dir + '/' + name;
      if (this.isDirectory(child)) {
        this.walkDeviceFiles(child, prefix + name + '/', out);
        continue;
      }
      out.push(prefix + name);
    }
  }

  // -------------------------------------------------------------- 内部：远端连通性探测

  /**
   * 用一次真实的 `GET <repo>/info/refs?service=git-upload-pack` 判断远端是否可连。
   * 200 = 可连；401/403 = 可连但 token 无效；404 = 仓库不存在；其它/异常 = 不可连。
   */
  private async probeRemote(): Promise<RemoteProbe> {
    const repoUrl: string = this.config.repoUrl;
    if (repoUrl.length === 0) {
      const missing: RemoteProbe = { reachable: false, statusCode: 0, detail: '未配置仓库地址' };
      return missing;
    }
    const base: string = repoUrl.replace(/\/+$/, '');
    const url: string = base + '/info/refs?service=git-upload-pack';
    const headers: Record<string, string> = { 'User-Agent': 'dsh-arkui-schedule' };
    if (this.config.token.length > 0) {
      headers['Authorization'] = 'Basic ' + this.base64Text(this.authUsername() + ':' + this.config.token);
    }
    const requestOptions: http.HttpRequestOptions = {
      method: http.RequestMethod.GET,
      header: headers,
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      connectTimeout: HTTP_CONNECT_TIMEOUT_MS,
      readTimeout: HTTP_READ_TIMEOUT_MS
    };
    const request: http.HttpRequest = http.createHttp();
    try {
      const response: http.HttpResponse = await request.request(url, requestOptions);
      const code: number = response.responseCode;
      if (code === 200) {
        const okProbe: RemoteProbe = { reachable: true, statusCode: code, detail: '可连接（HTTP 200）' };
        return okProbe;
      }
      if (code === 401 || code === 403) {
        const authProbe: RemoteProbe = {
          reachable: true,
          statusCode: code,
          detail: '可连接但认证失败（HTTP ' + code.toString() + '），请检查 token 权限'
        };
        return authProbe;
      }
      if (code === 404) {
        const notFound: RemoteProbe = {
          reachable: true,
          statusCode: code,
          detail: '可连接但仓库/分支不存在（HTTP 404）'
        };
        return notFound;
      }
      const other: RemoteProbe = {
        reachable: false,
        statusCode: code,
        detail: '远端返回 HTTP ' + code.toString()
      };
      return other;
    } catch (error) {
      const failedProbe: RemoteProbe = {
        reachable: false,
        statusCode: 0,
        detail: '不可连接（' + messageOf(error as Object) + '）'
      };
      return failedProbe;
    } finally {
      this.safeDestroy(request);
    }
  }
}

// ---------------------------------------------------------------- 结果描述辅助

function describePreserved(preserved: PreservePayload | null | undefined): string {
  if (preserved === undefined || preserved === null) {
    return '';
  }
  const restored: number = preserved.restored === undefined ? 0 : preserved.restored.length;
  const unioned: number = preserved.unioned === undefined ? 0 : preserved.unioned.length;
  if (restored === 0 && unioned === 0) {
    return '';
  }
  return '本机已有日程已保留（写回 ' + restored.toString() + ' 个文件、按行合并 ' + unioned.toString() + ' 个文件）';
}
