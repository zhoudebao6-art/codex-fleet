param([string]$InstallDir='D:\CodexFleet',[ValidateSet('Hub','Node')][string]$Role='Node')
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
. (Join-Path $PSScriptRoot 'Windows-Startup.ps1')
if($Role -eq 'Node'){
 $powerConfig=Read-FleetJson (Join-Path $InstallDir 'config\node.json')
 $powerDirectory=Join-Path $powerConfig.dataDir 'power'
 if(Test-Path -LiteralPath $powerDirectory){[IO.File]::WriteAllText((Join-Path $powerDirectory 'stop.request'),'disabled')}
}
& (Join-Path $PSScriptRoot 'Stop-Fleet.ps1') -InstallDir $InstallDir -Role $Role
$name=Get-FleetTaskName $InstallDir $Role.ToLowerInvariant()
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($task -and @($task.Actions | Where-Object { Test-FleetStartupCommand ($_.Execute+' '+$_.Arguments) $InstallDir $Role }).Count) { Disable-ScheduledTask -TaskName $name | Out-Null }
$shortcutDisabled = Disable-FleetStartupShortcut $InstallDir $Role
Write-Host 'Recognized Fleet scheduled-task and managed Startup shortcut entries are disabled. Data, credentials, source files, existing Codex skills and Tailscale routes are preserved.'
Write-Warning 'Any separately configured user Run entry or manually named launcher is retained; check it before assuming all automatic startup is disabled.'
Write-Host 'To remove the MCP connection after checking its installation path: codex mcp remove codex_fleet'
