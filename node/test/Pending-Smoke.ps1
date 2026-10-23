param([Parameter(Mandatory=$true)][string]$PackageZip,[Parameter(Mandatory=$true)][string]$CodexPath,[Parameter(Mandatory=$true)][string]$ReportFile)
$ErrorActionPreference='Stop'
$env:TEMP='D:\codex+\temp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP
$root=Join-Path $env:TEMP ('fleet pending smoke '+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($PackageZip,(Join-Path $root 'extracted'))
$package=(Get-ChildItem -LiteralPath (Join-Path $root 'extracted') -Directory | Select-Object -First 1).FullName
. (Join-Path $package 'scripts\Windows-Common.ps1')
$hub=Join-Path $root 'hub';$node=Join-Path $root 'node'
$env:CODEX_HOME=Join-Path $root 'isolated codex home'
$originalSkill=Join-Path $env:CODEX_HOME 'skills\existing\SKILL.md'
New-Item -ItemType Directory -Path (Split-Path -Parent $originalSkill) -Force | Out-Null
[IO.File]::WriteAllText($originalSkill,"---`nname: existing`ndescription: Existing local skill.`n---`nKeep this.`n")
$skillHash=(Get-FileHash -LiteralPath $originalSkill).Hash
$originalConfig=Join-Path $env:CODEX_HOME 'config.toml'
[IO.File]::WriteAllText($originalConfig,"model_reasoning_effort = `"low`"`n")
$report=@{at=(Get-Date).ToUniversalTime().ToString('o');version='0.1.1';realWan=$false;physicalMachines=1}
try {
    & (Join-Path $package 'Install.ps1') -Role Node -InstallDir $node -PrepareOnly -CodexPath $CodexPath
    $nodeExe=Join-Path $node 'runtime\node.exe';$cli=Join-Path $node 'app\src\cli.mjs';$config=Join-Path $node 'config\node.json'
    $before=Read-FleetJson $config
    if($before.enrollmentState -ne 'pending' -or $before.hubUrl){throw 'Expected an unbound node.'}
    if(Test-Path -LiteralPath (Join-Path $node 'config\hub.json')){throw 'PrepareOnly unexpectedly created a hub.'}
    $local=$null
    for($i=0;$i -lt 20;$i++){
        $local=((& $nodeExe $cli local --config $config) -join "`n") | ConvertFrom-Json
        if($local.connection.state -eq 'awaiting_enrollment'){break};Start-Sleep -Seconds 1
    }
    if($local.connection.state -ne 'awaiting_enrollment'){throw 'Pending worker state not persisted.'}
    $report.pendingInstallation=$true
    if((Get-FileHash -LiteralPath $originalSkill).Hash -ne $skillHash -or (Get-Content -LiteralPath $originalConfig -Raw) -notmatch 'model_reasoning_effort = "low"'){throw 'Existing skill/config changed.'}
    $mcp=((& $CodexPath mcp get codex_fleet --json) -join "`n") | ConvertFrom-Json
    if($mcp.transport.command -ne $nodeExe){throw 'MCP was not registered.'}
    $report.configAndSkillPreserved=$true;$report.mcpConfigured=$true
    & (Join-Path $node 'app\scripts\Stop-Fleet.ps1') -InstallDir $node -Role Node
    $taskName=Get-FleetTaskName $node 'node';$task=Get-ScheduledTask -TaskName $taskName
    if($task.Principal.UserId -in @('SYSTEM','S-1-5-18')){throw 'Wrong node startup identity.'}
    Start-ScheduledTask -TaskName $taskName
    $running=$false
    for($i=0;$i -lt 20;$i++){
        if(Get-FleetProcess (Read-FleetJson (Join-Path $node 'data\node\service.json'))){$running=$true;break};Start-Sleep -Seconds 1
    }
    if(!$running){throw 'Pending scheduled action did not restart the worker.'}
    $report.originalUserScheduledStartup=$true
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
    & (Join-Path $package 'Install.ps1') -Role Hub -InstallDir $hub -HubPort $port -NoStartup
    $invite=Join-Path $root 'private invitation\pending.invite.json'
    & (Join-Path $hub 'app\scripts\New-NodeInvitation.ps1') -InstallDir $hub -Name pending-node -HubUrl "http://127.0.0.1:$port" -OutFile $invite
    & (Join-Path $node 'app\scripts\Complete-Enrollment.ps1') -InstallDir $node -Invitation $invite
    $after=Read-FleetJson $config
    if($after.nodeId -ne $before.nodeId -or $after.nodeToken -ne $before.nodeToken -or $after.codexHome -ne $before.codexHome -or $after.enrollmentState -ne 'enrolled'){throw 'Enrollment did not preserve the prepared identity and home.'}
    $report.invitationCompletionPreservedIdentity=$true
    $seen=$false
    for($i=0;$i -lt 20;$i++){
        $nodes=((& (Join-Path $hub 'runtime\node.exe') (Join-Path $hub 'app\src\cli.mjs') nodes --config (Join-Path $hub 'config\admin.json')) -join "`n") | ConvertFrom-Json
        if(@($nodes).Count -eq 1 -and $nodes[0].lastSeen){$seen=$true;break};Start-Sleep -Seconds 1
    }
    if(!$seen){throw 'Hub did not receive the newly enrolled node.'}
    $report.enrolledHeartbeat=$true
} finally {
    foreach($pair in @(@($node,'Node'),@($hub,'Hub'))){$script=Join-Path $pair[0] 'app\scripts\Stop-Fleet.ps1';if(Test-Path -LiteralPath $script){& $script -InstallDir $pair[0] -Role $pair[1]}}
    $taskName=Get-FleetTaskName $node 'node';if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false}
}
foreach($pair in @(@($node,'node'),@($hub,'hub'))){$record=Join-Path $pair[0] "data\$($pair[1])\service.json";if((Test-Path -LiteralPath $record) -and (Get-FleetProcess (Read-FleetJson $record))){throw 'Test process still running.'}}
$report.testProcessesAndStartupRemoved=$true
Write-FleetJson $ReportFile $report
Write-Host "Pending installation smoke passed: $ReportFile"
