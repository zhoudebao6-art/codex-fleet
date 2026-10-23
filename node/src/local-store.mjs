import path from 'node:path';
import {dbOpen,json,parse,uid,now,transaction} from './common.mjs';

// Only observational, high-volume history may be overtaken. Thread bindings,
// read receipts, messages and lifecycle events remain in one FIFO control lane.
const BULK_EVENT="json_extract(payload,'$.type')='progress' AND json_extract(payload,'$.threadId') IS NULL AND json_extract(payload,'$.kind') IN ('tool_activity','input_transfer','output_transfer')";
const OUTBOX_BATCH=25,OUTBOX_HISTORY_SHARE=5,OUTBOX_BYTES=1536*1024;

export class LocalStore {
  constructor(dir){
    this.db=dbOpen(path.join(dir,'node.sqlite'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created TEXT NOT NULL,error TEXT);
    CREATE TABLE IF NOT EXISTS runs(task TEXT PRIMARY KEY,attempt TEXT NOT NULL,status TEXT NOT NULL,spec TEXT NOT NULL,thread TEXT,cwd TEXT,result TEXT,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery(id TEXT PRIMARY KEY,task TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inputs(task TEXT NOT NULL,sha TEXT NOT NULL,name TEXT NOT NULL,path TEXT NOT NULL,stage TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,size INTEGER NOT NULL,receipt TEXT,PRIMARY KEY(task,name));
    CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,error TEXT,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  put(key,value){this.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(key,json(value));}
  get(key){const r=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);return r?parse(r.value):null;}
  emit(e){e={id:uid(),...e};this.db.prepare('INSERT OR IGNORE INTO outbox VALUES(?,?,?,NULL)').run(e.id,json(e),now());return e.id;}
  pending(){
    const rows=condition=>this.db.prepare(`SELECT rowid,payload,created FROM outbox WHERE error IS NULL AND ${condition} ORDER BY created,rowid LIMIT ?`).all(OUTBOX_BATCH);
    const history=rows(`COALESCE((${BULK_EVENT}),0)`),control=rows(`NOT COALESCE((${BULK_EVENT}),0)`),selected=[];
    let bytes=2,ci=0,hi=0;
    const take=row=>{const size=Buffer.byteLength(row.payload)+1;if(selected.length>=OUTBOX_BATCH||selected.length&&bytes+size>OUTBOX_BYTES)return false;selected.push(row);bytes+=size;return true;};
    // One head from each lane prevents starvation even for large payloads. The
    // byte budget fits two maximum-size valid UTF-8 events and leaves room for
    // capabilities inside the hub's 2 MiB request limit. An oversize head goes
    // alone so the existing server rejection/quarantine path can diagnose it.
    if(control.length)take(control[ci++]);
    if(history.length){
      const headBytes=Buffer.byteLength(history[0].payload)+1;
      if(selected.length&&bytes+headBytes>OUTBOX_BYTES){const first=[control[0],history[0]].sort((a,b)=>a.created.localeCompare(b.created)||a.rowid-b.rowid)[0];return [parse(first.payload)];}
      while(hi<Math.min(OUTBOX_HISTORY_SHARE,history.length)&&take(history[hi]))hi++;
    }
    while(ci<control.length&&take(control[ci]))ci++;
    while(hi<history.length&&take(history[hi]))hi++;
    // Preserve chronological order within both lanes and within the selected
    // batch; selecting/retrying never mutates IDs, payloads or unacked history.
    return selected.sort((a,b)=>a.created.localeCompare(b.created)||a.rowid-b.rowid).map(r=>parse(r.payload));
  }
  ack(ids){transaction(this.db,()=>{for(const id of ids)this.db.prepare('DELETE FROM outbox WHERE id=?').run(id);});}
  quarantine(id,error){this.db.prepare('UPDATE outbox SET error=? WHERE id=?').run(error,id);}
  errors(){return this.db.prepare('SELECT id,created,error FROM outbox WHERE error IS NOT NULL').all();}
  run(id){const r=this.db.prepare('SELECT * FROM runs WHERE task=?').get(id);return r?{...r,spec:parse(r.spec),result:r.result?parse(r.result):null,context:this.get('run-context:'+id)}:null;}
  runs(){return this.db.prepare('SELECT task FROM runs').all().map(r=>this.run(r.task));}
  inputs(task){return this.db.prepare('SELECT * FROM inputs WHERE task=? ORDER BY name').all(task).map(r=>({...r,receipt:r.receipt?parse(r.receipt):null}));}
  input(task,a,file){this.db.prepare('INSERT OR IGNORE INTO inputs(task,sha,name,path,stage,bytes,size) VALUES(?,?,?,?,?,0,?)').run(task,a.sha,a.name,file,'received',a.size);return this.inputs(task).find(x=>x.name===a.name);}
  inputProgress(task,name,stage,bytes){this.db.prepare('UPDATE inputs SET stage=?,bytes=? WHERE task=? AND name=?').run(stage,bytes,task,name);}
  inputReceipt(task,name,receipt){this.db.prepare('UPDATE inputs SET receipt=? WHERE task=? AND name=?').run(json(receipt),task,name);}
  transfer(id){const r=this.db.prepare('SELECT * FROM transfers WHERE id=?').get(id);return r?{...parse(r.payload),id:r.id,status:r.status,bytes:r.bytes,error:r.error,updated:r.updated}:null;}
  transfers(){return this.db.prepare("SELECT id FROM transfers ORDER BY status='complete',updated DESC LIMIT 100").all().map(r=>this.transfer(r.id));}
  queueTransfer(payload){this.db.prepare('INSERT OR IGNORE INTO transfers(id,payload,status,updated) VALUES(?,?,?,?)').run(payload.id,json(payload),'queued',now());return this.transfer(payload.id);}
  transferProgress(id,status,bytes,error=null){this.db.prepare('UPDATE transfers SET status=?,bytes=?,error=?,updated=? WHERE id=?').run(status,bytes,error,now(),id);}
  add(task){this.db.prepare('INSERT OR IGNORE INTO runs(task,attempt,status,spec,thread,cwd,result,updated) VALUES(?,?,?,?,NULL,NULL,NULL,?)').run(task.id,task.attempt,'received',json(task.spec),now());return this.run(task.id);}
  update(id,patch){if(Object.hasOwn(patch,'context'))this.put('run-context:'+id,patch.context);const allowed=['status','thread','cwd','result'];const cols=Object.keys(patch).filter(k=>allowed.includes(k));if(!cols.length)return;this.db.prepare(`UPDATE runs SET ${cols.map(k=>k+'=?').join(',')},updated=? WHERE task=?`).run(...cols.map(k=>k==='result'?json(patch[k]):patch[k]),now(),id);}
  close(){this.db.close();}
}
