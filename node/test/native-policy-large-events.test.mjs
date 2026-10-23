import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readNativePolicy} from '../src/native-policy.mjs';
const root=fs.mkdtempSync('E:/codex+/temp/fleet-native-policy-regression-');
const home=path.join(root,'home'),sessions=path.join(home,'sessions');fs.mkdirSync(sessions,{recursive:true});
const cwd=root;
const context=(extra={})=>JSON.stringify({type:'turn_context',payload:{cwd,approval_policy:'never',sandbox_policy:{type:'danger-full-access'},permission_profile:{type:'disabled'},model:'gpt-6.1-sol',effort:'xhigh',...extra}});
let seq=0;
async function check(lines){const file=path.join(sessions,`test-${seq++}.jsonl`);fs.writeFileSync(file,lines.join('\n')+'\n');return readNativePolicy({codexHome:home},{path:file,cwd,modelProvider:'openai'});}
test('large unrelated response does not block latest exact policy',async()=>{
 const value=await check([context({model:'older-model'}),JSON.stringify({type:'response_item',payload:{type:'message',content:'x'.repeat(5*1024*1024)}}),context()]);
 assert.equal(value.model,'gpt-6.1-sol');assert.equal(value.approvalPolicy,'never');assert.deepEqual(value.sandboxPolicy,{type:'dangerFullAccess'});assert.equal(value.effort,'xhigh');
});
test('oversized permission context still fails closed',async()=>{
 await assert.rejects(check([context({irrelevant:'x'.repeat(4*1024*1024)})]),/bounded reader limit/);
});
test('read-only policy is not widened by a large message',async()=>{
 const value=await check([JSON.stringify({type:'response_item',payload:'x'.repeat(5*1024*1024)}),context({approval_policy:'on-request',sandbox_policy:{type:'read-only',network_access:false},permission_profile:undefined})]);
 assert.equal(value.approvalPolicy,'on-request');assert.deepEqual(value.sandboxPolicy,{type:'readOnly',networkAccess:false});
});
test('missing policy fails closed',async()=>{await assert.rejects(check([JSON.stringify({type:'response_item',payload:'x'.repeat(5*1024*1024)})]),/No complete recent permission metadata/);});
test('latest incompatible policy fails rather than reusing older policy',async()=>{await assert.rejects(check([context(),context({approval_policy:'unsupported'})]),/cannot yet be preserved/);});
test('outside session file still rejected',async()=>{const file=path.join(root,'outside.jsonl');fs.writeFileSync(file,context());await assert.rejects(readNativePolicy({codexHome:home},{path:file,cwd}),/outside this computer/);});
test('tail without complete recent metadata fails closed',async()=>{const file=path.join(sessions,'large.jsonl');const fd=fs.openSync(file,'w');fs.ftruncateSync(fd,128*1024*1024+1);fs.closeSync(fd);await assert.rejects(readNativePolicy({codexHome:home},{path:file,cwd}),/No complete recent permission metadata/);});
test('history above 128MiB reads only latest bounded tail',async()=>{const file=path.join(sessions,'long-valid.jsonl');const fd=fs.openSync(file,'w');fs.ftruncateSync(fd,256*1024*1024);fs.closeSync(fd);fs.appendFileSync(file,'\n'+context()+'\n');const p=await readNativePolicy({codexHome:home},{path:file,cwd});assert.equal(p.model,'gpt-6.1-sol');});
test('newest malformed context never falls back to older valid policy',async()=>{await assert.rejects(check([context(),'{"type":"turn_context","payload":']),/incomplete or invalid/);});
test('context crossing chunk boundaries and UTF8 is preserved',async()=>{const p=await check([context({model:'模型-'+ 'a'.repeat(90000)}),JSON.stringify({type:'response_item',payload:'文'.repeat(30000)})]);assert.equal(p.model,'模型-'+ 'a'.repeat(90000));});
test('complete context without final newline can be read',async()=>{const file=path.join(sessions,'no-newline.jsonl');fs.writeFileSync(file,context());const p=await readNativePolicy({codexHome:home},{path:file,cwd});assert.equal(p.model,'gpt-6.1-sol');});
test('context outside 32MiB tail is not used',async()=>{const file=path.join(sessions,'old-context.jsonl');fs.writeFileSync(file,context()+'\n');const fd=fs.openSync(file,'a');const chunk=Buffer.alloc(1024*1024,120);for(let i=0;i<33;i++)fs.writeSync(fd,chunk);fs.closeSync(fd);await assert.rejects(readNativePolicy({codexHome:home},{path:file,cwd}),/No complete recent permission metadata/);});


