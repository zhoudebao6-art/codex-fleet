import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const windows=process.platform==='win32',scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const env={...process.env,TEMP:'E:\\codex+\\temp',TMP:'E:\\codex+\\temp',TMPDIR:'E:\\codex+\\temp',PSModuleAnalysisCachePath:'E:\\codex+\\cache\\powershell\\ModuleAnalysisCache'};
const psQuote=s=>"'"+s.replaceAll("'","''")+"'";
function powershell(dir,script){const file=path.join(dir,'check.ps1');fs.writeFileSync(file,script);return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file],{env,windowsHide:true,encoding:'utf8'});}

test('reopening an already configured shared desktop preserves the worker and never takes a maintenance lease',{skip:!windows},()=>{
 const dir=fs.mkdtempSync('E:/codex+/temp/fleet-reopen-'),app=path.join(dir,'app','scripts'),bridge=path.join(dir,'desktop-bridge');
 fs.mkdirSync(app,{recursive:true});fs.mkdirSync(bridge);fs.mkdirSync(path.join(dir,'config'));fs.mkdirSync(path.join(dir,'runtime'));
 for(const name of ['Start-FleetDesktop.ps1','Windows-Common.ps1'])fs.copyFileSync(path.join(scripts,name),path.join(app,name));
 fs.writeFileSync(path.join(app,'Windows-Desktop.ps1'),"function Test-FleetDesktopOwner {return $true}\nfunction Get-FleetDesktopApplication {return [pscustomobject]@{Path='C:\\fixture\\ChatGPT.exe'}}\nfunction Start-FleetDesktopApplication {throw 'Existing desktop must not be relaunched'}");
 fs.writeFileSync(path.join(app,'Stop-Fleet.ps1'),"throw 'Existing worker must not be stopped'");
 fs.writeFileSync(path.join(app,'Start-Fleet.ps1'),"param($InstallDir,$Role)\nWrite-Output 'Existing worker checked'");
 fs.writeFileSync(path.join(bridge,'codex-fleet-desktop.exe'),'fixture');
 fs.writeFileSync(path.join(bridge,'runtime.json'),JSON.stringify({port:12345,pid:123,token:'test-only'}));
 const config=JSON.stringify({desktopSessionBridge:path.join(bridge,'runtime.json'),dataDir:path.join(dir,'data')});fs.writeFileSync(path.join(dir,'config','node.json'),config);
 const output=powershell(dir,`function Get-CimInstance {param($ClassName) return [pscustomobject]@{ExecutablePath='C:\\fixture\\ChatGPT.exe'}}
function Invoke-RestMethod {param($Uri,$Headers,$TimeoutSec) if($Uri -ne 'http://127.0.0.1:12345/health'){throw 'Unexpected endpoint'};return [pscustomobject]@{ready=$true;pid=123}}
function Start-Sleep {param($Seconds)}
& ${psQuote(path.join(app,'Start-FleetDesktop.ps1'))} -InstallDir ${psQuote(dir)}
`);
 assert.match(output,/Existing desktop connection is ready/);assert.equal(fs.readFileSync(path.join(dir,'config','node.json'),'utf8'),config);
 assert.equal(JSON.parse(fs.readFileSync(path.join(bridge,'launch-status.json'))).stage,'connection_reused');
});

test('stale service marker recovery accepts only the lock owner lifetime and this installation',{skip:!windows},()=>{
 const dir=fs.mkdtempSync('E:/codex+/temp/fleet-lock-adopt-');fs.mkdirSync(path.join(dir,'data'));
 const output=powershell(dir,`. ${psQuote(path.join(scripts,'Windows-Common.ps1'))}
$root=${psQuote(dir)};$cfg=[pscustomobject]@{dataDir=(Join-Path $root 'data')}
$started=[DateTime]::UtcNow
$script:candidate=[pscustomobject]@{ProcessId=123;CreationDate=$started;ExecutablePath=(Join-Path $root 'runtime\\node.exe');CommandLine=((Join-Path $root 'app\\src\\worker.mjs')+' --config '+(Join-Path $root 'config\\node.json'))}
function Get-CimInstance {param($ClassName,$Filter,$ErrorAction) return $script:candidate}
Write-FleetJson (Join-Path $cfg.dataDir 'worker.lock') @{pid=123;started=$started.AddSeconds(2).ToString('o')}
if(!(Get-FleetLockedWorker $root $cfg)){throw 'Verified existing worker was missed'}
$script:candidate.CreationDate=$started.AddHours(1)
if(Get-FleetLockedWorker $root $cfg){throw 'Reused PID was accepted'}
$script:candidate.CreationDate=$started;$script:candidate.ExecutablePath='C:\\other\\node.exe'
if(Get-FleetLockedWorker $root $cfg){throw 'Foreign executable was accepted'}
$script:candidate.ExecutablePath=(Join-Path $root 'runtime\\node.exe');$script:candidate.CommandLine='another worker'
if(Get-FleetLockedWorker $root $cfg){throw 'Foreign script was accepted'}
Write-Output 'PASS'
`);assert.match(output,/PASS/);
});

