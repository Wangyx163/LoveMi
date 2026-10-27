'use strict';
// VM DOM harness: no HTTP/model calls, exercises the shipping UI functions.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../assets/app.js'),'utf8');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/config.json'),'utf8'));
const BusinessEvents=require('../src/business_events.js');
const pending=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function browser({state,connected=true,runTurn,adapter,model,messages=[],storage=new Map()}={}){
  const nodes=new Map(),checks=[],timers=new Map();let timerId=0;
  function matches(node,selector){
    if(selector.startsWith('.'))return node.className.split(' ').includes(selector.slice(1));
    if(selector.startsWith('#'))return node.id===selector.slice(1);
    if(selector==='button[data-action]')return node.tag==='button'&&!!node.dataset.action;
    return node.tag===selector;
  }
  function element(tag='div'){
    const n={tag,className:'',id:'',value:'',textContent:'',dataset:{},children:[],parent:null,hidden:false,disabled:false,listeners:{},style:{setProperty(){}},scrollHeight:100,
      append(...items){for(const item of items){item.parent=this;this.children.push(item);}},
      replaceChildren(...items){this.children=[];this.append(...items);},setAttribute(name,value){this[name]=value;},
      addEventListener(name,listener){this.listeners[name]=listener;},
      querySelectorAll(selector){const all=[];for(const child of this.children){if(matches(child,selector))all.push(child);all.push(...child.querySelectorAll(selector));}return all;},
      querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
      closest(selector){let cursor=this;while(cursor){if(matches(cursor,selector))return cursor;cursor=cursor.parent;}return null;},
      remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);},close(){},showModal(){},scrollIntoView(){}};
    n.classList={add(name){if(!n.className.split(' ').includes(name))n.className=(n.className+' '+name).trim();},toggle(name,on){const parts=n.className.split(' ').filter(Boolean);n.className=parts.filter(p=>p!==name).concat(on?[name]:[]).join(' ');}};
    return n;
  }
  const get=id=>{if(nodes.has(id))return nodes.get(id);for(const n of nodes.values()){const found=n.querySelector('#'+id);if(found)return found;}if(id==='typing')return null;const n=element();n.id=id;nodes.set(id,n);return n;};
  const initialState=state||{v:1,session_id:'s1',stage:'S60',turn:3,progress:20,current:{task:'NEED'},cards:[]};
  const sandbox={console:{warn(){},error(){}},URLSearchParams,AbortController,location:{search:''},
    setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},requestAnimationFrame:fn=>fn(),
    document:{getElementById:get,createElement:element,addEventListener(){}},
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    window:{LoveMiEngine:{BusinessEvents},lovemiBusinessAdapter:adapter,lovemiLocalModel:model},
    fetch:(url,options)=>{assert.equal(url,'/api/status');const d=pending();checks.push({...d,signal:options.signal});return d.promise;},
    runTurn:runTurn||(async(ctx)=>({newState:ctx.stateJson,reply:'收到'})),
    stageInsightText:text=>text.replace(/。/g,''),
    configInput:config,initialState,initialConnected:connected,initialMessages:messages};
  const instrumented=source.replace('  init();',`  config=configInput;promptSet={};stateJson=JSON.stringify(initialState);connected=initialConnected;messages=initialMessages;
    window.probe={messages:()=>messages,busy:()=>busy,render:renderMessage,restore:restoreRoom,sendProfile:showProfileSend};`);
  vm.runInNewContext(instrumented,sandbox);
  return {ui:sandbox.window.lovemiUI,probe:sandbox.window.probe,checks,nodes,get,storage,timers,window:sandbox.window};
}
const allText=node=>[node.textContent,...node.children.map(allText)].join(' ');
const profileState=(profile={})=>({v:1,session_id:'s1',stage:'PROFILE_READY',profile_version:1,facts_revision:2,turn:12,progress:60,profile});
let count=0;
async function check(name,fn){await fn();count++;console.log('PASS '+name);}
async function main(){
  await check('failed generation exposes retry, not a finished or savable profile; refresh retains retry',async()=>{
    const failed={...profileState({daily:'已生成的生活段落'}),stage:'PROFILE_FAILED',profile_version:0,profile_writeback:{reason:'composer_generation_failed'}};
    const b=browser({runTurn:async ctx=>{ctx.trace.push({id:'N32'});return {newState:JSON.stringify(failed),reply:'画像还没有生成完成',events:[]};}});
    await b.ui.send('生成画像');b.probe.restore();
    assert.equal(b.get('chat-footer').hidden,true);assert.equal(b.get('conversation').querySelectorAll('.full-profile').length,0);
    assert.deepEqual(b.get('conversation').querySelectorAll('button[data-action]').map(n=>n.dataset.action),['profile-retry','profile-supplement']);
    const saved=JSON.parse(b.storage.get('lovemi_conversation_v1'));
    const restored=browser({state:JSON.parse(saved.stateJson),messages:saved.messages});restored.probe.restore();
    assert.deepEqual(restored.get('conversation').querySelectorAll('button[data-action]').map(n=>n.dataset.action),['profile-retry','profile-supplement']);
  });
  await check('100% excludes core and empty sections; original two actions remain',()=>{
    const b=browser();b.probe.render({type:'profile',data:{core:'不得再次展示',expect_ta:'',daily:'喜欢听歌',love_style:'',tags:[]}});
    const room=b.get('conversation');assert.equal(room.querySelectorAll('.insight').length,0);
    assert.equal(room.querySelectorAll('.profile-section').length,1);assert.equal(room.querySelector('.profile-section').dataset.section,'daily');
    assert(!allText(room).includes('不得再次展示'));assert.deepEqual(room.querySelectorAll('button[data-action]').map(n=>n.dataset.action),['save','home']);
  });
  await check('status no_evidence/generation_error never renders prose or object placeholders',()=>{
    const b=browser();b.probe.render({type:'profile',data:{expect_ta:'错误内容',daily:{bad:1},love_style:'错误内容',section_state:{expect_ta:'no_evidence',love_style:'generation_error'}}});
    assert.equal(b.get('conversation').querySelectorAll('.profile-section').length,0);
    assert(!allText(b.get('conversation')).includes('[object Object]'));
  });
  await check('empty 60% uses existing stage feedback only, no fabricated tags',()=>{
    const b=browser();b.probe.render({type:'stage-card',data:{attitude:'',stage_feedback:'当前信息还不足以形成画像',tags:[]}});
    const room=b.get('conversation');assert.equal(room.querySelectorAll('.insight').length,0);assert.equal(room.querySelectorAll('.profile-tag').length,0);
    assert(allText(room).includes('当前信息还不足以形成画像'));assert.equal(room.querySelectorAll('button[data-action]').length,2);
  });
  await check('disabled SEND never appears, including restored historical bubbles',()=>{
    const b=browser({state:profileState({daily:'喜欢听歌'})}),before=JSON.stringify(b.ui.getState());
    b.probe.sendProfile();b.probe.restore();b.probe.restore();
    assert.equal(b.probe.messages().filter(m=>m.type==='profile-send').length,0);
    assert.equal(JSON.stringify(b.ui.getState()),before);assert.equal(b.get('chat-footer').hidden,true);
    const saved=JSON.parse(b.storage.get('lovemi_conversation_v1'));
    const restored=browser({state:JSON.parse(saved.stateJson),messages:[...saved.messages,{type:'profile-send',text:'旧结束语'}]});restored.probe.restore();
    assert(!allText(restored.get('conversation')).includes('旧结束语'));
  });
  await check('one whole-profile notice for no evidence; never for model failure or partial content',()=>{
    const empty={expect_ta:'',daily:'',love_style:'',section_state:{expect_ta:'no_evidence',daily:'no_evidence',love_style:'no_evidence'}};
    const b=browser();b.probe.render({type:'profile',data:empty});
    assert.equal(b.get('conversation').querySelectorAll('.profile-empty').length,1);
    assert.equal(b.get('conversation').querySelectorAll('.profile-section').length,0);
    assert(allText(b.get('conversation')).includes(config.profile_empty_message));
    for(const data of [{...empty,section_state:{...empty.section_state,daily:'generation_error'}},{...empty,daily:'看电影',section_state:{...empty.section_state,daily:'generated'}}]){
      const next=browser();next.probe.render({type:'profile',data});assert.equal(next.get('conversation').querySelectorAll('.profile-empty').length,0);
    }
  });
  await check('completed profile cannot consume a text answer to SEND',async()=>{
    let calls=0;const b=browser({state:profileState(),runTurn:async()=>{calls++;}});
    await b.ui.send('我喜欢温柔的人');assert.equal(calls,0);assert.equal(b.ui.getState().turn,12);
  });
  await check('busy locks before async readiness; two clicks issue one turn',async()=>{
    const runs=[];const b=browser({connected:false,runTurn:async(ctx,text)=>{runs.push({ctx,text});return {newState:ctx.stateJson,reply:'收到'};}});
    const first=b.ui.send('第一条'),second=b.ui.send('第二条');assert.equal(b.checks.length,1);assert.equal(b.probe.busy(),true);
    b.checks[0].resolve({ok:true,json:async()=>({ok:true})});await Promise.all([first,second]);assert.equal(runs.length,1);assert(runs[0].ctx.turnId);
  });
  await check('restart discards stale reply/onBubble, starts a new conversation',async()=>{
    const old=pending();let oldCtx;
    const b=browser({runTurn:async(ctx)=>{if(ctx.stateJson){oldCtx=ctx;return old.promise;}return {newState:JSON.stringify({v:1,session_id:'s2',stage:'INTRO',turn:0,progress:0}),reply:'新开场'};}});
    const work=b.ui.send('旧回答');await b.ui.restart();oldCtx.onBubble('旧中间气泡');old.resolve({newState:JSON.stringify(profileState()),reply:'旧回复'});await work;
    assert.equal(b.ui.getState().session_id,'s2');assert.deepEqual(Array.from(b.probe.messages(),m=>m.text),['新开场']);
  });
  await check('restart cancels readiness and old finally cannot unlock the new request',async()=>{
    const fresh=pending();const b=browser({connected:false,runTurn:async()=>fresh.promise});
    const old=b.ui.send('旧回答');const next=b.ui.restart();assert.equal(b.checks[0].signal.aborted,true);
    b.checks[0].resolve({ok:true,json:async()=>({ok:true})});await old;assert.equal(b.probe.busy(),true);
    fresh.resolve({newState:JSON.stringify({v:1,session_id:'s2',stage:'INTRO',turn:0,progress:0}),reply:'新开场'});await next;assert.equal(b.probe.busy(),false);
  });
  await check('restart aborts in-flight model request',async()=>{
    const d=pending();let signal;
    const b=browser({model:(body,s)=>{signal=s;return d.promise;},runTurn:async(ctx)=>{
      if(!ctx.stateJson)return {newState:JSON.stringify({v:1,stage:'INTRO',turn:0,progress:0}),reply:'新开场'};
      await ctx.llm('N04','P1B','system','user','main');return {newState:ctx.stateJson,reply:'旧回复'};
    }});
    const old=b.ui.send('旧回答');await b.ui.restart();assert.equal(signal.aborted,true);d.resolve('{}');await old;assert.equal(b.ui.getState().stage,'INTRO');
  });
  await check('N32 renders 3 sections without SEND; business delivery does not hold UI',async()=>{
    const backend=pending();let delivered=0;
    const state=profileState({expect_ta:'希望温柔',daily:'喜欢摄影',love_style:'希望直接沟通'});
    const event={type:'onProfileReady',session_id:'s1',facts_revision:2,profile_version:1,idempotency_key:'profile1'};
    const b=browser({adapter:{onProfileReady:()=>{delivered++;return backend.promise;}},runTurn:async(ctx)=>{ctx.trace.push({id:'N32'});return {newState:JSON.stringify(state),reply:'文本不应重绘',events:[event]};}});
    await b.ui.send('最后回答');await flush();assert.equal(b.probe.busy(),false);assert.equal(delivered,1);
    assert.equal(b.get('conversation').querySelectorAll('.profile-section').length,3);assert.equal(b.probe.messages().filter(m=>m.type==='profile-send').length,0);
    backend.resolve({accepted:true,profile_version:1,facts_revision:2});await flush();assert.equal(b.ui.getBusinessReceipts()[0].accepted,true);
    await b.ui.retryBusinessEvents();assert.equal(delivered,1);
  });
  await check('unconfigured adapter records failure, later explicit retry is accepted',async()=>{
    const event={type:'onFactsUpdated',session_id:'s1',facts_revision:1,idempotency_key:'facts1'};
    const b=browser({runTurn:async(ctx)=>({newState:ctx.stateJson,reply:'收到',events:[event]})});
    await b.ui.send('回答');await flush();assert.equal(b.ui.getBusinessReceipts()[0].error_code,'not_configured');
    b.window.lovemiBusinessAdapter={onFactsUpdated:async()=>({accepted:true,facts_revision:1})};await b.ui.retryBusinessEvents();
    assert.equal(b.ui.getBusinessReceipts()[0].accepted,true);assert.equal(JSON.parse(b.storage.get('lovemi_conversation_v1')).businessReceipts[0].accepted,true);
  });
  await check('replay response does not duplicate bot/profile bubbles or SEND',async()=>{
    const b=browser({state:profileState(),messages:[{type:'profile-send',profile_key:'s1:1',role:'bot',text:config.profile_send}],
      runTurn:async(ctx)=>({newState:ctx.stateJson,reply:'不应追加',duplicate:true})});
    await b.ui.send(config.buttons.p100[0],{quiet:true});assert.equal(b.probe.messages().length,1);
  });
  await check('SAVE stores canonical visible fields once, never core or fallback prose',async()=>{
    const state=profileState({core:'旧核心',expect_ta:'',daily:'看电影',love_style:''});
    const b=browser({state,runTurn:async(ctx)=>({newState:JSON.stringify({...JSON.parse(ctx.stateJson),saved:true}),reply:'保存'})});
    b.probe.render({type:'profile',data:state.profile});
    const target=b.get('conversation').querySelectorAll('button[data-action]')[0];
    await b.get('conversation').listeners.click({target});
    const saved=JSON.parse(b.storage.get('lovemi_saved_profile_v1'));assert.equal(saved.daily,'看电影');assert.equal(saved.expect_ta,'');assert.equal(saved.core,undefined);
    assert.equal(b.get('toast').textContent,'画像已保存在本机');assert.equal(saved.flow_progress,60);
    b.get('home-profile').onclick();assert.equal(b.get('progress-value').textContent,60);
  });
  console.log(`V2.2 frontend: ${count}/${count} passed (offline; no model/network requests)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
