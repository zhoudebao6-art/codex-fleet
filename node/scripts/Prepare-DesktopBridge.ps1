param([string]$InstallDir='D:\CodexFleet')
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
. (Join-Path $PSScriptRoot 'Windows-Desktop.ps1')
Set-FleetCache
$cfg=Read-FleetJson (Join-Path $InstallDir 'config\node.json')
$root=Join-Path $InstallDir 'desktop-bridge'
New-Item -ItemType Directory -Path $root -Force | Out-Null
Protect-FleetDirectory $root
$statusFile=Join-Path $root 'launch-status.json';$stage='prepare_trust'
try {
$exe=Initialize-FleetDesktopBinary $root 'bridge'
$null=Initialize-FleetDesktopAppLauncher $root
$real=Find-FleetCodex $cfg.codexPath
Write-FleetJson (Join-Path $root 'launcher.json') @{nodePath=(Join-Path $InstallDir 'runtime\node.exe');adapterPath=(Join-Path $InstallDir 'app\src\desktop-session-bridge.mjs');realCodexPath=$real;endpointFile=(Join-Path $root 'runtime.json')}
$stage='prepare_passthrough'
$version=& $exe --version
if($LASTEXITCODE -ne 0 -or !$version){throw 'Desktop bridge passthrough check failed. Codex was not changed.'}
$shell=New-Object -ComObject WScript.Shell
$link=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Fleet 联动.lnk'))
$link.TargetPath=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$link.Arguments='-NoProfile -ExecutionPolicy Bypass -File '+(Quote-FleetArgument (Join-Path $InstallDir 'app\scripts\Start-FleetDesktop.ps1'))+' -InstallDir '+(Quote-FleetArgument $InstallDir)
$link.WorkingDirectory=$InstallDir;$link.Description='Codex desktop and Fleet share one session executor';$link.Save()
Write-FleetJson (Join-Path $root 'preparation-status.json') @{state='completed';stage='prepared';at=(Get-Date).ToUniversalTime().ToString('o')}
Write-FleetJson $statusFile @{state='prepared';stage='awaiting_desktop_open';at=(Get-Date).ToUniversalTime().ToString('o');desktopVisible='not_verified'}
Write-Host 'Prepared. Finish current Codex work, exit Codex normally, then open the desktop shortcut: Codex Fleet 联动. Existing login, skills and original shortcuts were retained.'
}catch{
 $code=Get-FleetDesktopTrustFailure $_
 $failure=@{state='failed';stage=$stage;error=$_.Exception.Message;errorCode=$code;at=(Get-Date).ToUniversalTime().ToString('o');desktopVisible='not_verified'}
 Write-FleetJson (Join-Path $root 'preparation-status.json') $failure
 Write-FleetJson $statusFile $failure
 throw
}
