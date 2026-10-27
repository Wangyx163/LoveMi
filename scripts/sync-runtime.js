'use strict';

// Expand the small shared behavior block once at build time. Model requests keep
// using the same compiled JSON interface and make no additional model calls.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const PIDS=['P1B','P3','P5','P6','P7'];
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8').replace(/\r\n/g,'\n');
const MAPPING_MODULES=[['PROFILE_MAPPER','ProfileFieldMapper','src/profile_mapper.js'],['PROFILE_CONTENT','ProfileContentComposer','src/profile_content_composer.js']];
const embeddedModule=([marker,name,file])=>`/* ${marker}_START (generated from ${file}) */\nconst ${name} = (() => { const module = {exports:{}};\n${read(file)}\nreturn module.exports; })();\n/* ${marker}_END */`;
function mappingBundle(){
  return {config:JSON.parse(read('config/profile_mapping.json')),
    taxonomy:JSON.parse(read('data/platform_interest_tags.json')).map(({id,name})=>({id,name})),
    interestAliases:JSON.parse(read('data/interest_aliases.json'))};
}
const replaceRequired=(text,pattern,replacement,label)=>{
  if(!pattern.test(text))throw Error('Missing runtime marker: '+label);
  return text.replace(pattern,()=>replacement);
};

function compileRuntime({pids=PIDS}={}){
  if(!Array.isArray(pids)||!pids.length||pids.some(pid=>!PIDS.includes(pid)))throw Error('Invalid prompt selection');
  const embedded='/* PROFILE_EVIDENCE_START (generated from src/profile_evidence.js) */\nconst ProfileEvidence = (() => { const module = {exports:{}};\n'+read('src/profile_evidence.js')+'\nreturn module.exports; })();\n/* PROFILE_EVIDENCE_END */';
  if(!read('src/engine.js').startsWith(embedded))throw Error('Evidence module differs from embedded engine; synchronize explicitly');
  const businessBlock='/* BUSINESS_EVENTS_START (generated from src/business_events.js) */\nconst BusinessEvents = (() => { const module = {exports:{}};\n'+read('src/business_events.js')+'\nreturn module.exports; })();\n/* BUSINESS_EVENTS_END */';
  if(!read('src/engine.js').includes(businessBlock))throw Error('Business events module differs from embedded engine; synchronize explicitly');
  for(const spec of MAPPING_MODULES)if(!read('src/engine.js').includes(embeddedModule(spec)))throw Error('Profile mapping module differs from embedded engine');
  const shared=read('prompts/shared_behavior.txt').trimEnd();
  if(!shared||shared.includes('{{'))throw Error('Shared behavior must be static text');
  const prompts=JSON.parse(read('data/prompts.json'));
  delete prompts.P1;
  delete prompts.P6E;
  for(const pid of pids){
    const template=read('prompts/'+pid+'_system.txt').trimEnd();
    if((template.match(/\{\{shared_behavior\}\}/g)||[]).length!==1)throw Error(pid+' must reference shared behavior once');
    prompts[pid].sys=template.replace('{{shared_behavior}}',shared);
    prompts[pid].user=read('prompts/'+pid+'_user.txt').trimEnd();
  }
  prompts.PE={sys:read('prompts/PE_system.txt').trimEnd(),user:read('prompts/PE_user.txt').trimEnd()};
  prompts.PC={sys:read('prompts/PC_system.txt').trimEnd(),user:read('prompts/PC_user.txt').trimEnd()};
  const cfg=JSON.parse(read('data/config.json'));
  if(JSON.stringify(cfg.profile_mapping)!==JSON.stringify(mappingBundle()))throw Error('Profile mapping bundle differs from source');
  const htmlFile='LoveMi_在线测试版_v1.9.html';
  let html=read(htmlFile);
  if(!/^const PNAMES=.*\bPC:/m.test(html))html=replaceRequired(html,/^const PNAMES=\{/m,"const PNAMES={PC:'【回写】故事压缩与原话话题选择 · 单次调用',",'composer prompt editor');
  let start=html.indexOf('/* ===== LoveMi Coze Demo 引擎');
  const evidenceStart=html.indexOf('/* PROFILE_EVIDENCE_START');
  if(evidenceStart>=0 && evidenceStart<start)start=evidenceStart;
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
  const ownedKeys=['version','intro','intro_ack','weights','no_reask_tasks','no_replace_tasks','no_followup_tasks','need_intake','q7_followup','profile_send','profile_send_enabled','profile_empty_message','model_fail_reply','p60_bubble','profile_bubble','rec_text','profile_writeback','profile_mapping'];
  const ownedTasks=['NEED','CARD_L1','LIFE','REL','Q5','Q7','Q6','Q9','Q10','Q12','SUP1','SUP2','SUP3','SUP4'];
  const taskCopyKeys=['script','fallback','core','core_by_missing'];
  const flowRevision='v22-'+crypto.createHash('sha256').update(JSON.stringify([ownedKeys.map(k=>cfg[k]),ownedTasks.map(k=>taskCopyKeys.map(field=>cfg.tasks[k][field]))])).digest('hex').slice(0,12);
  const flowCacheBlock=`/* ===== V22 flow config cache ===== */
const V22_FLOW_REVISION='${flowRevision}';
if(LS.get('lm_v22_flow_revision')!==V22_FLOW_REVISION){
  for(const key of ${JSON.stringify(ownedKeys)})if(DEFAULT_CONFIG[key]!==undefined)cfg[key]=clone(DEFAULT_CONFIG[key]);
  for(const task of ${JSON.stringify(ownedTasks)})for(const field of ${JSON.stringify(taskCopyKeys)})if(DEFAULT_CONFIG.tasks[task][field]!==undefined)cfg.tasks[task][field]=clone(DEFAULT_CONFIG.tasks[task][field]);
  LS.set('lm_cfg_v10',JSON.stringify(cfg));
  LS.set('lm_v22_flow_revision',V22_FLOW_REVISION);
}
/* ===== End V22 flow config cache ===== */`;
  const flowCached=/\/\* ===== V22 flow config cache ===== \*\/[\s\S]*?\/\* ===== End V22 flow config cache ===== \*\//;
  if(flowCached.test(html))html=html.replace(flowCached,()=>flowCacheBlock);
  else html=html.replace('/* ===== End NEED intake config cache ===== */','/* ===== End NEED intake config cache ===== */\n'+flowCacheBlock);
  const profileCacheBlock=`/* ===== Profile mapping field cache ===== */
for(const [field,extension] of Object.entries(DEFAULT_CONFIG.profile_mapping.config.facts_extensions)){
  Object.assign(cfg.fields[field].subs,clone(extension.subs));
}
cfg.timeouts.PC=DEFAULT_CONFIG.timeouts.PC;
LS.set('lm_cfg_v10',JSON.stringify(cfg));
/* ===== End profile mapping field cache ===== */`;
  const profileCached=/\/\* ===== Profile mapping field cache ===== \*\/[\s\S]*?\/\* ===== End profile mapping field cache ===== \*\//;
  if(profileCached.test(html))html=html.replace(profileCached,()=>profileCacheBlock);
  else html=html.replace('/* ===== End V22 flow config cache ===== */','/* ===== End V22 flow config cache ===== */\n'+profileCacheBlock);
  // Migrate only the prompt set owned by these source templates. Existing stage
  // rules, question configuration and unrelated local edits persist.
  const revision='shared-'+crypto.createHash('sha256').update(JSON.stringify([...PIDS,'PE','PC'].map(pid=>prompts[pid]))).digest('hex').slice(0,12);
  const cacheBlock=`/* ===== Shared behavior prompt cache ===== */
const SHARED_BEHAVIOR_REVISION='${revision}';
if(LS.get('lm_shared_behavior_revision')!==SHARED_BEHAVIOR_REVISION){
  delete prompts.P1;
  delete prompts.P6E;
  for(const pid of ${JSON.stringify([...PIDS,'PE','PC'])})prompts[pid]=clone(DEFAULT_PROMPTS[pid]);
  LS.set('lm_prompts_v19_v11',JSON.stringify(prompts));
  LS.set('lm_shared_behavior_revision',SHARED_BEHAVIOR_REVISION);
}
/* ===== End shared behavior prompt cache ===== */`;
  const cached=/\/\* ===== Shared behavior prompt cache ===== \*\/[\s\S]*?\/\* ===== End shared behavior prompt cache ===== \*\//;
  if(cached.test(html))html=html.replace(cached,()=>cacheBlock);
  else html=replaceRequired(html,/^let p1v='B'.*$/m,cacheBlock+'\n'+html.match(/^let p1v='B'.*$/m)?.[0],'prompt cache insertion');
  return {prompts,html,htmlFile,revision};
}

function syncRuntime({check=false,pids=PIDS}={}){
  if(!check){
    const source=read('src/engine.js');
    const block='/* PROFILE_EVIDENCE_START (generated from src/profile_evidence.js) */\nconst ProfileEvidence = (() => { const module = {exports:{}};\n'+read('src/profile_evidence.js')+'\nreturn module.exports; })();\n/* PROFILE_EVIDENCE_END */';
    const pattern=/\/\* PROFILE_EVIDENCE_START[^]*?\/\* PROFILE_EVIDENCE_END \*\//;
    if(!pattern.test(source))throw Error('Missing evidence module markers');
    let updated=source.replace(pattern,()=>block);
    const businessBlock='/* BUSINESS_EVENTS_START (generated from src/business_events.js) */\nconst BusinessEvents = (() => { const module = {exports:{}};\n'+read('src/business_events.js')+'\nreturn module.exports; })();\n/* BUSINESS_EVENTS_END */';
    const businessPattern=/\/\* BUSINESS_EVENTS_START[^]*?\/\* BUSINESS_EVENTS_END \*\//;
    updated=businessPattern.test(updated) ? updated.replace(businessPattern,()=>businessBlock) : updated.replace('/* PROFILE_EVIDENCE_END */','/* PROFILE_EVIDENCE_END */\n'+businessBlock);
    for(const spec of MAPPING_MODULES){
      const pattern=new RegExp('/\\* '+spec[0]+'_START[^]*?/\\* '+spec[0]+'_END \\*/');
      updated=pattern.test(updated)?updated.replace(pattern,()=>embeddedModule(spec)):updated.replace('/* BUSINESS_EVENTS_END */','/* BUSINESS_EVENTS_END */\n'+embeddedModule(spec));
    }
    if(updated!==source)fs.writeFileSync(path.join(ROOT,'src/engine.js'),updated);
    const cfg=JSON.parse(read('data/config.json'));
    cfg.profile_mapping=mappingBundle();
    for(const [field,extension] of Object.entries(cfg.profile_mapping.config.facts_extensions))Object.assign(cfg.fields[field].subs,extension.subs);
    const cfgJson=JSON.stringify(cfg,null,2)+'\n';
    if(read('data/config.json')!==cfgJson)fs.writeFileSync(path.join(ROOT,'data/config.json'),cfgJson);
  }
  const result=compileRuntime({pids});
  const json=JSON.stringify(result.prompts,null,2)+'\n';
  const currentPrompts=read('data/prompts.json');
  const currentHtml=read(result.htmlFile);
  if(check){
    if(currentPrompts!==json||currentHtml!==result.html)throw Error('Runtime defaults are stale; run npm run sync');
  }else{
    fs.writeFileSync(path.join(ROOT,'data/prompts.json'),json);
    fs.writeFileSync(path.join(ROOT,result.htmlFile),result.html);
  }
  return {check,revision:result.revision,prompts:pids};
}

if(require.main===module){
  try{const only=process.argv.find(arg=>arg.startsWith('--only='));console.log(JSON.stringify(syncRuntime({check:process.argv.includes('--check'),...(only?{pids:only.slice(7).split(',')}:{})})));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={compileRuntime,syncRuntime};
