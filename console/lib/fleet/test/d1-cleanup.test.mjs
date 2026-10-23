import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {cleanupConsole,restoreCleanup} from '../console-cleanup.mjs';
import {uid,now} from '../util.mjs';

test('actual D1 cleanup supports a multi-record batch and restores it',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'cleanup-regression'},d1Persist:false});
 try{
  const db=await mf.getD1Database('DB'),dir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));
  for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())for(const sql of fs.readFileSync(dir+'/'+name,'utf8').split(/--> statement-breakpoint|;\s*(?:\r?\n|$)/).map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  const items=Array.from({length:67},()=>({kind:'task',id:uid()}));
  await db.batch(items.map(i=>db.prepare('INSERT INTO tasks(id,creator,target,project,status,spec,spec_hash,created,updated) VALUES(?,?,?,?,?,?,?,?,?)').bind(i.id,'admin','node','workspace','accepted','{}','hash',now(),now())));
  const body={id:uid(),label:'Batch regression',items};
  let calls=0;
  const counted={prepare(sql){calls++;return db.prepare(sql);},batch(statements){assert.ok(statements.length<=2);return db.batch(statements);}};
  // Metadata resolution is bounded; preparing the atomic writes is expected.
  await cleanupConsole(counted,{id:'admin',admin:true},body);
  assert.ok(calls<10,`Unexpected per-record reads: ${calls}`);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'console_hidden:%'").first()).n,items.length);
  await restoreCleanup(counted,{id:'admin',admin:true},body.id);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'console_hidden:%'").first()).n,0);
 }finally{await mf.dispose();}
});
