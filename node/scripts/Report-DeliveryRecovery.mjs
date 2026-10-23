// Authenticated with this installation's node identity; never copy credentials.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRequest,readJson} from '../src/common.mjs';
const values=new Map();
for(let i=2;i<process.argv.length;i+=2){
 const flag=process.argv[i],value=process.argv[i+1];
 if(!['--batch','--issue','--report'].includes(flag)||!value||values.has(flag))throw new Error('Use --batch --issue --report once');
 values.set(flag,value);
}
if(values.size!==3||![values.get('--batch'),values.get('--issue')].every(v=>/^[\w-]{1,100}$/.test(v)))throw new Error('Invalid recovery identity');
const file=path.resolve(values.get('--report'));
if(fs.statSync(file).size>24000)throw new Error('Recovery report too large');
const report=readJson(file),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const config=readJson(path.join(root,'config','node.json'));
const result=await httpRequest(config.hubUrl,`/v1/deliveries/${values.get('--batch')}/recovery`,{
 method:'POST',token:config.nodeToken,sitesToken:config.sitesToken,proxy:config.proxyUrl,
 body:{issueId:values.get('--issue'),action:report.action,note:report.note,learning:report.learning,skillRepair:report.skillRepair}
});
console.log(JSON.stringify(result));
