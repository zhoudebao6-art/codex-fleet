import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {startConsoleBridge} from '../src/console-bridge.mjs';

const site='https://fleet.example.test';
function request(port,{method='GET',path='/',headers={},body}={}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method,headers},res=>{let text='';res.setEncoding('utf8');res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)}));});req.on('error',reject);req.setTimeout(2000,()=>req.destroy(new Error('request timeout')));req.end(body);});}
async function fixture(t,upstream){const bridge=await startConsoleBridge({hubUrl:site,name:'TEST',nodeToken:'not-a-real-token'},{port:0,request:upstream||(async()=>({siteUrl:site,ticket:'test-ticket-'+crypto.randomUUID()}))});t.after(()=>bridge.close());return bridge;}

test('loopback bridge rejects DNS rebinding hosts and unapproved origins',async t=>{
  let issued=0;const b=await fixture(t,async()=>{issued++;return {siteUrl:site,ticket:'ticket-abcdefghijklmnop'};});
  assert.equal((await request(b.port,{path:'/status',headers:{host:'evil.example:'+b.port}})).status,403);
  for(const origin of ['https://evil.example','null','http://fleet.example.test'])assert.equal((await request(b.port,{path:'/ticket',method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await request(b.port,{path:'/ticket',method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  const good=await request(b.port,{path:'/status',headers:{origin:site}});assert.equal(good.status,200);assert.equal(good.headers['access-control-allow-origin'],site);assert.equal(good.headers['cache-control'],'no-store');assert.equal(issued,0);
});

test('concurrent browser tabs each get their own one-use device ticket',async t=>{
  let issued=0;const b=await fixture(t,async()=>{const n=++issued;await new Promise(r=>setTimeout(r,30));return {siteUrl:site,ticket:'single-use-ticket-'+n+'-abcdefghijklmnopqrstuvwxyz'};});
  const options={path:'/ticket',method:'POST',headers:{origin:site,'content-type':'application/json'},body:'{}'},[a,c]=await Promise.all([request(b.port,options),request(b.port,options)]);assert.equal(a.status,200);assert.equal(c.status,200);assert.notEqual(a.json().ticket,c.json().ticket,'Never hand one redeemable ticket to two independent tabs');assert.equal(issued,2);
});

test('lost ticket creation acknowledgement can be retried with a fresh ticket',async t=>{
  let issued=0;const b=await fixture(t,async()=>{issued++;if(issued===1)throw new Error('Response dropped after server issued a ticket');return {siteUrl:site,ticket:'fresh-ticket-abcdefghijklmnopqrstuvwxyz'};});
  const options={path:'/ticket',method:'POST',headers:{origin:site,'content-type':'application/json'},body:'{}'};assert.equal((await request(b.port,options)).status,503);const retry=await request(b.port,options);assert.equal(retry.status,200);assert.match(retry.json().ticket,/fresh-ticket/);assert.equal(issued,2);
});

test('login redirects only to the configured hub and rejects XHR use',async t=>{
  const b=await fixture(t,async()=>({siteUrl:site,ticket:'ticket-abcdefghijklmnop'}));assert.equal((await request(b.port,{path:'/login',headers:{'sec-fetch-mode':'cors'}})).status,403);const r=await request(b.port,{path:'/login',headers:{'sec-fetch-mode':'navigate'}});assert.equal(r.status,302);assert.equal(new URL(r.headers.location).origin,site);assert.equal(r.headers['referrer-policy'],'no-referrer');
  const other=await fixture(t,async()=>({siteUrl:'https://other.example',ticket:'ticket-abcdefghijklmnop'}));assert.equal((await request(other.port,{path:'/login'})).status,503);
});

test('ticket must be a sufficiently long string, never an object or empty value',async t=>{
  for(const ticket of [{},'', 'short']){const b=await fixture(t,async()=>({siteUrl:site,ticket}));const r=await request(b.port,{path:'/ticket',method:'POST',headers:{origin:site,'content-type':'application/json'},body:'{}'});assert.equal(r.status,503);}
});

test('malformed request targets return 400 without taking the node down',async t=>{
  const b=await fixture(t);assert.equal((await request(b.port,{path:'http://['})).status,400);assert.equal((await request(b.port,{path:'/status'})).status,200);
});
