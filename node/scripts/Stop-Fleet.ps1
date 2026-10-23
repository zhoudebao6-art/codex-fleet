param([string]$InstallDir='D:\CodexFleet',[ValidateSet('Hub','Node')][string]$Role='Node',[ValidateRange(1,600)][int]$TimeoutSeconds=180,[switch]$RecoverIdleHang)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
$config=Join-Path $InstallDir ('config\'+$Role.ToLowerInvariant()+'.json');$cfg=Read-FleetJson $config
$marker=Join-Path $cfg.dataDir 'service.json'
if (!(Test-Path -LiteralPath $marker)) { Write-Host 'No managed process record.';return }
$record=Read-FleetJson $marker
if (!(Get-FleetProcess $record)) { Write-Host 'The recorded Fleet process is no longer running. No other process was stopped.';return }
$stopFile=Join-Path $cfg.dataDir 'stop.request'
if(!(Test-Path -LiteralPath $stopFile)){[IO.File]::WriteAllText($stopFile,'stop')}
for($i=0;$i -lt $TimeoutSeconds;$i++){ if (!(Get-FleetProcess $record)) { Write-Host "$Role stopped.";return }; Start-Sleep -Seconds 1 }
if($RecoverIdleHang -and $Role -eq 'Node'){
    . (Join-Path $PSScriptRoot 'Idle-WorkerRecovery.ps1')
    Stop-FleetVerifiedIdleWorker -InstallDir $InstallDir
}else{Write-Warning 'The managed process has not stopped yet. It was not force-killed. Inspect its active task and logs.'}
