import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {FleetClient,initHub,enroll,prepareNode} from './client.mjs';
import {CodexRPC} from './codex.mjs';
import {arg,configPath,readJson,writeJson,assert,json,mkdir,hash,fileHash,safeUrl,VERSION,httpRequest} from './common.mjs';

const command=process.argv[2];let c;
try{
 let value;
 if(command==='init-hub'){value=initHub(configPath(),{dataDir:path.resolve(arg('data')),port:Number(arg('port','43127'))});}
 else if(command==='prepare-node'){value=prepareNode(configPath(),{dataDir:path.resolve(arg('data')),codexPath:arg('codex','codex'),projects:readJson(arg('projects')),name:arg('name','local-pending')});}
 else if(command==='enroll'){const p=configPath();const projects=readJson(arg('projects'));value=await enroll(p,arg('invite'),{dataDir:path.resolve(arg('data')),codexPath:arg('codex','codex'),projects});}
 else if(command==='probe'){
   const cfg=readJson(configPath());const rpc=new CodexRPC(cfg,null);try{await rpc.start();const account=await rpc.call('account/read',{refreshToken:false});const skills=await rpc.call('skills/list',{cwds:Object.values(cfg.projects||{}).map(p=>p.root),forceReload:true});value={version:VERSION,rpc:true,authenticated:!!account.account,authMode:account.account?.type||null,accountFields:Object.keys(account.account||{}),skills:(skills.data||[]).map(x=>({cwd:x.cwd,names:(x.skills||[]).filter(s=>s.enabled!==false).map(s=>s.name)}))};}finally{await rpc.close();}
 }
 else{
   const cfg=readJson(configPath());c=new FleetClient(cfg);
   if(command==='invite'){const inv=await c.api('/v1/invites',{method:'POST',body:{name:arg('name'),projects:arg('projects','workspace').split(','),accountGroup:arg('group','shared-default'),hours:Number(arg('hours','24'))}});const out=path.resolve(arg('out'));const hubUrl=safeUrl(arg('url',cfg.hubUrl));writeJson(out,{...inv,hubUrl});value={file:out,name:inv.name,expires:inv.expires};}
   else if(command==='nodes')value=await c.nodes();else if(command==='tasks')value=await c.tasks();else if(command==='status')value=await c.task(arg('task'));
   else if(command==='assign')value=await c.assign(readJson(arg('file')));
   else if(command==='workflow')value=await c.workflow(readJson(arg('file')));
   else if(command==='summary')value=await c.summary();
   else if(command==='knowledge')value=await c.knowledge(arg('project'),arg('query',''));
   else if(command==='publish-knowledge')value=await c.publishKnowledge(readJson(arg('file')));
   else if(command==='message')value=c.message(arg('task'),fs.readFileSync(arg('file'),'utf8'));
   else if(command==='continue')value=await c.continueTask(arg('task'),fs.readFileSync(arg('file'),'utf8'));
   else if(command==='accept')value=await c.accept(arg('task'),arg('note'));
   else if(command==='cancel')value=await c.cancel(arg('task'));
   else if(command==='resolve')value=await c.api(`/v1/tasks/${arg('task')}/resolve`,{method:'POST',body:{confirmStopped:process.argv.includes('--confirmed-stopped'),note:arg('note')}});
   else if(command==='revoke')value=await c.api(`/v1/nodes/${arg('node')}/revoke`,{method:'POST',body:{}});
   else if(command==='local')value=c.local();
   else if(command==='diagnose-json'){const out=path.resolve(arg('out'));writeJson(out,c.diagnostics());value={file:out,secretsIncluded:false};}
   else if(command==='open-console'){
     assert(process.platform==='win32','Open the Fleet console from the Windows shortcut');let url;
     try{const port=cfg.consolePort||43129,local=await httpRequest('http://127.0.0.1:'+port,'/status',{timeout:1500,proxy:false});assert(local.ok&&new URL(local.siteUrl).origin===new URL(cfg.hubUrl).origin,'Unexpected local console');url='http://127.0.0.1:'+port+'/login';}catch{url=await c.consoleTicket();}
     await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/Open-ConsoleUrl.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','ignore','ignore']});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Could not open the default browser')));child.stdin.end(url);});value={opened:true,note:'Opened the console using a short-lived one-time device ticket.'};
   }
   else if(command==='download'){
     value=await c.download(arg('task'),arg('sha'),path.resolve(arg('out')));
   }else throw new Error('Commands: init-hub, prepare-node, enroll, probe, invite, nodes, tasks, status, assign, workflow, summary, knowledge, publish-knowledge, message, continue, accept, cancel, resolve, revoke, local, download');
 }
 console.log(JSON.stringify(value,null,2));
}catch(e){console.error(e.message);process.exitCode=1;}finally{c?.close();}
