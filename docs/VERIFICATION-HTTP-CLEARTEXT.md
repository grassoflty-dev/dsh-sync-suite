# 明文 HTTP 验证（ArkWeb / Web 组件）

> 调查对象：HarmonyOS API 26（本机 DevEco SDK `HarmonyOS 26.0.0 / apiVersion 26`，`sdk-pkg.json`），
> 工程 `apps/arkui-schedule`。只读调查，未改任何代码、未跑 hvigor、未真机。
> 证据分三类标注：**【文档说】**（developer.huawei.com 官方文档）、**【本机 SDK】**（`D:\A-DevEco\DevEco Studio\sdk` 原文）、**【仓库内】**（本仓库文件）。

## 结论

**不需要额外配置**：HarmonyOS 默认允许明文 HTTP（无 `network_config.json` 时不下发明文拦截策略），ArkWeb 的 `Web` 组件也没有任何 cleartext 开关属性；`mixedMode` **不是**「允许加载 http:// 页面」的开关，它只管「https 页面里去加载 http 子资源」。
唯一需要写配置的场景：**一旦工程为别的目的引入了 `resources/base/profile/network_config.json`**，就要在该文件的 `component-config` 里显式写 `"ArkWeb": true`（官方字段表把 ArkWeb 组件的明文开关默认值写作 `false`），否则 ArkWeb 的 http 请求有被系统策略拦成 `-29` 的风险。配在 `entry/src/main/resources/base/profile/network_config.json`；`module.json5` 不需要任何改动。

## 证据

### 1. 网络权限：已声明

【仓库内】`apps/arkui-schedule/entry/src/main/module.json5:37-44`

```json5
    "requestPermissions": [
      {
        "name": "ohos.permission.INTERNET"
      },
      {
        "name": "ohos.permission.STYLUS_FRAME_BOOST"
      }
    ]
```

（逐字照抄；`INTERNET` 在第 39 行。文件共 46 行，无 `metadata`、无 `network` 字段。）

### 2. ArkWeb 的 `Web` 组件：没有 cleartext/mixed-content 之外的明文开关

【本机 SDK】`sdk\default\openharmony\ets\component\web.d.ts`

- `mixedMode` 的**语义就是"安全源加载非安全源子资源"**，与顶层导航无关（`web.d.ts:5891-5902`）：

```
5891:     /**
5892:      * Sets the behavior when a secure origin attempts to load a resource from an insecure origin.
5893:      * The default is MixedMode.None, meaning not allow a secure origin to load content from an insecure origin.
...
5902:     mixedMode(mixedMode: MixedMode): WebAttribute;
```

- 枚举定义（`web.d.ts:715-751`）：

```
715:  * The Web's behavior to load from HTTP or HTTPS. Defaults to MixedMode.None.
723: declare enum MixedMode {
725:      * Loose mode: Allow a secure origin to load content from any other origin.
732:     All = 0,
734:      * Compatible mode: Some insecure content may be allowed to be loaded by a secure origin.
741:     Compatible = 1,
743:      * Strict mode: Not allow a secure origin to load content from an insecure origin.
750:     None = 2
```

- **`WebAttribute` 全表 153 个属性（`grep -c '^\s+\w+(...): WebAttribute;'`）中没有任何 `enableCleartext` / `networkSecurityConfig` / `securityConfig` / `cleartext`**。逐条列举（节选，可复核）：
  - `web.d.ts:5827 javaScriptAccess`、`5848 fileAccess`、`5862 onlineImageAccess`、`5876 domStorageAccess`、`5890 imageAccess`、`5902 mixedMode`、`5914 zoomAccess`、`5928 geolocationAccess`、`6134 databaseAccess`、`7017 blockNetwork`、`8195 enableMediaNetworkProxy`；
  - 全文 grep `cleartext|Cleartext|networkSecurity|securityConfig` 在该文件**0 命中**（`mixedMode` 5 命中，仅在 716/723/5893/5895/5902）。

【文档说】官方安全最佳实践同样只把 `mixedMode` 定义为**混合内容**开关，且明确"默认 None、调试用完必须关"：
`https://developer.huawei.com/consumer/cn/doc/best-practices/bpta-arkweb-component-security`（章节「避免HTTP与HTTPS混合内容加载」）

> mixedMode() 设置是否允许加载超文本传输协议（HTTP）和超文本传输安全协议（HTTPS）的混合内容，ArkWeb 默认不允许加载 HTTP 和 HTTPS 的混合内容（mixedMode 默认设为 None），应当避免设置为 All。开发者若在调试场景下需要访问 HTTP，则务必在调试完成后将 mixedMode 设置为 None。

