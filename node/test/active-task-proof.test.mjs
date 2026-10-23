import test from 'node:test';
import assert from 'node:assert/strict';
import {activeTaskProof} from '../scripts/active-task-proof.mjs';

test('idle proof counts older active work, including desktop requests, without fetching history',async()=>{
  let called=0;const client={api:async route=>{
    called++;const url=new URL(route,'https://fleet.example');
    assert.equal(url.pathname,'/v1/tasks/page');assert.equal(url.searchParams.get('target'),'self');
    assert.equal(url.searchParams.get('phase'),'active');assert.equal(url.searchParams.has('source'),false);
    return {total:502,tasks:[{id:'old-desktop-request',status:'uncertain'}],serverTime:new Date().toISOString(),nextCursor:'next'};
  }};
  const proof=await activeTaskProof(client,'self');
  assert.equal(called,1);assert.equal(proof.completeProof,true);assert.equal(proof.total,502);
});
test('idle proof fails closed on stale, incomplete or contradictory counts and network failure',async()=>{
  const valid={total:0,tasks:[],nextCursor:null,serverTime:new Date().toISOString()};
  for(const invalid of [{total:-1},{total:'0'},{total:1},{tasks:[{id:'live'}]},{nextCursor:'next'},{serverTime:'2000-01-01'}, {serverTime:'bad'}])
    await assert.rejects(activeTaskProof({api:async()=>({...valid,...invalid})},'self'),/Fresh complete/);
  await assert.rejects(activeTaskProof({api:async()=>{throw Error('offline');}},'self'),/offline/);
  assert.equal((await activeTaskProof({api:async()=>valid},'self')).total,0);
});
