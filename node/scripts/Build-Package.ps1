param([string]$OutputDirectory,[string]$NodeExecutable='E:\hermers\node\node.exe',[string]$NodeLicense='E:\hermers\node\LICENSE',[string]$TailscaleMsi='D:\codex+\cache\codex-fleet\tailscale-setup-1.104.1-amd64.msi',[switch]$IncludeTailscale,[switch]$RequireSignedDesktop)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
. (Join-Path $PSScriptRoot 'Windows-DesktopTrust.ps1')
$source=Split-Path -Parent $PSScriptRoot
$signedRelease=Join-Path $PSScriptRoot 'desktop-binaries\win-x64\manifest.json'
if($RequireSignedDesktop -and !(Test-Path -LiteralPath $signedRelease)){throw 'A signed desktop release is required for this package. Run the publisher signing workflow with an existing trusted code-signing certificate first.'}
if(Test-Path -LiteralPath $signedRelease){
    # A present release must validate even when the strict flag was omitted.
    $verification=Join-Path $env:TEMP ('fleet-signed-release-check-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $verification | Out-Null
    $null=Initialize-FleetDesktopBinary $verification bridge
    $null=Initialize-FleetDesktopBinary $verification application
}
$version=(Read-FleetJson (Join-Path $source 'package.json')).version
if($version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid package version.'}
if(!$OutputDirectory){$OutputDirectory=Join-Path (Split-Path -Parent (Split-Path -Parent $source)) 'outputs'}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$stage=Join-Path $env:TEMP ('fleet-package-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$package=Join-Path $stage "codex-fleet-$version-windows-x64";New-Item -ItemType Directory -Path $package | Out-Null
foreach($part in @('src','scripts','skills','docs','Install.ps1','Install-Sites.ps1','Setup-Sites.cmd','Setup.ps1','Setup-Hub.cmd','Setup-Node.cmd','package.json')){Copy-Item -LiteralPath (Join-Path $source $part) -Destination $package -Recurse}
$runtime=Join-Path $package 'runtime';$prerequisites=Join-Path $package 'prerequisites'
New-Item -ItemType Directory -Path $runtime,$prerequisites | Out-Null
$sig=Get-AuthenticodeSignature -LiteralPath $NodeExecutable;if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'OpenJS'){throw 'Node signature validation failed.'}
Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $runtime 'node.exe')
Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $runtime 'LICENSE')
if ($IncludeTailscale) {
  $tsSig=Get-AuthenticodeSignature -LiteralPath $TailscaleMsi
  if($tsSig.Status -ne 'Valid' -or $tsSig.SignerCertificate.Subject -notmatch 'Tailscale'){throw 'Tailscale signature validation failed.'}
  Copy-Item -LiteralPath $TailscaleMsi -Destination $prerequisites
}
$files=@(Get-ChildItem -LiteralPath $package -Recurse -File | Sort-Object FullName | ForEach-Object { @{path=$_.FullName.Substring($package.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant();bytes=$_.Length} })
Write-FleetJson (Join-Path $package 'manifest.json') @{name='codex-fleet';version=$version;platform='windows-x64';built=(Get-Date).ToUniversalTime().ToString('o');desktopLaunchers=$(if(Test-Path -LiteralPath $signedRelease){'signed-publisher-release'}else{'local-build-where-policy-allows'});files=$files}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=Join-Path $OutputDirectory "codex-fleet-$version-windows-x64.zip"
if(Test-Path -LiteralPath $zip){throw 'Output ZIP exists. Choose a new output directory or explicitly archive the previous build.'}
[IO.Compression.ZipFile]::CreateFromDirectory($stage,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
$sourceZip=Join-Path $OutputDirectory "codex-fleet-$version-source.zip"
if(Test-Path -LiteralPath $sourceZip){throw 'Source ZIP exists.'}
[IO.Compression.ZipFile]::CreateFromDirectory($source,$sourceZip,[IO.Compression.CompressionLevel]::Optimal,$false)
Copy-Item -LiteralPath (Join-Path $source 'docs\部署使用指南.md'),(Join-Path $source 'docs\跨机验收清单.md'),(Join-Path $source 'docs\桌面启动器签名与受控设备接入.md') -Destination $OutputDirectory
Write-FleetJson (Join-Path $OutputDirectory 'SHA256.json') @(@{file=(Split-Path -Leaf $zip);sha256=(Get-FileHash -LiteralPath $zip).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $zip).Length},@{file=(Split-Path -Leaf $sourceZip);sha256=(Get-FileHash -LiteralPath $sourceZip).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $sourceZip).Length})
Write-Host "Windows package: $zip"
Write-Host "Source package: $sourceZip"
