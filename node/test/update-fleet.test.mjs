import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {LocalStore} from '../src/local-store.mjs';
import {launchUpgradeQueue} from '../src/node-updater.mjs';
import {setTimeout as sleep} from 'node:timers/promises';

const repository=fileURLToPath(new URL('..',import.meta.url));
const inheritedModulePath=Object.entries(process.env).find(([key])=>key.toLowerCase()==='psmodulepath')?.[1]||'';
const env={...process.env,TEMP:'D:/codex+/temp',TMP:'D:/codex+/temp',TMPDIR:'D:/codex+/temp',PSModuleAnalysisCachePath:'D:/codex+/cache/powershell/ModuleAnalysisCache'};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
const pwsh=(file,args=[],{shell='powershell.exe',environment=env}={})=>{const out=path.join('D:/codex+/temp','fleet-ps-'+crypto.randomUUID()),err=out+'.err',ofd=fs.openSync(out,'w'),efd=fs.openSync(err,'w');let failure;try{execFileSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',file,...args],{encoding:'utf8',windowsHide:true,timeout:120000,env:environment,stdio:['ignore',ofd,efd]});}catch(e){failure=e;}finally{fs.closeSync(ofd);fs.closeSync(efd);}const output=fs.readFileSync(out,'utf8'),error=fs.readFileSync(err,'utf8');if(failure)throw new Error(output+'\n'+error+'\n'+failure.message);return output;};
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const worker=`import fs from 'node:fs';import path from 'node:path';const c=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config')+1]));const t=setInterval(()=>{if(fs.existsSync(path.join(c.dataDir,'stop.request'))){clearInterval(t);process.exit(0);}},100);`;
const client=`export class FleetClient{constructor(config){this.config=config;}api(route,{body}={}){if(route.startsWith('/v1/tasks/page?'))return Promise.resolve({total:0,tasks:[],nextCursor:null,serverTime:new Date().toISOString()});if(route!=='/v1/node/maintenance')throw new Error('Unexpected route');return Promise.resolve({enabled:body.enabled,expiresAt:body.expiresAt});}tasks(){throw Error('History cannot prove idle');}close(){}}`;
function list(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?list(path.join(dir,x.name)):[path.join(dir,x.name)]);}
function fixture(){
  const dir=fs.mkdtempSync(path.join('D:/codex+/temp','fleet-upgrade-test-')),installed=path.join(dir,'installed'),release=path.join(dir,'release'),pkg=path.join(release,'codex-fleet-0.3.0-windows-x64');
  for(const base of [path.join(installed,'app'),pkg]){for(const part of ['src','scripts','skills/codex-fleet','docs'])fs.mkdirSync(path.join(base,part),{recursive:true});for(const f of ['Windows-Common.ps1','Idle-WorkerRecovery.ps1','Start-Fleet.ps1','Stop-Fleet.ps1','Recover-FleetUpgrade.ps1','backup-sqlite.mjs','Update-Fleet.ps1','upgrade-guard.mjs','active-task-proof.mjs'])fs.copyFileSync(path.join(repository,'scripts',f),path.join(base,'scripts',f));fs.writeFileSync(path.join(base,'src','worker.mjs'),worker);fs.writeFileSync(path.join(base,'src','client.mjs'),client);fs.writeFileSync(path.join(base,'skills/codex-fleet/SKILL.md'),'new skill');fs.writeFileSync(path.join(base,'docs/operations.md'),'fixture');fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({version:'0.3.0'}));}
  for(const part of ['config','data/node','runtime','codex-home/skills/codex-fleet'])fs.mkdirSync(path.join(installed,part),{recursive:true});
  try{fs.linkSync(process.execPath,path.join(installed,'runtime','node.exe'));}catch(e){if(e.code!=='EXDEV')throw e;fs.copyFileSync(process.execPath,path.join(installed,'runtime','node.exe'));}
  const cfg={nodeId:'fixture-node',name:'FIXTURE',hubUrl:'http://127.0.0.1:1',nodeToken:'fixture-not-secret',dataDir:path.join(installed,'data/node'),codexHome:path.join(installed,'codex-home'),projects:{workspace:{root:dir}},enrollmentState:'enrolled'};fs.writeFileSync(path.join(installed,'config/node.json'),JSON.stringify(cfg));fs.writeFileSync(path.join(installed,'codex-home/skills/codex-fleet/SKILL.md'),'old skill');const store=new LocalStore(cfg.dataDir);store.close();
  const pack=path.join(dir,'pack.ps1');fs.writeFileSync(pack,String.raw`param([string]$Source,[string]$Zip)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($Source,$Zip,[IO.Compression.CompressionLevel]::Optimal,$false)
`);
  return {dir,installed,pkg,release,cfg,build(){const files=list(pkg).filter(f=>!f.endsWith('manifest.json')).map(f=>({path:path.relative(pkg,f).replaceAll('\\','/'),sha256:digest(f),bytes:fs.statSync(f).size}));fs.writeFileSync(path.join(pkg,'manifest.json'),JSON.stringify({name:'codex-fleet',version:'0.3.0',platform:'windows-x64',files}));const zip=path.join(dir,crypto.randomUUID()+'.zip');pwsh(pack,['-Source',release,'-Zip',zip]);return {zip,sha:digest(zip)};},start(){return pwsh(path.join(installed,'app/scripts/Start-Fleet.ps1'),['-InstallDir',installed]);},stop(){return pwsh(path.join(installed,'app/scripts/Stop-Fleet.ps1'),['-InstallDir',installed]);}};
}

