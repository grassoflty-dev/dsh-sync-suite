/**
 * 三个「用户选择」键的持久化绑定契约（mod-v2-sync-wiring P1-5）：纯数据、零 SDK import。
 *
 * 为什么放在 model：三个键与默认值必须被断言（静态/pure 测试），而 ArkUI 的
 * `PersistentStorage.persistProp` 只能在 SDK 侧调用。这里声明**唯一真值**，运行时由
 * `EntryAbility.onCreate()` 在页面加载前用 persistProp 绑定同名同默认值的键：
 * - 首次启动：persistProp 在 AppStorage 建键并写默认值；
 * - 用户激活/切换：`AppStorage.setOrCreate` 写同名键 → PersistentStorage 自动落盘；
 * - 重启：persistProp 先把磁盘值 hydrate 回 AppStorage，`timelineStore.readMode()` /
 *   `timelineModeSwitch.writeActivated()` / `v2ActivationService.isActivated()` 读到的就是上次选择。
 *
 * 服务侧键常量全部从本文件 import，避免两份字符串漂移。
 */

/** 一条绑定：key + 缺省值（缺省值只在首次启动、磁盘无值时生效）。 */
export interface PersistentBinding {
  key: string;
  defaultValue: string | boolean;
}

/** 读模式：'v1' 缺省 / 'v2'（显式激活后）。 */
export const PERSISTENT_READ_MODE_KEY: string = 'timeline.readMode';
/** 第二道显式激活闸：false 缺省 / true（用户在设置页确认后）。 */
export const PERSISTENT_V2_WRITE_KEY: string = 'timeline.v2WriteEnabled';
/** 并存裁决：'' 缺省 / '1'（用户确认「timeline/ 权威、v1 文件保留」后）。 */
export const PERSISTENT_V1_RETAINED_KEY: string = 'timeline.v1Retained';

/** 三个键的完整绑定表（EntryAbility 启动时逐条 persistProp；测试逐条断言）。 */
export const PERSISTENT_BINDINGS: PersistentBinding[] = [
  { key: PERSISTENT_READ_MODE_KEY, defaultValue: 'v1' },
  { key: PERSISTENT_V2_WRITE_KEY, defaultValue: false },
  { key: PERSISTENT_V1_RETAINED_KEY, defaultValue: '' }
];

/** 按 key 查绑定（未登记的键返回 null，防止有人绕过绑定表写「看似持久」的键）。 */
export function bindingFor(key: string): PersistentBinding | null {
  for (const binding of PERSISTENT_BINDINGS) {
    if (binding.key === key) {
      return binding;
    }
  }
  return null;
}
