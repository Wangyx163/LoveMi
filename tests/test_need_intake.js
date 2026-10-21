'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'data/config.json'), 'utf8'));
const prompts = JSON.parse(fs.readFileSync(path.join(root, 'data/prompts.json'), 'utf8'));
const api = vm.runInNewContext(
  fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8') +
    '\n({newState,N02,N09,N11,N23,runTurn});',
  {performance: require('node:perf_hooks').performance}
);

const clone = value => JSON.parse(JSON.stringify(value));
function config(enabled = true) {
  const cfg = clone(baseConfig);
  cfg.need_intake = {
    enabled, max_questions: 2,
    questions: {
      height: '对另一半的身高，你有什么偏好吗？没有限制也可以说～',
      lifestyle: '你希望另一半平时怎么过日子呀？没有偏好也可以说～'
    },
    wait_reply: '出卡前还需要明确{missing}；不限也可以直接告诉我。你想继续时再补充就好。'
  };
  cfg.fields.NEED.subs.lifestyle = {type: 'open'};
  return cfg;
}
function fact(sub, value, extra = {}) {
  return {
    field: 'NEED', sub, subject: 'TA', value, evidence: value,
    active: true, status: '已确认', src: 'NEED', strength: '偏好', ...extra
  };
}
function needState(cfg, facts = []) {
  const st = api.newState(cfg);
  st.current = {task: 'NEED', qtype: 'MAIN', text: cfg.tasks.NEED.core};
  st.history.push({...st.current});
  st.facts = clone(facts);
  st._und = {answer_status: 'answered', parse_ok: true, facts: [], ack: '嗯，知道啦～'};
  return st;
}
function write(cfg, st, input, und = {}) {
  return api.N09(cfg, JSON.stringify(st), input, JSON.stringify({
    answer_status: 'answered', facts: [], ack: '嗯，知道啦～', ...und
  }));
}
function route(cfg, st, input = '继续', und) {
  const written = und ? write(cfg, st, input, und).state : JSON.stringify(st);
  return api.N11(cfg, written, input, '{}');
}
function submitted(cfg, routed) {
  return JSON.parse(api.N23(cfg, routed.state, routed.candidate_q).new_state);
}
function assertClarify(result, target) {
  assert.equal(result.route, 'READY');
  assert.equal(result.action, 'NEED_CLARIFY');
  const st = JSON.parse(result.state);
  assert.equal(st.plan.task, 'NEED');
  assert.equal(st.plan.qtype, 'NEED_CLARIFY');
  assert.equal(st.plan.intake_target, target);
  assert.equal(st.need_intake.ready, false);
  assert.equal(result.q_task_spec || '', '', '门槛补问不能追加 P3 调用');
}
function assertWaiting(result) {
  assert.equal(result.route, 'READY');
  assert.equal(result.action, 'NEED_WAIT');
  assert.equal(JSON.parse(result.state).plan.action, 'NEED_WAIT');
  assert.equal(result.q_task_spec || '', '', '等待补充不能追加 P3 调用');
}

let passed = 0;
async function check(name, run) {
  await run();
  passed++;
  console.log('✓ ' + name);
}

