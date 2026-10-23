import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const [source,destination]=process.argv.slice(2);
if(!source||!destination||path.resolve(source)===path.resolve(destination)||fs.existsSync(destination))throw new Error('Use an existing database and a new snapshot path.');
const live=new DatabaseSync(source,{readOnly:true});
try{
  live.exec('PRAGMA busy_timeout=10000');
  live.exec("VACUUM INTO '"+path.resolve(destination).replaceAll("'","''")+"'");
}finally{live.close();}
const snapshot=new DatabaseSync(destination,{readOnly:true});
try{
  const checks=snapshot.prepare('PRAGMA integrity_check').all();
  if(checks.length!==1||Object.values(checks[0])[0]!=='ok')throw new Error('Snapshot integrity check failed.');
  console.log(JSON.stringify({integrity:'ok',bytes:fs.statSync(destination).size}));
}finally{snapshot.close();}
