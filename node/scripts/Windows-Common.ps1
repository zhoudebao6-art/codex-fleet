$ErrorActionPreference = 'Stop'
function Assert-FleetCacheDrive([string]$DriveRoot = 'D:\') {
    # Use .NET before repairing the PowerShell 5.1 module search path.
    if (![IO.Directory]::Exists($DriveRoot)) {
        throw 'Fleet requires an available D: drive for D:\codex+ cache, temporary files, and backups. No installation or startup setting was changed. Choose a supported storage location before continuing; Fleet will not switch to C: automatically.'
    }
}
function Initialize-FleetPowerShell {
    # A Windows PowerShell child of pwsh can inherit the latter's module roots.
    # Prefer this process's own modules; never persist or alter machine/user env.
    Assert-FleetCacheDrive
    $moduleCache = 'D:\codex+\cache\powershell\ModuleAnalysisCache'
    try { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($moduleCache)) | Out-Null }
    catch { throw 'Fleet cannot write D:\codex+\cache. No installation or startup setting was changed. Check D: access before continuing.' }
    $env:PSModuleAnalysisCachePath = $moduleCache
    if ($PSVersionTable.PSEdition -eq 'Desktop' -or $PSVersionTable.PSVersion.Major -le 5) {
        $native = Join-Path $PSHOME 'Modules'
        $paths = @($native)
        foreach ($candidate in @($env:PSModulePath -split [IO.Path]::PathSeparator)) {
            if ($candidate -and !($paths -contains $candidate)) { $paths += $candidate }
        }
        $env:PSModulePath = $paths -join [IO.Path]::PathSeparator
        # Explicit loading also handles a stale autoload cache left by pwsh.
        Import-Module -Name (Join-Path $native 'Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force -ErrorAction Stop
    }
}
Initialize-FleetPowerShell
function Set-FleetCache {
    Assert-FleetCacheDrive
    try { New-Item -ItemType Directory -Path 'D:\codex+\temp' -Force | Out-Null }
    catch { throw 'Fleet cannot write D:\codex+\temp. Check D: access before continuing; C: is not used as a fallback.' }
    $env:TEMP = 'D:\codex+\temp'
    $env:TMP = $env:TEMP
    $env:TMPDIR = $env:TEMP
}
function Read-FleetJson([string]$Path) { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-FleetJson([string]$Path, $Value) {
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $Path -Force
}
function Find-FleetCodex([string]$ExplicitPath) {
    if ($ExplicitPath) { if (!(Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) { throw 'Codex executable not found.' }; return (Resolve-Path -LiteralPath $ExplicitPath).Path }
    $cmd = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $base = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $base) {
        $candidate = Get-ChildItem -LiteralPath $base -Filter codex.exe -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    throw 'Install/sign in to Codex on this computer first, or pass -CodexPath. Fleet never copies another computer login.'
}
function Protect-FleetDirectory([string]$Path) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path /inheritance:r /grant:r "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot protect private directory: $Path" }
}
function Quote-FleetArgument([string]$Value) {
    if ($Value.Contains('"')) { throw 'Paths with quotation marks are unsupported.' }
    return '"' + $Value.TrimEnd('\') + '"'
}
function Get-FleetProcess($Record) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($Record.pid)" -ErrorAction SilentlyContinue
    if (!$p) { return $null }
    if (![string]::Equals($p.ExecutablePath, $Record.executable, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    if (!$p.CommandLine.Contains($Record.script) -or !$p.CommandLine.Contains($Record.config)) { return $null }
    if ($Record.created) {
        try {
            $recordedTime=if($Record.created -is [DateTime]){$Record.created.ToUniversalTime()}else{[DateTimeOffset]::Parse([string]$Record.created,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime}
            if([Math]::Abs(($p.CreationDate.ToUniversalTime()-$recordedTime).TotalMilliseconds) -gt 1){return $null}
        }catch{return $null}
    }
    return $p
}
function Get-FleetTaskName([string]$Root,[string]$Role) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant()))).Replace('-','').Substring(0,10) } finally { $sha.Dispose() }
    return "CodexFleet-$Role-$digest"
}

function Get-FleetLockedWorker([string]$InstallDir,$Config) {
    # Recover a stale service marker only from the lock's exact live process.
    # The lock timestamp must belong to this process lifetime (PID reuse fails).
    $lockFile=Join-Path $Config.dataDir 'worker.lock'
    if(!(Test-Path -LiteralPath $lockFile)){return $null}
    try {
        $lockRecord=Read-FleetJson $lockFile
        $candidate=Get-CimInstance Win32_Process -Filter "ProcessId = $($lockRecord.pid)" -ErrorAction SilentlyContinue
        if(!$candidate){return $null}
        $created=$candidate.CreationDate.ToUniversalTime()
        $locked=[DateTimeOffset]::Parse([string]$lockRecord.started,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        $delay=($locked-$created).TotalSeconds
        if($delay -lt 0 -or $delay -gt 60){return $null}
        $record=@{pid=$candidate.ProcessId;created=$created.ToString('o');executable=(Join-Path $InstallDir 'runtime\node.exe');script=(Join-Path $InstallDir 'app\src\worker.mjs');config=(Join-Path $InstallDir 'config\node.json')}
        if(!(Get-FleetProcess $record)){return $null}
        return $record
    }catch{return $null}
}
