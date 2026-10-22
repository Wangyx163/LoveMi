#!/usr/bin/env node
'use strict';
// 历史一次性迁移脚本：当前实现已集成到 src/engine.js。
// 禁止重新应用，避免历史模板覆盖已确认的回复契约。
console.error('此迁移脚本已停用，请使用 src/engine.js；同步运行版本请执行 node scripts/sync-runtime.js。');
process.exit(1);
/**
 * LoveMi P1B 多意图 / 历史话题回补 / 画像前承接：就地修改工具
 * 对应 Wangyx163/LoveMi 的 src/engine.js（v1.9.11 结构）。
 * 使用：将本文件放在项目根目录，执行 node apply_lovemi_flow_fix.js
 * 不修改 Prompt、data/config.json，也不会连接 GitHub。
 * 应用前运行配套回归测试；已集成时校验后退出，--check 只检查。
 * 自动备份 engine.js，失败则不写入。新版手工修改不会被旧版补丁覆盖。
 */
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const vm = require('node:vm');

const root = __dirname;
const enginePath = path.join(root, 'src', 'engine.js');
if (!fs.existsSync(enginePath)) {
  console.error('没有找到 src/engine.js。请把脚本放在 LoveMi 项目根目录后运行。');
  process.exit(1);
}
const original = fs.readFileSync(enginePath, 'utf8');
let s = original.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
function verifySource(source) {
  new vm.Script(source, {filename:'src/engine.js'});
  const testPath = path.join(root, 'test_lovemi_flow_fix.js');
  if (!fs.existsSync(testPath)) throw Error('缺少配套 test_lovemi_flow_fix.js，无法验证补丁，未写入。');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovemi-flow-'));
  const candidate = path.join(dir, 'engine.js');
  try {
    fs.writeFileSync(candidate, source, 'utf8');
    execFileSync(process.execPath, [testPath, '--engine', candidate], {
      cwd: root, encoding: 'utf8', timeout: 30000,
    });
  } catch (error) {
    throw Error('流程回归失败：\n' + (error.stderr || error.message));
  } finally {
    // 只移除本次创建的单个临时文件及空目录，不做递归删除。
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    fs.rmdirSync(dir);
  }
}
let operations = [];
function replaceOnce(before, after, id) {
  const a = s.indexOf(before);
  if (a < 0) throw Error(`${id}: 没有找到预期代码。可能是项目版本不同或本地已有修改。未写入文件。`);
  if (s.indexOf(before, a + before.length) >= 0) throw Error(`${id}: 命中多处，停止以避免误改。`);
  s = s.slice(0,a) + after + s.slice(a+before.length);
  operations.push(id);
}
function replaceBetween(start,end,body,id){
 const i=s.indexOf(start),j=i<0?-1:s.indexOf(end,i+start.length);
 if(i<0||j<0)throw Error(`${id}: 预期上下文不存在，未写入。`);
 if(s.indexOf(start,i+start.length)>=0)throw Error(`${id}: 目标不唯一，未写入。`);
 s=s.slice(0,i)+body+s.slice(j);
 operations.push(id);
}
try {
  if (s.includes('function buildTurnReply(') || s.includes('LOVEMI_FLOW_FEEDBACK_FIX_20261022')) {
    verifySource(s);
    console.log('流程修改已集成，语法与定向回归通过；未重复写入或备份。');
    process.exit(0);
  }
  if (process.argv.includes('--check')) throw Error('尚未集成流程修改；--check 不写入文件。');
  // 1. N02: 提供只读任务索引；由 cfg.tasks 自动生成，避免新增配置表。
  replaceOnce(
    '/* ---------- N02 ---------- */\nfunction N02(',
    `/* ---------- N02 ---------- */
function buildTaskLookup(cfg, st) {
  return [...new Set([...cfg.order.S60, ...cfg.order.S40])]
    .filter(id => cfg.tasks[id]?.kind === 'main')
    .map(id => ({
      task_id: id,
      stage: cfg.tasks[id].stage,
      theme: cfg.tasks[id].theme,
      goal: cfg.tasks[id].goal,
      asked: st.history.some(h=>h.task===id)
    }));
}
function N02(`,
    'N02.task_lookup helper'
  );
  replaceOnce(
    "  let hint='{}';",
    "  curSpec.task_lookup=buildTaskLookup(cfg,st);\n  let hint='{}';",
    'N02.attach lookup'
  );

  // 2. Q12 必须走 P1B/N09/N11，不能在入口直接触发画像。
  replaceBetween(
    "  } else if(st.stage==='S40'&&st.current&&st.current.task==='Q12'){",
    "  } else if(['S60','S40'].includes(st.stage)&&st.current){",
    '', 'N02.remove Q12 bypass'
  );

  // 3. N09: 跨题事实的已有校验保持不变，追加候选回复/目标任务校验。
  replaceOnce(
    "    followup:und.followup||{},card_followup:und.card_followup||{},ack:String(und.ack||''),next_question_draft:und.next_question_draft||'',parse_ok:Object.keys(und).length>0,prefilter:und.prefilter||''};",
    `    followup:und.followup||{},card_followup:und.card_followup||{},ack:String(und.ack||''),next_question_draft:und.next_question_draft||'',parse_ok:Object.keys(und).length>0,prefilter:und.prefilter||'',
    turn_signal:['normal','user_question','flow_feedback'].includes(und.turn_signal)?und.turn_signal:'normal',
    reference_task:und.turn_signal==='flow_feedback'&&typeof und.reference_task==='string'&&cfg.tasks[und.reference_task]?.kind==='main'?und.reference_task:null,
    reply_text:['user_question','flow_feedback'].includes(und.turn_signal)?String(und.reply_text||'').replace(/[\\r\\n]+/g,' ').trim():'',
    feedback_close:und.turn_signal==='flow_feedback'?String(und.feedback_close||'').replace(/[\\r\\n]+/g,' ').trim():''};`,
    'N09.pass intent'
  );

  // 原 Q12 原文保存能力迁移至 N09。注意只给普通明确补充兜底，
  // 用户反问、拒答、没有补充、模型已提取 Q12 时均不原样落库。
  replaceOnce(
    "  const a=statusOk.includes(und.answer_status)?und.answer_status:'unclear';",
    `  // Q12 开放文本兼容：优先使用上方已校验的 Q12.supplement，绝不将纯反问/拒答视为事实。
  if(st.current?.task==='Q12' &&
     (!und.turn_signal||und.turn_signal==='normal') &&
     und.answer_status==='answered' &&
     !written.some(x=>x.field==='Q12') &&
     !(und.facts||[]).some(x=>x.field==='Q12') &&
     !prefilter(cfg,ui,'Q12') &&
     !PII.test(ui) &&
     !cfg.blocked.compliance.some(w=>ui.includes(w)) &&
     !/^(?:没(?:有|什么)?(?:其他|别的|更多|补充)?|没什么(?:其他|别的)?(?:要|想)?补充的?|没有(?:其他|别的)?(?:要|想)?补充的?|暂时没有|不用了)[了啦呀吧哦～~。！!\\s]*$/.test(String(ui).trim())){
    const raw=String(ui).trim().slice(0,inputLimit(cfg,'Q12'));
    if(raw){st.fv+=1;
      const rec={field:'Q12',sub:'supplement',subject:'自己',value:raw,evidence:raw,
        src:'Q12',status:'已确认',active:true,turn:st.turn,ver:st.fv,raw:true};
      st.facts.push(rec);written.push(rec);
    }
  }
  const a=statusOk.includes(und.answer_status)?und.answer_status:'unclear';`,
    'N09.Q12 safe fallback'
  );

  // 4. N11: 有独立的用户反问与返回旧话题意图；跳过由此引发的额外提问。
  replaceOnce(
    "  st.stat=st.stat||{};st.stat[status]=(st.stat[status]||0)+1;if(tid==='NEED')st.need_status=status;",
    `  const isUserQuestion=und.turn_signal==='user_question'&&status!=='risk';
  const isFlowFeedback=und.turn_signal==='flow_feedback'&&status!=='risk';
  const suppressExtra=isUserQuestion||isFlowFeedback;
  st.stat=st.stat||{};st.stat[status]=(st.stat[status]||0)+1;if(tid==='NEED')st.need_status=status;`,
    'N11.intent flags'
  );

  replaceOnce(
    "  if(status==='asks_back'){",
    `  if(suppressExtra&&['asks_back','off_topic'].includes(status))status='skipped';
  if(status==='asks_back'&&!suppressExtra){`,
    'N11.feedback & asks_back'
  );
  replaceOnce(
    "  st.asked=st.asked||{};st.asked[stage]=(st.asked[stage]||0)+1;",
    '', 'N11.defer pace count'
  );
  replaceOnce(
    "  if(qtype==='MAIN'||qtype==='REPLACE'||qtype==='NEED_CLARIFY'){",
    `  const target=isFlowFeedback?und.reference_task:null,task=target&&cfg.tasks[target],ts=target&&T[target];
  const canBackfill=!!(task&&ts&&target!==tid&&target!=='CARD_L1'&&
    task.stage===stage&&task.kind==='main'&&ts.a===1&&
    st.history.some(h=>h.task===target)&&!ts.covered&&!ts.refused&&
    !(cfg.no_replace_tasks||[]).includes(target)&&
    ts.rep<lim.replace_per_task&&budgetLeft(cfg,st,stage)>0);
  const deferCurrent=canBackfill&&status==='skipped';
  st.asked=st.asked||{};if(!deferCurrent)st.asked[stage]=(st.asked[stage]||0)+1;
  if(!deferCurrent&&['MAIN','REPLACE','NEED_CLARIFY'].includes(qtype)){`,
    'N11.validate feedback target'
  );
  replaceOnce("else if(qtype==='FOLLOW_UP')T[tid].h=1;", "else if(!deferCurrent&&qtype==='FOLLOW_UP')T[tid].h=1;", 'N11.defer followup');
  replaceOnce("else if(qtype==='CARD_FOLLOWUP')T[tid].done=1;", "else if(!deferCurrent&&qtype==='CARD_FOLLOWUP')T[tid].done=1;", 'N11.defer card');
  replaceOnce(
    "  let action=null,pTask=null,pQ=null,cand='';",
    `  if(canBackfill){
    ts.rep+=1;st.used[stage].R+=1;
    st.pending=st.pending.filter(x=>x.task!==target);
    st.plan={action:'FEEDBACK_ASK',task:target,qtype:'REPLACE'};
    st.progress=progressOf(cfg,st);
    return {state:S(st),action:'FEEDBACK_ASK',route:'QGEN',candidate_q:'',
      q_task_spec:S(leadSpec(cfg,st,target)),rel_facts_text:'',life_facts_text:'',
      debug:'用户反馈回补 '+target+'；消耗本阶段 R 额度 1'};
  }
  let action=null,pTask=null,pQ=null,cand='';`,
    'N11.feedback after current answer'
  );
  replaceOnce("if(action==='SHOW_60'){route=", "if(action==='SHOW_60'){st.plan={action};route=", 'N11.clear stage plan');
  replaceOnce("if(action==='GENERATE_PROFILE'){route=", "if(action==='GENERATE_PROFILE'){st.plan={action};route=", 'N11.clear profile plan');

  replaceOnce(
    "    if(!(cfg.no_replace_tasks||[]).includes(tid)&&!T[tid].covered",
    "    if(!suppressExtra&&!(cfg.no_replace_tasks||[]).includes(tid)&&!T[tid].covered",
    'N11.no auto pending'
  );
  replaceOnce(
    "const can=cf.needed&&!l3&&!dup",
    "const can=!suppressExtra&&cf.needed&&!l3&&!dup",
    'N11.no card followup'
  );
  replaceOnce(
    "    if(!(cfg.no_followup_tasks||[]).includes(tid)&&T[tid].covered",
    "    if(!suppressExtra&&!(cfg.no_followup_tasks||[]).includes(tid)&&T[tid].covered",
    'N11.no normal followup'
  );
  replaceOnce(
    "  if(action===null){const rep=st.pending.find(x=>x.since>=1);",
    "  if(action===null&&!suppressExtra){const rep=st.pending.find(x=>x.since>=1);",
    'N11.no delayed replace'
  );
  replaceOnce(
    "const sup=atTrigger?pickSupplement(cfg,st,stage):null;",
    "const sup=!suppressExtra&&atTrigger?pickSupplement(cfg,st,stage):null;",
    'N11.no extra supplement'
  );

  // 5. N23: 单次读取回复状态，避免 careLine 被消费两次。
  replaceOnce(
    'function N23(cfg,stateStr,q){const st=JSON.parse(stateStr);q=replyQuestion(cfg,st.plan||{},q);',
    `function buildTurnReply(cfg,st){
  const selected=selectAck(cfg,st); // 只调用一次，careLine 有状态变更
  if(selected.care||st.plan?.action==='FEEDBACK_ASK')return selected;
  const und=st._und||{};
  if(und.parse_ok===false)return selected;
  if(['user_question','flow_feedback'].includes(und.turn_signal)){
    const candidates=[und.reply_text];
    if(und.turn_signal==='flow_feedback')candidates.push(und.feedback_close);
    for(const candidate of candidates){
    const txt=String(candidate||'').replace(/[\\r\\n]+/g,' ').trim();
    if(txt&&[...txt].length<=120&&!/[？?]/.test(txt)&&
      !cfg.blocked.compliance.some(w=>txt.includes(w))){
      return {text:txt,care:false};
    }
    }
  }
  return selected;
}
function N23(cfg,stateStr,q){const st=JSON.parse(stateStr);q=replyQuestion(cfg,st.plan||{},q);`,
    'N23.shared reply builder'
  );
  replaceOnce('const ack=selectAck(cfg,st).text;', 'const ack=buildTurnReply(cfg,st).text;', 'N36.use shared builder');
  replaceOnce(
    '  const selected=selectAck(cfg,st),ack=selected.text;',
    '  const selected=buildTurnReply(cfg,st),ack=selected.text;',
    'N23.use shared builder'
  );

  // 6. runTurn: 在最终结果生成前发送本轮回复，使用已有 onBubble 而非再次提问。
  replaceOnce(
    "  const finish=(id,r,s)=>{agg('N33','本轮输出',{来源:id});reply=r;newState=s;};",
    `  const finish=(id,r,s)=>{agg('N33','本轮输出',{来源:id});reply=r;newState=s;};
  const prepareStageReply=stateStr=>{
    const st=JSON.parse(stateStr),sel=buildTurnReply(cfg,st);
    if(sel.text){step('N23a','输出：本轮承接','out',null,{text:sel.text});ctx.onBubble?.(sel.text);}
    st._new=[];
    return {state:S(st),reply:sel.text||''};
  };`,
    'runTurn.stage reply helper'
  );
  replaceOnce(
    "      else if(r11.route==='SHOW_60'){step('N24a','输出：60% 阶段消息','out',null,{text:cfg.p60_bubble});",
    "      else if(r11.route==='SHOW_60'){const staged=prepareStageReply(r11.state);step('N24a','输出：60% 阶段消息','out',null,{text:cfg.p60_bubble});",
    'runTurn.60% pre-reply'
  );
  replaceOnce(
    "const r25=code('N25','组装 60% 阶段卡',()=>N25(cfg,r11.state,o),{llm_out:o});finish('N25',r25.reply,r25.new_state);handled=true;}",
    "const r25=code('N25','组装 60% 阶段卡',()=>N25(cfg,staged.state,o),{llm_out:o});finish('N25',(!ctx.onBubble&&staged.reply?staged.reply+'\\n\\n':'')+r25.reply,r25.new_state);handled=true;}",
    'runTurn.60% state & fallback'
  );
  replaceOnce(
    "      else if(r11.route==='GENERATE_PROFILE'){await profile(r11.state,false);handled=true;}",
    "      else if(r11.route==='GENERATE_PROFILE'){const staged=prepareStageReply(r11.state);await profile(staged.state,false);if(!ctx.onBubble&&staged.reply)reply=staged.reply+'\\n\\n'+reply;handled=true;}",
    'runTurn.100% pre-reply'
  );

  // 独立校验修改后的 JavaScript 语法，任一修改失败都不覆盖原文件。
  verifySource(s);
  const backup = enginePath + '.before-flow-feedback-' + crypto.createHash('sha256').update(original).digest('hex').slice(0,10) + '.bak';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, {encoding:'utf8',flag:'wx'});
  s += '\n/* LOVEMI_FLOW_FEEDBACK_FIX_20261022 */\n';
  const output = (original.startsWith('\uFEFF')?'\uFEFF':'') + (original.includes('\r\n')?s.replace(/\n/g,'\r\n'):s);
  if (fs.readFileSync(enginePath, 'utf8') !== original) throw Error('校验期间 engine.js 被其他程序修改，已停止写入。');
  fs.writeFileSync(enginePath, output, 'utf8');
  console.log(`已更新 ${enginePath}`);
  console.log(`已备份 ${backup}`);
  console.log(`已完成 ${operations.length} 项代码替换：\n - ${operations.join('\n - ')}`);
  console.log('请执行 npm run sync && npm test 校验现有测试。');
} catch (err) {
  console.error('修改已取消：'+err.message);
  if (s !== original) console.error('源文件没有被覆盖。');
  process.exitCode = 1;
}
