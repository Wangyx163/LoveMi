'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {runCase}=require('./runner');
const root=path.join(__dirname,'..');
const cfg=JSON.parse(fs.readFileSync(path.join(root,'data/config.json'),'utf8'));
const prompts=JSON.parse(fs.readFileSync(path.join(root,'data/prompts.json'),'utf8'));
const api=vm.runInNewContext(fs.readFileSync(path.join(root,'src/engine.js'),'utf8')+'\n({newState,N02,N11,N15,N23,N32,N36,covered,missing,runTurn});',{performance:require('node:perf_hooks').performance});
let passed=0;
function check(name,fn){fn();passed++;console.log('✓ '+name);}
function fact(field,sub,subject){return {field,sub,subject,value:'已知',active:true,status:'已确认',src:'LIFE'};}
function ready40(){const st=api.newState(cfg);st.stage='AWAIT_60';st.facts=[fact('Q5','has_pet','自己'),fact('Q7','smoke','自己'),fact('Q7','drink','自己'),fact('Q6','style','自己'),fact('Q9','balance','关系'),fact('Q10','openness','关系')];return st;}
check('P6 的伴侣期待在新版90字上限内保留模型原文，超过上限仍兜底',()=>{
 const st=api.newState(cfg);st.facts=[{...fact('NEED','traits','TA'),value:'有耐心',evidence:'希望对方有耐心'}];
 const expect='你理想中的 TA，有自己的生活和喜欢做的事，也能理解你偶尔忙得顾不上回消息。不必时时刻刻黏在一起，各自忙碌时能互相体谅，难得有空了，也愿意一起吃顿饭，好好享受两个人的时间。';
 assert(expect.length>80&&expect.length<=90);
 const render=text=>JSON.parse(api.N32(cfg,JSON.stringify(st),JSON.stringify({core:'你有自己的生活节奏。',expect_ta:text,love_style:''}),JSON.stringify({daily:''})).new_state).profile;
 const accepted=render(expect);assert.equal(accepted.expect_ta,expect);assert.equal(accepted.source.expect_ta,'model');
 const overlong=render(expect+'有时间也能一起慢慢计划以后。');
 assert.equal(overlong.source.expect_ta,'generation_error');assert(overlong.expect_ta.length<=90);assert(!overlong.expect_ta.includes('有时间也能一起慢慢计划以后'));
});
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
check('Q10不登记延后重问，补充题后正常开放补充',()=>{
 const st=api.newState(cfg);st.stage='S40';st.current={task:'Q10',qtype:'MAIN',text:cfg.tasks.Q10.script};st.asked={S40:3};
 for(const id of ['Q5','Q7','Q6','Q9'])st.tasks[id].a=1;
 st._und={answer_status:'unclear',parse_ok:true};const first=api.N11(cfg,JSON.stringify(st),'不知道','{}');
 assert.equal(first.action,'SUPPLEMENT');const after=JSON.parse(api.N23(cfg,first.state,first.candidate_q).new_state);
 after._und={answer_status:'nothing_to_add',parse_ok:true};const second=api.N11(cfg,JSON.stringify(after),'没什么补充','{}');
 assert.equal(second.action,'ASK_NEXT');assert.equal(JSON.parse(second.state).plan.task,'Q12');
});
check('阶段卡只识别明确的画像动作，不对关键词做子串匹配',()=>{
 for(const text of ['我还没完成','我不想生成画像','继续聊'])assert.equal(api.N02(cfg,JSON.stringify(ready40()),text).branch,'CONTINUE_40');
 for(const text of [cfg.buttons.p60[1],'生成画像','直接完成'])assert.equal(api.N02(cfg,JSON.stringify(ready40()),text).branch,'PROFILE');
});
check('开场各分支使用配置承接，接受时只去共用开头而保留完整需求正文',()=>{
 for(const [input,kind] of [['ok','accept'],['要聊多久呀？','question'],['有点紧张','hesitate'],['你好','other']]){
  const opened=api.N02(cfg,'','开始'),result=api.N02(cfg,opened.state,input),state=JSON.parse(result.state);
  const ack=cfg.intro_ack[kind][0],body=kind==='accept'?cfg.tasks.NEED.script.replace(/^那就开始啦～\s*/,''):cfg.tasks.NEED.script;
  assert.equal(result.branch,'STATIC');assert.equal(state.intro_class,kind);assert(result.reply_static.startsWith(ack));
  assert(result.reply_static.endsWith(body),'不能为去重而丢失首段实际问句或第二段说明');
  assert.equal((result.reply_static.match(/那就开始啦/g)||[]).length,1,'开头只能出现一次');
  assert.equal(state.current.task,'NEED');assert.equal(state.current.text,cfg.tasks.NEED.core,'当前问题使用core，展示正文使用script');
 }
});
check('人物卡人数变化采用配置中的单人或多人问句',()=>{
 const baseline=api.N36(cfg,JSON.stringify(api.newState(cfg))),selected=JSON.parse(baseline.new_state).cards;
 assert(selected.length>=3,'基准配置应足够展示三位候选人');
 const pool=selected.map(card=>cfg.pool.find(person=>person.id===card.id));
 for(const count of [1,2,3]){
  const localCfg={...cfg,pool:pool.slice(0,count)},result=api.N36(localCfg,JSON.stringify(api.newState(localCfg))),state=JSON.parse(result.new_state);
  const question=count===1?cfg.rec_text.card_question_one:cfg.rec_text.card_question.replace('{word}',count===2?'两个人':'三个人');
  assert.equal(state.cards.length,count);assert.equal(state.current.task,'CARD_L1');assert.equal(state.current.text,question);
  assert(result.reply.includes(question),'展示问句应与对应人数的配置一致');
 }
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
check('REL配置脚本保留两段，承接接在过渡段且当前题仍为REL',()=>{
 const st=api.newState(cfg);st.current={task:'LIFE',qtype:'FOLLOW_UP',text:'通常自己打还是和朋友一起呀？'};
 const ack='嗯，知道啦～';st._und={answer_status:'answered',parse_ok:true,ack};st.plan={action:'ASK_NEXT',task:'REL',qtype:'MAIN'};
 const submitted=api.N23(cfg,JSON.stringify(st),cfg.tasks.REL.script),next=JSON.parse(submitted.new_state);
 const parts=submitted.reply.split('\n\n— 画像进度')[0].split('\n\n');
 assert.equal(parts.length,2,'保留脚本显式分段，而非拆开ack或把全部内容压成一段');
 const expected=cfg.tasks.REL.script.split(/\r?\n\s*\r?\n/);
 assert.equal(parts[0],ack+expected[0]);assert.equal(parts[1],expected[1]);
 assert.equal(next.current.task,'REL');assert.equal(next.current.qtype,'MAIN');assert.equal(next.current.text,cfg.tasks.REL.script);
 st.plan={action:'FOLLOW_UP',task:'LIFE',qtype:'FOLLOW_UP'};
 const dynamic=api.N23(cfg,JSON.stringify(st),cfg.tasks.REL.script).reply.split('\n\n— 画像进度')[0];
 assert(!/[\r\n]/.test(dynamic),'动态追问即便带空行也不自行分段');
});
check('解释后重问和 P3 引子重问同段输出，核心问题不丢失',()=>{
 const st=api.newState(cfg);st.current={task:'Q6',qtype:'MAIN',text:cfg.tasks.Q6.core};
 st._und={answer_status:'asks_back'};st.plan={action:'REASK',task:'Q6',qtype:'MAIN',prefix:'我想了解你的消费习惯呀～',hold:1};
 const body=api.N23(cfg,JSON.stringify(st),cfg.tasks.Q6.core).reply.split('\n\n— 画像进度')[0];
 assert(!/[\r\n]/.test(body));assert.equal(body.replace(/\s/g,''),('嗯，我们接着聊～'+st.plan.prefix+cfg.tasks.Q6.core).replace(/\s/g,''));
 const lead='我们想象一个场景～';const spec=JSON.stringify({mode:'lead',core:cfg.tasks.Q6.core});
 const question=api.N15(cfg,JSON.stringify({lead}),spec,false).q_text;
 st._und={answer_status:'answered',ack:'买东西时你会先看看实际需要～'};st.plan={action:'REPLACE_LATER',task:'Q6',qtype:'REPLACE'};
 const replacement=api.N23(cfg,JSON.stringify(st),question).reply.split('\n\n— 画像进度')[0];
 assert(!/[\r\n]/.test(replacement));assert.equal(replacement.replace(/\s/g,''),(st._und.ack+lead+cfg.tasks.Q6.core).replace(/\s/g,''));
});
check('有效承接不依赖事实或回答状态，简短回答和拒答不会被模板覆盖',()=>{
 const ack='好，这个话题就先放一放～';
 for(const answer_status of ['answered','unclear','refused','nothing_to_add']){
  const st=api.newState(cfg);st.current={task:'Q6',qtype:'FOLLOW_UP',text:cfg.tasks.Q6.core};
  st._und={answer_status,parse_ok:true,ack};st.plan={action:'ASK_NEXT',task:'Q9',qtype:'MAIN'};
  const body=api.N23(cfg,JSON.stringify(st),cfg.tasks.Q9.core).reply.split('\n\n— 画像进度')[0];
  assert.equal(st.facts.length,0);assert.equal(body,ack+cfg.tasks.Q9.core,answer_status+' 应使用本轮有效承接');
 }
});
check('承接按25个Unicode字符校验，超长或提问仅使用中性兜底',()=>{
 const render=(ack,extra={})=>{const st=api.newState(cfg);st.current={task:'Q6',qtype:'MAIN',text:cfg.tasks.Q6.core};
  st._und={answer_status:'answered',parse_ok:true,ack,...extra};st.plan={action:'ASK_NEXT',task:'Q9',qtype:'MAIN'};
  return api.N23(cfg,JSON.stringify(st),cfg.tasks.Q9.core).reply.split('\n\n— 画像进度')[0];};
 const maxAck='好'.repeat(24)+'🐾';assert.equal([...maxAck].length,25);
 assert.equal(render(maxAck),maxAck+cfg.tasks.Q9.core,'25字符承接不能因emoji占两个UTF-16单元被误删');
 for(const ack of ['好'.repeat(26),'那你喜欢什么呀？','真的这样吗?'])assert.equal(render(ack),'嗯，我们接着聊～'+cfg.tasks.Q9.core);
 assert.equal(render(''),'嗯，我们接着聊～'+cfg.tasks.Q9.core,'无合规承接时不虚构用户没想好');
 assert.equal(render('',{parse_ok:false}),cfg.tasks.Q9.core,'模型解析失败时不伪装成正常承接');
});
check('出卡及无候选分支都展示本轮承接，关怀仍优先',()=>{
 const ack='嗯，你更看重相处时的舒服～';
 for(const pool of [cfg.pool,[]]){
  const localCfg={...cfg,pool};const st=api.newState(localCfg);st.current={task:'NEED',qtype:'MAIN',text:cfg.tasks.NEED.core};
  st._und={answer_status:'refused',parse_ok:true,ack};
  const reply=api.N36(localCfg,JSON.stringify(st)).reply;
  assert(reply.startsWith(ack));assert(!/^[\r\n]/.test(reply.slice(ack.length)),'承接和首段应连续');
  const noAck=api.newState(localCfg);noAck.current=st.current;noAck._und={};
  assert(!api.N36(localCfg,JSON.stringify(noAck)).reply.includes('嗯，我们接着聊～'),'没有本轮理解时不凭空生成承接');
 }
 const care=api.newState(cfg);care.current={task:'NEED',qtype:'MAIN',text:cfg.tasks.NEED.core};care._care=true;
 care._und={answer_status:'risk',parse_ok:true,ack};
 const reply=api.N36(cfg,JSON.stringify(care)).reply;
 assert(!reply.includes(ack));assert(cfg.care_ack.some(line=>reply.startsWith(line)),'关怀应优先于普通承接');
});
check('本轮承接不会跨输入重放，60%继续按钮不复用历史承接',()=>{
 const st=ready40(),oldAck='历史回答已经回应过了～';st._und={answer_status:'unclear',parse_ok:true,ack:oldAck};
 const entry=api.N02(cfg,JSON.stringify(st),'继续聊');assert.equal(entry.branch,'CONTINUE_40');
 const next=JSON.parse(entry.state);assert(!next._und?.ack);assert(!next._und?.answer_status);
 const reply=api.N23(cfg,entry.state,entry.cont_q).reply;
 assert(!reply.includes(oldAck));assert(!reply.includes('嗯，我们接着聊～'));
 const answering=api.newState(cfg);answering.current={task:'Q6',qtype:'MAIN',text:cfg.tasks.Q6.core};answering._und=st._und;
 const nextAnswer=api.N02(cfg,JSON.stringify(answering),'看使用的频率');assert.equal(nextAnswer.branch,'ANSWER');
 assert(!JSON.parse(nextAnswer.state)._und?.ack,'新回答须等待本轮理解，不能沿用旧ack');
});
(async()=>{
 // 这些桩结果只验证短否定经过模型后的执行链，不将其当作模型语义判断已验证。
 for(const sample of [
  {label:'单问否定',question:'你平常会抽烟吗？',input:'不',status:'answered',facts:[{field:'Q7',sub:'smoke',subject:'自己',value:'不吸',evidence:'不'}]},
  {label:'明确双项否定',question:cfg.tasks.Q7.core,input:'都不',status:'answered',facts:[{field:'Q7',sub:'smoke',subject:'自己',value:'不吸',evidence:'都不'},{field:'Q7',sub:'drink',subject:'自己',value:'不喝',evidence:'都不'}]},
  {label:'明确只答吸烟',question:cfg.tasks.Q7.core,input:'不抽',status:'partial',facts:[{field:'Q7',sub:'smoke',subject:'自己',value:'不吸',evidence:'不抽'}],pending:true},
  {label:'否定范围未确定',question:cfg.tasks.Q7.core,input:'不',status:'unclear',facts:[],pending:true},
  {label:'拒答不同于否定',question:cfg.tasks.Q7.core,input:'不想说',status:'refused',facts:[],refused:true}
 ]){
  const st=api.newState(cfg);st.stage='S40';st.current={task:'Q7',qtype:'MAIN',text:sample.question};st.tasks.Q5.a=1;
  const trace=[],calls=[];
  const reply=await api.runTurn({cfg,prompts,p1:'B',stateJson:JSON.stringify(st),trace,llm:async(id,pid)=>{calls.push({id,pid});return JSON.stringify({answer_status:sample.status,facts:sample.facts,ack:'嗯，知道啦～'});}},sample.input);
  const state=JSON.parse(reply.newState),written=JSON.parse(trace.find(t=>t.id==='N09').output.written);
  assert.equal(calls.length,1);assert.equal(calls[0].pid,'P1B',sample.label+' 不能因回答简短而被前置规则拦截');
  assert.deepEqual(written.map(f=>[f.field,f.sub,f.value,f.evidence]),sample.facts.map(f=>[f.field,f.sub,f.value,f.evidence]));
  assert.equal(state._und.answer_status,sample.status);assert.equal(state.tasks.Q7.refused,sample.refused?1:0);
  assert.equal(state.pending.some(p=>p.task==='Q7'),false,'Q7不进入普通延后重问');
  const oneKnown=sample.facts.length===1;
  assert.equal(state.current.task,oneKnown?'Q7':'Q6');
  if(oneKnown){assert.equal(state.current.text,cfg.q7_followup.drink);assert.equal(state.tasks.Q7.fu,1);}
  assert(!trace.some(t=>['N14','N17'].includes(t.id)),'单项补问直接用系统模板');
 }
 passed++;console.log('✓ 桩结果回归：短否定交给P1B，单项/双项事实和未确定缺项按原规则处理');
 {
  const st=api.newState(cfg);st.stage='S40';st.current={task:'Q6',qtype:'FOLLOW_UP',text:'那有没有哪次实在喜欢，最后还是买下来的？'};
  for(const id of ['Q5','Q7','Q6'])st.tasks[id].a=1;st.tasks.Q6.f=1;st.tasks.Q6.fu=1;st.used.S40.F=1;
  st.facts=[{field:'Q6',sub:'condition',subject:'自己',value:'非必需的东西不买',evidence:'不买吧',active:true,status:'已确认',src:'Q6'}];
  const trace=[],calls=[],ack='好，没有这样的例外～';
  const result=await api.runTurn({cfg,prompts,p1:'B',stateJson:JSON.stringify(st),trace,llm:async(id,pid)=>{calls.push({id,pid});return JSON.stringify({answer_status:'answered',facts:[],ack});}},'没');
  const state=JSON.parse(result.newState),written=JSON.parse(trace.find(t=>t.id==='N09').output.written);
  assert.equal(calls.length,1);assert.equal(calls[0].pid,'P1B');assert(!trace.some(t=>['N14','N17'].includes(t.id)));
  assert.equal(written.length,0);assert.equal(state._und.answer_status,'answered');assert.equal(state.tasks.Q6.refused,0);
  assert.equal(state.tasks.Q6.h,1);assert.equal(state.tasks.Q6.done,1);assert.equal(state.current.task,'Q9');
  assert(!state.pending.some(p=>p.task==='Q6'));assert.equal(state.used.S40.F,1,'本次回答不再占用追问额度');
  assert(result.reply.startsWith(ack));assert(!/先放|跳过|没想好/.test(result.reply),'有效否定回答不能展示跳过话术');
  passed++;console.log('✓ 购买经历追问答“没”的桩结果可无新事实，正常进入Q9且不增加追问或P3调用');
 }
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
