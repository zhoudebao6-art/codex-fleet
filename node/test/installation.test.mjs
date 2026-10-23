import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo=fileURLToPath(new URL('..',import.meta.url)),windows={skip:process.platform!=='win32'};
const baseEnv={...process.env,TEMP:'D:\\codex+\\temp',TMP:'D:\\codex+\\temp',TMPDIR:'D:\\codex+\\temp',PSModuleAnalysisCachePath:'D:\\codex+\\cache\\powershell\\ModuleAnalysisCache'};
for(const key of Object.keys(baseEnv))if(key.toLowerCase()==='psmodulepath')delete baseEnv[key];
function ps(file,args=[],env={}){
  // A detached Windows worker can retain the parent's inherited pipe handles;
  // use log files so waiting for the installer does not also wait for the worker.
  const log=path.join('D:/codex+/temp','fleet-install-ps-'+crypto.randomUUID()),out=fs.openSync(log+'.out','w'),err=fs.openSync(log+'.err','w');let failure;
  try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],{windowsHide:true,timeout:120000,env:{...baseEnv,...env},stdio:['ignore',out,err]});}catch(e){failure=e;}finally{fs.closeSync(out);fs.closeSync(err);}
  const output=fs.readFileSync(log+'.out','utf8'),error=fs.readFileSync(log+'.err','utf8');if(failure)throw Error(output+'\n'+error+'\n'+failure.message);return output;
}
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(path.join(dir,x.name)):[path.join(dir,x.name)]);
const fakeCli=String.raw`import fs from 'node:fs';import path from 'node:path';
const command=process.argv[2],arg=k=>process.argv[process.argv.indexOf('--'+k)+1];
if(command==='probe'){console.log(JSON.stringify({authenticated:true}));process.exit(0);}
if(command!=='enroll')throw Error('Unexpected test CLI command');
const file=arg('config'),old=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null,invite=JSON.parse(fs.readFileSync(arg('invite')));
const value={...old,nodeId:old?.nodeId||'new-test-node',nodeToken:old?.nodeToken||'test-identity-token',enrollmentState:'enrolling',hubUrl:invite.hubUrl,dataDir:arg('data'),codexPath:arg('codex'),projects:JSON.parse(fs.readFileSync(arg('projects')))};
fs.writeFileSync(file,JSON.stringify(value));
if(process.env.FLEET_TEST_ENROLL_FAIL==='1'){console.error('Simulated disconnected enrollment');process.exit(1);}
value.enrollmentState='enrolled';value.name=invite.name;fs.writeFileSync(file,JSON.stringify(value));console.log(JSON.stringify({nodeId:value.nodeId,name:value.name}));`;
const fakeWorker=String.raw`import fs from 'node:fs';import path from 'node:path';
const cfg=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config')+1]));
fs.writeFileSync(path.join(cfg.dataDir,'test-heartbeat.json'),JSON.stringify({nodeId:cfg.nodeId,enrollmentState:cfg.enrollmentState}));
const timer=setInterval(()=>{if(fs.existsSync(path.join(cfg.dataDir,'stop.request'))){clearInterval(timer);process.exit(0);}},100);`;
const fakePowerAgent=String.raw`import fs from 'node:fs';import path from 'node:path';
const cfg=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config')+1]));
const dir=path.join(cfg.dataDir,'power');
fs.appendFileSync(path.join(dir,'test-launches.ndjson'),JSON.stringify({pid:process.pid,nodeId:cfg.nodeId})+'\n');
const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'stop.request'))){clearInterval(timer);fs.writeFileSync(path.join(dir,'test-stopped.json'),JSON.stringify({pid:process.pid}));process.exit(0);}},100);`;
function fixture(t,{startup='disabled',power=false}={}){
  const root=fs.mkdtempSync('D:/codex+/temp/fleet-install-test-'),pkg=path.join(root,'package'),install=path.join(root,'installed'),home=path.join(root,'codex-home');
  for(const d of ['src','scripts','skills/codex-fleet','docs','runtime'])fs.mkdirSync(path.join(pkg,d),{recursive:true});
  fs.mkdirSync(path.join(home,'skills','other'),{recursive:true});fs.writeFileSync(path.join(home,'skills','other','SKILL.md'),'preserve other skills');fs.writeFileSync(path.join(home,'auth.json'),'test-login-sentinel');fs.writeFileSync(path.join(home,'config.toml'),'# preserve other MCP configuration');
  for(const file of ['Install.ps1','Install-Sites.ps1'])fs.copyFileSync(path.join(repo,file),path.join(pkg,file));
  for(const file of ['Windows-Common.ps1','Windows-Install.ps1','Windows-Startup.ps1','Start-Fleet.ps1','Stop-Fleet.ps1','Complete-Enrollment.ps1'])fs.copyFileSync(path.join(repo,'scripts',file),path.join(pkg,'scripts',file));
  fs.writeFileSync(path.join(pkg,'src','cli.mjs'),fakeCli);fs.writeFileSync(path.join(pkg,'src','worker.mjs'),fakeWorker);
  if(power){fs.copyFileSync(path.join(repo,'scripts/Start-FleetPower.ps1'),path.join(pkg,'scripts/Start-FleetPower.ps1'));fs.writeFileSync(path.join(pkg,'src/power-agent.mjs'),fakePowerAgent);}
  fs.writeFileSync(path.join(pkg,'skills/codex-fleet/SKILL.md'),'fixture fleet skill');fs.writeFileSync(path.join(pkg,'docs/guide.md'),'fixture');fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'0.3.6'}));
  try{fs.linkSync(process.execPath,path.join(pkg,'runtime','node.exe'));}catch(error){if(error.code!=='EXDEV')throw error;fs.copyFileSync(process.execPath,path.join(pkg,'runtime','node.exe'));}
  fs.writeFileSync(path.join(pkg,'runtime','LICENSE'),'fixture');
  const codex=path.join(root,'codex.cmd');fs.writeFileSync(codex,'@echo off\r\necho []\r\n');
  const invite=path.join(root,'PC-NEW.invite.json');fs.writeFileSync(invite,JSON.stringify({hubUrl:'https://fleet.example.test',name:'PC-NEW',token:'test-invitation'}));
  const env={CODEX_HOME:home};
  if(startup!=='disabled')fs.appendFileSync(path.join(pkg,'scripts','Windows-Startup.ps1'),String.raw`
function Get-FleetStartupRegistration { return $null }
function New-ScheduledTaskAction { return @{} }
function New-ScheduledTaskTrigger { return @{} }
function New-ScheduledTaskPrincipal { return @{} }
function New-ScheduledTaskSettingsSet { return @{} }
function Register-ScheduledTask { throw 'Test task scheduler denied' }
function New-FleetStartupShortcut { param($InstallDir,$Role,$Arguments)
 if($env:FLEET_TEST_STARTUP_FAIL -eq '1'){throw 'Test startup folder denied'}
 [IO.File]::WriteAllText((Join-Path $InstallDir 'test-startup-arguments.txt'),$Arguments)
 return @{method='user-startup';enabled=$true;retained=$false}
}
`);
  const seal=()=>fs.writeFileSync(path.join(pkg,'manifest.json'),JSON.stringify({name:'codex-fleet',version:'0.3.6',platform:'windows-x64',files:walk(pkg).filter(f=>!f.endsWith('manifest.json')).map(f=>({path:path.relative(pkg,f).replaceAll('\\','/'),sha256:digest(f),bytes:fs.statSync(f).size}))}));seal();
  const config=path.join(install,'config/node.json'),options=['-InstallDir',install,'-Invitation',invite,'-CodexPath',codex,'-NoMcp','-NoShortcut',...(startup==='disabled'?['-NoStartup']:[])];
  t.after(async()=>{
    const powerDir=path.join(install,'data/node/power');
    if(fs.existsSync(path.join(powerDir,'service.json'))){
      fs.writeFileSync(path.join(powerDir,'stop.request'),'test cleanup');
      for(let i=0;i<50&&!fs.existsSync(path.join(powerDir,'test-stopped.json'));i++)await new Promise(resolve=>setTimeout(resolve,100));
      assert.ok(fs.existsSync(path.join(powerDir,'test-stopped.json')),'isolated power helper must stop normally');
    }
    if(fs.existsSync(path.join(install,'data/node/service.json')))ps(path.join(pkg,'scripts','Stop-Fleet.ps1'),['-InstallDir',install],env);
  });
  return {root,pkg,install,home,invite,config,env,seal,run(extra=[],vars={}){return ps(path.join(pkg,'Install-Sites.ps1'),[...options,...extra],{...env,...vars});},pending(){for(const d of ['config','data/node','workspace','app/scripts','runtime'])fs.mkdirSync(path.join(install,d),{recursive:true});for(const f of ['Start-Fleet.ps1','Stop-Fleet.ps1','Windows-Common.ps1'])fs.copyFileSync(path.join(pkg,'scripts',f),path.join(install,'app/scripts',f));fs.copyFileSync(process.execPath,path.join(install,'runtime/node.exe'));const cfg={nodeId:'original-pending-id',nodeToken:'original-private-token',name:'local-pending',enrollmentState:'pending',hubUrl:null,dataDir:path.join(install,'data/node'),codexPath:codex,codexHome:home,projects:{workspace:{root:path.join(install,'workspace'),sandbox:'read-only',custom:'retain'},other:{root:root,sandbox:'read-only'}}};fs.writeFileSync(config,JSON.stringify(cfg));fs.writeFileSync(path.join(install,'data/node/retained.bin'),'retain data');return cfg;}};
}

