# Tailcat × HarmonyOS/ArkTS 可行性调研（spike）
> 2026-11-21；只读调研：未改源码、未装工具、未碰真机、未动 git。本机命令原样引用，外部资料给 URL；无法核实的一律写 `未确认`。
**判定：YES-WITH-COST（foreground-only）。** "编出 arm64 .so + NAPI 桥"技术上可行；但常驻需要受限权限/系统身份，普通三方 app 拿不到 ⇒ 作为**常驻一等传输 = NO**。证据见 §1–4，成本见 §5，兜底见 §6。

## 1 工具链（本机实测）
```powershell
PS> go version
go : 无法将"go"项识别为 cmdlet、函数、脚本文件或可运行程序的名称。CommandNotFoundException
PS> where.exe go
INFO: Could not find files for the given pattern(s).
```
Go **未安装**。go.dev/dl JSON 实测：最新稳定 `go1.27.4`，`go1.27.4.windows-amd64.msi` size=66,203,648 B（约 63 MiB）；安装只解决"有没有 Go"，不解决 OHOS port（§2）。
```powershell
PS> $clang = "D:\A-DevEco\DevEco Studio\sdk\default\openharmony\native\llvm\bin\clang.exe"
PS> & $clang --version
OHOS (dev) clang version 15.0.4 (llvm-project 00dcd9ccdb860908f60ff11b32239084b0908a08)
Target: x86_64-w64-windows-gnu
PS> & $clang --target=aarch64-linux-ohos -print-target-triple
aarch64-unknown-linux-ohos
```
NDK 实存：`...\sdk\default\openharmony\native\{llvm,sysroot,sysroot_lite,build-tools}`；`sysroot\usr\lib\aarch64-linux-ohos\` 下有 `libc.a`、`libace_napi.z.so`；`oh-uni-package.json`: apiVersion 26。hvigor 产物 ABI=`arm64-v8a`（`entry/build/default/intermediates/loader/default/loader.json:23`）。

## 2 交叉编译（最关键实测）
```powershell
PS> $env:CGO_ENABLED="1"; $env:CC=$clang; $env:GOOS="linux"; $env:GOARCH="arm64"; go build ./...
go : 无法将"go"项识别为 cmdlet… CommandNotFoundException   # Go 缺失，CGO 构建无法执行
PS> 'int add(int a,int b){return a+b;}' | & $clang --target=aarch64-linux-ohos --sysroot=$sysroot -x c - -c -o $tmp
clang-compile-exit=0; object=840 B; llvm-readobj -h →
Format: elf64-littleaarch64 / Class: 64-bit / Machine: EM_AARCH64 (0xB7)
```
即 **C 侧可用、Go 侧零证据**。设备真实 triple 应为 `aarch64-linux-ohos`（OHOS fork 的 `GOOS=openharmony`）；stock Go 无此 target：`https://api.github.com/repos/golang/go/issues/67829` 实测 `state=closed, state_reason=not_planned, labels=mobile/FrozenDueToAge, closed_at=2024-06-05`。`linux/arm64`+CGO 产物能否在 OHOS musl 上 dlopen、stock Go 的 initial-exec TLS 是否报错——**未确认**（仓库 RESEARCH-C 记有第三方项目声称踩到此坑，本次未复核）。

## 3 syscall / 沙箱风险
上游 README（https://raw.githubusercontent.com/tailscale/tailcat/main/README.md）：userspace WireGuard「doesn't use a kernel TUN/TAP device (nor … routing tables, DNS），不需要 root」；magicsock「direct UDP + DERP … UDP hole-punching」；gVisor netstack。故不需 tun/root/改路由。C API 在 `cmd/libtailcat/`（README「Swift / C bindings」节）。
| 能力 | 判定 |
|---|---|
| 出站 UDP/443 连 DERP | 允许（本 app 已声明 `ohos.permission.INTERNET`，module.json5:39）；真机未验 |
| raw socket / netns / 特权端口 | **未确认**；未找到三方 app 可用的官方依据 |
| UDP 打洞直连（对等入站） | **未确认**；沙箱 NAT/防火墙行为未知 |

## 4 沙箱与常驻（关键补充）
官方 openharmony/docs（master）`.../apis-backgroundtasks-kit/js-apis-resourceschedule-backgroundTaskManager.md` 原文：「当应用退至后台时…避免应用进程被终止或挂起」；`requestSuspendDelay` = 短时任务（超时前约 6s 回调）；`startBackgroundRunning` = 长时任务，**需要权限 `ohos.permission.KEEP_BACKGROUND_RUNNING`**，错误码 202 = `Not System App`。长时类型中 `MODE_DATA_TRANSFER` 要求实况窗持续更新进度，>10 分钟不更新即取消（`SYSTEM_CANCEL_DATA_TRANSFER_NOT_UPDATE`）；`MODE_TASK_KEEPING` 与 `MODE_SPECIAL_SCENARIO_PROCESSING` 需 ACL `KEEP_BACKGROUND_RUNNING_SYSTEM/SPECIAL_SCENARIO`（受限），后者只覆盖媒体导出/投播等场景。→ **没有"维持一个空闲 WireGuard/UDP socket"的通用长时类型**。本 app `module.json5` 仅 INTERNET + STYLUS_FRAME_BOOST，无 KEEP_BACKGROUND_RUNNING。
独立进程路线：`.../apis-network-kit/js-apis-VpnExtensionAbility.md` 证实 `@ohos.app.ability.VpnExtensionAbility`（API 11+，onCreate/onDestroy）是三方 VPN 的独立 ExtensionAbility，理论上可让另一进程持有 socket；但需用户 VPN 信任授权，且无 TUN 时能否承载 tailcat、是否等同系统级能力——**未确认**；普通三方 app 起常驻系统服务 **未确认/无证据**。
⇒ **平板端只能按"前台传输"定位**；退后台后 socket 存活/恢复 = 未确认且大概率被冻结。一个只在前台工作的传输，作为"始终在线的远程通道"是产品上显著更弱的一档。

## 5 成本（估算，非承诺）
- Go：装 1.27.4（≈63 MiB）+ **必须**换 OHOS Go fork 才能产出 `aarch64-linux-ohos`（stock 已 not_planned）；fork 对 tailcat 全依赖的兼容性未确认。
- NAPI 桥：`.so` 放 `libs/arm64-v8a`、`napi_module` 注册、ArkTS wrapper、INTERNET 声明（已有）；上游无 ArkTS 封装，只有 `cmd/libtailcat` C API + Swift TailcatKit（macOS14+/iOS17+）+ 实验 WASM（仅 DERP 中继，README 明确无直连，issue #4）。
- 量级：前台 PoC **约 5–10 人日**（含 fork/build/dlopen 排错）；常驻另计且需受限权限或系统身份，普通 app 不在可达范围。未知项：OHOS Go fork 能否编 tailcat、TLS/dlopen、沙箱 UDP 入站、后台保活、上架合规。

## 6 兜底（保持不变）
产品继续：平板走 Tailscale/LAN/IPv6 over HTTPS；tailcat 仅 host↔host；平板侧 adapter 保持 typed `E_TRANSPORT_UNSUPPORTED`（`remoteTransport.ts:45,168,487-506`），不静默降级。本 spike 未改任何产品代码。
