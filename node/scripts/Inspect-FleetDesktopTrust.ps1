param([string]$InstallDir='D:\CodexFleet')
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
. (Join-Path $PSScriptRoot 'Windows-DesktopTrust.ps1')
Set-FleetCache
$root=Join-Path $InstallDir 'desktop-bridge'
$launcher=Join-Path $root 'codex-fleet-desktop.exe'
$policy=Get-FleetDesktopPolicy
$report=@{state='checked';stage='trust_preflight';at=(Get-Date).ToUniversalTime().ToString('o');requiresSignedRelease=$policy.requiresSignedRelease;desktopVisible='not_verified';errorCode=$null;error=$null}
try{
 if(Test-Path -LiteralPath $launcher){$trust=Assert-FleetDesktopLauncherTrust $launcher;$report.signatureStatus=$trust.signatureStatus}
 elseif($policy.requiresSignedRelease){Stop-FleetDesktopTrust 'This Windows application-control policy requires an approved signed Fleet desktop release. The ordinary node remains available; desktop linkage is not ready.' 'DESKTOP_SIGNED_RELEASE_REQUIRED'}
 else{$report.state='not_prepared'}
}catch{
 $report.state='failed';$report.errorCode=Get-FleetDesktopTrustFailure $_;$report.error=$_.Exception.Message
 # The worker already reports this bounded file; preparation failure must not
 # be hidden by the absence of a successful desktop launch.
 Write-FleetJson (Join-Path $root 'launch-status.json') $report
}
Write-FleetJson (Join-Path $root 'trust-status.json') $report
$report | ConvertTo-Json -Depth 5 -Compress
