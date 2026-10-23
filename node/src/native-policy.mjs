import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {hash} from './common.mjs';

export function nativeError(state,message,code='NATIVE_CONTINUATION_UNSUPPORTED'){return Object.assign(new Error(message),{nativeState:state,nativeCode:code});}
function requireNative(ok,message){if(!ok)throw nativeError('unsupported',message);}
export function sameNativePath(a,b){return typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();}
const onlyKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
export function nativePolicy(context,thread){
  requireNative(context&&sameNativePath(context.cwd,thread.cwd),'Original conversation permission metadata is missing or its directory changed.');
  const approval=context.approval_policy;
  requireNative(['never','on-request','untrusted'].includes(approval),'This conversation approval policy cannot yet be preserved exactly.');
  const source=context.sandbox_policy;let sandbox;
  if(source?.type==='danger-full-access'&&onlyKeys(source,['type']))sandbox={type:'dangerFullAccess'};
  else if(source?.type==='read-only'&&onlyKeys(source,['type','network_access'])&&(source.network_access===undefined||typeof source.network_access==='boolean'))sandbox={type:'readOnly',networkAccess:source.network_access??false};
  else if(source?.type==='workspace-write'&&onlyKeys(source,['type','writable_roots','network_access','exclude_tmpdir_env_var','exclude_slash_tmp'])&&Array.isArray(source.writable_roots||[])&&(source.writable_roots||[]).every(x=>typeof x==='string'&&path.isAbsolute(x))&&['network_access','exclude_tmpdir_env_var','exclude_slash_tmp'].every(k=>source[k]===undefined||typeof source[k]==='boolean'))sandbox={type:'workspaceWrite',writableRoots:source.writable_roots||[],networkAccess:source.network_access??false,excludeTmpdirEnvVar:source.exclude_tmpdir_env_var??false,excludeSlashTmp:source.exclude_slash_tmp??false};
  requireNative(sandbox,'This conversation sandbox cannot yet be preserved exactly.');
  // Current CLI serializes a richer permission profile beside the legacy
  // sandbox. Accept only profiles proved equivalent to the supported policy.
  const profile=context.permission_profile;
  if(profile){
    const entry=profile.file_system?.entries?.[0],rootRead=onlyKeys(entry,['path','access'])&&entry.access==='read'&&onlyKeys(entry.path,['type','value'])&&entry.path.type==='special'&&onlyKeys(entry.path.value,['kind'])&&entry.path.value.kind==='root';
    const readOnlyRoot=profile.type==='managed'&&onlyKeys(profile,['type','file_system','network'])&&onlyKeys(profile.file_system,['type','entries'])&&profile.file_system.type==='restricted'&&profile.file_system.entries?.length===1&&rootRead&&profile.network===(sandbox.networkAccess?'enabled':'restricted');
    requireNative((sandbox.type==='dangerFullAccess'&&onlyKeys(profile,['type'])&&profile.type==='disabled')||(sandbox.type==='readOnly'&&readOnlyRoot),'This conversation uses a permission profile that Fleet cannot safely reconstruct.');
  }
  requireNative(typeof context.model==='string'&&context.model.length>0,'Original conversation model metadata is missing.');
  const reviewer=context.approvals_reviewer||'user';requireNative(['user','auto_review','guardian_subagent'].includes(reviewer),'Unknown original approval reviewer.');
  const mode=context.collaboration_mode?.mode||null;requireNative(!mode||['default','plan'].includes(mode),'Unknown original collaboration mode.');
  const effort=context.effort??context.collaboration_mode?.settings?.reasoning_effort??thread.reasoningEffort??null;
  requireNative(effort===null||(typeof effort==='string'&&effort.length<80),'Unknown original reasoning effort.');
  const snapshot={cwd:context.cwd,approvalPolicy:approval,approvalsReviewer:reviewer,sandboxPolicy:sandbox,model:context.model,modelProvider:thread.modelProvider,effort,mode};
  return {...snapshot,fingerprint:hash(JSON.stringify(snapshot)+JSON.stringify(profile||null))};
}
async function readPolicyFile(config,thread){
  const home=fs.realpathSync.native(config.codexHome||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
  requireNative(typeof thread.path==='string'&&path.isAbsolute(thread.path),'Codex did not expose a local conversation history path.');
  const file=fs.realpathSync.native(thread.path),allowed=['sessions','archived_sessions'].some(name=>{const root=path.join(home,name);if(!fs.existsSync(root))return false;const relative=path.relative(fs.realpathSync.native(root),file);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);});
  requireNative(allowed&&fs.statSync(file).isFile(),'Conversation history is outside this computer Codex session directories.');
  const context=await latestPolicyContext(file);
  return nativePolicy(context,thread);
}
// A long-running controller can have gigabytes of ordinary history. Read only
// a bounded tail, and never fall back past an invalid latest permission record.
async function latestPolicyContext(file){
  const MAX_SCAN=32*1024*1024,MAX_CONTEXT=4*1024*1024,CHUNK=64*1024;
  const handle=await fs.promises.open(file,'r');
  try{
    const initial=await handle.stat(),floor=Math.max(0,initial.size-MAX_SCAN);
    let position=initial.size,parts=[],length=0,prefix=Buffer.alloc(0),oversized=false;
    function prepend(segment){
      if(!segment.length)return;
      prefix=Buffer.concat([segment.subarray(0,240),prefix]).subarray(0,240);
      length+=segment.length;
      if(length>MAX_CONTEXT){oversized=true;parts=[];}else if(!oversized)parts.push(segment);
    }
    function consume(){
      const isContext=/"type"\s*:\s*"turn_context"/.test(prefix.toString('utf8'));
      if(!isContext){parts=[];length=0;prefix=Buffer.alloc(0);oversized=false;return null;}
      requireNative(!oversized,'Conversation metadata exceeds the bounded reader limit.');
      let entry;try{entry=JSON.parse(Buffer.concat(parts.reverse(),length).toString('utf8'));}catch{throw nativeError('unsupported','Latest conversation permission metadata is incomplete or invalid. No message was sent.');}
      requireNative(entry.type==='turn_context','Latest conversation permission metadata has an invalid event identity.');
      const p=entry.payload||{};
      return {cwd:p.cwd,approval_policy:p.approval_policy,approvals_reviewer:p.approvals_reviewer,sandbox_policy:p.sandbox_policy,permission_profile:p.permission_profile,model:p.model,effort:p.effort,collaboration_mode:p.collaboration_mode?{mode:p.collaboration_mode.mode,settings:{reasoning_effort:p.collaboration_mode.settings?.reasoning_effort}}:null};
    }
    async function stable(context){const after=await handle.stat();requireNative(after.size===initial.size&&after.mtimeMs===initial.mtimeMs,'Conversation history changed during permission metadata reading. No message was sent.');return context;}
    while(position>floor){
      const start=Math.max(floor,position-CHUNK),buffer=Buffer.alloc(position-start);
      const {bytesRead}=await handle.read(buffer,0,buffer.length,start);
      requireNative(bytesRead===buffer.length,'Conversation history changed during permission metadata reading. No message was sent.');
      let end=buffer.length;
      for(let newline=buffer.lastIndexOf(10,end-1);newline>=0;newline=buffer.lastIndexOf(10,end-1)){
        prepend(buffer.subarray(newline+1,end));const context=consume();if(context)return await stable(context);
        end=newline;if(end===0)break;
      }
      prepend(buffer.subarray(0,end));position=start;
    }
    // A tail-window boundary is not a line boundary. Never parse its fragment.
    if(floor===0){const context=consume();if(context)return await stable(context);}
    throw nativeError('unsupported','No complete recent permission metadata was found within the bounded conversation tail. No message was sent.');
  }finally{await handle.close();}
}
export async function readNativePolicy(config,thread){try{return await readPolicyFile(config,thread);}catch(e){if(e.nativeState)throw e;throw nativeError('unsupported','Original conversation permission metadata could not be verified locally. No message was sent.');}}
function comparableSandbox(s){if(s?.type==='readOnly')return {type:s.type,networkAccess:s.networkAccess??false};if(s?.type==='workspaceWrite')return {type:s.type,writableRoots:s.writableRoots||[],networkAccess:s.networkAccess??false,excludeTmpdirEnvVar:s.excludeTmpdirEnvVar??false,excludeSlashTmp:s.excludeSlashTmp??false};return s;}
export async function resumeNativeThread(rpc,config,binding,{readPolicy=readNativePolicy}={}){
  let response;try{response=await rpc.call('thread/read',{threadId:binding.threadId,includeTurns:false},15000);}catch(e){if([-32601,-32602].includes(e.code))throw nativeError('unsupported','This Codex installation cannot verify the original conversation. No message was sent.');throw e;}const {thread}=response;
  requireNative(thread?.id===binding.threadId&&sameNativePath(thread.cwd,binding.cwd)&&sameNativePath(fs.realpathSync.native(thread.cwd),binding.realRoot),'Original conversation directory no longer matches its verified source.');
  if(thread.status?.type==='active')throw nativeError('busy','This conversation is currently running. No message was sent.','NATIVE_CONTINUATION_BUSY');
  const before=await readPolicy(config,thread);
  const sandbox=({readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access'})[before.sandboxPolicy.type];
  let resumed;try{resumed=await rpc.call('thread/resume',{threadId:binding.threadId,excludeTurns:true,cwd:before.cwd,model:before.model,modelProvider:before.modelProvider,approvalPolicy:before.approvalPolicy,approvalsReviewer:before.approvalsReviewer,sandbox},20000);}catch(e){if(/already has an active writer/i.test(e.message))throw nativeError('busy','This conversation is still loaded or running in another Codex process. Release it there before retrying; Fleet did not interrupt it.','NATIVE_CONTINUATION_BUSY');if([-32601,-32602].includes(e.code))throw nativeError('unsupported','This Codex installation cannot restore this original conversation policy. No message was sent.');throw e;}
  requireNative(resumed.thread?.id===binding.threadId&&sameNativePath(resumed.thread.cwd,binding.cwd)&&sameNativePath(fs.realpathSync.native(resumed.thread.cwd),binding.realRoot)&&resumed.thread.status?.type==='idle','Codex did not acquire the original idle conversation.');
  const after=await readPolicy(config,thread);requireNative(before.fingerprint===after.fingerprint,'Conversation permission metadata changed during attachment. No message was sent.');
  requireNative(resumed.approvalPolicy===before.approvalPolicy&&resumed.approvalsReviewer===before.approvalsReviewer&&resumed.model===before.model&&resumed.modelProvider===before.modelProvider&&JSON.stringify(comparableSandbox(resumed.sandbox))===JSON.stringify(before.sandboxPolicy),'Codex could not restore the exact original permissions and model. No message was sent.');
  requireNative(!before.mode||resumed.collaborationMode?.mode===before.mode,'Codex could not restore the original conversation mode. No message was sent.');
  return {resumed,policy:before,turnParams:{cwd:before.cwd,model:before.model,approvalPolicy:before.approvalPolicy,approvalsReviewer:before.approvalsReviewer,sandboxPolicy:before.sandboxPolicy,...(before.effort?{effort:before.effort}:{})}};
}
