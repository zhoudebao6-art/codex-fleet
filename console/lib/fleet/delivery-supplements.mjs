import {assert,hash,relativeFile} from './util.mjs';

export const SUPPLEMENTAL_SKILL=Object.freeze({id:'supplemental-delivery',version:'1.1.0',repository:'zhoudebao6-art/software-system-delivery',path:'skills/supplemental-delivery',commit:'661b18140f4831c0d4db6f2e418cc88110e53d20',versionDirectoryHint:'skill-versions/661b18140f4831c0d4db6f2e418cc88110e53d20/supplemental-delivery'});
export function hasSupplementalSkill(node){const caps=typeof node.capabilities==='string'?JSON.parse(node.capabilities||'{}'):node.capabilities||{};return (caps.skills||[]).flatMap(s=>typeof s==='string'?[s]:s.names||[]).includes(SUPPLEMENTAL_SKILL.id);}

export function normalizeSupplement(value){
 if(value===undefined)return undefined;
 assert(value&&typeof value==='object'&&!Array.isArray(value),'Invalid supplemental requirements');
 const text=value.text?.trim();
 assert(typeof text==='string'&&text.length>0&&text.length<=6000,'Provide supplemental requirements');
 const attachments=value.attachments??[];
 assert(Array.isArray(attachments)&&attachments.length<=12,'Upload at most 12 supplemental attachments');
 assert(attachments.every(x=>x&&relativeFile(x.name)&&!/[\\/]/.test(x.name)&&/^[a-f0-9]{64}$/.test(x.sha)&&Number.isSafeInteger(x.size)&&x.size>0),'Invalid supplemental attachment');
 assert(new Set(attachments.map(x=>x.name.toLowerCase())).size===attachments.length,'Supplemental attachment names must be unique');
 return {text,attachments:attachments.map(({name,sha,size})=>({name,sha,size}))};
}

export function supplementalInputs(spec){
 return [...(spec.supplemental?.attachments||[]).map((x,i)=>({...x,name:`supplemental/attachments/${i+1}/${x.name}`})),
 ...(spec.supplementSource?.artifacts||[]).map((x,i)=>({sha:x.sha,size:x.size,name:`supplemental/source/${i+1}/${x.name.split(/[\\/]/).pop()}`}))];
}

export function supplementalPreparationPrompt(spec){
 if(!spec.supplementalSkill)return '';
 return `\n本批还冻结补充协作技能 ${JSON.stringify(spec.supplementalSkill)}。本阶段仅在本机真实读取该固定版本的 SKILL.md 与 references/integration.md，核验入口、提交和必要依赖，不制作案件、不调用反馈打包器，不更改正在使用的技能。缺失或版本不符返回blocked和实际缺项。准备收据必须另有 supplementalSkill:{id:"${spec.supplementalSkill.id}",commit:"${spec.supplementalSkill.commit}",entryPath:"实际本机SKILL.md路径",verified:true}，不能把本机其他电脑安装情况当作本机已验证。`+supplementalVersionDirectoryPrompt(spec);
}

function supplementalVersionDirectoryPrompt(spec){
 const hint=spec.supplementalSkill?.versionDirectoryHint;if(!hint)return '';
 return `\n优先按本机研发自动化根目录配置解析固定快照 ${hint}/SKILL.md；当前 Windows 约定入口 E:\\研发自动化\\${hint.replaceAll('/','\\')}\\SKILL.md，实际根目录遵循本机配置。只调用与本批固定提交一致的隔离快照，逐文件核对后将真实入口写入收据；目录缺失、提交或文件不匹配均返回blocked，不能以全局同名技能或其他电脑的核验替代，不覆盖或修改活动全局技能。`;
}