test('PowerShell 5.1 verifies a release and rejects wrong SHA without changing installation',{skip:process.platform!=='win32'},()=>{
  const f=fixture(),{zip,sha}=f.build(),old=digest(path.join(f.installed,'config/node.json'));
  const args=['-PackagePath',zip,'-Sha256',sha,'-InstallDir',f.installed,'-VerifyOnly'];
  assert.match(pwsh(path.join(repository,'scripts/Update-Fleet.ps1'),args),/Verified release 0.3.0/);assert.equal(digest(path.join(f.installed,'config/node.json')),old);assert.ok(!fs.existsSync(path.join(f.cfg.dataDir,'service.json')));
  assert.throws(()=>pwsh(path.join(repository,'scripts/Update-Fleet.ps1'),['-PackagePath',zip,'-Sha256','0'.repeat(64),'-InstallDir',f.installed,'-VerifyOnly']),/SHA256 mismatch/);
  assert.throws(()=>pwsh(path.join(repository,'scripts/Update-Fleet.ps1'),['-PackagePath',zip,'-Sha256',sha,'-ExpectedVersion','9.9.9','-InstallDir',f.installed,'-VerifyOnly']),/version does not match/);
});

test('PowerShell 5.1 upgrades a running isolated worker and preserves identity and SQLite',{skip:process.platform!=='win32'},()=>{
  const f=fixture();fs.writeFileSync(path.join(f.pkg,'src/release-marker.mjs'),'export const release=3;');const {zip,sha}=f.build(),before=digest(path.join(f.installed,'config/node.json'));f.start();fs.writeFileSync(path.join(f.installed,'app/scripts/Stop-Fleet.ps1'),"throw 'The old installed stop helper must not be used by this upgrade.'");
  try{const out=pwsh(path.join(repository,'scripts/Update-Fleet.ps1'),['-PackagePath',zip,'-Sha256',sha,'-InstallDir',f.installed,'-WaitForIdleSeconds','30']);assert.match(out,/completed/);assert.equal(digest(path.join(f.installed,'config/node.json')),before);assert.ok(fs.existsSync(path.join(f.installed,'app/src/release-marker.mjs')));const status=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'upgrade-status.json')));assert.equal(status.state,'completed');const backup=JSON.parse(fs.readFileSync(path.join(status.backup,'manifest.json')));assert.equal(backup.complete,true);assert.equal(backup.nodeId,'fixture-node');assert.equal(fs.readFileSync(path.join(f.installed,'codex-home/skills/codex-fleet/SKILL.md'),'utf8'),'new skill');}finally{f.stop();}
});

