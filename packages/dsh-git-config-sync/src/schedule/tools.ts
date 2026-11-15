/**
 * 模型侧工具：`schedule_list` / `schedule_add` / `schedule_summary`。
 *
 * 注册方式：宿主 `ctx.tools.register(definition)`（Cordis `tools` 服务）。
 * 这里**直接给注册表要求的原始定义**（`{name, description, parameters, output:{schema,render}, execute}`），
 * 不 import `@deepseek-ai/dsh-tools` 的 `defineTool`：它只是把作者侧 DSL 编译成 JSON Schema
 * 并加一层入参校验的语法糖，而本插件按仓库纪律"运行时零 npm 依赖"，且注册表本身只校验
 * `name` 与 `output.{schema,render}`（见 `@deepseek-ai/dsh-tools` 的 `ToolsService.register`）。
 *
 * 参数与返回值都用**标准 JSON Schema**，模型看到的就是这份 schema。
 */
import { SettingsStore } from '../engine/settings.js'
import type { StatePaths } from '../engine/paths.js'
import { SyncError, errorMessage } from '../engine/errors.js'
import { formatClock } from './clock.js'
import { ALL_DEVICES, withScheduleBridge } from './bridge.js'
import type {
  ListSchedulesResult,
  ScheduleAiOptions,
  ScheduleBridge,
  ScheduleWorkspaceOptions,
} from './bridge.js'
import type { AddScheduleResult, SummaryResult } from './types.js'

/** 工具定义（与 `ctx.tools.register` 接受的形状一致）。 */
export interface ScheduleToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  timeoutMs: number
  execute: (args: unknown) => Promise<unknown>
}

/** 宿主 `tools` 服务的最小形状（只需要 `register`）。 */
export interface ToolsServiceLike {
  register(definition: ScheduleToolDefinition): unknown
}

export interface ScheduleToolHostContext {
  tools: ToolsServiceLike
  effect?: (effect: () => (() => void) | void, label?: string) => unknown
}

export interface ScheduleToolOptions {
  paths: StatePaths
  allowLocalRepo?: boolean
  now?: () => Date
  networkTimeoutMs?: number
  /** 覆盖 AI 配置（缺省读环境变量）。 */
  ai?: ScheduleAiOptions
}

function text(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
}

function argsString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** 每次执行都重新读设置：设置页改完仓库/设备标识，下一次工具调用立即生效。 */
async function withBridgeForTool<T>(
  options: ScheduleToolOptions,
  task: (bridge: ScheduleBridge, today: string) => Promise<T>,
): Promise<T> {
  const store = new SettingsStore(options.paths, { allowLocalRepo: options.allowLocalRepo === true })
  const settings = store.readSettings()
  const token = store.readToken()
  const workspace: ScheduleWorkspaceOptions = {
    paths: options.paths,
    ...(options.allowLocalRepo === true ? { allowLocalRepo: true } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.networkTimeoutMs !== undefined ? { networkTimeoutMs: options.networkTimeoutMs } : {}),
    ...(options.ai !== undefined ? { ai: options.ai } : {}),
  }
  return withScheduleBridge(workspace, settings, token, async (bridge) => task(bridge, bridge.today()))
}

/**
 * 递归补齐 `additionalProperties`：宿主的 `assertSupportedJsonSchema` 要求 object 节点
 * **显式**声明 `additionalProperties: true|false`，缺省会被判为 unsupported（注册直接失败）。
 *
 * 统一取 `true`：返回值多带一个字段（或模型多传一个参数）不该让调用失败。
 */
export function sealToolSchema(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((item) => sealToolSchema(item))
  const record = node as Record<string, unknown>
  const sealed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const properties: Record<string, unknown> = {}
      for (const [name, schema] of Object.entries(value as Record<string, unknown>)) {
        properties[name] = sealToolSchema(schema)
      }
      sealed.properties = properties
      continue
    }
    if (key === 'items') {
      sealed.items = sealToolSchema(value)
      continue
    }
    sealed[key] = value
  }
  if (sealed.type === 'object' && sealed.additionalProperties === undefined) sealed.additionalProperties = true
  return sealed
}

/** 补齐一份工具定义里的 `parameters` 与 `output.schema`。 */
function sealToolDefinition(definition: ScheduleToolDefinition): ScheduleToolDefinition {
  return {
    ...definition,
    parameters: sealToolSchema(definition.parameters) as Record<string, unknown>,
    output: {
      ...definition.output,
      schema: sealToolSchema(definition.output.schema) as Record<string, unknown>,
    },
  }
}

