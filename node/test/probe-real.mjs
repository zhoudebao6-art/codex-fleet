import fs from 'node:fs';
import path from 'node:path';
import {CodexRPC} from '../src/codex.mjs';
const dataDir=path.join(process.env.TEMP,'codex-fleet-probe');fs.mkdirSync(dataDir,{recursive:true});
const rpc=new CodexRPC({dataDir,tempDir:process.env.TEMP},null);
try{
 await rpc.start();const a=await rpc.call('account/read',{refreshToken:false});
 const s=await rpc.call('skills/list',{cwds:[process.cwd()],forceReload:true});
 console.log(JSON.stringify({rpc:true,accountType:a.account?.type,accountFields:Object.keys(a.account||{}),authenticated:!!a.account,skills:(s.data||[]).map(x=>({cwd:x.cwd,count:x.skills?.length,names:x.skills?.slice(0,5).map(y=>y.name)}))}));
}finally{await rpc.close();}
