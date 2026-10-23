import fs from 'node:fs';
import path from 'node:path';
import {CodexRPC,publicSanitizer} from './codex.mjs';
import {assert,within,now} from './common.mjs';
import {DesktopProjects} from './desktop-projects.mjs';
import {WorkspaceCatalog,workspacePath} from './workspace-catalog.mjs';

const key=id=>'workspace:'+id;
const pathEqual=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export class WorkspaceBindings {
  constructor(config,store,{readThread,desktopProjects,catalog}={}){this.config=config;this.store=store;this.clean=publicSanitizer(config);this.lastSync=0;this.readThread=readThread||this.localThread.bind(this);this.desktopProjects=desktopProjects||(config.desktopProjectBridge!==false?new DesktopProjects(config,store):null);this.catalog=catalog||new WorkspaceCatalog(config,store);}
  async localThread(threadId){assert(!this.closed,'Workspace reader stopped');const rpc=new CodexRPC(this.config,null);this.readers??=new Set();this.readers.add(rpc);try{await rpc.start();assert(!this.closed,'Workspace reader stopped');return (await rpc.call('thread/read',{threadId,includeTurns:false},15000)).thread;}finally{await rpc.close();this.readers.delete(rpc);}}
  cached(id){return this.store.get(key(id));}
  root(spec){const binding=this.cached(spec.workspaceId);assert(binding?.status==='ready'&&binding.nodeId===this.config.nodeId&&binding.project===spec.project,'Workspace has not been verified on this computer');assert(fs.existsSync(binding.root)&&fs.statSync(binding.root).isDirectory(),'Workspace directory is missing');assert(pathEqual(fs.realpathSync(binding.root),binding.realRoot),'Workspace directory link changed since verification');return binding.root;}
  async verify(workspace,{fresh=true}={}){
    assert(workspace&&/^[a-zA-Z0-9_-]{1,100}$/.test(workspace.id),'Invalid workspace ID');assert(workspace.nodeId===this.config.nodeId,'Workspace belongs to a different computer');const project=this.config.projects?.[workspace.project];assert(project?.root,'Project is not configured on this computer');let root;
    if(workspace.source==='created'){
      assert(fs.existsSync(project.root)&&fs.statSync(project.root).isDirectory(),'Base project directory is missing');
      root=within(project.root,path.join('projects',workspace.id));
      if(workspace.root)assert(pathEqual(workspace.root,root),'Created workspace root differs from its fixed local directory');
      fs.mkdirSync(root,{recursive:true});within(project.root,path.join('projects',workspace.id));
    }else if(workspace.source==='configured'){
      assert(typeof workspace.root==='string'&&pathEqual(project.root,workspace.root),'Workspace differs from its local configured project');root=path.resolve(project.root);workspacePath(root);
    }else if(workspace.source==='registered'){
      assert(typeof workspace.sourceProjectId==='string'&&workspace.sourceProjectId,'Workspace requires a local Codex project');
      const proof=this.store.get('workspace-proof:'+workspace.id);
      if(!fresh&&proof?.source==='registered'&&proof.sourceProjectId===workspace.sourceProjectId&&proof.project===workspace.project&&Date.now()-Date.parse(proof.verifiedAt)<120000&&pathEqual(proof.root,workspace.root))assert(workspacePath(workspace.root)===proof.realRoot,'Workspace link changed');
      else {const p=await this.catalog.readProject(workspace.sourceProjectId);assert(p?.id===workspace.sourceProjectId&&p.roots?.some(r=>{try{return workspacePath(r.path)===workspacePath(workspace.root);}catch{return false;}}),'Workspace is not a registered local Codex project root');}
      root=path.resolve(workspace.root);
    }else{
      assert(workspace.source==='discovered'&&typeof workspace.sourceThreadId==='string','Existing workspace requires an observed local source thread');
      const proof=this.store.get('workspace-proof:'+workspace.id),cached=!fresh&&proof?.source==='discovered'&&proof.sourceThreadId===workspace.sourceThreadId&&proof.project===workspace.project&&Date.now()-Date.parse(proof.verifiedAt)<120000&&pathEqual(proof.root,workspace.root)&&workspacePath(proof.root)===proof.realRoot;
      const thread=cached?{id:proof.sourceThreadId,cwd:proof.root}:await this.readThread(workspace.sourceThreadId);assert(thread?.id===workspace.sourceThreadId&&typeof thread.cwd==='string'&&path.isAbsolute(thread.cwd),'Source thread could not be verified locally');
      assert(typeof workspace.root==='string'&&pathEqual(workspace.root,thread.cwd),'Workspace path differs from this computer source thread');
      root=path.resolve(thread.cwd);assert(fs.existsSync(root)&&fs.statSync(root).isDirectory(),'Observed project directory no longer exists');
    }
    const result={id:workspace.id,nodeId:this.config.nodeId,project:workspace.project,name:workspace.name||workspace.id,source:workspace.source,sourceThreadId:workspace.sourceThreadId||null,sourceProjectId:workspace.sourceProjectId||null,autoImported:!!workspace.autoImported,controllerThreadId:workspace.controllerThreadId||null,automationNote:String(workspace.automationNote||'').slice(0,8000),root,realRoot:fs.realpathSync(root),status:'ready',verifiedAt:now()};
    this.store.put(key(workspace.id),result);return result;
  }
  async sync(api,{force=false,requiredId,registerDesktop=true}={}){
    if(this.closed)return;
    if(!force&&!requiredId&&Date.now()-this.lastSync<10000)return;this.lastSync=Date.now();
    if(!requiredId)await this.catalog.sync(api,{force});
    const response=await api('/v1/workspaces?nodeId='+encodeURIComponent(this.config.nodeId));assert(Array.isArray(response.workspaces),'Invalid project workspace response');
    let required=null;
    for(const workspace of response.workspaces){
      if(this.closed)break;
      if(workspace.nodeId!==this.config.nodeId)continue;if(requiredId&&workspace.id!==requiredId)continue;
      const prior=this.cached(workspace.id);
      const desktopFresh=prior?.desktopProject&&(prior.desktopProject.state==='registered'||Date.now()-(prior.desktopProject.checkedAtMs||0)<(prior.desktopProject.state==='unsupported'?300000:60000));
      if(!requiredId&&workspace.status==='ready'&&prior?.status==='ready'&&prior.serverUpdatedAt===workspace.updatedAt&&Date.now()-Date.parse(prior.verifiedAt)<60000&&(!this.desktopProjects||desktopFresh||workspace.autoImported))continue;
      try{const binding=await this.verify(workspace,{fresh:!!requiredId});if(this.desktopProjects&&registerDesktop&&(!workspace.autoImported||requiredId))binding.desktopProject=await this.desktopProjects.ensure(binding,{force:!!requiredId});else if(prior?.desktopProject)binding.desktopProject=prior.desktopProject;if(workspace.status!=='ready'){const saved=await api('/v1/workspaces/'+encodeURIComponent(workspace.id)+'/ack',{method:'POST',body:{status:'ready',root:binding.root}});binding.serverUpdatedAt=saved.updatedAt||workspace.updatedAt;}else binding.serverUpdatedAt=workspace.updatedAt;this.store.put(key(workspace.id),binding);if(workspace.id===requiredId)required=binding;}
      catch(e){const error=this.clean(String(e.message)).slice(0,1000);this.store.put(key(workspace.id),{id:workspace.id,nodeId:this.config.nodeId,project:workspace.project,status:'error',error,at:now()});await api('/v1/workspaces/'+encodeURIComponent(workspace.id)+'/ack',{method:'POST',body:{status:'error',error}});if(workspace.id===requiredId)throw e;}
    }
    this.store.put('workspaceSync',{at:now(),error:null});if(requiredId)assert(required,'Requested workspace is not registered for this computer');return required;
  }
  ensure(id,api,{registerDesktop=true}={}){return this.sync(api,{requiredId:id,force:true,registerDesktop});}
  async close(){this.closed=true;await Promise.allSettled([...(this.readers||[])].map(rpc=>rpc.close()));await this.desktopProjects?.close();await this.catalog.close();}
  desktopSummary(){const states=this.store.db.prepare("SELECT value FROM metadata WHERE key LIKE 'desktop-project:%'").all().map(row=>JSON.parse(row.value));return {enabled:!!this.desktopProjects,registered:states.filter(x=>x.state==='registered').length,unsupported:states.filter(x=>x.state==='unsupported').length,errors:states.filter(x=>x.state==='error').length,visibility:'not_verified',checkedAt:states.map(x=>x.verifiedAt).filter(Boolean).sort().at(-1)||null};}
}
