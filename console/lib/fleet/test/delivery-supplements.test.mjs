import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,uid} from '../util.mjs';
import {normalizeSupplement,supplementalInputs,supplementPublicationEvidence,supplementalPrompt,supplementalPreparationPrompt,SUPPLEMENTAL_SKILL,supplementalSkillEvidence} from '../delivery-supplements.mjs';
test('supplement paths isolate duplicate source basenames and attached input names',()=>{
 const file={name:'same.zip',sha:'a'.repeat(64),size:10};
 const result=supplementalInputs({supplemental:{attachments:[file]},supplementSource:{artifacts:[{...file,name:'first/same.zip'},{...file,name:'second/same.zip'}]}});
 assert.equal(new Set(result.map(x=>x.name)).size,3);
 assert.throws(()=>normalizeSupplement({text:'ok',attachments:[file,file]}));
 assert.throws(()=>normalizeSupplement({text:'ok',attachments:[{...file,name:'../escape'}]}));
});

test('new supplemental contract fixes the skill release and requires a real combined feedback receipt',()=>{
 const spec={profile:'software',supplemental:{text:'解释被要求的视频片段',attachments:[]},supplementalSkill:SUPPLEMENTAL_SKILL};
 const prompt=supplementalPrompt(spec);assert.ok(prompt.includes(SUPPLEMENTAL_SKILL.commit));assert.match(prompt,/算法与计算阶段/);assert.match(prompt,/一个新的反馈ZIP/);assert.doesNotMatch(prompt,/候选技能已安装/);
 const skill={id:SUPPLEMENTAL_SKILL.id,commit:SUPPLEMENTAL_SKILL.commit,entryPath:`E:/研发自动化/${SUPPLEMENTAL_SKILL.versionDirectoryHint}/SKILL.md`,verified:true,invoked:true},packageSha='a'.repeat(64);
 const raw={schema_version:1,tool:{name:'pack_feedback'},case_id:'batch-1',version:'run-1',parent_version:'run-1',requirements:[],main_skill:'software-system-delivery',output_zip:{sha256:packageSha},validation_scope:{file_hashes_verified:true,zip_members_verified:true},files:[{kind:'normal',arcname:'系统/源代码.zip',sha256:'b'.repeat(64)},{kind:'supplemental',arcname:'补充材料/视频解释.docx',sha256:'c'.repeat(64)}]};
 const build=value=>{const rawText=JSON.stringify(value);return {batchId:'batch-1',publishReceipt:{runId:'run-1'},packageSha,supplementalSkill:skill,feedbackPack:{rawText,sha256:hash(rawText)}};};
 assert.equal(supplementalSkillEvidence(build(raw),spec,'produce'),true);
 assert.equal(supplementalSkillEvidence({...build(raw),supplementalSkill:{...skill,commit:'d'.repeat(40)}},spec,'produce'),false);
 assert.equal(supplementalSkillEvidence({...build(raw),supplementalSkill:{...skill,entryPath:'E:/skills/supplemental-delivery/SKILL.md'}},spec,'preflight'),false,'A global same-name skill cannot substitute the frozen snapshot');
 assert.equal(supplementalSkillEvidence(build({...raw,files:raw.files.filter(x=>x.kind!=='normal')}),spec,'produce'),false);
 assert.equal(supplementalSkillEvidence(build({...raw,output_zip:{sha256:'d'.repeat(64)}}),spec,'produce'),false);
 assert.equal(supplementalSkillEvidence(build({...raw,case_id:'different-case'}),spec,'produce'),false);
 assert.equal(supplementalSkillEvidence(build({...raw,files:raw.files.filter(x=>x.kind==='normal')}),spec,'produce'),true,'Normal-only revisions are legitimate when no extra artifact is required');
 assert.equal(supplementalSkillEvidence({supplementalSkill:skill},spec,'preflight'),true);
 assert.equal(supplementalSkillEvidence({},spec,'preflight'),false);
 assert.equal(supplementalSkillEvidence({},{} ,'produce'),true,'Legacy frozen contracts do not acquire new requirements');
});

test('new 1.1 defaults use an isolated release and opt in to code Word and size limits only when requested',()=>{
 assert.equal(SUPPLEMENTAL_SKILL.version,'1.1.0');assert.equal(SUPPLEMENTAL_SKILL.commit,'661b18140f4831c0d4db6f2e418cc88110e53d20');
 assert.equal(SUPPLEMENTAL_SKILL.versionDirectoryHint,`skill-versions/${SUPPLEMENTAL_SKILL.commit}/supplemental-delivery`);
 const spec={supplementalSkill:SUPPLEMENTAL_SKILL,supplemental:{text:'按实际需求处理',attachments:[]}},preparation=supplementalPreparationPrompt(spec),production=supplementalPrompt(spec);
 assert.match(preparation,/优先按本机研发自动化根目录配置/);assert.ok(preparation.includes(SUPPLEMENTAL_SKILL.versionDirectoryHint));assert.match(preparation,/不覆盖或修改活动全局技能/);
 assert.match(production,/仅当用户或材料明确要求纯代码Word/);assert.match(production,/--max-bytes/);assert.match(production,/未要求限额时不传此参数/);assert.match(production,/不给所有案件默认20MB/);
 const old={...spec,supplementalSkill:{id:'supplemental-delivery',version:'1.0.0',repository:SUPPLEMENTAL_SKILL.repository,path:SUPPLEMENTAL_SKILL.path,commit:'67bf813b4d3939497680ad0027832d7c698903ad'}};
 assert.doesNotMatch(supplementalPrompt(old),/661b1814|--max-bytes|skill-versions/);assert.equal(supplementalSkillEvidence({supplementalSkill:{id:'supplemental-delivery',commit:old.supplementalSkill.commit,verified:true,entryPath:'E:/legacy/SKILL.md'}},old,'preflight'),true);
});
test('scoped publication binds original version and independent review without requiring unrelated outputs',()=>{
 const source={sourceHash:'b'.repeat(64)},producer=uid(),reviewer=uid();
 const rawText=JSON.stringify({schema:'supplement-v1',status:'published',runId:'new-run',published:'E:/delivery/new-version',sourceHash:source.sourceHash,snapshot:{'解说词.txt':'c'.repeat(64)}});
 const reviewText='Reviewed requested explanation against original '+source.sourceHash;
 const receipt={sourceHash:source.sourceHash,publishReceipt:{rawText,sha256:hash(rawText),runId:'new-run'},independentReview:{decision:'pass',reviewerId:reviewer,rawText:reviewText,evidenceSha256:hash(reviewText)}};
 assert.ok(supplementPublicationEvidence(receipt,source,producer));
 assert.equal(supplementPublicationEvidence(receipt,source,reviewer),false);
 assert.equal(supplementPublicationEvidence({...receipt,sourceHash:'d'.repeat(64)},source,producer),false);
 assert.equal(supplementPublicationEvidence({...receipt,publishReceipt:{...receipt.publishReceipt,rawText:rawText+' '}},source,producer),false);
});
