import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceLedEvidence} from '../delivery-requirements.mjs';
import {hash} from '../util.mjs';
function evidence(change=()=>{}){
 const fig={path:'图件/力学响应.svg',sha256:'a'.repeat(64)},data={path:'数据/力学响应.csv',sha256:'b'.repeat(64)},system={path:'系统材料/源代码.zip',sha256:'c'.repeat(64)};
 const snapshot=Object.fromEntries([fig,data,system].map(x=>[x.path,x.sha256]));
 const r={schema:1,runId:'actual-run',inputSha:'d'.repeat(64),items:[{id:'R1',requirement:'不同边界条件下力学响应对比',source:'输入材料第 5 页，要求 2',acceptance:'各曲线对应真实计算与参数，坐标单位完整',artifacts:[fig,data]}],figures:[{...fig,purpose:'边界变化对响应的影响',method:'依据原始方程、参数和边界条件求解后绘图',provenance:'computed',dataArtifacts:[data],checks:{professionalFit:true,sourceFidelity:true,readability:true,labelsAndUnits:true}}],review:{reviewerId:'independent',decision:'pass',checkedItems:['R1'],checkedFigures:[fig.path],findings:'逐图核对源数据、方法、图例与坐标，检查最终可读性。'}};
 change(r,system);const rawText=JSON.stringify(r),sha256=hash(rawText);
 return {inputSha:'d'.repeat(64),publishReceipt:{runId:'actual-run',rawText:JSON.stringify({snapshot})},independentReview:{reviewerId:'independent',rawText:'Independent visual review bound to '+sha256},requirementsReview:{rawText,sha256}};
}
test('professional demand is not restricted to two image categories and no-figure deliveries remain valid',()=>{
 assert.equal(sourceLedEvidence(evidence()),true);
 assert.equal(sourceLedEvidence(evidence((r,system)=>{r.items[0].artifacts=[system];r.figures=[];r.review.checkedFigures=[];})),true);
});
test('missing actual data, unfinished visual review, changed publication or foreign report cannot pass',()=>{
 for(const mutate of [r=>r.figures[0].dataArtifacts=[],r=>r.figures[0].checks.professionalFit=false,r=>r.review.checkedFigures=[],r=>r.review.checkedItems=[],r=>r.figures[0].sha256='f'.repeat(64),r=>r.items[0].artifacts[0].path='not-published.svg',r=>r.inputSha='f'.repeat(64),r=>r.runId='other-run',r=>r.review.reviewerId='other-reviewer'])assert.equal(sourceLedEvidence(evidence(mutate)),false);
 const tampered=evidence();tampered.requirementsReview.rawText+=' ';assert.equal(sourceLedEvidence(tampered),false);
 const unbound=evidence();unbound.independentReview.rawText='Not a review of this requirements report';assert.equal(sourceLedEvidence(unbound),false);
});
