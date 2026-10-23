import fs from 'node:fs';
import path from 'node:path';
import {CodexRPC,publicSanitizer} from './codex.mjs';
import {assert,hash,now} from './common.mjs';

const key=id=>'desktop-project:'+id;
const canonical=value=>{assert(typeof value==='string'&&path.isAbsolute(value),'Desktop project requires an absolute local directory');assert(fs.statSync(value).isDirectory(),'Desktop project directory is missing');const resolved=fs.realpathSync(value);return process.platform==='win32'?resolved.toLowerCase():resolved;};
function roots(project){assert(project&&typeof project.id==='string'&&project.id&&Array.isArray(project.roots),'Invalid Codex project response');return project.roots.map(r=>{try{return canonical(r.path);}catch{return null;}});}
function unavailable(error){return error?.code===-32601||/method not found|unknown (?:method|variant)|experimental.*(?:required|disabled|not enabled)|unsupported.*project/i.test(String(error?.message));}

export class DesktopProjects {
  constructor(config,store,{rpcFactory}={}){this.config=config;this.store=store;this.clean=publicSanitizer(config);this.inflight=new Map();this.rpcFactory=rpcFactory||(()=>new CodexRPC({...config,fleetExperimentalApi:true},null));}
  validate(binding){
    assert(binding?.status==='ready'&&binding.nodeId===this.config.nodeId&&this.config.projects?.[binding.project],'Desktop registration requires a verified workspace on this computer');
    const saved=this.store.get('workspace:'+binding.id);assert(saved?.status==='ready'&&saved.nodeId===binding.nodeId&&saved.project===binding.project&&saved.source===binding.source,'Desktop registration requires the saved website-selected workspace');
    assert(['created','discovered','configured','registered'].includes(binding.source)&&(binding.source!=='discovered'||typeof binding.sourceThreadId==='string'&&binding.sourceThreadId&&binding.sourceThreadId===saved.sourceThreadId)&&(binding.source!=='registered'||binding.sourceProjectId&&binding.sourceProjectId===saved.sourceProjectId),'Desktop registration has no verified local source');
    const root=canonical(binding.root);assert(root===canonical(binding.realRoot)&&root===canonical(saved.realRoot)&&root===canonical(saved.root),'Workspace directory changed since verification');return root;
  }
  async ensure(binding,{force=false}={}){
    assert(!this.closed,'Desktop project reader stopped');
    const root=this.validate(binding),prior=this.store.get(key(binding.id));
    if(!force&&prior?.root===root&&Date.now()-(prior.checkedAtMs||0)<60000)return prior;
    const running=this.inflight.get(binding.id);if(running)return running;
    const promise=this.register(binding,root,prior).finally(()=>this.inflight.delete(binding.id));this.inflight.set(binding.id,promise);return promise;
  }
  async register(binding,root,prior){
    const rpc=this.rpcFactory();this.readers??=new Set();this.readers.add(rpc);let result;
    try{
      await rpc.start();
      if(binding.source==='registered'){
        const project=(await rpc.call('project/read',{projectId:binding.sourceProjectId},15000)).project;
        assert(project?.id===binding.sourceProjectId&&roots(project).includes(root),'Registered Codex project no longer contains this workspace');
        result={state:'registered',projectId:project.id,name:this.clean(String(project.name||binding.name)).slice(0,120),root,verifiedAt:now(),visibility:'not_verified',source:'app_server_project_api'};
      }else{
      let projects=[],cursor=null;const cursors=new Set();
      do{assert(!this.closed,'Desktop project reader stopped');const page=await rpc.call('project/list',{limit:100,...(cursor?{cursor}:{})},15000);assert(Array.isArray(page.data)&&page.data.length<=100,'Invalid Codex project directory');projects.push(...page.data);assert(projects.length<=10000,'Codex project directory exceeds the safe registration scan limit');cursor=page.nextCursor||null;if(cursor){assert(!cursors.has(cursor),'Codex project cursor repeated');cursors.add(cursor);}}while(cursor);
      assert(!this.closed,'Desktop project reader stopped');
      const matches=projects.map(p=>({project:p,roots:roots(p)})).filter(p=>p.roots.includes(root));
      const exact=matches.filter(p=>p.roots.length===1&&p.roots[0]===root);let project=exact.find(p=>p.project.id===prior?.projectId)?.project||exact[0]?.project;
      assert(project||!matches.length,'Existing Codex project contains additional folders; automatic registration will not expand this task workspace');
      if(!project){
        const idempotencyKey='fleet-'+hash(this.config.nodeId+'\0'+binding.id+'\0'+root);
        const response=await rpc.call('project/create',{idempotencyKey,name:this.clean(String(binding.name||binding.id)).slice(0,120),roots:[{path:fs.realpathSync(binding.root)}],metadata:{source:'codex-fleet',fleetWorkspaceId:binding.id,fleetNodeId:this.config.nodeId}},20000);project=response.project;
      }
      assert(roots(project).length===1&&roots(project)[0]===root,'Codex registered a different project directory');
      // Confirm the durable identity through the protocol; never copy desktop UI
      // project IDs or edit the app global state to manufacture an association.
      const confirmed=(await rpc.call('project/read',{projectId:project.id},15000)).project;
      assert(confirmed?.id===project.id&&roots(confirmed).length===1&&roots(confirmed)[0]===root,'Codex project registration could not be verified');
      result={state:'registered',projectId:project.id,name:this.clean(String(confirmed.name||binding.name)).slice(0,120),root,verifiedAt:now(),visibility:'not_verified',source:'app_server_project_api'};
      }
    }catch(e){result={state:unavailable(e)?'unsupported':'error',root,error:this.clean(String(e.message)).slice(0,600),verifiedAt:now(),visibility:'not_verified',source:'app_server_project_api'};}
    finally{await rpc.close().catch(()=>{});this.readers.delete(rpc);}
    Object.assign(result,{workspaceId:binding.id,nodeId:binding.nodeId,project:binding.project,checkedAtMs:Date.now()});this.store.put(key(binding.id),result);return result;
  }
  async close(){this.closed=true;await Promise.allSettled([...(this.readers||[])].map(rpc=>rpc.close()));}
}
