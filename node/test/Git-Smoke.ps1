param([Parameter(Mandatory=$true)][string]$ReportFile)
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\Windows-Common.ps1')
Set-FleetCache
$root=Join-Path $env:TEMP ('fleet-git-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $root | Out-Null
$repo=Join-Path $root 'source';$receiver=Join-Path $root 'receiver';$integration=Join-Path $root 'integration';$bundle=Join-Path $root 'change.bundle'
& git init $repo;& git -C $repo config user.name 'Fleet Test';& git -C $repo config user.email 'fleet-test@example.invalid'
[IO.File]::WriteAllText((Join-Path $repo 'base.txt'),'base');& git -C $repo add base.txt;& git -C $repo commit -m baseline;$base=(& git -C $repo rev-parse HEAD).Trim()
& git clone $repo $receiver;& git -C $receiver config user.name 'Fleet Test';& git -C $receiver config user.email 'fleet-test@example.invalid'
[IO.File]::WriteAllText((Join-Path $repo 'change.txt'),'candidate');& git -C $repo add change.txt;& git -C $repo commit -m candidate;$candidate=(& git -C $repo rev-parse HEAD).Trim()
$scripts=Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts'
& (Join-Path $scripts 'Export-TaskCode.ps1') -Repository $repo -BaseCommit $base -Commit $candidate -OutFile $bundle
& (Join-Path $scripts 'Import-TaskCode.ps1') -Repository $receiver -Bundle $bundle
& (Join-Path $scripts 'Prepare-Integration.ps1') -Repository $receiver -BaseCommit $base -CandidateCommits @($candidate) -WorktreePath $integration
if(!(Test-Path -LiteralPath (Join-Path $integration 'change.txt'))){throw 'Integrated code missing.'}
if((& git -C $receiver rev-parse HEAD).Trim() -ne $base){throw 'Main checkout was changed.'}
[IO.File]::WriteAllText((Join-Path $repo 'uncommitted.txt'),'dirty');$rejected=$false
try{& (Join-Path $scripts 'Export-TaskCode.ps1') -Repository $repo -BaseCommit $base -Commit $candidate -OutFile (Join-Path $root 'dirty.bundle')}catch{if($_.Exception.Message -match 'Uncommitted'){$rejected=$true}else{throw}}
if(!$rejected){throw 'Dirty export was not rejected.'}
& git -C $receiver checkout -b conflicting-a $base
[IO.File]::WriteAllText((Join-Path $receiver 'base.txt'),'variant-a');& git -C $receiver add base.txt;& git -C $receiver commit -m variant-a;$left=(& git -C $receiver rev-parse HEAD).Trim()
& git -C $receiver checkout -b conflicting-b $base
[IO.File]::WriteAllText((Join-Path $receiver 'base.txt'),'variant-b');& git -C $receiver add base.txt;& git -C $receiver commit -m variant-b;$right=(& git -C $receiver rev-parse HEAD).Trim()
$conflictDir=Join-Path $root 'retained-conflict';$conflict=$false
try{& (Join-Path $scripts 'Prepare-Integration.ps1') -Repository $receiver -BaseCommit $base -CandidateCommits @($left,$right) -WorktreePath $conflictDir}catch{if($_.Exception.Message -match 'Merge stopped'){$conflict=$true}else{throw}}
if(!$conflict -or !(& git -C $conflictDir diff --name-only --diff-filter=U)){throw 'Expected unresolved conflict was not retained.'}
if((& git -C $receiver rev-parse HEAD).Trim() -ne $right){throw 'Conflict changed the original checkout.'}
Write-FleetJson $ReportFile @{at=(Get-Date).ToUniversalTime().ToString('o');bundleExport=$true;bundleImport=$true;isolatedIntegration=$true;originalCheckoutPreserved=$true;dirtyExportRejected=$true;conflictRetained=$true;base=$base;candidate=$candidate}
