# AppGallery（华为应用市场）发布计划 — DSH-Dots / `com.itwill.schedule`

> 资料基准日：**2026-11-20**（外部页面访问日同此日，逐条附 URL）。仓库事实以 `file:line` 标注。
> 本文是 **research + docs only**：不注册账号、不申请证书、不提审、不上传、不改设备、不改代码。
> 官方现行术语是「HarmonyOS 5 及以上 / HarmonyOS 开发者中心」；「HarmonyOS NEXT / 纯血鸿蒙」是营销称谓，本文不把它当作独立的账号权限类别。

## 1 发布者账号与资质

| 事项 | 结论 | 依据 |
| --- | --- | --- |
| 账号 + 实名认证 | 必须注册华为开发者联盟账号并完成实名认证，否则无法进入管理中心/发布应用；认证审核官方标 1–3 个工作日（该页更新时间 2020-10-10，时效较旧） | https://developer.huawei.com/consumer/cn/doc/registration-and-verification-0000001053628148 （访问 2026-11-20） |
| 个人 vs 企业可发布范围 | 两类账号的权益表**都含「应用市场」**；企业额外有首发、支付、应用市场推广、云测、智能家居等。故「个人账号可发布 AppGallery 应用」有官方依据；「个人账号不能发布 HarmonyOS 5+/NEXT 应用」**未验证**（未找到该规定的官方页面） | 同上 |
| 敏感应用的认证方式 | 个人：敏感应用只能走个人银行卡认证；非敏感可选银行卡或身份证人工审核。企业：敏感应用只能对公打款；非敏感可选对公打款或资料人工审核 | 同上 |
| HarmonyOS NEXT 发布权 | 发布文档按「HarmonyOS 5 及以上」与「3.1/4.0 及以下」分卷，未对账号类型设额外门槛；新创建应用默认为 5.0 及以上 | https://developer.huawei.com/consumer/cn/doc/app/agc-help-release-app-0000002271695230 ；https://developer.huawei.com/consumer/cn/doc/app/agc-help-harmonyos-releaseapp-non-next-0000002179322402 （访问 2026-11-20） |
| 工信部 APP 备案 | `APP主办者`须按《反电信网络诈骗法》第 23 条与工信部通知履行核准（备案）；HarmonyOS 应用由**接入商代备案**，填写时须选「鸿蒙」平台并填包名；同一主体不同 APP 名称不可重复，跨平台上架同一 APP 名称须一致；未完成备案影响搜索与展示 | https://developer.huawei.com/consumer/cn/doc/app/50130 （更新 2026-10-15，访问 2026-11-20） |
| 备案主体一致性 | 可勾「与开发者账号主体一致」由系统核验；不一致须手填主办单位名称 + 证件号；包名/名称/主体须与在架信息一致 | 同上 |
| 软件著作权 | 官方资质页写明「APP 软件著作权证书为**非必选资质**，但建议申请」；但审核指南 1.1 要求「上传的应用名称需与《计算机软件著作权登记证书》上软件名称/简称一致」，且发布页对中国大陆手机应用列「应用版权证书或代理证书：必选」。两处口径张力 → **软著是否实际必需：未验证（需向华为客服确认）** | https://developer.huawei.com/consumer/cn/doc/doccenter-submission/80301 ；https://developer.huawei.com/consumer/cn/doc/doccenter-submission/50104 ；https://developer.huawei.com/consumer/cn/doc/app/agc-help-harmonyos-releaseapp-non-next-0000002179322402 （访问 2026-11-20） |
| AI 功能资质（本 app 的主要资质风险） | 「深度合成或生成式人工智能服务」需：AI 生成合成内容标识材料（显式标识截图或说明函）、算法备案查询结果截图（`beian.cac.gov.cn`）、合作方算法备案 + 协议、安全评估报告及其提交结果截图；使用第三方 AI 服务时需合作方「生成合成类」算法备案 | https://developer.huawei.com/consumer/cn/doc/doccenter-submission/80301 （访问 2026-11-20） |
| 其他资质 | 聊天/社区/通讯类另需安全评估报告 + 网站平台提交结果 + 增值电信业务经营许可证；本 app 只做**只读会话浏览**且非公开社交，是否落入该类**未验证** | 同上 |
| 个人开发者附加材料 | 个人开发者须同时提供「个人开发者承诺函.zip」 | 同上 |

