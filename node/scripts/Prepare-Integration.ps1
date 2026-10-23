param([Parameter(Mandatory=$true)][string]$Repository,[Parameter(Mandatory=$true)][string]$BaseCommit,[Parameter(Mandatory=$true)][string[]]$CandidateCommits,[Parameter(Mandatory=$true)][string]$WorktreePath)
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
if ($BaseCommit -notmatch '^[a-fA-F0-9]{40,64}$') { throw 'Use a full base commit hash.' }
foreach($commit in $CandidateCommits){if($commit -notmatch '^[a-fA-F0-9]{40,64}$'){throw 'Use full candidate commit hashes.'}}
if(Test-Path -LiteralPath $WorktreePath){throw 'Integration worktree path already exists.'}
foreach($commit in @($BaseCommit)+$CandidateCommits){& git -C $Repository cat-file -e "$commit^{commit}";if($LASTEXITCODE -ne 0){throw 'A commit is unavailable locally. Fetch the authorized repository first.'}}
$branch='fleet/integration-'+[guid]::NewGuid().ToString('N').Substring(0,12)
& git -C $Repository worktree add -b $branch $WorktreePath $BaseCommit
if($LASTEXITCODE -ne 0){throw 'Could not create integration worktree.'}
foreach($commit in $CandidateCommits){& git -C $WorktreePath merge --no-ff --no-edit $commit;if($LASTEXITCODE -ne 0){throw "Merge stopped. Inspect and resolve the retained integration worktree: $WorktreePath"}}
Write-Host "Integration prepared: $WorktreePath ($branch). Run project tests before accepting/pushing."
