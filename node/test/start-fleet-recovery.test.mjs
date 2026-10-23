import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const repo=fileURLToPath(new URL('..',import.meta.url));
const windows={skip:process.platform!=='win32',timeout:45000};
const baseEnv={...process.env,TEMP:'D:\\codex+\\temp',TMP:'D:\\codex+\\temp',TMPDIR:'D:\\codex+\\temp',PSModuleAnalysisCachePath:'D:\\codex+\\cache\\powershell\\ModuleAnalysisCache'};
for(const k of Object.keys(baseEnv))if(k.toLowerCase()==='psmodulepath')delete baseEnv[k];
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function ps(file,args=[]){
  const log=path.join('D:/codex+/temp','fleet-start-test-'+crypto.randomUUID()),out=fs.openSync(log+'.out','w'),err=fs.openSync(log+'.err','w');
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],{windowsHide:true,env:baseEnv,stdio:['ignore',out,err]});
    child.once('error',e=>{fs.closeSync(out);fs.closeSync(err);reject(e);});
    child.once('exit',code=>{fs.closeSync(out);fs.closeSync(err);const text=fs.readFileSync(log+'.out','utf8')+'\n'+fs.readFileSync(log+'.err','utf8');code===0?resolve(text):reject(new Error(text));});
  });
}
function fixture(t,delay=3000){
  const root=fs.mkdtempSync('D:/codex+/temp/fleet-start-recovery-'),data=path.join(root,'data/node');
  for(const d of ['app/src','app/scripts','config','runtime','data/node'])fs.mkdirSync(path.join(root,d),{recursive:true});
  for(const f of ['Start-Fleet.ps1','Stop-Fleet.ps1','Windows-Common.ps1'])fs.copyFileSync(path.join(repo,'scripts',f),path.join(root,'app/scripts',f));
  try{fs.linkSync(process.execPath,path.join(root,'runtime/node.exe'));}catch(e){if(e.code!=='EXDEV')throw e;fs.copyFileSync(process.execPath,path.join(root,'runtime/node.exe'));}
  const config=path.join(root,'config/node.json');fs.writeFileSync(config,JSON.stringify({nodeId:'isolated-start-fixture',dataDir:data,delay}));
  fs.writeFileSync(path.join(root,'app/src/worker.mjs'),`import fs from 'node:fs';import path from 'node:path';
const cfg=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config')+1]));
fs.appendFileSync(path.join(cfg.dataDir,'starts.txt'),process.pid+'\\n');let stopping=false;
setInterval(()=>{if(!stopping&&fs.existsSync(path.join(cfg.dataDir,'stop.request'))){stopping=true;setTimeout(()=>process.exit(0),cfg.delay);}},40);`);
  const marker=path.join(data,'service.json'),stop=path.join(data,'stop.request'),start=path.join(root,'app/scripts/Start-Fleet.ps1');
  const stopping=path.join(root,'request-and-start.ps1');fs.writeFileSync(stopping,`param([string]$Root,[int]$Seconds=15)\n[IO.File]::WriteAllText((Join-Path $Root 'data\\node\\stop.request'),'stop')\n& (Join-Path $Root 'app\\scripts\\Start-Fleet.ps1') -InstallDir $Root -WaitForStopSeconds $Seconds\n`);
  const record=()=>JSON.parse(fs.readFileSync(marker));
  t.after(async()=>{fs.writeFileSync(stop,'stop');const pids=fs.existsSync(path.join(data,'starts.txt'))?fs.readFileSync(path.join(data,'starts.txt'),'utf8').trim().split('\n').map(Number):[];for(let i=0;i<160&&pids.some(alive);i++)await sleep(100);assert.ok(pids.every(pid=>!alive(pid)),'Only fixture processes should exit normally at cleanup');});
  return {root,data,config,marker,stop,record,start:args=>ps(start,['-InstallDir',root,...(args||[])]),requestAndStart:seconds=>ps(stopping,['-Root',root,'-Seconds',String(seconds)])};
}

test('Start waits for a slow managed shutdown, then launches one fresh worker without changing config',windows,async t=>{
  const f=fixture(t,6000),hash=digest(f.config);await f.start();const old=f.record();
  const output=await f.requestAndStart(15),current=f.record();
  assert.match(output,/finishing a previous stop/);assert.notEqual(current.pid,old.pid);assert.equal(alive(old.pid),false);assert.ok(alive(current.pid));assert.equal(fs.existsSync(f.stop),false);assert.equal(digest(f.config),hash);
  assert.equal(fs.readFileSync(path.join(f.data,'starts.txt'),'utf8').trim().split('\n').length,2);
  await f.start();assert.equal(f.record().pid,current.pid,'Starting an already healthy worker must remain idempotent');
});

test('A bounded stop wait fails clearly while retaining stop intent and the still-running process',windows,async t=>{
  const f=fixture(t,6000);await f.start();const old=f.record();
  await assert.rejects(f.requestAndStart(1),/Fleet is still stopping/);
  assert.ok(alive(old.pid));assert.equal(f.record().pid,old.pid);assert.ok(fs.existsSync(f.stop));
  await f.start(['-WaitForStopSeconds','15']);assert.notEqual(f.record().pid,old.pid);assert.equal(alive(old.pid),false);
});

test('Concurrent recovery launchers serialize and retain a single worker identity',windows,async t=>{
  const f=fixture(t,200);await Promise.all([f.start(),f.start(),f.start()]);const current=f.record();
  assert.ok(alive(current.pid));assert.equal(fs.readFileSync(path.join(f.data,'starts.txt'),'utf8').trim(),String(current.pid));
  const lock=fs.openSync(path.join(f.data,'start.lock'),'r+');fs.closeSync(lock);
});

test('a blocked desktop launch leaves an actual managed worker online without creating stop.request',windows,async t=>{
  const f=fixture(t,200),scripts=path.join(f.root,'app/scripts'),bridge=path.join(f.root,'desktop-bridge');fs.mkdirSync(bridge);
  for(const name of ['Start-FleetDesktop.ps1','Windows-DesktopTrust.ps1'])fs.copyFileSync(path.join(repo,'scripts',name),path.join(scripts,name));
  fs.writeFileSync(path.join(bridge,'codex-fleet-desktop.exe'),'policy-blocked-fixture');
  fs.writeFileSync(path.join(scripts,'Windows-Desktop.ps1'),`. (Join-Path $PSScriptRoot 'Windows-DesktopTrust.ps1')\nfunction Get-FleetDesktopPolicy {return [pscustomobject]@{requiresSignedRelease=$true}}\nfunction Get-FleetDesktopSignature {return [pscustomobject]@{status='NotSigned';thumbprint=$null}}\n`);
  const hash=digest(f.config);await f.start();const old=f.record();
  await assert.rejects(ps(path.join(scripts,'Start-FleetDesktop.ps1'),['-InstallDir',f.root]),/trusted signed Fleet desktop launcher/);
  assert.ok(alive(old.pid));assert.equal(f.record().pid,old.pid);assert.equal(digest(f.config),hash);assert.equal(fs.existsSync(f.stop),false);
  const launch=JSON.parse(fs.readFileSync(path.join(bridge,'launch-status.json')));assert.equal(launch.errorCode,'DESKTOP_TRUST_REQUIRED');assert.equal(launch.recovery,'node_start_checked');
  assert.equal(fs.readFileSync(path.join(f.data,'starts.txt'),'utf8').trim(),String(old.pid));
});
