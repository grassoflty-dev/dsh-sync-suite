/**
 * 配对可达性探针的**真实网络出口**（mod-pairing-reachability）。
 *
 * 契约（与 `model/repoVisibilityChecker` / `model/pairingProbe.ts` 同构：纯模型 + 薄传输）：
 * - 只做一次 **TCP connect**：证明 `host:port` 真的有监听器在听。配对不再「写一行就说成功」；
 * - 双层超时：socket 自带 `timeout` + 应用层 watchdog，上限 3000 ms；
 * - 全程 Promise / 回调，**绝不在 UI 线程同步等待**；
 * - 异常 / 未知错误一律收敛成中性 `unreachable`（没有错误码判别，不单独断言「被拒绝」），
 *   原生错误文本、host、token、指纹都不回显；
 * - **可达性（TCP）≠ 配对真实性（TLS 指纹）**：这里只证明「host:port 有人听」，
 *   不校验证书指纹：当前 TCP 模式下指纹随载荷落表保存但不比对；握手 + 叶证书指纹
 *   校验由 TLS lane gate（本文件不碰 `RemoteControl.ets` / `tlsPin.ts`）。
 *
 * IPv6 载荷在配对模型里是 `[2001:db8::1]` 形态：这里去掉方括号并把 family 设为 2；
 * Tailscale 魔法域名 / 主机名交给系统解析，family 保持 1。
 */
import { socket } from '@kit.NetworkKit';
import { PAIRING_PROBE_TIMEOUT_MS } from '../model/pairingProbe';
import type {
  PairingProbeStatus,
  PairingProbeTransportResult
} from '../model/pairingProbe';

/** 最大超时上限的保守下界：坏调用也不允许退化成 0（0 在部分 SDK 上等于「无限等」）。 */
const MIN_PROBE_TIMEOUT_MS: number = 1;

/**
 * 真 TCP 探针，可直接作为 `PairingProbeTransport` 传给纯模型。
 * 只返回 status 事实，不把 socket 错误对象 / 地址 / 载荷带出本文件。
 */
export function tcpConnectProbe(
  host: string,
  port: number,
  timeoutMs: number
): Promise<PairingProbeTransportResult> {
  const limit: number =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(Math.max(timeoutMs, MIN_PROBE_TIMEOUT_MS), PAIRING_PROBE_TIMEOUT_MS)
      : PAIRING_PROBE_TIMEOUT_MS;
  const inner: string = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, host.length - 1)
    : host;
  const family: number = inner.indexOf(':') >= 0 ? 2 : 1;

  return new Promise<PairingProbeTransportResult>((
    resolve: (value: PairingProbeTransportResult) => void
  ): void => {
    // socket 构造失败时 Promise 自动 reject，纯模型会把它收敛为 E_PAIRING_UNREACHABLE。
    const client = socket.constructTCPSocketInstance();
    let settled: boolean = false;
    let timer: number = 0;

    const settle = (status: PairingProbeStatus): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== 0) {
        clearTimeout(timer);
      }
      resolve({ status: status });
      // 连上 / 拒绝 / 超时都要关句柄；未连接时 close 可能抛错，吞掉即可（不打印）。
      try {
        client.close().catch((): void => {
          // 已关闭 / 从未连上：忽略
        });
      } catch (error) {
        void error;
      }
    };

    // 应用层 watchdog：SDK 若没有按时回调，也必须让配对按钮在 ≤ 3 s 内回来。
    timer = setTimeout((): void => {
      settle('timeout');
    }, limit);

    const connecting: Promise<void> = client.connect({
      address: { address: inner, family: family, port: port },
      timeout: limit
    });
    connecting
      .then((): void => {
        settle('ok');
      })
      .catch((): void => {
        // 没有 socket 错误码判别：ECONNREFUSED / DNS 失败 / 网络不可达一律落中性
        // unreachable，文案写「连接被拒绝或地址不可达」，不单独断言「被拒绝」。
        settle('unreachable');
      });
  });
}
