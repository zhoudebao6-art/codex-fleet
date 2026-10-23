param([string]$InstallDir='D:\CodexFleet')
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
& (Join-Path $InstallDir 'runtime\node.exe') (Join-Path $InstallDir 'app\src\cli.mjs') open-console --config (Join-Path $InstallDir 'config\node.json')
if ($LASTEXITCODE -ne 0) { throw 'The console could not be opened. Check node enrollment and connectivity.' }
