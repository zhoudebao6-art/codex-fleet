import {cleanupConsole,cleanupHistory,restoreCleanup} from './console-cleanup.mjs';
import {VERSION,assert,uid,secret,hash,now,json,parse,reply,body,validProject} from './util.mjs';
import {first,all,run,batch} from './db.mjs';
import {authenticate,can,writer,admin,browserMutation} from './auth.mjs';
import {submit,sync,message,changeTask,listNodes,listTasks,tasksPage,taskStats,attentionStats,events,taskAccess,taskDetail} from './tasks.mjs';
import {initializeFile,uploadChunk,fileResponse,fileRow,listFiles,resetFile} from './files.mjs';
import {filesPage} from './file-catalog.mjs';
import {login,logout,changePassword,manageAccounts,metadataBackup} from './accounts.mjs';
import {desktopSync,desktopThreads,desktopDetail,desktopPin,desktopSummary} from './desktop.mjs';
import {createInteraction,listInteractions,answerInteraction,resolveInteraction,maintenance} from './interactions.mjs';
import {listWorkspaces,createWorkspace,workspaceThreads,updateWorkspace,acknowledgeWorkspace,syncWorkspaceCatalog} from './workspaces.mjs';
import {createAutomation,listAutomations,getAutomation,changeAutomation} from './orchestration.mjs';
import {runningProjects} from './running-projects.mjs';
import {listDeviceGroups,createDeviceGroup,updateDeviceGroup,deleteDeviceGroup,updateDevice} from './device-management.mjs';
import {createUpgrade,listNodeActions,acknowledgeNodeAction} from './node-actions.mjs';
import {readAccess,validateAccess,nodeScope,fileScope} from './access.mjs';
import {continueDesktop} from './native-continuation.mjs';
import {createInvitation,enrollInvitation,listInvitations,invitationDetail,revokeInvitation} from './invitations.mjs';
import {listWorkflows,registerWorkflow,cancelWorkflow} from './workflows.mjs';
import {powerView,setPowerPolicy,requestWake,powerPoll,wakeAck} from './power.mjs';
import {deliveryBatchReport,deliverySettings,listDeliveries,getDelivery,createDelivery,createSupplementDelivery,deliveryTick,deliveryAck,controlDelivery,reportDeliveryRecovery} from './deliveries.mjs';
import {deliveryIntegrations,bindLocalIntegration} from './delivery-integration.mjs';
import {createSkillCycle,listSkillCycles,getSkillCycle,controlSkillCycle,advanceSkillCycles,skillReleasePolicy} from './skill-cycles.mjs';
import {maintenanceRequests,cancelMaintenance,advanceMaintenanceRequests} from './skill-maintenance.mjs';
import {skillOwners} from './skill-owners.mjs';
import {controllerRecovery,transferController,withControllerTick} from './controller-recovery.mjs';
import {capacityView} from './capacity.mjs';
import {assertNodeAccess} from './access.mjs';
import {listBackups,createBackup,downloadBackup} from './backups.mjs';
import {caseFlows,registerCaseFlow,setCaseFlowEnabled} from './case-registry.mjs';
import {listCases,getCase,createCase,addCaseRequirements,resumeCase,reconcileCase,advanceCases} from './cases.mjs';

