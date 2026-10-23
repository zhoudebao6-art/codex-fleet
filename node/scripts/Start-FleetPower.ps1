param([string]$InstallDir='D:\CodexFleet')
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
$config=Join-Path $InstallDir 'config\node.json';$cfg=Read-FleetJson $config
if(!$cfg.hubUrl -or $cfg.enrollmentState -ne 'enrolled'){return}
$dir=Join-Path $cfg.dataDir 'power';New-Item -ItemType Directory -Path $dir -Force|Out-Null
$lock=$null
try{
 $lock=[IO.File]::Open((Join-Path $dir 'start.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $marker=Join-Path $dir 'service.json'
 if(Test-Path -LiteralPath $marker){if(Get-FleetProcess (Read-FleetJson $marker)){Write-Host 'Fleet power agent is already running.';return}}
 $stop=Join-Path $dir 'stop.request';if(Test-Path -LiteralPath $stop){Remove-Item -LiteralPath $stop}
 $node=Join-Path $InstallDir 'runtime\node.exe';$script=Join-Path $InstallDir 'app\src\power-agent.mjs'
 $arguments=(Quote-FleetArgument $script)+' --config '+(Quote-FleetArgument $config)
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
 $process=Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $dir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dir "$stamp.out.log") -RedirectStandardError (Join-Path $dir "$stamp.err.log")
 Start-Sleep -Milliseconds 500
 if($process.HasExited){throw 'Fleet power agent exited during startup.'}
 $native=Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
 Write-FleetJson $marker @{pid=$process.Id;executable=$node;script=$script;config=$config;created=$native.CreationDate.ToUniversalTime().ToString('o')}
 Write-Host 'Fleet power agent started; existing Codex tasks were retained.'
}catch [IO.IOException]{Write-Warning 'Fleet power startup is already in progress.'}
finally{if($lock){$lock.Dispose()}}
