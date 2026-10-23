param([ValidateSet('Hub','Node')][string]$Role)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'scripts\Windows-Common.ps1')
Set-FleetCache
if(!$Role){$choice=Read-Host 'Install [1] Hub on the always-online PC, or [2] Node on a Codex PC';$Role=if($choice -eq '1'){'Hub'}elseif($choice -eq '2'){'Node'}else{throw 'Choose 1 or 2.'}}
$installDir=Read-Host 'Installation directory [D:\CodexFleet]';if(!$installDir){$installDir='D:\CodexFleet'}
& (Join-Path $PSScriptRoot 'scripts\Install-Tailscale.ps1')
if($Role -eq 'Hub'){
 & (Join-Path $PSScriptRoot 'Install.ps1') -Role Hub -InstallDir $installDir
 & (Join-Path $installDir 'app\scripts\Enable-PrivateNetwork.ps1') -Role Hub -InstallDir $installDir
 Write-Host 'Create one separate invitation for each computer with app\scripts\New-NodeInvitation.ps1.'
}else{
 $invite=(Read-Host 'Full path to this computer invitation JSON [Enter to prepare locally before the hub is installed]').Trim('"')
 $project=Read-Host 'Shared project ID [workspace]';if(!$project){$project='workspace'}
 $root=Read-Host 'Existing local project directory [new empty workspace]'
 if($invite){
     & (Join-Path $PSScriptRoot 'scripts\Enable-PrivateNetwork.ps1') -Role Node -InstallDir $installDir
     & (Join-Path $PSScriptRoot 'Install.ps1') -Role Node -InstallDir $installDir -Invitation $invite -ProjectId $project -ProjectRoot $root
 }
 else { & (Join-Path $PSScriptRoot 'Install.ps1') -Role Node -InstallDir $installDir -PrepareOnly -ProjectId $project -ProjectRoot $root }
}
