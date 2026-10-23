param(
 [Parameter(Mandatory=$true)][string]$OldPackageZip,
 [Parameter(Mandatory=$true)][string]$PackageZip,
 [Parameter(Mandatory=$true)][string]$CodexPath,
 [Parameter(Mandatory=$true)][string]$ReportFile,
 [string]$OpenSsl='E:\hermers\git\usr\bin\openssl.exe'
)
$ErrorActionPreference='Stop'
$env:TEMP='D:\codex+\temp';$env:TMP=$env:TEMP;$env:TMPDIR=$env:TEMP
$root=Join-Path $env:TEMP ('fleet sites upgrade '+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($OldPackageZip,(Join-Path $root 'old'))
[IO.Compression.ZipFile]::ExtractToDirectory($PackageZip,(Join-Path $root 'new'))
$oldPackage=(Get-ChildItem -LiteralPath (Join-Path $root 'old') -Directory | Select-Object -First 1).FullName
$newPackage=(Get-ChildItem -LiteralPath (Join-Path $root 'new') -Directory | Select-Object -First 1).FullName
. (Join-Path $newPackage 'scripts\Windows-Common.ps1')
$hub=Join-Path $root 'test hub';$node=Join-Path $root 'existing node';$env:CODEX_HOME=Join-Path $root 'isolated codex home'
$skill=Join-Path $env:CODEX_HOME 'skills\existing\SKILL.md';New-Item -ItemType Directory -Path (Split-Path -Parent $skill) -Force | Out-Null
[IO.File]::WriteAllText($skill,"---`nname: existing`ndescription: Existing private skill.`n---`nPreserve this.")
$skillHash=(Get-FileHash -LiteralPath $skill).Hash
$report=@{version='0.2.0';realWan=$false;physicalMachines=1;at=(Get-Date).ToUniversalTime().ToString('o')};$bridge=$null
function Get-TestPort { $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$number=$listener.LocalEndpoint.Port;$listener.Stop();return $number }
try {
 & (Join-Path $oldPackage 'Install.ps1') -Role Node -InstallDir $node -PrepareOnly -CodexPath $CodexPath -NoStartup -NoStart
 $config=Join-Path $node 'config\node.json';$before=Read-FleetJson $config;$nodeExe=Join-Path $node 'runtime\node.exe'
 $keep=Join-Path $node 'data\node\retained-input.partial';[IO.File]::WriteAllText($keep,'pending bytes to preserve');$keepHash=(Get-FileHash -LiteralPath $keep).Hash
 $dbSeed=Join-Path $root 'seed.mjs';[IO.File]::WriteAllText($dbSeed,"import {LocalStore} from './existing node/app/src/local-store.mjs'; const s=new LocalStore(process.argv[2]);s.put('upgrade-proof',{retained:true});s.close();")
 & $nodeExe $dbSeed $before.dataDir;if($LASTEXITCODE -ne 0){throw 'Cannot initialize old database.'}
 $hubPort=Get-TestPort;$tlsPort=Get-TestPort
 & (Join-Path $newPackage 'Install.ps1') -Role Hub -InstallDir $hub -HubPort $hubPort -NoStartup
 $cert=Join-Path $root 'test-only-cert.pem';$key=Join-Path $root 'test-only-key.pem'
 $priorAction=$ErrorActionPreference;$ErrorActionPreference='Continue'
 try { & $OpenSsl req -x509 -newkey rsa:2048 -nodes -keyout $key -out $cert -days 1 -subj '/CN=localhost' -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' -addext 'basicConstraints=critical,CA:TRUE' 2> (Join-Path $root 'certificate-generation.log');$certExit=$LASTEXITCODE } finally { $ErrorActionPreference=$priorAction }
 if($certExit -ne 0){throw 'TLS test certificate generation failed.'}
 $env:NODE_EXTRA_CA_CERTS=$cert
 $bridgeArgs=@((Quote-FleetArgument (Join-Path $PSScriptRoot 'sites-test-bridge.mjs')),(Quote-FleetArgument $cert),(Quote-FleetArgument $key),[string]$tlsPort,"http://127.0.0.1:$hubPort") -join ' '
 $bridge=Start-Process -FilePath $nodeExe -ArgumentList $bridgeArgs -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $root 'bridge.err.log') -RedirectStandardOutput (Join-Path $root 'bridge.out.log')
 Start-Sleep -Seconds 1
 if($bridge.HasExited){throw 'TLS test bridge did not start.'}
 $invite=Join-Path $root 'test.invite.json'
 & (Join-Path $hub 'app\scripts\New-NodeInvitation.ps1') -InstallDir $hub -Name upgraded-node -HubUrl "https://127.0.0.1:$tlsPort" -OutFile $invite
 & (Join-Path $newPackage 'Install-Sites.ps1') -InstallDir $node -Invitation $invite -NoStartup -NoStart -NoShortcut
 $after=Read-FleetJson $config
 if($before.nodeId -ne $after.nodeId -or $before.nodeToken -ne $after.nodeToken -or $before.codexHome -ne $after.codexHome -or $after.enrollmentState -ne 'enrolled'){throw 'Upgrade changed original node identity or did not enroll.'}
 if($before.projects.workspace.root -ne $after.projects.workspace.root){throw 'Project mapping changed.'}
 if((Get-FileHash -LiteralPath $skill).Hash -ne $skillHash -or (Get-FileHash -LiteralPath $keep).Hash -ne $keepHash){throw 'Skill or pending input changed.'}
 $verify=Join-Path $root 'verify.mjs';[IO.File]::WriteAllText($verify,"import {LocalStore} from './existing node/app/src/local-store.mjs';const s=new LocalStore(process.argv[2]);if(!s.get('upgrade-proof').retained)throw new Error('database lost');s.close();")
 & $nodeExe $verify $after.dataDir;if($LASTEXITCODE -ne 0){throw 'Original SQLite metadata was not retained.'}
 $report.originalIdentityProjectLoginHomeSkillsDataPreserved=$true;$report.httpsCertificateValidationRetained=$true
 & (Join-Path $node 'app\scripts\Start-Fleet.ps1') -InstallDir $node -Role Node
 $seen=$false
 for($i=0;$i -lt 20;$i++){
  $nodes=((& (Join-Path $hub 'runtime\node.exe') (Join-Path $hub 'app\src\cli.mjs') nodes --config (Join-Path $hub 'config\admin.json')) -join "`n") | ConvertFrom-Json
  if(@($nodes).Count -eq 1 -and $nodes[0].lastSeen){$seen=$true;break};Start-Sleep -Seconds 1
 }
 if(!$seen){throw 'Upgraded node heartbeat not received through HTTPS.'}
 $report.upgradedHttpsHeartbeat=$true
 & (Join-Path $node 'app\scripts\Export-Diagnostics.ps1') -InstallDir $node -OutputFile (Join-Path $root 'diagnostic.json')
 $diagnostic=Get-Content -LiteralPath (Join-Path $root 'diagnostic.json') -Raw
 if($diagnostic.Contains($after.nodeToken)){throw 'Diagnostic contains node token.'}
 $report.sanitizedDiagnostic=$true
} finally {
 foreach($pair in @(@($node,'Node'),@($hub,'Hub'))){$script=Join-Path $pair[0] 'app\scripts\Stop-Fleet.ps1';if(Test-Path -LiteralPath $script){& $script -InstallDir $pair[0] -Role $pair[1]}}
 if($bridge -and !$bridge.HasExited){Stop-Process -Id $bridge.Id -ErrorAction SilentlyContinue}
}
$report.isolatedServicesStopped=$true
Write-FleetJson $ReportFile $report
Write-Host "Sites pending-to-v0.2 upgrade smoke passed: $ReportFile"
