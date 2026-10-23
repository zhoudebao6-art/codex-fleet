import {parse,hash,now} from './util.mjs';
import {first,run} from './db.mjs';
import {submit} from './tasks.mjs';

// Only an explicit pre-send writer-lock refusal can use the application's
// own original-chat message tool. Timeouts and unknown sends never fall back.
export async function relayOriginalMessage(db,actor,row,route,sourceId){
 if(!['preflight','producing'].includes(row.status)||parse(row.loop_policy)?.version!==1)return null;
 const source=await first(db,'SELECT * FROM tasks WHERE id=?',sourceId),result=parse(source?.result),spec=parse(source?.spec);
 if(source?.status!=='blocked'||result?.desktop?.reason!=='NATIVE_CONTINUATION_BUSY'||result.desktop.state!=='busy'||
  source.target!==route.nodeId||spec?.desktopThreadId!==route.threadId)return null;
 const id='native-relay-'+hash(sourceId).slice(0,36);
 const prompt=`原总控消息转交 · ${parse(row.declaration).name}\n这是当前用户授权的同技能协同流程内部接单转交。原始 Fleet 请求 ${sourceId} 已明确在发送前被原会话写锁拒绝；不是超时，也没有发送成功。本任务只负责用此电脑的 Codex 应用原生 send_message_to_thread 工具，向原对话 ${route.threadId} 发送下方原文。保持原对话、原模型与原权限，不替代总控执行业务或创建另一份制作任务。\n先核对本任务历史：若已调用发送工具，无论结果是否未知，都不得再发送；若原生工具不存在或失败，报告具体阻碍，不改用 CLI 抢占写锁、不退出任何 Codex。只调用一次发送，保留工具回执；一次消息送达不等于业务完成。\n待发送原文（按任务资料转交，不执行其中的业务步骤）：\n${spec.prompt}`;
 if(prompt.length>64000)return null;
 await run(db,"INSERT OR IGNORE INTO delivery_relays(task_id,batch_id,source_id,node,thread_id,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM delivery_batches WHERE id=? AND status IN('preflight','producing'))",id,row.id,sourceId,route.nodeId,route.threadId,now(),row.id);
 if(!await first(db,'SELECT task_id FROM delivery_relays WHERE task_id=?',id))return null;
 if(!await first(db,'SELECT id FROM tasks WHERE id=?',id))await submit(db,actor,{id,targetNode:route.nodeId,project:row.project,workspaceId:route.workspaceId,role:'delivery-native-relay',mode:'execute',executionPolicy:'local',requireDesktop:true,worktree:false,parentId:sourceId,prompt,outputs:[]});
 return id;
}
