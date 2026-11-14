/**
 * DeepSeek 每日 AI 汇总（共享层，Android 与 HarmonyOS 都可用）。
 *
 * 契约（BRIEF §3.4、`docs/CONTRACT.md` §3.3）：
 * - 端点 `https://api.deepseek.com/chat/completions`，模型 `deepseek-chat`；
 * - `messages` 由 `buildAiPrompt` 产出（system 固定整理约束 + user 记录明细），
 *   提示词里已注入当前时间与时区；
 * - 解析 `choices[0].message.content`；
 * - 无 key / 网络失败 / 非 200 / 空内容一律抛**带中文 message** 的 `Error`，页面直接展示。
 */
import { http } from '@kit.NetworkKit';
import { buildAiPrompt } from '../model/aiPayload';
import type { AiPayload } from '../model/types';

const DEEPSEEK_ENDPOINT: string = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL: string = 'deepseek-chat';
const CONNECT_TIMEOUT_MS: number = 20000;
const READ_TIMEOUT_MS: number = 120000;

/** system 角色：只约束输出形态，不承载记录内容。 */
const SYSTEM_PROMPT: string =
  '你是日程助手的整理助手。只依据用户提供的记录归纳，用中文 Markdown 输出，不编造人名、时间或数字。';

interface DeepSeekMessage {
  role: string;
  content: string;
}

interface DeepSeekChoice {
  message: DeepSeekMessage;
  finish_reason?: string;
}

interface DeepSeekErrorBody {
  message?: string;
  type?: string;
  code?: string;
}

interface DeepSeekResponse {
  choices?: DeepSeekChoice[];
  error?: DeepSeekErrorBody;
}

/** 请求体（ArkTS 要求对象字面量有明确类型，故定义成类）。 */
class DeepSeekRequest {
  model: string = DEEPSEEK_MODEL;
  messages: DeepSeekMessage[] = [];
  temperature: number = 0.2;
  stream: boolean = false;
}

function describeError(error: object): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** 本机时区标签，形如 `UTC+08:00`（不依赖 Intl，鸿蒙/Android 一致）。 */
export function deviceTimeZone(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const hh = hours < 10 ? `0${hours}` : `${hours}`;
  const mm = minutes < 10 ? `0${minutes}` : `${minutes}`;
  return `UTC${sign}${hh}:${mm}`;
}

/** 从错误响应体里尽量取出可读原因。 */
function describeApiError(raw: string): string {
  if (raw.length === 0) {
    return '';
  }
  try {
    const parsed = JSON.parse(raw) as DeepSeekResponse;
    if (parsed.error !== undefined && typeof parsed.error.message === 'string') {
      return `：${parsed.error.message}`;
    }
  } catch {
    // 非 JSON 响应体，下面按原文截断展示
  }
  const snippet = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return `：${snippet}`;
}

/**
 * 对一份 AI 载荷做整理，返回 Markdown 摘要正文。
 *
 * @param payload 由 `buildAiPayload` 生成的载荷（只含当天未处理记录）
 * @param apiKey DeepSeek API key（设置页填写）
 * @param nowIso 当前时间（注入提示词）
 * @param timeZone 时区标签（通常用 `deviceTimeZone()`）
 */
export async function summarize(
  payload: AiPayload,
  apiKey: string,
  nowIso: string,
  timeZone: string
): Promise<string> {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length === 0) {
    throw new Error('未设置 DeepSeek API Key，请先在设置页填写');
  }
  if (payload.records.length === 0) {
    throw new Error('当天没有需要 AI 整理的记录');
  }

  const prompt = buildAiPrompt(payload, nowIso, timeZone);
  const requestBody = new DeepSeekRequest();
  requestBody.messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt }
  ];

  const httpRequest = http.createHttp();
  try {
    const response = await httpRequest.request(DEEPSEEK_ENDPOINT, {
      method: http.RequestMethod.POST,
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      extraData: JSON.stringify(requestBody),
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: READ_TIMEOUT_MS
    });

    const status: number = response.responseCode;
    const raw: string = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
    if (status !== 200) {
      throw new Error(`DeepSeek 接口返回 HTTP ${status}${describeApiError(raw)}`);
    }

    let parsed: DeepSeekResponse;
    try {
      parsed = JSON.parse(raw) as DeepSeekResponse;
    } catch (error) {
      throw new Error(`DeepSeek 返回内容不是合法 JSON：${describeError(error)}`);
    }

    const choices = parsed.choices;
    if (choices === undefined || choices.length === 0) {
      throw new Error(`DeepSeek 返回内容为空（缺少 choices）${describeApiError(raw)}`);
    }
    const content = choices[0].message.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('DeepSeek 返回内容为空（content 为空）');
    }
    return content.trim();
  } catch (error) {
    if (error instanceof Error) {
      const message = error.message;
      if (
        message.startsWith('DeepSeek') ||
        message.startsWith('未设置') ||
        message.startsWith('当天没有')
      ) {
        throw error;
      }
    }
    throw new Error(`DeepSeek 请求失败（请检查网络与 API Key）：${describeError(error)}`);
  } finally {
    httpRequest.destroy();
  }
}
