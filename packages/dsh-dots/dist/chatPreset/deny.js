/**
 * chat preset 的**工具名证据表（仅说明用）**+ 失败文案 / 名字解析工具。
 *
 * ## 这一版改了什么（Lead 2026-11-18 二次裁决）
 *
 * 上一版这里是一份**手写的 58 项 deny 名单**（`CHAT_DENY_TOOLS`）。真接线会当场炸：
 * `read`/`write`/`edit`/`glob`/`grep`/`bash`/`pwsh`/`job_*` 在 chat 会话里**本来就没有注册**
 * （chat preset 不挂任何 `tool-*` 行），`bcdp_*` 除 `bcdp_status` 外是**惰性注册**，
 * `codex_*`/`chatgpt_connectors_*` 按开关注册；而 `ctx.tools.restrict()` 只认**当前已注册**
 * 的名字、写错就抛错（`<ASAR>/dsh-tools/src/index.ts:179-183`）。所以"把黑名单写死"在插件
 * 生态里必然失败：工具在运行期注册，**数量与名字都不稳定**。
 *
 * 现在 deny **不再出现在源码里**，而是运行期反算（实现在 `src/chatPreset/isolate.ts`）：
 *
 * ```
 * deny = 当前已注册的全部工具 − 纯对话白名单（src/chatPreset/allow.ts）
 * ```
 *
 * 反算之后还要**再枚举一次可见集做白名单断言**（fail-closed）：但凡多出一个非白名单工具，
 * 就抛 `E_CHAT_TOOLS_NOT_ISOLATED` 并拒绝创建会话。
 *
 * ## 本文件里 `KNOWN_*` 的地位：仅说明用
 *
 * `*_TOOL_SOURCES` / `KNOWN_*` 退化为**文档性证据表**——解释"哪些工具、为什么碰本机"，
 * 供评审与"升级 DSH/插件后复核"使用。**任何代码都不得把它们当作 deny 输入**：
 * 写死的名字既会漏掉新装插件（漏 = 隔离失败），也会包含当时未注册的名字（restrict 抛错 =
 * 会话起不来）。测试只把它们当"证据表完整性"来检查，不参与 `computeDeny`。
 *
 * ## 为什么仍然需要 deny（不是"preset 不列就够了"）
 *
 * preset 的 `plugins` 只决定**它自己挂载**什么。Web 面把内置工具插件在 Host 层显式
 * `disabled: true`（`<ASAR>/dsh-web-app/cordis.patch.yml:497-611`，注释原文 "The Web surface
 * disables them here and lets each session mount a preset instead."），所以 chat preset
 * **不列** `dsh-tool-fs`/`-fs-search`/`-bash`/`-pwsh`/`-jobs` 就已经结构性缺席。
 *
 * 但**第三方 Host 插件注册的全局工具摘不掉**：`dsh-browser-cdp`、`dsh-codex-subscription`、
 * 本插件的 `timeline_*`/`dsh_dots` 都在 Host 层 `ctx.tools.register(...)`，进入全局层，
 * 任何 preset 的 agent 都继承可见（`docs/RESEARCH-chat-preset.md` §3.2）。唯一手段是
 * agent 作用域 `ctx.tools.restrict({ deny })`（`<ASAR>/dsh-tools/src/index.ts:162-189`）。
 *
 * ## 路径别名
 *
 * - `<ASAR>` = `<DSH 安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai`
 *   （asar 内的文件只能用 Host 的 read 工具读，`rg`/`glob` 穿不透）
 * - `NM` = `<用户主目录>/.dsh/profiles/<profile>/node_modules`（本机 profile 已装插件）
 *
 * 这里一律写占位符、不写本机绝对路径：这些注释经常被复制/贴进 issue 与评审记录，
 * 绝对路径属于环境信息（用户名、安装位置），不该随源码外泄。
 *
 * 行号以本机当前安装版本为准；升级 DSH 或升级插件后需重新核对（见 `docs/CHAT-SYNC.md`
 * 「安全边界：chat preset 与工具隔离」的"复核方法"）。
 */
