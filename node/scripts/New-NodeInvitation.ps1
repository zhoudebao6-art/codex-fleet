param([string]$InstallDir='D:\CodexFleet',[Parameter(Mandatory=$true)][string]$Name,[string]$Projects='workspace',[string]$AccountGroup='shared-default',[string]$HubUrl,[string]$OutFile)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
if (!$HubUrl) { $HubUrl=(Read-FleetJson (Join-Path $InstallDir 'config\network.json')).hubUrl }
if (!$OutFile) { $OutFile=Join-Path $InstallDir "invitations\$Name.invite.json" }
New-Item -ItemType Directory -Path (Split-Path -Parent $OutFile) -Force | Out-Null
Protect-FleetDirectory (Split-Path -Parent $OutFile)
& (Join-Path $InstallDir 'runtime\node.exe') (Join-Path $InstallDir 'app\src\cli.mjs') invite --config (Join-Path $InstallDir 'config\admin.json') --name $Name --projects $Projects --group $AccountGroup --url $HubUrl --out $OutFile
if ($LASTEXITCODE -ne 0) { throw 'Invitation creation failed.' }
Write-Host 'Send this one-use invitation only to the intended computer. It expires in 24 hours; admin.json must stay on the hub.'
