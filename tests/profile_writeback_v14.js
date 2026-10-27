'use strict';
// Semantic/model quality is not asserted by stubs. These tests exercise the actual
// mapper, field acceptance, full engine, browser bundle and delivery contracts.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const Mapper=require('../src/profile_mapper'),Content=require('../src/profile_content_composer'),Events=require('../src/business_events');
const mapping=require('../config/profile_mapping.json'),taxonomy=require('../data/platform_interest_tags.json'),aliases=require('../data/interest_aliases.json');
const cfg=require('../data/config.json'),prompts=require('../data/prompts.json');
const clone=x=>JSON.parse(JSON.stringify(x)),S=JSON.stringify;
const api=vm.runInNewContext(fs.readFileSync('src/engine.js','utf8')+'\n({newState,N09,N11,runTurn,completeProfileWriteback})',{performance,setTimeout,clearTimeout,AbortController});
let ver=0;
const f=(field,sub,subject,value,extra={})=>({field,sub,subject,value,evidence:value,active:true,status:'已确认',ver:++ver,turn:1,...extra});
const map=(facts=[],extra={})=>Mapper.mapProfile({facts,config:mapping,taxonomy,interestAliases:aliases,...extra});
const state=()=>({...clone(api.newState(cfg)),stage:'PROFILE_READY',facts_revision:1,
  facts:[f('Q1','items','自己','骑车'),f('Q4','pace','自己','偏慢热')],
  profile:{expect_ta:'你们可以商量你的安排',daily:'你偶尔骑车',love_style:'你刚认识时有点慢热',
    section_state:{expect_ta:'generated',daily:'generated',love_style:'generated'}}});
const complete=(st=state(),compose=async()=>S({story_text:'我偶尔骑车，刚认识时有点慢热',selected_turn_id:null}),c=cfg,registration={})=>api.completeProfileWriteback(c,st,registration,compose);

