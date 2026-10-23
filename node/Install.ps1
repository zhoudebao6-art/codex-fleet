param(
    [Parameter(Mandatory=$true)][ValidateSet('Hub','Node')][string]$Role,
    [string]$InstallDir = 'D:\CodexFleet',
    [string]$Invitation,
    [switch]$PrepareOnly,
    [string]$ProjectId = 'workspace',
    [string]$ProjectRoot,
    [string]$CodexPath,
    [int]$HubPort = 43127,
    [switch]$NoStartup,
    [switch]$NoMcp,
    [switch]$NoStart
)
. (Join-Path $PSScriptRoot 'scripts\Windows-Common.ps1')
. (Join-Path $PSScriptRoot 'scripts\Windows-Install.ps1')
. (Join-Path $PSScriptRoot 'scripts\Windows-Startup.ps1')
Set-FleetCache
if ($PrepareOnly -and ($Role -ne 'Node' -or $Invitation)) { throw 'Use -PrepareOnly only for a Node without an invitation.' }
if ($Role -eq 'Node' -and !$PrepareOnly -and !$Invitation) { throw 'Use -Invitation <file> or -PrepareOnly while the hub is not installed.' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if ($InstallDir -eq [IO.Path]::GetPathRoot($InstallDir)) { throw 'Choose a dedicated installation directory.' }
if ([string]::Equals($InstallDir,$PSScriptRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Install to a directory separate from the extracted package.' }
if ($Role -eq 'Node' -and !$PrepareOnly -and (Test-Path -LiteralPath (Join-Path $InstallDir 'config\node.json'))) {
    Assert-FleetEnrollment (Read-FleetJson (Join-Path $InstallDir 'config\node.json')) (Read-FleetJson $Invitation)
}
foreach($serviceRole in @('hub','node')) {
    $record=Join-Path $InstallDir "data\$serviceRole\service.json"
    if ((Test-Path -LiteralPath $record) -and (Get-FleetProcess (Read-FleetJson $record))) { throw 'Stop the existing Fleet services with Stop-Fleet.ps1 before installing or upgrading.' }
}
if ($ProjectId -notmatch '^[a-zA-Z0-9_-]{1,80}$') { throw 'Invalid project ID.' }
$sourceRuntime = Join-Path $PSScriptRoot 'runtime\node.exe'
if (!(Test-Path -LiteralPath $sourceRuntime)) { throw 'Use the complete Windows package, including runtime\node.exe.' }
$manifest = Assert-FleetInstallPackage $PSScriptRoot $InstallDir
if ($Role -eq 'Node') { $codex = Find-FleetCodex $CodexPath }
$app = Join-Path $InstallDir 'app'
$runtime = Join-Path $InstallDir 'runtime'
$private = Join-Path $InstallDir 'config'
foreach ($dir in @($app,$runtime,$private,(Join-Path $InstallDir 'data'))) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
Protect-FleetDirectory $private
$installState = Join-Path $private ('installation-'+$Role.ToLowerInvariant()+'.json')
$phase = 'copying-application'
Write-FleetJson $installState @{version=$manifest.version;state='installing';phase=$phase;updated=(Get-Date).ToUniversalTime().ToString('o')}
try {
foreach ($part in @('src','scripts','skills','docs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $part) -Destination $app -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Destination (Join-Path $app 'package.json') -Force
$node = Join-Path $runtime 'node.exe'
if (!(Test-Path -LiteralPath $node)) { Copy-Item -LiteralPath $sourceRuntime -Destination $node }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime\LICENSE') -Destination (Join-Path $runtime 'LICENSE') -Force
if ((Get-FileHash -LiteralPath $node).Hash -ne (Get-FileHash -LiteralPath $sourceRuntime).Hash) { throw 'Runtime differs from this package. Stop Fleet and back up the installation before upgrading.' }
$cli = Join-Path $app 'src\cli.mjs'
$config = Join-Path $private ($Role.ToLowerInvariant()+'.json')
$data = Join-Path $InstallDir ('data\'+$Role.ToLowerInvariant())
New-Item -ItemType Directory -Path $data -Force | Out-Null
Protect-FleetDirectory $data
if ($Role -eq 'Hub') {
    if (!(Test-Path -LiteralPath $config)) { & $node $cli init-hub --config $config --data $data --port $HubPort; if ($LASTEXITCODE -ne 0) { throw 'Hub initialization failed.' } }
} else {
    if (!$ProjectRoot) { $ProjectRoot = Join-Path $InstallDir 'workspace'; New-Item -ItemType Directory -Path $ProjectRoot -Force | Out-Null }
    if (!(Test-Path -LiteralPath $ProjectRoot -PathType Container)) { throw 'ProjectRoot must be an existing local directory.' }
    $ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
    $maps = @{}; $maps[$ProjectId] = @{root=$ProjectRoot;sandbox='workspace-write'}
    if (Test-Path -LiteralPath $config) {
        $old = Read-FleetJson $config
        foreach ($p in $old.projects.PSObject.Properties) { if ($p.Name -ne $ProjectId) { $maps[$p.Name]=$p.Value } }
        if ($old.projects.PSObject.Properties[$ProjectId] -and [string]::Equals([IO.Path]::GetFullPath($old.projects.$ProjectId.root),$ProjectRoot,[StringComparison]::OrdinalIgnoreCase)) { $maps[$ProjectId]=$old.projects.$ProjectId }
    }
    $mapFile = Join-Path $private 'project-mapping.json'; Write-FleetJson $mapFile $maps
    $phase = 'enrollment'
    if ($PrepareOnly) {
        & $node $cli prepare-node --config $config --data $data --codex $codex --projects $mapFile --name $env:COMPUTERNAME
        if ($LASTEXITCODE -ne 0) { throw 'Local node preparation failed; existing identity was retained.' }
    } else {
        & $node $cli enroll --config $config --invite $Invitation --data $data --codex $codex --projects $mapFile
        if ($LASTEXITCODE -ne 0) { throw 'Enrollment failed. Local identity is retained so the same invitation can be retried.' }
    }
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $phase = 'local-integration'
    $nodeConfig=Read-FleetJson $config
    $nodeConfig | Add-Member -NotePropertyName codexHome -NotePropertyValue $codexHome -Force
    Write-FleetJson $config $nodeConfig
    $backup = Join-Path 'D:\codex+\backups' ('codex-fleet-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Protect-FleetDirectory $backup
    $skillDir = Join-Path $codexHome 'skills\codex-fleet'
    if (Test-Path -LiteralPath $skillDir) { Copy-Item -LiteralPath $skillDir -Destination $backup -Recurse }
    New-Item -ItemType Directory -Path (Split-Path -Parent $skillDir) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $app 'skills\codex-fleet') -Destination (Split-Path -Parent $skillDir) -Recurse -Force
    Write-FleetJson (Join-Path $skillDir 'installation.json') @{installDir=$InstallDir;config=$config}
    if (!$NoMcp) {
        $priorErrorAction=$ErrorActionPreference
        $ErrorActionPreference='Continue'
        try { $existingText = & $codex mcp list --json 2>$null; $mcpExit=$LASTEXITCODE } finally { $ErrorActionPreference=$priorErrorAction }
        if ($mcpExit -ne 0) { throw 'Cannot inspect existing MCP configuration. Resolve the local Codex error first.' }
        # Windows PowerShell 5.1 emits a JSON array as one pipeline object.
        # Assign it first so filtering enumerates servers, not their combined names.
        $mcpServers = ($existingText -join "`n") | ConvertFrom-Json
        $existing = @($mcpServers | Where-Object { $_.name -eq 'codex_fleet' })
        if ($existing.Count -gt 1) { throw 'Multiple codex_fleet MCP entries were returned. Inspect the local MCP configuration.' }
        if ($existing.Count -eq 1) {
            $existing = $existing[0]
            if ($existing.transport.command -ne $node -or @($existing.transport.args) -notcontains $config -or @($existing.transport.args) -notcontains (Join-Path $app 'src\mcp.mjs')) {
                throw 'An existing codex_fleet MCP entry belongs to another path. Inspect it before changing installations.'
            }
        } else {
            $codexConfig = Join-Path $codexHome 'config.toml'
            if (Test-Path -LiteralPath $codexConfig) { Copy-Item -LiteralPath $codexConfig -Destination (Join-Path $backup 'config.toml') }
            & $codex mcp add codex_fleet -- $node (Join-Path $app 'src\mcp.mjs') --config $config
            if ($LASTEXITCODE -ne 0) { throw "MCP setup failed; backup: $backup" }
        }
    }
    & $node $cli probe --config $config
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Codex probe failed. Run Diagnose-Fleet.ps1 after signing in locally.' }
}
$phase = 'startup'
$startup = if ($NoStartup) { @{method='unchanged';enabled=$false} } else { Register-FleetStartup $InstallDir $Role }
if ($startup.warning) { Write-Warning $startup.warning }
if ($startup.retained -and !$startup.enabled) { Write-Warning 'The existing startup entry is disabled and was retained. Automatic startup at next logon is not enabled.' }
Write-FleetJson (Join-Path $private ('installed-'+$Role.ToLowerInvariant()+'.json')) @{version=$manifest.version;role=$Role;installDir=$InstallDir;installed=(Get-Date).ToString('o');startup=[bool]$startup.enabled;startupMethod=$startup.method;startupRetained=[bool]$startup.retained}
$phase = 'starting'
if($Role -eq 'Node' -and (Test-Path -LiteralPath (Join-Path $app 'scripts\Inspect-FleetDesktopTrust.ps1'))){
    # A desktop-only trust blocker must not prevent the enrolled worker from
    # starting or leave a stop request behind. No launcher is executed here.
    try{& (Join-Path $app 'scripts\Inspect-FleetDesktopTrust.ps1') -InstallDir $InstallDir | Out-Null}catch{Write-Warning 'Desktop trust inspection failed; the node will still start. Inspect desktop-bridge diagnostics.'}
}
if (!$NoStart) { & (Join-Path $app 'scripts\Start-Fleet.ps1') -InstallDir $InstallDir -Role $Role }
Write-FleetJson $installState @{version=$manifest.version;state='installed';phase='complete';startup=[bool]$startup.enabled;startupMethod=$startup.method;started=(!$NoStart);updated=(Get-Date).ToUniversalTime().ToString('o')}
} catch {
    # Enrollment may already have consumed the invitation. Never roll back its
    # node ID/token or user data; retain the phase for a precise recovery.
    try { Write-FleetJson $installState @{version=$manifest.version;state='incomplete';phase=$phase;identityRetained=$true;updated=(Get-Date).ToUniversalTime().ToString('o');recovery='Keep the original config and invitation. Inspect the recorded phase before retrying. If already enrolled, do not enroll with a new invitation.'} } catch { Write-Warning 'Could not save installation status; original config and user data were retained.' }
    throw
}
Write-Host "Installed $Role at $InstallDir. Existing Codex login and other skills were retained."
if ($Role -eq 'Hub') { Write-Host "Next: run app\scripts\Enable-PrivateNetwork.ps1, then app\scripts\New-NodeInvitation.ps1." }
elseif ($PrepareOnly) { Write-Host 'Node is installed and awaiting the intended hub invitation. Use fleet_local now; later run app\scripts\Complete-Enrollment.ps1 -Invitation <file>.' }
else { Write-Host 'Open a new Codex chat, load $codex-fleet, and call fleet_nodes.' }
