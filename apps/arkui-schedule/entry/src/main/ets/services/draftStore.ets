/**
 * 草稿存储：`<filesDir>/drafts/<key>.json`（应用沙箱文件，不用 preferences）。
 *
 * 为什么不放 preferences：草稿是「整页笔迹 + 框」的结构化数据，几 KB 到几百 KB，
 * preferences 只适合小标量（`handwriting.tipShown` 那种）；编辑页正文草稿同理（可能上万字）。
 *
 * 两套使用方，同一套落盘机制：
 * - 手写板：`saveDraftSync` / `readDraftSync` / `deleteDraftSync`（`key` 是 `new-<ts>` 这类 draftKey）；
 * - 编辑页正文：`saveTextSync` / `readTextSync` / `removeTextSync`（`key` 是 `editor.draft.<recordId>`，
 *   见 `model/editorDraft.ts`）。
 *
 * 约定：
 * - **原子替换**：先写 `.tmp`，再 `renameSync` 覆盖正式文件；
 * - 鸿蒙上「`renameSync` 覆盖已存在目标」**未经真机验证（unverified）**：失败时回落到
 *   「删旧 → 改名」（旧行为）。回落路径中间被杀仍有小窗口，但那种残留 `.tmp` 会被下面的
 *   启动扫描接住——**任何一条路都不许直接抛平台差异**；
 * - **启动扫描**：进程内第一次访问草稿目录时扫一遍残留 `.tmp`（正式文件不在就顶上去，
 *   已在就清掉），`readTextAtPath` 也会先看正式文件、再看 `.tmp`（双保险）；
 * - 读取失败/JSON 损坏由 `model/draft.ts` 的 `parseDraft()` / `model/editorDraft.ts` 的
 *   `parseEditorDraft()` 判定，本类只负责字节；
 * - 页面路径与文件名都由 `sanitizeDraftKey()` 清洗，不会目录穿越。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { DRAFT_DIR_NAME, draftFileName } from '../model/draft';
import { describeError, scheduleStore } from './scheduleStore';

/** 临时文件后缀（写完 rename 成正式文件）。 */
const TMP_SUFFIX: string = '.tmp';

export class DraftStore {
  /**
   * 是否已经扫过残留 `.tmp`（进程内只扫一次）。
   *
   * 为什么不是「每个 store 方法都扫」：`listFileSync` 是 IO，输入去抖路径上每 1s 一次足够，
   * 每次都扫没必要；启动后第一次访问草稿目录时扫一次，正好覆盖「上次被杀」的场景。
   */
  private swept: boolean = false;

  /** 草稿目录（`<filesDir>/drafts`）。 */
  draftsDir(): string {
    return `${scheduleStore.getFilesDir()}/${DRAFT_DIR_NAME}`;
  }

  /** 某份草稿的绝对路径。 */
  draftPath(draftKey: string): string {
    return `${this.draftsDir()}/${draftFileName(draftKey)}`;
  }

  /** 草稿是否存在（`.tmp` 残留会在本方法里先被恢复/清理）。 */
  hasDraft(draftKey: string): boolean {
    if (!scheduleStore.isReady()) {
      return false;
    }
    this.sweepTempFilesOnce();
    return this.fileExists(this.draftPath(draftKey));
  }

  /**
   * 写手写板草稿（原子替换）。
   *
   * 失败抛中文错误（调用方只 toast，不阻塞退出）。
   */
  saveDraftSync(draftKey: string, json: string): void {
    this.saveTextSync(draftKey, json);
  }

  /**
   * 写一份文本草稿（编辑页正文/标题也走这里）。
   *
   * 失败抛中文错误：**调用方必须让用户看见**（编辑页显示 danger 文案），不许静默吞掉。
   */
  saveTextSync(draftKey: string, text: string): void {
    if (!scheduleStore.isReady()) {
      throw new Error('草稿存储尚未初始化：请先调用 scheduleStore.ensureReady(context)');
    }
    this.ensureDirSync(this.draftsDir());
    this.sweepTempFilesOnce();
    this.writeAtomically(this.draftPath(draftKey), text);
  }

  /** 读手写板草稿文本；不存在返回空串（不抛）。 */
  readDraftSync(draftKey: string): string {
    return this.readTextSync(draftKey);
  }

  /** 读文本草稿；不存在返回空串（读失败才抛，`.tmp` 残留会被认）。 */
  readTextSync(draftKey: string): string {
    return this.readTextAtPath(this.draftPath(draftKey));
  }

