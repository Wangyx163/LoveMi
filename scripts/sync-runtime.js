'use strict';

// Expand the small shared behavior block once at build time. Model requests keep
// using the same compiled JSON interface and make no additional model calls.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const PIDS=['P1B','P3','P5','P6','P7'];
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8').replace(/\r\n/g,'\n');
const replaceRequired=(text,pattern,replacement,label)=>{
  if(!pattern.test(text))throw Error('Missing runtime marker: '+label);
  return text.replace(pattern,()=>replacement);
};

function compileRuntime(){
  const shared=read('prompts/shared_behavior.txt').trimEnd();
  if(!shared||shared.includes('{{'))throw Error('Shared behavior must be static text');
  const prompts=JSON.parse(read('data/prompts.json'));
  for(const pid of PIDS){
    const template=read('prompts/'+pid+'_system.txt').trimEnd();
    if((template.match(/\{\{shared_behavior\}\}/g)||[]).length!==1)throw Error(pid+' must reference shared behavior once');
    prompts[pid].sys=template.replace('{{shared_behavior}}',shared);
    prompts[pid].user=read('prompts/'+pid+'_user.txt').trimEnd();
  }
  const cfg=JSON.parse(read('data/config.json'));
  const htmlFile='LoveMi_在线测试版_v1.9.html';
  let html=read(htmlFile);
  const start=html.indexOf('/* ===== LoveMi Coze Demo 引擎');
  const end=html.indexOf('/* ===== 特殊场景测试用例',start);
  if(start<0||end<=start)throw Error('Missing embedded engine markers');
  html=html.slice(0,start)+read('src/engine.js').trimEnd()+'\n\n'+html.slice(end);
  const casesStart=html.indexOf('/* ===== 特殊场景测试用例');
  const casesEnd=html.indexOf('async function runCase(',casesStart);
  if(casesStart<0||casesEnd<=casesStart)throw Error('Missing embedded test case markers');
  html=html.slice(0,casesStart)+read('tests/cases.js').trimEnd()+'\n\n'+html.slice(casesEnd);
  const runnerStart=html.indexOf('async function runCase(',casesStart);
  const runnerEnd=html.indexOf('const DEFAULT_CONFIG =',runnerStart);
  if(runnerStart<0||runnerEnd<=runnerStart)throw Error('Missing embedded test runner markers');
  html=html.slice(0,runnerStart)+read('tests/runner.js').trimEnd()+'\n\n'+html.slice(runnerEnd);
  html=replaceRequired(html,/^const DEFAULT_PROMPTS = .*;$/m,'const DEFAULT_PROMPTS = '+JSON.stringify(prompts)+';','prompt defaults');
  html=replaceRequired(html,/^const DEFAULT_CONFIG = .*;$/m,'const DEFAULT_CONFIG = '+JSON.stringify(cfg)+';','config defaults');
  const intakeRevision='intake-'+crypto.createHash('sha256').update(JSON.stringify([cfg.need_intake,cfg.fields.NEED.subs.lifestyle,cfg.tasks.CARD_L1.goal,cfg.stage_rules.NEED,cfg.stage_rules.CARD])).digest('hex').slice(0,12);
  const intakeCacheBlock=`/* ===== NEED intake config cache ===== */
const NEED_INTAKE_REVISION='${intakeRevision}';
if(LS.get('lm_need_intake_revision')!==NEED_INTAKE_REVISION){
  cfg.need_intake=clone(DEFAULT_CONFIG.need_intake);
  cfg.fields.NEED.subs.lifestyle=clone(DEFAULT_CONFIG.fields.NEED.subs.lifestyle);
  cfg.tasks.NEED.min_info=clone(DEFAULT_CONFIG.tasks.NEED.min_info);
  cfg.tasks.CARD_L1.goal=DEFAULT_CONFIG.tasks.CARD_L1.goal;
  for(const key of ['NEED','CARD'])cfg.stage_rules[key]=DEFAULT_CONFIG.stage_rules[key];
  LS.set('lm_cfg_v10',JSON.stringify(cfg));
  LS.set('lm_need_intake_revision',NEED_INTAKE_REVISION);
}
/* ===== End NEED intake config cache ===== */`;
  const intakeCached=/\/\* ===== NEED intake config cache ===== \*\/[\s\S]*?\/\* ===== End NEED intake config cache ===== \*\//;
  if(intakeCached.test(html))html=html.replace(intakeCached,()=>intakeCacheBlock);
  else html=replaceRequired(html,/^let cfg=.*$/m,html.match(/^let cfg=.*$/m)?.[0]+'\n'+intakeCacheBlock,'intake config cache insertion');
  // Migrate only the prompt set owned by these source templates. Existing stage
  // rules, question configuration, the legacy P1 and other local edits persist.
  const revision='shared-'+crypto.createHash('sha256').update(JSON.stringify(PIDS.map(pid=>prompts[pid]))).digest('hex').slice(0,12);
  const cacheBlock=`/* ===== Shared behavior prompt cache ===== */
const SHARED_BEHAVIOR_REVISION='${revision}';
if(LS.get('lm_shared_behavior_revision')!==SHARED_BEHAVIOR_REVISION){
  for(const pid of ${JSON.stringify(PIDS)})prompts[pid]=clone(DEFAULT_PROMPTS[pid]);
  LS.set('lm_prompts_v19_v11',JSON.stringify(prompts));
  LS.set('lm_shared_behavior_revision',SHARED_BEHAVIOR_REVISION);
}
/* ===== End shared behavior prompt cache ===== */`;
  const cached=/\/\* ===== Shared behavior prompt cache ===== \*\/[\s\S]*?\/\* ===== End shared behavior prompt cache ===== \*\//;
  if(cached.test(html))html=html.replace(cached,()=>cacheBlock);
  else html=replaceRequired(html,/^let p1v='B'.*$/m,cacheBlock+'\n'+html.match(/^let p1v='B'.*$/m)?.[0],'prompt cache insertion');
  return {prompts,html,htmlFile,revision};
}

function syncRuntime({check=false}={}){
  const result=compileRuntime();
  const json=JSON.stringify(result.prompts,null,2)+'\n';
  const currentPrompts=read('data/prompts.json');
  const currentHtml=read(result.htmlFile);
  if(check){
    if(currentPrompts!==json||currentHtml!==result.html)throw Error('Runtime defaults are stale; run npm run sync');
  }else{
    fs.writeFileSync(path.join(ROOT,'data/prompts.json'),json);
    fs.writeFileSync(path.join(ROOT,result.htmlFile),result.html);
  }
  return {check,revision:result.revision,prompts:PIDS};
}

if(require.main===module){
  try{console.log(JSON.stringify(syncRuntime({check:process.argv.includes('--check')})));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={compileRuntime,syncRuntime};
