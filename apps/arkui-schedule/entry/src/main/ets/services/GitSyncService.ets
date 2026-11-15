/**
 * GitSyncService — ArkUI-X 日程助手的 Git 同步服务（ArkTS 侧）
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
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  assertWithinDevice,
  devicePathPrefix,
  filterPathsForDevice,
  normalizeDeviceId
} from '../model/syncScope';

// ---------------------------------------------------------------- 对外接口

export interface GitSyncConfig {
  /** HTTPS 仓库地址（GitHub/Gitee），不支持 SSH */
  repoUrl: string;
  /** 分支名，通常 main */
  branch: string;
  /** 设备标识，匹配 ^[a-z0-9][a-z0-9-]{0,31}$，决定 devices/<deviceId>/ 目录 */
  deviceId: string;
  /** Personal Access Token（只用于 HTTPS Basic 认证，不落盘、不进日志） */
  token: string;
  /** 提交作者名 */
  authorName: string;
  /** 提交作者邮箱 */
  authorEmail: string;
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
  branch?: string;
  head?: string;
  remoteUrl?: string;
  repoRoot?: string;
  changedCount?: number;
  lastCommit?: CommitPayload;
}

interface PullPayload {
  cloned?: boolean;
  branch?: string;
  head?: string;
  previousHead?: string;
  fastForward?: boolean;
  alreadyUpToDate?: boolean;
  url?: string;
  localPreserved?: PreservePayload;
}

interface PushPayload {
  branch?: string;
  deviceId?: string;
  files?: number;
  commit?: string;
  pushed?: boolean;
  message?: string;
}

interface RemoteProbe {
  reachable: boolean;
  statusCode: number;
  detail: string;
}

// ---------------------------------------------------------------- 常量

