#requires -Version 5.1
<#
.SYNOPSIS
  Build the ArkUI-X project with a CPU cap (Windows).

.DESCRIPTION
  The first HarmonyOS build runs ohpm/pnpm + hvigor + the Java compiler at once and can
  starve the foreground on a weak machine. This wrapper limits the whole build tree to:
    - N logical cores (processor affinity, inherited by children)
    - BelowNormal / Idle priority
    - a smaller Node heap and a capped JVM active-processor count
  While the build runs, every 2 seconds newly spawned node/java children are pushed onto
  the same limits too (some runtimes do not inherit them).

  The cap makes the build slower but keeps the desktop usable.

.PARAMETER Cores
  Number of logical cores the build may use (1..logical). Default 4.

.PARAMETER Priority
  BelowNormal (default) or Idle (yields more, builds slower).

.PARAMETER Product
  Product name from build-profile.json5. Default: default (HarmonyOS).

.PARAMETER DryRun
  Print the command and limits, do not build.

.EXAMPLE
  powershell -File tools/build-harmony.ps1 -DryRun
  powershell -File tools/build-harmony.ps1 -Cores 4
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 64)][int]$Cores = 4,
  [ValidateSet('Normal', 'BelowNormal', 'Idle')][string]$Priority = 'BelowNormal',
  [string]$Product = 'default',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logDir = Join-Path $projectRoot '.build-logs'
$deveco = if ($env:DEVECO_CLI_STUDIO_PATH) { $env:DEVECO_CLI_STUDIO_PATH } else { 'D:\A-DevEco\DevEco Studio' }
$cli = 'C:\Users\GWL\Desktop\itwillclaude\.tmp\deveco-cli\node_modules\.bin\devecocli.cmd'

# A killed build leaves .hvigor/.build-lock behind and every later build waits on it forever.
# Remove it only when no hvigor process is alive (safe: nobody holds the lock).
$lock = Join-Path $projectRoot '.hvigor\.build-lock'
if (Test-Path $lock) {
  $busy = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'hvigor' }
  if (-not $busy) {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
    Write-Host "Removed stale .hvigor/.build-lock (no hvigor process alive)"
  }
}

$logical = [Environment]::ProcessorCount
if ($Cores -gt $logical) { $Cores = $logical }
$mask = [int64]((1 -shl $Cores) - 1)
$maskHex = '0x{0:X}' -f $mask

Write-Host "Project : $projectRoot"
Write-Host "DevEco  : $deveco"
Write-Host "Limits  : $Cores/$logical logical cores (affinity $maskHex), priority $Priority"
Write-Host "Command : devecocli build --product $Product"

if ($DryRun) {
  Write-Host ""
  Write-Host "[DryRun] Environment:"
  Write-Host "  DEVECO_CLI_STUDIO_PATH=$deveco"
  Write-Host "  DEVECO_SDK_HOME=$deveco\sdk"
  Write-Host "  UV_THREADPOOL_SIZE=$([Math]::Max(1, [int]($Cores / 2)))"
  Write-Host "  JAVA_TOOL_OPTIONS=-XX:ActiveProcessorCount=$Cores"
  Write-Host "  NODE_OPTIONS=--max-old-space-size=1536"
  Write-Host ""
  Write-Host "[DryRun] Nothing executed."
  return
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Platform overlay: entry's `targets[].source.sourceRoots` does NOT apply to the entry module
# (hvigor only honors it for HAR/HSP dependencies), so `src/harmony/**` would never be compiled
# and the HAP would silently ship without the handwriting page. tools/overlay.mjs copies the
# harmony tree over src/main/ and records a reversible manifest; it is restored after the build.
$overlay = Join-Path $projectRoot 'tools\overlay.mjs'
& node $overlay apply
if ($LASTEXITCODE -ne 0) { throw "overlay apply failed (exit $LASTEXITCODE)" }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $logDir "build-$stamp.log"

$env:DEVECO_CLI_STUDIO_PATH = $deveco
$env:DEVECO_SDK_HOME = Join-Path $deveco 'sdk'
$env:DEVECO_CLI_DISABLE_TELEMETRY = '1'
$env:UV_THREADPOOL_SIZE = [string][Math]::Max(1, [int]($Cores / 2))
$env:JAVA_TOOL_OPTIONS = "-XX:ActiveProcessorCount=$Cores"
$env:NODE_OPTIONS = '--max-old-space-size=1536'

# Do not use Start-Process here: this machine has both NO_PROXY and no_proxy in its
# environment, and PowerShell 5.1 duplicates that dictionary case-insensitively and throws.
$arguments = "/c $cli build --product $Product > $log 2>&1"
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
try {
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
  # Restore the shared tree as soon as the build process is done (also on Ctrl-C / timeout),
  # so a hung pipe or an interrupted run can never leave the overlay materialized.
  & node $overlay restore
  if ($LASTEXITCODE -ne 0) { Write-Warning "overlay restore failed (exit $LASTEXITCODE)" }
  $status = (& node $overlay status) -join ' '
  Write-Host "overlay: $status"
  if ($status -notmatch 'applied=false') { Write-Warning "overlay may still be applied - run: node tools/overlay.mjs restore" }
}
Write-Host ""
Write-Host "Exit code: $code"
Write-Host "Log: $log"
Get-Content $log -Tail 30 -ErrorAction SilentlyContinue

if ($code -eq 0) {
  # BUILD SUCCESSFUL is not delivery: assert the artifacts actually contain the feature.
  Write-Host ""
  Write-Host "== verify HAP contents =="
  & node (Join-Path $projectRoot 'tools\verify-hap.mjs')
  if ($LASTEXITCODE -ne 0) {
    Write-Host "HAP content verification failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

exit $code