## 2 证书与签名

**现状（仓库事实）**：`apps/arkui-schedule/signing/README.md:6-7` 明示目录内是**调试身份**，「不能用于应用市场发布/上架」，正式发布需另申请 release 证书与 release Profile；`:11-16` 列出 `itwill-debug.p12/.csr/.cer/.p7b`；`:45-59` 的 p7b `type=debug`、绑定 `com.itwill.schedule` + 单台设备 UDID + developer-id；`:36-43` 证书链叶子含 `Development`、有效期至 2027-11-15。`sign-hap.ps1:55-71` 优先选 `itwill-debug-v2.*`，缺件则回退到标注 `LEAKED KEY` 的 v1 材料；`:28`/`:51` 默认别名 `debugkey`；`:142` 交付名固定 `arkui-schedule-harmony-debug-signed.hap`。

| 发布侧要求 | 官方事实（URL + 访问日 2026-11-20） |
| --- | --- |
| 发布证书 | `.cer`，含公钥与指纹；每账号最多 3 个；实名开发者发布证书有效期 3 年；需账号角色有「访问发布类证书」权限；更新版本须用**同一个 CSR** 生成的证书并同步更新 Profile | https://developer.huawei.com/consumer/cn/doc/app/agc-help-add-releasecert-0000001946273961 （更新 2026-10-13） |
| 发布 Profile | `.p7b`，含包名、证书信息、允许的权限列表；**Release 类型设备列表为空**；每应用最多 100 个；Profile 中申请的权限必须包含软件包声明的所有权限；受限开放权限未在 Profile 申请会导致审核驳回。证书页「备案信息」可导出公钥/指纹供备案使用 | https://developer.huawei.com/consumer/cn/doc/app/agc-help-add-releaseprofile-0000001914714796 （更新 2026-10-13） |
| **上架包是 APP，不是 HAP** | 官方 FAQ：「HAP 是用于本地调试的，APP 包是用于上架发布的」「APP 包能本地安装吗？**不能**」 | https://developer.huawei.com/consumer/cn/doc/doccenter-submission/agc-help-release-faq-0000002298937792 （更新 2026-10-13） |
| 发布后重签名 | 上架后开发者中心会对应用重签名（不改变应用本身签名）；版本回退后再次升级，提交签名须与该版本签名一致 | https://developer.huawei.com/consumer/cn/doc/app/agc-help-harmonyos-releaseapp-non-next-0000002179322402 ；https://developer.huawei.com/consumer/cn/doc/doccenter-submission/agc-help-maintain-rollback-0000002236334578 （访问 2026-11-20） |

**私钥纪律**：release `.p12` 与其口令只能存本机（建议 `signing/` 的 git-ignored 路径或系统密钥库），**永不进仓库/文档/日志/CI 变量明文**；现有 `sign-hap.ps1:73-79` 从 `signing/pass.txt`（git-ignored）读口令，历史曾泄露 v1 私钥（`:55`/`:70`），仓库已对历史做过脱敏重写（`docs/ROADMAP.md:471-476`）。不要复用任何已泄露材料做发布签名。