test('14 controls map using exact source, subject and enum',()=>{
  assert.equal(mapping.targets.length,14);
  const examples=[
    ['Q2','home_out','自己','偏宅家','lifestyle.home_pct',70],
    ['Q2','sleep','自己','偏晚睡','lifestyle.early_sleep_pct',30],
    ['Q3','social','自己','比较偏社交','lifestyle.alone_pct',30],
    ['Q6','style','自己','追求品质','lifestyle.consumption','追求品质'],
    ['Q7','smoke','自己','不吸','lifestyle.smoke','不吸烟'],
    ['Q7','drink','自己','偶尔','lifestyle.drink','小酌怡情'],
    ['Q5','has_pet','自己','正在养','lifestyle.pet_attitude','已经养啦'],
    ['NEED','gender','TA','女生','preference.seek_gender','女生'],
    ['Q11','need','关系','灵魂共鸣','relationship.need','灵魂共鸣'],
    ['Q4','pace','自己','偏慢热','relationship.pace',2],
    ['Q8','flaw_handling','关系','持续评估','relationship.flaw_handling','持续评估'],
    ['Q9','balance','关系','比较偏感情','relationship.balance',4],
    ['Q10','openness','关系','点到为止','relationship.past_openness','点到为止'],
  ];
  for(const [field,sub,subject,value,key,expected] of examples){
    assert.equal(map([f(field,sub,subject,value)]).updates[key],expected,key);
    for(const more of [{active:false},{status:'候选'},{polarity:'否定'},{condition:'只有周末'},{subject:'候选反馈'}])
      assert.equal(map([f(field,sub,subject,value,more)]).updates[key],undefined,key+S(more));
  }
  const h=map([f('NEED','height','TA','180左右')]).updates['preference.ideal_height'];
  assert.deepEqual([h.min_cm,h.max_cm],[175,185]);
});
test('unresolved conflict and non-equivalent choices never create defaults',()=>{
  for(const item of [f('Q2','sleep','自己','不固定'),f('Q10','openness','关系','随关系发展决定'),f('Q6','condition','自己','平时省钱'),f('Q9','strategy','关系','商量')])assert.deepEqual(map([item]).updates,{});
  assert.deepEqual(map([f('Q6','style','自己','追求品质'),f('Q6','style','自己','理智务实')]).updates,{});
  assert.deepEqual(map([f('Q6','style','自己','追求品质')],{notes:[{active:true,field:'Q6',sub:'style',subject:'自己'}]}).updates,{});
});
test('height keeps explicit ranges, hard boundaries and missing registration',()=>{
  const height=(value,more={},registration={})=>map([f('NEED','height','TA',value,more)],{registration}).updates['preference.ideal_height'];
  for(const [value,min,max] of [['175到185',175,185],['至少180',180,220],['170以下',140,170],['不限',140,220]]){
    const h=height(value,{strength:'硬性'});assert.deepEqual([h.min_cm,h.max_cm],[min,max]);
  }
  assert.equal(height('比我高5cm左右'),undefined);
  const relative=height('比我高5cm左右',{}, {height_cm:170});assert.deepEqual([relative.min_cm,relative.max_cm],[170,180]);
  for(const value of ['180','180左右','180上下'])for(const strength of ['偏好','硬性']){
    const h=height(value,{strength});assert.deepEqual([h.min_cm,h.max_cm],[175,185]);
  }
  const hardRelative=height('比我高5cm左右',{strength:'硬性'},{height_cm:170});assert.deepEqual([hardRelative.min_cm,hardRelative.max_cm],[170,180]);
  for(const value of ['185到175','比我高99','180或190'])assert.equal(height(value,{strength:'硬性'},{height_cm:170}),undefined);
});
test('interest taxonomy: 100 IDs and every unambiguous alias round-trips',()=>{
  assert.equal(taxonomy.length,100);
  for(const row of aliases.interest_aliases)for(const value of [row.name,...row.aliases])assert.deepEqual(map([f('Q1','items','自己',value)]).interest.ids,[row.id],value);
});
test('interests union existing IDs, deduplicate and preserve them with no new matches',()=>{
  assert.deepEqual(map([f('Q1','items','自己','骑车，打羽毛球')],{registration:{interest_ids:[1,3,23]}}).interest.ids,[1,3,23,24]);
  assert.deepEqual(map([],{registration:{interest_ids:[1,3,3]}}).interest.ids,[1,3]);
  for(const facts of [[],[f('Q1','items','自己','运动')],[f('NEED','interests','TA','骑车')],[f('Q1','items','自己','骑车',{polarity:'否定'})],[f('Q1','items','自己','骑车',{active:false})]]){
    const r=map(facts);assert.equal(r.interest.status,'mapped');assert.deepEqual(r.interest.ids,[]);
  }
});
test('interest dictionary failure does not suppress valid independent controls',()=>{
  const r=map([f('Q7','smoke','自己','不吸')],{taxonomy:[]});assert.equal(r.interest.status,'error');assert.equal(r.updates['lifestyle.smoke'],'不吸烟');
  const broken=clone(aliases);broken.interest_aliases.push({id:2,name:'骑车',aliases:[]});assert.equal(map([],{interestAliases:broken}).interest.status,'error');
});
test('alcohol only explicit affirmative self naming maps 酒蒙子',()=>{
  const drink=evidence=>map([f('Q7','drink','自己','经常',{evidence})]).updates['lifestyle.drink'];
  assert.equal(drink('我就是个酒蒙子'),'酒蒙子');
  for(const evidence of ['我经常喝酒','我可不是酒蒙子','我不是一个酒蒙子','我不觉得我是酒蒙子','我室友是酒蒙子','我说他是酒蒙子','我以前是酒蒙子','如果我是酒蒙子','我是酒蒙子吗？'])assert.equal(drink(evidence),undefined,evidence);
});
test('pet uses whole Q5 answer with conservative tense, subject and intent',()=>{
  const pet=text=>map([],{q5_answers:[{text,turn:1}]}).updates['lifestyle.pet_attitude'];
  for(const text of ['我还没养，但以后一定想养一只','一直想养只小狗，等毕业就养','我打算养猫','我计划养一只狗'])assert.equal(pet(text),'非常想养',text);
  assert.equal(pet('我现在养着一只猫'),'已经养啦');
  assert.equal(pet('我完全不想养宠物'),'完全不想养');
  for(const text of ['喜欢猫但目前没养','以前养过狗','未来可能会考虑养','如果有钱就计划养','我室友打算养猫','我室友还没养，但以后一定想养一只','我帮朋友养猫','我不打算养','不是完全不想养','我以前非常想养','现在养着别人家的猫','我完全不想养狗'])assert.equal(pet(text),undefined,text);
  assert.equal(map([f('Q5','has_pet','自己','正在养')],{q5_answers:[{text:'完全不想养第二只',turn:1}]}).updates['lifestyle.pet_attitude'],'已经养啦');
  assert.equal(map([],{q5_answers:[{text:'非常想养',turn:1},{text:'完全不想养',turn:2}]}).updates['lifestyle.pet_attitude'],undefined);
  assert.equal(map([],{q5_answers:[{text:'非常想养',turn:1},{text:'现在不打算养了',turn:2}]}).updates['lifestyle.pet_attitude'],undefined);
  for(const text of ['我现在养了花','我特别想养生','我打算养花'])assert.equal(pet(text),undefined,text);
});
test('new fields pass real N09; Q8 new sub enforces relationship subject',()=>{
  for(const [field,sub,subject,value] of [['Q2','home_out','自己','偏宅家'],['NEED','gender','TA','女生'],['Q8','flaw_handling','关系','持续评估']]){
    const s=api.newState(cfg);s.current={task:'LIFE',text:'平时怎么过',qtype:'MAIN'};
    const result=JSON.parse(api.N09(cfg,S(s),value,S({answer_status:'answered',facts:[{field,sub,subject,value,evidence:value}]})).state);
    assert.equal(result.facts.length,1);
  }
  const s=api.newState(cfg);s.current={task:'REL',text:'怎么相处',qtype:'MAIN'};
  const bad=JSON.parse(api.N09(cfg,S(s),'持续评估',S({answer_status:'answered',facts:[f('Q8','flaw_handling','TA','持续评估')]})).state);assert.equal(bad.facts.length,0);
});
function capture(s,task,id,answer,status='answered',extra={}){
  s.current={task,qtype:'MAIN',text:'真实问题 '+id};s.turn++;s.turn_id=id;
  s._und={answer_status:status,parse_ok:true,turn_signal:'normal',facts:[],...extra};
  return JSON.parse(api.N11(cfg,S(s),answer,'{}').state);
}
test('Q/A and Q5 raw persist beyond 8 turns without trimming or combining',()=>{
  let s=clone(api.newState(cfg));
  const answer='  '+('和朋友骑车，遇到下雨就去吃饭。'.repeat(8))+'\n真的挺开心  ';
  s=capture(s,'LIFE','long',answer);s=capture(s,'Q5','pet','我还没养，但以后一定想养一只');
  for(let i=0;i<9;i++)s=capture(s,'SUP2','sup-'+i,'想学骑车');
  assert.equal(s.dialog.length,8);assert.equal(s.topic_candidates[0].raw_answer,answer);assert.equal(s.topic_candidates[0].question,'真实问题 long');assert.equal(s.q5_answers[0].text,'我还没养，但以后一定想养一只');
  const before=s.topic_candidates.length;s.turn_id='sup-8';s._und.answer_status='answered';s=JSON.parse(api.N11(cfg,S(s),'想学骑车','{}').state);assert.equal(s.topic_candidates.length,before);
});
test('refusal, risk, parse failure and existing privacy boundary are not public candidates',()=>{
  for(const [answer,status,extra] of [['不想说','refused',{}],['没想好','unclear',{}],['故事','risk',{}],['故事','answered',{parse_ok:false}],['电话13800138000','answered',{}],['赌博','answered',{}]]){
    const s=capture(clone(api.newState(cfg)),'LIFE','t',answer,status,extra);assert.equal(s.topic_candidates.length,0,answer);
  }
});
test('TA conversion is literal, writeback-only; missing section not written',async()=>{
  const s=state(),original=S(s.profile);const out=await complete(s);assert.equal(S(s.profile),original);assert.equal(S(out.profile),original);assert.equal(out.profile_content.ideal_partner_description,'我们可以商量我的安排');
  s.profile.section_state.expect_ta='generation_error';const r=await complete(s);assert.equal(r.stage,'PROFILE_FAILED');assert(!r.profile_content?.ideal_partner_description);
});
test('composer story and selected original topic are independent',()=>{
  const s=state();s.topic_candidates=[{turn_id:'t1',task_id:'LIFE',answer_status:'answered',question:'平时做什么？',raw_answer:'原句'.repeat(60)}];
  const input=Content.prepareContentInput(s);
  let result=Content.parseAndValidate(S({story_text:'我偶尔骑车',selected_turn_id:'fake',answer:'伪造'}),input);assert.equal(result.story_text,'我偶尔骑车');assert.equal(result.selected_turn_id,null);
  result=Content.parseAndValidate(S({story_text:{bad:true},selected_turn_id:'t1'}),input);assert.equal(result.story_text,'');assert.equal(result.selected_turn_id,'t1');
  assert.equal(Content.resolveSelectedTopic(input.qa_candidates,'t1').answer,'原句'.repeat(60));
  for(const raw of ['[]','null','bad','"text"'])assert.equal(Content.parseAndValidate(raw,input).story_text,'');
  assert.equal(Content.parseAndValidate(S({story_text:'没有证据',selected_turn_id:null}),{daily:'',love_style:'',supporting_facts:[],qa_candidates:[]}).story_text,'');
});
test('one complete event: original portrait, patch fields, merged interest, original Q/A',async()=>{
  const s=state();s.topic_candidates=[{turn_id:'t1',task_id:'SUP2',answer_status:'answered',question:'想做什么？',raw_answer:'想学冲浪。'.repeat(20)}];
  let calls=0;const done=await complete(s,async input=>{calls++;assert.equal(input.daily,s.profile.daily);return S({story_text:'我偶尔骑车，刚认识时慢热',selected_turn_id:'t1'});});
  assert.equal(calls,1);const {state:after,event}=Events.prepareProfileReady(done);
  assert.deepEqual(clone(event.interest_ids),[23]);assert.equal(event.write_modes.interest_ids,'merge');assert.equal(event.profile_field_updates['relationship.pace'],2);assert.equal(event.profile_content.topic.answer,s.topic_candidates[0].raw_answer);assert.equal(event.profile.expect_ta,s.profile.expect_ta);
  assert.equal(Events.prepareProfileReady(after).event,null);
  await complete(after,()=>{throw Error('must not regenerate');});
});
test('interest success [] vs failed dictionary have different event semantics',async()=>{
  const s=state();s.facts=[];s.profile={expect_ta:'你希望对方坦诚',daily:'',love_style:''};
  const ok=Events.prepareProfileReady(await complete(s)).event;assert.deepEqual(clone(ok.interest_ids),[]);assert.equal(ok.write_modes.interest_ids,'merge');
  const c=clone(cfg);c.profile_mapping.taxonomy=[];s.facts=[f('Q7','smoke','自己','不吸')];
  const failed=Events.prepareProfileReady(await complete(s,async()=>'',c)).event;assert(!('interest_ids' in failed));assert(!('interest_ids' in failed.write_modes));assert.equal(failed.profile_field_updates['lifestyle.smoke'],'不吸烟');
});
test('composer failure blocks writeback; successful generation then delivery retries never rerun models',async()=>{
  const s=state();s.profile_writeback={required:true,status:'pending',facts_revision:1};assert.throws(()=>Events.prepareProfileReady(s),/writeback_not_ready/);
  let calls=0;const failed=await complete(s,async()=>{calls++;throw Error('upstream failure');});
  assert.equal(failed.stage,'PROFILE_FAILED');assert.equal(failed.profile_writeback.status,'failed');assert.throws(()=>Events.prepareProfileReady(failed));
  const done=await complete(failed,async()=>{calls++;return S({story_text:'我偶尔骑车',selected_turn_id:null});});
  const ready=Events.prepareProfileReady(done);assert.equal(ready.event.profile_content.story_text,'我偶尔骑车');assert.equal(ready.event.profile.daily,s.profile.daily);
  let attempts=0;const payloads=[];const d=Events.createDispatcher({onProfileReady:async e=>{payloads.push(S(e));if(++attempts===1)throw Error('offline');return{accepted:true,profile_version:e.profile_version};}});
  assert.equal((await d.dispatch([ready.event]))[0].accepted,false);assert.equal((await d.dispatch([ready.event]))[0].accepted,true);assert.equal(payloads[0],payloads[1]);assert.equal(calls,2);
});
test('real orchestration uses P6/P7 then single PC; refresh replay invokes no models',async()=>{
  const s=state();s.stage='AWAIT_60';s.stage_card_60={attitude:'已有洞察'};s.progress=60;
  const calls=[];const ctx={cfg,prompts,stateJson:S(s),turnId:'profile-v14',trace:[],registrationProfile:{height_cm:170},llm:async(id,pid)=>{
    calls.push(pid);if(pid==='P6')return S({expect_ta:'',love_style:'你刚认识时有点慢热'});if(pid==='P7')return S({daily:'你偶尔骑车'});if(pid==='PC')return S({story_text:'我偶尔骑车，刚认识时有点慢热',selected_turn_id:null});throw Error(pid);
  }};
  const r=await api.runTurn(ctx,cfg.buttons.p60[1]);assert.deepEqual(calls,['P6','P7','PC']);assert.equal(r.events.length,1);assert.equal(r.events[0].profile_content.story_text,'我偶尔骑车，刚认识时有点慢热');
  await api.runTurn({...ctx,stateJson:r.newState,llm:()=>{throw Error('refresh model call');}},cfg.buttons.p60[1]);assert.equal(calls.length,3);
});
test('PC timeout blocks ready event; explicit retry only calls PC, including after refresh',async()=>{
  const c=clone(cfg);c.timeouts.PC=10;const s=state();s.stage='AWAIT_60';let count=0;
  const r=await api.runTurn({cfg:c,prompts,stateJson:S(s),trace:[],llm:async(id,pid)=>{if(pid==='PC'){count++;return new Promise(()=>{});}return S(pid==='P6'?{expect_ta:'',love_style:'你慢热'}:{daily:'你偶尔骑车'});}},c.buttons.p60[1]);
  assert.equal(count,1);assert.equal(r.events.length,0);const failed=JSON.parse(r.newState);
  assert.equal(failed.stage,'PROFILE_FAILED');assert.equal(failed.profile_version,0);assert.equal(failed.profile_field_updates['relationship.pace'],2);
  const fresh=vm.runInNewContext(fs.readFileSync('src/engine.js','utf8')+'\n({runTurn})',{performance,setTimeout,clearTimeout,AbortController});
  const calls=[];const retry=await fresh.runTurn({cfg:c,prompts,stateJson:r.newState,trace:[],llm:async(id,pid)=>{calls.push(pid);return S({story_text:'我偶尔骑车',selected_turn_id:null});}},'重试生成画像');
  assert.deepEqual(calls,['PC']);assert.equal(retry.events.length,1);assert.equal(retry.events[0].profile_version,1);assert.equal(JSON.parse(retry.newState).profile_generation,undefined);
});

