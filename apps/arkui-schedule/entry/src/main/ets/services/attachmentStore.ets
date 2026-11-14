/**
 * 手写截图附件存储：`<filesDir>/git-repo/devices/<deviceId>/attachments/<sha256>.png`。
 *
 * 契约（`docs/DATA-CONTRACT.md` §3、BRIEF §3.2）：
 * - 按 sha256 去重命名，同一张图重复保存只落一份；
 * - 手写板每页在 OCR **之前** 就先落盘，OCR 失败也能凭截图人工补录；
 * - 读取返回 `ArrayBuffer`（详情页预览与二次校验都用它）。
 *
 * 说明：共享层（main）禁止引用 `@kit.ImageKit` / PixelMap（validate 规则 4），
 * 因此详情页预览用沙箱文件 URI（`file://<绝对路径>`）交给 `Image()`，不在这里解码像素。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { attachmentFileName } from '../model/attachments';
import { sha256Hex } from '../model/sha256';
import type { Attachment } from '../model/types';
import { describeError, scheduleStore } from './scheduleStore';

/** 校验 sha256 形状（64 位十六进制），防止用非法文件名拼出目录穿越路径。 */
export function isValidSha256(value: string): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value.trim().toLowerCase());
}

/** 解析手写页回传的 `Attachment[]` JSON（坏数据一律跳过，不让页面崩）。 */
export function parseAttachmentList(json: string): Attachment[] {
  const list: Attachment[] = [];
  const text = typeof json === 'string' ? json.trim() : '';
  if (text.length === 0) {
    return list;
  }
  let parsed: Attachment[] = [];
  try {
    parsed = JSON.parse(text) as Attachment[];
  } catch {
    return list;
  }
  if (!Array.isArray(parsed)) {
    return list;
  }
  for (const item of parsed) {
    if (item === null || item === undefined) {
      continue;
    }
    if (!isValidSha256(item.sha256) || typeof item.name !== 'string' || typeof item.pageIndex !== 'number') {
      continue;
    }
    list.push({ sha256: item.sha256.trim().toLowerCase(), name: item.name, pageIndex: item.pageIndex });
  }
  list.sort((left: Attachment, right: Attachment) => left.pageIndex - right.pageIndex);
  return list;
}

export class AttachmentStore {
  /** 等待存储层就绪（页面进入时调用）。 */
  async ensureReady(context: object): Promise<void> {
    await scheduleStore.ensureReady(context);
  }

  isReady(): boolean {
    return scheduleStore.isReady();
  }

  attachmentsDir(): string {
    return scheduleStore.attachmentsDir();
  }

  /** 附件的绝对沙箱路径。 */
  attachmentPath(sha256: string): string {
    return `${scheduleStore.attachmentsDir()}/${attachmentFileName(sha256)}`;
  }

  /** 交给 `Image()` 的沙箱文件 URI。 */
  attachmentUri(sha256: string): string {
    return `file://${this.attachmentPath(sha256)}`;
  }

  hasAttachment(sha256: string): boolean {
    return this.fileExists(this.attachmentPath(sha256));
  }

  /**
   * 保存一页截图并返回附件引用（按 sha256 去重；已存在则不重复写盘）。
   * 同步落盘：返回时文件已可被 OCR / 预览读取。
   */
  savePageAttachment(bytes: ArrayBuffer, pageIndex: number): Attachment {
    if (!scheduleStore.isReady()) {
      throw new Error('附件存储尚未初始化：请先调用 attachmentStore.ensureReady(context)');
    }
    if (bytes === undefined || bytes === null || bytes.byteLength === 0) {
      throw new Error('截图内容为空，无法保存附件');
    }
    const sha256 = sha256Hex(new Uint8Array(bytes));
    const name = attachmentFileName(sha256);
    const path = this.attachmentPath(sha256);
    if (!this.fileExists(path)) {
      try {
        fs.mkdirSync(scheduleStore.attachmentsDir(), true);
      } catch (error) {
        // 目录已存在时 mkdirSync 会抛错，这里只在目录确实不可用时才向上抛
        if (!this.fileExists(scheduleStore.attachmentsDir())) {
          throw new Error(`创建附件目录失败：${describeError(error)}`);
        }
      }
      this.writeFileSync(path, bytes);
    }
    return { sha256: sha256, name: name, pageIndex: pageIndex };
  }

  /** 单页保存的便捷入口（pageIndex 固定 0，适合非分页场景）。 */
  async saveAttachment(bytes: ArrayBuffer): Promise<Attachment> {
    return this.savePageAttachment(bytes, 0);
  }

  /** 读取附件字节（不存在或读失败抛中文错误）。 */
  readAttachment(sha256: string): Promise<ArrayBuffer> {
    return Promise.resolve(this.readAttachmentSync(sha256));
  }

  readAttachmentSync(sha256: string): ArrayBuffer {
    const path = this.attachmentPath(sha256);
    if (!this.fileExists(path)) {
      throw new Error(`附件不存在：${path}`);
    }
    try {
      const stat = fs.statSync(path);
      const buffer = new ArrayBuffer(stat.size);
      const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
      try {
        if (stat.size > 0) {
          fs.readSync(file.fd, buffer, { offset: 0, length: stat.size });
        }
      } finally {
        fs.closeSync(file);
      }
      return buffer;
    } catch (error) {
      throw new Error(`读取附件失败（${path}）：${describeError(error)}`);
    }
  }

  /** 列出已落盘的附件文件名（自检/排障用）。 */
  listAttachmentNames(): string[] {
    const dir = scheduleStore.attachmentsDir();
    if (!this.fileExists(dir)) {
      return [];
    }
    try {
      return fs.listFileSync(dir);
    } catch (error) {
      throw new Error(`列出附件目录失败：${describeError(error)}`);
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

  private writeFileSync(path: string, bytes: ArrayBuffer): void {
    let file: fs.File | null = null;
    try {
      file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, bytes);
    } catch (error) {
      throw new Error(`写入附件失败（${path}）：${describeError(error)}`);
    } finally {
      if (file !== null) {
        fs.closeSync(file);
      }
    }
  }
}

/** 全局单例。 */
export const attachmentStore: AttachmentStore = new AttachmentStore();
