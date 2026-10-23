param([string]$InstallDir='D:\CodexFleet',[Parameter(Mandatory=$true)][string]$Invitation)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
$config=Join-Path $InstallDir 'config\node.json'
$cfg=Read-FleetJson $config
$invite=Read-FleetJson $Invitation
if ($cfg.hubUrl -and $cfg.hubUrl -ne $invite.hubUrl) { throw 'This node is already bound to another hub. Its identity was not changed.' }
if ($cfg.codexHome -and [IO.Path]::GetFullPath($cfg.codexHome) -ne [IO.Path]::GetFullPath($(if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path $env:USERPROFILE '.codex'}))) { throw 'Run enrollment as the original Windows user with the original CODEX_HOME.' }
$node=Join-Path $InstallDir 'runtime\node.exe';$cli=Join-Path $InstallDir 'app\src\cli.mjs'
$mapFile=Join-Path $InstallDir 'config\project-mapping.json'
Write-FleetJson $mapFile $cfg.projects
& (Join-Path $PSScriptRoot 'Stop-Fleet.ps1') -InstallDir $InstallDir -Role Node
$marker=Join-Path $cfg.dataDir 'service.json'
if ((Test-Path -LiteralPath $marker) -and (Get-FleetProcess (Read-FleetJson $marker))) { throw 'The node is still stopping. Wait for its active task before retrying enrollment.' }
try {
    & $node $cli enroll --config $config --invite $Invitation --data $cfg.dataDir --codex $cfg.codexPath --projects $mapFile
    if ($LASTEXITCODE -ne 0) { throw 'Enrollment was not confirmed. Identity and invitation binding are retained; retry this same command after connectivity is restored.' }
} finally {
    & (Join-Path $PSScriptRoot 'Start-Fleet.ps1') -InstallDir $InstallDir -Role Node
}
Write-Host 'Enrollment confirmed. The existing node identity, Codex login and local skills were retained.'
