#requires -Version 5.1
<#
.SYNOPSIS
  Build the ArkUI-X project with a CPU cap (Windows) and a hard guarantee that the platform
  overlay gets restored on every exit path.

.DESCRIPTION
  The first HarmonyOS build runs ohpm/pnpm + hvigor + the Java compiler at once and can
  starve the foreground on a weak machine. This wrapper limits the whole build tree to:
    - N logical cores (processor affinity, inherited by children)
    - BelowNormal / Idle priority
    - a smaller Node heap and a capped JVM active-processor count
  While the build runs, every 2 seconds newly spawned node/java children are pushed onto
  the same limits too (some runtimes do not inherit them).

  The cap makes the build slower but keeps the desktop usable.

  OVERLAY SAFETY (why this script is shaped like this)
  ----------------------------------------------------
  tools/overlay.mjs copies entry/src/harmony/** over entry/src/main/** and records a reversible
  manifest; the tree must be restored afterwards or every later source-level test silently
  reads the harmony tree. A previous version restored only inside a `finally` that started
  *after* the overlay was applied — one exception in between (or a killed process) left the
  overlay materialized. The guarantee is now layered so that no single failure mode is fatal:

    1. STARTUP RECOVERY (authoritative): the very first thing the script does is inspect the
       overlay state; `applied=true` (or a stale `.building` marker) means a previous run died
       without restoring -> restore first, then continue building.
    2. `.building` MARKER: written before `apply`, removed by `restore`. A hard kill (Stop-Process,
       OOM, power loss) cannot run any handler, so the *next* run recognizes the marker and
       prints "上次构建未正常结束".
    3. CONCURRENCY GUARD: if the marker's owner PID is still alive, or any live hvigor/devecocli
       process exists while the overlay is applied, the script refuses to run (exit 4) instead
       of restoring somebody else's in-flight build.
    4. `trap`: catches every terminating error (throw, native-command failure under
       $ErrorActionPreference='Stop', ...) and restores + asserts before exiting.
    5. Whole-body `try/finally` + `Exit-Build` helper: every `exit` goes through one finalizer.
    6. ASSERT: after restoring, `overlay.mjs status` must report `applied=false`; if it does not,
       the script exits 3 and prints the exact repair command. Never "warn and continue".
     7. RESTORE WRAPPER (mod-build-restore-timeout): the finalizer's `restore` calls go through
        `tools/overlay-restore.ps1`, which puts a 120 s deadline on node and fails loudly with a
        greppable hint if the restore stalls. This finalizer keeps its own assert + exit-3 path.

  Note on PowerShell 5.1: `Register-EngineEvent -SourceIdentifier PowerShell.Exit -Action {...}`
  was measured on this machine and does NOT fire for `powershell -File` runs (see
  docs/VERIFICATION.md, overlay safety section), so `trap` + `finally` + the marker are used
  instead of the engine-exit event.

.PARAMETER Cores
  Number of logical cores the build may use (1..logical). Default 4.

.PARAMETER Priority
  BelowNormal (default) or Idle (yields more, builds slower).

.PARAMETER Product
  Product name from build-profile.json5. Default: default (HarmonyOS).

.PARAMETER DryRun
  Print the command and limits, do not build.

.PARAMETER FailAfterApply
  TEST-ONLY: throw right after the overlay is applied. Used to prove that the exception path
  restores the overlay; never use it for a real build.

.EXAMPLE
  powershell -File tools/build-harmony.ps1 -DryRun
  powershell -File tools/build-harmony.ps1 -Cores 4
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 64)][int]$Cores = 4,
  [ValidateSet('Normal', 'BelowNormal', 'Idle')][string]$Priority = 'BelowNormal',
  [string]$Product = 'default',
  [ValidateSet('debug', 'release')][string]$BuildMode = 'debug',
  [switch]$DryRun,
  [switch]$FailAfterApply
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logDir = Join-Path $projectRoot '.build-logs'
$overlay = Join-Path $projectRoot 'tools\overlay.mjs'
$overlayRestore = Join-Path $projectRoot 'tools\overlay-restore.ps1'
$overlayState = Join-Path $projectRoot '.platform-overlay'
$buildingMarker = Join-Path $overlayState '.building'
$deveco = if ($env:DEVECO_CLI_STUDIO_PATH) { $env:DEVECO_CLI_STUDIO_PATH } else { 'D:\A-DevEco\DevEco Studio' }
$cli = 'C:\Users\GWL\Desktop\itwillclaude\.tmp\deveco-cli\node_modules\.bin\devecocli.cmd'

# Overlay bookkeeping. State lives in $script: because the trap/finally/functions all run in
# the script scope and must agree on "did this run apply the overlay?".
$script:overlayOwned = $false      # true once *this* run applied the overlay
$script:overlayFinalized = $false  # true once the one-shot finalizer has run
$script:overlayBad = $false        # true when restore/assert failed -> exit 3
$script:overlayClean = $false      # true when the finalizer asserted applied=false

# ---------------------------------------------------------------------------
# Overlay helpers
# ---------------------------------------------------------------------------

function Write-OverlayFixHint {
  param([string]$Detail = '')
  Write-Host ''
  Write-Host '覆盖层没有被还原，工作区现在被污染（源码测试会读到 harmony 树）。修复命令：' -ForegroundColor Red
  Write-Host ("  cd `"{0}`"" -f $projectRoot)
  Write-Host '  node tools\overlay.mjs restore'
  Write-Host '  node tools\overlay.mjs status      # 必须打印 [overlay] applied=false'
  Write-Host '  git status --short                 # 应为空（entry/src/main 无改动）'
  if ($Detail -ne '') { Write-Host "  说明：$Detail" -ForegroundColor Red }
}

function Get-OverlayStatusText {
  <# Runs `overlay.mjs status` and returns its merged output ('' when node itself failed). #>
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = & node $overlay status 2>&1
    $code = $LASTEXITCODE
  } catch {
    $ErrorActionPreference = $prevEap
    return ''
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($code -ne 0) { return '' }
  return (($lines | ForEach-Object { "$_" }) -join "`n")
}

function Get-LiveBuildProcess {
  <# hvigor / devecocli processes that would mean "a build is running right now". #>
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='java.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'hvigor|devecocli' })
}

function Test-BuildingMarkerOwnerAlive {
  <# True only when the marker belongs to a *live* process (PID + start time match, so a reused
     PID does not fool us). A killed run leaves the marker behind with a dead PID. #>
  if (-not (Test-Path $buildingMarker)) { return $false }
  try {
    $record = Get-Content -LiteralPath $buildingMarker -Raw | ConvertFrom-Json
    $started = [datetime]::Parse($record.startedAt)
    $proc = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $false }
    return ([math]::Abs(($proc.StartTime - $started).TotalSeconds) -lt 60)
  } catch {
    return $false
  }
}

function Set-BuildingMarker {
  param([string]$Phase = 'apply')
  New-Item -ItemType Directory -Force -Path $overlayState | Out-Null
  $record = [ordered]@{
    pid       = $PID
    startedAt = (Get-Date -Format 'o')
    phase     = $Phase
    product   = $Product
    host      = $env:COMPUTERNAME
  }
  ($record | ConvertTo-Json -Compress) | Set-Content -LiteralPath $buildingMarker -Encoding ASCII
}

function Remove-BuildingMarker {
  Remove-Item -LiteralPath $buildingMarker -Force -ErrorAction SilentlyContinue
}

function Invoke-OverlayRestoreFinal {
  <#
    One-shot finalizer: restore + assert. Safe to call from trap, finally and Exit-Build;
    later calls are no-ops. Never throws (a cleanup path that throws would hide the real failure).
  #>
  param([string]$Stage = 'finally')

  if ($script:overlayFinalized) { return $script:overlayClean }
  $script:overlayFinalized = $true

  if (-not $script:overlayOwned) {
    # Nothing was applied by this run: do NOT touch the tree (another build may own the overlay).
    Write-Host "overlay($Stage): 本次构建未应用覆盖层，无需还原"
    $script:overlayClean = $true
    return $true
  }

  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    Write-Host "overlay($Stage): restoring"
    # mod-build-restore-timeout: the wrapper enforces a deadline, asserts applied=false and
    # exits non-zero with a greppable recovery hint when restore stalls. Exit code still
    # flows through $LASTEXITCODE into the same $ok / retry / exit-3 logic below.
    $restoreOut = & $overlayRestore 2>&1
    $restoreCode = $LASTEXITCODE
    foreach ($line in @($restoreOut)) { Write-Host "  $line" }
    $status = Get-OverlayStatusText
    foreach ($line in @($status -split "`n")) {
      if ($line -match '^\[') { Write-Host "  $line" }
    }

    $ok = ($restoreCode -eq 0) -and ($status -match 'applied=false')

    if (-not $ok) {
      # One retry: a transient file lock (antivirus, editor) is the only recoverable case.
      Write-Host '  restore 未通过断言，重试一次' -ForegroundColor Yellow
      $retryOut = & $overlayRestore 2>&1
      $retryCode = $LASTEXITCODE
      foreach ($line in @($retryOut)) { Write-Host "  $line" }
      $status = Get-OverlayStatusText
      $ok = ($retryCode -eq 0) -and ($status -match 'applied=false')
      if ($ok) { Write-Host '  overlay restored on retry' }
    }

    if ($ok) {
      Remove-BuildingMarker
      $script:overlayClean = $true
      $script:overlayBad = $false
      Write-Host "overlay($Stage): applied=false（已断言）"
    } else {
      $script:overlayClean = $false
      $script:overlayBad = $true
      Write-Host "overlay($Stage): 还原失败或断言不成立（restore exit $restoreCode）" -ForegroundColor Red
    }
  } catch {
    $script:overlayClean = $false
    $script:overlayBad = $true
    Write-Host "overlay($Stage): 还原过程抛出异常：$($_.Exception.Message)" -ForegroundColor Red
  } finally {
    $ErrorActionPreference = $prevEap
  }

  return $script:overlayClean
}

function Exit-Build {
  <# The only supported way out: finalize the overlay, then exit with the requested code. #>
  param([int]$Code)
  $clean = Invoke-OverlayRestoreFinal 'exit'
  if (-not $clean) {
    Write-OverlayFixHint 'restore 后 overlay.mjs status 仍报 applied=true'
    Write-Host 'Exit code: 3 (overlay 未还原；工作区被污染)' -ForegroundColor Red
    exit 3
  }
  exit $Code
}

# ---------------------------------------------------------------------------
# Trap: every terminating error ends here (throw, native failure, unexpected I/O)
# ---------------------------------------------------------------------------
trap {
  $message = "$($_.Exception.Message)"
  $line = "$($_.InvocationInfo.ScriptLineNumber)"
  Write-Host ''
  Write-Host "✗ 构建异常终止（第 $line 行）：$message" -ForegroundColor Red
  $clean = $false
  try { $clean = Invoke-OverlayRestoreFinal 'trap' } catch { $clean = $false }
  if (-not $clean) {
    Write-OverlayFixHint '异常路径还原失败'
    Write-Host 'Exit code: 3 (overlay 未还原；工作区被污染)' -ForegroundColor Red
    exit 3
  }
  Write-Host 'Exit code: 1 (构建异常；overlay 已还原)'
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Startup: recover a leftover overlay *before* touching anything else
# ---------------------------------------------------------------------------
Write-Host "Project : $projectRoot"
Write-Host "DevEco  : $deveco"

$statusText = Get-OverlayStatusText
if ($statusText -eq '') {
  Write-Host '✗ 无法读取覆盖层状态（node tools\overlay.mjs status 失败）' -ForegroundColor Red
  exit 3
}

# 1a. Another build of this script is still running -> refuse, do not steal its overlay.
if (Test-BuildingMarkerOwnerAlive) {
  Write-Host '✗ 另一个构建正在运行（.platform-overlay/.building 的 pid 仍存活），拒绝并发构建。' -ForegroundColor Red
  Write-Host "  确认无人构建后可删标记：Remove-Item `"$buildingMarker`" -Force"
  exit 4
}

$applied = ($statusText -match 'applied=true')
$staleMarker = Test-Path $buildingMarker

if ($applied -or $staleMarker) {
  # 1b. Concurrency guard: an overlay applied by a build that is *alive* must not be restored.
  $live = Get-LiveBuildProcess
  if ($live.Count -gt 0) {
    Write-Host "✗ 覆盖层已被应用，且检测到 $($live.Count) 个存活的 hvigor/devecocli 进程 —— 像是另一个构建正在进行。" -ForegroundColor Red
    Write-Host '  拒绝还原（会破坏那个构建）。等它结束后重跑本脚本。' -ForegroundColor Red
    Remove-BuildingMarker
    exit 4
  }

  if ($applied) {
    Write-Host '发现上一次构建残留，已先还原'
  } else {
    Write-Host '发现上一次构建未正常结束（残留 .platform-overlay/.building 标记），已先还原'
  }
  # The finalizer is the restore path; own it so the assert below is authoritative.
  $script:overlayOwned = $true
  $script:overlayFinalized = $false
  $clean = Invoke-OverlayRestoreFinal 'startup'
  if (-not $clean) {
    Write-OverlayFixHint '启动时的残留还原失败'
    Write-Host 'Exit code: 3 (overlay 未还原；工作区被污染)' -ForegroundColor Red
    exit 3
  }
  # From here on the tree is clean; a new apply will be owned again below.
  $script:overlayOwned = $false
  $script:overlayFinalized = $false
  $script:overlayClean = $false
  if (Test-Path $overlayState) { Remove-BuildingMarker }
} else {
  Write-Host 'overlay : applied=false（无残留）'
}

# A killed build leaves .hvigor/.build-lock behind and every later build waits on it forever.
# Remove it only when no hvigor process is alive (safe: nobody holds the lock).
$lock = Join-Path $projectRoot '.hvigor\.build-lock'
if (Test-Path $lock) {
  $busy = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'hvigor' }
  if (-not $busy) {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
    Write-Host 'Removed stale .hvigor/.build-lock (no hvigor process alive)'
  }
}

$logical = [Environment]::ProcessorCount
if ($Cores -gt $logical) { $Cores = $logical }
$mask = [int64]((1 -shl $Cores) - 1)
$maskHex = '0x{0:X}' -f $mask

Write-Host "Limits  : $Cores/$logical logical cores (affinity $maskHex), priority $Priority"
Write-Host "Command : devecocli build --product $Product --build-mode $BuildMode"

if ($DryRun) {
  Write-Host ''
  Write-Host '[DryRun] Environment:'
  Write-Host "  DEVECO_CLI_STUDIO_PATH=$deveco"
  Write-Host "  DEVECO_SDK_HOME=$deveco\sdk"
  Write-Host "  UV_THREADPOOL_SIZE=$([Math]::Max(1, [int]($Cores / 2)))"
  Write-Host "  JAVA_TOOL_OPTIONS=-XX:ActiveProcessorCount=$Cores"
  Write-Host '  NODE_OPTIONS=--max-old-space-size=1536'
  Write-Host ''
  Write-Host '[DryRun] Nothing executed.'
  return
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ---------------------------------------------------------------------------
# 2. Apply the overlay behind a .building marker (hard kills leave the marker)
# ---------------------------------------------------------------------------
# Platform overlay: entry's `targets[].source.sourceRoots` does NOT apply to the entry module
# (hvigor only honors it for HAR/HSP dependencies), so `src/harmony/**` would never be compiled
# and the HAP would silently ship without the handwriting page.
Set-BuildingMarker -Phase 'apply'
& node $overlay apply $BuildMode
if ($LASTEXITCODE -ne 0) {
  # `apply` refuses when a manifest already exists: that overlay belongs to somebody else,
  # so we must not claim ownership (otherwise the trap would restore their build).
  Remove-BuildingMarker
  throw "overlay apply failed (exit $LASTEXITCODE)"
}
$script:overlayOwned = $true
$script:overlayFinalized = $false

if ($FailAfterApply) {
  throw 'FailAfterApply: 测试用异常（构建未开始，覆盖层必须被 trap 还原）'
}

# ---------------------------------------------------------------------------
# 3. Build (the whole body lives in try/finally as the third safety net)
# ---------------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $logDir "build-$stamp.log"

$env:DEVECO_CLI_STUDIO_PATH = $deveco
$env:DEVECO_SDK_HOME = Join-Path $deveco 'sdk'
$env:DEVECO_CLI_DISABLE_TELEMETRY = '1'
$env:UV_THREADPOOL_SIZE = [string][Math]::Max(1, [int]($Cores / 2))
$env:JAVA_TOOL_OPTIONS = "-XX:ActiveProcessorCount=$Cores"
$env:NODE_OPTIONS = '--max-old-space-size=1536'

try {
  # Do not use Start-Process here: this machine has both NO_PROXY and no_proxy in its
  # environment, and PowerShell 5.1 duplicates that dictionary case-insensitively and throws.
  $arguments = "/c $cli build --product $Product --build-mode $BuildMode > $log 2>&1"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = $arguments
  $psi.WorkingDirectory = $projectRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $launcher = [System.Diagnostics.Process]::Start($psi)

  try { $launcher.PriorityClass = $Priority } catch { Write-Warning "priority: $($_.Exception.Message)" }
  try { $launcher.ProcessorAffinity = [IntPtr]$mask } catch { Write-Warning "affinity: $($_.Exception.Message)" }

  $started = $launcher.StartTime
  $deadline = (Get-Date).AddHours(2)
  $tick = 0
  while (-not $launcher.HasExited -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $tick++
    foreach ($p in Get-Process -Name node, java, cmd -ErrorAction SilentlyContinue) {
      try {
        if ($p.Id -eq $PID) { continue }
        if ($p.StartTime -lt $started.AddSeconds(-5)) { continue }
        if ($p.PriorityClass -ne $Priority) { $p.PriorityClass = $Priority }
        if ($p.ProcessorAffinity -ne [IntPtr]$mask) { $p.ProcessorAffinity = [IntPtr]$mask }
      } catch { }
    }
    if ($tick % 15 -eq 0) {
      $load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
      Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] building... system CPU ~$load%"
    }
  }

  $launcher.WaitForExit()
  $code = $launcher.ExitCode
} finally {
  # Third net: runs for throw / exit / Ctrl-C inside the try above. The primary guarantees are
  # the startup recovery + trap; this one only covers "somebody added a bare `exit`".
  Invoke-OverlayRestoreFinal 'finally' | Out-Null
  if (-not $script:overlayClean -and $script:overlayOwned) {
    Write-OverlayFixHint 'finally 阶段还原失败'
    Write-Host 'Exit code: 3 (overlay 未还原；工作区被污染)' -ForegroundColor Red
    exit 3
  }
}

if ($null -eq $code) { $code = 1 }
Write-Host ''
Write-Host "Exit code: $code"
Write-Host "Log: $log"
Get-Content $log -Tail 30 -ErrorAction SilentlyContinue

if ($code -eq 0) {
  # BUILD SUCCESSFUL is not delivery: assert the artifacts actually contain the feature.
  Write-Host ''
  Write-Host '== verify HAP contents =='
  & node (Join-Path $projectRoot 'tools\verify-hap.mjs')
  if ($LASTEXITCODE -ne 0) {
    Write-Host "HAP content verification failed (exit $LASTEXITCODE)" -ForegroundColor Red
    Exit-Build $LASTEXITCODE
  }
}

Exit-Build $code
