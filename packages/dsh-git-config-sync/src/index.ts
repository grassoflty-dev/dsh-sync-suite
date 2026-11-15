/**
 * dsh-git-config-sync host 半侧入口（Cordis 函数插件）。
 *
 * 注册两样东西：
 *   1. Web 路由 `/dsh-git-config-sync/rpc` —— 配置同步的 RPC 面（设置/同步/状态/预览/回滚）；
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
}

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): (() => void) | void
}

export interface HostContext {
  webServer: WebServerLike
  connection?: ConnectionLike
  effect(effect: () => (() => void) | void, label?: string): unknown
  /** 宿主 `tools` 服务（可选）。 */
  tools?: ToolsServiceLike
  /** Cordis 的服务注入：`ctx.inject(['tools'], (scope) => …)`（可选）。 */
  inject?(deps: string[], callback: (scope: HostContext) => void): unknown
}

export const inject = ['webServer', 'connection']

export const RPC_PATH = '/dsh-git-config-sync/rpc'

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
  const service: RpcService = createRpcService({
    homeDir: config.homeDir,
    profileDir: config.profileDir,
    dshVersion: config.dshVersion,
    allowLocalRepo: config.allowLocalRepo === true,
  })
  const handler = createHttpHandler(service, ctx.connection)

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: RPC_PATH, handler }),
    'dsh-git-config-sync: /dsh-git-config-sync/rpc',
  )
  ctx.effect(
    () => () => {
      void service.dispose()
    },
    'dsh-git-config-sync: dispose rpc service',
  )

  if (config.scheduleTools !== false) {
    mountScheduleTools(ctx, {
      paths: service.paths,
      allowLocalRepo: config.allowLocalRepo === true,
    })
  }
}
