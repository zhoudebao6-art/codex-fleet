// A history page cannot prove idleness: long-running work may be older than it.
export async function activeTaskProof(client,nodeId,clock=Date.now) {
  const page=await client.api('/v1/tasks/page?'+new URLSearchParams({target:nodeId,phase:'active',limit:'1'}));
  if(!Number.isSafeInteger(page?.total)||page.total<0||!Array.isArray(page.tasks)||
    !Number.isFinite(Date.parse(page.serverTime))||Math.abs(clock()-Date.parse(page.serverTime))>300000||
    (page.total===0&&(page.tasks.length||page.nextCursor))||
    (page.total>0&&page.tasks.length!==1))
    throw Error('Fresh complete active task count is unavailable');
  return {total:page.total,remote:page.tasks.map(t=>({id:t.id,status:t.status})),completeProof:true};
}
