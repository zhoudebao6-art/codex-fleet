// Offline recovery only. No network calls, node startup, or writes to an existing directory.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const assert=(value,message)=>{if(!value)throw Error(message);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const quote=s=>'"'+s.replaceAll('"','""')+'"';
async function* archiveLines(archive){
 let header;for await(const line of createInterface({input:fs.createReadStream(archive),crlfDelay:Infinity})){header=JSON.parse(line);break;}
 if(!header?.segment){yield* createInterface({input:fs.createReadStream(archive),crlfDelay:Infinity});return;}
 const {index,total,totalRows}=header.segment;assert(index===1&&Number.isSafeInteger(total)&&total>=1&&total<=10000&&Number.isSafeInteger(totalRows)&&totalRows>=0&&/^[\w-]{1,128}$/.test(header.id),'请从第 1 分卷恢复，保持所有分卷名称并放在同一目录');
 const combined=createHash('sha256');let rows=0,chunks=0,schemaHash;const emit=line=>{combined.update(line+'\n');return line;};
 for(let i=1;i<=total;i++){
  const filename=i===1?archive:path.join(path.dirname(archive),`fleet-backup-${header.id}.part-${String(i).padStart(3,'0')}.ndjson`);assert(fs.existsSync(filename),`缺少第 ${i}/${total} 分卷：${path.basename(filename)}`);
  const checksum=createHash('sha256');let partHeader,ended=false,partRows=0,partChunks=0,seenSchema=false;
  for await(const line of createInterface({input:fs.createReadStream(filename),crlfDelay:Infinity})){
   assert(!ended,'分卷结束标记之后还有数据');const record=JSON.parse(line);
   if(record.type==='end'){assert(partHeader&&seenSchema&&record.sha256===checksum.digest('hex')&&record.rows===partRows&&partHeader.expectedRows===partRows&&record.chunks===partChunks,`第 ${i} 分卷校验失败`);ended=true;continue;}
   checksum.update(line+'\n');
   if(record.type==='header'){assert(!partHeader&&record.id===header.id&&record.format===header.format&&record.version===header.version&&record.createdAt===header.createdAt&&record.segment?.index===i&&record.segment.total===total&&record.segment.totalRows===totalRows,'分卷不属于同一快照或顺序错误');partHeader=record;if(i===1){const {segment,...base}=record;yield emit(JSON.stringify({...base,expectedRows:totalRows}));}}
   else if(record.type==='schema'){assert(partHeader&&!seenSchema,'分卷结构重复');seenSchema=true;const h=digest(line);if(i===1){schemaHash=h;yield emit(line);}else assert(h===schemaHash,'分卷数据库结构不一致');}
   else{assert(partHeader&&seenSchema,'分卷缺少结构');if(record.type==='row'){rows++;partRows++;}if(record.type==='chunk_end'){chunks++;partChunks++;}yield emit(line);}
  }
  assert(ended,`第 ${i} 分卷被截断，请重新下载该分卷`);
 }
 assert(rows===totalRows,'分卷缺少业务记录');yield JSON.stringify({type:'end',rows,chunks,sha256:combined.digest('hex')});
}
export async function restoreBackup(archive,destination){
 const out=path.resolve(destination);assert(!fs.existsSync(out),'恢复目录必须是一个尚不存在的新目录');
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'INCOMPLETE'),'恢复未完成，不可使用');
 const db=new DatabaseSync(path.join(out,'fleet.sqlite')),hash=createHash('sha256'),tables=new Set(),objects=new Map(),objectPaths=new Map();
 fs.mkdirSync(path.join(out,'objects'));let header,ended=false,rows=0,chunks=0,transaction=false,verifiedFiles=0;const restoredFiles=[];
 try{
  for await(const line of archiveLines(archive)){
   assert(!ended,'恢复包结束标记之后还有数据');assert(Buffer.byteLength(line)<=16*1024*1024,'恢复记录超过大小限制');const r=JSON.parse(line);
   if(r.type==='end'){assert(header&&transaction,'恢复包缺少结构');assert(r.sha256===hash.digest('hex')&&r.rows===rows&&header.expectedRows===rows&&r.chunks===chunks,'恢复包不完整或校验失败');assert([...objects.values()].every(o=>o.closed),'存在未完成文件块');ended=true;continue;}
   hash.update(line+'\n');
   if(r.type==='header'){assert(!header&&r.format==='fleet-business-backup'&&r.version===1&&r.restoreMode==='isolated_paused','不支持的恢复包');header=r;}
   else if(r.type==='schema'){
    assert(header&&!transaction&&Array.isArray(r.items),'恢复结构重复或无效');db.exec('BEGIN');transaction=true;
    for(const s of r.items){assert(['table','index'].includes(s.type)&&/^[a-z][a-z0-9_]*$/.test(s.tbl_name),'无效的表名');
     assert(typeof s.sql==='string'&&/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s/i.test(s.sql)&&!s.sql.replace(/;\s*$/,'').includes(';')&&!/\b(?:ATTACH|DETACH|PRAGMA|TRIGGER|load_extension)\b/i.test(s.sql),'不安全的恢复结构');
     if(s.type==='table')tables.add(s.name);db.exec(s.sql);
    }
   }else if(r.type==='row'){
    assert(transaction&&tables.has(r.table)&&r.row&&typeof r.row==='object','未知恢复表');const keys=Object.keys(r.row);
    const known=new Set(db.prepare('PRAGMA table_info('+quote(r.table)+')').all().map(c=>c.name));assert(keys.length&&keys.every(k=>known.has(k)),'恢复列不匹配');
    db.prepare(`INSERT INTO ${quote(r.table)} (${keys.map(quote).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>r.row[k]));rows++;
   }else if(r.type==='blob'){
    assert(typeof r.key==='string'&&r.key.length<2048&&Number.isSafeInteger(r.offset)&&r.offset>=0&&typeof r.data==='string'&&/^[A-Za-z0-9+/]*={0,2}$/.test(r.data),'文件块格式无效');
    let obj=objects.get(r.key);if(!obj){assert(r.offset===0,'文件块起点缺失');const filename=path.join(out,'objects',digest(r.key));obj={fd:fs.openSync(filename,'wx'),offset:0,hash:createHash('sha256'),closed:false};objects.set(r.key,obj);objectPaths.set(r.key,filename);}
    assert(!obj.closed&&obj.offset===r.offset,'文件块重复或不连续');const bytes=Buffer.from(r.data,'base64');assert(bytes.toString('base64')===r.data,'文件块编码无效');fs.writeSync(obj.fd,bytes);obj.hash.update(bytes);obj.offset+=bytes.length;
   }else if(r.type==='chunk_end'){
    let obj=objects.get(r.key);if(!obj&&r.size===0&&r.sha256===digest('')&&typeof r.key==='string'&&r.key.length<2048){const filename=path.join(out,'objects',digest(r.key));obj={fd:fs.openSync(filename,'wx'),offset:0,hash:createHash('sha256'),closed:false};objects.set(r.key,obj);objectPaths.set(r.key,filename);}
    assert(obj&&!obj.closed&&obj.offset===r.size&&obj.hash.digest('hex')===r.sha256,'文件块 SHA256 校验失败');fs.closeSync(obj.fd);obj.closed=true;chunks++;
   }else throw Error('未知恢复记录');
  }
  assert(ended,'恢复包被截断，缺少最终校验');
  const catalog=db.prepare('SELECT * FROM file_chunks ORDER BY project,sha,offset').all();assert(catalog.length===chunks,'文件清单与文件内容不一致');
  for(const c of catalog){const filename=objectPaths.get(c.key);assert(filename&&fs.statSync(filename).size===c.size,'文件清单缺少内容');const h=createHash('sha256');for await(const b of fs.createReadStream(filename))h.update(b);assert(h.digest('hex')===c.digest,'文件清单摘要不一致');}
  for(const f of db.prepare("SELECT * FROM files WHERE status='complete'").all()){
   const h=createHash('sha256'),directory=path.join(out,'files',digest(f.project));fs.mkdirSync(directory,{recursive:true});assert(/^[a-f0-9]{64}$/.test(f.sha),'无效文件摘要');
   const ext=path.extname(f.name),filename=path.join(directory,f.sha+(/^\.[A-Za-z0-9]{1,10}$/.test(ext)?ext:'')),fd=fs.openSync(filename,'wx');let size=0;
   try{for(const c of catalog.filter(c=>c.project===f.project&&c.sha===f.sha)){assert(c.offset===size,'完整文件存在缺块');for await(const b of fs.createReadStream(objectPaths.get(c.key))){h.update(b);fs.writeSync(fd,b);}size+=c.size;}}finally{fs.closeSync(fd);}
   assert(size===f.size&&h.digest('hex')===f.sha,'完整文件 SHA256 校验失败');verifiedFiles++;restoredFiles.push({project:f.project,name:f.name,sha:f.sha,size:f.size,path:path.relative(out,filename)});
  }
  // Recovered execution is deliberately dormant until identities and original
  // attempts have been reconciled. Never turn a lost acknowledgement into a retry.
  db.exec("UPDATE nodes SET revoked=1,token_hash='restore-disabled:'||id,last_seen=NULL,capabilities='{}'; UPDATE local_accounts SET active=0,password_hash='',password_salt='';");
  db.exec("UPDATE tasks SET status='uncertain' WHERE status IN('claimed','running','cancel_requested'); UPDATE tasks SET status='blocked',result=json_object('error','恢复快照；需核对原任务后安排后续工作') WHERE status='queued';");
  db.exec("UPDATE delivery_batches SET error=json_object('resume',status,'restored',1),status='paused' WHERE status IN('baseline','preflight','producing','collecting','cancelling'); UPDATE automation_flows SET status='paused' WHERE status IN('running','cancelling'); UPDATE skill_cycles SET state='paused' WHERE state NOT IN('completed','cancelled');");
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('restored_snapshot',?)").run(JSON.stringify({id:header.id,dispatchDisabled:true,requiresReenrollment:true,restoredAt:new Date().toISOString()}));
  db.exec('COMMIT');transaction=false;
  const result={ok:true,id:header.id,rows,chunks,verifiedFiles,dispatchDisabled:true,credentialsRestored:false,files:restoredFiles,objects:Object.fromEntries([...objectPaths].map(([k,v])=>[k,path.relative(out,v)]))};
  fs.writeFileSync(path.join(out,'recovery-verification.json'),JSON.stringify(result,null,2));fs.unlinkSync(path.join(out,'INCOMPLETE'));return result;
 }catch(e){if(transaction)db.exec('ROLLBACK');throw e;}
 finally{for(const obj of objects.values())if(!obj.closed)fs.closeSync(obj.fd);db.close();}
}
export function snapshotLocalStore(source,destination){
 assert(!fs.existsSync(destination),'本机记录备份文件已存在');const db=new DatabaseSync(path.resolve(source),{readOnly:true});
 try{db.exec("VACUUM INTO '"+path.resolve(destination).replaceAll("'","''")+"'");}finally{db.close();}
 const copy=new DatabaseSync(path.resolve(destination),{readOnly:true});try{assert(copy.prepare('PRAGMA integrity_check').get().integrity_check==='ok','本机记录备份校验失败');}finally{copy.close();}
 return {ok:true,file:path.resolve(destination)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [command,input,output]=process.argv.slice(2);assert(input&&output,'用法：node fleet-restore.mjs restore 恢复包.ndjson 新目录\n或：node fleet-restore.mjs local-store node.sqlite 新备份.sqlite');
  const result=command==='restore'?await restoreBackup(input,output):command==='local-store'?snapshotLocalStore(input,output):(()=>{throw Error('未知命令');})();
  console.log(JSON.stringify({...result,objects:undefined},null,2));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