**接入点（提案，未实施）**：
1. `apps/arkui-schedule/build-profile.json5:11` 当前 `"signingConfigs": []`。需在 DevEco 侧为 **release product** 配置发布证书/Profile（发布包 `.app` 由 hvigor/DevEco 构建，非本仓离线脚本产物）。
2. `tools/build-harmony.ps1`：参数仅 `-Cores/-Priority/-Product/-DryRun/-FailAfterApply`（`:46-73`），`:329` 固定 `devecocli build --product $Product`，`:434-442` 只调用 `verify-hap.mjs`。建议新增 `-Release` 开关切换 release product + 产物扩展名校验（`.app`），并为 `.app` 增一个产物校验入口；不要改 overlay 还原保障（`:18-44`、`:352-360`）。
3. `tools/sign-hap.ps1`：新增显式 `-KeyStore/-Cert/-Profile/-KeyAlias/-OutName` 参数；**删除 `:66-71` 的 debug 回退分支**（发布签名绝不静默降级）；口令改从环境变量/密钥读取；交付名 `:142` 增加 release 变体，避免覆盖 debug 产物。`:95-109` 的 `hap-sign-tool sign-app -mode localSign` 参数形态可复用，但 `:31` 的 `CompatibleVersion=26` 与 API level 需在 release 环境复核。
4. 本仓脚本当前只能产 signed **HAP**（用于装机自测）；AGC 上传的 **APP 包**构建链是本仓最大工程缺口，见 §7。

## 3 应用标识

- `bundleName = com.itwill.schedule`（`apps/arkui-schedule/AppScope/app.json5:3`；`vendor=itwill` `:4`）。`entry/src/main/app.json5` **不存在**（全仓仅 `AppScope/app.json5`），任务书中该路径为笔误。
- `versionName = 1.0.0`、`versionCode = 1000000`（`AppScope/app.json5:5-6`）。**单调规则**：上传软件包的 `versionCode` 不得低于当前在架版本（分阶段发布文档明确此约束）；回退后升级的签名必须与前一版本一致（§2）。建议：`versionCode` 每次发布 +1 且永不回退，`versionName` 用语义化版本并与商店「新版本特性」同步；当前两个字段自 2026-11-15 以来未动（`docs/ROADMAP.md:12`）。
- 设备范围：`module.json5:7-10` 声明 `phone` + `tablet`，商店勾选范围必须 ≤ 软件包声明范围；`installationFree:false`（`:12`）满足非免安装要求。
- 应用名称：≤15 个汉字或 30 个其他语言字符；不得为通用词/热门搜索词；一个自然年最多改 2 次；须与软件包内名称一致（审核指南 1.1/1.12/1.4）。
- 备案：本 app 连接公网 Git 仓库与外部 AI 服务，**不宜勾选「单机APP」**（官方定义：未通过连接公共互联网提供互联网信息服务的移动应用程序）；须按「鸿蒙」平台填 `com.itwill.schedule`，并与开发者账号主体一致或如实填写主办单位；包名/名称/主体与在架信息不一致会导致校验失败。

## 4 商店资料

**基础素材**（官方字段，URL 见 `https://developer.huawei.com/consumer/cn/doc/app/agc-help-harmonyos-releaseapp-non-next-0000002179322402` 与 `.../agc-help-release-app-guide-0000002287176372`，访问 2026-11-20）：应用图标（与包内一致、不得为系统图标）；截图**至少 3 张不同内容**、方向正确、不得模糊/重复；应用介绍必填 ≤8000 字；一句话简介中文 ≤17 字符；新版本特性中国大陆 ≤500 字符；分类二级 + 标签 ≤5 个（主标签须与二级分类关联）；年龄分级问卷据实填写（虚假陈述可致下架/冻结）；隐私政策 URL **必须公网可访问且始终可打开**，另需「隐私权利网址」（删除/修改/导出个人数据入口）；无自有页面可用 AGC 隐私声明托管服务（发布指引页明确）。隐私政策内开发者名称/应用名称须与提交信息一致；应用内也须可便捷查看（审核指南 7.1）。

**隐私合规三清单 → 本 app 实际权限/数据流映射**（仓库事实 `apps/arkui-schedule/entry/src/main/module.json5:37-44`；全仓 `grep ohos.permission.` 仅 3 处命中：`module.json5:39` INTERNET、`module.json5:42` STYLUS_FRAME_BOOST、`ets/pages/RemoteControl.ets:26` 只是提到 INTERNET 的注释）：

