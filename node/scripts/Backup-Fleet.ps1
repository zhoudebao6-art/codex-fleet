param([string]$InstallDir='D:\CodexFleet',[string]$BackupRoot='D:\codex+\backups')
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
foreach($role in @('hub','node')){
 $marker=Join-Path $InstallDir "data\$role\service.json"
 if((Test-Path -LiteralPath $marker) -and (Get-FleetProcess (Read-FleetJson $marker))){throw 'Stop Fleet services first; backup requires a consistent SQLite snapshot.'}
}
$destination=Join-Path $BackupRoot ('codex-fleet-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6))
$InstallDir=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$destination=[IO.Path]::GetFullPath($destination)
if($destination.StartsWith($InstallDir+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Choose a backup directory outside the Fleet installation.'}
New-Item -ItemType Directory -Path $destination | Out-Null
Protect-FleetDirectory $destination
$incomplete=Join-Path $destination 'BACKUP-INCOMPLETE.txt'
[IO.File]::WriteAllText($incomplete,'Backup did not finish. Do not use this directory for restore.')
$node=Join-Path $InstallDir 'runtime\node.exe'
$parts=@('app','runtime','config','data')
$records=New-Object System.Collections.Generic.List[object]
$snapshots=@{}
# The worker is stopped, but Codex MCP clients may still hold the WAL database.
# Snapshot SQLite before copying immutable output files referenced by that snapshot.
foreach($part in $parts){
 $source=Join-Path $InstallDir $part
 if(!(Test-Path -LiteralPath $source)){continue}
 foreach($file in Get-ChildItem -LiteralPath $source -File -Recurse | Where-Object {$_.Extension -in @('.sqlite','.db')}){
  $relative=$file.FullName.Substring($InstallDir.Length+1);$copy=Join-Path $destination $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $copy) -Force | Out-Null
  $snapshotText=& $node --no-warnings (Join-Path $PSScriptRoot 'backup-sqlite.mjs') $file.FullName $copy
  if($LASTEXITCODE -ne 0){throw "SQLite snapshot failed: $relative"}
  $snapshot=($snapshotText -join "`n") | ConvertFrom-Json
  if($snapshot.integrity -ne 'ok'){throw "SQLite snapshot integrity failed: $relative"}
  $snapshots[$relative]=$true
  $records.Add(@{path=$relative;mode='sqlite_snapshot';sha256=(Get-FileHash -LiteralPath $copy).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $copy).Length;integrity='ok'})
 }
}
foreach($part in $parts){
 $source=Join-Path $InstallDir $part
 if(!(Test-Path -LiteralPath $source)){continue}
 New-Item -ItemType Directory -Path (Join-Path $destination $part) -Force | Out-Null
 foreach($file in Get-ChildItem -LiteralPath $source -File -Recurse){
  $relative=$file.FullName.Substring($InstallDir.Length+1)
  if($file.Name -match '\.(sqlite|db)-(wal|shm|journal)$'){continue}
  if($file.Extension -in @('.sqlite','.db')){if(!$snapshots[$relative]){throw 'The database set changed during backup; retry.'};continue}
  $copy=Join-Path $destination $relative;New-Item -ItemType Directory -Path (Split-Path -Parent $copy) -Force | Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination $copy
  $sourceHash=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant();$copyHash=(Get-FileHash -LiteralPath $copy).Hash.ToLowerInvariant()
  if($sourceHash -ne $copyHash){throw "Backup hash mismatch: $relative"}
  $records.Add(@{path=$relative;mode='file_copy';sha256=$copyHash;bytes=(Get-Item -LiteralPath $copy).Length})
 }
}
Write-FleetJson (Join-Path $destination 'backup-manifest.json') @{format='codex-fleet-private-backup';version=1;created=(Get-Date).ToUniversalTime().ToString('o');complete=$true;includes=$parts;sqlite='VACUUM INTO snapshot; integrity_check=ok; live WAL/SHM excluded';excludes=@('Primary project workspaces outside data','Codex home and login');files=@($records.ToArray())}
Remove-Item -LiteralPath $incomplete
Write-Host "Verified private backup: $destination"
Write-Host 'Keep this backup private: it contains Fleet device tokens. Restore only to the original role; never clone a node identity to a second PC.'
Write-Host 'This backup includes app, runtime, config and data. Primary project workspaces and the Codex home require separate backups.'
