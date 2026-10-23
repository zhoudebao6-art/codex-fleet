param([Parameter(Mandatory=$true)][string]$RecordPath,[ValidateRange(100,5000)][int]$PollMilliseconds=1000)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
$record=Read-FleetJson $RecordPath
$install=[IO.Path]::GetFullPath([string]$record.installDir).TrimEnd('\')
$config=Join-Path $install 'config\node.json';$app=Join-Path $install 'app'
$resultPath=$RecordPath+'.result.json'
function Result([string]$State,[string]$Detail){Write-FleetJson $resultPath @{state=$State;detail=$Detail;at=(Get-Date).ToUniversalTime().ToString('o')}}
function Same-Updater {
 $p=Get-CimInstance Win32_Process -Filter "ProcessId = $($record.updater.pid)" -ErrorAction SilentlyContinue
 if(!$p -or ![string]::Equals($p.ExecutablePath,[string]$record.updater.executable,[StringComparison]::OrdinalIgnoreCase)){return $false}
 $time=[DateTimeOffset]::Parse([string]$record.updater.created,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
 return [Math]::Abs(($p.CreationDate.ToUniversalTime()-$time).TotalMilliseconds) -le 1
}
function Safe-AppPath([string]$Value,[string]$Pattern){
 $full=[IO.Path]::GetFullPath($Value)
 if(![string]::Equals((Split-Path -Parent $full),$install,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $full) -notmatch $Pattern){throw 'Recovery path is outside the same installation.'}
 if((Test-Path -LiteralPath $full) -and ((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Recovery cannot replace a linked directory.'}
 return $full
}
$handle=$null;$rescueMaintenance=$false
try {
 if($install -eq [IO.Path]::GetPathRoot($install).TrimEnd('\') -or !(Test-Path -LiteralPath $config)){throw 'Invalid existing installation.'}
 $cfg=Read-FleetJson $config
 if($cfg.nodeId -ne $record.nodeId -or ![string]::Equals([IO.Path]::GetFullPath($cfg.dataDir),[IO.Path]::GetFullPath($record.dataDir),[StringComparison]::OrdinalIgnoreCase) -or (Get-FileHash -LiteralPath $config).Hash -ne $record.configHash){throw 'Installation identity changed; recovery requires review.'}
 $expectedParent=Join-Path $cfg.dataDir 'upgrades'
 if(![string]::Equals((Split-Path -Parent ([IO.Path]::GetFullPath($RecordPath))),$expectedParent,[StringComparison]::OrdinalIgnoreCase)){throw 'Recovery record is outside the managed data directory.'}
 $app=Safe-AppPath $app '^app$';$oldApp=Safe-AppPath ([string]$record.oldApp) '^app\.previous-[a-f0-9]{32}$'
 $deadline=(Get-Date).AddHours(1)
 Result 'watching' 'Waiting for the owning upgrade process.'
 while((Get-Date) -lt $deadline){
  if(Same-Updater){Start-Sleep -Milliseconds $PollMilliseconds;continue}
  # A later upgrade owns the same lock; do not race it or alter its checkout.
  try{$handle=[IO.File]::Open((Join-Path $cfg.dataDir 'upgrade.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{Start-Sleep -Milliseconds $PollMilliseconds;continue}
  $marker=Join-Path $cfg.dataDir 'service.json';$current=if(Test-Path -LiteralPath $marker){Read-FleetJson $marker}else{$null}
  if($current -and (Get-FleetProcess $current)){
   if(!$record.worker -or $current.pid -ne $record.worker.pid -or $current.created -ne $record.worker.created){Result 'healthy' 'Managed worker has already restarted.';return}
   if(!(Test-Path -LiteralPath (Join-Path $cfg.dataDir 'stop.request'))){Result 'healthy' 'Original worker is running and no stop was requested.';return}
   Result 'waiting_worker' 'Upgrade exited; checking the exact stopped worker before recovery.'
   $stopAge=((Get-Date).ToUniversalTime()-(Get-Item -LiteralPath (Join-Path $cfg.dataDir 'stop.request')).LastWriteTimeUtc).TotalSeconds
   if($stopAge -lt 180){$handle.Dispose();$handle=$null;Start-Sleep -Milliseconds $PollMilliseconds;continue}
   . (Join-Path $PSScriptRoot 'Idle-WorkerRecovery.ps1')
   $rescueMaintenance=$true
   Stop-FleetVerifiedIdleWorker -InstallDir $install
  }
  if($record.worker -and (Get-FleetProcess $record.worker)){$handle.Dispose();$handle=$null;Start-Sleep -Milliseconds $PollMilliseconds;continue}
  if((Get-FileHash -LiteralPath $config).Hash -ne $record.configHash){throw 'Configuration changed while waiting; recovery requires review.'}
  $app=Safe-AppPath $app '^app$';$oldApp=Safe-AppPath $oldApp '^app\.previous-[a-f0-9]{32}$'
  # Recover an interrupted directory swap only inside this verified install.
  if(!(Test-Path -LiteralPath $app) -and (Test-Path -LiteralPath $oldApp)){Move-Item -LiteralPath $oldApp -Destination $app}
  if(!(Test-Path -LiteralPath (Join-Path $app 'scripts\Start-Fleet.ps1'))){throw 'Worker files are missing; preserved previous application requires review.'}
  try{& (Join-Path $app 'scripts\Start-Fleet.ps1') -InstallDir $install -Role Node;Start-Sleep -Seconds 2;$running=Read-FleetJson $marker;if(!(Get-FleetProcess $running)){throw 'Replacement worker exited during recovery startup.'}}catch{
   if(!(Test-Path -LiteralPath $oldApp)){throw}
   $current=if(Test-Path -LiteralPath $marker){Read-FleetJson $marker}else{$null};if($current -and (Get-FleetProcess $current)){throw 'A managed worker is still running; rollback was not attempted.'}
   $failed=Safe-AppPath (Join-Path $install ('app.failed-'+[guid]::NewGuid().ToString('N'))) '^app\.failed-[a-f0-9]{32}$'
   Move-Item -LiteralPath $app -Destination $failed;Move-Item -LiteralPath $oldApp -Destination $app
   & (Join-Path $app 'scripts\Start-Fleet.ps1') -InstallDir $install -Role Node
  }
  $current=Read-FleetJson $marker;if(!(Get-FleetProcess $current)){throw 'Managed worker did not stay running after recovery.'}
  try{& (Join-Path $install 'runtime\node.exe') --no-warnings (Join-Path $PSScriptRoot 'upgrade-guard.mjs') maintenance-off $install | Out-Null}catch{}
  Result 'restarted' 'Managed worker restored after this upgrade exited. Existing identity and configuration preserved.';return
 }
 Result 'attention' 'Timed out waiting for the exact managed processes; none was force-killed.'
}catch{Result 'attention' ([string]$_.Exception.Message);throw}finally{
 if($rescueMaintenance){try{& (Join-Path $install 'runtime\node.exe') --no-warnings (Join-Path $PSScriptRoot 'upgrade-guard.mjs') maintenance-off $install | Out-Null}catch{}}
 if($handle){$handle.Dispose()}
}
