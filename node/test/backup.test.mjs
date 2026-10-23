import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';

test('Windows backup snapshots a database held by another connection without its WAL or uncommitted rows',{skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-backup-check-')),install=path.join(root,'existing install'),backups=path.join(root,'private backups');
  for(const part of ['runtime','config','data/node','workspace'])fs.mkdirSync(path.join(install,part),{recursive:true});
  fs.copyFileSync(process.execPath,path.join(install,'runtime/node.exe'));fs.writeFileSync(path.join(install,'config/node.json'),JSON.stringify({nodeId:'fixture',nodeToken:'fixture-private-token'}));fs.writeFileSync(path.join(install,'workspace/not-in-fleet-backup.txt'),'separate project source');
  const db=new DatabaseSync(path.join(install,'data/node/node.sqlite'));
  db.exec("PRAGMA journal_mode=WAL;CREATE TABLE evidence(value TEXT);INSERT INTO evidence VALUES('committed row');BEGIN IMMEDIATE;INSERT INTO evidence VALUES('uncommitted row');");
  try{
    const env={...process.env,TEMP:os.tmpdir(),TMP:os.tmpdir(),TMPDIR:os.tmpdir()};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
    const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/Backup-Fleet.ps1',import.meta.url)),'-InstallDir',install,'-BackupRoot',backups],{encoding:'utf8',windowsHide:true,env});
    assert.ok(!output.includes('fixture-private-token'));
    const destination=path.join(backups,fs.readdirSync(backups)[0]),manifest=JSON.parse(fs.readFileSync(path.join(destination,'backup-manifest.json'),'utf8'));
    assert.equal(manifest.complete,true);assert.ok(manifest.excludes.includes('Primary project workspaces outside data'));assert.equal(fs.existsSync(path.join(destination,'BACKUP-INCOMPLETE.txt')),false);assert.equal(fs.existsSync(path.join(destination,'data/node/node.sqlite-wal')),false);assert.equal(fs.existsSync(path.join(destination,'data/node/node.sqlite-shm')),false);assert.equal(fs.existsSync(path.join(destination,'workspace')),false);
    const snapshot=new DatabaseSync(path.join(destination,'data/node/node.sqlite'),{readOnly:true});try{assert.deepEqual(snapshot.prepare('SELECT value FROM evidence').all().map(r=>r.value),['committed row']);assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{snapshot.close();}
    const entry=manifest.files.find(f=>f.path==='data\\node\\node.sqlite');assert.equal(entry.mode,'sqlite_snapshot');assert.equal(entry.integrity,'ok');assert.equal(fs.readFileSync(path.join(destination,'config/node.json'),'utf8'),fs.readFileSync(path.join(install,'config/node.json'),'utf8'));
  }finally{db.exec('ROLLBACK');db.close();}
});
