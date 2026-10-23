param([string]$InstallDir='D:\CodexFleet',[ValidateSet('Hub','Node')][string]$Role='Node')
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
$node=Join-Path $InstallDir 'runtime\node.exe';$cli=Join-Path $InstallDir 'app\src\cli.mjs'
if($Role -eq 'Node') {
    $cfg=Join-Path $InstallDir 'config\node.json'
    & $node $cli probe --config $cfg
    & $node $cli local --config $cfg
    $nodeConfig=Read-FleetJson $cfg
    if ($nodeConfig.hubUrl -and $nodeConfig.enrollmentState -notin @('pending','enrolling')) { & $node $cli nodes --config $cfg }
    else { Write-Host 'Waiting for the intended hub invitation. Run Complete-Enrollment.ps1 when it is available.' }
} else {
    & $node $cli nodes --config (Join-Path $InstallDir 'config\admin.json')
    & $node $cli tasks --config (Join-Path $InstallDir 'config\admin.json')
}
$tsCommand=Get-Command tailscale.exe -ErrorAction SilentlyContinue
$ts=if($tsCommand){$tsCommand.Source}elseif(Test-Path -LiteralPath 'C:\Program Files\Tailscale\tailscale.exe'){'C:\Program Files\Tailscale\tailscale.exe'}else{$null}
if($ts){$s=(& $ts status --json | ConvertFrom-Json);[pscustomobject]@{TailscaleState=$s.BackendState;Online=$s.Self.Online;Health=($s.Health -join '; ')} | Format-List}
