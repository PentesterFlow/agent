<#
.SYNOPSIS
  pentesterflow online installer (Windows).

.DESCRIPTION
  Downloads the standalone Windows binary from the latest GitHub release,
  verifies its SHA-256, installs it under %LOCALAPPDATA%\Programs\pentesterflow,
  and adds that directory to your user PATH.

  Run:
    irm https://raw.githubusercontent.com/PentesterFlow/agent/main/install.ps1 | iex

.NOTES
  Environment overrides:
    $env:PENTESTERFLOW_VERSION     = 'v0.1.0'   # pin a release (default: latest)
    $env:PENTESTERFLOW_INSTALL_DIR = 'C:\path'  # install location
    $env:PENTESTERFLOW_REPO        = 'owner/repo'
#>

#Requires -Version 5
$ErrorActionPreference = 'Stop'

$Repo = if ($env:PENTESTERFLOW_REPO) { $env:PENTESTERFLOW_REPO } else { 'PentesterFlow/agent' }
$Bin  = 'pentesterflow'

# --- detect arch (only windows-x64 is published) -------------------------
if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'unsupported architecture: only 64-bit Windows (x64) is published.'
}
$asset = "$Bin-windows-x64.exe"

$ver = if ($env:PENTESTERFLOW_VERSION) { $env:PENTESTERFLOW_VERSION.Trim() } else { 'latest' }
if ($ver -ne 'latest' -and -not $ver.StartsWith('v')) {
  $ver = "v$ver"
}

$base = if ($ver -eq 'latest') {
  "https://github.com/$Repo/releases/latest/download"
} else {
  "https://github.com/$Repo/releases/download/$ver"
}

$dir = if ($env:PENTESTERFLOW_INSTALL_DIR) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:PENTESTERFLOW_INSTALL_DIR)
} else {
  if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is not set; set PENTESTERFLOW_INSTALL_DIR explicitly.'
  }
  Join-Path $env:LOCALAPPDATA 'Programs\pentesterflow'
}
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  if ([Net.ServicePointManager]::SecurityProtocol -notmatch 'Tls12') {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }
  $download = Join-Path $tmp $asset

  Write-Host "downloading $asset ($ver)..."
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $download -UseBasicParsing -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $download) -or (Get-Item -LiteralPath $download).Length -eq 0) {
    throw "downloaded asset is empty: $base/$asset"
  }

  # --- verify checksum ----------------------------------------------------
  $checksumVerified = $false
  try {
    $sums = (Invoke-WebRequest -Uri "$base/SHA256SUMS" -UseBasicParsing -ErrorAction Stop).Content
  } catch {
    Write-Warning "SHA256SUMS unavailable; skipping checksum verification: $($_.Exception.Message)"
    $sums = $null
  }

  if ($sums) {
    $line = $sums -split "`n" |
      Where-Object { $_ -match "\s$([regex]::Escape($asset))\s*$" } |
      Select-Object -First 1
    if ($line) {
      $want = ($line -replace '\s.*$', '').Trim().ToLower()
      $got  = (Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToLower()
      if ($got -ne $want) {
        throw "checksum mismatch for $asset (expected $want, got $got)"
      }
      $checksumVerified = $true
      Write-Host 'checksum ok'
    } else {
      Write-Warning "SHA256SUMS does not contain $asset; skipping checksum verification"
    }
  }

  $dest = Join-Path $dir "$Bin.exe"
  $staged = Join-Path $dir ".$Bin.tmp.$PID.exe"
  Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $staged
  Copy-Item -Force -Path $download -Destination $staged
  Move-Item -Force -LiteralPath $staged -Destination $dest
  Write-Host "installed $Bin -> $dest"

  # --- add to user PATH --------------------------------------------------
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $pathEntries = @()
  if (-not [string]::IsNullOrWhiteSpace($userPath)) {
    $pathEntries = $userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  }

  if (-not ($pathEntries | Where-Object { [string]::Equals($_, $dir, [StringComparison]::OrdinalIgnoreCase) })) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $dir } else { "$userPath;$dir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$env:Path;$dir"
    Write-Host "added $dir to your user PATH (open a new terminal for it to take effect)"
  }

  if (-not $checksumVerified) {
    Write-Warning 'installed without checksum verification'
  }
  & $dest --version
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
}
