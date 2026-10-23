import {createHash} from 'node:crypto';
import {assert,parse,json,now,validId} from './util.mjs';
import {all,first,run,batch} from './db.mjs';
import {admin} from './auth.mjs';

const omitted=new Set(['device_sessions','device_tickets','login_sessions','login_rate_limits','invites','desktop_read_requests']);
const allowed=name=>/^[a-z][a-z0-9_]*$/.test(name)&&!name.startsWith('recovery_backup')&&!name.startsWith('sqlite_')&&!name.startsWith('d1_');
const q=s=>'"'+s.replaceAll('"','""')+'"';
const lit=s=>"'"+s.replaceAll("'","''")+"'";
export async function planBackupSegments(db,id,maxBytes=64*1024*1024){
 const rows=await all(db,"SELECT seq,length(CAST(row_json AS BLOB))+256+CASE WHEN table_name='file_chunks' THEN CAST(json_extract(row_json,'$.size')*1.34 AS INTEGER)+4096 ELSE 0 END AS bytes FROM recovery_backup_rows WHERE backup_id=? ORDER BY seq",id);
 const parts=[];let part={from:0,to:0,rows:0,bytes:0};for(const r of rows){if(part.rows&&part.bytes+r.bytes>maxBytes){parts.push(part);part={from:part.to,to:part.to,rows:0,bytes:0};}part.to=r.seq;part.rows++;part.bytes+=r.bytes;}if(part.rows||!parts.length)parts.push(part);
 return parts.map((p,i)=>({...p,index:i+1,filename:`fleet-backup-${id}.part-${String(i+1).padStart(3,'0')}.ndjson`,downloadUrl:`/api/console/backups/${id}/download?part=${i+1}`}));
}
async function segmentsFor(db,id){const key='backup:'+id+':segments',saved=await first(db,'SELECT value FROM settings WHERE key=?',key);if(saved)return parse(saved.value);const parts=await planBackupSegments(db,id);await run(db,'INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)',key,json(parts));return parse((await first(db,'SELECT value FROM settings WHERE key=?',key)).value);}
export async function backupView(db,n,id){
 admin(n);assert(validId(id),'Invalid backup ID');const b=await first(db,'SELECT * FROM recovery_backups WHERE id=?',id);assert(b,'备份快照不存在',404);
 const counts=await all(db,'SELECT table_name AS name,count(*) AS count FROM recovery_backup_rows WHERE backup_id=? GROUP BY table_name ORDER BY table_name',id);
 const files=await first(db,"SELECT count(*) AS files,COALESCE(sum(json_extract(row_json,'$.size')),0) AS bytes FROM recovery_backup_rows WHERE backup_id=? AND table_name='files' AND json_extract(row_json,'$.status')='complete'",id);
 return {id:b.id,createdAt:b.created_at,verifiedAt:b.verified_at,status:b.status,tables:counts,rows:counts.reduce((s,t)=>s+t.count,0),...files,segments:await segmentsFor(db,id),scope:'cloud_business_and_stored_files',credentialsIncluded:false,restoreMode:'isolated_paused',downloadUrl:'/api/console/backups/'+id+'/download'};
}
export async function listBackups(db,n){admin(n);const rows=await all(db,'SELECT id FROM recovery_backups ORDER BY created_at DESC LIMIT 20');return {backups:await Promise.all(rows.map(b=>backupView(db,n,b.id)))};}
export async function createBackup(db,n,b){
 admin(n);assert(validId(b.id),'提供稳定的备份编号');if(await first(db,'SELECT id FROM recovery_backups WHERE id=?',b.id))return backupView(db,n,b.id);
 const schema=await all(db,"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN('table','index') AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name");
 const tables=schema.filter(s=>s.type==='table'&&allowed(s.name)&&!omitted.has(s.name));
 const statements=[['INSERT INTO recovery_backups(id,creator,created_at,schema_json) VALUES(?,?,?,?)',b.id,n.id,now(),json(schema.filter(s=>allowed(s.tbl_name)))]];
 for(const t of tables){
  const columns=await all(db,'PRAGMA table_info('+q(t.name)+')');
  const expression=columns.flatMap(c=>{let value=q(c.name);if(c.name==='token_hash')value=lit('credential-not-exported:'+t.name+':')+'||'+q('id');else if(/password_hash|password_salt/.test(c.name))value=lit('credential-not-exported');return [lit(c.name),value];}).join(',');
  const filter=t.name==='settings'?" WHERE key NOT IN('group_salt','delivery_controller_lock') AND key NOT LIKE 'backup:%'":'';
  statements.push([`INSERT INTO recovery_backup_rows(backup_id,table_name,row_json) SELECT ?,?,json_object(${expression}) FROM ${q(t.name)}${filter}`,b.id,t.name]);
 }
 // One D1 transaction fixes every table at the same instant; running task rows are
 // copied without changing their state. File chunks are immutable by generation.
 await batch(db,statements);return backupView(db,n,b.id);
}
export async function downloadBackup(db,bucket,n,id,partIndex=null){
 const info=await backupView(db,n,id),source=await first(db,'SELECT schema_json FROM recovery_backups WHERE id=?',id);
 const part=partIndex===null?null:info.segments.find(p=>p.index===partIndex);assert(partIndex===null||part,'备份分卷不存在',404);const expectedRows=part?.rows??info.rows;
 const digest=createHash('sha256'),encoder=new TextEncoder();
 async function* records(){
  yield {type:'header',format:'fleet-business-backup',version:1,id,createdAt:info.createdAt,expectedRows,credentialsIncluded:false,restoreMode:'isolated_paused',...(part?{segment:{index:part.index,total:info.segments.length,totalRows:info.rows}}:{})};
  yield {type:'schema',items:parse(source.schema_json)};
  let after=part?.from??0,rows=0,chunks=0;
  for(;;){const page=await all(db,'SELECT seq,table_name,row_json FROM recovery_backup_rows WHERE backup_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 100',id,after,part?.to??Number.MAX_SAFE_INTEGER);if(!page.length)break;
   for(const r of page){after=r.seq;rows++;const row=parse(r.row_json);yield {type:'row',table:r.table_name,row};
    if(r.table_name==='file_chunks'){
     const object=await bucket.get(row.key);assert(object?.body,'备份文件块缺失，未生成完整恢复包',503);
     const reader=object.body.getReader(),chunkDigest=createHash('sha256');let offset=0,buffer=Buffer.allocUnsafe(262144),filled=0;
     try{for(;;){const {done,value}=await reader.read();if(done)break;chunkDigest.update(value);
      for(let at=0;at<value.byteLength;){const take=Math.min(buffer.length-filled,value.byteLength-at);buffer.set(value.subarray(at,at+take),filled);filled+=take;at+=take;if(filled===buffer.length){yield {type:'blob',key:row.key,offset,data:buffer.toString('base64')};offset+=filled;filled=0;}}
     }if(filled){yield {type:'blob',key:row.key,offset,data:buffer.subarray(0,filled).toString('base64')};offset+=filled;}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
     assert(offset===row.size&&chunkDigest.digest('hex')===row.digest,'备份文件块校验失败，未生成完整恢复包',409);chunks++;
     yield {type:'chunk_end',key:row.key,size:row.size,sha256:row.digest};
    }
   }
  }
  assert(rows===expectedRows,'快照内容发生变化，请重新下载',409);
  if(part)await run(db,'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value','backup:'+id+':verified:'+part.index,now());
  if(!part||(await first(db,"SELECT count(*) AS n FROM settings WHERE key GLOB ?",'backup:'+id+':verified:*')).n===info.segments.length)await run(db,"UPDATE recovery_backups SET verified_at=?,status='verified' WHERE id=?",now(),id);
  yield {type:'end',rows,chunks,sha256:digest.digest('hex')};
 }
 const iterator=records();
 const stream=new ReadableStream({async pull(controller){try{const r=await iterator.next();if(r.done){controller.close();return;}const bytes=encoder.encode(json(r.value)+'\n');if(r.value.type!=='end')digest.update(bytes);controller.enqueue(bytes);}catch(e){controller.error(e);await iterator.return();}},async cancel(){await iterator.return();}});
 return new Response(stream,{headers:{'content-type':'application/x-ndjson','cache-control':'no-store','x-content-type-options':'nosniff','content-disposition':`attachment; filename="${part?.filename||`fleet-backup-${id}.ndjson`}"`}});
}