const userView=n=>n?{id:n.userId||n.id,email:n.email||null,name:n.display_name||n.name||n.email||'Fleet operator',role:n.role,...(n.memberId?{memberId:n.memberId}:{}),access:n.admin?{mode:'all',groupIds:[]}:readAccess(n.access),kind:n.kind||'service',...(n.username?{username:n.username}:{}),...(n.kind==='device'?{nodeId:n.nodeId,projects:parse(n.projects)}:{})}:null;
const checkJSON=req=>assert((req.headers.get('content-type')||'').split(';')[0]==='application/json','JSON content type required',415);
function eventOptions(url,defaultLimit=100){const after=Number(url.searchParams.get('after')||0),limit=Number(url.searchParams.get('limit')||defaultLimit),tail=url.searchParams.has('tail')?Number(url.searchParams.get('tail')):null;assert(Number.isSafeInteger(after)&&after>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=500&&(tail===null||(Number.isSafeInteger(tail)&&tail>=0&&tail<=500)),'Invalid event pagination');return {after,limit,tail};}
async function deviceTicket(request,db,n){assert(!n.browser&&!n.admin,'Device token required',403);const token=secret(),expires=new Date(Date.now()+60000).toISOString();await run(db,'INSERT INTO device_tickets(hash,node,expires) VALUES(?,?,?)',hash(token),n.id,expires);return {ticket:token,expires,siteUrl:new URL(request.url).origin};}
async function consumeTicket(request,env){browserMutation(request);const b=await body(request);assert(typeof b.ticket==='string'&&b.ticket.length>=40&&b.ticket.length<=200,'Invalid device ticket',401);const db=env.DB,ticketHash=hash(b.ticket),raw=secret(),sessionHash=hash(raw),ts=now(),expires=new Date(Date.now()+7*86400000).toISOString();await batch(db,[['UPDATE device_tickets SET consumed_session=? WHERE hash=? AND consumed_session IS NULL AND expires>? AND EXISTS(SELECT 1 FROM nodes WHERE id=device_tickets.node AND revoked=0)',sessionHash,ticketHash,ts],['INSERT OR IGNORE INTO device_sessions(hash,node,expires,created) SELECT ?,node,?,? FROM device_tickets WHERE hash=? AND consumed_session=?',sessionHash,expires,ts,ticketHash,sessionHash]]);const session=await first(db,'SELECT n.* FROM device_sessions s JOIN nodes n ON n.id=s.node WHERE s.hash=? AND n.revoked=0',sessionHash);assert(session,'Device ticket expired, used or revoked',401,'DEVICE_TICKET_INVALID');const url=new URL(request.url),local=url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);assert(url.protocol==='https:'||local,'Secure device session required',400);const cookie=(local?'fleet_device':'__Host-fleet-device')+'='+raw+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800'+(local?'':'; Secure');return reply({ok:true,user:userView({...session,id:'device:'+session.id,nodeId:session.id,email:null,role:session.console_role==='operator'?'operator':'viewer',kind:'device',access:readAccess(session.console_access)})},200,{'set-cookie':cookie});}
const memberView=m=>({id:m.id,userId:m.user_id,email:m.email,role:m.role,created:m.created,access:m.role==='admin'?{mode:'all',groupIds:[]}:readAccess(m.group_access)});
async function members(request,db,n,id){
  admin(n);if(request.method==='GET')return reply({members:(await all(db,'SELECT * FROM members WHERE NOT EXISTS(SELECT 1 FROM local_accounts WHERE member_id=members.id) ORDER BY created')).map(memberView)});
  const b=request.method==='DELETE'?{}:await body(request,16384);
  if(request.method==='POST'){
    assert(Object.keys(b).every(k=>['email','role','access'].includes(k)),'Unsupported member field');
    assert(typeof b.email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)&&b.email.length<=320,'Invalid email');assert(['admin','operator','viewer'].includes(b.role),'Invalid role');
    const email=b.email.trim().toLowerCase(),memberId=uid(),access=await validateAccess(db,b.access);assert(!await first(db,'SELECT id FROM members WHERE email=?',email),'Member already exists',409);
    await batch(db,[['INSERT INTO members(id,email,role,created,group_access) VALUES(?,?,?,?,?)',memberId,email,b.role,now(),json(access)],['DELETE FROM settings WHERE key=?','removed_member:'+hash(email)]]);return reply(memberView(await first(db,'SELECT * FROM members WHERE id=?',memberId)));
  }
  assert(id,'Member ID required');const old=await first(db,'SELECT * FROM members WHERE id=?',id);assert(old,'Member not found',404);assert(!await first(db,'SELECT id FROM local_accounts WHERE member_id=?',id),'Manage local accounts through the accounts endpoint',409);
  const count="(SELECT count(*) FROM members m LEFT JOIN local_accounts a ON a.member_id=m.id WHERE m.role='admin' AND (a.id IS NULL OR a.active=1))";
  if(request.method==='PATCH'){
    assert(Object.keys(b).every(k=>['role','access'].includes(k)),'Unsupported member field');
    const role=b.role??old.role;assert(['admin','operator','viewer'].includes(role),'Invalid role');const access=b.access===undefined?readAccess(old.group_access):await validateAccess(db,b.access);
    const result=await run(db,`UPDATE members SET role=?,group_access=? WHERE id=? AND (role!='admin' OR ?='admin' OR ${count}>1)`,role,json(access),id,role);assert(result.meta.changes===1,'Cannot remove the last administrator',409);return reply(memberView(await first(db,'SELECT * FROM members WHERE id=?',id)));
  }
  if(request.method==='DELETE'){
    const result=await batch(db,[[`DELETE FROM members WHERE id=? AND (role!='admin' OR ${count}>1)`,id],["INSERT OR REPLACE INTO settings(key,value) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM members WHERE id=?)",'removed_member:'+hash(old.email),'true',id]]);assert(result[0].meta.changes===1,'Cannot remove the last administrator',409);return reply({ok:true});
  }
  assert(false,'Method not allowed',405);
}
async function knowledge(request,db,n,url){if(request.method==='GET'){const project=url.searchParams.get('project');assert(validProject(project)&&can(n,project),'Project access denied',403);const q=(url.searchParams.get('q')||'').slice(0,300);return reply(await all(db,'SELECT k.* FROM knowledge k WHERE EXISTS(SELECT 1 FROM tasks kt WHERE kt.id=k.source_task AND '+nodeScope(n,'kt.target')+') AND project=? AND version=(SELECT MAX(k2.version) FROM knowledge k2 WHERE k2.project=k.project AND k2.key=k.key) AND (key LIKE ? OR body LIKE ?) ORDER BY created DESC LIMIT 100',project,'%'+q+'%','%'+q+'%'));}
  writer(n);const b=await body(request);assert(validProject(b.project)&&can(n,b.project),'Project access denied',403);assert(typeof b.key==='string'&&/^[\w-]{1,80}$/.test(b.key)&&typeof b.body==='string'&&b.body.length>0&&b.body.length<=16000,'Invalid knowledge entry');const source=await taskAccess(db,n,b.sourceTask);assert(source.project===b.project&&source.status==='accepted','Knowledge requires accepted source task',409);assert(n.admin||source.creator===n.id,'Only task creator or admin may publish knowledge',403);await run(db,'INSERT INTO knowledge(project,key,version,body,source_task,author,created) SELECT ?,?,COALESCE(MAX(version),0)+1,?,?,?,? FROM knowledge WHERE project=? AND key=?',b.project,b.key,b.body,b.sourceTask,n.id,now(),b.project,b.key);return reply(await first(db,'SELECT * FROM knowledge WHERE project=? AND key=? ORDER BY version DESC LIMIT 1',b.project,b.key));}