import { CHAT_PRESET_ID } from './ids.js';
export { CHAT_PRESET_ID };
/* -------------------------------------------------------------------------- */
/* 1. 本插件自己的全局工具（Host 层注册，任何 preset 都继承）                     */
/* -------------------------------------------------------------------------- */
/**
 * 本插件的 4 个工具：日程/DSH 状态都是**本机数据入口**（能读本机日程库、能写 Git 仓库、
 * 能报本机会话状态），纯对话模式一律不可见。
 *
 * 注册点在 `src/schedule/tools.ts`（`buildScheduleTools`），由 `src/index.ts` 的
 * `mountScheduleTools` 在 Host 层 `ctx.inject(['tools'], …)` 里注册 → 全局层。
 */
export const PLUGIN_TOOL_SOURCES = [
    { name: 'timeline_list', source: 'src/schedule/tools.ts:161', why: '读本机/跨设备日程库（含平板手写 OCR 记录）' },
    { name: 'timeline_add', source: 'src/schedule/tools.ts:220', why: '写本机日程并 commit/push 到 Git 仓库' },
    { name: 'timeline_summary', source: 'src/schedule/tools.ts:276', why: '读日程并调用外部 AI 密钥做汇总' },
    { name: 'dsh_dots', source: 'src/schedule/tools.ts:338', why: '聚合跨设备日程 + 本机 DSH 运行状态' },
];
/* -------------------------------------------------------------------------- */
/* 2. 内置文件 / 命令 / 后台任务（preset 面，chat 不列即缺席；此处仅作证据）          */
/* -------------------------------------------------------------------------- */
/**
 * 这些名字由 DSH 内置插件注册，**在 Web 面只由 preset 挂载**，所以 chat preset 不列它们
 * 就已经缺席（`<ASAR>/dsh-web-app/cordis.patch.yml:497-611`）。
 *
 * 证据表收它们的目的**只是解释"为什么碰本机"**（评审要能一眼看出 read/write/bash 属于
 * "不接触本机文件系统 / 不执行本机命令"的边界内），**不是**让谁把它们塞进 deny：正如本节
 * 开头说的，这些名字在 chat 会话里根本没注册，真拿去 `restrict` 会抛 unknown。
 *
 * 注意：`dsh-tool-bash`/`dsh-tool-pwsh` 与 `dsh-tool-bash-persistent`/`-pwsh-persistent`
 * 是两组不同包，但注册的**工具名相同**（`bash`/`pwsh`），所以证据表里各一条。
 */
export const BUILTIN_TOOL_SOURCES = [
    { name: 'read', source: '<ASAR>/dsh-tool-fs/src/index.ts:2,28-29', why: '读本机任意文件' },
    { name: 'read_image', source: '<ASAR>/dsh-tool-fs/src/index.ts:2,30-31', why: '读本机图片（同样落在文件系统上）' },
    { name: 'write', source: '<ASAR>/dsh-tool-fs/src/index.ts:2,32-33', why: '写本机文件' },
    { name: 'edit', source: '<ASAR>/dsh-tool-fs/src/index.ts:2,34-35', why: '改本机文件' },
    { name: 'apply_patch', source: '<ASAR>/dsh-tool-fs/src/index.ts:2,36-37', why: '批量改本机文件' },
    { name: 'glob', source: '<ASAR>/dsh-tool-fs-search/src/index.ts:2-3', why: '枚举本机文件树' },
    { name: 'grep', source: '<ASAR>/dsh-tool-fs-search/src/index.ts:2-3', why: '搜索本机文件内容' },
    { name: 'bash', source: '<ASAR>/dsh-tool-bash/src/index.ts:2；<ASAR>/dsh-web-app/presets/standard.patch.yml:21-23', why: '起子进程/执行任意命令' },
    { name: 'pwsh', source: '<ASAR>/dsh-tool-pwsh/src/index.ts:2；<ASAR>/dsh-web-app/presets/standard.patch.yml:24-26', why: '起子进程/执行任意 PowerShell' },
    { name: 'job_list', source: '<ASAR>/dsh-tool-jobs/src/index.ts:2', why: '后台任务可承载 shell/子进程输出' },
    { name: 'job_output', source: '<ASAR>/dsh-tool-jobs/src/index.ts:2', why: '读后台任务输出（等于读命令结果）' },
    { name: 'job_kill', source: '<ASAR>/dsh-tool-jobs/src/index.ts:2', why: '操作后台任务' },
];
/* -------------------------------------------------------------------------- */
/* 3. 第三方全局工具：dsh-codex-subscription（NM/dsh-codex-subscription/lib/index.js） */
/* -------------------------------------------------------------------------- */
/**
 * 全部由 Host 层 `ctx.tools.register` 注册（`lib/index.js:18217,18241,18642,18668,18753`）。
 *
 * **注意：其中多数是条件注册**（按设置/模型/连接器状态/通话状态开关）。条件不满足时
 * 该名字在运行期不存在——这正是旧版"手写名单"必然失败的原因（名单里留着它 → `restrict`
 * 判 unknown → 抛错）。证据表收它们只用来解释"为什么这些能力不该出现在纯对话里"；
 * 真 deny 由运行期反算，条件注册的名字**不会被算进注册表**，所以不可能出现在 deny 里。
 */
