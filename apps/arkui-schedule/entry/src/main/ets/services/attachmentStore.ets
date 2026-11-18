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
import { imageEntryName } from '../model/pageObjects';
import { fileIo as fs } from '@kit.CoreFileKit';
import type { PageShotRef } from '../model/attachments';
import {
  attachmentFileName,
  buildArchivedAttachmentRefs,
  dayArchiveName,
  isLegacyAttachment,
  jpegFileName
} from '../model/attachments';
import { sha256Hex } from '../model/sha256';
import type { Attachment } from '../model/types';
import { describeError, scheduleStore } from './scheduleStore';
import { GitSyncService } from './GitSyncService';
import type { ZipEntryInput } from './GitSyncService';

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

/** 待归档的插图条目（sha256 + zip 条目名）。 */
export interface ArchiveImageEntry {
  sha256: string;
  entry: string;
}

/** 保存插图后的返回值（sha256 + zip 条目名）。 */
export interface SavedImage {
  sha256: string;
  entry: string;
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

  // ------------------------------------------------------------------ 附件：JPEG + 按天 zip（2026-11）

  /** 本地源图目录（**不进仓库**）：`<filesDir>/attachments-src`。 */
  sourceDir(): string {
    return `${scheduleStore.getFilesDir()}/attachments-src`;
  }

  /** 本地源图路径：`<filesDir>/attachments-src/<sha>.jpg`。 */
  sourcePath(sha256: string): string {
    return `${this.sourceDir()}/${jpegFileName(sha256)}`;
  }

  /** 解压缓存目录（详情页取图用）：`<filesDir>/cache/attachments`。 */
  cacheDir(): string {
    return `${scheduleStore.getFilesDir()}/cache/attachments`;
  }

  /**
   * 保存一页 **JPEG** 到本地源图目录（按 sha256 去重）。
   *
   * 只落本地：仓库里只允许出现按天的 zip（见 `archiveDay`），散图不进 git。
   * 返回的引用还没有 `archive/entry`，由 `archiveDay()` 补齐后再写进 JSONL。
   */
  savePageJpeg(bytes: ArrayBuffer, pageIndex: number): Attachment {
    if (!scheduleStore.isReady()) {
      throw new Error('附件存储尚未初始化：请先调用 attachmentStore.ensureReady(context)');
    }
    if (bytes === undefined || bytes === null || bytes.byteLength === 0) {
      throw new Error('截图内容为空，无法保存附件');
    }
    const sha256 = sha256Hex(new Uint8Array(bytes));
    const path = this.sourcePath(sha256);
    if (!this.fileExists(path)) {
      this.ensureDir(this.sourceDir(), '创建源图目录失败');
      this.writeFileSync(path, bytes);
    }
    return { sha256: sha256, name: jpegFileName(sha256), pageIndex: pageIndex };
  }

  /**
   * 把「插入的原始图片」也打进当天 zip（条目名 `image-<sha8>.<ext>`）。
   *
   * 与 `archiveDay()` 分开：页 JPEG 用 `page-<N>-<sha8>.jpg`，插图用 `image-<sha8>.<ext>`，
   * 两者共用同一个 zip（合并写、同名覆盖），因此可以分开调用、互不覆盖。
   */
  async archiveImages(dateKey: string, images: ArchiveImageEntry[]): Promise<number> {
    if (images.length === 0) {
      return 0;
    }
    const sync: GitSyncService | null = GitSyncService.active();
    if (sync === null) {
      throw new Error('同步桥未就绪：无法打包插图');
    }
    const archivePath: string = `${this.attachmentsDir()}/${dayArchiveName(dateKey)}`;
    const entries: ZipEntryInput[] = [];
    for (let index = 0; index < images.length; index++) {
      const item = images[index];
      const source: string = this.sourcePath(item.sha256);
      if (!this.fileExists(source)) {
        continue; // 源图缺失：跳过，不阻塞其它条目
      }
      const bytes: ArrayBuffer = this.readSourceBytes(item.sha256);
      entries.push({ name: item.entry, chunks: this.toChunks(bytes) });
    }
    if (entries.length === 0) {
      return 0;
    }
    await sync.zipUpsert(archivePath, entries);
    console.info(`[hw] archive images=${entries.length} file=${dayArchiveName(dateKey)}`);
    return entries.length;
  }

  /**
   * 保存一张「插入的图片」（JPEG 字节）到本地源目录，返回 sha256 与 zip 条目名。
   *
   * 与 `savePageJpeg` 同一条落盘链路（按 sha256 去重），区别只在条目命名（`image-…`）。
   */
  saveImageJpeg(bytes: ArrayBuffer, ext: string): SavedImage {
    if (!scheduleStore.isReady()) {
      throw new Error('附件存储尚未初始化：请先调用 attachmentStore.ensureReady(context)');
    }
    if (bytes === undefined || bytes === null || bytes.byteLength === 0) {
      throw new Error('图片内容为空，无法保存');
    }
    const sha256: string = sha256Hex(new Uint8Array(bytes));
    const path: string = this.sourcePath(sha256);
    if (!this.fileExists(path)) {
      this.ensureDir(this.sourceDir(), '创建源图目录失败');
      this.writeFileSync(path, bytes);
    }
    return { sha256: sha256, entry: imageEntryName(sha256, ext) };
  }

