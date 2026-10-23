import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scripts=fileURLToPath(new URL('../scripts/',import.meta.url)),win=process.platform==='win32';
const env={...process.env,TEMP:'D:\\codex+\\temp',TMP:'D:\\codex+\\temp',TMPDIR:'D:\\codex+\\temp',PSModuleAnalysisCachePath:'D:\\codex+\\cache\\powershell\\ModuleAnalysisCache'};
const q=s=>"'"+s.replaceAll("'","''")+"'";
function fixture(){const root=fs.mkdtempSync('D:/codex+/temp/fleet-desktop-trust-');fs.mkdirSync(path.join(root,'scripts'));for(const name of ['Windows-Common.ps1','Windows-DesktopTrust.ps1','DesktopBridgeLauncher.cs','DesktopAppLauncher.cs'])fs.copyFileSync(path.join(scripts,name),path.join(root,'scripts',name));return root;}
function ps(root,body){const file=path.join(root,'test.ps1');fs.writeFileSync(file,`. ${q(path.join(root,'scripts','Windows-Common.ps1'))}\n. ${q(path.join(root,'scripts','Windows-DesktopTrust.ps1'))}\nSet-FleetCache\n${body}`);return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file],{env,windowsHide:true,encoding:'utf8'});}

test('enforced signature policy rejects local preparation before replacing unsigned launchers',{skip:!win},()=>{
 const root=fixture(),bridge=path.join(root,'bridge');fs.mkdirSync(bridge);fs.writeFileSync(path.join(bridge,'codex-fleet-desktop.exe'),'original-unsigned');
 assert.match(ps(root,`function Get-FleetDesktopPolicy {return [pscustomobject]@{requiresSignedRelease=$true}}
function Get-FleetDesktopSignature {return [pscustomobject]@{status='NotSigned';thumbprint=$null}}
$failed=$false;try{Initialize-FleetDesktopBinary ${q(bridge)} bridge}catch{$failed=$true;if((Get-FleetDesktopTrustFailure $_) -ne 'DESKTOP_TRUST_REQUIRED'){throw}}
if(!$failed){throw 'Policy blocker was ignored'}
Write-Output 'PASS'
`),/PASS/);
 assert.equal(fs.readFileSync(path.join(bridge,'codex-fleet-desktop.exe'),'utf8'),'original-unsigned');assert.equal(fs.readdirSync(bridge).length,1);
});

test('matching verified publisher release is installed and reused; tampering is rejected without replacing it',{skip:!win},()=>{
 const root=fixture(),bridge=path.join(root,'bridge'),release=path.join(root,'scripts/desktop-binaries/win-x64');fs.mkdirSync(bridge);fs.mkdirSync(release,{recursive:true});fs.writeFileSync(path.join(release,'codex-fleet-desktop.exe'),'signed-fixture');
 assert.match(ps(root,`function Get-FleetDesktopPolicy {return [pscustomobject]@{requiresSignedRelease=$true}}
function Get-FleetDesktopSignature {return [pscustomobject]@{status='Valid';thumbprint='publisher-fixture'}}
$bridge=${q(bridge)};$release=${q(release)};$source=${q(path.join(root,'scripts/DesktopBridgeLauncher.cs'))}
$entry=@{name='codex-fleet-desktop.exe';sourceSha256=(Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant();sha256=(Get-FileHash (Join-Path $release 'codex-fleet-desktop.exe') -Algorithm SHA256).Hash.ToLowerInvariant();signerThumbprint='publisher-fixture'}
Write-FleetJson (Join-Path $release 'manifest.json') @{schemaVersion=1;files=@($entry)}
$null=Initialize-FleetDesktopBinary $bridge bridge
$null=Initialize-FleetDesktopBinary $bridge bridge
if(@(Get-ChildItem $bridge -Filter '*.backup-*').Count){throw 'Unchanged signed file was needlessly replaced'}
[IO.File]::WriteAllText((Join-Path $release 'codex-fleet-desktop.exe'),'tampered')
$failed=$false;try{Initialize-FleetDesktopBinary $bridge bridge}catch{$failed=$true;if((Get-FleetDesktopTrustFailure $_) -ne 'DESKTOP_SIGNATURE_INVALID'){throw}}
if(!$failed){throw 'Tampering was accepted'}
Write-Output 'PASS'
`),/PASS/);
 assert.equal(fs.readFileSync(path.join(bridge,'codex-fleet-desktop.exe'),'utf8'),'signed-fixture');
});

test('an existing signed launcher without a matching new publisher release is never locally rebuilt',{skip:!win},()=>{
 const root=fixture(),bridge=path.join(root,'bridge');fs.mkdirSync(bridge);fs.writeFileSync(path.join(bridge,'codex-fleet-desktop.exe'),'installed-signed');
 assert.match(ps(root,`function Get-FleetDesktopPolicy {return [pscustomobject]@{requiresSignedRelease=$false}}
function Get-FleetDesktopSignature {return [pscustomobject]@{status='Valid';thumbprint='publisher-fixture'}}
$failed=$false;try{Initialize-FleetDesktopBinary ${q(bridge)} bridge}catch{$failed=$true;if((Get-FleetDesktopTrustFailure $_) -ne 'DESKTOP_SIGNED_RELEASE_REQUIRED'){throw}}
if(!$failed){throw 'Signed launcher was replaced by a development build'}
Write-Output 'PASS'
`),/PASS/);
 assert.equal(fs.readFileSync(path.join(bridge,'codex-fleet-desktop.exe'),'utf8'),'installed-signed');
});

