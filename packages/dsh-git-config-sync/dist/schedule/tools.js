/**
 * 模型侧工具：`schedule_list` / `schedule_add` / `schedule_summary` / `dsh_dots`。
 *
 * 注册方式：宿主 `ctx.tools.register(definition)`（Cordis `tools` 服务）。
 * 这里**直接给注册表要求的原始定义**（`{name, description, parameters, output:{schema,render}, execute}`），
 * 不 import `@deepseek-ai/dsh-tools` 的 `defineTool`：它只是把作者侧 DSL 编译成 JSON Schema
 * 并加一层入参校验的语法糖，而本插件按仓库纪律"运行时零 npm 依赖"，且注册表本身只校验
 * `name` 与 `output.{schema,render}`（见 `@deepseek-ai/dsh-tools` 的 `ToolsService.register`）。
 *
 * 参数与返回值都用**标准 JSON Schema**，模型看到的就是这份 schema。
 */
import { SettingsStore } from '../engine/settings.js';
import { SyncError, errorMessage } from '../engine/errors.js';
import { formatClock } from './clock.js';
import { ALL_DEVICES, withScheduleBridge } from './bridge.js';
import { clampDays, dotsSnapshotFromBridge, emptyDotsSnapshot } from './dots.js';
function text(value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}
function argsRecord(args) {
    return args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
}
function argsString(args, key) {
    const value = args[key];
    return typeof value === 'string' ? value.trim() : '';
}
/** 每次执行都重新读设置：设置页改完仓库/设备标识，下一次工具调用立即生效。 */
function readToolSettings(options) {
    const store = new SettingsStore(options.paths, { allowLocalRepo: options.allowLocalRepo === true });
    return { settings: store.readSettings(), token: store.readToken() };
}
/** 把工具选项翻译成 `ScheduleBridge` 的工作区选项（只带显式给过的字段）。 */
function workspaceOptions(options) {
    return {
        paths: options.paths,
        ...(options.allowLocalRepo === true ? { allowLocalRepo: true } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.networkTimeoutMs !== undefined ? { networkTimeoutMs: options.networkTimeoutMs } : {}),
        ...(options.ai !== undefined ? { ai: options.ai } : {}),
    };
}
async function withBridgeForTool(options, task) {
    const { settings, token } = readToolSettings(options);
    return withScheduleBridge(workspaceOptions(options), settings, token, async (bridge) => task(bridge, bridge.today()));
}
/**
 * 递归补齐 `additionalProperties`：宿主的 `assertSupportedJsonSchema` 要求 object 节点
 * **显式**声明 `additionalProperties: true|false`，缺省会被判为 unsupported（注册直接失败）。
 *
 * 统一取 `true`：返回值多带一个字段（或模型多传一个参数）不该让调用失败。
 */
