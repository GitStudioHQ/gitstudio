# GitStudio Desktop — one-line installer for Windows.
#
#   irm https://gitstudio.dev/install.ps1 | iex
#   irm https://raw.githubusercontent.com/GitStudioHQ/gitstudio/main/scripts/install.ps1 | iex
#
#   $env:GITSTUDIO_VERSION = "2.0.0"   pin a version instead of taking the latest
#   -Silent                            install without the NSIS wizard
#
# Resolves the newest `app-v*` release, downloads the NSIS installer, verifies
# it against SHA256SUMS.txt when the release has one, and runs it. Per-user by
# default, so it needs no elevation.
[CmdletBinding()]
param([switch]$Silent)

$ErrorActionPreference = 'Stop'
$repo = 'GitStudioHQ/gitstudio'

function Say  { param($m) Write-Host "▸ $m" -ForegroundColor Magenta }
function Warn { param($m) Write-Host "! $m" -ForegroundColor Yellow }
# `throw`, not `exit`: under `irm | iex` this script runs inside the caller's
# session, and `exit` would close their window with the message in it.
function Die  { param($m) Write-Host "✗ $m" -ForegroundColor Red; throw $m }

# TLS 1.2 for Windows PowerShell 5.1, which still defaults lower and then fails
# against GitHub with an error that reads like a network outage.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# ── Which release? ───────────────────────────────────────────────────────────
# Filter to app-v* rather than trusting /releases/latest: the extension tags in
# this repo too.
if ($env:GITSTUDIO_VERSION) {
  $tag = 'app-v' + ($env:GITSTUDIO_VERSION -replace '^v', '')
} else {
  Say 'Finding the latest release…'
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=30" `
                                -Headers @{ 'User-Agent' = 'gitstudio-installer' }
  $tag = ($releases | Where-Object { $_.tag_name -like 'app-v*' } | Select-Object -First 1).tag_name
  if (-not $tag) { Die 'could not find an app-v* release — is GitHub reachable?' }
}
$version = $tag -replace '^app-v', ''
Say "GitStudio $version for Windows"

$asset = "GitStudio-Setup-$version.exe"
$url   = "https://github.com/$repo/releases/download/$tag/$asset"
$tmp   = Join-Path ([IO.Path]::GetTempPath()) ("gitstudio-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$exe = Join-Path $tmp $asset

try {
  Say "Downloading $asset…"
  # ProgressPreference off: the built-in progress bar makes Invoke-WebRequest
  # an order of magnitude slower on large files in Windows PowerShell.
  $prev = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
  $ProgressPreference = $prev
  if (-not (Test-Path $exe) -or (Get-Item $exe).Length -eq 0) { Die 'downloaded file is empty' }

  # Verify when the release carries checksums; say so plainly when it does not.
  $sumsUrl = "https://github.com/$repo/releases/download/$tag/SHA256SUMS.txt"
  try {
    $sums = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content
    $want = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($asset) + '\s*$' } |
             Select-Object -First 1) -split '\s+' | Select-Object -First 1
    if ($want) {
      $got = (Get-FileHash -Path $exe -Algorithm SHA256).Hash.ToLower()
      if ($got -ne $want.ToLower()) { Die "checksum mismatch for $asset — refusing to install" }
      Say 'Checksum verified.'
    }
  } catch {
    Warn 'No SHA256SUMS.txt on this release; skipping checksum verification.'
  }

  Say 'Running the installer…'
  # /S is NSIS's silent switch; without it the user gets the normal wizard and
  # can choose the install directory, which is why oneClick is off. The switch
  # is added only when asked for: Windows PowerShell 5.1 — what `irm | iex`
  # runs in on a fresh machine — validates -ArgumentList as not-empty, so
  # passing '' died right here, after the download and before the install.
  $start = @{ FilePath = $exe; PassThru = $true; Wait = $true }
  if ($Silent) { $start.ArgumentList = '/S' }
  $p = Start-Process @start
  if ($p.ExitCode -ne 0) { Die "the installer exited with code $($p.ExitCode)" }
  Say 'Installed. Find GitStudio in the Start menu.'
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
