/**
 * 配对可达性探针的**纯决策层**（mod-pairing-reachability）——零 SDK import，Node 可直接单测。
 *
 * 为什么要有这一层：配对曾经是「本地写一行 + 弹『配对成功』」，电脑监听器停了照样报成功，
 * 用户点「打开」才知道连不上。现在配对路径必须先做一次真实短超时探测，只有探测通过
 * 才允许把实例写成 healthy 行（并把证书指纹钉住）；失败一律 typed 拒绝、整表零写入。
 *
 * 本文件只决定「探测结果 → typed 码 + 固定中文文案」，真正的网络 I/O 由
 * `services/pairingProbeService.ets` 注入（唯一 @kit.NetworkKit 出口）。这样：
 * - 纯模型可以用假 transport 做 OK / 拒绝 / 超时 / TLS 冲突四种用例；
 * - 传输层的异常 / 超时收敛成 status，绝不把原生 error 文本回显到 UI。
 *
 * 纪律：
 * 1. token / host / 指纹的值**永不进错误文案**；只有端口号按需求点名。
 * 2. 硬超时上限 3000 ms，并原样交给 transport 落实（SDK 级 timeout + 应用层 watchdog）。
 * 3. **可达性（TCP）≠ 配对真实性（TLS 指纹）**：本探针只证明「host:port 有东西在听」，
 *    属于传输层可达性；「对面确实是配对串里的那台机器」是身份真实性，必须由 TLS lane
 *    的握手 + 叶证书指纹比对来判定，**不在这里**。所以本文件既不实现也不声称做了身份校验；
 *    配对真实性由 TLS 模块 gate，未接入前任何成功文案都只能说「地址可达，尚未校验证书」。
 * 4. 因为不做 socket 错误码判别，任何 SDK 拒绝（ECONNREFUSED / DNS 失败 / 网络不可达）
 *    都落进 `unreachable` 中性类，文案写「连接被拒绝或地址不可达」，绝不单独断言「被拒绝」；
 *    只有应用层 watchdog 先到时才计入 `timeout`，用专属「连接超时」文案。
 */

/** 硬超时上限（毫秒）：≤ 3 s，防止坏地址把配对按钮卡住。 */
export const PAIRING_PROBE_TIMEOUT_MS: number = 3000;

/**
 * 当前实现的探测模式。今天只有 `tcp`；等 TLS 握手链路接通再改 `tls`，
 * 那时叶证书指纹必须等于载荷里的 `tlsFingerprint`，否则判 `E_PAIRING_TLS_MISMATCH`。
 */
export const PAIRING_PROBE_MODE: 'tcp' | 'tls' = 'tcp';

/**
 * transport 的归一化结果；未知字符串在纯决策层一律失败关闭为 `unreachable`。
 * `unreachable` = **未分类的连接失败**（拒绝 / DNS 失败 / 路由不可达都在这里），不是「已确认被拒绝」。
 */
export type PairingProbeStatus = 'ok' | 'unreachable' | 'timeout' | 'tls-mismatch';

/** 探针侧 typed 码（与 `pairingPayload.ts` 的 `PairingErrorCode` 同心）。 */
export type PairingProbeErrorCode = 'E_PAIRING_UNREACHABLE' | 'E_PAIRING_TLS_MISMATCH';

/** transport 返回的事实：只有 status，绝不带原生错误文本 / 地址 / 令牌。 */
export interface PairingProbeTransportResult {
  status: PairingProbeStatus;
}

/**
 * 注入的探测函数：真实 app 侧由 `services/pairingProbeService.ets` 绑定 @kit.NetworkKit；
 * 单测里是返回固定 status 的假函数。调用方承诺 timeoutMs 不超过 PAIRING_PROBE_TIMEOUT_MS。
 */
export type PairingProbeTransport = (
  host: string,
  port: number,
  timeoutMs: number
) => Promise<PairingProbeTransportResult>;

