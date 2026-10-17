// 运行全部逻辑用例：node tests/run_tests.js（不需要网络、不调用真实模型）
const fs=require('fs'),path=require('path');global.performance=require('perf_hooks').performance;
eval(fs.readFileSync(path.join(__dirname,'../src/engine.js'),'utf8'));
const {CASES}=require('./cases.js');const {runCase}=require('./runner.js');
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/config.json'),'utf8'));
const prompts=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/prompts.json'),'utf8'));
(async()=>{let pass=0,fail=0;
 for(const cs of CASES){const r=await runCase(cs,cfg,prompts,runTurn);const ok=r.results.every(x=>x.pass);ok?pass++:fail++;
   console.log((ok?'✓ ':'✗ ')+cs.cat+' | '+cs.name);if(!ok)r.results.filter(x=>!x.pass).forEach(x=>console.log('     '+x.msg));}
 console.log(`\n${pass} 通过 / ${fail} 失败 / 共 ${CASES.length}`);process.exit(fail?1:0);})();
