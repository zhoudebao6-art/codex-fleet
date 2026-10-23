import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from '../src/worker.mjs';

test('desktop launch telemetry exposes only bounded public state and removes configured credentials',t=>{
 const dir=fs.mkdtempSync('D:/codex+/temp/fleet-launch-report-');fs.mkdirSync(path.join(dir,'desktop-bridge'));
 const worker=new Worker({nodeId:'fixture',nodeToken:'private-test-token',dataDir:path.join(dir,'data'),projects:{}},path.join(dir,'config/node.json'),async()=>{});t.after(()=>worker.store.close());
 assert.equal(worker.desktopLaunchReport(),null);
 const file=path.join(dir,'desktop-bridge/launch-status.json');fs.writeFileSync(file,JSON.stringify({state:'failed',stage:'launch_desktop',at:'2026-10-20T00:00:00Z',errorCode:'DESKTOP_TRUST_REQUIRED',error:'Failure: private-test-token '+'.'.repeat(1000),token:'must never appear',configBackup:'private path'}));
 const report=worker.capabilities().desktopLaunch;assert.equal(report.stage,'launch_desktop');assert.equal(report.error.length,600);assert.ok(!JSON.stringify(report).includes('private-test-token'));assert.ok(!JSON.stringify(report).includes('private path'));assert.equal(report.token,undefined);
 assert.equal(report.errorCode,'DESKTOP_TRUST_REQUIRED');
 fs.writeFileSync(file,'x'.repeat(17000));assert.equal(worker.desktopLaunchReport(),null);
});
