'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..'),cfg=JSON.parse(fs.readFileSync(path.join(root,'data/config.json'),'utf8')),prompts=JSON.parse(fs.readFileSync(path.join(root,'data/prompts.json'),'utf8'));
const api=vm.runInNewContext(fs.readFileSync(path.join(root,'src/engine.js'),'utf8')+'\n({newState,runTurn,N09,N11,N32})',{performance,AbortController,setTimeout,clearTimeout});
const clone=x=>JSON.parse(JSON.stringify(x));let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
async function generate(enabled,pe,extra={}){const c=clone(cfg);c.profile_evidence.enabled=enabled;c.timeouts.PE=25;const s=api.newState(c);s.stage='AWAIT_60';s.facts=[{field:'NEED',sub:'traits',subject:'TA',value:'坦诚',evidence:'希望另一半坦诚',active:true,status:'已确认',ver:1},{field:'Q8',sub:'expectation',subject:'关系',value:'好好沟通',evidence:'希望好好沟通',active:true,status:'已确认',ver:2},{field:'Q1',sub:'items',subject:'自己',value:'电影',evidence:'喜欢看电影',active:true,status:'已确认',ver:3}];s.stage_card_60={attitude:'原核心不变',content_status:'ok'};s.profile_evidence_runtime={status:'ok',levels:{expect_ta:'insufficient',love_style:'insufficient',daily:'insufficient'}};const calls=[],trace=[];const result=await api.runTurn({cfg:c,prompts,p1:'B',stateJson:JSON.stringify(s),trace,enforceTimeout:false,llm:async(id,pid,sys,user)=>{calls.push({pid,sys,user});if(pid==='PE'){if(pe instanceof Error)throw pe;if(typeof pe==='function')return pe();return JSON.stringify(pe);}return JSON.stringify(pid==='P6'?{expect_ta:'希望有话直说',love_style:'希望彼此坦诚'}:{daily:'喜欢看电影'});}},c.buttons.p60[1]);return {c,result,st:JSON.parse(result.newState),calls,trace};}
const empty={atoms:[],links:[],routes:{expect_ta:{primary:[],secondary:[]},love_style:{primary:[],secondary:[]},p7:{primary:[],secondary:[]}}};
(async()=>{
 await test('单一P6来源，旧P1与P6E文件及浏览器缓存清理',()=>{
   for(const file of ['P1_system.txt','P1_user.txt','P6_evidence_system.txt','P6_evidence_user.txt'])assert(!fs.existsSync(path.join(root,'prompts',file)));
   assert(!prompts.P1);assert(!prompts.P6E);
   const shared=fs.readFileSync(path.join(root,'prompts/shared_behavior.txt'),'utf8').trimEnd();
   assert.equal(prompts.P6.sys,fs.readFileSync(path.join(root,'prompts/P6_system.txt'),'utf8').trimEnd().replace('{{shared_behavior}}',shared));
   const html=fs.readFileSync(path.join(root,'LoveMi_在线测试版_v1.9.html'),'utf8');
   for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
   assert(!html.includes('id="p1A"'));assert(!html.includes("let curP='P1';"));
   const cache=html.match(/\/\* ===== Shared behavior prompt cache ===== \*\/([\s\S]*?)\/\* ===== End shared behavior prompt cache ===== \*\//)[1];
   const old={P1:{sys:'old'},P6E:{sys:'old'},P6:{sys:'old'}};
   vm.runInNewContext(cache,{prompts:old,DEFAULT_PROMPTS:prompts,clone,LS:{get:()=>null,set:()=>{}}});
   assert(!old.P1);assert(!old.P6E);assert.equal(old.P6.sys,prompts.P6.sys);
 });
 await test('旧调用方传A或不传版本仍只走P1B',async()=>{
   for(const p1 of ['A',undefined]){
     const s=api.newState(cfg);s.stage='S40';s.current={task:'Q5',qtype:'MAIN',text:'养宠物吗'};
     const calls=[];
     await api.runTurn({cfg,prompts,p1,stateJson:JSON.stringify(s),trace:[],llm:async(id,pid)=>{calls.push(pid);return JSON.stringify({answer_status:'refused',refused_targets:['Q5'],facts:[],ack:'好，那先不聊这个。'});}},'跳过');
     assert.equal(calls[0],'P1B');assert(!calls.includes('P1'));
   }
 });
 await test('开关关闭不增加调用且清除旧Gate',async()=>{const r=await generate(false,empty);assert.deepEqual(r.calls.map(x=>x.pid),['P6','P7','PC']);assert.equal(r.st.profile.source.expect_ta,'model');assert(!r.st.profile_evidence_runtime);assert.equal(r.calls[0].sys,prompts.P6.sys);});
 await test('成功仅调用一次PE，三栏无证据留空且与事件一致',async()=>{const r=await generate(true,empty);assert.deepEqual(r.calls.map(x=>x.pid),['PE','P6','P7']);for(const k of ['expect_ta','love_style','daily']){assert.equal(r.st.profile[k],'');assert.equal(r.st.profile.section_state[k],'no_evidence');assert.equal(r.st.profile.source[k],'no_evidence');}assert(!('core' in r.st.profile));assert.equal(r.st.stage_card_60.attitude,'原核心不变');assert.equal(r.calls[1].sys,prompts.P6.sys);assert(r.calls[1].user.includes('primary_facts'));const p6Trace=r.trace.find(x=>x.id==='N30');assert.equal(p6Trace.input.用户提示词,'[redacted]');const entry=r.trace.find(x=>x.id==='N29PE');assert.equal(entry.input.用户提示词,'[redacted]');assert.equal(entry.output.redacted,true);});
 for(const [name,pe] of [['429',new Error('429')],['schema',{}],['unknown-id',{...empty,atoms:[{id:'A',source_fact_ids:['F999'],subject:'自己',kind:'daily_life',basis:'explicit',meaning:'电影',quote:'电影'}]}],['timeout',()=>new Promise(()=>{})]])await test(name+'回退文本输入及原组装，仍用正式P6',async()=>{const r=await generate(true,pe);assert.deepEqual(r.calls.map(x=>x.pid),['PE','P6','P7','PC']);assert.equal(r.st.profile.source.expect_ta,'model');assert(!r.st.profile_evidence_runtime);assert.equal(r.calls[1].sys,prompts.P6.sys);assert(!r.calls[1].user.includes('\"primary_facts\":')); });
 await test('有证据但模型类型错误使用generation_error',()=>{const c=clone(cfg);c.profile_evidence.enabled=true;const s=api.newState(c);s.profile_evidence_runtime={status:'ok',levels:{expect_ta:'sufficient',love_style:'limited',daily:'sufficient'}};const r=api.N32(c,JSON.stringify(s),JSON.stringify({expect_ta:{bad:true},love_style:''}),JSON.stringify({daily:true}));const p=JSON.parse(r.new_state).profile;for(const k of ['expect_ta','daily']){assert.equal(p.source[k],'generation_error');assert.equal(p[k],'');}assert.equal(p.source.love_style,'no_evidence');assert.equal(p.love_style,'');});
 await test('N09附加来源，不增加P1B出参',()=>{const s=api.newState(cfg);s.turn=1;s.current={task:'LIFE',qtype:'MAIN',text:'周末怎么过'};const r=api.N09(cfg,JSON.stringify(s),'看电影',JSON.stringify({answer_status:'answered',facts:[{field:'Q1',sub:'items',subject:'自己',value:'看电影',evidence:'看电影'}]}));const f=JSON.parse(r.state).facts[0];assert.equal(f.source_question,'周末怎么过');assert.equal(f.source_qtype,'MAIN');});
 await test('Q12保存可定位原话，PE原话不写回匹配事实',async()=>{const c=clone(cfg);c.profile_evidence.enabled=true;const s=api.newState(c);s.stage='S40';s.turn=10;for(const task of Object.values(s.tasks))Object.assign(task,{a:1,done:1});s.tasks.Q12.a=0;s.tasks.Q12.done=0;s.current={task:'Q12',qtype:'MAIN',text:'还有什么补充'};let input;const r=await api.runTurn({cfg:c,prompts,p1:'B',stateJson:JSON.stringify(s),trace:[],llm:async(id,pid,sys,user)=>{if(pid==='P1B')return JSON.stringify({answer_status:'answered',facts:[],ack:'收到啦～'});if(pid==='PE'){input=user;return JSON.stringify(empty);}return '{}';}},'我希望各自有自己的时间');const st=JSON.parse(r.newState);assert.equal(st.dialog.at(-1).task_id,'Q12');assert.equal(st.dialog.at(-1).answer_status,'answered');assert(input.includes('Q12_RAW_T'));assert(!st.facts.some(f=>String(f.ver).includes('Q12_RAW')));});
 console.log(`${passed} 项证据链路集成检查通过`);
})().catch(e=>{console.error(e);process.exitCode=1});
