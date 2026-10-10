<#
OAR install script for Windows (PowerShell 5.1+ or 7+). macOS/Linux use scripts/install.sh.

Usage:
  scripts\install.ps1 [-SkipBuild] [-SkipAutostart] [-ImportAuth] [-Force] [-From <auth.json>] [-Uninstall]

Steps:
  1. bun install + bun run build (skipped with -SkipBuild; npm packages ship dist/)
  2. write %USERPROFILE%\.local\bin\oar.cmd and add that folder to the user PATH
  3. copy the OMO/Senpi extensions into %USERPROFILE%\.omo\agent\extensions (symlinks need admin on Windows)
  4. register the "OAR Daemon" logon task and start the daemon (skipped with -SkipAutostart)
  5. optionally run oar import-auth --all (never overwrites vault profiles unless -Force)
  6. print live remaining usage (oar usage); oar usage --watch keeps it live

Idempotent: safe to re-run. -Uninstall reverses steps 2-4 and keeps %USERPROFILE%\.oar.
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$SkipAutostart,
  [switch]$ImportAuth,
  [switch]$Force,
  [string]$From = (Join-Path $HOME '.omo\agent\auth.json'),
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$LocalBin = Join-Path $HOME '.local\bin'
$OarCmd = Join-Path $LocalBin 'oar.cmd'
$ExtDir = Join-Path $HOME '.omo\agent\extensions'
$TaskName = 'OAR Daemon'
$ExtFiles = 'oar.js', 'cursor-omo.js', 'oar-usage-status.js'

function Invoke-Checked([string]$what, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

if ($Uninstall) {
  Write-Host '==> remove logon task'
  try {
    if (Test-Path $OarCmd) { & $OarCmd daemon stop }
    schtasks.exe /Delete /TN $TaskName /F | Out-Null
  } catch { Write-Host "    nothing to stop or unregister: $_" }
  Write-Host '==> remove launcher and extension copies'
  Remove-Item -Force -ErrorAction SilentlyContinue $OarCmd
  foreach ($name in $ExtFiles) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $ExtDir $name) }
  Write-Host "==> keeping $(Join-Path $HOME '.oar') (vault/state)"
  Write-Host '==> done'
  return
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw 'node not found on PATH. Install Node 22+: https://nodejs.org' }
Write-Host "==> OAR root: $Root"
Write-Host "==> node: $Node"

if (-not $SkipBuild) {
  $Bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if (-not $Bun) { throw 'bun not found on PATH (needed to build). Install bun: https://bun.sh, or pass -SkipBuild for a packaged dist/.' }
  Push-Location $Root
  try {
    Write-Host '==> bun install'
    Invoke-Checked 'bun install' { & $Bun install }
    Write-Host '==> bun run build'
    Invoke-Checked 'bun run build' { & $Bun run build }
  } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $Root 'dist\cli.js'))) { throw "dist\cli.js missing under $Root. Run without -SkipBuild." }

Write-Host "==> write $OarCmd"
New-Item -ItemType Directory -Force $LocalBin | Out-Null
Set-Content -Path $OarCmd -Encoding ASCII -Value "@echo off`r`n`"$Node`" `"$Root\bin\oar.js`" %*"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $LocalBin) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$LocalBin".TrimStart(';'), 'User')
  Write-Host "    added $LocalBin to the user PATH (open a new terminal to pick it up)"
}

Write-Host '==> copy Senpi/OMO extensions'
if (Test-Path (Join-Path $HOME '.omo\agent')) {
  New-Item -ItemType Directory -Force $ExtDir | Out-Null
  Copy-Item -Force (Join-Path $Root 'dist\oar-extension.js') (Join-Path $ExtDir 'oar.js')
  Copy-Item -Force (Join-Path $Root 'extensions\cursor-omo.js') (Join-Path $ExtDir 'cursor-omo.js')
  Copy-Item -Force (Join-Path $Root 'extensions\oar-usage-status.js') (Join-Path $ExtDir 'oar-usage-status.js')
  Write-Host "    copied to $ExtDir (re-run this script after updating OAR)"
} else {
  Write-Host '    skipped: ~\.omo\agent not found (OMO not installed for this user yet)'
}

if (-not $SkipAutostart) {
  Write-Host "==> register logon task '$TaskName'"
  $daemon = Join-Path $Root 'dist\daemon-main.js'
  schtasks.exe /Create /TN $TaskName /SC ONLOGON /RL LIMITED /F /TR "`"$Node`" `"$daemon`"" | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning 'could not register the logon task; the daemon will start on demand' }
} else {
  Write-Host '==> skipped logon task (-SkipAutostart)'
}

Write-Host '==> start daemon'
& $OarCmd daemon start

if ($ImportAuth) {
  Write-Host "==> import-auth --all --from $From"
  if (Test-Path $From) {
    $importArgs = @('import-auth', '--all', '--from', $From, '--profile', 'main')
    if ($Force) { $importArgs += '--force' }
    & $OarCmd @importArgs
  } else {
    Write-Host "    skipped: $From does not exist"
  }
} else {
  Write-Host '==> skipped import-auth (pass -ImportAuth; never overwrites vault profiles unless -Force)'
}

Write-Host '==> bootstrap multi-profile auto failover'
try { & $OarCmd bootstrap-auto | Out-Null } catch { Write-Host "    skipped: $_" }

Write-Host '==> live remaining usage'
& $OarCmd usage
Write-Host '    keep it live: oar usage --watch   (or: oar panel --watch)'

Write-Host '==> done'
Write-Host 'Run: oar doctor'
