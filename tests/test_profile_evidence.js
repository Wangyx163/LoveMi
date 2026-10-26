'use strict';
const assert = require('node:assert/strict');
const { buildMapperInput, validateMapper, classifyEvidence, makeProfileInputs } = require('../src/profile_evidence');
const st = { facts: [
  {ver:1,active:true,status:'已确认',field:'NEED',sub:'traits',subject:'TA',value:'直接沟通',evidence:'希望他有话直说',turn:1,src:'NEED'},
  {ver:2,active:true,status:'已确认',field:'Q4',sub:'pace',subject:'自己',value:'喜欢分享日常',evidence:'我喜欢分享日常',turn:2,src:'Q4'}
], notes: [], stage_card_60: {attitude:'保留原文',content_status:'fallback'}};
const input = buildMapperInput(st);
assert.equal(input.facts.length,2);
const response = {atoms:[
  {id:'A1',source_fact_ids:['F1'],subject:'TA',kind:'partner_preference',basis:'explicit',quote:'希望他有话直说',meaning:'希望伴侣直接沟通'},
  {id:'A2',source_fact_ids:['F2'],subject:'自己',kind:'self_interaction',basis:'explicit',quote:'我喜欢分享日常',meaning:'喜欢分享日常'}
],links:[],routes:{expect_ta:{primary:['A1'],secondary:['A2']}, love_style:{primary:['A2'],secondary:['A1']},p7:{primary:[],secondary:[]}}};
const checked = validateMapper(input,response), levels=classifyEvidence(checked), vars=makeProfileInputs(st,checked,levels);
assert.equal(levels.expect_ta.level,'sufficient');
assert.equal(levels.love_style.level,'limited');
assert.equal(levels.p7.level,'insufficient');
assert.equal(vars.p60_insight,'无'); // current N29 hides fallback from P6 until C06 is decided
const explicitVars=makeProfileInputs(st,checked,levels,{p60_insight:'legacy_sent_core'});
assert.equal(explicitVars.p60_insight,'legacy_sent_core');
assert.throws(()=>validateMapper(input,{...response,atoms:[{...response.atoms[0],quote:'莫须有'},response.atoms[1]]}),/mapper_quote_not_grounded/);
const swapped={...response,routes:{...response.routes,expect_ta:{primary:['A2'],secondary:['A1']}}};
assert.equal(classifyEvidence(validateMapper(input,swapped)).expect_ta.level,'insufficient');
console.log('PASS: source linkage / conservative gate / invalid quote / subject swap / 60% fallback');

// Appearance-only candidate must not become a full-character assumption.
const photoInput = {version:'evidence-v1',facts:[{fact_id:'F7',subject:'候选反馈',quote:'阿远照片帅',raw_answer:'',value:'阿远照片帅',field:'CARD'}]};
const photoOutput={atoms:[{id:'A7',source_fact_ids:['F7'],subject:'候选反馈',kind:'attraction',basis:'explicit',quote:'阿远照片帅',meaning:'评价照片帅'}],links:[],routes:{expect_ta:{primary:['A7'],secondary:[]},love_style:{primary:[],secondary:[]},p7:{primary:[],secondary:[]}}};
const photoLevel=classifyEvidence(validateMapper(photoInput,photoOutput));
assert.equal(photoLevel.expect_ta.level,'limited');
assert.equal(photoLevel.love_style.level,'insufficient');
console.log('PASS: relaxed preference gate / appearance-only limited');

