import fs from 'node:fs';
import path from 'node:path';
import {createHub} from '../src/hub.mjs';
import {Worker} from '../src/worker.mjs';
import {FleetClient,enroll} from '../src/client.mjs';
import {mkdir,uid,secret,hash,writeJson,sleep,now} from '../src/common.mjs';

const root=path.resolve(process.argv[2]||'../real-smoke-'+Date.now());mkdir(root);
const token=secret(),hub=createHub({dataDir:mkdir(path.join(root,'hub')),port:0,adminTokenHash:hash(token),defaultGroupLimit:2});
const address=await hub.listen(),url=`http://127.0.0.1:${address.port}`,admin=new FleetClient({hubUrl:url,adminToken:token});
const nodes=[];
try{
 for(const name of ['local-a','local-b']){
   const dir=mkdir(path.join(root,name)),project=mkdir(path.join(dir,'project'));
   mkdir(path.join(project,'.agents','skills','fleet-smoke-local'));
   fs.writeFileSync(path.join(project,'.agents','skills','fleet-smoke-local','SKILL.md'),'---\nname: fleet-smoke-local\ndescription: Local fleet verification skill for this isolated test project.\n---\nRead input.txt in the task working directory. Write result.txt containing the exact input text followed by a newline and FLEET_LOCAL_SKILL_OK. Do not delegate.\n');
   fs.writeFileSync(path.join(project,'input.txt'),'fleet-verification-'+uid());
   const inv=await admin.api('/v1/invites',{method:'POST',body:{name,projects:['smoke'],accountGroup:'same-account'}}),invite=path.join(dir,'invite.json');writeJson(invite,{...inv,hubUrl:url});
   const cfg=path.join(dir,'node.json');await enroll(cfg,invite,{dataDir:dir,codexPath:process.env.FLEET_CODEX_PATH||'codex',projects:{smoke:{root:project,sandbox:'workspace-write'}}});
   const c=new FleetClient(JSON.parse(fs.readFileSync(cfg))),w=new Worker(c.config,cfg);await w.tick();nodes.push({c,w,project});
 }
 console.log(JSON.stringify({phase:'nodes-ready',nodes:await admin.nodes()}));
 const [a,b]=nodes;const submitted=await a.c.assign({targetNode:b.c.config.nodeId,project:'smoke',worktree:false,skills:['fleet-smoke-local'],outputs:['result.txt'],prompt:'Execute the fleet-smoke-local skill in this isolated directory. Read input.txt and write result.txt exactly as the skill specifies. Do not modify any other files. Then report the output path and the marker.'});
 const deadline=Date.now()+240000;let status;
 while(Date.now()<deadline){for(const n of nodes)await n.w.tick();status=await admin.task(submitted.taskId);console.log(JSON.stringify({phase:'poll',status:status.status}));if(['submitted','failed','blocked','cancelled'].includes(status.status))break;await sleep(1000);}
 if(status.status!=='submitted')throw new Error('Real Codex task did not submit: '+JSON.stringify(status.result));
 const expected=fs.readFileSync(path.join(b.project,'input.txt'),'utf8')+'\nFLEET_LOCAL_SKILL_OK';const actual=fs.readFileSync(path.join(b.project,'result.txt'),'utf8').trimEnd();if(actual!==expected)throw new Error('Skill output content mismatch');
 await a.c.accept(submitted.taskId,'Read result.txt; exact input and skill marker verified. Artifact SHA256 is present.');
 const report={at:now(),realCodex:true,sameAccountFingerprint:nodes[0].w.inspection.accountFingerprint===nodes[1].w.inspection.accountFingerprint,independentNodeIds:nodes[0].c.config.nodeId!==nodes[1].c.config.nodeId,task:await admin.task(submitted.taskId),skillsLoaded:nodes[1].w.inspection.skills,outputVerified:true};
 writeJson(path.join(root,'verification.json'),report);console.log(JSON.stringify({ok:true,report:path.join(root,'verification.json')}));
}finally{for(const n of nodes){for(const c of n.w.active.values())await c.cancel?.().catch(()=>{});while(n.w.active.size)await sleep(100);n.w.store.close();n.c.close();}admin.close();await hub.close();}
