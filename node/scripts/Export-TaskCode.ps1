param([Parameter(Mandatory=$true)][string]$Repository,[Parameter(Mandatory=$true)][string]$BaseCommit,[Parameter(Mandatory=$true)][string]$Commit,[Parameter(Mandatory=$true)][string]$OutFile)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
foreach($sha in @($BaseCommit,$Commit)){if($sha -notmatch '^[a-fA-F0-9]{40,64}$'){throw 'Use full commit hashes.'}}
if(Test-Path -LiteralPath $OutFile){throw 'Output already exists.'}
$dirty=& git -C $Repository status --porcelain;if($LASTEXITCODE -ne 0){throw 'Not a repository.'};if($dirty){throw 'Commit the authorized task changes before exporting. Uncommitted files are not silently included.'}
& git -C $Repository merge-base --is-ancestor $BaseCommit $Commit;if($LASTEXITCODE -ne 0 -or $BaseCommit -eq $Commit){throw 'Base must be an ancestor of a different candidate commit.'}
$ref='refs/fleet-export/'+[guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($OutFile))) -Force | Out-Null
try{
 & git -C $Repository update-ref $ref $Commit;if($LASTEXITCODE -ne 0){throw 'Cannot create export reference.'}
 & git -C $Repository bundle create $OutFile $ref "^$BaseCommit";if($LASTEXITCODE -ne 0){throw 'Bundle creation failed.'}
 & git -C $Repository bundle verify $OutFile;if($LASTEXITCODE -ne 0){throw 'Bundle verification failed.'}
 Get-FileHash -LiteralPath $OutFile -Algorithm SHA256
}finally{& git -C $Repository update-ref -d $ref}
