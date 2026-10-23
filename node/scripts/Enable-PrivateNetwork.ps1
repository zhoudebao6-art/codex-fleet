param([string]$InstallDir='D:\CodexFleet',[ValidateSet('Hub','Node')][string]$Role='Node',[int]$HttpsPort=8447,[switch]$Unattended)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
$cmd=Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (!$cmd) {
    $candidate='C:\Program Files\Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $candidate) { $ts=$candidate } else { throw 'Install Tailscale from https://tailscale.com/download/windows, sign in to the shared tailnet, then rerun this script.' }
} else { $ts=$cmd.Source }
$state=(& $ts status --json | ConvertFrom-Json)
if ($state.BackendState -ne 'Running') {
    Write-Host 'Complete Tailscale sign-in on this computer using the intended shared tailnet.'
    & $ts up --timeout=60s
    if ($LASTEXITCODE -ne 0) { throw 'Tailscale is not connected. Complete sign-in and rerun.' }
    $state=(& $ts status --json | ConvertFrom-Json)
}
if ($state.BackendState -ne 'Running' -or !$state.Self.Online) { throw 'Tailscale node is not online.' }
if($Unattended){& $ts set --unattended=true;if($LASTEXITCODE -ne 0){throw 'Unattended network setup failed. Retry this explicit option in an elevated PowerShell.'}}
if ($Role -eq 'Hub') {
    $cfg=Read-FleetJson (Join-Path $InstallDir 'config\hub.json')
    $dns=$state.Self.DNSName.TrimEnd('.')
    if (!$dns) { throw 'No tailnet DNS name. Enable MagicDNS/HTTPS in Tailscale and rerun.' }
    $existing=(& $ts serve status --json | ConvertFrom-Json)
    if ($existing.TCP -and $existing.TCP.PSObject.Properties.Name -contains [string]$HttpsPort) {
        $webKey="$($dns):$HttpsPort";$web=$existing.Web.PSObject.Properties[$webKey]
        $proxy=if($web){$web.Value.Handlers.PSObject.Properties['/'].Value.Proxy}else{$null}
        if ($proxy -ne "http://127.0.0.1:$($cfg.port)") { throw 'This Tailscale HTTPS port already has a different route. Choose another -HttpsPort; existing routes will not be reset.' }
    }
    & $ts serve --bg "--https=$HttpsPort" "http://127.0.0.1:$($cfg.port)"
    if ($LASTEXITCODE -ne 0) { throw 'Private HTTPS setup failed. Follow the Tailscale HTTPS enablement prompt and retry.' }
    $url="https://$($dns):$HttpsPort"
    $health=Invoke-RestMethod -Uri "$url/health" -TimeoutSec 20
    if (!$health.ok) { throw 'Private HTTPS health check failed.' }
    Write-FleetJson (Join-Path $InstallDir 'config\network.json') @{hubUrl=$url;httpsPort=$HttpsPort;checked=(Get-Date).ToString('o')}
    Write-Host "Private hub URL: $url"
}
Write-Host 'Tailscale is online. On Windows, enable Preferences > Run unattended for connectivity after logout/restart.'
Write-Host 'Fleet user tasks still require the original Windows user session. No public Funnel route was enabled.'