// Q12 original answer is read only when it was answered/partial and task ID is recorded.
const sourceQ12='我希望两个人都有自己的时间。工作日忙的时候不用一直发消息，但真有事还是要愿意说开。';
const q12state={facts:[],notes:[],dialog:[{q:'还有补充吗',a:sourceQ12,task_id:'Q12',turn:10,answer_status:'answered'}]};
const qInput=buildMapperInput(q12state);
assert.equal(qInput.facts.length,1);
assert.equal(qInput.facts[0].fact_id,'Q12_RAW_T10');
assert.equal(qInput.facts[0].raw_answer,sourceQ12);
assert.equal(buildMapperInput(q12state,{includeQ12Raw:false}).facts.length,0);
const qAtom={atoms:[{id:'AQ12',source_fact_ids:['Q12_RAW_T10'],subject:'关系',kind:'relationship_expectation',basis:'explicit',quote:'工作日忙的时候不用一直发消息',meaning:'工作日忙时不必一直发消息',condition:'工作日忙时'}],links:[],routes:{expect_ta:{primary:[],secondary:[]},love_style:{primary:['AQ12'],secondary:[]},p7:{primary:[],secondary:[]}}};
assert.equal(classifyEvidence(validateMapper(qInput,qAtom)).love_style.level,'limited');
const bad={facts:[],notes:[],dialog:[{q:'最后补充',a:sourceQ12,task_id:'Q12',turn:10,answer_status:'refused'}]};
assert.equal(buildMapperInput(bad).facts.length,0);
const old={facts:[],notes:[],dialog:[{q:'最后补充',a:sourceQ12,turn:10,answer_status:'answered'}]};
assert.equal(buildMapperInput(old).facts.length,0); // do not guess task ID by question text
const qa={facts:[{ver:3,active:true,status:'已确认',field:'Q12',sub:'supplement',subject:'关系',value:'希望坦诚沟通',evidence:'愿意说开',turn:10,src:'Q12'}],notes:[],dialog:q12state.dialog};
const qaInput=buildMapperInput(qa);
assert.equal(qaInput.facts.length,1); // attach original to canonical source, no duplicate Q12_RAW
assert.equal(qaInput.facts[0].raw_answer,sourceQ12);
const qLong={facts:[],notes:[],dialog:[{task_id:'Q12',turn:9,answer_status:'partial',a:'日'.repeat(400)}]};
assert.equal(buildMapperInput(qLong).facts[0].raw_answer.length,320);
console.log('PASS: Q12 answer-only / status and task isolation / no duplicate / bounded input');

assert.throws(()=>validateMapper(input,{...response,atoms:[{...response.atoms[0],subject:'自己'},response.atoms[1]]}),/mapper_subject_conflict/);
assert.throws(()=>validateMapper(input,{...response,atoms:[{...response.atoms[0],quote:'。'},response.atoms[1]]}),/mapper_atom_invalid/);
assert.throws(()=>validateMapper(input,{...response,atoms:[{...response.atoms[0],meaning:{}},response.atoms[1]]}),/mapper_atom_invalid/);
assert.equal(checked.atoms[0].source_facts[0].subject,'TA');
const contact={facts:[],notes:[],dialog:[{task_id:'Q12',turn:1,answer_status:'answered',a:'联系手机13812345678，微信 abc123456'}]};
const safe=JSON.stringify(buildMapperInput(contact));assert(!safe.includes('13812345678'));assert(!safe.includes('abc123456'));
console.log('PASS: strict quote / source subject / meaning type / source qualifiers / Q12 masking');

// v1.3: validate against the source that actually contains the quote.
const replaceFirst = patch => ({...response,atoms:[{...response.atoms[0],...patch},response.atoms[1]]});
for (const meaning of ['', '   ', '字'.repeat(161)])
  assert.throws(()=>validateMapper(input,replaceFirst({meaning})),/mapper_atom_invalid/);
const punctuationInput=structuredClone(input);
punctuationInput.facts[0].quote+='。 ～ ✨';
for (const quote of ['。',' ～ ','✨'])
  assert.throws(()=>validateMapper(punctuationInput,replaceFirst({quote})),/mapper_atom_invalid/);
assert.throws(()=>validateMapper(input,replaceFirst({quote:'希望 他有话直说'})),/mapper_quote_not_grounded/);
assert.throws(()=>validateMapper(input,replaceFirst({subject:'自己',source_fact_ids:['F1','F2']})),/mapper_subject_conflict/);
console.log('PASS: punctuation even in source / bounded meaning / exact quote / unrelated source cannot authorize subject');

