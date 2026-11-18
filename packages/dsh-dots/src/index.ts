/**
 * dsh-dots host 半侧入口（Cordis 函数插件）。
 *
 * 注册两样东西：
 *   1. Web 路由 `/dsh-dots/rpc` —— 配置同步的 RPC 面（设置/同步/状态/预览/回滚）；
 *   2. 模型工具 `schedule_list` / `schedule_add` / `schedule_summary` —— 桌面端日程桥，
 *      与平板 App 写同一个 Git 仓库（`devices/<deviceId>/schedules/*.jsonl`）。
 *
 * 鉴权（Host/Origin fence + 浏览器登录态）由 connection 服务负责，
 * 所以 handler 的第一件事永远是 `ctx.connection.requestRejection(req)`。
 *
 * `tools` 是**可选**依赖：用 `ctx.inject(['tools'], …)` 延迟注入，
 * 拿不到 tools 服务时插件照常挂载、RPC 照常可用，只是没有日程工具。
 * 这样 `inject` 声明保持 `['webServer','connection']` 不变，也避免因缺服务导致整个插件不激活。
 *
 * 所有注册都包在 `ctx.effect(...)` 里，便于插件卸载时释放路由、预览缓存与工具注册。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRemoteModule } from './remote/index.js'
import type { RemoteModule } from './remote/index.js'
import { createHttpHandler, createRpcService } from './rpc.js'
import type { ConnectionLike, RpcService } from './rpc.js'
import { registerScheduleTools } from './schedule/tools.js'
import type { ScheduleToolOptions, ToolsServiceLike } from './schedule/tools.js'

export interface PluginConfig {
  /** 覆盖 `~`（测试/多用户场景）；默认取 `os.homedir()` 或 `DSH_HOME`。 */
  homeDir?: string
  /** 覆盖 profile 目录；默认 `<.dsh>/profiles/web`（可用 `DSH_PROFILE_DIR`）。 */
  profileDir?: string
  /** 覆盖写入 manifest 的 DSH 版本。 */
  dshVersion?: string
  /** 仅集成测试用：允许本地路径 / file:// 作为 repoUrl。 */
  allowLocalRepo?: boolean
  /** 注册日程工具（默认 true）；关掉后只剩配置同步 RPC。 */
  scheduleTools?: boolean
  /** 启用远程访问域（默认 true）。关掉后 `remote*` action 一律 E_INTERNAL。 */
  remoteAccess?: boolean
}

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): (() => void) | void
  /** DSH 自己实际监听的端口（`WebServer.port`，asar 已验证存在）。0/未监听时读不到。 */
  port?: number
}

export interface HostContext {
  webServer: WebServerLike
  /**
   * DSH 的 connection 服务。除鉴权围栏外，还提供 `authenticatedUrl()`——
   * 远程访问靠它换本机 DSH 会话（取不到就 fail-closed，不降级成无鉴权转发）。
   */
  connection?: ConnectionLike & { authenticatedUrl?(baseUrl: string): string }
  effect(effect: () => (() => void) | void, label?: string): unknown
  /** 宿主 `tools` 服务（可选）。 */
  tools?: ToolsServiceLike
  /** Cordis 的服务注入：`ctx.inject(['tools'], (scope) => …)`（可选）。 */
  inject?(deps: string[], callback: (scope: HostContext) => void): unknown
}

export const inject = ['webServer', 'connection']

export const RPC_PATH = '/dsh-dots/rpc'

/**
 * 临时兼容旧路径、后续删除：老客户端仍可能请求旧 RPC 路径，这里用同一个 handler
 * 再挂一条 exact 路由。老客户端下线后删除此常量与下面对应的那条注册即可。
 */
export const LEGACY_RPC_PATH = '/dsh-git-config-sync/rpc'

/**
 * 尝试注册日程工具；宿主没有 `tools` 服务时静默跳过（不是错误：RPC 仍然完整可用）。
 *
 * 优先走 `ctx.inject(['tools'], …)`（服务晚到也能注册上），
 * 没有 `inject` 时退回"当前 ctx 上已经有 tools 就直接注册"。
 */
function mountScheduleTools(ctx: HostContext, options: ScheduleToolOptions): void {
  const run = (scope: HostContext): void => {
    try {
      registerScheduleTools(
        {
          tools: scope.tools as ToolsServiceLike,
          effect: scope.effect.bind(scope) as (effect: () => (() => void) | void, label?: string) => unknown,
        },
        options,
      )
    } catch {
      /* 拿不到 tools 服务/注册被拒：日程工具缺席，配置同步不受影响 */
    }
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (scope) => run(scope))
      return
    } catch {
      /* inject 不可用（老宿主）→ 落到下面的直连尝试 */
    }
  }
  if (ctx.tools !== undefined) run(ctx)
}

export function apply(ctx: HostContext, config: PluginConfig = {}): void {
  // 远程访问域：**独立的失败面**——装配失败只是没有远程访问，配置同步/日程工具照常。
  let remote: RemoteModule | null = null
  if (config.remoteAccess !== false) {
    try {
      remote = createRemoteModule({
        homeDir: config.homeDir,
        ...(ctx.connection === undefined ? {} : { connection: ctx.connection }),
        webServer: ctx.webServer,
      })
    } catch {
      remote = null
    }
  }

  const service: RpcService = createRpcService({
    homeDir: config.homeDir,
    profileDir: config.profileDir,
    dshVersion: config.dshVersion,
    allowLocalRepo: config.allowLocalRepo === true,
    ...(remote === null ? {} : { remote: remote.service }),
  })
  const handler = createHttpHandler(service, ctx.connection)

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: RPC_PATH, handler }),
    'dsh-dots: /dsh-dots/rpc',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: LEGACY_RPC_PATH, handler }),
    'dsh-dots: legacy rpc route (临时兼容旧路径、后续删除)',
  )
  ctx.effect(
    () => () => {
      void service.dispose()
    },
    'dsh-dots: dispose rpc service',
  )

  if (remote !== null) {
    const remoteModule = remote
    ctx.effect(
      () => () => {
        void remoteModule.service.dispose()
      },
      'dsh-dots: dispose remote service',
    )
    // 用户上次开了开关 → 本次挂载后自动起监听。
    // 刻意 fire-and-forget 且吞错：监听起不来只写 status.lastError，不许冒到插件启动路径。
    ctx.effect(
      () => {
        void remoteModule.service
          .getState()
          .then((state) => (state.settings.enabled ? remoteModule.service.start() : undefined))
          .catch(() => undefined)
        return () => undefined
      },
      'dsh-dots: remote autostart',
    )
  }

  if (config.scheduleTools !== false) {
    mountScheduleTools(ctx, {
      paths: service.paths,
      allowLocalRepo: config.allowLocalRepo === true,
    })
  }
}