export const CODEX_TOOL_SOURCES = [
    { name: 'codex_image_generate', source: 'NM/dsh-codex-subscription/lib/index.js:5056（注册 :18217）', why: '生图/改图（网络 + 写附件）' },
    { name: 'codex_subscription_preferences', source: 'NM/dsh-codex-subscription/lib/index.js:948（注册 :18753）', why: '改订阅侧响应偏好（非对话能力）' },
    { name: 'chatgpt_connectors_search', source: 'NM/dsh-codex-subscription/lib/index.js:15295（注册 :18241）', why: '检索用户连接器数据' },
    { name: 'chatgpt_connectors_describe', source: 'NM/dsh-codex-subscription/lib/index.js:15324（注册 :18241）', why: '读取连接器数据' },
    { name: 'chatgpt_connectors_call', source: 'NM/dsh-codex-subscription/lib/index.js:15348（注册 :18241）', why: '调用连接器（可触发外部动作）' },
    { name: 'codex_sketch', source: 'NM/dsh-codex-subscription/lib/index.js:5686（注册 :18642）', why: '画板编辑（生成附件）' },
    { name: 'end_voice_call', source: 'NM/dsh-codex-subscription/lib/index.js:17157（注册 :18668）', why: '控制语音通话（非文本对话）' },
];
/* -------------------------------------------------------------------------- */
/* 4. 第三方全局工具：dsh-browser-cdp（NM/dsh-browser-cdp/lib/index.js）          */
/* -------------------------------------------------------------------------- */
/**
 * 35 个 `bcdp_*` 工具，按插件自己的分级表逐级列出（`lib/index.js:6518-6562` 的
 * `CORE/ACT/OBSERVE/WAIT/POWER/SESSION/ESCAPE/JUDGE`）。全部由 `lib/index.js:12255`
 * 的 `ctx.tools.register(tool)` 注册到全局层。
 *
 * **这里是逐名全列，不是 `bcdp_*` 前缀通配**：`restrict` 只认字面名字，前缀/通配一律无效。
 * 其中只有 `bcdp_status` 是常驻（core）；其余按分级 + 活动闸**惰性注册**，所以在
 * "刚开一个 chat 会话、浏览器还没动过"的时刻，多数 `bcdp_*` 并不存在——旧版把它们
 * 一次性塞进 deny 就会让 `restrict` 报 unknown（这正是现在改成运行期反算的原因：
 * 当时没注册的名字根本不会进注册表，也就不可能进 deny）。
 *
 * 旧名 `ego_*`（`legacyEgoToolNames` 别名，`lib/index.js:12347-12351`）默认关闭，
 * 本机配置未开启，故证据表里没有；若哪天开了该开关，运行期反算会自动覆盖它们，
 * 这里可选择性补 35 条**说明**（不影响隔离是否成立）。
 */