const REQUEST_TIMEOUT_MS: number = 60000;
const HTTP_CONNECT_TIMEOUT_MS: number = 15000;
const HTTP_READ_TIMEOUT_MS: number = 45000;
const REPO_DIR_NAME: string = 'git-repo';
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
    authorName: '日程助手',
    authorEmail: 'schedule@localhost'
  };
  private pending: Map<string, PendingRequest> = new Map<string, PendingRequest>();
  private requestSeq: number = 0;
  private ready: boolean = false;

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
  }

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
  registerProxy(): void {
    this.controller.registerJavaScriptProxy(this, BRIDGE_PROXY_NAME, GitSyncService.proxyMethodList);
    this.controller.refresh();
    this.ready = true;
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

  // -------------------------------------------------------------- 对外操作

  /** 拉取：本机无仓库时自动 clone；有仓库时 fetch + fast-forward（永不 merge）。 */
  async pull(): Promise<GitSyncResult> {
    const problem: string = this.validateForSync();
    if (problem.length > 0) {
      return rejected('拉取失败', problem);
    }
    try {
      const event: BridgeEvent = await this.callBridge('pull', this.configArgs());
      const data: PullPayload = event.data === undefined ? {} : event.data as PullPayload;
      const branch: string = data.branch === undefined ? this.config.branch : data.branch;
      const head: string = data.head === undefined ? '' : data.head;
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
      const result: GitSyncResult = { ok: true, message: message };
      if (head.length > 0) {
        result.commit = head;
      }
      return result;
    } catch (error) {
      return failed('拉取失败', error as Object);
    }
  }

  /** 推送：只 add + commit `devices/<deviceId>/`，再推 origin/<branch>；永不 force。 */
  async push(message: string): Promise<GitSyncResult> {
    const problem: string = this.validateForSync();
    if (problem.length > 0) {
      return rejected('推送失败', problem);
    }
    // 提交范围不变量（docs/DATA-CONTRACT.md §1/§6）：待提交路径越界一律拒绝，且不触碰网络
    const scopeProblem: string = this.verifyPushScope();
    if (scopeProblem.length > 0) {
      return rejected('推送失败', scopeProblem);
    }
    try {
      const args: Record<string, string> = this.configArgs();
      args['message'] = message.length > 0 ? message : '日程同步 ' + new Date().toISOString();
      const event: BridgeEvent = await this.callBridge('push', args);
      const data: PushPayload = event.data === undefined ? {} : event.data as PushPayload;
      const branch: string = data.branch === undefined ? this.config.branch : data.branch;
      const commit: string = data.commit === undefined ? '' : data.commit;
      const fileCount: number = data.files === undefined ? 0 : data.files;
      const pushed: boolean = data.pushed !== false;
      let detail: string = '文件 ' + fileCount.toString() + ' 个';
      if (commit.length > 0) {
        detail = detail + '，提交 ' + shortSha(commit);
      } else {
        detail = detail + '，无新提交';
      }
      const result: GitSyncResult = {
        ok: true,
        message: (pushed ? '推送完成' : '推送未完成') + '（分支 ' + branch + '，' + detail + '）'
      };
      if (commit.length > 0) {
        result.commit = commit;
      }
      return result;
    } catch (error) {
      return failed('推送失败', error as Object);
    }
  }

  /** 状态：当前分支 / HEAD / 本地改动 / 远端是否可连（真实发一次 info/refs 探测）。 */
  async status(): Promise<GitSyncResult> {
    const problem: string = this.validateForStatus();
    if (problem.length > 0) {
      return rejected('查询失败', problem);
    }
    try {
      const event: BridgeEvent = await this.callBridge('status', this.configArgs());
      const data: StatusPayload = event.data === undefined ? {} : event.data as StatusPayload;
      let message: string;
      if (data.initialized !== true) {
        message = '本机仓库尚未初始化（首次「拉取」会自动克隆）';
      } else {
        const branch: string = data.branch === undefined ? this.config.branch : data.branch;
        const head: string = data.head === undefined ? '' : data.head;
        const changed: number = data.changedCount === undefined ? 0 : data.changedCount;
        const remoteUrl: string = data.remoteUrl === undefined ? '' : data.remoteUrl;
        message = '分支 ' + branch + '｜HEAD ' + shortSha(head) + '｜本地改动 ' + changed.toString() + ' 处';
        message = message + '｜远端 ' + (remoteUrl.length > 0 ? '已配置' : '未配置');
        if (data.lastCommit !== undefined && data.lastCommit.message !== undefined) {
          message = message + '｜最近提交 ' + data.lastCommit.message;
        }
      }
      const probe: RemoteProbe = await this.probeRemote();
      const result: GitSyncResult = { ok: true, message: message + '｜连接 ' + probe.detail };
      return result;
    } catch (error) {
      return failed('查询失败', error as Object);
    }
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

  private configArgs(): Record<string, string> {
    const args: Record<string, string> = {
      'repoUrl': this.config.repoUrl,
      'branch': this.config.branch,
      'deviceId': this.config.deviceId,
      'token': this.config.token,
      'authorName': this.config.authorName,
      'authorEmail': this.config.authorEmail
    };
    return args;
  }

  private validateForSync(): string {
    const config: GitSyncConfig = this.config;
    if (config.repoUrl.length === 0) {
      return '请先在设置页填写仓库地址（HTTPS）';
    }
    if (config.repoUrl.indexOf('https://') !== 0 && config.repoUrl.indexOf('http://') !== 0) {
      return '仓库地址必须以 https:// 开头（本应用不支持 SSH）';
    }
    if (config.branch.length === 0) {
      return '请填写分支名（如 main）';
    }
    if (config.deviceId.length === 0) {
      return '请填写设备标识（如 phone-a）';
    }
    if (!new RegExp(DEVICE_ID_PATTERN).test(config.deviceId)) {
      return '设备标识不合法：需小写字母/数字/短横线，1–32 位且以字母或数字开头';
    }
    if (config.token.length === 0) {
      return '请填写访问令牌（GitHub/Gitee Personal Access Token）';
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
      headers['Authorization'] = 'Basic ' + this.base64Text('x-access-token:' + this.config.token);
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

function describePreserved(preserved: PreservePayload | undefined): string {
  if (preserved === undefined) {
    return '';
  }
  const restored: number = preserved.restored === undefined ? 0 : preserved.restored.length;
  const unioned: number = preserved.unioned === undefined ? 0 : preserved.unioned.length;
  if (restored === 0 && unioned === 0) {
    return '';
  }
  return '本机已有日程已保留（写回 ' + restored.toString() + ' 个文件、按行合并 ' + unioned.toString() + ' 个文件）';
}
