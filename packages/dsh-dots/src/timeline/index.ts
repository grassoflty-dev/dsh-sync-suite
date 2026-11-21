/**
 * v2 单时间线读 + 规范序列化模块的唯一出口。
 *
 * 只做纯函数再导出；**无 import 副作用、无 IO、无门禁、无写盘**。
 * 与 `src/schedule/**`（v1）平行存在，不迁移、不删除、不重连现有工具。
 * writer（原子替换 / 账本追加 / outbox / union/replay / assertWritable IO）留给下一模块。
 */
export * from './paths.js'
export * from './records.js'
