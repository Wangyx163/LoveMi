'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('src/engine.js','utf8');
const load=()=>vm.runInNewContext(source+'\n({newState,runTurn,N38,N09,N25,N11,qOk,BusinessEvents})',{performance,setTimeout,clearTimeout,AbortController});
const api=load(),cfg=JSON.parse(fs.readFileSync('data/config.json','utf8')),prompts=JSON.parse(fs.readFileSync('data/prompts.json','utf8'));
const S=JSON.stringify;let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const fact=(field,sub,subject,value,evidence=value)=>({field,sub,subject,value,evidence});
const state=(task,stage='S60')=>{const s=api.newState(cfg);s.stage=stage;s.current={task,qtype:'MAIN',text:cfg.tasks[task].script};return s;};
const ctx=(s,llm,turnId)=>({cfg,prompts,stateJson:S(s),llm,turnId,trace:[]});
(async()=>{
 await test('concurrent same turn invokes P1B once; refresh replay retains version and facts',async()=>{
  const s=state('NEED');let calls=0;
  const c=ctx(s,async()=>{calls++;await new Promise(r=>setTimeout(r,5));return S({answer_status:'answered',facts:[fact('NEED','height','TA','175以上'),fact('NEED','interests','TA','运动')],ack:'好呀～'});},'turn-one');
  const [a,b]=await Promise.all([api.runTurn(c,'175以上，运动'),api.runTurn(c,'175以上，运动')]);
  assert.equal(calls,1);assert.equal(a.newState,b.newState);assert.equal(b.duplicate,true);
  const after=JSON.parse(a.newState);assert.equal(after.facts_revision,1);assert.equal(a.events.length,1);assert.equal(a.events[0].task_id,'NEED');
  const replay=await load().runTurn({...c,stateJson:a.newState,llm:()=>{throw Error('replay called model');}},'175以上，运动');
  assert.equal(replay.duplicate,true);assert.equal(replay.newState,a.newState);assert.equal(JSON.parse(replay.newState).turn,1);
  await assert.rejects(()=>api.runTurn({...c,stateJson:a.newState},'不同回答'),/turn_id_input_conflict/);
 });
 await test('same words with different request ids remain separate legitimate turns',async()=>{
  let calls=0;const llm=async()=>{calls++;return S({answer_status:'answered',ack:'知道啦～',facts:[],followup:{worth:false}});};
  const a=await api.runTurn(ctx(state('LIFE'),llm,'id-a'),'可以');
  await api.runTurn({...ctx(JSON.parse(a.newState),llm,'id-b')},'可以');assert.equal(calls,2);
 });
 await test('model failures produce no facts event and never settle the task',async()=>{
  const s=state('Q5','S40');s.progress=60;let count=0;
  const r=await api.runTurn(ctx(s,async()=>{count++;return count%2?'null':S({answer_status:'answered',facts:{}});},'invalid'),'有猫');
  const st=JSON.parse(r.newState);assert.equal(count,2);assert.equal(st.tasks.Q5.a,0);assert.equal(st.progress,60);assert.equal(r.events.length,0);
 });
 await test('mixed Q12 answer/question is answered before profile; committed facts precede profile event',async()=>{
  const s=state('Q12','S40');for(const t of Object.values(s.tasks))Object.assign(t,{a:1,done:1});Object.assign(s.tasks.Q12,{a:0,done:0});
  s.stage_card_60={attitude:'原来的洞察',content_status:'ok'};const order=[];
  const c=ctx(s,async(id,pid)=>{order.push(pid);if(pid==='P1B')return S({answer_status:'answered',turn_signal:'user_question',reply_text:'我只依据当前提供的信息整理画像。',facts:[fact('NEED','traits','TA','坦诚')],ack:'知道啦～'});return S(pid==='P6'?{expect_ta:'你希望对方坦诚。',love_style:''}:{daily:''});},'q12');
  c.onBubble=t=>order.push(t);const r=await api.runTurn(c,'希望坦诚，你会怎么整理？');
  assert(order.indexOf('我只依据当前提供的信息整理画像。')<order.indexOf('P6'));
  assert.deepEqual(Array.from(r.events,e=>e.type),['onFactsUpdated','onProfileReady']);
  const profile=r.events[1];assert.equal(profile.core_60,'原来的洞察');assert.equal(profile.flow_progress,100);assert.equal(profile.facts_revision,1);assert(!('core' in profile.profile));
 });
 await test('direct generation keeps actual progress and a single ready event',async()=>{
  const s=api.newState(cfg);s.stage='AWAIT_60';s.progress=65;s.stage_card_60={attitude:'唯一洞察',content_status:'ok'};
  const a=await api.runTurn(ctx(s,async()=>S({expect_ta:'',love_style:'',daily:''}),'direct'),cfg.buttons.p60[1]);
  assert.equal(a.events.length,1);assert.equal(a.events[0].flow_progress,65);assert.equal(a.events[0].profile_version,1);
  const b=await api.runTurn(ctx(JSON.parse(a.newState),()=>{throw Error('save called model');},'save'),cfg.buttons.p100[0]);
  assert.equal(b.events.length,0);assert.equal(JSON.parse(b.newState).profile_version,1);
 });
 await test('both invalid JSON profile outputs leave explicit empty error states',async()=>{
  const s=api.newState(cfg);s.stage='AWAIT_60';s.progress=60;s.facts=[{...fact('NEED','traits','TA','坦诚'),ver:1,active:true,status:'已确认'}];
  const r=await api.runTurn(ctx(s,async()=> 'null','null-profile'),cfg.buttons.p60[1]);
  assert.equal(r.events[0].section_state.expect_ta,'generation_error');assert.equal(r.events[0].profile.expect_ta,'');
 });
 await test('nested wrong types and unknown enums reject the whole proposed update',()=>{
  for(const extra of [{reference_task:{}},{ack_worthy:'yes'},{turn_signal:'unknown'},{card_interest:{target:[]}},{followup:{worth:true}},{facts:[{...fact('NEED','traits','TA','坦诚'),strength:'maybe'}]},{facts:[{...fact('NEED','traits','TA','坦诚'),priority:'high'}]}])assert.equal(api.N38(S({answer_status:'answered',...extra})).ok,false);
 });
 await test('dynamic followups obey the prompt length and single-question contract',()=>{
  assert.equal(api.qOk(cfg,'你希望两个人平时怎么相处呢？'),true);
  for(const q of ['你'.repeat(40)+'？','平时去哪玩？和谁去？','平时喜欢\n怎么安排？','对身高有什么要求？'])assert.equal(api.qOk(cfg,q),false);
 });
 await test('single candidate attribution resolves l2 even before l1 and keeps stable ids',()=>{
  const s=state('CARD_L1');s.card_set_id='set-1';s.cards=[{key:'A',name:'小林',id:'stable-1'},{key:'B',name:'阿遥',id:'stable-2'}];
  const r=api.N09(cfg,S(s),'A，温柔',S({answer_status:'answered',facts:[fact('CARD','l2','候选反馈','温柔'),fact('CARD','l1','候选反馈','A')]}));
  const feedback=JSON.parse(r.state).facts;assert.deepEqual(feedback.map(f=>f.candidate_ids),[['stable-1'],['stable-1']]);
 });
 await test('editing one multi-valued preference retains another current preference',()=>{
  const s=state('NEED');s.fv=2;s.facts=[{...fact('NEED','interests','TA','摄影'),ver:1,active:true,status:'已确认'},{...fact('NEED','interests','TA','跑步'),ver:2,active:true,status:'已确认'}];
  const r=api.N09(cfg,S(s),'摄影',S({answer_status:'answered',facts:[{...fact('NEED','interests','TA','摄影'),strength:'硬性'}]}));
  const active=JSON.parse(r.state).facts.filter(f=>f.active);assert.equal(active.length,2);assert(active.some(f=>f.value==='跑步'));assert(active.some(f=>f.value==='摄影'&&f.strength==='硬性'));
 });
 console.log(`${passed} V2.2 orchestration checks passed (offline)`);
})().catch(e=>{console.error(e);process.exitCode=1});
