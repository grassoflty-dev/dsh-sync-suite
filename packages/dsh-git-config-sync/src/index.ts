/**
 * dsh-git-config-sync host 半侧入口（Cordis 函数插件）。
 *
 * 只在 Web 服务上注册一条 exact 路由：`/dsh-git-config-sync/rpc`。
 * 鉴权（Host/Origin fence + 浏览器登录态）由 connection 服务负责，
 * 所以 handler 的第一件事永远是 `ctx.connection.requestRejection(req)`。
 *
 * 所有注册都包在 `ctx.effect(...)` 里，便于插件卸载时释放路由与预览缓存。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHttpHandler, createRpcService } from './rpc.js'
import type { ConnectionLike, RpcService } from './rpc.js'

export interface PluginConfig {
  /** 覆盖 `~`（测试/多用户场景）；默认取 `os.homedir()` 或 `DSH_HOME`。 */
  homeDir?: string
  /** 覆盖 profile 目录；默认 `<.dsh>/profiles/web`（可用 `DSH_PROFILE_DIR`）。 */
  profileDir?: string
  /** 覆盖写入 manifest 的 DSH 版本。 */
  dshVersion?: string
  /** 仅集成测试用：允许本地路径 / file:// 作为 repoUrl。 */
  allowLocalRepo?: boolean
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
}

export const inject = ['webServer', 'connection']

export const RPC_PATH = '/dsh-git-config-sync/rpc'

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
}