export function sealToolSchema(node) {
    if (node === null || typeof node !== 'object')
        return node;
    if (Array.isArray(node))
        return node.map((item) => sealToolSchema(item));
    const record = node;
    const sealed = {};
    for (const [key, value] of Object.entries(record)) {
        if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const properties = {};
            for (const [name, schema] of Object.entries(value)) {
                properties[name] = sealToolSchema(schema);
            }
            sealed.properties = properties;
            continue;
        }
        if (key === 'items') {
            sealed.items = sealToolSchema(value);
            continue;
        }
        sealed[key] = value;
    }
    if (sealed.type === 'object' && sealed.additionalProperties === undefined)
        sealed.additionalProperties = true;
    return sealed;
}
/** 补齐一份工具定义里的 `parameters` 与 `output.schema`。 */
function sealToolDefinition(definition) {
    return {
        ...definition,
        parameters: sealToolSchema(definition.parameters),
        output: {
            ...definition.output,
            schema: sealToolSchema(definition.output.schema),
        },
    };
}
/** `schedule_list` 的定义。 */
function scheduleListTool(options) {
    return {
        name: 'schedule_list',
        description: '列出某天的日程（跨设备按 id 折叠，同一 id 取较晚的记录）。默认今天、只看本机设备；' +
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
            render: (_args, value) => text(renderList(value)),
        },
        timeoutMs: 60_000,
        async execute(rawArgs) {
            const args = argsRecord(rawArgs);
            const date = argsString(args, 'date');
            const deviceId = argsString(args, 'deviceId');
            return withBridgeForTool(options, async (bridge, today) => {
                const day = date === '' ? today : date;
                return bridge.list(deviceId === '' ? bridge.deviceId : deviceId, day);
            });
        },
    };
}
/** `schedule_add` 的定义。 */
function scheduleAddTool(options) {
    return {
        name: 'schedule_add',
        description: '在本机设备目录下新建一条日程（追加一行 JSONL，不重写历史行），然后提交并推送到同一个 Git 仓库，' +
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
            render: (_args, value) => text(renderAdd(value)),
        },
        timeoutMs: 60_000,
        async execute(rawArgs) {
            const args = argsRecord(rawArgs);
            const date = argsString(args, 'date');
            const title = argsString(args, 'title');
            if (title === '')
                throw new SyncError('E_VALIDATION', 'title 不能为空');
            const body = argsString(args, 'body');
            const author = argsString(args, 'author');
            return withBridgeForTool(options, async (bridge, today) => {
                const day = date === '' ? today : date;
                return bridge.add(bridge.deviceId, day, {
                    title,
                    ...(body !== '' ? { body } : {}),
                    ...(author !== '' ? { author } : {}),
                });
            });
        },
    };
}
/** `schedule_summary` 的定义。 */
function scheduleSummaryTool(options) {
    return {
        name: 'schedule_summary',
        description: '把某天的日程记录拼成 AI 载荷与提示词（与平板 App 的每日汇总同一契约：只取当天记录、' +
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
            render: (_args, value) => text(renderSummary(value)),
        },
        timeoutMs: 90_000,
        async execute(rawArgs) {
            const args = argsRecord(rawArgs);
            const date = argsString(args, 'date');
            const deviceId = argsString(args, 'deviceId');
            return withBridgeForTool(options, async (bridge, today) => {
                const day = date === '' ? today : date;
                const result = await bridge.summary(deviceId === '' ? bridge.deviceId : deviceId, day);
                // 工具返回值里 `summary: ''` 表示没有 AI 正文（原因见 aiNote），schema 里保持 string。
                return { ...result, summary: result.summary ?? '' };
            });
        },
    };
}
/** `dsh_dots` 的定义：手机端「DSH-dots」的一次性快照。 */
function dshDotsTool(options) {
    return {
        name: 'dsh_dots',
        description: '给手机端「DSH-dots」的一次性快照：**跨设备聚合**仓库里「最近 N 天（默认 7，夹到 1..90）」的日程——' +
            '每天的总数 / 未完成 / 已完成，以及最多 3 条「未完成优先、按时间倒序、去重」的标题；' +
            '同时给出本机 DSH 状态（只填能证明的字段：数据通道 mode、版本 version；会话级字段在拿不到证据时不填，' +
            'reachable=false 表示"没有会话证据"而不是"DSH 挂了"）。只读：不写仓库、不提交、不推送。',
        parameters: {
            type: 'object',
            properties: {
                days: {
                    type: 'integer',
                    description: '最近多少天（含今天）；默认 7，夹取到 1..90',
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    generatedAt: { type: 'string' },
                    deviceId: { type: 'string' },
                    note: { type: 'string' },
                    days: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                dateKey: { type: 'string' },
                                total: { type: 'integer' },
                                open: { type: 'integer' },
                                done: { type: 'integer' },
                                topTitles: { type: 'array', items: { type: 'string' } },
                            },
                        },
                    },
                    totals: {
                        type: 'object',
                        properties: {
                            days: { type: 'integer' },
                            records: { type: 'integer' },
                            open: { type: 'integer' },
                            done: { type: 'integer' },
                            skipped: { type: 'integer' },
                        },
                    },
                    dsh: {
                        type: 'object',
                        properties: {
                            reachable: { type: 'boolean' },
                            mode: { type: 'string', description: 'git-bridge / http-remote / unknown' },
                            sessionCount: { type: 'integer' },
                            activeSessionTitle: { type: 'string' },
                            busy: { type: 'boolean' },
                            lastActivityAt: { type: 'string' },
                            version: { type: 'string' },
                            detail: { type: 'string' },
                        },
                    },
                },
            },
            render: (_args, value) => text(renderDots(value)),
        },
        timeoutMs: 90_000,
        async execute(rawArgs) {
            const args = argsRecord(rawArgs);
            const days = clampDays(args.days);
            const { settings, token } = readToolSettings(options);
            // 没有仓库 = 没有数据，不是错误：日程给空数组，DSH 状态给可读说明（与 read 路径同样的降级策略）。
            if (typeof settings.repoUrl !== 'string' || settings.repoUrl.trim() === '') {
                return emptyDotsSnapshot({
                    deviceId: settings.deviceId,
                    days,
                    ...(options.now !== undefined ? { now: options.now } : {}),
                    note: '尚未配置仓库地址：日程为空数组（不是错误），配置后即可聚合跨设备日程',
                });
            }
            return withScheduleBridge(workspaceOptions(options), settings, token, async (bridge) => dotsSnapshotFromBridge(bridge, {
                days,
                ...(options.now !== undefined ? { now: options.now } : {}),
                ...(options.dsh !== undefined ? { dsh: options.dsh } : {}),
            }));
        },
    };
}
/** 四个工具的定义（顺序 = 注册顺序）。schema 已补齐 `additionalProperties`，可直接注册。 */
export function buildScheduleTools(options) {
    return [
        scheduleListTool(options),
        scheduleAddTool(options),
        scheduleSummaryTool(options),
        dshDotsTool(options),
    ].map(sealToolDefinition);
}
/**
 * 把四个工具注册到宿主 `tools` 服务；每个注册都挂在 `ctx.effect` 上，插件卸载即注销。
 *
 * `ctx.tools.register` 返回的 disposer 由 effect 接管；`ctx.effect` 不存在时（极简宿主/测试）
 * 退回直接注册，返回值仍然可用。
 */