test('new Sites install with explicit invitation copies version metadata and preserves login/other integrations',windows,t=>{
  const f=fixture(t),before=['auth.json','config.toml','skills/other/SKILL.md'].map(x=>digest(path.join(f.home,x)));
  f.run();assert.equal(JSON.parse(fs.readFileSync(path.join(f.install,'app/package.json'))).version,'0.3.6');
  assert.equal(JSON.parse(fs.readFileSync(f.config)).enrollmentState,'enrolled');assert.equal(JSON.parse(fs.readFileSync(path.join(f.install,'data/node/test-heartbeat.json'))).nodeId,'new-test-node');
  assert.deepEqual(['auth.json','config.toml','skills/other/SKILL.md'].map(x=>digest(path.join(f.home,x))),before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.install,'config/installation-node.json'))).state,'installed');
});

test('new node with desktop signing requirement still enrolls and starts without changing login',windows,t=>{
  const f=fixture(t),before=digest(path.join(f.home,'auth.json'));
  for(const name of ['Inspect-FleetDesktopTrust.ps1','Windows-DesktopTrust.ps1'])fs.copyFileSync(path.join(repo,'scripts',name),path.join(f.pkg,'scripts',name));
  fs.appendFileSync(path.join(f.pkg,'scripts/Windows-DesktopTrust.ps1'),"\nfunction Get-FleetDesktopPolicy {return [pscustomobject]@{requiresSignedRelease=$true}}\n");f.seal();
  f.run();
  assert.equal(JSON.parse(fs.readFileSync(f.config)).enrollmentState,'enrolled');
  const worker=JSON.parse(fs.readFileSync(path.join(f.install,'data/node/service.json')));process.kill(worker.pid,0);
  assert.equal(fs.existsSync(path.join(f.install,'data/node/stop.request')),false);assert.equal(digest(path.join(f.home,'auth.json')),before);
  const report=JSON.parse(fs.readFileSync(path.join(f.install,'desktop-bridge/trust-status.json')));assert.equal(report.errorCode,'DESKTOP_SIGNED_RELEASE_REQUIRED');assert.equal(report.state,'failed');
});
test('new Sites installation starts the bundled power companion and repeat startup keeps both process identities',windows,t=>{
  const f=fixture(t,{power:true,startup:'fallback'});
  const before=['auth.json','config.toml','skills/other/SKILL.md'].map(x=>digest(path.join(f.home,x)));
  f.run();
  const dir=path.join(f.install,'data/node'),powerRecord=path.join(dir,'power/service.json'),workerRecord=path.join(dir,'service.json');
  const power=JSON.parse(fs.readFileSync(powerRecord)),worker=JSON.parse(fs.readFileSync(workerRecord));
  assert.notEqual(power.pid,worker.pid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'power/test-launches.ndjson'),'utf8').trim()).nodeId,'new-test-node');
  ps(path.join(f.install,'app/scripts/Start-Fleet.ps1'),['-InstallDir',f.install],f.env);
  assert.deepEqual(JSON.parse(fs.readFileSync(powerRecord)),power);
  assert.deepEqual(JSON.parse(fs.readFileSync(workerRecord)),worker);
  assert.equal(fs.readFileSync(path.join(dir,'power/test-launches.ndjson'),'utf8').trim().split('\n').length,1);
  assert.deepEqual(['auth.json','config.toml','skills/other/SKILL.md'].map(x=>digest(path.join(f.home,x))),before);
  assert.match(fs.readFileSync(path.join(f.install,'test-startup-arguments.txt'),'utf8'),/Start-Fleet\.ps1/);
});
test('power companion waits for enrollment and honours NoStart before normal startup',windows,t=>{
  const f=fixture(t,{power:true});f.pending();
  ps(path.join(f.pkg,'scripts/Start-FleetPower.ps1'),['-InstallDir',f.install],f.env);
  assert.ok(!fs.existsSync(path.join(f.install,'data/node/power/service.json')));
  f.run(['-NoStart']);
  assert.ok(!fs.existsSync(path.join(f.install,'data/node/power/service.json')));
  assert.ok(!fs.existsSync(path.join(f.install,'data/node/service.json')));
  ps(path.join(f.install,'app/scripts/Start-Fleet.ps1'),['-InstallDir',f.install],f.env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.install,'data/node/power/test-launches.ndjson'),'utf8').trim()).nodeId,'original-pending-id');
});
test('pending original identity, data and exact project sandbox survive Sites enrollment',windows,t=>{
  const f=fixture(t),before=f.pending();f.run(['-NoStart']);const after=JSON.parse(fs.readFileSync(f.config));
  assert.equal(after.nodeId,before.nodeId);assert.equal(after.nodeToken,before.nodeToken);assert.deepEqual(after.projects,before.projects);assert.equal(fs.readFileSync(path.join(f.install,'data/node/retained.bin'),'utf8'),'retain data');
});
test('enrolled same-site upgrade/new code and different-site attempts reject before changing identity or stopping worker',windows,t=>{
  const f=fixture(t);f.run();const hash=digest(f.config),service=digest(path.join(f.install,'data/node/service.json'));
  assert.throws(()=>f.run(),/already enrolled at this site/);
  fs.writeFileSync(f.invite,JSON.stringify({hubUrl:'https://fleet.example.test',name:'PC-OTHER'}));assert.throws(()=>f.run(),/different device code/);
  fs.writeFileSync(f.invite,JSON.stringify({hubUrl:'https://other.example.test',name:'PC-NEW'}));assert.throws(()=>f.run(),/belongs to another hub/);
  assert.equal(digest(f.config),hash);assert.equal(digest(path.join(f.install,'data/node/service.json')),service);assert.ok(!fs.existsSync(path.join(f.install,'data/node/stop.request')));
});
test('failed enrollment keeps generated identity and recoverable phase; same invitation completion reuses it',windows,t=>{
  const f=fixture(t);assert.throws(()=>f.run(['-NoStart'],{FLEET_TEST_ENROLL_FAIL:'1'}),/Enrollment failed/);const before=JSON.parse(fs.readFileSync(f.config));
  assert.equal(before.enrollmentState,'enrolling');assert.equal(JSON.parse(fs.readFileSync(path.join(f.install,'config/installation-node.json'))).phase,'enrollment');
  f.run();const after=JSON.parse(fs.readFileSync(f.config));assert.equal(after.nodeId,before.nodeId);assert.equal(after.nodeToken,before.nodeToken);assert.equal(after.enrollmentState,'enrolled');
});
test('failed pending enrollment restarts only the original managed node and retains its new retry binding',windows,t=>{
  const f=fixture(t),before=f.pending();fs.mkdirSync(path.join(f.install,'app/src'),{recursive:true});fs.writeFileSync(path.join(f.install,'app/src/worker.mjs'),fakeWorker);
  ps(path.join(f.pkg,'scripts/Start-Fleet.ps1'),['-InstallDir',f.install],f.env);const prior=JSON.parse(fs.readFileSync(path.join(f.install,'data/node/service.json')));
  assert.throws(()=>f.run([],{FLEET_TEST_ENROLL_FAIL:'1'}),/Enrollment failed/);
  const after=JSON.parse(fs.readFileSync(f.config)),current=JSON.parse(fs.readFileSync(path.join(f.install,'data/node/service.json')));
  assert.equal(after.nodeId,before.nodeId);assert.equal(after.nodeToken,before.nodeToken);assert.equal(after.enrollmentState,'enrolling');assert.equal(after.hubUrl,'https://fleet.example.test');assert.notEqual(current.pid,prior.pid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.install,'data/node/test-heartbeat.json'))).enrollmentState,'enrolling');
});
test('scheduler rejection uses hidden current-user fallback and still starts the actual isolated worker',windows,t=>{
  const f=fixture(t,{startup:'fallback'});f.run();const state=JSON.parse(fs.readFileSync(path.join(f.install,'config/installed-node.json')));
  assert.equal(state.startup,true);assert.equal(state.startupMethod,'user-startup');assert.match(fs.readFileSync(path.join(f.install,'test-startup-arguments.txt'),'utf8'),/-NonInteractive -WindowStyle Hidden/);assert.ok(fs.existsSync(path.join(f.install,'data/node/test-heartbeat.json')));
});
test('both startup registrations denied report no autostart while current-session worker really starts',windows,t=>{
  const f=fixture(t,{startup:'fallback'}),output=f.run([],{FLEET_TEST_STARTUP_FAIL:'1'});const state=JSON.parse(fs.readFileSync(path.join(f.install,'config/installed-node.json')));
  assert.match(output,/automatic startup at next logon is not configured/i);assert.equal(state.startup,false);assert.equal(state.startupMethod,'none');assert.ok(fs.existsSync(path.join(f.install,'data/node/test-heartbeat.json')));
});
test('startup helper retains existing valid mechanism and never creates duplicate registration',windows,()=>{
  const root=fs.mkdtempSync('D:/codex+/temp/fleet-startup-test-'),file=path.join(root,'test.ps1');
  fs.writeFileSync(file,String.raw`param([string]$Root)
. (Join-Path $Root 'scripts\Windows-Common.ps1')
. (Join-Path $Root 'scripts\Windows-Startup.ps1')
function Get-FleetStartupRegistration { return @{method=$script:Method;enabled=$script:Enabled;retained=$true} }
function Register-ScheduledTask { throw 'Must not register duplicates' }
function New-FleetStartupShortcut { throw 'Must not create duplicates' }
foreach($method in @('scheduled-task','user-run','user-startup')){
 $script:Method=$method;$script:Enabled=$true;$value=Register-FleetStartup 'D:\Fleet Fixture' 'Node'
 if(!$value.retained -or !$value.enabled -or $value.method -ne $method){throw 'Existing startup was not retained'}
}
$script:Enabled=$false;$value=Register-FleetStartup 'D:\Fleet Fixture' 'Node';if($value.enabled){throw 'Disabled startup was misreported'}
if(!(Test-FleetStartupCommand 'powershell -File "D:\Fleet Fixture\app\scripts\Start-Fleet.ps1" -InstallDir "D:\Fleet Fixture" -Role Node -Wait' 'D:\Fleet Fixture' 'Node')){throw 'Valid command not matched'}
if(Test-FleetStartupCommand 'powershell -File "D:\Other\app\scripts\Start-Fleet.ps1" -InstallDir "D:\Other" -Role Node' 'D:\Fleet Fixture' 'Node'){throw 'Foreign command matched'}
if(Test-FleetStartupCommand 'powershell -File "D:\Fleet Fixture\app\scripts\Start-Fleet.ps1" -InstallDir "D:\Other" -Role Node' 'D:\Fleet Fixture' 'Node'){throw 'Foreign install argument matched'}
if(!(Test-FleetStartupCommand 'powershell -File "D:\Fleet Fixture\app\scripts\Start-Fleet.ps1" -InstallDir "D:\Fleet Fixture"' 'D:\Fleet Fixture' 'Node')){throw 'Default node role was not recognized'}
'retained'
`);assert.match(ps(file,['-Root',repo]),/retained/);
});
test('managed fallback disable only renames its owned shortcut in an isolated folder',windows,()=>{
  const root=fs.mkdtempSync('D:/codex+/temp/fleet-shortcut-test-'),file=path.join(root,'test.ps1');
  fs.writeFileSync(file,String.raw`param([string]$Root,[string]$Fixture)
. (Join-Path $Root 'scripts\Windows-Common.ps1')
. (Join-Path $Root 'scripts\Windows-Startup.ps1')
$install='D:\Fleet Fixture';$name=(Get-FleetTaskName $install 'node')+'.lnk';$target=Join-Path $Fixture $name
$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($target)
$link.TargetPath=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$link.Arguments='-NoProfile -WindowStyle Hidden -File "D:\Fleet Fixture\app\scripts\Start-Fleet.ps1" -InstallDir "D:\Other" -Role Node';$link.Save()
$rejected=$false;try{Disable-FleetStartupShortcut $install 'Node' $Fixture}catch{$rejected=$true}
if(!$rejected -or !(Test-Path -LiteralPath $target)){throw 'Foreign startup was modified'}
$link=$shell.CreateShortcut($target);$link.Arguments='-NoProfile -WindowStyle Hidden -File "D:\Fleet Fixture\app\scripts\Start-Fleet.ps1" -InstallDir "D:\Fleet Fixture" -Role Node';$link.Save()
if(!(Disable-FleetStartupShortcut $install 'Node' $Fixture)){throw 'Owned shortcut was not disabled'}
if(Test-Path -LiteralPath $target){throw 'Shortcut remains active'}
if(@(Get-ChildItem -LiteralPath $Fixture -Filter ($name+'.disabled-*')).Count -ne 1){throw 'Recoverable shortcut was not retained'}
if(Disable-FleetStartupShortcut $install 'Node' $Fixture){throw 'Repeated disable misreported a change'}
'isolated shortcut preserved'
`);assert.match(ps(file,['-Root',repo,'-Fixture',root]),/isolated shortcut preserved/);
});
test('startup inspection denial stays unverified and never adds a second launcher',windows,()=>{
  const root=fs.mkdtempSync('D:/codex+/temp/fleet-startup-denied-test-'),file=path.join(root,'test.ps1');
  fs.writeFileSync(file,String.raw`param([string]$Root)
. (Join-Path $Root 'scripts\Windows-Common.ps1')
. (Join-Path $Root 'scripts\Windows-Startup.ps1')
function Get-ScheduledTask { [CmdletBinding()]param($TaskName) Write-Error 'Test permission denied' -Category PermissionDenied -ErrorId 'TestStartupDenied' }
$script:Writes=0
function Register-ScheduledTask { $script:Writes++;throw 'Unexpected registration' }
function New-FleetStartupShortcut { $script:Writes++;throw 'Unexpected fallback' }
$result=Register-FleetStartup 'D:\Fleet Fixture' 'Node'
if($result.method -ne 'unverified' -or $result.enabled -or $script:Writes -ne 0){throw 'Unknown registration was treated as missing'}
'denied enumeration retained'
`);assert.match(ps(file,['-Root',repo]),/denied enumeration retained/);
});
test('missing D drive fails before cache environment changes or installation writes',windows,()=>{
  const root=fs.mkdtempSync('D:/codex+/temp/fleet-no-drive-test-'),file=path.join(root,'test.ps1');
  fs.writeFileSync(file,String.raw`param([string]$Root)
$tokens=$null;$errors=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Root 'scripts\Windows-Common.ps1'),[ref]$tokens,[ref]$errors)
foreach($name in @('Assert-FleetCacheDrive','Initialize-FleetPowerShell')){$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);. ([ScriptBlock]::Create($fn.Extent.Text))}
$script:RealDriveCheck=(Get-Item Function:\Assert-FleetCacheDrive).ScriptBlock
function Assert-FleetCacheDrive { & $script:RealDriveCheck ('D:\codex+\temp\missing-drive-'+[guid]::NewGuid().ToString('N')) }
$old=$env:PSModuleAnalysisCachePath;$message=$null
try{Initialize-FleetPowerShell}catch{$message=$_.Exception.Message}
if(!$message -or $message -notmatch 'requires an available D: drive'){throw 'Missing clear storage failure'}
if($env:PSModuleAnalysisCachePath -ne $old){throw 'Environment changed before missing-drive refusal'}
'no drive correctly rejected'
`);assert.match(ps(file,['-Root',repo]),/correctly rejected/);
});