export const BROWSER_TOOL_SOURCES = [
    // core（常驻）
    { name: 'bcdp_status', source: 'NM/dsh-browser-cdp/lib/index.js:6518（注册 :12255）', why: '探测本机浏览器/链路状态' },
    // act
    { name: 'bcdp_space', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '切换浏览器空间/接管真实浏览器' },
    { name: 'bcdp_navigate', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '访问任意 URL' },
    { name: 'bcdp_click', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '在真实浏览器里点击（可提交表单）' },
    { name: 'bcdp_fill', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '在真实浏览器里填表' },
    { name: 'bcdp_key', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '键盘输入' },
    { name: 'bcdp_hover', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '悬停操作' },
    { name: 'bcdp_scroll', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '页面滚动' },
    { name: 'bcdp_select', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '下拉选择（表单）' },
    { name: 'bcdp_check', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '勾选（表单）' },
    { name: 'bcdp_drag', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '拖拽操作' },
    { name: 'bcdp_tab', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '管理标签页' },
    { name: 'bcdp_help', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '暴露浏览器工具面/配置指引' },
    { name: 'bcdp_doctor', source: 'NM/dsh-browser-cdp/lib/index.js:6519-6533', why: '探测本机浏览器安装/链路' },
    // observe
    { name: 'bcdp_screenshot', source: 'NM/dsh-browser-cdp/lib/index.js:6534-6540', why: '截屏（落盘/回传附件）' },
    { name: 'bcdp_page_info', source: 'NM/dsh-browser-cdp/lib/index.js:6534-6540', why: '读页面内容' },
    { name: 'bcdp_read_element', source: 'NM/dsh-browser-cdp/lib/index.js:6534-6540', why: '读页面元素' },
    { name: 'bcdp_js', source: 'NM/dsh-browser-cdp/lib/index.js:6534-6540', why: '在页面里执行 JS' },
    { name: 'bcdp_snapshot', source: 'NM/dsh-browser-cdp/lib/index.js:6534-6540', why: '抓取页面快照' },
    // wait
    { name: 'bcdp_wait', source: 'NM/dsh-browser-cdp/lib/index.js:6541', why: '等待页面条件（长任务）' },
    // power
    { name: 'bcdp_cdp', source: 'NM/dsh-browser-cdp/lib/index.js:6542-6548', why: '任意 CDP 命令（等价完全控制浏览器）' },
    { name: 'bcdp_http', source: 'NM/dsh-browser-cdp/lib/index.js:6542-6548', why: '借浏览器上下文发 HTTP' },
    { name: 'bcdp_upload', source: 'NM/dsh-browser-cdp/lib/index.js:6542-6548', why: '上传本机文件' },
    { name: 'bcdp_download', source: 'NM/dsh-browser-cdp/lib/index.js:6542-6548', why: '下载文件落盘' },
    { name: 'bcdp_dialog', source: 'NM/dsh-browser-cdp/lib/index.js:6542-6548', why: '处理原生对话框' },
    // session
    { name: 'bcdp_captcha', source: 'NM/dsh-browser-cdp/lib/index.js:6549-6554', why: '人机验证相关' },
    { name: 'bcdp_wait_for_human', source: 'NM/dsh-browser-cdp/lib/index.js:6549-6554', why: '接管等待人工' },
    { name: 'bcdp_auth_flush', source: 'NM/dsh-browser-cdp/lib/index.js:6549-6554', why: '清浏览器凭据/登录态' },
    { name: 'bcdp_login_import', source: 'NM/dsh-browser-cdp/lib/index.js:6549-6554', why: '导入本机浏览器登录态' },
    // escape
    { name: 'bcdp_script', source: 'NM/dsh-browser-cdp/lib/index.js:6555', why: '脚本化浏览器操作（逃生通道）' },
    // judge
    { name: 'bcdp_jev_status', source: 'NM/dsh-browser-cdp/lib/index.js:6556-6562', why: '视觉评审通道状态' },
    { name: 'bcdp_jev_ask', source: 'NM/dsh-browser-cdp/lib/index.js:6556-6562', why: '把图片发外部视觉模型' },
    { name: 'bcdp_jev_frame', source: 'NM/dsh-browser-cdp/lib/index.js:6556-6562', why: '抽帧送审' },
    { name: 'bcdp_jev_run', source: 'NM/dsh-browser-cdp/lib/index.js:6556-6562', why: '跑评审任务' },
    { name: 'bcdp_jev_attempt', source: 'NM/dsh-browser-cdp/lib/index.js:6556-6562', why: '评审重试' },
];
/* -------------------------------------------------------------------------- */
/* 5. 汇总：证据表 → KNOWN_*（**仅说明用**，不得作为 deny 输入）                    */
/* -------------------------------------------------------------------------- */
/**
 * 内置（preset 面）工具名，来自 `BUILTIN_TOOL_SOURCES`。
 *
 * **仅说明用**：这是"历史上出现过的内置工具名"的文档，不是 deny 名单。运行期这些名字在
 * chat 会话里大多根本不存在，`restrict` 会直接判 unknown。
 */
export const KNOWN_BUILTIN_TOOLS = BUILTIN_TOOL_SOURCES.map((item) => item.name);
/**
 * 本机可证的**全局层**工具名（第三方 + 本插件），来自 `PLUGIN_TOOL_SOURCES` /
 * `CODEX_TOOL_SOURCES` / `BROWSER_TOOL_SOURCES`。这些是 preset 摘不掉的残余面。
 *
 * **仅说明用**：解释"残余面可能有哪些工具、为什么必须不可见"。真 deny 由运行期反算
 * （`src/chatPreset/isolate.ts` 的 `computeDeny`），白名单在 `src/chatPreset/allow.ts`。
 */
