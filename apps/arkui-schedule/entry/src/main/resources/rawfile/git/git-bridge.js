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
  var CONFIG_KEYS = ['repoUrl', 'branch', 'deviceId', 'token', 'authorName', 'authorEmail'];

  var SUPPORTED_OPS = [
    'init',
    'clone',
    'fetch',
    'pull',
    'push',
    'status',
    'log',
    'currentBranch',
    'resolveRef'
  ];

  var DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
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
      name: (config && config.authorName) || '日程助手',
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

  /** GitHub/Gitee HTTPS：token 作为密码，用户名固定 x-access-token。SSH 不支持。 */
  function makeOnAuth(config) {
    return function onAuth() {
      var token = config && config.token;
      if (typeof token !== 'string' || token.length === 0) {
        // 无 token 时取消而不是拿空密码重试；上层会得到 E_AUTH 中文提示
        return { cancel: true };
      }
      return { username: 'x-access-token', password: token };
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

  async function opFetch(args) {
    var config = applyConfig(args);
    var root = ensureRepo();
    var git = gitApi();
    if (!repoInitialized()) {
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
    var root = ensureRepo();
    var git = gitApi();
    if (!repoInitialized()) {
      throw bridgeError('E_GIT', '本机仓库尚未初始化：请先执行「拉取」完成克隆');
    }
    var branch = config.branch || 'main';
    var deviceId = config.deviceId;
    if (typeof deviceId !== 'string' || DEVICE_ID_RE.test(deviceId) !== true) {
      throw bridgeError('E_GIT', '设备标识（deviceId）不合法：需匹配 ^[a-z0-9][a-z0-9-]{0,31}$');
    }
    await ensureRemote(git, config);

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

    var pushResult = await git.push({
      fs: session.fs,
      http: session.http,
      dir: root,
      remote: 'origin',
      ref: branch,
      onAuth: makeOnAuth(config)
    });
    return {
      branch: branch,
      deviceId: deviceId,
      files: files.length,
      commit: commit === undefined || commit === null ? null : String(commit),
      pushed: !(pushResult && pushResult.ok === false),
      prePull: prePull,
      message: commit === null ? '没有新的改动可提交' : '已提交并推送'
    };
  }

  async function opStatus(args) {
    var config = applyConfig(args);
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
      lastCommit: null,
      config: {
        repoUrl: typeof config.repoUrl === 'string' ? config.repoUrl : null,
        branch: typeof config.branch === 'string' && config.branch.length > 0 ? config.branch : 'main',
        deviceId: typeof config.deviceId === 'string' ? config.deviceId : null,
        hasToken: typeof config.token === 'string' && config.token.length > 0,
        authorName: typeof config.authorName === 'string' ? config.authorName : null
      }
    };
    if (!report.initialized) {
      return report;
    }
    report.branch = await currentBranchOf(git);
    report.head = await resolveHead(git);
    try {
      var remote = await git.getConfig({ fs: session.fs, dir: root, path: 'remote.origin.url' });
      report.remoteUrl = remote === undefined || remote === null ? null : String(remote);
    } catch (error) {
      report.remoteUrl = null;
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
    } catch (error) {
      report.statusError = sanitizeMessage(error && error.message !== undefined ? error.message : error);
    }
    return report;
  }

  async function opLog(args) {
    var config = applyConfig(args);
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
    applyConfig(args);
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
    applyConfig(args);
    ensureRepo();
    var git = gitApi();
    var ref = args.ref;
    if (typeof ref !== 'string' || ref.length === 0) {
      throw bridgeError('E_GIT', 'resolveRef 需要 ref 参数');
    }
    var oid = await git.resolveRef({ fs: session.fs, dir: session.repoRoot, ref: ref });
    return { ref: ref, oid: oid === undefined || oid === null ? null : String(oid) };
  }

  var OP_HANDLERS = {
    init: opInit,
    clone: opClone,
    fetch: opFetch,
    pull: opPull,
    push: opPush,
    status: opStatus,
    log: opLog,
    currentBranch: opCurrentBranch,
    resolveRef: opResolveRef
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
    listDeviceFiles: listDeviceFiles
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
