'use strict';
// Offline contract tests: model replies are controlled fixtures, never live calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'data/config.json'), 'utf8'));
const evidence = require('../src/profile_evidence');
const api = vm.runInNewContext(fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8') +
  '\n({newState,N25,N29,N32})', {performance, setTimeout, clearTimeout, AbortController});
const clone = value => JSON.parse(JSON.stringify(value));
const fact = (field, sub, subject, value, extra = {}) => ({
  field, sub, subject, value, evidence: value, active: true, status: '已确认', ver: 1, ...extra,
});
const state = facts => Object.assign(api.newState(cfg), {facts: facts || []});
const assemble = (st, rel = {}, life = {}, c = cfg) => {
  const result = api.N32(c, JSON.stringify(st), JSON.stringify(rel), JSON.stringify(life));
  return {result, state: JSON.parse(result.new_state), profile: JSON.parse(result.new_state).profile};
};
const fields = ['expect_ta', 'daily', 'love_style'];
let passed = 0, failed = 0;
function test(name, check) {
  try { check(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}

test('P6 examples output exactly two fields; P7 uses the actual PE input schema', () => {
  const p6 = fs.readFileSync(path.join(root, 'prompts/P6_system.txt'), 'utf8');
  const examples = p6.match(/\{\s*"expect_ta"\s*:[\s\S]*?\n\}/g) || [];
  assert(examples.length >= 4);
  for (const example of examples) assert.deepEqual(Object.keys(JSON.parse(example)), ['expect_ta', 'love_style']);
  assert(p6.includes('不输出 core'));
  const p7 = fs.readFileSync(path.join(root, 'prompts/P7_system.txt'), 'utf8');
  for (const name of ['`life_facts`', '`primary`', '`secondary`', '`level`']) assert(p7.includes(name));
  assert(p7.includes('未分类的开放补充')); assert(p7.includes('提问'));
});

test('P5 alone produces the 60% insight and strips periods', () => {
  const st = state([fact('Q8', 'expectation', '关系', '有想法愿意直接说')]);
  const attitude = '你有种不拧巴的实在，也喜欢明明白白的真诚。';
  const r = api.N25(cfg, JSON.stringify(st), JSON.stringify({attitude, insufficient: false}));
  const card = JSON.parse(r.new_state).stage_card_60;
  assert.equal(card.attitude, attitude.slice(0, -1)); assert.equal(card.content_status, 'ok');
  const assembled = assemble(JSON.parse(r.new_state), {core:'伪造的第二份核心', expect_ta:'希望有话直说', love_style:'你希望遇事能直接聊'});
  assert(!('core' in assembled.profile)); assert(!assembled.result.reply.includes(card.attitude));
  assert.equal(assembled.state.stage_card_60.attitude, card.attitude);
});

test('refusal/unclear/dislike cannot manufacture 60% personality or tags', () => {
  for (const [stat, facts] of [[{refused:3},[]], [{unclear:3},[]], [{},[fact('CARD','l1','候选反馈','都没感觉')]]]) {
    const st = state(facts); st.stat = stat;
    const r = api.N25(cfg, JSON.stringify(st), JSON.stringify({attitude:'你有自己的边界感，也愿意慢慢等待合适的那个人', insufficient:false}));
    const card = JSON.parse(r.new_state).stage_card_60;
    assert.equal(card.attitude, ''); assert.equal(card.content_status, 'no_evidence');
    assert.deepEqual(card.tags, []); assert.equal(card.fallback_group, '');
  }
});

test('P5 malformed output leaves no synthetic insight; valid facts retain real tags only', () => {
  const st = state([fact('Q1','items','自己','摄影')]);
  st.tags = {60:[{tag_id:'real',text:'摄影',cat:'兴趣'},{tag_id:'fake',text:'有主见',cat:'社交情感',kind:'兜底'}]};
  const r = api.N25(cfg, JSON.stringify(st), JSON.stringify({attitude:{text:'bad'}, insufficient:false}));
  const card = JSON.parse(r.new_state).stage_card_60;
  assert.equal(card.attitude,''); assert.equal(card.content_status,'generation_error');
  assert.deepEqual(card.tags.map(t=>t.tag_id),['real']);
});

test('N29 preserves confirmed subject/polarity/condition/strength and only valid P5 core', () => {
  const st = state([fact('NEED','smoke','TA','吸烟',{polarity:'否定',condition:'共同生活时',strength:'硬性'})]);
  st.stage_card_60 = {attitude:'原文',content_status:'ok'};
  const r = api.N29(cfg, JSON.stringify(st));
  for (const part of ['对象:TA','极性:否定','硬性','条件：共同生活时']) assert(r.rel_facts.includes(part));
  assert.equal(r.p60_insight,'原文');
  st.stage_card_60.content_status='no_evidence';
  assert.equal(api.N29(cfg, JSON.stringify(st)).p60_insight,'无');
});

test('N29 passes Q12 raw as unclassified input, without changing confirmed facts', () => {
  const st = state(); st.dialog = [{task_id:'Q12',turn:9,answer_status:'answered',a:'周末会自己做饭',q:'还有补充吗'}];
  const before = JSON.stringify(st), r = api.N29(cfg, before);
  assert.equal(r.state,before); assert.equal(st.facts.length,0);
  assert(r.life_facts.includes('周末会自己做饭')); assert(r.rel_facts.includes('未分类'));
  const raw = evidence.buildMapperInput(st).facts[0];
  assert.equal(raw.source_class,'answered_unstructured_not_confirmed');
  assert.equal(raw.subject,'待判');
});

test('Q12 no-content/refused/missing-task/PII-only inputs are not profile evidence', () => {
  for (const row of [
    {task_id:'Q12',answer_status:'answered',a:'没有'},
    {task_id:'Q12',answer_status:'answered',a:'暂无'},
    {task_id:'Q12',answer_status:'refused',a:'先不聊这个'},
    {answer_status:'answered',a:'周末会做饭'},
    {task_id:'Q12',answer_status:'answered',a:'13812345678'},
  ]) {
    const st = state(); st.dialog=[{turn:10,...row}];
    assert.equal(evidence.buildMapperInput(st).facts.length,0);
    const p = assemble(st,{expect_ta:'伪造期待',love_style:'伪造方式'},{daily:'伪造生活'}).profile;
    for (const key of fields) { assert.equal(p[key],''); assert.equal(p.section_state[key],'no_evidence'); }
  }
});

test('Q12 redaction happens before the length limit and never exposes the phone prefix', () => {
  const st = state(); st.dialog=[{task_id:'Q12',turn:10,answer_status:'answered',a:'日'.repeat(315)+'13812345678'}];
  const raw=evidence.buildMapperInput(st).facts[0].raw_answer;
  assert(!/138/.test(raw)); assert(raw.length <= 320);
});

test('no confirmed evidence blocks model-generated text in every section', () => {
  const p=assemble(state(),{expect_ta:'好相处的人',love_style:'擅长沟通'},{daily:'生活丰富'}).profile;
  for (const key of fields) { assert.equal(p[key],''); assert.equal(p.section_state[key],'no_evidence'); }
  assert.deepEqual(p.tags,[]); assert.equal(p.content_status,'no_evidence');
  assert.equal(p.empty_message,cfg.profile_empty_message);
});

test('life evidence only allows daily; inactive and third-party facts do not unlock relationship sections', () => {
  const st=state([fact('Q1','items','自己','电影'), fact('Q8','expectation','关系','一起聊',{active:false}), fact('NEED','traits','室友','温柔')]);
  const p=assemble(st,{expect_ta:'温柔的人',love_style:'有事聊开'},{daily:'平时喜欢看电影'}).profile;
  assert.equal(p.daily,'平时喜欢看电影'); assert.equal(p.expect_ta,''); assert.equal(p.love_style,'');
});

test('relationship-only evidence leaves daily empty and ignores extra model core', () => {
  const st=state([fact('NEED','traits','TA','直接沟通'),fact('Q8','expectation','关系','遇事说开',{ver:2})]);
  const p=assemble(st,{core:'bad',expect_ta:'希望对方有话直说',love_style:'希望两个人遇事说开'},{daily:'周末宅家'}).profile;
  assert.equal(p.daily,''); assert(!('core' in p)); assert.equal(p.expect_ta,'希望对方有话直说');
});

test('malformed model sections are generation_error; valid sibling sections survive', () => {
  const st=state([fact('NEED','traits','TA','坦诚'),fact('Q8','expectation','关系','互相信任',{ver:2}),fact('Q1','items','自己','电影',{ver:3})]);
  for (const bad of [{},[],null,5,true]) {
    const p=assemble(st,{expect_ta:bad,love_style:'希望两个人互相信任'},{daily:'平时喜欢看电影'}).profile;
    assert.equal(p.expect_ta,''); assert.equal(p.section_state.expect_ta,'generation_error');
    assert.equal(p.love_style,'希望两个人互相信任'); assert.equal(p.section_state.daily,'generated');
    assert.equal(p.empty_message,'');
    assert(!JSON.stringify(p).includes('[object Object]'));
  }
});

test('strict PE levels isolate insufficient sections and distinguish model failure', () => {
  const c=clone(cfg); c.profile_evidence.enabled=true;
  const st=state(); st.profile_evidence_runtime={status:'ok',levels:{expect_ta:'insufficient',daily:'sufficient',love_style:'limited'}};
  const p=assemble(st,{expect_ta:'不得放行',love_style:'希望两个人慢慢熟悉'},{daily:false},c).profile;
  assert.equal(p.expect_ta,''); assert.equal(p.section_state.expect_ta,'no_evidence');
  assert.equal(p.daily,''); assert.equal(p.section_state.daily,'generation_error');
  assert.equal(p.love_style,'希望两个人慢慢熟悉');
});

test('valid classified Q12 supplement survives without a dialog record', () => {
  const st=state([fact('Q12','supplement','自己','周末会做饭',{src:'Q12',turn:10})]);
  const input=api.N29(cfg,JSON.stringify(st)); assert(input.life_facts.includes('周末会做饭'));
  const p=assemble(st,{expect_ta:'',love_style:''},{daily:'周末喜欢自己做饭'}).profile;
  assert.equal(p.daily,'周末喜欢自己做饭'); assert.equal(p.expect_ta,''); assert.equal(p.love_style,'');
});

test('profile writer output stays within one paragraph', () => {
  const st=state([fact('Q1','items','自己','电影')]);
  const p=assemble(st,{expect_ta:'',love_style:''},{daily:'喜欢看电影\n也会重看喜欢的片子'}).profile;
  assert(!/[\r\n]/.test(p.daily)); assert(p.daily.includes('喜欢看电影'));
});

console.log(`${passed} V2.2 profile checks passed, ${failed} failed (offline; semantic quality requires later model evaluation)`);
if (failed) process.exitCode=1;
