// Request a main-controller judgment. This does not directly edit or publish skills.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {httpRequest,readJson} from '../src/common.mjs';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--request')throw new Error('Use --request <JSON file> with a stable id');
const file=path.resolve(args[1]);if(fs.statSync(file).size>24000)throw new Error('Request is too large');
const b=readJson(file);if(!b.id||!b.profile||!b.project||!b.trigger||!b.description||!b.expected)throw new Error('Require id, profile, project, trigger, description and expected');
const config=readJson(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../config/node.json'));
for(let attempt=0;;attempt++)try{
 const result=await httpRequest(config.hubUrl,'/v1/skill-maintenance',{method:'POST',timeout:15000,token:config.nodeToken,sitesToken:config.sitesToken,proxy:config.proxyUrl,body:b});
 console.log(JSON.stringify({id:result.id,state:result.state,taskId:result.taskId}));break;
}catch(e){if(attempt>=2||e.status&&e.status<500)throw e;await new Promise(r=>setTimeout(r,1000*(attempt+1)));}