test('P6 failure retries P6 only, retains P7 and progress, then composes and emits once',async()=>{
  const s=state();s.stage='AWAIT_60';s.progress=65;const calls=[];
  const first=await api.runTurn({cfg,prompts,stateJson:S(s),trace:[],llm:async(id,pid)=>{calls.push(pid);return pid==='P6'?'null':S({daily:'你偶尔骑车'});}},cfg.buttons.p60[1]);
  assert.deepEqual(calls,['P6','P7']);assert.equal(first.events.length,0);assert.equal(JSON.parse(first.newState).progress,65);
  calls.length=0;
  const retry=await api.runTurn({cfg,prompts,stateJson:first.newState,trace:[],llm:async(id,pid)=>{calls.push(pid);return S(pid==='P6'?{expect_ta:'',love_style:'你刚认识时慢热'}:{story_text:'我偶尔骑车，刚认识时慢热',selected_turn_id:null});}},'重试生成画像');
  assert.deepEqual(calls,['P6','PC']);assert.equal(retry.events.length,1);assert.equal(retry.events[0].flow_progress,65);assert.equal(retry.events[0].profile.daily,'你偶尔骑车');
});

test('empty or malformed story cannot masquerade as a finished profile',async()=>{
  for(const raw of ['null','{}',S({story_text:'',selected_turn_id:null}),S({story_text:42,selected_turn_id:null})]){
    const out=await complete(state(),async()=>raw);assert.equal(out.stage,'PROFILE_FAILED');assert.throws(()=>Events.prepareProfileReady(out));
  }
  const s=state();s.profile={expect_ta:'',daily:'',love_style:''};const out=await complete(s,()=>{throw Error('must not call PC');});
  assert.equal(out.profile_writeback.reason,'no_evidence');assert.throws(()=>Events.prepareProfileReady(out));
});