【文档说】官方 FAQ 的表述一致（`https://developer.huawei.com/consumer/cn/doc/doccenter-dev-faq/faqs-arkweb-67.md`）：
> ArkWeb 提供 mixedMode(mixedMode: MixedMode) 接口，用于设置是否允许加载 HTTP 和 HTTPS 混合内容。默认情况下，不允许加载混合内容。

> 说明：社区/官方问答里存在「Web 加载 `http://ip:port` 就把 `mixedMode` 设成 `MixedMode.All`」的回答（如 `https://developer.huawei.com/consumer/cn/forum/topic/0202197198823871978`），但同文给出的示例 `src` 是 `www.huawei.com`，即 https 首页 + 混合内容场景；用它解释**顶层 http 导航**属于误用，我不采信。

### 3. HarmonyOS 的明文策略：默认允许；拦截靠 `network_config.json`（Stage 模型没有 module.json5 字段）

【本机 SDK】`sdk\default\openharmony\ets\api\@ohos.net.networkSecurity.d.ts:156-167`（"默认允许"的直接依据）：

```
156:     /**
157:      * Checks whether plaintext HTTP access is allowed from the preset **network_config.json** file of the application. By
158:      * default, plaintext HTTP access is allowed.
...
162:      *     plaintext HTTP is allowed, and the value **false** indicates the opposite. The default value is **true**.
...
167:     export function isCleartextPermitted(): boolean;
```

`isCleartextPermittedByHostName(hostName)`（同文件 `169-181`）同样是「按域名查询，默认 true」。

【本机 SDK】`sdk\default\openharmony\ets\api\@ohos.net.http.d.ts:1362`：只有**配置了才可能触发**的错误码

```
1362:          * @throws { BusinessError } 2300997 - Cleartext traffic not permitted. [since 18]
```

【本机 SDK】ArkWeb 侧确有"被系统策略拦明文"这个错误，说明 ArkWeb 也受同一策略约束：

- `sdk\default\openharmony\ets\api\@ohos.web.netErrorList.d.ts:280-290`

```
280:     ERR_BLOCKED_BY_RESPONSE = -27,
281:     /**
282:      * The request was blocked by system policy disallowing some or all cleartext
283:      * requests.
...
290:     ERR_CLEARTEXT_NOT_PERMITTED = -29,
```

- C 头 `sdk\default\openharmony\native\sysroot\usr\include\web\arkweb_net_error_list.h:181-185`

```
181:     /**
182:      * @error The request was blocked by system policy disallowing some or all cleartext
183:      *        requests.
184:      */
185:     ARKWEB_ERR_CLEARTEXT_NOT_PERMITTED = -29,
```

【本机 SDK】**Stage 模型 `module.json5` 里没有明文/网络策略字段**：

- `sdk\default\hms\toolchains\modulecheck\module.json`（"JSON schema for module.json"）全文 grep `"network` **0 命中**，即没有 `network` / `cleartextTraffic` 之类字段。
- 唯一带 `cleartextTraffic` 的 schema 是 **FA 模型 `config.json`** 的：`sdk\default\openharmony\toolchains\configcheck\configSchema_rich.json:2,6-16,269-308`

```
2:  "title": "JSON schema for HarmonyProfile.json",
6:  "required": ["app","deviceConfig","module"],
269:            "network": {
270:              "description": "Indicates the network security configuration. ...",
274:                  "cleartextTraffic",
275:                  "securityConfig"
279:                "cleartextTraffic": { ... "type": "boolean" }
283:                "securityConfig": { ... "cleartextPermitted", "domains" ... }
```

→ 结论：`config.json` 的 `deviceConfig.network.cleartextTraffic` 是**旧 FA 模型**写法，**不能**照抄到 `module.json5`；Stage 模型的等价物是独立文件 `network_config.json`。

【文档说】`network_config.json` 的正式定义（`https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/http-request` 章节「明文HTTP访问权限配置说明」，路径与字段原文）：

```jsonc
// src/main/resources/base/profile/network_config.json
{
  "network-security-config": {
    "base-config": {
      "cleartextTrafficPermitted": true // 可选，自API version 18开始支持该属性。
    },
    "domain-config": [
      {
        "domains": [ { "include-subdomains": true, "name": "example.com" } ],
        "cleartextTrafficPermitted": false // 可选，自API version 18开始支持该属性。
      }
    ],
    "component-config": {
        "Request": true,                        // API 20+，默认 true
        "Network Kit": true,                    // API 20+，默认 true
        "ArkWeb": false,                        // API 20+，默认 false   ← 关键一行
        "Media Kit": false,                     // API 23+，默认 false
        "Remote Communication Kit": false       // API 23+，默认 false
    }
  }
}
```