test('an invalid or untrusted existing signature is never treated as an unsigned permitted build',{skip:!win},()=>{
 const root=fixture(),exe=path.join(root,'untrusted.exe');fs.writeFileSync(exe,'fixture');
 assert.match(ps(root,`function Get-FleetDesktopPolicy {return [pscustomobject]@{requiresSignedRelease=$false}}
foreach($state in @('HashMismatch','NotTrusted','NotTimeValid','UnknownError')){
 $script:signatureState=$state
 function Get-FleetDesktopSignature {return [pscustomobject]@{status=$script:signatureState;thumbprint='untrusted-fixture'}}
 $failed=$false;try{Assert-FleetDesktopLauncherTrust ${q(exe)}}catch{$failed=$true;if((Get-FleetDesktopTrustFailure $_) -ne 'DESKTOP_SIGNATURE_INVALID'){throw}}
 if(!$failed){throw 'Invalid signature was accepted'}
}
Write-Output 'PASS'`),/PASS/);
});

test('startup trust failure is recorded before any maintenance lease or worker stop',{skip:!win},()=>{
 const root=fixture();fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'desktop-bridge'));fs.writeFileSync(path.join(root,'config/node.json'),JSON.stringify({dataDir:path.join(root,'data')}));fs.writeFileSync(path.join(root,'desktop-bridge/codex-fleet-desktop.exe'),'unsigned');fs.copyFileSync(path.join(scripts,'Start-FleetDesktop.ps1'),path.join(root,'scripts/Start-FleetDesktop.ps1'));
 fs.writeFileSync(path.join(root,'scripts/Windows-Desktop.ps1'),`. (Join-Path $PSScriptRoot 'Windows-DesktopTrust.ps1')\nfunction Get-FleetDesktopPolicy {return [pscustomobject]@{requiresSignedRelease=$true}}\nfunction Get-FleetDesktopSignature {return [pscustomobject]@{status='NotSigned';thumbprint=$null}}\n`);
 fs.writeFileSync(path.join(root,'scripts/Start-Fleet.ps1'),"param($InstallDir,$Role)\nWrite-Output 'Existing worker checked'");fs.writeFileSync(path.join(root,'scripts/Stop-Fleet.ps1'),"throw 'MUST NOT STOP'");
 assert.match(ps(root,`$failed=$false;try{& ${q(path.join(root,'scripts/Start-FleetDesktop.ps1'))} -InstallDir ${q(root)}}catch{$failed=$true;if((Get-FleetDesktopTrustFailure $_) -ne 'DESKTOP_TRUST_REQUIRED'){throw}}
if(!$failed){throw 'Missing expected trust failure'}
Write-Output 'PASS'`),/PASS/);
 const report=JSON.parse(fs.readFileSync(path.join(root,'desktop-bridge/launch-status.json')));assert.equal(report.stage,'trust_preflight');assert.equal(report.errorCode,'DESKTOP_TRUST_REQUIRED');assert.equal(report.recovery,'node_start_checked');
});

test('a strict release build refuses a package without signed launchers before creating output',{skip:!win},()=>{
 const root=fixture(),output=path.join(root,'not-created');fs.copyFileSync(path.join(scripts,'Build-Package.ps1'),path.join(root,'scripts/Build-Package.ps1'));
 assert.match(ps(root,`$failed=$false;try{& ${q(path.join(root,'scripts/Build-Package.ps1'))} -RequireSignedDesktop -OutputDirectory ${q(output)}}catch{$failed=$true;if($_.Exception.Message -notlike '*signed desktop release is required*'){throw}}
if(!$failed){throw 'Unsigned release was accepted'}
Write-Output 'PASS'`),/PASS/);
 assert.equal(fs.existsSync(output),false);
});

test('desktop preparation failure persists a public launch error and keeps original binaries and config',{skip:!win},()=>{
 const root=fixture(),bridge=path.join(root,'desktop-bridge');fs.mkdirSync(bridge);fs.mkdirSync(path.join(root,'config'));
 const config=JSON.stringify({codexPath:'unused-fixture'});fs.writeFileSync(path.join(root,'config/node.json'),config);fs.writeFileSync(path.join(bridge,'codex-fleet-desktop.exe'),'original');
 fs.copyFileSync(path.join(scripts,'Prepare-DesktopBridge.ps1'),path.join(root,'scripts/Prepare-DesktopBridge.ps1'));
 fs.writeFileSync(path.join(root,'scripts/Windows-Desktop.ps1'),`. (Join-Path $PSScriptRoot 'Windows-DesktopTrust.ps1')\nfunction Get-FleetDesktopPolicy {return [pscustomobject]@{requiresSignedRelease=$true}}\nfunction Get-FleetDesktopSignature {return [pscustomobject]@{status='NotSigned';thumbprint=$null}}\nfunction Protect-FleetDirectory {param($Path)}\n`);
 assert.match(ps(root,`$failed=$false;try{& ${q(path.join(root,'scripts/Prepare-DesktopBridge.ps1'))} -InstallDir ${q(root)}}catch{$failed=$true;if((Get-FleetDesktopTrustFailure $_) -ne 'DESKTOP_TRUST_REQUIRED'){throw}}
if(!$failed){throw 'Preparation unexpectedly succeeded'}
Write-Output 'PASS'`),/PASS/);
 for(const name of ['preparation-status.json','launch-status.json']){const state=JSON.parse(fs.readFileSync(path.join(bridge,name)));assert.equal(state.state,'failed');assert.equal(state.stage,'prepare_trust');assert.equal(state.errorCode,'DESKTOP_TRUST_REQUIRED');}
 assert.equal(fs.readFileSync(path.join(root,'config/node.json'),'utf8'),config);assert.equal(fs.readFileSync(path.join(bridge,'codex-fleet-desktop.exe'),'utf8'),'original');
});
