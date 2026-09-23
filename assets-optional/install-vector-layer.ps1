# install-vector-layer.ps1
# Usage:
#   powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1
#   powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1 -Strict
#   powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1 -CheckOnly
#   powershell -ExecutionPolicy Bypass -File assets-optional\install-vector-layer.ps1 -Json
#
# All real work is delegated to node install-vector-layer.mjs so the bash
# entrypoint stays a one-liner. Keep behaviour identical across platforms.

[CmdletBinding()]
param(
  [switch]$Strict,
  [switch]$NoDownload,
  [switch]$NoInstall,
  [switch]$CheckOnly,
  [switch]$Json,
  [switch]$Force,
  [switch]$WipeExistingModel,
  [switch]$PurgeDb
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$mjs = Join-Path $scriptDir 'install-vector-layer.mjs'

$args = @()
if ($Strict)            { $args += '--strict' }
if ($NoDownload)        { $args += '--no-download' }
if ($NoInstall)         { $args += '--no-install' }
if ($CheckOnly)         { $args += '--check-only' }
if ($Json)              { $args += '--json' }
if ($Force)             { $args += '--force' }
if ($WipeExistingModel) { $args += '--wipe-existing-model' }
if ($PurgeDb)           { $args += '--purge-db' }

Write-Output "==> multi-agent vector-layer installer (PowerShell entry)"
Write-Output "    Default: idempotent. Existing files (model / vec.db / vec0.dll)"
Write-Output "    are PRESERVED; nothing is overwritten."
Write-Output "    Override source: `$env:VECTOR_MODEL_URL=`"https://your-mirror/`""
Write-Output "    Destructive flags (rare):"
Write-Output "      -Force              re-download model (caution)"
Write-Output "      -WipeExistingModel  delete model dir first, then redownload (caution)"
Write-Output "      -PurgeDb            delete vec.db (DESTROYS saved memories)"
Write-Output ""

& node $mjs @args
exit $LASTEXITCODE
