/**
 * mod-remote-pinned-client（RC-3 核心）：唯一带凭证网络出口 + 握手期 leaf pin 回调。
 *
 * 为什么离开 WebView（SDK spike 结论 PIN-VIA-PINNED-CLIENT）：
 * ArkWeb 只能在 SSL 出错后回调，无法在「真正承载 bearer 的那条 TLS 连接」握手期按连接拒绝；
 * NetworkKit 的 http.HttpRequestOptions.remoteValidation（SDK ets/api/@ohos.net.http.d.ts:353）
 * 让同一条带凭证请求自带 ValidationCallback，返回 false 即在写 Authorization 之前失败（2300060）。
 *
 * 不跟随重定向（Lead 2026-11-22 纠正）：事后检查 3xx 不是 fail-closed，因为库可能已经跟了。
 * SDK 在 ets/api/@ohos.net.http.d.ts:400 提供 `maxRedirects`，:390-395 明写
 * 「0 = redirection disabled」，所以这里固定 `maxRedirects: 0`（SDK 级 no-follow），
 * 另在 model 的 classifyPinnedResponse 里把任何 3xx 当拒绝，作为第二道闸。
 *
 * 本文件不打印 token / PEM / 证书内容；错误只带 typed code 与数字错误码。
 * 设备/API 能力、回调时机、链首顺序仍属 SDK 未定义，必须由真机门禁证明（见交付报告）。
 */
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  buildPinnedRequestPlan,
  executePinnedRequest,
  pemToDer,
  verifyLeafPin
} from '../model/remotePinnedClient';
import type {
  CredentialedRequest,
  LeafCandidate,
  LeafChainShape,
  PinnedExecution,
  PinnedRefusal,
  PinnedRequestPlan,
  PinnedTransportResponse
} from '../model/remotePinnedClient';
import { PIN_REFUSAL_WORDING } from '../model/remotePinnedClient';

/** 单条请求的超时（ms）：远程控制页不该长时间挂住用户。 */
const PINNED_TIMEOUT_MS: number = 8000;

/**
 * 从回调上下文摘出可 hash 的 leaf 候选：**只用 PEM 路径**。
 *
 * 为什么不用 x509Certs[0].getEncoded()：SDK cert.X509Cert.getEncoded() 只有
 * Promise<EncodingBlob> 形式（@ohos.security.cert.d.ts:673）；同步形式 (:1213) 属于
 * CertExtension 而非证书，而 ValidationCallback 必须同步判定，不能在回调里 await。
 * x509Certs 因此只作为形状/歧义信号（条数），不作为字节来源；字节一律来自 pemCerts[0]。
 */
export function collectLeafCandidates(context: http.ValidationContext): LeafCandidate[] {
  const leaves: LeafCandidate[] = [];
  const pemCerts: string[] = context.pemCerts;
  if (Array.isArray(pemCerts) && pemCerts.length === 1) {
    const der: Uint8Array | null = pemToDer(pemCerts[0]);
    if (der !== null && der.length > 0) {
      leaves.push({ der: der, source: 'pem' });
    }
  }
  return leaves;
}

/** 链的形状信号：x509 不能提供同步字节，只用来识别「多证书/歧义」。 */
export function leafChainShape(context: http.ValidationContext): LeafChainShape {
  const x509Certs = context.x509Certs;
  const pemCerts: string[] = context.pemCerts;
  return {
    x509Count: Array.isArray(x509Certs) ? x509Certs.length : 0,
    pemCount: Array.isArray(pemCerts) ? pemCerts.length : 0
  };
}

/**
 * 握手期回调本身：host / 可选 ip → leaf DER → SHA-256 → 恒定时间比较。
 *
 * 任何异常、空链、两种表示矛盾、链首顺序未真机证实都返回 false（fail closed）。
 * 绝不使用 WebView 的 SSL 错误处理放行接口——本模块没有 WebView handler。
 */
