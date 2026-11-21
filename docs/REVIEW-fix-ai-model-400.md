# REVIEW — mod-fix-ai-model-400（独立只读评审）

## 结论
P0 **0** / P1 **0** / P2 **1**（仅文档登记，非代码缺陷）→ **可以提交**（建议 Lead 提交时补登记）。
五道门闸全部复现通过：全量 3151 / 3150 pass / 0 fail / 1 skip；validate 8/8；tsc 0；overlay false。

## Findings
- **P2-1（登记缺失）** `docs/MODULES.md`、`docs/ROADMAP.md`：全树 grep `mod-fix-ai-model-400` **0 命中**；本批 6 个代码/测试文件已落盘，但执行器 idle 未出报告，模块索引未登记。违反 `项目理解.md` §7「每批更新索引」；不影响代码正确性，Lead 提交前补 §1/§2/§5/§6 与交接节即可。
- 非缺陷确认：`apps/arkui-schedule/entry/src/main/ets/model/aiProvider.ts:50` 仅改端点（`/inference/go/v1` → `/inference/go/openai/v1`）；**模型 id 没有改错、也没有改**：`:52` 仍为 `deepseek-v4.1-flash`。外部模型目录 [GET /inference/go/v1/models](https://opencode.ai/inference/go/v1/models) 显示其 `api.chat-completions.base_url` 正是新值，`canonical_id=deepseek/deepseek-v4.1-flash-1017` 不是请求体 id；旧端点只服务 /models，400 `ai_generate` 是端点错、不是模型名错。`aiProvider.test.mjs:473` 的注释与结论一致。

## 请求形状（脱敏，无 key）
| 项 | 现值 | 钉子 / 依据 |
| --- | --- | --- |
| POST 端点 | `https://opencode.ai/inference/go/openai/v1/chat/completions` | `aiProvider.ts:50`、`aiProvider.test.mjs:464-470`；外部目录 base_url 一致 |
| `model` | `deepseek-v4.1-flash`（未变，无 `opencode/` 前缀、无 `-free` 后缀） | `aiProvider.ts:51-54`、`aiProvider.test.mjs:473-485` |
| body 键 | 恰 5 个：`model`/`messages`/`temperature`/`max_tokens`/`stream` | `aiRequest.ts:198-204`、`aiRequest.test.mjs:750` |
| 被拒字段 | 无 `reasoning_effort`/`top_p`/`session_id`/`apiKey`/`key` | `aiRequest.test.mjs:756-758` |
| 鉴权/会话头 | `Authorization: Bearer <redacted>`；`x-opencode-session: <uuid-v4>` | `deepseek.ets:290-293`、`aiFallbackRunner.ets:248-250` |

## 类型化文案 verdict：**通过**
`aiRequest.ts:402-419` `AiModelRefusalError.message` 同时点名 `provider=…, model=…`，只带 `status` 供诊断，**不回显原始 body / 错误码**；`:663-668` 经 `classifyAiError` 生效，`:427-454` 判定仅 400/404/422 + 强特征，路由拒绝优先。`aiRequest.test.mjs:789-800` 逐字钉住文案并断言无原文、无 `ai_generate`、无 key（KEYISH 由字符码拼出，夹具不含 key 字面量）。两条服务路径均传入源 id + 实际模型：`deepseek.ets:263-268,386,741`、`aiFallbackRunner.ets:373-384`。`sanitizeDiagnostic`（`aiFallback.ts:488-504`）的脱敏/截断不伤该文案，UI 可见。

## 会话头回归：**未回归**
`aiRequest.ts:104,137-151,609` 单例 UUID v4 会话 id → `deepseek.ets:293`、`aiFallbackRunner.ets:250` 两处字面量头；`aiRequest.test.mjs:616-685` 钉住稳定性（连续请求/重试复用、重启换新、不进 body、不打印、两服务层各恰好一处）。新增测试 `aiRequest.test.mjs:769` 再次断言头存在。

## 其它约束
无端点切按量：`aiProvider.test.mjs:487-492` 钉住 `inference/go/` 且非 `inference/openai/`。无新依赖（manifest diff 为空）；无新增 `throw`（`arkts-limited-throw` 无新面）；key 仅进 Authorization 头，日志仅 `deepseek.ets:161-163` 一条模板（provider/model/latency/ok）。

## 门闸 tails
```
GATE1: ℹ tests 171 / pass 171 / fail 0 / skipped 0   (exit 0)
GATE2: ℹ tests 3151 / suites 373 / pass 3150 / fail 0 / cancelled 0 / skipped 1 / todo 0 (exit 0)
GATE3: tsc exit 0（无输出）
GATE4: ✅ 全部通过：8/8 条规则（JSON5/JSON 70、相对 import 500、main 静态 import 657、页面 12、rawfile/git 2）
GATE5: 覆盖层：未应用；[overlay] applied=false (exit 0)
```
测试真实性：改 slug 为 `opencode/…`/`-free` → `aiProvider.test.mjs:477-484` 红；删会话头 → `aiRequest.test.mjs:667-669,769` 红；文案回显 body/key → `aiRequest.test.mjs:798-800` 红。

## unverified
真机 ArkTS 编译 / 装机与真实 key 端到端 400 是否消失（无设备、无 key）；外部目录仅证实请求形状，未实际重放线上 400。P2-1 的文档登记需由 Lead 补齐。