同页字段表原文：

> **cleartextTrafficPermitted18+** … 明文HTTP是否允许。true 表示允许，false 表示不允许，**默认为 true**。
> **component-config20+** … 指示每个组件的明文配置。优先级最高。
> **ArkWeb** … ArkWeb 从 API version 20 开始支持配置开启或关闭明文HTTP功能。true 表示配置开启，false 表示配置关闭，**默认为 false**。
> 配置优先级规则：组件配置（component-config）> 域名配置（domain-config）> 基础配置（base-config）。

【文档说】`network_config.json` 的位置与"一个文件多用"也见于 `https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/network-connection-security-configuration`（CA/证书锁定同文件）与 `https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/remote-communication-preparations`（"从 6.1.0(23) 开始，新增支持 HTTP 明文拦截配置…可通过 `src/main/resources/base/profile/network_config.json`（该文件不存在时可以手动创建）配置"）。

### 4. 对照：本 App 现在根本不走 ArkWeb 的 http

【仓库内】

| 事实 | 位置 |
| --- | --- |
| 全仓唯一的 `Web(...)` 只加载**本地 rawfile**，不是 http 页面 | `entry/src/main/ets/components/GitBridgeHost.ets:28` `Web({ src: $rawfile('git/index.html'), controller: this.controller })`；`entry/src/main/ets/pages/Settings.ets:1436`（该文件正被并发修改，行号会漂移） |
| 全仓**没有任何** `mixedMode` 调用（默认 None 生效） | grep `\.mixedMode` / `mixedMode` 在 `entry/src/main/ets/**` 0 命中 |
| 本地页面的网络请求交给 ArkTS 的 **Network Kit**，不经 ArkWeb 网络栈 | `entry/src/main/resources/rawfile/git/git-bridge.js:1119-1152`（`/^https?:\/\//` 校验后 `hostCall('httpRequest', …)`）→ `GitSyncService.ets:14,29,1065`（`import { http } from '@kit.NetworkKit'` + `http.createHttp()`） |
| AI 请求同样走 Network Kit | `services/deepseek.ets:23,268,596-603,629`（`HTTP_FETCH_IMPL = httpFetch`，注释明说"本应用所有网络调用本来就走 `@kit.NetworkKit`"） |
| http 先例（用户可手填 http 地址，但走的是 Network Kit，不是 ArkWeb） | `model/aiProvider.ts:187` "不要求域名带点，`http://localhost:8080/v1` 这类本地反代同样放行"；`aiProvider.ts:76-78` 自定义源 `baseURL: ''` 由用户填；`services/settingsStore.ets:255` "「自定义」本来就允许手填 http:// 地址" |

**真机跑通了吗？没有证据。**【仓库内】`docs/VERIFICATION.md:231`

```
| 真实 GitHub/Gitee HTTPS/SSH 认证 | 本机无远端仓库凭据 | 建私有仓库，用 HTTPS PAT 执行 testConnection/push/pull；SSH 用 ssh-agent |
```

`docs/VERIFICATION.md:812-819`（13.3 真机未验）明确列出「启动自动 pull 的 `[sync]` 日志与下拉刷新」未验；`docs/VERIFICATION.md:781`「AI 三个源的真机『测试』未做（没有可用 key）」。
→ 即：**仓库里没有任何一条"真机用明文 http 成功联网"的记录**，不论 ArkWeb 还是 Network Kit。

## 若需配置：正确做法

只在**确实需要**时（例如新增的"远程控制台"要在一个 `Web` 组件里显示 `http://<电脑IP>:3080/?token=…`，或者工程已为 CA 引入该文件）才加，路径固定、`module.json5` 不动：

`apps/arkui-schedule/entry/src/main/resources/base/profile/network_config.json`

```json
{
  "network-security-config": {
    "base-config": {
      "cleartextTrafficPermitted": true
    },
    "component-config": {
      "Network Kit": true,
      "ArkWeb": true
    }
  }
}
```

