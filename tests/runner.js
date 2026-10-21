async function runCase(cs,cfg,prompts,runTurn){
  // 历史用例固定原有开场入口；默认开启的新门槛由 test_need_intake.js 独立验证。
  if(cs.legacy_intake)cfg={...cfg,need_intake:{...cfg.need_intake,enabled:false}};
  let stateJson='';const replies=[],traces=[],states=[];
  // 开场多了一轮“准备好了吗”：在每个“开始 / 重新开始”后面自动补一句“好的”，用例里的轮次编号保持不变
  const steps=[],idx=[];cs.steps.forEach(s=>{idx.push(steps.length);steps.push(s);if(!cs.noReady&&(s[0]==='开始'||s[0]==='重新开始'))steps.push(['好的',{}]);});
  for(const [ui,stub] of steps){const trace=[];
    const llm=async(id)=>{const v=stub&&stub[id];return v==null?'{}':(typeof v==='string'?v:JSON.stringify(v));};
    const ctx={cfg,prompts,llm,trace,stateJson};let r;
    try{r=await runTurn(ctx,ui);}catch(e){const crash=String(e&&e.stack||e);return {cs,crash,results:[{pass:false,msg:'流程执行出错：'+crash}],replies,traces,states};}
    stateJson=r.newState;replies.push(r.reply);traces.push(trace);states.push(r.newState);}
  const st=JSON.parse(stateJson);const off=cs.off===undefined?1:cs.off;const M=i=>idx[i+off];const P=i=>JSON.parse(states[M(i)]);
  const out=(id,i)=>{const t=traces[M(i)].find(x=>x.id===id);return t?t.output:null;};
  const c={cfg,st,
    reply:i=>replies[M(i)]||'',prog:i=>P(i).progress,plan:i=>P(i).plan||{},plans:()=>idx.map(i=>JSON.parse(states[i]).plan),statesRaw:()=>idx.slice(cs.off===undefined?1:cs.off).map(i=>states[i]),
    action:i=>{const o=out('N11',i);return o?o.action:(P(i).plan||{}).action;},
    ran:(i,id)=>!!traces[M(i)].find(x=>x.id===id),
    turnFacts:i=>{const o=out('N09',i);return o?JSON.parse(o.written):[];},
    rejected:i=>{const o=out('N09',i);return o?JSON.parse(o.rejected):[];},
    modelInput:(i,id)=>{const t=traces[M(i)].find(x=>x.id===id);return t?t.input.变量:{};},
    active:k=>{const [f,s]=k.split('.');const x=st.facts.filter(y=>y.active&&y.status==='已确认'&&y.field===f&&y.sub===s).pop();return x?x.value:undefined;},
    eq:(got,exp,msg)=>({pass:JSON.stringify(got)===JSON.stringify(exp),msg,got:JSON.stringify(got),exp:JSON.stringify(exp)}),
    ok:(v,msg)=>({pass:!!v,msg,got:String(!!v)}),
    has:(text,sub,msg)=>({pass:String(text).includes(sub),msg,got:String(text).slice(0,60)})};
  let results;try{results=cs.check(c);}catch(e){results=[{pass:false,msg:'断言执行出错：'+e.message}];}
  return {cs,results,replies,traces,states};
}
if(typeof module!=='undefined')module.exports={runCase};