test('ordinary node upgrade records desktop trust blocker and restarts the worker without a stale stop request',{skip:process.platform!=='win32'},()=>{
  const f=fixture();
  for(const name of ['Inspect-FleetDesktopTrust.ps1','Windows-DesktopTrust.ps1'])fs.copyFileSync(path.join(repository,'scripts',name),path.join(f.pkg,'scripts',name));
  fs.appendFileSync(path.join(f.pkg,'scripts/Windows-DesktopTrust.ps1'),"\nfunction Get-FleetDesktopPolicy {return [pscustomobject]@{requiresSignedRelease=$true}}\nfunction Get-FleetDesktopSignature {return [pscustomobject]@{status='NotSigned';thumbprint=$null}}\n");
  fs.mkdirSync(path.join(f.installed,'desktop-bridge'));fs.writeFileSync(path.join(f.installed,'desktop-bridge/codex-fleet-desktop.exe'),'preserved-unsigned');
  const {zip,sha}=f.build(),hash=digest(path.join(f.installed,'config/node.json'));f.start();
  try{
    const before=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'service.json'))).pid;
    assert.match(pwsh(path.join(repository,'scripts/Update-Fleet.ps1'),['-PackagePath',zip,'-Sha256',sha,'-InstallDir',f.installed,'-WaitForIdleSeconds','30']),/completed/);
    const current=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'service.json')));process.kill(current.pid,0);assert.notEqual(current.pid,before);assert.equal(fs.existsSync(path.join(f.cfg.dataDir,'stop.request')),false);assert.equal(digest(path.join(f.installed,'config/node.json')),hash);
    const trust=JSON.parse(fs.readFileSync(path.join(f.installed,'desktop-bridge/trust-status.json')));assert.equal(trust.state,'failed');assert.equal(trust.errorCode,'DESKTOP_TRUST_REQUIRED');assert.equal(fs.readFileSync(path.join(f.installed,'desktop-bridge/codex-fleet-desktop.exe'),'utf8'),'preserved-unsigned');
  }finally{f.stop();}
});

test('PowerShell 5.1 rolls back app and skill if the replacement worker exits',{skip:process.platform!=='win32'},()=>{
  const f=fixture();fs.writeFileSync(path.join(f.pkg,'src/worker.mjs'),'process.exit(19);');const {zip,sha}=f.build(),before=digest(path.join(f.installed,'app/src/worker.mjs'));f.start();
  try{assert.throws(()=>pwsh(path.join(repository,'scripts/Update-Fleet.ps1'),['-PackagePath',zip,'-Sha256',sha,'-InstallDir',f.installed,'-WaitForIdleSeconds','30']));assert.equal(digest(path.join(f.installed,'app/src/worker.mjs')),before);const status=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'upgrade-status.json')));assert.equal(status.state,'failed');assert.equal(fs.readFileSync(path.join(f.installed,'codex-home/skills/codex-fleet/SKILL.md'),'utf8'),'old skill');const marker=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'service.json')));process.kill(marker.pid,0);}finally{f.stop();}
});

test('PowerShell 5.1 rejects a mismatched manifest even with the matching archive hash',{skip:process.platform!=='win32'},()=>{
  const f=fixture();f.build();const manifestFile=path.join(f.pkg,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));manifest.files[0].sha256='0'.repeat(64);fs.writeFileSync(manifestFile,JSON.stringify(manifest));const zip=path.join(f.dir,'bad-manifest.zip');pwsh(path.join(f.dir,'pack.ps1'),['-Source',f.release,'-Zip',zip]);assert.throws(()=>pwsh(path.join(repository,'scripts/Update-Fleet.ps1'),['-PackagePath',zip,'-Sha256',digest(zip),'-InstallDir',f.installed,'-VerifyOnly']),/Manifest integrity check failed/);assert.ok(!fs.existsSync(path.join(f.cfg.dataDir,'service.json')));
});

