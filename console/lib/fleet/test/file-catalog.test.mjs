import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {filesPage} from '../file-catalog.mjs';
import {hash,uid} from '../util.mjs';

function fixture(t){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());const dir=fileURLToPath(new URL('../../../drizzle/',import.meta.url));for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())sql.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 const db={prepare(q){return{args:[],bind(...args){this.args=args;return this;},async first(){return sql.prepare(q).get(...this.args)||null;},async all(){return{results:sql.prepare(q).all(...this.args)};}};}};
 const admin={admin:true};const created='2026-10-19T12:00:00.000Z';
 function node(name,group=null){const id=uid();sql.prepare('INSERT INTO nodes(id,name,token_hash,projects,account_group,display_group_id) VALUES(?,?,?,?,?,?)').run(id,name,hash(id),'["workspace"]',name,group);return id;}
 function file(name,owner,extra={}){const f={id:uid(),project:'workspace',sha:hash(uid()),name,owner,size:100,status:'complete',created,...extra};sql.prepare('INSERT INTO files(id,project,sha,size,name,status,owner,created,updated) VALUES(?,?,?,?,?,?,?,?,?)').run(f.id,f.project,f.sha,f.size,f.name,f.status,f.owner,f.created,f.created);return f;}
 function ref(f,target,title,name=f.name){const id=uid();sql.prepare('INSERT INTO tasks(id,creator,target,project,status,spec,spec_hash,created,updated) VALUES(?,?,?,?,?,?,?,?,?)').run(id,'admin',target,f.project,'accepted',JSON.stringify({prompt:title}),hash(id),created,created);sql.prepare('INSERT INTO artifact_refs(task,sha,name,direction) VALUES(?,?,?,?)').run(id,f.sha,name,'output');return id;}
 function hide(kind,id){sql.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(`console_hidden:${kind}:${id}`,'{"hidden":true}');}
 const search=(params={},actor=admin)=>filesPage(db,actor,new URL('https://fleet.test/api/console/files/page?'+new URLSearchParams(params)));
 return{sql,db,node,file,ref,hide,search,admin};
}
test('file search reaches older files beyond overview cap and keyset pages have no duplicates',async t=>{
 const f=fixture(t),n=f.node('PC-01');for(let i=0;i<507;i++)f.file(`资料-${i}.csv`,n);const old=f.file('旧交付.docx',n,{created:'2025-01-01T00:00:00Z'});
 assert.equal((await f.search({q:'旧交付'})).files[0].sha,old.sha);let cursor='',ids=[],total;do{const p=await f.search({limit:'100',cursor});total=p.total;ids.push(...p.files.map(x=>x.id));cursor=p.nextCursor;}while(cursor);
 assert.equal(total,508);assert.equal(ids.length,508);assert.equal(new Set(ids).size,508);
});
test('file catalog searches case titles, keeps original name, and filters device/type/status',async t=>{
 const f=fixture(t),a=f.node('PC-01'),b=f.node('PC-02');const doc=f.file('说明.docx',a);const task=f.ref(doc,a,'莉莉2 · 网络负载交付','alias.docx');f.file('录制.mp4',a);f.file('待传.zip',b,{status:'uploading'});
 const result=await f.search({q:'网络负载'});assert.equal(result.total,1);assert.equal(result.files[0].taskId,task);assert.equal(result.files[0].name,'说明.docx');assert.equal(result.files[0].sourceNodeName,'PC-01');
 assert.equal((await f.search({node:a,kind:'document',status:'complete'})).total,1);assert.equal((await f.search({node:b,status:'uploading'})).total,1);
 assert.equal((await f.search({q:'PC-02'})).total,1);assert.equal((await f.search({q:'alias.docx'})).total,1);
});
test('literal wildcard input and cursor validation',async t=>{
 const f=fixture(t),n=f.node('PC-01');f.file('100%_完成.zip',n);f.file('其他.zip',n);assert.equal((await f.search({q:'%_'})).total,1);
 const p=await f.search({limit:'1'});await assert.rejects(()=>f.search({q:'其他',cursor:p.nextCursor}),/cursor/);await assert.rejects(()=>f.search({q:'x'.repeat(301)}),/too long/);await assert.rejects(()=>f.search({limit:'0'}),/page size/);
});
test('group limited readers cannot discover task titles or owner metadata from other groups',async t=>{
 const f=fixture(t),a=f.node('PC-01','group-a'),b=f.node('PC-02','group-b');const shared=f.file('共享.zip',b);f.ref(shared,a,'可见任务');f.ref(shared,b,'保密任务');f.file('另一组.docx',b);const hidden=f.file('清理文件.docx',a);f.hide('file',hidden.id);
 const viewer={browser:true,admin:false,role:'viewer',access:{mode:'groups',groupIds:['group-a']}};
 const page=await f.search({},viewer);assert.equal(page.total,1);assert.equal(page.files[0].sourceNodeName,null);assert.equal(page.files[0].taskTitle,'可见任务');assert.equal((await f.search({q:'保密任务'},viewer)).total,0);assert.equal((await f.search({q:'PC-02'},viewer)).total,0);assert.equal((await f.search({node:b},viewer)).total,0);
 const h=f.file('另一个共享.docx',a);const ht=f.ref(h,a,'隐藏任务');f.hide('task',ht);assert.equal((await f.search({q:'隐藏任务'},viewer)).total,0);
});
test('device tokens stay within project grants even when filenames match',async t=>{
 const f=fixture(t),n=f.node('PC-01');f.file('共享.csv',n);f.file('共享.csv',n,{project:'private'});const actor={admin:false,browser:false,projects:'["workspace"]'};assert.equal((await f.search({q:'共享'},actor)).total,1);await assert.rejects(()=>f.search({project:'private'},actor),/access denied/);
});
