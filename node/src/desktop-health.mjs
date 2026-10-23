import fs from 'node:fs';
import http from 'node:http';

export async function desktopHealth(endpointFile,timeout=4000){
  try{
    const raw=fs.readFileSync(endpointFile,'utf8'),info=JSON.parse(raw);
    if(info.protocol!==1||!Number.isInteger(info.port)||info.port<1||info.port>65535||!/^[0-9a-f]{64}$/.test(info.token))throw Error('Invalid endpoint');
    const value=await new Promise((resolve,reject)=>{
      const req=http.get({host:'127.0.0.1',port:info.port,path:'/health',agent:false,headers:{authorization:'Bearer '+info.token}},res=>{
        if(res.statusCode!==200){res.resume();reject(Error('Health unavailable'));return;}
        let data='';res.on('data',chunk=>{data+=chunk;if(data.length>4096)req.destroy(Error('Health response too large'));});
        res.on('error',reject);res.on('end',()=>{try{resolve(JSON.parse(data));}catch{reject(Error('Invalid health response'));}});
      });
      req.setTimeout(timeout,()=>req.destroy(Error('Desktop health timeout')));req.on('error',reject);
    });
    if(fs.readFileSync(endpointFile,'utf8')!==raw||value.protocol!==1||value.pid!==info.pid||value.backendPid!==info.backendPid)throw Error('Desktop endpoint changed');
    return {ready:value.ready===true,checkedAt:new Date().toISOString(),...(value.ready===true?{}:{error:'桌面连接暂不可用；保留现有任务，暂停新派发。'})};
  }catch{return {ready:false,checkedAt:new Date().toISOString(),error:'桌面连接健康检查失败；保留现有任务，暂停新派发。'};}
}
