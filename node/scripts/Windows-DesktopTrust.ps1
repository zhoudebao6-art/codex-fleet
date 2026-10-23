# Read-only trust checks. Never install certificates or change application-control policy.
function Get-FleetDesktopPolicy {
    $state=$null
    try{$state=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction Stop).VerifiedAndReputablePolicyState}catch{}
    return [pscustomobject]@{verifiedAndReputableState=$state;requiresSignedRelease=($state -eq 1)}
}

function Get-FleetDesktopSignature([string]$Path) {
    $signature=Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
    return [pscustomobject]@{status=[string]$signature.Status;thumbprint=$(if($signature.SignerCertificate){$signature.SignerCertificate.Thumbprint}else{$null})}
}

function Stop-FleetDesktopTrust([string]$Message,[string]$Code='DESKTOP_TRUST_REQUIRED') {
    $failure=[InvalidOperationException]::new($Message)
    $failure.Data['FleetDesktopCode']=$Code
    throw $failure
}

function Assert-FleetDesktopLauncherTrust([string]$Path) {
    if(!(Test-Path -LiteralPath $Path -PathType Leaf)){Stop-FleetDesktopTrust 'Desktop launcher is missing. Prepare the Fleet desktop connection first.' 'DESKTOP_LAUNCHER_MISSING'}
    $signature=Get-FleetDesktopSignature $Path
    if($signature.status -notin @('Valid','NotSigned')){Stop-FleetDesktopTrust 'Desktop launcher signature cannot be verified. Restore the verified publisher release; do not retry or recompile it.' 'DESKTOP_SIGNATURE_INVALID'}
    $policy=Get-FleetDesktopPolicy
    if($policy.requiresSignedRelease -and $signature.status -ne 'Valid'){
        Stop-FleetDesktopTrust 'Windows application control requires a trusted signed Fleet desktop launcher. Install the approved signed release; reopening Codex cannot repair this. Existing Codex and Fleet work were preserved.'
    }
    return [pscustomobject]@{signatureStatus=$signature.status;signerThumbprint=$signature.thumbprint;policy=$policy}
}

function Get-FleetDesktopTrustFailure($ErrorRecord) {
    $failure=$ErrorRecord.Exception
    while($failure){
        if($failure.Data -and $failure.Data.Contains('FleetDesktopCode')){return [string]$failure.Data['FleetDesktopCode']}
        if($failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -in @(577,1260,4551)){return 'DESKTOP_APPLICATION_CONTROL_BLOCKED'}
        $failure=$failure.InnerException
    }
    return $null
}

function Initialize-FleetDesktopBinary([string]$BridgeRoot,[ValidateSet('bridge','application')][string]$Kind) {
    $name=if($Kind -eq 'bridge'){'codex-fleet-desktop.exe'}else{'codex-fleet-app-launcher.exe'}
    $sourceName=if($Kind -eq 'bridge'){'DesktopBridgeLauncher.cs'}else{'DesktopAppLauncher.cs'}
    $source=Join-Path $PSScriptRoot $sourceName
    $sourceHash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    $target=Join-Path $BridgeRoot $name
    $receiptPath=Join-Path $BridgeRoot ($name+'.release.json')
    $releaseRoot=Join-Path $PSScriptRoot 'desktop-binaries\win-x64'
    $manifestPath=Join-Path $releaseRoot 'manifest.json'
    $candidate=$null;$mode='local_build';$signer=$null
    if(Test-Path -LiteralPath $manifestPath){
        $manifest=Read-FleetJson $manifestPath
        $entry=$manifest.files | Where-Object {$_.name -eq $name}
        if($manifest.schemaVersion -ne 1 -or @($entry).Count -ne 1 -or $entry.sourceSha256 -ne $sourceHash){Stop-FleetDesktopTrust 'Signed desktop release does not match this Fleet source. Obtain the matching publisher package.' 'DESKTOP_RELEASE_MISMATCH'}
        $candidate=Join-Path $releaseRoot $name
        if(!(Test-Path -LiteralPath $candidate -PathType Leaf) -or (Get-Item -LiteralPath $candidate).LinkType){Stop-FleetDesktopTrust 'Signed desktop release file is missing or is a link.' 'DESKTOP_RELEASE_MISMATCH'}
        $candidateHash=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
        $signature=Get-FleetDesktopSignature $candidate
        if($candidateHash -ne $entry.sha256 -or $signature.status -ne 'Valid' -or !$entry.signerThumbprint -or $signature.thumbprint -ne $entry.signerThumbprint){Stop-FleetDesktopTrust 'Signed desktop release failed hash or publisher-signature verification.' 'DESKTOP_SIGNATURE_INVALID'}
        $mode='signed_release';$signer=$signature.thumbprint
    }
    if(Test-Path -LiteralPath $target){
        $existingHash=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if($candidate -and $existingHash -eq $candidateHash){$null=Assert-FleetDesktopLauncherTrust $target;return $target}
        if(!$candidate -and (Test-Path -LiteralPath $receiptPath)){
            try{$receipt=Read-FleetJson $receiptPath}catch{$receipt=$null}
            if($receipt -and $receipt.sourceSha256 -eq $sourceHash -and $receipt.sha256 -eq $existingHash){$null=Assert-FleetDesktopLauncherTrust $target;return $target}
        }
        if(!$candidate -and (Get-FleetDesktopSignature $target).thumbprint){
            Stop-FleetDesktopTrust 'A signed desktop launcher is already installed. It was preserved; a matching signed publisher release is required before replacement.' 'DESKTOP_SIGNED_RELEASE_REQUIRED'
        }
    }
    if(!$candidate){
        if((Get-FleetDesktopPolicy).requiresSignedRelease){Stop-FleetDesktopTrust 'Windows application control requires a signed Fleet desktop release. Local compilation was skipped and existing launchers were preserved.'}
        $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        if(!(Test-Path -LiteralPath $compiler)){throw 'Windows .NET Framework compiler is unavailable; existing launchers were preserved.'}
        $candidate=Join-Path $BridgeRoot ('launcher-candidate-'+[guid]::NewGuid().ToString('N')+'.exe')
        $targetType=if($Kind -eq 'bridge'){'/target:exe'}else{'/target:winexe'}
        & $compiler /nologo $targetType /optimize+ /r:System.Web.Extensions.dll "/out:$candidate" $source | Out-Null
        if($LASTEXITCODE -ne 0){throw 'Desktop launcher compilation failed; existing launchers were preserved.'}
        $candidateHash=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $null=Assert-FleetDesktopLauncherTrust $candidate
    # Verify before replacing anything. A running, locked executable is left intact.
    if(Test-Path -LiteralPath $target){Copy-Item -LiteralPath $target -Destination (Join-Path $BridgeRoot ($name+'.backup-'+(Get-Date -Format 'yyyyMMddHHmmssfff')))}
    if($mode -eq 'signed_release'){Copy-Item -LiteralPath $candidate -Destination $target -Force}else{Move-Item -LiteralPath $candidate -Destination $target -Force}
    Write-FleetJson $receiptPath @{schemaVersion=1;mode=$mode;sourceSha256=$sourceHash;sha256=$candidateHash;signerThumbprint=$signer;at=(Get-Date).ToUniversalTime().ToString('o')}
    return $target
}
