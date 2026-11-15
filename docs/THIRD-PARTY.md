# 第三方依赖清单（App 运行时）

本文件只列**随 App 打包进 rawfile 的前端第三方库**（不是 `package.json` 里的构建期依赖）。
新增/升级任何 vendored 库都必须在这里登记：名称、版本、许可证、来源 URL、用途、落盘路径。

## 1. isomorphic-git

| 项 | 值 |
| --- | --- |
| 名称 | isomorphic-git |
| 版本 | 见 `entry/src/main/resources/rawfile/git/isomorphic-git.VERSION`（当前 1.25.3） |
| 许可证 | MIT（全文见 `isomorphic-git.LICENSE.md`） |
| 来源 | https://github.com/isomorphic-git/isomorphic-git/releases |
| 用途 | 在 WebView 里用纯 JS 实现 git（clone/fetch/pull/push/status），供 `GitSyncService.ets` 驱动 |
| 落盘 | `entry/src/main/resources/rawfile/git/isomorphic-git.js` |

## 2. JSZip

| 项 | 值 |
| --- | --- |
| 名称 | JSZip |
| 版本 | **3.10.1**（见 `rawfile/git/jszip.VERSION`） |
| 许可证 | MIT（全文见 `rawfile/git/jszip.LICENSE.md`，随 npm 包 `LICENSE.markdown` 原样拷贝） |
| 来源 | https://www.npmjs.com/package/jszip/v/3.10.1（`npm pack jszip@3.10.1`，取 `dist/jszip.min.js`） |
| 用途 | **手写附件按天打包成 zip**（`attachments/YYYY-MM-DD.zip`）与详情页按条目解压 |
| 落盘 | `entry/src/main/resources/rawfile/git/jszip.min.js` |
| 引入日期 | 2026-11-15 |
| 加载位置 | `rawfile/git/index.html`：`isomorphic-git.js` → `jszip.min.js` → `git-bridge.js` |

### 为什么选 JSZip（而不是 `@ohos.zlib`）

1. **两端通用**：`@ohos.zlib` 是 OpenHarmony 专有 API，**ArkUI-X 的 Android 侧没有**。
   安卓不产生手迹，但**必须能读**鸿蒙同步上来的手迹（详情页展示），所以解压必须两端都能跑。
   JSZip 运行在 WebView 里，两端的 WebView 都支持，写一次两端通用。
2. **可控**：条目名、覆盖/合并语义、`STORE`（不重复压缩已压缩的 JPEG）都能精确控制；
   `@ohos.zlib.compressFile` 按**目录**打包，条目名受目录结构影响，跨端难以保证一致。
3. **不引入原生依赖**：JSZip 是纯 JS（MIT，约 95 KB），随 rawfile 打包，不需要额外系统权限。

### 失败会怎样

- `jszip.min.js` 未加载 → 桥的 `jszipApi()` 抛 `E_FS`「JSZip 未加载」，
  `zipUpsert/zipList/zipRead` 全部失败 → **附件不落 zip、详情页回退到「散图路径」**（旧数据照常可读），
  同步仍可进行（只是没有新附件包），不会阻塞日程同步。
- zip 损坏 → `loadZip()` 捕获后当**空包**重建，只丢当天那条坏包里的图，不影响其它天。
- 单条过大（>8 MB）→ `joinChunks` 抛 `E_FS`「zip 条目超过上限」，该条写入失败并上报，
  其余条目/其它天不受影响。

## 3. 传递依赖说明

`jszip.min.js` 是**打包后的单文件**（已把 `pako`/`lie` 等依赖打进去），
因此 rawfile 里只有这一个文件，不再单独登记 pako/lie；其许可证已包含在
`jszip.LICENSE.md` 的 bundled licenses 段中（需在使用前人工确认一次，见待办）。

## 待办

- [ ] 人工确认 `jszip.LICENSE.md` 中 pako/lie 的许可证段落是否需要另外附带（当前只在同一文件里）。
- [ ] 若后续升级 JSZip（如 3.10.2），同步更新 `jszip.VERSION`、本文件与 LICENSE 文件。
