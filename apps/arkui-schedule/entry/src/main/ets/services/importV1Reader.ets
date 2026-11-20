/**
 * mod-v2-import-v1：**只读** v1 文件读取器（devices/** 永不写、不移动、不删除）。
 *
 * 单独成文件的原因：`timelineWriteStore` 的既有不变量是「源码里不出现 devices/ 路径」，
 * 迁移的读侧不能破坏这条不变量；写侧继续只经 timelineWriteStore 的迁移专用 writer。
 * 本文件只有三个只读方法（列目录 / 读文本 / 取绝对路径供 zipRead），没有任何写 API。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

const REPO_DIR: string = 'git-repo';
const V1_PREFIX: string = 'devices/';

export class ImportV1Reader {
  private filesDir: string = '';
  private ready: boolean = false;

  async ensureReady(context: object): Promise<void> {
    if (this.ready) {
      return;
    }
    const abilityContext: common.UIAbilityContext = context as common.UIAbilityContext;
    this.filesDir = abilityContext.filesDir;
    this.ready = true;
  }

  /** 列出只读目录的直接项名（缺目录返回空）。 */
  listNames(relPath: string): string[] {
    const dir: string = this.path(relPath);
    try {
      return fs.accessSync(dir) ? fs.listFileSync(dir) : [];
    } catch {
      return [];
    }
  }

  /** 读文本；缺文件返回 ''，异常由调用方按 typed 拒绝上报。 */
  readText(relPath: string): string {
    const file: string = this.path(relPath);
    if (!fs.accessSync(file)) {
      return '';
    }
    return fs.readTextSync(file);
  }

  /** 绝对路径供 zipRead 使用（桥只读 zip，绝不写回）。 */
  filePath(relPath: string): string {
    return this.path(relPath);
  }

  /** 路径白名单：只接受 devices/ 下的仓库相对路径，拒绝上跳与反斜杠。 */
  private path(relPath: string): string {
    if (!this.ready || this.filesDir.length === 0) {
      throw new Error('E_IO: v1 只读读取器尚未初始化');
    }
    if (!relPath.startsWith(V1_PREFIX) || relPath.includes('..') || relPath.includes('\\')) {
      throw new Error('E_IO: 仅允许读取 v1 数据目录');
    }
    return `${this.filesDir}/${REPO_DIR}/${relPath}`;
  }
}

/** 全局单例：与迁移服务共用同一份目录状态。 */
export const importV1Reader: ImportV1Reader = new ImportV1Reader();
