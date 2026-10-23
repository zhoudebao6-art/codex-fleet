param([string]$InstallDir='D:\CodexFleet',[string]$ExpectedNodeId)
. (Join-Path $PSScriptRoot 'Idle-WorkerRecovery.ps1')
Set-FleetCache
$config=Join-Path $InstallDir 'config\node.json';$cfg=Read-FleetJson $config
if($ExpectedNodeId -and $ExpectedNodeId -ne $cfg.nodeId){throw 'This is not the intended Fleet computer.'}
$lock=$null;$maintenance=$false
try {
    $lock=[IO.File]::Open((Join-Path $cfg.dataDir 'upgrade.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $marker=Join-Path $cfg.dataDir 'service.json';$stop=Join-Path $cfg.dataDir 'stop.request'
    if((Test-Path -LiteralPath $marker) -and (Test-Path -LiteralPath $stop)){
        $maintenance=$true
        Stop-FleetVerifiedIdleWorker -InstallDir $InstallDir
    }
    & (Join-Path $PSScriptRoot 'Start-Fleet.ps1') -InstallDir $InstallDir -Role Node
    $record=Read-FleetJson $marker
    if(!(Get-FleetProcess $record)){throw 'Fleet did not remain running after recovery.'}
    Write-Host 'Fleet process restored. Verify a fresh website heartbeat before declaring recovery complete.'
}finally{
    if($maintenance){& (Join-Path $InstallDir 'runtime\node.exe') --no-warnings (Join-Path $PSScriptRoot 'upgrade-guard.mjs') maintenance-off $InstallDir | Out-Null}
    if($lock){$lock.Dispose()}
}
