import { createHttpHandler, createRpcService } from './rpc.js';
export const inject = ['webServer', 'connection'];
export const RPC_PATH = '/dsh-git-config-sync/rpc';
export function apply(ctx, config = {}) {
    const service = createRpcService({
        homeDir: config.homeDir,
        profileDir: config.profileDir,
        dshVersion: config.dshVersion,
        allowLocalRepo: config.allowLocalRepo === true,
    });
    const handler = createHttpHandler(service, ctx.connection);
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: RPC_PATH, handler }), 'dsh-git-config-sync: /dsh-git-config-sync/rpc');
    ctx.effect(() => () => {
        void service.dispose();
    }, 'dsh-git-config-sync: dispose rpc service');
}
