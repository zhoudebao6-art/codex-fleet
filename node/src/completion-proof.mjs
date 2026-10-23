import path from 'node:path';

// A terminal record for this exact turn is evidence. An idle thread, elapsed
// timeout, existing output file, or a model saying "done" is not.
export async function readCompletionProof(rpc,{task,thread,cwd,turnId,legacy=false}) {
  if(!thread||!cwd||(!turnId&&!legacy))return null;
  const info=(await rpc.call('thread/read',{threadId:thread,includeTurns:false},12000)).thread;
  if(info?.id!==thread||path.resolve(info.cwd||'').toLowerCase()!==path.resolve(cwd).toLowerCase())return null;
  const page=await rpc.call('thread/turns/list',{threadId:thread,limit:1,sortDirection:'desc',itemsView:'summary'},12000);
  const turn=page.data?.[0];
  if(!turn?.id||!['completed','failed','interrupted'].includes(turn.status)||!Number.isFinite(turn.completedAt))return null;
  if(turnId&&turn.id!==turnId)return null;
  if(!turnId){
    const first=(turn.items||[]).find(i=>i.type==='userMessage');
    if(!(first?.content||[]).some(i=>i.type==='text'&&i.text?.startsWith(`Fleet task ${task}. Role: `)))return null;
  }
  if(info.status?.type==='active')return null;
  const messages=(turn.items||[]).filter(i=>i.type==='agentMessage');
  const final=messages.findLast(i=>i.phase==='final_answer')||messages.at(-1);
  return {status:turn.status==='completed'?'submitted':turn.status==='interrupted'?'cancelled':'failed',
    summary:final?.text||'',error:turn.error?.message||null,threadId:thread,turnId:turn.id,
    completionProof:{method:'exact_terminal_turn',turnStatus:turn.status,completedAt:turn.completedAt,checkedAt:new Date().toISOString()}};
}