test('packaged launch helper supplies bridge and D-drive temp without inherited environment, and rejects changed requests',{skip:!windows},async()=>{
 const dir=fs.mkdtempSync('E:/codex+/temp/fleet-app-launch-test-'),appDir=path.join(dir,'package');fs.mkdirSync(appDir);
 const compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),helper=path.join(dir,'codex-fleet-app-launcher.exe');
 execFileSync(compiler,['/nologo','/target:winexe','/r:System.Web.Extensions.dll','/out:'+helper,path.join(scripts,'DesktopAppLauncher.cs')],{env,windowsHide:true});
 const fake=path.join(appDir,'Fake.cs'),app=path.join(appDir,'ChatGPT.exe');
 fs.writeFileSync(fake,'using System;using System.IO;using System.Web.Script.Serialization;class Fake{static void Main(){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"observed.json"),new JavaScriptSerializer().Serialize(new {cli=Environment.GetEnvironmentVariable("CODEX_CLI_PATH"),temp=Environment.GetEnvironmentVariable("TEMP"),tmp=Environment.GetEnvironmentVariable("TMP"),tmpdir=Environment.GetEnvironmentVariable("TMPDIR")}));}}');
 execFileSync(compiler,['/nologo','/target:winexe','/r:System.Web.Extensions.dll','/out:'+app,fake],{env,windowsHide:true});
 fs.writeFileSync(path.join(dir,'codex-fleet-desktop.exe'),'probe only');
 const request={requestId:'test-actual-environment',appPath:app,packageRoot:appDir};fs.writeFileSync(path.join(dir,'desktop-launch.json'),JSON.stringify(request));
 execFileSync(helper,[request.requestId],{env:{...env,CODEX_CLI_PATH:'incorrect-inherited-value'},windowsHide:true});
 const output=path.join(appDir,'observed.json');for(let i=0;i<40&&!fs.existsSync(output);i++)await new Promise(r=>setTimeout(r,50));
 const observed=JSON.parse(fs.readFileSync(output));assert.equal(observed.cli,path.join(dir,'codex-fleet-desktop.exe'));for(const k of ['temp','tmp','tmpdir'])assert.equal(observed[k],'E:\\codex+\\temp');
 assert.throws(()=>execFileSync(helper,['stale-request'],{env,windowsHide:true}));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'desktop-launch-result.json'))).status,'failed');
 request.requestId='outside-package';request.packageRoot=path.join(dir,'elsewhere');fs.writeFileSync(path.join(dir,'desktop-launch.json'),JSON.stringify(request));
 assert.throws(()=>execFileSync(helper,[request.requestId],{env,windowsHide:true}));assert.match(JSON.parse(fs.readFileSync(path.join(dir,'desktop-launch-result.json'))).error,/not inside/);
});