// Open Q12 answers may contain multiple subjects, including canonical Q12 facts.
const mixed='我周末看电影，希望对方有话直说，两个人各自留些时间';
for (const subject of ['待判','关系']) {
  const source={facts:[{fact_id:'Q',field:'Q12',subject,quote:mixed,raw_answer:mixed}]};
  const output={atoms:[
    {id:'S',source_fact_ids:['Q'],subject:'自己',kind:'daily_life',basis:'explicit',quote:'我周末看电影',meaning:'周末看电影'},
    {id:'T',source_fact_ids:['Q'],subject:'TA',kind:'partner_preference',basis:'explicit',quote:'希望对方有话直说',meaning:'希望对方有话直说'},
    {id:'R',source_fact_ids:['Q'],subject:'关系',kind:'relationship_expectation',basis:'explicit',quote:'两个人各自留些时间',meaning:'双方保留自己的时间'}
  ],links:[],routes:{expect_ta:{primary:['T'],secondary:[]},love_style:{primary:['R'],secondary:[]},p7:{primary:['S'],secondary:[]}}};
  assert.equal(validateMapper(source,output).atoms.length,3);
}
for (const status of ['nothing_to_add','refused','unclear'])
  assert.equal(buildMapperInput({...q12state,dialog:[{...q12state.dialog[0],answer_status:status}]}).facts.length,0);
console.log('PASS: canonical and raw Q12 multiple subjects / excluded statuses');

function gradeDetails(scene, details, links=[], secondary=[]) {
  const atoms=details.map((d,i)=>({id:'D'+i,source_fact_ids:['ONE'],subject:'自己',kind:scene==='p7'?'daily_life':'self_interaction',basis:'explicit',...d}));
  const source={facts:[{fact_id:'ONE',field:'Q4',subject:'自己',quote:atoms.map(a=>a.quote).join('；')}]};
  const routes=Object.fromEntries(['expect_ta','love_style','p7'].map(s=>[s,{primary:[],secondary:[]}]));
  routes[scene]={primary:atoms.map(a=>a.id).filter(id=>!secondary.includes(id)),secondary};
  return classifyEvidence(validateMapper(source,{atoms,routes,links}))[scene].level;
}
assert.equal(gradeDetails('love_style',[
  {quote:'刚认识慢热',meaning:'刚认识时慢热'},
  {quote:'熟了爱分享',meaning:'熟悉后爱分享'},
  {quote:'以前谈恋爱也是这样',meaning:'过去恋爱有同样的相处节奏',kind:'relationship_experience'}
]),'sufficient');
assert.equal(gradeDetails('p7',[
  {quote:'工作日下班跑步',meaning:'工作日下班跑步'},
  {quote:'周末在家学做饭',meaning:'周末学做饭'}
]),'sufficient');
for (const pair of [
  [{quote:'我喜欢分享日常',meaning:'爱分享日常'},{quote:'我喜欢分享日常',meaning:'乐意分享生活',kind:'relationship_experience'}],
  [{quote:'我喜欢分享日常',meaning:'爱分享日常'},{quote:'喜欢分享日常',meaning:'乐意聊聊生活'}],
  [{quote:'我喜欢分享',meaning:'爱分享日常'},{quote:'喜欢分享日常',meaning:'乐意聊聊生活'}]
]) assert.equal(gradeDetails('love_style',pair,[{ids:['D0','D1'],basis:'explicit',relation:'相互说明'}]),'limited');
const linked=[{quote:'我忙时会提前说',meaning:'忙时提前告知'},
  {quote:'最近加班多',meaning:'最近加班较多',kind:'daily_life'}];
assert.equal(gradeDetails('love_style',linked,[{ids:['D0','D1'],basis:'candidate',relation:'可能有关'}],['D1']),'limited');
assert.equal(gradeDetails('love_style',linked,[{ids:['D0','D1'],basis:'explicit',relation:'当前工作忙时的回应方式'}],['D1']),'sufficient');
assert.equal(gradeDetails('love_style',linked,[{ids:['D0','D1'],basis:'explicit',relation:''}],['D1']),'limited');
console.log('PASS: same-source complementary details / duplicate and overlapping splits / candidate link cannot promote');
