/**
 * 云端对话模式 P1（插件侧）的**类型契约**，不含任何副作用。
 *
 * 事实来源（不要在这里自由发挥）：
 *   - `docs/CHAT-SYNC.md` §2：`chats/<sessionId>/{meta.json,session.jsonl}` + `chats/index.jsonl`，
 *     `meta.json` 字段白名单、只追加语义、禁绝对路径；
 *   - `docs/RESEARCH-session-import.md`（下称 RSI）§2：`session.v4.jsonl.zstd` 是**裸 zstd 帧串联**，
 *     `zlib.zstdDecompressSync` 只解第一帧，必须自己按帧切；§3：header 行 `type:"session"`、
 *     事件行 `{type,seq,time,data}`。
 *
 * 本文件的类型只描述「插件读到的本机事实」与「要写进共享仓库的投影」；不含任何绝对路径字段。
 */
export {};
