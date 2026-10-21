#!/usr/bin/env node
'use strict';
// Run from LoveMi repository root: node test_lovemi_flow_fix.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {performance} = require('node:perf_hooks');
const path = require('node:path');
const cwd = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(cwd,'data/config.json'),'utf8'));
const prompts = JSON.parse(fs.readFileSync(path.join(cwd,'data/prompts.json'),'utf8'));
const engineArg = process.argv.indexOf('--engine');
if(engineArg>=0&&!process.argv[engineArg+1])throw Error('--engine 需要指定文件路径');
const source = fs.readFileSync(engineArg>=0?path.resolve(process.argv[engineArg+1]):path.join(cwd,'src/engine.js'),'utf8');
const api=vm.runInNewContext(source+'\n({newState,N02,N09,N11,N23,N36,runTurn})',{performance});
const S=JSON.stringify;
let passed=0;
function test(name,fn){return Promise.resolve().then(fn).then(()=>{passed++;console.log('✓ '+name);});}
function mainState(stage,task){const st=api.newState(cfg);st.stage=stage;st.current={task,qtype:'MAIN',text:cfg.tasks[task].core};return st;}
function feedbackState(){
  const st=mainState('S60','REL');
  for(const id of ['NEED','CARD_L1','LIFE'])st.tasks[id].a=1;
  st.history.push({task:'LIFE',qtype:'MAIN',text:cfg.tasks.LIFE.core});
  st._und={answer_status:'asks_back',turn_signal:'flow_feedback',reference_task:'LIFE',reply_text:'生活这块确实还可以慢慢聊～',ack:'那我们聊聊生活这块～',parse_ok:true};
  return st;
}
function interest(){return {field:'Q1',sub:'items',subject:'自己',value:'电影',evidence:'喜欢电影',active:true,status:'已确认',src:'LIFE'};}
async function run(){
  await test('Q12 使用 P1B 的 ANSWER 分支（不再从 N02 直达画像）',()=>{
    const st=mainState('S40','Q12');const r=api.N02(cfg,S(st),'我觉得两个人要能好好沟通');assert.equal(r.branch,'ANSWER');
    assert.equal(JSON.parse(r.cur_task_slim).task_id,'Q12');
  });
  await test('N02 向 P1B 提供真实任务 ID 的索引',()=>{
    const st=mainState('S60','REL');const r=api.N02(cfg,S(st),'我之前生活还没聊完');
    assert(JSON.parse(r.cur_task_slim).task_lookup.some(x=>x.task_id==='LIFE'));
  });
  await test('N09 透传 user_question，但不把 Q12 的反问写成补充事实',()=>{
    const st=mainState('S40','Q12');st.turn=1;
    const out=api.N09(cfg,S(st),'你为什么问这些？',S({answer_status:'asks_back',turn_signal:'user_question',reply_text:'是为了认识你呀～',ack:'嗯～',facts:[]}));
    const after=JSON.parse(out.state);assert.equal(after._und.turn_signal,'user_question');
    assert.equal(after.facts.filter(f=>f.field==='Q12').length,0);
  });
  await test('N09 保留普通 Q12 的开放补充',()=>{
    const st=mainState('S40','Q12');st.turn=1;
    const out=api.N09(cfg,S(st),'遇到分歧的时候愿意好好沟通',S({answer_status:'answered',turn_signal:'normal',facts:[],ack:'知道啦～'}));
    assert(JSON.parse(out.state).facts.some(f=>f.field==='Q12'&&f.sub==='supplement'));
  });
  await test('用户纯反问，不进入 REASK、FOLLOW_UP 或 SUPPLEMENT',()=>{
    const st=mainState('S60','REL');for(const id of ['NEED','CARD_L1','LIFE'])st.tasks[id].a=1;
    st._und={answer_status:'asks_back',turn_signal:'user_question',reply_text:'想多了解你呀～',ack:'嗯～',parse_ok:true};
    const out=api.N11(cfg,S(st),'为什么问这些？','{}');
    assert.equal(out.action,'SHOW_60');
  });
  await test('返回 LIFE 且未覆盖/有预算 → FEEDBACK_ASK + R 额度',()=>{
    const st=mainState('S60','REL');st.tasks.LIFE.a=1;
    st.history.push({task:'LIFE',qtype:'MAIN',text:cfg.tasks.LIFE.core});
    st._und={answer_status:'asks_back',turn_signal:'flow_feedback',reference_task:'LIFE',reply_text:'生活还可以聊～',ack:'嗯～',parse_ok:true};
    const out=api.N11(cfg,S(st),'刚才生活还没聊完吧','{}');
    assert.equal(out.action,'FEEDBACK_ASK');assert.equal(out.route,'QGEN');
    const after=JSON.parse(out.state);assert.equal(after.used.S60.R,1);assert.equal(after.tasks.REL.a,0);
  });
  await test('返回 LIFE 但已 covered 时不额外回补',()=>{
    const st=feedbackState();
    st.facts=[{field:'Q1',sub:'items',subject:'自己',value:'电影',evidence:'喜欢电影',active:true,status:'已确认'}];
    st._und={answer_status:'asks_back',turn_signal:'flow_feedback',reference_task:'LIFE',reply_text:'生活这块也值得慢慢聊～',ack:'嗯～',parse_ok:true};
    const out=api.N11(cfg,S(st),'生活没聊完吧','{}');
    assert.notEqual(out.action,'FEEDBACK_ASK');
  });
  await test('任务索引不会丢失人物卡或需求门槛上下文，完整与精简输入一致',()=>{
    for(const task of ['CARD_L1','NEED']){
      const r=api.N02(cfg,S(mainState('S60',task)),'为什么问这个？');
      const slim=JSON.parse(r.cur_task_slim),full=JSON.parse(r.cur_task);
      assert.deepEqual(slim.task_lookup,full.task_lookup);
      if(task==='CARD_L1'){assert.equal(slim.parent_task_id,'CARD_L1');assert(Array.isArray(slim.asked_followups));}
      else if(cfg.need_intake?.enabled)assert(slim.need_intake);
    }
  });
  await test('回补被拒绝的各类边界均不消耗 R 额度',()=>{
    const variants=[
      st=>{st.tasks.LIFE.rep=cfg.limits.replace_per_task;},
      st=>{st.used.S60.F=Math.floor(cfg.budget.S60.N*cfg.budget.S60.r);},
      st=>{st.tasks.LIFE.refused=1;},
      st=>{st._und.refused_targets=['LIFE'];},
      st=>{st._und.reference_task='REL';},
      st=>{st._und.reference_task='made_up_task';},
      st=>{st._und.reference_task=null;},
      st=>{st._und.reference_task='Q5';st.tasks.Q5.a=1;st.history.push({task:'Q5'});},
      st=>{st._und.reference_task='CARD_L1';st.history.push({task:'CARD_L1'});},
      st=>{st.tasks.LIFE.a=0;},
      st=>{st.history=[];},
      st=>{st.facts=[interest()];},
    ];
    for(const change of variants){
      const st=feedbackState();change(st);
      const out=api.N11(cfg,S(st),'刚才生活没聊完吧','{}');
      assert.notEqual(out.action,'FEEDBACK_ASK');assert.equal(JSON.parse(out.state).used.S60.R,0);
    }
    const st=feedbackState(),local={...cfg,no_replace_tasks:[...cfg.no_replace_tasks,'LIFE']};
    assert.notEqual(api.N11(local,S(st),'生活没聊完','{}').action,'FEEDBACK_ASK');
  });
  await test('回补只记录一条对话，使用 ack，并在补答后找回未答主问题',()=>{
    const st=feedbackState();
    const routed=api.N11(cfg,S(st),'刚才生活还没聊完吧','{}');
    let after=JSON.parse(routed.state);assert.equal(after.dialog.length,1);
    const asked=api.N23(cfg,routed.state,cfg.tasks.LIFE.core);
    assert(asked.reply.startsWith(st._und.ack));assert(!asked.reply.includes(st._und.reply_text));
    after=JSON.parse(asked.new_state);assert.equal(after.current.task,'LIFE');
    const understood=api.N09(cfg,S(after),'喜欢电影',S({answer_status:'answered',facts:[interest()],ack:'电影能聊的可不少～'}));
    const resumed=api.N11(cfg,understood.state,'喜欢电影','{}');
    assert.equal(JSON.parse(resumed.state).plan.task,'REL');assert.equal(JSON.parse(resumed.state).used.S60.R,1);
  });
  await test('反馈中回答当前问题时正常结算，不因回补重复采集',()=>{
    const st=feedbackState();st.asked={S60:10};
    const r9=api.N09(cfg,S(st),'我慢热，刚才生活还没聊完',S({...st._und,answer_status:'answered',facts:[{field:'Q4',sub:'pace',subject:'自己',value:'偏慢热',evidence:'我慢热'}]}));
    const r11=api.N11(cfg,r9.state,'我慢热，刚才生活还没聊完','{}');
    assert.equal(r11.action,'FEEDBACK_ASK');assert.equal(JSON.parse(r11.state).tasks.REL.a,1);
    const asked=api.N23(cfg,r11.state,cfg.tasks.LIFE.core);
    const next=JSON.parse(asked.new_state);next._und={answer_status:'answered',parse_ok:true};next.facts.push(interest());
    const end=api.N11(cfg,S(next),'喜欢电影','{}');
    assert.equal(end.action,'SHOW_60');assert.equal(JSON.parse(end.state).plan.action,'SHOW_60');
  });
  await test('用户提问即使模型建议追问，也不发普通或人物卡额外追问',()=>{
    for(const task of ['LIFE','CARD_L1']){
      const st=mainState('S60',task);st.tasks.NEED.a=1;st.facts=[interest()];
      st._und={answer_status:'answered',turn_signal:'user_question',parse_ok:true,followup:{worth:true,question:'平时喜欢看什么电影？'},card_followup:{needed:true,question:'你期待怎样的相处？'}};
      const result=api.N11(cfg,S(st),'我喜欢电影，你为什么问这些？','{}');
      assert.notEqual(result.action,'FOLLOW_UP');assert.equal(JSON.parse(result.state).used.S60.F,0);
    }
  });
  await test('用户反问仍遵守出卡前必需信息门槛',()=>{
    if(!cfg.need_intake?.enabled)return;
    const st=mainState('S60','NEED');st._und={answer_status:'asks_back',turn_signal:'user_question',parse_ok:true,reply_text:'这些偏好能帮我了解你～'};
    const out=api.N11(cfg,S(st),'为什么问这个','{}');
    assert.equal(out.action,'NEED_CLARIFY');assert.notEqual(out.route,'CARDS');
  });
  await test('Q12 不把无补充、拒答、反问或被拒事实兜底保存',()=>{
    const cases=[
      ['没有其他补充',{answer_status:'answered'}],['没什么要补充的了',{answer_status:'answered'}],
      ['不想说',{answer_status:'refused'}],['你是谁？',{answer_status:'asks_back',turn_signal:'user_question'}],
      ['希望互相理解',{answer_status:'answered',facts:[{field:'Q12',sub:'supplement',subject:'自己',value:'不合法的证据',evidence:'不存在的原话'}]}],
      ['微信 abc12345678',{answer_status:'answered'}],
    ];
    for(const [ui,und] of cases){
      const out=api.N09(cfg,S(mainState('S40','Q12')),ui,S(und));
      assert.equal(JSON.parse(out.state).facts.filter(f=>f.field==='Q12').length,0,ui);
    }
  });
  await test('reply_text 与 ack 二选一；无效候选不截断使用，feedback_close 可兜底',()=>{
    const st=mainState('S60','REL');st.plan={action:'ASK_NEXT',task:'REL',qtype:'MAIN'};
    st._und={answer_status:'answered',parse_ok:true,turn_signal:'user_question',ack:'知道啦～',reply_text:'了解你的想法，整理出来的画像才更贴近你～'};
    let r=api.N23(cfg,S(st),cfg.tasks.REL.core);assert(r.reply.startsWith(st._und.reply_text));assert(!r.reply.includes(st._und.ack));
    for(const text of ['要不要再说一点？','啊'.repeat(121),...cfg.blocked.compliance]){
      st._und.reply_text=text;r=api.N23(cfg,S(st),cfg.tasks.REL.core);assert(r.reply.startsWith(st._und.ack));
    }
    st._und.turn_signal='flow_feedback';st._und.reply_text='';st._und.feedback_close='生活这块还有很多可以聊的，我先整理一下目前听到的～';
    const r9=api.N09(cfg,S(st),'生活没聊完吧',S(st._und));
    r=api.N23(cfg,r9.state,cfg.tasks.REL.core);assert(r.reply.startsWith(st._und.feedback_close));
  });
  await test('出卡分支也优先回应用户本轮提问',()=>{
    const st=mainState('S60','NEED');st._und={answer_status:'answered',parse_ok:true,turn_signal:'user_question',ack:'知道啦～',reply_text:'我会先从你在意的生活方式了解起～'};
    const out=api.N36(cfg,S(st));assert(out.reply.startsWith(st._und.reply_text));
  });
  await test('关怀只消费一次，优先于用户提问的候选回答',()=>{
    const st=mainState('S60','REL');st.plan={action:'ASK_NEXT',task:'REL',qtype:'MAIN'};st._care=true;
    st._und={answer_status:'risk',parse_ok:true,turn_signal:'user_question',reply_text:'候选回答不应展示',ack:'普通承接不应展示'};
    const out=api.N23(cfg,S(st),cfg.tasks.REL.core);
    assert(cfg.care_ack.some(t=>out.reply.startsWith(t)));assert(!out.reply.includes(st._und.reply_text));assert.equal(JSON.parse(out.new_state)._care,false);
  });
  await test('risk 即使携带流程反馈也不会触发回补',()=>{
    const st=feedbackState();st._und.answer_status='risk';
    const out=api.N11(cfg,S(st),'生活没聊完，最近有点难受','{}');
    assert.notEqual(out.action,'FEEDBACK_ASK');assert.equal(JSON.parse(out.state)._care,true);
  });
  await test('画像前会先通过 onBubble 输出本轮回应',async()=>{
    const st=mainState('S60','REL');for(const id of ['NEED','CARD_L1','LIFE'])st.tasks[id].a=1;
    const events=[],trace=[];
    const result=await api.runTurn({cfg,prompts,p1:'B',stateJson:S(st),trace,
      llm:async(_id,pid)=> pid==='P1B'?S({answer_status:'answered',turn_signal:'user_question',reply_text:'想了解你平时的想法呀～',ack:'嗯～',facts:[],followup:{worth:false}}):S({attitude:'你在关系里愿意认真沟通。'}),
      onBubble:t=>events.push(t)
    },'我没什么要求，你为什么问这些？');
    assert(trace.some(x=>x.id==='N25'),'应生成 60% 阶段卡');
    assert(events[0].includes('想了解你平时的想法'));
    assert(events.includes(cfg.p60_bubble));
  });
  await test('60% / 100% 阶段承接先于生成调用，流式与非流式均只输出一次',async()=>{
    for(const stage of ['S60','S40'])for(const streaming of [true,false]){
      const task=stage==='S60'?'REL':'Q12',st=mainState(stage,task);
      for(const id of cfg.order[stage])if(id!==task)st.tasks[id].a=1;
      st.asked={[stage]:10};
      const text='我先回应你刚刚提出的问题，再整理目前聊到的内容～',events=[],trace=[];
      const result=await api.runTurn({cfg,prompts,p1:'B',stateJson:S(st),trace,
        ...(streaming?{onBubble:t=>events.push(t)}:{}),
        llm:async(_id,pid)=>{
          if(pid==='P1B')return S({answer_status:'answered',turn_signal:'user_question',reply_text:text,ack:'知道啦～',facts:[]});
          if(streaming)assert.equal(events[0],text,'先回应用户再调用画像模型');
          return '{}';
        }
      },'为什么问这些？');
      const end=JSON.parse(result.newState);
      assert.equal(end.stage,stage==='S60'?'AWAIT_60':'PROFILE_READY');assert.equal(end._new.length,0);
      if(streaming){assert.equal(events.filter(t=>t===text).length,1);assert(!result.reply.includes(text));}
      else {assert(result.reply.startsWith(text+'\n\n'));assert.equal(result.reply.split(text).length-1,1);}
      assert(trace.some(t=>t.id==='N23a'&&t.output.text===text));
    }
  });
  console.log(`\n通过 ${passed} 项定向测试。请继续执行 npm test 做全量回归。`);
}
run().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
