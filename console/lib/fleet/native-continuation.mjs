import {assert,validId,parse} from './util.mjs';
import {first} from './db.mjs';
import {directoryFilter} from './project-paths.mjs';
import {writer} from './auth.mjs';
import {desktopAccess} from './desktop.mjs';
import {submit,taskAccess} from './tasks.mjs';

// The caller selects a synchronized conversation, never its execution directory
// or policy. The node must acquire Codex's own writer lock before continuing.
export async function continueDesktop(db,actor,nodeId,threadId,body){
  writer(actor);assert(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).every(k=>['id','prompt'].includes(k)),'Only a stable request ID and prompt are accepted');
  assert(validId(body.id)&&typeof body.prompt==='string'&&body.prompt.trim().length>0&&body.prompt.length<=64000,'Invalid continuation request');
  const thread=await desktopAccess(db,actor,nodeId,threadId);assert(!thread.archived,'Restore the archived conversation locally before continuing',409,'NATIVE_THREAD_ARCHIVED');
  const prior=await first(db,'SELECT * FROM tasks WHERE id=?',body.id);
  if(prior){const spec=parse(prior.spec);assert(prior.creator===actor.id&&prior.target===nodeId&&prior.project===thread.project&&spec.desktopThreadId===threadId&&spec.prompt===body.prompt,'Continuation request ID already used',409);return await taskAccess(db,actor,body.id);}
  const node=await first(db,'SELECT * FROM nodes WHERE id=? AND revoked=0',nodeId);assert(node&&node.last_seen&&Date.now()-Date.parse(node.last_seen)<60000,'The computer is offline; retry after it reconnects',409,'NODE_OFFLINE');
  const caps=parse(node.capabilities)||{};
  assert(!caps.parallelExecution||caps.conversationDispatch===true,'节点已更新，桌面联动尚未激活。请在当前工作结束后，从“Codex Fleet 联动”重新打开。',409,'DESKTOP_CONNECTION_ACTIVATION_REQUIRED');
  assert(parse(node.capabilities)?.desktopContinuation===true,'This adapter has not verified native conversation continuation',409,'NATIVE_CONTINUATION_UNSUPPORTED');
  assert(typeof thread.cwd==='string'&&thread.cwd.length>0&&thread.cwd.length<=2000,'The conversation working directory is not synchronized',409,'NATIVE_DIRECTORY_UNAVAILABLE');
  directoryFilter(thread.cwd);
  // A continuation uses the existing thread's policy and transport. Keep its
  // strict native contract free of new-task execution overrides.
  const spec={id:body.id,targetNode:nodeId,project:thread.project,prompt:body.prompt,mode:'execute',worktree:false,desktopThreadId:threadId,desktopCwd:thread.cwd};
  return await submit(db,actor,spec,null,{desktopContinuation:true});
}
