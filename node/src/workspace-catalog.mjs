import fs from 'node:fs';
import path from 'node:path';
import {CodexRPC,publicSanitizer} from './codex.mjs';
import {assert,hash,now} from './common.mjs';

export function workspacePath(root){assert(typeof root==='string'&&path.isAbsolute(root),'Workspace requires an absolute local directory');assert(fs.statSync(root).isDirectory(),'Workspace directory is missing');const real=fs.realpathSync(root);return process.platform==='win32'?real.toLowerCase():real;}
const contains=(root,cwd)=>{const rel=path.relative(root,cwd);return !rel||(!rel.startsWith('..')&&!path.isAbsolute(rel));};

// Only this computer's configured roots, official project registry and locally
// observed Codex threads are imported. No drive scan or remote path trust.
export class WorkspaceCatalog {
  constructor(config,store,{rpcFactory}={}){this.config=config;this.store=store;this.clean=publicSanitizer(config);this.rpcFactory=rpcFactory||(()=>new CodexRPC({...config,fleetExperimentalApi:true},null));this.nextScan=0;}
  summary(){return {enabled:this.config.workspaceAutoImport!==false,...(this.store.get('workspaceCatalog')||{state:'pending',count:0})};}
  async registry(){const rpc=this.rpcFactory();this.rpc=rpc;try{await rpc.start();const result=[],seen=new Set();let cursor=null;do{assert(!this.closed,'Workspace catalog stopped');const page=await rpc.call('project/list',{limit:100,...(cursor?{cursor}:{})},15000);assert(Array.isArray(page.data),'Invalid Codex project directory');result.push(...page.data);assert(result.length<=10000,'Too many Codex projects');cursor=page.nextCursor||null;if(cursor){assert(!seen.has(cursor),'Repeated Codex project cursor');seen.add(cursor);}}while(cursor);return result;}finally{await rpc.close().catch(()=>{});this.rpc=null;}}
  async readProject(projectId){assert(!this.closed,'Workspace catalog stopped');const rpc=this.rpcFactory();this.readers??=new Set();this.readers.add(rpc);try{await rpc.start();assert(!this.closed,'Workspace catalog stopped');return (await rpc.call('project/read',{projectId},15000)).project;}finally{await rpc.close().catch(()=>{});this.readers.delete(rpc);}}
  async scan(){
    const entries=new Map(),projects=this.config.projects||{},fallback=projects.workspace?'workspace':Object.keys(projects)[0];let skipped=0,registryError=null;
    const projectFor=root=>Object.entries(projects).sort((a,b)=>String(b[1].root).length-String(a[1].root).length).find(([,p])=>p.root&&contains(path.resolve(p.root),root))?.[0]||fallback;
    const add=(root,item)=>{try{const realRoot=workspacePath(root),project=item.project||projectFor(path.resolve(root));if(!project||!projects[project])return;if(entries.has(realRoot))return;entries.set(realRoot,{...item,id:'auto-'+hash(this.config.nodeId+'\0'+realRoot).slice(0,48),nodeId:this.config.nodeId,project,name:String(item.name||path.basename(root)||root).slice(0,160),root:path.resolve(root),realRoot});}catch{skipped++;}};
    try{for(const p of await this.registry())if(p&&typeof p.id==='string'&&Array.isArray(p.roots))for(const root of p.roots)add(root.path,{name:p.name,source:'registered',sourceProjectId:p.id});}
    catch(e){registryError=this.clean(String(e.message)).slice(0,300);}
    for(const [project,p] of Object.entries(projects))add(p.root,{project,name:p.name||path.basename(p.root)||project,source:'configured'});
    if(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_threads'").get())for(const row of this.store.db.prepare('SELECT payload FROM desktop_threads').all()){let t;try{t=JSON.parse(row.payload);}catch{continue;}if(t.threadId&&t.cwd)add(t.cwd,{source:'discovered',sourceThreadId:t.threadId,project:projects[t.project]?t.project:undefined});}
    return {entries:[...entries.values()],skipped,registryError};
  }
  async sync(api,{force=false}={}){
    if(this.closed||this.config.workspaceAutoImport===false||(!force&&Date.now()<this.nextScan))return;
    this.nextScan=Date.now()+60000;
    try{const {entries,skipped,registryError}=await this.scan();let count=0;
      for(let i=0;i<entries.length&&!this.closed;i+=40){const batch=entries.slice(i,i+40);for(const item of batch)this.store.put('workspace-proof:'+item.id,{...item,verifiedAt:now()});const response=await api('/v1/workspaces/sync',{method:'POST',body:{workspaces:batch.map(({realRoot,nodeId,...item})=>item)}});assert(Array.isArray(response.workspaces),'Invalid workspace catalog acknowledgement');count+=response.workspaces.length;}
      this.store.put('workspaceCatalog',{state:registryError?'partial':'synced',count,skipped,registryError,lastSuccess:now(),error:null});
    }catch(e){this.nextScan=Date.now()+15000;this.store.put('workspaceCatalog',{...(this.store.get('workspaceCatalog')||{}),state:'retrying',error:this.clean(String(e.message)).slice(0,400),attemptedAt:now()});}
  }
  async close(){this.closed=true;await Promise.allSettled([this.rpc,...(this.readers||[])].filter(Boolean).map(r=>r.close()));}
}