| 清单 | 本 app 应填内容 | 判定 |
| --- | --- | --- |
| 权限清单 | `ohos.permission.INTERNET`（Git 同步 / AI 请求 / 远程 Web 加载）；`ohos.permission.STYLUS_FRAME_BOOST`（手写笔帧率提升） | 两者均为普通权限，**不是**敏感权限或受限开放权限；AGC「应用隐私说明」仅在检测到敏感/受限权限时必填，本 app 预计不触发、无需使用场景视频。但 INTERNET 天然宽泛，隐私政策须**按用途逐项说明**，不得只写「网络访问」。无过度宽泛的已声明权限；真正的覆盖不足在数据流声明（下行） |
| 个人信息收集清单（工信部「双清单」，须在 APP 二级菜单展示，审核指南 7.25） | 日程标题/正文/作者（用户内容-文字信息）、手写笔迹截图（图片或视频）、设备标识 `deviceId`（标识符-用户标识符）、Git 仓库地址 + 令牌与 AI API Key（账号信息/凭据，须说明仅本地存储与用途）、DSH 会话只读内容、远程地址/端口（应用设置信息）。存证/同步范围见 `docs/DATA-CONTRACT-v2.md` 与 `docs/RUNBOOK.md:31-36` | 当前**没有**应用内二级菜单双清单页面，属阻塞项（§7） |
| 第三方 SDK 清单 | 隐私政策须逐一明示 SDK 名称/开发者/收集范围/目的/隐私政策链接，并与「全国SDK管理服务平台」一致（审核指南 7.2）。外部服务至少涉及：AI 服务（DeepSeek / opencode-go / OpenAI / custom，`docs/ROADMAP.md:12`）、Git 托管（仓库地址由用户填）、远程通道（LAN/IPv6/Cloudflare/Tailscale/UU，`docs/ROADMAP.md:306-313`）。JS 库（isomorphic-git、JSZip）与 ArkWeb 是否计入 SDK 清单**未验证**（未做依赖审计） | 阻塞项；清单完整性**未验证** |
| 隐私标签（12 大类/91 数据项，业务场景最多 6 种；`https://developer.huawei.com/consumer/cn/doc/doccenter-submission/privacy-label`，访问 2026-11-20） | 建议场景：`应用功能`（核心）；`向第三方披露`（AI/Git/远程，若成立）；`跨境传输`（若 AI 或 Git 服务在境外，须同时勾「同意应用数据出境声明」）；`分析` 当前**不适用**（本仓无 analytics/crash reporting）；`广告与营销` **不选**（审核指南要求无广告不得勾选） | 需按最终服务地域复核 |

隐私弹窗须有明确同意 + 拒绝、不得默认勾选；敏感信息单独同意；权限最小化和动态申请（审核指南 7.5/7.8/7.17/7.18）。本 app 的隐私弹窗/权限 reason 文案现状**未验证**（未在本次只读调研中逐页核对）。

## 5 审核风险（功能 → 审问点 → 诚实表述）

