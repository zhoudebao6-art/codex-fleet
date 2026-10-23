. (Join-Path $PSScriptRoot 'Windows-DesktopTrust.ps1')

# A live loopback listener can outlive the desktop that created it. Never reuse
# that listener for another desktop process, even when /health says ready.
function Test-FleetDesktopOwner([int]$BridgePid,[string]$DesktopPath,$Processes=$null) {
    if($null -eq $Processes){$Processes=@(Get-CimInstance Win32_Process)}
    $seen=@{};$current=@($Processes | Where-Object ProcessId -eq $BridgePid)
    if($current.Count -ne 1){return $false}
    for($depth=0;$depth -lt 12;$depth++){
        $child=$current[0]
        if($seen.ContainsKey([int]$child.ProcessId)){return $false}
        $seen[[int]$child.ProcessId]=$true
        if($child.ExecutablePath -and $child.ExecutablePath -eq $DesktopPath){return $true}
        $current=@($Processes | Where-Object ProcessId -eq $child.ParentProcessId)
        if($current.Count -ne 1){return $false}
        if(!$child.CreationDate -or !$current[0].CreationDate -or $current[0].CreationDate -gt $child.CreationDate){return $false}
    }
    return $false
}

function Get-FleetDesktopApplication {
    $package=Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
    if(!$package){throw 'Codex desktop package was not found for the current Windows user.'}
    $manifest=Get-AppxPackageManifest -Package $package.PackageFullName
    $apps=@($manifest.Package.Applications.Application | Where-Object { $_.Executable -and ([IO.Path]::GetFileName(($_.Executable -replace '/','\')) -in @('ChatGPT.exe','Codex.exe')) })
    if($apps.Count -ne 1){throw 'Cannot uniquely identify the desktop application in the installed Codex manifest.'}
    $application=$apps[0]
    $packageRoot=[IO.Path]::GetFullPath($package.InstallLocation).TrimEnd('\')+'\'
    $app=[IO.Path]::GetFullPath((Join-Path $packageRoot ($application.Executable -replace '/','\')))
    if(!$app.StartsWith($packageRoot,[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $app -PathType Leaf)){throw 'Codex desktop manifest executable is missing or outside its package.'}
    return [pscustomobject]@{Path=$app;PackageRoot=$packageRoot;Family=$package.PackageFamilyName;AppId=$application.Id;EntryPoint=$application.EntryPoint;Version=[string]$package.Version}
}

function Initialize-FleetDesktopAppLauncher([string]$BridgeRoot) {
    return Initialize-FleetDesktopBinary $BridgeRoot 'application'
}

function Start-FleetDesktopExecutable([string]$Path) {
    # Windows PowerShell Start-Process discards Win32Exception.NativeErrorCode
    # when it wraps a failed launch. Process.Start retains the typed inner error,
    # so package compatibility does not depend on translated exception messages.
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=$Path;$start.UseShellExecute=$false
    $start.WorkingDirectory=Split-Path -Parent $Path
    $process=[Diagnostics.Process]::Start($start)
    if(!$process){throw 'Desktop launch did not return a process.'}
    $process.Dispose()
}

function Start-FleetDesktopApplication($Desktop,[string]$BridgeRoot) {
    $launcher=Join-Path $BridgeRoot 'codex-fleet-desktop.exe'
    if(!(Test-Path -LiteralPath $launcher)){throw 'Run Prepare-DesktopBridge.ps1 first.'}
    $old=$env:CODEX_CLI_PATH
    try {
        $env:CODEX_CLI_PATH=$launcher
        try {
            Start-FleetDesktopExecutable $Desktop.Path
            return 'direct'
        } catch {
            $failure=$_.Exception;$accessDenied=$false
            while($failure){if($failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 5){$accessDenied=$true};$failure=$failure.InnerException}
            if(!$accessDenied){throw}
            # Only FullTrust desktop packages may use this compatibility path.
            if($Desktop.EntryPoint -ne 'Windows.FullTrustApplication' -or !(Get-Command Invoke-CommandInDesktopPackage -ErrorAction SilentlyContinue)){throw}
            $helper=Initialize-FleetDesktopAppLauncher $BridgeRoot
            $requestId=[guid]::NewGuid().ToString('N')
            Write-FleetJson (Join-Path $BridgeRoot 'desktop-launch.json') @{requestId=$requestId;appPath=$Desktop.Path;packageRoot=$Desktop.PackageRoot}
            Invoke-CommandInDesktopPackage -PackageFamilyName $Desktop.Family -AppId $Desktop.AppId -Command $helper -Args $requestId -PreventBreakaway -ErrorAction Stop | Out-Null
            $resultFile=Join-Path $BridgeRoot 'desktop-launch-result.json'
            for($i=0;$i -lt 40;$i++){
                if(Test-Path -LiteralPath $resultFile){
                    try{$result=Read-FleetJson $resultFile}catch{$result=$null}
                    if($result -and $result.requestId -eq $requestId){
                        if($result.status -ne 'started'){throw ('Packaged desktop launch failed: '+$result.error)}
                        return 'package_context'
                    }
                }
                Start-Sleep -Milliseconds 250
            }
            throw 'Packaged desktop launch did not return a result. Check the existing desktop before retrying.'
        }
    } finally {$env:CODEX_CLI_PATH=$old}
}