export const KNOWN_GLOBAL_TOOLS = [
    ...PLUGIN_TOOL_SOURCES,
    ...CODEX_TOOL_SOURCES,
    ...BROWSER_TOOL_SOURCES,
].map((item) => item.name);
/**
 * 证据表里的全部已知工具名（内置 + 全局）。
 *
 * **仅说明用**：测试拿它做"证据表是否完整、来源是否带行号"的自检；**不**参与 deny 计算。
 */
export const KNOWN_ALL_TOOLS = [...KNOWN_BUILTIN_TOOLS, ...KNOWN_GLOBAL_TOOLS];
/**
 * 工具名约定：小写 snake_case（kebab-case 也接受，历史工具名里没有，但校验不因此报错）。
 * 明确拒绝：空串、前后空白、含空格、含大写、以数字/分隔符开头、连续分隔符、含 `.`/`/`。
 */
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;
/** 纯函数：名单自身的静态校验（重复/空/不是 snake_case 形态）。不碰运行期、不联网。 */
export function validateDenyList(list) {
    const unknown = [];
    const duplicates = [];
    const seen = new Set();
    for (const raw of list) {
        if (typeof raw !== 'string' || !TOOL_NAME_RE.test(raw)) {
            // 空串/带空格/带大写都会落到这里；原样回显便于定位（用 JSON 形态避免不可见字符）。
            unknown.push(typeof raw === 'string' ? raw : String(raw));
            continue;
        }
        if (seen.has(raw))
            duplicates.push(raw);
        else
            seen.add(raw);
    }
    return { ok: unknown.length === 0 && duplicates.length === 0, unknown, duplicates };
}
/**
 * 把"未知工具名"（运行期 `restrict` 抛的错）包成可读中文；未知必须**报错**不许吞。
 *
 * @param unknownNames - 运行期判定为不存在的工具名；空数组时给"未能解析出具体名字"的兜底文案。
 */
export function describeDenyFailure(unknownNames) {
    const names = unknownNames.filter((name) => typeof name === 'string' && name !== '');
    if (names.length === 0) {
        return ('chat 模式工具遮蔽失败：ctx.tools.restrict 拒绝了 deny 名单，但没能从中解析出具体工具名。' +
            'deny 是运行期反算的（已注册工具 − 白名单），出现这种失败说明宿主与我们的枚举结果不一致；' +
            '按 fail-closed 拒绝创建会话，请附上本机 DSH 版本与已装插件清单排查。');
    }
    return (`chat 模式工具遮蔽失败：deny 名单里有 ${names.length} 个工具名在当前 agent 作用域里不存在` +
        `（restrict 只认已注册的工具名，写错名字会抛错）：${names.join('、')}。` +
        'deny 是运行期反算的（已注册工具 − 白名单），不是写死的名单，所以这通常意味着' +
        '"算 deny"与"调 restrict"之间注册表变了（延迟注册的工具被卸载/重装）；按 fail-closed ' +
        '拒绝创建会话，不要退回静态名单。');
}
/**
 * 从 `tools.restrict` 抛出的错误里解析未知工具名。
 *
 * 宿主原文（`<ASAR>/dsh-tools/src/index.ts:182`）：
 * `tools.restrict() names unknown global tool "x", "y"; known global tools: a, b, c`
 *
 * 只认双引号包裹的 token，且**必须**是这次实际传给 `restrict` 的 deny 名字（避免把
 * `known global tools:` 后面的清单也吃进来）。解析不出时返回空数组，由
 * `describeDenyFailure` 给兜底文案。
 *
 * @param error - `restrict` 抛出的原始错误。
 * @param candidates - 本次实际传入的 deny 名单（必填：不再有全局静态名单可退化）。
 */
export function unknownToolNamesFromRestrictError(error, candidates) {
    const message = error instanceof Error ? error.message : String(error);
    const head = message.split('; known global tools:')[0] ?? message;
    const known = new Set(candidates ?? []);
    const found = [];
    const re = /"([^"]+)"/g;
    let match;
    while ((match = re.exec(head)) !== null) {
        const name = match[1];
        if (name !== undefined && known.has(name) && !found.includes(name))
            found.push(name);
    }
    return found;
}