test('queued Windows PowerShell updater inherits a real pwsh 7 environment and waits for active work and outbox',{skip:process.platform!=='win32'},async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.pkg,'src/release-marker.mjs'),'export const release=3;');const {zip,sha}=f.build();f.start();const original=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'service.json'))).pid,store=new LocalStore(f.cfg.dataDir);store.add({id:'active-fixture',attempt:'a',spec:{}});store.update('active-fixture',{status:'running'});store.emit({type:'message',taskId:'active-fixture',text:'pending'});
  const shell=inheritedModulePath.split(path.delimiter).map(p=>path.join(path.dirname(p),'pwsh.exe')).find(p=>fs.existsSync(p))||'pwsh.exe',wrapper=path.join(f.dir,'queue-from-pwsh7.ps1');fs.writeFileSync(wrapper,"param([string]$PackagePath,[string]$Sha256,[string]$InstallDir)\nif($PSVersionTable.PSVersion.Major -lt 7){throw 'Regression requires the real pwsh 7 parent'}\nWrite-Host ('Parent edition: '+$PSVersionTable.PSEdition)\n& '"+path.join(repository,'scripts/Update-Fleet.ps1').replaceAll("'","''")+"' -PackagePath $PackagePath -Sha256 $Sha256 -InstallDir $InstallDir -WaitForIdleSeconds 60 -ActionId fixture-self-upgrade -Queue\n");
  try{const out=pwsh(wrapper,['-PackagePath',zip,'-Sha256',sha,'-InstallDir',f.installed],{shell,environment:{...env,PSModulePath:inheritedModulePath}});assert.match(out,/Parent edition: Core/);assert.match(out,/Upgrade queued/);const statusFile=path.join(f.cfg.dataDir,'upgrade-status.json');let status=null;for(let i=0;i<200;i++){if(fs.existsSync(statusFile)){status=JSON.parse(fs.readFileSync(statusFile));if(status.state==='waiting_for_idle')break;}await sleep(100);}assert.equal(status?.state,'waiting_for_idle');assert.equal(status.actionId,'fixture-self-upgrade');const receiptFile=path.join(f.cfg.dataDir,'upgrades/fixture-self-upgrade.queued.json'),receipt=JSON.parse(fs.readFileSync(receiptFile));assert.equal(receipt.actionId,'fixture-self-upgrade');const duplicate=pwsh(path.join(repository,'scripts/Update-Fleet.ps1'),['-PackagePath',zip,'-Sha256',sha,'-InstallDir',f.installed,'-ActionId','fixture-self-upgrade','-Queue']);assert.match(duplicate,/already queued/);assert.equal(JSON.parse(fs.readFileSync(receiptFile)).pid,receipt.pid);process.kill(original,0);assert.ok(!fs.existsSync(path.join(f.installed,'app/src/release-marker.mjs')));store.update('active-fixture',{status:'submitted'});store.db.exec('DELETE FROM outbox');for(let i=0;i<500;i++){status=JSON.parse(fs.readFileSync(statusFile));if(['completed','failed'].includes(status.state))break;await sleep(100);}assert.equal(status.state,'completed');assert.equal(JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'upgrades/fixture-self-upgrade.status.json'))).state,'completed');assert.ok(fs.existsSync(path.join(f.installed,'app/src/release-marker.mjs')));assert.notEqual(JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'service.json'))).pid,original);}finally{store.close();f.stop();}
});

