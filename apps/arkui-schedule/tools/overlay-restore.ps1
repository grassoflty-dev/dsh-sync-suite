#requires -Version 5.1
<#
.SYNOPSIS
  Restore the platform overlay with a hard timeout, then assert `applied=false`.

.DESCRIPTION
  Wrapper around `node tools/overlay.mjs restore` used by build-harmony.ps1's finalizer.

  Why this exists (2026-11-21 incident): a successful hvigor build finished at 14:00:55 but
  the post-build restore never completed, leaving `[overlay] applied=true` and overlay
  artifacts in entry/src/main. Anything that blocks node during restore used to hang the
  finalizer forever with no diagnostic. This wrapper puts a wall-clock deadline on the
  restore, prints a greppable `[overlay-restore] TIMEOUT ...` / `FAILED ...` line with the
  exact manual recovery command, and exits non-zero so the caller's exit-3 path still fires.

  Behaviour:
    1. Read `overlay.mjs status`; if it already says applied=false, print a one-line no-op
       and exit 0 (idempotent — safe to call from trap / finally / exit paths repeatedly).
    2. Run `node tools/overlay.mjs restore` under a deadline (-TimeoutSec, default 120).
       On deadline, kill the whole process tree and report TIMEOUT (exit 2).
    3. Re-read `overlay.mjs status`; it must report applied=false (exit 0), otherwise
       report FAILED with the manual recovery command (exit 3).

  The applied/unknown/not-applied decision is shared with the Node tests through
  tools/overlay-restore-status.mjs — do not duplicate its regex here.

.PARAMETER TimeoutSec
  Wall-clock seconds allowed for the restore child process. Default 120.

.EXAMPLE
  powershell -File tools/overlay-restore.ps1
  powershell -File tools/overlay-restore.ps1 -TimeoutSec 30
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 3600)][int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $toolsDir
$overlay = Join-Path $toolsDir 'overlay.mjs'
$decider = Join-Path $toolsDir 'overlay-restore-status.mjs'
$timeoutMs = $TimeoutSec * 1000

function Get-OverlayStatus {
  <# Returns @{ text = <merged stdout+stderr>; code = <node exit code> }. Never throws. #>
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = & node $overlay status 2>&1
    $code = $LASTEXITCODE
    return @{ text = (($lines | ForEach-Object { "$_" }) -join "`n"); code = $code }
  } catch {
    return @{ text = ''; code = -1 }
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

function Test-OverlayRestored {
  <# True only for a successful status read that explicitly reports applied=false. #>
  param([string]$Text, [int]$Code)
  if ($Code -ne 0) { return $false }
  if ($Text -notmatch 'applied=false') { return $false }
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $verdict = ($Text | & node $decider --needs-restore 2>$null | Select-Object -First 1)
    return ($verdict -eq 'no')
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

# 1. Idempotency: nothing to do when a previous run (or a manual restore) already cleaned up.
$before = Get-OverlayStatus
if (Test-OverlayRestored -Text $before.text -Code $before.code) {
  Write-Output '[overlay-restore] already restored (applied=false); nothing to do'
  exit 0
}

# 2. Restore with a hard deadline. Launch through ComSpec so a node shim/PATH wrapper resolves
#    the same way build-harmony.ps1's other native calls do; redirect the pipes so a child
#    that writes a lot of output cannot fill the buffer and fake a hang.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:ComSpec
$psi.Arguments = ('/c node "{0}" restore' -f $overlay)
$psi.WorkingDirectory = $projectRoot
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true

$proc = [System.Diagnostics.Process]::Start($psi)
$timedOut = $false
$restoreCode = 0
$restoreOut = ''
$restoreErr = ''
try {
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  $exited = $proc.WaitForExit($timeoutMs)
  if (-not $exited) {
    $timedOut = $true
    $restoreCode = 124
    # Kill descendants too: a node process that spawned hvigor children must not survive us.
    & taskkill /T /F /PID $proc.Id 2>&1 | Out-Null
    $proc.WaitForExit(5000) | Out-Null
  } else {
    $restoreCode = $proc.ExitCode
  }
  if ($outTask.Wait(5000)) { $restoreOut = $outTask.Result }
  if ($errTask.Wait(5000)) { $restoreErr = $errTask.Result }
} finally {
  if (-not $proc.HasExited) { try { $proc.Kill() } catch { } }
  $proc.Dispose()
}

foreach ($line in @(($restoreOut + "`n" + $restoreErr) -split "`r?`n")) {
  if ($line.Trim() -ne '') { Write-Output "  $line" }
}

if ($timedOut) {
  Write-Output ("[overlay-restore] TIMEOUT after {0}s; overlay still applied — run 'node tools/overlay.mjs restore' manually" -f $TimeoutSec)
  exit 2
}
if ($restoreCode -ne 0) {
  Write-Output ("[overlay-restore] FAILED (node tools/overlay.mjs restore exit {0}); overlay still applied — run 'node tools/overlay.mjs restore' manually" -f $restoreCode)
  exit 3
}

# 3. Assert: a zero exit code from restore is not enough; status must prove applied=false.
$after = Get-OverlayStatus
if (-not (Test-OverlayRestored -Text $after.text -Code $after.code)) {
  Write-Output "[overlay-restore] FAILED (assert: overlay.mjs status did not report applied=false); overlay still applied — run 'node tools/overlay.mjs restore' manually"
  exit 3
}
Write-Output '[overlay-restore] OK: overlay.mjs status reports applied=false'
exit 0
