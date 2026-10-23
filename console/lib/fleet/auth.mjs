import {assert,hash,equal,uid,now,parse} from './util.mjs';
import {first,run} from './db.mjs';
import {localSession} from './accounts.mjs';
import {withAccess} from './access.mjs';
export const projects=n=>n.admin||(n.browser&&n.kind!=='device')?null:parse(n.projects);
export const can=(n,p)=>n.admin||(n.browser&&n.kind!=='device')||projects(n).includes(p);
export const writer=n=>assert(n.admin||n.role==='operator'||!n.browser,'Operator permission required',403);
export const admin=n=>assert(n.admin,'Administrator permission required',403);

export function browserMutation(request,raw=false){if(['GET','HEAD'].includes(request.method))return;const origin=request.headers.get('origin');assert(origin===new URL(request.url).origin,'Same-origin request required',403,'ORIGIN_REQUIRED');const type=request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();assert(type===(raw?'application/octet-stream':'application/json'),'Unsupported content type',415);const site=request.headers.get('sec-fetch-site');assert(!site||site==='same-origin','Cross-site request denied',403);}
export async function authenticate(request,env,{optional=false,consoleOnly=false,raw=false}={}){
  const db=env.DB;assert(db,'Database unavailable',503);const authorization=request.headers.get('authorization');
  if(authorization){assert(!consoleOnly||!request.headers.get('origin'),'Browser cannot use maintenance or device tokens',403);assert(!request.headers.get('origin'),'Bearer credentials are for non-browser clients',403);assert(authorization.startsWith('Bearer '),'Invalid authorization',401,'NODE_AUTH');const token=authorization.slice(7);
    if(env.FLEET_ADMIN_TOKEN&&equal(token,env.FLEET_ADMIN_TOKEN))return {id:'admin',admin:true,browser:false,role:'admin'};
    assert(!consoleOnly,'Console requires browser identity or maintenance token',403);const node=await first(db,'SELECT * FROM nodes WHERE token_hash=? AND revoked=0',hash(token));assert(node,'Invalid or revoked node token',401,'NODE_AUTH');return {...node,admin:false,browser:false,role:'node'};
  }
  const local=await localSession(request,db);if(local){browserMutation(request,raw);return local;}
  const userId=request.headers.get('oai-authenticated-user-id'),email=request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  let member=null;if(userId&&email){assert(userId.length<=300&&email.length<=320,'Invalid platform identity',401);member=await first(db,'SELECT * FROM members WHERE user_id=?',userId);
  if(!member){member=await first(db,'SELECT * FROM members WHERE email=?',email);if(!member&&env.FLEET_OWNER_EMAIL&&email===env.FLEET_OWNER_EMAIL.trim().toLowerCase()&&!await first(db,'SELECT value FROM settings WHERE key=?','removed_member:'+hash(email))){
      await run(db,"INSERT OR IGNORE INTO members(id,user_id,email,role,created) VALUES(?,?,?,'admin',?)",uid(),userId,email,now());member=await first(db,'SELECT * FROM members WHERE email=?',email);
    }
    if(member){assert(!member.user_id||member.user_id===userId,'Membership belongs to another identity',403);await run(db,'UPDATE members SET user_id=? WHERE id=? AND user_id IS NULL',userId,member.id);member=await first(db,'SELECT * FROM members WHERE id=?',member.id);assert(member.user_id===userId,'Identity binding conflict',403);}
  }}
  if(!member){const cookies=Object.fromEntries((request.headers.get('cookie')||'').split(';').map(x=>{const i=x.indexOf('=');return i<0?['','']:[x.slice(0,i).trim(),x.slice(i+1).trim()];}));const deviceToken=cookies['__Host-fleet-device']||cookies.fleet_device;
    if(deviceToken){const row=await first(db,'SELECT s.expires,n.* FROM device_sessions s JOIN nodes n ON n.id=s.node WHERE s.hash=? AND s.expires>? AND n.revoked=0',hash(deviceToken),now());if(row){browserMutation(request,raw);return withAccess({...row,id:'device:'+row.id,nodeId:row.id,kind:'device',email:null,role:row.console_role==='operator'?'operator':'viewer',admin:false,browser:true},row.console_access);}}
    if(optional)return null;assert(false,userId?'This account is not a Fleet member':'Sign in with ChatGPT',userId?403:401,userId?'MEMBERSHIP_REQUIRED':'SIGN_IN_REQUIRED');
  }
  browserMutation(request,raw);let name=email;const encoded=request.headers.get('oai-authenticated-user-full-name');if(encoded)try{name=request.headers.get('oai-authenticated-user-full-name-encoding')==='percent-encoded-utf-8'?decodeURIComponent(encoded):encoded;}catch{}
  return withAccess({id:'member:'+member.id,memberId:member.id,userId,email,name,role:member.role,admin:member.role==='admin',browser:true,kind:'member'},member.group_access);
}
