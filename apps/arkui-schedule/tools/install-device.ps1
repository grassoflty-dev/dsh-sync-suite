#requires -Version 5.1
<#
.SYNOPSIS
  Sign, build and install the HarmonyOS app on a USB-connected device.

.DESCRIPTION
  Steps:
    1. locate hdc (DevEco SDK toolchains) and the device
    2. print device model + API version (to catch API mismatch early)
    3. devecocli signature generate  (creates cert/profile bound to this device and
       writes signingConfigs into build-profile.json5)
    4. devecocli build --product <Product>
    5. hdc install -r <signed hap>
    6. hdc shell aa start -a EntryAbility -b com.itwill.schedule

  Prerequisites on the device: developer mode on, USB debugging on, and the
  "Allow USB debugging" prompt accepted. The device must be signed in with the
  same Huawei account as `devecocli auth login` for automatic signing.

.EXAMPLE
  powershell -File tools/install-device.ps1
  powershell -File tools/install-device.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
  [string]$Product = 'default',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$deveco = if ($env:DEVECO_CLI_STUDIO_PATH) { $env:DEVECO_CLI_STUDIO_PATH } else { 'D:\A-DevEco\DevEco Studio' }
$hdc = Join-Path $deveco 'sdk\default\openharmony\toolchains\hdc.exe'
$cli = 'C:\Users\GWL\Desktop\itwillclaude\.tmp\deveco-cli\node_modules\.bin\devecocli.cmd'
$bundleName = 'com.itwill.schedule'
$ability = 'EntryAbility'

if (-not (Test-Path $hdc)) { throw "hdc not found: $hdc" }
if (-not (Test-Path $cli)) { throw "devecocli not found: $cli" }

$env:DEVECO_CLI_STUDIO_PATH = $deveco
$env:DEVECO_SDK_HOME = Join-Path $deveco 'sdk'

Write-Host "== 1/6 device check =="
$targets = & $hdc list targets 2>&1 | Where-Object { $_ -and $_ -notmatch '\[Empty\]' -and $_ -notmatch '^$' }
if (-not $targets) {
  Write-Host "No device found." -ForegroundColor Yellow
  Write-Host "On the tablet: Settings > About -> tap version number to enable Developer options;"
  Write-Host "then Settings > System > Developer options -> USB debugging ON, and accept the RSA prompt."
  exit 2
}
$serial = ($targets | Select-Object -First 1).Trim()
Write-Host "device: $serial"

Write-Host "== 2/6 device info =="
& $hdc -t $serial shell param get const.product.model 2>&1 | Select-Object -First 1
& $hdc -t $serial shell param get const.ohos.apiversion 2>&1 | Select-Object -First 1
& $hdc -t $serial shell param get const.ohos.fullname 2>&1 | Select-Object -First 1

if (-not $SkipBuild) {
  Write-Host "== 3/6 generate signing materials =="
  Push-Location $projectRoot
  try {
    & $cli signature generate --product $Product --force 2>&1 | Select-Object -Last 20
    if ($LASTEXITCODE -ne 0) { throw "signature generate failed (exit $LASTEXITCODE)" }

    Write-Host "== 4/6 build =="
    & $cli build --product $Product 2>&1 | Select-Object -Last 25
    if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "== 3-4/6 skipped (SkipBuild) =="
}

Write-Host "== 5/6 install =="
$outputs = Join-Path $projectRoot 'entry\build\default\outputs\default'
$hap = Get-ChildItem $outputs -Recurse -Filter '*-signed.hap' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $hap) { $hap = Get-ChildItem $outputs -Recurse -Filter '*.hap' -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $hap) { throw "No HAP under $outputs; build first." }
Write-Host "hap: $($hap.FullName)"
& $hdc -t $serial install -r $hap.FullName 2>&1 | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { throw "hdc install failed (exit $LASTEXITCODE)" }

Write-Host "== 6/6 launch =="
& $hdc -t $serial shell aa start -a $ability -b $bundleName 2>&1 | Select-Object -Last 5
Write-Host ""
Write-Host "Done. If the app keeps closing, watch logs with:"
Write-Host "  `"$hdc`" -t $serial hilog | Select-String $bundleName"
