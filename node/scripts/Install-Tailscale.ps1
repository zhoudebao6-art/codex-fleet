param([string]$InstallerPath)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
if((Get-Command tailscale.exe -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath 'C:\Program Files\Tailscale\tailscale.exe')) { Write-Host 'Existing Tailscale installation retained.';return }
if(!$InstallerPath){$InstallerPath=Join-Path (Split-Path -Parent $PSScriptRoot) 'prerequisites\tailscale-setup-1.104.1-amd64.msi'}
if(!(Test-Path -LiteralPath $InstallerPath)){
 $dir='D:\codex+\cache\codex-fleet';New-Item -ItemType Directory -Path $dir -Force | Out-Null
 $InstallerPath=Join-Path $dir 'tailscale-setup-1.104.1-amd64.msi'
 [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
 Invoke-WebRequest -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-1.104.1-amd64.msi' -OutFile $InstallerPath -UseBasicParsing
}
$sig=Get-AuthenticodeSignature -LiteralPath $InstallerPath
if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch '(CN|O)=Tailscale Inc\.') {throw 'Tailscale installer signature is invalid. Do not run this file.'}
Write-Host 'Windows may request administrator authorization to install the signed Tailscale network driver.'
$p=Start-Process -FilePath 'msiexec.exe' -ArgumentList ('/i '+(Quote-FleetArgument $InstallerPath)+' /passive /norestart') -Verb RunAs -WindowStyle Hidden -PassThru -Wait
if($p.ExitCode -notin @(0,3010)){throw "Tailscale install failed: $($p.ExitCode)"}
if($p.ExitCode -eq 3010){throw 'Tailscale requires a Windows restart. Restart and run Setup again.'}
