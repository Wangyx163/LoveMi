'use strict';
const assert = require('node:assert/strict');
const api = require('../src/business_events');
const clone = x => JSON.parse(JSON.stringify(x));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const initial = () => ({session_id:'s1',turn:1,facts_revision:0,facts:[],tags:{60:[],100:[],mapping_version:'v2'},need_tags:[]});
const fact = (ver, field, sub, subject, value, more={}) => ({ver,field,sub,subject,value,evidence:'用户原话',active:true,status:'已确认',op:'add',...more});
const ready = () => ({...initial(),stage:'PROFILE_READY',progress:60,stage_card_60:{attitude:'原文'},profile:{expect_ta:'希望坦诚',daily:'喜欢电影',love_style:'',section_state:{expect_ta:'generated',daily:'generated',love_style:'no_evidence'}}});

(async () => {
  await test('only committed confirmed facts exported; no state mutation or fabricated defaults', () => {
    const before=initial(), after=initial(); after.facts=[fact(1,'NEED','height','TA','175以上',{strength:'硬性',priority:'core'}),fact(2,'Q1','items','自己','音乐'),fact(3,'Q5','has_pet','自己','养',{active:false}),fact(4,'Q6','style','自己','计划',{status:'候选'})];
    const copy=clone(after), r=api.prepareFactsUpdated(before,after,{taskId:'NEED'});
    assert.deepEqual(after,copy);assert.equal(r.event.changes.length,2);assert.equal(r.state.facts_revision,1);
    assert.equal(r.event.changes[0].strength,'硬性');assert.equal(r.event.changes[0].priority,'core');assert(!('evidence' in r.event.changes[0]));assert(!('strength' in r.event.changes[1]));
    assert(!r.event.current_facts.partner_preferences.some(f=>f.sub==='lifestyle'));assert.equal(r.event.task_id,'NEED');assert.equal(r.event.type,'onFactsUpdated');
  });
  await test('classification follows field and subject despite cross-question collection',()=>{
    const after=initial();after.current={task:'CARD_L1'};after.facts=[fact(1,'NEED','interests','TA','运动'),fact(2,'Q1','items','自己','摄影'),fact(3,'Q8','expectation','关系','互相尊重'),fact(4,'Q4','pace','自己','慢热'),fact(5,'Q11','need','自己','安全感'),fact(6,'SELF','wish','自己','一起旅游'),fact(7,'Q12','supplement','自己','未来想换城市')];
    const s=api.prepareFactsUpdated(initial(),after).event.current_facts;
    assert.equal(s.partner_preferences.length,1);assert.equal(s.self_life.length,1);assert.equal(s.relationship.length,3);assert.equal(s.self_extra.length,1);assert.equal(s.supplement.length,1);
  });
  await test('correction emits deactivation plus replacement; removes derived stale tags',()=>{
    const before=initial();before.facts_revision=6;before.facts=[fact(1,'NEED','smoke','TA','不吸',{strength:'硬性',priority:'core'})];before.tags[100]=[{tag_id:'old',evidence_ver:1}];before.need_tags=['no_smoke'];
    const after=clone(before);after.turn=2;after.facts[0].active=false;after.facts.push(fact(2,'NEED','smoke','TA','偶尔可以',{op:'correct',polarity:'肯定',condition:'聚会时',strength:'偏好'}));after.tags[100]=[{tag_id:'new',evidence_ver:2}];after.need_tags=['occasional'];
    const r=api.prepareFactsUpdated(before,after);assert.deepEqual(r.event.deactivated_fact_versions,[1]);assert.equal(r.event.changes[0].op,'upsert');assert.equal(r.event.changes[0].source_op,'correct');assert.equal(r.event.changes[0].condition,'聚会时');assert.equal(r.event.facts_revision,7);assert.deepEqual(r.event.current_tag_ids,['new']);assert.deepEqual(r.event.current_need_tag_ids,['occasional']);assert.equal(r.event.current_facts.partner_preferences.length,1);
  });
  await test('tag-only replacement emitted; fallback atmosphere excluded; duplicate ids deduped',()=>{
    const before=initial(),after=initial();after.tags[60]=[{tag_id:'same'},{tag_id:'mood',source:'fallback'}];after.tags[100]=[{id:'same'},{tag_id:'fake',fallback:true}];
    const r=api.prepareFactsUpdated(before,after);assert.deepEqual(r.event.changes,[]);assert.deepEqual(r.event.current_tag_ids,['same']);
  });
  await test('unchanged/empty/refused turn produces no fact event; replay state does not increment',()=>{
    assert.equal(api.prepareFactsUpdated(initial(),initial()).event,null);
    const before=initial(),after=initial();after.facts=[fact(1,'Q1','items','自己','音乐')];const a=api.prepareFactsUpdated(before,after);
    assert.equal(api.prepareFactsUpdated(before,a.state).event,null);assert.equal(api.prepareFactsUpdated(a.state,a.state).state.facts_revision,1);
  });
  await test('external evidence optional; original internal evidence preserved',()=>{
    const before=initial(),after=initial();after.facts=[fact(1,'Q1','items','自己','音乐')];const r=api.prepareFactsUpdated(before,after,{includeEvidence:true});assert.equal(r.event.changes[0].evidence,'用户原话');assert.equal(r.state.facts[0].evidence,'用户原话');
  });
  await test('CARD uses recorded stable candidate and card-set ids; never resolves against new cards',()=>{
    const state=initial();state.cards=[{key:'A',id:'new_candidate'}];state.card_set_id='new_set';state.facts=[fact(1,'CARD','l1','候选反馈','A',{card_set_id:'old_set',candidate_ids:['old_candidate']}),fact(2,'CARD','l2','候选反馈','烘焙')];
    const [first,second]=api.currentSnapshot(state).candidate_feedback;assert.equal(first.candidate_id,'old_candidate');assert.equal(first.card_set_id,'old_set');assert.equal(first.candidate_resolution,'resolved');assert.equal(second.candidate_resolution,'unresolved');assert.equal(second.candidate_id,null);
  });
  await test('multiple and zero candidate feedback retain explicit resolution instead of fake ids',()=>{
    const state=initial();state.facts=[fact(1,'CARD','l1','候选反馈','A C',{card_set_id:'set',candidate_ids:['c1','c3']}),fact(2,'CARD','l1','候选反馈','都没感觉',{card_set_id:'set'})];
    const [multi,none]=api.currentSnapshot(state).candidate_feedback;assert.deepEqual(multi.candidate_ids,['c1','c3']);assert.equal(multi.candidate_id,null);assert.equal(none.candidate_resolution,'none_selected');
  });
  await test('direct profile preserves actual progress, only 3 sections, 60% original core and full snapshot',()=>{
    const state=ready();state.facts=[fact(1,'NEED','traits','TA','坦诚')];state.facts_revision=2;const copy=clone(state);const r=api.prepareProfileReady(state);
    assert.deepEqual(state,copy);assert.equal(r.event.core_60,'原文');assert.equal(r.event.flow_progress,60);assert.deepEqual(Object.keys(r.event.profile),['expect_ta','daily','love_style']);assert.equal(r.event.profile.love_style,'');assert.equal(r.event.section_state.love_style,'no_evidence');assert.equal(r.event.profile_version,1);assert.equal(r.event.current_facts.partner_preferences.length,1);assert.equal(r.event.status,'ready');
  });
  await test('N32 repeat same facts revision has one profile version; new facts creates next version',()=>{
    const first=api.prepareProfileReady(ready());const changedText=clone(first.state);changedText.profile.expect_ta='同一证据的另一种文案';assert.equal(api.prepareProfileReady(changedText).event,null);
    changedText.facts_revision++;const second=api.prepareProfileReady(changedText);assert.equal(second.event.profile_version,2);assert.notEqual(first.event.idempotency_key,second.event.idempotency_key);
  });
  await test('no-info and generation failure are empty prose with explicit state, no fallback as facts',()=>{
    const state=ready();state.stage_card_60={};state.profile={expect_ta:'我们还不太了解你',daily:'再试一次',love_style:'',source:{expect_ta:'fixed_insufficient',daily:'fixed_generation_error'}};
    const {event}=api.prepareProfileReady(state);assert.equal(event.core_60,'');assert.deepEqual(event.profile,{expect_ta:'',daily:'',love_style:''});assert.deepEqual(event.section_state,{expect_ta:'no_evidence',daily:'generation_error',love_style:'no_evidence'});
  });
  await test('missing identity and unvalidated profile cannot emit a delivery',()=>{
    const state=initial();delete state.session_id;assert.throws(()=>api.prepareFactsUpdated(state,state),/session_id_required/);assert.throws(()=>api.prepareProfileReady(initial()),/profile_not_ready/);assert.throws(()=>api.prepareFactsUpdated(initial(),initial(),{sessionId:'s2'}),/conflict/);
  });
  await test('unconfigured backend is explicitly not accepted',async()=>{
    const {event}=api.prepareProfileReady(ready());const [r]=await api.createDispatcher().dispatch([event]);assert.equal(r.accepted,false);assert.equal(r.error_code,'not_configured');
  });
  await test('adapter requires explicit accepted and matching version; failed delivery can retry',async()=>{
    const {event}=api.prepareProfileReady(ready());let count=0;const d=api.createDispatcher({onProfileReady:async()=>{count++;if(count===1)throw Error('secret backend details');if(count===2)return{accepted:true,profile_version:99};return{accepted:true,profile_version:1};}});
    const [a]=await d.dispatch([event]);assert.equal(a.error_code,'delivery_failed');const [b]=await d.dispatch([event]);assert.equal(b.error_code,'invalid_acknowledgement');const [c]=await d.dispatch([event]);assert.equal(c.accepted,true);const [again]=await d.dispatch([event]);assert.equal(again.duplicate,true);assert.equal(count,3);
  });
  await test('concurrent same-key requests share one callback; callback mutations never reach source',async()=>{
    const {event}=api.prepareProfileReady(ready());let count=0,release;const barrier=new Promise(r=>release=r);const d=api.createDispatcher({onProfileReady:async e=>{count++;e.profile.daily='mutated';await barrier;return{accepted:true,profile_version:1};}});
    const a=d.dispatch([event]),b=d.dispatch([event]);release();const replies=await Promise.all([a,b]);assert.equal(count,1);assert(replies.every(r=>r[0].accepted));assert.equal(event.profile.daily,'喜欢电影');
  });
  await test('facts callback precedes profile callback and revisions remain independently validated',async()=>{
    const before=initial(),after=ready();after.facts=[fact(1,'Q1','items','自己','音乐')];const f=api.prepareFactsUpdated(before,after),p=api.prepareProfileReady(f.state),order=[];
    const d=api.createDispatcher({onFactsUpdated:async e=>{order.push(e.type);return{accepted:true,facts_revision:e.facts_revision};},onProfileReady:async e=>{order.push(e.type);return{accepted:true,profile_version:e.profile_version,facts_revision:e.facts_revision};}});
    const result=await d.dispatch([f.event,p.event]);assert.deepEqual(order,['onFactsUpdated','onProfileReady']);assert(result.every(r=>r.accepted));
  });
  await test('same-session concurrent deliveries serialize and older profile cannot overwrite accepted newer revision',async()=>{
    const old=api.prepareProfileReady(ready()).event,newer=clone(old);newer.facts_revision=2;newer.profile_version=2;newer.idempotency_key=JSON.stringify(['s1',2]);
    let count=0;const d=api.createDispatcher({onProfileReady:async e=>{count++;return{accepted:true,profile_version:e.profile_version,facts_revision:e.facts_revision};}});
    const [a,b]=await Promise.all([d.dispatch([newer]),d.dispatch([old])]);assert.equal(a[0].accepted,true);assert.equal(b[0].accepted,false);assert.equal(b[0].error_code,'stale_version');assert.equal(count,1);
  });
  console.log(`${passed} V2.2 business event checks passed (offline)`);
})().catch(error=>{console.error(error);process.exitCode=1;});