/** `schedule_list` 的定义。 */
function scheduleListTool(options: ScheduleToolOptions): ScheduleToolDefinition {
  return {
    name: 'schedule_list',
    description:
      '列出某天的日程（跨设备按 id 折叠，同一 id 取较晚的记录）。默认今天、只看本机设备；' +
      `deviceId 传 "${ALL_DEVICES}" 可看仓库里所有设备的日程（含平板手写录入的记录）。` +
      '只读：会先尽力从远端拉取最新提交，拉取失败时返回本地副本并给出 note。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD（设备本地日期）；省略表示今天' },
        deviceId: { type: 'string', description: `设备目录名，或 "${ALL_DEVICES}"（全部设备）；省略表示本机` },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          deviceIds: { type: 'array', items: { type: 'string' } },
          refreshed: { type: 'boolean' },
          note: { type: 'string' },
          errors: { type: 'array', items: { type: 'string' } },
          records: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                ts: { type: 'string' },
                date: { type: 'string' },
                deviceId: { type: 'string' },
                title: { type: 'string' },
                author: { type: 'string' },
                done: { type: 'boolean' },
                bodyPreview: { type: 'string' },
                bodyLength: { type: 'integer' },
                hasAttachments: { type: 'boolean' },
                aiProcessed: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => text(renderList(value as ListSchedulesResult)),
    },
    timeoutMs: 60_000,
    async execute(rawArgs) {
      const args = argsRecord(rawArgs)
      const date = argsString(args, 'date')
      const deviceId = argsString(args, 'deviceId')
      return withBridgeForTool(options, async (bridge, today) => {
        const day = date === '' ? today : date
        return bridge.list(deviceId === '' ? bridge.deviceId : deviceId, day)
      })
    },
  }
}

/** `schedule_add` 的定义。 */
function scheduleAddTool(options: ScheduleToolOptions): ScheduleToolDefinition {
  return {
    name: 'schedule_add',
    description:
      '在本机设备目录下新建一条日程（追加一行 JSONL，不重写历史行），然后提交并推送到同一个 Git 仓库，' +
      '平板打开 App 同步后即可看到。写入前先 pull --rebase，遇到冲突会中止并报错（不会覆盖任何一方的记录）。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD（设备本地日期）；省略表示今天' },
        title: { type: 'string', description: '标题（必填）' },
        body: { type: 'string', description: '正文，可为空' },
        author: { type: 'string', description: '记录者，缺省「我」' },
      },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ts: { type: 'string' },
          date: { type: 'string' },
          deviceId: { type: 'string' },
          path: { type: 'string' },
          commit: { type: 'string' },
          pushed: { type: 'boolean' },
          rebased: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => text(renderAdd(value as AddScheduleResult)),
    },
    timeoutMs: 60_000,
    async execute(rawArgs) {
      const args = argsRecord(rawArgs)
      const date = argsString(args, 'date')
      const title = argsString(args, 'title')
      if (title === '') throw new SyncError('E_VALIDATION', 'title 不能为空')
      const body = argsString(args, 'body')
      const author = argsString(args, 'author')
      return withBridgeForTool(options, async (bridge, today) => {
        const day = date === '' ? today : date
        return bridge.add(bridge.deviceId, day, {
          title,
          ...(body !== '' ? { body } : {}),
          ...(author !== '' ? { author } : {}),
        })
      })
    },
  }
}

/** `schedule_summary` 的定义。 */
function scheduleSummaryTool(options: ScheduleToolOptions): ScheduleToolDefinition {
  return {
    name: 'schedule_summary',
    description:
      '把某天的日程记录拼成 AI 载荷与提示词（与平板 App 的每日汇总同一契约：只取当天记录、' +
      'text 优先取 body、为空退回 ocr_text）。配置了 AI 密钥时直接返回模型摘要；未配置时返回 payload 与 prompt，' +
      '调用方可以自己完成汇总。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD（设备本地日期）；省略表示今天' },
        deviceId: { type: 'string', description: `设备目录名，或 "${ALL_DEVICES}"；省略表示本机` },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          deviceIds: { type: 'array', items: { type: 'string' } },
          count: { type: 'integer' },
          refreshed: { type: 'boolean' },
          note: { type: 'string' },
          aiNote: { type: 'string' },
          summary: { type: 'string' },
          prompt: { type: 'string' },
          payload: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              records: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    ocr_time: { type: 'string' },
                    text: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => text(renderSummary(value as SummaryResult)),
    },
    timeoutMs: 90_000,
    async execute(rawArgs) {
      const args = argsRecord(rawArgs)
      const date = argsString(args, 'date')
      const deviceId = argsString(args, 'deviceId')
      return withBridgeForTool(options, async (bridge, today) => {
        const day = date === '' ? today : date
        const result = await bridge.summary(deviceId === '' ? bridge.deviceId : deviceId, day)
        // 工具返回值里 `summary: ''` 表示没有 AI 正文（原因见 aiNote），schema 里保持 string。
        return { ...result, summary: result.summary ?? '' }
      })
    },
  }
}

