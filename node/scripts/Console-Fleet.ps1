param([string]$InstallDir='D:\CodexFleet')
. (Join-Path $PSScriptRoot 'Windows-Common.ps1')
Set-FleetCache
$node=Join-Path $InstallDir 'runtime\node.exe';$cli=Join-Path $InstallDir 'app\src\cli.mjs';$admin=Join-Path $InstallDir 'config\admin.json'
while($true){
    Write-Host "`nCodex Fleet controller: 1 Nodes | 2 Tasks | 3 Invite | 4 Task details | 5 Dispatch JSON | 6 Accept | 7 Cancel | 0 Exit"
    $choice=Read-Host 'Choose'
    try { switch($choice){
        '1' { & $node $cli nodes --config $admin }
        '2' { & $node $cli tasks --config $admin }
        '3' { $name=Read-Host 'Unique computer name';$projects=Read-Host 'Project IDs (comma separated)'; & (Join-Path $PSScriptRoot 'New-NodeInvitation.ps1') -InstallDir $InstallDir -Name $name -Projects $projects }
        '4' { $taskId=Read-Host 'Task ID'; & $node $cli status --config $admin --task $taskId }
        '5' { $file=(Read-Host 'Task JSON file path').Trim('"'); & $node $cli assign --config $admin --file $file }
        '6' { $taskId=Read-Host 'Task ID';$note=Read-Host 'Verified evidence'; & $node $cli accept --config $admin --task $taskId --note $note }
        '7' { $taskId=Read-Host 'Task ID'; & $node $cli cancel --config $admin --task $taskId }
        '0' { return }
    }}catch{Write-Warning $_.Exception.Message}
}
