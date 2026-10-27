'use strict';
/* Registration-only mapping. Pure code, never writes a database or infers missing facts. */
const TARGET_SEPARATOR = '.';
const norm = x => String(x == null ? '' : x).trim();
const inRange = (x,min,max)=>Math.max(min,Math.min(max,x));
const isValidFact = f => !!f && f.active === true && f.status === '已确认' &&
  (f.polarity || '肯定') === '肯定' && !norm(f.condition) &&
  !!norm(f.field) && !!norm(f.sub) && typeof f.value === 'string' && !!norm(f.value);
const quoteOf = f => norm(f.evidence);
const order = f => Number.isFinite(Number(f.ver)) ? Number(f.ver) : Number(f.turn)||0;

function selectedFact(facts,field,sub,subject){
  const matches=facts.filter(f=>isValidFact(f)&&f.field===field&&f.sub===sub&&f.subject===subject);
  if(!matches.length)return {status:'missing'};
  const values=[...new Set(matches.map(f=>norm(f.value)))];
  if(values.length===1)return {status:'matched',fact:matches.sort((a,b)=>order(b)-order(a))[0]};
  // N09 should have invalidated a corrected value. Never silently last-write-wins otherwise.
  const corrected=matches.filter(f=>f.op==='correct').sort((a,b)=>order(b)-order(a));
  if(corrected.length && order(corrected[0])>Math.max(...matches.filter(f=>f!==corrected[0]).map(order)))
    return {status:'matched',fact:corrected[0]};
  return {status:'conflict',reason:`${field}.${sub} has multiple active values`,evidence:matches.map(f=>f.value)};
}
function evidence(f){return {fact_version:f.ver??null,field:`${f.field}.${f.sub}`,subject:f.subject,quote:quoteOf(f)};}
function canonicalInterest(raw,aliases){
  const q=norm(raw).toLowerCase();
  if(!q)return null;
  for(const row of aliases)if([row.name,...(row.aliases||[])].some(s=>norm(s).toLowerCase()===q))return row.id;
  return null;
}
function mapInterests(facts,taxonomy,interestAliases){
  if(!Array.isArray(facts)||!Array.isArray(taxonomy)||!taxonomy.length)throw Error('invalid_interest_taxonomy');
  const validIDs=new Set(taxonomy.map(t=>Number(t.id)));
  const data=interestAliases?.interest_aliases||interestAliases;
  if(validIDs.size!==taxonomy.length||[...validIDs].some(id=>!Number.isSafeInteger(id)||id<=0)||!Array.isArray(data)||!data.length)throw Error('invalid_interest_dictionary');
  const meanings=new Map();
  for(const row of data){
    if(!validIDs.has(row.id)||typeof row.name!=='string'||!Array.isArray(row.aliases))throw Error('invalid_interest_alias');
    for(const name of [row.name,...row.aliases]){
      if(typeof name!=='string'||!name.trim())throw Error('invalid_interest_alias');
      const key=norm(name).toLowerCase();
      if(meanings.has(key)&&meanings.get(key)!==row.id)throw Error('ambiguous_interest_alias');
      meanings.set(key,row.id);
    }
  }
  const ids=new Set(),unmapped=[],trace=[];
  for(const f of facts.filter(f=>isValidFact(f)&&f.subject==='自己'&&f.field==='Q1'&&f.sub==='items')){
    if(f.polarity==='否定')continue;
    const v=norm(f.value);
    // Try entire standardized phrase before splitting. This preserves aliases such as 奶茶和甜品.
    const whole=canonicalInterest(v,data);
    const tokens=whole?[v]:v.split(/[、，,；;\/]|(?:和)|(?:以及)/).map(x=>x.trim()).filter(Boolean);
    for(const token of tokens){const id=canonicalInterest(token,data);
      if(id!==null&&validIDs.has(Number(id))){ids.add(Number(id));trace.push({id:Number(id),source:evidence(f)});}
      else unmapped.push({word:token,source_fact_version:f.ver??null});
    }
  }
  return {ids:[...ids].sort((a,b)=>a-b),unmapped,trace};
}
function parseHeight(f,registeredHeight,bounds,tolerance){
  let s=norm(f.value).replace(/厘米|公分|ＣＭ|cm/gi,'').replace(/\s+/g,'');
  const [low,high]=bounds;
  if(/^(不限|无所谓|没要求|都可以)$/.test(s))return {min_cm:low,max_cm:high,kind:'unlimited',strength:f.strength||'偏好',tolerance_cm:0};
  let m=s.match(/^(?:比我|比本人|比自己)(高|矮)(\d{1,2})(?:左右|上下)?$/);
  if(m){
    if(!Number.isFinite(registeredHeight)||registeredHeight<low||registeredHeight>high)return {pending:'missing_registered_height',raw:f.value};
    const center=registeredHeight+(m[1]==='高'?1:-1)*Number(m[2]);
    if(center<low||center>high)return {pending:'out_of_bounds',raw:f.value};
    const delta=tolerance;
    return {min_cm:inRange(center-delta,low,high),max_cm:inRange(center+delta,low,high),kind:'relative_target',strength:f.strength||'偏好',tolerance_cm:delta,raw:f.value};
  }
  m=s.match(/^(\d{3})(?:-|~|～|至|到)(\d{3})$/);
  if(m){const min=Number(m[1]),max=Number(m[2]);if(min>max||min<low||max>high)return {pending:'invalid_range',raw:f.value};
    return {min_cm:min,max_cm:max,kind:'explicit_range',strength:f.strength||'偏好',tolerance_cm:0,raw:f.value};}
  m=s.match(/^(?:(?:至少|不低于|不得低于|不能低于)(\d{3})|(\d{3})(?:以上|起|及以上))$/);
  if(m){const x=Number(m[1]||m[2]);if(x<low||x>high)return {pending:'out_of_bounds',raw:f.value};return {min_cm:x,max_cm:high,kind:'min',strength:f.strength||'偏好',tolerance_cm:0,raw:f.value};}
  m=s.match(/^(?:(?:最多|不高于|不能高于)(\d{3})|(\d{3})(?:以下|以内|及以下))$/);
  if(m){const x=Number(m[1]||m[2]);if(x<low||x>high)return {pending:'out_of_bounds',raw:f.value};return {min_cm:low,max_cm:x,kind:'max',strength:f.strength||'偏好',tolerance_cm:0,raw:f.value};}
  m=s.match(/^(\d{3})(?:左右|上下)?$/);
  if(m){const x=Number(m[1]);if(x<low||x>high)return {pending:'out_of_bounds',raw:f.value};
    const delta=tolerance;
    return {min_cm:inRange(x-delta,low,high),max_cm:inRange(x+delta,low,high),kind:delta?'around':'exact',strength:f.strength||'偏好',tolerance_cm:delta,raw:f.value};}
  return {pending:'unparsed_height',raw:f.value};
}
function isSelfNamedAlcohol(f){
  const s=quoteOf(f).replace(/\s+/g,'');
  if(/[?？"“”「」]|以前|曾经|如果|可能|不|没|别/.test(s))return false;
  return /(?:^|[，。；;！!])(?:我|本人)(?:就是|是|算是|自认是|自称是)(?:个|一个|妥妥的)?酒蒙子/.test(s);
}
function mapPet(facts,q5_answers=[]){
  const own=facts.filter(f=>isValidFact(f)&&f.field==='Q5'&&f.subject==='自己');
  const has=selectedFact(own,'Q5','has_pet','自己');
  if(has.status==='matched'&&has.fact.value==='正在养')return {status:'matched',value:'已经养啦',source:evidence(has.fact)};
  if(has.status==='conflict')return has;
  // Explicit desire must be present in P1B evidence, not inferred from '喜欢动物' or '没有养'.
  // Old raw answers cannot undo a newer confirmed correction. Unknown/conflicting
  // intent stays unknown; a third person's plans never become the user's plans.
  const latestTurn=has.status==='matched'?Number(has.fact.turn)||0:0;
  const quotes=[...new Set([...own.filter(f=>(Number(f.turn)||0)>=latestTurn).map(quoteOf),...q5_answers.filter(q=>q&&typeof q.text==='string'&&
    (Number(q.turn)||0)>=latestTurn).map(q=>q.text)])].filter(Boolean);
  const safe=quotes.filter(q=>!/[?？"“”「」]|(?:如果|要是|可能|或许|以前|曾经|过去|原来|他|她|室友|朋友|父母|爸妈|别人|对方)/.test(q));
  const clauses=safe.flatMap(q=>q.split(/[，。；;！!]/)).map(q=>q.trim())
    .filter(q=>q&&!/(?:他|她|它|室友|朋友|父母|爸妈|别人|对方|帮|替|照顾|代养)/.test(q));
  // Bare '养' inherits the Q5 pet question, while an explicitly different object
  // (养花/养生 etc.) must never be accepted just because the verb matches.
  const petObject=/(?:想养|打算养|计划养|就养|再养)(?=$|宠物|小?猫|小?狗|一只|一条|几只|几条)/;
  const want=clauses.filter(q=>/(?:非常|特别|很|超级|一直|真的|一定).{0,3}想养|(?:打算|计划)养|等.{1,8}(?:就|再)养/.test(q)&&petObject.test(q)&&!/不|没|别/.test(q));
  const never=clauses.filter(q=>/^(?:我|本人)?(?:完全不想养|绝对不养|一点都不想养|绝不会养)(?:宠物|任何动物|动物)?(?:了|啦|啊|呢)?$/.test(q));
  const current=clauses.filter(q=>/^(?:我)?(?:现在|目前|正在)(?:正)?养(?:着|了|有)?(?:一只|一条|几只|几条)?(?:小?猫|小?狗|宠物)/.test(q));
  if(current.length&&has.status==='matched'&&has.fact.value==='没有养')return {status:'conflict',reason:'conflicting_current_pet'};
  if(current.length)return {status:'matched',value:'已经养啦',source:{quotes:current}};
  if(want.length&&clauses.some(q=>/不想养|不打算养|没打算养|不计划养/.test(q)))return {status:'conflict',reason:'conflicting_pet_desire'};
  if(want.length&&never.length)return {status:'conflict',reason:'conflicting_pet_desire'};
  if(want.length)return {status:'matched',value:'非常想养',source:{quotes:want}};
  if(never.length)return {status:'matched',value:'完全不想养',source:{quotes:never}};
  return {status:'unknown',reason:'no_explicit_pet_intention'};
}
function mapProfile({facts=[],registration={},config,taxonomy=[],interestAliases={interest_aliases:[]},q5_answers=[],notes=[]}){
  if(!config||!Array.isArray(config.targets))throw new Error('profile_mapping_config_missing');
  const conflicts=notes.filter(n=>n.active);
  facts=facts.filter(f=>!conflicts.some(n=>n.field===f.field&&n.sub===f.sub&&n.subject===f.subject));
  const updates={},sources={},skipped=[];
  const emit=(key,value,source)=>{updates[key]=value;sources[key]=source;};
  // Existing registered preference remains available, but is not written unless explicitly changed.
  for(const t of config.targets){
    const source=Array.isArray(t.from)?null:t.from;
    if(t.type==='special'&&t.target==='lifestyle.pet_attitude'){
      const p=conflicts.some(n=>n.field==='Q5')?{status:'conflict',reason:'unresolved_pet_conflict'}:mapPet(facts,q5_answers);
      if(p.status==='matched')emit(t.target,p.value,p.source);
      else skipped.push({target:t.target,status:p.status,reason:p.reason});continue;
    }
    const [field,sub]=source.split(TARGET_SEPARATOR);
    const sel=selectedFact(facts,field,sub,t.subject);
    if(sel.status!=='matched'){
      skipped.push({target:t.target,status:sel.status,reason:sel.reason||'no_valid_fact'});continue;
    }
    const f=sel.fact,raw=norm(f.value);
    if(t.type==='range'){
      const h=parseHeight(f,registration.height_cm==null?NaN:Number(registration.height_cm),t.bounds_cm,t.tolerance_cm);
      if(h.pending)skipped.push({target:t.target,status:'unmapped',reason:h.pending,raw:h.raw});
      else emit(t.target,h,evidence(f));continue;
    }
    if(t.type==='special'&&t.target==='lifestyle.drink'){
      if(raw==='经常'){
        if(isSelfNamedAlcohol(f))emit(t.target,'酒蒙子',evidence(f));
        else skipped.push({target:t.target,status:'unmapped',reason:'frequent_drinking_not_self_named_酒蒙子'});
      }else if(Object.prototype.hasOwnProperty.call(t.map,raw)&&t.map[raw]!==null)emit(t.target,t.map[raw],evidence(f));
      else skipped.push({target:t.target,status:'unmapped',reason:'unrecognized_drink'});
      continue;
    }
    if(t.map&&Object.prototype.hasOwnProperty.call(t.map,raw))emit(t.target,t.map[raw],evidence(f));
    else skipped.push({target:t.target,status:'unmapped',reason:'non_equivalent_or_illegal_value',raw});
  }
  let interest;
  try {interest={status:'mapped',...mapInterests(facts,taxonomy,interestAliases)};}
  catch (_) {interest={status:'error',reason:'interest_mapping_failed'};}
  // Include known existing interests for a useful snapshot. The host must still
  // apply an atomic union against its current database, not replace from this snapshot.
  if(interest.status==='mapped'){
    const existing=Array.isArray(registration.interest_ids)?registration.interest_ids:[];
    interest.ids=[...new Set([...existing.filter(id=>Number.isSafeInteger(id)&&id>0),...interest.ids])].sort((a,b)=>a-b);
  }
  return {updates,sources,skipped,interest,registration_unchanged:{seek:registration.seek??null,height_cm:registration.height_cm??null}};
}
module.exports={mapProfile,mapInterests,parseHeight,mapPet,isSelfNamedAlcohol,selectedFact};
