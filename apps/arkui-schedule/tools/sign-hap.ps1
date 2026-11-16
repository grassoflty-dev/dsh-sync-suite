#requires -Version 5.1
<#
.SYNOPSIS
  Offline-sign a HarmonyOS HAP with the SDK hap-sign-tool (no DevEco needed).

.DESCRIPTION
  hvigor's SignHap task only accepts the *encrypted* storePassword/keyPassword
  strings that DevEco Studio writes (it fails with 00303116 "The length of the
  storePassword or keyPassword field ... is less than 32" on plaintext). This
  script bypasses hvigor and drives the SDK's hap-sign-tool.jar directly with
  plaintext passwords, using the signing material committed under signing/.

  It signs an unsigned HAP into a signed HAP, then verifies the result.

  Signing material (apps/arkui-schedule/signing/):
    itwill-debug.p12   key store   (alias debugkey, storepass/keypass <已脱敏>)
    itwill-debug.cer   cert chain  (AGC debug certificate, valid until 2027-11-15)
    itwill-debug.p7b   profile     (AGC debug profile, bound to bundle + device UDID)

.EXAMPLE
  powershell -File tools/sign-hap.ps1
  powershell -File tools/sign-hap.ps1 -Hap entry\build\default\outputs\default\entry-default-unsigned.hap
#>
[CmdletBinding()]
param(
  [string]$Hap,
  [string]$Out,
  [string]$KeyAlias = 'debugkey',
  [string]$StorePass,
  [string]$KeyPass,
  [int]$CompatibleVersion = 26,
  [switch]$SkipVerify,
  [switch]$Deliver
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$deliverDir = Join-Path $projectRoot 'dist-harmony'
$signingDir = Join-Path $projectRoot 'signing'
$deveco = if ($env:DEVECO_CLI_STUDIO_PATH) { $env:DEVECO_CLI_STUDIO_PATH } else { 'D:\A-DevEco\DevEco Studio' }
$java = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' } else { 'D:\jdk17\jdk-17\bin\java.exe' }
$tool = Join-Path $deveco 'sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar'

if (-not (Test-Path $java)) { throw "java not found: $java (set JAVA_HOME or install JDK 17)" }
if (-not (Test-Path $tool)) { throw "hap-sign-tool.jar not found: $tool (set DEVECO_CLI_STUDIO_PATH)" }

if (-not $Hap) { $Hap = Join-Path $projectRoot 'entry\build\default\outputs\default\entry-default-unsigned.hap' }
if (-not (Test-Path $Hap)) { throw "unsigned HAP not found: $Hap (run tools/build-harmony.ps1 first)" }
if (-not $Out) { $Out = [IO.Path]::ChangeExtension($Hap, $null).TrimEnd('.') + '-signed.hap' }

$KeyAlias = if ($PSBoundParameters.ContainsKey('KeyAlias')) { $KeyAlias } else { 'debugkey' }
$StorePass = if ($PSBoundParameters.ContainsKey('StorePass')) { $StorePass } else { '' }
$KeyPass = if ($PSBoundParameters.ContainsKey('KeyPass')) { $KeyPass } else { $StorePass }

# Prefer v2 key material (rotated after the v1 private key leaked); password comes from signing/pass.txt, never hard-coded.
$v2Keystore = Join-Path $signingDir 'itwill-debug-v2.p12'
$v2Cert = Join-Path $signingDir 'itwill-debug-v2.cer'
$v2Profile = Join-Path $signingDir 'itwill-debug-v2.p7b'
$passFile = Join-Path $signingDir 'pass.txt'

if ((Test-Path $v2Keystore) -and (Test-Path $v2Cert) -and (Test-Path $v2Profile)) {
  $keystore = $v2Keystore
  $cert = $v2Cert
  $profile = $v2Profile
} else {
  # Fallback: v2 material incomplete (AGC has not issued a cert/profile for the v2 CSR yet) -> use v1 and warn.
  $keystore = Join-Path $signingDir 'itwill-debug.p12'
  $cert = Join-Path $signingDir 'itwill-debug.cer'
  $profile = Join-Path $signingDir 'itwill-debug.p7b'
  Write-Warning "v2 signing material incomplete (need .p12/.cer/.p7b) - falling back to v1 (LEAKED KEY)"
}

if ($StorePass -eq '' -and (Test-Path $passFile)) {
  $StorePass = (Get-Content -Raw $passFile).Trim()
  $KeyPass = $StorePass
}
if ($StorePass -eq '') {
  throw "no password: pass -StorePass, or put it in signing/pass.txt (git-ignored)"
}

foreach ($f in @($keystore, $cert, $profile)) {
  if (-not (Test-Path $f)) { throw "signing material missing: $f" }
}

Write-Host "java    : $java"
Write-Host "tool    : $tool"
Write-Host "in      : $Hap"
Write-Host "out     : $Out"
Write-Host "keystore: $keystore (alias $KeyAlias)"
Write-Host "cert    : $cert"
Write-Host "profile : $profile"
Write-Host ""

# hap-sign-tool writes progress to stdout/stderr; capture so a non-zero exit is visible.
$signArgs = @(
  '-jar', $tool, 'sign-app',
  '-mode', 'localSign',
  '-keyAlias', $KeyAlias,
  '-keyPwd', $KeyPass,
  '-appCertFile', $cert,
  '-profileFile', $profile,
  '-inFile', $Hap,
  '-signAlg', 'SHA256withECDSA',
  '-keystoreFile', $keystore,
  '-keystorePwd', $StorePass,
  '-outFile', $Out,
  '-compatibleVersion', "$CompatibleVersion",
  '-signCode', '1'
)

# PS 5.1 turns any stderr line of a native command into a terminating error when
# $ErrorActionPreference is Stop (hap-sign-tool logs to stderr), so relax it here and
# judge success by the produced file plus the exit code.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $java @signArgs 2>&1 | ForEach-Object { Write-Host $_ }
$signExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if (-not (Test-Path $Out)) { throw "sign-app did not produce $Out (exit $signExit)" }
$signed = Get-Item $Out
Write-Host ""
Write-Host ("signed HAP: {0} ({1} bytes)" -f $signed.FullName, $signed.Length)

if ($SkipVerify) { return }

$chain = Join-Path $env:TEMP 'itwill-signed-certchain.cer'
$prof = Join-Path $env:TEMP 'itwill-signed-profile.p7b'
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$verifyOut = & $java -jar $tool verify-app -inFile $Out -outCertChain $chain -outProfile $prof 2>&1
$verifyExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
$verifyOut | ForEach-Object { Write-Host $_ }
if ($verifyExit -ne 0) { throw "verify-app failed (exit $verifyExit)" }
Write-Host ""
Write-Host "Install with:"
Write-Host ("  hdc -t <serial> install -r `"{0}`"" -f $signed.FullName)

if ($Deliver) {
  # Delivery rule: always copy the signed HAP into dist-harmony and print its SHA256 (never install-only).
  if (-not (Test-Path $deliverDir)) { New-Item -ItemType Directory -Force -Path $deliverDir | Out-Null }
  $target = Join-Path $deliverDir 'arkui-schedule-harmony-debug-signed.hap'
  Copy-Item $signed.FullName $target -Force
  $hash = (Get-FileHash $target -Algorithm SHA256).Hash
  $size = (Get-Item $target).Length
  Write-Host ""
  Write-Host "Delivered:"
  Write-Host ("  {0}  {1} B  SHA256={2}" -f $target, $size, $hash)
}