/** 三个工具的定义（顺序 = 注册顺序）。schema 已补齐 `additionalProperties`，可直接注册。 */
export function buildScheduleTools(options: ScheduleToolOptions): ScheduleToolDefinition[] {
  return [scheduleListTool(options), scheduleAddTool(options), scheduleSummaryTool(options)].map(sealToolDefinition)
}

/**
 * 把三个工具注册到宿主 `tools` 服务；每个注册都挂在 `ctx.effect` 上，插件卸载即注销。
 *
 * `ctx.tools.register` 返回的 disposer 由 effect 接管；`ctx.effect` 不存在时（极简宿主/测试）
 * 退回直接注册，返回值仍然可用。
 */
export function registerScheduleTools(ctx: ScheduleToolHostContext, options: ScheduleToolOptions): string[] {
  if (ctx === null || typeof ctx !== 'object' || ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
    throw new SyncError('E_INTERNAL', '宿主没有可用的 tools 服务，无法注册日程工具')
  }
  const names: string[] = []
  for (const tool of buildScheduleTools(options)) {
    const dispose = ctx.tools.register(tool)
    if (typeof ctx.effect === 'function') {
      ctx.effect(
        () => (typeof dispose === 'function' ? (dispose as () => void) : () => undefined),
        `dsh-git-config-sync: tool ${tool.name}`,
      )
    }
    names.push(tool.name)
  }
  return names
}

/* -------------------------------------------------------------------------- */
/* 渲染（模型看到的是这些文本）                                                 */
/* -------------------------------------------------------------------------- */

function renderList(result: ListSchedulesResult): string {
  const lines: string[] = []
  const devices = result.deviceIds.length > 0 ? result.deviceIds.join(', ') : '（无）'
  lines.push(`${result.date} · ${result.records.length} 条 · 设备：${devices}`)
  if (result.note !== undefined && result.note !== '') lines.push(`note：${result.note}`)
  for (const record of result.records) {
    const clock = formatClock(record.ts)
    const state = record.done ? '已完成' : '未完成'
    const owner = record.author !== '' ? record.author : '我'
    lines.push(`- ${clock} [${state}] ${record.title} · ${owner} · ${record.deviceId} · id=${record.id}`)
    if (record.bodyPreview !== '') lines.push(`  ${record.bodyPreview}`)
  }
  if (result.records.length === 0) lines.push('（当天没有记录）')
  if (result.errors.length > 0) {
    lines.push(`坏行 ${result.errors.length} 条（已跳过）：`)
    for (const item of result.errors.slice(0, 5)) lines.push(`- ${item}`)
  }
  return lines.join('\n')
}

function renderAdd(result: AddScheduleResult): string {
  return [
    `已新建日程：${result.date} · ${result.id}`,
    `路径：${result.path}`,
    `提交：${result.commit === '' ? '（无变更）' : result.commit.slice(0, 12)}${result.rebased ? '（已 rebase）' : ''}`,
    `推送：${result.pushed ? '已推送' : '无需推送'}`,
  ].join('\n')
}

function renderSummary(result: SummaryResult): string {
  if (result.summary !== null && result.summary !== '') return result.summary
  const lines: string[] = []
  lines.push(`${result.date} · ${result.count} 条记录（设备：${result.deviceIds.join(', ') || '（无）'}）`)
  if (result.aiNote !== undefined && result.aiNote !== '') lines.push(`说明：${result.aiNote}`)
  if (result.note !== undefined && result.note !== '') lines.push(`note：${result.note}`)
  if (result.count === 0) return lines.join('\n')
  lines.push('')
  lines.push('下面是可直接用于汇总的提示词：')
  lines.push('')
  lines.push(result.prompt)
  return lines.join('\n')
}

/** 工具执行错误统一转成可读文本（绝不带 token）。 */
export function describeToolError(error: unknown): string {
  return error instanceof Error ? errorMessage(error) : String(error)
}
