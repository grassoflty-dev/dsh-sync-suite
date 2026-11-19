/**
 * 日程编辑视图（可嵌入 Edit 页，也可作为首页横屏主从布局的右栏）。
 *
 * 入参是**记录 id**（`''` = 新建）：编辑已有记录时保留原 id / 原日期 / 原 `ocr_text` /
 * 原 `attachments` / 原 `ocr_time`，正文或标题变更后置 `ai_processed:false` 等重新整理。
 *
 * 契约：BRIEF §3.2、§3.5、`docs/CONTRACT.md` §3.4：
 * - 保存 = 追加一条记录（新 id 用 `newRecordId()`；已有记录保留 id、ts 用 `nextTsSameDate()`）；
 * - 手写板入口仅在 `getFeatures().handwriting` 为真时显示，回填走 AppStorage：
 *   容器在页面 `onPageShow` 里把 `refreshTick` 加一，组件在 `@Watch` 里读取并**立即清除**三个键。
 *
 * 草稿（`docs/FAILURE-MODES.md` §6 的两条 P1）：
 * - 输入变化后按 `EDITOR_DRAFT_MIN_INTERVAL_MS`（1s）去抖，把标题/正文写进磁盘草稿
 *   （`draftStore.saveTextSync`，键 = `editor.draft.<recordId>`）→ 进程被杀最多丢 1s 输入；
 * - 一条记录一把键：`restoreDraft` **先算本记录的键、先比对 `recordId`**，再决定恢复，
 *   绝不先清别的记录的键（旧实现从记录 A 切到 B 时会把 A 的草稿清掉）；
 * - 恢复时给一行灰字提示 + 「丢弃草稿」入口；写盘失败显示 danger 文案（不静默、内存态保留）。
 */