test('insufficient evidence can reopen Q12 without resetting progress or calling models',async()=>{
  const s=state();s.stage='PROFILE_FAILED';s.progress=65;s.profile_writeback={required:true,status:'failed',reason:'no_evidence'};
  const r=await api.runTurn({cfg,prompts,stateJson:S(s),trace:[],llm:()=>{throw Error('unexpected model call');}},'继续补充');
  const out=JSON.parse(r.newState);assert.equal(out.stage,'S40');assert.equal(out.current.task,'Q12');assert.equal(out.progress,65);assert.equal(r.events.length,0);
});

test('host applies atomic set union, so stale snapshot and replay cannot erase interests',async()=>{
  const ready=Events.prepareProfileReady(await complete(state(),undefined,cfg,{interest_ids:[1]}));
  const db={ids:[1,3],seen:new Set()};const dispatcher=Events.createDispatcher({onProfileReady:async event=>{
    if(!db.seen.has(event.idempotency_key)){
      assert.equal(event.write_modes.interest_ids,'merge');db.ids=[...new Set([...db.ids,...event.interest_ids])].sort((a,b)=>a-b);db.seen.add(event.idempotency_key);
    }
    return {accepted:true,profile_version:event.profile_version};
  }});
  await dispatcher.dispatch([ready.event]);await dispatcher.dispatch([ready.event]);assert.deepEqual(db.ids,[1,3,23]);
});
