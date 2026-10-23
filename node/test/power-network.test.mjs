import test from 'node:test';
import assert from 'node:assert/strict';
import {network,magicPacket,sendWake,networksFromInventory} from '../src/power-network.mjs';
test('LAN identity distinguishes identical private ranges at different sites',()=>{
 const a=network('192.168.2.101',24,'10-9f-4f-5a-b8-0c'),b=network('192.168.2.10',24,'10:9f:4f:5a:b8:0c'),other=network('192.168.2.101',24,'10:9f:4f:00:00:01');
 assert.equal(a.networkId,b.networkId);assert.notEqual(a.networkId,other.networkId);assert.equal(a.broadcast,'192.168.2.255');
 assert.equal(network('100.64.1.3',24,'10:9f:4f:00:00:01'),null);assert.equal(network('192.168.2.1',24,'00:00:00:00:00:00'),null);
});
test('magic packet format and subnet restrictions prevent arbitrary destinations',async()=>{
 const p=magicPacket('00-e0-4f-45-c5-66');assert.equal(p.length,102);assert.deepEqual(p.subarray(0,6),Buffer.alloc(6,255));
 for(let i=0;i<16;i++)assert.equal(p.subarray(6+i*6,12+i*6).toString('hex'),'00e04f45c566');
 assert.throws(()=>magicPacket('ff:ff:ff:ff:ff:ff'));
 await assert.rejects(sendWake({kind:'wake',targets:[{networkId:'x',broadcast:'8.8.8.8',mac:'00:e0:4f:45:c5:66'}]},[]),/verified local/);
});
