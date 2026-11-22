/**
 * dsh-dots — client half (hand-written `__ModuleLoader__` bundle, no build step).
 *
 * Registers one settings section (Settings → 配置同步 / Config sync):
 *   slot `settings.section`, id `dots`, order 70, locale NS `dots`.
 *
 * Contents:
 *   - repository form: platform / repoUrl / authMode / deviceId / branch / token
 *   - sync scope: config / providers / plugins / mcp (all enabled by default)
 *   - status badges: reachable (tri-state: reachable / unreachable-after-last-probe / not probed),
 *     branch, local commits, remote commit, pending upload/download (— when no upstream ref),
 *     conflict, latest commit (sha + message + time), last sync, local-read error
 *   - actions: save / test / push / preview / apply / refresh (all disabled while one is pending)
 *   - preview: grouped per source device, per-entry diff (monospace, collapsible, max-height),
 *     adopt-remote vs keep-local toggle, `manual` entries default unchecked
 *   - plugin manifest MERGE-only plan (install / keep / skip / noDowngrade)
 *   - pre-write snapshots with two-step rollback confirmation
 *   - inline errors (code + message), including "preview expired, re-preview" hints
 *
 * Transport: same-origin POST /dsh-dots/rpc
 *   request  `{ action, ...payload }`
 *   response `{ ok: true, data }` | `{ ok: false, error: { code, message, details? } }`
 *   (HTTP 200; only auth failures use 401/403)
 *
 * Styling: inline styles only, colours exclusively from `--dsw-alias-*` theme variables.
 */
