// Desktop owns the real stdio app-server. Fleet is a scoped second client of
// this transport, not another app-server and never another thread-store writer.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const MAX=4*1024*1024;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function desktopInvocation(args){
  const index=args.indexOf('app-server');
  // Only the observed desktop launcher invocation owns runtime.json. Tools
  // inherit CODEX_CLI_PATH too; their --listen servers must never replace it.
  return index>=0&&args.includes('--analytics-default-enabled')&&
    !args.some(a=>['--listen','--remote','--environment-id'].some(flag=>a===flag||a.startsWith(flag+'=')))&&
    !args.includes('--help')&&!args.includes('-h')&&
    !['generate-ts','generate-json-schema','daemon','proxy','help'].includes(args[index+1]);
}
export async function serveDesktopBridge({command,args,endpointFile,cwd,env=process.env,input=process.stdin,output=process.stdout}) {
  let ready=null,closed=false,seq=0,desktopBackpressure=false,desktopOutputError=false;
  const clients=new Map(),requests=new Map(),owners=new Map(),serverRequests=new Map(),announced=new Map();
  // Windows process.stdout pipe writes may block the JS event loop when the
  // desktop stops reading. Use asynchronous file-descriptor writes and honor
  // backpressure so /health and Fleet recovery stay responsive.
  const desktopOutput=process.platform==='win32'&&output===process.stdout?
    fs.createWriteStream(null,{fd:1,autoClose:false,highWaterMark:MAX}):output;
  const desktop={id:'desktop',send:m=>{
    if(desktopOutputError)return;
    if(!desktopOutput.write(JSON.stringify(m)+'\n')&&!desktopBackpressure){
      desktopBackpressure=true;upstream.pause();
      desktopOutput.once('drain',()=>{desktopBackpressure=false;if(!closed&&!desktopOutputError)upstream.resume();});
    }
  }};
  const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const write=m=>{if(!closed&&child.stdin.writable)child.stdin.write(JSON.stringify(m)+'\n');};
  const error=(client,id,message)=>client.send({id,error:{code:-32002,message}});
  const internal=(method,params)=>new Promise((resolve,reject)=>{const id='fleet-internal:'+ ++seq,timer=setTimeout(()=>{requests.delete(id);reject(Error('Desktop state check timed out'));},15000);requests.set(id,{handle:m=>{clearTimeout(timer);m.error?reject(Error(m.error.message)):resolve(m.result);}});write({id,method,params});});
  async function incoming(client,m){
    if(!m||typeof m!=='object')return;
    if(m.method==='initialize'&&client!==desktop){
      if(!ready)return error(client,m.id,'Desktop session bridge is not ready');
      client.send({id:m.id,result:ready});return;
    }
    if(client!==desktop&&m.method==='initialized')return;
    if(!m.method&&m.id!==undefined){
      const req=serverRequests.get(String(m.id));
      if(!req||req.client!==client)return;
      serverRequests.delete(String(m.id));write({...m,id:req.original});return;
    }
    if(client!==desktop){
      if(m.method==='fleet/thread/message'){
        const p=m.params||{};
        if(typeof p.threadId!=='string'||typeof p.text!=='string'||!p.text.trim()||p.text.length>64000||Object.keys(p).some(k=>!['threadId','text'].includes(k)))return error(client,m.id,'Invalid original conversation message');
        try{
          const {thread}=await internal('thread/read',{threadId:p.threadId,includeTurns:true});
          const turn=thread?.turns?.findLast(t=>t.status==='inProgress');
          if(thread?.id!==p.threadId||thread.status?.type!=='active'||!turn?.id)return error(client,m.id,'Conversation is no longer running; no message was sent');
          const result=await internal('turn/steer',{threadId:p.threadId,expectedTurnId:turn.id,input:[{type:'text',text:p.text}]});
          // Keep the original owner and approval routing; this is a message,
          // not a takeover or a second writer.
          client.send({id:m.id,result:{...result,threadId:p.threadId,turnId:turn.id,delivery:'steered'}});
        }catch(e){client.send({id:m.id,error:{code:-32003,message:e.message}});}
        return;
      }
      const allowed=new Set(['thread/start','thread/resume','thread/read','thread/list','thread/turns/list','thread/items/list','thread/loaded/list','thread/name/set','thread/unsubscribe','turn/start','turn/steer','turn/interrupt','account/read','skills/list','project/create','project/list','project/read']);
      if(!allowed.has(m.method))return error(client,m.id,'Method is not available through the Fleet desktop bridge');
      const tid=m.params?.threadId;
      if(tid&&['turn/start','turn/steer','turn/interrupt','thread/name/set'].includes(m.method)&&owners.get(tid)!==client)return error(client,m.id,'This connection does not own the Fleet task');
      if(m.method==='thread/resume'){
        try{const read=await internal('thread/read',{threadId:tid,includeTurns:false});if(read.thread?.status?.type==='active'||(owners.has(tid)&&owners.get(tid)!==client&&clients.has(owners.get(tid).id)))return error(client,m.id,'This conversation is busy; no message was sent');}
        catch{return error(client,m.id,'Desktop state could not be verified; no message was sent');}
      }
    }
    if(m.id!==undefined){const id='fleet-bridge:'+ ++seq;requests.set(id,{client,original:m.id,method:m.method});write({...m,id});}
    else write(m);
  }
  const upstream=readline.createInterface({input:child.stdout});
  desktopOutput.on('error',()=>{desktopOutputError=true;upstream.pause();});
  upstream.on('line',line=>{
    let m;try{m=JSON.parse(line);}catch{return;}
    if(m.method&&m.id!==undefined){
      const tid=m.params?.threadId||m.params?.thread_id,owner=owners.get(tid),client=owner&&clients.has(owner.id)?owner:desktop;
      const id='fleet-server:'+ ++seq;serverRequests.set(id,{client,original:m.id,message:m});client.send({...m,id});return;
    }
    if(m.id!==undefined){const req=requests.get(m.id);if(!req)return;requests.delete(m.id);if(req.handle){req.handle(m);return;}
      if(req.method==='initialize'&&req.client===desktop&&m.result){ready=m.result;}
      if(['thread/start','thread/resume'].includes(req.method)&&m.result?.thread?.id&&req.client!==desktop)owners.set(m.result.thread.id,req.client);
      // The desktop did not issue Fleet's thread/start request, so it does not
      // see that response. Announce the confirmed new thread on its transport
      // even when the backend's initialize options suppressed thread/started.
      if(req.method==='thread/start'&&req.client!==desktop&&m.result?.thread?.id){const tid=m.result.thread.id;if((announced.get(tid)||0)<Date.now())desktop.send({method:'thread/started',params:{thread:m.result.thread}});announced.set(tid,Date.now()+5000);}
      req.client.send({...m,id:req.original});return;
    }
    const started=m.method==='thread/started'?m.params?.thread?.id:null;
    if(!started||(announced.get(started)||0)<Date.now())desktop.send(m);
    if(started)announced.set(started,Date.now()+5000);
    if(announced.size>200)for(const [id,until] of announced)if(until<Date.now())announced.delete(id);
    const tid=m.params?.threadId||m.params?.thread?.id;
    if(tid){const owner=owners.get(tid);if(owner&&clients.has(owner.id))owner.send(m);}
  });
  function disconnect(client){
    if(!clients.delete(client.id))return;
    // Losing Fleet never closes the desktop's backend. Pending human input
    // returns to the desktop. The worker records uncertain delivery separately.
    for(const [id,req] of serverRequests)if(req.client===client){req.client=desktop;desktop.send({...req.message,id});}
  }
  const token=crypto.randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    if(req.headers.origin||!same(req.headers.authorization,'Bearer '+token)){res.writeHead(403).end();return;}
    if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ready:!!ready&&!desktopBackpressure&&!desktopOutputError,pid:process.pid,backendPid:child.pid,protocol:1,desktopBackpressure,desktopOutputError}));return;}
    if(req.method==='POST'&&req.url==='/connect'){
      if(!ready||desktopBackpressure||desktopOutputError){res.writeHead(503).end();return;}
      const client={id:crypto.randomUUID(),send:m=>{if(res.destroyed||res.writableEnded)return;if(res.writableLength>MAX){res.destroy();return;}res.write(JSON.stringify(m)+'\n');}};
      clients.set(client.id,client);res.writeHead(200,{'content-type':'application/x-ndjson','cache-control':'no-store'});client.send({bridgeClientId:client.id,features:{nativeMessages:true,threadAnnouncements:true},version:'0.3.21'});res.on('close',()=>disconnect(client));return;
    }
    if(req.method!=='POST'||!req.url?.startsWith('/rpc/')){res.writeHead(404).end();return;}
    const client=clients.get(req.url.slice(5));if(!client){res.writeHead(409).end();return;}
    try{let raw='';for await(const b of req){raw+=b;if(Buffer.byteLength(raw)>MAX)throw Error('too large');}const message=JSON.parse(raw);incoming(client,message);res.writeHead(204).end();}catch{res.writeHead(400).end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  fs.mkdirSync(path.dirname(endpointFile),{recursive:true});
  const endpoint=JSON.stringify({protocol:1,pid:process.pid,backendPid:child.pid,port:server.address().port,token});
  // A per-instance receipt makes accidental primary-file replacement
  // recoverable without reading credentials from process memory.
  fs.writeFileSync(path.join(path.dirname(endpointFile),'runtime-'+process.pid+'.json'),endpoint,{mode:0o600});
  const temporary=endpointFile+'.'+process.pid+'.partial';
  fs.writeFileSync(temporary,endpoint,{mode:0o600});fs.renameSync(temporary,endpointFile);
  const desktopLines=readline.createInterface({input});desktopLines.on('line',line=>{try{incoming(desktop,JSON.parse(line));}catch{}});
  input.on('end',()=>child.stdin.end());
  const diagnostics=process.platform==='win32'?fs.createWriteStream(null,{fd:2,autoClose:false,highWaterMark:MAX}):process.stderr;
  diagnostics.on('error',()=>{/* The diagnostic sink must not stop execution. */});
  child.stderr.on('data',b=>{if(!diagnostics.destroyed&&!diagnostics.write(b)){child.stderr.pause();diagnostics.once('drain',()=>child.stderr.resume());}});
  const finished=new Promise(resolve=>{
    function finish(code){if(closed)return;closed=true;ready=null;for(const client of clients.values())client.send({bridgeClosed:true});server.closeAllConnections();server.close();desktopLines.close();upstream.close();
      try{const current=JSON.parse(fs.readFileSync(endpointFile,'utf8'));if(current.pid===process.pid)fs.unlinkSync(endpointFile);}catch{}resolve(code??1);}
    child.once('error',()=>finish(1));child.once('exit',finish);
  });
  return {child,finished};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const configuration=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const args=process.argv.slice(3),index=args.indexOf('app-server');
  if(desktopInvocation(args)){
    const service=await serveDesktopBridge({command:configuration.realCodexPath,args,endpointFile:configuration.endpointFile});process.exitCode=await service.finished;
  }else{const child=spawn(configuration.realCodexPath,args,{stdio:'inherit',windowsHide:true});child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});}
}
