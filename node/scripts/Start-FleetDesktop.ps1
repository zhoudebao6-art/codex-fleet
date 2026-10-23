param([string]$InstallDir='D:\CodexFleet',[switch]$RestoreBackground)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
. (Join-Path $PSScriptRoot 'Windows-Desktop.ps1')
# Windows Appx APIs require Windows PowerShell. Forward only this invocation;
# leave persistent execution policy and machine/user environment unchanged.
if($PSVersionTable.PSEdition -eq 'Core'){
    $desktopArgs=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-InstallDir',$InstallDir)
    if($RestoreBackground){$desktopArgs+='-RestoreBackground'}
    & (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') @desktopArgs
    if($LASTEXITCODE -ne 0){throw 'Desktop launcher failed. Inspect desktop-bridge/launch-status.json; existing work was not stopped.'}
    return
}
Set-FleetCache
$root=Join-Path $InstallDir 'desktop-bridge';$config=Join-Path $InstallDir 'config\node.json';$cfg=Read-FleetJson $config
$node=Join-Path $InstallDir 'runtime\node.exe';$guard=Join-Path $PSScriptRoot 'upgrade-guard.mjs'
$maintenance=$false;$stopped=$false
$reuseConnection=(!$RestoreBackground -and $cfg.desktopSessionBridge -and ([IO.Path]::GetFullPath([string]$cfg.desktopSessionBridge) -eq [IO.Path]::GetFullPath((Join-Path $root 'runtime.json'))))
$stage='preflight';$launchMode=$null;$configBackup=$null
New-Item -ItemType Directory -Path $root -Force | Out-Null
$statusFile=Join-Path $root 'launch-status.json'
Write-FleetJson $statusFile @{state='starting';stage=$stage;at=(Get-Date).ToUniversalTime().ToString('o')}
try {
 # Fail before maintenance leases or asking the user to close working windows.
 if(!$RestoreBackground -and !$reuseConnection){
   $stage='trust_preflight'
   $null=Assert-FleetDesktopLauncherTrust (Join-Path $root 'codex-fleet-desktop.exe')
 }
 if(!$reuseConnection){
  $raw=& $node --no-warnings $guard maintenance-on $InstallDir
  if($LASTEXITCODE -ne 0){throw 'Cannot pause new Fleet claims. No session setting was changed.'};$maintenance=$true
  $idle=$null
  for($preflight=0;$preflight -lt 11;$preflight++){
    $raw=& $node --no-warnings $guard idle $InstallDir
    if($LASTEXITCODE -ne 0){throw 'Cannot verify Fleet work status. No session setting was changed.'}
    $idle=($raw -join "`n" | ConvertFrom-Json)
    if($idle.idle){break}
    # A verified cancellation is durable before its cloud acknowledgement.
    # Allow the live worker to send it before rejecting a desktop switch.
    if(@($idle.local.runs).Count -or $idle.local.transfers -or !$idle.local.outbox){break}
    Start-Sleep -Seconds 3
  }
  if(!$idle.idle){throw 'Fleet still has unfinished work or transfers. Finish or cancel them before switching the session connection.'}
 }
  if(!$RestoreBackground){
    $stage='locate_desktop'
    $desktop=Get-FleetDesktopApplication
    $app=$desktop.Path
    $open=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath -eq $app}
    if($open -and !$reuseConnection){throw 'Please exit Codex normally first, then open Codex Fleet 联动 again. No Codex process was stopped.'}
    $launcher=Join-Path $root 'codex-fleet-desktop.exe'
    if(!(Test-Path -LiteralPath $launcher)){throw 'Run Prepare-DesktopBridge.ps1 first.'}
    if(!$open){$stage='trust_preflight';$null=Assert-FleetDesktopLauncherTrust $launcher}
    $stage='launch_desktop'
    if($open -and $reuseConnection){
      $existingEndpoint=$null
      try{$existingEndpoint=Read-FleetJson (Join-Path $root 'runtime.json')}catch{}
      if(!$existingEndpoint -or !(Test-FleetDesktopOwner -BridgePid $existingEndpoint.pid -DesktopPath $app)){
        throw 'The current Codex desktop is not connected to Fleet. A stale bridge cannot be reused. Existing work was left running; after it finishes, exit Codex normally and open Codex Fleet again.'
      }
    }
    if($open){$launchMode='existing_desktop'}else{$launchMode=Start-FleetDesktopApplication -Desktop $desktop -BridgeRoot $root}
    Write-Host ('Desktop launch method: '+$launchMode)
    $stage='verify_shared_executor'
    $ready=$false;$stablePid=0;$stableChecks=0
    for($i=0;$i -lt 60;$i++){
      try{
        $state=Read-FleetJson (Join-Path $root 'runtime.json')
        $health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$state.port+'/health') -Headers @{Authorization=('Bearer '+$state.token)} -TimeoutSec 2
        if($health.ready -and $health.pid -eq $state.pid -and (Test-FleetDesktopOwner -BridgePid $state.pid -DesktopPath $app)){
          if($stablePid -eq $health.pid){$stableChecks++}else{$stablePid=$health.pid;$stableChecks=1}
          if($stableChecks -ge 4){$ready=$true;break}
        }else{$stableChecks=0}
      }catch{$stableChecks=0}
      Start-Sleep -Seconds 1
    }
    if(!$ready){throw 'Desktop bridge did not become ready. Fleet configuration was preserved; use the original Codex shortcut and report this result.'}
  }
  # Reopening a configured desktop does not switch the node executor. Keep its
  # current work and claims intact; Start-Fleet is an idempotent liveness check.
  if($reuseConnection){
    & (Join-Path $PSScriptRoot 'Start-Fleet.ps1') -InstallDir $InstallDir -Role Node
    Write-FleetJson $statusFile @{state='completed';stage='connection_reused';launchMode=$launchMode;at=(Get-Date).ToUniversalTime().ToString('o');desktopVisible='not_verified'}
    Write-Host 'Existing desktop connection is ready. Fleet work was preserved.'
    return
  }
  $stage='switch_node'
  & (Join-Path $PSScriptRoot 'Stop-Fleet.ps1') -InstallDir $InstallDir -Role Node -RecoverIdleHang
  $marker=Join-Path $cfg.dataDir 'service.json'
  if((Test-Path -LiteralPath $marker) -and (Get-FleetProcess (Read-FleetJson $marker))){throw 'Fleet is still stopping; session settings were not changed.'}
  $stopped=$true
  $configBackup=Join-Path $root ('node-backup-'+(Get-Date -Format 'yyyyMMddHHmmssfff')+'.json')
  Copy-Item -LiteralPath $config -Destination $configBackup
  if($RestoreBackground){$cfg.PSObject.Properties.Remove('desktopSessionBridge')}
  else{$cfg | Add-Member -Force NoteProperty desktopSessionBridge (Join-Path $root 'runtime.json')}
  Write-FleetJson $config $cfg
  & (Join-Path $PSScriptRoot 'Start-Fleet.ps1') -InstallDir $InstallDir -Role Node
  $stopped=$false
  Write-FleetJson $statusFile @{state='completed';stage='node_started';launchMode=$launchMode;at=(Get-Date).ToUniversalTime().ToString('o');desktopVisible='not_verified'}
  Write-Host $(if($RestoreBackground){'Fleet background mode restored.'}else{'Desktop connection enabled. Verify one short website task is visible in this Codex desktop, then stop it.'})
}catch{
  $failure=$_
  $recovery='not_attempted'
  if($stopped -and $configBackup){Copy-Item -LiteralPath $configBackup -Destination $config -Force}
  try{& (Join-Path $PSScriptRoot 'Start-Fleet.ps1') -InstallDir $InstallDir -Role Node;$recovery='node_start_checked';$stopped=$false}catch{$recovery='node_start_failed'}
  Write-FleetJson $statusFile @{state='failed';stage=$stage;launchMode=$launchMode;error=$failure.Exception.Message;errorCode=(Get-FleetDesktopTrustFailure $failure);recovery=$recovery;at=(Get-Date).ToUniversalTime().ToString('o')}
  Write-Warning ('Desktop launch diagnostics: '+$statusFile)
  throw $failure
}finally{
  if($stopped){& (Join-Path $PSScriptRoot 'Start-Fleet.ps1') -InstallDir $InstallDir -Role Node}
  if($maintenance){$null=& $node --no-warnings $guard maintenance-off $InstallDir}
}
