import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {VERSION,now,uid,secret,hash,json,parse,assert,mkdir,dbOpen,transaction,bodyOf,reply,taskView,validateSpec,configPath,readJson,fileHash,isMain} from './common.mjs';

export function createHub(config){
  assert(['127.0.0.1','::1'].includes(config.host||'127.0.0.1'),'Hub must bind loopback; publish through Tailscale Serve');
  const db=dbOpen(path.join(config.dataDir,'hub.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,token_hash TEXT NOT NULL UNIQUE,projects TEXT NOT NULL,account_group TEXT NOT NULL,max_running INTEGER NOT NULL DEFAULT 1,last_seen TEXT,capabilities TEXT NOT NULL DEFAULT '{}',revoked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,name TEXT NOT NULL,projects TEXT NOT NULL,account_group TEXT NOT NULL,expires TEXT NOT NULL,used_by TEXT);
  CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,creator TEXT NOT NULL,target TEXT NOT NULL,project TEXT NOT NULL,status TEXT NOT NULL,spec TEXT NOT NULL,spec_hash TEXT NOT NULL,attempt TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,result TEXT,thread_id TEXT);
  CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,node TEXT NOT NULL,task TEXT,type TEXT NOT NULL,payload TEXT NOT NULL,created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS receipts(node TEXT NOT NULL,id TEXT NOT NULL,body_hash TEXT NOT NULL,PRIMARY KEY(node,id));
  CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,task TEXT NOT NULL,sender TEXT NOT NULL,text TEXT NOT NULL,created TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS artifacts(sha TEXT PRIMARY KEY,size INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS artifact_refs(task TEXT NOT NULL,sha TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(task,sha));`);
  db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS knowledge(project TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,source_task TEXT NOT NULL,author TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(project,key,version))');
  if(!db.prepare('PRAGMA table_info(nodes)').all().some(c=>c.name==='fingerprint'))db.exec('ALTER TABLE nodes ADD COLUMN fingerprint TEXT');
  db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('group_salt',secret());
  const groupSalt=db.prepare('SELECT value FROM settings WHERE key=?').get('group_salt').value;
  const get=(q,...p)=>db.prepare(q).get(...p), all=(q,...p)=>db.prepare(q).all(...p), run=(q,...p)=>db.prepare(q).run(...p);
  const node=id=>get('SELECT * FROM nodes WHERE id=?',id);
  const task=id=>taskView(get('SELECT * FROM tasks WHERE id=?',id));
  const projects=n=>parse(n.projects);
  const can=(n,p)=>n.admin||projects(n).includes(p);
  const event=(n,t,type,payload,id=uid())=>run('INSERT INTO events(id,node,task,type,payload,created) VALUES(?,?,?,?,?,?)',id,n,t,type,json(payload),now());
  function authenticate(req){
    const v=req.headers.authorization||'';assert(v.startsWith('Bearer '),'Authentication required',401);const h=hash(v.slice(7));
    if(h===config.adminTokenHash)return {id:'admin',admin:true};
    const n=get('SELECT * FROM nodes WHERE token_hash=? AND revoked=0',h);assert(n,'Invalid or revoked token',401);return n;
  }
  function access(n,id){const t=task(id);assert(t,'Task not found',404);assert(can(n,t.project),'Project access denied',403);return t;}
  function submit(n,s){
    validateSpec(s);const target=node(s.targetNode);assert(target&&!target.revoked,'Unknown target node');
    assert(can(n,s.project)&&can(target,s.project),'Project access denied',403);
    const old=task(s.id), digest=hash(json(s));if(old){assert(old.creator===n.id&&old.spec_hash===digest,'Task ID already used with different request',409);return old;}
    for(const d of s.dependencies||[]){assert(d!==s.id,'Self dependency');const dep=access(n,d);assert(dep.project===s.project,'Cross-project dependency denied');}
    if(s.parentId){const parent=access(n,s.parentId);assert(parent.project===s.project,'Cross-project parent denied');let depth=0,p=parent;while(p){assert(++depth<9,'Maximum delegation depth exceeded');p=p.spec.parentId?task(p.spec.parentId):null;}}
    run('INSERT INTO tasks(id,creator,target,project,status,spec,spec_hash,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',s.id,n.id,s.targetNode,s.project,'queued',json(s),digest,now(),now());
    event(n.id,s.id,'submitted',{});return task(s.id);
  }
  function sync(n,b){
    assert(!n.admin,'Node token required');
    assert(Array.isArray(b.events||[])&&(b.events||[]).length<=100,'Invalid event batch');
    const ack=[];
    for(const e of b.events||[]){
      assert(e.id&&e.type,'Invalid event');const digest=hash(json(e));const old=get('SELECT body_hash FROM receipts WHERE node=? AND id=?',n.id,e.id);
      if(old){assert(old.body_hash===digest,'Changed event body',409);ack.push(e.id);continue;}
      if(e.type==='assign'){submit(n,e.spec);}
      else if(e.type==='message'){const t=access(n,e.taskId);assert(typeof e.text==='string'&&e.text.length<=16000,'Invalid message');run('INSERT INTO messages VALUES(?,?,?,?,?)',e.id,t.id,n.id,e.text,now());event(n.id,t.id,'message',{messageId:e.id});}
      else {
        const t=access(n,e.taskId);assert(t.target===n.id&&t.attempt===e.attemptId,'Task attempt owner mismatch',409);
        if(['accepted','submitted','failed','blocked','cancelled'].includes(t.status)){assert(e.type==='progress'||e.type==='started'||e.type==='finished'||e.type==='uncertain','Terminal task');}
        else if(e.type==='started'){assert(['claimed','running','uncertain'].includes(t.status),'Task not claimable');run('UPDATE tasks SET status=?,thread_id=COALESCE(?,thread_id),updated=? WHERE id=?','running',e.threadId||null,now(),t.id);}
        else if(e.type==='progress'){if(e.threadId)run('UPDATE tasks SET thread_id=?,updated=? WHERE id=?',e.threadId,now(),t.id);}
        else if(e.type==='uncertain'){run('UPDATE tasks SET status=?,updated=? WHERE id=?','uncertain',now(),t.id);}
        else if(e.type==='finished'){
          assert(['submitted','failed','blocked','cancelled'].includes(e.status),'Invalid finish state');
          run('UPDATE tasks SET status=?,result=?,thread_id=COALESCE(?,thread_id),updated=? WHERE id=?',e.status,json(e.result||{}),e.threadId||null,now(),t.id);
        }else throw new Error('Unknown event type');
        event(n.id,t.id,e.type,e);
      }
      run('INSERT INTO receipts VALUES(?,?,?)',n.id,e.id,digest);ack.push(e.id);
    }
    const caps=b.capabilities||{};assert(json(caps).length<=128000,'Capabilities too large');
    const fingerprint=typeof caps.accountFingerprint==='string'&&/^[a-f0-9]{64}$/.test(caps.accountFingerprint)?caps.accountFingerprint:null;
    run('UPDATE nodes SET last_seen=?,capabilities=?,fingerprint=? WHERE id=?',now(),json(caps),fingerprint,n.id);
    const effectiveGroup=fingerprint||n.account_group;
    const active=()=>all("SELECT * FROM tasks WHERE target=? AND status IN ('claimed','running','cancel_requested','uncertain')",n.id);
    if(caps.ready===true&&active().length<n.max_running){
      const groupBusy=get("SELECT count(*) AS n FROM tasks t JOIN nodes n ON t.target=n.id WHERE COALESCE(n.fingerprint,n.account_group)=? AND t.status IN ('claimed','running','cancel_requested','uncertain')",effectiveGroup).n;
      const groups=all('SELECT account_group FROM nodes WHERE COALESCE(fingerprint,account_group)=?',effectiveGroup);
      const groupLimit=Math.min(...groups.map(g=>config.groupLimits?.[g.account_group]??config.defaultGroupLimit??2));
      if(groupBusy<groupLimit){for(const t of all("SELECT * FROM tasks WHERE target=? AND status='queued' ORDER BY created",n.id)){
        const s=parse(t.spec);if((s.dependencies||[]).some(d=>task(d)?.status!=='accepted'))continue;
        if(!caps.projects?.includes(s.project))continue;
        const busy=get("SELECT id FROM tasks WHERE target=? AND project=? AND status IN ('claimed','running','cancel_requested','uncertain')",n.id,s.project);if(busy)continue;
        const attempt=uid();run("UPDATE tasks SET status='claimed',attempt=?,updated=? WHERE id=?",attempt,now(),t.id);event('hub',t.id,'claimed',{attemptId:attempt,node:n.id});break;
      }}
    }
    return {ack,tasks:active().map(taskView),serverTime:now(),protocol:1};
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const u=new URL(req.url,'http://127.0.0.1');const route=u.pathname;
      if(req.method==='GET'&&route==='/health')return reply(res,200,{ok:true,version:VERSION,protocol:1});
      if(req.method==='POST'&&route==='/v1/enroll'){
        const b=await bodyOf(req);assert(typeof b.token==='string'&&typeof b.nodeToken==='string'&&b.nodeToken.length>=40&&typeof b.nodeId==='string'&&/^[\w-]{20,80}$/.test(b.nodeId),'Invalid enrollment');
        const result=transaction(db,()=>{const inv=get('SELECT * FROM invites WHERE token_hash=?',hash(b.token));assert(inv,'Invalid invitation',403);
          if(inv.used_by){assert(inv.used_by===b.nodeId,'Invitation already used',409);const n=node(b.nodeId);assert(n&&!n.revoked&&n.token_hash===hash(b.nodeToken),'Enrollment identity mismatch',403);return {nodeId:n.id,name:n.name,projects:projects(n),accountGroup:n.account_group,groupSalt};}
          assert(inv.expires>now(),'Invitation expired',403);run('INSERT INTO nodes(id,name,token_hash,projects,account_group) VALUES(?,?,?,?,?)',b.nodeId,inv.name,hash(b.nodeToken),inv.projects,inv.account_group);run('UPDATE invites SET used_by=? WHERE id=?',b.nodeId,inv.id);return {nodeId:b.nodeId,name:inv.name,projects:parse(inv.projects),accountGroup:inv.account_group,groupSalt};});return reply(res,200,result);
      }
      const n=authenticate(req);
      if(route==='/v1/knowledge'&&req.method==='POST'){
        const b=await bodyOf(req);assert(typeof b.key==='string'&&/^[\w-]{1,80}$/.test(b.key)&&typeof b.body==='string'&&b.body.length>0&&b.body.length<=16000,'Invalid knowledge entry');
        const source=access(n,b.sourceTask);assert(source.status==='accepted'&&source.project===b.project,'Knowledge requires an accepted source task in the same project',409);assert(n.admin||source.creator===n.id,'Only task creator or admin may publish knowledge',403);
        const result=transaction(db,()=>{const version=(get('SELECT MAX(version) AS v FROM knowledge WHERE project=? AND key=?',b.project,b.key).v||0)+1;run('INSERT INTO knowledge VALUES(?,?,?,?,?,?,?)',b.project,b.key,version,b.body,source.id,n.id,now());event(n.id,source.id,'knowledge_published',{key:b.key,version});return {project:b.project,key:b.key,version,sourceTask:source.id};});return reply(res,200,result);
      }
      if(route==='/v1/knowledge'&&req.method==='GET'){
        const project=u.searchParams.get('project'),q=u.searchParams.get('q')||'';assert(can(n,project),'Project access denied',403);assert(q.length<=200,'Query too long');
        return reply(res,200,all('SELECT k.* FROM knowledge k WHERE k.project=? AND k.version=(SELECT MAX(x.version) FROM knowledge x WHERE x.project=k.project AND x.key=k.key) AND (instr(k.key,?)>0 OR instr(k.body,?)>0) ORDER BY k.created DESC LIMIT 50',project,q,q));
      }
      if(route==='/v1/invites'&&req.method==='POST'){
        assert(n.admin,'Admin required',403);const b=await bodyOf(req);assert(/^[\w-]{1,60}$/.test(b.name)&&Array.isArray(b.projects)&&b.projects.length&&b.projects.every(p=>/^[\w-]{1,80}$/.test(p)),'Invalid node name or projects');
        const token=secret(),id=uid(),expires=new Date(Date.now()+Math.min(b.hours||24,168)*3600000).toISOString();
        run('INSERT INTO invites VALUES(?,?,?,?,?,?,NULL)',id,hash(token),b.name,json(b.projects),b.accountGroup||'shared-default',expires);
        return reply(res,200,{id,token,expires,name:b.name,projects:b.projects,accountGroup:b.accountGroup||'shared-default'});
      }
      if(route==='/v1/nodes'&&req.method==='GET')return reply(res,200,all('SELECT * FROM nodes').filter(x=>n.admin||projects(x).some(p=>can(n,p))).map(x=>({id:x.id,name:x.name,projects:projects(x),accountGroup:x.account_group,effectiveAccountGroup:x.fingerprint?'account-'+x.fingerprint.slice(0,12):x.account_group,lastSeen:x.last_seen,online:!!x.last_seen&&Date.now()-Date.parse(x.last_seen)<60000,revoked:!!x.revoked,capabilities:parse(x.capabilities)})));
      if(route.match(/^\/v1\/nodes\/[\w-]+\/revoke$/)&&req.method==='POST'){assert(n.admin,'Admin required',403);run('UPDATE nodes SET revoked=1 WHERE id=?',route.split('/')[3]);return reply(res,200,{ok:true});}
      if(route==='/v1/sync'&&req.method==='POST'){const b=await bodyOf(req);return reply(res,200,transaction(db,()=>sync(n,b)));}
      if(route==='/v1/tasks'&&req.method==='POST'){const b=await bodyOf(req);return reply(res,200,transaction(db,()=>submit(n,b)));}
      if(route==='/v1/tasks'&&req.method==='GET')return reply(res,200,all('SELECT * FROM tasks ORDER BY created DESC LIMIT 500').filter(t=>can(n,t.project)).map(taskView));
      const tm=route.match(/^\/v1\/tasks\/([\w-]+)(?:\/(accept|cancel|resolve|messages|events))?$/);
      if(tm){const t=access(n,tm[1]);if(!tm[2]&&req.method==='GET')return reply(res,200,{...t,artifacts:all('SELECT r.*,a.size FROM artifact_refs r JOIN artifacts a ON r.sha=a.sha WHERE r.task=?',t.id)});
        if(req.method==='GET'&&tm[2]==='messages')return reply(res,200,all('SELECT * FROM messages WHERE task=? ORDER BY created',t.id));
        if(req.method==='GET'&&tm[2]==='events')return reply(res,200,all('SELECT * FROM events WHERE task=? ORDER BY seq',t.id).map(e=>({...e,payload:parse(e.payload)})));
        if(req.method==='POST'&&tm[2]==='accept'){assert(n.admin||t.creator===n.id,'Only task creator or admin may accept',403);assert(t.status==='submitted'||t.status==='accepted','Task not submitted',409);const b=await bodyOf(req);assert(b.note&&typeof b.note==='string','Acceptance evidence note required');run("UPDATE tasks SET status='accepted',updated=? WHERE id=?",now(),t.id);event(n.id,t.id,'accepted',{note:b.note});return reply(res,200,task(t.id));}
        if(req.method==='POST'&&tm[2]==='cancel'){assert(n.admin||t.creator===n.id||t.target===n.id,'Cannot cancel',403);assert(['queued','claimed','running','uncertain','cancel_requested'].includes(t.status),'Task is terminal',409);run('UPDATE tasks SET status=?,updated=? WHERE id=?',t.status==='queued'?'cancelled':'cancel_requested',now(),t.id);event(n.id,t.id,'cancel_requested',{});return reply(res,200,task(t.id));}
        if(req.method==='POST'&&tm[2]==='resolve'){assert(n.admin,'Admin required',403);const b=await bodyOf(req);assert(t.status==='uncertain'||t.status==='cancel_requested','Task not uncertain',409);assert(b.confirmStopped===true&&b.note,'Confirm the previous process has stopped and supply evidence');run("UPDATE tasks SET status='failed',result=?,updated=? WHERE id=?",json({error:'Operator resolved uncertain attempt',note:b.note}),now(),t.id);event(n.id,t.id,'resolved',b);return reply(res,200,task(t.id));}
      }
      const am=route.match(/^\/v1\/artifacts\/([a-f0-9]{64})$/);
      if(am){const t=access(n,u.searchParams.get('task'));const sha=am[1],root=mkdir(path.join(config.dataDir,'artifacts',hash(t.project))),file=path.join(root,sha),part=path.join(root,sha+'.part');
        if(req.method==='GET'){assert(get('SELECT * FROM artifact_refs WHERE task=? AND sha=?',t.id,sha),'Artifact not attached to task',404);assert(fs.existsSync(file),'Artifact unavailable',404);const size=fs.statSync(file).size;
          if(req.headers.range){const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range);assert(m,'Invalid byte range',416);const start=Number(m[1]),end=Math.min(Number(m[2]),size-1);assert(start>=0&&end>=start&&end<size,'Invalid byte range',416);res.writeHead(206,{'content-type':'application/octet-stream','content-length':end-start+1,'content-range':`bytes ${start}-${end}/${size}`,'accept-ranges':'bytes','cache-control':'no-store'});return fs.createReadStream(file,{start,end}).pipe(res);}
          res.writeHead(200,{'content-type':'application/octet-stream','content-length':size,'accept-ranges':'bytes','cache-control':'no-store'});return fs.createReadStream(file).pipe(res);}
        assert(n.id===t.target,'Only execution node can upload',403);
        if(req.method==='HEAD'){res.writeHead(200,{'x-upload-offset':String(fs.existsSync(part)?fs.statSync(part).size:0)});return res.end();}
        if(req.method==='POST'){const b=await bodyOf(req);assert(Number.isSafeInteger(b.size)&&b.size>=0&&b.size<=(config.maxArtifactBytes||512*1024*1024),'Invalid artifact size');assert(typeof b.name==='string'&&b.name.length<300,'Invalid artifact name');
          if(fs.existsSync(file)){assert(fs.statSync(file).size===b.size,'Artifact size mismatch');run('INSERT OR IGNORE INTO artifact_refs VALUES(?,?,?)',t.id,sha,b.name);return reply(res,200,{complete:true,offset:b.size});}
          const a=get('SELECT * FROM artifacts WHERE sha=?',sha);assert(!a||a.size===b.size,'Artifact conflict',409);run('INSERT OR IGNORE INTO artifacts VALUES(?,?)',sha,b.size);run('INSERT OR IGNORE INTO artifact_refs VALUES(?,?,?)',t.id,sha,b.name);return reply(res,200,{complete:false,offset:fs.existsSync(part)?fs.statSync(part).size:0});}
        if(req.method==='PUT'){const a=get('SELECT * FROM artifacts WHERE sha=?',sha);assert(a&&get('SELECT * FROM artifact_refs WHERE task=? AND sha=?',t.id,sha),'Initialize upload first',409);const offset=Number(u.searchParams.get('offset')),b=await bodyOf(req,1024*1024,true);const current=fs.existsSync(part)?fs.statSync(part).size:0;assert(offset===current,'Upload offset mismatch',409);assert(current+b.length<=a.size,'Upload exceeds declared size');const fd=fs.openSync(part,'a');try{fs.writeSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(current+b.length===a.size){if(fileHash(part)!==sha){fs.renameSync(part,path.join(root,sha+'.corrupt.'+uid()));assert(false,'Artifact hash mismatch; corrupted partial was quarantined',409);}fs.renameSync(part,file);}return reply(res,200,{offset:current+b.length,complete:fs.existsSync(file)});}
      }
      throw Object.assign(new Error('Not found'),{status:404});
    }catch(e){if(!res.headersSent)reply(res,e.status||400,{error:e.message});else res.destroy();}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  let closed=false;
  return {db,server,listen:()=>new Promise((r,j)=>{server.once('error',j);server.listen(config.port??43127,config.host||'127.0.0.1',()=>r(server.address()));}),close:()=>{if(closed)return Promise.resolve();closed=true;return new Promise(r=>{server.close(()=>{db.close();r();});server.closeIdleConnections();});}};
}
if(isMain(import.meta.url)){const cfg=readJson(configPath()),h=createHub(cfg);await h.listen();console.log(json({service:'codex-fleet-hub',version:VERSION,address:h.server.address()}));const stop=async()=>{clearInterval(watch);await h.close();process.exit(0);};const watch=setInterval(()=>{if(fs.existsSync(path.join(cfg.dataDir,'stop.request')))stop();},500);for(const s of ['SIGINT','SIGTERM'])process.on(s,stop);}
