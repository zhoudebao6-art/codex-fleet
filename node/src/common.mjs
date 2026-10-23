import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const VERSION = '0.3.24';
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const secret = () => crypto.randomBytes(32).toString('base64url');
export const hash = x => crypto.createHash('sha256').update(x).digest('hex');
export const json = x => JSON.stringify(x);
export const parse = x => JSON.parse(x);
export const isMain = url => !!process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(url);
export function assert(ok, message, status = 400) { if (!ok) throw Object.assign(new Error(message), {status}); }
export function mkdir(p) { fs.mkdirSync(p, {recursive:true}); return p; }
export function readJson(p) { return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')); }
export function writeJson(p, value) {
  mkdir(path.dirname(p)); const temp = `${p}.${uid()}.tmp`;
  fs.writeFileSync(temp, json(value)+'\n', {mode:0o600}); fs.renameSync(temp,p);
}
export function dbOpen(p) {
  mkdir(path.dirname(p)); const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; }
  catch(e) { db.exec('ROLLBACK'); throw e; }
}
export function arg(name, fallback) { const i=process.argv.indexOf('--'+name); return i<0?fallback:process.argv[i+1]; }
export function configPath() { const p=arg('config',process.env.CODEX_FLEET_CONFIG); assert(p,'Use --config <file>'); return path.resolve(p); }
export function safeUrl(value) {
  const u=new URL(value); assert(!u.username&&!u.password&&!u.search&&!u.hash,'Invalid hub URL');
  assert(u.protocol==='https:' || (u.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)), 'Remote hub requires HTTPS; HTTP is allowed only on loopback');
  return u.href.replace(/\/$/,'');
}
export function within(root, relative) {
  assert(typeof relative==='string'&&relative&&!path.isAbsolute(relative),'Expected a relative file path');
  assert(!relative.includes(':')&&!relative.includes('\0'),'Invalid relative file path');
  const r=fs.realpathSync(root), full=path.resolve(r,relative), rel=path.relative(r,full);
  assert(rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel),'Path escapes project');
  let ancestor=full;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
  const actual=fs.realpathSync(ancestor),a=path.relative(r,actual);assert(!a.startsWith('..'+path.sep)&&a!=='..'&&!path.isAbsolute(a),'Symlink escapes project');
  return full;
}
export function fileHash(p) {
  const h=crypto.createHash('sha256'), fd=fs.openSync(p,'r'), b=Buffer.alloc(1024*1024);
  try { let n; while((n=fs.readSync(fd,b,0,b.length,null))) h.update(b.subarray(0,n)); } finally {fs.closeSync(fd);}
  return h.digest('hex');
}
export const transientHttp = status => !status||[408,425,429].includes(status)||status>=500;
function proxyFor(u,explicit){
  if(explicit===false||['localhost','127.0.0.1','[::1]'].includes(u.hostname))return null;
  const bypass=(process.env.NO_PROXY||process.env.no_proxy||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(bypass.some(x=>x==='*'||u.hostname===x||x.startsWith('.')&&u.hostname.endsWith(x)))return null;
  const value=explicit||(u.protocol==='https:'?(process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy):(process.env.HTTP_PROXY||process.env.http_proxy));
  if(!value)return null;const p=new URL(value);assert(['http:','https:'].includes(p.protocol),'Only HTTP(S) proxy endpoints are supported');return p;
}
function proxyTunnel(u,p,timeout){
  return new Promise((resolve,reject)=>{
    const authorization=p.username?{'proxy-authorization':'Basic '+Buffer.from(decodeURIComponent(p.username)+':'+decodeURIComponent(p.password)).toString('base64')}:{},authority=u.hostname+':'+(u.port||443);
    const req=(p.protocol==='https:'?https:http).request(p,{method:'CONNECT',path:authority,agent:false,headers:{host:authority,...authorization}});
    req.setTimeout(timeout,()=>req.destroy(new Error('Proxy connection timeout')));req.on('error',reject);
    req.on('connect',(res,socket,head)=>{if(res.statusCode!==200){socket.destroy();reject(Object.assign(new Error('Proxy CONNECT rejected: HTTP '+res.statusCode),{status:res.statusCode}));return;}if(head.length)socket.unshift(head);
      const secure=tls.connect({socket,servername:net.isIP(u.hostname)?undefined:u.hostname,rejectUnauthorized:true});secure.setTimeout(timeout,()=>secure.destroy(new Error('Proxy TLS timeout')));secure.once('error',reject);secure.once('secureConnect',()=>resolve(secure));});req.end();
  });
}
export async function httpRequest(base, route, {method='GET',token,sitesToken,proxy,body,raw=false,timeout=20000,headers={}}={}) {
  assert(typeof route==='string'&&route.startsWith('/')&&!route.startsWith('//'),'Expected a same-hub route');
  const u=new URL(safeUrl(base)+route); const data=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(json(body)),p=proxyFor(u,proxy);
  const socket=p&&u.protocol==='https:'?await proxyTunnel(u,p,timeout):null;
  return new Promise((resolve,reject)=>{
    const agent=socket?new https.Agent({keepAlive:false}):false;if(socket)agent.createConnection=()=>socket;
    const options={method,agent,headers:{...(token?{authorization:'Bearer '+token}:{}),...(sitesToken?{'OAI-Sites-Authorization':'Bearer '+sitesToken}:{}),...(data?{'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json','content-length':data.length}:{}),...headers}};
    if(p&&u.protocol==='http:'){options.path=u.href;options.headers.host=u.host;if(p.username)options.headers['proxy-authorization']='Basic '+Buffer.from(decodeURIComponent(p.username)+':'+decodeURIComponent(p.password)).toString('base64');}
    const target=p&&u.protocol==='http:'?p:u;
    const req=(target.protocol==='https:'?https:http).request(target,options,res=>{
      const parts=[]; let size=0;
      res.on('data',b=>{size+=b.length;if(size>16*1024*1024){res.destroy(new Error('Response too large'));return;}parts.push(b);});
      res.on('error',reject);res.on('end',()=>{try {const b=Buffer.concat(parts),status=res.statusCode;if(status>=300&&status<400)throw Object.assign(new Error('Hub redirected to a login or another address. Check the invitation URL and Sites service access.'),{status,code:'HUB_LOGIN_REDIRECT'});
        if(status>=400){let message;try{message=parse(b.toString()).error;}catch{}const retryAfter=Number(res.headers['retry-after']);throw Object.assign(new Error(typeof message==='string'?message:`HTTP ${status}`),{status,retryAfterMs:Number.isFinite(retryAfter)?Math.min(300000,retryAfter*1000):undefined});}
        if(!raw&&b.length&&!/^application\/(?:[\w.+-]*\+)?json\b/i.test(res.headers['content-type']||''))throw Object.assign(new Error('Hub returned a sign-in page or non-JSON response; check Sites service access.'),{status:401,code:'HUB_LOGIN_REQUIRED'});
        resolve(raw?b:b.length?parse(b.toString()):{});}catch(e){reject(e);}finally{if(socket)agent.destroy();}});
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('Network timeout')));req.on('error',e=>{if(socket)agent.destroy();reject(e);});if(data)req.write(data);req.end();
  });
}
export async function bodyOf(req, limit=2*1024*1024, raw=false) {
  const chunks=[];let size=0;for await(const b of req){size+=b.length;assert(size<=limit,'Request too large',413);chunks.push(b);}
  const b=Buffer.concat(chunks);return raw?b:b.length?parse(b.toString('utf8')):{};
}
export function reply(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(json(data));}
export const sleep = ms => new Promise(r=>setTimeout(r,ms));
export function taskView(row){if(!row)return null;return {...row,spec:parse(row.spec),result:row.result?parse(row.result):null};}
export function validateSpec(s){
  assert(s.intent===undefined||['conversation','collaboration'].includes(s.intent),'Invalid dispatch intent');
  if(s.intent==='conversation')assert(s.requireDesktop===true&&s.worktree===false&&!s.parentId&&!s.workflowId&&!s.resumeTaskId&&!(s.dependencies||[]).length,'Conversation must use its selected desktop project without workflow dependencies');
  assert(s&&typeof s==='object','Missing task');
  for(const k of ['id','targetNode','project','prompt'])assert(typeof s[k]==='string'&&s[k].length>0,`Missing ${k}`);
  assert(/^[a-zA-Z0-9_-]{1,100}$/.test(s.id),'Invalid task ID');
  assert(s.prompt.length<=64000,'Prompt too long');
  assert(s.mode===undefined||['question','execute'].includes(s.mode),'Invalid task mode');
  assert(s.executionPolicy===undefined||['local','project'].includes(s.executionPolicy),'Invalid execution policy');
  assert(s.requireDesktop===undefined||typeof s.requireDesktop==='boolean','Invalid desktop requirement');
  assert(s.executionPolicy!=='local'||s.mode==='execute','Local execution policy requires explicit execute mode; question tasks remain read-only');
  if(s.workspaceId!==undefined)assert(typeof s.workspaceId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(s.workspaceId),'Invalid workspace ID');
  if(s.desktopThreadId!==undefined||s.desktopCwd!==undefined){
    assert(typeof s.desktopThreadId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(s.desktopThreadId)&&typeof s.desktopCwd==='string'&&path.isAbsolute(s.desktopCwd),'Invalid native conversation identity');
    assert(s.mode==='execute'&&s.worktree===false,'Native continuation must retain its original working directory');
    assert(Object.keys(s).every(key=>['id','targetNode','project','prompt','mode','worktree','desktopThreadId','desktopCwd'].includes(key)),'Native continuation cannot override the original conversation or derive other work');
  }
  assert(Array.isArray(s.inputs||[])&&(s.inputs||[]).length<=100,'Invalid inputs');
  const names=new Set();for(const a of s.inputs||[]){assert(a&&/^[a-f0-9]{64}$/.test(a.sha)&&Number.isSafeInteger(a.size)&&a.size>=0&&a.size<=512*1024*1024,'Invalid input artifact');assert(typeof a.name==='string'&&a.name.length<=500&&a.name.split(/[\\/]/).every(x=>x&&x!=='.'&&x!=='..'&&!/[. ]$/.test(x)&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))&&!/[<>:"|?*\x00-\x1f]/.test(a.name)&&!path.isAbsolute(a.name),'Invalid input filename');const key=a.name.replaceAll('\\','/').toLowerCase();assert(!names.has(key),'Duplicate input filename');names.add(key);}
  assert(Array.isArray(s.dependencies||[])&&(s.dependencies||[]).length<=32,'Invalid dependencies');
  assert(Array.isArray(s.skills||[])&&(s.skills||[]).every(x=>typeof x==='string'&&x.length<128),'Invalid skills');
  assert(Array.isArray(s.outputs||[])&&(s.outputs||[]).length<=100&&(s.outputs||[]).every(x=>typeof x==='string'&&x.length<500),'Invalid outputs');
  if(s.baseCommit)assert(/^[a-f0-9]{40,64}$/.test(s.baseCommit),'baseCommit must be a full commit hash');
  if(s.role)assert(typeof s.role==='string'&&s.role.length<=80,'Invalid role');
  if(s.acceptance)assert(typeof s.acceptance==='string'&&s.acceptance.length<=8000,'Invalid acceptance criteria');
}
