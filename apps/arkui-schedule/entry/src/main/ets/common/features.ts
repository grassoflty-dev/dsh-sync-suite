/**
 * 平台能力开关（纯逻辑）。
 *
 * 手写板与 OCR 仅 HarmonyOS 具备；`platform/platformFeatures.ts` 的平台覆盖文件在启动时
 * 调用 `setFeatures(...)`，页面只读 `getFeatures()`，从而静态隐藏 Android 侧入口。
 * 默认全部关闭（fail-closed：未显式开启即视为不可用）。
 *
 * 契约：`docs/CONTRACT.md` §3.2。
 */

export interface ScheduleFeatures {
  /** 是否具备手写板（Canvas 分页书写 + 截图落盘）。 */
  handwriting: boolean;
  /** 是否具备 OCR（textRecognition 批量识别）。 */
  ocr: boolean;
}

const DEFAULT_FEATURES: ScheduleFeatures = { handwriting: false, ocr: false };

let current: ScheduleFeatures = { ...DEFAULT_FEATURES };

function toBool(value: unknown): boolean {
  return value === true;
}

/** 设置能力开关（未提供的字段保持当前值；非布尔值按 `false` 处理）。 */
export function setFeatures(features: Partial<ScheduleFeatures>): void {
  const next: ScheduleFeatures = { ...current };
  if (features !== null && typeof features === 'object') {
    if ('handwriting' in features) {
      next.handwriting = toBool(features.handwriting);
    }
    if ('ocr' in features) {
      next.ocr = toBool(features.ocr);
    }
  }
  current = next;
}

/** 读取能力开关（返回副本，调用方修改不会污染全局状态）。 */
export function getFeatures(): ScheduleFeatures {
  return { ...current };
}

/** 重置为默认（全部关闭）；供平台切换与测试使用。 */
export function resetFeatures(): void {
  current = { ...DEFAULT_FEATURES };
}
