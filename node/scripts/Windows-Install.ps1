function Assert-FleetEnrollment($Existing, $Invitation) {
    if (!$Existing) { return }
    if ($Existing.hubUrl -and $Existing.hubUrl -ne $Invitation.hubUrl) {
        throw 'Existing node belongs to another hub; no identity was changed.'
    }
    $state = if ($Existing.enrollmentState) { $Existing.enrollmentState } elseif ($Existing.hubUrl) { 'enrolled' } else { 'pending' }
    if ($state -eq 'enrolled') {
        if ($Invitation.name -and $Existing.name -and $Invitation.name -ne $Existing.name) {
            throw 'This invitation is for a different device code. The existing enrolled node was retained; do not use a new invitation to rename or upgrade it.'
        }
        throw 'This node is already enrolled at this site. Keep its identity and use scripts\Update-Fleet.ps1 -PackagePath <verified ZIP> -Sha256 <SHA256> -ExpectedVersion <version> -InstallDir <original directory> -Queue. No invitation was consumed and no service was stopped.'
    }
    if ($state -notin @('pending','enrolling')) { throw 'Unknown enrollment state; inspect the original node before changing it.' }
}

function Assert-FleetInstallPackage([string]$Source, [string]$InstallDir) {
    $manifest = Read-FleetJson (Join-Path $Source 'manifest.json')
    if ($manifest.name -ne 'codex-fleet' -or $manifest.platform -ne 'windows-x64' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Fleet package metadata.' }
    foreach ($entry in $manifest.files) {
        $file = [IO.Path]::GetFullPath((Join-Path $Source $entry.path))
        if (!$file.StartsWith($Source.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid manifest path.' }
        if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256 -or (Get-Item -LiteralPath $file).Length -ne $entry.bytes) { throw "Package integrity check failed: $($entry.path)" }
    }
    $package = Read-FleetJson (Join-Path $Source 'package.json')
    if ($package.version -ne $manifest.version) { throw 'Package version does not match the manifest.' }
    $sourceRuntime = Join-Path $Source 'runtime\node.exe'
    if (!(Test-Path -LiteralPath $sourceRuntime -PathType Leaf)) { throw 'Use the complete Windows package, including runtime\node.exe.' }
    $runtime = Join-Path $InstallDir 'runtime\node.exe'
    if ((Test-Path -LiteralPath $runtime) -and (Get-FileHash -LiteralPath $runtime).Hash -ne (Get-FileHash -LiteralPath $sourceRuntime).Hash) { throw 'The existing runtime differs from this package. Use the original-path updater; no application files were copied.' }
    return $manifest
}