// loader id 必须等于 package.json.name（DSH 以包名作为模块工厂的 key）。
// 它与 settings.section 的 slot id `dots` / `dots-remote`、locale NS `dots`、
// RPC 路径 `/dsh-dots/rpc` 是互相独立的命名空间，勿一并改名。
// build.mjs 会用 package.json.name 重写下面的字面量，防止与包名漂移。
window.__ModuleLoader__.load({
  id: 'dsh-dots',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dots'
    const RPC_PATH = '/dsh-dots/rpc'

    // ------------------------------------------------------------------
    // Locale dictionaries — kept byte-identical to locale/zh.json / locale/en.json
    // (the JSON files are generated from these literals; key sets must match).
    // ------------------------------------------------------------------
    const zh = {
      "meta.title": "配置同步",
      "meta.description": "通过 Git 在设备间同步 DSH 配置（patch 条目、provider、插件清单、MCP）。入口：设置 → 配置同步；密钥永不进入仓库。",
      "meta.detail": "docs/DETAIL.zh.md",
      "nav": "配置同步",
      "title": "Git 配置同步",
      "subtitle": "在设备间同步 DSH 配置：本机只写自己的目录，冲突按条目人工确认。",

      "repo.title": "仓库配置",
      "repo.platform": "平台",
      "repo.platform.hint": "影响仓库地址提示与 HTTPS 默认用户名（Gitee 必填登录名）。",
      "repo.url": "仓库地址",
      "repo.url.hint.github": "示例：https://github.com/<owner>/<repo>.git",
      "repo.url.hint.gitee": "示例：https://gitee.com/<owner>/<repo>.git",
      "repo.url.hint.custom": "支持 https://、ssh://、git@host:path",
      "repo.auth": "认证方式",
      "repo.username": "用户名",
      "repo.username.hint": "仅 HTTPS 认证使用；只存本机 settings.json，不进凭据文件。",
      "repo.username.hint.github": "可留空，默认 x-access-token（GitHub PAT 约定）。",
      "repo.username.hint.gitee": "必填 Gitee 登录名；私人令牌只作密码。",
      "repo.username.hint.custom": "按仓库服务要求填写，可留空。",
      "repo.device": "设备标识",
      "repo.device.hint": "只能用小写字母、数字与连字符，最长 32 位，例如 pc-a。",
      "repo.branch": "分支",
      "repo.branch.hint": "默认 main；非快进时先 pull --rebase，永不 force push。",
      "repo.token": "访问令牌（Token）",
      "repo.token.hint": "留空表示不修改已保存的 Token",
      "repo.token.set": "已保存 Token（仅存本机，不入仓库）",
      "repo.token.unset": "尚未保存 Token",
      "repo.save": "保存设置",

      "platform.github": "GitHub",
      "platform.gitee": "Gitee",
      "platform.custom": "自定义 / 自建",

      "auth.https": "HTTPS（Token）",
      "auth.ssh": "SSH（系统 ssh-agent）",

      "scope.title": "同步范围",
      "scope.hint": "默认全部勾选；未勾选的文件不会写入远端快照。",
      "scope.config": "profile 配置（cordis.patch.yml）",
      "scope.providers": "模型 provider 定义",
      "scope.plugins": "插件清单（MERGE-only）",
      "scope.mcp": "MCP 定义",
      "scope.config.desc": "按 entry id 逐条合并，保留注释与 !!js",
      "scope.providers.desc": "provider 定义脱敏后随快照同步",
      "scope.plugins.desc": "只同步清单，不下载代码；远端有本地无仅给安装计划",
      "scope.mcp.desc": "含 mcp 的 patch 条目，脱敏后同步",

      "status.title": "同步状态",
      "status.refresh": "刷新状态",
      "status.reachable": "可达",
      "status.unreachable": "不可达（最近探测）",
      "status.unprobed": "未探测（点击测试连接）",
      "status.branch": "分支",
      "status.local": "本地提交",
      "status.remote": "仓库提交",
      "status.ahead": "待上传",
      "status.behind": "待下载",
      "status.conflict": "冲突",
      "status.conflict.yes": "有冲突",
      "status.conflict.no": "无冲突",
      "status.head": "最近提交",
      "status.headNone": "（暂无提交）",
      "status.lastSync": "最近同步",
      "status.never": "从未同步",
      "status.error": "状态错误",

      "actions.title": "操作",
      "actions.test": "测试连接",
      "actions.push": "推送",
      "actions.preview": "拉取预览",
      "actions.apply": "执行覆盖",
      "actions.apply.hint": "需先拉取预览并勾选至少一个条目",
      "actions.refresh": "刷新状态",

      "busy.loading": "加载中…",
      "busy.saving": "保存中…",
      "busy.testing": "测试中…",
      "busy.pushing": "推送中…",
      "busy.previewing": "预览中…",
      "busy.applying": "覆盖中…",
      "busy.rollingBack": "回滚中…",

      "error.title": "操作失败",
      "error.network": "网络异常，无法连接 DSH 服务，请确认服务仍在运行。",
      "error.http": "服务返回 HTTP {status}，请查看 DSH 日志。",
      "error.badResponse": "服务返回了无法解析的响应。",
      "error.unauthorized": "未通过 DSH 鉴权（401/403）。",
      "error.unknown": "未知错误。",
      "error.giteeUsername": "Gitee 需要填写用户名（Gitee 登录名）。私人令牌只作密码，不能代替用户名。",
      "error.retry": "重试",
      "error.dismiss": "关闭提示",

      "notice.saved": "设置已保存。",
      "notice.platformInferred": "已按仓库地址把平台切换为「{platform}」。",
      "notice.testOk": "连接正常：{branch} @ {sha} {message}",
      "notice.pushed": "已推送：{branch} @ {commit}（{files} 个文件）",
      "notice.previewReady": "预览已生成，共 {count} 个条目。",
      "notice.applied": "覆盖完成，已写入 {n} 个条目，并生成写前快照。",
      "notice.rolledBack": "已回滚到快照 {id}。",

      "preview.title": "拉取预览",
      "preview.empty": "尚未预览。点击「拉取预览」查看其他设备的快照与逐条差异。",
      "preview.expired": "预览已过期或本次预览已失效，请重新点击「拉取预览」。",
      "preview.hint": "勾选需要采纳的条目；标记「需本地填写」的条目含脱敏密钥，采纳后仍需在本机补全。",
      "preview.source": "源设备",
      "preview.sourceActive": "应用来源",
      "preview.head": "快照提交",
      "preview.entries": "条目",
      "preview.files": "快照文件",
      "preview.selectAll": "全选可采纳",
      "preview.clearAll": "清空选择",
      "preview.selected": "已选 {n} 项",
      "preview.noneSelected": "未勾选任何条目",
      "preview.localText": "本地（当前）",
      "preview.remoteText": "远端（将写入）",
      "preview.expand": "展开差异",
      "preview.collapse": "收起差异",
      "preview.manual": "需本地填写",
      "preview.secret": "含脱敏密钥",
      "preview.none": "（空）",

      "entry.status.added": "新增",
      "entry.status.changed": "变更",
      "entry.status.same": "相同",
      "entry.status.manual": "需本地填写",
      "entry.adoptRemote": "采纳远端",
      "entry.keepLocal": "保留本地",

      "plugins.title": "插件清单（仅合并）",
      "plugins.hint": "只同步清单，不下载代码；远端有而本地没有仅给出安装计划，本地独有永不删除。",
      "plugins.install": "可安装/升级",
      "plugins.keep": "保持",
      "plugins.skip": "跳过",
      "plugins.noDowngrade": "不降级",
      "plugins.empty": "无插件清单数据。",
      "plugins.installItem": "{name} @ {version}",
      "plugins.keepItem": "{name} @ {version}",
      "plugins.skipItem": "{name} · {reason}",
      "plugins.noDowngradeItem": "{name}：本地 {localVersion} > 远端 {remoteVersion}",
      "plugins.manualNote": "install 项只写入 plugins.to-install.json，需你手动安装；本插件不会调用 pnpm，也不会修改 profile。",

      "providers.title": "Provider 差异",
      "providers.added": "新增",
      "providers.changed": "变更",
      "providers.same": "相同",
      "mcp.title": "MCP 差异",

      "snapshots.title": "写前快照",
      "snapshots.refresh": "刷新快照",
      "snapshots.empty": "暂无快照（每次执行覆盖/回滚前会自动生成，最多保留最近 10 份）。",
      "snapshots.id": "快照",
      "snapshots.time": "时间",
      "snapshots.reason": "原因",
      "snapshots.bytes": "大小",
      "snapshots.rollback": "回滚",
      "snapshots.confirm": "确认把配置回滚到快照 {id}？当前文件会被覆盖。",
      "snapshots.confirmYes": "确认回滚",
      "snapshots.cancel": "取消",

      "apply.title": "上次覆盖结果",
      "apply.applied": "已写入",
      "apply.skipped": "已跳过",
      "apply.snapshot": "写前快照",
      "apply.verified": "SHA-256 校验通过",
      "apply.fileSha": "文件 SHA-256",
      "apply.blockSha": "条目 SHA-256",
      "apply.none": "无",

      "confirm.apply": "确认把 {device} 的 {n} 个条目覆盖到本机？写入前会自动快照，写后校验 SHA-256。",
      "confirm.yes": "确认覆盖",
      "confirm.cancel": "取消",

      "common.close": "关闭",
      "common.none": "—",

      "remote.nav": "远程访问",
      "remote.title": "远程访问",
      "remote.subtitle": "让平板或手机通过局域网 / 隧道打开本机 DSH：默认关闭，只绑你选定的具体地址，不会落到 0.0.0.0。",
      "remote.settings.title": "远程访问设置",
      "remote.enable": "允许局域网 / 远程访问",
      "remote.enable.hint": "默认关闭；打开后仍只绑具体地址，打开前请先保存并自检。",
      "remote.mode": "访问方式",
      "remote.mode.hint": "每种方式需要不同的准备条件；不可用的方式会写明原因，不做假开关。",
      "remote.port": "端口",
      "remote.port.hint": "0 = 跟 DSH 同端口（地址只差主机名）；正整数 = 固定端口。",
      "remote.fields.lanAddress": "局域网地址",
      "remote.fields.lanAddress.placeholder": "留空自动挑选，例如 192.168.1.6",
      "remote.fields.tailscaleHost": "Tailscale 主机",
      "remote.fields.tailscaleHost.placeholder": "例如 pc-a.tailnet-xxxx.ts.net",
      "remote.fields.cloudflareHost": "Cloudflare 主机",
      "remote.fields.cloudflareHost.placeholder": "例如 xxx.trycloudflare.com",
      "remote.fields.ipv6Address": "IPv6 地址",
      "remote.fields.ipv6Address.placeholder": "例如 2408:8207:...（不带方括号）",
      "remote.fields.manualUrl": "完整地址",
      "remote.fields.manualUrl.placeholder": "例如 https://example.com/dsh",
      "remote.fields.uu.manualUrl": "对外入口地址",
      "remote.fields.uu.manualUrl.placeholder": "从 UU 远程复制，如 abc.uuyc.com:12345 或 https://…",
      "remote.field.token": "访问令牌（可选）",
      "remote.field.token.hint": "留空则不带令牌；填了会在链接里追加 ?token=…",
      "remote.token.saved": "已保存访问令牌（{masked}）",
      "remote.token.clear": "清除令牌",
      "remote.token.cleared": "已清除",
      "remote.availability.ready": "可用",
      "remote.unsupported": "不可用",
      "remote.needsSetup": "需先准备",
      "remote.requires": "需要先准备",
      "remote.steps": "怎么做",
      "remote.status.title": "运行状态",
      "remote.status.running": "运行中",
      "remote.status.stopped": "已停止",
      "remote.status.listen": "监听地址",
      "remote.status.bound": "绑定地址",
      "remote.status.bound.hint": "只绑这一个具体地址（不是 0.0.0.0）；换网络后请重新挑选地址。",
      "remote.status.connections": "连接数",
      "remote.status.rejected": "被拒次数",
      "remote.status.token": "令牌",
      "remote.status.token.none": "尚未生成",
      "remote.status.startedAt": "启动时间",
      "remote.status.lastError": "最近错误",
      "remote.actions.title": "操作",
      "remote.actions.save": "保存设置",
      "remote.actions.start": "启动",
      "remote.actions.stop": "停止",
      "remote.actions.rotate": "生成新令牌",
      "remote.actions.rotate.confirm": "生成新令牌后，旧二维码与旧链接立即失效，需要重新扫码。确定生成？",
      "remote.actions.rotate.yes": "生成新令牌",
      "remote.actions.rotate.cancel": "取消",
      "remote.actions.probe": "重新自检",
      "remote.actions.showLink": "显示二维码与链接",
      "remote.actions.copy": "复制完整地址",
      "remote.busy.loading": "读取中…",
      "remote.busy.saving": "保存中…",
      "remote.busy.starting": "启动中…",
      "remote.busy.stopping": "停止中…",
      "remote.busy.rotating": "生成中…",
      "remote.busy.probing": "自检中…",
      "remote.busy.linking": "生成链接中…",
      "remote.probe.title": "连通性自检",
      "remote.probe.ok": "通过",
      "remote.probe.warn": "注意",
      "remote.probe.fail": "失败",
      "remote.probe.unknown": "无法自证",
      "remote.probe.never": "尚未自检；点「重新自检」确认这台机器到底能不能被访问。",
      "remote.probe.at": "自检时间",
      "remote.qr.title": "扫码打开",
      "remote.qr.hint": "用平板扫这个码",
      "remote.link.hint": "或手动输入下面的地址（不含令牌，首次打开后按提示输入令牌）。",
      "remote.notice.saved": "设置已保存。",
      "remote.notice.started": "已启动。",
      "remote.notice.stopped": "已停止。",
      "remote.notice.rotated": "已生成新令牌：旧链接与旧二维码立即失效。",
      "actions.diff": "查看差异",
      "actions.rollbackLatest": "回滚到上次快照",
      "busy.diffing": "对比中…",
      "busy.rollbackPreview": "计算回滚影响…",
      "diff.title": "差异预览",
      "diff.hint": "只读对比：不创建快照，也不写任何文件。",
      "diff.emptyHint": "点「查看差异」对比本地工作副本与当前 profile。",
      "diff.summary": "{changed} 个文件变更（+{plus} / -{minus} 行）",
      "diff.summary.same": "另有 {n} 个文件无变化",
      "diff.empty": "没有差异",
      "diff.group.added": "新增",
      "diff.group.modified": "修改",
      "diff.group.deleted": "删除",
      "diff.lineStat": "+{added} / -{removed} 行",
      "diff.expand": "展开 hunk",
      "diff.collapse": "收起 hunk",
      "diff.truncated": "仅显示前 {n} 行",
      "diff.truncatedFile": "二进制或过大：只给统计",
      "diff.source.local": "本机：工作副本 → 当前 profile",
      "diff.source.remote": "远端设备：{device}",
      "diff.deletedNote": "「删除」表示当前有、快照里没有；回滚不会删除这些文件。",
      "diff.failed": "差异预览失败",
      "rollback.title": "回滚到上次快照",
      "rollback.hint": "两步确认：先看这次回滚会改什么，再手动确认。",
      "rollback.step1": "第 1 步 / 2：最近一份快照",
      "rollback.step2": "第 2 步 / 2：回滚预览",
      "rollback.check": "查看这次回滚会改什么",
      "rollback.confirm": "确认回滚（不可撤销）",
      "rollback.cancel": "取消",
      "rollback.back": "返回上一步",
      "rollback.empty": "没有可回滚的快照。",
      "rollback.previewFailed": "回滚预览失败，未写入任何文件。",
      "rollback.willRestore": "将写入",
      "rollback.none": "不会改写任何文件",
      "rollback.summary": "{changed} 个文件会变化（+{plus} / -{minus} 行）",
      "rollback.same": "回滚后与当前一致",
      "rollback.snapshot": "快照 {id}",
      "rollback.reason": "原因：{reason}",
      "rollback.createdAt": "创建于 {time}",
      "remote.notice.probed": "自检完成。"
    }

    const en = {
      "meta.title": "Config sync",
      "meta.description": "Sync DSH configuration across devices over Git (patch entries, providers, plugin manifest, MCP). Open Settings → Config sync; secrets never enter the repository.",
      "meta.detail": "docs/DETAIL.md",
      "nav": "Config sync",
      "title": "Git config sync",
      "subtitle": "Sync DSH configuration across devices. Each device writes only its own directory; conflicts are resolved entry by entry.",

      "repo.title": "Repository",
      "repo.platform": "Platform",
      "repo.platform.hint": "Affects the URL hint and the default HTTPS username (Gitee requires a login name).",
      "repo.url": "Repository URL",
      "repo.url.hint.github": "e.g. https://github.com/<owner>/<repo>.git",
      "repo.url.hint.gitee": "e.g. https://gitee.com/<owner>/<repo>.git",
      "repo.url.hint.custom": "Accepts https://, ssh:// and git@host:path",
      "repo.auth": "Authentication",
      "repo.username": "Username",
      "repo.username.hint": "Used only for HTTPS auth; stored in local settings.json, never in the credentials file.",
      "repo.username.hint.github": "Optional; defaults to x-access-token (GitHub PAT convention).",
      "repo.username.hint.gitee": "Required: your Gitee login name. The private token is the password.",
      "repo.username.hint.custom": "Use what the repository host requires; may be left empty.",
      "repo.device": "Device ID",
      "repo.device.hint": "Lowercase letters, digits and hyphens only, up to 32 chars, e.g. pc-a.",
      "repo.branch": "Branch",
      "repo.branch.hint": "Defaults to main. Non-fast-forward pulls use pull --rebase; never force-push.",
      "repo.token": "Access token",
      "repo.token.hint": "Leave empty to keep the saved token",
      "repo.token.set": "Token saved (local only, never in the repo)",
      "repo.token.unset": "No token saved yet",
      "repo.save": "Save settings",

      "platform.github": "GitHub",
      "platform.gitee": "Gitee",
      "platform.custom": "Custom / self-hosted",

      "auth.https": "HTTPS (token)",
      "auth.ssh": "SSH (system ssh-agent)",

      "scope.title": "Sync scope",
      "scope.hint": "All enabled by default; unchecked files are not written to the remote snapshot.",
      "scope.config": "Profile config (cordis.patch.yml)",
      "scope.providers": "Provider definitions",
      "scope.plugins": "Plugin manifest (MERGE-only)",
      "scope.mcp": "MCP definitions",
      "scope.config.desc": "Merged per entry id; comments and !!js preserved",
      "scope.providers.desc": "Provider definitions are redacted before sync",
      "scope.plugins.desc": "Manifest only, no code; remote-only plugins get an install plan",
      "scope.mcp.desc": "Patch entries containing mcp, redacted",

      "status.title": "Status",
      "status.refresh": "Refresh",
      "status.reachable": "Reachable",
      "status.unreachable": "Unreachable (last probe)",
      "status.unprobed": "Not probed (click Test connection)",
      "status.branch": "Branch",
      "status.local": "Local commits",
      "status.remote": "Remote commit",
      "status.ahead": "Pending upload",
      "status.behind": "Pending download",
      "status.conflict": "Conflict",
      "status.conflict.yes": "conflict",
      "status.conflict.no": "no conflict",
      "status.head": "Latest commit",
      "status.headNone": "(no commit yet)",
      "status.lastSync": "Last sync",
      "status.never": "never",
      "status.error": "Status error",

      "actions.title": "Actions",
      "actions.test": "Test connection",
      "actions.push": "Push",
      "actions.preview": "Preview remote",
      "actions.apply": "Apply overwrite",
      "actions.apply.hint": "Requires a preview with at least one selected entry",
      "actions.refresh": "Refresh status",

      "busy.loading": "Loading…",
      "busy.saving": "Saving…",
      "busy.testing": "Testing…",
      "busy.pushing": "Pushing…",
      "busy.previewing": "Previewing…",
      "busy.applying": "Applying…",
      "busy.rollingBack": "Rolling back…",

      "error.title": "Operation failed",
      "error.network": "Network error: cannot reach the DSH server. Check that it is still running.",
      "error.http": "Server returned HTTP {status}; check the DSH logs.",
      "error.badResponse": "Server returned an unparsable response.",
      "error.unauthorized": "DSH authorization rejected (401/403).",
      "error.unknown": "Unknown error.",
      "error.giteeUsername": "Gitee requires a username (your Gitee login name). A private token is the password, not the username.",
      "error.retry": "Retry",
      "error.dismiss": "Dismiss",

      "notice.saved": "Settings saved.",
      "notice.platformInferred": "Platform switched to \"{platform}\" based on the repository URL.",
      "notice.testOk": "Connected: {branch} @ {sha} {message}",
      "notice.pushed": "Pushed: {branch} @ {commit} ({files} files)",
      "notice.previewReady": "Preview ready: {count} entries.",
      "notice.applied": "Applied {n} entries; a pre-write snapshot was created.",
      "notice.rolledBack": "Rolled back to snapshot {id}.",

      "preview.title": "Preview",
      "preview.empty": "No preview yet. Click \"Preview remote\" to fetch other devices' snapshots and per-entry diffs.",
      "preview.expired": "This preview is stale or already consumed. Please run \"Preview remote\" again.",
      "preview.hint": "Check the entries to adopt. Entries marked \"needs local value\" contain redacted secrets and still require a local value.",
      "preview.source": "Source device",
      "preview.sourceActive": "Apply from",
      "preview.head": "Snapshot commit",
      "preview.entries": "Entries",
      "preview.files": "Snapshot files",
      "preview.selectAll": "Select all adoptable",
      "preview.clearAll": "Clear selection",
      "preview.selected": "{n} selected",
      "preview.noneSelected": "No entry selected",
      "preview.localText": "Local (current)",
      "preview.remoteText": "Remote (will be written)",
      "preview.expand": "Show diff",
      "preview.collapse": "Hide diff",
      "preview.manual": "Needs local value",
      "preview.secret": "Contains redacted secret",
      "preview.none": "(empty)",

      "entry.status.added": "added",
      "entry.status.changed": "changed",
      "entry.status.same": "same",
      "entry.status.manual": "needs local value",
      "entry.adoptRemote": "Adopt remote",
      "entry.keepLocal": "Keep local",

      "plugins.title": "Plugin manifest (merge only)",
      "plugins.hint": "Manifest only, no code. Remote-only plugins get an install plan; local-only plugins are never removed.",
      "plugins.install": "Install / upgrade",
      "plugins.keep": "Keep",
      "plugins.skip": "Skip",
      "plugins.noDowngrade": "No downgrade",
      "plugins.empty": "No plugin manifest data.",
      "plugins.installItem": "{name} @ {version}",
      "plugins.keepItem": "{name} @ {version}",
      "plugins.skipItem": "{name} · {reason}",
      "plugins.noDowngradeItem": "{name}: local {localVersion} > remote {remoteVersion}",
      "plugins.manualNote": "Install items are only written to plugins.to-install.json for you to install manually; this plugin never runs pnpm and never edits the profile.",

      "providers.title": "Provider diff",
      "providers.added": "added",
      "providers.changed": "changed",
      "providers.same": "same",
      "mcp.title": "MCP diff",

      "snapshots.title": "Pre-write snapshots",
      "snapshots.refresh": "Refresh snapshots",
      "snapshots.empty": "No snapshots yet (one is created before every apply/rollback, latest 10 kept).",
      "snapshots.id": "Snapshot",
      "snapshots.time": "Time",
      "snapshots.reason": "Reason",
      "snapshots.bytes": "Size",
      "snapshots.rollback": "Roll back",
      "snapshots.confirm": "Roll the configuration back to snapshot {id}? Current files will be overwritten.",
      "snapshots.confirmYes": "Roll back now",
      "snapshots.cancel": "Cancel",

      "apply.title": "Last apply result",
      "apply.applied": "Written",
      "apply.skipped": "Skipped",
      "apply.snapshot": "Snapshot",
      "apply.verified": "SHA-256 verified",
      "apply.fileSha": "File SHA-256",
      "apply.blockSha": "Entry SHA-256",
      "apply.none": "none",

      "confirm.apply": "Overwrite this machine with {n} entries from {device}? A snapshot is taken first and SHA-256 is verified after writing.",
      "confirm.yes": "Apply now",
      "confirm.cancel": "Cancel",

      "common.close": "Close",
      "common.none": "—",

      "remote.nav": "Remote access",
      "remote.title": "Remote access",
      "remote.subtitle": "Open this machine's DSH from a tablet or phone over LAN / a tunnel: off by default, bound only to the address you pick — never 0.0.0.0.",
      "remote.settings.title": "Remote access settings",
      "remote.enable": "Allow LAN / remote access",
      "remote.enable.hint": "Off by default. Even when on, the listener binds one specific address — save and run a check first.",
      "remote.mode": "Access mode",
      "remote.mode.hint": "Each mode needs its own preparation; unavailable modes state the reason instead of offering a fake switch.",
      "remote.port": "Port",
      "remote.port.hint": "0 = share the DSH port (only the host differs); a positive number pins a fixed port.",
      "remote.fields.lanAddress": "LAN address",
      "remote.fields.lanAddress.placeholder": "Leave empty to auto-pick, e.g. 192.168.1.6",
      "remote.fields.tailscaleHost": "Tailscale host",
      "remote.fields.tailscaleHost.placeholder": "e.g. pc-a.tailnet-xxxx.ts.net",
      "remote.fields.cloudflareHost": "Cloudflare host",
      "remote.fields.cloudflareHost.placeholder": "e.g. xxx.trycloudflare.com",
      "remote.fields.ipv6Address": "IPv6 address",
      "remote.fields.ipv6Address.placeholder": "e.g. 2408:8207:... (no brackets)",
      "remote.fields.manualUrl": "Full URL",
      "remote.fields.manualUrl.placeholder": "e.g. https://example.com/dsh",
      "remote.fields.uu.manualUrl": "Public entry URL",
      "remote.fields.uu.manualUrl.placeholder": "Paste from UU Remote, e.g. abc.uuyc.com:12345 or https://…",
      "remote.field.token": "Access token (optional)",
      "remote.field.token.hint": "Leave empty to send no token; when filled, ?token=… is appended to the link.",
      "remote.token.saved": "Access token saved ({masked})",
      "remote.token.clear": "Clear token",
      "remote.token.cleared": "Cleared",
      "remote.availability.ready": "Available",
      "remote.unsupported": "Unavailable",
      "remote.needsSetup": "Needs setup",
      "remote.requires": "Requires",
      "remote.steps": "How to",
      "remote.status.title": "Runtime status",
      "remote.status.running": "Running",
      "remote.status.stopped": "Stopped",
      "remote.status.listen": "Listening on",
      "remote.status.bound": "Bound address",
      "remote.status.bound.hint": "Bound to this one specific address (not 0.0.0.0); re-pick it after changing networks.",
      "remote.status.connections": "Connections",
      "remote.status.rejected": "Rejected",
      "remote.status.token": "Token",
      "remote.status.token.none": "not generated yet",
      "remote.status.startedAt": "Started",
      "remote.status.lastError": "Last error",
      "remote.actions.title": "Actions",
      "remote.actions.save": "Save settings",
      "remote.actions.start": "Start",
      "remote.actions.stop": "Stop",
      "remote.actions.rotate": "New token",
      "remote.actions.rotate.confirm": "A new token invalidates the old QR code and links immediately, so you must scan again. Generate it?",
      "remote.actions.rotate.yes": "Generate token",
      "remote.actions.rotate.cancel": "Cancel",
      "remote.actions.probe": "Run check again",
      "remote.actions.showLink": "Show QR code and links",
      "remote.actions.copy": "Copy full URL",
      "remote.busy.loading": "Loading…",
      "remote.busy.saving": "Saving…",
      "remote.busy.starting": "Starting…",
      "remote.busy.stopping": "Stopping…",
      "remote.busy.rotating": "Generating…",
      "remote.busy.probing": "Checking…",
      "remote.busy.linking": "Building link…",
      "remote.probe.title": "Connectivity check",
      "remote.probe.ok": "Pass",
      "remote.probe.warn": "Warn",
      "remote.probe.fail": "Fail",
      "remote.probe.unknown": "Unproven",
      "remote.probe.never": "No check yet; run one to see whether this machine is actually reachable.",
      "remote.probe.at": "Checked at",
      "remote.qr.title": "Scan to open",
      "remote.qr.hint": "Scan this code with a tablet",
      "remote.link.hint": "Or type the address below (token-free; the tablet asks for the token on first open).",
      "remote.notice.saved": "Settings saved.",
      "remote.notice.started": "Started.",
      "remote.notice.stopped": "Stopped.",
      "remote.notice.rotated": "New token generated: old links and QR codes are invalid now.",
      "actions.diff": "View diff",
      "actions.rollbackLatest": "Roll back to latest snapshot",
      "busy.diffing": "Comparing…",
      "busy.rollbackPreview": "Computing rollback impact…",
      "diff.title": "Diff preview",
      "diff.hint": "Read-only: no snapshot is created and no file is written.",
      "diff.emptyHint": "Click \"View diff\" to compare the working copy with the current profile.",
      "diff.summary": "{changed} changed files (+{plus} / -{minus} lines)",
      "diff.summary.same": "{n} more files unchanged",
      "diff.empty": "No differences",
      "diff.group.added": "Added",
      "diff.group.modified": "Modified",
      "diff.group.deleted": "Deleted",
      "diff.lineStat": "+{added} / -{removed} lines",
      "diff.expand": "Show hunks",
      "diff.collapse": "Hide hunks",
      "diff.truncated": "Showing the first {n} lines only",
      "diff.truncatedFile": "Binary or oversized: stats only",
      "diff.source.local": "This device: working copy → current profile",
      "diff.source.remote": "Remote device: {device}",
      "diff.deletedNote": "\"Deleted\" means present now but absent from the snapshot; rollback does not remove these files.",
      "diff.failed": "Diff preview failed",
      "rollback.title": "Roll back to latest snapshot",
      "rollback.hint": "Two-step confirmation: review the impact first, then confirm manually.",
      "rollback.step1": "Step 1 of 2: latest snapshot",
      "rollback.step2": "Step 2 of 2: rollback preview",
      "rollback.check": "See what this rollback changes",
      "rollback.confirm": "Confirm rollback (cannot be undone)",
      "rollback.cancel": "Cancel",
      "rollback.back": "Back",
      "rollback.empty": "No snapshot available to roll back to.",
      "rollback.previewFailed": "Rollback preview failed; nothing was written.",
      "rollback.willRestore": "Will write",
      "rollback.none": "No file will be rewritten",
      "rollback.summary": "{changed} files will change (+{plus} / -{minus} lines)",
      "rollback.same": "Identical to the current file",
      "rollback.snapshot": "Snapshot {id}",
      "rollback.reason": "Reason: {reason}",
      "rollback.createdAt": "Created {time}",
      "remote.notice.probed": "Check finished."
    }

    const DICTS = { zh: zh, en: en }

    /**
     * 顶层 `truncated: true` 的补足文案（M1）：`diff.truncated` 只说"仅显示前 N 行"，
     * 预算用尽时还必须告诉用户"还有更多、该怎么办"。
     *
     * 说明：`locale/*.json` 不在本轮可改范围（改了就与 `locale.test.mjs` 的 key 对齐断言冲突），
     * 所以这半句以常量形式留在这里，**不加入** DICTS 的 key 集合。
     */
    const TRUNC_MORE = {
      zh: '差异，还有更多（请把区间缩小或直接看文件）',
      en: '; more remain (narrow the range or open the file)'
    }

    // ------------------------------------------------------------------
    // Translation
    // ------------------------------------------------------------------
    let serviceT = null // bound to ctx.locale.t in apply(), when available

    function detectLang() {
      try {
        const doc = typeof document === 'undefined' ? null : document
        let raw = ''
        if (doc && doc.documentElement) {
          raw = doc.documentElement.getAttribute('lang') || doc.documentElement.lang || ''
        }
        if (!raw && typeof navigator !== 'undefined' && navigator) raw = navigator.language || ''
        raw = String(raw).toLowerCase()
        if (raw.indexOf('zh') === 0) return 'zh'
        if (raw.indexOf('en') === 0) return 'en'
      } catch (e) {
        /* ignore */
      }
      return 'zh'
    }

    const lang = detectLang()

    function interpolate(text, vars) {
      if (!vars || typeof text !== 'string') return text
      return text.replace(/\{([a-zA-Z0-9_]+)\}/g, function (all, name) {
        if (Object.prototype.hasOwnProperty.call(vars, name)) {
          const v = vars[name]
          return v === undefined || v === null ? '' : String(v)
        }
        return all
      })
    }

    function t(key, vars) {
      if (serviceT) {
        try {
          const out = serviceT(key)
          if (typeof out === 'string' && out !== '' && out !== key) return interpolate(out, vars)
        } catch (e) {
          /* fall through to the bundled dictionary */
        }
      }
      const dict = DICTS[lang] || DICTS.zh
      let text = dict[key]
      if (typeof text !== 'string') text = DICTS.zh[key]
      if (typeof text !== 'string') text = key
      return interpolate(text, vars)
    }

    /** Component-level translator: prefers the `t` prop handed over by the slot host. */
    function makeT(props) {
      const fn = props && typeof props.t === 'function' ? props.t : null
      return function translate(key, vars) {
        if (fn) {
          try {
            const out = fn(key)
            if (typeof out === 'string' && out !== '' && out !== key) return interpolate(out, vars)
          } catch (e) {
            /* fall through */
          }
        }
        return t(key, vars)
      }
    }

    // ------------------------------------------------------------------
    // Theme + inline styles (only --dsw-alias-* variables, with neutral fallbacks)
    // ------------------------------------------------------------------
    const C = {
      borderL1: 'var(--dsw-alias-border-l1, rgba(127,127,127,.14))',
      borderL2: 'var(--dsw-alias-border-l2, rgba(127,127,127,.22))',
      bgBase: 'var(--dsw-alias-bg-base, #ffffff)',
      bgFloat: 'var(--dsw-alias-bg-float, rgba(127,127,127,.05))',
      labelPrimary: 'var(--dsw-alias-label-primary, #1f1f1f)',
      labelSecondary: 'var(--dsw-alias-label-secondary, #4a4a4a)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, #767676)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10))',
      btnFill: 'var(--dsw-alias-button-tool-bar-fill, rgba(127,127,127,.08))',
      accent: 'var(--dsw-alias-state-business-primary, #2a7de1)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
    }

    const TONE = {
      ok: {
        background: 'var(--dsw-alias-state-success-soft, rgba(18,150,78,.14))',
        color: 'var(--dsw-alias-state-success-primary, #0d7a3f)'
      },
      info: {
        background: 'var(--dsw-alias-state-info-soft, rgba(40,120,255,.12))',
        color: 'var(--dsw-alias-state-info-primary, #2a7de1)'
      },
      warn: {
        background: 'var(--dsw-alias-state-warning-soft, rgba(220,140,0,.14))',
        color: 'var(--dsw-alias-state-warning-primary, #a76500)'
      },
      err: {
        background: 'var(--dsw-alias-state-error-soft, rgba(220,60,60,.12))',
        color: 'var(--dsw-alias-state-error-primary, #c62828)'
      },
      mute: {
        background: 'var(--dsw-alias-bg-base, rgba(127,127,127,.10))',
        color: 'var(--dsw-alias-label-tertiary, #767676)'
      }
    }

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '4px 2px 18px',
        fontSize: 13,
        lineHeight: 1.55,
        color: C.labelPrimary,
        minWidth: 0,
        maxWidth: '100%',
        boxSizing: 'border-box'
      },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
      headText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      title: { fontSize: 16, fontWeight: 600, margin: 0, color: C.labelPrimary },
      desc: { fontSize: 12, margin: 0, color: C.labelTertiary, lineHeight: 1.5 },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        border: '1px solid ' + C.borderL2,
        borderRadius: 10,
        background: C.bgFloat,
        minWidth: 0,
        boxSizing: 'border-box'
      },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
      cardTitle: { fontSize: 13, fontWeight: 600, margin: 0, color: C.labelPrimary },
      hint: { fontSize: 11.5, margin: 0, color: C.labelTertiary, lineHeight: 1.5 },
      hintWarn: {
        fontSize: 11.5,
        margin: 0,
        color: 'var(--dsw-alias-state-warning-primary, #a76500)',
        lineHeight: 1.5
      },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, minWidth: 0 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      label: { fontSize: 12, color: C.labelSecondary },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        fontSize: 12.5,
        color: C.labelPrimary,
        background: C.bgBase,
        border: '1px solid ' + C.borderL2,
        borderRadius: 6,
        padding: '5px 8px',
        outline: 'none',
        minWidth: 0
      },
      select: {
        width: '100%',
        boxSizing: 'border-box',
        fontSize: 12.5,
        color: C.labelPrimary,
        background: C.bgBase,
        border: '1px solid ' + C.borderL2,
        borderRadius: 6,
        padding: '5px 6px',
        outline: 'none',
        minWidth: 0
      },
      inputDisabled: { opacity: 0.6, cursor: 'not-allowed' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      grow: { flex: '1 1 auto' },
      btn: {
        fontSize: 12,
        fontWeight: 500,
        color: C.labelPrimary,
        background: C.btnFill,
        border: '1px solid ' + C.borderL2,
        borderRadius: 6,
        padding: '4px 11px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        boxSizing: 'border-box'
      },
      btnPrimary: { color: C.accent, borderColor: C.accent, fontWeight: 600 },
      btnDanger: {
        color: 'var(--dsw-alias-state-error-primary, #c62828)',
        borderColor: 'var(--dsw-alias-state-error-primary, #c62828)'
      },
      btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
      linkBtn: {
        fontSize: 11.5,
        color: C.accent,
        background: 'transparent',
        border: 'none',
        padding: '1px 4px',
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      },
      segBtn: {
        fontSize: 11.5,
        padding: '2px 8px',
        borderRadius: 5,
        border: '1px solid ' + C.borderL2,
        background: 'transparent',
        color: C.labelSecondary,
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      },
      segBtnActive: { background: C.accent, borderColor: C.accent, color: '#ffffff' },
      seg: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        fontWeight: 500,
        padding: '1px 8px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        flex: 'none'
      },
      checkbox: { accentColor: C.accent, margin: 0, flex: 'none' },
      checkRow: { display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', minWidth: 0 },
      checkText: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
      checkLabel: { fontSize: 12.5, color: C.labelPrimary },
      checkDesc: { fontSize: 11, color: C.labelTertiary, lineHeight: 1.45 },
      errorBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-error-primary, #c62828)',
        background: 'var(--dsw-alias-state-error-soft, rgba(220,60,60,.10))',
        color: C.labelPrimary,
        minWidth: 0
      },
      errorHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
      errorTitle: { fontSize: 12.5, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary, #c62828)' },
      errorCode: { fontFamily: C.mono, fontSize: 11.5, color: C.labelSecondary },
      errorMsg: { fontSize: 12, color: C.labelPrimary, wordBreak: 'break-word' },
      errorHint: { fontSize: 11.5, color: C.labelSecondary, wordBreak: 'break-word' },
      notice: {
        fontSize: 12,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-success-primary, #0d7a3f)',
        background: 'var(--dsw-alias-state-success-soft, rgba(18,150,78,.10))',
        color: C.labelPrimary,
        wordBreak: 'break-word'
      },
      metaRow: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, flexWrap: 'wrap' },
      metaLabel: { fontSize: 11.5, color: C.labelTertiary, flex: 'none' },
      metaValue: { fontSize: 12, color: C.labelPrimary, minWidth: 0, wordBreak: 'break-word' },
      mono: { fontFamily: C.mono, fontSize: 11.5 },
      source: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid ' + C.borderL2,
        background: C.bgBase,
        minWidth: 0
      },
      sourceActive: { borderColor: C.accent, boxShadow: '0 0 0 1px ' + C.accent + ' inset' },
      sourceHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      sourceName: { fontFamily: C.mono, fontSize: 12.5, fontWeight: 600, color: C.labelPrimary, wordBreak: 'break-all' },
      radio: { accentColor: C.accent, margin: 0, flex: 'none' },
      radioWrap: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
      chipRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
      chip: {
        fontSize: 11,
        maxWidth: '100%',
        padding: '1px 7px',
        borderRadius: 5,
        border: '1px solid ' + C.borderL1,
        color: C.labelSecondary,
        background: C.bgFloat,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      },
      entries: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      entry: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '7px 9px',
        borderRadius: 7,
        border: '1px solid ' + C.borderL1,
        background: C.bgFloat,
        minWidth: 0
      },
      entryHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      entryName: { fontFamily: C.mono, fontSize: 12, color: C.labelPrimary, minWidth: 0, wordBreak: 'break-all' },
      manualNote: { fontSize: 11, color: 'var(--dsw-alias-state-warning-primary, #a76500)' },
      diffGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8, minWidth: 0 },
      diffCol: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      diffColHead: { fontSize: 11, color: C.labelTertiary },
      pre: {
        margin: 0,
        padding: '6px 8px',
        fontFamily: C.mono,
        fontSize: 11.5,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 220,
        overflow: 'auto',
        background: C.bgBase,
        border: '1px solid ' + C.borderL1,
        borderRadius: 6,
        color: C.labelPrimary,
        minWidth: 0
      },
      block: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        borderRadius: 7,
        border: '1px dashed ' + C.borderL2,
        minWidth: 0
      },
      blockHead: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      blockTitle: { fontSize: 12, fontWeight: 600, color: C.labelPrimary },
      list: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      listRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
      listText: { fontFamily: C.mono, fontSize: 11.5, color: C.labelPrimary, wordBreak: 'break-all' },
      listMeta: { fontSize: 11, color: C.labelTertiary, wordBreak: 'break-all' },
      snapRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '7px 9px',
        borderRadius: 7,
        border: '1px solid ' + C.borderL1,
        background: C.bgBase,
        minWidth: 0
      },
      snapMain: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      snapId: { fontFamily: C.mono, fontSize: 11.5, color: C.labelPrimary, wordBreak: 'break-all' },
      snapMeta: { fontSize: 11, color: C.labelTertiary },
      confirmBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '8px 10px',
        borderRadius: 7,
        border: '1px solid ' + C.accent,
        background: C.bgBase,
        minWidth: 0
      },
      confirmInline: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      confirmText: { fontSize: 11.5, color: C.labelPrimary, flex: '1 1 220px', minWidth: 0, wordBreak: 'break-word' }
    }

    // ------------------------------------------------------------------
    // Formatting helpers
    // ------------------------------------------------------------------
    function num(v) {
      if (typeof v === 'number' && isFinite(v)) return String(v)
      if (typeof v === 'string' && v !== '') return v
      return '0'
    }

    /** 三态/未知数量：null 表示"本地没有 upstream 引用，未计算"，显示成 — 而不是 0。 */
    function numOrDash(v) {
      if (v === null || v === undefined) return '—'
      if (typeof v === 'number' && isFinite(v)) return String(v)
      if (typeof v === 'string' && v !== '') return v
      return '—'
    }

    function shortSha(sha) {
      if (typeof sha !== 'string' || !sha) return '—'
      return sha.length > 7 ? sha.slice(0, 7) : sha
    }

    function fmtTime(value) {
      if (!value) return '—'
      try {
        const d = new Date(value)
        if (isNaN(d.getTime())) return String(value)
        return d.toLocaleString()
      } catch (e) {
        return String(value)
      }
    }

    function fmtBytes(n) {
      if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—'
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function asText(v) {
      return typeof v === 'string' ? v : ''
    }

    // ------------------------------------------------------------------
    // RPC (same-origin fetch; never throws)
    // ------------------------------------------------------------------
    async function rpcCall(action, payload) {
      const body = Object.assign({ action: action }, payload && typeof payload === 'object' ? payload : {})
      let response
      try {
        response = await fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      } catch (e) {
        return { ok: false, error: { code: 'E_NETWORK', message: (e && e.message) || '' } }
      }
      const status = response && typeof response.status === 'number' ? response.status : 0
      let text = ''
      try {
        text = await response.text()
      } catch (e) {
        text = ''
      }
      let json = null
      if (text) {
        try {
          json = JSON.parse(text)
        } catch (e) {
          json = null
        }
      }
      if (json && typeof json === 'object') {
        if (json.ok === true) return { ok: true, data: json.data }
        if (json.ok === false) {
          const raw = json.error && typeof json.error === 'object' ? json.error : {}
          return {
            ok: false,
            error: {
              code: String(raw.code || (status === 401 || status === 403 ? 'E_AUTH' : 'E_UNKNOWN')),
              message: String(raw.message || ''),
              details: raw.details
            }
          }
        }
      }
      if (status === 401 || status === 403) return { ok: false, error: { code: 'E_AUTH', message: 'HTTP ' + status } }
      if (status >= 400) return { ok: false, error: { code: 'E_HTTP', message: 'HTTP ' + status } }
      return { ok: false, error: { code: 'E_BAD_RESPONSE', message: text ? text.slice(0, 300) : 'HTTP ' + status } }
    }

    /** Normalise an error envelope into `{code, message, hint?}` with localized text. */
    function localizeError(translate, error) {
      const e = error && typeof error === 'object' ? error : {}
      const code = String(e.code || 'E_UNKNOWN')
      const raw = asText(e.message)
      let message = ''
      if (code === 'E_NETWORK') message = translate('error.network')
      else if (code === 'E_HTTP') {
        const digits = raw.replace(/[^0-9]/g, '')
        message = translate('error.http', { status: digits || '?' })
      } else if (code === 'E_BAD_RESPONSE') {
        message = translate('error.badResponse') + (raw ? ' · ' + raw : '')
      } else if (code === 'E_AUTH') {
        message = translate('error.unauthorized') + (raw ? ' · ' + raw : '')
      } else {
        message = raw || translate('error.unknown')
      }
      return { code: code, message: message }
    }

    // ------------------------------------------------------------------
    // Settings / preview helpers
    // ------------------------------------------------------------------
    function emptyForm() {
      return {
        platform: 'github',
        repoUrl: '',
        authMode: 'https',
        username: '',
        deviceId: '',
        branch: 'main',
        scope: { config: true, providers: true, plugins: true, mcp: true }
      }
    }

    function normalizeSettings(settings) {
      const src = settings && typeof settings === 'object' ? settings : {}
      const scope = src.scope && typeof src.scope === 'object' ? src.scope : {}
      return {
        platform: src.platform === 'gitee' || src.platform === 'custom' ? src.platform : 'github',
        repoUrl: asText(src.repoUrl),
        authMode: src.authMode === 'ssh' ? 'ssh' : 'https',
        username: asText(src.username),
        deviceId: asText(src.deviceId),
        branch: asText(src.branch) || 'main',
        scope: {
          config: scope.config !== false,
          providers: scope.providers !== false,
          plugins: scope.plugins !== false,
          mcp: scope.mcp !== false
        }
      }
    }

    /**
     * 平台推断：只纠正默认的 github（用户明确选 gitee/custom 时尊重原选择）。
     * 与 host `engine/settings.ts` 的 inferPlatform 保持同一规则。
     */
    function inferPlatform(repoUrl, platform) {
      const url = asText(repoUrl).toLowerCase()
      if (platform === 'github' && url.indexOf('gitee.com') >= 0) return 'gitee'
      if (platform === 'github' && url.indexOf('gitlab.com') >= 0) return 'custom'
      return platform
    }

    function usernameHint(translate, platform) {
      const specific =
        platform === 'gitee'
          ? translate('repo.username.hint.gitee')
          : platform === 'custom'
            ? translate('repo.username.hint.custom')
            : translate('repo.username.hint.github')
      return translate('repo.username.hint') + ' ' + specific
    }

    function urlPlaceholder(platform) {
      if (platform === 'gitee') return 'https://gitee.com/owner/repo.git'
      if (platform === 'custom') return 'git@example.com:owner/repo.git'
      return 'https://github.com/owner/repo.git'
    }

    function urlHint(translate, platform) {
      if (platform === 'gitee') return translate('repo.url.hint.gitee')
      if (platform === 'custom') return translate('repo.url.hint.custom')
      return translate('repo.url.hint.github')
    }

    function entryKey(deviceId, id) {
      return String(deviceId) + '::' + String(id)
    }

    function entryStatus(entry) {
      const status = entry && typeof entry === 'object' ? String(entry.status || '') : ''
      if (status === 'added' || status === 'changed' || status === 'same' || status === 'manual') return status
      return 'same'
    }

    function buildSelection(sources) {
      const out = {}
      const list = Array.isArray(sources) ? sources : []
      for (let si = 0; si < list.length; si++) {
        const src = list[si] || {}
        const entries = Array.isArray(src.entries) ? src.entries : []
        for (let ei = 0; ei < entries.length; ei++) {
          const entry = entries[ei] || {}
          const status = entryStatus(entry)
          out[entryKey(src.deviceId, entry.id)] = status === 'added' || status === 'changed'
        }
      }
      return out
    }

    function findSource(sources, deviceId) {
      const list = Array.isArray(sources) ? sources : []
      for (let i = 0; i < list.length; i++) {
        const src = list[i] || {}
        if (String(src.deviceId || '') === String(deviceId || '')) return src
      }
      return null
    }

    function collectSelected(source, selection) {
      const out = []
      if (!source || typeof source !== 'object') return out
      const entries = Array.isArray(source.entries) ? source.entries : []
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] || {}
        if (entryStatus(entry) === 'same') continue
        if (selection[entryKey(source.deviceId, entry.id)]) out.push(String(entry.id))
      }
      return out
    }

    function countEntries(sources) {
      let total = 0
      const list = Array.isArray(sources) ? sources : []
      for (let i = 0; i < list.length; i++) {
        total += Array.isArray(list[i] && list[i].entries) ? list[i].entries.length : 0
      }
      return total
    }

    function findSnapshot(snapshots, id) {
      const list = Array.isArray(snapshots) ? snapshots : []
      const wanted = String(id || '')
      for (let i = 0; i < list.length; i++) {
        const meta = list[i] && typeof list[i] === 'object' ? list[i] : {}
        if (asText(meta.id) === wanted && wanted !== '') return meta
      }
      return null
    }

    /** 差异 totals 归一（缺字段按 0，绝不显示 NaN）。 */
    function diffTotals(summary) {
      const s = summary && typeof summary === 'object' ? summary : {}
      const t = s.totals && typeof s.totals === 'object' ? s.totals : {}
      function count(v) {
        return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0
      }
      const added = count(t.added)
      const modified = count(t.modified)
      const deleted = count(t.deleted)
      return {
        added: added,
        modified: modified,
        deleted: deleted,
        same: count(t.same),
        plus: count(t.addedLines),
        minus: count(t.removedLines),
        changed: added + modified + deleted
      }
    }

    /** 一句结论（与 host `summarize()` 同一口径，文案走 locale）。 */
    function summarizeFileDiff(translate, summary) {
      const totals = diffTotals(summary)
      if (totals.changed === 0) return translate('diff.empty')
      let text = translate('diff.summary', { changed: totals.changed, plus: totals.plus, minus: totals.minus })
      if (totals.same > 0) text += ' · ' + translate('diff.summary.same', { n: totals.same })
      return text
    }

    /** 按 kind 分组；`same` 不展示（只在结论里报数量）。 */
    function fileDiffGroups(files) {
      const groups = { added: [], modified: [], deleted: [] }
      const list = Array.isArray(files) ? files : []
      for (let i = 0; i < list.length; i++) {
        const file = list[i] && typeof list[i] === 'object' ? list[i] : {}
        if (file.kind === 'added' || file.kind === 'modified' || file.kind === 'deleted') groups[file.kind].push(file)
      }
      return groups
    }

    function kindBadge(translate, kind) {
      if (kind === 'added') return { text: translate('diff.group.added'), tone: 'ok' }
      if (kind === 'deleted') return { text: translate('diff.group.deleted'), tone: 'warn' }
      return { text: translate('diff.group.modified'), tone: 'info' }
    }

    /** 顶层 truncated 的提示文案：前缀走 locale，补足半句走 TRUNC_MORE。 */
    function truncationHint(translate, shownLines) {
      return translate('diff.truncated', { n: shownLines }) + (TRUNC_MORE[lang] || TRUNC_MORE.zh)
    }

    /**
     * 文件级差异列表：按「新增 / 修改 / 删除」分组，每行 path + 行数 + 字节变化，
     * 有 hunk 时可展开（等宽、限高滚动，truncated 时明说只显示了前 N 行）。
     *
     * `props.truncated` 是**顶层** "还有差异没展示"（M1）：预算恰好用完时后续 hunk
     * 根本没产出，每个已产出的 hunk 都是 `truncated: false`，所以不能只看 hunk 级标记。
     */
    function FileDiffList(props) {
      const translate = props.t
      const files = Array.isArray(props.files) ? props.files : []
      const hunks = Array.isArray(props.hunks) ? props.hunks : []
      const openMap = props.openMap && typeof props.openMap === 'object' ? props.openMap : {}
      if (!files.length) return h('p', { style: S.hint }, asText(props.emptyLabel) || translate('diff.empty'))
      const groups = fileDiffGroups(files)
      const blocks = []
      if (props.truncated === true) {
        const shownLines = hunks.reduce(function (sum, hunk) {
          const lines = Array.isArray(hunk && hunk.lines) ? hunk.lines : []
          return sum + lines.length
        }, 0)
        blocks.push(h('p', { key: 'diff-truncated', style: S.hintWarn }, truncationHint(translate, shownLines)))
      }
      ;['added', 'modified', 'deleted'].forEach(function (kind) {
        const list = groups[kind]
        if (!list.length) return
        const badge = kindBadge(translate, kind)
        blocks.push(
          h(
            'div',
            { key: 'diff-group-' + kind, style: S.block },
            h(
              'div',
              { style: S.blockHead },
              h(Badge, { text: badge.text + ' ' + list.length, tone: badge.tone }),
              kind === 'deleted' ? h('span', { style: S.hint }, translate('diff.deletedNote')) : null
            ),
            h(
              'div',
              { style: S.list },
              list.map(function (file, index) {
                const path = asText(file.path)
                const pathHunks = hunks.filter(function (hunk) {
                  return asText(hunk && hunk.path) === path
                })
                const open = Boolean(openMap[path])
                const rows = [
                  h(
                    'div',
                    { key: 'row-' + index, style: S.listRow },
                    h('span', { style: S.listText }, path || '—'),
                    h(
                      'span',
                      { style: S.listMeta },
                      translate('diff.lineStat', { added: num(file.addedLines), removed: num(file.removedLines) })
                    ),
                    h('span', { style: S.listMeta }, fmtBytes(file.beforeBytes) + ' → ' + fmtBytes(file.afterBytes)),
                    file.truncated
                      ? h(Badge, { text: translate('diff.truncatedFile'), tone: 'warn' })
                      : null,
                    pathHunks.length
                      ? h(
                          'button',
                          {
                            type: 'button',
                            style: S.linkBtn,
                            onClick: function () {
                              if (typeof props.onToggle === 'function') props.onToggle(path)
                            }
                          },
                          open ? translate('diff.collapse') : translate('diff.expand')
                        )
                      : null
                  )
                ]
                if (open) {
                  pathHunks.forEach(function (hunk, hunkIndex) {
                    const lines = Array.isArray(hunk && hunk.lines) ? hunk.lines : []
                    rows.push(
                      h(
                        'div',
                        { key: 'hunk-' + hunkIndex, style: S.diffCol },
                        h('div', { style: S.diffColHead }, asText(hunk && hunk.header) || '@@'),
                        h('pre', { style: S.pre }, lines.join('\n')),
                        hunk && hunk.truncated
                          ? h('div', { style: S.hint }, translate('diff.truncated', { n: lines.length }))
                          : null
                      )
                    )
                  })
                }
                return h('div', { key: 'file-' + index, style: S.entry }, rows)
              })
            )
          )
        )
      })
      return h('div', { style: S.entries }, blocks)
    }

    // ------------------------------------------------------------------
    // Presentational components (stateless, inline styles only)
    // ------------------------------------------------------------------
    function Badge(props) {
      const tone = TONE[props.tone] || TONE.mute
      return h(
        'span',
        { style: Object.assign({}, S.badge, tone), title: asText(props.title) },
        asText(props.text)
      )
    }

    function Btn(props) {
      const disabled = Boolean(props.disabled)
      return h(
        'button',
        {
          type: 'button',
          disabled: disabled,
          title: asText(props.title),
          onClick: disabled ? undefined : props.onClick,
          style: Object.assign(
            {},
            S.btn,
            props.primary ? S.btnPrimary : null,
            props.danger ? S.btnDanger : null,
            disabled ? S.btnDisabled : null,
            props.style || null
          )
        },
        asText(props.label)
      )
    }

    function SegBtn(props) {
      const disabled = Boolean(props.disabled)
      return h(
        'button',
        {
          type: 'button',
          disabled: disabled,
          onClick: disabled ? undefined : props.onClick,
          style: Object.assign(
            {},
            S.segBtn,
            props.active ? S.segBtnActive : null,
            disabled ? S.btnDisabled : null
          )
        },
        asText(props.label)
      )
    }

    function Input(props) {
      return h('input', {
        type: props.type === 'password' ? 'password' : 'text',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: asText(props.placeholder),
        disabled: Boolean(props.disabled),
        autoComplete: props.autoComplete === 'new-password' ? 'new-password' : 'off',
        spellCheck: props.spellCheck === true,
        onChange: function (event) {
          if (typeof props.onChange === 'function') props.onChange(event.target.value)
        },
        style: Object.assign({}, S.input, props.disabled ? S.inputDisabled : null)
      })
    }

    function Select(props) {
      const options = Array.isArray(props.options) ? props.options : []
      return h(
        'select',
        {
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          disabled: Boolean(props.disabled),
          onChange: function (event) {
            if (typeof props.onChange === 'function') props.onChange(event.target.value)
          },
          style: Object.assign({}, S.select, props.disabled ? S.inputDisabled : null)
        },
        options.map(function (opt) {
          const o = opt || {}
          return h('option', { key: String(o.value), value: String(o.value) }, asText(o.label))
        })
      )
    }

    function CheckRow(props) {
      return h(
        'label',
        { style: S.checkRow },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.checked),
          disabled: Boolean(props.disabled),
          onChange: function (event) {
            if (typeof props.onChange === 'function') props.onChange(Boolean(event.target.checked))
          },
          style: S.checkbox
        }),
        h(
          'span',
          { style: S.checkText },
          h('span', { style: S.checkLabel }, asText(props.label)),
          props.desc ? h('span', { style: S.checkDesc }, asText(props.desc)) : null
        )
      )
    }

    /**
     * React passes children in `props.children`, never as extra arguments:
     * reading `arguments` here drops every child and renders empty cards/fields.
     */
    function childrenOf(props) {
      return React.Children.toArray(props.children === undefined ? [] : props.children)
    }

    /** Wrap children in keyed fragments so React never warns about lists. */
    function keyedKids(kids, prefix) {
      return kids.map(function (kid, i) {
        return h(React.Fragment, { key: prefix + i }, kid)
      })
    }

    function Card(props) {
      const kids = childrenOf(props)
      return h(
        'section',
        { style: Object.assign({}, S.card, props.style || null) },
        props.title
          ? h(
              'div',
              { style: S.cardHead },
              h('h3', { style: S.cardTitle }, asText(props.title)),
              props.right || null
            )
          : null,
        keyedKids(kids, 'card-')
      )
    }

    function Field(props) {
      const kids = childrenOf(props)
      return h(
        'div',
        { style: S.field },
        h('label', { style: S.label }, asText(props.label)),
        keyedKids(kids, 'field-'),
        props.hint ? h('p', { style: S.hint }, asText(props.hint)) : null
      )
    }

    function ErrorBox(props) {
      const err = props.error && typeof props.error === 'object' ? props.error : {}
      return h(
        'div',
        { style: S.errorBox, role: 'alert' },
        h(
          'div',
          { style: S.errorHead },
          h('span', { style: S.errorTitle }, asText(props.title)),
          typeof props.onDismiss === 'function'
            ? h('button', { type: 'button', style: S.linkBtn, onClick: props.onDismiss }, asText(props.dismissLabel))
            : null
        ),
        h('div', { style: S.errorCode }, asText(err.code) || 'E_UNKNOWN'),
        h('div', { style: S.errorMsg }, asText(err.message)),
        err.hint ? h('div', { style: S.errorHint }, asText(err.hint)) : null,
        typeof props.onRetry === 'function'
          ? h(Btn, { label: asText(props.retryLabel), onClick: props.onRetry, style: { alignSelf: 'flex-start' } })
          : null
      )
    }

    function DiffList(props) {
      const translate = props.t
      const data = props.data && typeof props.data === 'object' ? props.data : {}
      const added = Array.isArray(data.added) ? data.added : []
      const changed = Array.isArray(data.changed) ? data.changed : []
      const same = Array.isArray(data.same) ? data.same : []
      const groups = []
      function group(label, arr, tone) {
        if (!arr.length) return null
        return h(
          'div',
          { style: S.chipRow, key: 'g-' + label },
          h(Badge, { text: label + ' ' + arr.length, tone: tone }),
          arr.map(function (name, i) {
            return h('span', { key: 'c' + i, style: S.chip, title: String(name) }, String(name))
          })
        )
      }
      groups.push(group(translate('providers.added'), added, 'ok'))
      groups.push(group(translate('providers.changed'), changed, 'info'))
      groups.push(group(translate('providers.same'), same, 'mute'))
      return h(
        'div',
        { style: S.block },
        h('div', { style: S.blockHead }, h('span', { style: S.blockTitle }, asText(props.title))),
        added.length + changed.length + same.length
          ? groups
          : h('div', { style: S.hint }, translate('common.none'))
      )
    }

    function PluginBlock(props) {
      const translate = props.t
      const plan = props.plugins && typeof props.plugins === 'object' ? props.plugins : {}
      const install = Array.isArray(plan.install) ? plan.install : []
      const keep = Array.isArray(plan.keep) ? plan.keep : []
      const skip = Array.isArray(plan.skip) ? plan.skip : []
      const noDowngrade = Array.isArray(plan.noDowngrade) ? plan.noDowngrade : []
      const total = install.length + keep.length + skip.length + noDowngrade.length
      const rows = []
      install.forEach(function (item, i) {
        const o = item && typeof item === 'object' ? item : { name: String(item), version: '' }
        rows.push(
          h(
            'div',
            { key: 'pi' + i, style: S.listRow },
            h(Badge, { text: translate('plugins.install'), tone: 'ok' }),
            h('span', { style: S.listText }, translate('plugins.installItem', { name: asText(o.name), version: asText(o.version) || '?' })),
            h('span', { style: S.listMeta }, asText(o.source))
          )
        )
      })
      keep.forEach(function (item, i) {
        const o = item && typeof item === 'object' ? item : { name: String(item), version: '' }
        rows.push(
          h(
            'div',
            { key: 'pk' + i, style: S.listRow },
            h(Badge, { text: translate('plugins.keep'), tone: 'mute' }),
            h('span', { style: S.listText }, translate('plugins.keepItem', { name: asText(o.name), version: asText(o.version) || '?' }))
          )
        )
      })
      skip.forEach(function (item, i) {
        const o = item && typeof item === 'object' ? item : { name: String(item), reason: '' }
        rows.push(
          h(
            'div',
            { key: 'ps' + i, style: S.listRow },
            h(Badge, { text: translate('plugins.skip'), tone: 'warn' }),
            h('span', { style: S.listText }, translate('plugins.skipItem', { name: asText(o.name), reason: asText(o.reason) }))
          )
        )
      })
      noDowngrade.forEach(function (item, i) {
        const o = item && typeof item === 'object' ? item : {}
        rows.push(
          h(
            'div',
            { key: 'pn' + i, style: S.listRow },
            h(Badge, { text: translate('plugins.noDowngrade'), tone: 'err' }),
            h(
              'span',
              { style: S.listText },
              translate('plugins.noDowngradeItem', {
                name: asText(o.name),
                localVersion: asText(o.localVersion) || '?',
                remoteVersion: asText(o.remoteVersion) || '?'
              })
            )
          )
        )
      })
      return h(
        'div',
        { style: S.block },
        h(
          'div',
          { style: S.blockHead },
          h('span', { style: S.blockTitle }, translate('plugins.title')),
          h(Badge, { text: translate('plugins.install') + ' ' + install.length, tone: install.length ? 'ok' : 'mute' }),
          h(Badge, { text: translate('plugins.keep') + ' ' + keep.length, tone: 'mute' }),
          h(Badge, { text: translate('plugins.skip') + ' ' + skip.length, tone: skip.length ? 'warn' : 'mute' }),
          h(Badge, {
            text: translate('plugins.noDowngrade') + ' ' + noDowngrade.length,
            tone: noDowngrade.length ? 'err' : 'mute'
          })
        ),
        h('div', { style: S.hint }, translate('plugins.hint')),
        total ? h('div', { style: S.list }, rows) : h('div', { style: S.hint }, translate('plugins.empty')),
        h('div', { style: S.hint }, translate('plugins.manualNote'))
      )
    }

    function EntryRow(props) {
      const translate = props.t
      const entry = props.entry && typeof props.entry === 'object' ? props.entry : {}
      const status = entryStatus(entry)
      const isSame = status === 'same'
      const isManual = status === 'manual'
      const keepingLocal = props.mode === 'local'
      const tone = status === 'added' ? 'ok' : status === 'changed' ? 'info' : isManual ? 'warn' : 'mute'
      const label =
        status === 'added'
          ? translate('entry.status.added')
          : status === 'changed'
            ? translate('entry.status.changed')
            : isManual
              ? translate('entry.status.manual')
              : translate('entry.status.same')
      const identity = asText(entry.name) || asText(entry.id) || '—'
      return h(
        'div',
        { style: S.entry },
        h(
          'div',
          { style: S.entryHead },
          isSame
            ? null
            : h('input', {
                type: 'checkbox',
                checked: Boolean(props.checked),
                disabled: Boolean(props.disabled) || keepingLocal,
                onChange: function (event) {
                  if (typeof props.onToggle === 'function') props.onToggle(Boolean(event.target.checked))
                },
                style: S.checkbox,
                'aria-label': identity
              }),
          h(Badge, { text: label, tone: tone }),
          h('span', { style: S.entryName, title: asText(entry.id) }, identity),
          entry.secretStripped ? h(Badge, { text: translate('preview.secret'), tone: 'warn' }) : null,
          h('span', { style: S.grow }),
          h(
            'span',
            { style: S.seg },
            h(SegBtn, {
              active: !keepingLocal,
              disabled: isSame || Boolean(props.disabled),
              label: translate('entry.adoptRemote'),
              onClick: function () {
                if (typeof props.onMode === 'function') props.onMode('remote')
              }
            }),
            h(SegBtn, {
              active: keepingLocal,
              disabled: isSame || Boolean(props.disabled),
              label: translate('entry.keepLocal'),
              onClick: function () {
                if (typeof props.onMode === 'function') props.onMode('local')
              }
            })
          ),
          h(
            'button',
            {
              type: 'button',
              style: S.linkBtn,
              onClick: function () {
                if (typeof props.onExpand === 'function') props.onExpand()
              }
            },
            props.open ? translate('preview.collapse') : translate('preview.expand')
          )
        ),
        isManual ? h('div', { style: S.manualNote }, translate('preview.manual')) : null,
        props.open
          ? h(
              'div',
              { style: S.diffGrid },
              h(
                'div',
                { style: S.diffCol },
                h('div', { style: S.diffColHead }, translate('preview.localText')),
                h('pre', { style: S.pre }, asText(entry.localText) || translate('preview.none'))
              ),
              h(
                'div',
                { style: S.diffCol },
                h('div', { style: S.diffColHead }, translate('preview.remoteText')),
                h('pre', { style: S.pre }, asText(entry.remoteText) || translate('preview.none'))
              )
            )
          : null
      )
    }

    // ------------------------------------------------------------------
    // Settings section
    // ------------------------------------------------------------------
    function SettingsPanel(props) {
      const tr = makeT(props)
      const alive = React.useRef(true)
      React.useEffect(function () {
        alive.current = true
        return function () {
          alive.current = false
        }
      }, [])

      const [state, setState] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [form, setForm] = React.useState(emptyForm)
      const [token, setToken] = React.useState('')
      const [hasToken, setHasToken] = React.useState(false)
      const [preview, setPreview] = React.useState(null)
      const [selection, setSelection] = React.useState({})
      const [modes, setModes] = React.useState({})
      const [openMap, setOpenMap] = React.useState({})
      const [activeDevice, setActiveDevice] = React.useState('')
      const [confirmApply, setConfirmApply] = React.useState(false)
      const [confirmSnap, setConfirmSnap] = React.useState('')
      const [applyResult, setApplyResult] = React.useState(null)
      // 差异预览（只读）与回滚两步确认：错误各自独立，任一步失败都停在当前步骤。
      const [diffResult, setDiffResult] = React.useState(null)
      const [diffError, setDiffError] = React.useState(null)
      const [openDiffs, setOpenDiffs] = React.useState({})
      const [rollbackStep, setRollbackStep] = React.useState('')
      const [rollbackTarget, setRollbackTarget] = React.useState('')
      const [rollbackPlan, setRollbackPlan] = React.useState(null)
      const [rollbackError, setRollbackError] = React.useState(null)
      // 回滚第 2 步的 hunk 展开状态（M4）：与差异卡片的 openDiffs 分开，互不影响。
      const [rollbackOpen, setRollbackOpen] = React.useState({})
      const initialized = React.useRef(false)

      React.useEffect(function () {
        let stopped = false
        function done(result) {
          if (stopped || !alive.current) return
          setLoading(false)
          if (!result || !result.ok) {
            setError(localizeError(tr, result ? result.error : { code: 'E_NETWORK' }))
            return
          }
          adoptState(result.data)
        }
        Promise.resolve(rpcCall('getState', {})).then(done, function () {
          done({ ok: false, error: { code: 'E_NETWORK' } })
        })
        return function () {
          stopped = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      function adoptState(data) {
        const next = data && typeof data === 'object' ? data : {}
        setState(next)
        if (!initialized.current) {
          initialized.current = true
          const settings = next.settings && typeof next.settings === 'object' ? next.settings : {}
          setForm(normalizeSettings(settings))
          setHasToken(Boolean(settings.hasToken))
        }
      }

      async function reloadState(options) {
        const silent = Boolean(options && options.silent)
        if (!silent) setLoading(true)
        const result = await rpcCall('getState', {})
        if (!alive.current) return
        if (!silent) setLoading(false)
        if (!result.ok) {
          setError(localizeError(tr, result.error))
          return
        }
        adoptState(result.data)
      }

      /** Dedicated snapshot listing (`listSnapshots`), used by the snapshot card refresh. */
      async function refreshSnapshots() {
        const result = await rpcCall('listSnapshots', {})
        if (!alive.current) return false
        if (!result.ok) {
          setError(localizeError(tr, result.error))
          return false
        }
        const data = result.data && typeof result.data === 'object' ? result.data : {}
        const list = Array.isArray(data.snapshots) ? data.snapshots : []
        setState(function (prev) {
          return Object.assign({}, prev || {}, { snapshots: list })
        })
        return true
      }

      async function runTask(key, task) {
        if (busy) return
        setBusy(key)
        setError(null)
        try {
          await task()
        } catch (e) {
          if (alive.current) setError({ code: 'E_UNKNOWN', message: (e && e.message) || tr('error.unknown') })
        } finally {
          if (alive.current) setBusy('')
        }
      }

      function setField(key, value) {
        setForm(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = value
          return next
        })
      }

      function setScopeField(key, value) {
        setForm(function (prev) {
          const scope = Object.assign({}, prev.scope)
          scope[key] = Boolean(value)
          return Object.assign({}, prev, { scope: scope })
        })
      }

      function doSave() {
        const next = normalizeSettings(form)
        const previousPlatform = next.platform
        const inferred = inferPlatform(next.repoUrl, next.platform)
        if (inferred !== next.platform) {
          next.platform = inferred
          setField('platform', inferred)
        }
        // Gitee 的 HTTPS 认证是「登录名 + 私人令牌作密码」，不能沿用 GitHub 的 x-access-token。
        if (next.authMode === 'https' && next.platform === 'gitee' && next.username.trim() === '') {
          setNotice('')
          setError({ code: 'E_VALIDATION', message: tr('error.giteeUsername') })
          return
        }
        runTask('save', async function () {
          const result = await rpcCall('saveSettings', { settings: next, token: token })
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          const data = result.data && typeof result.data === 'object' ? result.data : {}
          if (data.settings) setForm(normalizeSettings(data.settings))
          setHasToken(data.hasToken === undefined ? Boolean(data.settings && data.settings.hasToken) : Boolean(data.hasToken))
          setToken('')
          const inferredNotice =
            inferred !== previousPlatform
              ? ' ' + tr('notice.platformInferred', { platform: tr('platform.' + inferred) })
              : ''
          setNotice(tr('notice.saved') + inferredNotice)
          await reloadState({ silent: true })
        })
      }

      function doTest() {
        runTask('test', async function () {
          const result = await rpcCall('testConnection', {})
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          const data = result.data && typeof result.data === 'object' ? result.data : {}
          setNotice(
            tr('notice.testOk', {
              branch: asText(data.branch) || '—',
              sha: shortSha(data.headSha),
              message: asText(data.message)
            })
          )
          await reloadState({ silent: true })
        })
      }

      function doPush() {
        runTask('push', async function () {
          const result = await rpcCall('push', {})
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          const data = result.data && typeof result.data === 'object' ? result.data : {}
          setNotice(
            tr('notice.pushed', {
              branch: asText(data.branch) || '—',
              commit: shortSha(data.commit),
              files: Array.isArray(data.files) ? data.files.length : 0
            })
          )
          // Remote head may have moved: any previous preview is stale now.
          clearPreview()
          await reloadState({ silent: true })
        })
      }

      function doPreview() {
        runTask('preview', async function () {
          const result = await rpcCall('preview', {})
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          const data = result.data && typeof result.data === 'object' ? result.data : {}
          const sources = Array.isArray(data.sources) ? data.sources : []
          setPreview({ previewId: data.previewId, sources: sources })
          setSelection(buildSelection(sources))
          setModes({})
          setOpenMap({})
          setApplyResult(null)
          setConfirmApply(false)
          setActiveDevice(sources.length ? String(sources[0].deviceId || '') : '')
          setNotice(sources.length ? tr('notice.previewReady', { count: countEntries(sources) }) : tr('preview.empty'))
        })
      }

      function clearPreview() {
        setPreview(null)
        setSelection({})
        setModes({})
        setOpenMap({})
        setActiveDevice('')
        setConfirmApply(false)
      }

      function doApply() {
        if (!preview || !preview.previewId || !activeSource) return
        const ids = activeIds.slice()
        if (!ids.length) return
        setConfirmApply(false)
        runTask('apply', async function () {
          const result = await rpcCall('apply', {
            confirm: true,
            previewId: preview.previewId,
            sourceDevice: String(activeSource.deviceId || ''),
            entries: ids
          })
          if (!alive.current) return
          if (!result.ok) {
            const localized = localizeError(tr, result.error)
            const code = String((result.error && result.error.code) || '')
            if (code === 'E_NOT_FOUND' || code === 'E_VALIDATION' || code === 'E_CONFIRM_REQUIRED') {
              localized.hint = tr('preview.expired')
            }
            setError(localized)
            return
          }
          const data = result.data && typeof result.data === 'object' ? result.data : {}
          setApplyResult(data)
          setNotice(tr('notice.applied', { n: Array.isArray(data.applied) ? data.applied.length : 0 }))
          // A preview can only be applied once; force a fresh preview afterwards.
          clearPreview()
          await refreshSnapshots()
          await reloadState({ silent: true })
        })
      }

      function doRollback(snapshotId) {
        const id = String(snapshotId || '')
        if (!id) return
        setConfirmSnap('')
        runTask('rollback', async function () {
          const result = await rpcCall('rollback', { snapshotId: id, confirm: true })
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          setApplyResult(null)
          setNotice(tr('notice.rolledBack', { id: id }))
          clearPreview()
          await refreshSnapshots()
          await reloadState({ silent: true })
        })
      }

      /* ---- 差异预览：只读，失败只影响本卡片 ---------------------------- */

      function doDiff() {
        runTask('diff', async function () {
          setDiffError(null)
          const result = await rpcCall('previewDiff', {})
          if (!alive.current) return
          if (!result.ok) {
            setDiffResult(null)
            setDiffError(localizeError(tr, result.error))
            return
          }
          setDiffResult(result.data && typeof result.data === 'object' ? result.data : {})
          setOpenDiffs({})
        })
      }

      function toggleDiff(path) {
        const key = String(path || '')
        if (!key) return
        setOpenDiffs(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = !prev[key]
          return next
        })
      }

      /* ---- 回滚两步确认：第 1 步只读预览，第 2 步才写 -------------------- */

      function startRollback() {
        setRollbackError(null)
        setRollbackPlan(null)
        setRollbackOpen({})
        const latest = snapshots.length ? snapshots[0] : null
        const id = latest ? asText(latest.id) : ''
        if (!id) {
          setRollbackStep('')
          setRollbackTarget('')
          setNotice(tr('rollback.empty'))
          return
        }
        setRollbackTarget(id)
        setRollbackStep('pick')
      }

      function cancelRollback() {
        setRollbackStep('')
        setRollbackTarget('')
        setRollbackPlan(null)
        setRollbackError(null)
        setRollbackOpen({})
      }

      function backRollback() {
        if (busy) return
        setRollbackStep('pick')
        setRollbackPlan(null)
        setRollbackError(null)
        setRollbackOpen({})
      }

      /** 回滚预览里展开/收起某文件的 hunk（默认收起，用户显式点开才渲染正文）。 */
      function toggleRollbackHunk(path) {
        const key = String(path || '')
        if (!key) return
        setRollbackOpen(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = !prev[key]
          return next
        })
      }

      function doRollbackPreview() {
        const id = rollbackTarget
        if (!id) return
        runTask('rollbackPreview', async function () {
          setRollbackError(null)
          const result = await rpcCall('rollbackPreview', { snapshotId: id })
          if (!alive.current) return
          if (!result.ok) {
            // 停在「第 1 步」：不展示未经验证的预览，也不写任何文件。
            setRollbackPlan(null)
            setRollbackError(localizeError(tr, result.error))
            return
          }
          setRollbackPlan(result.data && typeof result.data === 'object' ? result.data : {})
          setRollbackOpen({})
          setRollbackStep('preview')
        })
      }

      function doRollbackConfirm() {
        const id = rollbackTarget
        if (!id || !rollbackPlan) return
        runTask('rollback', async function () {
          setRollbackError(null)
          const result = await rpcCall('rollback', { snapshotId: id, confirm: true })
          if (!alive.current) return
          if (!result.ok) {
            // 停在「第 2 步」：服务端 fail-closed（confirm 门禁 / sha 校验），这里只报错不重试。
            const localized = localizeError(tr, result.error)
            localized.hint = tr('rollback.previewFailed')
            setRollbackError(localized)
            return
          }
          const doneId = id
          cancelRollback()
          setApplyResult(null)
          setNotice(tr('notice.rolledBack', { id: doneId }))
          clearPreview()
          await refreshSnapshots()
          await reloadState({ silent: true })
        })
      }

      function toggleEntry(deviceId, id, checked) {
        const key = entryKey(deviceId, id)
        setSelection(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = Boolean(checked)
          return next
        })
      }

      function setEntryMode(deviceId, id, mode) {
        const key = entryKey(deviceId, id)
        const keep = mode === 'local'
        setModes(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = keep ? 'local' : 'remote'
          return next
        })
        setSelection(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = keep ? false : true
          return next
        })
      }

      function toggleOpen(key) {
        setOpenMap(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = !prev[key]
          return next
        })
      }

      function selectAllForActiveSource() {
        if (!activeSource) return
        const entries = Array.isArray(activeSource.entries) ? activeSource.entries : []
        const next = Object.assign({}, selection)
        const nextModes = Object.assign({}, modes)
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i] || {}
          if (entryStatus(entry) === 'same') continue
          const key = entryKey(activeSource.deviceId, entry.id)
          next[key] = true
          nextModes[key] = 'remote'
        }
        setSelection(next)
        setModes(nextModes)
      }

      function clearAllForActiveSource() {
        if (!activeSource) return
        const entries = Array.isArray(activeSource.entries) ? activeSource.entries : []
        const next = Object.assign({}, selection)
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i] || {}
          next[entryKey(activeSource.deviceId, entry.id)] = false
        }
        setSelection(next)
      }

      // Derived values -------------------------------------------------
      const status = (state && state.status) || {}
      const settings = (state && state.settings) || {}
      const snapshots = Array.isArray(state && state.snapshots) ? state.snapshots : []
      const sources = preview && Array.isArray(preview.sources) ? preview.sources : []
      const activeSource = findSource(sources, activeDevice)
      const activeIds = activeSource ? collectSelected(activeSource, selection) : []
      const canApply = Boolean(preview && preview.previewId && activeSource && activeIds.length > 0 && !busy)
      const applyHint = !preview || !preview.previewId ? tr('actions.apply.hint') : activeIds.length ? '' : tr('preview.noneSelected')
      const anyBusy = Boolean(busy)

      const children = []

      children.push(
        h(
          'div',
          { key: 'head', style: S.head },
          h(
            'div',
            { style: S.headText },
            h('h2', { style: S.title }, tr('title')),
            h('p', { style: S.desc }, tr('subtitle'))
          ),
          typeof props.close === 'function'
            ? h(Btn, { key: 'close', label: tr('common.close'), onClick: props.close })
            : null
        )
      )

      if (error) {
        children.push(
          h(ErrorBox, {
            key: 'error',
            error: error,
            title: tr('error.title'),
            retryLabel: tr('error.retry'),
            dismissLabel: tr('error.dismiss'),
            onRetry: function () {
              setError(null)
              reloadState({})
            },
            onDismiss: function () {
              setError(null)
            }
          })
        )
      }

      if (notice) {
        children.push(
          h(
            'div',
            { key: 'notice', style: S.row },
            h('div', { style: Object.assign({}, S.notice, { flex: '1 1 auto' }) }, notice),
            h(
              'button',
              {
                type: 'button',
                style: S.linkBtn,
                onClick: function () {
                  setNotice('')
                }
              },
              tr('error.dismiss')
            )
          )
        )
      }

      if (loading && !state) {
        children.push(h('div', { key: 'loading', style: S.hint }, tr('busy.loading')))
      }

      // 1) Repository form --------------------------------------------
      children.push(
        h(
          Card,
          { key: 'repo', title: tr('repo.title') },
          h(
            'div',
            { style: S.grid2 },
            h(
              Field,
              { label: tr('repo.platform'), hint: tr('repo.platform.hint') },
              h(Select, {
                value: form.platform,
                disabled: anyBusy,
                options: [
                  { value: 'github', label: tr('platform.github') },
                  { value: 'gitee', label: tr('platform.gitee') },
                  { value: 'custom', label: tr('platform.custom') }
                ],
                onChange: function (value) {
                  setField('platform', value)
                }
              })
            ),
            h(
              Field,
              { label: tr('repo.auth') },
              h(Select, {
                value: form.authMode,
                disabled: anyBusy,
                options: [
                  { value: 'https', label: tr('auth.https') },
                  { value: 'ssh', label: tr('auth.ssh') }
                ],
                onChange: function (value) {
                  setField('authMode', value)
                }
              })
            ),
            form.authMode === 'https'
              ? h(
                  Field,
                  { label: tr('repo.username'), hint: usernameHint(tr, form.platform) },
                  h(Input, {
                    value: form.username,
                    placeholder: form.platform === 'gitee' ? 'your-gitee-login' : 'x-access-token',
                    disabled: anyBusy,
                    onChange: function (value) {
                      setField('username', value)
                    }
                  })
                )
              : null,
            h(
              Field,
              { label: tr('repo.url'), hint: urlHint(tr, form.platform) },
              h(Input, {
                value: form.repoUrl,
                placeholder: urlPlaceholder(form.platform),
                disabled: anyBusy,
                onChange: function (value) {
                  setField('repoUrl', value)
                }
              })
            ),
            h(
              Field,
              { label: tr('repo.device'), hint: tr('repo.device.hint') },
              h(Input, {
                value: form.deviceId,
                placeholder: 'pc-a',
                disabled: anyBusy,
                onChange: function (value) {
                  setField('deviceId', value)
                }
              })
            ),
            h(
              Field,
              { label: tr('repo.branch'), hint: tr('repo.branch.hint') },
              h(Input, {
                value: form.branch,
                placeholder: 'main',
                disabled: anyBusy,
                onChange: function (value) {
                  setField('branch', value)
                }
              })
            ),
            h(
              Field,
              { label: tr('repo.token'), hint: hasToken ? tr('repo.token.set') : tr('repo.token.unset') },
              h(Input, {
                type: 'password',
                value: token,
                placeholder: tr('repo.token.hint'),
                autoComplete: 'new-password',
                disabled: anyBusy,
                onChange: function (value) {
                  setToken(value)
                }
              })
            )
          ),
          h(
            'div',
            { style: S.row },
            h(Btn, {
              label: busy === 'save' ? tr('busy.saving') : tr('repo.save'),
              primary: true,
              disabled: anyBusy,
              onClick: doSave
            })
          )
        )
      )

      // 2) Sync scope --------------------------------------------------
      children.push(
        h(
          Card,
          { key: 'scope', title: tr('scope.title') },
          h('p', { style: S.hint }, tr('scope.hint')),
          h(
            'div',
            { style: S.grid2 },
            h(CheckRow, {
              label: tr('scope.config'),
              desc: tr('scope.config.desc'),
              checked: Boolean(form.scope.config),
              disabled: anyBusy,
              onChange: function (checked) {
                setScopeField('config', checked)
              }
            }),
            h(CheckRow, {
              label: tr('scope.providers'),
              desc: tr('scope.providers.desc'),
              checked: Boolean(form.scope.providers),
              disabled: anyBusy,
              onChange: function (checked) {
                setScopeField('providers', checked)
              }
            }),
            h(CheckRow, {
              label: tr('scope.plugins'),
              desc: tr('scope.plugins.desc'),
              checked: Boolean(form.scope.plugins),
              disabled: anyBusy,
              onChange: function (checked) {
                setScopeField('plugins', checked)
              }
            }),
            h(CheckRow, {
              label: tr('scope.mcp'),
              desc: tr('scope.mcp.desc'),
              checked: Boolean(form.scope.mcp),
              disabled: anyBusy,
              onChange: function (checked) {
                setScopeField('mcp', checked)
              }
            })
          )
        )
      )

      // 3) Status ------------------------------------------------------
      const statusErrorText =
        status.error === undefined || status.error === null || status.error === ''
          ? ''
          : typeof status.error === 'string'
            ? status.error
            : JSON.stringify(status.error)
      const conflict = Boolean(status.conflict)
      // reachable 是三态：true/false/null（null = 从未探测，不得显示成红色错误）。
      const reachable = status.reachable === true ? true : status.reachable === false ? false : null
      const reachableLabel =
        reachable === true ? tr('status.reachable') : reachable === false ? tr('status.unreachable') : tr('status.unprobed')
      children.push(
        h(
          Card,
          {
            key: 'status',
            title: tr('status.title'),
            right: h(Btn, {
              label: anyBusy ? tr('busy.loading') : tr('status.refresh'),
              disabled: anyBusy,
              onClick: function () {
                setNotice('')
                reloadState({})
              }
            })
          },
          h(
            'div',
            { style: S.chipRow },
            h(Badge, {
              text: reachableLabel,
              tone: reachable === true ? 'ok' : reachable === false ? 'err' : 'mute'
            }),
            h(Badge, {
              text: tr('status.branch') + ': ' + (asText(status.branch) || form.branch || '—'),
              tone: 'info'
            }),
            h(Badge, {
              text: tr('status.local') + ': ' + numOrDash(status.localPending),
              tone: Number(status.localPending) > 0 ? 'info' : 'mute'
            }),
            h(Badge, {
              text: tr('status.remote') + ': ' + (status.headSha ? shortSha(status.headSha) : '—'),
              tone: status.headSha ? 'info' : 'mute'
            }),
            h(Badge, {
              text: tr('status.ahead') + ': ' + numOrDash(status.localPending),
              tone: Number(status.localPending) > 0 ? 'warn' : 'mute'
            }),
            h(Badge, {
              text: tr('status.behind') + ': ' + numOrDash(status.remotePending),
              tone: Number(status.remotePending) > 0 ? 'warn' : 'mute'
            }),
            h(Badge, {
              text: tr('status.conflict') + ': ' + (conflict ? tr('status.conflict.yes') : tr('status.conflict.no')),
              tone: conflict ? 'err' : 'mute'
            })
          ),
          h(
            'div',
            { style: S.metaRow },
            h('span', { style: S.metaLabel }, tr('status.head')),
            h(
              'span',
              { style: S.metaValue, title: asText(status.headSha) },
              status.headSha
                ? shortSha(status.headSha) + ' · ' + asText(status.headMessage) + ' · ' + fmtTime(status.headTime)
                : tr('status.headNone')
            )
          ),
          h(
            'div',
            { style: S.metaRow },
            h('span', { style: S.metaLabel }, tr('status.lastSync')),
            h('span', { style: S.metaValue }, status.lastSyncAt ? fmtTime(status.lastSyncAt) : tr('status.never'))
          ),
          statusErrorText
            ? h(
                'div',
                { style: Object.assign({}, S.metaRow, { color: 'var(--dsw-alias-state-error-primary, #c62828)' }) },
                h('span', { style: S.metaLabel }, tr('status.error')),
                h('span', { style: S.metaValue }, statusErrorText)
              )
            : null
        )
      )

      // 4) Actions -----------------------------------------------------
      children.push(
        h(
          Card,
          { key: 'actions', title: tr('actions.title'), right: h(Badge, { text: asText(settings.deviceId) || form.deviceId || '—', tone: 'mute' }) },
          h(
            'div',
            { style: S.row },
            h(Btn, {
              label: busy === 'test' ? tr('busy.testing') : tr('actions.test'),
              disabled: anyBusy,
              onClick: doTest
            }),
            h(Btn, {
              label: busy === 'push' ? tr('busy.pushing') : tr('actions.push'),
              disabled: anyBusy,
              onClick: doPush
            }),
            h(Btn, {
              label: busy === 'preview' ? tr('busy.previewing') : tr('actions.preview'),
              disabled: anyBusy,
              onClick: doPreview
            }),
            h(Btn, {
              label: busy === 'diff' ? tr('busy.diffing') : tr('actions.diff'),
              disabled: anyBusy,
              title: tr('diff.hint'),
              onClick: doDiff
            }),
            h(Btn, {
              label: tr('actions.rollbackLatest'),
              disabled: anyBusy || !snapshots.length,
              title: snapshots.length ? tr('rollback.hint') : tr('rollback.empty'),
              onClick: startRollback
            }),
            h(Btn, {
              label: busy === 'apply' ? tr('busy.applying') : tr('actions.apply'),
              primary: true,
              disabled: anyBusy || !canApply,
              title: applyHint || tr('actions.apply'),
              onClick: function () {
                setConfirmApply(true)
              }
            }),
            h(Btn, {
              label: tr('actions.refresh'),
              disabled: anyBusy,
              onClick: function () {
                setNotice('')
                reloadState({})
              }
            })
          ),
          h('p', { style: S.hint }, applyHint || tr('preview.selected', { n: activeIds.length })),
          confirmApply && activeSource
            ? h(
                'div',
                { style: S.confirmBar },
                h(
                  'div',
                  { style: S.confirmText },
                  tr('confirm.apply', { device: asText(activeSource.deviceId) || '—', n: activeIds.length })
                ),
                h(Btn, {
                  label: tr('confirm.yes'),
                  primary: true,
                  danger: true,
                  disabled: anyBusy,
                  onClick: doApply
                }),
                h(Btn, {
                  label: tr('confirm.cancel'),
                  disabled: anyBusy,
                  onClick: function () {
                    setConfirmApply(false)
                  }
                })
              )
            : null
        )
      )

      // 5) Preview -----------------------------------------------------
      const previewBody = []
      if (!preview || !sources.length) {
        previewBody.push(h('p', { key: 'p-empty', style: S.hint }, tr('preview.empty')))
      } else {
        previewBody.push(h('p', { key: 'p-hint', style: S.hint }, tr('preview.hint')))
        previewBody.push(
          h(
            'div',
            { key: 'p-actions', style: S.row },
            h(Btn, {
              label: tr('preview.selectAll'),
              disabled: anyBusy || !activeSource,
              onClick: selectAllForActiveSource
            }),
            h(Btn, {
              label: tr('preview.clearAll'),
              disabled: anyBusy || !activeSource,
              onClick: clearAllForActiveSource
            }),
            h(Badge, { text: tr('preview.selected', { n: activeIds.length }), tone: activeIds.length ? 'ok' : 'mute' }),
            h(Badge, { text: tr('preview.source') + ': ' + (activeDevice || '—'), tone: 'info' })
          )
        )
        sources.forEach(function (src, si) {
          const source = src && typeof src === 'object' ? src : {}
          const deviceId = asText(source.deviceId)
          const entries = Array.isArray(source.entries) ? source.entries : []
          const files = Array.isArray(source.files) ? source.files : []
          const isActive = deviceId === activeDevice
          const header = h(
            'div',
            { style: S.sourceHead },
            h(
              'label',
              { style: S.radioWrap },
              h('input', {
                type: 'radio',
                name: 'dsh-dots-source',
                checked: isActive,
                disabled: anyBusy,
                onChange: function () {
                  setActiveDevice(deviceId)
                  setConfirmApply(false)
                },
                style: S.radio
              }),
              h('span', { style: S.sourceName }, deviceId || '—')
            ),
            h(Badge, { text: tr('preview.head') + ' ' + shortSha(source.headSha), tone: 'info' }),
            h(Badge, { text: tr('preview.entries') + ' ' + entries.length, tone: 'mute' }),
            h(Badge, { text: tr('preview.files') + ' ' + files.length, tone: 'mute' }),
            h('span', { style: S.grow }),
            isActive ? h(Badge, { text: tr('preview.sourceActive'), tone: 'ok' }) : null
          )
          const entryRows = entries.map(function (entry, ei) {
            const e = entry && typeof entry === 'object' ? entry : {}
            const key = entryKey(deviceId, e.id)
            return h(EntryRow, {
              key: key + ':' + ei,
              t: tr,
              entry: e,
              checked: Boolean(selection[key]),
              mode: modes[key] === 'local' ? 'local' : 'remote',
              open: Boolean(openMap[key]),
              disabled: anyBusy,
              onToggle: function (checked) {
                toggleEntry(deviceId, e.id, checked)
              },
              onMode: function (mode) {
                setEntryMode(deviceId, e.id, mode)
              },
              onExpand: function () {
                toggleOpen(key)
              }
            })
          })
          previewBody.push(
            h(
              'div',
              { key: 'src-' + si, style: Object.assign({}, S.source, isActive ? S.sourceActive : null) },
              header,
              files.length
                ? h(
                    'div',
                    { style: S.chipRow },
                    files.map(function (file, fi) {
                      const f = file && typeof file === 'object' ? file : {}
                      return h(
                        'span',
                        { key: 'f' + fi, style: S.chip, title: asText(f.sha256) },
                        asText(f.name) + ' · ' + fmtBytes(f.bytes)
                      )
                    })
                  )
                : null,
              entries.length ? h('div', { style: S.entries }, entryRows) : h('div', { style: S.hint }, tr('common.none')),
              h(PluginBlock, { key: 'plugins', plugins: source.plugins, t: tr }),
              h(DiffList, { key: 'providers', title: tr('providers.title'), data: source.providers, t: tr }),
              h(DiffList, { key: 'mcp', title: tr('mcp.title'), data: source.mcp, t: tr })
            )
          )
        })
      }
      children.push(
        h(
          Card,
          {
            key: 'preview',
            title: tr('preview.title'),
            right: h(Btn, {
              label: busy === 'preview' ? tr('busy.previewing') : tr('actions.preview'),
              disabled: anyBusy,
              onClick: doPreview
            })
          },
          previewBody
        )
      )

      // 5.5) 差异预览（只读） -------------------------------------------
      const diffBody = []
      if (diffError) {
        diffBody.push(
          h(ErrorBox, {
            key: 'diff-error',
            error: diffError,
            title: tr('diff.failed'),
            dismissLabel: tr('error.dismiss'),
            onDismiss: function () {
              setDiffError(null)
            }
          })
        )
      }
      if (!diffResult) {
        diffBody.push(h('p', { key: 'diff-hint', style: S.hint }, tr('diff.emptyHint')))
      } else {
        const diffSummary = diffResult.summary && typeof diffResult.summary === 'object' ? diffResult.summary : null
        const diffFiles = diffSummary && Array.isArray(diffSummary.files) ? diffSummary.files : []
        const diffHunks = Array.isArray(diffResult.hunks) ? diffResult.hunks : []
        diffBody.push(
          h(
            'div',
            { key: 'diff-meta', style: S.chipRow },
            h(Badge, {
              text: summarizeFileDiff(tr, diffSummary),
              tone: diffTotals(diffSummary).changed > 0 ? 'info' : 'mute'
            }),
            h(Badge, {
              text:
                diffResult.local === false
                  ? tr('diff.source.remote', { device: asText(diffResult.sourceDevice) || '—' })
                  : tr('diff.source.local'),
              tone: 'mute'
            })
          )
        )
        diffBody.push(
          h(FileDiffList, {
            key: 'diff-files',
            t: tr,
            files: diffFiles,
            hunks: diffHunks,
            truncated: diffResult.truncated === true,
            openMap: openDiffs,
            onToggle: toggleDiff
          })
        )
      }
      children.push(
        h(
          Card,
          {
            key: 'diff',
            title: tr('diff.title'),
            right: h(Btn, {
              label: busy === 'diff' ? tr('busy.diffing') : tr('actions.diff'),
              disabled: anyBusy,
              onClick: doDiff
            })
          },
          h('p', { key: 'diff-readonly', style: S.hint }, tr('diff.hint')),
          diffBody
        )
      )

      // 6) Snapshots ---------------------------------------------------
      const snapshotRows = snapshots.map(function (snapshot, si) {
        const sn = snapshot && typeof snapshot === 'object' ? snapshot : {}
        const id = asText(sn.id)
        const confirming = confirmSnap === id && id !== ''
        return h(
          'div',
          { key: 'snap-' + si, style: S.snapRow },
          h(
            'div',
            { style: S.snapMain },
            h('span', { style: S.snapId, title: id }, id || '—'),
            h('span', { style: S.snapMeta }, asText(sn.reason) || '—'),
            h('span', { style: S.snapMeta }, fmtTime(sn.time)),
            h('span', { style: S.snapMeta }, fmtBytes(sn.bytes))
          ),
          confirming
            ? h(
                'div',
                { style: S.confirmInline },
                h('div', { style: S.confirmText }, tr('snapshots.confirm', { id: id })),
                h(Btn, {
                  label: busy === 'rollback' ? tr('busy.rollingBack') : tr('snapshots.confirmYes'),
                  primary: true,
                  danger: true,
                  disabled: anyBusy,
                  onClick: function () {
                    doRollback(id)
                  }
                }),
                h(Btn, {
                  label: tr('snapshots.cancel'),
                  disabled: anyBusy,
                  onClick: function () {
                    setConfirmSnap('')
                  }
                })
              )
            : h(Btn, {
                label: tr('snapshots.rollback'),
                disabled: anyBusy || !id,
                onClick: function () {
                  setConfirmSnap(id)
                }
              })
        )
      })
      children.push(
        h(
          Card,
          {
            key: 'snapshots',
            title: tr('snapshots.title'),
            right: h(Btn, {
              label: busy === 'snapshots' ? tr('busy.loading') : tr('snapshots.refresh'),
              disabled: anyBusy,
              onClick: function () {
                setNotice('')
                runTask('snapshots', async function () {
                  await refreshSnapshots()
                })
              }
            })
          },
          snapshotRows.length
            ? h(
                'div',
                { style: S.list },
                h(
                  'div',
                  { style: S.chipRow },
                  h(Badge, { text: tr('snapshots.id'), tone: 'mute' }),
                  h(Badge, { text: tr('snapshots.time'), tone: 'mute' }),
                  h(Badge, { text: tr('snapshots.reason'), tone: 'mute' }),
                  h(Badge, { text: tr('snapshots.bytes'), tone: 'mute' })
                ),
                snapshotRows
              )
            : h('p', { style: S.hint }, tr('snapshots.empty'))
        )
      )

      // 6.5) 回滚两步确认（第 1 步只读预览，第 2 步才写） ----------------
      const rollbackBody = []
      if (!rollbackStep) {
        rollbackBody.push(h('p', { key: 'rb-hint', style: S.hint }, tr('rollback.hint')))
        rollbackBody.push(
          h(
            'div',
            { key: 'rb-start', style: S.row },
            h(Btn, {
              label: tr('actions.rollbackLatest'),
              disabled: anyBusy || !snapshots.length,
              title: snapshots.length ? tr('rollback.hint') : tr('rollback.empty'),
              onClick: startRollback
            })
          )
        )
      } else {
        const target = findSnapshot(snapshots, rollbackTarget)
        const planSummary = rollbackPlan && rollbackPlan.summary && typeof rollbackPlan.summary === 'object' ? rollbackPlan.summary : null
        const planTotals = diffTotals(planSummary)
        const planFiles = Array.isArray(rollbackPlan && rollbackPlan.files) ? rollbackPlan.files : []
        const willRestore = Array.isArray(rollbackPlan && rollbackPlan.willRestore) ? rollbackPlan.willRestore : []
        // M4：第 2 步不再只有计数——hunk 与统计同方向（当前 → 快照），默认收起、可展开。
        const planHunks = Array.isArray(rollbackPlan && rollbackPlan.hunks) ? rollbackPlan.hunks : []

        rollbackBody.push(
          h(
            'div',
            { key: 'rb-step', style: S.chipRow },
            h(Badge, {
              text: rollbackStep === 'preview' ? tr('rollback.step2') : tr('rollback.step1'),
              tone: 'info'
            }),
            h(Badge, { text: tr('rollback.snapshot', { id: rollbackTarget }), tone: 'mute' }),
            target ? h('span', { style: S.snapMeta }, fmtTime(target.time)) : null
          )
        )
        rollbackBody.push(
          h(
            'p',
            { key: 'rb-reason', style: S.hint },
            tr('rollback.reason', {
              reason: (target && asText(target.reason)) || asText(rollbackPlan && rollbackPlan.reason) || '—'
            }) +
              ' · ' +
              tr('rollback.createdAt', {
                time: fmtTime((target && target.time) || asText(rollbackPlan && rollbackPlan.createdAt))
              })
          )
        )

        if (rollbackError) {
          rollbackBody.push(
            h(ErrorBox, {
              key: 'rb-error',
              error: rollbackError,
              title: tr('error.title'),
              dismissLabel: tr('error.dismiss'),
              onDismiss: function () {
                setRollbackError(null)
              }
            })
          )
        }

        if (rollbackStep === 'preview' && rollbackPlan) {
          rollbackBody.push(
            h(
              'div',
              { key: 'rb-summary', style: S.chipRow },
              h(Badge, {
                text:
                  planTotals.changed > 0
                    ? tr('rollback.summary', {
                        changed: planTotals.changed,
                        plus: planTotals.plus,
                        minus: planTotals.minus
                      })
                    : tr('rollback.same'),
                tone: planTotals.changed > 0 ? 'warn' : 'mute'
              })
            )
          )
          rollbackBody.push(
            h(
              'p',
              { key: 'rb-will', style: S.hint },
              tr('rollback.willRestore') + '：' + (willRestore.length ? willRestore.join('、') : tr('rollback.none'))
            )
          )
          rollbackBody.push(
            h(FileDiffList, {
              key: 'rb-files',
              t: tr,
              files: planFiles,
              hunks: planHunks,
              truncated: rollbackPlan.truncated === true,
              openMap: rollbackOpen,
              onToggle: toggleRollbackHunk,
              emptyLabel: tr('rollback.same')
            })
          )
          rollbackBody.push(
            h(
              'div',
              { key: 'rb-actions', style: S.confirmBar },
              h('div', { style: S.confirmText }, tr('rollback.hint')),
              h(Btn, {
                label: busy === 'rollback' ? tr('busy.rollingBack') : tr('rollback.confirm'),
                primary: true,
                danger: true,
                disabled: anyBusy,
                onClick: doRollbackConfirm
              }),
              h(Btn, { label: tr('rollback.back'), disabled: anyBusy, onClick: backRollback }),
              h(Btn, { label: tr('rollback.cancel'), disabled: anyBusy, onClick: cancelRollback })
            )
          )
        } else {
          rollbackBody.push(
            h(
              'div',
              { key: 'rb-actions', style: S.row },
              h(Btn, {
                label: busy === 'rollbackPreview' ? tr('busy.rollbackPreview') : tr('rollback.check'),
                primary: true,
                disabled: anyBusy,
                onClick: doRollbackPreview
              }),
              h(Btn, { label: tr('rollback.cancel'), disabled: anyBusy, onClick: cancelRollback })
            )
          )
        }
      }
      children.push(h(Card, { key: 'rollback', title: tr('rollback.title') }, rollbackBody))

      // 7) Last apply result -------------------------------------------
      if (applyResult && typeof applyResult === 'object') {
        const applied = Array.isArray(applyResult.applied) ? applyResult.applied : []
        const skipped = Array.isArray(applyResult.skipped) ? applyResult.skipped : []
        const rows = []
        applied.forEach(function (item, i) {
          const o = item && typeof item === 'object' ? item : {}
          rows.push(
            h(
              'div',
              { key: 'ar' + i, style: S.listRow },
              h(Badge, { text: tr('apply.applied'), tone: 'ok' }),
              h('span', { style: S.listText }, asText(o.id) || '—'),
              h('span', { style: S.listMeta }, asText(o.path)),
              h(
                'span',
                { style: S.listMeta, title: asText(o.fileSha256) },
                tr('apply.fileSha') + ': ' + (asText(o.fileSha256) ? shortSha(o.fileSha256) : '—')
              ),
              h(
                'span',
                { style: S.listMeta, title: asText(o.blockSha256) },
                tr('apply.blockSha') + ': ' + (asText(o.blockSha256) ? shortSha(o.blockSha256) : '—')
              )
            )
          )
        })
        skipped.forEach(function (item, i) {
          const o = item && typeof item === 'object' ? item : {}
          rows.push(
            h(
              'div',
              { key: 'as' + i, style: S.listRow },
              h(Badge, { text: tr('apply.skipped'), tone: 'warn' }),
              h('span', { style: S.listText }, asText(o.id) || '—'),
              h('span', { style: S.listMeta }, asText(o.reason))
            )
          )
        })
        children.push(
          h(
            Card,
            { key: 'apply-result', title: tr('apply.title') },
            h(
              'div',
              { style: S.chipRow },
              h(Badge, { text: tr('apply.snapshot') + ': ' + (asText(applyResult.snapshotId) || '—'), tone: 'info' }),
              applyResult.verified ? h(Badge, { text: tr('apply.verified'), tone: 'ok' }) : null
            ),
            rows.length ? h('div', { style: S.list }, rows) : h('p', { style: S.hint }, tr('apply.none'))
          )
        )
      }

      return h('div', { style: S.root }, children)
    }

    // ------------------------------------------------------------------
    // 远程访问 section（settings.section，id `dots-remote`）
    //
    // 与「配置同步」是两个**互相独立**的 section：各自的 state / error / busy，
    // 一侧失败只会出现在自己的 ErrorBox 里，绝不把另一侧标红。
    //
    // token 纪律：明文 token 只存在于 `RemoteLink.url`。本组件**不把它写进 DOM**
    // ——连 title / aria 都不放（比"只放 title"更严）：「复制」按钮在点击回调里
    // 才从 state 取 url，二维码只画黑白矩阵。所以渲染结果里永远没有 token 明文。
    // ------------------------------------------------------------------

    const REMOTE_MODES = ['lan', 'tailscale', 'ipv6', 'cloudflare', 'manual', 'uu']
    const REMOTE_FIELDS = ['lanAddress', 'tailscaleHost', 'cloudflareHost', 'ipv6Address', 'manualUrl']

    /** 远程访问专用样式：只用 C 与 --dsw-alias-* 变量，不硬编码颜色（二维码黑白除外）。 */
    const RS = {
      noteRow: { display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap', minWidth: 0 },
      noteText: { fontSize: 11.5, color: C.labelTertiary, lineHeight: 1.5, minWidth: 0, wordBreak: 'break-word' },
      neutral: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 10px',
        borderRadius: 7,
        border: '1px solid ' + C.borderL2,
        background: C.bgBase,
        minWidth: 0
      },
      neutralHead: { fontSize: 11.5, color: C.labelTertiary },
      neutralText: { fontSize: 12, color: C.labelSecondary, lineHeight: 1.5, wordBreak: 'break-word' },
      verdict: { fontSize: 15, fontWeight: 600, lineHeight: 1.5, wordBreak: 'break-word' },
      checkRow: { display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', minWidth: 0 },
      checkBody: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 240px' },
      checkMsg: { fontSize: 12, color: C.labelPrimary, wordBreak: 'break-word' },
      checkHint: { fontSize: 11, color: C.labelTertiary, lineHeight: 1.45, wordBreak: 'break-word' },
      qrWrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        alignItems: 'flex-start',
        padding: 10,
        borderRadius: 8,
        border: '1px solid ' + C.borderL2,
        background: '#ffffff',
        minWidth: 0
      },
      // 二维码块是纯白底，块内文字只能用深色（黑白属于二维码本身，不受主题色约束）。
      qrNote: { fontSize: 11.5, color: '#1f1f1f' },
      steps: { margin: 0, paddingLeft: 18, fontSize: 11.5, color: C.labelSecondary, lineHeight: 1.5 },
      summary: { cursor: 'pointer', fontSize: 11.5, color: C.accent },
      // 「已保存访问令牌（…）」徽章 + 「清除令牌」：中性色，不是警告——令牌存在本身是正常状态。
      tokenSavedRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }
    }

    /** 自检等级 → 现有 tone（ok 绿 / warn 黄 / fail 红 / unknown 灰）。 */
    function remoteLevelTone(level) {
      if (level === 'ok') return 'ok'
      if (level === 'warn') return 'warn'
      if (level === 'fail') return 'err'
      return 'mute'
    }

    function remoteLevelLabel(translate, level) {
      const key = 'remote.probe.' + String(level || 'unknown')
      const out = translate(key)
      if (typeof out === 'string' && out !== '' && out !== key) return out
      return String(level || 'unknown')
    }

    /** 落地状态 → 徽章（unsupported 用中性色，绝不红）。 */
    function remoteAvailabilityBadge(translate, availability) {
      if (availability === 'ready') return { text: translate('remote.availability.ready'), tone: 'ok' }
      if (availability === 'needs-setup') return { text: translate('remote.needsSetup'), tone: 'warn' }
      return { text: translate('remote.unsupported'), tone: 'mute' }
    }

    /** UI 表单值归一：只认契约字段，缺省/越界一律回落到安全默认值（fail-closed）。 */
    function remoteSettingsOf(source) {
      const src = source && typeof source === 'object' ? source : {}
      const s = src.settings && typeof src.settings === 'object' ? src.settings : src
      const rawPort = typeof s.port === 'number' && isFinite(s.port) && s.port >= 0 ? Math.floor(s.port) : 0
      const out = {
        enabled: s.enabled === true,
        mode: REMOTE_MODES.indexOf(s.mode) >= 0 ? s.mode : 'lan',
        port: rawPort > 65535 ? 0 : rawPort
      }
      for (let i = 0; i < REMOTE_FIELDS.length; i++) out[REMOTE_FIELDS[i]] = asText(s[REMOTE_FIELDS[i]])
      // 访问令牌是 secret：表单**永远**从空串开始，绝不把 host 的任何令牌值预填进来
      // （`RemoteSettingsView` 里也根本没有 `token` 这个字段，只有 tokenSet/tokenMasked）。
      out.token = ''
      return out
    }

    /** `remote.fields.<key>` 之外的文案覆盖（令牌字段的 key 用单数 `remote.field.*`，与契约一致）。 */
    const REMOTE_FIELD_TEXT_KEYS = {
      token: { label: 'remote.field.token', hint: 'remote.field.token.hint' }
    }

    /**
     * 字段文案：优先 host 文案，其次**方式专属**本地化 key（`remote.fields.<mode>.<key>`），
     * 再次通用本地化 key（`remote.fields.<key>`），最后回落到 spec 自带 label/placeholder/hint。
     *
     * 为什么要有"方式专属"这一层：`manual` 与 `uu` 刻意共用 `manualUrl` 这个存储槽位
     * （契约 `types.ts` 不新增字段），但两者对用户的叫法完全不同——manual 是「完整地址」，
     * uu 是 UU 界面里复制出来的「对外入口地址」。没有这一层的话，uu 会显示 manual 的文案。
     * 没配专属 key 的方式（lan/ipv6/tailscale/cloudflare）行为与从前完全一致。
     */
    function remoteFieldText(translate, field, kind, mode) {
      const key = String(field && field.key ? field.key : '')
      const suffix = kind === 'placeholder' ? '.placeholder' : ''
      const overrides = REMOTE_FIELD_TEXT_KEYS[key] || {}
      const overrideKey = kind === 'placeholder' ? '' : asText(overrides[kind === 'hint' ? 'hint' : 'label'])
      if (overrideKey !== '') {
        const out = translate(overrideKey)
        if (typeof out === 'string' && out !== '' && out !== overrideKey) return out
      }
      const modeKey = asText(mode) === '' ? '' : 'remote.fields.' + asText(mode) + '.' + key + suffix
      if (modeKey !== '') {
        const scoped = translate(modeKey)
        if (typeof scoped === 'string' && scoped !== '' && scoped !== modeKey) return scoped
      }
      const localKey = 'remote.fields.' + key + suffix
      const out = translate(localKey)
      if (typeof out === 'string' && out !== '' && out !== localKey) return out
      if (kind === 'placeholder') return asText(field && field.placeholder)
      if (kind === 'hint') return asText(field && field.hint)
      return asText(field && field.label)
    }

    /**
     * 「已保存访问令牌（abcd…wxyz）」文案：模板里没有 `{masked}` 时退化成只给打码串，
     * 任何情况下都不会回落成令牌明文（明文在客户端本来也拿不到）。
     */
    function remoteTokenSavedText(translate, masked) {
      const key = 'remote.token.saved'
      const template = translate(key)
      const text = typeof template === 'string' && template !== '' && template !== key ? template : '{masked}'
      return text.split('{masked}').join(masked)
    }

    /** 数字输入（端口）：只收十进制整数，空值 = 0（跟随 DSH 端口）。 */
    function RemoteNumInput(props) {
      return h('input', {
        type: 'number',
        min: 0,
        max: 65535,
        step: 1,
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        disabled: Boolean(props.disabled),
        onChange: function (event) {
          if (typeof props.onChange === 'function') props.onChange(event.target.value)
        },
        style: Object.assign({}, S.input, props.disabled ? S.inputDisabled : null)
      })
    }

    /** 访问方式下拉：`unsupported` 的项禁用，但仍留在列表里，让用户看到它为什么不行。 */
    function RemoteModeSelect(props) {
      const specs = Array.isArray(props.specs) ? props.specs : []
      return h(
        'select',
        {
          value: asText(props.value),
          disabled: Boolean(props.disabled),
          onChange: function (event) {
            if (typeof props.onChange === 'function') props.onChange(event.target.value)
          },
          style: Object.assign({}, S.select, props.disabled ? S.inputDisabled : null)
        },
        specs.map(function (spec) {
          const s = spec && typeof spec === 'object' ? spec : {}
          return h(
            'option',
            { key: asText(s.mode), value: asText(s.mode), disabled: s.availability === 'unsupported' },
            asText(s.label) || asText(s.mode)
          )
        })
      )
    }

    /**
     * 二维码：把 host 给的布尔矩阵直接画成 SVG。
     * 每模块 4px（要求 ≥3px），四周留 4 模块静区，纯白底。
     */
    function QrMatrix(props) {
      const src = props.qr && typeof props.qr === 'object' ? props.qr : {}
      const modules = Array.isArray(src.modules) ? src.modules : []
      const size = typeof src.size === 'number' && src.size > 0 ? Math.floor(src.size) : modules.length
      if (!size || modules.length === 0) return null
      const unit = 4
      const quiet = 4 * unit
      const px = size * unit + quiet * 2
      const cells = []
      for (let y = 0; y < size; y++) {
        const row = Array.isArray(modules[y]) ? modules[y] : []
        for (let x = 0; x < size; x++) {
          if (row[x] !== true) continue
          cells.push(
            h('rect', {
              key: 'm' + x + '_' + y,
              x: quiet + x * unit,
              y: quiet + y * unit,
              width: unit,
              height: unit,
              fill: '#000000'
            })
          )
        }
      }
      return h(
        'svg',
        {
          width: px,
          height: px,
          viewBox: '0 0 ' + px + ' ' + px,
          role: 'img',
          'aria-label': asText(props.label),
          style: { display: 'block', background: '#ffffff' }
        },
        h('rect', { key: 'bg', x: 0, y: 0, width: px, height: px, fill: '#ffffff' }),
        cells
      )
    }

    function RemotePanel(props) {
      const tr = makeT(props)
      const alive = React.useRef(true)
      React.useEffect(function () {
        alive.current = true
        return function () {
          alive.current = false
        }
      }, [])

      // 仅用于测试 / 首帧预置：host 只传 { t, close }，生产路径这两者恒为 null。
      const seedState = props && props.seedState && typeof props.seedState === 'object' ? props.seedState : null
      const seedLink = props && props.seedLink && typeof props.seedLink === 'object' ? props.seedLink : null

      const [state, setState] = React.useState(seedState)
      const [loading, setLoading] = React.useState(seedState === null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [form, setForm] = React.useState(function () {
        return remoteSettingsOf(seedState)
      })
      const [link, setLink] = React.useState(seedLink)
      const [probe, setProbe] = React.useState(seedState && seedState.status ? seedState.status.probe : null)
      const [confirmRotate, setConfirmRotate] = React.useState(false)
      // 令牌输入框是否被用户动过（含「清除令牌」）：
      // 没动过就不把 token 放进保存请求 —— 否则每次保存都会把已存令牌清空。
      const [tokenDirty, setTokenDirty] = React.useState(false)

      React.useEffect(function () {
        if (seedState !== null) return function () {}
        let stopped = false
        function done(result) {
          if (stopped || !alive.current) return
          setLoading(false)
          if (!result || !result.ok) {
            setError(localizeError(tr, result ? result.error : { code: 'E_NETWORK' }))
            return
          }
          adoptState(result.data)
        }
        Promise.resolve(rpcCall('remoteGetState', {})).then(done, function () {
          done({ ok: false, error: { code: 'E_NETWORK' } })
        })
        return function () {
          stopped = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      /** 读取整份状态（getState / saveSettings 的返回体同形）。 */
      function adoptState(data) {
        const next = data && typeof data === 'object' ? data : {}
        setState(next)
        setForm(remoteSettingsOf(next))
        // 保存/刷新后令牌已落盘：输入框回到空串，脏标记清掉（view 里本来就取不到明文）。
        setTokenDirty(false)
        if (next.status && next.status.probe) setProbe(next.status.probe)
      }

      /** 只换状态块（start/stop/rotateToken 返回的是 RemoteStatus），不动表单里未保存的编辑。 */
      function adoptStatus(nextStatus) {
        if (!nextStatus || typeof nextStatus !== 'object') return
        setState(function (prev) {
          return Object.assign({}, prev || {}, { status: nextStatus })
        })
        if (nextStatus.probe) setProbe(nextStatus.probe)
      }

      /** 一个请求在飞时其它按钮全部 disabled（busy 互斥，避免重复提交）。 */
      async function runTask(key, task) {
        if (busy) return
        setBusy(key)
        setError(null)
        setNotice('')
        try {
          await task()
        } catch (e) {
          if (alive.current) setError({ code: 'E_UNKNOWN', message: (e && e.message) || tr('error.unknown') })
        } finally {
          if (alive.current) setBusy('')
        }
      }

      function setFormField(key, value) {
        setForm(function (prev) {
          const next = Object.assign({}, prev)
          next[key] = value
          return next
        })
      }

      function setPortValue(value) {
        const digits = String(value === undefined || value === null ? '' : value).replace(/[^0-9]/g, '')
        const n = digits === '' ? 0 : Number(digits)
        const safe = isFinite(n) && n > 0 ? Math.min(65535, Math.floor(n)) : 0
        setFormField('port', safe)
      }

      /**
       * 「清除令牌」：只把**表单值**置成空串并标记脏，下一次「保存设置」才提交空串
       * （= 归一里的显式清空）。绝不在这里回填任何令牌内容。
       */
      function clearToken() {
        setTokenDirty(true)
        setFormField('token', '')
        setNotice(tr('remote.token.cleared'))
      }

      function doRefresh() {
        runTask('load', async function () {
          const result = await rpcCall('remoteGetState', {})
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          adoptState(result.data)
        })
      }

      function doSave() {
        const next = remoteSettingsOf(form)
        // 用户没动过令牌输入框 → 不提交该键（归一里"缺省"= 沿用 previous，令牌不会被清掉）；
        // 动过（含点了「清除令牌」）→ 提交原值或空串，空串即"清空令牌"。
        if (!tokenDirty) delete next.token
        runTask('save', async function () {
          const result = await rpcCall('remoteSaveSettings', { settings: next })
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          adoptState(result.data)
          setNotice(tr('remote.notice.saved'))
        })
      }

      function doStart() {
        runTask('start', async function () {
          const result = await rpcCall('remoteStart', {})
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          adoptStatus(result.data)
          setNotice(tr('remote.notice.started'))
        })
      }

      function doStop() {
        runTask('stop', async function () {
          const result = await rpcCall('remoteStop', {})
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          adoptStatus(result.data)
          setNotice(tr('remote.notice.stopped'))
        })
      }

      function doRotate() {
        setConfirmRotate(false)
        runTask('rotate', async function () {
          const result = await rpcCall('remoteRotateToken', {})
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          adoptStatus(result.data)
          // 旧链接 / 旧二维码立即失效：把本地展示的链接一并丢掉，避免继续扫码。
          setLink(null)
          setNotice(tr('remote.notice.rotated'))
        })
      }

      function doProbe() {
        runTask('probe', async function () {
          const result = await rpcCall('remoteProbe', { mode: form.mode })
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          const data = result.data && typeof result.data === 'object' ? result.data : null
          if (data) setProbe(data)
          setNotice(tr('remote.notice.probed'))
        })
      }

      function doShowLink() {
        runTask('link', async function () {
          const result = await rpcCall('remoteShowLink', { mode: form.mode })
          if (!alive.current) return
          if (!result.ok) {
            setError(localizeError(tr, result.error))
            return
          }
          const data = result.data && typeof result.data === 'object' ? result.data : null
          if (!data || typeof data.url !== 'string' || data.url === '') {
            setError({ code: 'E_BAD_RESPONSE', message: tr('error.badResponse') })
            return
          }
          setLink(data)
        })
      }

      /**
       * 复制：明文 url（含 token）只在点击回调里取用，绝不进入 DOM / title / aria。
       * 剪贴板不可用时静默失败——不降级成"把地址渲染出来"。
       */
      function doCopyLink() {
        const url = link && typeof link.url === 'string' ? link.url : ''
        if (url === '') return
        try {
          const clip = typeof navigator === 'undefined' ? null : navigator.clipboard
          if (clip && typeof clip.writeText === 'function') {
            const pending = clip.writeText(url)
            if (pending && typeof pending.catch === 'function') pending.catch(function () {})
          }
        } catch (e) {
          /* 静默：宁可复制失败，也不把 token 写进 DOM */
        }
      }

      // Derived values -------------------------------------------------
      const status = state && state.status && typeof state.status === 'object' ? state.status : {}
      const modes = Array.isArray(state && state.modes) ? state.modes : []
      // 设置视图（契约：只有 tokenSet / tokenMasked，**没有** token 明文）。
      const settingsView = state && state.settings && typeof state.settings === 'object' ? state.settings : {}
      const tokenSaved = settingsView.tokenSet === true
      const tokenMasked = asText(settingsView.tokenMasked)
      const running = status.running === true
      const tokenInfo = status.token && typeof status.token === 'object' ? status.token : {}
      const conns = status.connections && typeof status.connections === 'object' ? status.connections : {}
      const lastError = status.lastError && typeof status.lastError === 'object' ? status.lastError : null
      const urls = Array.isArray(status.urls) ? status.urls : []
      // 契约里 status.urls 恒不含 token；万一 host 给了 withToken 的条目，这里也绝不渲染。
      const safeUrls = urls.filter(function (entry) {
        return !(entry && typeof entry === 'object' && entry.withToken === true)
      })
      const activeProbe =
        probe && typeof probe === 'object'
          ? probe
          : status.probe && typeof status.probe === 'object'
            ? status.probe
            : null
      const anyBusy = Boolean(busy)

      let selected = null
      for (let i = 0; i < modes.length; i++) {
        const spec = modes[i] && typeof modes[i] === 'object' ? modes[i] : {}
        if (asText(spec.mode) === form.mode) selected = spec
      }
      if (!selected) {
        // state 还没到（首次加载）或 host 没给该方式：用最小骨架，不假设它可用。
        selected = {
          mode: form.mode,
          label: form.mode,
          description: '',
          availability: '',
          unavailableReason: '',
          requires: [],
          fields: [],
          steps: []
        }
      }
      const selectedBadge = remoteAvailabilityBadge(tr, selected.availability)
      const fields = Array.isArray(selected.fields) ? selected.fields : []
      const requires = Array.isArray(selected.requires) ? selected.requires : []
      const steps = Array.isArray(selected.steps) ? selected.steps : []
      const nonReady = modes.filter(function (spec) {
        return spec && typeof spec === 'object' && spec.availability !== 'ready'
      })

      const children = []

      children.push(
        h(
          'div',
          { key: 'head', style: S.head },
          h(
            'div',
            { style: S.headText },
            h('h2', { style: S.title }, tr('remote.title')),
            h('p', { style: S.desc }, tr('remote.subtitle'))
          ),
          typeof props.close === 'function' ? h(Btn, { key: 'close', label: tr('common.close'), onClick: props.close }) : null
        )
      )

      // 本 section 自己的错误：只出现在这里，绝不外溢到同步 section。
      if (error) {
        children.push(
          h(ErrorBox, {
            key: 'error',
            error: error,
            title: tr('error.title'),
            retryLabel: tr('error.retry'),
            dismissLabel: tr('error.dismiss'),
            onRetry: function () {
              setError(null)
              doRefresh()
            },
            onDismiss: function () {
              setError(null)
            }
          })
        )
      }

      if (notice) {
        children.push(
          h(
            'div',
            { key: 'notice', style: S.row },
            h('div', { style: Object.assign({}, S.notice, { flex: '1 1 auto' }) }, notice),
            h(
              'button',
              {
                type: 'button',
                style: S.linkBtn,
                onClick: function () {
                  setNotice('')
                }
              },
              tr('error.dismiss')
            )
          )
        )
      }

      if (loading && !state) {
        children.push(h('div', { key: 'loading', style: S.hint }, tr('remote.busy.loading')))
      }

      // 1) 设置 --------------------------------------------------------
      children.push(
        h(
          Card,
          { key: 'remote-settings', title: tr('remote.settings.title'), right: h(Badge, selectedBadge) },
          h(CheckRow, {
            label: tr('remote.enable'),
            desc: tr('remote.enable.hint'),
            checked: Boolean(form.enabled),
            disabled: anyBusy,
            onChange: function (checked) {
              setFormField('enabled', Boolean(checked))
            }
          }),
          h(
            'div',
            { style: S.grid2 },
            h(
              Field,
              { label: tr('remote.mode'), hint: tr('remote.mode.hint') },
              h(RemoteModeSelect, {
                specs: modes,
                value: form.mode,
                disabled: anyBusy,
                onChange: function (value) {
                  setFormField('mode', value)
                }
              })
            ),
            h(
              Field,
              { label: tr('remote.port'), hint: tr('remote.port.hint') },
              h(RemoteNumInput, {
                value: form.port,
                disabled: anyBusy,
                onChange: setPortValue
              })
            ),
            fields.map(function (field, fi) {
              const f = field && typeof field === 'object' ? field : {}
              const key = asText(f.key)
              if (key === '' || key === 'port') return null
              if (key === 'token') {
                // 访问令牌：password 输入 + hint +（已保存时）打码徽章与「清除令牌」。
                // value 只来自表单 state（初始恒为空串），DOM 里因此**永远**不出现令牌明文。
                return h(
                  Field,
                  {
                    key: 'rf-' + fi,
                    label: remoteFieldText(tr, f, 'label', selected.mode),
                    hint: remoteFieldText(tr, f, 'hint', selected.mode)
                  },
                  h(Input, {
                    type: 'password',
                    autoComplete: 'new-password',
                    value: asText(form.token),
                    placeholder: remoteFieldText(tr, f, 'placeholder', selected.mode),
                    disabled: anyBusy,
                    onChange: function (value) {
                      setTokenDirty(true)
                      setFormField('token', value)
                    }
                  }),
                  tokenSaved && tokenMasked !== ''
                    ? h(
                        'div',
                        { key: 'token-saved', style: RS.tokenSavedRow },
                        h(Badge, { text: remoteTokenSavedText(tr, tokenMasked), tone: 'mute' }),
                        h(Btn, { label: tr('remote.token.clear'), disabled: anyBusy, onClick: clearToken })
                      )
                    : null
                )
              }
              return h(
                Field,
                {
                  key: 'rf-' + fi,
                  label: remoteFieldText(tr, f, 'label', selected.mode),
                  hint: asText(f.hint)
                },
                h(Input, {
                  value: form[key] === undefined || form[key] === null ? '' : String(form[key]),
                  placeholder: remoteFieldText(tr, f, 'placeholder', selected.mode),
                  disabled: anyBusy,
                  onChange: function (value) {
                    setFormField(key, value)
                  }
                })
              )
            })
          ),
          // 选中方式的说明 / 不可用原因 / 前提 / 步骤
          h(
            'div',
            { style: RS.neutral },
            h(
              'div',
              { style: RS.noteRow },
              h(Badge, selectedBadge),
              h('span', { style: RS.neutralText }, asText(selected.description))
            ),
            asText(selected.unavailableReason)
              ? h(
                  'div',
                  { key: 'reason', style: RS.neutralText },
                  tr('remote.unsupported') + ' · ' + asText(selected.unavailableReason)
                )
              : null,
            requires.length
              ? h('div', { key: 'requires', style: RS.neutralText }, tr('remote.requires') + ' · ' + requires.join('；'))
              : null,
            steps.length
              ? h(
                  'details',
                  { key: 'steps' },
                  h('summary', { style: RS.summary }, tr('remote.steps')),
                  h(
                    'ol',
                    { style: RS.steps },
                    steps.map(function (step, si) {
                      return h('li', { key: 'st' + si }, asText(step))
                    })
                  )
                )
              : null
          ),
          // 所有「不可用 / 需先准备」的方式都列一遍（中性色，不是红）
          nonReady.length
            ? h(
                'div',
                { key: 'non-ready', style: S.list },
                nonReady.map(function (spec, ni) {
                  const sp = spec && typeof spec === 'object' ? spec : {}
                  const badge = remoteAvailabilityBadge(tr, sp.availability)
                  const detail =
                    sp.availability === 'unsupported'
                      ? asText(sp.unavailableReason)
                      : Array.isArray(sp.requires)
                        ? sp.requires.join('；')
                        : ''
                  return h(
                    'div',
                    { key: 'nr' + ni, style: RS.noteRow },
                    h(Badge, badge),
                    h('span', { style: RS.noteText }, asText(sp.label) + (detail ? ' · ' + detail : ''))
                  )
                })
              )
            : null,
          h(
            'div',
            { key: 'save-row', style: S.row },
            h(Btn, {
              label: busy === 'save' ? tr('remote.busy.saving') : tr('remote.actions.save'),
              primary: true,
              disabled: anyBusy,
              onClick: doSave
            }),
            h(Btn, { label: tr('status.refresh'), disabled: anyBusy, onClick: doRefresh })
          )
        )
      )

      // 2) 运行状态 ----------------------------------------------------
      children.push(
        h(
          Card,
          {
            key: 'remote-status',
            title: tr('remote.status.title'),
            right: h(Badge, {
              text: running ? tr('remote.status.running') : tr('remote.status.stopped'),
              tone: running ? 'ok' : 'mute'
            })
          },
          h(
            'div',
            { style: S.chipRow },
            h(Badge, {
              text: tr('remote.status.bound') + ': ' + (asText(status.boundAddress) || tr('common.none')),
              tone: asText(status.boundAddress) ? 'info' : 'mute'
            }),
            h(Badge, {
              text: tr('remote.status.connections') + ': ' + num(conns.active) + '/' + num(conns.total),
              tone: 'mute'
            }),
            h(Badge, {
              text: tr('remote.status.rejected') + ': ' + num(status.rejected),
              tone: num(status.rejected) === '0' ? 'mute' : 'warn'
            }),
            h(Badge, {
              text:
                tr('remote.status.token') +
                ': ' +
                (tokenInfo.exists === true
                  ? asText(tokenInfo.masked)
                  : tokenSaved && tokenMasked !== ''
                    ? tokenMasked
                    : tr('remote.status.token.none')),
              tone: tokenInfo.exists === true || tokenSaved ? 'info' : 'mute'
            })
          ),
          // 这条必须有：让用户明确知道"只绑了具体地址"，不是 0.0.0.0。
          h('p', { style: S.hint }, tr('remote.status.bound.hint')),
          h(
            'div',
            { style: S.metaRow },
            h('span', { style: S.metaLabel }, tr('remote.status.listen')),
            h('span', { style: S.metaValue }, asText(status.listen) || tr('common.none'))
          ),
          h(
            'div',
            { style: S.metaRow },
            h('span', { style: S.metaLabel }, tr('remote.status.startedAt')),
            h('span', { style: S.metaValue }, status.startedAt ? fmtTime(status.startedAt) : tr('common.none'))
          ),
          // 最近错误：中性框（灰），不要红一片——失败信息不该压过"其实还在正常运行"。
          lastError
            ? h(
                'div',
                { key: 'last-error', style: RS.neutral },
                h('div', { style: RS.neutralHead }, tr('remote.status.lastError') + ' · ' + asText(lastError.code)),
                h('div', { style: RS.neutralText }, asText(lastError.message))
              )
            : null,
          h(
            'div',
            { key: 'actions', style: S.row },
            h(Btn, {
              label: busy === 'start' ? tr('remote.busy.starting') : tr('remote.actions.start'),
              primary: true,
              disabled: anyBusy || running,
              onClick: doStart
            }),
            h(Btn, {
              label: busy === 'stop' ? tr('remote.busy.stopping') : tr('remote.actions.stop'),
              disabled: anyBusy || !running,
              onClick: doStop
            }),
            h(Btn, {
              label: busy === 'rotate' ? tr('remote.busy.rotating') : tr('remote.actions.rotate'),
              disabled: anyBusy,
              onClick: function () {
                setConfirmRotate(true)
              }
            }),
            h(Btn, {
              label: busy === 'probe' ? tr('remote.busy.probing') : tr('remote.actions.probe'),
              disabled: anyBusy,
              onClick: doProbe
            }),
            h(Btn, {
              label: busy === 'link' ? tr('remote.busy.linking') : tr('remote.actions.showLink'),
              disabled: anyBusy,
              onClick: doShowLink
            })
          ),
          // 生成新令牌的二次确认（旧链接立即失效）
          confirmRotate
            ? h(
                'div',
                { key: 'confirm-rotate', style: S.confirmBar },
                h('div', { style: S.confirmText }, tr('remote.actions.rotate.confirm')),
                h(Btn, {
                  label: tr('remote.actions.rotate.yes'),
                  primary: true,
                  danger: true,
                  disabled: anyBusy,
                  onClick: doRotate
                }),
                h(Btn, {
                  label: tr('remote.actions.rotate.cancel'),
                  disabled: anyBusy,
                  onClick: function () {
                    setConfirmRotate(false)
                  }
                })
              )
            : null
        )
      )

      // 3) 二维码与链接（只有显式点过「显示二维码与链接」才出现） -------
      if (link) {
        children.push(
          h(
            Card,
            { key: 'remote-qr', title: tr('remote.qr.title') },
            h(
              'div',
              { style: RS.qrWrap },
              h(QrMatrix, { qr: link.qr, label: tr('remote.qr.title') }),
              h('div', { style: RS.qrNote }, tr('remote.qr.hint'))
            ),
            h(
              'div',
              { key: 'qr-actions', style: S.row },
              h(Btn, { label: tr('remote.actions.copy'), onClick: doCopyLink }),
              asText(link.note) ? h('span', { style: S.hint }, asText(link.note)) : null
            ),
            h('p', { key: 'link-hint', style: S.hint }, tr('remote.link.hint')),
            safeUrls.length
              ? h(
                  'div',
                  { key: 'urls', style: S.list },
                  safeUrls.map(function (entry, ui) {
                    const e = entry && typeof entry === 'object' ? entry : {}
                    return h(
                      'div',
                      { key: 'u' + ui, style: S.listRow },
                      h(Badge, { text: asText(e.label) || asText(e.mode), tone: 'mute' }),
                      h('span', { style: S.listText }, asText(e.url)),
                      asText(e.note) ? h('span', { style: S.listMeta }, asText(e.note)) : null
                    )
                  })
                )
              : null
          )
        )
      }

      // 4) 自检结果 ----------------------------------------------------
      children.push(
        h(
          Card,
          { key: 'remote-probe', title: tr('remote.probe.title') },
          activeProbe
            ? h(
                'div',
                { style: S.list },
                h(
                  'div',
                  {
                    key: 'verdict',
                    style: Object.assign({}, RS.verdict, {
                      color: (TONE[remoteLevelTone(activeProbe.level)] || TONE.mute).color
                    })
                  },
                  asText(activeProbe.verdict) || remoteLevelLabel(tr, activeProbe.level)
                ),
                h(
                  'div',
                  { key: 'probe-meta', style: S.row },
                  h(Badge, {
                    text: remoteLevelLabel(tr, activeProbe.level),
                    tone: remoteLevelTone(activeProbe.level)
                  }),
                  h('span', { style: S.hint }, tr('remote.probe.at') + ' ' + fmtTime(activeProbe.at))
                ),
                (Array.isArray(activeProbe.checks) ? activeProbe.checks : []).map(function (check, ci) {
                  const c = check && typeof check === 'object' ? check : {}
                  const tone = remoteLevelTone(c.level)
                  return h(
                    'div',
                    { key: 'chk' + ci, style: RS.checkRow },
                    h(Badge, { text: remoteLevelLabel(tr, c.level), tone: tone }),
                    h(
                      'div',
                      { style: RS.checkBody },
                      h('span', { style: RS.checkMsg }, asText(c.message)),
                      asText(c.hint) ? h('span', { style: RS.checkHint }, asText(c.hint)) : null
                    )
                  )
                })
              )
            : h('p', { style: S.hint }, tr('remote.probe.never'))
        )
      )

      return h('div', { style: S.root }, children)
    }

    // ------------------------------------------------------------------
    // Plugin body
    // ------------------------------------------------------------------
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { en: en, zh: zh })
      })
      try {
        // The Client locale service exposes `bind(ns)` (the LocaleFace); there is no
        // `ctx.locale.t(ns, key)`, so probing `.t` would silently pin the copy to the
        // bundle-time dictionary and ignore runtime language switches.
        if (ctx.locale && typeof ctx.locale.bind === 'function') {
          serviceT = ctx.locale.bind(NS)
        } else if (ctx.locale && typeof ctx.locale.translate === 'function') {
          const service = ctx.locale
          serviceT = function (key) {
            return service.translate(NS, key)
          }
        }
      } catch (e) {
        serviceT = null
      }
      // 第二个 section：远程访问（order 71，与「配置同步」并列且**互相独立**）。
      // 先注册它、再注册同步：host 按 `order` 排序展示，注册先后不影响顺序；
      // 把同步留在最后，既有「最后一个注册的 panel 就是同步面板」的渲染回归不受影响。
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dots-remote',
            order: 71,
            label: function () {
              return t('remote.nav')
            },
            locale: NS
          },
          RemotePanel
        )
      })
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dots',
            order: 70,
            label: function () {
              return t('nav')
            },
            locale: NS
          },
          SettingsPanel
        )
      })
    }

    return { inject: inject, apply: apply }
  }
})