| 功能（仓库依据） | 审核员可能质疑 | 建议诚实表述 |
| --- | --- | --- |
| 内嵌 Web 远程控制（`docs/ROADMAP.md:366-399`；`ets/pages/RemoteControl.ets`） | 审核指南 2.4「不得允许远程攻击者控制手机、接收攻击者下发的远程控制指令」 | 「由用户在设置中主动填写地址/端口并显式点击连接，仅在本机展示用户自有 DSH 的 Web 界面；不监听公网、不接收远端下发的控制指令、不控制本机系统设置」。不要写成「远程控制平板」 |
| 端口映射 / UU 说明（`docs/ROADMAP.md:143-147`、`:159-162`；`mod-remote-hints`） | 文案承诺与实测不符、诱导用户装第三方 | 六条前置条件提示只按 `REMOTE_MODE_HINTS` 查表（`docs/MODULES.md:51`）；UU 免费版含图形化端口映射（官方 blog，见 `docs/ROADMAP.md:143`）；入口形态与 WebSocket 透传两个实测点仍**未完成**，商店文案不得断言「已支持/已验证」 |
| 局域网访问（`docs/ROADMAP.md:403-405`、`:232-251`） | 后台常驻、扫描局域网、越权访问 | 「用户主动发起；旁挂监听绑具体 IPv4/IPv6，绝不绑 `0.0.0.0`；令牌门 + 上游会话 cookie 不下发客户端」 |
| 本地文件读写（导出/导入 `docs/EXPORT-IMPORT.md`；`docs/RUNBOOK.md:31-36`） | 静默读取用户文件 | 「仅应用沙箱内写 `timeline/**`；导入/导出经用户选文件与显式确认，不读应用外目录」 |
| AI 调用外部服务（`docs/ROADMAP.md:12`；`model/aiProvider.ts`） | 生成式 AI 资质、算法备案、数据出境、用户 Key 上传 | 「用户自带 Key（BYOK），摘要文本由用户主动触发并仅发往用户所选服务；无隐式后台调用」。若被判定为生成式 AI 服务，须按 §1 提交标识/算法备案/安全评估材料；是否落入该类别**未验证** |
| 从 Git 仓库同步配置（`docs/STATE-OF-PROJECT.md:58`；`docs/RUNBOOK.md:26`） | 审核指南 3.13「不得从其他来源下载/执行会修改应用本身功能的代码」 | 「同步内容是日程数据 `timeline/**`（records/summary/media/账本），**不是**代码、脚本或 APK；不下载可执行代码、不热更新」 |
| 只读浏览 DSH 会话（`docs/STATE-OF-PROJECT.md:9`；chat 单写者设计） | 窃取/外传聊天内容 | 「只读浏览，无写回、无输入框；数据留在用户自有 Git 仓库」 |
| 调试签名 / 测试痕迹 | 审核指南 3.8「发布版本不得为可调试版本」、常见驳回第 7 项「包含测试数据或测试版本」 | 必须提交 release 签名、无测试数据的正式包（当前仓库做不到，见 §7） |
| 分类饱和（记事本/日历类） | 审核指南 3.5/3.7「同质化、简单套壳可能被拒」 | 突出差异化：手写笔迹 + Git 单时间线同步 + DSH 伴侣；避免把内嵌 Web 页描述成应用主功能（3.5「不得是简单打包的网站页面」） |

## 6 流程（官方状态与时长）

1. **构建发布包**：release 证书 + release Profile 签名的 **APP 包**（非 HAP，§2/§3）；`release` 签名且不含调试开关。
2. **上传软件包**：AGC「软件包管理 → 上传」，使用场景选「测试和正式上架」（选「仅测试」则不能用于正式版本）；检测状态为 已达标 / 待优化 / 不通过（不通过不可上架）。
3. **选包 + 配置版本**：发布国家/地区（选非中国大陆需勾「同意应用数据出境声明」）→ 素材/简介 → 内容分级问卷 → 隐私说明 → 隐私声明 URL + 隐私权利 URL → 隐私标签 → AI 功能声明 → 版权信息 → 备案信息 → 审核备注/测试账号 → 联系方式 → 上架时间（立即或指定；指定时间可「手动发布」，几分钟内生效）→ 提交审核。
4. **审核时长**：官方「常规应用审核时效通常为 24 小时」，复杂功能/节假日/高峰期可能延长（`https://developer.huawei.com/consumer/cn/doc/doccenter-submission/50104`，更新 2026-10-30）；等待数天可「催审」；加急仅账号持有者可申请，每应用每自然年 **3 次**（`.../agc-help-release-push-0000002312626049`，访问 2026-11-20）。状态机：准备提交 → 正在等待审核 → 正在审核 → 待修改 / 待上架 / 已上架 / 已撤销上架 / 下架处理中 / 被下架 / 被开发者下架（`.../agc-help-release-faq-0000002298937792`）。
5. **灰度**：分阶段发布先向比例用户放量（比例 `>0 且 <100`，小数最多 2 位；生效周期 ≤365 天；暂停/恢复/取消无需人工审核；一个应用只能有一个在架分阶段版本）。**该文档标注「即将下线，新功能参考《分阶段发布（7天内自动更新）》」**，新版细节本次未抓取 → **未验证**。（`.../agc-help-maintain-phased-release-0000002271493785`，访问 2026-11-20）
6. **回滚/下架**：「版本回退」只能回到最近一次上架版本且按发布顺序逐级回退，需华为审核；**分阶段发布版本不支持回退**；取消分阶段发布立即下架且无需审核；全网版本下架审核通过后分阶段版本随之下架。回退后再次升级须保持与前一版本相同签名 → release 证书必须长期稳定保管。（`.../agc-help-maintain-rollback-0000002236334578`，访问 2026-11-20）
7. **预empt 常见驳回**（审核指南「常见审核不通过原因」，更新 2026-10-30）：① APP 未备案；② 资质缺失/不合规；③ 个人信息保护不合规；④ 功能异常；⑤ UX 不合规（深色模式/对比度）；⑥ 名称/图标/内容与他人相似；⑦ 含测试数据或提交测试版本。逐项对照本文 §1/§4/§5 自检后再提审。