export function registerScheduleTools(ctx, options) {
    if (ctx === null || typeof ctx !== 'object' || ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
        throw new SyncError('E_INTERNAL', '宿主没有可用的 tools 服务，无法注册日程工具');
    }
    const names = [];
    for (const tool of buildScheduleTools(options)) {
        const dispose = ctx.tools.register(tool);
        if (typeof ctx.effect === 'function') {
            ctx.effect(() => (typeof dispose === 'function' ? dispose : () => undefined), `dsh-git-config-sync: tool ${tool.name}`);
        }
        names.push(tool.name);
    }
    return names;
}
/* -------------------------------------------------------------------------- */
/* 渲染（模型看到的是这些文本）                                                 */
/* -------------------------------------------------------------------------- */
function renderList(result) {
    const lines = [];
    const devices = result.deviceIds.length > 0 ? result.deviceIds.join(', ') : '（无）';
    lines.push(`${result.date} · ${result.records.length} 条 · 设备：${devices}`);
    if (result.note !== undefined && result.note !== '')
        lines.push(`note：${result.note}`);
    for (const record of result.records) {
        const clock = formatClock(record.ts);
        const state = record.done ? '已完成' : '未完成';
        const owner = record.author !== '' ? record.author : '我';
        lines.push(`- ${clock} [${state}] ${record.title} · ${owner} · ${record.deviceId} · id=${record.id}`);
        if (record.bodyPreview !== '')
            lines.push(`  ${record.bodyPreview}`);
    }
    if (result.records.length === 0)
        lines.push('（当天没有记录）');
    if (result.errors.length > 0) {
        lines.push(`坏行 ${result.errors.length} 条（已跳过）：`);
        for (const item of result.errors.slice(0, 5))
            lines.push(`- ${item}`);
    }
    return lines.join('\n');
}
function renderAdd(result) {
    return [
        `已新建日程：${result.date} · ${result.id}`,
        `路径：${result.path}`,
        `提交：${result.commit === '' ? '（无变更）' : result.commit.slice(0, 12)}${result.rebased ? '（已 rebase）' : ''}`,
        `推送：${result.pushed ? '已推送' : '无需推送'}`,
    ].join('\n');
}
function renderSummary(result) {
    if (result.summary !== null && result.summary !== '')
        return result.summary;
    const lines = [];
    lines.push(`${result.date} · ${result.count} 条记录（设备：${result.deviceIds.join(', ') || '（无）'}）`);
    if (result.aiNote !== undefined && result.aiNote !== '')
        lines.push(`说明：${result.aiNote}`);
    if (result.note !== undefined && result.note !== '')
        lines.push(`note：${result.note}`);
    if (result.count === 0)
        return lines.join('\n');
    lines.push('');
    lines.push('下面是可直接用于汇总的提示词：');
    lines.push('');
    lines.push(result.prompt);
    return lines.join('\n');
}
/** `dsh_dots` 快照的可读渲染（模型/日志看到的是这段文本）。 */
function renderDots(snapshot) {
    const lines = [];
    lines.push(`DSH-dots 快照 · ${snapshot.generatedAt} · 设备 ${snapshot.deviceId}`);
    const skipped = snapshot.totals.skipped === undefined ? 0 : snapshot.totals.skipped;
    lines.push(`有记录的 ${snapshot.totals.days} 天：共 ${snapshot.totals.records} 条 · 未完成 ${snapshot.totals.open}` +
        ` · 已完成 ${snapshot.totals.done}${skipped > 0 ? ` · 坏行 ${skipped}（已跳过）` : ''}`);
    if (snapshot.note !== undefined && snapshot.note !== '')
        lines.push(`note：${snapshot.note}`);
    for (const day of snapshot.days) {
        lines.push(`${day.dateKey} · ${day.total} 条（未完成 ${day.open} / 已完成 ${day.done}）`);
        if (day.topTitles.length > 0)
            lines.push(`  ${day.topTitles.join(' / ')}`);
    }
    if (snapshot.days.length === 0)
        lines.push('（最近 N 天没有日程记录）');
    const version = snapshot.dsh.version === undefined ? '' : ` · version=${snapshot.dsh.version}`;
    lines.push(`DSH：reachable=${snapshot.dsh.reachable ? 'true' : 'false'} · mode=${snapshot.dsh.mode}${version}`);
    if (snapshot.dsh.detail !== undefined && snapshot.dsh.detail !== '')
        lines.push(`  说明：${snapshot.dsh.detail}`);
    return lines.join('\n');
}
/** 工具执行错误统一转成可读文本（绝不带 token）。 */
export function describeToolError(error) {
    return error instanceof Error ? errorMessage(error) : String(error);
}
