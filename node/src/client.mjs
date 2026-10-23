import fs from 'node:fs';
import path from 'node:path';
import {LocalStore} from './local-store.mjs';
import {publicSanitizer} from './codex.mjs';
import {uid,assert,httpRequest,validateSpec,readJson,writeJson,secret,hash,mkdir,safeUrl,fileHash,within,VERSION} from './common.mjs';

export class FleetClient {
  constructor(config){this.config=config;this.store=config.nodeId?new LocalStore(config.dataDir):null;}
  requireEnrollment(){assert(this.config.hubUrl&&!['pending','enrolling'].includes(this.config.enrollmentState),'Node is awaiting a hub invitation or enrollment retry. Use fleet_local for local readiness and Complete-Enrollment.ps1 to connect.');}
  api(route,options={}){this.requireEnrollment();return httpRequest(this.config.hubUrl,route,{token:this.config.nodeToken||this.config.adminToken,sitesToken:this.config.sitesToken,proxy:this.config.proxyUrl,...options});}
  async nodes(){const value=await this.api('/v1/nodes');this.store?.put('nodes',value);return value;}
  tasks(){return this.api('/v1/tasks');}
  async desktopNode(target){if(!target)return null;const nodes=await this.nodes();const found=nodes.find(n=>n.id===target||String(n.name).toLowerCase()===String(target).toLowerCase());assert(found,'Unknown device code or ID');return found.id;}
  async desktopTasks({target,nodeId,search='',archived='all',limit=50,cursor}={}){
    assert(['all','true','false'].includes(archived),'archived must be all, true or false');assert(Number.isInteger(limit)&&limit>=1&&limit<=100,'limit must be 1-100');assert(typeof search==='string'&&search.length<=300,'Search must be up to 300 characters');
    const query=new URLSearchParams({archived,limit:String(limit)}),node=nodeId||await this.desktopNode(target);if(node)query.set('node',node);if(search)query.set('search',search);if(cursor)query.set('cursor',cursor);return this.api('/v1/desktop/threads?'+query);
  }
  async desktopRead({target,nodeId,threadId}){assert(typeof threadId==='string'&&threadId.length<=200,'Provide the native Codex thread ID');const node=nodeId||await this.desktopNode(target);assert(node,'Select a device code or ID');return this.api(`/v1/desktop/threads/${encodeURIComponent(node)}/${encodeURIComponent(threadId)}`);}
  async desktopMessage({id,target,nodeId,threadId,prompt}){
    this.requireEnrollment();assert(id&&threadId&&typeof prompt==='string'&&prompt.trim(),'Stable id, original threadId and message required');
    const node=nodeId||await this.desktopNode(target);assert(node,'Select a device');
    return this.api(`/v1/desktop/threads/${encodeURIComponent(node)}/${encodeURIComponent(threadId)}/message`,{method:'POST',body:{id,prompt}});
  }
  async startConversation({id,target,targetNode,project,workspaceId,prompt,skills=[],inputs=[]}){
    this.requireEnrollment();assert(id&&workspaceId,'Use a stable request id and a ready target project');
    const node=targetNode||await this.desktopNode(target);assert(node,'Select a device');
    return this.api('/v1/tasks',{method:'POST',body:{id,targetNode:node,project,workspaceId,prompt,skills,inputs,intent:'conversation',requireDesktop:true,executionPolicy:'local',mode:'execute',worktree:false,outputs:[],dependencies:[]}});
  }
  async projects({target,nodeId}={}){const node=nodeId||await this.desktopNode(target);return this.api('/v1/workspaces'+(node?'?nodeId='+encodeURIComponent(node):''));}
  async power({target,nodeId}={}){const node=nodeId||await this.desktopNode(target);assert(node,'Select a device');return this.api('/v1/nodes/'+encodeURIComponent(node)+'/power');}
  async wake({target,nodeId,id,probe=false}){const node=nodeId||await this.desktopNode(target);assert(node&&typeof id==='string'&&/^[\w-]{1,100}$/.test(id),'Select a device and stable wake request ID');return this.api('/v1/nodes/'+encodeURIComponent(node)+'/wake',{method:'POST',body:{id,probe}});}
  async createProject(input){
    assert(typeof input.id==='string'&&/^[\w-]{1,100}$/.test(input.id),'Use a stable project ID up to 100 characters');assert(typeof input.name==='string'&&input.name.trim()&&input.name.length<=160,'Provide a project name up to 160 characters');
    assert(input.root===undefined&&input.path===undefined,'Choose an observed sourceThreadId or let the target device create its own directory');
    const nodeId=input.nodeId||await this.desktopNode(input.target);assert(nodeId,'Select a device code or ID');
    if(this.store&&input.project)assert(this.config.projects?.[input.project],'Project scope is not configured on this node');
    const body={id:input.id,nodeId,name:input.name.trim(),...(input.project?{project:input.project}:{}),...(input.sourceThreadId?{sourceThreadId:input.sourceThreadId}:{}),...(input.automationNote!==undefined?{automationNote:input.automationNote}:{})};
    return this.api('/v1/workspaces',{method:'POST',body});
  }
  automations({id,status,limit=100}={}){
    if(id){assert(typeof id==='string'&&/^[\w-]{1,100}$/.test(id),'Invalid automation ID');return this.api('/v1/automations/'+encodeURIComponent(id));}
    assert(Number.isInteger(limit)&&limit>=1&&limit<=200,'Automation limit must be 1-200');const query=new URLSearchParams({limit:String(limit)});
    if(status){assert(['running','paused','needs_attention','completed','cancelling','cancelled'].includes(status),'Invalid automation status');query.set('status',status);}
    return this.api('/v1/automations?'+query);
  }
  async createAutomation(input){
    assert(typeof input.id==='string'&&/^[\w-]{1,100}$/.test(input.id),'Use a stable automation ID up to 100 characters');assert(typeof input.name==='string'&&input.name.trim()&&input.name.length<=160,'Provide an automation name up to 160 characters');
    assert(Array.isArray(input.steps)&&input.steps.length>=2&&input.steps.length<=12,'An automation requires 2-12 steps');if(this.store)assert(this.config.projects?.[input.project],'Project scope is not configured on this node');
    const parallel=input.executionMode==='parallel';assert(input.executionMode===undefined||['parallel','sequential'].includes(input.executionMode),'Invalid execution mode');
    const keys=new Set(),steps=[];
    for(const [index,s] of input.steps.entries()){
      const key=s.key||'step-'+(index+1),mode=s.mode||'execute';assert(typeof key==='string'&&/^[\w-]{1,100}$/.test(key)&&!keys.has(key),'Invalid or repeated automation step key');keys.add(key);
      assert(typeof s.name==='string'&&s.name.trim()&&s.name.length<=160,'Provide a step name up to 160 characters');assert(typeof s.prompt==='string'&&s.prompt.trim()&&s.prompt.length<=48000,'Provide a step prompt up to 48000 characters');assert(parallel||s.inputs===undefined||(Array.isArray(s.inputs)&&s.inputs.length===0),'Automation inputs come from the preceding step');
      const targetNode=s.targetNode||await this.desktopNode(s.target);assert(targetNode,'Select a device for each step');
      const step={key,name:s.name.trim(),targetNode,prompt:s.prompt,mode,executionPolicy:s.executionPolicy||(mode==='execute'?'local':'project'),skills:s.skills||[],outputs:s.outputs||[],worktree:s.worktree??true,...(s.workspaceId?{workspaceId:s.workspaceId}:{})};
      if(parallel){assert(Array.isArray(s.dependsOn||[])&&(s.dependsOn||[]).every(dep=>dep!==key&&keys.has(dep)),'Dependencies must refer to earlier steps');Object.assign(step,{dependsOn:s.dependsOn||[],inputs:s.inputs||[],requireDesktop:s.requireDesktop!==false});}
      else if(s.requireDesktop!==undefined)step.requireDesktop=s.requireDesktop;
      validateSpec({...step,id:'validate-step',project:input.project,dependencies:[],inputs:step.inputs||[]});steps.push(step);
    }
    const parentTaskId=input.parentTaskId||this.config.parentTaskId||process.env.CODEX_FLEET_PARENT_TASK;
    return this.api('/v1/automations',{method:'POST',body:{id:input.id,name:input.name.trim(),project:input.project,steps,...(parallel?{executionMode:'parallel'}:{}),...(parentTaskId?{parentTaskId}:{})}});
  }
  controlAutomation(id,action){assert(typeof id==='string'&&/^[\w-]{1,100}$/.test(id),'Invalid automation ID');assert(['pause','resume','cancel'].includes(action),'Automation action must be pause, resume or cancel');return this.api(`/v1/automations/${encodeURIComponent(id)}/${action}`,{method:'POST',body:{}});}
  task(id){return this.api('/v1/tasks/'+encodeURIComponent(id));}
  async assign(input){
    this.requireEnrollment();
    const spec={...input,id:input.id||uid(),dependencies:input.dependencies||[],skills:input.skills||[],outputs:input.outputs||[]};
    if(!spec.parentId&&(this.config.parentTaskId||process.env.CODEX_FLEET_PARENT_TASK))spec.parentId=this.config.parentTaskId||process.env.CODEX_FLEET_PARENT_TASK;
    if(!spec.targetNode&&spec.target){let nodes;try{nodes=await this.nodes();}catch(e){nodes=this.store?.get('nodes');if(!nodes)throw e;}const target=nodes.find(n=>n.name===spec.target||n.id===spec.target);assert(target,'Unknown target');spec.targetNode=target.id;delete spec.target;}
    assert(!this.store||this.config.projects[spec.project],'Project is not configured on this node');validateSpec(spec);
    if(!this.store)return this.api('/v1/tasks',{method:'POST',body:spec});
    const outboxId=this.store.emit({type:'assign',spec});return {taskId:spec.id,outboxId,status:'queued_locally',note:'Durably queued on this node. The running worker submits it to the hub; use fleet_status to confirm delivery and execution.'};
  }
  message(taskId,text){this.requireEnrollment();assert(this.store,'Use node config');assert(typeof text==='string'&&text.length<=16000,'Invalid message');const outboxId=this.store.emit({type:'message',taskId,text});return {outboxId,status:'queued_locally',note:'Delivered to the active turn when possible. For a completed task, use fleet_continue to start a tracked follow-up.'};}
  async continueTask(id,prompt,outputs=[]){const t=await this.task(id);return this.assign({project:t.project,targetNode:t.target,prompt,resumeTaskId:id,worktree:false,outputs,workspaceId:t.spec.workspaceId,executionPolicy:t.spec.executionPolicy,parentId:id,skills:t.spec.skills||[],mode:t.spec.mode||'execute',...(t.spec.workspaceId?{workspaceId:t.spec.workspaceId}:{})});}
  async handoff(id,target,prompt){const t=await this.task(id);assert(['submitted','accepted'].includes(t.status),'Handoff requires a submitted result');return this.assign({project:t.project,target,parentId:id,prompt:`Handoff from task ${id}. Previous outcome: ${JSON.stringify(t.result)}. Retrieve required artifacts using fleet tools.\n\n${prompt}`,baseCommit:t.result?.code&&!t.result.code.dirty?t.result.code.commit:undefined});}
  accept(id,note){return this.api(`/v1/tasks/${encodeURIComponent(id)}/accept`,{method:'POST',body:{note}});}
  async workflow(input){
    assert(/^[\w-]{1,50}$/.test(input.id),'Use a stable workflow id up to 50 characters');assert(Array.isArray(input.steps)&&input.steps.length>0&&input.steps.length<=20,'Workflow requires 1-20 steps');
    const seen=new Set(),prepared=[];
    for(const s of input.steps){assert(/^[\w-]{1,40}$/.test(s.key)&&!seen.has(s.key),'Invalid or duplicate step key');assert(Array.isArray(s.dependsOn||[])&&(s.dependsOn||[]).every(d=>seen.has(d)),'Order steps topologically; dependencies must refer to earlier steps');const {key,dependsOn,...rest}=s;prepared.push({...rest,id:input.id+'-'+key,workflowId:input.id,project:input.project,parentId:input.parentId,dependencies:(dependsOn||[]).map(d=>input.id+'-'+d)});seen.add(key);}
    const results=[];for(const s of prepared)results.push(await this.assign(s));return {workflowId:input.id,tasks:results,note:'Each dependent step waits for explicit acceptance of its prerequisites. Reuse this workflow id and identical input to recover interrupted submission.'};
  }
  async summary(){const tasks=await this.tasks();const counts={};for(const t of tasks)counts[t.status]=(counts[t.status]||0)+1;return {scope:'most recent 500 visible tasks',counts,tasks:tasks.map(t=>({id:t.id,project:t.project,parentId:t.spec.parentId,workflowId:t.spec.workflowId,role:t.spec.role,creator:t.creator,target:t.target,status:t.status,acceptance:t.spec.acceptance,summary:t.result?.summary,error:t.result?.error,code:t.result?.code,artifacts:t.result?.artifacts}))};}
  knowledge(project,q=''){return this.api('/v1/knowledge?project='+encodeURIComponent(project)+'&q='+encodeURIComponent(q));}
  publishKnowledge(input){return this.api('/v1/knowledge',{method:'POST',body:input});}
  cancel(id){return this.api(`/v1/tasks/${encodeURIComponent(id)}/cancel`,{method:'POST',body:{}});}
  local(){return {nodeId:this.config.nodeId,name:this.config.name,enrollmentState:this.config.enrollmentState||(this.config.hubUrl?'enrolled':'pending'),projects:Object.keys(this.config.projects||{}),codex:this.store?.get('codex'),connection:this.store?.get('connection'),runs:this.store?.runs(),files:this.store?.transfers(),outboxErrors:this.store?.errors(),pending:this.store?.pending().map(e=>({id:e.id,type:e.type,taskId:e.taskId||e.spec?.id}))};}
  async download(taskId,sha,out){
    const task=await this.task(taskId),a=task.artifacts.find(x=>x.sha===sha);assert(a,'Artifact not attached to task');assert(!fs.existsSync(out),'Output file already exists');mkdir(path.dirname(out));
    const part=out+'.'+sha+'.partial';let offset=fs.existsSync(part)?fs.statSync(part).size:0;assert(offset<=a.size,'Local partial is larger than artifact');
    if(!fs.existsSync(part))fs.writeFileSync(part,Buffer.alloc(0),{flag:'wx',mode:0o600});
    while(offset<a.size){const end=Math.min(offset+1024*1024,a.size)-1;const b=await this.api(`/v1/artifacts/${sha}?task=${encodeURIComponent(taskId)}`,{raw:true,headers:{range:`bytes=${offset}-${end}`}});assert(b.length===end-offset+1,'Incomplete download chunk');const fd=fs.openSync(part,'a');try{fs.writeSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}offset+=b.length;}
    assert(fileHash(part)===sha,'Downloaded file hash mismatch; partial retained for inspection');fs.renameSync(part,out);return {file:out,sha256:sha,size:a.size};
  }
  downloadToProject(taskId,sha,project,relativePath){assert(this.config.projects?.[project],'Local project missing');return this.download(taskId,sha,within(this.config.projects[project].root,relativePath));}
  queueFile(project,relativePath,{id,followup}={}){
    this.requireEnrollment();assert(this.store&&this.config.projects?.[project],'Local project missing');const source=within(this.config.projects[project].root,relativePath);assert(fs.existsSync(source)&&fs.statSync(source).isFile(),'Select an existing project file');const size=fs.statSync(source).size;assert(size<=(this.config.maxArtifactBytes||512*1024*1024),'File exceeds transfer limit');
    const sha=fileHash(source),name=relativePath.replaceAll('\\','/');validateSpec({id:'validate-input',targetNode:this.config.nodeId,project,prompt:'transfer',inputs:[{sha,size,name}]});
    const snapshot=path.join(mkdir(path.join(this.config.dataDir,'artifacts')),sha);if(!fs.existsSync(snapshot))fs.copyFileSync(source,snapshot);assert(fileHash(snapshot)===sha,'File changed during snapshot; retry after the writer has finished');
    const transferId=id||'file-'+hash(project+'\0'+name+'\0'+sha).slice(0,40);assert(/^[\w-]{1,100}$/.test(transferId),'Invalid transfer ID');const prior=this.store.transfer(transferId);if(prior)assert(prior.sha===sha&&prior.project===project&&prior.name===name&&JSON.stringify(prior.followup||null)===JSON.stringify(followup||null),'Transfer ID already used with different input');
    return this.store.queueTransfer({id:transferId,project,sha,size,name,...(followup?{followup}:{}),created:new Date().toISOString()});
  }
  fileStatus(id){const transfer=this.store?.transfer(id);assert(transfer,'Unknown local transfer');return transfer;}
  diagnostics(){
    const redact=value=>{let text=String(value||'');for(const token of [this.config.nodeToken,this.config.adminToken,this.config.sitesToken])if(token)text=text.split(token).join('[redacted]');return text.replace(/\bBearer\s+[^\s"']+/gi,'Bearer [redacted]').slice(0,1000);};
    const connection=this.store?.get('connection'),codex=this.store?.get('codex');return {version:VERSION,at:new Date().toISOString(),nodeId:this.config.nodeId,name:this.config.name,enrollmentState:this.config.enrollmentState,hubOrigin:this.config.hubUrl?new URL(this.config.hubUrl).origin:null,projects:Object.keys(this.config.projects||{}),connection:connection?{online:connection.online,state:connection.state,lastSuccess:connection.lastSuccess,error:redact(connection.error)}:null,codex:codex?{ready:codex.ready,checkedAt:codex.checkedAt,error:redact(codex.error)}:null,pendingEvents:this.store?.pending().length,rejectedEvents:this.store?.errors().map(e=>({id:e.id,error:redact(e.error)})),runs:this.store?.runs().map(r=>({taskId:r.task,status:r.status,updated:r.updated,...(r.result?.uploadStopped?{uploadStopped:{reason:redact(r.result.uploadStopped.reason),remoteStatus:r.result.uploadStopped.remoteStatus,remoteAttempt:r.result.uploadStopped.remoteAttempt,stoppedAt:r.result.uploadStopped.stoppedAt,snapshotRetained:r.result.uploadStopped.snapshotRetained}}:{})})),transfers:this.store?.transfers().map(a=>({id:a.id,size:a.size,bytes:a.bytes,status:a.status,error:redact(a.error)})),note:'Contains no configuration secrets, prompts, file bodies, absolute source paths, or Codex login data. Review device names and task IDs before sharing.'};
  }
  async sendFile({id,project,relativePath,target,targetNode,prompt,mode='execute',skills=[],outputs=[],workspaceId,executionPolicy,worktree=true,parentId,workflowId,requireDesktop=true}){
    this.requireEnrollment();assert(typeof prompt==='string'&&prompt.trim(),'Provide the authorized purpose for the receiving Codex');
    if(!targetNode){const nodes=await this.nodes().catch(e=>{const cached=this.store?.get('nodes');if(!cached)throw e;return cached;});const node=nodes.find(n=>n.id===target||n.name===target);assert(node,'Unknown target');targetNode=node.id;}
    const transferId=id||uid(),taskId=transferId+'-delivery';const followup={id:taskId,targetNode,project,prompt,mode,skills,outputs,dependencies:[],parentId:parentId||this.config.parentTaskId||undefined,worktree,requireDesktop,...(workspaceId?{workspaceId}:{}),...(workflowId?{workflowId}:{}),...(executionPolicy?{executionPolicy}:{})};validateSpec(followup);
    const transfer=this.queueFile(project,relativePath,{id:transferId,followup});return {...transfer,taskId,note:'File and follow-up are durably queued. The follow-up is submitted only after the hub confirms the complete file; use fleet_file_status then fleet_status.'};
  }
  readReceipt({taskId,sha256,localPath,summary}){
    assert(this.config.parentTaskId&&taskId===this.config.parentTaskId,'Read receipts are restricted to the current Fleet task');
    const r=this.store?.run(taskId);assert(r?.status==='running','Current task is not executing');
    assert(typeof summary==='string'&&summary.trim().length>=3&&summary.length<=2000,'Provide a concrete reading summary up to 2000 characters');
    const input=this.store.inputs(taskId).find(x=>x.sha===sha256&&path.resolve(x.path)===path.resolve(localPath));assert(input&&input.stage==='context_attached','This file was not attached to the current task');
    assert(fs.existsSync(input.path)&&fs.statSync(input.path).isFile()&&fileHash(input.path)===sha256,'Input file is missing or changed');
    const safe=within(r.cwd,path.relative(r.cwd,input.path));assert(safe===input.path,'Input path mismatch');
    const receipt={sha:sha256,name:input.name,summary:publicSanitizer(this.config)(summary.trim()).slice(0,2000),reportedAt:new Date().toISOString(),evidence:'codex_self_report'};
    this.store.db.exec('BEGIN IMMEDIATE');try{this.store.inputReceipt(taskId,input.name,receipt);const outboxId=this.store.emit({type:'progress',taskId,attemptId:r.attempt,kind:'input_read_receipt',...receipt});this.store.db.exec('COMMIT');return {outboxId,recorded:true,evidence:'codex_self_report'};}catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  async consoleTicket(){const value=await this.api('/v1/device-session',{method:'POST',body:{}});assert(typeof value.ticket==='string'&&value.ticket.length>=20&&value.ticket.length<=1000,'Invalid device sign-in ticket');const site=new URL(value.siteUrl||this.config.hubUrl),hub=new URL(safeUrl(this.config.hubUrl));assert(site.origin===hub.origin&&!site.username&&!site.password,'Device sign-in destination must match this hub');return new URL('/#device-ticket='+encodeURIComponent(value.ticket),hub).href;}
  close(){this.store?.close();}
}

export async function enroll(configFile,inviteFile,{dataDir,codexPath,projects}){
  const inv=readJson(inviteFile);safeUrl(inv.hubUrl);assert(projects&&Object.keys(projects).length,'At least one local project mapping is required');
  if(inv.sitesToken!==undefined)assert(typeof inv.sitesToken==='string'&&inv.sitesToken.length<8000,'Invalid Sites access credential');
  let c;if(fs.existsSync(configFile)){c=readJson(configFile);assert((!c.hubUrl&&c.enrollmentState==='pending')||c.hubUrl===inv.hubUrl,'Existing node belongs to a different hub');c={...c,hubUrl:inv.hubUrl,...(inv.sitesToken!==undefined?{sitesToken:inv.sitesToken}:{}),enrollmentState:c.enrollmentState==='enrolled'?'enrolled':'enrolling'};writeJson(configFile,c);}
  else {c={version:2,enrollmentState:'enrolling',nodeId:uid(),nodeToken:secret(),hubUrl:inv.hubUrl,...(inv.sitesToken?{sitesToken:inv.sitesToken}:{}),dataDir,codexPath,projects,workspaceAutoImport:true,pollMs:2000,idlePollMs:15000,maxTaskMs:3600000};writeJson(configFile,c);}
  const result=await httpRequest(inv.hubUrl,'/v1/enroll',{method:'POST',sitesToken:c.sitesToken,proxy:c.proxyUrl,body:{token:inv.token,nodeId:c.nodeId,nodeToken:c.nodeToken}});
  assert(Object.keys(projects).every(p=>result.projects.includes(p)),'Local project not permitted by invitation');
  c={...c,enrollmentState:'enrolled',name:result.name,accountGroup:result.accountGroup,groupSalt:result.groupSalt,projects,codexPath};writeJson(configFile,c);return {nodeId:c.nodeId,name:c.name,projects:Object.keys(c.projects)};
}

export function prepareNode(configFile,{dataDir,codexPath,projects,name}){
  assert(projects&&Object.keys(projects).length,'At least one local project mapping is required');
  let c;if(fs.existsSync(configFile)){c=readJson(configFile);assert(c.enrollmentState==='pending'&&!c.hubUrl,'Existing node is already enrolling or enrolled; retain its configuration');c={...c,projects,codexPath};}
  else c={version:1,enrollmentState:'pending',nodeId:uid(),nodeToken:secret(),hubUrl:null,name:name||'local-pending',dataDir,codexPath,projects,workspaceAutoImport:true,pollMs:2000,maxTaskMs:3600000};
  writeJson(configFile,c);return {nodeId:c.nodeId,name:c.name,enrollmentState:'pending',projects:Object.keys(c.projects)};
}

export function initHub(configFile,{dataDir,port=43127}){
  assert(!fs.existsSync(configFile),'Hub config already exists');mkdir(dataDir);const token=secret();
  writeJson(configFile,{version:1,host:'127.0.0.1',port,dataDir,adminTokenHash:hash(token),defaultGroupLimit:2,groupLimits:{},maxArtifactBytes:512*1024*1024});
  const adminFile=path.join(path.dirname(configFile),'admin.json');writeJson(adminFile,{hubUrl:`http://127.0.0.1:${port}`,adminToken:token});return {configFile,adminFile};
}
