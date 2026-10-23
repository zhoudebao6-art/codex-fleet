param([string]$InstallDir='D:\CodexFleet',[ValidateSet('Hub','Node')][string]$Role='Node',[switch]$Wait,[ValidateRange(1,600)][int]$WaitForStopSeconds=180)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
$name=$Role.ToLowerInvariant();$config=Join-Path $InstallDir "config\$name.json"
if (!(Test-Path -LiteralPath $config)) { throw "Missing configuration: $config" }
$cfg=Read-FleetJson $config;$data=$cfg.dataDir
if($Role -eq 'Node' -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'Start-FleetPower.ps1'))){
    try{& (Join-Path $PSScriptRoot 'Start-FleetPower.ps1') -InstallDir $InstallDir}catch{Write-Warning 'Fleet power helper could not start; the task worker is unaffected.'}
}
$marker=Join-Path $data 'service.json'
$stopFile=Join-Path $data 'stop.request'
# Serialize launchers so recovery and user startup cannot race the service
# marker. Keep a stop request until its exact managed worker exits normally.
New-Item -ItemType Directory -Path $data -Force | Out-Null
$startLock=$null;$waitExisting=$null;$waitStarted=$null
$deadline=(Get-Date).AddSeconds($WaitForStopSeconds)
while(!$startLock){
    try{$startLock=[IO.File]::Open((Join-Path $data 'start.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
    catch [IO.IOException]{if((Get-Date) -ge $deadline){throw 'Another Fleet startup is still in progress. No duplicate worker was launched.'};Start-Sleep -Milliseconds 200}
}
try{
# A worker can survive its launcher's interruption before service.json is saved.
# Adopt only its verified lifetime and paths; never launch a second worker.
if($Role -eq 'Node'){
    $recorded=$null
    if(Test-Path -LiteralPath $marker){try{$recorded=Get-FleetProcess (Read-FleetJson $marker)}catch{}}
    if(!$recorded){$liveRecord=Get-FleetLockedWorker $InstallDir $cfg;if($liveRecord){Write-FleetJson $marker $liveRecord}}
}
if(Test-Path -LiteralPath $marker){
    $record=Read-FleetJson $marker;$existing=Get-FleetProcess $record
    if($existing -and (Test-Path -LiteralPath $stopFile)){
        Write-Host "$Role is finishing a previous stop; waiting for its managed process to exit."
        while($existing -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200;$existing=Get-FleetProcess $record}
        if($existing){throw 'Fleet is still stopping. Its stop request was retained and no duplicate process was launched.'}
    }
    if($existing){Write-Host "$Role is already running.";$waitExisting=$existing.ProcessId;return}
}
if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile }
$node=Join-Path $InstallDir 'runtime\node.exe';$script=Join-Path $InstallDir $(if($Role -eq 'Hub'){'app\src\hub.mjs'}else{'app\src\worker.mjs'})
$logs=Join-Path $data 'logs';New-Item -ItemType Directory -Path $logs -Force | Out-Null
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$args=(Quote-FleetArgument $script)+' --config '+(Quote-FleetArgument $config)
$p=Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $data -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs "$stamp.out.log") -RedirectStandardError (Join-Path $logs "$stamp.err.log")
Start-Sleep -Milliseconds 700
if ($p.HasExited) { throw "$Role exited. Inspect $logs\$stamp.err.log" }
$native=Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)"
Write-FleetJson $marker @{pid=$p.Id;executable=$node;script=$script;config=$config;created=$native.CreationDate.ToUniversalTime().ToString('o')}
if($Role -eq 'Hub'){
    $ready=$false
    for($attempt=0;$attempt -lt 20;$attempt++){
        if($p.HasExited){throw "Hub exited during startup. Inspect $logs\$stamp.err.log"}
        try{if((Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/health" -TimeoutSec 2).ok){$ready=$true;break}}catch{}
        Start-Sleep -Milliseconds 250
    }
    if(!$ready){throw 'Hub process started but its health endpoint is not ready. Inspect logs before using it.'}
}
Write-Host "$Role started. PID $($p.Id). Logs: $logs"
$waitStarted=$p
}finally{
    if($startLock){$startLock.Dispose()}
    # Scheduled startup waits for service lifetime outside the launch lock.
    if($Wait -and $waitExisting){Wait-Process -Id $waitExisting -ErrorAction SilentlyContinue}
    if($Wait -and $waitStarted){$waitStarted.WaitForExit();if($waitStarted.ExitCode -ne 0){exit $waitStarted.ExitCode}}
}