import { promptAction, router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { nextTsSameDate, nowIso, localDateKey } from '../common/date';
import { getFeatures } from '../common/features';
import { handwritingPageRoute } from '../common/platformFeatures';
import type { Attachment, ScheduleRecord } from '../model/types';
import {
  EDITOR_DRAFT_MIN_INTERVAL_MS,
  describeRestore,
  dirtyAgainst,
  draftKey,
  parseEditorDraft,
  serializeEditorDraft,
  shouldPersistDraft
} from '../model/editorDraft';
import type { EditorDraft, EditorText } from '../model/editorDraft';
import { SAVED_MARKER_KEY, encodeSavedMarker } from '../model/homeRefresh';
import type { SavedMarker } from '../model/homeRefresh';
import { newRecordId, resolveRecordDate, scheduleStore, describeError } from '../services/scheduleStore';
import { settingsStore } from '../services/settingsStore';
import { attachmentStore, parseAttachmentList } from '../services/attachmentStore';
import { draftStore } from '../services/draftStore';
import { loadingText, toastMsFor } from '../common/copy';
import { DIVIDER, FONT, LINE_HEIGHT, RADIUS, SPACING, TOUCH_MIN } from '../common/uiTokens';
import { ActionButton } from './ActionButton';
import { StateView } from './StateView';

const INPUT_HEIGHT: number = 44;
const BODY_HEIGHT: number = 200;
const PRIMARY_HEIGHT: number = 48;
const THUMB: number = 88;

/**
 * 去抖间隔（ms）：停手 1s 内必定落盘，崩溃最多丢 1s 输入。
 *
 * 真值定义在 `model/editorDraft.ts`（那里有 Node 单测），这里只是给本文件用的本地别名，
 * 避免组件里出现第二个魔法数字。
 */
const DRAFT_MIN_INTERVAL_MS: number = EDITOR_DRAFT_MIN_INTERVAL_MS;

/** 按 sha256 合并两批附件（去重、按 pageIndex 升序）。 */
function mergeAttachments(base: Attachment[], incoming: Attachment[]): Attachment[] {
  const merged: Attachment[] = [];
  for (const item of base) {
    merged.push(item);
  }
  for (const item of incoming) {
    let exists = false;
    for (const kept of merged) {
      if (kept.sha256 === item.sha256 && kept.pageIndex === item.pageIndex) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      merged.push(item);
    }
  }
  merged.sort((left: Attachment, right: Attachment) => left.pageIndex - right.pageIndex);
  return merged;
}

@Component
export struct RecordEditorView {
  /** 要编辑的记录 id；空串 = 新建。 */
  @Prop recordId: string = '';
  /** 新建时用于副标题提示的日期（可空）。 */
  @Prop defaultDate: string = '';
  /**
   * 是否让标题输入框在挂载时自动获得焦点（省掉「点标题」这一次 tap）。
   *
   * 只有「新建记录且没有草稿内容」才聚焦：已有记录不聚焦，避免软键盘遮挡正文、
   * 也避免用户误改标题。真正是否聚焦由 `defaultFocus` 的表达式再判一次
   * （`recordId` 为空 且 `title` 为空白），双保险。
   */
  @Prop autoFocusTitle: boolean = false;
  /** 容器在页面 `onPageShow` 时 +1（手写板返回后回填）。 */
  @Prop @Watch('onRefreshTick') refreshTick: number = 0;
  /** 保存成功回调：带上刚追加的记录。 */
  onSaved: (record: ScheduleRecord) => void = () => {};
  /** 取消回调；为 null 时不渲染「取消」。 */
  onCancel: (() => void) | null = null;
  /** 脏状态变化（容器用它做「放弃未保存内容？」提示）。 */
  onDirtyChange: ((dirty: boolean) => void) | null = null;
  /**
   * 容器登记「返回守卫」用的两个动作（返回键 / 返回手势要**同步**问「脏不脏」）。
   *
   * - `probe()`：同步返回当前是否脏（不抛）；
   * - `discard()`：用户确认「放弃修改」后要执行的清草稿动作。
   *
   * 默认 `null` = 不登记：既有装配（Index 主从右栏只传 `onDirtyChange`）行为不变。
   */
  onRegisterGuard: ((probe: () => boolean, discard: () => void) => void) | null = null;

  @State title: string = '';
  @State body: string = '';
  @State author: string = '';
  @State done: boolean = false;
  @State ocrText: string = '';
  @State attachments: Attachment[] = [];
  /** 手写板插入对象（v2 按页文档 JSON；来自 AppStorage handwriting.pageObjects）。 */
  @State pageObjectsJson: string = '';
  @State handwritingAvailable: boolean = false;
  @State ready: boolean = false;
  @State statusText: string = '';
  @State saving: boolean = false;
  /** 恢复提示（空 = 没恢复任何草稿，不占一行）。 */
  @State draftHint: string = '';
  /** 草稿写盘失败原因（空 = 正常）；非空时显示 danger 文案，内存态仍可编辑。 */
  @State draftError: string = '';

  private originalTitle: string = '';
  private originalBody: string = '';
  private originalTs: string = '';
  private originalOcrTime: string = '';
  private originalAiStructured: string = '';
  private originalAiProcessed: boolean = false;
  private loaded: boolean = false;
  private lastDirty: boolean = false;
  /** 最近一次落盘的草稿快照（`null` = 本记录还没落过盘）：去抖比较用。 */
  private lastPersistDraft: EditorDraft | null = null;
  /** 最近一次落盘时刻（ms）：去抖的「距上次落盘」用它。 */
  private lastPersistAt: number = 0;
  /** 尾部落盘定时器句柄（`-1` = 没排）。 */
  private persistTimer: number = -1;

  aboutToAppear(): void {
    this.handwritingAvailable = getFeatures().handwriting;
    const registrar: ((probe: () => boolean, discard: () => void) => void) | null = this.onRegisterGuard;
    if (registrar !== null) {
      const probe: () => boolean = (): boolean => this.isDirty();
      const discard: () => void = (): void => {
        this.discardDraft();
      };
      registrar(probe, discard);
    }
    this.bootstrap();
  }

  /**
   * 卸载时（旋转到单列 / 切走 / 页面退出）把未保存内容写进**本记录专属**草稿。
   *
   * 两条路都写：
   * - `AppStorage`（键 = `draftKey(recordId)`）：同进程内回挂（旋转/切栏）不必等 IO；
   * - 磁盘（`draftStore.saveTextSync`）：进程被杀后仍能恢复。
   *
   * 磁盘写失败在这里**无处显示**（组件已卸载）：内存稿还在，下次挂载先从内存稿恢复，
   * 首次输入会重试落盘；能显示的场景（输入去抖写盘）在 `persistNow()` 里报 danger 文案。
   */
  aboutToDisappear(): void {
    this.clearPersistTimer();
    const saved: EditorText = { title: this.originalTitle, body: this.originalBody };
    const current: EditorText = { title: this.title, body: this.body };
    const key: string = draftKey(this.recordId);
    if (!dirtyAgainst(saved, current)) {
      // 与磁盘记录一致：草稿没意义，清掉本键（不会碰别的记录）
      this.forgetDraft(key);
      return;
    }
    const draft: EditorDraft = this.buildDraft(Date.now());
    const encoded: string = serializeEditorDraft(draft);
    AppStorage.setOrCreate<string>(key, encoded);
    try {
      draftStore.saveTextSync(key, encoded);
    } catch (error) {
      // 见方法头：此处无 UI 可报；内存稿已存，下次挂载会重试
    }
  }

  /**
   * 挂载时恢复**本记录专属**的草稿。
   *
   * 顺序契约（`tools/test/editorDraft.test.mjs` 有静态断言盯着）：
   * ① 先按当前 `recordId` 算键（`draftKey(this.recordId)`）并只读这把键；
   * ② 只有 `draft.recordId` 与 `this.recordId` **匹配**才用草稿覆盖表单；
   * ③ 最后才清「本记录」的键——别的记录的键一个字都不碰
   *    （旧实现先 `setOrCreate(DRAFT_KEY, '')` 再比对，从 A 切到 B 就把 A 的草稿销毁了）。
   */
  private restoreDraft(): boolean {
    const key: string = draftKey(this.recordId);
    this.draftHint = '';
    const memoryDraft: EditorDraft | null = this.readMemoryDraft(key);
    let diskDraft: EditorDraft | null = null;
    try {
      diskDraft = parseEditorDraft(draftStore.readTextSync(key));
    } catch (error) {
      // 读盘失败不算「没有草稿」：内存里那份还能用，下面的 savedAt 比较会挑它
      diskDraft = null;
    }
    const draft: EditorDraft | null = this.pickNewerDraft(memoryDraft, diskDraft);
    if (draft === null || draft.recordId !== this.recordId) {
      return false;
    }
    const hint: string = describeRestore(draft, Date.now());
    if (hint.length === 0) {
      // 空草稿（标题正文全空/只有空白）：没有可恢复内容，顺手清掉本键
      this.forgetDraft(key);
      return false;
    }
    this.title = draft.title;
    this.body = draft.body;
    this.draftHint = hint;
    this.draftError = '';
    this.lastPersistDraft = draft;
    this.lastPersistAt = draft.savedAt;
    // 内存稿已经进表单：只清本记录这一把键（`key` 由本次 recordId 算出来）
    AppStorage.setOrCreate<string>(key, '');
    return true;
  }

  /** 读内存稿（键即按记录分槽的草稿键）；没有/脏数据返回 null。 */
  private readMemoryDraft(key: string): EditorDraft | null {
    const raw: string | undefined = AppStorage.get<string>(key);
    if (raw === undefined || raw.length === 0) {
      return null;
    }
    return parseEditorDraft(raw);
  }

  /** 两份草稿取 `savedAt` 较新的一份（相等取内存稿：它是本次进程里更新的）。 */
  private pickNewerDraft(memoryDraft: EditorDraft | null, diskDraft: EditorDraft | null): EditorDraft | null {
    if (memoryDraft === null) {
      return diskDraft;
    }
    if (diskDraft === null) {
      return memoryDraft;
    }
    return memoryDraft.savedAt >= diskDraft.savedAt ? memoryDraft : diskDraft;
  }

  /** 页面从手写板返回时触发回填；回填到内容时再决定要不要自动保存（B3 路径 2）。 */
  onRefreshTick(): void {
    const applied: boolean = this.applyPendingInkResult();
    this.maybeAutoSaveAfterInk(applied);
  }

  /**
   * 三态里的「重试」：清掉错误文案、退回未就绪，再重跑一次「确保存储就绪 → 读记录」。
   *
   * 失败的两种来源（`ensureReady` 失败 / `findByIdAny` 失败）都在 `bootstrap()` 里，
   * 所以重试必须整条链路重来，只 `loadRecord()` 会在存储未就绪时立刻再失败一次。
   */
  private retryLoad(): void {
    this.statusText = '';
    this.ready = false;
    this.bootstrap();
  }

  /** 错误标题：取 `statusText` 冒号前那半句，取不到给通用标题。 */
  private statusTitle(): string {
    const cut: number = this.statusText.indexOf('：');
    if (cut > 0) {
      return this.statusText.slice(0, cut);
    }
    return '读取失败';
  }

  private async bootstrap(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    try {
      await scheduleStore.ensureReady(context);
      let defaultAuthor = '我';
      try {
        const settings = await settingsStore.load(context);
        defaultAuthor = settings.author.trim().length > 0 ? settings.author : '我';
      } catch (error) {
        // 读设置失败不阻断编辑：回落「我」
      }
      if (this.author.trim().length === 0) {
        this.author = defaultAuthor;
      }
      this.ready = true;
      if (this.recordId.length > 0) {
        this.loadRecord();
      } else {
        this.loaded = true;
      }
      // 有草稿（同一条记录）就优先用草稿，覆盖刚读到的记录字段
      this.restoreDraft();
    } catch (error) {
      this.ready = false;
      this.statusText = `初始化失败：${describeError(error)}`;
    }
    this.notifyDirty();
  }

  private loadRecord(): void {
    let record: ScheduleRecord | null = null;
    try {
      record = scheduleStore.findByIdAny(this.recordId);
    } catch (error) {
      this.statusText = `读取记录失败：${describeError(error)}`;
      return;
    }
    if (record === null) {
      this.statusText = '记录不存在：可能已被其他设备改写，请返回列表重试';
      return;
    }
    this.title = record.title;
    this.body = record.body;
    this.author = record.author.length > 0 ? record.author : this.author;
    this.done = record.done;
    this.ocrText = record.ocr_text === undefined ? '' : record.ocr_text;
    this.attachments = record.attachments === undefined ? [] : record.attachments;
    this.originalTitle = record.title;
    this.originalBody = record.body;
    this.originalTs = record.ts;
    this.originalOcrTime = record.ocr_time === undefined ? '' : record.ocr_time;
    this.originalAiStructured = record.ai_structured === undefined ? '' : record.ai_structured;
    this.originalAiProcessed = record.ai_processed;
    this.loaded = true;
  }

  /**
   * 手写板回填：正文、原始识别文本、截图附件、插入对象四路数据（读后立即清空键）。
   *
   * 返回 `applied` = 本次是否真的把内容回填进表单：只有内容真的进来了，调用方才值得
   * 省掉那一次「保存日程」tap；空回来（失败 / 退出 / 空笔迹）一个字都不自动写。
   */
  private applyPendingInkResult(): boolean {
    let applied: boolean = false;
    const text = AppStorage.get<string>('handwriting.result');
    if (text !== undefined && text.length > 0) {
      this.body = this.body.length > 0 ? `${this.body}\n${text}` : text;
      applied = true;
      AppStorage.setOrCreate<string>('handwriting.result', '');
    }
    const ocrText = AppStorage.get<string>('handwriting.ocrText');
    if (ocrText !== undefined && ocrText.length > 0) {
      this.ocrText = ocrText;
      applied = true;
      AppStorage.setOrCreate<string>('handwriting.ocrText', '');
    }
    const pageObjectsJson = AppStorage.get<string>('handwriting.pageObjects');
    if (pageObjectsJson !== undefined && pageObjectsJson.length > 0) {
      this.pageObjectsJson = pageObjectsJson;
      applied = true;
      AppStorage.setOrCreate<string>('handwriting.pageObjects', '');
    }
    const attachmentsJson = AppStorage.get<string>('handwriting.attachments');
    if (attachmentsJson !== undefined && attachmentsJson.length > 0) {
      const incoming = parseAttachmentList(attachmentsJson);
      if (incoming.length > 0) {
        this.attachments = mergeAttachments(this.attachments, incoming);
        applied = true;
      }
      AppStorage.setOrCreate<string>('handwriting.attachments', '');
    }
    this.notifyDirty();
    // 手写板回填也是「刚从手写板回来」的未保存输入：立刻按去抖规则落盘，别等用户再敲键
    this.schedulePersist();
    return applied;
  }

  /**
   * 手写板「完成」返回后的自动保存（B3 路径 2）：省掉「保存日程」这一 tap 与回首页那一次等待。
   *
   * 一次性键 `handwriting.autosave` 由手写板在**识别成功且有内容**时写 `'1'`；这里读后**立即清空**
   * （不管走不走自动保存），绝不让下一次进入编辑页误触发。以下情况不自动保存，只给原因并停在
   * 可继续操作的状态（`docs/FAILURE-MODES.md` §6：宁可多一步，不写半条坏记录）：
   * - 手写板没给可保存信号（识别失败 / 空笔迹 / 用户点的是「退出」）；
   * - 这次回来没有任何内容回填；
   * - 编辑页还没就绪（`ready`/`loaded` 为假：这时 `originalTs` 还没读到，保存会写出错误日期）；
   * - 标题为空（新记录必须先有标题）；
   * - 正在保存中。
   */
  private maybeAutoSaveAfterInk(applied: boolean): void {
    const flag: string | undefined = AppStorage.get<string>('handwriting.autosave');
    AppStorage.setOrCreate<string>('handwriting.autosave', '');
    if (flag !== '1' || !applied) {
      return;
    }
    if (this.saving) {
      return;
    }
    if (!this.ready || !this.loaded) {
      promptAction.showToast({ message: '手写内容已回填，但编辑页还没就绪：请稍后点「保存日程」', duration: toastMsFor(false) });
      return;
    }
    if (this.title.trim().length === 0) {
      promptAction.showToast({ message: '手写内容已回填：先填标题，再点「保存日程」', duration: toastMsFor(false) });
      return;
    }
    if (this.body.trim().length === 0 && this.attachments.length === 0 && this.pageObjectsJson.length === 0) {
      promptAction.showToast({ message: '没有可保存的内容：请补充正文后再保存', duration: toastMsFor(false) });
      return;
    }
    this.save();
  }

  private contentChanged(): boolean {
    if (!this.loaded) {
      return this.title.trim().length > 0 || this.body.length > 0;
    }
    return this.title.trim() !== this.originalTitle.trim() || this.body !== this.originalBody;
  }

  /** 脏判定：新建时只要有内容就算脏；编辑时看标题/正文是否变过。 */
  private isDirty(): boolean {
    if (this.recordId.length === 0) {
      return this.title.trim().length > 0 || this.body.length > 0 || this.attachments.length > 0;
    }
    return this.contentChanged();
  }

  private notifyDirty(): void {
    const dirty: boolean = this.isDirty();
    if (dirty === this.lastDirty) {
      return;
    }
    this.lastDirty = dirty;
    const handler: ((dirty: boolean) => void) | null = this.onDirtyChange;
    if (handler !== null) {
      handler(dirty);
    }
  }

  // ------------------------------------------------------------------ 草稿落盘

  /** 造一份当前表单的草稿快照。 */
  private buildDraft(now: number): EditorDraft {
    const draft: EditorDraft = {
      recordId: this.recordId,
      title: this.title,
      body: this.body,
      savedAt: now
    };
    return draft;
  }

  /**
   * 输入变化后的落盘决策（去抖的唯一入口）。
   *
   * - 内容回到「与磁盘记录一致」→ 草稿没有意义，删本键；
   * - `shouldPersistDraft()` 说该写 → **立刻写**（换记录永远立刻写）；
   * - 否则排一次尾部写：保证**停手 ≤1s** 后磁盘上一定是最新内容，
   *   即「进程被杀最多丢 1s 输入」。
   */
  private schedulePersist(): void {
    const now: number = Date.now();
    const saved: EditorText = { title: this.originalTitle, body: this.originalBody };
    const current: EditorText = { title: this.title, body: this.body };
    if (!dirtyAgainst(saved, current)) {
      this.clearPersistTimer();
      this.forgetDraft(draftKey(this.recordId));
      this.lastPersistDraft = null;
      this.lastPersistAt = now;
      return;
    }
    const next: EditorDraft = this.buildDraft(now);
    if (shouldPersistDraft(this.lastPersistDraft, next, DRAFT_MIN_INTERVAL_MS, now)) {
      this.persistNow(next);
      return;
    }
    const elapsed: number = now - this.lastPersistAt;
    const delay: number = elapsed >= DRAFT_MIN_INTERVAL_MS ? DRAFT_MIN_INTERVAL_MS : DRAFT_MIN_INTERVAL_MS - elapsed;
    this.scheduleTrailingPersist(delay);
  }

  /** 排一次尾部落盘（同一时刻只留一个定时器，新输入会重置）。 */
  private scheduleTrailingPersist(delay: number): void {
    this.clearPersistTimer();
    const wait: number = delay > 0 ? delay : 0;
    const timer: number = setTimeout(() => {
      this.persistTimer = -1;
      this.persistNow(this.buildDraft(Date.now()));
    }, wait);
    this.persistTimer = timer;
  }

  /**
   * 立刻写盘（唯一落盘点）。
   *
   * 写失败**不许静默**：`draftError` 显示 danger 文案，但内存态（`this.title` / `this.body`）
   * 一个字都不动——用户还能继续编辑、还能保存，只是别急着退出。
   */
  private persistNow(draft: EditorDraft): void {
    this.clearPersistTimer();
    const key: string = draftKey(draft.recordId);
    this.lastPersistDraft = draft;
    this.lastPersistAt = draft.savedAt;
    try {
      draftStore.saveTextSync(key, serializeEditorDraft(draft));
      this.draftError = '';
    } catch (error) {
      this.draftError = `草稿保存失败：${describeError(error)}（正文仍在内存里，别退出）`;
    }
  }

  private clearPersistTimer(): void {
    if (this.persistTimer >= 0) {
      clearTimeout(this.persistTimer);
      this.persistTimer = -1;
    }
  }

  /** 删掉某把草稿键（磁盘 + 内存）；两处互不拖累，失败只留下「可恢复的旧草稿」。 */
  private forgetDraft(key: string): void {
    try {
      draftStore.removeTextSync(key);
    } catch (error) {
      // 删不掉只是多一份旧草稿，不会丢内容；不打扰用户
    }
    AppStorage.setOrCreate<string>(key, '');
  }

  /**
   * 用户点「丢弃草稿」：删键 + 把表单退回保存态。
   *
   * 已有记录重读磁盘记录；新建记录清空标题/正文（作者、手迹附件保留——那是手写板已经
   * 落盘的工作，不做连带销毁）。之后内容与保存态一致，不会立刻被重新写成草稿。
   */
  private discardDraft(): void {
    this.clearPersistTimer();
    this.forgetDraft(draftKey(this.recordId));
    this.draftHint = '';
    this.draftError = '';
    this.lastPersistDraft = null;
    this.lastPersistAt = 0;
    if (this.recordId.length > 0 && this.loaded) {
      this.loadRecord();
    } else {
      this.title = '';
      this.body = '';
    }
    this.notifyDirty();
  }

  private openWritingBoard(): void {
    const route = handwritingPageRoute();
    if (route.length === 0) {
      promptAction.showToast({ message: '当前平台不支持手写板' });
      return;
    }
    // 记录日期透传给手写板：决定附件打哪一天的 zip（`attachments/<YYYY-MM-DD>.zip`）
    const dateParam: string = this.defaultDate.length === 10 ? this.defaultDate : localDateKey(new Date());
    const params: Record<string, string> = { 'date': dateParam };
    router.pushUrl({ url: route, params: params }).catch((error: Error) => {
      promptAction.showToast({ message: `打开手写板失败：${describeError(error)}` });
    });
  }

  private save(): void {
    if (this.saving) {
      return;
    }
    const title = this.title.trim();
    if (title.length === 0) {
      promptAction.showToast({ message: '请先填写标题' });
      return;
    }
    if (!scheduleStore.isReady()) {
      promptAction.showToast({ message: '存储尚未就绪，请稍后重试' });
      return;
    }
    const changed = this.contentChanged();
    const record: ScheduleRecord = {
      id: this.recordId.length > 0 ? this.recordId : newRecordId(),
      // 编辑旧记录时保留原日期（不迁到当天），时刻保证严格大于原 ts
      ts: this.recordId.length > 0 ? nextTsSameDate(this.originalTs) : nowIso(),
      title: title,
      body: this.body,
      author: this.author.trim().length > 0 ? this.author.trim() : '我',
      done: this.done,
      ai_processed: changed ? false : this.originalAiProcessed
    };
    if (this.ocrText.length > 0) {
      record.ocr_text = this.ocrText;
    }
    if (this.attachments.length > 0) {
      record.attachments = this.attachments.slice();
    }
    // 手写板插入的对象（框/图片/表格，v2 按页文档）；只在有内容时写，别给旧记录塞空串
    if (this.pageObjectsJson.length > 0) {
      record.pageObjects = this.pageObjectsJson;
    }
    if (!changed && this.originalAiStructured.length > 0) {
      record.ai_structured = this.originalAiStructured;
    }
    const ocrTime =
      this.originalOcrTime.length > 0 ? this.originalOcrTime : (this.ocrText.length > 0 ? nowIso() : '');
    if (ocrTime.length > 0) {
      record.ocr_time = ocrTime;
    }
    this.saving = true;
    try {
      scheduleStore.appendRecord(record);
    } catch (error) {
      this.saving = false;
      promptAction.showToast({ message: `保存失败：${describeError(error)}`, duration: toastMsFor(true) });
      return;
    }
    this.saving = false;
    this.originalTitle = title;
    this.originalBody = this.body;
    this.originalTs = record.ts;
    this.lastDirty = false;
    // 保存成功 = 磁盘记录已是权威内容：清掉本记录的草稿键与「已恢复…」提示
    this.clearPersistTimer();
    this.forgetDraft(draftKey(this.recordId));
    this.draftHint = '';
    this.draftError = '';
    this.lastPersistDraft = null;
    this.lastPersistAt = Date.now();
    const dirtyHandler: ((dirty: boolean) => void) | null = this.onDirtyChange;
    if (dirtyHandler !== null) {
      dirtyHandler(false);
    }
    promptAction.showToast({ message: changed ? '已保存（待 AI 整理）' : '已保存' });
    // 一次性「保存返回」标记：必须在 onSaved（它会 router.back() 触发首页 onPageShow）之前写好，
    // 首页读到就只做局部刷新（reload + 单行对账），不再跑全量对账 / 重读汇总 / 推进 paneTick。
    AppStorage.setOrCreate<string>(SAVED_MARKER_KEY, encodeSavedMarker(this.savedMarkerOf(record)));
    this.onSaved(record);
  }

  /**
   * 构造一次性「保存返回」标记。
   *
   * `date` 必须按 `ts` 算（`resolveRecordDate(record.ts)`）：编辑旧记录会保留原日期，
   * 绝不能拿 `defaultDate` / 首页 `selectedDate` 猜——跨日期编辑时两者不一致，
   * 猜了会让首页把「别的日期的保存」误判成当前列表该出现的记录。
   */
  private savedMarkerOf(record: ScheduleRecord): SavedMarker {
    const marker: SavedMarker = {
      id: record.id,
      date: resolveRecordDate(record.ts),
      ts: record.ts,
      done: record.done
    };
    return marker;
  }

  // ------------------------------------------------------------------ UI

  @Builder
  FieldLabel(text: string) {
    Text(text)
      .fontSize(FONT.caption)
      .lineHeight(LINE_HEIGHT.caption)
      .fontColor($r('app.color.text_secondary'))
      .width('100%')
      .textAlign(TextAlign.Start)
  }

  @Builder
  WritingEntry() {
    if (this.handwritingAvailable) {
      Text('手写板')
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.brand'))
        .height(TOUCH_MIN)
        .padding({ left: SPACING.md, right: SPACING.md })
        .textAlign(TextAlign.Center)
        .onClick(() => this.openWritingBoard())
    }
  }

  @Builder
  AttachmentPreview() {
    Column({ space: SPACING.sm }) {
      // 用户报的「完成后编辑页没有任何反馈」：这里明确写「手迹 N 页」（不是附件 N 个）
      Text(`手迹 ${this.attachments.length} 页`)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Start)
      List({ space: SPACING.sm }) {
        ForEach(
          this.attachments,
          (item: Attachment) => {
            ListItem() {
              Column({ space: SPACING.xs }) {
                Image(attachmentStore.attachmentUri(item.sha256))
                  .width(THUMB)
                  .height(THUMB)
                  .borderRadius(RADIUS.none)
                  .objectFit(ImageFit.Cover)
                  .backgroundColor($r('app.color.page_background'))
                Text(`第 ${item.pageIndex + 1} 页`)
                  .fontSize(FONT.caption)
                  .lineHeight(LINE_HEIGHT.caption)
                  .fontColor($r('app.color.text_secondary'))
              }
            }
          },
          (item: Attachment) => `${item.sha256}|${item.pageIndex}`
        )
      }
      .listDirection(Axis.Horizontal)
      .height(THUMB + 32)
      .width('100%')
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /**
   * 草稿状态条（编辑器顶部）。
   *
   * - 有可恢复草稿：灰字说明「已恢复 N 分钟前未保存的草稿」+「丢弃草稿」（ghost）；
   * - 写盘失败：danger 文案，明确说「正文仍在内存里，别退出」。
   *
   * 两条都为空时整块不渲染（不占高度）。
   */
  @Builder
  DraftStatus() {
    if (this.draftHint.length > 0) {
      Row({ space: SPACING.sm }) {
        Text(this.draftHint)
          .fontSize(FONT.caption)
          .lineHeight(LINE_HEIGHT.caption)
          .fontColor($r('app.color.text_secondary'))
          .layoutWeight(1)
          .textAlign(TextAlign.Start)
        ActionButton({
          label: '丢弃草稿',
          variant: 'ghost',
          block: false,
          onTap: () => {
            this.discardDraft();
          }
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    if (this.draftError.length > 0) {
      Text(this.draftError)
        .fontSize(FONT.caption)
        .lineHeight(LINE_HEIGHT.caption)
        .fontColor($r('app.color.danger'))
        .width('100%')
        .textAlign(TextAlign.Start)
    }
  }

  build() {
    Column() {
      Scroll() {
        Column({ space: SPACING.lg }) {
          // 顶部草稿提示：恢复提示（灰字 + 「丢弃草稿」）/ 写盘失败（danger 文案）
          this.DraftStatus()

          Column({ space: SPACING.xs }) {
            this.FieldLabel('标题')
            TextInput({ text: this.title, placeholder: '例如：周三项目周会' })
              .width('100%')
              .height(INPUT_HEIGHT)
              .fontSize(FONT.body)
              .backgroundColor($r('app.color.page_background'))
              .borderRadius(RADIUS.none)
              .padding({ left: 0, right: 0 })
              // 纯组件属性、零新 API：仅「新建且标题未被草稿填入」时自动聚焦。
              // 不用 focusControl.requestFocus / getUIContext()——本机无 DevEco/SDK，无法验证新增 import。
              .defaultFocus(this.autoFocusTitle && this.recordId.length === 0 && this.title.trim().length === 0)
              .onChange((value: string) => {
                this.title = value;
                this.notifyDirty();
                this.schedulePersist();
              })
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)

          Column({ space: SPACING.xs }) {
            Row({ space: SPACING.sm }) {
              Text('正文')
                .fontSize(FONT.caption)
                .lineHeight(LINE_HEIGHT.caption)
                .fontColor($r('app.color.text_secondary'))
              // 完成后给明确反馈：「手迹 N 页」（用户报过「写完以为白写了」）
              if (this.attachments.length > 0) {
                Text(`手迹 ${this.attachments.length} 页`)
                  .fontSize(FONT.caption)
                  .lineHeight(LINE_HEIGHT.caption)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.None })
                  .fontColor($r('app.color.brand'))
                  .margin({ left: SPACING.sm })
              }
              Blank()
              this.WritingEntry()
            }
            .width('100%')
            .alignItems(VerticalAlign.Center)

            TextArea({ text: this.body, placeholder: '记录内容；手写识别结果会追加到这里' })
              .width('100%')
              .height(BODY_HEIGHT)
              .fontSize(FONT.body)
              .backgroundColor($r('app.color.page_background'))
              .borderRadius(RADIUS.none)
              .padding({ left: 0, right: 0 })
              .onChange((value: string) => {
                this.body = value;
                this.notifyDirty();
                this.schedulePersist();
              })
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)

          Column({ space: SPACING.xs }) {
            this.FieldLabel('记录者')
            TextInput({ text: this.author, placeholder: '记录者姓名' })
              .width('100%')
              .height(INPUT_HEIGHT)
              .fontSize(FONT.body)
              .backgroundColor($r('app.color.page_background'))
              .borderRadius(RADIUS.none)
              .padding({ left: 0, right: 0 })
              .onChange((value: string) => {
                this.author = value;
              })
            Divider()
              .strokeWidth(DIVIDER)
              .color($r('app.color.divider'))
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)

          Row({ space: SPACING.sm }) {
            Text('完成情况')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
            Blank()
            Text(this.done ? '已完成' : '未完成')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_primary'))
            Toggle({ type: ToggleType.Switch, isOn: this.done })
              .selectedColor($r('app.color.brand'))
              .onChange((isOn: boolean) => {
                this.done = isOn;
              })
          }
          .width('100%')
          .height(TOUCH_MIN + SPACING.sm)
          .alignItems(VerticalAlign.Center)

          if (this.contentChanged()) {
            Text('标题或正文变更后需要重新「AI 汇总」：本次保存会重置 AI 处理标记。')
              .fontSize(FONT.caption)
              .lineHeight(LINE_HEIGHT.caption)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
              .textAlign(TextAlign.Start)
          }

          if (this.attachments.length > 0) {
            this.AttachmentPreview()
          }

          if (this.statusText.length > 0) {
            // 初始化失败 / 记录不存在：行内错误条（原因 + 下一步），给「重试」出口
            StateView({
              kind: 'error',
              title: this.statusTitle(),
              detail: this.statusText,
              retryLabel: '重试',
              compact: true,
              onRetry: () => {
                this.retryLoad();
              }
            })
          } else if (!this.ready) {
            // 正在等存储就绪：行内加载态（与错误态共用同一套三态视觉）
            StateView({ kind: 'loading', title: loadingText('存储'), compact: true })
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ bottom: SPACING.lg })
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .align(Alignment.TopStart)

      Row({ space: SPACING.md }) {
        if (this.onCancel !== null) {
          Button('取消')
            .height(PRIMARY_HEIGHT)
            .fontSize(FONT.body)
            .backgroundColor($r('app.color.brand_soft'))
            .fontColor($r('app.color.text_secondary'))
            .borderRadius(RADIUS.sm)
            .onClick(() => {
              const handler: (() => void) | null = this.onCancel;
              if (handler !== null) {
                handler();
              }
            })
        }
        Button(this.recordId.length > 0 ? '保存修改' : '保存日程')
          .layoutWeight(1)
          .height(PRIMARY_HEIGHT)
          .fontSize(FONT.body)
          .backgroundColor($r('app.color.brand'))
          .fontColor($r('app.color.text_inverse'))
          .borderRadius(RADIUS.sm)
          .enabled(!this.saving)
          .onClick(() => this.save())
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .height('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
