#requires -Version 5.1
<#
.SYNOPSIS
  Offline-sign a HarmonyOS HAP with the SDK hap-sign-tool (no DevEco needed).

.DESCRIPTION
  hvigor's SignHap task only accepts the *encrypted* storePassword/keyPassword
  strings that DevEco Studio writes (it fails with 00303116 "The length of the
  storePassword or keyPassword field ... is less than 32" on plaintext). This
  script bypasses hvigor and drives the SDK's hap-sign-tool.jar directly with
  plaintext passwords, using the local signing material (git-ignored).

  It signs an unsigned HAP into a signed HAP, then verifies the result.

  PASSWORD RESOLUTION ORDER (deterministic, documented here and in docs/RUNBOOK.md):
    1. explicit parameters ......... -StorePass / -KeyPass
    2. environment variables ....... SIGN_PASS (store) / SIGN_KEY_PASS (key, optional)
    3. signing/pass.txt ............ read as UTF-8; a leading UTF-8 BOM is stripped
                                     and ONLY trailing CR/LF line endings are removed
                                     (spaces/tabs are password characters and are kept).
  The resolved password is validated against the keystore with `keytool -list`
  BEFORE any signing attempt. A bad password fails with a clear message instead
  of the raw `11014003 keystore password was incorrect` from hap-sign-tool.
  The password is never echoed to stdout/stderr or written to any file.

  KEY MATERIAL: v2 (itwill-debug-v2.p12/.cer/.p7b) is required by default. If it
  is incomplete, the script REFUSES to use the leaked v1 debug key unless the
  caller passes the explicit -AllowLegacyV1Key switch (reproduce-only, loud warning).

  Signing material (apps/arkui-schedule/signing/):
    itwill-debug.p12       v1 key store (LEAKED private key; legacy only)
    itwill-debug-v2.p12    v2 key store (preferred; password from signing/pass.txt)
    itwill-debug.cer/.p7b  v1 cert + profile
    itwill-debug-v2.cer/.p7b  v2 cert + profile (issued by AGC when available)

.EXAMPLE
  powershell -File tools/sign-hap.ps1
  powershell -File tools/sign-hap.ps1 -Hap entry\build\default\outputs\default\entry-default-unsigned.hap
  powershell -File tools/sign-hap.ps1 -StorePass $env:SIGN_PASS
  powershell -File tools/sign-hap.ps1 -AllowLegacyV1Key   # deliberately reproduce the old leaked-key path
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
  [switch]$Deliver,
  [switch]$AllowLegacyV1Key
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$deliverDir = Join-Path $projectRoot 'dist-harmony'
$signingDir = Join-Path $projectRoot 'signing'
$deveco = if ($env:DEVECO_CLI_STUDIO_PATH) { $env:DEVECO_CLI_STUDIO_PATH } else { 'D:\A-DevEco\DevEco Studio' }
$java = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' } else { 'D:\jdk17\jdk-17\bin\java.exe' }
$tool = Join-Path $deveco 'sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar'
$passFile = Join-Path $signingDir 'pass.txt'

if (-not (Test-Path $java)) { throw "java not found: $java (set JAVA_HOME or install JDK 17)" }
if (-not (Test-Path $tool)) { throw "hap-sign-tool.jar not found: $tool (set DEVECO_CLI_STUDIO_PATH)" }

if (-not $Hap) { $Hap = Join-Path $projectRoot 'entry\build\default\outputs\default\entry-default-unsigned.hap' }
if (-not (Test-Path $Hap)) { throw "unsigned HAP not found: $Hap (run tools/build-harmony.ps1 first)" }
if (-not $Out) { $Out = [IO.Path]::ChangeExtension($Hap, $null).TrimEnd('.') + '-signed.hap' }

$KeyAlias = if ($PSBoundParameters.ContainsKey('KeyAlias')) { $KeyAlias } else { 'debugkey' }

# --- Password resolution: ONE documented order, no fall-through guessing. -------
# Pure helper for signing/pass.txt: strip a leading UTF-8 BOM and remove ONLY
# trailing line endings. Do NOT Trim() whitespace: a space/tab may be part of the
# password, and trimming it is what silently produced a wrong password before.
function Read-PassFileText {
  param([Parameter(Mandatory = $true)][string]$Path)
  $bytes = [IO.File]::ReadAllBytes($Path)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  return $text.TrimEnd([char]0x0D, [char]0x0A)
}

if ($PSBoundParameters.ContainsKey('StorePass')) {
  $StorePass = [string]$StorePass
} elseif ($env:SIGN_PASS) {
  $StorePass = [string]$env:SIGN_PASS
} elseif (Test-Path $passFile) {
  $StorePass = Read-PassFileText -Path $passFile
} else {
  $StorePass = ''
}

if ($PSBoundParameters.ContainsKey('KeyPass')) {
  $KeyPass = [string]$KeyPass
} elseif ($env:SIGN_KEY_PASS) {
  $KeyPass = [string]$env:SIGN_KEY_PASS
} else {
  # A keystore usually uses one password for store and key; no guessing beyond this.
  $KeyPass = $StorePass
}

if ([string]::IsNullOrEmpty($StorePass) -or [string]::IsNullOrEmpty($KeyPass)) {
  throw 'no password: pass -StorePass/-KeyPass, set SIGN_PASS/SIGN_KEY_PASS, or put it in signing/pass.txt (git-ignored)'
}

# --- Key material selection: v2 required by default, v1 is opt-in only. ----------
$v2Keystore = Join-Path $signingDir 'itwill-debug-v2.p12'
$v2Cert = Join-Path $signingDir 'itwill-debug-v2.cer'
$v2Profile = Join-Path $signingDir 'itwill-debug-v2.p7b'
$v2Complete = (Test-Path $v2Keystore) -and (Test-Path $v2Cert) -and (Test-Path $v2Profile)

if ($v2Complete) {
  $keystore = $v2Keystore
  $cert = $v2Cert
  $profile = $v2Profile
} elseif ($AllowLegacyV1Key) {
  $keystore = Join-Path $signingDir 'itwill-debug.p12'
  $cert = Join-Path $signingDir 'itwill-debug.cer'
  $profile = Join-Path $signingDir 'itwill-debug.p7b'
  Write-Warning '[sign-hap] WARNING -AllowLegacyV1Key: using LEAKED v1 signing key (compromised private key) - reproduce-only, never ship or publish with this key'
} else {
  throw '[sign-hap] REFUSING LEAKED V1 KEY: v2 signing material incomplete (need itwill-debug-v2.p12 / .cer / .p7b). Pass -AllowLegacyV1Key to deliberately use the LEAKED v1 key.'
}

foreach ($f in @($keystore, $cert, $profile)) {
  if (-not (Test-Path $f)) { throw "signing material missing: $f" }
}

# --- Early keystore validation: fail with a clear message BEFORE sign-app. -------
# keytool ships with the JDK, so derive its path from the resolved java.exe.
$keytool = Join-Path (Split-Path -Parent $java) 'keytool.exe'
if (-not (Test-Path $keytool)) { throw "keytool not found: $keytool (set JAVA_HOME to a full JDK 17)" }

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$null = & $keytool -list -keystore $keystore -storetype pkcs12 -storepass $StorePass 2>&1
$keytoolExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($keytoolExit -ne 0) {
  throw '[sign-hap] 密码无法打开 keystore：检查 -StorePass / signing/pass.txt（不要打印密码）'
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