## 7 与当前仓库的差距分析

仓库已有：debug 签名与离线 HAP 签名（`signing/README.md:6-16`、`sign-hap.ps1`）、HAP 构建与产物校验（`build-harmony.ps1:329`/`:434-442`）、`validate-app` 8/8、全量 `node --test` ≥2900 例（近期记录 `docs/ROADMAP.md:204` 的 2954/2953/0/1，最终数字由 Lead 回填）、v2-only 数据契约与回滚链（`docs/STATE-OF-PROJECT.md:9`、`docs/MODULES.md §1.1`）。**未发 Release、只打 `dist-*`（`docs/ROADMAP.md:324-337`）**。

| 项 | 已有 | 缺失 | 阻塞级别 |
| --- | --- | --- | --- |
| 发布者账号实名认证 | 无证据 | 注册 + 实名（企业/个人）| **P0** |
| release 证书 + release Profile | 仅 debug（含已泄露 v1 回退） | 新 CSR → release `.cer`/`.p7b`，私钥本地保管 | **P0** |
| 上架 APP 包构建链 | 只有 signed HAP | release product + `.app` 产物；`signingConfigs=[]`（`build-profile.json5:11`） | **P0** |
| 工信部（鸿蒙）备案 | 无 | 接入商备案 + 包名/主体一致填报 | **P0** |
| AI 功能资质 | 无 | AI 标识材料、算法备案截图、安全评估报告（若被判定适用） | **P0** |
| 隐私政策 URL + 隐私权利 URL | 无 | 公网页面，含开发者/应用名、第三方服务、权利入口；应用内可查看 | **P0** |
| 应用内双清单 + 隐私弹窗 | 未验证 | 已收集/共享清单二级菜单；同意/拒绝弹窗 | **P1** |
| 隐私标签与 SDK 清单 | 无 | 三清单映射（§4）+ 依赖审计 | **P1** |
| 商店素材 | 无（包内 `icon` 资源存在，`module.json5:19`） | ≥3 截图、简介、一句话、新版本特性、分类标签、年龄问卷 | **P1** |
| 版本纪律 | 固定 `1.0.0`/`1000000`（`AppScope/app.json5:5-6`） | 单调 versionCode 流程 + 发布台账 | **P1** |
| 软著 / 版权材料 | 无 | 名称一致性 + 中国大陆手机应用版权证书（必需性未验证） | **P1** |
| 分析 / 崩溃上报 | 明确没有 | 若上线后需质量数据需新增（并同步隐私标签） | **P2** |
| 测试覆盖 | ≥2900 例本地门闸 | 真机/双端/重启仍 `unverified`（`docs/STATE-OF-PROJECT.md:80-91`），不能作为上架功能完备性证据 | **P1** |

## 8 成本与时间估算 + 按阻塞程度排序的 checklist

> 下表「工期/费用」除注明官方的以外**均为本项目自估，非华为报价**；官方未给出的周期/费用一律标 **未验证**。

