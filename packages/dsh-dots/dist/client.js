/**
 * dsh-dots — client half (hand-written `__ModuleLoader__` bundle, no build step).
 *
 * Registers exactly ONE settings section (Settings → DSH-dots):
 *   slot `settings.section`, id `dots`, order 70, locale NS `dots`.
 *   The page contains exactly two stacked groups and nothing else (mod-plugin-lean-panel):
 *     「配置同步」: 仓库地址 / 访问令牌 / 一行状态 / 保存
 *     「远程控制」: 访问方式 / 端口 / 访问令牌（生成 + 复制）/ 自检 / 二维码
 *
 * 精简口径（用户定版）：高级控件（同步范围复选框、平台 / 认证方式 / 设备标识 /
 * 分支、预览 / 应用 / 回滚 / 快照、插件清单 MERGE 计划、逐步说明段落）**入口已删除**，
 * 不是藏进开关。引擎能力零删除，这些功能在 UI 层 dormant（清单见 docs/MODULES.md §2）。
 * 状态行只有一条：已同步 · HH:MM / 失败：<原因> / 未配置：缺少<字段> /
 * 已配置（可见性阻断，禁止推送）/ 尚未同步 / 同步中…（沿用 App 语义）。
 * mod-plugin-dormant-panel-removal: 旧 SettingsPanel / RemotePanel 及其专用 helper / 文案已删除；
 *
 * Transport: same-origin POST /dsh-dots/rpc
 *   request  `{ action, ...payload }`
 *   response `{ ok: true, data }` | `{ ok: false, error: { code, message, details? } }`
 *   (HTTP 200; only auth failures use 401/403)
 *
 * Styling: inline styles only, colours exclusively from `--dsw-alias-*` theme variables.
 */
