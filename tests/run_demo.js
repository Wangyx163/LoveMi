// 回放一段完整对话，打印每轮回复和经过的节点：node tests/run_demo.js A （A：完整路径；B：60% 直接生成画像）
const fs=require('fs'),path=require('path');global.performance=require('perf_hooks').performance;
eval(fs.readFileSync(path.join(__dirname,'../src/engine.js'),'utf8'));
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/config.json'),'utf8'));
const prompts=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/prompts.json'),'utf8'));
const sc=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/demo_scripts.json'),'utf8'))[process.argv[2]||'A'];
(async()=>{console.log('=== '+sc.name+'\n');let sj='';
 for(const [ui,stub] of sc.steps){const trace=[];const llm=async(id)=>{const v=stub&&stub[id];return v==null?'{}':(typeof v==='string'?v:JSON.stringify(v));};
   const r=await runTurn({cfg,prompts,llm,trace,stateJson:sj,onBubble:t=>console.log('   〔先发〕'+t)},ui);sj=r.newState;
   console.log('>>> 用户：'+ui);console.log('    节点：'+trace.map(t=>t.id).join(' → '));console.log(r.reply.split('\n').map(x=>'    '+x).join('\n'));console.log();}})();
