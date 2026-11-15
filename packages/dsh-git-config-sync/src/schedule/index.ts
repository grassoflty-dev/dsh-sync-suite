/**
 * 日程桥（PC 侧）公开出口。
 *
 * 模块分层（详见 `docs/SCHEDULE-BRIDGE.md`）：
 *   types.ts     —— 与 App 共用的数据形状（JSONL / AI 载荷 / 工具返回值）
 *   clock.ts     —— id 与时间生成（逐字符对齐 App，折叠键必须同形）
 *   jsonl.ts     —— JSONL 编解码与折叠（只追加、同 id 取较晚 ts）
 *   paths.ts     —— 路径构造与越界防护（只允许 devices/<本机>/schedules/）
 *   aiPayload.ts —— 每日汇总载荷与提示词（照搬 App 契约）
 *   aiRequest.ts —— OpenAI 兼容请求与错误文案（Node 侧，零依赖 fetch）
 *   bridge.ts    —— Git 工作副本 + 读/写/汇总的实现
 *   tools.ts     —— 注册给模型的三个工具
 */
export * from './types.js'
export * from './clock.js'
export * from './jsonl.js'
export * from './paths.js'
export * from './aiPayload.js'
export * from './aiRequest.js'
export * from './bridge.js'
export * from './tools.js'
