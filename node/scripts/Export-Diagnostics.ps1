param([string]$InstallDir='D:\CodexFleet',[Parameter(Mandatory=$true)][string]$OutputFile)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
& (Join-Path $InstallDir 'runtime\node.exe') (Join-Path $InstallDir 'app\src\cli.mjs') diagnose-json --config (Join-Path $InstallDir 'config\node.json') --out ([IO.Path]::GetFullPath($OutputFile))
if ($LASTEXITCODE -ne 0) { throw 'Diagnostic export failed.' }
Write-Host 'Review device names and task IDs before sharing. No node tokens, prompts, source files, or Codex login data are exported.'
