'use strict';
// Integration test: a fake local OpenAI-compatible completion service receives requests from our local gateway.
const {spawn}=require('node:child_process');
const http=require('node:http');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const BASE=path.join(__dirname,'..');
const testPort=18765,upstreamPort=18766;
let lastRequest=null;
const fake=http.createServer((req,res)=>{
 if(req.url!=='/v1/chat/completions'){res.writeHead(404).end();return;}
 let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  lastRequest=JSON.parse(body);
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({answer_status:'answered',ack:'嗯，安全感确实挺重要的。'})}}],usage:{prompt_tokens:100,completion_tokens:15}}));
 });
});
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
(async()=>{
 await new Promise(r=>fake.listen(upstreamPort,'127.0.0.1',r));
 const processEnv={...process.env,HOST:'127.0.0.1',PORT:String(testPort),MODEL_API_BASE:`http://127.0.0.1:${upstreamPort}/v1`};
 const gateway=spawn(process.execPath,[path.join(BASE,'server.js')],{cwd:BASE,env:processEnv,stdio:['ignore','pipe','pipe']});
 try{
  let ready=false;
  for(let i=0;i<35;i++){
   await delay(90);
   try{const response=await fetch(`http://127.0.0.1:${testPort}/api/status`);if(response.ok){ready=true;break;}}catch{}
  }
  assert(ready,'gateway did not start');
  const root=await fetch(`http://127.0.0.1:${testPort}/`);const html=await root.text();
  assert.equal(root.status,200);assert(html.includes('周末窝在家看电影、做饭，听着还挺惬意的～'));
  const js=await fetch(`http://127.0.0.1:${testPort}/local_model_client.js`);assert.equal(js.status,200);
  const secret=await fetch(`http://127.0.0.1:${testPort}/.env`);assert.equal(secret.status,404);
  const model=await fetch(`http://127.0.0.1:${testPort}/api/model`,{
   method:'POST',headers:{'Content-Type':'application/json',Origin:`http://127.0.0.1:${testPort}`},
   body:JSON.stringify({pid:'P1B',sys:'你是 LoveMi',user:'安全感',tier:'fast'})});
  const data=await model.json();assert.equal(model.status,200,JSON.stringify(data));assert(data.text.includes('安全感确实挺重要'));assert.equal(lastRequest.messages[1].content,'安全感');assert.equal(lastRequest.stream,false);
  assert.equal(lastRequest.model,'deepseek-v4.1-flash');
  assert.equal(lastRequest.enable_thinking,false);
  assert.equal(lastRequest.thinking,undefined);
  for(const pid of ['P1','P3','P5','P6','P7']) {
   const response=await fetch(`http://127.0.0.1:${testPort}/api/model`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pid,sys:'test',user:'test'})});
   assert.equal(response.status,200);
   assert.equal(lastRequest.model,'deepseek-v4.1-flash');
   assert.equal(lastRequest.enable_thinking,['P6','P7'].includes(pid));
  }
  const missing=await fetch(`http://127.0.0.1:${testPort}/api/model`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"pid":"UNKNOWN","sys":"a","user":"b"}'});assert.equal(missing.status,400);
  console.log('✓ 本地网关测试通过：静态页面、模型代理、节点路由、密钥保护、非法节点拦截');
 }finally{gateway.kill();fake.close();}
})().catch(e=>{console.error(e);process.exitCode=1;fake.close();});