export async function handle(request,env){try{
  const url=new URL(request.url),route=url.pathname.replace(/\/$/,'')||'/',method=request.method,db=env.DB;assert(db,'Database unavailable',503);
  if(route==='/health'&&method==='GET')return reply({ok:true,version:VERSION,protocol:1});
  if(route==='/api/console/login'&&method==='POST'){browserMutation(request);return await login(request,env);}
  if(route==='/api/console/logout'&&method==='POST'){browserMutation(request);return await logout(request,db);}
  if(route==='/v1/enroll'&&method==='POST'){assert(!request.headers.get('origin'),'Use the local node adapter to enroll',403);checkJSON(request);return reply(await enrollInvitation(db,await body(request,4096)));}
  if(route==='/api/console/device-session'&&method==='POST')return await consumeTicket(request,env);
  if(route==='/api/console/me'&&method==='GET')return reply({user:userView(await authenticate(request,env,{optional:true,consoleOnly:true}))});
  const consoleOnly=route.startsWith('/api/console/'),raw=method==='PUT',n=await authenticate(request,env,{consoleOnly,raw});
  if(['POST','PUT','PATCH','DELETE'].includes(method)&&!raw)checkJSON(request);
  if(route==='/api/console/password'&&method==='POST')return await changePassword(request,db,n);
  if(route==='/v1/power/poll'&&method==='POST')return reply(await powerPoll(db,n,await body(request,40000)));
  const powerAck=route.match(/^\/v1\/power\/actions\/([\w-]+)\/ack$/);
  if(powerAck&&method==='POST')return reply(await wakeAck(db,n,powerAck[1],await body(request,4096)));
  const power=route.match(/^\/v1\/nodes\/([\w-]+)\/(power|wake)$/);
  if(power){
    if(power[2]==='power'&&method==='GET')return reply(await powerView(db,n,power[1]));
    if(power[2]==='power'&&method==='PATCH')return reply(await setPowerPolicy(db,n,power[1],await body(request,1024)));
    if(power[2]==='wake'&&method==='POST')return reply(await requestWake(db,n,power[1],await body(request,1024)));
  }
  const account=route.match(/^\/api\/console\/accounts(?:\/([\w-]+)(?:\/(password))?)?$/);if(account)return await manageAccounts(request,db,n,account[1],account[2]);
  if(route==='/api/console/backup'&&method==='GET')return reply(await metadataBackup(db,n),200,{'content-disposition':'attachment; filename="fleet-metadata-backup-'+new Date().toISOString().slice(0,10)+'.json"'});
  if(route==='/api/console/backups'&&method==='GET')return reply(await listBackups(db,n));
  if(route==='/api/console/backups'&&method==='POST')return reply(await createBackup(db,n,await body(request,1024)));
  const backup=route.match(/^\/api\/console\/backups\/([\w-]+)\/download$/);if(backup&&method==='GET')return await downloadBackup(db,env.BUCKET,n,backup[1],url.searchParams.has('part')?Number(url.searchParams.get('part')):null);
  if(route==='/api/console/installer'){
    if(method==='POST'){admin(n);const b=await body(request);assert(typeof b.version==='string'&&/^[\w.-]{1,80}$/.test(b.version)&&typeof b.name==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.zip$/.test(b.name)&&validProject(b.project)&&/^[a-f0-9]{64}$/.test(b.sha),'Invalid installer metadata');const f=await fileRow(db,n,b.project,b.sha);assert(f.status==='complete'&&f.size===b.size&&f.name.split(/[\\/]/).pop()===b.name,'Installer must match a completed ZIP upload',409);await run(db,'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value','installer',json({version:b.version,name:b.name,size:b.size,sha256:b.sha,project:b.project}));}
    if(method==='GET'||method==='POST'){const row=await first(db,"SELECT value FROM settings WHERE key='installer'");if(!row)return reply(null);const item=parse(row.value);if(!can(n,item.project))return reply(null);const f=await first(db,"SELECT size,name FROM files WHERE project=? AND sha=? AND status='complete' AND "+fileScope(n),item.project,item.sha256);if(!f||f.size!==item.size||f.name.split(/[\\/]/).pop()!==item.name)return reply(null);return reply({...item,downloadUrl:'/api/console/files/'+item.sha256+'?project='+encodeURIComponent(item.project)});}
  }
  if(route==='/v1/device-session'&&method==='POST')return reply(await deviceTicket(request,db,n));
  if(route==='/api/console/cleanup'&&method==='GET')return reply(await cleanupHistory(db,n));
  if(route==='/api/console/cleanup'&&method==='POST')return reply(await cleanupConsole(db,n,await body(request,200000)));
  const restore=route.match(/^\/api\/console\/cleanup\/([\w-]+)\/restore$/);if(restore&&method==='POST')return reply(await restoreCleanup(db,n,restore[1]));
  if(route==='/api/console/overview'&&method==='GET'){const options=eventOptions(url);const [nodes,tasks,ev,files,counts,projects,viewState,attention]=await Promise.all([listNodes(db,n),listTasks(db,n,url),events(db,n,options),listFiles(db,n),taskStats(db,n),runningProjects(db,n),first(db,"SELECT COALESCE(MAX(COALESCE(json_extract(value,'$.restoredAt'),json_extract(value,'$.createdAt'))),'') AS revision FROM settings WHERE key LIKE 'console_cleanup:%'"),attentionStats(db,n)]);return reply({viewRevision:viewState.revision,user:userView(n),nodes,tasks,taskStats:counts,attentionStats:attention,runningProjects:projects,events:ev,files,cursor:ev.at(-1)?.seq||options.after});}
  const member=route.match(/^\/api\/console\/members(?:\/([\w-]+))?$/);if(member)return await members(request,db,n,member[1]);
  if((route==='/api/console/invites'||route==='/v1/invites')&&method==='POST')return reply(await createInvitation(db,n,await body(request,16384),url.origin));
  if(route==='/api/console/invites'&&method==='GET')return reply(await listInvitations(db,n,url));
  const invitation=route.match(/^\/api\/console\/invites\/([\w-]+)$/);
  if(invitation&&method==='GET')return reply(await invitationDetail(db,n,invitation[1]));
  if(invitation&&method==='DELETE')return reply(await revokeInvitation(db,n,invitation[1]));
  if(route==='/v1/nodes'&&method==='GET')return reply(await listNodes(db,n));
  if(route==='/v1/delivery/settings'&&method==='GET')return reply(await deliverySettings(db,n));
  if(route==='/v1/delivery/settings'&&method==='POST')return reply(await deliverySettings(db,n,await body(request,64000)));
  if(route==='/v1/delivery/tick'&&method==='POST')return reply(await withControllerTick(db,n,async guarded=>{await advanceSkillCycles(guarded,env,n);await advanceMaintenanceRequests(guarded,env,n);await advanceCases(guarded,env,{nodeId:n.id});return deliveryTick(guarded,n);}));
  if(route==='/v1/delivery/controller-recovery'&&method==='GET')return reply(await controllerRecovery(db,n));
  if(route==='/v1/delivery/controller-recovery'&&method==='POST')return reply(await transferController(db,n,await body(request,4096)));
  const nodeCapacity=route.match(/^\/v1\/nodes\/([\w-]+)\/capacity$/);if(nodeCapacity&&method==='GET'){await assertNodeAccess(db,n,nodeCapacity[1]);return reply(await capacityView(db,nodeCapacity[1]));}
  if(route==='/v1/skill-maintenance'&&['GET','POST'].includes(method))return reply(await maintenanceRequests(db,n,method==='POST'?await body(request,24000):undefined));
  if(route==='/v1/skill-owners'&&['GET','POST'].includes(method))return reply(await skillOwners(db,n,method==='POST'?await body(request,16000):undefined));
  const maintenanceRequest=route.match(/^\/v1\/skill-maintenance\/([\w-]+)\/cancel$/);if(maintenanceRequest&&method==='POST')return reply(await cancelMaintenance(db,n,maintenanceRequest[1]));
  if(route==='/v1/skill-release-policy'&&['GET','POST'].includes(method))return reply(await skillReleasePolicy(db,n,method==='POST'?await body(request,64000):undefined));
  if(route==='/v1/skill-cycles'&&method==='GET')return reply(await listSkillCycles(db,n));
  if(route==='/v1/skill-cycles'&&method==='POST')return reply(await createSkillCycle(db,n,await body(request,64000)));
  const skillCycle=route.match(/^\/v1\/skill-cycles\/([\w-]+)(?:\/(pause|resume|cancel))?$/);
  if(skillCycle&&method==='GET'&&!skillCycle[2])return reply(await getSkillCycle(db,n,skillCycle[1]));
  if(skillCycle&&method==='POST'&&skillCycle[2])return reply(await controlSkillCycle(db,n,skillCycle[1],skillCycle[2]));
  if(route==='/v1/delivery/integration'&&method==='GET')return reply(await deliveryIntegrations(db,n));
  if(route==='/v1/delivery/integration/bind'&&method==='POST')return reply(await bindLocalIntegration(db,n,await body(request,4096)));
  if(route==='/v1/deliveries'&&method==='GET')return reply(await listDeliveries(db,n,url));
  if(route==='/v1/case-flows'&&method==='GET')return reply(await caseFlows(db));
  if(route==='/v1/case-flows'&&method==='POST')return reply(await registerCaseFlow(db,n,await body(request,20000)));
  const caseFlow=route.match(/^\/v1\/case-flows\/([\w-]+)$/);if(caseFlow&&method==='PATCH')return reply(await setCaseFlowEnabled(db,n,caseFlow[1],await body(request,1000)));
  if(route==='/v1/cases'&&method==='GET')return reply(await listCases(db,n,url));
  if(route==='/v1/cases'&&method==='POST')return reply(await createCase(db,env,n,await body(request,64000)));
  const dossier=route.match(/^\/v1\/cases\/([\w-]+)(?:\/(requirements|resume|reconcile))?$/);
  if(dossier&&method==='GET'&&!dossier[2])return reply(await getCase(db,n,dossier[1]));
  if(dossier&&method==='POST'&&dossier[2]){const input=await body(request,32000);return reply(dossier[2]==='requirements'?await addCaseRequirements(db,env,n,dossier[1],input):dossier[2]==='resume'?await resumeCase(db,env,n,dossier[1],input):await reconcileCase(db,env,n,dossier[1]));}
  if(route==='/v1/deliveries'&&method==='POST')return reply(await createDelivery(db,n,await body(request,64000)));
  const supplement=route.match(/^\/v1\/deliveries\/([\w-]+)\/supplements$/);
  if(supplement&&method==='POST')return reply(await createSupplementDelivery(db,n,supplement[1],await body(request,32000)));
  const batchReport=route.match(/^\/v1\/deliveries\/([\w-]+)\/batch-report$/);
  if(batchReport&&method==='POST')return reply(await deliveryBatchReport(db,n,batchReport[1],await body(request,100000)));
  const recovery=route.match(/^\/v1\/deliveries\/([\w-]+)\/recovery$/);
  if(recovery&&method==='POST')return reply(await reportDeliveryRecovery(db,n,recovery[1],await body(request,16000)));
  const delivery=route.match(/^\/v1\/deliveries\/([\w-]+)(?:\/(ack|pause|resume|retry|recheck|cancel|message))?$/);
  if(delivery){if(!delivery[2]&&method==='GET')return reply(await getDelivery(db,n,delivery[1]));if(delivery[2]&&method==='POST'){const input=await body(request,delivery[2]==='ack'?100000:16000);return reply(delivery[2]==='ack'?await withControllerTick(db,n,guarded=>deliveryAck(guarded,env,n,delivery[1],input),{rejectBusy:true}):await controlDelivery(db,n,delivery[1],delivery[2],input));}}
  if(route==='/v1/node/actions'&&method==='GET')return reply(await listNodeActions(db,n));
  const nodeAction=route.match(/^\/v1\/node\/actions\/([\w-]+)\/ack$/);if(nodeAction&&method==='POST')return reply(await acknowledgeNodeAction(db,n,nodeAction[1],await body(request,4096)));
  const deviceAction=route.match(/^\/v1\/nodes\/([\w-]+)\/(upgrade|actions)$/);if(deviceAction?.[2]==='upgrade'&&method==='POST')return reply(await createUpgrade(db,n,deviceAction[1],await body(request,4096)));if(deviceAction?.[2]==='actions'&&method==='GET')return reply(await listNodeActions(db,n,deviceAction[1]));
  if(route==='/v1/device-groups'&&method==='GET')return reply(await listDeviceGroups(db,n));
  if(route==='/v1/device-groups'&&method==='POST')return reply(await createDeviceGroup(db,n,await body(request,4096)));
  const displayGroup=route.match(/^\/v1\/device-groups\/([\w-]+)$/);if(displayGroup&&method==='PATCH')return reply(await updateDeviceGroup(db,n,displayGroup[1],await body(request,4096)));if(displayGroup&&method==='DELETE')return reply(await deleteDeviceGroup(db,n,displayGroup[1]));
  const device=route.match(/^\/v1\/nodes\/([\w-]+)$/);if(device&&method==='PATCH')return reply(await updateDevice(db,n,device[1],await body(request,4096)));
  const revoke=route.match(/^\/v1\/nodes\/([\w-]+)\/revoke$/);if(revoke&&method==='POST'){admin(n);assert(await first(db,'SELECT id FROM nodes WHERE id=?',revoke[1]),'Node not found',404);await batch(db,[['UPDATE nodes SET revoked=1 WHERE id=?',revoke[1]],['DELETE FROM device_sessions WHERE node=?',revoke[1]],['DELETE FROM device_tickets WHERE node=?',revoke[1]]]);return reply({ok:true});}
  if(route==='/v1/sync'&&method==='POST'){const result=await sync(db,n,await body(request));await advanceCases(db,env,{nodeId:n.id});return reply(result);}
  if(route==='/v1/node/maintenance'&&method==='POST')return reply(await maintenance(db,n,await body(request,4096)));
  if(route==='/v1/workspaces'&&method==='GET')return reply(await listWorkspaces(db,n,url));
  if(route==='/v1/workspaces'&&method==='POST')return reply(await createWorkspace(db,n,await body(request,16000)));
  if(route==='/v1/workspaces/sync'&&method==='POST')return reply(await syncWorkspaceCatalog(db,n,await body(request,180000)));
  const workspace=route.match(/^\/v1\/workspaces\/([\w-]+)(?:\/(threads|ack))?$/);
  if(workspace){const id=workspace[1],action=workspace[2];
    if(!action&&method==='PATCH')return reply(await updateWorkspace(db,n,id,await body(request,16000)));
    if(action==='threads'&&method==='GET')return reply(await workspaceThreads(db,n,id));
    if(action==='ack'&&method==='POST')return reply(await acknowledgeWorkspace(db,n,id,await body(request,16000)));
  }
  if(route==='/v1/desktop/sync'&&method==='POST')return reply(await desktopSync(db,n,await body(request,1024*1024)));
  if(route==='/v1/desktop/threads'&&method==='GET')return reply(await desktopThreads(db,n,url));
  if(route==='/v1/desktop/summary'&&method==='GET')return reply(await desktopSummary(db,n));
  const desktop=route.match(/^\/v1\/desktop\/threads\/([\w-]+)\/([\w-]+)(?:\/(pin|refresh|message))?$/);
  if(desktop){const nodeId=desktop[1],threadId=desktop[2],action=desktop[3];
    if(!action&&method==='GET')return reply(await desktopDetail(db,n,nodeId,threadId));
    if(action==='message'&&method==='POST')return reply(await continueDesktop(db,n,nodeId,threadId,await body(request,70*1024)));
    if(action==='pin'&&['POST','PATCH'].includes(method))return reply(await desktopPin(db,n,nodeId,threadId,await body(request)));
    if(action==='refresh'&&method==='POST')return reply(await desktopDetail(db,n,nodeId,threadId,{refresh:true}));
  }
  if(route==='/v1/tasks'&&method==='GET')return reply(await listTasks(db,n,url));
  if(route==='/v1/tasks/page'&&method==='GET')return reply(await tasksPage(db,n,url));
  if(route==='/v1/automations'&&method==='GET')return reply(await listAutomations(db,n,url));
  if(route==='/v1/workflows'&&method==='GET')return reply(await listWorkflows(db,n,url));
  if(route==='/v1/workflows'&&method==='POST')return reply(await registerWorkflow(db,n,await body(request,16000)));
  if(route==='/v1/workflows/cancel'&&method==='POST')return reply(await cancelWorkflow(db,n,await body(request,4096)));
  if(route==='/v1/automations'&&method==='POST')return reply(await createAutomation(db,n,await body(request,640000)));
  const automation=route.match(/^\/v1\/automations\/([\w-]+)(?:\/(pause|resume|cancel))?$/);
  if(automation){const id=automation[1],action=automation[2];
    if(!action&&method==='GET')return reply(await getAutomation(db,n,id));
    if(action&&method==='POST')return reply(await changeAutomation(db,n,id,action));
  }
  if(route==='/v1/tasks'&&method==='POST')return reply(await submit(db,n,await body(request)));
  const interaction=route.match(/^\/v1\/tasks\/([\w-]+)\/interactions(?:\/([\w-]+)\/(respond|resolve))?$/);
  if(interaction){const taskId=interaction[1],id=interaction[2],action=interaction[3];
    if(!id&&method==='GET')return reply(await listInteractions(db,n,taskId));
    if(!id&&method==='POST')return reply(await createInteraction(db,n,taskId,await body(request,128*1024)));
    if(action==='respond'&&method==='POST')return reply(await answerInteraction(db,n,taskId,id,await body(request,40*1024)));
    if(action==='resolve'&&method==='POST')return reply(await resolveInteraction(db,n,taskId,id,await body(request,4096)));
  }
  const task=route.match(/^\/v1\/tasks\/([\w-]+)(?:\/(messages|events|accept|cancel|resolve))?$/);if(task){const id=task[1],action=task[2];if(!action&&method==='GET')return reply(await taskDetail(db,n,id));await taskAccess(db,n,id);if(action==='events'&&method==='GET')return reply(await events(db,n,{taskId:id,...eventOptions(url,500)}));if(action==='messages'&&method==='GET')return reply(await all(db,'SELECT * FROM messages WHERE task=? ORDER BY created,id',id));if(action==='messages'&&method==='POST')return reply(await message(db,n,id,await body(request)));if(['accept','cancel','resolve'].includes(action)&&method==='POST')return reply(await changeTask(db,n,id,action,await body(request)));}
  if(route==='/v1/knowledge'&&['GET','POST'].includes(method))return await knowledge(request,db,n,url);
  if((route==='/api/console/files/page'||route==='/v1/files/page')&&method==='GET')return reply(await filesPage(db,n,url));
  if((route==='/api/console/files'||route==='/v1/files')&&method==='POST'){assert(env.BUCKET,'File storage unavailable',503);return reply(await initializeFile(db,n,await body(request),env.BUCKET));}
  const reset=route.match(/^\/api\/console\/files\/([a-f0-9]{64})\/reset$/);if(reset&&method==='POST'){admin(n);const b=await body(request);return reply(await resetFile(db,n,b.project,reset[1],b.reason));}
  const file=route.match(/^\/(?:api\/console|v1)\/files\/([a-f0-9]{64})$/);if(file){assert(env.BUCKET,'File storage unavailable',503);const project=url.searchParams.get('project')||'workspace';if(method==='PUT')return reply(await uploadChunk(db,env.BUCKET,n,project,file[1],Number(url.searchParams.get('offset')),request));if(method==='GET')return await fileResponse(db,env.BUCKET,n,project,file[1],request);}
  const artifact=route.match(/^\/v1\/artifacts\/([a-f0-9]{64})$/);if(artifact){assert(env.BUCKET,'File storage unavailable',503);const t=await taskAccess(db,n,url.searchParams.get('task')),sha=artifact[1],ref=await first(db,'SELECT * FROM artifact_refs WHERE task=? AND sha=?',t.id,sha);if(method==='GET'){assert(ref,'File is not attached to this task',404);return await fileResponse(db,env.BUCKET,n,t.project,sha,request);}assert(!n.browser&&!n.admin&&n.id===t.target,'Only execution node can upload task artifacts',403);assert(['claimed','running','uncertain','cancel_requested'].includes(t.status),'Task is terminal',409);
    if(method==='POST'){const b=await body(request);assert((t.spec.outputs||[]).includes(b.name),'File is not a declared task output',403);const state=await initializeFile(db,n,{...b,sha,project:t.project},env.BUCKET);await run(db,"INSERT OR IGNORE INTO artifact_refs(task,sha,name,direction) VALUES(?,?,?,'output')",t.id,sha,b.name);return reply(state);}
    if(method==='HEAD'){assert(ref,'Initialize upload first',409);const f=await fileRow(db,n,t.project,sha);return new Response(null,{headers:{'x-upload-offset':String(f.offset),'cache-control':'no-store'}});}
    if(method==='PUT'){assert(await first(db,"SELECT 1 FROM artifact_refs WHERE task=? AND sha=? AND direction='output'",t.id,sha),'Initialize output upload first',409);return reply(await uploadChunk(db,env.BUCKET,n,t.project,sha,Number(url.searchParams.get('offset')),request));}
  }
  assert(false,'Not found',404);
}catch(error){if(!error.status)console.error('fleet_request_failed',JSON.stringify({path:new URL(request.url).pathname,method:request.method,error:String(error.cause?.message||error.message).slice(0,500)}));return reply({error:error.status?error.message:'Service temporarily unavailable',...(error.code?{code:error.code}:{})},error.status||500);}}
