import fs from 'node:fs';
import http from 'node:http';
import {EventEmitter} from 'node:events';

export class DesktopSessionClient extends EventEmitter {
  constructor(endpointFile){super();this.endpointFile=endpointFile;this.closed=false;this.chain=Promise.resolve();}
  async start(){
    let info;try{info=JSON.parse(fs.readFileSync(this.endpointFile,'utf8'));}catch{throw Error('请先通过 Codex Fleet 联动入口启动本机 Codex 桌面。后台没有另开执行器。');}
    if(info.protocol!==1||!Number.isSafeInteger(info.port)||info.port<1||info.port>65535||!/^[0-9a-f]{64}$/.test(info.token))throw Error('Invalid desktop bridge endpoint');
    this.info=info;let first=true,buffer='';
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.response?.destroy();this.request?.destroy();reject(Error('Desktop bridge connection timed out'));},10000);
      // Streaming connections must not reserve shared HTTP pool slots needed by
      // other readers or by the short RPC POSTs on this same loopback port.
      this.request=http.request({host:'127.0.0.1',port:info.port,path:'/connect',method:'POST',agent:false,headers:{authorization:'Bearer '+info.token}},res=>{
        this.response=res;if(res.statusCode!==200){clearTimeout(timer);res.resume();reject(Error('Desktop bridge is unavailable; no background executor was started'));return;}
        res.setEncoding('utf8');res.on('data',chunk=>{buffer+=chunk;if(buffer.length>4*1024*1024){res.destroy();return;}let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let m;try{m=JSON.parse(line);}catch{continue;}
          if(first){first=false;this.clientId=m.bridgeClientId;this.features=m.features||{};this.version=m.version||null;clearTimeout(timer);if(!this.clientId){reject(Error('Invalid bridge handshake'));return;}resolve();continue;}
          if(m.bridgeClosed){res.destroy();return;}this.emit('message',m);
        }});const lost=()=>{if(!this.closed){this.closed=true;this.emit('disconnect',Error('Desktop session connection ended; do not resend this task automatically'));}};res.on('end',lost);res.on('error',lost);res.on('close',lost);
      });this.request.on('error',e=>{clearTimeout(timer);reject(e);});this.request.end();
    });return this;
  }
  send(message){
    this.chain=this.chain.then(()=>new Promise((resolve,reject)=>{
      if(this.closed)return reject(Error('Desktop bridge is disconnected'));
      const req=http.request({host:'127.0.0.1',port:this.info.port,path:'/rpc/'+this.clientId,method:'POST',agent:false,headers:{authorization:'Bearer '+this.info.token,'content-type':'application/json'}},res=>{res.resume();if(res.statusCode!==204)reject(Error('Desktop bridge rejected request'));else resolve();});
      req.setTimeout(15000,()=>req.destroy(Error('Desktop bridge send timeout')));req.on('error',reject);req.end(JSON.stringify(message));
    })).catch(e=>{if(!this.closed){this.closed=true;this.emit('disconnect',e);}});
  }
  close(){this.closed=true;this.response?.destroy();this.request?.destroy();}
}
