. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
$script:FleetRecoveryHelpers=$PSScriptRoot
function Stop-FleetVerifiedIdleWorker([string]$InstallDir,[int]$MinimumStopAgeSeconds=180) {
    Set-FleetCache
    $install=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    if($install -eq [IO.Path]::GetPathRoot($install).TrimEnd('\')){throw 'Recovery requires a dedicated Fleet installation.'}
    $config=Join-Path $install 'config\node.json';$node=Join-Path $install 'runtime\node.exe';$worker=Join-Path $install 'app\src\worker.mjs'
    foreach($p in @($install,(Join-Path $install 'app'),(Join-Path $install 'config'),(Join-Path $install 'runtime'),$config,$node,$worker)){
        if(!(Test-Path -LiteralPath $p) -or ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Recovery requires ordinary existing Fleet paths.'}
    }
    $cfg=Read-FleetJson $config;$data=[IO.Path]::GetFullPath([string]$cfg.dataDir).TrimEnd('\')
    if(!$data.StartsWith($install+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Recovery data must be inside this installation.'}
    $ancestor=$data
    while($ancestor -ne $install){if((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked data directories need review.'};$ancestor=Split-Path -Parent $ancestor}
    $marker=Join-Path $data 'service.json';$stop=Join-Path $data 'stop.request';$status=Join-Path $data 'idle-recovery-status.json'
    $configHash=(Get-FileHash -LiteralPath $config).Hash;$record=Read-FleetJson $marker
    if(!$record.created -or [int]$record.pid -le 0){throw 'Managed process identity is incomplete.'}
    foreach($pair in @(@([string]$record.executable,$node),@([string]$record.script,$worker),@([string]$record.config,$config))){if(![string]::Equals([IO.Path]::GetFullPath($pair[0]),$pair[1],[StringComparison]::OrdinalIgnoreCase)){throw 'Recorded process is not this Fleet node.'}}
    if(!(Get-FleetProcess $record)){return}
    if(!(Test-Path -LiteralPath $stop) -or ((Get-Date).ToUniversalTime()-(Get-Item -LiteralPath $stop).LastWriteTimeUtc).TotalSeconds -lt $MinimumStopAgeSeconds){throw 'Normal Fleet shutdown grace period has not elapsed.'}
    $guard=Join-Path $script:FleetRecoveryHelpers 'upgrade-guard.mjs'
    $process=$null;$backup=$null
    try {
        $maintenance=& $node --no-warnings $guard maintenance-on $install
        if($LASTEXITCODE -ne 0 -or !(($maintenance -join [Environment]::NewLine | ConvertFrom-Json).enabled)){throw 'Cannot pause task dispatch for recovery.'}
        for($check=0;$check -lt 2;$check++){
            $raw=& $node --no-warnings $guard idle-recovery $install
            if($LASTEXITCODE -ne 0){throw 'Cannot prove this node is idle; its process was preserved.'}
            $proof=($raw -join [Environment]::NewLine) | ConvertFrom-Json
            if(!$proof.idle -or !$proof.completeProof -or $proof.nodeId -ne $cfg.nodeId){throw 'Unfinished work or transfers require reconciliation; the node was preserved.'}
            if($check -eq 0){
                $backup=Join-Path 'D:\codex+\backups' ('fleet-idle-recovery-'+[guid]::NewGuid().ToString('N'))
                New-Item -ItemType Directory -Path $backup | Out-Null;Protect-FleetDirectory $backup
                foreach($file in @($config,$marker,$stop)){$target=Join-Path $backup (Split-Path -Leaf $file);Copy-Item -LiteralPath $file -Destination $target;if((Get-FileHash -LiteralPath $file).Hash -ne (Get-FileHash -LiteralPath $target).Hash){throw 'Recovery backup hash mismatch.'}}
                & $node --no-warnings (Join-Path $script:FleetRecoveryHelpers 'backup-sqlite.mjs') (Join-Path $data 'node.sqlite') (Join-Path $backup 'node.sqlite') | Out-Null
                if($LASTEXITCODE -ne 0){throw 'Recovery database snapshot failed.'}
                Start-Sleep -Seconds 1
            }
        }
        if((Get-FileHash -LiteralPath $config).Hash -ne $configHash -or !(Test-Path -LiteralPath $stop)){throw 'Node configuration or shutdown intent changed; process preserved.'}
        $current=Read-FleetJson $marker
        if($current.pid -ne $record.pid -or [string]$current.created -ne [string]$record.created){throw 'Managed worker changed; process preserved.'}
        if(!(Get-FleetProcess $record)){return}
        # Hold an OS process handle, then recheck identity. Never kill an unverified PID or process tree.
        $process=[Diagnostics.Process]::GetProcessById([int]$record.pid);$null=$process.Handle
        $created=if($record.created -is [DateTime]){$record.created.ToUniversalTime()}else{[DateTimeOffset]::Parse([string]$record.created,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime}
        if([Math]::Abs(($process.StartTime.ToUniversalTime()-$created).TotalMilliseconds) -gt 1 -or !(Get-FleetProcess $record)){throw 'Managed process identity changed; process preserved.'}
        Write-FleetJson $status @{state='stopping_verified_idle_node';pid=$record.pid;nodeId=$cfg.nodeId;backup=$backup;at=(Get-Date).ToUniversalTime().ToString('o')}
        $process.Kill();if(!$process.WaitForExit(10000)){throw 'Verified node did not exit after recovery request.'}
        Write-FleetJson $status @{state='stopped';pid=$record.pid;nodeId=$cfg.nodeId;backup=$backup;at=(Get-Date).ToUniversalTime().ToString('o')}
        Write-Host 'Stopped only the verified idle Fleet node after its normal shutdown timed out.'
    }catch{
        Write-FleetJson $status @{state='attention';pid=$record.pid;nodeId=$cfg.nodeId;backup=$backup;detail=$_.Exception.Message;at=(Get-Date).ToUniversalTime().ToString('o')}
        throw
    }finally{if($process){$process.Dispose()}}
    # The caller owns maintenance and restarts the node before clearing it.
}
