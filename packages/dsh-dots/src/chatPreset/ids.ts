/**
 * 「云端对话模式」（chat preset）的标识常量。
 *
 * 两套 id 必须分清（见 `docs/RESEARCH-chat-preset.md` §1.2、§5.1）：
 * - `CHAT_PRESET_ID`：preset **定义**里的 `config.id`，同时也是会话首行 header 里
 *   `agentPreset` 字段的值（不是 Loader 行 id）；
 * - `CHAT_PRESET_LOADER_ID`：`cordis.patch.yml` 里那一行插件（Loader 行）的 `id`，
 *   约定为 `preset-<id>`（`dsh-agent-preset/skills/dsh-doc/references/compositions.md:9`）。
 *
 * `chat` 这个 id 在本机 profile 里未被占用（`~/.dsh/profiles/desktop/cordis.patch.yml`
 * 没有任何 preset 行；随 DSH 发布的三个 preset 是 `standard`/`ptc`/`minimal`）。
 */

/** preset 定义 id，也是会话 header 里 `agentPreset` 的取值。 */
export const CHAT_PRESET_ID = 'chat'

/** Loader 行 id（`cordis.patch.yml` 的 `- id: preset-chat`）。 */
export const CHAT_PRESET_LOADER_ID = 'preset-chat'

/** 展示名（preset roster 里显示的名字）。 */
export const CHAT_PRESET_NAME = 'Chat'