export function supplementalPrompt(spec){
 if(!spec.supplemental)return '';
 const integration=spec.supplementalSkill?`\n本批补充协作技能固定为 ${JSON.stringify(spec.supplementalSkill)}。先读取该版本 SKILL.md 与 references/integration.md，核验当地实际入口与固定提交；缺失或不匹配必须明确返回能力缺项，不假称目标电脑已安装。同一案件只保留已选的一个正常制作主技能，supplemental-delivery 负责需求映射、补充制作及整合，不把两个主流程完整重跑。需求准备阶段先解析，算法与计算阶段预留量与边界，视频录制前纳入确需解释的环节，依赖稳定即可同步制图/写解释，不必机械等整案结束。已有owner、run、冻结版本及验收成果保留，只补受影响部分，不能重新prepare或抢当前工作。正常整套研发材料仍按原主流程验收；已验收且不变的正常成品核验后复用并纳入同版本反馈，不因通知未写研发材料就省略。未经主流程验收的历史文件只能作参照，不能靠补充包追认为合格。只有明确要求的解释Word或图才制作；解释与图范围不扩大。最后实际运行 scripts/pack_feedback.py，按白名单将本次正常材料与明确要求的补充成果汇总为一个新的反馈ZIP，保留正常源码ZIP字节；内部证据和打包收据不混入反馈包。收据增加 supplementalSkill:{id:"supplemental-delivery",commit:"${spec.supplementalSkill.commit}",entryPath:"实际入口",verified:true,invoked:true}，预检查时invoked可不填；制作收据另有 feedbackPack:{rawText:"实际pack_feedback内部收据原文",sha256:"该原文SHA256"}，其output_zip.sha256须等于packageSha，case_id等于本批batchId，version等于publishReceipt.runId，parent_version等于父sourceHash（无父补充版本则等于本轮主发布runId），requirements覆盖requirementsReview的需求ID并绑定实际members。只修改正常成果时允许正常材料满足需求，不强制虚构额外补充文件。打包器不代替主流程或独立内容审核。`:'\n本批沿用已冻结的主技能与需求合同；补充能力不足必须报告具体缺项，不推定目标电脑已配置新技能。';
 const v11=spec.supplementalSkill?.versionDirectoryHint?'\n仅当用户或材料明确要求纯代码Word、源码ZIP替代或体积限额时，读取 references/size-limited-code-word.md；按明确范围从实际源码提取主代码，不能将摘录称为可启动源码包。只有明确替代授权才采用代码Word替换对应反馈成员，保留内部原版及父收据；未经明确授权不删除原文件。用户明确压缩包大小时才传 pack_feedback.py --max-bytes <明确的正整数字节数>，20m/20MB按20,000,000字节解释；未要求限额时不传此参数，不给所有案件默认20MB。实际读取打包收据的output_zip.max_bytes和validation_scope.size_limit_enforced核验；超限不能发布成功，不把仅有哈希核验宣称为体积限制已通过。':'';
 return `\n本次补充需求：${spec.supplemental.text}\n补充附件路径与SHA256：${JSON.stringify(supplementalInputs(spec))}。必须真实读取附件和原材料，按具体要求建立逐项验收映射，解释说明必须对应实际交付内容，不泛写，不编造已完成实验或仿真。按需求选合适专业图件和可复核来源，图形外观不得代替技术依据。`+integration+supplementalVersionDirectoryPrompt(spec)+v11;
}

export function supplementalSkillEvidence(receipt,spec,phase){
 if(!spec.supplementalSkill)return true;
 const skill=receipt.supplementalSkill;
 if(skill?.id!==spec.supplementalSkill.id||skill.commit!==spec.supplementalSkill.commit||skill.verified!==true||typeof skill.entryPath!=='string'||!skill.entryPath.trim())return false;
 if(spec.supplementalSkill.versionDirectoryHint){const path=skill.entryPath.replaceAll('\\','/').toLowerCase(),suffix='/'+spec.supplementalSkill.versionDirectoryHint.toLowerCase()+'/skill.md';if(!/^(?:[a-z]:\/|\/|\/\/)/i.test(path)||!path.endsWith(suffix))return false;}
 if(phase==='preflight')return true;
 try{const proof=receipt.feedbackPack;if(skill.invoked!==true||typeof proof?.rawText!=='string'||hash(proof.rawText)!==proof.sha256)return false;const raw=JSON.parse(proof.rawText),files=raw.files,requirements=JSON.parse(receipt.requirementsReview?.rawText||'{"items":[]}').items||[];
  return raw.schema_version===1&&raw.tool?.name==='pack_feedback'&&raw.case_id===receipt.batchId&&raw.version===receipt.publishReceipt?.runId&&raw.parent_version===(spec.supplementSource?.sourceHash||receipt.publishReceipt?.runId)&&raw.output_zip?.sha256===receipt.packageSha&&raw.main_skill===(spec.profile==='software'?'software-system-delivery':'software-case-batch-pro')&&Array.isArray(files)&&files.some(f=>f.kind==='normal')&&files.every(f=>relativeFile(f.arcname)&&/^[a-f0-9]{64}$/.test(f.sha256))&&Array.isArray(raw.requirements)&&requirements.every(r=>raw.requirements.some(x=>x.id===r.id&&Array.isArray(x.members)&&x.members.length&&x.members.every(name=>files.some(f=>f.arcname===name&&f.requirement_ids?.includes(r.id)))))&&raw.validation_scope?.file_hashes_verified===true&&raw.validation_scope?.zip_members_verified===true;
 }catch{return false;}
}

export function supplementPublicationEvidence(receipt,source,producer){
 try{
  const pub=receipt.publishReceipt,review=receipt.independentReview;
  if(typeof pub?.rawText!=='string'||hash(pub.rawText)!==pub.sha256||typeof review?.rawText!=='string'||hash(review.rawText)!==review.evidenceSha256||review.decision!=='pass'||!review.rawText.trim()||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(review.reviewerId||'')||review.reviewerId===producer)return false;
  const raw=JSON.parse(pub.rawText),files=raw.snapshot;
  return raw.schema==='supplement-v1'&&raw.status==='published'&&raw.runId===pub.runId&&typeof raw.published==='string'&&!!raw.published.trim()&&raw.sourceHash===source.sourceHash&&receipt.sourceHash===source.sourceHash&&review.rawText.includes(source.sourceHash)&&files&&typeof files==='object'&&!Array.isArray(files)&&Object.keys(files).length>0&&Object.entries(files).every(([name,sha])=>relativeFile(name)&&/^[a-f0-9]{64}$/.test(sha));
 }catch{return false;}
}
