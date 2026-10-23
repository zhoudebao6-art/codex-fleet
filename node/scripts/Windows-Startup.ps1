function Test-FleetStartupCommand([string]$Command, [string]$InstallDir, [string]$Role) {
    $script = Join-Path $InstallDir 'app\scripts\Start-Fleet.ps1'
    $root = [regex]::Escape($InstallDir.TrimEnd('\'))
    $directoryArgument = '(?i)(?:^|\s)-InstallDir\s+(?:"'+$root+'"|'+$root+')(?=\s|$)'
    $roleMatches = $Command -match ('(?i)(?:^|\s)-Role\s+["'']?'+[regex]::Escape($Role)+'(?:["''\s]|$)')
    if ($Role -eq 'Node' -and $Command -notmatch '(?i)(?:^|\s)-Role\s') { $roleMatches=$true }
    return $Command -and $Command.IndexOf($script,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $Command -match $directoryArgument -and $roleMatches
}
function Get-FleetStartupRegistration([string]$InstallDir, [string]$Role) {
    $taskName = Get-FleetTaskName $InstallDir $Role.ToLowerInvariant()
    $lookupErrors = @()
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue -ErrorVariable lookupErrors
    foreach ($failure in $lookupErrors) {
        if ($failure.FullyQualifiedErrorId -notmatch '^CmdletizationQuery_NotFound_TaskName(?:,|$)') { throw 'Scheduled startup could not be inspected; existing launchers were retained.' }
    }
    if ($task -and @($task.Actions | Where-Object { Test-FleetStartupCommand ($_.Execute+' '+$_.Arguments) $InstallDir $Role }).Count) {
        return @{method='scheduled-task';enabled=($task.State -ne 'Disabled');name=$taskName;retained=$true}
    }
    $lookupErrors = @()
    $run = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue -ErrorVariable lookupErrors
    foreach ($failure in $lookupErrors) {
        if ($failure.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) { throw 'Current-user startup could not be inspected; existing launchers were retained.' }
    }
    if ($run) { foreach ($property in $run.PSObject.Properties) {
        if ($property.Name -notmatch '^PS' -and $property.Value -is [string] -and (Test-FleetStartupCommand $property.Value $InstallDir $Role)) { return @{method='user-run';enabled=$true;name=$property.Name;retained=$true} }
    } }
    $startup = [Environment]::GetFolderPath('Startup')
    if ($startup -and (Test-Path -LiteralPath $startup)) {
        $shell = $null
        foreach ($item in @(Get-ChildItem -LiteralPath $startup -Filter '*.lnk' -File)) {
            if (!$shell) { $shell = New-Object -ComObject WScript.Shell }
            $link = $shell.CreateShortcut($item.FullName)
            if (Test-FleetStartupCommand ($link.TargetPath+' '+$link.Arguments) $InstallDir $Role) { return @{method='user-startup';enabled=$true;name=$item.Name;retained=$true} }
        }
    }
    return $null
}
function New-FleetStartupShortcut([string]$InstallDir, [string]$Role, [string]$Arguments) {
    $startup = [Environment]::GetFolderPath('Startup')
    if (!$startup) { throw 'Current-user Startup folder is unavailable.' }
    New-Item -ItemType Directory -Path $startup -Force | Out-Null
    $target = Join-Path $startup ((Get-FleetTaskName $InstallDir $Role.ToLowerInvariant())+'.lnk')
    if (Test-Path -LiteralPath $target) { throw 'A different startup shortcut already uses the managed name; it was retained.' }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($target)
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Start this Codex Fleet node at current-user logon'
    $shortcut.Save()
    if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Startup shortcut was not created.' }
    return @{method='user-startup';enabled=$true;name=[IO.Path]::GetFileName($target);retained=$false}
}
function Register-FleetStartup([string]$InstallDir, [string]$Role) {
    try {
        $existing = Get-FleetStartupRegistration $InstallDir $Role
        if ($existing) { return $existing }
    } catch {
        # Failure to inspect existing startup must not create duplicate launchers.
        return @{method='unverified';enabled=$false;warning='Existing startup could not be inspected. No startup entry was added; current-session startup will still be attempted.'}
    }
    $script = Join-Path $InstallDir 'app\scripts\Start-Fleet.ps1'
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File '+(Quote-FleetArgument $script)+' -InstallDir '+(Quote-FleetArgument $InstallDir)+' -Role '+$Role+' -Wait'
    try {
        $taskName = Get-FleetTaskName $InstallDir $Role.ToLowerInvariant()
        $action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments
        $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if ($Role -eq 'Hub' -and $isAdmin) { $trigger=New-ScheduledTaskTrigger -AtStartup; $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest }
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        # Do not replace a pre-existing task whose action failed the ownership check.
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
        return @{method='scheduled-task';enabled=$true;name=$taskName;retained=$false}
    } catch {
        try { return New-FleetStartupShortcut $InstallDir $Role $arguments }
        catch { return @{method='none';enabled=$false;warning='Windows rejected scheduled startup and current-user Startup fallback. Current-session startup will still be attempted; automatic startup at next logon is not configured.'} }
    }
}
function Disable-FleetStartupShortcut([string]$InstallDir, [string]$Role, [string]$StartupDirectory = [Environment]::GetFolderPath('Startup')) {
    if (!$StartupDirectory) { return $false }
    $target = Join-Path $StartupDirectory ((Get-FleetTaskName $InstallDir $Role.ToLowerInvariant())+'.lnk')
    if (!(Test-Path -LiteralPath $target -PathType Leaf)) { return $false }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($target)
    if (!(Test-FleetStartupCommand ($shortcut.TargetPath+' '+$shortcut.Arguments) $InstallDir $Role)) { throw 'The startup shortcut belongs to another command and was retained.' }
    # Renaming only this verified shortcut keeps it recoverable and prevents
    # Windows from treating it as a logon launcher. User files are not removed.
    Move-Item -LiteralPath $target -Destination ($target+'.disabled-'+[guid]::NewGuid().ToString('N'))
    return $true
}