| 项 | 工期（自估） | 费用（官方除外均未验证） | 官方已知时长 |
| --- | --- | --- | --- |
| 个人/企业实名认证 | 1–3 工作日 | 未验证 | 1–3 工作日（2020 文档） |
| release 证书 + Profile | 1–3 工作日 | 未验证 | — |
| APP 包构建链接入 | 2–5 人日 | — | — |
| 工信部备案 | 未验证 | 未验证 | — |
| 软著 | 未验证 | 未验证 | — |
| AI 资质（算法备案/安全评估） | 未验证 | 未验证 | — |
| 隐私政策页 + 双清单 + 弹窗 | 3–5 人日 | 自有域名/托管费未验证 | — |
| 商店素材 + 文案 | 2–3 人日 | — | — |
| 审核 | — | — | 通常 24 小时；加急 3 次/年 |
| 灰度 + 回退预案 | 1 人日 | — | 手动发布数分钟；回退需审核 |

**Checklist（按阻塞程度）**：
- [ ] **P0-1** 决定账号主体（个人/企业），完成注册 + 实名认证；确认敏感应用认证方式。
- [ ] **P0-2** 用新 CSR 申请 release 证书 + release Profile（Release 类型、含全部声明权限）；私钥与口令只存本机。
- [ ] **P0-3** 打通 release APP 包构建（不是 HAP）；改 `build-harmony.ps1` / `sign-hap.ps1` 的签名为显式 release 参数并去掉 debug 回退。
- [ ] **P0-4** 通过接入商完成「鸿蒙」平台 APP 备案，核对包名 `com.itwill.schedule` 与主体一致。
- [ ] **P0-5** 向华为客服确认 AI 摘要功能是否触发生成式 AI 资质，并按结论备齐标识/算法备案/安全评估材料。
- [ ] **P0-6** 上线隐私政策 URL + 隐私权利 URL（含第三方服务清单），应用内可查看。
- [ ] **P1-7** 应用内「双清单」二级菜单 + 隐私弹窗 + 权限 reason 文案。
- [ ] **P1-8** 隐私标签（业务场景/数据项）与第三方 SDK 清单依赖审计。
- [ ] **P1-9** 图标 + ≥3 截图 + 简介/一句话/新版本特性 + 分类标签 + 年龄问卷；按 §5 重写审核备注。
- [ ] **P1-10** 定版 `versionCode` 单调策略；准备测试账号/演示视频（远程页需特殊环境，审核指南 1.21）。
- [ ] **P1-11** 真机补齐 `docs/STATE-OF-PROJECT.md:80-91` 的未验证项，再决定提审时点。
- [ ] **P2-12** 评估是否引入 analytics/crash reporting（引入即同步更新隐私标签）。
- [ ] **P2-13** 提审 → 24h 量级等待 → 1%→…→全网灰度 → 保留回退证书与上一版包。

## 9 边界声明

- 本次**只做研究与文档**：未注册账号、未申请证书/Profile、未提交审核、未上传任何包、未调用 `hdc`、未构建/安装/触碰平板、未改代码、未推送。
- 外部事实均附官方 URL + 访问日 `2026-11-20`；仓库事实均附 `file:line`。**未验证项**如下，不得当作结论使用：
  1. 个人账号能否发布 HarmonyOS 5+/NEXT 应用的明确官方规定（未找到）；2. 软著实际是否必需（两处官方口径张力）；3. 备案/软著/AI 资质的周期与费用；4. 分阶段发布（7天内自动更新）新版的百分比与时长细节；5. 应用素材具体尺寸/格式规范（未抓取 `应用素材规范` 页）；6. 本 app 的 AI 摘要是否被判为「生成式 AI 服务」；7. 第三方 SDK 完整清单（未做依赖审计）；8. 应用内隐私弹窗/双清单现状（未逐页核对）；9. UU 入口形态与 WS 透传实测点（`docs/ROADMAP.md:159-162`）；10. 聊天只读浏览是否落入「聊天/社区」资质类；11. `CompatibleVersion=26` 在 release 环境的适配性；12. `entry/src/main/app.json5` 不存在（仓库确证，任务书路径有误）。
- 方法说明：`web_search` 本次因凭据 401 不可用；官方页面经浏览器渲染读取（`web_fetch` 对 JS 渲染页只返回「文档中心」，故未采用其正文）。抓不到的页面一律标注未验证，未以猜测补齐；官方未公布的数字未作陈述。