// loader id 必须等于 package.json.name（DSH 以包名作为模块工厂的 key）。
// 它与 settings.section 的唯一 slot id `dots`、locale NS `dots`、
// RPC 路径 `/dsh-dots/rpc` 是互相独立的命名空间，勿一并改名。
// `dots-remote` 现只作为单页内部折叠分组的 id，不再是 settings.section 注册。
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
      // 单一条目的名称 + 单页内两组能力的分组标题（不是两个插件视图）。
      "panel.title": "DSH-dots",
      "group.sync": "配置同步",
      "group.remote": "远程控制",








      "error.network": "网络异常，无法连接 DSH 服务，请确认服务仍在运行。",
      "error.http": "服务返回 HTTP {status}，请查看 DSH 日志。",
      "error.badResponse": "服务返回了无法解析的响应。",
      "error.unauthorized": "未通过 DSH 鉴权（401/403）。",
      "error.unknown": "未知错误。",
      "error.giteeUsername": "Gitee 需要填写用户名（Gitee 登录名）。私人令牌只作密码，不能代替用户名。",










      "remote.nav": "远程访问",
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
      "remote.actions.title": "操作",
      "remote.probe.ok": "通过",
      "remote.probe.warn": "注意",
      "remote.probe.fail": "失败",
      "remote.probe.unknown": "无法自证",

      // mod-plugin-lean-panel：精简面板专用文案（复用 App 的语义与字面，不造第二套说法）。
      "lean.repo.url": "仓库地址",
      "lean.repo.token": "访问令牌",
      // mod-plugin-git-username：登录名只读派生行 + 鉴权失败后才出现的可编辑字段。
      "lean.sync.login": "登录名",
      "lean.sync.login.inferred": "登录名：{name}（由仓库地址推断）",
      "lean.sync.login.required": "Gitee 的私人令牌只能当密码，需要你的登录名；通常就是仓库地址里的 owner",
      "lean.missing.url": "仓库地址",
      "lean.missing.token": "访问令牌",
      "lean.actions.save": "保存",
      "lean.status.synced": "已同步 · {time}",
      "lean.status.syncing": "同步中…",
      "lean.status.failed": "失败：{reason}",
      "lean.status.unconfigured": "未配置：缺少{missing}",
      "lean.status.blocked": "已配置（可见性阻断，禁止推送）",
      "lean.status.never": "尚未同步",
      // mod-plugin-chat-export-auto：常驻静态声明（无按钮、无确认、不可关闭），逐字照设计 §4。
      "lean.chatExport.honesty": "会话正文会像日程一样自动同步到云端仓库，以明文 JSONL 保存并进入 Git 历史，无法抹除。",
      "lean.chatExport.scope": "平板/云端显示的是你在 chat / dots 模式下创建的会话；本机已有的 888 个会话都是 work 模式，因此不会被同步，平板的会话列表在你新建 chat / dots 会话之前本来就是空的。",
      "lean.chatExport.paused": "自动发布暂停：{reason}（已写入的提交保留；本轮不自动重试）",
      "lean.chatExport.partial": "部分发布：{n} 个；本轮超时，剩余 {m} 个下次同步继续",
      "lean.chatExport.skipped": "本轮跳过 {n} 个不完整会话",
      "lean.remote.mode": "访问方式",
      "lean.remote.port": "端口",
      "lean.remote.token": "访问令牌",
      "lean.remote.generate": "重新生成",
      "lean.remote.copy": "复制配对串",
      "lean.remote.selfcheck": "自检",
      "lean.remote.qr": "二维码",
      "lean.remote.mode.unselected": "尚未选择访问方式",
      "lean.remote.probe.never": "尚未自检；点「自检」确认这台机器到底能不能被访问。",
      "lean.mode.lan": "局域网",
      "lean.mode.tailscale": "Tailscale",
      "lean.mode.ipv6": "IPv6",
      // mod-plugin-pairing-client：自动选路 / 显式二维码 / 轮换后果 / 脱敏审计 / 停止接受。
      "lean.remote.mode.hint": "方式（自动选中，可覆盖）",
      "lean.remote.mode.auto": "自动选择（推荐）",
      "lean.remote.transport.selected": "自动选中：{mode}",
      // retarget（mod-plugin-remote-hints-mode-keyed）：只给唯一推荐动作，不再并列多种方式的前提。
      "lean.remote.transport.none": "未检测到可用网络：推荐先登录 Tailscale，让平板加入同一 tailnet。",
      "lean.remote.transport.fallback": "所选方式不可用，已回落到自动选择",
      // mod-plugin-remote-hints-mode-keyed：按方式唯一的提示，只讲本方式自己的前提。
      "lean.remote.hint.auto": "自动选路已开启：按当前可用网络选择传输方式。",
      "lean.remote.hint.tailscale": "两端加入同一 tailnet，填电脑的 100.x 地址；平板用鸿蒙原生 Tailscale 客户端。",
      "lean.remote.hint.lan": "平板与电脑在同一 Wi-Fi/局域网，填电脑的局域网 IP。",
      "lean.remote.hint.ipv6": "电脑有公网 IPv6 且放行入站，填 [地址]:端口；平板需支持 IPv6。",
      "lean.remote.hint.fallback": "未知方式暂无专用提示，请以上方状态行为准。",
      // 传输诚实：TLS 落地前只讲事实，不做任何通道安全承诺。
      "lean.remote.transport.recommended": "推荐：Tailscale（已加密）",
      "lean.remote.transport.plaintext": "当前为明文 HTTP，仅建议在 Tailscale 下使用；加密传输模块随后",
      "lean.remote.transport.encrypted": "已加密（自签名证书，按配对指纹校验）",
      "lean.remote.unavailable": "不可用",
      "lean.remote.port.auto": "自动端口：{port}",
      "lean.remote.qr.show": "显示二维码",
      "lean.remote.rotated": "已重新生成：旧二维码与旧令牌立即失效，平板必须重新扫码配对。",
      "lean.remote.announce.pending": "待公告（未接公告钩子，每次打开都会请求重发）",
      "lean.remote.announce.none": "暂无待公告变更",
      "lean.remote.audit.title": "当前连接",
      "lean.remote.audit.empty": "当前没有设备连接",
      "lean.remote.live.since": "已连接 {n} 分钟",
      "lean.remote.live.watching": "正在查看",
      "lean.remote.live.more": "还有 {n} 个",
      "lean.remote.stop": "停止接受连接",
      "lean.remote.start": "开始接受连接",
      "lean.remote.started": "已启动",
      "lean.remote.accepting": "正在接受连接（{addr}）",
      "lean.remote.autostarted": "已在启动时自动恢复",
      "lean.remote.stopped": "未启动",
      "lean.remote.start.failed": "监听启动失败",
      "lean.remote.listener-failed": "监听已失效（{code}）：{message}。面板不再显示「正在接受连接」。请点「停止接受连接」再点「开始接受连接」；若反复失败，请检查端口是否已被别的程序占用、网卡是否还连着。"
    }

    const en = {
      "meta.title": "Config sync",
      "meta.description": "Sync DSH configuration across devices over Git (patch entries, providers, plugin manifest, MCP). Open Settings → Config sync; secrets never enter the repository.",
      "meta.detail": "docs/DETAIL.md",
      "nav": "Config sync",
      // One entry name + two in-page group headings (not two plugin views).
      "panel.title": "DSH-dots",
      "group.sync": "Config sync",
      "group.remote": "Remote control",








      "error.network": "Network error: cannot reach the DSH server. Check that it is still running.",
      "error.http": "Server returned HTTP {status}; check the DSH logs.",
      "error.badResponse": "Server returned an unparsable response.",
      "error.unauthorized": "DSH authorization rejected (401/403).",
      "error.unknown": "Unknown error.",
      "error.giteeUsername": "Gitee requires a username (your Gitee login name). A private token is the password, not the username.",










      "remote.nav": "Remote access",
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
      "remote.actions.title": "Actions",
      "remote.probe.ok": "Pass",
      "remote.probe.warn": "Warn",
      "remote.probe.fail": "Fail",
      "remote.probe.unknown": "Unproven",

      // mod-plugin-lean-panel: lean-panel copy (app semantics, no second wording scheme).
      "lean.repo.url": "Repository URL",
      "lean.repo.token": "Access token",
      // mod-plugin-git-username: read-only derived login + auth-failure-only editable field.
      "lean.sync.login": "Login name",
      "lean.sync.login.inferred": "Login name: {name} (inferred from the repository URL)",
      "lean.sync.login.required": "A Gitee private token can only be used as the password; your login name is required - usually the owner in the repository URL.",
      "lean.missing.url": "repository URL",
      "lean.missing.token": "access token",
      "lean.actions.save": "Save",
      "lean.status.synced": "Synced · {time}",
      "lean.status.syncing": "Syncing…",
      "lean.status.failed": "Failed: {reason}",
      "lean.status.unconfigured": "Not configured: missing {missing}",
      "lean.status.blocked": "Configured (visibility blocked, push forbidden)",
      "lean.status.never": "Never synced",
      // mod-plugin-chat-export-auto: permanent static notice (no button, no dialog, not dismissible).
      "lean.chatExport.honesty": "Conversation content is automatically synced to the cloud repository just like schedule entries, stored as plaintext JSONL, and committed to Git history; it cannot be erased.",
      "lean.chatExport.scope": "The tablet/cloud shows sessions you created in chat or dots mode; all 888 sessions already on this machine are work mode and will not be synced, so the tablet's session list is empty until you create a chat or dots session.",
      "lean.chatExport.paused": "Auto-publish paused: {reason} (committed bytes are kept; no automatic retry this round)",
      "lean.chatExport.partial": "Partially published: {n}; stopped at the time limit, {m} left for the next sync",
      "lean.chatExport.skipped": "Skipped {n} incomplete session(s) this round",
      "lean.remote.mode": "Access mode",
      "lean.remote.port": "Port",
      "lean.remote.token": "Access token",
      "lean.remote.generate": "Regenerate",
      "lean.remote.copy": "Copy pairing text",
      "lean.remote.selfcheck": "Self-check",
      "lean.remote.qr": "QR code",
      "lean.remote.mode.unselected": "No access mode selected yet",
      "lean.remote.probe.never": "No check yet; click Self-check to see whether this machine is actually reachable.",
      "lean.mode.lan": "LAN",
      "lean.mode.tailscale": "Tailscale",
      "lean.mode.ipv6": "IPv6",
      // mod-plugin-pairing-client: auto transport / explicit QR / rotation consequence / redacted audit / stop.
      "lean.remote.mode.hint": "Mode (auto-selected, overridable)",
      "lean.remote.mode.auto": "Auto (recommended)",
      "lean.remote.transport.selected": "Auto-selected: {mode}",
      // retarget（mod-plugin-remote-hints-mode-keyed）：只给唯一推荐动作，不再并列多种方式的前提。
      "lean.remote.transport.none": "No usable network detected: sign in to Tailscale first so the tablet joins the same tailnet (recommended).",
      "lean.remote.transport.fallback": "Selected mode unavailable; fell back to auto-selection",
      // mod-plugin-remote-hints-mode-keyed：按方式唯一的提示，只讲本方式自己的前提。
      "lean.remote.hint.auto": "Auto-selection is on: the transport follows the networks currently available.",
      "lean.remote.hint.tailscale": "Join the same tailnet on both ends and enter the PC's 100.x address; the tablet needs the native HarmonyOS Tailscale client.",
      "lean.remote.hint.lan": "Put the tablet and PC on the same Wi-Fi/LAN and enter the PC's LAN IP.",
      "lean.remote.hint.ipv6": "The PC needs public IPv6 with inbound access allowed; enter [address]:port and make sure the tablet supports IPv6.",
      "lean.remote.hint.fallback": "No specific guidance for this mode; follow the status line above.",
      // Transport honesty: state facts only; no channel-security promise until TLS lands.
      "lean.remote.transport.recommended": "Recommended: Tailscale (encrypted)",
      "lean.remote.transport.plaintext": "Plain HTTP right now; only recommended under Tailscale; encrypted transport module to follow",
      "lean.remote.transport.encrypted": "Encrypted (self-signed certificate, verified against the pairing fingerprint)",
      "lean.remote.unavailable": "unavailable",
      "lean.remote.port.auto": "Auto port: {port}",
      "lean.remote.qr.show": "Show QR",
      "lean.remote.rotated": "Regenerated: the old QR and token stop working now; the tablet must pair again.",
      "lean.remote.announce.pending": "Awaiting announce (no hook wired; a republish is requested on every open)",
      "lean.remote.announce.none": "No pending announce changes",
      "lean.remote.audit.title": "Live connections",
      "lean.remote.audit.empty": "No devices are connected right now",
      "lean.remote.live.since": "Connected {n} min",
      "lean.remote.live.watching": "Viewing",
      "lean.remote.live.more": "{n} more",
      "lean.remote.stop": "Stop accepting connections",
      "lean.remote.start": "Start accepting connections",
      "lean.remote.started": "Started",
      "lean.remote.accepting": "Accepting connections ({addr})",
      "lean.remote.autostarted": "Restored automatically at startup",
      "lean.remote.stopped": "Not started",
      "lean.remote.start.failed": "Listener failed to start",
      "lean.remote.listener-failed": "Listener failed ({code}): {message}. The panel no longer claims it is accepting. Click “Stop accepting connections”, then “Start accepting connections”; if it keeps failing, check whether another program took the port or the network adapter is still connected."
    }

    const DICTS = { zh: zh, en: en }

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
    // mod-plugin-remote-hints-mode-keyed：远程方式提示表（纯数据 + 查表，零副作用）。
    // 只按 select 的真实可选项建条目：auto / tailscale / lan / ipv6；
    // none = 没检测到传输（只给一条推荐动作），fallback = 未知方式的中性兜底。
    // 每条只讲自己的前提，绝不拼进别的方式的整句要求。
    // ------------------------------------------------------------------
    const LEAN_MODE_HINT_KEYS = {
      auto: 'lean.remote.hint.auto',
      tailscale: 'lean.remote.hint.tailscale',
      lan: 'lean.remote.hint.lan',
      ipv6: 'lean.remote.hint.ipv6',
      none: 'lean.remote.transport.none',
      fallback: 'lean.remote.hint.fallback'
    }

    /** 纯查表：空串 = 未检测到(none)；未知值 = 中性 fallback，绝不回落到某个具体方式。 */
    function leanModeHintKey(mode) {
      if (mode === '') return LEAN_MODE_HINT_KEYS.none
      if (typeof mode !== 'string' || !Object.prototype.hasOwnProperty.call(LEAN_MODE_HINT_KEYS, mode)) {
        return LEAN_MODE_HINT_KEYS.fallback
      }
      return LEAN_MODE_HINT_KEYS[mode]
    }

    /** 取唯一一条提示文案；tr 由调用方注入，本函数无副作用。 */
    function leanModeHint(mode, tr) {
      return tr(leanModeHintKey(mode))
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
      // 单页内的两组能力：默认展开、可折叠，但仍属于同一个 settings.section。
      panelTitle: { fontSize: 16, fontWeight: 600, margin: 0, color: C.labelPrimary },
      group: {
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: '8px 10px', border: '1px solid ' + C.borderL2,
        borderRadius: 10, background: C.bgFloat, minWidth: 0, boxSizing: 'border-box'
      },
      groupSummary: { cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.labelPrimary, listStyle: 'none' },
      groupBody: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 },
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
    // UI primitives still used by the shipped LeanSyncGroup / LeanRemoteGroup
    // (restored verbatim from the pre-deletion source; zero behaviour change).
    // ------------------------------------------------------------------
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


    function Input(props) {
      return h('input', {
        // mod-plugin-lean-panel：端口需要原生 number 输入（旧远程面板一直用 number）。
        type: props.type === 'password' || props.type === 'number' ? props.type : 'text',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: asText(props.placeholder),
        disabled: Boolean(props.disabled),
        autoComplete: props.autoComplete === 'new-password' ? 'new-password' : 'off',
        spellCheck: props.spellCheck === true,
        onChange: function (event) {
          if (typeof props.onChange === 'function') props.onChange(event.target.value)
        },
        // mod-plugin-lean-panel r2：远程令牌输入失焦即落盘（精简面板无独立保存按钮）。
        onBlur: typeof props.onBlur === 'function'
          ? function (event) { props.onBlur(event.target.value) }
          : undefined,
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
          // 不可用的传输方式要显式灰掉（不能静默消失）；其它 Select 不传 disabled 时保持原样。
          return h('option', {
            key: String(o.value),
            value: String(o.value),
            disabled: o.disabled === true
          }, asText(o.label))
        })
      )
    }


    function childrenOf(props) {
      return React.Children.toArray(props.children === undefined ? [] : props.children)
    }

    /** Wrap children in keyed fragments so React never warns about lists. */

    function keyedKids(kids, prefix) {
      return kids.map(function (kid, i) {
        return h(React.Fragment, { key: prefix + i }, kid)
      })
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

    // ------------------------------------------------------------------
    // mod-plugin-lean-panel：面板只保留两字段 + 两动作；远程只保留方式 / 端口 /
    // 令牌 / 自检 / 二维码。功能的引擎实现一字未删，只是不再有 UI 入口（UI-dormant）。
    // 旧 SettingsPanel / RemotePanel 已随 mod-plugin-dormant-panel-removal 删除，
    // 不存在任何可把它们重新挂回页面的路径；引擎能力仍一字未删（UI-dormant 清单见 docs/MODULES.md §2）。
    // ------------------------------------------------------------------
    /** 把 ISO 时间折成 App 同款 `HH:MM`（本地时钟），没有可信时刻就返回空串。 */
    function fmtClock(value) {
      if (typeof value !== 'string' || value === '') return ''
      try {
        const d = new Date(value)
        if (isNaN(d.getTime())) return value.slice(0, 16)
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        return hh + ':' + mm
      } catch (e) {
        return String(value).slice(0, 16)
      }
    }

    /**
     * 登录名只读派生（mod-plugin-git-username）。浏览器半侧是单文件 bundle、不能 import
     * host 的 TS，所以这里保留一份**纯展示**镜像；规则与 `engine/gitUsername.ts::inferGitUsername`
     * 逐字一致，并由 `test/git-username.test.mjs` 的 G01 对拍表钉住，防止两边漂移。
     *
     * 只认 Gitee 主机：GitHub 永远发 `x-access-token`，把 owner 显示成登录名会误导用户。
     * 推不出来返回空串——此时不渲染派生行，鉴权失败才出现可编辑字段。
     */
    function leanInferLogin(repoUrl) {
      const url = typeof repoUrl === 'string' ? repoUrl.trim() : ''
      if (url === '') return ''
      let host = ''
      let path = ''
      const scp = /^[A-Za-z0-9._-]+@([^:/\\]+):(.*)$/.exec(url)
      if (scp !== null) {
        host = scp[1].toLowerCase()
        path = scp[2]
      } else {
        const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)(\/[^?#]*)?/.exec(url)
        if (scheme !== null) {
          let authority = scheme[1]
          const at = authority.lastIndexOf('@')
          if (at >= 0) authority = authority.slice(at + 1)
          const colon = authority.indexOf(':')
          if (colon >= 0 && authority.indexOf(']') < 0) authority = authority.slice(0, colon)
          host = authority.toLowerCase()
          path = scheme[2] || ''
        } else {
          const bare = /^([A-Za-z0-9.-]+\.[A-Za-z]{2,})(\/[^?#]*)?$/.exec(url)
          if (bare === null) return ''
          host = bare[1].toLowerCase()
          path = bare[2] || ''
        }
      }
      if (!(host === 'gitee.com' || host.endsWith('.gitee.com'))) return ''
      const segments = path.split('/').map(function (segment) { return segment.trim() }).filter(function (segment) { return segment !== '' })
      if (segments.length < 2) return ''
      const owner = segments[0] || ''
      return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(owner) ? owner : ''
    }

    /** 鉴权失败（401/403 或 E_AUTH）才展开登录名字段；其它失败不动。 */
    function leanIsAuthFailure(result) {
      if (!result || result.ok !== false) return false
      const error = result.error && typeof result.error === 'object' ? result.error : {}
      if (error.code === 'E_AUTH') return true
      return /\b(?:401|403)\b/.test(asText(error.message))
    }

    /**
     * 把 host 的两份权威返回体归一成状态行的唯一输入。
     *
     * 关键教训（review M2）：`SyncSettings`（settings.json 的持久化形状）**没有** hasToken。
     * `getState` 把 `hasToken` 挂在 settings 视图上，`saveSettings` 把它挂在顶层。
     * 所以这里显式读这两个**真实存在**的位置，绝不从持久化字段里臆造「令牌已保存」或
     * 「令牌缺失」；`status`（含 blocked / lastSyncAt）原样透传，保存动作无权清空它。
     */
    function leanStateView(state, knownTokenPresent) {
      const data = state && typeof state === 'object' ? state : {}
      const settings = data.settings && typeof data.settings === 'object' ? data.settings : {}
      const status = data.status && typeof data.status === 'object' ? data.status : {}
      const tokenPresent =
        settings.hasToken === true || data.hasToken === true || knownTokenPresent === true
      return { settings: settings, status: status, tokenPresent: tokenPresent }
    }

    /**
     * 唯一状态行：复用 App 的语义与字面——
     *   `已同步 · HH:MM` / `失败：<原因>` / `未配置：缺少<字段>` /
     *   `已配置（可见性阻断，禁止推送）` / `尚未同步` / `同步中…`。
     * 不新增第二套措辞，也不把「保存成功」冒充「已同步」。
     * `tokenPresent` 必须来自 leanStateView 的权威归一（不读不存在的持久化字段）。
     */
    function leanStatusText(translate, settings, status, tokenPresent, busy, failure) {
      const cfg = settings && typeof settings === 'object' ? settings : {}
      const st = status && typeof status === 'object' ? status : {}
      if (busy === 'save' || busy === 'probe') return translate('lean.status.syncing')
      const missing = []
      if (asText(cfg.repoUrl).trim() === '') missing.push(translate('lean.missing.url'))
      if (tokenPresent !== true) missing.push(translate('lean.missing.token'))
      if (missing.length) return translate('lean.status.unconfigured', { missing: missing.join('、') })
      // 隐私闸是「已配置但不能推」的独立问题：宿主给出 blocked 标记时照 App 原句显示。
      if (st.visibilityBlocked === true || st.privacyBlocked === true || st.repoBlocked === true) {
        return translate('lean.status.blocked')
      }
      const errText =
        asText(failure) ||
        (typeof st.error === 'string' ? st.error : asText(st.error && st.error.message))
      if (errText) return translate('lean.status.failed', { reason: errText })
      if (st.lastSyncAt) return translate('lean.status.synced', { time: fmtClock(st.lastSyncAt) })
      return translate('lean.status.never')
    }

    /** 配置同步组：仓库地址 + 访问令牌 + 一行状态 + 保存 / 测试连接。 */
    function LeanSyncGroup(props) {
      const tr = makeT(props)
      const seedState = props && props.seedState && typeof props.seedState === 'object' ? props.seedState : null
      const [state, setState] = React.useState(seedState)
      const [repoUrl, setRepoUrl] = React.useState(
        seedState && seedState.settings ? asText(seedState.settings.repoUrl) : ''
      )
      const [token, setToken] = React.useState('')
      const [hasToken, setHasToken] = React.useState(
        seedState && seedState.settings ? seedState.settings.hasToken === true : false
      )
      const [busy, setBusy] = React.useState('')
      const [failure, setFailure] = React.useState('')
      // mod-plugin-git-username：登录名默认不出现；只有 E_AUTH / 401 / 403 才展开。
      const [needLogin, setNeedLogin] = React.useState(false)
      const [loginName, setLoginName] = React.useState('')

      React.useEffect(function () {
        if (seedState !== null) return function () {}
        let stopped = false
        Promise.resolve(rpcCall('getState', {})).then(function (result) {
          if (stopped || !result.ok) return
          setState(result.data)
          if (result.data && result.data.settings) {
            setRepoUrl(asText(result.data.settings.repoUrl))
            setHasToken(result.data.settings.hasToken === true)
            // 手填过的登录名只来自本机 settings.username（本地鉴权配置，不进仓库）。
            setLoginName(asText(result.data.settings.username))
          }
        })
        return function () { stopped = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      /**
       * 登录名失焦即写本机 settings.json（只写 username，令牌/配对串/仓库都不碰）。
       * 这样一旦字段因 401 出现，用户输入的值在刷新页面后仍在——「显示过就持久」。
       */
      async function persistLogin(value) {
        const next = typeof value === 'string' ? value.trim() : ''
        setLoginName(next)
        if (!needLogin) return
        const result = await rpcCall('saveSettings', {
          settings: { repoUrl: repoUrl, branch: 'main', username: next },
          token: undefined
        })
        if (!result.ok) setFailure(localizeError(tr, result.error).message)
      }

      async function doSave() {
        if (busy) return
        setBusy('save')
        setFailure('')
        try {
          // 分支固定 main；设备标识 / 平台由 host 归一时推导，界面永不询问。
          const settings = { repoUrl: repoUrl, branch: 'main' }
          if (loginName !== '') settings.username = loginName
          const result = await rpcCall('saveSettings', {
            settings: settings,
            token: token === '' ? undefined : token
          })
          if (!result.ok) {
            if (leanIsAuthFailure(result)) setNeedLogin(true)
            setFailure(localizeError(tr, result.error).message)
            return
          }
          if (result.data) {
            // review M2：saveSettings 只回 {settings, hasToken}，没有 status。
            // 合并进旧 state 而不是整体替换，保住隐私闸 blocked 与真实的 lastSyncAt；
            // 令牌存在性只认 host 返回的权威 hasToken（顶层），不从 settings 里猜。
            setState(function (prev) {
              const base = prev && typeof prev === 'object' ? prev : {}
              return Object.assign({}, base, {
                settings: result.data.settings,
                status: base.status || {}
              })
            })
            setHasToken(result.data.hasToken === true)
          }
          setToken('')
          // 宿主已接受本次鉴权配置：条件字段收起，回到只读派生行。
          setNeedLogin(false)
        } finally {
          setBusy('')
        }
      }

      // mod-plugin-sync-probe-removal：lean 同步组的「测试连接」按钮与 doTest() 已删除。
      // 鉴权失败的登录名展开改由 doSave() 的 401/403 分支承担；RPC testConnection 仍保留
      // 为服务端内部 / dormant 动作（当前 shipped UI 无任何控件可达）。

      const view = leanStateView(state, hasToken)
      const line = leanStatusText(tr, view.settings, view.status, view.tokenPresent, busy, failure)
      const inferred = leanInferLogin(repoUrl)

      return h(
        'div',
        { style: S.groupBody },
        h(
          Field,
          { label: tr('lean.repo.url') },
          h(Input, {
            value: repoUrl,
            disabled: Boolean(busy),
            onChange: function (value) { setRepoUrl(value) }
          })
        ),
        h(
          Field,
          { label: tr('lean.repo.token') },
          h(Input, {
            type: 'password',
            value: token,
            autoComplete: 'new-password',
            disabled: Boolean(busy),
            onChange: function (value) { setToken(value) }
          })
        ),
        // 只读派生行：让用户看到实际会发给 Gitee 的登录名（不是新增常驻输入框）。
        inferred !== '' && !needLogin
          ? h('div', { role: 'note', 'data-lean': 'sync-login-derived', style: S.hint },
              tr('lean.sync.login.inferred', { name: inferred }))
          : null,
        // 只有 401/403 才展开；失焦即落本机 settings.username，刷新后仍在。
        needLogin
          ? h(
              'div',
              { 'data-lean': 'sync-login-field' },
              h('div', { role: 'note', 'data-lean': 'sync-login-hint', style: S.hint },
                tr('lean.sync.login.required')),
              h(
                Field,
                { label: tr('lean.sync.login') },
                h(Input, {
                  value: loginName,
                  disabled: Boolean(busy),
                  onChange: function (value) { setLoginName(value) },
                  onBlur: persistLogin
                })
              )
            )
          : null,
        h('div', { role: 'status', 'data-lean': 'sync-status', style: S.hint }, line),
        // mod-plugin-chat-export-auto：失败 / 部分发布状态行。只透传引擎给的 typed 安全文案；
        // 没有这一行时不渲染，绝不自己拼「已同步」式成功文案（§8）。
        view && view.status && typeof view.status.chatExportLine === 'string' && view.status.chatExportLine !== ''
          ? h('div', { 'data-lean': 'chat-export-status', style: S.hint }, view.status.chatExportLine)
          : null,
        h(
          'div',
          { style: S.row },
          h(Btn, {
            label: tr('lean.actions.save'),
            primary: true,
            disabled: Boolean(busy),
            onClick: doSave
          })
        )
      )
    }

    /**
     * 远程控制组（mod-plugin-pairing-client）：自动选路 + 可覆盖 + 原因行；
     * 二维码 / 复制串只由显式 `pairingShow` 取得（qr 只进 QrMatrix，text 只进剪贴板）；
     * 重新生成 = 显式轮换 + 新二维码 + 重新配对提示；当前连接 = 引擎的活视图（不是历史审计）；
     * 停止接受连接 = 关闭监听并显示已停止。
     *
     * 硬纪律：挂载只调 pairingProvision / pairingTransports / remoteGetState，
     * **绝不**调 pairingShow（bearer secret 出口）、**绝不**写剪贴板、
     * **绝不**渲染端口 / 令牌输入框（端口只读展示，令牌只有 `present` 状态）。
     */
    /** 面板自己的最后一道脱敏：只收白名单字段，任何 ? / token / URL 都进不了 DOM。 */
    const LIVE_PEER_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:.]+|已脱敏)$/
    const LIVE_TRANSPORTS = ['局域网', 'Tailscale', 'IPv6', '未知']
    function readLiveConnections(raw) {
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.connections)) return { connections: [], count: 0 }
      const rows = []
      for (const item of raw.connections.slice(0, 5)) {
        if (!item || typeof item !== 'object') continue
        const peer = typeof item.peer === 'string' && LIVE_PEER_RE.test(item.peer) ? item.peer : '已脱敏'
        const transport = LIVE_TRANSPORTS.includes(item.transport) ? item.transport : '未知'
        const since = typeof item.since === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(item.since) ? item.since : ''
        if (since === '') continue
        rows.push({
          peer,
          transport,
          kind: item.kind === 'tunnel' ? 'tunnel' : 'http',
          since,
        })
      }
      const count = Number.isInteger(raw.count) && raw.count >= rows.length ? raw.count : rows.length
      return { connections: rows, count }
    }

    /**
     * P2-1：面板打开期间「当前连接」的轮询间隔。5 秒是有界折中——新对端最迟 5 秒上屏，
     * 静默对端最迟 5 秒消失，而每次只是只读的 remoteGetState，不是忙循环；请求还有在飞去重。
     */
    const LIVE_POLL_MS = 5_000

    function LeanRemoteGroup(props) {
      const tr = makeT(props)
      const [view, setView] = React.useState(null)
      const [transports, setTransports] = React.useState(null)
      const [override, setOverride] = React.useState('')
      const [fallback, setFallback] = React.useState(false)
      // shown 只留 qr 矩阵：pairingShow 的 payload / text 绝不进 state / DOM / 日志。
      const [shown, setShown] = React.useState(null)
      // 「当前连接」活视图：只来自 remoteGetState 的 status.liveConnections；历史审计不再上屏。
      const [liveConnections, setLiveConnections] = React.useState({ connections: [], count: 0 })
      const [running, setRunning] = React.useState(null)
      /**
       * mod-plugin-remote-autostart：这次监听是不是插件激活时**自己**恢复的
       * （引擎给 `status.startedBy === 'auto'`）。自动恢复若不声不响，面板上的「已启动」
       * 会像"我什么时候点的？"，所以另起一行说明。
       */
      const [autoStarted, setAutoStarted] = React.useState(false)
      /**
       * mod-plugin-remote-accepting-surface：**此刻在不在接**（引擎给的 `settings.accepting`，
       * 与 `status.running` 同一个句柄）。与 `settings.enabled` 无关——后者是"上次保存的偏好"，
       * 崩溃后可能停在 true，**绝不允许**拿来推断这一句。
       */
      const [accepting, setAccepting] = React.useState(null)
      /** 活真相同源的 `host:port`（`settings.listen`）；未在接为空串。 */
      const [acceptAddr, setAcceptAddr] = React.useState('')
      /**
       * mod-plugin-dispose-hygiene-residuals item 1：监听在启动**之后**失效的 typed 原因
       * （引擎的 `status.listenerFailure`，只在句柄报到 server 级错误时出现）。
       * 它不为 null 时面板必须说出「监听已失效（code）」并给下一步——不能只留一个字段。
       */
      const [listenerFailure, setListenerFailure] = React.useState(null)
      const [probe, setProbe] = React.useState(null)
      /**
       * mod-plugin-lan-address-selection：状态里那条「广播哪个地址、为什么」的中文说明
       * （引擎给的 `status.urls[].note`，与地址同源）。空串 = 本条目不适用（非局域网方式）。
       */
      const [addressNote, setAddressNote] = React.useState('')
      const [republish, setRepublish] = React.useState(null)
      const [rotated, setRotated] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [failure, setFailure] = React.useState('')
      const booted = React.useRef(false)
      // P2-1 轮询句柄：只由本组件的挂载 effect 建立与清理，和预约槽一样幂等。
      const liveTimer = React.useRef(null)
      const livePolling = React.useRef(false)

      function activeOverride() { return override === '' ? 'auto' : override }

      /**
       * 唯一的远程状态落地口：running / probe / 地址说明 / **活真相**一起更新，
       * 避免四个 setState 各自漂移。`addressNote` 只取引擎算好的那一行（`urls[].note`），
       * 前端不自己拼地址判断。
       *
       * `settings` 是 `remoteGetState` 的 settings 视图；`remoteStart` 只回 `RemoteStatus`，
       * 那种调用方只把 `status` 传进来（活真相留空等下一次 getState，绝不靠猜）。
       */
      function applyRemoteStatus(status, settings) {
        if (!status || typeof status !== 'object') return
        setRunning(status.running === true)
        // 当前连接只认 status.liveConnections（引擎每次读都会剪枝）；不读历史审计。
        setLiveConnections(readLiveConnections(status.liveConnections))
        // 自动恢复的标签必须跟"这次是谁拉起来的"同源；未启动时一律不显示。
        setAutoStarted(status.running === true && status.startedBy === 'auto')
        if (status.probe) setProbe(status.probe)
        const first = Array.isArray(status.urls) && status.urls.length > 0 ? status.urls[0] : null
        const note = first && typeof first.note === 'string' ? first.note : ''
        setAddressNote(note)
        // 活真相只认引擎派生的 `accepting` / `listen`（同一份句柄），**不看** `enabled`。
        if (settings && typeof settings === 'object') {
          setAccepting(settings.accepting === true)
          setAcceptAddr(typeof settings.listen === 'string' ? settings.listen : '')
        }
        // 监听失败通道：typed 原因由引擎给（server 级错误才出现），前端只负责说出来。
        const failed = status.listenerFailure
        setListenerFailure(
          failed && typeof failed === 'object' && typeof failed.code === 'string'
            ? { code: failed.code, message: typeof failed.message === 'string' ? failed.message : '' }
            : null
        )
      }

      /**
       * P2-1：面板开着时周期性重读引擎的活视图。只读引擎给的字段；引擎剪掉的对端下一次
       * 轮询就会从列表消失，前端绝不自行补一个"还在"的假象。在飞请求去重，避免慢 RPC 堆积。
       */
      async function pollLiveConnections() {
        if (livePolling.current) return
        livePolling.current = true
        try {
          const result = await rpcCall('remoteGetState', {})
          if (result.ok && result.data) applyRemoteStatus(result.data.status, result.data.settings)
        } catch (e) {
          /* rpcCall 不抛；这里只兜住意外，失败不改写上一次引擎快照 */
        } finally {
          livePolling.current = false
        }
      }

      async function refreshProvision(which) {
        const result = await rpcCall('pairingProvision', { transport: which === '' ? 'auto' : which })
        if (!result.ok) {
          setFailure(localizeError(tr, result.error).message)
          return false
        }
        if (result.data) {
          setView(result.data.view)
          setRepublish(result.data.republish || null)
        }
        return true
      }

      async function refreshTransports(which) {
        const result = await rpcCall('pairingTransports', { transport: which === '' ? 'auto' : which })
        if (!result.ok) {
          setFailure(localizeError(tr, result.error).message)
          return null
        }
        const data = result.data || null
        if (data) {
          setTransports(data)
          setFallback(data.overrideUnavailable === true)
        }
        return data
      }

      React.useEffect(function () {
        if (booted.current) return function () {}
        booted.current = true
        let stopped = false
        Promise.resolve((async function () {
          // 真实宿主 props（只有 t / close）：三个只读入口各取一次，没有任何种子接缝。
          // 「当前连接」来自 remoteGetState 的 status.liveConnections，不再请求历史审计 pairingConnections。
          await Promise.all([
            refreshProvision(''),
            refreshTransports(''),
            (async function () {
              const result = await rpcCall('remoteGetState', {})
              if (!stopped && result.ok && result.data) applyRemoteStatus(result.data.status, result.data.settings)
            })(),
          ])
        })()).catch(function () { /* rpcCall 不抛；这里只兜住意外 */ })

        /**
         * P2-1：面板开着才轮询「此刻谁在」。宿主没有单独的 aboutToDisappear 钩子，
         * settings.section 关闭 = 组件卸载，下面的 cleanup 就是 dispose，必须清掉定时器。
         * 页面隐藏（切走标签页）也立刻停表，不留任何在跑的定时器。
         */
        const doc = typeof document === 'undefined' ? null : document
        const startLivePoll = function () {
          if (stopped || liveTimer.current !== null) return
          if (doc !== null && doc.visibilityState !== 'visible') return
          liveTimer.current = setInterval(function () { void pollLiveConnections() }, LIVE_POLL_MS)
          // 无界面宿主不被轮询钉住事件循环；真实页面仍由下面两处显式清理。
          if (typeof liveTimer.current.unref === 'function') liveTimer.current.unref()
        }
        const stopLivePoll = function () {
          if (liveTimer.current !== null) {
            clearInterval(liveTimer.current)
            liveTimer.current = null
          }
        }
        const onVisibility = function () {
          if (doc !== null && doc.visibilityState === 'visible') startLivePoll()
          else stopLivePoll()
        }
        if (doc !== null) {
          onVisibility()
          if (typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility)
        }
        return function () {
          stopped = true
          stopLivePoll()
          if (doc !== null && typeof doc.removeEventListener === 'function') {
            doc.removeEventListener('visibilitychange', onVisibility)
          }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      async function runTask(key, task) {
        if (busy) return
        setBusy(key)
        setFailure('')
        try { await task() } finally { setBusy('') }
      }

      /** 显式动作：pairingShow 是唯一 secret 出口；state 只留 qr，payload / text 不落地。 */
      async function fetchQr(which) {
        // mod-pairing-listener-truth：停止时不产生任何配对产物（前端先挡一道，引擎再 typed 拒绝）。
        if (running !== true) {
          setFailure('E_LISTENER_NOT_RUNNING：' + tr('lean.remote.start'))
          return null
        }
        const result = await rpcCall('pairingShow', { transport: which === '' ? 'auto' : which })
        if (!result.ok) {
          setFailure(localizeError(tr, result.error).message)
          return null
        }
        const data = result.data
        if (!data || !data.qr || typeof data.qr !== 'object') {
          setFailure({ code: 'E_BAD_RESPONSE', message: tr('error.badResponse') })
          return null
        }
        setShown({ qr: data.qr })
        return data
      }

      function doShow() {
        runTask('qr', async function () { await fetchQr(activeOverride()) })
      }

      /** 显式复制：现取现写，只写紧凑配对串；挂载路径永不调用，DOM 永不出现 secret。 */
      function doCopy() {
        runTask('copy', async function () {
          const data = await fetchQr(activeOverride())
          if (data === null) return
          if (typeof data.text !== 'string') {
            setFailure({ code: 'E_BAD_RESPONSE', message: tr('error.badResponse') })
            return
          }
          try {
            const clip = typeof navigator === 'undefined' ? null : navigator.clipboard
            if (clip && typeof clip.writeText === 'function') {
              const pending = clip.writeText(data.text)
              if (pending && typeof pending.catch === 'function') pending.catch(function () {})
            }
          } catch (e) {
            /* 静默失败：绝不把配对串降级渲染进 DOM */
          }
        })
      }

      function doGenerate() {
        runTask('rotate', async function () {
          const result = await rpcCall('pairingRotateToken', { transport: activeOverride() })
          if (!result.ok) {
            setFailure(localizeError(tr, result.error).message)
            return
          }
          if (result.data) {
            setView(result.data.view)
            setRepublish(result.data.republish || null)
          }
          // 后果：旧二维码与旧令牌立即失效，平板必须重新扫码配对。
          setRotated(true)
          await fetchQr(activeOverride())
        })
      }

      function doSelfCheck() {
        runTask('probe', async function () {
          const mode = view && typeof view.transport === 'string' ? view.transport : undefined
          const result = await rpcCall('remoteProbe', mode === undefined ? {} : { mode: mode })
          if (!result.ok) {
            setFailure(localizeError(tr, result.error).message)
            return
          }
          if (result.data) setProbe(result.data)
        })
      }

      function doStop() {
        runTask('stop', async function () {
          const result = await rpcCall('remoteStop', {})
          if (!result.ok) {
            setFailure(localizeError(tr, result.error).message)
            return
          }
          // 停止是终态：清掉轮换提示与二维码（没有监听就不该留下可复制的配对产物）。
          setRotated(false)
          setShown(null)
          setRunning(false)
          const state = await rpcCall('remoteGetState', {})
          if (state.ok && state.data) applyRemoteStatus(state.data.status, state.data.settings)
        })
      }

      /**
       * mod-pairing-listener-truth：精简面板**能启动监听**（此前只有停止，fresh install 上
       * enabled:false 永远无法配对）。仍走既有 remoteStart 路径，不另造第二套启动。
       *
       * remoteStart 的失败有两种形态：RPC 层 `ok:false`（服务未挂载等），或 `ok:true` 但
       * `data.running !== true` + `data.lastError`（service.start() 的 fail-closed 返回值）。
       * 两种都要把 **typed code + 中文原因** 写进状态行，绝不静默显示"已启动"。
       */
      function doStart() {
        runTask('start', async function () {
          // 重试 = 运维已经动手：旧的监听事故不再挂在面板上（新状态回来后再按引擎说）。
          setListenerFailure(null)
          const result = await rpcCall('remoteStart', {})
          if (!result.ok) {
            setFailure(localizeError(tr, result.error).message)
            return
          }
          const status = result.data && typeof result.data === 'object' ? result.data : null
          if (!status || status.running !== true) {
            const err = status && status.lastError && typeof status.lastError === 'object' ? status.lastError : null
            const code = err && err.code ? String(err.code) : 'E_LISTENER_NOT_RUNNING'
            const message = err && err.message ? String(err.message) : tr('lean.remote.start.failed')
            setFailure(code + '：' + message)
            setRunning(false)
            setShown(null)
            return
          }
          setRunning(true)
          setRotated(false)
          // 启动返回的就是最新状态：地址说明（广播哪个地址 / 为什么）跟着一起落地。
          applyRemoteStatus(status)
          // mod-plugin-remote-accepting-surface：`remoteStart` 只回 RemoteStatus，没有 settings 视图，
          // 所以这里再读一次状态，让 `settings.accepting` / `settings.listen` 这**唯一**一组成分落地
          // （停止路径本来就这么做）。读失败不影响"已启动"：那一行由 status 决定。
          const live = await rpcCall('remoteGetState', {})
          if (live.ok && live.data) applyRemoteStatus(live.data.status, live.data.settings)
          // 旧二维码（若曾由枚举产生）在真正启动后作废；配对串只由新的 pairingShow 取。
          setShown(null)
          await refreshProvision(activeOverride())
        })
      }

      const qr = shown && shown.qr && typeof shown.qr === 'object' ? shown.qr : null
      // 只有能证明监听在跑才给配对产物；null（尚未读到状态）也按"未启动"处理，fail-closed。
      const stopped = running !== true
      const selected = transports && typeof transports.selected === 'string' ? transports.selected : ''
      const reasonLines = transports && Array.isArray(transports.reasonLines) ? transports.reasonLines : []
      const candidates = transports && transports.candidates && typeof transports.candidates === 'object' ? transports.candidates : {}
      // 手动覆盖不可用 → 回落自动选中，下拉也必须显示回落后的真实方式，绝不留在死选项上。
      const modeValue = fallback && selected !== '' ? selected : (override !== '' ? override : selected)
      // 方式提示只查一行：modeValue 是下拉实际生效值（'' = 未检测到传输）。
      const modeHint = tr(leanModeHintKey(modeValue))
      // 传输诚实：这条说明跟着"实际用于二维码的传输方式"走；transports 还没落地时
      // 退回 provision 的 view.transport（二维码此刻用的就是它），fail-closed 先讲明文事实。
      const effectiveTransport = override !== '' ? override : (selected !== '' ? selected : (view && typeof view.transport === 'string' ? view.transport : ''))
      const probeLevel = probe && typeof probe === 'object' ? asText(probe.level) : ''
      const probeLine = probe && typeof probe === 'object'
        ? asText(probe.verdict) || asText(probe.message) || ''
        : ''
      const probeLabel = probeLevel ? tr('remote.probe.' + probeLevel) : ''
      const statusLine = failure
        ? failure
        : running === false ? tr('lean.remote.stopped')
          : rotated ? tr('lean.remote.rotated')
            : fallback ? tr('lean.remote.transport.fallback')
              : republish ? tr('lean.remote.announce.pending')
                : selected === '' ? tr('lean.remote.transport.none')
                  : probeLevel ? (probeLabel ? probeLabel + ' · ' : '') + probeLine
                    : tr('lean.remote.probe.never')
      const portLine = view && typeof view.port === 'number' && view.port > 0
        ? tr('lean.remote.port.auto', { port: String(view.port) })
        : ''
      // 没有公告钩子时引擎清掉标记并强制重发；这里只报"待公告"，绝不冒充"已公告端口 X"。
      const announceLine = republish
        ? tr('lean.remote.announce.pending')
        : tr('lean.remote.announce.none')

      function optionOf(kind, key) {
        const candidate = candidates[kind]
        const unavailable = !!(candidate && candidate.available === false)
        return {
          value: kind,
          label: tr(key) + (unavailable ? ' · ' + tr('lean.remote.unavailable') : ''),
          disabled: unavailable
        }
      }

      return h(
        'div',
        { style: S.groupBody },
        h(
          Field,
          { label: tr('lean.remote.mode.hint') },
          h(Select, {
            value: modeValue,
            disabled: Boolean(busy),
            options: [
              { value: 'auto', label: tr('lean.remote.mode.auto') },
              optionOf('tailscale', 'lean.mode.tailscale'),
              optionOf('lan', 'lean.mode.lan'),
              optionOf('ipv6', 'lean.mode.ipv6')
            ],
            onChange: function (value) {
              runTask('transport', async function () {
                // 切换方式后旧的"已重新生成"提示立即失效，不许继续遮住真实状态。
                setRotated(false)
                const next = value === 'auto' ? '' : value
                // mod-pairing-listener-truth：先让引擎严格选择并落盘（mode + 地址同一事务）。
                // 不可用会得到 typed 拒绝（例如 E_NO_IPV6_ADDRESS），状态行显示原因，
                // mode 保持原值；绝不"静默回落成 lan 却把 UI 说成 IPv6"。
                const ok = await refreshProvision(next)
                if (!ok) return
                setOverride(next)
                await refreshTransports(next)
              })
            }
          })
        ),
        h('div', { 'data-lean': 'remote-transport', style: S.hint }, modeHint),
        // 运行状态单独一行讲真话：已启动 / 未启动。停止时下面的二维码与复制入口整体不渲染。
        h('div', { 'data-lean': 'remote-running', style: S.hint },
          stopped ? tr('lean.remote.stopped') : tr('lean.remote.started')
        ),
        // mod-plugin-dispose-hygiene-residuals item 1：监听在启动之后死掉时，必须有一句中文
        // 说明它已经不在接（含 typed code、原因与下一步），而不是继续显示「正在接受连接」。
        // 这句话与 accepting 互斥：失败态下 accepting 必为 false，于是上面那一句不会渲染。
        listenerFailure
          ? h('div', { 'data-lean': 'remote-listener-failed', style: S.hint },
              tr('lean.remote.listener-failed', { code: listenerFailure.code, message: listenerFailure.message }))
          : null,
        // mod-plugin-remote-accepting-surface：**只有真的在接**才说「正在接受连接（addr:port）」。
        // 判据是引擎派生的 `accepting`（= 监听句柄存在）与同源的 `listen`，
        // **绝不**用 `enabled`（保存的偏好 / 句柄回声）冒充活真相。
        accepting === true && acceptAddr !== ''
          ? h('div', { 'data-lean': 'remote-accepting', style: S.hint },
              tr('lean.remote.accepting', { addr: acceptAddr }))
          : null,
        // mod-plugin-remote-autostart：激活时自动恢复的那一次要留一句说明，
        // 免得运维以为"我没点它怎么自己开了"。
        autoStarted && !stopped
          ? h('div', { 'data-lean': 'remote-autostart', style: S.hint }, tr('lean.remote.autostarted'))
          : null,
        transports && transports.tls === true
          ? h('div', { 'data-lean': 'remote-transport-honesty', style: S.hint }, tr('lean.remote.transport.encrypted'))
          : (effectiveTransport === 'lan' || effectiveTransport === 'ipv6')
            ? h('div', { 'data-lean': 'remote-transport-honesty', style: S.hint }, tr('lean.remote.transport.plaintext'))
            : null,
        reasonLines.map(function (line, i) {
          return h('div', { key: 'reason' + i, 'data-lean': 'remote-reason', style: S.hint }, line)
        }),
        // mod-plugin-lan-address-selection：唯一一条「广播哪个地址、为什么、跳过了什么」的说明。
        // 文案由引擎给（与真正要绑定的地址同源），前端不重算；空串时不渲染（非局域网方式）。
        addressNote ? h('div', { 'data-lean': 'remote-address-note', style: S.hint }, addressNote) : null,
        portLine ? h('div', { 'data-lean': 'remote-port', style: S.hint }, portLine) : null,
        // 未启动 ⇒ 没有二维码入口、没有可复制配对串；启动是唯一可做的远程动作。
        stopped ? null : h(
          'div',
          { style: S.row },
          h(Btn, { label: tr('lean.remote.qr.show'), disabled: Boolean(busy), onClick: doShow }),
          h(Btn, { label: tr('lean.remote.copy'), disabled: Boolean(busy), onClick: doCopy })
        ),
        h(
          'div',
          { style: S.row },
          h(Btn, { label: tr('lean.remote.generate'), disabled: Boolean(busy), onClick: doGenerate }),
          h(Btn, { label: tr('lean.remote.selfcheck'), disabled: Boolean(busy), onClick: doSelfCheck })
        ),
        h(
          'div',
          { style: S.row },
          stopped
            ? h(Btn, {
                label: tr('lean.remote.start'),
                disabled: Boolean(busy),
                primary: true,
                onClick: doStart
              })
            : h(Btn, {
                label: tr('lean.remote.stop'),
                disabled: Boolean(busy),
                danger: true,
                onClick: doStop
              })
        ),
        h('div', { role: 'status', 'data-lean': 'remote-status', style: S.hint }, statusLine),
        // mod-plugin-chat-export-auto：常驻诚实声明。它是声明，不是按钮、不是确认弹层、不可关闭。
        h('div', { 'data-lean': 'chat-export-honesty', style: S.hint }, tr('lean.chatExport.honesty')),
        h('div', { 'data-lean': 'chat-export-scope', style: S.hint }, tr('lean.chatExport.scope')),
        h('div', { 'data-lean': 'remote-announce', style: S.hint }, announceLine),
        h('div', { 'data-lean': 'remote-audit', style: S.hint },
          h('div', { style: S.groupSummary }, tr('lean.remote.audit.title')),
          liveConnections.connections.length === 0
            ? h('div', { 'data-lean': 'remote-live-empty', style: S.hint }, tr('lean.remote.audit.empty'))
            : liveConnections.connections.map(function (entry, i) {
                // 一行一个对端：IP · 传输 · 已连接 N 分钟；隧道再标「正在查看」。
                const sinceMs = Date.parse(entry.since)
                const minutes = Number.isFinite(sinceMs)
                  ? Math.max(0, Math.floor((Date.now() - sinceMs) / 60000))
                  : 0
                let line = entry.peer + ' · ' + entry.transport + ' · '
                  + tr('lean.remote.live.since').replace('{n}', String(minutes))
                if (entry.kind === 'tunnel') line += ' · ' + tr('lean.remote.live.watching')
                return h('div', {
                  key: 'live' + i, 'data-lean': 'remote-live-connection', style: S.hint,
                }, line)
              }),
          liveConnections.count > liveConnections.connections.length
            ? h('div', { 'data-lean': 'remote-live-more', style: S.hint },
                tr('lean.remote.live.more').replace('{n}', String(liveConnections.count - liveConnections.connections.length)))
            : null
        ),
        h(QrMatrix, { qr: qr, label: tr('lean.remote.qr') })
      )
    }

    // ------------------------------------------------------------------
    // 单一条目 DSH-dots：两组能力在同一页内纵向堆叠（不是 tab，不是第二个视图）。
    // 折叠只是页内的空间管理：默认都展开，控件始终属于同一个 settings.section。
    // `dots-remote` 只保留为远程分组的内部 id，不再注册 settings.section。
    // ------------------------------------------------------------------
    function DotsPanel(props) {
      const tr = makeT(props)
      return h(
        'div',
        { style: S.root },
        h(
          'details',
          { id: 'dots', open: true, style: S.group },
          h('summary', { style: S.groupSummary }, tr('group.sync')),
          h(LeanSyncGroup, props)
        ),
        h(
          'details',
          { id: 'dots-remote', open: true, style: S.group },
          h('summary', { style: S.groupSummary }, tr('group.remote')),
          h(LeanRemoteGroup, props)
        )
      )
    }
    // 内部测试接缝：精简组件供清单守卫单独挂载；旧 dormant 面板已删除。
    DotsPanel.LeanSyncGroup = LeanSyncGroup
    DotsPanel.LeanRemoteGroup = LeanRemoteGroup
    // 纯展示推断的测试接缝：G01 用它逐条对拍 engine/gitUsername.ts（防止两副本漂移）。
    DotsPanel.leanInferLogin = leanInferLogin
    // mod-plugin-remote-hints-mode-keyed：纯查表接缝（与 LeanRemoteGroup / leanInferLogin 同级）。
    DotsPanel.leanModeHint = leanModeHint
    DotsPanel.leanModeHintKey = leanModeHintKey
    DotsPanel.LEAN_MODE_HINT_KEYS = LEAN_MODE_HINT_KEYS

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
      // 全插件只注册这一个 settings.section（「内置插件」因此只有一个条目）。
      // 配置同步 / 远程控制 是同一页里的两个折叠分组，id 保留在页内，绝不再注册为 section。
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dots',
            order: 70,
            label: function () {
              return t('panel.title')
            },
            locale: NS
          },
          DotsPanel
        )
      })
    }

    return { inject: inject, apply: apply }
  }
})
