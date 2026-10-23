import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {activeTaskProof} from './active-task-proof.mjs';

const [operation,installDir]=process.argv.slice(2);
if(!['idle','idle-recovery','maintenance-on','maintenance-off'].includes(operation)||!installDir)throw new Error('Use an upgrade guard operation and installation directory');
const config=JSON.parse(fs.readFileSync(path.join(installDir,'config','node.json'),'utf8').replace(/^\uFEFF/,''));
const {FleetClient}=await import(pathToFileURL(path.join(installDir,'app','src','client.mjs')));
const client=new FleetClient(config);
try{
  if(operation.startsWith('maintenance-')){
    const value=await client.api('/v1/node/maintenance',{method:'POST',body:{enabled:operation==='maintenance-on',reason:'Node adapter upgrade',...(operation==='maintenance-on'?{expiresAt:new Date(Date.now()+55*60*1000).toISOString()}:{})}});
    console.log(JSON.stringify({enabled:value.enabled,expiresAt:value.expiresAt||null}));
  }else{
    if(operation==='idle'){
      for(const run of (client.store?.runs()||[]).filter(r=>r.status==='uncertain')){
        const {reconcileCancellation}=await import('../src/cancel-reconcile.mjs');
        await reconcileCancellation({config,store:client.store,api:(...args)=>client.api(...args),taskId:run.task});
      }
    }
    const db=new DatabaseSync(path.join(config.dataDir,'node.sqlite'),{readOnly:true});let local;
    try{db.exec('PRAGMA busy_timeout=3000');const runs=db.prepare("SELECT task,status FROM runs WHERE status IN ('received','preparing','running','uploading','uncertain')").all(),transfers=db.prepare("SELECT COUNT(*) n FROM transfers WHERE status!='complete'").get().n,outbox=db.prepare('SELECT COUNT(*) n FROM outbox').get().n;local={runs,transfers,outbox};}finally{db.close();}
    const {remote,completeProof,total}=await activeTaskProof(client,config.nodeId);
    console.log(JSON.stringify({idle:!local.runs.length&&!local.transfers&&!local.outbox&&!total,completeProof,remoteTotal:total,local,remote,nodeId:config.nodeId,checkedAt:new Date().toISOString()}));
  }
}catch(e){console.error(JSON.stringify({error:String(e.message).replace(/\bBearer\s+[^\s"']+/gi,'Bearer [redacted]').slice(0,500)}));process.exitCode=1;}finally{client.close();}