export async function verifyPinnedLeaf(
  context: http.ValidationContext,
  expectedPin: string,
  expectedHost: string,
  expectedIp: string,
  leafOrderProven: boolean
): Promise<boolean> {
  try {
    if (context === null || context === undefined) {
      return false;
    }
    const outcome = verifyLeafPin({
      host: context.host,
      ip: context.ip,
      expectedHost: expectedHost,
      expectedIp: expectedIp,
      expectedPin: expectedPin,
      leaves: collectLeafCandidates(context),
      chainShape: leafChainShape(context),
      leafOrderProven: leafOrderProven
    });
    return outcome.ok;
  } catch (error) {
    void error; // 不打印：可能带 URL / 证书 / 凭证
    return false;
  }
}

/** 适配层内部传给 transport 的 options：header 仍只有凭证载体，validation 是真实函数。 */
interface PinnedHttpOptions {
  header: Record<string, string>;
  validation: http.ValidationCallback;
}

/**
 * 唯一请求构造点：每个带凭证请求新建一个 http.createHttp() 实例，用完 destroy。
 * 绝不复用无凭证 preflight 的连接/会话；绝不把凭证拼进 URL。
 */
class PinnedHttpTransport {
  async request(url: string, options: PinnedHttpOptions): Promise<PinnedTransportResponse> {
    const request: http.HttpRequest = http.createHttp();
    try {
      const httpOptions: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: options.header,
        maxRedirects: 0,
        usingProxy: false,
        remoteValidation: options.validation,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: PINNED_TIMEOUT_MS,
        readTimeout: PINNED_TIMEOUT_MS
      };
      const response: http.HttpResponse = await request.request(url, httpOptions);
      const headers: Record<string, string> = response.header as Record<string, string>;
      let location: string = '';
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'location') {
          location = headers[key];
          break;
        }
      }
      const raw: Object = response.result as Object;
      return {
        responseCode: response.responseCode,
        location: location,
        body: typeof raw === 'string' ? raw : '',
        errorCode: 0
      };
    } catch (error) {
      // 只取数字码，不取 message（可能含带 token 的 URL）；未知错误用 -1 占位。
      const codeValue: number = (error as BusinessError).code;
      const code: number = typeof codeValue === 'number' ? codeValue : -1;
      return { responseCode: 0, location: '', body: '', errorCode: code };
    } finally {
      try {
        request.destroy();
      } catch (error) {
        void error;
      }
    }
  }
}

/**
 * debug harness 的**无凭证观察**出口：用同一个唯一请求构造点，header 为空。
 * 返回的 callback 由 harness 提供；本函数不打印、不记录任何响应内容。
 */
export async function requestWithValidation(
  url: string,
  validation: http.ValidationCallback
): Promise<PinnedTransportResponse> {
  const transport: PinnedHttpTransport = new PinnedHttpTransport();
  const emptyHeader: Record<string, string> = {};
  return await transport.request(url, { header: emptyHeader, validation: validation });
}

/** 对外结果：与纯模型同构，UI 只看 disposition 与固定的 refusal.message。 */
export async function requestCredentialedData(req: CredentialedRequest): Promise<PinnedExecution> {
  const plan: PinnedRequestPlan = buildPinnedRequestPlan(req);
  const transport: PinnedHttpTransport = new PinnedHttpTransport();
  let callbackInvoked: boolean = false;
  const validation: http.ValidationCallback = async (context: http.ValidationContext): Promise<boolean> => {
    callbackInvoked = true;
    return await verifyPinnedLeaf(
      context, plan.expectedPin, plan.host, plan.expectedIp, plan.leafOrderProven
    );
  };
  const execution: PinnedExecution = await executePinnedRequest(plan, {
    request: async (url: string): Promise<PinnedTransportResponse> => {
      return await transport.request(url, { header: plan.options.header, validation: validation });
    }
  });
  // 平台若静默忽略 remoteValidation（API 不支持），200 也不能算通过：fail closed。
  if (execution.disposition.kind === 'ok' && !callbackInvoked) {
    const refusal: PinnedRefusal = {
      code: 'E_API_UNSUPPORTED',
      message: PIN_REFUSAL_WORDING['E_API_UNSUPPORTED']
    };
    return { disposition: { kind: 'refused', refusal: refusal }, requestCount: execution.requestCount };
  }
  return execution;
}
