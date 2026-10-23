import dgram from 'node:dgram';
import {createHash} from 'node:crypto';
export const mac=value=>typeof value==='string'&&/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(value)?value.replaceAll('-',':').toLowerCase():null;
export const validMac=value=>!!mac(value)&&!(parseInt(mac(value).slice(0,2),16)&1)&&!/^00(:00){5}$/.test(mac(value));
export function ipv4(value){if(typeof value!=='string'||!/^(\d{1,3}\.){3}\d{1,3}$/.test(value))return null;const a=value.split('.').map(Number);return a.every(x=>x<=255)?a.reduce((n,x)=>((n<<8)|x)>>>0,0):null;}
const dotted=n=>[24,16,8,0].map(b=>(n>>>b)&255).join('.');
export function network(address,prefix,gatewayMac){
 const n=ipv4(address),g=mac(gatewayMac);if(n===null||!Number.isInteger(prefix)||prefix<8||prefix>30||!validMac(g))return null;
 if(!((n>>>24)===10||(n>>>20)===0xac1||(n>>>16)===0xc0a8))return null;
 const mask=(0xffffffff<<(32-prefix))>>>0,subnet=dotted((n&mask)>>>0),broadcast=dotted(((n&mask)|(~mask))>>>0);
 return {networkId:createHash('sha256').update(`${g}/${subnet}/${prefix}`).digest('hex'),address,prefix,subnet,broadcast};
}
export function networksFromInventory(value){return (value.adapters||[]).filter(a=>a.status==='Up'&&validMac(a.mac)).flatMap(a=>(a.addresses||[]).map(ip=>{const n=network(ip.address,ip.prefix,ip.gatewayMac);return n?{...n,mac:mac(a.mac),name:a.name,wakeOnMagicPacket:a.wakeOnMagicPacket,wakeArmed:a.wakeArmed}:null}).filter(Boolean));}
export function magicPacket(value){if(!validMac(value))throw Error('Invalid unicast MAC address');const bytes=Buffer.from(mac(value).replaceAll(':',''),'hex');return Buffer.concat([Buffer.alloc(6,255),...Array.from({length:16},()=>bytes)]);}
export async function sendWake(action,networks){
 if(action.kind!=='wake'||!Array.isArray(action.targets)||action.targets.length<1||action.targets.length>8)throw Error('Invalid wake action');
 const evidence=[];
 for(const target of action.targets){
  const local=networks.find(n=>n.networkId===target.networkId&&n.broadcast===target.broadcast);
  if(!local)throw Error('Wake target is not on a verified local physical network');
  const packet=magicPacket(target.mac),socket=dgram.createSocket('udp4');
  try{
   await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(0,local.address,resolve);});
   socket.setBroadcast(true);
   for(let i=0;i<3;i++)await new Promise((resolve,reject)=>socket.send(packet,9,target.broadcast,e=>e?reject(e):resolve()));
   evidence.push({networkId:target.networkId,bytes:packet.length,packets:3});
  }finally{socket.close();}
 }
 return evidence;
}
