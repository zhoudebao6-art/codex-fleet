param([Parameter(Mandatory=$true)][string]$PackageZip,[Parameter(Mandatory=$true)][string]$CodexPath,[Parameter(Mandatory=$true)][string]$ReportFile)
$ErrorActionPreference='Stop'
$TestStartup=$true
$env:TEMP='D:\codex+\temp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP
$root=Join-Path $env:TEMP ('fleet windows smoke '+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($PackageZip,(Join-Path $root 'extracted'))
$package=(Get-ChildItem -LiteralPath (Join-Path $root 'extracted') -Directory | Select-Object -First 1).FullName
. (Join-Path $package 'scripts\Windows-Common.ps1')
$hub=Join-Path $root 'installed hub';$node=Join-Path $root 'installed node'
$env:CODEX_HOME=Join-Path $root 'existing codex home';New-Item -ItemType Directory -Path (Join-Path $env:CODEX_HOME 'skills\existing-local') -Force | Out-Null
$originalSkill=Join-Path $env:CODEX_HOME 'skills\existing-local\SKILL.md';[IO.File]::WriteAllText($originalSkill,"---`nname: existing-local`ndescription: Preserve this local skill during installer verification.`n---`nExisting content.`n")
$originalConfig=Join-Path $env:CODEX_HOME 'config.toml';[IO.File]::WriteAllText($originalConfig,"model_reasoning_effort = `"low`"`n")
$skillHash=(Get-FileHash -LiteralPath $originalSkill).Hash
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
$result=@{extractedPackage=$true;pathWithSpaces=$true;at=(Get-Date).ToUniversalTime().ToString('o');realWan=$false;physicalMachines=1}
try{
 & (Join-Path $package 'Install.ps1') -Role Hub -InstallDir $hub -HubPort $port -NoStartup:(!$TestStartup)
 $health=Invoke-RestMethod -Uri "http://127.0.0.1:$port/health";if(!$health.ok){throw 'Installed hub not healthy.'};$result.hubHealth=$true
 $invite=Join-Path $root 'private invitation\smoke.invite.json'
 & (Join-Path $hub 'app\scripts\New-NodeInvitation.ps1') -InstallDir $hub -Name installer-node -HubUrl "http://127.0.0.1:$port" -OutFile $invite
 & (Join-Path $package 'Install.ps1') -Role Node -InstallDir $node -Invitation $invite -CodexPath $CodexPath -NoStartup:(!$TestStartup)
 if((Get-FileHash -LiteralPath $originalSkill).Hash -ne $skillHash){throw 'Existing skill changed.'}
 if((Get-Content -LiteralPath $originalConfig -Raw) -notmatch 'model_reasoning_effort = "low"'){throw 'Existing config changed.'}
 if(!(Test-Path -LiteralPath (Join-Path $env:CODEX_HOME 'skills\codex-fleet\installation.json'))){throw 'Fleet skill was not installed.'}
 $result.originalSkillsAndConfigPreserved=$true;$result.newSkillInstalled=$true
 $mcpText=& $CodexPath mcp get codex_fleet --json;$mcp=($mcpText -join "`n")|ConvertFrom-Json
 if($mcp.transport.command -ne (Join-Path $node 'runtime\node.exe')){throw 'MCP command path mismatch.'};$result.mcpConfigured=$true
 Start-Sleep -Seconds 5
 $nodesText=& (Join-Path $hub 'runtime\node.exe') (Join-Path $hub 'app\src\cli.mjs') nodes --config (Join-Path $hub 'config\admin.json');$nodes=($nodesText -join "`n")|ConvertFrom-Json
 if(@($nodes).Count -ne 1 -or !$nodes[0].lastSeen){throw 'Installed node heartbeat not received.'};$result.nodeEnrolledAndHeartbeat=$true
 & (Join-Path $node 'app\scripts\Stop-Fleet.ps1') -InstallDir $node -Role Node
 & (Join-Path $package 'Install.ps1') -Role Node -InstallDir $node -Invitation $invite -CodexPath $CodexPath -NoStartup -NoStart
 $result.repeatInstallRetainedIdentity=$true
 & (Join-Path $hub 'app\scripts\Stop-Fleet.ps1') -InstallDir $hub -Role Hub
 & (Join-Path $hub 'app\scripts\Backup-Fleet.ps1') -InstallDir $hub -BackupRoot (Join-Path $root 'private backups')
 $result.stoppedBackupVerified=$true
 $hubTask=Get-ScheduledTask -TaskName (Get-FleetTaskName $hub 'hub');$nodeTask=Get-ScheduledTask -TaskName (Get-FleetTaskName $node 'node')
 if($hubTask.Principal.UserId -notin @('SYSTEM','S-1-5-18')){throw 'Expected elevated hub startup under SYSTEM.'}
 if($nodeTask.Principal.UserId -in @('SYSTEM','S-1-5-18')){throw 'Node must retain the original Windows user.'}
 Start-ScheduledTask -TaskName $hubTask.TaskName
 $healthy=$false
 for($retry=0;$retry -lt 40;$retry++){try{if((Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2).ok){$record=Read-FleetJson (Join-Path $hub 'data\hub\service.json');$nativeHub=Get-FleetProcess $record;if($nativeHub){$healthy=$true;break}}}catch{};Start-Sleep -Seconds 1}
 if(!$healthy){throw 'Scheduled hub did not become healthy within the startup window.'}
 if((Invoke-CimMethod -InputObject $nativeHub -MethodName GetOwner).User -ne 'SYSTEM'){throw 'Scheduled hub did not execute under SYSTEM.'}
 $result.startupRolesVerified=$true;$result.hubScheduledActionRan=$true
 if(!(Invoke-RestMethod -Uri "http://127.0.0.1:$port/health").ok){throw 'Installed hub restart failed.'};$result.hubRestart=$true
}finally{
 foreach($pair in @(@($node,'Node'),@($hub,'Hub'))){$script=Join-Path $pair[0] 'app\scripts\Stop-Fleet.ps1';if(Test-Path -LiteralPath $script){& $script -InstallDir $pair[0] -Role $pair[1]}}
 foreach($pair in @(@($node,'node'),@($hub,'hub'))){$taskName=Get-FleetTaskName $pair[0] $pair[1];if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}}
}
foreach($pair in @(@($node,'node'),@($hub,'hub'))){$record=Join-Path $pair[0] "data\$($pair[1])\service.json";if((Test-Path -LiteralPath $record) -and (Get-FleetProcess (Read-FleetJson $record))){throw 'Temporary Fleet process is still running.'}}
$result.temporaryServicesStopped=$true;$result.noPermanentStartupInstalled=$true
Write-FleetJson $ReportFile $result
Write-Host "Windows package smoke passed: $ReportFile"
