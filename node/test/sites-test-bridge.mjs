import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
const [cert,key,port,target]=process.argv.slice(2);
const server=https.createServer({cert:fs.readFileSync(cert),key:fs.readFileSync(key)},(req,res)=>{
  const upstream=http.request(new URL(req.url,target),{method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
});server.listen(Number(port),'127.0.0.1');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit()));
