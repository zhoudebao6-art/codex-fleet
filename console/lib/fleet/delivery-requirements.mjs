import {hash,relativeFile} from './util.mjs';

export function sourceLedPrompt(inputSha){return `\n本轮按材料与需求制定交付方案，不限模型图、仿真图，不用两项预设替代专业判断。逐条读取材料和补充要求，明确专业领域、图件用途、需要证明的结论、数据和参数依据，再决定图型、方法、数量、参考样式和交付格式。没有图件需求时不凑图；要求未明确的关键数据先查资料，不能伪造仪器测量或文献来源。\n需要出图时，以用户提供的参考优先，采用对应专业设备报告或科研文献的表达规范：真实的数据/模型关系、适当坐标与尺度、单位、图例、色标、误差或边界条件、字体层级、版式与可读性；按图型判断适用项，不能用套模板或装饰图代替分析。实测、计算、示意和演示数据明确区分。实测/计算图保留原始或可复算数据、绘图脚本及必要的可编辑文件；示意图不冒充设备实测。独立审核须实际查看每张最终图，并逐项判断是否回答需求、专业方法正确、标注完整、数值可信、版式达到参考标准；不达标返修，不能只检查有图片或文件。\n交付收据另附 requirementsReview:{rawText,sha256}。rawText 是真实独立验收 JSON 原文：{schema:1,runId:"与发布收据一致",inputSha:"${inputSha}",items:[{id:"需求编号",requirement:"实际需求",source:"原材料页码/附件路径或补充要求位置",acceptance:"具体验收标准",artifacts:[{path:"最终发布清单中的相对路径",sha256:"与清单一致"}]}],figures:[{path:"已发布图件路径",sha256:"图件哈希",purpose:"对应专业问题",method:"实际绘制或计算方法",provenance:"measured|computed|schematic|illustrative",dataArtifacts:[{path,sha256}],checks:{professionalFit:true,sourceFidelity:true,readability:true,labelsAndUnits:true}}],review:{reviewerId:"与独立审核收据一致",decision:"pass",checkedItems:["所有需求编号"],checkedFigures:["所有图件路径"],findings:"具体专业和视觉审核依据"}}。items 覆盖所有材料和补充需求；无图时 figures 为空。所有文件必须在最终发布清单中，实测或计算图 dataArtifacts 不为空。independentReview.rawText 须引用这份 requirementsReview 的 SHA256，使审查与该份标准绑定。证据与失败日志独立保存，不混入面向用户的成品。已有技能接口未支持某种需求时向主控上报具体缺口并触发按需维护，不擅自降低标准或重建环境。`;}

// This checks evidence identity and coverage. Professional/visual judgment must
// come from the real independent reviewer; a schema check is not visual QA.
export function sourceLedEvidence(receipt){
 try{
  const report=receipt.requirementsReview;
  if(typeof report?.rawText!=='string'||hash(report.rawText)!==report.sha256||!receipt.independentReview?.rawText?.includes(report.sha256))return false;
  const r=JSON.parse(report.rawText.replace(/^\uFEFF/,'')),p=JSON.parse(receipt.publishReceipt.rawText.replace(/^\uFEFF/,'')),snapshot=p.snapshot||p.files;
  const text=x=>typeof x==='string'&&x.trim().length>=4;
  const artifact=a=>a&&relativeFile(a.path)&&/^[a-f0-9]{64}$/.test(a.sha256)&&snapshot?.[a.path]===a.sha256;
  const unique=a=>new Set(a).size===a.length;
  if(r.schema!==1||r.runId!==receipt.publishReceipt.runId||r.inputSha!==receipt.inputSha||r.review?.reviewerId!==receipt.independentReview.reviewerId||r.review?.decision!=='pass'||!text(r.review?.findings))return false;
  if(!Array.isArray(r.items)||!r.items.length||r.items.length>100||!unique(r.items.map(x=>x.id))||!Array.isArray(r.figures)||r.figures.length>100||!unique(r.figures.map(x=>x.path)))return false;
  if(!Array.isArray(r.review.checkedItems)||!Array.isArray(r.review.checkedFigures))return false;
  if(r.review.checkedItems.length!==r.items.length||r.review.checkedFigures.length!==r.figures.length||!unique(r.review.checkedItems)||!unique(r.review.checkedFigures))return false;
  if(!r.items.every(x=>typeof x.id==='string'&&x.id.trim().length>0&&text(x.requirement)&&text(x.source)&&text(x.acceptance)&&Array.isArray(x.artifacts)&&x.artifacts.length&&x.artifacts.every(artifact)&&r.review.checkedItems.includes(x.id)))return false;
  return r.figures.every(f=>artifact(f)&&r.items.some(x=>x.artifacts.some(a=>a.path===f.path))&&text(f.purpose)&&text(f.method)&&['measured','computed','schematic','illustrative'].includes(f.provenance)&&Array.isArray(f.dataArtifacts)&&f.dataArtifacts.every(artifact)&&(!['measured','computed'].includes(f.provenance)||f.dataArtifacts.length>0)&&['professionalFit','sourceFidelity','readability','labelsAndUnits'].every(k=>f.checks?.[k]===true)&&r.review.checkedFigures.includes(f.path));
 }catch{return false;}
}
