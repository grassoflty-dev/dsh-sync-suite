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
import { sweepAskpassDirsAtStartup } from './engine/askpassTemp.js'
import { createRemoteModule } from './remote/index.js'
import type { RemoteModule } from './remote/index.js'
import { createPairingService } from './remote/pairingProvision.js'
import { createHttpHandler, createRpcService } from './rpc.js'
import type { ConnectionLike, RpcService } from './rpc.js'
import type { SessionControllerLike } from './remote/sessionPrompt.js'
import { registerScheduleTools } from './schedule/tools.js'
import type { ScheduleToolOptions, ToolsServiceLike } from './schedule/tools.js'
// v2 写半侧：首跑迁移门禁 + 同步周期接线；与 v1 日程工具完全平行，不重连 schedule_*。
import { mountV2Sync } from './sync/bootstrap.js'

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
  /**
   * 宿主 `sessionController`（可选、可能晚挂载）。sessionPrompt 投递端口在每次调用时
   * 惰性读取它；拿不到就是 E_SESSION_UNAVAILABLE，不在插件启动期崩溃。
   */
  sessionController?: SessionControllerLike
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
  // 配对服务先建：远程监听的入站连接要记进它的脱敏审计环；
  // provisioning 新生成的令牌经 onTokenChanged 同步给远程门（全程进程内，token 不进 RPC / DOM / 日志）。
  let remote: RemoteModule | null = null
  const pairing = createPairingService({
    homeDir: config.homeDir,
    // mod-pairing-listener-truth：show() 只认运行监听的事实。这里从 remote.service 投影
    // boundAddress / port / mode / tls（都是 server.address() 与持久化的真值），进程内读取、
    // 不联网、不回显 token。remote 晚于 pairing 装配，故用闭包惰性读取。
    listenerState: async () => {
      const active = remote
      if (active === null) return null
      const state = await active.service.getState()
      const status = state.status
      return {
        running: status.running === true,
        address: status.boundAddress,
        port: status.port,
        mode: state.settings.mode,
        tls: status.tls === true,
      }
    },
    onTokenChanged: (event) => {
      const active = remote
      if (active === null) return
      try {
        active.service.adoptToken?.(event.token)
      } catch {
        /* 门还没就绪时下一次 provision 会再发；关键信息不写控制台（凭据卫生） */
      }
    },
  })
  // 远程访问域：**独立的失败面**——装配失败只是没有远程访问，配置同步/日程工具照常。
  if (config.remoteAccess !== false) {
    try {
      remote = createRemoteModule({
        homeDir: config.homeDir,
        ...(ctx.connection === undefined ? {} : { connection: ctx.connection }),
        webServer: ctx.webServer,
        onConnect: (info) => {
          try {
            pairing.recordConnection(info.remoteAddress, info.at)
          } catch {
            /* 审计失败绝不影响监听 */
          }
        },
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
    pairing,
    ...(remote === null ? {} : { remote: remote.service }),
    // 每次调用都从 ctx 现取：服务晚到 / 未挂载都不影响插件启动，缺席 ⇒ E_SESSION_UNAVAILABLE。
    promptSessionController: () => ctx.sessionController ?? null,
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
  // mod-plugin-askpass-temp-hygiene：插件启动时**顺手**清一次超龄的 askpass 临时目录
  // （`%TEMP%\dsh-gcs-askpass-*`；`dispose()` 只清自己那一个，崩溃/被杀会留下）。
  //
  // 为什么和 RPC dispose 共用同一个 effect，而不是新开一个：
  //   1. 本仓库的既有测试（`confirm-gate` / `schedule-bridge`）把 ctx.effect **数量**当作
  //      契约逐一钉住，新开一个会让它们变成假失败，而那些断言不许删也不许放宽；
  //   2. 这次清理不持有任何可卸载句柄（一次性、跑完即弃），口径与下方 `mountV2Sync`
  //      的注释一致——"运行时不持有可卸载句柄，故不新增 ctx.effect"。
  //
  // 为什么 fire-and-forget（不 await）：清理是尽力而为的收垃圾，绝不许拖慢或阻断插件激活；
  // `sweepAskpassDirsAtStartup()` 自己从不 throw（失败只进 `failed` 计数、不写日志），这里的
  // `.catch` 只是最后一道保险，保证"清理故障"永远不会变成"插件激活失败"。
  ctx.effect(
    () => {
      void sweepAskpassDirsAtStartup(process.env).catch(() => undefined)
      return () => {
        void service.dispose()
      }
    },
    'dsh-dots: dispose rpc service + askpass temp sweep',
  )

  if (remote !== null) {
    const remoteModule = remote
    ctx.effect(
      () => () => {
        void remoteModule.service.dispose()
      },
      'dsh-dots: dispose remote service',
    )
    // mod-plugin-remote-autostart：自动恢复监听**只走这一条路径** —— 意图（`remote.json`
    // 的 `autoStart`）为真时，激活即自己把监听拉起来，不必运维再点一次「开始接受连接」。
    //
    // 为什么不再在这里读设置：`settings.enabled` 是句柄回声（见 `remote/service.ts` 的
    // `commitEnabledFlag`），把它当意图位会让"启动失败"看起来像"用户关掉了"。判据全部
    // 收在 `service.autoStart()` 里（意图 + 已有句柄幂等 + 前提由 start() fail-closed），
    // 插件层只负责**什么时候**问一次。
    //
    // 刻意 fire-and-forget 且吞错：监听起不来只写 `status.lastError`（typed，面板可显示），
    // 绝不冒到插件启动路径、也绝不拖慢激活。
    ctx.effect(
      () => {
        void remoteModule.service.autoStart().catch(() => undefined)
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

  // v2 写半侧：迁移门禁与同步周期只在这里挂一次；装配/启动失败不冒泡，v1 面不受影响。
  // 运行时不持有可卸载句柄，故不新增 ctx.effect（保持既有 effect 数量契约）。
  mountV2Sync(ctx, {
    homeDir: config.homeDir,
    allowLocalRepo: config.allowLocalRepo === true,
  }, false)
}