test('desktop launch only uses package-context compatibility for access denied and restores the caller environment',{skip:!windows},()=>{
 const dir=fs.mkdtempSync('E:/codex+/temp/fleet-app-launch-policy-');
 fs.writeFileSync(path.join(dir,'codex-fleet-desktop.exe'),'fixture');fs.writeFileSync(path.join(dir,'codex-fleet-app-launcher.exe'),'fixture');
 const script=`. ${psQuote(path.join(scripts,'Windows-Common.ps1'))}
Set-FleetCache
. ${psQuote(path.join(scripts,'Windows-Desktop.ps1'))}
$desktop=[pscustomobject]@{Path='C:\\fixture\\ChatGPT.exe';PackageRoot='C:\\fixture';Family='fixture_family';AppId='App';EntryPoint='Windows.FullTrustApplication'}
$root=${psQuote(dir)}
$env:CODEX_CLI_PATH='original'
$script:errorCode=5;$script:called=0
function Initialize-FleetDesktopAppLauncher {param($BridgeRoot) return (Join-Path $BridgeRoot 'codex-fleet-app-launcher.exe')}
function Start-FleetDesktopExecutable { param($Path) throw [ComponentModel.Win32Exception]::new($script:errorCode) }
function Invoke-CommandInDesktopPackage {param($PackageFamilyName,$AppId,$Command,[Alias('Args')]$LaunchArgs,[switch]$PreventBreakaway,$ErrorAction)
 if(!$PreventBreakaway -or $PackageFamilyName -ne 'fixture_family' -or $AppId -ne 'App'){throw 'Incorrect package scope'}
 $script:called++;Write-FleetJson (Join-Path $root 'desktop-launch-result.json') @{requestId=$LaunchArgs;status='started';pid=123}
}
$mode=Start-FleetDesktopApplication $desktop $root
if($mode -ne 'package_context' -or $script:called -ne 1 -or $env:CODEX_CLI_PATH -ne 'original'){throw 'Compatibility launch failed'}
$script:errorCode=2;$failed=$false
try{Start-FleetDesktopApplication $desktop $root}catch{$failed=$true}
if(!$failed -or $script:called -ne 1 -or $env:CODEX_CLI_PATH -ne 'original'){throw 'Unexpected error was retried'}
$script:errorCode=5;$desktop.EntryPoint='DifferentApp';$failed=$false
try{Start-FleetDesktopApplication $desktop $root}catch{$failed=$true}
if(!$failed -or $script:called -ne 1){throw 'Non-FullTrust package was launched'}
Write-Output 'PASS'
`;
 assert.match(powershell(dir,script),/PASS/);
});

test('real Windows access-denied exception reaches compatibility without localized message matching',{skip:!windows},()=>{
 const dir=fs.mkdtempSync('E:/codex+/temp/fleet-native-denied-');
 fs.writeFileSync(path.join(dir,'codex-fleet-desktop.exe'),'fixture');fs.writeFileSync(path.join(dir,'codex-fleet-app-launcher.exe'),'fixture');
 const script=`. ${psQuote(path.join(scripts,'Windows-Common.ps1'))}
Set-FleetCache
. ${psQuote(path.join(scripts,'Windows-Desktop.ps1'))}
$root=${psQuote(dir)}
$source=Join-Path $root 'Fixture.cs';$exe=Join-Path $root 'ChatGPT.exe'
[IO.File]::WriteAllText($source,'class Fixture { static void Main() {} }')
& (Join-Path $env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe') /nologo /target:winexe "/out:$exe" $source | Out-Null
if($LASTEXITCODE -ne 0){throw 'Compile failed'}
$desktop=[pscustomobject]@{Path=$exe;PackageRoot=$root;Family='fixture_family';AppId='App';EntryPoint='Windows.FullTrustApplication'}
$script:called=0
function Initialize-FleetDesktopAppLauncher {param($BridgeRoot) return (Join-Path $BridgeRoot 'codex-fleet-app-launcher.exe')}
function Invoke-CommandInDesktopPackage {param($PackageFamilyName,$AppId,$Command,[Alias('Args')]$LaunchArgs,[switch]$PreventBreakaway,$ErrorAction)
 if(!$PreventBreakaway){throw 'Package containment missing'}
 $script:called++;Write-FleetJson (Join-Path $root 'desktop-launch-result.json') @{requestId=$LaunchArgs;status='started';pid=123}
}
$original=Get-Acl -LiteralPath $exe;$acl=Get-Acl -LiteralPath $exe
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::ExecuteFile,[Security.AccessControl.AccessControlType]::Deny)
try{
 $acl.AddAccessRule($rule);Set-Acl -LiteralPath $exe -AclObject $acl
 $nativeCode=$null
 try{Start-FleetDesktopExecutable $exe;throw 'Access denial fixture failed'}catch{$failure=$_.Exception;while($failure){if($failure -is [ComponentModel.Win32Exception]){$nativeCode=$failure.NativeErrorCode};$failure=$failure.InnerException}}
 if($nativeCode -ne 5){throw 'Native code was lost'}
 $env:CODEX_CLI_PATH='original-fixture'
 $mode=Start-FleetDesktopApplication $desktop $root
 if($mode -ne 'package_context' -or $script:called -ne 1 -or $env:CODEX_CLI_PATH -ne 'original-fixture'){throw 'Real access-denied fallback failed'}
}finally{Set-Acl -LiteralPath $exe -AclObject $original}
Write-Output 'PASS'
`;
 assert.match(powershell(dir,script),/PASS/);
});
