// Run on the configured master only. Never print credentials or arbitrary URLs.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRequest,readJson} from '../src/common.mjs';
const values=new Map();
for(let i=2;i<process.argv.length;i+=2){
 const flag=process.argv[i],value=process.argv[i+1];
 if(!['--node','--profile','--workspace','--thread','--proof'].includes(flag)||!value||values.has(flag))throw new Error('Use --node --profile --workspace --thread --proof exactly once');
 values.set(flag,value);
}
if(values.size!==5)throw new Error('All five parameters are required');
const installDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const config=readJson(path.join(installDir,'config','node.json'));
const result=await httpRequest(config.hubUrl,'/v1/delivery/integration/bind',{
 method:'POST',token:config.nodeToken,sitesToken:config.sitesToken,proxy:config.proxyUrl,
 body:{nodeId:values.get('--node'),profile:values.get('--profile'),workspaceId:values.get('--workspace'),threadId:values.get('--thread'),probeTaskId:values.get('--proof')}
});
console.log(JSON.stringify(result));
