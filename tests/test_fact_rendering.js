'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'data/config.json'), 'utf8'));
const prompts = JSON.parse(fs.readFileSync(path.join(root, 'data/prompts.json'), 'utf8'));
const api = vm.runInNewContext(
  fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8') +
    '\n({newState,N09,N25,N29,N32,factsText,rowsOf,runTurn});',
  {performance: require('node:perf_hooks').performance}
);

function fact(field, sub, subject, value, extra = {}) {
  return {field, sub, subject, value, evidence: value, active: true, status: '已确认', ...extra};
}

function renderings(st, fields) {
  return [
    ['理解简版', api.factsText(cfg, st, fields, false), false],
    ['阶段画像', api.factsText(cfg, st, fields, true), true],
    ['完整画像', api.rowsOf(cfg, st.facts.filter(f => f.active), [], fields), true]
  ];
}

function factLine(text, key) {
  const lines = text.split(/\r?\n/).filter(line => line.includes(key));
  assert.equal(lines.length, 1, `${key} 应能定位到唯一事实`);
  return lines[0];
}

function assertPolarity(line, polarity) {
  assert(new RegExp('极性\\s*[:：=]?\\s*' + polarity).test(line), `应明确保留极性：${polarity}`);
}

const originalInsight = '你在关系里慢慢靠近，日子里也给自己留点安静。';
const rewrittenInsight = '你更喜欢热闹，遇见喜欢的人就想主动靠近。';
const modelRelationship = {
  core: rewrittenInsight,
  expect_ta: '你希望能和对方好好沟通。',
  love_style: '你愿意有事一起商量。'
};
const modelLife = {daily: '你空闲时喜欢读书。'};

function portraitState() {
  const st = api.newState(cfg);
  st.facts = [
    fact('Q1', 'items', '自己', '读书'),
    fact('Q8', 'expectation', '关系', '好好沟通'),
    fact('Q9', 'strategy', '关系', '一起商量')
  ];
  return st;
}

function assemblePortrait(st) {
  const result = api.N32(cfg, JSON.stringify(st), JSON.stringify(modelRelationship), JSON.stringify(modelLife));
  return {result, profile: JSON.parse(result.new_state).profile};
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('✓ ' + name);
}