(async () => {
  await check('实际默认配置开启出卡门槛并提供生活方式字段与两类问句', () => {
    assert.equal(baseConfig.need_intake?.enabled, true);
    assert.equal(baseConfig.need_intake.max_questions, 2);
    assert.equal(baseConfig.fields.NEED.subs.lifestyle?.type, 'open');
    for (const target of ['height', 'lifestyle']) {
      assert.equal(typeof baseConfig.need_intake.questions[target], 'string');
      assert(baseConfig.need_intake.questions[target].trim());
    }
    assert(baseConfig.need_intake.wait_reply.includes('{missing}'));
  });

  await check('首答同时给出 TA 身高与生活方式，可直接进入出卡', () => {
    const cfg = config(), input = '希望身高180以上，最好爱运动';
    const result = route(cfg, needState(cfg), input, {facts: [
      fact('height', '180以上', {evidence: '身高180以上'}),
      fact('interests', '运动', {evidence: '最好爱运动'})
    ]});
    assert.equal(result.route, 'CARDS');
    assert.equal(JSON.parse(result.state).need_intake.ready, true);
  });

  await check('仅有一类时只补问缺少的一类，N23 保存目标及真实问句', () => {
    const cfg = config();
    for (const [facts, missing] of [
      [[fact('height', '180以上')], 'lifestyle'],
      [[fact('interests', '运动')], 'height']
    ]) {
      const result = route(cfg, needState(cfg, facts));
      assertClarify(result, missing);
      assert.equal(result.candidate_q, cfg.need_intake.questions[missing]);
      const next = submitted(cfg, result);
      assert.equal(next.current.task, 'NEED');
      assert.equal(next.current.qtype, 'NEED_CLARIFY');
      assert.equal(next.current.intake_target, missing);
      assert.equal(next.current.text, cfg.need_intake.questions[missing]);
    }
  });

  await check('本人信息、性格及其他条件不能冒充 TA 生活方式', () => {
    const cfg = config();
    for (const wrong of [
      fact('items', '运动', {field: 'Q1', subject: '自己'}),
      fact('traits', '温柔'), fact('other', '有车'),
      fact('lifestyle', '运动', {subject: '自己'})
    ]) {
      assertClarify(route(cfg, needState(cfg, [fact('height', '180以上'), wrong])), 'lifestyle');
    }
  });

  await check('兴趣、烟酒、宠物及生活方式要求均能作为 TA 生活维度', () => {
    const cfg = config();
    for (const [sub, value] of [
      ['interests', '运动'], ['smoke', '不吸烟'], ['drink', '少喝'],
      ['pet', '不养宠物'], ['lifestyle', '作息规律']
    ]) {
      assert.equal(route(cfg, needState(cfg, [fact('height', '不限'), fact(sub, value)])).route, 'CARDS', sub);
    }
  });

  await check('两类明确不限算已表达，无信息和说不清均不算不限', () => {
    const cfg = config();
    const yes = route(cfg, needState(cfg), '身高不限，生活方式也不限', {facts: [
      fact('height', '不限', {evidence: '身高不限'}),
      fact('lifestyle', '不限', {evidence: '生活方式也不限'})
    ]});
    assert.equal(yes.route, 'CARDS');
    const no = route(cfg, needState(cfg), '还没想好', {answer_status: 'unclear', facts: []});
    assertClarify(no, 'height');
    assert.equal(JSON.parse(no.state).facts.length, 0);
  });

  await check('缺两类按身高到生活方式顺序，每类最多自动问一次', () => {
    const cfg = config();
    const first = route(cfg, needState(cfg), '还没想好', {answer_status: 'unclear'});
    assertClarify(first, 'height');
    const second = route(cfg, submitted(cfg, first), '还没想好', {answer_status: 'unclear'});
    assertClarify(second, 'lifestyle');
    const afterSecond = submitted(cfg, second);
    const waiting = route(cfg, afterSecond, '也没想好', {answer_status: 'unclear'});
    assertWaiting(waiting);
    assert(waiting.candidate_q.includes('身高'));
    assert(waiting.candidate_q.includes('生活方式'));
    assert(!waiting.candidate_q.includes('{missing}'));
    const saved = submitted(cfg, waiting);
    assert.equal(saved.current.text, waiting.candidate_q, '下一轮必须按实际展示的待补充范围理解用户');
    assert.equal(saved.current.qtype, 'NEED_CLARIFY');
    assert.deepEqual(saved.current.intake_targets, ['height', 'lifestyle']);
    assert.equal(saved.current.intake_target, undefined);
    assert.equal(new Set(saved.need_intake.asked).size, 2);
    const again = route(cfg, saved, '还是没想好', {answer_status: 'unclear'});
    assertWaiting(again);
    assert.equal(new Set(JSON.parse(again.state).need_intake.asked).size, 2);
  });

  await check('单项目标拒答不伪装不限，不再强问这一类', () => {
    const cfg = config();
    const asked = route(cfg, needState(cfg));
    const next = route(cfg, submitted(cfg, asked), '身高不想说', {answer_status: 'refused'});
    assertClarify(next, 'lifestyle');
    const st = JSON.parse(next.state);
    assert.equal(st.need_intake.responses.height.status, 'refused');
    assert.equal(st.facts.some(f => f.sub === 'height'), false);
    const waiting = route(cfg, submitted(cfg, next), '生活方式也不想说', {answer_status: 'refused'});
    assertWaiting(waiting);
    const after = submitted(cfg, waiting);
    assert.equal(after.need_intake.responses.lifestyle.status, 'refused');
    assert.equal(after.need_intake.ready, false);
  });

  await check('一轮可拒答一项并确认另一项，不把整段状态套到两类', () => {
    const cfg = config();
    const result = route(cfg, needState(cfg), '身高不想说，但希望对方作息规律', {
      answer_status: 'partial',
      facts: [fact('lifestyle', '作息规律', {evidence: '希望对方作息规律'})],
      need_responses: [{target: 'height', status: 'refused', evidence: '身高不想说'}]
    });
    assertWaiting(result);
    const st = JSON.parse(result.state);
    assert.equal(st.need_intake.responses.height.status, 'refused');
    assert(st.facts.some(f => f.active && f.sub === 'lifestyle'));
    assert.deepEqual(st.need_intake.missing, ['height']);
  });

  await check('初始拒答有明确单项范围时，不将全句 refused 扩到另一项', () => {
    const cfg = config();
    const result = route(cfg, needState(cfg), '身高不想说', {
      answer_status: 'refused',
      need_responses: [{target: 'height', status: 'refused', evidence: '身高不想说'}]
    });
    assertClarify(result, 'lifestyle');
    const st = JSON.parse(result.state);
    assert.equal(st.need_intake.responses.height.status, 'refused');
    assert.equal(st.need_intake.responses.lifestyle, undefined);
    assert.equal(st.need_intake.known.height, false);
    assert.equal(st.need_intake.known.lifestyle, false);
  });

  await check('单项补问反问重发后仍保存目标，随后拒答只作用于身高', () => {
    const cfg = config();
    const first = route(cfg, needState(cfg));
    assertClarify(first, 'height');
    const asked = submitted(cfg, first);
    const repeated = route(cfg, asked, '为什么要问身高呀', {answer_status: 'asks_back'});
    assert.equal(repeated.action, 'REASK');
    const saved = submitted(cfg, repeated);
    assert.equal(saved.current.task, 'NEED');
    assert.equal(saved.current.qtype, 'NEED_CLARIFY');
    assert.equal(saved.current.intake_target, 'height');
    assert.equal(saved.current.text, cfg.need_intake.questions.height);
    const result = route(cfg, saved, '那身高先不想说', {answer_status: 'refused'});
    assertClarify(result, 'lifestyle');
    const st = JSON.parse(result.state);
    assert.equal(st.need_intake.responses.height.status, 'refused');
    assert.equal(st.need_intake.responses.lifestyle, undefined);
  });

  await check('拒答或等待后主动补齐仍能出卡，旧拒答不阻止新事实', () => {
    const cfg = config();
    const first = route(cfg, needState(cfg));
    const second = route(cfg, submitted(cfg, first), '暂时不想说', {answer_status: 'refused'});
    const waiting = route(cfg, submitted(cfg, second), '也还没想好', {answer_status: 'unclear'});
    assertWaiting(waiting);
    const result = route(cfg, submitted(cfg, waiting), '身高不限，希望对方不吸烟', {facts: [
      fact('height', '不限', {evidence: '身高不限'}),
      fact('smoke', '不吸烟', {evidence: '希望对方不吸烟'})
    ]});
    assert.equal(result.route, 'CARDS');
    assert.equal(JSON.parse(result.state).need_intake.ready, true);
  });

  await check('失效、未确认事实及同子项有效冲突不能通过门槛', () => {
    const cfg = config();
    for (const invalid of [
      fact('height', '180以上', {active: false}),
      fact('height', '180以上', {status: '待确认'})
    ]) {
      assertClarify(route(cfg, needState(cfg, [invalid, fact('lifestyle', '规律作息')])), 'height');
    }
    const conflict = needState(cfg, [fact('height', '180以上'), fact('lifestyle', '规律作息')]);
    conflict.notes = [{field: 'NEED', sub: 'height', subject: 'TA', active: true, evidence: '前后矛盾', note: '身高尚未确认'}];
    assertClarify(route(cfg, conflict), 'height');
    conflict.notes[0].active = false;
    assert.equal(route(cfg, conflict).route, 'CARDS');
  });

  await check('未通过 N09 的事实和模型自由 ready 标志均不能放行', () => {
    const cfg = config();
    const result = route(cfg, needState(cfg), '我也不知道', {
      ready: true, need_intake: {ready: true},
      facts: [fact('height', '不限', {evidence: '不存在的原话'}), fact('lifestyle', '不限', {evidence: '另一段不存在的原话'})]
    });
    assertClarify(result, 'height');
    assert.equal(JSON.parse(result.state).facts.length, 0);
  });

  await check('负状态记录仅接受合法目标、拒答或不确定及本轮原话', () => {
    const cfg = config(), st = needState(cfg);
    const result = write(cfg, st, '身高还没想好', {need_responses: [
      {target: 'height', status: 'unclear', evidence: '身高还没想好'},
      {target: 'lifestyle', status: 'refused', evidence: '并不存在'},
      {target: 'traits', status: 'refused', evidence: '身高还没想好'},
      {target: 'lifestyle', status: 'unrestricted', evidence: '身高还没想好'}
    ]});
    const saved = JSON.parse(result.state).need_intake;
    assert.equal(saved.responses.height.status, 'unclear');
    assert.equal(Object.hasOwn(saved.responses, 'lifestyle'), false);
    assert.equal(Object.hasOwn(saved.responses, 'traits'), false);
  });

  await check('身高不限替代旧身高条件，生活方式不限清理整组旧约束', () => {
    const cfg = config();
    const st = needState(cfg, [
      fact('height', '180以上'), fact('height', '175以上'), fact('traits', '温柔'),
      fact('lifestyle', '作息规律'), fact('interests', '运动'),
      fact('smoke', '不吸烟'), fact('drink', '少喝'), fact('pet', '不养宠物')
    ]);
    const result = write(cfg, st, '身高不限，生活方式也不限', {facts: [
      fact('height', '不限', {evidence: '身高不限'}),
      fact('lifestyle', '不限', {evidence: '生活方式也不限'})
    ]});
    const active = JSON.parse(result.state).facts.filter(f => f.active);
    assert.deepEqual(active.filter(f => f.sub === 'height').map(f => f.value), ['不限']);
    assert.deepEqual(active.filter(f => ['lifestyle', 'interests', 'smoke', 'drink', 'pet'].includes(f.sub)).map(f => [f.sub, f.value]), [['lifestyle', '不限']]);
    assert(active.some(f => f.sub === 'traits' && f.value === '温柔'), '不能跨组清除性格偏好');
  });

  await check('新具体生活要求使旧生活方式不限失效，保留其他具体条件', () => {
    const cfg = config();
    const st = needState(cfg, [fact('height', '不限'), fact('lifestyle', '不限')]);
    const first = write(cfg, st, '还是希望对方不吸烟', {facts: [fact('smoke', '不吸烟', {evidence: '希望对方不吸烟'})]});
    const saved = JSON.parse(first.state);
    assert.equal(saved.facts.find(f => f.sub === 'lifestyle' && f.value === '不限').active, false);
    const second = write(cfg, saved, '也喜欢运动', {facts: [fact('interests', '运动', {evidence: '喜欢运动'})]});
    const active = JSON.parse(second.state).facts.filter(f => f.active);
    assert(active.some(f => f.sub === 'height' && f.value === '不限'));
    assert(active.some(f => f.sub === 'smoke' && f.value === '不吸烟'));
    assert(active.some(f => f.sub === 'interests' && f.value === '运动'));
  });

  await check('新具体身高偏好替代旧身高不限，其他需求保持有效', () => {
    const cfg = config();
    const st = needState(cfg, [fact('height', '不限'), fact('smoke', '不吸烟', {strength: '硬性'})]);
    const result = write(cfg, st, '还是希望180以上', {
      facts: [fact('height', '180以上', {evidence: '希望180以上'})]
    });
    const active = JSON.parse(result.state).facts.filter(f => f.active);
    assert.deepEqual(active.filter(f => f.sub === 'height').map(f => f.value), ['180以上']);
    assert(active.some(f => f.sub === 'smoke' && f.value === '不吸烟' && f.strength === '硬性'));
  });

  await check('有条件或否定的不限不能撤销全局旧硬条件', () => {
    const cfg = config();
    for (const extra of [{condition: '仅考虑短期相处时'}, {polarity: '否定'}]) {
      const st = needState(cfg, [fact('height', '180以上', {strength: '硬性'}), fact('smoke', '不吸烟', {strength: '硬性'})]);
      const input = '仅考虑短期相处时身高不限，生活方式不限；否则并不是不限';
      const result = write(cfg, st, input, {facts: [
        fact('height', '不限', {...extra, evidence: input}),
        fact('lifestyle', '不限', {...extra, evidence: input})
      ]});
      const saved = JSON.parse(result.state);
      assert(saved.facts.some(f => f.active && f.sub === 'height' && f.value === '180以上' && f.strength === '硬性'));
      assert(saved.facts.some(f => f.active && f.sub === 'smoke' && f.value === '不吸烟' && f.strength === '硬性'));
    }
  });

  await check('仅有带条件或否定的不限，不作为全局无限制通过门槛', () => {
    const cfg = config();
    for (const extra of [{condition: '仅考虑短期相处时'}, {polarity: '否定'}]) {
      for (const missing of ['height', 'lifestyle']) {
        const known = missing === 'height' ? fact('smoke', '不吸烟') : fact('height', '180以上');
        const facts = [known, fact(missing, '不限', extra)];
        assertClarify(route(cfg, needState(cfg, facts)), missing);
      }
    }
  });

  await check('N02 给本次 P1B 传入实际门槛和当前待补问目标', () => {
    const cfg = config();
    const first = route(cfg, needState(cfg, [fact('height', '180以上')]));
    const st = submitted(cfg, first);
    const entry = api.N02(cfg, JSON.stringify(st), '希望他喜欢运动');
    assert.equal(entry.branch, 'ANSWER');
    const spec = JSON.parse(entry.cur_task_slim);
    assert.deepEqual(spec.intake_targets, ['lifestyle']);
    assert.equal(spec.need_intake.ready, false);
    assert.deepEqual(spec.need_intake.missing, ['lifestyle']);
    assert.equal(entry.cur_q, cfg.need_intake.questions.lifestyle);
  });

  await check('人物卡主问与两轮追问传入同一父目标及已问历史', () => {
    const cfg = config();
    let stableFollowupGoal;
    for (const tid of ['CARD_L1', 'CARD_F1', 'CARD_F2']) {
      const st = api.newState(cfg);
      const qtype = tid === 'CARD_L1' ? 'MAIN' : 'CARD_FOLLOWUP';
      st.current = {task: tid, qtype, text: '对人物介绍有什么看法呀？'};
      const asked = ['在一起时，你会想和阿遥做些什么？', '你提到的温柔，具体是什么样呢？'];
      st.history = [
        {task: 'CARD_L1', qtype: 'MAIN', text: '这三个人里你喜欢谁？'},
        {task: 'CARD_F1', qtype: 'CARD_FOLLOWUP', text: asked[0]},
        {task: 'LIFE', qtype: 'FOLLOW_UP', text: '自己周末通常打什么球？'},
        {task: 'CARD_F2', qtype: 'CARD_FOLLOWUP', text: asked[1]}
      ];
      const entry = api.N02(cfg, JSON.stringify(st), '我想和他一起听歌');
      assert.equal(entry.branch, 'ANSWER');
      const spec = JSON.parse(entry.cur_task_slim);
      assert.equal(spec.task_id, tid);
      assert.equal(spec.parent_task_id, 'CARD_L1');
      assert.equal(spec.goal, cfg.tasks.CARD_L1.goal);
      assert.equal(typeof spec.followup_goal, 'string');
      assert(spec.followup_goal.trim());
      if (stableFollowupGoal) assert.equal(spec.followup_goal, stableFollowupGoal);
      stableFollowupGoal = spec.followup_goal;
      assert.deepEqual(spec.asked_followups, asked);
      assert(!spec.asked_followups.includes('自己周末通常打什么球？'));
    }
  });

  await check('关闭门槛保留原出卡流程，不要求新字段', () => {
    const cfg = config(false);
    const result = route(cfg, needState(cfg, [fact('traits', '温柔')]));
    assert.equal(result.route, 'CARDS');
  });

  await check('实际补问到出卡每次只调用一个 P1B，不追加映射或 P3', async () => {
    const cfg = config();
    const calls = [], trace = [];
    const responses = [
      {answer_status: 'answered', facts: [fact('traits', '温柔', {evidence: '希望温柔'})]},
      {answer_status: 'answered', facts: [fact('height', '不限', {evidence: '身高不限'})]},
      {answer_status: 'answered', facts: [fact('interests', '运动', {evidence: '希望对方爱运动'})]}
    ];
    let stateJson = JSON.stringify(needState(cfg));
    for (const [index, input] of ['希望温柔', '身高不限', '希望对方爱运动'].entries()) {
      const before = calls.length;
      const result = await api.runTurn({
        cfg, prompts, p1: 'B', stateJson, trace,
        llm: async (id, pid) => {
          calls.push({id, pid});
          return JSON.stringify({...responses[index], ack: '嗯，知道啦～'});
        }
      }, input);
      assert.equal(calls.length - before, 1, input + ' 不应新增模型调用');
      assert.equal(calls.at(-1).pid, 'P1B');
      stateJson = result.newState;
      const st = JSON.parse(stateJson);
      assert.equal(st.current.task, index < 2 ? 'NEED' : 'CARD_L1');
    }
    assert.equal(calls.length, 3);
    assert.equal(trace.some(step => ['N14', 'N17'].includes(step.id)), false);
    assert.equal(JSON.parse(stateJson).need_intake.ready, true);
  });

  console.log(`\n${passed} 项人物卡前信息门槛回归通过`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
