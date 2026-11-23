/**
 * mod-remote-pinned-client：RC-3 真机门禁 harness —— **仅 debug 构建可达**。
 *
 * 暴露边界（Lead 直接可用，不面向普通用户）：
 * - 只有 `BuildProfile.DEBUG === true` 且 router 参数 `rc3Gate=1` 才挂 UI；router 参数不是
 *   访问边界，真正的开关是编译期常量 DEBUG，release 构建会把它折成 false 并把本模块摇掉。
 * - `PIN-ATTACK-01` 是本 harness 唯一 sentinel：release-exclusion 检查断言 release 的
 *   modules.abc 不含这个字符串（见 tools/check-rc3-release-exclusion.mjs）。
 * - 只接受白名单里的受控 HTTPS 端点；只接受本 harness 生成的合成凭证；本文件**不 import
 *   settingsStore**、不读用户 token / ~/.dsh/dots/**，也不回显任何响应正文。
 *
 * 门禁顺序（不可跳过）：先无凭证观察（回调是否触发、证书两种表示的形状与摘要是否一致），
 * 再在观察证据证明 leaf 身份且 debug harness 显式确认后，才允许带合成凭证请求。
 */
import BuildProfile from 'BuildProfile';
import { http } from '@kit.NetworkKit';
import {
  canRunCredentialPhase,
  classifyGateCredential,
  emptyObservation,
  formatGateCounts,
  isAllowedGateEndpoint,
  leafOrderEvidence,
  normalizeGateExpectedPin,
  GATE_ROUTE_VALUE
} from '../model/rc3GateHarness';
import type { GateCounts, GateObservation } from '../model/rc3GateHarness';
import { sha256Hex as pureSha256Hex } from '../model/sha256';
import {
  collectLeafCandidates,
  leafChainShape,
  requestCredentialedData,
  requestWithValidation
} from './remotePinnedClient';

/** release-exclusion sentinel：全仓库只有本文件含有这个字面量。 */
const RC3_GATE_SENTINEL: string = 'PIN-ATTACK-01';

/** 观察阶段只写这里；摘要以外不保留任何证书/响应内容。 */
let observation: GateObservation = emptyObservation();
let observedEndpoint: string = '';
let observationSequence: number = 0;

/** debug 构建 + router 参数双闸；release 下 DEBUG 折成 false。 */
export function rc3GateActive(routeFlag: string): boolean {
  return BuildProfile.DEBUG === true && routeFlag === GATE_ROUTE_VALUE;
}

/** 让 UI 能显示 sentinel 举证（不是凭证）。 */
export function rc3GateSentinel(): string {
  return RC3_GATE_SENTINEL;
}

/** 第一步：无凭证观察。返回只含计数与 typed 结论的中文串，绝不回显 URL/证书/凭证。 */
export async function observeGateEndpoint(url: string): Promise<string> {
  const sequence: number = ++observationSequence;
  observedEndpoint = '';
  observation = emptyObservation();
  if (!isAllowedGateEndpoint(url)) {
    return 'E_GATE_ENDPOINT_NOT_ALLOWED：受控端点不在白名单内，已拒绝';
  }
  const current: GateObservation = emptyObservation();
  try {
    await requestWithValidation(url, async (context: http.ValidationContext): Promise<boolean> => {
      current.callbackFired = true;
      current.host = context.host;
      current.ip = context.ip;
      const shape = leafChainShape(context);
      current.x509Count = shape.x509Count;
      current.pemCount = shape.pemCount;
      for (const leaf of collectLeafCandidates(context)) {
        // 只保留摘要；PEM / DER / 响应正文一个都不留存、不上屏。
        current.leafDigests.push(sha256Of(leaf.der));
      }
      return false; // 观察请求必须在凭证写出前失败
    });
  } catch (error) {
    void error;
  }
  if (sequence !== observationSequence) {
    return '这次观察已被更新的请求替代';
  }
  observation = current;
  observedEndpoint = url;
  if (!observation.callbackFired) {
    return 'E_API_UNSUPPORTED：校验回调未触发，设备不支持或时机不符，门禁不能继续';
  }
  const verdict: string = leafOrderEvidence(observation);
  return `观察完成（无凭证）：回调已触发；x509Certs=${observation.x509Count} 项，pemCerts=${observation.pemCount} 项，leaf 候选摘要=${observation.leafDigests.length} 条；leaf 顺序证据=${verdict}`;
}

/** 第二步：仅在观察已证明 leaf 身份、且 debug harness 显式确认后，用合成凭证请求。 */
export async function runGateWithSyntheticCredential(
  url: string,
  credential: string,
  confirmationInDebugHarness: boolean,
  expectedPinInput: string
): Promise<string> {
  if (!isAllowedGateEndpoint(url)) {
    return 'E_GATE_ENDPOINT_NOT_ALLOWED：受控端点不在白名单内，已拒绝';
  }
  if (classifyGateCredential(credential) !== 'synthetic') {
    return 'E_GATE_CREDENTIAL：只接受本 harness 生成的合成凭证，已拒绝';
  }
  const expectedPin: string = normalizeGateExpectedPin(expectedPinInput);
  if (expectedPin.length === 0) {
    return 'E_NO_PIN：请先填写从受控测试服务独立取得的证书指纹';
  }
  if (observedEndpoint !== url || !canRunCredentialPhase('credentials', observation, confirmationInDebugHarness)) {
    return 'E_LEAF_ORDER_UNPROVEN：观察证据未证明 leaf 身份，禁止带凭证请求；门禁不能通过';
  }
  const result = await requestCredentialedData({
    url: url,
    host: observation.host,
    authorization: credential,
    expectedPin: expectedPin,
    expectedIp: observation.ip,
    leafOrderProven: true
  });
  if (result.disposition.kind === 'ok') {
    return '请求完成：匹配 pin 的合成凭证请求已发出（服务端计数请按门禁表填写）';
  }
  return `请求被拒绝：${result.disposition.refusal.code}（${result.disposition.refusal.message}）`;
}

/** 计数格式化只接受数字，绝不接收 token 值。 */
export function formatServerCounts(authCount: number, destinationRequestCount: number): string {
  const counts: GateCounts = { authCount: authCount, destinationRequestCount: destinationRequestCount };
  return formatGateCounts(counts);
}

/** 用纯 TS SHA-256 摘出候选摘要；不引入任何 SDK 摘要 API。 */
function sha256Of(der: Uint8Array): string {
  // 延迟实现避免与 model/sha256 的循环依赖：直接调用纯函数。
  return pureSha256Hex(der);
}
