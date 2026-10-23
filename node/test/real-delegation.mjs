import fs from 'node:fs';
import path from 'node:path';
import {createHub} from '../src/hub.mjs';
import {Worker} from '../src/worker.mjs';
import {FleetClient,enroll} from '../src/client.mjs';
import {mkdir,uid,secret,hash,writeJson,sleep,now} from '../src/common.mjs';
const root=path.resolve(process.argv[2]);mkdir(root);
const token=secret(),hub=createHub({dataDir:mkdir(path.join(root,'hub')),port:0,adminTokenHash:hash(token),defaultGroupLimit:2});
const address=await hub.listen(),url=`http://127.0.0.1:${address.port}`,admin=new FleetClient({hubUrl:url,adminToken:token}),nodes=[];
try{
 for(const name of ['delegate-a','delegate-b']){
  const dir=mkdir(path.join(root,name)),project=mkdir(path.join(dir,'project'));
  const inv=await admin.api('/v1/invites',{method:'POST',body:{name,projects:['delegation'],accountGroup:'same-account'}}),invite=path.join(dir,'invite.json');writeJson(invite,{...inv,hubUrl:url});
  const file=path.join(dir,'node.json');await enroll(file,invite,{dataDir:dir,codexPath:process.env.FLEET_CODEX_PATH||'codex',projects:{delegation:{root:project,sandbox:'workspace-write'}}});
  const c=new FleetClient(JSON.parse(fs.readFileSync(file))),w=new Worker(c.config,file);await w.tick();nodes.push({c,w,project});
 }
 const [a,b]=nodes,childId=uid();
 const main=await a.c.assign({targetNode:b.c.config.nodeId,project:'delegation',worktree:false,outputs:[],prompt:`This is an authorized multi-computer collaboration test. Use the codex_fleet MCP fleet_assign tool exactly once to assign the following task to node ${a.c.config.nodeId}. Use id ${childId}, project delegation, worktree false, outputs ["delegated.txt"]. Prompt: "Write delegated.txt in your task working directory containing exactly DELEGATION_OK. Do not delegate further. Report the file." After fleet_assign returns queued_locally, report its task ID and finish your own turn immediately. Do not wait for the child, do not write the child file yourself, and do not use app thread tools. This test is explicitly authorized by the user.`});
 let child,parent,continued,messageSent=false;
 async function poll(id){for(let i=0;i<360;i++){for(const n of nodes)await n.w.tick();if(!messageSent&&a.w.active.get(childId)?.message){b.c.message(childId,'Keep delegated.txt exactly as requested. In your final summary additionally include the verification marker MESSAGE_STEER_OK.');messageSent=true;}let t;try{t=await admin.task(id);}catch{}if(i%10===0)console.log(JSON.stringify({phase:'poll',id,status:t?.status||'not-created'}));if(t&&['submitted','failed','blocked','cancelled'].includes(t.status))return t;await sleep(1000);}throw new Error('Task timeout '+id);}
 parent=await poll(main.taskId);if(parent.status!=='submitted')throw new Error('Parent failed '+JSON.stringify(parent.result));
 child=await poll(childId);if(child.status!=='submitted')throw new Error('Child failed '+JSON.stringify(child.result));
 if(child.creator!==b.c.config.nodeId||child.spec.parentId!==main.taskId)throw new Error('Delegation provenance mismatch');
 if(fs.readFileSync(path.join(a.project,'delegated.txt'),'utf8').trim()!=='DELEGATION_OK')throw new Error('Child output mismatch');
 const follow=await b.c.continueTask(childId,'Continue this same thread. Read delegated.txt and write continued.txt containing exactly CONTINUE_OK. Do not delegate.', ['continued.txt']);
 continued=await poll(follow.taskId);if(continued.status!=='submitted'||continued.thread_id!==child.thread_id)throw new Error('Continuation failed '+JSON.stringify(continued.result));
 if(fs.readFileSync(path.join(a.project,'continued.txt'),'utf8').trim()!=='CONTINUE_OK')throw new Error('Continuation output mismatch');
 await a.c.accept(parent.id,'Verified model used Fleet MCP to create the child with correct provenance.');await b.c.accept(child.id,'Verified file content and artifact.');await b.c.accept(continued.id,'Verified same thread and continuation file.');
 const delivery=a.w.store.db.prepare('SELECT state FROM delivery WHERE task=?').all(childId);const steered=messageSent&&delivery.some(x=>x.state==='delivered')&&child.result.summary.includes('MESSAGE_STEER_OK');
 writeJson(path.join(root,'verification.json'),{at:now(),realCodex:true,modelMcpDelegation:true,sameAccountFingerprint:a.w.inspection.accountFingerprint===b.w.inspection.accountFingerprint,childParentVerified:true,continuedSameThread:true,activeMessageSteeringVerified:steered,tasks:[parent.id,child.id,continued.id],outputVerified:true});console.log(JSON.stringify({ok:true,report:path.join(root,'verification.json'),activeMessageSteeringVerified:steered}));
}finally{for(const n of nodes){for(const c of n.w.active.values())await c.cancel?.().catch(()=>{});while(n.w.active.size)await sleep(100);n.w.store.close();n.c.close();}admin.close();await hub.close();}
