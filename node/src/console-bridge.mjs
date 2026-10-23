import http from 'node:http';
import {httpRequest} from './common.mjs';

// Bound only to this Windows user's loopback adapter. No filesystem or command API.
export async function startConsoleBridge(config,{request=httpRequest,port=config.consolePort??43129}={}){
  const hub=new URL(config.hubUrl);
  const ticket=()=>request(config.hubUrl,'/v1/device-session',{method:'POST',token:config.nodeToken,sitesToken:config.sitesToken,proxy:config.proxyUrl,body:{},timeout:15000}).then(value=>{
    if(new URL(value.siteUrl).origin!==hub.origin||typeof value.ticket!=='string'||value.ticket.length<20||value.ticket.length>1000)throw Error('Invalid device ticket');return value;
  });
  const server=http.createServer(async(req,res)=>{
    const address=server.address(),host='127.0.0.1:'+address.port;
    const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'"};
    const send=(status,value,extra={})=>{res.writeHead(status,{...headers,'content-type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(value));};
    if(req.headers.host!==host)return send(403,{error:'Loopback host required'});
    const origin=req.headers.origin;
    if(origin&&origin!==hub.origin)return send(403,{error:'This site is not allowed'});
    const cors=origin?{'access-control-allow-origin':hub.origin,'vary':'Origin','access-control-allow-private-network':'true'}:{};
    let route;try{if(!req.url.startsWith('/')||req.url.startsWith('//'))return send(400,{error:'Invalid request target'});route=new URL(req.url,'http://'+host).pathname;}catch{return send(400,{error:'Invalid request target'});}
    if(req.method==='OPTIONS')return send(200,{ok:true},{...cors,'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'Content-Type'});
    if(route==='/status'&&req.method==='GET')return send(200,{ok:true,name:config.name,siteUrl:hub.origin},cors);
    if(route==='/ticket'&&req.method==='POST'){
      if(origin!==hub.origin||!String(req.headers['content-type']||'').startsWith('application/json'))return send(403,{error:'Site origin required'});
      try{return send(200,await ticket(),cors);}catch{return send(503,{error:'设备暂时无法连接协作台，请稍后重试。'},cors);}
    }
    if(route==='/login'&&req.method==='GET'){
      if(req.headers['sec-fetch-mode']&&req.headers['sec-fetch-mode']!=='navigate')return send(403,{error:'Open this address in the browser'});
      try{const value=await ticket();res.writeHead(302,{...headers,location:hub.origin+'/#device-ticket='+encodeURIComponent(value.ticket)});res.end();}catch{
        res.writeHead(503,{...headers,'content-type':'text/html; charset=utf-8'});res.end('<meta name="viewport" content="width=device-width"><title>协作台连接</title><main style="font:18px system-ui;padding:40px"><h2>暂时无法连接协作台</h2><p>本机节点正在重试。请稍后刷新，或检查网络。</p><a href="/login">重新连接</a></main>');
      }return;
    }
    send(404,{error:'Not found'},cors);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  server.on('error',()=>{});
  return {port:server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
