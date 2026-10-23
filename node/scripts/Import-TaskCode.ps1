param([Parameter(Mandatory=$true)][string]$Repository,[Parameter(Mandatory=$true)][string]$Bundle)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
$Bundle=(Resolve-Path -LiteralPath $Bundle).Path
& git -C $Repository bundle verify $Bundle;if($LASTEXITCODE -ne 0){throw 'Bundle prerequisites or integrity verification failed.'}
$heads=@(& git -C $Repository bundle list-heads $Bundle)
if($heads.Count -ne 1 -or $heads[0] -notmatch '^([a-fA-F0-9]{40,64}) (refs/fleet-export/[a-f0-9]{32})$'){throw 'Expected one Fleet export reference.'}
$commit=$Matches[1];$sourceRef=$Matches[2];$localRef='refs/fleet/incoming/'+[guid]::NewGuid().ToString('N')
& git -C $Repository fetch --no-tags $Bundle "$($sourceRef):$localRef";if($LASTEXITCODE -ne 0){throw 'Bundle import failed.'}
Write-Host "Imported $commit into $localRef. Use Prepare-Integration.ps1 to integrate after review."
