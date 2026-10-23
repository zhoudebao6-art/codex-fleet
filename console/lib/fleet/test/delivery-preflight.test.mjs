import test from 'node:test';
import assert from 'node:assert/strict';
import {SKILL_SOURCE_NODE as source,sourcePolicy,isSkillSource,preflightNodes,preflightComplete,maintenanceCommit} from '../delivery-preflight.mjs';
const row=(profile,policy,controller=source)=>({controller,declaration:JSON.stringify({profile,nodes:[source,'remote']}),loop_policy:JSON.stringify({skillSource:policy})});
test('source exemption is frozen, device-specific and applies to both authorized profiles',()=>{
 for(const profile of ['auto20','software']){
  const r=row(profile,sourcePolicy(source,profile));
  assert.equal(isSkillSource(r,source),true);assert.equal(isSkillSource(r,'remote'),false);
  assert.deepEqual(preflightNodes(r),['remote']);assert.equal(preflightComplete(r,[]),false);
  assert.equal(preflightComplete(r,[{node:'remote',phase:'preflight',verified:'{"passed":true}'}]),true);
  assert.equal(isSkillSource(row(profile,null),source),false,'Legacy batch unchanged');
  assert.equal(isSkillSource(row(profile,sourcePolicy(source,profile),'other-controller'),source),false);
 }
 assert.equal(sourcePolicy('other-device','auto20'),null);
 assert.equal(sourcePolicy(source,'future-profile'),null);
 assert.equal(isSkillSource(row('software',sourcePolicy(source,'auto20')),source),false);
});
test('specific source maintenance freezes a real release without changing ordinary delivery history',()=>{
 const r={baseline:JSON.stringify({source:'local-publisher',commit:'local-source'})},before=r.baseline;
 assert.throws(()=>maintenanceCommit(r,{}));
 assert.equal(maintenanceCommit(r,{baseCommit:'a'.repeat(40)}),'a'.repeat(40));
 assert.equal(r.baseline,before);
 assert.equal(maintenanceCommit({baseline:JSON.stringify({commit:'b'.repeat(40)})},{baseCommit:'a'.repeat(40)}),'b'.repeat(40));
});
