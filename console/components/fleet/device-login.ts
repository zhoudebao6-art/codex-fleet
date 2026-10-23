import { api, mutation } from './api';
import type { User } from './types';

let initializing: Promise<{user:User|null}> | null = null;
// Shared across StrictMode effect replays: a one-use ticket is exchanged once.
export function initializeDeviceLogin() {
  return initializing ??= (async()=>{
    const fragment=new URLSearchParams(window.location.hash.slice(1));
    const ticket=fragment.get('device-ticket');
    if(ticket){
      try { await mutation('/api/console/device-session',{ticket}); }
      catch(error) { const current=await api<{user:User|null}>('/api/console/me'); if(!current.user)throw error; }
      finally { window.history.replaceState(null,'',window.location.pathname+window.location.search); }
    }
    let me=await api<{user:User|null}>('/api/console/me');
    if(!me.user && !ticket){
      // Loopback is optional. Phones and unconnected computers keep the account login.
      try {
        const response=await fetch('http://127.0.0.1:43129/ticket',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(2500),credentials:'omit'});
        if(response.ok){const local=await response.json() as {siteUrl?:string;ticket?:string};if(local.siteUrl===window.location.origin&&typeof local.ticket==='string'){
          await mutation('/api/console/device-session',{ticket:local.ticket});
          me=await api<{user:User|null}>('/api/console/me');
        }}
      } catch { /* A direct localhost link remains available if browser policy blocks fetch. */ }
    }
    return me;
  })().catch(error=>{initializing=null;throw error;});
}