test('real Node maintenance launcher executes PowerShell, queues once and completes after draining active work',{skip:process.platform!=='win32'},async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.pkg,'src/release-marker.mjs'),'export const realNodeLauncher=true;');
  const {zip,sha}=f.build(),configHash=digest(path.join(f.installed,'config/node.json'));f.start();
  const original=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'service.json'))).pid,store=new LocalStore(f.cfg.dataDir),id='real-node-launch-'+crypto.randomUUID();
  store.add({id:'active-real-launch',attempt:'a',spec:{}});store.update('active-real-launch',{status:'running'});store.emit({type:'message',taskId:'active-real-launch',text:'pending'});
  const statusFile=path.join(f.cfg.dataDir,'upgrades',id+'.status.json'),receiptFile=path.join(f.cfg.dataDir,'upgrades',id+'.queued.json');
  let status;
  try{
    const record={id,file:zip,action:{installer:{sha256:sha,version:'0.3.0'}}};
    const launcher=await launchUpgradeQueue(record,f.installed,f.cfg.dataDir);assert.ok(launcher.pid>0);
    for(let i=0;i<300;i++){if(fs.existsSync(statusFile)){status=JSON.parse(fs.readFileSync(statusFile));if(['waiting_for_idle','failed'].includes(status.state))break;}await sleep(100);}
    assert.equal(status?.state,'waiting_for_idle');const receipt=JSON.parse(fs.readFileSync(receiptFile));assert.equal(receipt.state,'queued');assert.equal(receipt.actionId,id);assert.equal(receipt.packageSha256,sha);
    const launcherLog=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'upgrades',id+'.launcher.json')));assert.equal(launcherLog.state,'exited');assert.equal(launcherLog.code,0);
    process.kill(original,0);assert.ok(!fs.existsSync(path.join(f.installed,'app/src/release-marker.mjs')));
    store.update('active-real-launch',{status:'submitted'});store.db.exec('DELETE FROM outbox');
    for(let i=0;i<600;i++){status=JSON.parse(fs.readFileSync(statusFile));if(['completed','failed'].includes(status.state))break;await sleep(100);}
    assert.equal(status.state,'completed');assert.equal(status.actionId,id);assert.equal(status.packageSha256,sha);assert.equal(digest(path.join(f.installed,'config/node.json')),configHash);
    assert.ok(fs.existsSync(path.join(f.installed,'app/src/release-marker.mjs')));assert.notEqual(JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'service.json'))).pid,original);
  }finally{store.update('active-real-launch',{status:'submitted'});store.db.exec('DELETE FROM outbox');store.close();f.stop();}
});

