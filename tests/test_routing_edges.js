'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {runCase}=require('./runner');
const root=path.join(__dirname,'..');
const cfg=JSON.parse(fs.readFileSync(path.join(root,'data/config.json'),'utf8'));
const api=vm.runInNewContext(fs.readFileSync(path.join(root,'src/engine.js'),'utf8')+'\n({newState,N02,N11,N15,N23,covered,missing});',{});
let passed=0;
function check(name,fn){fn();passed++;console.log('✓ '+name);}
function fact(field,sub,subject){return {field,sub,subject,value:'已知',active:true,status:'已确认',src:'LIFE'};}
function ready40(){const st=api.newState(cfg);st.stage='AWAIT_60';st.facts=[fact('Q5','has_pet','自己'),fact('Q7','smoke','自己'),fact('Q7','drink','自己'),fact('Q6','style','自己'),fact('Q9','balance','关系'),fact('Q10','openness','关系')];return st;}
check('相处最小信息同时校验字段和对象，包括矛盾附注',()=>{
 const st=api.newState(cfg);st.facts=[fact('Q4','pace','TA')];
 assert.equal(api.covered(cfg,st,'REL'),false);assert(api.missing(cfg,st,'REL').includes('Q4.pace'));
 st.facts[0].subject='自己';assert.equal(api.covered(cfg,st,'REL'),true);
 st.facts=[];st.notes=[{field:'Q4',sub:'pace',subject:'TA',active:true}];assert.equal(api.covered(cfg,st,'REL'),false);
});
check('旧会话自动补齐补充题状态',()=>{
 const st=api.newState(cfg);delete st.tasks.SUP1;st.current={task:'SUP1',qtype:'SUPPLEMENT',text:cfg.tasks.SUP1.script};
 const restored=JSON.parse(api.N02(cfg,JSON.stringify(st),'暂时没有想法').state);assert(restored.tasks.SUP1);
});
check('跨题信息覆盖后半全部主问题时，开放补充前仍插入节奏补充题',()=>{
 const entry=api.N02(cfg,JSON.stringify(ready40()),'继续聊');const st=JSON.parse(entry.state);
 assert.equal(st.plan.qtype,'SUPPLEMENT');assert.equal(st.used.S40.S,1);assert.equal(st.sup_used.S40,1);
 const submitted=api.N23(cfg,entry.state,entry.cont_q);const next=JSON.parse(submitted.new_state);
 next._und={answer_status:'nothing_to_add',parse_ok:true};
 const routed=api.N11(cfg,JSON.stringify(next),'没有补充','{}');assert.equal(JSON.parse(routed.state).plan.task,'Q12');
});
check('后半末题说不清，补充题之后先重问再开放补充',()=>{
 const st=api.newState(cfg);st.stage='S40';st.current={task:'Q10',qtype:'MAIN',text:cfg.tasks.Q10.script};st.asked={S40:3};
 for(const id of ['Q5','Q7','Q6','Q9'])st.tasks[id].a=1;
 st._und={answer_status:'unclear',parse_ok:true};const first=api.N11(cfg,JSON.stringify(st),'不知道','{}');
 assert.equal(first.action,'SUPPLEMENT');const after=JSON.parse(api.N23(cfg,first.state,first.candidate_q).new_state);
 after._und={answer_status:'nothing_to_add',parse_ok:true};const second=api.N11(cfg,JSON.stringify(after),'没什么补充','{}');
 assert.equal(second.action,'REPLACE_LATER');assert.equal(JSON.parse(second.state).plan.task,'Q10');
});
check('阶段卡只识别明确的画像动作，不对关键词做子串匹配',()=>{
 for(const text of ['我还没完成','我不想生成画像','继续聊'])assert.equal(api.N02(cfg,JSON.stringify(ready40()),text).branch,'CONTINUE_40');
 for(const text of [cfg.buttons.p60[1],'生成画像','直接完成'])assert.equal(api.N02(cfg,JSON.stringify(ready40()),text).branch,'PROFILE');
});
check('P3 按 4～22 字、单句和句尾校验，失败时仅发核心句',()=>{
 const spec=JSON.stringify({mode:'lead',core:cfg.tasks.REL.core});
 for(const lead of ['嗯。','啊'.repeat(22)+'。','我们想象一个场景','先想想。再说说～'])assert.equal(api.N15(cfg,JSON.stringify({lead}),spec,false).pass,false);
 assert.equal(api.N15(cfg,JSON.stringify({lead:'我们想象一个场景～'}),spec,false).pass,true);
 assert.equal(api.N15(cfg,'{}',spec,true).q_text,cfg.tasks.REL.core);
});
(async()=>{
 const result=await runCase({steps:[['测试',{}]]},cfg,{},async()=>{throw new Error('intentional failure');});
 assert(result.results.some(r=>r.pass===false),'流程异常必须导致测试失败');passed++;console.log('✓ 测试框架不会把异常当通过');
 console.log(`\n${passed} 项路由边界检查通过`);
})().catch(e=>{console.error(e);process.exitCode=1;});
