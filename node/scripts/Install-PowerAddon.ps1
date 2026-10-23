param([string]$InstallDir='D:\CodexFleet',[Parameter(Mandatory)][string]$PackageDirectory,[string]$ExpectedNodeId)
. (Join-Path $InstallDir 'app\scripts\Windows-Common.ps1')
Set-FleetCache
$root=[IO.Path]::GetFullPath($InstallDir)
$source=(Resolve-Path -LiteralPath $PackageDirectory).Path
$cfg=Read-FleetJson (Join-Path $root 'config\node.json')
if($ExpectedNodeId -and $cfg.nodeId -ne $ExpectedNodeId){throw 'Node identity mismatch; no files changed.'}
$allowed=@('src/power-agent.mjs','src/power-network.mjs','scripts/Inspect-FleetPower.ps1','scripts/Keep-FleetAwake.ps1','scripts/Start-FleetPower.ps1','scripts/Start-Fleet.ps1','scripts/Disable-Fleet.ps1')
$manifest=Read-FleetJson (Join-Path $source 'power-manifest.json')
if($manifest.version -ne '0.1.0' -or @($manifest.files).Count -ne $allowed.Count){throw 'Unexpected power package.'}
foreach($entry in $manifest.files){
 if($allowed -notcontains $entry.path -or $entry.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Unexpected power package entry.'}
 $file=Join-Path $source $entry.path
 if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw 'Power package checksum mismatch.'}
}
if(@($manifest.files.path|Select-Object -Unique).Count -ne $allowed.Count){throw 'Duplicate power package entries.'}
$powerService=Join-Path $cfg.dataDir 'power\service.json'
if(Test-Path -LiteralPath $powerService){
 $existingPower=Get-FleetProcess (Read-FleetJson $powerService)
 if($existingPower){
  $same=$true
  foreach($entry in $manifest.files){
   $installed=Join-Path (Join-Path $root 'app') $entry.path
   if(!(Test-Path -LiteralPath $installed) -or (Get-FileHash -LiteralPath $installed).Hash.ToLowerInvariant() -ne $entry.sha256){$same=$false}
  }
  if($same){Write-Host 'This power package is already installed and running.';return}
  # This companion owns no Codex turns or file transfers. Gracefully release
  # only its own power lease before updating; the task worker stays untouched.
  [IO.File]::WriteAllText((Join-Path $cfg.dataDir 'power\stop.request'),'power companion update')
  $deadline=[datetime]::UtcNow.AddSeconds(30)
  while((Get-FleetProcess (Read-FleetJson $powerService)) -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 500}
  if(Get-FleetProcess (Read-FleetJson $powerService)){throw 'The power companion has not stopped. No application files were replaced; Codex tasks were not touched.'}
 }
}
$backup=Join-Path 'D:\codex+\backups' ('fleet-power-addon-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force|Out-Null
foreach($entry in $manifest.files){
 $target=Join-Path (Join-Path $root 'app') $entry.path
 if(Test-Path -LiteralPath $target){
  $copy=Join-Path $backup $entry.path
  New-Item -ItemType Directory -Path (Split-Path -Parent $copy) -Force|Out-Null
  Copy-Item -LiteralPath $target -Destination $copy
  if((Get-FileHash -LiteralPath $copy).Hash -ne (Get-FileHash -LiteralPath $target).Hash){throw 'Backup verification failed.'}
 }
}
foreach($entry in $manifest.files){
 $target=Join-Path (Join-Path $root 'app') $entry.path
 New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null
 Copy-Item -LiteralPath (Join-Path $source $entry.path) -Destination $target -Force
 if((Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant() -ne $entry.sha256){throw 'Installed power file checksum mismatch.'}
}
& (Join-Path $root 'app\scripts\Start-FleetPower.ps1') -InstallDir $root
Write-FleetJson (Join-Path $cfg.dataDir 'power\installation.json') @{version='0.1.0';nodeId=$cfg.nodeId;backup=$backup;at=[datetime]::UtcNow.ToString('o');workerRestarted=$false;codexRestarted=$false}
Write-Host 'Power add-on installed without restarting Fleet or Codex.'
