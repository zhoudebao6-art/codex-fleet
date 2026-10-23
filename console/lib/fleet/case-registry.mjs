import {assert,canonical,hash,json,now,validId,relativeFile} from './util.mjs';
import {all,first,run} from './db.mjs';
import {admin} from './auth.mjs';

const capabilities={create:true,link:true,import:true,resume:true,requirements:true};
export const BUILTIN_CASE_FLOWS=[
 {id:'auto20',version:1,name:'自动化 2.0',description:'复用原自动化的准备、制作、独立审核和主控汇总。',adapter:'delivery-v1',deliveryProfile:'auto20',fields:[],capabilities},
 {id:'software',version:1,name:'研发系统交付',description:'复用现有研发系统交付与本地总控，按原案件接续。',adapter:'delivery-v1',deliveryProfile:'software',fields:[],capabilities}
];
// Registry entries are data contracts, never executable server code. A new
// adapter needs a server implementation; unknown adapters cannot dispatch.
export function normalizeCaseFlow(b){
 assert(b&&validId(b.id)&&!BUILTIN_CASE_FLOWS.some(x=>x.id===b.id),'Choose a new flow ID');
 assert(Number.isSafeInteger(b.version)&&b.version>0,'A positive flow version is required');
 assert(typeof b.name==='string'&&b.name.trim()&&b.name.length<=120,'Provide a flow name');
 assert(typeof (b.description||'')==='string'&&(b.description||'').length<=2000,'Invalid flow description');
 assert(b.adapter==='desktop-evidence-v1','Unsupported executable adapter',400,'CASE_ADAPTER_UNSUPPORTED');
 assert(typeof b.taskPrompt==='string'&&b.taskPrompt.trim().length>=10&&b.taskPrompt.length<=12000,'Provide the concrete automation instructions');
 assert(Array.isArray(b.outputs)&&b.outputs.length>=1&&b.outputs.length<=16&&b.outputs.every(x=>relativeFile(x)&&!x.includes('\\')&&!['receipt.json','review.json','collection.json'].includes(x.split('/')[0].toLowerCase()))&&new Set(b.outputs.map(x=>x.toLowerCase())).size===b.outputs.length,'Provide unique relative output names');
 assert(!b.outputs.some(a=>b.outputs.some(c=>a!==c&&c.toLowerCase().startsWith(a.toLowerCase()+'/'))),'Output files cannot also be parent directories');
 assert(Array.isArray(b.requiredSkills||[])&&(b.requiredSkills||[]).length<=8&&(b.requiredSkills||[]).every(x=>typeof x==='string'&&/^[\w:-]{1,100}$/.test(x)),'Invalid required skills');
 return {id:b.id,version:b.version,name:b.name.trim(),description:b.description||'',adapter:b.adapter,taskPrompt:b.taskPrompt.trim(),outputs:b.outputs,requiredSkills:b.requiredSkills||[],fields:[],capabilities:{...capabilities,link:false}};
}
export async function caseFlows(db){
 const rows=await all(db,"SELECT declaration FROM case_flow_registry r WHERE version=(SELECT MAX(version) FROM case_flow_registry x WHERE x.id=r.id) AND NOT EXISTS(SELECT 1 FROM settings s WHERE s.key='case-flow-disabled:'||r.id AND s.value='true') ORDER BY id");
 return {flows:[...BUILTIN_CASE_FLOWS,...rows.map(r=>JSON.parse(r.declaration))],adapterContracts:[{id:'delivery-v1',version:1,registration:'built-in',phases:['baseline','preflight','produce','independent-review','collect']},{id:'desktop-evidence-v1',version:1,registration:'manifest',phases:['produce','review','collect'],evidence:'exact revision/request hash, uploaded artifact hashes, distinct reviewer conversation and controller collection receipt'}]};
}
export async function getCaseFlow(db,id,version){
 const builtin=BUILTIN_CASE_FLOWS.find(x=>x.id===id&&(!version||version===x.version));if(builtin)return builtin;
 const row=await first(db,'SELECT declaration FROM case_flow_registry WHERE id=?'+(version?' AND version=?':' ORDER BY version DESC LIMIT 1'),id,...(version?[version]:[]));
 assert(row,'Automation flow not found',404);return JSON.parse(row.declaration);
}
export async function registerCaseFlow(db,actor,b){
 admin(actor);const declaration=normalizeCaseFlow(b),digest=hash(canonical(declaration));
 await run(db,'INSERT OR IGNORE INTO case_flow_registry(id,version,declaration,declaration_hash,creator,created_at) VALUES(?,?,?,?,?,?)',declaration.id,declaration.version,json(declaration),digest,actor.id,now());
 const saved=await first(db,'SELECT declaration_hash FROM case_flow_registry WHERE id=? AND version=?',declaration.id,declaration.version);
 assert(saved?.declaration_hash===digest,'This flow version already has a different immutable contract',409);
 return declaration;
}
export async function setCaseFlowEnabled(db,actor,id,b){
 admin(actor);assert(validId(id)&&!BUILTIN_CASE_FLOWS.some(x=>x.id===id)&&typeof b.enabled==='boolean','Choose a registered flow and enabled state');await getCaseFlow(db,id);
 await run(db,'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value','case-flow-disabled:'+id,json(!b.enabled));
 return {id,enabled:b.enabled};
}
