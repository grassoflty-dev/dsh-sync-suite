/**
 * 手写板草稿存储：`<filesDir>/drafts/<draftKey>.json`（应用沙箱文件，不用 preferences）。
 *
 * 为什么不放 preferences：草稿是「整页笔迹 + 框」的结构化数据，几 KB 到几百 KB，
 * preferences 只适合小标量（`handwriting.tipShown` 那种）。
 *
 * 约定：
 * - 写盘是**原子替换**（先写 `.tmp` 再 rename），避免杀进程时留下半个 JSON；
 * - 读取失败/JSON 损坏由 `model/draft.ts` 的 `parseDraft()` 判定，本类只负责字节；
 * - 页面路径与文件名都由 `sanitizeDraftKey()` 清洗，不会目录穿越。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { DRAFT_DIR_NAME, draftFileName } from '../model/draft';
import { describeError, scheduleStore } from './scheduleStore';

/** 临时文件后缀（写完 rename 成正式文件）。 */
const TMP_SUFFIX: string = '.tmp';

export class DraftStore {
  /** 草稿目录（`<filesDir>/drafts`）。 */
  draftsDir(): string {
    return `${scheduleStore.getFilesDir()}/${DRAFT_DIR_NAME}`;
  }

  /** 某份草稿的绝对路径。 */
  draftPath(draftKey: string): string {
    return `${this.draftsDir()}/${draftFileName(draftKey)}`;
  }

  /** 草稿是否存在。 */
  hasDraft(draftKey: string): boolean {
    if (!scheduleStore.isReady()) {
      return false;
    }
    return this.fileExists(this.draftPath(draftKey));
  }

  /**
   * 写草稿（原子替换）。
   *
   * 失败抛中文错误（调用方只 toast，不阻塞退出）。
   */
  saveDraftSync(draftKey: string, json: string): void {
    if (!scheduleStore.isReady()) {
      throw new Error('草稿存储尚未初始化：请先调用 scheduleStore.ensureReady(context)');
    }
    const dir: string = this.draftsDir();
    this.ensureDirSync(dir);
    const path: string = this.draftPath(draftKey);
    const tmpPath: string = `${path}${TMP_SUFFIX}`;
    this.writeTextSync(tmpPath, json);
    try {
      // 已存在时先删再 rename（部分实现不允许覆盖式 rename）
      if (this.fileExists(path)) {
        fs.unlinkSync(path);
      }
      fs.renameSync(tmpPath, path);
    } catch (error) {
      // rename 失败就把临时文件也清掉，避免目录里越积越多
      try {
        if (this.fileExists(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // 清理失败不影响主流程
      }
      throw new Error(`保存草稿失败（${path}）：${describeError(error)}`);
    }
  }

  /** 读草稿文本；不存在返回空串（不抛）。 */
  readDraftSync(draftKey: string): string {
    const path: string = this.draftPath(draftKey);
    if (!scheduleStore.isReady() || !this.fileExists(path)) {
      return '';
    }
    try {
      return fs.readTextSync(path);
    } catch (error) {
      throw new Error(`读取草稿失败（${path}）：${describeError(error)}`);
    }
  }

  /** 丢弃草稿（不存在也当成功；用于「完成且 OCR 成功」与损坏文件清理）。 */
  deleteDraftSync(draftKey: string): void {
    const path: string = this.draftPath(draftKey);
    if (!this.fileExists(path)) {
      return;
    }
    try {
      fs.unlinkSync(path);
    } catch (error) {
      throw new Error(`删除草稿失败（${path}）：${describeError(error)}`);
    }
  }

  /** 草稿文件字节数（不存在返回 0）。 */
  draftSize(draftKey: string): number {
    const path: string = this.draftPath(draftKey);
    if (!this.fileExists(path)) {
      return 0;
    }
    try {
      return fs.statSync(path).size;
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------------------------ 内部实现

  private fileExists(path: string): boolean {
    try {
      return fs.accessSync(path);
    } catch {
      return false;
    }
  }

  private ensureDirSync(dir: string): void {
    try {
      fs.mkdirSync(dir, true);
    } catch (error) {
      // 目录已存在时 mkdirSync 会抛错，只有确实不可用时才向上抛
      if (!this.fileExists(dir)) {
        throw new Error(`创建草稿目录失败：${describeError(error)}`);
      }
    }
  }

  private writeTextSync(path: string, text: string): void {
    let file: fs.File | null = null;
    try {
      file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, text);
    } catch (error) {
      throw new Error(`写入草稿失败（${path}）：${describeError(error)}`);
    } finally {
      if (file !== null) {
        fs.closeSync(file);
      }
    }
  }
}

/** 全局单例。 */
export const draftStore: DraftStore = new DraftStore();
