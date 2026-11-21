/**
 * 设置根页四行的摘要文案（纯函数，零 SDK 依赖，Node 单测覆盖）。
 *
 * mod-settings-root：设置页从「长滚动」改为四行菜单，每行只显示一句可核对的摘要。
 * 摘要一律来自已持久化的真实状态：仓库主机 / 上次同步成败 / 上次导出导入 / 服务·模型。
 * 拿不到数据时给「未同步 / 未导出」这类确定文案，不编造状态、不伪造时间。
 */
/** 上次导出 / 导入时刻的 AppStorage 键（由导入导出页面在落盘成功后写入）。 */
export const LAST_EXPORT_AT_KEY: string = 'settings.lastExportAt';
export const LAST_IMPORT_AT_KEY: string = 'settings.lastImportAt';

/** 去掉协议、账号与路径，只留主机名；空值 / 非法值回落到原文去壳后的短串或「未配置」。 */
export function repoHostOf(repoUrl: string): string {
  const raw: string = typeof repoUrl === 'string' ? repoUrl.trim() : '';
  if (raw.length === 0) {
    return '未配置';
  }
  const withoutScheme: string = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/^[^/@]+@/, '');
  const host: string = withoutScheme.split(/[/?#]/, 1)[0].split(':', 1)[0].trim();
  return host.length > 0 ? host : '未配置';
}

/** ISO 时刻 → 本机时区 `HH:MM`；无法解析返回空串（调用方据此回落「时间未知」）。 */
export function clockOf(iso: string): string {
  const value: string = typeof iso === 'string' ? iso.trim() : '';
  if (value.length === 0) {
    return '';
  }
  const ms: number = Date.parse(value);
  if (Number.isNaN(ms)) {
    return '';
  }
  const date: Date = new Date(ms);
  const hours: string = `${date.getHours()}`.padStart(2, '0');
  const minutes: string = `${date.getMinutes()}`.padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** 同步仓库行摘要：失败优先（原因取第一行），否则 `已同步·HH:MM`，从未同步给「未同步」。 */
export function syncRowSummary(lastSyncAt: string, lastSyncError: string): string {
  const error: string = typeof lastSyncError === 'string' ? lastSyncError.trim() : '';
  if (error.length > 0) {
    const firstLine: string = error.split(/\r?\n/, 1)[0].trim();
    return `失败：${firstLine}`;
  }
  const clock: string = clockOf(lastSyncAt);
  return clock.length > 0 ? `已同步·${clock}` : '未同步';
}

/** 数据行摘要：最近一次导出 / 导入的 `HH:MM`，都没做过给「未导出」。 */
export function dataRowSummary(lastExportAt: string, lastImportAt: string): string {
  const exported: string = clockOf(lastExportAt);
  const imported: string = clockOf(lastImportAt);
  if (exported.length === 0 && imported.length === 0) {
    return '未导出';
  }
  if (exported.length > 0 && imported.length === 0) {
    return `上次导出 ${exported}`;
  }
  if (exported.length === 0 && imported.length > 0) {
    return `上次导入 ${imported}`;
  }
  return exported >= imported ? `上次导出 ${exported}` : `上次导入 ${imported}`;
}

/** API 配置行摘要：`服务 · 模型`；任一段缺失都用「未配置」占位，不拼接出半截文案。 */
export function apiRowSummary(providerLabel: string, modelLabel: string): string {
  const provider: string = typeof providerLabel === 'string' ? providerLabel.trim() : '';
  const model: string = typeof modelLabel === 'string' ? modelLabel.trim() : '';
  const left: string = provider.length > 0 ? provider : '未配置';
  const right: string = model.length > 0 ? model : '未配置';
  return `${left} · ${right}`;
}