(async () => {
  await check('60% 模型与兜底文案均去掉句号，完整画像继承处理后的原文', () => {
    for (const attitude of [originalInsight, originalInsight.replace('。', '.'), '']) {
      const result = api.N25(cfg, JSON.stringify(portraitState()), JSON.stringify({attitude, insufficient: !attitude}));
      const st = JSON.parse(result.new_state);
      const displayed = st.stage_card_60.attitude;
      assert(displayed && !/[。.]/.test(displayed));
      if (attitude) assert.equal(displayed, originalInsight.replace('。', ''));
      assert(result.reply.includes(displayed));
      assert.equal(assemblePortrait(st).profile.core, displayed);
    }
  });

  await check('烟酒均回答“不介意”时，各画像仍能区分具体子项', () => {
    const st = api.newState(cfg);
    st.facts = [
      fact('NEED', 'smoke', 'TA', '不介意'),
      fact('NEED', 'drink', 'TA', '不介意')
    ];
    for (const [name, text] of renderings(st, ['NEED'])) {
      const smoke = factLine(text, 'NEED.smoke');
      const drink = factLine(text, 'NEED.drink');
      assert.notEqual(smoke, drink, `${name} 不能把同值的不同问题渲染成相同事实`);
      for (const line of [smoke, drink]) {
        assert(line.includes('TA'));
        assert(line.includes('不介意'));
      }
    }
  });

  await check('硬性要求和条件不会随事实渲染丢失', () => {
    const st = api.newState(cfg);
    st.facts = [fact('NEED', 'smoke', 'TA', '不吸烟', {
      strength: '硬性', condition: '在一起生活时', evidence: '在一起生活时一定不能抽烟'
    })];
    for (const [name, text, withEvidence] of renderings(st, ['NEED'])) {
      const line = factLine(text, 'NEED.smoke');
      for (const part of ['TA', '不吸烟', '硬性', '在一起生活时']) {
        assert(line.includes(part), `${name} 应保留 ${part}`);
      }
      if (withEvidence) assert(line.includes(st.facts[0].evidence), `${name} 应保留原话`);
    }
  });

  await check('极性缺省为肯定，否定只作标记，不翻转原有“不吸”值', () => {
    const st = api.newState(cfg);
    st.facts = [
      fact('NEED', 'drink', 'TA', '不介意'),
      fact('Q7', 'smoke', '自己', '不吸', {polarity: '否定', evidence: '我不吸烟'})
    ];
    const before = JSON.stringify(st.facts);
    for (const [name, text, withEvidence] of renderings(st, ['NEED', 'Q7'])) {
      assertPolarity(factLine(text, 'NEED.drink'), '肯定');
      const negative = factLine(text, 'Q7.smoke');
      assertPolarity(negative, '否定');
      assert(negative.includes('自己'));
      assert(negative.includes('不吸'), `${name} 不应自行作双重否定改写`);
      if (withEvidence) assert(negative.includes('我不吸烟'));
    }
    assert.equal(JSON.stringify(st.facts), before, '渲染不能改写已确认事实');
  });

  await check('开放字段明确改口后，下游只收到新确认的兴趣', () => {
    const st = api.newState(cfg);
    st.current = {task: 'LIFE', qtype: 'MAIN', text: cfg.tasks.LIFE.core};
    st.facts = [fact('Q1', 'items', '自己', '跑步', {evidence: '我喜欢跑步'})];
    const write = api.N09(cfg, JSON.stringify(st), '现在改成游泳', JSON.stringify({
      answer_status: 'answered',
      facts: [{field: 'Q1', sub: 'items', subject: '自己', value: '游泳', evidence: '现在改成游泳', op: 'correct'}]
    }));
    const next = JSON.parse(write.state);
    assert.equal(JSON.parse(write.rejected).length, 0);
    assert.equal(next.facts.find(f => f.value === '跑步').active, false);
    assert.equal(next.facts.find(f => f.value === '游泳').active, true);
    const profile = api.N29(cfg, write.state);
    for (const text of [profile.life_facts, api.factsText(cfg, next, ['Q1'], true)]) {
      assert(text.includes('游泳'));
      assert(!text.includes('跑步'), '已失效的旧兴趣不能重新进入画像输入');
    }
  });

  await check('实际画像分支把相同的带条件和极性的生活事实传给 P6 与 P7', async () => {
    const st = api.newState(cfg);
    st.stage = 'AWAIT_60';
    st.facts = [fact('Q7', 'drink', '自己', '偶尔', {
      polarity: '肯定', condition: '朋友聚会时', evidence: '朋友聚会时偶尔喝一点'
    })];
    const lifeFacts = api.N29(cfg, JSON.stringify(st)).life_facts;
    const calls = [];
    await api.runTurn({
      cfg, prompts, stateJson: JSON.stringify(st), trace: [],
      llm: async (id, pid, sys, user) => {
        calls.push({pid, user});
        return pid === 'P6'
          ? JSON.stringify({core: '', expect_ta: '', love_style: ''})
          : JSON.stringify({daily: ''});
      }
    }, cfg.buttons.p60[1]);
    assert.deepEqual(calls.map(c => c.pid).sort(), ['P6', 'P7']);
    for (const {pid, user} of calls) {
      assert(user.includes(lifeFacts), `${pid} 应使用相同的生活事实渲染`);
      const line = factLine(user, 'Q7.drink');
      assertPolarity(line, '肯定');
      assert(line.includes('朋友聚会时'));
      assert(line.includes('朋友聚会时偶尔喝一点'));
    }
  });

  await check('完整画像逐字沿用成功的 60% 洞察，P6 改写不会覆盖或误记为兜底', () => {
    const st = portraitState();
    st.stage_card_60 = {attitude: originalInsight, content_status: 'ok', fallback_group: ''};
    const {result, profile} = assemblePortrait(st);
    assert.equal(profile.core, originalInsight);
    assert.notEqual(profile.core, rewrittenInsight);
    assert.equal(profile.source.core, '60%');
    assert.equal(profile.content_status, 'ok', '正常继承阶段洞察不应使完整画像降为兜底');
    assert(!result.fallback_sections.includes('core'));
    assert(result.reply.includes(originalInsight));
    assert(!result.reply.includes(rewrittenInsight));
  });

  await check('60% 已展示的兜底文案同样原样沿用，并保留兜底来源', () => {
    const st = portraitState();
    const displayedFallback = '你的样子正在一点点清晰，剩下的，我们可以慢慢了解。';
    st.stage_card_60 = {attitude: displayedFallback, content_status: 'fallback', fallback_group: 'default'};
    const {result, profile} = assemblePortrait(st);
    assert.equal(profile.core, displayedFallback);
    assert.equal(profile.source.core, 'fallback');
    assert.equal(profile.content_status, 'fallback');
    assert(result.fallback_sections.includes('core'));
  });

  await check('画像输入仍只把成功的 P5 文案作为 p60_insight，兜底沿用由组装层负责', () => {
    const st = portraitState();
    st.stage_card_60 = {attitude: originalInsight, content_status: 'ok'};
    assert.equal(api.N29(cfg, JSON.stringify(st)).p60_insight, originalInsight);
    st.stage_card_60.content_status = 'fallback';
    assert.equal(api.N29(cfg, JSON.stringify(st)).p60_insight, '无');
    assert.equal(st.stage_card_60.attitude, originalInsight, '输入筛选不应删除已展示的文案');
  });

  await check('没有 60% 文案时忽略 P6 的 core，使用已有配置兜底', () => {
    for (const withFacts of [true, false]) {
      for (const card of [undefined, {attitude: '', content_status: 'ok'}]) {
        const st = withFacts ? portraitState() : api.newState(cfg);
        if (card) st.stage_card_60 = card;
        const {result, profile} = assemblePortrait(st);
        const configured = cfg.fallback_groups.default[withFacts ? 'core_some' : 'core'];
        assert(configured.includes(profile.core), '应采用已有的中性或缺少信息兜底');
        assert.notEqual(profile.core, rewrittenInsight, '无阶段文案也不能改用 P6 重写的 core');
        assert.equal(profile.source.core, 'fallback');
        assert.equal(profile.content_status, 'fallback');
        assert(result.fallback_sections.includes('core'));
      }
    }
  });

  await check('两条真实画像链路保留阶段文案或已有兜底，且只调用 P6/P7', async () => {
    for (const route of ['direct', 'completed']) {
      for (const status of ['ok', 'fallback', 'missing']) {
        const st = portraitState();
        if (status !== 'missing') {
          st.stage_card_60 = {
            attitude: originalInsight, content_status: status,
            fallback_group: status === 'fallback' ? 'default' : ''
          };
        }
        let input;
        if (route === 'direct') {
          st.stage = 'AWAIT_60';
          input = cfg.buttons.p60[1];
        } else {
          st.stage = 'S40';
          for (const tid of [...cfg.order.S60, ...cfg.order.S40]) {
            if (tid !== 'Q12') Object.assign(st.tasks[tid], {a: 1, done: 1});
          }
          st.current = {task: 'Q12', qtype: 'MAIN', text: cfg.tasks.Q12.core};
          input = '没有其他补充';
        }
        const calls = [];
        const result = await api.runTurn({
          cfg, prompts, stateJson: JSON.stringify(st), trace: [],
          llm: async (id, pid) => {
            calls.push(pid);
            return JSON.stringify(pid === 'P6' ? modelRelationship : modelLife);
          }
        }, input);
        const profile = JSON.parse(result.newState).profile;
        assert.deepEqual(calls.sort(), ['P6', 'P7'], `${route}/${status} 不应追加 P5 或其他模型调用`);
        if (status === 'missing') {
          assert(cfg.fallback_groups.default.core_some.includes(profile.core));
        } else {
          assert.equal(profile.core, originalInsight, `${route}/${status} 应逐字沿用已展示文案`);
          assert(result.reply.includes(originalInsight));
        }
        assert.equal(profile.source.core, status === 'ok' ? '60%' : 'fallback');
        assert.equal(profile.content_status, status === 'ok' ? 'ok' : 'fallback');
        assert(!result.reply.includes(rewrittenInsight));
      }
    }
  });

  console.log(`\n${passed} 项事实渲染与阶段洞察回归通过`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
