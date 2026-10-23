param(
 [Parameter(Mandatory=$true)][string]$PackagePath,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Sha256,
 [string]$InstallDir='D:\CodexFleet',
 [ValidateRange(30,2700)][int]$WaitForIdleSeconds=1800,
 [ValidatePattern('^[a-zA-Z0-9_-]{1,100}$')][string]$ActionId,
 [ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedVersion,
 [switch]$Queue,
 [switch]$VerifyOnly
)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
$env:PSModuleAnalysisCachePath='D:\codex+\cache\powershell\ModuleAnalysisCache'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if($ActionId -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])$'){throw 'Action ID is a reserved Windows device name.'}

function Assert-Child([string]$Parent,[string]$Child){
 $parentPath=[IO.Path]::GetFullPath($Parent).TrimEnd('\')
 $childPath=[IO.Path]::GetFullPath($Child)
 if(!$childPath.StartsWith($parentPath+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Operation target is outside its intended directory.'}
 if(Test-Path -LiteralPath $childPath){if((Get-Item -LiteralPath $childPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Upgrade does not replace a linked directory.'}}
 return $childPath
}
function Copy-VerifiedTree([string]$Source,[string]$Destination){
 New-Item -ItemType Directory -Path $Destination -Force | Out-Null
 foreach($item in Get-ChildItem -LiteralPath $Source -Recurse -Force){
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked entries need manual upgrade review.'}
  $relative=$item.FullName.Substring($Source.TrimEnd('\').Length+1)
  $target=Assert-Child $Destination (Join-Path $Destination $relative)
  if($item.PSIsContainer){New-Item -ItemType Directory -Path $target -Force | Out-Null;continue}
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $item.FullName -Destination $target -Force
  if((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $item.FullName).Hash){throw 'Backup or staged copy hash mismatch.'}
 }
}
function Read-Guard([string]$Mode){
 for($try=0;$try -lt 3;$try++){
  # Use the verified release guard, including when upgrading an older adapter.
  $raw=& $node --no-warnings (Join-Path $source 'scripts\upgrade-guard.mjs') $Mode $InstallDir
  if($LASTEXITCODE -eq 0){return (($raw -join "`n") | ConvertFrom-Json)}
  if($try -lt 2){Start-Sleep -Seconds (2+$try*2)}
 }
 throw "Upgrade guard failed: $Mode"
}
function Status([string]$State,[string]$Detail=''){
 if($statusFile){$statusValue=@{state=$State;detail=$Detail;at=(Get-Date).ToUniversalTime().ToString('o');version=$manifest.version;packageSha256=$Sha256.ToLowerInvariant();backup=$backup;pid=$PID;actionId=$ActionId};Write-FleetJson $statusFile $statusValue;if($ActionId){Write-FleetJson (Join-Path $cfg.dataDir ('upgrades\'+$ActionId+'.status.json')) $statusValue}}
 Write-Host $State
}

$PackagePath=(Resolve-Path -LiteralPath $PackagePath).Path
if((Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash -ne $Sha256){throw 'Package SHA256 mismatch; nothing was changed.'}
$InstallDir=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if($InstallDir -eq [IO.Path]::GetPathRoot($InstallDir).TrimEnd('\')){throw 'Use a dedicated existing Fleet installation.'}
if(!(Test-Path -LiteralPath $InstallDir -PathType Container)){throw 'The existing installation does not exist.'}
if((Get-Item -LiteralPath $InstallDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Upgrade requires the resolved installation path.'}
$app=Assert-Child $InstallDir (Join-Path $InstallDir 'app')
$config=Assert-Child $InstallDir (Join-Path $InstallDir 'config\node.json')
$node=Assert-Child $InstallDir (Join-Path $InstallDir 'runtime\node.exe')
if(!(Test-Path -LiteralPath $config) -or !(Test-Path -LiteralPath $node)){throw 'Install and enroll this node before an in-place upgrade.'}
$cfg=Read-FleetJson $config
$stage=Join-Path $env:TEMP ('fleet-upgrade-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$zip=[IO.Compression.ZipFile]::OpenRead($PackagePath)
try{
 $seen=@{};$total=[long]0;$manifestEntry=$null
 if($zip.Entries.Count -gt 5000){throw 'Package has too many entries.'}
 foreach($entry in $zip.Entries){
  $name=$entry.FullName.Replace('\','/')
  if($name -match '(^/|:|(^|/)\.\.(/|$)|(^|/)\.(/|$)|\x00)' -or !$name.TrimEnd('/')){throw 'Unsafe ZIP path.'}
  if($seen.ContainsKey($name.ToLowerInvariant())){throw 'Duplicate ZIP path.'};$seen[$name.ToLowerInvariant()]=$true
  $total+=$entry.Length;if($total -gt 1073741824){throw 'Expanded package exceeds 1 GiB.'}
  $target=Assert-Child $stage (Join-Path $stage $name)
  if($name -match '^[^/]+/manifest\.json$'){if($manifestEntry){throw 'More than one package root.'};$manifestEntry=$entry}
 }
 if(!$manifestEntry){throw 'A Windows release manifest is required.'}
 $rootName=$manifestEntry.FullName.Replace('\','/').Split('/')[0]
 foreach($entry in $zip.Entries){if(!$entry.FullName.Replace('\','/').StartsWith($rootName+'/',[StringComparison]::Ordinal)){throw 'ZIP entries span multiple roots.'}}
 [IO.Compression.ZipFile]::ExtractToDirectory($PackagePath,$stage)
}finally{$zip.Dispose()}
$source=Assert-Child $stage (Join-Path $stage $rootName)
$manifest=Read-FleetJson (Join-Path $source 'manifest.json')
if($manifest.name -ne 'codex-fleet' -or $manifest.platform -ne 'windows-x64' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$'){throw 'Unsupported release manifest.'}
if($ExpectedVersion -and $manifest.version -ne $ExpectedVersion){throw 'Registered installer version does not match the release manifest.'}
$listed=@{}
foreach($record in $manifest.files){
 if(!$record.path -or $record.path -match '(^[/\\]|:|(^|[/\\])\.\.([/\\]|$))' -or $record.sha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'Invalid manifest entry.'}
 $relative=([string]$record.path).Replace('\','/');if($listed.ContainsKey($relative.ToLowerInvariant())){throw 'Duplicate manifest entry.'};$listed[$relative.ToLowerInvariant()]=$true
 $file=Assert-Child $source (Join-Path $source $relative)
 if(!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne $record.bytes -or (Get-FileHash -LiteralPath $file).Hash -ne $record.sha256){throw "Manifest integrity check failed: $relative"}
}
foreach($file in Get-ChildItem -LiteralPath $source -File -Recurse){$relative=$file.FullName.Substring($source.Length+1).Replace('\','/');if($relative -ne 'manifest.json' -and !$listed.ContainsKey($relative.ToLowerInvariant())){throw 'Package contains an unlisted file.'}}
foreach($part in @('src','scripts','skills','docs','package.json')){if(!(Test-Path -LiteralPath (Join-Path $source $part))){throw 'Package source is incomplete.'}}
$packageVersion=(Read-FleetJson (Join-Path $source 'package.json')).version
if($packageVersion -ne $manifest.version){throw 'Version metadata mismatch.'}
foreach($script in Get-ChildItem -LiteralPath (Join-Path $source 'src') -File -Recurse -Filter '*.mjs'){& $node --check $script.FullName | Out-Null;if($LASTEXITCODE -ne 0){throw 'Release JavaScript syntax check failed.'}}
if($VerifyOnly){Write-Host "Verified release $($manifest.version); no service or installation was changed.";return}

if($Queue){
 # Start from a verified extracted copy so replacing app cannot replace the
 # script or helper currently controlling this upgrade.
 $queuedScript=Join-Path $source 'scripts\Update-Fleet.ps1'
 $arguments='-NoProfile -ExecutionPolicy Bypass -File '+(Quote-FleetArgument $queuedScript)+' -PackagePath '+(Quote-FleetArgument $PackagePath)+' -Sha256 '+$Sha256+' -InstallDir '+(Quote-FleetArgument $InstallDir)+' -WaitForIdleSeconds '+$WaitForIdleSeconds
 if($ActionId){$arguments+=' -ActionId '+$ActionId}
 if($ExpectedVersion){$arguments+=' -ExpectedVersion '+$ExpectedVersion}
 $logs=Join-Path $cfg.dataDir 'upgrades';New-Item -ItemType Directory -Path $logs -Force | Out-Null
 $actionLock=$null
 try{
 if($ActionId){
  $actionLock=[IO.File]::Open((Join-Path $logs ($ActionId+'.queue.lock')),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $receipt=Join-Path $logs ($ActionId+'.queued.json')
  if(Test-Path -LiteralPath $receipt){$previous=Read-FleetJson $receipt;if($previous.packageSha256 -ne $Sha256){throw 'Action ID is already associated with a different installer.'};Write-Host 'Upgrade action already queued; it will not be launched twice.';return}
  # Write an intent before process creation. An uncertain launch is reconciled
  # by the node and never automatically repeated for the same action ID.
  Write-FleetJson $receipt @{actionId=$ActionId;packageSha256=$Sha256.ToLowerInvariant();created=(Get-Date).ToUniversalTime().ToString('o');state='launching';pid=$null}
 }
 $runId=(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)
 $process=Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs ($runId+'.out.log')) -RedirectStandardError (Join-Path $logs ($runId+'.err.log'))
 $queueValue=@{pid=$process.Id;actionId=$ActionId;packageSha256=$Sha256.ToLowerInvariant();created=(Get-Date).ToUniversalTime().ToString('o');state='queued';note='Waits for the current task and all queues to finish before stopping only the managed Fleet worker.'}
 Write-FleetJson (Join-Path $logs ($runId+'.queued.json')) $queueValue
 if($ActionId){Write-FleetJson $receipt $queueValue}
 Write-Host "Upgrade queued. PID $($process.Id); status directory: $logs";return
 }finally{if($actionLock){$actionLock.Dispose()}}
}

$lockPath=Join-Path $cfg.dataDir 'upgrade.lock';$lockHandle=$null;$maintenance=$false;$moved=$false;$started=$false;$stopped=$false;$stopRequested=$false;$stopRecord=$null;$backup=$null
$statusFile=Join-Path $cfg.dataDir 'upgrade-status.json'
$oldApp=Assert-Child $InstallDir (Join-Path $InstallDir ('app.previous-'+[guid]::NewGuid().ToString('N')))
$newApp=Assert-Child $InstallDir (Join-Path $InstallDir ('app.next-'+[guid]::NewGuid().ToString('N')))
$configHash=(Get-FileHash -LiteralPath $config).Hash
try{
 $lockHandle=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 Status 'preparing'
 New-Item -ItemType Directory -Path $newApp | Out-Null
 foreach($part in @('src','scripts','skills','docs')){Copy-VerifiedTree (Join-Path $source $part) (Join-Path $newApp $part)}
 Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination (Join-Path $newApp 'package.json')
 if(Test-Path -LiteralPath (Join-Path $source 'scripts\Inspect-FleetDesktopTrust.ps1')){
  # Record desktop trust separately. Updating the ordinary node remains safe
  # when a desktop launcher is blocked; never execute or recompile it here.
  try{& (Join-Path $source 'scripts\Inspect-FleetDesktopTrust.ps1') -InstallDir $InstallDir | Out-Null}catch{Write-Warning 'Desktop trust inspection is unavailable; node upgrade will preserve its existing executor configuration.'}
 }
 $maintenance=$true;$maintenanceResult=Read-Guard 'maintenance-on';if(!$maintenanceResult.enabled){throw 'Hub did not pause new task claims.'}
 Status 'waiting_for_idle'
 $deadline=(Get-Date).AddSeconds($WaitForIdleSeconds);$stable=0
 while((Get-Date) -lt $deadline){
  $idle=Read-Guard 'idle'
  if($idle.idle){$stable++}else{$stable=0}
  if($stable -ge 2){break}
  Start-Sleep -Seconds 3
 }
 if($stable -lt 2){throw 'Upgrade wait expired; current work was left running.'}
 # Maintenance excludes new cloud claims. The second local and remote check
 # ensures previously claimed work has entered and left the durable queues.
 Status 'stopping_worker'
 $marker=Join-Path $cfg.dataDir 'service.json'
 if(Test-Path -LiteralPath $marker){$stopRecord=Read-FleetJson $marker}
 $updaterProcess=Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
 $guardRecord=Join-Path $cfg.dataDir ('upgrades\recovery-'+[guid]::NewGuid().ToString('N')+'.json')
 Write-FleetJson $guardRecord @{installDir=$InstallDir;dataDir=$cfg.dataDir;nodeId=$cfg.nodeId;configHash=$configHash;oldApp=$oldApp;packageSha256=$Sha256;worker=$stopRecord;updater=@{pid=$PID;executable=$updaterProcess.ExecutablePath;created=$updaterProcess.CreationDate.ToUniversalTime().ToString('o')}}
 $guardArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File '+(Quote-FleetArgument (Join-Path $source 'scripts\Recover-FleetUpgrade.ps1'))+' -RecordPath '+(Quote-FleetArgument $guardRecord)
 $guardProcess=Start-Process -FilePath 'powershell.exe' -ArgumentList $guardArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput ($guardRecord+'.out.log') -RedirectStandardError ($guardRecord+'.err.log')
 $stopRequested=$true
 # New helper also gives older workers enough time to leave their old sleep.
 & (Join-Path $source 'scripts\Stop-Fleet.ps1') -InstallDir $InstallDir -Role Node -RecoverIdleHang
 if((Test-Path -LiteralPath $marker) -and (Get-FleetProcess (Read-FleetJson $marker))){throw 'Fleet did not stop normally; no process was force-killed.'}
 $stopped=$true
 $idle=Read-Guard 'idle';if(!$idle.idle){throw 'Queues changed during stop; upgrade aborted.'}
 Status 'backing_up'
 $backup=Join-Path 'D:\codex+\backups' ('codex-fleet-upgrade-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6))
 New-Item -ItemType Directory -Path $backup | Out-Null;Protect-FleetDirectory $backup
 Copy-VerifiedTree $app (Join-Path $backup 'app')
 Copy-VerifiedTree (Join-Path $InstallDir 'config') (Join-Path $backup 'config')
 New-Item -ItemType Directory -Path (Join-Path $backup 'data') | Out-Null
 foreach($db in Get-ChildItem -LiteralPath $cfg.dataDir -File | Where-Object {$_.Extension -in @('.sqlite','.db')}){
  $copy=Join-Path $backup ('data\'+$db.Name)
  & $node --no-warnings (Join-Path $source 'scripts\backup-sqlite.mjs') $db.FullName $copy | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Database backup did not pass integrity_check.'}
 }
 $codexHome=if($cfg.codexHome){[string]$cfg.codexHome}elseif($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path $env:USERPROFILE '.codex'}
 $skill=Join-Path $codexHome 'skills\codex-fleet'
 if(Test-Path -LiteralPath $skill){Copy-VerifiedTree $skill (Join-Path $backup 'codex-fleet-skill')}
 $backupFiles=@(Get-ChildItem -LiteralPath $backup -Recurse -File | ForEach-Object {@{path=$_.FullName.Substring($backup.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant();bytes=$_.Length}})
 Write-FleetJson (Join-Path $backup 'manifest.json') @{complete=$true;nodeId=$cfg.nodeId;created=(Get-Date).ToUniversalTime().ToString('o');files=$backupFiles;sqlite='VACUUM INTO, integrity_check=ok';note='Private: contains original node credentials. Restore only to the same device.'}
 if((Get-FileHash -LiteralPath $config).Hash -ne $configHash){throw 'Node configuration changed during preparation; retry after reviewing it.'}
 Status 'installing'
 $null=Assert-Child $InstallDir $app;$null=Assert-Child $InstallDir $oldApp;$null=Assert-Child $InstallDir $newApp
 Move-Item -LiteralPath $app -Destination $oldApp
 try{Move-Item -LiteralPath $newApp -Destination $app;$moved=$true}catch{Move-Item -LiteralPath $oldApp -Destination $app;throw}
 if(Test-Path -LiteralPath $skill){Copy-VerifiedTree (Join-Path $app 'skills\codex-fleet') $skill}
 Status 'starting_worker'
 & (Join-Path $app 'scripts\Start-Fleet.ps1') -InstallDir $InstallDir -Role Node
 Start-Sleep -Seconds 3
 if(!(Test-Path -LiteralPath $marker) -or !(Get-FleetProcess (Read-FleetJson $marker))){throw 'Updated managed worker did not stay alive.'}
 if((Get-FileHash -LiteralPath $config).Hash -ne $configHash){throw 'Node configuration unexpectedly changed.'}
 $started=$true
 $null=Read-Guard 'maintenance-off';$maintenance=$false
 Status 'completed' 'Original node identity, Codex login, skills, MCP, project mappings, startup entry and runtime preserved.'
}catch{
 $problem=$_.Exception.Message
 if($stopRequested -and !$stopped -and !$moved -and (!$stopRecord -or !(Get-FleetProcess $stopRecord))){$stopped=$true}
 if($moved -and !$started){
  Status 'rolling_back' $problem
  & (Join-Path $app 'scripts\Stop-Fleet.ps1') -InstallDir $InstallDir -Role Node
  $marker=Join-Path $cfg.dataDir 'service.json'
  if((Test-Path -LiteralPath $marker) -and (Get-FleetProcess (Read-FleetJson $marker))){throw 'Rollback needs attention: the replacement Fleet worker has not stopped; it was not force-killed.'}
  $failedApp=Assert-Child $InstallDir (Join-Path $InstallDir ('app.failed-'+[guid]::NewGuid().ToString('N')))
  $null=Assert-Child $InstallDir $app;$null=Assert-Child $InstallDir $oldApp
  Move-Item -LiteralPath $app -Destination $failedApp;Move-Item -LiteralPath $oldApp -Destination $app
  if($backup -and (Test-Path -LiteralPath (Join-Path $backup 'codex-fleet-skill'))){Copy-VerifiedTree (Join-Path $backup 'codex-fleet-skill') $skill}
 }
 # If the old worker had already stopped, restore its ordinary service. This
 # function checks the exact PID identity and cannot stop an unrelated Codex.
 if($lockHandle -and $stopped -and (Test-Path -LiteralPath (Join-Path $app 'scripts\Start-Fleet.ps1'))){try{& (Join-Path $app 'scripts\Start-Fleet.ps1') -InstallDir $InstallDir -Role Node}catch{Write-Warning 'Fleet restart needs attention; inspect upgrade-status.json.'}}
 Status 'failed' $problem
 throw
}finally{
 if($maintenance){try{$null=Read-Guard 'maintenance-off'}catch{Write-Warning 'Could not clear cloud maintenance. It will expire automatically.'}}
 if($lockHandle){$lockHandle.Dispose()}
}