  /** 丢弃手写板草稿（不存在也当成功；用于「完成且 OCR 成功」与损坏文件清理）。 */
  deleteDraftSync(draftKey: string): void {
    this.removeTextSync(draftKey);
  }

  /**
   * 删除一份文本草稿（不存在也当成功）。
   *
   * 只删正式文件；`.tmp` 由下一次启动扫描清理（删一半被杀只是残留，不会把内容变成错的）。
   */
  removeTextSync(draftKey: string): void {
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

  // ------------------------------------------------------------------ 原子落盘

  /**
   * 原子写：`.tmp` → 覆盖式 rename，失败再回落「删旧 → 改名」。
   *
   * 「覆盖式 rename」在鸿蒙上的行为 **unverified**（没真机验证过）。
   * 这里两条路都走一遍，任一条成功即可；都失败时清掉 `.tmp` 并抛中文错误，
   * 让上层能明确告诉用户「草稿没写进去」。
   */
  private writeAtomically(path: string, text: string): void {
    const tmpPath: string = `${path}${TMP_SUFFIX}`;
    this.writeTextSync(tmpPath, text);
    let overwriteReason: string = '';
    try {
      // ① 首选：rename 直接覆盖（原子，中间没有「正式文件不存在」的窗口）
      fs.renameSync(tmpPath, path);
      return;
    } catch (error) {
      // 平台不接受覆盖式 rename —— 记下原因，走回落分支
      overwriteReason = describeError(error);
    }
    try {
      // ② 回落：删旧 → 改名（旧行为；窗口很小，但残留 .tmp 会被启动扫描接住）
      if (this.fileExists(path)) {
        fs.unlinkSync(path);
      }
      fs.renameSync(tmpPath, path);
    } catch (error) {
      this.cleanupTemp(tmpPath);
      throw new Error(
        `保存草稿失败（${path}）：覆盖式改名失败（${overwriteReason}），删旧后改名也失败（${describeError(error)}）`
      );
    }
  }

  /** 读一份草稿：正式文件优先；正式文件不在时看 `.tmp`（上次写在改名之前被杀的现场）。 */
  private readTextAtPath(path: string): string {
    if (!scheduleStore.isReady()) {
      return '';
    }
    this.sweepTempFilesOnce();
    const tmpPath: string = `${path}${TMP_SUFFIX}`;
    if (this.fileExists(path)) {
      try {
        return fs.readTextSync(path);
      } catch (error) {
        throw new Error(`读取草稿失败（${path}）：${describeError(error)}`);
      }
    }
    if (this.fileExists(tmpPath)) {
      try {
        return fs.readTextSync(tmpPath);
      } catch (error) {
        throw new Error(`读取草稿失败（${tmpPath}）：${describeError(error)}`);
      }
    }
    return '';
  }

  /**
   * 启动扫描（进程内一次）：处理草稿目录里的残留 `.tmp`。
   *
   * - 正式文件**不在** → 上次是在「删旧 → 改名」之间被杀的：把 `.tmp` 顶上去（恢复内容）；
   * - 正式文件**在** → `.tmp` 是写了一半的旧内容：删掉，别让它越积越多。
   *
   * 扫描本身失败（目录不存在 / 无权限 / 单个文件删不掉）只跳过，绝不影响正常读写。
   */
  private sweepTempFilesOnce(): void {
    if (this.swept) {
      return;
    }
    if (!scheduleStore.isReady()) {
      // 还没就绪：留到下次（此时也不该有草稿目录）
      return;
    }
    this.swept = true;
    const dir: string = this.draftsDir();
    let names: string[] = [];
    try {
      if (!this.fileExists(dir)) {
        return;
      }
      names = fs.listFileSync(dir);
    } catch {
      return;
    }
    for (let index = 0; index < names.length; index++) {
      const name: string = names[index];
      if (!name.endsWith(TMP_SUFFIX) || name.length <= TMP_SUFFIX.length) {
        continue;
      }
      const tmpPath: string = `${dir}/${name}`;
      const finalPath: string = `${dir}/${name.slice(0, name.length - TMP_SUFFIX.length)}`;
      try {
        if (this.fileExists(finalPath)) {
          fs.unlinkSync(tmpPath);
        } else {
          fs.renameSync(tmpPath, finalPath);
        }
      } catch {
        // 单个文件处理失败不阻塞其它文件（下次启动再试）
      }
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

  private cleanupTemp(tmpPath: string): void {
    try {
      if (this.fileExists(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // 清理失败不影响主流程（启动扫描会兜底）
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