test('independent recovery restores real heartbeats, clears stale stop and maintenance after an upgrader exits during directory swap',{skip:process.platform!=='win32',timeout:60000},async()=>{
  const f=fixture(),heartbeats=[];let maintenance=true;const server=http.createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};res.setHeader('content-type','application/json');if(req.url==='/v1/sync'){heartbeats.push({pid:body.capabilities.fixturePid,at:Date.now()});res.end(JSON.stringify({ack:body.events.map(e=>e.id),tasks:[],nextPollMs:1000}));}else if(req.url==='/v1/node/maintenance'){maintenance=body.enabled;res.end(JSON.stringify({enabled:maintenance}));}else{res.statusCode=404;res.end('{}');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  Object.assign(f.cfg,{hubUrl:'http://127.0.0.1:'+server.address().port,desktopSync:false,selfUpgrade:false,pollMs:1000,idlePollMs:1000});fs.writeFileSync(path.join(f.installed,'config/node.json'),JSON.stringify(f.cfg));
  fs.writeFileSync(path.join(f.installed,'app/src/worker.mjs'),`import fs from 'node:fs';import {Worker} from ${JSON.stringify(pathToFileURL(path.join(repository,'src/worker.mjs')).href)};const file=process.argv[process.argv.indexOf('--config')+1],w=new Worker(JSON.parse(fs.readFileSync(file)),file,async()=>({status:'submitted'}));const original=w.capabilities.bind(w);w.capabilities=()=>({...original(),fixturePid:process.pid});await w.start();`);
  fs.writeFileSync(path.join(f.installed,'app/src/client.mjs'),`export class FleetClient{constructor(c){this.c=c;}async api(route,{method='GET',body}={}){const r=await fetch(this.c.hubUrl+route,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error('fixture HTTP '+r.status);return r.json();}close(){}}`);
  const configHash=digest(path.join(f.installed,'config/node.json'));f.start();const original=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'service.json'))),oldApp=path.join(f.installed,'app.previous-'+crypto.randomUUID().replaceAll('-','')),recovery=path.join(f.cfg.dataDir,'upgrades/recovery-test.json');fs.mkdirSync(path.dirname(recovery),{recursive:true});
  const wrapper=path.join(f.dir,'simulate-exited-upgrader.ps1');fs.writeFileSync(wrapper,String.raw`param([string]$InstallDir,[string]$RecordPath,[string]$OldApp,[string]$Helper,[string]$ConfigHash)
. (Join-Path (Split-Path -Parent $Helper) 'Windows-Common.ps1')
Set-FleetCache
$cfg=Read-FleetJson (Join-Path $InstallDir 'config\node.json');$updater=Get-CimInstance Win32_Process -Filter "ProcessId = $PID";$worker=Read-FleetJson (Join-Path $cfg.dataDir 'service.json')
Write-FleetJson $RecordPath @{installDir=$InstallDir;dataDir=$cfg.dataDir;nodeId=$cfg.nodeId;configHash=$ConfigHash;oldApp=$OldApp;worker=$worker;updater=@{pid=$PID;executable=$updater.ExecutablePath;created=$updater.CreationDate.ToUniversalTime().ToString('o')}}
$arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File '+(Quote-FleetArgument $Helper)+' -RecordPath '+(Quote-FleetArgument $RecordPath)+' -PollMilliseconds 100'
$guard=Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput ($RecordPath+'.out') -RedirectStandardError ($RecordPath+'.err')
[IO.File]::WriteAllText((Join-Path $cfg.dataDir 'stop.request'),'stop')
$app=Join-Path $InstallDir 'app'
if([IO.Path]::GetFullPath((Split-Path -Parent $OldApp)) -ne [IO.Path]::GetFullPath($InstallDir) -or (Split-Path -Leaf $OldApp) -notmatch '^app\.previous-[a-f0-9]{32}$'){throw 'Invalid isolated move target'}
Move-Item -LiteralPath $app -Destination $OldApp
Write-Host ('Isolated updater exit; guard '+$guard.Id)
`);
  try{pwsh(wrapper,['-InstallDir',f.installed,'-RecordPath',recovery,'-OldApp',oldApp,'-Helper',path.join(repository,'scripts/Recover-FleetUpgrade.ps1'),'-ConfigHash',configHash]);let result;for(let i=0;i<200;i++){try{result=JSON.parse(fs.readFileSync(recovery+'.result.json'));}catch{}if(result&&result.state!=='watching')break;await sleep(100);}assert.equal(result?.state,'restarted',JSON.stringify(result)+(fs.existsSync(recovery+'.err')?fs.readFileSync(recovery+'.err','utf8'):''));const current=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'service.json')));assert.notEqual(current.pid,original.pid);process.kill(current.pid,0);assert.equal(digest(path.join(f.installed,'config/node.json')),configHash);assert.ok(fs.existsSync(path.join(f.installed,'app/src/worker.mjs')));assert.ok(!fs.existsSync(oldApp));assert.ok(!fs.existsSync(path.join(f.cfg.dataDir,'stop.request')));assert.equal(maintenance,false);assert.ok(heartbeats.some(h=>h.pid===current.pid));const at=heartbeats.at(-1).at;for(let i=0;i<30&&!heartbeats.some(h=>h.pid===current.pid&&h.at>at);i++)await sleep(100);assert.ok(heartbeats.some(h=>h.pid===current.pid&&h.at>at),'Restored real worker must continue syncing after recovery');}finally{fs.writeFileSync(path.join(f.cfg.dataDir,'stop.request'),'stop');for(let i=0;i<100;i++){let alive=false;try{const r=JSON.parse(fs.readFileSync(path.join(f.cfg.dataDir,'service.json')));process.kill(r.pid,0);alive=true;}catch{}if(!alive)break;await sleep(100);}server.closeAllConnections();await new Promise(r=>server.close(r));}
});
