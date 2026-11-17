import { createRemoteModule } from './remote/index.js';
import { createHttpHandler, createRpcService } from './rpc.js';
import { registerScheduleTools } from './schedule/tools.js';
export const inject = ['webServer', 'connection'];
export const RPC_PATH = '/dsh-git-config-sync/rpc';
/**
 * 尝试注册日程工具；宿主没有 `tools` 服务时静默跳过（不是错误：RPC 仍然完整可用）。
 *
 * 优先走 `ctx.inject(['tools'], …)`（服务晚到也能注册上），
 * 没有 `inject` 时退回"当前 ctx 上已经有 tools 就直接注册"。
 */
function mountScheduleTools(ctx, options) {
    const run = (scope) => {
        try {
            registerScheduleTools({
                tools: scope.tools,
                effect: scope.effect.bind(scope),
            }, options);
        }
        catch {
            /* 拿不到 tools 服务/注册被拒：日程工具缺席，配置同步不受影响 */
        }
    };
    if (typeof ctx.inject === 'function') {
        try {
            ctx.inject(['tools'], (scope) => run(scope));
            return;
        }
        catch {
            /* inject 不可用（老宿主）→ 落到下面的直连尝试 */
        }
    }
    if (ctx.tools !== undefined)
        run(ctx);
}
export function apply(ctx, config = {}) {
    // 远程访问域：**独立的失败面**——装配失败只是没有远程访问，配置同步/日程工具照常。
    let remote = null;
    if (config.remoteAccess !== false) {
        try {
            remote = createRemoteModule({
                homeDir: config.homeDir,
                ...(ctx.connection === undefined ? {} : { connection: ctx.connection }),
                webServer: ctx.webServer,
            });
        }
        catch {
            remote = null;
        }
    }
    const service = createRpcService({
        homeDir: config.homeDir,
        profileDir: config.profileDir,
        dshVersion: config.dshVersion,
        allowLocalRepo: config.allowLocalRepo === true,
        ...(remote === null ? {} : { remote: remote.service }),
    });
    const handler = createHttpHandler(service, ctx.connection);
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: RPC_PATH, handler }), 'dsh-git-config-sync: /dsh-git-config-sync/rpc');
    ctx.effect(() => () => {
        void service.dispose();
    }, 'dsh-git-config-sync: dispose rpc service');
    if (remote !== null) {
        const remoteModule = remote;
        ctx.effect(() => () => {
            void remoteModule.service.dispose();
        }, 'dsh-git-config-sync: dispose remote service');
        // 用户上次开了开关 → 本次挂载后自动起监听。
        // 刻意 fire-and-forget 且吞错：监听起不来只写 status.lastError，不许冒到插件启动路径。
        ctx.effect(() => {
            void remoteModule.service
                .getState()
                .then((state) => (state.settings.enabled ? remoteModule.service.start() : undefined))
                .catch(() => undefined);
            return () => undefined;
        }, 'dsh-git-config-sync: remote autostart');
    }
    if (config.scheduleTools !== false) {
        mountScheduleTools(ctx, {
            paths: service.paths,
            allowLocalRepo: config.allowLocalRepo === true,
        });
    }
}
