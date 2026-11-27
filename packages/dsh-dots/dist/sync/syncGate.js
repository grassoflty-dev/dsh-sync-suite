/**
 * 同步门禁的**纯判定**（`mod-plugin-behind-fastforward`）。
 *
 * 背景（本文件要修的 bug）：旧门禁 `gateOfFacts()` 只接受 `HEAD === origin/main` 的
 * **严格字符串相等**，于是「本地只落后、历史是远端的祖先」这种最干净的同步状态也被判成
 * E_NOT_SYNCED；而恢复通道 `pendingIsOurs()` 又要求 `behind === 0`，两条路都走不通。
 * 结果：另一台设备先推一次，本机保存就永远报错——而这一层其实**没有任何**快进尝试。
 *
 * 本文件把「该怎么做」抽成**没有 IO、没有 git、没有墙钟**的纯函数：调用方只把
 * `(ahead, behind, ours)` 三个事实喂进来，动作与 typed 原因都可以脱离 git 单测。
 *
 * 判定矩阵（完整，含退化输入；`ours` 只在 both-sides 都有提交时才影响结论）：
 *
 *   | ahead | behind | ours  | action         | reason            |
 *   |-------|--------|-------|----------------|-------------------|
 *   | 0     | 0      | 任意  | proceed        | in-sync           |
 *   | 0     | >0     | 任意  | fast-forward   | behind-only       |
 *   | >0    | 0      | true  | recover        | ahead-only-ours   |
 *   | >0    | 0      | false | refuse         | ahead-only-foreign|
 *   | >0    | >0     | true  | recover        | diverged-ours     |
 *   | >0    | >0     | false | refuse         | diverged-foreign  |
 *   | 其它（负数 / NaN / Infinity / 小数 / 非数）| refuse | invalid-facts |
 *
 * 「其它」一行是**硬护栏**：事实读不出来或形状不对时绝不静默 proceed，一律 typed 拒绝。
 * `ours` = 领先提交是否**全部**由本模块产生（带 `dsh-dots-v2:` 尾注 + 只改 `timeline/**`），
 * 由调用方用 `sync/cycle.ts` 的既有严格谓词算好后传入；本文件不重复实现归属判定，
 * 也不放宽任何一条（尾注缺失 / 实例不符 / diff 越界仍然一律不算本模块）。
 */
/**
 * 判定原因的稳定标识。只用小写 slug（不以 E_ 开头）：
 * 它们进日志/测试断言，不是给用户看的文案——文案由 `sync/cycle.ts` 按原因映射。
 */
export const SYNC_GATE_REASON = {
    IN_SYNC: 'in-sync',
    BEHIND_ONLY: 'behind-only',
    AHEAD_ONLY_OURS: 'ahead-only-ours',
    AHEAD_ONLY_FOREIGN: 'ahead-only-foreign',
    DIVERGED_OURS: 'diverged-ours',
    DIVERGED_FOREIGN: 'diverged-foreign',
    INVALID_FACTS: 'invalid-facts',
};
/**
 * 计数事实是否合法：必须是**非负整数**。
 * `NaN` / `Infinity` / `1.5` / `-1` / `'3'` / `null` / `undefined` 全部非法——
 * 计数只能来自 `git rev-list --count`，任何别的形状都说明事实不可信。
 */
export function isSyncFactsValid(ahead, behind) {
    return typeof ahead === 'number' && typeof behind === 'number' &&
        Number.isInteger(ahead) && Number.isInteger(behind) &&
        ahead >= 0 && behind >= 0;
}
/** 「事实不可用」的统一拒绝判定：读不到 / 自相矛盾都走这一条，绝不静默 proceed。 */
export function refuseInvalidFacts() {
    return { action: 'refuse', reason: SYNC_GATE_REASON.INVALID_FACTS };
}
/**
 * 纯函数：把同步事实映射成动作。
 *
 * 不读任何外部状态、不抛异常、对任何输入都返回四个动作之一（总函数），
 * 因此整张矩阵可以脱离 git 与文件系统逐格断言。
 */
export function decideSyncGate(facts) {
    const ahead = facts?.ahead;
    const behind = facts?.behind;
    if (!isSyncFactsValid(ahead, behind))
        return refuseInvalidFacts();
    // 非 true 一律按「非本模块」：不许靠真值性把陌生提交当自己的。
    const ours = facts.ours === true;
    if (ahead === 0 && behind === 0) {
        return { action: 'proceed', reason: SYNC_GATE_REASON.IN_SYNC };
    }
    // 只落后、本地没有对方没有的提交 ⇒ 这是最干净的一种状态：只需要一次快进（不改写任何历史）。
    if (ahead === 0) {
        return { action: 'fast-forward', reason: SYNC_GATE_REASON.BEHIND_ONLY };
    }
    if (behind === 0) {
        return ours
            ? { action: 'recover', reason: SYNC_GATE_REASON.AHEAD_ONLY_OURS }
            : { action: 'refuse', reason: SYNC_GATE_REASON.AHEAD_ONLY_FOREIGN };
    }
    // 双方各有对方没有的提交 = 真分叉：本层不改写历史，只能有界恢复或拒绝。
    return ours
        ? { action: 'recover', reason: SYNC_GATE_REASON.DIVERGED_OURS }
        : { action: 'refuse', reason: SYNC_GATE_REASON.DIVERGED_FOREIGN };
}