要点：
- 顶层键是 `network-security-config`（连字符），字段是 `cleartextTrafficPermitted`；**不是** Android 风格的 `networkSecurityConfig.cleartextTrafficPermitted`。
- 不要照抄论坛答复里那个 `network_security_config.json` + `module.json5 abilities.metadata` 的写法（`https://developer.huawei.com/consumer/cn/forum/topic/0202185829539348034`）——那是社区自拟 schema，官方文档的路径是固定的 `resources/base/profile/network_config.json`，且官方文档**没有**要求 `module.json5` 登记 `metadata`。
- 只想放行单个域：用 `domain-config[].cleartextTrafficPermitted`，别全局开。
- 官方链接：
  - 明文配置说明（本页为权威）：`https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/http-request#明文http访问权限配置说明`
  - 网络连接安全配置（同文件、CA 场景）：`https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/network-connection-security-configuration`
  - 运行时自检 API：`https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-networksecurity`
  - ArkWeb 安全最佳实践（mixedMode 定位）：`https://developer.huawei.com/consumer/cn/doc/best-practices/bpta-arkweb-component-security`

## 真机验证步骤（3 步）

1. **加探针**（只在测试分支/临时页，别进主干）：在 `Web({ src: 'http://<PC局域网IP>:3080/?token=…' })` 上挂
   `.onErrorReceive((e) => hilog.error(0x0000, 'CLEARTEST', \`code=${e.error.getErrorCode()} info=${e.error.getErrorInfo()}\`))`
   （`onErrorReceive` 的 `error: WebResourceError` 才有 `getErrorCode()/getErrorInfo()`：`web.d.ts:4369-4388` + `3036-3065`；**`onHttpErrorReceive` 只给 `WebResourceResponse`（HTTP 状态码），拿不到网络错误码**，`web.d.ts:4397-4415`。）
   同时在能跑 ArkTS 的地方调用 `networkSecurity.isCleartextPermitted()` 打印一次（需 `ohos.permission.INTERNET`，已声明）。
2. **跑起来看日志**：`hdc shell hilog -r | findstr CLEARTEST`（或 `hdc hilog | grep CLEARTEST`），同时看 `isCleartextPermitted()` 输出。
3. **判读**：
   - 页面正常加载 + `isCleartextPermitted()=true` → 明文无需任何配置（预期结果）。
   - `code=-29`（`ERR_CLEARTEXT_NOT_PERMITTED`，`netErrorList.d.ts:290` / `arkweb_net_error_list.h:185`）→ 被明文策略拦下；此时才按上节加 `network_config.json` 并写 `"ArkWeb": true`，重装后复测同一信号。

## 未验证 / 不确定的点

1. **`component-config.ArkWeb` 默认 `false` 与「默认允许明文 HTTP」的关系未坐实（最关键的一条）**。官方字段表把 ArkWeb 默认值写成 `false`，而 `@ohos.net.networkSecurity` 文档写"默认允许明文 HTTP"。我的解读是：**没有 `network_config.json` 时整份策略不生效（→允许）**；**一旦有该文件而 `component-config` 未写 `ArkWeb`，ArkWeb 侧按 `false` 处理（→拦截）**。这是从两段文档字面推的，**没有**真机/官方说明直接证实，也未在 SDK 里找到 schema 文件可印证。
2. ArkWeb 是否对**顶层 http 导航**（而非混合内容）套用同一策略：SDK 只有 `-29` 的错误码与 `ERR_CLEARTEXT_NOT_PERMITTED` 文案，未看到判定逻辑；真机未验。
3. 本机 SDK 里**没有** `network_config.json` 的 schema（只有 `@ohos.net.networkSecurity.d.ts` 注释提到文件名 + FA 老 `configSchema_rich.json`），所以字段名/层级只能依赖官方文档，不能像 `module.json5` 那样从 SDK 静态验证。
4. 未验证 `resource://rawfile` 本地页面向 http 远端发 fetch 是否算"混合内容"：本 App 的 git 流量走的是 ArkTS 桥（Network Kit），**绕开了这个问题**；但若将来在 rawfile 页里直接 `fetch('http://…')`，这条路径没有任何真机证据（旧 `docs/REMOTE-DSH-M1.md` 也只讨论过方案）。
5. `apps/arkui-schedule/entry/src/main/ets/pages/Settings.ets` 当前处于**并发修改**状态（`git status` 显示 M，且其 `import { normalizeRemoteUrl, routeToRemote } from '../model/remoteUrl'` 指向的文件此刻不存在），本文件引用的 `Settings.ets` 行号（约 1436）可能已漂移；结论不依赖该行号。
6. 全部结论**未真机验证**，也未在 Android(ArkUI-X) 侧验证（两侧 WebView 明文策略不同，Android 9+ 默认禁明文，属另一套 `usesCleartextTraffic` 配置）。
