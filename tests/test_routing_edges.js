'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {runCase}=require('./runner');
const root=path.join(__dirname,'..');
const cfg=JSON.parse(fs.readFileSync(path.join(root,'data/config.json'),'utf8'));
const prompts=JSON.parse(fs.readFileSync(path.join(root,'data/prompts.json'),'utf8'));
const api=vm.runInNewContext(fs.readFileSync(path.join(root,'src/engine.js'),'utf8')+'\n({newState,N02,N11,N15,N23,covered,missing,runTurn});',{performance:require('node:perf_hooks').performance});
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
check('历史回答保留到各题输入上限，不再在 200 字处截断',()=>{
 for(const task of ['NEED','Q6']){
  const st=api.newState(cfg);st.stage=task==='NEED'?'S60':'S40';st.current={task,qtype:'MAIN',text:cfg.tasks[task].core};st._und={answer_status:'answered',parse_ok:true};
  const limit=cfg.max_input_chars[task]??cfg.max_input_chars.default;
  const answer='完整回答'+('具体内容'.repeat(limit))+'末尾';
  const saved=JSON.parse(api.N11(cfg,JSON.stringify(st),answer,'{}').state).dialog.at(-1);
  assert.equal(saved.q,st.current.text);assert.equal(saved.a,answer.slice(0,limit));assert(saved.a.length>200);
 }
});
check('普通承接和含内部换行的问题同段输出，问题内容完整',()=>{
 const st=api.newState(cfg);st.current={task:'LIFE',qtype:'MAIN',text:cfg.tasks.LIFE.core};
 st._und={answer_status:'answered',ack:'周末出去运动，也会留时间休息～'};st.plan={action:'ASK_NEXT',task:'REL',qtype:'MAIN'};
 const question='生活里的你有点轮廓啦～\n\n假如真的谈恋爱了，你觉得自己会是什么样的呀？\n你希望两个人平时怎么相处呢？';
 const body=api.N23(cfg,JSON.stringify(st),question).reply.split('\n\n— 画像进度')[0];
 assert(!/[\r\n]/.test(body));assert.equal(body.replace(/\s/g,''),(st._und.ack+question).replace(/\s/g,''));
});
check('解释后重问和 P3 引子重问同段输出，核心问题不丢失',()=>{
 const st=api.newState(cfg);st.current={task:'Q6',qtype:'MAIN',text:cfg.tasks.Q6.core};
 st._und={answer_status:'asks_back'};st.plan={action:'REASK',task:'Q6',qtype:'MAIN',prefix:'我想了解你的消费习惯呀～',hold:1};
 const body=api.N23(cfg,JSON.stringify(st),cfg.tasks.Q6.core).reply.split('\n\n— 画像进度')[0];
 assert(!/[\r\n]/.test(body));assert.equal(body.replace(/\s/g,''),(st.plan.prefix+cfg.tasks.Q6.core).replace(/\s/g,''));
 const lead='我们想象一个场景～';const spec=JSON.stringify({mode:'lead',core:cfg.tasks.Q6.core});
 const question=api.N15(cfg,JSON.stringify({lead}),spec,false).q_text;
 st._und={answer_status:'answered',ack:'买东西时你会先看看实际需要～'};st.plan={action:'REPLACE_LATER',task:'Q6',qtype:'REPLACE'};
 const replacement=api.N23(cfg,JSON.stringify(st),question).reply.split('\n\n— 画像进度')[0];
 assert(!/[\r\n]/.test(replacement));assert.equal(replacement.replace(/\s/g,''),(st._und.ack+lead+cfg.tasks.Q6.core).replace(/\s/g,''));
});
(async()=>{
 const st=api.newState(cfg);st.stage='S40';st.current={task:'Q6',qtype:'FOLLOW_UP',text:'那要是预算够的时候，你会怎么判断值不值得买呀？'};
 st.tasks.Q5.a=1;st.tasks.Q7.a=1;st.tasks.Q6.a=1;st.tasks.Q6.f=1;
 st.dialog=[{q:'最早的问题标记 EARLIER_QUESTION',a:'最早回答标记 EARLIER_ANSWER'},{q:'最近两轮的第一问 RECENT_ONE',a:'完整长回答'+('生活安排'.repeat(65))+'LONG_ANSWER_END'},{q:'最近两轮的第二问 RECENT_TWO',a:'暂时不买，预算有限 LAST_ANSWER'}];
 const history=st.dialog.slice(-2),calls=[],trace=[];const answer='使用的频率 CURRENT_ANSWER';
 const llm=async(id,pid,sys,user)=>{calls.push({pid,user});return JSON.stringify({answer_status:'answered',facts:[{field:'Q6',sub:'condition',subject:'自己',value:'考虑使用频率',evidence:'使用的频率'}]});};
 await api.runTurn({cfg,prompts,p1:'B',stateJson:JSON.stringify(st),trace,llm},answer);
 const call=calls.find(c=>c.pid==='P1B'),vars=trace.find(t=>t.id==='N04').input.变量;
 assert(call,'必须实际构建 P1B 的用户提示词');assert.equal(vars.recent_dialog,JSON.stringify(history));assert(call.user.includes(JSON.stringify(history)),'实际提示词必须包含最近两轮完整问答');
 assert(call.user.includes('LONG_ANSWER_END'));assert(!call.user.includes('EARLIER_QUESTION'));assert(!call.user.includes('EARLIER_ANSWER'));
 assert(!vars.recent_dialog.includes('CURRENT_ANSWER'),'本轮回答不能混入已完成问答');assert(call.user.includes(answer),'本轮回答仍单独传入');
 passed++;console.log('✓ P1B 实际提示词含最近两轮完整问答，排除更早历史和本轮回答');
 const reset=await api.runTurn({cfg,prompts,p1:'B',stateJson:JSON.stringify(st),trace:[],llm},'重新开始');
 const ready=await api.runTurn({cfg,prompts,p1:'B',stateJson:reset.newState,trace:[],llm},'好的');
 const resetTrace=[];calls.length=0;
 await api.runTurn({cfg,prompts,p1:'B',stateJson:ready.newState,trace:resetTrace,llm},'希望对方温柔一点');
 const fresh=calls.find(c=>c.pid==='P1B'),freshVars=resetTrace.find(t=>t.id==='N04').input.变量;
 assert.equal(freshVars.recent_dialog,'[]');assert(fresh.user.includes('[]'));assert(!fresh.user.includes('EARLIER_ANSWER'));assert(!fresh.user.includes('LAST_ANSWER'));assert(!fresh.user.includes('LONG_ANSWER_END'));
 passed++;console.log('✓ 重新开始后 P1B 历史为空，不带入旧会话问答');
 const result=await runCase({steps:[['测试',{}]]},cfg,{},async()=>{throw new Error('intentional failure');});
 assert(result.results.some(r=>r.pass===false),'流程异常必须导致测试失败');passed++;console.log('✓ 测试框架不会把异常当通过');
 console.log(`\n${passed} 项路由边界检查通过`);
})().catch(e=>{console.error(e);process.exitCode=1;});