  /** 读本地源图 URI（画布插图预览用；已落盘才可用）。 */
  sourceUri(sha256: string): string {
    return `file://${this.sourcePath(sha256)}`;
  }

  /**
   * 把某一天的附件打包进 `devices/<deviceId>/attachments/<YYYY-MM-DD>.zip`（合并写，同名覆盖）。
   *
   * 桥（JSZip）不可用或写入失败时抛错 —— 调用方据此回退到「散图引用」，不丢手迹。
   */
  async archiveDay(dateKey: string, pages: PageShotRef[]): Promise<Attachment[]> {
    const refs: Attachment[] = buildArchivedAttachmentRefs(pages, dateKey);
    if (refs.length === 0) {
      return refs;
    }
    const sync: GitSyncService | null = GitSyncService.active();
    if (sync === null) {
      throw new Error('同步桥未就绪：无法打包当日 zip');
    }
    const archivePath: string = `${this.attachmentsDir()}/${dayArchiveName(dateKey)}`;
    const entries: ZipEntryInput[] = [];
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index];
      const source: string = this.sourcePath(ref.sha256);
      if (!this.fileExists(source)) {
        continue; // 源图缺失（被清理过）：跳过该页，不阻塞其它页打包
      }
      const bytes: ArrayBuffer = this.readSourceBytes(ref.sha256);
      entries.push({ name: ref.entry === undefined ? ref.name : ref.entry, chunks: this.toChunks(bytes) });
    }
    if (entries.length === 0) {
      return refs;
    }
    await sync.zipUpsert(archivePath, entries);
    console.info(`[hw] archive ${dayArchiveName(dateKey)} entries=${entries.length}`);
    return refs;
  }

  /**
   * 详情页取图：返回可直接给 `Image()` 的文件 URI。
   *
   * - 新格式（有 `archive` + `entry`）：从 zip 解到 `cache/attachments/<sha>.jpg`，**命中不重复解压**；
   * - 旧格式（无 `archive`）：直接读散图 `attachments/<name>`（PNG），不迁移、不报错。
   */
  async resolveImageUri(item: Attachment): Promise<string> {
    if (isLegacyAttachment(item) || item.archive === undefined || item.entry === undefined) {
      return this.attachmentUri(item.sha256);
    }
    const cached: string = `${this.cacheDir()}/${jpegFileName(item.sha256)}`;
    if (this.fileExists(cached)) {
      return `file://${cached}`;
    }
    const sync: GitSyncService | null = GitSyncService.active();
    if (sync === null) {
      throw new Error('同步桥未就绪：无法解压附件');
    }
    const archivePath: string = `${this.attachmentsDir()}/${item.archive}`;
    const bytes: Uint8Array | null = await sync.zipRead(archivePath, item.entry);
    if (bytes === null) {
      throw new Error(`附件条目不存在：${item.archive}/${item.entry}`);
    }
    this.ensureDir(this.cacheDir(), '创建解压缓存目录失败');
    this.writeFileSync(cached, this.toArrayBuffer(bytes));
    return `file://${cached}`;
  }

  // ------------------------------------------------------------------ 内部实现

  /** 读本地源图字节（`attachments-src/<sha>.jpg`；不存在抛中文错误）。 */
  readSourceBytes(sha256: string): ArrayBuffer {
    const path: string = this.sourcePath(sha256);
    if (!this.fileExists(path)) {
      throw new Error(`源图不存在：${path}`);
    }
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
  }

  /** 把字节切成 ≤192KB 原始 / 块的 base64 分块（与桥的 ZIP_CHUNK_BYTES 一致）。 */
  private toChunks(bytes: ArrayBuffer): string[] {
    const raw: Uint8Array = new Uint8Array(bytes);
    const chunkBytes: number = 192 * 1024;
    const chunks: string[] = [];
    for (let offset = 0; offset < raw.length; offset += chunkBytes) {
      const end: number = Math.min(offset + chunkBytes, raw.length);
      chunks.push(GitSyncService.encodeBase64(raw.subarray(offset, end)));
    }
    return chunks;
  }

  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy: Uint8Array = new Uint8Array(bytes.length);
    copy.set(bytes);
    return copy.buffer;
  }

  private ensureDir(dir: string, message: string): void {
    try {
      fs.mkdirSync(dir, true);
    } catch (error) {
      if (!this.fileExists(dir)) {
        throw new Error(`${message}：${describeError(error)}`);
      }
    }
  }

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
