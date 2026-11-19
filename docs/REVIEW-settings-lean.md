# REVIEW — `mod-settings-lean`（设置只留仓库地址 + 令牌）

独立、只读评审。评审对象为工作区未提交 diff 的 6 个文件：

```
apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets
apps/arkui-schedule/entry/src/main/ets/components/settings/SyncSection.ets
apps/arkui-schedule/tools/test/gitBranch.test.mjs
apps/arkui-schedule/tools/test/gitPlatform.test.mjs
apps/arkui-schedule/tools/test/settingsFormValidation.test.mjs
apps/arkui-schedule/tools/test/structureGuards.test.mjs
```

`git diff --name-only` 与上面 6 行完全一致；`services/settingsStore.ets`、`model/gitAuth.ts`、
`model/settingsForm.ts`、同步服务/桥文件均**不在 diff 内**。

> 并发说明：评审过程中 `docs/MODULES.md` 与 `docs/ROADMAP.md` 被其它角色并发改写（现已登记
> `mod-settings-lean`）。这两份文档不属于本次代码 diff；下文引用的是评审结束时它们的内容。

## 1 结论

| 级别 | 数量 | 是否阻断 |
| --- | --- | --- |
| P0 | 0 | 否 |
| P1 | 1 | 否（提交前建议修；只影响持有旧 SSH `authMode` 的用户，不丢数据） |
| P2 | 3 | 否 |

**总判定：非阻断（可提交）。** 用户可见契约（主表单只有仓库地址 + 一个掩码令牌 + 固定说明，
平台/分支/认证选择器全删）与引擎契约（`configure()` 和 extras 都下发 `DEFAULT_BRANCH`、平台仍按
地址推断、store 键不变、引擎文件零改动）均已达成；4 个测试文件全部是**改写而非削弱**；四道门闸
全绿（2390 / 2389 / 0 / 1，validate 8/8，tsc 0，overlay `applied=false`）。

唯一的 P1 是：旧数据 `authMode='ssh'` 时只读警告可达且不被静默改写，但**警告给出的补救办法
（“改成 HTTPS 地址后保存”）实际上无效**——页面上已没有任何控件能把 `authMode` 改回 HTTPS，
此用户被永久卡在警告 + 同步被拦状态。详见 F1。

## 2 逐项核对（Check 1–7）

### 2.1 用户可见结果（Check 1）—— 通过

`components/settings/SyncSection.ets:63-67` 定义固定说明与 SSH 警告：

```ts
/** 仓库地址下的固定说明：平台随地址推断、分支固定 main（本页没有平台/分支选择控件）。 */
const SYNC_CAPTION: string = '平台按地址自动识别 · 分支固定 main';

/** 已保存的认证方式是 SSH 时的只读提示（不是控件，不强制迁移）。 */
const SSH_STORED_WARNING: string = '当前保存的是 SSH 方式；本页只提供 HTTPS + 令牌，建议改成 HTTPS 地址后保存';
```

`SyncSection.ets:403-428` 主表单恰好两个输入框：仓库地址 + 令牌；令牌掩码：

```ts
TextInput({ text: this.repoUrl, placeholder: repoUrlPlaceholderFor(this.gitPlatform, this.authMode) })
...
if (this.repoUrlError.length > 0) {
  this.ErrorText(this.repoUrlError)
} else {
  // 固定说明：平台按地址推断、分支固定 main（没有平台/分支选择控件）
  this.HintLine(SYNC_CAPTION)
}

this.FieldLabel('访问令牌（仅存本机）')
TextInput({
  text: this.token,
  placeholder: tokenPlaceholderFor(this.gitPlatform)
})
  .type(InputType.Password)
```

`SyncSection.ets:445-455`：

```ts
// 已保存的是 SSH 方式时给一行只读警告（本页不提供认证方式选择器，也不强制迁移）
if (this.authMode === AUTH_SSH) {
  Text(SSH_STORED_WARNING)
    ...
}
// ---- 主表单到此结束：只剩「仓库地址 / 访问令牌」两个控件 ----
```

