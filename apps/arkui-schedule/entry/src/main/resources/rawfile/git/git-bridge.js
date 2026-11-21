/*!
 * DSH ArkUI-X Git 同步桥（git-bridge.js）
 * ============================================================================
 * 运行位置：ArkUI-X `Web` 组件加载的 rawfile 页面（与 isomorphic-git.js 同目录）。
 * 职责：把 isomorphic-git 的 `fs` / `http` 插件接到 ArkTS 侧（GitSyncService.ets）的
 *       同步文件代理与异步 HTTP 代理上，并把每个操作的结果回传给 ArkTS。
 *
 * 加载顺序（index.html 内固定）：
 *   1) <script src="isomorphic-git.js">   -> 暴露全局 `git`（isomorphic-git 1.25.3 UMD）
 *   2) <script src="git-bridge.js">       -> 暴露 window.DshGitBridge
 *
 * 协议（ArkTS 与 JS 两侧严格一致）：
 *   请求：window.DshGitBridge.call(requestJson)
 *         requestJson = JSON.stringify({ id, op, args })
 *         op ∈ init | clone | fetch | pull | push | status | log | currentBranch | resolveRef
 *         call 只负责发起，**不返回值**；结果只通过宿主代理回传。
 *   结果：window.dshGitHost.onEvent(JSON.stringify({ id, ok: true,  data }))
 *         window.dshGitHost.onEvent(JSON.stringify({ id, ok: false, error: { code, message } }))
 *         code ∈ E_GIT | E_HTTP | E_AUTH | E_FS
 *
 * 文件系统代理（**同步**方法，桥内包成 Promise 以满足 isomorphic-git 的 fs.promises 语义）：
 *   dshGitHost.readFileBase64(path) -> string     不存在返回 ''（桥内先 fileExists 判定再抛 ENOENT）
 *   dshGitHost.writeFileBase64(path, base64) -> boolean
 *   dshGitHost.fileExists(path) -> boolean
 *   dshGitHost.mkdirp(path) -> boolean
 *   dshGitHost.readdir(path) -> string(JSON string[])
 *   dshGitHost.stat(path) -> string(JSON {mode,size,mtimeMs,type})   type ∈ file|dir|symlink
 *   dshGitHost.unlink(path) -> boolean
 *   dshGitHost.rename(oldPath, newPath) -> boolean
 *   dshGitHost.getRepoRoot() -> string  绝对路径（filesDir + '/git-repo'）
 *
 * HTTP 代理（**异步**）：
 *   桥内 http.request(opts) 调用 dshGitHost.httpRequest(id, optionsJson) 发起请求；
 *   ArkTS 完成请求后执行
 *     controller.runJavaScript("window.DshGitBridge.onHttpResult(" + json + ")")
 *   回传 { id, statusCode, statusMessage, headers, bodyBase64, url }（失败时可为 { id, error }）。
 *   桥内返回 { url, method, headers, statusCode, statusMessage, body: asyncIterator<Uint8Array> }。
 *
 * 同步范围约束：
 *   push 只 git.add + git.commit 路径限定 `devices/<deviceId>/`；
 *   fetch / pull 只读取其它设备目录，**从不 merge**（`pull` 固定 fastForwardOnly）。
 *
 * 分支（A2）：
 *   - 分支名来自 args.branch（默认 main），**从不 force 推送**（`pushPlan().force === false`）；
 *   - 首次推送时本地/远端分支可能还不存在：先 `ensureOnBranch()` 把 HEAD 换到目标分支
 *     （必要时 `writeRef refs/heads/<branch>`），提交后再补写一次分支引用，
 *     然后由 `git.push({ref})` 在远端**自动创建**同名分支，返回 `branchCreated` 说明是否新建；
 *   - `status` 额外返回 ahead/behind（`refs/heads/<branch>` 与 `refs/remotes/origin/<branch>`
 *     的提交集合差）与冲突数，供设置页展示「领先 / 落后 / 冲突」。
 *
 * 安全：token 只出现在 HTTP Authorization 头里，不写日志、不进 call 的返回值、不进错误信息
 *       （错误信息经 sanitizeMessage 二次脱敏）。
 * ============================================================================
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 常量

  var BRIDGE_VERSION = '1.0.0';
  var PROTOCOL_VERSION = 1;
  var HTTP_TIMEOUT_MS = 90000;
  var MAX_MESSAGE_LENGTH = 600;

  /** call/args 里允许携带的配置字段（token 永不回显）。 */
  // `username` 是 HTTPS 认证用户名（Gitee = 登录名，GitHub = x-access-token），由 ArkTS 侧解析后传入
  var CONFIG_KEYS = ['repoUrl', 'branch', 'deviceId', 'token', 'authorName', 'authorEmail', 'username'];

  var SUPPORTED_OPS = [
    'init',
    'clone',
    'fetch',
    'pull',
    'push',
    'commitPaths',
    'status',
    'log',
    'currentBranch',
    'resolveRef',
    'v2Git',
    'zipUpsert',
    'zipList',
    'zipRead',
    'zipWrite'
  ];

  var DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

  /**
   * `commitPaths` 允许提交的共享文件白名单（设备登记表）。
   *
   * 与 `push` 的「只能写 `devices/<deviceId>/`」互补：登记表在 `devices/` 下，
   * 它必须能被所有设备追加写入，所以单列一份白名单（仍然拒绝任意路径）。
   */
  var COMMIT_PATH_WHITELIST = ['devices/registry.jsonl'];
  var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_LOOKUP = (function () {
    var table = Object.create(null);
    for (var i = 0; i < B64_CHARS.length; i++) {
      table[B64_CHARS.charAt(i)] = i;
    }
    // 容忍 URL-safe base64
    table['-'] = 62;
    table['_'] = 63;
    return table;
  })();

  // ---------------------------------------------------------------- 基础编码

  function bytesToBase64(bytes) {
    if (!bytes || bytes.length === 0) {
      return '';
    }
    var out = '';
    var len = bytes.length;
    var i = 0;
    for (; i + 2 < len; i += 3) {
      var triple = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out +=
        B64_CHARS.charAt((triple >> 18) & 63) +
        B64_CHARS.charAt((triple >> 12) & 63) +
        B64_CHARS.charAt((triple >> 6) & 63) +
        B64_CHARS.charAt(triple & 63);
    }
    var rest = len - i;
    if (rest === 1) {
      var one = bytes[i] << 16;
      out += B64_CHARS.charAt((one >> 18) & 63) + B64_CHARS.charAt((one >> 12) & 63) + '==';
    } else if (rest === 2) {
      var two = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out +=
        B64_CHARS.charAt((two >> 18) & 63) +
        B64_CHARS.charAt((two >> 12) & 63) +
        B64_CHARS.charAt((two >> 6) & 63) +
        '=';
    }
    return out;
  }

  function base64ToBytes(text) {
    if (text === undefined || text === null || text === '') {
      return new Uint8Array(0);
    }
    var source = String(text).replace(/[\s]/g, '');
    while (source.length > 0 && source.charAt(source.length - 1) === '=') {
      source = source.slice(0, -1);
    }
    var out = new Uint8Array(Math.floor((source.length * 6) / 8));
    var buffer = 0;
    var bits = 0;
    var pos = 0;
    for (var i = 0; i < source.length; i++) {
      var value = B64_LOOKUP[source.charAt(i)];
      if (value === undefined) {
        throw bridgeError('E_FS', 'base64 解码失败：包含非法字符');
      }
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[pos] = (buffer >> bits) & 255;
        pos++;
      }
    }
    return pos === out.length ? out : out.subarray(0, pos);
  }

  function utf8Encode(text) {
    var source = String(text === undefined || text === null ? '' : text);
    var out = new Uint8Array(source.length * 3);
    var pos = 0;
    for (var i = 0; i < source.length; i++) {
      var code = source.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
        var low = source.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
          i++;
        }
      }
      if (code < 0x80) {
        out[pos++] = code;
      } else if (code < 0x800) {
        out[pos++] = 0xc0 | (code >> 6);
        out[pos++] = 0x80 | (code & 0x3f);
      } else if (code < 0x10000) {
        out[pos++] = 0xe0 | (code >> 12);
        out[pos++] = 0x80 | ((code >> 6) & 0x3f);
        out[pos++] = 0x80 | (code & 0x3f);
      } else {
        out[pos++] = 0xf0 | (code >> 18);
        out[pos++] = 0x80 | ((code >> 12) & 0x3f);
        out[pos++] = 0x80 | ((code >> 6) & 0x3f);
        out[pos++] = 0x80 | (code & 0x3f);
      }
    }
    return out.subarray(0, pos);
  }

  function utf8Decode(bytes) {
    if (!bytes || bytes.length === 0) {
      return '';
    }
    var out = '';
    var i = 0;
    while (i < bytes.length) {
      var first = bytes[i++];
      var code;
      if (first < 0x80) {
        code = first;
      } else if (first >= 0xc0 && first < 0xe0) {
        code = ((first & 0x1f) << 6) | (bytes[i++] & 0x3f);
      } else if (first >= 0xe0 && first < 0xf0) {
        code = ((first & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      } else {
        code =
          ((first & 0x07) << 18) |
          ((bytes[i++] & 0x3f) << 12) |
          ((bytes[i++] & 0x3f) << 6) |
          (bytes[i++] & 0x3f);
      }
      if (code > 0xffff) {
        code -= 0x10000;
        out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
      } else {
        out += String.fromCharCode(code);
      }
    }
    return out;
  }

  function toBytes(data) {
    if (data === undefined || data === null) {
      return new Uint8Array(0);
    }
    if (data instanceof Uint8Array) {
      return data;
    }
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (typeof data === 'string') {
      return utf8Encode(data);
    }
    if (typeof data === 'object' && typeof data.length === 'number') {
      var out = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) {
        out[i] = Number(data[i]) & 255;
      }
      return out;
    }
    throw bridgeError('E_FS', '不支持的文件写入数据类型：' + typeof data);
  }

  function concatBytes(chunks, total) {
    var out = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  // ---------------------------------------------------------------- 路径（统一 '/'，isomorphic-git 用 posix 语义）

  function normalizePath(path) {
    var text = String(path === undefined || path === null ? '' : path).replace(/\\/g, '/');
    text = text.replace(/\/{2,}/g, '/');
    if (text.length > 1 && text.charAt(text.length - 1) === '/') {
      text = text.slice(0, -1);
    }
    return text;
  }

  function pathJoin(base, child) {
    var left = normalizePath(base);
    var right = normalizePath(child);
    if (right === '') {
      return left;
    }
    if (right.charAt(0) === '/') {
      return right;
    }
    return normalizePath(left + '/' + right);
  }

  function pathDirname(path) {
    var text = normalizePath(path);
    var index = text.lastIndexOf('/');
    if (index < 0) {
      return '.';
    }
    if (index === 0) {
      return '/';
    }
    return text.slice(0, index);
  }

  // ---------------------------------------------------------------- 错误

  function bridgeError(code, message) {
    var error = new Error(String(message === undefined ? '' : message));
    error.code = code;
    error.isBridgeError = true;
    return error;
  }

  var SECRET_PATTERNS = [
    /(Basic\s+)[A-Za-z0-9+/=._~-]{8,}/g,
    /(Bearer\s+)[A-Za-z0-9+/=._~-]{8,}/g,
    /(x-access-token:)[^\s"',;]+/g,
    /((?:token|secret|password|access_token)=)[^\s"'&,;]+/gi
  ];

  /** 错误信息二次脱敏（token 永不进日志/错误信息）。 */
  function sanitizeMessage(raw) {
    var text = String(raw === undefined || raw === null ? '' : raw);
    for (var i = 0; i < SECRET_PATTERNS.length; i++) {
      text = text.replace(SECRET_PATTERNS[i], '$1***');
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      text = text.slice(0, MAX_MESSAGE_LENGTH) + '…';
    }
    return text;
  }

  /** 把 isomorphic-git / 宿主异常统一成 { code ∈ E_GIT|E_HTTP|E_AUTH|E_FS, message 中文 }。 */
  function normalizeError(error) {
    if (!error) {
      return bridgeError('E_GIT', '未知错误');
    }
    if (error.isBridgeError === true) {
      return error;
    }
    var name = String((error && (error.code || error.name)) || '');
    var message = sanitizeMessage(error && error.message !== undefined ? error.message : error);
    var statusCode =
      error && error.data && typeof error.data.statusCode === 'number' ? error.data.statusCode : null;

    if (name === 'HttpError' || statusCode !== null) {
      var code = statusCode === null ? 0 : statusCode;
      if (code === 401 || code === 403 || code === 203) {
        return bridgeError(
          'E_AUTH',
          '认证失败（HTTP ' + code + '）：请检查访问令牌是否有效、是否有该仓库的读写权限'
        );
      }
      if (code === 404) {
        return bridgeError('E_HTTP', '远端返回 404：仓库地址或分支不存在，或令牌无权访问私有仓库');
      }
      if (code >= 500 && code < 600) {
        return bridgeError('E_HTTP', '远端服务异常（HTTP ' + code + '），请稍后重试');
      }
      if (code === 0) {
        return bridgeError('E_HTTP', '网络请求失败：' + message);
      }
      return bridgeError('E_HTTP', '远端返回 HTTP ' + code + '：' + message);
    }
    if (/AuthCancelled|AuthFailed|AuthError|AuthenticationError|UnauthorizedError|InvalidAuth|UserCanceled/.test(name)) {
      return bridgeError('E_AUTH', '认证失败：请在设置页填写有效的 HTTPS 访问令牌（GitHub/Gitee Personal Access Token）');
    }
    if (/PushRejected/.test(name)) {
      return bridgeError('E_GIT', '推送被拒绝：远端已有新提交。请先执行「拉取」，本应用不会强制覆盖远端');
    }
    if (/MergeConflict|MergeNotSupported|CheckoutConflict|UnmergedPaths/.test(name)) {
      return bridgeError('E_GIT', '存在冲突：本应用不执行自动合并，请在其它设备完成提交后再拉取');
    }
    if (/FastForward/.test(name)) {
      return bridgeError(
        'E_GIT',
        '无法快进合并：本机与远端已分叉。本应用不执行自动合并，请检查设备目录是否被其它设备写入'
      );
    }
    if (/NothingToCommit/.test(name)) {
      return bridgeError('E_GIT', '没有需要提交的改动');
    }
    if (/NotFound|ResolveRef|NoRefspec|RemoteCapability/.test(name)) {
      return bridgeError('E_GIT', '远端仓库为空，或分支/引用不存在：' + message);
    }
    if (/MissingParameter|InvalidParameter|InvalidFilepath|UnsafeFilepath|InternalError|UnknownTransport|InvalidRefName/.test(name)) {
      return bridgeError('E_GIT', 'Git 调用参数错误：' + message);
    }
    if (name === 'ENOENT' || name === 'ENOTDIR') {
      return bridgeError('E_FS', '文件不存在：' + message);
    }
    if (/^E[A-Z]+$/.test(name) || /EACCES|EPERM|EIO|EBUSY/.test(name)) {
      return bridgeError('E_FS', '本地文件读写失败：' + message);
    }
    // 证书 / DNS 是「确定性的环境问题」，给一句能照着排查的中文，别让用户只看到英文异常
    if (/CERT_|ERR_CERT|SSL|TLS|certificate|证书|self.?signed|UNABLE_TO_VERIFY/i.test(message)) {
      return bridgeError('E_HTTP', '证书错误（HTTPS 校验未通过）：' + message);
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|nodename nor servname|域名解析|无法解析域名|DNS 解析/i.test(message)) {
      return bridgeError('E_HTTP', '域名解析失败（DNS）：' + message);
    }
    return bridgeError('E_GIT', 'Git 操作失败：' + message);
  }

  // ---------------------------------------------------------------- 宿主代理

  function getHost() {
    var host = global.dshGitHost;
    if (!host || typeof host !== 'object') {
      throw bridgeError(
        'E_FS',
        '宿主代理 dshGitHost 未注册：请在 Web 页面 onPageEnd 后调用 GitSyncService.registerProxy()'
      );
    }
    return host;
  }

  function hostCall(name, args) {
    var host = getHost();
    var method = host[name];
    if (typeof method !== 'function') {
      throw bridgeError('E_FS', '宿主代理缺少方法：' + name);
    }
    try {
      return method.apply(host, args || []);
    } catch (error) {
      if (error && error.isBridgeError === true) {
        throw error;
      }
      throw bridgeError(
        'E_FS',
        '本地文件操作失败（' + name + '）：' + sanitizeMessage(error && error.message !== undefined ? error.message : error)
      );
    }
  }

  function emitResult(id, error, data) {
    var payload;
    if (error) {
      payload = {
        id: id,
        ok: false,
        error: { code: error.code || 'E_GIT', message: sanitizeMessage(error.message) }
      };
    } else {
      payload = { id: id, ok: true, data: data === undefined ? null : data };
    }
    try {
      hostCall('onEvent', [JSON.stringify(payload)]);
    } catch (ignored) {
      // 宿主已不可用（页面销毁等）：没有回传通道，只能丢弃本次结果
    }
  }

  // ---------------------------------------------------------------- 会话状态

  var session = {
    config: Object.create(null),
    repoRoot: null,
    fs: null,
    http: null,
    queue: Promise.resolve(),
    httpSeq: 0,
    pendingHttp: Object.create(null)
  };

  function applyConfig(args) {
    for (var i = 0; i < CONFIG_KEYS.length; i++) {
      var key = CONFIG_KEYS[i];
      if (args && args[key] !== undefined && args[key] !== null) {
        session.config[key] = args[key];
      }
    }
    return session.config;
  }

  function gitApi() {
    var git = global.git;
    if (!git || typeof git.clone !== 'function') {
      throw bridgeError(
        'E_GIT',
        'isomorphic-git 未加载：index.html 必须先加载 isomorphic-git.js 再加载 git-bridge.js'
      );
    }
    return git;
  }

  function ensureRepo() {
    if (session.repoRoot !== null) {
      return session.repoRoot;
    }
    var root = hostCall('getRepoRoot', []);
    if (typeof root !== 'string' || root.length === 0) {
      throw bridgeError('E_FS', '宿主返回的仓库根目录为空');
    }
    session.repoRoot = normalizePath(root);
    session.fs = createFs();
    session.http = createHttp();
    return session.repoRoot;
  }

  function repoInitialized() {
    try {
      return hostCall('fileExists', [pathJoin(session.repoRoot, '.git')]) === true;
    } catch (error) {
      return false;
    }
  }

  function authorOf(config) {
    return {
      name: (config && config.authorName) || 'DSH-Dots',
      email: (config && config.authorEmail) || 'schedule@localhost'
    };
  }

  async function currentBranchOf(git) {
    try {
      var branch = await git.currentBranch({ fs: session.fs, dir: session.repoRoot, fullname: false });
      return branch === undefined || branch === null ? null : String(branch);
    } catch (error) {
      return null;
    }
  }

  async function resolveHead(git) {
    try {
      var oid = await git.resolveRef({ fs: session.fs, dir: session.repoRoot, ref: 'HEAD' });
      return oid === undefined || oid === null ? null : String(oid);
    } catch (error) {
      return null;
    }
  }

  function isoFromSeconds(seconds) {
    var value = typeof seconds === 'number' ? seconds : 0;
    var date = new Date(value * 1000);
    return isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function mapCommit(item) {
    var commit = (item && item.commit) || {};
    var author = commit.author || commit.committer || {};
    return {
      sha: item && item.oid ? String(item.oid) : '',
      message: String(commit.message === undefined ? '' : commit.message).replace(/\n+$/, ''),
      author: String(author.name === undefined ? '' : author.name),
      email: String(author.email === undefined ? '' : author.email),
      time: isoFromSeconds(author.timestamp)
    };
  }

  function normalizeDepth(value) {
    var depth = typeof value === 'number' && isFinite(value) ? Math.floor(value) : 10;
    if (depth < 1) {
      depth = 1;
    }
    if (depth > 200) {
      depth = 200;
    }
    return depth;
  }

  // ---------------------------------------------------------------- 分支与 ahead/behind（A2）

  /** 计算 ahead/behind 时读取的提交条数上限（超出部分按「下界」处理，不联网、不读 packfile）。 */
  var BRANCH_LOG_DEPTH = 500;

  /**
   * 由「本地分支提交 sha 列表」与「远端分支提交 sha 列表」算 ahead/behind。
   *
   * 纯函数（与 ArkTS 侧 `model/syncError.ts` 的 `computeAheadBehind` 同一口径）：
   * 只看集合差，重复 sha 只算一次；两侧列表通常来自 `git.log`（新到旧），结果与顺序无关。
   */
  function computeAheadBehind(localShas, remoteShas) {
    var local = Array.isArray(localShas) ? localShas : [];
    var remote = Array.isArray(remoteShas) ? remoteShas : [];
    var remoteSet = Object.create(null);
    var localSet = Object.create(null);
    var i;
    for (i = 0; i < remote.length; i++) {
      var remoteSha = String(remote[i] === undefined || remote[i] === null ? '' : remote[i]).trim();
      if (remoteSha.length > 0) {
        remoteSet[remoteSha] = true;
      }
    }
    for (i = 0; i < local.length; i++) {
      var localSha = String(local[i] === undefined || local[i] === null ? '' : local[i]).trim();
      if (localSha.length > 0) {
        localSet[localSha] = true;
      }
    }
    var ahead = 0;
    var behind = 0;
    var key;
    for (key in localSet) {
      if (remoteSet[key] !== true) {
        ahead++;
      }
    }
    for (key in remoteSet) {
      if (localSet[key] !== true) {
        behind++;
      }
    }
    return {
      ahead: ahead,
      behind: behind,
      diverged: ahead > 0 && behind > 0,
      comparable: Object.keys(localSet).length > 0 || Object.keys(remoteSet).length > 0
    };
  }

  /**
   * 从 `git.statusMatrix()` 估冲突条目数。
   *
   * isomorphic-git 的 statusMatrix 没有「未合并」标记，这里用最接近的启发式：
   * HEAD / 工作区 / 暂存区**三者互不相同**（文件在三个地方都不一样）才算冲突。
   * 本应用从不 merge（pull 固定 fastForwardOnly），所以正常情况恒为 0；
   * 只有外部工具在仓库目录里做过合并才会出现。
   */
  function countConflicts(matrix) {
    if (!Array.isArray(matrix)) {
      return 0;
    }
    var conflicts = 0;
    for (var i = 0; i < matrix.length; i++) {
      var row = matrix[i];
      if (!Array.isArray(row) || row.length < 4) {
        continue;
      }
      var head = row[1];
      var workdir = row[2];
      var stage = row[3];
      if (head !== workdir && head !== stage && workdir !== stage) {
        conflicts++;
      }
    }
    return conflicts;
  }

  /**
   * 推送参数（纯函数）：远端 origin、ref 是分支名、**force 恒为 false**。
   *
   * 单测直接断言这个对象，防止以后有人为了「推上去就行」加上 `force: true`
   * （本应用的契约是永不覆盖远端历史）。
   */
  function pushPlan(branch) {
    var name = typeof branch === 'string' && branch.length > 0 ? branch : 'main';
    return { remote: 'origin', ref: name, refspec: 'refs/heads/' + name, force: false };
  }

  /** 读某 ref 的 oid；不存在/读失败返回 null（分支可能还没建，不抛）。 */
  async function refOid(git, ref) {
    try {
      var oid = await git.resolveRef({ fs: session.fs, dir: session.repoRoot, ref: ref });
      return oid === undefined || oid === null ? null : String(oid);
    } catch (error) {
      return null;
    }
  }

  /** 读某 ref 的提交 sha 列表（读不到返回空数组）。 */
  async function logShas(git, ref) {
    try {
      var commits = await git.log({ fs: session.fs, dir: session.repoRoot, ref: ref, depth: BRANCH_LOG_DEPTH });
      var shas = [];
      for (var i = 0; i < commits.length; i++) {
        var oid = commits[i] && commits[i].oid ? String(commits[i].oid) : '';
        if (oid.length > 0) {
          shas.push(oid);
        }
      }
      return shas;
    } catch (error) {
      return [];
    }
  }

  /**
   * 本地分支 + 远端跟踪分支的状态：是否存在、oid、ahead/behind。
   *
   * ahead = 本地独有提交数（该推的量），behind = 远端独有提交数（该拉的量）。
   */
  async function branchState(git, branch) {
    var name = typeof branch === 'string' && branch.length > 0 ? branch : 'main';
    var localRef = 'refs/heads/' + name;
    var remoteRef = 'refs/remotes/origin/' + name;
    var localOid = await refOid(git, localRef);
    var remoteOid = await refOid(git, remoteRef);
    var localShas = localOid === null ? [] : await logShas(git, localRef);
    var remoteShas = remoteOid === null ? [] : await logShas(git, remoteRef);
    var range = computeAheadBehind(localShas, remoteShas);
    return {
      branch: name,
      localRef: localRef,
      remoteRef: remoteRef,
      localBranchExists: localOid !== null,
      remoteBranchExists: remoteOid !== null,
      localBranchOid: localOid,
      remoteBranchOid: remoteOid,
      ahead: range.ahead,
      behind: range.behind,
      diverged: range.diverged,
      comparable: range.comparable,
      localCommitCount: localShas.length,
      remoteCommitCount: remoteShas.length
    };
  }

  /**
   * 把 HEAD 换到目标分支（拉取/推送前调用），必要时先建出本地分支。
   *
   * 顺序：已在目标分支 → 什么都不做；本地有该分支 → checkout；本地没有但远端有 →
   * `writeRef refs/heads/<branch>` 指向远端 oid 再 checkout；都没有（空仓库）→
   * 返回 `from: 'empty'`，等提交后再由 `opPush` 补写引用。
   */
  async function ensureOnBranch(git, branch) {
    var name = branch;
    var current = await currentBranchOf(git);
    if (current === name) {
      return { switched: false, createdLocalBranch: false, current: current, from: 'current' };
    }
    var localOid = await refOid(git, 'refs/heads/' + name);
    if (localOid !== null) {
      await git.checkout({ fs: session.fs, dir: session.repoRoot, ref: name });
      return { switched: true, createdLocalBranch: false, current: name, from: 'local' };
    }
    var base = await refOid(git, 'refs/remotes/origin/' + name);
    var from = 'remote';
    if (base === null) {
      base = await refOid(git, 'HEAD');
      from = 'head';
    }
    if (base === null) {
      return { switched: false, createdLocalBranch: false, current: current, from: 'empty' };
    }
    await git.writeRef({ fs: session.fs, dir: session.repoRoot, ref: 'refs/heads/' + name, value: base, force: true });
    await git.checkout({ fs: session.fs, dir: session.repoRoot, ref: name });
    return { switched: true, createdLocalBranch: true, current: name, from: from };
  }

  // ---------------------------------------------------------------- fs 适配器

  function enoentError(target) {
    var error = new Error("ENOENT: no such file or directory, open '" + target + "'");
    error.code = 'ENOENT';
    return error;
  }

  /** fs.readFile 的 options 是否要求文本结果（isomorphic-git 用 {encoding:'utf8'} 读 config/refs）。 */
  function wantsText(options) {
    if (typeof options === 'string') {
      return options.length > 0;
    }
    return !!(options && typeof options === 'object' && typeof options.encoding === 'string' && options.encoding.length > 0);
  }

  function parseNames(raw) {
    var value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value.length !== 'number') {
      throw bridgeError('E_FS', '宿主 readdir 返回的不是数组');
    }
    var names = [];
    for (var i = 0; i < value.length; i++) {
      if (typeof value[i] === 'string') {
        names.push(value[i]);
      }
    }
    return names;
  }

  function makeStatObject(info, target) {
    var type = info && typeof info.type === 'string' ? info.type : 'file';
    var mode = info && typeof info.mode === 'number' && info.mode > 0 ? info.mode : 0;
    if (mode === 0) {
      mode = type === 'dir' ? 0o40000 : type === 'symlink' ? 0o120000 : 0o100644;
    }
    var size = info && typeof info.size === 'number' ? info.size : 0;
    var mtimeMs = info && typeof info.mtimeMs === 'number' ? info.mtimeMs : 0;
    return {
      path: target,
      type: type,
      mode: mode,
      size: size,
      mtimeMs: mtimeMs,
      mtime: new Date(mtimeMs),
      ctimeMs: mtimeMs,
      ctime: new Date(mtimeMs),
      birthtimeMs: mtimeMs,
      ino: 0,
      dev: 0,
      uid: 0,
      gid: 0,
      isFile: function () {
        return type === 'file';
      },
      isDirectory: function () {
        return type === 'dir';
      },
      isSymbolicLink: function () {
        return type === 'symlink';
      },
      isBlockDevice: function () {
        return false;
      },
      isCharacterDevice: function () {
        return false;
      },
      isFIFO: function () {
        return false;
      },
      isSocket: function () {
        return false;
      }
    };
  }

  function readHostStat(target) {
    if (hostCall('fileExists', [target]) !== true) {
      return null;
    }
    var raw = hostCall('stat', [target]);
    var info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return makeStatObject(info, target);
  }

  function readHostFileBase64(target) {
    if (hostCall('fileExists', [target]) !== true) {
      return null;
    }
    var encoded = hostCall('readFileBase64', [target]);
    return typeof encoded === 'string' ? encoded : null;
  }

  function listFilesRecursive(absoluteDir, relativePrefix) {
    var names;
    try {
      names = parseNames(hostCall('readdir', [absoluteDir]));
    } catch (error) {
      return [];
    }
    names.sort();
    var collected = [];
    for (var i = 0; i < names.length; i++) {
      var childAbsolute = pathJoin(absoluteDir, names[i]);
      var childRelative = relativePrefix === '' ? names[i] : relativePrefix + '/' + names[i];
      var stat = readHostStat(childAbsolute);
      if (stat === null) {
        continue;
      }
      if (stat.isDirectory()) {
        var nested = listFilesRecursive(childAbsolute, childRelative);
        for (var j = 0; j < nested.length; j++) {
          collected.push(nested[j]);
        }
      } else {
        collected.push(childRelative);
      }
    }
    return collected;
  }

  function listDeviceFiles(deviceId) {
    var relativeDir = 'devices/' + deviceId;
    return listFilesRecursive(pathJoin(session.repoRoot, relativeDir), relativeDir);
  }

  function createFs() {
    function readFile(path, options) {
      return Promise.resolve().then(function () {
        var target = normalizePath(path);
        if (hostCall('fileExists', [target]) !== true) {
          throw enoentError(target);
        }
        var encoded = hostCall('readFileBase64', [target]);
        if (typeof encoded !== 'string') {
          throw enoentError(target);
        }
        if (encoded.length === 0) {
          // 空字符串既可能是空文件，也可能是宿主读失败：再判一次存在性
          if (hostCall('fileExists', [target]) !== true) {
            throw enoentError(target);
          }
          return wantsText(options) ? '' : new Uint8Array(0);
        }
        var bytes = base64ToBytes(encoded);
        // isomorphic-git 读 .git/config、packed-refs、refs/*、shallow 时带 {encoding:'utf8'}，
        // 期望拿到字符串（Buffer 会走进 GitConfig 的 split 分支而崩溃）
        return wantsText(options) ? utf8Decode(bytes) : bytes;
      });
    }

    function writeFile(path, data) {
      return Promise.resolve().then(function () {
        var target = normalizePath(path);
        var parent = pathDirname(target);
        if (parent !== '.' && parent !== '/') {
          hostCall('mkdirp', [parent]);
        }
        var encoded = bytesToBase64(toBytes(data));
        var ok = hostCall('writeFileBase64', [target, encoded]);
        if (ok === false) {
          throw bridgeError('E_FS', '写入文件失败：' + target);
        }
        return true;
      });
    }

    function unlink(path) {
      return Promise.resolve().then(function () {
        var target = normalizePath(path);
        var ok = hostCall('unlink', [target]);
        if (ok === false) {
          if (hostCall('fileExists', [target]) !== true) {
            throw enoentError(target);
          }
          throw bridgeError('E_FS', '删除文件失败：' + target);
        }
        return true;
      });
    }

    function readdir(path) {
      return Promise.resolve().then(function () {
        var target = normalizePath(path);
        return parseNames(hostCall('readdir', [target]));
      });
    }

    function mkdir(path) {
      return Promise.resolve().then(function () {
        hostCall('mkdirp', [normalizePath(path)]);
        return true;
      });
    }

    function purge(target) {
      var names;
      try {
        names = parseNames(hostCall('readdir', [target]));
      } catch (error) {
        return;
      }
      for (var i = 0; i < names.length; i++) {
        var child = pathJoin(target, names[i]);
        var stat = readHostStat(child);
        if (stat === null) {
          continue;
        }
        if (stat.isDirectory()) {
          purge(child);
        } else {
          try {
            hostCall('unlink', [child]);
          } catch (ignored) {
            // 尽力删除；宿主没有 rmdir，目录条目本身删不掉，但 git 流程不依赖它
          }
        }
      }
    }

    function rmdir(path) {
      return Promise.resolve().then(function () {
        purge(normalizePath(path));
        return true;
      });
    }

    function stat(path) {
      return Promise.resolve().then(function () {
        var target = normalizePath(path);
        var built = readHostStat(target);
        if (built === null) {
          throw enoentError(target);
        }
        return built;
      });
    }

    function readlink(path) {
      return Promise.reject(
        bridgeError('E_FS', '本机文件桥不支持符号链接读取：' + normalizePath(path))
      );
    }

    function symlink(linkTarget, path) {
      return Promise.reject(
        bridgeError('E_FS', '本机文件桥不支持符号链接写入：' + normalizePath(path))
      );
    }

    function rename(oldPath, newPath) {
      return Promise.resolve().then(function () {
        var from = normalizePath(oldPath);
        var to = normalizePath(newPath);
        var parent = pathDirname(to);
        if (parent !== '.' && parent !== '/') {
          hostCall('mkdirp', [parent]);
        }
        if (hostCall('rename', [from, to]) === false) {
          throw bridgeError('E_FS', '重命名失败：' + from + ' → ' + to);
        }
        return true;
      });
    }

    return {
      readFile: readFile,
      writeFile: writeFile,
      unlink: unlink,
      readdir: readdir,
      mkdir: mkdir,
      rmdir: rmdir,
      stat: stat,
      lstat: stat,
      readlink: readlink,
      symlink: symlink,
      rename: rename
    };
  }

  // ---------------------------------------------------------------- http 适配器

  function lowerHeaders(headers) {
    var out = Object.create(null);
    if (!headers || typeof headers !== 'object') {
      return out;
    }
    for (var key in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, key)) {
        continue;
      }
      var value = headers[key];
      if (value === undefined || value === null) {
        continue;
      }
      out[String(key).toLowerCase()] = String(value);
    }
    return out;
  }

  function byteStream(bytes) {
    var consumed = false;
    var stream = {
      next: function () {
        if (consumed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        consumed = true;
        return Promise.resolve({ done: false, value: bytes });
      },
      return: function () {
        consumed = true;
        return Promise.resolve({ done: true, value: undefined });
      },
      throw: function (error) {
        consumed = true;
        return Promise.reject(error);
      }
    };
    if (typeof Symbol !== 'undefined' && Symbol.asyncIterator) {
      stream[Symbol.asyncIterator] = function () {
        return stream;
      };
    }
    return stream;
  }

  function collectBody(body) {
    return new Promise(function (resolve, reject) {
      try {
        if (body === undefined || body === null) {
          resolve(new Uint8Array(0));
          return;
        }
        if (body instanceof Uint8Array) {
          resolve(body);
          return;
        }
        if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
          resolve(new Uint8Array(body));
          return;
        }
        if (typeof body === 'string') {
          resolve(utf8Encode(body));
          return;
        }
        var hasAsync = typeof Symbol !== 'undefined' && Symbol.asyncIterator && typeof body[Symbol.asyncIterator] === 'function';
        var hasSync = typeof Symbol !== 'undefined' && Symbol.iterator && typeof body[Symbol.iterator] === 'function';
        if (typeof body.next === 'function' || hasAsync || hasSync) {
          var iterator = hasAsync ? body[Symbol.asyncIterator]() : hasSync ? body[Symbol.iterator]() : body;
          var chunks = [];
          var total = 0;
          var finish = function (step) {
            if (!step || step.done) {
              resolve(concatBytes(chunks, total));
              return;
            }
            var chunk = toBytes(step.value);
            chunks.push(chunk);
            total += chunk.length;
            pump();
          };
          var pump = function () {
            var step;
            try {
              step = iterator.next();
            } catch (error) {
              reject(error);
              return;
            }
            if (step && typeof step.then === 'function') {
              step.then(finish, reject);
              return;
            }
            finish(step);
          };
          pump();
          return;
        }
        resolve(toBytes(body));
      } catch (error) {
        reject(error);
      }
    });
  }

  function createHttp() {
    return {
      request: function (options) {
        return new Promise(function (resolve, reject) {
          var opts = options || {};
          var url = opts.url;
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            reject(bridgeError('E_HTTP', '仅支持 http(s) 远端地址：' + sanitizeMessage(url)));
            return;
          }
          var method = String(opts.method || 'GET').toUpperCase();
          collectBody(opts.body).then(
            function (bodyBytes) {
              var id = 'http-' + String(++session.httpSeq);
              var timer = setTimeout(function () {
                if (session.pendingHttp[id]) {
                  delete session.pendingHttp[id];
                  reject(
                    bridgeError(
                      'E_HTTP',
                      '网络请求超时（' + Math.round(HTTP_TIMEOUT_MS / 1000) + ' 秒）：' + url
                    )
                  );
                }
              }, HTTP_TIMEOUT_MS);
              session.pendingHttp[id] = {
                resolve: resolve,
                reject: reject,
                url: url,
                method: method,
                timer: timer
              };
              var payload = {
                url: url,
                method: method,
                headers: lowerHeaders(opts.headers),
                bodyBase64: bodyBytes.length === 0 ? '' : bytesToBase64(bodyBytes)
              };
              try {
                hostCall('httpRequest', [id, JSON.stringify(payload)]);
              } catch (error) {
                clearTimeout(timer);
                delete session.pendingHttp[id];
                reject(error);
              }
            },
            function (error) {
              reject(normalizeError(error));
            }
          );
        });
      }
    };
  }

  function onHttpResult(json) {
    var message;
    try {
      message = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (error) {
      return false;
    }
    if (!message || typeof message !== 'object') {
      return false;
    }
    var pending = session.pendingHttp[message.id];
    if (!pending) {
      return false;
    }
    delete session.pendingHttp[message.id];
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (message.error && typeof message.error === 'object') {
      pending.reject(
        bridgeError(
          'E_HTTP',
          '网络请求失败：' + sanitizeMessage(message.error.message || message.error.code || '未知错误')
        )
      );
      return true;
    }
    var statusCode = typeof message.statusCode === 'number' ? message.statusCode : 0;
    if (statusCode === 0) {
      pending.reject(
        bridgeError('E_HTTP', '网络请求未取得响应（DNS/证书/网络不可达）：' + pending.url)
      );
      return true;
    }
    var bytes;
    try {
      bytes = base64ToBytes(message.bodyBase64 === undefined ? '' : message.bodyBase64);
    } catch (error) {
      pending.reject(normalizeError(error));
      return true;
    }
    pending.resolve({
      url: typeof message.url === 'string' && message.url.length > 0 ? message.url : pending.url,
      method: pending.method,
      headers: lowerHeaders(message.headers),
      statusCode: statusCode,
      statusMessage: typeof message.statusMessage === 'string' ? message.statusMessage : '',
      body: byteStream(bytes)
    });
    return true;
  }

  // ---------------------------------------------------------------- 认证

  /**
   * HTTPS 认证：token 作为密码，用户名由 **ArkTS 侧传下来的 config.username** 决定。
   *
   * Gitee 的用户名必须=登录名（写死 x-access-token 必然 401），GitHub 才是 x-access-token。
   * 兜底规则在 model/gitAuth.ts 的 esolveGitUsername()，这里只消费，不再硬编码。
   * SSH 不支持。
   */
  function makeOnAuth(config) {
    return function onAuth() {
      var token = config && config.token;
      if (typeof token !== 'string' || token.length === 0) {
        // 无 token 时取消而不是拿空密码重试；上层会得到 E_AUTH 中文提示
        return { cancel: true };
      }
      var username = config && config.username;
      if (typeof username !== 'string' || username.length === 0) {
        // 防御：ArkTS 侧漏传用户名时不猜默认值（猜错平台就是 401），直接取消并给中文原因
        throw bridgeError('E_AUTH', '缺少认证用户名：Gitee 需填写登录名，GitHub 留空即可');
      }
      return { username: username, password: token };
    };
  }

  // ---------------------------------------------------------------- 远端

  function requireRepoUrl(config) {
    var url = config && config.repoUrl;
    if (typeof url !== 'string' || url.length === 0) {
      throw bridgeError('E_GIT', '未配置仓库地址（repoUrl），请先在设置页填写');
    }
    if (!/^https?:\/\//i.test(url)) {
      throw bridgeError('E_GIT', '仅支持 HTTPS 仓库地址（本应用不支持 SSH）：' + sanitizeMessage(url));
    }
    return url;
  }

  async function ensureRemote(git, config) {
    var url = requireRepoUrl(config);
    var existing;
    try {
      existing = await git.getConfig({ fs: session.fs, dir: session.repoRoot, path: 'remote.origin.url' });
    } catch (error) {
      existing = undefined;
    }
    if (existing === url) {
      return url;
    }
    await git.addRemote({
      fs: session.fs,
      dir: session.repoRoot,
      remote: 'origin',
      url: url,
      force: true
    });
    return url;
  }

  // ---------------------------------------------------------------- 设备目录保护（自动 clone 前）

  function snapshotDeviceFiles(deviceId) {
    var backup = [];
    var files = listDeviceFiles(deviceId);
    for (var i = 0; i < files.length; i++) {
      var absolute = pathJoin(session.repoRoot, files[i]);
      var encoded = readHostFileBase64(absolute);
      if (encoded !== null) {
        backup.push({ path: absolute, relative: files[i], base64: encoded });
      }
    }
    return backup;
  }

  /**
   * 按行求并集（JSONL 只追加语义）：远端克隆结果在前，本地独有行追加在后。
   * 完全相同的行去重；同一 id 的不同版本都保留，交给 foldById 按 ts 折叠。
   */
  function unionJsonl(firstText, secondText) {
    var seen = Object.create(null);
    var lines = [];
    var feed = function (text) {
      var parts = String(text === undefined || text === null ? '' : text).split('\n');
      for (var i = 0; i < parts.length; i++) {
        var line = parts[i];
        if (line === '' || /^\s*$/.test(line)) {
          continue;
        }
        if (seen[line] === true) {
          continue;
        }
        seen[line] = true;
        lines.push(line);
      }
    };
    feed(firstText);
    feed(secondText);
    return lines.length === 0 ? '' : lines.join('\n') + '\n';
  }

  /**
   * 自动 clone 之前若本机已有 `devices/<deviceId>/` 文件（例如首次同步前先写了草稿），
   * clone 的 checkout 会覆盖同名文件。这里在 clone 之后把本地内容补回来：
   *   - 克隆缺失的文件：整体写回；
   *   - `.jsonl`：远端行 + 本地独有行求并集（只追加语义，不丢数据）；
   *   - 其它（附件按 sha256 命名）：保留远端版本（内容本来相同）。
   */
  function restoreDeviceFiles(backup) {
    var report = { restored: [], unioned: [], kept: [] };
    for (var i = 0; i < backup.length; i++) {
      var item = backup[i];
      if (hostCall('fileExists', [item.path]) !== true) {
        hostCall('writeFileBase64', [item.path, item.base64]);
        report.restored.push(item.relative);
        continue;
      }
      var current = readHostFileBase64(item.path);
      if (current === item.base64) {
        report.kept.push(item.relative);
        continue;
      }
      if (/\.jsonl$/i.test(item.path)) {
        var mergedText = unionJsonl(
          utf8Decode(base64ToBytes(current === null ? '' : current)),
          utf8Decode(base64ToBytes(item.base64))
        );
        var mergedBase64 = bytesToBase64(utf8Encode(mergedText));
        if (mergedBase64 !== current) {
          hostCall('writeFileBase64', [item.path, mergedBase64]);
          report.unioned.push(item.relative);
        } else {
          report.kept.push(item.relative);
        }
        continue;
      }
      report.kept.push(item.relative);
    }
    return report;
  }

  // ---------------------------------------------------------------- 操作实现

  async function opInit(args) {
    var config = applyConfig(args);
    var root = ensureRepo();
    var git = gitApi();
    var branch = config.branch || 'main';
    var alreadyInitialized = repoInitialized();
    if (!alreadyInitialized) {
      await git.init({ fs: session.fs, dir: root, defaultBranch: branch });
    }
    if (config.authorName || config.authorEmail) {
      var author = authorOf(config);
      await git.setConfig({ fs: session.fs, dir: root, path: 'user.name', value: author.name });
      await git.setConfig({ fs: session.fs, dir: root, path: 'user.email', value: author.email });
    }
    if (typeof config.repoUrl === 'string' && config.repoUrl.length > 0) {
      await ensureRemote(git, config);
    }
    var current = await currentBranchOf(git);
    return {
      initialized: true,
      alreadyInitialized: alreadyInitialized,
      branch: current || branch,
      head: await resolveHead(git),
      repoRoot: root
    };
  }

  /**
   * clone 失败时把半成品 `.git` 改名隔离（宿主没有删除目录的接口），
   * 这样下一次「拉取」还能重新 clone，而不是卡在「有目录但没提交」的死状态。
   * 返回隔离后的目录名（失败返回空串）。
   */
  function quarantineBrokenRepo() {
    var gitDir = pathJoin(session.repoRoot, '.git');
    try {
      if (hostCall('fileExists', [gitDir]) !== true) {
        return '';
      }
      var target = pathJoin(session.repoRoot, '.git.clone-failed-' + String(Date.now()));
      if (hostCall('rename', [gitDir, target]) === false) {
        return '';
      }
      return target;
    } catch (error) {
      return '';
    }
  }

  async function opClone(args) {
    var config = applyConfig(args);
    var root = ensureRepo();
    var git = gitApi();
    var branch = config.branch || 'main';
    if (repoInitialized()) {
      return {
        cloned: false,
        alreadyInitialized: true,
        branch: await currentBranchOf(git),
        head: await resolveHead(git),
        repoRoot: root
      };
    }
    var url = requireRepoUrl(config);
    var backup = config.deviceId ? snapshotDeviceFiles(config.deviceId) : [];
    try {
      await git.clone({
        fs: session.fs,
        http: session.http,
        dir: root,
        url: url,
        ref: branch,
        singleBranch: true,
        onAuth: makeOnAuth(config),
        author: authorOf(config)
      });
    } catch (error) {
      var quarantined = quarantineBrokenRepo();
      var normalized = normalizeError(error);
      if (quarantined.length > 0) {
        normalized.message =
          normalized.message + '（已隔离未完成的本地仓库 ' + quarantined + '，可直接再次拉取）';
      }
      throw normalized;
    }
    var preserved = backup.length > 0 ? restoreDeviceFiles(backup) : { restored: [], unioned: [], kept: [] };
    await ensureRemote(git, config);
    return {
      cloned: true,
      branch: await currentBranchOf(git),
      head: await resolveHead(git),
      url: url,
      repoRoot: root,
      localPreserved: preserved
    };
  }

  /** mod-sync-silent-autoinit：远端引用一个都没有 = 空仓库首跑态（不是传输故障）。 */
  function remoteHasNoRefs(info) {
    var refs = (info && info.refs) || {};
    var keys = Object.keys(refs);
    for (var i = 0; i < keys.length; i++) {
      var group = refs[keys[i]];
      if (typeof group === 'string' && group.length > 0) {
        return false;
      }
      if (group && typeof group === 'object' && Object.keys(group).length > 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * 静默初始化前置步骤（mod-sync-silent-autoinit）：所有需要仓库的操作在触碰 .git 之前先过这里。
   * - 已有仓库 → 空操作，直接返回；
   * - 没有仓库且调用方带 `autoInit:'true'`（App 侧 configArgs 恒带）→ 静默 clone：
   *   复用 opClone 的设备目录备份 / 并集恢复 / 失败隔离，失败抛 normalizeError 的 typed 错（可重试），
   *   文案里不再出现「尚未初始化 / 先拉取」；
   * - 空远端（服务端引用 advertisement 一个引用都没有）→ 本地 init + 配 origin，
   *   交给 E_REMOTE_EMPTY 首跑引导继续，绝不覆盖别人的历史；
   * - 直接调桥（单测 / 内部不变量）不带 autoInit 时本函数空跑，旧 E_GIT 不变量仍守住；
   *   正常用户流程每条路径都带 autoInit，下面四个「先拉取」死结不可达、永不用户可见。
   */
  async function ensureRepoInitialised(args) {
    var config = applyConfig(args);
    var root = ensureRepo();
    var git = gitApi();
    if (repoInitialized()) {
      return {
        cloned: false, alreadyInitialized: true, repoRoot: root,
        branch: await currentBranchOf(git), head: await resolveHead(git)
      };
    }
    if (!args || args.autoInit !== 'true') {
      return { cloned: false, skipped: true, repoRoot: root };
    }
    var url = requireRepoUrl(config);
    var branch = config.branch || 'main';
    var backup = config.deviceId ? snapshotDeviceFiles(config.deviceId) : [];
    var refsKnown = false;
    var emptyRemote = false;
    try {
      var info = await git.getRemoteInfo({ http: session.http, url: url, onAuth: makeOnAuth(config) });
      refsKnown = true;
      emptyRemote = remoteHasNoRefs(info);
    } catch (error) {
      // 探测不到引用不算空仓库（fail-closed）：交给 clone 抛 typed 传输/认证错误
    }
    if (refsKnown && emptyRemote) {
      await git.init({ fs: session.fs, dir: root, defaultBranch: branch });
      await ensureRemote(git, config);
      var preservedEmpty = backup.length > 0 ? restoreDeviceFiles(backup) : { restored: [], unioned: [], kept: [] };
      return {
        cloned: false, initialized: true, emptyRemote: true, repoRoot: root,
        branch: await currentBranchOf(git), head: await resolveHead(git), localPreserved: preservedEmpty
      };
    }
    return await opClone(args);
  }

  async function opFetch(args) {
    var config = applyConfig(args);
    await ensureRepoInitialised(args);
    var root = ensureRepo();
    var git = gitApi();
    if (!repoInitialized()) {
      // 内部不变量（**非用户提示**）：正常流程 ensureRepoInitialised 已静默 clone/init，此处绝不可达；
      // 下面这句只服务直接调桥的单测，任何 UI 路径都不会把它显示给用户。
      throw bridgeError('E_GIT', '本机仓库尚未初始化：请先执行「拉取」（首次会自动克隆）');
    }
    await ensureRemote(git, config);
    var branch = config.branch || 'main';
    var result = await git.fetch({
      fs: session.fs,
      http: session.http,
      dir: root,
      remote: 'origin',
      ref: branch,
      singleBranch: true,
      onAuth: makeOnAuth(config)
    });
    return {
      branch: branch,
      fetchHead: result && result.fetchHead ? String(result.fetchHead) : null,
      fetchHeadDescription: result && result.fetchHeadDescription ? String(result.fetchHeadDescription) : null
    };
  }

  async function opPull(args) {
    var config = applyConfig(args);
    // 静默前置：App 侧带 autoInit 时这里已完成 clone/init；下面的 opClone 分支只服务
    // 「直接调桥」的内部不变量路径（单测仍钉住旧 E_GIT 文案），正常用户流程走不到。
    await ensureRepoInitialised(args);
    var root = ensureRepo();
    var git = gitApi();
    if (!repoInitialized()) {
      var cloned = await opClone(args);
      return {
        cloned: true,
        branch: cloned.branch,
        head: cloned.head,
        previousHead: null,
        fastForward: false,
        alreadyUpToDate: false,
        url: cloned.url,
        localPreserved: cloned.localPreserved
      };
    }
    await ensureRemote(git, config);
    var branch = config.branch || 'main';
    // 分支可配：HEAD 不在目标分支时先切过去（本地没有就按远端/HEAD 建），否则 pull 会更新错分支
    await ensureOnBranch(git, branch);
    var before = await resolveHead(git);
    // fastForwardOnly：本应用永不 merge；分叉时 isomorphic-git 抛 FastForwardError，由 normalizeError 转中文
    var result = await git.pull({
      fs: session.fs,
      http: session.http,
      dir: root,
      ref: branch,
      singleBranch: true,
      fastForwardOnly: true,
      author: authorOf(config),
      onAuth: makeOnAuth(config)
    });
    var after = await resolveHead(git);
    return {
      cloned: false,
      branch: branch,
      head: after,
      previousHead: before,
      fastForward: !!(result && result.fastForward),
      alreadyUpToDate: before !== null && before === after,
      oid: result && result.oid ? String(result.oid) : after
    };
  }

  function isNothingToCommit(error) {
    var name = String((error && (error.code || error.name)) || '');
    if (/NothingToCommit/.test(name)) {
      return true;
    }
    return /nothing to commit/i.test(String(error && error.message ? error.message : ''));
  }

  async function opPush(args) {
    var config = applyConfig(args);
    await ensureRepoInitialised(args);
    var root = ensureRepo();
    var git = gitApi();
    if (!repoInitialized()) {
      // 内部不变量（**非用户提示**）：ensureRepoInitialised 已静默初始化，正常流程不可达。
      throw bridgeError('E_GIT', '本机仓库尚未初始化：请先执行「拉取」完成克隆');
    }
    var branch = config.branch || 'main';
    var deviceId = config.deviceId;
    if (typeof deviceId !== 'string' || DEVICE_ID_RE.test(deviceId) !== true) {
      throw bridgeError('E_GIT', '设备标识（deviceId）不合法：需匹配 ^[a-z0-9][a-z0-9-]{0,31}$');
    }
    await ensureRemote(git, config);

    // 分支可配（A2）：HEAD 不在目标分支时先切过去（本地没有就按远端/HEAD 建），
    // 否则 commit 会落到别的分支上，push ref 也就推错了。
    var branchSwitch = { switched: false, createdLocalBranch: false, current: null, from: 'current' };
    try {
      branchSwitch = await ensureOnBranch(git, branch);
    } catch (error) {
      throw normalizeError(error);
    }

    // 提交前尽力快进拉取，降低推送被拒的概率（失败只记录，不影响后面的提交）
    var prePull = { performed: false, fastForward: false, alreadyUpToDate: false, message: '' };
    try {
      var beforePull = await resolveHead(git);
      await git.pull({
        fs: session.fs,
        http: session.http,
        dir: root,
        ref: branch,
        singleBranch: true,
        fastForwardOnly: true,
        author: authorOf(config),
        onAuth: makeOnAuth(config)
      });
      var afterPull = await resolveHead(git);
      prePull.performed = true;
      prePull.fastForward = beforePull !== afterPull;
      prePull.alreadyUpToDate = beforePull === afterPull;
    } catch (error) {
      prePull.message = sanitizeMessage(error && error.message !== undefined ? error.message : error);
    }

    var deviceDir = pathJoin(root, 'devices/' + deviceId);
    if (hostCall('fileExists', [deviceDir]) !== true) {
      throw bridgeError('E_FS', '本设备目录不存在：devices/' + deviceId + '（请先保存一条日程）');
    }
    var files = listDeviceFiles(deviceId);
    for (var i = 0; i < files.length; i++) {
      await git.add({ fs: session.fs, dir: root, filepath: files[i] });
    }

    var commit = null;
    var commitMessage =
      typeof args.message === 'string' && args.message.trim().length > 0
        ? sanitizeMessage(args.message.trim())
        : '日程同步 ' + new Date().toISOString();
    try {
      commit = await git.commit({
        fs: session.fs,
        dir: root,
        message: commitMessage,
        author: authorOf(config)
      });
    } catch (error) {
      if (!isNothingToCommit(error)) {
        throw error;
      }
      commit = null;
    }

    // 首次推送：本地分支引用可能还不存在（空仓库 / 刚换的新分支名）→ 提交后补写一次，
    // 让 `git.push({ref: branch})` 有东西可推，远端据此自动创建同名分支。
    var commitOid =
      commit === undefined || commit === null ? await resolveHead(git) : String(commit);
    var branchCreatedLocal = branchSwitch.createdLocalBranch === true;
    if (commitOid !== null && commitOid !== undefined && commitOid.length > 0) {
      var branchOidBefore = await refOid(git, 'refs/heads/' + branch);
      if (branchOidBefore === null) {
        await git.writeRef({
          fs: session.fs,
          dir: root,
          ref: 'refs/heads/' + branch,
          value: commitOid,
          force: true
        });
        branchCreatedLocal = true;
      }
    }

    // 远端此前有没有这个分支：决定「自动创建分支」的提示（以本地缓存的远端跟踪引用为准）
    var remoteBranchExisted = (await refOid(git, 'refs/remotes/origin/' + branch)) !== null;

    // force 恒为 false（`pushPlan` 是纯函数，单测直接断言）：本应用永不覆盖远端历史
    var plan = pushPlan(branch);
    var pushResult = await git.push({
      fs: session.fs,
      http: session.http,
      dir: root,
      remote: plan.remote,
      ref: plan.ref,
      force: plan.force,
      onAuth: makeOnAuth(config)
    });
    return {
      branch: branch,
      deviceId: deviceId,
      files: files.length,
      commit: commit === undefined || commit === null ? null : String(commit),
      pushed: !(pushResult && pushResult.ok === false),
      refspec: plan.refspec,
      force: plan.force,
      branchCreated: !remoteBranchExisted,
      branchCreatedLocal: branchCreatedLocal,
      branchSwitch: branchSwitch,
      prePull: prePull,
      message: commit === null ? '没有新的改动可提交' : '已提交并推送'
    };
  }

  /**
   * 回滚「`commitPaths` 刚创建的那个提交」（push 被拒时用）。
   *
   * 只把分支引用退回提交前的 HEAD，并把调用方给的原文写回文件（`args.previous`），
   * 让工作区/索引与远端保持一致 —— 否则抢占重试的下一步 `pull`（fast-forward only）
   * 会因为本地多一个远端没有的提交而直接失败，重试永远不可能成功。
   *
   * 尽力而为：任何一步失败都不抛出（原始错误更重要），残留由调用方的重试与用户可见错误兜住。
   */
  async function rollbackRegistryCommit(git, root, branch, beforeHead, paths, args) {
    if (beforeHead === null || beforeHead === undefined || String(beforeHead).length === 0) {
      return;
    }
    try {
      await git.writeRef({
        fs: session.fs,
        dir: root,
        ref: 'refs/heads/' + branch,
        value: String(beforeHead),
        force: true
      });
    } catch (error) {
      return;
    }
    if (typeof args.previous === 'string') {
      try {
        var target = pathJoin(root, paths[0]);
        await session.fs.writeFile(target, utf8Encode(args.previous));
        await git.add({ fs: session.fs, dir: root, filepath: paths[0] });
      } catch (error) {
        // 原文写回失败：下次 pull 可能因工作区不同步而报冲突，但错误信息仍指向真实原因
      }
    }
  }

  /**
   * 共享文件提交（**只允许 `devices/registry.jsonl`**）：设备编号登记用。
   *
   * 为什么不复用 `push`：`push` 的范围被钉在 `devices/<deviceId>/`（不能写别人的目录），
   * 而登记表在 `devices/` 下、与本机目录同级；首次接入时本机目录还可能不存在
   * （用户还没存过日程）。这里用一份**显式白名单**保证它同样不能写任意路径：
   * 除了 `devices/registry.jsonl`，任何 path 都会被拒。
   *
   * 语义与 `push` 一致：永不 force；提交前尽力快进拉取（降低被拒概率，失败不影响提交）；
   * push 被拒时把桥的错误抛出去（E_GIT「推送被拒绝」），由 ArkTS 侧重拉 + 重算 + 重试。
   */
  async function opCommitPaths(args) {
    var config = applyConfig(args);
    await ensureRepoInitialised(args);
    var root = ensureRepo();
    var git = gitApi();
    if (!repoInitialized()) {
      // 内部不变量（**非用户提示**）：ensureRepoInitialised 已静默初始化，正常流程不可达。
      throw bridgeError('E_GIT', '本机仓库尚未初始化：请先执行「拉取」完成克隆');
    }
    var branch = config.branch || 'main';
    var rawPaths = typeof args.paths === 'string' ? args.paths : '';
    var requested = rawPaths.split(/[,\n]/);
    var paths = [];
    for (var p = 0; p < requested.length; p++) {
      var candidate = normalizePath(requested[p].trim().replace(/^\.?\//, ''));
      if (candidate.length === 0) {
        continue;
      }
      if (COMMIT_PATH_WHITELIST.indexOf(candidate) < 0) {
        throw bridgeError('E_GIT', '只允许提交 ' + COMMIT_PATH_WHITELIST.join('/') + '（拒绝：' + candidate + '）');
      }
      if (paths.indexOf(candidate) < 0) {
        paths.push(candidate);
      }
    }
    if (paths.length === 0) {
      throw bridgeError('E_GIT', 'commitPaths 需要 paths 参数（允许的路径：' + COMMIT_PATH_WHITELIST.join('/') + '）');
    }
    for (var q = 0; q < paths.length; q++) {
      if (hostCall('fileExists', [pathJoin(root, paths[q])]) !== true) {
        throw bridgeError('E_FS', '待提交的文件不存在：' + paths[q]);
      }
    }
    await ensureRemote(git, config);

    var branchSwitch = { switched: false, createdLocalBranch: false, current: null, from: 'current' };
    try {
      branchSwitch = await ensureOnBranch(git, branch);
    } catch (error) {
      throw normalizeError(error);
    }

    // 提交前尽力快进拉取（与 push 同样的降级策略：失败只记录，不影响后面的提交）
    var prePull = { performed: false, fastForward: false, alreadyUpToDate: false, message: '' };
    if (args.prePull !== 'false') {
      try {
        var beforePull = await resolveHead(git);
        await git.pull({
          fs: session.fs,
          http: session.http,
          dir: root,
          ref: branch,
          singleBranch: true,
          fastForwardOnly: true,
          author: authorOf(config),
          onAuth: makeOnAuth(config)
        });
        var afterPull = await resolveHead(git);
        prePull.performed = true;
        prePull.fastForward = beforePull !== afterPull;
        prePull.alreadyUpToDate = beforePull === afterPull;
      } catch (error) {
        prePull.message = sanitizeMessage(error && error.message !== undefined ? error.message : error);
      }
    }

    for (var a = 0; a < paths.length; a++) {
      await git.add({ fs: session.fs, dir: root, filepath: paths[a] });
    }

    var commitMessage =
      typeof args.message === 'string' && args.message.trim().length > 0
        ? sanitizeMessage(args.message.trim())
        : '登记设备编号 ' + new Date().toISOString();
    // 记录提交前的 HEAD：push 被拒时要把这个「只为登记表创建的提交」回滚掉，
    // 否则本地多出一个远端没有的提交，下一次 pull 就无法快进（分叉）。
    var beforeHead = await resolveHead(git);
    var commit = null;
    try {
      commit = await git.commit({
        fs: session.fs,
        dir: root,
        message: commitMessage,
        author: authorOf(config)
      });
    } catch (error) {
      if (!isNothingToCommit(error)) {
        throw error;
      }
      commit = null;
    }

    var commitOid =
      commit === undefined || commit === null ? await resolveHead(git) : String(commit);
    var branchCreatedLocal = branchSwitch.createdLocalBranch === true;
    if (commitOid !== null && commitOid !== undefined && commitOid.length > 0) {
      var branchOidBefore = await refOid(git, 'refs/heads/' + branch);
      if (branchOidBefore === null) {
        await git.writeRef({
          fs: session.fs,
          dir: root,
          ref: 'refs/heads/' + branch,
          value: commitOid,
          force: true
        });
        branchCreatedLocal = true;
      }
    }
    var remoteBranchExisted = (await refOid(git, 'refs/remotes/origin/' + branch)) !== null;
    var plan = pushPlan(branch);
    var pushResult = null;
    try {
      pushResult = await git.push({
        fs: session.fs,
        http: session.http,
        dir: root,
        remote: plan.remote,
        ref: plan.ref,
        force: plan.force,
        onAuth: makeOnAuth(config)
      });
    } catch (error) {
      await rollbackRegistryCommit(git, root, branch, beforeHead, paths, args);
      throw normalizeError(error);
    }
    if (pushResult && pushResult.ok === false) {
      await rollbackRegistryCommit(git, root, branch, beforeHead, paths, args);
      throw bridgeError('E_GIT', '推送被拒绝：远端已有新提交。请先执行「拉取」，本应用不会强制覆盖远端');
    }
    return {
      branch: branch,
      paths: paths,
      commit: commit === undefined || commit === null ? null : String(commit),
      pushed: !(pushResult && pushResult.ok === false),
      refspec: plan.refspec,
      force: plan.force,
      branchCreated: !remoteBranchExisted,
      branchCreatedLocal: branchCreatedLocal,
      branchSwitch: branchSwitch,
      prePull: prePull
    };
  }

  async function opStatus(args) {
    var config = applyConfig(args);
    // 查看状态 / 测试连接也先静默初始化：不需要用户先手动拉取一次。
    await ensureRepoInitialised(args);
    var root = ensureRepo();
    var git = gitApi();
    var report = {
      repoRoot: root,
      initialized: repoInitialized(),
      branch: null,
      head: null,
      remoteUrl: null,
      changedCount: 0,
      changed: [],
      conflicts: 0,
      lastCommit: null,
      // A2：分支与同步状态（本地 vs origin/<branch>）
      targetBranch: null,
      localBranchExists: false,
      remoteBranchExists: false,
      localBranchOid: null,
      remoteBranchOid: null,
      ahead: 0,
      behind: 0,
      diverged: false,
      comparable: false,
      config: {
        repoUrl: typeof config.repoUrl === 'string' ? config.repoUrl : null,
        branch: typeof config.branch === 'string' && config.branch.length > 0 ? config.branch : 'main',
        deviceId: typeof config.deviceId === 'string' ? config.deviceId : null,
        hasToken: typeof config.token === 'string' && config.token.length > 0,
        authorName: typeof config.authorName === 'string' ? config.authorName : null
      }
    };
    // A2：目标分支先填好（未初始化也要回显，页面据此提示「首次拉取会自动克隆 / 首次推送会建分支」）
    report.targetBranch = typeof config.branch === 'string' && config.branch.length > 0 ? config.branch : 'main';
    if (!report.initialized) {
      return report;
    }
    // 真实远端状态：查看状态 / 测试连接要求 ahead/behind/equal 是真值而非过期本地引用。
    // 只更新远端跟踪引用，不改工作区、不 merge、不 push；失败只在诊断里留原因，不谎称已同步。
    if (args.fetchRemote === 'true') {
      try {
        await git.fetch({
          fs: session.fs, http: session.http, dir: root,
          remote: 'origin', ref: report.targetBranch, singleBranch: true, onAuth: makeOnAuth(config)
        });
      } catch (error) {
        report.remoteError = sanitizeMessage(error && error.message !== undefined ? error.message : error);
      }
    }
    report.branch = await currentBranchOf(git);
    report.head = await resolveHead(git);
    try {
      var remote = await git.getConfig({ fs: session.fs, dir: root, path: 'remote.origin.url' });
      report.remoteUrl = remote === undefined || remote === null ? null : String(remote);
    } catch (error) {
      report.remoteUrl = null;
    }
    // A2：ahead/behind（refs/heads/<branch> vs refs/remotes/origin/<branch>）
    try {
      var state = await branchState(git, report.targetBranch);
      report.localBranchExists = state.localBranchExists;
      report.remoteBranchExists = state.remoteBranchExists;
      report.localBranchOid = state.localBranchOid;
      report.remoteBranchOid = state.remoteBranchOid;
      report.ahead = state.ahead;
      report.behind = state.behind;
      report.diverged = state.diverged;
      report.comparable = state.comparable;
    } catch (error) {
      report.branchError = sanitizeMessage(error && error.message !== undefined ? error.message : error);
    }
    if (report.head !== null) {
      try {
        var latest = await git.log({ fs: session.fs, dir: root, depth: 1 });
        if (latest && latest.length > 0) {
          report.lastCommit = mapCommit(latest[0]);
        }
      } catch (error) {
        report.lastCommit = null;
      }
    }
    try {
      var matrix = await git.statusMatrix({ fs: session.fs, dir: root });
      var changed = [];
      for (var i = 0; i < matrix.length; i++) {
        var row = matrix[i];
        if (row[1] === 1 && row[2] === 1 && row[3] === 1) {
          continue;
        }
        changed.push({ path: String(row[0]), head: row[1], workdir: row[2], stage: row[3] });
      }
      report.changedCount = changed.length;
      report.changed = changed.slice(0, 100);
      report.conflicts = countConflicts(matrix);
    } catch (error) {
      report.statusError = sanitizeMessage(error && error.message !== undefined ? error.message : error);
    }
    return report;
  }

  async function opLog(args) {
    var config = applyConfig(args);
    await ensureRepoInitialised(args);
    var root = ensureRepo();
    var git = gitApi();
    var depth = normalizeDepth(args.depth);
    var report = { branch: null, head: null, depth: depth, commits: [] };
    if (!repoInitialized()) {
      return report;
    }
    report.branch = await currentBranchOf(git);
    report.head = await resolveHead(git);
    try {
      var commits = await git.log({ fs: session.fs, dir: root, depth: depth });
      report.commits = commits.map(mapCommit);
    } catch (error) {
      var name = String((error && (error.code || error.name)) || '');
      if (!/NotFound|ResolveRef/.test(name)) {
        throw error;
      }
    }
    return report;
  }

  async function opCurrentBranch(args) {
    await ensureRepoInitialised(args);
    ensureRepo();
    var git = gitApi();
    if (!repoInitialized()) {
      return { branch: null, head: null, initialized: false };
    }
    return {
      branch: await currentBranchOf(git),
      head: await resolveHead(git),
      initialized: true
    };
  }

  async function opResolveRef(args) {
    await ensureRepoInitialised(args);
    ensureRepo();
    var git = gitApi();
    var ref = args.ref;
    if (typeof ref !== 'string' || ref.length === 0) {
      throw bridgeError('E_GIT', 'resolveRef 需要 ref 参数');
    }
    var oid = await git.resolveRef({ fs: session.fs, dir: session.repoRoot, ref: ref });
    return { ref: ref, oid: oid === undefined || oid === null ? null : String(oid) };
  }

  // ---------------------------------------------------------------- v2 同步周期（mod-v2-sync-wiring）
  //
  // 单一薄桥：把 ArkTS 侧 GitPort 的八个能力收进一个 op，避免为每一步各开一个桥方法。
  // 硬约束（与契约 §9 一致）：分支恒为 main；force 恒为 false；只有一个 resetHard，
  // 且它只把本地分支指回 origin/main（远端文件一个都不删、历史不改写）。
  // args.op ∈ fetch | resolveRef | currentBranch | readBlob | mergeBase |
  //           fastForward | addCommit | push | resetHard |
  //           remoteLayout | listLocalTimeline | readLocalTimelineSchema
  //           （首跑引导：远端引用探测 / 本地初始树枚举 / §11 schema 标记读取）

  /** 把一个 oid/ref 解析成 sha；已经是 40 位十六进制时直接返回。 */
  async function v2OidOf(git, ref) {
    if (/^[0-9a-f]{40}$/.test(ref)) {
      return ref;
    }
    var oid = await git.resolveRef({ fs: session.fs, dir: session.repoRoot, ref: ref });
    return oid === undefined || oid === null ? '' : String(oid);
  }

  async function opV2Git(args) {
    var config = applyConfig(args);
    // v2 周期的每个薄桥 op 都需要工作副本；统一先过静默前置，空仓库交给 E_REMOTE_EMPTY 引导。
    await ensureRepoInitialised(args);
    var root = ensureRepo();
    var git = gitApi();
    var op = String(args.op || '');
    var out = { ok: true, value: '', oid: '' };

    if (op === 'fetch') {
      if (!repoInitialized()) {
        // 内部不变量（**非用户提示**）：ensureRepoInitialised 已静默初始化，正常流程不可达。
        throw bridgeError('E_GIT', '本机仓库尚未初始化：请先拉取克隆仓库');
      }
      await ensureRemote(git, config);
      await git.fetch({
        fs: session.fs, http: session.http, dir: root,
        remote: 'origin', ref: 'main', singleBranch: true, onAuth: makeOnAuth(config)
      });
      return out;
    }
    if (op === 'resolveRef') {
      out.oid = await v2OidOf(git, String(args.ref || 'HEAD'));
      return out;
    }
    if (op === 'currentBranch') {
      out.value = await currentBranchOf(git);
      return out;
    }
    if (op === 'listDays') {
      // 远端有 records.json 的合法日目录（与 syncProtocolStore.remoteDates 同口径）。
      // 空远端首跑时本地只有骨架、还没有 origin/main 引用：返回空列表交给 E_REMOTE_EMPTY 引导，
      // 绝不把「引用不存在」误报成传输故障。
      var files = [];
      try {
        files = await git.listFiles({ fs: session.fs, dir: root, ref: 'origin/main' });
      } catch (error) {
        out.value = '[]';
        return out;
      }
      var days = [];
      for (var d = 0; d < files.length; d++) {
        var m = /^timeline\/(\d{4}-\d{2}-\d{2})\/records\.json$/.exec(files[d]);
        if (m) { days.push(m[1]); }
      }
      days.sort();
      out.value = JSON.stringify(days);
      return out;
    }
    if (op === 'remoteLayout') {
      // 首跑探测：直接读服务端引用 advertisement，不经过 fetch —— 空仓库上 `fetch origin main`
      // 会抛 "Could not find origin/main"，那是首跑态不是传输故障，必须先分流。
      // 任何 heads/tags/pull 引用都没有才算空仓库（可引导）；只要有任何引用却没有 main，
      // 就是别人的历史（例如只有 tags 的仓库），拒绝引导、保留 typed 错误。
      var url = requireRepoUrl(config);
      var info = await git.getRemoteInfo({
        http: session.http, url: url, onAuth: makeOnAuth(config)
      });
      var refs = (info && info.refs) || {};
      var heads = refs.heads || {};
      var names = Object.keys(heads);
      names.sort();
      // 引用总览（诊断用）：heads 原名在前，其它类别带类别前缀追加，顺序确定。
      var allNames = names.slice();
      var categories = Object.keys(refs);
      categories.sort();
      for (var c = 0; c < categories.length; c++) {
        var group = refs[categories[c]];
        if (!group || typeof group !== 'object') { continue; }
        var groupNames = Object.keys(group);
        groupNames.sort();
        for (var g = 0; g < groupNames.length; g++) {
          var label = categories[c] === 'heads' ? groupNames[g] : categories[c] + '/' + groupNames[g];
          if (allNames.indexOf(label) < 0) { allNames.push(label); }
        }
      }
      out.value = JSON.stringify({
        hasMain: Object.prototype.hasOwnProperty.call(heads, 'main'),
        isEmpty: allNames.length === 0,
        refs: allNames
      });
      return out;
    }
    if (op === 'listLocalTimeline') {
      // 首跑引导：本地工作副本 timeline/** 的相对路径（schema.json + 各日文件 + 账本）。
      var timelineDir = pathJoin(session.repoRoot, 'timeline');
      out.value = JSON.stringify(listFilesRecursive(timelineDir, 'timeline'));
      return out;
    }
    if (op === 'readLocalTimelineSchema') {
      // §11 门禁前置：读工作副本 timeline/schema.json 原文；复用 listFilesRecursive 同一套宿主 fs
      // 访问器（hostCall fileExists / readFileBase64）。缺文件或读不到一律空串，绝不抛；
      // 空串交给 ArkTS 侧 parseSchemaMarker 判为未知版本，fail-closed 为 E_SCHEMA_UNKNOWN。
      try {
        var schemaPath = pathJoin(pathJoin(session.repoRoot, 'timeline'), 'schema.json');
        var encoded = readHostFileBase64(schemaPath);
        out.value = encoded === null ? '' : utf8Decode(base64ToBytes(encoded));
      } catch (error) {
        out.value = '';
      }
      return out;
    }
    if (op === 'readBlob') {
      var oid = await v2OidOf(git, String(args.ref || 'origin/main'));
      if (oid.length === 0) {
        return out;
      }
      try {
        var blob = await git.readBlob({
          fs: session.fs, dir: root, oid: oid, filepath: String(args.path || '')
        });
        out.value = new TextDecoder('utf-8').decode(blob.blob);
      } catch (error) {
        // 远端缺该文件 = 空文本（与 syncProtocolStore.remoteText 的口径一致）
        out.value = '';
      }
      return out;
    }
    if (op === 'mergeBase') {
      var a = await v2OidOf(git, String(args.a || ''));
      var b = await v2OidOf(git, String(args.b || ''));
      if (a.length === 0 || b.length === 0) {
        return out;
      }
      if (a === b) {
        out.oid = a;
        return out;
      }
      if (typeof git.findMergeBase === 'function') {
        try {
          var bases = await git.findMergeBase({
            fs: session.fs, dir: root, oids: [a, b]
          });
          if (bases && bases.length > 0) {
            out.oid = String(bases[0]);
          }
        } catch (error) {
          // 无共同祖先 → 空 oid，ArkTS 侧判为分叉（fail-closed）
        }
      }
      return out;
    }
    if (op === 'fastForward') {
      var target = await v2OidOf(git, 'refs/remotes/origin/main');
      if (target.length === 0) {
        throw bridgeError('E_GIT', '缺少 origin/main，无法快进');
      }
      await git.merge({
        fs: session.fs, dir: root, oid: target,
        fastForwardOnly: true, author: authorOf(config)
      });
      return out;
    }
    if (op === 'addCommit') {
      var paths = [];
      try { paths = JSON.parse(String(args.paths || '[]')); } catch (error) { paths = []; }
      // 只接受 timeline/** 路径：任何 devices/** 或仓库外路径都被拒（契约：devices/ 零写入）。
      for (var i = 0; i < paths.length; i++) {
        if (typeof paths[i] !== 'string' || paths[i].indexOf('timeline/') !== 0 ||
            paths[i].indexOf('..') >= 0) {
          throw bridgeError('E_GIT', 'v2 提交路径越界：' + String(paths[i]));
        }
        await git.add({ fs: session.fs, dir: root, filepath: paths[i] });
      }
      try {
        out.oid = String(await git.commit({
          fs: session.fs, dir: root,
          message: String(args.message || '[v2] sync'), author: authorOf(config)
        }));
      } catch (error) {
        // 没有改动可提交是合法 no-op（commit 路径为空时 ArkTS 侧本就不调用本 op）
        if (!isNothingToCommit(error)) {
          throw error;
        }
      }
      return out;
    }
    if (op === 'push') {
      await ensureRemote(git, config);
      var pushResult = await git.push({
        fs: session.fs, http: session.http, dir: root,
        remote: 'origin', ref: 'main', force: false, onAuth: makeOnAuth(config)
      });
      out.ok = !(pushResult && pushResult.ok === false);
      return out;
    }
    if (op === 'resetHard') {
      // 本地分支指回 origin/main 并刷新工作副本；不删任何远端文件、不改写远端历史。
      var originSha = await v2OidOf(git, 'refs/remotes/origin/main');
      if (originSha.length === 0) {
        throw bridgeError('E_GIT', '缺少 origin/main，无法 reset');
      }
      var branch = await currentBranchOf(git);
      await git.writeRef({
        fs: session.fs, dir: root,
        ref: 'refs/heads/' + (branch || 'main'), value: originSha, force: true
      });
      await git.checkout({ fs: session.fs, dir: root, ref: 'HEAD', force: true });
      out.oid = originSha;
      return out;
    }
    throw bridgeError('E_GIT', 'v2Git 不支持的操作：' + op);
  }

  // ---------------------------------------------------------------- zip（按天附件包）
  //
  // 附件打包走 WebView 里的 JSZip：`@ohos.zlib` 是 OHOS 专有 API，**Android 侧没有**，
  // 而安卓不产生手迹但必须能读鸿蒙同步上来的手迹（详情页展示）→ 解压必须两端都能跑。
  // JSZip 在 WebView 里，两端环境一致，写一次两端通用。
  //
  // 跨桥数据一律**分块 base64**（每块 ≤256KB 的 base64 文本），避免超长字符串：
  // - 写入：`entries[i].chunks = [base64, ...]`，桥内拼成 Uint8Array 再交给 JSZip；
  // - 读出：返回 `chunks` 数组，ArkTS 侧按序拼接。

  /** 每块原始字节数：192KB 原始 → base64 ≈256KB 文本。 */
  var ZIP_CHUNK_BYTES = 192 * 1024;

  /** 取 JSZip 全局（index.html 必须已加载 jszip.min.js）。 */
  function jszipApi() {
    var api = global.JSZip;
    if (typeof api !== 'function') {
      throw bridgeError('E_FS', 'JSZip 未加载：index.html 必须先加载 jszip.min.js 再加载 git-bridge.js');
    }
    return api;
  }

  /** 把 base64 分块数组还原成 Uint8Array（校验总大小上限，防误传超大文件）。 */
  function joinChunks(chunks, maxBytes) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return new Uint8Array(0);
    }
    var parts = [];
    var total = 0;
    for (var i = 0; i < chunks.length; i++) {
      var bytes = base64ToBytes(String(chunks[i]));
      total += bytes.length;
      if (maxBytes && total > maxBytes) {
        throw bridgeError('E_FS', 'zip 条目超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限');
      }
      parts.push(bytes);
    }
    return concatBytes(parts, total);
  }

  /** 把 Uint8Array 切成 base64 分块（每块 ≤ ZIP_CHUNK_BYTES 原始字节）。 */
  function splitChunks(bytes) {
    var chunks = [];
    for (var offset = 0; offset < bytes.length; offset += ZIP_CHUNK_BYTES) {
      var end = Math.min(offset + ZIP_CHUNK_BYTES, bytes.length);
      chunks.push(bytesToBase64(bytes.subarray(offset, end)));
    }
    return chunks;
  }

  /** 读一个文件路径的字节（不存在返回 null）。 */
  async function readFileBytes(path) {
    if (hostCall('fileExists', [path]) !== true) {
      return null;
    }
    var encoded = hostCall('readFileBase64', [path]);
    return base64ToBytes(String(encoded === undefined || encoded === null ? '' : encoded));
  }

  /** 写一个文件路径的字节（必要时建目录）。 */
  function writeFileBytes(path, bytes) {
    hostCall('mkdirp', [pathDirname(path)]);
    var ok = hostCall('writeFileBase64', [path, bytesToBase64(bytes)]);
    if (ok === false) {
      throw bridgeError('E_FS', '写入失败：' + path);
    }
  }

  /** 打开（或新建）一个 zip：损坏时按「空包」重建，避免一条坏包卡死整天附件。 */
  async function loadZip(archivePath) {
    var JSZip = jszipApi();
    var existing = await readFileBytes(archivePath);
    if (existing === null || existing.length === 0) {
      return new JSZip();
    }
    try {
      return await JSZip.loadAsync(existing);
    } catch (error) {
      return new JSZip();
    }
  }

  /**
   * `zipUpsert(archivePath, entries)`：不存在则新建，存在则合并/覆盖同名条目。
   * `entries = [{ name: 'page-1-1a2b3c4d.jpg', chunks: [base64, ...] }]`
   * 返回 `{ archivePath, bytes, entries: [{name, size}] }`。
   */
  async function opZipUpsert(args) {
    var archivePath = normalizePath(String(args.archivePath || ''));
    if (archivePath.length === 0) {
      throw bridgeError('E_FS', 'zipUpsert 需要 archivePath');
    }
    var entries = Array.isArray(args.entries) ? args.entries : [];
    if (entries.length === 0) {
      throw bridgeError('E_FS', 'zipUpsert 需要至少一个条目');
    }
    var zip = await loadZip(archivePath);
    for (var i = 0; i < entries.length; i++) {
      var item = entries[i] || {};
      var name = String(item.name || '');
      if (name.length === 0 || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) {
        throw bridgeError('E_FS', 'zip 条目名不合法：' + name);
      }
      var bytes = joinChunks(item.chunks, 8 * 1024 * 1024);
      zip.file(name, bytes, { binary: true, date: new Date(item.mtime || Date.now()) });
    }
    var out = await zip.generateAsync({
      type: 'uint8array',
      compression: 'STORE', // JPEG 已压缩，再 deflate 收益极小、耗时明显
      platform: 'UNIX'
    });
    writeFileBytes(archivePath, out);
    var listed = [];
    zip.forEach(function (relativePath, file) {
      if (!file.dir) {
        listed.push({ name: relativePath, size: file._data ? file._data.uncompressedSize : 0 });
      }
    });
    listed.sort(function (left, right) {
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
    return { archivePath: archivePath, bytes: out.length, entries: listed };
  }

  /**
   * media.zip 条目名：`<date>/<sha16>.jpg`（导出 bundle 专用，允许一层日期目录）。
   * 与附件按天 zip 的 `page-<N>-<sha8>.jpg` 严格分开：两个命名域互不串用。
   */
  var MEDIA_ZIP_ENTRY_RE = /^\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}\.jpg$/;

  /** 固定 DOS 时间（本地 1980-01-01 00:00:00）：同数据重复打包逐字节相同，不引入当前时间。 */
  function mediaZipFixedDate() {
    return new Date(1980, 0, 1, 0, 0, 0);
  }

  /**
   * `zipWrite(archivePath, entries)`：整包重写一个**新** zip（不读旧包、不合并、不覆盖已有条目）。
   * 仅接受 media.zip 的 `<date>/<sha16>.jpg` 条目名；条目按名字排序、固定 DOS 时间、STORE 压缩。
   * 返回 `{ archivePath, bytes, entries: [{name,size}] }`。供导出 bundle 的 media.zip 使用。
   */
  async function opZipWrite(args) {
    var archivePath = normalizePath(String(args.archivePath || ''));
    if (archivePath.length === 0) {
      throw bridgeError('E_FS', 'zipWrite 需要 archivePath');
    }
    var entries = Array.isArray(args.entries) ? args.entries : [];
    var zip = new (jszipApi())();
    var sorted = entries.slice().sort(function (left, right) {
      var a = String((left || {}).name || '');
      var b = String((right || {}).name || '');
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (var i = 0; i < sorted.length; i++) {
      var item = sorted[i] || {};
      var name = String(item.name || '');
      if (!MEDIA_ZIP_ENTRY_RE.test(name)) {
        throw bridgeError('E_FS', 'media.zip 条目名不合法：' + name);
      }
      var bytes = joinChunks(item.chunks, 8 * 1024 * 1024);
      zip.file(name, bytes, { binary: true, date: mediaZipFixedDate() });
    }
    var out = await zip.generateAsync({
      type: 'uint8array',
      compression: 'STORE',
      platform: 'UNIX'
    });
    writeFileBytes(archivePath, out);
    return { archivePath: archivePath, bytes: out.length, entries: sorted.length };
  }

  /**
   * `zipList(archivePath)` → `{ archivePath, entries: [{name, size}] }`。
   * 包不存在返回空数组（不报错，调用方当「还没有附件」）。
   */
  async function opZipList(args) {
    var archivePath = normalizePath(String(args.archivePath || ''));
    if (archivePath.length === 0) {
      throw bridgeError('E_FS', 'zipList 需要 archivePath');
    }
    if (hostCall('fileExists', [archivePath]) !== true) {
      return { archivePath: archivePath, entries: [] };
    }
    var zip = await loadZip(archivePath);
    var entries = [];
    zip.forEach(function (relativePath, file) {
      if (!file.dir) {
        entries.push({ name: relativePath, size: file._data ? file._data.uncompressedSize : 0 });
      }
    });
    entries.sort(function (left, right) {
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
    return { archivePath: archivePath, entries: entries };
  }

  /**
   * `zipRead(archivePath, entryName)` → `{ name, size, chunks: [base64, ...] }`。
   * 条目不存在返回 `{ name, size: 0, chunks: [] }`（调用方据此回退/提示）。
   */
  async function opZipRead(args) {
    var archivePath = normalizePath(String(args.archivePath || ''));
    var entryName = String(args.entryName || '');
    if (archivePath.length === 0 || entryName.length === 0) {
      throw bridgeError('E_FS', 'zipRead 需要 archivePath 与 entryName');
    }
    if (hostCall('fileExists', [archivePath]) !== true) {
      return { name: entryName, size: 0, chunks: [] };
    }
    var zip = await loadZip(archivePath);
    var file = zip.file(entryName);
    if (file === null || file === undefined) {
      return { name: entryName, size: 0, chunks: [] };
    }
    var bytes = await file.async('uint8array');
    return { name: entryName, size: bytes.length, chunks: splitChunks(bytes) };
  }

  var OP_HANDLERS = {
    init: opInit,
    clone: opClone,
    fetch: opFetch,
    pull: opPull,
    push: opPush,
    commitPaths: opCommitPaths,
    status: opStatus,
    log: opLog,
    currentBranch: opCurrentBranch,
    resolveRef: opResolveRef,
    v2Git: opV2Git,
    zipUpsert: opZipUpsert,
    zipList: opZipList,
    zipRead: opZipRead,
    zipWrite: opZipWrite
  };

  // ---------------------------------------------------------------- 入口

  /**
   * 发起一次操作。**没有返回值**：结果只通过 dshGitHost.onEvent 回传。
   * 操作串行执行（Promise 链），避免并发写 .git/index 互相破坏。
   */
  function call(requestJson) {
    var request;
    try {
      request = typeof requestJson === 'string' ? JSON.parse(requestJson) : requestJson;
    } catch (error) {
      emitResult(null, bridgeError('E_GIT', '请求不是合法 JSON：' + sanitizeMessage(error && error.message)));
      return;
    }
    if (!request || typeof request !== 'object') {
      emitResult(null, bridgeError('E_GIT', '请求必须是 { id, op, args } 对象'));
      return;
    }
    var id = request.id === undefined ? null : request.id;
    var op = request.op;
    var handler = OP_HANDLERS[op];
    if (typeof handler !== 'function') {
      emitResult(id, bridgeError('E_GIT', '不支持的操作：' + sanitizeMessage(op)));
      return;
    }
    var args = request.args && typeof request.args === 'object' ? request.args : {};
    session.queue = session.queue.then(function () {
      return handler(args);
    });
    session.queue = session.queue.then(
      function (data) {
        emitResult(id, null, data);
      },
      function (error) {
        emitResult(id, normalizeError(error));
      }
    );
  }

  // ---------------------------------------------------------------- 导出

  var internals = {
    // 纯函数工具（Node 单测与真机调试共用，不属于跨端协议）
    unionJsonl: unionJsonl,
    normalizePath: normalizePath,
    pathJoin: pathJoin,
    pathDirname: pathDirname,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    sanitizeMessage: sanitizeMessage,
    normalizeError: normalizeError,
    collectBody: collectBody,
    byteStream: byteStream,
    snapshotDeviceFiles: snapshotDeviceFiles,
    restoreDeviceFiles: restoreDeviceFiles,
    listDeviceFiles: listDeviceFiles,
    // 设备登记表（`devices/registry.jsonl`）：白名单提交 + 推送，供 Node 单测直接调
    commitPaths: opCommitPaths,
    commitPathWhitelist: COMMIT_PATH_WHITELIST.slice(),
    // 附件 zip（Node 单测直接调，不需要 WebView）：写/列/读 三个 op 的实现
    zipUpsert: opZipUpsert,
    zipList: opZipList,
    zipRead: opZipRead,
    zipWrite: opZipWrite,
    zipChunkBytes: ZIP_CHUNK_BYTES,
    mediaZipEntryRe: MEDIA_ZIP_ENTRY_RE,
    // 分支与同步状态（A2）：纯函数 + 需要真实仓库的两个 helper
    computeAheadBehind: computeAheadBehind,
    countConflicts: countConflicts,
    pushPlan: pushPlan,
    branchState: branchState,
    ensureOnBranch: ensureOnBranch,
    refOid: refOid,
    branchLogDepth: BRANCH_LOG_DEPTH,
    // 已绑定会话（repoRoot/fs）的便捷包装，供 Node 单测直接调用（不用自己造 git 实例）
    branchStateOf: function (branch) {
      return branchState(gitApi(), branch);
    },
    switchBranchTo: function (branch) {
      return ensureOnBranch(gitApi(), branch);
    }
  };

  var DshGitBridge = {
    version: BRIDGE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    supportedOps: SUPPORTED_OPS.slice(),
    call: call,
    onHttpResult: onHttpResult,
    /** 取出当前会话的 fs 适配器（测试/调试用；正常流程由 op 内部使用）。 */
    getInternalFs: function () {
      ensureRepo();
      return session.fs;
    },
    /** 宿主代理是否已就绪（供页面自检）。 */
    isHostReady: function () {
      return !!(global.dshGitHost && typeof global.dshGitHost === 'object');
    },
    internals: internals
  };

  global.DshGitBridge = DshGitBridge;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = DshGitBridge;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
