param(
    [string]$Invitation,
    [string]$InstallDir='D:\CodexFleet',
    [string]$ProjectId,
    [string]$ProjectRoot,
    [string]$CodexPath,
    [switch]$NoStartup,
    [switch]$NoMcp,
    [switch]$NoStart,
    [switch]$NoShortcut
)
. (Join-Path $PSScriptRoot 'scripts\Windows-Common.ps1')
. (Join-Path $PSScriptRoot 'scripts\Windows-Install.ps1')
Set-FleetCache
if (!$Invitation) {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object System.Windows.Forms.OpenFileDialog
    $picker.Title = 'Select the invitation downloaded from Fleet Console'
    $picker.Filter = 'Fleet invitation (*.json)|*.json'
    if ($picker.ShowDialog() -ne 'OK') { throw 'Select the invitation for this computer.' }
    $Invitation = $picker.FileName
}
$Invitation = (Resolve-Path -LiteralPath $Invitation).Path
$invite = Read-FleetJson $Invitation
$hub = [Uri]$invite.hubUrl
if (!$hub.IsAbsoluteUri -or $hub.Scheme -ne 'https' -or $hub.UserInfo -or $hub.Query -or $hub.Fragment) { throw 'A valid HTTPS Sites invitation is required.' }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if ($InstallDir -eq [IO.Path]::GetPathRoot($InstallDir)) { throw 'Choose a dedicated installation directory.' }
$oldConfig = Join-Path $InstallDir 'config\node.json'
$restoreRunning = $false
if (Test-Path -LiteralPath $oldConfig) {
    $old = Read-FleetJson $oldConfig
    Assert-FleetEnrollment $old $invite
    $currentCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    if ($old.codexHome -and ![string]::Equals([IO.Path]::GetFullPath($old.codexHome),[IO.Path]::GetFullPath($currentCodexHome),[StringComparison]::OrdinalIgnoreCase)) { throw 'Use the original Windows user and Codex home.' }
    if (!$ProjectId) { $ProjectId = @($old.projects.PSObject.Properties)[0].Name }
    if (!$ProjectRoot -and $old.projects.PSObject.Properties[$ProjectId]) { $ProjectRoot = $old.projects.$ProjectId.root }
    if (!$CodexPath) { $CodexPath = $old.codexPath }
    # Complete validation before stopping a pending node.
    $null = Assert-FleetInstallPackage $PSScriptRoot $InstallDir
    $backup = Join-Path 'D:\codex+\backups' ('fleet-sites-upgrade-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Protect-FleetDirectory $backup
    Copy-Item -LiteralPath (Join-Path $InstallDir 'config') -Destination $backup -Recurse
    if (Test-Path -LiteralPath (Join-Path $InstallDir 'app')) { Copy-Item -LiteralPath (Join-Path $InstallDir 'app') -Destination $backup -Recurse }
    $service = Join-Path $old.dataDir 'service.json'
    if (Test-Path -LiteralPath $service) { $restoreRunning = [bool](Get-FleetProcess (Read-FleetJson $service)) }
    & (Join-Path $PSScriptRoot 'scripts\Stop-Fleet.ps1') -InstallDir $InstallDir -Role Node
    if ((Test-Path -LiteralPath $service) -and (Get-FleetProcess (Read-FleetJson $service))) { throw 'The pending node is still stopping. No application files were copied; wait for its active work to finish.' }
    Write-Host "Existing configuration and application backup: $backup"
}
if (!$ProjectId) { $ProjectId='workspace' }
$installArgs = @{Role='Node';InstallDir=$InstallDir;Invitation=$Invitation;ProjectId=$ProjectId;NoStartup=$NoStartup;NoMcp=$NoMcp;NoStart=$NoStart}
if ($ProjectRoot) { $installArgs.ProjectRoot=$ProjectRoot }
if ($CodexPath) { $installArgs.CodexPath=$CodexPath }
try { & (Join-Path $PSScriptRoot 'Install.ps1') @installArgs }
catch {
    if ($restoreRunning -and (Test-Path -LiteralPath $oldConfig)) {
        try { & (Join-Path $PSScriptRoot 'scripts\Start-Fleet.ps1') -InstallDir $InstallDir -Role Node; Write-Warning 'Installation did not finish. The original node identity was retained and its managed process was restarted; inspect installation-node.json before retrying.' }
        catch { Write-Warning 'Installation did not finish and the node could not be restarted. Keep the original config and invitation; use app\scripts\Start-Fleet.ps1 after resolving the recorded installation phase.' }
    }
    throw
}
if (!$NoShortcut) {
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Fleet Console.lnk'))
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File '+(Quote-FleetArgument (Join-Path $InstallDir 'app\scripts\Open-Console.ps1'))+' -InstallDir '+(Quote-FleetArgument $InstallDir)
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Description = 'Open Fleet Console using this computer one-time sign-in'
$shortcut.Save()
try {
    & (Join-Path $InstallDir 'app\scripts\Prepare-DesktopBridge.ps1') -InstallDir $InstallDir
    # Prepare-DesktopBridge records its own bounded success/failure diagnostics.
} catch {
    if(!(Test-Path -LiteralPath (Join-Path $InstallDir 'desktop-bridge\preparation-status.json'))){Write-FleetJson (Join-Path $InstallDir 'desktop-bridge\preparation-status.json') @{state='failed';error=$_.Exception.Message;at=(Get-Date).ToUniversalTime().ToString('o')}}
    Write-Warning 'The node is installed, but desktop link preparation failed. Inspect desktop-bridge\preparation-status.json; the existing Codex and node were retained.'
}
}
Write-Host 'Connected to Fleet Sites. Open Codex Fleet Console on the desktop. No local hub or Tailscale setup is required.'