无平台 chip、无分支输入、无认证方式选择器：三者都只在 `git diff` 的删除行里出现
（`Settings.ets` 的 `PlatformChip` builder、`PlatformChip(...)` 两行、`'托管平台'/`认证方式` row、
`SyncSection.ets` 的分支 `Row/TextInput`），当前源码 grep `platformNotice|branchError|this.branch|
pickPlatform|pickAuthMode|PlatformChip|normalizeGitPlatform|platformLabel|normalizeBranchName|
validateBranchName|PLATFORM_CUSTOM|PLATFORM_GITLAB|AUTH_SSH` 在两份源码中**零命中**。
`立即同步`/`推送`/`高级 ▸`/`保存设置`/状态行是既有动作与只读行，不是被移除的字段控件，保留
符合模块登记（只移除平台/分支/访问方式控件）。

### 2.2 引擎行为不变（Check 2）—— 通过

`pages/Settings.ets:661-676`：

```ts
const config: GitSyncConfig = {
  repoUrl: this.repoUrl.trim(),
  // 分支固定 main（mod-settings-lean）：本页没有分支输入，内核始终收到 DEFAULT_BRANCH
  branch: DEFAULT_BRANCH,
  ...
  platform: this.gitPlatform,
  authMode: this.authMode
};
```

`Settings.ets:734-743` 平台仍推断：

```ts
const platformResolution: PlatformResolution = resolvePlatformSelection(
  this.repoUrl, this.gitPlatform, this.platformTouched
);
const platform: string = platformResolution.platform;
```

`Settings.ets:821-829` extras 保存仍写同一组键，只改分支值：

```ts
// 分支固定写入 DEFAULT_BRANCH（保留旧键，不改存储结构）；平台（四值）+ 锁定标记照旧落盘
const extras: GitSyncExtras = await gitExtrasStore.save(
  {
    branch: DEFAULT_BRANCH,
    platform: platform,
    platformTouched: this.platformTouched
  },
  context
);
```

`gitExtrasStore.save(..., {branch, platform, platformTouched})` 与 `settingsStore.save(patch, context)`
的键集合未变；引擎/store/模型文件全部未进 diff，故无 store 键增删改名。
**限定**：这里“不变”指引擎代码与默认（`main`）路径不变；对曾存过非 `main` 分支的老数据，
行为按设计改变（见 R3）。

### 2.3 SSH 存储值（Check 3）—— 警告可达、不静默改写；但无退出路径

prop 从 store 一路 wired：

- `Settings.ets:571` `this.authMode = normalizeAuthMode(settings.authMode);`（`applySettings` 从
  `settingsStore` 加载）
- `Settings.ets:2277` `authMode: this.authMode,`（`SyncGroup()` 传给 section）
- `SyncSection.ets:74` `@Prop authMode: string = AUTH_HTTPS;` → `SyncSection.ets:446-453` 渲染
  唯一一行只读 `Text(SSH_STORED_WARNING)`（旧 `SyncMoreSheet` 里的 SSH chip/说明已删，全文只此一处）

不静默改写：`Settings.ets:793` patch 仍写 `authMode: this.authMode`，`settingsStore.ets:645`
`authMode: patch.authMode === undefined ? current.authMode : normalizeAuthMode(patch.authMode)`
——保存 HTTPS 地址不会改动已存的 SSH 值，保存本身也**不被 SSH 拦住**（`blocking` 只看
`issuesSummary`，`Settings.ets:768`）。同步仍被拦：`authBlocker()` :857、`pushBlockedReason()` :863、
`runAction()` :1631-1634。

**但**（F1）：警告建议“改成 HTTPS 地址后保存”，而 `this.authMode` 的唯一赋值点是 :571（加载），
没有任何 URL 派生或 UI 控件再写它，所以照做之后警告依旧、同步依旧被拦。

### 2.4 死代码 / 遗留（Check 4）—— 通过

- 未用 import 已删：`Settings.ets` 的 `AUTH_SSH`、`PLATFORM_CUSTOM`、`PLATFORM_GITLAB`、
  `normalizeGitPlatform`、`platformLabel`、`normalizeBranchName`、`validateBranchName`；
  `SyncSection.ets` 的 `DEFAULT_BRANCH`。grep 两份源码均无残留引用。
- 不可达 `@State`：`platformNotice` / `branch` / `branchError` 已删；`GitSyncExtras` 的 `branch`
  故意保留存储键（不是 `@State`），注释说明。
- 孤儿 builder/方法：`PlatformChip`、`pickPlatform`、`pickAuthMode`、`syncPlatformNotice`、
  `onChangeBranch` 全部删除，无调用点残留。
- `structureGuards.test.mjs` / `uiTokens.test.mjs` 在全量里通过（见 §5）。

### 2.5 组顺序 / B2 锚点（Check 6）—— 通过

`Settings.ets:2250-2254`（diff 未触碰）：

```ts
this.GroupAnchorChip('同步', 0)
this.GroupAnchorChip('AI', 1)
this.GroupAnchorChip('远程', 2)
this.GroupAnchorChip('数据', 3)
this.GroupAnchorChip('关于', 4)
```

紧凑屏 `CompactBody()` :2557-2594 顺序 `GroupAnchorBar → IssuesBanner → Sync → AI → Remote →
Data → ChatEntry → About`；宽屏 `WideBody()` :2618-2648 左列 `Sync → Remote → Data → ChatEntry →
About`、右列 `AI`。diff 对这些行只有上下文、无增删改。
`docs/MODULES.md:52` 已登记本次共享文件触碰并写明“本次未改锚点与组顺序”。

### 2.6 风险（Check 7）—— 见 §4

## 3 四个测试文件的改写判定

总体：**没有削弱**。四个文件全部“改写并加严”；`structureGuards` 的 12→11 是随删除字段同步下调
且实际计数正好 11，有理由、不是无依据降门槛。

| 文件 | 判定 | 一句话理由 |
| --- | --- | --- |
| `gitBranch.test.mjs` | retargeted-and-stricter | 旧“分支可配”的正向断言换成“不可配”的反证 + 新的 `branch: DEFAULT_BRANCH` 正向断言，两边都钉 |
| `gitPlatform.test.mjs` | retargeted-and-stricter（但把 R2 风险钉成了契约） | chip-presence→absence 合理，且补了 `resolvePlatformSelection` 与固定说明的断言；未删覆盖 |
| `settingsFormValidation.test.mjs` | retargeted-and-stricter | 新增“主表单恰好 2 个 TextInput”“无分支/平台/认证控件”“说明与 SSH 警告必须渲染” |
| `structureGuards.test.mjs` | retargeted-with-justified-floor（注释计数有小错，见 F5） | 下限 12→11 与实测字段数 11 一致，删除了 `branchError` 一个字段 |

### 3.1 `gitBranch.test.mjs`（:456、:469）

旧（diff `-` 行）：

```js
has(/@State branch: string = DEFAULT_BRANCH;/);
has(/TextInput\(\{ text: this\.branch, placeholder: DEFAULT_BRANCH \}\)/);
has(/const branchProblem: string = validateBranchName\(this\.branch\);/);
has(/this\.branchError = branchProblem;/);
has(/this\.ErrorText\(this\.branchError\)/);
has(/gitExtrasStore\.save\(\s*\{[\s\S]{0,200}branch: normalizeBranchName\(this\.branch\)/);
```

新：

```js
const lacks = (pattern) => assert.equal(pattern.test(PAGE), false, `不该再有：${pattern}`);
has(/branch: DEFAULT_BRANCH,/);
has(/gitExtrasStore\.save\(\s*\{[\s\S]{0,200}branch: DEFAULT_BRANCH/);
has(/gitExtrasStore\.load\(context\)/);
lacks(/@State branch: string = DEFAULT_BRANCH;/);
lacks(/TextInput\(\{ text: this\.branch, placeholder: DEFAULT_BRANCH \}\)/);
lacks(/validateBranchName\(this\.branch\)/);
lacks(/this\.branchError\b/);
lacks(/Text\('分支'\)/);
```

第二处：旧 `assert.match(config[0], /branch: normalizeBranchName\(this\.branch\)[\s\S]{0,80}?DEFAULT_BRANCH/)`
→ 新 `assert.match(config[0], /branch: DEFAULT_BRANCH,/)`：更精确而非更宽。判定：**改写且更严**。

### 3.2 `gitPlatform.test.mjs`（:282、:294、:316）

旧（diff `-` 行）：

```js
assert.ok(PAGE.includes(`this.PlatformChip(${chip})`), `缺少平台 chip：${chip}`);
assert.match(PAGE, /this\.gitPlatform = normalizeGitPlatform\(value\);/, '选平台要归一成四值');
assert.match(PAGE, /this\.platformTouched = true;/, '手动选平台要置 platformTouched');
...
assert.match(PAGE, /this\.platformNotice = platformResolution\.notice;/, '保存后把推断提示展示出来');
assert.match(PAGE, /this\.syncPlatformNotice\(\);/, '改地址时即时更新推断提示');
assert.match(PAGE, /this\.HintLine\(this\.platformNotice\)/, '提示必须渲染出来');
...
assert.match(PAGE, /SSH（本版本不可用）/, 'SSH chip 要直接标不可用');
```

新：

```js
assert.equal(PAGE.includes(`this.PlatformChip(${chip})`), false, `不该再有平台 chip：${chip}`);
assert.equal(/pickPlatform\(/.test(PAGE), false, '不该有手动选平台入口');
assert.match(PAGE, /resolvePlatformSelection\(\s*this\.repoUrl,\s*this\.gitPlatform,\s*this\.platformTouched\s*\)/, ...);
...
assert.match(PAGE, /const platform: string = platformResolution\.platform;/, '仍用推断出的平台下发');
assert.equal(PAGE.includes('this.platformNotice'), false, ...);
assert.equal(PAGE.includes('platformResolution.notice'), false, ...);
assert.equal(PAGE.includes('syncPlatformNotice'), false, ...);
assert.ok(PAGE.includes('平台按地址自动识别 · 分支固定 main'), '固定说明必须存在');
...
assert.equal(/pickAuthMode\(/.test(PAGE), false, ...);
assert.equal(PAGE.includes("Text('HTTPS(PAT)')"), false, ...);
assert.equal(PAGE.includes('SSH（本版本不可用）'), false, ...);
assert.ok(PAGE.includes('当前保存的是 SSH 方式；本页只提供 HTTPS + 令牌，建议改成 HTTPS 地址后保存'), ...);
```

“chip 存在→chip 不存在”不是削弱：控件被有意删除，且新断言补了 `resolvePlatformSelection`、
推断值下发、固定说明、SSH 只读警告四处**新契约**；`describeAuthModeBlocker` / 同步入口拦截 /
`pushBlockedReason` 三条旧断言原样保留。判定：**改写且更严**。注意新测试把
`platformTouched` 的传递钉成契约，等于把 R2 风险固化（见 §4 R2）。

### 3.3 `settingsFormValidation.test.mjs`（:454）

旧：

```js
test('主表单只剩「仓库地址 / 访问 token / 分支」三个控件', () => {
  assert.match(mainForm, /Text\('仓库地址'\)/, '仓库地址是主表单字段');
  assert.match(mainForm, /this\.FieldLabel\(this\.authMode === AUTH_SSH \? '访问 token/, ...);
  assert.match(mainForm, /Text\('分支'\)/, '分支是主表单字段');
```

新：

```js
test('主表单只剩「仓库地址 / 访问令牌」两个控件 + 固定说明 + SSH 只读警告', () => {
  assert.match(mainForm, /Text\('仓库地址'\)/, '仓库地址是主表单字段');
  assert.match(mainForm, /this\.FieldLabel\('访问令牌（仅存本机）'\)/, ...);
  assert.equal((mainForm.match(/TextInput\(/g) ?? []).length, 2, '主表单恰好两个输入框：仓库地址 + 访问令牌');
  assert.equal(mainForm.includes("Text('分支')"), false, ...);
  assert.equal(mainForm.includes('this.PlatformChip('), false, ...);
  assert.equal(/pickAuthMode\(/.test(mainForm), false, ...);
  assert.match(mainForm, /this\.HintLine\(SYNC_CAPTION\)/, ...);
  assert.match(mainForm, /Text\(SSH_STORED_WARNING\)/, ...);
```

新增**精确计数**（不是“至少/存在”）与三条反证，判定：**改写且更严**。掩码由未改动的
`credentialHygiene.test.mjs:96-97`（`>= 2` 个 `InputType.Password`）覆盖。

### 3.4 `structureGuards.test.mjs`（:95）

旧：

```js
// 覆盖率下限：Settings 的 9 个内联错误 + 2 个警告 + 页面侧同类字段都要被扫到
assert.ok(settingsFields.length >= 12, ...);
```

新：

```js
// 覆盖率下限：Settings 的 8 个内联错误（branchError 随 mod-settings-lean 删除）+ 2 个警告
// + 页面侧同类字段（lastSyncError / remoteUrlError）都要被扫到；删除一个控件后下限同步减 1。
assert.ok(settingsFields.length >= 11, ...);
```

用 `collectIssueFields(componentFiles())` 实测当前 `Settings.ets` 字段：
`aiModelError, aiBaseUrlError, gitUsernameError, deviceIdError, authorError, repoUrlError, tokenError,
lastSyncError, identityWarning, attachmentWarning, remoteUrlError` = **11**（删除前 12，含
`branchError`）。下限 11 恰好等于实测值（不是留有余量的放宽），并有注释理由。判定：**合理下调，
非无依据削弱**；仅注释里“8 个内联错误”数错（实际 7 个，另 2 个是 `lastSyncError`/
`remoteUrlError`），见 F5。

## 4 Findings（含 file:line 与代码引用）

### F1 — P1 — SSH 警告的补救办法无效，旧 SSH 用户无退出路径

`components/settings/SyncSection.ets:66-67,445-453` 告诉用户“建议改成 HTTPS 地址后保存”；
但 `pages/Settings.ets:571` 是 `this.authMode` 的唯一赋值点：

```ts
this.authMode = normalizeAuthMode(settings.authMode);
```

`Settings.ets:793`（patch）与 `services/settingsStore.ets:645`（store）都原样保留 SSH；
`Settings.ets:857-864`（`authBlocker` / `pushBlockedReason`）和 `:1631-1634`（`runAction`）继续拦同步。
页面已删除 `pickAuthMode`，`resolvePlatformSelection` 只看 URL 推平台、不推认证方式。
结果：照警告改 URL 并保存 → 警告仍在、同步仍被拦，且没有控件可自救。
`runAction` 的 `:1627` 也还写着“切回 HTTPS(PAT)”，同样无对应控件。

**最便宜修法**：把 `SyncSection.ets:446-453` 的纯文本改成“只读警告 + 一个显式按钮
‘改用 HTTPS 令牌’”，点击回调只做 `this.authMode = AUTH_HTTPS`（再由用户点保存落盘）。
这是**显式**动作，不违反“不静默改写”；同时把 `:1627` 的文案改为不再指向不存在的控件。
若不做代码修改，至少把警告文案改诚实并写进 `docs/MODULES.md`。

### F2 — P2 — 陈旧 `platformTouched=true` 永久锁平台，且锁定的提示已被删除

`Settings.ets:648-653`：

```ts
private applyExtras(extras: GitSyncExtras): void {
  this.platformTouched = extras.platformTouched;
  if (extras.platform.length > 0) { this.gitPlatform = extras.platform; }
}
```

`:738-742` 把它传给 `resolvePlatformSelection`，`:826` 又原样写回；
`model/gitAuth.ts:277-282` 在 `platformTouched=true` 时直接返回用户旧平台。旧用户曾手选过平台
（如 Gitee），现在贴一个 GitHub 地址保存，平台仍锁 Gitee；原先解释这件事的
`platformResolution.notice` 已从 UI 删除（`gitPlatform.test.mjs:297-298` 明确断言不再上屏）。
页面没有 chip 也没有其它入口能把 `platformTouched` 清回 `false`。

**最便宜修法**：`applyExtras()` 里改成 `this.platformTouched = false;`（1 行，加载时退役旧标记），
同时更新 `gitPlatform.test.mjs:282-292` 的断言（不再要求传 `this.platformTouched`）。
若坚持“旧锁定继续生效”，则必须补一行只读提示说明当前锁定平台，否则用户无从解释。

### F3 — P2 — 旧存储的非 `main` 分支被静默覆盖，且代码注释与行为不符

`Settings.ets:645-646` 注释说“旧的 `extras.branch` 保留在存储里、不再影响下发给同步内核”，
但 `:824` 实际写 `branch: DEFAULT_BRANCH`；下一次保存就把旧分支**覆盖**掉，没有任何提示。
`configure()` :666 同步内核也固定收 `DEFAULT_BRANCH`。产品意图“分支固定 main”在
`docs/DATA-CONTRACT-v2.md:15` 与 `docs/MODULES.md:29` 有记录，但“旧值会在下次保存时被重置”
没有记录，与同文件注释自相矛盾。

**最便宜修法**：把 `:646` 注释改成“保存时会重置为 main”（纯文档 1 行），并在 `?` 帮助弹层
（`:2791`）补一句“此前存过的非 main 分支会在保存后重置为 main”。
若要求不丢用户数据，则改为保存时把加载到的 `extras.branch` 原样写回（内核仍收 `DEFAULT_BRANCH`）。

### F4 — P2 — `docs/UI-DESIGN.md:116` 仍是旧契约（文档漂移）

```md
| 同步 (Git) | 仓库地址 | token（密码框） | 设备标识 + 作者名（同行两列） | ... | 推送 / 查看状态 / 重试上次 / 测试连接 / 平台(GitHub·Gitee) / 认证(HTTPS·SSH) |
```

本 diff 已删除平台/认证控件，但 `UI-DESIGN.md` 不在 diff 内。最便宜修法：把“组头更多”单元格改为
“推送 / 查看状态 / 重试上次 / 测试连接（平台按地址推断、分支固定 main、无认证切换）”。

### F5 — P2（极小）— `structureGuards.test.mjs:95` 注释计数差 1

注释写“8 个内联错误 + 2 个警告 + 页面侧同类字段”，实测是 7 个内联错误 +
`lastSyncError`/`remoteUrlError` + 2 个警告 = 11。下限数值正确，仅注释把 7 写成 8；改成 7 即可。

## 5 门闸（逐字尾部）

工作目录 `C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite`。

```
$ node apps/arkui-schedule/tools/overlay.mjs status
覆盖层：未应用（工作区为「共享源码 + 平台目录」的原始形态）
[overlay] applied=false
```

```
$ node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
（无 stdout / stderr 输出）
tsc-exit=0
```

```
$ node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
✔ ① 旧目录含完整条目 → 新目录全部存在且字节一致，标记文件存在 (73.9258ms)
✔ ② 新目录已存在 → 不覆盖原内容，旧目录不动，写跳过标记 (28.8275ms)
✔ ③ 无旧目录 → no-op，且不创建标记 (3.7732ms)
✔ ④ 重复调用幂等：第二次不重复搬动、不覆盖用户后续修改 (13.1562ms)
✔ ⑤ 标记在但目标不全（上次中断）→ 从旧目录补齐并校验，旧数据不丢 (27.2597ms)
✔ ⑥ 无完成标记但有 pending 标记 + 目标已建且只搬了一半 → 补齐而不是永久 skip（评审 M1） (23.4206ms)
✔ ⑦ 补齐时目标已有同名条目 → 不覆盖用户数据，也不因旧目录残留而永久失败（评审 M3） (14.2792ms)
ℹ tests 2390
ℹ suites 309
ℹ pass 2389
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 26343.1556
```

```
$ node apps/arkui-schedule/tools/validate-app.mjs
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 355 条、main 静态 import 448 条、页面 7 个、rawfile/git 2 个文件）
validate-exit=0
```

与期望基线（2390 / 2389 pass / 0 fail / 1 skip、validate 8/8、tsc 0）**完全一致**。

## 6 unverified

- 真机/DevEco 编译与交互未验证（无 `hdc` 目标、无 SDK）；所有 UI 行为结论均来自源码静态阅读与
  Node 门闸，不代表真机渲染/点击结果。
- 未验证旧数据的真实读取：`platformTouched=true`、`extras.branch!=='main'`、`authMode='ssh'`
  的存量偏好文件未在真机/沙箱里构造，F1–F3 的结论基于代码路径推导（并已被源码级测试间接确认）。
- `gitExtrasStore` / `settingsStore` 的实现文件未改，但未在本评审中逐行审计其全部键的兼容性；
  仅按 diff 与调用点判断“键未变”。
- 评审期间 `docs/MODULES.md`、`docs/ROADMAP.md` 由其它角色并发修改；本评审未复核其全部内容，
  只引用了与 `mod-settings-lean` 相关的行。
- 没有运行真机 `device-accept.mjs`；本模块也未新增该脚本用例。

## 复审（2026-11-19 深夜，F1–F5 修复）

范围：`pages/Settings.ets`、`components/settings/SyncSection.ets`、4 个 retargeted 测试、`docs/UI-DESIGN.md` 的未提交 diff；只读复核 + 三门闸重跑。原 findings 未改写。

- **F1 — CLOSED（P1 已修）**：`SyncSection.ets:449-470` SSH 警告行恰好 1 个 `ActionButton{label:'改用 HTTPS 令牌'}` → `onSwitchToHttpsToken()`；`Settings.ets:871-877` handler 显式 `this.authMode = AUTH_HTTPS`、清掉上次拦截的 `❌` 红字、`showToast('已切换为 HTTPS + 令牌，保存后生效')`，**不** save/configure；回调 prop 在 `:2360` 由页面接上，子组件不改 `@Prop`。`:1645` 旧文案已改；`HTTPS(PAT)` 在源码/文档零残留（仅旧评审引文中保留）。路径成立：点按钮 → 本地 HTTPS → 点「保存设置」→ `:796` 写 `authMode` → store 落盘 → 警告消失、同步解锁；`settingsFormValidation.test.mjs` 新增 describe 同时钉住“恰好一个动作 / handler 不自动保存 / prop 已接线”。
- **F2 — CLOSED**：`applyExtras()` 在 `Settings.ets:652` 置 `this.platformTouched = false`，加载(`:513`)与保存后(`:837`)都走；`resolvePlatformSelection` 重新按地址推断。`gitPlatform.test.mjs` 用 `/applyExtras\(...\)[\s\S]{0,400}?this\.platformTouched = false;/` 正向断言这次退役，不是只删旧断言。
- **F3 — CLOSED**：`Settings.ets:647` 注释明说旧 `branch` 被忽略、下次保存写成 main、无迁移提示；`:824-828` 实写 `DEFAULT_BRANCH`；`UI-DESIGN.md` 新增「分支契约（mod-settings-lean）…无迁移提示」。
- **F4 — CLOSED**：表格「组头更多」已去掉平台/认证 chip，改成「平台按地址推断、分支固定 main、无认证切换」；紧随的第二段主操作说明同步改；`UI-DESIGN.md` grep `平台\(GitHub|认证\(HTTPS|HTTPS(PAT)` 零命中。
- **F5 — CLOSED**：注释改为「7 个内联错误（branchError 删除）+ 2 个警告 + 页面侧 lastSyncError/remoteUrlError」，下限仍 11；实测 `collectIssueFields(...)` = 11（7 错 + 2 警 + 2 页面侧），7 正确。
- **新发现（P2，非阻断）**：`Settings.ets:266` 与 `:740` 注释仍写「旧数据仍按原语义参与推断」，与 `:652` 加载时退役（platformTouched 恒为 false）矛盾。纯注释，不影响行为；建议改为“锁定标记加载时退役，平台一律按地址推断”。
- **无新 P0/P1**：无子节点改 `@Prop`、无重复动作、无未用 import（`AUTH_SSH` :449、`GITEE_PLATFORM` :795、uiTokens 各 token 均在用；tsc 不覆盖 .ets，已 grep 核对）；4 个测试均为改写加严，无旧断言被削弱（结构守卫 12→11 与实测 11 一致且注释有理由）。
- **总判定**：非阻断（0 P0 / 0 P1），可提交。

门闸（逐字尾部）：

```
$ node node_modules/typescript/bin/tsc -p apps/arkui-schedule/tools/tsconfig.json
tsc-exit=0
```

```
$ node --test "packages/dsh-dots/test/*.test.mjs" "apps/arkui-schedule/tools/test/*.test.mjs"
✔ ⑦ 补齐时目标已有同名条目 → 不覆盖用户数据，也不因旧目录残留而永久失败（评审 M3） (26.4714ms)
ℹ tests 2391
ℹ suites 310
ℹ pass 2390
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 26427.2631
test-exit=0
```

```
$ node apps/arkui-schedule/tools/validate-app.mjs
🔍 校验 ArkUI-X 工程：C:\Users\GWL\Desktop\itwillclaude\dsh-sync-suite\apps\arkui-schedule
✅ 全部通过：8/8 条规则（JSON5/JSON 70 个、相对 import 355 条、main 静态 import 448 条、页面 7 个、rawfile/git 2 个文件）
validate-exit=0
```

与期望基线（2391 / 2390 pass / 0 fail / 1 skip、validate 8/8、tsc 0）完全一致。
