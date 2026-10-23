param(
 [Parameter(Mandatory=$true)][string]$CertificateThumbprint,
 [Parameter(Mandatory=$true)][string]$TimestampServer,
 [string]$OutputDirectory=(Join-Path $PSScriptRoot 'desktop-binaries\win-x64')
)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
if($TimestampServer -notmatch '^https?://'){throw 'Provide the certificate publisher timestamp service URL.'}
$certificate=@(Get-ChildItem Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert | Where-Object {$_.Thumbprint -eq $CertificateThumbprint -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date)})
if($certificate.Count -ne 1){throw 'A unique existing code-signing certificate with its private key is required. No certificate or trust policy was changed.'}
if(Test-Path -LiteralPath $OutputDirectory){throw 'Use a new output directory; an existing signed release is never overwritten.'}
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$entries=@()
foreach($item in @(@{name='codex-fleet-desktop.exe';source='DesktopBridgeLauncher.cs';target='/target:exe'},@{name='codex-fleet-app-launcher.exe';source='DesktopAppLauncher.cs';target='/target:winexe'})){
 $source=Join-Path $PSScriptRoot $item.source;$binary=Join-Path $OutputDirectory $item.name
 & $compiler /nologo $item.target /optimize+ /r:System.Web.Extensions.dll "/out:$binary" $source | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Launcher compilation failed. The candidate is not a published release.'}
 $signature=Set-AuthenticodeSignature -LiteralPath $binary -Certificate $certificate[0] -HashAlgorithm SHA256 -TimestampServer $TimestampServer
 if($signature.Status -ne 'Valid' -or !$signature.TimeStamperCertificate){throw 'Publisher signing/timestamp verification failed. The candidate is not a published release.'}
 $entries+=@{name=$item.name;sourceSha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant();sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant();signerThumbprint=$signature.SignerCertificate.Thumbprint}
}
Write-FleetJson (Join-Path $OutputDirectory 'manifest.json') @{schemaVersion=1;created=(Get-Date).ToUniversalTime().ToString('o');files=$entries}
Write-Host 'Signed candidate prepared. Package this directory as scripts/desktop-binaries/win-x64 only after verifying it on the target policy. No machine trust policy was changed.'