/** 指纹不一致的逐字上屏文案（TLS 握手接入后生效；当前为预留接缝）。 */
export const PAIRING_TLS_MISMATCH_WORDING: string =
  '证书指纹不匹配：对端证书与配对串中的指纹不同，请重新核对配对串';

/**
 * 连接失败的逐字文案：点名端口，方便用户核对电脑监听器配置；
 * 不回显 host / token / 指纹（bearer secret 纪律）。
 *
 * - `timeout`：只有应用层 watchdog 先到才用，可确定是超时；
 * - 其它一律是**未分类失败**：没有 socket 错误码判别，不能只说「被拒绝」（DNS 失败也会落这里），
 *   所以用中性文案「连接被拒绝或地址不可达」。
 */
export function pairingUnreachableWording(status: string, port: number): string {
  const shown: string = Number.isInteger(port) && port > 0 && port <= 65535 ? String(port) : '?';
  if (status === 'timeout') {
    return `无法连接到该地址：连接超时（${shown}）`;
  }
  return `无法连接到该地址（${shown}）：连接被拒绝或地址不可达`;
}

/** 成功 / 失败同形的结果；失败分支的 code 被 TS 收窄为 typed 错误码。 */
export type PairingProbeResult =
  | {
    ok: true;
    code: 'ok';
    reason: string;
    status: 'ok';
    fingerprintVerified: boolean;
  }
  | {
    ok: false;
    code: PairingProbeErrorCode;
    reason: string;
    status: PairingProbeStatus;
    fingerprintVerified: boolean;
  };

/**
 * 探测一次并把原生世界的意外收敛成 typed 结果。
 * - transport 抛错 / abort / 返回未知 status ⇒ unreachable（未分类失败，失败关闭，绝不误判为可达）；
 * - timeout 与 unreachable 共用 E_PAIRING_UNREACHABLE，但文案逐字区分（超时是确证，其余是中性类）；
 * - tls-mismatch 独立成码，留给 TLS 握手接入后的指纹比对；
 * - 成功也只是「地址可达」这一传输层事实，不代表身份真实性 —— 后者由 TLS 模块 gate。
 */
export async function probePairingTarget(
  host: string,
  port: number,
  expectedFingerprint: string,
  transport: PairingProbeTransport,
  timeoutMs: number = PAIRING_PROBE_TIMEOUT_MS
): Promise<PairingProbeResult> {
  const limit: number =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, PAIRING_PROBE_TIMEOUT_MS)
      : PAIRING_PROBE_TIMEOUT_MS;

  let status: PairingProbeStatus = 'unreachable';
  try {
    const response: PairingProbeTransportResult = await transport(host, port, limit);
    const raw: string = response === null || response === undefined ? '' : response.status;
    if (raw === 'ok' || raw === 'unreachable' || raw === 'timeout' || raw === 'tls-mismatch') {
      status = raw;
    }
  } catch (error) {
    // 原生 socket 异常 / DNS 失败 / abort 一律落中性 unreachable：不分类、不回显原生错误文本。
    void error;
    status = 'unreachable';
  }

  // 当前模式只做 TCP connect：指纹随载荷落表保存，但**不比对、不回显**。
  // TLS lane 接通握手后，在 transport 里比对叶证书指纹并给出 tls-mismatch，届时再把
  // fingerprintVerified 改成真实比对结果；今天恒 false，不撒「已校验证书」的谎。
  void expectedFingerprint;
  const fingerprintVerified: boolean = false;

  if (status === 'ok') {
    return {
      ok: true, code: 'ok', reason: '', status: 'ok', fingerprintVerified: fingerprintVerified
    };
  }
  if (status === 'tls-mismatch') {
    return {
      ok: false,
      code: 'E_PAIRING_TLS_MISMATCH',
      reason: PAIRING_TLS_MISMATCH_WORDING,
      status: status,
      fingerprintVerified: fingerprintVerified
    };
  }
  return {
    ok: false,
    code: 'E_PAIRING_UNREACHABLE',
    reason: pairingUnreachableWording(status, port),
    status: status,
    fingerprintVerified: fingerprintVerified
  };
}
