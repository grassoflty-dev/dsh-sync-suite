# 持久化审计（PERSISTENCE.md）

> **配置会存活；clone 是派生数据，会在后台静默重建**。

范围：`apps/arkui-schedule/entry/src/main/ets/**`，只读审计。配置（preferences + filesDir 配置文件）在 `install -r` 后存活；升级存活（case 1）按**跨版本边界**（1000005→1000006）的 marker 测试口径表述，装机证明用 `bm dump` 的 `versionCode`+`updateTime` 前后对照（docs/RUNBOOK.md §7.1:162）。`git-repo` 工作副本是**派生数据**，本审计不承诺其存活；「静默重建」归 `mod-sync-silent-autoinit`，不在此保证。

## 表：key → 存储位置 → 升级后是否保留 → 读 / 写（file:line）

| key（真实名） | 存储位置 | 升级后 | 读取 → 写入 |
| --- | --- | --- | --- |
| deviceId / deviceFingerprint / deviceUuid / deviceIdAuto | preferences `schedule_settings` | 保留 | settingsStore.ets:370-376 → :676-679 |
| repoUrl / token / author / gitPlatform / gitUsername / authMode | 同上 | 保留 | :377-378,410-414 → :680-681,697-700 |
| aiKey / aiProviderId / aiModel / aiBaseURL / aiTemperature / aiMaxTokens / aiTimeoutMs / aiRetries | 同上 | 保留（含旧键迁移 :380-386） | :379-394,437-439 → :682-689 |
| aiFallback*（7 键：ProviderId/Model/BaseURL/Key/Enabled/MaxAttempts/Order） | 同上 | 保留 | :396-409 → :690-696 |
| penOnlyInput / themeMode | 同上 | 保留 | :416,418 → :701-702 |
| remote*（10 键：Url/Mode/LanAddress/Port/TailscaleHost/CloudflareHost/Ipv6Address/ManualUrl/Token/LastOk） | 同上 | 保留 | :420-433 → :703-712 |
| lastSyncAt / lastSyncError / lastSyncAction | 同上（独立写路径） | 保留 | :434-436 → :778-780（saveSyncState） |
| branch / platform / platformTouched | preferences `git_sync_extras` | 保留 | syncController.ets:95-104 → :138-141 |
| instances.json（信封 `{v:1,items}`，含 token/URL） | PersistentStorage→底层 preferences，键名即 store 名（底层文件名 未确认） | 保留 | instanceStore.ets:55-59 → :62-65 |
| instance-grants.json（信封 `{v:1,items}`） | 同上 | 保留 | instanceGrantStore.ets:54-58 → :61-64 |
| sync-outbox.json（git-repo 之外） | filesDir 根 | 保留 | outboxStore.ets:59-64 → :150-155 |
| sync-baseline.json（git-repo 之外） | filesDir 根 | 保留 | GitSyncService.ets:2030-2032 → :2055-2056 |
| sync-quarantine/ | filesDir 根 | 保留 | GitSyncService.ets:2157 → 未确认 |
| drafts/<key>.json | filesDir/drafts | 保留 | draftStore.ets:87-88 → :76-78 |
| timeline/**、devices/**、chats/**、git-merge/**、exports/、attachments-src/、cache/attachments | filesDir 下（数据 / 快照 / 派生） | **不承诺**（clone 派生，静默重建归 mod-sync-silent-autoinit） | GitSyncService.ets:1474-1480；gitMerge.ets:142,496 |
| timeline.sync.state / reason / pending / lastAt | **仅内存**（AppStorage，非持久） | 不保留 | syncStatusStore.ets:34-37,105-115 → :68-87 |
| settings.lastExportAt / lastImportAt | **仅内存**（AppStorage） | 不保留 | Settings.ets:79-80 → SettingsExportImport.ets:181,306,399 |
| home.includeOtherDevices | **仅内存**（AppStorage） | 不保留 | SettingsSync.ets:195 → :850 |
| home.lastSaved（一次性标记） | **仅内存**（AppStorage） | 不保留 | Index.ets:354-355、SchedulePane.ets:391-392 → RecordEditorView.ets:693 |
| handwriting.result / ocrText / pageObjects / attachments / autosave | **仅内存**（AppStorage 交接） | 不保留 | RecordEditorView.ets:359-406 → 同处 |
| draftKey(recordId) 草稿镜像 | 内存镜像 + filesDir/drafts 文件 | 文件保留 | RecordEditorView.ets:243 → :192（文件 draftStore.ets:76-88） |

## 风险清单（最高风险在前）

1. **仅内存、重启即丢（真实丢失风险）**：上表末尾 6 类 AppStorage 键。损失：`timeline.sync.*`（syncStatusStore.ets:34-37,68-87）丢失后状态行回退 `失败：未知错误`（:103,117），上次同步时间/结果归零；`settings.lastExportAt/lastImportAt`（settingsMenu.ts:9-10；写 SettingsExportImport.ets:181,306,399）丢失后设置页回落「未导出」（Settings.ets:79-84）；`home.includeOtherDevices`（uiTokens.ts:126；写 SettingsSync.ets:850）丢失后首页过滤开关回默认；`handwriting.*`（RecordEditorView.ets:359-406）若 App 在编辑器消费前被杀，OCR 文本/页对象/附件交接丢失；`home.lastSaved` 是一次性标记，丢失无实际影响。`instanceStore.items`(:69)、`instanceGrantStore.items`(:68)、`settingsStore.cache`(:353) 是持久化值的内存镜像，重启从盘重读，非独立风险。授权表跨重启**保留**（instanceGrantStore.ets:47）。
2. **无配置版本标记**：`schedule_settings` / `git_sync_extras` 无 schema/version 键；只有数据信封 `{v:1}`（instances.ts:44,635；instanceGrant.ts:76,686）与 timeline schema.json（timelineWriteStore.ets:68）。版本变更即 `E_ENVELOPE_VERSION` → 空表；缺口由 mod-config-persistence 补。
3. **store 改名即静默丢**：`schedule_settings`（settingsStore.ets:245）、`git_sync_extras`（syncController.ets:53）硬编码；改名后 `prefs.get(key, 默认)`（:370-436）全量回落默认，无旧名读取/别名路径。PersistentStorage 键（instanceStore.ets:36、instanceGrantStore.ets:35）同理；信封版本不符亦静默回落空表。
4. **升级替换路径**：无配置写入 `rawfile/`——仅只读加载 `$rawfile('git/index.html')`（GitBridgeHost.ets:28、SyncSection.ets:444、gitRunner.ets:4），非缺陷；无配置仅存 git 仓库——指纹/UUID 同时入 preferences（settingsStore.ets:247-248,372-374）。
5. **签名 / 包名身份变更（case 3，发布约束）**：签名变更可拒绝升级或丢数据，App 代码无法修补。与 v1/v2 签名阻塞并列记录：signing/README.md §已知问题:93-95 —— v2 材料不全、须 `-AllowLegacyV1Key`、泄露的 v1 调试密钥 `reproduce-only, never ship or publish with this key`。

## 应成为守卫的两条不变量

- **绝不把用户配置写进 `rawfile/` 或任何升级会替换的位置**：守卫应扫描 `components/GitBridgeHost.ets:28`、`components/settings/SyncSection.ets:444`、`services/gitRunner.ets:4` 等 `$rawfile` 引用点，以及任何新增的向 `resources/rawfile` 写盘代码。
- **绝不把用户配置只存进 git 仓库**：守卫应扫描 `services/settingsStore.ets`、`services/syncController.ets`、`services/instanceStore.ets`、`services/instanceGrantStore.ets`，确认每个配置键另有 preferences/PersistentStorage 落点。

## 结构问题速答

- **访问器非单一**：显式 preferences 2 个（`schedule_settings`、`git_sync_extras`），PersistentStorage 键 2 个；每个 filesDir 存储各自开文件（outboxStore / draftStore / GitSyncService / timelineWriteStore / chatStore / gitMerge 等）。
- **版本标记无**（风险 2）；**rawfile/ 或仅仓库写入无缺陷**（风险 4）；**改名兼容路径无**（风险 3）。
- **aboutToAppear 写默认覆盖：未发现**。各页均 init→load→apply（EntryAbility.ets:93-105；SettingsHost.ets:251-268；SettingsSync.ets:150-168；SettingsApi.ets:124-133；Settings.ets:64-84）。唯一在 aboutToAppear 的写入是 `instanceStore.ensureSeeded`（InstancesPane.ets:120-138），但内容相等则不写（instanceStore.ets:117-124）。次级风险：`gitExtrasStore.save()` 先置 cache 后写盘（syncController.ets:135 vs 137），且 `load()` 失败返回 defaults 而不置 cache（:107-110），IO 失败后用户保存可能以默认值写回——边界情况，未确认是否可触发。

## 未确认（需何证据）

preferences 在沙箱内的精确文件名、PersistentStorage 底层 preferences 文件名、sync-quarantine 目录写入行：需真机列沙箱目录（`hdc file recv` 在 undebuggable 镜像被拒，signing/README.md:96）；此三项均为静态不可定，不影响「升级保留」结论（均在 App 数据目录内）。

## 本审计不做的事

配置集中化（统一 accessor + 版本标记 + 迁移/改名兼容）故意延后到独立模块 `mod-config-persistence`。本轮只读：不改 `apps/**`、不改测试、不构建、不写 git；唯一写入是本文档。
