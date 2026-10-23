import {assert,hash,json,parse,validId,validProject} from './util.mjs';
import {all,first} from './db.mjs';
import {can} from './auth.mjs';
import {fileScope,nodeScope,readAccess} from './access.mjs';
import {consoleView,visibleItem} from './console-cleanup.mjs';

const KINDS={document:['docx','doc','pdf','txt','md'],archive:['zip','7z','rar','gz','tar'],video:['mp4','mov','webm','mkv'],data:['csv','xlsx','xls','json'],image:['png','jpg','jpeg','webp','svg']};
export async function filesPage(db,n,url){
 const q=(url.searchParams.get('q')||'').trim(),node=url.searchParams.get('node')||'',kind=url.searchParams.get('kind')||'',status=url.searchParams.get('status')||'',project=url.searchParams.get('project')||'',limit=Number(url.searchParams.get('limit')||30);
 assert(q.length<=300,'File search is too long');assert(!node||validId(node),'Invalid file device');assert(!kind||Object.hasOwn(KINDS,kind),'Invalid file type');assert(!status||['complete','uploading','corrupt'].includes(status),'Invalid file status');assert(Number.isInteger(limit)&&limit>=1&&limit<=100,'Invalid file page size');assert(!project||validProject(project)&&can(n,project),'Project access denied',403);
 const scoped=!n.admin&&(!n.browser||n.kind==='device'),scope=scoped?[...parse(n.projects)].sort():null;
 const refScope=[nodeScope(n,'t.target'),...(consoleView(n)?[visibleItem('task','t.id')]:[])].join(' AND ');
 const cte=`WITH visible_refs AS (SELECT r.*,t.project,t.target,t.created AS taskCreated,substr(json_extract(t.spec,'$.prompt'),1,160) AS taskTitle FROM artifact_refs r JOIN tasks t ON t.id=r.task WHERE ${refScope}) `;
 const where=[fileScope(n,'f'),...(consoleView(n)?[visibleItem('file','f.id')]:[])],args=[];
 if(scoped){where.push('f.project IN (SELECT value FROM json_each(?))');args.push(json(scope));}
 if(project){where.push('f.project=?');args.push(project);}
 if(node){where.push('f.owner=? AND '+nodeScope(n,'f.owner'));args.push(node);}
 if(status){where.push('f.status=?');args.push(status);}
 if(kind){where.push('('+KINDS[kind].map(()=>"lower(f.name) LIKE ?").join(' OR ')+')');args.push(...KINDS[kind].map(ext=>'%.'+ext));}
 if(q){const like='%'+q.replace(/[\\%_]/g,'\\$&')+'%';where.push("(f.name LIKE ? ESCAPE '\\' OR f.project LIKE ? ESCAPE '\\' OR f.sha LIKE ? ESCAPE '\\' OR COALESCE(owner.display_name,owner.name,'') LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM visible_refs sr WHERE sr.sha=f.sha AND sr.project=f.project AND (sr.name LIKE ? ESCAPE '\\' OR sr.taskTitle LIKE ? ESCAPE '\\' OR sr.task LIKE ? ESCAPE '\\')))");args.push(...Array(7).fill(like));}
 const signature=hash(json({q,node,kind,status,project,scope,access:n.browser?readAccess(n.access):null})),pageWhere=[...where],pageArgs=[...args],raw=url.searchParams.get('cursor');
 if(raw){let cursor;assert(raw.length<=1000,'Invalid file cursor');try{cursor=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{assert(false,'Invalid file cursor');}assert(cursor&&cursor.signature===signature&&validId(cursor.id)&&typeof cursor.created==='string'&&Number.isFinite(Date.parse(cursor.created)),'Invalid file cursor');pageWhere.push('(f.created<? OR (f.created=? AND f.id<?))');pageArgs.push(cursor.created,cursor.created,cursor.id);}
 const from=` FROM files f LEFT JOIN nodes owner ON owner.id=f.owner AND ${nodeScope(n,'owner.id')}`;
 const reference=`(SELECT json_object('taskId',vr.task,'taskTitle',vr.taskTitle,'direction',vr.direction,'referenceName',vr.name) FROM visible_refs vr WHERE vr.sha=f.sha AND vr.project=f.project ORDER BY vr.direction DESC,vr.taskCreated DESC,vr.task DESC,vr.name LIMIT 1) AS reference`;
 const [rows,count]=await Promise.all([all(db,cte+'SELECT f.id,f.project,f.sha,f.size,f.name,f.status,f.offset,f.created,f.updated,owner.id AS sourceNodeId,COALESCE(owner.display_name,owner.name) AS sourceNodeName,'+reference+from+' WHERE '+pageWhere.join(' AND ')+' ORDER BY f.created DESC,f.id DESC LIMIT ?',...pageArgs,limit+1),first(db,cte+'SELECT count(*) AS total'+from+' WHERE '+where.join(' AND '),...args)]);
 const page=rows.slice(0,limit),last=page.at(-1);
 return {files:page.map(({reference,...f})=>({...f,...(reference?JSON.parse(reference):{})})),total:count.total,nextCursor:rows.length>limit?Buffer.from(json({signature,id:last.id,created:last.created})).toString('base64url'):null};
}
