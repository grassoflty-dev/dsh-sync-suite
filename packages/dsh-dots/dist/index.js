import { createRemoteModule } from './remote/index.js';
import { createPairingService } from './remote/pairingProvision.js';
import { createHttpHandler, createRpcService } from './rpc.js';
import { registerScheduleTools } from './schedule/tools.js';
// v2 写半侧：首跑迁移门禁 + 同步周期接线；与 v1 日程工具完全平行，不重连 schedule_*。
import { mountV2Sync } from './sync/bootstrap.js';
export const inject = ['webServer', 'connection'];
export const RPC_PATH = '/dsh-dots/rpc';
/**
 * 临时兼容旧路径、后续删除：老客户端仍可能请求旧 RPC 路径，这里用同一个 handler
 * 再挂一条 exact 路由。老客户端下线后删除此常量与下面对应的那条注册即可。
 */
export const LEGACY_RPC_PATH = '/dsh-git-config-sync/rpc';
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
    // 配对服务先建：远程监听的入站连接要记进它的脱敏审计环；
    // provisioning 新生成的令牌经 onTokenChanged 同步给远程门（全程进程内，token 不进 RPC / DOM / 日志）。
    let remote = null;
    const pairing = createPairingService({
        homeDir: config.homeDir,
        // mod-pairing-listener-truth：show() 只认运行监听的事实。这里从 remote.service 投影
        // boundAddress / port / mode / tls（都是 server.address() 与持久化的真值），进程内读取、
        // 不联网、不回显 token。remote 晚于 pairing 装配，故用闭包惰性读取。
        listenerState: async () => {
            const active = remote;
            if (active === null)
                return null;
            const state = await active.service.getState();
            const status = state.status;
            return {
                running: status.running === true,
                address: status.boundAddress,
                port: status.port,
                mode: state.settings.mode,
                tls: status.tls === true,
            };
        },
        onTokenChanged: (event) => {
            const active = remote;
            if (active === null)
                return;
            try {
                active.service.adoptToken?.(event.token);
            }
            catch {
                /* 门还没就绪时下一次 provision 会再发；关键信息不写控制台（凭据卫生） */
            }
        },
    });
    // 远程访问域：**独立的失败面**——装配失败只是没有远程访问，配置同步/日程工具照常。
    if (config.remoteAccess !== false) {
        try {
            remote = createRemoteModule({
                homeDir: config.homeDir,
                ...(ctx.connection === undefined ? {} : { connection: ctx.connection }),
                webServer: ctx.webServer,
                onConnect: (info) => {
                    try {
                        pairing.recordConnection(info.remoteAddress, info.at);
                    }
                    catch {
                        /* 审计失败绝不影响监听 */
                    }
                },
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
        pairing,
        ...(remote === null ? {} : { remote: remote.service }),
        // 每次调用都从 ctx 现取：服务晚到 / 未挂载都不影响插件启动，缺席 ⇒ E_SESSION_UNAVAILABLE。
        promptSessionController: () => ctx.sessionController ?? null,
    });
    const handler = createHttpHandler(service, ctx.connection);
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: RPC_PATH, handler }), 'dsh-dots: /dsh-dots/rpc');
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: LEGACY_RPC_PATH, handler }), 'dsh-dots: legacy rpc route (临时兼容旧路径、后续删除)');
    ctx.effect(() => () => {
        void service.dispose();
    }, 'dsh-dots: dispose rpc service');
    if (remote !== null) {
        const remoteModule = remote;
        ctx.effect(() => () => {
            void remoteModule.service.dispose();
        }, 'dsh-dots: dispose remote service');
        // 用户上次开了开关 → 本次挂载后自动起监听。
        // 刻意 fire-and-forget 且吞错：监听起不来只写 status.lastError，不许冒到插件启动路径。
        ctx.effect(() => {
            void remoteModule.service
                .getState()
                .then((state) => (state.settings.enabled ? remoteModule.service.start() : undefined))
                .catch(() => undefined);
            return () => undefined;
        }, 'dsh-dots: remote autostart');
    }
    if (config.scheduleTools !== false) {
        mountScheduleTools(ctx, {
            paths: service.paths,
            allowLocalRepo: config.allowLocalRepo === true,
        });
    }
    // v2 写半侧：迁移门禁与同步周期只在这里挂一次；装配/启动失败不冒泡，v1 面不受影响。
    // 运行时不持有可卸载句柄，故不新增 ctx.effect（保持既有 effect 数量契约）。
    mountV2Sync(ctx, {
        homeDir: config.homeDir,
        allowLocalRepo: config.allowLocalRepo === true,
    }, false);
}
