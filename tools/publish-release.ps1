#requires -Version 5.1
<#
.SYNOPSIS
  Create (or update) a GitHub release and upload assets, using the local git credential store.

.DESCRIPTION
  The token is read from `git credential fill` and never printed. Only the release URL and
  each asset's browser_download_url / size / sha256 are written to stdout.
  Release notes can be passed inline (-Notes) or, preferably, from a UTF-8 file (-NotesFile)
  so non-ASCII text survives.

.EXAMPLE
  powershell -File tools/publish-release.ps1 -Tag v1.0.0-debug -Name "HarmonyOS debug build" `
    -NotesFile .tmp/release-notes.md -Assets dist-harmony/arkui-schedule-harmony-debug-signed.hap
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Notes = '',
  [string]$NotesFile = '',
  [string[]]$Assets = @(),
  [string]$Repo = 'grassoflty-dev/dsh-sync-suite',
  [switch]$Draft,
  [switch]$Prerelease
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $projectRoot

function Get-GitToken {
  $payload = "protocol=https`nhost=github.com`n`n"
  $lines = ($payload | git credential fill) -split "`n"
  foreach ($line in $lines) {
    if ($line -match '^password=(.+)$') { return $Matches[1].Trim() }
  }
  throw 'no github token in git credential store (run: git credential fill)'
}

$token = Get-GitToken

if ($NotesFile -ne '') {
  $notesPath = if ([IO.Path]::IsPathRooted($NotesFile)) { $NotesFile } else { Join-Path $projectRoot $NotesFile }
  if (-not (Test-Path $notesPath)) { throw "notes file not found: $notesPath" }
  $Notes = [IO.File]::ReadAllText($notesPath, (New-Object System.Text.UTF8Encoding($false)))
}

$headers = @{
  Authorization          = "token $token"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = 'dsh-sync-suite-release'
  'X-GitHub-Api-Version' = '2022-11-28'
}
$api = "https://api.github.com/repos/$Repo"

# Reuse an existing release for the tag (idempotent re-runs).
$existing = $null
try {
  $existing = Invoke-RestMethod -Uri "$api/releases/tags/$Tag" -Headers $headers -Method Get
} catch {
  $existing = $null
}

$body = @{
  tag_name   = $Tag
  name       = $Name
  body       = $Notes
  draft      = [bool]$Draft
  prerelease = [bool]$Prerelease
} | ConvertTo-Json -Depth 4

if ($existing -ne $null) {
  Write-Host "release exists (id=$($existing.id)) - updating"
  $release = Invoke-RestMethod -Uri "$api/releases/$($existing.id)" -Headers $headers -Method Patch -Body $body -ContentType 'application/json'
} else {
  Write-Host "creating release $Tag"
  $release = Invoke-RestMethod -Uri "$api/releases" -Headers $headers -Method Post -Body $body -ContentType 'application/json'
}

Write-Host "release: $($release.html_url)"

$uploadBase = ([string]$release.upload_url).Split('{')[0]

foreach ($asset in $Assets) {
  $path = if ([IO.Path]::IsPathRooted($asset)) { $asset } else { Join-Path $projectRoot $asset }
  if (-not (Test-Path $path)) { throw "asset not found: $path" }
  $file = Get-Item $path
  $sha = (Get-FileHash $file.FullName -Algorithm SHA256).Hash

  # Replace an asset with the same name (upload endpoint rejects duplicates).
  if ($release.assets) {
    foreach ($old in $release.assets) {
      if ($old.name -eq $file.Name) {
        Write-Host "deleting existing asset $($old.name)"
        Invoke-RestMethod -Uri "$api/releases/assets/$($old.id)" -Headers $headers -Method Delete | Out-Null
      }
    }
  }

  $uploadUrl = "$uploadBase?name=$([uri]::EscapeDataString($file.Name))"
  Write-Host "uploading $($file.Name) ($($file.Length) B)"
  $uploaded = Invoke-RestMethod -Uri $uploadUrl -Headers $headers -Method Post -ContentType 'application/octet-stream' -InFile $file.FullName
  Write-Host "asset: $($uploaded.browser_download_url)  size=$($uploaded.size)  sha256=$sha"
}
