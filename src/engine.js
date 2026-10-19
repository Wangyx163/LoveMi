/* ===== LoveMi Coze Demo 引擎：与 Coze 代码节点逐一对应（JS 版） ===== */
const clone = o => JSON.parse(JSON.stringify(o));
const S = v => JSON.stringify(v);
function parseLoose(txt){
  if (txt && typeof txt === 'object') return txt;
  let s = String(txt||'').trim().replace(/^```(?:json)?/gm,'').replace(/```$/gm,'').trim();
  const m = s.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : s); } catch(e){ return {}; }
}
const stripP = s => String(s||'').replace(/^[\s。.!！~]+|[\s。.!！~]+$/g,'');
const PII=/(\d{7,})|((微信|vx|wx|QQ|qq|电话|手机)[号:：\s]*[A-Za-z0-9_-]{5,})/i;
const norm = s => String(s||'').replace(/[\s，。,.!！?？、~～…"'“”‘’：:；;（）()]/g,'');
const qmarks = t => (t.match(/[？?]/g)||[]).length;

const newTaskState=()=>({a:0,f:0,h:0,done:0,refused:0,fu:0,rep:0,covered:0});
function newState(cfg){
  const tasks={}; for(const t in cfg.tasks) tasks[t]=newTaskState();
  return {v:1,stage:'S60',turn:0,current:null,plan:null,tasks,pending:[],
    used:{S60:{F:0,R:0,S:0},S40:{F:0,R:0,S:0}},card_fu:0,facts:[],fv:0,tags:{'60':[],'100':[]},
    dialog:[],history:[],cards:[],rec:{},notes:[],stat:{},progress:0,saved:false,from_direct:false,_und:{},_new:[]};
}
const activeFacts = st => st.facts.filter(f=>f.active && f.status==='已确认');
function itemMet(st,item,subjects){const [fid,sub]=item.split('.');const subjectMatches=x=>!subjects||subjects.includes(x.subject);return st.facts.some(f=>f.active&&f.status==='已确认'&&f.field===fid&&f.sub===sub&&subjectMatches(f)&&!(f.src==='NEED'&&fid!=='NEED'))||(st.notes||[]).some(n=>n.active&&n.field===fid&&n.sub===sub&&subjectMatches(n));}
function covered(cfg,st,tid){const mi=cfg.tasks[tid].min_info;if(!mi)return false;const h=mi.items.map(i=>itemMet(st,i,mi.subjects?.[i]));return mi.mode==='all'?h.every(Boolean):h.some(Boolean);}
function missing(cfg,st,tid){const mi=cfg.tasks[tid].min_info||{items:[]};return mi.items.filter(i=>!itemMet(st,i,mi.subjects?.[i]));}
function budgetLeft(cfg,st,stage){if(!cfg.budget[stage])return 0;const b=cfg.budget[stage],u=st.used[stage];return Math.max(0,Math.floor(b.N*b.r)-u.F-u.R-u.S);}
function factsText(cfg,st,only,withEv){
  const rows=[];
  for(const f of activeFacts(st)){ if(only&&!only.includes(f.field))continue;
    const cond=f.condition?`（条件：${f.condition}）`:'';
    const hard=f.strength==='硬性'?'（硬性）':'';
    rows.push(withEv?`- ${cfg.fields[f.field].name}｜对象:${f.subject}｜${f.value}${hard}${cond}｜原话:${f.evidence}`:`- ${f.field}.${f.sub}｜${cfg.fields[f.field].name}｜对象:${f.subject}｜${f.value}${cond}`);}
  if(!only&&!withEv){const ref=Object.keys(st.tasks).filter(t=>st.tasks[t].refused);if(ref.length)rows.push('- 已拒答的题目：'+ref.join('、'));}
  return rows.join('\n')||'（暂无）';
}
function fieldDictText(cfg){return Object.entries(cfg.fields).map(([fid,f])=>`${fid} ${f.name}｜对象可取:${f.subjects.join('/')}｜`+Object.entries(f.subs).map(([s,d])=>`${s}=`+(d.type==='enum'?d.values.join('/'):'开放文本')).join('；')).join('\n');}
function cardsText(st){return (st.cards||[]).map((c,i)=>`第${i+1}位（编号 ${c.key}）｜${c.name}·${c.age}·${c.city}·${c.school}｜`+c.tags.join(' · ')).join('\n');}
function spec(cfg,st,tid,qtype,withEv){const t=cfg.tasks[tid];
  return {task_id:tid,qtype,theme:t.theme,goal:t.goal,key_semantics:t.key_semantics,fallback:t.fallback,scenes:t.scenes||[],
    missing:missing(cfg,st,tid),avoid_texts:st.history.filter(h=>h.task===tid).map(h=>h.text),known_facts:factsText(cfg,st,null,withEv),recent_dialog:st.dialog.slice(-3)};}
// 核心句：问题本身（换场景重问、反问后重问时原样使用）；烟酒只缺一项时只问缺的那项
// 补充问题：本阶段实际答过的题少于下限、额度还有、本阶段还没用过补充题时触发；优先补画像最空的那一块
function pickSupplement(cfg,st,stage){const PC=(cfg.pace||{})[stage];if(!PC)return null;
  if(((st.asked||{})[stage]||0)>=PC.min_answered)return null;if(budgetLeft(cfg,st,stage)<=0)return null;
  if(((st.sup_used||{})[stage]||0)>=((cfg.pace||{}).max_supplements||1))return null;
  const asked=new Set(st.history.map(h=>h.task));const facts=activeFacts(st);
  const cands=(cfg.supplements||[]).filter(id=>!asked.has(id)&&!covered(cfg,st,id));if(!cands.length)return null;
  const fill=id=>facts.filter(f=>((cfg.related_fields||{})[id]||[]).includes(f.field)).length;
  return cands.map((id,i)=>({id,i,s:fill(id)})).sort((a,b)=>(a.s-b.s)||(a.i-b.i))[0].id;}
function coreOf(cfg,st,tid){const t=cfg.tasks[tid];const miss=missing(cfg,st,tid);if(t.core_by_missing&&miss.length===1&&t.core_by_missing[miss[0]])return t.core_by_missing[miss[0]];return t.core||t.fallback;}
function leadSpec(cfg,st,tid){const t=cfg.tasks[tid];const rf=(cfg.related_fields||{})[tid]||[];
  const facts=activeFacts(st).filter(f=>rf.includes(f.field)).map(f=>`- ${cfg.fields[f.field].name}：${f.value}`).join('\n')||'（无）';
  const last=st.dialog.slice(-1)[0];return {task_id:tid,qtype:'REPLACE',mode:'lead',theme:t.theme,core:coreOf(cfg,st,tid),related_facts:facts,last_turn:last?`问：${last.q}｜答：${last.a}`:'（无）',avoid_texts:st.history.filter(h=>h.task===tid).map(h=>h.text)};}
function qOk(cfg,text){const t=String(text||'').trim();if(t.length<4||t.length>80)return false;if(qmarks(t)>2)return false;
  if([...cfg.blocked.compliance,...cfg.blocked.no_ask].some(w=>t.includes(w)))return false;return true;}
function progressOf(cfg,st){let p=0;for(const [tid,w] of Object.entries(cfg.weights)){const ts=st.tasks[tid];
  p+= cfg.tasks[tid].kind==='judge' ? (ts.done?w:0) : Math.min(w,w*(ts.a+ts.h)/(1+ts.f));}return Math.round(p*10)/10;}
function firstOpenTask(cfg,st,stage){for(const tid of cfg.order[stage]){const t=cfg.tasks[tid],ts=st.tasks[tid];
  if(t.kind!=='main'||ts.a)continue; if(covered(cfg,st,tid)||ts.refused){ts.a=1;ts.done=1;continue;} return tid;}return null;}

/* ---------- N02 前置拦截（写死规则） ---------- */
const EMOJI=/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F\u200D]/gu;
const PUNCT=/[\s.,!?~～…。，！？、；;：:"'“”‘’（）()\-—_*#@&%^+=<>\/\\|\[\]{}]/g;
const KEYROWS=['qwertyuiop','asdfghjkl','zxcvbnm'];
function prefilter(cfg,ui,task){const t=String(ui||'').trim();
  const noP=t.replace(PUNCT,'');if(!noP)return 'empty';
  const core=noP.replace(EMOJI,'');if(!core)return task==='NEED'?'emoji':'';
  if([...core].length>=3&&new Set([...core]).size===1)return 'repeat';
  if(new RegExp('^\\d{'+cfg.prefilter.digits_min+',}$').test(core))return 'digits';
  const low=core.toLowerCase();
  if(/^[a-z]{4,}$/.test(low)){let row=false;for(let i=0;i+4<=low.length;i++)if(KEYROWS.some(r=>r.includes(low.slice(i,i+4))))row=true;
    if(row||/[bcdfghjklmnpqrstvwxz]{5,}/.test(low))return 'gibberish';}
  return '';}
const inputLimit=(cfg,task)=>cfg.max_input_chars[task]??cfg.max_input_chars.default;

// 仅用于等待开场回应的上下文；先排除提问、否定和犹豫，再识别自然的同意表达。
const INTRO_ACCEPT='那就开始啦～想到什么都可以和我说，说得越具体，我就越懂你～';
const INTRO_ACCEPT_PREFIXES=['那我们','我们','那就','已经','现在','完全','当然','没事','嗯','恩','哦','噢','那','我','都'];
const INTRO_ACCEPT_WORDS=new Set(['准备好','准备好了','准备好的','好','好了','好的','好哒','好滴','好嘞','可以','可以了','可以的','行','行了','行的','没问题','没有问题','没毛病','同意','愿意','开始','开始了','开聊','聊','聊起来','来','你问','你开始问','ok','okk','okay','yes','yep','sure','ready','letsgo','goahead']);
function introAcceptClause(t){
  if(/^[嗯恩]+$/.test(t))return true;
  let start=0,end=t.length;
  // 最长前缀优先，每步只移动游标；重复语气词不会触发正则回溯。
  while(start<end){const prefix=INTRO_ACCEPT_PREFIXES.find(p=>t.startsWith(p,start));if(!prefix)break;start+=prefix.length;}
  while(end>start&&'呀啊呢哦喔哟啦吧嗯恩'.includes(t[end-1]))end--;
  return INTRO_ACCEPT_WORDS.has(t.slice(start,end));
}
function introClass(ui){
  const t=String(ui||'').normalize('NFKC').toLowerCase().trim();
  if(/[？?]|吗|什么|多久|怎么|几个|几分钟/.test(t))return 'question';
  if(/还没|没好|没准备|等等|等一下|等会|稍等|晚点|待会|以后再|紧张|不知道|没想好|害羞|不太会|不行|不可以|不能|不想|暂时不|先不|别开始|没空|不方便|别问|没时间|not\s+(?:yet|ready|now)|\b(?:no|nope)\b/.test(t))return 'hesitate';
  const clauses=t.replace(EMOJI,'').split(/[，,。.!！;；～~\n]/).map(s=>s.replace(/\s+/g,'').replace(/[“”‘’"']/g,''));
  return clauses.some(introAcceptClause)?'accept':'other';
}

/* ---------- N02 ---------- */
function N02(cfg,stateJson,ui){
  ui=String(ui||'').trim(); let st=null;
  try{st=stateJson?JSON.parse(stateJson):null;if(!st||st.v!==1)st=null;}catch(e){st=null;}
  if(st){st.tasks=st.tasks||{};for(const tid in cfg.tasks)if(!st.tasks[tid])st.tasks[tid]=newTaskState();}
  let branch='STATIC',reply='',qSpec='',forcedUnd='',contQ='';if(st){st._care=false;st._und={};}
  if(!st||ui==='重新开始'||ui==='/reset'){st=newState(cfg);
    st.stage='INTRO';st.current=null;reply=cfg.intro.hello+'\n\n'+cfg.intro.guide;
  } else if(ui==='退出'&&['S60','S40','AWAIT_60'].includes(st.stage)){st.stage='EXITED';st.current=null;reply='好，我们先聊到这里。对话会保留，不会生成中途画像。（回复「重新开始」可重新测试）';}
  else if(['EXITED','DONE'].includes(st.stage)) reply='这次注册已经结束啦。回复「重新开始」可以重新测试。';
  else if(st.stage==='AWAIT_60'){
    const generateProfile=[cfg.buttons.p60[1],'生成画像','直接完成','完成'].includes(ui);
    if(!generateProfile){st.stage='S40';const nxt=firstOpenTask(cfg,st,'S40');
      st.progress=Math.max(60,progressOf(cfg,st));
      if(nxt){
        const sup=(cfg.pace||{}).S40?.trigger==='before:'+nxt?pickSupplement(cfg,st,'S40'):null;
        if(sup){st.used.S40.S+=1;st.sup_used=st.sup_used||{};st.sup_used.S40=(st.sup_used.S40||0)+1;st.plan={action:'SUPPLEMENT',task:sup,qtype:'SUPPLEMENT'};}
        else st.plan={action:'ASK_NEXT',task:nxt,qtype:'MAIN'};
        branch='CONTINUE_40';const target=sup||nxt;contQ=cfg.tasks[target].script||cfg.tasks[target].fallback;}
      else {branch='PROFILE';st.stage='PROFILE_GEN';}}
    else{branch='PROFILE';st.stage='PROFILE_GEN';st.from_direct=true;}
  } else if(st.stage==='PROFILE_READY'){
    if(ui.includes('保存')){st.saved=true;reply='画像已保存。（Demo 未写入真实数据）';}
    else if(ui.includes('首页')||ui.includes('匹配')){st.stage='DONE';reply='（Demo）回到首页。真实环境以首页实际到达为准。';}
    else reply=`回复「${cfg.buttons.p100[0]}」或「${cfg.buttons.p100[1]}」。`;
  } else if(st.stage==='INTRO'){
    // 开场回应按语义选择承接；确认后直接进入需求题，不调用模型。
    const IA=cfg.intro_ack||{},cls=introClass(ui);
    const ackL=IA[cls]||(cls==='accept'?[INTRO_ACCEPT]:[]);const ack=ackL.length?ackL[(st.turn||0)%ackL.length]:(cls==='accept'?INTRO_ACCEPT:'');
    const parts=String(cfg.tasks.NEED.script||'').split(/\n\s*\n/);
    if(cls==='accept'&&[INTRO_ACCEPT,ack].includes(parts[0].trim()))parts.shift();
    const q=[ack,...parts].filter(Boolean).join('\n\n');st.intro_class=cls;st.stage='S60';st.current={task:'NEED',qtype:'MAIN',text:cfg.tasks.NEED.core,qid:'q1'};st.history.push({task:'NEED',qtype:'MAIN',text:cfg.tasks.NEED.core});reply=q;
  } else if(st.stage==='S40'&&st.current&&st.current.task==='Q12'){
    // 最后一题只采集、不处理：原话直接入库（不调理解模型），然后生成画像
    st.turn+=1;const t=ui.trim();
    if(t&&!prefilter(cfg,t,'Q12')&&!PII.test(t)&&!cfg.blocked.compliance.some(w=>t.includes(w)))
      st.facts.push({field:'Q12',sub:'supplement',subject:'自己',value:t.slice(0,cfg.max_input_chars.Q12),evidence:t.slice(0,cfg.max_input_chars.Q12),status:'已确认',active:true,turn:st.turn,src:'Q12',raw:true});
    st.dialog=[...st.dialog,{q:st.current.text,a:t.slice(0,200)}].slice(-8);
    st.tasks.Q12.a=1;st.tasks.Q12.done=1;st.pending=[];st.current=null;st.stage='PROFILE_GEN';st.progress=progressOf(cfg,st);branch='COLLECT';
  } else if(['S60','S40'].includes(st.stage)&&st.current){st.turn+=1;const kind=prefilter(cfg,ui,st.current.task);
    if(kind){branch='PREFILTER';forcedUnd=S({answer_status:'unclear',facts:[],refused_targets:[],conflicts:[],followup:{worth:false},card_followup:{needed:false},ack_worthy:false,next_question_draft:'',prefilter:kind});}
    else branch='ANSWER';}
  else reply='状态异常，回复「重新开始」重新测试。';
  const cur=st.current||{},curTask=cur.task;
  const curSpec=curTask&&cfg.tasks[curTask].kind!=='judge'?spec(cfg,st,curTask,cur.qtype):{task_id:curTask,qtype:cur.qtype};
  let hint='{}';
  if(branch==='ANSWER'||branch==='PREFILTER'){const tmp=clone(st);if(curTask&&cur.qtype==='MAIN')tmp.tasks[curTask].a=1;
    for(const tid of cfg.order[st.stage]){const t=cfg.tasks[tid];
      if(t.kind==='main'&&!tmp.tasks[tid].a&&!covered(cfg,tmp,tid)&&tid!==curTask){hint=S(spec(cfg,st,tid,'MAIN'));break;}}}
  const inCard=curTask==='CARD_L1'||cur.qtype==='CARD_FOLLOWUP';
  const SR=cfg.stage_rules||{};const stageRules=curTask==='NEED'?SR.NEED:(inCard?SR.CARD:((cfg.tasks[curTask]||{}).kind==='supplement'?SR.SUP:SR.default));
  const slim=s=>{try{const o=JSON.parse(s);if(!o||!o.task_id)return s;const {known_facts,recent_dialog,avoid_texts,...rest}=o;return S(rest);}catch(e){return s;}};
  return {branch,state:S(st),cont_q:contQ,reply_static:reply,user_text:ui.slice(0,inputLimit(cfg,curTask)),forced_und:forcedUnd,stage_rules:stageRules||'',cur_task_slim:slim(S(curSpec)),next_hint_slim:slim(hint),tag_catalog:(cfg.tag_catalog_in_prompt&&curTask==='NEED')?Object.entries(cfg.tag_lib).map(([k,v])=>`${k}｜${v.text}｜${v.cat}`).join('\n'):'（未启用）',cur_q:cur.text||'',cur_task:S(curSpec),field_dict:fieldDictText(cfg),
    facts_text:factsText(cfg,st),recent_dialog:S(st.dialog.slice(-2)),stage:st.stage,budget_left:String(budgetLeft(cfg,st,st.stage)),
    cards_text:inCard?cardsText(st):'（当前不在人物卡阶段）',next_hint:hint,q_task_spec:qSpec};
}
/* ---------- N38 ---------- */
function N38(raw){raw=String(raw||'');const d=parseLoose(raw);const ok=!!d&&['answered','partial','unclear','refused','nothing_to_add','off_topic','asks_back','risk'].includes(d.answer_status);
  return {ok,reason:ok?'ok':(raw?'非 JSON 或缺少 answer_status':'空输出（超时或报错）')};}
/* ---------- N05 ---------- */
function N05(und){const d=parseLoose(und);return {parse_ok:Object.keys(d).length>0};}
/* ---------- N09 ---------- */
function N09(cfg,stateStr,ui,undTxt){
  const st=JSON.parse(stateStr),und=parseLoose(undTxt),fields=cfg.fields;st.notes=st.notes||[];
  const statusOk=['answered','partial','unclear','refused','nothing_to_add','off_topic','asks_back','risk'];
  const cands=[...(und.facts||[])];
  const written=[],rejected=[],nui=norm(ui);
  for(const f of cands){const {field:fid,sub,subject:subj,value:val}=f,ev=f.evidence||'';let reason='';
    if(!fields[fid])reason='字段不存在';else if(!fields[fid].subs[sub])reason='子项不存在';
    else if(!fields[fid].subjects.includes(subj))reason='对象不合法';
    else if(!ev||norm(ev).length<1||!nui.includes(norm(ev)))reason='证据不是用户原话';
    else if(PII.test(String(val))||PII.test(ev))reason='含联系方式等隐私信息';
    else if(cfg.blocked.compliance.some(w=>String(val).includes(w)||ev.includes(w)))reason='命中合规屏蔽词';
    else{const d=fields[fid].subs[sub];if(d.type==='enum'&&!d.values.includes(val))reason='枚举值不合法';
      else if(d.type==='open'&&(!val||String(val).length>40))reason='开放值为空或过长';}
    if(reason){rejected.push({fact:`${fid}.${sub}=${val}`,reason});continue;}
    st.notes.forEach(x=>{if(x.active&&x.field===fid&&x.sub===sub&&x.subject===subj)x.active=false;});   // 有了明确的新值，矛盾附注失效
    const same=st.facts.filter(x=>x.active&&x.status==='已确认'&&x.field===fid&&x.sub===sub&&x.subject===subj);
    const isEnum=fields[fid].subs[sub].type==='enum'&&!fields[fid].subs[sub].multi;
    if(same.some(x=>x.value===val)&&f.op!=='correct')continue;
    if(isEnum||f.op==='correct')same.forEach(x=>{x.active=false;x.superseded_turn=st.turn;});
    st.fv+=1;const rec={field:fid,sub,subject:subj,value:val,polarity:f.polarity||'肯定',condition:f.condition||'',strength:['硬性','偏好'].includes(f.strength)?f.strength:'偏好',evidence:ev,src:(st.current||{}).task||'',status:'已确认',active:true,turn:st.turn,ver:st.fv,op:f.op||'add'};
    st.facts.push(rec);written.push(rec);}
  for(const cf of (und.conflicts||[])){const {field:fid,sub,subject:subj}=cf,ev=cf.evidence||'';
    if(fields[fid]&&fields[fid].subs[sub]&&fields[fid].subjects.includes(subj)&&ev&&nui.includes(norm(ev))){
      st.notes.push({field:fid,sub,subject:subj,note:String(cf.note||'').slice(0,60),evidence:ev,turn:st.turn,active:true});written.push({field:fid,sub,status:'矛盾附注',evidence:ev});}
    else rejected.push({fact:`${fid}.${sub}（矛盾）`,reason:'字段或证据不合法'});}
  const a=statusOk.includes(und.answer_status)?und.answer_status:'unclear';
  st._und={answer_status:a,refused_targets:(und.refused_targets||[]).filter(t=>cfg.tasks[t]),card_level:und.card_level||'none',
    followup:und.followup||{},card_followup:und.card_followup||{},ack:String(und.ack||''),next_question_draft:und.next_question_draft||'',parse_ok:Object.keys(und).length>0,prefilter:und.prefilter||''};
  const tids=(und.need_tag_ids||[]).filter(t=>cfg.tag_lib[t]);if(tids.length)st.need_tags=[...new Set([...(st.need_tags||[]),...tids])].sort();
  st._new=written;
  return {state:S(st),written:S(written),rejected:S(rejected),debug:`写入${written.length}条 拒绝${rejected.length}条 answer_status=${a}`};
}
/* ---------- N10 ---------- */
function N10(cfg,stateStr){const st=JSON.parse(stateStr);const ck=new Set((st.notes||[]).filter(n=>n.active).map(n=>n.field+'.'+n.sub));
  const facts=activeFacts(st).filter(f=>!ck.has(f.field+'.'+f.sub));const out={};
  for(const scene of ['60','100']){const hits=[];
    for(const t of cfg.tag_dict){if(!t.scenes.includes(scene))continue;
      for(const f of facts){if(f.field!==t.field||f.sub!==t.sub||!t.subject.includes(f.subject))continue;const v=String(f.value);
        const ok=(t.in||[]).includes(v)||(t.contains||[]).some(k=>v.includes(k));
        if(ok&&(f.polarity||'肯定')!=='否定'){hits.push({tag_id:t.id,text:t.text,cat:t.cat||'',source:`${f.field}.${f.sub}`,evidence_ver:f.ver,group:t.group,p:t.p});break;}}}
    const seen=new Set(),chosen=[];hits.sort((a,b)=>a.p-b.p).forEach(h=>{if(seen.has(h.group))return;seen.add(h.group);chosen.push({tag_id:h.tag_id,text:h.text,cat:h.cat,source:h.source,evidence_ver:h.evidence_ver});});
    out[scene]=chosen.slice(0,cfg.tag_max[scene]);}
  st.tags={'60':out['60'],'100':out['100'],mapping_version:'demo-1',fv:st.fv||0};
  return {state:S(st),tags_60:S(out['60']),tags_100:S(out['100']),debug:`60%标签${out['60'].length} 100%标签${out['100'].length}`};}
/* ---------- N11 ---------- */
function N11(cfg,stateStr,ui,hintStr){
  const st=JSON.parse(stateStr);let hint={};try{hint=JSON.parse(hintStr||'{}');}catch(e){}
  const und=st._und||{},stage=st.stage,cur=st.current,tid=cur.task,qtype=cur.qtype,T=st.tasks,lim=cfg.limits;let status=und.answer_status||'unclear';
  st.stat=st.stat||{};st.stat[status]=(st.stat[status]||0)+1;if(tid==='NEED')st.need_status=status;
  st.dialog=[...st.dialog,{q:cur.text,a:String(ui).slice(0,inputLimit(cfg,tid))}].slice(-8);
  const hold=(text,why)=>{st.plan={action:'HOLD',task:tid,qtype};return {state:S(st),action:'HOLD',route:'READY',candidate_q:text,q_task_spec:'',need_ack:false,ack_anchor:'',rel_facts_text:'',debug:`动作=HOLD（${why}）原题保留`};};
  if(status==='risk'){st._care=true;status='skipped';}   // 口头关怀一句，主流程照常推进
  if(und.parse_ok===false){if(!cur.fail){cur.fail=1;return hold(cfg.model_fail_reply+'\n\n'+cur.text,'模型失败');}status='unclear';}
  if(status==='asks_back'){
    if(!cur.hold){const prefix=cfg.asks_back_template.replace('{about}',cfg.tasks[tid].about||'想法');
      st.plan={action:'REASK',task:tid,qtype,hold:1,prefix};
      if(qtype==='MAIN'||qtype==='REPLACE')return {state:S(st),action:'REASK',route:'READY',candidate_q:coreOf(cfg,st,tid),q_task_spec:'',rel_facts_text:'',debug:`动作=REASK 目标=${tid}（核心句原样）`};
      return {state:S(st),action:'REASK',route:'READY',candidate_q:cur.text,q_task_spec:'',need_ack:false,ack_anchor:'',rel_facts_text:'',debug:`动作=REASK（追问原句重发）目标=${tid}`};}
    status='skipped';}

  st.asked=st.asked||{};st.asked[stage]=(st.asked[stage]||0)+1;
  for(const t in T)if(cfg.tasks[t].kind==='main')T[t].covered=covered(cfg,st,t)?1:0;
  const refused=new Set(und.refused_targets||[]);
  if(status==='refused'&&['MAIN','REPLACE','FOLLOW_UP'].includes(qtype))refused.add(tid);
  refused.forEach(r=>T[r].refused=1);
  if(qtype==='MAIN'||qtype==='REPLACE'){T[tid].a=1;st.pending=st.pending.filter(x=>x.task!==tid);
    if(!(cfg.no_replace_tasks||[]).includes(tid)&&!T[tid].covered&&!T[tid].refused&&T[tid].rep<lim.replace_per_task&&['unclear','partial','off_topic'].includes(status))st.pending.push({task:tid,since:0});}
  else if(qtype==='FOLLOW_UP')T[tid].h=1;
  else if(qtype==='CARD_FOLLOWUP')T[tid].done=1;
  st.pending=st.pending.filter(x=>!T[x.task].covered&&!T[x.task].refused);
  let action=null,pTask=null,pQ=null,cand='';
  const inCard=tid==='CARD_L1'||qtype==='CARD_FOLLOWUP';
  if(inCard){const cf=und.card_followup||{};
    // 代码兜底：说出了对 TA 的要求（L3）→ 不追；追问后说不清 / 跑题 / 拒答 → 停；追问② 和追问① 问的是同一件事 → 停
    const l3=und.card_level==='L3'||(st._new||[]).some(f=>f.field==='NEED');
    const stopSt=['refused','skipped',...(qtype==='CARD_FOLLOWUP'?['unclear','off_topic']:[])];
    const prevFu=st.history.filter(h=>h.qtype==='CARD_FOLLOWUP').map(h=>h.text);
    const sim=(a,b)=>{const A=new Set(norm(a)),B=new Set(norm(b));const inter=[...A].filter(x=>B.has(x)).length;return inter/Math.max(1,Math.min(A.size,B.size));};
    const dup=!!cf.question&&prevFu.some(t=>sim(t,cf.question)>=0.7);
    st.card_guard=l3?'L3':(stopSt.includes(status)?'停止：'+status:(dup?'和上一次追问重复':''));
    for(const j of ['CARD_F1','CARD_F2']){if(T[j].done)continue;
      const can=cf.needed&&!l3&&!dup&&st.card_fu<lim.card_followup&&budgetLeft(cfg,st,stage)>0&&!T.CARD_L1.refused&&!stopSt.includes(status)&&qOk(cfg,cf.question);
      if(can){action='FOLLOW_UP';pTask=j;pQ='CARD_FOLLOWUP';cand=cf.question.trim();st.card_fu+=1;st.used[stage].F+=1;}
      else ['CARD_F1','CARD_F2'].forEach(jj=>T[jj].done=1);
      break;}
    T.CARD_L1.done=T.CARD_L1.a?1:0;
  } else if(qtype==='MAIN'){const fu=und.followup||{};
    if(!(cfg.no_followup_tasks||[]).includes(tid)&&T[tid].covered&&!T[tid].refused&&['answered','partial'].includes(status)&&fu.worth&&T[tid].fu<lim.followup_per_task&&budgetLeft(cfg,st,stage)>0&&qOk(cfg,fu.question)){
      action='FOLLOW_UP';pTask=tid;pQ='FOLLOW_UP';cand=fu.question.trim();T[tid].fu+=1;T[tid].f=1;st.used[stage].F+=1;}}
  if(action===null&&cfg.tasks[tid].kind==='main'&&cfg.tasks[tid].stage===stage)
    T[tid].done=(T[tid].a&&(!T[tid].f||T[tid].h))?1:T[tid].done;
  if(action===null){const rep=st.pending.find(x=>x.since>=1);
    if(rep&&budgetLeft(cfg,st,stage)>0){action='REPLACE_LATER';pTask=rep.task;pQ='REPLACE';T[rep.task].rep+=1;st.used[stage].R+=1;
      st.pending=st.pending.filter(x=>x!==rep);st.pending.forEach(x=>x.since+=1);}}
  if(action===null){let nxt=null;
    for(const t of cfg.order[stage]){const ts=T[t];if(cfg.tasks[t].kind!=='main'||ts.a)continue;
      if(ts.covered||ts.refused){ts.a=1;ts.done=1;continue;}nxt=t;break;}
    const PC=(cfg.pace||{})[stage]||{};const atTrigger=PC.trigger==='end'?!nxt:(PC.trigger&&PC.trigger==='before:'+nxt);
    const sup=atTrigger?pickSupplement(cfg,st,stage):null;
    if(sup){action='SUPPLEMENT';pTask=sup;pQ='SUPPLEMENT';st.used[stage].S+=1;st.sup_used=st.sup_used||{};st.sup_used[stage]=(st.sup_used[stage]||0)+1;st.pending.forEach(x=>x.since+=1);}
    else if(nxt){action='ASK_NEXT';pTask=nxt;pQ='MAIN';st.pending.forEach(x=>x.since+=1);}
    else{st.pending=[];action=stage==='S60'?'SHOW_60':'GENERATE_PROFILE';}}
  st.progress=progressOf(cfg,st);let qs='',route='READY';
  if(action==='SHOW_60'){route='SHOW_60';st.stage='AWAIT_60';st.current=null;st.progress=60;}
  else if(action==='GENERATE_PROFILE'){route='GENERATE_PROFILE';st.stage='PROFILE_GEN';st.current=null;}
  else if(action==='ASK_NEXT'&&pTask==='CARD_L1'){route='CARDS';st.plan={action,task:pTask,qtype:pQ};}
  else{st.plan={action,task:pTask,qtype:pQ};
    if(action==='ASK_NEXT'||action==='SUPPLEMENT')cand=cfg.tasks[pTask].script||cfg.tasks[pTask].fallback;          // V1：主问题、补充问题都用脚本原文
    else if(action==='REPLACE_LATER'){route='QGEN';qs=S(leadSpec(cfg,st,pTask));}            // 换场景重问：只让模型写引子
    if(!cand&&!qs){route='QGEN';qs=S(leadSpec(cfg,st,pTask));}}
  const nw=st._new||[];
  const anchor=nw.map(f=>`${cfg.fields[f.field].name}：${f.evidence}`).join('；');
  const left=['S60','S40'].includes(stage)?budgetLeft(cfg,st,stage):0;
  return {state:S(st),action,route,candidate_q:cand,q_task_spec:qs,
    rel_facts_text:factsText(cfg,st,['NEED','Q3','Q4','Q8','Q9','Q10','Q11','CARD','SELF'],true),life_facts_text:factsText(cfg,st,['Q1','Q2','Q3','Q5','Q6','Q7','SELF'],true),
    debug:`动作=${action} 目标=${pTask} 进度=${st.progress}% 剩余额度=${left} 待替换=[${st.pending.map(x=>x.task)}]`};
}
/* ---------- N15 / N18 ---------- */
function N15(cfg,llmOut,specStr,isFinal){const sp=parseLoose(specStr);
  if(sp.mode==='lead'){const lead=String(parseLoose(llmOut).lead||'').trim();let reason='';
    if(lead.length<4||lead.length>22)reason='引子长度不合规';else if(/[？?]/.test(lead))reason='引子里提问了';else if(!/[～。]$/.test(lead))reason='引子结尾不合规';else if(/[。！!～~\r\n]/.test(lead.slice(0,-1)))reason='引子不是一句陈述';else if([...cfg.blocked.compliance,...cfg.blocked.no_ask].some(w=>lead.includes(w)))reason='含屏蔽词';
    if(!reason)return {pass:true,q_text:lead+sp.core,used_fallback:false,reason:'ok'};
    if(isFinal)return {pass:true,q_text:sp.core,used_fallback:true,reason};return {pass:false,q_text:'',used_fallback:false,reason};}
  const q=String(parseLoose(llmOut).question||'').trim();let reason='';
  if(q.length<4||q.length>80)reason='长度不合规';else if(qmarks(q)>2)reason='一次问了多个问题';
  else if([...cfg.blocked.compliance,...cfg.blocked.no_ask].some(w=>q.includes(w)))reason='含屏蔽词';
  else if((sp.avoid_texts||[]).includes(q))reason='与已问过的问法重复';
  if(!reason)return {pass:true,q_text:q,used_fallback:false,reason:'ok'};
  if(isFinal)return {pass:true,q_text:sp.fallback||'',used_fallback:true,reason};
  return {pass:false,q_text:q,used_fallback:false,reason};}
/* ---------- N23 ---------- */
// 口头关怀：只是一句温暖的承接，放在下一条回复最前面
function careLine(cfg,st){if(!st._care)return '';st._care=false;const L=cfg.care_ack||[];return L.length?L[(st.turn||0)%L.length]:'';}
const replyParagraph=text=>String(text||'').replace(/\s*[\r\n]+\s*/g,'').trim();
function selectAck(cfg,st){
  const care=careLine(cfg,st);if(care)return {text:replyParagraph(care),care:true};
  const und=st._und||{};
  if(!und.answer_status||und.parse_ok===false)return {text:'',care:false};
  const ack=replyParagraph(und.ack);
  const valid=ack&&[...ack].length<=25&&!/[？?]/.test(ack)&&!cfg.blocked.compliance.some(w=>ack.includes(w));
  return {text:valid?ack:'嗯，我们接着聊～',care:false};
}
function N23(cfg,stateStr,q){const st=JSON.parse(stateStr);q=replyParagraph(q);
  const selected=selectAck(cfg,st),ack=selected.text;
  if(selected.care){const pl=st.plan||{};if(pl.action==='ASK_NEXT'&&cfg.tasks[pl.task]&&cfg.tasks[pl.task].core)q=replyParagraph(cfg.tasks[pl.task].core);}   // 关怀之后去掉脚本里欢快的过渡句，只问问题本身
  const plan=st.plan||{},n=st.history.length+1;
  if(plan.action==='HOLD'){st._new=[];return {reply:q+`\n\n— 画像进度 ${Math.floor((st.progress||0)+0.5)}%`,new_state:S(st)};}
  st.current={task:plan.task,qtype:plan.qtype,text:q,qid:'q'+n};st.history.push({task:plan.task,qtype:plan.qtype,text:q});st._new=[];
  if(plan.action==='REASK'){st.current.hold=plan.hold||1;q=replyParagraph(plan.prefix)+q;}
  let reply=replyParagraph(ack)+q;reply+=`\n\n— 画像进度 ${Math.floor((st.progress||0)+0.5)}%`;
  return {reply,new_state:S(st)};}
/* ---------- N25 ---------- */
const NEED={'情感慰藉':'被理解、被陪着','灵魂共鸣':'能聊到一起的共鸣','现实助力':'生活里彼此搭把手','感官吸引':'心动的感觉'};
// 是否拿到过用户自己的有效信息（人物卡选择、最后一题原话不算）
const hasInfo=st=>activeFacts(st).some(f=>!['CARD','Q12'].includes(f.field));
// 兜底信号组：按“没说的方式”选文案和兜底标签
function fbGroup(st){const s=st.stat||{},ref=s.refused||0,unc=(s.unclear||0)+(s.off_topic||0);
  if(ref>=2&&ref>=unc)return 'boundary';if(unc>=2)return 'chill';
  if(activeFacts(st).some(f=>f.field==='CARD'&&f.sub==='l1'&&f.value==='都没感觉'))return 'picky';
  if(st.need_status==='nothing_to_add')return 'feel';return 'default';}
function fbText(cfg,st,slot){const g=fbGroup(st),G=cfg.fallback_groups;const arr=(G[g]&&G[g][slot])||G.default[slot]||[''];return arr[(st.turn||0)%arr.length];}
// 标签：真实标签优先；不足 2 个时用兜底标签补位（兜底标签带 kind:'兜底'，不参与匹配）
function withFallbackTags(cfg,st,real,min){min=min||cfg.fallback_min_tags;const out=real.map(t=>({...t,kind:'事实'}));if(out.length>=min)return out;
  const g=fbGroup(st);const order=[...(cfg.fallback_tags[g]||[]),...(g!=='default'?cfg.fallback_tags.default||[]:[])];
  for(const id of order){if(out.length>=min)break;if(!out.some(t=>t.tag_id===id))out.push({tag_id:id,text:cfg.tag_text[id],kind:'兜底'});}return out;}
// 60% 标签：只用已确认事实映射出的标签，优先“情感 + 生活态度”各至少一个，共 3～4 个
function pick60Tags(cfg,st){const all=(st.tags||{})['60']||[],R=cfg.p60_card;const emo=all.filter(t=>t.cat==='社交情感'),life=all.filter(t=>t.cat!=='社交情感');const out=[];
  if(emo[0])out.push(emo[0]);if(life[0])out.push(life[0]);for(const t of all){if(out.length>=R.tags_max)break;if(!out.includes(t))out.push(t);}
  return withFallbackTags(cfg,st,out.slice(0,R.tags_max),R.tags_min);}
// 60% 主文案的事实模板（模型生成不出来时用）：关系一句 + 生活一句
function p60Template(st){const f=activeFacts(st),get=(fid,sub,subj)=>f.find(x=>x.field===fid&&(!sub||x.sub===sub)&&(!subj||x.subject===subj));
  const need=get('Q11'),pace=get('Q4','pace','自己'),exp=get('Q8','expectation');let rel='';
  if(need)rel=`在关系里你更看重${NEED[need.value]||need.value}`;else if(pace&&['非常慢热','偏慢热'].includes(pace.value))rel='你在感情里偏慢热，愿意让关系慢慢升温';else if(exp)rel=`你希望两个人${String(exp.value).replace(/^希望/,'')}`;
  const it=get('Q1','items'),sl=get('Q2','sleep');let life='';if(it)life=`日子里也爱${it.value}`;else if(sl)life={'偏晚睡':'日子里是个夜猫子','偏早睡':'日子里作息偏早'}[sl.value]||'';
  return rel&&life?`${rel}，${life}。`:(rel?rel+'。':(life?'你'+life.replace(/^日子里/,'平时')+'。':''));}
function N25(cfg,stateStr,llmOut){const st=JSON.parse(stateStr);const out=parseLoose(llmOut);let line=String(out.attitude||'').trim(),status='ok';
  const R=cfg.p60_card;
  if(line.length<R.insight_min||line.length>R.insight_max||[...cfg.blocked.compliance,...cfg.blocked.no_label].some(w=>line.includes(w))||out.insufficient){status='fallback';
    line=p60Template(st);if(!line)line=hasInfo(st)?fbText(cfg,st,'core_some'):fbText(cfg,st,'p60');}
  const tags=pick60Tags(cfg,st);const care=careLine(cfg,st);const parts=care?[care,'','【LoveMi 眼中的你】']:['【LoveMi 眼中的你】'];if(line)parts.push(line);
  if(tags.length)parts.push(tags.map(t=>'#'+t.text).join('  '));
  parts.push('',`「${cfg.buttons.p60[0]}」　「${cfg.buttons.p60[1]}」`,'— 画像进度 60%');
  st.stage_card_60={attitude:line,tags,content_status:status,fallback_group:status==='fallback'?fbGroup(st):''};
  return {reply:parts.join('\n'),new_state:S(st),content_status:status};}
/* ---------- N29 ---------- */
function rowsOf(cfg,facts,notes,only){const out=[];for(const f of facts){if(!only.includes(f.field))continue;const nm=cfg.fields[f.field].name;
  const cond=f.condition?`（条件：${f.condition}）`:'';const hard=f.strength==='硬性'?'（硬性）':'';out.push(`- ${nm}｜对象:${f.subject}｜${f.value}${hard}${cond}｜原话:${f.evidence}`);}
  for(const n of notes){if(!only.includes(n.field))continue;out.push(`- ${cfg.fields[n.field].name}｜对象:${n.subject}｜（前后矛盾，需要综合判断）｜原话:${n.evidence}`+(n.note?`｜说明:${n.note}`:''));}
  return out.join('\n')||'（暂无）';}
function N29(cfg,stateStr){const st=JSON.parse(stateStr);const facts=activeFacts(st),notes=(st.notes||[]).filter(n=>n.active);
  const c60=st.stage_card_60||{};
  return {rel_facts:rowsOf(cfg,facts,notes,['NEED','Q4','Q8','Q9','Q10','Q11','CARD','SELF','Q12']),life_facts:rowsOf(cfg,facts,notes,['Q1','Q2','Q3','Q5','Q6','Q7','SELF','Q12']),p60_insight:(c60.content_status==='ok'&&c60.attitude)?c60.attitude:'无',state:S(st)};}
/* ---------- N32 ---------- */
function phrase(f){const k=f.field+'.'+f.sub,v=f.value;
  if(f.field==='NEED')return ['traits','interests','other'].includes(f.sub)?(f.strength!=='硬性'?`希望对方${v}`:`很在意对方${v}`):(f.strength==='硬性'?`在意对方${v}`:`希望对方${v}`);
  const T={'Q1.items':`喜欢${v}`,'Q2.sleep':{'偏早睡':'作息偏早','偏晚睡':'习惯晚睡','不固定':'作息不太固定'}[v]||'','Q2.pace':{'比较忙碌':'平时比较忙','相对轻松':'日子过得比较轻松'}[v]||'',
    'Q3.social':{'明显偏独处':'更享受独处','比较偏独处':'更享受独处','比较偏社交':'喜欢热闹','明显偏社交':'喜欢热闹'}[v]||'','Q5.has_pet':{'正在养':'养着宠物'}[v]||'','Q5.animal_like':{'喜欢':'喜欢小动物'}[v]||'',
    'Q6.style':`消费上偏${v}`,'Q6.condition':v,'Q7.smoke':{'不吸':'不抽烟'}[v]||'','Q7.drink':{'不喝':'不喝酒','偶尔':'偶尔喝点酒'}[v]||'',
    'Q4.pace':f.subject==='自己'?`在感情里${v}`:`希望对方${v}`,'Q11.need':`在关系里更看重${NEED[v]||v}`,'Q9.strategy':`忙起来会${v}`,'Q9.balance':`事业和感情之间${v}`,
    'Q10.openness':`聊到过去的感情时倾向${v}`,'Q8.expectation':`希望${v}`};return T[k]||'';}
function tpl(st,fields){const parts=[];for(const f of st.facts.filter(f=>f.active&&f.status==='已确认'&&fields.includes(f.field))){const x=phrase(f);if(x&&!parts.includes(x))parts.push(x);}return parts.length?'你'+parts.join('，')+'。':'';}
function N32(cfg,stateStr,outRel,outLife){const st=JSON.parse(stateStr);const rel=parseLoose(outRel),life=parseLoose(outLife);
  const banned=[...cfg.blocked.compliance,...cfg.blocked.no_label];const ok=(t,mx)=>t&&t.length<=mx&&!banned.some(w=>t.includes(w));const info=hasInfo(st);
  const src={};const pick=(key,txt,mx,fields)=>{txt=String(txt||'').trim();if(ok(txt,mx)){src[key]='model';return txt;}const t=fields?tpl(st,fields):'';if(t){src[key]='template';return t.slice(0,mx);}src[key]='empty';return '';};
  // 核心洞察：模型 → 60% 卡的洞察（非兜底时）→ 兜底文案（有信息用中性版，没信息按信号组）
  let core=String(rel.core||'').trim();
  if(ok(core,60))src.core='model';
  else{const c60=st.stage_card_60||{};core=(c60.content_status==='ok'||(c60.attitude&&!c60.fallback_group))?c60.attitude:'';src.core=core?'60%':'fallback';
    if(!core)core=info?fbText(cfg,st,'core_some'):fbText(cfg,st,'core');}
  const expect=pick('expect_ta',rel.expect_ta,80,['NEED','Q8']),daily=pick('daily',life.daily,110,['Q1','Q2','Q3','Q5','Q6','Q7']),love=pick('love_style',rel.love_style,100,['Q4','Q9','Q10','Q11']);
  const tags=withFallbackTags(cfg,st,(st.tags||{})['100']||[]);const tagLine=tags.length?tags.map(t=>'#'+t.text).join('  '):'';
  const care=careLine(cfg,st);const lines=[...(care?[care,'']:[]),'【我的画像】','','核心洞察',core,''];
  if(!expect&&!daily&&!love){lines.push(fbText(cfg,st,'merged'),'');if(tagLine)lines.push(tagLine,'');}
  else{lines.push('我对 TA 的期待',expect||fbText(cfg,st,'expect'),'','兴趣日常',daily||fbText(cfg,st,'daily'));if(tagLine)lines.push(tagLine);lines.push('','我的相处方式',love||fbText(cfg,st,'love'),'');}
  lines.push(`「${cfg.buttons.p100[0]}」　「${cfg.buttons.p100[1]}」`);st.stage='PROFILE_READY';
  const fb=Object.entries(src).filter(([k,v])=>v!=='model').map(([k])=>k);
  st.profile={core,expect_ta:expect,daily,love_style:love,tags,source:src,fallback_group:fbGroup(st),content_status:fb.length?'fallback':'ok'};
  return {reply:lines.join('\n'),new_state:S(st),fallback_sections:fb};}

/* ---------- N36 召回 + 硬筛 + 排序 + 出卡 ---------- */
const EDU={'本科':1,'硕士':2,'博士':3};
const loadLibrary=cfg=>cfg.pool;                         // 口子 1：真实环境查库（候选人 + 预先跑好的标签）
const tagObj=(cfg,tid)=>{const t=cfg.tag_lib[tid];return {id:tid,text:t.text,cat:t.cat,kw:t.kw||[]};};
function displayTags(c,cfg){const d=cfg.display;const tags=c.tags.filter(t=>cfg.tag_lib[t]).map(t=>tagObj(cfg,t));
  // 先按默认配额（教育1 + 基础1 + 兴趣2 + 社交1）取；不足 4 条时再放宽到最大配额补齐
  const take=quota=>{const out=[],used={};for(const cat of d.cat_order)for(const t of tags)if(t.cat===cat&&(used[cat]||0)<(quota[cat]??0)){out.push(t);used[cat]=(used[cat]||0)+1;}return out;};
  let ordered=take(d.cat_quota);if(ordered.length<d.min_tags&&d.cat_quota_max){const more=take(d.cat_quota_max).filter(t=>!ordered.includes(t));for(const t of more){if(ordered.length>=d.min_tags)break;ordered.push(t);}
    ordered=d.cat_order.flatMap(cat=>ordered.filter(t=>t.cat===cat));}
  const rows=[],picked=[];for(const t of ordered){if(picked.length>=d.max_tags)break;
    if(rows.length&&rows[rows.length-1].reduce((a,x)=>a+x.length,0)+t.text.length<=d.row_chars){rows[rows.length-1].push(t.text);picked.push(t);}
    else if(rows.length<d.max_rows&&t.text.length<=d.row_chars){rows.push([t.text]);picked.push(t);}}
  return [picked,rows];}
function baseOk(c,me,gap,same){if(c.gender!==me.seek||Math.abs(c.age-me.age)>gap)return false;return same==='city'?c.city===me.city:c.province===me.province;}
function ageRange(t,me){t=String(t);let m=t.match(/(\d{2})\s*[-到至~～]\s*(\d{2})/);if(m)return [+m[1],+m[2]];
  m=t.match(/(\d{2})\s*(岁)?\s*(以上|往上|及以上)/);if(m)return [+m[1],200];m=t.match(/(\d{2})\s*(岁)?\s*(以下|以内|往下)/);if(m)return [0,+m[1]];
  if(t.includes('比我大'))return [me+1,200];if(t.includes('比我小'))return [0,me-1];if(t.includes('同龄')||t.includes('差不多大'))return [me-1,me+1];return null;}
function hardCheck(c,f,me){const sub=f.sub,v=f.value;
  if(sub==='smoke')return v==='不吸烟'?[true,c.smoke==='不吸','吸烟']:[false,true,''];
  if(sub==='drink'){if(v==='不喝酒')return [true,c.drink==='不喝','喝酒'];if(v==='少喝')return [true,['不喝','偶尔'].includes(c.drink),'经常喝酒'];return [false,true,''];}
  if(sub==='city')return v==='同城'?[true,c.city===me.city,'不同城']:[false,true,''];
  if(sub==='edu'){const need={'本科及以上':1,'硕士及以上':2}[v];return need?[true,(EDU[c.edu]||0)>=need,'学历不符']:[false,true,''];}
  if(sub==='pet')return v==='不养宠物'?[true,c.pet==='没有养','养宠物']:[false,true,''];
  if(sub==='age'){const r=ageRange(v,me.age);return r?[true,r[0]<=c.age&&c.age<=r[1],'年龄不符']:[false,true,''];}
  if(sub==='height'){const m=String(v).match(/(1\d{2})/);return m?[true,c.height>=+m[1],'身高不符']:[false,true,''];}
  return [false,true,''];}
function softHit(c,f,cfg,me){const sub=f.sub,v=String(f.value);
  if(['traits','interests','other'].includes(sub)){const words=v.split(/[、，,;；/\s]+/).filter(Boolean);const tags=c.tags.filter(t=>cfg.tag_lib[t]).map(t=>tagObj(cfg,t));
    return words.some(w=>tags.some(t=>w.includes(t.text)||t.text.includes(w)||t.kw.includes(w)||t.kw.some(k=>w.includes(k))));}
  if(sub==='pet'&&v==='喜欢宠物')return c.pet==='正在养';const [can,passed]=hardCheck(c,f,me);return can&&passed;}
// 差异点：按标签类目逐类比较——每一类里“对方没有的标签数”（两边取大），各类相加
function tdiff(a,b){const cats=[...new Set([...a,...b].map(t=>t.cat))];
  return cats.reduce((s,c)=>{const A=a.filter(t=>t.cat===c).map(t=>t.id),B=b.filter(t=>t.cat===c).map(t=>t.id);
    return s+Math.max(A.filter(x=>!B.includes(x)).length,B.filter(x=>!A.includes(x)).length);},0);}
function* combos(n,k,start=0,acc=[]){if(acc.length===k){yield acc.slice();return;}for(let i=start;i<n;i++){acc.push(i);yield* combos(n,k,i+1,acc);acc.pop();}}
function cmpKey(a,b){for(let i=0;i<a.length;i++){const x=a[i],y=b[i];if(Array.isArray(x)){for(let j=0;j<x.length;j++)if(x[j]!==y[j])return x[j]-y[j];continue;}if(x!==y)return x-y;}return 0;}
function N36(cfg,stateStr){const st=JSON.parse(stateStr);const me=cfg.user_profile,rc=cfg.recall;const needTags=new Set(st.need_tags||[]);
  const needs=st.facts.filter(f=>f.active&&f.status==='已确认'&&f.field==='NEED');const mode=(needs.length||needTags.size)?'need':'home';
  const lib=loadLibrary(cfg);const hard=[],soft=[],down=[];
  needs.forEach(f=>{if(f.strength==='硬性')(hardCheck(lib[0],f,me)[0]?hard:down).push(f);else soft.push(f);});soft.push(...down);
  const disp={};lib.forEach(c=>disp[c.id]=displayTags(c,cfg));
  const levels=[{name:'固定规则',age_gap:rc.age_gap,same:rc.same},...rc.expand_steps];let eligible=[],usedLevels=[],dropped=[];
  for(let li=0;li<levels.length;li++){const lv=levels[li];usedLevels=levels.slice(1,li+1);eligible=[];dropped=[];
    for(const c of lib){if(!baseOk(c,me,lv.age_gap,lv.same))continue;if(disp[c.id][0].length<rc.min_tags){dropped.push({name:c.name,reasons:['可展示标签不足 4 个']});continue;}
      const bad=hard.filter(f=>!hardCheck(c,f,me)[1]).map(f=>hardCheck(c,f,me)[2]);if(bad.length){dropped.push({name:c.name,reasons:bad});continue;}eligible.push(c);}
    if(eligible.length>=rc.recommend_count)break;}
  const scored=eligible.map((c,i)=>{const hits=[...soft.filter(f=>softHit(c,f,cfg,me)).map(f=>`${f.sub}=${f.value}`),...c.tags.filter(t=>needTags.has(t)).map(t=>'标签:'+cfg.tag_lib[t].text)];return {c,hits,score:hits.length,ntags:c.tags.length,i};});
  const ranked=[...scored].sort((a,b)=>(b.score-a.score)||(b.ntags-a.ntags)||(a.i-b.i));
  const dvc=cfg.diversity,texts=x=>disp[x.c.id][0],okp=(a,b)=>{const d=tdiff(texts(a),texts(b));return dvc.min<=d&&d<=dvc.max;};
  const cand=ranked.slice(0,10),n=Math.min(rc.recommend_count,cand.length);let top=null;
  for(const cb of combos(cand.length,n)){let good=true;for(let i=0;i<cb.length&&good;i++)for(let j=i+1;j<cb.length;j++)if(!okp(cand[cb[i]],cand[cb[j]])){good=false;break;}
    if(good){top=cb.map(i=>cand[i]);break;}}
  const filled=!top;if(!top)top=ranked.slice(0,n);
  const pairs=[];for(let i=0;i<top.length;i++)for(let j=i+1;j<top.length;j++)pairs.push(tdiff(texts(top[i]),texts(top[j])));
  const cards=top.map((x,idx)=>{const c=x.c,[tags,rows]=disp[c.id];
    const items=mode==='need'?[...hard.map(f=>`${f.sub}=${f.value}（硬性）`),...x.hits]:[];
    return {key:'ABC'[idx],id:c.id,name:c.name,age:c.age,city:c.city,school:c.school,tags:tags.map(t=>t.text),tag_ids:tags.map(t=>t.id),rows,score:x.score,source:mode,filter_hit:{count:items.length,items}};});
  st.cards=cards;st.rec={mode,hard:hard.map(f=>`${f.sub}=${f.value}`),soft:soft.map(f=>`${f.sub}=${f.value}`),downgraded:down.map(f=>`${f.sub}=${f.value}`),
    expanded:usedLevels.map(l=>l.name),dropped,ranked:ranked.map(x=>({name:x.c.name,score:x.score,ntags:x.ntags})),pair_diffs:pairs,diversity_ok:!filled&&pairs.every(d=>dvc.min<=d&&d<=dvc.max)};
  const T=cfg.rec_text;const cnt=cards.length;let body;
  if(cnt===0){['CARD_L1','CARD_F1','CARD_F2'].forEach(t=>{st.tasks[t].a=1;st.tasks[t].done=1;});const q=cfg.tasks.LIFE.script||cfg.tasks.LIFE.fallback;
    st.current={task:'LIFE',qtype:'MAIN',text:q,qid:'q'+(st.history.length+1)};st.history.push({task:'LIFE',qtype:'MAIN',text:q});
    body=[(mode==='need'&&hard.length)?T.none_found:T.none_home,'',q];}
  else{const word={2:'两个人',3:'三个人'}[cnt];const q=cnt>1?T.card_question.replace('{word}',word):T.card_question_one;const gender=me.seek==='女'?'女生':'男生';
    st.current={task:'CARD_L1',qtype:'MAIN',text:q,qid:'q'+(st.history.length+1)};st.history.push({task:'CARD_L1',qtype:'MAIN',text:q});
    body=[];if(usedLevels.length)body.push(T.expand_note.replace('{steps}',usedLevels.map(l=>l.name).join('、')));
    body.push((cnt===1?(mode==='need'?T.need_lead_one:T.home_lead_one):(mode==='need'?T.need_lead:T.home_lead)).replace('{n}',cnt).replace('{gender}',gender),'','【Demo 模拟人物，仅用于测试】');
    cards.forEach(c=>{const hit=mode==='need'&&c.filter_hit.count?`　满足 ${c.filter_hit.count} 个筛选条件`:'';body.push(`${c.name} · ${c.age} · ${c.city} · ${c.school}${hit}`);c.rows.forEach(r=>body.push('    '+r.map(x=>'#'+x).join('  ')));});
    body.push('',q);}
  st.progress=progressOf(cfg,st);st._new=[];const ack=selectAck(cfg,st).text;
  if(cnt===0)body=[ack+replyParagraph(body.join(''))];else if(ack)body[0]=ack+body[0];
  return {reply:body.join('\n')+`\n\n— 画像进度 ${Math.floor(st.progress+0.5)}%`,new_state:S(st),mode};}

const p1Vars=r2=>({user_input:r2.user_text,stage:r2.stage,budget_left:r2.budget_left,cur_q:r2.cur_q,cur_task:r2.cur_task,next_hint:r2.next_hint,cur_task_slim:r2.cur_task_slim,next_hint_slim:r2.next_hint_slim,stage_rules:r2.stage_rules,cards_text:r2.cards_text,field_dict:r2.field_dict,facts_text:r2.facts_text,recent_dialog:r2.recent_dialog,tag_catalog:r2.tag_catalog});
const renderUserPrompt=(prompts,pid,vars)=>prompts[pid].user.replace(/\{\{(\w+)\}\}/g,(m,k)=>vars[k]??'');
const renderSys=(prompts,pid,vars)=>prompts[pid].sys.replace(/\{\{(\w+)\}\}/g,(m,k)=>vars[k]??'');
/* ---------- 编排：按 Coze 连线执行一轮 ---------- */
async function runTurn(ctx, ui){
  const {cfg,prompts,llm,trace}=ctx;
  const T0=performance.now();
  const step=(id,name,type,input,output,ms,note)=>trace.push({id,name,type,input,output,ms:Math.round(ms||0),note});
  const code=(id,name,fn,input)=>{const t=performance.now();const out=fn();step(id,name,'code',input,out,performance.now()-t);return out;};
  const sel=(id,name,res)=>step(id,name,'if',null,{结果:res},0,res);
  const agg=(id,name,obj)=>step(id,name,'agg',null,obj,0);
  const TIER={P1:'fast',P1B:'fast',P3:'fast',P5:'strong',P6:'deep_low',P7:'strong'};const P1ID=ctx.p1==='B'?'P1B':'P1';
  const model=async(id,name,pid,vars)=>{const t=performance.now();const sys=renderSys(prompts,pid,vars);const user=prompts[pid].user.replace(/\{\{(\w+)\}\}/g,(m,k)=>vars[k]??'');
    const limit=(cfg.timeouts||{})[pid];let out,err=null,timedOut=false;
    try{if(ctx.enforceTimeout&&limit){const ac=new AbortController();const timer=setTimeout(()=>{timedOut=true;ac.abort();},limit);
        try{out=await llm(id,pid,sys,user,TIER[pid],ac.signal);}finally{clearTimeout(timer);}}
      else out=await llm(id,pid,sys,user,TIER[pid]);}
    catch(e){err=timedOut?{code:'timeout'}:e;out='';}
    const ms=performance.now()-t;const over=limit&&ms>limit;
    step(id,name,'model',{prompt:pid,档位:TIER[pid],生产超时:limit?limit+'ms':'—',变量:vars,用户提示词:user},err?{error:err.code||String(err.message||err)}:{output:out},ms,err?(err.code==='timeout'?'超时（按生产超时中止）':'调用失败'):(over?`超过生产超时 ${limit}ms`:''));return out;};
  step('N01','开始','start',null,{USER_INPUT:ui});
  const r2=code('N02','装载与入口路由',()=>N02(cfg,ctx.stateJson,ui),{state_json:'(用户变量)',user_input:ui});
  sel('N03','入口分支',r2.branch==='STATIC'?'其他':r2.branch);if(r2.branch==='PREFILTER')trace[trace.length-1].note='PREFILTER（'+JSON.parse(r2.forced_und).prefilter+'）';
  let reply,newState;
  const finish=(id,r,s)=>{agg('N33','本轮输出',{来源:id});reply=r;newState=s;};
  const profile=async(stateStr,direct)=>{
    step('N26','输出：阶段消息','out',null,{text:cfg.profile_bubble});ctx.onBubble&&ctx.onBubble(cfg.profile_bubble);
    agg('N28','画像输入',{来源:direct?'N02':'N11'});
    const r29=code('N29','整理画像输入',()=>N29(cfg,stateStr),{});
    const [o30,o31]=await Promise.all([model('N30','② 关系画像·100%（核心洞察 / 期待 / 相处）','P6',{rel_facts:r29.rel_facts,life_facts:r29.life_facts,p60_insight:r29.p60_insight}),model('N31','③ 生活画像·100%（兴趣日常）','P7',{life_facts:r29.life_facts})]);
    const r32=code('N32','组装 100% 画像',()=>N32(cfg,r29.state,o30,o31),{out_rel:o30,out_life:o31});
    finish('N32',r32.reply,r32.new_state);};
  if(r2.branch==='STATIC'){finish('N02',r2.reply_static,r2.state);}
  else if(r2.branch==='COLLECT'){await profile(r2.state,false);}
  else if(r2.branch==='PROFILE'){await profile(r2.state,true);}
  else{
    let st,qspec,cand='',handled=false;
    if(r2.branch==='ANSWER'||r2.branch==='PREFILTER'){
      let und;
      if(r2.branch==='PREFILTER'){und=r2.forced_und;agg('N37','理解结果',{来源:'N02 前置拦截（未调用模型）'});}
      else{const vars=p1Vars(r2);
        const o4=await model('N04','⑤ 回答理解（主模型）'+(P1ID==='P1B'?'· B 版':''),P1ID,vars);
        const r38=code('N38','主模型输出检查',()=>N38(o4),{});sel('N39','主模型可用？',r38.ok?'是':'否：'+r38.reason);
        if(r38.ok){und=o4;agg('N37','理解结果',{来源:'N04'});}
        else{und=await model('N04B','⑤ 回答理解（备用模型）',P1ID,vars);agg('N37','理解结果',{来源:'N04B'});}}
      const r5=code('N05','解析理解结果',()=>N05(und),{});
      const r9=code('N09','校验 & 写入事实',()=>N09(cfg,r2.state,ui,und),{});
      const r10=code('N10','标签映射',()=>N10(cfg,r9.state),{});
      const r11=code('N11','任务路由与进度',()=>N11(cfg,r10.state,ui,r2.next_hint),{next_hint:r2.next_hint});
      sel('N12','下一步',r11.route);
      if(r11.route==='CARDS'){const r36=code('N36','召回 + 硬筛 + 排序 + 出卡',()=>N36(cfg,r11.state),{});finish('N36',r36.reply,r36.new_state);handled=true;}
      else if(r11.route==='SHOW_60'){step('N24a','输出：60% 阶段消息','out',null,{text:cfg.p60_bubble});ctx.onBubble&&ctx.onBubble(cfg.p60_bubble);
        const o=await model('N24','② 60% 主文案（情感 + 生活态度）','P5',{rel_facts:r11.rel_facts_text,life_facts:r11.life_facts_text});
        const r25=code('N25','组装 60% 阶段卡',()=>N25(cfg,r11.state,o),{llm_out:o});finish('N25',r25.reply,r25.new_state);handled=true;}
      else if(r11.route==='GENERATE_PROFILE'){await profile(r11.state,false);handled=true;}
      st=r11.state;qspec=r11.q_task_spec;cand=r11.candidate_q;
    } else { st=r2.state;qspec='';cand=r2.cont_q; }
    if(!handled){
    let q=cand;
    if(qspec){agg('N13','问法输入',{来源:r2.branch!=='CONTINUE_40'?'N11':'N02'});
      const o14=await model('N14','⑤ 重问引子（主模型）','P3',JSON.parse(qspec));
      const c1=code('N15','问法合规校验①',()=>N15(cfg,o14,qspec,false),{llm_out:o14});
      sel('N16','合规？',c1.pass?'是':'否：'+c1.reason);
      if(c1.pass)q=c1.q_text;else{const o17=await model('N17','⑤ 重问引子（备用模型）','P3',JSON.parse(qspec));
        const c2=code('N18','问法合规校验②（兜底）',()=>N15(cfg,o17,qspec,true),{llm_out:o17});q=c2.q_text;}
    }
    agg('N19','最终问句',{q_text:q,来源:qspec?'问法生成':'N11 追问/复用草稿'});
    const r23=code('N23','组装回复 & 提交（含承接）',()=>N23(cfg,st,q),{q_text:q});
    finish('N23',r23.reply,r23.new_state);
    }
  }
  step('N34','变量赋值','assign',null,{state_json:'← N33.new_state'});
  step('N35','结束','end',null,{reply});
  ctx.ms=Math.round(performance.now()-T0);
  return {reply,newState};
}
