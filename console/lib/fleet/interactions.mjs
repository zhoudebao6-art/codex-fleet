import {assert,now,json,parse,hash,canonical,validId} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {taskAccess} from './tasks.mjs';

const ACTIVE=['claimed','running','uncertain'];
const ACTIVE_SQL="'claimed','running','uncertain'";
const APPROVAL_METHODS=new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval']);
const SCALAR_TYPES=new Set(['string','number','integer','boolean','null']);
const SAFE_SCHEMA_KEYS=new Set(['$schema','type','title','description','properties','required','additionalProperties','items','enum','const','default','minLength','maxLength','minimum','maximum','minItems','maxItems','format']);
const BAD_KEYS=new Set(['__proto__','prototype','constructor']);

function short(value,name,max,{required=false}={}) {
  if(value===undefined||value===null){assert(!required,`${name} required`);return undefined;}
  assert(typeof value==='string'&&value.length<=max&&(!required||value.length>0),`Invalid ${name}`);return value.replace(/\u0000/g,'');
}
function date(value,name) {
  assert(typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value)),`Invalid ${name}`);return new Date(value).toISOString();
}
function plain(value) {return value&&typeof value==='object'&&!Array.isArray(value);}
function safeJSON(value,depth=0) {
  assert(depth<=8,'Interaction data is too deeply nested');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){assert(value.length<=8000,'Interaction text too long');return value;}
  if(typeof value==='number'){assert(Number.isFinite(value),'Invalid interaction number');return value;}
  if(Array.isArray(value)){assert(value.length<=100,'Interaction list too long');return value.map(x=>safeJSON(x,depth+1));}
  assert(plain(value),'Invalid interaction value');const keys=Object.keys(value);assert(keys.length<=100,'Too many interaction fields');const result={};
  for(const key of keys){assert(key.length<=200&&!BAD_KEYS.has(key),'Invalid interaction field');result[key]=safeJSON(value[key],depth+1);}return result;
}
function schema(value,depth=0) {
  assert(plain(value)&&depth<=6,'Invalid requested schema');const out={};
  for(const [key,v] of Object.entries(value)) {
    // Preserve unknown schema keywords only as a marker. They are never treated
    // as validated constraints; an accept response will explicitly be refused.
    if(!SAFE_SCHEMA_KEYS.has(key)){out.unsupported=true;continue;}
    if(key==='properties'){assert(plain(v)&&Object.keys(v).length<=50,'Invalid schema properties');out.properties={};for(const [name,prop] of Object.entries(v)){assert(name.length<=100&&!BAD_KEYS.has(name),'Invalid schema property');out.properties[name]=schema(prop,depth+1);}}
    else if(key==='items')out.items=schema(v,depth+1);
    else if(key==='required'){assert(Array.isArray(v)&&v.length<=50&&v.every(x=>typeof x==='string'&&x.length<=100&&!BAD_KEYS.has(x)),'Invalid required properties');out.required=[...v];}
    else if(key==='type'){if(typeof v!=='string'||(!SCALAR_TYPES.has(v)&&!['object','array'].includes(v)))out.unsupported=true;else out.type=v;}
    else if(key==='additionalProperties'){if(typeof v!=='boolean')out.unsupported=true;else out.additionalProperties=v;}
    else if(['title','description','$schema','format'].includes(key))out[key]=short(v,'schema '+key,key==='description'?4000:500,{required:true});
    else if(['enum','const','default'].includes(key))out[key]=safeJSON(v);
    else {assert(Number.isFinite(v)&&v>=-1000000000&&v<=1000000000,'Invalid schema bound');out[key]=v;}
  }
  if(!out.type)out.unsupported=true;return out;
}
function normalizeRequest(kind,input) {
  assert(plain(input),'Interaction request required');const out={};
  if(kind==='approval')assert(!['additionalPermissions','permissions','networkApprovalContext','proposedExecpolicyAmendment','proposedNetworkPolicyAmendments','execPolicyAmendment','grantRoot','allowNetwork'].some(key=>input[key]!==undefined&&input[key]!==null),'Permission changes must be handled on the execution computer',409,'UNSUPPORTED_APPROVAL');
  for(const [key,max] of [['message',8000],['command',8000],['reason',4000],['cwd',2000],['display',8000],['serverName',200],['mode',40]]) {
    const value=short(input[key],key,max);if(value!==undefined)out[key]=value;
  }
  if(input.url!==undefined){const raw=short(input.url,'interaction URL',2000,{required:true});let url;try{url=new URL(raw);}catch{assert(false,'Invalid interaction URL');}assert(url.protocol==='https:'&&!url.username&&!url.password,'Interaction URL must be HTTPS without credentials');out.url=url.href;}
  if(input.availableDecisions!==undefined){assert(Array.isArray(input.availableDecisions)&&input.availableDecisions.length<=20&&input.availableDecisions.every(x=>typeof x==='string'&&x.length<=100),'Invalid available decisions');out.availableDecisions=[...input.availableDecisions];}
  if(input.requestedSchema!==undefined)out.requestedSchema=schema(input.requestedSchema);
  if(input.questions!==undefined) {
    assert(Array.isArray(input.questions)&&input.questions.length>0&&input.questions.length<=20,'Invalid interaction questions');const ids=new Set();
    out.questions=input.questions.map(q=>{
      assert(plain(q)&&validId(q.id)&&!ids.has(q.id),'Invalid question ID');ids.add(q.id);
      const result={id:q.id,question:short(q.question,'question text',4000,{required:true})};
      for(const k of ['header']){const v=short(q[k],k,200);if(v!==undefined)result[k]=v;}
      for(const k of ['isOther','isSecret','allowMultiple'])if(q[k]!==undefined){assert(typeof q[k]==='boolean','Invalid question flag');result[k]=q[k];}
      if(q.options!==undefined&&q.options!==null){assert(Array.isArray(q.options)&&q.options.length<=30,'Invalid question options');result.options=q.options.map(option=>({label:short(option.label,'option label',300,{required:true}),description:short(option.description,'option description',1000)||''}));}
      return result;
    });
  }
  if(kind==='questions')assert(out.questions?.length,'Questions are required');
  assert(json(out).length<=64000,'Interaction request too large',413);return out;
}
function isSupportedSchema(s) {
  if(!s||s.unsupported||!s.type)return false;
  if(s.format&&!['email','uri','date','date-time'].includes(s.format))return false;
  if(s.type==='object')return Object.values(s.properties||{}).every(isSupportedSchema);
  if(s.type==='array')return !!s.items&&isSupportedSchema(s.items);
  return SCALAR_TYPES.has(s.type);
}
function validateContent(value,s,path='content') {
  assert(isSupportedSchema(s),'This requested schema cannot be accepted remotely; decline or cancel the request',409,'UNSUPPORTED_INTERACTION_SCHEMA');
  if(s.enum!==undefined)assert(Array.isArray(s.enum)&&s.enum.some(x=>canonical(x)===canonical(value)),`${path} is not an allowed value`);
  if(s.const!==undefined)assert(canonical(value)===canonical(s.const),`${path} does not match the required value`);
  if(s.type==='object') {
    assert(plain(value),`${path} must be an object`);const properties=s.properties||{};
    for(const key of s.required||[])assert(Object.hasOwn(value,key),`${path}.${key} is required`);
    for(const [key,v] of Object.entries(value)){assert(Object.hasOwn(properties,key),`${path}.${key} is not a requested field`);validateContent(v,properties[key],path+'.'+key);}return;
  }
  if(s.type==='array'){assert(Array.isArray(value),`${path} must be an array`);assert((s.minItems===undefined||value.length>=s.minItems)&&(s.maxItems===undefined||value.length<=s.maxItems),`${path} has an invalid item count`);value.forEach((v,i)=>validateContent(v,s.items,path+'['+i+']'));return;}
  if(s.type==='null'){assert(value===null,`${path} must be null`);return;}
  if(s.type==='integer')assert(Number.isSafeInteger(value),`${path} must be an integer`);else assert(typeof value===s.type,`${path} must be ${s.type}`);
  if(typeof value==='number')assert((s.minimum===undefined||value>=s.minimum)&&(s.maximum===undefined||value<=s.maximum),`${path} is out of range`);
  if(typeof value==='string') {
    assert((s.minLength===undefined||value.length>=s.minLength)&&(s.maxLength===undefined||value.length<=s.maxLength),`${path} has an invalid length`);
    if(s.format==='email')assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),`${path} must be an email`);
    if(s.format==='uri'){try{new URL(value);}catch{assert(false,`${path} must be a URI`);}}
    if(s.format==='date')assert(/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value)),`${path} must be a date`);
    if(s.format==='date-time')assert(Number.isFinite(Date.parse(value)),`${path} must be a timestamp`);
  }
}
function normalizeResponse(row,input) {
  assert(plain(input),'Interaction response required');assert(Buffer.byteLength(json(input),'utf8')<=32768,'Interaction response too large',413);const request=parse(row.request);
  if(row.kind==='elicitation') {
    assert(['accept','decline','cancel'].includes(input.action),'Invalid elicitation action');
    const result={action:input.action};if(input.action==='accept'&&request.mode==='url'){assert(request.url,'URL elicitation requires a secure URL');return result;}if(input.action==='accept'){const content=safeJSON(input.content);validateContent(content,request.requestedSchema);result.content=content;}return result;
  }
  if(row.kind==='questions') {
    assert(plain(input.answers),'Question answers required');const result={answers:{}};const known=new Map(request.questions.map(q=>[q.id,q]));
    for(const [id,value] of Object.entries(input.answers)){assert(known.has(id)&&plain(value)&&Array.isArray(value.answers)&&value.answers.length<=20,'Invalid question answer');const q=known.get(id);assert(value.answers.every(v=>typeof v==='string'&&v.length<=4000),'Invalid answer text');assert(q.allowMultiple||value.answers.length<=1,'This question accepts one answer');result.answers[id]={answers:[...value.answers]};}
    assert(request.questions.every(q=>Object.hasOwn(result.answers,q.id)),'Answer every question');return result;
  }
  assert(APPROVAL_METHODS.has(row.method),'This approval cannot be answered remotely',409);
  assert(['accept','decline','cancel'].includes(input.decision),'Only a single-turn approval is supported');
  if(request.availableDecisions?.length)assert(request.availableDecisions.includes(input.decision),'Decision is not offered by this request');
  return {decision:input.decision};
}
function interactionView(row,task) {
  const expired=row.status!=='resolved'&&(!ACTIVE.includes(task.status)||task.attempt!==row.attempt||row.expires_at<=now());
  return {id:row.id,taskId:row.task,nodeId:row.node,attemptId:row.attempt,kind:row.kind,method:row.method,request:parse(row.request),status:expired?'expired':row.status,
    expiresAt:row.expires_at,createdAt:row.created_at,response:!expired&&row.response?parse(row.response):null,answeredBy:row.answered_by,answeredAt:row.answered_at,resolvedAt:row.resolved_at};
}
function assertNode(n,task,attempt) {
  assert(!n.browser&&!n.admin&&n.id===task.target,'Execution node required',403);
  assert(task.attempt===attempt&&validId(attempt),'Task attempt mismatch',409);
}
function current(task,expiresAt) {assert(ACTIVE.includes(task.status)&&expiresAt>now(),'Interaction is expired or task is no longer running',409,'INTERACTION_EXPIRED');}
export async function createInteraction(db,n,taskId,b) {
  const task=await taskAccess(db,n,taskId);assertNode(n,task,b.attemptId);
  assert(validId(b.id)&&['elicitation','questions','approval'].includes(b.kind),'Invalid interaction identity');
  const method=short(b.method,'interaction method',160,{required:true});
  if(b.kind==='approval')assert(APPROVAL_METHODS.has(method),'Approval method requires local handling',409,'UNSUPPORTED_APPROVAL');
  const request=normalizeRequest(b.kind,b.request),expiresAt=date(b.expiresAt,'interaction expiry'),fingerprint=hash(canonical({taskId,attemptId:b.attemptId,kind:b.kind,method,request,expiresAt}));
  const old=await first(db,'SELECT * FROM task_interactions WHERE id=?',b.id);
  if(old){assert(old.node===n.id&&old.task===taskId&&old.request_hash===fingerprint,'Interaction ID already used with a different request',409);return interactionView(old,task);}
  current(task,expiresAt);assert(Date.parse(expiresAt)<=Date.now()+86400000,'Interaction expiry exceeds 24 hours');
  const ts=now();await batch(db,[
    [`INSERT OR IGNORE INTO task_interactions(id,task,node,attempt,kind,method,request,request_hash,status,expires_at,created_at) SELECT ?,?,?,?,?,?,?,?,'pending',?,? FROM tasks WHERE id=? AND target=? AND attempt=? AND status IN (${ACTIVE_SQL})`,b.id,taskId,n.id,b.attemptId,b.kind,method,json(request),fingerprint,expiresAt,ts,taskId,n.id,b.attemptId],
    ["INSERT OR IGNORE INTO events(id,node,task,type,payload,created) SELECT ?,node,task,'interaction_requested',?,created_at FROM task_interactions WHERE id=? AND request_hash=?",'interaction-request:'+b.id,json({interactionId:b.id,kind:b.kind,method}),b.id,fingerprint],
  ]);
  const saved=await first(db,'SELECT * FROM task_interactions WHERE id=?',b.id);assert(saved&&saved.node===n.id&&saved.task===taskId&&saved.request_hash===fingerprint,'Interaction changed before it could be created',409);return interactionView(saved,await taskAccess(db,n,taskId));
}
export async function listInteractions(db,n,taskId) {
  const task=await taskAccess(db,n,taskId),rows=await all(db,'SELECT * FROM task_interactions WHERE task=? ORDER BY created_at DESC,id DESC LIMIT 100',taskId);
  return {interactions:rows.map(row=>interactionView(row,task)),serverTime:now()};
}
export async function answerInteraction(db,n,taskId,id,b) {
  assert(n.browser&&(n.admin||n.role==='operator'),'A signed-in human operator must answer this request',403,'HUMAN_RESPONSE_REQUIRED');
  const task=await taskAccess(db,n,taskId),row=await first(db,'SELECT * FROM task_interactions WHERE id=? AND task=?',id,taskId);assert(row,'Interaction not found',404);
  assert(task.attempt===row.attempt,'Task attempt mismatch',409);current(task,row.expires_at);
  const response=normalizeResponse(row,b.response),digest=hash(canonical(response)),ts=now();
  if(row.response_hash){assert(row.response_hash===digest,'Interaction already has a different answer',409);return interactionView(row,task);}
  await batch(db,[
    [`UPDATE task_interactions SET status='answered',response=?,response_hash=?,answered_by=?,answered_at=? WHERE id=? AND task=? AND status='pending' AND expires_at>? AND EXISTS(SELECT 1 FROM tasks WHERE id=task_interactions.task AND attempt=task_interactions.attempt AND status IN (${ACTIVE_SQL}))`,json(response),digest,n.id,ts,id,taskId,ts],
    ["INSERT OR IGNORE INTO events(id,node,task,type,payload,created) SELECT ?,answered_by,task,'interaction_answered',?,answered_at FROM task_interactions WHERE id=? AND response_hash=?",'interaction-answer:'+id,json({interactionId:id,kind:row.kind}),id,digest],
  ]);
  const saved=await first(db,'SELECT * FROM task_interactions WHERE id=?',id);assert(saved.response_hash===digest,'Interaction was answered differently or has expired',409);return interactionView(saved,await taskAccess(db,n,taskId));
}
export async function resolveInteraction(db,n,taskId,id,b) {
  const task=await taskAccess(db,n,taskId);assertNode(n,task,b.attemptId);
  const row=await first(db,'SELECT * FROM task_interactions WHERE id=? AND task=?',id,taskId);assert(row,'Interaction not found',404);assert(row.attempt===b.attemptId,'Task attempt mismatch',409);
  if(row.status==='resolved')return interactionView(row,task);
  // Resolution records that an existing human answer was delivered to Codex. A
  // fast turn may finish before this acknowledgement reaches the server.
  assert(row.expires_at>now(),'Interaction acknowledgement expired',409);assert(row.status==='answered','Interaction has not been answered',409);
  const ts=now();await batch(db,[
    ["UPDATE task_interactions SET status='resolved',resolved_at=? WHERE id=? AND task=? AND attempt=? AND status='answered' AND expires_at>? AND EXISTS(SELECT 1 FROM tasks WHERE id=task_interactions.task AND attempt=task_interactions.attempt AND target=task_interactions.node)",ts,id,taskId,b.attemptId,ts],
    ["INSERT OR IGNORE INTO events(id,node,task,type,payload,created) SELECT ?,node,task,'interaction_resolved',?,resolved_at FROM task_interactions WHERE id=? AND status='resolved'",'interaction-resolve:'+id,json({interactionId:id}),id],
  ]);
  const saved=await first(db,'SELECT * FROM task_interactions WHERE id=?',id);assert(saved.status==='resolved','Interaction expired before it could be resolved',409);return interactionView(saved,task);
}

export async function maintenance(db,n,b) {
  assert(!n.browser&&!n.admin,'Node token required',403);assert(typeof b.enabled==='boolean','Maintenance enabled flag required');
  if(!b.enabled){await run(db,'DELETE FROM node_maintenance WHERE node=?',n.id);return {enabled:false,expiresAt:null,reason:null};}
  const expiresAt=b.expiresAt?date(b.expiresAt,'maintenance expiry'):new Date(Date.now()+15*60000).toISOString();
  assert(Date.parse(expiresAt)>Date.now()&&Date.parse(expiresAt)<=Date.now()+3600000,'Maintenance expiry must be within one hour');
  const reason=short(b.reason,'maintenance reason',500)||'Node update';
  await run(db,'INSERT INTO node_maintenance(node,expires_at,reason,updated_at) VALUES(?,?,?,?) ON CONFLICT(node) DO UPDATE SET expires_at=excluded.expires_at,reason=excluded.reason,updated_at=excluded.updated_at',n.id,expiresAt,reason,now());
  return {enabled:true,expiresAt,reason};
}
