'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),cfg=JSON.parse(fs.readFileSync(path.join(root,'data/config.json'),'utf8'));
const api=vm.runInNewContext(fs.readFileSync(path.join(root,'src/engine.js'),'utf8')+'\n({newState,buildTurnReply,N23})',{performance});
let passed=0;const check=(name,fn)=>{fn();passed++;console.log('PASS '+name)};
function state(signal,action='ASK_NEXT'){const s=api.newState(cfg);s.stage='S60';s.plan={action,task:'LIFE',qtype:'MAIN'};s._und={answer_status:'answered',parse_ok:true,turn_signal:signal,ack:'知道啦～',reply_text:'想了解你平时的生活，让画像更贴近你。',feedback_close:'这块还有没聊到的，我先把目前听到的整理一下。'};return s;}
check('normal仅使用ack',()=>assert.equal(api.buildTurnReply(cfg,state('normal')).text,'知道啦～'));
check('user_question回答具体问题，不叠加ack',()=>assert.equal(api.buildTurnReply(cfg,state('user_question')).text,'想了解你平时的生活，让画像更贴近你。'));
check('flow_feedback优先统一reply_text',()=>assert.equal(api.buildTurnReply(cfg,state('flow_feedback')).text,'想了解你平时的生活，让画像更贴近你。'));
check('回补也优先reply_text，不叠加ack',()=>assert.equal(api.buildTurnReply(cfg,state('flow_feedback','FEEDBACK_ASK')).text,'想了解你平时的生活，让画像更贴近你。'));
check('缺失reply_text才兼容旧收束',()=>{const s=state('flow_feedback');delete s._und.reply_text;assert.equal(api.buildTurnReply(cfg,s).text,s._und.feedback_close)});
check('无效回复安全回到ack',()=>{for(const value of ['', '要不要再聊聊？', '字'.repeat(121)]){const s=state('user_question');s._und.reply_text=value;assert.equal(api.buildTurnReply(cfg,s).text,'知道啦～')}});
check('同气泡回复与问题不插入换行',()=>{const s=state('user_question');const r=api.N23(cfg,JSON.stringify(s),'周末通常怎么过呀？');assert(r.reply.includes('想了解你平时的生活，让画像更贴近你。周末通常怎么过呀？'))});
check('Prompt只保留一处意图分类且声明收束字段',()=>{const p=fs.readFileSync(path.join(root,'prompts/P1B_system.txt'),'utf8');assert(!p.includes('普通反问或拒答'));assert(!p.includes('## 对话反馈识别'));assert(p.includes('- feedback_close：旧版兼容字段'));assert(p.includes('仅当 turn_signal=user_question 或 flow_feedback 时生成'))});
console.log(`${passed} 项回复契约检查通过`);
